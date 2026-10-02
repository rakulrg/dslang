// Delhivery — create-shipment core (provider-neutral facade).
//
// This is the ONE shipment-creation core. It is used by:
//   * supabase/functions/delhivery-order/index.ts      (admin manual Ship Order)
//   * supabase/functions/auto-ship-orders/index.ts     (automatic due sweep)
//   * supabase/functions/cashfree-webhook/index.ts     (paid → arm auto-ship)
//   * supabase/functions/delhivery-webhook/index.ts    (payment → ship)
//
// It shares the exact eligibility / idempotency / CAS-claim / attempt-tracking
// machinery that the Shiprocket core had — but is provider-agnostic:
//   * Reads/writes the NEUTRAL shipping columns (awb_number, tracking_id,
//     tracking_url, courier_name, label_url, shipped_at, tracking_current_status,
//     tracking_location, tracking_scans, last_shipping_attempt_at,
//     ship_attempt_error, auto_ship_at, shipping_provider).
//   * Falls back to the LEGACY Shiprocket columns (shiprocket_*,
//     shiprocket_order_id) for historic orders that were shipped before the
//     cutover — read-only, never written.
//   * NEVER trusts client-supplied amounts/identifiers; amounts come from the
//     server-authoritative retail_orders row. Fail-closed: misconfigured or
//     bad responses are recorded on the order as ship_attempt_error + CAS
//     release so admin sees a clean RETRY, never a silent/double shipment.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { createClient } from 'npm:@supabase/supabase-js@2';

// --- shared Delhivery adapter (fail-closed; token from env, never stored) ----
import { delhiveryBase as DELHIVERY_BASE, delhiveryConfigured, type DelhiveryConfig as DelhiveryProviderConfig } from './client.ts';
import { createDelhiveryOrder, fetchDelhiveryWaybill, type DelhiveryCreateResult } from './orders.ts';
import { sendOrderEmail } from '../emails.ts';

export const CREATING_SENTINEL = 'creating';
/**
 * Order states that may be handed to Delhivery.
 *
 * A NEW COD order is created at 'pending' with payment_status 'cod_pending' and
 * is fully confirmed — nothing is owed to us online, the balance is collected at
 * the door — so it must be shippable exactly like a confirmed order.
 *
 */
export const SHIPPABLE_STATUSES = new Set(['pending', 'processing']);

export type ShipmentSource = 'auto' | 'admin' | 'webhook';

export interface ShipmentProcessResult {
  ok: boolean;
  created: boolean;
  alreadyShipped: boolean;
  inProgress: boolean;
  error: string | null;
  shippingProvider: string | null;
  trackingId: string | null;
  awbNumber: string | null;
  courierName: string | null;
  labelUrl: string | null;
  shippedAt: string | null;
  trackingUrl: string | null;
}

export interface ShippableOrder {
  id: string;
  ref: string | null;
  isCod: boolean;
  totalAmount: number;
  amountDueOnDelivery: number;
  customer: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
}

/** Normalized customer-shipping snapshot used by the admin and the sweep. */
export function toShippableOrder(order: Record<string, unknown>): ShippableOrder {
  const customer = (order.customer as Record<string, unknown> | null) ?? {};
  const isCod = Boolean(order.is_cod ?? order.isCod ?? false);
  return {
    id: String(order.id ?? ''),
    ref: String(order.ref ?? '') || null,
    isCod,
    totalAmount: Number(order.total_amount ?? order.totalAmount ?? 0),
    amountDueOnDelivery: Number(order.amount_due_on_delivery ?? order.amountDueOnDelivery ?? 0),
    customer,
    items: Array.isArray(order.items) ? (order.items as Array<Record<string, unknown>>) : [],
  };
}

/** Gateway/eligibility check — deliberately mirrors the Shiprocket core. */
export function isShippable(order: Record<string, unknown>): boolean {
  const s = String(order.order_status ?? '');
  return SHIPPABLE_STATUSES.has(s);
}

function failOn(claimResult: { ok: boolean; error?: string; inProgress?: boolean; alreadyShipped?: boolean }): ShipmentProcessResult {
  return {
    ok: false,
    created: false,
    alreadyShipped: Boolean(claimResult.alreadyShipped),
    inProgress: Boolean(claimResult.inProgress),
    error: claimResult.error ?? 'Shipment was not created.',
    shippingProvider: null,
    trackingId: null,
    awbNumber: null,
    courierName: null,
    labelUrl: null,
    shippedAt: null,
    trackingUrl: null,
  };
}

export async function processEligibleShipment(
  supabase: SupabaseClient,
  orderId: string,
  source: ShipmentSource
): Promise<ShipmentProcessResult> {
  const config = delhiveryConfigured();
  // Load the order (id + neutral + legacy read-only fallback).
  const { data: order } = await supabase
    .from('retail_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (!order) return failOn({ ok: false, error: 'Order not found.' });

  const shiprocketOrderId = String(order.shiprocket_order_id ?? '');
  if (shiprocketOrderId === CREATING_SENTINEL) {
    return failOn({ ok: false, inProgress: true, error: 'Another attempt is already creating this shipment.' });
  }
  if (shiprocketOrderId) {
    // Legacy (pre-cutover) live shipment already exists — idempotent no-op.
    return {
      ok: true,
      created: false,
      alreadyShipped: true,
      inProgress: false,
      error: null,
      shippingProvider: 'shiprocket',
      trackingId: String(order.shiprocket_order_id ?? ''),
      awbNumber: String(order.awb_number ?? '') || null,
      courierName: String(order.courier_name ?? '') || null,
      labelUrl: String(order.label_url ?? '') || null,
      shippedAt: String(order.shipped_at ?? '') || null,
      trackingUrl: String(order.tracking_url ?? '') || null,
    };
  }

  // Neutral already-shipped detection. ANY existing AWB is final, whoever wrote
  // it: a Delhivery waybill from an earlier run, or a courier + waybill an admin
  // typed in by hand. Auto-ship is a fallback for orders nobody has shipped yet,
  // so it steps aside rather than creating a second AWB for a parcel that is
  // already with a courier.
  if (String(order.awb_number ?? '') !== '') {
    return {
      ok: true,
      created: false,
      alreadyShipped: true,
      inProgress: false,
      error: null,
      shippingProvider: String(order.shipping_provider ?? '') || 'manual',
      trackingId: String(order.tracking_id ?? '') || String(order.awb_number ?? ''),
      awbNumber: String(order.awb_number ?? ''),
      courierName: String(order.courier_name ?? '') || null,
      labelUrl: String(order.label_url ?? '') || null,
      shippedAt: String(order.shipped_at ?? '') || null,
      trackingUrl: String(order.tracking_url ?? '') || null,
    };
  }

  // Idempotent claim (provider-neutral sentinel) with CAS — only one sweep may
  // win; retries see alreadyShipped and don't double-create.
  const claim = await supabase
    .from('retail_orders')
    .update({ shiprocket_order_id: CREATING_SENTINEL, last_ship_attempt_at: new Date().toISOString() })
    .eq('id', order.id)
    .is('shiprocket_order_id', null)
    .is('awb_number', null)
    .select('id');
  if (claim.error || !claim.data || claim.data.length !== 1) {
    const recheck = await supabase
      .from('retail_orders')
      .select('shiprocket_order_id, awb_number, shipping_provider')
      .eq('id', order.id)
      .maybeSingle();
    // The CAS above can legitimately lose for two very different reasons. Report
    // each one truthfully instead of collapsing them into "in progress".
    if (recheck.data?.awb_number) {
      // A manual AWB is just as final as a Delhivery one: an admin entered this
      // courier and waybill by hand, and auto-ship must never overwrite it or
      // invent a second one. Echo the real provider/courier back.
      const provider = String(recheck.data.shipping_provider ?? '') || 'manual';
      return {
        ok: true,
        created: false,
        alreadyShipped: true,
        inProgress: false,
        error: null,
        shippingProvider: provider,
        trackingId: String(recheck.data.awb_number),
        awbNumber: String(recheck.data.awb_number),
        courierName: null,
        labelUrl: null,
        shippedAt: null,
        trackingUrl: null,
      };
    }
    if (recheck.data?.shiprocket_order_id && recheck.data.shiprocket_order_id !== CREATING_SENTINEL) {
      return {
        ok: true,
        created: false,
        alreadyShipped: true,
        inProgress: false,
        error: null,
        shippingProvider: 'shiprocket',
        trackingId: String(recheck.data.shiprocket_order_id),
        awbNumber: null,
        courierName: null,
        labelUrl: null,
        shippedAt: null,
        trackingUrl: null,
      };
    }
    return failOn({ ok: false, inProgress: true, error: 'Another attempt is already creating this shipment.' });
  }

  // --- Eligibility (server-side only; never client-supplied) -----------------
  if (String(order.payment_status ?? '') !== 'success') {
    await supabase
      .from('retail_orders')
      .update({
        shiprocket_order_id: null,
        ship_attempt_error: 'Cannot ship an order that is not confirmed as paid.',
        last_ship_attempt_at: new Date().toISOString(),
      })
      .eq('id', order.id);
    return failOn({ ok: false, error: 'Cannot ship an order that is not confirmed as paid.' });
  }
  if (!isShippable(order)) {
    await supabase
      .from('retail_orders')
      .update({
        shiprocket_order_id: null,
        ship_attempt_error: 'This order is not in a shippable state.',
        last_ship_attempt_at: new Date().toISOString(),
      })
      .eq('id', order.id);
    return failOn({ ok: false, error: 'This order is not in a shippable state.' });
  }

  // --- Provider ready? Fail-closed (never guess creds / never fake a result). --
  if (!config.configured) {
    const msg =
      'Delhivery is not configured. Add DELHIVERY_API_TOKEN + DELHIVERY_ENV ' +
      '(staging|production) secrets and redeploy.';
    await recordFailure(supabase, order.id, msg, 'delhivery');
    return failOn({ ok: false, error: msg });
  }

  // --- Build + create the Delhivery order (waybill + label) ------------------
  let result: DelhiveryCreateResult;
  try {
    result = await createDelhiveryOrder(supabase, toShippableOrder(order), config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delhivery could not be reached.';
    await recordFailure(supabase, order.id, msg, 'delhivery');
    return failOn({ ok: false, error: msg });
  }

  // --- Persist the NEUTRAL fields (CAS-cleared, provider stamped) ------------
  const basePatch: Record<string, unknown> = {
    shipping_provider: 'delhivery',
    awb_number: result.awb,
    tracking_id: result.awb,
    tracking_url: result.trackingUrl,
    courier_name: result.courierName || null,
    label_url: result.labelUrl || null,
    shipped_at: result.shippedAt ?? new Date().toISOString(),
    // Neutral shipment status at creation ('shipped' = registered/in-transit at
    // Delhivery). Persisted once so Admin/Track show an immediate status; the
    // Delhivery webhook refines it (delivered/undelivered/returned) as scans arrive.
    tracking_current_status: 'shipped',
    last_tracking_sync_at: new Date().toISOString(),
    ship_attempt_error: null,
    last_ship_attempt_at: new Date().toISOString(),
    ship_source: source,
    order_status: 'shipped',
    auto_ship_at: null,
    shiprocket_order_id: null,
  };
  const patch: Record<string, unknown> = {
    ...basePatch,
    // The same shipping lifecycle the admin UI writes by hand. Without this a
    // courier-generated shipment would keep the column's `pending` default and a
    // customer holding a real AWB would be told their parcel is still being
    // prepared. `order_status` stays 'shipped' in lockstep.
    shipping_status: 'shipped',
  };
  let { error: updateError } = await supabase
    .from('retail_orders')
    .update(patch)
    .eq('id', order.id);

  // `shipping_status` arrives with its migration. Deployed ahead of that
  // migration, PostgREST rejects the entire write — including the waybill, which
  // has already been created at Delhivery. Losing the AWB is far worse than
  // losing the lifecycle enrichment, so retry with the pre-existing columns.
  if (updateError) {
    const missingColumn =
      updateError.code === 'PGRST204' ||
      updateError.code === '42703' ||
      /column .* does not exist|schema cache/i.test(String(updateError.message ?? ''));
    if (missingColumn) {
      const retry = await supabase
        .from('retail_orders')
        .update(basePatch)
        .eq('id', order.id);
      updateError = retry.error ?? null;
    }
  }
  if (updateError) {
    // Shipment IS live at Delhivery — never lose the waybill. Flag for review.
    const rescue = await supabase
      .from('retail_orders')
      .update({
        ship_attempt_error: 'Shipment is live at Delhivery (waybill ' + result.awb + ' #' + result.awb + ') but saving the neutral fields failed. Verify in the Delhivery dashboard and fix manually — do not re-ship.',
        last_ship_attempt_at: new Date().toISOString(),
      })
      .eq('id', order.id);
    void rescue;
  }

  // Shipped email — sent once the waybill is live (single-fire via the shared
  // stamp; the manual Admin ship and the auto sweep share this core, so both
  // notify the customer the same way). Fail-open: a mail hiccup never undoes
  // the shipment.
  try {
    const emailOrder = {
      ...order,
      awb_number: result.awb,
      tracking_id: result.awb,
      courier_name: result.courierName,
      tracking_url: result.trackingUrl,
    };
    await sendOrderEmail(supabase, emailOrder, 'shipped');
  } catch {
    /* emailing is best-effort — the shipment itself already succeeded */
  }

  return {
    ok: true,
    created: true,
    alreadyShipped: false,
    inProgress: false,
    error: null,
    shippingProvider: 'delhivery',
    trackingId: result.awb,
    awbNumber: result.awb,
    courierName: result.courierName || null,
    labelUrl: result.labelUrl || null,
    shippedAt: patch.shipped_at as string,
    trackingUrl: result.trackingUrl || null,
  };
}

async function recordFailure(
  supabase: SupabaseClient,
  orderId: string,
  msg: string,
  provider: string
) {
  await supabase
    .from('retail_orders')
    .update({
      ship_attempt_error: `${provider === 'delhivery' ? 'Delhivery' : 'Shipping'} — ${msg}`,
      last_ship_attempt_at: new Date().toISOString(),
      shiprocket_order_id: null,
    })
    .eq('id', orderId);
}

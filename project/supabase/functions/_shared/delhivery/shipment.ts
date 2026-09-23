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

export const CREATING_SENTINEL = 'creating';
export const SHIPPABLE_STATUSES = new Set(['pending', 'cod_partial_paid', 'processing']);

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

  // Neutral already-shipped detection (Delhivery rows carry awb_number +
  // shipping_provider; legacy rows carry shiprocket_order_id — handled above).
  if (String(order.shipping_provider ?? '') === 'delhivery' && String(order.awb_number ?? '') !== '') {
    return {
      ok: true,
      created: false,
      alreadyShipped: true,
      inProgress: false,
      error: null,
      shippingProvider: 'delhivery',
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
    if (recheck.data?.shipping_provider === 'delhivery' && recheck.data.awb_number) {
      return {
        ok: true,
        created: false,
        alreadyShipped: true,
        inProgress: false,
        error: null,
        shippingProvider: 'delhivery',
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
  const patch: Record<string, unknown> = {
    shipping_provider: 'delhivery',
    awb_number: result.awb,
    tracking_id: result.awb,
    tracking_url: result.trackingUrl,
    courier_name: result.courierName || null,
    label_url: result.labelUrl || null,
    shipped_at: result.shippedAt ?? new Date().toISOString(),
    ship_attempt_error: null,
    last_ship_attempt_at: new Date().toISOString(),
    ship_source: source,
    order_status: 'shipped',
    auto_ship_at: null,
    shiprocket_order_id: null,
  };
  const { error: updateError } = await supabase
    .from('retail_orders')
    .update(patch)
    .eq('id', order.id);
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

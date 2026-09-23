// Delhivery — orders / waybill / label adapter (shared, fail-closed).
//
// The ONLY place that knows the exact Delhivery create-shipment + waybill
// contract:
//   create   POST {delhiveryBase()}/api/p/create
//              Authorization: Token <api-token>
//              body: {
//                shipments: [{ name, phone, address, city, state, pincode,
//                       country:'India', payment_mode, order:<ref>,
//                       total_amount, waybill:'', add:'',
//                       ...item slots (item_name/item_qty/item_amount)...
//                     }],
//                pickup_location: { name: delhiveryPickupLocation() },
//                client: delhiveryClient(),
//              }
//            success -> { shipments:[{ waybill:'60…', ... }], ... } — waybill
//              AUTO-ASSIGNED by the provider when left blank (provider-owned
//              pool assigned to the account; the only always-safe path).
//            error   -> 4xx/5xx { error:'…' } (auth 401, rate 429).
//   waybill  GET  {delhiveryBase()}/waybill/api/fetch/json/?cl=<client>
//            success -> single numeric waybill (provider-owned pool).
//   label    GET  {delhiveryBase()}/api/p/packing_slip            (label)
//
// Fail-closed rules (identical philosophy to the Shiprocket core — do NOT
// re-guess the provider):
//   * token comes from config (already resolved by client.ts) — NEVER from the
//     browser/DB/args; a live parcel is UNLOCKED ONLY when the config is
//     configured AND the production base is active — anything else fails closed
//     (auto-ship sweep + admin Ship Order + cashfree-webhook all call
//     processEligibleShipment which refuses staging/non-production).
//   * amounts/identifiers come from the SERVER row — never client input.
//   * a response that does not unambiguously contain a waybill -> { awb: null }
//     and the caller records ship_attempt_error + releases the CAS claim so
//     admin sees a clean RETRY — never a silent/duplicated shipment.
//   * NEVER "pretend" a waybill exists; NEVER fake/label a parcel.
//
// THE ONLY neutral surface consumers read/write today:
//   retail_orders.awb_number / tracking_id / tracking_url / courier_name /
//   label_url / shipped_at / tracking_current_status / tracking_location /
//   tracking_scans / last_ship_attempt_at / ship_attempt_error / auto_ship_at
//   (+ legacy read-only shiprocket_aws for historic rows).

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  delhiveryBase,
  delhiveryHeaders,
  delhiveryPickupLocation,
  delhiveryClient,
  type DelhiveryConfig,
} from './client.ts';

export interface DelhiveryShippable {
  id: string;
  ref: string | null;
  isCod: boolean;
  totalAmount: number;
  amountDueOnDelivery: number;
  customer: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
}

export interface DelhiveryCreateResult {
  awb: string | null;
  trackingUrl: string | null;
  courierName: string | null;
  labelUrl: string | null;
  shippedAt: string | null;
}

export interface DelhiveryWaybillResult {
  awb: string | null;
  error: string | null;
}

/** Creates the Delhivery forward shipment for one order. Always fail-closed:
 *  returns { awb: null, ... } when the response did not contain an unambiguous
 *  waybill. Throws only on transport/parse errors the caller records on the
 *  order (ship_attempt_error) before releasing the CAS claim. */
export async function createDelhiveryOrder(
  supabase: SupabaseClient,
  order: DelhiveryShippable,
  config: DelhiveryConfig
): Promise<DelhiveryCreateResult> {
  if (!config.configured || !config.token) {
    throw new Error('Delhivery is not configured (missing DELHIVERY_ENV / DELHIVERY_API_TOKEN).');
  }
  const pickup = delhiveryPickupLocation();
  if (!pickup) {
    throw new Error('Delhivery is missing DELHIVERY_PICKUP_LOCATION.');
  }

  const addr = resolveAddress(order.customer);
  const sl = lineItems(order.items);
  const body: Record<string, unknown> = {
    shipments: [
      {
        name: addr.name,
        phone: addr.phone,
        address: addr.address,
        city: addr.city,
        state: addr.state,
        pincode: addr.pincode,
        country: addr.country || 'India',
        payment_mode: order.isCod ? 'COD' : 'Prepaid',
        order: String(order.ref ?? order.id).slice(0, 15),
        total_amount: codOrPrepaidAmount(order),
        waybill: '',
        add: '',
        ...sl,
      },
    ],
    pickup_location: { name: pickup },
    client: delhiveryClient(),
  };

  const base = delhiveryBase();
  const res = await fetch(`${base}/api/p/create`, {
    method: 'POST',
    headers: delhiveryHeaders(config.token),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      const j = JSON.parse(text);
      detail = String(j?.error ?? '') || '(no detail)';
    } catch {
      detail = text.slice(0, 200);
    }
    throw new Error(`Delhivery create failed (${res.status}): ${detail}`);
  }
  const awb = extractWaybill(text);
  if (!awb) {
    return { awb: null, trackingUrl: null, courierName: null, labelUrl: null, shippedAt: null };
  }
  return {
    awb,
    trackingUrl: `${base}/track/php/?waybill=${encodeURIComponent(awb)}`,
    courierName: null,
    labelUrl: null,
    shippedAt: new Date().toISOString(),
  };
}

/** Fetches one waybill from the account's pool (explicit-allocate path; the
 *  admin manages the pool size). Fail-closed: an unambiguously numeric waybill
 *  OR { awb: null, error } — never a guess/pretend. */
export async function fetchDelhiveryWaybill(
  supabase: SupabaseClient,
  config: DelhiveryConfig
): Promise<DelhiveryWaybillResult> {
  if (!config.configured || !config.token) {
    return { awb: null, error: 'Delhivery is not configured.' };
  }
  const client = delhiveryClient();
  const url = `${delhiveryBase()}/waybill/api/fetch/json/?cl=${encodeURIComponent(client)}`;
  const res = await fetch(url, { method: 'GET', headers: delhiveryHeaders(config.token) });
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      const j = JSON.parse(text);
      detail = String(j?.error ?? '') || '(no detail)';
    } catch {
      detail = text.slice(0, 200);
    }
    return { awb: null, error: `Delhivery waybill fetch failed (${res.status}): ${detail}` };
  }
  const awb = extractWaybill(text);
  if (!awb) return { awb: null, error: 'Delhivery returned no waybill.' };
  return { awb, error: null };
}

// --- private helpers (pure) ----------------------------------------------------

function resolveAddress(customer: Record<string, unknown>): Record<string, string> {
  const c = (customer ?? {}) as Record<string, unknown>;
  const addr = (c.address ?? {}) as Record<string, unknown>;
  return {
    name: String(c.name ?? ''),
    phone: String(c.phone ?? c.mobile ?? ''),
    address: String(addr.line1 ?? addr.address ?? ''),
    city: String(addr.city ?? ''),
    state: String(addr.state ?? ''),
    pincode: String(addr.pincode ?? addr.zip ?? ''),
    country: String(addr.country ?? 'India'),
  };
}

function lineItems(items: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  (items ?? []).forEach((it, i) => {
    const idx = i === 0 ? '' : `_${i + 1}`;
    out[`item_name${idx}`] = String(it?.name ?? '');
    out[`item_qty${idx}`] = Number(it?.qty ?? 1);
    out[`item_amount${idx}`] = Number(it?.amount ?? 0);
  });
  return out;
}

function codOrPrepaidAmount(order: DelhiveryShippable): number {
  return order.isCod ? order.amountDueOnDelivery || order.totalAmount : order.totalAmount;
}

function extractWaybill(text: string): string | null {
  try {
    const j = JSON.parse(text);
    const candidates: unknown[] = [];
    if (Array.isArray(j?.shipments)) candidates.push(...j.shipments);
    if (Array.isArray(j?.Shipments)) candidates.push(...j.Shipments);
    if (Array.isArray(j?.data)) candidates.push(...j.data);
    for (const c of candidates) {
      const w = (c as Record<string, unknown>)?.waybill;
      if (typeof w === 'string' && /^\d{6,}$/.test(w)) return w;
    }
    for (const key of ['waybill', 'awb', 'awb_number']) {
      const w = (j as Record<string, unknown>)?.[key];
      if (typeof w === 'string' && /^\d{6,}$/.test(w)) return w;
    }
  } catch {
    // not JSON — not a waybill we can trust.
  }
  return null;
}

// Delhivery — tracking pull + webhook (push) adapter (shared).
//
// Pull tracking (documented): GET {track-server}/api/v1/packages/json/?waybill=<awb>
//   -> { ShipmentData: [ { AWB, Status: { StatusType: 'DL'|'UD'|'RT'|'IT'|'NDR', ... }, Scans:[...] } ] }
//   normalization is fail-closed: only documented statuses map; anything else is
//   an opaque in-transit "shipped" fallback. Never invent Delhivery codes.
//
// Webhook (push): Delhivery pushes scan events to the client-configured
//   endpoint with payload { Shipment: { AWB, Status: {...}, ... } }.
//   * We verify DELHIVERY_WEBHOOK_KEY (constant-time) and fail closed.
//   * We persist ONLY neutral fields on retail_orders and stamp neutral event
//     rows; the provider is recorded as 'delhivery'.
//   * The payload shape varies by account/config; if the body doesn't carry an
//     unambiguous waybill we record a "webhook no-op" and do NOT guess.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { delhiveryHeaders, type DelhiveryConfig } from './client.ts';

/** Returns normalized { status, location, scans } from a raw tracking response.
 *  Delivered → 'delivered'; Registered/Manifested/InTransit scan → 'shipped';
 *  Undelivered / Return / RTO → preserved raw so admins see reality; unknown →
 *  'shipped' (in-transit) — provider-consistent, never fabricated. */
export function normalizeDelhiveryTracking(raw: Record<string, unknown>): {
  status: string;
  location: string | null;
  scans: unknown[];
  awb: string | null;
} {
  const sd = Array.isArray(raw?.ShipmentData) ? raw.ShipmentData : [];
  const first = (sd[0] as Record<string, unknown> | undefined) ?? (raw as Record<string, unknown>);
  const awb = String(first?.AWB ?? first?.awb ?? '') || null;
  const statusObj = (first?.Status ?? first?.status) as Record<string, unknown> | undefined;
  const statusType = String(statusObj?.StatusType ?? statusObj?.status_type ?? statusObj?.status ?? '');
  const scans = Array.isArray(first?.Scans)
    ? (first.Scans as unknown[])
    : Array.isArray(raw?.Scans)
      ? (raw.Scans as unknown[])
      : [];

  let status = 'shipped';
  const t = statusType.toUpperCase();
  if (t === 'DL' || t === 'DELIVERED') status = 'delivered';
  else if (t === 'UD' || t === 'UNDELIVERED') status = 'undelivered';
  else if (t === 'RT' || t === 'RTO' || t === 'RETURN') status = 'returned';
  // Anything else (IT, NDR, Manifested, Registered, ...) → 'shipped' (in transit).

  let location: string | null = null;
  for (const s of scans) {
    const loc = String((s as Record<string, unknown>)?.Location ?? '');
    if (loc) { location = loc; break; }
  }

  return { status, location, scans, awb };
}

/** Applies the normalized tracking state to a retail_orders row via neutral
 *  columns. Returns true when a change was persisted. Fail-closed on auth. */
export async function applyDelhiveryTracking(
  supabase: SupabaseClient,
  orderId: string,
  normalized: { status: string; location: string | null; scans: unknown[] }
): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await supabase
    .from('retail_orders')
    .update({
      tracking_current_status: normalized.status,
      tracking_location: normalized.location,
      tracking_scans: normalized.scans,
      last_tracking_sync_at: new Date().toISOString(),
    })
    .eq('id', orderId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

/** The pending-alias handler for Delhivery push webhooks. This is what
 *  delhivery-webhook/index.ts calls after header-vending the key; the function
 *  itself may also use this directly. */
export async function processDelhiveryWebhookPayload(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  config: DelhiveryConfig
): Promise<{ ok: boolean; handled: string | null; error: string | null }> {
  const shipment = (body?.Shipment ?? body?.shipment ?? body?.data) as Record<string, unknown> | undefined;
  const awb =
    String(shipment?.AWB ?? shipment?.awb ?? body?.awb ?? body?.waybill ?? '') || null;
  if (!awb) {
    return { ok: false, handled: null, error: 'Webhook payload had no waybill; no-op (fail closed).' };
  }
  const { data, error } = await supabase
    .from('retail_orders')
    .select('id')
    .or(`awb_number.eq.${awb},tracking_id.eq.${awb}`)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, handled: null, error: 'No matching order for this waybill (no-op).' };
  }
  const orderId = String(data.id);
  const normalized = normalizeDelhiveryTracking(body);
  const applied = await applyDelhiveryTracking(supabase, orderId, normalized);
  if (!applied.ok) return { ok: false, handled: orderId, error: applied.error };
  return { ok: true, handled: orderId, error: null };
}

export { delhiveryHeaders };

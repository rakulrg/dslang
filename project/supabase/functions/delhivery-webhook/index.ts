// Delhivery — webhook (push) receiver. Delhivery pushes scan events to the
// client-configured endpoint URL; THIS is that endpoint.
//
//   POST {url}/delhivery-webhook
//     vend header: `x-delhivery-webhook-key` — constant-time compared against
//       DELHIVERY_WEBHOOK_KEY (server secret). FAIL-CLOSED on any mismatch,
//       missing header, or unconfigured key.
//     body (documented push shapes — we accept ALL and normalize in ONE place):
//       { Shipment: { AWB, Waybill, Status:{...}, Scans:[...] } }
//       { ShipmentData: [ { AWB, Status:{...}, Scans:[...] } ] }
//       { data: { awb, status, scans } }
//     PERSISTS only NEUTRAL columns on retail_orders keyed by awb/tracking_id:
//       tracking_current_status / tracking_location / tracking_scans /
//       last_tracking_sync_at. Provider stamped as 'delhivery'. Never trusts
//       identity/amounts from the payload — waybill must MATCH an existing row.
//
// Fail-closed rules (identical to the ENTIRE core):
//   * key from env, constant-time compare, keyed header ONLY — never query/body.
//   * no unambiguous waybill → no-op recorded (event row), never a guess.
//   * waybill matching NO order → no-op recorded (never a new/pretend parcel).
//   * optional: records the normalized push in a NEUTRAL event table only when
//     the schema has it; absent table → no-op, never an error that loses the
//     waybill. (Shipment still applied to neutral order columns regardless.)
//   * NEVER stores/returns/logs the webhook key or the provider token.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { loadDelhiveryConfig } from '../_shared/delhivery/client.ts';
import { processDelhiveryWebhookPayload } from '../_shared/delhivery/tracking.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, x-client-info, apikey, x-delhivery-webhook-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

/** Constant-time string compare (fail-closed: any length/type mismatch → false). */
function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true }, 204);

  // 1. Constant-time verify of the vend webhook key (fail-closed).
  const key = String(req.headers.get('x-delhivery-webhook-key') ?? '').trim();
  const expected = String(Deno.env.get('DELHIVERY_WEBHOOK_KEY') ?? '').trim();
  if (!expected || !key || !constantTimeEqual(key, expected)) {
    return json({ ok: false, handled: null, error: 'Unauthorized (bad or missing webhook key).' }, 401);
  }

  // 2. Supabase client (server env; neutral surface).
  const supabase = createClient(
    String(Deno.env.get('SUPABASE_URL') ?? ''),
    String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  );

  // 3. Parse + normalize + persist via the shared fail-closed core (never
  //    client-typed identifiers, never invented parcels).
  const raw = await req.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, handled: null, error: 'Malformed JSON body.' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, handled: null, error: 'Malformed payload (no-op).' }, 400);
  }

  const config = loadDelhiveryConfig();
  const result = await processDelhiveryWebhookPayload(supabase, body, config);
  return json(
    { ok: result.ok, handled: result.handled, error: result.error },
    result.ok ? 200 : 422
  );
});

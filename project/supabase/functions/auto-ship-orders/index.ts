// auto-ship-orders — scheduled sweep that creates Delhivery shipments after a
// cancel-before-ship grace window.
//
// WHY (see 20261003000000_dslang_auto_ship_grace.sql): the cashfree-webhook no
// longer ships inline. It stamps `auto_ship_at = paid+45min` on confirmation
// and returns; only when that timestamp is in the past does THIS sweep create
// the shipment. The grace window keeps the admin's manual check (cancel or edit
// the address) before a real parcel goes out, while automation runs the shared
// fulfilment core instead of requiring a manual "Ship Order" click.
//
// Pipeline (mirrors expire-stale-orders):
//   1. Authorization = 'Bearer <service_role>' (or SWEEP_TRIGGER_TOKEN),
//      constant-time; never an anonymous sweep.
//   2. Candidates: auto_ship_at <= now() AND payment_status='success' AND
//      order_status in shippable states AND shiprocket_order_id IS NULL AND
//      ship_attempt_error IS NULL. The last clause is deliberate: an order that
//      already failed an auto-ship attempt stays FLAGGED FOR MANUAL ACTION in
//      Admin (Shipment failed — needs manual action → Retry) instead of being
//      re-attempted blindly every few minutes.
//   3. Each candidate goes through the ONE shared core
//      (processEligibleShipment, source 'auto') — the same eligibility,
//      idempotent 'creating' CAS claim and error recording the admin and webhook
//      paths use, so nothing can drift. Success clears auto_ship_at; failure is
//      already recorded on the order (ship_attempt_error) by the core.
//   4. Stale-'creating' recovery: a crashed/interrupted claim (edge-function
//      timeout between the 'creating' claim and persistence) can otherwise sit
//      for ever and hide an order in Admin behind the "Creating the
//      shipment…" spinner. Claims older than SHIP_STALE_CREATING_MINUTES
//      (default 60) are cleared back to NULL with a manual-action message.
//
// Invocation (localhost / `supabase functions serve`, no deploy):
//   POST { "limit": 20 }                        (production sweep, due orders)
//   POST { "dryRun": true }                     (candidate preview, no writes)
//   POST { "ref": "DSL-R-XXXX", "force": true } (single-order test — bypasses
//                                                the not-due guard)
//
// Env (Supabase Edge Function secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required),
//   SWEEP_TRIGGER_TOKEN (optional), SHIP_STALE_CREATING_MINUTES (optional, 60).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { bearerToken, constantTimeEqual } from '../_shared/auth-util.ts';
import { processEligibleShipment, SHIPPABLE_STATUSES, type ShipmentProcessResult } from '../_shared/delhivery/shipment.ts';

const CREATING_SENTINEL = 'creating';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface CandidateRow {
  id: string;
  ref: string | null;
  auto_ship_at: string | null;
  shiprocket_order_id: string | null;
  ship_attempt_error: string | null;
}

interface Detail {
  ref: string | null;
  action: 'shipped' | 'already_shipped' | 'in_progress' | 'failed' | 'not_due';
  note: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const sweepToken = Deno.env.get('SWEEP_TRIGGER_TOKEN');
  if (!supabaseUrl || !serviceRole) {
    return json({ success: false, error: 'Sweep is not configured on the server.' }, 500);
  }

  // Authorization — same model as expire-stale-orders: the pg_cron job sends
  // 'Authorization: Bearer <service_role>' (the value this function already
  // reads from its own env). SWEEP_TRIGGER_TOKEN is honored as an alternative.
  const presented = bearerToken(req.headers.get('authorization') || '');
  let allowed = false;
  if (presented) {
    if (await constantTimeEqual(presented, serviceRole)) allowed = true;
    else if (sweepToken && (await constantTimeEqual(presented, sweepToken))) allowed = true;
  }
  if (!allowed) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  let body: { ref?: string; force?: boolean; dryRun?: boolean; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid request.' }, 400);
  }

  const dryRun = Boolean(body.dryRun);
  const limit = Math.max(1, Math.min(200, Number(body.limit ?? 20) || 20));
  const staleMinutes = (() => {
    const n = Number(Deno.env.get('SHIP_STALE_CREATING_MINUTES') ?? '60');
    return Number.isFinite(n) && n > 0 ? n : 60;
  })();
  const supabase = createClient(supabaseUrl, serviceRole);

  // -------------------------------------------------------------------------
  // 1) Candidate selection. Production mode = due orders only. ref mode = one
  //    specific order (still gated on due-ness unless force is passed).
  // -------------------------------------------------------------------------
  let candidates: CandidateRow[] = [];
  if (body.ref) {
    const ref = String(body.ref).trim().toUpperCase();
    const { data } = await supabase
      .from('retail_orders')
      .select('id, ref, auto_ship_at, shiprocket_order_id, ship_attempt_error')
      .eq('ref', ref)
      .limit(1);
    candidates = (data as CandidateRow[] | null | undefined) ?? [];
  } else {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('retail_orders')
      .select('id, ref, auto_ship_at, shiprocket_order_id, ship_attempt_error')
      .lte('auto_ship_at', now)
      .eq('payment_status', 'success')
      .in('order_status', Array.from(SHIPPABLE_STATUSES))
      .is('shiprocket_order_id', null)
      // Never auto-ship an order a human already shipped by hand. An admin-entered
      // AWB is final: this sweep must not create a second, competing waybill.
      .is('awb_number', null)
      .is('ship_attempt_error', null)
      .order('auto_ship_at', { ascending: true })
      .limit(limit);
    if (error) return json({ success: false, error: `Candidate query failed: ${error.message}` }, 500);
    candidates = (data as CandidateRow[] | null) ?? [];
  }

  // -------------------------------------------------------------------------
  // 2) Stale-'creating' recovery (interrupted auto/admin claims) — run BEFORE
  //    the main loop so a stale sentinel never shadows a due order.
  // -------------------------------------------------------------------------
  const staleCutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const { data: staleStubs } = await supabase
    .from('retail_orders')
    .select('id, ref')
    .eq('shiprocket_order_id', CREATING_SENTINEL)
    .lte('last_ship_attempt_at', staleCutoff)
    .limit(20);

  const recovered: Array<{ ref: string | null; note: string }> = [];
  if (!dryRun && Array.isArray(staleStubs) && staleStubs.length > 0) {
    for (const stub of staleStubs as Array<{ id: string; ref: string | null }>) {
      const { error } = await supabase
        .from('retail_orders')
        .update({
          shiprocket_order_id: null,
          ship_attempt_error:
            'The previous shipment attempt was interrupted mid-creation (stale "creating" claim). ' +
            'Check the Delhivery dashboard for a stray order before retrying — do not double-ship.',
        })
        .eq('id', stub.id)
        .eq('shiprocket_order_id', CREATING_SENTINEL);
      if (!error) recovered.push({ ref: stub.ref, note: 'sentinel cleared, flagged for manual action' });
    }
  } else if (Array.isArray(staleStubs) && staleStubs.length > 0) {
    recovered.push({ ref: '(dry run)', note: `${staleStubs.length} stale 'creating' claims would be cleared` });
  }

  // -------------------------------------------------------------------------
  // 3) Create the shipment for each due order via the shared core.
  // -------------------------------------------------------------------------
  const details: Detail[] = [];
  let shipped = 0;
  let alreadyShipped = 0;
  let inProgress = 0;
  let failed = 0;
  let notDue = 0;

  for (const c of candidates) {
    // ref mode keeps the grace principle unless force is passed.
    if (body.ref && !body.force && c.auto_ship_at && c.auto_ship_at > new Date().toISOString()) {
      notDue++;
      details.push({ ref: c.ref, action: 'not_due', note: `auto_ship_at=${c.auto_ship_at} (grace window not over)` });
      continue;
    }

    if (dryRun) {
      details.push({ ref: c.ref, action: 'shipped', note: '(dry run — would ship via processEligibleShipment)' });
      continue;
    }

    const r: ShipmentProcessResult = await processEligibleShipment(supabase, c.id, 'auto');

    if (r.ok) {
      shipped++;
      details.push({ ref: c.ref, action: 'shipped', note: `Provider ${r.shippingProvider ?? '?'}, tracking ${r.trackingId ?? '?'}, AWB ${r.awbNumber ?? '?'}` });
      // Tidy: nothing left to wait on. (shipped-id + status guards already block
      // any re-ship; clearing the stamp just stops it influencing other logic.)
      await supabase.from('retail_orders').update({ auto_ship_at: null }).eq('id', c.id);
    } else if (r.alreadyShipped) {
      alreadyShipped++;
      details.push({ ref: c.ref, action: 'already_shipped', note: 'A shipment already exists (admin or earlier run).' });
      await supabase.from('retail_orders').update({ auto_ship_at: null }).eq('id', c.id);
    } else if (r.inProgress) {
      inProgress++;
      details.push({ ref: c.ref, action: 'in_progress', note: 'Another attempt currently holds the claim — left untouched.' });
    } else {
      // The core records API/config failures on the order (ship_attempt_error
      // + last_ship_attempt_at) so Admin shows "Shipment failed — needs manual
      // action" with a Retry button. Eligibility failures (e.g. an incomplete
      // address on a paid order) return WITHOUT writing though — so we flag
      // those ourselves below. Either way the order is excluded from every
      // future auto attempt and never fails silently.
      failed++;
      details.push({ ref: c.ref, action: 'failed', note: r.error ?? 'Shipment creation failed.' });
      const after = await supabase
        .from('retail_orders')
        .select('ship_attempt_error, last_ship_attempt_at')
        .eq('id', c.id)
        .maybeSingle();
      if (!after.data?.ship_attempt_error) {
        await supabase
          .from('retail_orders')
          .update({
            ship_attempt_error: `Auto-ship skipped this order: ${r.error ?? 'not shippable'}. Review and fix, then retry manually.`,
            last_ship_attempt_at: new Date().toISOString(),
          })
          .eq('id', c.id)
          .is('ship_attempt_error', null);
      }
    }
  }

  return json({
    success: true,
    dryRun,
    mode: body.ref ? 'ref' : 'all-due',
    scanned: candidates.length,
    shipped,
    alreadyShipped,
    inProgress,
    failed,
    notDue,
    staleCreatingCleared: recovered.length,
    recovered,
    details,
  });
});
// Cashfree PG — webhook listener (idempotent).
//
// Defences:
//   * Signature: Webhooks are signed with
//       signature = Base64(HMAC-SHA256(secret_key, x-webhook-timestamp + rawBody))
//     compared against the `x-webhook-signature` header. We verify on the RAW
//     body (never a re-parsed/reformatted string), matching Cashfree's current
//     requirements.
//   * We never trust the webhook's stated status alone. After signature
//     verification the authoritative Cashfree status API is consulted and the
//     amount is checked before the DSLANG order is marked PAID.
//   * the gateway amount is matched against amount_paid_upfront — the single
//     authoritative "payable now" figure:
//     online -> total_amount - payment_discount (₹50 off the Sale Price, capped)
//     COD    -> never reaches this handler: a full-COD order is confirmed at
//              creation with payment_status 'cod_pending' and payment_id null,
//              and Cashfree never creates a session for it. Historical gateway
//              collections retain their facts and use normal fulfilment.
//   * Idempotent: already-paid orders short-circuit; only one path can flip
//     payment_status -> 'success' (guarded with a CAS update), so
//     duplicate/replayed webhooks are safe.
//   * AUTO-SHIP: this handler does NOT create a shipment inline. It stamps
//     auto_ship_at = now() + SHIP_AUTO_GRACE_MINUTES (default 45) so the
//     scheduled auto-ship-orders sweep can create the Shiprocket order AFTER a
//     cancel-before-ship window — the admin keeps time to catch address errors
//     or fraud. Orders before this automation (or with a NULL stamp) ship only
//     via the Admin 'Ship Order' button.
//
// Env (Supabase Edge Function secrets):
//   CASHFREE_SECRET_KEY, CASHFREE_ENV (TEST|PRODUCTION),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   SHIP_AUTO_GRACE_MINUTES (optional, default 45).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendOrderEmail } from '../_shared/emails.ts';

async function verifyWebhookSignature(
  secretKey: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  const data = new TextEncoder().encode(`${timestamp}${rawBody}`);
  const key = new TextEncoder().encode(secretKey);
  try {
    const algo = { name: 'HMAC', hash: 'SHA-256' };
    const cryptoKey = await crypto.subtle.importKey('raw', key, algo, false, ['sign']);
    const mac = await crypto.subtle.sign(algo, cryptoKey, data);
    const bytes = new Uint8Array(mac);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary) === signature;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('{"ok":false,"error":"Method not allowed."}', { status: 405, headers: { 'Content-Type': 'application/json' } });

  const secretKey = Deno.env.get('CASHFREE_SECRET_KEY');
  const appId = Deno.env.get('CASHFREE_APP_ID');
  const env = Deno.env.get('CASHFREE_ENV') || 'TEST';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secretKey || !appId || !supabaseUrl || !serviceRole) {
    return new Response('{"ok":false,"error":"Webhook not configured."}', { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const timestamp = req.headers.get('x-webhook-timestamp');
  const signature = req.headers.get('x-webhook-signature');
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return new Response('{"ok":false,"error":"Bad request."}', { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  if (!(await verifyWebhookSignature(secretKey, timestamp, signature, rawBody))) {
    return new Response('{"ok":false,"error":"Invalid signature."}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // The order id lives under data.order.order_id for payment events.
  const orderId = payload?.data?.order?.order_id;
  if (!orderId) {
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(supabaseUrl, serviceRole);
  const { data: order } = await supabase
    .from('retail_orders')
    .select('*')
    .eq('payment_id', String(orderId))
    .maybeSingle();
  if (!order) {
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (order.payment_status === 'success') {
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Defence in depth against a stale gateway event on a full-COD order.
  //
  // A new COD order has payment_id = null, so the lookup above cannot match it
  // and this branch is normally unreachable. It exists so that even if a COD
  // row were ever re-attached to a payment id (a bad backfill, a manual fix, a
  // retried conversion), the webhook acknowledges the event and mutates
  // NOTHING. A COD order's money is collected at the door by the agent and is
  // never settled through Cashfree, so no gateway event may change its state.
  // In particular it must never become a gateway-settled order.
  if (order.is_cod && order.payment_status === 'cod_pending') {
    return new Response('{"ok":true,"ignored":"cod_order"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Re-verify with the authoritative status API before marking paid.
  const base = env.toUpperCase() === 'PRODUCTION' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
  const headers = {
    Accept: 'application/json',
    'x-api-version': '2025-01-01',
    'X-Client-Id': appId,
    'X-Client-Secret': secretKey,
  };

  let payments: Record<string, unknown>[] = [];
  try {
    const res = await fetch(`${base}/pg/orders/${encodeURIComponent(orderId)}/payments`, { method: 'GET', headers });
    const api = await res.json();
    payments = Array.isArray(api) ? api : api?.data && Array.isArray(api.data) ? api.data : [];
  } catch {
    return new Response('{"ok":false,"error":"Status lookup failed."}', { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  if (payments.length > 0) {
    const last = payments[payments.length - 1];
    const status = String(last?.payment_status ?? '').toUpperCase();
    const paidAmount = Number(last?.order_amount ?? last?.amount ?? 0);
    // Authoritative expected charge = amount_paid_upfront (what Cashfree was
    // actually charged: online = Sale Price minus the capped ₹50 discount).
    // Never the client-supplied amount. A full-COD order has no payment_id and
    // can never be looked up here; a COD order that does resolve is a legacy
    // advance-model one, so this is its real advance.
    const expected = Number(order.amount_paid_upfront ?? order.total_amount);
    if (status === 'SUCCESS' && Math.abs(paidAmount - expected) <= 0.005) {
      const gatewayId = last?.payment_gateway_details as Record<string, unknown> | undefined;
      // Grace window before the auto-ship sweep may claim this order.
      const graceRaw = Number(Deno.env.get('SHIP_AUTO_GRACE_MINUTES') ?? '45');
      const graceMinutes = Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : 45;
      // CAS flip (CAS = same idempotency principle used everywhere else): only
      // the first confirmation wins; a concurrent/replayed delivery updates
      // zero rows. The stamp is written ONLY by the winning confirmation so a
      // duplicate webhook can never re-arm (or extend) the grace window.
      const flip = await supabase
        .from('retail_orders')
        .update({
          payment_status: 'success',
          // COD is excluded by the guard below. A historical gateway-confirmed
          // row keeps its stored monetary facts and follows normal fulfilment.
          order_status: 'processing',
          paid_at: new Date().toISOString(),
          txn_id: String(last?.cf_payment_id ?? gatewayId?.gateway_transaction_id ?? '') || order.txn_id,
          payment_provider: 'cashfree',
          auto_ship_at: new Date(Date.now() + graceMinutes * 60_000).toISOString(),
        })
        .eq('id', order.id)
        .neq('payment_status', 'success')
        // Hard guard, independent of the early return above: a new COD order
        // must never be settled through the gateway. Even if this handler were
        // reached with a stale event for a COD row, the CAS matches zero rows
        // and nothing changes.
        .neq('payment_status', 'cod_pending')
        .select('id');
      if (flip.error) {
        return new Response('{"ok":false,"error":"Order update failed."}', { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
      // Order Confirmed email — fired by the WINNING flip only (replayed/
      // duplicate webhooks short-circuit above, so this runs exactly once).
      // Fail-open: an email hiccup never fails the payment confirmation.
      if ((flip.data?.length ?? 0) > 0) {
        try {
          await sendOrderEmail(supabase, order, 'confirmed');
        } catch {
          /* best-effort */
        }
      }
      // The shipment itself is NOT created here: the auto-ship-orders sweep
      // creates it once auto_ship_at is in the past (cancel-before-ship window).
    } else if (status === 'CANCELLED' || status === 'USER_DROPPED' || status === 'FAILED') {
      // Confirmed failure (not provisional/pending): mark failed + cancelled.
      // Order status always stays consistent: a failed payment is a cancelled
      // order, never 'processing'.
      //
      // Stock is deliberately NOT returned here — the order stays reserved so
      // "Try Again" can reuse the same order without over-selling stock that
      // was already put back on the shelf. Inventory is reclaimed later by the
      // expire-stale-orders sweep (expires failed/pending orders older than the
      // window and restocks them exactly once via restock_retail_order_items).
      // CAS: a late failure must never clobber a payment that already succeeded.
      // Cashfree can deliver a terminal FAILED/USER_DROPPED *after* a SUCCESS for
      // the same order (retry, replayed delivery, out-of-order events). This
      // handler read the gateway a moment before a concurrent webhook/status poll
      // flipped the row to `success`, so an unguarded write by id alone would
      // knock a PAID order back to failed/cancelled. The filters make that write
      // match zero rows instead — the same CAS principle as the success branch
      // above. A lost race is a silent no-op here on purpose: the delivery is
      // still acknowledged 200 so Cashfree does not retry a stale event forever.
      const failureFlip = await supabase
        .from('retail_orders')
        .update({ payment_status: 'failed', order_status: 'cancelled' })
        .eq('id', order.id)
        .neq('payment_status', 'success')
        // Same independent COD guard as the success branch: a full-COD order must
        // never be settled through the gateway at all, in either direction.
        .neq('payment_status', 'cod_pending')
        .select('id');
      if (failureFlip.error) {
        return new Response('{"ok":false,"error":"Order update failed."}', { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
    }
  }

  return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
});

// Cashfree PG — authoritative, server-side payment-status verification.
//
// The frontend never decides payment success. This function asks Cashfree for
// the real payment state of the order, checks the paid amount matches the
// DSLANG expected charge and only then marks the order PAID.
//
//   * the gateway amount is matched against amount_paid_upfront — the single
//     authoritative "payable now" figure:
//     online -> total_amount - payment_discount (₹50 off the Sale Price, capped)
//     COD    -> never reaches the gateway: a full-COD order is confirmed at
//              creation with payment_status 'cod_pending' and payment_id null,
//              and is answered directly below without any Cashfree call.
//   * online success -> order_status 'processing'.
//
//   A historical order with a genuine gateway collection retains that recorded
//   money and follows the ordinary processing status.
//
// Idempotent: already-paid orders short-circuit; the payment_id partial unique
// index prevents a second Cashfree order ever pairing with one DSLANG order.
//
// Env (Supabase Edge Function secrets):
//   CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (TEST|PRODUCTION),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendOrderEmail } from '../_shared/emails.ts';

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

function baseUrl(env: string): string {
  return env.toUpperCase() === 'PRODUCTION'
    ? 'https://api.cashfree.com'
    : 'https://sandbox.cashfree.com';
}

/** Normalizes a phone number to its last 10 digits (Indic mobile format). */
function normalizePhone(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '').slice(-10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ verified: false, status: 'unavailable', order: null }, 405);

  const appId = Deno.env.get('CASHFREE_APP_ID');
  const secretKey = Deno.env.get('CASHFREE_SECRET_KEY');
  const env = Deno.env.get('CASHFREE_ENV') || 'TEST';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!appId || !secretKey || !supabaseUrl || !serviceRole) {
    return json({ verified: false, status: 'unavailable', order: null }, 500);
  }

  let body: { orderRef?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return json({ verified: false, status: 'unavailable', order: null }, 400);
  }
  if (!body.orderRef) {
    return json({ verified: false, status: 'unavailable', order: null }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRole);

  const { data: order, error } = await supabase
    .from('retail_orders')
    .select('*')
    .eq('ref', body.orderRef)
    .maybeSingle();
  if (error || !order || !order.payment_id) {
    return json({ verified: false, status: 'pending', order: null }, 404);
  }

  // POSSESSION GATE: the caller must know the order reference AND the
  // customer's 10-digit phone. An anonymous caller who only knows/guesses an
  // order ref gets the same indistinguishable "pending / null" response as an
  // invalid ref — so this endpoint can never be used to enumerate orders or
  // read customer PII (name, phone, delivery address) from retail_orders.
  const orderPhone = normalizePhone((order.customer as Record<string, unknown> | null)?.phone);
  const callerPhone = normalizePhone(body.phone);
  if (callerPhone.length !== 10 || callerPhone !== orderPhone) {
    return json({ verified: false, status: 'pending', order: null }, 200);
  }

  // COD GUARD: a full-COD order is confirmed the moment it is created and owes
  // its money to the delivery agent, so there is nothing for Cashfree to verify
  // and `payment_id` is null. Answer "confirmed" directly instead of touching
  // the gateway. Legacy COD orders that DID pay an advance carry a real
  // payment_id and still fall through to the normal verification below.
  if (order.is_cod && (order.payment_status === 'cod_pending' || !order.payment_id)) {
    return json({ verified: true, status: 'cod_pending', order });
  }

  if (order.payment_status === 'success') {
    return json({ verified: true, status: 'paid', order });
  }

  const base = baseUrl(env);
  const orderId = String(order.payment_id);
  const headers = {
    Accept: 'application/json',
    'x-api-version': '2025-01-01',
    'X-Client-Id': appId,
    'X-Client-Secret': secretKey,
  };

  let orderStatusApi: { order_status?: string };
  try {
    const res = await fetch(`${base}/pg/orders/${encodeURIComponent(orderId)}`, { method: 'GET', headers });
    orderStatusApi = await res.json();
  } catch {
    return json({ verified: false, status: 'pending', order }, 502);
  }

  // If the order has not charmed/paid yet, report pending.
  const os = orderStatusApi.order_status || '';
  if (os === 'PAID' || os === 'ACTIVE') {
    // Fall through to the payments list for the authoritative status.
  } else {
    return json({ verified: false, status: 'pending', order });
  }

  let payments: Record<string, unknown>[] = [];
  try {
    const res = await fetch(`${base}/pg/orders/${encodeURIComponent(orderId)}/payments`, { method: 'GET', headers });
    const api = await res.json();
    payments = Array.isArray(api) ? api : api?.data && Array.isArray(api.data) ? api.data : [];
  } catch {
    return json({ verified: false, status: 'pending', order }, 502);
  }

  if (payments.length === 0) {
    return json({ verified: false, status: 'pending', order });
  }

  const last = payments[payments.length - 1];
  const paymentStatus = String(last?.payment_status ?? '').toUpperCase();
  const paidAmount = Number(last?.order_amount ?? last?.amount ?? 0);
  // Authoritative expected charge = amount_paid_upfront (what Cashfree was
  // actually charged: online = Sale Price minus the capped ₹50 discount).
  // Never the client-supplied amount. A COD order that reaches here is a
  // legacy advance-model one, so this is its real advance.
  const expected = Number(order.amount_paid_upfront ?? order.total_amount);

  if (paymentStatus === 'SUCCESS') {
    // Amount-tamper guard: only mark paid when the gateway amount matches the
    // DSLANG expected charge (within sub-paise float tolerance).
    if (Math.abs(paidAmount - expected) > 0.005) {
      return json({ verified: false, status: 'pending', order });
    }
    const gatewayId = last?.payment_gateway_details as Record<string, unknown> | undefined;
    // Grace before the auto-ship sweep may claim this order (same default and
    // semantics as the webhook path).
    const graceRaw = Number(Deno.env.get('SHIP_AUTO_GRACE_MINUTES') ?? '45');
    const graceMinutes = Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : 45;
    const { data: flippedRows } = await supabase
      .from('retail_orders')
      .update({
        payment_status: 'success',
        // COD is guarded above. A historical gateway-confirmed row retains its
        // recorded amounts but follows the normal fulfilment status.
        order_status: 'processing',
        paid_at: new Date().toISOString(),
        txn_id: String(last?.cf_payment_id ?? gatewayId?.gateway_transaction_id ?? '') || order.txn_id,
        payment_provider: 'cashfree',
        auto_ship_at: new Date(Date.now() + graceMinutes * 60_000).toISOString(),
      })
      .eq('id', order.id)
      // Hard guard, independent of the early return above: a new COD order
      // must never be settled through the gateway, so the CAS matches zero rows
      // for one even if this handler were reached with a stale event.
      .neq('payment_status', 'cod_pending')
      // Idempotency with the webhook: whichever confirmation runs FIRST stamps
      // the grace window; a redundant poll (or late duplicate webhook) matches
      // zero rows here via `.is('auto_ship_at', null)` and never extends it.
      .is('auto_ship_at', null)
      .select('id');
    const flipped = (flippedRows?.length ?? 0) > 0;
    const { data: fresh } = await supabase
      .from('retail_orders')
      .select('*')
      .eq('id', order.id)
      .maybeSingle();
    // Order Confirmed email — fired by the winning flip only (mirrors the
    // webhook path's single-fire). Fail-open: never fails the confirmation.
    if (flipped && fresh) {
      try {
        await sendOrderEmail(supabase, fresh, 'confirmed');
      } catch {
        /* best-effort */
      }
    }
    return json({ verified: true, status: 'paid', order: fresh || order });
  }

  if (paymentStatus === 'CANCELLED' || paymentStatus === 'USER_DROPPED' || paymentStatus === 'FAILED') {
    // Confirmed failure (not a provisional/pending state): mark the order
    // failed + cancelled. Order status always stays consistent: a failed
    // payment is a cancelled order, never 'processing'.
    //
    // Stock is deliberately NOT returned here. The order stays reserved so
    // "Try Again" can reuse the same order (same Cashfree session id) without
    // double-selling a unit that was already put back on the shelf. Inventory
    // is reclaimed later by the expire-stale-orders sweep, which expires any
    // failed/pending order older than the window and restocks it exactly once.
    // CAS: a late failure must never clobber a payment that already succeeded.
    // Cashfree can deliver a terminal FAILED/USER_DROPPED *after* a SUCCESS for
    // the same order (retry, duplicate/replayed delivery, out-of-order gateway
    // events). This handler read the gateway a moment before a concurrent
    // webhook flipped the row to `success`, so an unguarded write by id alone
    // would knock a PAID order back to failed/cancelled — losing the money fact
    // and stranding a reservation. The filters make that write match zero rows
    // instead. Same principle as the success branch's `.neq('cod_pending')` CAS
    // above: whoever arrives second cannot overwrite the other.
    const { data: failedRows, error: failureError } = await supabase
      .from('retail_orders')
      .update({ payment_status: 'failed', order_status: 'cancelled' })
      .eq('id', order.id)
      .neq('payment_status', 'success')
      // Same independent COD guard as the success branch: a full-COD order must
      // never be settled through the gateway at all, in either direction.
      .neq('payment_status', 'cod_pending')
      .select('id');

    // Distinguish "the write failed" from "the write matched zero rows". Without
    // this a database error (network, RLS, transient) would look identical to a
    // lost CAS, and the fall-through below would report `status: 'failed'` for a
    // failure that was never actually recorded — telling a customer their payment
    // did not go through when the row may well still be unpaid, or may already
    // have been paid concurrently. 502 + 'pending' is this file's existing
    // convention for a transport-level failure, and it never claims a verdict.
    if (failureError) {
      return json({ verified: false, status: 'pending', order }, 502);
    }

    if ((failedRows?.length ?? 0) > 0) {
      const { data: failedOrder } = await supabase
        .from('retail_orders')
        .select('*')
        .eq('id', order.id)
        .maybeSingle();
      return json({ verified: false, status: 'failed', order: failedOrder ?? order });
    }

    // Zero rows = we lost the race. Re-read and report the row's REAL state, so
    // a customer whose payment actually succeeded is never shown "failed".
    const { data: raced } = await supabase
      .from('retail_orders')
      .select('*')
      .eq('id', order.id)
      .maybeSingle();
    const racedPayment = String(raced?.payment_status ?? '');
    if (racedPayment === 'success') {
      return json({ verified: true, status: 'paid', order: raced ?? order });
    }
    if (racedPayment === 'cod_pending') {
      return json({ verified: false, status: 'pending', order: raced ?? order });
    }
    return json({ verified: false, status: 'failed', order: raced ?? order });
  }

  return json({ verified: false, status: 'pending', order });
});

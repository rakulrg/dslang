// cod-order-mail — server-side Order Confirmed email for Cash-on-Delivery orders.
//
// WHY THIS EXISTS
//   The only automatic confirmation trigger was the Cashfree paid-flip
//   (cashfree-webhook / cashfree-status), so COD orders — which never touch a
//   gateway and are confirmed at creation with payment_status 'cod_pending' —
//   had no email at all. This closes that gap.
//
// SERVER-SIDE, NOT CLIENT-SIDE
//   The caller supplies nothing but two possession factors (order ref + the
//   customer's 10-digit phone), exactly like cashfree-status and
//   track_lookup_order. The recipient, the money, the items and the template are
//   all read from the authoritative order row here. The client never decides
//   that an order is confirmed, never names a recipient, and cannot influence a
//   single figure in the mail.
//
//   COD NEVER CALLS CASHFREE — this function talks only to the database.
//
// IDEMPOTENT
//   Two independent guards, so any number of client retries, double-taps or
//   refreshes still produce exactly one confirmation:
//     1. sendOrderEmail() itself refuses when retail_orders.last_email_kind is
//        already 'confirmed' (that column is written on the previous send).
//     2. This function re-reads the row and short-circuits on the same field.
//   The admin "Resend Email" action calls sendOrderEmail with force:true, which
//   bypasses guard 1 by design — a human re-notifying a customer is intentional.
//
// NEVER SENDS FOR A BAD ORDER
//   Requires is_cod AND payment_status = 'cod_pending' — the terminal COD
//   state. A failed, abandoned, cancelled or expired order is never confirmed,
//   so it can never produce a confirmation mail.
//
// FAIL-OPEN, NON-BLOCKING
//   Email failure must never roll back, cancel or fail a valid COD order: the
//   order is already committed and confirmed in the database before this is
//   called. Every Resend failure is swallowed and merely reported as ok:false.
//   Nothing here writes to retail_orders except the audit stamp inside
//   sendOrderEmail, and no financial column is ever touched.
//
// Env (Supabase Edge Function secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
//   optional EMAIL_FROM / APP_ORIGIN.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendOrderEmail } from '../_shared/emails.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Last 10 digits — the same normalization cashfree-status uses. */
function normalizePhone(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '').slice(-10);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRole) {
    return json({ ok: false, error: 'Server config missing.' }, 500);
  }

  let body: { orderRef?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid body.' }, 400);
  }

  const ref = String(body?.orderRef ?? '').trim().toUpperCase();
  const phone = normalizePhone(body?.phone);
  if (!ref || phone.length !== 10) {
    return json({ ok: false, error: 'An order reference and 10-digit phone are required.' }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRole);

  const { data: order, error } = await supabase
    .from('retail_orders')
    .select('*')
    .eq('ref', ref)
    .maybeSingle();
  if (error) {
    console.error('cod-order-mail: order lookup failed', error.message);
    return json({ ok: false, error: 'Order lookup failed.' }, 500);
  }
  // Unknown ref and wrong phone are indistinguishable on purpose: this endpoint
  // must not become an order/PII enumeration oracle.
  if (!order) return json({ ok: false, sent: false }, 200);

  const orderPhone = normalizePhone((order.customer as Record<string, unknown> | null)?.phone);
  if (!orderPhone || orderPhone !== phone) {
    return json({ ok: false, sent: false }, 200);
  }

  // Only a genuinely confirmed COD order may be announced. This also keeps a
  // failed/cancelled/expired order from ever being mailed.
  if (!order.is_cod || order.payment_status !== 'cod_pending') {
    return json({ ok: false, sent: false, reason: 'not a confirmed COD order' }, 200);
  }

  // Idempotency guard #2 (guard #1 lives inside sendOrderEmail).
  if (String(order.last_email_kind ?? '') === 'confirmed') {
    return json({ ok: true, sent: false, reason: 'already sent' }, 200);
  }

  try {
    const result = await sendOrderEmail(supabase, order, 'confirmed');
    if (!result.ok) {
      // Fail-open. The order is already valid and confirmed; a mail problem is
      // an operations detail, never an order problem. Log it for operators
      // without ever surfacing the provider's raw error to the caller.
      console.error('cod-order-mail: send failed', result.kind, result.skipped ? 'skipped' : 'error', result.error ?? '');
      return json({ ok: false, sent: false }, 200);
    }
    return json({ ok: true, sent: !result.skipped }, 200);
  } catch (err) {
    console.error('cod-order-mail: unexpected error', err instanceof Error ? err.message : 'unknown');
    return json({ ok: false, sent: false }, 200);
  }
});

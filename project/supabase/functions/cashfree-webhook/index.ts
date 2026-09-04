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
//   * Idempotent: already-paid orders short-circuit; only one path can flip
//     payment_status -> 'success' (guarded) so duplicate/replayed webhooks are
//     safe.
//
// Env (Supabase Edge Function secrets):
//   CASHFREE_SECRET_KEY, CASHFREE_ENV (TEST|PRODUCTION),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2';

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
    const expected = Number(order.total_amount);
    if (status === 'SUCCESS' && Math.abs(paidAmount - expected) <= 0.005) {
      const gatewayId = last?.payment_gateway_details as Record<string, unknown> | undefined;
      await supabase
        .from('retail_orders')
        .update({
          payment_status: 'success',
          order_status: 'processing',
          paid_at: new Date().toISOString(),
          txn_id: String(last?.cf_payment_id ?? gatewayId?.gateway_transaction_id ?? '') || order.txn_id,
          payment_provider: 'cashfree',
        })
        .eq('id', order.id);
      // Best-effort order-confirmation SMS (idempotent via sms_sent_at). Never
      // fails the webhook ack or blocks the verified payment.
      try {
        await supabase.functions.invoke('send-order-sms', { body: { orderRef: String(order.ref) } });
      } catch {
        // Missing/unconfigured SMS function must not fail the payment callback.
      }
    } else if (status === 'CANCELLED' || status === 'USER_DROPPED' || status === 'FAILED') {
      await supabase
        .from('retail_orders')
        .update({ payment_status: 'failed' })
        .eq('id', order.id);
    }
  }

  return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
});
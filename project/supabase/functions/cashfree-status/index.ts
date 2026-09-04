// Cashfree PG — authoritative, server-side payment-status verification.
//
// The frontend never decides payment success. This function asks Cashfree for
// the real payment state of the order, checks the paid amount matches the
// DSLANG order total (tamper protection) and only then marks the order PAID
// (payment_status = 'success', order_status = 'processing').
//
// Idempotent: already-paid orders short-circuit; the payment_id partial unique
// index prevents a second Cashfree order ever pairing with one DSLANG order.
//
// Env (Supabase Edge Function secrets):
//   CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (TEST|PRODUCTION),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2';

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

  let body: { orderRef?: string };
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
  const expected = Number(order.total_amount);

  if (paymentStatus === 'SUCCESS') {
    // Amount-tamper guard: only mark paid when the gateway amount matches the
    // DSLANG order total (within sub-paise float tolerance).
    if (Math.abs(paidAmount - expected) > 0.005) {
      return json({ verified: false, status: 'pending', order });
    }
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
    const { data: fresh } = await supabase
      .from('retail_orders')
      .select('*')
      .eq('id', order.id)
      .maybeSingle();
    // Best-effort order-confirmation SMS (idempotent via sms_sent_at). Never
    // blocks or fails the verified payment state.
    try {
      await supabase.functions.invoke('send-order-sms', { body: { orderRef: String(order.ref) } });
    } catch {
      // A missing/unconfigured SMS function must not fail the payment callback.
    }
    return json({ verified: true, status: 'paid', order: fresh || order });
  }

  if (paymentStatus === 'CANCELLED' || paymentStatus === 'USER_DROPPED' || paymentStatus === 'FAILED') {
    await supabase
      .from('retail_orders')
      .update({ payment_status: 'failed' })
      .eq('id', order.id);
    return json({ verified: false, status: 'failed', order });
  }

  return json({ verified: false, status: 'pending', order });
});
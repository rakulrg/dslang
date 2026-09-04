// Vercel Serverless Function — create a Cashfree payment order.
//
// This is the Vercel-hosted twin of the Supabase Edge Function
// `supabase/functions/cashfree-order/index.ts`. It performs the exact same
// Cashfree Create Order call and returns the same request/response shape, so
// the frontend can be pointed at it without changing anything else.
//
// Credentials live ONLY here (Vercel environment variables), never in the
// browser. The order totals are re-read from retail_orders (written
// authoritatively by create_retail_order) rather than taken from the client.
//
// Required env (Vercel project settings -> Environment Variables):
//   CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (TEST|PRODUCTION),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_ORIGIN.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    return res.status(200).send('ok');
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  const env = process.env.CASHFREE_ENV || 'TEST';
  const origin = (process.env.APP_ORIGIN || 'https://dslang.in').replace(/\/$/, '');
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
 if (!appId || !secretKey || !supabaseUrl || !serviceRole) {
  console.error('[cashfree-order] Missing environment variables', {
    CASHFREE_APP_ID: !!appId,
    CASHFREE_SECRET_KEY: !!secretKey,
    CASHFREE_ENV: !!env,
    SUPABASE_URL: !!supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: !!serviceRole,
  });

  return res.status(500).json({
    success: false,
    error: 'Server payment configuration is incomplete.',
  });
}

  let body: { orderId?: string; orderRef?: string };
  try {
    body = req.body ?? {};
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid request.' });
  }
  if (!body.orderId || !body.orderRef) {
    return res.status(400).json({ success: false, error: 'Missing order reference.' });
  }

  console.log('[cashfree-order] Environment check passed', {
  cashfreeEnv: env,
  hasAppId: !!appId,
  hasSecretKey: !!secretKey,
  hasSupabaseUrl: !!supabaseUrl,
  hasServiceRole: !!serviceRole,
});

const supabase = createClient(supabaseUrl, serviceRole);
  const { data: order, error } = await supabase
    .from('retail_orders')
    .select('id, ref, customer, total_amount, payment_status, payment_id, payment_provider')
    .eq('id', body.orderId)
    .eq('ref', body.orderRef)
    .maybeSingle();
  if (error || !order) {
  console.error('[cashfree-order] Supabase order lookup failed', {
    error: error?.message ?? null,
    code: error?.code ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
    orderFound: !!order,
  });

  return res.status(404).json({
    success: false,
    error: 'Order not found.',
  });
}

console.log('[cashfree-order] Order loaded successfully', {
  orderId: order.id,
  orderRef: order.ref,
  amount: order.total_amount,
});
  if (order.payment_status === 'success') {
    return res.status(409).json({ success: false, error: 'This order is already paid.' });
  }

  const amount = Number(order.total_amount);
  if (!(amount > 0)) {
    return res.status(400).json({ success: false, error: 'Nothing to charge for this order.' });
  }

  const orderAmount = amount.toFixed(2);
  const orderId = cashfreeOrderId(order.ref, order.id, order.payment_id ?? null);

  const customer = (order.customer as Record<string, unknown>) || {};
  const customerId = `dsl-${shortish(order.ref, 12)}`;
  const phone = String(customer.phone ?? '').replace(/\D/g, '');

  const payload = {
    order_amount: Number(orderAmount),
    order_currency: 'INR',
    order_id: orderId,
    order_note: `DSLANG order ${order.ref}`,
    customer_details: {
      customer_id: customerId,
      customer_name: String(customer.name ?? 'Customer') || undefined,
      customer_email: String(customer.email ?? '') || undefined,
      customer_phone: phone || undefined,
    },
    order_meta: {
      return_url: `${origin}/#/checkout?order_id={order_id}`,
      notify_url: `${process.env.APP_ORIGIN ?? 'https://dslang.in'}/api/cashfree-webhook`,
    },
  };
  // Drop empty customer fields (Cashfree rejects blank optional fields).
  const cd = payload.customer_details as Record<string, unknown>;
  for (const k of Object.keys(cd)) {
    if (cd[k] === undefined) delete cd[k];
  }

  const envKey = env.toUpperCase();
  const base = envKey === 'PRODUCTION' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';

  let api: any;
  try {
    const r = await fetch(`${base}/pg/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-version': '2025-01-01',
        'X-Client-Id': appId,
        'X-Client-Secret': secretKey,
      },
      body: JSON.stringify(payload),
    });
    api = await r.json().catch(() => ({}));
    if (!r.ok || !api || !api.payment_session_id) {
      // Log the FULL Cashfree response + which base URL/env was used. This is
      // the exact line to find in Vercel function logs when tracing a 502.
      // eslint-disable-next-line no-console
      console.error('[cashfree-order] Create order FAILED', JSON.stringify({
        httpStatus: r.status,
        baseUrl: base,
        env: envKey,
        response: api,
      }));
      return res.status(502).json({ success: false, error: 'Payment could not be initialized. Please try again.' });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cashfree-order] Create order threw', JSON.stringify({
      baseUrl: base,
      env: envKey,
      error: err instanceof Error ? err.message : String(err),
    }));
    return res.status(502).json({ success: false, error: 'Payment could not be initialized. Please try again.' });
  }

  // Persist the Cashfree order id (in payment_id) so status-verification and
  // webhooks can find this order, and retries reuse the same Cashfree order.
  const { error: updateError } = await supabase
    .from('retail_orders')
    .update({ payment_provider: 'cashfree', payment_id: orderId })
    .eq('id', order.id);
  if (updateError) {
    return res.status(500).json({ success: false, error: 'Payment could not be initialized. Please try again.' });
  }

  return res.status(200).json({
    success: true,
    orderRef: order.ref,
    orderId,
    paymentSessionId: api.payment_session_id,
    environment: env.toUpperCase() === 'PRODUCTION' ? 'PROD' : 'TEST',
    returnUrl: `${origin}/#/checkout?order_id=${orderId}`,
  });
}

function shortish(s: string, n: number): string {
  return s.replace(/[^0-9a-zA-Z]/g, '').toUpperCase().slice(0, n);
}

function cashfreeOrderId(ref: string, orderId: string, fallback: string | null): string {
  if (fallback) return fallback;
  return `DSL${shortish(ref, 10)}${shortish(orderId, 8)}`;
}
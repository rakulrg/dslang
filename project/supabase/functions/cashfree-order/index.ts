// Cashfree PG — create a payment order (Web Checkout / Standard Checkout).
//
// Security model:
//   * Credentials (CASHFREE_APP_ID / CASHFREE_SECRET_KEY) exist ONLY here on the
//     server (Supabase Edge Function secrets). They are NEVER returned to the
//     browser.
//   * The requested amount is NEVER trusted from the client. The order totals
//     are re-read from retail_orders (written authoritatively by
//     create_retail_order which re-prices every line, recomputes promo/shipping
//     and applies the >=999 free-shipping rule). Only the final stored
//     total_amount is charged.
//   * A retry with an already-charged order is rejected. Reusing an existing
//     Cashfree order id makes create-order idempotent so a double-click /
//     retry never spins up a second Cashfree session for the same DSLANG order.
//
// Env (Supabase Edge Function secrets):
//   CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (TEST|PRODUCTION),
//   CASHFREE_WEBHOOK_URL (optional override), APP_ORIGIN,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extra },
  });
}

function baseUrl(env: string): string {
  return env.toUpperCase() === 'PRODUCTION'
    ? 'https://api.cashfree.com'
    : 'https://sandbox.cashfree.com';
}

function shortish(s: string, n: number): string {
  return s.replace(/[^0-9a-zA-Z]/g, '').toUpperCase().slice(0, n);
}

// A deterministic, unique, alphanumeric Cashfree order id mapped 1:1 to the
// DSLANG order. re-using it (via payment_id) makes a retry idempotent: Cashfree
// returns the existing order for the same order_id instead of creating a new
// charge session.
function cashfreeOrderId(ref: string, orderId: string, fallback: string | null): string {
  if (fallback) return fallback;
  return `DSL${shortish(ref, 10)}${shortish(orderId, 8)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed.' }, 405);

  const appId = Deno.env.get('CASHFREE_APP_ID');
  const secretKey = Deno.env.get('CASHFREE_SECRET_KEY');
  const env = Deno.env.get('CASHFREE_ENV') || 'TEST';
  const origin = (Deno.env.get('APP_ORIGIN') || 'https://dslang.in').replace(/\/$/, '');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!appId || !secretKey || !supabaseUrl || !serviceRole) {
    return json({ success: false, error: 'Payment gateway is not configured on the server.' }, 500);
  }

  let body: { orderId?: string; orderRef?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid request.' }, 400);
  }
  if (!body.orderId || !body.orderRef) {
    return json({ success: false, error: 'Missing order reference.' }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRole);

  const { data: order, error } = await supabase
    .from('retail_orders')
    .select('id, ref, customer, total_amount, payment_status, payment_id, payment_provider')
    .eq('id', body.orderId)
    .eq('ref', body.orderRef)
    .maybeSingle();
  if (error || !order) return json({ success: false, error: 'Order not found.' }, 404);
  if (order.payment_status === 'success') {
    return json({ success: false, error: 'This order is already paid.' }, 409);
  }

  const amount = Number(order.total_amount);
  if (!(amount > 0)) {
    return json({ success: false, error: 'Nothing to charge for this order.' }, 400);
  }

  // Authoritative amount, 2-decimal INR string. Never taken from the client.
  const orderAmount = amount.toFixed(2);
  const orderId = cashfreeOrderId(order.ref, order.id, order.payment_id ?? null);

  const customer = (order.customer as Record<string, unknown>) || {};
  const customerId = `dsl-${shortish(order.ref, 12)}`;
  const phone = String(customer.phone ?? '').replace(/\D/g, '');
  const webhookUrl =
    Deno.env.get('CASHFREE_WEBHOOK_URL') ||
    `${supabaseUrl.replace(/\/$/, '')}/functions/v1/cashfree-webhook`;

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
      notify_url: webhookUrl,
    },
  };
  // Drop empty customer fields (Cashfree rejects blank optional fields).
  const cd = payload.customer_details as Record<string, unknown>;
  for (const k of Object.keys(cd) as (keyof typeof cd & string)[]) {
    if (cd[k] === undefined) delete cd[k];
  }

  const base = baseUrl(env);
  let res: Response;
  try {
    res = await fetch(`${base}/pg/orders`, {
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
  } catch {
    return json({ success: false, error: 'Payment could not be initialized. Please try again.' }, 502);
  }

  let api: any;
  try {
    api = await res.json();
  } catch {
    api = {};
  }

  if (!res.ok || !api || !api.payment_session_id) {
    return json({ success: false, error: 'Payment could not be initialized. Please try again.' }, 502);
  }

  // Persist the Cashfree order id (in payment_id) so status-verification and
  // webhooks can find this order, and retries reuse the same Cashfree order.
  const { error: updateError } = await supabase
    .from('retail_orders')
    .update({ payment_provider: 'cashfree', payment_id: orderId })
    .eq('id', order.id);
  if (updateError) {
    return json({ success: false, error: 'Payment could not be initialized. Please try again.' }, 500);
  }

  return json({
    success: true,
    orderRef: order.ref,
    orderId,
    paymentSessionId: api.payment_session_id,
    environment: env.toUpperCase() === 'PRODUCTION' ? 'PROD' : 'TEST',
    returnUrl: `${origin}/#/checkout?order_id=${orderId}`,
  });
});
// send-order-sms — transactional order-confirmation SMS (MSG91), idempotent.
//
// Purpose:
//   Sends the order-confirmation SMS to the customer AFTER the order exists and
//   the payment/order status has been VERIFIED server-side. It is invoked by the
//   Cashfree backend functions (cashfree-status / cashfree-webhook) at the exact
//   moment an order flips to payment_status = 'success'. The frontend NEVER sends
//   SMS and NEVER sees the provider API key.
//
// SMS content:
//   * DSLANG
//   * Order ID / reference (e.g. DSL-R-XXXX)
//   * Order confirmation text
//   * Order amount (INR, e.g. "Rs. 1,299")
//   * A Track Order URL (https://<app-origin>/#/track-order/<ref>)
//
// MSG91 transactional API (v5 Flow / template):
//   POST https://api.msg91.com/api/v5/flow/
//   Header:  authkey: <MSG91_AUTH_KEY>
//   Body:    { template_id, short_url: "0", real_time_response: "1",
//              recipients: [{ mobiles: "91<10-digit>", VAR1..VARn: ... }] }
//   The template is created/approved in MSG91 and its variable placeholders are
//   substituted from the order. The exact template_id and its variable mapping
//   are config, NOT hardcoded values, so this file stays provider-flexible.
//
// Idempotency:
//   `retail_orders.sms_sent_at` is only set AFTER a successful provider ack.
//   A second invocation (duplicate webhook, retry, status+webhook firing) sees
//   sms_sent_at non-NULL and no-ops, so the customer never gets duplicate SMS.
//   We also refuse to send if payment_status != 'success' — the SMS is never
//   fired before order creation + verified payment.
//
// Env (Supabase Edge Function secrets — NOT provided in this repo):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_ORIGIN,
//   MSG91_AUTH_KEY, MSG91_TEMPLATE_ID (flow id), MSG91_SENDER_ID,
//   MSG91_CLIENT_ID / MSG91_CLIENT_SECRET (optional, for short-url auto-links).
//
// The function is fully implemented (builds/type-checks as a Deno Edge Function)
// but MUST NOT be deployed until the credentials above are supplied to the
// Supabase dashboard as Edge Function secrets.

import { createClient } from 'npm:@supabase/supabase-js@2';

const VALID_REF = /^[A-Z0-9-]{6,32}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function describeSmsCode(code: number): string {
  switch (code) {
    case 201: return 'SMS queued/approved.';
    case 200: return 'SMS accepted.';
    case 401: return 'MSG91 authentication failed (check MSG91_AUTH_KEY).';
    case 422: return 'MSG91 rejected the message (check template_id / sender).';
    case 500: return 'MSG91 server error.';
    case 503: return 'MSG91 temporarily unavailable.';
    default: return `MSG91 responded ${code}.`;
  }
}

async function sendMsg91(phone: string, vars: Record<string, string>): Promise<{ ok: boolean; reason?: string }> {
  const authKey = Deno.env.get('MSG91_AUTH_KEY');
  const templateId = Deno.env.get('MSG91_TEMPLATE_ID') || Deno.env.get('MSG91_FLOW_ID');
  const senderId = Deno.env.get('MSG91_SENDER_ID');
  if (!authKey || !templateId) {
    return { ok: false, reason: 'MSG91 credentials are not configured on the server.' };
  }

  const base = Deno.env.get('MSG91_BASE_URL') || 'https://api.msg91.com';
  const url = `${base}/api/v5/flow/`;

  // MSG91 expects an international "91XXXXXXXXXX" (India + E164) mobile.
  const mobiles = `91${phone}`;
  const recipients: Record<string, unknown> = { mobiles };
  // Substitute template variables (VAR1…). Extra keys are harmless.
  for (const [k, v] of Object.entries(vars)) {
    recipients[k.toUpperCase()] = v;
  }

  const body: Record<string, unknown> = {
    template_id: templateId,
    short_url: '0',
    real_time_response: '1',
    recipients: [recipients],
  };
  if (senderId) body.sender = senderId;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authkey: authKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok && res.status <= 202) {
      return { ok: true, reason: text };
    }
    return { ok: false, reason: `${describeSmsCode(res.status)} ${text}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'MSG91 request failed.' };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);

  let body: { orderRef?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Bad request.' }, 400);
  }

  const orderRef = String(body.orderRef ?? '').trim().toUpperCase();
  if (!VALID_REF.test(orderRef)) {
    return json({ ok: false, error: 'Missing or invalid order reference.' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const appOrigin = Deno.env.get('APP_ORIGIN');
  if (!supabaseUrl || !serviceRole) {
    return json({ ok: false, error: 'SMS sender not configured.' }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRole);

  // Read the order. SECURITY DEFINER not needed here: service_role bypasses RLS.
  const { data: order, error: orderError } = await supabase
    .from('retail_orders')
    .select('*')
    .eq('ref', orderRef)
    .maybeSingle();
  if (orderError || !order) {
    return json({ ok: false, error: 'Order not found.' }, 404);
  }

  // Idempotency: only send once, and only after the order is confirmed/paid.
  if (order.sms_sent_at) {
    return json({ ok: true, sent: false, reason: 'already-sent' });
  }
  if (order.payment_status !== 'success') {
    return json({ ok: true, sent: false, reason: 'payment-not-verified' });
  }

  const phoneRaw = String(order.customer?.phone ?? '').replace(/\D/g, '');
  if (!/^[0-9]{10,12}$/.test(phoneRaw)) {
    return json({ ok: false, error: 'No valid customer mobile number on this order.' }, 400);
  }
  const phone = phoneRaw.slice(-10);

  const trackUrl = appOrigin
    ? `${appOrigin.replace(/\/+$/, '')}/#/track-order/${orderRef}`
    : `https://dslang.in/#/track-order/${orderRef}`;

  // Order amount: MSG91 variables are strings.
  const totalText = new Intl.NumberFormat('en-IN').format(Number(order.total_amount) || 0);

  const vars: Record<string, string> = {
    VAR1: 'DSLANG',
    VAR2: orderRef,
    VAR3: `Your order is confirmed. Amount Rs. ${totalText}.`,
    VAR4: `Track: ${trackUrl}`,
  };

  const sendResult = await sendMsg91(phone, vars);
  if (!sendResult.ok) {
    // Do NOT set sms_sent_at on failure — a retry must be able to send.
    return json({ ok: false, error: `SMS could not be sent. ${sendResult.reason ?? ''}`.trim() }, 502);
  }

  // Only now mark it sent so duplicate callbacks cannot re-send.
  await supabase
    .from('retail_orders')
    .update({ sms_sent_at: new Date().toISOString() })
    .eq('id', order.id);

  return json({ ok: true, sent: true, ref: orderRef });
});
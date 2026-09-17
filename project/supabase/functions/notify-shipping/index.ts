// notify-shipping — transactional shipping notification (SMS + optional WhatsApp)
// on the Order Status -> 'shipped' transition. Idempotent, admin-gated, and
// deliberately SEPARATE from send-order-sms (the ORDER-CONFIRMATION SMS, fired
// by the Cashfree functions when payment flips to success). A customer therefore
// receives two distinct messages:
//   1) order confirmation (send-order-sms, at payment success)
//   2) shipping update   (notify-shipping, when an admin ships the order)
//
// Invoked ONLY by the authenticated ADMIN from the Retail Orders panel. The admin
// browser session's JWT is verified against admin_users (authoritative gate), so
// a customer who knows an order ref cannot trigger SMS spam.
//
// Guards (all must hold before anything is sent):
//   * Caller is an admin (JWT in Authorization header + admin_users membership)
//   * payment_status = 'success'  (never notify before a verified payment)
//   * order_status   = 'shipped'  (already in the shipped transition)
//   * shipping_sms_sent_at is NULL (idempotency — like sms_sent_at, set ONLY
//     after a real provider ack; a re-trigger can always re-send)
//
// SMS:  MSG91 v5 Flow (shipping template) — MSG91_SHIPPING_TEMPLATE_ID.
//       Falls back to MSG91_TEMPLATE_ID ONLY if the shipping one is absent, so
//       a single template setup still works, but the shipping-specific template
//       is recommended so the two messages read differently.
// WA:   MSG91 WhatsApp (api.msg91.com/api/v5/whatsapp/flow/), best-effort.
//       Fires ONLY if MSG91_WHATSAPP_TEMPLATE_ID is configured — otherwise the
//       function reports whatsapp:'not-configured' and still marks the SMS sent.
//       The WhatsApp template must be created + approved in the MSG91 WhatsApp
//       console (Meta template). MSG91 = the WhatsApp Business API path used
//       here because the project already uses MSG91 for SMS; Interakt / Gupshup
//       / Twilio would be drop-in alternatives behind the same template vars.
//
// Env (Supabase Edge Function secrets — NOT provided in this repo):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_ORIGIN,
//   MSG91_AUTH_KEY, MSG91_SHIPPING_TEMPLATE_ID, MSG91_SENDER_ID,
//   MSG91_WHATSAPP_TEMPLATE_ID (optional WhatsApp), MSG91_BASE_URL / *_WHATSAPP_BASE_URL.
//
// Not deployed until the MSG91 secrets are added to the Supabase dashboard
// (same requirement as send-order-sms).

import { createClient } from 'npm:@supabase/supabase-js@2';

const VALID_REF = /^[A-Z0-9-]{6,32}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function describeMsg91Code(code: number): string {
  switch (code) {
    case 201: return 'queued/approved.';
    case 200: return 'accepted.';
    case 401: return 'MSG91 authentication failed (check MSG91_AUTH_KEY).';
    case 422: return 'MSG91 rejected the message (check template_id / sender).';
    default: return `MSG91 responded ${code}.`;
  }
}

interface SendOutcome { ok: boolean; reason?: string }

async function sendMsg91Flow(
  baseUrl: string,
  path: string,
  authKey: string,
  templateId: string,
  phone: string,
  vars: Record<string, string>,
  senderId?: string,
): Promise<SendOutcome> {
  const url = `${baseUrl}${path}`;
  const recipients: Record<string, unknown> = { mobiles: `91${phone}` };
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
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok && res.status <= 202) return { ok: true, reason: text };
    return { ok: false, reason: `${describeMsg91Code(res.status)} ${text}`.trim() };
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
  if (!supabaseUrl || !serviceRole) {
    return json({ ok: false, error: 'notify-shipping is not configured.' }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRole);

  // --- Admin gate: only an authenticated admin_users member can trigger this. ---
  const authz = req.headers.get('Authorization') ?? '';
  const token = authz.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return json({ ok: false, error: 'Admin authentication required.' }, 401);
  }
  let adminId: string | null = null;
  try {
    const { data: user, error: userErr } = await supabase.auth.getUser(token);
    if (!userErr && user?.user) adminId = user.user.id;
  } catch {
    adminId = null;
  }
  if (!adminId) {
    return json({ ok: false, error: 'Invalid token.' }, 401);
  }
  const { data: adminRow, error: adminErr } = await supabase
    .from('admin_users')
    .select('id')
    .eq('user_id', adminId)
    .maybeSingle();
  if (adminErr || !adminRow) {
    return json({ ok: false, error: 'Only an authorized administrator can send shipping notifications.' }, 403);
  }

  // --- Read the order. ---
  const { data: order, error: orderError } = await supabase
    .from('retail_orders')
    .select('*')
    .eq('ref', orderRef)
    .maybeSingle();
  if (orderError || !order) {
    return json({ ok: false, error: 'Order not found.' }, 404);
  }

  // --- Guards. ---
  if (order.shipping_sms_sent_at) {
    return json({ ok: true, sent: false, reason: 'already-notified' });
  }
  if (order.payment_status !== 'success') {
    return json({ ok: true, sent: false, reason: 'payment-not-verified' });
  }
  if (order.order_status !== 'shipped') {
    return json({ ok: true, sent: false, reason: 'order-not-shipped' });
  }

  const phoneRaw = String(order.customer?.phone ?? '').replace(/\D/g, '');
  if (!/^[0-9]{10,12}$/.test(phoneRaw)) {
    return json({ ok: false, error: 'No valid customer mobile number on this order.' }, 400);
  }
  const phone = phoneRaw.slice(-10);

  const trackingId = String(order.tracking_id ?? '').trim();
  const appOrigin = Deno.env.get('APP_ORIGIN');
  const trackUrl = appOrigin
    ? `${appOrigin.replace(/\/+$/, '')}/#/track-order/${orderRef}`
    : `https://dslang.in/#/track-order/${orderRef}`;

  // Short, clear message: shipped + tracking ID when present + tracking link.
  const vars: Record<string, string> = {
    VAR1: 'DSLANG',
    VAR2: orderRef,
    VAR3: trackingId
      ? `Your order has been shipped. Tracking ID: ${trackingId}.`
      : 'Good news! Your order has been shipped.',
    VAR4: `Track shipment: ${trackUrl}`,
  };

  // --- SMS. ---
  const authKey = Deno.env.get('MSG91_AUTH_KEY');
  const shippingTemplate =
    Deno.env.get('MSG91_SHIPPING_TEMPLATE_ID') || Deno.env.get('MSG91_TEMPLATE_ID') || Deno.env.get('MSG91_FLOW_ID');
  const senderId = Deno.env.get('MSG91_SENDER_ID');
  if (!authKey || !shippingTemplate) {
    return json({ ok: false, error: 'MSG91 shipping credentials are not configured on the server.' }, 502);
  }
  const base = Deno.env.get('MSG91_BASE_URL') || 'https://api.msg91.com';
  const sms = await sendMsg91Flow(base, '/api/v5/flow/', authKey, shippingTemplate, phone, vars, senderId);
  if (!sms.ok) {
    return json({ ok: false, error: `SMS could not be sent. ${sms.reason ?? ''}`.trim() }, 502);
  }

  // --- WhatsApp, best-effort. Never fails the request; reported separately. ---
  let whatsapp: SendOutcome & { configured: boolean } = { ok: false, configured: false, reason: 'not-configured' };
  const waTemplate = Deno.env.get('MSG91_WHATSAPP_TEMPLATE_ID');
  if (waTemplate) {
    const waBase = Deno.env.get('MSG91_WHATSAPP_BASE_URL') || base;
    whatsapp = {
      configured: true,
      ...(await sendMsg91Flow(waBase, '/api/v5/whatsapp/flow/', authKey, waTemplate, phone, vars)),
    };
  }

  // Only now mark it sent so duplicate callbacks cannot re-send. The flag tracks
  // the primary SMS channel; WhatsApp is additive and best-effort.
  await supabase
    .from('retail_orders')
    .update({ shipping_sms_sent_at: new Date().toISOString() })
    .eq('id', order.id);

  return json({
    ok: true,
    sent: true,
    ref: orderRef,
    whatsapp: {
      configured: whatsapp.configured,
      sent: whatsapp.ok,
      reason: whatsapp.ok ? undefined : whatsapp.reason,
    },
  });
});
// send-order-mail — Admin "Email Customer / Resend Email" endpoint.
//
//   POST {url}/send-order-mail           Authorization: Bearer <admin JWT>
//     AUTH: fail-closed on a missing/invalid JWT, and on any caller without a
//       row in public.admin_users. This is the SAME authoritative admin model
//       the storefront, the Admin UI and every SECURITY DEFINER RPC already
//       use, resolved through the service-role client.
//       It used to gate on `user_metadata.role === 'admin'`, which is NOT a
//       security boundary: user_metadata is self-editable by the account owner
//       via supabase.auth.updateUser({ data: … }). Any signed-in visitor could
//       therefore have granted themselves the role and then used this endpoint
//       to email arbitrary orders and read back the customer's address.
//       app_metadata is server-controlled, but admin_users is the real model.
//     BODY: { orderId?: string; ref?: string; kind?: 'confirmed' | 'shipped' }
//       kind is OPTIONAL: when omitted it is derived from the order state —
//       shipped/delivered → 'shipped', otherwise 'confirmed'. The admin can
//       override to force a specific template (e.g. re-send confirmation to an
//       old order).
//
// This is the MANUAL trigger for the shared email path. It always force-sends
// (stamps last_email_kind + last_email_sent_at) so support can see exactly when
// the customer was last emailed.
//
// The response deliberately does NOT echo the customer's email address. It is
// not needed to drive the UI, and returning it would make this endpoint a
// PII-disclosure + order-enumeration oracle for anyone who ever cleared the
// admin gate. The Admin UI already has the address from the order row.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendOrderEmail, type OrderEmailKind } from '../_shared/emails.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 204, headers: CORS });

  const authHeader = req.headers.get('authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  if (!Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    return json({ ok: false, error: 'Server config missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' }, 500);
  }

  // 1. Admin gate — fail-closed, and resolved from the AUTHORITATIVE source.
  //    `supabase.auth.getUser` validates the JWT (so an anon or forged token
  //    cannot get past this line); the membership test is then a service-role
  //    read of public.admin_users, which the caller cannot influence.
  const { data: userData, error: userError } = await supabase.auth.getUser(
    authHeader.replace(/^Bearer\s+/i, '').trim()
  );
  if (userError || !userData?.user) {
    return json({ ok: false, error: 'Authentication required.' }, 401);
  }
  const callerId = String(userData.user.id ?? '');
  const { data: adminRow, error: adminError } = await supabase
    .from('admin_users')
    .select('user_id')
    .eq('user_id', callerId)
    .maybeSingle();
  if (adminError || !adminRow) {
    return json({ ok: false, error: 'Admin role required.' }, 403);
  }

  // 2. Body — orderId or ref (self-excluding), optional kind override.
  let orderId = '';
  let ref = '';
  let kindOverride: OrderEmailKind | null = null;
  try {
    const b = await req.json();
    orderId = String(b?.orderId ?? '').trim();
    ref = String(b?.ref ?? '').trim();
    const k = String(b?.kind ?? '');
    if (k === 'confirmed' || k === 'shipped') kindOverride = k;
  } catch {
    orderId = '';
    ref = '';
  }
  if (!orderId && !ref) {
    return json({ ok: false, error: 'Missing orderId or ref.' }, 400);
  }

  // 3. Load the order (server row is the only truth).
  let query = supabase.from('retail_orders').select('*');
  query = orderId ? query.eq('id', orderId) : query.eq('ref', ref);
  const { data: order, error } = await query.maybeSingle();
  if (error || !order) {
    return json({ ok: false, error: 'Order not found.' }, 404);
  }

  // 4. Derive or use the requested kind, then send (admin actions always force).
  const status = String(order.order_status ?? '');
  const kind: OrderEmailKind = kindOverride ?? (status === 'shipped' || status === 'delivered' ? 'shipped' : 'confirmed');
  const result = await sendOrderEmail(supabase, order, kind, { force: true });
  if (!result.ok && !result.skipped) {
    return json({ ok: false, error: result.error ?? 'Email could not be sent.', kind }, 422);
  }
  if (!result.ok && result.skipped) {
    return json({ ok: false, error: result.error ?? 'No customer email on this order.', kind }, 422);
  }
  // No customer email in the response: it is not needed by the UI and would
  // turn this into a PII lookup. `hasEmail` only says whether a send was
  // possible, which is the one fact the Admin button actually needs.
  return json({ ok: true, kind, hasEmail: true, sentAt: new Date().toISOString() }, 200);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}
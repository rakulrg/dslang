// Delhivery — admin "Ship Order" endpoint (neutral surface). This is what the
// Admin Dashboard ship panel calls.
//
//   POST {url}/delhivery-order          Authorization: Bearer <service-role>
//     AUTH: requires a signed-in admin (user_metadata.role === 'admin') — the
//       function looks up auth:getUser and checks role. Fail-closed on any
//       resolution error, missing JWT, or non-admin role.
//     BODY: { orderId: string }
//     NEUTRAL surface it returns (identical to the core fail-closed contract):
//       { ok, created, alreadyShipped, inProgress, error,
//         shippingProvider, awbNumber, courierName, labelUrl, shippedAt,
//         trackingUrl, trackingId }
//     It NEVER trusts client amounts/identifiers — everything comes from the
//     SERVER row (retail_orders). It NEVER unlocks a parcel unless the adapter
//     is configured for PRODUCTION Delhivery (fail-closed: staging → refusls,
//     records ship_attempt_error, admin sees clean RETRY).
//
// THIS function only marshals the request → _shared/delhivery/shipment.ts
// (processEligibleShipment). It does NOT know the provider contract.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { processEligibleShipment } from '../_shared/delhivery/shipment.ts';

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

  // Startup parameters are verified at edge runtime (Supabase sets env from the
  // dashboard's Verified params panel); we fail-closed if missing.
  if (!Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    return json({ ok: false, inProgress: false, error: 'Server config missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' }, 500);
  }

  // 1. Admin gate — resolve the caller from the JWT; fail-closed.
  const { data: userData, error: userError } = await supabase.auth.getUser(
    authHeader.replace(/^Bearer\s+/i, '').trim()
  );
  if (userError || !userData?.user) {
    return json({ ok: false, inProgress: false, error: 'Authentication required.' }, 401);
  }
  const role = String(userData.user.user_metadata?.role ?? '');
  if (role !== 'admin') {
    return json({ ok: false, inProgress: false, error: 'Admin role required.' }, 403);
  }

  // 2. Body — only orderId; everything else comes from the row.
  let orderId = '';
  try {
    const b = await req.json();
    orderId = String(b?.orderId ?? '').trim();
  } catch {
    orderId = '';
  }
  if (!orderId) {
    return json({ ok: false, inProgress: false, error: 'Missing orderId.' }, 400);
  }

  // 3. Ship via the shared neutral core (fail-closed; CAS-guarded; idempotent).
  const result = await processEligibleShipment(supabase, orderId, 'admin');
  return json(result, result.ok ? 200 : result.inProgress ? 409 : 422);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

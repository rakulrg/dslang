// expire-stale-orders — scheduled sweep for abandoned retail checkouts.
//
// Problem: an order can sit at payment_status='pending' forever when Cashfree
// never fires a webhook — the customer left the checkout, or Cashfree never
// created a payment record. Stock locked by such orders never returns. Also,
// since definitive payment failures no longer restock at status-verification
// time (the order stays reserved so "Try Again" can reuse the same order), a
// failed order keeps its reservation until the sweep reclaims it here.
//
// This function runs on a schedule (pg_cron → net.http_post) and reclaims:
//   * candidates: payment_status IN ('pending','failed') AND
//     stock_restored_at IS NULL AND created_at <= now() - minutes (default 30).
//   * for each, consult Cashfree (mirrors the cashfree-status decision table):
//       - never charmed (no payment record)      -> EXPIRE + restock (RPC)
//       - last payment terminal-failed           -> EXPIRE + restock (RPC)
//       - last payment SUCCESS (amount matches)  -> mark PAID (no restock)
//       - same, amount mismatch / non-terminal   -> SKIP (may still settle)
//       - Cashfree API error                     -> SKIP
//   * the expire+restock write is a single gated SQL RPC
//     (expire_stale_retail_order) that CAS-updates pending|failed -> failed then
//     calls restock_retail_order_items — atomic, idempotent, race-safe.
//
// Security:
//   * Authorization must be 'Bearer <service_role JWT>'. The gateway runs with
//     verify_jwt=true and validates that token's signature, issuer, project and
//     expiry before this code runs; the function then reads the `role` claim
//     locally (see jwtRole) and requires it to be exactly 'service_role'. A
//     signed-in shopper's JWT clears the gateway but fails that role check.
//   * The decode is a claims read, NOT signature verification. It is sound only
//     while verify_jwt=true. Never disable it without replacing this check.
//   * A dedicated SWEEP_TRIGGER_TOKEN is also honored when configured. NOTE: a
//     non-JWT bearer only reaches the function if it is deployed with
//     verify_jwt = false (config.toml), otherwise the gateway rejects it before
//     the code runs. The service-role JWT path works with default verify_jwt.
//   * Anonymous callers (anon key) are rejected — this endpoint mutates orders.
//   * cashfree-status remains the only user-facing verification endpoint.
//
// Env (Supabase Edge Function secrets):
//   CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (default TEST),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SWEEP_TRIGGER_TOKEN (optional).
//
// Invocation:
//   POST { "minutes": 30, "limit": 20 }                  (production sweep)
//   POST { "minutes": 0,  "dryRun": true }               (candidate preview)
//   POST { "ref": "DSL-R-XXXX", "phone": "9034071504" }  (single-order test)

import { createClient } from 'npm:@supabase/supabase-js@2';
import { bearerToken, constantTimeEqual } from '../_shared/auth-util.ts';

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

// Read the `role` claim out of a JWT payload, entirely locally.
//
// THIS IS NOT SIGNATURE VERIFICATION. It trusts the caller-supplied bytes. It
// is only sound because this function is deployed with verify_jwt=true, so the
// Supabase gateway has already validated the signature, issuer, project and
// expiry before execution reaches here. If verify_jwt were ever disabled, this
// function must NOT be trusted — an attacker could hand-craft a payload with
// role: 'service_role' and it would be accepted.
//
// Returns '' for anything that is not a decodable three-part token with a
// string `role`, which fails closed at the call site.
function jwtRole(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) return '';
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : '';
  } catch {
    return '';
  }
}

const TERMINAL_FAILED = new Set(['CANCELLED', 'USER_DROPPED', 'FAILED']);
const NON_TERMINAL = new Set(['PROCESSING', 'ACTIVE', 'PENDING', 'AUTHORISING', 'VOID']);

interface OrderRow {
  id: string;
  ref: string | null;
  customer: Record<string, unknown> | null;
  payment_id: string | null;
  total_amount: number;
  is_cod: boolean;
  amount_paid_upfront: number;
  payment_status: string;
  created_at: string;
}

interface Decision {
  action: 'paid' | 'expire' | 'skip';
  note: string;
  payment?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed.' }, 405);

  const appId = Deno.env.get('CASHFREE_APP_ID');
  const secretKey = Deno.env.get('CASHFREE_SECRET_KEY');
  const env = Deno.env.get('CASHFREE_ENV') || 'TEST';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const token = Deno.env.get('SWEEP_TRIGGER_TOKEN');

  if (!appId || !secretKey || !supabaseUrl || !serviceRole) {
    return json({ success: false, error: 'Sweep is not configured on the server.' }, 500);
  }

  // Authorization — the sweep is service-role only.
  //
  // verify_jwt=true is the security boundary: the gateway has already verified
  // the bearer token's signature, issuer, project and expiry BEFORE this code
  // runs, and rejects the request otherwise. The decode below is NOT signature
  // verification and must not be treated as such — it only reads claims from a
  // token the gateway already trusts, in order to enforce the role check that
  // verify_jwt does not perform on its own.
  //
  // A valid signature is not sufficient authority: a signed-in shopper's JWT
  // (role 'authenticated') clears the gateway too, so the role claim is
  // asserted here and such a caller is rejected without reaching the sweep.
  //
  // The credential is deliberately NOT compared against our own
  // SUPABASE_SERVICE_ROLE_KEY. That value is injected per-runtime, while the
  // caller presents a separately issued service-role JWT: same project and
  // role, different bytes, so an exact comparison rejects legitimate callers
  // (and silently breaks on key rotation). Authority comes from the claim, not
  // from byte equality. The key is still used below to build the Supabase
  // client, which applies service-role privileges to the sweep's own writes.
  const auth = req.headers.get('authorization') || '';
  const presented = bearerToken(auth);
  let allowed = false;

  if (presented) {
    // base64url-decode the JWT payload and read the role claim. No network
    // call and no user lookup: the service-role key carries no 'sub', so it is
    // not a user JWT and cannot be resolved via auth.getUser().
    if (jwtRole(presented) === 'service_role') allowed = true;

    // A dedicated opaque secret for callers that cannot present a JWT. Only
    // reachable when a JWT is actually presented, so this branch is inert
    // while the gateway enforces verify_jwt=true.
    if (!allowed && token && (await constantTimeEqual(presented, token))) {
      allowed = true;
    }
  }
  if (!allowed) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  let body: {
    minutes?: number;
    limit?: number;
    dryRun?: boolean;
    ref?: string;
    phone?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid request.' }, 400);
  }

  const minutes = Math.max(0, Number(body.minutes ?? 30) || 30);
  const limit = Math.max(1, Math.min(200, Number(body.limit ?? 20) || 20));
  const dryRun = Boolean(body.dryRun);
  const supabase = createClient(supabaseUrl, serviceRole);

  // 1. Candidate selection.
  let orders: OrderRow[] = [];
  if (body.ref) {
    const { data } = await supabase
      .from('retail_orders')
      .select('id, ref, customer, payment_id, total_amount, is_cod, amount_paid_upfront, payment_status, created_at')
      .eq('ref', body.ref)
      .limit(1);
    orders = (data as OrderRow[] | null) ?? [];
  } else {
    const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
    const { data, error } = await supabase
      .from('retail_orders')
      .select('id, ref, customer, payment_id, total_amount, is_cod, amount_paid_upfront, payment_status, created_at')
      .in('payment_status', ['pending', 'failed'])
      .is('stock_restored_at', null)
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) return json({ success: false, error: `Candidate query failed: ${error.message}` }, 500);
    orders = (data as OrderRow[] | null) ?? [];
  }

  // 2. Decide each candidate against Cashfree.
  const base = baseUrl(env);
  const cfHeaders = {
    Accept: 'application/json',
    'x-api-version': '2025-01-01',
    'X-Client-Id': appId,
    'X-Client-Secret': secretKey,
  };

  async function decide(order: OrderRow): Promise<Decision> {
    // COD GUARD: a full-COD order is confirmed at creation and is waiting for
    // the delivery agent to collect cash — there is no gateway order and no
    // pending payment to expire. The bulk sweep already excludes it via
    // payment_status, but the single-order `ref` path can be pointed at any
    // ref, so it is re-checked here. Expiring it would cancel a live order and
    // wrongly release its stock reservation.
    if (order.is_cod && order.payment_status === 'cod_pending') {
      return { action: 'skip', note: 'COD order awaiting collection on delivery' };
    }

    // No Cashfree order was ever created -> cannot be paid.
    if (!order.payment_id) return { action: 'expire', note: 'no Cashfree order' };

    try {
      const res = await fetch(`${base}/pg/orders/${encodeURIComponent(order.payment_id)}`, {
        method: 'GET',
        headers: cfHeaders,
      });
      const api = (await res.json()) as { order_status?: string };
      const os = api.order_status || '';
      // PAID/ACTIVE -> inspect payments; anything else already terminal on CF.
      if (os !== 'PAID' && os !== 'ACTIVE') {
        return { action: 'expire', note: `Cashfree order_status=${os || 'unknown'}` };
      }
    } catch {
      return { action: 'skip', note: 'Cashfree order-status lookup failed' };
    }

    try {
      const res = await fetch(`${base}/pg/orders/${encodeURIComponent(order.payment_id)}/payments`, {
        method: 'GET',
        headers: cfHeaders,
      });
      const api = await res.json();
      const payments: Record<string, unknown>[] = Array.isArray(api)
        ? api
        : api?.data && Array.isArray(api.data)
          ? api.data
          : [];
      // Authoritative expected charge = amount_paid_upfront — the single
      // "payable now" figure (online = Sale Price minus the capped ₹50
      // discount). Never a client-supplied amount.
      const expected = Number(order.amount_paid_upfront ?? order.total_amount);

      if (payments.length === 0) {
        return { action: 'expire', note: 'no payment record after expiry window' };
      }

      const last = payments[payments.length - 1];
      const paymentStatus = String(last?.payment_status ?? '').toUpperCase();
      const paidAmount = Number(last?.order_amount ?? last?.amount ?? 0);

      if (paymentStatus === 'SUCCESS') {
        return Math.abs(paidAmount - expected) > 0.005
          ? { action: 'skip', note: `success but amount mismatch (${paidAmount} vs ${expected})` }
          : { action: 'paid', note: 'gateway reports SUCCESS', payment: last };
      }

      if (TERMINAL_FAILED.has(paymentStatus)) {
        // A refused or returned parcel is never settled here — an already-paid
        // order keeps payment_status 'success' and an admin flips it to
        // cancelled/returned. This branch only covers a gateway-side failure
        // of an online payment.
        return { action: 'expire', note: `payment_status=${paymentStatus}` };
      }

      return NON_TERMINAL.has(paymentStatus)
        ? { action: 'skip', note: `payment_status=${paymentStatus} (in flight)` }
        : { action: 'expire', note: `unknown payment_status=${paymentStatus}` };
    } catch {
      return { action: 'skip', note: 'Cashfree payments lookup failed' };
    }
  }

  // 3. Apply.
  const details: Array<{ ref: string | null; action: Decision['action']; note: string }> = [];
  let paid = 0;
  let expired = 0;
  let skipped = 0;

  for (const order of orders) {
    const d = await decide(order);
    details.push({ ref: order.ref, action: d.action, note: d.note });

    if (d.action === 'paid') {
      paid++;
      if (!dryRun) {
        const gatewayId = d.payment?.payment_gateway_details as Record<string, unknown> | undefined;
        await supabase
          .from('retail_orders')
          .update({
            payment_status: 'success',
            // Full-COD orders are skipped above, so this only ever marks a
            // legacy COD order that really did pay an advance — for those
            // Preserve stored historical money, but use the normal fulfilment
            // state for every verified payment.
            order_status: 'processing',
            paid_at: new Date().toISOString(),
            txn_id:
              String(d.payment?.cf_payment_id ?? gatewayId?.gateway_transaction_id ?? '') ||
              String(order.payment_id ?? ''),
            payment_provider: 'cashfree',
          })
          .eq('id', order.id)
          // Hard guard, independent of the `decide` skip above: a new COD order
          // must never be settled through the gateway, so the sweep updates
          // zero rows for one even if it were reached with a stale event.
          .neq('payment_status', 'cod_pending');
      }
    } else if (d.action === 'expire') {
      expired++;
      if (!dryRun) {
        try {
          const { data } = await supabase.rpc('expire_stale_retail_order', {
            p_order_id: order.id,
          });
          details[details.length - 1].note += dryRun ? '' : ` → ${JSON.stringify(data)}`;
        } catch (e) {
          details[details.length - 1].note += ` → expire RPC failed: ${(e as Error).message}`;
        }
      }
    } else {
      skipped++;
    }
  }

  return json({
    success: true,
    dryRun,
    scanned: orders.length,
    paid,
    expired,
    skipped,
    details,
  });
});

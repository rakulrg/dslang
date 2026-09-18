// expire-stale-orders — scheduled sweep for abandoned retail checkouts.
//
// Problem: an order can sit at payment_status='pending' forever when Cashfree
// never fires a webhook — the customer left the checkout, or Cashfree never
// created a payment record. Stock locked by such orders never returns (the
// cashfree-status endpoint only restocks on an explicit FAILED/CANCELLED/
// USER_DROPPED response; empty/never-charmed payments report 'pending' forever).
//
// This function runs on a schedule (pg_cron → net.http_post) and reclaims:
//   * candidates: payment_status='pending' AND stock_restored_at IS NULL AND
//     created_at <= now() - minutes (default 30).
//   * for each, consult Cashfree (mirrors the cashfree-status decision table):
//       - never charmed (no payment record)      -> EXPIRE + restock (RPC)
//       - last payment terminal-failed           -> EXPIRE + restock (RPC)
//       - last payment SUCCESS (amount matches)  -> mark PAID (no restock)
//       - same, amount mismatch / non-terminal   -> SKIP (may still settle)
//       - Cashfree API error                     -> SKIP
//   * the expire+restock write is a single gated SQL RPC
//     (expire_stale_retail_order) that CAS-updates pending->failed then calls
//     restock_retail_order_items — atomic, idempotent, race-safe.
//
// Security:
//   * Authorization must be 'Bearer <service_role>' (Primary — the pg_cron job
//     sends the SUPABASE_SERVICE_ROLE_KEY resolved from Vault). The token is
//     normalized (optional 'Bearer ' prefix, trimmed) and compared against the
//     function's own env secret with a constant-time digest comparison.
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

const TERMINAL_FAILED = new Set(['CANCELLED', 'USER_DROPPED', 'FAILED']);
const NON_TERMINAL = new Set(['PROCESSING', 'ACTIVE', 'PENDING', 'AUTHORISING', 'VOID']);

interface OrderRow {
  id: string;
  ref: string | null;
  customer: Record<string, unknown> | null;
  payment_id: string | null;
  total_amount: number;
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

  // Authorization — never run an OAuth-role/anonymous sweep. The pg_cron job
  // sends 'Authorization: Bearer <SERVICE_ROLE_KEY>' (the value the function
  // already reads from its own server-side env). We normalize the header
  // (optional 'Bearer ' prefix / whitespace) and then require an exact,
  // constant-time match against the expected credential.
  const auth = req.headers.get('authorization') || '';
  const presented = bearerToken(auth);
  let allowed = false;
  if (presented) {
    if (serviceRole && (await constantTimeEqual(presented, serviceRole))) allowed = true;
    else if (token && (await constantTimeEqual(presented, token))) allowed = true;
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
      .select('id, ref, customer, payment_id, total_amount, created_at')
      .eq('ref', body.ref)
      .limit(1);
    orders = (data as OrderRow[] | null) ?? [];
  } else {
    const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
    const { data, error } = await supabase
      .from('retail_orders')
      .select('id, ref, customer, payment_id, total_amount, created_at')
      .eq('payment_status', 'pending')
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
      const expected = Number(order.total_amount);

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
            order_status: 'processing',
            paid_at: new Date().toISOString(),
            txn_id:
              String(d.payment?.cf_payment_id ?? gatewayId?.gateway_transaction_id ?? '') ||
              String(order.payment_id ?? ''),
            payment_provider: 'cashfree',
          })
          .eq('id', order.id);
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
// Vercel Serverless Function — create a Cashfree payment order.
//
// THIS IS THE ONE AND ONLY PAYMENT-START IMPLEMENTATION.
// The Supabase Edge Function `supabase/functions/cashfree-order` has been
// decommissioned (it answers 410 Gone) because two live copies of the money
// path could drift. `cashfree-status` and `cashfree-webhook` are NOT affected —
// they remain the only status-verification and webhook paths.
//
// Amounts are NEVER taken from the client. The order totals are re-read from
// retail_orders (written authoritatively by create_retail_order) and only the
// stored `amount_paid_upfront` is charged — what the order is meant to be
// charged NOW:
//   online -> total_amount − payment_discount (Sale Price minus the fixed ₹50
//             online discount). This is the ONLY case that reaches Cashfree.
//   COD    -> amount_paid_upfront is 0. A COD order is paid IN FULL by the
//             delivery agent and never touches a payment gateway, so this
//             handler refuses it outright (see step 3) rather than creating a
//             ₹0 or partial session.
//
// AUTHORIZATION (guest checkout keeps working, cross-user access does not):
//   The endpoint is reachable with OR without a Supabase session.
//   0. DECLINED FIRST -> an order with `claim_declined_at` set is refused for
//      everyone. That column is the shopper's durable "not mine", and it has to
//      bind here too: this handler reads on the service-role key, so it bypasses
//      the RLS policy and the RPC guards that enforce it elsewhere.
//   1. Signed-in shopper -> the bearer token is verified with Supabase Auth and
//      the order must ALREADY be theirs: `user_id = auth.uid()`, nothing else.
//      There is no email-match branch. Guest checkout accepts any address, so a
//      matching email is a string the customer typed, not proof of possession,
//      and on the service-role key such a match would have been a claim with no
//      proof at all. Linking a guest order is
//      `claim_retail_guest_order(ref, phone)` (email + 10-digit phone), and it
//      is deliberately NOT called from here: paying is not linking. An order
//      this shopper placed as a guest therefore falls through to the possession
//      gate below, exactly as it did before they had an account.
//   2. Guest shopper      -> possession factor, identical to `cashfree-status`
//      and `track_lookup_order`: the caller must supply the order ref AND the
//      customer's 10-digit phone that is already stored on the order.
//   3. Neither satisfied  -> 403 PAYMENT_NOT_PERMITTED, the SAME response a
//      non-existent ref gets, so this endpoint cannot be used to enumerate
//      orders or discover which refs exist.
//
// Never trusted from the client: amount, discount, payment_status,
// order_status, user_id, payment_id. All of those are read from the DB row.
//
// Required env (Vercel project -> Environment Variables). Every one of these is
// mandatory and the handler FAILS CLOSED when any is missing or malformed — it
// never falls back to a guessed environment or a guessed origin:
//   CASHFREE_APP_ID, CASHFREE_SECRET_KEY,
//   CASHFREE_ENV        (exactly 'TEST' or 'PRODUCTION'),
//   APP_ORIGIN          (explicit absolute http(s) origin, no query/fragment),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional: CASHFREE_WEBHOOK_URL (absolute http(s) URL) overrides the default
// notify_url, which is the project's own cashfree-webhook Edge Function.

import { createClient } from '@supabase/supabase-js';

type CashfreeEnv = 'TEST' | 'PRODUCTION';

interface ServerConfig {
  appId: string;
  secretKey: string;
  env: CashfreeEnv;
  origin: string;
  /** Cashfree `notify_url`. Defaults to the project's own cashfree-webhook Edge
   *  Function; overridable via CASHFREE_WEBHOOK_URL. */
  webhookUrl: string;
  supabaseUrl: string;
  serviceRole: string;
}

/**
 * Order states that can never take a new payment.
 *
 * 'pending' and 'processing' are the only pay-able states.
 */
const PAYABLE_ORDER_STATUSES = new Set(['pending', 'processing']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Last 10 digits — the Indian mobile format the whole codebase already uses
 *  (cashfree-status, track_lookup_order, checkout). */
function normalizePhone(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\D/g, '')
    .slice(-10);
}

function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/** An absolute http(s) URL with a host, and no query string or fragment — those
 *  would end up in the middle of the `return_url` we build and corrupt it. A
 *  sub-path deployment (`https://host/store`) is allowed and supported. */
function isValidOrigin(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      !!u.hostname &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

/**
 * FAIL-CLOSED configuration loader. `CASHFREE_ENV` must be explicitly TEST or
 * PRODUCTION and `APP_ORIGIN` must be an explicit absolute origin — there is
 * deliberately no `|| 'TEST'` and no production-domain fallback, because
 * silently running sandbox payments in production (or sending shoppers to the
 * wrong return URL on a preview deploy) is worse than a controlled 500.
 */
function readConfig(): { ok: true; cfg: ServerConfig } | { ok: false; missing: string[] } {
  const appId = (process.env.CASHFREE_APP_ID ?? '').trim();
  const secretKey = (process.env.CASHFREE_SECRET_KEY ?? '').trim();
  const envRaw = (process.env.CASHFREE_ENV ?? '').trim().toUpperCase();
  const originRaw = (process.env.APP_ORIGIN ?? '').trim().replace(/\/$/, '');
  const webhookOverride = (process.env.CASHFREE_WEBHOOK_URL ?? '').trim();
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim();
  const serviceRole = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

  const missing: string[] = [];
  if (!appId) missing.push('CASHFREE_APP_ID');
  if (!secretKey) missing.push('CASHFREE_SECRET_KEY');
  if (envRaw !== 'TEST' && envRaw !== 'PRODUCTION') missing.push('CASHFREE_ENV (must be TEST or PRODUCTION)');
  if (!originRaw) missing.push('APP_ORIGIN');
  else if (!isValidOrigin(originRaw)) missing.push('APP_ORIGIN (must be an absolute http(s) origin)');
  if (webhookOverride && !isValidOrigin(webhookOverride)) {
    // A malformed notify_url would make Cashfree silently fail to deliver the
    // webhook, so an order could sit 'pending' forever. Refuse to start.
    missing.push('CASHFREE_WEBHOOK_URL (must be an absolute http(s) URL)');
  }
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRole) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    cfg: {
      appId,
      secretKey,
      env: envRaw as CashfreeEnv,
      origin: originRaw,
      webhookUrl:
        webhookOverride || `${supabaseUrl.replace(/\/$/, '')}/functions/v1/cashfree-webhook`,
      supabaseUrl,
      serviceRole,
    },
  };
}

function baseUrl(env: CashfreeEnv): string {
  return env === 'PRODUCTION' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
}

export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') {
    // The endpoint never relies on ambient credentials (auth is an explicit
    // bearer token, or the ref+phone possession pair), so a permissive
    // preflight is not a CSRF surface. `Vary` keeps caches honest.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Vary', 'Origin');
    return res.status(200).send('ok');
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const config = readConfig();
  if (!config.ok) {
    // Log the NAMES of what is missing (never values) plus the gateway we would
    // have used, so an operator can fix the environment without the log ever
    // holding a secret.
    console.error('[cashfree-order] Server payment configuration is incomplete', {
      missing: config.missing,
      cashfreeEnvConfigured: Boolean((process.env.CASHFREE_ENV ?? '').trim()),
      appOriginConfigured: Boolean((process.env.APP_ORIGIN ?? '').trim()),
    });
    return res.status(500).json({
      success: false,
      error: 'Server payment configuration is incomplete.',
    });
  }
  const { appId, secretKey, env, origin, webhookUrl, supabaseUrl, serviceRole } = config.cfg;

  let body: { orderId?: string; orderRef?: string; phone?: string };
  try {
    body = req.body ?? {};
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid request.' });
  }
  const orderId = String(body.orderId ?? '').trim();
  const orderRef = String(body.orderRef ?? '').trim();
  const callerPhone = String(body.phone ?? '').trim();
  if (!UUID_RE.test(orderId) || !orderRef) {
    return res.status(400).json({ success: false, error: 'Missing order reference.' });
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /* ------------------------------------------------------------------ *
   * 1. Resolve the caller.
   *    A present-but-unusable token is treated as anonymous (the guest gate
   *    then applies) so an expired session can never lock a guest out of
   *    paying for an order they legitimately placed.
   * ------------------------------------------------------------------ */
  interface Caller {
    userId: string | null;
    email: string;
    via: 'session' | 'guest';
  }
  const authHeader = String(req.headers?.authorization ?? req.headers?.Authorization ?? '');
  const bearer = /^bearer\s+(.+)$/i.exec(authHeader.trim())?.[1]?.trim() ?? '';
  let caller: Caller = { userId: null, email: '', via: 'guest' };
  if (bearer) {
    try {
      const { data } = await supabase.auth.getUser(bearer);
      const u = data?.user;
      if (u) caller = { userId: u.id, email: normalizeEmail(u.email), via: 'session' };
    } catch {
      // Invalid/expired token -> fall through to the guest possession gate.
    }
  }

  /* ------------------------------------------------------------------ *
   * 2. Load the order and prove the caller may pay for it.
   *    `.limit(2)` so a duplicated ref is treated as "not exactly one order"
   *    rather than silently resolving to whichever row PostgREST returned.
   * ------------------------------------------------------------------ */
  const { data: orderRows, error: orderError } = await supabase
    .from('retail_orders')
    .select('id, ref, user_id, customer, total_amount, amount_paid_upfront, is_cod, payment_status, order_status, payment_id, payment_provider, stock_restored_at, claim_declined_at')
    .eq('id', orderId)
    .eq('ref', orderRef)
    .limit(2);
  if (orderError) {
    console.error('[cashfree-order] Supabase order lookup failed', {
      error: orderError.message ?? null,
      code: orderError.code ?? null,
    });
    return res.status(500).json({ success: false, error: 'Payment could not be initialized. Please try again.' });
  }

  const order = (orderRows ?? [])[0] as Record<string, any> | undefined;
  const uniqueOrder = (orderRows ?? []).length === 1 ? order : undefined;

  let authorized = false;
  if (uniqueOrder) {
    const customer = (uniqueOrder.customer as Record<string, unknown>) || {};
    /* A DECLINED order is off limits to everyone.
     *
     * `decline_retail_guest_order` writes `claim_declined_at` as the shopper's
     * durable answer to "this order is not mine". That answer has to bind every
     * path that can touch the order, not just the My Orders card: this endpoint
     * reads on the service-role key, so it bypasses the RLS policy and the RPC
     * guards entirely, and a declined order would otherwise still be payable
     * through the guest possession gate.
     *
     * Checked BEFORE ownership so it holds for a signed-in caller too, and so
     * there is no branch under which a declined order is "reclaimed" by
     * attaching a `user_id`. Paying for an order is not linking one, and an
     * order is never automatically re-claimed here. */
    if (!uniqueOrder.claim_declined_at) {
      if (caller.via === 'session' && caller.userId) {
        /* A signed-in shopper may only pay for an order that is ALREADY theirs.
         *
         * Ownership is `user_id = auth.uid()` and nothing else. There is
         * deliberately no email-match branch here: guest checkout accepts any
         * address, so a matching email is a string the customer typed, not proof
         * of possession. This endpoint runs on the service-role key, which
         * bypasses RLS, so an email match here would have been a claim with no
         * proof at all - it also ignored `claim_declined_at`, so an order the
         * shopper had explicitly answered "not mine" could still be taken.
         *
         * Linking a guest order is `claim_retail_guest_order(ref, phone)`, which
         * requires email AND a 10-digit phone and refuses a declined order
         * outright. Paying does not link, so an unclaimed order falls through to
         * the guest possession gate below (ref + phone) exactly as it did before
         * an account existed. */
        authorized = Boolean(uniqueOrder.user_id) && uniqueOrder.user_id === caller.userId;
      } else {
        // Guest possession gate — ref + the 10-digit phone stored on the order.
        const orderPhone = normalizePhone(customer.phone);
        const presented = normalizePhone(callerPhone);
        authorized = presented.length === 10 && orderPhone.length === 10 && presented === orderPhone;
      }
    }
  }

  if (!authorized) {
    // Deliberately identical for "no such order" and "not your order", and it
    // logs ONLY what the caller already sent us — `orderFound` is deliberately
    // absent, because writing "this ref exists" into the logs re-creates the
    // enumeration oracle the identical response exists to remove.
    console.warn('[cashfree-order] Payment session refused — caller not authorized', {
      orderId,
      via: caller.via,
    });
    return res.status(403).json({
      success: false,
      code: 'PAYMENT_NOT_PERMITTED',
      error: 'This order cannot be paid from this session.',
    });
  }

  const typed = uniqueOrder as Record<string, any>;

  /* ------------------------------------------------------------------ *
   * 3. Eligibility. Checked only AFTER authorization, so none of these
   *    states can be probed by an unauthorized caller.
   * ------------------------------------------------------------------ */
  if (typed.payment_status === 'success') {
    return res.status(409).json({ success: false, code: 'ALREADY_PAID', error: 'This order is already paid.' });
  }
  if (typed.stock_restored_at) {
    // The reservation is gone — the sweep (or an admin) already restocked this
    // order's inventory. Retrying it could sell a unit that is back on the
    // shelf, so refuse the session and make the frontend direct the shopper to
    // start a new checkout.
    return res.status(409).json({
      success: false,
      code: 'ORDER_EXPIRED',
      error: 'This order has expired and its items were returned to stock. Please place a new order.',
    });
  }
  const orderStatus = String(typed.order_status ?? 'pending');
  if (!PAYABLE_ORDER_STATUSES.has(orderStatus)) {
    return res.status(409).json({
      success: false,
      code: 'ORDER_NOT_PAYABLE',
      error: 'This order can no longer be paid. Please contact us if you need help.',
    });
  }
  // Cash on Delivery is paid IN FULL by the delivery agent, so it never has an
  // online payment. This must be checked BEFORE the amount is read and before
  // any gateway call: under the current model a COD order's amount_paid_upfront
  // is 0, so without this guard the request would fall through to the
  // `!(amount > 0)` check with a confusing "Nothing to charge" message, and any
  // future non-zero COD split would silently create a real charge.
  // Checkout already branches before calling this endpoint, so reaching it with
  // a COD order means a stale client or a hand-crafted request — refuse it.
  if (typed.is_cod) {
    console.warn('[cashfree-order] Refused a Cashfree session for a COD order', {
      orderRef: typed.ref,
    });
    return res.status(400).json({
      success: false,
      code: 'COD_NO_ONLINE_PAYMENT',
      error: 'Cash on Delivery orders do not require online payment.',
    });
  }
  // A payment id left by some OTHER gateway must never be reused or replaced by
  // Cashfree. Reusing it would re-open a Razorpay/legacy session under the
  // Cashfree api-version, and overwriting it would strand that gateway's
  // callback against an id that no longer exists in its own system. A legacy
  // 'shiprocket'/'legacy' marker is tolerated only when NO payment id is stored.
  const storedProvider = String(typed.payment_provider ?? '').trim().toLowerCase();
  if (storedProvider && storedProvider !== 'cashfree') {
    if (typed.payment_id) {
      console.error('[cashfree-order] Refusing to touch a non-Cashfree payment_id', {
        orderRef: typed.ref,
        paymentProvider: storedProvider,
      });
      return res.status(409).json({
        success: false,
        code: 'ORDER_NOT_PAYABLE',
        error: 'This order is already linked to another payment method. Please contact us if you need help.',
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 4. Amount — exclusively from the authoritative DB row.
   * ------------------------------------------------------------------ */
  const amount = Number(typed.amount_paid_upfront ?? typed.total_amount);
  if (!(amount > 0)) {
    return res.status(400).json({ success: false, error: 'Nothing to charge for this order.' });
  }
  const orderAmount = amount.toFixed(2);

  /* ------------------------------------------------------------------ *
   * 5. Cashfree order id. Reuse the stored id on the FIRST attempt (a
   *    double-click of "Pay Now" is idempotent: Cashfree returns the existing
   *    order/session). A retry after a FAILED payment mints a FRESH id, and a
   *    rejected reuse falls back to a fresh id once before giving up.
   * ------------------------------------------------------------------ */
  const previousPaymentId: string | null = typed.payment_id ?? null;
  const reusedId = typed.payment_status === 'failed' ? null : previousPaymentId;
  const firstId =
    reusedId ?? cashfreeOrderId(typed.ref, typed.id, null, typed.payment_status === 'failed' ? retryAttemptSuffix() : null);

  const customer = (typed.customer as Record<string, unknown>) || {};
  const customerId = `dsl-${shortish(String(typed.ref), 12)}`;
  const phone = String(customer.phone ?? '').replace(/\D/g, '');

  const buildPayload = (cashfreeOrderIdValue: string) => ({
    order_amount: Number(orderAmount),
    order_currency: 'INR',
    order_id: cashfreeOrderIdValue,
    order_note: `DSLANG order ${typed.ref}`,
    customer_details: {
      customer_id: customerId,
      customer_name: String(customer.name ?? 'Customer') || undefined,
      customer_email: String(customer.email ?? '') || undefined,
      customer_phone: phone || undefined,
    },
    order_meta: {
      // Send the shopper to a dedicated result page (NOT the checkout form)
      // after payment, carrying the DSLANG order ref so the page can look up
      // the live status. Cashfree appends its own payment params onto this URL.
      return_url: `${origin}/#/payment/return?ref=${typed.ref}`,
      // Cashfree posts payment updates here. This points at the Supabase Edge
      // Function cashfree-webhook (HMAC + Cashfree re-verification inside). The
      // function must be deployed WITHOUT JWT verification — Cashfree posts
      // unauthenticated, and the gateway rejects a JWT-required function with
      // 401. Deploy once:
      //   supabase functions deploy cashfree-webhook --no-verify-jwt
      notify_url: webhookUrl,
    },
  });
  // Drop empty customer fields (Cashfree rejects blank optional fields).
  const buildCleanPayload = (cashfreeOrderIdValue: string) => {
    const p = buildPayload(cashfreeOrderIdValue) as Record<string, unknown>;
    const cd = p.customer_details as Record<string, unknown>;
    for (const k of Object.keys(cd)) {
      if (cd[k] === undefined) delete cd[k];
    }
    return p;
  };

  const createCashfreeOrder = async (cashfreeOrderIdValue: string) => {
    try {
      const r = await fetch(`${baseUrl(env)}/pg/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-version': '2025-01-01',
          'X-Client-Id': appId,
          'X-Client-Secret': secretKey,
        },
        body: JSON.stringify(buildCleanPayload(cashfreeOrderIdValue)),
      });
      const api: any = await r.json().catch(() => ({}));
      if (!r.ok || !api || !api.payment_session_id) {
        // Server-side diagnostic for ANY create-order failure (never secrets).
        console.error('[cashfree-order] CASHFREE_ORDER_CREATE_FAILED', JSON.stringify({
          httpStatus: r.status,
          env,
          orderRef: typed.ref,
          orderId: cashfreeOrderIdValue,
          code: api.code ?? null,
          message: api.message ?? null,
        }));
        return null;
      }
      return { api, orderId: cashfreeOrderIdValue };
    } catch (err) {
      console.error('[cashfree-order] CASHFREE_ORDER_CREATE_FAILED threw', JSON.stringify({
        env,
        orderRef: typed.ref,
        orderId: cashfreeOrderIdValue,
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  };

  let created = await createCashfreeOrder(firstId);
  if (!created && reusedId) {
    // Reuse rejected — the Cashfree order exists but can no longer be
    // re-created (stale/closed session). Mint a fresh id and try once more.
    created = await createCashfreeOrder(cashfreeOrderId(typed.ref, typed.id, null, retryAttemptSuffix()));
  }
  if (!created) {
    return res.status(502).json({ success: false, error: 'Payment could not be initialized. Please try again.' });
  }
  // NB: named `createdOrderId`, NOT `cashfreeOrderId`. A `const { orderId:
  // cashfreeOrderId }` here would shadow the `cashfreeOrderId()` helper for the
  // whole block, and the earlier calls to that helper would then hit the
  // temporal dead zone and throw on EVERY request.
  const { api, orderId: createdOrderId } = created;

  /* ------------------------------------------------------------------ *
   * 6. Persist the Cashfree order id, WITHOUT allowing an arbitrary
   *    payment_id overwrite. The write is conditional on payment_id still
   *    holding the value we read, so a concurrent request that already won
   *    the race is detected instead of being clobbered. The
   *    `retail_orders_payment_id_unique` index remains the last line of
   *    defence against one Cashfree order ever pairing with two DSLANG orders.
   * ------------------------------------------------------------------ */
  let persist = supabase
    .from('retail_orders')
    .update({ payment_provider: 'cashfree', payment_id: createdOrderId })
    .eq('id', typed.id);
  persist = previousPaymentId ? persist.eq('payment_id', previousPaymentId) : persist.is('payment_id', null);
  const { data: updatedRows, error: updateError } = await persist.select('payment_id');

  if (updateError) {
    return res.status(500).json({ success: false, error: 'Payment could not be initialized. Please try again.' });
  }
  if ((updatedRows ?? []).length === 0) {
    // Someone else persisted a different gateway id between our read and this
    // write. Do not overwrite it — re-read and accept only the exact id we
    // just created (a genuine double-click), otherwise refuse.
    const { data: fresh } = await supabase
      .from('retail_orders')
      .select('payment_id')
      .eq('id', typed.id)
      .maybeSingle();
    if (fresh?.payment_id !== createdOrderId) {
      console.warn('[cashfree-order] Concurrent payment_id write detected — refusing to overwrite', {
        orderRef: typed.ref,
      });
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_IN_PROGRESS',
        error: 'A payment is already being set up for this order. Please try again.',
      });
    }
  }

  return res.status(200).json({
    success: true,
    orderRef: typed.ref,
    orderId: createdOrderId,
    paymentSessionId: api.payment_session_id,
    environment: env === 'PRODUCTION' ? 'PROD' : 'TEST',
    returnUrl: `${origin}/#/payment/return?ref=${typed.ref}`,
  });
}

function shortish(s: string, n: number): string {
  return s.replace(/[^0-9a-zA-Z]/g, '').toUpperCase().slice(0, n);
}

function retryAttemptSuffix(): string {
  // A fresh, unique suffix (timestamp + random) so a failed order's retry gets
  // a brand-new Cashfree order id instead of reusing the terminal-stated one.
  return `R${Date.now().toString(36).toUpperCase().slice(-4)}${Math.random().toString(36).toUpperCase().slice(2, 6)}`;
}

function cashfreeOrderId(ref: string, orderId: string, fallback: string | null, attemptSuffix: string | null = null): string {
  if (fallback) return fallback;
  const base = `DSL${shortish(ref, 10)}${shortish(orderId, 8)}`;
  return attemptSuffix ? `${base}${attemptSuffix}` : base;
}

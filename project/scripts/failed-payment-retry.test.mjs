/**
 * FAILED / CANCELLED online payment, end to end.
 *
 * The chain under test:
 *
 *   Cashfree cancel or decline
 *     -> return_url -> PaymentReturnPage (one read, no polling, renders nothing)
 *     -> CheckoutPage (form, bag and promo restored; no confirmation screen)
 *     -> quiet verification recognises the failure from the server
 *     -> Pay Now -> startCheckout -> the EXISTING pending-order reuse branch
 *     -> api/cashfree-order accepts it and mints a NEW Cashfree session
 *
 * The one thing that has to be executed rather than read is the payment-start
 * endpoint's eligibility gate: it decides whether the existing order is still
 * payable at all, and getting it wrong silently turns "pay again" into a dead
 * end. Its real predicate is lifted out of `api/cashfree-order.ts` and run here
 * against every order state the storefront can produce. Everything else is a
 * contract on the real source, because it needs a live Supabase and a live
 * gateway to execute.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const API = 'api/cashfree-order.ts';
const CHECKOUT = 'src/pages/CheckoutPage.tsx';
const RETURN_PAGE = 'src/pages/PaymentReturnPage.tsx';
const PAYMENT_LIB = 'src/lib/payment.ts';
const CART_STOCK = 'src/lib/cartStock.ts';
const STATUS_FN = 'supabase/functions/cashfree-status/index.ts';
const WEBHOOK_FN = 'supabase/functions/cashfree-webhook/index.ts';
const SWEEP_MIGRATION = 'supabase/migrations/20260925000000_dslang_expire_failed_orders_restock.sql';
const COD_MIGRATION = 'supabase/migrations/20261012000000_dslang_cod_full_payment.sql';

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const apiCode = code(read(API));
const checkoutCode = code(read(CHECKOUT));
const returnCode = code(read(RETURN_PAGE));
const statusFnCode = code(read(STATUS_FN));
const webhookCode = code(read(WEBHOOK_FN));

// ===========================================================================
// 1. Execute the real payment-start eligibility gate.
// ===========================================================================

/**
 * Lift the real gate out of the endpoint and run it. The endpoint is a Vercel
 * handler that talks to Supabase and Cashfree, but the DECISION is pure, so it
 * is pulled out verbatim (located by content, not by line number) and evaluated.
 * Nothing about the rule is restated here — only the driver.
 */
function buildGate() {
  const setSrc = /const PAYABLE_ORDER_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(apiCode);
  assert.ok(setSrc, 'PAYABLE_ORDER_STATUSES must exist');
  const payable = setSrc[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));

const g = apiCode.indexOf("const orderStatus = String(typed.order_status");
  assert.notEqual(g, -1, 'expected the order-status eligibility gate');
  const marker = 'if (!abandonedAttempt && !PAYABLE_ORDER_STATUSES.has(orderStatus)) {';
  const gateLine = apiCode.indexOf(marker);
  assert.notEqual(gateLine, -1, 'expected the abandoned-attempt gate');

  // Keep the shipped predicate verbatim; only rewrite `typed` -> `order` (this
  // driver passes one order) and turn the `if` header into an assignment so the
  // real condition text is what gets evaluated.
  const predicate = apiCode
    .slice(g, gateLine + marker.length)
    .replace(/const orderStatus = String\(typed\.order_status \?\? 'pending'\);/, "const orderStatus = String(order.order_status ?? 'pending');")
    .replace(/typed\.payment_status/g, 'order.payment_status')
    .replace(marker, 'gate = !abandonedAttempt && !PAYABLE_ORDER_STATUSES.has(orderStatus);');
  assert.ok(predicate.includes('gate = !abandonedAttempt'), 'the real gate expression must survive');

  const driver = new Function(
    'PAYABLE_ORDER_STATUSES',
    'order',
    `let gate = true;\n${predicate}\nreturn !gate;`,
  );
  return (order) => driver(new Set(payable), order);
}

/** `true` = this endpoint will still open a Cashfree session for the order. */
const isPayable = buildGate();

test('the real gate is executed here, not restated', () => {
  assert.ok(
    apiCode.includes("orderStatus === 'cancelled'") && apiCode.includes("=== 'failed'"),
    'the gate must read the cancelled-order / failed-payment pair'
  );
  // A sanity check that the driver really is the shipped decision: flipping one
  // input flips the real predicate.
  assert.equal(isPayable({ order_status: 'pending', payment_status: 'pending' }), true);
  assert.equal(isPayable({ order_status: 'cancelled', payment_status: 'failed' }), true);
  assert.equal(isPayable({ order_status: 'cancelled', payment_status: 'success' }), false);
});

// ===========================================================================
// 2. The retry after a cancellation/failure is accepted.
// ===========================================================================

test('a cancelled Cashfree session leaves the order payable again', () => {
  // Exactly what cashfree-webhook / cashfree-status write for CANCELLED /
  // USER_DROPPED / FAILED, with the reservation still held (stock_restored_at
  // is only ever set by the sweep or an admin restock).
  const abandoned = {
    order_status: 'cancelled',
    payment_status: 'failed',
    stock_restored_at: null,
    is_cod: false,
  };
  assert.equal(isPayable(abandoned), true, 'the customer must be able to pay again');
});

test('a failure that never flipped order_status is still payable', () => {
  assert.equal(isPayable({ order_status: 'pending', payment_status: 'failed' }), true);
});

test('a first attempt is payable', () => {
  assert.equal(isPayable({ order_status: 'pending', payment_status: 'pending' }), true);
  assert.equal(isPayable({ order_status: 'processing', payment_status: 'pending' }), true);
});

// ===========================================================================
// 3. Nothing else became payable, and the earlier refusals still win.
// ===========================================================================

test('a paid order is still refused, before any of this', () => {
  // ALREADY_PAID is checked first in the endpoint, so a cancelled PAID order
  // (admin "cancel before ship", which leaves payment_status 'success') can
  // never slip through the abandoned-attempt allowance.
  const gateIdx = apiCode.indexOf('PAYABLE_ORDER_STATUSES.has(orderStatus)');
  const alreadyPaidIdx = apiCode.indexOf("typed.payment_status === 'success'");
  const expiredIdx = apiCode.indexOf('typed.stock_restored_at');
  assert.ok(alreadyPaidIdx > -1 && expiredIdx > -1 && gateIdx > -1);
  assert.ok(alreadyPaidIdx < gateIdx, 'ALREADY_PAID must be checked before the gate');
  assert.ok(expiredIdx < gateIdx, 'ORDER_EXPIRED must be checked before the gate');
});

test('a swept / restocked order is still refused', () => {
  // The sweep stamps stock_restored_at, which the endpoint refuses first.
  assert.match(read(SWEEP_MIGRATION), /perform public\.restock_retail_order_items\(p_order_id\)/);
  assert.match(apiCode, /if \(typed\.stock_restored_at\) \{[\s\S]*?'ORDER_EXPIRED'/);
  assert.ok(
    apiCode.indexOf('typed.stock_restored_at') < apiCode.indexOf('abandonedAttempt'),
    'the restock guard must precede the abandoned-attempt allowance'
  );
});

test('every genuinely dead order state is still refused', () => {
  for (const status of ['shipped', 'delivered', 'refunded', 'rto']) {
    for (const pay of ['pending', 'failed', 'success', 'cancelled']) {
      if (pay === 'success') continue; // refused earlier as ALREADY_PAID
      assert.equal(
        isPayable({ order_status: status, payment_status: pay }),
        false,
        `${status}/${pay} must not be payable`,
      );
    }
  }
  // A cancelled order whose payment was NOT a failure is not an abandoned
  // attempt, and stays refused.
  assert.equal(isPayable({ order_status: 'cancelled', payment_status: 'pending' }), false);
  assert.equal(isPayable({ order_status: 'cancelled', payment_status: 'refunded' }), false);
  assert.equal(isPayable({ order_status: 'cancelled', payment_status: 'cancelled' }), false);
});

test('COD is never opened to the gateway', () => {
  assert.match(apiCode, /if \(typed\.is_cod\) \{[\s\S]*?'COD_NO_ONLINE_PAYMENT'/);
  assert.ok(apiCode.indexOf('typed.is_cod') < apiCode.indexOf('createCashfreeOrder'));
  assert.match(codSql(), /v_payment_status := 'cod_pending'/);
});
const codSql = () => read(COD_MIGRATION);

// ===========================================================================
// 4. The retry mints a NEW session on the SAME order.
// ===========================================================================

test('a retry after a failed payment mints a fresh Cashfree order id', () => {
  // `reusedId` is nulled exactly when the payment failed, so the retry cannot
  // reuse the terminal-stated Cashfree order.
  assert.match(apiCode, /const reusedId = typed\.payment_status === 'failed' \? null : previousPaymentId;/);
  assert.match(apiCode, /typed\.payment_status === 'failed' \? retryAttemptSuffix\(\) : null/);
  assert.match(apiCode, /function retryAttemptSuffix\(\)/);
  // The old id is replaced on the SAME order row, never on a new one.
  assert.match(apiCode, /from\('retail_orders'\)[\s\S]{0,80}?update\(\{ payment_provider: 'cashfree', payment_id: createdOrderId \}\)[\s\S]{0,40}?\.eq\('id', typed\.id\)/);
});

test('the reuse branch never creates a second order', () => {
  const reuse = checkoutCode.slice(
    checkoutCode.indexOf('if (reuseOrder && liveOrder'),
    checkoutCode.indexOf('createRetailOrder({'),
  );
  assert.ok(reuse.length > 0, 'the reuse branch must exist');
  assert.ok(!/createRetailOrder\(/.test(reuse), 'a retry must not reserve stock twice');
  assert.match(reuse, /order = \{ ref: liveOrder\.ref, order_id: liveOrder\.order_id/);
  // Pay Now is what triggers it, and it hands off on the same order.
  assert.match(
    checkoutCode.slice(checkoutCode.indexOf('const handleSubmit'), checkoutCode.indexOf('const startCheckout')),
    /void startCheckout\(Boolean\(liveOrder\)\)/,
  );
});

test('switching to COD after a failure still converts in place', () => {
  assert.match(checkoutCode, /convertRetailOrderToCod\(liveOrder\.ref, form\.phone\)/);
});

// ===========================================================================
// 5. The reservation is held throughout, never released.
// ===========================================================================

test('cancellation and failure never release the reservation', () => {
  assert.ok(!/restock/i.test(webhookCode), 'the webhook must not restock');
  assert.ok(!/restock/i.test(statusFnCode), 'status verification must not restock');
  assert.ok(!/restock/i.test(checkoutCode), 'the client must not release stock');
  // Both write exactly the abandoned-attempt pair, and nothing else.
  for (const src of [webhookCode, statusFnCode]) {
    assert.match(src, /(?:paymentS|s)tatus === 'CANCELLED' \|\| \w*[Ss]tatus === 'USER_DROPPED' \|\| \w*[Ss]tatus === 'FAILED'/);
    assert.match(src, /update\(\{ payment_status: 'failed', order_status: 'cancelled' \}\)/);
  }
  // Releasing stays the sweep's exclusive job.
  assert.ok(!/restock_retail_order_items/.test(read(COD_MIGRATION)));
});

test('the order decrements stock exactly once, at creation', () => {
  const sql = read(COD_MIGRATION);
  assert.equal(
    (sql.match(/update public\.product_sizes/g) || []).length,
    1,
    'one decrement, one loop',
  );
  assert.match(sql, /set stock = greatest\(stock - \(v_row->>'quantity'\)::int, 0\)/);
  // Ordering: the stock is validated, then reserved, in the same function.
  assert.ok(sql.indexOf('if v_stock < v_qty') < sql.indexOf('greatest(stock -'));
});

// ===========================================================================
// 6. Cancel and decline both land on Checkout, restored, with no screen.
// ===========================================================================

test('every unconfirmed return goes to CheckoutPage, with nothing rendered first', () => {
  // Cancellation, decline, pending, unknown and a failed lookup all share the
  // single fallback: one read, then /checkout. No polling, no timer, no screen.
  assert.equal((returnCode.match(/rpc<TrackedLookup>\(/g) || []).length, 1);
  assert.ok(!/setTimeout|DEADLINE/.test(returnSrc_()), 'the return route must not wait');
  assert.match(returnCode, /if \(state !== 'success' \|\| !snap\) return null;/);
  assert.ok(!/LoadingDots|animate-spin/.test(read(RETURN_PAGE)));
  const effect = returnCode.slice(returnCode.indexOf('useEffect(() => {'), returnCode.indexOf('if (state !=='));
  assert.ok((effect.match(/replaceRoute\('\/checkout'\)/g) || []).length >= 2);
  assert.ok(!/navigate\(/.test(effect), 'the return route must never push a destination');
  // Only a confirmed success shows an order.
  assert.match(effect, /payment_status === 'success'/);
  assert.match(effect, /if \(confirmed\) \{\s*settleSuccess\(confirmed\);\s*return;\s*\}/);
});
const returnSrc_ = () => read(RETURN_PAGE);

test('no confirmation screen exists in either page', () => {
  for (const [name, src] of [
    ['PaymentReturnPage', returnCode],
    ['CheckoutPage', checkoutCode],
    ['OrderStatusPage', code(read('src/pages/OrderStatusPage.tsx'))],
  ]) {
    for (const dead of [
      'Confirming Payment',
      'Still Confirming',
      'Payment Pending',
      'Confirming your payment',
    ]) {
      assert.ok(!src.includes(dead), `${name} must not contain "${dead}"`);
    }
  }
  // CheckoutPage reaches its result stage only from a confirmed outcome.
  assert.equal((checkoutCode.match(/if \(stage === 'result'/g) || []).length, 1);
  assert.match(checkoutCode, /if \(stage === 'result' && result\) \{/);
});

test('an unverified return is reported on the form, never as a page', () => {
  const effect = checkoutCode.slice(
    checkoutCode.indexOf('const confirm = async () => {'),
    checkoutCode.indexOf('}, [paymentCfg.configured, clear, removeAppliedPromo]);'),
  );
  assert.ok(effect.length > 0);
  assert.ok(!/setStage\('result'\)/.test(effect), 'only settleSuccess may leave the form');
  assert.match(effect, /setErrorMsg\(/);
  // The failed outcome keeps the bag and the live handle for the retry.
  const settleFailed = checkoutCode.slice(
    checkoutCode.indexOf('const settleFailed'),
    checkoutCode.indexOf('const attempt = async ()'),
  );
  assert.match(settleFailed, /clearPendingKey\(\);/);
  assert.ok(!/clear\(\)|clearLiveOrderKey|removeAppliedPromo/.test(settleFailed));
});

// ===========================================================================
// 6b. An EXPIRED (restocked) order is discarded quietly, not carried forward.
// ===========================================================================

test('expiry is detected from the order row, because the status label says "pending"', () => {
  const attempt = checkoutCode.slice(
    checkoutCode.indexOf('const attempt = async ()'),
    checkoutCode.indexOf('const confirm = async () => {'),
  );
  // cashfree-status answers an abandoned payment with status 'pending' and the
  // full order row, so the check must not be nested under `status === 'failed'`.
  assert.match(attempt, /const orderRow = v\?\.order as Record<string, unknown> \| null;/);
  assert.match(attempt, /if \(orderRow\?\.stock_restored_at\) \{/);
  const expiredIdx = attempt.indexOf('orderRow?.stock_restored_at');
  const failedIdx = attempt.indexOf("v?.status === 'failed'");
  assert.ok(expiredIdx > -1 && failedIdx > -1);
  assert.ok(expiredIdx < failedIdx, 'expiry must be checked independently of the status label');
  // The discarded order is never announced as expired at restore time.
  const branch = attempt.slice(expiredIdx, failedIdx);
  assert.match(branch, /clearLiveOrderKey\(\);/);
  assert.match(branch, /setLiveOrder\(null\);/);
  assert.match(branch, /settleFailed\(\);/, 'discarded with the plain, non-alarming message');
  assert.ok(!/ORDER_EXPIRED_MESSAGE/.test(branch), 'no expired-order warning while restoring checkout');
});

test('the expired-order warning now comes only from the Pay Now path', () => {
  // It is raised by the server on a session request and surfaced verbatim; the
  // handle it belongs to is dropped in the same catch, so the next Pay Now is a
  // brand-new order rather than a dead end.
  assert.match(read(PAYMENT_LIB), /throw new PaymentSessionError\(ORDER_EXPIRED_MESSAGE, 'ORDER_EXPIRED'\)/);
  const catchBlock = checkoutCode.slice(
    checkoutCode.indexOf("console.error('[checkout] Order placement failed:'"),
    checkoutCode.indexOf('const proceedToPayment'),
  );
  assert.match(catchBlock, /err instanceof PaymentSessionError && \(err\.code === 'ORDER_EXPIRED' \|\| err\.code === 'ORDER_NOT_FOUND'\)/);
  assert.match(catchBlock, /clearPendingKey\(\);\s*clearLiveOrderKey\(\);\s*setLiveOrder\(null\);/);
  // Checkout no longer imports the message: it only relays what the server says.
  assert.ok(!/ORDER_EXPIRED_MESSAGE/.test(checkoutCode), 'the constant is no longer named in checkout');
  // And the form/cart are never touched on either expiry path.
  assert.ok(!/clear\(\)|removeAppliedPromo\(\)|removeItem\(CHECKOUT_FORM_KEY\)/.test(catchBlock));
});

test('a still-valid cancelled order is kept and reused', () => {
  const attempt = checkoutCode.slice(
    checkoutCode.indexOf('const attempt = async ()'),
    checkoutCode.indexOf('const confirm = async () => {'),
  );
  const expiredIdx = attempt.indexOf('orderRow?.stock_restored_at');
  const after = attempt.slice(expiredIdx);
  // Past the expiry branch, nothing drops the handle.
  assert.ok(!/clearLiveOrderKey|setLiveOrder\(null\)/.test(after.split("v?.status === 'failed'")[1] ?? ''));
  // And Pay Now still reuses it: one order, one reservation.
  const reuse = checkoutCode.slice(
    checkoutCode.indexOf('if (reuseOrder && liveOrder'),
    checkoutCode.indexOf('createRetailOrder({'),
  );
  assert.ok(!/createRetailOrder\(/.test(reuse));
  assert.match(reuse, /order = \{ ref: liveOrder\.ref, order_id: liveOrder\.order_id/);
});

test('only the server ever returns stock', () => {
  assert.ok(!/restock/i.test(checkoutCode), 'the client must not release or restock anything');
  assert.ok(!/restock/i.test(returnCode));
  // The discriminator is the server's own restock stamp, and the sweep is the
  // only writer of it.
  assert.match(read(SWEEP_MIGRATION), /perform public\.restock_retail_order_items\(p_order_id\)/);
  assert.match(read('supabase/migrations/20260920000000_dslang_restock_retail_orders.sql'), /stock_restored_at/);
});

test('the live handle survives the failure, which is what makes the reuse possible', () => {
  // Clearing it would force a second order AND a second reservation.
  const attempt = checkoutCode.slice(
    checkoutCode.indexOf('const attempt = async ()'),
    checkoutCode.indexOf('const confirm = async () => {'),
  );
  const expiredIdx = attempt.indexOf('orderRow?.stock_restored_at');
  assert.ok(expiredIdx > -1);
  const plainFailure = attempt.slice(0, expiredIdx);
  assert.ok(
    !/clearLiveOrderKey|setLiveOrder\(null\)/.test(plainFailure),
    'a still-valid cancelled order keeps its handle',
  );
  // A swept order is the one case that must be dropped — quietly.
  const swept = attempt.slice(expiredIdx);
  assert.match(swept, /clearLiveOrderKey\(\);/);
  assert.match(swept, /setLiveOrder\(null\);/);
  assert.match(swept, /settleFailed\(\);/);
  assert.ok(!/ORDER_EXPIRED_MESSAGE/.test(swept), 'and without an expired-order warning');
});

// ===========================================================================
// 7. Checkout state comes back exactly as it was.
// ===========================================================================

test('the delivery form round-trips every field, and only success clears it', () => {
  for (const f of ['firstName', 'lastName', 'address', 'apartment', 'city', 'state', 'pincode', 'phone', 'email']) {
    assert.ok(read(CHECKOUT).includes(`get('${f}'`), `${f} must be rehydrated`);
    assert.match(checkoutCode, new RegExp(`set\\('${f}'`), `${f} must be bound`);
  }
  assert.match(
    checkoutCode,
    /sessionStorage\.setItem\(CHECKOUT_FORM_KEY, JSON\.stringify\(\{ \.\.\.form, paymentMethod \}\)\)/,
  );
  // Cleared only on the three completed paths in checkout, and only by the
  // confirmed-success settle on the return route.
  assert.equal((checkoutCode.match(/removeItem\(CHECKOUT_FORM_KEY\)/g) || []).length, 3);
  assert.equal((returnCode.match(/removeItem\(CHECKOUT_FORM_KEY\)/g) || []).length, 1);
  assert.ok(
    !/CHECKOUT_FORM_KEY/.test(returnCode.slice(returnCode.indexOf('if (confirmed) {'))),
    'the /checkout fallback must not touch the delivery form',
  );
});

test('the payment method and the promo come back too', () => {
  assert.match(checkoutCode, /saved\?\.paymentMethod === 'cod' \? 'cod' : 'online'/);
  assert.match(code(read('src/lib/d2cCart.tsx')), /getPromo\(\)/);
  assert.equal(
    (returnCode.match(/removeAppliedPromo\(\)/g) || []).length,
    1,
    'the applied promo is dropped once, on confirmed success',
  );
  // ...and that one call is inside the confirmed-success settle, which is the
  // only function between the component body and the return effect.
  const settle = returnCode.slice(
    returnCode.indexOf('const settleSuccess'),
    returnCode.indexOf('useEffect(() => {'),
  );
  assert.match(settle, /removeAppliedPromo\(\);/);
});

test('the bag keeps its quantity, reservation-aware, in both mount paths', () => {
  const stock = read(CART_STOCK);
  assert.match(stock, /held: HeldStockMap = ownHeldStock\(items\)/);
  assert.match(stock, /onShelf \+ \(held\[key\] \?\? 0\)/);
  // While a pending record exists the load-time revalidation is skipped, so the
  // quantity cannot be touched at all; once CheckoutPage has verified the
  // failure the reservation-aware reconcile is what preserves it.
  assert.match(checkoutCode, /if \(window\.sessionStorage\.getItem\(PENDING_PAYMENT_KEY\)\) return;/);
  // The return route clears the pending record in exactly one place — inside
  // clearPending(), used only by the confirmed-success settle.
  assert.equal((returnCode.match(/removeItem\(PENDING_PAYMENT_KEY\)/g) || []).length, 1);
  const fallback = returnCode.slice(returnCode.indexOf('if (confirmed) {'));
  assert.ok(!/clearPending\(\)/.test(fallback), 'the /checkout fallback must leave the record for CheckoutPage');
});

// ===========================================================================
// 8. Untouched.
// ===========================================================================

test('success, COD, amounts and verification are unchanged', () => {
  // Success still needs a confirmed status; the webhook still writes it alone.
  assert.match(webhookCode, /payment_status: 'success'/);
  assert.match(webhookCode, /\.neq\('payment_status', 'success'\)/);
  assert.match(statusFnCode, /payment_status: 'failed', order_status: 'cancelled'/);
  // Amounts and the online discount.
  const sql = read(COD_MIGRATION);
  assert.match(sql, /v_payment_discount := least\(50, v_total\);/);
  assert.match(sql, /v_upfront := greatest\(round\(v_total - v_payment_discount, 2\), 0\);/);
  assert.match(read(PAYMENT_LIB), /`amount` is NOT[\s\S]*?sent: the server derives the charge from the order row/);
  // The possession gate is untouched.
  assert.match(apiCode, /presented === orderPhone/);
  assert.match(apiCode, /'PAYMENT_NOT_PERMITTED'/);
  // No schema change, no new component, no new payment state.
  assert.match(apiCode, /const abandonedAttempt =\s*orderStatus === 'cancelled' && String\(typed\.payment_status \?\? ''\) === 'failed';/);
});
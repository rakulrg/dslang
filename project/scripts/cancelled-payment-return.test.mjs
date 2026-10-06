/**
 * Cancelled-payment return flow.
 *
 * Cashfree can only hand back two outcomes: the payment completed, or it did
 * NOT (cancelled at the gateway, dropped, or failed). The second one used to
 * land the customer behind a "Confirming Payment" page with a spinner — both on
 * the return route itself (a ~9s polling gate) and again afterwards, because
 * CheckoutPage jumped straight into its result stage whenever a pending order
 * matched the bag.
 *
 * The rule this suite pins down:
 *
 *   cancelled / unverified  ->  straight back to CheckoutPage, checkout state
 *                               intact, and NO confirmation screen of any kind
 *   confirmed success       ->  the existing order-success page, untouched
 *
 * Nothing here needs a live gateway to execute the decision, so the decision
 * and every state it must preserve are asserted against the real source, the
 * same way this repo asserts its other gateway-dependent guarantees.
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

const CHECKOUT = 'src/pages/CheckoutPage.tsx';
const RETURN_PAGE = 'src/pages/PaymentReturnPage.tsx';
const CART_CTX = 'src/lib/d2cCart.tsx';
const CART_STOCK = 'src/lib/cartStock.ts';
const APP = 'src/App.tsx';
const STATUS_PAGE = 'src/pages/OrderStatusPage.tsx';
const COD_MIGRATION = 'supabase/migrations/20261012000000_dslang_cod_full_payment.sql';
const STATUS_FN = 'supabase/functions/cashfree-status/index.ts';
const WEBHOOK_FN = 'supabase/functions/cashfree-webhook/index.ts';
const PAYMENT_LIB = 'src/lib/payment.ts';

/** Comments document the rules, so strip them before asserting on code. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const checkout = read(CHECKOUT);
const checkoutCode = code(checkout);
const returnSrc = read(RETURN_PAGE);
const returnCode = code(returnSrc);
const codSql = read(COD_MIGRATION);
const statusFnCode = code(read(STATUS_FN));

// ===========================================================================
// 1. ONLINE -> CASHFREE -> CANCEL lands on CheckoutPage with nothing in between.
// ===========================================================================

test('a cancelled payment has no confirming screen left anywhere in the return flow', () => {
  // Asserted on the EXECUTABLE source: the comments in these files name the
  // screens on purpose, to record that they were removed.
  for (const [name, src] of [
    ['PaymentReturnPage', returnCode],
    ['CheckoutPage', checkoutCode],
  ]) {
    for (const dead of [
      'Confirming Payment',
      'Confirming your payment',
      'Still Confirming',
      'Payment Not Completed',
      'Payment Pending',
      'Order Complete',
      'ResultVerdict',
      'setVerdict',
    ]) {
      assert.ok(!src.includes(dead), `${name} must not contain "${dead}"`);
    }
  }
});

test('the return route renders nothing while it decides — no spinner, no loader', () => {
  assert.ok(!/LoadingDots/.test(returnSrc), 'the payment-return spinner must be gone');
  assert.ok(!/animate-spin/.test(returnSrc), 'no spinning loader on the return route');
  assert.ok(!/min-h-\[70vh\][^]*?Checking/.test(returnSrc));
  // The only thing rendered before a confirmed success is `null`.
  assert.match(returnCode, /if \(state !== 'success' \|\| !snap\) return null;/);
});

test('the return route decides in ONE read and never waits', () => {
  // No polling loop, no deadline, no retry: a cancelled payment is not a slow
  // success, so the old multi-second gate bought nothing.
  assert.ok(!/DEADLINE/.test(returnSrc), 'no polling deadline');
  assert.ok(!/setTimeout/.test(returnSrc), 'the return route must not wait on a timer');
  assert.ok(!/attemptNo|for \(let i/.test(returnCode), 'no polling loop');
  assert.equal((returnCode.match(/rpc<TrackedLookup>\(/g) || []).length, 1, 'exactly one status read');
});

test('every non-success outcome navigates straight to /checkout', () => {
  const effect = returnCode.slice(
    returnCode.indexOf('useEffect(() => {'),
    returnCode.indexOf('if (state !==')
  );
  assert.ok(effect.length > 0, 'the return effect must exist');
  // No ref at all -> checkout. Not confirmed -> checkout. Both REPLACE, so the
  // transient return entry is consumed rather than left as a Back destination.
  assert.ok((effect.match(/replaceRoute\('\/checkout'\)/g) || []).length >= 2);
  assert.ok(!/navigate\(/.test(effect), 'the return route must never push');
  // There is exactly one branch that shows an order, and it requires a
  // confirmed success from the database.
  assert.match(effect, /if \(confirmed\) \{\s*settleSuccess\(confirmed\);\s*return;\s*\}/);
  assert.match(effect, /payment_status === 'success'/);
  assert.ok(
    effect.lastIndexOf('settleSuccess') < effect.lastIndexOf("replaceRoute('/checkout')"),
    'success must be settled before the checkout fallback'
  );
});

test('CheckoutPage never opens its result stage on the way IN', () => {
  // The removed behaviour: a matching pending order forced stage='result',
  // which is what re-presented a cancelled payment as a confirmation state.
  const init = checkoutCode.slice(
    checkoutCode.indexOf('const [stage, setStage] = useState<Stage>'),
    checkoutCode.indexOf('const [placing, setPlacing]')
  );
  assert.ok(init.length > 0, 'the stage initialiser must exist');
  assert.ok(!/return 'result'/.test(init), 'the initial stage is never "result"');
  assert.ok(!/'success'/.test(init), 'no verdict is decided on load');
  // What it still does is drop handles for a bag that no longer matches.
  assert.match(init, /if \(!matches\) \{/);
  assert.match(init, /clearPendingKey\(\);/);
  assert.match(init, /clearLiveOrderKey\(\);/);
  assert.match(init, /clearResultKey\(\);/);
});

test('the result stage is reachable only from a confirmed outcome', () => {
  const assignments = [...checkoutCode.matchAll(/setStage\('(\w+)'\)/g)].map((m) => m[1]);
  assert.equal(
    assignments.filter((a) => a === 'result').length,
    3,
    'exactly three confirmed paths enter the result stage'
  );
  // Each one is a completion, never an attempt: the verification effect, the COD
  // short-circuit, and the no-gateway deployment.
  const settle = checkoutCode.slice(
    checkoutCode.indexOf('const settleSuccess = (order'),
    checkoutCode.indexOf('const settleFailed')
  );
  assert.ok(settle.length > 0, 'settleSuccess must exist');
  assert.match(settle, /setStage\('result'\)/);
  assert.ok(!/setStage/.test(settle.split('setStage')[0].split('const settleSuccess')[1] ?? ''));
  // The dead state machine is gone, not merely unused.
  assert.ok(!/ResultVerdict/.test(checkout), 'the verdict state machine is removed');
  assert.ok(!/setVerdict/.test(checkout), 'no verdict transitions remain');
  assert.ok(!/verdict ===/.test(checkout), 'no verdict branches remain');
  // Exactly one result branch renders, and it is the order-success page.
  assert.equal((checkoutCode.match(/if \(stage === 'result'/g) || []).length, 1);
  assert.match(checkoutCode, /if \(stage === 'result' && result\) \{/);
});

test('the verification pass can no longer open a confirming screen', () => {
  const effect = checkoutCode.slice(
    checkoutCode.indexOf('const confirm = async () => {'),
    checkoutCode.indexOf('}, [paymentCfg.configured, clear, removeAppliedPromo]);')
  );
  assert.ok(effect.length > 0, 'the quiet verification pass must exist');
  assert.ok(!/setStage\('result'\)/.test(effect), 'only settleSuccess may leave the form');
  assert.ok(!/Confirming/.test(effect), 'no confirming copy');
  // An unverified payment is reported honestly ON the form, never as a page.
  assert.match(effect, /setErrorMsg\(/);
  assert.ok(!/setStage/.test(checkoutCode.slice(
    checkoutCode.indexOf('const attempt = async ()'),
    checkoutCode.indexOf('const confirm = async () => {')
  )));
});

// ===========================================================================
// 2. A cancelled payment is never treated as a paid order.
// ===========================================================================

test('a cancelled payment is never marked paid or charged', () => {
  // Only the server writes a success payment_status; the return route only reads.
  assert.ok(!/payment_status:\s*'success'/.test(returnCode), 'the return route never writes a status');
  assert.ok(!/update\(/.test(returnCode) && !/from\('retail_orders'\)/.test(returnCode));
  assert.ok(!/createRetailOrder|createPaymentSession/.test(returnCode));
  // The webhook remains the only writer of the paid state.
  assert.match(read(WEBHOOK_FN), /payment_status/);
  assert.match(statusFnCode, /payment_status: 'failed', order_status: 'cancelled'/);
  // settleSuccess is fed only by a verified read — never from the URL, a
  // session value or a local guess.
  const settle = checkoutCode.slice(
    checkoutCode.indexOf('const settleSuccess = (order'),
    checkoutCode.indexOf('const settleFailed')
  );
  assert.ok(!/searchParams|location|window\.location|URLSearchParams/.test(settle));
});

test('a cancelled payment keeps its reservation, handled by the existing expiry logic', () => {
  // The gateway cancel path must not restock: the order stays reserved so the
  // retry reuses it. Releasing stays the sweep's job.
  assert.ok(!/restock/i.test(statusFnCode), 'cashfree-status must not restock on cancel');
  assert.ok(!/restock_retail_order_items/.test(codSql));
  assert.match(read('supabase/migrations/20260925000000_dslang_expire_failed_orders_restock.sql'),
    /perform public\.restock_retail_order_items\(p_order_id\)/);
});

// ===========================================================================
// 3. Retrying after a cancellation never creates a second order.
// ===========================================================================

test('the retry is the normal Pay Now path and reuses the reserved order', () => {
  // The dead "Try Again" button is gone; Pay Now is the retry.
  assert.ok(!/handleRetryPayment|retryHandle|Start New Order|Try Again/.test(checkout));
  const submit = checkoutCode.slice(
    checkoutCode.indexOf('const handleSubmit'),
    checkoutCode.indexOf('const startCheckout')
  );
  assert.match(submit, /void startCheckout\(Boolean\(liveOrder\)\)/, 'Pay Now reuses a live order');
  const reuse = checkoutCode.slice(
    checkoutCode.indexOf('if (reuseOrder && liveOrder'),
    checkoutCode.indexOf('createRetailOrder({')
  );
  assert.ok(!/createRetailOrder\(/.test(reuse), 'a retry must not reserve stock twice');
  assert.match(reuse, /order = \{ ref: liveOrder\.ref, order_id: liveOrder\.order_id/);
});

test('an expired reservation is still recovered from, on the Pay Now path', () => {
  // The escape hatch used to live on the deleted screen; it now runs where the
  // failure happens, so a swept order can never trap the customer.
  const catchBlock = checkoutCode.slice(
    checkoutCode.indexOf("console.error('[checkout] Order placement failed:'"),
    checkoutCode.indexOf('const proceedToPayment')
  );
  assert.match(catchBlock, /err instanceof PaymentSessionError/);
  assert.match(catchBlock, /ORDER_EXPIRED/);
  assert.match(catchBlock, /clearLiveOrderKey\(\);/);
  assert.match(catchBlock, /setLiveOrder\(null\);/);
  // A restocked order is recognised by the verification pass too, off the
  // ORDER ROW rather than the status label, and discarded without an alarm.
  const attempt = checkoutCode.slice(
    checkoutCode.indexOf('const attempt = async ()'),
    checkoutCode.indexOf('const confirm = async () => {')
  );
  assert.match(attempt, /orderRow\?\.stock_restored_at/);
  assert.match(attempt, /setLiveOrder\(null\);/);
});

// ===========================================================================
// 4. Checkout state is restored — nothing is re-asked.
// ===========================================================================

test('the delivery form is persisted and rehydrated field by field', () => {
  for (const field of [
    'firstName', 'lastName', 'address', 'apartment',
    'city', 'state', 'pincode', 'phone', 'email',
  ]) {
    assert.ok(checkout.includes(`get('${field}'`), `${field} must be rehydrated`);
    assert.match(checkoutCode, new RegExp(`set\\('${field}'`), `${field} must be bound`);
  }
  // Written on every change, read back on mount, and only cleared on SUCCESS.
  assert.match(checkoutCode, /sessionStorage\.setItem\(CHECKOUT_FORM_KEY, JSON\.stringify\(\{ \.\.\.form, paymentMethod \}\)\)/);
  const clears = [...checkoutCode.matchAll(/removeItem\(CHECKOUT_FORM_KEY\)/g)];
  assert.equal(clears.length, 3, 'cleared only on the three confirmed/completed paths');
  // No cancelled path clears it.
  const settleFailed = checkoutCode.slice(
    checkoutCode.indexOf('const settleFailed'),
    checkoutCode.indexOf('const attempt = async ()')
  );
  assert.ok(!/CHECKOUT_FORM_KEY/.test(settleFailed), 'a cancelled payment must not clear the form');
});

test('the selected payment method survives the round trip', () => {
  assert.match(checkoutCode, /saved\?\.paymentMethod === 'cod' \? 'cod' : 'online'/);
  assert.match(checkoutCode, /JSON\.stringify\(\{ \.\.\.form, paymentMethod \}\)/);
});

test('the promo/discount state is preserved', () => {
  assert.match(read(CART_CTX), /getPromo\(\)/, 'promo rehydrates from storage');
  assert.match(read(CART_CTX), /promo, applyPromo, removeAppliedPromo/);
  // The promo is dropped in exactly one place on this route: the CONFIRMED
  // success. A cancelled payment leaves the customer's applied code in place.
  const success = returnCode.slice(
    returnCode.indexOf('const settleSuccess'),
    returnCode.indexOf('useEffect(() => {')
  );
  assert.match(success, /removeAppliedPromo\(\)/);
  assert.equal((returnCode.match(/removeAppliedPromo\(\)/g) || []).length, 1);
  const settleFailed = checkoutCode.slice(
    checkoutCode.indexOf('const settleFailed'),
    checkoutCode.indexOf('const attempt = async ()')
  );
  assert.ok(!/removeAppliedPromo/.test(settleFailed));
});

test('cart items and quantities are restored, reservation-aware', () => {
  assert.match(read(CART_CTX), /dslang_retail_cart_v1/);
  assert.match(checkoutCode, /if \(items\.length === 0\) reloadFromStorage\(\);/);
  // A cancelled payment does not shrink the bag: the shopper's OWN pending
  // reservation is added back before the cart is judged against the shelf.
  assert.match(read(CART_STOCK), /held: HeldStockMap = ownHeldStock\(items\)/);
  assert.match(read(CART_STOCK), /onShelf \+ \(held\[key\] \?\? 0\)/);
});

// ===========================================================================
// 5. Refreshing after a cancellation is safe and stays on the form.
// ===========================================================================

test('a refresh after a cancellation cannot reopen the old confirmation page', () => {
  // Nothing on load can select the result stage, so a refresh is idempotent:
  // the form renders whether or not a pending record is still in storage.
  assert.ok(!/return 'result'/.test(checkoutCode.slice(
    checkoutCode.indexOf('const [stage, setStage] = useState<Stage>'),
    checkoutCode.indexOf('const [placing, setPlacing]')
  )));
  assert.equal((checkoutCode.match(/if \(stage === 'result'/g) || []).length, 1);
  // The empty-bag guard is the only other early return, and it is not one.
  assert.match(checkoutCode, /if \(items\.length === 0 && stage === 'form' && !liveOrder\) \{/);
  assert.ok(!/items\.length === 0 && stage === 'result'/.test(checkoutCode));
  // Nothing is read from the URL to decide a payment state.
  assert.ok(!/searchParams|location\.search/.test(returnCode.replace(/const qs =[\s\S]*?;\n/, '')));
});

// ===========================================================================
// 6. The legitimate success confirmation and COD are untouched.
// ===========================================================================

test('a confirmed payment still reaches the existing order-success page', () => {
  assert.match(returnSrc, /Order Placed/);
  assert.match(returnSrc, /addCheckoutHistory\(snapshot\.ref, phone\)/);
  assert.match(checkoutCode, /Order Confirmed/);
  assert.match(checkoutCode, /Thank You/);
  assert.match(checkoutCode, /Track Order/);
  // The bag is cleared ONLY there.
  assert.match(checkoutCode, /removeAppliedPromo\(\);\s*setLiveOrder\(null\);\s*setResult\(/);
});

test('COD is completely unchanged', () => {
  // Still reserved through create_retail_order, still confirmed on placement,
  // still never contacting the gateway, still with the full amount due.
  assert.match(codSql, /v_payment_status := 'cod_pending'/);
  assert.match(codSql, /v_upfront := 0;/);
  const codShort = checkoutCode.slice(
    checkoutCode.indexOf('if (order.is_cod || paymentMethod'),
    checkoutCode.indexOf('await createPaymentSession({')
  );
  assert.ok(codShort.length > 0, 'the COD short-circuit must still exist');
  assert.match(codShort, /clear\(\)/);
  assert.match(codShort, /setStage\('result'\)/);
  assert.ok(!/persistPendingKey|createPaymentSession|openCashfreeCheckout/.test(codShort));
  // Switching online -> COD still converts in place: one reservation.
  assert.match(checkoutCode, /convertRetailOrderToCod\(liveOrder\.ref, form\.phone\)/);
  // A COD order is never a held online reservation.
  assert.match(read(CART_STOCK), /live\.is_cod === true\) return \{\}/);
});

test('payment amount, the online discount and the gateway config are untouched', () => {
  assert.match(codSql, /v_payment_discount := least\(50, v_total\);/);
  assert.match(codSql, /v_upfront := greatest\(round\(v_total - v_payment_discount, 2\), 0\);/);
  assert.match(codSql, /v_due := 0;/);
  // The client still never influences what is charged.
  assert.match(read(PAYMENT_LIB), /`amount` is NOT[\s\S]*?sent: the server derives the charge from the order row/);
  assert.match(read('src/lib/orders.ts'), /payment_discount, capped at the order value/);
});

test('payment verification and its security model are untouched', () => {
  assert.match(read(PAYMENT_LIB), /cashfree-status/);
  assert.match(statusFnCode, /verified: false, status: 'failed'/);
  // The return route still uses the possession-gated, read-only lookup.
  assert.match(returnCode, /rpc<TrackedLookup>\('track_lookup_order', \{ p_ref: ref, p_phone: phone \}\)/);
});

// ===========================================================================
// 7. Nothing outside this flow was touched.
// ===========================================================================

test('the return route is the only Cashfree destination and is still routed', () => {
  assert.match(read(APP), /payment.*return.*PaymentReturnPage/);
  assert.ok(!/order-status/.test(checkoutCode), 'the cancelled flow never navigates to the status page');
  // The order-status page is a separate, directly-URL-reachable tracking
  // surface, never navigated to from this flow, and it has no payment
  // confirmation screen either: an unconfirmed order shows its normal status.
  const statusCode = code(read(STATUS_PAGE));
  assert.doesNotMatch(statusCode, /Confirming Payment|Still Confirming|Payment Pending/);
  assert.equal((read(APP).match(/order-status/g) || []).length, 2, 'routed, never navigated to');
});

test('no CSS or visibility trick was used to hide anything', () => {
  // The screen is gone from the source tree, not hidden behind a class.
  assert.ok(!/hidden.*Confirming|Confirming.*hidden/.test(checkoutCode));
  assert.ok(!/display:\s*none/.test(returnCode));
  // And the loader component is not merely unused-but-imported on this route.
  assert.ok(!/LoadingDots/.test(returnSrc));
});
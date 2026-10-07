/**
 * FULL COD regression suite.
 *
 * Twenty scenarios covering the switch from the old "advance on COD" model to
 * full Cash on Delivery. Each is asserted against the real source, because
 * every one of them is a property of a code path that needs a live Supabase
 * and a live gateway to execute.
 *
 * The pricing arithmetic itself is executed (not just described) in
 * `payment-rules.test.mjs`, which evaluates the real `if v_is_cod ... end if;`
 * block out of the migration. The tests here cover the SURROUNDING behaviour:
 * that no gateway is ever contacted for COD, that the states and screens agree,
 * that a confirmed COD order can actually be fulfilled and reported on, that the
 * sweeper and admin leave COD orders alone, and that switching payment method
 * never double-books stock.
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

const COD_MIGRATION = 'supabase/migrations/20261012000000_dslang_cod_full_payment.sql';
const OPS_MIGRATION = 'supabase/migrations/20261013000000_dslang_remove_cod_partial_ops_logic.sql';
const RETIRE_STATUS_MIGRATION = 'supabase/migrations/20261014000000_dslang_retire_cod_advance_status.sql';
const API = 'api/cashfree-order.ts';
const CHECKOUT = 'src/pages/CheckoutPage.tsx';
const ORDERS_LIB = 'src/lib/orders.ts';
const STATUS_PAGE = 'src/pages/OrderStatusPage.tsx';
const RETURN_PAGE = 'src/pages/PaymentReturnPage.tsx';
const TRACK_PAGE = 'src/pages/TrackOrderPage.tsx';
const MY_ORDERS = 'src/pages/MyOrdersPage.tsx';
const ADMIN = 'src/pages/admin/AdminDashboard.tsx';
const ORDER_LABELS = 'src/pages/admin/orderLabels.ts';
const DASH_DATA = 'src/pages/admin/dashboardData.ts';
const OVERVIEW = 'src/pages/admin/OverviewSection.tsx';
const STATUS_FN = 'supabase/functions/cashfree-status/index.ts';
const WEBHOOK_FN = 'supabase/functions/cashfree-webhook/index.ts';
const EXPIRE_FN = 'supabase/functions/expire-stale-orders/index.ts';
const EMAILS = 'supabase/functions/_shared/emails.ts';

const sql = read(COD_MIGRATION);
const api = read(API);
const checkout = read(CHECKOUT);
const ordersLib = read(ORDERS_LIB);

/** The body of the payment-start endpoint, from the handler start to the first
 *  gateway `fetch(` — used to prove the COD guard runs BEFORE any network
 *  access. Note the Cashfree BASE_URL constant lives at module top level, above
 *  the handler, so it is not a usable marker here. */
function codGuardWindow(src) {
  const guard = src.indexOf('COD_NO_ONLINE_PAYMENT');
  assert.notEqual(guard, -1, 'the endpoint must reject COD with a specific, testable code');
  const handler = src.indexOf('export default');
  const gatewayCall = src.indexOf('fetch(', handler);
  assert.notEqual(handler, -1, 'expected an exported handler');
  assert.notEqual(gatewayCall, -1, 'expected a gateway fetch in the handler');
  return { guard, handler, gatewayCall, body: src.slice(handler, gatewayCall) };
}

/* ================================================================== *
 * 1. An online order is charged the complete discounted amount
 * ================================================================== */
test('COD 1: an online order charges the full discounted total and nothing is due on delivery', () => {
  // Executed against the real SQL block (the evaluator lives in
  // payment-rules.test.mjs; the values are pinned here as the spec).
  assert.match(
    sql,
    /v_payment_discount := least\(50, v_total\);\s*\n\s*v_upfront := greatest\(round\(v_total - v_payment_discount, 2\), 0\);\s*\n\s*v_due := 0;/,
    'the online branch must discount Rs 50, charge the rest now and leave 0 due',
  );
  // The endpoint charges the stored amount, which for online is the full total.
  assert.match(
    api,
    /const amount = Number\(typed\.amount_paid_upfront \?\? typed\.total_amount\)/,
    'the charge must come from the server-stored amount, never a client figure',
  );
});

/* ================================================================== *
 * 2. A COD order charges nothing online and the full amount is due
 * ================================================================== */
test('COD 2: a COD order stores a zero online charge and the full total due on delivery', () => {
  assert.match(
    sql,
    /if v_is_cod then\s*\n\s*v_payment_discount := 0;\s*\n\s*v_upfront := 0;\s*\n\s*v_due := greatest\(round\(v_total, 2\), 0\);/,
    'the COD branch must be 0 / 0 / full total',
  );
  // And the client shows the same thing.
  assert.match(checkout, /const codDue = safeTotal;/, 'checkout must show the full total as due on delivery');
  assert.match(
    checkout,
    /const payableNow = paymentMethod === 'cod' \? 0 : onlineTotal;/,
    'nothing may be payable online for a COD order',
  );
});

/* ================================================================== *
 * 3. COD never contacts the payment gateway
 * ================================================================== */
test('COD 3: the payment-start endpoint refuses COD before any gateway call', () => {
  const { guard, handler, gatewayCall, body } = codGuardWindow(api);
  assert.notEqual(guard, -1);
  assert.match(
    api,
    /code: 'COD_NO_ONLINE_PAYMENT'/,
    "the refusal must carry the explicit code 'COD_NO_ONLINE_PAYMENT'",
  );
  assert.match(
    api,
    /Cash on Delivery orders do not require online payment\./,
    'the refusal must explain itself to the shopper',
  );
  // The guard must sit before the first gateway fetch, i.e. no session can be
  // opened for a COD order even if the caller ignores the error code.
  assert.ok(
    guard > handler && guard < gatewayCall,
    'the COD guard must sit inside the handler and precede its first gateway fetch',
  );
  // No amount is even computed for COD.
  assert.equal(
    /is_cod[\s\S]{0,400}const amount =/.test(body),
    false,
    'the charged amount must not be computed for a COD order',
  );
  // The COD path returns immediately, with a 400 and no gateway interaction.
  const codBranch = api.slice(api.indexOf('if (typed.is_cod) {'), guard + 220);
  assert.match(codBranch, /return res\.status\(400\)\.json\(\{/, 'COD must be refused with a 400');
  assert.match(codBranch, /success: false,/, 'the refusal must be an explicit failure, not a silent no-op');
  assert.match(codBranch, /error: 'Cash on Delivery orders do not require online payment\.'/);
  // The order is read only to authorise first; the refusal itself is cheap.
  assert.ok(
    api.indexOf('if (typed.is_cod) {') > api.indexOf('.select('),
    'authorisation must be settled before the payment method is judged',
  );
});

test('COD 3b: checkout short-circuits COD without opening a session or preloading the SDK', () => {
  assert.match(
    checkout,
    /if \(paymentMethod !== 'cod'\) preloadCashfreeSdk\(\);/,
    'the Cashfree SDK must never be preloaded for a COD order',
  );
  // The COD branch must end the flow before createPaymentSession.
  const codBranch = checkout.slice(checkout.indexOf('COD short-circuit'));
  const end = codBranch.indexOf('createPaymentSession');
  assert.notEqual(end, -1, 'expected a COD branch ahead of the session call');
  assert.match(
    codBranch.slice(0, end),
    /if \(order\.is_cod \|\| paymentMethod === 'cod'\)[\s\S]*setStage\('result'\)/,
    'COD must reach the result screen before any session is created',
  );
  assert.equal(
    codBranch.slice(0, end).includes('createPaymentSession'),
    false,
    'a COD order must not create a payment session',
  );
  // The payment attempt must also refuse to hand a COD order to the gateway.
  // There is now a single online payment entry point (Pay Now, which is also
  // the retry), so the guard lives on the reuse condition itself.
  assert.match(
    checkout,
    /if \(reuseOrder && liveOrder && liveOrder\.itemsKey === itemsKeyOf\(items\) && !liveOrder\.is_cod\) \{/,
    'the online payment path must exclude COD orders',
  );
  assert.match(
    checkout,
    /if \(paymentMethod === 'cod'\) \{[\s\S]{0,200}convertRetailOrderToCod/,
    'a COD payment method must convert the existing order instead of paying it',
  );
});

/* ================================================================== *
 * 4. Switching payment method works in both directions
 * ================================================================== */
test('COD 4: switching an existing unpaid order to COD re-prices it in place', () => {
  assert.match(
    ordersLib,
    /export async function convertRetailOrderToCod/,
    'a conversion helper must exist for the online -> COD switch',
  );
  assert.match(
    ordersLib,
    /rpc<RetailOrderResult>\('convert_retail_order_to_cod'/,
    'the conversion must go through the server-authoritative RPC',
  );
  // The client must use it rather than creating a second order.
  const switchBranch = checkout.slice(checkout.indexOf('if (paymentMethod === \'cod\') {'));
  assert.match(
    switchBranch.slice(0, 600),
    /await convertRetailOrderToCod\(liveOrder\.ref, form\.phone\)/,
    'switching to COD must convert the existing order, not create a new one',
  );
  assert.equal(
    /if \(paymentMethod === 'cod'\) \{[\s\S]{0,600}createRetailOrder\(/.test(switchBranch.slice(0, 600)),
    false,
    'switching to COD must NOT create a second order (it would reserve stock twice)',
  );
});

test('COD 4b: the conversion preserves one stock reservation and the quoted total', () => {
  const fn = sql.slice(sql.indexOf('convert_retail_order_to_cod'));
  // It must never touch inventory — the point is to keep the single reservation.
  for (const forbidden of ['product_sizes', 'insert into public.retail_orders', 'delete from']) {
    assert.equal(
      fn.includes(forbidden),
      false,
      `the conversion must not run \`${forbidden}\` — it re-prices an existing reservation`,
    );
  }
  // It must re-price the payment split.
  assert.match(fn, /set is_cod = true/);
  assert.match(fn, /payment_discount = 0/);
  assert.match(fn, /amount_paid_upfront = 0/);
  assert.match(fn, /amount_due_on_delivery = greatest\(v_row\.total_amount, 0\)/);
  assert.match(fn, /payment_status = 'cod_pending'/);
  // The gateway session must be dropped so it can never be verified later.
  assert.match(fn, /payment_id = null/);
  // The quoted money must be preserved.
  assert.equal(/total_amount\s*=/.test(fn.slice(fn.indexOf('set is_cod = true'), fn.indexOf('where id ='))), false);
});

test('COD 4c: the conversion is possession-gated and refuses any order that moved on', () => {
  const fn = sql.slice(sql.indexOf('convert_retail_order_to_cod'));
  assert.match(fn, /select \* into v_row[\s\S]{0,80}for update/, 'the row must be locked while it is converted');
  assert.match(fn, /v_caller_phone <> '' and v_stored_phone = v_caller_phone/, 'the 10-digit phone must be required');
  assert.match(fn, /raise exception 'Order not found\.' using errcode = 'P0002'/, 'a wrong phone must look like a bad ref');
  // Refusals: already COD, already paid, already moving, already cancelled.
  assert.match(fn, /if v_row\.is_cod then[\s\S]{0,120}already Cash on Delivery/);
  assert.match(fn, /if v_row\.payment_status not in \('pending', 'failed'\) then/);
  assert.match(fn, /if v_row\.order_status <> 'pending' then/);
  assert.match(fn, /if v_row\.stock_restored_at is not null then/);
  // And it must be reachable only through the explicit grant.
  assert.match(fn, /revoke all on function public\.convert_retail_order_to_cod\(text, text\) from public/);
  assert.match(fn, /grant execute on function public\.convert_retail_order_to_cod\(text, text\)\s*\n\s*to anon, authenticated, service_role;/);
  assert.match(fn, /set search_path = public/);
});

/* ================================================================== *
 * 5. Promo codes apply to both methods, before the split
 * ================================================================== */
test('COD 5: a promo discount applies to both methods and precedes the payment split', () => {
  // The promo discount is folded into total_amount first, then the method split
  // is computed from that total — so both methods get it.
  const totalIdx = sql.indexOf('v_total := v_subtotal - v_discount + v_shipping');
  const splitIdx = sql.indexOf('if v_is_cod then');
  assert.notEqual(totalIdx, -1, 'the total must be derived from subtotal, discount and shipping');
  assert.ok(totalIdx < splitIdx, 'the promo discount must be applied BEFORE the payment split');
  // The split must be computed from v_total, never from a client figure.
  assert.match(sql, /v_upfront := greatest\(round\(v_total - v_payment_discount, 2\), 0\)/);
  assert.match(sql, /v_due := greatest\(round\(v_total, 2\), 0\)/);
  // The client sends only the code, never an amount.
  assert.match(ordersLib, /p_promo_code: payload\.promoCode \?\? null/);
  assert.equal(/p_discount|p_amount|p_total/.test(ordersLib), false, 'the client must not send any money figure');
});

/* ================================================================== *
 * 6. Inventory is reserved exactly once
 * ================================================================== */
test('COD 6: stock is reserved in the same transaction, for both methods', () => {
  assert.match(sql, /update public\.product_sizes[\s\S]{0,200}greatest\(stock - \(v_row->>'quantity'\)::int, 0\)/);
  // The re-pricing path (switching method) must not reserve again — asserted in
  // COD 4b. Here we pin that both methods go through the same single reserve.
  const insertIdx = sql.indexOf('insert into public.retail_orders');
  const updateIdx = sql.indexOf('update public.product_sizes');
  assert.ok(updateIdx < insertIdx, 'stock must be reserved before the order row is written');
});

/* ================================================================== *
 * 7. A COD order is never expired or auto-cancelled
 * ================================================================== */
test('COD 7: the expiry sweeper cannot cancel or restock a confirmed COD order', () => {
  const fn = read(EXPIRE_FN);
  // The bulk sweep only looks at unpaid online states.
  assert.match(fn, /\.in\('payment_status', \['pending', 'failed'\]\)/, 'the sweep must only target unpaid online orders');
  // ...and the single-order `ref` path re-checks before acting.
  assert.match(
    fn,
    /if \(order\.is_cod && order\.payment_status === 'cod_pending'\) \{\s*\n\s*return \{ action: 'skip'/,
    'a COD order pointed at directly must be skipped, not expired',
  );
  assert.match(fn, /payment_status, created_at/, 'the sweep must select payment_status to make that decision');
  assert.match(
    fn,
    /COD order awaiting collection on delivery/,
    'the skip reason must be explicit for the operator log',
  );
});

/* ================================================================== *
 * 8. The admin sees COD as a confirmed order, not an unpaid one
 * ================================================================== */
test('COD 8: admin treats cod_pending as confirmed and shows the full amount due', () => {
  const admin = read(ADMIN);
  assert.match(
    admin,
    /const VERIFIED_PAYMENTS = \['success', 'paid', 'cod', 'cod_pending'\]/,
    "cod_pending must be an accepted New Orders state, otherwise COD orders are invisible to staff",
  );
  // ...which also removes it from the "awaiting payment" banner, because that
  // view filters on the same list with excludePayments.
  assert.match(admin, /filter\.payments = \[\.\.\.VERIFIED_PAYMENTS\];\s*\n\s*filter\.excludePayments = true;/);
  assert.match(
    admin,
    /Due on Delivery[\s\S]{0,200}amount_due_on_delivery \?\? o\.total_amount/,
    'the admin must display the amount the agent will collect',
  );
  // Legacy advance orders keep showing the split they were actually paid under.
  assert.match(admin, /Number\(o\.amount_paid_upfront \?\? 0\) > 0/);
});

/* ================================================================== *
 * 9. Every customer-facing surface tells the same story
 * ================================================================== */
/**
 * Remove code comments so a wording scan measures what actually reaches the
 * DOM. Comments legitimately document the model ("no advance, no online
 * payment") and are not customer-facing; only the rendered strings are. The
 * `//` rule skips a slash preceded by `:` so a `https://` inside a string is
 * not mistaken for a comment.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('COD 9: no customer-facing screen still advertises a COD advance', () => {
  const surfaces = {
    [STATUS_PAGE]: read(STATUS_PAGE),
    [TRACK_PAGE]: read(TRACK_PAGE),
    [MY_ORDERS]: read(MY_ORDERS),
    [CHECKOUT]: checkout,
    [EMAILS]: read(EMAILS),
  };
  for (const [file, src] of Object.entries(surfaces)) {
    assert.equal(
      /COD Advance|COD advance|Advance paid \(min|advance payment of/i.test(src),
      false,
      `${file} must not mention a COD advance`,
    );
  }

  // NEW COD orders are a single amount collected on delivery. The customer-facing
  // wording is reduced to exactly that, so the copy cannot drift back into
  // describing an advance, a split payment, or a percentage.
  const forbidden = [
    /\bno advance\b/i,
    /\badvance needed\b/i,
    /\bupfront\b/i,
    /\bpartial payment\b/i,
    /\b5\s?%/,
    /\b95\s?%/,
    /\bbalance payment\b/i,
  ];
  for (const [file, src] of Object.entries(surfaces)) {
    const rendered = stripComments(src);
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(rendered),
        false,
        `${file} must not use ${pattern} in customer-facing copy`,
      );
    }
  }

  // The confirmation screen must state the single amount due on delivery.
  const status = surfaces[STATUS_PAGE];
  assert.match(status, /Amount due on delivery/);
  // The required copy, on the page a customer lands on after checkout...
  assert.match(status, /Your order total of \$\{formatPrice\(codDue\)\} is due on delivery\./);
  // ...on the tracker (which leads with the amount due, not a payment history)...
  assert.match(surfaces[TRACK_PAGE], /Cash on Delivery — \$\{formatPrice\(/);
  assert.match(surfaces[TRACK_PAGE], /ready for your delivery partner/);
  // ...and in the checkout payment picker. The card is deliberately terse, so
  // the guarantee it has to carry is "one amount, collected on delivery".
  // "(COD)" is spelled out because the option list is also the only place a
  // shopper is told which abbreviation the rest of checkout uses.
  assert.match(surfaces[CHECKOUT], /name="CASH ON DELIVERY \(COD\)"/);
  // The COD amount must be the real due amount in full-strength ink, never a
  // muted/disabled-looking grey, or it reads as an unavailable option. Matching
  // the amount's own opening tag keeps this from passing on an unrelated
  // `text-bone` elsewhere in the file.
  //
  // The px size is deliberately NOT pinned. The amount is now larger on mobile
  // than on desktop (`text-[21px] … sm:text-[18px]`), and the number itself is
  // presentation only — what this test exists to protect is the INK, i.e. that
  // the COD price is never greyed out into looking disabled. Pinning a size
  // here would just mean editing this assertion on every type-scale tweak while
  // saying nothing about the property being defended.
  assert.match(
    surfaces[CHECKOUT],
    /font-price[\s\S]{0,200}?text-bone[\s\S]{0,80}?formatPrice\(codDue\)/,
    'COD amount must be full-strength text-bone, not a greyed-out price',
  );
  assert.doesNotMatch(
    surfaces[CHECKOUT],
    /font-price[^"']*text-(grey|bone-soft)[^"']*["'][^>]*>\s*\{formatPrice\(codDue\)/,
    'the COD amount must not use a muted ink token',
  );
  assert.match(surfaces[CHECKOUT], /sub="Pay when your order arrives"/);
  // The picker must show the amount that is actually due, not a partial figure.
  assert.match(surfaces[CHECKOUT], /formatPrice\(codDue\)/);

  // --- payment card layout: the alignment the design depends on -------------
  // The savings line must stay a full-width `footnote`, NOT inside the narrow
  // price column. In the price column it wrapped to three lines and the card was
  // ~148px tall for ~60px of content; as a footnote it is one line.
  assert.match(
    surfaces[CHECKOUT],
    /footnote=\{`You save \$\{formatPrice\(onlineDiscount\)\} by paying online`\}/,
    'the savings line must be the full-width footnote prop, not part of the price column',
  );
  // ...and the price column must still RESERVE its width up front.
  //
  // The invariant is that the column's width is reserved before the text is
  // measured, not that it is any particular number of pixels: a column with no
  // reservation at all would take its width from the method label, and that is
  // the failure this guards. The literal is 88px (up from 76px) because the
  // amount is 26px on mobile and "₹3,847" was being clipped at its widest — so
  // the reservation tracks the type scale, and pinning the number here would only
  // force an edit on every scale change.
  //
  // It is a MINIMUM (`min-w-`), not a hard `w-`, and that is deliberate: the
  // amount is a single `whitespace-nowrap` value, so a long amount must widen the
  // column rather than be broken across two lines. A fixed width could only hold
  // that by clipping or overlapping the label. `min-w` still reserves 88px for
  // every ordinary amount (COD's is never wider than that), and because the label
  // is `min-w-0 flex-1` the growth is taken from the label, which wraps — the
  // label can never be pushed into or overlapped by the price.
  const priceCol = surfaces[CHECKOUT].match(
    /flex (?:min-)?w-\[(\d+)px\][^"]*shrink-0 flex-col items-end/,
  );
  assert.ok(priceCol, 'the price column must reserve its width up front');
  assert.ok(
    !/w-\[(\d+)px\][^"]*flex-col items-end[^"]*"[^>]*>\s*\{\s*formatPrice\(codDue\)/.test(surfaces[CHECKOUT]),
    'the COD amount must not sit inside a differently-sized column',
  );
  assert.ok(Number(priceCol[1]) <= 100, `the price column must stay narrow (got ${priceCol[1]}px) so the method label gets the width`);
  // The amount sits on the same top row as the title, and the pill under it, so
  // the price column is a column (`items-end`) and not a padded text block.
  // Pinned on the TYPE properties, not the px size — the amount is now
  // responsive (26px mobile / 22px desktop) and that scale is presentation.
  assert.match(
    surfaces[CHECKOUT],
    /font-price text-\[26px\][^"]*font-bold leading-none text-bone tabular-nums/,
    'the online amount must be bold, tight-leading and tabular',
  );
  // The ₹ and the amount are ONE price value, not two stacked pieces.
  //
  // `formatPrice` joins them with U+2009 THIN SPACE, and a space IS a line-break
  // opportunity: at 26px bold tabular "₹ 2,446" is ~89px, wider than the 88px
  // reservation, so it broke at that space and left the ₹ alone on the first line
  // with the amount below it — which reads as the sign being raised too high.
  // `whitespace-nowrap` makes the pair unbreakable at every amount (₹99 through
  // ₹12,34,567) without special-casing any one value, and `items-baseline` keeps
  // the sign and the digits on one baseline. Nothing here is allowed to become a
  // separately positioned ₹ glyph.
  assert.match(
    surfaces[CHECKOUT],
    /items-baseline justify-end whitespace-nowrap font-price text-\[26px\]/,
    'the online amount must be one inline, unbreakable price value',
  );
  assert.doesNotMatch(
    surfaces[CHECKOUT],
    /absolute[^"]*>\s*\{?['"`]?₹/,
    'the currency symbol must not be positioned separately from the amount',
  );
  // Logos and the savings line share one indent, so they read as one block.
  assert.match(
    surfaces[CHECKOUT],
    /\{extra && \(\s*<span className="mt-1\.5 flex items-center pl-\[26px\]">\{extra\}<\/span>/,
  );
  // The savings footnote must stay a full-width row sharing the logo indent, so
  // it never inherits the price column's width and wraps to three lines. Neither
  // the margin nor a JSX comment between the guard and the element is pinned —
  // only the full-width, shared-indent shape.
  assert.match(
    surfaces[CHECKOUT],
    /\{footnote && \([\s\S]{0,400}?<span className="mt-[\d.]+ flex items-center pl-\[26px\][^"]*text-\[11\.5px\]/,
    'the savings footnote must be a full-width row at the logo indent, not inside the price column',
  );

  // A COD order must be treated as confirmed when rendering the timeline.
  assert.match(
    surfaces[TRACK_PAGE],
    /const cod = order\.is_cod === true \|\| order\.payment_status === 'cod_pending';/,
    'the tracker must not hide a COD order just because it is unpaid online',
  );
  // The confirmation email must match.
  assert.match(surfaces[EMAILS], /Pay on delivery/);
  assert.match(surfaces[EMAILS], /is due on delivery\./);
});

test('COD 9b: the COD advance model is gone from every customer-facing surface', () => {
  // Canonical COD is Rs 0 upfront + the full amount due on delivery. The
  // retired advance/partial split must not survive anywhere a customer can see
  // it -- notably the confirmation email, which used to render a two-row
  // "Amount collected" + "Pay at delivery" pair for advance-era rows.
  const emails = read(EMAILS);
  assert.doesNotMatch(emails, /Amount collected/,
    'the COD advance "Amount collected" row must not exist');
  assert.doesNotMatch(emails, /is payable when it arrives/,
    'the COD advance wording must not exist');
  // The COD branch is now a single unconditional "Pay on delivery" row that
  // reads the authoritative stored remainder.
  const totals = emails.slice(emails.indexOf('function totalsBlock'), emails.indexOf('function addressBlock'));
  const cod = codBranchOf(totals);
  assert.match(cod, /Pay on delivery/);
  assert.match(cod, /amount_due_on_delivery \?\? order\.total_amount/);
  assert.doesNotMatch(cod, /if \(Number\(order\.amount_paid_upfront\)/,
    'the COD branch must not branch on a prepaid amount any more');
  // Still truthful, and still free of advance UI, on the customer pages.
  assert.match(read(MY_ORDERS), /due on delivery/);
  for (const page of [MY_ORDERS, TRACK_PAGE, STATUS_PAGE, CHECKOUT]) {
    assert.doesNotMatch(codeOnlySrc(read(page)), /cod_partial_paid|pay remaining|amount collected|advance paid/i,
      'no customer-facing COD advance copy may remain');
  }
});

test('COD 9c: customer order totals use stored payment and delivery amounts', () => {
  const status = read(STATUS_PAGE);
  const tracking = read(TRACK_PAGE);
  assert.match(checkout, /result\.is_cod \? codDue : \(result\.amount_paid_upfront \?\? result\.total_amount\)/);
  assert.match(status, /snap\.is_cod \? codDue : \(snap\.amount_paid_upfront \?\? snap\.total_amount\)/);
  assert.match(tracking, /order\.amount_paid_upfront \?\? order\.total_amount/);
  for (const [file, src] of [[CHECKOUT, checkout], [STATUS_PAGE, status], [TRACK_PAGE, tracking]]) {
    assert.doesNotMatch(src, /(?:result|snap|order)\.total_amount\s*-\s*\((?:result|snap|order)\.payment_discount/,
      `${file} must not recalculate an online payment total`);
  }

  const account = read('src/lib/account.ts');
  assert.match(account, /amount_due_on_delivery/);
  // The delivery amount is requested through the shared column-group constant
  // the fallback chain is built from, not through a literal .select('...'), so
  // assert the column is present in the group every level of the chain inherits.
  // Tolerate the `=` / string landing on separate lines.
  const baseCols = account.match(/const SELECT_BASE\s*=\s*'([^']+)'/s)?.[1] ?? '';
  assert.match(baseCols, /amount_due_on_delivery/, 'the base select must request the COD delivery amount');
  assert.match(read(MY_ORDERS), /Due on delivery \{formatPrice\(o\.amount_due_on_delivery \?\? o\.total_amount\)\}/);
});

/* ================================================================== *
 * 10. Historical orders stay truthful
 * ================================================================== */
test('COD 10: historical rows preserve money while the retired state is normalized', () => {
  const backfillIdx = sql.indexOf('update public.retail_orders', sql.indexOf('Convert ONLY'));
  const backfill = sql.slice(backfillIdx, sql.indexOf(';', sql.indexOf('where is_cod', backfillIdx)) + 1);
  assert.match(backfill, /where is_cod\s*\n\s*and payment_status = 'pending';/);

  // The new payment status must be documented on the column.
  assert.match(sql, /comment on column public\.retail_orders\.amount_due_on_delivery is/);
  assert.match(sql, /'Amount the delivery agent collects on delivery \(INR\)\. COD: total_amount/);

  for (const fn of [read(STATUS_FN), read(WEBHOOK_FN)]) {
    assert.match(fn, /order_status: 'processing'/, 'verified payments must use normal processing');
    assert.doesNotMatch(fn, /cod_partial_paid/);
  }
  const retire = read(RETIRE_STATUS_MIGRATION);
  assert.match(retire, /set order_status = 'processing'/);
  assert.match(retire, /order_status = 'cod_partial_paid'/);
  assert.doesNotMatch(retire, /set[\s\S]*amount_paid_upfront|set[\s\S]*amount_due_on_delivery/);
  assert.match(
    read(STATUS_FN),
    /if \(order\.is_cod && \(order\.payment_status === 'cod_pending' \|\| !order\.payment_id\)\) \{[\s\S]{0,200}cod_pending/,
    'the status endpoint must answer a full-COD order without touching the gateway',
  );
  // The return page confirms a COD ref instead of bouncing it back to checkout.
  assert.match(
    read(RETURN_PAGE),
    /o\.payment_status === 'success' \|\| \(o\.is_cod && o\.payment_status === 'cod_pending'\)/,
    'a COD ref landing on the payment return page must be confirmed, not redirected back',
  );
});

/* ================================================================== *
 * 11. A confirmed COD order must be able to REACH the customer
 * ================================================================== */
test('COD 11: a confirmed COD order can move through processing, shipped and delivered', () => {
  const admin = read(ADMIN);

  // Regression: the guard used to require payment_status = 'success', so a new
  // COD order (cod_pending) could never be packed, shipped or delivered.
  assert.doesNotMatch(
    admin,
    /o\.payment_status !== 'success' && \['cod_partial_paid', 'processing', 'shipped', 'delivered'\]/,
    "the old guard that blocked every cod_pending order from fulfillment must be gone",
  );
  assert.match(
    admin,
    /const confirmed = \(VERIFIED_PAYMENTS as readonly string\[]\)\.includes\(o\.payment_status\);/,
    'fulfilment must be gated on the full confirmed list, which includes cod_pending',
  );
  assert.match(
    admin,
    /if \(!confirmed && \['processing', 'shipped', 'delivered'\]\.includes\(next\)\)/,
    'an unconfirmed online order must still be blocked from fulfillment',
  );

  // cod_pending must be in that list, or the guard is a no-op.
  assert.match(admin, /const VERIFIED_PAYMENTS = \['success', 'paid', 'cod', 'cod_pending'\] as const;/);
});

/* ================================================================== *
 * 12. cod_partial_paid is not a destination any more
 * ================================================================== */
test('COD 12: the retired partial-COD state is absent from active production code', () => {
  const labels = read(ORDER_LABELS);
  const admin = read(ADMIN);

  // Absent from the selectable flow...
  const flow = /export const ORDER_STATUS_FLOW = \[([^\]]*)\]/.exec(labels);
  assert.ok(flow, 'ORDER_STATUS_FLOW must exist');
  assert.doesNotMatch(
    flow[1],
    /cod_partial_paid/,
    'cod_partial_paid must not be a selectable destination',
  );
  assert.doesNotMatch(labels, /cod_partial_paid/);

  // The dropdown uses the per-order option list, not the raw flow.
  assert.match(admin, /orderStatusOptions\(o\.order_status\)\.map/);
  assert.doesNotMatch(admin, /ORDER_STATUS_FLOW\.map/);

  // The payment-start endpoint only permits ordinary online states.
  const payable = /const PAYABLE_ORDER_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(read(API));
  assert.ok(payable, 'PAYABLE_ORDER_STATUSES must exist');
  assert.doesNotMatch(payable[1], /cod_partial_paid/);
  for (const file of [API, CHECKOUT, TRACK_PAGE, MY_ORDERS, ADMIN, ORDER_LABELS, STATUS_FN, WEBHOOK_FN]) {
    assert.doesNotMatch(read(file), /cod_partial_paid/, `${file} must not retain retired COD status logic`);
  }
});

/* ================================================================== *
 * 13. The invariant is enforced by the database, not just by convention
 * ================================================================== */
test('COD 13: the database refuses to store an online charge on a cod_pending order', () => {
  const ops = read(OPS_MIGRATION);

  // Scoped to the NEW state, so legacy COD advances are not invalidated...
  assert.match(ops, /dslang_cod_pending_no_upfront_chk/);
  const constraint = /add constraint dslang_cod_pending_no_upfront_chk\s*\n\s*check \(([\s\S]*?)\) not valid;/.exec(ops);
  assert.ok(constraint, 'the guard must exist as a NOT VALID check constraint');
  assert.match(constraint[1], /not coalesce\(is_cod, false\)/);
  assert.match(constraint[1], /payment_status is distinct from 'cod_pending'/);
  assert.match(constraint[1], /amount_paid_upfront = 0/);
  // ...and NOT VALID, so applying it cannot fail against existing history.
  assert.match(constraint[0], /not valid;/);

  // A blanket `is_cod => amount_paid_upfront = 0` would abort the migration
  // against legacy rows that genuinely paid an advance, so the predicate must
  // be gated on the new payment state. Exactly one constraint is added, and it
  // must be the scoped one.
  const added = ops.match(/add constraint\s+(\w+)\s*\n\s*check \(([\s\S]*?)\) not valid;/g) ?? [];
  assert.equal(added.length, 1, 'exactly one guarded constraint may be added');
  assert.match(constraint[1], /payment_status is distinct from 'cod_pending'/);
  assert.doesNotMatch(
    constraint[1],
    /not coalesce\(is_cod, false\)\s*\n?\s*or amount_paid_upfront = 0/,
    'a blanket COD zero-charge check would fail validation against historical advance rows',
  );

  // This migration must not rewrite history.
  assert.doesNotMatch(
    ops,
    /update\s+public\.retail_orders/i,
    'the ops migration must not mutate any retail_orders row',
  );
});

/* ================================================================== *
 * 14. No gateway event may touch a new COD order
 * ================================================================== */
test('COD 14: a stale gateway event can never convert a COD order', () => {
  const status = read(STATUS_FN);
  const webhook = read(WEBHOOK_FN);
  const expire = read(EXPIRE_FN);

  for (const [name, src] of [['cashfree-status', status], ['cashfree-webhook', webhook]]) {
    // The early return: a full-COD order is answered, never verified. The
    // webhook matches on payment_id so its guard is the plain form; the status
    // endpoint also covers a missing payment_id.
    const guard = new RegExp(
      'if \\(order\\.is_cod &&[^{]*cod_pending[^{]*\\{[\\s\\S]{0,240}?(cod_pending|ignored)',
    );
    assert.match(src, guard, `${name} must short-circuit a new COD order before any gateway call`);
    // The independent second layer: even if the early return were removed, the
    // CAS would match zero rows.
    assert.match(
      src,
      /\.neq\('payment_status', 'cod_pending'\)/,
      `${name} must exclude cod_pending from its payment flip`,
    );
  }

  // The sweeper can neither cancel nor restock a confirmed COD order, and can
  // never settle one through the gateway.
  assert.match(
    expire,
    /order\.is_cod && order\.payment_status === 'cod_pending'\)[\s\S]{0,120}return \{ action: 'skip'/,
    'the sweeper must skip a confirmed COD order entirely',
  );
  assert.match(expire, /\.neq\('payment_status', 'cod_pending'\)/);

  // A COD order keeps no gateway session, so nothing can resolve it by payment id.
  // create_retail_order never writes payment_id at all (an online order is given
  // one only after the gateway session exists), so a new COD order is born with
  // no payment_id by construction.
  const insert = /insert into public\.retail_orders \(([\s\S]*?)\)\s*\n\s*values \(([\s\S]*?)\)\s*\n\s*returning id into v_order_id;/.exec(sql);
  assert.ok(insert, 'expected the order insert in create_retail_order');
  assert.doesNotMatch(insert[1], /payment_id/, 'a new order must not be born with a gateway session');
  assert.doesNotMatch(insert[2], /payment_id/);
  // The online path attaches its session later, outside the insert.
  assert.match(sql, /attach_cashfree|payment_id\s*=/);
  // And conversion explicitly clears any session it may have had.
  assert.match(sql, /payment_id = null,/);
  assert.ok(
    /update public\.retail_orders[\s\S]{0,800}?payment_id = null,/.test(sql),
    'the conversion must clear the gateway session',
  );
});

/* ================================================================== *
 * 15. COD reaches the operational queues
 * ================================================================== */
test('COD 15: a confirmed COD order is visible in New Orders and packing', () => {

  // Regression: the old definitions required payment_status = 'success' AND
  // order_status IN ('cod_partial_paid','processing'), which a new COD order
  // ('cod_pending' + 'pending') matched nowhere — invisible to packing staff.



  // ...and it holds stock like any other committed order, so it is not hidden
  // from inventory either.

  // The admin New Orders tab keeps COD visible and keeps it out of the
  // "awaiting payment" view.
  const admin = read(ADMIN);
  assert.match(admin, /const NEW_ORDER_STATUSES = \['pending'\] as const;/);
  assert.match(admin, /payments: VERIFIED_PAYMENTS \}/);
  const shipping = read('src/pages/admin/ShippingSection.tsx');
  assert.match(shipping, /new Set\(\['pending', 'processing'\]\)/);
  assert.doesNotMatch(shipping, /cod_partial_paid/);
});

/* ================================================================== *
 * 16. Ops reporting never calls an unpaid COD order collected revenue
 * ================================================================== */
test('COD 16: ops reporting separates order value from cash collected', () => {
  const ops = read(OPS_MIGRATION);

  // Cash collected is summed from amount_paid_upfront, which is 0 for a new COD
  // order — so collecting money can never include a door payment that has not
  // happened yet.
  const cash = /'cash_collected', coalesce\(\(\s*\n\s*select sum\(x\.amount_paid_upfront\) from/.exec(ops);
  assert.ok(cash, 'cash_collected must be summed from amount_paid_upfront');

  // Order value stays total_amount.
  const sales = /'sales', coalesce\(\(\s*\n\s*select sum\(x\.total_amount\) from/.exec(ops);
  assert.ok(sales, 'order value must stay total_amount');

  // Amount due is reported separately, for live COD orders only.
  assert.match(
    ops,
    /'cod_due', coalesce\(\(\s*\n\s*select sum\(x\.amount_due_on_delivery\) from \(\s*\n\s*select o\.amount_due_on_delivery/,
    'cod_due must be summed from amount_due_on_delivery',
  );
  assert.match(ops, /and coalesce\(o\.is_cod, false\)/);

  // The payment mix must expose all three numbers per method, so COD cannot be
  // read as realised revenue.
  assert.match(ops, /'order_value', t\.order_value,/);
  assert.match(ops, /'cash_collected', t\.cash_collected,/);
  assert.match(ops, /'amount_due', t\.amount_due/);
  assert.match(ops, /sum\(amount_paid_upfront\)::numeric as cash_collected/);

  // A customer's COD order must not inflate what they are recorded as spending
  // in cash either.
  assert.match(ops, /as total_paid/);
  assert.match(ops, /as total_due/);
  assert.match(ops, /'customers', coalesce\(v_rows/);
});

/* ================================================================== *
 * 17. The live dashboard tells the same story
 * ================================================================== */
test('COD 17: the dashboard labels order value and cash collected separately', () => {
  const data = read(DASH_DATA);
  const overview = read(OVERVIEW);

  // It must read the real cash column, not infer it from the order total.
  assert.match(data, /amount_paid_upfront, amount_due_on_delivery/);

  // Cash is accumulated independently of whether the order counts as paid, so
  // an uncollected COD order contributes 0 rather than its full value.
  assert.match(data, /curCash \+= Number\(o\.amount_paid_upfront\) \|\| 0;/);
  assert.match(data, /cashSeries\[idx\]\.current \+= Number\(o\.amount_paid_upfront\) \|\| 0;/);

  // "isPaid" is what drives the order-value figure, and it must EXCLUDE
  // cod_pending: an unpaid COD order is real order value but not cash.
  const isPaid = /function isPaid\(o: \{ payment_status: string \}\): boolean \{\s*\n\s*return ([^;]+);/.exec(data);
  assert.ok(isPaid, 'isPaid must exist');
  assert.doesNotMatch(isPaid[1], /cod_pending/, 'an uncollected COD order is not paid revenue');
  assert.doesNotMatch(isPaid[1], /'cod'/, "a COD order's money is collected at the door, not online");

  // Canceled / refunded orders are excluded from the amount owed at the door.
  assert.match(data, /function isLive\(/);
  assert.match(data, /if \(o\.is_cod && isLive\(o\)\)/);

  // Both figures are surfaced, with honest labels.
  assert.match(data, /cashCollected: \{ value: curCash/);
  assert.match(data, /codDue: \{ value: curCodDue/);
  assert.match(overview, /label="Order value"/);
  assert.match(overview, /label="Cash collected"/);
  assert.match(overview, /Awaiting collection on delivery/);
  assert.doesNotMatch(overview, /label="Revenue"/, 'a mixed order-value/cash figure must not be called plain "Revenue"');
});

/* ================================================================== *
 * 11. COD order-confirmation email
 *
 * COD is confirmed at creation with payment_status 'cod_pending' and
 * never touches a gateway, so the Cashfree paid-flip that mails the ONLINE
 * confirmation could never fire for it. The checkout therefore asks the
 * possession-gated `cod-order-mail` function, which is authoritative and
 * idempotent.
 * ================================================================== */
test('COD 11a: a settled COD order asks the server to send its confirmation', () => {
  assert.match(read(CHECKOUT), /invokeFunction<[^>]*>\('cod-order-mail', \{\s*orderRef: ref,\s*phone,/);
  // Gated on the COD outcome only, so the ONLINE path is untouched.
  const eff = read(CHECKOUT).slice(read(CHECKOUT).indexOf("invokeFunction<{ ok?: boolean; sent?: boolean }>('cod-order-mail'") - 700);
  assert.match(eff, /if \(!result\?\.is_cod \|\| !ref\) return;/);
});

test('COD 11b: the COD email trigger is fail-open and never blocks the order', () => {
  const src = read(CHECKOUT);
  const eff = src.slice(
    src.indexOf("invokeFunction<{ ok?: boolean; sent?: boolean }>('cod-order-mail'") - 600,
    src.indexOf("invokeFunction<{ ok?: boolean; sent?: boolean }>('cod-order-mail'") + 400,
  );
  assert.match(eff, /catch \{[\s\S]{0,300}?Best-effort/,
    'a mail failure must be swallowed, never surfaced to the shopper');
  // It must not gate the order CTA on the email.
  assert.doesNotMatch(eff, /setErrorMsg/, 'the email must never produce a checkout error');
});

test('COD 11c: checkout email is required so a confirmation can be delivered', () => {
  const co = codeOnlySrc(read(CHECKOUT));
  assert.match(co, /REQUIRED_FIELDS = \[[^\]]*'email'[^\]]*\]/,
    'email must be a required field');
  assert.doesNotMatch(co, /label="Email \(optional\)"/);
  assert.match(co, /case 'email':[\s\S]{0,160}?if \(!v\) return 'Please enter your email for order updates'/);
  // Guest checkout is otherwise untouched: no login/OTP/password was added.
  assert.doesNotMatch(co, /password|otp|oneTimeCode/i);
  // The address is still sent to the server on the order itself.
  assert.match(co, /email: f\.email \|\| undefined/);
});

test('COD 11d: a COD email shows the due amount and never the online discount', () => {
  const em = read(EMAILS);
  const totals = em.slice(em.indexOf('function totalsBlock'), em.indexOf('function addressBlock'));
  assert.match(totals, /const isCod = Boolean\(order\.is_cod\)/);
  // The COD branch is the `if`; EVERYTHING else (including the Rs 50 row) lives
  // in the `else`, so an online discount is unreachable for a COD order.
  assert.match(totals, /if \(isCod\) \{[\s\S]*?\} else \{[\s\S]*?Online payment discount/,
    'payment_discount must only be rendered in the non-COD branch');
  assert.match(totals, /Pay on delivery/);
  assert.match(em, /Your order total of \$\{inr\(order\.amount_due_on_delivery \?\? order\.total_amount\)\} is due on delivery\./);
});

/** Returns the body of the `if (isCod) { ... }` branch, brace-matched. */
function codBranchOf(totals) {
  const start = totals.indexOf('if (isCod) {');
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < totals.length; i++) {
    if (totals[i] === '{') depth++;
    else if (totals[i] === '}') {
      depth--;
      if (depth === 0) return totals.slice(start, i + 1);
    }
  }
  return '';
}

/** Strip comments so a CODE assertion is not affected by explanatory prose. */
function codeOnlySrc(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ================================================================== *
 * 14. The confirmed email must state the amount ACTUALLY paid
 *
 * Regression: for a 649 + 49 = 698 order carrying the Rs 50 online discount,
 * the email used to stop at a bolded "Order Total 698" with a bare "-50"
 * underneath and no resulting figure � so the most prominent number on the
 * page was NOT what the customer was charged. The closing "Amount Paid" line
 * is rendered from the AUTHORITATIVE order.amount_paid_upfront, never
 * recomputed, so a promo and the Rs 50 are each netted out exactly once.
 * ================================================================== */
test('COD 14a: the online email ends with the authoritative Amount Paid', () => {
  const totals = read(EMAILS).slice(
    read(EMAILS).indexOf('function totalsBlock'),
    read(EMAILS).indexOf('function addressBlock'),
  );
  // Driven by the stored collected amount, not by arithmetic on the rows above.
  assert.match(totals, /const paid = Number\(order\.amount_paid_upfront\)/,
    'Amount Paid must read the stored amount_paid_upfront');
  assert.match(totals, /Number\.isFinite\(paid\) && paid > 0/,
    'it must not print a figure for an order with no recorded collection');
  assert.match(totals, />Amount Paid</,
    'the closing line must be labelled Amount Paid');
  // Never derived from the display strings above it.
  assert.doesNotMatch(totals, /total_amount\s*-\s*(Number\()?order\.payment_discount/,
    'Amount Paid must not be recomputed from total_amount - payment_discount');
});

test('COD 14b: COD emails never gain an Amount Paid or the online discount', () => {
  const em = read(EMAILS);
  const totals = em.slice(em.indexOf('function totalsBlock'), em.indexOf('function addressBlock'));
  // The COD branch must be the `if`, and the new online-only work the `else`.
  assert.match(totals, /if \(isCod\) \{[\s\S]*?\} else \{/,
    'the online Amount Paid must live in the non-COD branch only');
  // Brace-matched, because the COD branch contains its own nested if/else.
  const codBranch = codBranchOf(totals);
  assert.ok(codBranch.length > 0, 'could not locate the COD branch');
  assert.doesNotMatch(codBranch, /Amount Paid/,
    'a COD email must not show Amount Paid');
  assert.doesNotMatch(codBranch, /Online payment discount/,
    'a COD email must never show the Rs 50 online discount');
  // COD still reports the authoritative full remaining amount.
  assert.match(codBranch, /Pay on delivery/);
  assert.match(codBranch, /amount_due_on_delivery/);
});

/* ================================================================== *
 * 15. A NEW COD order is structurally full-payment-on-delivery
 * ================================================================== */
test('COD 15a: new COD is Rs 0 upfront and the full amount due, at every layer', () => {
  const co = read(CHECKOUT);
  // Checkout: the COD figures are derived from the whole order total, never
  // from a partially-paid notion.
  assert.match(co, /const codDue = safeTotal;/,
    'COD due must be the full order total');
  assert.match(co, /const payableNow = paymentMethod === 'cod' \? 0 : onlineTotal;/,
    'COD must collect nothing online');
  // The online Rs 50 can never touch a COD figure.
  assert.match(co, /if \(paymentMethod === 'cod'\) \{/);
  const codPay = co.slice(co.indexOf("if (paymentMethod === 'cod') {"), co.indexOf("if (paymentMethod === 'cod') {") + 700);
  assert.doesNotMatch(codPay, /onlineDiscount/,
    'the online discount must not be applied to COD');
});

test('COD 15b: the retired advance state cannot be produced by any active path', () => {
  // No active code may mint the retired status.
  for (const rel of [CHECKOUT, STATUS_PAGE, TRACK_PAGE, MY_ORDERS]) {
    assert.doesNotMatch(codeOnlySrc(read(rel)), /cod_partial_paid/,
      `${rel} must not produce cod_partial_paid`);
  }
  // The email template has exactly one COD outcome and one online outcome.
  const totals = read(EMAILS).slice(
    read(EMAILS).indexOf('function totalsBlock'),
    read(EMAILS).indexOf('function addressBlock'),
  );
  assert.match(totals, /if \(isCod\) \{/);
  assert.equal((totals.match(/Pay on delivery/g) ?? []).length, 1,
    'COD must render exactly one due-on-delivery row, with no variants');
  assert.equal((totals.match(/Amount Paid/g) ?? []).length, 1,
    'Amount Paid must exist only for online orders');
});

test('COD 15c: the deleted legacy orders leave no frozen carve-out behind', () => {
  // The four legacy advance-era COD orders were deleted outright, so the
  // ref-scoped frozen set that protected them is gone. The sweeper must decide
  // purely on stored payment state, and real full-COD orders stay protected by
  // the cod_pending guard rather than by a hard-coded ref list.
  const sweeper = read('supabase/functions/expire-stale-orders/index.ts');
  assert.doesNotMatch(sweeper, /LEGACY_ADVANCE_COD_REFS/,
    'the deleted orders must not leave a frozen ref list in the sweeper');
  assert.doesNotMatch(sweeper, /frozen legacy advance-era COD order/,
    'the frozen skip note must be gone');
  assert.match(sweeper, /order\.is_cod && order\.payment_status === 'cod_pending'/,
    'full-COD orders must still be skipped, by payment state');
});

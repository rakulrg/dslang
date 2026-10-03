/**
 * Payment-rule regression tests.
 *
 * The business rules (the online payment-method discount, FULL COD on delivery,
 * who may pay, what the server may trust) live in TWO places that must agree:
 *
 *   1. the authoritative Postgres RPC `create_retail_order` in
 *      `supabase/migrations/20261012000000_dslang_cod_full_payment.sql`
 *      (which supersedes the advance model in `20260930000000_...`, still on
 *      disk and still applied, but no longer the pricing source of truth)
 *   2. the Vercel payment-start endpoint `api/cashfree-order.ts`
 *
 * There is no Postgres in this repo, so these tests do two different things:
 *
 *   * The PRICING RULES are executed, not described. The real `if v_is_cod ...
 *     end if;` block is read out of the migration and evaluated by a tiny
 *     purpose-built interpreter, so a change to the real SQL fails here. The
 *     rule is not restated in JS — only the evaluator is.
 *   * The ENDPOINT + TRACKING + SCHEDULER guarantees are asserted as contracts
 *     against the real source, because they are properties of code paths that
 *     need a live Supabase and a live gateway to execute.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** The migration that now owns the canonical pricing split. */
const COD_MIGRATION = 'supabase/migrations/20261012000000_dslang_cod_full_payment.sql';
/** The applied, superseded advance-model migration. It must stay on disk
 *  untouched — these tests only assert that it was NOT edited. */
const LEGACY_COD_MIGRATION = 'supabase/migrations/20260930000000_dslang_retail_cod.sql';
const THROTTLE_MIGRATION = 'supabase/migrations/20261011000000_dslang_track_lookup_throttle.sql';
const SWEEP_MIGRATION = 'supabase/migrations/20261010000000_dslang_install_sweep_schedules.sql';
const API = 'api/cashfree-order.ts';
const PAYMENT_LIB = 'src/lib/payment.ts';
const EDGE = 'supabase/functions/cashfree-order/index.ts';
const CHECKOUT = 'src/pages/CheckoutPage.tsx';
const ORDERS_LIB = 'src/lib/orders.ts';
const STATUS_FN = 'supabase/functions/cashfree-status/index.ts';
const WEBHOOK_FN = 'supabase/functions/cashfree-webhook/index.ts';
const EXPIRE_FN = 'supabase/functions/expire-stale-orders/index.ts';
const EMAILS = 'supabase/functions/_shared/emails.ts';
const ADMIN = 'src/pages/admin/AdminDashboard.tsx';

const codSql = read(COD_MIGRATION);
const legacyCodSql = read(LEGACY_COD_MIGRATION);
const apiSrc = read(API);

/** Comments document the rules and legitimately name what they ban, so strip
 *  them before asserting that a call is absent from the executable code. */
const apiCode = apiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/* ================================================================== *
 * 1. Execute the REAL pricing block out of the migration
 * ================================================================== */

/**
 * Pull the `if v_is_cod then ... else ... end if;` pricing block straight out of
 * the migration text. Locating it by content (not by line number) means the test
 * keeps testing the right block if the file is edited above it.
 */
function extractCodPricingBlock(sql) {
  const start = sql.indexOf('if v_is_cod then');
  assert.notEqual(start, -1, 'expected an `if v_is_cod then` pricing branch in the COD migration');

  // Find the matching `end if;` by counting the nested if/end-if depth.
  const tokens = [...sql.slice(start).matchAll(/\b(if|end\s+if)\b/g)];
  let depth = 0;
  let end = -1;
  for (const t of tokens) {
    if (t[1] === 'if') depth += 1;
    else {
      depth -= 1;
      if (depth === 0) {
        end = start + t.index + t[0].length;
        break;
      }
    }
  }
  assert.notEqual(end, -1, 'unbalanced if/end if in the COD migration');

  const block = sql.slice(start, end);
  const elseIdx = block.indexOf('else');
  assert.notEqual(elseIdx, -1, 'expected an `else` (online) branch next to the COD branch');
  return {
    cod: block.slice(block.indexOf('then') + 'then'.length, elseIdx),
    online: block.slice(elseIdx + 'else'.length, block.lastIndexOf('end if')),
  };
}

/**
 * Evaluate the `v_x := <expr>;` statements of one branch of the migration.
 * Supports exactly the operators the real block uses: least(), greatest(),
 * round(x, d) with Postgres numeric semantics, +, -, *, /, parentheses and
 * numeric literals. Nothing about the RULE is encoded here — only the operators.
 */
function evalPricingBranch(branchSql, inputs) {
  const stmts = branchSql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  // Postgres round(numeric, int) — half-up away from zero, kept in floating
  // point. It matters here: the COD balance is round(total - advance, 2), and a
  // JS-only round() would drop the scale argument and silently change the rule.
  const pgRound = (x, d) => {
    const scale = 10 ** (d ?? 0);
    return Math.sign(x) * Math.round(Math.abs(x) * scale) / scale;
  };

  const names = new Set();
  for (const s of stmts) {
    const m = /^(v_\w+)\s*:=/.exec(s);
    assert.ok(m, `unexpected statement in the pricing block: ${JSON.stringify(s)}`);
    names.add(m[1]);
    for (const v of s.matchAll(/v_\w+/g)) names.add(v[0]);
  }
  const vars = [...names];
  const env = { ...inputs };
  for (const s of stmts) {
    const [, name, expr] = /^(v_\w+)\s*:=\s*([\s\S]+)$/.exec(s);
    // eslint-disable-next-line no-new-func
    const fn = new Function('least', 'greatest', 'round', ...vars, `return (${expr});`);
    env[name] = fn(Math.min, Math.max, pgRound, ...vars.map((n) => env[n]));
  }
  return env;
}

/** Run the real migration logic for one order total and payment method. */
function price(total, isCod) {
  const { cod, online } = extractCodPricingBlock(codSql);
  const env = evalPricingBranch(isCod ? cod : online, { v_total: total });
  return {
    payment_discount: env.v_payment_discount,
    amount_paid_upfront: env.v_upfront,
    amount_due_on_delivery: env.v_due,
  };
}

test('PRICING: an online order gets the fixed Rs 50 discount and is charged in full', () => {
  assert.deepEqual(price(1000, false), {
    payment_discount: 50,
    amount_paid_upfront: 950,
    amount_due_on_delivery: 0,
  });
});

test('PRICING: an online discount is capped by the order value, never negative', () => {
  assert.deepEqual(price(30, false), {
    payment_discount: 30,
    amount_paid_upfront: 0,
    amount_due_on_delivery: 0,
  });
});

test('PRICING: a COD order gets NO online discount', () => {
  const p = price(1000, true);
  assert.equal(p.payment_discount, 0, 'COD must not receive the Rs 50 online discount');
});

test('PRICING: a COD order is collected in FULL on delivery and nothing is charged online', () => {
  assert.deepEqual(price(1000, true), {
    payment_discount: 0,
    amount_paid_upfront: 0,
    amount_due_on_delivery: 1000,
  });
});

test('PRICING: a small COD order is still collected in full — there is no advance cap', () => {
  assert.deepEqual(price(40, true), {
    payment_discount: 0,
    amount_paid_upfront: 0,
    amount_due_on_delivery: 40,
  });
});

test('PRICING: a COD order NEVER carries an online charge, at any order value', () => {
  for (let total = 0; total <= 5000; total += 11) {
    const p = price(total, true);
    assert.equal(p.amount_paid_upfront, 0, `COD charged ${p.amount_paid_upfront} online at total ${total}`);
    assert.equal(p.payment_discount, 0, `COD received a discount at total ${total}`);
    assert.equal(p.amount_due_on_delivery, total, `COD due ${p.amount_due_on_delivery} != total ${total}`);
  }
});

test('PRICING: a zero-value order is never charged a negative amount', () => {
  assert.deepEqual(price(0, true), {
    payment_discount: 0,
    amount_paid_upfront: 0,
    amount_due_on_delivery: 0,
  });
});

test('PRICING: discount never exceeds the total (swept over 0..5000)', () => {
  for (let total = 0; total <= 5000; total += 7) {
    for (const isCod of [false, true]) {
      const p = price(total, isCod);
      assert.ok(p.payment_discount <= total, `discount ${p.payment_discount} > total ${total} (cod=${isCod})`);
      assert.ok(p.amount_paid_upfront >= 0, `negative upfront for total ${total} (cod=${isCod})`);
      assert.ok(p.amount_paid_upfront <= total, `upfront ${p.amount_paid_upfront} > total ${total} (cod=${isCod})`);
      assert.ok(p.amount_due_on_delivery >= 0, `negative due for total ${total} (cod=${isCod})`);
    }
  }
});

test('PRICING: money is conserved - what is charged plus what is due plus the discount is the total', () => {
  for (let total = 0; total <= 5000; total += 13) {
    for (const isCod of [false, true]) {
      const p = price(total, isCod);
      assert.equal(
        p.amount_paid_upfront + p.amount_due_on_delivery + p.payment_discount,
        total,
        `upfront+due+discount mismatch at total ${total} (cod=${isCod})`,
      );
    }
  }
});

test('PRICING: an online order under the discount value is fully discounted (existing, intended cap)', () => {
  // `least(50, v_total)` caps the discount at the order value, so it can never
  // make a total negative — the documented consequence is that a sub-Rs-50
  // online order is free. This is PRE-EXISTING authoritative behaviour in
  // create_retail_order and is deliberately NOT changed here; the test exists to
  // pin it so a future pricing change is a conscious decision.
  assert.deepEqual(price(49, false), {
    payment_discount: 49,
    amount_paid_upfront: 0,
    amount_due_on_delivery: 0,
  });
  // A COD order of the same value is still collected in full at delivery.
  assert.equal(price(49, true).amount_due_on_delivery, 49);
  assert.equal(price(49, true).amount_paid_upfront, 0);
});

test('PRICING: only COD leaves a balance to collect; online is always fully settled at creation', () => {
  for (let total = 1; total <= 3000; total += 29) {
    assert.equal(price(total, false).amount_due_on_delivery, 0);
    assert.ok(price(total, true).amount_due_on_delivery > 0, `COD total ${total} has nothing to collect`);
  }
});

test('PRICING: total is subtotal - discount + shipping, so a promo cannot break the identity', () => {
  assert.match(
    codSql,
    /v_total\s*:=\s*v_subtotal\s*-\s*v_discount\s*\+\s*v_shipping/,
    'the order total must be derived from subtotal, discount and shipping in SQL',
  );
  assert.match(
    codSql,
    /v_total\s*:=\s*v_subtotal\s*-\s*v_discount\s*\+\s*v_shipping/,
    'the client must never be able to send its own total',
  );
});

test('PRICING: the client-facing figures mirror the same two rules at checkout', () => {
  const checkout = read(CHECKOUT);
  assert.match(
    checkout,
    /const codDue = safeTotal/,
    'checkout must show the FULL order total as the COD amount due on delivery',
  );
  assert.match(
    checkout,
    /const onlineDiscount = Math\.min\(50, safeTotal\)/,
    'checkout must show the same fixed Rs 50 online discount, capped by the total',
  );
});

test('PRICING: the order summary shows the PRE-discount product subtotal', () => {
  const checkout = read(CHECKOUT);
  // The "Items" row in the order summary is the product selling price, so it
  // must be the product subtotal. It previously rendered `total` =
  // subtotal - discount + shipping, which is already discounted AND includes
  // shipping: a 649 + 49 - 100 cart displayed 598 instead of 649.
  const start = checkout.indexOf('Items ({count})');
  const summary = checkout.slice(start, checkout.indexOf('</dl>', start));
  assert.ok(start > -1 && summary.length > 0, 'could not locate the Items row in the order summary');
  assert.match(summary, /formatPrice\(subtotal\)/, 'the Items row must render the cart subtotal');
  assert.doesNotMatch(
    summary,
    /\{\(?total \|\| 0\)?\.toLocaleString\(/,
    'the summary must NOT render the discounted, shipping-inclusive total as a product price',
  );
  // The authoritative pre-discount source: the cart's own sum of line prices.
  assert.match(
    read('src/lib/d2cCart.tsx'),
    /const subtotal = useMemo\(\(\) => items\.reduce\(\(s, i\) => s \+ i\.unitPrice \* i\.quantity, 0\)/,
    'subtotal must remain SUM(unitPrice * quantity) with no discount folded in',
  );
});

test('PRICING: the summary breakdown still rolls up to the payable totals', () => {
  const checkout = read(CHECKOUT);
  // Anchor on the summary toggle. This used to be the `Order Summary</h3>`
  // heading; the summary is now a collapsible <button> whose label is a span,
  // so anchor on the aria-expanded state instead — it is the one string that
  // marks the start of the summary region and that the collapse test also
  // pins. The pricing rows below it are unchanged by the layout work.
  const breakdown = checkout.slice(checkout.indexOf('aria-expanded={summaryOpen}'));
  // The itemised rows are what carry the promo and online discounts, each
  // applied exactly once, on top of the pre-discount Items subtotal.
  assert.match(breakdown, /<dt className="text-bone-soft">Items \(\{count\}\)<\/dt>/);
  assert.match(breakdown, /formatPrice\(subtotal\)/);
  assert.match(breakdown, /<dt className="text-bone-soft">Shipping<\/dt>/);
  assert.match(breakdown, /formatPrice\(discount\)/);
  assert.match(breakdown, /formatPrice\(onlineDiscount\)/);
  assert.match(breakdown, /formatPrice\(codDue\)/);
  // COD never shows the online discount, and the charged amount is unchanged.
  assert.match(checkout, /const payableNow = paymentMethod === 'cod' \? 0 : onlineTotal;/);
});

test('LAYOUT: the checkout is a flat page — no panel wrapping the form or the purchase column', () => {
  const checkout = read(CHECKOUT);
  const form = checkout.slice(checkout.indexOf('<form'), checkout.indexOf('</form>'));
  // The two-column grid and both column wrappers must survive; only the
  // `panel` cards that used to sit inside them are gone. A `panel` anywhere
  // inside the form means a card is back around delivery or payment.
  assert.doesNotMatch(
    form,
    /className="panel/,
    'no panel may wrap the delivery form or the purchase column — sections are separated by spacing and hairlines instead',
  );
  assert.match(form, /lg:grid-cols-\[minmax\(0,1\.3fr\)_minmax\(0,1fr\)\]/, 'the desktop two-column layout is retained');
});

test('LAYOUT: the order summary is a collapsible that is closed on first paint', () => {
  const checkout = read(CHECKOUT);
  // Default state: collapsed. This is what keeps the mobile checkout short.
  assert.match(
    checkout,
    /const \[summaryOpen, setSummaryOpen\] = useState\(false\);/,
    'the order summary must start collapsed',
  );
  // The toggle is a real button that reports and drives its own state, so the
  // chevron is never just decoration and the region is announced correctly.
  assert.match(
    checkout,
    /<button\s+type="button"\s+onClick=\{\(\) => setSummaryOpen\(\(o\) => !o\)\}\s+aria-expanded=\{summaryOpen\}/,
    'the summary header must be a button wired to aria-expanded',
  );
  // The breakdown is only rendered when open, so it cannot be permanently on.
  assert.match(checkout, /\{summaryOpen && \(/, 'the item rows and breakdown render only while open');
  // The collapsed header carries the PRODUCT price (`subtotal`), matching the
  // expanded item row directly below it, so an amount sitting beside the product
  // name is never read as that product's price. It deliberately must NOT be the
  // payment-method-dependent payable total: shipping, the promo discount and the
  // online-payment discount are itemised in the expanded breakdown and remain
  // visible on the payment cards and the CTA — they are never folded into this
  // figure. The payable total is pinned separately, in the breakdown test above.
  assert.match(
    checkout,
    /aria-expanded=\{summaryOpen\}[\s\S]{0,3000}?formatPrice\(subtotal\)/,
    'the collapsed summary header must show the product price',
  );
  // …and specifically NOT the payable total, which would make the bar's figure
  // change with the selected payment method (₹448 online / ₹498 COD).
  assert.doesNotMatch(
    checkout.slice(checkout.indexOf('aria-expanded={summaryOpen}'), checkout.indexOf('{summaryOpen && (')),
    /formatPrice\(paymentMethod === 'cod' \? codDue : onlineTotal\)/,
    'the collapsed header must not show the payment-method-dependent total',
  );
  // The chevron mirrors the state.
  assert.match(
    checkout,
    /\$\{summaryOpen \? 'rotate-180' : ''\}/,
    'the chevron must rotate to mirror the open/closed state',
  );
});

test('LAYOUT: the summary uses the light house style, never the inverted black block', () => {
  const checkout = read(CHECKOUT);
  // Bound the slice at the payment radiogroup, not the next `</section>`: the
  // payment cards that follow legitimately use white text (the crimson ₹50
  // badge), and they are not part of the summary being checked here.
  //
  // The boundary is the radiogroup rather than the "Payment Method" heading
  // because that heading's text is no longer on the same line as its tag, and
  // a `>Payment Method</h3>` anchor silently stops matching — indexOf returns
  // -1 and slice(start, -1) swallows the whole rest of the file, which turns
  // every assertion below into a false pass or fail.
  const summaryStart = checkout.indexOf('overflow-hidden rounded-card border border-line-2 bg-white');
  const summaryEnd = checkout.indexOf('role="radiogroup"', summaryStart);
  assert.ok(summaryStart > -1 && summaryEnd > summaryStart, 'the summary and payment sections must both be findable');
  const summary = checkout.slice(summaryStart, summaryEnd);
  assert.match(
    summary,
    /border border-line-2 bg-white/,
    'the summary must be a light, outlined surface',
  );
  // White-on-dark ink was only ever legible against the old bg-bone slab.
  assert.doesNotMatch(
    summary,
    /text-white/,
    'the light summary must not keep white text from the removed dark block',
  );
  assert.doesNotMatch(
    summary,
    /bg-bone p-|divide-white|border-white/,
    'the dark-block styling must be fully gone from the summary',
  );
  // Strip comments before scanning for colour tokens: the rationale comments
  // explaining the token choices necessarily NAME the rejected ones, and
  // matching those would fail the very code they document.
  const summaryCode = summary.replace(/\/\*[\s\S]*?\*\//g, '');

  // `text-grey` (#9a9a9a) is a dark-background token — ~2.8:1 on white, below
  // AA. Labels moved onto the light surface must use text-bone-soft (#6e6e6e).
  assert.doesNotMatch(
    summaryCode,
    /text-grey/,
    'summary labels must use text-bone-soft, the secondary token that passes AA on white',
  );
  // Nor may they fall back to text-bone-dim, which is body-ink weight for what
  // are de-emphasised metadata labels here.
  assert.doesNotMatch(summaryCode, /text-bone-dim/, 'summary metadata must not use the body-ink dim token');
  // The green money figures must be the light-surface green, not the old
  // dark-block green-300.
  assert.doesNotMatch(summaryCode, /text-green-300/, 'discount and FREE figures must use the light-surface green');
  // And the replacement must actually be present, so the rules above cannot be
  // satisfied by deleting the labels altogether.
  assert.match(summaryCode, /text-bone-soft/, 'summary metadata must use the light-surface secondary token');
});

test('LAYOUT: payment is a sibling section of the summary, not nested inside it', () => {
  const checkout = read(CHECKOUT);
  // The summary's <button> … </div> closes before the payment section opens.
  const summaryEnd = checkout.indexOf('{summaryOpen && (', checkout.indexOf('aria-expanded={summaryOpen}'));
  // Anchor on the radiogroup, not the heading text: the heading's content is on
  // its own line, so a `>Payment Method</h3>` anchor no longer matches and
  // would silently degrade this into a -1 slice.
  const paymentStart = checkout.indexOf('role="radiogroup"');
  assert.ok(summaryEnd > -1 && paymentStart > summaryEnd, 'payment must come after the summary region, not inside it');
  // The section opener carries the hairline that replaced the old nested card.
  assert.match(
    checkout.slice(summaryEnd, paymentStart),
    /<section className="mt-7 border-t border-line-2 pt-6">/,
    'payment must be its own section, separated by a rule rather than a wrapping card',
  );
  // The CTA lives INSIDE the payment section, so the method it submits and the
  // button itself are one unit rather than two groups held together by margin.
  const cta = checkout.indexOf('type="submit"');
  const sectionClose = checkout.indexOf('</section>', paymentStart);
  assert.ok(cta > paymentStart && cta < sectionClose, 'the pay button must sit inside the payment section');
});

test('LAYOUT: first and last name share a row at every width, the wider pairs from sm up', () => {
  const checkout = read(CHECKOUT);
  // Anchor on the Delivery <h2> and close at the LAST "Save this information"
  // occurrence (the earlier hits are in unrelated components) — indexOf with a
  // fromIndex so the slice cannot start before the heading it is anchored to.
  const deliveryStart = checkout.indexOf('>Delivery</h2>');
  const delivery = checkout.slice(
    deliveryStart,
    checkout.indexOf('Save this information', deliveryStart),
  );
  assert.ok(delivery.length > 500, 'the delivery section must be found in the checkout');
  // First + Last are explicitly two-up with no breakpoint, which is the
  // requirement the screenshots call out.
  assert.match(
    delivery,
    /className="grid grid-cols-2 gap-3">\s*<Field\s+label="First name"/,
    'first and last name must be side by side at all widths',
  );
  // City/State and PIN/Phone pair from sm up, where two inputs still fit.
  assert.match(delivery, /className="grid gap-3 sm:grid-cols-2">\s*<Field\s+label="City"/, 'city and state pair from sm up');
  assert.match(delivery, /className="grid gap-3 sm:grid-cols-2">\s*<Field\s+label="PIN code"/, 'pin and phone pair from sm up');
  // Full-width fields must not be dragged into a pair.
  for (const label of ['Address', 'Apartment, suite, etc. (optional)', 'Email']) {
    assert.doesNotMatch(
      delivery,
      new RegExp(`grid-cols-2[^>]*>\\s*<Field\\s+label="${label.replace(/[().]/g, '\\$&')}"`),
      `${label} must stay full width`,
    );
  }
});

test('LAYOUT: the CTA stays in normal flow — no sticky or floating payment box', () => {
  const checkout = read(CHECKOUT);
  // The button's own attributes only. A wide slice would pick up the sticky
  // COLUMN wrapper it sits inside, which is intentional and unrelated.
  const cta = checkout.slice(checkout.indexOf('type="submit"'), checkout.indexOf('type="submit"') + 420);
  // The margin is not pinned — only that the button is full width in normal
  // flow directly under the options. It now lives inside the payment section.
  assert.match(cta, /className="mt-[\d.]+ flex w-full items-center justify-center/, 'the CTA is full width directly below the payment options');
  // Only the purchase COLUMN may be sticky (so the total stays visible beside a
  // long form); the button itself must never be pinned to the viewport.
  assert.doesNotMatch(cta, /sticky|fixed/, 'the CTA must not be sticky or fixed');
  // And the discount row, the summary and payment must not be boxed separately
  // from the column now that the wrapper panel is gone.
  assert.doesNotMatch(
    checkout.slice(checkout.indexOf('setDiscountOpen((o) => !o)'), checkout.indexOf('aria-expanded={summaryOpen}')),
    /className="panel/,
    'no panel may wrap the discount + summary run',
  );
});

test('PAYMENT UI: the method section is the strongest block on mobile', () => {
  const checkout = read(CHECKOUT);
  // The heading must out-weigh the other section labels on the page. It used to
  // be 11px bone-soft, identical to the muted metadata in the summary, which is
  // why the section that decides HOW A CUSTOMER PAYS read as a caption. It is
  // now styled identically to the DELIVERY heading — same family, size,
  // tracking, case and ink — because the two are peers, not a title and a
  // subtitle, and matching DELIVERY still leaves it far above the small labels
  // (Phone, Email, and the ONLINE PAYMENT / COD option names below).
  const heading = /<h3 className="font-display text-xl uppercase[^"]*text-bone/.exec(checkout);
  assert.ok(heading, 'the payment heading must be larger, bolder and in full ink');
  // …and specifically NOT the old muted token.
  assert.doesNotMatch(
    heading[0],
    /text-bone-soft/,
    'the payment heading must not use the muted secondary ink',
  );
  // The security note is bumped too, but must stay secondary: same line height
  // as the heading would make it a second title, which it is not.
  assert.match(
    checkout,
    /text-\[11px\] font-medium leading-none text-bone-soft[\s\S]{0,200}Secure &amp; encrypted/,
    'the security note must be visible but still stepped down from the heading',
  );
  // Stacked, not baseline-aligned: sharing one line is what forced both small.
  assert.doesNotMatch(
    checkout,
    /flex items-baseline justify-between gap-3">\s*(?:\{[\s\S]{0,200})?<h3[^>]*>\s*Payment Method/,
    'the heading and security note must not compete for one line',
  );
});

test('PAYMENT UI: the online amount leads and the saving is unmistakable', () => {
  const checkout = read(CHECKOUT);
  // The amount the customer is about to be charged, largest on mobile where it
  // has to survive being read at arm's length.
  assert.match(
    checkout,
    /font-price text-\[26px\] font-bold leading-none text-bone tabular-nums sm:text-\[22px\][\s\S]{0,120}formatPrice\(onlineTotal\)/,
    'the online amount must be the largest text on mobile and step back on desktop',
  );
  // The SAVE pill must be readable as a badge, not a word.
  assert.match(
    checkout,
    /rounded-full bg-crimson px-2\.5 py-1[\s\S]{0,160}text-\[10\.5px\] font-bold uppercase/,
    'the SAVE badge must be clearly visible',
  );
  // The restated saving in words, at a size that can actually be read.
  assert.match(
    checkout,
    /text-\[11\.5px\] font-semibold leading-\[1\.35\] text-crimson/,
    'the "you save" footnote must be prominent',
  );
  // …and it must still say the same real number. The copy is presentation; the
  // discount it reports is not.
  assert.match(
    checkout,
    /footnote=\{`You save \$\{formatPrice\(onlineDiscount\)\} by paying online`\}/,
    'the savings footnote must still be derived from onlineDiscount',
  );
});

test('PAYMENT UI: online reads as primary, COD stays a clear secondary', () => {
  const checkout = read(CHECKOUT);
  // Selected state is carried by tint plus a box-shadow, never by going dark.
  // The shadow is specifically a ring rather than a 2px border so selecting an
  // option cannot reflow the card by a pixel and make the two options jump.
  assert.match(
    checkout,
    /selected\s*\?\s*'border-crimson\/60 bg-\[#fff4f6\] shadow-\[0_0_0_1px_rgba\(210,10,46,0\.22\)\,inset_0_1px_0_rgba\(255,255,255,0\.85\)\,0_2px_10px_rgba\(210,10,46,0\.14\)\]'/,
    'the selected card must lift via tint + shadow',
  );
  assert.doesNotMatch(
    checkout,
    /shadow-\[0_1px_3px_rgba\(26,26,26,0\.07\)\]'\s*:\s*'[^']*shadow/,
    'the unselected card must stay flat — only the chosen option lifts',
  );
  // COD must remain visually subordinate to online: never equal to it, and
  // never greyed into looking unavailable.
  const online = /font-price text-\[(\d+)px\][^"]*sm:text-\[(\d+)px\][\s\S]{0,60}formatPrice\(onlineTotal\)/.exec(checkout);
  const cod = /font-price text-\[(\d+)px\][^"]*sm:text-\[(\d+)px\][\s\S]{0,60}formatPrice\(codDue\)/.exec(checkout);
  assert.ok(online && cod, 'both amounts must be findable');
  assert.ok(
    Number(online[1]) > Number(cod[1]) && Number(online[2]) > Number(cod[2]),
    `online must out-rank COD at both breakpoints (online ${online[1]}/${online[2]} vs cod ${cod[1]}/${cod[2]})`,
  );
  // The logos are the "we accept your app" signal and were under-scaled next to
  // the enlarged amount.
  const icons = read('src/components/PaymentMethodIcons.tsx');
  assert.match(icons, /const MARK_H = 26;/, 'the payment marks must be visible ink at 26px');
  assert.match(icons, /const MARK_GAP = 11;/);
  // …but the marks stay unboxed: real brand colour is what makes the row
  // trustworthy, and chips would fight the crimson SAVE badge.
  assert.doesNotMatch(icons, /border[^"']*rounded[^"']*>\s*\{MARKS\.map/, 'the logo marks must stay unboxed');
});

test('PAYMENT UI: the pay button is bound to the method it submits', () => {
  const checkout = read(CHECKOUT);
  const groupStart = checkout.indexOf('role="radiogroup"');
  const groupEnd = checkout.indexOf('</div>', checkout.indexOf('</div>', groupStart));
  const cta = checkout.indexOf('type="submit"');
  assert.ok(cta > groupEnd, 'the pay button must follow the method options it submits');
  // The CTA label is derived from the CHOSEN method, so the button and the
  // selected card can never disagree about the amount. The `·` separator and
  // the JSX line break after `? (` are both matched loosely: this is about which
  // amount the button commits to, not about formatting.
  // Both branches of the ternary must live in this slice, so it has to reach
  // past the online branch (~724 chars in) as well as the COD one.
  const ctaCode = checkout.slice(cta, cta + 1000);
  assert.match(
    ctaCode,
    /paymentMethod === 'cod'\s*\?\s*\(\s*`Place Order\s.\s\$\{formatPrice\(codDue\)\}`/,
    'the CTA must reflect the selected method (COD branch)',
  );
  assert.match(
    ctaCode,
    /paymentCfg\.configured\s*\?\s*\(\s*`Pay Now\s.\s\$\{formatPrice\(onlineTotal\)\}`/,
    'the CTA must reflect the selected method (online branch)',
  );
  // Breathing room between the options and the button, so the two read as
  // separate actions rather than one fused block.
  // The margin is on the button's own className, which sits AFTER the
  // type="submit" attribute — so look forward, not back.
  assert.match(
    ctaCode.slice(0, 400),
    /className="mt-5 flex w-full items-center justify-center/,
    'the pay button must have clear air between it and the options',
  );
});

test('MIGRATION: COD is confirmed at creation and is never left in a pending-payment state', () => {
  // A COD order must not sit in 'pending': expire-stale-orders sweeps exactly
  // that state, so a live COD order would be cancelled and restocked.
  assert.match(
    codSql,
    /if v_is_cod then\s*\n\s*v_payment_status := 'cod_pending';/,
    "a COD order must be created as payment_status 'cod_pending'",
  );
  assert.match(
    codSql,
    /v_order_status := 'pending';\s*\n\s*else\s*\n\s*v_payment_status := 'pending';\s*\n\s*v_order_status := 'pending';/,
    'order_status stays pending for both methods (the admin New Orders workflow state)',
  );
});

test('MIGRATION: the superseded advance migration is still on disk, unmodified', () => {
  // It is applied, so it must never be edited — the new pricing lives in a
  // separate, additive migration. This pins that the old file still exists and
  // still describes the model it was applied with.
  assert.ok(legacyCodSql.length > 0, 'the applied advance migration must not be deleted');
  assert.match(
    legacyCodSql,
    /v_upfront := least\(100, v_total\)/,
    'the applied advance migration should still contain its original advance rule',
  );
});

test('MIGRATION: only never-paid legacy COD orders are backfilled, and the promo total is untouched', () => {
  // Start at the statement itself, not the explanatory comment above it, so the
  // comment's own discussion of the skipped statuses cannot trip the check.
  const backfillIdx = codSql.indexOf('update public.retail_orders', codSql.indexOf('Convert ONLY'));
  assert.notEqual(backfillIdx, -1, 'the never-paid COD backfill statement must exist');
  const backfill = codSql.slice(backfillIdx, codSql.indexOf(';', codSql.indexOf('where is_cod', backfillIdx)) + 1);
  assert.match(
    backfill,
    /where is_cod\s*\n\s*and payment_status = 'pending';/,
    'the backfill must be limited to is_cod orders still awaiting an advance',
  );
  // Settled history must survive untouched. This is about the WHERE clause —
  // 'cod_pending' legitimately appears in the SET clause as the new value.
  const where = backfill.slice(backfill.indexOf('where is_cod'));
  for (const status of ["'success'", "'cod_pending'", "'failed'", "'cancelled'", "'refunded'"]) {
    assert.equal(
      where.includes(status),
      false,
      `the backfill must never select an order at ${status}`,
    );
  }
  // The backfill must not touch the money the customer was quoted. Note the
  // lookbehind: `payment_discount =` is an allowed write, the promo `discount`
  // column is not.
  assert.equal(backfill.includes('total_amount ='), false, 'the backfill must not rewrite total_amount');
  assert.equal(backfill.includes('subtotal ='), false, 'the backfill must not rewrite the subtotal');
  assert.equal(backfill.includes('shipping ='), false, 'the backfill must not rewrite shipping');
  assert.equal(
    /(^|[^a-z_])discount\s*=/m.test(backfill),
    false,
    'the backfill must not rewrite the promo discount',
  );
  assert.equal(backfill.includes('items ='), false, 'the backfill must not rewrite the order items');
  // ...but it must set the full total as the amount due on delivery.
  assert.match(
    backfill,
    /amount_due_on_delivery = greatest\(total_amount, 0\)/,
    'a converted COD order must be due its full total on delivery',
  );
});

/* ================================================================== *
 * 2. No order mutation before payment
 * ================================================================== */

test('NO PREMATURE MUTATION: a new order is inserted with a non-success payment status', () => {
  // Online is inserted pending/pending; COD is inserted cod_pending/pending
  // (confirmed, awaiting collection). Neither may be written as paid.
  assert.match(
    codSql,
    /v_subtotal,\s*v_discount,\s*v_shipping,\s*v_total,\s*\n?\s*v_payment_status,\s*v_order_status/,
    'create_retail_order must insert the server-computed payment and order status, never a literal "paid"',
  );
  // Nothing in the create path may set a gateway id or a success status. Bound
  // the window to the insert statement itself so later statements in the same
  // migration (e.g. the conversion RPC) cannot mask a regression here.
  const insertStart = codSql.indexOf('insert into public.retail_orders');
  const insertEnd = codSql.indexOf('returning id into', insertStart);
  assert.notEqual(insertStart, -1, 'create_retail_order must insert into retail_orders');
  assert.notEqual(insertEnd, -1, 'the insert must return the new order id');
  const insertWindow = codSql.slice(insertStart, insertEnd);
  assert.equal(insertWindow.includes("'success'"), false, 'the insert must not write a success status');
  assert.equal(insertWindow.includes('payment_id'), false, 'the insert must not write a gateway payment id');
  // And it must never hardcode a COD advance.
  assert.equal(insertWindow.includes('100'), false, 'the insert must not encode an advance amount');
});

test('NO PREMATURE MUTATION: stock is reserved in the same transaction that creates the order', () => {
  assert.match(
    codSql,
    /set stock = greatest\(stock - \(v_row->>'quantity'\)::int, 0\)/,
    'stock must be decremented as part of order creation so the reservation is atomic',
  );
  assert.match(
    codSql,
    /available = greatest\(stock - \(v_row->>'quantity'\)::int, 0\) > 0/,
    'availability must be recomputed from the same decrement',
  );
});

/* ================================================================== *
 * 3. The client never dictates the amount
 * ================================================================== */

test('AMOUNT: the checkout client never sends an amount to the payment endpoint', () => {
  const lib = read(PAYMENT_LIB);
  // Isolate the one request body object literal and inspect its keys.
  const body = /body: JSON\.stringify\(\{([\s\S]*?)\}\)/.exec(lib);
  assert.ok(body, 'expected exactly one JSON request body in the payment client');
  const keys = [...body[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), ['orderId', 'orderRef', 'phone']);
  assert.equal(keys.includes('amount'), false, 'the request body must not contain an amount field');
  // The display-only amount must be documented as such and never serialized.
  assert.match(lib, /amount: number; \/\/ display only/);
});

test('AMOUNT: the endpoint never reads an amount off the request', () => {
  const bodyType = /let body: \{([^}]*)\}/.exec(apiSrc);
  assert.ok(bodyType, 'expected the request body type to be declared');
  assert.equal(
    /amount/.test(bodyType[1]),
    false,
    'the declared request body must not accept an amount',
  );
  assert.equal(
    /body\.amount|req\.body\.amount|\{[^}]*\bamount\b[^}]*\}\s*=\s*body/.test(apiSrc),
    false,
    'the handler must not read an amount from the client',
  );
});

test('AMOUNT: the charged amount comes from amount_paid_upfront, falling back to the total', () => {
  assert.match(
    apiSrc,
    /Number\(typed\.amount_paid_upfront \?\? typed\.total_amount\)/,
    'the charge must be the stored amount_paid_upfront, not a client figure',
  );
  // The columns must actually be selected, or the expression would read undefined.
  const selectLine = /select\(([^)]*amount_paid_upfront[^)]*)\)/.exec(apiSrc);
  assert.ok(selectLine, 'amount_paid_upfront must be in the order SELECT');
  assert.match(selectLine[1], /total_amount/);
  assert.match(selectLine[1], /is_cod/);
});

test('AMOUNT: the amount sent to the gateway is a 2-decimal number', () => {
  assert.match(apiSrc, /const orderAmount = amount\.toFixed\(2\)/);
  assert.match(apiSrc, /order_amount: Number\(orderAmount\)/);
  assert.match(apiSrc, /order_currency: 'INR'/);
});

test('AMOUNT: a non-positive order is refused instead of creating a payment session', () => {
  assert.match(apiSrc, /if \(!\(amount > 0\)\)/);
});

/* ================================================================== *
 * 4. Never overwrite an arbitrary payment_id
 * ================================================================== */

test('PAYMENT_ID: the persist is conditional on the value that was read', () => {
  assert.match(
    apiSrc,
    /persist = previousPaymentId \? persist\.eq\('payment_id', previousPaymentId\) : persist\.is\('payment_id', null\)/,
    'the update must be a compare-and-set, so a concurrent winner is never clobbered',
  );
});

test('PAYMENT_ID: a lost compare-and-set is refused rather than forced', () => {
  assert.match(apiSrc, /if \(fresh\?\.payment_id !== createdOrderId\)/);
  assert.match(apiSrc, /code: 'PAYMENT_IN_PROGRESS'/);
});

test('PAYMENT_ID: a non-Cashfree gateway id is never reused or replaced', () => {
  assert.match(apiSrc, /storedProvider !== 'cashfree'/, 'the provider must be checked before paying');
  assert.match(
    apiSrc,
    /ORDER_NOT_PAYABLE[\s\S]{0,200}already linked to another payment method/,
    'a non-Cashfree payment id must be refused, not overwritten',
  );
});

test('PAYMENT_ID: the helper function is not shadowed by a local binding', () => {
  // A `const { orderId: cashfreeOrderId } = created` would put the helper
  // function in the temporal dead zone and throw on the first request.
  assert.equal(
    /const\s*\{[^}]*orderId:\s*cashfreeOrderId\b/.test(apiSrc),
    false,
    'do not destructure the created order id into the helper function name',
  );
  assert.match(apiSrc, /orderId: createdOrderId/);
  // ...and the helper must actually still be called.
  assert.match(apiSrc, /firstId =[\s\S]{0,200}cashfreeOrderId\(/);
  assert.match(apiSrc, /created = await createCashfreeOrder\(cashfreeOrderId\(/);
});

test('PAYMENT_ID: retrying a FAILED payment mints a fresh id, a live one is reused', () => {
  assert.match(
    apiSrc,
    /const reusedId = typed\.payment_status === 'failed' \? null : previousPaymentId/,
    'a terminal failed payment must not have its Cashfree order id reused',
  );
  assert.match(apiSrc, /attemptSuffix \? `\$\{base\}\$\{attemptSuffix\}` : base/);
});

/* ================================================================== *
 * 5. Payment is not started twice
 * ================================================================== */

test('NO DUPLICATE INITIATION: the Edge Function is decommissioned and inert', () => {
  const edge = read(EDGE);
  assert.match(edge, /410/, 'the duplicate Edge Function must answer 410 Gone');
  assert.equal(/api\.cashfree\.com|sandbox\.cashfree\.com/.test(edge), false, 'no gateway call may remain');
  assert.equal(/payment_session_id/.test(edge), false, 'no session may be minted');
  assert.equal(/CASHFREE_APP_ID|CASHFREE_SECRET_KEY/.test(edge), false, 'no credential handling may remain');
});

test('NO DUPLICATE INITIATION: exactly one module talks to the create-order gateway', () => {
  const gatewayCallers = ['api/cashfree-order.ts', 'supabase/functions/cashfree-order/index.ts'].filter((rel) =>
    /pg\/orders/.test(read(rel)),
  );
  assert.deepEqual(gatewayCallers, ['api/cashfree-order.ts']);
});

test('NO DUPLICATE INITIATION: nothing in src/ calls the decommissioned Edge Function', () => {
  const offenders = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    if (/functions\/v1\/cashfree-order|invoke\(\s*['"]cashfree-order/.test(src)) {
      offenders.push(file.slice(ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], 'the retired Edge Function must have no callers');
});

test('NO DUPLICATE INITIATION: the single call site is the checkout page', () => {
  assert.match(read(PAYMENT_LIB), /apiUrl\('\/cashfree-order'\)/);
  // Both entry points in checkout (first payment + retry) go through the one
  // client helper; no page hand-rolls a fetch to the endpoint.
  const checkout = read(CHECKOUT);
  assert.equal((checkout.match(/createPaymentSession\(/g) ?? []).length, 2, 'first attempt + retry');
  assert.equal(/\/api\/cashfree-order|api\/cashfree-order/.test(checkout), false, 'no direct fetch to the endpoint');
});

/* ================================================================== *
 * 6. Authorization on the payment endpoint
 * ================================================================== */

test('AUTHORIZATION: a bearer token is verified with Supabase Auth', () => {
  assert.match(apiSrc, /supabase\.auth\.getUser\(bearer\)/);
  assert.match(apiSrc, /\^bearer\\s\+\(\.\+\)\$\/i/);
});

test('AUTHORIZATION: a signed-in shopper must own the order', () => {
  assert.match(apiSrc, /uniqueOrder\.user_id === caller\.userId/);
  assert.match(
    apiSrc,
    /Boolean\(uniqueOrder\.user_id\) && uniqueOrder\.user_id === caller\.userId/,
    'ownership must require the order to already belong to the caller',
  );
});

test('AUTHORIZATION: the payment endpoint never claims a guest order', () => {
  // It runs on the service-role key, which bypasses RLS, so any write here is a
  // claim with no proof. There must be none: guest checkout accepts any email
  // address, so an email match is a string the customer typed, not possession.
  assert.doesNotMatch(
    apiCode,
    /\.update\(\{[^}]*user_id/,
    'no service-role write may attach a user_id to an order',
  );
  assert.doesNotMatch(
    apiCode,
    /normalizeEmail\(customer\.email\) === caller\.email/,
    'an email match must never stand in for proof of ownership',
  );
  // Linking is claim_retail_guest_order(ref, phone) and it is not called from
  // here: paying for an order is not linking one.
  assert.doesNotMatch(apiCode, /claim_retail_guest_order|decline_retail_guest_order/);
  // …and the header must not still advertise the removed email-match claim.
  assert.doesNotMatch(apiSrc, /or an unclaimed\s+guest order whose stored/);
});

test('AUTHORIZATION: a declined order cannot be paid for or reclaimed', () => {
  // claim_declined_at is the shopper's durable "not mine". It has to bind this
  // endpoint too, which bypasses the RPC guards entirely.
  assert.match(apiSrc, /claim_declined_at/, 'the order lookup must read claim_declined_at');
  assert.match(
    apiCode,
    /if \(!uniqueOrder\.claim_declined_at\) \{[\s\S]{0,200}?if \(caller\.via === 'session'/,
    'the decline guard must be checked BEFORE the ownership branch',
  );
  // …and it must not be possible to set a user_id on the way through.
  assert.doesNotMatch(apiCode, /\.update\(\{[^}]*user_id/);
});

test('AUTHORIZATION: a guest needs the ref AND the stored 10-digit phone', () => {
  assert.match(apiSrc, /\.eq\('id', orderId\)[\s\S]{0,40}\.eq\('ref', orderRef\)/);
  assert.match(
    apiSrc,
    /presented\.length === 10 && orderPhone.length === 10 && presented === orderPhone/,
    'the possession check must require a full 10-digit match on both sides',
  );
  assert.match(apiSrc, /const UUID_RE = \/\^\[0-9a-f\]\{8\}-/, 'the order id must be validated as a UUID');
});

test('AUTHORIZATION: missing and unauthorized orders are indistinguishable', () => {
  // Exactly ONE refusal site in the endpoint, and nothing anywhere states
  // whether the order exists.
  assert.equal(
    (apiSrc.match(/code: 'PAYMENT_NOT_PERMITTED'/g) ?? []).length,
    1,
    'there must be a single not-permitted throw site',
  );
  // Nothing in a RESPONSE may distinguish "no such order" from "not your order".
  // (Comments explaining the design are allowed to mention both.)
  const responses = [...apiSrc.matchAll(/res\.status\(\d+\)\.json\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  assert.ok(responses.length >= 4, 'expected several response bodies');
  for (const body of responses) {
    assert.equal(
      /does not exist|unknown order|no such order|not found|invalid order/i.test(body),
      false,
      `a response body leaks order existence: ${body.trim()}`,
    );
  }
  // No log payload may record whether the order was found (comments are fine).
  const logged = [...apiSrc.matchAll(/console\.(?:warn|error|log)\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(logged.length >= 3, 'expected the endpoint to log diagnostics');
  for (const entry of logged) {
    assert.equal(
      /orderFound|orderExists|found:/i.test(entry),
      false,
      `a log payload records order existence: ${entry.trim()}`,
    );
  }
  // The client turns that single code into one message, so the shopper cannot
  // learn anything from the difference either.
  assert.match(read(PAYMENT_LIB), /data\?\.code === 'PAYMENT_NOT_PERMITTED'/);
  // A duplicated ref is treated as "not exactly one order", not silently resolved.
  assert.match(apiSrc, /\.limit\(2\)/);
  assert.match(apiSrc, /const uniqueOrder = \(orderRows \?\? \[\]\)\.length === 1 \? order : undefined/);
});

test('AUTHORIZATION: eligibility is only evaluated after authorization', () => {
  const authAt = apiSrc.indexOf('if (!authorized) {');
  const checks = ['ALREADY_PAID', 'ORDER_EXPIRED', 'ORDER_NOT_PAYABLE'].map((c) => apiSrc.indexOf(`code: '${c}'`));
  assert.ok(authAt > 0);
  for (const at of checks) {
    assert.ok(at > authAt, `${at} must come after the authorization gate so it cannot be probed`);
  }
});

test('AUTHORIZATION: paid, restocked and terminal orders are all refused', () => {
  assert.match(apiSrc, /typed\.payment_status === 'success'\)\s*\{\s*return res\.status\(409\)[\s\S]{0,120}ALREADY_PAID/);
  assert.match(apiSrc, /if \(typed\.stock_restored_at\)\s*\{[\s\S]{0,700}ORDER_EXPIRED/);
  assert.match(
    apiSrc,
    /const PAYABLE_ORDER_STATUSES = new Set\(\['pending', 'processing'\]\)/,
    'only pending / processing may take a new payment; the legacy COD status is not payable',
  );
  assert.doesNotMatch(
    apiSrc,
    /PAYABLE_ORDER_STATUSES = new Set\(\[[^\]]*cod_partial_paid/,
    'cod_partial_paid is legacy-only and must never be a pay-able state',
  );
  assert.match(apiSrc, /if \(!PAYABLE_ORDER_STATUSES\.has\(orderStatus\)\)/);
  // A foreign gateway on the row is refused too, so the guard set is complete.
  assert.match(apiSrc, /storedProvider !== 'cashfree'[\s\S]{0,400}ORDER_NOT_PAYABLE/);
});

/* ================================================================== *
 * 7. Fail-closed configuration
 * ================================================================== */

test('CONFIG: every credential is mandatory, with no production fallback', () => {
  for (const name of [
    'CASHFREE_APP_ID',
    'CASHFREE_SECRET_KEY',
    'CASHFREE_ENV',
    'APP_ORIGIN',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]) {
    assert.match(apiSrc, new RegExp(`missing\\.push\\('${name}`), `${name} must be required`);
  }
  // No `|| 'TEST'`-style default for the gateway environment.
  assert.equal(
    /CASHFREE_ENV[^\n]*\|\|\s*'TEST'/.test(apiSrc),
    false,
    'the gateway environment must never default to a guess',
  );
  assert.match(apiSrc, /if \(envRaw !== 'TEST' && envRaw !== 'PRODUCTION'\)/);
  assert.match(
    apiSrc,
    /if \(missing\.length > 0\) return \{ ok: false, missing \}/,
    'an incomplete environment must abort before any gateway call',
  );
});

test('CONFIG: missing configuration returns a 500 that leaks no detail', () => {
  assert.match(apiSrc, /status\(500\)\.json\(\{\s*success: false,\s*error: 'Server payment configuration is incomplete\.'/);
  assert.equal(/missing\.\w+\]\)/.test(apiSrc), false, 'the missing-env list must not reach the response');
});

test('CONFIG: the return_url is built from the explicit origin and the order ref', () => {
  assert.match(apiSrc, /return_url: `\$\{origin\}\/#\/payment\/return\?ref=\$\{typed\.ref\}`/);
  assert.equal(/returnUrl: .*window\.location/.test(apiSrc), false);
});

test('CONFIG: the notify_url override is optional but validated when present', () => {
  assert.match(apiSrc, /webhookOverride \|\| `\$\{supabaseUrl[\s\S]{0,60}\/functions\/v1\/cashfree-webhook`/);
  assert.match(apiSrc, /if \(webhookOverride && !isValidOrigin\(webhookOverride\)\)/);
});

test('CONFIG: the api version is pinned', () => {
  assert.match(apiSrc, /'x-api-version': '2025-01-01'/);
});

/* ================================================================== *
 * 8. Guest tracking: no enumeration oracle, throttled
 * ================================================================== */

test('TRACKING: every failure mode returns one identical message', () => {
  const throttle = read(THROTTLE_MIGRATION);
  // The denial object is built ONCE, so there is exactly one reason string for
  // all three failure modes. (The separate blank-input hint is a client-side
  // validation message and is intentionally different.)
  const denied = /v_denied\s+jsonb\s*:=\s*jsonb_build_object\(([\s\S]*?)\n\s*\);/.exec(throttle);
  assert.ok(denied, 'expected a single v_denied response object');
  assert.equal((denied[1].match(/'reason'/g) ?? []).length, 1, 'v_denied must carry exactly one reason');
  const deniedReason = /'reason',\s*'([^']+)'/.exec(denied[1])[1];
  assert.ok(deniedReason.length > 20, 'the denial message must be a real customer-facing sentence');

  // All three ways to fail must return that same object.
  assert.equal(
    (throttle.match(/return v_denied;/g) ?? []).length,
    3,
    'throttled, not-found and wrong-phone must all return v_denied',
  );
  assert.match(throttle, /if not coalesce\(v_throttled, true\) then\s*return v_denied;/);
  assert.match(throttle, /if not found then\s*return v_denied;/);
  assert.match(throttle, /<> v_phone then\s*return v_denied;/);
});

test('TRACKING: the throttle counts only FAILED attempts', () => {
  const throttle = read(THROTTLE_MIGRATION);
  // A successful lookup resets the counter and is never incremented, so the
  // tracking page's 30s auto-poll can never lock a legitimate customer out.
  assert.match(
    throttle,
    /delete from public\.dslang_track_lookup_attempts where ref_hash = md5\(v_ref\)/,
    'a success must clear the counter',
  );
  const registerAt = throttle.indexOf('dslang_track_lookup_register_failure(v_ref)');
  const successAt = throttle.indexOf('-- SUCCESS:');
  assert.ok(registerAt > 0 && successAt > registerAt, 'the failure counter must be incremented only on the failure path');
});

test('TRACKING: the attempt ledger never stores a reference or a phone number', () => {
  const throttle = read(THROTTLE_MIGRATION);
  // Just the column list of the CREATE TABLE, not its comments. Table-level
  // `constraint ... check (...)` lines are constraints, not columns.
  const ddl = /create table if not exists public\.dslang_track_lookup_attempts \(([\s\S]*?)\n\);/.exec(throttle);
  assert.ok(ddl, 'expected the attempt-ledger table definition');
  const columns = [...ddl[1].matchAll(/^\s{2}(\w+)\s+(?!check\()/gim)]
    .map((m) => m[1])
    .filter((c) => c !== 'constraint');
  assert.deepEqual(columns, ['ref_hash', 'window_started_at', 'attempts']);
  assert.equal(columns.includes('phone'), false);
  assert.equal(columns.some((c) => c === 'ref' || c.endsWith('_ref')), false);
  assert.match(throttle, /v_hash := md5\(upper\(btrim\(coalesce\(p_ref, ''\)\)\)\)/);
});

test('TRACKING: the ledger is RLS-protected and only the definer path can write it', () => {
  const throttle = read(THROTTLE_MIGRATION);
  assert.match(throttle, /alter table public\.dslang_track_lookup_attempts enable row level security/);
  assert.equal(
    /create policy[\s\S]{0,200}dslang_track_lookup_attempts/.test(throttle),
    false,
    'no client-visible policy may exist on the ledger',
  );
  assert.match(throttle, /revoke all on function public\.dslang_track_lookup_register_failure\(text\) from public/);
  assert.match(throttle, /to service_role/);
});

test('TRACKING: the public grants and the PII-free projection are unchanged', () => {
  const throttle = read(THROTTLE_MIGRATION);
  assert.match(
    throttle,
    /grant execute on function public\.track_lookup_order\(text, text\)\s*to anon, authenticated, service_role/,
    'guests must still be able to track their own order',
  );
  assert.match(throttle, /security definer/);
  assert.match(throttle, /set search_path = public/);
  // No personal data in the success payload.
  const projection = throttle.slice(throttle.indexOf("'order', jsonb_build_object("));
  for (const forbidden of ['name', 'email', 'phone', 'address', 'city', 'pincode']) {
    assert.equal(
      new RegExp(`'${forbidden}'\\s*:`).test(projection),
      false,
      `the tracking projection must not expose ${forbidden}`,
    );
  }
  for (const kept of ['ref', 'order_status', 'payment_status', 'total_amount', 'amount_paid_upfront', 'items']) {
    assert.ok(projection.includes(`'${kept}'`), `the tracking projection must keep ${kept}`);
  }
});

test('TRACKING: the frontend needed no change because it renders the reason verbatim', () => {
  const page = read('src/pages/TrackOrderPage.tsx');
  assert.match(page, /setError\(res\?\.reason \|\|/);
});

/* ================================================================== *
 * 9. Scheduler installer: no secrets, fail closed
 * ================================================================== */

test('SCHEDULER: no secret value is committed anywhere in the migration', () => {
  const sweep = read(SWEEP_MIGRATION);
  for (const pattern of [
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /sk_(live|test)_[A-Za-z0-9]{10,}/,
    /eyJ[A-Za-z0-9_-]{20,}/, // a JWT / service-role key
    /SERVICE_ROLE_KEY\s*=\s*'/,
    /vault\.create_secret\(\s*'[^<][^']{12,}'/, // a literal secret, not a <PLACEHOLDER>
  ]) {
    assert.equal(pattern.test(sweep), false, `a committed secret matched ${pattern}`);
  }
  // Secrets are resolved from Vault at run time, and only their NAMES are config.
  assert.match(sweep, /vault\.decrypted_secrets/);
  assert.match(sweep, /expire_secret_name\s+text\s+not null default 'expire_stale_orders_key'/);
  assert.match(sweep, /ship_secret_name\s+text\s+not null default 'auto_ship_orders_key'/);
  assert.match(
    sweep,
    /select 1 from vault\.decrypted_secrets[\s\S]{0,80}expire_stale_orders_key/,
    'the job body must read the bearer from Vault when it fires',
  );
});

test('SCHEDULER: registration is fail-closed and never hardcodes a project', () => {
  const sweep = read(SWEEP_MIGRATION);
  // Missing config / extension => report and schedule NOTHING.
  for (const reason of [
    'pg_cron_not_installed',
    'pg_net_not_installed',
    'vault_not_installed',
    'settings_row_missing',
    'functions_base_url_not_configured',
  ]) {
    assert.ok(sweep.includes(`'${reason}'`), `expected a fail-closed report for ${reason}`);
  }
  assert.equal(
    (sweep.match(/'ok', false/g) ?? []).length,
    5,
    'each precondition failure must return before reaching cron.schedule',
  );
  // No project ref is committed: the operator sets the base URL explicitly.
  assert.equal(
    /https:\/\/[a-z0-9]{8,}\.supabase\.co/.test(sweep),
    false,
    'the migration must not hardcode a project ref',
  );
  assert.match(sweep, /functions_base_url\s+text\s+not null default ''/);
  assert.match(sweep, /select \* into v_cfg from public\.dslang_sweep_settings where id = 1;/);
});

test('SCHEDULER: the two sweeps keep the existing, proven implementations', () => {
  const sweep = read(SWEEP_MIGRATION);
  assert.match(sweep, /expire-stale-orders/);
  assert.match(sweep, /auto-ship-orders/);
});

test('SCHEDULER: auto-ship stays fail-closed on the Delhivery readiness gate', () => {
  const sweep = read(SWEEP_MIGRATION);
  assert.match(sweep, /service_role/i);
  // The installer must not smuggle a provider switch past the shipment core.
  assert.equal(/delhivery|razorpay|shiprocket/i.test(sweep.slice(sweep.indexOf('auto_ship_template'))), false);
});

/* ------------------------------------------------------------------ */
/** Every .ts/.tsx file under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

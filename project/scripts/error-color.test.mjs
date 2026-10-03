/**
 * Error-state colour lock.
 *
 * The complaint that started this: some errors were rendering in black or grey,
 * so a shopper or a store admin had to read the sentence to discover something
 * had gone wrong. The fix was to route every genuine error through the existing
 * `--color-crimson` token.
 *
 * The hard part is not the recolouring -- it is staying recoloured. A blanket
 * `text-crimson` sweep would also paint success copy, warnings and helper text
 * red, which is how "red means error" quietly becomes "red means nothing". So
 * this file pins BOTH directions:
 *
 *   - every error render site is crimson;
 *   - the neighbouring success / pending / warning / helper text is still neutral.
 *
 * The neutral assertions are the load-bearing half. Without them the positive
 * check passes just as happily against a site where red has been sprayed
 * everywhere.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Every .tsx under src/, so a new page cannot introduce a grey error. */
function tsxFiles(dir = join(ROOT, 'src')) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const CSS = read('src/index.css');
const rel = (f) => relative(join(ROOT, 'src'), f).split('\\').join('/');

test('TOKEN: the error colour is the existing brand red, not a new one', () => {
  // Reusing the token the invalid-field borders and the admin error boxes
  // already use is what keeps this a palette change and not a new brand hue --
  // `palette.test.mjs` separately enforces that crimson is the only saturated
  // colour in the theme, so introducing `--color-error` as a second red would
  // have put the two tests in direct conflict.
  assert.match(CSS, /--color-crimson: #d20a2e/);
  // And it is already the invalid-input colour, so error text and error borders
  // now agree.
  assert.match(CSS, /\.field-focus\.is-invalid:focus-within \{[^}]*border-color: var\(--color-crimson\)/);
});

test('ERROR TEXT: the sites that were rendering errors in black or grey are crimson', () => {
  const sites = [
    // Discount / promo code.
    ['components/CartDrawer.tsx', /promoError && <p className="[^"]*text-crimson/],
    ['pages/CheckoutPage.tsx', /promoError && <p className="[^"]*text-crimson/],
    // Checkout's whole-form error banner (was `text-bone`).
    ['pages/CheckoutPage.tsx', /lg:col-span-2 text-sm text-crimson border border-bone\/25/],
    // Google sign-in failure on the order-confirmation save prompt.
    ['components/SaveDetailsPrompt.tsx', /gError && <p role="alert" className="[^"]*text-crimson/],
    // Load failures.
    ['pages/CollectionPage.tsx', /text-crimson[^>]*>Something went wrong</],
    ['pages/CollectionPage.tsx', /text-sm text-crimson[^>]*>Could not load the collection/],
    ['pages/HomePage.tsx', /text-crimson[^>]*>Couldn't Load Products</],
    ['pages/HomePage.tsx', /text-sm text-crimson[^>]*>The collection failed to load/],
    ['pages/RetailProductPage.tsx', /text-crimson[^>]*>Failed to load product\.</],
    // The "!" that marks the failed PDP load is the icon half of the same
    // signal, so it moves with the sentence rather than staying black.
    ['pages/RetailProductPage.tsx', /text-crimson leading-none">!<\/p>/],
    ['pages/SubscriberDashboard.tsx', /text-crimson[^>]*>Couldn't Load Your Updates</],
    ['pages/SubscriberDashboard.tsx', /text-sm text-crimson[^>]*>\{loadError\}/],
    // Order / account lookups.
    ['pages/TrackOrderPage.tsx', /text-sm text-crimson[^>]*>\{error\}</],
    ['pages/MyOrdersPage.tsx', /text-crimson[^>]*>\{loadError\}/],
    ['pages/admin/PrintDeliveryPage.tsx', /text-sm text-crimson[^>]*>\{error \|\|/],
    // Already-correct sites, pinned so they cannot regress backwards.
    ['components/LoginModal.tsx', /text-xs text-crimson leading-relaxed/],
    ['pages/CheckoutPage.tsx', /text-xs text-crimson" role="alert">\{errorMsg\}/],
    ['pages/admin/OpsUi.tsx', /export function ErrorBox[\s\S]*?text-crimson[\s\S]*?\{message\}/],
  ];
  for (const [file, re] of sites) {
    assert.match(read(`src/${file}`), re, `${file} must render error text in crimson`);
  }
});

test('PAYMENT ERRORS: a failed payment reads as an error, a pending one does not', () => {
  // Both result pages render ONE paragraph for three jobs: progress copy while
  // confirming, the failure reason once known, and a generic "not charged"
  // fallback. The colour is therefore derived from the verdict, because painting
  // the paragraph unconditionally would paint "Still confirming" red too.
  const checkout = read('src/pages/CheckoutPage.tsx');
  const status = read('src/pages/OrderStatusPage.tsx');

  assert.match(checkout, /const noteIsError = Boolean\(errorMsg\) \|\| isFailed/);
  assert.match(
    checkout,
    /\$\{noteIsError \? 'text-crimson' : 'text-grey'\}[\s\S]*?checkingNote \|\| errorMsg/,
  );

  assert.match(status, /const noteIsError = isFailed/);
  assert.match(
    status,
    /const noteIsError = isFailed;[\s\S]*?\$\{noteIsError \? 'text-crimson' : 'text-grey'\}`}>\{note\}/,
  );

  // The failure icon travels with the failure.
  assert.match(status, /isFailed \? \(\s*<XCircle[^>]*text-crimson/);
  assert.match(checkout, /\)\s*:\s*\(\s*<XCircle[^>]*text-crimson/);
});

test('NOT COLOURS: success, pending and warning copy stay neutral', () => {
  // This is the half that stops the fix from becoming a red spray. Each of these
  // sat next to an error we just recoloured, and each must keep its own colour.
  const cases = [
    // Resend confirmation in the auth modal: `role="status"`, so success.
    ['components/LoginModal.tsx', /role="status" aria-live="polite" className="[^"]*text-bone-soft[^"]*">\{resendNotice\}/],
    // Promo applied is a SUCCESS state (green), unlike promoError directly above
    // it, which is the error we just moved to crimson. The two live a few lines
    // apart, so this pair is the clearest proof the fix is not a blanket sweep.
    ['components/CartDrawer.tsx', /text-green-800[^>]*>\s*<Check[^>]*\/> \{promo\.code\} APPLIED/],
    // "Nothing has been charged" reassurance under a failed payment stays
    // neutral -- only the failure reason above it turns red.
    ['pages/OrderStatusPage.tsx', /text-xs text-grey\/70[^>]*>\s*Nothing has been charged/],
    ['pages/CheckoutPage.tsx', /text-xs text-grey\/70[^>]*>\s*Nothing has been charged/],
  ];
  for (const [file, re] of cases) {
    assert.match(read(`src/${file}`), re, `${file} must keep its non-error copy unchanged`);
  }

  // And the promo ERROR that shares that block must not have been left green.
  const drawer = read('src/components/CartDrawer.tsx');
  assert.match(drawer, /promoError && <p className="mt-1\.5 text-xs text-crimson/);
  assert.doesNotMatch(drawer, /promoError[^"]*text-green/);
});

test('AUDIT: no error render site regresses to a neutral text colour', () => {
  // Backstop for anything added after this commit: within a few lines of an
  // error conditional, an element may not be painted a neutral text colour.
  const NEUTRAL = /text-(grey|bone|bone-dim|bone-soft|black|gray)/;
  const CONDITION = /\{\s*[\w.[\]*]*[Ee]rr(or)?[\w.]*\s*&&\s*\(?/;
  const offenders = [];
  for (const file of tsxFiles()) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!CONDITION.test(lines[i])) continue;
      for (let j = i; j < Math.min(i + 4, lines.length); j++) {
        const m = lines[j].match(/className="([^"]*)"/);
        if (m && NEUTRAL.test(m[1])) {
          offenders.push(`${rel(file)}:${j + 1}  ${m[1].slice(0, 90)}`);
          break;
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `error text must not use a neutral colour:\n${offenders.join('\n')}`,
  );
});
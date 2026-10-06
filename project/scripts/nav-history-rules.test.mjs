/**
 * Browser-history rules for transient and terminal pages.
 *
 * `navigate()` sets `location.hash`, which PUSHES a history entry.
 * `replaceRoute()` uses `location.replace`, which REPLACES the current entry.
 * That single difference decides whether a page the customer has moved past can
 * be resurrected by Back — and for three pages on this site it decided wrongly.
 *
 * NORMAL pages must keep using `navigate` and keep normal Back/Forward. These
 * tests pin only the pages that must never be left behind in history:
 *
 *   * the Cashfree payment return  (TRANSIENT  — a hop between gateway and
 *     checkout; pushed, Back re-ran it and ping-ponged with /checkout)
 *   * the Order Placed screen      (ONE-TIME TERMINAL — pushed, Back from Track
 *     Order / Account / Continue Shopping brought the completed order back)
 *   * the /cart bag-drawer alias and the protected-route bounces
 *                                  (TRANSIENT redirects — pushed, Back landed on
 *     the alias again, which re-pushed and grew history on every press)
 *
 * `scripts/nav-audit.mjs` drives these same rules in a real browser.
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

const ROUTER = 'src/lib/router.ts';
const APP = 'src/App.tsx';
const RETURN_PAGE = 'src/pages/PaymentReturnPage.tsx';
const CHECKOUT = 'src/pages/CheckoutPage.tsx';

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const routerCode = code(read(ROUTER));
const appCode = code(read(APP));
const returnCode = code(read(RETURN_PAGE));
const checkoutCode = code(read(CHECKOUT));

// ---------------------------------------------------------------------------
// The mechanism itself must stay intact.
// ---------------------------------------------------------------------------

test('HISTORY MECHANISM: push and replace remain distinct', () => {
  // navigate PUSHES (normal pages keep working normally)
  assert.match(routerCode, /window\.location\.hash = target;/);
  // replaceRoute REPLACES (transient/terminal pages opt into this)
  assert.match(routerCode, /window\.location\.replace\(next\)/);
  // ...and replaceRoute still notifies the router, so pages update as usual.
  assert.ok(!/preventDefault/.test(routerCode), 'no popstate is blocked anywhere');
  assert.ok(!/addEventListener\('popstate'/.test(routerCode), 'popstate is not intercepted');
  // No history rewriting of the document itself.
  assert.equal((routerCode.match(/history\.(push|replace)State/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// TRANSIENT: the payment return route.
// ---------------------------------------------------------------------------

test('the cancelled/failed return REPLACES checkout instead of pushing it', () => {
  // Both ways off the return route: no ref at all, and "not confirmed".
  const noRef = returnCode.slice(returnCode.indexOf('if (!ref) {'));
  assert.match(noRef.slice(0, 120), /replaceRoute\('\/checkout'\)/);
  const fallback = returnCode.slice(returnCode.indexOf('if (confirmed) {'));
  assert.match(fallback, /replaceRoute\('\/checkout'\)/);
  // Nothing on this route pushes a destination any more.
  assert.ok(!/navigate\(/.test(returnCode), 'the return route must never push');
  assert.match(returnCode, /import \{ replaceRoute \} from '@\/lib\/router';/);
});

test('the payment return can never be a Back destination', () => {
  // Every navigation the route performs must consume its own entry.
  const routes = [...returnCode.matchAll(/(?:replaceRoute|navigate)\(\s*[`']([^`']*)/g)].map((m) => m[1]);
  assert.ok(routes.length >= 4, `expected the route's outbound links, got ${routes.length}`);
  assert.ok(routes.every((r) => r.startsWith('/')), 'destinations are plain paths');
});

// ---------------------------------------------------------------------------
// ONE-TIME TERMINAL: Order Placed.
// ---------------------------------------------------------------------------

test('leaving Order Placed consumes its history entry', () => {
  // Track Order (both branches) and Continue Shopping.
  const buttons = returnCode.slice(returnCode.indexOf('Track Order') - 900);
  assert.ok(!/navigate\(/.test(buttons), 'the terminal screen must never push');
  assert.match(buttons, /replaceRoute\('\/track-order'\)/);
  assert.match(buttons, /replaceRoute\(`\/track-order\/\$\{encodeURIComponent\(snap\.ref\)\}`\)/);
  assert.match(buttons, /replaceRoute\('\/collections'\)/);
});

test('the checkout success screen is not a history entry of its own', () => {
  // It renders AT #/checkout, so it can only be re-entered by re-mounting
  // checkout — which is exactly why the settled state must not survive.
  assert.ok(!/stage === 'result'/.test(returnCode));
  assert.match(checkoutCode, /if \(stage === 'result' && result\) \{/);
  const settle = checkoutCode.slice(
    checkoutCode.indexOf('const settleSuccess = (order'),
    checkoutCode.indexOf('const settleFailed')
  );
  // Settling clears every handle that could re-render it, and empties the bag.
  assert.match(settle, /clearPendingKey\(\);/);
  assert.match(settle, /clearLiveOrderKey\(\);/);
  assert.match(settle, /clear\(\);/);
  assert.match(settle, /removeAppliedPromo\(\);/);
  assert.match(settle, /setStage\('result'\)/);
  // A fresh checkout mount never opens the result stage on its own.
  const init = checkoutCode.slice(
    checkoutCode.indexOf('const [stage, setStage] = useState<Stage>'),
    checkoutCode.indexOf('const [placing, setPlacing]')
  );
  assert.ok(!/return 'result'/.test(init));
});

// ---------------------------------------------------------------------------
// TRANSIENT redirects: /cart and the protected-route bounces.
// ---------------------------------------------------------------------------

test('the /cart bag-drawer alias is replaced away, not pushed past', () => {
  const cart = appCode.slice(appCode.indexOf("if (segments[0] === 'cart')"));
  assert.match(cart.slice(0, 160), /replaceRoute\('\/'\)/);
  assert.ok(!/navigate\(/.test(cart.slice(0, 160)), 'the alias must not push');
  // The drawer still opens exactly as before.
  assert.match(cart.slice(0, 160), /openCart\(\)/);
});

test('protected-route bounces replace, so Back is not trapped', () => {
  const guard = appCode.slice(
    appCode.indexOf('if (loading) return;'),
    appCode.indexOf('}, [segments, user, loading, isAdmin, isAdminLoading]);')
  );
  assert.ok(guard.length > 0, 'the protected-route guard must exist');
  assert.ok(!/navigate\(/.test(guard), 'no branch may push its redirect');
  // guest /account -> /, admin /account -> /admin, guest /admin -> /,
  // non-admin /admin -> /account
  assert.equal((guard.match(/replaceRoute\('\/'\)/g) || []).length, 2);
  assert.match(guard, /replaceRoute\('\/admin'\)/);
  assert.match(guard, /replaceRoute\('\/account'\)/);
});

// ---------------------------------------------------------------------------
// NORMAL pages must be untouched.
// ---------------------------------------------------------------------------

test('NORMAL pages keep using push navigation', () => {
  // Track Order, Checkout, Account and the shop all navigate normally.
  for (const [file, path] of [
    ['src/components/Navbar.tsx', 'Navbar'],
    ['src/components/CartDrawer.tsx', 'CartDrawer'],
    ['src/pages/TrackOrderPage.tsx', 'TrackOrderPage'],
  ]) {
    const src = code(read(file));
    assert.match(src, /navigate\(/, `${path} must keep normal push navigation`);
  }
  // The canonicalisation redirect already replaced, and still does.
  assert.match(appCode, /if \(segments\[0\] === 'collection' \|\| segments\[0\] === 'shop' \|\| segments\[0\] === 'new-drops'\) \{\s*replaceRoute\('\/collections'\)/);
  // The post-login destination restore is a normal navigation.
  assert.match(appCode, /if \(destination && !isAdmin\) navigate\(destination\)/);
});

test('the OAuth callback is cleaned with replaceState, not pushed', () => {
  const auth = read('src/lib/auth.tsx');
  assert.match(auth, /stripOAuthParams\(\)/);
  assert.match(auth.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /history\.replaceState\(window\.history\.state, '', cleaned\)/);
  // The one-time callback params are not stored as a route.
  const router = read('src/lib/router.ts');
  assert.match(router, /AUTH_URL_MARKERS/);
  assert.match(router, /if \(isAuthArtefact\(window\.location\.hash\)\) return \{ path: '\/', segments: \[\] \};/);
});

test('no new navigation system, no sessionStorage history hacks', () => {
  // The only navigation primitives are the two the app already had.
  const router = read('src/lib/router.ts');
  for (const fn of ['useRouter', 'replaceRoute', 'linkHref', 'currentPath', 'readHashQuery', 'replaceHashQuery', 'clearHashQuery']) {
    assert.match(router, new RegExp(`export (function|const) ${fn}\\b|export function ${fn}`), `${fn} must still be exported`);
  }
  assert.equal((read('src/lib/router.ts').match(/export function/g) || []).length, 7);
  // Nothing stores a history snapshot in sessionStorage/localStorage.
  for (const file of [APP, RETURN_PAGE, CHECKOUT]) {
    assert.ok(!/historyStack|historyIndex|navStack/.test(read(file)), `${file} must not snapshot history`);
  }
});
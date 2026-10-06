/**
 * DSLANG browser navigation + history audit.
 *
 * Records, for every scenario, the REAL browser history stack (page URLs) and
 * what Back actually lands on, so a terminal/transient state that can be
 * resurrected is observable rather than assumed.
 *
 * Run: node scripts/nav-audit.mjs [--url http://localhost:5199]
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:5199';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'C:/Users/Admin/AppData/Local/Temp/opencode/nav-audit';
fs.mkdirSync(OUT, { recursive: true });

const CART_KEY = 'dslang_retail_cart_v1';
const PRODUCT = '10259500-f655-4ccc-b974-5f165a84a20f';
const COLOR = 'c755ed6c-b8db-4775-a777-693eb0f1f513';

const rows = [];
const consoleErrors = [];

const log = (...a) => console.log(...a);

/** Short label for a URL, for the report. */
function label(u) {
  try {
    const url = new URL(u);
    const hash = url.hash.replace(/^#/, '');
    const q = hash.includes('?') ? '?' + hash.split('?')[1].slice(0, 22) : '';
    const p = (hash.split('?')[0] || '/').replace(/^\//, '') || 'HOME';
    return `/${p}${q}`;
  } catch {
    return String(u).slice(-40);
  }
}

async function seedCart(page, qty = 2) {
  await page.evaluate(
    ([k, p, c, q]) => {
      localStorage.setItem(
        k,
        JSON.stringify([
          {
            productId: p, slug: 'dslang-original', name: 'DSLANG Original - Relaxed Fit T-shirt',
            code: 'DS-ORG-0-3', image: '', colorId: c, color: 'Optic Wash', colorHex: '#000000',
            sizeLabel: 'M', quantity: q, unitPrice: 1299, mrp: 1499, stock: 6, addedAt: Date.now(),
          },
        ])
      );
    },
    [CART_KEY, PRODUCT, COLOR, qty]
  );
}

/** The current page's own hash route, as the app sees it. */
const hashPath = (page) => page.evaluate(() => window.location.hash.replace(/^#/, '').split('?')[0] || '/');

/** Full browser history stack (all same-document + cross-document entries). */
async function stack(page) {
  return page.evaluate(() => window.history.length);
}

async function back(page) {
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(450);
}

async function forward(page) {
  await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(450);
}

/** A visible fingerprint of what is actually rendered. */
async function screen(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const t = (h1?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46);
    const body = (document.body.innerText || '').replace(/\s+/g, ' ');
    const flags = [];
    if (/confirming payment/i.test(body)) flags.push('CONFIRMING_PAYMENT');
    if (/confirming your payment/i.test(body)) flags.push('CONFIRMING_YOUR_PAYMENT');
    if (/still confirming/i.test(body)) flags.push('STILL_CONFIRMING');
    if (/payment pending/i.test(body)) flags.push('PAYMENT_PENDING');
    if (/order placed|thank you|order confirmed/i.test(body)) flags.push('SUCCESS');
    if (/your bag is empty/i.test(body)) flags.push('EMPTY_BAG');
    if (/has expired/i.test(body)) flags.push('EXPIRED');
    if (/couldn't find your order/i.test(body)) flags.push('NOT_FOUND');
    if (/confirm your order/i.test(body)) flags.push('CONFIRM_YOUR_ORDER');
    if (/this page sold out/i.test(body)) flags.push('HTTP_404');
    return { heading: t, flags: [...new Set(flags)].join(',') || '-', hash: location.hash.replace(/^#/, '').split('?')[0] || '/' };
  });
}

function record(n, from, action, expected, actual, pass, note = '') {
  rows.push({ n, from, action, expected, actual, pass, note });
  log(`${pass ? 'PASS' : 'FAIL'}  ${String(n).padStart(2)}  ${from} | ${action}\n        expect ${expected}\n        actual ${actual}${note ? `  (${note})` : ''}`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newPage(ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: ctxOpts.viewport ?? { width: 1366, height: 900 }, ...ctxOpts });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e).slice(0, 160)));
  return { ctx, page };
}

/** Wait until the app itself has moved to `hash` (never race the navigation). */
async function settle(page, hash, ms = 8000) {
  await page
    .waitForFunction((h) => window.location.hash === `#${h}`, hash, { timeout: ms })
    .catch(() => {});
  await page.waitForTimeout(400);
}

const go = async (page, hash) => {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
};
const setHash = async (page, hash) => {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await page.waitForTimeout(600);
};

log('='.repeat(78));
log('NORMAL ROUTES — Back/Forward must behave normally');
log('='.repeat(78));

// ---- T1 Home -> Collection -> Product -> Checkout -> Back
{
  const { ctx, page } = await newPage();
  await go(page, '/');
  await setHash(page, '/collections');
  await setHash(page, `/product/${PRODUCT}`);
  await seedCart(page, 2);
  await setHash(page, '/checkout');
  await back(page);
  const h = await hashPath(page);
  record(1, 'Checkout', 'Back', 'Product page', label(await page.url()), h.startsWith('/product') ? 'PASS' : 'FAIL');
  await forward(page);
  const f = await hashPath(page);
  record(1, 'Checkout', 'Back then Forward', 'Checkout again', label(await page.url()), f === '/checkout' ? 'PASS' : 'FAIL');
  await ctx.close();
}

// ---- T12 Product -> Collection -> Back  /  T13 Collection -> Home -> Back
{
  const { ctx, page } = await newPage();
  await go(page, `/product/${PRODUCT}`);
  await setHash(page, '/collections');
  await back(page);
  const h = await hashPath(page);
  record(12, 'Collection', 'Back', 'Product page', label(await page.url()), h.startsWith('/product') ? 'PASS' : 'FAIL');
  await back(page);
  const h2 = await hashPath(page);
  record(13, 'Collection (from Home)', 'Back', 'Home', label(await page.url()), h2 === '/' ? 'PASS' : 'FAIL');
  await ctx.close();
}

// ---- T2/T3 Checkout -> Cart drawer -> Back
{
  const { ctx, page } = await newPage();
  await go(page, '/');
  await seedCart(page, 2);
  await setHash(page, '/checkout');
  await setHash(page, '/');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('x')));
  // open the bag via the navbar button
  const btn = page.locator('header button, nav button').filter({ hasText: /bag/i }).first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(700); }
  const opened = await page.evaluate(() => /bag|total|checkout/i.test(document.body.innerText));
  await back(page);
  const h = await hashPath(page);
  record(3, 'Checkout -> Cart drawer', 'Back', 'Checkout page', label(await page.url()), h === '/checkout' ? 'PASS' : 'FAIL', `drawerOpen=${opened}`);
  await ctx.close();
}

// ---- T4 Checkout -> Cashfree CANCEL -> Checkout -> Back   (simulated cancel)
{
  const { ctx, page } = await newPage();
  await go(page, '/');
  await seedCart(page, 2);
  // Fill the checkout form + create the pending/live handles exactly as the app
  // does after Pay Now, then simulate Cashfree's cancel redirect.
  await setHash(page, '/checkout');
  await page.evaluate(
    ([p, c]) => {
      const key = 'PENDING_PAYMENT_KEY';
      sessionStorage.setItem(
        'dslang_pending_order_v1',
        JSON.stringify({ ref: 'DSL-R-TESTCANC', order_id: 'o1', amount: 2548, itemsKey: `${p}|${c}|M|2`, at: Date.now(), phone: '9833399999', held: { [`${p}|${c}|M`]: 2 } })
      );
      sessionStorage.setItem(
        'dslang_live_order_v1',
        JSON.stringify({ ref: 'DSL-R-TESTCANC', order_id: 'o1', amount: 2548, itemsKey: `${p}|${c}|M|2`, is_cod: false, held: { [`${p}|${c}|M`]: 2 } })
      );
      sessionStorage.setItem(
        'dslang_checkout_form_v1',
        JSON.stringify({ firstName: 'Test', lastName: 'User', phone: '9833399999', email: 't@e.st', address: '12 Test Road', apartment: '', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', paymentMethod: 'online' })
      );
      void key;
    },
    [PRODUCT, COLOR]
  );
  const before = await stack(page);
  // Cashfree redirects to the return_url: a NEW history entry.
  await setHash(page, '/payment/return?ref=DSL-R-TESTCANC');
  await settle(page, '/checkout'); // the app's own redirect must land first
  const afterCancel = await hashPath(page);
  record(4, 'Cashfree CANCEL', 'Return redirect', 'Checkout restored', label(await page.url()), afterCancel === '/checkout' ? 'PASS' : 'FAIL');
  const sc = await screen(page);
  record(4, 'Cashfree CANCEL return', 'Screen check', 'No confirming/payment-pending/spinner screen', sc.flags, /CONFIRMING|STILL_CONFIRMING|PAYMENT_PENDING/.test(sc.flags) ? 'FAIL' : 'PASS', `heading="${sc.heading}"`);
  const depth = await stack(page);
  await back(page);
  const backTo = await hashPath(page);
  const backScreen = await screen(page);
  const isReturn = backTo.startsWith('/payment/return');
  record(4, 'Checkout (after cancel)', 'Back', 'NOT /payment/return', label(await page.url()), isReturn ? 'FAIL' : 'PASS', `stack ${before}->${depth}->${screen(page).hash}`);
  await shot(page, 't04-after-back');
  if (isReturn) {
    // Record whether it ping-pongs.
    await back(page);
    record(4, '/payment/return (resurrected)', 'Back again', 'no ping-pong loop', label(await page.url()), 'INFO', `backScreen=${backScreen.flags}`);
  }
  await ctx.close();
}

// ---- T5/T6/T7/T8 Order Success -> Track Order / Account / Continue Shopping -> Back
// Checkout's success screen lives AT #/checkout (no URL change), so we assert the
// success screen cannot be re-rendered after leaving.
async function orderSuccessScenario(n, label_, action, expected) {
  const { ctx, page } = await newPage();
  await go(page, '/');
  await seedCart(page, 2);
  await setHash(page, '/checkout');
  // Settle a confirmed success the way settleSuccess does: handles + bag cleared,
  // order result persisted, checkout history recorded.
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.removeItem('dslang_retail_cart_v1');
    localStorage.setItem(
      'dslang_order_result_v1',
      JSON.stringify({
        ref: 'DSL-R-SUCCESS1', phone: '9833399999', at: Date.now(),
        order: {
          ref: 'DSL-R-SUCCESS1', total_qty: 2, subtotal: 2598, discount: 0, shipping: 0,
          total_amount: 2598, payment_status: 'success', order_status: 'processing',
          is_cod: false, payment_discount: 50, amount_paid_upfront: 2548, amount_due_on_delivery: 0,
          items: [{ product_id: 'p', name: 'T', color: 'Optic Wash', size_label: 'M', quantity: 2, line_total: 2598 }],
          customer: { name: 'Test User', phone: '9833399999', address: '12 Test Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
        },
      })
    );
    localStorage.setItem('dslang_checkout_history_v1', JSON.stringify([{ ref: 'DSL-R-SUCCESS1', phone: '9833399999', at: Date.now() }]));
  });
  // Render the success screen (stage=result is set by settleSuccess in-app).
  await setHash(page, '/checkout');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await setHash(page, action);
  await page.waitForTimeout(700);
  await back(page);
  await page.waitForTimeout(600);
  const s = await screen(page);
  const h = await hashPath(page);
  const resurrected = /SUCCESS/.test(s.flags);
  record(n, label_, 'Back after leaving', expected, `${label(await page.url())} flags=${s.flags}`, resurrected ? 'FAIL' : 'PASS', `heading="${s.heading}"`);
  await shot(page, `t${n}-back`);
  await ctx.close();
}

log('');
log('='.repeat(78));
log('ORDER SUCCESS (terminal) — must not be resurrectable by Back');
log('='.repeat(78));
await orderSuccessScenario(5, 'Order Success -> Track Order', '/track-order/DSL-R-SUCCESS1', 'must NOT show Order Success again');
await orderSuccessScenario(6, 'Order Success -> Account', '/account', 'must NOT show Order Success again');
await orderSuccessScenario(7, 'Order Success -> Continue Shopping', '/collections', 'must NOT show Order Success again');
await orderSuccessScenario(8, 'Order Success -> Home', '/', 'must NOT show Order Success again');

log('');
log('='.repeat(78));
log('PAYMENT RETURN (transient) — direct-load + refresh');
log('='.repeat(78));
{
  const { ctx, page } = await newPage();
  await go(page, '/');
  await seedCart(page, 2);
  await setHash(page, '/payment/return?ref=DSL-R-TESTCANC');
  await settle(page, '/checkout');
  const h = await hashPath(page);
  record('4b', '/payment/return direct load', 'Boot', 'redirects to Checkout', label(await page.url()), h === '/checkout' ? 'PASS' : 'FAIL');
  await ctx.close();
}

// ---- T9 Login -> Google -> authenticated -> Back
log('');
log('='.repeat(78));
log('AUTH / OAUTH — callback must not linger as a page');
log('='.repeat(78));
{
  const { ctx, page } = await newPage();
  await go(page, '/collections');
  // Simulate the OAuth return document landing with ?code=...
  await page.goto(`${BASE}/?code=auth-code-123`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const url = await page.url();
  const cleaned = !/code=/.test(url);
  record(9, 'OAuth callback ?code=', 'Return', 'callback params removed via replaceState', url.replace(BASE, '') || '/', cleaned ? 'PASS' : 'FAIL');
  await back(page);
  const s = await screen(page);
  const h = await hashPath(page);
  const isCallback = /code=/.test(page.url());
  record(9, 'after auth', 'Back', 'NOT an OAuth callback / not a 404', label(await page.url()), isCallback ? 'FAIL' : 'PASS', `flags=${s.flags}`);
  await ctx.close();
}

// ---- T10 Track Order -> <normal page> -> Back ; guest /account redirect
{
  const { ctx, page } = await newPage();
  await go(page, '/track-order/DSL-R-XXXX');
  await setHash(page, '/contact');
  await back(page);
  const h = await hashPath(page);
  record(10, 'Track Order -> Contact', 'Back', 'Track Order', label(await page.url()), h.startsWith('/track-order') ? 'PASS' : 'FAIL');
// /account is gated: a guest is bounced to '/'. The bounce must CONSUME the
  // /account entry, so Back returns to Track Order instead of being stuck.
  await setHash(page, '/account');
  await settle(page, '/');
  await back(page);
  const h2 = await hashPath(page);
  record('10b', 'Track Order -> /account (guest)', 'Back', 'Track Order (bounce entry consumed)', label(await page.url()), h2.startsWith('/track-order') ? 'PASS' : 'FAIL', `guestLandedOn=/`);
  // My Orders for a guest.
  await setHash(page, '/track-order/DSL-R-XXXX');
  await setHash(page, '/my-orders');
  await page.waitForTimeout(600);
  await back(page);
  const h3 = await hashPath(page);
  record(11, 'Track Order -> /my-orders', 'Back', 'Track Order (no /my-orders loop)', label(await page.url()), h3.startsWith('/track-order') ? 'PASS' : 'FAIL');
  await ctx.close();
}

// ---- T14 refresh every important normal page
log('');
log('='.repeat(78));
log('REFRESH + DIRECT LOAD of every route');
log('='.repeat(78));
{
  const routes = ['/', '/collections', `/product/${PRODUCT}`, '/checkout', '/track-order', '/contact',
    '/policies', '/terms-and-conditions', '/privacy-policy', '/refund-and-cancellation',
    '/return-policy', '/shipping-policy', '/about', '/collection', '/shop', '/new-drops',
    '/order-status', '/cart', '/nope-not-a-route'];
  for (const r of routes) {
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    await seedCart(page, 2);
    await page.evaluate((h) => { window.location.hash = h; }, r);
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const s = await screen(page);
    const h = await hashPath(page);
    const expected = ['/collection', '/shop', '/new-drops', '/cart'].includes(r) ? '/collections' : null;
    if (/sold out|\b404\b/i.test(s.heading) || /sold out/i.test(s.flags)) {
      // handled below via body flags
    }
    let verdict = 'PASS';
    let note = '';
    const bodyTxt = s.heading;
    void bodyTxt;
    if (r === '/cart') {
      // App opens the bag drawer and lands on '/' — by design (App.tsx).
      verdict = h === '/' ? 'PASS' : 'FAIL';
      note = h === '/' ? 'redirects to / and opens the drawer' : `expected /, got ${h}`;
} else if (r === '/nope-not-a-route') {
      const ok = s.flags.includes('HTTP_404');
      verdict = ok ? 'PASS' : 'FAIL';
      note = ok ? '' : `expected the 404 page, got flags=${s.flags}`;
    } else if (expected) {
      if (h !== expected) { verdict = 'FAIL'; note = `expected canonical ${expected}`; }
    } else if (h !== r) {
      verdict = 'FAIL'; note = `hash drifted to ${h}`;
    }
    record(`R${routes.indexOf(r) + 1}`, r, 'Load + Refresh', expected ?? (r === '/nope-not-a-route' ? 'not-found page' : 'same route'), `${h} "${s.heading}"`, verdict, note);
    await ctx.close();
  }
}

// ---- mobile viewport spot-check of the terminal flows
log('');
log('='.repeat(78));
log('MOBILE (390x844) — terminal + transient flows');
log('='.repeat(78));
{
  const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 } });
  await go(page, '/');
  await seedCart(page, 2);
  await page.evaluate(
    ([p, c]) => {
      sessionStorage.setItem('dslang_pending_order_v1', JSON.stringify({ ref: 'DSL-R-M', order_id: 'o1', amount: 2548, itemsKey: `${p}|${c}|M|2`, at: Date.now(), phone: '9833399999', held: { [`${p}|${c}|M`]: 2 } }));
      sessionStorage.setItem('dslang_live_order_v1', JSON.stringify({ ref: 'DSL-R-M', order_id: 'o1', amount: 2548, itemsKey: `${p}|${c}|M|2`, is_cod: false, held: { [`${p}|${c}|M`]: 2 } }));
      sessionStorage.setItem('dslang_checkout_form_v1', JSON.stringify({ firstName: 'Test', lastName: 'User', phone: '9833399999', email: 't@e.st', address: '12 Test Road', apartment: '', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', paymentMethod: 'online' }));
    },
    [PRODUCT, COLOR]
  );
  await setHash(page, '/checkout');
  await setHash(page, '/payment/return?ref=DSL-R-M');
  await settle(page, '/checkout');
  record('M1', 'mobile Cashfree cancel', 'Return', 'Checkout restored', label(await page.url()), (await hashPath(page)) === '/checkout' ? 'PASS' : 'FAIL');
  await back(page);
  const r = await hashPath(page);
  record('M2', 'mobile Checkout', 'Back', 'NOT /payment/return', label(await page.url()), r.startsWith('/payment/return') ? 'FAIL' : 'PASS');
  await shot(page, 'm-after-back');
  await ctx.close();
}

await browser.close();

log('');
log('='.repeat(78));
log(`RESULT: ${rows.filter((r) => r.pass === 'PASS').length} PASS / ${rows.filter((r) => r.pass === 'FAIL').length} FAIL  (of ${rows.length} checks)`);
log('='.repeat(78));
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ rows, consoleErrors }, null, 2));
if (consoleErrors.length) {
  log('\nCONSOLE ERRORS:');
  [...new Set(consoleErrors)].slice(0, 25).forEach((e) => log('  ' + e));
} else log('\nNo console errors.');
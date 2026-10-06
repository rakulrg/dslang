/**
 * Proves the online-payment timeout fix:
 * the server COMMITS the order (and its reservation) but the response never
 * reaches the browser. The customer must NOT end up with a second order or a
 * second reservation when they press Pay Now again.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = 'http://localhost:5199';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CAT = JSON.parse(fs.readFileSync('C:/Users/Admin/AppData/Local/Temp/opencode/catalog.json', 'utf8'));
let P, C, S;
for (const c of CAT.colors) { const s = CAT.sizes.find((x) => x.product_id === c.product_id && x.color_id === c.id && Number(x.stock) > 0); if (s) { P = CAT.products.find((x) => x.id === c.product_id); C = c; S = s; break; } }
const REF = 'DSL-R-TIMEOUT';
const OUT = 'C:/Users/Admin/AppData/Local/Temp/opencode/journey';

const state = { createCalls: 0, reserved: 0, sessions: 0, stockNow: Number(S.stock) };

const b = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
const J = (x) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
const eq = (v) => (v || '').replace(/^eq\./, '');

page.route('**/storage/v1/object/public/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }));
page.route('**/rest/v1/**', (route) => {
  const u = new URL(route.request().url());
  const path = u.pathname.replace('/rest/v1/', '').split('?')[0];
  const q = u.searchParams;
  const raw = q.get('product_id') || '';
  const m = /^in\.\((.*)\)$/.exec(raw) || /^eq\.(.*)$/.exec(raw);
  const ids = m ? m[1].split(',').map((v) => v.trim()) : [];
  const table = { products: CAT.products, product_colors: CAT.colors, product_sizes: CAT.sizes, size_chart_rows: CAT.charts, hero_slides: CAT.hero }[path];
  if (!table) return route.fulfill(J([]));
  let rows = table;
  if (path === 'products') rows = rows.filter((x) => x.published && x.retail_visible !== false);
  else if (ids.length) rows = rows.filter((x) => ids.includes(x.product_id));
  if (path === 'product_sizes') rows = rows.map((x) => ({ ...x, stock: x.id === S.id ? state.stockNow : x.stock }));
  return route.fulfill(J(rows));
});

page.route('**/rest/v1/rpc/**', async (route) => {
  const fn = route.request().url().split('/rpc/')[1].split('?')[0];
  const body = route.request().postDataJSON() || {};
  if (fn === 'create_retail_order') {
    state.createCalls += 1;
    if (state.createCalls === 1) {
      // The server COMMITS: stock reserved, order written.
      state.reserved += body.p_items[0].quantity;
      state.stockNow -= body.p_items[0].quantity;
      console.log(`   [server] order #${state.createCalls} COMMITTED, stock ${state.stockNow + body.p_items[0].quantity} -> ${state.stockNow}`);
      // ...but the RESPONSE is lost. The browser only sees an aborted fetch.
      await route.abort('timedout');
      return;
    }
    state.reserved += body.p_items[0].quantity;
    state.stockNow -= body.p_items[0].quantity;
    console.log(`   [server] order #${state.createCalls} COMMITTED, stock now ${state.stockNow}`);
    return route.fulfill(J({
      order_id: 'o' + state.createCalls, ref: REF, order_type: 'retail', total_qty: body.p_items[0].quantity,
      subtotal: 649, discount: 0, shipping: 99, total_amount: 748, payment_status: 'pending', order_status: 'pending',
      is_cod: false, payment_discount: 50, amount_paid_upfront: 698, amount_due_on_delivery: 0,
      items: body.p_items.map((i) => ({ ...i, unit_price: 649, line_total: 649 * i.quantity })), customer: body.p_customer,
    }));
  }
  if (fn === 'track_lookup_order') return route.fulfill(J({ ok: false, reason: 'no match' }));
  return route.fulfill(J({ ok: false }));
});

page.route('**/functions/v1/**', (r) => r.fulfill(J({ verified: false, status: 'pending', order: { ref: REF, payment_status: 'pending', stock_restored_at: null } })));
await page.route('**/api/cashfree-order', (route) => {
  state.sessions += 1;
  return route.fulfill(J({ success: true, orderRef: REF, orderId: 'cf' + state.sessions, paymentSessionId: 'sess' + state.sessions, environment: 'TEST' }));
});
await page.route('**/sdk.cashfree.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
  body: "window.Cashfree=function(){return{checkout:function(){return new Promise(function(){});},init:function(){},on:function(){}}};" }));

await page.goto(`${BASE}/#/checkout`, { waitUntil: 'domcontentloaded' });
await page.evaluate(([p, s, n, c, z, up]) => {
  localStorage.setItem('dslang_retail_cart_v1', JSON.stringify([{ productId: p, slug: s, name: n, code: 'C', image: '', colorId: c, color: 'V', colorHex: '#000', sizeLabel: z, quantity: 1, unitPrice: up, stock: 20, addedAt: Date.now() }]));
  sessionStorage.setItem('dslang_checkout_form_v1', JSON.stringify({ firstName: 'Asha', lastName: 'Rao', phone: '9876543210', email: 'a@e.st', address: '22 Carter Road', apartment: '', city: 'Mumbai', state: 'Maharashtra', pincode: '400050', paymentMethod: 'online' }));
}, [P.id, P.slug, 'DSLANG Tee', C.id, S.size_label, P.price]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const err = () => page.evaluate(() => document.querySelector('[role=alert]')?.textContent?.trim().slice(0, 150) || '');

console.log('stock before:', state.stockNow);
console.log('\n--- ATTEMPT 1 (server commits, response lost) ---');
await page.locator('button[type=submit]').last().click();
await page.waitForTimeout(45000);
let msg = await err();
console.log('   inline error shown:', JSON.stringify(msg));
console.log('   raw "Request timed out" leaked to customer?', /Request timed out/i.test(msg));
await page.screenshot({ path: OUT + '/timeout-1.png' });

console.log('\n--- ATTEMPT 2 (customer presses Pay Now again) ---');
await page.locator('button[type=submit]').last().click();
await page.waitForTimeout(12000);
msg = await err();
console.log('   inline error now:', JSON.stringify(msg).slice(0, 120));

console.log('\n================ RESULT ================');
console.log('server create calls        :', state.createCalls, state.createCalls === 1 ? '(PASS - exactly one order)' : '(FAIL - duplicate order)');
console.log('units reserved             :', state.reserved, state.reserved === 1 ? '(PASS - reserved once)' : '(FAIL - double reservation)');
console.log('stock now                  :', state.stockNow, '(was ' + (state.stockNow + state.reserved) + ')');
console.log('cashfree sessions requested:', state.sessions);
console.log('========================================');
await b.close();
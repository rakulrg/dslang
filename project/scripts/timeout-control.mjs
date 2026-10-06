/**
 * The unresolved-create interlock must only ever block when the outcome really
 * is unknown. A DEFINITE server refusal and a normal success must both keep
 * working exactly as before.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const BASE = 'http://localhost:5199';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CAT = JSON.parse(fs.readFileSync('C:/Users/Admin/AppData/Local/Temp/opencode/catalog.json', 'utf8'));
let P, C, S;
for (const c of CAT.colors) { const s = CAT.sizes.find((x) => x.product_id === c.product_id && x.color_id === c.id && Number(x.stock) > 0); if (s) { P = CAT.products.find((x) => x.id === c.product_id); C = c; S = s; break; } }
const REF = 'DSL-R-T2';
const J = (x) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
const eq = (v) => (v || '').replace(/^eq\./, '');

async function run(label, mode, stock) {
  const state = { calls: 0, reserved: 0 };
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
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
    if (path === 'product_sizes') rows = rows.map((x) => ({ ...x, stock: x.id === S.id ? stock - state.reserved : x.stock }));
    return route.fulfill(J(rows));
  });
  page.route('**/rest/v1/rpc/**', async (route) => {
    const fn = route.request().url().split('/rpc/')[1].split('?')[0];
    const body = route.request().postDataJSON() || {};
    if (fn === 'create_retail_order') {
      state.calls += 1;
      if (mode === 'definite') {
        return route.fulfill({ status: 400, contentType: 'application/json',
          body: JSON.stringify({ code: 'P0001', message: 'Only 0 left in Optic Wash / M for "DSLANG Tee".' }) });
      }
      state.reserved += body.p_items[0].quantity;
      return route.fulfill(J({ order_id: 'o' + state.calls, ref: REF, order_type: 'retail', total_qty: 1,
        subtotal: 649, discount: 0, shipping: 99, total_amount: 748, payment_status: 'pending', order_status: 'pending',
        is_cod: false, payment_discount: 50, amount_paid_upfront: 698, amount_due_on_delivery: 0,
        items: body.p_items.map((i) => ({ ...i, unit_price: 649, line_total: 649 })), customer: body.p_customer }));
    }
    return route.fulfill(J({ ok: false }));
  });
  await page.route('**/functions/v1/**', (r) => r.fulfill(J({ verified: false, status: 'pending', order: null })));
  await page.route('**/api/cashfree-order', (r) => r.fulfill(J({ success: true, orderRef: REF, orderId: 'cf1', paymentSessionId: 's1', environment: 'TEST' })));
  await page.route('**/sdk.cashfree.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: "window.Cashfree=function(){return{checkout:function(){return new Promise(function(){});},init:function(){},on:function(){}}};" }));

  await page.goto(`${BASE}/#/checkout`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([p, s, n, c, z, up]) => {
    localStorage.setItem('dslang_retail_cart_v1', JSON.stringify([{ productId: p, slug: s, name: n, code: 'C', image: '', colorId: c, color: 'V', colorHex: '#000', sizeLabel: z, quantity: 1, unitPrice: up, stock: 20, addedAt: Date.now() }]));
    sessionStorage.setItem('dslang_checkout_form_v1', JSON.stringify({ firstName: 'Asha', lastName: 'Rao', phone: '9876543210', email: 'a@e.st', address: '22 Carter Road', apartment: '', city: 'Mumbai', state: 'Maharashtra', pincode: '400050', paymentMethod: 'online' }));
  }, [P.id, P.slug, 'DSLANG Tee', C.id, S.size_label, P.price]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  const err = () => page.evaluate(() => document.querySelector('[role=alert]')?.textContent?.trim().slice(0, 90) || '(no error)');
  await page.locator('button[type=submit]').last().click();
  await page.waitForTimeout(mode === 'definite' ? 6000 : 9000);
  const first = await err();
  console.log(`\n[${label}] attempt 1 -> calls=${state.calls} reserved=${state.reserved}`);
  console.log(`[${label}] message: ${JSON.stringify(first)}`);

  await page.locator('button[type=submit]').last().click();
  await page.waitForTimeout(mode === 'definite' ? 6000 : 9000);
  const second = await err();
  console.log(`[${label}] attempt 2 -> calls=${state.calls} reserved=${state.reserved}`);
  console.log(`[${label}] message: ${JSON.stringify(second)}`);
  console.log(`[${label}] blocked by interlock? ${/previous attempt is still being sorted out/.test(second)}`);
  await b.close();
  return { calls: state.calls, reserved: state.reserved, second };
}

const d = await run('DEFINITE refusal (400)', 'definite', 2);
console.log('\n=> definite refusal is RETRYABLE and shows the server reason:', d.calls === 2 && !/previous attempt/.test(d.second));
const s = await run('NORMAL success', 'success', 2);
console.log('=> success path unaffected:', s.calls === 1 && s.reserved === 1);
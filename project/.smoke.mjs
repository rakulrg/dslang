import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'https://dslang.in';
const SHOT_DIR = 'C:/Users/Admin/AppData/Local/Temp/opencode/smoke';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const LOG = [];
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const ts = new Date().toISOString().slice(11, 23);
  LOG.push(`[${ts}] ${line}`);
  console.log(line);
}
function dump(name, content) {
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.html`), String(content ?? ''));
}

const CART_KEY = 'dslang_retail_cart_v1';
const CART_ITEM = {
  productId: '10259500-f655-4ccc-b974-5f165a84a20f',
  slug: 'dslang-original',
  name: 'DSLANG Original - Relaxed Fit T-shirt - Optic Wash',
  code: 'DS-ORG-0-3',
  image: 'https://fryxswzrpqujivtbguim.supabase.co/storage/v1/object/public/product-images/10259500-f655-4ccc-b974-5f165a84a20f-black-a72e1ae4-c704-4d9f-ba16-0bf5b0974dab.webp',
  colorId: 'c755ed6c-b8db-4775-a777-693eb0f1f513',
  color: 'Black',
  colorHex: '#000000',
  sizeLabel: 'M',
  quantity: 1,
  unitPrice: 399,
  mrp: 499,
  stock: 6,
  addedAt: Date.now(),
};
const FORM = {
  firstName: 'Test',
  lastName: 'User',
  phone: '9833399999',
  email: 'test@dslang.in',
  address: '12 Test Road',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400001',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gotoRetry(page, url, label) {
  for (let i = 1; i <= 4; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return;
    } catch (e) {
      log(`${label}: goto attempt ${i} failed: ${String(e).slice(0, 120)}`);
      await sleep(4000 * i);
    }
  }
  throw new Error(`goto failed after retries: ${url}`);
}

async function setupCart(page, clearKeys = true) {
  await page.evaluate(
    ({ cart, clearKeys }) => {
      localStorage.setItem('dslang_retail_cart_v1', JSON.stringify([cart]));
      if (clearKeys) {
        try { sessionStorage.removeItem('dslang_pending_order_v1'); } catch {}
        try { sessionStorage.removeItem('dslang_live_order_v1'); } catch {}
        try { sessionStorage.removeItem('dslang_checkout_form_v1'); } catch {}
        try { localStorage.removeItem('dslang_promo_v1'); } catch {}
        try { localStorage.removeItem('dslang_order_result_v1'); } catch {}
      }
    },
    { cart: CART_ITEM, clearKeys }
  );
}

async function fillCheckout(page) {
  await page.waitForSelector('input[autocomplete="given-name"]', { timeout: 30000 });
  const set = async (sel, val) => {
    const el = page.locator(sel).first();
    if ((await el.count()) === 0) return;
    const tag = await el.evaluate((n) => n.tagName).catch(() => '');
    if (tag === 'SELECT') {
      await el.selectOption({ label: String(val) });
    } else {
      await el.fill(String(val));
    }
  };
  await set('input[autocomplete="given-name"]', FORM.firstName);
  await set('input[autocomplete="family-name"]', FORM.lastName);
  await set('input[autocomplete="tel"]', FORM.phone);
  await set('input[autocomplete="email"]', FORM.email);
  await set('input[autocomplete="street-address"]', FORM.address);
  await set('input[autocomplete="address-level2"]', FORM.city);
  await set('select[autocomplete="address-level1"]', FORM.state);
  await set('input[autocomplete="postal-code"]', FORM.pincode);
}

async function payNowAndMeasure(page, label) {
  const btn = page.getByRole('button', { name: /^Pay Now/ }).first();
  await btn.waitFor({ state: 'visible', timeout: 30000 });
  const t0 = Date.now();
  await btn.click();
  let deltaMs = -1;
  let target = null;
  try {
    await page.waitForURL(/cashfree/i, { timeout: 20000 });
    deltaMs = Date.now() - t0;
    target = page.url();
  } catch {
    deltaMs = Date.now() - t0;
    // maybe the SDK opened a popup instead of self-navigation
    target = page.url();
  }
  log(`${label}: Pay Now -> cashfree in ${deltaMs}ms, target=${target.slice(0, 90)}`);
  return { deltaMs, target };
}

function scanFrames(page) {
  const out = [];
  for (const f of page.frames()) {
    out.push({ url: (f.url() || '').slice(0, 120) });
  }
  return out;
}

async function cashfreeSnapshot(page, name) {
  await sleep(1500);
  const frames = scanFrames(page);
  log(`${name}: frames=${JSON.stringify(frames)}`);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });
  // Dump EVERY frame's url + body text so we can see exactly what the gateway
  // is showing when something stalls.
  const parts = [];
  const htmlParts = [];
  for (let i = 0; i < page.frames().length; i++) {
    const f = page.frames()[i];
    try {
      const txt = await f.evaluate(() => document.body ? document.body.innerText : '');
      parts.push(`===== frame[${i}] ${(f.url() || '').slice(0, 160)} =====\n${String(txt ?? '').slice(0, 4000)}`);
      const h = await f.evaluate(() => document.documentElement ? document.documentElement.outerHTML : '');
      htmlParts.push(`<!-- frame[${i}] ${(f.url() || '').slice(0, 200)} -->\n${String(h ?? '')}`);
    } catch (e) {
      parts.push(`===== frame[${i}] ${(f.url() || '').slice(0, 160)} =====\n<error ${String(e).slice(0, 80)}>`);
    }
  }
  dump(`${name}_text`, parts.join('\n\n'));
  dump(`${name}_html`, htmlParts.join('\n'));
  log(`${name}: frame texts captured (${parts.length} frames)`);
}

async function listInputs(page, name) {
  for (let i = 0; i < page.frames().length; i++) {
    const f = page.frames()[i];
    try {
      const inputs = await f.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map((inp) => ({
          placeholder: inp.placeholder,
          name: inp.name,
          id: inp.id,
          type: inp.type,
          value: inp.value,
        }))
      );
      log(`${name} frame[${i}] (${(f.url() || '').slice(0, 80)}) inputs=${JSON.stringify(inputs)}`);
    } catch {}
  }
}
async function attemptCardPayment(page, name, cardIndex = 0, simStatus = 'SUCCESS') {
  await driveCardCheckout(page, name, cardIndex, simStatus).catch((e) => log(`${name}: driveCardCheckout error -> ${String(e).slice(0, 140)}`));
  log(`${name}: card drive finished`);
}

async function framesText(page) {
  const parts = [];
  for (const f of page.frames()) {
    try {
      const t = await f.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (t) parts.push(t.replace(/\n+/g, ' | '));
    } catch {}
  }
  return parts.join(' @@ ');
}

const TEST_CARDS = ['4706131211212123', '6074825972083818', '540916269381034'];

/**
 * Drives the Cashfree sandbox card checkout through to the end state:
 * Card tab ->< type test-card details -> Proceed to Pay -> (OTP / decline /
 * redirect to merchant). Returns once the page returns to dslang.in or the
 * gateway stops progressing.
 */
async function driveCardCheckout(page, name, cardIndex = 0, simStatus = 'SUCCESS') {
  // 1) Card tab (retry until the whole checkout UI is hydrated)
  let clickedTab = false;
  for (let attempt = 0; attempt < 12 && !clickedTab; attempt++) {
    for (const f of page.frames()) {
      try {
        let cand = f.getByRole('button', { name: /^Card$/ }).first();
        if ((await cand.count()) === 0) cand = f.getByText('Card', { exact: true }).first();
        if ((await cand.count()) > 0 && (await cand.isVisible().catch(() => false))) {
          await cand.click({ timeout: 4000 });
          clickedTab = true;
          log(`${name}: clicked Card tab`);
          break;
        }
      } catch {}
    }
    if (!clickedTab) await sleep(1000);
  }
  if (!clickedTab) {
    await cashfreeSnapshot(page, `${name}-no-card-tab`);
    throw new Error('card tab not found');
  }
  await sleep(1200);

  const cardF = page.frames().find((f) => /payment-method\/card/.test(f.url()));
  if (!cardF) {
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const f2 = page.frames().find((x) => /payment-method\/card/.test(x.url()));
      if (f2) break;
    }
  }
  const frame = page.frames().find((f) => /payment-method\/card/.test(f.url()));
  if (!frame) {
    await cashfreeSnapshot(page, `${name}-no-card-frame`);
    throw new Error('card frame never appeared');
  }
  log(`${name}: card frame ready`);
  await sleep(500);

  // 2) Populate the card form USING the sandbox "Use" button on the target test
  //    card row — this server-side pre-fills every field deterministically
  //    (typing into the hosted React form is flaky: Proceed stays disabled).
  //    Fall back to keyed typing if the expected test-card row is missing.
  const pan = TEST_CARDS[cardIndex % TEST_CARDS.length];
  const byName = (n) => frame.locator(`input[name="${n}"]`);

  let usedButton = false;
  const useIndex = cardIndex % TEST_CARDS.length;
  // The sandbox "Use" prefill is sometimes flaky (leaves cardNumber empty /
  // Proceed disabled) — retry clicking Use a few times before falling back to
  // manual typing.
  for (let useAttempt = 0; useAttempt < 3 && !usedButton; useAttempt++) {
    for (const f of page.frames()) {
      try {
        const useBtn = f.getByRole('button', { name: 'Use', exact: true }).nth(useIndex);
        const cnt = await useBtn.count();
        log(`${name}: "Use" buttons found=${cnt} (attempt ${useAttempt + 1})`);
        if (cnt > 0 && (await useBtn.isVisible().catch(() => false))) {
          await useBtn.click({ timeout: 5000 });
          log(`${name}: clicked "Use" (#${useIndex}) on test card ${pan}`);
          await sleep(1800);
          const no = await byName('cardNumber').inputValue().catch(() => '');
          if (!no) {
            log(`${name}: Use prefill left cardNumber empty, retrying`);
            await sleep(800);
          } else {
            usedButton = true;
          }
          break;
        }
      } catch {}
    }
  }

  // Either the Use button pre-filled the form, or we type it manually.
  // Give React a beat to hydrate the inputs after Use.
  if (usedButton) await sleep(1800);

  const cardNoVal = await byName('cardNumber').inputValue().catch(() => '');
  if (!cardNoVal) {
    // No prefill — type the full card manually with keyed input.
    for (const [sel, val, delay] of [
      ['cardNumber', pan, 40],
      ['validThrough', '12/27', 40],
      ['cvv', '123', 40],
      ['cardHolderName', 'TEST USER', 20],
    ]) {
      const el = byName(sel);
      await el.click({ timeout: 4000 });
      await el.pressSequentially(val, { delay });
      await sleep(200);
    }
  }
  await sleep(400);
  await listInputs(page, `${name}-after-typing`);

  // 3) Click "Proceed to Pay" (retry role/text until it sticks). After the
  //    "Use" prefill Proceed enables on its own — the tokeniseCard consent
  //    section (which disables Proceed) only appears if the box is ticked
  //    ourselves, so NEVER tick it here; just wait for React hydration.
  let clickedProceed = false;
  for (let attempt = 0; attempt < 20 && !clickedProceed; attempt++) {
    for (const f of page.frames()) {
      try {
        const p = f.getByRole('button', { name: /^Proceed to Pay$/ }).first();
        const t = f.getByText('Proceed to Pay', { exact: true }).first();
        let el = (await p.count()) > 0 ? p : ((await t.count()) > 0 ? t : null);
        if (el) {
          const vis = await el.isVisible().catch(() => false);
          const dis = await el.isDisabled().catch(() => false);
          if (vis && !dis) {
            await el.click({ timeout: 4000 });
            clickedProceed = true;
            log(`${name}: clicked Proceed to Pay`);
            break;
          } else {
            if (attempt === 19) log(`${name}: Proceed found but vis=${vis} dis=${dis}`);
          }
        }
      } catch {}
    }
    if (!clickedProceed) await sleep(1000);
  }
  if (!clickedProceed) {
    await cashfreeSnapshot(page, `${name}-no-proceed`);
    throw new Error('Proceed to Pay not found');
  }

  // 4) Watch the gateway until it returns to the merchant (or stalls)
  const t0 = Date.now();
  let lastText = '';
  let otpHandled = false;
  let proceeded = 1;
  let saveModalHandled = false;
  let simulatorHandled = false;
  let photoPosted = false;
  while (Date.now() - t0 < 90000) {
    if (/dslang\.in/.test(page.url())) {
      log(`${name}: returned to merchant after ${Date.now() - t0}ms`);
      return { outcome: 'returned', elapsedMs: Date.now() - t0 };
    }
    const txt = await framesText(page);

    // Cashfree sandbox "Simulator" page — final hop of a card payment. Enter
    // the OTP shown on the page, choose SUCCESS, and submit so the gateway
    // redirects back to the merchant.
    if (/Simulator/i.test(txt) && /Simulation Status/i.test(txt) && !simulatorHandled) {
      simulatorHandled = true;
      const done = await driveSimulator(page, name, simStatus);
      if (done) {
        await sleep(1500);
        continue;
      }
    }

    const changed = txt !== lastText;
    lastText = txt;

    if (!otpHandled && /(sent to|verification|enter.*otp|6-digit|otp)/i.test(txt) && /input/i.test(txt)) {
      log(`${name}: gateway shows OTP screen`);
      otpHandled = true;
      const done = await fillOtpMaybe(page, name);
      log(`${name}: otp handled=${done}`);
      await sleep(1000);
      continue;
    }
    // Sandbox "Save your card securely" modal — pick decline-save so the
    // payment moves forward (matches what a shopper would do to pay now).
    if (/Save your card securely/i.test(txt) && /Pay without saving the card/i.test(txt) && !saveModalHandled) {
      log(`${name}: save-card modal shown, declining save`);
      saveModalHandled = true;
      for (const f of page.frames()) {
        try {
          const b = f.getByRole('button', { name: /Pay without saving the card/i }).first();
          const t = f.getByText('Pay without saving the card', { exact: true }).first();
          const el = (await b.count()) > 0 ? b : ((await t.count()) > 0 ? t : null);
          if (el && (await el.isVisible().catch(() => false))) {
            await el.click({ timeout: 3000 });
            log(`${name}: clicked Pay without saving the card`);
            await sleep(1500);
            break;
          }
        } catch {}
      }
      await sleep(1000);
      continue;
    }
    if (/(declined|not authorised|not authorized|transaction failed|payment failed|insufficient)/i.test(txt)) {
      log(`${name}: GATEWAY DECLINED. text=${txt.slice(0, 400)}`);
      for (const label of ['Back to Merchant', 'Return to Merchant', 'Cancel', 'Try Again', 'Go Back']) {
        for (const f of page.frames()) {
          try {
            const b = f.getByRole('button', { name: new RegExp(label, 'i') }).first();
            if ((await b.count()) > 0 && (await b.isVisible().catch(() => false))) {
              await b.click({ timeout: 3000 });
              log(`${name}: clicked "${label}" to leave gateway`);
              break;
            }
          } catch {}
        }
      }
      await sleep(1500);
      continue;
    }
    // Still on the card screen: the gateway wants save-card consent or a 2nd
    // Proceed. Tick the tokeniseCard consent + retry Proceed a couple of times.
    if (/Proceed to Pay/i.test(txt) && Date.now() - t0 > 4000 && proceeded < 3 && /payment-method\/card/.test(page.url())) {
      const cf = page.frames().find((f) => /payment-method\/card/.test(f.url()));
      if (cf) {
        try {
          const cb = cf.locator('input[name="tokeniseCard"]');
          const checked = await cb.isChecked().catch(() => false);
          if (!checked) {
            await cb.click({ timeout: 3000 });
            log(`${name}: ticked tokeniseCard consent`);
            await sleep(300);
          }
        } catch {}
        for (const f of page.frames()) {
          try {
            const p = f.getByRole('button', { name: /^Proceed to Pay$/ }).first();
            const t = f.getByText('Proceed to Pay', { exact: true }).first();
            let el = (await p.count()) > 0 ? p : ((await t.count()) > 0 ? t : null);
            if (el && (await el.isVisible().catch(() => false)) && !(await el.isDisabled().catch(() => true))) {
              await el.click({ timeout: 4000 });
              proceeded++;
              log(`${name}: clicked Proceed to Pay (#${proceeded})`);
              break;
            }
          } catch {}
        }
      }
      await sleep(1500);
      continue;
    }
    await sleep(2000);
  }
  log(`${name}: gateway did not return to merchant within 90s. lastText=${lastText.slice(0, 500)}`);
  await cashfreeSnapshot(page, `${name}-gateway-stall`);
  dump(`${name}-gateway-stall-lasttext`, lastText.slice(0, 8000));
  return { outcome: 'stalled', elapsedMs: Date.now() - t0, lastText: lastText.slice(0, 500) };
}

async function driveSimulator(page, name, statusLabel = 'SUCCESS') {
  await sleep(1500);
  const frame = page.frames().find((f) => /simulator/i.test(f.url()));
  if (!frame) {
    log(`${name}: simulator frame not found`);
    return false;
  }
  log(`${name}: simulator frame ready`);
  await cashfreeSnapshot(page, `${name}-simulator`);
  // 1) OTP field — the simulator shows its own test OTP in the page text.
  let otpDone = false;
  for (const sel of ['input', 'input[type="text"]', 'input[placeholder*="OTP" i]']) {
    try {
      const el = frame.locator(sel).nth(0);
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click().catch(() => {});
        await el.pressSequentially('111000', { delay: 50 });
        otpDone = true;
        log(`${name}: typed OTP 111000`);
        break;
      }
    } catch {}
  }
  if (!otpDone) {
    // Fall back to any visible input and type the OTP.
    try {
      const vis = frame.locator('input:visible').nth(0);
      await vis.pressSequentially('111000', { delay: 50 });
      log(`${name}: typed OTP from fallback`);
    } catch {}
  }
  await sleep(800);
  // 2) Choose the requested simulation status.
  for (const f of page.frames()) {
    try {
      const b = f.getByRole('button', { name: new RegExp(`^${statusLabel}$`, 'i') }).first();
      const t = f.getByText(statusLabel, { exact: true }).first();
      const el = (await b.count()) > 0 ? b : ((await t.count()) > 0 ? t : null);
      if (el && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 4000 });
        log(`${name}: clicked ${statusLabel} simulation`);
        break;
      }
    } catch {}
  }
  await sleep(800);
  // 2b) For FAILED, the simulator requires a Bootstrap "Failure Type"
  //     dropdown selection before Submit becomes enabled (enabled only when
  //     OTP=6 digits AND status selected AND failure type picked).
  for (const f of page.frames()) {
    try {
      const toggle = f.locator('#txMsg').first();
      if ((await toggle.count()) > 0 && (await toggle.isVisible().catch(() => false))) {
        // The toggle is a Bootstrap dropdown button — click it to open the menu.
        await toggle.click({ timeout: 3000 }).catch(() => {});
        await sleep(500);
        const item = f.locator('.txMsg.pointer').nth(1);
        if ((await item.count()) > 0) {
          await item.click({ timeout: 3000 });
          log(`${name}: picked failure type -> ${(await f.locator('#txMsg').textContent().catch(() => '')).trim().slice(0, 60)}`);
        }
        break;
      }
    } catch {}
  }
  await sleep(800);
  // 3) Submit.
  for (const f of page.frames()) {
    try {
      const b = f.getByRole('button', { name: /^Submit$/i }).first();
      if ((await b.count()) > 0 && (await b.isVisible().catch(() => false))) {
        await b.click({ timeout: 4000 });
        log(`${name}: clicked Submit`);
        return true;
      }
    } catch {}
  }
  log(`${name}: Submit button not found`);
  await cashfreeSnapshot(page, `${name}-simulator-no-submit`);
  return false;
}

async function fillOtpMaybe(page, name) {
  await sleep(2000);
  for (const f of page.frames()) {
    try {
      const bodyText = await f.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      // Must look like a real OTP/verification screen, not the card form
      const isCardForm = await f.evaluate(() => !!document.querySelector('input[name="cardNumber"]')).catch(() => false);
      if (isCardForm) continue;
      if (!/OTP|sent to|verification|verify|6.?digit/i.test(bodyText)) continue;
      const visible = f.locator('input:visible');
      const count = await visible.count();
      if (count === 0) continue;
      log(`${name}: OTP screen detected in frame (text="${bodyText.slice(0, 140).replace(/\n/g, ' | ')}") inputs=${count}`);
      await cashfreeSnapshot(page, `${name}-otp-screen`);

      // Single masked input (maxlength 6) vs group of single-digit boxes
      let typed = false;
      for (let i = 0; i < count && !typed; i++) {
        const el = visible.nth(i);
        try {
          const maxLen = await el.getAttribute('maxlength');
          const val = (await el.inputValue()).length;
          const type = await el.getAttribute('type');
          if (val === 0 && (maxLen === '6' || maxLen === '4' || type === 'password' || type === 'tel' || type === 'number')) {
            await el.click().catch(() => {});
            await el.pressSequentially('123456', { delay: 120 });
            await sleep(600);
            typed = true;
            log(`${name}: typed 123456 into single OTP input`);
          }
        } catch {}
      }
      if (!typed && count <= 8) {
        // group of single-char boxes — type one digit each
        const digits = '123456';
        for (let i = 0; i < count && i < digits.length; i++) {
          try {
            const v = (await visible.nth(i).inputValue()).length;
            if (v === 0) {
              await visible.nth(i).pressSequentially(digits[i], { delay: 80 });
              await sleep(100);
            }
          } catch {}
        }
        await sleep(600);
        typed = true;
        log(`${name}: typed digits into ${count} OTP boxes`);
      }
      if (typed) {
        await cashfreeSnapshot(page, `${name}-otp-filled`);
        for (const label of ['Pay', 'Verify', 'Submit', 'Confirm']) {
          try {
            const b = f.getByRole('button', { name: new RegExp(label, 'i') }).first();
            if ((await b.count()) > 0 && (await b.isVisible().catch(() => false))) {
              await b.click({ timeout: 6000 });
              log(`${name}: clicked "${label}" after OTP`);
              return true;
            }
          } catch {}
        }
      }
      return typed;
    } catch {}
  }
  return false;
}

async function waitForSite(page, label, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const url = page.url();
    if (/dslang\.in/.test(url)) {
      log(`${label}: landed at ${url.slice(0, 140)} after ${Date.now() - t0}ms`);
      return Date.now() - t0;
    }
    await sleep(2000);
  }
  log(`${label}: never returned to site within ${timeoutMs}ms (still at ${page.url().slice(0, 100)})`);
  return Date.now() - t0;
}

async function waitForVerdict(page, label, timeoutMs = 60000) {
  const t0 = Date.now();
  const verdictRe = /Order Confirmed|Thank You|Payment Not Completed|Confirming Payment|expired|not found|Something went wrong/i;
  while (Date.now() - t0 < timeoutMs) {
    const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (verdictRe.test(body)) {
      log(`${label}: verdict text found after ${Date.now() - t0}ms`);
      return body;
    }
    await sleep(2000);
  }
  return await page.evaluate(() => document.body.innerText || '').catch(() => '');
}

async function extraction(page) {
  await sleep(2500);
  const hash = page.url().split('#')[1] || '';
  const text = await page.evaluate(() => document.body.innerText);
  const refs = [...text.matchAll(/Order\s+#([A-Z0-9-]+)/gi)].map((m) => m[1]);
  const orderHashes = [...hash.matchAll(/ref=([^&]+)/g)].map((m) => m[1].toUpperCase());
  const storageRefs = await page.evaluate(() => {
    const read = (k) => { try { const v = localStorage.getItem(k) || sessionStorage.getItem(k); if (!v) return null; const p = JSON.parse(v); return p.ref || p.orderRef || p.order?.ref || null; } catch { return null; } };
    return [read('dslang_live_order_v1'), read('dslang_pending_order_v1'), read('dslang_order_result_v1')].filter(Boolean);
  });
  const ref = refs[0] || orderHashes[0] || storageRefs[0] || null;
  log(`extract: hash=${hash} refsInText=${JSON.stringify(refs)} refsInHash=${JSON.stringify(orderHashes)} storageRefs=${JSON.stringify(storageRefs)}`);
  return { hash, ref };
}

async function storefrontChecks(page) {
  const results = [];
  const errs = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errs.push(msg.text().slice(0, 200) + ' @ ' + (msg.location().url || '').slice(-60)); });
  page.on('pageerror', (err) => errs.push('PAGEERROR: ' + String(err).slice(0, 200)));

  // Homepage — wait for real data cards (not skeletons)
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.product-card-frame h3').length > 0, null, { timeout: 60000 });
  const cards = await page.locator('.product-card-frame h3').count();
  const swatchCount = await page.locator('.product-card-frame [aria-label*="colours"]').count();
  results.push(`homepage: loaded OK; product cards=${cards}; cards with swatch row=${swatchCount}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'home.png') });

  // Collection
  await page.goto(BASE + '/#/collection', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.product-card-frame h3').length > 0, null, { timeout: 60000 });
  const cCards = await page.locator('.product-card-frame h3').count();
  const cSwatches = await page.locator('.product-card-frame [aria-label*="colours"] [class*="rounded-full"]').count();
  results.push(`collection: loaded OK; product cards=${cCards}; swatch dots shown=${cSwatches}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'collection.png') });

  // Product page + size chart modal
  await page.goto(BASE + '/#/product/dslang-original', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=DSLANG Original - Relaxed Fit T-shirt', { timeout: 40000 });
  const sizeChartBtn = page.getByRole('button', { name: 'Size Chart' }).first();
  await sizeChartBtn.click();
  await page.waitForSelector('[role="dialog"][aria-label="Size chart"]', { timeout: 10000 });
  const modal = page.locator('[role="dialog"][aria-label="Size chart"]');
  const modalWidth = await modal.evaluate((el) => {
    const card = el.querySelector('.max-w-md') || el;
    // measure the inner card
    const mdl = el.querySelector('[class*="rounded-2xl"]');
    return mdl ? Math.round(mdl.getBoundingClientRect().width) : 0;
  });
  results.push(`product page: loaded OK; size chart modal open; modal content width=${modalWidth}px (max-w-md=448 target)`);
  const chartRows = await page.locator('[role="dialog"] table tbody tr').count();
  results.push(`size chart: table rows=${chartRows}; close button present=${(await page.locator('[role="dialog"] [aria-label="Close size chart"]').count()) > 0}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'sizechart.png') });
  await page.locator('[role="dialog"] [aria-label="Close size chart"]').click();

  results.push(`consoleErrors=${errs.length}${errs.length ? ': ' + errs.join(' || ') : ''}`);
  const all = `FINAL\n${results.join('\n')}\n`;
  fs.writeFileSync(path.join(SHOT_DIR, 'storefront-results.txt'), all);
  log(all);
  return all;
}

async function successRun() {
  log('========== RUN: SUCCESS checkouut E2E ==========');
  let browser;
  try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();

  await gotoRetry(page, BASE + '/#/checkout', 'success');
  await setupCart(page, true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await fillCheckout(page);
  await page.screenshot({ path: path.join(SHOT_DIR, 'checkout-form.png') });

  const { deltaMs } = await payNowAndMeasure(page, 'success');

  await cashfreeSnapshot(page, 'cashfree-success');
  await attemptCardPayment(page, 'success', 0);
  const t = await waitForSite(page, 'success');
  log(`success: return to site in ${t}ms`);
  await waitForVerdict(page, 'success');
  const result = await extraction(page);
  // The OrderStatusPage starts in "Confirming payment" and only reaches
  // "Thank You / Order Confirmed" once the server-side cashfree-status
  // verification resolves. Poll for the DEFINITIVE paid verdict so we are not
  // screenshotting the transient state.
  const confirmDeadline = Date.now() + 45000;
  let confirmed = false;
  let confirmBody = '';
  while (Date.now() < confirmDeadline) {
    confirmBody = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (/Thank You|Order Confirmed/i.test(confirmBody)) {
      confirmed = true;
      break;
    }
    await sleep(2500);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, 'success-result.png') });
  dump('success-result-text', confirmBody.slice(0, 6000));
  const onOrderStatus = result.hash.includes('order-status');
  const ok = onOrderStatus && confirmed;
  log(`success: onOrderStatus=${onOrderStatus} confirmed=${confirmed} confirmBodyHead=${confirmBody.slice(0, 300).replace(/\n/g, ' | ')}`);
  log(numeric(`success-result-${result.ref}`, result.hash));

  const summary = `SUCCESS_RUN results=${JSON.stringify(result)} landedOnOrderStatus=${onOrderStatus} confirmationShown=${ok} redirectMs=${deltaMs}`;
  log(summary);
  fs.writeFileSync(path.join(SHOT_DIR, 'success-summary.txt'), summary + '\n');
  return { result, ok, redirectMs: deltaMs };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function failThenRetryRun() {
  log('========== RUN: FAIL -> TRY AGAIN -> SUCCESS ==========');
  let browser;
  try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();

  await gotoRetry(page, BASE + '/#/checkout', 'fail');
  await setupCart(page, true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await fillCheckout(page);

  const step1 = await payNowAndMeasure(page, 'fail-step1');

  await cashfreeSnapshot(page, 'cashfree-fail');

  // Drive the reliable test card (#0) to the simulator and choose FAILED —
  // the deterministic way to get a declined transaction back to the merchant
  // (the sandbox's 2nd "Use"-style card often leaves the form invalid).
  await attemptCardPayment(page, 'fail', 0, 'FAILED');

  // Wait for either a fail state on the gateway or a redirect back to the site
  await waitForSite(page, 'fail', 60000);
  const failResult = await extraction(page);
  await page.screenshot({ path: path.join(SHOT_DIR, 'fail-result.png') });

  const failBody = await page.evaluate(() => document.body.innerText);
  const failureShown = /Payment Not Completed|Order Not Found|expired/i.test(failBody);
  const failReasons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[class*="text-red"], p')).map((e) => (e.textContent || '').trim()).filter((t) => /(fail|declin|not|expir)/i.test(t)).slice(0, 6)
  );
  const tryAgainVisible = /Try Again/i.test(failBody);
  log(`fail: result=${JSON.stringify(failResult)} failureShown=${failureShown} tryAgainVisible=${tryAgainVisible} reasons=${JSON.stringify(failReasons)}`);

  // ---- TRY AGAIN ----
  if (tryAgainVisible) {
    const apiRespHandler = async (resp) => {
      if (/\/api\/cashfree-order/.test(resp.url())) {
        const body = await resp.text().catch(() => '');
        log(`cashfree-order RESPONSE ${resp.status()}: ${body.slice(0, 400)}`);
      }
      if (/cashfree-order/.test(resp.url()) && !/\/api\//.test(resp.url())) {
        const body = await resp.text().catch(() => '');
        log(`edge cashfree-order RESPONSE ${resp.status()}: ${body.slice(0, 400)}`);
      }
    };
    page.on('response', apiRespHandler);
    const tb = page.getByRole('button', { name: 'Try Again' }).first();
    const t0 = Date.now();
    await tb.click();
    let deltaMs = -1;
    try {
      await page.waitForURL(/cashfree/i, { timeout: 25000 });
      deltaMs = Date.now() - t0;
    } catch { deltaMs = Date.now() - t0; }
    log(`fail->tryAgain: redirect to cashfree in ${deltaMs}ms`);
    page.off('response', apiRespHandler);
    await cashfreeSnapshot(page, 'cashfree-retry');
    await attemptCardPayment(page, 'retry', 0);
    await waitForSite(page, 'retry', 60000);
    await waitForVerdict(page, 'retry');
    const retryResult = await extraction(page);
    await page.screenshot({ path: path.join(SHOT_DIR, 'retry-result.png') });
    const ok = /Thank You|Order Confirmed/i.test(await page.evaluate(() => document.body.innerText));
    const summary = `FAILRETRY_RUN sameOrderRef=${retryResult.ref === failResult.ref} final=${JSON.stringify(retryResult)} confirmationShown=${ok} tryAgainRedirectMs=${deltaMs}`;
    log(summary);
    fs.writeFileSync(path.join(SHOT_DIR, 'failretry-summary.txt'), summary + '\n');
    return { failRef: failResult.ref, finalRef: retryResult.ref, sameOrder: retryResult.ref === failResult.ref, ok, tryAgainRedirectMs: deltaMs };
  }

  fs.writeFileSync(path.join(SHOT_DIR, 'failretry-summary.txt'), 'NO TRY AGAIN AVAILABLE\n');
  return { note: 'no try again visible', failRef: failResult.ref };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function numeric(name, v) { fs.writeFileSync(path.join(SHOT_DIR, name), String(v)); return v; }

const mode = process.argv[2] || 'all';
const run = async () => {
  let browser;
  try {
    if (mode === 'storefront' || mode === 'all') {
      const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
      const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
      const page = await ctx.newPage();
      await storefrontChecks(page);
      await b.close();
      if (mode === 'storefront') return;
    }
    if (mode === 'success' || mode === 'all') await successRun();
    if (mode === 'success') return;
    if (mode === 'failretry' || mode === 'all') await failThenRetryRun();
  } catch (err) {
    log('FATAL: ' + (err && err.stack ? err.stack : String(err)));
    fs.writeFileSync(path.join(SHOT_DIR, 'fatal-error.txt'), String(err && err.stack ? err.stack : err) + '\n' + LOG.join('\n'));
  }
};
run();
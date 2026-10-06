/**
 * Cart-vs-stock reconciliation under a PENDING ONLINE RESERVATION.
 *
 * Placing an online order reserves stock by DECREMENTING product_sizes.stock
 * (create_retail_order), and the reservation is deliberately HELD while the
 * customer pays at Cashfree so "Try Again" can reuse the same order. That makes
 * product_sizes.stock the SHELF count: for the customer who started the payment
 * it no longer contains the units their own unpaid order holds.
 *
 * Reconciliation must therefore be reservation-aware — it adds the customer's
 * own held units back, and only those, so a cancelled Cashfree session returns
 * the customer to the bag they came from while stock held by anyone else is
 * still respected.
 *
 * The reconciliation itself is EXECUTED here, not described: `src/lib/cartStock.ts`
 * is compiled with the project's own TypeScript and the real functions are
 * driven through the real flow. Everything that needs a live Supabase/gateway
 * (order creation, the reservation decrement, the webhook) is asserted as a
 * contract against the real source.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const CART_STOCK = 'src/lib/cartStock.ts';
const CHECKOUT = 'src/pages/CheckoutPage.tsx';
const ORDERS_LIB = 'src/lib/orders.ts';
const CREATE_ORDER_SQL = 'supabase/migrations/20261012000000_dslang_cod_full_payment.sql';
const SWEEP_MIGRATION = 'supabase/migrations/20260925000000_dslang_expire_failed_orders_restock.sql';
const STATUS_FN = 'supabase/functions/cashfree-status/index.ts';
const DRAWER = 'src/components/CartDrawer.tsx';

/** Strip comments so contract assertions look at executable code only. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const cartStockSrc = read(CART_STOCK);
const cartStockCode = code(cartStockSrc);
const checkoutSrc = read(CHECKOUT);
const checkoutCode = code(checkoutSrc);
const createOrderSql = read(CREATE_ORDER_SQL);
const statusFnSrc = read(STATUS_FN);
const statusFnCode = code(statusFnSrc);

// ---------------------------------------------------------------------------
// Compile the real module and load it, so every scenario below runs the actual
// shipped functions (including the `held = ownHeldStock(items)` default).
// ---------------------------------------------------------------------------

const OUT = join(tmpdir(), 'dslang-cartstock-test');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'stub-rest.mjs'), 'export const get = async () => [];\n');

const compiled = ts.transpileModule(cartStockSrc, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
// `@/lib/rest` is the only runtime import (the d2cCart import is `import type`
// and is elided). Point it at a stub so the real fetch helper stays untouched.
const MOD = join(OUT, 'cartStock.mjs');
writeFileSync(MOD, compiled.replace(/from\s+'@\/lib\/rest'/, "from './stub-rest.mjs'"));
const cartStock = await import(pathToFileURL(MOD).href);

// ---------------------------------------------------------------------------
// The flow under test.
// ---------------------------------------------------------------------------

const P = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const KEY = cartStock.variantKey(P, C, 'M');

/** One cart line, as d2cCart stores it. */
function line(quantity, stock) {
  return {
    productId: P,
    slug: 'tshirt',
    name: 'DSLANG Original - Relaxed Fit T-shirt',
    code: 'TS',
    image: '',
    colorId: C,
    color: 'Optic Wash',
    colorHex: '#000',
    sizeLabel: 'M',
    quantity,
    unitPrice: 1299,
    stock,
    addedAt: 1,
  };
}

/** What create_retail_order returns for a 2-unit online order. */
const SERVER_LINES = [
  { product_id: P, color_id: C, name: 'x', code: 'TS', color: 'Optic Wash', size_label: 'M', quantity: 2, unit_price: 1299, line_total: 2598 },
];

const cartKey = cartStock.itemsKeyOf([line(2, 3)]);

/** sessionStorage stand-in for the checkout's live-order handle. */
function installLiveOrder(handle) {
  globalThis.window = {
    sessionStorage: {
      getItem: (k) => (k === 'dslang_live_order_v1' && handle ? JSON.stringify(handle) : null),
      removeItem: () => {},
      setItem: () => {},
    },
  };
}
const clearLiveOrder = () => installLiveOrder(null);

/** A paid/abandoned Cashfree return: handle stays, cart is unchanged. */
function pendingOnlineHandle() {
  return {
    ref: 'DSL-R-ABC12345',
    order_id: 'o1',
    amount: 2548,
    itemsKey: cartKey,
    is_cod: false,
    held: cartStock.heldStockFromOrderLines(SERVER_LINES),
  };
}

// ===========================================================================
// 1. THE REPORTED BUG: 2 in the bag, Cashfree cancelled, back to checkout.
// ===========================================================================

test('cancelled Cashfree returns the customer to their original quantity (3 on shelf)', () => {
  // Shelf before Pay Now.
  assert.equal(cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 3 }).items[0].quantity, 2);

  // Pay Now -> create_retail_order reserves 2 by decrementing stock 3 -> 1,
  // and checkout records exactly those units on the live-order handle.
  const shelfAfterReservation = 1;
  installLiveOrder(pendingOnlineHandle());

  // Customer cancels at Cashfree -> back to checkout -> load-time revalidation.
  const { items, changes } = cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: shelfAfterReservation });

  assert.equal(changes.changed, false, 'the warning must not fire for the shopper\'s own reservation');
  assert.equal(cartStock.describeStockChanges(changes), null);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 2, 'cart must stay at 2');
  assert.equal(items[0].stock, 3, 'snapshot restored to the pre-reservation figure');
});

test('cancelled Cashfree returns the customer to their original quantity (nothing left on the shelf)', () => {
  // Shelf was exactly 2: the reservation took the last 2 units.
  installLiveOrder(pendingOnlineHandle());

  const { items, changes } = cartStock.reconcileCartWithLive([line(2, 2)], { [KEY]: 0 });

  assert.equal(changes.changed, false);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 2, 'a zero shelf must not empty the bag of its own order');
});

test('the reservation survives other customers buying the free units in the meantime', () => {
  // Shelf 3 -> this order reserves 2 (shelf 1) -> another customer buys 1 (shelf 0).
  installLiveOrder(pendingOnlineHandle());

  const { items, changes } = cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 0 });

  assert.equal(changes.changed, false);
  assert.equal(items[0].quantity, 2);
});

test('the bag drawer reconciles identically (it shares the same function)', () => {
  installLiveOrder(pendingOnlineHandle());
  const drawer = cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 });
  const checkout = cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 });
  assert.deepEqual(drawer.items, checkout.items);
  assert.equal(drawer.changes.changed, false);
  // Both call sites use the default `held`, so neither can regress separately.
  assert.ok(!/reconcileCartWithLive\(items,\s*live\s*,/.test(code(read(DRAWER))));
  assert.ok(!/reconcileCartWithLive\(items,\s*live\s*,/.test(checkoutCode));
});

// ===========================================================================
// 2. Genuine shortages must STILL be reported.
// ===========================================================================

test('a genuine low-stock cart is still clamped and reported', () => {
  clearLiveOrder(); // a different shopper, no reservation of their own
  const { items, changes } = cartStock.reconcileCartWithLive([line(2, 2)], { [KEY]: 1 });

  assert.equal(items[0].quantity, 1);
  assert.equal(changes.clamped[0].from, 2);
  assert.equal(changes.clamped[0].to, 1);
  assert.match(cartStock.describeStockChanges(changes), /reduced from 2 to 1/);
});

test('a reservation only covers its own lines: going above it clamps to real availability', () => {
  // Customer edits the bag up to 4 after paying -> the live order no longer
  // matches, so nothing is added back and the real shelf decides.
  installLiveOrder(pendingOnlineHandle());
  const four = [line(4, 3)];
  const { items, changes } = cartStock.reconcileCartWithLive(four, { [KEY]: 1 });

  assert.equal(items[0].quantity, 1);
  assert.equal(changes.clamped[0].from, 4);
  assert.match(cartStock.describeStockChanges(changes), /reduced from 4 to 1/);
});

test('out-of-stock with no reservation still removes the line', () => {
  clearLiveOrder();
  const { items, changes } = cartStock.reconcileCartWithLive([line(2, 0)], { [KEY]: 0 });
  assert.equal(items.length, 0);
  assert.equal(changes.removed.length, 1);
  assert.match(cartStock.describeStockChanges(changes), /Removed \(now out of stock\)/);
});

test('a variant deleted from product_sizes is removed even with a live order', () => {
  installLiveOrder(pendingOnlineHandle());
  const { items, changes } = cartStock.reconcileCartWithLive([line(2, 3)], {}); // row gone
  assert.equal(items.length, 0);
  assert.equal(changes.removed.length, 1);
});

// ===========================================================================
// 3. The add-back is scoped to THIS shopper's reservation.
// ===========================================================================

test('a live order whose bag no longer matches the cart holds nothing back', () => {
  installLiveOrder({ ...pendingOnlineHandle(), itemsKey: `${P}|${C}|L|1` });
  const { items } = cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 });
  assert.equal(items[0].quantity, 1, 'a stale reservation must not inflate availability');
});

test('a COD live order is never treated as a held online reservation', () => {
  installLiveOrder({ ...pendingOnlineHandle(), is_cod: true });
  const { items } = cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 });
  assert.equal(items[0].quantity, 1);
});

test('no live order at all behaves exactly as before the fix', () => {
  clearLiveOrder();
  assert.deepEqual(cartStock.ownHeldStock([line(2, 3)]), {});
  assert.equal(cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 7 }).items[0].quantity, 2);
  assert.equal(cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 7 }).items[0].stock, 7);
});

test('a malformed or hostile stored reservation never inflates availability', () => {
  for (const held of [null, 'nope', 42, [], { [KEY]: -5 }, { [KEY]: NaN }, { '': 9 }]) {
    installLiveOrder({ ...pendingOnlineHandle(), held });
    const { items } = cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 });
    assert.equal(items[0].quantity, 1, `held=${JSON.stringify(held)} must not count`);
  }
  installLiveOrder({ ...pendingOnlineHandle(), held: { [KEY]: '3' } });
  assert.equal(
    cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 }).items[0].quantity,
    2,
    'a numeric string is still a count, not a forgery'
  );
});

test('unusable sessionStorage is survivable (private mode / quota)', () => {
  globalThis.window = {
    sessionStorage: {
      getItem: () => {
        throw new Error('denied');
      },
    },
  };
  assert.deepEqual(cartStock.ownHeldStock([line(2, 3)]), {});
  assert.equal(cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 }).items[0].quantity, 1);
  clearLiveOrder();
});

test('an empty cart never claims a reservation', () => {
  installLiveOrder(pendingOnlineHandle());
  assert.deepEqual(cartStock.ownHeldStock([]), {});
});

test('held units are read from the lines the SERVER reserved, per variant', () => {
  const held = cartStock.heldStockFromOrderLines([
    { product_id: P, color_id: C, size_label: 'M', quantity: 2 },
    { product_id: P, color_id: C, size_label: 'M', quantity: 1 },
    { product_id: P, color_id: C, size_label: 'L', quantity: 4 },
    { product_id: null, color_id: C, size_label: 'M', quantity: 9 },
    { product_id: P, color_id: null, size_label: 'M', quantity: 9 },
    { product_id: P, color_id: C, size_label: 'M', quantity: 0 },
    { product_id: P, color_id: C, size_label: 'M', quantity: 'x' },
    null,
  ]);
  assert.deepEqual(held, {
    [cartStock.variantKey(P, C, 'M')]: 3,
    [cartStock.variantKey(P, C, 'L')]: 4,
  });
  assert.deepEqual(cartStock.heldStockFromOrderLines(undefined), {});
});

test('an explicit held map is honoured, and callers can opt out with {}', () => {
  clearLiveOrder();
  assert.equal(
    cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 }, { [KEY]: 2 }).items[0].quantity,
    2
  );
  installLiveOrder(pendingOnlineHandle());
  assert.equal(
    cartStock.reconcileCartWithLive([line(2, 3)], { [KEY]: 1 }, {}).items[0].quantity,
    1,
    'an explicit empty map opts out of the default'
  );
});

// ===========================================================================
// 4. The reservation is preserved for retry — never released, never doubled.
// ===========================================================================

test('a cancelled payment still HOLDS its reservation (not released)', () => {
  // The gateway cancel path must never restock: the reservation is kept so a
  // retry reuses the same order instead of creating a second one.
  assert.ok(
    !/restock/i.test(statusFnCode),
    'cashfree-status must not restock on cancel'
  );
  // create_retail_order reserves (decrements) and never gives a unit back.
  assert.match(createOrderSql, /set stock = greatest\(stock - \(v_row->>'quantity'\)::int, 0\)/);
  assert.ok(!/restock_retail_order_items/.test(createOrderSql), 'order creation must not also release');
  // Releasing stays the exclusive job of the expiry sweep.
  assert.match(read(SWEEP_MIGRATION), /perform public\.restock_retail_order_items\(p_order_id\)/);
});

test('no new reservation is created on a retry (same order is reused)', () => {
  // The online->online branch (up to the new-order `else`) must not call
  // createRetailOrder at all — that is what keeps a retry from double-reserving.
  const reuseBranch = checkoutCode.slice(
    checkoutCode.indexOf('if (reuseOrder && liveOrder'),
    checkoutCode.indexOf('createRetailOrder({')
  );
  assert.ok(reuseBranch.length > 0, 'reuse branch must exist');
  assert.ok(!/createRetailOrder\(/.test(reuseBranch), 'retry must reuse the reserved order');
  assert.match(reuseBranch, /order = \{ ref: liveOrder\.ref, order_id: liveOrder\.order_id/);
  // Switching online -> COD re-prices in place, still exactly one reservation.
  assert.match(reuseBranch, /convertRetailOrderToCod\(liveOrder\.ref/);
});

test('the reservation is recorded from the server response, and survives every handle round-trip', () => {
  // Recorded from create_retail_order's own lines (never invented client-side).
  assert.ok(/held: res\.is_cod \? undefined : heldStockFromOrderLines\(res\.items\)/.test(checkoutCode));
  // The type actually carries the colour uuid the key needs.
  assert.ok(/color_id: string;/.test(read(ORDERS_LIB)));
  // Persisted -> rehydrated -> re-persisted from the pending record: 3 hops.
  assert.ok(/held: parsed\.held && typeof parsed\.held === 'object'/.test(checkoutCode));
  assert.ok(/held: v\.held && typeof v\.held === 'object'/.test(checkoutCode));
  assert.ok(/held: pending\.held,/.test(checkoutCode));
  // ...and it reaches the pending record written on a re-attempt too.
  assert.ok(/held: order\.is_cod\s*\?\s*undefined/.test(checkoutCode));
  assert.ok(/heldStockFromOrderLines\(order\.items\)/.test(checkoutCode));
  assert.ok(/liveOrder\?\.held/.test(checkoutCode));
  // ...and the fingerprint that scopes it is now defined once, in cartStock.
  assert.ok(!/function itemsKeyOf\(/.test(checkoutCode), 'CheckoutPage must not keep a second copy');
  assert.ok(/export function itemsKeyOf\(/.test(cartStockCode));
});

test('successful payment and COD are untouched by this change', () => {
  // Success clears the handle and empties the bag (nothing left to reconcile).
  assert.match(checkoutCode, /clearPendingKey\(\);\s*clearLiveOrderKey\(\);/);
  // COD still reserves through create_retail_order and records no online hold.
  assert.ok(/held: res\.is_cod \? undefined/.test(checkoutCode));
  assert.match(createOrderSql, /v_payment_status := 'cod_pending'/);
  // COD never opens a gateway session and never writes a pending record.
  const codShort = checkoutCode.slice(
    checkoutCode.indexOf('if (order.is_cod || paymentMethod'),
    checkoutCode.indexOf('await createPaymentSession({')
  );
  assert.ok(codShort.length > 0, 'COD short-circuit must exist');
  assert.match(codShort, /clear\(\)/);
  assert.ok(!/persistPendingKey|createPaymentSession/.test(codShort));
});

// ===========================================================================
// 5. Nothing was suppressed.
// ===========================================================================

test('the shortage notice still exists and is still produced from real changes', () => {
  assert.match(cartStockSrc, /Some items changed in your bag while you were shopping:/);
  assert.match(cartStockSrc, /reduced from \$\{c\.from\} to \$\{c\.to\}/);
  assert.match(checkoutCode, /setErrorMsg\(notice \?\? 'Some items changed in your bag\.'\)/);
  assert.ok(!/return;/.test(cartStockCode.slice(cartStockCode.indexOf('export function reconcileCartWithLive'))), 'the reconciliation must never short-circuit');
});

test('no parallel reservation system, no schema change', () => {
  // Reconciliation adds stock back only in the shopper's own view; it never
  // writes inventory and never calls an RPC.
  const fn = cartStockCode.slice(cartStockCode.indexOf('export function reconcileCartWithLive'));
  assert.ok(!/\brpc\b|\bupdate\b|\binsert\b|product_sizes/.test(fn));
  assert.ok(!/from '@\/lib\/rest'/.test(fn));
});
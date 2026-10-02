/**
 * Restock fail-closed behaviour — executed against a real PostgreSQL.
 *
 * Every scenario below is EXECUTED, not asserted from source text: a throwaway
 * PGlite instance (real Postgres, in-process, no server, no network) is
 * created, a production-shaped schema is loaded, and the *actual* function
 * bodies are extracted out of the migration files at run time. If someone edits
 * the migration and breaks the invariant, these tests fail.
 *
 * Both the pre-fix and post-fix function definitions are exercised, so the
 * suite demonstrates the leak that the change closes as well as the behaviour
 * that replaces it.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const HARDENING_MIGRATION = 'supabase/migrations/20261016000000_dslang_restock_fail_closed.sql';
const PRIOR_MIGRATION = 'supabase/migrations/20261001000000_dslang_shiprocket.sql';

/**
 * PGlite is resolved rather than hard-required so the suite degrades to a skip
 * on machines that have not installed it, instead of failing `npm test` for
 * everyone. An env override is honoured for CI.
 */
function loadPGlite() {
  const candidates = [
    process.env.PGLITE_PATH,
    ...(existsSync(join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
      ? ['@electric-sql/pglite']
      : []),
    'C:/Users/Admin/AppData/Local/Temp/opencode/pgharness/node_modules/@electric-sql/pglite',
  ].filter(Boolean);
  for (const spec of candidates) {
    try {
      const require = createRequire(import.meta.url);
      return require(spec);
    } catch { /* try next */ }
  }
  return null;
}

const pglite = loadPGlite();

/** Pull one `create or replace function <name>` body out of a migration. */
function extractFunction(sql, name) {
  const marker = `create or replace function public.${name}(`;
  const start = sql.indexOf(marker);
  if (start === -1) throw new Error(`${name} not found`);
  const dollar = sql.indexOf('$$', start);
  if (dollar === -1) throw new Error(`no $$ body for ${name}`);
  const end = sql.indexOf('$$;', dollar + 2);
  if (end === -1) throw new Error(`unterminated body for ${name}`);
  return sql.slice(start, end + 3);
}

const priorSql = read(PRIOR_MIGRATION);
const hardeningSql = read(HARDENING_MIGRATION);

const PRIOR_FN = extractFunction(priorSql, 'restock_retail_order_items');
const HARDENED_FN = extractFunction(hardeningSql, 'restock_retail_order_items');

// gen_random_uuid() is built in on PG13+; no pgcrypto needed, and PGlite does
// not ship that extension.
const SCHEMA = `
  create table public.product_sizes (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null,
    color_id uuid not null,
    size_label text not null,
    stock integer not null default 0,
    available boolean not null default true,
    reserved integer not null default 0,
    unique (product_id, color_id, size_label)
  );
  create table public.retail_orders (
    id uuid primary key default gen_random_uuid(),
    ref text,
    order_type text not null default 'retail',
    payment_status text,
    order_status text,
    total_amount numeric,
    is_cod boolean not null default false,
    amount_paid_upfront numeric,
    stock_restored_at timestamptz,
    items jsonb,
    updated_at timestamptz
  );
`;

const P = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';
const C2 = '44444444-4444-4444-8444-444444444444';

const line = (product_id, color_id, size_label, quantity) => ({
  code: 'X', name: 'Item', product_id, color_id, size_label, quantity,
});

/** Fresh DB per test: no shared state, no ordering dependence. */
async function freshDb() {
  const { PGlite } = pglite;
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(HARDENED_FN);
  return db;
}

async function seedStock(db, rows) {
  for (const r of rows) {
    await db.query(
      `insert into public.product_sizes (product_id, color_id, size_label, stock, available)
       values ($1, $2, $3, $4, $5)`,
      [r.product_id, r.color_id, r.size_label, r.stock, r.stock > 0],
    );
  }
}

async function seedOrder(db, { ref, items, payment_status = 'pending', order_status = 'pending', is_cod = false }) {
  const r = await db.query(
    `insert into public.retail_orders (ref, payment_status, order_status, is_cod, items, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, now()) returning id`,
    [ref, payment_status, order_status, is_cod, JSON.stringify(items)],
  );
  return r.rows[0].id;
}

const stockOf = async (db, p, c, s) =>
  (await db.query(
    `select stock, available from public.product_sizes
     where product_id=$1 and color_id=$2 and size_label=$3`, [p, c, s],
  )).rows[0];

const restoredAt = async (db, id) =>
  (await db.query(`select stock_restored_at from public.retail_orders where id=$1`, [id]))
    .rows[0].stock_restored_at;

/** Call the function, distinguishing "raised" from "returned a value". */
async function callRestock(db, id) {
  try {
    const r = await db.query(`select public.restock_retail_order_items($1) as n`, [id]);
    return { raised: null, value: r.rows[0].n };
  } catch (e) {
    return { raised: e, value: null };
  }
}

const skip = pglite ? false : 'PGlite not installed; set PGLITE_PATH to a @electric-sql/pglite install';

// -----------------------------------------------------------------------------
// Baseline: the pre-fix function really did lose stock silently.
// -----------------------------------------------------------------------------

test('BEFORE: the old function stamps stock_restored_at while restoring nothing', { skip }, async () => {
  const { PGlite } = pglite;
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(PRIOR_FN);

  // Two lines: one valid, one missing color_id. 3 units total reserved.
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-LEAK',
    items: [line(P, C, 'M', 2), { product_id: P, size_label: 'M', quantity: 1 }],
  });

  const res = await callRestock(db, id);
  assert.equal(res.raised, null, 'the old function reported success');

  const row = await stockOf(db, P, C, 'M');
  assert.equal(row.stock, 2, 'only the valid line came back — 1 unit leaked');
  assert.notEqual(
    await restoredAt(db, id), null,
    'the old function still stamped stock_restored_at, making the leak permanent',
  );

  // And the idempotency guard now blocks any retry.
  const second = await callRestock(db, id);
  assert.equal(second.value, 0);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 2, 'the missing unit is unrecoverable');
  await db.close();
});

// -----------------------------------------------------------------------------
// A. Normal order with valid identifiers.
// -----------------------------------------------------------------------------

test('A: valid identifiers restore every quantity, stamp the order, then no-op', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, { ref: 'DSL-R-A', items: [line(P, C, 'M', 3)] });

  const res = await callRestock(db, id);
  assert.equal(res.raised, null, 'must not raise');
  assert.equal(res.value, 1, 'one stock row updated');
  assert.deepEqual(await stockOf(db, P, C, 'M'), { stock: 3, available: true });
  assert.notEqual(await restoredAt(db, id), null, 'stock_restored_at set');

  const again = await callRestock(db, id);
  assert.equal(again.value, 0, 'second call is a no-op');
  assert.equal((await stockOf(db, P, C, 'M')).stock, 3, 'stock not double-restored');
  await db.close();
});

test('A: available tracks a resulting stock of zero', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  // Restoring exactly zero units must leave available false, not force it true.
  const id = await seedOrder(db, { ref: 'DSL-R-A0', items: [line(P, C, 'M', 0)] });
  const res = await callRestock(db, id);
  assert.equal(res.raised, null);
  assert.equal((await stockOf(db, P, C, 'M')).available, false);
  assert.equal(res.value, 0, 'a zero-quantity line restores no row');
  await db.close();
});

// -----------------------------------------------------------------------------
// B. Duplicate lines aggregate to a single stock-row update.
// -----------------------------------------------------------------------------

test('B: duplicate lines aggregate and touch the stock row exactly once', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-B',
    items: [
      line(P, C, 'M', 1),
      line(P, C, 'M', 2),
      line(P, C, 'M', 3),
    ],
  });

  const res = await callRestock(db, id);
  assert.equal(res.value, 1, 'three duplicate lines -> one row update');
  assert.equal((await stockOf(db, P, C, 'M')).stock, 6, '1+2+3 aggregated');
  await db.close();
});

test('B: mixed distinct keys each restore once, duplicates within a key aggregate', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [
    { product_id: P, color_id: C, size_label: 'M', stock: 0 },
    { product_id: P, color_id: C, size_label: 'L', stock: 0 },
    { product_id: P2, color_id: C2, size_label: 'M', stock: 0 },
  ]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-B2',
    items: [
      line(P, C, 'M', 2), line(P, C, 'M', 3),
      line(P, C, 'L', 1),
      line(P2, C2, 'M', 4),
    ],
  });

  const res = await callRestock(db, id);
  assert.equal(res.value, 3, 'three distinct keys -> three row updates');
  assert.equal((await stockOf(db, P, C, 'M')).stock, 5);
  assert.equal((await stockOf(db, P, C, 'L')).stock, 1);
  assert.equal((await stockOf(db, P2, C2, 'M')).stock, 4);
  await db.close();
});

// -----------------------------------------------------------------------------
// C/D/E. Malformed identifiers must abort the whole restoration.
// -----------------------------------------------------------------------------

const malformed = [
  ['C: missing product_id', { size_label: 'M', color_id: C, quantity: 1 }],
  ['C: empty product_id', { product_id: '', color_id: C, size_label: 'M', quantity: 1 }],
  ['C: non-uuid product_id', { product_id: 'not-a-uuid', color_id: C, size_label: 'M', quantity: 1 }],
  ['D: missing color_id', { product_id: P, size_label: 'M', quantity: 1 }],
  ['D: empty color_id', { product_id: P, color_id: '', size_label: 'M', quantity: 1 }],
  ['D: non-uuid color_id', { product_id: P, color_id: 'not-a-uuid', size_label: 'M', quantity: 1 }],
  ['E: missing size_label', { product_id: P, color_id: C, quantity: 1 }],
  ['E: empty size_label', { product_id: P, color_id: C, size_label: '', quantity: 1 }],
];

for (const [name, bad] of malformed) {
  test(`${name}: aborts, restores nothing, leaves the order retryable`, { skip }, async () => {
    const db = await freshDb();
    // A good line that MUST also stay untouched — proves atomicity, not just
    // that the bad line was skipped.
    await seedStock(db, [
      { product_id: P, color_id: C, size_label: 'M', stock: 0 },
      { product_id: P2, color_id: C2, size_label: 'M', stock: 0 },
    ]);
    const id = await seedOrder(db, {
      ref: 'DSL-R-BAD',
      items: [line(P, C, 'M', 2), bad],
    });

    const res = await callRestock(db, id);
    assert.notEqual(res.raised, null, 'must raise, not return');
    assert.match(res.raised.message, /malformed restockable line/i);
    assert.match(res.raised.message, /stock_restored_at was NOT set/i);

    // Atomic: the valid line's units were NOT returned either.
    assert.equal((await stockOf(db, P, C, 'M')).stock, 0, 'no partial restoration');
    assert.equal((await stockOf(db, P2, C2, 'M')).stock, 0, 'untouched unrelated row');
    assert.equal(await restoredAt(db, id), null, 'stock_restored_at must stay NULL');
    await db.close();
  });
}

test('E: non-numeric quantity is rejected as a malformed line, not a cast crash', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-BADQTY',
    items: [line(P, C, 'M', 'two')],
  });
  const res = await callRestock(db, id);
  assert.notEqual(res.raised, null);
  assert.match(res.raised.message, /malformed restockable line/i);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 0);
  assert.equal(await restoredAt(db, id), null);
  await db.close();
});

// -----------------------------------------------------------------------------
// F. A key with no product_sizes row must abort, not partially restore.
// -----------------------------------------------------------------------------

test('F: unresolvable stock row aborts with no partial restoration', { skip }, async () => {
  const db = await freshDb();
  // Only the FIRST key has a stock row; the second has none.
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-GHOST',
    items: [line(P, C, 'M', 2), line(P2, C2, 'L', 5)],
  });

  const res = await callRestock(db, id);
  assert.notEqual(res.raised, null, 'must raise');
  assert.match(res.raised.message, /no matching product_sizes row/i);
  assert.match(res.raised.message, /stock_restored_at was NOT set/i);

  assert.equal((await stockOf(db, P, C, 'M')).stock, 0,
    'the resolvable line must NOT be restored — all or nothing');
  assert.equal(await restoredAt(db, id), null);
  await db.close();
});

test('F: the failure detail names the count of unresolvable keys', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, []);
  const id = await seedOrder(db, {
    ref: 'DSL-R-GHOST2',
    items: [line(P, C, 'M', 1), line(P2, C2, 'L', 1)],
  });
  const res = await callRestock(db, id);
  assert.notEqual(res.raised, null);
  assert.match(res.raised.detail ?? '', /unresolvable distinct .* keys: 2/);
  await db.close();
});

// -----------------------------------------------------------------------------
// Retryability: the order must still be restockable once the data is repaired.
// -----------------------------------------------------------------------------

test('a previously failed restock succeeds after the bad line is repaired', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-RETRY',
    items: [line(P, C, 'M', 2), { product_id: P, size_label: 'M', quantity: 1 }],
  });

  const first = await callRestock(db, id);
  assert.notEqual(first.raised, null);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 0);
  assert.equal(await restoredAt(db, id), null);

  // Repair: the missing color_id is filled in.
  await db.query(
    `update public.retail_orders set items = $2::jsonb where id = $1`,
    [id, JSON.stringify([line(P, C, 'M', 2), line(P, C, 'M', 1)])],
  );

  const second = await callRestock(db, id);
  assert.equal(second.raised, null, 'retry must now succeed');
  assert.equal(second.value, 1);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 3, 'both lines restored on retry');
  assert.notEqual(await restoredAt(db, id), null);
  await db.close();
});

// -----------------------------------------------------------------------------
// H. Existing behaviour preserved.
// -----------------------------------------------------------------------------

const skipCases = [
  ['null order id returns 0', null],
  ['non-retail order is ignored', 'wholesale'],
];

test('H: a null order id returns 0 without raising', { skip }, async () => {
  const db = await freshDb();
  const r = await db.query(`select public.restock_retail_order_items(null) as n`);
  assert.equal(r.rows[0].n, 0);
  await db.close();
});

test('H: non-retail order is ignored', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const r = await db.query(
    `insert into public.retail_orders (ref, order_type, payment_status, order_status, items)
     values ('DSL-R-WS','wholesale','pending','pending',$1::jsonb) returning id`,
    [JSON.stringify([line(P, C, 'M', 3)])],
  );
  const res = await callRestock(db, r.rows[0].id);
  assert.equal(res.value, 0);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 0);
  await db.close();
});

for (const status of ['shipped', 'delivered', 'refunded', 'rto']) {
  test(`H: a '${status}' order is never restocked`, { skip }, async () => {
    const db = await freshDb();
    await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
    const id = await seedOrder(db, {
      ref: `DSL-R-${status}`, order_status: status, items: [line(P, C, 'M', 3)],
    });
    const res = await callRestock(db, id);
    assert.equal(res.value, 0);
    assert.equal((await stockOf(db, P, C, 'M')).stock, 0);
    assert.equal(await restoredAt(db, id), null);
    await db.close();
  });
}

test('H: a paid order is never restocked', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-PAID', payment_status: 'success', items: [line(P, C, 'M', 3)],
  });
  const res = await callRestock(db, id);
  assert.equal(res.value, 0);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 0);
  await db.close();
});

test('H: an already-restocked order is a no-op even with valid items', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, { ref: 'DSL-R-TWICE', items: [line(P, C, 'M', 3)] });
  await callRestock(db, id);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 3);

  // Force the guard to be the only thing preventing a double restore.
  await db.query(`update public.retail_orders set stock_restored_at = now() where id=$1`, [id]);
  const again = await callRestock(db, id);
  assert.equal(again.value, 0);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 3, 'idempotency guard holds');
  await db.close();
});

test('H: stock_restored_at is a compare-and-set — a second attempt never overwrites it', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, { ref: 'DSL-R-STAMP', items: [line(P, C, 'M', 2)] });

  // First restoration stamps the column.
  assert.equal((await callRestock(db, id)).value, 1);
  const first = await restoredAt(db, id);
  assert.notEqual(first, null, 'first call must stamp');

  // A distinguishable, older-looking stamp is written directly, then several
  // more attempts are made. The early guard short-circuits them at the top of
  // the function, so the stamp must survive every one of them unchanged.
  const sentinel = '2020-01-02 03:04:05+00';
  await db.query(
    `update public.retail_orders set stock_restored_at = $2::timestamptz where id=$1`,
    [id, sentinel],
  );
  for (let i = 0; i < 3; i++) {
    const res = await callRestock(db, id);
    assert.equal(res.raised, null, 'no attempt may raise');
    assert.equal(res.value, 0, 'no attempt may restore');
    const stampNow = await restoredAt(db, id);
    assert.ok(stampNow instanceof Date, 'stock_restored_at is a timestamptz');
    assert.equal(stampNow.toISOString(), new Date(sentinel).toISOString(),
      'stock_restored_at must not be overwritten by a later restoration attempt');
    assert.equal((await stockOf(db, P, C, 'M')).stock, 2, 'stock unchanged');
  }

  // And the UPDATE predicate itself carries the guard, so the invariant holds
  // even if the early-return guard were ever removed.
  const stamp = HARDENED_FN.slice(
    HARDENED_FN.indexOf('update public.retail_orders'),
  );
  assert.match(
    stamp,
    /set stock_restored_at = now\(\)\s*\n\s*where id = v_order\.id\s*\n\s*and stock_restored_at is null;/,
    'the stamp UPDATE must require stock_restored_at IS NULL',
  );
  await db.close();
});

test('H: an order with no items restores nothing and does not raise', { skip }, async () => {
  const db = await freshDb();
  const id = await seedOrder(db, { ref: 'DSL-R-EMPTY', items: [] });
  const res = await callRestock(db, id);
  assert.equal(res.raised, null);
  assert.equal(res.value, 0);
  await db.close();
});

test('H: a missing order is ignored', { skip }, async () => {
  const db = await freshDb();
  const res = await callRestock(db, '99999999-9999-4999-8999-999999999999');
  assert.equal(res.raised, null);
  assert.equal(res.value, 0);
  await db.close();
});

test('H: a zero or negative quantity line is ignored, not treated as malformed', { skip }, async () => {
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 0 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-ZERO',
    items: [line(P, C, 'M', 0), line(P, C, 'L', -2)],
  });
  const res = await callRestock(db, id);
  assert.equal(res.raised, null, 'no reservation is held, so nothing to fail on');
  assert.equal(res.value, 0);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 0);
  await db.close();
});

// -----------------------------------------------------------------------------
// Security posture is preserved (source-level, cheap and exact).
// -----------------------------------------------------------------------------

test('the hardened function keeps SECURITY DEFINER and its service_role-only ACL', () => {
  assert.match(HARDENED_FN, /security definer/i);
  assert.match(HARDENED_FN, /set search_path = public/i);
  const tail = hardeningSql.slice(hardeningSql.indexOf('revoke all on function public.restock_retail_order_items'));
  assert.match(tail, /grant execute on function public\.restock_retail_order_items\(uuid\)\s*to service_role;/);
  assert.match(tail, /revoke execute on function public\.restock_retail_order_items\(uuid\) from anon;/);
  assert.match(tail, /revoke execute on function public\.restock_retail_order_items\(uuid\) from authenticated;/);
});

test('the hardened function keeps its original signature and return type', () => {
  assert.match(HARDENED_FN, /create or replace function public\.restock_retail_order_items\(p_order_id uuid\)/);
  assert.match(HARDENED_FN, /returns integer/);
});

test('the preflight runs before the UPDATE, so a failure cannot partially write', () => {
  const body = HARDENED_FN;
  const preflight = body.indexOf('PREFLIGHT 1');
  const preflight2 = body.indexOf('PREFLIGHT 2');
  const update = body.indexOf('update public.product_sizes ps');
  const stamp = body.indexOf('set stock_restored_at = now()');
  assert.ok(preflight > -1 && preflight2 > -1, 'both preflights present');
  assert.ok(preflight < update, 'preflight 1 precedes the stock UPDATE');
  assert.ok(preflight2 < update, 'preflight 2 precedes the stock UPDATE');
  assert.ok(update < stamp, 'stock_restored_at is written only after the UPDATE');
});

test('the silent per-line identifier filter is gone from the restoration UPDATE', () => {
  // The old body dropped lines via `and x.item->>'product_id' is not null` etc.
  // inside the aggregation, which is exactly the silent skip being fixed.
  const updateBlock = HARDENED_FN.slice(
    HARDENED_FN.indexOf('update public.product_sizes ps'),
  );
  assert.doesNotMatch(
    updateBlock,
    /x\.item->>'(product_id|color_id|size_label)'\s+is not null/,
    'the restoration UPDATE must not silently filter out unidentifiable lines',
  );
  assert.doesNotMatch(
    priorSql.slice(priorSql.indexOf('create or replace function public.restock_retail_order_items')),
    /RESTORE — identical/,
  );
});

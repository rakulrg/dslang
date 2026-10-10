/**
 * Paid-order deletion safety — executed against a real PostgreSQL.
 *
 * Regression suite for the production incident of 2026-10-10, where five orders
 * that had reached payment_status='success' were deleted from the admin panel
 * and took 6 units of reserved stock with them, silently and permanently.
 *
 * Root cause: `delete_retail_order` called `restock_retail_order_items` and then
 * deleted the row regardless of what the restock decided. The restock
 * deliberately declines paid orders, so the units stayed withdrawn while the row
 * that proved they were owed disappeared.
 *
 * Every scenario below is EXECUTED, not asserted from source text: a throwaway
 * PGlite instance (real Postgres, in-process, no server, no network) is created,
 * a production-shaped schema is loaded, and the *actual* function bodies are
 * extracted out of the migration files at run time. If someone edits the
 * migration and breaks an invariant, these tests fail.
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

const GUARD_MIGRATION = 'supabase/migrations/20261022000000_dslang_block_paid_order_deletion.sql';
const RESTOCK_MIGRATION = 'supabase/migrations/20261016000000_dslang_restock_fail_closed.sql';
const OPS_MIGRATION = 'supabase/migrations/20261005000000_dslang_ops_inventory.sql';
const PRIOR_DELETE_MIGRATION = 'supabase/migrations/20260920000000_dslang_restock_retail_orders.sql';

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

const guardSql = read(GUARD_MIGRATION);
const restockSql = read(RESTOCK_MIGRATION);
const opsSql = read(OPS_MIGRATION);
const priorDeleteSql = read(PRIOR_DELETE_MIGRATION);

const PAYMENT_CAPTURED_FN = extractFunction(guardSql, 'dslang_order_payment_captured');
const GUARDED_DELETE_FN = extractFunction(guardSql, 'delete_retail_order');
const PAID_DELETE_FN = extractFunction(guardSql, 'delete_paid_retail_order');
const RESTOCK_FN = extractFunction(restockSql, 'restock_retail_order_items');
const RECORD_ACTIVITY_FN = extractFunction(opsSql, 'record_admin_activity');
const PRIOR_DELETE_FN = extractFunction(priorDeleteSql, 'delete_retail_order');

// gen_random_uuid() is built in on PG13+; no pgcrypto needed, and PGlite does
// not ship that extension.
const SCHEMA = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text);

  create or replace function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
      nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid)
  $$;

  create table if not exists public.admin_users (user_id uuid primary key);

  create table if not exists public.admin_activity (
    id bigint generated always as identity primary key,
    actor_id uuid, actor_email text, action text not null,
    entity text not null, entity_id text, entity_ref text,
    metadata jsonb, created_at timestamptz not null default now()
  );

  create table if not exists public.promo_codes (
    id uuid primary key default gen_random_uuid(),
    code text not null unique,
    used_count integer not null default 0
  );

  create table if not exists public.product_sizes (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null,
    color_id uuid not null,
    size_label text not null,
    stock integer not null default 0,
    available boolean not null default true,
    reserved integer not null default 0,
    unique (product_id, color_id, size_label)
  );

  create table if not exists public.retail_orders (
    id uuid primary key default gen_random_uuid(),
    ref text,
    order_type text not null default 'retail',
    order_status text not null default 'pending',
    payment_status text not null default 'pending',
    is_cod boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    paid_at timestamptz,
    total_qty integer not null default 0,
    subtotal numeric not null default 0,
    discount numeric not null default 0,
    shipping numeric not null default 0,
    total_amount numeric not null default 0,
    amount_paid_upfront numeric not null default 0,
    amount_due_on_delivery numeric not null default 0,
    currency text,
    promo_code text,
    payment_provider text,
    payment_id text,
    txn_id text,
    customer jsonb,
    items jsonb,
    stock_restored_at timestamptz
  );
`;

const P = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTSIDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const line = (product_id, color_id, size_label, quantity) => ({
  code: 'X', name: 'Item', product_id, color_id, size_label, quantity,
});

/** Fresh DB per test: no shared state, no ordering dependence. */
async function freshDb() {
  const { PGlite } = pglite;
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(RESTOCK_FN);
  await db.exec(RECORD_ACTIVITY_FN);
  await db.exec(PAYMENT_CAPTURED_FN);
  await db.exec(GUARDED_DELETE_FN);
  await db.exec(PAID_DELETE_FN);
  // Act as an administrator for the privileged-path tests.
  await db.query('insert into public.admin_users (user_id) values ($1)', [ADMIN]);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ADMIN]);
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

async function seedOrder(db, {
  ref, items, payment_status = 'pending', order_status = 'pending',
  paid_at = null, is_cod = false, promo_code = null,
}) {
  const r = await db.query(
    `insert into public.retail_orders
       (ref, payment_status, order_status, paid_at, is_cod, promo_code, items, total_qty, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now()) returning id`,
    [ref, payment_status, order_status, paid_at, is_cod, promo_code,
      JSON.stringify(items), items.reduce((n, i) => n + (i.quantity || 0), 0)],
  );
  return r.rows[0].id;
}

const stockOf = async (db, p, c, s) =>
  (await db.query(
    `select stock, available from public.product_sizes
     where product_id=$1 and color_id=$2 and size_label=$3`, [p, c, s],
  )).rows[0];

const orderExists = async (db, id) =>
  (await db.query(`select 1 from public.retail_orders where id=$1`, [id])).rows.length > 0;

const restoredAt = async (db, id) =>
  (await db.query(`select stock_restored_at from public.retail_orders where id=$1`, [id]))
    .rows[0].stock_restored_at;

/** Call delete_retail_order, distinguishing "raised" from "returned a value". */
async function callDelete(db, id) {
  try {
    const r = await db.query(`select public.delete_retail_order($1) as n`, [id]);
    return { raised: false, value: r.rows[0].n };
  } catch (e) {
    return { raised: true, message: String(e.message || e) };
  }
}

async function callPaidDelete(db, id, reason, attest) {
  try {
    const r = await db.query(
      `select public.delete_paid_retail_order($1, $2, $3) as out`, [id, reason, attest],
    );
    return { raised: false, value: r.rows[0].out };
  } catch (e) {
    return { raised: true, message: String(e.message || e) };
  }
}

const activityFor = async (db, ref) =>
  (await db.query(
    `select action, metadata from public.admin_activity
     where entity='order' and entity_ref=$1 order by id asc`, [ref],
  )).rows;

// ---------------------------------------------------------------------------
// 1. THE INCIDENT: a paid order must not be deletable through the normal path.
// ---------------------------------------------------------------------------

test('a successful paid order is REFUSED by delete_retail_order, and survives', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-PAID', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.product_sizes set stock = stock - 1
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  const res = await callDelete(db, id);
  assert.equal(res.raised, true, 'the delete must be refused');
  assert.match(res.message, /captured payment/i);

  // The order row must still exist, and the stock must be exactly where the
  // reservation left it (4 seeded, 1 reserved => 3). A refused delete must not
  // move stock in either direction.
  assert.equal(await orderExists(db, id), true, 'the order row must survive');
  assert.equal((await stockOf(db, P, C, 'M')).stock, 3, 'stock must be untouched');
});

test('every captured-payment shape is refused (success / paid / cod_partial_paid / paid_at)', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const cases = [
    { label: 'success', payment_status: 'success', order_status: 'processing', paid_at: null },
    { label: 'paid', payment_status: 'paid', order_status: 'processing', paid_at: null },
    { label: 'cod_partial_paid', payment_status: 'cod_partial_paid', order_status: 'pending', paid_at: null },
    { label: 'paid_at set, status pending', payment_status: 'pending', order_status: 'processing', paid_at: '2026-10-05 05:52:08+00' },
  ];
  for (const c of cases) {
    const db = await freshDb();
    await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
    const id = await seedOrder(db, {
      ref: `DSL-R-${c.label}`, payment_status: c.payment_status,
      order_status: c.order_status, paid_at: c.paid_at,
      items: [line(P, C, 'M', 1)],
    });
    const res = await callDelete(db, id);
    assert.equal(res.raised, true, `${c.label} must be refused`);
    assert.equal(await orderExists(db, id), true, `${c.label} order must survive`);
    await db.close();
  }
});

test('an unpaid order that merely INTENDS a charge (amount_paid_upfront > 0) is still deletable', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  // amount_paid_upfront is populated at order creation and survives a payment
  // failure, so it must never be treated as "money captured".
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-UNPAID', payment_status: 'failed', order_status: 'cancelled',
    items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.product_sizes set stock = stock - 1
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);
  await db.query(`update public.retail_orders set amount_paid_upfront = 448 where id=$1`, [id]);

  const res = await callDelete(db, id);
  assert.equal(res.raised, false, `must delete, got: ${res.message}`);
  assert.equal(res.value, 1);
  assert.equal(await orderExists(db, id), false);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 4, 'unpaid stock must be restored');
});

// ---------------------------------------------------------------------------
// 2. THE INVENTORY GUARD: no deletion may strand a reservation.
// ---------------------------------------------------------------------------

test('an order that still holds stock is refused when restock would decline (terminal statuses)', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  for (const status of ['shipped', 'delivered', 'refunded', 'rto']) {
    const db = await freshDb();
    await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
    const id = await seedOrder(db, {
      ref: `DSL-R-${status.toUpperCase()}`, payment_status: 'pending', order_status: status,
      items: [line(P, C, 'M', 1)],
    });
    await db.query(`update public.product_sizes set stock = stock - 1
                     where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

    const res = await callDelete(db, id);
    assert.equal(res.raised, true, `${status} must be refused`);
    assert.match(res.message, /strand stock/i);
    assert.equal(await orderExists(db, id), true);
    assert.equal((await stockOf(db, P, C, 'M')).stock, 3, 'stock must stay withdrawn, not vanish');
    await db.close();
  }
});

test('a terminal-status order whose stock was ALREADY restored stays deletable', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-RESTORED', payment_status: 'pending', order_status: 'delivered',
    items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.retail_orders set stock_restored_at = now() where id=$1`, [id]);

  const res = await callDelete(db, id);
  assert.equal(res.raised, false, `must delete, got: ${res.message}`);
  assert.equal(res.value, 1);
  assert.equal(await orderExists(db, id), false);
});

// ---------------------------------------------------------------------------
// 3. LEGITIMATE DELETION STILL WORKS (pending / failed / cancelled).
// ---------------------------------------------------------------------------

test('a pending order deletes and its stock is restored exactly once', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 5 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-PENDING', payment_status: 'pending', order_status: 'pending',
    items: [line(P, C, 'M', 2)],
  });
  await db.query(`update public.product_sizes set stock = stock - 2
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 3);

  const res = await callDelete(db, id);
  assert.equal(res.raised, false, `must delete, got: ${res.message}`);
  assert.equal(res.value, 1);
  assert.equal(await orderExists(db, id), false);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 5, 'stock fully restored');
});

test('a COD order that charged nothing online stays deletable', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 5 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-COD', payment_status: 'cod_pending', order_status: 'pending',
    is_cod: true, items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.product_sizes set stock = stock - 1
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  const res = await callDelete(db, id);
  assert.equal(res.raised, false, `must delete, got: ${res.message}`);
  assert.equal(res.value, 1);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 5);
});

test('promo usage is reversed on a legitimate delete', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 5 }]);
  await db.query(`insert into public.promo_codes (code, used_count) values ('DSL100', 3)`);
  const id = await seedOrder(db, {
    ref: 'DSL-R-PROMO', payment_status: 'failed', order_status: 'cancelled',
    promo_code: 'DSL100', items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.product_sizes set stock = stock - 1
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  await callDelete(db, id);
  const pc = (await db.query(`select used_count from public.promo_codes where code='DSL100'`)).rows[0];
  assert.equal(pc.used_count, 2, 'used_count decremented exactly once');
});

// ---------------------------------------------------------------------------
// 4. REPEATED ATTEMPTS AND DUPLICATE RESTORATION.
// ---------------------------------------------------------------------------

test('deleting the same unpaid order twice returns 0 the second time and never double-restocks', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 5 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-TWICE', payment_status: 'failed', order_status: 'cancelled',
    items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.product_sizes set stock = stock - 1
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  const first = await callDelete(db, id);
  assert.equal(first.value, 1);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 5);

  // Second attempt: the row is gone, so the RPC reports "not found" (0) and
  // must NOT run a restock that would inflate stock.
  const second = await callDelete(db, id);
  assert.equal(second.raised, false);
  assert.equal(second.value, 0, 'a missing order returns 0, it does not raise');
  assert.equal((await stockOf(db, P, C, 'M')).stock, 5, 'stock must not be credited twice');
});

test('a paid order stays undeletable however many times the admin retries', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-RETRY', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.product_sizes set stock = stock - 1
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  for (let i = 0; i < 3; i++) {
    const res = await callDelete(db, id);
    assert.equal(res.raised, true, `attempt ${i + 1} must still be refused`);
    assert.equal(await orderExists(db, id), true);
    assert.equal((await stockOf(db, P, C, 'M')).stock, 3);
  }
});

test('restock_retail_order_items still refuses a paid order directly (protection untouched)', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-DIRECT', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.product_sizes set stock = stock - 1
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  const r = await db.query(`select public.restock_retail_order_items($1) as n`, [id]);
  assert.equal(r.rows[0].n, 0, 'the paid-order restock guard must be unchanged');
  assert.equal((await stockOf(db, P, C, 'M')).stock, 3, 'stock must NOT be returned for a paid order');
  assert.equal(await restoredAt(db, id), null, 'stock_restored_at must stay NULL');
});

test('calling restock twice on an unpaid order credits stock exactly once', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-DUP', payment_status: 'failed', order_status: 'cancelled',
    items: [line(P, C, 'M', 2)],
  });
  await db.query(`update public.product_sizes set stock = stock - 2
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  // restock returns the number of product_sizes ROWS updated, not units: one
  // line of quantity 2 touches one row.
  const a = await db.query(`select public.restock_retail_order_items($1) as n`, [id]);
  assert.equal(a.rows[0].n, 1);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 4, 'both units returned');

  const stamp = await restoredAt(db, id);
  assert.notEqual(stamp, null);

  const b = await db.query(`select public.restock_retail_order_items($1) as n`, [id]);
  assert.equal(b.rows[0].n, 0, 'second restock is a no-op');
  assert.equal((await stockOf(db, P, C, 'M')).stock, 4, 'no duplicate credit');
  assert.deepEqual(await restoredAt(db, id), stamp, 'the stamp is never overwritten');
});

// ---------------------------------------------------------------------------
// 5. THE AUTHORIZED TEST-ORDER PATH — narrow, audited, and never restocks.
// ---------------------------------------------------------------------------

test('delete_paid_retail_order refuses an order that was never paid', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-NOTPAID', payment_status: 'failed', order_status: 'cancelled',
    items: [line(P, C, 'M', 1)],
  });

  const res = await callPaidDelete(db, id, 'confirmed sandbox test order', 'no real money captured');
  assert.equal(res.raised, true, 'must not act on an unpaid order');
  assert.match(res.message, /no captured payment/i);
  assert.equal(await orderExists(db, id), true, 'unpaid orders go through delete_retail_order');
});

test('delete_paid_retail_order requires a substantive reason AND attestation', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-NOREASON', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', items: [line(P, C, 'M', 1)],
  });

  for (const [r, a] of [[null, 'sandbox capture, no money'], ['x', 'sandbox capture, no money'],
                        ['confirmed sandbox test order', null],
                        ['confirmed sandbox test order', 'x'],
                        ['', '']]) {
    const res = await callPaidDelete(db, id, r, a);
    assert.equal(res.raised, true, `reason=${r} attest=${a} must be refused`);
    assert.equal(await orderExists(db, id), true);
  }
});

test('delete_paid_retail_order refuses a non-admin caller', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-NONADMIN', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', items: [line(P, C, 'M', 1)],
  });
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [OUTSIDER]);

  const res = await callPaidDelete(db, id, 'confirmed sandbox test order', 'sandbox capture, no money');
  assert.equal(res.raised, true);
  assert.match(res.message, /authorized administrator/i);
  assert.equal(await orderExists(db, id), true);
});

test('delete_paid_retail_order deletes a confirmed test order, snapshots the payment, and NEVER restocks', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-TESTOK', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', items: [line(P, C, 'M', 2)],
  });
  await db.query(`update public.retail_orders
                   set payment_provider='cashfree', payment_id='DSLDSLRTESTOK', total_amount=647
                   where id=$1`, [id]);
  await db.query(`update public.product_sizes set stock = stock - 2
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  const res = await callPaidDelete(
    db, id,
    'Internal Cashfree sandbox order created during checkout testing',
    'Cashfree environment is sandbox; no real funds captured, no refund owed',
  );
  assert.equal(res.raised, false, `must delete, got: ${res.message}`);
  assert.equal(await orderExists(db, id), false, 'the row is gone');

  // The money is NOT returned automatically — that is a separate, deliberate act.
  assert.equal(res.value.stock_restocked, false);
  assert.equal(res.value.stock_still_committed_units, 2);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 2, 'stock stays withdrawn until reconciled');

  // Payment history survives in the audit trail.
  const acts = await activityFor(db, 'DSL-R-TESTOK');
  const snap = acts.find((a) => a.action === 'DELETE_PAID_ORDER');
  assert.ok(snap, 'a DELETE_PAID_ORDER snapshot must be written');
  assert.equal(snap.metadata.payment_status, 'success');
  assert.equal(snap.metadata.payment_id, 'DSLDSLRTESTOK');
  assert.equal(snap.metadata.payment_provider, 'cashfree');
  assert.equal(snap.metadata.total_amount, 647);
  assert.match(snap.metadata.paid_at, /2026-10-05/);
  assert.equal(snap.metadata.stock_still_committed_units, 2);
  assert.equal(snap.metadata.items.length, 1, 'the full items array is preserved');
  assert.match(snap.metadata.reason, /sandbox order/);
});

test('delete_paid_retail_order reverses promo usage on delete', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  await db.query(`insert into public.promo_codes (code, used_count) values ('DSL100', 4)`);
  const id = await seedOrder(db, {
    ref: 'DSL-R-PAIDPROMO', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', promo_code: 'DSL100',
    items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.product_sizes set stock = stock - 1
                   where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

  await callPaidDelete(db, id, 'confirmed sandbox test order', 'sandbox capture, no money');
  const pc = (await db.query(`select used_count from public.promo_codes where code='DSL100'`)).rows[0];
  assert.equal(pc.used_count, 3);
});

test('delete_paid_retail_order refuses a SHIPPED/fulfilled order (never destroys fulfilment records)', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  // The paid path bypasses restock entirely, so without an explicit check it
  // would happily delete a shipped order and destroy the record of goods that
  // physically left the warehouse.
  for (const status of ['shipped', 'delivered', 'refunded', 'rto']) {
    const db = await freshDb();
    await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
    const id = await seedOrder(db, {
      ref: `DSL-R-PAID-${status.toUpperCase()}`, payment_status: 'success',
      order_status: status, paid_at: '2026-10-05 05:52:08+00',
      items: [line(P, C, 'M', 1)],
    });
    await db.query(`update public.product_sizes set stock = stock - 1
                     where product_id=$1 and color_id=$2 and size_label='M'`, [P, C]);

    const res = await callPaidDelete(
      db, id, 'confirmed sandbox test order', 'sandbox capture, no money',
    );
    assert.equal(res.raised, true, `${status} must be refused on the paid path`);
    assert.match(res.message, /fulfilment record/i);
    assert.equal(await orderExists(db, id), true, `${status} order must survive`);
    await db.close();
  }
});

test('delete_paid_retail_order reports zero committed units when stock was already restored', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-PAIDRESTOCKED2', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', items: [line(P, C, 'M', 2)],
  });
  await db.query(`update public.retail_orders set stock_restored_at = now() where id=$1`, [id]);

  const res = await callPaidDelete(
    db, id, 'confirmed sandbox test order', 'sandbox capture, no money',
  );
  assert.equal(res.raised, false, `must delete, got: ${res.message}`);
  assert.equal(res.value.stock_still_committed_units, 0, 'nothing is committed');
  assert.deepEqual(res.value.stock_still_committed, []);
  assert.equal((await stockOf(db, P, C, 'M')).stock, 4, 'stock is untouched');
});

test('a paid order cannot be deleted even if its stock was already restored', async (t) => {
  if (!pglite) return t.skip('PGlite not installed');

  // The financial guard is independent of stock state: a captured payment is
  // payment evidence and must not be deletable via the normal workflow.
  const db = await freshDb();
  await seedStock(db, [{ product_id: P, color_id: C, size_label: 'M', stock: 4 }]);
  const id = await seedOrder(db, {
    ref: 'DSL-R-PAIDRESTORED', payment_status: 'success', order_status: 'processing',
    paid_at: '2026-10-05 05:52:08+00', items: [line(P, C, 'M', 1)],
  });
  await db.query(`update public.retail_orders set stock_restored_at = now() where id=$1`, [id]);

  const res = await callDelete(db, id);
  assert.equal(res.raised, true);
  assert.match(res.message, /captured payment/i);
  assert.equal(await orderExists(db, id), true);
});

// ---------------------------------------------------------------------------
// 6. STRUCTURAL GUARDS — the fix must not be quietly edited away.
// ---------------------------------------------------------------------------

test('the guard migration does not weaken restock_retail_order_items', () => {
  assert.ok(!guardSql.includes('create or replace function public.restock_retail_order_items'),
    'the guard migration must not redefine the restock function at all');

  // The live restock body must still refuse paid and terminal orders.
  assert.match(restockSql, /if v_order\.payment_status = 'success' then\s*\n\s*return 0;/,
    'the paid-order restock guard must remain');
  assert.match(restockSql,
    /if v_order\.order_status in \('shipped', 'delivered', 'refunded', 'rto'\) then\s*\n\s*return 0;/,
    'the terminal-status restock guard must remain');
});

test('the prior vulnerable delete really did delete unconditionally (the incident is reproduced)', () => {
  // Guards against the test passing for the wrong reason: if a future migration
  // removes the guard from BOTH the old and new definitions, this still holds,
  // but if the "old" definition is swapped for a guarded one the incident would
  // silently stop being a regression test.
  assert.ok(!/dslang_order_payment_captured/.test(PRIOR_DELETE_FN),
    'the pre-fix delete must not already contain the financial guard');
  assert.match(PRIOR_DELETE_FN, /perform public\.restock_retail_order_items\(p_order_id\);/);
  assert.match(PRIOR_DELETE_FN, /delete from public\.retail_orders/);
});

test('delete_retail_order keeps its signature, return type and grants', () => {
  assert.match(GUARDED_DELETE_FN,
    /create or replace function public\.delete_retail_order\(p_order_id uuid\)\s*\nreturns integer/);
  assert.match(GUARDED_DELETE_FN, /security definer/);
  assert.match(GUARDED_DELETE_FN, /set search_path = public/);
  assert.match(guardSql, /revoke all on function public\.delete_retail_order\(uuid\) from public;/);
  assert.match(guardSql, /grant execute on function public\.delete_retail_order\(uuid\) to authenticated;/);
  assert.match(guardSql, /revoke execute on function public\.delete_retail_order\(uuid\) from anon;/);
});

test('delete_paid_retail_order is admin-gated, unpaid-refusing, and never restocks', () => {
  assert.match(PAID_DELETE_FN, /security definer/);
  assert.match(PAID_DELETE_FN, /set search_path = public/);
  // admin gate
  assert.match(PAID_DELETE_FN, /not exists \(select 1 from public\.admin_users where user_id = v_actor\)/);
  // it must refuse non-paid orders (scope control, not a general bypass)
  assert.match(PAID_DELETE_FN, /if not public\.dslang_order_payment_captured/);
  // it must never call the restock function
  assert.ok(!PAID_DELETE_FN.includes('restock_retail_order_items'),
    'the authorized path must not restock; inventory is reconciled separately');
  // and it must snapshot payment data before deleting
  assert.match(PAID_DELETE_FN, /DELETE_PAID_ORDER/);
  assert.match(PAID_DELETE_FN, /'payment_id', v_order\.payment_id/);
  assert.match(PAID_DELETE_FN, /'txn_id', v_order\.txn_id/);
  assert.match(PAID_DELETE_FN, /'paid_at', v_order\.paid_at/);
  assert.match(PAID_DELETE_FN, /'items', v_order\.items/);

  assert.match(guardSql, /grant execute on function public\.delete_paid_retail_order\(uuid, text, text\) to authenticated;/);
  assert.match(guardSql, /revoke execute on function public\.delete_paid_retail_order\(uuid, text, text\) from anon;/);
});

test('the payment-captured predicate ignores amount columns', () => {
  // amount_paid_upfront / total_amount appear nowhere in the predicate: they
  // record intent, not capture, and unpaid rows carry non-zero values.
  assert.match(PAYMENT_CAPTURED_FN, /p_paid_at is not null/);
  assert.match(PAYMENT_CAPTURED_FN, /'success', 'paid', 'cod_partial_paid'/);
  assert.ok(!/amount_paid_upfront|total_amount|amount_due_on_delivery/.test(PAYMENT_CAPTURED_FN),
    'the predicate must not read amount columns');
  assert.match(PAYMENT_CAPTURED_FN, /language sql\s*\nimmutable/);
});
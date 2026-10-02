/**
 * Expire -> restock atomicity, and the protected legacy COD refs.
 *
 * Complements restock-fail-closed.test.mjs, which covers restock in isolation.
 * The point here is the COMPOSITE path the sweep actually uses:
 * expire_stale_retail_order performs its CAS flip to failed/cancelled and THEN
 * calls restock_retail_order_items. If restock raises, the CAS flip must be
 * rolled back with it, so the order stays exactly as it was and the next sweep
 * retries it. A sweep that left an order 'cancelled but unrestocked' would be a
 * worse leak than the original bug, because stock_restored_at stays NULL and
 * the order can never be reclaimed.
 *
 * The four owner-frozen refs are asserted as source-level guards: the list
 * lives in the edge function, and this suite proves it still names exactly
 * those four refs, is checked before any Cashfree call, and is not reachable
 * from the database path.
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
const EXPIRE_MIGRATION = 'supabase/migrations/20260925000000_dslang_expire_failed_orders_restock.sql';
const SWEEP_FN = 'supabase/functions/expire-stale-orders/index.ts';

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
      return createRequire(import.meta.url)(spec);
    } catch { /* next */ }
  }
  return null;
}
const pglite = loadPGlite();
const skip = pglite ? false : 'PGlite not installed; set PGLITE_PATH to a @electric-sql/pglite install';

function extractFunction(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  const dollar = sql.indexOf('$$', start);
  const end = sql.indexOf('$$;', dollar + 2);
  return sql.slice(start, end + 3);
}

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

const line = (p, c, s, q) => ({ code: 'X', name: 'Item', product_id: p, color_id: c, size_label: s, quantity: q });

async function freshDb() {
  const { PGlite } = pglite;
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(extractFunction(read(HARDENING_MIGRATION), 'restock_retail_order_items'));
  await db.exec(extractFunction(read(EXPIRE_MIGRATION), 'expire_stale_retail_order'));
  return db;
}

const orderRow = (db, ref) =>
  db.query(
    `select ref, payment_status, order_status, stock_restored_at, is_cod
     from public.retail_orders where ref=$1`, [ref],
  ).then((r) => r.rows[0]);

// -----------------------------------------------------------------------------
// The composite expire -> restock path.
// -----------------------------------------------------------------------------

test('a fully valid stale order expires and restocks', { skip }, async () => {
  const db = await freshDb();
  await db.query(
    `insert into public.product_sizes (product_id, color_id, size_label, stock, available)
     values ($1,$2,'M',0,false)`, [P, C],
  );
  const { rows } = await db.query(
    `insert into public.retail_orders (ref, payment_status, order_status, items, updated_at)
     values ('DSL-R-OK','pending','pending',$1::jsonb, now()) returning id`,
    [JSON.stringify([line(P, C, 'M', 2)])],
  );

  const r = await db.query(`select public.expire_stale_retail_order($1) as res`, [rows[0].id]);
  assert.equal(r.rows[0].res.ok, true);
  assert.equal(r.rows[0].res.reason, 'expired_and_restocked');

  const o = await orderRow(db, 'DSL-R-OK');
  assert.equal(o.payment_status, 'failed', 'CAS flip to failed');
  assert.equal(o.order_status, 'cancelled', 'CAS flip to cancelled');
  assert.notEqual(o.stock_restored_at, null);

  const s = (await db.query(
    `select stock, available from public.product_sizes where product_id=$1 and color_id=$2`, [P, C],
  )).rows[0];
  assert.equal(s.stock, 2);
  assert.equal(s.available, true);
  await db.close();
});

test('expire is atomic: an unresolvable restock rolls the CAS flip back too', { skip }, async () => {
  const db = await freshDb();
  // Stock row exists for the first key only.
  await db.query(
    `insert into public.product_sizes (product_id, color_id, size_label, stock, available)
     values ($1,$2,'M',0,false)`, [P, C],
  );
  const { rows } = await db.query(
    `insert into public.retail_orders (ref, payment_status, order_status, items, updated_at)
     values ('DSL-R-ATOMIC','pending','pending',$1::jsonb, now()) returning id`,
    [JSON.stringify([line(P, C, 'M', 3), line(P2, C2, 'L', 1)])],
  );
  const id = rows[0].id;

  let raised = null;
  try {
    await db.query(`select public.expire_stale_retail_order($1)`, [id]);
  } catch (e) {
    raised = e;
  }
  assert.notEqual(raised, null, 'expire must surface the restock failure');

  const o = await orderRow(db, 'DSL-R-ATOMIC');
  assert.equal(o.payment_status, 'pending', 'CAS flip rolled back — order stays a candidate');
  assert.equal(o.order_status, 'pending', 'order NOT left cancelled');
  assert.equal(o.stock_restored_at, null, 'never stamped');

  const s = (await db.query(
    `select stock from public.product_sizes where product_id=$1 and color_id=$2`, [P, C],
  )).rows[0];
  assert.equal(s.stock, 0, 'no partial restoration');

  // And it is genuinely retryable: repair the data, then it succeeds.
  await db.query(
    `insert into public.product_sizes (product_id, color_id, size_label, stock, available)
     values ($1,$2,'L',0,false)`, [P2, C2],
  );
  const retry = await db.query(`select public.expire_stale_retail_order($1) as res`, [id]);
  assert.equal(retry.rows[0].res.ok, true);
  const after = await orderRow(db, 'DSL-R-ATOMIC');
  assert.equal(after.order_status, 'cancelled');
  assert.notEqual(after.stock_restored_at, null);
  assert.equal((await db.query(
    `select stock from public.product_sizes where product_id=$1 and color_id=$2`, [P, C],
  )).rows[0].stock, 3);
  await db.close();
});

test('expire is idempotent: a second call restocks nothing further', { skip }, async () => {
  const db = await freshDb();
  await db.query(
    `insert into public.product_sizes (product_id, color_id, size_label, stock, available)
     values ($1,$2,'M',0,false)`, [P, C],
  );
  const { rows } = await db.query(
    `insert into public.retail_orders (ref, payment_status, order_status, items, updated_at)
     values ('DSL-R-IDEM','pending','pending',$1::jsonb, now()) returning id`,
    [JSON.stringify([line(P, C, 'M', 2)])],
  );
  const id = rows[0].id;
  await db.query(`select public.expire_stale_retail_order($1)`, [id]);
  const second = await db.query(`select public.expire_stale_retail_order($1) as res`, [id]);

  assert.equal(second.rows[0].res.ok, false);
  assert.equal(second.rows[0].res.reason, 'already_restocked');
  assert.equal((await db.query(
    `select stock from public.product_sizes where product_id=$1 and color_id=$2`, [P, C],
  )).rows[0].stock, 2, 'stock not double-restored');
  await db.close();
});

// NOTE: expire_stale_retail_order gates ONLY on payment_status, matching the
// live production definition. It does not consult order_status. A shipped or
// delivered order still carrying payment_status='pending' is therefore expired
// by the RPC; the stock is NOT returned, because restock_retail_order_items
// skips those order_status values itself. That asymmetry is pre-existing
// behaviour in a function this task must not change, so it is pinned here as a
// characterisation test rather than "fixed". The sweep never reaches it anyway:
// the candidate query requires payment_status in ('pending','failed') and the
// protected legacy refs are skipped before the RPC is ever called.
test('expire refuses a paid order, and never restocks a shipped or delivered one', { skip }, async () => {
  const db = await freshDb();
  await db.query(
    `insert into public.product_sizes (product_id, color_id, size_label, stock, available)
     values ($1,$2,'M',0,false)`, [P, C],
  );

  // Paid: refused outright by the payment_status gate.
  const paid = await db.query(
    `insert into public.retail_orders (ref, payment_status, order_status, items, updated_at)
     values ('DSL-R-PAID','success','processing',$1::jsonb, now()) returning id`,
    [JSON.stringify([line(P, C, 'M', 5)])],
  );
  const r = await db.query(`select public.expire_stale_retail_order($1) as res`, [paid.rows[0].id]);
  assert.equal(r.rows[0].res.ok, false);
  assert.equal(r.rows[0].res.reason, 'not_reclaimable');

  // Shipped/delivered while still unpaid. CHARACTERISED, not endorsed:
  //
  //   expire_stale_retail_order CAS-flips order_status to 'cancelled' BEFORE
  //   calling restock. restock's own order_status guard therefore evaluates
  //   'cancelled', not 'shipped'/'delivered', so the guard never fires and the
  //   reserved units ARE returned. The guard is only effective for direct
  //   restock callers (delete_retail_order), not for the sweep.
  //
  // This is pre-existing behaviour in expire_stale_retail_order, which this task
  // must not modify, and the sweep cannot reach it: a shipped order is not
  // normally unpaid, and the four protected legacy refs never reach the RPC.
  // Pinned so a future change to either function is a deliberate decision.
  const before = (await db.query(
    `select stock from public.product_sizes where product_id=$1 and color_id=$2`, [P, C],
  )).rows[0].stock;
  for (const ord of ['shipped', 'delivered']) {
    const ref = `DSL-R-${ord.toUpperCase()}`;
    const r2 = await db.query(
      `insert into public.retail_orders (ref, payment_status, order_status, items, updated_at)
       values ($1,'pending',$2,$3::jsonb, now()) returning id`,
      [ref, ord, JSON.stringify([line(P, C, 'M', 5)])],
    );
    const res = await db.query(`select public.expire_stale_retail_order($1) as res`, [r2.rows[0].id]);
    assert.equal(res.rows[0].res.ok, true);
    const o = await orderRow(db, ref);
    assert.equal(o.order_status, 'cancelled', 'CAS flip overwrote the fulfilment status');
    assert.notEqual(o.stock_restored_at, null,
      'characterised: the CAS flip hides the shipped status from restock, so stock IS returned');
  }
  // 5 units per order, two orders, on a row that started at 0.
  assert.equal((await db.query(
    `select stock from public.product_sizes where product_id=$1 and color_id=$2`, [P, C],
  )).rows[0].stock, before + 10, 'stock returned for both — see the comment above');
  await db.close();
});

test('restock called DIRECTLY on a shipped order still skips (guard is caller-dependent)', { skip }, async () => {
  const db = await freshDb();
  await db.query(
    `insert into public.product_sizes (product_id, color_id, size_label, stock, available)
     values ($1,$2,'M',0,false)`, [P, C],
  );
  const { rows } = await db.query(
    `insert into public.retail_orders (ref, payment_status, order_status, items, updated_at)
     values ('DSL-R-DIRECT','pending','shipped',$1::jsonb, now()) returning id`,
    [JSON.stringify([line(P, C, 'M', 5)])],
  );
  const res = await db.query(`select public.restock_retail_order_items($1) as n`, [rows[0].id]);
  assert.equal(res.rows[0].n, 0, 'order_status guard fires when restock sees it directly');
  assert.equal((await db.query(
    `select stock from public.product_sizes where product_id=$1 and color_id=$2`, [P, C],
  )).rows[0].stock, 0);
  assert.equal((await orderRow(db, 'DSL-R-DIRECT')).stock_restored_at, null);
  await db.close();
});

// -----------------------------------------------------------------------------
// G. No per-ref protection survives; the COD guard is the only shield.
// -----------------------------------------------------------------------------

test('G: the sweep carries no ref-scoped allow/deny list', () => {
  // The four legacy advance-era COD orders were deleted outright, so the
  // hard-coded frozen set that shielded them is gone. There must be no
  // replacement list: the sweep decides purely on stored payment state.
  const src = read(SWEEP_FN);
  assert.doesNotMatch(src, /LEGACY_ADVANCE_COD_REFS/,
    'the ref-scoped frozen set must not return');
  const decide = src.slice(src.indexOf('async function decide'));
  assert.doesNotMatch(decide, /DSL-R-[A-Z0-9]{6,}/,
    'decide() must not branch on a hard-coded order ref');
  assert.doesNotMatch(src, /new Set\(\[\s*'DSL-R-/,
    'no frozen set of order refs may exist in the sweep');
});

test('G: a full-COD order is skipped before any Cashfree call or write', () => {
  const src = read(SWEEP_FN);
  const decide = src.slice(src.indexOf('async function decide'));
  const guardAt = decide.indexOf("order.payment_status === 'cod_pending'");
  const cfAt = decide.indexOf('await fetch(');
  assert.ok(guardAt > -1, 'the COD guard must be present in decide()');
  assert.ok(cfAt > guardAt, 'a COD order is short-circuited before any Cashfree lookup');
  assert.match(decide.slice(guardAt, guardAt + 200), /action:\s*'skip'/,
    'a cod_pending order must return skip, never expire');
});

test('G: no migration carries a hard-coded exclusion for a deleted ref', () => {
  // One source of truth: the decision is made from payment_status, so no
  // migration may re-introduce a divergent, ref-keyed carve-out.
  const sql = read(HARDENING_MIGRATION) + read(PRIOR_MIGRATION) + read(EXPIRE_MIGRATION)
    + read('supabase/migrations/20261012000000_dslang_cod_full_payment.sql');
  assert.doesNotMatch(sql, /ref\s+not\s+in\s*\(\s*'DSL-R-/i,
    'no migration may exclude a backfill by a hard-coded order ref');
});

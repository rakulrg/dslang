// =============================================================================
// retail-order-update-policy.test.mjs
// =============================================================================
// Database-LEVEL security tests for public.retail_orders.
//
// These deliberately do NOT regex-match SQL text. They build a PGlite database
// that reproduces the live production schema (the real policies, the real
// maintenance triggers, the real table-level default grant), apply the REAL
// migration files, and then execute attacker statements as the real roles and
// assert on what actually changed.
//
// Reproduces, from production, on 2026-09-28:
//   - pg_default_acl / role_table_grants: table-level ALL to anon/authenticated,
//     which is what makes `grant update (user_id)` inert.
//   - pg_policy: retail_orders_select_admin, retail_orders_select_owner,
//     retail_orders_update_admin, retail_orders_update_owner_claim.
//   - triggers retail_orders_set_updated_at and admin_log_order_changes.
//
// Covers: A-T of the manual-shipping blocker remediation.
// =============================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIG = 'supabase/migrations/';
// The section markers below contain hard-coded "\n", so a checkout that rewrites
// line endings (git autocrlf) would make indexOf() return -1 and silently empty
// every slice. Normalise to LF on read so this file is line-ending agnostic.
const readMigrations = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const SHIPPING = readMigrations(MIG + '20261015000000_dslang_manual_courier_shipping.sql');
const HARDENING = readMigrations(MIG + '20261017000000_dslang_retail_order_update_hardening.sql');
const COD = readMigrations(MIG + '20261012000000_dslang_cod_full_payment.sql');

// The REAL customer-facing checkout function, taken verbatim from the migration
// that defines it. It is live in production (out of band) and writes exactly the
// financial columns the new guard watches, so it is the one thing most likely to
// be broken by the guard -- and the one thing a customer would notice first.
const CONVERT_TO_COD = (() => {
  const from = 'create or replace function public.convert_retail_order_to_cod(';
  const a = COD.indexOf(from);
  const b = COD.indexOf('$$;', a) + 3;
  assert.notEqual(a, -1, 'convert_retail_order_to_cod not found in migration 12');
  return COD.slice(a, b)
    + '\ngrant execute on function public.convert_retail_order_to_cod(text, text) to anon, authenticated;';
})();

// A slice that resolved to nothing is a harness bug, not a test failure; make it
// loud so it can never again masquerade as a database problem.
const slice = (from, to) => {
  const a = SHIPPING.indexOf(from);
  const b = SHIPPING.indexOf(to, a + from.length);
  assert.notEqual(a, -1, `slice start marker not found in migration 15: ${JSON.stringify(from)}`);
  assert.ok(b > a, `slice end marker not found after start: ${JSON.stringify(to)}`);
  return SHIPPING.slice(a, b);
};

// Same, but the end marker is the last thing wanted (the trigger statement that
// ends with the function call), so it is included rather than cut off.
const sliceThrough = (from, end) => {
  const a = SHIPPING.indexOf(from);
  const b = SHIPPING.indexOf(end, a + from.length);
  assert.notEqual(a, -1, `slice start marker not found: ${JSON.stringify(from)}`);
  assert.ok(b > a, `slice end marker not found after start: ${JSON.stringify(end)}`);
  return SHIPPING.slice(a, b + end.length);
};

// -----------------------------------------------------------------------------
// Fixture: production schema shape, reproduced faithfully.
// -----------------------------------------------------------------------------
const FIXTURE = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon')         then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role')  then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);

-- Supabase's auth.uid() reads the request JWT; mirror both GUC spellings.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid)
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true)::json->>'role', ''))
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth, public to anon, authenticated, service_role;

create table if not exists public.admin_users (user_id uuid primary key);

create table if not exists public.admin_activity (
  id bigint generated always as identity primary key,
  actor_id uuid, actor_email text, action text not null,
  entity text not null, entity_id text, entity_ref text,
  metadata jsonb, created_at timestamptz not null default now()
);

create table if not exists public.retail_orders (
  id uuid primary key default gen_random_uuid(),
  ref text,
  order_type text not null default 'retail',
  order_status text not null default 'pending',
  payment_status text not null default 'pending',
  is_cod boolean not null default false,
  total_amount numeric not null default 0,
  total_qty integer not null default 0,
  subtotal numeric not null default 0,
  discount numeric not null default 0,
  shipping numeric not null default 0,
  amount_paid_upfront numeric not null default 0,
  amount_due_on_delivery numeric not null default 0,
  payment_discount numeric not null default 0,
  payment_provider text,
  payment_id text,
  txn_id text,
  paid_at timestamptz,
  user_id uuid,
  stock_restored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  customer jsonb,
  items jsonb,
  auto_ship_at timestamptz,
  courier_name text, awb_number text, tracking_id text, tracking_url text,
  shipped_at timestamptz, shipping_provider text, ship_source text, label_url text,
  tracking_current_status text, tracking_location text, tracking_scans jsonb
);

-- The schema's default privileges auto-grant table-level ALL to the API roles.
-- This is the grant that makes the column-level "update (user_id)" a no-op.
grant all on public.retail_orders to anon, authenticated, service_role;
grant all on public.admin_users to authenticated, service_role;
grant all on public.admin_activity to authenticated, service_role;

alter table public.retail_orders enable row level security;

create policy retail_orders_select_admin on public.retail_orders for select to authenticated
  using (exists (select 1 from admin_users where user_id = auth.uid()));
create policy retail_orders_select_owner on public.retail_orders for select to authenticated
  using (user_id = auth.uid() or (user_id is null
    and coalesce(auth.jwt()->>'email','') <> ''
    and lower(coalesce(customer->>'email','')) = lower(auth.jwt()->>'email')));
create policy retail_orders_update_admin on public.retail_orders for update to authenticated
  using (exists (select 1 from admin_users where user_id = auth.uid()))
  with check (exists (select 1 from admin_users where user_id = auth.uid()));
create policy retail_orders_update_owner_claim on public.retail_orders for update to authenticated
  using (user_id is null and coalesce(auth.jwt()->>'email','') <> ''
     and lower(coalesce(customer->>'email','')) = lower(auth.jwt()->>'email'))
  with check (user_id = auth.uid());

-- verbatim from 20260904000000
create or replace function public.set_retail_order_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
create trigger retail_orders_set_updated_at before update on public.retail_orders
  for each row execute function public.set_retail_order_updated_at();

create or replace function public.record_admin_activity(
  p_action text, p_entity text, p_entity_id text, p_entity_ref text, p_metadata jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.admin_activity (action, entity, entity_id, entity_ref, metadata)
  values (p_action, p_entity, p_entity_id, p_entity_ref, p_metadata) $$;

-- verbatim shape from 20261005000000
create or replace function public.log_order_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_meta jsonb;
begin
  v_meta := jsonb_build_object('order_status', new.order_status, 'payment_status', new.payment_status,
    'total', new.total_amount, 'is_cod', coalesce(new.is_cod, false));
  if tg_op = 'INSERT' then
    perform public.record_admin_activity('CREATE','order',new.id::text,new.ref,v_meta); return new;
  elsif tg_op = 'UPDATE' then
    if new.order_status is distinct from old.order_status then
      perform public.record_admin_activity('STATUS','order',new.id::text,new.ref,v_meta);
    else
      perform public.record_admin_activity('UPDATE','order',new.id::text,new.ref,v_meta);
    end if;
    return new;
  else
    perform public.record_admin_activity('DELETE','order',old.id::text,old.ref,jsonb_build_object()); return old;
  end if;
exception when others then return coalesce(new, old);
end; $$;
create trigger admin_log_order_changes after insert or update or delete on public.retail_orders
  for each row execute function public.log_order_activity();

-- the throttle helper track_order_shipping depends on. It returns TRUE when the
-- lookup is still allowed, FALSE once the caller is throttled, so a
-- never-throttled stub returns true.
create or replace function public.dslang_track_lookup_register_failure(p_ref text)
returns boolean language sql security definer set search_path = public as $$ select true $$;

-- track_order_shipping clears the throttle ledger on a successful match.
create table if not exists public.dslang_track_lookup_attempts (
  ref_hash text primary key, attempts int not null default 0, last_attempt_at timestamptz
);
`;

// The exact shape of the 3 rows remaining in production on 2026-09-29.
// The four legacy advance-era COD orders (DSL-R-645FF459, DSL-R-63B2BF85,
// DSL-R-F90D73F1, DSL-R-5DB828BF) were deleted outright and are no longer seeded.
const PROD_ROWS = [
  { ref: 'DSL-R-4F5BE4E0', order_status: 'processing', payment_status: 'success', awb: null },
  { ref: 'DSL-R-91ECFC7F', order_status: 'processing', payment_status: 'success', awb: null },
  { ref: 'DSL-R-B4C7C887', order_status: 'delivered',  payment_status: 'success', awb: null },
];

// ---- migration-15 slices, located by their own markers -----------------------
const COLS_AND_BACKFILL = slice(
  'alter table public.retail_orders\n  add column if not exists shipping_status',
  '-- 2) delivered_at');
const DELIVERED_AND_CONSTRAINT = slice(
  'alter table public.retail_orders\n  add column if not exists delivered_at',
  '-- 4) admin_set_order_shipping');
const GUARD = sliceThrough(
  'create or replace function public.retail_orders_guard_shipping_writes()',
  'execute function public.retail_orders_guard_shipping_writes();');
const REVOKES = slice(
  'revoke update on public.retail_orders from anon;',
  'create or replace function public.retail_orders_guard_shipping_writes()');
const ADMIN_RPC = slice('create or replace function public.admin_set_order_shipping(', '-- 5) track_order_shipping');
const TRACKING = slice('create or replace function public.track_order_shipping(', '-- 6) Grants');

// ---- helpers ----------------------------------------------------------------
const asRole = (db, role, claims) => async (sql) => {
  await db.exec(`set role ${role}`);
  // Always (re)write the claim, or a previous role's JWT leaks into this call.
  await db.exec(
    `select set_config('request.jwt.claims','${JSON.stringify({ role, ...(claims || {}) })}',false)`);
  try { const r = await db.query(sql); return { ok: true, n: r.rowCount, rows: r.rows }; }
  catch (e) { return { ok: false, n: 0, err: (e.message || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || String(e), code: e.code }; }
  finally { await db.exec('reset role'); }
};

// Runs as the table owner (superuser, so RLS is bypassed) but wearing a
// CUSTOMER's JWT. Nothing but the BEFORE UPDATE triggers can stop a write in
// this context, which is how the two guard layers are tested independently.
const asOwnerWearingCustomer = (db, claims) => async (sql) => {
  await db.exec(`select set_config('request.jwt.claims','${JSON.stringify(claims)}',false)`);
  try { const r = await db.query(sql); return { ok: true, n: r.rowCount, rows: r.rows }; }
  catch (e) { return { ok: false, n: 0, err: e.message.split('\n')[0], code: e.code }; }
  finally { await db.exec(`select set_config('request.jwt.claims','{}',false)`); }
};

const seedOrder = async (db, { ref, email, userId = null, awb = null, orderStatus = 'pending', cod = true, paymentStatus = 'cod_pending', dueOnDelivery = 1000 }) => {
  const id = (await db.query(
    `insert into public.retail_orders
       (ref,order_status,payment_status,is_cod,total_amount,amount_paid_upfront,amount_due_on_delivery,
        customer,items,user_id,awb_number,updated_at)
     values ($1,$2,$3,$4,1000,0,$5,$6::jsonb,'[]'::jsonb,$7,$8,'2020-01-01 00:00:00+00')
     returning id`,
    [ref, orderStatus, paymentStatus, cod, dueOnDelivery,
      JSON.stringify({ email, phone: '9999999999', name: 'X' }), userId, awb])).rows[0].id;
  await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
  await db.query(`update public.retail_orders set shipping_status = 'shipped' where id = $1`, [id]);
  await db.exec(`select set_config('request.jwt.claims','{}',false)`);
  return id;
};

const rowOf = async (db, id) => (await db.query(
  `select order_status, payment_status, is_cod, total_amount, amount_paid_upfront,
          amount_due_on_delivery,
          stock_restored_at, order_type, user_id::text, customer::text, items::text,
          courier_name, awb_number, shipping_status, tracking_url,
          auto_ship_at::text, shipped_at::text, delivered_at::text
     from public.retail_orders where id = $1`, [id])).rows[0];

// =============================================================================
// Database A -- Blocker A (the policy) + shipping interactions
// =============================================================================
let db, asCustomer, asStranger, asAnon, asAdmin, asService;
const VICTIM = { ref: 'DSL-R-TEST-1', email: 'victim@shop.test' };
const CUSTOMER = 'bbbbbbbb-0000-4000-8000-000000000002';
const STRANGER = 'cccccccc-0000-4000-8000-000000000003';
const ADMIN = 'dddddddd-0000-4000-8000-000000000004';
let victimId;

before(async () => {
  db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(COLS_AND_BACKFILL);
  await db.exec(DELIVERED_AND_CONSTRAINT);
  await db.exec(ADMIN_RPC);
  await db.exec(GUARD);
    await db.exec(CONVERT_TO_COD);
    await db.exec(REVOKES);
    await db.exec(TRACKING);
    await db.exec(HARDENING); // the corrective migration under test

  await db.query('insert into auth.users values ($1,$2),($3,$4),($5,$6)',
    [CUSTOMER, VICTIM.email, STRANGER, 'stranger@evil.test', ADMIN, 'admin@shop.test']);
  await db.query('insert into public.admin_users (user_id) values ($1)', [ADMIN]);

  victimId = await seedOrder(db, { ref: VICTIM.ref, email: VICTIM.email, awb: 'REAL-AWB-001' });

  asCustomer = asRole(db, 'authenticated', { sub: CUSTOMER, email: VICTIM.email });
  asStranger = asRole(db, 'authenticated', { sub: STRANGER, email: 'stranger@evil.test' });
  asAdmin = asRole(db, 'authenticated', { sub: ADMIN, email: 'admin@shop.test' });
  asService = asRole(db, 'service_role', null);
  asAnon = asRole(db, 'anon', null);
});

after(async () => { if (db) await db.close(); });

// Every one of these runs against a FRESH unclaimed guest order owned by the
// caller's own email, so the only thing that can reject it is the database.
const attack = async (label, setClause) => {
  const id = await seedOrder(db, { ref: 'DSL-R-ATK-' + Math.random().toString(36).slice(2, 8), email: VICTIM.email });
  const before = await rowOf(db, id);
  const r = await asCustomer(
    `update public.retail_orders set ${setClause} where id = '${id}'`);
  const after = await rowOf(db, id);
  const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const beyond = changed.filter((k) => k !== 'user_id');
  return { r, before, after, changed, beyond };
};

// A write is "blocked" if it either raised, or matched zero rows. Dropping the
// claim policy means RLS filters the row out (rows=0, BEFORE UPDATE never
// fires); the guard trigger raises instead when a policy does let the row
// through. Either is a refusal, and the invariant that matters is the same in
// both cases: the protected columns must not move.
const expectBlocked = (label, res) => {
  assert.ok(!res.r.ok || res.r.n === 0,
    `${label}: the write took effect (rows=${res.r.n}, no error) but must be refused`);
  assert.deepEqual(res.beyond, [], `${label}: column(s) ${res.beyond} changed despite the block`);
};

// ---- A-G: payment / lifecycle / stock fields --------------------------------
test('A. customer cannot UPDATE order_status', async () => {
  const res = await attack('order_status', `user_id = '${CUSTOMER}', order_status = 'delivered'`);
  expectBlocked('A', res);
});

test('B. customer cannot UPDATE payment_status', async () => {
  const res = await attack('payment_status', `user_id = '${CUSTOMER}', payment_status = 'success'`);
  expectBlocked('B', res);
});

test('C. customer cannot UPDATE stock_restored_at  (CRITICAL STOCK RULE)', async () => {
  const res = await attack('stock_restored_at', `user_id = '${CUSTOMER}', stock_restored_at = now()`);
  expectBlocked('C', res);
  assert.equal(res.after.stock_restored_at, null, 'stock_restored_at must still be NULL');
});

test('D. customer cannot UPDATE amount_due_on_delivery', async () => {
  const res = await attack('amount_due_on_delivery',
    `user_id = '${CUSTOMER}', amount_due_on_delivery = 0, amount_paid_upfront = 0`);
  expectBlocked('D', res);
});

test('E. customer cannot UPDATE total_amount', async () => {
  const res = await attack('total_amount', `user_id = '${CUSTOMER}', total_amount = 1`);
  expectBlocked('E', res);
});

test('F. customer cannot UPDATE is_cod', async () => {
  const res = await attack('is_cod', `user_id = '${CUSTOMER}', is_cod = false`);
  expectBlocked('F', res);
});

test('G. customer cannot UPDATE order_type', async () => {
  const res = await attack('order_type', `user_id = '${CUSTOMER}', order_type = 'preorder'`);
  expectBlocked('G', res);
});

// ---- H: customer / items JSON ----------------------------------------------
test('H. customer cannot UPDATE the customer or items JSON', async () => {
  const res = await attack('customer/items',
    `user_id = '${CUSTOMER}', customer = '{"email":"attacker@evil.test","phone":"0"}'::jsonb, items = '[]'::jsonb`);
  expectBlocked('H', res);
});

// ---- I: the legitimate claim flow still works -------------------------------
test('I. the legitimate claim flow still works (via the RPC)', async () => {
  const id = await seedOrder(db, { ref: 'DSL-R-CLAIM-OK', email: VICTIM.email });
  const r = await asCustomer(`select public.claim_retail_guest_order('DSL-R-CLAIM-OK') as res`);
  assert.ok(r.ok, `claim RPC failed: ${r.err}`);
  assert.equal(r.rows[0].res.claimed, 1, 'exactly one order should be claimed');
  assert.equal((await rowOf(db, id)).user_id, CUSTOMER, 'the order must now belong to the caller');
});

test('I2. the bulk claim path works and is bound to the caller JWT', async () => {
  await seedOrder(db, { ref: 'DSL-R-BULK-1', email: VICTIM.email });
  await seedOrder(db, { ref: 'DSL-R-BULK-2', email: VICTIM.email });
  const r = await asCustomer('select public.claim_retail_guest_order(null) as res');
  assert.ok(r.ok, `bulk claim failed: ${r.err}`);
  assert.ok(r.rows[0].res.claimed >= 2, 'both guest orders should be claimed');
  // A stranger claiming the same shape must get nothing.
  const id = await seedOrder(db, { ref: 'DSL-R-BULK-3', email: 'someone-else@shop.test' });
  const s = await asStranger(`select public.claim_retail_guest_order('DSL-R-BULK-3') as res`);
  assert.ok(s.ok);
  assert.equal(s.rows[0].res.claimed, 0, 'a stranger must not claim another email\'s order');
  assert.equal((await rowOf(db, id)).user_id, null);
});

// ---- J: stranger -----------------------------------------------------------
test('J. a stranger with another email gets 0 rows and cannot update', async () => {
  const before = await rowOf(db, victimId);
  const sel = await asStranger(`select * from public.retail_orders where id = '${victimId}'`);
  assert.equal(sel.n, 0, 'stranger must not see the row');
  const upd = await asStranger(
    `update public.retail_orders set user_id='${STRANGER}', order_status='delivered' where id='${victimId}'`);
  assert.equal(upd.n, 0, 'stranger must match zero rows');
  assert.deepEqual(await rowOf(db, victimId), before, 'row unchanged');
});

// ---- K: anonymous ----------------------------------------------------------
test('K. an anonymous session cannot update the table at all', async () => {
  const r = await asAnon(
    `update public.retail_orders set order_status='delivered' where id='${victimId}'`);
  assert.ok(!r.ok, 'anon UPDATE must be denied');
  const g = await asAnon(`select * from public.retail_orders where id='${victimId}'`);
  assert.ok(!g.ok || g.n === 0, 'anon must not read orders');
});

// ---- L/M/N: shipping -------------------------------------------------------
test('L. admin shipping update still works (direct write + the admin RPC)', async () => {
  // The Admin UI writes shipping through admin_set_order_shipping.
  const r = await asAdmin(
    `select public.admin_set_order_shipping('${victimId}','Delhivery','AWB-777','https://d.example/x','shipped') as res`);
  assert.ok(r.ok, `admin shipping RPC failed: ${r.err}`);
  const row = await rowOf(db, victimId);
  assert.equal(row.awb_number, 'AWB-777', 'AWB must be written');
  assert.equal(row.shipping_status, 'shipped', 'shipping_status must be written');
  assert.equal(row.order_status, 'shipped', 'order_status projection must follow');
});

test('M. customer shipping update is rejected', async () => {
  const id = await seedOrder(db, { ref: 'DSL-R-SHIP-ATK', email: VICTIM.email, awb: 'REAL-AWB-002' });
  const before = await rowOf(db, id);
  for (const set of [
    `user_id='${CUSTOMER}', awb_number='FAKE-999'`,
    `user_id='${CUSTOMER}', shipping_status='delivered'`,
    `user_id='${CUSTOMER}', courier_name='FreeShip'`,
    `user_id='${CUSTOMER}', tracking_url='javascript:alert(1)'`,
  ]) {
    const r = await asCustomer(`update public.retail_orders set ${set} where id='${id}'`);
    assert.ok(!r.ok || r.n === 0, `customer shipping write must be refused: ${set}`);
    if (!r.ok) {
      // Both guards can fire; alphabetically the customer guard goes first.
      assert.match(r.err, /administrator|contact the store/i, `unexpected rejection: ${r.err}`);
    }
  }
  assert.deepEqual(await rowOf(db, id), before, 'no shipping column may move');
});

test('N. shipping lookup stays possession-gated', async () => {
  const wrong = await asAnon(`select public.track_order_shipping('${VICTIM.ref}','0000000000') as res`);
  assert.ok(wrong.ok);
  assert.equal(wrong.rows[0].res.ok, false, 'a wrong phone must be denied');
  assert.equal(wrong.rows[0].res.reason, 'We could not find an order matching that reference and phone number. Please check both and try again.');

  const right = await asAnon(`select public.track_order_shipping('${VICTIM.ref}','9999999999') as res`);
  assert.ok(right.ok);
  assert.equal(right.rows[0].res.ok, true, 'the true phone must return the order');
  const body = JSON.stringify(right.rows[0].res);
  assert.ok(!body.includes('victim@shop.test'), 'must be PII-free: no email');
  assert.ok(!body.includes('9999999999'), 'must be PII-free: no phone');
});

// ---- 8: user_id cannot be re-pointed after claim ---------------------------
test('user_id cannot be changed after the claim', async () => {
  const id = await seedOrder(db, { ref: 'DSL-R-REPOINT', email: VICTIM.email });
  await asCustomer(`select public.claim_retail_guest_order('DSL-R-REPOINT')`);
  assert.equal((await rowOf(db, id)).user_id, CUSTOMER);
  const r = await asCustomer(`update public.retail_orders set user_id='${STRANGER}' where id='${id}'`);
  assert.ok(!r.ok || r.n === 0, 're-pointing user_id must not be possible');
  assert.equal((await rowOf(db, id)).user_id, CUSTOMER, 'ownership must be unchanged');
});

// ---- 11: service_role operational path -------------------------------------
test('service_role can still write every operational column', async () => {
  const id = await seedOrder(db, { ref: 'DSL-R-SVC', email: VICTIM.email });
  const r = await asService(
    `update public.retail_orders set order_status='shipped', payment_status='success', awb_number='SVC-1' where id='${id}'`);
  assert.ok(r.ok && r.n === 1, `service_role write must succeed: ${r.err}`);
  const row = await rowOf(db, id);
  assert.equal(row.order_status, 'shipped');
  assert.equal(row.awb_number, 'SVC-1');
});

// ---- T: restock cannot be bypassed -----------------------------------------
// ---- defence in depth: the two guards are independently effective ---------
test('the two guard layers are independently effective', async () => {
  // Remove layer 1 (the customer column guard) entirely and confirm migration
  // 15's shipping guard alone still refuses the customer. This proves the
  // shipping columns are not relying on the new guard, and vice versa.
  const c = new PGlite();
  try {
    await c.exec(FIXTURE);
    await c.exec(COLS_AND_BACKFILL);
    await c.exec(DELIVERED_AND_CONSTRAINT);
    await c.exec(ADMIN_RPC);
    await c.exec(GUARD);
    await c.exec(HARDENING);
    await c.query('insert into auth.users values ($1,$2)', [CUSTOMER, VICTIM.email]);
    // The customer JSON must carry the victim's email: the guard only allows a
    // bare claim when the order's own email matches the caller's JWT.
    const id = (await c.query(
      `insert into public.retail_orders (ref,customer,awb_number)
       values ('DSL-R-DD', jsonb_build_object('email',$1::text,'phone','9999999999'), 'REAL-1')
       returning id`, [VICTIM.email])).rows[0].id;
    await c.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await c.query(`update public.retail_orders set shipping_status='shipped' where id=$1`, [id]);
    await c.exec(`select set_config('request.jwt.claims','{}',false)`);

    // Isolate the trigger layer. A permissive policy lets the row through RLS, so
    // the BEFORE UPDATE trigger is the only thing that can refuse the write --
    // which is exactly the "someone re-adds a policy by mistake" scenario.
    // (Running as the table owner would NOT test this: the guard deliberately
    // defers to SECURITY DEFINER / owner contexts, which is what keeps
    // convert_retail_order_to_cod working.)
    await c.exec(`create policy test_permissive_update on public.retail_orders
      for update to authenticated using (true) with check (true)`);
    const owner = asRole(c, 'authenticated', { sub: CUSTOMER, email: VICTIM.email });

    // Both layers installed: refused.
    const both = await owner(`update public.retail_orders set user_id='${CUSTOMER}', awb_number='X1' where id='${id}'`);
    assert.ok(!both.ok, 'with both guards the write must be refused');

    // Layer 1 removed: migration 15's shipping guard alone still refuses.
    await c.exec('drop trigger retail_orders_guard_customer_writes on public.retail_orders');
    const shippingOnly = await owner(`update public.retail_orders set user_id='${CUSTOMER}', awb_number='X2' where id='${id}'`);
    assert.ok(!shippingOnly.ok, 'the shipping guard alone must refuse the shipping column');
    assert.match(shippingOnly.err, /administrator/i);

    // Layer 2 removed and layer 1 re-created: layer 1 alone still refuses a
    // NON-shipping field that layer 2 never watched.
    await c.exec('drop trigger retail_orders_guard_shipping_writes on public.retail_orders');
    await c.exec(HARDENING);
    const customerOnly = await owner(
      `update public.retail_orders set user_id='${CUSTOMER}', payment_status='success' where id='${id}'`);
    assert.ok(!customerOnly.ok, 'the customer guard alone must refuse a non-shipping field');
    assert.match(customerOnly.err, /contact the store/i);

    // And the one thing a customer legitimately may do still goes through.
    const claim = await owner(`update public.retail_orders set user_id='${CUSTOMER}' where id='${id}'`);
    assert.ok(claim.ok && claim.n === 1, `the bare claim must still work: ${claim.err}`);
  } finally { await c.close(); }
});

// ---- 16/17/19. admin shipping input handling ---------------------------------
test('16. auto_ship_at is handled correctly: NULL, valid, invalid, timezone', async () => {
  // The admin RPC has no auto_ship_at parameter: it hardcodes JSON null so that a
  // hand-entered AWB can never be overwritten by the courier automation. The
  // uncast `v_patch ->> 'auto_ship_at'` was text -> timestamptz and aborted the
  // whole statement, which is why this test exists at all.
  const id = await seedOrder(db, { ref: 'DSL-R-AUTOSHIP', email: VICTIM.email });
  await asService(
    `update public.retail_orders set auto_ship_at='2026-02-01 10:00:00+05:30' where id='${id}'`);

  const saved = await asAdmin(`select public.admin_set_order_shipping(
    '${id}','Delhivery','AWB-AUTO1','https://delhivery.com/track/AWB-AUTO1','shipped')`);
  assert.ok(saved.ok, `admin save must work: ${saved.err}`);
  const row = await rowOf(db, id);
  assert.equal(row.auto_ship_at, null, 'auto_ship_at must be cleared by a manual AWB');

  // The cast itself: a valid timestamp with an explicit offset keeps its instant.
  const valid = await db.query(
    `select nullif('2026-02-01 10:00:00+05:30','')::timestamptz as t`);
  assert.equal(valid.rows[0].t.toISOString(), '2026-02-01T04:30:00.000Z',
    'an offset timestamp must normalise to the same instant');

  // A naive timestamp is interpreted in the session zone, not guessed.
  await db.exec(`set time zone 'Asia/Kolkata'`);
  assert.equal((await db.query(`show timezone`)).rows[0].TimeZone, 'Asia/Kolkata',
    'the session time zone must actually be in effect for this check to mean anything');
  const naive = await db.query(`select nullif('2026-02-01 10:00:00','')::timestamptz as t`);
  assert.equal(naive.rows[0].t.toISOString(), '2026-02-01T04:30:00.000Z',
    'a naive timestamp must be read in the session time zone');
  await db.exec(`set time zone 'UTC'`);

  // An invalid timestamp is a loud failure, never a silent NULL.
  const bad = await db.query(`select nullif('not-a-timestamp','')::timestamptz`).catch((e) => ({ err: e.message }));
  assert.ok(bad.err, 'an invalid timestamp string must raise');
  assert.match(bad.err, /invalid input syntax for type timestamp with time zone/);

  // And an empty string clears to NULL rather than erroring.
  const cleared = await db.query(`select nullif('','')::timestamptz as t`);
  assert.equal(cleared.rows[0].t, null, 'an empty string must clear to NULL');
});

test('17. invalid shipping input is rejected and nothing is written', async () => {
  const id = await seedOrder(db, { ref: 'DSL-R-BADSHIP', email: VICTIM.email });
  const before = await rowOf(db, id);

  const cases = [
    ['a bogus status', `select public.admin_set_order_shipping('${id}','Delhivery','AWB-BAD1','https://x.test/1','teleported')`, /Unknown shipping status/],
    ['an AWB with illegal characters', `select public.admin_set_order_shipping('${id}','Delhivery','bad awb!','https://x.test/1','shipped')`, /must be 4-60 letters, digits or dashes/],
    ['a javascript: tracking URL (stored XSS)', `select public.admin_set_order_shipping('${id}','Delhivery','AWB-BAD2','javascript:alert(1)','shipped')`, /must start with http/],
    ['a non-existent order', `select public.admin_set_order_shipping('00000000-0000-4000-8000-000000000000','Delhivery','AWB-BAD3','https://x.test/3','shipped')`, /Order not found/],
  ];
  for (const [label, sql, expect] of cases) {
    const r = await asAdmin(sql);
    assert.ok(!r.ok, `${label} must be rejected`);
    assert.match(r.err, expect);
    // The whole order is untouched: a rejected save must be all-or-nothing.
    const row = await rowOf(db, id);
    assert.equal(row.awb_number, before.awb_number, `AWB must not change after: ${label}`);
    assert.equal(row.shipping_status, before.shipping_status, `status must not change after: ${label}`);
    assert.equal(row.order_status, before.order_status, `order_status must not change after: ${label}`);
  }
});

test('19. the shipping status vocabulary is enforced by a constraint', async () => {
  const id = await seedOrder(db, { ref: 'DSL-R-VOCAB', email: VICTIM.email });
  // service_role bypasses the guard triggers, so only the CHECK constraint can
  // stop this -- which is exactly why the constraint has to exist independently.
  const r = await asService(
    `update public.retail_orders set shipping_status='teleported' where id='${id}'`);
  assert.ok(!r.ok, 'a status outside the vocabulary must be refused even for service_role');
  assert.match(r.err, /retail_orders_shipping_status_check/);
  const good = await asService(`update public.retail_orders set shipping_status='out_for_delivery' where id='${id}'`);
  assert.ok(good.ok && good.n === 1, 'a status inside the vocabulary must be accepted');
});

test('11. a stranger can neither read nor write another customer\'s order', async () => {
  const id = await seedOrder(db, { ref: 'DSL-R-PRIVATE', email: VICTIM.email });
  await asCustomer(`update public.retail_orders set user_id='${CUSTOMER}' where id='${id}'`);

  // Read: the victim's order must be invisible to a different signed-in user.
  const seen = await asStranger(`select count(*)::int as n from public.retail_orders where id='${id}'`);
  assert.ok(seen.ok, 'the select itself must not error');
  assert.equal(seen.rows[0].n, 0, "a stranger must not read another customer's order");

  // Write: and must not change it either.
  const w = await asStranger(
    `update public.retail_orders set payment_status='success', total_amount=0 where id='${id}'`);
  assert.ok(!w.ok || w.n === 0, 'a stranger must not write another customer\'s order');
  const row = await rowOf(db, id);
  assert.equal(row.payment_status, 'cod_pending', 'payment_status untouched by the stranger');
  assert.equal(Number(row.total_amount), 1000, 'total_amount untouched by the stranger');
});

// ---- the whole files, verbatim, in order -------------------------------------
// The behavioural tests above apply the migration in slices. This one applies
// the two FILES as written, against a production-shaped schema, so a syntax
// error or a stray statement outside the sliced regions cannot hide.
test('the two migration files apply verbatim, in order, on a production-shaped schema', async () => {
  const c = new PGlite();
  try {
    await c.exec(FIXTURE);
    // FIXTURE already models the production-shaped pre-state: the account
    // policies (including the vulnerable claim policy) are live in production
    // even though 20261007 is absent from the migration ledger.
    await c.query('insert into public.admin_users (user_id) values ($1)', [ADMIN]);

    // 1) migration 15, exactly as it sits on disk.
    await c.exec(SHIPPING);
    // 2) migration 17, exactly as it sits on disk.
    await c.exec(HARDENING);

    // The account claim policy is gone and the claim RPC took its place.
    const pol = await c.query(
      `select count(*)::int as n from pg_policies
        where schemaname='public' and tablename='retail_orders'
          and policyname='retail_orders_update_owner_claim'`);
    assert.equal(pol.rows[0].n, 0, 'the vulnerable claim policy must be dropped');
    const admin = await c.query(
      `select count(*)::int as n from pg_policies
        where schemaname='public' and tablename='retail_orders'
          and policyname='retail_orders_update_admin'`);
    assert.equal(admin.rows[0].n, 1, 'the admin policy must survive');

    // Both files are re-runnable: applying them twice must not fail.
    await c.exec(SHIPPING);
    await c.exec(HARDENING);
  } finally { await c.close(); }
});

// ---- the guard must not break live SECURITY DEFINER checkout functions -------
// Regression guard for a real production risk: convert_retail_order_to_cod is a
// live, customer-facing function that writes is_cod / payment_status /
// amount_paid_upfront / amount_due_on_delivery -- the exact columns the new guard
// watches. A strict guard refuses it with 42501 and breaks the checkout
// payment-method switch for every customer.
test('the guard does not break convert_retail_order_to_cod (live checkout flow)', async () => {
  const id = await seedOrder(db, {
    ref: 'DSL-R-TOKOD', email: VICTIM.email, cod: false, paymentStatus: 'pending', dueOnDelivery: 0 });
  const before = await rowOf(db, id);
  assert.equal(before.is_cod, false);
  assert.equal(before.payment_status, 'pending');

  // A guest who has NOT signed in: exactly how checkout calls this today.
  const asGuest = await asAnon(`select public.convert_retail_order_to_cod('DSL-R-TOKOD','9999999999')`);
  assert.ok(asGuest.ok, `an anonymous guest must still be able to switch to COD: ${asGuest.err}`);
  // The result column is named after the function; PGlite returns jsonb parsed.
  const out = asGuest.rows[0].convert_retail_order_to_cod;
  assert.equal(out.is_cod, true, 'the RPC must report is_cod true');
  assert.equal(out.payment_status, 'cod_pending', 'the RPC must report cod_pending');

  const row = await rowOf(db, id);
  assert.equal(row.is_cod, true, 'is_cod must be set');
  assert.equal(row.payment_status, 'cod_pending', 'payment_status must be cod_pending');
  assert.equal(Number(row.amount_paid_upfront), 0, 'nothing is paid upfront for COD');
  assert.equal(Number(row.amount_due_on_delivery), Number(before.total_amount),
    'the full amount is due on delivery');

  // The possession gate and the other refusals must survive the guard.
  const wrongPhone = await asAnon(`select public.convert_retail_order_to_cod('DSL-R-TOKOD','0000000000')`);
  assert.ok(!wrongPhone.ok, 'a wrong phone must still be refused');
  assert.match(wrongPhone.err, /Order not found/);
  const again = await asAnon(`select public.convert_retail_order_to_cod('DSL-R-TOKOD','9999999999')`);
  assert.ok(!again.ok, 'an already-COD order must still be refused');

  // A paid order must still be protected from the switch. (seedOrder always
  // stores phone 9999999999; a different number would fail the possession gate
  // first and prove nothing about the payment guard.)
  const paid = await seedOrder(db, {
    ref: 'DSL-R-PAIDCOD', email: VICTIM.email, cod: false, paymentStatus: 'pending', dueOnDelivery: 0 });
  await asService(`update public.retail_orders set payment_status='success' where id='${paid}'`);
  const refuse = await asAnon(`select public.convert_retail_order_to_cod('DSL-R-PAIDCOD','9999999999')`);
  assert.ok(!refuse.ok, 'a paid order must not be switchable to COD');
  assert.match(refuse.err, /already been paid/);
  assert.equal((await rowOf(db, paid)).is_cod, false, 'the paid order must stay non-COD');
});

test('T. a customer cannot make an order look restocked', async () => {
  const id = await seedOrder(db, { ref: 'DSL-R-RESTOCK', email: VICTIM.email });
  // every column that could fake a restock, in one shot
  const r = await asCustomer(
    `update public.retail_orders set user_id='${CUSTOMER}', stock_restored_at=now(), payment_status='failed', order_status='cancelled' where id='${id}'`);
  assert.ok(!r.ok || r.n === 0, 'the restock-spoofing write must be refused');
  const row = await rowOf(db, id);
  assert.equal(row.stock_restored_at, null, 'stock_restored_at must still be NULL');
  assert.equal(row.payment_status, 'cod_pending', 'payment_status untouched');
  assert.equal(row.order_status, 'pending', 'order_status untouched');
});

// =============================================================================
// Database B -- Blocker B (the migration-15 backfill) against production data
// =============================================================================
test('O/P/Q/R/S. the migration-15 backfill writes only the factually wrong row', async (t) => {
  const b = new PGlite();
  try {
    await b.exec(FIXTURE);
    for (const r of PROD_ROWS) {
      await b.query(
        `insert into public.retail_orders
           (ref,order_status,payment_status,is_cod,total_amount,amount_paid_upfront,amount_due_on_delivery,
            customer,items,awb_number,updated_at,created_at)
         values ($1,$2,$3,true,1000,0,1000,$4::jsonb,'[]'::jsonb,$5,'2026-01-01 00:00:00+00','2026-01-01 00:00:00+00')`,
        [r.ref, r.order_status, r.payment_status, JSON.stringify({ email: r.ref + '@shop.test' }), r.awb]);
    }
    const before = new Map((await b.query(
      `select ref, order_status, payment_status, total_amount, amount_due_on_delivery,
              stock_restored_at, is_cod, order_type, customer::text, items::text,
              updated_at::text, created_at::text
         from public.retail_orders`)).rows.map((r) => [r.ref, r]));
    const logsBefore = (await b.query(`select count(*)::int as n from public.admin_activity`)).rows[0].n;

    // ---- apply the REAL column add + the REAL backfill from migration 15 ----
    await b.exec(COLS_AND_BACKFILL);

    const after = new Map((await b.query(
      `select ref, order_status, payment_status, total_amount, amount_due_on_delivery,
              stock_restored_at, is_cod, order_type, customer::text, items::text,
              updated_at::text, created_at::text
         from public.retail_orders`)).rows.map((r) => [r.ref, r]));

    // Q: every seeded row is byte-identical apart from the one correction below.
    for (const ref of PROD_ROWS.map((r) => r.ref)) {
      const a = { ...after.get(ref) }, b0 = { ...before.get(ref) };
      if (ref !== 'DSL-R-B4C7C887') {
        assert.deepEqual(a, b0, `${ref} must be byte-identical after the backfill`);
      }
    }

    // S: every existing row carries the correct effective shipping state.
    const expected = {
      'DSL-R-4F5BE4E0': 'pending',
      'DSL-R-91ECFC7F': 'pending',
      'DSL-R-B4C7C887': 'delivered',
    };
    const st = (await b.query(
      `select ref, shipping_status, updated_at::text from public.retail_orders`)).rows;
    for (const row of st) {
      assert.equal(row.shipping_status, expected[row.ref], `${row.ref} shipping_status`);
    }

    // O: only the row whose value was factually wrong is written. The other two
    // keep their original updated_at.
    const beforeByRef = before;
    const moved = st
      .filter((r) => r.updated_at !== beforeByRef.get(r.ref).updated_at)
      .map((r) => r.ref);
    assert.deepEqual(moved, ['DSL-R-B4C7C887'],
      `only the delivered order may be written; got ${JSON.stringify(moved)}`);

    // P: exactly one order-change log row, for that same single correction.
    // Action is UPDATE, not STATUS: the backfill corrects shipping_status and
    // leaves order_status alone. The seed INSERTs are excluded by action --
    // they are CREATE rows stamped "now", while the orders' own updated_at are
    // back-dated to 2026-01-01, so a created_at filter cannot separate them.
    const logs = (await b.query(
      `select entity_ref, action from public.admin_activity
        where action <> 'CREATE' order by id`)).rows;
    assert.deepEqual(logs, [{ entity_ref: 'DSL-R-B4C7C887', action: 'UPDATE' }],
      `expected exactly one corrective log row, got ${JSON.stringify(logs)}`);
    assert.equal(logsBefore, 3, 'the three seed INSERTs should have logged CREATE');

    // R: a brand-new order still gets its status from the column default.
    await b.query(`insert into public.retail_orders (ref,customer) values ('DSL-R-NEW','{}'::jsonb)`);
    const fresh = (await b.query(`select shipping_status from public.retail_orders where ref='DSL-R-NEW'`)).rows[0];
    assert.equal(fresh.shipping_status, 'pending', 'new orders must get the default');
  } finally {
    await b.close();
  }
});

test('the backfill is a no-op when nothing needs correcting', async () => {
  const b = new PGlite();
  try {
    await b.exec(FIXTURE);
    // Only rows that already derive to the default. The delivered order is
    // excluded on purpose: it is the one row the backfill must correct, so it
    // cannot appear in a no-op scenario.
    for (const r of PROD_ROWS.filter((x) => x.order_status !== 'delivered')) {
      await b.query(
        `insert into public.retail_orders (ref,order_status,payment_status,customer,updated_at)
         values ($1,$2,$3,'{}'::jsonb,'2026-01-01 00:00:00+00')`, [r.ref, r.order_status, r.payment_status]);
    }
    await b.exec(COLS_AND_BACKFILL);
    const moved = (await b.query(
      `select count(*)::int as n from public.retail_orders
        where updated_at is distinct from '2026-01-01 00:00:00+00'::timestamptz`)).rows[0].n;
    assert.equal(moved, 0, 'no row may be written when every row already derives to the default');
  } finally { await b.close(); }
});

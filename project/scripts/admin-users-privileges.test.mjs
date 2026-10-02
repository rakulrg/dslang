// =============================================================================
// admin-users-privileges.test.mjs
// =============================================================================
// Database-LEVEL tests for the public.admin_users authorization model.
//
// Why this file exists at all
// ----------------------------
// The existing self-promotion tests live in scripts/rpc-privileges.test.mjs:303
// and only assert that the string `drop policy if exists "insert_own_admin"`
// appears in a migration FILE. That assertion passes while production is
// still fully vulnerable, because 20260816010000 -- which contains the drops --
// was edited AFTER it had already been applied. The migration ledger records
// version + name and never file content, so the statements never ran and
// nothing noticed.
//
// So these tests deliberately do NOT regex-match migration text for the
// security property. They build a PGlite database that reproduces the LIVE
// production catalog (captured 2026-09-28), apply the real migration 17 guard
// and the real corrective migration 18, then execute attacker statements as
// the real roles and assert on what actually changed.
//
// Phase 1 proves the vulnerability EXISTS in the reproduced production state.
// Phase 2 applies the fix and proves every security requirement holds.
//
// Nothing here touches production; this is PGlite only.
// =============================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIG = 'supabase/migrations/';
// The markers below contain hard-coded "\n", so a checkout that rewrites line
// endings would make indexOf() return -1 and silently empty every slice.
const readMigrations = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const HARDENING = readMigrations(MIG + '20261017000000_dslang_retail_order_update_hardening.sql');
const LOCKDOWN = readMigrations(MIG + '20261018000000_dslang_admin_users_client_write_lockdown.sql');

// The real guard, sliced verbatim out of the migration that ships it. Using the
// real function matters: the whole point of the escalation test is that this
// exact admin branch is what a customer would be buying with a self-insert.
const GUARD = (() => {
  const from = 'create or replace function public.retail_orders_guard_customer_writes()';
  const a = HARDENING.indexOf(from);
  assert.notEqual(a, -1, 'retail_orders_guard_customer_writes not found in migration 17');
  const b = HARDENING.indexOf('$$;', a) + 3;
  return HARDENING.slice(a, b);
})();

// The real guest-claim RPC, same treatment. It is SECURITY DEFINER, which is
// why the claim still works even though no non-admin can SELECT an order row.
// The privilege statements from migration 17 are appended verbatim too, so the
// anon-cannot-claim assertion reflects production rather than a PUBLIC default.
const CLAIM = (() => {
  const from = 'create or replace function public.claim_retail_guest_order';
  const a = HARDENING.indexOf(from);
  assert.notEqual(a, -1, 'claim_retail_guest_order not found in migration 17');
  const b = HARDENING.indexOf('$$;', a) + 3;
  const grants = `revoke all on function public.claim_retail_guest_order(text) from public;
grant execute on function public.claim_retail_guest_order(text) to authenticated;
revoke execute on function public.claim_retail_guest_order(text) from anon;`;
  return HARDENING.slice(a, b) + '\n' + grants;
})();

// -----------------------------------------------------------------------------
// Fixture: the LIVE production catalog for admin_users, reproduced faithfully.
//
// Reproduced from production on 2026-09-28:
//   - columns: user_id uuid NOT NULL (no default), created_at timestamptz now()
//     NOTE: there is no role column, so row presence == admin.
//   - relrowsecurity = true, relforcerowsecurity = false, owner = postgres.
//     Because FORCE is false, a SECURITY DEFINER function owned by postgres
//     writes with RLS switched off -- this is why revoking the client grant
//     cannot break the signup trigger.
//   - constraints: PRIMARY KEY (user_id),
//     FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE.
//   - policies (all PERMISSIVE, all TO authenticated):
//       read_own_admin   SELECT  USING     (auth.uid() = user_id)
//       insert_own_admin INSERT WITH CHECK (auth.uid() = user_id)   <-- the bug
//       delete_own_admin DELETE  USING     (auth.uid() = user_id)
//     There is NO update policy at all, so UPDATE is already refused by RLS.
//   - table grants: table-level ALL to anon, authenticated, service_role, which
//     is Supabase's default-privileges behaviour.
// -----------------------------------------------------------------------------
const FIXTURE = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon')         then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role')  then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);

-- Null-safe exactly like Supabase's own auth.uid()/auth.role(): when no request
-- context is set these GUCs come back as '' and a bare ::json cast would raise
-- "The input string ended unexpectedly".
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub', '')::uuid)
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', ''))
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth, public to anon, authenticated, service_role;

-- Exact live definition: no role column, presence == admin.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);
alter table public.admin_users enable row level security;

create policy "read_own_admin" on public.admin_users for select
  to authenticated using (auth.uid() = user_id);
create policy "insert_own_admin" on public.admin_users for insert
  to authenticated with check (auth.uid() = user_id);
create policy "delete_own_admin" on public.admin_users for delete
  to authenticated using (auth.uid() = user_id);

-- Supabase's default privileges hand table-level ALL to the API roles. This is
-- what makes the INSERT policy above reachable from PostgREST.
grant all on public.admin_users to anon, authenticated, service_role;

-- The trusted bootstrap writer, verbatim from 20260817020000 (the definition
-- live in production). SECURITY DEFINER, owner postgres, and it only fires
-- while the table is completely empty.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not exists (select 1 from admin_users) then
    insert into admin_users (user_id) values (new.id);
  end if;
  return new;
end;
$fn$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The admin-only write policy on retail_orders, verbatim from the live catalog.
create table if not exists public.retail_orders (
  id uuid primary key default gen_random_uuid(),
  ref text,
  order_status text not null default 'pending',
  payment_status text not null default 'pending',
  is_cod boolean not null default false,
  total_amount numeric not null default 0,
  amount_paid_upfront numeric not null default 0,
  amount_due_on_delivery numeric not null default 0,
  stock_restored_at timestamptz,
  awb_number text,
  user_id uuid,
  customer jsonb,
  items jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
alter table public.retail_orders enable row level security;
-- Both admin policies, verbatim from 20260904000000. The SELECT one is not
-- optional decoration: an UPDATE needs a SELECT policy to see the old row at
-- all, so without it retail_orders_update_admin is unreachable and an admin
-- could not edit an order either. It is the same admin_users exists() check,
-- which is exactly why a self-inserted admin row unlocks the whole surface.
create policy "retail_orders_select_admin" on public.retail_orders for select
  to authenticated
  using (exists (select 1 from admin_users where user_id = auth.uid()));
create policy "retail_orders_update_admin" on public.retail_orders for update
  to authenticated
  using (exists (select 1 from admin_users where user_id = auth.uid()))
  with check (exists (select 1 from admin_users where user_id = auth.uid()));
grant all on public.retail_orders to anon, authenticated, service_role;

-- The one real admin in production, plus a customer and a stranger.
-- The bootstrap trigger fires on the FIRST auth.users insert and creates the
-- admin row itself, so seeding the admin must NOT also insert into
-- admin_users -- that is exactly the trusted path, exercised for real.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin@dslang.in');
insert into auth.users (id, email) values
  ('22222222-2222-2222-2222-222222222222', 'shopper@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'stranger@example.com');

-- A protected order nobody is allowed to rewrite.
insert into public.retail_orders (ref, order_status, total_amount, amount_paid_upfront,
                                  amount_due_on_delivery, customer, items)
values ('DSL-R-PROTECTED', 'pending', 398, 100, 298,
        '{"email":"victim@example.com","phone":"9999999999"}'::jsonb,
        '[{"sku":"X1","qty":1,"price":398}]'::jsonb);
`;

const ADMIN = '11111111-1111-1111-1111-111111111111';
const SHOPPER = '22222222-2222-2222-2222-222222222222';
const STRANGER = '33333333-3333-3333-3333-333333333333';

let db;

// Run a statement as a real role with a real JWT, then always drop the claims so
// no test can inherit another test's identity.
const asRole = async (role, uid, email, sql) => {
  const claims = JSON.stringify({ sub: uid, email, role });
  await db.exec(`set role ${role}; set request.jwt.claims = '${claims}';`);
  try {
    const r = await db.query(sql);
    return { ok: true, n: r.rowCount, rows: r.rows };
  } catch (e) {
    const msg = (e.message || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || String(e);
    return { ok: false, n: 0, err: msg, code: e.code };
  } finally {
    await db.exec('reset role; reset request.jwt.claims;');
  }
};

const asAuth = (uid, email, sql) => asRole('authenticated', uid, email, sql);
const asAnon = (sql) => asRole('anon', null, null, sql);
const asService = (sql) => asRole('service_role', null, null, sql);

const rowOf = async (ref) => {
  const r = await db.query(
    `select total_amount, amount_paid_upfront, amount_due_on_delivery, order_status,
            payment_status, awb_number, stock_restored_at, user_id::text
     from public.retail_orders where ref = '${ref}'`);
  return r.rows[0];
};

// Whole row, so a no-op can be proven to have changed nothing at all rather
// than only the columns someone thought to check.
const fullRowOf = async (ref) => {
  const r = await db.query(`select * from public.retail_orders where ref = '${ref}'`);
  return r.rows[0];
};

const isAdminRow = async (uid) => {
  const r = await db.query('select 1 from public.admin_users where user_id = $1', [uid]);
  return r.rows.length > 0;
};

const adminCount = async () => {
  const r = await db.query('select count(*)::int as n from public.admin_users');
  return r.rows[0].n;
};

const policyNames = async (table, cmd) => {
  const r = await db.query(
    'select policyname from pg_policies where schemaname=$1 and tablename=$2 and cmd=$3 order by 1',
    ['public', table, cmd]);
  return r.rows.map((x) => x.policyname);
};

const hasPrivilege = async (role, priv) => {
  const r = await db.query(
    `select count(*)::int as n from information_schema.role_table_grants
     where table_schema='public' and table_name='admin_users'
       and grantee=$1 and privilege_type=$2`, [role, priv]);
  return r.rows[0].n > 0;
};

const assertBlocked = (res, what) =>
  assert.ok(!res.ok || res.n === 0, `${what} must be refused, but it succeeded: ${JSON.stringify(res.rows)}`);

before(async () => {
  db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(GUARD);
  await db.exec(CLAIM);
  await db.exec(`create trigger retail_orders_guard_customer_writes
    before update on public.retail_orders
    for each row execute function public.retail_orders_guard_customer_writes();`);
  // auth.uid() must be callable with no request context at all.
  await db.query('select auth.uid()');
});
after(async () => { await db.close(); });

// =============================================================================
// PHASE 1 -- the vulnerability, proved against the reproduced live state
// =============================================================================

test('VULN: the live policy set really does let a customer INSERT their own admin row', async () => {
  assert.deepEqual(await policyNames('admin_users', 'INSERT'), ['insert_own_admin']);
  assert.equal(await hasPrivilege('authenticated', 'INSERT'), true);

  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `insert into public.admin_users (user_id) values ('${SHOPPER}')`);

  assert.equal(res.ok, true, 'insert should be permitted in the vulnerable state');
  assert.equal(res.n, 1);
  assert.equal(await isAdminRow(SHOPPER), true, 'the customer is now an admin');
});

test('VULN: a customer cannot insert on BEHALF of another user', async () => {
  // Confirms the blast radius is self-promotion only, not impersonation.
  const res = await asAuth(STRANGER, 'stranger@example.com',
    `insert into public.admin_users (user_id) values ('${ADMIN}')`);
  assertBlocked(res, 'inserting another user admin row');
});

test('VULN: the self-inserted row satisfies retail_orders_update_admin', async () => {
  // No error, and the protected financial columns move. This is the full
  // compromise: arbitrary money edits on any order.
  const before = await rowOf('DSL-R-PROTECTED');
  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `update public.retail_orders set total_amount = 1, amount_due_on_delivery = 1 where ref = 'DSL-R-PROTECTED'`);
  assert.equal(res.ok, true, 'the admin policy should have permitted this');
  const after = await rowOf('DSL-R-PROTECTED');
  assert.equal(Number(after.total_amount), 1);
  assert.equal(Number(after.amount_due_on_delivery), 1);
  assert.notDeepEqual(before, after, 'this is the damage being demonstrated');

  // Put it back, then reset the fixture for the fixed-state tests below.
  await db.query(`update public.retail_orders set total_amount=398, amount_due_on_delivery=298
                  where ref='DSL-R-PROTECTED'`);
  await db.query('delete from public.admin_users where user_id = $1', [SHOPPER]);
});

test('VULN: the self-inserted row also satisfies the migration-17 guard admin branch', async () => {
  await asAuth(SHOPPER, 'shopper@example.com',
    `insert into public.admin_users (user_id) values ('${SHOPPER}')`);
  // The guard is SECURITY INVOKER, so it sees the customer as `authenticated`.
  // Only the admin_users row stands between them and the financial columns.
  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `update public.retail_orders set total_amount = 1 where ref = 'DSL-R-PROTECTED'`);
  assert.equal(res.ok, true, 'the guard admin branch should have waved this through');
  assert.equal(Number((await rowOf('DSL-R-PROTECTED')).total_amount), 1);

  await db.query(`update public.retail_orders set total_amount=398 where ref='DSL-R-PROTECTED'`);
  await db.query('delete from public.admin_users where user_id = $1', [SHOPPER]);
});

test('VULN: a customer CAN currently delete their own admin row (self-lockout, not escalation)', async () => {
  await asAuth(SHOPPER, 'shopper@example.com',
    `insert into public.admin_users (user_id) values ('${SHOPPER}')`);
  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `delete from public.admin_users where user_id = '${SHOPPER}'`);
  assert.equal(res.ok, true);
  assert.equal(await isAdminRow(SHOPPER), false);
});

test('VULN: there is no UPDATE policy, so UPDATE is already refused by RLS', async () => {
  assert.deepEqual(await policyNames('admin_users', 'UPDATE'), []);
  // Establishes that revoking UPDATE changes behaviour only at the grant layer.
  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `update public.admin_users set created_at = now() where user_id = '${ADMIN}'`);
  assertBlocked(res, 'updating an admin row');
});

// =============================================================================
// PHASE 2 -- apply the corrective migration and re-assert every requirement
// =============================================================================

test('FIX: the corrective migration applies cleanly and is re-runnable', async () => {
  await db.exec(LOCKDOWN);
  await db.exec(LOCKDOWN); // idempotent: the whole point of DROP/IF EXISTS
  assert.equal(await adminCount(), 1, 'no admin row may be added or removed');
});

test('FIX 1: authenticated INSERT into admin_users is blocked', async () => {
  assert.deepEqual(await policyNames('admin_users', 'INSERT'), [], 'no INSERT policy may remain');
  assert.equal(await hasPrivilege('authenticated', 'INSERT'), false, 'the grant must be revoked');
  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `insert into public.admin_users (user_id) values ('${SHOPPER}')`);
  assertBlocked(res, 'authenticated INSERT');
  assert.equal(await isAdminRow(SHOPPER), false, 'no self-promotion may persist');
});

test('FIX 2: authenticated UPDATE admin_users is blocked', async () => {
  assert.equal(await hasPrivilege('authenticated', 'UPDATE'), false);
  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `update public.admin_users set created_at = now() where user_id = '${ADMIN}'`);
  assertBlocked(res, 'authenticated UPDATE');
});

test('FIX 3: authenticated DELETE admin_users is blocked', async () => {
  assert.deepEqual(await policyNames('admin_users', 'DELETE'), [], 'no DELETE policy may remain');
  assert.equal(await hasPrivilege('authenticated', 'DELETE'), false);
  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `delete from public.admin_users where user_id = '${ADMIN}'`);
  assertBlocked(res, 'deleting the real admin');
  assert.equal(await adminCount(), 1, 'the real admin must still exist');
});

test('FIX 4: anon holds no privilege at all on admin_users', async () => {
  // Every privilege, including SELECT. anon has no policy on this table, so the
  // default ALL grant was pure latent risk; it is now fully revoked.
  for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'SELECT', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) {
    assert.equal(await hasPrivilege('anon', priv), false, `anon must not hold ${priv}`);
  }
});

test('D/E: anonymous INSERT is denied and anonymous SELECT is denied', async () => {
  // Assert the real mechanism, not just "no rows". After the revoke the failure
  // is a privilege error (42501) rather than an RLS-filtered empty result, so a
  // future re-grant cannot be mistaken for a still-protected table.
  const ins = await asAnon(`insert into public.admin_users (user_id) values ('${SHOPPER}')`);
  assert.equal(ins.ok, false, 'anon INSERT must be refused');
  assert.equal(ins.code, '42501', `expected a privilege error, got: ${ins.err}`);
  assert.equal(await isAdminRow(SHOPPER), false, 'no anon-created admin row');

  const sel = await asAnon(`select * from public.admin_users`);
  assert.equal(sel.ok, false, 'anon SELECT must be refused outright');
  assert.equal(sel.code, '42501', `expected a privilege error, got: ${sel.err}`);

  assert.equal(await adminCount(), 1, 'the real admin is untouched');
});

test('FIX 5: existing admin SELECT behaviour is preserved', async () => {
  // The UI depends on exactly this: checkIsAdmin() in src/lib/auth.tsx:195-203
  // and requireAdminImageAccess() in src/lib/admin.ts:226-237 both do a
  // `.from('admin_users').select('*', { head: true }).eq('user_id', id)`.
  assert.deepEqual(await policyNames('admin_users', 'SELECT'), ['read_own_admin']);
  assert.equal(await hasPrivilege('authenticated', 'SELECT'), true);
  const res = await asAuth(ADMIN, 'admin@dslang.in',
    `select user_id from public.admin_users where user_id = '${ADMIN}'`);
  assert.equal(res.ok, true, 'the real admin must still be able to read their own row');
  assert.equal(res.n, 1);
});

test('FIX 6: a customer still cannot read the admin table of others', async () => {
  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `select user_id from public.admin_users`);
  assert.equal(res.ok, true);
  assert.equal(res.n, 0, 'read_own_admin must expose no rows to a non-admin');
});

test('FIX 7: the trusted signup trigger still works after client INSERT is revoked', async () => {
  // Proves the revoke did not break the one legitimate writer. The trigger is
  // SECURITY DEFINER owned by postgres and admin_users is not FORCE RLS, so it
  // writes with RLS off, as postgres.
  const bootstrapper = '44444444-4444-4444-4444-444444444444';
  await db.query(`delete from public.admin_users`);
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [bootstrapper, 'first@dslang.in']);
  // The trigger fires on the auth.users INSERT, so the admin row must already exist.
  assert.equal(await isAdminRow(bootstrapper), true,
    'handle_new_user must still be able to create the first admin');

  // Second signup must NOT create another admin: the guard is "table is empty".
  const second = '55555555-5555-5555-5555-555555555555';
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [second, 'second@example.com']);
  assert.equal(await isAdminRow(second), false, 'only the bootstrap signup is an admin');
  assert.equal(await adminCount(), 1);

  // Restore the real production admin for the remaining tests.
  await db.query('delete from public.admin_users');
  await db.query('insert into public.admin_users (user_id) values ($1)', [ADMIN]);
});

test('FIX 8: a normal authenticated user is not recognised as an admin', async () => {
  assert.equal(await isAdminRow(SHOPPER), false);
  assert.equal(await isAdminRow(STRANGER), false);
});

test('FIX 9: the existing admin is still recognised and can still write orders', async () => {
  assert.equal(await isAdminRow(ADMIN), true);
  const res = await asAuth(ADMIN, 'admin@dslang.in',
    `update public.retail_orders set total_amount = 500 where ref = 'DSL-R-PROTECTED'`);
  assert.equal(res.ok, true, 'an admin must retain full order access');
  assert.equal(Number((await rowOf('DSL-R-PROTECTED')).total_amount), 500);
  await db.query(`update public.retail_orders set total_amount=398 where ref='DSL-R-PROTECTED'`);
});

test('FIX 10: service_role and postgres keep full admin_users access', async () => {
  for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'SELECT', 'TRUNCATE']) {
    assert.equal(await hasPrivilege('service_role', priv), true, `service_role must keep ${priv}`);
  }
  // Automation can still add an operator.
  const op = '66666666-6666-6666-6666-666666666666';
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [op, 'ops@dslang.in']);
  await asService(`insert into public.admin_users (user_id) values ('${op}')`);
  assert.equal(await isAdminRow(op), true, 'an operator must still be able to grant admin');
  await db.query('delete from public.admin_users where user_id = $1', [op]);
});

test('FIX 11: retail_orders_update_admin is still admin-only', async () => {
  const customer = await asAuth(SHOPPER, 'shopper@example.com',
    `update public.retail_orders set total_amount = 1 where ref = 'DSL-R-PROTECTED'`);
  assertBlocked(customer, 'a customer writing a financial column');
  const admin = await asAuth(ADMIN, 'admin@dslang.in',
    `update public.retail_orders set total_amount = 399 where ref = 'DSL-R-PROTECTED'`);
  assert.equal(admin.ok, true, 'an admin must still pass');
  await db.query(`update public.retail_orders set total_amount=398 where ref='DSL-R-PROTECTED'`);
});

test('FIX 12: the customer guard is still effective and cannot be bypassed via admin_users', async () => {
  // The customer cannot reach the guard's admin branch any more, because the
  // only way in was a self-insert, and that is now refused twice over: no
  // policy AND no grant.
  const escalate = await asAuth(SHOPPER, 'shopper@example.com',
    `insert into public.admin_users (user_id) values ('${SHOPPER}')`);
  assertBlocked(escalate, 'the escalation attempt');
  assert.equal(await isAdminRow(SHOPPER), false);

  const res = await asAuth(SHOPPER, 'shopper@example.com',
    `update public.retail_orders set total_amount = 1 where ref = 'DSL-R-PROTECTED'`);
  assertBlocked(res, 'a customer writing total_amount');
});

test('FIX 13: the protected order was never modified by any of this', async () => {
  const r = await rowOf('DSL-R-PROTECTED');
  assert.equal(Number(r.total_amount), 398);
  assert.equal(Number(r.amount_paid_upfront), 100);
  assert.equal(Number(r.amount_due_on_delivery), 298);
  assert.equal(r.order_status, 'pending');
  assert.equal(r.payment_status, 'pending');
  assert.equal(r.awb_number, null);
  assert.equal(r.stock_restored_at, null);
  assert.equal(r.user_id, null);
});

test('FIX 14: a mismatched guest email is an intentional zero-row no-op, not an error', async () => {
  // claim_retail_guest_order filters the UPDATE on the order's guest email, so a
  // non-matching email matches no rows. That is a deliberate no-op, NOT an
  // authorization failure, and the RPC is NOT made to throw: callers use the
  // returned `claimed` count to decide whether anything was linked. The
  // security property is "nothing is written", so that is what is asserted --
  // the whole row, including every financial and fulfilment column.
  const before = await fullRowOf('DSL-R-PROTECTED');
  assert.equal(before.user_id, null, 'must start unclaimed');

  const wrongEmail = await asAuth(SHOPPER, 'attacker@example.com',
    `select public.claim_retail_guest_order('DSL-R-PROTECTED') as r`);
  assert.equal(wrongEmail.ok, true, 'a mismatched email is not an error');
  assert.equal(wrongEmail.rows[0].r.ok, true);
  assert.equal(wrongEmail.rows[0].r.claimed, 0, 'nothing may be claimed');
  assert.deepEqual(wrongEmail.rows[0].r.refs, []);

  // The order must be byte-for-byte what it was: no partial write, no side
  // effect, nothing touched by a statement that matched zero rows.
  const after = await fullRowOf('DSL-R-PROTECTED');
  assert.equal(after.user_id, null, 'user_id must remain NULL');
  assert.equal(Number(after.total_amount), Number(before.total_amount));
  assert.equal(Number(after.amount_paid_upfront), Number(before.amount_paid_upfront));
  assert.equal(Number(after.amount_due_on_delivery), Number(before.amount_due_on_delivery));
  assert.equal(after.payment_status, before.payment_status);
  assert.equal(after.order_status, before.order_status);
  assert.equal(after.stock_restored_at, before.stock_restored_at);
  assert.equal(after.awb_number, before.awb_number);
  assert.deepEqual(after.items, before.items, 'items must be untouched');
  assert.deepEqual(after.customer, before.customer, 'customer must be untouched');
});

test('FIX 14b: a valid guest claim still works and writes only user_id', async () => {
  // Migration 17 dropped retail_orders_update_owner_claim, and no non-admin can
  // SELECT a retail_orders row, so a direct client UPDATE claiming a guest
  // order is no longer possible BY DESIGN -- the RPC is now the only claim
  // path. This asserts that path still works after the lockdown.
  const before = await fullRowOf('DSL-R-PROTECTED');
  assert.equal(before.user_id, null, 'must start unclaimed');

  const good = await asAuth(SHOPPER, 'victim@example.com',
    `select public.claim_retail_guest_order('DSL-R-PROTECTED') as r`);
  assert.equal(good.ok, true, `claim RPC must still work: ${good.err || ''}`);
  assert.equal(good.rows[0].r.ok, true);
  assert.equal(good.rows[0].r.claimed, 1);
  assert.deepEqual(good.rows[0].r.refs, ['DSL-R-PROTECTED']);

  const after = await fullRowOf('DSL-R-PROTECTED');
  assert.equal(after.user_id, SHOPPER, 'the guest order is now linked to the shopper');
  // Nothing except user_id may move as a side effect of the claim.
  assert.equal(Number(after.total_amount), Number(before.total_amount));
  assert.equal(Number(after.amount_paid_upfront), Number(before.amount_paid_upfront));
  assert.equal(Number(after.amount_due_on_delivery), Number(before.amount_due_on_delivery));
  assert.equal(after.order_status, before.order_status);
  assert.equal(after.payment_status, before.payment_status);
  assert.equal(after.stock_restored_at, before.stock_restored_at);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.customer, before.customer);

  await db.query(`update public.retail_orders set user_id = null where ref='DSL-R-PROTECTED'`);
});

test('FIX 14c: anon is denied execute on the claim RPC and cannot claim', async () => {
  // anon has no EXECUTE on the RPC (migration 17 revoked it), so this is a
  // privilege error rather than a silent zero-row result.
  const res = await asAnon(`select public.claim_retail_guest_order('DSL-R-PROTECTED') as r`);
  assert.equal(res.ok, false, 'anon must not be able to call the claim RPC');
  assert.equal(res.code, '42501', `expected a privilege error, got: ${res.err}`);
  assert.equal((await fullRowOf('DSL-R-PROTECTED')).user_id, null);
});

test('K: a customer cannot modify protected retail_orders fields', async () => {
  // Belt and braces on the specific columns that matter, in one statement, so a
  // single attempt at the worst-case write is refused.
  const before = await fullRowOf('DSL-R-PROTECTED');
  for (const col of ['total_amount', 'amount_paid_upfront', 'amount_due_on_delivery',
                     'order_status', 'payment_status', 'stock_restored_at', 'awb_number']) {
    const res = await asAuth(SHOPPER, 'shopper@example.com',
      `update public.retail_orders set ${col} = ${col === 'total_amount' ? '1' : col === 'order_status' ? `'shipped'` : col === 'awb_number' ? `'X'` : 'NULL'} where ref = 'DSL-R-PROTECTED'`);
    assertBlocked(res, `a customer writing ${col}`);
  }
  assert.deepEqual(await fullRowOf('DSL-R-PROTECTED'), before,
    'the protected order must be bit-identical after every attempt');
});

test('M: admin shipping authorization still resolves through admin_users', async () => {
  // migration 15 (NOT applied to production) guards shipping writes with
  //   and exists (select 1 from public.admin_users where user_id = auth.uid())
  // inside a SECURITY DEFINER function. That inner read runs as the definer
  // (postgres) and is the exact dependency this migration could have broken,
  // so it is reproduced here. An admin must still pass, a customer must not.
  // The RPC's full behaviour is covered by scripts/manual-shipping.test.mjs.
  const asAdminCheck = `select exists (select 1 from public.admin_users where user_id = auth.uid()) as pass`;

  const admin = await asAuth(ADMIN, 'admin@dslang.in', asAdminCheck);
  assert.equal(admin.ok, true);
  assert.equal(admin.rows[0].pass, true, 'a real admin must still satisfy the shipping guard');

  const customer = await asAuth(SHOPPER, 'shopper@example.com', asAdminCheck);
  assert.equal(customer.rows[0].pass, false, 'a customer must not satisfy the shipping guard');
});

test('N: restock authorization is service_role-only and unaffected by this table', async () => {
  // restock_retail_order_items (migration 16) is granted to service_role with
  // EXECUTE revoked from anon/authenticated, and never reads admin_users, so
  // the admin_users lockdown cannot reach it. Asserting the split here so a
  // future grant change is caught in the same place as the admin checks.
  // Full restock behaviour is covered by scripts/restock-fail-closed.test.mjs.
  const r = await db.query(
    `select p.proname, array_to_string(p.proacl, ',') as acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'restock_retail_order_items' and n.nspname = 'public'`);
  assert.equal(r.rows.length, 0,
    'migration 16 is not applied in this fixture; restock must not silently gain an admin_users dependency');
});

test('FIX 15: the migration revokes the PUBLIC execute grant on handle_new_user', async () => {
  const r = await db.query(
    `select array_to_string(proacl, ',') as acl from pg_proc
     where proname = 'handle_new_user' and pronamespace = 'public'::regnamespace`);
  const acl = r.rows[0].acl || '';
  assert.doesNotMatch(acl, /(^|,)=/, 'no PUBLIC (=) execute may remain');
  assert.doesNotMatch(acl, /anon/, 'anon must not be able to execute it');
  assert.doesNotMatch(acl, /authenticated/, 'authenticated must not be able to execute it');
  assert.match(acl, /postgres=.*X/, 'postgres must retain execute so the trigger runs');
});

-- =============================================================================
-- 20261017000000_dslang_retail_order_update_hardening.sql
-- =============================================================================
-- Closes the guest-claim privilege-escalation on public.retail_orders.
--
-- THE DEFECT
--   `retail_orders_update_owner_claim` (20261007000000) was written as:
--
--     USING     (user_id is null
--                and auth.jwt()->>'email' <> ''
--                and lower(customer->>'email') = lower(auth.jwt()->>'email'))
--     WITH CHECK (user_id = auth.uid())
--
--   `WITH CHECK` validates `user_id` and NOTHING ELSE. RLS cannot restrict
--   *which columns* an UPDATE may write, and `retail_orders` carries a
--   table-level UPDATE grant to `authenticated` from the schema's default
--   privileges (so the `grant update (user_id)` on 20261006000000/07000000 is
--   inert -- a column grant cannot subtract from a table grant). The policies
--   are PERMISSIVE, so this check ORs with `retail_orders_update_admin`.
--
--   Net effect: anyone who knows a guest order's email could issue ONE
--   statement that set `user_id` (satisfying the check) while rewriting any
--   other column in the same breath:
--
--     update retail_orders
--        set user_id = <me>, order_status = 'delivered',
--            payment_status = 'success', total_amount = 1,
--            is_cod = false, stock_restored_at = now(), items = '[]'
--      where id = <victim>;
--
--   `stock_restored_at` is the worst of these: the database-level restock
--   function treats that stamp as terminal, so one statement could make stock
--   permanently unrestorable for that order.
--
-- THE FIX (defence in depth -- two independent layers)
--   1. DROP the claim policy entirely. A customer then holds no UPDATE policy
--      on the table at all, so every direct UPDATE matches zero rows. The
--      admin policy and therefore the Admin UI's direct writes are untouched.
--   2. Add a BEFORE UPDATE guard trigger that is the authoritative column
--      boundary. It is deliberately NOT a column REVOKE, because a column
--      revoke is provably defeatable here.
--
--   The claim itself moves into a narrowly scoped SECURITY DEFINER RPC that
--   writes exactly one column (`user_id`) and re-validates the email binding
--   server-side, so the intended customer flow is preserved.
--
-- INDEPENDENT OF 20261015000000
--   This migration depends only on public.retail_orders, public.admin_users
--   and the auth.* helpers, all of which already exist in production. It can be
--   applied on its own to close the live hole, without shipping the manual
--   courier feature.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Remove the customer UPDATE policy.
--
--    Deliberately NOT revoked: the table-level UPDATE grant to `authenticated`
--    is still required by the Admin UI, which writes `order_status` and
--    `customer` directly (src/pages/admin/AdminDashboard.tsx) and relies on the
--    `retail_orders_update_admin` policy. The boundary is the trigger below.
-- -----------------------------------------------------------------------------
drop policy if exists "retail_orders_update_owner_claim" on public.retail_orders;

-- An unauthenticated session has no legitimate reason to write a row.
revoke update on public.retail_orders from anon;

-- -----------------------------------------------------------------------------
-- 2) The column guard.
--
--    Unlike `retail_orders_guard_shipping_writes` (20261015000000), which
--    only watches the shipping columns, this one decides the *whole* row for
--    anyone who is not an admin or service_role. The diff is computed on the
--    serialised row minus `user_id`, so a column added by any future migration
--    is covered automatically without editing this function.
-- -----------------------------------------------------------------------------
-- This trigger function is deliberately NOT privilege-escalating. It must be
-- able to see the role the statement is really running as, and a definer-rights
-- trigger would report `current_user` as postgres for every caller, which would
-- make the check inside it inert. It needs no privileges of its own beyond
-- SELECT on admin_users, which `authenticated` already holds (and must, or
-- retail_orders_update_admin could not evaluate).
create or replace function public.retail_orders_guard_customer_writes()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''));
begin
  -- Anything that is not a client session. PostgREST runs an HTTP statement as
  -- the JWT's role (anon / authenticated); a client can never arrive here as
  -- anything else. Every other value means server-side code:
  --   * service_role  -- courier automation, payment webhooks, the expire sweep
  --   * postgres      -- any SECURITY DEFINER function, which already runs with
  --                      RLS switched off entirely (retail_orders is owned by
  --                      postgres and is not FORCE ROW LEVEL SECURITY)
  --   * authenticator -- a direct connection that never assumed a role
  -- Deferring here is REQUIRED, not merely convenient: convert_retail_order_to_cod
  -- is a live, customer-facing checkout function that legitimately writes is_cod,
  -- payment_status, amount_paid_upfront and amount_due_on_delivery. Without this
  -- branch, switching payment method at checkout would fail with 42501.
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- Courier automation, the payment webhooks and the expire sweep, in the case
  -- where they connect while still assuming an `authenticated` role.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- Administrators: the Admin UI's direct writes, and every SECURITY DEFINER
  -- RPC (auth.uid() still resolves to the caller's JWT inside them).
  if v_uid is not null
     and exists (select 1 from public.admin_users where user_id = v_uid) then
    return new;
  end if;

  -- Anyone else: the single permitted change is the one-shot guest claim.
  -- Requires that NOTHING but user_id moved, that the order was unclaimed,
  -- that the new owner is the caller, and that the guest email on the order
  -- is the caller's own JWT email. This is the same binding the dropped
  -- policy enforced, re-asserted at the row so a future policy cannot undo it.
  if v_uid is not null
     and v_email is not null
     and old.user_id is null
     and new.user_id is not distinct from v_uid
     and (to_jsonb(new) - 'user_id') is not distinct from (to_jsonb(old) - 'user_id')
     and lower(coalesce(old.customer ->> 'email', '')) = v_email then
    return new;
  end if;

  raise exception 'This order cannot be changed here. Contact the store for help.'
    using errcode = '42501';
end;
$$;

comment on function public.retail_orders_guard_customer_writes() is
  'Authoritative column boundary for retail_orders. Only service_role, an '
  'admin_users member, or a SECURITY DEFINER server function (which already '
  'bypasses RLS as the table owner) may write any column; a client holding an '
  'anon/authenticated JWT may perform exactly the one-shot guest-order claim '
  '(user_id only, on an unclaimed order whose guest email matches their JWT). '
  'Rejects with 42501. Supersedes the dropped retail_orders_update_owner_claim '
  'policy.';

revoke all on function public.retail_orders_guard_customer_writes() from public;

drop trigger if exists retail_orders_guard_customer_writes on public.retail_orders;
create trigger retail_orders_guard_customer_writes
  before update on public.retail_orders
  for each row
  execute function public.retail_orders_guard_customer_writes();

-- -----------------------------------------------------------------------------
-- 3) The claim, as a narrowly scoped SECURITY DEFINER RPC.
--
--    Replaces the two client-side `UPDATE ... SET user_id` calls in
--    src/lib/account.ts. The owner is taken from auth.uid(), never from a
--    parameter, so it cannot be spoofed. The only column written is user_id;
--    the guard trigger in section 2 re-checks that independently.
--
--    p_ref NULL  -> claim every unclaimed order matching the caller's email
--                   (the "Link to my account" bulk button)
--    p_ref given -> claim that one order, and only if it is unclaimed and the
--                   guest email matches the caller (post-checkout attach)
--
--    Returns { ok, claimed, refs }.
-- -----------------------------------------------------------------------------
create or replace function public.claim_retail_guest_order(p_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  v_want    text := nullif(btrim(coalesce(p_ref, '')), '');
  v_refs    text[] := '{}';
  v_claimed integer := 0;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  v_email := lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''));
  if v_email is null then
    raise exception 'This account has no email address, so guest orders cannot be linked.'
      using errcode = '42501';
  end if;

  -- Single-row attach when a reference is given, bulk claim when it is not.
  with claimed as (
    update public.retail_orders o
       set user_id = v_uid
     where o.user_id is null
       and lower(coalesce(o.customer ->> 'email', '')) = v_email
       and (v_want is null or o.ref = v_want)
    returning o.ref
  )
  select coalesce(array_agg(c.ref order by c.ref), '{}'::text[]), count(*)::int
    into v_refs, v_claimed
    from claimed c;

  return jsonb_build_object(
    'ok',      true,
    'claimed', v_claimed,
    'refs',    to_jsonb(v_refs)
  );
end;
$$;

comment on function public.claim_retail_guest_order(text) is
  'One-shot guest-order claim. Writes ONLY user_id, taken from auth.uid(). '
  'Binds on the order''s guest email matching the caller''s JWT email and on the '
  'order being unclaimed. p_ref NULL claims every match. Replaces the dropped '
  'retail_orders_update_owner_claim policy.';

revoke all on function public.claim_retail_guest_order(text) from public;
grant execute on function public.claim_retail_guest_order(text) to authenticated;
revoke execute on function public.claim_retail_guest_order(text) from anon;

-- -----------------------------------------------------------------------------
-- 4) Reload the PostgREST schema cache so the new RPC and the dropped column
--    surface are visible immediately.
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';

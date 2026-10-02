-- =============================================================================
-- Migration: 20261020000000_dslang_owner_select_and_guest_candidate_projection.sql
--
-- CLOSES A DATA-EXPOSURE GAP FOUND AFTER 20261019000000.
--
-- THE VULNERABILITY
--   20261019000000 correctly moved guest-order LINKING behind email + phone
--   proof. It did not touch the My Orders SELECT policy, which still granted a
--   FULL ROW to any signed-in caller whose JWT email matched the order's guest
--   email:
--
--     create policy "retail_orders_select_owner"
--       for select to authenticated
--       using (
--         user_id = auth.uid()
--         or (user_id is null
--             and lower(coalesce(customer->>'email','')) = lower(auth.jwt()->>'email'))
--       );
--
--   Guest checkout accepts ANY email address, so that match proved nothing. A
--   row granted this way carries `id`, `items` and the whole `customer` jsonb:
--   delivery name, phone, street address, city, state and pincode, plus every
--   item, size and line total. Anyone who learned or guessed an address used at
--   guest checkout could sign up with it and read that customer's purchase.
--
--   This was strictly WORSE than the app's own public tracking path, which
--   requires ref + a 10-digit phone (`track_lookup_order`) for exactly this
--   reason. It also handed the caller the `id` needed to then POST
--   `/api/cashfree-order` and take permanent ownership, which the same session
--   removed by dropping its service-role email-match claim.
--
-- WHAT THIS DOES
--   1. `retail_orders_select_owner` now matches OWNED ORDERS ONLY
--      (`user_id = auth.uid()`). An email match returns nothing at all. This is
--      a TIGHTENING: no previously readable row becomes newly readable, and the
--      policy is not weakened anywhere.
--
--   2. Adds `public.list_retail_guest_candidates(p_phone text)`, a SECURITY
--      DEFINER function that is the ONLY way to discover an unclaimed guest
--      order from an account. It requires the caller's JWT email to match AND a
--      caller-supplied 10-digit phone to match the phone captured on the order
--      - the same two proofs, normalised exactly the way
--      `claim_retail_guest_order` and `track_lookup_order` normalise them.
--
--      It returns a PII-FREE PROJECTION and nothing else:
--        ref, created_at, total_amount, total_qty, is_cod, payment_status
--      Deliberately ABSENT: `id`, `customer` (so no name, phone, address, city,
--      state or pincode), and `items` (so no product, size or line detail). The
--      projection cannot be used to address a row through any other endpoint,
--      because it carries no `id` and no delivery data.
--
--   3. Declined orders stay invisible. `claim_declined_at IS NOT NULL` rows are
--      excluded, so an order the shopper answered "not mine" is neither
--      discoverable nor linkable. This is a deliberate behaviour change: such
--      orders used to remain LISTED in My Orders with their full delivery
--      snapshot, which was itself part of this leak. They remain fully
--      trackable on the public Track Order page, which re-proves possession
--      with ref + phone.
--
-- NOT CHANGED
--   * `claim_retail_guest_order` / `decline_retail_guest_order` are untouched.
--     Their proofs, grants and the `retail_orders_guard_customer_writes` row
--     guard are exactly as 20261019000000 left them.
--   * No pricing, payment, COD, stock, shipping, tracking or return logic.
--   * No order is linked, unlinked, declined or modified by this migration. It
--     is pure policy + function definition.
--   * `retail_orders_select_admin` is untouched, so admin tooling is unaffected.
--
-- ADDITIVE + IDEMPOTENT + RE-RUNNABLE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) My Orders SELECT - owned rows only.
--
--    The email-match branch is REMOVED, not merely supplemented. Leaving it in
--    place with an extra condition would keep a row-level grant that returns
--    the full `customer` jsonb, which is the leak itself.
-- -----------------------------------------------------------------------------
drop policy if exists "retail_orders_select_owner" on public.retail_orders;
create policy "retail_orders_select_owner"
  on public.retail_orders
  for select
  to authenticated
  using (user_id = auth.uid());

comment on policy "retail_orders_select_owner" on public.retail_orders is
  'Owned orders only. An unclaimed guest order is NOT readable here on an email match: guest checkout accepts any address, so a matching email is not proof of possession, and this policy returns the full row including the delivery jsonb. Unclaimed guest orders are discovered through public.list_retail_guest_candidates(p_phone), which requires email AND a 10-digit phone and returns a PII-free projection with no id, customer or items. Tightened 20261020000000.';

-- -----------------------------------------------------------------------------
-- 2) The only discovery path for an unclaimed guest order.
--
--    Proof is identical to the claim RPC, so nothing is discoverable here that
--    could not already have been claimed with the same two answers. The
--    difference is only the SHAPE of what comes back: a projection with no
--    identifying data and no row address.
-- -----------------------------------------------------------------------------
create or replace function public.list_retail_guest_candidates(p_phone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_phone  text;
begin
  if (v_uid is null) then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  v_email := lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''));
  if v_email is null then
    raise exception 'Your account has no email address on file.' using errcode = '42501';
  end if;

  -- Same normalisation as claim_retail_guest_order / track_lookup_order, so all
  -- three paths agree on what "the same phone number" means.
  v_phone := nullif(regexp_replace(btrim(coalesce(p_phone, '')), '[^0-9]', '', 'g'), '');
  if v_phone is null or length(v_phone) <> 10 then
    raise exception 'Enter the 10-digit phone number used on the order to find it.' using errcode = '42501';
  end if;

  -- PII-free by construction. If a field is not listed here it cannot leak:
  -- `id` is absent (no row is addressable), `customer` is absent (no delivery
  -- data), `items` is absent (no product detail).
  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'ref',            o.ref,
               'created_at',     o.created_at,
               'total_amount',   o.total_amount,
               'total_qty',      o.total_qty,
               'is_cod',         o.is_cod,
               'payment_status', o.payment_status
             )
             order by o.created_at asc, o.ref asc
           )
    from public.retail_orders o
    where o.user_id is null
      and o.claim_declined_at is null
      and lower(coalesce(o.customer ->> 'email', '')) = v_email
      and nullif(regexp_replace(coalesce(o.customer ->> 'phone', ''), '[^0-9]', '', 'g'), '') = v_phone
  ), '[]'::jsonb);
end;
$$;

comment on function public.list_retail_guest_candidates(text) is
  'PII-free discovery of unclaimed guest orders for a signed-in shopper. Requires BOTH proofs: the order''s guest email equals the caller''s JWT email AND the caller-supplied p_phone equals the phone captured on the order (both normalised to 10 digits), the same proof claim_retail_guest_order requires. Returns only ref, created_at, total_amount, total_qty, is_cod and payment_status - never id, customer or items - so nothing returned can address a row or expose delivery or product detail. Declined orders (claim_declined_at set) are excluded. Added 20261020000000 to replace the email-only My Orders SELECT grant.';

revoke all on function public.list_retail_guest_candidates(text) from public;
grant execute on function public.list_retail_guest_candidates(text) to authenticated;
revoke execute on function public.list_retail_guest_candidates(text) from anon;
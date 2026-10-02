-- =============================================================================
-- Migration: 20261019000000_dslang_guest_claim_phone_proof.sql
--
-- CLOSES A DATA-EXPOSURE GAP: a guest order is linked to an account on an
-- EMAIL MATCH ALONE.
--
-- THE VULNERABILITY
--   20260930000000 chose to link guest orders by email and removed the phone
--   OTP login that used to back it. That decision was correct about LOGIN, but
--   it silently also removed the PROOF from the ownership check, and the two
--   were conflated.
--
--   `claim_retail_guest_order` (20261017000000) linked an order when
--     o.user_id is null
--     and lower(coalesce(o.customer->>'email','')) = lower(auth.jwt()->>'email')
--   `retail_orders_guard_customer_writes` (same migration) independently
--   re-asserted exactly the same binding at row level, so no policy change could
--   loosen it either.
--
--   Guest checkout accepts ANY email, so email is not proof of anything: it is
--   a string the customer typed. Anyone who learns or guesses an address used at
--   guest checkout could sign up with it and permanently pull that order — with
--   its full delivery address, items and totals — into their account.
--
--   This is weaker than the app's own public tracking path, which already
--   requires ref + a 10-digit phone (`track_lookup_order`) precisely because
--   email is not treated as possession there. This migration makes the account
--   claim path at least as strong as the tracking path.
--
-- WHAT THIS DOES
--   1. `claim_retail_guest_order` now takes a `p_phone` proof factor and
--      requires email AND phone to match. The email match alone no longer links
--      anything. The phone supplied by the caller is compared against the phone
--      captured on the order at checkout, normalised exactly the way
--      `track_lookup_order` normalises it, so the two paths agree on what "the
--      same phone number" means.
--   2. The row guard re-asserts the phone proof independently, so the boundary
--      survives a future policy edit. Because the proof is a function ARGUMENT
--      (a Google-OAuth JWT carries no phone since OTP login was removed), the RPC
--      hands it to the trigger through a TRANSACTION-LOCAL setting. The trigger
--      still refuses anything it cannot verify itself.
--   3. `claim_declined_at` is a STORED decision. "Not mine" has to survive
--      reloads, other devices and cache clears, so it lives on the row rather
--      than in the browser. A declined order is never offered again and can
--      never be claimed.
--   4. The old one-argument overload is DROPPED, not merely superseded. Leaving
--      it in place would keep the email-only path callable and would make this
--      migration purely cosmetic.
--
-- NOT CHANGED
--   * OTP LOGIN STAYS REMOVED. This reverses only the ownership-check side
--     effect of 20260930000000; it does not reintroduce phone login.
--   * No order is linked, unlinked, or denied by this migration. It is pure
--     schema + function definition. Existing `user_id` values are untouched.
--   * No payment, shipping, pricing, stock or tracking logic is touched.
--
-- ADDITIVE + IDEMPOTENT + RE-RUNNABLE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) The stored "this is not mine" decision.
--
--    Scoped to the order row rather than the account, which is correct here: a
--    candidate must already match the caller's JWT email to be offered at all,
--    so the row is already effectively scoped to that email.
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists claim_declined_at timestamptz;

comment on column public.retail_orders.claim_declined_at is
  'When a signed-in customer was shown this unlinked order and answered "not mine". A non-null value permanently removes the order from guest-claim candidates for that email and blocks any further claim. Set only through decline_retail_guest_order(), which requires the same email + phone proof as a claim. NULL for every order that was never offered.';

create index if not exists idx_retail_orders_claim_candidates
  on public.retail_orders (lower(coalesce(customer ->> 'email', '')))
  where user_id is null and claim_declined_at is null;

-- -----------------------------------------------------------------------------
-- 2) The claim RPC, now with a phone proof factor.
--
--    p_ref NULL  -> claim every eligible order matching this caller's email
--                   AND phone (bulk "link my guest orders")
--    p_ref given -> claim that one order only, under the same two proofs
--
--    Both proofs are required. A caller who cannot supply the phone claims
--    nothing, which is the point: an email alone is not ownership.
-- -----------------------------------------------------------------------------
create or replace function public.claim_retail_guest_order(
  p_ref   text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_phone  text;
  v_want   text := nullif(btrim(coalesce(p_ref, '')), '');
  v_refs   text[] := '{}';
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

  -- The proof factor. Normalised exactly like track_lookup_order's phone match,
  -- so a customer who already tracks an order with this number is not asked for
  -- a different format of the same number.
  v_phone := nullif(regexp_replace(btrim(coalesce(p_phone, '')), '[^0-9]', '', 'g'), '');
  if v_phone is null or length(v_phone) <> 10 then
    raise exception 'Enter the 10-digit phone number used on the order to confirm it is yours.'
      using errcode = '42501';
  end if;

  -- Hand the proof to the row guard, which cannot see an RPC argument. The
  -- setting is LOCAL to this transaction, so it cannot leak to a later request
  -- on the same pooled connection.
  perform set_config('dslang.claim_phone', v_phone, true);

  with claimed as (
    update public.retail_orders o
       set user_id = v_uid
     where o.user_id is null
       and o.claim_declined_at is null
       and lower(coalesce(o.customer ->> 'email', '')) = v_email
       and nullif(regexp_replace(coalesce(o.customer ->> 'phone', ''), '[^0-9]', '', 'g'), '') = v_phone
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

comment on function public.claim_retail_guest_order(text, text) is
  'Guest-order claim. Writes ONLY user_id, taken from auth.uid(). Requires BOTH proofs: the order''s guest email must equal the caller''s JWT email AND the caller-supplied p_phone must equal the phone captured on the order (both normalised to 10 digits). Email alone never links. p_ref NULL claims every eligible match; p_ref given claims that one. Orders with claim_declined_at set are permanently ineligible. Replaces the email-only overload.';

-- The email-only overload is DROPPED, not left alongside. If it survived it
-- would still be callable and this migration would change nothing.
drop function if exists public.claim_retail_guest_order(text);

revoke all on function public.claim_retail_guest_order(text, text) from public;
grant execute on function public.claim_retail_guest_order(text, text) to authenticated;
revoke execute on function public.claim_retail_guest_order(text, text) from anon;

-- -----------------------------------------------------------------------------
-- 3) "Not mine" — the stored decline.
--
--    Symmetric with the claim: the same email AND phone proof. That is
--    deliberate. If a decline only needed the email, anyone who guessed an
--    address could permanently hide a real customer's order from their own
--    account. Requiring the same proof on both sides keeps the write boundary
--    identical, and means the card can offer Yes and No from the same verified
--    step without one of them being the weak link.
-- -----------------------------------------------------------------------------
create or replace function public.decline_retail_guest_order(
  p_ref   text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_phone  text;
  v_ref    text := nullif(btrim(coalesce(p_ref, '')), '');
  v_stored integer := 0;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  v_email := lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''));
  if v_email is null then
    raise exception 'This account has no email address.' using errcode = '42501';
  end if;

  v_phone := nullif(regexp_replace(btrim(coalesce(p_phone, '')), '[^0-9]', '', 'g'), '');
  if v_phone is null or length(v_phone) <> 10 then
    raise exception 'Enter the 10-digit phone number used on the order to confirm it is yours.'
      using errcode = '42501';
  end if;

  if v_ref is null then
    raise exception 'No order reference supplied.' using errcode = '42501';
  end if;

  perform set_config('dslang.claim_phone', v_phone, true);

  with declined as (
    update public.retail_orders o
       set claim_declined_at = now()
     where o.ref = v_ref
       and o.user_id is null
       and o.claim_declined_at is null
       and lower(coalesce(o.customer ->> 'email', '')) = v_email
       and nullif(regexp_replace(coalesce(o.customer ->> 'phone', ''), '[^0-9]', '', 'g'), '') = v_phone
    returning o.ref
  )
  select count(*)::int into v_stored from declined;

  return jsonb_build_object('ok', true, 'declined', v_stored);
end;
$$;

comment on function public.decline_retail_guest_order(text, text) is
  'Stores a "not mine" decision for one unlinked guest order. Requires the SAME two proofs as a claim: the order''s guest email must equal the caller''s JWT email AND the caller-supplied p_phone must equal the phone on the order. Writes ONLY claim_declined_at. A declined order is permanently ineligible for that email, so the customer is never asked about it again.';

revoke all on function public.decline_retail_guest_order(text, text) from public;
grant execute on function public.decline_retail_guest_order(text, text) to authenticated;
revoke execute on function public.decline_retail_guest_order(text, text) from anon;

-- -----------------------------------------------------------------------------
-- 4) The row guard, re-asserted.
--
--    This is the authoritative boundary and it must be able to VERIFY the phone
--    proof on its own, not trust that the calling function did. It reads the
--    proof from the transaction-local setting the two RPCs above set
--    (`dslang.claim_phone`); with no such setting the value is NULL and both
--    branches below fail, so a client that tries to UPDATE retail_orders
--    directly gets 42501 exactly as before.
--
--    Two permitted shapes for a non-admin client, and only these two:
--      (a) CLAIM  — user_id NULL -> caller's uid, nothing else on the row moved,
--                   order was unclaimed and not declined, phone proof matches.
--      (b) DECLINE— claim_declined_at NULL -> now(), nothing else moved,
--                   phone proof matches.
--
--    OTP login remains removed; `v_email` is still the caller's own JWT email
--    and is still required, so this widens the evidence, never the authority.
-- -----------------------------------------------------------------------------
create or replace function public.retail_orders_guard_customer_writes()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), ''));
  -- The proof handed over by the SECURITY DEFINER claim/decline RPC, in the
  -- same transaction. NULL for anything that did not come through one of them.
  v_proof text := nullif(regexp_replace(coalesce(current_setting('dslang.claim_phone', true), ''), '[^0-9]', '', 'g'), '');
  v_row_phone text;
begin
  -- Server-side callers bypass this entirely (unchanged from 20261017000000).
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if v_uid is not null
     and exists (select 1 from public.admin_users where user_id = v_uid) then
    return new;
  end if;

  v_row_phone := nullif(regexp_replace(coalesce(old.customer ->> 'phone', ''), '[^0-9]', '', 'g'), '');

  -- The claim and the decline, both behind the phone proof.
  if v_uid is not null
     and v_email is not null
     and v_proof is not null
     and v_row_phone is not null
     and v_row_phone = v_proof
     and lower(coalesce(old.customer ->> 'email', '')) = v_email
     and old.user_id is null
     and old.claim_declined_at is null
     and (
       (     new.user_id is not distinct from v_uid
         and new.claim_declined_at is null
         and (to_jsonb(new) - 'user_id') is not distinct from (to_jsonb(old) - 'user_id') )
       or
       (     new.user_id is null
         and new.claim_declined_at is not null
         and (to_jsonb(new) - 'claim_declined_at') is not distinct from (to_jsonb(old) - 'claim_declined_at') )
     ) then
    return new;
  end if;

  raise exception 'This order cannot be changed here. Contact the store for help.'
    using errcode = '42501';
end;
$$;

comment on function public.retail_orders_guard_customer_writes() is
  'Authoritative column boundary for retail_orders. Only service_role, an admin_users member, or a SECURITY DEFINER server function may write any column. For a plain client the ONLY permitted changes are the two guest-claim outcomes, and both now require the phone proof supplied through the claim/decline RPC: (a) user_id set to the caller on an unclaimed, undeclined order, or (b) claim_declined_at stamped. Both also require the order''s guest email to equal the caller''s JWT email. Rejects with 42501.';

revoke all on function public.retail_orders_guard_customer_writes() from public;

drop trigger if exists retail_orders_guard_customer_writes on public.retail_orders;
create trigger retail_orders_guard_customer_writes
  before update on public.retail_orders
  for each row
  execute function public.retail_orders_guard_customer_writes();

-- -----------------------------------------------------------------------------
-- 5) Surface the new column and RPCs to PostgREST.
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';


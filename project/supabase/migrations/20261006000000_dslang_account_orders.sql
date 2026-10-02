-- ----------------------------------------------------------------------------
-- DSLANG Account System — optional customer accounts (Google OAuth + phone OTP).
-- Everything here is ADDITIVE and backwards-safe: guests keep buying with zero
-- login (no checkout field requires it, no redirect in the purchase flow), and
-- this migration can be applied any time AFTER the frontend ships. Until it is
-- applied the signed-in extras (My Orders, saved-details prefill, user_id
-- linking) simply no-op on the client.
--   * retail_orders.user_id       : nullable account owner (guest orders stay NULL)
--   * retail_orders owner SELECT  : my orders = user_id=me OR verified phone/email
--     match on GUEST orders (possession = verification)
--   * retail_orders CLAIM UPDATE  : one-time link of a matching guest order
--   * customer_profiles           : optional "Save your details" address record
-- ----------------------------------------------------------------------------

-- 1) user_id — nullable link from a retail order to the signed-in shopper who
--    placed it (or later claimed it). NULL for every guest order.
alter table public.retail_orders
  add column if not exists user_id uuid references auth.users (id) on delete set null;

comment on column public.retail_orders.user_id is
  'Nullable account owner. Set when a signed-in shopper placed the order or claimed a matching guest order. Guards owner-level My Orders access.';

create index if not exists idx_retail_orders_user_id
  on public.retail_orders (user_id) where user_id is not null;

-- 2) My Orders SELECT — a signed-in shopper may read their own orders: the ones
--    they placed while signed in (user_id = me) plus past GUEST orders whose
--    phone or email matches a VERIFIED identity claim (SMS OTP number, Google/
--    email address). Possession = verification: only the person able to receive
--    the OTP or control the Google account sees those orders. Admins keep their
--    existing broader policy; anon sees nothing (unchanged).
drop policy if exists "retail_orders_select_owner" on public.retail_orders;
create policy "retail_orders_select_owner"
  on public.retail_orders
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id is null
      and (
        customer->>'phone' = coalesce(auth.jwt()->>'phone', '')
        or lower(coalesce(customer->>'email', '')) = lower(coalesce(auth.jwt()->>'email', ''))
      )
    )
  );

-- 3) CLAIM + attach — a shopper may set user_id on a guest order (including the
--    order they just placed while signed in) exactly once, only while it is
--    still unclaimed, and only when its phone/email matches their verified
--    identity. WITH CHECK forces the write to point at the caller — it can only
--    ever become 'me'.
drop policy if exists "retail_orders_update_owner_claim" on public.retail_orders;
create policy "retail_orders_update_owner_claim"
  on public.retail_orders
  for update
  to authenticated
  using (
    user_id is null
    and (
      customer->>'phone' = coalesce(auth.jwt()->>'phone', '')
      or lower(coalesce(customer->>'email', '')) = lower(coalesce(auth.jwt()->>'email', ''))
    )
  )
  with check (user_id = auth.uid());

-- 4) Table-level grants for the roles those policies rely on. Anonymous/anonymous
--    behavior is untouched — guests behave exactly as before this migration.
grant select, update (user_id) on public.retail_orders to authenticated;

-- 5) customer_profiles — the optional "Save your details" record a signed-in
--    shopper opts into on the Order Confirmed / My Orders surfaces. Used to
--    prefill checkout for next time.
create table if not exists public.customer_profiles (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  name     text not null,
  phone    text not null,
  email    text,
  address  text not null,
  apartment text,
  city     text not null,
  state    text not null,
  pincode  text not null,
  country  text not null default 'India',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_profiles enable row level security;

drop policy if exists "customer_profiles_select_owner" on public.customer_profiles;
create policy "customer_profiles_select_owner"
  on public.customer_profiles
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "customer_profiles_insert_owner" on public.customer_profiles;
create policy "customer_profiles_insert_owner"
  on public.customer_profiles
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "customer_profiles_update_owner" on public.customer_profiles;
create policy "customer_profiles_update_owner"
  on public.customer_profiles
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.customer_profiles to authenticated;

-- Keep updated_at fresh on profile saves.
create or replace function public.set_customer_profile_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customer_profiles_set_updated_at on public.customer_profiles;
create trigger customer_profiles_set_updated_at
  before update on public.customer_profiles
  for each row execute function public.set_customer_profile_updated_at();
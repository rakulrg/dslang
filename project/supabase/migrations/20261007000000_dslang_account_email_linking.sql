-- ----------------------------------------------------------------------------
-- DSLANG Account System — link guest orders by EMAIL (phone OTP auth removed).
-- Supersedes the phone/email identity matching introduced in
-- 20261006000000_dslang_account_orders.sql:
--   * My Orders SELECT  : user_id=me OR user_id IS NULL AND guest EMAIL matches
--                         the signed-in account's email.
--   * CLAIM UPDATE      : one-time link of a matching unclaimed guest order.
-- Phone is UNCHANGED as a checkout / delivery field (retail_orders.customer->
-- 'phone', customer_profiles.phone, order/SMS notification flags all stay) — it
-- simply no longer works as an auth identity because SMS OTP sign-in was removed.
-- Nothing here is destructive: guests still place orders with zero login, and
-- this file can be pushed any time after the frontend ships.
-- ----------------------------------------------------------------------------

-- 1) My Orders SELECT — email match only. Possession of the login email = proof
--    of ownership of the guest order. google/email accounts both expose their
--    address on the JWT identically, so OAuth and email/password sign-ins link
--    past guest orders the same way.
drop policy if exists "retail_orders_select_owner" on public.retail_orders;
create policy "retail_orders_select_owner"
  on public.retail_orders
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id is null
      and auth.jwt()->>'email' <> ''
      and lower(coalesce(customer->>'email', '')) = lower(auth.jwt()->>'email')
    )
  );

-- 2) CLAIM + attach — email match only, still one-time, still MUST point at the
--    caller (WITH CHECK user_id = auth.uid()).
drop policy if exists "retail_orders_update_owner_claim" on public.retail_orders;
create policy "retail_orders_update_owner_claim"
  on public.retail_orders
  for update
  to authenticated
  using (
    user_id is null
    and auth.jwt()->>'email' <> ''
    and lower(coalesce(customer->>'email', '')) = lower(auth.jwt()->>'email')
  )
  with check (user_id = auth.uid());

-- 3) Grants unchanged from the account-orders migration (email-link relies on
--    the exact same privileges).
grant select, update (user_id) on public.retail_orders to authenticated;
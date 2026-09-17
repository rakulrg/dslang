-- P1: drop the legacy wholesale `orders_insert_public` grant.
--
-- `public.orders` is the retired wholesale table. Its only RLS write policy is
-- `orders_insert_public` (`FOR INSERT TO authenticated, anon WITH CHECK (true)`),
-- which grants ANY anonymous client a literal insert on an orders table — an
-- unauthenticated write surface that nothing legitimately uses anymore.
--
-- The retail side writes to `retail_orders` exclusively through the SECURITY
-- DEFINER `create_retail_order` RPC (stock-validated, server-priced), and the
-- legacy `create_wholesale_order` RPC is also SECURITY DEFINER — so both order
-- paths still work without any client INSERT privilege.
--
-- Reads on public.orders remain admin-only via orders_select_admin.

drop policy if exists "orders_insert_public" on public.orders;
-- ============================================================================
-- Migration: 20260920000000_dslang_restock_retail_orders.sql
--
-- WHY: create_retail_order decrements product_sizes.stock at order placement,
-- but nothing ever returned that stock when an order did not actually sell:
--   * payment confirmed FAILED (Cashfree webhook / status) left the stock
--     locked down forever on an abandoned order;
--   * an admin deleting/cancelling an order removed the row with no restock.
-- Net effect: every failed/cancelled checkout permanently reduced sellable
-- inventory (inventory drift).
--
-- FIX:
--   1) retail_orders.stock_restored_at — idempotency flag (NULL = never
--      restocked). The restock only fires if this is still NULL, so an order
--      can never be restocked twice (e.g. a failed payment restocked by the
--      webhook, then later deleted by an admin).
--   2) public.restock_retail_order_items(p_order_id) — SECURITY DEFINER helper
--      that locks the order row FOR UPDATE (serializes webhook/status/admin
--      races), applies the AUTHORIZATION (skip) rules, and atomically adds the
--      order's line-item quantities back to product_sizes (+ available flag).
--   3) delete_retail_order now calls restock_retail_order_items before the
--      DELETE, inside the same transaction, so an admin delete/cancel restores
--      stock exactly once and then removes the order.
--
-- SKIP RULES (order is NOT restocked):
--   * payment_status = 'success'          — it was paid; refunds handle that.
--   * order_status IN ('shipped','delivered','refunded')  — stock already left
--     the building / money already came back.
--   * stock_restored_at IS NOT NULL       — already restocked (idempotency).
--
-- Additive + idempotent: adds one column + one function; re-creates
-- delete_retail_order with the same signature. No table/column drop.
-- ============================================================================

-- 1) Idempotency flag.
alter table public.retail_orders
  add column if not exists stock_restored_at timestamptz;

comment on column public.retail_orders.stock_restored_at is
  'Timestamp when line-item stock was returned to product_sizes (failed/cancelled order). NULL = not yet restocked. Guards against double restock.';

-- 2) The shared, skip-rule-aware restock helper.
create or replace function public.restock_retail_order_items(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.retail_orders%rowtype;
  v_updated integer := 0;
begin
  if p_order_id is null then
    return 0;
  end if;

  -- Lock the order row so concurrent webhook / status-poll / admin-delete
  -- paths serialize to a single restock. The lock is held until commit.
  select * into v_order
  from public.retail_orders
  where id = p_order_id
    and order_type = 'retail'
  for update;

  if not found then
    return 0;
  end if;

  -- Skip: paid order, or stock already gone out (fulfilled/refunded).
  if v_order.payment_status = 'success' then
    return 0;
  end if;
  if v_order.order_status in ('shipped', 'delivered', 'refunded') then
    return 0;
  end if;

  -- Skip: already restocked (idempotency guard).
  if v_order.stock_restored_at is not null then
    return 0;
  end if;

  -- Add the order's quantities back, aggregated per product/colour/size so a
  -- multi-line or duplicate-line order updates each stock row exactly once.
  update public.product_sizes ps
  set stock = ps.stock + s.qty,
      available = (ps.stock + s.qty) > 0
  from (
    select (x.item->>'product_id')::uuid  as product_id,
           (x.item->>'color_id')::uuid    as color_id,
           x.item->>'size_label'          as size_label,
           sum((x.item->>'quantity')::int) as qty
    from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) as x(item)
    where coalesce((x.item->>'quantity')::int, 0) > 0
      and x.item->>'product_id' is not null
      and x.item->>'color_id' is not null
      and x.item->>'size_label' is not null
    group by 1, 2, 3
  ) s
  where ps.product_id = s.product_id
    and ps.color_id = s.color_id
    and ps.size_label = s.size_label;

  get diagnostics v_updated = row_count;

  -- Mark restocked (NULL -> now) so a second call is a no-op.
  update public.retail_orders
  set stock_restored_at = now()
  where id = v_order.id;

  return v_updated;
end;
$$;

revoke all on function public.restock_retail_order_items(uuid) from public;
grant execute on function public.restock_retail_order_items(uuid)
  to service_role;

-- This DB ships default privileges that auto-grant EXECUTE to
-- anon/authenticated/service_role on every new function, so REVOKE FROM PUBLIC
-- above is not enough — the per-role grants are explicit in the ACL. restock
-- must be service_role-ONLY (it has no in-body auth gate of its own).
revoke execute on function public.restock_retail_order_items(uuid) from anon;
revoke execute on function public.restock_retail_order_items(uuid) from authenticated;

-- 3) Admin delete/cancel now restocks (once) before removing the order.
create or replace function public.delete_retail_order(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can delete orders.';
  end if;

  if p_order_id is null then
    raise exception 'An order id is required.';
  end if;

  -- Restock (honours skip rules + idempotency flag, locks the row) atomically
  -- with the delete below.
  perform public.restock_retail_order_items(p_order_id);

  select promo_code into v_code
  from public.retail_orders
  where id = p_order_id and order_type = 'retail';

  delete from public.retail_orders
  where id = p_order_id and order_type = 'retail';
  get diagnostics v_deleted = row_count;

  -- Reverse the promo usage increment made at order creation, if any.
  if v_deleted = 1 and v_code is not null and trim(v_code) <> '' then
    update public.promo_codes
    set used_count = greatest(used_count - 1, 0)
    where upper(code) = upper(trim(v_code));
  end if;

  return v_deleted;
end;
$$;

revoke all on function public.delete_retail_order(uuid) from public;
grant execute on function public.delete_retail_order(uuid) to authenticated;

-- The admin gate lives in-body, but anon should not even reach it.
revoke execute on function public.delete_retail_order(uuid) from anon;

-- --- Security hygiene (default privileges) ----------------------------------
-- Stop the DB's default privileges auto-granting EXECUTE to anon/authenticated
-- on future functions, and drop the legacy anon grant on the stock setter
-- (its in-body admin gate remains the real control, this is defense-in-depth).
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;
revoke execute on function public.set_product_size_stock(uuid, uuid, text, integer) from anon;

notify pgrst, 'reload schema';
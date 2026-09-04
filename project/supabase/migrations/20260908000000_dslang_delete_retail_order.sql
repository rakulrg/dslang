-- ============================================================================
-- Migration: 20260908000000_dslang_delete_retail_order.sql
-- Purpose:   Provide the Admin Orders panel with a permanent, server-blessed
--            delete operation for a single retail order.
--
-- Why an RPC (not a direct client .delete()):
--   * retail_orders has INSERT/SELECT/UPDATE policies but NO FOR DELETE policy,
--     so with RLS enabled a direct client-side delete is denied by default.
--   * SECURITY DEFINER lets the function delete through RLS while the in-function
--     admin gate remains the authoritative authorization check.
--   * It runs as ONE transactional statement, so the promo usage cleanup and
--     the order removal happen atomically (all-or-nothing).
--
-- Security model (mirrors set_product_size_stock):
--   * SECURITY DEFINER + fixed search_path = public.
--   * Requires auth.uid() AND membership in admin_users (a normal customer can
--     never delete).
--   * Deletes ONLY the row whose id matches p_order_id and whose order_type is
--     'retail' — it can never touch another order or any customer record.
--   * REVOKE from PUBLIC; EXECUTE only for authenticated.
--
-- Related-data cleanup (existing relationships):
--   * Order items + customer live as jsonb columns on the retail_orders row
--     itself, so deleting the row removes all of its associated data atomically.
--   * When an order used a promo code, create_retail_order increments that
--     code's used_count; deleting the order reverses it so the promo's remaining
--     usage stays accurate. The decrement is guarded so used_count never goes
--     below zero.
-- ============================================================================

-- 1) The RPC. Returns the number of rows actually deleted (0 => id not found),
--    so the admin UI can distinguish a missing order from a real failure.
CREATE OR REPLACE FUNCTION public.delete_retail_order(
  p_order_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
  v_code text;
BEGIN
  -- Require an authenticated user.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required.';
  END IF;

  -- Admin authorization gate.
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only an authorized administrator can delete orders.';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'An order id is required.';
  END IF;

  -- Capture any promo code used by this order so its usage counter can be
  -- reversed right after. Restrict to retail orders only.
  SELECT promo_code INTO v_code
  FROM public.retail_orders
  WHERE id = p_order_id AND order_type = 'retail';

  DELETE FROM public.retail_orders
  WHERE id = p_order_id AND order_type = 'retail';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Reverse the promo usage increment made at order creation, if any.
  -- Guarded so used_count can never drop below zero.
  IF v_deleted = 1 AND v_code IS NOT NULL AND trim(v_code) <> '' THEN
    UPDATE public.promo_codes
    SET used_count = greatest(used_count - 1, 0)
    WHERE upper(code) = upper(trim(v_code));
  END IF;

  RETURN v_deleted;
END;
$$;

-- 2) Lock it down: not callable by the public; only authenticated users may
--    attempt it, and the in-function admin check is the authoritative gate.
REVOKE ALL ON FUNCTION public.delete_retail_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_retail_order(uuid) TO authenticated;

-- 3) Reload the PostgREST schema cache so the newly defined function is
--    immediately resolvable by name. Safe: only emits NOTIFY, no DDL.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- Migration: 20260817000000_dslang_set_product_size_stock_rpc.sql
-- Purpose:   Create the set_product_size_stock RPC used by the admin Size
--            Manager (src/lib/admin.ts). This function was referenced by the
--            frontend but never created, so stock updates failed at runtime.
--
-- Security model:
--   * SECURITY DEFINER so the function can update product_sizes rows while
--     RLS remains fully enforced for direct table access.
--   * Fixed safe search_path = public.
--   * Admin authorization verified INSIDE the function using the existing
--     admin_users table (same mechanism as the storage/color lock policies).
--   * Only product_sizes.stock is updated. No other columns are touched.
--   * RLS is not disabled or weakened anywhere.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_product_size_stock(
  p_size_id uuid,
  p_stock integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1) Require an authenticated user.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required.';
  END IF;

  -- 2) Admin authorization check.
  --    Uses the SAME mechanism as the existing admin lock policies:
  --    EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  --    Because the function is SECURITY DEFINER, it can read admin_users
  --    regardless of RLS, but it only tests membership — it never returns
  --    admin data to the caller.
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only an authorized administrator can update stock.';
  END IF;

  -- 3) Validate p_stock is a non-negative integer.
  IF p_stock IS NULL OR p_stock < 0 THEN
    RAISE EXCEPTION 'Stock must be a non-negative integer.';
  END IF;

  -- 4) Update ONLY the stock column for the specified row.
  UPDATE public.product_sizes
  SET stock = p_stock
  WHERE id = p_size_id;
END;
$$;

-- Only authenticated users may attempt the call; the in-function admin check
-- is the authoritative gatekeeper. No service-role key is involved.
REVOKE ALL ON FUNCTION public.set_product_size_stock(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_product_size_stock(uuid, integer) TO authenticated;
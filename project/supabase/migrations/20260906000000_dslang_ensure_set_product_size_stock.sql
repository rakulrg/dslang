-- ============================================================================
-- Migration: 20260906000000_dslang_ensure_set_product_size_stock.sql
-- Purpose:   Guarantee the exact set_product_size_stock RPC that the admin
--            stock UI (src/lib/admin.ts adminSetSizeStock) calls actually
--            exists in the live database and matches its argument names/order.
--
-- Background:
--   The admin Product editor calls:
--       supabase.rpc('set_product_size_stock', {
--         p_product_id, p_color_id, p_size_label, p_stock
--       })
--   The earlier migration `20260817040000_color_wise_stock.sql` defined this
--   4-argument function, but the live database reports:
--       Could not find the function public.set_product_size_stock(
--         p_color_id, p_product_id, p_size_label, p_stock) in the schema cache
--   That means the 4-arg function is absent OR its schema-cache entry is stale.
--   This migration idempotently (re)creates the exact function and reloads the
--   PostgREST schema cache so the call resolves. It is additive and safe: no
--   tables are dropped/truncated and no product / color / stock data is touched.
--
-- Security model (unchanged from the original):
--   * SECURITY DEFINER so it can UPDATE product_sizes while RLS stays enforced
--     for direct table access.
--   * Fixed safe search_path = public.
--   * Admin authorization checked INSIDE the function against admin_users.
--   * Only product_sizes.stock + available are updated for the exact
--     (product_id, color_id, size_label) row. Non-negative integer enforced.
--   * REVOKE from PUBLIC; EXECUTE only for authenticated.
-- ============================================================================

-- 1) Drop any legacy signatures so the named-argument call resolves to exactly
--    one function. (Only drops function definitions, never data.)
DROP FUNCTION IF EXISTS public.set_product_size_stock(uuid, integer);
DROP FUNCTION IF EXISTS public.set_product_size_stock(uuid, uuid, text, integer);

-- 2) Create the canonical function with argument names matching the frontend.
CREATE OR REPLACE FUNCTION public.set_product_size_stock(
  p_product_id uuid,
  p_color_id uuid,
  p_size_label text,
  p_stock integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Require an authenticated user.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required.';
  END IF;

  -- Admin authorization gate (same mechanism as the other admin lock policies).
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only an authorized administrator can update stock.';
  END IF;

  -- Stock must be a non-negative integer; 0 means sold out.
  IF p_stock IS NULL OR p_stock < 0 THEN
    RAISE EXCEPTION 'Stock must be a non-negative integer.';
  END IF;

  -- Update ONLY the matching (product, color, size) variant's stock and its
  -- availability flag. No other columns are touched.
  UPDATE public.product_sizes
  SET stock = p_stock,
      available = p_stock > 0
  WHERE product_id = p_product_id
    AND color_id = p_color_id
    AND size_label = p_size_label;
END;
$$;

-- 3) Lock it down: not callable by the public; only authenticated users may
--    attempt it, and the in-function admin check is the authoritative gate.
REVOKE ALL ON FUNCTION public.set_product_size_stock(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_product_size_stock(uuid, uuid, text, integer) TO authenticated;

-- 4) Reload the PostgREST schema cache so the freshly defined function is
--    immediately resolvable by name (avoids the "schema cache" error the admin
--    UI currently hits). Safe: only emits NOTIFY, no DDL.
NOTIFY pgrst, 'reload schema';

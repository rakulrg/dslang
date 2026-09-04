-- ============================================================================
-- Migration: 20260907000000_dslang_upsert_product_size_stock.sql
-- Purpose:   Create / refresh the EXACT set_product_size_stock RPC that the
--            admin Inventory panel calls, with a real UPSERT (insert if the
--            product_id + color_id + size_label row does not exist, update if
--            it does), and reload the PostgREST schema cache.
--
-- FIXES RUNTIME ERROR:
--   "Could not find the function public.set_product_size_stock(
--    p_color_id, p_product_id, p_size_label, p_stock) in the schema cache."
--
-- Root cause: the 4-argument function either is absent in the live database,
-- or its PostgREST schema-cache entry is stale. Because the frontend calls the
-- RPC by NAMED arguments, PostgREST requires an EXACT match on parameter name,
-- order and type. The existing 20260817040000_color_wise_stock migration
-- already declared the correct signature (p_product_id uuid, p_color_id uuid,
-- p_size_label text, p_stock integer), but it is not live, so the schema cache
-- does not contain it. This migration (re)declares it idempotently and reloads
-- the cache so the call resolves.
--
-- Security model (consistent with the existing admin helpers):
--   * SECURITY DEFINER   -> can INSERT/UPDATE product_sizes even though RLS
--                           blocks direct table writes by non-owner roles.
--   * SET search_path = public -> prevents search_path hijack.
--   * Admin gate INSIDE the function via public.admin_users.
--   * REVOKE from PUBLIC; EXECUTE only for authenticated.
-- ============================================================================

-- 1) Drop any legacy signatures so the named-argument call resolves to exactly
--    one function. (Drops only function definitions, never data.)
DROP FUNCTION IF EXISTS public.set_product_size_stock(uuid, integer);
DROP FUNCTION IF EXISTS public.set_product_size_stock(uuid, uuid, text, integer);

-- 2) Create the canonical RPC with argument names/order/types that EXACTLY
--    match the frontend call in src/lib/admin.ts adminSetSizeStock().
--    PostgREST maps named JSON args to these exact identifiers.
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
  -- Authentication required.
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

  -- Upsert: update if the (product_id, color_id, size_label) row exists,
  -- otherwise insert a new variant row. Only stock + available are written.
  INSERT INTO public.product_sizes (product_id, color_id, size_label, stock, available)
  VALUES (p_product_id, p_color_id, p_size_label, p_stock, p_stock > 0)
  ON CONFLICT (product_id, color_id, size_label)
  DO UPDATE SET
    stock = EXCLUDED.stock,
    available = EXCLUDED.stock > 0;
END;
$$;

-- 3) Lock it down: PUBLIC cannot execute; only authenticated users may attempt
--    it, and the in-function admin check is the authoritative gate.
REVOKE ALL ON FUNCTION public.set_product_size_stock(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_product_size_stock(uuid, uuid, text, integer) TO authenticated;

-- 4) Reload the PostgREST schema cache so the freshly defined function is
--    immediately resolvable by name. Without this, PostgREST keeps reporting
--    "Could not find the function ... in the schema cache" even though the
--    function exists. Safe: emits NOTIFY only, no DDL.
NOTIFY pgrst, 'reload schema';

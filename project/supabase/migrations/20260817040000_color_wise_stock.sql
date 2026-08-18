-- ============================================================================
-- Migration: 20260817040000_color_wise_stock.sql
-- Purpose: Add color-wise stock tracking to product_sizes.
-- ============================================================================

-- 1. Add color_id.
ALTER TABLE public.product_sizes
  ADD COLUMN IF NOT EXISTS color_id uuid
  REFERENCES public.product_colors(id)
  ON DELETE CASCADE;

-- 2. Remove the old uniqueness constraint first.
ALTER TABLE public.product_sizes
  DROP CONSTRAINT IF EXISTS product_sizes_product_id_size_label_key;

-- 3. Create the new color-aware uniqueness constraint BEFORE backfilling.
ALTER TABLE public.product_sizes
  ADD CONSTRAINT product_sizes_product_id_color_id_size_label_key
  UNIQUE (product_id, color_id, size_label);

-- 4. Backfill existing size rows for every color belonging to the product.
DO $$
DECLARE
  r RECORD;
  c RECORD;
BEGIN
  FOR r IN
    SELECT
      ps.id,
      ps.product_id,
      ps.size_label,
      ps.stock,
      ps.available
    FROM public.product_sizes ps
    WHERE ps.color_id IS NULL
  LOOP

    FOR c IN
      SELECT pc.id AS color_id
      FROM public.product_colors pc
      WHERE pc.product_id = r.product_id
    LOOP

      INSERT INTO public.product_sizes (
        product_id,
        color_id,
        size_label,
        stock,
        available
      )
      VALUES (
        r.product_id,
        c.color_id,
        r.size_label,
        r.stock,
        r.available
      )
      ON CONFLICT (product_id, color_id, size_label)
      DO UPDATE SET
        stock = EXCLUDED.stock,
        available = EXCLUDED.available;

    END LOOP;

    DELETE FROM public.product_sizes
    WHERE id = r.id;

  END LOOP;
END $$;

-- 5. Make color_id mandatory.
ALTER TABLE public.product_sizes
  ALTER COLUMN color_id SET NOT NULL;

-- 6. Recreate color-aware index.
DROP INDEX IF EXISTS public.idx_sizes_product;

CREATE INDEX IF NOT EXISTS idx_sizes_product_color
  ON public.product_sizes(product_id, color_id);

-- 7. Replace stock update RPC.
DROP FUNCTION IF EXISTS public.set_product_size_stock(uuid, integer);

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

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only an authorized administrator can update stock.';
  END IF;

  IF p_stock IS NULL OR p_stock < 0 THEN
    RAISE EXCEPTION 'Stock must be a non-negative integer.';
  END IF;

  UPDATE public.product_sizes
  SET
    stock = p_stock,
    available = p_stock > 0
  WHERE product_id = p_product_id
    AND color_id = p_color_id
    AND size_label = p_size_label;

END;
$$;

REVOKE ALL
ON FUNCTION public.set_product_size_stock(uuid, uuid, text, integer)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.set_product_size_stock(uuid, uuid, text, integer)
TO authenticated;
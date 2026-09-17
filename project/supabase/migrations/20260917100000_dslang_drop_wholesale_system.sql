-- =============================================================================
-- DSLANG wholesale system removal (retail-only pivot complete).
--
-- Drops all wholesale/B2B-only database objects that are NOT used by the
-- retail/D2C storefront. Every statement uses IF EXISTS / IF NOT EXISTS
-- so it is safe on any database state.
--
-- WHAT IS REMOVED
--   * products: wholesale pricing columns (wholesale_price_50, wholesale_price_100)
--     and wholesale minimum order quantity (moq).
--   * site_settings: all wholesale-era columns (pack sizing, MOQ controls,
--     wholesale pricing, wholesale feature flag).
--   * public.orders: the legacy wholesale orders table, its RLS policies,
--     index, and the create_wholesale_order RPC.
--
-- WHAT IS PRESERVED
--   * All retail products, prices, colors, sizes, images.
--   * retail_orders, promo_codes, admin_users, subscribers, hero_slides.
--   * All retail RLS policies.
--   * Cashfree payment functions and order flow.
--   * Site settings retail columns (announcement, WhatsApp, shipping).
--   * Product spec columns used by retail (gsm, wash, details, fabric, fit, care).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Products: drop wholesale-only columns.
-- ----------------------------------------------------------------------------
ALTER TABLE public.products DROP COLUMN IF EXISTS wholesale_price_50;
ALTER TABLE public.products DROP COLUMN IF EXISTS wholesale_price_100;
ALTER TABLE public.products DROP COLUMN IF EXISTS moq;

-- ----------------------------------------------------------------------------
-- 2. Site settings: drop all wholesale-era columns.
--    Handle both naming variants (wholesale_price_50 and wholesale_price50)
--    since the live DB may have either.
-- ----------------------------------------------------------------------------
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS wholesale_price_50;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS wholesale_price_100;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS wholesale_price50;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS wholesale_price100;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS wholesale_pricing_enabled;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS default_moq;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS min_order_quantity;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS per_color_minimum;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS pack_size;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS pack_m;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS pack_l;
ALTER TABLE public.site_settings DROP COLUMN IF EXISTS pack_xl;

-- ----------------------------------------------------------------------------
-- 3. Wholesale orders table: drop if it still exists.
-- DROP POLICY cannot reference a missing table, so guard with a DO block.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    DROP POLICY IF EXISTS "orders_insert_public" ON public.orders;
    DROP POLICY IF EXISTS "orders_select_admin" ON public.orders;
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_orders_created_at;
DROP TABLE IF EXISTS public.orders;

-- ----------------------------------------------------------------------------
-- 4. Wholesale order creation RPC: drop if it still exists.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_wholesale_order(jsonb, jsonb);

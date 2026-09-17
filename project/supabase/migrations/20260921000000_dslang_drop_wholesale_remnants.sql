-- =============================================================================
-- DSLANG — Unified wholesale/B2B remnant removal (retail-only pivot complete).
--
-- Supersedes + folds in the intent of:
--   20260917000000_dslang_drop_legacy_orders_insert_policy.sql
--   20260917100000_dslang_drop_wholesale_system.sql
--   20260919000000_dslang_drop_hero_text_columns.sql
-- (those files are removed; this migration is the single source of truth for
-- every remaining wholesale object, doing the same drops in one pass.)
--
-- WHAT IS REMOVED
--   * products: wholesale_price_50, wholesale_price_100, moq
--   * site_settings: wholesale_pricing_enabled, default_moq,
--     min_order_quantity, per_color_minimum, pack_size, pack_m, pack_l,
--     pack_xl, wholesale_price50, wholesale_price100
--   * hero_slides: eyebrow, title, subtitle, cta_text, cta_url (hero is
--     images-only now — frontend + admin never read these)
--   * public.orders (legacy wholesale table, does not exist in prod),
--     its RLS policies, index, and the create_wholesale_order RPC — guarded
--     with IF EXISTS / DO-block so it is a safe no-op wherever absent.
--
-- WHAT IS PRESERVED
--   * promo_codes.min_order_value — this is the RETAIL promo basket threshold
--     (client + validate_promo_code enforcement), NOT wholesale. Untouched.
--   * All retail products, prices, colors, sizes, images, retail_orders,
--     promo_codes, admin_users, subscribers, hero_slides rows + images.
--   * All retail RLS policies and the retail order/payment/restock flow.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Products: wholesale-only pricing + MOQ columns.
-- ----------------------------------------------------------------------------
ALTER TABLE public.products DROP COLUMN IF EXISTS wholesale_price_50;
ALTER TABLE public.products DROP COLUMN IF EXISTS wholesale_price_100;
ALTER TABLE public.products DROP COLUMN IF EXISTS moq;

-- ----------------------------------------------------------------------------
-- 2. Site settings: wholesale-era columns (both naming variants covered).
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
-- 3. Hero slides: obsolete text / CTA columns. Hero is images-only.
--    Frontend (src/lib/catalog.ts) + admin (src/lib/admin.ts) both select
--    only id, image_url, sort_order, active, created_at.
-- ----------------------------------------------------------------------------
ALTER TABLE public.hero_slides DROP COLUMN IF EXISTS eyebrow;
ALTER TABLE public.hero_slides DROP COLUMN IF EXISTS title;
ALTER TABLE public.hero_slides DROP COLUMN IF EXISTS subtitle;
ALTER TABLE public.hero_slides DROP COLUMN IF EXISTS cta_text;
ALTER TABLE public.hero_slides DROP COLUMN IF EXISTS cta_url;

-- ----------------------------------------------------------------------------
-- 4. Legacy wholesale orders remnant (no-op in prod: table does not exist).
--    Folds in the intent of 20260917000000 (orders_insert_public) and
--    20260917100000 (orders table + policies + index + RPC).
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
DROP FUNCTION IF EXISTS public.create_wholesale_order(jsonb, jsonb);
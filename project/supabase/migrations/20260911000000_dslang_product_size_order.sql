-- ============================================================================
-- Migration: 20260911000000_dslang_product_size_order.sql
-- Purpose:   Let admins define a per-product size display order.
--
--   Adds product_sizes.sort_order. The admin Size manager reorders sizes and
--   writes the same rank to every variant row (product_id + size_label across
--   all colours) plus size_chart_rows.sort_order, so the size chart follows the
--   same order. The storefront and admin sort sizes by this column when any
--   positive value exists and fall back to the shared garment/numeric sort
--   when all rows are 0 (which keeps every existing product's order intact).
--
--   The set_product_size_stock upsert RPC inserts new variant rows without a
--   sort_order (default 0), so freshly added sizes automatically appear after
--   the ranked ones until the admin reorders them.
--
--   Additive and safe: no tables dropped, no stock/product data touched. The
--   existing RLS policies on product_sizes (public SELECT, admin INSERT/UPDATE/
--   DELETE via admin_users) cover the new column with no changes.
-- ============================================================================

ALTER TABLE public.product_sizes
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
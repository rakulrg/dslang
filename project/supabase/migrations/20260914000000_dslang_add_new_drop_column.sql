-- ============================================================================
-- Migration: 20260914000000_dslang_add_new_drop_column.sql
-- Purpose:   Add the missing new_drop column to the products table.
--
--   The storefront catalog query (catalog.ts) always requests new_drop when
--   the published column exists. If new_drop is absent PostgREST returns a
--   42703 error and the entire product listing fails ("Couldn't load
--   products").
--
--   This column was declared in several earlier migrations (20260827010000,
--   20260827030000, 20260828000000, 20260904000000) using IF NOT EXISTS, but
--   the live database is missing it — likely because those migrations were
--   never applied or were rolled back. This is a standalone, idempotent fix.
--
--   Additive and safe: existing rows receive false (the semantic default —
--   product is not a "new drop"), no data is modified, and IF NOT EXISTS
--   ensures re-running is harmless.
-- ============================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS new_drop boolean NOT NULL DEFAULT false;

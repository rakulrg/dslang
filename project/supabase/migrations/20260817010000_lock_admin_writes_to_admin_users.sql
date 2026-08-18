-- ============================================================================
-- Migration: 20260817010000_lock_admin_writes_to_admin_users.sql
-- Purpose:   Close the security gap where ANY authenticated user could
--            INSERT/UPDATE/DELETE products, sizes, size charts, hero slides,
--            and drop announcements. These tables still had the original
--            "any authenticated user" policies from the schema v1 migration.
--            This migration replaces them with the same admin_users
--            membership check already used by the storage and color locks.
--
-- Security model:
--   * Public SELECT remains open (catalog is public).
--   * INSERT/UPDATE/DELETE require a row in admin_users for the caller.
--   * RLS is NOT disabled. Only write policies are replaced.
--   * No policies on admin_users are created, modified, or dropped here.
-- ============================================================================

-- ==================== products ====================
DROP POLICY IF EXISTS "admin_insert_products" ON public.products;
DROP POLICY IF EXISTS "admin_update_products" ON public.products;
DROP POLICY IF EXISTS "admin_delete_products" ON public.products;

CREATE POLICY "admin_insert_products"
  ON public.products FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_update_products"
  ON public.products FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_delete_products"
  ON public.products FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

-- ==================== product_sizes ====================
DROP POLICY IF EXISTS "admin_insert_sizes" ON public.product_sizes;
DROP POLICY IF EXISTS "admin_update_sizes" ON public.product_sizes;
DROP POLICY IF EXISTS "admin_delete_sizes" ON public.product_sizes;

CREATE POLICY "admin_insert_sizes"
  ON public.product_sizes FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_update_sizes"
  ON public.product_sizes FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_delete_sizes"
  ON public.product_sizes FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

-- ==================== size_chart_rows ====================
DROP POLICY IF EXISTS "admin_insert_sizechart" ON public.size_chart_rows;
DROP POLICY IF EXISTS "admin_update_sizechart" ON public.size_chart_rows;
DROP POLICY IF EXISTS "admin_delete_sizechart" ON public.size_chart_rows;

CREATE POLICY "admin_insert_sizechart"
  ON public.size_chart_rows FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_update_sizechart"
  ON public.size_chart_rows FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_delete_sizechart"
  ON public.size_chart_rows FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

-- ==================== hero_slides ====================
DROP POLICY IF EXISTS "admin_insert_hero" ON public.hero_slides;
DROP POLICY IF EXISTS "admin_update_hero" ON public.hero_slides;
DROP POLICY IF EXISTS "admin_delete_hero" ON public.hero_slides;

CREATE POLICY "admin_insert_hero"
  ON public.hero_slides FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_update_hero"
  ON public.hero_slides FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_delete_hero"
  ON public.hero_slides FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

-- ==================== drop_announcements ====================
DROP POLICY IF EXISTS "admin_insert_announcements" ON public.drop_announcements;
DROP POLICY IF EXISTS "admin_update_announcements" ON public.drop_announcements;
DROP POLICY IF EXISTS "admin_delete_announcements" ON public.drop_announcements;

CREATE POLICY "admin_insert_announcements"
  ON public.drop_announcements FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_update_announcements"
  ON public.drop_announcements FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));

CREATE POLICY "admin_delete_announcements"
  ON public.drop_announcements FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()));
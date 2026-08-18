-- ============================================================================
-- Migration: 20260817030000_lock_product_images_storage_rls.sql
-- Purpose:   Apply the minimum Storage RLS fix for the existing
--            `product-images` bucket.
--
-- Current state (after 20260816010000):
--   * Bucket is PUBLIC (public = true) — keep it public for read access.
--   * INSERT/UPDATE/DELETE are already admin-gated.
--   * SELECT is open to anon, authenticated — keep it that way.
--
-- This migration:
--   1. Ensures the bucket remains PUBLIC (public = true) for read access.
--   2. Re-asserts the public SELECT policy (anon + authenticated can read).
--   3. Re-asserts the admin-only INSERT/UPDATE/DELETE policies idempotently
--      so the end state is guaranteed regardless of prior migration state.
--
-- Security model:
--   * RLS is NOT disabled on storage.objects.
--   * No policies on admin_users are created, modified, or dropped.
--   * No new bucket is created.
--   * No service-role credentials are used.
--   * Admin authorization uses the existing pattern:
--       EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Ensure the existing `product-images` bucket remains PUBLIC for read.
--    (Requirement: keep the bucket named `product-images`; keep it public
--    for read access so the storefront can serve images to anonymous
--    customers.)
-- ----------------------------------------------------------------------------
UPDATE storage.buckets
SET public = true
WHERE id = 'product-images';

-- ----------------------------------------------------------------------------
-- 2. Drop the existing storage.objects policies for this bucket so we can
--    recreate them with the correct semantics.
--    DROP IF EXISTS makes this idempotent.
--    NOTE: admin_users policies are intentionally NOT touched here.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "public_read_product_images" ON storage.objects;
DROP POLICY IF EXISTS "auth_upload_product_images" ON storage.objects;
DROP POLICY IF EXISTS "auth_update_product_images" ON storage.objects;
DROP POLICY IF EXISTS "auth_delete_product_images" ON storage.objects;
DROP POLICY IF EXISTS "admin_upload_product_images" ON storage.objects;
DROP POLICY IF EXISTS "admin_update_product_images" ON storage.objects;
DROP POLICY IF EXISTS "admin_delete_product_images" ON storage.objects;
DROP POLICY IF EXISTS "admin_read_product_images" ON storage.objects;

-- ----------------------------------------------------------------------------
-- 3. SELECT — anon and authenticated users may read product images.
--    (Requirement: anon/authenticated users: SELECT/read product images)
-- ----------------------------------------------------------------------------
CREATE POLICY "public_read_product_images"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'product-images');

-- ----------------------------------------------------------------------------
-- 4. INSERT — only authenticated admins may upload.
--    (Requirement: only authenticated users who exist in public.admin_users
--    with user_id = auth.uid(): INSERT)
-- ----------------------------------------------------------------------------
CREATE POLICY "admin_upload_product_images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'product-images'
    AND EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- 5. UPDATE — only authenticated admins may update objects in this bucket.
-- ----------------------------------------------------------------------------
CREATE POLICY "admin_update_product_images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  )
  WITH CHECK (
    bucket_id = 'product-images'
    AND EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- 6. DELETE — only authenticated admins may delete objects in this bucket.
-- ----------------------------------------------------------------------------
CREATE POLICY "admin_delete_product_images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  );

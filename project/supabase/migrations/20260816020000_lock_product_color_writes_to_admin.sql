-- The storefront can read colors publicly. Product color changes must use the
-- same admin_users membership check as the existing application auth state.
DROP POLICY IF EXISTS "admin_insert_colors" ON public.product_colors;
DROP POLICY IF EXISTS "admin_update_colors" ON public.product_colors;
DROP POLICY IF EXISTS "admin_delete_colors" ON public.product_colors;

CREATE POLICY "admin_insert_colors"
  ON public.product_colors FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  );

CREATE POLICY "admin_update_colors"
  ON public.product_colors FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  );

CREATE POLICY "admin_delete_colors"
  ON public.product_colors FOR DELETE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
  );

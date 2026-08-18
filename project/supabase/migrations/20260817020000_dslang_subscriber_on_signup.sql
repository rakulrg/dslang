-- ============================================================================
-- Migration: 20260817020000_dslang_subscriber_on_signup.sql
-- Purpose:   Ensure every non-admin user has a subscribers row so the
--            SubscriberDashboard can manage notification preferences.
--            Previously, only the first user (admin) was handled by the
--            trigger; non-admin users had no subscriber row.
--
-- Security model:
--   * SECURITY DEFINER trigger function (same as existing handle_new_user).
--   * Fixed safe search_path = public.
--   * Only inserts into subscribers; never modifies admin_users logic.
--   * RLS is not disabled or weakened.
-- ============================================================================

-- Replace the trigger function to also create a subscriber row for
-- non-admin users.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If no admin exists yet, make this user the admin (unchanged behavior).
  IF NOT EXISTS (SELECT 1 FROM admin_users) THEN
    INSERT INTO admin_users (user_id) VALUES (NEW.id);
  ELSE
    -- Otherwise, create a subscriber row for the new user.
    INSERT INTO subscribers (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill subscriber rows for existing non-admin users who signed up
-- before this migration.
INSERT INTO subscribers (id, email)
SELECT u.id, u.email
FROM auth.users u
WHERE u.id NOT IN (SELECT id FROM subscribers)
  AND u.id NOT IN (SELECT user_id FROM admin_users)
ON CONFLICT (id) DO NOTHING;
-- =============================================================================
-- dslang_admin_users_client_write_lockdown
-- =============================================================================
-- Closes the self-promotion privilege escalation in public.admin_users.
--
-- THE VULNERABILITY
--   public.admin_users is the single authorization source for the whole admin
--   surface: `retail_orders_update_admin`, `retail_orders_guard_customer_writes`,
--   the product/storage RLS policies, and ~24 SECURITY DEFINER RPCs all gate on
--   `exists (select 1 from public.admin_users where user_id = auth.uid())`.
--   The table has only two columns (user_id, created_at) and no role column, so
--   the PRESENCE of a row is the entire definition of "admin".
--
--   Production carried the policies created in 20260813062206:
--     insert_own_admin  INSERT  TO authenticated WITH CHECK (auth.uid() = user_id)
--     delete_own_admin  DELETE  TO authenticated USING     (auth.uid() = user_id)
--     read_own_admin    SELECT  TO authenticated USING     (auth.uid() = user_id)
--   together with the Supabase default table-level ALL grant to anon and
--   authenticated. So any signed-in customer could:
--     POST /rest/v1/admin_users  {"user_id": "<own uid>"}
--   and immediately satisfy every admin check in the application. That is a
--   complete compromise of the admin surface, including the ability to rewrite
--   financial columns on any order.
--
-- WHY THIS IS STILL HAPPENING DESPITE AN EXISTING "FIX"
--   20260816010000_lock_product_image_storage_to_admin.sql does contain
--     DROP POLICY IF EXISTS "insert_own_admin"  ON public.admin_users;
--     DROP POLICY IF EXISTS "delete_own_admin"  ON public.admin_users;
--   and that migration IS recorded as applied in supabase_migrations. But the
--   production catalog still holds both policies, and is still missing the
--   `admin_delete_product_images` policy that the same file creates. The file
--   was edited after it had already been applied to the database (committed
--   2026-08-19, three days after its 2026-08-16 apply date). The migration
--   ledger records only version + name, never file content, so a post-apply
--   edit is invisible: the statements were never executed.
--
--   scripts/rpc-privileges.test.mjs asserts the drops are present in the FILE,
--   which is why the suite stayed green while production stayed vulnerable.
--   This migration therefore repeats the intent idempotently, and the new
--   scripts/admin-users-privileges.test.mjs asserts the resulting BEHAVIOUR
--   against a real database instead of against migration text.
--
-- WHAT IS DELIBERATELY PRESERVED
--   * read_own_admin + the authenticated SELECT grant. The client-side admin
--     check depends on it and is the only way the UI knows who an admin is:
--       src/lib/auth.tsx:195-203   checkIsAdmin()  -> .from('admin_users').select(...)
--       src/lib/admin.ts:226-237  requireAdminImageAccess() -> same read
--     Revoking SELECT would not improve server-side security at all (the RPCs
--     and policies check admin_users as the definer/owner), it would only break
--     the Admin UI's ability to render. anon does NOT need it (no anon policy
--     ever existed) so it loses SELECT too.
--   * handle_new_user + the on_auth_user_created trigger. It is SECURITY
--     DEFINER, owned by postgres, and `admin_users` is NOT FORCE ROW LEVEL
--     SECURITY, so it inserts with RLS switched off and is unaffected by a
--     revoke against anon/authenticated. The trigger's INSERT is additionally
--     written as `postgres`, which keeps its own privilege.
--   * Every admin that exists today. This migration adds no INSERT and deletes
--     no rows; it only removes client-writable privileges.
--   * service_role and postgres are not named in any REVOKE, so automation and
--     the migration runner keep full access.
--
-- There is no admin-management UI, no admin-management RPC, and no edge
-- function that writes admin_users, so nothing legitimate loses access. Adding
-- a new admin remains an operator action (a direct INSERT as postgres /
-- service_role), which is the correct model.
-- =============================================================================

-- 1. Remove the two self-service policies, so client-side self-management of
--    admin membership is no longer expressible at all. `read_own_admin` is kept:
--    it is read-only and is what the Admin UI needs to render.
--    USING IF EXISTS keeps this re-runnable.
drop policy if exists "insert_own_admin" on public.admin_users;
drop policy if exists "delete_own_admin" on public.admin_users;

-- 2. Revoke the table-level privileges that made the policies reachable.
--
--    Both statements are split because the two roles do not lose the same set.
--    anon loses EVERY privilege including SELECT: no policy grants anon access
--    to this table, so its default ALL grant is pure latent risk. Leaving a
--    privilege in place that no policy can ever use is exactly the condition
--    that turns one future policy mistake into a disclosure.
--
--    INSERT / UPDATE / DELETE are the escalation itself. The remaining are
--    inert today only because no policy grants them, and they are revoked as
--    well so a future policy cannot silently re-open the table:
--      TRUNCATE  - no TRUNCATE policy exists, but the grant alone is a footgun.
--      REFERENCES- nothing references admin_users; no FK is built against it.
--      TRIGGER   - would allow attaching a trigger to this table.
--    None of these are used by any function, migration, or UI in the repo.
revoke insert, update, delete, truncate, references, trigger
  on table public.admin_users from anon, authenticated;
revoke select
  on table public.admin_users from anon;

-- 3. Restate the minimum grant each role actually needs, so a later
--    `alter default privileges` change cannot widen this again.
--      authenticated - SELECT only, and only because read_own_admin exists and
--        the Admin UI reads its own row to decide what to render:
--          src/lib/auth.tsx:195-203   checkIsAdmin()  -> .from('admin_users').select(...)
--          src/lib/admin.ts:226-237  requireAdminImageAccess() -> same read
--        read_own_admin exposes a single column (user_id) plus created_at, and
--        only the caller's own row, so this grant is not a directory leak.
--        Revoking it would not improve server-side security at all -- the RPCs
--        and policies read admin_users as the definer/owner -- it would only
--        break the Admin UI.
--      anon          - nothing (revoked above).
--      service_role  - INSERT (and its existing UPDATE/DELETE) for operators and
--        automation. Not revoked.
--    Note handle_new_user needs NONE of these: it is SECURITY DEFINER owned by
--    postgres, so it writes with postgres's own privilege and RLS switched off.
grant select on table public.admin_users to authenticated;
grant insert on table public.admin_users to service_role;

-- 4. handle_new_user is a trigger function, so it can never be invoked by a
--    client (PostgreSQL rejects calling a `returns trigger` function directly).
--    Supabase nevertheless left a PUBLIC execute grant on it, which hands every
--    role the right to try. Trigger execution does not consult EXECUTE at fire
--    time -- it was authorised once, when the trigger was created on
--    auth.users -- so removing this grant cannot stop the signup trigger.
revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon, authenticated, service_role;
grant execute on function public.handle_new_user() to postgres;

comment on table public.admin_users is
  'Admin membership. Presence of a row = full admin. Written only by the '
  'handle_new_user bootstrap trigger or by an operator acting as postgres/'
  'service_role. authenticated keeps SELECT on its own row for the UI admin '
  'check; anon holds nothing; no client role can write.';

-- Reload PostgREST so the endpoint's privilege cache matches immediately.
notify pgrst, 'reload schema';

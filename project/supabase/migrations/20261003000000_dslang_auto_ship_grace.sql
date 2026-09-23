-- =============================================================================
-- Migration: 20261003000000_dslang_auto_ship_grace.sql
--
-- Automatic Cashfree-triggered Shiprocket fulfilment with a cancel-before-ship
-- grace window.
--
-- DESIGN (single source of truth = the timestamp column, not a client clock):
--   * When the cashfree-webhook confirms a payment it stamps
--       auto_ship_at = now() + SHIP_AUTO_GRACE_MINUTES (default 45)
--     on the order INSTEAD of shipping inline. The order keeps its manual
--     check window: the admin can cancel (order_status -> 'cancelled') or edit
--     the delivery address before the sweep claims it.
--   * The scheduled `auto-ship-orders` sweep only claims orders whose
--     auto_ship_at is already in the past and that are STILL shippable when it
--     runs (paid, state in pending/cod_partial_paid/processing, no existing
--     Shiprocket id). Orders that were already cancelled (or failed an earlier
--     auto-ship attempt -> ship_attempt_error set) are left for manual action.
--   * By anchoring the grace on a stored timestamp written by the webhook we
--     get idempotency for free: a replayed webhook only flips + re-stamps when
--     the CAS (payment_status pending->success) actually wins, and a second
--     sweep pick-up of an already-claimed order is impossible (the shared
--     processEligibleShipment 'creating' claim + shipped-id guard).
--
-- WHAT:
--   * retail_orders.auto_ship_at timestamptz (nullable) — when the automatic
--     Shiprocket shipment is due. NULL for non-Cashfree / legacy orders (they
--     stay fully manual via the Admin 'Ship Order' button).
--   * Partial index for the sweep: due (auto_ship_at not null) rows that do not
--     yet hold a Shiprocket order id.
--   * ship_source comment updated to document the new 'cashfree' value.
--
-- Idempotent + additive. Safe on any current retail DB.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) auto_ship_at — the grace-timer column.
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists auto_ship_at timestamptz;

comment on column public.retail_orders.auto_ship_at is
  'When the automatic Shiprocket shipment becomes due (set by the cashfree '
  'webhook to paid_at + grace minutes, default 45). NULL = no auto-ship was '
  'armed (legacy / fastrr / manual-only order). The auto-ship-orders sweep '
  'claims rows with auto_ship_at <= now() that are still shippable. Cleared by '
  'the sweep once the shipment is created; a cancelled (order_status collated) '
  'or previously-failed (ship_attempt_error set) order is never auto-shipped.';

-- The sweep reads exactly this predicate, so index exactly that shape.
create index if not exists idx_retail_orders_auto_ship_due
  on public.retail_orders (auto_ship_at)
  where auto_ship_at is not null and shiprocket_order_id is null;

-- -----------------------------------------------------------------------------
-- 2) ship_source now also carries the 'cashfree' automatic trigger.
-- -----------------------------------------------------------------------------
comment on column public.retail_orders.ship_source is
  'Who created the shipment: ''fastrr'' (automatic fastrr webhook), ''cashfree'' '
  '(automatic, via the auto-ship-orders sweep after the Cashfree grace window) '
  'or ''admin'' (manual Ship Order / RETRY). NULL = legacy/manual before these '
  'fields existed.';

notify pgrst, 'reload schema';

-- ===========================================================================
-- SCHEDULING (enable manually, AFTER deploying the auto-ship-orders fn):
--
-- The service_role key is stored in Supabase Vault (never hardcoded into the
-- cron command). The job reads it at run time and sends
-- 'Authorization: Bearer <service_role>' to the edge function — the same value
-- the function already uses from its own server-side env.
--
-- 1. Enable Vault (or via Dashboard -> Database -> Extensions):
--      create extension if not exists supabase_vault;
--      select vault.create_secret('<SERVICE_ROLE_KEY>', 'auto_ship_orders_key');
--
-- 2. Enable pg_cron + pg_net (or via Dashboard -> Database -> Extensions):
--      create extension if not exists pg_cron;
--      create extension if not exists pg_net;
--
-- 3. Register the schedule (run once in the SQL editor). Every 5 minutes is
--    plenty — the grace window means a row normally becomes due 45 minutes
--    after payment and is shipped on the next tick after that:
--
--    select cron.schedule(
--      'auto-ship-orders',
--      '*/5 * * * *',                              -- every 5 minutes
--      $$
--      select net.http_post(
--        url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/auto-ship-orders',
--        headers := jsonb_build_object(
--          'Content-Type', 'application/json',
--          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'auto_ship_orders_key')
--        ),
--        body    := '{"limit": 20}'
--      );
--      $$
--    );
--
--    (Alternative: set a dedicated SWEEP_TRIGGER_TOKEN in the function's
--     secrets and store THAT in Vault instead of the service role key.)
--
-- 4. Verify the job + runs:
--      select * from cron.job where jobname = 'auto-ship-orders';
--      select * from cron.job_run_details order by start_time desc limit 5;
--
-- To remove:
--      select cron.unschedule('auto-ship-orders');
--      select vault.delete_secret(secret_id) from vault.decrypted_secrets where name = 'auto_ship_orders_key';
--
-- LOCAL/VERIFICATION NOTE (localhost, NO deploy): you can run the sweep with
-- `supabase functions serve` and POST directly, e.g.
--   curl -X POST -H "Authorization: Bearer <SERVICE_ROLE>" \
--        -H "Content-Type: application/json" \
--        -d '{"dryRun": true}' \
--        <LOCAL_FN_URL>/auto-ship-orders
-- See supabase/functions/auto-ship-orders/index.ts for all invocation modes.
-- ===========================================================================
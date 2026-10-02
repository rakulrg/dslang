-- =============================================================================
-- Migration: 20261010000000_dslang_install_sweep_schedules.sql
--
-- Installs REAL scheduled execution for the two maintenance sweeps whose
-- `cron.schedule(...)` calls only ever existed as comments:
--
--   * 20260923000000_dslang_expire_stale_retail_orders.sql  -> expire-stale-orders
--   * 20261003000000_dslang_auto_ship_grace.sql              -> auto-ship-orders
--
-- WHAT CHANGED vs the commented instructions: nothing about the business rules.
-- Both sweeps, their candidate predicates, the stale-order timeout window
-- (minutes: 30), the Cashfree decision table, the `expire_stale_retail_order`
-- CAS flip and the `restock_retail_order_items` idempotency guard are all
-- untouched. This file only makes the pg_cron entries real and re-runnable.
--
-- DESIGN (fail-closed, idempotent, no secrets in this file):
--   * The job command never contains a credential. It reads the service-role /
--     trigger token from Supabase Vault AT RUN TIME, exactly like the commented
--     instructions did, so nothing secret is committed or echoed anywhere.
--   * The jobs are installed by `dslang_schedule_sweeps()`, which is
--     re-runnable: it always unschedules first, then re-adds, so running it
--     twice can never create duplicates.
--   * If the Vault secret is absent the job is SKIPPED and reported, not
--     installed broken. If the project base URL has not been set the whole
--     function reports `functions_base_url_not_configured` and schedules
--     NOTHING. Applying this migration on a project that is not ready yet is
--     therefore a no-op, never a silently-failing cron job.
--
-- OPERATOR SETUP (once, per project — nothing secret is written by this file):
--   1. Ensure the extensions exist (this migration tries; the Supabase SQL
--      editor can also enable them under Database -> Extensions):
--        pg_cron, pg_net, supabase_vault
--   2. Store the trigger credential in Vault, under the secret names below.
--      Either the SUPABASE_SERVICE_ROLE_KEY, or a dedicated SWEEP_TRIGGER_TOKEN
--      that is also set on both functions:
--        select vault.create_secret('<SERVICE_ROLE_KEY>', 'expire_stale_orders_key');
--        select vault.create_secret('<SERVICE_ROLE_KEY>', 'auto_ship_orders_key');
--   3. Set this project's functions base URL and install:
--        update public.dslang_sweep_settings
--           set functions_base_url = 'https://<PROJECT_REF>.supabase.co'
--         where id = 1;
--        select public.dslang_schedule_sweeps();
--   4. Verify:
--        select jobname, schedule, active from cron.job
--         where jobname in ('expire-stale-orders','auto-ship-orders');
--        select public.dslang_sweep_status();
--
-- SAFETY OF auto-ship WHILE DELHIVERY IS UNAVAILABLE: the auto-ship-orders sweep
-- is safe to schedule at any time. Shipment creation goes through
-- processEligibleShipment -> loadDelhiveryConfig, which resolves to staging
-- unless DELHIVERY_ENV=production AND DELHIVERY_API_TOKEN is set. When the
-- provider is not production-ready the core returns a failure, the sweep records
-- `ship_attempt_error` on the order and stops re-attempting it. No fake AWB is
-- ever written and no order is marked shipped without a confirmed provider
-- response. A misconfigured Delhivery can therefore only ever cost an operator a
-- manual retry — it can never ship a parcel to the wrong environment.
--
-- Additive only: a new table, two new functions, no change to any existing
-- table, column, RPC, policy or order.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Extensions. Each is attempted independently and never aborts the
--    migration: a project without pg_cron simply gets `not_installed` reported
--    by dslang_schedule_sweeps() instead of a failed deploy.
-- -----------------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'dslang: pg_cron not enabled here (%) — enable it in Dashboard -> Database -> Extensions', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'dslang: pg_net not enabled here (%) — enable it in Dashboard -> Database -> Extensions', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists supabase_vault;
exception when others then
  raise notice 'dslang: supabase_vault not enabled here (%) — enable it in Dashboard -> Database -> Extensions', sqlerrm;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1) Scheduling config. Holds NO secrets — only the project functions URL, the
--    NAMES of the Vault secrets, and the cron schedule / request body. RLS is
--    enabled with no policies, so anon/authenticated can never read or write it;
--    only service_role (which bypasses RLS) and the function owner can.
-- -----------------------------------------------------------------------------
create table if not exists public.dslang_sweep_settings (
  id                  int     primary key default 1 check (id = 1),
  functions_base_url  text    not null default '',
  expire_secret_name  text    not null default 'expire_stale_orders_key',
  ship_secret_name    text    not null default 'auto_ship_orders_key',
  expire_schedule     text    not null default '*/15 * * * *',
  expire_body         jsonb   not null default '{"minutes": 30, "limit": 20}'::jsonb,
  ship_schedule       text    not null default '*/5 * * * *',
  ship_body           jsonb   not null default '{"limit": 20}'::jsonb,
  updated_at          timestamptz not null default now()
);

comment on table public.dslang_sweep_settings is
  'pg_cron configuration for the expire-stale-orders and auto-ship-orders sweeps. '
  'Contains no credentials: the trigger token is read from Supabase Vault at job run time.';

insert into public.dslang_sweep_settings (id) values (1) on conflict (id) do nothing;

alter table public.dslang_sweep_settings enable row level security;

-- -----------------------------------------------------------------------------
-- 2) dslang_unschedule_sweeps() — remove both jobs if present. Never raises,
--    so it is safe to call when the jobs (or pg_cron) do not exist.
-- -----------------------------------------------------------------------------
create or replace function public.dslang_unschedule_sweeps()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_removed text[] := array[]::text[];
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return jsonb_build_object('ok', true, 'reason', 'pg_cron_not_installed', 'removed', v_removed);
  end if;

  -- unschedule() on a missing jobname is a no-op, but guard anyway so a
  -- partial failure cannot abort the whole installer.
  begin
    perform cron.unschedule('expire-stale-orders');
    v_removed := v_removed || 'expire-stale-orders';
  exception when others then
    null;
  end;
  begin
    perform cron.unschedule('auto-ship-orders');
    v_removed := v_removed || 'auto-ship-orders';
  exception when others then
    null;
  end;

  return jsonb_build_object('ok', true, 'removed', to_jsonb(v_removed));
end;
$$;

revoke all on function public.dslang_unschedule_sweeps() from public;
grant execute on function public.dslang_unschedule_sweeps() to service_role;

comment on function public.dslang_unschedule_sweeps() is
  'Remove the expire-stale-orders and auto-ship-orders cron jobs. Idempotent, never raises.';

-- -----------------------------------------------------------------------------
-- 3) dslang_schedule_sweeps() — install (or reinstall) both jobs.
--
--    Idempotent by construction: unschedules first, then adds. A second run
--    replaces rather than duplicates. The command text embeds NO credential —
--    the bearer value is resolved from vault.decrypted_secrets when the job
--    fires, which is the model the original commented instructions described.
-- -----------------------------------------------------------------------------
create or replace function public.dslang_schedule_sweeps()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_cfg        public.dslang_sweep_settings%rowtype;
  v_base       text;
  v_report     jsonb := '{}'::jsonb;
  v_has_expire boolean;
  v_has_ship   boolean;
  v_template   text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return jsonb_build_object('ok', false, 'reason', 'pg_cron_not_installed');
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return jsonb_build_object('ok', false, 'reason', 'pg_net_not_installed');
  end if;
  if not exists (select 1 from pg_schema where schema_name = 'vault') then
    return jsonb_build_object('ok', false, 'reason', 'vault_not_installed');
  end if;

  select * into v_cfg from public.dslang_sweep_settings where id = 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'settings_row_missing');
  end if;

  v_base := btrim(coalesce(v_cfg.functions_base_url, ''));
  if v_base = '' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'functions_base_url_not_configured',
      'hint', 'update public.dslang_sweep_settings set functions_base_url = ''https://<PROJECT_REF>.supabase.co'' where id = 1; then select public.dslang_schedule_sweeps();'
    );
  end if;
  v_base := rtrim(v_base, '/');

  -- Presence only. The value is never selected into this session, never logged
  -- and never written into cron.job.
  v_has_expire := exists (
    select 1 from vault.decrypted_secrets where name = btrim(coalesce(v_cfg.expire_secret_name, 'expire_stale_orders_key'))
  );
  v_has_ship := exists (
    select 1 from vault.decrypted_secrets where name = btrim(coalesce(v_cfg.ship_secret_name, 'auto_ship_orders_key'))
  );

  perform public.dslang_unschedule_sweeps();

  -- The single command template both jobs use. %1 = function URL,
  -- %2 = vault secret name, %3 = JSON request body.
  v_template :=
    'select net.http_post(' ||
    '  url := %L,' ||
    '  headers := jsonb_build_object(' ||
    '    ''Content-Type'', ''application/json'',' ||
    '    ''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = %L)' ||
    '  ),' ||
    '  body := %L::jsonb' ||
    ')';

  if v_has_expire then
    perform cron.schedule(
      'expire-stale-orders',
      v_cfg.expire_schedule,
      format(v_template,
        v_base || '/functions/v1/expire-stale-orders',
        btrim(coalesce(v_cfg.expire_secret_name, 'expire_stale_orders_key')),
        v_cfg.expire_body::text)
    );
    v_report := v_report || jsonb_build_object('expire-stale-orders', 'scheduled');
  else
    v_report := v_report || jsonb_build_object('expire-stale-orders', 'skipped_missing_vault_secret');
  end if;

  if v_has_ship then
    perform cron.schedule(
      'auto-ship-orders',
      v_cfg.ship_schedule,
      format(v_template,
        v_base || '/functions/v1/auto-ship-orders',
        btrim(coalesce(v_cfg.ship_secret_name, 'auto_ship_orders_key')),
        v_cfg.ship_body::text)
    );
    v_report := v_report || jsonb_build_object('auto-ship-orders', 'scheduled');
  else
    v_report := v_report || jsonb_build_object('auto-ship-orders', 'skipped_missing_vault_secret');
  end if;

  return jsonb_build_object(
    'ok', true,
    'functions_base_url', v_base,
    'jobs', v_report
  );
end;
$$;

revoke all on function public.dslang_schedule_sweeps() from public;
grant execute on function public.dslang_schedule_sweeps() to service_role;

comment on function public.dslang_schedule_sweeps() is
  'Install (or reinstall) the expire-stale-orders and auto-ship-orders pg_cron jobs. '
  'Reads the trigger credential from Supabase Vault at job run time — never stores it. '
  'Idempotent: unschedules before re-adding, so repeated runs cannot duplicate jobs. '
  'Skips (and reports) any job whose Vault secret is missing rather than installing a broken job.';

-- -----------------------------------------------------------------------------
-- 4) dslang_sweep_status() — read-only view of what is actually installed.
-- -----------------------------------------------------------------------------
create or replace function public.dslang_sweep_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_cfg public.dslang_sweep_settings%rowtype;
  v_jobs jsonb;
begin
  select * into v_cfg from public.dslang_sweep_settings where id = 1;

  v_jobs := coalesce((
    select jsonb_agg(jsonb_build_object(
      'jobname', j.jobname,
      'schedule', j.schedule,
      'active', j.active
    ) order by j.jobname)
    from cron.job j
    where j.jobname in ('expire-stale-orders', 'auto-ship-orders')
  ), '[]'::jsonb);

  return jsonb_build_object(
    'pg_cron', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'pg_net', exists (select 1 from pg_extension where extname = 'pg_net'),
    'vault', exists (select 1 from pg_schema where schema_name = 'vault'),
    'functions_base_url', coalesce(v_cfg.functions_base_url, ''),
    'expire_secret_present', exists (
      select 1 from vault.decrypted_secrets where name = coalesce(v_cfg.expire_secret_name, 'expire_stale_orders_key')
    ),
    'ship_secret_present', exists (
      select 1 from vault.decrypted_secrets where name = coalesce(v_cfg.ship_secret_name, 'auto_ship_orders_key')
    ),
    'jobs', v_jobs
  );
end;
$$;

revoke all on function public.dslang_sweep_status() from public;
grant execute on function public.dslang_sweep_status() to service_role;

-- -----------------------------------------------------------------------------
-- 5) NO AUTOMATIC INSTALL — DELIBERATE.
--
--    An earlier revision of this file ended with a `do $$ ... public.dslang_schedule_sweeps() ... $$`
--    block that attempted the install as part of the migration. That has been
--    REMOVED on purpose, and this comment replaces it so the omission is not
--    mistaken for an oversight.
--
-- WHY
--   Applying this migration must have ZERO effect on cron. Scheduling is an
--    operator decision, not a schema change, and this file is applied to
--    environments that are not ready to run unattended sweeps.
--
--    It was also not as harmless as it appeared. dslang_schedule_sweeps()
--    unschedules BOTH jobs before re-adding them, so on any project where
--    `functions_base_url` had been configured it would tear down a working
--    `expire-stale-orders` job and recreate it under a new jobid. Today the
--    base URL is empty and the call returned early — but the migration should
--    not depend on that default holding to avoid churn on a live cron job.
--
-- HOW TO INSTALL (explicit, when you actually want it)
--    update public.dslang_sweep_settings
--       set functions_base_url = 'https://<PROJECT_REF>.supabase.co'
--     where id = 1;
--    select public.dslang_schedule_sweeps();
--    select public.dslang_sweep_status();   -- read-only verification
--
--    Note that the auto-ship job additionally requires the Vault secret named
--    by `ship_secret_name` to already exist, or it is reported as
--    `skipped_missing_vault_secret` and simply not scheduled.
-- -----------------------------------------------------------------------------

notify pgrst, 'reload schema';

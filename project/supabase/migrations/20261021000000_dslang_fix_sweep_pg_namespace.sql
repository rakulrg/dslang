-- =============================================================================
-- Migration: 20261021000000_dslang_fix_sweep_pg_namespace.sql
--
-- PURPOSE: repair two sweep-administration functions that could never run.
--
-- THE BUG
--   20261010000000_dslang_install_sweep_schedules.sql guards on the presence of
--   the Vault schema with:
--
--       if not exists (select 1 from pg_schema where schema_name = 'vault')
--
--   `pg_schema` is not a PostgreSQL catalog at all. The catalog that lists
--   schemas is `pg_namespace`, and its column is named `nspname` — NOT
--   `schema_name`. (`schema_name` belongs to `information_schema.schemata`.)
--   So a bare rename to `pg_namespace` while keeping `schema_name` would trade
--   one runtime error for another (`column "schema_name" does not exist`); the
--   corrected pair is `pg_namespace.nspname`.
--
--   Because plpgsql resolves relations at RUN time, the mistake was invisible
--   at migration time: both functions were created cleanly, granted, and only
--   raised when first called —
--
--       ERROR: relation "pg_schema" does not exist
--
-- IMPACT (why this blocks shipping automation)
--   * dslang_sweep_status() is the ONLY supported read-only way to see whether
--     pg_cron / pg_net / Vault are installed, whether the trigger secrets exist
--     and which cron.job rows are actually present. It has never once returned a
--     result, so the operator has been blind to the scheduler's real state.
--   * dslang_schedule_sweeps() hits the same reference at its third guard,
--     BEFORE the functions_base_url check. So it cannot install anything either,
--     no matter how the configuration is filled in. The `auto-ship-orders`
--     sweep could therefore never be scheduled by the sanctioned installer.
--
-- WHAT THIS FILE CHANGES — nothing but the catalog name:
--   * `pg_schema` -> `pg_namespace` in exactly two places.
--   * Both function bodies are otherwise reproduced VERBATIM: identical
--     declarations, variables, control flow, guard order, hint strings, return
--     shapes, cron command template, and idempotent unschedule-then-schedule
--     construction.
--   * Identical security posture: SECURITY DEFINER with a pinned
--     `search_path = public, pg_catalog`, REVOKE ALL from PUBLIC, EXECUTE
--     granted only to service_role. `CREATE OR REPLACE` preserves the existing
--     ACL; the explicit REVOKE/GRANT pair is repeated so the file states the
--     contract on its own.
--   * `pg_namespace` resolves through the pinned `pg_catalog` in the search
--     path, exactly like the `pg_extension` reference it sits beside.
--
-- EXPLICITLY OUT OF SCOPE (deliberate, per the maintenance task):
--   * public.dslang_sweep_settings is NOT modified. functions_base_url stays
--     '' exactly as it is, so the installer still short-circuits with
--     `functions_base_url_not_configured` and still schedules nothing. Fixing
--     the catalog reference must not, by itself, arm any scheduler.
--   * No Vault secret is created, altered or read.
--   * No cron job is installed, unscheduled, enabled or disabled. Neither
--     function is invoked by this migration — it only (re)defines them.
--   * No order, inventory, payment, shipping or Delhivery configuration is
--     touched.
--
-- ADDITIVE ONLY: two CREATE OR REPLACE FUNCTION statements (no DROP, no
-- ALTER, no data change). Applying it is inert until an operator deliberately
-- calls dslang_schedule_sweeps() with approval.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) dslang_schedule_sweeps() — identical to the 20261010000000 definition
--    except for the corrected Vault schema catalog reference.
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
  -- FIX: was `pg_schema` (not a catalog) -> always raised
  -- `relation "pg_schema" does not exist` at run time. `pg_namespace` is the
  -- right catalog; its schema column is `nspname`, not `schema_name`.
  if not exists (select 1 from pg_namespace where nspname = 'vault') then
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
-- 2) dslang_sweep_status() — identical to the 20261010000000 definition except
--    for the corrected Vault schema catalog reference. Strictly read-only: it
--    performs SELECTs against pg_extension / pg_namespace / cron.job and the
--    Vault secret NAMES, and returns them as jsonb.
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
    -- FIX: was `pg_schema` (not a catalog) -> always raised
    -- `relation "pg_schema" does not exist`, which is why this read-only
    -- verifier had never returned anything. `pg_namespace` is the right
    -- catalog; its schema column is `nspname`, not `schema_name`.
    'vault', exists (select 1 from pg_namespace where nspname = 'vault'),
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

-- Reload the PostgREST schema cache so the repaired bodies are the ones the API
-- resolves immediately. Safe: only emits NOTIFY, no DDL, no data change.
notify pgrst, 'reload schema';

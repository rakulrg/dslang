-- 20260923000000_dslang_expire_stale_retail_orders.sql
-- Atomic reclaim for stale pending orders: mark failed + return stock.
-- SECURITY DEFINER: only callable by service_role (sweep function or admin).
-- Idempotent: guarded by payment_status='pending' AND stock_restored_at IS NULL.

-- 1. Partial index for the sweep query (candidates = pending rows, not yet restocked).
create index if not exists idx_retail_orders_stale_pending
  on public.retail_orders (created_at)
  where payment_status = 'pending' and stock_restored_at is null;

-- 2. Atomic expire + restock RPC.
create or replace function public.expire_stale_retail_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.retail_orders%rowtype;
begin
  -- Lock the row to serialize two concurrent sweep runs on the same order.
  select * into v_order
    from public.retail_orders
   where id = p_order_id
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;

  if v_order.payment_status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'not_pending',
      'payment_status', v_order.payment_status
    );
  end if;

  if v_order.stock_restored_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_restocked');
  end if;

  -- CAS-style flip: only win if still pending.
  update public.retail_orders
     set payment_status = 'failed', updated_at = now()
   where id = p_order_id
     and payment_status = 'pending';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'already_expired', 'restocked', false);
  end if;

  -- Restock is idempotent (stock_restored_at guard) and skip-rule-aware.
  perform public.restock_retail_order_items(p_order_id);

  return jsonb_build_object(
    'ok', true,
    'ref', v_order.ref,
    'reason', 'expired_and_restocked'
  );
end;
$$;

revoke all on function public.expire_stale_retail_order(uuid) from public;
grant  execute on function public.expire_stale_retail_order(uuid) to service_role;

comment on function public.expire_stale_retail_order(uuid) is
  'Expire a still-pending, un-restocked order: CAS payment_status pending->failed '
  'then call restock_retail_order_items. Idempotent. service_role only.';

-- ===========================================================================
-- SCHEDULING (enable manually, AFTER deploying the expire-stale-orders fn):
--
-- The service_role key is stored in Supabase Vault (never hardcoded into the
-- cron command). The job reads it at run time and sends
-- 'Authorization: Bearer <service_role>' to the edge function — the same value
-- the function already uses from its own server-side env.
--
-- 1. Enable Vault (or via Dashboard -> Database -> Extensions):
--      create extension if not exists supabase_vault;
--      select vault.create_secret('<SERVICE_ROLE_KEY>', 'expire_stale_orders_key');
--
-- 2. Enable pg_cron + pg_net (or via Dashboard -> Database -> Extensions):
--      create extension if not exists pg_cron;
--      create extension if not exists pg_net;
--
-- 3. Register the schedule (run once in the SQL editor):
--
--    select cron.schedule(
--      'expire-stale-orders',
--      '*/15 * * * *',                            -- every 15 minutes
--      $$
--      select net.http_post(
--        url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/expire-stale-orders',
--        headers := jsonb_build_object(
--          'Content-Type', 'application/json',
--          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'expire_stale_orders_key')
--        ),
--        body    := '{"minutes": 30, "limit": 20}'
--      );
--      $$
--    );
--
--    (Alternative: set a dedicated SWEEP_TRIGGER_TOKEN in the function's
--     secrets and store THAT in Vault instead of the service role key.)
--
-- 4. Verify the job + runs:
--      select * from cron.job where jobname = 'expire-stale-orders';
--      select * from cron.job_run_details order by start_time desc limit 5;
--
-- To remove:
--      select cron.unschedule('expire-stale-orders');
--      select vault.delete_secret(secret_id) from vault.decrypted_secrets where name = 'expire_stale_orders_key';
-- ===========================================================================
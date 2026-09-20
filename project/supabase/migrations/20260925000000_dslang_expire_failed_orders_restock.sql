-- 20260925000000_dslang_expire_failed_orders_restock.sql
-- Reclaim stock for FAILED orders too, via the existing sweep.
--
-- WHY: definitive payment failures no longer restock at status-verification /
-- webhook time (cashfree-status + cashfree-webhook). The order stays reserved
-- so "Try Again" can reuse the same order and its Cashfree session without
-- over-selling stock that was already put back on the shelf. The reservation is
-- now released ONLY by the expire-stale-orders sweep, which must therefore also
-- reclaim orders that already reached payment_status='failed' (previously those
-- were only ever restocked by the immediate-failure branch, now removed).
--
-- FIX:
--   * re-create expire_stale_retail_order so its CAS flip accepts BOTH
--     'pending' and 'failed' payment_status (still guarded by
--     stock_restored_at IS NULL; restock stays idempotent + skip-rule-aware).
--   * add a partial index matching the widened sweep candidate query.
-- Idempotent: create-or-replace with the same signature; no data/table changes.
-- NOTE: must be accompanied by the expire-stale-orders function change that
-- selects payment_status IN ('pending','failed').

-- 1. Partial index for the widened sweep candidate query.
create index if not exists idx_retail_orders_stale_reclaimable
  on public.retail_orders (created_at)
  where payment_status in ('pending', 'failed')
    and stock_restored_at is null;

-- 2. Re-created RPC: CAS pending|failed -> failed + cancelled, then restock.
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

  -- Only pending or already-failed (un-paid) orders are reclaimable. A paid,
  -- shipped, delivered or refunded order is never restocked here.
  if v_order.payment_status not in ('pending', 'failed') then
    return jsonb_build_object(
      'ok', false,
      'reason', 'not_reclaimable',
      'payment_status', v_order.payment_status
    );
  end if;

  if v_order.stock_restored_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_restocked');
  end if;

  -- CAS-style flip: only win if still pending/failed and never restocked.
  update public.retail_orders
     set payment_status = 'failed',
         order_status = 'cancelled',
         updated_at = now()
   where id = p_order_id
     and payment_status in ('pending', 'failed')
     and stock_restored_at is null;

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
  'Expire a still-pending or failed, un-restocked order: CAS payment_status -> '
  'failed and order_status -> cancelled, then call restock_retail_order_items. '
  'Idempotent. service_role only.';

notify pgrst, 'reload schema';
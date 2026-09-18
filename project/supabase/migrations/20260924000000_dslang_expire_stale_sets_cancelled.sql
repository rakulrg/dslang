-- 20260924000000_dslang_expire_stale_sets_cancelled.sql
-- Status-consistency fix for the stale-order sweep.
--
-- WHY: expire_stale_retail_order (20260923000000) marked expired orders
-- payment_status='failed' but left order_status='pending'. That made admin
-- filtering + the customer-facing states contradictory (an order could read
-- "payment failed" but "order pending"). The retail flow requires: a failed
-- payment is ALWAYS a cancelled order (never 'pending'/'processing').
--
-- FIX: re-create the RPC so the CAS flip also sets order_status='cancelled'.
-- Restock semantics are unchanged (restock_retail_order_items is skip-rule-
-- aware — it still restocks a 'cancelled' un-paid order exactly once).
-- Idempotent: same signature, create-or-replace, no data/table changes.

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

  -- CAS-style flip: only win if still pending. A failed payment is always a
  -- cancelled order (never 'pending'/'processing') per the retail flow rules.
  update public.retail_orders
     set payment_status = 'failed',
         order_status = 'cancelled',
         updated_at = now()
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
  'and order_status -> cancelled, then call restock_retail_order_items. '
  'Idempotent. service_role only.';

notify pgrst, 'reload schema';
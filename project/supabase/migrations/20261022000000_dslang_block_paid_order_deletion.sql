-- =============================================================================
-- Migration: 20261022000000_dslang_block_paid_order_deletion.sql
--
-- WHY: a paid order could be deleted from the admin panel, taking its order row
--      with it while leaving its reserved stock permanently withdrawn.
--
-- THE BUG (confirmed in production on 2026-10-10):
--   `delete_retail_order` calls `restock_retail_order_items` and then deletes the
--   row, whatever the restock decided:
--
--       perform public.restock_retail_order_items(p_order_id);   -- may no-op
--       delete from public.retail_orders where id = p_order_id;
--
--   `restock_retail_order_items` deliberately refuses to touch a paid order:
--
--       -- restock_fail_closed.sql:109
--       if v_order.payment_status = 'success' then return 0; end if;
--       -- restock_fail_closed.sql:112
--       if v_order.order_status in ('shipped','delivered','refunded','rto')
--          then return 0; end if;
--
--   Those two guards are FINANCIAL SAFETY and must stay exactly as they are: a
--   captured payment is not evidence that the goods are back on the shelf. The
--   customer may be owed a refund, or the units may already be in a parcel.
--
--   The defect is therefore not in the restock. It is that `delete_retail_order`
--   treated "restock declined" as if it were "restock completed". Five test
--   orders reached payment_status='success' / order_status='processing' and were
--   then deleted; `product_sizes.stock` was never incremented, the rows vanished,
--   and 6 units across 4 variants were orphaned. Worse, they became INVISIBLE:
--   `variant_inventory_v` derives `committed` from live open orders, so once the
--   rows are gone the ops dashboard reports those units as neither available nor
--   committed — the loss is silent and unrecoverable from the data.
--
-- THE RULE (this migration):
--   Deleting a row must never silently drop a reservation. Deletion is refused
--   whenever removing the row would either destroy payment evidence or strand
--   stock that restock will not release.
--
--   1. FINANCIAL GUARD - if money was captured, the order is not deletable
--      through the normal admin workflow at all. The correct instrument is a
--      refund/cancel flow that leaves an auditable record, not a row delete.
--   2. INVENTORY GUARD - if the order still holds a reservation
--      (`stock_restored_at is null`) and restock would refuse to act, deletion is
--      refused. This closes the same leak through every other door
--      (shipped/delivered/refunded/rto), not just the paid one.
--
--   Both guards are checked BEFORE any write and raise, so nothing is deleted.
--
-- PRESERVED, deliberately unchanged:
--   * `restock_retail_order_items` is NOT touched in this migration. Its paid and
--     terminal-status guards stay exactly as they are.
--   * Deletion of pending / failed / cancelled orders still works and still
--     restocks first, atomically, exactly as before.
--   * Deleting an order whose stock was already restored stays allowed: nothing
--     is stranded and no payment was captured.
--   * Promo-usage reversal on delete is unchanged.
--
-- THE ESCAPE HATCH (deliberately narrow):
--   `delete_paid_retail_order` is the separately authorized process for a CONFIRMED
--   TEST order. It is not a general-purpose bypass:
--     * admin_users membership, same gate as every other admin RPC;
--     * it REFUSES orders that are not financially settled, so it can never be
--       used to delete an ordinary pending/failed order;
--     * it REFUSES shipped/delivered/refunded/rto orders, so it can never
--       destroy the fulfilment record of goods that left the warehouse;
--     * it requires a free-text reason AND a free-text payment-settlement
--       attestation, both stored verbatim in the audit trail;
--     * it writes a COMPLETE snapshot of the order - payment identifiers, paid_at,
--       amounts, promo code and the full items array - to `admin_activity`
--       BEFORE deleting, so payment history and per-variant reservations survive
--       the row's destruction;
--     * it does NOT restock. Returning captured stock is a financial decision, so
--       the units are reported back to the caller and must be corrected through
--       the audited ops path (`adjust_variant_stock`) once finance has confirmed.
--
--   Deleting is therefore auditable and payment-safe, but deliberately does NOT
--   hand out a way to inflate inventory.
--
-- SCOPE: this migration redefines `delete_retail_order`, adds
-- `delete_paid_retail_order`, and changes no data. It does not touch the restock
-- function, the expiry sweep, any edge function, cron, or any existing row.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared predicate: has money actually been captured for this order?
--
-- Deliberately NOT based on `amount_paid_upfront`. Verified against production on
-- 2026-10-10: unpaid orders carry the intended charge in that column (15 failed
-- orders all had amount_paid_upfront of 448/548/648/897/1746), so testing it
-- would refuse to delete exactly the unpaid orders this migration must keep
-- deleting. `paid_at` is the server-set payment-verification timestamp and is
-- NULL on every unpaid row, so it is the trustworthy signal.
--
-- `cod_partial_paid` is legacy-only but means an advance genuinely was collected,
-- so it counts as captured. COD `cod_pending` orders charged nothing online
-- (amount_paid_upfront = 0, paid_at NULL) and stay deletable.
-- -----------------------------------------------------------------------------
create or replace function public.dslang_order_payment_captured(p_payment_status text, p_paid_at timestamptz)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_paid_at is not null
      or lower(coalesce(p_payment_status, '')) in ('success', 'paid', 'cod_partial_paid');
$$;

revoke all on function public.dslang_order_payment_captured(text, timestamptz) from public;
grant execute on function public.dslang_order_payment_captured(text, timestamptz) to service_role;

comment on function public.dslang_order_payment_captured(text, timestamptz) is
  'True when money was actually captured for a retail order: paid_at is set by '
  'payment verification, or payment_status is success/paid/cod_partial_paid. '
  'Amount columns are deliberately ignored - unpaid orders carry the intended '
  'charge in amount_paid_upfront.';

-- -----------------------------------------------------------------------------
-- delete_retail_order — refuse deletions that would strand stock or destroy
-- payment evidence. Signature, return type, security posture and the legitimate
-- pending/failed/cancelled behaviour are all unchanged.
-- -----------------------------------------------------------------------------
create or replace function public.delete_retail_order(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
  v_code text;
  v_order public.retail_orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can delete orders.';
  end if;

  if p_order_id is null then
    raise exception 'An order id is required.';
  end if;

  -- Lock the row for the rest of the transaction so a concurrent payment
  -- webhook cannot flip it to 'success' between these checks and the DELETE.
  select * into v_order
  from public.retail_orders
  where id = p_order_id and order_type = 'retail'
  for update;

  -- Nothing to delete. Returning 0 (not raising) preserves the RPC's existing
  -- "0 => id not found" contract that the admin UI keys off.
  if not found then
    return 0;
  end if;

  -- GUARD 1 (financial): money was captured. Deleting the row destroys the only
  -- record of the payment. Refuse, and point at the authorized alternative.
  if public.dslang_order_payment_captured(v_order.payment_status, v_order.paid_at) then
    raise exception
      'Order % has a captured payment (payment_status=%, paid_at=%) and cannot be deleted. '
      'Refund or cancel it so the payment record is kept, or - only for a confirmed test '
      'order - use delete_paid_retail_order with a reason and a payment-settlement attestation.',
      coalesce(v_order.ref, p_order_id::text), coalesce(v_order.payment_status, 'null'),
      coalesce(v_order.paid_at::text, 'null')
      using errcode = 'check_violation';
  end if;

  -- GUARD 2 (inventory): the order still holds a reservation AND restock will
  -- refuse to release it, so deleting the row would strand those units exactly
  -- as the paid path did. stock_restored_at is not null means the units are
  -- already back, so that case stays deletable.
  if v_order.stock_restored_at is null
     and v_order.order_status in ('shipped', 'delivered', 'refunded', 'rto') then
    raise exception
      'Order % still holds reserved stock but is % (stock is not returned for orders '
      'that are shipped, delivered, refunded or RTO). Deleting it would strand stock. '
      'Fulfil or reconcile the order instead.',
      coalesce(v_order.ref, p_order_id::text), v_order.order_status
      using errcode = 'check_violation';
  end if;

  -- Restock (honours skip rules + idempotency flag, locks the row) atomically
  -- with the delete below. Unchanged from the previous definition.
  perform public.restock_retail_order_items(p_order_id);

  select promo_code into v_code
  from public.retail_orders
  where id = p_order_id and order_type = 'retail';

  delete from public.retail_orders
  where id = p_order_id and order_type = 'retail';
  get diagnostics v_deleted = row_count;

  -- Reverse the promo usage increment made at order creation, if any.
  if v_deleted = 1 and v_code is not null and trim(v_code) <> '' then
    update public.promo_codes
    set used_count = greatest(used_count - 1, 0)
    where upper(code) = upper(trim(v_code));
  end if;

  return v_deleted;
end;
$$;

revoke all on function public.delete_retail_order(uuid) from public;
grant execute on function public.delete_retail_order(uuid) to authenticated;
revoke execute on function public.delete_retail_order(uuid) from anon;

comment on function public.delete_retail_order(uuid) is
  'Admin delete of ONE retail order. Refuses orders with a captured payment, and '
  'refuses to strand reserved stock. Pending/failed/cancelled orders are '
  'restocked and deleted exactly as before.';

-- -----------------------------------------------------------------------------
-- delete_paid_retail_order — the separately authorized path for a CONFIRMED TEST
-- order. Auditable, and deliberately does not touch inventory.
-- -----------------------------------------------------------------------------
create or replace function public.delete_paid_retail_order(
  p_order_id uuid,
  p_reason text,
  p_payment_settled_attestation text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.retail_orders%rowtype;
  v_actor uuid := auth.uid();
  v_reason text := trim(coalesce(p_reason, ''));
  v_attest text := trim(coalesce(p_payment_settled_attestation, ''));
  v_committed jsonb;
  v_units integer;
begin
  if v_actor is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (select 1 from public.admin_users where user_id = v_actor) then
    raise exception 'Only an authorized administrator can delete paid orders.';
  end if;

  if p_order_id is null then
    raise exception 'An order id is required.';
  end if;

  -- Both free-text fields are mandatory and must be substantive. A single
  -- character is not a record anyone can audit later.
  if length(v_reason) < 12 then
    raise exception 'A reason of at least 12 characters is required to delete a paid order.';
  end if;
  if length(v_attest) < 12 then
    raise exception
      'A payment-settlement attestation of at least 12 characters is required. '
      'State how the captured payment was settled (for example: sandbox/test '
      'capture, or refund completed with reference).';
  end if;

  select * into v_order
  from public.retail_orders
  where id = p_order_id and order_type = 'retail'
  for update;

  if not found then
    raise exception 'Order not found.';
  end if;

  -- Scope control: this function exists ONLY for orders the normal path now
  -- refuses. If the order was never paid, deleting it must go through
  -- delete_retail_order so the ordinary restock-and-delete path stays the only
  -- route for unpaid orders.
  if not public.dslang_order_payment_captured(v_order.payment_status, v_order.paid_at) then
    raise exception
      'Order % has no captured payment (payment_status=%, paid_at=%); use '
      'delete_retail_order for unpaid orders.',
      coalesce(v_order.ref, p_order_id::text), coalesce(v_order.payment_status, 'null'),
      coalesce(v_order.paid_at::text, 'null');
  end if;

  -- Fulfilment guard. The normal path refuses to strand a reservation on a
  -- terminal-status order; this path bypasses restock entirely, so without an
  -- equivalent check it would happily delete a SHIPPED or DELIVERED order and
  -- destroy the fulfilment record of goods that physically left the warehouse.
  -- A test order that was actually shipped is not a test order any more -
  -- investigate before touching it.
  if v_order.order_status in ('shipped', 'delivered', 'refunded', 'rto') then
    raise exception
      'Order % is % and cannot be deleted through the paid-order path: the goods '
      'were handed over, so removing the row would destroy the fulfilment record. '
      'Reconcile this order manually.',
      coalesce(v_order.ref, p_order_id::text), v_order.order_status
      using errcode = 'check_violation';
  end if;

  -- Per-variant reservation still held, so the caller can reconcile inventory
  -- through the audited ops path. An already-restocked order commits nothing.
  select coalesce(jsonb_agg(x order by x->>'product_id'), '[]'::jsonb),
         coalesce(sum((x->>'quantity')::int), 0)
  into v_committed, v_units
  from (
    select jsonb_build_object(
             'product_id', (e.item->>'product_id'),
             'color_id', (e.item->>'color_id'),
             'size_label', e.item->>'size_label',
             'quantity', coalesce((e.item->>'quantity')::int, 0)
           ) as x
    from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) e(item)
    where coalesce((e.item->>'quantity')::int, 0) > 0
  ) q
  where v_order.stock_restored_at is null;

  -- Preserve payment history BEFORE the row disappears. Without this the delete
  -- leaves only a bare ref (that is exactly why the five test-order deletions
  -- left no record of what they were worth).
  perform public.record_admin_activity(
    'DELETE_PAID_ORDER',
    'order',
    v_order.id::text,
    v_order.ref,
    jsonb_strip_nulls(jsonb_build_object(
      'reason', v_reason,
      'payment_settled_attestation', v_attest,
      'order_type', v_order.order_type,
      'order_status', v_order.order_status,
      'payment_status', v_order.payment_status,
      'payment_provider', v_order.payment_provider,
      'payment_id', v_order.payment_id,
      'txn_id', v_order.txn_id,
      'paid_at', v_order.paid_at,
      'created_at', v_order.created_at,
      'total_qty', v_order.total_qty,
      'subtotal', v_order.subtotal,
      'discount', v_order.discount,
      'shipping', v_order.shipping,
      'total_amount', v_order.total_amount,
      'amount_paid_upfront', v_order.amount_paid_upfront,
      'amount_due_on_delivery', v_order.amount_due_on_delivery,
      'currency', v_order.currency,
      'promo_code', v_order.promo_code,
      'customer', v_order.customer,
      'items', v_order.items,
      'stock_restored_at', v_order.stock_restored_at,
      'stock_still_committed_units', v_units,
      'stock_still_committed', v_committed
    ))
  );

  delete from public.retail_orders
  where id = p_order_id and order_type = 'retail';

  -- Reverse the promo usage increment made at order creation, if any, exactly
  -- as the normal path does.
  if v_order.promo_code is not null and trim(v_order.promo_code) <> '' then
    update public.promo_codes
    set used_count = greatest(used_count - 1, 0)
    where upper(code) = upper(trim(v_order.promo_code));
  end if;

  return jsonb_build_object(
    'ok', true,
    'ref', v_order.ref,
    'reason', v_reason,
    'payment_status', v_order.payment_status,
    'paid_at', v_order.paid_at,
    -- Restock is NEVER performed here. These units are still withdrawn from
    -- product_sizes.stock and must be returned deliberately, via
    -- adjust_variant_stock, once finance has confirmed the payment.
    'stock_restocked', false,
    'stock_still_committed_units', v_units,
    'stock_still_committed', v_committed,
    'note', 'Order removed. No refund was issued and no stock was restored. '
            'Reconcile the listed variants with adjust_variant_stock after '
            'confirming the payment.'
  );
end;
$$;

revoke all on function public.delete_paid_retail_order(uuid, text, text) from public;
grant execute on function public.delete_paid_retail_order(uuid, text, text) to authenticated;
revoke execute on function public.delete_paid_retail_order(uuid, text, text) from anon;

comment on function public.delete_paid_retail_order(uuid, text, text) is
  'Separately authorized delete for a CONFIRMED TEST order with a captured payment. '
  'Requires admin_users, a reason and a payment-settlement attestation; refuses '
  'unpaid orders and refuses shipped/delivered/refunded/rto orders. Writes a full '
  'payment/inventory snapshot to admin_activity before deleting. Never refunds and '
  'never restocks - it reports the per-variant units still committed so they can be '
  'reconciled through adjust_variant_stock.';

notify pgrst, 'reload schema';
-- 20261016000000_dslang_restock_fail_closed.sql
--
-- WHY: restock_retail_order_items could report success while restoring nothing.
--
-- The preflight-free UPDATE (20261001000000_dslang_shiprocket.sql) aggregated
-- order lines and let the join decide what matched:
--
--     select (x.item->>'product_id')::uuid, ...
--     from jsonb_array_elements(...) x(item)
--     where coalesce((x.item->>'quantity')::int, 0) > 0
--       and x.item->>'product_id' is not null      <-- silently DROPS the line
--       and x.item->>'color_id'   is not null      <-- silently DROPS the line
--       and x.item->>'size_label' is not null      <-- silently DROPS the line
--     group by 1, 2, 3
--
-- Two distinct leaks followed from that:
--
--   1) A line missing any of the three identifiers was filtered out by the
--      inner WHERE, so its reserved units were never returned to
--      product_sizes.stock. The order was nevertheless stamped
--      stock_restored_at = now() a few lines later, so the idempotency guard
--      then made the loss permanent: no later sweep could ever retry it.
--
--   2) A line whose (product_id, color_id, size_label) triple has no matching
--      product_sizes row was dropped by the JOIN instead. The UPDATE touched
--      fewer rows than there were distinct keys, but nothing compared the two
--      numbers, so the order was again stamped and the reservation leaked.
--
-- Either way the caller saw a successful restock. Both are silent partial
-- restores, which is exactly the failure mode stock accounting must not have.
--
-- WHAT CHANGES: restoration is now fail-closed and all-or-nothing.
--
--   * Every restockable line is validated BEFORE any write. A line that is
--     missing or malformed in any identifier, or whose triple resolves to no
--     product_sizes row, aborts the call with an exception. Because that
--     happens before the first UPDATE, and because PostgreSQL rolls the whole
--     transaction back on an exception, there is no partial write: stock is
--     either fully restored or untouched.
--
--   * The exception propagates out of restock_retail_order_items. Its callers
--     (expire_stale_retail_order, delete_retail_order) are plain plpgsql
--     `perform` calls inside the same transaction, so a raise there also
--     discards THEIR earlier writes. For the sweep that is the desired
--     outcome: the CAS flip to payment_status='failed' /
--     order_status='cancelled' is rolled back too, so the order stays exactly
--     as it was -- still a candidate, stock_restored_at still NULL, reserved
--     stock still held -- and the next 15-minute sweep retries it once the
--     bad line is repaired. Fail-closed, not fail-lost.
--
--   * A post-update row-count check re-asserts the invariant after the fact,
--     so a future edit to the aggregation cannot silently reintroduce a
--     mismatch between distinct keys and rows actually updated.
--
-- PRESERVED, deliberately unchanged:
--   * duplicate lines for the same triple still aggregate (SUM) to one stock
--     row touched once;
--   * stock = stock + qty and available = (stock + qty) > 0;
--   * every existing guard: null order, non-retail order, missing order,
--     payment_status='success', order_status in
--     (shipped, delivered, refunded, rto), and the stock_restored_at
--     idempotency guard -- each still returns 0 without writing;
--   * SECURITY DEFINER, `set search_path = public`, the same integer return
--     type and the same signature, so every existing caller and grant is
--     unaffected;
--   * transaction semantics: still one atomic unit, now with no partial state.
--
-- A line with quantity <= 0 remains a non-restockable line and is ignored,
-- exactly as before; it holds no reservation, so it is not a leak. Only lines
-- that actually reserved stock (quantity > 0) are validated and restored.
--
-- SCOPE: this migration redefines one function and changes no data. It does
-- not touch expire_stale_retail_order, the Cashfree decision table, the edge
-- function, cron, or any historical order row.

-- -----------------------------------------------------------------------------
-- restock_retail_order_items — fail-closed, all-or-nothing restoration.
-- -----------------------------------------------------------------------------
create or replace function public.restock_retail_order_items(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.retail_orders%rowtype;
  v_updated integer := 0;
  v_keys    integer := 0;
  v_bad     jsonb;
  v_missing integer := 0;
begin
  if p_order_id is null then
    return 0;
  end if;

  -- Lock the order row so concurrent webhook / status-poll / admin-delete
  -- paths serialize to a single restock. The lock is held until commit.
  select * into v_order
  from public.retail_orders
  where id = p_order_id
    and order_type = 'retail'
  for update;

  if not found then
    return 0;
  end if;

  -- Skip: paid order, or stock already gone out (fulfilled/refunded/rto).
  if v_order.payment_status = 'success' then
    return 0;
  end if;
  if v_order.order_status in ('shipped', 'delivered', 'refunded', 'rto') then
    return 0;
  end if;

  -- Skip: already restocked (idempotency guard).
  if v_order.stock_restored_at is not null then
    return 0;
  end if;

  -- ---------------------------------------------------------------------------
  -- PREFLIGHT 1 — every restockable line must carry a usable identifier.
  --
  -- Runs before any write, so a failure here cannot leave stock half-restored.
  -- Covers the three identifiers plus a quantity that is a positive integer:
  -- a non-numeric quantity would otherwise abort the cast further down, and
  -- surfacing it here names the offending line instead.
  -- ---------------------------------------------------------------------------
  with lines as (
    select l.ord,
           l.item,
           l.item->>'product_id' as product_id,
           l.item->>'color_id'   as color_id,
           l.item->>'size_label' as size_label,
           l.item->>'quantity'   as quantity
    from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb))
         with ordinality as l(item, ord)
  ),
  restockable as (
    -- Mirrors the historical filter: a line reserves stock only when its
    -- quantity is a positive integer.
    select *
    from lines
    where coalesce(quantity, '') ~ '^[0-9]+$'
      and quantity::int > 0
  ),
  malformed as (
    -- (a) A line whose quantity is not a parseable integer. Before this
    -- migration the bare `::int` cast raised here, which aborted the whole
    -- call; the regex guard keeps that abort but reports WHICH line instead of
    -- letting a bad value reach the cast. A signed integer is accepted here
    -- and then filtered by `> 0` below, so a zero or negative line still
    -- reserves nothing and is ignored exactly as it always was.
    select ord, item, product_id, color_id, size_label, quantity
    from lines
    where coalesce(quantity, '') <> ''
      and quantity !~ '^[+-]?[0-9]+$'

    union all

    -- (b) A restockable line missing or malforming any required identifier.
    select ord, item, product_id, color_id, size_label, quantity
    from restockable
    where product_id is null
       or btrim(product_id) = ''
       or product_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or color_id is null
       or btrim(color_id) = ''
       or color_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or size_label is null
       or btrim(size_label) = ''
  )
  select jsonb_agg(
           jsonb_build_object(
             'line', ord,
             'product_id', product_id,
             'color_id', color_id,
             'size_label', size_label,
             'quantity', quantity,
             'item', item
           )
           order by ord
         )
  into v_bad
  from malformed;

  if v_bad is not null then
    raise exception using
      errcode = 'check_violation',
      message = 'restock_retail_order_items: order % has % malformed restockable line(s) '
                '(missing or invalid product_id / color_id / size_label / quantity). '
                'Nothing was restored and stock_restored_at was NOT set; the order '
                'remains a retry candidate. Offending lines: %',
      detail = v_bad::text,
      hint = 'Repair the order''s items array, or void the bad line, then re-run the sweep.';
  end if;

  -- ---------------------------------------------------------------------------
  -- PREFLIGHT 2 — every distinct key must resolve to a product_sizes row.
  --
  -- (product_id, color_id, size_label) is UNIQUE on product_sizes, so this is
  -- an exact existence test, not a best-effort join. A key with no row means
  -- the reserved units have nowhere to go, which must abort rather than be
  -- dropped.
  -- ---------------------------------------------------------------------------
  with keys as (
    select (l.item->>'product_id')::uuid  as product_id,
           (l.item->>'color_id')::uuid    as color_id,
           l.item->>'size_label'          as size_label,
           sum((l.item->>'quantity')::int) as qty
    from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) as l(item)
    where coalesce(l.item->>'quantity', '') ~ '^[0-9]+$'
      and (l.item->>'quantity')::int > 0
    group by 1, 2, 3
  )
  select count(*)
  into v_missing
  from keys k
  where not exists (
    select 1
    from public.product_sizes ps
    where ps.product_id = k.product_id
      and ps.color_id   = k.color_id
      and ps.size_label = k.size_label
  );

  if v_missing > 0 then
    raise exception using
      errcode = 'check_violation',
      message = 'restock_retail_order_items: order % has % restockable key(s) with no '
                'matching product_sizes row. Nothing was restored and stock_restored_at '
                'was NOT set; the order remains a retry candidate.',
      detail = format('unresolvable distinct product/color/size keys: %s', v_missing),
      hint = 'Create the missing product_sizes row, then re-run the sweep.';
  end if;

  -- Distinct keys this restoration must touch, for the post-update assertion.
  with keys as (
    select (l.item->>'product_id')::uuid  as product_id,
           (l.item->>'color_id')::uuid    as color_id,
           l.item->>'size_label'          as size_label
    from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) as l(item)
    where coalesce(l.item->>'quantity', '') ~ '^[0-9]+$'
      and (l.item->>'quantity')::int > 0
    group by 1, 2, 3
  )
  select count(*) into v_keys from keys;

  -- ---------------------------------------------------------------------------
  -- RESTORE — identical to the previous behaviour, reached only once the order
  -- is known to be fully restockable. Aggregated per product/colour/size, so a
  -- multi-line or duplicate-line order updates each stock row exactly once.
  -- ---------------------------------------------------------------------------
  update public.product_sizes ps
  set stock = ps.stock + s.qty,
      available = (ps.stock + s.qty) > 0
  from (
    select (x.item->>'product_id')::uuid  as product_id,
           (x.item->>'color_id')::uuid    as color_id,
           x.item->>'size_label'          as size_label,
           sum((x.item->>'quantity')::int) as qty
    from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) as x(item)
    where coalesce(x.item->>'quantity', '') ~ '^[0-9]+$'
      and (x.item->>'quantity')::int > 0
    group by 1, 2, 3
  ) s
  where ps.product_id = s.product_id
    and ps.color_id = s.color_id
    and ps.size_label = s.size_label;

  get diagnostics v_updated = row_count;

  -- Defence in depth: preflight 2 already proved every key resolves, so a
  -- shortfall here means the aggregation and the UPDATE have diverged. Abort
  -- rather than stamp an order whose stock was only partly returned.
  if v_updated <> v_keys then
    raise exception using
      errcode = 'check_violation',
      message = 'restock_retail_order_items: order % restored % of % distinct stock rows. '
                'Rolling back; stock_restored_at was NOT set.',
      detail = format('rows_updated=%s, distinct_keys=%s', v_updated, v_keys);
  end if;

  -- Mark restocked (NULL -> now) so a second call is a no-op.
  --
  -- `and stock_restored_at is null` makes the stamp itself a compare-and-set, so
  -- the recorded restoration time is never overwritten by a later attempt. The
  -- FOR UPDATE lock above already serialises callers on this row, so this
  -- predicate cannot fail here under normal single-transaction execution; it is
  -- a defence-in-depth guarantee that the first stamp wins and keeps its
  -- original timestamp. Without it, any path that reached this UPDATE while the
  -- column was already set would silently restate a historical value.
  update public.retail_orders
  set stock_restored_at = now()
  where id = v_order.id
    and stock_restored_at is null;

  return v_updated;
end;
$$;

-- Unchanged grants: service_role only, EXECUTE revoked from anon/authenticated.
-- restock has no in-body auth gate, so the ACL is its only barrier.
revoke all on function public.restock_retail_order_items(uuid) from public;
grant execute on function public.restock_retail_order_items(uuid)
  to service_role;
revoke execute on function public.restock_retail_order_items(uuid) from anon;
revoke execute on function public.restock_retail_order_items(uuid) from authenticated;

comment on function public.restock_retail_order_items(uuid) is
  'Restore an unpaid retail order''s reserved stock. Fail-closed: aborts (restoring '
  'nothing and leaving stock_restored_at NULL) if any restockable line lacks a valid '
  'product_id/color_id/size_label or has no matching product_sizes row. Duplicate '
  'lines aggregate to one row update. Idempotent. service_role only.';

notify pgrst, 'reload schema';

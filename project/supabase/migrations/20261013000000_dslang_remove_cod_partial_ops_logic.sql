-- =============================================================================
-- DSLANG — remove COD partial-payment from ACTIVE operational logic
-- =============================================================================
--
-- This migration is ADDITIVE ONLY. It does not edit, drop or rewrite any
-- previously applied migration, and it does not destroy historical data.
--
-- BACKGROUND
-- ----------
-- 20260930000000_dslang_retail_cod.sql introduced a COD model where the
-- customer paid a small advance online (via Cashfree) and the balance on
-- delivery. That created two states:
--
--   payment_status = 'success'   (the advance was verified)
--   order_status   = 'cod_partial_paid'
--
-- 20261012000000_dslang_cod_full_payment.sql replaced that with FULL COD:
--
--   payment_status = 'cod_pending'
--   amount_paid_upfront = 0, amount_due_on_delivery = total_amount
--   no Cashfree session, no advance, no balance
--
-- 'cod_partial_paid' is now LEGACY ONLY. It must never be produced again.
--
-- WHAT WAS ACTUALLY BROKEN
-- -------------------------
-- The operations functions in 20261005000000_dslang_ops_inventory.sql were
-- written for the advance model and treated "confirmed" as
-- `payment_status = 'success' AND order_status IN ('cod_partial_paid',
-- 'processing')`. A new COD order is `payment_status = 'cod_pending'` and
-- `order_status = 'pending'`, so it matched NEITHER of those lists. The
-- consequences were:
--
--   1. COD orders were INVISIBLE in the to-pack and ready-to-ship queues and
--      in both "attention" lists — the packing staff could never see them.
--   2. The `sales` KPI and the sales chart summed total_amount for every order
--      whose payment_status was not failed/cancelled/refunded, which includes
--      'cod_pending'. That counted an order worth Rs 548 with Rs 0 actually
--      collected as if the money were in the bank.
--
-- Neither is acceptable, and they fail in opposite directions: one HIDES the
-- order, the other OVERSTATES the cash.
--
-- THE DISTINCTION ENFORCED HERE
-- -----------------------------
--   ORDER VALUE    = total_amount          — what the customer committed to buy
--   CASH COLLECTED = amount_paid_upfront   — money that has actually arrived
--   AMOUNT DUE     = amount_due_on_delivery— to be collected at the door
--
--   COD    (new):  order value 548 | cash collected 0   | due 548
--   Online (new):  order value 598 | cash collected 548 | due 0
--   COD (legacy):  order value 900 | cash collected 100 | due 800
--
-- A confirmed COD order is a real, committed, inventory-reserved order and is
-- reported as such everywhere it belongs (order counts, units, packing queues,
-- inventory committed, fulfilment). It is NOT counted as collected cash, and
-- it is NOT hidden.
--
-- HISTORICAL DATA IS UNTOUCHED
-- -----------------------------
-- No UPDATE against retail_orders appears in this migration. Legacy COD orders
-- that genuinely paid an advance keep payment_status / order_status /
-- amount_paid_upfront / amount_due_on_delivery exactly as they are, and the
-- revised functions still classify them correctly (they DO have cash collected,
-- so they count toward cash_collected and their fulfilment states still work).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Document the two payment states on the columns that carry them.
-- -----------------------------------------------------------------------------
comment on column public.retail_orders.payment_status is
  'Payment state. NEW COD orders use ''cod_pending'' = confirmed, nothing charged online, full amount due on delivery (''amount_due_on_delivery'' = ''total_amount'', ''amount_paid_upfront'' = 0). ''success'' means Cashfree money was verified (online orders, and legacy COD orders that genuinely paid an advance). ''pending''/''failed'' are unpaid ONLINE orders. ''cod_partial_paid'' is LEGACY ONLY and must never be written by a new order path.';

comment on column public.retail_orders.order_status is
  'Fulfilment state, shared by both payment methods (''pending'' -> ''processing'' -> ''shipped'' -> ''delivered''). ''cod_partial_paid'' is LEGACY ONLY: it was a fulfilment state invented for the withdrawn COD advance model and must never be written by a new order path.';

-- -----------------------------------------------------------------------------
-- 1) Database guard for the new COD invariant.
--
--    Preferred invariant: a COD order in the NEW state carries no online charge.
--
--    Deliberately NOT a blanket `is_cod => amount_paid_upfront = 0`:
--    legacy COD orders really do have a positive amount_paid_upfront (the advance
--    they genuinely paid), and a plain CHECK would fail validation against those
--    existing rows and abort this migration.
--
--    The predicate is therefore scoped to the new state, and added NOT VALID:
--      * existing rows are not checked, so history stays valid;
--      * every future INSERT and UPDATE IS checked, so no new COD order can ever
--        be written with an online charge.
--
--    Note on UPDATE: Postgres re-checks a NOT VALID CHECK on any UPDATE of the
--    row. That is harmless here — a new COD row satisfies the predicate by
--    construction (amount_paid_upfront = 0), and legacy rows are outside the
--    predicate because their payment_status is not 'cod_pending'.
--
--    The equivalent invariant for amount_due_on_delivery is deliberately NOT
--    added: the RPC rounds with round(v_total, 2), so an exact equality check
--    could reject a legitimate order whose total carries sub-paise precision.
--    The "full amount due" rule is instead enforced at the only place that
--    creates orders (create_retail_order) and asserted by the test suite.
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  drop constraint if exists dslang_cod_pending_no_upfront_chk;

alter table public.retail_orders
  add constraint dslang_cod_pending_no_upfront_chk
  check (
    not coalesce(is_cod, false)
    or payment_status is distinct from 'cod_pending'
    or amount_paid_upfront = 0
  ) not valid;

comment on constraint dslang_cod_pending_no_upfront_chk on public.retail_orders is
  'New COD orders (payment_status = ''cod_pending'') must never carry an online charge: amount_paid_upfront = 0. Added NOT VALID so legacy COD orders that genuinely paid an advance are not invalidated; enforced on every future INSERT and UPDATE.';

-- -----------------------------------------------------------------------------
-- 2) dashboard_overview_stats — same signature, COD-aware fulfilment and an
--    explicit order-value vs cash-collected split.
--
--    Changes vs 20261005000000:
--      * "confirmed" is now payment_status IN ('success','paid','cod','cod_pending')
--        instead of payment_status = 'success', so COD reaches the packing and
--        ready-to-ship queues and the attention lists.
--      * kpi.sales is kept as ORDER VALUE and is now accompanied by
--        kpi.cash_collected and kpi.cod_due, so an unpaid COD order can no
--        longer be read as collected revenue.
--      * the charts gain cash_collected and cod_due series alongside sales.
--      * attention rows expose cash_collected / amount_due for staff.
--    Everything else (inventory, low/out-of-stock, shipment exceptions) is
--    carried over unchanged. 'cod_partial_paid' is retained in the fulfilment
--    lists so legacy advance-model orders keep appearing in the right queue.
-- -----------------------------------------------------------------------------
create or replace function public.dashboard_overview_stats(p_range text default '7D')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_range text := upper(trim(coalesce(p_range, '7D')));
  v_start timestamptz;
  v_bucket text;
  v_gran text;
  v_label text;
  v_step text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can view dashboard statistics.';
  end if;

  if v_range in ('TODAY','1D') then
    v_range := '1D';
    v_start := date_trunc('day', now());
    v_bucket := 'hour';
    v_gran := 'hour';
    v_label := 'HH24';
    v_step := '1 hour';
  elsif v_range = '7D' then
    v_start := date_trunc('day', now()) - interval '6 days';
    v_bucket := 'day'; v_gran := 'day'; v_label := 'Mon DD'; v_step := '1 day';
  elsif v_range = '30D' then
    v_start := date_trunc('day', now()) - interval '29 days';
    v_bucket := 'day'; v_gran := 'day'; v_label := 'Mon DD'; v_step := '1 day';
  elsif v_range = '3M' then
    v_start := date_trunc('month', now()) - interval '2 months';
    v_bucket := 'week'; v_gran := 'week'; v_label := 'Mon DD'; v_step := '7 days';
  else
    v_range := '1Y';
    v_start := date_trunc('month', now()) - interval '11 months';
    v_bucket := 'month'; v_gran := 'month'; v_label := 'Mon YY'; v_step := '1 month';
  end if;

  select jsonb_build_object(
    'range', v_range,
    'from', v_start,
    'kpi', jsonb_build_object(
      -- ORDER VALUE: every live, non-failed order, COD included. This is a
      -- pipeline number ("what has been committed to"), not cash in the bank.
      'sales', coalesce((
        select sum(x.total_amount) from (
          select o.total_amount
          from public.retail_orders o
          where o.order_type = 'retail'
            and o.created_at >= v_start
            and o.payment_status not in ('failed','cancelled','refunded')
            and o.order_status not in ('cancelled','refunded')
        ) x
      ), 0),
      -- CASH COLLECTED: only money that has actually arrived. A confirmed COD
      -- order contributes 0 until the agent collects at the door, because its
      -- amount_paid_upfront is 0 by design.
      'cash_collected', coalesce((
        select sum(x.amount_paid_upfront) from (
          select o.amount_paid_upfront
          from public.retail_orders o
          where o.order_type = 'retail'
            and o.created_at >= v_start
            and o.payment_status not in ('failed','cancelled','refunded')
            and o.order_status not in ('cancelled','refunded')
        ) x
      ), 0),
      -- AMOUNT DUE: money still to be collected at the door on live COD orders.
      'cod_due', coalesce((
        select sum(x.amount_due_on_delivery) from (
          select o.amount_due_on_delivery
          from public.retail_orders o
          where o.order_type = 'retail'
            and o.created_at >= v_start
            and coalesce(o.is_cod, false)
            and o.payment_status not in ('failed','cancelled','refunded')
            and o.order_status not in ('cancelled','refunded')
        ) x
      ), 0),
      'cod_orders', coalesce((
        select count(*)::int
        from public.retail_orders o
        where o.order_type = 'retail'
          and o.created_at >= v_start
          and coalesce(o.is_cod, false)
          and o.payment_status not in ('failed','cancelled','refunded')
          and o.order_status not in ('cancelled','refunded')
      ), 0),
      'orders', coalesce((
        select count(*)::int from public.retail_orders o
        where o.order_type = 'retail'
          and o.created_at >= v_start
          and o.payment_status not in ('failed','cancelled','refunded')
          and o.order_status not in ('cancelled','refunded')
      ), 0),
      'units', coalesce((
        select sum(o.total_qty) from public.retail_orders o
        where o.order_type = 'retail'
          and o.created_at >= v_start
          and o.payment_status not in ('failed','cancelled','refunded')
          and o.order_status not in ('cancelled','refunded')
      ), 0),
      'pending_orders', coalesce((
        select count(*)::int from public.retail_orders o
        where o.order_type = 'retail'
          and o.payment_status not in ('failed','cancelled','refunded')
          and o.order_status in ('pending','cod_partial_paid','processing')
      ), 0),
      -- Fulfilment queues. 'cod_pending' is a CONFIRMED state for a new COD
      -- order (nothing is being verified, the cash is due at the door), so it
      -- must appear here exactly like a paid online order. 'cod_partial_paid'
      -- stays for legacy advance-model orders, which really are mid-fulfilment.
      'to_pack', coalesce((
        select count(*)::int from public.retail_orders o
        where o.order_type = 'retail'
          and o.payment_status in ('success','paid','cod','cod_pending')
          and o.order_status in ('pending','cod_partial_paid','processing')
      ), 0),
      'ready_to_ship', coalesce((
        select count(*)::int from public.retail_orders o
        where o.order_type = 'retail'
          and o.payment_status in ('success','paid','cod','cod_pending')
          and o.order_status in ('pending','cod_partial_paid','processing')
          and (o.awb_number is null and o.tracking_id is null)
      ), 0),
      'low_stock_variants', coalesce((
        select count(*)::int from public.product_sizes ps
        where ps.stock > 0 and ps.stock <= ps.reorder_point and ps.reorder_point > 0
      ), 0),
      'out_of_stock_variants', coalesce((
        select count(*)::int from public.product_sizes ps where ps.stock <= 0
      ), 0)
    ),
    'charts', (
      select jsonb_build_object(
        'labels', (select jsonb_agg(to_char(g, v_label) order by g) from generate_series(v_start, (select max(g) from generate_series(v_start, now(), v_step::interval) g), v_step::interval) g),
        'sales', coalesce((
          select jsonb_agg(coalesce(l.sales, 0) order by l.b) from (
            select date_trunc(v_gran, g) b
            from generate_series(v_start, now(), v_step::interval) g
          ) l
          left join (
            select date_trunc(v_gran, o.created_at) as b, sum(o.total_amount)::numeric sales
            from public.retail_orders o
            where o.order_type = 'retail'
              and o.created_at >= v_start
              and o.payment_status not in ('failed','cancelled','refunded')
              and o.order_status not in ('cancelled','refunded')
            group by 1
          ) s on s.b = l.b
        ), '[]'::jsonb),
        -- Per-bucket cash actually collected, so the sales curve can be read
        -- against it: the gap is the COD pipeline, not a shortfall in payment.
        'cash_collected', coalesce((
          select jsonb_agg(coalesce(l4.cash_collected, 0) order by l4.b) from (
            select date_trunc(v_gran, g) b
            from generate_series(v_start, now(), v_step::interval) g
          ) l4
          left join (
            select date_trunc(v_gran, o.created_at) as b, sum(o.amount_paid_upfront)::numeric cash_collected
            from public.retail_orders o
            where o.order_type = 'retail'
              and o.created_at >= v_start
              and o.payment_status not in ('failed','cancelled','refunded')
              and o.order_status not in ('cancelled','refunded')
            group by 1
          ) s4 on s4.b = l4.b
        ), '[]'::jsonb),
        -- Per-bucket amount still to be collected on the door for COD.
        'cod_due', coalesce((
          select jsonb_agg(coalesce(l5.cod_due, 0) order by l5.b) from (
            select date_trunc(v_gran, g) b
            from generate_series(v_start, now(), v_step::interval) g
          ) l5
          left join (
            select date_trunc(v_gran, o.created_at) as b, sum(o.amount_due_on_delivery)::numeric cod_due
            from public.retail_orders o
            where o.order_type = 'retail'
              and o.created_at >= v_start
              and coalesce(o.is_cod, false)
              and o.payment_status not in ('failed','cancelled','refunded')
              and o.order_status not in ('cancelled','refunded')
            group by 1
          ) s5 on s5.b = l5.b
        ), '[]'::jsonb),
        'orders', coalesce((
          select jsonb_agg(coalesce(l2.orders, 0) order by l2.b) from (
            select date_trunc(v_gran, g) b
            from generate_series(v_start, now(), v_step::interval) g
          ) l2
          left join (
            select date_trunc(v_gran, o.created_at) as b, count(*)::int orders
            from public.retail_orders o
            where o.order_type = 'retail'
              and o.created_at >= v_start
              and o.payment_status not in ('failed','cancelled','refunded')
              and o.order_status not in ('cancelled','refunded')
            group by 1
          ) s2 on s2.b = l2.b
        ), '[]'::jsonb),
        'units', coalesce((
          select jsonb_agg(coalesce(l3.units, 0) order by l3.b) from (
            select date_trunc(v_gran, g) b
            from generate_series(v_start, now(), v_step::interval) g
          ) l3
          left join (
            select date_trunc(v_gran, o.created_at) as b, sum(o.total_qty)::int units
            from public.retail_orders o
            where o.order_type = 'retail'
              and o.created_at >= v_start
              and o.payment_status not in ('failed','cancelled','refunded')
              and o.order_status not in ('cancelled','refunded')
            group by 1
          ) s3 on s3.b = l3.b
        ), '[]'::jsonb)
      )
    ),
    'inventory', jsonb_build_object(
      'available', coalesce((select sum(ps.stock) from public.product_sizes ps), 0),
      -- Inventory committed. A confirmed COD order holds its stock exactly like
      -- a paid one; it is only released on cancel/rto/return, so this stays
      -- unchanged and is already COD-correct.
      'committed', coalesce((
        select sum(x.qty) from (
          select (x.item->>'quantity')::int qty
          from public.retail_orders o
          cross join lateral jsonb_array_elements(o.items) x(item)
          where o.order_type = 'retail'
            and o.stock_restored_at is null
            and o.order_status not in ('shipped','delivered','cancelled','refunded','rto')
        ) x
      ), 0),
      'incoming', coalesce((select sum(ps.incoming) from public.product_sizes ps), 0),
      'low_stock', coalesce((select count(*)::int from public.product_sizes ps
        where ps.stock > 0 and ps.stock <= ps.reorder_point and ps.reorder_point > 0), 0),
      'out_of_stock', coalesce((select count(*)::int from public.product_sizes ps where ps.stock <= 0), 0),
      'value', coalesce((select sum(ps.stock * coalesce(p.price, 0)) from public.product_sizes ps join public.products p on p.id = ps.product_id), 0)
    ),
    'attention', jsonb_build_object(
      'to_pack', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ref', o.ref, 'total', o.total_amount, 'payment', o.payment_status,
          'cash_collected', o.amount_paid_upfront, 'amount_due', o.amount_due_on_delivery,
          'created', o.created_at) order by o.created_at) from (
          select o.ref, o.total_amount, o.payment_status, o.amount_paid_upfront,
                 o.amount_due_on_delivery, o.created_at
          from public.retail_orders o
          where o.order_type = 'retail'
            and o.payment_status in ('success','paid','cod','cod_pending')
            and o.order_status in ('pending','cod_partial_paid','processing')
          order by o.created_at
          limit 12
        ) o
      ), '[]'::jsonb),
      'ready_to_ship', coalesce((
        select jsonb_agg(jsonb_build_object(
          'ref', o.ref, 'total', o.total_amount, 'payment', o.payment_status,
          'cash_collected', o.amount_paid_upfront, 'amount_due', o.amount_due_on_delivery,
          'created', o.created_at) order by o.created_at) from (
          select o.ref, o.total_amount, o.payment_status, o.amount_paid_upfront,
                 o.amount_due_on_delivery, o.created_at
          from public.retail_orders o
          where o.order_type = 'retail'
            and o.payment_status in ('success','paid','cod','cod_pending')
            and o.order_status in ('pending','cod_partial_paid','processing')
            and (o.awb_number is null and o.tracking_id is null)
          order by o.created_at
          limit 12
        ) o
      ), '[]'::jsonb),
      'shipment_exceptions', coalesce((
        select jsonb_agg(jsonb_build_object('ref', o.ref, 'error', o.error, 'at', o.at) order by o.at desc) from (
          select o.ref, o.ship_attempt_error as error, o.last_ship_attempt_at as at
          from public.retail_orders o
          where o.order_type = 'retail'
            and o.ship_attempt_error is not null
            and o.last_ship_attempt_at is not null
            and o.order_status not in ('shipped','delivered')
          order by o.last_ship_attempt_at desc
          limit 8
        ) o
      ), '[]'::jsonb),
      'low_stock', coalesce((
        select jsonb_agg(jsonb_build_object(
          'product_id', ps.product_id, 'color_id', ps.color_id, 'size_label', ps.size_label,
          'name', p.name, 'color', pc.name, 'available', ps.stock, 'reorder_point', ps.reorder_point,
          'target_stock', ps.target_stock
        ) order by ps.stock) from (
          select ps.product_id, ps.color_id, ps.size_label, ps.stock, ps.reorder_point, ps.target_stock
          from public.product_sizes ps
          where ps.stock > 0 and ps.stock <= ps.reorder_point and ps.reorder_point > 0
          order by ps.stock
          limit 12
        ) ps
        join public.products p on p.id = ps.product_id
        join public.product_colors pc on pc.id = ps.color_id
      ), '[]'::jsonb),
      'out_of_stock', coalesce((
        select jsonb_agg(jsonb_build_object(
          'product_id', ps.product_id, 'color_id', ps.color_id, 'size_label', ps.size_label,
          'name', p.name, 'color', pc.name, 'reorder_point', ps.reorder_point, 'target_stock', ps.target_stock
        ) order by p.name) from (
          select ps.product_id, ps.color_id, ps.size_label, ps.reorder_point, ps.target_stock
          from public.product_sizes ps
          where ps.stock <= 0
          order by p.name
          limit 12
        ) ps
        join public.products p on p.id = ps.product_id
        join public.product_colors pc on pc.id = ps.color_id
      ), '[]'::jsonb)
    ),
    'ts', now()
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.dashboard_overview_stats(text) from public;
grant execute on function public.dashboard_overview_stats(text) to authenticated;
revoke execute on function public.dashboard_overview_stats(text) from anon;

-- -----------------------------------------------------------------------------
-- 3) admin_analytics — payment_mix gains an explicit cash split, and the
--    product/geo revenue figures are labelled as ORDER VALUE.
--
--    Before, payment_mix reported `revenue` = sum(total_amount) for COD, which
--    is indistinguishable from collected cash. It now reports three separate
--    numbers per method so the COD pipeline can be read honestly:
--      order_value, cash_collected, amount_due
-- -----------------------------------------------------------------------------
create or replace function public.admin_analytics()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can view analytics.';
  end if;

  select jsonb_build_object(
    'range', 'all-time',
    'top_products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', t.product_id, 'name', t.name, 'code', t.code,
        'color_id', t.color_id, 'color', t.color, 'size_label', t.size_label,
        'units', t.units, 'revenue', t.revenue, 'orders', t.orders
      ) order by t.revenue desc) from (
        -- `revenue` here is ORDER VALUE of the line (what was sold), not cash.
        -- Cash cannot be attributed to an individual line, so it is only
        -- reported in aggregate under payment_mix.
        select
          x.item->>'product_id' as product_id,
          x.item->>'color_id' as color_id,
          x.item->>'size_label' as size_label,
          (x.item->>'name')::text as name,
          coalesce(x.item->>'code', '') as code,
          (x.item->>'color')::text as color,
          sum((x.item->>'quantity')::int) as units,
          sum((x.item->>'line_total')::numeric) as revenue,
          count(distinct o.id) as orders
        from public.retail_orders o
        cross join lateral jsonb_array_elements(o.items) x(item)
        where o.order_type = 'retail'
          and o.payment_status not in ('failed','cancelled','refunded')
          and o.order_status not in ('cancelled','refunded')
        group by 1, 2, 3, 4, 5, 6
        limit 12
      ) t
    ), '[]'::jsonb),
    'payment_mix', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', t.method, 'orders', t.orders,
        'revenue', t.order_value,
        'order_value', t.order_value,
        'cash_collected', t.cash_collected,
        'amount_due', t.amount_due
      ) order by t.order_value desc) from (
        select
          case when coalesce(is_cod, false) then 'COD' else 'Online' end as method,
          count(*)::int as orders,
          -- ORDER VALUE: what the customer committed to.
          sum(total_amount)::numeric as order_value,
          -- CASH COLLECTED: 0 for an uncollected COD order, so COD is never
          -- presented as realised revenue.
          sum(amount_paid_upfront)::numeric as cash_collected,
          -- AMOUNT DUE: still to be collected at the door.
          sum(amount_due_on_delivery)::numeric as amount_due
        from public.retail_orders
        where order_type = 'retail'
          and payment_status not in ('failed','cancelled','refunded')
          and order_status not in ('cancelled','refunded')
        group by 1
      ) t
    ), '[]'::jsonb),
    'status_funnel', coalesce((
      select jsonb_agg(jsonb_build_object('status', t.status, 'count', t.count) order by t.count desc) from (
        select order_status as status, count(*)::int as count
        from public.retail_orders
        where order_type = 'retail'
          and payment_status not in ('failed','cancelled','refunded')
        group by 1
      ) t
    ), '[]'::jsonb),
    'geo', coalesce((
      select jsonb_agg(jsonb_build_object(
        'city', t.city, 'orders', t.orders, 'revenue', t.order_value,
        'cash_collected', t.cash_collected
      ) order by t.order_value desc) from (
        select coalesce(customer->>'city', '—') as city,
               count(*)::int as orders,
               sum(total_amount)::numeric as order_value,
               sum(amount_paid_upfront)::numeric as cash_collected
        from public.retail_orders
        where order_type = 'retail'
          and payment_status not in ('failed','cancelled','refunded')
          and order_status not in ('cancelled','refunded')
        group by 1
        limit 15
      ) t
    ), '[]'::jsonb),
    'repeat', jsonb_build_object(
      'returning', coalesce((
        select count(*)::int from (
          select regexp_replace(coalesce(customer->>'phone',''),'[^0-9]','','g') phone
          from public.retail_orders
          where order_type = 'retail'
            and payment_status not in ('failed','cancelled','refunded')
            and order_status not in ('cancelled','refunded')
          group by 1
          having count(*) > 1
        ) t
      ), 0),
      'customers', coalesce((
        select count(*)::int from (
          select 1 from public.retail_orders
          where order_type = 'retail'
            and payment_status not in ('failed','cancelled','refunded')
            and order_status not in ('cancelled','refunded')
          group by regexp_replace(coalesce(customer->>'phone',''),'[^0-9]','','g')
        ) t
      ), 0)
    ),
    'ts', now()
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_analytics() from public;
grant execute on function public.admin_analytics() to authenticated;
revoke execute on function public.admin_analytics() from anon;

-- -----------------------------------------------------------------------------
-- 4) customer_overview — a customer's COD orders must not inflate "spent".
--
--    `total_spent` is kept (and is what the list is sorted by) as lifetime ORDER
--    VALUE, because that is the useful customer-value metric and changing it
--    would reorder the "best customers" table. `total_paid` and `total_due` are
--    added so the cash position is explicit rather than implied.
-- -----------------------------------------------------------------------------
create or replace function public.customer_overview(p_limit integer default 200, p_offset integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_total integer;
  v_limit integer;
  v_offset integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can view customers.';
  end if;

  v_limit := greatest(1, least(500, coalesce(p_limit, 200)));
  v_offset := greatest(0, coalesce(p_offset, 0));

  select count(*) into v_total
  from (
    select regexp_replace(coalesce(customer->>'phone',''),'[^0-9]','','g') phone
    from public.retail_orders
    where order_type = 'retail'
    group by 1
  ) t;

  select jsonb_agg(row_to_json(c))
  into v_rows
  from (
    select
      regexp_replace(coalesce(customer->>'phone',''),'[^0-9]','','g') as phone,
      (array_agg(customer->>'name' order by created_at desc))[1] as name,
      (array_agg(customer->>'city' order by created_at desc))[1] as city,
      count(*)::int as order_count,
      -- total_spent = lifetime ORDER VALUE (unchanged; this is the sort key).
      coalesce(sum(case when payment_status not in ('failed','cancelled','refunded')
                        and order_status not in ('cancelled','refunded')
                    then total_amount else 0 end), 0) as total_spent,
      -- Cash actually received from this customer.
      coalesce(sum(case when payment_status not in ('failed','cancelled','refunded')
                        and order_status not in ('cancelled','refunded')
                    then amount_paid_upfront else 0 end), 0) as total_paid,
      -- Still owed at the door on their live COD orders.
      coalesce(sum(case when coalesce(is_cod, false)
                        and payment_status not in ('failed','cancelled','refunded')
                        and order_status not in ('cancelled','refunded')
                    then amount_due_on_delivery else 0 end), 0) as total_due,
      coalesce(avg(case when payment_status not in ('failed','cancelled','refunded')
                        and order_status not in ('cancelled','refunded')
                    then total_amount end), 0) as average_order,
      coalesce(sum(case when payment_status not in ('failed','cancelled','refunded')
                        and order_status not in ('cancelled','refunded')
                    then total_qty else 0 end), 0) as units_ordered,
      (max(case when coalesce(is_cod,false) then created_at end)) is not null as has_cod,
      (array_agg(ref order by created_at desc))[1] as last_ref,
      max(created_at) as last_order_at
    from public.retail_orders
    where order_type = 'retail'
    group by 1
    order by total_spent desc
    limit v_limit offset v_offset
  ) c;

  return jsonb_build_object('total', v_total, 'customers', coalesce(v_rows, '[]'::jsonb));
end;
$$;

revoke all on function public.customer_overview(integer, integer) from public;
grant execute on function public.customer_overview(integer, integer) to authenticated;
revoke execute on function public.customer_overview(integer, integer) from anon;

notify pgrst, 'reload schema';

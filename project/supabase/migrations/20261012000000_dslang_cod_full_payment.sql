-- =============================================================================
-- Migration: 20261012000000_dslang_cod_full_payment.sql
--
-- REPLACES the COD advance-payment model with FULL COD PAYMENT.
-- ADDITIVE + IDEMPOTENT. Nothing is dropped; 20260930000000_dslang_retail_cod.sql
-- is left untouched because it may already be applied remotely.
--
-- WHAT CHANGED (business decision):
--   Previously a COD order charged a FIXED ₹100 advance through Cashfree and
--   collected the balance on delivery. COD is now paid IN FULL by the delivery
--   agent: nothing is charged online, nothing is charged at checkout, and
--   Cashfree is never involved in a COD order.
--
-- CANONICAL PRICING MODEL (single source of truth — unchanged shape, new COD
-- branch):
--   sale_total = subtotal(server re-priced) - promo_discount + shipping
--   online:     payment_discount        = least(50, sale_total)   -- fixed ₹50
--               amount_paid_upfront     = sale_total - payment_discount
--               amount_due_on_delivery  = 0
--               Cashfree is invoked, charged exactly amount_paid_upfront.
--   COD:        payment_discount        = 0                      -- NO online
--               amount_paid_upfront     = 0                      -- discount, NO
--               amount_due_on_delivery  = sale_total             -- advance
--               Cashfree is NEVER invoked. 100% due at delivery.
--
-- The ₹50 difference between the two methods comes ENTIRELY from the online
-- payment-method discount. There is no COD handling fee, so the COD total is
-- never inflated above the Sale Price.
--
-- NEW payment_status value: 'cod_pending'
--   COD orders are created ALREADY CONFIRMED with nothing awaited from the
--   customer, so 'pending' (which means "waiting for an online payment that has
--   not arrived") is the wrong state for them. 'cod_pending' means "confirmed,
--   awaiting collection from the delivery agent".
--
--   Why a distinct value is load-bearing, not cosmetic:
--     * expire-stale-orders sweeps `payment_status IN ('pending','failed')`.
--       A COD order parked on 'pending' would be auto-CANCELLED and restocked
--       while it sits legitimately awaiting delivery. 'cod_pending' is outside
--       that set, so COD orders are never auto-expired. (Requirement 13: stock
--       semantics unchanged — they still restore exactly once, via the same
--       idempotent restock RPC, when an admin cancels.)
--     * Admin's "awaiting payment" banner excludes verified payments. Without a
--       COD-specific value every new COD order would be shown as a customer who
--       has not paid yet.
--     * order_status stays 'pending' for COD, which is the existing value the
--       admin New Orders tab and restock guards already understand. No new
--       order_status is invented and 'cod_partial_paid' is simply no longer
--       written by any code path.
--
-- HISTORICAL DATA (requirement: past orders must stay readable):
--   * Settled COD orders (payment_status 'success' / order_status
--     'cod_partial_paid' / 'cancelled' / 'refunded') are NOT touched. The
--     advance those customers actually paid stays on the record, and the
--     customer-facing screens still render that historical split correctly.
--   * Only COD orders that were created under the old model and NEVER paid
--     anything (payment_status = 'pending') are converted to the new model.
--     No money changed hands for those, so normalising them is lossless and
--     stops the sweep from expiring them as abandoned online checkouts.
--   * amount_paid_upfront / amount_due_on_delivery are KEPT. Online orders
--     still use them (paid now / 0 due), and historical COD orders still carry
--     the real advance they paid. Nothing is dropped.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1) create_retail_order — full COD payment.
--    Same 6-arg signature as 20260930000000, so every existing caller keeps
--    working; only the COD branch of the charge split and the inserted
--    payment_status change.
-- ----------------------------------------------------------------------------
create or replace function public.create_retail_order(
  p_customer jsonb,
  p_items jsonb,
  p_referral text default null,
  p_promo_code text default null,
  p_shipping jsonb default '{}'::jsonb,
  p_payment_method text default 'online'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_total_qty int := 0;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_shipping numeric := 0;
  v_total numeric := 0;
  v_row jsonb;
  v_i int;
  v_n int;
  v_product_id text;
  v_color_id text;
  v_size text;
  v_qty int;
  v_unit numeric;
  v_stock int;
  v_published boolean;
  v_retail_visible boolean;
  v_code text;
  v_promo jsonb;
  v_limit int;
  v_phone text;
  v_order_id uuid;
  v_ref text;
  v_payment_method text;
  v_is_cod boolean;
  v_payment_discount numeric := 0;
  v_upfront numeric := 0;
  v_due numeric := 0;
  v_payment_status text;
  v_order_status text;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'The retail order is empty.';
  end if;

  if p_customer is null
     or coalesce(p_customer->>'name', '') = ''
     or coalesce(p_customer->>'phone', '') = ''
     or coalesce(p_customer->>'address', '') = ''
     or coalesce(p_customer->>'city', '') = ''
     or coalesce(p_customer->>'state', '') = ''
     or coalesce(p_customer->>'pincode', '') = '' then
    raise exception 'Please provide the complete delivery information.';
  end if;

  -- Country is NOT collected at checkout anymore — hardcode India server-side.
  p_customer := coalesce(p_customer, '{}'::jsonb) || jsonb_build_object('country', 'India');

  v_phone := regexp_replace(coalesce(p_customer->>'phone', ''), '[^0-9]', '', 'g');

  -- Payment method — only 'cod' changes behavior; everything else is online.
  v_payment_method := lower(trim(coalesce(p_payment_method, 'online')));
  if v_payment_method <> 'cod' then
    v_payment_method := 'online';
  end if;
  v_is_cod := v_payment_method = 'cod';

  select coalesce(shipping_flat_rate, 0)
    into v_shipping
  from public.site_settings
  where id = 1;

  v_n := jsonb_array_length(p_items);
  for v_i in 0 .. v_n - 1 loop
    v_row := jsonb_array_element(p_items, v_i);
    v_product_id := v_row->>'product_id';
    v_color_id := v_row->>'color_id';
    v_size := v_row->>'size_label';
    v_qty := (v_row->>'quantity')::int;

    if v_qty is null or v_qty < 1 or v_qty > 99 then
      raise exception 'Invalid quantity for "%".', coalesce(v_row->>'name', 'item');
    end if;

    if v_product_id is null
       or v_product_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or not exists (select 1 from public.products p where p.id = v_product_id::uuid) then
      raise exception 'Unknown product "% — please refresh and try again.', coalesce(v_row->>'name', v_product_id);
    end if;

    select p.price, p.published, coalesce(p.retail_visible, true)
      into v_unit, v_published, v_retail_visible
    from public.products p
    where p.id = v_product_id::uuid;

    v_unit := coalesce(v_unit, 0);
    v_published := coalesce(v_published, false);

    if not v_published or not v_retail_visible then
      raise exception 'Product "%" is not available for purchase right now.', coalesce(v_row->>'name', '');
    end if;

    if not exists (
      select 1 from public.product_colors pc
      where pc.id = v_color_id::uuid and pc.product_id = v_product_id::uuid
    ) then
      raise exception 'Color is not valid for "%".', coalesce(v_row->>'name', '');
    end if;

    if not exists (
      select 1 from public.product_sizes ps
      where ps.product_id = v_product_id::uuid
        and ps.color_id = v_color_id::uuid
        and ps.size_label = v_size
    ) then
      raise exception 'Size % is not available for "%".', v_size, coalesce(v_row->>'name', '');
    end if;

    select ps.stock into v_stock
    from public.product_sizes ps
    where ps.product_id = v_product_id::uuid
      and ps.color_id = v_color_id::uuid
      and ps.size_label = v_size;

    v_stock := coalesce(v_stock, 0);
    if v_stock < v_qty then
      raise exception 'Only % left in % / % for "%".', v_stock, coalesce(v_row->>'color', ''), v_size, coalesce(v_row->>'name', '');
    end if;

    v_items := v_items || jsonb_build_object(
      'product_id', v_product_id,
      'name', coalesce(v_row->>'name', ''),
      'code', coalesce(v_row->>'code', ''),
      'color_id', v_color_id,
      'color', coalesce(v_row->>'color', ''),
      'color_hex', coalesce(v_row->>'color_hex', '#000000'),
      'size_label', v_size,
      'quantity', v_qty,
      'unit_price', v_unit,
      'line_total', v_unit * v_qty
    );
    v_total_qty := v_total_qty + v_qty;
    v_subtotal := v_subtotal + v_unit * v_qty;
  end loop;

  -- Promo (server-side, authoritative). A promo code is an ORDINARY discount on
  -- the Sale Price and is completely independent of the payment method: it is
  -- applied to v_subtotal above, before the payment split, so a COD order gets
  -- exactly the same promo benefit as an online one. It is NOT the ₹50 online
  -- discount and it never leaks into the COD branch below.
  v_code := upper(trim(coalesce(p_promo_code, '')));
  if v_code <> '' then
    v_promo := public.validate_promo_code(v_code, v_subtotal);
    if (v_promo->>'ok')::boolean is not true then
      raise exception '%', coalesce(v_promo->>'reason', 'This code is invalid or expired.');
    end if;

    if (v_promo->'promo'->>'per_customer_limit') is not null then
      v_limit := (v_promo->'promo'->>'per_customer_limit')::int;
      if v_limit > 0 then
        if (select count(*) from public.retail_orders
            where promo_code = v_code
              and trim(regexp_replace(coalesce(customer->>'phone', ''), '[^0-9]', '', 'g')) = v_phone
           ) >= v_limit then
          raise exception 'This code has already been used for this number.';
        end if;
      end if;
    end if;

    if (v_promo->'promo'->>'discount_type') = 'flat' then
      v_discount := least((v_promo->'promo'->>'discount_value')::numeric, v_subtotal);
    else
      v_discount := least(round(v_subtotal * (v_promo->'promo'->>'discount_value')::numeric / 100), v_subtotal);
    end if;

    if (v_promo->'promo'->>'max_discount') is not null then
      v_discount := least(v_discount, (v_promo->'promo'->>'max_discount')::numeric);
    end if;

    update public.promo_codes
      set used_count = used_count + 1
    where upper(code) = v_code;
  end if;

  -- Free shipping: merchandise subtotal >= INR 999 ships at ₹0.
  if v_subtotal >= 999 then
    v_shipping := 0;
  end if;

  v_total := v_subtotal - v_discount + v_shipping;

  -- Authoritative charge split (CANONICAL — the ONLY place totals are priced):
  --   * COD:   FULL payment on delivery. No online discount, no advance, no
  --            handling fee, and no gateway call at all. 100% of sale_total is
  --            collected by the delivery agent.
  --   * online: a fixed ₹50 payment-method discount (capped at the order value,
  --            never negative) and the entire reduced total is charged now.
  --            Nothing is collected on delivery.
  -- least() keeps both branches non-negative for tiny orders, and the is_cod
  -- branch makes it structurally impossible for a COD order to carry a nonzero
  -- payment_discount or amount_paid_upfront.
  if v_is_cod then
    v_payment_discount := 0;
    v_upfront := 0;
    v_due := greatest(round(v_total, 2), 0);
  else
    v_payment_discount := least(50, v_total);
    v_upfront := greatest(round(v_total - v_payment_discount, 2), 0);
    v_due := 0;
  end if;

  -- COD is confirmed the moment it is placed — the customer is not awaiting any
  -- payment, so it must not sit in the 'pending' state that
  -- expire-stale-orders interprets as an abandoned online checkout.
  if v_is_cod then
    v_payment_status := 'cod_pending';
    v_order_status := 'pending';
  else
    v_payment_status := 'pending';
    v_order_status := 'pending';
  end if;

  v_n := jsonb_array_length(v_items);
  for v_i in 0 .. v_n - 1 loop
    v_row := jsonb_array_element(v_items, v_i);
    update public.product_sizes
    set stock = greatest(stock - (v_row->>'quantity')::int, 0),
        available = greatest(stock - (v_row->>'quantity')::int, 0) > 0
    where product_id = (v_row->>'product_id')::uuid
      and color_id = (v_row->>'color_id')::uuid
      and size_label = v_row->>'size_label';
  end loop;

  insert into public.retail_orders (
    order_type, customer, items, total_qty, subtotal, discount, shipping,
    total_amount, payment_status, order_status, referral, promo_code, currency,
    is_cod, payment_discount, amount_paid_upfront, amount_due_on_delivery
  )
  values (
    'retail', p_customer, v_items, v_total_qty,
    v_subtotal, v_discount, v_shipping, v_total,
    v_payment_status, v_order_status,
    nullif(trim(coalesce(p_referral, '')), ''),
    nullif(v_code, ''),
    'INR',
    v_is_cod, v_payment_discount, v_upfront, v_due
  )
  returning id into v_order_id;

  v_ref := 'DSL-R-' || upper(substr(replace(v_order_id::text, '-', ''), 1, 8));
  update public.retail_orders set ref = v_ref where id = v_order_id;

  return jsonb_build_object(
    'order_id', v_order_id,
    'ref', v_ref,
    'order_type', 'retail',
    'total_qty', v_total_qty,
    'subtotal', v_subtotal,
    'discount', v_discount,
    'shipping', v_shipping,
    'total_amount', v_total,
    'payment_status', v_payment_status,
    'order_status', v_order_status,
    'is_cod', v_is_cod,
    'payment_discount', v_payment_discount,
    'amount_paid_upfront', v_upfront,
    'amount_due_on_delivery', v_due,
    'items', v_items,
    'customer', p_customer
  );
end;
$$;

revoke all on function public.create_retail_order(jsonb, jsonb, text, text, jsonb) from public;
grant execute on function public.create_retail_order(jsonb, jsonb, text, text, jsonb)
  to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2) Column comments — the advance model is gone; the numbers must stop lying.
-- ----------------------------------------------------------------------------
comment on column public.retail_orders.is_cod is
  'true = Cash on Delivery. Paid IN FULL by the delivery agent: nothing is charged online, Cashfree is never involved, and amount_due_on_delivery = total_amount.';
comment on column public.retail_orders.payment_discount is
  'Fixed ₹50 ONLINE-payment discount (the payment-method incentive), always min(50, total) for online orders and exactly 0 for COD. Never client-supplied. Distinct from `discount`, which is the promo-code discount and applies to both methods.';
comment on column public.retail_orders.amount_paid_upfront is
  'Authoritative amount charged up front via Cashfree (INR). Online: total_amount - payment_discount. COD: 0 (nothing is paid online). Never client-supplied. Retained because online orders use it and historical COD orders still record the advance they genuinely paid.';
comment on column public.retail_orders.amount_due_on_delivery is
  'Amount the delivery agent collects on delivery (INR). COD: total_amount (the full amount). Online: 0. Historical COD orders may show a lower figure — the balance left after the advance that was actually paid.';

-- ----------------------------------------------------------------------------
-- 3) Convert ONLY never-paid COD orders left over from the advance model.
--
--   Scoped deliberately:
--     * payment_status = 'pending' + is_cod -> an order created under the old
--       model where the customer never completed the ₹100 advance, so no money
--       was taken. Converting it to full COD is lossless.
--     * 'success' (advance paid), 'failed', 'cancelled', 'refunded', and any
--       order already at 'cod_pending' are left completely untouched, so the
--       record of what actually happened is preserved and historical orders
--       stay readable.
--
--   Without this, those orders would remain on 'pending' and be auto-cancelled
--   and restocked by the expire-stale-orders sweep.
--
--   Every eligible pending COD order receives the new production contract:
--     amount_paid_upfront    = 0
--     amount_due_on_delivery = greatest(total_amount, 0)
--     payment_discount       = 0
--     payment_status         = 'cod_pending'
-- ----------------------------------------------------------------------------
update public.retail_orders
set amount_paid_upfront = 0,
    amount_due_on_delivery = greatest(total_amount, 0),
    payment_discount = 0,
    payment_status = 'cod_pending',
    updated_at = now()
where is_cod
  and payment_status = 'pending';

-- ----------------------------------------------------------------------------
-- 4) Support index. The admin New Orders tab and the "awaiting payment" badge
--    both filter on payment_status; COD is now a first-class value there.
-- ----------------------------------------------------------------------------
create index if not exists idx_retail_orders_payment_status
  on public.retail_orders (payment_status);

-- ----------------------------------------------------------------------------
-- 5) convert_retail_order_to_cod — used ONLY when a shopper switches payment
--    method at checkout after an unpaid ONLINE order already exists.
--
--    Why this exists. create_retail_order() reserves stock, so by the time an
--    order exists the inventory is already spoken for. If the shopper then
--    switches to COD we must NOT simply call create_retail_order() again: that
--    would reserve the same stock twice and leave the abandoned order holding
--    stock until the expiry sweep runs. Reusing the existing order instead is
--    also wrong — its row says is_cod = false, so confirming it as COD would
--    produce an order that is invisible in admin New Orders and gets
--    auto-expired by expire-stale-orders.
--
--    This re-prices the EXISTING order in place, so the single stock
--    reservation is preserved and nothing is double-booked:
--      payment_discount        -> 0      (the online incentive no longer applies)
--      amount_paid_upfront     -> 0      (nothing is charged online)
--      amount_due_on_delivery  -> total  (the agent collects the full amount)
--      payment_status          -> 'cod_pending'
--      payment_id/provider     -> null   (no gateway session may be verified)
--    total_amount, subtotal, shipping, discount and every order item are LEFT
--    ALONE — the promo discount and sale total the customer saw do not change
--    when the payment method does.
--
--    Guards: possession (ref + 10-digit phone, identical to track_lookup_order
--    so this endpoint can never be used to probe someone else's order), and
--    only an order that is still unpaid, unshipped, unrestocked and online.
--    A paid, processing, shipped or already-COD order is refused outright.
--
--    Residual risk, accepted deliberately: if a Cashfree session was already
--    created for this order and the shopper pays it in another tab, clearing
--    payment_id means that payment can no longer be auto-verified. The window
--    is tiny (the gateway handoff navigates away from /checkout immediately,
--    and api/cashfree-order.ts refuses to open a session for COD), and the
--    order is still fully visible to admin for manual reconciliation.
-- ----------------------------------------------------------------------------
create or replace function public.convert_retail_order_to_cod(p_ref text, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.retail_orders%rowtype;
  v_stored_phone text;
  v_caller_phone text;
begin
  -- Lock the row for the duration so two concurrent switches cannot both pass
  -- the guards below.
  select * into v_row
  from public.retail_orders
  where ref = p_ref
  for update;

  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  -- Possession gate. A wrong phone must be indistinguishable from a bad ref.
  v_stored_phone := regexp_replace(coalesce(v_row.customer ->> 'phone', ''), '\D', '', 'g');
  v_caller_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if v_caller_phone <> '' and v_stored_phone = v_caller_phone then
    null;
  else
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  if v_row.is_cod then
    raise exception 'This order is already Cash on Delivery.';
  end if;
  if v_row.payment_status not in ('pending', 'failed') then
    raise exception 'This order has already been paid and can no longer be changed.';
  end if;
  if v_row.order_status <> 'pending' then
    raise exception 'This order is already being processed.';
  end if;
  if v_row.stock_restored_at is not null then
    raise exception 'This order was already cancelled. Please place a new order.';
  end if;

  update public.retail_orders
  set is_cod = true,
      payment_discount = 0,
      amount_paid_upfront = 0,
      amount_due_on_delivery = greatest(v_row.total_amount, 0),
      payment_status = 'cod_pending',
      payment_id = null,
      payment_provider = null,
      paid_at = null,
      txn_id = null,
      updated_at = now()
  where id = v_row.id;

  return jsonb_build_object(
    'order_id', v_row.id,
    'ref', v_row.ref,
    'order_type', 'retail',
    'total_qty', v_row.total_qty,
    'subtotal', v_row.subtotal,
    'discount', v_row.discount,
    'shipping', v_row.shipping,
    'total_amount', v_row.total_amount,
    'payment_status', 'cod_pending',
    'order_status', v_row.order_status,
    'is_cod', true,
    'payment_discount', 0,
    'amount_paid_upfront', 0,
    'amount_due_on_delivery', greatest(v_row.total_amount, 0),
    'items', v_row.items,
    'customer', v_row.customer
  );
end;
$$;

revoke all on function public.convert_retail_order_to_cod(text, text) from public;
grant execute on function public.convert_retail_order_to_cod(text, text)
  to anon, authenticated, service_role;

comment on function public.convert_retail_order_to_cod(text, text) is
  'Re-prices an existing, unpaid ONLINE retail order as full COD in place, preserving its single stock reservation. Called when a shopper switches payment method at checkout. Refuses paid, processing, restocked or already-COD orders, and requires the customer 10-digit phone as a possession proof.';

notify pgrst, 'reload schema';

-- =============================================================================
-- Migration: 20260930000000_dslang_retail_cod.sql
--
-- Cash on Delivery (COD) for retail orders + "country = India" hardcode.
--
-- WHAT:
--   * New retail_orders columns:
--       is_cod                boolean (true = Cash on Delivery)
--       payment_discount      numeric — the FIXED ₹50 online-payment discount
--                             applied ONLY to online orders (0 for COD). This
--                             is the "Win-the-Net" style incentive: pay online
--                             and save ₹50 off the Sale Price.
--       amount_paid_upfront   numeric — the amount actually charged up front
--                             via Cashfree:
--                               online -> Sale Price total − payment_discount
--                                        (i.e. total_amount − ₹50)
--                               COD     -> least(100, total_amount) — a FIXED
--                                        ₹100 advance (NOT a percentage),
--                                        capped at the order value so it never
--                                        exceeds the total
--       amount_due_on_delivery numeric — balance collected from the courier on
--                             delivery (0 for pure online orders; for COD =
--                             total_amount − amount_paid_upfront)
--   * create_retail_order gains a trailing `p_payment_method text default
--     'online'` argument ('online' | 'cod'). Every amount is computed
--     AUTHORITATIVELY server-side from the re-priced Sale Price total — the
--     client never sends prices, discounts, or payable amounts.
--   * create_retail_order now HARDCODES `country = 'India'` into the stored and
--     returned customer object (the checkout no longer collects a country).
--   * track_lookup_order returns the safe pricing fields (is_cod + the three
--     amounts) so the public Track Order page can show the same split.
--
-- CANONICAL PRICING MODEL (single source of truth):
--   sale_total = subtotal(server re-priced) − promo_discount + shipping
--   COD:        payment_discount = 0
--               amount_paid_upfront = least(100, sale_total) (FIXED ₹100
--                                     advance, capped at the order value —
--                                     ₹80 order → ₹80 advance)
--               amount_due_on_delivery = sale_total − amount_paid_upfront
--               customer pays the FULL Sale Price (₹1,000 on ₹1,000)
--   online:     payment_discount = least(50, sale_total)
--               amount_paid_upfront = sale_total − payment_discount
--               amount_due_on_delivery = 0
--               customer pays ₹950 on a ₹1,000 Sale Price
--   Cashfree is ALWAYS charged amount_paid_upfront and EVERY verification
--   (cashfree-status / cashfree-webhook / expire-stale-orders) compares the
--   gateway amount against amount_paid_upfront — never a client-supplied
--   number. A negative/zero online total, a duplicate ₹50, or a ₹50 applied to
--   COD are structurally impossible (least() guard + is_cod branch).
--
-- New order_status value used by the COD flow (plain text, no DDL):
--     'cod_partial_paid' — the advance is verified; the remaining balance is
--     collected on delivery. Set server-side by cashfree-status / cashfree-
--     webhook / expire-stale-orders when an is_cod order's advance succeeds.
--
-- COD REFUSED-PARCEL POLICY (business decision, 2026-09-21; advance made a
-- fixed ₹100 on 2026-09-22):
--   * Customer-caused RTO / refused delivery: the ₹100 advance (capped at the
--     order value — e.g. ₹80 on a ₹80 order) is FORFEITED as a restocking fee
--     (no refund). Admin sets
--     order_status='cancelled'; no Cashfree refund is issued. payment_status
--     stays 'success' — stock is intentionally NOT auto-restocked by
--     restock_retail_order_items (skip on 'success'); the returned item must be
--     re-added to stock manually if sellable.
--   * DSLANG-caused problems (wrong/damaged/defective product) are NOT subject
--     to the forfeiture rule — they follow the existing refund flow.
--
-- Backward compatible + idempotent: additive columns, create-or-replace
-- functions with the same names; the new trailing RPC argument has a default,
-- so every existing caller (storefront checkout, test scripts) keeps working
-- unchanged. `p_payment_method` is only ever sent as 'cod' by the new checkout.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1) COD columns on retail_orders.
-- ----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists is_cod boolean not null default false;

alter table public.retail_orders
  add column if not exists payment_discount numeric not null default 0;

alter table public.retail_orders
  add column if not exists amount_paid_upfront numeric not null default 0;

alter table public.retail_orders
  add column if not exists amount_due_on_delivery numeric not null default 0;

comment on column public.retail_orders.is_cod is
  'true = Cash on Delivery order. A fixed ₹100 advance (capped at the order value) is paid via Cashfree; the balance is collected on delivery.';
comment on column public.retail_orders.payment_discount is
  'Fixed ₹50 online-payment discount, applied ONLY to online orders (0 for COD). min(50, total_amount); never client-supplied. Legacy online orders predating this column have 0 here.';
comment on column public.retail_orders.amount_paid_upfront is
  'Authoritative amount charged up front via Cashfree (INR). Online: total_amount - payment_discount. COD: min(100, total_amount) — fixed ₹100 advance, never more than the order value. Never client-supplied.';
comment on column public.retail_orders.amount_due_on_delivery is
  'Balance to be collected on delivery (INR). COD: total_amount - amount_paid_upfront. Online: 0.';

-- ----------------------------------------------------------------------------
-- 2) create_retail_order — p_payment_method + COD split + country hardcode.
--    Same signature as before PLUS the trailing p_payment_method (default
--    'online'), so existing callers are unaffected.
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

  -- Promo (server-side, authoritative).
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
  --   * COD:   the customer pays the FULL Sale Price. A FIXED ₹100 advance
  --            (2026-09-22 — NOT a percentage; replaces the old
--            percentage-of-total advance, min ₹100)
  --            is charged now via Cashfree, capped at the order value so a
  --            low-value order never pays more than its total (₹80 order → ₹80
  --            advance / ₹0 on delivery); the balance is collected on
  --            delivery. NO online discount applies to COD.
  --   * online: a fixed ₹50 "Win-the-Net" discount (capped at the order value,
  --            never negative) is applied to the Sale Price; the entire
  --            reduced total is charged now. Nothing is collected on delivery.
  if v_is_cod then
    v_payment_discount := 0;
    v_upfront := least(100, v_total);
    v_due := round(v_total - v_upfront, 2);
  else
    v_payment_discount := least(50, v_total);
    v_upfront := v_total - v_payment_discount;
    v_due := 0;
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
    v_subtotal, v_discount, v_shipping, v_total, 'pending', 'pending',
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
    'payment_status', 'pending',
    'order_status', 'pending',
    'is_cod', v_is_cod,
    'payment_discount', v_payment_discount,
    'amount_paid_upfront', v_upfront,
    'amount_due_on_delivery', v_due,
    'items', v_items,
    'customer', p_customer
  );
end;
$$;

revoke all on function public.create_retail_order(jsonb, jsonb, text, text, jsonb, text) from public;
grant execute on function public.create_retail_order(jsonb, jsonb, text, text, jsonb, text)
  to anon, authenticated, service_role;

-- Keep the 5-arg overload revocable-grantable for any caller pinned to the old
-- signature (PostgREST resolves the 5-arg form to the new function anyway).
revoke all on function public.create_retail_order(jsonb, jsonb, text, text, jsonb) from public;
grant execute on function public.create_retail_order(jsonb, jsonb, text, text, jsonb)
  to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3) track_lookup_order — expose safe COD fields to the public Track page.
-- ----------------------------------------------------------------------------
create or replace function public.track_lookup_order(
  p_ref text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
  v_phone text;
  v_row public.retail_orders%rowtype;
  v_items jsonb;
  v_item jsonb;
  v_safe jsonb := '[]'::jsonb;
begin
  v_ref := upper(trim(coalesce(p_ref, '')));
  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');

  if v_ref = '' or v_phone = '' then
    return jsonb_build_object('ok', false, 'reason', 'Enter your order reference and phone number.');
  end if;

  select * into v_row
  from public.retail_orders
  where upper(coalesce(ref, '')) = upper(v_ref)
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Order not found. Check the order reference and try again.');
  end if;

  -- Gate: the phone must match the order's customer phone.
  if regexp_replace(coalesce(v_row.customer->>'phone', ''), '[^0-9]', '', 'g') <> v_phone then
    return jsonb_build_object('ok', false, 'reason', 'This order reference and phone number do not match.');
  end if;

  -- Build a safe line-item array: name/code/color/size/qty/line_total only.
  v_items := coalesce(v_row.items, '[]'::jsonb);
  for v_item in select * from jsonb_array_elements(v_items)
  loop
    v_safe := v_safe || jsonb_build_object(
      'name', coalesce(v_item->>'name', ''),
      'code', coalesce(v_item->>'code', ''),
      'color', coalesce(v_item->>'color', ''),
      'size_label', coalesce(v_item->>'size_label', ''),
      'quantity', coalesce((v_item->>'quantity')::int, 0),
      'line_total', coalesce((v_item->>'line_total')::numeric, 0)
    );
  end loop;

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'ref', v_row.ref,
      'order_status', v_row.order_status,
      'payment_status', v_row.payment_status,
      'created_at', v_row.created_at,
      'total_qty', v_row.total_qty,
      'subtotal', v_row.subtotal,
      'discount', v_row.discount,
      'shipping', v_row.shipping,
      'total_amount', v_row.total_amount,
      'is_cod', v_row.is_cod,
      'payment_discount', v_row.payment_discount,
      'amount_paid_upfront', v_row.amount_paid_upfront,
      'amount_due_on_delivery', v_row.amount_due_on_delivery,
      'items', v_safe
    )
  );
end;
$$;

revoke all on function public.track_lookup_order(text, text) from public;
grant execute on function public.track_lookup_order(text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
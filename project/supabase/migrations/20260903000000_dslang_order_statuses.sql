-- =============================================================================
-- DSLANG order statuses + paid snapshot (2026-09-03).
--
-- 1. Adds retail_orders.paid_at (server-set payment-verification timestamp).
-- 2. create_retail_order now opens with order_status = 'pending' (aligned with
--    the DSLANG order-status enum) and returns the full order snapshot
--    (items + customer) so the confirmation screen never reconstructs prices.
--
-- Payment statuses: pending | success | failed | cancelled | refunded
-- Order statuses:   pending | processing | shipped | delivered | cancelled | refunded
-- =============================================================================

alter table public.retail_orders
  add column if not exists paid_at timestamptz;

comment on column public.retail_orders.paid_at is
  'Verified payment timestamp — set server-side only, when payment_status becomes ''success''.';

-- ----------------------------------------------------------------------------
-- create_retail_order — enum-aligned order_status + snapshot in the result.
-- ----------------------------------------------------------------------------
create or replace function public.create_retail_order(
  p_customer jsonb,
  p_items jsonb,
  p_referral text default null,
  p_promo_code text default null,
  p_shipping jsonb default '{}'::jsonb
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

  v_phone := regexp_replace(coalesce(p_customer->>'phone', ''), '[^0-9]', '', 'g');

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

  v_total := v_subtotal - v_discount + v_shipping;

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
    total_amount, payment_status, order_status, referral, promo_code, currency
  )
  values (
    'retail', coalesce(p_customer, '{}'::jsonb), v_items, v_total_qty,
    v_subtotal, v_discount, v_shipping, v_total, 'pending', 'pending',
    nullif(trim(coalesce(p_referral, '')), ''),
    nullif(v_code, ''),
    'INR'
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
    'items', v_items,
    'customer', coalesce(p_customer, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.create_retail_order(jsonb, jsonb, text, text, jsonb) from public;
grant execute on function public.create_retail_order(jsonb, jsonb, text, text, jsonb)
  to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Reload the PostgREST schema cache so new tables/functions are visible
-- immediately (avoids "Could not find ... in the schema cache" errors).
-- Safe: run as superuser during migration.
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';
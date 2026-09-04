-- =============================================================================
-- DSLANG retail / D2C migration (single self-sufficient file).
--
-- Adds the retail (D2C) channel on top of the existing wholesale system WITHOUT
-- touching the wholesale data model:
--
--   * products.price  -> the RETAIL price (previously only a legacy column),
--     products.mrp    -> compare-at price shown for retail.
--   * products.retail_visible -> retail-channel visibility gate (published
--     remains the wholesale/general visibility used by the existing storefront).
--   * site_settings gains the central feature flag `wholesale_pricing_enabled`
--     (default OFF -> wholesale prices hidden from customers) and
--     `shipping_flat_rate` used by retail checkout.
--   * retail_orders table + create_retail_order RPC: server-side validated
--     retail orders with product/color/size/quantity, server-side priced from
--     products.price, stock decrement, payment status order_type = retail,
--     optional influencer referral.
--
-- Wholesale keeps the existing orders table + create_wholesale_order RPC and is
-- NOT modified. Wholesale ordering does NOT decrement product_sizes.stock —
-- D2C inventory is consumed only by retail orders (shared-variant design made
-- explicit: D2C sales eat the per-color/size stock; wholesale availability is
-- product-level and ignores variant stock as before).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. products: explicit retail channel.
-- ----------------------------------------------------------------------------
alter table public.products
  add column if not exists retail_visible boolean not null default true;

comment on column public.products.retail_visible is
  'Retail (D2C) visibility gate. published still gates the wholesale/general storefront.';

-- For legacy rows created with price = 0, seed a sane retail price from the
-- wholesale 50+ tier (50-60% margin) when a wholesale price exists so retail
-- works out of the box. Admin is the only place pricing is edited afterwards.
update public.products
set price = greatest(round((coalesce(wholesale_price_50, 0) * 2.0) / 5) * 5, 199)
where coalesce(price, 0) = 0 and coalesce(wholesale_price_50, 0) > 0;

-- ----------------------------------------------------------------------------
-- 2. site_settings: retail feature flag + shipping config.
-- ----------------------------------------------------------------------------
alter table public.site_settings
  add column if not exists wholesale_pricing_enabled boolean not null default false,
  add column if not exists shipping_flat_rate integer not null default 0;

comment on column public.site_settings.wholesale_pricing_enabled is
  'Central master switch for customer-facing wholesale pricing. When false (default)
   wholesale prices are never rendered. When true, 50/100+ tier pricing becomes visible.';

-- ----------------------------------------------------------------------------
-- 3. retail_orders: retail-specific order storage, cleanly separated from the
--    wholesale `orders` table.
-- ----------------------------------------------------------------------------
create table if not exists public.retail_orders (
  id uuid primary key default gen_random_uuid(),
  ref text,
  order_type text not null default 'retail',
  customer jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  total_qty integer not null default 0,
  subtotal numeric not null default 0,
  shipping numeric not null default 0,
  total_amount numeric not null default 0,
  payment_status text not null default 'pending',
  order_status text not null default 'new',
  referral text,
  created_at timestamptz not null default now()
);

alter table public.retail_orders enable row level security;

-- Public visitors may place a retail order (no account required for
-- influencer-driven D2C purchases).
drop policy if exists "retail_orders_insert_public" on public.retail_orders;
create policy "retail_orders_insert_public"
  on public.retail_orders for insert
  to anon, authenticated
  with check (true);

-- Orders are only readable by the authorized admin.
drop policy if exists "retail_orders_select_admin" on public.retail_orders;
create policy "retail_orders_select_admin"
  on public.retail_orders for select
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

create index if not exists idx_retail_orders_created_at on public.retail_orders (created_at desc);
create index if not exists idx_retail_orders_referral on public.retail_orders (referral);

-- ----------------------------------------------------------------------------
-- 4. create_retail_order RPC.
--
-- SECURITY DEFINER so it can read products / product_colors / product_sizes /
-- site_settings regardless of RLS. It NEVER trusts the client prices: every
-- line is re-priced from products.price server-side, the final amount is
-- recomputed, stock is validated and decremented, and the order is stored with
-- a retail order reference. Payment stays 'pending' until an external gateway
-- confirms (no fake success).
-- ----------------------------------------------------------------------------
create or replace function public.create_retail_order(
  p_customer jsonb,
  p_items jsonb,
  p_referral text default null,
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

  select coalesce(shipping_flat_rate, 0)
    into v_shipping
  from public.site_settings
  where id = 1;

  -- Pass 1: validate every line (product / color / size / quantity / stock).
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
      raise exception 'Product "%" is not available for retail purchase right now.', coalesce(v_row->>'name', '');
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

  v_total := v_subtotal + v_shipping;

  -- Pass 2: decrement stock AFTER every validation passed.
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
    order_type, customer, items, total_qty, subtotal, shipping,
    total_amount, payment_status, order_status, referral
  )
  values (
    'retail', coalesce(p_customer, '{}'::jsonb), v_items, v_total_qty,
    v_subtotal, v_shipping, v_total, 'pending', 'new',
    nullif(trim(coalesce(p_referral, '')), '')
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
    'shipping', v_shipping,
    'total_amount', v_total,
    'payment_status', 'pending'
  );
end;
$$;

revoke all on function public.create_retail_order(jsonb, jsonb, text, jsonb) from public;
grant execute on function public.create_retail_order(jsonb, jsonb, text, jsonb)
  to anon, authenticated, service_role;
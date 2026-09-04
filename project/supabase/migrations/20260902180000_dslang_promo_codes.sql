-- =============================================================================
-- DSLANG promo codes + server-side discounting.
--
-- Promo codes are validated ONLY server-side: the browser never decides a
-- discount. The drawer/checkout surface the discount for display, checkout
-- submits the promo CODE, and create_retail_order re-derives the discount
-- from the promo_codes table and stores the discounted amount.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. retail_orders: store the applied discount.
-- ----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists discount numeric not null default 0;

comment on column public.retail_orders.discount is
  'Promo discount applied server-side (subtotal - discount + shipping = total).';

-- ----------------------------------------------------------------------------
-- 2. promo_codes.
-- ----------------------------------------------------------------------------
create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  label text not null default '',
  discount_type text not null default 'percent' check (discount_type in ('percent', 'flat')),
  discount_value numeric not null default 0,
  active boolean not null default true,
  max_uses integer,
  used_count integer not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists promo_codes_code_unique on public.promo_codes (lower(code));

alter table public.promo_codes enable row level security;

-- Codes are managed exclusively by the admin.
drop policy if exists "promo_codes_admin_select" on public.promo_codes;
create policy "promo_codes_admin_select"
  on public.promo_codes for select
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

drop policy if exists "promo_codes_admin_insert" on public.promo_codes;
create policy "promo_codes_admin_insert"
  on public.promo_codes for insert
  to authenticated
  with check (exists (select 1 from public.admin_users where user_id = auth.uid()));

drop policy if exists "promo_codes_admin_update" on public.promo_codes;
create policy "promo_codes_admin_update"
  on public.promo_codes for update
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

drop policy if exists "promo_codes_admin_delete" on public.promo_codes;
create policy "promo_codes_admin_delete"
  on public.promo_codes for delete
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- 3. validate_promo_code RPC (security definer — ignores RLS, safe).
-- Returns the promo terms when valid, NULL otherwise.
-- ----------------------------------------------------------------------------
create or replace function public.validate_promo_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v record;
begin
  v_code := upper(trim(coalesce(p_code, '')));
  if v_code = '' then
    return null;
  end if;

  select * into v
  from public.promo_codes
  where upper(code) = v_code
    and active
    and (max_uses is null or used_count < max_uses)
    and (expires_at is null or expires_at > now())
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'code', v.code,
    'label', coalesce(v.label, ''),
    'discount_type', v.discount_type,
    'discount_value', v.discount_value
  );
end;
$$;

revoke all on function public.validate_promo_code(text) from public;
grant execute on function public.validate_promo_code(text)
  to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. create_retail_order: now discount-aware (extra p_promo_code param).
-- The exact same validation as before plus a server-side discount computed
-- from the promo table (and a used_count increment) when a code is supplied.
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
  v_promo jsonb;
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

  -- Promo discount (server-side, authoritative).
  if coalesce(p_promo_code, '') <> '' then
    v_promo := public.validate_promo_code(p_promo_code);
    if v_promo is null then
      raise exception 'Invalid or expired promo code.';
    end if;
    if v_promo->>'discount_type' = 'flat' then
      v_discount := least((v_promo->>'discount_value')::numeric, v_subtotal);
    else
      v_discount := least(round(v_subtotal * (v_promo->>'discount_value')::numeric / 100), v_subtotal);
    end if;
    update public.promo_codes
      set used_count = used_count + 1
    where upper(code) = upper(coalesce(p_promo_code, ''));
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
    total_amount, payment_status, order_status, referral
  )
  values (
    'retail', coalesce(p_customer, '{}'::jsonb), v_items, v_total_qty,
    v_subtotal, v_discount, v_shipping, v_total, 'pending', 'new',
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
    'discount', v_discount,
    'shipping', v_shipping,
    'total_amount', v_total,
    'payment_status', 'pending'
  );
end;
$$;

revoke all on function public.create_retail_order(jsonb, jsonb, text, text, jsonb) from public;
grant execute on function public.create_retail_order(jsonb, jsonb, text, text, jsonb)
  to anon, authenticated, service_role;
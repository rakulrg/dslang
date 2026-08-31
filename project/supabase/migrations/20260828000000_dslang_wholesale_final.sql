-- =============================================================================
-- DSLANG wholesale final migration (single self-sufficient file).
--
-- Apply this file (and only this file) in the Supabase SQL editor for the
-- production database. It is idempotent and REPLACES the earlier wholesale
-- migrations (20260827000000 -> 20260827030000).
--
-- What it changes:
--   * products: adds the ONE wholesale pricing pair the app uses —
--       wholesale_price_50 (50-99 PCS price) and wholesale_price_100 (100+
--       PCS price) — plus published / new_drop / moq / gsm / wash / print_type /
--       details / available_sizes. If a legacy price50 / price100 column ever
--       exists, its values are copied over and the old columns are dropped so
--       the live schema ends with only wholesale_price_50 / wholesale_price_100.
--   * hero_slides: adds cta_text / cta_url.
--   * site_settings: single-row admin control (announcement, WhatsApp number,
--       MOQ, dispatch, pack sizing, global wholesale price fallbacks).
--   * orders + create_wholesale_order RPC: server-side validated wholesale
--       orders that re-price every line from the database using the product's
--       wholesale_price_50 / wholesale_price_100 columns (never the client).
--   * Ensures the first signed-up user is an admin so write access to
--       products / site_settings / orders works from day one (writes require
--       membership in admin_users).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Products: wholesale pricing + publishing + specs.
-- ----------------------------------------------------------------------------
alter table public.products
  add column if not exists wholesale_price_50 integer,
  add column if not exists wholesale_price_100 integer,
  add column if not exists published boolean not null default true,
  add column if not exists new_drop boolean not null default false,
  add column if not exists moq integer not null default 50,
  add column if not exists gsm integer,
  add column if not exists wash text,
  add column if not exists print_type text,
  add column if not exists details text,
  add column if not exists available_sizes text[] not null default array['M','L','XL'];

-- Migrate legacy price50/price100 columns (if any environment still has them)
-- into the canonical wholesale_price_50 / wholesale_price_100 columns, then
-- drop the legacy columns so the final schema has a single pricing pair.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'price50'
  ) then
    update public.products
    set wholesale_price_50 = price50
    where wholesale_price_50 is null and price50 is not null;
    alter table public.products drop column price50;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'price100'
  ) then
    update public.products
    set wholesale_price_100 = price100
    where wholesale_price_100 is null and price100 is not null;
    alter table public.products drop column price100;
  end if;
end $$;

-- Seed wholesale pricing from the legacy retail price so existing products are
-- orderable after migration. Seed values only — the admin panel is the only
-- place pricing is edited from now on.
update public.products
set wholesale_price_50 = round((price * 0.3) / 5) * 5
where coalesce(wholesale_price_50, 0) <= 0 and coalesce(price, 0) > 0;

update public.products
set wholesale_price_100 = greatest(wholesale_price_50 - 10, round((wholesale_price_50 * 0.96) / 5) * 5)
where coalesce(wholesale_price_100, 0) <= 0 and wholesale_price_50 is not null and wholesale_price_50 > 0;

-- Ensure every product has usable spec values.
update public.products
set gsm = coalesce((regexp_match(coalesce(fabric, ''), '(\d+)\s*GSM'))[1]::integer, 240)
where gsm is null;

update public.products
set wash = 'Optic Wash'
where wash is null or wash = '';

-- ----------------------------------------------------------------------------
-- 2. hero_slides: CTA fields read by the homepage hero.
-- ----------------------------------------------------------------------------
alter table public.hero_slides
  add column if not exists cta_text text,
  add column if not exists cta_url text;

-- ----------------------------------------------------------------------------
-- 3. site_settings: single-row admin control of the wholesale system.
-- ----------------------------------------------------------------------------
create table if not exists public.site_settings (
  id integer primary key check (id = 1),
  announcement_text text not null default 'SAME DAY DISPATCH • FOR RESELLERS & WHOLESALE ONLY • PAN INDIA DELIVERY',
  announcement_active boolean not null default true,
  whatsapp_number text not null default '919944676178',
  default_moq integer not null default 50,
  dispatch_note text not null default 'Same Day Dispatch',
  delivery_note text not null default 'Pan India',
  min_order_quantity integer not null default 48,
  per_color_minimum integer not null default 6,
  pack_size integer not null default 6,
  pack_m integer not null default 2,
  pack_l integer not null default 2,
  pack_xl integer not null default 2,
  wholesale_price_50 integer,
  wholesale_price_100 integer,
  updated_at timestamptz not null default now()
);

alter table public.site_settings
  add column if not exists min_order_quantity integer not null default 48,
  add column if not exists per_color_minimum integer not null default 6,
  add column if not exists pack_size integer not null default 6,
  add column if not exists pack_m integer not null default 2,
  add column if not exists pack_l integer not null default 2,
  add column if not exists pack_xl integer not null default 2,
  add column if not exists wholesale_price_50 integer,
  add column if not exists wholesale_price_100 integer;

insert into public.site_settings (id) values (1) on conflict (id) do nothing;

alter table public.site_settings enable row level security;

drop policy if exists "site_settings_read" on public.site_settings;
create policy "site_settings_read"
  on public.site_settings for select
  to authenticated, anon
  using (true);

drop policy if exists "site_settings_write_admin" on public.site_settings;
create policy "site_settings_write_admin"
  on public.site_settings for all
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users where user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- 4. Orders: stored wholesale orders with the full color/size breakdown.
-- ----------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  ref text,
  lines jsonb not null default '[]'::jsonb,
  total_qty integer not null default 0,
  total_amount numeric not null default 0,
  seller jsonb not null default '{}'::jsonb,
  status text not null default 'new',
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;

drop policy if exists "orders_insert_public" on public.orders;
create policy "orders_insert_public"
  on public.orders for insert
  to authenticated, anon
  with check (true);

-- Orders are only readable by the authorized admin (via the admin dashboard).
drop policy if exists "orders_select_admin" on public.orders;
create policy "orders_select_admin"
  on public.orders for select
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

create index if not exists idx_orders_created_at on public.orders (created_at desc);

-- ----------------------------------------------------------------------------
-- 5. Products write access requires admin membership. Re-asserted here so this
--    file is self-sufficient on a fresh schema.
-- ----------------------------------------------------------------------------
drop policy if exists "products_write_admin" on public.products;
create policy "products_write_admin"
  on public.products for all
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users where user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- 6. Server-side validated order creation RPC.
--
-- SECURITY DEFINER so it can read products / product_colors / site_settings
-- regardless of RLS. It IGNORES any client-supplied pricing and re-prices every
-- line from the database using the product's wholesale_price_50 /
-- wholesale_price_100 columns (falling back to the admin-controlled global
-- site defaults), and validates that the product exists, is published, the
-- color really belongs to it, whole packs are >= 0 and the total meets the
-- order minimum.
-- ----------------------------------------------------------------------------
create or replace function public.create_wholesale_order(
  p_lines jsonb,
  p_seller jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack_size int := 6;
  v_pack_m int := 2;
  v_pack_l int := 2;
  v_pack_xl int := 2;
  v_min_qty int := 48;
  v_global_50 numeric := 0;
  v_global_100 numeric := 0;

  v_validated jsonb := '[]'::jsonb;
  v_total_qty int := 0;
  v_total_amount numeric := 0;
  v_row jsonb;
  v_packs int;
  v_product_id text;
  v_color text;
  v_product_qty int;
  v_prod_price50 numeric;
  v_prod_price100 numeric;
  v_published boolean;
  v_unit numeric;
  v_i int;
  v_n int;
  v_order_id uuid;
  v_ref text;
begin
  select coalesce(pack_size, 6), coalesce(pack_m, 2), coalesce(pack_l, 2),
         coalesce(pack_xl, 2), coalesce(min_order_quantity, 48)
    into v_pack_size, v_pack_m, v_pack_l, v_pack_xl, v_min_qty
  from public.site_settings
  where id = 1;

  if v_pack_m + v_pack_l + v_pack_xl <> v_pack_size then
    raise exception 'Invalid pack configuration — M + L + XL must equal the pack size.';
  end if;

  select coalesce(wholesale_price_50, 0), coalesce(wholesale_price_100, 0)
    into v_global_50, v_global_100
  from public.site_settings
  where id = 1;

  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Invalid wholesale order payload.';
  end if;

  -- Pass 1: validate whole packs and derive the fixed M/L/XL split server-side.
  v_n := jsonb_array_length(p_lines);
  for v_i in 0 .. v_n - 1 loop
    v_row := jsonb_array_element(p_lines, v_i);
    v_packs := (v_row ->> 'packs')::int;

    if v_packs is null or v_packs < 0 then
      raise exception 'Invalid pack quantity on "%" (%).', coalesce(v_row->>'color', '?'), coalesce(v_row->>'name', '?');
    end if;
    if v_packs > 0 then
      v_validated := v_validated || jsonb_build_object(
        'product_id', coalesce(v_row->>'product_id', ''),
        'name', coalesce(v_row->>'name', ''),
        'code', coalesce(v_row->>'code', ''),
        'color', coalesce(v_row->>'color', ''),
        'color_hex', coalesce(v_row->>'color_hex', '#000000'),
        'image', coalesce(v_row->>'image', ''),
        'slug', coalesce(v_row->>'slug', ''),
        'packs', v_packs,
        'm', v_packs * v_pack_m,
        'l', v_packs * v_pack_l,
        'xl', v_packs * v_pack_xl,
        'qty', v_packs * v_pack_size
      );
      v_total_qty := v_total_qty + v_packs * v_pack_size;
    end if;
  end loop;

  if v_n = 0 or v_total_qty = 0 then
    raise exception 'Wholesale order is empty.';
  end if;

  if v_total_qty < v_min_qty then
    raise exception 'Minimum wholesale order is % PCS (currently % PCS).', v_min_qty, v_total_qty;
  end if;

  -- Pass 2: server-side sanity checks + pricing sourced from the database.
  v_n := jsonb_array_length(v_validated);
  for v_i in 0 .. v_n - 1 loop
    v_row := jsonb_array_element(v_validated, v_i);
    v_product_id := v_row->>'product_id';
    v_color := v_row->>'color';

    if v_product_id is null
       or v_product_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or not exists (select 1 from public.products p2 where p2.id = v_product_id::uuid) then
      raise exception 'Unknown product "%" — please refresh and try again.', coalesce(v_row->>'name', v_product_id);
    end if;

    select p2.wholesale_price_50, p2.wholesale_price_100, p2.published
      into v_prod_price50, v_prod_price100, v_published
    from public.products p2
    where p2.id = v_product_id::uuid;
    v_prod_price50 := coalesce(v_prod_price50, 0);
    v_prod_price100 := coalesce(v_prod_price100, 0);
    v_published := coalesce(v_published, false);

    if not v_published then
      raise exception 'Product "%" is not available for wholesale orders right now.', coalesce(v_row->>'name', '');
    end if;

    if not exists (
      select 1 from public.product_colors pc
      where pc.product_id = v_product_id::uuid
        and lower(pc.name) = lower(v_color)
    ) then
      raise exception 'Color "%" is not part of the product "%".', v_color, coalesce(v_row->>'name', '');
    end if;

    select coalesce(sum((x->>'qty')::int), 0)
      into v_product_qty
    from jsonb_array_elements(v_validated) x
    where x->>'product_id' = v_product_id;

    v_unit := 0;
    if v_product_qty >= 100 and (v_prod_price100 > 0 or v_global_100 > 0) then
      v_unit := coalesce(nullif(v_prod_price100, 0), v_global_100);
    elsif v_prod_price50 > 0 or v_global_50 > 0 then
      v_unit := coalesce(nullif(v_prod_price50, 0), v_global_50);
    end if;

    if v_unit <= 0 then
      raise exception 'Product "%" has no wholesale price set — contact the DSLANG team.', coalesce(v_row->>'name', '');
    end if;

    v_row := v_row
      || jsonb_build_object('wholesale_price_50', v_prod_price50, 'wholesale_price_100', v_prod_price100)
      || jsonb_build_object('unit_price', v_unit, 'line_total', v_unit * (v_row->>'qty')::int);
    v_validated := jsonb_set(v_validated, array[v_i::text], v_row);
    v_total_amount := v_total_amount + v_unit * (v_row->>'qty')::int;
  end loop;

  insert into public.orders (lines, total_qty, total_amount, seller)
  values (v_validated, v_total_qty, v_total_amount, coalesce(p_seller, '{}'::jsonb))
  returning id into v_order_id;

  v_ref := upper(substr(replace(v_order_id::text, '-', ''), 1, 9));
  update public.orders set ref = v_ref where id = v_order_id;

  return jsonb_build_object(
    'order_id', v_order_id,
    'ref', v_ref,
    'total_qty', v_total_qty,
    'total_amount', v_total_amount
  );
end;
$$;

revoke all on function public.create_wholesale_order(jsonb, jsonb) from public;
grant execute on function public.create_wholesale_order(jsonb, jsonb) to anon, authenticated, service_role;

-- Guarantee there is always at least one admin (the first signed-up user), so
-- write access to products / site_settings / orders works after a fresh
-- migration. Only runs when admin_users is completely empty.
insert into public.admin_users (user_id)
select u.id
from auth.users u
order by u.created_at asc
limit 1
where not exists (select 1 from public.admin_users);
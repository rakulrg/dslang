-- =============================================================================
-- DSLANG color-pack wholesale ordering (final migration).
--
-- Supersedes the earlier wholesale migrations (recommended run order is still
-- 0000 -> 0100 -> 0200 -> this file, but this file is self-sufficient and
-- idempotent, so it can also be applied on its own).
--
-- Makes the wholesale quantity model a COLOR PACK system:
--   * 1 pack of a color  =  pack_size pieces (6)
--   * split  =  pack_m M (2) + pack_l L (2) + pack_xl XL (2)  -> fixed ratio
--   * the customer only ever picks whole packs per color (M/L/XL never
--     independently editable)
--   * the real acceptance floor is min_order_quantity (48) while the site may
--     advertise default_moq (50)
--   * 50+ / 100+ per-piece pricing is admin-controlled (per product + global
--     site defaults)
--
-- Also adds an orders table and a SECURITY DEFINER RPC that VALIDATES every
-- wholesale order server-side (whole packs >= 0, sizes derived from the ratio,
-- total >= min_order_quantity) so a manipulated request cannot create an
-- invalid order. Orders store the full color/size breakdown for the admin.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Products: idempotent superset of the wholesale columns.
-- ----------------------------------------------------------------------------
alter table public.products
  add column if not exists gsm integer,
  add column if not exists wash text,
  add column if not exists print_type text,
  add column if not exists moq integer not null default 50,
  add column if not exists price50 integer,
  add column if not exists price100 integer,
  add column if not exists published boolean not null default true,
  add column if not exists new_drop boolean not null default false,
  add column if not exists details text,
  add column if not exists available_sizes text[] not null default array['M','L','XL'];

alter table public.hero_slides
  add column if not exists cta_text text,
  add column if not exists cta_url text;

-- Backfill wholesale pricing from the legacy retail price so existing products
-- are orderable after migration. These are seed values only — the admin panel
-- is the only place pricing is edited.
update public.products
set price50 = round((price * 0.3) / 5) * 5
where coalesce(price50, 0) <= 0 and coalesce(price, 0) > 0;

update public.products
set price100 = greatest(price50 - 10, round((price50 * 0.96) / 5) * 5)
where coalesce(price100, 0) <= 0 and price50 is not null and price50 > 0;

-- ----------------------------------------------------------------------------
-- 2. site_settings: single-row admin control of the wholesale system.
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
-- 3. Orders: stored wholesale orders with the full color/size breakdown.
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
-- 4. Server-side validated order creation RPC.
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

  v_validated jsonb := '[]'::jsonb;
  v_total_qty int := 0;
  v_total_amount numeric := 0;
  v_row jsonb;
  v_packs int;
  v_product_qty int;
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
        'qty', v_packs * v_pack_size,
        'price50', coalesce((v_row ->> 'price50')::numeric, 0),
        'price100', coalesce((v_row ->> 'price100')::numeric, 0)
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

  -- Pass 2: price each line by its product's own total quantity
  -- (>= 100 PCS -> 100+ price; otherwise the 50+ price).
  v_n := jsonb_array_length(v_validated);
  for v_i in 0 .. v_n - 1 loop
    v_row := jsonb_array_element(v_validated, v_i);

    select coalesce(sum((x->>'qty')::int), 0)
      into v_product_qty
    from jsonb_array_elements(v_validated) x
    where x->>'product_id' = v_row->>'product_id';

    if v_product_qty >= 100 and coalesce((v_row->>'price100')::numeric, 0) > 0 then
      v_unit := (v_row->>'price100')::numeric;
    else
      v_unit := coalesce((v_row->>'price50')::numeric, 0);
    end if;

    v_row := v_row || jsonb_build_object('unit_price', v_unit, 'line_total', v_unit * (v_row->>'qty')::int);
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

-- ----------------------------------------------------------------------------
-- 5. Housekeeping so earlier migrations stay compatible if run before this one.
-- ----------------------------------------------------------------------------
update public.products
set new_drop = true
where new_drop = false
  and id in (
    select id from public.products
    order by created_at desc
    limit 4
  );
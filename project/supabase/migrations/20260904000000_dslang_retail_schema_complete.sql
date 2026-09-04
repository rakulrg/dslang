-- =============================================================================
-- DSLANG retail/D2C schema — complete, idempotent, self-sufficient (2026-09-04)
--
-- WHY THIS FILE EXISTS
--   The retail/D2C workflow (checkout, promo codes, orders, settings) requires
--   three tables and two RPCs. The earlier retail migrations assumed the
--   wholesale_final base (which creates site_settings) had already been applied,
--   so applying only the newer files leaves the database incomplete. This one
--   forward migration is fully self-sufficient and idempotent: it creates (or
--   safely updates) every retail/D2C object the running application expects,
--   in dependency order, WITHOUT dropping or renaming any existing tables and
--   WITHOUT touching existing data.
--
-- It is safe to run regardless of which prior migrations were applied:
--   * Tables use CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.
--   * Functions use CREATE OR REPLACE FUNCTION.
--   * Policies are dropped then recreated.
--   * Existing wholesale rows/tables are left untouched.
--
-- Objects defined here (canonical, matching the current frontend contract):
--   0) Missing catalog columns       — additive products/hero_slides columns
--                                    (published, retail_visible, moq, cta_text,
--                                    cta_url) required by the retail workflow.
--   A) public.site_settings        — singleton row (id=1) with all admin +
--                                    retail fields the app reads/writes.
--   B) public.promo_codes          — full rule set the Admin Promo Codes UI uses.
--   C) public.retail_orders        — full retail order + promo + payment snapshot.
--   D) public.validate_promo_code  — RPC (p_code, p_subtotal) → ok/reason/promo.
--   E) public.create_retail_order  — RPC (p_customer, p_items, p_referral,
--                                    p_promo_code, p_shipping) → order snapshot.
--
-- NOTE: create_retail_order intentionally keeps the field snapshot in the
-- customer / items jsonb, plus the added paid_at / payment / promo columns.
-- The wholesale `orders` table + create_wholesale_order RPC are NOT touched.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 0) ADDITIVE missing catalog columns (identified from the live remote schema).
--    The remote database was missing these columns on products / hero_slides,
--    which caused HTTP 400/42703 errors. They are added IF NOT EXISTS so this
--    migration is safe and idempotent on any database. No wholesale columns
--    (wholesale_price_50/100) are modified here.
-- ----------------------------------------------------------------------------
alter table public.products
  add column if not exists published boolean not null default true;

alter table public.products
  add column if not exists retail_visible boolean not null default true;

alter table public.products
  add column if not exists moq integer not null default 50;

alter table public.products
  add column if not exists new_drop boolean not null default false;

alter table public.hero_slides
  add column if not exists cta_text text;

alter table public.hero_slides
  add column if not exists cta_url text;

-- ----------------------------------------------------------------------------
-- A) site_settings (singleton row).
-- Contains the full set of columns referenced by src/lib/settings.tsx plus the
-- retail additions (wholesale_pricing_enabled, shipping_flat_rate).
-- ----------------------------------------------------------------------------
create table if not exists public.site_settings (
  id integer primary key check (id = 1),
  announcement_text text not null default 'NEW DROP · SAME DAY DISPATCH · PAN INDIA DELIVERY',
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
  wholesale_pricing_enabled boolean not null default false,
  shipping_flat_rate integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Backfill wholesale columns in case the table pre-existed (wholesale_final)
-- without the retail additions, and retail additions in case it only had the
-- early wholesale columns.
alter table public.site_settings add column if not exists default_moq integer not null default 50;
alter table public.site_settings add column if not exists dispatch_note text not null default 'Same Day Dispatch';
alter table public.site_settings add column if not exists delivery_note text not null default 'Pan India';
alter table public.site_settings add column if not exists min_order_quantity integer not null default 48;
alter table public.site_settings add column if not exists per_color_minimum integer not null default 6;
alter table public.site_settings add column if not exists pack_size integer not null default 6;
alter table public.site_settings add column if not exists pack_m integer not null default 2;
alter table public.site_settings add column if not exists pack_l integer not null default 2;
alter table public.site_settings add column if not exists pack_xl integer not null default 2;
alter table public.site_settings add column if not exists wholesale_price_50 integer;
alter table public.site_settings add column if not exists wholesale_price_100 integer;
comment on column public.site_settings.wholesale_price_50 is 'Global wholesale 50-99 PCS price fallback (legacy wholesale; unused by retail).';
comment on column public.site_settings.wholesale_price_100 is 'Global wholesale 100+ PCS price fallback (legacy wholesale; unused by retail).';

alter table public.site_settings add column if not exists wholesale_pricing_enabled boolean not null default false;
alter table public.site_settings add column if not exists shipping_flat_rate integer not null default 0;

comment on column public.site_settings.wholesale_pricing_enabled is
  'Central master switch for customer-facing wholesale pricing (default false).';
comment on column public.site_settings.shipping_flat_rate is
  'Flat shipping (INR) charged on retail orders.';

-- Singleton row.
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
-- B) promo_codes — full rule set used by the Admin Promo Codes UI and
--    validate_promo_code / create_retail_order.
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
  min_order_value numeric not null default 0,
  max_discount numeric,
  starts_at timestamptz,
  expires_at timestamptz,
  per_customer_limit integer,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Defensive: if the table pre-existed without the newer rule columns.
alter table public.promo_codes add column if not exists min_order_value numeric not null default 0;
alter table public.promo_codes add column if not exists max_discount numeric;
alter table public.promo_codes add column if not exists starts_at timestamptz;
alter table public.promo_codes add column if not exists per_customer_limit integer;
alter table public.promo_codes add column if not exists note text not null default '';
alter table public.promo_codes add column if not exists updated_at timestamptz not null default now();

comment on column public.promo_codes.min_order_value is
  'Minimum order subtotal required before this code applies (0 = any).';
comment on column public.promo_codes.max_discount is
  'Maximum discount this code may grant (null = no cap).';
comment on column public.promo_codes.per_customer_limit is
  'Maximum number of orders a single phone number may use this code on (null = unlimited).';
comment on column public.promo_codes.note is
  'Admin-only internal note; never surfaced to shoppers.';

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
-- C) retail_orders — full retail order + promo + payment snapshot.
-- ----------------------------------------------------------------------------
create table if not exists public.retail_orders (
  id uuid primary key default gen_random_uuid(),
  ref text,
  order_type text not null default 'retail',
  customer jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  total_qty integer not null default 0,
  subtotal numeric not null default 0,
  discount numeric not null default 0,
  shipping numeric not null default 0,
  total_amount numeric not null default 0,
  payment_status text not null default 'pending',
  order_status text not null default 'pending',
  referral text,
  promo_code text,
  currency text not null default 'INR',
  payment_provider text,
  payment_id text,
  txn_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Defensive column additions if the table pre-existed in a partial state.
alter table public.retail_orders add column if not exists discount numeric not null default 0;
alter table public.retail_orders add column if not exists promo_code text;
alter table public.retail_orders add column if not exists currency text not null default 'INR';
alter table public.retail_orders add column if not exists updated_at timestamptz not null default now();
alter table public.retail_orders add column if not exists payment_provider text;
alter table public.retail_orders add column if not exists payment_id text;
alter table public.retail_orders add column if not exists txn_id text;
alter table public.retail_orders add column if not exists paid_at timestamptz;

comment on column public.retail_orders.discount is
  'Promo discount applied server-side (subtotal - discount + shipping = total).';
comment on column public.retail_orders.promo_code is 'Promo code applied at order time (snapshot).';
comment on column public.retail_orders.currency is 'Order currency snapshot (INR).';
comment on column public.retail_orders.payment_provider is 'Payment gateway used (e.g. cashfree).';
comment on column public.retail_orders.payment_id is 'Gateway order/payment reference; unique while set for idempotent callbacks.';
comment on column public.retail_orders.txn_id is 'Gateway transaction id returned after a successful payment.';
comment on column public.retail_orders.paid_at is
  'Verified payment timestamp — set server-side only, when payment_status becomes ''success''.';

-- Idempotency: a payment id may be recorded at most once, so duplicate
-- webhooks / retries can never create or mutate a second paid order.
create unique index if not exists retail_orders_payment_id_unique
  on public.retail_orders (payment_id)
  where payment_id is not null;

create index if not exists idx_retail_orders_created_at on public.retail_orders (created_at desc);
create index if not exists idx_retail_orders_referral on public.retail_orders (referral);

alter table public.retail_orders enable row level security;

-- Public visitors may place a retail order (no account required).
drop policy if exists "retail_orders_insert_public" on public.retail_orders;
create policy "retail_orders_insert_public"
  on public.retail_orders for insert
  to anon, authenticated
  with check (true);

-- Orders are only readable/updatable by the authorized admin.
drop policy if exists "retail_orders_select_admin" on public.retail_orders;
create policy "retail_orders_select_admin"
  on public.retail_orders for select
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

drop policy if exists "retail_orders_update_admin" on public.retail_orders;
create policy "retail_orders_update_admin"
  on public.retail_orders for update
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users where user_id = auth.uid()));

-- Keep updated_at current whenever any row changes.
create or replace function public.set_retail_order_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists retail_orders_set_updated_at on public.retail_orders;
create trigger retail_orders_set_updated_at
  before update on public.retail_orders
  for each row execute function public.set_retail_order_updated_at();

-- ----------------------------------------------------------------------------
-- D) validate_promo_code — full rules + friendly reasons.
-- Signature: (p_code text, p_subtotal numeric default 0).
-- Returns jsonb: {"ok": true, "promo": {...}} or {"ok": false, "reason": "..."}.
-- Actually defined here so it exists even if the earlier promo migration was
-- not applied to this database.
-- ----------------------------------------------------------------------------
create or replace function public.validate_promo_code(p_code text, p_subtotal numeric default 0)
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
    return jsonb_build_object('ok', false, 'reason', 'Enter a promo code.');
  end if;

  select * into v
  from public.promo_codes
  where upper(code) = v_code
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'This code is invalid or expired.');
  end if;

  if not v.active then
    return jsonb_build_object('ok', false, 'reason', 'This code is unavailable right now.');
  end if;

  if v.starts_at is not null and v.starts_at > now() then
    return jsonb_build_object('ok', false, 'reason', 'This code is not active yet.');
  end if;

  if v.expires_at is not null and v.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'This code is invalid or expired.');
  end if;

  if v.max_uses is not null and v.used_count >= v.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'This code has reached its usage limit.');
  end if;

  if coalesce(v.min_order_value, 0) > coalesce(p_subtotal, 0) then
    return jsonb_build_object(
      'ok', false,
      'reason', 'Add ₹' || trim(to_char(coalesce(v.min_order_value, 0), 'FM999G999G999')) || ' more to use this code.'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'promo', jsonb_build_object(
      'code', v.code,
      'label', coalesce(v.label, ''),
      'discount_type', v.discount_type,
      'discount_value', v.discount_value,
      'min_order_value', coalesce(v.min_order_value, 0),
      'max_discount', v.max_discount,
      'per_customer_limit', v.per_customer_limit
    )
  );
end;
$$;

revoke all on function public.validate_promo_code(text, numeric) from public;
grant execute on function public.validate_promo_code(text, numeric)
  to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- E) create_retail_order — server-side validated retail order creation.
--
-- SECURITY DEFINER (reads products / product_colors / product_sizes /
-- site_settings / promo_codes regardless of RLS). NEVER trusts client prices:
-- every line is re-priced from products.price, the discount is derived from
-- promo_codes, stock is validated + decremented, and the total is recomputed.
-- Opens with order_status = 'pending' and returns the full order snapshot
-- (items + customer) so the confirmation screen never reconstructs prices.
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

  -- Free shipping: merchandise subtotal >= INR 999 ships at ₹0. Kept in sync
  -- with the storefront (lib/settings.tsx computeShipping) so the saved order,
  -- Cart, Checkout, and Admin Retail Orders all report the same amount.
  if v_subtotal >= 999 then
    v_shipping := 0;
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
-- F) Reload the PostgREST schema cache so the new tables/functions are visible
--    immediately (avoids "Could not find the table ... in the schema cache").
--    Safe: only emits NOTIFY; no DDL.
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';

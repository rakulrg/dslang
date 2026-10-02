-- =============================================================================
-- Migration: 20261005000000_dslang_ops_inventory.sql
--
-- DSLANG Operations & Inventory System — additive, idempotent, zero-touch on
-- existing storefront/payment/shipping logic.
--
-- CONTEXT (from the live audit):
--   * `product_sizes` is the variant-level inventory source of truth. Its
--     `stock` column is the SELLABLE (available) quantity: `create_retail_order`
--     decrements it at order placement (reservation), `restock_retail_order_items`
--     returns it on failure/cancel. The storefront checks/reads `stock` directly
--     (catalog.ts, cartStock.ts). Availability is enforced server-side and can
--     never go negative.
--   * Nothing tracks physical on-hand, inbound (PO) units, reorder levels, stock
--     movements, purchase orders, suppliers or an admin audit trail.
--
-- MODEL (one source of truth, no double counting):
--   available  = product_sizes.stock            (unchanged storefront truth)
--   committed  = derived: units on OPEN orders (status not shipped/delivered/
--                cancelled/refunded/rto AND stock_restored_at IS NULL). These
--                units were already withdrawn from `stock` at order creation,
--                so available + committed = the physical sellable pool.
--   incoming   = NEW column: units on confirmed (ORDERED) POs not yet received.
--   reorder_point / target_stock / min_stock = NEW columns for reorder mgmt.
--   unavailable / damaged / reserved = NEW columns: physical non-sellable units.
--   on_hand (display) = available + committed + unavailable + damaged + reserved
--                (exact physical reconciliation for sale-chasing variants).
--
-- Every stock mutation in the ops paths is TRANSACTIONAL + recorded in
-- `stock_movements`. A defensive AFTER-trigger logs storefront reservation/
-- release movements automatically (never breaks checkout — exceptions swallow).
--
-- NEW OBJECTS:
--   * product_sizes additive columns          (no existing column touched)
--   * suppliers, purchase_orders, purchase_order_items, stock_movements,
--     admin_activity                          (RLS: admin-only)
--   * variant_inventory_v                     (admin view: one row per variant)
--   * RPCs: adjust_variant_stock, set_variant_reorder, bulk_set_variant_reorder,
--           create_purchase_order, update_purchase_order_status,
--           receive_purchase_order, cancel_purchase_order, delete_purchase_order,
--           set_product_visibility, dashboard_overview_stats,
--           customer_overview
--   * triggers: product_sizes stock-movement logging, product_sizes updated_at,
--           admin_activity capture on products / promo_codes / retail_orders
--
-- SECURITY: every mutating RPC is SECURITY DEFINER with an in-body admin gate
-- against admin_users (same mechanism as set_product_size_stock). The movement
-- trigger is SECURITY DEFINER but swallows ALL errors so it can never abort a
-- storefront checkout. New tables are admin-only via RLS. No secrets anywhere.
--
-- Safe to apply on any current retail DB. Does not DROP any existing table.
-- =============================================================================

--------------------------------------------------------------------------------
-- 1) product_sizes — additive operations columns (never touch `stock` semantics)
--------------------------------------------------------------------------------
alter table public.product_sizes
  add column if not exists incoming integer not null default 0;

alter table public.product_sizes
  add column if not exists reorder_point integer not null default 0;

alter table public.product_sizes
  add column if not exists target_stock integer not null default 0;

alter table public.product_sizes
  add column if not exists min_stock integer not null default 0;

alter table public.product_sizes
  add column if not exists unavailable integer not null default 0;

alter table public.product_sizes
  add column if not exists damaged integer not null default 0;

alter table public.product_sizes
  add column if not exists reserved integer not null default 0;

alter table public.product_sizes
  add column if not exists updated_at timestamptz not null default now();

alter table public.product_sizes
  add column if not exists created_at timestamptz not null default now();

comment on column public.product_sizes.stock is
  'AVAILABLE / sellable units — the single storefront truth. Decremented at order placement, restored on failed/cancelled orders. Never negative.';
comment on column public.product_sizes.incoming is
  'Units on confirmed (ORDERED) purchase orders not yet received.';
comment on column public.product_sizes.reorder_point is
  'When available drops to/below this value the variant flags LOW STOCK.';
comment on column public.product_sizes.target_stock is
  'Desired available level used to prefill "Create purchase order" (target - available).';
comment on column public.product_sizes.min_stock is
  'Operational minimum (informational).';
comment on column public.product_sizes.unavailable is
  'Physical units on hand that are not sellable (quality hold / quarantine).';
comment on column public.product_sizes.damaged is
  'Physical units damaged (not sellable, not part of available).';
comment on column public.product_sizes.reserved is
  'Physical units held for manual reservations (not sellable until released).';

create index if not exists idx_product_sizes_updated_at
  on public.product_sizes (updated_at desc);

-- Keep updated_at current on every variant change (drives "recently updated").
create or replace function public.set_product_sizes_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists product_sizes_set_updated_at on public.product_sizes;
create trigger product_sizes_set_updated_at
  before update on public.product_sizes
  for each row execute function public.set_product_sizes_updated_at();

--------------------------------------------------------------------------------
-- 2) Field-based audit capture (post-hoc; never writes user data, never alters
--    the underlying transaction result). These fire on real changes made by the
--    storefront or existing RPCs so the Activity timeline is powered by facts.
--------------------------------------------------------------------------------
create table if not exists public.admin_activity (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  entity_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_activity_created_at on public.admin_activity (created_at desc);
create index if not exists idx_admin_activity_entity on public.admin_activity (entity, entity_id);

alter table public.admin_activity enable row level security;

drop policy if exists "admin_activity_admin_read" on public.admin_activity;
create policy "admin_activity_admin_read"
  on public.admin_activity for select
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

-- SECURITY DEFINER so RPCs/triggers may log regardless of RLS; WRITE access to
-- the table itself stays fully locked down (no admin insert/update/delete
-- policies — only the functions below may write).
create or replace function public.record_admin_activity(
  p_action text,
  p_entity text,
  p_entity_id text default null,
  p_entity_ref text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admin_activity (actor_id, actor_email, action, entity, entity_id, entity_ref, metadata)
  values (
    auth.uid(),
    (select email from auth.users where id = auth.uid()),
    p_action,
    p_entity,
    p_entity_id,
    p_entity_ref,
    coalesce(p_metadata, '{}'::jsonb)
  );
exception when others then
  null; -- audit must never break the calling transaction
end;
$$;

revoke all on function public.record_admin_activity(text, text, text, text, jsonb) from public;

-- product changes → activity
create or replace function public.log_product_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.record_admin_activity('CREATE', 'product', new.id::text, new.code, jsonb_build_object('name', new.name));
    return new;
  elsif tg_op = 'UPDATE' then
    perform public.record_admin_activity('UPDATE', 'product', new.id::text, new.code,
      jsonb_build_object('name', new.name, 'changed', jsonb_build_object('price', new.price)));
    return new;
  else
    perform public.record_admin_activity('DELETE', 'product', old.id::text, old.code, jsonb_build_object('name', old.name));
    return old;
  end if;
exception when others then
  return coalesce(new, old);
end;
$$;

drop trigger if exists admin_log_product_changes on public.products;
create trigger admin_log_product_changes
  after insert or update or delete on public.products
  for each row execute function public.log_product_activity();

-- promo code changes → activity
create or replace function public.log_promo_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.record_admin_activity('CREATE', 'promo_code', new.id::text, new.code, jsonb_build_object('active', new.active));
    return new;
  elsif tg_op = 'UPDATE' then
    perform public.record_admin_activity('UPDATE', 'promo_code', new.id::text, new.code,
      jsonb_build_object('active', new.active, 'used_count', new.used_count));
    return new;
  else
    perform public.record_admin_activity('DELETE', 'promo_code', old.id::text, old.code, jsonb_build_object());
    return old;
  end if;
exception when others then
  return coalesce(new, old);
end;
$$;

drop trigger if exists admin_log_promo_changes on public.promo_codes;
create trigger admin_log_promo_changes
  after insert or update or delete on public.promo_codes
  for each row execute function public.log_promo_activity();

-- order changes → activity (fires on placement, payment + status transitions incl.
-- webhooks/crons; captures the who/what of the order timeline)
create or replace function public.log_order_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta jsonb;
begin
  v_meta := jsonb_build_object(
    'order_status', new.order_status,
    'payment_status', new.payment_status,
    'total', new.total_amount,
    'is_cod', coalesce(new.is_cod, false)
  );
  if tg_op = 'INSERT' then
    perform public.record_admin_activity('CREATE', 'order', new.id::text, new.ref, v_meta);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.order_status is distinct from old.order_status then
      perform public.record_admin_activity('STATUS', 'order', new.id::text, new.ref, v_meta);
    else
      perform public.record_admin_activity('UPDATE', 'order', new.id::text, new.ref, v_meta);
    end if;
    return new;
  else
    perform public.record_admin_activity('DELETE', 'order', old.id::text, old.ref, jsonb_build_object());
    return old;
  end if;
exception when others then
  return coalesce(new, old);
end;
$$;

drop trigger if exists admin_log_order_changes on public.retail_orders;
create trigger admin_log_order_changes
  after insert or update or delete on public.retail_orders
  for each row execute function public.log_order_activity();

--------------------------------------------------------------------------------
-- 3) stock_movements — every inventory change gets a movement record.
--    Movement types follow the ops contract plus REJECTED (receiving).
--    `quantity` is the signed delta. previous_stock/new_stock reference the
--    variant's `available` (product_sizes.stock).
--------------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  color_id uuid not null references public.product_colors(id) on delete cascade,
  size_label text not null,
  movement_type text not null check (movement_type in (
    'SALE','RESERVATION','RELEASE','RECEIPT','ADJUSTMENT','DAMAGE','RETURN',
    'CANCELLATION','PRODUCTION','TRANSFER','CORRECTION','REJECTED'
  )),
  quantity integer not null,
  previous_stock integer not null default 0,
  new_stock integer not null default 0,
  reason text,
  source_type text,
  source_id text,
  actor uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_movements_product on public.stock_movements (product_id, created_at desc);
create index if not exists idx_stock_movements_type on public.stock_movements (movement_type, created_at desc);
create index if not exists idx_stock_movements_created on public.stock_movements (created_at desc);
create index if not exists idx_stock_movements_source on public.stock_movements (source_type, source_id);

alter table public.stock_movements enable row level security;

drop policy if exists "stock_movements_admin_read" on public.stock_movements;
create policy "stock_movements_admin_read"
  on public.stock_movements for select
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

-- Internal helper: append a movement row (definer role; RLS bypassed for the
-- write, reads in the functions rely on definer context — safe, admin-gate the
-- CALLERS, never expose this function to anon). Swallows errors so a movement
-- record can never fail the operation it describes.
create or replace function public.append_stock_movement(
  p_product_id uuid,
  p_color_id uuid,
  p_size_label text,
  p_movement_type text,
  p_quantity integer,
  p_previous integer,
  p_new integer,
  p_reason text default null,
  p_source_type text default null,
  p_source_id text default null,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.stock_movements (
    product_id, color_id, size_label, movement_type, quantity,
    previous_stock, new_stock, reason, source_type, source_id, actor, note
  ) values (
    p_product_id, p_color_id, p_size_label, p_movement_type, p_quantity,
    coalesce(p_previous, 0), coalesce(p_new, 0), p_reason, p_source_type,
    p_source_id, auth.uid(), p_note
  );
exception when others then
  null;
end;
$$;

revoke all on function public.append_stock_movement(uuid, uuid, text, text, integer, integer, integer, text, text, text, text) from public;

--------------------------------------------------------------------------------
-- 4) Automatic movement logging for the STOREFRONT/legacy stock paths.
--    product_sizes.stock is only ever changed by:
--      * create_retail_order          (decrement → RESERVATION)
--      * restock_retail_order_items   (increment → RELEASE)
--      * set_product_size_stock       (legacy admin absolute set → ADJUSTMENT-ish)
--      * the ops RPCs below           (they SET LOCAL skip + log their own richer
--                                      movement, so this trigger never double-logs)
--    The trigger is fully defensive: any failure is swallowed so checkout can
--    never be aborted by inventory logging.
--------------------------------------------------------------------------------
create or replace function public.product_sizes_log_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
  v_reason text;
  v_source_type text;
begin
  if lower(coalesce(current_setting('dslang.skip_stock_movement', true), 'no')) = 'yes' then
    return new;
  end if;

  if new.stock = old.stock then
    return new;
  end if;

  if new.stock < old.stock then
    v_type := 'RESERVATION';
    v_reason := 'Stock reserved for an order';
    v_source_type := 'order';
  else
    v_type := 'RELEASE';
    v_reason := 'Stock released (order failed / cancelled / restocked)';
    v_source_type := 'order';
  end if;

  perform public.append_stock_movement(
    new.product_id, new.color_id, new.size_label, v_type,
    new.stock - old.stock, old.stock, new.stock,
    v_reason, v_source_type, null, null
  );
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists product_sizes_log_stock_movement on public.product_sizes;
create trigger product_sizes_log_stock_movement
  after update of stock on public.product_sizes
  for each row execute function public.product_sizes_log_stock_movement();

--------------------------------------------------------------------------------
-- 5) Supplier + purchase order tables (admin-only RLS)
--------------------------------------------------------------------------------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_person text,
  phone text,
  email text,
  address text,
  payment_terms text,
  lead_time_days integer,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.suppliers enable row level security;

drop policy if exists "suppliers_admin_all" on public.suppliers;
create policy "suppliers_admin_all"
  on public.suppliers for all
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users where user_id = auth.uid()));

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text not null unique,
  supplier_id uuid references public.suppliers(id) on delete set null,
  status text not null default 'DRAFT'
    check (status in ('DRAFT','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  created_date timestamptz not null default now(),
  expected_date date,
  destination text,
  payment_terms text,
  notes text,
  total_cost numeric not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_purchase_orders_status on public.purchase_orders (status, created_date desc);
create index if not exists idx_purchase_orders_supplier on public.purchase_orders (supplier_id);

alter table public.purchase_orders enable row level security;

drop policy if exists "purchase_orders_admin_all" on public.purchase_orders;
create policy "purchase_orders_admin_all"
  on public.purchase_orders for all
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users where user_id = auth.uid()));

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  color_id uuid not null references public.product_colors(id) on delete cascade,
  size_label text not null,
  quantity_ordered integer not null check (quantity_ordered > 0),
  quantity_received integer not null default 0,
  quantity_rejected integer not null default 0,
  unit_cost numeric not null default 0,
  total_cost numeric not null default 0,
  unique (po_id, product_id, color_id, size_label)
);

create index if not exists idx_purchase_order_items_po on public.purchase_order_items (po_id);

alter table public.purchase_order_items enable row level security;

drop policy if exists "purchase_order_items_admin_all" on public.purchase_order_items;
create policy "purchase_order_items_admin_all"
  on public.purchase_order_items for all
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users where user_id = auth.uid()));

--------------------------------------------------------------------------------
-- 6) variant_inventory_v — one row per variant with the full ops signal set.
--    committed is DERIVED from open orders (the true reservation pool); on_hand
--    reconciles physical units exactly for sale-chasing variants.
--------------------------------------------------------------------------------
create or replace view public.variant_inventory_v as
select
  ps.id as variant_id,
  ps.product_id,
  ps.color_id,
  ps.size_label,
  ps.stock as available,
  coalesce(c.committed, 0) as committed,
  coalesce(c.committed, 0) + ps.stock + ps.unavailable + ps.damaged + ps.reserved as on_hand,
  ps.incoming,
  ps.unavailable,
  ps.damaged,
  ps.reserved,
  ps.reorder_point,
  ps.target_stock,
  ps.min_stock,
  ps.available as in_stock,
  (ps.stock > 0) and (ps.stock <= ps.reorder_point) as low_stock,
  ps.stock <= 0 as out_of_stock,
  (ps.stock * coalesce(p.price, 0)) as value,
  p.name as product_name,
  p.code as product_code,
  p.category as category,
  p.published as published,
  p.retail_visible as retail_visible,
  pc.name as color_name,
  pc.hex as color_hex,
  ps.updated_at,
  ps.created_at
from public.product_sizes ps
join public.products p on p.id = ps.product_id
left join public.product_colors pc on pc.id = ps.color_id
left join (
  select
    (x.item->>'product_id')::uuid as product_id,
    (x.item->>'color_id')::uuid as color_id,
    x.item->>'size_label' as size_label,
    sum((x.item->>'quantity')::int) as committed
  from public.retail_orders o
  cross join lateral jsonb_array_elements(o.items) x(item)
  where o.order_type = 'retail'
    and o.stock_restored_at is null
    and o.order_status not in ('shipped','delivered','cancelled','refunded','rto')
  group by 1, 2, 3
) c
  on c.product_id = ps.product_id
 and c.color_id = ps.color_id
 and c.size_label = ps.size_label;

--------------------------------------------------------------------------------
-- 7) Inventory mutation RPCs (admin-only, transactional, movement-recorded)
--------------------------------------------------------------------------------

-- ADJUST STOCK for one variant by a signed delta. new_available = stock + delta
-- and is clamped >= 0 server-side. Records a movement + activity. The reason
-- select drives the movement type when the caller does not pass one.
create or replace function public.adjust_variant_stock(
  p_product_id uuid,
  p_color_id uuid,
  p_size_label text,
  p_delta integer,
  p_reason text default 'Manual correction',
  p_note text default null,
  p_movement_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old integer;
  v_new integer;
  v_type text;
  v_reason text := coalesce(trim(p_reason), 'Manual correction');
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can adjust stock.';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'Adjustment must be a non-zero quantity.';
  end if;

  select stock into v_old
  from public.product_sizes
  where product_id = p_product_id
    and color_id = p_color_id
    and size_label = p_size_label
  for update;

  if not found then
    raise exception 'Variant not found.';
  end if;

  v_old := coalesce(v_old, 0);
  v_new := v_old + p_delta;
  if v_new < 0 then
    raise exception 'Adjustment would make available stock negative.';
  end if;

  v_type := upper(trim(coalesce(p_movement_type, '')));
  if v_type = '' or v_type not in (
    'SALE','RESERVATION','RELEASE','RECEIPT','ADJUSTMENT','DAMAGE','RETURN',
    'CANCELLATION','PRODUCTION','TRANSFER','CORRECTION','REJECTED'
  ) then
    v_type := case
      when lower(v_reason) like '%damag%' then 'DAMAGE'
      when lower(v_reason) like '%product%' or lower(v_reason) like '%stock-in%' or lower(v_reason) = 'production' then 'PRODUCTION'
      when lower(v_reason) like '%found%' then 'CORRECTION'
      when lower(v_reason) like '%correction%' or lower(v_reason) = 'manual correction' then 'CORRECTION'
      when lower(v_reason) like '%loss%' or lower(v_reason) like '%lost%' then 'DAMAGE'
      when lower(v_reason) like '%transfer%' then 'TRANSFER'
      when lower(v_reason) like '%return%' then 'RETURN'
      else 'ADJUSTMENT'
    end;
  end if;

  perform set_config('dslang.skip_stock_movement', 'yes', true);

  update public.product_sizes
  set stock = v_new,
      available = v_new > 0
  where product_id = p_product_id
    and color_id = p_color_id
    and size_label = p_size_label;

  perform public.append_stock_movement(
    p_product_id, p_color_id, p_size_label, v_type,
    p_delta, v_old, v_new, v_reason, 'manual', null,
    coalesce(p_note, null)
  );

  perform public.record_admin_activity(
    'adjust_stock', 'variant',
    p_product_id::text || ':' || p_color_id::text || ':' || p_size_label,
    null,
    jsonb_build_object('size_label', p_size_label, 'delta', p_delta, 'old', v_old, 'new', v_new, 'type', v_type, 'reason', v_reason)
  );

  return jsonb_build_object('ok', true, 'previous', v_old, 'new', v_new, 'movement_type', v_type);
end;
$$;

revoke all on function public.adjust_variant_stock(uuid, uuid, text, integer, text, text, text) from public;
grant execute on function public.adjust_variant_stock(uuid, uuid, text, integer, text, text, text) to authenticated;
revoke execute on function public.adjust_variant_stock(uuid, uuid, text, integer, text, text, text) from anon;

-- Set reorder levels for one variant.
create or replace function public.set_variant_reorder(
  p_product_id uuid,
  p_color_id uuid,
  p_size_label text,
  p_reorder_point integer default 0,
  p_target_stock integer default 0,
  p_min_stock integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can set reorder levels.';
  end if;
  if p_reorder_point is null or p_reorder_point < 0
     or p_target_stock is null or p_target_stock < 0
     or p_min_stock is null or p_min_stock < 0 then
    raise exception 'Reorder levels must be non-negative.';
  end if;

  update public.product_sizes
  set reorder_point = p_reorder_point,
      target_stock = p_target_stock,
      min_stock = p_min_stock
  where product_id = p_product_id
    and color_id = p_color_id
    and size_label = p_size_label;

  perform public.record_admin_activity(
    'set_reorder', 'variant',
    p_product_id::text || ':' || p_color_id::text || ':' || p_size_label,
    null,
    jsonb_build_object('reorder_point', p_reorder_point, 'target_stock', p_target_stock, 'min_stock', p_min_stock)
  );
end;
$$;

revoke all on function public.set_variant_reorder(uuid, uuid, text, integer, integer, integer) from public;
grant execute on function public.set_variant_reorder(uuid, uuid, text, integer, integer, integer) to authenticated;
revoke execute on function public.set_variant_reorder(uuid, uuid, text, integer, integer, integer) from anon;

-- Batch set reorder levels: p_items jsonb array of
-- [{product_id, color_id, size_label, reorder_point, target_stock, min_stock}]
create or replace function public.bulk_set_variant_reorder(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer := 0;
  v_row jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can set reorder levels.';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items must be an array.';
  end if;

  for v_row in select * from jsonb_array_elements(p_items) loop
    if (v_row->>'product_id') is null or (v_row->>'color_id') is null or (v_row->>'size_label') is null then
      continue;
    end if;
    update public.product_sizes
    set reorder_point = greatest(coalesce((v_row->>'reorder_point')::int, 0), 0),
        target_stock = greatest(coalesce((v_row->>'target_stock')::int, 0), 0),
        min_stock = greatest(coalesce((v_row->>'min_stock')::int, 0), 0)
    where product_id = (v_row->>'product_id')::uuid
      and color_id = (v_row->>'color_id')::uuid
      and size_label = v_row->>'size_label';
    v_n := v_n + 1;
  end loop;

  perform public.record_admin_activity('set_reorder', 'variant', null, null, jsonb_build_object('count', v_n));
  return v_n;
end;
$$;

revoke all on function public.bulk_set_variant_reorder(jsonb) from public;
grant execute on function public.bulk_set_variant_reorder(jsonb) to authenticated;
revoke execute on function public.bulk_set_variant_reorder(jsonb) from anon;

-- Archive / unarchive products (soft visibility flip; keeps all data).
create or replace function public.set_product_visibility(p_ids uuid[], p_published boolean)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can change product visibility.';
  end if;
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then
    return 0;
  end if;

  update public.products
  set published = p_published
  where id = any(p_ids);
  get diagnostics v_n = row_count;

  perform public.record_admin_activity(
    case when p_published then 'unarchive_product' else 'archive_product' end,
    'product', null, null,
    jsonb_build_object('ids', p_ids::text[], 'count', v_n)
  );
  return v_n;
end;
$$;

revoke all on function public.set_product_visibility(uuid[], boolean) from public;
grant execute on function public.set_product_visibility(uuid[], boolean) to authenticated;
revoke execute on function public.set_product_visibility(uuid[], boolean) from anon;

--------------------------------------------------------------------------------
-- 8) Purchase order RPCs
--------------------------------------------------------------------------------

-- Create a purchase order (DRAFT by default so nothing is committed to stock
-- until the PO is confirmed with the supplier). p_items jsonb array:
-- [{product_id, color_id, size_label, quantity, unit_cost}]
create or replace function public.create_purchase_order(
  p_supplier_id uuid,
  p_items jsonb,
  p_expected_date date default null,
  p_destination text default null,
  p_payment_terms text default null,
  p_notes text default null,
  p_status text default 'DRAFT'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po_id uuid;
  v_number text;
  v_total numeric := 0;
  v_row jsonb;
  v_status text;
  v_i int;
  v_n int;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can create purchase orders.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A purchase order needs at least one line item.';
  end if;

  v_status := upper(coalesce(p_status, 'DRAFT'));
  if v_status not in ('DRAFT','ORDERED') then
    raise exception 'A new purchase order can only be DRAFT or ORDERED.';
  end if;
  if v_status = 'ORDERED' and p_supplier_id is null then
    raise exception 'Assign a supplier before ordering.';
  end if;

  v_number := 'PO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.purchase_orders (
    po_number, supplier_id, status, expected_date, destination, payment_terms,
    notes, total_cost, created_by
  ) values (
    v_number, p_supplier_id, v_status, p_expected_date, p_destination,
    p_payment_terms, p_notes, 0, auth.uid()
  ) returning id into v_po_id;

  v_n := jsonb_array_length(p_items);
  for v_i in 0 .. v_n - 1 loop
    v_row := jsonb_array_element(p_items, v_i);
    if (v_row->>'product_id') is null or (v_row->>'color_id') is null
       or (v_row->>'size_label') is null or coalesce((v_row->>'quantity')::int, 0) <= 0 then
      raise exception 'Each line needs a product, colour, size and positive quantity.';
    end if;
    if not exists (
      select 1 from public.product_sizes ps
      where ps.product_id = (v_row->>'product_id')::uuid
        and ps.color_id = (v_row->>'color_id')::uuid
        and ps.size_label = v_row->>'size_label'
    ) then
      raise exception 'Variant does not exist (% / %).', v_row->>'product_id', v_row->>'size_label';
    end if;

    v_total := v_total + coalesce((v_row->>'quantity')::int, 0) * coalesce((v_row->>'unit_cost')::numeric, 0);

    insert into public.purchase_order_items (
      po_id, product_id, color_id, size_label, quantity_ordered, unit_cost, total_cost
    ) values (
      v_po_id, (v_row->>'product_id')::uuid, (v_row->>'color_id')::uuid,
      v_row->>'size_label', (v_row->>'quantity')::int,
      coalesce((v_row->>'unit_cost')::numeric, 0),
      coalesce((v_row->>'quantity')::int, 0) * coalesce((v_row->>'unit_cost')::numeric, 0)
    );

    -- An ORDERED PO adds to incoming immediately (units are on the way).
    if v_status = 'ORDERED' then
      perform set_config('dslang.skip_stock_movement', 'yes', true);
      update public.product_sizes
      set incoming = incoming + (v_row->>'quantity')::int
      where product_id = (v_row->>'product_id')::uuid
        and color_id = (v_row->>'color_id')::uuid
        and size_label = v_row->>'size_label';
    end if;
  end loop;

  if v_total > 0 then
    update public.purchase_orders set total_cost = v_total where id = v_po_id;
  end if;

  perform public.record_admin_activity('CREATE', 'purchase_order', v_po_id::text, v_number, jsonb_build_object('status', v_status, 'items', v_n, 'total', v_total));

  return jsonb_build_object('ok', true, 'po_id', v_po_id, 'po_number', v_number, 'status', v_status, 'total_cost', v_total);
end;
$$;

revoke all on function public.create_purchase_order(uuid, jsonb, date, text, text, text, text) from public;
grant execute on function public.create_purchase_order(uuid, jsonb, date, text, text, text, text) to authenticated;
revoke execute on function public.create_purchase_order(uuid, jsonb, date, text, text, text, text) from anon;

-- Transition a PO's lifecycle. DRAFT→ORDERED commits incoming; ORDERED→CANCELLED
-- releases it. PARTIALLY_RECEIVED/RECEIVED handled by receiving below.
create or replace function public.update_purchase_order_status(
  p_po_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders%rowtype;
  v_status text;
  v_release boolean := false;
  v_row record;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can update purchase orders.';
  end if;

  v_status := upper(trim(coalesce(p_status, '')));
  if v_status not in ('DRAFT','ORDERED','CANCELLED') then
    raise exception 'Invalid status transition.';
  end if;

  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'Purchase order not found.';
  end if;

  if v_po.status = v_status then
    return jsonb_build_object('ok', true, 'po_number', v_po.po_number, 'status', v_status);
  end if;

  -- DRAFT → ORDERED: commit incoming for all outstanding qty.
  if v_po.status = 'DRAFT' and v_status = 'ORDERED' then
    if v_po.supplier_id is null then
      raise exception 'Assign a supplier before ordering.';
    end if;
    perform set_config('dslang.skip_stock_movement', 'yes', true);
    for v_row in select * from public.purchase_order_items where po_id = v_po.id loop
      update public.product_sizes
      set incoming = incoming + (v_row.quantity_ordered - v_row.quantity_received - v_row.quantity_rejected)
      where product_id = v_row.product_id
        and color_id = v_row.color_id
        and size_label = v_row.size_label;
    end loop;
  end if;

  -- ORDERED → CANCELLED: release inbound units (clamped at zero).
  if v_po.status in ('DRAFT','ORDERED') and v_status = 'CANCELLED' and v_po.status = 'ORDERED' then
    v_release := true;
    perform set_config('dslang.skip_stock_movement', 'yes', true);
    for v_row in select * from public.purchase_order_items where po_id = v_po.id loop
      update public.product_sizes
      set incoming = greatest(incoming - (v_row.quantity_ordered - v_row.quantity_received - v_row.quantity_rejected), 0)
      where product_id = v_row.product_id
        and color_id = v_row.color_id
        and size_label = v_row.size_label;
    end loop;
  end if;

  update public.purchase_orders set status = v_status where id = v_po.id;

  perform public.record_admin_activity('STATUS', 'purchase_order', v_po.id::text, v_po.po_number, jsonb_build_object('from', v_po.status, 'to', v_status, 'released_incoming', v_release));

  return jsonb_build_object('ok', true, 'po_number', v_po.po_number, 'status', v_status, 'released_incoming', v_release);
end;
$$;

revoke all on function public.update_purchase_order_status(uuid, text) from public;
grant execute on function public.update_purchase_order_status(uuid, text) to authenticated;
revoke execute on function public.update_purchase_order_status(uuid, text) from anon;

-- Receive (partial/full) a purchase order. p_lines jsonb array:
-- [{item_id, received, rejected, reason}]
-- Received qty becomes AVAILABLE stock (+RECEIPT movement). Rejected qty does
-- NOT become stock and is recorded as a REJECTED movement (not sellable).
-- Updates the PO status to PARTIALLY_RECEIVED / RECEIVED. Transactional.
create or replace function public.receive_purchase_order(
  p_po_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.purchase_orders%rowtype;
  v_row jsonb;
  v_item public.purchase_order_items%rowtype;
  v_outstanding integer;
  v_received integer;
  v_rejected integer;
  v_stock_before integer;
  v_complete boolean := true;
  v_any_received boolean := false;
  v_lines_done integer := 0;
  v_total_received integer := 0;
  v_total_rejected integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can receive purchase orders.';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Nothing to receive.';
  end if;

  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'Purchase order not found.';
  end if;
  if v_po.status not in ('ORDERED','PARTIALLY_RECEIVED') then
    raise exception 'Only an ORDERED or PARTIALLY_RECEIVED purchase order can be received.';
  end if;

  perform set_config('dslang.skip_stock_movement', 'yes', true);

  for v_row in select * from jsonb_array_elements(p_lines) loop
    if (v_row->>'item_id') is null then
      continue;
    end if;
    v_received := greatest(coalesce((v_row->>'received')::int, 0), 0);
    v_rejected := greatest(coalesce((v_row->>'rejected')::int, 0), 0);

    select * into v_item from public.purchase_order_items where id = (v_row->>'item_id')::uuid;
    if not found then
      raise exception 'A line item on this purchase order was not found.';
    end if;

    v_outstanding := v_item.quantity_ordered - v_item.quantity_received - v_item.quantity_rejected;
    if v_received + v_rejected > v_outstanding then
      raise exception 'Received + rejected exceeds the outstanding quantity for one line.';
    end if;

    if v_received > 0 or v_rejected > 0 then
      -- READ the variant's current available stock (locked) for the movement trail.
      select stock into v_stock_before
      from public.product_sizes
      where product_id = v_item.product_id
        and color_id = v_item.color_id
        and size_label = v_item.size_label
      for update;

      -- incoming drops by the quantity that has now arrived or been turned away.
      update public.product_sizes
      set incoming = greatest(incoming - (v_received + v_rejected), 0)
      where product_id = v_item.product_id
        and color_id = v_item.color_id
        and size_label = v_item.size_label;

      -- received units become sellable stock.
      if v_received > 0 then
        update public.product_sizes
        set stock = stock + v_received,
            available = (stock + v_received) > 0
        where product_id = v_item.product_id
          and color_id = v_item.color_id
          and size_label = v_item.size_label;

        perform public.append_stock_movement(
          v_item.product_id, v_item.color_id, v_item.size_label, 'RECEIPT',
          v_received, coalesce(v_stock_before, 0), coalesce(v_stock_before, 0) + v_received,
          'Received against purchase order', 'purchase_order', v_po.po_number,
          null
        );
        v_total_received := v_total_received + v_received;
      end if;

      -- rejected units NEVER become stock; record the rejection.
      if v_rejected > 0 then
        perform public.append_stock_movement(
          v_item.product_id, v_item.color_id, v_item.size_label, 'REJECTED',
          -v_rejected, coalesce(v_stock_before, 0), coalesce(v_stock_before, 0),
          coalesce(v_row->>'reason', 'Rejected at receiving'), 'purchase_order', v_po.po_number,
          null
        );
        v_total_rejected := v_total_rejected + v_rejected;
      end if;

      update public.purchase_order_items
      set quantity_received = quantity_received + v_received,
          quantity_rejected = quantity_rejected + v_rejected
      where id = v_item.id;

      v_any_received := true;
      v_lines_done := v_lines_done + 1;
    end if;
  end loop;

  if not v_any_received then
    raise exception 'No quantity was entered for any line.';
  end if;

  -- Determine whether every line is now fully received/rejected.
  select not exists (
    select 1 from public.purchase_order_items
    where po_id = v_po.id
      and quantity_received + quantity_rejected < quantity_ordered
  ) into v_complete;

  if v_complete then
    update public.purchase_orders set status = 'RECEIVED' where id = v_po.id;
  else
    update public.purchase_orders set status = 'PARTIALLY_RECEIVED' where id = v_po.id;
  end if;

  perform public.record_admin_activity(
    'receive', 'purchase_order', v_po.id::text, v_po.po_number,
    jsonb_build_object('status', case when v_complete then 'RECEIVED' else 'PARTIALLY_RECEIVED' end,
                       'received', v_total_received, 'rejected', v_total_rejected, 'lines', v_lines_done)
  );

  return jsonb_build_object(
    'ok', true,
    'po_number', v_po.po_number,
    'status', case when v_complete then 'RECEIVED' else 'PARTIALLY_RECEIVED' end,
    'received', v_total_received,
    'rejected', v_total_rejected
  );
end;
$$;

revoke all on function public.receive_purchase_order(uuid, jsonb) from public;
grant execute on function public.receive_purchase_order(uuid, jsonb) to authenticated;
revoke execute on function public.receive_purchase_order(uuid, jsonb) from anon;

--------------------------------------------------------------------------------
-- 9) Dashboard overview — REAL numbers, computed from the live database.
--------------------------------------------------------------------------------
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
      'to_pack', coalesce((
        select count(*)::int from public.retail_orders o
        where o.order_type = 'retail'
          and o.payment_status = 'success'
          and o.order_status in ('cod_partial_paid','processing')
      ), 0),
      'ready_to_ship', coalesce((
        select count(*)::int from public.retail_orders o
        where o.order_type = 'retail'
          and o.payment_status = 'success'
          and o.order_status in ('cod_partial_paid','processing')
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
        select jsonb_agg(jsonb_build_object('ref', o.ref, 'total', o.total_amount, 'payment', o.payment_status, 'created', o.created_at) order by o.created_at) from (
          select o.ref, o.total_amount, o.payment_status, o.created_at
          from public.retail_orders o
          where o.order_type = 'retail'
            and o.payment_status = 'success'
            and o.order_status in ('cod_partial_paid','processing')
          order by o.created_at
          limit 12
        ) o
      ), '[]'::jsonb),
      'ready_to_ship', coalesce((
        select jsonb_agg(jsonb_build_object('ref', o.ref, 'total', o.total_amount, 'created', o.created_at) order by o.created_at) from (
          select o.ref, o.total_amount, o.created_at
          from public.retail_orders o
          where o.order_type = 'retail'
            and o.payment_status = 'success'
            and o.order_status in ('cod_partial_paid','processing')
          order by o.created_at
          limit 12
        ) o
      ), '[]'::jsonb),
      'shipment_exceptions', coalesce((
        select jsonb_agg(jsonb_build_object('ref', o.ref, 'error', o.ship_attempt_error, 'at', o.last_ship_attempt_at) order by o.last_ship_attempt_at desc) from (
          select o.ref, o.ship_attempt_error, o.last_ship_attempt_at
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

--------------------------------------------------------------------------------
-- 10) customer_overview — aggregate retail_orders by phone (real payments/lifetime)
--------------------------------------------------------------------------------
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
      coalesce(sum(case when payment_status not in ('failed','cancelled','refunded')
                        and order_status not in ('cancelled','refunded')
                    then total_amount else 0 end), 0) as total_spent,
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

-- 11) admin_analytics — top products, payment mix, status funnel, geo and
-- repeat-rate, all computed live from retail_orders (real data only).
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
        'method', t.method, 'orders', t.orders, 'revenue', t.revenue
      ) order by t.revenue desc) from (
        select
          case when coalesce(is_cod, false) then 'COD' else 'Online' end as method,
          count(*)::int as orders,
          sum(total_amount)::numeric as revenue
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
        'city', t.city, 'orders', t.orders, 'revenue', t.revenue
      ) order by t.revenue desc) from (
        select coalesce(customer->>'city', '—') as city,
               count(*)::int as orders,
               sum(total_amount)::numeric as revenue
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

notify pgrst, 'reload schema';
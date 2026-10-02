-- =============================================================================
-- Migration: 20261015000000_dslang_manual_courier_shipping.sql
--
-- MANUAL COURIER + AWB SHIPPING.
--
-- THE MODEL BEING ADDED
--   An admin packs the order, hands it to a courier, types the AWB the courier
--   gave them, and saves. The customer then sees the courier, the AWB and the
--   shipping status on the Track Order page and in My Orders. Nothing in this
--   path requires a courier API, a webhook, a working Delhivery account or any
--   credential of any kind.
--
-- FIELD REUSE (nothing duplicated)
--   retail_orders ALREADY has every physical shipping field this feature needs,
--   so no `courier_name` / `tracking_number` / `awb_number` / `tracking_url` /
--   `shipped_at` column is added. Specifically:
--     courier_name        -> the courier the admin selected
--     awb_number          -> the AWB / consignment number
--     tracking_id         -> the same AWB when there is no separate carrier id
--     tracking_url        -> a tracking link, ONLY when one really exists
--     shipped_at          -> when the parcel was handed over
--     shipping_provider   -> the courier slug (delhivery/dtdc/blue_dart/...)
--     ship_source         -> 'admin' for a hand-entered AWB
--     tracking_current_status / tracking_location / tracking_scans
--                           -> LEFT ALONE. These are the COURIER's own reported
--                              scan status, written by the Delhivery webhook. They
--                              are not the shipping lifecycle, so they are kept
--                              strictly separate and are never faked.
--
-- FIELDS ACTUALLY ADDED (the only two genuinely missing ones)
--   1. shipping_status  -- the shipping LIFECYCLE, admin/courier controlled.
--   2. delivered_at     -- there was no delivery timestamp of any kind.
--
-- WHY shipping_status IS NOT A DUPLICATE ORDER STATUS
--   order_status already exists and is NOT replaced or extended. It is the
--   coarse order lifecycle that the admin filters, the packing queue, the
--   expiry sweeper and the auto-ship sweep all read, so it keeps its existing
--   vocabulary. shipping_status is the FINE shipping state an operator actually
--   needs and order_status cannot express (packed / in_transit /
--   out_for_delivery). To stop the two from drifting into a second, conflicting
--   system, `admin_set_order_shipping` keeps them in ONE DIRECTION ONLY:
--   a post-handoff shipping_status projects onto the coarse order_status, and
--   pre-handoff states never touch order_status at all.
--
-- PAYMENT IS NOT TOUCHED
--   No column in payment_status, amount_paid_upfront, amount_due_on_delivery,
--   payment_id, is_cod or payment_discount is read-modify-written here, and no
--   function in this migration performs a payment-state change. `admin_set_order_
--   shipping` writes ONLY shipping columns. A COD order stays cod_pending with
--   0 collected and the full amount due on delivery, and an online order keeps
--   whatever the gateway verified. Historical rows are not rewritten.
--
-- DELHIVERY IS NOT REQUIRED
--   `admin_set_order_shipping` performs no network call, reads no courier
--   credential and touches no courier table. The existing Delhivery integration
--   is left exactly as it is for the future automated path, and this migration
--   additionally makes the auto-ship sweep SKIP any order that already has a
--   hand-entered AWB, so automation can never overwrite a manual shipment.
--
-- Additive: two columns, one constraint, two new functions, grants and a
-- backfill of the new column. Nothing is dropped and no order is deleted.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) shipping_status — the shipping lifecycle, independent of payment.
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists shipping_status text not null default 'pending';

comment on column public.retail_orders.shipping_status is
  'Shipping lifecycle only: pending|packed|shipped|in_transit|out_for_delivery|delivered|rto|cancelled. '
  'Independent of payment_status. order_status remains the coarse order lifecycle.';

-- Backfill so HISTORICAL orders keep showing the truth they were actually in.
-- A row that already carries an AWB is 'shipped' even if its order_status was
-- never advanced; one that was already delivered/rto/cancelled says so.
--
-- WHY THIS IS NOT `where shipping_status = 'pending'`
--   The column was just added NOT NULL DEFAULT 'pending', which in PostgreSQL
--   11+ (this database is 17.6) is a METADATA-ONLY change: every existing row
--   already reads 'pending' and no row is physically touched. A backfill
--   filtered on `shipping_status = 'pending'` therefore matches EVERY existing
--   order, including the ones already at the correct value.
--
--   Re-writing a column to the value it already holds is still a row UPDATE as
--   far as PostgreSQL is concerned, so it fires the table's BEFORE UPDATE
--   trigger `retail_orders_set_updated_at` (which unconditionally stamps
--   new.updated_at = now()) and the AFTER UPDATE trigger `admin_log_order_changes`
--   (which writes to admin_activity). That would silently rewrite `updated_at`
--   and manufacture audit-log entries on orders nobody had touched -- including
--   the four frozen legacy references, which must stay byte-identical.
--
--   So the backfill is now DIFFERENTIAL: it writes only the rows whose derived
--   state genuinely differs from what is already stored. On the current data
--   that is a single order (order_status = 'delivered', no AWB); the other six
--   rows -- including all four protected refs -- derive to 'pending', which is
--   already the column default, and are never written at all.
--
--   The derivation itself is unchanged, and this remains correct for any data
--   set: rows that need correcting get corrected, rows that do not are left
--   alone, and rows created after this migration already get their value from
--   the column default.
with derived as (
  select o.id,
         case
           when o.order_status = 'delivered' then 'delivered'
           when o.order_status = 'rto'       then 'rto'
           when o.order_status in ('cancelled', 'refunded') then 'cancelled'
           when o.order_status = 'shipped'   then 'shipped'
           when coalesce(nullif(btrim(o.awb_number), ''), nullif(btrim(o.tracking_id), '')) is not null
             then 'shipped'
           else 'pending'
         end as status
    from public.retail_orders o
)
update public.retail_orders o
   set shipping_status = d.status
  from derived d
 where d.id = o.id
   and d.status is distinct from o.shipping_status;

-- -----------------------------------------------------------------------------
-- 2) delivered_at — the one shipping timestamp that never existed.
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists delivered_at timestamptz;

comment on column public.retail_orders.delivered_at is
  'When the parcel reached the customer. Null until a delivery is actually recorded; '
  'historical delivered orders legitimately have no recorded delivery time.';

-- -----------------------------------------------------------------------------
-- 3) Guard the vocabulary. Only these states can ever be stored.
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  drop constraint if exists retail_orders_shipping_status_check;
alter table public.retail_orders
  add constraint retail_orders_shipping_status_check
  check (shipping_status in (
    'pending', 'packed', 'shipped', 'in_transit',
    'out_for_delivery', 'delivered', 'rto', 'cancelled'
  ));

-- -----------------------------------------------------------------------------
-- 4) admin_set_order_shipping — the manual AWB write path.
--
--   Admin-only, fail-closed on the SAME posture as the existing admin RPCs:
--   auth.uid() must resolve AND a row must exist in public.admin_users. The
--   grant alone is never trusted.
--
--   Invariants enforced here (not just in the UI):
--     * a post-handoff state REQUIRES an AWB, so an order can never advertise
--       "Shipped" with no waybill for the customer to look up;
--     * clearing the AWB demotes the shipping state instead of leaving a lie;
--     * tracking_url, when supplied, must be http(s) — it is rendered as a link;
--     * an AWB must look like an AWB;
--     * shipped_at / delivered_at are stamped once and never overwritten;
--     * auto_ship_at is cleared so the courier automation can never come back
--       and replace a hand-entered AWB with a parcel the admin did not ask for.
-- -----------------------------------------------------------------------------
create or replace function public.admin_set_order_shipping(
  p_order_id        uuid,
  p_courier         text,
  p_awb             text,
  p_tracking_url    text,
  p_shipping_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_row    public.retail_orders%rowtype;
  v_courier text := nullif(btrim(coalesce(p_courier, '')), '');
  v_awb     text := nullif(btrim(coalesce(p_awb, '')), '');
  v_url     text := nullif(btrim(coalesce(p_tracking_url, '')), '');
  v_status  text := lower(nullif(btrim(coalesce(p_shipping_status, '')), ''));
  v_slug    text;
  v_clamped boolean := false;
  v_patch   jsonb := '{}'::jsonb;
  v_now     timestamptz := now();
begin
  -- --- admin gate (fail closed) ---------------------------------------------
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Only an authorized administrator can update shipping details.';
  end if;

  -- --- load the order, retail only ------------------------------------------
  select * into v_row
    from public.retail_orders
   where id = p_order_id
     and order_type = 'retail'
   for update;

  if not found then
    raise exception 'Order not found.';
  end if;

  -- --- validate the shipping state ------------------------------------------
  v_status := coalesce(v_status, 'pending');
  if v_status not in (
    'pending', 'packed', 'shipped', 'in_transit',
    'out_for_delivery', 'delivered', 'rto', 'cancelled'
  ) then
    raise exception 'Unknown shipping status.';
  end if;

  -- --- validate the AWB ------------------------------------------------------
  if v_awb is not null and v_awb !~ '^[A-Za-z0-9][A-Za-z0-9-]{3,59}$' then
    raise exception 'Tracking / AWB number must be 4-60 letters, digits or dashes.';
  end if;

  -- --- validate the tracking link -------------------------------------------
  -- Only http(s). The customer pages render this as an href, so a javascript:
  -- or data: value would be a stored-XSS vector.
  if v_url is not null and v_url !~* '^https?://' then
    raise exception 'Tracking URL must start with http:// or https://';
  end if;

  -- --- an AWB is required before any post-handoff state ---------------------
  -- CASE 6 of the flow audit: an order with no AWB must never look shipped.
  if v_awb is null
     and v_status in ('shipped', 'in_transit', 'out_for_delivery', 'delivered', 'rto') then
    v_status := 'packed';
    v_clamped := true;
  end if;

  -- --- courier slug (keeps shipping_provider meaningful for the future) -----
  v_slug := case lower(v_courier)
    when 'delhivery'   then 'delhivery'
    when 'dtdc'        then 'dtdc'
    when 'blue dart'   then 'blue_dart'
    when 'india post'  then 'india_post'
    when 'other'       then 'other'
    else null
  end;

  v_patch := jsonb_build_object(
    'courier_name',      v_courier,
    'awb_number',        v_awb,
    'tracking_id',       v_awb,
    'tracking_url',      v_url,
    'shipping_status',   v_status,
    'shipping_provider', v_slug,
    -- A hand-entered AWB is recorded as exactly that, so an admin can always
    -- tell a manual shipment from an automated one.
    'ship_source',       case when v_awb is null then null else 'admin' end,
    -- The courier automation must not come back and overwrite a manual AWB.
    'auto_ship_at',      null,
    -- Shipped once, never re-stamped on a later status nudge.
    'shipped_at',        case
                           when v_awb is null and v_status in ('pending', 'packed') then null
                           when v_row.shipped_at is not null then v_row.shipped_at
                           when v_status in ('pending', 'packed') then null
                           else v_now
                         end,
    'delivered_at',      case
                           when v_awb is null then null
                           when v_row.delivered_at is not null then v_row.delivered_at
                           when v_status = 'delivered' then v_now
                           else null
                         end
  );

  -- One-way projection onto the coarse order lifecycle. Pre-handoff states are
  -- deliberately NOT written back, so this can never fight the admin's own
  -- order-status control or the packing queue.
  if v_status in ('shipped', 'in_transit', 'out_for_delivery') then
    v_patch := v_patch || jsonb_build_object('order_status', 'shipped');
  elsif v_status = 'delivered' then
    v_patch := v_patch || jsonb_build_object('order_status', 'delivered');
  elsif v_status = 'rto' then
    v_patch := v_patch || jsonb_build_object('order_status', 'rto');
  end if;

   -- Applied as explicit assignments rather than a jsonb merge so the column set
   -- is statically obvious to a reader and to `sql-structure.test.mjs`.
   -- (updated_at is maintained by the existing set_retail_order_updated_at trigger.)
   --
   -- Every timestamptz target is cast explicitly. `v_patch ->> 'col'` has the
   -- static type text, and text does not implicitly cast to timestamptz, so an
   -- uncast assignment to auto_ship_at made this statement fail on EVERY call
   -- ("column auto_ship_at is of type timestamp with time zone but expression is
   -- of type text") -- the admin Save button could never have worked.
   update public.retail_orders
     set courier_name      = v_patch ->> 'courier_name',
         awb_number        = v_patch ->> 'awb_number',
         tracking_id       = v_patch ->> 'tracking_id',
         tracking_url      = v_patch ->> 'tracking_url',
         shipping_status   = v_patch ->> 'shipping_status',
         shipping_provider = v_patch ->> 'shipping_provider',
         ship_source       = v_patch ->> 'ship_source',
         auto_ship_at      = nullif(v_patch ->> 'auto_ship_at', '')::timestamptz,
         shipped_at        = nullif(v_patch ->> 'shipped_at', '')::timestamptz,
         delivered_at      = nullif(v_patch ->> 'delivered_at', '')::timestamptz,
         order_status      = coalesce(v_patch ->> 'order_status', order_status)
   where id = p_order_id;

  return jsonb_build_object(
    'ok', true,
    'ref', v_row.ref,
    'shipping_status', v_status,
    'courier_name', v_courier,
    'awb_number', v_awb,
    'tracking_url', v_url,
    -- Echo what is NOW STORED, not "now": an order shipped last week must not
    -- report a handoff timestamp of the moment this RPC was called.
    'shipped_at', nullif(v_patch ->> 'shipped_at', ''),
    'delivered_at', nullif(v_patch ->> 'delivered_at', ''),
    -- Surfaced so the UI can explain the demotion instead of silently changing.
    'status_clamped', v_clamped,
    'note', case
      when v_clamped then
        'Saved without an AWB, so the shipping status was set to Packed. Enter the AWB to move it to Shipped.'
      else null
    end
  );
end;
$$;

comment on function public.admin_set_order_shipping(uuid, text, text, text, text) is
  'Admin-only manual courier + AWB save. Writes ONLY shipping columns; never touches payment. '
  'Requires an AWB before any post-handoff shipping status. Clears auto_ship_at so courier '
  'automation cannot overwrite a hand-entered AWB.';

revoke all on function public.admin_set_order_shipping(uuid, text, text, text, text) from public;
grant execute on function public.admin_set_order_shipping(uuid, text, text, text, text)
  to authenticated, service_role;
revoke execute on function public.admin_set_order_shipping(uuid, text, text, text, text) from anon;

-- -----------------------------------------------------------------------------
-- 5) track_order_shipping — the guest shipping projection.
--
--   `track_lookup_order` is the established, throttled, possession-gated guest
--   endpoint and its body is NOT touched here. It is a jsonb projection, so the
--   only way to surface the new columns without rewriting security-critical SQL
--   is a second, equally gated, shipping-only reader.
--
--   Same posture as the original, deliberately:
--     * identical single denial message for every failure mode, so it is not an
--       order-existence oracle;
--     * the same failed-attempt throttle, so the 10-digit phone cannot be
--       brute-forced through this second entry point either;
--     * PII-free: courier, AWB, status and timestamps only. No name, no phone,
--       no address, no money.
--
--   `tracking_url` is returned EXACTLY as stored. No fallback is invented: the
--   project previously coalesced a raw AWB into the tracking_url slot, which
--   produced a non-link in the customer's "Track" button. A link is now derived
--   by the client only for a courier whose public tracking page is known.
-- -----------------------------------------------------------------------------
create or replace function public.track_order_shipping(
  p_ref   text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_ref       text;
  v_phone     text;
  v_row       public.retail_orders%rowtype;
  v_throttled boolean;
  v_denied    jsonb := jsonb_build_object(
    'ok', false,
    'reason', 'We could not find an order matching that reference and phone number. Please check both and try again.'
  );
begin
  v_ref   := upper(btrim(coalesce(p_ref, '')));
  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');

  if v_ref = '' or v_phone = '' then
    return jsonb_build_object('ok', false, 'reason', 'Enter your order reference and phone number.');
  end if;

  select public.dslang_track_lookup_register_failure(v_ref) into v_throttled;
  if not coalesce(v_throttled, true) then
    return v_denied;
  end if;

  select * into v_row
    from public.retail_orders
   where upper(coalesce(ref, '')) = v_ref
   limit 1;

  if not found then
    return v_denied;
  end if;

  if regexp_replace(coalesce(v_row.customer->>'phone', ''), '[^0-9]', '', 'g') <> v_phone then
    return v_denied;
  end if;

  delete from public.dslang_track_lookup_attempts where ref_hash = md5(v_ref);

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object(
      'ref',             v_row.ref,
      'order_status',    v_row.order_status,
      'shipping_status', v_row.shipping_status,
      'courier_name',    v_row.courier_name,
      'awb_number',      v_row.awb_number,
      'tracking_id',     v_row.tracking_id,
      'tracking_url',    v_row.tracking_url,
      'shipped_at',      v_row.shipped_at,
      'delivered_at',    v_row.delivered_at
    )
  );
end;
$$;

comment on function public.track_order_shipping(text, text) is
  'Possession-gated, throttled, PII-free guest projection of the SHIPPING state only. '
  'Used by the Track Order page. Denies identically for no-order / wrong-phone / throttled.';

revoke all on function public.track_order_shipping(text, text) from public;
grant execute on function public.track_order_shipping(text, text)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6) Grants + an admin-only guard on the shipping columns.
--
--   WHY THERE IS NO COLUMN GRANT HERE
--   The admin UI saves shipping through `admin_set_order_shipping`, which is
--   SECURITY DEFINER, so it needs no UPDATE privilege of its own. Granting
--   authenticated a column-level UPDATE on the shipping fields would look tidy
--   and be actively harmful: `retail_orders` also has an UPDATE policy that lets
--   a signed-in customer claim a guest order they own by writing `user_id`. Under
--   a blanket/table UPDATE grant, that same customer could then PATCH their own
--   row's awb_number and shipping_status directly and completely bypass the
--   admin_users check in the RPC. The grant is therefore NOT taken.
--
--   WHY A TRIGGER INSTEAD
--   A grant is only one of the doors in. `retail_orders` already carries broad
--   table-level UPDATE privileges from its original migration, so removing a
--   grant does not close them. Enforcement therefore lives in the database, at
--   the row, where no client can talk its way around it:
--     * service_role  -> the Delhivery webhook / auto-ship sweep (they own the
--                        courier-reported scans, which are real evidence);
--     * an admin uid  -> the Admin UI, including via the SECURITY DEFINER RPC
--                        (which has already passed its own admin_users check);
--     * anything else -> refused, loudly.
--   A guest-order claim only ever writes `user_id`, so it never touches the
--   watched columns and is completely unaffected.
-- -----------------------------------------------------------------------------
-- An unauthenticated session has no legitimate reason to write a row at all.
revoke update on public.retail_orders from anon;

-- Belt and braces: if a future migration re-adds a shipping column grant, the
-- trigger below is what actually decides.
revoke update (
  courier_name,
  awb_number,
  tracking_id,
  tracking_url,
  shipping_status,
  shipped_at,
  delivered_at,
  shipping_provider,
  ship_source,
  label_url
) on public.retail_orders from authenticated;

create or replace function public.retail_orders_guard_shipping_writes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Nothing shipping-related changed. This is the ordinary order edit (status
  -- edits, the guest `user_id` claim, admin notes) and must pass straight
  -- through: this trigger guards the shipping columns, not the whole table.
  if (new.courier_name, new.awb_number, new.tracking_id, new.tracking_url,
      new.shipping_status, new.shipped_at, new.delivered_at,
      new.shipping_provider, new.ship_source, new.label_url)
     is not distinct from
     (old.courier_name, old.awb_number, old.tracking_id, old.tracking_url,
      old.shipping_status, old.shipped_at, old.delivered_at,
      old.shipping_provider, old.ship_source, old.label_url) then
    return new;
  end if;

  -- Courier automation and webhooks. They write the shipping columns on the
  -- strength of a real Delhivery event, and `tracking_current_status` beside
  -- them is only ever written this way.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- An administrator, whether writing directly or through the SECURITY DEFINER
  -- RPC (auth.uid() still resolves to the admin's JWT inside it).
  if auth.uid() is not null
     and exists (select 1 from public.admin_users where user_id = auth.uid()) then
    return new;
  end if;

  raise exception 'Shipping details can only be changed by an administrator.'
    using errcode = '42501';
end;
$$;

comment on function public.retail_orders_guard_shipping_writes() is
  'Row-level guard: only service_role or an admin_users member may write the shipping '
  'columns of retail_orders. Leaves every non-shipping write (including the guest '
  'user_id claim) untouched.';

-- It is a trigger function, so nothing needs to CALL it: the trigger invokes it
-- as the table owner. Leaving it executable by PUBLIC would be a needless
-- privilege, and it is SECURITY DEFINER, so revoke before the trigger exists.
revoke all on function public.retail_orders_guard_shipping_writes() from public;

drop trigger if exists retail_orders_guard_shipping_writes on public.retail_orders;
create trigger retail_orders_guard_shipping_writes
  before update on public.retail_orders
  for each row
  execute function public.retail_orders_guard_shipping_writes();

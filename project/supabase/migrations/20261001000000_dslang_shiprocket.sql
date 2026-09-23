-- =============================================================================
-- Migration: 20261001000000_dslang_shiprocket.sql
--
-- Shiprocket shipping integration for retail orders.
--
-- WHAT:
--   * New retail_orders columns (all nullable — non-shipped orders unaffected):
--       shiprocket_order_id      text    — Shiprocket's numeric order_id (from
--                                        Create Order), stored as text
--       awb_number               text    — the courier AWB / consignment number
--       courier_name             text    — courier company name (e.g. Delhivery)
--       label_url                text    — printable shipping label (PDF)
--       shipped_at               timestamptz — when the Shiprocket order was
--                                        created (a real "shipped" timestamp;
--                                        distinct from stock decrement at checkout)
--       shiprocket_current_status text   — latest normalized status from the
--                                        webhook (PICKED UP / IN TRANSIT /
--                                        OUT FOR DELIVERY / DELIVERED / RTO / …)
--       shiprocket_location      text    — latest scan location ("Delhi" etc.)
--       shiprocket_scans         jsonb   — raw scan trail from the webhook
--                                        (ring-buffer of recent scans)
--       shiprocket_updated_at    timestamptz — last webhook write time
--   * track_lookup_order re-created to return the SAFE shipping fields so the
--     public Track Order page can show courier + AWB + current status/location
--     WITHOUT exposing any of the scans' personal data or label PDF (the label
--     is admin-only).
--   * restock_retail_order_items skip-rule extended with the new terminal
--     order_status 'rto' (return-to-origin): a returned parcel is treated like
--     'delivered' — stock is NOT auto-restored (payment was collected; the
--     admin refunds or restocks manually as required by the COD forfeiture
--     policy).
--
-- New order_status value used by the webhook (plain text, no DDL):
--     'rto' — the parcel was returned to origin (customer refused / undeliverable).
--     'cancelled' — the shipment was cancelled at the courier.
--     'delivered' — already an existing value, now also settable by the webhook.
--
-- Idempotent + additive: `add column if not exists`, create-or-replace
-- functions, no table/column/drop. Safe to run on any current retail DB.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Shiprocket columns on retail_orders.
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists shiprocket_order_id text;

alter table public.retail_orders
  add column if not exists awb_number text;

alter table public.retail_orders
  add column if not exists courier_name text;

alter table public.retail_orders
  add column if not exists label_url text;

alter table public.retail_orders
  add column if not exists shipped_at timestamptz;

alter table public.retail_orders
  add column if not exists shiprocket_current_status text;

alter table public.retail_orders
  add column if not exists shiprocket_location text;

alter table public.retail_orders
  add column if not exists shiprocket_scans jsonb;

alter table public.retail_orders
  add column if not exists shiprocket_updated_at timestamptz;

comment on column public.retail_orders.shiprocket_order_id is
  'Shiprocket order_id from the Create Order API (numeric, stored as text). Set by the shiprocket-order edge function; the webhook matches orders by awb_number, falling back to this.';
comment on column public.retail_orders.awb_number is
  'Courier AWB / consignment number assigned to the Shiprocket order. Shown to the customer on Track Order; matched by the Shiprocket webhook.';
comment on column public.retail_orders.courier_name is
  'Courier company name assigned by Shiprocket (e.g. Delhivery). Shown to the customer on Track Order.';
comment on column public.retail_orders.label_url is
  'Printable shipping label (PDF) from Shiprocket. Admin-only (track_lookup_order deliberately does not return it).';
comment on column public.retail_orders.shipped_at is
  'Timestamp when the Shiprocket order was created by the admin (real dispatch marker). NULL until the order is actually shipped.';
comment on column public.retail_orders.shiprocket_current_status is
  'Latest normalized Shiprocket tracking status (PICKED UP / IN TRANSIT / OUT FOR DELIVERY / DELIVERED / RTO / …). Maintained by the shiprocket-webhook.';
comment on column public.retail_orders.shiprocket_location is
  'Latest scan location from the Shiprocket webhook (e.g. "Delhi"). Shown to the customer on Track Order.';
comment on column public.retail_orders.shiprocket_scans is
  'Recent scan trail from the Shiprocket webhook (status + location + timestamp per scan). Diagnostics only — not returned by track_lookup_order.';
comment on column public.retail_orders.shiprocket_updated_at is
  'Timestamp of the last Shiprocket webhook write to this order.';

-- -----------------------------------------------------------------------------
-- 2) track_lookup_order — expose the SAFE shipping fields to Track Order.
--    Keeps the same signature and security model (ref + 10-digit phone, no
--    personal data). The label_url and raw scans are intentionally EXCLUDED.
-- -----------------------------------------------------------------------------
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
  -- Personal data (customer object) is deliberately NOT included.
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
      'tracking_id', v_row.tracking_id,
      'tracking_url', v_row.tracking_url,
      'courier_name', v_row.courier_name,
      'awb_number', v_row.awb_number,
      'shiprocket_current_status', v_row.shiprocket_current_status,
      'shiprocket_location', v_row.shiprocket_location,
      'shiprocket_updated_at', v_row.shiprocket_updated_at,
      'items', v_safe
    )
  );
end;
$$;

revoke all on function public.track_lookup_order(text, text) from public;
grant execute on function public.track_lookup_order(text, text)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3) restock_retail_order_items — treat the new terminal 'rto' status like
--    'delivered': the parcel left the building, so the sweep must NOT restore
--    stock automatically (payment was collected; refunds/restock are manual).
-- -----------------------------------------------------------------------------
create or replace function public.restock_retail_order_items(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.retail_orders%rowtype;
  v_updated integer := 0;
begin
  if p_order_id is null then
    return 0;
  end if;

  -- Lock the order row so concurrent webhook / status-poll / admin-delete
  -- paths serialize to a single restock. The lock is held until commit.
  select * into v_order
  from public.retail_orders
  where id = p_order_id
    and order_type = 'retail'
  for update;

  if not found then
    return 0;
  end if;

  -- Skip: paid order, or stock already gone out (fulfilled/refunded/rto).
  if v_order.payment_status = 'success' then
    return 0;
  end if;
  if v_order.order_status in ('shipped', 'delivered', 'refunded', 'rto') then
    return 0;
  end if;

  -- Skip: already restocked (idempotency guard).
  if v_order.stock_restored_at is not null then
    return 0;
  end if;

  -- Add the order's quantities back, aggregated per product/colour/size so a
  -- multi-line or duplicate-line order updates each stock row exactly once.
  update public.product_sizes ps
  set stock = ps.stock + s.qty,
      available = (ps.stock + s.qty) > 0
  from (
    select (x.item->>'product_id')::uuid  as product_id,
           (x.item->>'color_id')::uuid    as color_id,
           x.item->>'size_label'          as size_label,
           sum((x.item->>'quantity')::int) as qty
    from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) as x(item)
    where coalesce((x.item->>'quantity')::int, 0) > 0
      and x.item->>'product_id' is not null
      and x.item->>'color_id' is not null
      and x.item->>'size_label' is not null
    group by 1, 2, 3
  ) s
  where ps.product_id = s.product_id
    and ps.color_id = s.color_id
    and ps.size_label = s.size_label;

  get diagnostics v_updated = row_count;

  -- Mark restocked (NULL -> now) so a second call is a no-op.
  update public.retail_orders
  set stock_restored_at = now()
  where id = v_order.id;

  return v_updated;
end;
$$;

revoke all on function public.restock_retail_order_items(uuid) from public;
grant execute on function public.restock_retail_order_items(uuid)
  to service_role;

-- This DB ships default privileges that auto-grant EXECUTE to
-- anon/authenticated/service_role on every new function, so REVOKE FROM PUBLIC
-- above is not enough — the per-role grants are explicit in the ACL. restock
-- must be service_role-ONLY (it has no in-body auth gate of its own).
revoke execute on function public.restock_retail_order_items(uuid) from anon;
revoke execute on function public.restock_retail_order_items(uuid) from authenticated;

notify pgrst, 'reload schema';
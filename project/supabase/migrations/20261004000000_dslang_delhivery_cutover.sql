-- =============================================================================
-- Migration: 20261004000000_dslang_delhivery_cutover.sql
--
-- Provider cutover: Shiprocket → Delhivery (retail shipping).
--
-- WHAT:
--   * Adds `shipping_provider` — the single neutral discriminator
--     ('delhivery' going forward). NULL = legacy/manual orders that predate the
--     field (same convention as auto_ship_at). This is the ONLY new shipping
--     column: every provider-neutral value already has a home, and we REUSE
--     them — no duplicate columns:
--         awb_number            ← Delhivery waybill
--         tracking_id           ← Delhivery AWB (mirror of waybill, kept in sync)
--         tracking_url          ← https://www.delhivery.com/track/package/<awb>
--         courier_name          ← courier assigned in the create-order response
--         label_url             ← shipping label PDF
--         shipped_at            ← when the Delhivery order was created
--         ship_attempt_error / last_ship_attempt_at / auto_ship_at
--                              ← unchanged auto-ship machinery (provider-neutral)
--   * Marks the existing shiprocket_* columns LEGACY READ-ONLY: they keep their
--     values for historical order data (Track Order + Admin fall back to them
--     when shipping_provider is null / not 'delhivery'), but nothing writes
--     them going forward. This preserves the audit trail for the live Shiprocket
--     order (1602319821 / DSL-R-231A3FEE) the admin cancels in the dashboard.
--   * Drops the EMPTY fastrr scaffold columns (fastrr_order_id,
--     fastrr_payment_ref, fastrr_payment_status). The fastrr integration was
--     never enabled (FASTRR_CHECKOUT_ENABLED=false) and its columns were never
--     populated, so this is data-loss-free. The provider-agnostic
--     webhook_receive inbox is KEPT — the Delhivery webhook uses it.
--
-- Idempotent + additive where there's data. Safe on any current retail DB.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) shipping_provider — neutral discriminator.
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists shipping_provider text;

comment on column public.retail_orders.shipping_provider is
  'Shipping provider that owns the live shipment for this order. ''delhivery'' '
  '(the only value auto/production path can write) or NULL for legacy/manual '
  'orders that predate the field. Historical orders created via Shiprocket keep '
  'their shiprocket_* columns as a read-only fallback; the app reads neutral '
  'columns (awb_number/tracking_id/tracking_url/courier_name/label_url/'
  'shipped_at) and only falls back to shiprocket_* when shipping_provider is '
  'NULL or legacy. Never stores secrets.';

-- -----------------------------------------------------------------------------
-- 2) Drop empty fastrr scaffold columns (never populated — safe).
--    NOTE: intentionally NOT dropped: webhook_receive (used by delhivery-webhook).
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  drop column if exists fastrr_order_id;
alter table public.retail_orders
  drop column if exists fastrr_payment_ref;
alter table public.retail_orders
  drop column if exists fastrr_payment_status;

-- Partial unique index no longer has anything to index (column is gone).
drop index if exists public.idx_retail_orders_fastrr_order_id;

-- -----------------------------------------------------------------------------
-- 3) Mark Shiprocket columns legacy (docs only — data untouched).
-- -----------------------------------------------------------------------------
comment on column public.retail_orders.shiprocket_order_id is
  'LEGACY (read-only): Shiprocket order id for historical orders created before '
  'the Delhivery cutover. NULL for everything going forward. See retail_orders.'
  'shipping_provider / awb_number / tracking_* for the neutral fields the app '
  'now reads.';

comment on column public.retail_orders.shiprocket_current_status is
  'LEGACY (read-only): last normalized Shiprocket tracking status. Historical '
  'fallback only; the Delhivery webhook writes the neutral columns instead.';

comment on column public.retail_orders.shiprocket_location is
  'LEGACY (read-only): last Shiprocket scan location. Historical fallback only.';

comment on column public.retail_orders.shiprocket_scans is
  'LEGACY (read-only): Shiprocket scan trail. Historical fallback only.';

comment on column public.retail_orders.shiprocket_updated_at is
  'LEGACY (read-only): last Shiprocket webhook write. Historical fallback only.';

comment on column public.retail_orders.auto_ship_at is
  'When the automatic Delhivery shipment becomes due (set by the cashfree '
  'webhook to paid_at + grace minutes, default 45). NULL = no auto-ship armed '
  '(legacy / manual-only order). Cleared once shipped.';

-- -----------------------------------------------------------------------------
-- 4) Track lookup returns provider-neutral shipping (legacy-safe fallback) and
--    reflects Delhivery when available ticker = the live field.
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

  if regexp_replace(coalesce(v_row.customer->>'phone', ''), '[^0-9]', '', 'g') <> v_phone then
    return jsonb_build_object('ok', false, 'reason', 'This order reference and phone number do not match.');
  end if;

  -- Items: code/name/color/size/quantity/line_total only. NO personal data.
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

  -- Provider-neutral live fields; legacy Shiprocket fallback ONLY for
  -- historical orders (shipping_provider IS NULL/Legacy).
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
      -- Neutral (reads live columns; shiprocket_* only as last resort):
      'tracking_id', coalesce(v_row.tracking_id, v_row.shiprocket_order_id),
      'tracking_url', coalesce(v_row.tracking_url, v_row.awb_number, v_row.awb_number),
      'courier_name', coalesce(v_row.courier_name, v_row.shiprocket_location),
      'awb_number', coalesce(v_row.awb_number, v_row.awb_number),
      'shipping_provider', v_row.shipping_provider,
      'shipped_at', v_row.shipped_at,
      -- Legacy aliases kept for backward-compat UI reads:
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

notify pgrst, 'reload schema';

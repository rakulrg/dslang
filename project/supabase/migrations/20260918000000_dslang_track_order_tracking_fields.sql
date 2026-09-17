-- =============================================================================
-- Migration: 20260918000000_dslang_track_order_tracking_fields.sql
--
-- Exposes the shipment tracking fields on the public Track Order page.
-- retail_orders.tracking_id / tracking_url were added by
-- 20260916000000_dslang_shipping_notification.sql and are filled in by the
-- admin (Retail Orders panel). The storefront's safe lookup function
-- track_lookup_order did NOT return them, so customers could never see the
-- courier AWB/link the admin saved. This migration re-creates the function to
-- include both fields (NULL-safe). Everything else about the lookup stays
-- identical: SECURITY DEFINER, ref + 10-digit phone required, no customer
-- personal data, no order enumeration risk.
--
-- Idempotent and self-sufficient (safe to run on any current retail DB).
-- =============================================================================

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
      'tracking_id', v_row.tracking_id,
      'tracking_url', v_row.tracking_url,
      'items', v_safe
    )
  );
end;
$$;

revoke all on function public.track_lookup_order(text, text) from public;
grant execute on function public.track_lookup_order(text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
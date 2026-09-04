-- =============================================================================
-- Migration: 20260910000000_dslang_retail_sms_and_tracking.sql
--
-- Two additions for the retail/order-completion upgrade:
--   1) retail_orders.sms_sent_at — idempotency flag for the order-confirmation
--      SMS Edge Function (send-order-sms). Set server-side (service_role) ONLY
--      after a REAL, successful SMS send, so the confirmation SMS is never
--      flushed more than once even if the webhook/status callback fires many
--      times. NULL = not sent yet.
--   2) public.track_lookup_order(ref, phone) — a SECURITY DEFINER RPC exposing
--      only a safe, limited subset of an order for the public Track Order page.
--      It intentionally returns product NAMES/quantities and order totals/status
--      (non-sensitive), but NEVER the customer's personal data, and it requires
--      BOTH the order ref AND the customer's 10-digit phone to match, so no one
--      can enumerate orders.
--
-- This file is idempotent and self-sufficient (safe to run on any current
-- retail DB). No existing table/function/column is dropped or renamed.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Sms idempotency flag on retail_orders.
-- ---------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists sms_sent_at timestamptz;

comment on column public.retail_orders.sms_sent_at is
  'Verified timestamp of the order-confirmation SMS — set server-side only, after a real send. NULL = not sent/handled yet. Idempotency guard for the order SMS.';

-- ---------------------------------------------------------------------------
-- 2) track_lookup_order — secure, limited public order lookup.
--    Signature: track_lookup_order(p_ref text, p_phone text) returns jsonb.
-- ---------------------------------------------------------------------------
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
      'items', v_safe
    )
  );
end;
$$;

revoke all on function public.track_lookup_order(text, text) from public;
grant execute on function public.track_lookup_order(text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- =============================================================================
-- Migration: 20260916000000_dslang_shipping_notification.sql
--
-- Fulfillment/tracking fields for the post-payment Shopify-style flow:
--   1) retail_orders.tracking_id  — courier tracking/AWB number (e.g. Delhivery,
--                                   India Post). NULL = not shipped yet.
--   2) retail_orders.tracking_url — optional courier tracking page URL (only if
--                                   the courier exposes a direct link).
--   3) retail_orders.shipping_sms_sent_at — idempotency flag for the
--      notify-shipping Edge Function (SMS + WhatsApp on the Shipped transition).
--      Deliberately SEPARATE from sms_sent_at (the order-confirmation SMS), so
--      customers get two distinct messages: one at order placement, one at
--      shipping. Set server-side (service_role) ONLY after a real send.
--
-- Idempotent and additive: no table/column/function is dropped or renamed.
-- =============================================================================

alter table public.retail_orders
  add column if not exists tracking_id text,
  add column if not exists tracking_url text,
  add column if not exists shipping_sms_sent_at timestamptz;

comment on column public.retail_orders.tracking_id is
  'Courier tracking number (AWB / consignment ID). NULL until the order ships.';

comment on column public.retail_orders.tracking_url is
  'Optional courier tracking page URL shown to the customer with the tracking ID.';

comment on column public.retail_orders.shipping_sms_sent_at is
  'Verified timestamp of the shipping notification (SMS + WhatsApp) — set server-side only, after a real send. NULL = not notified yet. Separate from sms_sent_at (order confirmation).';
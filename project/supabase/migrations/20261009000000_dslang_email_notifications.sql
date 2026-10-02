-- =============================================================================
-- Migration: 20261009000000_dslang_email_notifications.sql
--
-- Per-order transactional-email audit trail for the email-notification feature
-- (replaces the old WhatsApp-based order-update flow):
--
--   * last_email_kind      — which template was sent last: 'confirmed' (order
--                            placed/paid) or 'shipped' (AWB assigned).
--   * last_email_sent_at   — when it was sent.
--
-- Writers: the shared _shared/emails.ts helper (called by the payment-success
-- trigger, the shipment-success core, and the admin send-order-mail function).
-- The Admin order detail reads these to show "Email sent · {kind} · {time}" +
-- a Resend button. Every send overwrites the pair (one row, latest wins).
--
-- Idempotent + additive. Safe on any current retail DB.
-- =============================================================================

alter table public.retail_orders
  add column if not exists last_email_kind text;

alter table public.retail_orders
  add column if not exists last_email_sent_at timestamptz;

comment on column public.retail_orders.last_email_kind is
  'Last transactional email sent for this order (confirmed | shipped). Written '
  'by _shared/emails.ts; read by the Admin email-status indicator.';

comment on column public.retail_orders.last_email_sent_at is
  'Timestamp of the last transactional email sent for this order.';

notify pgrst, 'reload schema';
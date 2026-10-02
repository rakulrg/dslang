-- =============================================================================
-- Migration: 20261008000000_dslang_delhivery_tracking_columns.sql
--
-- Neutral live-tracking columns on retail_orders. The app (Track Order page,
-- Admin shipping panel) and the Delhivery push-tracking webhook already wrote
-- these four columns, but NO migration ever added them to a fresh DB — so the
-- webhook's tracking updates failed (column does not exist) and live tracking
-- state had nowhere to live. This migration makes the schema match the code.
--
-- Provider-neutral (same philosophy as awb_number/tracking_id): the values are
-- written by the Delhivery adapter/webhook and read by the UI; the legacy
-- shiprocket_* columns remain read-only fallback for historical rows.
--
-- Idempotent + additive. Safe on any current retail DB.
-- =============================================================================

alter table public.retail_orders
  add column if not exists tracking_current_status text;

alter table public.retail_orders
  add column if not exists tracking_location text;

alter table public.retail_orders
  add column if not exists tracking_scans jsonb;

alter table public.retail_orders
  add column if not exists last_tracking_sync_at timestamptz;

comment on column public.retail_orders.tracking_current_status is
  'Latest normalized shipment status (shipped/delivered/undelivered/returned). '
  'Stamped ''shipped'' at shipment creation; refined by the Delhivery webhook as '
  'scans arrive. Provider-neutral counterpart of shiprocket_current_status.';

comment on column public.retail_orders.tracking_location is
  'Latest scan location (provider-neutral). Mirror of shiprocket_location.';

comment on column public.retail_orders.tracking_scans is
  'Raw scan trail from the provider webhook (provider-neutral). Mirror of '
  'shiprocket_scans.';

comment on column public.retail_orders.last_tracking_sync_at is
  'Last time live tracking state was written (provider-neutral). Mirror of '
  'shiprocket_updated_at.';

notify pgrst, 'reload schema';
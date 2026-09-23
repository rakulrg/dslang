-- =============================================================================
-- Migration: 20261002000000_dslang_fastrr_scaffold.sql
--
-- Shape-independent scaffold for the fastrr (Shiprocket Checkout) integration.
--
-- WHY "scaffold": the official fastrr API contracts (session creation, hosted
-- handoff, webhook payload schema/signature) are NOT documented publicly and
-- we do not yet have the merchant's Postman collection / a real webhook sample.
-- This migration therefore ONLY adds (1) nullable business fields that store
-- fastrr's identifiers next to our order, and (2) a provider-agnostic webhook
-- inbox table. Nothing here invents a fastrr field name or payload shape — the
-- adapter layer maps real event bodies to these columns later, and only then.
--
-- WHAT:
--   * retail_orders gains five nullable columns:
--       fastrr_order_id       text — fastrr/Shiprocket-Checkout order id we got
--                              back when handing off this DSLANG order (unique
--                              index allows any number of NULLs).
--       fastrr_payment_ref    text — fastrr's payment/reference id for the
--                              completed transaction (reuse is deliberate: the
--                              existing payment_id/txn_id remain Cashfree's).
--       fastrr_payment_status text — fastrr's own payment state string, kept
--                              raw for diagnostics. DSLANG's authoritative
--                              payment_status is still updated only on
--                              confirmation, never copied verbatim.
--       ship_attempt_error    text — last auto-ship failure reason (clean,
--                              human-readable, from processEligibleShipment).
--       last_ship_attempt_at  timestamptz — every time auto/manual shipping was
--                              attempted (success or failure), for RETRY
--                              semantics + later reconciliation. NOT a timer
--                              sweep trigger — the fastrr paid webhook is.
--     Every existing payment/shiprocket/tracking column is REUSED as-is; no
--     secret, key, token or signature is ever stored on retail_orders.
--   * webhook_receive — generic inbound webhook inbox for fastrr (and future
--     providers): raw payload preserved verbatim, idempotency via a partial
--     unique index on (provider, external_event_id). Service-role only (RLS on,
--     no policies, explicit revokes) — the inbox is NEVER readable or writable
--     by anon/authenticated. No headers/auth material are stored.
--
-- Idempotent + additive. Safe on any current retail DB.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) fastrr fields on retail_orders (all nullable; unique index tolerates NULLs).
-- -----------------------------------------------------------------------------
alter table public.retail_orders
  add column if not exists fastrr_order_id text;

alter table public.retail_orders
  add column if not exists fastrr_payment_ref text;

alter table public.retail_orders
  add column if not exists fastrr_payment_status text;

alter table public.retail_orders
  add column if not exists ship_attempt_error text;

alter table public.retail_orders
  add column if not exists last_ship_attempt_at timestamptz;

alter table public.retail_orders
  add column if not exists ship_source text;

comment on column public.retail_orders.ship_source is
  'Who created the shipment: ''fastrr'' (automatically by the paid webhook) or ''admin'' (manual Ship Order / RETRY). NULL = legacy/manual before this field existed.';

comment on column public.retail_orders.fastrr_order_id is
  'fastrr (Shiprocket Checkout) order id returned when a DSLANG order is handed off. NULL until a fastrr session exists. One checkout = one order row: the fastrr webhook MATCHES this id, it NEVER creates a new retail_orders row.';
comment on column public.retail_orders.fastrr_payment_ref is
  'fastrr payment/reference id for the completed transaction (kept for reconciliation). Existing payment_id / txn_id stay the Cashfree gateway ids; this is fastrr''s own identifier.';
comment on column public.retail_orders.fastrr_payment_status is
  'fastrr''s raw payment-state string, diagnostic only. DSLANG''s authoritative payment_status flips to success ONLY on provider confirmation.';
comment on column public.retail_orders.ship_attempt_error is
  'Human-readable reason for the last failed Shiprocket auto-ship attempt (shown in Admin SHIPMENT NOT CREATED). Cleared on a successful attempt.';
comment on column public.retail_orders.last_ship_attempt_at is
  'Timestamp of the most recent auto/manual Shiprocket shipment attempt, success or failure. Written BEFORE any call so RETRY can prove it ran. The fastrr paid webhook is the trigger; this column only supports retries/reconciliation, never a sweep.';

-- One fastrr order belongs to at most one DSLANG order. NULLs stay allowed
-- (multiple pre-fastrr rows), so the constraint is a partial unique index.
create unique index if not exists idx_retail_orders_fastrr_order_id
  on public.retail_orders (fastrr_order_id)
  where fastrr_order_id is not null;

-- -----------------------------------------------------------------------------
-- 2) webhook_receive — provider-agnostic inbound inbox (service-role only).
-- -----------------------------------------------------------------------------
create table if not exists public.webhook_receive (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text,
  external_event_id text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'pending',
  processing_error text
);

-- Idempotency: a provider+gated event id may only be ingested once. NULL event
-- ids (providers that send no stable id) are uncapped — dedupe must then run at
-- the business layer.
create unique index if not exists webhook_receive_provider_event_uidx
  on public.webhook_receive (provider, external_event_id)
  where external_event_id is not null;

-- The auto-ship worker walks the inbox by claimed-but-unprocessed rows.
create index if not exists webhook_receive_status_created_idx
  on public.webhook_receive (processing_status, received_at)
  where processing_status = 'pending';

alter table public.webhook_receive enable row level security;

-- The inbox must stay invisible to anon/authenticated. RLS with zero policies
-- already denies every role except service_role (which bypasses RLS); the
-- explicit revokes below harden the table-level grants as a second layer.
revoke all on public.webhook_receive from anon;
revoke all on public.webhook_receive from authenticated;
revoke all on public.webhook_receive from public;
grant  all on table public.webhook_receive to service_role;

comment on table public.webhook_receive is
  'Provider-agnostic inbound webhook inbox. Raw payloads preserved verbatim for replay/debug; headers and any secret material are NEVER stored. Service-role only.';
comment on column public.webhook_receive.provider is
  'Provider key (e.g. "fastrr", "shiprocket", "cashfree").';
comment on column public.webhook_receive.event_type is
  'Provider event type (e.g. payment-paid). Best-effort; NULL when the provider sends none.';
comment on column public.webhook_receive.external_event_id is
  'Provider event id, when one exists. The (provider, external_event_id) partial unique index makes replayed webhooks safe to re-ACK. NULL when the provider has no stable id.';
comment on column public.webhook_receive.payload is
  'The RAW webhook body as received (JSON), never a normalized subset.';
comment on column public.webhook_receive.processing_status is
  'pending -> processing -> processed | failed | ignored. Written by the provider webhook worker.';
comment on column public.webhook_receive.processing_error is
  'Last processing error message (human-readable) when processing failed.';

notify pgrst, 'reload schema';
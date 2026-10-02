-- =============================================================================
-- Migration: 20261011000000_dslang_track_lookup_throttle.sql
--
-- Hardens the PUBLIC guest tracking endpoint `track_lookup_order(ref, phone)`.
--
-- THE PROBLEM: the function is granted to `anon`, so anyone on the internet can
-- call it. Possession of the ref AND the customer's 10-digit phone is required
-- before anything is returned, and the projection is already PII-free — but the
-- two failure modes were DISTINCT messages ("Order not found" vs "reference and
-- phone do not match"). That difference is an enumeration oracle: it let anyone
-- confirm which order references are real, and left the 10-digit phone open to
-- unbounded guessing.
--
-- THE FIX (two independent controls):
--   1. NO EXISTENCE DISCLOSURE. "No such order", "wrong phone" and "throttled"
--      all return ONE identical response. A caller can no longer learn whether
--      a reference exists, and cannot use response shape as a signal.
--   2. THROTTLE FAILED ATTEMPTS. Only FAILED attempts count. A successful
--      lookup already proves possession, so it has no enumeration value and is
--      never counted — which means the Track Order page's 30s auto-poll (always
--      successful after the first hit) can never trip the limit. A caller
--      guessing phones gets 10 tries per reference per 15-minute window, then
--      the lookup short-circuits before the phone is even compared.
--
-- WHAT DID NOT CHANGE:
--   * Signature, return shape, grants (anon, authenticated, service_role) and
--     the `security definer` + `set search_path = public` posture.
--   * The success projection: exactly the same fields, still PII-free (no name,
--     no phone, no address).
--   * The blank-input validation message the form relies on for its own
--     client-side hint.
--   * The frontend needs no change: it renders `reason` verbatim, so the single
--     generic message displays correctly.
--
-- STORAGE: only an md5 HASH of the reference is stored — never the reference
-- itself, and never a phone number. RLS is enabled with no policies, so only the
-- security-definer path (service_role) can ever touch the table.
--
-- Additive + idempotent: a new table, one new helper, and a create-or-replace
-- of an existing function. No order, product or customer data is read or written.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Failure-attempt ledger. One row per (hashed) reference.
-- -----------------------------------------------------------------------------
create table if not exists public.dslang_track_lookup_attempts (
  ref_hash          text        primary key,
  window_started_at timestamptz not null default now(),
  attempts          integer     not null default 1,
  constraint dslang_track_attempts_positive check (attempts >= 1)
);

comment on table public.dslang_track_lookup_attempts is
  'Per-reference failed-attempt counter backing the track_lookup_order throttle. '
  'Stores only an md5 hash of the order reference — never the reference, never a phone number.';

alter table public.dslang_track_lookup_attempts enable row level security;

create index if not exists idx_dslang_track_attempts_window
  on public.dslang_track_lookup_attempts (window_started_at);

-- -----------------------------------------------------------------------------
-- 2) dslang_track_lookup_register_failure(ref) -> boolean
--    Records one FAILED attempt and reports whether the caller may keep trying
--    in the current window. Idempotent-safe under concurrency: the upsert takes a
--    row lock, so two parallel guesses cannot both read the same counter value.
-- -----------------------------------------------------------------------------
create or replace function public.dslang_track_lookup_register_failure(p_ref text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_hash    text;
  v_attempts integer;
  v_window  interval := interval '15 minutes';
  v_limit   constant integer := 10;
begin
  v_hash := md5(upper(btrim(coalesce(p_ref, ''))));
  if v_hash = md5('') then
    return false;
  end if;

  -- Opportunistic cleanup keeps the ledger tiny. Only rows whose window closed
  -- more than a day ago are removed, so it can never disturb a live window.
  delete from public.dslang_track_lookup_attempts
   where window_started_at < now() - interval '1 day';

  insert into public.dslang_track_lookup_attempts as t (ref_hash, window_started_at, attempts)
  values (v_hash, now(), 1)
  on conflict (ref_hash) do update
     set attempts = case
                       when t.window_started_at < now() - v_window then 1
                       else t.attempts + 1
                     end,
         window_started_at = case
                       when t.window_started_at < now() - v_window then now()
                       else t.window_started_at
                     end
  returning attempts into v_attempts;

  return v_attempts <= v_limit;
end;
$$;

revoke all on function public.dslang_track_lookup_register_failure(text) from public;
grant execute on function public.dslang_track_lookup_register_failure(text) to service_role;

comment on function public.dslang_track_lookup_register_failure(text) is
  'Record one failed track_lookup_order attempt for a reference. Returns false once the '
  'reference exceeds 10 failures in a 15-minute window. Stores only md5(ref).';

-- -----------------------------------------------------------------------------
-- 3) track_lookup_order — re-created with the throttle gate and a single,
--    existence-neutral failure message.
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
  v_throttled boolean;
  -- ONE message for every failure mode. This is the whole point: the caller
  -- cannot distinguish "no such order" from "wrong phone" from "too many
  -- attempts", so the endpoint stops being an order-existence oracle.
  v_denied jsonb := jsonb_build_object(
    'ok', false,
    'reason', 'We could not find an order matching that reference and phone number. Please check both and try again.'
  );
begin
  v_ref := upper(trim(coalesce(p_ref, '')));
  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');

  -- Client-side validation hint. Carries no information about any order.
  if v_ref = '' or v_phone = '' then
    return jsonb_build_object('ok', false, 'reason', 'Enter your order reference and phone number.');
  end if;

  -- Throttle gate: once this reference has burned its failed-attempt budget in
  -- the current window, stop before touching retail_orders at all.
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

  -- SUCCESS: a failed-attempt counter reset is enough. Successful lookups are
  -- never counted, so a legitimate customer's repeated tracking/polling is
  -- never throttled.
  delete from public.dslang_track_lookup_attempts where ref_hash = md5(v_ref);

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

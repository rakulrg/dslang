-- =============================================================================
-- DSLANG — Customer cancellation REQUEST + admin approval workflow
-- =============================================================================
--
-- A customer may ASK for an order to be cancelled. Asking changes NOTHING: no
-- order status, no payment status, no stock, no refund. It writes exactly one
-- row into `order_cancellation_requests`, and an administrator then approves or
-- rejects it. Only a successful APPROVAL cancels the order and releases the
-- reservation, and it does so through the existing, already-idempotent
-- `restock_retail_order_items` (guarded by `retail_orders.stock_restored_at`).
--
-- WHY A SEPARATE TABLE AND NOT A COLUMN:
--   The request has its OWN lifecycle (pending/approved/rejected) that must stay
--   distinct from `order_status`, from `payment_status`, and from refund state.
--   Overloading `order_status` (e.g. 'cancelled' to mean "asked") would make a
--   pending request indistinguishable from a real cancellation everywhere the
--   restock/delete/payment guards branch on that column, and would let a request
--   silently look like a released order. Separate state, separate table.
--
-- WHAT IS DELIBERATELY NOT HERE:
--   * No refund API. The audit confirmed DSLANG has NO automated refund path
--     (no Cashfree /refunds call, no refund RPC, no refund column). Refunds are
--     MANUAL and happen outside this system, so this migration only TRACKS a
--     manual refund's pending/completed state. `payment_status` is never set to
--     'refunded' by an approval — only by the separate, explicit completion RPC.
--   * No guest cancellation flow. Requests require an authenticated OWNER
--     (`user_id = auth.uid()`). Guest-order access elsewhere is untouched.
--   * No stock write of any kind. The ONLY release is the call to
--     `public.restock_retail_order_items`, whose `stock_restored_at` guard is the
--     exactly-once mechanism that the sweep and the delete paths already rely on.
--
-- AUTHORIZATION MODEL (server-side, never the UI):
--   `request_order_cancellation`  -> authenticated, and must OWN the order.
--   `decide_order_cancellation`   -> must be a member of public.admin_users.
--   `complete_order_cancellation_refund` -> must be a member of public.admin_users.
--   The admin gate is enforced INSIDE the functions, so a customer calling the
--   admin RPC directly is refused with 42501 regardless of what the UI shows.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) The request table.
-- -----------------------------------------------------------------------------
create table if not exists public.order_cancellation_requests (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.retail_orders(id) on delete cascade,
  -- Denormalised so the admin queue can render without a join, and so the record
  -- survives even if the order row were later deleted by an admin (ON DELETE
  -- CASCADE removes it then anyway; the ref is kept for audit snapshots).
  order_ref        text not null,
  user_id          uuid not null references auth.users(id) on delete cascade,
  reason           text,
  -- Request lifecycle. SEPARATE from order_status / payment_status / refund_status.
  request_status   text not null default 'pending',
  requested_at     timestamptz not null default now(),
  decided_by       uuid references auth.users(id),
  decided_at       timestamptz,
  decision_note    text,
  -- Audit mirror of the exactly-once stock release (the authority is still
  -- retail_orders.stock_restored_at, set by restock_retail_order_items).
  stock_released_at timestamptz,
  -- Manual-refund tracking. Independent of payment_status: an approved paid
  -- order is 'refund_pending' while its payment_status stays 'success'.
  refund_status    text not null default 'none',
  refund_amount    numeric,
  refund_completed_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Add the check constraints defensively (idempotent: table may pre-exist in a
-- re-run scenario, though normally this creates it fresh).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_cancellation_requests_status_chk'
  ) then
    alter table public.order_cancellation_requests
      add constraint order_cancellation_requests_status_chk
      check (request_status in ('pending', 'approved', 'rejected', 'withdrawn'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'order_cancellation_requests_refund_chk'
  ) then
    alter table public.order_cancellation_requests
      add constraint order_cancellation_requests_refund_chk
      check (refund_status in ('none', 'not_applicable', 'refund_pending', 'refund_completed'));
  end if;
end $$;

-- Duplicate prevention: at most ONE live request per order. A partial unique
-- index (only 'pending' rows) is what makes re-submitting after a decision
-- possible while making a second concurrent submit a no-op.
create unique index if not exists order_cancellation_requests_one_pending_idx
  on public.order_cancellation_requests (order_id)
  where request_status = 'pending';

create index if not exists order_cancellation_requests_queue_idx
  on public.order_cancellation_requests (request_status, requested_at desc);

create index if not exists order_cancellation_requests_refund_idx
  on public.order_cancellation_requests (refund_status)
  where refund_status = 'refund_pending';

-- -----------------------------------------------------------------------------
-- 2) Row security. A customer sees only their own requests; an admin sees all.
--    There is NO client INSERT/UPDATE/DELETE policy: every write goes through a
--    SECURITY DEFINER function, exactly like retail_orders.
-- -----------------------------------------------------------------------------
alter table public.order_cancellation_requests enable row level security;

drop policy if exists "order_cancellation_requests_read" on public.order_cancellation_requests;
create policy "order_cancellation_requests_read"
  on public.order_cancellation_requests for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.admin_users where user_id = auth.uid())
  );

revoke insert, update, delete, truncate, references, trigger
  on table public.order_cancellation_requests from anon, authenticated;
grant select on table public.order_cancellation_requests to authenticated;

-- -----------------------------------------------------------------------------
-- 3) updated_at stamp (mirrors the retail_orders helper).
-- -----------------------------------------------------------------------------
create or replace function public.set_order_cancellation_request_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists order_cancellation_requests_updated_at on public.order_cancellation_requests;
create trigger order_cancellation_requests_updated_at
  before update on public.order_cancellation_requests
  for each row
  execute function public.set_order_cancellation_request_updated_at();

-- -----------------------------------------------------------------------------
-- 4) CUSTOMER — submit a request. Changes NOTHING but this table.
-- -----------------------------------------------------------------------------
create or replace function public.request_order_cancellation(
  p_ref    text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid      uuid := auth.uid();
  v_ref      text := nullif(btrim(coalesce(p_ref, '')), '');
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_order    public.retail_orders%rowtype;
  v_existing uuid;
  v_id       uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  if v_ref is null then
    return jsonb_build_object('ok', false, 'reason', 'no_ref');
  end if;

  -- Lock the order so a concurrent submit (or an admin decision) cannot race the
  -- duplicate check below.
  select * into v_order
  from public.retail_orders
  where ref = v_ref
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Ownership. An order owned by someone else, or an unclaimed guest order, is
  -- not requestable in this release (no guest flow). This is checked here, on
  -- the server, not in the UI.
  if v_order.user_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  -- Eligibility (server-side, from current DB state — hiding a button is not
  -- authorization). Shipped / delivered / returned / terminal orders are routed
  -- to support / refusal / return instead.
  if v_order.order_status in ('shipped', 'delivered', 'rto', 'cancelled', 'refunded') then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible', 'order_status', v_order.order_status);
  end if;

  -- A shipment, however it was created (Delhivery waybill or a manual AWB), is
  -- final: cancellation is no longer available.
  if nullif(btrim(coalesce(v_order.awb_number, '')), '') is not null
     or v_order.shipped_at is not null
     or coalesce(v_order.shipping_status, 'pending') in
        ('shipped', 'in_transit', 'out_for_delivery', 'delivered', 'rto') then
    return jsonb_build_object('ok', false, 'reason', 'shipped');
  end if;

  -- Duplicate prevention (the partial unique index is the hard guarantee; this
  -- check gives a clean, idempotent answer instead of a constraint violation).
  select id into v_existing
  from public.order_cancellation_requests
  where order_id = v_order.id
    and request_status = 'pending';

  if v_existing is not null then
    return jsonb_build_object('ok', true, 'reason', 'already_requested', 'request_id', v_existing);
  end if;

  insert into public.order_cancellation_requests (order_id, order_ref, user_id, reason)
  values (v_order.id, v_order.ref, v_uid, v_reason)
  returning id into v_id;

  -- An activity line so the admin trail records the request as it arrived.
  perform public.record_admin_activity(
    'CANCELLATION_REQUESTED',
    'retail_order',
    v_order.id::text,
    v_order.ref,
    jsonb_build_object('request_id', v_id, 'reason', v_reason)
  );

  return jsonb_build_object('ok', true, 'reason', 'requested', 'request_id', v_id);
end;
$$;

comment on function public.request_order_cancellation(text, text) is
  'Customer cancellation REQUEST. Writes only public.order_cancellation_requests — never order_status, payment_status, stock_restored_at or any retail_orders column. Requires an authenticated owner (user_id = auth.uid()); guest orders are not requestable in this release. Refuses shipped/terminal orders. Idempotent: an existing pending request is returned rather than duplicated.';

revoke all on function public.request_order_cancellation(text, text) from public;
grant execute on function public.request_order_cancellation(text, text) to authenticated;
revoke execute on function public.request_order_cancellation(text, text) from anon;

-- -----------------------------------------------------------------------------
-- 5) ADMIN — approve or reject. This is the ONLY path that cancels + restocks.
-- -----------------------------------------------------------------------------
create or replace function public.decide_order_cancellation(
  p_request_id uuid,
  p_approve    boolean,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid     uuid := auth.uid();
  v_req     public.order_cancellation_requests%rowtype;
  v_order   public.retail_orders%rowtype;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_refund  text;
  v_amount  numeric;
  v_restored integer := 0;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  -- Server-side admin gate. A customer calling this directly is refused here.
  if not exists (select 1 from public.admin_users where user_id = v_uid) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  -- Lock the request so two admins cannot decide it twice.
  select * into v_req
  from public.order_cancellation_requests
  where id = p_request_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'request_not_found');
  end if;

  if v_req.request_status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'request_status', v_req.request_status);
  end if;

  -- Lock the order. This serialises against the shipment CAS writes and any
  -- concurrent decision, so a loss on either side is resolved by the row lock.
  select * into v_order
  from public.retail_orders
  where id = v_req.order_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;

  -- ---------------------------------------------------------------- REJECTION
  if not p_approve then
    update public.order_cancellation_requests
       set request_status = 'rejected',
           decided_by     = v_uid,
           decided_at     = now(),
           decision_note  = v_note
     where id = p_request_id;

    -- The order and its payment state are left EXACTLY as they were.
    perform public.record_admin_activity(
      'CANCELLATION_REJECTED', 'retail_order', v_order.id::text, v_order.ref,
      jsonb_build_object('request_id', p_request_id, 'note', v_note)
    );

    return jsonb_build_object('ok', true, 'reason', 'rejected', 'request_id', p_request_id);
  end if;

  -- ----------------------------------------------------------------- APPROVAL
  -- REVALIDATE against the CURRENT row, not the state seen when the customer
  -- asked. It may have shipped (or been cancelled by the sweep) in the meantime.
  if nullif(btrim(coalesce(v_order.awb_number, '')), '') is not null
     or v_order.shipped_at is not null
     or coalesce(v_order.shipping_status, 'pending') in
        ('shipped', 'in_transit', 'out_for_delivery', 'delivered', 'rto') then
    return jsonb_build_object('ok', false, 'reason', 'shipment_created');
  end if;

  if v_order.order_status in ('shipped', 'delivered', 'rto') then
    return jsonb_build_object('ok', false, 'reason', 'shipment_created', 'order_status', v_order.order_status);
  end if;

  -- Already cancelled (e.g. the expiry sweep got there first). Not an error for
  -- the operator, but there is nothing left to release: report it truthfully and
  -- let the sweep's own restock stand. Exactly-once is preserved because
  -- restock_retail_order_items also refuses when stock_restored_at is set.
  if v_order.order_status = 'cancelled' then
    if v_order.stock_restored_at is not null then
      return jsonb_build_object('ok', false, 'reason', 'already_cancelled');
    end if;
    -- A cancelled order that somehow never restocked is completed below.
  end if;

  if v_order.order_status = 'refunded' then
    return jsonb_build_object('ok', false, 'reason', 'terminal', 'order_status', v_order.order_status);
  end if;

  -- Classify the manual refund BEFORE touching the order. `payment_status` is
  -- deliberately NOT changed here.
  v_amount := coalesce(v_order.amount_paid_upfront, 0);

  if coalesce(v_order.is_cod, false) or v_order.payment_status = 'cod_pending' then
    if v_amount > 0 then
      -- COD with an advance collected: the advance is owed back, manually.
      v_refund := 'refund_pending';
    else
      v_refund := 'not_applicable';   -- COD, nothing collected online
    end if;
  elsif v_order.payment_status = 'success' or v_order.paid_at is not null then
    -- Paid online: a real refund is owed and must be processed by hand.
    v_refund := 'refund_pending';
    if v_amount <= 0 then
      v_amount := coalesce(v_order.total_amount, 0);
    end if;
  else
    -- pending / failed: no money was captured, nothing to refund.
    v_refund := 'not_applicable';
  end if;

  -- Finalise the cancellation. Only ever on a still-live order.
  update public.retail_orders
     set order_status = 'cancelled',
         auto_ship_at = null,
         updated_at   = now()
   where id = v_order.id
     and order_status not in ('shipped', 'delivered', 'rto', 'refunded');

  -- Release the reservation through the EXISTING idempotent function. Its
  -- `stock_restored_at` guard is the single exactly-once mechanism; this
  -- migration never writes a stock quantity.
  --
  -- The function's own skip rules apply and are honoured, not bypassed: it
  -- returns 0 — releasing nothing and leaving stock_restored_at NULL — for an
  -- order whose payment was already captured (`payment_status = 'success'`) or
  -- whose stock has left the building (shipped/delivered/refunded/rto). That is
  -- the established rule (see the expire sweep and the admin cancel path): a
  -- PAID order's stock is never auto-returned to the sellable pool, because the
  -- sale actually happened. For a paid online cancellation the customer is
  -- refunded instead. So `stock_released_at` is stamped ONLY when the function
  -- reports it actually restored rows; a paid cancellation correctly records no
  -- release rather than a false one.
  v_restored := public.restock_retail_order_items(v_order.id);

  update public.order_cancellation_requests
     set request_status    = 'approved',
         decided_by        = v_uid,
         decided_at        = now(),
         decision_note     = v_note,
         stock_released_at = case when v_restored > 0 then now() else null end,
         refund_status     = v_refund,
         refund_amount     = case when v_refund = 'refund_pending' then v_amount else null end
   where id = p_request_id;

  perform public.record_admin_activity(
    'CANCELLATION_APPROVED', 'retail_order', v_order.id::text, v_order.ref,
    jsonb_build_object(
      'request_id', p_request_id,
      'note', v_note,
      'refund_status', v_refund,
      'refund_amount', v_amount,
      'stock_rows_restored', v_restored
    )
  );

  return jsonb_build_object(
    'ok', true,
    'reason', 'approved',
    'request_id', p_request_id,
    'stock_rows_restored', v_restored,
    'refund_status', v_refund,
    'refund_amount', case when v_refund = 'refund_pending' then v_amount else null end
  );
end;
$$;

comment on function public.decide_order_cancellation(uuid, boolean, text) is
  'Admin approve/reject of a cancellation request. Admin-gated INSIDE the function via public.admin_users (42501 otherwise). Re-validates the order''s CURRENT state on approval and refuses if a shipment now exists. On approval only, sets order_status=''cancelled'' and releases stock EXACTLY ONCE via the existing restock_retail_order_items (stock_restored_at guard); never writes a stock quantity and never sets payment_status=''refunded''. On rejection the order and payment state are left untouched.';

revoke all on function public.decide_order_cancellation(uuid, boolean, text) from public;
grant execute on function public.decide_order_cancellation(uuid, boolean, text) to authenticated;
revoke execute on function public.decide_order_cancellation(uuid, boolean, text) from anon;

-- -----------------------------------------------------------------------------
-- 6) ADMIN — record that the MANUAL refund actually completed.
--    This is the ONLY place payment_status may become 'refunded', and only for
--    an approved request whose refund was pending.
-- -----------------------------------------------------------------------------
create or replace function public.complete_order_cancellation_refund(
  p_request_id uuid,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid   uuid := auth.uid();
  v_req   public.order_cancellation_requests%rowtype;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_paid  boolean;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.admin_users where user_id = v_uid) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  select * into v_req
  from public.order_cancellation_requests
  where id = p_request_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'request_not_found');
  end if;

  if v_req.request_status <> 'approved' then
    return jsonb_build_object('ok', false, 'reason', 'not_approved', 'request_status', v_req.request_status);
  end if;

  if v_req.refund_status = 'refund_completed' then
    return jsonb_build_object('ok', true, 'reason', 'already_completed');
  end if;

  if v_req.refund_status <> 'refund_pending' then
    return jsonb_build_object('ok', false, 'reason', 'no_refund_due', 'refund_status', v_req.refund_status);
  end if;

  update public.order_cancellation_requests
     set refund_status       = 'refund_completed',
         refund_completed_at  = now(),
         decision_note        = coalesce(v_note, decision_note)
   where id = p_request_id;

  -- Reflect the refund on the ORDER only now that it is real. A COD order keeps
  -- its own payment vocabulary; only a genuine online capture becomes 'refunded'.
  select (o.is_cod is not true and (o.payment_status = 'success' or o.paid_at is not null))
    into v_paid
  from public.retail_orders o
  where o.id = v_req.order_id;

  if coalesce(v_paid, false) then
    update public.retail_orders
       set payment_status = 'refunded',
           updated_at     = now()
     where id = v_req.order_id
       and order_status = 'cancelled';
  end if;

  perform public.record_admin_activity(
    'CANCELLATION_REFUND_COMPLETED', 'retail_order', v_req.order_id::text, v_req.order_ref,
    jsonb_build_object('request_id', p_request_id, 'note', v_note)
  );

  return jsonb_build_object('ok', true, 'reason', 'completed', 'request_id', p_request_id);
end;
$$;

comment on function public.complete_order_cancellation_refund(uuid, text) is
  'Admin marks the MANUAL refund for an approved cancellation as actually completed. Admin-gated via public.admin_users. Sets refund_status=''refund_completed'' and, only for a genuine online capture on an already-cancelled order, payment_status=''refunded''. DSLANG has no automated refund path, so this records an action already performed outside the system.';

revoke all on function public.complete_order_cancellation_refund(uuid, text) from public;
grant execute on function public.complete_order_cancellation_refund(uuid, text) to authenticated;
revoke execute on function public.complete_order_cancellation_refund(uuid, text) from anon;

-- -----------------------------------------------------------------------------
-- 7) Surface the new table/RPCs to PostgREST.
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';

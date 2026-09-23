-- =============================================================================
-- Migration: 20261003010000_dslang_drop_stale_retail_order_overload.sql
--
-- WHY: 20260930000000_dslang_retail_cod.sql redefined create_retail_order with
-- a trailing p_payment_method text default 'online' — a SIX-arg signature:
--
--     (p_customer jsonb, p_items jsonb, p_referral text default null,
--      p_promo_code text default null, p_shipping jsonb default '{}',
--      p_payment_method text default 'online')
--
-- `create or replace` only swaps the body of the SAME overload; the new 6-arg
-- overload was created as a SEPARATE function, so the OLD 5-arg overload
-- (jsonb, jsonb, text, text, jsonb, body from 2026-09-05) is still present.
--
-- PostgREST then cannot choose between the two for a named 5-arg call (e.g.
-- {p_customer, p_items, p_promo_code, p_shipping}): both overloads fit once
-- defaults are applied, so it raises PGRST203 "Could not choose the best
-- candidate function" -> HTTP 300.
--
-- NET EFFECT (field-verified 2026-10-03): EVERY retail checkout on the live
-- site was failing at order placement:
--   [checkout] Order placement failed: RestError: Supabase RPC
--   create_retail_order failed (300)   (PGRST203)
--
-- FIX: drop the obsolete 5-arg overload. The current codebase (src/lib/orders.ts)
-- only ever calls with the 4 named args + lets the 6th default, and every
-- earlier `create or replace` that redefined the 5-arg function was superseded
-- by the COD body — the old overload must never execute anyway (its body
-- computes pre-COD pricing). After the drop, a 5-arg call resolves cleanly to
-- the 6-arg defaulted function, exactly as the COD migration intended.
--
-- Rollback: re-run the 20260905000000 definition (or any earlier `create or
-- replace` of the 5-arg overload). Safe + low-risk: no caller targets the
-- stale overload explicitly.
-- =============================================================================

drop function if exists public.create_retail_order(jsonb, jsonb, text, text, jsonb);

-- Defense-in-depth: make sure consumers can always reach the live 6-arg form
-- through the named-arg path (anon = public checkout, service_role = admin/edge).
grant execute on function public.create_retail_order(jsonb, jsonb, text, text, jsonb, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
-- DSLANG wholesale pricing & product fields.
-- Adds wholesale slab pricing and spec fields to the products table.
--
-- NOTE: superseded by 20260828000000_dslang_wholesale_final.sql. This file is
-- kept for reference; if you apply migrations on a fresh database, apply only
-- the final file.

alter table public.products
  add column if not exists gsm integer,
  add column if not exists wash text,
  add column if not exists print_type text,
  add column if not exists moq integer not null default 50,
  add column if not exists wholesale_price_50 integer,
  add column if not exists wholesale_price_100 integer;

-- Backfill sensible defaults so the wholesale site renders usable prices.
update public.products
set gsm = coalesce((regexp_match(coalesce(fabric, ''), '(\d+)\s*GSM'))[1]::integer, 240)
where gsm is null;

update public.products
set wash = 'Optic Wash'
where wash is null or wash = '';

update public.products
set wholesale_price_50 = round((price * 0.3) / 5) * 5
where wholesale_price_50 is null and price > 0;

update public.products
set wholesale_price_100 = greatest(wholesale_price_50 - 10, round((wholesale_price_50 * 0.96) / 5) * 5)
where wholesale_price_100 is null and wholesale_price_50 is not null and wholesale_price_50 > 0;
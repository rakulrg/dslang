-- DSLANG wholesale pricing & product fields.
-- Adds wholesale slab pricing and spec fields to the products table.

alter table public.products
  add column if not exists gsm integer,
  add column if not exists wash text,
  add column if not exists print_type text,
  add column if not exists moq integer not null default 50,
  add column if not exists price50 integer,
  add column if not exists price100 integer;

-- Backfill sensible defaults so the wholesale site renders usable prices.
update public.products
set gsm = coalesce((regexp_match(coalesce(fabric, ''), '(\d+)\s*GSM'))[1]::integer, 240)
where gsm is null;

update public.products
set wash = 'Optic Wash'
where wash is null or wash = '';

update public.products
set price50 = round((price * 0.3) / 5) * 5
where price50 is null and price > 0;

update public.products
set price100 = greatest(price50 - 10, round((price50 * 0.96) / 5) * 5)
where price100 is null and price50 is not null and price50 > 0;
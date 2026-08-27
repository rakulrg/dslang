-- DSLANG wholesale product & ordering rebuild.
-- Adds a free-form Details block and product-level available sizes to
-- products, and makes the wholesale ordering minimums admin-controlled on
-- the site_settings row (min 6 PCS per included color, min 48 PCS total).

alter table public.products
  add column if not exists details text,
  add column if not exists available_sizes text[] not null default array['M','L','XL'];

alter table public.site_settings
  add column if not exists min_order_quantity integer not null default 48,
  add column if not exists per_color_minimum integer not null default 6;

update public.site_settings
set min_order_quantity = 48,
    per_color_minimum = 6,
    updated_at = now()
where id = 1;
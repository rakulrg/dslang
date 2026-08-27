-- DSLANG wholesale site control.
-- Adds product publishing/new-drop flags, hero slide CTA fields, and a
-- single-row site_settings table that the storefront reads as its source of
-- truth for the announcement bar, WhatsApp number, MOQ and dispatch details.

alter table public.products
  add column if not exists published boolean not null default true,
  add column if not exists new_drop boolean not null default false;

alter table public.hero_slides
  add column if not exists cta_text text,
  add column if not exists cta_url text;

-- Single-row settings (the storefront reads these at runtime).
create table if not exists public.site_settings (
  id integer primary key check (id = 1),
  announcement_text text not null default 'SAME DAY DISPATCH • FOR RESELLERS & WHOLESALE ONLY • PAN INDIA DELIVERY',
  announcement_active boolean not null default true,
  whatsapp_number text not null default '919944676178',
  default_moq integer not null default 50,
  dispatch_note text not null default 'Same Day Dispatch',
  delivery_note text not null default 'Pan India',
  updated_at timestamptz not null default now()
);

insert into public.site_settings (id) values (1) on conflict (id) do nothing;

alter table public.site_settings enable row level security;

drop policy if exists "site_settings_read" on public.site_settings;
create policy "site_settings_read"
  on public.site_settings for select
  to authenticated, anon
  using (true);

drop policy if exists "site_settings_write_admin" on public.site_settings;
create policy "site_settings_write_admin"
  on public.site_settings for all
  to authenticated
  using (exists (select 1 from public.admin_users where user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users where user_id = auth.uid()));

-- Backfill: mark the newest published products as visible new drops so the
-- homepage stays populated before the admin picks its own selection.
update public.products
set new_drop = true
where id in (
  select id from public.products
  where new_drop = false
  order by created_at desc
  limit 4
);
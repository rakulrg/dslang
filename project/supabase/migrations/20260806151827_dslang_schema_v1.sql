/*
# DSLANG — Products, Colors, Sizes, Size Chart, Hero Slides + Admin Auth

## Overview
Creates a fully editable catalog backend for the DSLANG streetwear showcase.
Admin logs in with email/password (Supabase Auth). Public visitors read the
catalog without logging in. Only authenticated admins can create/update/delete.

## Tables

1. `products` — one row per product (tee, hoodie, etc.)
   - slug (text, unique) — URL identifier, e.g. "fallen-halo-tee"
   - name (text) — display name
   - code (text) — product code, e.g. "DSL-FH-01"
   - drop_label (text) — e.g. "Drop 01"
   - price (int) — sale price in INR
   - mrp (int, nullable) — original price for strikethrough
   - fabric (text), fit (text), care (text) — specs
   - description (text)
   - category (text) — 'tee' | 'hoodie' | 'drop'
   - badge (text, nullable) — e.g. "Best Seller", "New"
   - featured (bool) — show on home featured strip
   - sort_order (int) — display ordering
   - created_at, updated_at

2. `product_colors` — color variants per product
   - product_id (uuid FK)
   - name (text) — "Black", "Brown", "Green", "Maroon"
   - hex (text) — swatch color
   - images (text[]) — up to 5 image URLs
   - sort_order (int)

3. `product_sizes` — size availability per product (toggle on/off)
   - product_id (uuid FK)
   - size_label (text) — "S","M","L","XL","XXL"
   - available (bool) — admin toggles this

4. `size_chart_rows` — editable size chart per product
   - product_id (uuid FK)
   - size_label (text)
   - chest (numeric), length (numeric), shoulder (numeric) — in inches
   - sort_order (int)

5. `hero_slides` — homepage hero carousel, fully editable
   - image_url (text)
   - eyebrow (text) — small label above title
   - title (text) — main headline
   - subtitle (text)
   - sort_order (int)
   - active (bool)

## Security (RLS)
- products, product_colors, product_sizes, size_chart_rows, hero_slides:
  SELECT open to anon + authenticated (public catalog).
  INSERT/UPDATE/DELETE restricted to authenticated (admin only).
- No user_id columns — single admin model: any signed-in user can manage.
  This is intentional for a single-operator store.

## Notes
- Email confirmation stays OFF.
- The admin creates products/colors/sizes/hero slides from the dashboard.
- Default seed data is inserted in a follow-up migration so re-running this
  one stays idempotent.
*/

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  code text NOT NULL,
  drop_label text NOT NULL DEFAULT 'Drop 01',
  price integer NOT NULL DEFAULT 0,
  mrp integer,
  fabric text NOT NULL DEFAULT '240 GSM Combed Cotton',
  fit text NOT NULL DEFAULT 'Oversized Boxy Fit',
  care text NOT NULL DEFAULT 'Cold wash inside out. Do not bleach. Iron print inside out. Hang dry.',
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'tee',
  badge text,
  featured boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_products" ON products;
CREATE POLICY "public_read_products" ON products FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_products" ON products;
CREATE POLICY "admin_insert_products" ON products FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "admin_update_products" ON products;
CREATE POLICY "admin_update_products" ON products FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin_delete_products" ON products;
CREATE POLICY "admin_delete_products" ON products FOR DELETE
  TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS product_colors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  hex text NOT NULL DEFAULT '#000000',
  images text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE product_colors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_colors" ON product_colors;
CREATE POLICY "public_read_colors" ON product_colors FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_colors" ON product_colors;
CREATE POLICY "admin_insert_colors" ON product_colors FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "admin_update_colors" ON product_colors;
CREATE POLICY "admin_update_colors" ON product_colors FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin_delete_colors" ON product_colors;
CREATE POLICY "admin_delete_colors" ON product_colors FOR DELETE
  TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS product_sizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_label text NOT NULL,
  available boolean NOT NULL DEFAULT true,
  UNIQUE (product_id, size_label)
);

ALTER TABLE product_sizes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_sizes" ON product_sizes;
CREATE POLICY "public_read_sizes" ON product_sizes FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_sizes" ON product_sizes;
CREATE POLICY "admin_insert_sizes" ON product_sizes FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "admin_update_sizes" ON product_sizes;
CREATE POLICY "admin_update_sizes" ON product_sizes FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin_delete_sizes" ON product_sizes;
CREATE POLICY "admin_delete_sizes" ON product_sizes FOR DELETE
  TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS size_chart_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_label text NOT NULL,
  chest numeric NOT NULL DEFAULT 0,
  length numeric NOT NULL DEFAULT 0,
  shoulder numeric NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (product_id, size_label)
);

ALTER TABLE size_chart_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_sizechart" ON size_chart_rows;
CREATE POLICY "public_read_sizechart" ON size_chart_rows FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_sizechart" ON size_chart_rows;
CREATE POLICY "admin_insert_sizechart" ON size_chart_rows FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "admin_update_sizechart" ON size_chart_rows;
CREATE POLICY "admin_update_sizechart" ON size_chart_rows FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin_delete_sizechart" ON size_chart_rows;
CREATE POLICY "admin_delete_sizechart" ON size_chart_rows FOR DELETE
  TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS hero_slides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url text NOT NULL,
  eyebrow text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  subtitle text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE hero_slides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_hero" ON hero_slides;
CREATE POLICY "public_read_hero" ON hero_slides FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_hero" ON hero_slides;
CREATE POLICY "admin_insert_hero" ON hero_slides FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "admin_update_hero" ON hero_slides;
CREATE POLICY "admin_update_hero" ON hero_slides FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "admin_delete_hero" ON hero_slides;
CREATE POLICY "admin_delete_hero" ON hero_slides FOR DELETE
  TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_colors_product ON product_colors(product_id);
CREATE INDEX IF NOT EXISTS idx_sizes_product ON product_sizes(product_id);
CREATE INDEX IF NOT EXISTS idx_sizechart_product ON size_chart_rows(product_id);

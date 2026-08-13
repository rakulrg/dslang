/*
# Seed DSLANG catalog — 3 products, 4 colors each, sizes, size charts, hero slides

Inserts the launch Drop 01 catalog so the site renders out of the box.
Idempotent: uses ON CONFLICT on the products.slug unique constraint to
avoid duplicates on re-run. Child rows are inserted with fixed slugs
referenced via a CTE so re-runs do not duplicate children either
(child UNIQUE constraints + ON CONFLICT guard them).
*/

INSERT INTO products (slug, name, code, drop_label, price, mrp, fabric, fit, care, description, category, badge, featured, sort_order)
VALUES
  ('fallen-halo-tee', 'Fallen Halo Oversized Tee', 'DSL-FH-01', 'Drop 01', 899, 1299,
    '240 GSM Combed Cotton', 'Oversized Boxy Fit',
    'Cold wash inside out. Do not bleach. Iron print inside out. Hang dry.',
    'A heavyweight statement piece. The Fallen Halo graphic sits heavy on premium 240 GSM combed cotton with an oversized boxy cut.',
    'tee', 'Best Seller', true, 0),
  ('uncontrol-tee', 'Uncontrol Oversized Tee', 'DSL-UN-02', 'Drop 01', 899, 1299,
    '240 GSM Combed Cotton', 'Oversized Boxy Fit',
    'Cold wash inside out. Do not bleach. Iron print inside out. Hang dry.',
    'Uncontrol is for the ones who refuse to be boxed in. Heavyweight cotton, bold front print, and a dropped shoulder silhouette that drapes clean.',
    'tee', 'New', true, 1),
  ('sever-tee', 'Sever Oversized Tee', 'DSL-SV-03', 'Drop 01', 949, 1399,
    '240 GSM Combed Cotton', 'Oversized Boxy Fit',
    'Cold wash inside out. Do not bleach. Iron print inside out. Hang dry.',
    'Sever cuts clean. A minimal back print, heavy front chest hit, and the kind of drape that only 240 GSM gives you.',
    'tee', 'Limited Run', true, 2)
ON CONFLICT (slug) DO NOTHING;

-- Colors per product (Black, Brown, Green, Maroon)
INSERT INTO product_colors (product_id, name, hex, images, sort_order)
SELECT p.id, c.name, c.hex, c.images, c.sort_order
FROM products p
JOIN (VALUES
  ('fallen-halo-tee', 'Black',  '#0d0d0d', 1, ARRAY[
    'https://images.pexels.com/photos/37043496/pexels-photo-37043496.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/13020610/pexels-photo-13020610.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/3290886/pexels-photo-3290886.jpeg?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('fallen-halo-tee', 'Brown',  '#5b3a29', 2, ARRAY[
    'https://images.pexels.com/photos/15258903/pexels-photo-15258903.png?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/15693987/pexels-photo-15693987.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/15258905/pexels-photo-15258905.png?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('fallen-halo-tee', 'Green',  '#2d4a2b', 3, ARRAY[
    'https://images.pexels.com/photos/18856590/pexels-photo-18856590.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/7643904/pexels-photo-7643904.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/12922554/pexels-photo-12922554.jpeg?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('fallen-halo-tee', 'Maroon', '#4a1620', 4, ARRAY[
    'https://images.pexels.com/photos/13046261/pexels-photo-13046261.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/2315347/pexels-photo-2315347.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/12644737/pexels-photo-12644737.jpeg?auto=compress&cs=tinysrgb&h=900&w=700']),

  ('uncontrol-tee', 'Black',  '#0d0d0d', 1, ARRAY[
    'https://images.pexels.com/photos/15984691/pexels-photo-15984691.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/30186079/pexels-photo-30186079.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/18403112/pexels-photo-18403112.jpeg?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('uncontrol-tee', 'Brown',  '#5b3a29', 2, ARRAY[
    'https://images.pexels.com/photos/15258903/pexels-photo-15258903.png?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/15693987/pexels-photo-15693987.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/15258905/pexels-photo-15258905.png?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('uncontrol-tee', 'Green',  '#2d4a2b', 3, ARRAY[
    'https://images.pexels.com/photos/18856590/pexels-photo-18856590.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/7643904/pexels-photo-7643904.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/12922554/pexels-photo-12922554.jpeg?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('uncontrol-tee', 'Maroon', '#4a1620', 4, ARRAY[
    'https://images.pexels.com/photos/13046261/pexels-photo-13046261.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/2315347/pexels-photo-2315347.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/12644737/pexels-photo-12644737.jpeg?auto=compress&cs=tinysrgb&h=900&w=700']),

  ('sever-tee', 'Black',  '#0d0d0d', 1, ARRAY[
    'https://images.pexels.com/photos/16649942/pexels-photo-16649942.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/5975344/pexels-photo-5975344.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/16781290/pexels-photo-16781290.jpeg?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('sever-tee', 'Brown',  '#5b3a29', 2, ARRAY[
    'https://images.pexels.com/photos/15258903/pexels-photo-15258903.png?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/15693987/pexels-photo-15693987.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/15258905/pexels-photo-15258905.png?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('sever-tee', 'Green',  '#2d4a2b', 3, ARRAY[
    'https://images.pexels.com/photos/18856590/pexels-photo-18856590.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/7643904/pexels-photo-7643904.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/12922554/pexels-photo-12922554.jpeg?auto=compress&cs=tinysrgb&h=900&w=700']),
  ('sever-tee', 'Maroon', '#4a1620', 4, ARRAY[
    'https://images.pexels.com/photos/13046261/pexels-photo-13046261.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/2315347/pexels-photo-2315347.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
    'https://images.pexels.com/photos/12644737/pexels-photo-12644737.jpeg?auto=compress&cs=tinysrgb&h=900&w=700'])
) AS c(slug, name, hex, sort_order, images)
ON p.slug = c.slug
WHERE NOT EXISTS (
  SELECT 1 FROM product_colors pc WHERE pc.product_id = p.id AND pc.name = c.name
);

-- Sizes (S–XXL) for every product, all available by default
INSERT INTO product_sizes (product_id, size_label, available)
SELECT p.id, s.label, true
FROM products p
CROSS JOIN (VALUES ('S'), ('M'), ('L'), ('XL'), ('XXL')) AS s(label)
WHERE NOT EXISTS (
  SELECT 1 FROM product_sizes ps WHERE ps.product_id = p.id AND ps.size_label = s.label
);

-- Size chart rows (inches) for every product
INSERT INTO size_chart_rows (product_id, size_label, chest, length, shoulder, sort_order)
SELECT p.id, r.label, r.chest, r.length, r.shoulder, r.sort_order
FROM products p
JOIN (VALUES
  ('S',    48, 27, 23, 0),
  ('M',    52, 28, 24, 1),
  ('L',    56, 29, 25, 2),
  ('XL',   60, 30, 26, 3),
  ('XXL',  64, 31, 27, 4)
) AS r(label, chest, length, shoulder, sort_order) ON true
WHERE NOT EXISTS (
  SELECT 1 FROM size_chart_rows sc WHERE sc.product_id = p.id AND sc.size_label = r.label
);

-- Hero slides
INSERT INTO hero_slides (image_url, eyebrow, title, subtitle, sort_order, active)
VALUES
  ('https://images.pexels.com/photos/30636000/pexels-photo-30636000.jpeg?auto=compress&cs=tinysrgb&w=1600',
   'Drop 01 — Limited Run', 'Wear The Struggle',
   'Heavyweight oversized tees. Made with intent. Built to last.', 0, true),
  ('https://images.pexels.com/photos/13020610/pexels-photo-13020610.jpeg?auto=compress&cs=tinysrgb&w=1600',
   'New Arrival', 'Fallen Halo Has Landed',
   '240 GSM combed cotton. Bold front print. Oversized boxy fit.', 1, true),
  ('https://images.pexels.com/photos/23570892/pexels-photo-23570892.jpeg?auto=compress&cs=tinysrgb&w=1600',
   'The Movement', 'Not A Brand. A Movement.',
   'No investors. No shortcuts. Just late nights and heavy cotton.', 2, true)
ON CONFLICT DO NOTHING;

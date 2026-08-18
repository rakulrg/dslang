ALTER TABLE product_sizes
  ADD COLUMN IF NOT EXISTS stock integer NOT NULL DEFAULT 0;

UPDATE product_sizes
SET stock = CASE
  WHEN available = true THEN 10
  ELSE 0
END
WHERE stock IS NULL OR stock < 0;

UPDATE product_sizes
SET available = stock > 0
WHERE available IS DISTINCT FROM (stock > 0);

ALTER TABLE product_sizes
  ALTER COLUMN stock SET DEFAULT 0;

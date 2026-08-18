-- Remove S and XXL sizes from product_sizes and size_chart_rows.
-- Only M, L, XL remain. Historical order records are untouched.

DELETE FROM product_sizes WHERE size_label IN ('S', 'XXL');
DELETE FROM size_chart_rows WHERE size_label IN ('S', 'XXL');

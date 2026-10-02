-- Retire the obsolete COD-advance fulfilment state without rewriting money.
-- Historical COD rows may contain a genuine Cashfree collection, so all
-- amounts, payment timestamps and transaction IDs are deliberately preserved.

update public.retail_orders
set order_status = 'processing'
where is_cod
  and order_status = 'cod_partial_paid';

comment on column public.retail_orders.order_status is
  'Fulfilment state. COD uses the normal pending/processing/shipped/delivered flow; historical payment amounts remain recorded as collected.';

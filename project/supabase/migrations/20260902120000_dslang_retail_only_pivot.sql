-- =============================================================================
-- DSLANG retail-only pivot (wholesale -> WhatsApp only). Minimal, non-destructive.
--
-- The customer-facing storefront is now retail-only. Wholesale moves to a single
-- WhatsApp-powered info page: no wholesale prices, packs, MOQ/pack config or
-- wholesale storefront are rendered anywhere on the public site.
--
-- This migration ONLY updates the announcement bar to retail-friendly copy and
-- makes sure the pre-existing retail-only defaults hold. No tables, columns,
-- functions or existing product data are dropped or modified (legacy wholesale
-- tables remain untouched for record-keeping).
-- =============================================================================

update public.site_settings
set announcement_text = 'NEW DROP · SAME DAY DISPATCH · PAN INDIA DELIVERY'
where id = 1
  and announcement_text like '%RESELLERS%'
  or id = 1
  and announcement_text like '%WHOLESALE ONLY%';

-- Wholesale pricing must never be visible on the public storefront.
update public.site_settings
set wholesale_pricing_enabled = false
where id = 1
  and wholesale_pricing_enabled is distinct from false;
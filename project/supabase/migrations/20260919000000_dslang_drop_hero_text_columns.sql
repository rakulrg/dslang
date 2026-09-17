-- ============================================================================
-- DSLANG — Remove obsolete hero slide text/content columns
--
-- The homepage hero is now images-only. The hero text system (eyebrow, title,
-- subtitle) and the per-slide CTA system (cta_text, cta_url) are no longer
-- used anywhere (admin editor and public hero were both stripped).
--
-- This migration ONLY drops those five columns. It does NOT delete hero slides
-- or their images, and it preserves id, image_url, sort_order, active,
-- created_at, RLS policies, and all other retail data.
-- ============================================================================

alter table public.hero_slides
  drop column if exists eyebrow,
  drop column if exists title,
  drop column if exists subtitle,
  drop column if exists cta_text,
  drop column if exists cta_url;
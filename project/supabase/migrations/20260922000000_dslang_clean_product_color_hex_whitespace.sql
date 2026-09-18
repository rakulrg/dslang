-- ============================================================================
-- Migration: dslang_clean_product_color_hex_whitespace
-- Purpose:   product_colors.hex is hand-entered in the admin UI. Two rows were
--            saved with a stray LEADING SPACE (" #093624"), which the card
--            swatch / detail-page selector / cart-color-hex read as a parity
--            value, so the browser refused to parse it and the swatch fell
--            back to the diagonal "print/fabric" pattern instead of rendering
--            the solid colour (it looked like a broken/disabled dot).
--            Affected: "Green" on
--              * jujutsukaisen-sukuna (Sukuna - Jujutsu Kaisen ...)
--              * no-wasted-potential (No Wasted Potential ...)
--            This trims leading/trailing whitespace from every hex so any
--            similar hand-entry slip is repaired in one place, not just the
--            two known rows. Idempotent — safe to run repeatedly.
-- ============================================================================

UPDATE public.product_colors
   SET hex = btrim(hex)
 WHERE hex IS DISTINCT FROM btrim(hex);
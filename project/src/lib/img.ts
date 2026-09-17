// Responsive-image helper for the storefront.
//
// The storefront's product/hero images are served from Supabase Storage as
// their original files (free tier has no image transformations). This module
// OPTIONALLY attaches a srcSet via a config-gated transform proxy — e.g. a
// Cloudflare/Image-Resizing-style endpoint. Off by default (no proxy configured
// => plain <img src>) so nothing changes until an operator opts in by setting
// VITE_IMAGE_TRANSFORM_BASE at build time.
//
// Compatible with imgproxy-style `?url=<encoded>&w=<w>` query params (Cloudflare
// Image Resizing, imgproxy, Imagor). gated-off default means no risk either way.

const TRANSFORM_BASE = (import.meta.env.VITE_IMAGE_TRANSFORM_BASE ?? '').replace(/\/$/, '');

export interface ResponsiveSrc {
  srcSet?: string;
  sizes?: string;
}

/**
 * Builds a `srcSet`/`sizes` pair for an <img> when a transform proxy is
 * configured. Returns `{}` (=> no srcSet) otherwise. Never throws.
 */
export function responsiveSrc(src: string, widths: number[] = [360, 480, 720]): ResponsiveSrc {
  if (!TRANSFORM_BASE || !src || src.startsWith('data:') || src.startsWith('blob:')) return {};
  const srcSet = widths
    .map((w) => `${TRANSFORM_BASE}?url=${encodeURIComponent(src)}&w=${w}&quality=75&format=auto ${w}w`)
    .join(', ');
  return {
    srcSet,
    sizes: `(max-width: 480px) ${widths[0]}px, (max-width: 1024px) ${widths[1]}px, ${widths[2]}px`,
  };
}
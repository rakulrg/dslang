import {
  getRetailPrice,
  getMrp,
  formatPrice,
  normalizeHexColor,
  type CatalogProduct,
} from '@/lib/catalog';
import type { ProductColorRow } from '@/lib/types';
import { linkHref } from '@/lib/router';
import { useInView } from '@/lib/useInView';
import { responsiveSrc } from '@/lib/img';
import { useEffect, useState } from 'react';

/**
 * Retail (D2C) product card — always links to /product/[slug] and shows the
 * retail price with a compare-at strike-through.
 */

/** How many swatches render on a card before they collapse into a "+N" bubble.
 * Keeps the dot row from wrapping or overflowing narrow (2-col) card widths. */
const MAX_SWATCHES = 5;

/** Fallback swatch for colours with no usable hex value (empty, null, or not a
 * parseable hex after trimming). A quiet diagonal stripe reads as
 * "print/fabric" and never visibly clashes with the card. */
const MULTICOLOR_PATTERN = {
  backgroundImage:
    'repeating-linear-gradient(45deg, #d6d0c2 0px, #d6d0c2 2px, #f0ece1 2px, #f0ece1 4px)',
};

/** Decorative colour dots for a card. Pure visual indicator — the whole card is
 * the link, so these spans are intentionally not interactive (colour/size
 * selection lives on the product detail page). */
function ColorSwatchRow({ colors }: { colors: ProductColorRow[] }) {
  const visible = colors.slice(0, MAX_SWATCHES);
  const extra = colors.length - visible.length;
  return (
    <div className="flex items-center gap-1.5" aria-label={`${colors.length} colours`}>
      {visible.map((c) => {
        const hex = normalizeHexColor(c.hex);
        return (
          <span
            key={c.id}
            title={c.name}
            className="h-3.5 w-3.5 rounded-full border border-bone-dim/40 shrink-0"
            style={
              hex
                ? { backgroundColor: hex }
                : { backgroundColor: 'transparent', ...MULTICOLOR_PATTERN }
            }
          />
        );
      })}
      {extra > 0 && (
        <span
          title={`${extra} more colours`}
          className="h-3.5 min-w-3.5 px-1 rounded-full border border-bone-dim/40 flex items-center justify-center text-[8px] font-medium leading-none text-bone-dim tabular-nums shrink-0"
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

/** Neutral DSLANG-branded image fallback (dark ink field + wordmark). Rendered
 * whenever a product has NO uploaded photos or a photo fails to load — an
 * ImageLess-or-broken product is still a valid product and must stay visible. */
export const PRODUCT_IMAGE_FALLBACK = (() => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">' +
    '<rect width="800" height="1000" fill="#111111"/>' +
    '<text x="400" y="492" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="60" letter-spacing="12" fill="rgba(255,255,255,0.9)">DSLANG</text>' +
    '<text x="400" y="530" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="16" letter-spacing="6" fill="rgba(255,255,255,0.36)">SLANG OF DESIGN</text>' +
    '</svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
})();

export function ProductCard({
  product,
  index = 0,
  priority = false,
  immediate = false,
}: {
  product: CatalogProduct;
  index?: number;
  /** Eager-load this card's main image (use only for the first above-the-fold
   * row of a grid). Everything else stays lazy. */
  priority?: boolean;
  /** Collection mode: render fully visible the moment it mounts (no
   * viewport-reveal gate / IntersectionObserver) and request EVERY image
   * eagerly — including below-the-fold and hover views — so the whole grid
   * loads at once instead of progressively on scroll. */
  immediate?: boolean;
}) {
  const primary = product.colors[0];
  const image = primary?.images[0];
  const hoverImage = primary?.images[1] ?? primary?.images[0];
  const [imgFailed, setImgFailed] = useState(false);

  // A product switching to a new image/card starts clean (no stale error state).
  useEffect(() => {
    setImgFailed(false);
  }, [image]);

  const imageSrc = image && !imgFailed ? image : PRODUCT_IMAGE_FALLBACK;
  const hoverSrc = hoverImage && hoverImage !== image && !imgFailed ? hoverImage : null;

  const retailPrice = getRetailPrice(product);
  const mrp = getMrp(product);
  const showMrp = mrp !== null && mrp > retailPrice;
  const showPrice = retailPrice > 0;

  const { ref, inView } = useInView<HTMLAnchorElement>(undefined, !immediate);
  const visible = immediate || inView;
  const eager = immediate || priority;

  const discountPct = showMrp ? Math.round((1 - retailPrice / mrp) * 100) : 0;

  return (
    <div className="product-card-frame">
      <div className="product-card-scale">
        <a
          ref={ref}
          href={linkHref(`/product/${product.slug}`)}
          className={`group block reveal flex flex-col ${visible ? 'is-visible' : ''}`}
          style={{ transitionDelay: `${index * 80}ms` }}
        >
          <div className="relative aspect-[4/5] overflow-hidden bg-paper-3 border border-line">
            <img
              src={imageSrc}
              alt={`${product.name} — ${primary?.name ?? ''}`}
              loading={eager ? 'eager' : 'lazy'}
              fetchPriority={eager && index < 4 ? 'high' : 'auto'}
              decoding="async"
              onError={() => setImgFailed(true)}
              {...responsiveSrc(imageSrc)}
              className="absolute inset-0 w-full h-full object-cover transition-all duration-300 group-hover:scale-105 group-hover:opacity-0"
            />
            {hoverSrc && <img
              src={hoverSrc}
              alt={`${product.name} — alternate view`}
              loading={eager ? 'eager' : 'lazy'}
              decoding="async"
              onError={() => setImgFailed(true)}
              {...responsiveSrc(hoverSrc)}
              className="absolute inset-0 w-full h-full object-cover opacity-0 transition-all duration-300 group-hover:scale-105 group-hover:opacity-100"
            />}
            {showMrp && discountPct > 0 && (
              <span className="absolute top-1.5 left-1.5 z-10 bg-red-600 text-white text-[9px] leading-none uppercase font-bold px-1.5 py-1">
                Save {discountPct}%
              </span>
            )}
          </div>

          {/* Info — title with a fixed 2-line block so every price row aligns,
              then the price/sale line, then a swatch slot pinned to the
              bottom of the card via mt-auto. The reserved min-h on the
              swatch slot keeps every card in a row bottom-aligned even when
              some products are single-colour (the slot is simply empty). */}
          <div className="pt-2 md:pt-4 flex flex-col flex-1">
            <h3 className="text-[14px] font-semibold text-bone leading-[1.3] line-clamp-2 min-h-[2.6em]">
              {product.name}
            </h3>

            {showPrice && (
              <div className="mt-3 flex items-baseline gap-2">
                <span className="font-price text-[16px] font-semibold text-bone">
                  {formatPrice(retailPrice)}
                </span>
                {showMrp && (
                  <span className="font-price text-[11px] text-grey line-through">
                    {formatPrice(mrp)}
                  </span>
                )}
              </div>
            )}

            <div className="mt-auto pt-2.5 min-h-[24px] flex items-center">
              {product.colors.length > 1 && (
                <ColorSwatchRow colors={product.colors} />
              )}
            </div>
          </div>
        </a>
      </div>
    </div>
  );
}
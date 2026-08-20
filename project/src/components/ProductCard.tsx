import { formatPrice, type CatalogProduct } from '@/lib/catalog';
import type { ProductColorRow } from '@/lib/types';
import { linkHref } from '@/lib/router';

export function ProductCard({ product, index = 0 }: { product: CatalogProduct; index?: number }) {
  const primary = product.colors[0];
  const image = primary?.images[0];
  const hoverImage = primary?.images[1] ?? primary?.images[0];
  const discount = product.mrp
    ? Math.round(((product.mrp - product.price) / product.mrp) * 100)
    : null;

  return (
    <a
      href={linkHref(`/product/${product.slug}`)}
      className="group block animate-fade-up flex flex-col"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-paper-3 border border-line">
        {discount && (
          <span className="font-label absolute top-2.5 right-2.5 z-10 bg-crimson text-white text-[9px] uppercase tracking-wide-2 font-semibold px-2 py-0.5 rounded-sm">
            -{discount}%
          </span>
        )}

        {/* Image with hover swap */}
        {image && <img
          src={image}
          alt={`${product.name} — ${primary?.name ?? ''}`}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover transition-all duration-200 group-hover:scale-105 group-hover:opacity-0"
        />}
        {hoverImage && hoverImage !== image && <img
          src={hoverImage}
          alt={`${product.name} — alternate view`}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover opacity-0 transition-all duration-200 group-hover:scale-105 group-hover:opacity-100"
        />}

        {/* Hover buy bar */}
        <div className="absolute bottom-0 inset-x-0 translate-y-full group-hover:translate-y-0 transition-transform duration-200">
          <div className="bg-crimson text-white text-center py-3 text-[11px] uppercase tracking-wide-2 font-semibold">
            View Product
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="pt-2 md:pt-4 flex flex-col flex-1">
        <h3 className="text-[14px] font-medium text-bone leading-[1.3] line-clamp-2">
          {product.name}
        </h3>
        <div className="mt-auto pt-1.5">
          <div className="flex items-center gap-2.5">
            <span className="font-price text-[15px] text-bone">{formatPrice(product.price)}</span>
            {product.mrp && (
              <span className="font-price text-[13px] text-grey line-through">{formatPrice(product.mrp)}</span>
            )}
          </div>
          {/* Swatches */}
          <div className="mt-2.5 flex items-center gap-2">
            {product.colors.map((c: ProductColorRow) => (
              <span
                key={c.id}
                className="w-3.5 h-3.5 border border-line"
                style={{ backgroundColor: c.hex }}
                title={c.name}
              />
            ))}
            {product.colors.length > 0 && (
              <span className="font-label text-[11px] font-normal uppercase tracking-wide-2 text-grey ml-1">
                {product.colors.length} Colors
              </span>
            )}
          </div>
        </div>
      </div>
    </a>
  );
}

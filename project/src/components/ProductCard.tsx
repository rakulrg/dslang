import { getWholesaleSlabs, getAvailableSizes, formatPerUnit, type CatalogProduct } from '@/lib/catalog';
import type { ProductColorRow } from '@/lib/types';
import { linkHref } from '@/lib/router';

export function ProductCard({ product, index = 0 }: { product: CatalogProduct; index?: number }) {
  const primary = product.colors[0];
  const image = primary?.images[0];
  const hoverImage = primary?.images[1] ?? primary?.images[0];
  const slabs = getWholesaleSlabs(product);
  const sizeLabels = getAvailableSizes(product);

  return (
    <a
      href={linkHref(`/product/${product.slug}`)}
      className="group block animate-fade-up flex flex-col"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-paper-3 border border-line">
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

        {/* Hover bar */}
        <div className="absolute bottom-0 inset-x-0 translate-y-full group-hover:translate-y-0 transition-transform duration-200">
          <div className="bg-bone text-white text-center py-3 text-[11px] uppercase tracking-wide-2 font-semibold">
            View Wholesale Details
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="pt-2 md:pt-4 flex flex-col flex-1">
        <h3 className="text-[14px] font-semibold text-bone leading-[1.3] line-clamp-2">
          {product.name}
        </h3>

        <div className="mt-2 flex items-center gap-2">
          {product.colors.slice(0, 5).map((c: ProductColorRow) => (
            <span
              key={c.id}
              className="w-3.5 h-3.5 border border-line"
              style={{ backgroundColor: c.hex }}
              title={c.name}
            />
          ))}
          {product.colors.length > 0 && (
            <span className="font-label text-[10px] font-normal uppercase tracking-wide-2 text-grey">
              {product.colors.length} {product.colors.length === 1 ? 'Color' : 'Colors'}
              {sizeLabels.length > 0 ? ` · ${sizeLabels.join(' / ')}` : ''}
            </span>
          )}
        </div>

        <div className="mt-auto pt-3">
          <div className="flex items-baseline gap-2">
            <span className="font-label text-[12px] uppercase tracking-wide-2 font-bold text-bone">
              MOQ {slabs.moq} PCS
            </span>
          </div>
          <div className="mt-1.5">
            <p className="font-price text-[13px] text-bone-dim">
              From{' '}
              <span className="text-crimson">
                {slabs.price100 > 0
                  ? formatPerUnit(slabs.price100)
                  : slabs.price50 > 0
                    ? formatPerUnit(slabs.price50)
                    : '—'}
              </span>
            </p>
          </div>
        </div>
      </div>
    </a>
  );
}
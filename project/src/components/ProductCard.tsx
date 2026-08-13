import { formatPrice, type CatalogProduct } from '@/lib/catalog';
import type { ProductColorRow } from '@/lib/types';
import { linkHref } from '@/lib/router';

export function ProductCard({ product, index = 0 }: { product: CatalogProduct; index?: number }) {
  const primary = product.colors[0];
  if (!primary) return null;
  const image = primary.images[0];
  const hoverImage = primary.images[1] ?? primary.images[0];
  const discount = product.mrp
    ? Math.round(((product.mrp - product.price) / product.mrp) * 100)
    : null;

  return (
    <a
      href={linkHref(`/product/${product.slug}`)}
      className="group block animate-fade-up"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-paper-3 border border-line">
        {/* Badge */}
        {product.badge && (
          <span className="absolute top-3 left-3 z-10 bg-crimson text-white text-[10px] uppercase tracking-wide-2 font-semibold px-2.5 py-1">
            {product.badge}
          </span>
        )}
        {discount && (
          <span className="absolute top-3 right-3 z-10 bg-paper/90 backdrop-blur-sm text-bone text-[10px] uppercase tracking-wide-2 font-semibold px-2.5 py-1 border border-line">
            -{discount}%
          </span>
        )}

        {/* Image with hover swap */}
        <img
          src={image}
          alt={`${product.name} — ${primary.name}`}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover transition-all duration-700 group-hover:scale-105 group-hover:opacity-0"
        />
        <img
          src={hoverImage}
          alt={`${product.name} — alternate view`}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover opacity-0 transition-all duration-700 group-hover:scale-105 group-hover:opacity-100"
        />

        {/* Hover buy bar */}
        <div className="absolute bottom-0 inset-x-0 translate-y-full group-hover:translate-y-0 transition-transform duration-500">
          <div className="bg-crimson text-white text-center py-3 text-[11px] uppercase tracking-wide-2 font-semibold">
            View Product
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="pt-4">
        <h3 className="text-base font-semibold text-bone leading-tight">
          {product.name}
        </h3>
        <p className="text-[11px] uppercase tracking-wide-2 text-grey mt-1">{product.code}</p>
        <div className="mt-2 flex items-center gap-2.5">
          <span className="text-bone font-medium">{formatPrice(product.price)}</span>
          {product.mrp && (
            <span className="text-grey line-through text-sm">{formatPrice(product.mrp)}</span>
          )}
        </div>
        {/* Swatches */}
        <div className="mt-3 flex items-center gap-2">
          {product.colors.map((c: ProductColorRow) => (
            <span
              key={c.id}
              className="w-3.5 h-3.5 border border-line"
              style={{ backgroundColor: c.hex }}
              title={c.name}
            />
          ))}
          <span className="text-[10px] uppercase tracking-wide-2 text-grey ml-1">
            {product.colors.length} Colors
          </span>
        </div>
      </div>
    </a>
  );
}

import { useEffect, useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import { fetchProducts, type CatalogProduct } from '@/lib/catalog';

const FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Tees', value: 'tee' },
];

export function ShopPage() {
  const [filter, setFilter] = useState('all');
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchProducts()
      .then((p) => { setProducts(p); setError(false); })
      .catch(() => setError(true));
  }, []);

  const filtered = (products ?? []).filter((p) => {
    if (filter === 'all') return true;
    if (filter === 'tee') return p.category === 'tee';
    return true;
  });

  return (
    <div className="pb-12 md:pb-20 pt-3">
        <div className="mx-auto px-2 md:px-12 lg:px-20 xl:px-28">
        {/* Header */}
        <div className="border-b border-line pb-4 md:pb-8">
          <h1 className="font-display text-[1.75rem] md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            Shop All
          </h1>
          <p className="mt-2 text-bone-dim max-w-xl leading-relaxed">
            Once a drop sells out, it is gone.
          </p>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mt-3 mb-5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`font-label text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 border transition-colors duration-150 ${
                filter === f.value
                  ? 'bg-bone text-white border-bone'
                  : 'border-line text-bone-dim hover:border-bone-dim hover:text-bone'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="ml-auto font-label text-[11px] uppercase tracking-wide-2 text-grey">
            {filtered.length} {filtered.length === 1 ? 'Piece' : 'Pieces'}
          </span>
        </div>

        {error ? (
          <div className="py-16 text-center">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Something went wrong</p>
            <p className="mt-2 text-sm text-grey">Could not load products. Please try again.</p>
          </div>
        ) : products === null ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="aspect-[3/4] bg-paper-3 border border-line animate-pulse" />
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-8">
            {filtered.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        ) : (
          <div className="py-16 text-center">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Sold Out</p>
            <p className="mt-2 text-sm text-grey">Next drop loading. Stay close.</p>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import { fetchProducts, isRetailVisible, type CatalogProduct } from '@/lib/catalog';
import { LoadingDots } from '@/components/LoadingDots';

export function CollectionPage() {
  const [filter, setFilter] = useState('all');
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    setProducts(null);
    setError(false);
    fetchProducts()
      .then((all) => {
        setProducts(all.filter((p) => isRetailVisible(p)));
        setError(false);
      })
      .catch(() => setError(true));
  }, [loadKey]);

  const categories = Array.from(
    new Set((products ?? []).map((p) => (p.category || 'tee').toLowerCase()))
  ).sort();
  const activeCat = filter === 'all' ? null : filter;

  const filtered = (products ?? []).filter((p) => {
    if (filter === 'all') return true;
    return (p.category || 'tee').toLowerCase() === filter;
  });

  return (
    <div className="pb-12 md:pb-20 pt-3">
      <div className="mx-auto px-2 md:px-12 lg:px-20 xl:px-28">
        {/* Header */}
        <div className="px-2 md:px-0 border-b border-line pb-4 md:pb-8">
          <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">
            DSLANG · Slang Of Design
          </p>
          <h1 className="font-display text-[1.75rem] md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            Shop The Collection
          </h1>
          <p className="mt-3 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            Oversized fits, heavy quality. Pan-India dispatch in 24–48 hrs with easy size exchanges.
          </p>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mt-3 mb-5 overflow-x-auto no-scrollbar">
          {[{ label: 'All', value: 'all' }, ...categories.map((c) => ({ label: c, value: c }))].map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`shrink-0 font-label text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 border transition-colors duration-150 ${
                filter === f.value
                  ? 'bg-bone text-ink border-bone'
                  : 'border-line text-bone-dim hover:border-bone-dim hover:text-bone'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="ml-auto shrink-0 font-label text-[11px] uppercase tracking-wide-2 text-grey">
            {filtered.length} {filtered.length === 1 ? 'Design' : 'Designs'}
          </span>
        </div>

        {error ? (
          <div className="min-h-[50vh] flex flex-col items-center justify-center text-center px-5">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Something went wrong</p>
            <p className="mt-2 text-sm text-grey">Could not load the collection. Please try again.</p>
            <button
              onClick={() => setLoadKey((k) => k + 1)}
              className="mt-8 inline-flex items-center text-[11px] uppercase tracking-wide-2 font-semibold bg-crimson text-white px-6 py-3.5 hover:bg-crimson-dark transition-colors"
            >
              Try Again
            </button>
          </div>
        ) : products === null ? (
          <div className="min-h-[50vh] flex items-center justify-center"><LoadingDots /></div>
        ) : filtered.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-8">
            {filtered.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        ) : (
          <div className="py-16 text-center">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No Designs</p>
            <p className="mt-2 text-sm text-grey">{activeCat ? `Nothing in "${activeCat}" yet. ` : ''}Next drop loading. Stay close.</p>
          </div>
        )}

        {/* Retail highlights */}
        <div className="mt-10 grid grid-cols-2 md:grid-cols-4 gap-3 text-center bg-paper-3 border border-line px-4 py-8">
          <div>
            <p className="font-display text-xl md:text-2xl uppercase tracking-wide-2 text-bone">Heavy Weight</p>
            <p className="mt-1 text-[11px] text-grey">240 GSM cotton</p>
          </div>
          <div>
            <p className="font-display text-xl md:text-2xl uppercase tracking-wide-2 text-bone">Oversized</p>
            <p className="mt-1 text-[11px] text-grey">True-to-size boxy fit</p>
          </div>
          <div>
            <p className="font-display text-xl md:text-2xl uppercase tracking-wide-2 text-bone">Fast Ships</p>
            <p className="mt-1 text-[11px] text-grey">24–48 hrs dispatch</p>
          </div>
          <div>
            <p className="font-display text-xl md:text-2xl uppercase tracking-wide-2 text-bone">Easy Swap</p>
            <p className="mt-1 text-[11px] text-grey">7-day size exchange</p>
          </div>
        </div>
      </div>
    </div>
  );
}
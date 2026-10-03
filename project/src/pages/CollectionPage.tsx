import { useEffect, useState } from 'react';
import { ProductCard } from '@/components/ProductCard';
import { Reveal } from '@/components/Reveal';
import { FadeSwap, ProductGridSkeleton } from '@/components/Skeletons';
import { fetchProducts, isRetailVisible, type CatalogProduct } from '@/lib/catalog';

export function CollectionPage() {
  const [filter, setFilter] = useState('all');
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setProducts(null);
    setError(false);
    fetchProducts()
      .then((all) => {
        if (cancelled) return;
        setProducts(all.filter((p) => isRetailVisible(p)));
        setError(false);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
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
      <div className="shell">
        {/* Header */}
        <Reveal className="md:px-0 border-b border-line pb-4 md:pb-8">

          <h1 className="font-display text-[1.5rem] md:text-[5rem] uppercase tracking-wide-2 text-bone leading-[0.85]">
            Shop The Collection
          </h1>
        </Reveal>

        {/* Filters */}
        <div className="flex items-center gap-3 mt-3 mb-5 overflow-x-auto no-scrollbar">
          {[{ label: 'All', value: 'all' }, ...categories.map((c) => ({ label: c, value: c }))].map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`shrink-0 font-label text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 border rounded-full transition-all duration-200 ${
                filter === f.value
                  ? 'bg-bone text-white border-bone'
                  : 'border-line text-bone-dim hover:border-bone-dim hover:text-bone'
              }`}
            >
              {f.label}
            </button>
          ))}
          {!error && products !== null && (
            <span className="ml-auto shrink-0 font-label text-[10px] uppercase tracking-wide-2 text-grey">
              {filtered.length} {filtered.length === 1 ? 'Design' : 'Designs'}
            </span>
          )}
        </div>

        {error && (
          <div className="min-h-[50vh] flex flex-col items-center justify-center text-center px-5">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-crimson">Something went wrong</p>
            <p className="mt-2 text-sm text-crimson">Could not load the collection. Please try again.</p>
            <button
              onClick={() => setLoadKey((k) => k + 1)}
              className="mt-8 btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3.5"
            >
              Try Again
            </button>
          </div>
        )}
      </div>

      {!error && (
        // THE EXACT card container the homepage's THE COLLECTION grid uses.
        // The card component was never the difference — it was always the same
        // ProductCard, with the same grid class string. The difference was THIS
        // wrapper: the grid used to sit inside `.shell`, whose gutter is
        // 1.25rem / 2rem / 3rem and which is capped at max-width 1600px, while the
        // homepage's grid is full-bleed with px-2 / md:px-4 / lg:px-6 / xl:px-8.
        // So every card here came out ~12px narrower on mobile and ~8px on
        // desktop, and the two grids could never agree above 1600px. Reusing the
        // homepage's own section class string makes the two grids identical by
        // construction, with no new component and no duplicated CSS.
        // No vertical padding is added: the page wrapper below already supplies
        // it, exactly as before this grid was moved out of `.shell`, and the gap
        // above the grid is still the filter row's own mb-5.
        <section className="mx-auto w-full px-2 md:px-4 lg:px-6 xl:px-8">
          <FadeSwap loading={products === null} skeleton={<ProductGridSkeleton count={8} />}>
          {filtered.length > 0 ? (
            // Identical grid + identical card call site to the homepage.
            <div className="grid grid-cols-2 md:grid-cols-4 2xl:grid-cols-5 gap-x-0.5 gap-y-5 md:gap-x-8 md:gap-y-8">
            {filtered.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
            </div>
          ) : (
            <div className="py-16 text-center">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No Designs</p>
            <p className="mt-2 text-sm text-grey">{activeCat ? `Nothing in "${activeCat}" yet. ` : ''}More designs coming soon.</p>
            </div>
          )}
          </FadeSwap>
        </section>
      )}
    </div>
  );
}
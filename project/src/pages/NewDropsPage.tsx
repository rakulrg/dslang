import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { ProductCard } from '@/components/ProductCard';
import { FadeSwap, ProductGridSkeleton } from '@/components/Skeletons';
import { fetchProducts, buildWhatsAppGeneralUrl, isRetailVisible, type CatalogProduct } from '@/lib/catalog';

export function NewDropsPage() {
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    setProducts(null);
    setError(false);
    fetchProducts()
      .then((all) => { setProducts(all.filter((p) => isRetailVisible(p))); setError(false); })
      .catch(() => setError(true));
  }, [loadKey]);

  const flagged = [...(products ?? [])].filter((p) => p.new_drop);
  const drops =
    flagged.length > 0
      ? flagged
      : [...(products ?? [])].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

  return (
    <div className="pb-12 md:pb-20 pt-3">
      <div className="mx-auto px-2 md:px-4 lg:px-6 xl:px-8">
        <div className="md:px-0 border-b border-line pb-4 md:pb-8">
          <p className="font-label text-[10px] uppercase tracking-ultra text-grey mb-2">
            DSLANG · Fresh Off The Press
          </p>
          <h1 className="font-display text-[1.75rem] md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            New Drops
          </h1>
          <p className="mt-3 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            The newest colourways and graphics — before they sell out.
          </p>
        </div>

        {error ? (
          <div className="min-h-[50vh] flex flex-col items-center justify-center text-center px-5">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Something went wrong</p>
            <p className="mt-2 text-sm text-grey">Could not load the latest drops. Please try again.</p>
            <button
              onClick={() => setLoadKey((k) => k + 1)}
              className="mt-8 btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3.5"
            >
              Try Again
            </button>
          </div>
        ) : (
          <FadeSwap loading={products === null} skeleton={<ProductGridSkeleton count={8} />}>
          {drops.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-0.5 gap-y-6 md:gap-x-8 md:gap-y-10 pt-6">
              {drops.map((p, i) => (
                <ProductCard key={p.id} product={p} index={i} priority={i < 4} />
              ))}
            </div>
          ) : (
            <div className="py-16 text-center">
              <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Nothing Here Yet</p>
              <p className="mt-2 text-sm text-grey">
                New designs land soon. Stay close.
              </p>
              <a
                href={buildWhatsAppGeneralUrl('Hi DSLANG! When is the next drop coming?')}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-6 inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone hover:text-bone-dim transition-colors"
              >
                <MessageCircle size={14} strokeWidth={2} /> Ask On WhatsApp
              </a>
            </div>
          )}
          </FadeSwap>
        )}
      </div>
    </div>
  );
}
import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { ProductCard } from '@/components/ProductCard';
import { fetchProducts, buildWhatsAppGeneralUrl, type CatalogProduct } from '@/lib/catalog';
import { LoadingDots } from '@/components/LoadingDots';

export function NewDropsPage() {
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    setProducts(null);
    setError(false);
    fetchProducts()
      .then((p) => { setProducts(p); setError(false); })
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
      <div className="mx-auto px-2 md:px-12 lg:px-20 xl:px-28">
        <div className="px-2 md:px-0 border-b border-line pb-4 md:pb-8">
          <p className="font-label text-[10px] uppercase tracking-ultra text-crimson mb-2">
            Latest For Wholesale
          </p>
          <h1 className="font-display text-[1.75rem] md:text-8xl uppercase tracking-wide-2 text-bone leading-[0.9]">
            New Drops
          </h1>
          <p className="mt-3 text-bone-dim max-w-xl leading-relaxed text-sm md:text-base">
            The newest designs available wholesale for stores and resellers.
          </p>
        </div>

        {error ? (
          <div className="min-h-[50vh] flex flex-col items-center justify-center text-center px-5">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Something went wrong</p>
            <p className="mt-2 text-sm text-grey">Could not load the latest drops. Please try again.</p>
            <button
              onClick={() => setLoadKey((k) => k + 1)}
              className="mt-8 inline-flex items-center text-[11px] uppercase tracking-wide-2 font-semibold bg-crimson text-white px-6 py-3.5 hover:bg-crimson-dark transition-colors"
            >
              Try Again
            </button>
          </div>
        ) : products === null ? (
          <div className="min-h-[50vh] flex items-center justify-center"><LoadingDots /></div>
        ) : drops.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-8 pt-6">
            {drops.map((p, i) => (
              <ProductCard key={p.id} product={p} index={i} />
            ))}
          </div>
        ) : (
          <div className="py-16 text-center">
            <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">Nothing Here Yet</p>
            <p className="mt-2 text-sm text-grey">New designs land soon. Reach out on WhatsApp for the latest arrival list.</p>
            <a
              href={buildWhatsAppGeneralUrl("Hi DSLANG! What are the latest wholesale drops available?")}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
            >
              <MessageCircle size={14} strokeWidth={2} /> Ask On WhatsApp
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
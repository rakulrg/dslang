import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { fetchProducts, isRetailVisible, getRetailPrice, getMrp, formatPrice, type CatalogProduct } from '@/lib/catalog';
import { linkHref } from '@/lib/router';
import { lockScroll, unlockScroll } from '@/lib/scrollLock';

let cachedProducts: CatalogProduct[] | null = null;

function loadProducts(): Promise<CatalogProduct[]> {
  if (cachedProducts) return Promise.resolve(cachedProducts);
  return fetchProducts()
    .then((all) => {
      cachedProducts = all.filter((p) => isRetailVisible(p));
      return cachedProducts;
    })
    .catch(() => []);
}

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<CatalogProduct[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    loadProducts().then(setProducts);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    lockScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      unlockScroll();
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const q = query.trim().toLowerCase();
  const results = q.length === 0
    ? products
    : products.filter((p) => {
        const name = p.name.toLowerCase();
        const code = (p.code || '').toLowerCase();
        const category = (p.category || '').toLowerCase();
        const colors = p.colors.map((c) => c.name.toLowerCase());
        return [name, code, category, ...colors].some((t) => t.includes(q));
      });

  return (
    <div
      className="fixed inset-0 z-[80]"
      style={{ pointerEvents: open ? 'auto' : 'none' }}
      aria-hidden={!open}
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-200"
        style={{ opacity: open ? 1 : 0 }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search products"
        className="absolute left-1/2 top-[92px] md:top-[104px] w-[calc(100vw-2rem)] max-w-2xl max-h-[75dvh] flex flex-col overflow-hidden bg-paper-2 border border-line shadow-[0_20px_60px_rgba(0,0,0,0.55)] will-change-transform"
        style={{
          transform: open ? 'translateX(-50%) translateY(0)' : 'translateX(-50%) translateY(-12px)',
          opacity: open ? 1 : 0,
          transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1), opacity 160ms ease',
        }}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 md:px-5 h-14 shrink-0">
          <Search size={18} className="text-grey shrink-0" strokeWidth={1.8} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search designs, codes, colors…"
            className="flex-1 min-w-0 bg-transparent text-sm text-bone placeholder:text-grey focus:outline-none"
          />
          <button onClick={onClose} className="text-grey hover:text-bone transition-colors p-1 shrink-0" aria-label="Close search">
            <X size={20} strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {results.length === 0 ? (
            <div className="py-16 text-center px-6">
              <p className="font-label text-2xl uppercase tracking-wide-2 text-grey">No Results</p>
              <p className="mt-2 text-sm text-grey">
                {q ? `Nothing matches "${query.trim()}".` : 'Start typing to find a design.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {results.slice(0, 12).map((p) => {
                const primary = p.colors[0];
                const image = primary?.images[0];
                const price = getRetailPrice(p);
                const mrp = getMrp(p);
                return (
                  <a
                    key={p.id}
                    href={linkHref(`/product/${p.slug}`)}
                    onClick={onClose}
                    className="flex items-center gap-4 px-4 md:px-5 py-3.5 hover:bg-paper-2 transition-colors"
                  >
                    <div className="w-14 h-[70px] shrink-0 border border-line bg-paper-3 overflow-hidden">
                      {image && (
                        <img src={image} alt={p.name} loading="lazy" className="w-full h-full object-cover" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-bone truncate">{p.name}</p>
                      <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mt-0.5">
                        {(p.category || 'tee')} · {p.code}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      {price > 0 && (
                        <p className="font-price text-sm font-semibold text-bone tabular-nums">{formatPrice(price)}</p>
                      )}
                      {mrp !== null && mrp > price && (
                        <p className="font-price text-[11px] text-grey line-through tabular-nums">{formatPrice(mrp)}</p>
                      )}
                    </div>
                  </a>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-line px-4 md:px-5 py-3 flex items-center justify-between shrink-0">
          <span className="font-label text-[10px] uppercase tracking-wide-2 text-grey">
            {results.length} {results.length === 1 ? 'design' : 'designs'}
          </span>
          <button
            onClick={() => { onClose(); window.location.hash = '#/collection'; }}
            className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
          >
            View Collection →
          </button>
        </div>
      </div>
    </div>
  );
}
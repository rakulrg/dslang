import { useEffect, useState, useRef } from 'react';
import { X, Search, MessageCircle } from 'lucide-react';
import { fetchProducts, getWholesaleSlabs, formatPrice, buildWhatsAppGeneralUrl, type CatalogProduct } from '@/lib/catalog';
import { linkHref } from '@/lib/router';

export function SearchModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      fetchProducts().then(setProducts).catch(() => {});
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const q = query.trim().toLowerCase();
  const results = q
    ? products.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.code.toLowerCase().includes(q) ||
          (p.category || '').toLowerCase().includes(q)
      )
    : [];

  return (
    <div
      className="fixed inset-0 z-[65]"
      style={{ pointerEvents: isOpen ? 'auto' : 'none' }}
      aria-hidden={!isOpen}
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-200"
        style={{ opacity: isOpen ? 1 : 0 }}
        onClick={onClose}
      />
      <div
        className="absolute left-0 right-0 top-8 bg-white border-b border-line will-change-transform"
        style={{
          transform: isOpen ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 250ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="mx-auto max-w-3xl px-5 md:px-8 py-5">
          <div className="flex items-center gap-3 border-b border-line pb-3">
            <Search size={20} className="text-grey shrink-0" strokeWidth={1.8} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the wholesale collection…"
              className="flex-1 bg-transparent text-lg text-bone placeholder:text-grey focus:outline-none min-w-0"
            />
            <button onClick={onClose} className="text-grey hover:text-bone transition-colors p-1" aria-label="Close search">
              <X size={20} strokeWidth={1.8} />
            </button>
          </div>

          <div
            className="mt-2 overflow-y-auto"
            style={{ maxHeight: 'min(60vh, 520px)' }}
          >
            {q && results.length === 0 && (
              <p className="py-8 text-center text-sm text-grey">
                No wholesale product matches "{query.trim()}".
              </p>
            )}
            {q && (
              <ul className="divide-y divide-line">
                {results.map((p) => {
                  const slabs = getWholesaleSlabs(p);
                  const image = p.colors[0]?.images[0];
                  const wa = buildWhatsAppGeneralUrl(
                    `Hi DSLANG! I'm interested in the wholesale listing: ${p.name} (${p.code}). Please share availability and wholesale pricing.`
                  );
                  return (
                    <li key={p.id}>
                      <div className="flex items-center gap-3 py-3">
                        <div className="w-12 aspect-[4/5] shrink-0 overflow-hidden bg-paper-3 border border-line">
                          {image && <img src={image} alt={p.name} className="w-full h-full object-cover" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <a
                            href={linkHref(`/product/${p.slug}`)}
                            onClick={onClose}
                            className="text-sm font-semibold text-bone hover:text-crimson transition-colors leading-tight block truncate"
                          >
                            {p.name}
                          </a>
                          <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mt-0.5">
                            {p.code} · MOQ {slabs.moq} PCS
                          </p>
                          <p className="font-price text-sm text-bone-dim mt-0.5">
                            {slabs.price50 > 0 && `${formatPrice(slabs.price50)}/PC`}
                          </p>
                        </div>
                        <a
                          href={wa}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={onClose}
                          className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] font-semibold text-crimson hover:text-crimson-dark transition-colors shrink-0"
                        >
                          <MessageCircle size={13} strokeWidth={2} /> Enquire
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {!q && (
              <div className="py-6 flex flex-wrap gap-2">
                <span className="font-label text-[10px] uppercase tracking-[0.18em] text-grey mt-0.5 w-full mb-1">
                  Popular
                </span>
                {products.slice(0, 6).map((p) => (
                  <a
                    key={p.id}
                    href={linkHref(`/product/${p.slug}`)}
                    onClick={onClose}
                    className="text-[11px] uppercase tracking-wide-2 border border-line px-3 py-2 text-bone-dim hover:border-crimson hover:text-crimson transition-colors"
                  >
                    {p.name}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
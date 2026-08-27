import { X, Minus, Plus, Trash2, MessageCircle, ShoppingBag, AlertTriangle, Loader2 } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useCart } from '@/lib/cart';
import {
  buildWholesaleWhatsAppUrl,
  summarizeWholesale,
  formatPrice,
  type WholesaleSkuLine,
} from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';
import { supabase } from '@/lib/supabase';
import { linkHref } from '@/lib/router';

export function CartDrawer() {
  const { items, isOpen, close, removeItem, updateQty, count, clear } = useCart();
  const [showForm, setShowForm] = useState(false);
  const [seller, setSeller] = useState({ businessName: '', phone: '', city: '' });
  const [submitting, setSubmitting] = useState(false);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { settings } = useSiteSettings();
  const moq = settings.default_moq;
  const minOrderQty = settings.min_order_quantity;

  const lines: WholesaleSkuLine[] = items.map((i) => ({
    productId: i.productId,
    name: i.name,
    code: i.code,
    color: i.color,
    colorHex: i.colorHex,
    image: i.image,
    slug: i.slug,
    packs: i.packs,
    m: i.m,
    l: i.l,
    xl: i.xl,
    qty: i.qty,
    price50: i.price50,
    price100: i.price100,
  }));
  const summary = summarizeWholesale(lines);
  const belowMoaq = summary.totalQty < minOrderQty;

  // Reset checkout state when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setShowForm(false);
      setSubmitting(false);
      setSeller({ businessName: '', phone: '', city: '' });
    }
  }, [isOpen]);

  // Body scroll lock with scrollbar compensation
  useEffect(() => {
    if (isOpen) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
    } else {
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      document.body.style.paddingRight = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      document.body.style.paddingRight = '';
    };
  }, [isOpen]);

  // Auto-close cart after 3 seconds if empty
  useEffect(() => {
    if (isOpen && items.length === 0) {
      autoCloseTimer.current = setTimeout(() => {
        close();
        autoCloseTimer.current = null;
      }, 3000);
    }
    return () => {
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current);
        autoCloseTimer.current = null;
      }
    };
  }, [isOpen, items.length, close]);

  const handleSubmit = async () => {
    if (items.length === 0 || belowMoaq) return;
    setSubmitting(true);
    let orderRef: string | undefined;
    try {
      const { data, error } = await supabase.rpc('create_wholesale_order', {
        p_lines: lines.map((l) => ({
          product_id: l.productId,
          name: l.name,
          code: l.code,
          color: l.color,
          color_hex: l.colorHex,
          image: l.image,
          slug: l.slug,
          packs: l.packs,
          m: l.m,
          l: l.l,
          xl: l.xl,
          qty: l.qty,
          price50: l.price50,
          price100: l.price100,
        })),
        p_seller:
          seller.businessName || seller.phone || seller.city
            ? { business_name: seller.businessName, phone: seller.phone, city: seller.city }
            : {},
      });
      if (!error && data && typeof data.ref === 'string' && data.ref) {
        orderRef = `DSLANG-W-${data.ref}`;
      }
    } catch {
      // Order logging is best-effort — WhatsApp ordering still proceeds.
    }
    const url = buildWholesaleWhatsAppUrl({
      lines,
      businessName: seller.businessName || undefined,
      phone: seller.phone || undefined,
      city: seller.city || undefined,
      orderRef,
    });
    window.open(url, '_blank', 'noopener,noreferrer');
    setSubmitting(false);
    setShowForm(false);
    close();
  };

  // Group items per product for display, then per color. Each group records
  // the global cart index of its first line so edits map back to the real item.
  const groups: { productId: string; productItems: typeof items; startIndex: number }[] = [];
  {
    const byProduct = new Map<string, typeof items>();
    for (const item of items) {
      if (!byProduct.has(item.productId)) byProduct.set(item.productId, []);
      byProduct.get(item.productId)!.push(item);
    }
    let cursor = 0;
    for (const [productId, productItems] of byProduct) {
      groups.push({ productId, productItems, startIndex: cursor });
      cursor += productItems.length;
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70]"
      style={{ pointerEvents: isOpen ? 'auto' : 'none' }}
      aria-hidden={!isOpen}
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-200"
        style={{ opacity: isOpen ? 1 : 0 }}
        onClick={close}
      />
      <div
        className="absolute right-0 top-8 w-[85vw] max-w-lg bg-white border-l border-line flex flex-col overflow-hidden will-change-transform"
        style={{
          height: 'calc(100dvh - 2rem)',
          maxHeight: 'calc(100dvh - 2rem)',
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 250ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between h-16 px-5 border-b border-line shrink-0">
          <div className="flex items-center gap-2">
            <ShoppingBag size={18} className="text-bone" strokeWidth={1.8} />
            <span className="font-display text-xl tracking-wide-2 text-bone uppercase">Wholesale Order</span>
            {count > 0 && (
              <span className="text-xs text-grey">({count} PCS)</span>
            )}
          </div>
          <button onClick={close} className="text-bone-dim hover:text-bone transition-colors p-1" aria-label="Close wholesale order">
            <X size={22} strokeWidth={1.8} />
          </button>
        </div>

        {/* Items */}
        {items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
            <ShoppingBag size={48} className="text-line mb-4" strokeWidth={1} />
            <p className="font-label text-2xl uppercase tracking-wide-2 text-grey">No pieces selected</p>
            <p className="mt-2 text-sm text-bone-soft">Build a wholesale mix of MOQ {moq} PCS — order acceptance from {minOrderQty} PCS.</p>
            <a
              href={linkHref('/collection')}
              onClick={close}
              className="mt-6 inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
            >
              Browse Wholesale Collection →
            </a>
          </div>
        ) : (
          <>
            <div
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 py-4 space-y-5"
              style={{ WebkitOverflowScrolling: 'touch' }}
            >
              {groups.map(({ productId, productItems, startIndex }) => {
                const first = productItems[0];
                const productQty = productItems.reduce((s, i) => s + i.qty, 0);
                const unit = productQty >= 100 && first.price100 > 0 ? first.price100 : first.price50;
                return (
                  <div key={productId} className="border-b border-line pb-4">
                    <div className="flex items-start gap-3">
                      <div className="w-14 h-16 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
                        {first.image && (
                          <img src={first.image} alt={first.name} className="w-full h-full object-cover" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <a href={linkHref(`/product/${first.slug}`)} onClick={close} className="text-sm font-semibold text-bone hover:text-crimson transition-colors leading-tight block">
                          {first.name}
                        </a>
                        <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mt-0.5">
                          {first.code} · {productQty} PCS · {formatPrice(unit)}/PC
                        </p>
                      </div>
                    </div>
                    {/* Per color pack breakdown */}
                    {productItems.map((item, itemIdx) => {
                      const globalIdx = startIndex + itemIdx;
                      return (
                        <div key={`${item.color}`} className="mt-3 flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 border border-line shrink-0" style={{ backgroundColor: item.colorHex }} />
                            <span className="text-xs text-bone-dim truncate">
                              {item.color}
                              {item.packs > 0 && (
                                <span className="text-grey"> — {item.m} M · {item.l} L · {item.xl} XL</span>
                              )}
                            </span>
                          </span>
                          <div className="inline-flex items-center border border-line shrink-0">
                            <button
                              onClick={() => (item.packs <= 1 ? removeItem(globalIdx) : updateQty(globalIdx, item.packs - 1))}
                              disabled={submitting}
                              className="w-7 h-7 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                              aria-label="Decrease packs"
                            >
                              <Minus size={12} strokeWidth={2} />
                            </button>
                            <span className="w-8 text-center text-sm font-medium tabular-nums">
                              {item.packs}
                            </span>
                            <button
                              onClick={() => updateQty(globalIdx, item.packs + 1)}
                              disabled={submitting}
                              className="w-7 h-7 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                              aria-label="Increase packs"
                            >
                              <Plus size={12} strokeWidth={2} />
                            </button>
                          </div>
                          <span className="w-12 text-right text-xs font-medium tabular-nums text-bone shrink-0">
                            {item.qty} PCS
                          </span>
                          <button
                            onClick={() => removeItem(globalIdx)}
                            disabled={submitting}
                            className="text-grey hover:text-crimson transition-colors p-1 shrink-0 disabled:opacity-30"
                            aria-label="Remove line"
                          >
                            <Trash2 size={14} strokeWidth={1.6} />
                          </button>
                        </div>
                      );
                    })}
                    <p className="mt-2 font-label text-[10px] uppercase tracking-wide-2 text-grey">
                      {productQty} PCS → {formatPrice(unit)}/PC
                    </p>
                  </div>
                );
              })}
              <button
                onClick={clear}
                className="font-label text-[10px] uppercase tracking-wide-2 text-grey hover:text-crimson transition-colors"
              >
                Clear all
              </button>
            </div>

            {/* Footer */}
            <div
              className="border-t border-line px-5 pt-5 pb-5 space-y-4 shrink-0"
              style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}
            >
              <div className="flex items-center justify-between">
                <span className="font-label text-[11px] uppercase tracking-wide-2 text-grey">Total Quantity</span>
                <span className="font-price text-lg text-bone tabular-nums">
                  {summary.totalQty} PCS
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-label text-[11px] uppercase tracking-wide-2 text-grey">Wholesale Price</span>
                <span className="font-price text-base text-bone-dim">
                  {summary.tiers.length > 0 ? summary.tiers.map((t) => t.name).join(' / ') : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-label text-[11px] uppercase tracking-wide-2 text-bone">Order Total</span>
                <span className="font-price text-2xl text-crimson">{formatPrice(summary.total)}</span>
              </div>

              {belowMoaq && (
                <div className="flex items-start gap-2 rounded border border-crimson/30 bg-crimson/5 px-3 py-3">
                  <AlertTriangle size={16} className="text-crimson mt-0.5 shrink-0" strokeWidth={1.8} />
                  <p className="text-xs text-crimson leading-relaxed">
                    Order acceptance starts from {minOrderQty} PCS (MOQ {moq} PCS). Add {minOrderQty - summary.totalQty} more PCS across colors to place your order.
                  </p>
                </div>
              )}

              {showForm && (
                <div className="rounded border border-line bg-paper-2 p-3 space-y-3">
                  <p className="text-[11px] uppercase tracking-wide-2 text-bone-dim">Seller details</p>
                  <input value={seller.businessName} onChange={(e) => setSeller((p) => ({ ...p, businessName: e.target.value }))} placeholder="Shop / Business name" className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-bone outline-none" />
                  <input value={seller.phone} onChange={(e) => setSeller((p) => ({ ...p, phone: e.target.value }))} placeholder="WhatsApp number" className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-bone outline-none" />
                  <input value={seller.city} onChange={(e) => setSeller((p) => ({ ...p, city: e.target.value }))} placeholder="City" className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-bone outline-none" />
                </div>
              )}

              <button
                onClick={() => setShowForm((s) => !s)}
                className="w-full inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold py-4 rounded hover:bg-crimson-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={belowMoaq}
              >
                <MessageCircle size={18} strokeWidth={2} />
                {showForm ? 'Back' : 'Request Wholesale Order'}
              </button>
              {showForm && (
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="w-full inline-flex items-center justify-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold py-4 rounded hover:bg-ink transition-colors disabled:opacity-60"
                >
                  {submitting ? <Loader2 size={18} strokeWidth={2} className="animate-spin" /> : <MessageCircle size={18} strokeWidth={2} />}
                  {submitting ? 'Logging order…' : 'Confirm & Send on WhatsApp'}
                </button>
              )}
              <a
                href={linkHref('/collection')}
                onClick={close}
                className="block text-center text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-crimson transition-colors"
              >
                Continue Browsing →
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
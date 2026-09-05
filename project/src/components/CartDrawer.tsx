import { useEffect, useRef, useState } from 'react';
import { X, Minus, Plus, Trash2, ArrowRight, Check, Loader2, ShoppingBag, Tag } from 'lucide-react';
import { useD2cCart } from '@/lib/d2cCart';
import { useCartDrawer } from '@/lib/cartDrawer';
import { useRouter } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';
import { computeShipping } from '@/lib/settings';
import {
  validatePromo,
  computeDiscount,
  promoApplies,
} from '@/lib/promo';
import { fetchLiveVariantStock, reconcileCartWithLive, describeStockChanges } from '@/lib/cartStock';
import { lockScroll, unlockScroll } from '@/lib/scrollLock';

/**
 * Bag drawer — slides in from the RIGHT, matching the premium visual language
 * of the left-side navigation menu drawer in Navbar.tsx.
 *
 * Mobile: ~98vw width (small page/overlay visible behind).
 * Desktop: 440px right panel.
 * Both are full-height below the announcement bar / header.
 *
 * Auto-closes when the last line is removed. If opened while empty it
 * auto-closes after 3 seconds. The timer is cancelled immediately if an item
 * is added, and cleared on close/unmount. ESC / backdrop / X close it.
 * Body scrolling is locked while open.
 *
 * Promo codes are validated server-side on APPLY and persisted through the
 * cart/checkout flow.
 *
 * Every time the drawer opens the cart is re-validated against live DB stock;
 * variants that went out of stock (or whose quantity now exceeds stock) are
 * reconciled in the cart and a clear notice is shown.
 */
export function CartDrawer() {
  const { isOpen, closeCart } = useCartDrawer();
  const { items, count, subtotal, setQuantity, removeItem, reconcileWithLiveStock, promo, applyPromo, removeAppliedPromo } = useD2cCart();
  const { navigate } = useRouter();
  const shipping = computeShipping(subtotal);

  const [promoInput, setPromoInput] = useState('');
  const [applying, setApplying] = useState(false);
  const [promoError, setPromoError] = useState('');
  const [stockNotice, setStockNotice] = useState('');

  const prevItemsRef = useRef(items.length);

  // Auto-close when the LAST item is removed (drawer was open with items).
  useEffect(() => {
    if (isOpen && prevItemsRef.current > 0 && items.length === 0) closeCart();
    prevItemsRef.current = items.length;
  }, [isOpen, items.length, closeCart]);

  // Auto-close an EMPTY drawer after 3 seconds.
  useEffect(() => {
    if (!isOpen || items.length > 0) return;
    const t = window.setTimeout(() => closeCart(), 3000);
    return () => window.clearTimeout(t);
  }, [isOpen, items.length, closeCart]);

  // Re-validate the cart against live DB stock each time the drawer opens.
  useEffect(() => {
    if (!isOpen || items.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const live = await fetchLiveVariantStock(items);
        if (cancelled) return;
        const { changes } = reconcileCartWithLive(items, live);
        const notice = describeStockChanges(changes);
        if (notice) {
          setStockNotice(notice);
          reconcileWithLiveStock(live);
        } else {
          setStockNotice('');
        }
      } catch {
        // Ignore network failures here — the server still re-validates at
        // checkout, so a transient fetch failure never endorses a bad order.
        if (!cancelled) setStockNotice('');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Body scroll lock while the drawer is open.
  useEffect(() => {
    if (isOpen) {
      lockScroll();
      return () => unlockScroll();
    }
  }, [isOpen]);

  // ESC closes the drawer (desktop).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCart();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, closeCart]);

  const goToCheckout = () => {
    if (items.length === 0) return;
    closeCart();
    // Let the drawer's slide-out transition play, then navigate, so the panel
    // visibly closes over the current page instead of snapping to a new page.
    window.setTimeout(() => navigate('/checkout'), 250);
  };

  const goToCollection = () => {
    closeCart();
    navigate('/collection');
  };

  const handleApplyPromo = async () => {
    if (applying) return;
    setApplying(true);
    setPromoError('');
    const res = await validatePromo(promoInput, subtotal);
    setApplying(false);
    if (res.ok && res.promo) {
      applyPromo(res.promo);
      setPromoInput('');
    } else {
      setPromoError(res.reason ?? 'This code is invalid or expired.');
    }
  };

  const handleRemovePromo = () => {
    removeAppliedPromo();
    setPromoInput('');
  };

  const discount = promoApplies(subtotal, promo) ? computeDiscount(subtotal, promo) : 0;
  const total = subtotal - discount + shipping;

  return (
    <div className="fixed inset-0 z-[60]" style={{ pointerEvents: isOpen ? 'auto' : 'none' }} aria-hidden={!isOpen}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-200"
        style={{ opacity: isOpen ? 1 : 0 }}
        onClick={closeCart}
      />

      {/* Panel — slides from RIGHT, full-height below the announcement bar / header */}
      <aside
        className="absolute right-0 top-8 h-[calc(100dvh-2rem)] w-[98vw] md:w-[440px] bg-paper-2 border-l border-line flex flex-col will-change-transform"
        style={{
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 250ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
        role="dialog"
        aria-label="Shopping bag"
      >
        {/* Header */}
        <div className="flex items-center justify-between h-11 px-5 border-b border-line shrink-0">
          <h2 className="font-display text-lg uppercase tracking-wide-2 text-bone">Your Bag</h2>
          <button onClick={closeCart} className="text-bone p-1" aria-label="Close bag">
            <X size={22} strokeWidth={1.6} />
          </button>
        </div>

        {items.length === 0 ? (
          /* ---- Empty state ---- */
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <ShoppingBag size={30} strokeWidth={1.3} className="text-grey" />
            <p className="mt-4 font-display text-2xl uppercase tracking-wide-2 text-bone">Your Bag Is Empty</p>
            <button
              onClick={goToCollection}
              className="mt-6 inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3.5 hover:bg-crimson-dark transition-colors"
            >
              Explore Collection <ArrowRight size={14} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <>
            {/* Items */}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
              {stockNotice && (
                <div className="px-5 py-3 border-b border-line bg-amber-950/60">
                  <p className="text-xs text-amber-300 whitespace-pre-line leading-relaxed">{stockNotice}</p>
                </div>
              )}
              <div className="divide-y divide-line">
                {items.map((item, idx) => {
                  const capped = item.stock > 0 ? Math.min(item.quantity, item.stock) : item.quantity;
                  return (
                    <div key={`${item.productId}-${item.colorId}-${item.sizeLabel}`} className="flex gap-3 px-5 py-4">
                      <a
                        href={`#/product/${item.slug}`}
                        onClick={closeCart}
                        className="w-[76px] h-[96px] shrink-0 overflow-hidden bg-paper-3 border border-line"
                      >
                        {item.image && <img src={item.image} alt={item.name} className="w-full h-full object-cover" loading="lazy" />}
                      </a>
                      <div className="flex-1 min-w-0 flex flex-col">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <a
                              href={`#/product/${item.slug}`}
                              onClick={closeCart}
                              className="block font-semibold text-[13px] text-bone line-clamp-2 hover:text-crimson transition-colors"
                            >
                              {item.name}
                            </a>
                            <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mt-0.5">
                              {item.color} · {item.sizeLabel}
                            </p>
                          </div>
                          <button
                            onClick={() => removeItem(idx)}
                            className="text-grey/70 hover:text-crimson transition-colors p-0.5 mt-0.5"
                            aria-label="Remove item"
                          >
                            <Trash2 size={15} strokeWidth={1.8} />
                          </button>
                        </div>

                        <div className="mt-auto flex items-center justify-between gap-3 pt-2.5">
                          <div className="inline-flex items-center border border-line">
                            <button
                              onClick={() => setQuantity(idx, Math.max(1, item.quantity - 1))}
                              className="w-8 h-9 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors"
                              aria-label="Decrease quantity"
                            >
                              <Minus size={13} strokeWidth={2} />
                            </button>
                            <span className="w-7 text-center text-sm font-semibold tabular-nums text-bone select-none">
                              {item.quantity}
                            </span>
                            <button
                              onClick={() => setQuantity(idx, item.quantity + 1)}
                              disabled={item.stock > 0 && capped >= item.stock}
                              className="w-8 h-9 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30"
                              aria-label="Increase quantity"
                            >
                              <Plus size={13} strokeWidth={2} />
                            </button>
                          </div>
                          <p className="font-price text-sm font-semibold text-bone tabular-nums whitespace-nowrap">
                            {formatPrice(item.unitPrice * item.quantity)}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer: ORDER SUMMARY → PROMO CODE → CHECKOUT */}
            <div className="border-t border-line shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
              {/* ORDER SUMMARY */}
              <div className="px-5 pt-4">
                <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2">Order Summary</p>
                <dl className="space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-grey">Subtotal</dt>
                    <dd className="font-semibold text-bone tabular-nums">{formatPrice(subtotal)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-grey">Discount</dt>
                    <dd className={`font-semibold tabular-nums ${discount > 0 ? 'text-green-400' : 'text-grey'}`}>
                      {discount > 0 ? `−${formatPrice(discount)}` : '—'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-grey">Shipping</dt>
                    <dd className="font-semibold text-bone tabular-nums">
                      {shipping > 0 ? formatPrice(shipping) : <span className="text-green-400">FREE</span>}
                    </dd>
                  </div>
                  <p className="text-[10px] text-grey text-right">
                    {shipping > 0
                      ? `FREE shipping on orders ₹999+`
                      : `You've unlocked FREE shipping`}
                  </p>
                  <div className="flex items-center justify-between border-t border-line pt-2 mt-2">
                    <dt className="font-label text-xs uppercase tracking-wide-2 text-bone">Total</dt>
                    <dd className="font-price text-xl text-crimson tabular-nums">
                      {(total || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Promo code */}
              <div className="px-5 pt-4">
                <div className="flex items-center gap-2">
                  <Tag size={13} strokeWidth={1.8} className="text-bone-dim" />
                  <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold">Promo Code</p>
                </div>
                {promo ? (
                  <>
                    <div className="mt-2 flex items-center justify-between border border-green-900/70 bg-green-950/50 px-3 py-2.5">
                      <span className="inline-flex items-center gap-2 text-xs font-semibold text-green-400">
                        <Check size={14} strokeWidth={2.5} /> {promo.code} APPLIED
                      </span>
                      <button
                        onClick={handleRemovePromo}
                        className="text-[10px] uppercase tracking-wide-2 font-semibold text-green-400 underline underline-offset-2 hover:text-green-300"
                      >
                        Remove
                      </button>
                    </div>
                    {!promoApplies(subtotal, promo) && (
                      <p className="mt-1.5 text-xs text-grey">
                        Add {formatPrice((promo.min_order_value || 0) - subtotal)} more to use this code — it will
                        not apply at checkout below that amount.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="mt-2 flex gap-2">
                      <input
                        value={promoInput}
                        onChange={(e) => setPromoInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleApplyPromo(); }}
                        placeholder="Enter promo code"
                        autoCapitalize="characters"
                        spellCheck={false}
                        className="flex-1 min-w-0 border border-line px-3 py-2.5 text-sm text-bone placeholder:text-grey/60 focus:border-crimson focus:outline-none transition-colors"
                      />
                      <button
                        onClick={handleApplyPromo}
                        disabled={applying || !promoInput.trim()}
                        className="inline-flex items-center gap-1.5 shrink-0 bg-bone text-ink text-[10px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 hover:bg-bone-dim transition-colors disabled:opacity-40"
                      >
                        {applying ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : 'Apply'}
                      </button>
                    </div>
                    {promoError && <p className="mt-1.5 text-xs text-crimson">{promoError}</p>}
                  </>
                )}
              </div>

              {/* Actions */}
              <div className="px-5 pt-4 pb-3 space-y-2">
                <button
                  onClick={goToCheckout}
                  className="w-full inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold py-4 px-5 hover:bg-crimson-dark hover:glow-crimson focus-visible:glow-crimson transition-all duration-150 active:scale-[0.99]"
                >
                  Checkout <ArrowRight size={15} strokeWidth={2} />
                </button>
                <button
                  onClick={closeCart}
                  className="w-full font-label text-[11px] uppercase tracking-wide-2 text-grey hover:text-crimson transition-colors py-2.5"
                >
                  Continue Shopping
                </button>
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
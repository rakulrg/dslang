import { X, Minus, Plus, Trash2, MessageCircle, ShoppingBag } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useCart, formatPrice } from '@/lib/cart';
import { buildWhatsAppUrl } from '@/lib/catalog';
import { linkHref } from '@/lib/router';

export function CartDrawer() {
  const { items, isOpen, close, removeItem, updateQty, subtotal, count, clear } = useCart();
  const [showForm, setShowForm] = useState(false);
  const [customer, setCustomer] = useState({ name: '', phone: '', city: '', address: '' });
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset checkout state when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setShowForm(false);
      setCustomer({ name: '', phone: '', city: '', address: '' });
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

  const handleCheckout = () => {
    if (items.length === 0) return;
    setShowForm(true);
  };

  const handleSubmit = () => {
    if (items.length === 0) return;
    if (!customer.name || !customer.phone || !customer.city || !customer.address) return;

    const message = items
      .map((item) => `${item.name} | ${item.color} | Size ${item.size} | Qty ${item.qty} | ${formatPrice(item.price * item.qty)}`)
      .join('\n');

    const url = buildWhatsAppUrl({
      name: items.map((i) => i.name).join(', '),
      code: items.map((i) => i.code).join(', '),
      color: items.map((i) => i.color).join(', '),
      size: items.map((i) => i.size).join(', '),
      quantity: count,
      price: subtotal,
      total: subtotal,
      customerName: customer.name,
      phone: customer.phone,
      city: customer.city,
      address: customer.address,
      notes: `Order Summary:\n${message}`,
    });
    window.open(url, '_blank', 'noopener,noreferrer');
    setShowForm(false);
    close();
  };

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
            <span className="font-display text-xl tracking-wide-2 text-bone uppercase">Cart</span>
            {count > 0 && (
              <span className="text-xs text-grey">({count})</span>
            )}
          </div>
          <button onClick={close} className="text-bone-dim hover:text-bone transition-colors p-1" aria-label="Close cart">
            <X size={22} strokeWidth={1.8} />
          </button>
        </div>

        {/* Items */}
        {items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
            <ShoppingBag size={48} className="text-line mb-4" strokeWidth={1} />
            <p className="font-label text-2xl uppercase tracking-wide-2 text-grey">Your cart is empty.</p>
            <a
              href={linkHref('/shop')}
              onClick={close}
              className="mt-6 inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
            >
              Continue Shopping →
            </a>
          </div>
        ) : (
          <>
            <div
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 py-4 space-y-4"
              style={{ WebkitOverflowScrolling: 'touch' }}
            >
              {items.map((item, i) => (
                <div key={i} className="flex gap-3 border-b border-line pb-4">
                  <div className="w-16 h-20 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
                    {item.image && (
                      <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-bone truncate">{item.name}</h4>
                    <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mt-0.5">
                      {item.color} · Size {item.size}
                    </p>
                    <p className="font-price text-sm text-bone-dim mt-1">{formatPrice(item.price)}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="inline-flex items-center border border-line">
                        <button
                          onClick={() => updateQty(i, item.qty - 1)}
                          className="w-8 h-8 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors"
                          aria-label="Decrease quantity"
                        >
                          <Minus size={14} strokeWidth={2} />
                        </button>
                        <span className="w-9 text-center text-sm font-medium tabular-nums">{item.qty}</span>
                        <button
                          onClick={() => updateQty(i, item.qty + 1)}
                          disabled={item.qty >= item.stock}
                          className="w-8 h-8 flex items-center justify-center text-bone-dim hover:text-crimson transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label="Increase quantity"
                        >
                          <Plus size={14} strokeWidth={2} />
                        </button>
                      </div>
                      <button
                        onClick={() => removeItem(i)}
                        className="text-grey hover:text-crimson transition-colors p-1"
                        aria-label="Remove item"
                      >
                        <Trash2 size={15} strokeWidth={1.6} />
                      </button>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-price text-sm text-bone">{formatPrice(item.price * item.qty)}</p>
                  </div>
                </div>
              ))}
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
                <span className="font-label text-[11px] uppercase tracking-wide-2 text-grey">Subtotal</span>
                <span className="font-price text-lg text-bone">{formatPrice(subtotal)}</span>
              </div>
              <p className="text-xs text-grey">Shipping is confirmed via WhatsApp. Free over ₹999.</p>
              {showForm && (
                <div className="rounded border border-line bg-paper-2 p-3 space-y-3">
                  <p className="text-[11px] uppercase tracking-wide-2 text-bone-dim">Customer details</p>
                  <input value={customer.name} onChange={(e) => setCustomer((p) => ({ ...p, name: e.target.value }))} placeholder="Full name" className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-bone outline-none" />
                  <input value={customer.phone} onChange={(e) => setCustomer((p) => ({ ...p, phone: e.target.value }))} placeholder="Phone number" className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-bone outline-none" />
                  <input value={customer.city} onChange={(e) => setCustomer((p) => ({ ...p, city: e.target.value }))} placeholder="City" className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-bone outline-none" />
                  <textarea value={customer.address} onChange={(e) => setCustomer((p) => ({ ...p, address: e.target.value }))} placeholder="Delivery address" rows={3} className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-bone outline-none" />
                  <button
                    onClick={handleSubmit}
                    className="w-full inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold py-3 rounded hover:bg-crimson-dark transition-colors"
                  >
                    <MessageCircle size={18} strokeWidth={2} />
                    Continue to WhatsApp
                  </button>
                </div>
              )}
              {!showForm && (
                <button
                  onClick={handleCheckout}
                  className="w-full inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold py-4 rounded hover:bg-crimson-dark transition-colors"
                >
                  <MessageCircle size={18} strokeWidth={2} />
                  Order via WhatsApp
                </button>
              )}
              <a
                href={linkHref('/shop')}
                onClick={close}
                className="block text-center text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-crimson transition-colors"
              >
                Continue Shopping →
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { MessageCircle, ShoppingBag } from 'lucide-react';
import { useCart } from '@/lib/cart';
import { buildWhatsAppGeneralUrl } from '@/lib/catalog';

export function StickyMobileBar() {
  const { open: openCart } = useCart();

  return (
    <div
      className="md:hidden fixed left-0 right-0 bottom-0 z-[55] border-t border-line bg-white/95 backdrop-blur-xl shadow-[0_-6px_24px_rgba(0,0,0,0.08)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="grid grid-cols-2 h-14">
        <a
          href={buildWhatsAppGeneralUrl(
            "Hi DSLANG! I'm interested in the wholesale collection. Please share the catalogue and pricing."
          )}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.14em] font-semibold text-bone"
        >
          <MessageCircle size={17} strokeWidth={2} /> WhatsApp
        </a>
        <button
          onClick={openCart}
          className="flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-[0.14em] font-semibold"
        >
          <ShoppingBag size={17} strokeWidth={2} /> Wholesale Order
        </button>
      </div>
    </div>
  );
}
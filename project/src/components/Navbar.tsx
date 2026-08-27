import { useEffect, useState, useRef } from 'react';
import { Menu, X, Search, MessageCircle, ShoppingBag } from 'lucide-react';
import { linkHref } from '@/lib/router';
import { useCart } from '@/lib/cart';
import { INSTAGRAM_URL, buildWhatsAppGeneralUrl } from '@/lib/catalog';
import { useSiteSettings } from '@/lib/settings';
import { Instagram } from '@/components/icons/Instagram';
import { SearchModal } from '@/components/SearchModal';

const NAV_LINKS = [
  { label: 'Collection', to: '/collection' },
  { label: 'New Drops', to: '/new-drops' },
  { label: 'Wholesale', to: '/wholesale' },
  { label: 'How It Works', to: '/how-it-works' },
  { label: 'About', to: '/stock-dslang' },
];

export function Navbar({ currentPath }: { currentPath: string }) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { count, open: openCart, isOpen: isCartOpen } = useCart();
  const { settings } = useSiteSettings();
  const cartOpenRef = useRef(isCartOpen);
  cartOpenRef.current = isCartOpen;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (menuOpen) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
    }
    return () => {
      if (!cartOpenRef.current) {
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
      }
    };
  }, [menuOpen]);

  const isActive = (to: string) => {
    if (to === '/') return currentPath === '/';
    if (to === '/stock-dslang') {
      return currentPath.startsWith('/stock-dslang') || currentPath.startsWith('/about');
    }
    return currentPath.startsWith(to);
  };

  const isProductPage = currentPath.startsWith('/product');
  const solid = scrolled || isProductPage || currentPath !== '/';

  const wholesaleChat = buildWhatsAppGeneralUrl(
    "Hi DSLANG! I'm interested in the wholesale collection. Please share the catalogue and pricing."
  );

  return (
    <>
      <header
        className={`fixed top-8 inset-x-0 z-50 transition-all duration-200 ${
          solid
            ? 'bg-white/95 backdrop-blur-xl border-b border-line shadow-[0_1px_20px_rgba(0,0,0,0.04)]'
            : 'bg-white/80 backdrop-blur-md border-b border-transparent'
        }`}
      >
        <nav className="mx-auto px-4 md:px-12 lg:px-20 xl:px-28">
          <div className="flex h-11 md:h-14 items-center gap-3 md:gap-6">
            {/* Left — hamburger (mobile) */}
            <button
              onClick={() => setMenuOpen(true)}
              className="text-bone p-1 -ml-1 lg:hidden"
              aria-label="Open menu"
            >
              <Menu size={22} strokeWidth={1.6} />
            </button>

            {/* Logo */}
            <a
              href={linkHref('/')}
              className="font-brand text-2xl md:text-3xl tracking-[0.18em] leading-none select-none text-bone"
              aria-label="DSLANG home"
            >
              DSLANG<span className="text-crimson">.</span>
            </a>

            {/* Desktop links */}
            <div className="hidden lg:flex items-center gap-6 xl:gap-8 ml-4">
              {NAV_LINKS.map((l) => (
                <a
                  key={l.to}
                  href={linkHref(l.to)}
                  className={`font-label text-[11px] xl:text-xs uppercase tracking-[0.16em] font-semibold transition-colors ${
                    isActive(l.to) ? 'text-crimson' : 'text-bone-dim hover:text-bone'
                  }`}
                >
                  {l.label}
                </a>
              ))}
            </div>

            {/* Right */}
            <div className="ml-auto flex items-center gap-2 md:gap-3.5">
              <button
                onClick={() => setSearchOpen(true)}
                className="text-bone-dim hover:text-crimson transition-colors p-1"
                aria-label="Search catalogue"
              >
                <Search size={22} strokeWidth={1.6} />
              </button>
              <a
                href={wholesaleChat}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:flex items-center gap-2 text-bone-dim hover:text-crimson transition-colors p-1"
                aria-label="WhatsApp DSLANG wholesale"
              >
                <MessageCircle size={22} strokeWidth={1.6} />
              </a>
              <button
                onClick={openCart}
                className="relative text-bone-dim hover:text-crimson transition-colors p-1"
                aria-label="Wholesale order"
              >
                <ShoppingBag size={22} strokeWidth={1.6} />
                {count > 0 && (
                  <span className="absolute -top-1 -right-1 bg-crimson text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center leading-none">
                    {count}
                  </span>
                )}
              </button>
              <button
                onClick={openCart}
                className="hidden md:inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-[0.16em] font-semibold px-5 py-2.5 hover:bg-crimson transition-colors duration-150"
              >
                Wholesale Order
              </button>
            </div>
          </div>
        </nav>
      </header>

      {/* Search overlay */}
      <SearchModal isOpen={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* Menu drawer — always rendered, transform-based */}
      <div
        className="fixed inset-0 z-[60]"
        style={{ pointerEvents: menuOpen ? 'auto' : 'none' }}
        aria-hidden={!menuOpen}
      >
        <div
          className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-200"
          style={{ opacity: menuOpen ? 1 : 0 }}
          onClick={() => setMenuOpen(false)}
        />
        <div
          className="absolute left-0 top-8 h-[calc(100vh-2rem)] w-[80vw] max-w-[380px] bg-white border-r border-line flex flex-col will-change-transform"
          style={{
            transform: menuOpen ? 'translateX(0)' : 'translateX(-100%)',
            transition: 'transform 250ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div className="flex items-center justify-between h-11 px-5 border-b border-line shrink-0">
            <span className="font-brand text-2xl tracking-[0.03em] text-bone">
              DSLANG<span className="text-crimson">.</span>
            </span>
            <button onClick={() => setMenuOpen(false)} className="text-bone p-1" aria-label="Close menu">
              <X size={22} strokeWidth={1.6} />
            </button>
          </div>
          <div className="flex flex-col flex-1 min-h-0">
            <p className="px-5 pt-4 text-[10px] uppercase tracking-[0.2em] text-grey font-semibold">
              Wholesale Only
            </p>
            <ul className="flex flex-col py-2">
              {NAV_LINKS.map((l) => (
                <li key={l.to}>
                  <a
                    href={linkHref(l.to)}
                    onClick={() => setMenuOpen(false)}
                    className={`block px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors ${
                      isActive(l.to) ? 'text-crimson' : 'text-bone-dim hover:text-bone'
                    }`}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
              <li>
                <a
                  href={linkHref('/contact')}
                  onClick={() => setMenuOpen(false)}
                  className={`block px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors ${
                    isActive('/contact') ? 'text-crimson' : 'text-bone-dim hover:text-bone'
                  }`}
                >
                  Contact
                </a>
              </li>
            </ul>
            <div className="flex-1" />
            <div className="px-5 pb-6 space-y-2">
              <a
                href={wholesaleChat}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMenuOpen(false)}
                className="w-full inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-[0.16em] font-semibold py-3.5 px-5"
              >
                <MessageCircle size={16} strokeWidth={2} /> Order On WhatsApp
              </a>
              <button
                onClick={() => { setMenuOpen(false); openCart(); }}
                className="w-full inline-flex items-center justify-center gap-2 border border-bone-dim text-bone text-[11px] uppercase tracking-[0.16em] font-semibold py-3.5 px-5"
              >
                <ShoppingBag size={16} strokeWidth={1.8} /> Wholesale Order
              </button>
            </div>
          </div>
          <div className="p-5 border-t border-line flex items-center gap-6 shrink-0">
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-bone-dim hover:text-crimson transition-colors"
              aria-label="Instagram"
            >
              <Instagram size={20} strokeWidth={1.6} />
            </a>
            <span className="ml-auto text-[10px] uppercase tracking-wide-2 text-grey">
              MOQ {settings.default_moq} PCS · {settings.delivery_note}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
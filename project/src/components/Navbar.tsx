import { useEffect, useState, useRef } from 'react';
import { Menu, X, ShoppingBag, User } from 'lucide-react';
import { linkHref } from '@/lib/router';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { INSTAGRAM_URL } from '@/lib/catalog';
import { Instagram } from '@/components/icons/Instagram';

const NAV_LINKS = [
  { label: 'Home', to: '/' },
  { label: 'Shop', to: '/shop' },
  { label: 'Contact', to: '/contact' },
];

export function Navbar({ currentPath, onLoginClick }: { currentPath: string; onLoginClick: () => void }) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { user } = useAuth();
  const { count, open: openCart, isOpen: isCartOpen } = useCart();
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

  const isActive = (to: string) =>
    to === '/' ? currentPath === '/' : currentPath.startsWith(to);

  const isProductPage = currentPath.startsWith('/product');
  const solid = scrolled || isProductPage || currentPath !== '/';

  return (
    <>
      <header
        className={`fixed top-8 inset-x-0 z-50 transition-all duration-200 ${
          solid
            ? 'bg-white/95 backdrop-blur-xl border-b border-line shadow-[0_1px_20px_rgba(0,0,0,0.04)]'
            : 'bg-white/80 backdrop-blur-md border-b border-transparent'
        }`}
      >
        <nav className="mx-auto px-6 md:px-12 lg:px-20 xl:px-28">
          <div className="grid h-11 md:h-14 items-center" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
            {/* Left — Hamburger */}
            <button
              onClick={() => setMenuOpen(true)}
              className="text-bone p-1 -ml-1"
              aria-label="Open menu"
            >
              <Menu size={22} strokeWidth={1.6} />
            </button>

            {/* Center — Logo */}
            <a
              href={linkHref('/')}
              className="justify-self-center font-display text-2xl md:text-3xl tracking-wide-2 leading-none select-none transition-colors text-bone"
              aria-label="DSLANG home"
            >
              DSLANG<span className="text-crimson">.</span>
            </a>

            {/* Right — Cart */}
            <button
              onClick={openCart}
              className="relative text-bone-dim hover:text-crimson transition-colors duration-150"
              aria-label="Open cart"
            >
              <ShoppingBag size={22} strokeWidth={1.6} />
              {count > 0 && (
                <span className="absolute -top-2 -right-2 bg-crimson text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center leading-none">
                  {count}
                </span>
              )}
            </button>
          </div>
        </nav>
      </header>

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
            <span className="font-display text-2xl tracking-wide-2 text-bone">
              DSLANG<span className="text-crimson">.</span>
            </span>
            <button onClick={() => setMenuOpen(false)} className="text-bone p-1" aria-label="Close menu">
              <X size={22} strokeWidth={1.6} />
            </button>
          </div>
          <ul className="flex flex-col py-4 overflow-y-auto">
            {NAV_LINKS.map((l) => (
              <li key={l.to}>
                <a
                  href={linkHref(l.to)}
                  onClick={() => setMenuOpen(false)}
                  className={`block px-5 py-4 font-condensed text-3xl tracking-wide-2 uppercase transition-colors ${
                    isActive(l.to) ? 'text-crimson' : 'text-bone-dim hover:text-bone'
                  }`}
                >
                  {l.label}
                </a>
              </li>
            ))}
            <li>
              <button
                onClick={() => { setMenuOpen(false); onLoginClick(); }}
                className="flex items-center gap-2 px-5 py-4 font-condensed text-2xl tracking-wide-2 uppercase text-bone-soft hover:text-bone w-full text-left"
              >
                <User size={18} strokeWidth={1.6} /> {user ? 'Account' : 'Sign in'}
              </button>
            </li>
          </ul>
          <div className="mt-auto p-5 border-t border-line flex items-center gap-6 shrink-0">
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
              dslang.in
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

import { useEffect, useState, useRef } from 'react';
import { Menu, X, ShoppingBag, Search } from 'lucide-react';
import { linkHref, useRouter } from '@/lib/router';
import { useD2cCart } from '@/lib/d2cCart';
import { useCartDrawer } from '@/lib/cartDrawer';
import { INSTAGRAM_URL } from '@/lib/catalog';
import { useAuth } from '@/lib/auth';
import { Instagram } from '@/components/icons/Instagram';
import { SearchDialog } from '@/components/SearchDialog';

const NAV_LINKS = [
  { label: 'Collection', to: '/collection' },
  { label: 'New Drops', to: '/new-drops' },
  { label: 'Track Order', to: '/track-order' },
  { label: 'How It Works', to: '/how-it-works' },
  { label: 'About', to: '/stock-dslang' },
];

export function Navbar({
  currentPath,
  onOpenLogin,
}: {
  currentPath: string;
  onOpenLogin: (mode: 'signin' | 'signup') => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const { count: retailCount } = useD2cCart();
  const { openCart } = useCartDrawer();
  const { user, isAdmin } = useAuth();
  const { navigate } = useRouter();
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;

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
      if (!menuOpenRef.current) {
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
      }
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const isActive = (to: string) => {
    if (to === '/') return currentPath === '/' || currentPath === '';
    if (to === '/stock-dslang') {
      return currentPath.startsWith('/stock-dslang') || currentPath.startsWith('/about');
    }
    return currentPath.startsWith(to);
  };

  const solid = scrolled || currentPath !== '/';

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
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-brand text-2xl md:text-3xl tracking-[0.18em] leading-none select-none text-bone lg:static lg:translate-x-0 lg:translate-y-0"
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
            <div className="ml-auto flex items-center gap-2 md:gap-5">
              {!user && (
                <button
                  onClick={() => onOpenLogin('signin')}
                  className="hidden md:inline-flex text-[11px] uppercase tracking-[0.16em] font-semibold text-bone-dim hover:text-crimson transition-colors"
                >
                  Sign In
                </button>
              )}
              {user && (
                <button
                  onClick={() => navigate(isAdmin ? '/admin' : '/account')}
                  className="hidden md:inline-flex text-[11px] uppercase tracking-[0.16em] font-semibold text-bone-dim hover:text-crimson transition-colors"
                >
                  {isAdmin ? 'Admin' : 'Account'}
                </button>
              )}
              <button
                onClick={() => { setSearchOpen(true); setMenuOpen(false); }}
                className="relative text-bone-dim hover:text-crimson transition-colors p-1"
                aria-label="Search products"
              >
                <Search size={22} strokeWidth={1.6} />
              </button>
              <button
                onClick={() => { openCart(); setMenuOpen(false); }}
                className="relative text-bone-dim hover:text-crimson transition-colors p-1"
                aria-label="Shopping bag"
              >
                <ShoppingBag size={22} strokeWidth={1.6} />
                {retailCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-crimson text-white text-[9px] font-bold min-w-4 h-4 px-1 rounded-full flex items-center justify-center leading-none tabular-nums">
                    {retailCount}
                  </span>
                )}
              </button>
            </div>
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
            <span className="font-brand text-2xl tracking-[0.03em] text-bone">
              DSLANG<span className="text-crimson">.</span>
            </span>
            <button onClick={() => setMenuOpen(false)} className="text-bone p-1" aria-label="Close menu">
              <X size={22} strokeWidth={1.6} />
            </button>
          </div>
          <div className="flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden" style={{ WebkitOverflowScrolling: 'touch' }}>
            <p className="px-5 pt-4 text-[10px] uppercase tracking-[0.2em] text-grey font-semibold">
              DSLANG · Slang Of Design
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
              <li className="mt-2">
                <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-[0.2em] text-grey font-semibold">
                  Account
                </div>
                {user ? (
                  <button
                    onClick={() => { setMenuOpen(false); navigate(isAdmin ? '/admin' : '/account'); }}
                    className="block w-full text-left px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors text-bone-dim hover:text-bone"
                  >
                    {isAdmin ? 'Admin Panel' : 'Account'}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => { setMenuOpen(false); onOpenLogin('signin'); }}
                      className="block w-full text-left px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors text-bone-dim hover:text-bone"
                    >
                      Sign In
                    </button>
                    <button
                      onClick={() => { setMenuOpen(false); onOpenLogin('signup'); }}
                      className="block w-full text-left px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors text-bone-dim hover:text-bone"
                    >
                      Create Account
                    </button>
                  </>
                )}
              </li>
            </ul>
            <div className="flex-1" />
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
              Pan-India delivery · Easy exchanges
            </span>
          </div>
        </div>
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
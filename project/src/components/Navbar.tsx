import { useEffect, useState } from 'react';
import { Menu, X, ShoppingBag, Search } from 'lucide-react';
import { linkHref, useRouter } from '@/lib/router';
import { useD2cCart } from '@/lib/d2cCart';
import { useCartDrawer } from '@/lib/cartDrawer';
import { INSTAGRAM_URL } from '@/lib/catalog';
import { useAuth } from '@/lib/auth';
import { Instagram } from '@/components/icons/Instagram';
import { SearchDialog } from '@/components/SearchDialog';
import { lockScroll, unlockScroll } from '@/lib/scrollLock';

// The storefront has ONE browsing destination. "New Drops" is deliberately not a
// second one: it is a filtered copy of the same catalogue, so listing it beside
// Collection offered two doors to one room. The catalogue is small enough that
// Collection is the whole shop, and /new-drops redirects here.
const NAV_LINKS = [
  { label: 'Collection', to: '/collections' },
  { label: 'Track Order', to: '/track-order' },
  { label: 'About', to: '/stock-dslang' },
];

export function Navbar({
  currentPath,
  onOpenLogin,
  minimal,
}: {
  currentPath: string;
  onOpenLogin: (mode: 'signin' | 'signup') => void;
  minimal?: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const { count: retailCount } = useD2cCart();
  const { openCart } = useCartDrawer();
  const { user, isAdmin, isAdminLoading } = useAuth();
  const { navigate } = useRouter();

  // The single gate for every ADMIN affordance in the header and the drawer.
  //
  // `isAdmin` alone is not safe to render from: the admin_users check is async,
  // so between a sign-out (or a user switch) and the check resolving, the flag
  // can still describe the PREVIOUS identity. Requiring a settled user and a
  // completed check means ADMIN PANEL is only ever painted for an identity that
  // has actually been confirmed against admin_users â€” never for a signed-out
  // visitor, and never optimistically while the answer is in flight. This is
  // pure UI gating; the real authorization is still enforced server-side.
  const showAdminPanel = !!user && !isAdminLoading && isAdmin;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (menuOpen) {
      lockScroll();
      return () => unlockScroll();
    }
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // A route change â€” menu link tap, browser back/forward, or programmatic
  // navigation â€” must always close the mobile menu. The scroll-lock effect
  // above releases the body scroll via its cleanup when menuOpen turns false.
  useEffect(() => {
    setMenuOpen(false);
  }, [currentPath]);

  const isActive = (to: string) => {
    if (to === '/') return currentPath === '/' || currentPath === '';
    if (to === '/stock-dslang') {
      return currentPath.startsWith('/stock-dslang') || currentPath.startsWith('/about');
    }
    return currentPath.startsWith(to);
  };

  const solid = scrolled || currentPath !== '/';

  // Minimal header (payment return flow): brand only â€” no nav, no hamburger,
  // no search/cart icons. The shopper just landed back from the gateway and
  // must not be pulled toward checkout/navigation while payment is verified.
  if (minimal) {
    return (
      <header className="fixed top-8 inset-x-0 z-50 bg-white/85 backdrop-blur-xl border-b border-line/60 shadow-[0_2px_20px_rgba(0,0,0,0.04)]">
        <nav className="shell">
          <div className="flex h-12 md:h-14 items-center justify-center">
            <a
              href={linkHref('/')}
              className="font-brand text-2xl md:text-3xl tracking-[0.18em] leading-none select-none text-bone"
              aria-label="DSLANG home"
            >
              DSLANG
            </a>
          </div>
        </nav>
      </header>
    );
  }

  return (
    <>
      <header
        className={`fixed top-8 inset-x-0 z-50 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          solid
            ? 'bg-white/85 backdrop-blur-xl border-b border-line/60 shadow-[0_2px_20px_rgba(0,0,0,0.04)]'
            : 'bg-white/70 backdrop-blur-md border-b border-transparent'
        }`}
      >
        <nav className="shell">
          <div className="flex h-12 md:h-14 items-center gap-3 md:gap-6">
            {/* Left â€” hamburger (mobile) */}
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
              DSLANG
            </a>

            {/* Desktop links */}
            <div className="hidden lg:flex items-center gap-6 xl:gap-8 ml-4">
              {NAV_LINKS.map((l) => (
                <a
                  key={l.to}
                  href={linkHref(l.to)}
                  aria-current={isActive(l.to) ? 'page' : undefined}
                  className={`nav-underline font-label text-[11px] xl:text-xs uppercase tracking-[0.16em] font-semibold transition-colors ${
                    isActive(l.to) ? 'text-bone' : 'text-bone-dim hover:text-bone'
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
                  className="hidden md:inline-flex text-[11px] uppercase tracking-[0.16em] font-semibold text-bone-dim hover:text-bone transition-colors"
                >
                  Sign In
                </button>
              )}
              {user && (
                <button
                  onClick={() => navigate(showAdminPanel ? '/admin' : '/account')}
                  className="hidden md:inline-flex text-[11px] uppercase tracking-[0.16em] font-semibold text-bone-dim hover:text-bone transition-colors"
                >
                  {showAdminPanel ? 'Admin' : 'Account'}
                </button>
              )}
              <button
                onClick={() => { setSearchOpen(true); setMenuOpen(false); }}
                className="relative text-bone-dim hover:text-bone transition-colors p-1"
                aria-label="Search products"
              >
                <Search size={22} strokeWidth={1.6} />
              </button>
              <button
                onClick={() => { openCart(); setMenuOpen(false); }}
                className="relative text-bone-dim hover:text-bone transition-colors p-1"
                aria-label="Shopping bag"
              >
                <ShoppingBag size={22} strokeWidth={1.6} />
                {retailCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-bone text-white text-[9px] font-bold min-w-4 h-4 px-1 rounded-full flex items-center justify-center leading-none tabular-nums">
                    {retailCount}
                  </span>
                )}
              </button>
            </div>
          </div>
        </nav>
      </header>

      {/* Menu drawer â€” always rendered, transform-based */}
      <div
        className="fixed inset-0 z-[60]"
        style={{ pointerEvents: menuOpen ? 'auto' : 'none' }}
        aria-hidden={!menuOpen}
      >
        <div
          className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-[250ms]"
          style={{ opacity: menuOpen ? 1 : 0 }}
          onClick={() => setMenuOpen(false)}
        />
        <div
          className="absolute left-0 top-8 h-[calc(100dvh-2rem)] w-[95vw] bg-paper-2 border-r border-line flex flex-col will-change-transform"
          style={{
            transform: menuOpen ? 'translateX(0)' : 'translateX(-100%)',
            transition: 'transform 250ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <div className="flex items-center justify-between h-11 px-5 border-b border-line shrink-0">
            <span className="font-brand text-2xl tracking-[0.03em] text-bone">
              DSLANG
            </span>
            <button onClick={() => setMenuOpen(false)} className="text-bone p-1" aria-label="Close menu">
              <X size={22} strokeWidth={1.6} />
            </button>
          </div>
          <div className="flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
            <p className="px-5 pt-4 text-[10px] uppercase tracking-[0.2em] text-grey font-semibold">
              DSLANG Â· Slang Of Design
            </p>
            <ul className="flex flex-col py-2">
              {NAV_LINKS.map((l) => (
                <li key={l.to}>
                  <a
                    href={linkHref(l.to)}
                    onClick={() => setMenuOpen(false)}
                    className={`block px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors ${
                      isActive(l.to) ? 'text-bone' : 'text-bone-dim hover:text-bone'
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
                    isActive('/contact') ? 'text-bone' : 'text-bone-dim hover:text-bone'
                  }`}
                >
                  Contact
                </a>
              </li>
              {/* Signed-in: an "Account" group holding MY ACCOUNT â€” the single
                  customer entry point â€” plus ADMIN PANEL only for a confirmed
                  admin. Orders and log out live INSIDE My Account, so "My
                  Orders" is deliberately not a top-level item here. Signed-out:
                  no group heading and no admin entry at all, so a stale isAdmin
                  can never surface. */}
              {user ? (
                <li className="mt-2">
                  <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-[0.2em] text-grey font-semibold">
                    Account
                  </div>
                  <button
                    onClick={() => { setMenuOpen(false); navigate('/account'); }}
                    className="block w-full text-left px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors text-bone-dim hover:text-bone"
                  >
                    My Account
                  </button>
                  {showAdminPanel && (
                    <button
                      onClick={() => { setMenuOpen(false); navigate('/admin'); }}
                      className="block w-full text-left px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors text-bone-dim hover:text-bone"
                    >
                      Admin Panel
                    </button>
                  )}
                </li>
              ) : (
                <li className="mt-2">
                  <button
                    onClick={() => { setMenuOpen(false); onOpenLogin('signin'); }}
                    className="block w-full text-left px-5 py-3 font-label text-[22px] font-bold tracking-[0.04em] uppercase transition-colors text-bone-dim hover:text-bone"
                  >
                    LOGIN
                  </button>
                </li>
              )}
            </ul>
            <div className="flex-1" />
          </div>
          <div className="p-5 border-t border-line flex items-center gap-6 shrink-0">
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-bone-dim hover:text-bone transition-colors"
              aria-label="Instagram"
            >
              <Instagram size={20} strokeWidth={1.6} />
            </a>
          </div>
        </div>
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
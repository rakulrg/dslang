import { useEffect, useState } from 'react';
import { Menu, X, MessageCircle, Lock, LogOut } from 'lucide-react';
import { linkHref } from '@/lib/router';
import { INSTAGRAM_URL, WHATSAPP_NUMBER } from '@/lib/catalog';
import { Instagram } from '@/components/icons/Instagram';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

const NAV_LINKS = [
  { label: 'Home', to: '/' },
  { label: 'Shop', to: '/shop' },
  { label: 'Contact', to: '/contact' },
];

export function Navbar({ currentPath }: { currentPath: string }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const isActive = (to: string) =>
    to === '/' ? currentPath === '/' : currentPath.startsWith(to);

  const isProductPage = currentPath.startsWith('/product');
  const solid = scrolled || isProductPage || currentPath !== '/';

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.hash = '#/';
  };

  return (
    <>
      <header
        className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ${
          solid
            ? 'bg-white/95 backdrop-blur-xl border-b border-line shadow-[0_1px_20px_rgba(0,0,0,0.04)]'
            : 'bg-white/80 backdrop-blur-md border-b border-transparent'
        }`}
      >
        <nav className="mx-auto max-w-[1400px] px-5 md:px-8">
          <div className="flex h-16 md:h-20 items-center justify-between">
            {/* Logo */}
            <a
              href={linkHref('/')}
              className="font-display text-2xl md:text-3xl tracking-wide-2 leading-none select-none transition-colors text-bone"
              aria-label="DSLANG home"
            >
              DSLANG<span className="text-crimson">.</span>
            </a>

            {/* Desktop nav */}
            <ul className="hidden md:flex items-center gap-10">
              {NAV_LINKS.map((l) => (
                <li key={l.to}>
                  <a
                    href={linkHref(l.to)}
                    className={`text-[11px] uppercase tracking-wide-2 font-medium transition-colors duration-300 hover:text-crimson ${
                      isActive(l.to) ? 'text-crimson' : 'text-bone-dim'
                    }`}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>

            {/* Right icons */}
            <div className="flex items-center gap-4 md:gap-5">
              <a
                href={INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bone-dim hover:text-crimson transition-colors duration-300 hidden sm:block"
                aria-label="Instagram"
              >
                <Instagram size={18} strokeWidth={1.6} />
              </a>
              <a
                href={`https://wa.me/${WHATSAPP_NUMBER}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bone-dim hover:text-crimson transition-colors duration-300 hidden sm:block"
                aria-label="WhatsApp"
              >
                <MessageCircle size={18} strokeWidth={1.6} />
              </a>
              {user ? (
                <button
                  onClick={handleLogout}
                  className="text-bone-dim hover:text-crimson transition-colors duration-300 hidden sm:block"
                  aria-label="Sign out"
                >
                  <LogOut size={16} strokeWidth={1.6} />
                </button>
              ) : (
                <a
                  href={linkHref('/admin/login')}
                  className="text-bone-dim hover:text-crimson transition-colors duration-300 hidden sm:block"
                  aria-label="Admin"
                >
                  <Lock size={16} strokeWidth={1.6} />
                </a>
              )}
              <button
                onClick={() => setOpen(true)}
                className="md:hidden text-bone p-1 -mr-1"
                aria-label="Open menu"
              >
                <Menu size={22} strokeWidth={1.6} />
              </button>
            </div>
          </div>
        </nav>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-fade-in"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-0 h-full w-[78%] max-w-[340px] bg-white border-l border-line animate-slide-down flex flex-col">
            <div className="flex items-center justify-between h-16 px-5 border-b border-line">
              <span className="font-display text-2xl tracking-wide-2 text-bone">
                DSLANG<span className="text-crimson">.</span>
              </span>
              <button onClick={() => setOpen(false)} className="text-bone p-1" aria-label="Close menu">
                <X size={22} strokeWidth={1.6} />
              </button>
            </div>
            <ul className="flex flex-col py-4">
              {NAV_LINKS.map((l) => (
                <li key={l.to}>
                  <a
                    href={linkHref(l.to)}
                    onClick={() => setOpen(false)}
                    className={`block px-5 py-4 font-condensed text-3xl tracking-wide-2 uppercase transition-colors ${
                      isActive(l.to) ? 'text-crimson' : 'text-bone-dim hover:text-bone'
                    }`}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
              <li>
                <a
                  href={linkHref(user ? '/admin' : '/admin/login')}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 px-5 py-4 font-condensed text-2xl tracking-wide-2 uppercase text-bone-soft hover:text-bone"
                >
                  <Lock size={18} strokeWidth={1.6} /> Admin
                </a>
              </li>
            </ul>
            <div className="mt-auto p-5 border-t border-line flex items-center gap-6">
              <a
                href={INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bone-dim hover:text-crimson transition-colors"
                aria-label="Instagram"
              >
                <Instagram size={20} strokeWidth={1.6} />
              </a>
              <a
                href={`https://wa.me/${WHATSAPP_NUMBER}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bone-dim hover:text-crimson transition-colors"
                aria-label="WhatsApp"
              >
                <MessageCircle size={20} strokeWidth={1.6} />
              </a>
              <span className="ml-auto text-[10px] uppercase tracking-wide-2 text-grey">
                dslang.in
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

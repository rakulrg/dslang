import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useRouter } from '@/lib/router';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { CartDrawer } from '@/components/CartDrawer';
import { LoginModal } from '@/components/LoginModal';
import { HomePage } from '@/pages/HomePage';
import { CollectionPage } from '@/pages/CollectionPage';
import { NewDropsPage } from '@/pages/NewDropsPage';
import { RetailProductPage } from '@/pages/RetailProductPage';
import { useAuth } from '@/lib/auth';
import { useSiteSettings } from '@/lib/settings';
import { useCartDrawer } from '@/lib/cartDrawer';
import { notFound } from '@/lib/notFound';
import { LoadingDots } from '@/components/LoadingDots';

// Lazy-load every non-core page so the initial bundle only ships the shop
// skeleton (home, collection, new drops, product + admin entry). Each
// secondary route downloads only the chunk it needs on first visit, and the
// shop path never loads checkout/account/admin code.
const AdminDashboard = lazy(() =>
  import('@/pages/admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard }))
);
const CheckoutPage = lazy(() =>
  import('@/pages/CheckoutPage').then((m) => ({ default: m.CheckoutPage }))
);
const TrackOrderPage = lazy(() =>
  import('@/pages/TrackOrderPage').then((m) => ({ default: m.TrackOrderPage }))
);
const SubscriberDashboard = lazy(() =>
  import('@/pages/SubscriberDashboard').then((m) => ({ default: m.SubscriberDashboard }))
);
const AboutPage = lazy(() =>
  import('@/pages/AboutPage').then((m) => ({ default: m.AboutPage }))
);
const ContactPage = lazy(() =>
  import('@/pages/ContactPage').then((m) => ({ default: m.ContactPage }))
);
const PoliciesPage = lazy(() =>
  import('@/pages/PoliciesPage').then((m) => ({ default: m.PoliciesPage }))
);
const TermsPage = lazy(() =>
  import('@/pages/TermsConditionsPage').then((m) => ({ default: m.TermsPage }))
);
const PrivacyPolicyPage = lazy(() =>
  import('@/pages/PrivacyPolicyPage').then((m) => ({ default: m.PrivacyPolicyPage }))
);
const RefundCancellationPage = lazy(() =>
  import('@/pages/RefundCancellationPage').then((m) => ({ default: m.RefundCancellationPage }))
);
const ReturnPolicyPage = lazy(() =>
  import('@/pages/ReturnPolicyPage').then((m) => ({ default: m.ReturnPolicyPage }))
);
const ShippingPolicyPage = lazy(() =>
  import('@/pages/ShippingPolicyPage').then((m) => ({ default: m.ShippingPolicyPage }))
);

const DEFAULT_TITLE = 'DSLANG — Premium Streetwear | Slang of Design';

function getPageTitle(path: string): string {
  if (path === '/' || path === '') return DEFAULT_TITLE;
  if (path.startsWith('/collection') || path.startsWith('/shop')) return 'Shop The Collection — DSLANG';
  if (path.startsWith('/new-drops')) return 'New Drops — DSLANG';
  if (path.startsWith('/product') || path.startsWith('/products') || path.startsWith('/p/')) return 'Product — DSLANG';
  if (path.startsWith('/cart')) return 'Your Bag — DSLANG';
  if (path.startsWith('/checkout')) return 'Checkout — DSLANG';
  if (path.startsWith('/stock-dslang') || path.startsWith('/about')) return 'About DSLANG — DSLANG';
  if (path.startsWith('/contact')) return 'Contact — DSLANG';
  if (path.startsWith('/policies')) return 'Policies — DSLANG';
  if (path.startsWith('/terms-and-conditions')) return 'Terms & Conditions — DSLANG';
  if (path.startsWith('/privacy-policy')) return 'Privacy Policy — DSLANG';
  if (path.startsWith('/refund-and-cancellation')) return 'Refund & Cancellation — DSLANG';
  if (path.startsWith('/return-policy')) return 'Return Policy — DSLANG';
  if (path.startsWith('/shipping-policy')) return 'Shipping Policy — DSLANG';
  if (path.startsWith('/track-order')) return 'Track Order — DSLANG';
  if (path.startsWith('/account')) return 'Account — DSLANG';
  if (path.startsWith('/admin')) return 'Admin — DSLANG';
  return DEFAULT_TITLE;
}

/** Full-screen overlay for the initial boot loading state. Fades out on resolve. */
function FullscreenLoader({ visible }: { visible: boolean }) {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (visible) {
      setGone(false);
      return;
    }
    if (!gone) {
      const t = window.setTimeout(() => setGone(true), 300);
      return () => window.clearTimeout(t);
    }
  }, [visible, gone]);

  if (gone) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-paper transition-opacity duration-300 ease-out"
      style={visible ? { opacity: 1 } : { opacity: 0 }}
      aria-hidden="true"
    >
      <LoadingDots />
    </div>
  );
}

function App() {
  const { route, navigate } = useRouter();
  const { path, segments } = route;
  const { user, loading, isAdmin } = useAuth();
  const { openCart } = useCartDrawer();
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginMode, setLoginMode] = useState<'signin' | 'signup'>('signin');

  useEffect(() => {
    document.title = getPageTitle(path);
  }, [path]);

  // Legacy /cart links open the bag drawer instead of a separate page.
  useEffect(() => {
    if (segments[0] === 'cart') {
      openCart();
      navigate('/');
    }
  }, [segments, openCart, navigate]);

  // Handle redirects for protected routes - MUST BE IN useEffect, NOT in renderPage
  useEffect(() => {
    if (loading) return; // Wait for auth state to load

    if (segments[0] === 'account') {
      if (!user) {
        setLoginOpen(true);
        navigate('/');
      } else if (isAdmin) {
        // Admin accessing /account - send to /admin
        navigate('/admin');
      }
    } else if (segments[0] === 'admin') {
      if (!user) {
        setLoginOpen(true);
        navigate('/');
      } else if (!isAdmin) {
        // Non-admin accessing /admin - send to /account
        navigate('/account');
      }
    }
  }, [segments, user, loading, isAdmin, navigate]);

  const handleLoginClose = useCallback(() => {
    setLoginOpen(false);
  }, []);


  const renderPage = () => {
    if (segments.length === 0) return <HomePage />;
    if (segments[0] === 'collection' || segments[0] === 'shop') return <CollectionPage />;
    if (segments[0] === 'new-drops') return <NewDropsPage />;
    if (segments[0] === 'product' && segments[1]) return <RetailProductPage slug={segments[1]} />;
    if (segments[0] === 'products' && segments[1]) return <RetailProductPage slug={segments[1]} />;
    if (segments[0] === 'p' && segments[1]) return <RetailProductPage slug={segments[1]} />;
    if (segments[0] === 'cart') return <HomePage />;
    if (segments[0] === 'checkout') return <CheckoutPage />;
    if (segments[0] === 'stock-dslang' || segments[0] === 'about') return <AboutPage />;
    if (segments[0] === 'contact') return <ContactPage />;
    if (segments[0] === 'policies') return <PoliciesPage />;
    if (segments[0] === 'terms-and-conditions') return <TermsPage />;
    if (segments[0] === 'privacy-policy') return <PrivacyPolicyPage />;
    if (segments[0] === 'refund-and-cancellation') return <RefundCancellationPage />;
    if (segments[0] === 'return-policy') return <ReturnPolicyPage />;
    if (segments[0] === 'shipping-policy') return <ShippingPolicyPage />;
    if (segments[0] === 'track-order') return <TrackOrderPage refFromRoute={segments[1] ?? ''} />;
    if (segments[0] === 'account') {
      if (loading) return null;
      if (!user) return null; // Redirect handled by useEffect above
      if (isAdmin) return null; // Redirect to /admin handled by useEffect
      return <SubscriberDashboard />;
    }
    if (segments[0] === 'admin') {
      if (loading) return null;
      if (!user) return null; // Redirect handled by useEffect above
      if (!isAdmin) return null; // Redirect to /account handled by useEffect
      return (
          <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center"><LoadingDots /></div>}>
          <AdminDashboard />
        </Suspense>
      );
    }
    return notFound();
  };

  const isAdminPath = segments[0] === 'admin';

  // The announcement bar renders ONLY the admin-set text from Settings. The
  // value is hydrated synchronously from the local settings cache (see
  // settings.tsx), so the bar appears instantly on page load — it never waits
  // on the settings fetch, auth, products, or any other async request. If
  // nothing is cached yet it simply stays hidden until the first fetch lands.
  const { settings: announcement } = useSiteSettings();

  // The boot loader exists to avoid flashing unauthenticated state (or an empty
  // page) while auth resolves on PROTECTED routes. Public pages should never
  // show it — otherwise every hard refresh flashes a full-screen loader.
  const protectingRoute = segments[0] === 'account' || segments[0] === 'admin';

  // Skip the route fade-in on the very first paint so content is fully visible
  // immediately after a hard refresh; keep it for internal navigations.
  const [firstPaint, setFirstPaint] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setFirstPaint(false), 0);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      {announcement.announcement_active && announcement.announcement_text.trim() && (
        <div className="fixed inset-x-0 top-0 z-[100] border-b border-white/10 bg-[#111111] overflow-hidden">
          <div className="h-8 flex items-center whitespace-nowrap">
            <span className="animate-marquee flex shrink-0 items-center whitespace-nowrap">
              {Array.from({ length: 4 }).map((_, i) => (
                  <span key={i} className="inline-flex shrink-0 items-center gap-8 pr-8 text-[11px] md:text-[11px] uppercase tracking-[0.28em] text-white/90">
                  <span>{announcement.announcement_text}</span>
                  <span>{announcement.announcement_text}</span>
                </span>
              ))}
            </span>
          </div>
        </div>
      )}
      <Navbar
        currentPath={path}
        onOpenLogin={(mode) => { setLoginMode(mode); setLoginOpen(true); }}
      />
      <main className="flex-1 pt-[80px] md:pt-[88px] overflow-x-hidden">
        <div key={path} className={`${firstPaint ? '' : 'animate-fade-in'} min-h-full`}>
          {isAdminPath ? <div className="min-h-screen bg-paper">{renderPage()}</div> : (
            <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center"><LoadingDots /></div>}>
              {renderPage()}
            </Suspense>
          )}
        </div>
      </main>
      <Footer />
      <CartDrawer />
      <LoginModal isOpen={loginOpen} onClose={handleLoginClose} initialMode={loginMode} />
      <FullscreenLoader visible={loading && protectingRoute} />
    </div>
  );
}

export default App;
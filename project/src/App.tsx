import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useRouter } from '@/lib/router';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { CartDrawer } from '@/components/CartDrawer';
import { LoginModal } from '@/components/LoginModal';
import { HomePage } from '@/pages/HomePage';
import { CollectionPage } from '@/pages/CollectionPage';
import { NewDropsPage } from '@/pages/NewDropsPage';
import { HowItWorksPage } from '@/pages/HowItWorksPage';
import { AboutPage } from '@/pages/AboutPage';
import { RetailProductPage } from '@/pages/RetailProductPage';
import { CheckoutPage } from '@/pages/CheckoutPage';
import { ContactPage } from '@/pages/ContactPage';
import { PoliciesPage } from '@/pages/PoliciesPage';
import { TermsPage } from '@/pages/TermsConditionsPage';
import { PrivacyPolicyPage } from '@/pages/PrivacyPolicyPage';
import { RefundCancellationPage } from '@/pages/RefundCancellationPage';
import { ReturnPolicyPage } from '@/pages/ReturnPolicyPage';
import { ShippingPolicyPage } from '@/pages/ShippingPolicyPage';
import { TrackOrderPage } from '@/pages/TrackOrderPage';
import { SubscriberDashboard } from '@/pages/SubscriberDashboard';
import { useAuth } from '@/lib/auth';
import { useSiteSettings } from '@/lib/settings';
import { useCartDrawer } from '@/lib/cartDrawer';
import { notFound } from '@/lib/notFound';
import { LoadingDots } from '@/components/LoadingDots';

// Lazy-load the admin dashboard (large, admin-only) to keep the main bundle small.
const AdminDashboard = lazy(() =>
  import('@/pages/admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard }))
);

const DEFAULT_TITLE = 'DSLANG — Premium Streetwear | Slang of Design';

function getPageTitle(path: string): string {
  if (path === '/' || path === '') return DEFAULT_TITLE;
  if (path.startsWith('/collection') || path.startsWith('/shop')) return 'Shop The Collection — DSLANG';
  if (path.startsWith('/new-drops')) return 'New Drops — DSLANG';
  if (path.startsWith('/product') || path.startsWith('/products') || path.startsWith('/p/')) return 'Product — DSLANG';
  if (path.startsWith('/cart')) return 'Your Bag — DSLANG';
  if (path.startsWith('/checkout')) return 'Checkout — DSLANG';
  if (path.startsWith('/how-it-works')) return 'How It Works — DSLANG';
  if (path.startsWith('/stock-dslang') || path.startsWith('/about')) return 'Stock DSLANG — DSLANG';
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
    if (segments[0] === 'how-it-works') return <HowItWorksPage />;
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

  const announcement = useSiteSettings().settings;

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      {announcement.announcement_active && announcement.announcement_text.trim() && (
        <div className="fixed inset-x-0 top-0 z-[100] border-b border-white/10 bg-[#111111] overflow-hidden">
          <div className="h-8 flex items-center whitespace-nowrap">
            <span className="animate-marquee flex shrink-0 items-center whitespace-nowrap">
              {Array.from({ length: 4 }).map((_, i) => (
                <span key={i} className="inline-flex shrink-0 items-center gap-8 pr-8 text-[10px] md:text-[11px] uppercase tracking-[0.28em] text-white/90">
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
      <main className="flex-1 pt-[76px] md:pt-[88px] overflow-x-hidden">{isAdminPath ? <div className="min-h-screen bg-paper">{renderPage()}</div> : renderPage()}</main>
      <Footer />
      <CartDrawer />
      <LoginModal isOpen={loginOpen} onClose={handleLoginClose} initialMode={loginMode} />
      <FullscreenLoader visible={loading} />
    </div>
  );
}

export default App;
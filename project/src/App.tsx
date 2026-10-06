import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useRouter, replaceRoute } from '@/lib/router';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { CartDrawer } from '@/components/CartDrawer';
import { LoginModal } from '@/components/LoginModal';
import { HomePage } from '@/pages/HomePage';
import { CollectionPage } from '@/pages/CollectionPage';
import { RetailProductPage } from '@/pages/RetailProductPage';
import { useAuth, takeAuthReturnDestination } from '@/lib/auth';
import { useSiteSettings } from '@/lib/settings';
import { useCartDrawer } from '@/lib/cartDrawer';
import { notFound } from '@/lib/notFound';
import { LoadingDots } from '@/components/LoadingDots';
import { FullscreenLoader } from '@/components/FullscreenLoader';
import { AdminLayout } from '@/layouts/AdminLayout';
import { getPaymentConfig } from '@/lib/payment';
import { preloadCashfreeSdk } from '@/lib/cashfreeSdk';

// Lazy-load every non-core page so the initial bundle only ships the shop
// skeleton (home, collection, product + admin entry). Each
// secondary route downloads only the chunk it needs on first visit, and the
// shop path never loads checkout/account/admin code.
const AdminDashboard = lazy(() =>
  import('@/pages/admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard }))
);
const PrintDeliveryPage = lazy(() =>
  import('@/pages/admin/PrintDeliveryPage').then((m) => ({ default: m.PrintDeliveryPage }))
);
const CheckoutPage = lazy(() =>
  import('@/pages/CheckoutPage').then((m) => ({ default: m.CheckoutPage }))
);
const PaymentReturnPage = lazy(() =>
  import('@/pages/PaymentReturnPage').then((m) => ({ default: m.PaymentReturnPage }))
);
const TrackOrderPage = lazy(() =>
  import('@/pages/TrackOrderPage').then((m) => ({ default: m.TrackOrderPage }))
);
const MyOrdersPage = lazy(() =>
  import('@/pages/MyOrdersPage').then((m) => ({ default: m.MyOrdersPage }))
);
const OrderStatusPage = lazy(() =>
  import('@/pages/OrderStatusPage').then((m) => ({ default: m.OrderStatusPage }))
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
  // '/collection' is a prefix of '/collections', so the legacy URLs keep the
  // correct title on their single render before the redirect rewrites them.
  if (path.startsWith('/collections') || path.startsWith('/collection') || path.startsWith('/shop') || path.startsWith('/new-drops')) return 'Shop The Collection — DSLANG';
  if (path.startsWith('/product') || path.startsWith('/products') || path.startsWith('/p/')) return 'Product — DSLANG';
  if (path.startsWith('/cart')) return 'Your Bag — DSLANG';
  if (path.startsWith('/checkout')) return 'Checkout — DSLANG';
  if (path.startsWith('/payment/return')) return 'Payment — DSLANG';
  if (path.startsWith('/order-status')) return 'Order Status — DSLANG';
  if (path.startsWith('/stock-dslang') || path.startsWith('/about')) return 'About DSLANG — DSLANG';
  if (path.startsWith('/contact')) return 'Contact — DSLANG';
  if (path.startsWith('/policies')) return 'Policies — DSLANG';
  if (path.startsWith('/terms-and-conditions')) return 'Terms & Conditions — DSLANG';
  if (path.startsWith('/privacy-policy')) return 'Privacy Policy — DSLANG';
  if (path.startsWith('/refund-and-cancellation')) return 'Refund & Cancellation — DSLANG';
  if (path.startsWith('/return-policy')) return 'Return Policy — DSLANG';
  if (path.startsWith('/shipping-policy')) return 'Shipping Policy — DSLANG';
  if (path.startsWith('/track-order')) return 'Track Order — DSLANG';
  if (path.startsWith('/my-orders')) return 'My Orders — DSLANG';
  if (path.startsWith('/account')) return 'Account — DSLANG';
  if (path.startsWith('/admin')) return 'Admin — DSLANG';
  return DEFAULT_TITLE;
}

function App() {
  const { route, navigate } = useRouter();
  const { path, segments } = route;
  const { user, loading, isAdmin, isAdminLoading } = useAuth();
  const { openCart } = useCartDrawer();
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginMode, setLoginMode] = useState<'signin' | 'signup'>('signin');

  useEffect(() => {
    document.title = getPageTitle(path);
  }, [path]);

  // Warm the Cashfree SDK the moment the app boots (not just when checkout
  // mounts) so that Pay Now's hand-off to the gateway needs zero script
  // download wait. Fire-and-forget: a failure merely means the checkout path
  // re-attempts the load with its own guard.
  useEffect(() => {
    if (!getPaymentConfig().configured) return;
    preloadCashfreeSdk();
  }, []);

  // Legacy /cart links open the bag drawer instead of a separate page.
  //
  // REPLACED, not pushed. `/cart` is a transient alias with no page of its own:
  // if it pushed, the `#/cart` entry would stay in history, and every Back that
  // reached it would immediately push `/` again — history grew on each press and
  // the visitor could never leave with Back at all. Replacing it means the alias
  // is consumed on arrival, exactly like the canonicalization redirect below.
  useEffect(() => {
    if (segments[0] === 'cart') {
      openCart();
      replaceRoute('/');
    }
  }, [segments, openCart]);

  // Canonicalize the legacy shop URLs onto /collections. The replacement is
  // done with `replaceRoute`, so an old bookmark / shared link / indexed URL
  // lands on the one canonical page without leaving a Back entry that would
  // bounce straight back into this redirect.
  //
  // `/new-drops` is in this list because "New Drops" was a filtered copy of the
  // same catalogue: a second name for one set of clothes. Its page is gone, and
  // every old link to it now lands on Collection instead of a 404.
  useEffect(() => {
    if (segments[0] === 'collection' || segments[0] === 'shop' || segments[0] === 'new-drops') {
      replaceRoute('/collections');
    }
  }, [segments]);

  // Handle redirects for protected routes - MUST BE IN useEffect, NOT in renderPage
  //
  // Every branch here is a redirect the visitor was NOT meant to stay on (a guest
  // has no account, a non-admin has no console, an admin has no account page), so
  // each one REPLACES its entry instead of pushing. Pushing left the original
  // route in history, and Back then walked straight back into it, bounced to `/`
  // again, and the visitor could not get out with Back at all.
  useEffect(() => {
    if (loading) return; // Wait for auth state to load

    if (segments[0] === 'account') {
      if (!user) {
        setLoginOpen(true);
        replaceRoute('/');
      } else if (isAdmin) {
        // Admin accessing /account - send to /admin
        replaceRoute('/admin');
      }
    } else if (segments[0] === 'admin') {
      // Wait for the admin_users check to settle before deciding. Judging on a
      // stale/unknown isAdmin would either bounce a real admin to /account, or
      // (on sign-out) leave the admin route reachable for a frame.
      if (isAdminLoading) return;
      if (!user) {
        setLoginOpen(true);
        replaceRoute('/');
      } else if (!isAdmin) {
        // Non-admin accessing /admin - send to /account
        replaceRoute('/account');
      }
    }
  }, [segments, user, loading, isAdmin, isAdminLoading]);

  // Restore the route a shopper started a Google login from. `redirectTo`
  // normally carries the hash back, so this only fires when the OAuth return
  // lost it. Strictly one-shot, and admins are never moved off /admin.
  useEffect(() => {
    if (loading || !user) return;
    const destination = takeAuthReturnDestination();
    if (destination && !isAdmin) navigate(destination);
  }, [loading, user, isAdmin, navigate]);

  const handleLoginClose = useCallback(() => {
    setLoginOpen(false);
  }, []);


  const renderPage = () => {
    if (segments.length === 0) return <HomePage />;
    // `/collections` is the ONE canonical shop URL. `/collection`, `/shop` and
    // `/new-drops` render the same page for the single frame before the redirect
    // effect above rewrites them in place — without that, a visitor arriving on a
    // legacy URL would see a one-frame 404 flash. So the three URLs never compete
    // as separate destinations in analytics / search / link shares.
    if (segments[0] === 'collections' || segments[0] === 'collection' || segments[0] === 'shop' || segments[0] === 'new-drops') return <CollectionPage />;
    if (segments[0] === 'product' && segments[1]) return <RetailProductPage slug={segments[1]} />;
    if (segments[0] === 'products' && segments[1]) return <RetailProductPage slug={segments[1]} />;
    if (segments[0] === 'p' && segments[1]) return <RetailProductPage slug={segments[1]} />;
    if (segments[0] === 'cart') return <HomePage />;
    if (segments[0] === 'checkout') return <CheckoutPage />;
    if (segments[0] === 'payment' && segments[1] === 'return') return <PaymentReturnPage />;
    if (segments[0] === 'order-status') return <OrderStatusPage />;
    if (segments[0] === 'stock-dslang' || segments[0] === 'about') return <AboutPage />;
    if (segments[0] === 'contact') return <ContactPage />;
    if (segments[0] === 'policies') return <PoliciesPage />;
    if (segments[0] === 'terms-and-conditions') return <TermsPage />;
    if (segments[0] === 'privacy-policy') return <PrivacyPolicyPage />;
    if (segments[0] === 'refund-and-cancellation') return <RefundCancellationPage />;
    if (segments[0] === 'return-policy') return <ReturnPolicyPage />;
    if (segments[0] === 'shipping-policy') return <ShippingPolicyPage />;
    if (segments[0] === 'track-order') return <TrackOrderPage refFromRoute={segments[1] ?? ''} />;
    if (segments[0] === 'my-orders') return <MyOrdersPage />;
    if (segments[0] === 'account') {
      if (loading) return null;
      if (!user) return null; // Redirect handled by useEffect above
      if (isAdmin) return null; // Redirect to /admin handled by useEffect
      if (segments[1] === 'orders') return <MyOrdersPage />;
      return <SubscriberDashboard />;
    }
    if (segments[0] === 'admin') {
      if (loading || isAdminLoading) return null;
      if (!user) return null; // Redirect handled by useEffect above
      if (!isAdmin) return null; // Redirect to /account handled by useEffect
      if (segments[1] === 'print-delivery' && segments[2]) {
        return (
          <Suspense fallback={<div className="min-h-dvh w-full flex items-center justify-center"><LoadingDots /></div>}>
            <PrintDeliveryPage orderId={decodeURIComponent(segments[2])} />
          </Suspense>
        );
      }
      return (
          <Suspense fallback={<div className="min-h-dvh w-full flex items-center justify-center"><LoadingDots /></div>}>
          <AdminDashboard />
        </Suspense>
      );
    }
    return notFound();
  };

  const isAdminPath = segments[0] === 'admin';

  // Payment return (landing back from the Cashfree gateway): the window shows
  // ONLY the brand header + verification screen — no nav, and the cart drawer
  // is not even mounted so it can never be opened mid-verification.
  const isPaymentReturn = segments[0] === 'payment' && segments[1] === 'return';

  // The checkout ends on its own CTA and fine print. The site-wide brand footer
  // is a tall near-black block (see components/Footer.tsx) that would sit below
  // the fold as the last thing on the page and pull attention away from the
  // payment step, so it is not mounted here. Scoped to this one route — every
  // other page keeps the footer, and nothing is replaced in its place.
  const isCheckout = segments[0] === 'checkout';

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

  // Admin routes render through their OWN shell (AdminLayout + the admin
  // sidebar/header provided by AdminDashboard) — completely outside the
  // customer StorefrontLayout. No announcement bar, customer Navbar, customer
  // Footer, or cart drawer is ever mounted for /admin*.
  if (isAdminPath) {
    return <AdminLayout bootLoading={loading && protectingRoute}>{renderPage()}</AdminLayout>;
  }

  return (
    <div className="min-h-dvh flex flex-col bg-paper">
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
        minimal={isPaymentReturn}
        onOpenLogin={(mode) => { setLoginMode(mode); setLoginOpen(true); }}
      />
      <main className="flex-1 pt-[80px] md:pt-[88px]">
        <div key={path} className={`${firstPaint ? '' : 'animate-fade-in'} min-h-full`}>
          <Suspense fallback={<div className="min-h-dvh w-full flex items-center justify-center"><LoadingDots /></div>}>
            {renderPage()}
          </Suspense>
        </div>
      </main>
      {!isCheckout && <Footer />}
      {!isPaymentReturn && <CartDrawer />}
      <LoginModal isOpen={loginOpen} onClose={handleLoginClose} initialMode={loginMode} />
      <FullscreenLoader visible={loading && protectingRoute} />
    </div>
  );
}

export default App;
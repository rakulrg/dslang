import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useRouter } from '@/lib/router';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { CartDrawer } from '@/components/CartDrawer';
import { LoginModal } from '@/components/LoginModal';
import { HomePage } from '@/pages/HomePage';
import { ShopPage } from '@/pages/ShopPage';
import { ProductPage } from '@/pages/ProductPage';
import { ContactPage } from '@/pages/ContactPage';
import { PoliciesPage } from '@/pages/PoliciesPage';
import { SubscriberDashboard } from '@/pages/SubscriberDashboard';
import { useAuth } from '@/lib/auth';
import { notFound } from '@/lib/notFound';

// Lazy-load the admin dashboard (large, admin-only) to keep the main bundle small.
const AdminDashboard = lazy(() =>
  import('@/pages/admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard }))
);

const DEFAULT_TITLE = 'DSLANG — Limited Drop Streetwear';

function getPageTitle(path: string): string {
  if (path === '/' || path === '') return DEFAULT_TITLE;
  if (path.startsWith('/shop')) return 'Shop All — DSLANG';
  if (path.startsWith('/contact')) return 'Contact — DSLANG';
  if (path.startsWith('/policies')) return 'Policies — DSLANG';
  if (path.startsWith('/account')) return 'Account — DSLANG';
  if (path.startsWith('/admin')) return 'Admin — DSLANG';
  if (path.startsWith('/product/')) return 'Product — DSLANG';
  return DEFAULT_TITLE;
}

function App() {
  const { route, navigate } = useRouter();
  const { path, segments } = route;
  const { user, loading, isAdmin } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    document.title = getPageTitle(path);
  }, [path]);

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

  const handleLoginClick = useCallback(() => {
    if (loading) return;
    if (!user) {
      // Not authenticated - show login modal
      setLoginOpen(true);
    } else {
      // Already authenticated - navigate to correct destination if needed
      if (isAdmin && path !== '/admin') {
        navigate('/admin');
      } else if (!isAdmin && path !== '/account') {
        navigate('/account');
      }
      // Already at correct destination - do nothing
    }
  }, [user, isAdmin, loading, path, navigate]);


  const renderPage = () => {
    if (segments.length === 0) return <HomePage />;
    if (segments[0] === 'shop') return <ShopPage />;
    if (segments[0] === 'product' && segments[1]) return <ProductPage slug={segments[1]} />;
    if (segments[0] === 'contact') return <ContactPage />;
    if (segments[0] === 'policies') return <PoliciesPage />;
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
        <Suspense fallback={<div className="min-h-screen bg-paper-2 flex items-center justify-center"><div className="w-8 h-8 border-2 border-crimson border-t-transparent rounded-full animate-spin" /></div>}>
          <AdminDashboard />
        </Suspense>
      );
    }
    return notFound();
  };

  const isAdminPath = segments[0] === 'admin';

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      <div className="fixed inset-x-0 top-0 z-[100] border-b border-white/10 bg-[#111111] overflow-hidden">
        <div className="h-8 flex items-center whitespace-nowrap">
          <span className="animate-marquee flex shrink-0 items-center whitespace-nowrap">
            <span className="inline-flex shrink-0 items-center gap-8 pr-8 text-[10px] md:text-[11px] uppercase tracking-[0.28em] text-white/90">
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-8 pr-8 text-[10px] md:text-[11px] uppercase tracking-[0.28em] text-white/90">
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
              <span>FREE SHIPPING ON ORDERS ABOVE ₹999</span>
            </span>
          </span>
        </div>
      </div>
      <Navbar currentPath={path} onLoginClick={handleLoginClick} />
      <main className="flex-1 pt-[76px] md:pt-[88px] overflow-x-hidden">{isAdminPath ? <div className="min-h-screen bg-paper">{renderPage()}</div> : renderPage()}</main>
      <Footer />
      <CartDrawer />
      <LoginModal isOpen={loginOpen} onClose={handleLoginClose} />
    </div>
  );
}

export default App;


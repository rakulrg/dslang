import { useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { HomePage } from '@/pages/HomePage';
import { ShopPage } from '@/pages/ShopPage';
import { ProductPage } from '@/pages/ProductPage';
import { ContactPage } from '@/pages/ContactPage';
import { PoliciesPage } from '@/pages/PoliciesPage';
import { AdminLoginPage } from '@/pages/admin/AdminLoginPage';
import { AdminSignupPage } from '@/pages/admin/AdminSignupPage';
import { AdminDashboard } from '@/pages/admin/AdminDashboard';
import { SubscriberDashboard } from '@/pages/SubscriberDashboard';
import { useAuth } from '@/lib/auth';
import { notFound } from '@/lib/notFound';

const DEFAULT_TITLE = 'DSLANG — Limited Drop Streetwear';

function getPageTitle(path: string): string {
  if (path === '/' || path === '') return DEFAULT_TITLE;
  if (path.startsWith('/shop')) return 'Shop All — DSLANG';
  if (path.startsWith('/contact')) return 'Contact — DSLANG';
  if (path.startsWith('/policies')) return 'Policies — DSLANG';
  if (path.startsWith('/admin/login')) return 'Admin Login — DSLANG';
  if (path.startsWith('/admin/signup')) return 'Create Admin — DSLANG';
  if (path.startsWith('/admin')) return 'Admin — DSLANG';
  if (path.startsWith('/product/')) return 'Product — DSLANG';
  return DEFAULT_TITLE;
}

function App() {
  const { route } = useRouter();
  const { path, segments } = route;
  const { user, loading, isAdmin } = useAuth();

  useEffect(() => {
    document.title = getPageTitle(path);
  }, [path]);

  const isAdminPath = segments[0] === 'admin';
  const isAdminLogin = segments[0] === 'admin' && segments[1] === 'login';
  const isAdminSignup = segments[0] === 'admin' && segments[1] === 'signup';

  const renderPage = () => {
    if (segments.length === 0) return <HomePage />;
    if (segments[0] === 'shop') return <ShopPage />;
    if (segments[0] === 'product' && segments[1]) return <ProductPage slug={segments[1]} />;
    if (segments[0] === 'contact') return <ContactPage />;
    if (segments[0] === 'policies') return <PoliciesPage />;
    if (segments[0] === 'account') {
      if (loading) return null;
      if (!user) return <AdminLoginPage />;
      if (isAdmin) return <AdminDashboard />;
      return <SubscriberDashboard />;
    }
    if (isAdminLogin) return <AdminLoginPage />;
    if (isAdminSignup) return <AdminSignupPage />;
    if (isAdminPath) {
      if (loading) return null;
      if (!user) return <AdminLoginPage />;
      if (isAdmin) return <AdminDashboard />;
      return <SubscriberDashboard />;
    }
    return notFound();
  };

  if (isAdminPath && !isAdminLogin && !isAdminSignup) {
    return <div className="min-h-screen bg-paper">{renderPage()}</div>;
  }

  if (isAdminLogin || isAdminSignup) {
    return <div className="min-h-screen bg-paper">{renderPage()}</div>;
  }

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      <Navbar currentPath={path} />
      <main className="flex-1">{renderPage()}</main>
      <Footer />
    </div>
  );
}

export default App;

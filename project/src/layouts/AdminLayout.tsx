import type { ReactNode } from 'react';
import { FullscreenLoader } from '@/components/FullscreenLoader';

// Admin route shell. NEVER rendered inside the customer StorefrontLayout — the
// App switch mounts this layout only for /admin* routes, so no announcement
// bar, customer Navbar, customer Footer, cart drawer, or storefront search can
// appear around admin UI. The admin page itself (AdminDashboard) provides the
// admin sidebar + header + content area; this wrapper only supplies a neutral
// full-height surface and the protected-boot loader.
export function AdminLayout({
  children,
  bootLoading,
}: {
  children: ReactNode;
  bootLoading: boolean;
}) {
  return (
    <div className="min-h-dvh bg-paper">
      {children}
      <FullscreenLoader visible={bootLoading} />
    </div>
  );
}

export default AdminLayout;
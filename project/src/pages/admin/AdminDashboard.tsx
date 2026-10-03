import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  LayoutGrid,
  Image as ImageIcon,
  LogOut,
  Plus,
  Trash2,
  Save,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Check,
  Clock,
  ExternalLink,
  Upload,
  Settings as SettingsIcon,
  ShoppingBag,
  Copy,
  Pencil,
  Phone,
  Ticket,
  Loader2,
  Truck,
  Printer,
  LayoutDashboard,
  Boxes,
  ClipboardList,
  Users,
  BarChart3,
  Activity as ActivityIcon,
  FolderOpen,
  Menu,
  PanelLeft,
  Search as SearchIcon,
Bell,
Calendar,
Mail,
Info,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useSiteSettings, type SiteSettings } from '@/lib/settings';
import { linkHref } from '@/lib/router';
import { formatPrice, getMrp, getRetailPrice, getSizesForColor } from '@/lib/catalog';
import { useOrderImages, imageForItem } from '@/lib/orderImages';
import { preloadImage } from '@/lib/image';
import { LoadingDots } from '@/components/LoadingDots';
import { useConfirm } from '@/components/ConfirmDialog';
import {
  adminFetchProducts,
  adminFetchHero,
  adminCreateProduct,
  adminUpdateProduct,
  adminDeleteProduct,
  adminAddColor,
  adminUpdateColor,
  adminDeleteColor,
  adminUpdateColorSortOrders,
  adminBulkSetSizeStock,
  adminRemoveProductSize,
  adminSetSizeOrder,
  adminFetchRetailOrders,
  adminCountRetailOrders,
  adminDeleteRetailOrder,
  adminCreateHero,
  adminUpdateHero,
  adminDeleteHero,
  uploadProductImage,
  uploadHeroImage,
  latestImageCleanupWarning,
  describeSupabaseError,
  type ProductInput,
  type RetailOrderQuery,
  adminSetOrderShipping,
} from '@/lib/admin';
import { hasPublishColumns, isRetailVisible } from '@/lib/catalog';
import type { CatalogProduct, HeroSlideRow, ProductColorRow, RetailOrder } from '@/lib/types';
import {
  COURIER_OPTIONS,
  SHIPPING_STATUS_FLOW,
  SHIPPING_STATUS_LABEL,
  awbOf,
  delhiveryTrackingUrl,
  hasAwb,
  isPostHandoff,
  shippingStatusLabel,
  shippingStatusOf,
} from '@/lib/shipping';
import { sortSizeLabels, sizeLabelsForRows } from '@/lib/sizes';
import {
  ORDER_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  SHIPPABLE_ORDER_STATUSES,
  orderStatusOptions,
} from '@/pages/admin/orderLabels';
import { OverviewSection } from '@/pages/admin/OverviewSection';
import { DASH_RANGES, rangeLabel, type DashRange } from '@/pages/admin/dashboardData';
import { InventorySection } from '@/pages/admin/InventorySection';
import { PurchasingSection } from '@/pages/admin/PurchasingSection';
import { CustomersSection } from '@/pages/admin/CustomersSection';
import { ShippingSection } from '@/pages/admin/ShippingSection';
import { AnalyticsSection } from '@/pages/admin/AnalyticsSection';
import { ActivitySection } from '@/pages/admin/ActivitySection';
import { CollectionsSection } from '@/pages/admin/CollectionsSection';

type Tab =
  | 'overview'
  | 'orders'
  | 'shipping'
  | 'products'
  | 'collections'
  | 'hero'
  | 'promos'
  | 'inventory'
  | 'purchasing'
  | 'customers'
  | 'analytics'
  | 'activity'
  | 'settings';

import type { LucideIcon } from 'lucide-react';

const NAV_GROUPS: Array<{ label: string | null; items: Array<{ tab: Tab; label: string; icon: LucideIcon }> }> = [
  {
    label: null,
    items: [
      { tab: 'overview', label: 'Dashboard', icon: LayoutDashboard },
      { tab: 'orders', label: 'Orders', icon: ShoppingBag },
      { tab: 'products', label: 'Products', icon: LayoutGrid },
      { tab: 'collections', label: 'Collections', icon: FolderOpen },
    ],
  },
  {
    label: 'Operations',
    items: [
      { tab: 'inventory', label: 'Inventory', icon: Boxes },
      { tab: 'purchasing', label: 'Purchasing', icon: ClipboardList },
      { tab: 'customers', label: 'Customers', icon: Users },
      { tab: 'shipping', label: 'Shipments', icon: Truck },
    ],
  },
  {
    label: 'Marketing',
    items: [
      { tab: 'promos', label: 'Promo Codes', icon: Ticket },
      { tab: 'hero', label: 'Homepage', icon: ImageIcon },
    ],
  },
  {
    label: 'Insights',
    items: [
      { tab: 'analytics', label: 'Analytics', icon: BarChart3 },
      { tab: 'activity', label: 'Activity', icon: ActivityIcon },
    ],
  },
  {
    label: 'System',
    items: [{ tab: 'settings', label: 'Settings', icon: SettingsIcon }],
  },
];

const EXPECTED_RATIO = 4 / 5;
const RATIO_TOLERANCE = 0.03;

function checkImageAspectRatios(files: File[]): Promise<string[]> {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<string | null>((resolve) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            const ratio = img.naturalWidth / img.naturalHeight;
            if (Math.abs(ratio - EXPECTED_RATIO) / EXPECTED_RATIO > RATIO_TOLERANCE) {
              resolve(file.name);
            } else {
              resolve(null);
            }
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
          };
          img.src = url;
        }),
    ),
  ).then((results) => results.filter(Boolean) as string[]);
}

function adminIdentity(user: { email?: string | null }): { name: string; initial: string } {
  const local = ((user?.email ?? '').split('@')[0] || 'Admin').replace(/[^a-zA-Z]+/g, ' ');
  const words = local.split(' ').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const name = words.length > 0 ? words.join(' ') : 'Admin';
  return { name, initial: name.charAt(0).toUpperCase() || 'A' };
}

function inrOrderTotal(n: number): string {
  return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
}

function SidebarNav({
  collapsed,
  user,
  tab,
  onNavigate,
  onLogout,
}: {
  collapsed: boolean;
  user: { email?: string | null };
  tab: Tab;
  onNavigate: (t: Tab) => void;
  onLogout: () => void;
}) {
  const { name, initial } = adminIdentity(user);
  const itemCls = (active: boolean) =>
    collapsed
      ? `w-full flex items-center justify-center rounded-md px-0 py-2 transition-colors ${active ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'}`
      : `w-full flex items-center gap-3 rounded-md px-2.5 py-2 transition-colors ${active ? 'bg-white/10 text-white font-semibold' : 'text-slate-400 hover:text-white hover:bg-white/5'}`;
  return (
    <div className="flex flex-col h-full bg-[#0f172a]">
      <div className={`px-4 pt-5 pb-4 border-b border-white/10 ${collapsed ? 'px-0 text-center' : ''}`}>
        {collapsed ? (
          <a href={linkHref('/')} className="font-brand text-lg tracking-[0.03em] text-white" title="DSLANG">
            D
          </a>
        ) : (
          <>
            <a href={linkHref('/')} className="font-brand text-xl tracking-[0.03em] text-white leading-none inline-block">
              DSLANG
            </a>
            <p className="mt-1 font-label text-[9px] uppercase tracking-wide-2 text-slate-500">Slang of Design</p>
          </>
        )}
      </div>

      <div className={`px-3 py-3 border-b border-white/10 flex items-center ${collapsed ? 'px-0 justify-center' : 'gap-2.5'}`}>
        <div className="w-8 h-8 rounded-full bg-white/10 text-white grid place-items-center text-[11px] font-semibold uppercase shrink-0 ring-1 ring-white/15">
          {initial}
        </div>
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-white leading-tight">{name}</p>
              <p className="mt-0.5 text-[9px] uppercase tracking-wide-2 text-slate-500">Admin</p>
            </div>
            <ChevronDown size={14} className="shrink-0 text-slate-500" />
          </>
        )}
      </div>

      <nav className="admin-sidebar-nav flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label ?? 'primary'}>
            {!collapsed && group.label && (
              <p className="px-2 pb-1 text-[9px] font-semibold uppercase tracking-wide-2 text-slate-500">{group.label}</p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = tab === item.tab;
                return (
                  <button
                    key={item.tab}
                    onClick={() => onNavigate(item.tab)}
                    title={collapsed ? item.label : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    className={itemCls(active)}
                  >
                    <Icon size={16} strokeWidth={1.8} className="shrink-0" />
                    {!collapsed && <span className="text-[13px] whitespace-nowrap">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-2 border-t border-white/10 space-y-0.5">
        <a href={linkHref('/')} title="View site" className={itemCls(false)}>
          <ExternalLink size={16} strokeWidth={1.8} className="shrink-0" />
          {!collapsed && <span className="text-[13px]">View site</span>}
        </a>
        <button onClick={onLogout} title="Sign out" className={itemCls(false)}>
          <LogOut size={16} strokeWidth={1.8} className="shrink-0" />
          {!collapsed && <span className="text-[13px]">Sign out</span>}
        </button>
      </div>
    </div>
  );
}

export function AdminDashboard() {
  const { user, isAdmin, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [heroSlides, setHeroSlides] = useState<HeroSlideRow[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [publishReady, setPublishReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dashRange, setDashRange] = useState<DashRange>('30D');
  const [orderMatches, setOrderMatches] = useState<RetailOrder[]>([]);
  const [openMenu, setOpenMenu] = useState<'range' | 'bell' | 'user' | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadProducts = useCallback(async () => {
    try {
      setLoadError('');
      setProducts(await adminFetchProducts());
    } catch (err) {
      setProducts([]);
      setLoadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Failed to load products'));
    }
  }, []);

  const loadHero = useCallback(async () => {
    try {
      setLoadError('');
      setHeroSlides(await adminFetchHero());
    } catch (err) {
      setHeroSlides([]);
      setLoadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Failed to load hero slides'));
    }
  }, []);

  useEffect(() => {
    loadProducts();
    loadHero();
  }, [loadProducts, loadHero]);

  useEffect(() => {
    let cancelled = false;
    hasPublishColumns().then((ok) => { if (!cancelled) setPublishReady(ok); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setOrderMatches([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      const esc = q.replace(/[%_\\]/g, '');
      const { data } = await supabase
        .from('retail_orders')
        .select('id, ref, customer, items, total_qty, total_amount, payment_status, order_status, is_cod, created_at')
        .or(`ref.ilike.%${esc}%,customer->>name.ilike.%${esc}%,customer->>phone.ilike.%${esc}%`)
        .order('created_at', { ascending: false })
        .limit(5);
      if (!cancelled) setOrderMatches((data as RetailOrder[]) ?? []);
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [search]);

  const handleLogout = async () => {
    // Through the auth context, not supabase.auth.signOut() directly. Signing
    // out on the client alone left the context's user/isAdmin frozen at the
    // signed-in values, so the navigation drawer went on offering ADMIN PANEL
    // to a visitor who was already signed out, until a hard refresh.
    await signOut();
    window.location.hash = '#/';
  };

  const runAction = async (fn: () => Promise<void>, fallback: string) => {
    setActionError('');
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : describeSupabaseError(err, fallback));
    }
  };

  const editingProduct = products?.find((p) => p.id === editingId) ?? null;

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query || !products) return [];
    return products
      .filter((p) => p.name.toLowerCase().includes(query) || (p.code ?? '').toLowerCase().includes(query))
      .slice(0, 7);
  }, [products, search]);

  const customerMatches = useMemo(() => {
    const seen = new Set<string>();
    const arr: Array<{ name: string; phone: string; city: string }> = [];
    for (const o of orderMatches) {
      const phone = o.customer?.phone;
      if (phone && !seen.has(phone)) {
        seen.add(phone);
        arr.push({ name: o.customer.name, phone, city: o.customer.city });
      }
    }
    return arr;
  }, [orderMatches]);

  const { name: adminName } = adminIdentity(user ?? {});
  const adminInitial = adminIdentity(user ?? {}).initial;

  const goto = (t: Tab) => {
    setTab(t);
    setEditingId(null);
    setCreating(false);
    setNavOpen(false);
    setSearch('');
  };

  const openProductFromSearch = (id: string) => {
    setSearch('');
    setCreating(false);
    setTab('products');
    setEditingId(id);
  };

  // Defense-in-depth: App.tsx already redirects non-admins away from /admin,
  // but never render admin controls if this session is not an admin.
  if (!user || isAdmin !== true) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-paper px-4">
        <div className="text-center w-full max-w-md">
          <p className="font-label text-2xl uppercase tracking-wide-2 text-bone">Access restricted</p>
          <p className="mt-2 text-sm text-grey">You need an administrator account to open the dashboard.</p>
          <a href={linkHref('/')} className="mt-6 inline-block bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-ink transition-colors">
            Back to site
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh overflow-hidden bg-paper-2 flex flex-col lg:flex-row admin-shell">
      {/* Mobile drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-bone/40" onClick={() => setNavOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 bg-[#0f172a] border-r border-white/10 shadow-xl overflow-hidden">
            <button
              onClick={() => setNavOpen(false)}
              aria-label="Close menu"
              className="absolute right-2 top-2 z-10 grid w-8 h-8 place-items-center text-slate-400 hover:text-white rounded"
            >
              <X size={17} />
            </button>
            <SidebarNav collapsed={false} user={user ?? {}} tab={tab} onNavigate={goto} onLogout={handleLogout} />
          </div>
        </div>
      )}

      {/* Desktop sidebar. The collapse is instant on purpose: `width` is a
          layout property, so animating it relaid out the whole content column
          on every frame and read as a shutter every time the rail was
          toggled. The nav items inside still never move (see the
          .admin-shell interaction-polish block in index.css). */}
      <aside
        className={`hidden lg:flex shrink-0 border-r border-white/10 bg-[#0f172a] flex-col h-dvh overflow-hidden ${
          sidebarCollapsed ? 'w-16' : 'w-52'
        }`}
      >
        <SidebarNav collapsed={sidebarCollapsed} user={user ?? {}} tab={tab} onNavigate={goto} onLogout={handleLogout} />
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="shrink-0 sticky top-0 z-20 bg-white/95 backdrop-blur-md border-b border-line h-14 flex items-center gap-2 sm:gap-3 px-3 sm:px-5">
          <button
            onClick={() => setSidebarCollapsed((c) => !c)}
            title="Toggle sidebar"
            aria-label="Toggle sidebar"
            className="hidden lg:grid w-8 h-8 place-items-center rounded text-grey hover:text-bone hover:bg-paper-2"
          >
            <PanelLeft size={17} strokeWidth={1.8} />
          </button>
          <button
            onClick={() => setNavOpen(true)}
            title="Open menu"
            aria-label="Open menu"
            className="lg:hidden grid w-8 h-8 place-items-center rounded text-grey hover:text-bone hover:bg-paper-2"
          >
            <Menu size={18} strokeWidth={1.8} />
          </button>

          {/* Search */}
          <div className="relative flex-1 max-w-md ml-1 md:ml-4 block">
            <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-grey" strokeWidth={1.8} />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setOpenMenu(null)}
              placeholder="Search orders, products, customers…"
              className="w-full h-9 pl-9 pr-14 bg-paper-2 border border-line rounded-md text-[13px] text-bone placeholder:text-grey focus:outline-none focus:border-line-2 focus:bg-white"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex items-center rounded border border-line bg-paper-3 px-1.5 py-0.5 text-[9px] font-medium text-grey">
              Ctrl K
            </span>
            {search.trim().length > 0 && (
              <div className="absolute inset-x-0 top-full mt-1.5 z-30 bg-white border border-line rounded-lg shadow-xl overflow-hidden">
                {searchResults.length === 0 && orderMatches.length === 0 && customerMatches.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-grey">Nothing matches “{search.trim()}”.</p>
                ) : (
                  <div className="max-h-[420px] overflow-y-auto">
                    {orderMatches.length > 0 && (
                      <div>
                        <p className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-wide-2 text-grey">Orders</p>
                        {orderMatches.map((o) => (
                          <button
                            key={o.id}
                            onClick={() => goto('orders')}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-paper-2"
                          >
                            <span className="min-w-0 flex-1 truncate text-[13px] text-bone">{o.ref}</span>
                            <span className="shrink-0 truncate max-w-[160px] text-[11px] text-grey">{o.customer?.name}</span>
                            <span className="shrink-0 text-[10px] uppercase tracking-wide-2 text-grey tabular-nums">{inrOrderTotal(Number(o.total_amount) || 0)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {customerMatches.length > 0 && (
                      <div>
                        <p className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-wide-2 text-grey">Customers</p>
                        {customerMatches.map((c) => (
                          <button
                            key={c.phone}
                            onClick={() => goto('customers')}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-paper-2"
                          >
                            <span className="min-w-0 flex-1 truncate text-[13px] text-bone">{c.name}</span>
                            <span className="shrink-0 text-[11px] text-grey">{c.phone}</span>
                            {c.city && <span className="shrink-0 text-[11px] text-grey">{c.city}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    {searchResults.length > 0 && (
                      <div>
                        <p className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-wide-2 text-grey">Products</p>
                        {searchResults.map((p) => (
                          <button
                            key={p.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              openProductFromSearch(p.id);
                            }}
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-paper-2"
                          >
                            <div className="w-6 h-7 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
                              {p.colors[0]?.images[0] && <img src={p.colors[0].images[0]} alt="" className="h-full w-full object-cover" />}
                            </div>
                            <span className="min-w-0 flex-1 truncate text-[13px] text-bone">{p.name}</span>
                            <span className="shrink-0 text-[10px] uppercase tracking-wide-2 text-grey">{p.code}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
            {openMenu && <div className="fixed inset-0 z-10" onClick={() => setOpenMenu(null)} />}
            {/* Date range */}
            <div className="relative hidden sm:block">
              <button
                onClick={() => setOpenMenu((m) => (m === 'range' ? null : 'range'))}
                title="Date range"
                className="inline-flex items-center gap-1.5 h-9 rounded-lg border border-line px-2.5 text-[11px] font-medium text-bone-dim hover:text-bone hover:border-line-2 transition-colors"
              >
                <Calendar size={14} strokeWidth={1.8} />
                <span className="hidden md:inline">{rangeLabel(dashRange)}</span>
                <ChevronDown size={12} strokeWidth={2} />
              </button>
              {openMenu === 'range' && (
                <div className="absolute right-0 top-full mt-1.5 z-30 bg-white border border-line rounded-lg shadow-xl overflow-hidden w-44 animate-slide-down">
                  {DASH_RANGES.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => {
                        setDashRange(r.key);
                        setOpenMenu(null);
                      }}
                      className={`block w-full text-left px-3 py-2 text-[12px] ${dashRange === r.key ? 'bg-paper-2 font-semibold text-bone' : 'text-bone-dim hover:bg-paper-2'}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Notifications */}
            <div className="relative">
              <button
                onClick={() => setOpenMenu((m) => (m === 'bell' ? null : 'bell'))}
                title="Notifications"
                aria-label="Notifications"
                className="relative grid w-8 h-8 place-items-center rounded-lg text-grey hover:text-bone hover:bg-paper-2 transition-colors"
              >
                <Bell size={16} strokeWidth={1.8} />
              </button>
              {openMenu === 'bell' && (
                <div className="absolute right-0 top-full mt-1.5 z-30 bg-white border border-line rounded-lg shadow-xl overflow-hidden w-64 animate-slide-down">
                  <p className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wide-2 text-bone-dim">Notifications</p>
                  <div className="p-4">
                    <p className="text-xs text-bone">No notifications yet.</p>
                    <p className="mt-1.5 text-[11px] text-grey leading-relaxed">Low-stock and shipment alerts aren't configured yet — this bell stays empty until they are.</p>
                  </div>
                </div>
              )}
            </div>

            {/* Homepage (gallery) */}
            <button
              onClick={() => goto('hero')}
              title="Homepage"
              aria-label="Homepage"
              className="hidden sm:grid w-8 h-8 place-items-center rounded-lg text-grey hover:text-bone hover:bg-paper-2 transition-colors"
            >
              <ImageIcon size={16} strokeWidth={1.8} />
            </button>

            {/* User */}
            <div className="relative">
              <button
                onClick={() => setOpenMenu((m) => (m === 'user' ? null : 'user'))}
                title="Account"
                aria-label="Account"
                className="grid w-8 h-8 place-items-center rounded-full bg-bone text-white text-[11px] font-semibold uppercase hover:bg-ink transition-colors"
              >
                {adminInitial}
              </button>
              {openMenu === 'user' && (
                <div className="absolute right-0 top-full mt-1.5 z-30 bg-white border border-line rounded-lg shadow-xl overflow-hidden w-60 animate-slide-down">
                  <div className="px-4 py-3 border-b border-line">
                    <p className="text-[13px] font-semibold text-bone">{adminName}</p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-wide-2 text-grey">Admin</p>
                    <p className="mt-1.5 truncate text-[11px] text-grey">{user?.email ?? ''}</p>
                  </div>
                  <a href={linkHref('/')} className="flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-bone-dim hover:text-bone hover:bg-paper-2 transition-colors">
                    <ExternalLink size={15} strokeWidth={1.8} /> View site
                  </a>
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-bone-dim hover:text-bone hover:bg-paper-2 transition-colors"
                  >
                    <LogOut size={15} strokeWidth={1.8} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6 w-full max-w-[1440px] mx-auto admin-scroll">
          {loadError && (
            <div className="mb-6 bg-crimson/5 border border-crimson/20 text-crimson text-sm px-4 py-3 rounded">
              {loadError}
            </div>
          )}
          {actionError && (
            <div className="mb-6 bg-crimson/5 border border-crimson/20 text-crimson text-sm px-4 py-3 rounded">
              {actionError}
            </div>
          )}
          {tab === 'products' && (
            creating ? (
              <ProductForm
                publishReady={publishReady}
                onSave={(input) => runAction(async () => { await adminCreateProduct(input); await loadProducts(); setCreating(false); }, 'Could not create this product.')}
                onCancel={() => setCreating(false)}
              />
            ) : editingProduct ? (
              <ProductEditor
                product={editingProduct}
                publishReady={publishReady}
                onSave={(id, input) => runAction(async () => { await adminUpdateProduct(id, input); await loadProducts(); setEditingId(null); }, 'Could not save this product.')}
                onCancel={() => setEditingId(null)}
                onChanged={loadProducts}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 mb-6">
                  <div className="min-w-0">
                    <h1 className="text-xl font-semibold text-bone">Products</h1>
                    <p className="mt-0.5 text-[12px] text-grey">Catalog, colours, sizes and per-colour stock.</p>
                  </div>
                  <button
                    onClick={() => setCreating(true)}
                    className="inline-flex items-center gap-1.5 bg-bone text-white text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-2 hover:bg-ink transition-colors rounded ml-auto"
                  >
                    <Plus size={14} strokeWidth={2} /> New Product
                  </button>
                </div>
                <ProductList
                  products={products}
                  onEdit={(id) => setEditingId(id)}
                  onCreate={() => setCreating(true)}
                  onDelete={(id) => runAction(async () => { await adminDeleteProduct(id); await loadProducts(); const warning = latestImageCleanupWarning(); if (warning) throw new Error(warning); }, 'Could not delete this product.')}
                />
              </>
            )
          )}

          {tab === 'hero' && (
            creating ? (
              <HeroForm
                onSave={(slide) => runAction(async () => { await adminCreateHero(slide); await loadHero(); setCreating(false); }, 'Could not create this slide.')}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 mb-6">
                  <div className="min-w-0">
                    <h1 className="text-xl font-semibold text-bone">Homepage</h1>
                    <p className="mt-0.5 text-[12px] text-grey">Hero slides shown on the storefront.</p>
                  </div>
                  <button
                    onClick={() => setCreating(true)}
                    className="inline-flex items-center gap-1.5 bg-bone text-white text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-2 hover:bg-ink transition-colors rounded ml-auto"
                  >
                    <Plus size={14} strokeWidth={2} /> New Slide
                  </button>
                </div>
                <HeroList
                  slides={heroSlides}
                  onUpdate={(id, patch) => runAction(async () => { await adminUpdateHero(id, patch); await loadHero(); const warning = latestImageCleanupWarning(); if (warning) throw new Error(warning); }, 'Could not save this slide.')}
                  onDelete={(id) => runAction(async () => { await adminDeleteHero(id); await loadHero(); const warning = latestImageCleanupWarning(); if (warning) throw new Error(warning); }, 'Could not delete this slide.')}
                />
              </>
            )
          )}

          {tab === 'settings' && <SettingsPanel />}

          {tab === 'orders' && <RetailOrdersPanel />}

          {tab === 'promos' && <PromoPanel />}

          {tab === 'overview' && (
            <OverviewSection
              range={dashRange}
              onRange={setDashRange}
              onOpenOrders={() => setTab('orders')}
              onOpenInventory={() => setTab('inventory')}
              onOpenAnalytics={() => setTab('analytics')}
              onOpenActivity={() => setTab('activity')}
            />
          )}

          {tab === 'inventory' && <InventorySection />}

          {tab === 'purchasing' && <PurchasingSection />}

          {tab === 'customers' && <CustomersSection />}

          {tab === 'shipping' && <ShippingSection onOpenOrders={() => setTab('orders')} />}

          {tab === 'analytics' && <AnalyticsSection />}

          {tab === 'activity' && <ActivitySection />}

          {tab === 'collections' && <CollectionsSection onOpenProducts={() => setTab('products')} />}
        </div>
      </div>
    </div>
  );
}

/* ---- Product List ---- */

function ProductList({
  products,
  onEdit,
  onDelete,
  onCreate,
}: {
  products: CatalogProduct[] | null;
  onEdit: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onCreate: () => void;
}) {
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirm();
  if (products === null) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="text-center py-24 border border-line rounded bg-white">
        <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No products yet</p>
        <p className="mt-3 text-sm text-grey">Create your first product to get started.</p>
        <button
          onClick={onCreate}
          className="mt-6 inline-flex items-center gap-1.5 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-2.5 rounded hover:bg-ink transition-colors"
        >
          <Plus size={14} strokeWidth={2} /> Create Product
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 sm:space-y-3">
      {products.map((p) => {
        const primary = p.colors[0];
        const isPublished = p.published !== false;
        const visibleToShoppers = isRetailVisible(p);
        const retailPrice = getRetailPrice(p);
        const mrp = getMrp(p);
        return (
          <div
            key={p.id}
            className={`bg-white border border-line rounded hover:border-line-2 transition-colors overflow-hidden ${!isPublished ? 'opacity-70' : ''}`}
          >
            <div className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4">
              <div className="w-12 sm:w-14 aspect-[4/5] shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
                {primary && primary.images[0] && (
                  <img src={primary.images[0]} alt={p.name} className="w-full h-full object-cover" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-bone truncate">{p.name}</h3>
                <p className="text-[11px] uppercase tracking-wide-2 text-grey mt-0.5">{p.code}</p>
                <div className="mt-1 flex items-center gap-2 text-xs text-bone-soft flex-wrap">
                  <span className="font-medium">{formatPrice(retailPrice)}</span>
                  {mrp !== null && mrp > retailPrice && (
                    <span className="text-grey line-through">{formatPrice(mrp)}</span>
                  )}
                  <span className="text-grey">·</span>
                  <span>{p.colors.length} colors</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {isPublished ? (
                    visibleToShoppers ? (
                      <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-green-600/10 text-green-700 px-2 py-0.5 rounded">Visible</span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded">Published · Hidden Online</span>
                    )
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-grey/15 text-grey px-2 py-0.5 rounded">Hidden</span>
                  )}
                  {p.featured && (
                    <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-bone/10 text-bone px-2 py-0.5 rounded">Featured</span>
                  )}
                  {p.new_drop && (
                    <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-bone/10 text-bone px-2 py-0.5 rounded">New Drop</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => onEdit(p.id)}
                  className="text-[10px] sm:text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone transition-colors px-2.5 sm:px-3 py-1.5 sm:py-2 border border-line rounded hover:border-bone"
                >
                  Edit
                </button>
                <button
                  onClick={() => requestConfirm({
                    title: 'Delete product',
                    message: `Deleting "${p.name}" removes it from the store. This cannot be undone.`,
                    confirmLabel: 'Delete',
                    onConfirm: () => onDelete(p.id),
                  })}
                  className="text-grey hover:text-bone transition-colors p-1.5 sm:p-2"
                  aria-label="Delete product"
                >
                  <Trash2 size={15} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {confirmDialog}
    </div>
  );
}

/* ---- Product Create Form ---- */

function ProductForm({
  onSave,
  onCancel,
  publishReady,
}: {
  onSave: (input: ProductInput) => Promise<void>;
  onCancel: () => void;
  publishReady: boolean;
}) {
  const [form, setForm] = useState<ProductInput>({
    slug: '',
    name: '',
    code: '',
    category: 'tee',
    featured: true,
    published: true,
    new_drop: false,
    sort_order: 99,
    price: null,
    mrp: null,
    retail_visible: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.slug || !form.name || !form.code) {
      setError('Slug, name, and code are required.');
      return;
    }
    if (form.price !== null && form.price !== undefined && (!Number.isFinite(form.price) || form.price < 0)) {
      setError('Price must be a non-negative number.');
      return;
    }
    if (!(Number(form.price ?? 0) > 0)) {
      setError('Set a retail price to make a product sellable online.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Failed to create product'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5 bg-white border border-line rounded p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl sm:text-2xl tracking-wide-2 text-bone uppercase">New Product</h2>
        <button type="button" onClick={onCancel} className="text-grey hover:text-bone transition-colors">
          <X size={20} />
        </button>
      </div>

      <div>
        <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey font-semibold mb-3 border-b border-line pb-2">Product</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="Slug" hint="URL-friendly, no spaces">
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="fallen-halo-tee" className={inputCls} />
          </Field>
          <Field label="Product Name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Fallen Halo Tee" className={inputCls} />
          </Field>
          <Field label="Code">
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="DSL-FH-01" className={inputCls} />
          </Field>
          <Field label="Category">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls}>
              <option value="tee">Tee</option>
              <option value="hoodie">Hoodie</option>
              <option value="jogger">Jogger</option>
              <option value="tank">Tank</option>
              <option value="drop">Drop</option>
            </select>
          </Field>
        </div>
      </div>

      <div>
        <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey font-semibold mb-3 border-b border-line pb-2">Pricing</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="MRP" hint="Original / strikethrough price">
            <NumInput value={form.mrp} onChange={(n) => setForm({ ...form, mrp: n })} className={inputCls} placeholder="—" />
          </Field>
          <Field label="Offer Price" hint="Online selling price per piece">
            <NumInput value={form.price} onChange={(n) => setForm({ ...form, price: n })} className={inputCls} placeholder="—" />
          </Field>
        </div>
      </div>

      <div>
        <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey font-semibold mb-3 border-b border-line pb-2">Status</h3>
        <Field label="Sort Order">
          <NumInput value={form.sort_order} onChange={(n) => setForm({ ...form, sort_order: n ?? 0 })} className={inputCls} />
        </Field>
        <div className="flex items-end gap-4 flex-wrap mt-3">
          {publishReady && (
            <label className="flex items-end gap-2">
              <input type="checkbox" checked={form.published} onChange={(e) => setForm({ ...form, published: e.target.checked })} className="w-4 h-4 accent-bone" />
              <span className="text-sm text-bone-dim">Published</span>
            </label>
          )}
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} className="w-4 h-4 accent-bone" />
            <span className="text-sm text-bone-dim">Featured on homepage</span>
          </label>
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.new_drop} onChange={(e) => setForm({ ...form, new_drop: e.target.checked })} className="w-4 h-4 accent-bone" />
            <span className="text-sm text-bone-dim">New Drop</span>
          </label>
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.retail_visible} onChange={(e) => setForm({ ...form, retail_visible: e.target.checked })} className="w-4 h-4 accent-bone" />
            <span className="text-sm text-bone-dim">Visible in online store</span>
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-ink transition-colors disabled:opacity-50">
          <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Create Product'}
        </button>
        <button type="button" onClick={onCancel} className="text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-bone transition-colors px-4 py-3">
          Cancel
        </button>
      </div>
      <p className="text-xs text-grey pt-2 border-t border-line">
        After creating, add colors with images, then add sizes and set per-color stock. Buyers shop retail per piece, with inventory tracked for every colour and size.
      </p>
    </form>
  );
}

/* ---- Product Editor (existing product) ---- */

function ProductEditor({
  product,
  onSave,
  onCancel,
  onChanged,
  publishReady,
}: {
  product: CatalogProduct;
  onSave: (id: string, input: Partial<ProductInput>) => Promise<void>;
  onCancel: () => void;
  onChanged: () => Promise<void>;
  publishReady: boolean;
}) {
  const [form, setForm] = useState<Partial<ProductInput>>({
    slug: product.slug,
    name: product.name,
    code: product.code,
    category: product.category,
    featured: product.featured,
    published: product.published !== false,
    new_drop: product.new_drop === true,
    retail_visible: product.retail_visible !== false,
    sort_order: product.sort_order,
    price: Number(product.price ?? 0) > 0 ? Number(product.price ?? 0) : null,
    mrp: Number(product.mrp ?? 0) > 0 ? Number(product.mrp ?? 0) : null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.slug || !form.name || !form.code) {
      setError('Slug, name, and code are required.');
      return;
    }
    if (form.price !== null && form.price !== undefined && (!Number.isFinite(form.price) || form.price < 0)) {
      setError('Price must be a non-negative number.');
      return;
    }
    const willPublish = form.published ?? product.published !== false;
    if (willPublish && !(Number(form.price ?? 0) > 0)) {
      setError('Set a retail price — published products must be sellable online.');
      return;
    }
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await onSave(product.id, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Failed to save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-5 bg-white border border-line rounded p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl sm:text-2xl tracking-wide-2 text-bone uppercase">Edit Product</h2>
          <button type="button" onClick={onCancel} className="text-grey hover:text-bone transition-colors">
            <X size={20} />
          </button>
        </div>

        <div>
          <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey font-semibold mb-3 border-b border-line pb-2">Product</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Field label="Slug" hint="Cannot be changed after creation">
              <input value={form.slug ?? ''} disabled className={inputCls + ' opacity-60 cursor-not-allowed'} />
            </Field>
            <Field label="Product Name">
              <input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Code">
              <input value={form.code ?? ''} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Category">
              <select value={form.category ?? 'tee'} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls}>
                <option value="tee">Tee</option>
                <option value="hoodie">Hoodie</option>
                <option value="jogger">Jogger</option>
                <option value="tank">Tank</option>
                <option value="drop">Drop</option>
              </select>
            </Field>
          </div>
        </div>

      <div>
          <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey font-semibold mb-3 border-b border-line pb-2">Pricing</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Field label="MRP" hint="Original / strikethrough price">
              <NumInput value={form.mrp ?? null} onChange={(n) => setForm({ ...form, mrp: n })} className={inputCls} placeholder="—" />
            </Field>
            <Field label="Offer Price" hint="Online selling price per piece">
              <NumInput value={form.price ?? null} onChange={(n) => setForm({ ...form, price: n })} className={inputCls} placeholder="—" />
            </Field>
          </div>
        </div>

      <div>
          <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey font-semibold mb-3 border-b border-line pb-2">Status</h3>
          <Field label="Sort Order">
            <NumInput value={form.sort_order ?? 0} onChange={(n) => setForm({ ...form, sort_order: n ?? 0 })} className={inputCls} />
          </Field>
          <div className="flex items-end gap-4 flex-wrap mt-3">
{publishReady && (
            <label className="flex items-end gap-2">
              <input type="checkbox" checked={form.published ?? true} onChange={(e) => setForm({ ...form, published: e.target.checked })} className="w-4 h-4 accent-bone" />
              <span className="text-sm text-bone-dim">Published</span>
            </label>
          )}
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.featured ?? false} onChange={(e) => setForm({ ...form, featured: e.target.checked })} className="w-4 h-4 accent-bone" />
            <span className="text-sm text-bone-dim">Featured</span>
          </label>
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.new_drop ?? false} onChange={(e) => setForm({ ...form, new_drop: e.target.checked })} className="w-4 h-4 accent-bone" />
            <span className="text-sm text-bone-dim">New Drop</span>
          </label>
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.retail_visible ?? true} onChange={(e) => setForm({ ...form, retail_visible: e.target.checked })} className="w-4 h-4 accent-bone" />
            <span className="text-sm text-bone-dim">Visible in online store</span>
          </label>
        </div>
      </div>

        {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

        <div className="flex items-center gap-3 pt-2">
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-ink transition-colors disabled:opacity-50">
            <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Save Changes'}
          </button>
          {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
          <button type="button" onClick={onCancel} className="text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-bone transition-colors px-4 py-3 ml-auto">
            Back to list
          </button>
        </div>
      </form>

      {/* Colors section */}
      <ColorManager product={product} onChanged={onChanged} />

      {/* Inventory / Stock */}
      <InventoryManager product={product} onChanged={onChanged} />

      {/* Color priority */}
      <ColorPriorityManager product={product} onChanged={onChanged} />
    </div>
  );
}

/* ---- Color Manager ---- */

function ColorManager({ product, onChanged }: { product: CatalogProduct; onChanged: () => Promise<void> }) {
  const colors = product.colors;
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirm();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newHex, setNewHex] = useState('#000000');
  const [newImages, setNewImages] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [ratioWarning, setRatioWarning] = useState('');

  const handleImagePick = async (files: FileList | null) => {
    const picked = Array.from(files ?? []);
    if (picked.length === 0) return;
    setRatioWarning('');
    const bad = await checkImageAspectRatios(picked);
    if (bad.length > 0) {
      setRatioWarning(`This image isn't quite 4:5 — it may not display perfectly: ${bad.join(', ')}`);
    }
    setUploading(true);
    setUploadError('');
    try {
      const urls = await Promise.all(
        picked.map((file) => uploadProductImage(file, product.id, newName || 'default'))
      );
      const combined = [...new Set([...newImages.split('\n').map((s) => s.trim()).filter(Boolean), ...urls])].join('\n');
      setNewImages(combined);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Upload failed'));
    } finally {
      setUploading(false);
    }
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setUploadError('');
    try {
      const imgs = newImages.split('\n').map((s) => s.trim()).filter(Boolean);
      const created = await adminAddColor(product.id, newName.trim(), newHex.trim(), imgs);
      // Seed zero-stock variant rows so every existing size gets a cell for
      // this new colour (the inventory grid covers the full color × size set).
      const existingSizes = sortSizeLabels(
        Array.from(
          new Set<string>(
            product.colors.flatMap((c) =>
              product.sizes
                .filter((s) => s.color_id === c.id)
                .map((s) => s.size_label)
            )
          )
        )
      );
      await adminBulkSetSizeStock(
        existingSizes.map((label) => ({ productId: product.id, colorId: created.id, sizeLabel: label, stock: 0 }))
      );
      setNewName(''); setNewHex('#000000'); setNewImages(''); setAdding(false);
      await onChanged();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not add this color.'));
    } finally {
      setBusy(false);
    }
  };

  const deleteColorNow = async (id: string) => {
    setUploadError('');
    try {
      await adminDeleteColor(id);
      await onChanged();
      const warning = latestImageCleanupWarning();
      if (warning) setUploadError(warning);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not delete this color.'));
    }
  };

  const handleDeleteColor = (id: string) => {
    requestConfirm({
      title: 'Delete color',
      message: 'Delete this color and all its images? This cannot be undone.',
      confirmLabel: 'Delete',
      onConfirm: () => void deleteColorNow(id),
    });
  };

  const handleSaveColor = async (id: string, name: string, hex: string, images: string[]) => {
    setUploadError('');
    try {
      await adminUpdateColor(id, { name: name.trim(), hex: hex.trim(), images });
      await onChanged();
      const warning = latestImageCleanupWarning();
      if (warning) setUploadError(warning);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not save this color.'));
    }
  };

  return (
    <div className="bg-white border border-line rounded p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-lg sm:text-xl tracking-wide-2 text-bone uppercase">Colors & Images</h3>
        <button
          onClick={() => setAdding(!adding)}
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold text-bone hover:text-bone-dim transition-colors"
        >
          <Plus size={14} strokeWidth={2} /> Add Color
        </button>
      </div>

      {adding && (
        <div className="mb-4 border border-line rounded p-3 sm:p-4 bg-paper-2 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Color name (e.g. Black)" className={inputCls} />
            <div className="flex items-center gap-2">
              <input type="color" value={newHex} onChange={(e) => setNewHex(e.target.value)} className="w-12 h-10 border border-line rounded cursor-pointer shrink-0" />
              <input value={newHex} onChange={(e) => setNewHex(e.target.value)} className={inputCls} />
            </div>
          </div>
          <textarea value={newImages} onChange={(e) => setNewImages(e.target.value)} placeholder="Image URLs (one per line)" rows={3} className={inputCls} />
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="inline-flex items-center justify-center gap-2 border border-line text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded text-bone-dim hover:border-bone-dim hover:text-bone transition-colors cursor-pointer">
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleImagePick(e.target.files)} />
              {uploading ? 'Uploading…' : 'Upload Image'}
            </label>
            <button onClick={handleAdd} disabled={busy || !newName.trim()} className="bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded hover:bg-ink disabled:opacity-50">
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button onClick={() => setAdding(false)} className="text-[11px] uppercase tracking-wide-2 text-bone-dim px-4 py-2">Cancel</button>
          </div>
          {ratioWarning && <p className="text-sm text-amber-600">{ratioWarning}</p>}
          <p className="text-xs text-grey">New colours automatically get a 0-stock row for every size already set on this product.</p>
        </div>
      )}

      {uploadError && (
        <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded mb-4">{uploadError}</p>
      )}

      <div className="space-y-4">
        {colors.map((c) => (
          <ColorRow
            key={c.id}
            color={c}
            onDelete={() => handleDeleteColor(c.id)}
            onSave={(name, hex, images) => handleSaveColor(c.id, name, hex, images)}
          />
        ))}
        {colors.length === 0 && <p className="text-sm text-grey">No colors yet. Add one with images.</p>}
      </div>
      {confirmDialog}
    </div>
  );
}

function ColorRow({ color, onDelete, onSave }: {
  color: ProductColorRow;
  onDelete: () => void;
  onSave: (name: string, hex: string, images: string[]) => Promise<void>;
}) {
  const [name, setName] = useState(color.name);
  const [hex, setHex] = useState(color.hex);
  const [images, setImages] = useState<string[]>(color.images);
  const [imageUrl, setImageUrl] = useState('');
  const [selectedImage, setSelectedImage] = useState<string | null>(color.images[0] ?? null);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [ratioWarning, setRatioWarning] = useState('');

  const moveImage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= images.length) return;
    setImages((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const removeImage = (image: string) => {
    setImages((current) => current.filter((item) => item !== image));
    if (selectedImage === image) setSelectedImage(images.find((item) => item !== image) ?? null);
  };

  const addImageUrl = () => {
    const nextUrl = imageUrl.trim();
    if (!nextUrl || images.includes(nextUrl)) return;
    setImages((current) => [...current, nextUrl]);
    setImageUrl('');
  };

  const handleSave = async () => {
    setSaving(true);
    setUploadError('');
    try {
      await onSave(name, hex, images);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not save image changes.'));
    } finally {
      setSaving(false);
    }
  };

  const handlePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setRatioWarning('');
    const bad = await checkImageAspectRatios(files);
    if (bad.length > 0) {
      setRatioWarning(`This image isn't quite 4:5 — it may not display perfectly: ${bad.join(', ')}`);
    }
    setUploading(true);
    setUploadError('');
    try {
      const uploadedUrls = await Promise.all(
        files.map((file) => uploadProductImage(file, color.product_id, name || 'color'))
      );
      setImages((current) => [...new Set([...current, ...uploadedUrls])]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Upload failed'));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  return (
    <div className="border border-line rounded">
      <div className="flex items-center gap-3 p-3">
        <div className="w-8 h-8 rounded border border-line shrink-0" style={{ backgroundColor: hex }} />
        <span className="text-sm font-medium text-bone flex-1">{name}</span>
        <span className="text-xs text-grey">{color.images.length} imgs</span>
        <button onClick={() => setExpanded(!expanded)} className="text-grey hover:text-bone p-1">
          <ChevronDown size={16} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        <button onClick={onDelete} className="text-grey hover:text-bone p-1">
          <Trash2 size={15} />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-line p-3 sm:p-4 space-y-3 bg-paper-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            <div className="flex items-center gap-2">
              <input type="color" value={hex} onChange={(e) => setHex(e.target.value)} className="w-10 h-9 border border-line rounded cursor-pointer shrink-0" />
              <input value={hex} onChange={(e) => setHex(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="flex gap-2">
            <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addImageUrl(); } }} placeholder="Paste an image URL" className={inputCls} />
            <button type="button" onClick={addImageUrl} className="shrink-0 border border-line px-3 text-[11px] font-semibold uppercase tracking-wide-2 text-bone-dim hover:border-bone-dim">Add URL</button>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="inline-flex items-center justify-center gap-2 border border-line text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded text-bone-dim hover:border-bone-dim hover:text-bone transition-colors cursor-pointer">
              <input type="file" accept="image/*" multiple className="hidden" onChange={handlePick} />
              {uploading ? 'Uploading…' : 'Upload Image'}
            </label>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded hover:bg-ink transition-colors disabled:opacity-50"
            >
              <Save size={14} /> {saving ? 'Saving…' : 'Save Color'}
            </button>
            {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
          </div>
          {uploadError && <p className="text-sm text-crimson">{uploadError}</p>}
          {ratioWarning && <p className="text-sm text-amber-600">{ratioWarning}</p>}
          {images.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {images.map((img, index) => (
                <div key={img} className={`relative aspect-[4/5] overflow-hidden border bg-paper-3 ${selectedImage === img ? 'border-bone ring-1 ring-bone' : 'border-line'}`}>
                  <button type="button" onClick={() => { setSelectedImage(img); setIsImageViewerOpen(true); }} className="absolute inset-0 cursor-zoom-in" aria-label={`Zoom image ${index + 1}`}>
                    <img src={img} alt={`${name} ${index + 1}`} className="h-full w-full object-cover" />
                  </button>
                  {index === 0 && <span className="absolute left-1 top-1 bg-bone px-1.5 py-1 text-[8px] font-semibold uppercase tracking-wide-2 text-white">Primary</span>}
                  <div className="absolute inset-x-0 bottom-0 flex justify-between bg-bone/85 p-1 text-white">
                    <button type="button" disabled={index === 0} onClick={() => moveImage(index, -1)} className="px-1.5 text-xs disabled:opacity-30" aria-label="Move image earlier">←</button>
                    <button type="button" onClick={() => removeImage(img)} className="px-1.5 text-xs hover:text-bone" aria-label="Remove image"><Trash2 size={13} /></button>
                    <button type="button" disabled={index === images.length - 1} onClick={() => moveImage(index, 1)} className="px-1.5 text-xs disabled:opacity-30" aria-label="Move image later">→</button>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-grey">Upload or add an image URL. The first image becomes the primary product image.</p>}
          {selectedImage && (
            <div className="rounded border border-line bg-white p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Selected image preview</p>
                <button type="button" onClick={() => setIsImageViewerOpen(true)} className="text-[10px] font-semibold uppercase tracking-wide-2 text-bone hover:text-bone-dim">Open full size</button>
              </div>
              <img src={selectedImage} alt={`${name} selected`} className="max-h-80 w-full bg-paper-3 object-contain" />
            </div>
          )}
          {isImageViewerOpen && selectedImage && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" onClick={() => setIsImageViewerOpen(false)} role="dialog" aria-modal="true" aria-label="Enlarged product image">
              <button type="button" onClick={() => setIsImageViewerOpen(false)} className="absolute right-4 top-4 rounded-full bg-white/15 p-3 text-white hover:bg-white/25" aria-label="Close image viewer"><X size={18} /></button>
              <img src={selectedImage} alt={`${name} enlarged`} className="max-h-full max-w-full object-contain" onClick={(event) => event.stopPropagation()} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---- Inventory / Stock Manager ---- */

function InventoryManager({ product, onChanged }: { product: CatalogProduct; onChanged: () => Promise<void> }) {
  const colors = product.colors;
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirm();
  const buildDrafts = (p: CatalogProduct): Record<string, Record<string, number>> => {
    const labels = new Set<string>();
    for (const c of p.colors) {
      for (const s of getSizesForColor(p, c.id)) labels.add(s.size_label);
    }
    const sortedLabels = sortSizeLabels([...labels]);
    const out: Record<string, Record<string, number>> = {};
    for (const c of p.colors) {
      const row: Record<string, number> = {};
      for (const label of sortedLabels) {
        const found = p.sizes.find((s) => s.color_id === c.id && s.size_label === label);
        row[label] = Math.max(0, Math.floor(Number(found?.stock ?? 0)));
      }
      out[c.id] = row;
    }
    return out;
  };

  const [drafts, setDrafts] = useState<Record<string, Record<string, number>>>(() => buildDrafts(product));
  const [sizeOrder, setSizeOrder] = useState<string[]>(() => sizeLabelsForRows(product.sizes));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [newSizeInput, setNewSizeInput] = useState('');
  const [sizeBusy, setSizeBusy] = useState(false);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderSaved, setOrderSaved] = useState(false);

  useEffect(() => {
    setDrafts(buildDrafts(product));
    setSizeOrder(sizeLabelsForRows(product.sizes));
    setSaved(false);
    setOrderSaved(false);
    setError('');
  }, [product]);

  const sizeLabels = sizeOrder;

  const hasSizes = sizeLabels.length > 0 && colors.length > 0;

  const handleAddSizes = async () => {
    const requested = newSizeInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (requested.length === 0 || colors.length === 0) return;
    const fresh = [...new Set(requested.filter((label) => !sizeLabels.includes(label)))];
    if (fresh.length === 0) {
      setError('That size already exists for this product.');
      return;
    }
    setSizeBusy(true);
    setError('');
    try {
      const updates: Array<{ productId: string; colorId: string; sizeLabel: string; stock: number }> = [];
      for (const c of colors) {
        for (const label of fresh) {
          updates.push({ productId: product.id, colorId: c.id, sizeLabel: label, stock: 0 });
        }
      }
      await adminBulkSetSizeStock(updates);
      setNewSizeInput('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not add this size.'));
    } finally {
      setSizeBusy(false);
    }
  };

  const removeSizeNow = async (label: string) => {
    setError('');
    try {
      await adminRemoveProductSize(product.id, label);
      setSizeOrder((prev) => prev.filter((l) => l !== label));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not remove this size.'));
    }
  };

  const handleRemoveSize = (label: string) => {
    requestConfirm({
      title: 'Delete size',
      message: `Delete size "${label}" and its stock for every colour of this product? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => void removeSizeNow(label),
    });
  };

  const moveSize = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= sizeOrder.length) return;
    setSizeOrder((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleSaveOrder = async () => {
    setOrderBusy(true);
    setError('');
    setOrderSaved(false);
    try {
      await adminSetSizeOrder(product.id, sizeOrder);
      await onChanged();
      setOrderSaved(true);
      setTimeout(() => setOrderSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not reorder sizes.'));
    } finally {
      setOrderBusy(false);
    }
  };

  const handleSave = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      // Upsert EVERY colour × size combination so the database reflects the
      // full matrix (0 stock = sold out). Missing combos become explicit rows.
      const updates: Array<{ productId: string; colorId: string; sizeLabel: string; stock: number }> = [];
      for (const c of colors) {
        for (const label of sizeLabels) {
          updates.push({ productId: product.id, colorId: c.id, sizeLabel: label, stock: drafts[c.id]?.[label] ?? 0 });
        }
      }
      await adminBulkSetSizeStock(updates);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not update stock.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-line rounded p-4 sm:p-6">
      <div className="mb-4">
        <h3 className="font-display text-lg sm:text-xl tracking-wide-2 text-bone uppercase">Inventory</h3>
        <p className="text-xs text-grey mt-0.5">Sizes are per product; every colour gets its own stock row. 0 means sold out.</p>
      </div>

      {colors.length === 0 ? (
        <p className="text-sm text-grey">Add colours first, then sizes and per-colour stock become available.</p>
      ) : (
        <>
          {/* Size manager */}
          <div className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold">Sizes</p>
              {sizeLabels.length > 1 && (
                <button
                  type="button"
                  onClick={() => void handleSaveOrder()}
                  disabled={orderBusy}
                  className="inline-flex items-center gap-1.5 border border-line text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-1.5 rounded text-bone-dim hover:border-bone-dim hover:text-bone transition-colors disabled:opacity-50"
                >
                  <Save size={12} /> {orderBusy ? 'Saving…' : 'Save Size Order'}
                </button>
              )}
            </div>
            {sizeLabels.length > 1 && (
              <p className="text-[10px] text-grey mb-2 -mt-1">Use the arrows to set the display order, then save. The storefront and inventory matrix follow this order.</p>
            )}
            <div className="flex flex-wrap gap-2 mb-3">
              {sizeLabels.map((label, i) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 border border-line rounded px-2 py-1.5 text-xs font-semibold uppercase tracking-wide-2 text-bone"
                >
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => moveSize(i, -1)}
                    className="text-grey hover:text-bone transition-colors disabled:opacity-25"
                    aria-label={`Move ${label} earlier`}
                  >
                    <ChevronLeft size={13} strokeWidth={2.2} />
                  </button>
                  {label}
                  <button
                    type="button"
                    disabled={i === sizeLabels.length - 1}
                    onClick={() => moveSize(i, 1)}
                    className="text-grey hover:text-bone transition-colors disabled:opacity-25"
                    aria-label={`Move ${label} later`}
                  >
                    <ChevronRight size={13} strokeWidth={2.2} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveSize(label)}
                    className="text-grey hover:text-bone transition-colors h-4"
                    aria-label={`Remove size ${label}`}
                  >
                    <X size={12} strokeWidth={2.2} />
                  </button>
                </span>
              ))}
              {sizeLabels.length === 0 && (
                <p className="text-xs text-grey w-full">No sizes yet. Add one below to start tracking stock.</p>
              )}
            </div>
            {orderSaved && <p className="text-xs text-green-600 mb-2">Size order saved.</p>}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <input
                value={newSizeInput}
                onChange={(e) => setNewSizeInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAddSizes(); } }}
                placeholder="Add size(s), e.g. S, M, 28"
                className="flex-1 min-w-0 border border-line rounded px-3 py-2 text-sm text-bone placeholder:text-grey/60 focus:border-bone focus:outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => void handleAddSizes()}
                disabled={sizeBusy || !newSizeInput.trim() || colors.length === 0}
                className="inline-flex items-center justify-center gap-1.5 border border-line text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded text-bone-dim hover:border-bone-dim hover:text-bone transition-colors disabled:opacity-50"
              >
                <Plus size={13} strokeWidth={2} /> {sizeBusy ? 'Adding…' : 'Add Size'}
              </button>
              <p className="text-[10px] text-grey">Applies to every colour above. You can list several at once.</p>
            </div>
          </div>

          {hasSizes ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="text-left text-[10px] font-semibold uppercase tracking-wide-2 text-grey py-2 pr-3">Color</th>
                      {sizeLabels.map((label) => (
                        <th key={label} className="text-center text-[10px] font-semibold uppercase tracking-wide-2 text-grey py-2 px-2">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {colors.map((c) => (
                      <tr key={c.id} className="border-b border-line last:border-b-0">
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <span className="w-5 h-5 rounded border border-line shrink-0" style={{ backgroundColor: c.hex }} />
                            <span className="text-sm font-medium text-bone">{c.name}</span>
                          </div>
                        </td>
                        {sizeLabels.map((label) => (
                          <td key={label} className="py-2 px-2">
                            <NumInput
                              value={drafts[c.id]?.[label] ?? 0}
                              onChange={(n) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [c.id]: { ...(prev[c.id] ?? {}), [label]: Math.max(0, Math.floor(Number(n ?? 0))) },
                                }))
                              }
                              min={0}
                              className="w-full max-w-[4.5rem] bg-white border border-line px-2.5 py-2 text-sm text-center text-bone focus:border-bone focus:outline-none rounded"
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-grey mt-2">0 means sold out. Stock is tracked separately for every product colour and size.</p>
              <div className="flex items-center gap-3 pt-3">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-2.5 rounded hover:bg-ink transition-colors disabled:opacity-50"
                >
                  <Save size={14} /> {busy ? 'Saving…' : 'Save Stock'}
                </button>
                {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
                {error && <span className="text-sm text-crimson">{error}</span>}
              </div>
            </>
          ) : (
            <p className="text-sm text-grey">
              Add a size above to generate its stock cells for every colour.
            </p>
          )}
          {confirmDialog}
        </>
      )}
    </div>
  );
}

/* ---- Color Priority Manager ---- */

function ColorPriorityManager({ product, onChanged }: { product: CatalogProduct; onChanged: () => Promise<void> }) {
  const [orderedColors, setOrderedColors] = useState<ProductColorRow[]>(() =>
    [...product.colors].sort((a, b) => a.sort_order - b.sort_order)
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const touchStartY = useRef<number>(0);
  const touchCurrentY = useRef<number>(0);
  const touchDragEl = useRef<HTMLDivElement | null>(null);
  const touchClone = useRef<HTMLDivElement | null>(null);
  const touchStartIdx = useRef<number>(0);

  useEffect(() => {
    setOrderedColors([...product.colors].sort((a, b) => a.sort_order - b.sort_order));
  }, [product.colors]);

  const handleDragStart = (index: number) => {
    dragItem.current = index;
  };

  const handleDragEnter = (index: number) => {
    dragOverItem.current = index;
  };

  const handleDragEnd = () => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    if (dragItem.current === dragOverItem.current) { dragItem.current = null; dragOverItem.current = null; return; }
    setOrderedColors((prev) => {
      const next = [...prev];
      const [removed] = next.splice(dragItem.current!, 1);
      next.splice(dragOverItem.current!, 0, removed);
      return next;
    });
    dragItem.current = null;
    dragOverItem.current = null;
  };

  const handleTouchStart = (e: React.TouchEvent, index: number) => {
    touchStartIdx.current = index;
    touchStartY.current = e.touches[0].clientY;
    touchCurrentY.current = e.touches[0].clientY;
    const target = e.currentTarget.closest('[data-color-row]') as HTMLDivElement | undefined;
    if (target) {
      touchDragEl.current = target;
      const rect = target.getBoundingClientRect();
      const clone = target.cloneNode(true) as HTMLDivElement;
      clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:9999;opacity:0.85;pointer-events:none;transition:none;`;
      clone.classList.add('touch-drag-clone');
      document.body.appendChild(clone);
      touchClone.current = clone;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    touchCurrentY.current = e.touches[0].clientY;
    if (touchClone.current && touchDragEl.current) {
      const rect = touchDragEl.current.getBoundingClientRect();
      const dy = touchCurrentY.current - touchStartY.current;
      touchClone.current.style.top = `${rect.top + dy}px`;
    }
    const el = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
    if (el) {
      const row = el.closest('[data-color-row]') as HTMLDivElement | null;
      if (row) {
        const overIdx = Number(row.dataset.colorIndex);
        if (!isNaN(overIdx)) dragOverItem.current = overIdx;
      }
    }
  };

  const handleTouchEnd = () => {
    if (touchClone.current) {
      touchClone.current.remove();
      touchClone.current = null;
    }
    touchDragEl.current = null;
    if (touchStartIdx.current === dragOverItem.current || dragOverItem.current === null) {
      dragOverItem.current = null;
      return;
    }
    setOrderedColors((prev) => {
      const next = [...prev];
      const [removed] = next.splice(touchStartIdx.current, 1);
      next.splice(dragOverItem.current!, 0, removed);
      return next;
    });
    dragOverItem.current = null;
  };

  const moveColor = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= orderedColors.length) return;
    setOrderedColors((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const saveOrder = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await adminUpdateColorSortOrders(product.id, orderedColors.map((c) => c.id));
      await onChanged();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not save color order.'));
    } finally {
      setBusy(false);
    }
  };

  if (orderedColors.length < 2) return null;

  return (
    <div className="bg-white border border-line rounded p-4 sm:p-6">
      <h3 className="font-display text-lg sm:text-xl tracking-wide-2 text-bone uppercase mb-1">Color Order</h3>
      <p className="text-xs text-grey mb-4">Drag to reorder. First color is shown as primary on product cards.</p>
      <div className="space-y-1.5">
        {orderedColors.map((c, i) => (
          <div
            key={c.id}
            data-color-row
            data-color-index={i}
            draggable
            onDragStart={() => handleDragStart(i)}
            onDragEnter={() => handleDragEnter(i)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => e.preventDefault()}
            onTouchStart={(e) => handleTouchStart(e, i)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className={`flex items-center gap-3 px-3 py-2.5 bg-paper-2 border border-line rounded cursor-grab active:cursor-grabbing select-none transition-colors ${
              dragItem.current === i ? 'opacity-50' : ''
            }`}
          >
            <span className="text-xs text-grey font-mono w-5 text-center shrink-0">{i + 1}</span>
            <GripVertical size={16} className="text-grey/50 shrink-0" />
            <div className="w-6 h-6 rounded border border-line shrink-0" style={{ backgroundColor: c.hex }} />
            <span className="text-sm font-medium text-bone flex-1 truncate">{c.name}</span>
            <div className="flex items-center gap-0.5 shrink-0">
              <button type="button" disabled={i === 0} onClick={() => moveColor(i, -1)} className="text-grey hover:text-bone p-1 disabled:opacity-25" aria-label="Move up">
                <ChevronDown size={14} className="rotate-90" />
              </button>
              <button type="button" disabled={i === orderedColors.length - 1} onClick={() => moveColor(i, 1)} className="text-grey hover:text-bone p-1 disabled:opacity-25" aria-label="Move down">
                <ChevronDown size={14} className="-rotate-90" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          onClick={saveOrder}
          disabled={busy}
          className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-ink transition-colors disabled:opacity-50"
        >
          <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Save Color Order'}
        </button>
        {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
        {error && <span className="text-sm text-crimson">{error}</span>}
      </div>
    </div>
  );
}

/* ---- Hero Slide List ---- */

function HeroList({
  slides,
  onUpdate,
  onDelete,
}: {
  slides: HeroSlideRow[] | null;
  onUpdate: (id: string, patch: Partial<Omit<HeroSlideRow, 'id' | 'created_at'>>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  if (slides === null) {
    return <div className="h-32 bg-paper-3 border border-line rounded animate-pulse" />;
  }

  if (slides.length === 0) {
    return (
      <div className="text-center py-24 border border-line rounded bg-white">
        <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No hero slides</p>
        <p className="mt-3 text-sm text-grey">Add a slide to show on the homepage hero.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {slides.map((s) => (
        <HeroRow key={s.id} slide={s} onUpdate={(patch) => onUpdate(s.id, patch)} onDelete={() => onDelete(s.id)} />
      ))}
    </div>
  );
}

function HeroRow({
  slide,
  onUpdate,
  onDelete,
}: {
  slide: HeroSlideRow;
  onUpdate: (patch: Partial<Omit<HeroSlideRow, 'id' | 'created_at'>>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [image_url, setImageUrl] = useState(slide.image_url);
  const [sort_order, setSortOrder] = useState(slide.sort_order);
  const [active, setActive] = useState(slide.active);
  const [expanded, setExpanded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirm();

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const url = await uploadHeroImage(file);
      // Verify the uploaded asset is actually reachable before swapping the
      // slide's image, so the existing image is kept on any failure and the
      // preview never flashes while the new file streams in.
      await preloadImage(url);
      setImageUrl(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Upload failed'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const save = async () => {
    await onUpdate({ image_url, sort_order, active });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="bg-white border border-line rounded overflow-hidden">
      <div className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4">
        <div className="w-14 sm:w-20 h-10 sm:h-14 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
          {image_url && <img src={image_url} alt="Hero slide preview" className="w-full h-full object-cover" />}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-bone truncate">Hero Slide #{sort_order}</h3>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[9px] sm:text-[10px] uppercase tracking-wide-2 font-semibold px-1.5 sm:px-2 py-0.5 sm:py-1 rounded ${
            active ? 'bg-green-100 text-green-700' : 'bg-paper-2 text-grey'
          }`}>
            {active ? 'Active' : 'Hidden'}
          </span>
          <span className="text-[10px] sm:text-xs text-grey hidden sm:inline">Order: {sort_order}</span>
          <button onClick={() => setExpanded(!expanded)} className="text-grey hover:text-bone p-1">
            <ChevronDown size={15} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <button
            onClick={() => requestConfirm({
              title: 'Delete slide',
              message: 'Delete this slide from the homepage? This cannot be undone.',
              confirmLabel: 'Delete',
              onConfirm: onDelete,
            })}
            className="text-grey hover:text-bone p-1"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-line p-3 sm:p-4 bg-paper-2 space-y-3">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <div className="w-28 h-20 sm:w-36 sm:h-24 border border-line rounded overflow-hidden bg-paper-3">
                {image_url ? (
                  <img src={image_url} alt="Preview" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-grey text-xs">No image</div>
                )}
              </div>
            </div>
            <div className="flex-1 min-w-0 space-y-2">
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleUpload} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold px-3 py-2 border border-line text-bone-dim hover:border-bone-dim hover:text-bone rounded transition-colors disabled:opacity-50"
              >
                <Upload size={13} strokeWidth={2} /> {uploading ? 'Uploading…' : 'Upload Image'}
              </button>
              {uploadError && <p className="text-xs text-crimson">{uploadError}</p>}
            </div>
          </div>
          <Field label="Image URL">
            <input value={image_url} onChange={(e) => setImageUrl(e.target.value)} className={inputCls} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Field label="Sort Order">
              <NumInput value={sort_order} onChange={(n) => setSortOrder(n ?? 0)} className={inputCls} />
            </Field>
            <label className="flex items-end gap-2 pb-3">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-bone" />
              <span className="text-sm text-bone-dim">Active (show on homepage)</span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={save} className="inline-flex items-center gap-1.5 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-ink transition-colors">
              <Save size={14} /> Save Slide
            </button>
            {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

/* ---- Hero Create Form ---- */

function HeroForm({
  onSave,
  onCancel,
}: {
  onSave: (slide: Omit<HeroSlideRow, 'id' | 'created_at'>) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    image_url: '',
    sort_order: 99,
    active: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const url = await uploadHeroImage(file);
      // Only commit the URL once the uploaded asset is confirmed reachable.
      await preloadImage(url);
      setForm((f) => ({ ...f, image_url: url }));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Upload failed'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.image_url) {
      setError('Image URL is required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Failed to create slide'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5 bg-white border border-line rounded p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl sm:text-2xl tracking-wide-2 text-bone uppercase">New Hero Slide</h2>
        <button type="button" onClick={onCancel} className="text-grey hover:text-bone transition-colors">
          <X size={20} />
        </button>
      </div>

      <div className="flex items-start gap-4">
        <div className="shrink-0">
          <div className="w-28 h-20 sm:w-36 sm:h-24 border border-line rounded overflow-hidden bg-paper-3">
            {form.image_url ? (
              <img src={form.image_url} alt="Preview" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-grey text-xs">No image</div>
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleUpload} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold px-3 py-2 border border-line text-bone-dim hover:border-bone-dim hover:text-bone rounded transition-colors disabled:opacity-50"
          >
            <Upload size={13} strokeWidth={2} /> {uploading ? 'Uploading…' : 'Upload Image'}
          </button>
          {uploadError && <p className="text-xs text-crimson">{uploadError}</p>}
        </div>
      </div>
      <Field label="Image URL">
        <input value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="https://images.pexels.com/..." className={inputCls} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <Field label="Sort Order">
          <NumInput value={form.sort_order} onChange={(n) => setForm({ ...form, sort_order: n ?? 0 })} className={inputCls} />
        </Field>
        <label className="flex items-end gap-2 pb-3">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="w-4 h-4 accent-bone" />
          <span className="text-sm text-bone-dim">Active</span>
        </label>
      </div>

      {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-ink transition-colors disabled:opacity-50">
          <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Create Slide'}
        </button>
        <button type="button" onClick={onCancel} className="text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-bone transition-colors px-4 py-3">
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ---- Shared UI helpers ---- */

function NumInput({ value, onChange, className, placeholder, ...rest }: {
  value: number | null;
  onChange: (n: number | null) => void;
  className?: string;
  placeholder?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'>) {
  const [raw, setRaw] = useState(value == null ? '' : String(value));
  const lastRef = useRef(value);

  useEffect(() => {
    if (value !== lastRef.current) {
      lastRef.current = value;
      setRaw(value == null ? '' : String(value));
    }
  }, [value]);

  const sync = (v: number | null) => {
    lastRef.current = v;
    onChange(v);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setRaw(v);
    if (v === '' || v === '-') {
      sync(null);
      return;
    }
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) sync(Math.floor(n));
  };

  const commit = () => {
    if (raw === '' || raw === '-') {
      setRaw('');
      sync(null);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setRaw(lastRef.current == null ? '' : String(lastRef.current));
      return;
    }
    const n = Math.floor(parsed);
    setRaw(String(n));
    sync(n);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={raw}
      onChange={handleChange}
      onBlur={commit}
      onWheel={(e) => e.currentTarget.blur()}
      placeholder={placeholder}
      className={className}
      {...rest}
    />
  );
}

const inputCls = 'w-full px-3 py-2.5 bg-white border border-line text-bone text-sm rounded placeholder:text-grey focus:outline-none focus:border-bone transition-colors';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wide-2 text-grey block mb-1.5">
        {label}
        {hint && <span className="ml-2 normal-case tracking-normal text-grey/70">— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

/* ---- Settings ---- */

function SettingsPanel() {
  const { settings, loaded, save } = useSiteSettings();
  const [form, setForm] = useState<SiteSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const patch = (p: Partial<SiteSettings>) => setForm((f) => ({ ...f, ...p }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await save(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not save settings.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      {!loaded && <div className="h-24 bg-paper-3 border border-line rounded animate-pulse" />}

      <div className="bg-white border border-line rounded p-4 sm:p-6 space-y-4">
        <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">Store Settings</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="Flat Shipping (₹)" hint="Charged on retail orders">
            <NumInput value={form.shipping_flat_rate} onChange={(n) => patch({ shipping_flat_rate: n ?? 0 })} className={inputCls} />
          </Field>
        </div>
      </div>

      <div className="bg-white border border-line rounded p-4 sm:p-6 space-y-4">
        <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">Contact & Storefront</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="WhatsApp Number" hint="Digits only, country code first (e.g. 9199...)">
            <input value={form.whatsapp_number} onChange={(e) => patch({ whatsapp_number: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Announcement Text">
            <input value={form.announcement_text} onChange={(e) => patch({ announcement_text: e.target.value })} className={inputCls} />
          </Field>
        </div>
        <label className="flex items-end gap-2">
          <input type="checkbox" checked={form.announcement_active} onChange={(e) => patch({ announcement_active: e.target.checked })} className="w-4 h-4 accent-bone" />
          <span className="text-sm text-bone-dim">Show announcement bar</span>
        </label>
      </div>

      {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || !loaded} className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-ink transition-colors disabled:opacity-50">
          <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
        <span className="text-xs text-grey ml-auto">These apply instantly on the live storefront.</span>
      </div>
    </form>
  );
}

/* ---- Retail Orders ---- */

function formatOrderDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/** Partially mask an address for the "Email sent to …" confirmation banner.
 *  The send-order-mail endpoint intentionally no longer echoes the address
 *  back, so the UI confirms the row it already has — masked, because the action
 *  message is echoed in a shared screen and a toast should not print a full
 *  customer address. Support can still open the order for the real value. */
function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return 'the customer';
  const head = name.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

type OrderTabKey = 'new' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

/** The manual courier + AWB form for one order. */
interface ShipForm {
  courier: string;
  /** The real courier name typed when `courier` is "Other" — we must never
   *  store the literal word "Other" as the courier. */
  courier_other: string;
  awb: string;
  tracking_url: string;
  shipping_status: string;
}

interface OrderTabDef {
  key: OrderTabKey;
  label: string;
  statuses: readonly string[];
  payments?: readonly string[];
}

/**
 * Payment states that mean "this order is confirmed and can be fulfilled".
 *
 * A NEW COD order is confirmed the moment it is placed: payment_status =
 * 'cod_pending' means nothing is owed to us online and the full amount is due
 * at the door. It is NOT an unpaid order and must never be treated as one,
 * otherwise COD orders can never be packed, shipped or delivered.
 */
const VERIFIED_PAYMENTS = ['success', 'paid', 'cod', 'cod_pending'] as const;

/**
 * A new COD order is created at 'pending' and follows the ordinary fulfillment
 * path from there. Historical money is retained in its ledger fields and does
 * not create a separate fulfilment state.
 */
const NEW_ORDER_STATUSES = ['pending'] as const;

/**
 * The COD "Collection status" shown in Admin — a FACT, not a live value.
 *
 * Delhivery does not report per-order COD collection. Both surfaces this app
 * consumes carry only the shipment lifecycle:
 *   * pull  — GET {track-server}/api/v1/packages/json/?waybill=AWB
 *             -> { ShipmentData: [ { AWB, Status: { StatusType }, Scans } ] }
 *   * push  — the Shipment webhook body, same fields
 * StatusType is the delivery outcome (DL / UD / RT / IT / NDR) and Scans carry
 * Location + timestamps. Neither has a collected / pending / failed cash flag.
 * Delhivery's COD remittance is an account-level settlement, reconciled from
 * the merchant's remittance report — not addressable per waybill.
 *
 * So until that report is the system of record, this stays a static note. It is
 * deliberately worded as a pointer to the remittance report so an operator never
 * reads "Delivered" as "the cash is in hand".
 *
 * Single source of truth: if Delhivery ever exposes a per-order collection
 * field, change THIS function (and the copy above) rather than the call site.
 */
function codCollectionNote(_o: RetailOrder): string {
  return 'Reconciled via Delhivery';
}

/** One authoritative workflow mapping — every order lands in exactly one tab. */
const ORDER_TABS: OrderTabDef[] = [
  { key: 'new', label: 'New Orders', statuses: NEW_ORDER_STATUSES, payments: VERIFIED_PAYMENTS },
  { key: 'processing', label: 'Processing', statuses: ['processing'] },
  { key: 'shipped', label: 'Shipped', statuses: ['shipped'] },
  { key: 'delivered', label: 'Delivered', statuses: ['delivered'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled', 'rto'] },
  { key: 'refunded', label: 'Refunded', statuses: ['refunded'] },
];

const UNPAID_PENDING_STATUSES = NEW_ORDER_STATUSES;

const TAB_EMPTY_TITLE: Record<OrderTabKey, string> = {
  new: 'No new orders',
  processing: 'Nothing processing',
  shipped: 'Nothing in transit',
  delivered: 'No delivered orders yet',
  cancelled: 'No cancelled orders',
  refunded: 'No refunds yet',
};

function RetailOrdersPanel() {
  const [orders, setOrders] = useState<RetailOrder[] | null>(null);
  // Order lines store no image URL; resolved from the public catalogue, the same
  // source the storefront uses, so an operator sees the same picture a customer does.
  const imageIndex = useOrderImages();
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ordersComplete, setOrdersComplete] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // --- Workflow tabs + live per-tab counts (server-computed) ---
  const [tab, setTab] = useState<OrderTabKey>('new');
  const [counts, setCounts] = useState<Record<OrderTabKey, number>>({
    new: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0,
    refunded: 0,
  });
  const [unpaidCount, setUnpaidCount] = useState(0);
  const [unpaidView, setUnpaidView] = useState(false);

  // --- Search + date range (server-side, scoped to the active view) ---
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const selectTab = (next: OrderTabKey) => {
    setTab(next);
    setUnpaidView(false);
    setExpanded(null);
  };

  /** PostgREST filter for the active view (tab + unpaid toggle + filters). */
  const activeFilter = useMemo<RetailOrderQuery>(() => {
    const def = ORDER_TABS.find((d) => d.key === tab) ?? ORDER_TABS[0];
    const filter: RetailOrderQuery = { statuses: [...def.statuses] };
    if (unpaidView) {
      filter.payments = [...VERIFIED_PAYMENTS];
      filter.excludePayments = true;
    } else if (tab === 'new') {
      // New Orders = a confirmed order still awaiting processing. Unpaid online
      // orders are surfaced separately via the "awaiting payment" view.
      //
      // 'cod_pending' is a CONFIRMED state, not an unpaid one: a COD order owes
      // its money to the delivery agent, not to us, so it belongs in New Orders
      // and must never appear in the "awaiting payment" banner.
      filter.payments = [...VERIFIED_PAYMENTS];
    }
    if (search) filter.search = search;
    // The picked dates are local calendar days; convert them to absolute
    // instants so the timestamptz comparison lines up with what the admin sees.
    if (fromDate) filter.from = new Date(`${fromDate}T00:00:00`).toISOString();
    if (toDate) filter.to = new Date(`${toDate}T23:59:59.999`).toISOString();
    return filter;
  }, [tab, unpaidView, search, fromDate, toDate]);

  const refreshCounts = useCallback(async () => {
    const [newCount, unpaid, processing, shipped, delivered, cancelled, refunded] = await Promise.all([
      adminCountRetailOrders({ statuses: [...NEW_ORDER_STATUSES], payments: [...VERIFIED_PAYMENTS] }),
      adminCountRetailOrders({ statuses: UNPAID_PENDING_STATUSES, payments: [...VERIFIED_PAYMENTS], excludePayments: true }),
      adminCountRetailOrders({ statuses: ['processing'] }),
      adminCountRetailOrders({ statuses: ['shipped'] }),
      adminCountRetailOrders({ statuses: ['delivered'] }),
      adminCountRetailOrders({ statuses: ['cancelled', 'rto'] }),
      adminCountRetailOrders({ statuses: ['refunded'] }),
    ]);
    setCounts({ new: newCount, processing, shipped, delivered, cancelled, refunded });
    setUnpaidCount(unpaid);
  }, []);

  const load = useCallback(async () => {
    setLoadError('');
    setOrdersComplete(false);
    const filter = activeFilter;
    try {
      const rows = await adminFetchRetailOrders(filter);
      setOrders(rows);
      // Counts refresh in parallel so badges stay live without blocking the list.
      void refreshCounts();
    } catch (err) {
      setOrders([]);
      setLoadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not load retail orders.'));
    }
  }, [activeFilter, refreshCounts]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    setLoadError('');
    try {
      const extra = await adminFetchRetailOrders({ ...activeFilter, offset: orders?.length ?? 0 });
      setOrders((prev) => [...(prev ?? []), ...extra]);
      if (extra.length < 100) setOrdersComplete(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not load more retail orders.'));
    } finally {
      setLoadingMore(false);
    }
  }, [activeFilter, orders]);

  // Show the loading state whenever the active view changes; then load it.
  useEffect(() => {
    setOrders(null);
  }, [tab, search, fromDate, toDate, unpaidView]);

  useEffect(() => {
    void load();
  }, [load]);

  const copyRef = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
    } catch {
      /* clipboard unavailable — the ref is still visible in the UI */
    }
  };

  const [confirmDelete, setConfirmDelete] = useState<RetailOrder | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const performDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await adminDeleteRetailOrder(confirmDelete.id);
      setOrders((prev) => (prev ?? []).filter((x) => x.id !== confirmDelete.id));
      setExpanded((cur) => (cur === confirmDelete.id ? null : cur));
      setConfirmDelete(null);
      setActionMessage('Order deleted.');
      void refreshCounts();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the order.');
    } finally {
      setDeleting(false);
    }
  };

  // Auto-dismiss the brief success message.
  useEffect(() => {
    if (!actionMessage) return;
    const t = window.setTimeout(() => setActionMessage(''), 3000);
    return () => window.clearTimeout(t);
  }, [actionMessage]);

  // --- Manual courier + AWB shipping (admin-entered, no courier API needed) ---
  // One form per order. Seeded from the stored row so it shows the truth until
  // the admin edits it; a courier or AWB typed in another tab is picked up by
  // `load()` and re-seeds the form.
  const [shipForms, setShipForms] = useState<Record<string, ShipForm>>({});
  const [savingShipId, setSavingShipId] = useState<string | null>(null);
  const [shipMsgs, setShipMsgs] = useState<Record<string, string>>({});

  const shipFormFor = (o: RetailOrder): ShipForm =>
    shipForms[o.id] ?? {
      courier: o.courier_name ?? '',
      // A stored courier that is not one of our options IS the typed name, so
      // an "Other" shipment reopens showing what it actually says.
      courier_other: COURIER_OPTIONS.includes(o.courier_name as (typeof COURIER_OPTIONS)[number]) ? '' : o.courier_name ?? '',
      awb: awbOf(o),
      tracking_url: o.tracking_url ?? '',
      shipping_status: shippingStatusOf(o),
    };

  const setShipForm = (id: string, current: ShipForm, patch: Partial<ShipForm>) => {
    setShipForms((prev) => ({ ...prev, [id]: { ...current, ...patch } }));
  };

  /** What actually gets stored: the option, or the name typed behind "Other". */
  const courierToSave = (form: ShipForm): string =>
    (form.courier === 'Other' ? form.courier_other : form.courier).trim();

  const saveShipping = useCallback(
    async (o: RetailOrder) => {
      const form = shipFormFor(o);
      setSavingShipId(o.id);
      setShipMsgs((prev) => ({ ...prev, [o.id]: '' }));
      try {
        const courier = courierToSave(form);
        const res = await adminSetOrderShipping({
          orderId: o.id,
          courier,
          awb: form.awb.trim(),
          trackingUrl: form.tracking_url.trim(),
          shippingStatus: form.shipping_status,
        });
        setShipForms((prev) => {
          const next = { ...prev };
          delete next[o.id];
          return next;
        });
        setActionMessage(
          res.status_clamped
            ? `Shipping saved for ${o.ref} — ${res.note ?? 'the status was held at Packed until an AWB is entered.'}`
            : `Shipping saved for ${o.ref} — ${shippingStatusLabel(res.shipping_status)}.`,
        );
        load();
      } catch (err) {
        setShipMsgs((prev) => ({
          ...prev,
          [o.id]: err instanceof Error ? err.message : 'Could not save shipping details.',
        }));
      } finally {
        setSavingShipId(null);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [shipForms],
  );

  // --- Ship via Delhivery (real shipment locked to production; fail-closed) ---
  const [confirmShipId, setConfirmShipId] = useState<string | null>(null);
  const [shippingOrderId, setShippingOrderId] = useState<string | null>(null);
  const [shipErrors, setShipErrors] = useState<Record<string, string>>({});
  // Email notification state (replaces the old 'Send Order Update via WhatsApp').
  const [emailingOrderId, setEmailingOrderId] = useState<string | null>(null);
  const [emailMsgs, setEmailMsgs] = useState<Record<string, string>>({});
  const EMAIL_KIND_LABEL: Record<string, string> = { confirmed: 'Order Confirmed', shipped: 'Shipped' };

  const hasLiveShipment = (o: RetailOrder): boolean =>
    Boolean(
      o.awb_number ||
        o.tracking_id ||
        (o.shiprocket_order_id && o.shiprocket_order_id !== 'creating')
    );

  // A CONFIRMED order may be handed to the courier. That set includes COD: a
  // full-COD order is committed at creation and simply collects the amount on
  // delivery, so gating this on payment_status === 'success' alone would leave
  // every COD order permanently unshippable.
  const canShip = (o: RetailOrder): boolean =>
    (VERIFIED_PAYMENTS as readonly string[]).includes(o.payment_status) &&
    SHIPPABLE_ORDER_STATUSES.has(o.order_status) &&
    !hasLiveShipment(o);

  /** Delivery-address lines for the clipboard copy (copies name, phone,
   *  address, city, state, PIN — no internal ids). */
  const copyAddress = async (o: RetailOrder) => {
    const c = o.customer ?? ({} as RetailOrder['customer']);
    const lines = [
      c.name,
      c.phone,
      c.address,
      [c.city, c.state].filter(Boolean).join(', '),
      c.pincode,
      c.country && c.country !== 'India' ? c.country : null,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      setActionMessage('Delivery address copied.');
    } catch {
      setActionMessage('Could not copy the address.');
    }
  };

  const shipOrder = async (o: RetailOrder) => {
    setShippingOrderId(o.id);
    setConfirmShipId(null);
    setShipErrors((prev) => ({ ...prev, [o.id]: '' }));
    try {
      // Route through VITE_FUNCTIONS_BASE_URL (localhost/staging serve) when set,
      // otherwise the hosted project URL — same endpoint either way, so the
      // manual "Ship Order" action can be tested against locally-served functions.
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token ?? '';
      const base = String(import.meta.env.VITE_FUNCTIONS_BASE_URL || import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
      const res = await fetch(`${base}/functions/v1/delhivery-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ orderId: o.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; awbNumber?: string };
      if (!res.ok) setShipErrors((prev) => ({ ...prev, [o.id]: body?.error || `Shipment creation failed (HTTP ${res.status}).` }));
      if (!res.ok) return;
      if (!body?.ok) {
        setShipErrors((prev) => ({ ...prev, [o.id]: body?.error || 'Shipment creation failed.' }));
        return;
      }
      setActionMessage(`Shipped — AWB ${body.awbNumber ?? ''}`.trim());
      load();
    } catch (err) {
      setShipErrors((prev) => ({ ...prev, [o.id]: err instanceof Error ? err.message : 'Shipment creation failed.' }));
    } finally {
      setShippingOrderId(null);
    }
  };

  // --- Cancel-before-ship / edit-address during the auto-ship grace window ---
  const [confirmCancelShipId, setConfirmCancelShipId] = useState<string | null>(null);
  const [cancellingShip, setCancellingShip] = useState(false);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState<RetailOrder['customer'] | null>(null);
  const [savingAddress, setSavingAddress] = useState(false);
  // Re-render every minute so the "auto-ship in ~N min" countdown stays honest.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);

  /** True when this order is inside its Cashfree auto-ship grace window (paid,
   *  shippable, no shipment yet, no failed attempt). */
  const awaitingAutoShip = (o: RetailOrder): boolean =>
    Boolean(o.auto_ship_at) &&
    o.payment_status === 'success' &&
    SHIPPABLE_ORDER_STATUSES.has(o.order_status) &&
    !hasLiveShipment(o) &&
    !o.ship_attempt_error;

  /** Countdown vs the stored auto_ship_at stamp (server-authoritative). */
  const autoShipInfo = (o: RetailOrder) => {
    const dueMs = o.auto_ship_at ? new Date(o.auto_ship_at).getTime() : 0;
    if (!dueMs) return null;
    const diff = dueMs - Date.now();
    return {
      dueAt: o.auto_ship_at ?? '',
      overdue: diff <= 0,
      minsLeft: Math.max(0, Math.round(diff / 60_000)),
    };
  };

  const cancelBeforeShip = async (o: RetailOrder) => {
    setCancellingShip(true);
    setShipErrors((prev) => ({ ...prev, [o.id]: '' }));
    try {
      const { error } = await supabase
        .from('retail_orders')
        .update({ order_status: 'cancelled', auto_ship_at: null })
        .eq('id', o.id);
      if (error) throw new Error(describeSupabaseError(error, 'Could not cancel the order before shipping.'));
      setConfirmCancelShipId(null);
      setActionMessage(`Order ${o.ref} cancelled — it will NOT be auto-shipped.`);
      load();
    } catch (err) {
      setShipErrors((prev) => ({ ...prev, [o.id]: err instanceof Error ? err.message : 'Could not cancel the order before shipping.' }));
    } finally {
      setCancellingShip(false);
    }
  };

  const startEditAddress = (o: RetailOrder) => {
    setAddressDraft({ ...o.customer });
    setEditingAddressId(o.id);
  };

  const saveAddress = async (o: RetailOrder) => {
    if (!addressDraft) return;
    setSavingAddress(true);
    setShipErrors((prev) => ({ ...prev, [o.id]: '' }));
    try {
      const { error } = await supabase
        .from('retail_orders')
        .update({ customer: { ...o.customer, ...addressDraft } })
        .eq('id', o.id);
      if (error) throw new Error(describeSupabaseError(error, 'Could not save the delivery address.'));
      setEditingAddressId(null);
      setAddressDraft(null);
      setActionMessage('Delivery address updated.');
      load();
    } catch (err) {
      setShipErrors((prev) => ({ ...prev, [o.id]: err instanceof Error ? err.message : 'Could not save the delivery address.' }));
    } finally {
      setSavingAddress(false);
    }
  };

  // --- Email the customer (Order Confirmed or Shipped, chosen by order state
  // server-side in send-order-mail). Replaces the old WhatsApp order-update
  // link — same trigger point, but an actual transactional email (Resend). ---
  const emailCustomer = async (o: RetailOrder) => {
    setEmailingOrderId(o.id);
    setEmailMsgs((prev) => ({ ...prev, [o.id]: '' }));
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token ?? '';
      const base = String(import.meta.env.VITE_FUNCTIONS_BASE_URL || import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
      const res = await fetch(`${base}/functions/v1/send-order-mail`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ orderId: o.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; hasEmail?: boolean; kind?: string };
      if (!body?.ok) {
        setEmailMsgs((prev) => ({ ...prev, [o.id]: body?.error || 'Could not send the email.' }));
        return;
      }
      // The endpoint deliberately does not return the address (it would be a PII
      // oracle), so confirm from the order we already hold in the UI.
      const masked = o.customer?.email
        ? maskEmail(o.customer.email)
        : 'the customer on file';
      setActionMessage(`Email sent to ${masked} — ${body.kind === 'shipped' ? 'Shipped' : 'Order Confirmed'}.`);
      load();
    } catch (err) {
      setEmailMsgs((prev) => ({ ...prev, [o.id]: err instanceof Error ? err.message : 'Could not send the email.' }));
    } finally {
      setEmailingOrderId(null);
    }
  };

  const emailStatusLabel = (o: RetailOrder): string =>
    o.last_email_kind ? (EMAIL_KIND_LABEL[o.last_email_kind] ?? o.last_email_kind) : '';

  if (orders === null) {
    return <div className="min-h-[40vh] flex items-center justify-center"><LoadingDots /></div>;
  }

  return (
    <div className="space-y-3">
      {/* Workflow tabs with live per-tab counts */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        {ORDER_TABS.map((def) => {
          const active = tab === def.key;
          const count = counts[def.key];
          return (
            <button
              key={def.key}
              type="button"
              onClick={() => selectTab(def.key)}
              aria-pressed={active}
              className={`shrink-0 inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold px-3.5 py-2 rounded border transition-colors ${
                active
                  ? 'bg-teal-700 text-white border-teal-700'
                  : 'bg-white text-bone-dim border-line hover:border-bone hover:text-bone'
              }`}
            >
              {def.label}
              {count > 0 && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${active ? 'bg-white/20 text-white' : 'bg-grey/15 text-grey'}`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Unpaid pending orders stay visible — never silently mixed into New Orders */}
      {tab === 'new' && unpaidCount > 0 && (
        <div
          className={`flex items-center justify-between gap-3 border rounded px-3.5 py-2.5 ${
            unpaidView ? 'bg-teal-50 border-teal-200' : 'bg-amber-50 border-amber-200'
          }`}
        >
          <p className="text-xs text-bone-dim">
            {unpaidView
              ? `${unpaidCount} order${unpaidCount === 1 ? '' : 's'} awaiting payment — shown here for action, not counted as New Orders.`
              : `${unpaidCount} order${unpaidCount === 1 ? '' : 's'} awaiting payment are not counted as New Orders.`}
          </p>
          <button
            type="button"
            onClick={() => setUnpaidView((v) => !v)}
            className={`shrink-0 text-[11px] uppercase tracking-wide-2 font-semibold transition-colors ${
              unpaidView ? 'text-teal-700 hover:text-teal-900' : 'text-bone-dim hover:text-bone'
            }`}
          >
            {unpaidView ? 'Back to New Orders' : 'View awaiting payment'}
          </button>
        </div>
      )}

      {/* Search + date range (server-side, scoped to the active view) */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="relative flex-1 min-w-[200px]">
          <SearchIcon
            size={14}
            strokeWidth={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-grey pointer-events-none"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by order ref, name, or phone…"
            className="w-full border border-line bg-white pl-8 pr-3 py-2 text-sm text-bone rounded focus:border-bone focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold text-grey">
          <Calendar size={14} strokeWidth={2} />
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            aria-label="From date"
            className="border border-line bg-white px-2 py-1.5 text-sm text-bone rounded focus:border-bone focus:outline-none"
          />
        </label>
        <span className="text-[11px] uppercase tracking-wide-2 font-semibold text-grey">to</span>
        <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold text-grey">
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            aria-label="To date"
            className="border border-line bg-white px-2 py-1.5 text-sm text-bone rounded focus:border-bone focus:outline-none"
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-grey">
          {orders.length === 0
            ? 'No retail orders yet.'
            : `${orders.length} retail order${orders.length === 1 ? '' : 's'} — newest first.`}
        </p>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone border border-line rounded px-3 py-2 transition-colors"
        >
          <ShoppingBag size={13} strokeWidth={1.8} /> Refresh
        </button>
      </div>

      {loadError && <div className="bg-crimson/5 border border-crimson/20 text-crimson text-sm px-4 py-3 rounded">{loadError}</div>}

      {actionMessage && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded">
          <Check size={14} strokeWidth={2.5} /> {actionMessage}
        </div>
      )}

      {orders.length === 0 && !loadError && (
        <div className="text-center py-24 border border-line rounded bg-white">
          <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">
            {search ? 'No matching orders' : TAB_EMPTY_TITLE[tab]}
          </p>
          <p className="mt-3 text-sm text-grey">
            {search
              ? 'No orders match your search in this view.'
              : unpaidView
                ? 'No orders awaiting payment right now.'
                : 'Orders placed on the retail storefront will appear here when they reach this stage.'}
          </p>
        </div>
      )}

      {orders.map((o) => {
        const isOpen = expanded === o.id;
        const pay = PAYMENT_STATUS_LABEL[o.payment_status];
        const autoInfo = autoShipInfo(o);
        return (
          <div key={o.id} className="bg-white border border-line rounded overflow-hidden">
            <button
              onClick={() => setExpanded(isOpen ? null : o.id)}
              className="w-full text-left flex items-center gap-3 sm:gap-4 p-3 sm:p-4"
            >
              <div className="w-11 h-11 shrink-0 rounded bg-paper-3 border border-line flex items-center justify-center text-bone">
                <ShoppingBag size={18} strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-bone">{o.ref}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); copyRef(o.ref); }}
                    className="text-grey hover:text-bone p-0.5"
                    aria-label="Copy order reference"
                  >
                    <Copy size={13} />
                  </button>
                  {o.is_cod && <span className="text-[10px] uppercase tracking-wide-2 font-semibold px-2 py-0.5 rounded bg-bone/10 text-bone">COD</span>}
                  {pay && <span className={`text-[10px] uppercase tracking-wide-2 font-semibold px-2 py-0.5 rounded ${pay.cls}`}>{pay.label}</span>}
                </div>
                <p className="text-xs text-grey mt-0.5 truncate">{o.customer.name} · {o.customer.phone}</p>
                <p className="text-[11px] text-grey/70 mt-0.5">{formatOrderDate(o.created_at)}</p>
                {/* Shipping, kept to one compact line so the list does not grow a
                    column. Never claims a courier or an AWB that isn't stored. */}
                {hasAwb(o) ? (
                  <p className="text-[11px] text-bone-dim mt-0.5 truncate">
                    {shippingStatusLabel(shippingStatusOf(o))}
                    {o.courier_name ? ` · ${o.courier_name}` : ''} · AWB{' '}
                    <span className="tabular-nums">{awbOf(o)}</span>
                  </p>
                ) : (
                  <p className="text-[11px] text-grey/70 mt-0.5">Not shipped</p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold text-bone">{formatPrice(o.total_amount)}</p>
                <p className="text-[11px] text-grey">{o.total_qty} items</p>
              </div>
              <ChevronDown size={16} className={`text-grey shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
              <div className="border-t border-line p-3 sm:p-4 space-y-4 bg-paper-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="bg-white border border-line rounded p-3 sm:p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mb-2">Customer</p>
                    <div className="space-y-1.5 text-sm text-bone">
                      <p className="flex items-center gap-2"><Phone size={13} className="text-grey" /> {o.customer.name} · {o.customer.phone}</p>
                      {o.customer.email && <p className="text-grey text-xs">{o.customer.email}</p>}
                      <p className="text-grey text-xs">{o.customer.address}, {o.customer.city}, {o.customer.state} — {o.customer.pincode}</p>
                    </div>
                  </div>
                  <div className="bg-white border border-line rounded p-3 sm:p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mb-2">Totals</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-bone-dim">Subtotal</span><span className="font-medium text-bone">{formatPrice(o.subtotal)}</span></div>
                      {Number(o.discount) > 0 && (
                        <div className="flex justify-between"><span className="text-bone-dim">Discount</span><span className="font-medium text-green-700">−{formatPrice(o.discount)}</span></div>
                      )}
                      <div className="flex justify-between"><span className="text-bone-dim">Shipping</span><span className="font-medium text-bone">{formatPrice(o.shipping)}</span></div>
                      <div className="flex justify-between border-t border-line pt-1"><span className="text-bone">Total (Sale)</span><span className="font-semibold text-bone">{formatPrice(o.total_amount)}</span></div>
                      {o.is_cod ? (
                        /* COD is collected in full by the agent - no advance,
                           no remaining balance. Historical advance-model orders
                           still show the real split they were actually paid under. */
                        Number(o.amount_paid_upfront ?? 0) > 0 ? (
                          <>
                            <div className="flex justify-between"><span className="text-bone-dim">Amount Collected</span><span className="font-medium text-green-700">{formatPrice(o.amount_paid_upfront ?? 0)}</span></div>
                            <div className="flex justify-between"><span className="text-bone-dim">Due on Delivery</span><span className="font-medium text-bone">{formatPrice(o.amount_due_on_delivery ?? 0)}</span></div>
                          </>
                        ) : (
                          <div className="flex justify-between border-t border-line pt-1">
                            <span className="text-bone">Due on Delivery</span>
                            <span className="font-semibold text-bone">{formatPrice(o.amount_due_on_delivery ?? o.total_amount)}</span>
                          </div>
                        )
                      ) : Number(o.payment_discount) > 0 && (
                        <div className="flex justify-between"><span className="text-bone-dim">Online Payment Discount</span><span className="font-medium text-green-700">−{formatPrice(o.payment_discount ?? 0)}</span></div>
                      )}
                      <div className="flex justify-between text-xs text-grey"><span>Qty</span><span>{o.total_qty}</span></div>
                      {o.promo_code && <div className="flex justify-between text-xs text-grey"><span>Promo</span><span>{o.promo_code}</span></div>}
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-line rounded p-3 sm:p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mb-2">Items ({o.items.length})</p>
                  <div className="divide-y divide-line">
                    {o.items.map((it, i) => {
                      // Same resolver the storefront uses: order lines store no
                      // image URL, so the picture comes from the catalogue by
                      // product code (then id) + colour.
                      const img = imageForItem(imageIndex, it);
                      return (
                      <div key={`${it.product_id}-${it.color_id}-${it.size_label}-${i}`} className="flex items-center gap-3 py-2">
                        <div className="h-12 w-10 shrink-0 overflow-hidden rounded border border-line bg-paper-3">
                          {img ? (
                            <img src={img} alt={it.name} className="h-full w-full object-cover" loading="lazy" />
                          ) : (
                            <div className="h-full w-full" style={{ backgroundColor: it.color_hex }} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-bone truncate">{it.name}</p>
                          <p className="text-[11px] text-bone-dim">{it.code} · {it.color} · {it.size_label}</p>
                        </div>
                        <span className="text-sm text-bone-dim">× {it.quantity}</span>
                        <span className="text-sm font-medium text-bone">{formatPrice(it.line_total)}</span>
                      </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-start justify-between gap-3 flex-wrap border-t border-line pt-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Payment</span>
                    <span className={`text-[10px] uppercase tracking-wide-2 font-semibold px-2 py-1 rounded ${pay ? pay.cls : 'bg-grey/15 text-grey'}`}>
                      {pay ? pay.label : o.payment_status}
                    </span>
                    {o.paid_at && <span className="text-[11px] text-grey">verified {formatOrderDate(o.paid_at)}</span>}
                  </div>
                  <label className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Order Status</span>
                    <select
                      value={o.order_status}
                      onChange={async (e) => {
                        const next = e.target.value;
                        // Consistency guard. Payment status comes from the
                        // verified provider (or, for COD, from the confirmed
                        // 'cod_pending' state) — never from a fulfillment click.
                        //
                        // CONFIRMED orders may advance freely. 'cod_pending'
                        // IS confirmed: a COD order owes its money to the
                        // delivery agent, not to us, so requiring
                        // payment_status = 'success' here would have made new
                        // COD orders impossible to pack, ship or deliver.
                        const confirmed = (VERIFIED_PAYMENTS as readonly string[]).includes(o.payment_status);
                        if (!confirmed && ['processing', 'shipped', 'delivered'].includes(next)) {
                          setLoadError('Cannot move an unconfirmed order into fulfillment. Payment must be verified first.');
                          return;
                        }
                        const patch: Record<string, unknown> = {
                          order_status: next,
                        };
                        const { error } = await supabase
                          .from('retail_orders')
                          .update(patch)
                          .eq('id', o.id);
                        if (error) {
                          setLoadError(describeSupabaseError(error, 'Could not update order status.'));
                          return;
                        }
                        load();
                      }}
                      className="border border-line bg-white px-2 py-1.5 text-sm text-bone rounded focus:border-bone focus:outline-none"
                    >
                      {orderStatusOptions(o.order_status).map((s) => (
                        <option key={s} value={s}>
                          {ORDER_STATUS_LABEL[s].label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {/* Collection status — COD ONLY, and deliberately separate from
                    Order Status.

                    Order Status is the fulfilment lifecycle and is identical for
                    every order: Pending -> Processing -> Shipped -> Delivered,
                    advanced by the Delhivery tracking webhook. A COD order is
                    confirmed at creation (payment_status 'cod_pending'), so it
                    walks that exact same path — there is no separate "confirm
                    the payment" step gating Delivered.

                    Collection is a different fact: whether the agent actually
                    took the cash. Delhivery's tracking payload does NOT carry
                    it. Both sources we receive — the pull
                    GET /api/v1/packages/json/ and the pushed Shipment webhook —
                    expose only AWB, Status.StatusType (DL/UD/RT/IT/NDR) and
                    Scans[]. There is no per-order collected/pending/failed
                    field; COD remittance reaches the merchant as an account
                    settlement, not as a per-waybill status on the shipment.

                    So this is a static note, NOT a live value. It is shown
                    rather than hidden so an operator knows exactly where to
                    look for the money, and so nobody reads "Delivered" as
                    "cash in hand". See codCollectionNote() for the single
                    source of this string. */}
                {o.is_cod && (
                  <div className="mt-3 flex items-center gap-2 flex-wrap border-t border-line pt-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">
                      Collection status
                    </span>
                    <span
                      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide-2 font-semibold px-2 py-1 rounded bg-grey/15 text-bone-dim"
                      title="Delhivery does not expose per-order COD collection in its tracking data."
                    >
                      <Info size={11} strokeWidth={2} className="shrink-0" />
                      {codCollectionNote(o)}
                    </span>
                    <span className="text-[11px] text-grey">
                      settled via your Delhivery remittance report
                    </span>
                  </div>
                )}

                <div className="border-t border-line pt-3">
                    <div className="bg-white border border-line rounded p-3 sm:p-4">
                      <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mb-2">Shipment</p>
                      <div className="mb-3 pb-3 border-b border-line space-y-2">
                        <div className="flex items-center gap-1.5">
                          <Truck size={13} strokeWidth={1.8} className="text-grey" />
                          {/* The courier is whatever was actually chosen, not a
                              hard-coded provider. An order with no courier yet
                              is not "Delhivery" — it simply has not shipped. */}
                          <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">
                            {o.courier_name || 'Courier not assigned'}
                          </span>
                        </div>
                        {hasLiveShipment(o) && o.shiprocket_order_id !== 'creating' ? (
                          <>
                            <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide-2 text-green-700">
                              <Check size={13} strokeWidth={2.5} />
                              {hasAwb(o) ? 'AWB assigned' : 'Shipment created'}{' '}
                              {['auto', 'webhook'].includes(o.ship_source ?? '') ? 'automatically' : 'manually'}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                              <div>
                                <p className="text-[10px] uppercase tracking-wide-2 text-grey">Courier</p>
                                <p className="text-bone font-medium mt-0.5">{o.courier_name || '—'}</p>
                              </div>
                              <div>
                                <p className="text-[10px] uppercase tracking-wide-2 text-grey">AWB / Tracking</p>
                                <p className="text-bone font-medium mt-0.5 tabular-nums">{awbOf(o) || '—'}</p>
                              </div>
                              <div>
                                <p className="text-[10px] uppercase tracking-wide-2 text-grey">Shipping status</p>
                                <p className="text-bone font-medium mt-0.5 capitalize">
                                  {shippingStatusLabel(shippingStatusOf(o))}
                                  {/* The courier's own scan status, only when a
                                      provider actually reported one. Never
                                      invented, never used as a substitute. */}
                                  {o.tracking_current_status
                                    ? ` · courier: ${o.tracking_current_status}`
                                    : ''}
                                  {o.tracking_location ? ` · ${o.tracking_location}` : ''}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap pt-0.5">
                              {o.label_url && (
                                <a
                                  href={o.label_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-2 border border-bone/40 text-bone bg-white hover:bg-bone/5 text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded transition-colors"
                                >
                                  <Printer size={14} strokeWidth={2} /> Print Label
                                </a>
                              )}
                              <a
                                href={linkHref(`/admin/print-delivery/${o.id}`)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 border border-bone/40 text-bone bg-white hover:bg-bone/5 text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded transition-colors"
                              >
                                <Printer size={14} strokeWidth={2} /> Print Delivery Details
                              </a>
                              <button
                                type="button"
                                onClick={() => copyAddress(o)}
                                className="inline-flex items-center gap-2 border border-bone/40 text-bone bg-white hover:bg-bone/5 text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded transition-colors"
                              >
                                <Copy size={14} strokeWidth={2} /> Copy Address
                              </button>
                            </div>
                          </>
                        ) : o.shiprocket_order_id === 'creating' ? (
                          <p className="text-xs text-grey flex items-center gap-1.5">
                            <Loader2 size={13} strokeWidth={2} className="animate-spin" /> Creating the shipment on Delhivery…
                          </p>
                        ) : o.ship_attempt_error ? (
                          confirmShipId === o.id ? (
                            <div className="space-y-2">
                              <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide-2 text-crimson">
                                <X size={13} strokeWidth={2.5} /> Shipment failed — needs manual action
                              </p>
                              <p className="text-xs text-crimson bg-crimson/5 border border-crimson/20 px-3 py-2 rounded">
                                {o.ship_attempt_error}
                              </p>
                              {o.last_ship_attempt_at && (
                                <p className="text-[10px] text-grey">Last attempt: {formatOrderDate(o.last_ship_attempt_at)}</p>
                              )}
                              <p className="text-xs text-crimson bg-crimson/5 border border-crimson/20 px-3 py-2 rounded">
                                Retrying fails closed — a shipment is only created when Delhivery is configured and this order is eligible.
                              </p>
                              <div className="flex items-center gap-2 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => shipOrder(o)}
                                  disabled={shippingOrderId === o.id}
                                  className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-ink transition-colors disabled:opacity-50"
                                >
                                  {shippingOrderId === o.id ? (
                                    <Loader2 size={14} strokeWidth={2.5} className="animate-spin" />
                                  ) : (
                                    <Truck size={14} strokeWidth={2} />
                                  )}
                                  {shippingOrderId === o.id ? 'Shipping…' : 'Confirm — retry shipment'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmShipId(null)}
                                  disabled={shippingOrderId === o.id}
                                  className="text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone border border-line rounded px-4 py-2.5 transition-colors disabled:opacity-50"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide-2 text-crimson">
                                <X size={13} strokeWidth={2.5} /> Shipment failed — needs manual action
                              </p>
                              <p className="text-xs text-crimson bg-crimson/5 border border-crimson/20 px-3 py-2 rounded">
                                {o.ship_attempt_error}
                              </p>
                              {o.last_ship_attempt_at && (
                                <p className="text-[10px] text-grey">Last attempt: {formatOrderDate(o.last_ship_attempt_at)}</p>
                              )}
                              <div className="flex items-center justify-between gap-3 flex-wrap">
                                <p className="text-xs text-grey">Fix the reason, then retry the shipment. This order was flagged for manual action and will NOT be auto-retried.</p>
                                <button
                                  type="button"
                                  onClick={() => setConfirmShipId(o.id)}
                                  disabled={shippingOrderId === o.id}
                                  className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-ink transition-colors disabled:opacity-50"
                                >
                                  <Truck size={14} strokeWidth={2} /> Retry Shipment
                                </button>
                              </div>
                            </div>
                          )
                        ) : canShip(o) ? (
                          <div className="space-y-2">
                            {autoInfo && (
                              <>
                                <div className="flex items-center gap-1.5">
                                  <Clock size={13} strokeWidth={1.8} className="text-grey" />
                                  <span className="text-[11px] font-semibold uppercase tracking-wide-2 text-bone">
                                    Auto-ship {autoInfo.overdue ? 'ready / pending' : 'scheduled'}
                                    {!autoInfo.overdue && ` · ${formatOrderDate(autoInfo.dueAt)}`}
                                  </span>
                                </div>
                                <p className="text-xs text-grey">
                                  {autoInfo.overdue
                                    ? 'The due time has passed but the auto-ship sweep has not run yet — this order will be shipped on the next scheduled run, or ship it manually now.'
                                    : `This order will be handed to Delhivery automatically in ~${autoInfo.minsLeft} min. Cancel it (or fix the address) before then to stop the parcel.`}
                                </p>
                                {confirmCancelShipId === o.id ? (
                                  <div className="flex items-center gap-2 flex-wrap text-xs bg-crimson/5 border border-crimson/20 rounded px-3 py-2">
                                    <span className="text-crimson">Cancel this order? It will NOT be auto-shipped. Stock stays reserved and any refund is handled manually.</span>
                                    <button
                                      type="button"
                                      onClick={() => cancelBeforeShip(o)}
                                      disabled={cancellingShip || shippingOrderId === o.id}
                                      className="inline-flex items-center gap-1.5 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-3 py-1.5 rounded hover:bg-bone transition-colors disabled:opacity-50"
                                    >
                                      {cancellingShip ? (
                                        <Loader2 size={13} strokeWidth={2.5} className="animate-spin" />
                                      ) : (
                                        <X size={13} strokeWidth={2.5} />
                                      )}
                                      {cancellingShip ? 'Cancelling…' : 'Confirm cancel'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmCancelShipId(null)}
                                      disabled={cancellingShip || shippingOrderId === o.id}
                                      className="text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone disabled:opacity-50"
                                    >
                                      Keep order
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <button
                                      type="button"
                                      onClick={() => setConfirmCancelShipId(o.id)}
                                      disabled={cancellingShip || shippingOrderId === o.id}
                                      className="inline-flex items-center gap-2 border border-crimson/50 text-crimson bg-white hover:bg-crimson/5 text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded transition-colors disabled:opacity-50"
                                    >
                                      <X size={14} strokeWidth={2} /> Cancel before ship
                                    </button>
                                    {editingAddressId === o.id && addressDraft ? (
                                      <div className="w-full space-y-2 border border-line rounded p-3 bg-white">
                                        <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Edit delivery address (before auto-ship)</p>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                          <input
                                            value={addressDraft.name}
                                            onChange={(e) => setAddressDraft({ ...addressDraft, name: e.target.value })}
                                            placeholder="Name"
                                            className={inputCls}
                                          />
                                          <input
                                            value={addressDraft.phone}
                                            onChange={(e) => setAddressDraft({ ...addressDraft, phone: e.target.value })}
                                            placeholder="Phone"
                                            className={inputCls}
                                          />
                                          <input
                                            value={addressDraft.address}
                                            onChange={(e) => setAddressDraft({ ...addressDraft, address: e.target.value })}
                                            placeholder="Street address"
                                            className={inputCls}
                                          />
                                          <input
                                            value={addressDraft.city}
                                            onChange={(e) => setAddressDraft({ ...addressDraft, city: e.target.value })}
                                            placeholder="City"
                                            className={inputCls}
                                          />
                                          <input
                                            value={addressDraft.state}
                                            onChange={(e) => setAddressDraft({ ...addressDraft, state: e.target.value })}
                                            placeholder="State"
                                            className={inputCls}
                                          />
                                          <input
                                            value={addressDraft.pincode}
                                            onChange={(e) => setAddressDraft({ ...addressDraft, pincode: e.target.value })}
                                            placeholder="Pincode"
                                            className={inputCls}
                                          />
                                        </div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <button
                                            type="button"
                                            onClick={() => saveAddress(o)}
                                            disabled={savingAddress || shippingOrderId === o.id}
                                            className="inline-flex items-center gap-1.5 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded hover:bg-ink transition-colors disabled:opacity-50"
                                          >
                                            {savingAddress ? (
                                              <Loader2 size={13} strokeWidth={2.5} className="animate-spin" />
                                            ) : (
                                              <Save size={13} strokeWidth={2} />
                                            )}
                                            {savingAddress ? 'Saving…' : 'Save address'}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => { setEditingAddressId(null); setAddressDraft(null); }}
                                            disabled={savingAddress || shippingOrderId === o.id}
                                            className="text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone disabled:opacity-50"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => startEditAddress(o)}
                                        disabled={shippingOrderId === o.id}
                                        className="inline-flex items-center gap-2 border border-line text-bone-dim hover:text-bone bg-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded transition-colors disabled:opacity-50"
                                      >
                                        <Pencil size={14} strokeWidth={2} /> Edit address
                                      </button>
                                    )}
                                  </div>
                                )}
                              </>
                            )}
                            {confirmShipId === o.id ? (
                              <div className="space-y-2">
                                <p className="text-xs text-crimson bg-crimson/5 border border-crimson/20 px-3 py-2 rounded">
                                  This fails closed — a shipment is only created when Delhivery is configured and this order is eligible.
                                </p>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <button
                                    type="button"
                                    onClick={() => shipOrder(o)}
                                    disabled={shippingOrderId === o.id}
                                    className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-ink transition-colors disabled:opacity-50"
                                  >
                                    {shippingOrderId === o.id ? (
                                      <Loader2 size={14} strokeWidth={2.5} className="animate-spin" />
                                    ) : (
                                      <Truck size={14} strokeWidth={2} />
                                    )}
                                    {shippingOrderId === o.id ? 'Shipping…' : 'Confirm — ship order'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmShipId(null)}
                                    disabled={shippingOrderId === o.id}
                                    className="text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone border border-line rounded px-4 py-2.5 transition-colors disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-3 flex-wrap">
                                <p className="text-xs text-grey">
                                  {autoInfo
                                    ? 'Fallback — ship this order manually right now, bypassing the grace window.'
                                    : 'Create the shipment on Delhivery and assign a courier.'}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => setConfirmShipId(o.id)}
                                  disabled={shippingOrderId === o.id}
                                  className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-ink transition-colors disabled:opacity-50"
                                >
                                  <Truck size={14} strokeWidth={2} /> Ship Order
                                </button>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-grey">Not shippable — this order is not confirmed, already has a shipment, or is not in a shippable state.</p>
                        )}
                        {shipErrors[o.id] && <p className="text-xs text-crimson">{shipErrors[o.id]}</p>}
                      </div>
                      {/* --- Manual courier + AWB ---------------------------
                          Always visible, in every shipment state, so an admin can
                          enter or correct an AWB without any courier API, label
                          or account. This is the primary shipping control; the
                          Delhivery automation above is an optional shortcut. */}
                      <div className="mt-3 pt-3 border-t border-line space-y-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Shipping</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <label className="block">
                            <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Courier</span>
                            <select
                              value={shipFormFor(o).courier}
                              onChange={(e) => setShipForm(o.id, shipFormFor(o), { courier: e.target.value })}
                              className="mt-1 w-full border border-line bg-white px-2 py-1.5 text-sm text-bone rounded focus:border-bone focus:outline-none"
                            >
                              <option value="">Select courier…</option>
                              {COURIER_OPTIONS.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                              {/* A courier that is not in our list stays selectable
                                  by name, so the admin is never blocked. */}
                              {shipFormFor(o).courier &&
                                !COURIER_OPTIONS.includes(shipFormFor(o).courier as (typeof COURIER_OPTIONS)[number]) && (
                                  <option value={shipFormFor(o).courier}>{shipFormFor(o).courier}</option>
                                )}
                            </select>
                            {/* "Other" is a choice, not a courier name. Ask which
                                one, and refuse to save a bare "Other". */}
                            {shipFormFor(o).courier === 'Other' && (
                              <input
                                value={shipFormFor(o).courier_other}
                                onChange={(e) => setShipForm(o.id, shipFormFor(o), { courier_other: e.target.value })}
                                placeholder="Which courier? e.g. Ecom Express"
                                autoComplete="off"
                                className="mt-1 w-full border border-line bg-white px-2 py-1.5 text-sm text-bone rounded focus:border-bone focus:outline-none"
                              />
                            )}
                            {shipFormFor(o).courier === 'Other' && !shipFormFor(o).courier_other.trim() && (
                              <p className="mt-1 text-[10px] text-amber-700">
                                Enter the courier name, or pick one from the list.
                              </p>
                            )}
                          </label>
                          <label className="block">
                            <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Shipping status</span>
                            <select
                              value={shipFormFor(o).shipping_status}
                              onChange={(e) => setShipForm(o.id, shipFormFor(o), { shipping_status: e.target.value })}
                              className="mt-1 w-full border border-line bg-white px-2 py-1.5 text-sm text-bone rounded focus:border-bone focus:outline-none"
                            >
                              {SHIPPING_STATUS_FLOW.map((s) => (
                                <option key={s} value={s}>
                                  {SHIPPING_STATUS_LABEL[s].label}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <label className="block">
                            <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Tracking / AWB number</span>
                            <input
                              value={shipFormFor(o).awb}
                              onChange={(e) => setShipForm(o.id, shipFormFor(o), { awb: e.target.value })}
                              placeholder="Enter the AWB the courier gave you"
                              autoComplete="off"
                              className="mt-1 w-full border border-line bg-white px-2 py-1.5 text-sm text-bone rounded focus:border-bone focus:outline-none"
                            />
                          </label>
                          <label className="block">
                            <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Tracking URL</span>
                            <input
                              value={shipFormFor(o).tracking_url}
                              onChange={(e) => setShipForm(o.id, shipFormFor(o), { tracking_url: e.target.value })}
                              placeholder={
                                shipFormFor(o).courier === 'Delhivery' && shipFormFor(o).awb.trim()
                                  ? `Auto: ${delhiveryTrackingUrl(shipFormFor(o).awb.trim()) ?? ''}`
                                  : 'Optional — https://…'
                              }
                              autoComplete="off"
                              className="mt-1 w-full border border-line bg-white px-2 py-1.5 text-sm text-bone rounded focus:border-bone focus:outline-none"
                            />
                          </label>
                        </div>
                        {!shipFormFor(o).awb.trim() && isPostHandoff(shipFormFor(o).shipping_status) && (
                          <p className="text-[11px] text-amber-700">
                            Enter an AWB to save this status — an order cannot be shown as shipped to the customer without a tracking number.
                          </p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap mt-1">
                          <button
                            type="button"
                            onClick={() => saveShipping(o)}
                            disabled={savingShipId === o.id || !courierToSave(shipFormFor(o))}
                            className="btn-dark inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded disabled:opacity-50"
                          >
                            {savingShipId === o.id ? (
                              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                            ) : (
                              <Save size={14} strokeWidth={2} />
                            )}
                            Save Shipping Details
                          </button>
                          {hasAwb(o) && o.shipped_at && (
                            <span className="text-[11px] text-grey">Shipped {formatOrderDate(o.shipped_at)}</span>
                          )}
                          {o.delivered_at && (
                            <span className="text-[11px] text-green-700">Delivered {formatOrderDate(o.delivered_at)}</span>
                          )}
                        </div>
                        {shipMsgs[o.id] && <p className="text-[11px] text-crimson">{shipMsgs[o.id]}</p>}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap mt-3">
                        <button
                          type="button"
                          onClick={() => emailCustomer(o)}
                          disabled={emailingOrderId === o.id || !o.customer.email}
                          title={!o.customer.email ? 'No customer email on this order.' : undefined}
                          className="inline-flex items-center gap-2 bg-teal-700 text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-teal-800 transition-colors disabled:opacity-50"
                        >
                          {emailingOrderId === o.id ? (
                            <Loader2 size={14} strokeWidth={2.5} className="animate-spin" />
                          ) : (
                            <Mail size={14} strokeWidth={2} />
                          )}
                          {o.last_email_sent_at ? 'Resend Email' : 'Email Customer'}
                        </button>
                      </div>
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Customer email</span>
                        <span className="text-xs text-bone">{o.customer.email ?? <span className="text-crimson">no email on order</span>}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 flex-wrap">
                        {o.last_email_sent_at ? (
                          <span className="inline-flex items-center gap-1.5 text-[11px] text-green-700">
                            <Check size={13} strokeWidth={2.5} /> {emailStatusLabel(o)} emailed · {formatOrderDate(o.last_email_sent_at)}
                          </span>
                        ) : (
                          <span className="text-[11px] text-grey">Not emailed yet</span>
                        )}
                        {emailMsgs[o.id] && <span className="text-[11px] text-crimson">{emailMsgs[o.id]}</span>}
                      </div>
                    </div>
                  </div>

                <div className="flex justify-end border-t border-line pt-3">
                  <button
                    type="button"
                    onClick={() => { setDeleteError(''); setConfirmDelete(o); }}
                    className="inline-flex items-center gap-2 border border-bone/40 text-bone bg-white hover:bg-bone/5 text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded transition-colors"
                  >
                    <Trash2 size={14} strokeWidth={2} /> Delete Order
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {orders.length > 0 && !ordersComplete && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 border border-line bg-white text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone hover:border-bone rounded px-5 py-2.5 transition-colors disabled:opacity-50"
          >
            {loadingMore ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : null}
            {loadingMore ? 'Loading…' : 'Load older orders'}
          </button>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => !deleting && setConfirmDelete(null)} />
          <div className="relative w-full max-w-sm bg-white border border-line rounded-lg p-5 sm:p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-label text-sm uppercase tracking-wide-2 text-bone font-semibold">Delete this order?</h3>
              <button type="button" aria-label="Close" onClick={() => !deleting && setConfirmDelete(null)} className="text-grey hover:text-bone">
                <X size={16} />
              </button>
            </div>
            <p className="text-sm text-grey mt-2">
              This will permanently remove the order and its associated order data.
            </p>
            {deleteError && (
              <p className="mt-3 text-sm text-crimson bg-crimson/5 border border-crimson/20 px-3 py-2 rounded">{deleteError}</p>
            )}
            <div className="flex justify-end gap-3 mt-5">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmDelete(null)}
                className="inline-flex items-center gap-2 border border-line text-bone-dim hover:border-bone-dim hover:text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={performDelete}
                className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-ink transition-colors disabled:opacity-50"
              >
                {deleting ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : <Trash2 size={14} strokeWidth={2} />} Delete Order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Promo Codes ---- */

interface PromoRow {
  id: string;
  code: string;
  label: string;
  discount_type: 'percent' | 'flat';
  discount_value: number;
  active: boolean;
  max_uses: number | null;
  used_count: number;
  starts_at: string | null;
  expires_at: string | null;
  min_order_value: number | null;
  max_discount: number | null;
  per_customer_limit: number | null;
  note: string | null;
  created_at: string;
}

function PromoPanel() {
  const [promos, setPromos] = useState<PromoRow[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<PromoRow | null>(null);
  const [creating, setCreating] = useState(false);
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    setError('');
    try {
      const { data, error } = await supabase
        .from('promo_codes')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setPromos((data as PromoRow[]) ?? []);
    } catch (err) {
      setPromos([]);
      setError(describeSupabaseError(err, 'Could not load promo codes.'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleActive = async (p: PromoRow) => {
    setError('');
    const { error } = await supabase.from('promo_codes').update({ active: !p.active }).eq('id', p.id);
    if (error) { setError(describeSupabaseError(error, 'Could not update promo code.')); return; }
    setPromos((prev) => prev?.map((x) => (x.id === p.id ? { ...x, active: !p.active } : x)) ?? null);
  };

  const requestDelete = (p: PromoRow) =>
    requestConfirm({
      title: 'Delete promo code',
      message: `Delete promo "${p.code}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => void remove(p),
    });

  const remove = async (p: PromoRow) => {
    setError('');
    const { error } = await supabase.from('promo_codes').delete().eq('id', p.id);
    if (error) { setError(describeSupabaseError(error, 'Could not delete promo code.')); return; }
    setPromos((prev) => prev?.filter((x) => x.id !== p.id) ?? null);
    if (editing?.id === p.id) setEditing(null);
  };

  if (promos === null) {
    return <div className="min-h-[40vh] flex items-center justify-center"><LoadingDots /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-grey">
          {promos.length === 0 ? 'No promo codes yet.' : `${promos.length} promo code${promos.length === 1 ? '' : 's'}.`}
        </p>
        <button
          onClick={() => { setCreating(true); setEditing(null); }}
          className="inline-flex items-center gap-1.5 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-3 py-2 rounded hover:bg-ink transition-colors"
        >
          <Plus size={13} strokeWidth={2} /> New Promo
        </button>
      </div>

      {error && <div className="bg-crimson/5 border border-crimson/20 text-crimson text-sm px-4 py-3 rounded">{error}</div>}

      {(creating || editing) && (
        <PromoForm
          initial={editing}
          onCancel={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}

      {promos.length === 0 && !creating && !editing && !error && (
        <div className="text-center py-24 border border-line rounded bg-white">
          <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No promo codes</p>
          <p className="mt-3 text-sm text-grey">Create a code like WELCOME10 to offer shoppers a discount.</p>
        </div>
      )}

      {promos.map((p) => {
        const expired = p.expires_at && new Date(p.expires_at).getTime() < Date.now();
        const usable = p.active && !expired && (p.max_uses === null || p.used_count < p.max_uses);
        return (
          <div key={p.id} className="bg-white border border-line rounded p-3 sm:p-4 flex items-center gap-3 sm:gap-4 flex-wrap">
            <div className="w-11 h-11 shrink-0 rounded bg-paper-3 border border-line flex items-center justify-center text-bone">
              <Ticket size={18} strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-bone">{p.code}</span>
                {p.label && <span className="text-xs text-grey truncate">{p.label}</span>}
              </div>
              <p className="text-[11px] text-grey mt-0.5">
                {p.discount_type === 'percent' ? `${p.discount_value}% off` : `${formatPrice(p.discount_value)} off`}
                {Number(p.min_order_value) > 0 && <> · min {formatPrice(Number(p.min_order_value))}</>}
                {Number(p.max_discount) > 0 && <> · max {formatPrice(Number(p.max_discount))}</>}
                {' · '}{p.used_count}{p.max_uses !== null ? ` / ${p.max_uses} uses` : ' uses'}
                {p.per_customer_limit !== null && p.per_customer_limit !== undefined && (
                  <> · {p.per_customer_limit} per customer</>
                )}
              </p>
              <p className="text-[11px] text-grey mt-0.5">
                {p.starts_at && <>Valid from {formatOrderDate(p.starts_at).split(',')[0]}</>}
                {p.starts_at && p.expires_at && ' · '}
                {p.expires_at ? `valid till ${formatOrderDate(p.expires_at).split(',')[0]}` : 'No expiry'}
              </p>
              {p.note && <p className="text-[11px] text-bone-dim mt-0.5 italic truncate">Note: {p.note}</p>}
            </div>
            <span className={`shrink-0 text-[10px] uppercase tracking-wide-2 font-semibold px-2 py-1 rounded ${
              usable ? 'bg-green-600/10 text-green-700' : 'bg-grey/15 text-grey'
            }`}>
              {usable ? 'Active' : expired ? 'Expired' : 'Disabled'}
            </span>
            <button
              onClick={() => toggleActive(p)}
              className="shrink-0 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone border border-line rounded px-2.5 py-1.5 transition-colors"
            >
              {p.active ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => { setEditing(p); setCreating(false); }}
              className="shrink-0 text-[10px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone px-2 py-1.5 border border-line rounded hover:border-bone transition-colors"
            >
              Edit
            </button>
            <button onClick={() => requestDelete(p)} className="text-grey hover:text-bone p-1.5" aria-label="Delete promo code">
              <Trash2 size={15} strokeWidth={1.8} />
            </button>
          </div>
        );
      })}
      {confirmDialog}
    </div>
  );
}

function PromoForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: PromoRow | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    code: initial?.code ?? '',
    label: initial?.label ?? '',
    discount_type: initial?.discount_type ?? 'percent',
    discount_value: String(initial?.discount_value ?? 10),
    max_uses: initial?.max_uses !== null && initial?.max_uses !== undefined ? String(initial.max_uses) : '',
    min_order_value:
      initial?.min_order_value !== null && initial?.min_order_value !== undefined
        ? String(initial.min_order_value)
        : '',
    max_discount:
      initial?.max_discount !== null && initial?.max_discount !== undefined
        ? String(initial.max_discount)
        : '',
    per_customer_limit:
      initial?.per_customer_limit !== null && initial?.per_customer_limit !== undefined
        ? String(initial.per_customer_limit)
        : '',
    starts_at: initial?.starts_at ? new Date(initial.starts_at).toISOString().slice(0, 10) : '',
    expires_at:
      initial?.expires_at ? new Date(initial.expires_at).toISOString().slice(0, 10) : '',
    note: initial?.note ?? '',
    active: initial?.active ?? true,
  });

  const inputCls = 'w-full border border-line bg-white px-2.5 py-2 text-sm text-bone focus:border-bone focus:outline-none rounded';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    let value = Math.max(0, Number(form.discount_value) || 0);
    if (form.discount_type === 'percent') value = Math.min(100, value);
    const minOrder = Math.max(0, Number(form.min_order_value) || 0);
    const maxDisc = form.max_discount !== '' ? Math.max(0, Number(form.max_discount) || 0) : null;
    const perCustomer =
      form.per_customer_limit !== '' ? Math.max(1, parseInt(form.per_customer_limit, 10)) : null;
    const payload = {
      code: form.code.toUpperCase().trim().slice(0, 32),
      label: form.label.trim(),
      discount_type: form.discount_type,
      discount_value: value,
      max_uses: form.max_uses ? Math.max(1, parseInt(form.max_uses, 10)) : null,
      min_order_value: minOrder,
      max_discount: maxDisc,
      per_customer_limit: perCustomer,
      starts_at: form.starts_at ? `${form.starts_at}T00:00:00.000` : null,
      expires_at: form.expires_at ? `${form.expires_at}T23:59:59.999` : null,
      note: form.note.trim(),
      active: form.active,
    };
    if (!payload.code) { setError('Promo code is required.'); setSaving(false); return; }
    if (value <= 0) { setError('Discount value must be greater than zero.'); setSaving(false); return; }
    try {
      const op = initial
        ? supabase.from('promo_codes').update(payload).eq('id', initial.id)
        : supabase.from('promo_codes').insert(payload);
      const { error } = await op;
      if (error) throw error;
      onSaved();
    } catch (err) {
      setError(describeSupabaseError(err, 'Could not save promo code.'));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-line rounded p-4 sm:p-5 space-y-4">
      <h3 className="font-display text-lg uppercase tracking-wide-2 text-bone">
        {initial ? `Edit ${initial.code}` : 'New Promo Code'}
      </h3>
      {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-3 py-2 rounded">{error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <Field label="Code" hint="e.g. WELCOME10 — auto-uppercased">
          <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className={inputCls} placeholder="WELCOME10" maxLength={32} autoCapitalize="characters" spellCheck={false} />
        </Field>
        <Field label="Label" hint="Optional short title (internal)">
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className={inputCls} placeholder="Welcome offer" maxLength={80} />
        </Field>
        <Field label="Discount Type">
          <select value={form.discount_type} onChange={(e) => setForm({ ...form, discount_type: e.target.value as 'percent' | 'flat' })} className={inputCls}>
            <option value="percent">Percentage (%)</option>
            <option value="flat">Flat amount (₹)</option>
          </select>
        </Field>
        <Field label={form.discount_type === 'percent' ? 'Discount (%)' : 'Discount (₹)'}>
          <input type="number" min={0} step="1" value={form.discount_value} onChange={(e) => setForm({ ...form, discount_value: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Max Uses" hint="Leave empty for unlimited">
          <input type="number" min={1} step={1} value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: e.target.value })} className={inputCls} placeholder="Unlimited" />
        </Field>
        <Field label="Min Order Value (₹)" hint="Leave 0 for any basket">
          <input type="number" min={0} step="1" value={form.min_order_value} onChange={(e) => setForm({ ...form, min_order_value: e.target.value })} className={inputCls} placeholder="0" />
        </Field>
        <Field label="Max Discount (₹)" hint="Cap the discount; leave empty for no cap">
          <input type="number" min={0} step="1" value={form.max_discount} onChange={(e) => setForm({ ...form, max_discount: e.target.value })} className={inputCls} placeholder="No cap" />
        </Field>
        <Field label="Per-Customer Limit" hint="Max orders per phone number; leave empty for unlimited">
          <input type="number" min={1} step={1} value={form.per_customer_limit} onChange={(e) => setForm({ ...form, per_customer_limit: e.target.value })} className={inputCls} placeholder="Unlimited" />
        </Field>
        <Field label="Valid From" hint="Optional start date">
          <input type="date" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Expires" hint="Optional expiry date">
          <input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} className={inputCls} />
        </Field>
      </div>
      <Field label="Internal Note" hint="Admin-only — never shown to shoppers">
        <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={inputCls} placeholder="e.g. Winter sale, saturday email code" maxLength={240} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-bone">
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="w-4 h-4 accent-bone" />
        Active — redeemable at checkout
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button type="submit" disabled={saving} className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-ink transition-colors disabled:opacity-60">
          {saving ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save Promo'}
        </button>
        <button type="button" onClick={onCancel} className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone border border-line rounded px-5 py-3 transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}




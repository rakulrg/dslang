import { useEffect, useState, useCallback, useRef } from 'react';
import {
  LayoutGrid,
  Image as ImageIcon,
  LogOut,
  Plus,
  Trash2,
  Save,
  X,
  ChevronDown,
  GripVertical,
  Check,
  ExternalLink,
  Upload,
  Settings as SettingsIcon,
  ShoppingBag,
  Copy,
  Phone,
  Ticket,
  Loader2,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useSiteSettings, type SiteSettings } from '@/lib/settings';
import { linkHref } from '@/lib/router';
import { formatPrice, getMrp, getRetailPrice, getSizesForColor } from '@/lib/catalog';
import { preloadImage } from '@/lib/image';
import { LoadingDots } from '@/components/LoadingDots';
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
  adminSetSizeStock,
  adminFetchRetailOrders,
  adminDeleteRetailOrder,
  adminCreateHero,
  adminUpdateHero,
  adminDeleteHero,
  uploadProductImage,
  uploadHeroImage,
  hasHeroCtaColumns,
  describeSupabaseError,
  type ProductInput,
} from '@/lib/admin';
import { hasPublishColumns } from '@/lib/catalog';
import type { CatalogProduct, HeroSlideRow, ProductColorRow, ProductSizeRow, RetailOrder } from '@/lib/types';
import { SIZE_LABELS } from '@/lib/types';

type Tab = 'products' | 'hero' | 'settings' | 'orders' | 'promos';

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

export function AdminDashboard() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('products');
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [heroSlides, setHeroSlides] = useState<HeroSlideRow[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [publishReady, setPublishReady] = useState(false);
  const [heroCtaReady, setHeroCtaReady] = useState(false);

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
    hasHeroCtaColumns().then((ok) => { if (!cancelled) setHeroCtaReady(ok); });
    return () => { cancelled = true; };
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
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

  return (
    <div className="min-h-screen bg-paper-2 flex flex-col lg:flex-row">
      {/* Mobile header */}
      <div className="lg:hidden w-full shrink-0 bg-paper-2 border-b border-line">
        <div className="flex items-center justify-between px-4 py-3">
          <a href={linkHref('/')} className="font-brand text-xl tracking-[0.03em] text-bone leading-none">
            DSLANG<span className="text-crimson">.</span>
          </a>
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide-2 text-grey px-2 hidden sm:inline">{user?.email}</span>
            <a
              href={linkHref('/')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] uppercase tracking-wide-2 font-medium text-bone-dim hover:text-crimson rounded transition-colors"
            >
              <ExternalLink size={12} /> Site
            </a>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] uppercase tracking-wide-2 font-medium text-bone-dim hover:text-crimson rounded transition-colors"
            >
              <LogOut size={12} /> Out
            </button>
          </div>
        </div>
        <div className="flex gap-1 px-3 pb-2 overflow-x-auto no-scrollbar items-stretch">
          <button
            onClick={() => { setTab('products'); setEditingId(null); setCreating(false); }}
            className={`shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold rounded transition-colors ${
              tab === 'products' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <LayoutGrid size={13} strokeWidth={1.8} /> Products
          </button>
          <button
            onClick={() => { setTab('hero'); setEditingId(null); setCreating(false); }}
            className={`shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold rounded transition-colors ${
              tab === 'hero' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <ImageIcon size={13} strokeWidth={1.8} /> Homepage
          </button>
          <button
            onClick={() => { setTab('settings'); setEditingId(null); setCreating(false); }}
            className={`shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold rounded transition-colors ${
              tab === 'settings' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <SettingsIcon size={13} strokeWidth={1.8} /> Settings
          </button>
          <button
            onClick={() => { setTab('orders'); setEditingId(null); setCreating(false); }}
            className={`shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold rounded transition-colors ${
              tab === 'orders' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <ShoppingBag size={13} strokeWidth={1.8} /> Orders
          </button>
          <button
            onClick={() => { setTab('promos'); setEditingId(null); setCreating(false); }}
            className={`shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold rounded transition-colors ${
              tab === 'promos' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <Ticket size={13} strokeWidth={1.8} /> Promo Codes
          </button>
        </div>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 shrink-0 border-r border-line bg-paper-2 flex-col sticky top-0 h-screen">
        <div className="px-5 py-6 border-b border-line">
          <a href={linkHref('/')} className="font-brand text-2xl tracking-[0.03em] text-bone leading-none">
            DSLANG<span className="text-crimson">.</span>
          </a>
          <p className="mt-1 font-label text-[10px] uppercase tracking-wide-2 text-grey">Admin Panel</p>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          <button
            onClick={() => { setTab('products'); setEditingId(null); setCreating(false); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded transition-colors ${
              tab === 'products' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <LayoutGrid size={16} strokeWidth={1.8} /> Products
          </button>
          <button
            onClick={() => { setTab('hero'); setEditingId(null); setCreating(false); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded transition-colors ${
              tab === 'hero' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <ImageIcon size={16} strokeWidth={1.8} /> Homepage
          </button>
          <button
            onClick={() => { setTab('settings'); setEditingId(null); setCreating(false); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded transition-colors ${
              tab === 'settings' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <SettingsIcon size={16} strokeWidth={1.8} /> Settings
          </button>
          <button
            onClick={() => { setTab('orders'); setEditingId(null); setCreating(false); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded transition-colors ${
              tab === 'orders' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <ShoppingBag size={16} strokeWidth={1.8} /> Orders
          </button>
          <button
            onClick={() => { setTab('promos'); setEditingId(null); setCreating(false); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded transition-colors ${
              tab === 'promos' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <Ticket size={16} strokeWidth={1.8} /> Promo Codes
          </button>
        </nav>

        <div className="p-3 border-t border-line">
          <div className="px-3 py-2 text-xs text-grey truncate">
            {user?.email ?? 'admin'}
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-bone-dim hover:text-crimson rounded transition-colors hover:bg-paper-2"
          >
            <LogOut size={16} strokeWidth={1.8} /> Sign out
          </button>
          <a
            href={linkHref('/')}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-bone-dim hover:text-crimson rounded transition-colors hover:bg-paper-2"
          >
            <ExternalLink size={16} strokeWidth={1.8} /> View site
          </a>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-paper-2/95 backdrop-blur-md border-b border-line px-4 sm:px-6 h-12 sm:h-14 flex items-center justify-between gap-3">
          <h1 className="font-display text-lg sm:text-2xl tracking-wide-2 text-bone uppercase">
            {tab === 'products' ? 'Products' : tab === 'hero' ? 'Homepage' : tab === 'settings' ? 'Settings' : tab === 'orders' ? 'Orders' : 'Promo Codes'}
          </h1>
          {tab === 'products' && !creating && !editingProduct && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 sm:gap-2 bg-crimson text-white text-[10px] sm:text-[11px] uppercase tracking-wide-2 font-semibold px-3 sm:px-4 py-2 sm:py-2.5 hover:bg-crimson-dark transition-colors rounded"
            >
              <Plus size={14} strokeWidth={2} /> New Product
            </button>
          )}
          {tab === 'hero' && !creating && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 sm:gap-2 bg-crimson text-white text-[10px] sm:text-[11px] uppercase tracking-wide-2 font-semibold px-3 sm:px-4 py-2 sm:py-2.5 hover:bg-crimson-dark transition-colors rounded"
            >
              <Plus size={14} strokeWidth={2} /> New Slide
            </button>
          )}
        </header>

        <div className="p-3 sm:p-5 md:p-6">
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
              <ProductList
                products={products}
                onEdit={(id) => setEditingId(id)}
                onDelete={(id) => runAction(async () => { await adminDeleteProduct(id); await loadProducts(); }, 'Could not delete this product.')}
              />
            )
          )}

          {tab === 'hero' && (
            creating ? (
              <HeroForm
                ctaReady={heroCtaReady}
                onSave={(slide) => runAction(async () => { await adminCreateHero(slide); await loadHero(); setCreating(false); }, 'Could not create this slide.')}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <HeroList
                slides={heroSlides}
                onUpdate={(id, patch) => runAction(async () => { await adminUpdateHero(id, patch); await loadHero(); }, 'Could not save this slide.')}
                onDelete={(id) => runAction(async () => { await adminDeleteHero(id); await loadHero(); }, 'Could not delete this slide.')}
                ctaReady={heroCtaReady}
              />
            )
          )}

          {tab === 'settings' && <SettingsPanel />}

          {tab === 'orders' && <RetailOrdersPanel />}

          {tab === 'promos' && <PromoPanel />}
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
}: {
  products: CatalogProduct[] | null;
  onEdit: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  if (products === null) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="text-center py-24 border border-line rounded bg-paper-2">
        <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No products yet</p>
        <p className="mt-3 text-sm text-grey">Create your first product to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 sm:space-y-3">
      {products.map((p) => {
        const primary = p.colors[0];
        const isPublished = p.published !== false;
        const retailPrice = getRetailPrice(p);
        const mrp = getMrp(p);
        return (
          <div
            key={p.id}
            className={`bg-paper-2 border border-line rounded hover:border-line-2 transition-colors overflow-hidden ${!isPublished ? 'opacity-70' : ''}`}
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
                    <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-green-600/10 text-green-400 px-2 py-0.5 rounded">Visible</span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-grey/15 text-grey px-2 py-0.5 rounded">Hidden</span>
                  )}
                  {p.featured && (
                    <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-crimson/10 text-crimson px-2 py-0.5 rounded">Featured</span>
                  )}
                  {p.new_drop && (
                    <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-bone/10 text-bone px-2 py-0.5 rounded">New Drop</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => onEdit(p.id)}
                  className="text-[10px] sm:text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-crimson transition-colors px-2.5 sm:px-3 py-1.5 sm:py-2 border border-line rounded hover:border-crimson"
                >
                  Edit
                </button>
                <button
                  onClick={() => { if (confirm(`Delete "${p.name}"? This cannot be undone.`)) onDelete(p.id); }}
                  className="text-grey hover:text-crimson transition-colors p-1.5 sm:p-2"
                  aria-label="Delete product"
                >
                  <Trash2 size={15} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
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
    badge: null,
    featured: true,
    published: true,
    new_drop: false,
    sort_order: 99,
    moq: null,
    wholesale_price_50: null,
    wholesale_price_100: null,
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
    <form onSubmit={submit} className="max-w-2xl space-y-5 bg-paper-2 border border-line rounded p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl sm:text-2xl tracking-wide-2 text-bone uppercase">New Product</h2>
        <button type="button" onClick={onCancel} className="text-grey hover:text-bone transition-colors">
          <X size={20} />
        </button>
      </div>

      <div>
        <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey font-semibold mb-3 border-b border-line pb-2">Product</h3>
        <div className="space-y-4">
          <Field label="Slug" hint="URL-friendly, no spaces">
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="fallen-halo-tee" className={inputCls} />
          </Field>
          <Field label="Product Name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Fallen Halo Tee" className={inputCls} />
          </Field>
          <Field label="Code">
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="DSL-FH-01" className={inputCls} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Field label="Category">
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls}>
                <option value="tee">Tee</option>
                <option value="hoodie">Hoodie</option>
                <option value="jogger">Jogger</option>
                <option value="tank">Tank</option>
                <option value="drop">Drop</option>
              </select>
            </Field>
            <div className="hidden sm:block" />
          </div>
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
              <input type="checkbox" checked={form.published} onChange={(e) => setForm({ ...form, published: e.target.checked })} className="w-4 h-4 accent-crimson" />
              <span className="text-sm text-bone-dim">Published (visible to shoppers)</span>
            </label>
          )}
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} className="w-4 h-4 accent-crimson" />
            <span className="text-sm text-bone-dim">Featured on homepage</span>
          </label>
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.new_drop} onChange={(e) => setForm({ ...form, new_drop: e.target.checked })} className="w-4 h-4 accent-crimson" />
            <span className="text-sm text-bone-dim">New Drop</span>
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50">
          <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Create Product'}
        </button>
        <button type="button" onClick={onCancel} className="text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-bone transition-colors px-4 py-3">
          Cancel
        </button>
      </div>
      <p className="text-xs text-grey pt-2 border-t border-line">
        After creating, add colors with images, then sizes with stock. Buyers shop retail per piece (M / L / XL).
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
    badge: product.badge,
    featured: product.featured,
    published: product.published !== false,
    new_drop: product.new_drop === true,
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
      <form onSubmit={submit} className="max-w-2xl space-y-5 bg-paper-2 border border-line rounded p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl sm:text-2xl tracking-wide-2 text-bone uppercase">Edit Product</h2>
          <button type="button" onClick={onCancel} className="text-grey hover:text-bone transition-colors">
            <X size={20} />
          </button>
        </div>

        <div>
          <h3 className="font-label text-[11px] uppercase tracking-wide-2 text-grey font-semibold mb-3 border-b border-line pb-2">Product</h3>
          <div className="space-y-4">
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
              <input type="checkbox" checked={form.published ?? true} onChange={(e) => setForm({ ...form, published: e.target.checked })} className="w-4 h-4 accent-crimson" />
              <span className="text-sm text-bone-dim">Published (visible to shoppers)</span>
            </label>
          )}
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.featured ?? false} onChange={(e) => setForm({ ...form, featured: e.target.checked })} className="w-4 h-4 accent-crimson" />
            <span className="text-sm text-bone-dim">Featured</span>
          </label>
          <label className="flex items-end gap-2">
            <input type="checkbox" checked={form.new_drop ?? false} onChange={(e) => setForm({ ...form, new_drop: e.target.checked })} className="w-4 h-4 accent-crimson" />
            <span className="text-sm text-bone-dim">New Drop</span>
          </label>
        </div>
        </div>

        {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

        <div className="flex items-center gap-3 pt-2">
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50">
            <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Save Changes'}
          </button>
          {saved && <span className="text-sm text-green-400 flex items-center gap-1"><Check size={16} /> Saved</span>}
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
      await adminAddColor(product.id, newName.trim(), newHex, imgs);
      setNewName(''); setNewHex('#000000'); setNewImages(''); setAdding(false);
      await onChanged();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not add this color.'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteColor = async (id: string) => {
    if (!confirm('Delete this color and all its images?')) return;
    setUploadError('');
    try {
      await adminDeleteColor(id);
      await onChanged();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not delete this color.'));
    }
  };

  const handleSaveColor = async (id: string, name: string, hex: string, images: string[]) => {
    setUploadError('');
    try {
      await adminUpdateColor(id, { name, hex, images });
      await onChanged();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not save this color.'));
    }
  };

  return (
    <div className="max-w-2xl bg-paper-2 border border-line rounded p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-lg sm:text-xl tracking-wide-2 text-bone uppercase">Colors & Images</h3>
        <button
          onClick={() => setAdding(!adding)}
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
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
            <button onClick={handleAdd} disabled={busy || !newName.trim()} className="bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded hover:bg-crimson-dark disabled:opacity-50">
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button onClick={() => setAdding(false)} className="text-[11px] uppercase tracking-wide-2 text-bone-dim px-4 py-2">Cancel</button>
          </div>
          {uploadError && <p className="text-sm text-crimson">{uploadError}</p>}
          {ratioWarning && <p className="text-sm text-amber-400">{ratioWarning}</p>}
        </div>
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
        <button onClick={onDelete} className="text-grey hover:text-crimson p-1">
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
              className="inline-flex items-center gap-1.5 bg-bone text-ink text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded hover:bg-ink transition-colors disabled:opacity-50"
            >
              <Save size={14} /> {saving ? 'Saving…' : 'Save Color'}
            </button>
            {saved && <span className="text-sm text-green-400 flex items-center gap-1"><Check size={16} /> Saved</span>}
          </div>
          {uploadError && <p className="text-sm text-crimson">{uploadError}</p>}
          {ratioWarning && <p className="text-sm text-amber-400">{ratioWarning}</p>}
          {images.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {images.map((img, index) => (
                <div key={img} className={`relative aspect-[4/5] overflow-hidden border bg-paper-3 ${selectedImage === img ? 'border-crimson ring-1 ring-crimson' : 'border-line'}`}>
                  <button type="button" onClick={() => { setSelectedImage(img); setIsImageViewerOpen(true); }} className="absolute inset-0 cursor-zoom-in" aria-label={`Zoom image ${index + 1}`}>
                    <img src={img} alt={`${name} ${index + 1}`} className="h-full w-full object-cover" />
                  </button>
                  {index === 0 && <span className="absolute left-1 top-1 bg-crimson px-1.5 py-1 text-[8px] font-semibold uppercase tracking-wide-2 text-white">Primary</span>}
                  <div className="absolute inset-x-0 bottom-0 flex justify-between bg-bone/90 p-1 text-ink">
                    <button type="button" disabled={index === 0} onClick={() => moveImage(index, -1)} className="px-1.5 text-xs disabled:opacity-30" aria-label="Move image earlier">←</button>
                    <button type="button" onClick={() => removeImage(img)} className="px-1.5 text-xs hover:text-crimson" aria-label="Remove image"><Trash2 size={13} /></button>
                    <button type="button" disabled={index === images.length - 1} onClick={() => moveImage(index, 1)} className="px-1.5 text-xs disabled:opacity-30" aria-label="Move image later">→</button>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-grey">Upload or add an image URL. The first image becomes the primary product image.</p>}
          {selectedImage && (
            <div className="rounded border border-line bg-paper-2 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Selected image preview</p>
                <button type="button" onClick={() => setIsImageViewerOpen(true)} className="text-[10px] font-semibold uppercase tracking-wide-2 text-crimson hover:text-crimson-dark">Open full size</button>
              </div>
              <img src={selectedImage} alt={`${name} selected`} className="max-h-80 w-full object-contain" />
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

  const buildDrafts = (p: CatalogProduct): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = {};
    for (const c of p.colors) {
      const row: Record<string, number> = {};
      for (const s of getSizesForColor(p, c.id)) {
        row[s.size_label] = Math.max(0, Math.floor(Number(s.stock ?? 0)));
      }
      out[c.id] = row;
    }
    return out;
  };

  const [drafts, setDrafts] = useState<Record<string, Record<string, number>>>(() => buildDrafts(product));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDrafts(buildDrafts(product));
    setSaved(false);
    setError('');
  }, [product]);

  const sizeOrderIndex = (label: string): number => {
    const i = SIZE_LABELS.indexOf(label as (typeof SIZE_LABELS)[number]);
    return i === -1 ? 999 : i;
  };

  const sizeLabels = Array.from(
    new Set<string>(colors.flatMap((c) => getSizesForColor(product, c.id).map((s) => s.size_label)))
  ).sort((a, b) => sizeOrderIndex(a) - sizeOrderIndex(b));

  const hasSizes = sizeLabels.length > 0 && colors.length > 0;

  const handleSave = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const jobs: Promise<void>[] = [];
      for (const c of colors) {
        const sizes = getSizesForColor(product, c.id);
        for (const s of sizes) {
          jobs.push(adminSetSizeStock(product.id, c.id, s.size_label, drafts[c.id]?.[s.size_label] ?? 0));
        }
      }
      await Promise.all(jobs);
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
    <div className="max-w-2xl bg-paper-2 border border-line rounded p-4 sm:p-6">
      <div className="mb-4">
        <h3 className="font-display text-lg sm:text-xl tracking-wide-2 text-bone uppercase">Inventory</h3>
        <p className="text-xs text-grey mt-0.5">Manage stock by color and size.</p>
      </div>

      {!hasSizes ? (
        <p className="text-sm text-grey">Add sizes to your colors in the database (or check the product's size chart) to manage stock.</p>
      ) : (
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
                          className="w-full max-w-[4.5rem] bg-paper-2 border border-line px-2.5 py-2 text-sm text-center text-bone focus:border-crimson focus:outline-none rounded"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-grey mt-2">0 means sold out. Stock is tracked separately for every product color and size.</p>
          <div className="flex items-center gap-3 pt-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="inline-flex items-center gap-1.5 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-2.5 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50"
            >
              <Save size={14} /> {busy ? 'Saving…' : 'Save Stock'}
            </button>
            {saved && <span className="text-sm text-green-400 flex items-center gap-1"><Check size={16} /> Saved</span>}
            {error && <span className="text-sm text-crimson">{error}</span>}
          </div>
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
    <div className="max-w-2xl bg-paper-2 border border-line rounded p-4 sm:p-6">
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
          className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50"
        >
          <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Save Color Order'}
        </button>
        {saved && <span className="text-sm text-green-400 flex items-center gap-1"><Check size={16} /> Saved</span>}
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
  ctaReady,
}: {
  slides: HeroSlideRow[] | null;
  onUpdate: (id: string, patch: Partial<Omit<HeroSlideRow, 'id' | 'created_at'>>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  ctaReady: boolean;
}) {
  if (slides === null) {
    return <div className="h-32 bg-paper-3 border border-line rounded animate-pulse" />;
  }

  if (slides.length === 0) {
    return (
      <div className="text-center py-24 border border-line rounded bg-paper-2">
        <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No hero slides</p>
        <p className="mt-3 text-sm text-grey">Add a slide to show on the homepage hero.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {slides.map((s) => (
        <HeroRow key={s.id} slide={s} ctaReady={ctaReady} onUpdate={(patch) => onUpdate(s.id, patch)} onDelete={() => onDelete(s.id)} />
      ))}
    </div>
  );
}

function HeroRow({
  slide,
  onUpdate,
  onDelete,
  ctaReady,
}: {
  slide: HeroSlideRow;
  onUpdate: (patch: Partial<Omit<HeroSlideRow, 'id' | 'created_at'>>) => Promise<void>;
  onDelete: () => Promise<void>;
  ctaReady: boolean;
}) {
  const [image_url, setImageUrl] = useState(slide.image_url);
  const [eyebrow, setEyebrow] = useState(slide.eyebrow);
  const [title, setTitle] = useState(slide.title);
  const [subtitle, setSubtitle] = useState(slide.subtitle);
  const [cta_text, setCtaText] = useState(slide.cta_text ?? '');
  const [cta_url, setCtaUrl] = useState(slide.cta_url ?? '');
  const [sort_order, setSortOrder] = useState(slide.sort_order);
  const [active, setActive] = useState(slide.active);
  const [expanded, setExpanded] = useState(false);
  const [saved, setSaved] = useState(false);
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
    await onUpdate({ image_url, eyebrow, title, subtitle, sort_order, active, cta_text, cta_url });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="bg-paper-2 border border-line rounded overflow-hidden">
      <div className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4">
        <div className="w-14 sm:w-20 h-10 sm:h-14 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
          {image_url && <img src={image_url} alt={title} className="w-full h-full object-cover" />}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-bone truncate">{title || 'Untitled slide'}</h3>
          <p className="text-xs text-grey truncate">{eyebrow}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[9px] sm:text-[10px] uppercase tracking-wide-2 font-semibold px-1.5 sm:px-2 py-0.5 sm:py-1 rounded ${
            active ? 'bg-green-950/60 text-green-400' : 'bg-paper-2 text-grey'
          }`}>
            {active ? 'Active' : 'Hidden'}
          </span>
          <span className="text-[10px] sm:text-xs text-grey hidden sm:inline">Order: {sort_order}</span>
          <button onClick={() => setExpanded(!expanded)} className="text-grey hover:text-bone p-1">
            <ChevronDown size={15} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <button onClick={() => { if (confirm('Delete this slide?')) onDelete(); }} className="text-grey hover:text-crimson p-1">
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
          <Field label="Eyebrow">
            <input value={eyebrow} onChange={(e) => setEyebrow(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Title" hint="Use \n for line breaks">
            <textarea value={title} onChange={(e) => setTitle(e.target.value)} rows={2} className={inputCls} />
          </Field>
          <Field label="Subtitle">
            <textarea value={subtitle} onChange={(e) => setSubtitle(e.target.value)} rows={2} className={inputCls} />
          </Field>
          {ctaReady && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 border-t border-line pt-3">
              <Field label="CTA Button Text" hint="Leave blank for default">
                <input value={cta_text} onChange={(e) => setCtaText(e.target.value)} className={inputCls} placeholder="View Collection" />
              </Field>
              <Field label="CTA Button URL" hint="https://... or internal (#/route)">
                <input value={cta_url} onChange={(e) => setCtaUrl(e.target.value)} className={inputCls} placeholder="#/collection" />
              </Field>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <Field label="Sort Order">
              <NumInput value={sort_order} onChange={(n) => setSortOrder(n ?? 0)} className={inputCls} />
            </Field>
            <label className="flex items-end gap-2 pb-3">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-crimson" />
              <span className="text-sm text-bone-dim">Active (show on homepage)</span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={save} className="inline-flex items-center gap-1.5 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-crimson-dark transition-colors">
              <Save size={14} /> Save Slide
            </button>
            {saved && <span className="text-sm text-green-400 flex items-center gap-1"><Check size={16} /> Saved</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Hero Create Form ---- */

function HeroForm({
  onSave,
  onCancel,
  ctaReady,
}: {
  onSave: (slide: Omit<HeroSlideRow, 'id' | 'created_at'>) => Promise<void>;
  onCancel: () => void;
  ctaReady: boolean;
}) {
  const [form, setForm] = useState({
    image_url: '',
    eyebrow: '',
    title: '',
    subtitle: '',
    cta_text: '',
    cta_url: '',
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
    <form onSubmit={submit} className="max-w-2xl space-y-5 bg-paper-2 border border-line rounded p-4 sm:p-6">
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
      <Field label="Eyebrow" hint="Small text above the title">
        <input value={form.eyebrow} onChange={(e) => setForm({ ...form, eyebrow: e.target.value })} placeholder="New Arrivals" className={inputCls} />
      </Field>
      <Field label="Title" hint="Use \n for line breaks">
        <textarea value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} rows={2} placeholder="Wear The\nStruggle" className={inputCls} />
      </Field>
      <Field label="Subtitle">
        <textarea value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} rows={2} className={inputCls} />
      </Field>
      {ctaReady && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 border-t border-line pt-4">
          <Field label="CTA Button Text" hint="Leave blank for default">
            <input value={form.cta_text} onChange={(e) => setForm({ ...form, cta_text: e.target.value })} className={inputCls} placeholder="View Collection" />
          </Field>
          <Field label="CTA Button URL" hint="https://... or internal (#/route)">
            <input value={form.cta_url} onChange={(e) => setForm({ ...form, cta_url: e.target.value })} className={inputCls} placeholder="#/collection" />
          </Field>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <Field label="Sort Order">
          <NumInput value={form.sort_order} onChange={(n) => setForm({ ...form, sort_order: n ?? 0 })} className={inputCls} />
        </Field>
        <label className="flex items-end gap-2 pb-3">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="w-4 h-4 accent-crimson" />
          <span className="text-sm text-bone-dim">Active</span>
        </label>
      </div>

      {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50">
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

const inputCls = 'w-full px-3 py-2.5 bg-paper-2 border border-line text-bone text-sm rounded placeholder:text-grey focus:outline-none focus:border-crimson transition-colors';

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
    <form onSubmit={submit} className="max-w-3xl space-y-5">
      {!loaded && <div className="h-24 bg-paper-3 border border-line rounded animate-pulse" />}

      <div className="bg-paper-2 border border-line rounded p-4 sm:p-6 space-y-4">
        <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">Store Settings</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="Flat Shipping (₹)" hint="Charged on retail orders">
            <NumInput value={form.shipping_flat_rate} onChange={(n) => patch({ shipping_flat_rate: n ?? 0 })} className={inputCls} />
          </Field>
        </div>
      </div>

      <div className="bg-paper-2 border border-line rounded p-4 sm:p-6 space-y-4">
        <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">Contact & Storefront</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="WhatsApp Number" hint="Digits only, country code first (e.g. 9199...)">
            <input value={form.whatsapp_number} onChange={(e) => patch({ whatsapp_number: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Dispatch Note">
            <input value={form.dispatch_note} onChange={(e) => patch({ dispatch_note: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Delivery Note">
            <input value={form.delivery_note} onChange={(e) => patch({ delivery_note: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Announcement Text">
            <input value={form.announcement_text} onChange={(e) => patch({ announcement_text: e.target.value })} className={inputCls} />
          </Field>
        </div>
        <label className="flex items-end gap-2">
          <input type="checkbox" checked={form.announcement_active} onChange={(e) => patch({ announcement_active: e.target.checked })} className="w-4 h-4 accent-crimson" />
          <span className="text-sm text-bone-dim">Show announcement bar</span>
        </label>
      </div>

      {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy || !loaded} className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50">
          <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span className="text-sm text-green-400 flex items-center gap-1"><Check size={16} /> Saved</span>}
        <span className="text-xs text-grey ml-auto">These apply instantly on the live storefront.</span>
      </div>
    </form>
  );
}

/* ---- Retail Orders ---- */

const PAYMENT_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-950/60 text-amber-300' },
  success: { label: 'Success', cls: 'bg-green-600/10 text-green-400' },
  paid: { label: 'Paid', cls: 'bg-green-600/10 text-green-400' },
  failed: { label: 'Failed', cls: 'bg-crimson/10 text-crimson' },
  cancelled: { label: 'Cancelled', cls: 'bg-grey/15 text-grey' },
  refunded: { label: 'Refunded', cls: 'bg-grey/15 text-grey' },
};

const ORDER_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-950/60 text-amber-300' },
  processing: { label: 'Processing', cls: 'bg-sky-950/50 text-sky-300' },
  shipped: { label: 'Shipped', cls: 'bg-indigo-950/50 text-indigo-300' },
  delivered: { label: 'Delivered', cls: 'bg-green-600/10 text-green-400' },
  cancelled: { label: 'Cancelled', cls: 'bg-crimson/10 text-crimson' },
  refunded: { label: 'Refunded', cls: 'bg-grey/15 text-grey' },
};

const ORDER_STATUS_FLOW = ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'] as const;

function formatOrderDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function RetailOrdersPanel() {
  const [orders, setOrders] = useState<RetailOrder[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { settings } = useSiteSettings();

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setOrders(await adminFetchRetailOrders());
    } catch (err) {
      setOrders([]);
      setLoadError(err instanceof Error ? err.message : describeSupabaseError(err, 'Could not load retail orders.'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const copyRef = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
    } catch {
      /* clipboard unavailable — the ref is still visible in the UI */
    }
  };

  const whatsappLink = (order: RetailOrder) => {
    const number = (settings.whatsapp_number ?? '').replace(/\D/g, '') || '919944676178';
    const lines = [
      `DSLANG Order ${order.ref}`,
      `Total ${order.total_qty} items — ${formatPrice(order.total_amount)}`,
      '',
      ...order.items.map((it) => `${it.name} ${it.color} ${it.size_label} × ${it.quantity} (${formatPrice(it.line_total)})`),
      '',
      `Name: ${order.customer.name} · ${order.customer.phone}`,
      `Address: ${order.customer.address}, ${order.customer.city}, ${order.customer.state} ${order.customer.pincode}`,
      `Payment: ${PAYMENT_STATUS_LABEL[order.payment_status]?.label ?? order.payment_status}`,
    ];
    return `https://wa.me/${number}?text=${encodeURIComponent(lines.join('\n'))}`;
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

  if (orders === null) {
    return <div className="min-h-[40vh] flex items-center justify-center"><LoadingDots /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-grey">
          {orders.length === 0 ? 'No retail orders yet.' : `${orders.length} retail order${orders.length === 1 ? '' : 's'} — newest first.`}
        </p>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-crimson border border-line rounded px-3 py-2 transition-colors"
        >
          <ShoppingBag size={13} strokeWidth={1.8} /> Refresh
        </button>
      </div>

      {loadError && <div className="bg-crimson/5 border border-crimson/20 text-crimson text-sm px-4 py-3 rounded">{loadError}</div>}

      {actionMessage && (
        <div className="flex items-center gap-2 bg-green-950/50 border border-green-900/70 text-green-400 text-sm px-4 py-3 rounded">
          <Check size={14} strokeWidth={2.5} /> {actionMessage}
        </div>
      )}

      {orders.length === 0 && !loadError && (
        <div className="text-center py-24 border border-line rounded bg-paper-2">
          <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No retail orders</p>
          <p className="mt-3 text-sm text-grey">Orders placed on the retail storefront will appear here.</p>
        </div>
      )}

      {orders.map((o) => {
        const isOpen = expanded === o.id;
        const pay = PAYMENT_STATUS_LABEL[o.payment_status];
        return (
          <div key={o.id} className="bg-paper-2 border border-line rounded overflow-hidden">
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
                  {pay && <span className={`text-[10px] uppercase tracking-wide-2 font-semibold px-2 py-0.5 rounded ${pay.cls}`}>{pay.label}</span>}
                </div>
                <p className="text-xs text-grey mt-0.5 truncate">{o.customer.name} · {o.customer.phone}</p>
                <p className="text-[11px] text-grey/70 mt-0.5">{formatOrderDate(o.created_at)}</p>
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
                  <div className="bg-paper-2 border border-line rounded p-3 sm:p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mb-2">Customer</p>
                    <div className="space-y-1.5 text-sm text-bone">
                      <p className="flex items-center gap-2"><Phone size={13} className="text-grey" /> {o.customer.name} · {o.customer.phone}</p>
                      {o.customer.email && <p className="text-grey text-xs">{o.customer.email}</p>}
                      <p className="text-grey text-xs">{o.customer.address}, {o.customer.city}, {o.customer.state} — {o.customer.pincode}</p>
                    </div>
                  </div>
                  <div className="bg-paper-2 border border-line rounded p-3 sm:p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mb-2">Totals</p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-bone-dim">Subtotal</span><span className="font-medium text-bone">{formatPrice(o.subtotal)}</span></div>
                      {Number(o.discount) > 0 && (
                        <div className="flex justify-between"><span className="text-bone-dim">Discount</span><span className="font-medium text-green-400">−{formatPrice(o.discount)}</span></div>
                      )}
                      <div className="flex justify-between"><span className="text-bone-dim">Shipping</span><span className="font-medium text-bone">{formatPrice(o.shipping)}</span></div>
                      <div className="flex justify-between border-t border-line pt-1"><span className="text-bone">Total</span><span className="font-semibold text-bone">{formatPrice(o.total_amount)}</span></div>
                      <div className="flex justify-between text-xs text-grey"><span>Qty</span><span>{o.total_qty}</span></div>
                      {o.promo_code && <div className="flex justify-between text-xs text-grey"><span>Promo</span><span>{o.promo_code}</span></div>}
                    </div>
                  </div>
                </div>

                <div className="bg-paper-2 border border-line rounded p-3 sm:p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mb-2">Items ({o.items.length})</p>
                  <div className="divide-y divide-line">
                    {o.items.map((it, i) => (
                      <div key={`${it.product_id}-${it.color_id}-${it.size_label}-${i}`} className="flex items-center gap-3 py-2">
                        <div className="w-6 h-6 rounded border border-line shrink-0" style={{ backgroundColor: it.color_hex }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-bone truncate">{it.name}</p>
                          <p className="text-[11px] text-grey">{it.code} · {it.color} · {it.size_label}</p>
                        </div>
                        <span className="text-sm text-bone-dim">× {it.quantity}</span>
                        <span className="text-sm font-medium text-bone">{formatPrice(it.line_total)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <a
                    href={whatsappLink(o)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-green-600 text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-green-700 transition-colors"
                  >
                    <Phone size={14} strokeWidth={2} /> Confirm on WhatsApp
                  </a>
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
                        const { error } = await supabase
                          .from('retail_orders')
                          .update({ order_status: next })
                          .eq('id', o.id);
                        if (error) {
                          setLoadError(describeSupabaseError(error, 'Could not update order status.'));
                          return;
                        }
                        load();
                      }}
                      className="border border-line bg-paper-2 px-2 py-1.5 text-sm text-bone rounded focus:border-crimson focus:outline-none"
                    >
                      {ORDER_STATUS_FLOW.map((s) => (
                        <option key={s} value={s}>
                          {ORDER_STATUS_LABEL[s].label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="flex justify-end border-t border-line pt-3">
                  <button
                    type="button"
                    onClick={() => { setDeleteError(''); setConfirmDelete(o); }}
                    className="inline-flex items-center gap-2 border border-crimson/40 text-crimson bg-paper-2 hover:bg-crimson/5 text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded transition-colors"
                  >
                    <Trash2 size={14} strokeWidth={2} /> Delete Order
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => !deleting && setConfirmDelete(null)} />
          <div className="relative w-full max-w-sm bg-paper-2 border border-line rounded-lg p-5 sm:p-6 shadow-xl">
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
                className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-crimson/90 transition-colors disabled:opacity-50"
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

  const remove = async (p: PromoRow) => {
    if (!confirm(`Delete promo "${p.code}"? This cannot be undone.`)) return;
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
          className="inline-flex items-center gap-1.5 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-3 py-2 rounded hover:bg-crimson-dark transition-colors"
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
        <div className="text-center py-24 border border-line rounded bg-paper-2">
          <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No promo codes</p>
          <p className="mt-3 text-sm text-grey">Create a code like WELCOME10 to offer shoppers a discount.</p>
        </div>
      )}

      {promos.map((p) => {
        const expired = p.expires_at && new Date(p.expires_at).getTime() < Date.now();
        const usable = p.active && !expired && (p.max_uses === null || p.used_count < p.max_uses);
        return (
          <div key={p.id} className="bg-paper-2 border border-line rounded p-3 sm:p-4 flex items-center gap-3 sm:gap-4">
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
              usable ? 'bg-green-600/10 text-green-400' : 'bg-grey/15 text-grey'
            }`}>
              {usable ? 'Active' : expired ? 'Expired' : 'Disabled'}
            </span>
            <button
              onClick={() => toggleActive(p)}
              className="shrink-0 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-crimson border border-line rounded px-2.5 py-1.5 transition-colors"
            >
              {p.active ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => { setEditing(p); setCreating(false); }}
              className="shrink-0 text-[10px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-crimson px-2 py-1.5 border border-line rounded hover:border-crimson transition-colors"
            >
              Edit
            </button>
            <button onClick={() => remove(p)} className="text-grey hover:text-crimson p-1.5" aria-label="Delete promo code">
              <Trash2 size={15} strokeWidth={1.8} />
            </button>
          </div>
        );
      })}
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

  const inputCls = 'w-full border border-line bg-paper-2 px-2.5 py-2 text-sm text-bone focus:border-crimson focus:outline-none rounded';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    const value = Math.max(0, Number(form.discount_value) || 0);
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
    <form onSubmit={submit} className="bg-paper-2 border border-line rounded p-4 sm:p-5 space-y-4">
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
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="w-4 h-4 accent-crimson" />
        Active — redeemable at checkout
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button type="submit" disabled={saving} className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-crimson-dark transition-colors disabled:opacity-60">
          {saving ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save Promo'}
        </button>
        <button type="button" onClick={onCancel} className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-crimson border border-line rounded px-5 py-3 transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}




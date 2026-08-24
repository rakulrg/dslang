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
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { linkHref } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';
import { preloadImage } from '@/lib/image';
import {
  adminFetchProducts,
  adminFetchHero,
  adminCreateProduct,
  adminUpdateProduct,
  adminDeleteProduct,
  adminAddColor,
  adminUpdateColor,
  adminDeleteColor,
  adminUpdateSizeStock,
  adminInitColorSizes,
  adminUpdateSizeChartRow,
  adminUpdateColorSortOrders,
  adminCreateHero,
  adminUpdateHero,
  adminDeleteHero,
  uploadProductImage,
  uploadHeroImage,
  type ProductInput,
} from '@/lib/admin';
import type { CatalogProduct, HeroSlideRow, ProductColorRow, ProductSizeRow, SizeChartRow } from '@/lib/types';
import { SIZE_LABELS } from '@/lib/types';

type Tab = 'products' | 'hero';

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

  const loadProducts = useCallback(async () => {
    try {
      setLoadError('');
      setProducts(await adminFetchProducts());
    } catch (err) {
      setProducts([]);
      setLoadError(err instanceof Error ? err.message : 'Failed to load products');
    }
  }, []);

  const loadHero = useCallback(async () => {
    try {
      setLoadError('');
      setHeroSlides(await adminFetchHero());
    } catch (err) {
      setHeroSlides([]);
      setLoadError(err instanceof Error ? err.message : 'Failed to load hero slides');
    }
  }, []);

  useEffect(() => {
    loadProducts();
    loadHero();
  }, [loadProducts, loadHero]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.hash = '#/';
  };

  const editingProduct = products?.find((p) => p.id === editingId) ?? null;

  return (
    <div className="min-h-screen bg-paper-2 flex flex-col lg:flex-row">
      {/* Mobile header */}
      <div className="lg:hidden w-full shrink-0 bg-white border-b border-line">
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
        <div className="flex gap-1 px-3 pb-2">
          <button
            onClick={() => { setTab('products'); setEditingId(null); setCreating(false); }}
            className={`flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold rounded transition-colors ${
              tab === 'products' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <LayoutGrid size={13} strokeWidth={1.8} /> Products
          </button>
          <button
            onClick={() => { setTab('hero'); setEditingId(null); setCreating(false); }}
            className={`flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold rounded transition-colors ${
              tab === 'hero' ? 'bg-crimson text-white' : 'text-bone-dim hover:bg-paper-2'
            }`}
          >
            <ImageIcon size={13} strokeWidth={1.8} /> Hero Slides
          </button>
        </div>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 shrink-0 border-r border-line bg-white flex-col sticky top-0 h-screen">
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
            <ImageIcon size={16} strokeWidth={1.8} /> Hero Slides
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
        <header className="sticky top-0 z-10 bg-white/95 backdrop-blur-md border-b border-line px-4 sm:px-6 h-12 sm:h-14 flex items-center justify-between gap-3">
          <h1 className="font-display text-lg sm:text-2xl tracking-wide-2 text-bone uppercase">
            {tab === 'products' ? 'Products' : 'Hero Slides'}
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
          {tab === 'products' && (
            creating ? (
              <ProductForm
                onSave={async (input) => { await adminCreateProduct(input); await loadProducts(); setCreating(false); }}
                onCancel={() => setCreating(false)}
              />
            ) : editingProduct ? (
              <ProductEditor
                product={editingProduct}
                onSave={async (id, input) => { await adminUpdateProduct(id, input); await loadProducts(); setEditingId(null); }}
                onCancel={() => setEditingId(null)}
                onChanged={loadProducts}
              />
            ) : (
              <ProductList
                products={products}
                onEdit={(id) => setEditingId(id)}
                onDelete={async (id) => { await adminDeleteProduct(id); await loadProducts(); }}
              />
            )
          )}

          {tab === 'hero' && (
            creating ? (
              <HeroForm
                onSave={async (slide) => { await adminCreateHero(slide); await loadHero(); setCreating(false); }}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <HeroList
                slides={heroSlides}
                onUpdate={async (id, patch) => { await adminUpdateHero(id, patch); await loadHero(); }}
                onDelete={async (id) => { await adminDeleteHero(id); await loadHero(); }}
              />
            )
          )}
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
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-paper-3 border border-line rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="text-center py-24 border border-line rounded bg-white">
        <p className="font-label text-3xl uppercase tracking-wide-2 text-grey">No products yet</p>
        <p className="mt-3 text-sm text-grey">Create your first product to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 sm:space-y-3">
      {products.map((p) => {
        const primary = p.colors[0];
        return (
          <div
            key={p.id}
            className="bg-white border border-line rounded hover:border-line-2 transition-colors overflow-hidden"
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
                  <span className="font-medium">{formatPrice(p.price)}</span>
                  {p.mrp && <span className="line-through text-grey">{formatPrice(p.mrp)}</span>}
                  <span className="text-grey">·</span>
                  <span>{p.colors.length} colors</span>
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
            {(p.featured) && (
              <div className="flex flex-wrap gap-1.5 px-3 sm:px-4 pb-3 sm:pb-4 pt-0">
                {p.featured && (
                  <span className="text-[10px] uppercase tracking-wide-2 font-semibold bg-crimson/10 text-crimson px-2 py-0.5 rounded">Featured</span>
                )}
              </div>
            )}
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
}: {
  onSave: (input: ProductInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ProductInput>({
    slug: '',
    name: '',
    code: '',
    drop_label: '',
    price: 0,
    mrp: null,
    fabric: 'Premium Combed Cotton',
    fit: 'Boxy Fit',
    care: 'Cold wash inside out. Do not bleach. Iron print inside out. Hang dry.',
    description: '',
    category: 'tee',
    badge: null,
    featured: true,
    sort_order: 99,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.slug || !form.name || !form.code || form.price <= 0) {
      setError('Slug, name, code, and price are required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-5 bg-white border border-line rounded p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl sm:text-2xl tracking-wide-2 text-bone uppercase">New Product</h2>
        <button type="button" onClick={onCancel} className="text-grey hover:text-bone transition-colors">
          <X size={20} />
        </button>
      </div>

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
        <Field label="Price (₹)">
          <NumInput value={form.price} onChange={(n) => setForm({ ...form, price: n ?? 0 })} className={inputCls} />
        </Field>
        <Field label="MRP (₹)" hint="Optional — for discount display">
          <NumInput value={form.mrp} onChange={(n) => setForm({ ...form, mrp: n })} className={inputCls} placeholder="—" />
        </Field>
      </div>
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
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <Field label="Fabric">
          <input value={form.fabric} onChange={(e) => setForm({ ...form, fabric: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Fit">
          <input value={form.fit} onChange={(e) => setForm({ ...form, fit: e.target.value })} className={inputCls} />
        </Field>
      </div>
      <Field label="Care Instructions">
        <textarea value={form.care} onChange={(e) => setForm({ ...form, care: e.target.value })} rows={2} className={inputCls} />
      </Field>
      <Field label="Description">
        <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className={inputCls} />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <Field label="Sort Order">
          <NumInput value={form.sort_order} onChange={(n) => setForm({ ...form, sort_order: n ?? 0 })} className={inputCls} />
        </Field>
        <label className="flex items-end gap-2 pb-3">
          <input type="checkbox" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} className="w-4 h-4 accent-crimson" />
          <span className="text-sm text-bone-dim">Featured on homepage</span>
        </label>
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
        Default sizes (M–XL) and a size chart will be created automatically. You can edit them after creating the product.
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
}: {
  product: CatalogProduct;
  onSave: (id: string, input: Partial<ProductInput>) => Promise<void>;
  onCancel: () => void;
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState<Partial<ProductInput>>({
    slug: product.slug,
    name: product.name,
    code: product.code,
    drop_label: product.drop_label,
    price: product.price,
    mrp: product.mrp,
    fabric: product.fabric,
    fit: product.fit,
    care: product.care,
    description: product.description,
    category: product.category,
    badge: product.badge,
    featured: product.featured,
    sort_order: product.sort_order,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await onSave(product.id, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="max-w-2xl space-y-5 bg-white border border-line rounded p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl sm:text-2xl tracking-wide-2 text-bone uppercase">Edit Product</h2>
          <button type="button" onClick={onCancel} className="text-grey hover:text-bone transition-colors">
            <X size={20} />
          </button>
        </div>

        <Field label="Slug" hint="Cannot be changed after creation">
          <input value={form.slug ?? ''} disabled className={inputCls + ' opacity-60 cursor-not-allowed'} />
        </Field>
        <Field label="Product Name">
          <input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Code">
          <input value={form.code ?? ''} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="Price (₹)">
            <NumInput value={form.price ?? 0} onChange={(n) => setForm({ ...form, price: n ?? 0 })} className={inputCls} />
          </Field>
          <Field label="MRP (₹)">
            <NumInput value={form.mrp ?? null} onChange={(n) => setForm({ ...form, mrp: n })} className={inputCls} placeholder="—" />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="Fabric">
            <input value={form.fabric ?? ''} onChange={(e) => setForm({ ...form, fabric: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Fit">
            <input value={form.fit ?? ''} onChange={(e) => setForm({ ...form, fit: e.target.value })} className={inputCls} />
          </Field>
        </div>
        <Field label="Care">
          <textarea value={form.care ?? ''} onChange={(e) => setForm({ ...form, care: e.target.value })} rows={2} className={inputCls} />
        </Field>
        <Field label="Description">
          <textarea value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <Field label="Sort Order">
            <NumInput value={form.sort_order ?? 0} onChange={(n) => setForm({ ...form, sort_order: n ?? 0 })} className={inputCls} />
          </Field>
          <label className="flex items-end gap-2 pb-3">
            <input type="checkbox" checked={form.featured ?? false} onChange={(e) => setForm({ ...form, featured: e.target.checked })} className="w-4 h-4 accent-crimson" />
            <span className="text-sm text-bone-dim">Featured</span>
          </label>
        </div>

        {error && <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>}

        <div className="flex items-center gap-3 pt-2">
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50">
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

      {/* Color priority */}
      <ColorPriorityManager product={product} onChanged={onChanged} />

      {/* Sizes section */}
      <SizeManager product={product} onChanged={onChanged} />

      {/* Size chart section */}
      <SizeChartManager product={product} onChanged={onChanged} />
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
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
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
      setUploadError(err instanceof Error ? err.message : 'Could not add this color.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteColor = async (id: string) => {
    if (!confirm('Delete this color and all its images?')) return;
    await adminDeleteColor(id);
    await onChanged();
  };

  const handleSaveColor = async (id: string, name: string, hex: string, images: string[]) => {
    await adminUpdateColor(id, { name, hex, images });
    await onChanged();
  };

  return (
    <div className="max-w-2xl bg-white border border-line rounded p-4 sm:p-6">
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
          {ratioWarning && <p className="text-sm text-amber-600">{ratioWarning}</p>}
        </div>
      )}

      <div className="space-y-4">
        {colors.map((c) => (
          <ColorRow key={c.id} color={c} onDelete={() => handleDeleteColor(c.id)} onSave={(name, hex, images) => handleSaveColor(c.id, name, hex, images)} />
        ))}
        {colors.length === 0 && <p className="text-sm text-grey">No colors yet. Add one with images.</p>}
      </div>
    </div>
  );
}

function ColorRow({ color, onDelete, onSave }: { color: ProductColorRow; onDelete: () => void; onSave: (name: string, hex: string, images: string[]) => Promise<void> }) {
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
      setUploadError(err instanceof Error ? err.message : 'Could not save image changes.');
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
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
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
                <div key={img} className={`relative aspect-[4/5] overflow-hidden border bg-paper-3 ${selectedImage === img ? 'border-crimson ring-1 ring-crimson' : 'border-line'}`}>
                  <button type="button" onClick={() => { setSelectedImage(img); setIsImageViewerOpen(true); }} className="absolute inset-0 cursor-zoom-in" aria-label={`Zoom image ${index + 1}`}>
                    <img src={img} alt={`${name} ${index + 1}`} className="h-full w-full object-cover" />
                  </button>
                  {index === 0 && <span className="absolute left-1 top-1 bg-crimson px-1.5 py-1 text-[8px] font-semibold uppercase tracking-wide-2 text-white">Primary</span>}
                  <div className="absolute inset-x-0 bottom-0 flex justify-between bg-bone/85 p-1 text-white">
                    <button type="button" disabled={index === 0} onClick={() => moveImage(index, -1)} className="px-1.5 text-xs disabled:opacity-30" aria-label="Move image earlier">←</button>
                    <button type="button" onClick={() => removeImage(img)} className="px-1.5 text-xs hover:text-crimson" aria-label="Remove image"><Trash2 size={13} /></button>
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
      setError(err instanceof Error ? err.message : 'Could not save color order.');
    } finally {
      setBusy(false);
    }
  };

  if (orderedColors.length < 2) return null;

  return (
    <div className="max-w-2xl bg-white border border-line rounded p-4 sm:p-6">
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
        {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
        {error && <span className="text-sm text-crimson">{error}</span>}
      </div>
    </div>
  );
}

/* ---- Size Manager (color-wise stock) ---- */

function SizeManager({ product, onChanged }: { product: CatalogProduct; onChanged: () => Promise<void> }) {
  const colors = product.colors;
  const [selectedColorIdx, setSelectedColorIdx] = useState(0);
  const [stockValues, setStockValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const selectedColor = colors[selectedColorIdx] ?? colors[0];
  const colorSizes = selectedColor
    ? product.sizes
        .filter((s) => s.color_id === selectedColor.id)
        .sort((a, b) => (SIZE_LABELS.indexOf(a.size_label as typeof SIZE_LABELS[number]) ?? 99) - (SIZE_LABELS.indexOf(b.size_label as typeof SIZE_LABELS[number]) ?? 99))
    : [];

  useEffect(() => {
    setStockValues(Object.fromEntries(colorSizes.map((s) => [s.size_label, String(Number(s.stock ?? 0))])));
  }, [selectedColor?.id, product.sizes]);

  const saveAll = async () => {
    if (!selectedColor) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      for (const s of colorSizes) {
        const nextStock = Math.max(0, Math.floor(Number(stockValues[s.size_label]) || 0));
        if (nextStock !== Number(s.stock ?? 0)) {
          await adminUpdateSizeStock(product.id, selectedColor.id, s.size_label, nextStock);
        }
      }
      await onChanged();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      console.error('Stock save failed:', err);
      setError(err instanceof Error ? err.message : 'Could not save stock.');
    } finally {
      setBusy(false);
    }
  };

  const autoInitSizes = async () => {
    if (!selectedColor || colorSizes.length > 0) return;
    try {
      await adminInitColorSizes(product.id, selectedColor.id);
      await onChanged();
    } catch (err) {
      console.error('Auto-init sizes failed:', err);
    }
  };

  useEffect(() => {
    autoInitSizes();
  }, [selectedColor?.id, colorSizes.length]);

  return (
    <div className="max-w-2xl bg-white border border-line rounded p-4 sm:p-6">
      <h3 className="font-display text-lg sm:text-xl tracking-wide-2 text-bone uppercase mb-4">Sizes &amp; Availability</h3>

      {/* Color selector */}
      {colors.length > 0 && (
        <div className="mb-5">
          <p className="text-[11px] uppercase tracking-wide-2 text-grey mb-2">Select Color</p>
          <div className="flex flex-wrap gap-2">
            {colors.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedColorIdx(i)}
                className={`flex items-center gap-2 px-3 py-2 border rounded text-sm font-medium transition-colors ${
                  i === selectedColorIdx
                    ? 'bg-bone text-white border-bone'
                    : 'bg-paper-2 text-bone-dim border-line hover:border-bone-dim'
                }`}
              >
                <span className="w-4 h-4 rounded border border-line shrink-0" style={{ backgroundColor: c.hex }} />
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedColor && (
        <p className="text-xs uppercase tracking-wide-2 text-grey mb-3">Selected: {selectedColor.name}</p>
      )}

      {/* Size stock table */}
      {colorSizes.length > 0 ? (
        <div className="mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide-2 text-grey border-b border-line">
                <th className="text-left py-2 pr-4 font-medium">Size</th>
                <th className="text-right py-2 pl-4 font-medium">Stock</th>
              </tr>
            </thead>
            <tbody>
              {colorSizes.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className="py-2.5 pr-4 text-bone font-medium">{s.size_label}</td>
                  <td className="py-2.5 pl-4 text-right">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={stockValues[s.size_label] ?? ''}
                      onChange={(e) => setStockValues((current) => ({ ...current, [s.size_label]: e.target.value }))}
                      onWheel={(e) => e.currentTarget.blur()}
                      disabled={busy}
                      placeholder="0"
                      className="w-20 text-right rounded border border-line bg-white px-2 py-1.5 text-sm text-bone outline-none disabled:opacity-50"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : colors.length === 0 ? (
        <p className="text-sm text-grey py-4">Add a color first, then configure sizes.</p>
      ) : (
        <p className="text-sm text-grey py-4">Loading sizes…</p>
      )}

      {/* Actions */}
      {colorSizes.length > 0 && (
        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={saveAll}
            disabled={busy}
            className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50"
          >
            <Save size={15} strokeWidth={2} /> {busy ? 'Saving…' : 'Save Stock'}
          </button>
          {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
        </div>
      )}

      <p className="mt-4 text-xs text-grey">Stock is per color + size. Availability is automatic: stock above 0 opens the size; 0 marks it sold out.</p>
      {error && <p className="mt-2 text-sm text-crimson">{error}</p>}
    </div>
  );
}

/* ---- Size Chart Manager ---- */

function SizeChartManager({ product, onChanged }: { product: CatalogProduct; onChanged: () => Promise<void> }) {
  const [chart, setChart] = useState<SizeChartRow[]>(product.size_chart);

  useEffect(() => {
    setChart(product.size_chart);
  }, [product.size_chart]);

  const updateRow = (row: SizeChartRow, field: 'chest' | 'length' | 'shoulder', value: number) => {
    setChart((prev) => prev.map((r) => r.id === row.id ? { ...r, [field]: value } : r));
  };

  const saveRow = async (row: SizeChartRow) => {
    await adminUpdateSizeChartRow(row.id, Number(row.chest), Number(row.length), Number(row.shoulder));
    await onChanged();
  };

  return (
    <div className="max-w-2xl bg-white border border-line rounded p-4 sm:p-6">
      <h3 className="font-display text-lg sm:text-xl tracking-wide-2 text-bone uppercase mb-4">Size Chart</h3>
      {chart.length > 0 ? (
        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <table className="w-full text-sm min-w-[400px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide-2 text-grey border-b border-line">
                <th className="text-left py-2 pr-3 sm:pr-4 font-medium">Size</th>
                <th className="text-left py-2 pr-3 sm:pr-4 font-medium">Chest (in)</th>
                <th className="text-left py-2 pr-3 sm:pr-4 font-medium">Length (in)</th>
                <th className="text-left py-2 pr-3 sm:pr-4 font-medium">Shoulder (in)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {chart.map((r) => (
                <tr key={r.id} className="border-b border-line">
                  <td className="py-2 pr-3 sm:pr-4 font-medium text-bone">{r.size_label}</td>
                  <td className="py-2 pr-3 sm:pr-4">
                    <NumInput value={r.chest} onChange={(n) => updateRow(r, 'chest', n ?? 0)} className="w-16 sm:w-20 px-2 py-1 border border-line rounded text-sm" />
                  </td>
                  <td className="py-2 pr-3 sm:pr-4">
                    <NumInput value={r.length} onChange={(n) => updateRow(r, 'length', n ?? 0)} className="w-16 sm:w-20 px-2 py-1 border border-line rounded text-sm" />
                  </td>
                  <td className="py-2 pr-3 sm:pr-4">
                    <NumInput value={r.shoulder} onChange={(n) => updateRow(r, 'shoulder', n ?? 0)} className="w-16 sm:w-20 px-2 py-1 border border-line rounded text-sm" />
                  </td>
                  <td className="py-2">
                    <button onClick={() => saveRow(r)} className="text-crimson hover:text-crimson-dark" aria-label="Save row">
                      <Save size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-grey">No size chart rows. They are created automatically when you add a product.</p>
      )}
      <p className="mt-3 text-xs text-grey">Edit values and click the save icon to update each row.</p>
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
  const [eyebrow, setEyebrow] = useState(slide.eyebrow);
  const [title, setTitle] = useState(slide.title);
  const [subtitle, setSubtitle] = useState(slide.subtitle);
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
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const save = async () => {
    await onUpdate({ image_url, eyebrow, title, subtitle, sort_order, active });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="bg-white border border-line rounded overflow-hidden">
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
            active ? 'bg-green-100 text-green-700' : 'bg-paper-2 text-grey'
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
            {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check size={16} /> Saved</span>}
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
}: {
  onSave: (slide: Omit<HeroSlideRow, 'id' | 'created_at'>) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    image_url: '',
    eyebrow: '',
    title: '',
    subtitle: '',
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
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
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
      setError(err instanceof Error ? err.message : 'Failed to create slide');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-5 bg-white border border-line rounded p-4 sm:p-6">
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

  const commit = () => {
    if (raw === '' || raw === '-') {
      lastRef.current = null;
      setRaw('');
      onChange(null);
    } else {
      const n = Math.max(0, Math.floor(Number(raw)));
      lastRef.current = n;
      setRaw(String(n));
      onChange(n);
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onWheel={(e) => e.currentTarget.blur()}
      placeholder={placeholder}
      className={className}
      {...rest}
    />
  );
}

const inputCls = 'w-full px-3 py-2.5 bg-white border border-line text-bone text-sm rounded placeholder:text-grey focus:outline-none focus:border-crimson transition-colors';

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

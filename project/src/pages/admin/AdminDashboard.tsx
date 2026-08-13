import { useEffect, useState, useCallback } from 'react';
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
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { linkHref } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';
import {
  adminFetchProducts,
  adminFetchHero,
  adminCreateProduct,
  adminUpdateProduct,
  adminDeleteProduct,
  adminAddColor,
  adminUpdateColor,
  adminDeleteColor,
  adminToggleSize,
  adminUpdateSizeChartRow,
  adminCreateHero,
  adminUpdateHero,
  adminDeleteHero,
  type ProductInput,
} from '@/lib/admin';
import type { CatalogProduct, HeroSlideRow, ProductColorRow, ProductSizeRow, SizeChartRow } from '@/lib/types';
import { SIZE_LABELS } from '@/lib/types';

type Tab = 'products' | 'hero';

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
    <div className="min-h-screen bg-paper-2 flex">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-line bg-white flex flex-col sticky top-0 h-screen">
        <div className="px-5 py-6 border-b border-line">
          <a href={linkHref('/')} className="font-display text-2xl tracking-wide-2 text-bone leading-none">
            DSLANG<span className="text-crimson">.</span>
          </a>
          <p className="mt-1 text-[10px] uppercase tracking-wide-2 text-grey">Admin Panel</p>
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
        <header className="sticky top-0 z-10 bg-white/95 backdrop-blur-md border-b border-line px-6 md:px-8 h-16 flex items-center justify-between">
          <h1 className="font-display text-2xl tracking-wide-2 text-bone uppercase">
            {tab === 'products' ? 'Products' : 'Hero Slides'}
          </h1>
          {tab === 'products' && !creating && !editingProduct && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 hover:bg-crimson-dark transition-colors rounded"
            >
              <Plus size={15} strokeWidth={2} /> New Product
            </button>
          )}
          {tab === 'hero' && !creating && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 hover:bg-crimson-dark transition-colors rounded"
            >
              <Plus size={15} strokeWidth={2} /> New Slide
            </button>
          )}
        </header>

        <div className="p-6 md:p-8">
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
        <p className="font-condensed text-3xl uppercase tracking-wide-2 text-grey">No products yet</p>
        <p className="mt-3 text-sm text-grey">Create your first product to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {products.map((p) => {
        const primary = p.colors[0];
        return (
          <div
            key={p.id}
            className="flex items-center gap-4 bg-white border border-line rounded p-4 hover:border-line-2 transition-colors"
          >
            <div className="w-14 h-16 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
              {primary && primary.images[0] && (
                <img src={primary.images[0]} alt={p.name} className="w-full h-full object-cover" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-bone truncate">{p.name}</h3>
              <p className="text-[11px] uppercase tracking-wide-2 text-grey mt-0.5">{p.code}</p>
              <div className="mt-1 flex items-center gap-3 text-xs text-bone-soft">
                <span>{formatPrice(p.price)}</span>
                {p.mrp && <span className="line-through text-grey">{formatPrice(p.mrp)}</span>}
                <span className="text-grey">·</span>
                <span>{p.colors.length} colors</span>
                {p.badge && (
                  <>
                    <span className="text-grey">·</span>
                    <span className="text-crimson font-medium">{p.badge}</span>
                  </>
                )}
                {p.featured && (
                  <>
                    <span className="text-grey">·</span>
                    <span className="text-crimson font-medium">Featured</span>
                  </>
                )}
              </div>
            </div>
            <button
              onClick={() => onEdit(p.id)}
              className="text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-crimson transition-colors px-3 py-2 border border-line rounded hover:border-crimson"
            >
              Edit
            </button>
            <button
              onClick={() => { if (confirm(`Delete "${p.name}"? This cannot be undone.`)) onDelete(p.id); }}
              className="text-grey hover:text-crimson transition-colors p-2"
              aria-label="Delete product"
            >
              <Trash2 size={16} strokeWidth={1.8} />
            </button>
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
    drop_label: 'Drop 01',
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
    <form onSubmit={submit} className="max-w-2xl space-y-5 bg-white border border-line rounded p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-2xl tracking-wide-2 text-bone uppercase">New Product</h2>
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
      <div className="grid grid-cols-2 gap-4">
        <Field label="Price (₹)">
          <input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} className={inputCls} />
        </Field>
        <Field label="MRP (₹)" hint="Optional — for discount display">
          <input type="number" value={form.mrp ?? ''} onChange={(e) => setForm({ ...form, mrp: e.target.value ? Number(e.target.value) : null })} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Category">
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls}>
            <option value="tee">Tee</option>
            <option value="hoodie">Hoodie</option>
            <option value="jogger">Jogger</option>
            <option value="tank">Tank</option>
            <option value="drop">Drop</option>
          </select>
        </Field>
        <Field label="Drop Label">
          <input value={form.drop_label} onChange={(e) => setForm({ ...form, drop_label: e.target.value })} className={inputCls} />
        </Field>
      </div>
      <Field label="Badge" hint="Optional — e.g. Best Seller, New, Limited Run">
        <input value={form.badge ?? ''} onChange={(e) => setForm({ ...form, badge: e.target.value || null })} placeholder="Best Seller" className={inputCls} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
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
      <div className="grid grid-cols-2 gap-4">
        <Field label="Sort Order">
          <input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} className={inputCls} />
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
        Default sizes (S–XXL) and a size chart will be created automatically. You can edit them after creating the product.
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
      <form onSubmit={submit} className="max-w-2xl space-y-5 bg-white border border-line rounded p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-2xl tracking-wide-2 text-bone uppercase">Edit Product</h2>
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
        <div className="grid grid-cols-2 gap-4">
          <Field label="Price (₹)">
            <input type="number" value={form.price ?? 0} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} className={inputCls} />
          </Field>
          <Field label="MRP (₹)">
            <input type="number" value={form.mrp ?? ''} onChange={(e) => setForm({ ...form, mrp: e.target.value ? Number(e.target.value) : null })} className={inputCls} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Category">
            <select value={form.category ?? 'tee'} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls}>
              <option value="tee">Tee</option>
              <option value="hoodie">Hoodie</option>
              <option value="jogger">Jogger</option>
              <option value="tank">Tank</option>
              <option value="drop">Drop</option>
            </select>
          </Field>
          <Field label="Drop Label">
            <input value={form.drop_label ?? ''} onChange={(e) => setForm({ ...form, drop_label: e.target.value })} className={inputCls} />
          </Field>
        </div>
        <Field label="Badge">
          <input value={form.badge ?? ''} onChange={(e) => setForm({ ...form, badge: e.target.value || null })} placeholder="Best Seller" className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
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
        <div className="grid grid-cols-2 gap-4">
          <Field label="Sort Order">
            <input type="number" value={form.sort_order ?? 0} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} className={inputCls} />
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

      {/* Sizes section */}
      <SizeManager product={product} onChanged={onChanged} />

      {/* Size chart section */}
      <SizeChartManager product={product} onChanged={onChanged} />
    </div>
  );
}

/* ---- Color Manager ---- */

function ColorManager({ product, onChanged }: { product: CatalogProduct; onChanged: () => Promise<void> }) {
  const [colors, setColors] = useState<ProductColorRow[]>(product.colors);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newHex, setNewHex] = useState('#000000');
  const [newImages, setNewImages] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await onChanged();
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const imgs = newImages.split('\n').map((s) => s.trim()).filter(Boolean);
      await adminAddColor(product.id, newName.trim(), newHex, imgs);
      setNewName(''); setNewHex('#000000'); setNewImages(''); setAdding(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteColor = async (id: string) => {
    if (!confirm('Delete this color and all its images?')) return;
    await adminDeleteColor(id);
    await refresh();
  };

  const handleSaveColor = async (c: ProductColorRow, images: string) => {
    const imgs = images.split('\n').map((s) => s.trim()).filter(Boolean);
    await adminUpdateColor(c.id, { name: c.name, hex: c.hex, images: imgs });
    await refresh();
  };

  return (
    <div className="max-w-2xl bg-white border border-line rounded p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-xl tracking-wide-2 text-bone uppercase">Colors & Images</h3>
        <button
          onClick={() => setAdding(!adding)}
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide-2 font-semibold text-crimson hover:text-crimson-dark transition-colors"
        >
          <Plus size={14} strokeWidth={2} /> Add Color
        </button>
      </div>

      {adding && (
        <div className="mb-4 border border-line rounded p-4 bg-paper-2 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Color name (e.g. Black)" className={inputCls} />
            <div className="flex items-center gap-2">
              <input type="color" value={newHex} onChange={(e) => setNewHex(e.target.value)} className="w-12 h-10 border border-line rounded cursor-pointer" />
              <input value={newHex} onChange={(e) => setNewHex(e.target.value)} className={inputCls} />
            </div>
          </div>
          <textarea value={newImages} onChange={(e) => setNewImages(e.target.value)} placeholder="Image URLs (one per line)" rows={3} className={inputCls} />
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={busy || !newName.trim()} className="bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded hover:bg-crimson-dark disabled:opacity-50">
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button onClick={() => setAdding(false)} className="text-[11px] uppercase tracking-wide-2 text-bone-dim px-4 py-2">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {colors.map((c) => (
          <ColorRow key={c.id} color={c} onDelete={() => handleDeleteColor(c.id)} onSave={(images) => handleSaveColor(c, images)} />
        ))}
        {colors.length === 0 && <p className="text-sm text-grey">No colors yet. Add one with images.</p>}
      </div>
    </div>
  );
}

function ColorRow({ color, onDelete, onSave }: { color: ProductColorRow; onDelete: () => void; onSave: (images: string) => void }) {
  const [name, setName] = useState(color.name);
  const [hex, setHex] = useState(color.hex);
  const [images, setImages] = useState(color.images.join('\n'));
  const [expanded, setExpanded] = useState(false);

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
        <div className="border-t border-line p-4 space-y-3 bg-paper-2">
          <div className="grid grid-cols-2 gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            <div className="flex items-center gap-2">
              <input type="color" value={hex} onChange={(e) => setHex(e.target.value)} className="w-10 h-9 border border-line rounded cursor-pointer" />
              <input value={hex} onChange={(e) => setHex(e.target.value)} className={inputCls} />
            </div>
          </div>
          <textarea value={images} onChange={(e) => setImages(e.target.value)} placeholder="Image URLs (one per line)" rows={4} className={inputCls} />
          <div className="flex flex-wrap gap-2">
            {color.images.map((img, i) => (
              <div key={i} className="w-16 h-20 overflow-hidden border border-line rounded bg-paper-3">
                <img src={img} alt={`${name} ${i + 1}`} className="w-full h-full object-cover" />
              </div>
            ))}
          </div>
          <button
            onClick={() => { adminUpdateColor(color.id, { name, hex }); onSave(images); }}
            className="inline-flex items-center gap-1.5 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2 rounded hover:bg-ink transition-colors"
          >
            <Save size={14} /> Save Color
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- Size Manager ---- */

function SizeManager({ product, onChanged }: { product: CatalogProduct; onChanged: () => Promise<void> }) {
  const [sizes, setSizes] = useState<ProductSizeRow[]>(product.sizes);

  const toggle = async (s: ProductSizeRow) => {
    const updated = !s.available;
    setSizes((prev) => prev.map((x) => x.id === s.id ? { ...x, available: updated } : x));
    await adminToggleSize(s.id, updated);
    await onChanged();
  };

  return (
    <div className="max-w-2xl bg-white border border-line rounded p-6">
      <h3 className="font-display text-xl tracking-wide-2 text-bone uppercase mb-4">Sizes & Availability</h3>
      <div className="flex flex-wrap gap-3">
        {sizes.map((s) => (
          <button
            key={s.id}
            onClick={() => toggle(s)}
            className={`flex items-center gap-2 px-4 py-3 border rounded transition-all ${
              s.available
                ? 'bg-bone text-white border-bone'
                : 'bg-paper-2 text-grey border-line line-through'
            }`}
          >
            {s.available && <Check size={14} />}
            <span className="text-sm font-medium">{s.size_label}</span>
          </button>
        ))}
        {sizes.length === 0 && <p className="text-sm text-grey">No sizes configured.</p>}
      </div>
      <p className="mt-4 text-xs text-grey">Click a size to toggle availability. Unavailable sizes show as crossed out on the product page.</p>
    </div>
  );
}

/* ---- Size Chart Manager ---- */

function SizeChartManager({ product, onChanged }: { product: CatalogProduct; onChanged: () => Promise<void> }) {
  const [chart, setChart] = useState<SizeChartRow[]>(product.size_chart);

  const updateRow = async (row: SizeChartRow, field: 'chest' | 'length' | 'shoulder', value: number) => {
    setChart((prev) => prev.map((r) => r.id === row.id ? { ...r, [field]: value } : r));
  };

  const saveRow = async (row: SizeChartRow) => {
    await adminUpdateSizeChartRow(row.id, Number(row.chest), Number(row.length), Number(row.shoulder));
    await onChanged();
  };

  return (
    <div className="max-w-2xl bg-white border border-line rounded p-6">
      <h3 className="font-display text-xl tracking-wide-2 text-bone uppercase mb-4">Size Chart</h3>
      {chart.length > 0 ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide-2 text-grey border-b border-line">
              <th className="text-left py-2 pr-4 font-medium">Size</th>
              <th className="text-left py-2 pr-4 font-medium">Chest (in)</th>
              <th className="text-left py-2 pr-4 font-medium">Length (in)</th>
              <th className="text-left py-2 pr-4 font-medium">Shoulder (in)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {chart.map((r) => (
              <tr key={r.id} className="border-b border-line">
                <td className="py-2 pr-4 font-medium text-bone">{r.size_label}</td>
                <td className="py-2 pr-4">
                  <input type="number" value={Number(r.chest)} onChange={(e) => updateRow(r, 'chest', Number(e.target.value))} className="w-20 px-2 py-1 border border-line rounded text-sm" />
                </td>
                <td className="py-2 pr-4">
                  <input type="number" value={Number(r.length)} onChange={(e) => updateRow(r, 'length', Number(e.target.value))} className="w-20 px-2 py-1 border border-line rounded text-sm" />
                </td>
                <td className="py-2 pr-4">
                  <input type="number" value={Number(r.shoulder)} onChange={(e) => updateRow(r, 'shoulder', Number(e.target.value))} className="w-20 px-2 py-1 border border-line rounded text-sm" />
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
        <p className="font-condensed text-3xl uppercase tracking-wide-2 text-grey">No hero slides</p>
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

  const save = async () => {
    await onUpdate({ image_url, eyebrow, title, subtitle, sort_order, active });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="bg-white border border-line rounded overflow-hidden">
      <div className="flex items-center gap-4 p-4">
        <div className="w-20 h-14 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
          <img src={image_url} alt={title} className="w-full h-full object-cover" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-bone truncate">{title || 'Untitled slide'}</h3>
          <p className="text-xs text-grey truncate">{eyebrow}</p>
        </div>
        <span className={`text-[10px] uppercase tracking-wide-2 font-semibold px-2 py-1 rounded ${
          active ? 'bg-green-100 text-green-700' : 'bg-paper-2 text-grey'
        }`}>
          {active ? 'Active' : 'Hidden'}
        </span>
        <span className="text-xs text-grey">Order: {sort_order}</span>
        <button onClick={() => setExpanded(!expanded)} className="text-grey hover:text-bone p-1">
          <ChevronDown size={16} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        <button onClick={() => { if (confirm('Delete this slide?')) onDelete(); }} className="text-grey hover:text-crimson p-1">
          <Trash2 size={15} />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-line p-4 bg-paper-2 space-y-3">
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sort Order">
              <input type="number" value={sort_order} onChange={(e) => setSortOrder(Number(e.target.value))} className={inputCls} />
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
    <form onSubmit={submit} className="max-w-2xl space-y-5 bg-white border border-line rounded p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-2xl tracking-wide-2 text-bone uppercase">New Hero Slide</h2>
        <button type="button" onClick={onCancel} className="text-grey hover:text-bone transition-colors">
          <X size={20} />
        </button>
      </div>

      <Field label="Image URL">
        <input value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="https://images.pexels.com/..." className={inputCls} />
      </Field>
      <Field label="Eyebrow" hint="Small text above the title">
        <input value={form.eyebrow} onChange={(e) => setForm({ ...form, eyebrow: e.target.value })} placeholder="Drop 01 — Limited Run" className={inputCls} />
      </Field>
      <Field label="Title" hint="Use \n for line breaks">
        <textarea value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} rows={2} placeholder="Wear The\nStruggle" className={inputCls} />
      </Field>
      <Field label="Subtitle">
        <textarea value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} rows={2} className={inputCls} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Sort Order">
          <input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} className={inputCls} />
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

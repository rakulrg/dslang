import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Pencil, ArrowUpRight, X, Shirt } from 'lucide-react';
import { adminFetchProducts, describeSupabaseError } from '@/lib/admin';
import { supabase } from '@/lib/supabase';
import type { CatalogProduct } from '@/lib/types';
import { LoadingDots } from '@/components/LoadingDots';
import { Panel, ErrorBox, Btn, EmptyState, fmtNum } from '@/pages/admin/OpsUi';

interface CategoryInfo {
  name: string;
  count: number;
  published: number;
  archived: number;
}

function RenameModal({
  category,
  products,
  onClose,
  onSaved,
}: {
  category: CategoryInfo;
  products: CatalogProduct[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState(category.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const next = value.trim().toLowerCase();
    if (!next) {
      setErr('Enter a category name.');
      return;
    }
    const ids = products.filter((p) => p.category === category.name).map((p) => p.id);
    if (ids.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setErr('');
    try {
      if (next === category.name) {
        onClose();
        return;
      }
      let applied = 0;
      for (const id of ids) {
        const { error } = await supabase.from('products').update({ category: next }).eq('id', id);
        if (error) throw error;
        applied += 1;
      }
      await onSaved();
      onClose();
      void applied;
    } catch (e) {
      setErr(e instanceof Error ? e.message : describeSupabaseError(e, 'Could not rename the category.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded border border-line shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">Rename collection</h3>
          <button onClick={onClose} className="text-grey hover:text-bone"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-grey">Applied to all {fmtNum(category.count)} products currently grouped as “{category.name}”.</p>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">New name</label>
            <input value={value} onChange={(e) => setValue(e.target.value)} className="mt-1 w-full border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded focus:border-bone focus:outline-none" />
          </div>
          {err && <ErrorBox message={err} />}
          <button onClick={submit} disabled={busy} className="w-full inline-flex items-center justify-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-3 rounded hover:bg-ink transition-colors disabled:opacity-50">
            {busy ? 'Renaming…' : 'Rename collection'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CollectionsSection({ onOpenProducts }: { onOpenProducts: () => void }) {
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [err, setErr] = useState('');
  const [renaming, setRenaming] = useState<CategoryInfo | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      setProducts(await adminFetchProducts());
    } catch (e) {
      setProducts([]);
      setErr(e instanceof Error ? e.message : describeSupabaseError(e, 'Could not load collections.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const categories = useMemo(() => {
    const map = new Map<string, CategoryInfo>();
    for (const p of products ?? []) {
      const name = p.category?.trim() || 'uncategorised';
      const cur = map.get(name) ?? { name, count: 0, published: 0, archived: 0 };
      cur.count += 1;
      if (p.published === false) cur.archived += 1;
      else cur.published += 1;
      map.set(name, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [products]);

  if (products === null) {
    return <div className="min-h-[40vh] flex items-center justify-center"><LoadingDots /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-grey">
          {fmtNum(categories.length)} collection{ categories.length === 1 ? '' : 's' } — powered by the product “category” field ({fmtNum(products.length)} products).
        </p>
        <Btn onClick={load}><RefreshCw size={13} /> Refresh</Btn>
      </div>

      {err && <ErrorBox message={err} />}

      {categories.length === 0 ? (
        <EmptyState title="No collections yet" sub="Set a category on a product and it will appear here." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {categories.map((c) => (
            <div key={c.name} className="bg-white border border-line rounded p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-display text-xl tracking-wide-2 text-bone uppercase">{c.name}</p>
                  <p className="text-[11px] text-grey">
                    {fmtNum(c.count)} product{ c.count === 1 ? '' : 's'} · {fmtNum(c.published)} live{c.archived > 0 ? ` · ${fmtNum(c.archived)} archived` : ''}
                  </p>
                </div>
                <span className="w-9 h-9 rounded bg-paper-3 border border-line flex items-center justify-center text-bone shrink-0">
                  <Shirt size={16} strokeWidth={1.8} />
                </span>
              </div>
              <div className="flex items-center gap-2 mt-auto">
                <Btn variant="ghost" className="flex-1" onClick={() => setRenaming(c)}>
                  <Pencil size={13} /> Rename
                </Btn>
                <Btn variant="ghost" className="flex-1" onClick={onOpenProducts}>
                  Products <ArrowUpRight size={13} />
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {renaming && (
        <RenameModal
          category={renaming}
          products={products ?? []}
          onClose={() => setRenaming(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { reconcileCartWithLive } from '@/lib/cartStock';
import { getPromo, savePromo, removePromo, promoApplies, type Promo } from '@/lib/promo';

const STORAGE_KEY = 'dslang_retail_cart_v1';

/**
 * Retail / D2C cart.
 * Lines are normal retail SKUs: one item = product + color + size + quantity.
 */

export interface D2cCartItem {
  productId: string;
  slug: string;
  name: string;
  code: string;
  image: string;
  colorId: string;
  color: string;
  colorHex: string;
  sizeLabel: string;
  quantity: number;
  unitPrice: number; // current retail price at add time (₹)
  mrp?: number | null; // compare-at, optional
  stock: number; // stock snapshot for display
  addedAt: number;
}

export interface D2cCartLineInput {
  productId: string;
  slug: string;
  name: string;
  code: string;
  image: string;
  colorId: string;
  color: string;
  colorHex: string;
  sizeLabel: string;
  quantity: number;
  unitPrice: number;
  mrp?: number | null;
  stock: number;
}

export interface CartReconcileResult {
  removedCount: number;
  clampedCount: number;
  changed: boolean;
}

interface D2cCartContextValue {
  items: D2cCartItem[];
  count: number; // total units
  subtotal: number;
  addItem: (line: D2cCartLineInput) => void;
  setQuantity: (index: number, quantity: number) => void;
  removeItem: (index: number) => void;
  clear: () => void;
  isEmpty: boolean;
  /** Reconciles the cart against a live-stock map: drops OOS/vanished variants,
   * clamps quantities above the live stock, and refreshes each item's stock
   * snapshot. Returns a summary of what changed. */
  reconcileWithLiveStock: (live: Record<string, number>) => CartReconcileResult;
  /** Re-reads persisted cart lines from localStorage. Landing on /#/checkout
   * directly (cold load, bookmark, shared link, or a late write from another
   * tab) must reflect whatever cart is stored even when this context booted
   * before the items existed. */
  reloadFromStorage: () => void;
  /** Currently applied promo (single source of truth shared by Cart & Checkout). */
  promo: Promo | null;
  /** Persist + apply a validated promo. */
  applyPromo: (promo: Promo) => void;
  /** Remove the applied promo from both storage and shared state. */
  removeAppliedPromo: () => void;
}

const D2cCartContext = createContext<D2cCartContextValue>({
  items: [],
  count: 0,
  subtotal: 0,
  addItem: () => {},
  setQuantity: () => {},
  removeItem: () => {},
  clear: () => {},
  isEmpty: true,
  reconcileWithLiveStock: () => ({ removedCount: 0, clampedCount: 0, changed: false }),
  reloadFromStorage: () => {},
  promo: null,
  applyPromo: () => {},
  removeAppliedPromo: () => {},
});

function loadCart(): D2cCartItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is D2cCartItem =>
        i &&
        typeof i === 'object' &&
        typeof i.productId === 'string' &&
        typeof i.colorId === 'string' &&
        typeof i.sizeLabel === 'string' &&
        typeof i.quantity === 'number' &&
        Number.isFinite(i.quantity) &&
        i.quantity > 0 &&
        // The line's price is what the whole cart total is built from. A stored
        // value that is missing, non-numeric or negative (legacy schema, a
        // partial write, hand-edited storage) would make every subtotal NaN and
        // render "\u20b9 NaN" on the checkout amounts and CTA, so the line is
        // simply not usable as a cart entry.
        typeof i.unitPrice === 'number' &&
        Number.isFinite(i.unitPrice) &&
        i.unitPrice >= 0
    );
  } catch {
    return [];
  }
}

function sameLine(a: D2cCartItem, b: D2cCartLineInput): boolean {
  return a.productId === b.productId && a.colorId === b.colorId && a.sizeLabel === b.sizeLabel;
}

export function D2cCartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<D2cCartItem[]>(() => loadCart());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // private mode / quota — cart still works in-memory
    }
  }, [items]);

  const addItem = useCallback((line: D2cCartLineInput) => {
    const qty = Math.max(1, Math.floor(line.quantity));
    if (qty === 0 || !line.productId || !line.colorId || !line.sizeLabel) return;
    // Never persist an unusable price: the cart total, the payment cards and the
    // CTA all derive from it, so a NaN here would surface as "\u20b9 NaN".
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) return;
    const cap = Math.max(1, line.stock || 99);
    setItems((prev) => {
      const idx = prev.findIndex((i) => sameLine(i, line));
      if (idx >= 0) {
        const merged = Math.min(prev[idx].quantity + qty, cap);
        return prev.map((i, n) =>
          n === idx
            ? { ...i, quantity: merged, unitPrice: line.unitPrice, stock: line.stock }
            : i
        );
      }
      const next: D2cCartItem = {
        productId: line.productId,
        slug: line.slug,
        name: line.name,
        code: line.code,
        image: line.image,
        colorId: line.colorId,
        color: line.color,
        colorHex: line.colorHex,
        sizeLabel: line.sizeLabel,
        quantity: Math.min(qty, cap),
        unitPrice: line.unitPrice,
        mrp: line.mrp ?? null,
        stock: line.stock,
        addedAt: Date.now(),
      };
      return [...prev, next];
    });
  }, []);

  const setQuantity = useCallback((index: number, quantity: number) => {
    const qty = Math.max(1, Math.floor(quantity));
    if (!Number.isFinite(qty) || qty < 1) return;
    setItems((prev) => {
      const item = prev[index];
      if (!item) return prev;
      const cap = Math.max(1, item.stock || 99);
      return prev.map((i, n) => (n === index ? { ...i, quantity: Math.min(qty, cap) } : i));
    });
  }, []);

  const removeItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const reloadFromStorage = useCallback(() => {
    const fresh = loadCart();
    setItems((prev) => {
      // Never regress a context that already knows about lines the storage
      // read can't see (e.g. a just-added line mid-hydration) — only adopt the
      // stored cart when the context is genuinely stale/empty.
      if (prev.length > 0) return prev;
      return fresh;
    });
  }, []);

  // Cross-tab sync: when a cart change is written in ANOTHER tab (same origin),
  // refresh this context from storage so badges/drawer/checkout always reflect
  // the persisted cart regardless of which tab the user acts in.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setItems(loadCart());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Promo state is owned here (not in the drawer/checkout) so Cart and Checkout
  // always read the SAME applied promo — one source of truth, no stale copies.
  const [promo, setPromo] = useState<Promo | null>(() => getPromo());

  const applyPromo = useCallback((p: Promo) => {
    savePromo(p);
    setPromo(p);
  }, []);

  const removeAppliedPromo = useCallback(() => {
    removePromo();
    setPromo(null);
  }, []);

  const reconcileWithLiveStock = useCallback((live: Record<string, number>): CartReconcileResult => {
    const { items: next, changes } = reconcileCartWithLive(items, live);
    setItems(next);
    return {
      removedCount: changes.removed.length,
      clampedCount: changes.clamped.length,
      changed: changes.changed,
    };
  }, [items]);

  const count = useMemo(() => items.reduce((s, i) => s + i.quantity, 0), [items]);
  const subtotal = useMemo(() => items.reduce((s, i) => s + i.unitPrice * i.quantity, 0), [items]);
  const isEmpty = items.length === 0;

  // Auto-remove the applied promo as soon as the cart no longer satisfies its
  // rules (e.g. an item was removed and subtotal dropped below min_order_value).
  // Because promo lives in this shared context, the removal propagates to
  // BOTH the Cart drawer and Checkout instantly.
  useEffect(() => {
    if (promo && !promoApplies(subtotal, promo)) removeAppliedPromo();
  }, [subtotal, promo, removeAppliedPromo]);

  return (
    <D2cCartContext.Provider
      value={{ items, count, subtotal, addItem, setQuantity, removeItem, clear, isEmpty, reconcileWithLiveStock, promo, applyPromo, removeAppliedPromo, reloadFromStorage }}
    >
      {children}
    </D2cCartContext.Provider>
  );
}

export function useD2cCart() {
  return useContext(D2cCartContext);
}
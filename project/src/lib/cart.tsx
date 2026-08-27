import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { formatPrice, packToQuantities, WHOLESALE_TIER_100 } from '@/lib/catalog';

export interface CartItem {
  productId: string;
  slug: string;
  name: string;
  code: string;
  image: string;
  color: string;
  colorHex: string;
  packs: number; // whole color packs (never fractional)
  m: number; // packs * pack ratio (fixed)
  l: number;
  xl: number;
  qty: number; // packs * pack size
  price50: number;
  price100: number;
}

interface CartContextValue {
  items: CartItem[];
  count: number;
  subtotal: number;
  addItem: (item: Omit<CartItem, 'packs' | 'm' | 'l' | 'xl' | 'qty'>, packs: number) => void;
  removeItem: (index: number) => void;
  updateQty: (index: number, packs: number) => void;
  clear: () => void;
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const CartContext = createContext<CartContextValue>({
  items: [],
  count: 0,
  subtotal: 0,
  addItem: () => {},
  removeItem: () => {},
  updateQty: () => {},
  clear: () => {},
  isOpen: false,
  open: () => {},
  close: () => {},
});

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  const addItem = useCallback((item: Omit<CartItem, 'packs' | 'm' | 'l' | 'xl' | 'qty'>, packs: number) => {
    const whole = Math.max(0, Math.floor(packs));
    if (whole === 0) return;
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.productId === item.productId && i.color === item.color);
      if (idx >= 0) {
        const merged = prev[idx].packs + whole;
        const q = packToQuantities(merged);
        return prev.map((i, n) => (n === idx ? { ...i, ...q } : i));
      }
      const q = packToQuantities(whole);
      return [...prev, { ...item, ...q }];
    });
  }, []);

  const removeItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateQty = useCallback((index: number, packs: number) => {
    const whole = Math.max(1, Math.floor(packs));
    const q = packToQuantities(whole);
    setItems((prev) => prev.map((i, n) => (n === index ? { ...i, ...q } : i)));
  }, []);

  const clear = useCallback(() => setItems([]), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const count = items.reduce((s, i) => s + i.qty, 0);

  /**
   * Wholesale subtotal — the per-piece tier is decided per product by that
   * product's total quantity across all colors (100+ = 100 PCS slab).
   */
  const subtotal = useMemo(() => {
    const byProduct = new Map<string, { qty: number; price50: number; price100: number; amount: number }>();
    for (const item of items) {
      const group = byProduct.get(item.productId) ?? { qty: 0, price50: item.price50, price100: item.price100 ?? 0, amount: 0 };
      group.qty += item.qty;
      byProduct.set(item.productId, group);
    }
    let total = 0;
    for (const [groupId, group] of byProduct) {
      const unit = group.qty >= WHOLESALE_TIER_100 && group.price100 > 0 ? group.price100 : group.price50;
      for (const item of items) {
        if (item.productId === groupId) total += unit * item.qty;
      }
    }
    return total;
  }, [items]);

  return (
    <CartContext.Provider value={{ items, count, subtotal, addItem, removeItem, updateQty, clear, isOpen, open, close }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  return useContext(CartContext);
}

export { formatPrice };
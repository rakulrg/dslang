import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { formatPrice, WHOLESALE_TIER_100 } from '@/lib/catalog';

export interface CartItem {
  productId: string;
  slug: string;
  name: string;
  code: string;
  price: number;
  price50: number;
  price100: number;
  image: string;
  color: string;
  size: string;
  stock: number;
  qty: number;
}

interface CartContextValue {
  items: CartItem[];
  count: number;
  subtotal: number;
  addItem: (item: Omit<CartItem, 'qty'>, qty?: number) => void;
  removeItem: (index: number) => void;
  updateQty: (index: number, qty: number) => void;
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

  const addItem = useCallback((item: Omit<CartItem, 'qty'>, qty = 1) => {
    setItems((prev) => {
      const idx = prev.findIndex(
        (i) => i.productId === item.productId && i.color === item.color && i.size === item.size
      );
      if (idx >= 0) {
        return prev.map((i, n) =>
          n === idx ? { ...i, qty: Math.min(item.stock, i.qty + qty) } : i
        );
      }
      return [...prev, { ...item, qty: Math.min(item.stock, qty) }];
    });
  }, []);

  const removeItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateQty = useCallback((index: number, qty: number) => {
    setItems((prev) =>
      prev.map((i, n) => (n === index ? { ...i, qty: Math.max(1, Math.min(i.stock, qty)) } : i))
    );
  }, []);

  const clear = useCallback(() => setItems([]), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const count = items.reduce((s, i) => s + i.qty, 0);

  /**
   * Wholesale subtotal — the per-piece tier is decided per product by that
   * product's total quantity across all colors/sizes (100+ = ₹100 slab).
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
      let groupAmount = 0;
      for (const item of items) {
        if (item.productId === groupId) groupAmount += unit * item.qty;
      }
      total += groupAmount;
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

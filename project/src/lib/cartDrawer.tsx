import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

/**
 * Slide-out bag drawer open/close state. Kept separate from the cart store so
 * "add to bag" (product page) and the header bag icon can both open the drawer.
 *
 * History integration: each OPEN pushes a small marker entry onto the browser
 * history so the device/system back button closes the drawer first, and a
 * second back press then navigates away normally. Closing via UI
 * (X / backdrop / ESC / checkout) neutralizes the marker without navigating.
 */
interface CartDrawerContextValue {
  isOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
}

const CartDrawerContext = createContext<CartDrawerContextValue>({
  isOpen: false,
  openCart: () => {},
  closeCart: () => {},
});

const CART_HISTORY_TAG = 'dslangCart';

export function CartDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const openCart = useCallback(() => {
    setIsOpen(true);
    window.history.pushState({ [CART_HISTORY_TAG]: true }, '');
  }, []);

  const closeCart = useCallback(() => {
    // Remove the marker from the current entry without navigating, so a back
    // press after a UI close is a normal history back and never re-opens the drawer.
    if (window.history.state?.[CART_HISTORY_TAG]) {
      window.history.replaceState(null, '');
    }
    setIsOpen(false);
  }, []);

  // System/device back: the browser pops the marker entry first. Once the
  // marker is gone the drawer should close instead of navigating away.
  useEffect(() => {
    if (!isOpen) return;
    const onPop = () => {
      if (window.history.state?.[CART_HISTORY_TAG]) return;
      setIsOpen(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isOpen]);

  return (
    <CartDrawerContext.Provider value={{ isOpen, openCart, closeCart }}>
      {children}
    </CartDrawerContext.Provider>
  );
}

export function useCartDrawer() {
  return useContext(CartDrawerContext);
}
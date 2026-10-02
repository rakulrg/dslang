import { useEffect, useState } from 'react';
import { cleanImageUrls, fetchProducts, type CatalogProduct } from '@/lib/catalog';

/**
 * The ONE way an order line gets a product image, anywhere in this app.
 *
 * WHY IMAGES ARE RESOLVED, NOT STORED
 *   `create_retail_order` deliberately does NOT copy image URLs into
 *   `retail_orders.items`. It records the immutable product `code`, the chosen
 *   `color` name, `size_label`, quantity and price — facts about the order — and
 *   nothing about presentation. So a line has no image of its own.
 *
 * WHY LOOK IT UP BY code + colour
 *   The catalogue is the authoritative source, and it is what the Product
 *   Details page renders from, so an order thumbnail is the SAME first frame
 *   (`images[0]`) the shopper picked — not a generic product shot and not a
 *   cart snapshot. `code` is stable across the order's lifetime, so this is
 *   still correct for an order placed months ago, and it needs no cart and no
 *   session.
 *
 * FALLBACK
 *   `imageForItem` returns '' when the catalogue has no usable frame (deleted
 *   product, colour renamed after purchase, offline). Callers render a neutral
 *   block. It NEVER substitutes a different product's picture.
 */
export interface OrderImageLine {
  code?: string | null;
  color?: string | null;
  product_id?: string | null;
}

export type OrderImageIndex = Map<string, Map<string, string>>;

/**
 * `product code OR product id` -> `lowercased colour name` -> that colour's first
 * image.
 *
 * The index is written under BOTH keys on purpose. Order lines reach the UI with
 * different identifiers depending on where they came from:
 *   * `retail_orders.items` records the product `code` (immutable, human-facing)
 *   * `track_lookup_order` and the admin read expose `product_id`
 * Keying both means one resolver serves every order surface instead of each page
 * needing its own variant, which is what keeps a thumbnail identical everywhere.
 */
export function buildImageIndex(products: CatalogProduct[]): OrderImageIndex {
  const index: OrderImageIndex = new Map();
  const put = (key: string | undefined, byColor: Map<string, string>) => {
    const k = key?.trim();
    if (k && byColor.size > 0 && !index.has(k)) index.set(k, byColor);
  };
  for (const product of products) {
    const byColor = new Map<string, string>();
    for (const color of product.colors ?? []) {
      const first = cleanImageUrls(color.images)[0];
      if (!first) continue;
      byColor.set(color.name.trim().toLowerCase(), first);
    }
    if (byColor.size === 0) continue;
    put(product.code, byColor);
    put(product.id, byColor);
  }
  return index;
}

/** The ordered variant's image, or '' so the row can render a neutral block. */
export function imageForItem(index: OrderImageIndex, item: OrderImageLine): string {
  const color = (item.color ?? '').trim().toLowerCase();
  if (!color) return '';
  // Product code first: it is the identifier written onto the order itself, so
  // it is the most stable of the two. The id is the fallback for payloads that
  // only carry `product_id`.
  for (const key of [item.code?.trim(), item.product_id?.trim()]) {
    if (!key) continue;
    const byColor = index.get(key);
    if (byColor) return byColor.get(color) ?? '';
  }
  return '';
}

/**
 * Loads the shared, cached catalogue and returns a `code -> colour -> image`
 * index. Every order surface uses this so a thumbnail never costs its own
 * request, and so a cold/offline failure degrades to neutral blocks instead of
 * breaking the page it sits on.
 */
export function useOrderImages(): OrderImageIndex {
  const [index, setIndex] = useState<OrderImageIndex>(new Map());
  useEffect(() => {
    let cancelled = false;
    void fetchProducts()
      .then((products) => {
        if (!cancelled) setIndex(buildImageIndex(products));
      })
      .catch(() => {
        // Offline / RLS / schema drift: keep the neutral fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return index;
}

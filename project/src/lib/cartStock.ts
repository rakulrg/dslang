import { supabase } from '@/lib/supabase';
import type { D2cCartItem } from '@/lib/d2cCart';

/**
 * Live stock revalidation for the retail cart.
 *
 * The cart stores a stock *snapshot* taken when an item was added. Over time
 * that snapshot can go stale (an item sells out, the admin edits stock, another
 * customer buys the last unit). Before submitting an order we re-fetch the
 * current per-color/per-size stock from product_sizes (the database source of
 * truth) and reconcile the cart against it — never trusting stale or
 * client-supplied quantities.
 *
 * This module performs ONE batched query for the whole cart (not one request
 * per line), returning a map of variant-key -> current stock.
 */

/** Stable key for a cart variant. */
export function variantKey(
  productId: string,
  colorId: string,
  sizeLabel: string
): string {
  return `${productId}|${colorId}|${sizeLabel}`;
}

export type LiveStockMap = Record<string, number>;

/**
 * Fetches the current stock for every variant currently in the cart in a single
 * query. Variants that no longer exist in product_sizes are reported as 0
 * (treated as unavailable).
 */
export async function fetchLiveVariantStock(
  items: Pick<D2cCartItem, 'productId' | 'colorId' | 'sizeLabel'>[]
): Promise<LiveStockMap> {
  const products = [...new Set(items.map((i) => i.productId))];
  if (products.length === 0) return {};

  const { data, error } = await supabase
    .from('product_sizes')
    .select('product_id, color_id, size_label, stock')
    .in('product_id', products);

  const live: LiveStockMap = {};
  if (error) throw error;

  for (const row of data ?? []) {
    const key = variantKey(
      String(row.product_id),
      String(row.color_id),
      String(row.size_label)
    );
    // Last row wins for a given variant (the unique constraint on
    // (product_id, color_id, size_label) guarantees one row per variant anyway).
    live[key] = Math.max(0, Number(row.stock ?? 0));
  }
  return live;
}

export interface StockReconcileChange {
  removed: { productId: string; color: string; sizeLabel: string; name: string }[];
  clamped: { productId: string; color: string; sizeLabel: string; name: string; from: number; to: number }[];
  changed: boolean;
}

/**
 * Reconciles cart items against a live stock map. Out-of-stock or vanished
 * variants are dropped; quantities above the live stock are clamped down; every
 * item's stock snapshot is refreshed to the live value. Returns the resulting
 * items plus a human-readable change summary for the UI.
 */
export function reconcileCartWithLive(
  items: D2cCartItem[],
  live: LiveStockMap
): { items: D2cCartItem[]; changes: StockReconcileChange } {
  const changes: StockReconcileChange = { removed: [], clamped: [], changed: false };
  const next: D2cCartItem[] = [];

  for (const item of items) {
    const key = variantKey(item.productId, item.colorId, item.sizeLabel);
    const available = live[key] ?? 0; // undefined => variant no longer exists -> 0

    if (available <= 0) {
      changes.changed = true;
      changes.removed.push({
        productId: item.productId,
        color: item.color,
        sizeLabel: item.sizeLabel,
        name: item.name,
      });
      continue;
    }

    const refreshed: D2cCartItem = { ...item, stock: available };
    if (item.quantity > available) {
      changes.changed = true;
      changes.clamped.push({
        productId: item.productId,
        color: item.color,
        sizeLabel: item.sizeLabel,
        name: item.name,
        from: item.quantity,
        to: available,
      });
      refreshed.quantity = available;
    }
    next.push(refreshed);
  }

  return { items: next, changes };
}

/** Builds a concise, human-readable message describing stock changes. */
export function describeStockChanges(changes: StockReconcileChange): string | null {
  if (!changes.changed) return null;
  const lines: string[] = ['Some items changed in your bag while you were shopping:'];

  if (changes.removed.length > 0) {
    const removed = changes.removed
      .map((r) => `${r.name} (${r.color} · ${r.sizeLabel})`)
      .join(', ');
    lines.push(`• Removed (now out of stock): ${removed}.`);
  }
  if (changes.clamped.length > 0) {
    const clamped = changes.clamped
      .map((c) => `${c.name} (${c.color} · ${c.sizeLabel}) reduced from ${c.from} to ${c.to}.`)
      .join(' ');
    lines.push(`• Quantity updated: ${clamped}`);
  }

  return lines.join('\n');
}

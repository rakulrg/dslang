import { get } from '@/lib/rest';
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
 *
 * ONE correction to that "current stock": product_sizes.stock is the *shelf*
 * count, and a reservation is expressed by REMOVING units from it. So while a
 * shopper has a pending (unpaid) online order, the units that order already
 * holds are missing from `stock` — for that shopper only. Reconciliation is
 * therefore reservation-aware: it adds the shopper's OWN held units back before
 * deciding what the cart may contain. Without that, cancelling at Cashfree and
 * coming back to checkout shrinks the very bag the payment was started for.
 * Genuinely available stock (what other customers hold) is never inflated: the
 * add-back is exactly the reservation this shopper owns, and the authoritative
 * stock check still runs server-side inside create_retail_order at submit.
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

/** Per-variant units this shopper's OWN pending order is holding. */
export type HeldStockMap = Record<string, number>;

/** Session key of the checkout's live order (shared with CheckoutPage). */
const LIVE_ORDER_KEY = 'dslang_live_order_v1';

/**
 * Stable fingerprint of a cart's variants + quantities. A live order is only
 * ever reused for — and only ever holds stock for — the exact bag it was created
 * from, so this is what decides whether a pending reservation still belongs to
 * the cart being reconciled.
 */
export function itemsKeyOf(
  items: { productId: string; colorId: string; sizeLabel: string; quantity: number }[]
): string {
  return items
    .map((i) => `${i.productId}|${i.colorId}|${i.sizeLabel}|${i.quantity}`)
    .join(',');
}

/**
 * Per-variant held units, taken from the order lines the SERVER reserved
 * (create_retail_order returns the exact lines it decremented stock for), so
 * the figures are never client-invented.
 */
export function heldStockFromOrderLines(
  lines:
    | { product_id?: string | null; color_id?: string | null; size_label?: string | null; quantity?: number | null }[]
    | null
    | undefined
): HeldStockMap {
  const held: HeldStockMap = {};
  for (const line of lines ?? []) {
    if (!line?.product_id || !line?.color_id || line.size_label == null) continue;
    const qty = Math.floor(Number(line.quantity));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const key = variantKey(String(line.product_id), String(line.color_id), String(line.size_label));
    held[key] = (held[key] ?? 0) + qty;
  }
  return held;
}

/** Held map as read back from session storage — nothing malformed survives. */
function sanitizeHeldStock(raw: unknown): HeldStockMap {
  const held: HeldStockMap = {};
  if (!raw || typeof raw !== 'object') return held;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) continue;
    const qty = Math.floor(Number(value));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    held[key] = qty;
  }
  return held;
}

/**
 * The units this shopper's OWN live online order is still holding.
 *
 * Returns nothing at all unless the pending reservation provably belongs to the
 * cart being reconciled: a live order whose bag fingerprint no longer matches
 * (the shopper edited the cart after paying), or a COD order, holds nothing
 * this shopper may count on. The reservation itself is never touched here — it
 * stays exactly as created, which is what lets a retry reuse the same order
 * without reserving the same stock twice.
 */
export function ownHeldStock(
  items: { productId: string; colorId: string; sizeLabel: string; quantity: number }[]
): HeldStockMap {
  if (typeof window === 'undefined' || items.length === 0) return {};
  try {
    const raw = window.sessionStorage.getItem(LIVE_ORDER_KEY);
    if (!raw) return {};
    const live = JSON.parse(raw) as { itemsKey?: unknown; is_cod?: unknown; held?: unknown };
    if (!live || live.is_cod === true) return {};
    if (typeof live.itemsKey !== 'string' || live.itemsKey !== itemsKeyOf(items)) return {};
    return sanitizeHeldStock(live.held);
  } catch {
    // Storage unavailable/malformed — behave exactly as if no order existed.
    return {};
  }
}

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

  const rows = await get<{
    product_id: string | number;
    color_id: string | number;
    size_label: string | number;
    stock: number | null;
  }>('product_sizes', { product_id: `in.(${products.join(',')})` }, { select: 'product_id, color_id, size_label, stock' });

  const live: LiveStockMap = {};
  for (const row of rows ?? []) {
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
 *
 * `held` defaults to the shopper's OWN pending online reservation, so an order
 * this shopper started paying for never counts against the bag it was created
 * for. It is subtracted from `product_sizes.stock` when the order was placed, so
 * adding it back restores the pre-payment picture for this shopper exactly —
 * stock held by anyone else stays excluded and a genuine shortage is still
 * clamped and reported.
 */
export function reconcileCartWithLive(
  items: D2cCartItem[],
  live: LiveStockMap,
  held: HeldStockMap = ownHeldStock(items)
): { items: D2cCartItem[]; changes: StockReconcileChange } {
  const changes: StockReconcileChange = { removed: [], clamped: [], changed: false };
  const next: D2cCartItem[] = [];

  for (const item of items) {
    const key = variantKey(item.productId, item.colorId, item.sizeLabel);
    // A variant that is no longer in product_sizes is gone for good — a pending
    // reservation cannot bring it back. Otherwise what this shopper may buy is
    // the units on the shelf PLUS the ones their own unpaid order already holds.
    const onShelf = live[key];
    const available =
      onShelf === undefined ? 0 : Math.max(0, onShelf + (held[key] ?? 0));

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

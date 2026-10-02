import type { VariantInventory } from '@/lib/types';

/** Single source of truth for variant availability status.
 *  Rules (spec): OUT when available <= 0; LOW when available > 0 and
 *  available <= reorder_point; otherwise IN. Matches `variant_inventory_v`'s
 *  low_stock/out_of_stock derivation exactly. */
export type StockStatus = 'out' | 'low' | 'in';

export function stockStatus(v: Pick<VariantInventory, 'available' | 'reorder_point'>): StockStatus {
  if (v.available <= 0) return 'out';
  if (v.reorder_point > 0 && v.available <= v.reorder_point) return 'low';
  return 'in';
}

export const STOCK_STATUS_CLS: Record<StockStatus, string> = {
  out: 'bg-crimson/10 text-crimson',
  low: 'bg-amber-100 text-amber-700',
  in: 'bg-green-600/10 text-green-700',
};

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  out: 'Out of stock',
  low: 'Low stock',
  in: 'In stock',
};

export function hasIncomingUnits(v: Pick<VariantInventory, 'incoming'>): boolean {
  return Number(v.incoming ?? 0) > 0;
}
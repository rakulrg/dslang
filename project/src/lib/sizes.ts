/**
 * Dynamic size helpers.
 *
 * Sizes are NOT hardcoded to M/L/XL. Any label the admin configures (XS, S,
 * M, L, XL, XXL, 28, 30, 32, 34, …) is respected. Ordering is deterministic:
 * garment tokens (XS…XXXXL) come first in body size order, numeric sizes next
 * in ascending numeric order, then any other labels in their original order.
 *
 * When the database has an admin-set sort_order on a product_sizes row, that
 * stored order wins (so an admin can reorder sizes); any size without a stored
 * order falls back to the deterministic sort and is appended at the end.
 */

export const KNOWN_SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'] as const;

export const DEFAULT_SIZE_LABELS = ['M', 'L', 'XL'];

function rank(label: string): [number, number] {
  const upper = label.toUpperCase();
  const known = KNOWN_SIZE_ORDER.indexOf(upper as (typeof KNOWN_SIZE_ORDER)[number]);
  if (known !== -1) return [0, known];
  if (/^\d{1,4}$/.test(label.trim())) return [1, Number(label.trim())];
  return [2, 0];
}

/** A single comparable index so callers can sort size labels consistently. */
export function sizeSortIndex(label: string): number {
  const [group, rankValue] = rank(label);
  return group * 1000 + rankValue;
}

/** Sorts arbitrary size labels using the shared deterministic ordering. */
export function sortSizeLabels(labels: string[]): string[] {
  return [...labels]
    .map((label, i) => ({ label, i }))
    .sort((a, b) => {
      const [ag, ar] = rank(a.label);
      const [bg, br] = rank(b.label);
      if (ag !== bg) return ag - bg;
      if (ar !== br) return ar - br;
      return a.i - b.i;
    })
    .map(({ label }) => label);
}

interface SizedRow {
  size_label: string;
  sort_order?: number | null;
}

/** Per-label stored order: the smallest positive sort_order seen for a label. */
function storedOrders(rows: SizedRow[]): Map<string, number> {
  const orders = new Map<string, number>();
  for (const row of rows) {
    const value = Math.floor(Number(row.sort_order) || 0);
    if (value > 0) {
      const current = orders.get(row.size_label);
      if (current === undefined || value < current) orders.set(row.size_label, value);
    }
  }
  return orders;
}

/**
 * Effective display order of the size labels present in a set of rows (one
 * product's variants). Stored sort_order ranks first when any exists;
 * otherwise the deterministic garment/numeric sort is used.
 */
export function sizeLabelsForRows(rows: SizedRow[]): string[] {
  const orders = storedOrders(rows);
  const labels = Array.from(new Set(rows.map((row) => row.size_label)));
  if (orders.size === 0) return sortSizeLabels(labels);

  const ranked = labels
    .filter((label) => orders.has(label))
    .sort((a, b) => orders.get(a)! - orders.get(b)!);
  const unranked = sortSizeLabels(labels.filter((label) => !orders.has(label)));
  return [...ranked, ...unranked];
}

/** Sorts a collection of objects carrying a size_label (e.g. ProductSizeRow),
 * honouring any admin-set stored order. */
export function sortSizeRows<T extends SizedRow>(rows: T[]): T[] {
  const rank = new Map(sizeLabelsForRows(rows).map((label, i) => [label, i]));
  return [...rows].sort((a, b) => rank.get(a.size_label)! - rank.get(b.size_label)!);
}
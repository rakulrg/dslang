export const PAYMENT_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-700' },
  // NEW COD: confirmed, nothing charged online, full amount due on delivery.
  cod_pending: { label: 'Pending collection (COD)', cls: 'bg-sky-100 text-sky-700' },
  success: { label: 'Success', cls: 'bg-green-600/10 text-green-700' },
  paid: { label: 'Paid', cls: 'bg-green-600/10 text-green-700' },
  failed: { label: 'Failed', cls: 'bg-crimson/10 text-crimson' },
  cancelled: { label: 'Cancelled', cls: 'bg-grey/15 text-grey' },
  refunded: { label: 'Refunded', cls: 'bg-grey/15 text-grey' },
};

export const ORDER_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-700' },
  processing: { label: 'Processing', cls: 'bg-sky-100 text-sky-700' },
  shipped: { label: 'Shipped', cls: 'bg-indigo-100 text-indigo-700' },
  delivered: { label: 'Delivered', cls: 'bg-green-600/10 text-green-700' },
  rto: { label: 'Returned to Origin (RTO)', cls: 'bg-amber-100 text-amber-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-crimson/10 text-crimson' },
  refunded: { label: 'Refunded', cls: 'bg-grey/15 text-grey' },
};

/**
 * The statuses an admin may move an order INTO.
 *
 * A new COD order starts at 'pending' and follows the ordinary path to
 * processing/shipped/delivered.
 */
export const ORDER_STATUS_FLOW = ['pending', 'processing', 'shipped', 'delivered', 'rto', 'cancelled', 'refunded'] as const;

export function orderStatusOptions(current: string): string[] {
  return [...ORDER_STATUS_FLOW];
}

/** Which orders qualify for the "Ship Order" (Delhivery) action. */
export const SHIPPABLE_ORDER_STATUSES = new Set(['pending', 'processing']);

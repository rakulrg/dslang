/**
 * Manual courier + AWB shipping vocabulary.
 *
 * One place that knows the shipping lifecycle, the courier list and how a
 * tracking link is (and is not) derived. Admin, customer and email surfaces all
 * read from here so they cannot drift apart.
 *
 * This module is deliberately free of Supabase and of any courier SDK: a
 * shipment is a set of values on the order row, nothing more. That is what makes
 * manual AWB entry work with every courier integration switched off.
 */

/** The shipping lifecycle, in order. Payment state is NOT part of this. */
export const SHIPPING_STATUS_FLOW = [
  'pending',
  'packed',
  'shipped',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'rto',
  'cancelled',
] as const;

export type ShippingStatus = (typeof SHIPPING_STATUS_FLOW)[number];

/**
 * What a customer-facing surface may report as the shipping status.
 *
 * Every shipment leg, plus `refunded` — an ORDER-LEVEL outcome that is not a
 * shipment leg (a refund is a payment result, never a courier event). It is kept
 * out of `SHIPPING_STATUS_FLOW` so `isShippingStatus` stays false for it and the
 * admin shipping form can never persist it, while the display layer can still
 * label a refunded order "Refunded" rather than "Cancelled".
 */
export type ShippingDisplayStatus = ShippingStatus | 'refunded';

/** Anything at or past courier handoff. These states imply a parcel exists. */
const POST_HANDOFF: ReadonlySet<string> = new Set<ShippingStatus>([
  'shipped',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'rto',
]);

export function isPostHandoff(status: string): boolean {
  return POST_HANDOFF.has(status);
}

export function isShippingStatus(v: string): v is ShippingStatus {
  return (SHIPPING_STATUS_FLOW as readonly string[]).includes(v);
}

export const SHIPPING_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-700' },
  packed: { label: 'Packed', cls: 'bg-sky-100 text-sky-700' },
  shipped: { label: 'Shipped', cls: 'bg-indigo-100 text-indigo-700' },
  in_transit: { label: 'In transit', cls: 'bg-indigo-100 text-indigo-700' },
  out_for_delivery: { label: 'Out for delivery', cls: 'bg-teal-100 text-teal-700' },
  delivered: { label: 'Delivered', cls: 'bg-green-600/10 text-green-700' },
  rto: { label: 'Returned to origin (RTO)', cls: 'bg-amber-100 text-amber-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-crimson/10 text-crimson' },
  // Order-level outcome, NOT a shipment leg: a refund is a payment result, so it
  // is deliberately absent from SHIPPING_STATUS_FLOW and `isShippingStatus`.
  // It exists only so a refunded order is labelled "Refunded" instead of being
  // mislabelled "Cancelled" wherever the derived shipping status is displayed.
  refunded: { label: 'Refunded', cls: 'bg-grey/15 text-grey' },
};

export function shippingStatusLabel(status: string): string {
  return SHIPPING_STATUS_LABEL[status]?.label ?? status;
}

/**
 * Customer-facing sentence for a shipping state.
 *
 * Deliberately never implies movement before it happened: a pre-handoff order
 * says it is being prepared, and only a stored post-handoff state ever claims
 * the parcel is on its way.
 */
export function shippingStatusMessage(status: string): string {
  switch (status) {
    case 'packed':
      return 'Your order is packed and will be handed to the courier shortly.';
    case 'shipped':
      return 'Your order has been handed to the courier.';
    case 'in_transit':
      return 'Your order is in transit.';
    case 'out_for_delivery':
      return 'Your order is out for delivery.';
    case 'delivered':
      return 'Your order has been delivered. Thank you for shopping with DSLANG.';
    case 'rto':
      return 'This order is being returned to the sender.';
    case 'cancelled':
      return 'This order has been cancelled.';
    case 'refunded':
      return 'This order has been refunded.';
    default:
      return 'Preparing your order';
  }
}

/** What a customer is told before a courier/AWB exists. */
export const NO_AWB_NOTICE = 'Tracking will be updated after shipment.';

/**
 * The same slot for a DELIVERED order that has no stored AWB.
 *
 * `NO_AWB_NOTICE` is the honest answer for every state that is still ahead of
 * the courier, and it is wrong the moment the parcel has arrived — it promises
 * an update that can never come. This is that state's line instead. Copy lives
 * here, beside the notice it replaces, so the two cannot drift.
 */
export const DELIVERED_NOTICE =
  'Delivered. No further tracking updates will be posted for this shipment.';

/**
 * The line for a CANCELLED order that has no AWB.
 *
 * `NO_AWB_NOTICE` promises tracking "after shipment", which is a lie for an order
 * that will never ship: it was cancelled before handoff. This says what is true
 * instead.
 */
export const CANCELLED_NOTICE =
  'This order was cancelled and will not be shipped.';

/**
 * The line for a REFUNDED order that has no AWB.
 *
 * A refunded order is not going to ship, so the "tracking after shipment"
 * promise does not apply. Deliberately distinct from the cancelled line: the
 * refund is a payment outcome, and the customer should see that word.
 */
export const REFUNDED_NOTICE =
  'This order was refunded and will not be shipped.';

/**
 * The line for an RTO order that has no AWB.
 *
 * Like the cancelled case, the parcel is not going to ship onward, so the
 * "tracking after shipment" promise does not apply.
 */
export const RTO_NOTICE =
  'This order is being returned to the sender and will not be shipped.';

/**
 * The pre-AWB line to show for a given shipping status, so every customer
 * surface picks the same honest sentence. Terminal states (delivered /
 * cancelled / refunded / rto) get their own line; anything still ahead of the
 * courier keeps the promise that tracking follows shipment.
 */
export function noAwbNotice(status: string): string {
  switch (status) {
    case 'delivered':
      return DELIVERED_NOTICE;
    case 'cancelled':
      return CANCELLED_NOTICE;
    case 'refunded':
      return REFUNDED_NOTICE;
    case 'rto':
      return RTO_NOTICE;
    default:
      return NO_AWB_NOTICE;
  }
}

/**
 * Couriers an admin can pick from. `other` means "typed it myself", so the admin
 * is never blocked by our list being short.
 */
export const COURIER_OPTIONS = ['Delhivery', 'DTDC', 'Blue Dart', 'India Post', 'Other'] as const;

/** Machine slug kept on retail_orders.shipping_provider for future automation. */
export function courierSlug(name: string | null | undefined): string | null {
  switch ((name ?? '').trim().toLowerCase()) {
    case 'delhivery':
      return 'delhivery';
    case 'dtdc':
      return 'dtdc';
    case 'blue dart':
      return 'blue_dart';
    case 'india post':
      return 'india_post';
    case 'other':
      return 'other';
    default:
      return null;
  }
}

/**
 * Delhivery's PUBLIC customer tracking page.
 *
 * This is the destination documented for tracking_url in
 * 20261004000000_dslang_delhivery_cutover.sql. It is a customer-facing page, not
 * an API endpoint — deliberately NOT api.delhivery.com, which needs an auth
 * token we must never put in a customer's browser or an email link.
 */
const DELHIVERY_TRACKING_BASE = 'https://www.delhivery.com/track/package/';

export function delhiveryTrackingUrl(awb: string): string | null {
  const clean = awb.trim();
  if (!/^[A-Za-z0-9-]+$/.test(clean)) return null;
  return `${DELHIVERY_TRACKING_BASE}${encodeURIComponent(clean)}`;
}

/** Minimal shape both a full order row and the guest shipping projection satisfy. */
export interface ShippingFacts {
  shipping_status?: string | null;
  order_status?: string | null;
  courier_name?: string | null;
  awb_number?: string | null;
  tracking_id?: string | null;
  tracking_url?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
}

/** The AWB, preferring the dedicated column and falling back to a carrier id. */
export function awbOf(o: ShippingFacts | null | undefined): string {
  return (o?.awb_number ?? o?.tracking_id ?? '').trim();
}

/** True only once a real AWB exists. Gates every "track my parcel" affordance. */
export function hasAwb(o: ShippingFacts | null | undefined): boolean {
  return awbOf(o) !== '';
}

/**
 * Order-level states that OUTRANK any stored `shipping_status`.
 *
 * `shipping_status` is written by the shipping workflow (admin_set_order_shipping
 * / the courier claim). Cancellation and refunds are ORDER-level operations: they
 * move `order_status` and deliberately never touch `shipping_status`. So a
 * cancelled order that had not yet been handed over still carries
 * `shipping_status = 'pending'` — and because `shippingStatusOf` used to trust
 * that column first, the customer was told their cancelled order was still
 * "Preparing your order", with a "tracking will follow shipment" promise that can
 * never be kept.
 *
 * These are final, order-wide outcomes. They are not a leg of the shipment, so a
 * pre-handoff shipping_status cannot be allowed to mask them. A legitimately
 * later shipping state is unaffected: `shipped` / `in_transit` /
 * `out_for_delivery` and the AWB-derived states keep their precedence.
 */
const ORDER_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'cancelled',
  'refunded',
  'rto',
  'delivered',
]);

/**
 * The order-level terminal state projects to a customer-facing shipping status.
 *
 * `refunded` returns its own `refunded` status (never `cancelled`): a refunded
 * order must read "Refunded". Every other terminal keeps its existing leg.
 */
function terminalShippingStatus(orderStatus: string): ShippingDisplayStatus {
  switch (orderStatus) {
    case 'delivered':
      return 'delivered';
    case 'rto':
      return 'rto';
    case 'refunded':
      return 'refunded';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'cancelled';
  }
}

/** True when `order_status` is a final order-wide state that outranks shipping. */
export function isOrderTerminalStatus(orderStatus: string | null | undefined): boolean {
  return ORDER_TERMINAL_STATUSES.has((orderStatus ?? '').trim());
}

/**
 * The effective shipping state.
 *
 * Prefers the dedicated shipping_status, EXCEPT that an order-level terminal
 * state (cancelled / refunded / rto / delivered) always wins: those outcomes are
 * not a shipment leg, so a stale pre-handoff shipping_status must not mask them.
 * For a historical row that predates the column, or one a legacy provider wrote,
 * it falls back to deriving the truth from what is actually stored (an AWB means
 * the parcel has gone out) and then from the coarse order_status — so old orders
 * still display correctly.
 */
export function shippingStatusOf(o: ShippingFacts | null | undefined): ShippingDisplayStatus {
  const orderStatus = (o?.order_status ?? '').trim();
  if (isOrderTerminalStatus(orderStatus)) return terminalShippingStatus(orderStatus);

  const s = (o?.shipping_status ?? '').trim();
  if (isShippingStatus(s)) return s;

  // Legacy / partially-migrated row: no usable shipping_status.
  if (awbOf(o)) {
    return 'shipped';
  }
  switch (orderStatus) {
    case 'shipped':
      return 'shipped';
    case 'processing':
      return 'packed';
    default:
      return 'pending';
  }
}

/**
 * The tracking link to offer a customer, or null when none is honest.
 *
 * Order of preference:
 *   1. a tracking_url an admin actually saved;
 *   2. Delhivery's public tracking page, but only for a Delhivery shipment
 *      that has an AWB;
 *   3. null — the AWB is shown as text and no link is invented.
 */
export function trackingLinkFor(o: ShippingFacts | null | undefined): string | null {
  const stored = (o?.tracking_url ?? '').trim();
  if (/^https?:\/\//i.test(stored)) return stored;

  const awb = awbOf(o);
  if (!awb) return null;

  const courier = (o?.courier_name ?? '').trim().toLowerCase();
  if (courier === 'delhivery' || courierSlug(courier) === 'delhivery') {
    return delhiveryTrackingUrl(awb);
  }
  return null;
}

/** Can we honestly show a "Track Shipment" button? */
export function canTrackShipment(o: ShippingFacts | null | undefined): boolean {
  return hasAwb(o) && trackingLinkFor(o) !== null;
}

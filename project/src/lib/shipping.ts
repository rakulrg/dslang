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
 * The effective shipping state.
 *
 * Prefers the dedicated shipping_status. For a historical row that predates the
 * column, or one a legacy provider wrote, it falls back to deriving the truth
 * from what is actually stored (an AWB means the parcel has gone out) and then
 * from the coarse order_status — so old orders still display correctly.
 */
export function shippingStatusOf(o: ShippingFacts | null | undefined): ShippingStatus {
  const s = (o?.shipping_status ?? '').trim();
  if (isShippingStatus(s)) return s;

  // Legacy / partially-migrated row: no usable shipping_status.
  if (awbOf(o)) {
    if (o?.order_status === 'delivered') return 'delivered';
    if (o?.order_status === 'rto') return 'rto';
    return 'shipped';
  }
  switch (o?.order_status) {
    case 'delivered':
      return 'delivered';
    case 'shipped':
      return 'shipped';
    case 'rto':
      return 'rto';
    case 'cancelled':
    case 'refunded':
      return 'cancelled';
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

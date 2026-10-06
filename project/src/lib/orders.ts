import { isUnknownOutcome, rpc } from '@/lib/rest';

/** Client-provided line. Prices are intentionally NOT included — the server
 * re-prices every line from products.price via create_retail_order. */
export interface RetailOrderLineInput {
  product_id: string;
  name: string;
  code: string;
  color_id: string;
  color: string;
  color_hex: string;
  size_label: string;
  quantity: number;
}

export interface RetailCustomer {
  name: string;
  phone: string;
  email?: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  country?: string;
}

/** Payment method chosen at checkout. 'cod' = Cash on Delivery: the FULL order
 * amount is collected by the delivery agent on arrival and NOTHING is charged
 * online, so Cashfree is never involved. 'online' = the complete discounted
 * amount is charged via Cashfree and it keeps a ₹50 payment-method discount
 * (payment_discount, capped at the order value). */
export type RetailPaymentMethod = 'online' | 'cod';

export interface RetailOrderResult {
  order_id: string;
  ref: string;
  order_type: 'retail';
  total_qty: number;
  subtotal: number;
  discount: number;
  shipping: number;
  total_amount: number;
  payment_status: string;
  order_status?: string;
  is_cod?: boolean;
  /** ₹50 online-payment discount (exactly 0 for COD, absent pre-migration). */
  payment_discount?: number;
  /** Charged online via Cashfree. Online: the full discounted total. COD: 0. */
  amount_paid_upfront?: number;
  /** Collected by the agent on delivery. COD: the full total. Online: 0. */
  amount_due_on_delivery?: number;
  items?: RetailOrderLineSnapshot[];
  customer?: RetailCustomer;
}

export interface RetailOrderLineSnapshot {
  product_id: string;
  /** Variant colour uuid — returned by create_retail_order for every line (the
   *  reservation is per colour+size, so this identifies the reserved variant). */
  color_id: string;
  name: string;
  code: string;
  color: string;
  size_label: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface RetailOrderPayload {
  customer: RetailCustomer;
  items: RetailOrderLineInput[];
  promoCode?: string | null;
  /** 'online' (default) or 'cod'. COD: only p_payment_method='cod' is sent to
   * the RPC, so pre-migration DBs keep accepting online orders unchanged. */
  paymentMethod?: RetailPaymentMethod;
}

/**
 * How long the browser waits for `create_retail_order` before it stops listening.
 *
 * This is the ONE request whose failure mode is destructive: the server writes
 * the order row AND decrements stock inside the same transaction, so it can
 * easily have committed by the time we give up on the response. Abandoning it
 * leaves the browser with no order id, no live handle and no way to reuse what
 * was just reserved — the customer's next "Pay Now" would create a SECOND order
 * and reserve the SAME stock twice.
 *
 * So this call is not given the default 20s budget. The database has no
 * `lock_timeout` or `statement_timeout`, so a `product_sizes` row lock taken by
 * another checkout makes the transaction legitimately wait, and the wait is
 * exactly what a customer sees as a spinner on the Pay Now button. Abandoning
 * that wait buys nothing; finishing it is what makes the outcome known and the
 * order reusable. Every other request keeps the 20s default.
 *
 * (A genuinely definite failure - a 400 "only N left", a 401, a 5xx that
 * answers - still fails fast and is reported immediately.)
 */
const CREATE_ORDER_TIMEOUT_MS = 45000;

/**
 * The single order-creation currently in flight for this tab, if any.
 *
 * `startCheckout` is guarded against a double submit, but a create can also
 * still be running when the customer presses Pay Now again (e.g. after a slow
 * wait they assume it failed). Sharing the in-flight promise means the second
 * press receives the SAME order instead of placing a second one — so the order
 * and its stock reservation are created at most once per checkout, no matter
 * how many times the button is pressed.
 */
let inflightCreate: Promise<RetailOrderResult> | null = null;

/**
 * Set when an order creation ended with an UNKNOWN outcome (the transport
 * failed, so we never learned whether the server committed). The order and its
 * reservation may well exist right now, and there is no way to look an order up
 * by anything but its ref — which is exactly what we did not receive.
 *
 * While this is set, a new creation is refused. Creating again is the one thing
 * that could turn a lost response into a second order holding a second copy of
 * the same stock. The abandoned order is not leaked either: it is exactly what
 * the existing `expire-stale-orders` sweep exists for, and it restocks it once.
 *
 * It expires with that sweep's window (30 minutes by default), after which the
 * order is certainly gone and its stock certainly back, so a checkout may
 * safely start over rather than stay blocked forever.
 */
const UNRESOLVED_KEY = 'dslang_order_create_unresolved_v1';
const UNRESOLVED_TTL_MS = 30 * 60 * 1000;

/** Thrown instead of creating a second order after an unknown outcome. */
export class OrderCreateUnresolvedError extends Error {
  constructor() {
    super('An earlier order attempt is still unresolved, so a new order cannot be placed safely.');
    this.name = 'OrderCreateUnresolvedError';
  }
}

function readUnresolvedAt(): number {
  try {
    const raw = window.sessionStorage.getItem(UNRESOLVED_KEY);
    const at = Number(raw ?? 0);
    if (!at || !Number.isFinite(at)) return 0;
    // Older than the sweep window: the order is gone and its stock is back.
    if (Date.now() - at > UNRESOLVED_TTL_MS) {
      window.sessionStorage.removeItem(UNRESOLVED_KEY);
      return 0;
    }
    return at;
  } catch {
    return 0;
  }
}

function markUnresolved(): void {
  try {
    window.sessionStorage.setItem(UNRESOLVED_KEY, String(Date.now()));
  } catch {
    // storage unavailable — the in-flight guard still covers the common case
  }
}

function clearUnresolved(): void {
  try {
    window.sessionStorage.removeItem(UNRESOLVED_KEY);
  } catch {
    // ignore
  }
}

/** Whether an earlier creation is still unresolved (diagnostics/tests). */
export function hasUnresolvedOrderCreate(): boolean {
  return typeof window !== 'undefined' && readUnresolvedAt() > 0;
}

/**
 * Places a retail (D2C) order via the security-defined create_retail_order RPC.
 * The server re-prices every line from products.price, validates the
 * product/color/size/stock, decrements stock, and recomputes the total — the
 * client never supplies prices or totals. The server also computes the
 * authoritative payment split: COD records a zero online charge and the full
 * amount due on delivery (and the client then skips Cashfree entirely);
 * online orders get the ₹50 discount (payment_discount, capped at the order
 * value) and the whole discounted amount is charged.
 */
export async function createRetailOrder(payload: RetailOrderPayload): Promise<RetailOrderResult> {
  // An identical create is already running: hand back its result rather than
  // reserving the same stock a second time.
  if (inflightCreate) return inflightCreate;
  // An earlier attempt's outcome is unknown — its order and reservation may
  // still exist, so creating again is exactly the duplicate we must not create.
  if (typeof window !== 'undefined' && readUnresolvedAt() > 0) throw new OrderCreateUnresolvedError();

  const items = payload.items.map((item) => ({
    product_id: item.product_id,
    name: item.name,
    code: item.code,
    color_id: item.color_id,
    color: item.color,
    color_hex: item.color_hex,
    size_label: item.size_label,
    quantity: item.quantity,
  }));

  const params: Record<string, unknown> = {
    p_customer: { ...payload.customer, country: 'India' } as unknown as Record<string, unknown>,
    p_items: items as unknown as Record<string, unknown>[],
    p_promo_code: payload.promoCode ?? null,
    p_shipping: {},
  };
  // Only COD opts into the new RPC argument; online orders keep the exact old
  // call shape so they stay backward-compatible until the migration is applied.
  if (payload.paymentMethod === 'cod') {
    params.p_payment_method = 'cod';
  }

const run = rpc<RetailOrderResult>('create_retail_order', params, CREATE_ORDER_TIMEOUT_MS);
  inflightCreate = run;
  try {
    const created = await run;
    // We know the ref, so this checkout owns the order from here on.
    clearUnresolved();
    return created;
  } catch (err) {
    // A definite refusal (400 "only N left", 401, ...) is safe to retry and
    // leaves nothing behind. An unknown outcome may have committed an order and
    // a reservation, so block any further creation until the sweep has
    // reclaimed it.
    if (isUnknownOutcome(err)) markUnresolved();
    throw err;
  } finally {
    // Cleared on BOTH outcomes. A definite failure is safe to retry; an unknown
    // one has already had its full budget, so there is nothing left to wait for.
    if (inflightCreate === run) inflightCreate = null;
  }
}

/**
 * Switches an ALREADY-CREATED, still-unpaid ONLINE order to full COD in place.
 *
 * This is used when the shopper changes the payment method after an order
 * exists. It deliberately does NOT create a second order: stock is already
 * reserved, so a second create_retail_order() would double-book inventory and
 * leave the abandoned order holding stock until the expiry sweep. It also does
 * NOT reuse the online row as-is: that row says is_cod = false, so confirming
 * it as COD would hide the order from admin New Orders and let the
 * expire-stale-orders sweep cancel a live order.
 *
 * The server re-prices the order (online discount dropped, nothing charged
 * online, full amount due on delivery) and preserves the original sale total,
 * promo discount and the single stock reservation. Possession is proven with
 * the customer's 10-digit phone, and a paid / processing / already-COD order
 * is refused server-side.
 */
export async function convertRetailOrderToCod(ref: string, phone: string): Promise<RetailOrderResult> {
  return rpc<RetailOrderResult>('convert_retail_order_to_cod', { p_ref: ref, p_phone: phone });
}

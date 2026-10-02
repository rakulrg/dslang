import { rpc } from '@/lib/rest';

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
 * Places a retail (D2C) order via the security-defined create_retail_order RPC.
 * The server re-prices every line from products.price, validates the
 * product/color/size/stock, decrements stock, and recomputes the total — the
 * client never supplies prices or totals. The server also computes the
 * authoritative payment split: COD records a zero online charge and the full
 * amount due on delivery (and the client then skips Cashfree entirely);
 * online orders get the ₹50 discount (payment_discount) off the Sale Price and
 * the whole discounted amount is charged.
 */
export async function createRetailOrder(payload: RetailOrderPayload): Promise<RetailOrderResult> {
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

  const data = await rpc<RetailOrderResult>('create_retail_order', params);
  return data;
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

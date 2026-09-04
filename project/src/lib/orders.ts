import { supabase } from '@/lib/supabase';

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
}

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
}

/**
 * Places a retail (D2C) order via the security-defined create_retail_order RPC.
 * The server re-prices every line from products.price, validates the
 * product/color/size/stock, decrements stock, and recomputes the total — the
 * client never supplies prices or totals.
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

  const { data, error } = await supabase.rpc('create_retail_order', {
    p_customer: payload.customer as unknown as Record<string, unknown>,
    p_items: items as unknown as Record<string, unknown>[],
    p_promo_code: payload.promoCode ?? null,
    p_shipping: {},
  });

  if (error) throw error;
  return data as RetailOrderResult;
}
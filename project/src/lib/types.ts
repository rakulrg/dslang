export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  code: string;
  drop_label: string;
  price: number;
  mrp: number | null;
  fabric: string;
  fit: string;
  care: string;
  description: string;
  category: string;
  badge: string | null;
  featured: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  // Spec fields (added via migration; optional so old rows still load)
  gsm?: number | null;
  wash?: string | null;
  // Storefront visibility (added via migration; optional for older rows)
  published?: boolean;
  new_drop?: boolean;
  // Retail / D2C channel (added via migration; optional for older rows)
  retail_visible?: boolean;
  // Storefront extras (added via migration; optional for older rows)
  details?: string | null;
}

export interface RetailOrderItem {
  product_id: string;
  name: string;
  code: string;
  color_id: string;
  color: string;
  color_hex: string;
  size_label: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface RetailOrder {
  id: string;
  ref: string;
  order_type: 'retail';
  customer: {
    name: string;
    phone: string;
    email?: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
    country?: string;
  };
  items: RetailOrderItem[];
  total_qty: number;
  subtotal: number;
  discount: number;
  shipping: number;
  total_amount: number;
  payment_status: string;
  order_status: string;
  // Cash on Delivery + online-payment discount (added via migration; optional
  // so old rows still load). Canonical pricing (server-authoritative):
  //   online: amount_paid_upfront = total_amount - payment_discount (fixed ₹50)
  //   COD:    amount_paid_upfront = min(100, total_amount) — fixed ₹100 advance
  //           (capped at the order value),
  //           amount_due_on_delivery = balance
  is_cod?: boolean;
  payment_discount?: number;
  amount_paid_upfront?: number;
  amount_due_on_delivery?: number;
  promo_code: string | null;
  currency?: string;
  payment_provider?: string;
  payment_id?: string;
  txn_id?: string;
  paid_at?: string | null;
  tracking_id?: string | null;
  tracking_url?: string | null;
  // Delhivery / provider-neutral shipping (added via cutover migration)
  shipping_provider?: string | null;
  tracking_current_status?: string | null;
  tracking_location?: string | null;
  tracking_scans?: unknown;
  last_tracking_sync_at?: string | null;
  // Shiprocket shipping (legacy, read-only; optional so old rows still load)
  shiprocket_order_id?: string | null;
  awb_number?: string | null;
  courier_name?: string | null;
  label_url?: string | null;
  shipped_at?: string | null;
  shiprocket_current_status?: string | null;
  shiprocket_location?: string | null;
  shiprocket_scans?: unknown;
  shiprocket_updated_at?: string | null;
  shipping_sms_sent_at?: string | null;
  sms_sent_at?: string | null;
  // fastrr (Shiprocket Checkout) — added via migration; optional for old rows
  fastrr_order_id?: string | null;
  fastrr_payment_ref?: string | null;
  fastrr_payment_status?: string | null;
  ship_attempt_error?: string | null;
  last_ship_attempt_at?: string | null;
  ship_source?: 'fastrr' | 'cashfree' | 'admin' | 'auto' | 'webhook' | null;
  auto_ship_at?: string | null;
  referral: string | null;
  created_at: string;
  updated_at?: string;
}

export interface ProductColorRow {
  id: string;
  product_id: string;
  name: string;
  hex: string;
  images: string[];
  sort_order: number;
  created_at: string;
}

export interface ProductSizeRow {
  id: string;
  product_id: string;
  color_id: string;
  size_label: string;
  available: boolean;
  stock: number;
  /** Admin-set per-product display order (optional; 0/missing = fall back to
   * the shared garment/numeric sort). Same value on every colour row for a
   * given size. */
  sort_order?: number | null;
}

export interface SizeChartRow {
  id: string;
  product_id: string;
  size_label: string;
  chest: number;
  length: number;
  shoulder: number;
  sort_order: number;
}

export interface HeroSlideRow {
  id: string;
  image_url: string;
  sort_order: number;
  active: boolean;
  created_at: string;
}

export interface CatalogProduct extends ProductRow {
  colors: ProductColorRow[];
  sizes: ProductSizeRow[];
  size_chart: SizeChartRow[];
}

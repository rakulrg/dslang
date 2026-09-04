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
  // Wholesale fields (added via migration; optional so old rows still load)
  gsm?: number | null;
  wash?: string | null;
  print_type?: string | null;
  moq?: number | null;
  wholesale_price_50?: number | null;
  wholesale_price_100?: number | null;
  // Storefront visibility (added via migration; optional for older rows)
  published?: boolean;
  new_drop?: boolean;
  // Retail / D2C channel (added via migration; optional for older rows)
  retail_visible?: boolean;
  // Wholesale rebuild (added via migration; optional for older rows)
  details?: string | null;
  available_sizes?: string[] | null;
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
  };
  items: RetailOrderItem[];
  total_qty: number;
  subtotal: number;
  discount: number;
  shipping: number;
  total_amount: number;
  payment_status: string;
  order_status: string;
  promo_code: string | null;
  currency?: string;
  payment_provider?: string;
  payment_id?: string;
  txn_id?: string;
  paid_at?: string | null;
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
  eyebrow: string;
  title: string;
  subtitle: string;
  sort_order: number;
  active: boolean;
  created_at: string;
  // Optional CTA fields shown on the homepage hero
  cta_text?: string | null;
  cta_url?: string | null;
}

export interface CatalogProduct extends ProductRow {
  colors: ProductColorRow[];
  sizes: ProductSizeRow[];
  size_chart: SizeChartRow[];
}

export const SIZE_LABELS = ['M', 'L', 'XL'] as const;

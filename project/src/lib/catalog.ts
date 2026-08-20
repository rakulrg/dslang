import { supabase } from '@/lib/supabase';
import type {
  CatalogProduct,
  HeroSlideRow,
  ProductColorRow,
  ProductRow,
  ProductSizeRow,
  SizeChartRow,
} from '@/lib/types';
import { SIZE_LABELS } from '@/lib/types';

export type { CatalogProduct, HeroSlideRow };

export const WHATSAPP_NUMBER = '919944676178';
export const INSTAGRAM_URL = 'https://instagram.com/dslang.in';
export const EMAIL = 'hello.dslang@gmail.com';
export const FREE_SHIPPING_THRESHOLD = 999;

const ALLOWED_SIZES = new Set<string>(SIZE_LABELS);

const SIZE_ORDER: Record<string, number> = { M: 0, L: 1, XL: 2 };

function sortSizes(sizes: ProductSizeRow[]): ProductSizeRow[] {
  return sizes
    .filter((s) => ALLOWED_SIZES.has(s.size_label))
    .sort((a, b) => (SIZE_ORDER[a.size_label] ?? 99) - (SIZE_ORDER[b.size_label] ?? 99));
}

export function cleanImageUrls(images: string[] | null | undefined): string[] {
  return (images ?? []).filter((image): image is string => typeof image === 'string' && image.trim().length > 0).map((image) => image.trim());
}

export async function fetchProducts(): Promise<CatalogProduct[]> {
  const { data: products, error } = await supabase
    .from('products')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) throw error;
  if (!products || products.length === 0) return [];

  const ids = products.map((p) => p.id);

  const [{ data: colors }, { data: sizes }, { data: chart }] = await Promise.all([
    supabase.from('product_colors').select('*').in('product_id', ids).order('sort_order'),
    supabase.from('product_sizes').select('*').in('product_id', ids),
    supabase.from('size_chart_rows').select('*').in('product_id', ids).order('sort_order'),
  ]);

  return (products as ProductRow[]).map((p) => ({
    ...p,
    colors: ((colors as ProductColorRow[] | null)?.filter((c) => c.product_id === p.id) ?? []).map((color) => ({ ...color, images: cleanImageUrls(color.images) })),
    sizes: sortSizes(((sizes as ProductSizeRow[] | null)?.filter((s) => s.product_id === p.id) ?? []).map((s) => ({
      ...s,
      stock: Number(s.stock ?? 0),
      // Stock is the source of truth: a size is purchasable whenever stock is positive.
      available: Number(s.stock ?? 0) > 0,
    }))),
    size_chart: (chart as SizeChartRow[] | null)?.filter((r) => r.product_id === p.id) ?? [],
  }));
}

export async function fetchProduct(slug: string): Promise<CatalogProduct | null> {
  const { data: product, error } = await supabase
    .from('products')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) throw error;
  if (!product) return null;

  const p = product as ProductRow;
  const [{ data: colors }, { data: sizes }, { data: chart }] = await Promise.all([
    supabase.from('product_colors').select('*').eq('product_id', p.id).order('sort_order'),
    supabase.from('product_sizes').select('*').eq('product_id', p.id),
    supabase.from('size_chart_rows').select('*').eq('product_id', p.id).order('sort_order'),
  ]);

  return {
    ...p,
    colors: ((colors as ProductColorRow[]) ?? []).map((color) => ({ ...color, images: cleanImageUrls(color.images) })),
    sizes: sortSizes(((sizes as ProductSizeRow[]) ?? []).map((s) => ({
      ...s,
      stock: Number(s.stock ?? 0),
      available: Number(s.stock ?? 0) > 0,
    }))),
    size_chart: (chart as SizeChartRow[]) ?? [],
  };
}

export async function fetchHeroSlides(): Promise<HeroSlideRow[]> {
  const { data, error } = await supabase
    .from('hero_slides')
    .select('*')
    .eq('active', true)
    .order('sort_order');
  if (error) throw error;
  return (data as HeroSlideRow[]) ?? [];
}

export function formatPrice(n: number): string {
  return `₹\u2009${n.toLocaleString('en-IN')}`;
}

export interface WhatsAppOrder {
  name: string;
  code: string;
  color: string;
  size: string;
  quantity: number;
  price: number;
  customerName?: string;
  phone?: string;
  city?: string;
  address?: string;
  notes?: string;
  /** Optional pre-computed total. When provided, it overrides price * quantity. */
  total?: number;
}

export function buildWhatsAppUrl(order: WhatsAppOrder): string {
  const total = order.total ?? order.price * order.quantity;
  const customerDetails = [
    order.customerName ? `Customer Name: ${order.customerName}` : null,
    order.phone ? `Phone: ${order.phone}` : null,
    order.city ? `City: ${order.city}` : null,
    order.address ? `Address: ${order.address}` : null,
    order.notes ? `Notes: ${order.notes}` : null,
  ].filter(Boolean).join('\n');

  const message = [
    "Hi DSLANG! I'd like to order:",
    '',
    `Product: ${order.name}`,
    `Code: ${order.code}`,
    `Color: ${order.color}`,
    `Size: ${order.size}`,
    `Qty: ${order.quantity}`,
    `Price: ₹${order.price} x ${order.quantity} = ₹${total}`,
    ...(customerDetails ? ['', 'Customer Details:', customerDetails] : []),
    '',
    'Please confirm availability and delivery details.',
  ].join('\n');

  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export function buildWhatsAppGeneralUrl(message: string): string {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

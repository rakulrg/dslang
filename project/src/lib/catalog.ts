import { supabase } from '@/lib/supabase';
import type {
  CatalogProduct,
  HeroSlideRow,
  ProductColorRow,
  ProductRow,
  ProductSizeRow,
  SizeChartRow,
} from '@/lib/types';

export type { CatalogProduct, HeroSlideRow };

export const WHATSAPP_NUMBER = '919944676178';
export const INSTAGRAM_URL = 'https://instagram.com/dslang.in';
export const EMAIL = 'hello@dslang.in';

const SIZE_ORDER: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3, XXL: 4 };

function sortSizes(sizes: ProductSizeRow[]): ProductSizeRow[] {
  return [...sizes].sort((a, b) => (SIZE_ORDER[a.size_label] ?? 99) - (SIZE_ORDER[b.size_label] ?? 99));
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
    colors: (colors as ProductColorRow[] | null)?.filter((c) => c.product_id === p.id) ?? [],
    sizes: sortSizes((sizes as ProductSizeRow[] | null)?.filter((s) => s.product_id === p.id) ?? []),
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
    colors: (colors as ProductColorRow[]) ?? [],
    sizes: sortSizes((sizes as ProductSizeRow[]) ?? []),
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
  return `₹${n.toLocaleString('en-IN')}`;
}

export interface WhatsAppOrder {
  name: string;
  code: string;
  color: string;
  size: string;
  quantity: number;
  price: number;
}

export function buildWhatsAppUrl(order: WhatsAppOrder): string {
  const total = order.price * order.quantity;
  const message = `Hi DSLANG! I'd like to order:

Product: ${order.name}
Code: ${order.code}
Color: ${order.color}
Size: ${order.size}
Qty: ${order.quantity}
Price: ₹${order.price} x ${order.quantity} = ₹${total}

Please confirm availability and delivery details.`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export function buildWhatsAppGeneralUrl(message: string): string {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

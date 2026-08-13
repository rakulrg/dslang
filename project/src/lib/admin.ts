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

const SIZE_ORDER: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3, XXL: 4 };

function sortSizes(sizes: ProductSizeRow[]): ProductSizeRow[] {
  return [...sizes].sort((a, b) => (SIZE_ORDER[a.size_label] ?? 99) - (SIZE_ORDER[b.size_label] ?? 99));
}

export async function adminFetchProducts(): Promise<CatalogProduct[]> {
  const { data: products, error } = await supabase
    .from('products')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  if (!products) return [];

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

export async function adminFetchHero(): Promise<HeroSlideRow[]> {
  const { data, error } = await supabase.from('hero_slides').select('*').order('sort_order');
  if (error) throw error;
  return (data as HeroSlideRow[]) ?? [];
}

export interface ProductInput {
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
}

export async function adminCreateProduct(input: ProductInput): Promise<ProductRow> {
  const { data, error } = await supabase.from('products').insert(input).select().single();
  if (error) throw error;

  const product = data as ProductRow;

  // Create default sizes (all available)
  const sizeRows = SIZE_LABELS.map((label) => ({
    product_id: product.id,
    size_label: label,
    available: true,
  }));
  await supabase.from('product_sizes').insert(sizeRows);

  // Create default size chart
  const defaultChart: Record<string, { chest: number; length: number; shoulder: number }> = {
    S: { chest: 48, length: 27, shoulder: 23 },
    M: { chest: 52, length: 28, shoulder: 24 },
    L: { chest: 56, length: 29, shoulder: 25 },
    XL: { chest: 60, length: 30, shoulder: 26 },
    XXL: { chest: 64, length: 31, shoulder: 27 },
  };
  const chartRows = SIZE_LABELS.map((label, i) => ({
    product_id: product.id,
    size_label: label,
    chest: defaultChart[label].chest,
    length: defaultChart[label].length,
    shoulder: defaultChart[label].shoulder,
    sort_order: i,
  }));
  await supabase.from('size_chart_rows').insert(chartRows);

  return product;
}

export async function adminUpdateProduct(id: string, input: Partial<ProductInput>): Promise<void> {
  const { slug: _slug, ...rest } = input;
  const { error } = await supabase.from('products').update(rest).eq('id', id);
  if (error) throw error;
}

export async function adminDeleteProduct(id: string): Promise<void> {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

// Colors
export async function adminAddColor(
  productId: string,
  name: string,
  hex: string,
  images: string[]
): Promise<ProductColorRow> {
  const { data, error } = await supabase
    .from('product_colors')
    .insert({ product_id: productId, name, hex, images, sort_order: 99 })
    .select()
    .single();
  if (error) throw error;
  return data as ProductColorRow;
}

export async function adminUpdateColor(id: string, patch: Partial<Pick<ProductColorRow, 'name' | 'hex' | 'images' | 'sort_order'>>): Promise<void> {
  const { error } = await supabase.from('product_colors').update(patch).eq('id', id);
  if (error) throw error;
}

export async function adminDeleteColor(id: string): Promise<void> {
  const { error } = await supabase.from('product_colors').delete().eq('id', id);
  if (error) throw error;
}

// Sizes
export async function adminToggleSize(sizeId: string, available: boolean): Promise<void> {
  const { error } = await supabase.from('product_sizes').update({ available }).eq('id', sizeId);
  if (error) throw error;
}

// Size chart
export async function adminUpdateSizeChartRow(id: string, chest: number, length: number, shoulder: number): Promise<void> {
  const { error } = await supabase.from('size_chart_rows').update({ chest, length, shoulder }).eq('id', id);
  if (error) throw error;
}

// Hero slides
export async function adminCreateHero(input: Omit<HeroSlideRow, 'id' | 'created_at'>): Promise<void> {
  const { error } = await supabase.from('hero_slides').insert({
    image_url: input.image_url,
    eyebrow: input.eyebrow,
    title: input.title,
    subtitle: input.subtitle,
    sort_order: input.sort_order,
    active: input.active,
  });
  if (error) throw error;
}

export async function adminUpdateHero(id: string, patch: Partial<Omit<HeroSlideRow, 'id' | 'created_at'>>): Promise<void> {
  const { error } = await supabase.from('hero_slides').update(patch).eq('id', id);
  if (error) throw error;
}

export async function adminDeleteHero(id: string): Promise<void> {
  const { error } = await supabase.from('hero_slides').delete().eq('id', id);
  if (error) throw error;
}

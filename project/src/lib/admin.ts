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
import { hasPublishColumns } from '@/lib/catalog';
import type { SiteSettings } from '@/lib/settings';

const ALLOWED_SIZES = new Set<string>(SIZE_LABELS);

const SIZE_ORDER: Record<string, number> = { M: 0, L: 1, XL: 2 };
export const PRODUCT_IMAGE_BUCKET = 'product-images';
const PRODUCT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
const PRODUCT_IMAGE_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function sortSizes(sizes: ProductSizeRow[]): ProductSizeRow[] {
  return sizes
    .filter((s) => ALLOWED_SIZES.has(s.size_label))
    .sort((a, b) => (SIZE_ORDER[a.size_label] ?? 99) - (SIZE_ORDER[b.size_label] ?? 99));
}

function cleanImageUrls(images: string[] | null | undefined): string[] {
  return (images ?? []).filter((image): image is string => typeof image === 'string' && image.trim().length > 0).map((image) => image.trim());
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
    colors: ((colors as ProductColorRow[] | null)?.filter((c) => c.product_id === p.id) ?? []).map((color) => ({ ...color, images: cleanImageUrls(color.images) })),
    sizes: sortSizes(((sizes as ProductSizeRow[] | null)?.filter((s) => s.product_id === p.id) ?? []).map((s) => ({
      ...s,
      stock: Number(s.stock ?? 0),
      available: Number(s.stock ?? 0) > 0,
    }))),
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
  published: boolean;
  new_drop: boolean;
  sort_order: number;
  gsm: number | null;
  wash: string;
  print_type: string | null;
  moq: number | null;
  price50: number | null;
  price100: number | null;
}

export const WHOLESALE_COLUMNS = ['gsm', 'wash', 'print_type', 'moq', 'price50', 'price100'] as const;

let wholesaleColumnsAvailable: boolean | null = null;

/**
 * Detects whether the products table has the wholesale columns yet.
 * This lets the admin panel work before (and after) the migration is applied.
 */
export async function hasWholesaleColumns(): Promise<boolean> {
  if (wholesaleColumnsAvailable !== null) return wholesaleColumnsAvailable;
  const { error } = await supabase
    .from('products')
    .select('gsm, wash, print_type, moq, price50, price100')
    .limit(1);
  wholesaleColumnsAvailable = !error;
  return wholesaleColumnsAvailable;
}

/**
 * Builds a payload that only includes columns the schema actually has, so the
 * admin panel works before and after the site-control migration is applied.
 */
async function sanitizeProductPayload(input: Partial<ProductInput>): Promise<Partial<ProductInput>> {
  const clean = { ...input };
  const wholesale = await hasWholesaleColumns();
  if (!wholesale) for (const col of WHOLESALE_COLUMNS) delete clean[col as keyof ProductInput];
  const publish = await hasPublishColumns();
  if (!publish) {
    delete clean.published;
    delete clean.new_drop;
  }
  return clean;
}

async function requireAdminImageAccess(): Promise<void> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('Sign in as the authorized administrator to upload product images.');

  const { count, error } = await supabase
    .from('admin_users')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (error || (count ?? 0) !== 1) {
    throw new Error('Only the authorized administrator can upload product images.');
  }
}

export async function uploadProductImage(file: File, productId: string, colorName: string): Promise<string> {
  if (!(file instanceof File) || file.size <= 0) {
    throw new Error('Choose a non-empty image file before uploading.');
  }
  if (!PRODUCT_IMAGE_TYPES.has(file.type)) {
    throw new Error('Only JPG, PNG, and WebP product images are supported.');
  }
  if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error('Product images must be 10 MB or smaller.');
  }

  await requireAdminImageAccess();

  const fileExt = PRODUCT_IMAGE_EXTENSIONS[file.type];
  const safeColorName = colorName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'color';
  const uniqueId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const objectPath = `${productId}-${safeColorName}-${uniqueId}.${fileExt}`;

  const { data, error } = await supabase.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .upload(objectPath, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || 'application/octet-stream',
    });

  if (error) throw error;
  const publicUrl = supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(data.path).data.publicUrl;
  if (!publicUrl) {
    throw new Error('Failed to create the uploaded image URL.');
  }

  return publicUrl;
}

export async function adminCreateProduct(input: ProductInput): Promise<ProductRow> {
  const payload = await sanitizeProductPayload(input);
  const { data, error } = await supabase
    .from('products')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;

  const product = data as ProductRow;

  // Size rows are created per-color via adminAddColor, not here,
  // because color_id is required on product_sizes.

  // Create default size chart
  const defaultChart: Record<string, { chest: number; length: number; shoulder: number }> = {
    M: { chest: 52, length: 28, shoulder: 24 },
    L: { chest: 56, length: 29, shoulder: 25 },
    XL: { chest: 60, length: 30, shoulder: 26 },
  };
  const chartRows = SIZE_LABELS.map((label, i) => ({
    product_id: product.id,
    size_label: label,
    chest: defaultChart[label].chest,
    length: defaultChart[label].length,
    shoulder: defaultChart[label].shoulder,
    sort_order: i,
  }));
  const { error: chartError } = await supabase.from('size_chart_rows').insert(chartRows);
  if (chartError) throw chartError;

  return product;
}

export async function adminUpdateProduct(id: string, input: Partial<ProductInput>): Promise<void> {
  const { slug: _slug, ...rest } = input;
  const payload = await sanitizeProductPayload(rest);
  const { error } = await supabase.from('products').update(payload).eq('id', id);
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
  const { data: existingColors } = await supabase
    .from('product_colors')
    .select('sort_order')
    .eq('product_id', productId)
    .order('sort_order', { ascending: false })
    .limit(1);
  const maxSort = (existingColors?.[0] as { sort_order?: number } | undefined)?.sort_order ?? -1;

  const { data, error } = await supabase
    .from('product_colors')
    .insert({ product_id: productId, name, hex, images, sort_order: maxSort + 1 })
    .select()
    .single();
  if (error) throw error;

  const color = data as ProductColorRow;

  // Create default size rows for this color with stock = 0
  const sizeRows = SIZE_LABELS.map((label) => ({
    product_id: productId,
    color_id: color.id,
    size_label: label,
    available: false,
    stock: 0,
  }));
  const { error: sizesError } = await supabase.from('product_sizes').insert(sizeRows);
  if (sizesError) throw sizesError;

  return color;
}

export async function adminUpdateColor(id: string, patch: Partial<Pick<ProductColorRow, 'name' | 'hex' | 'images' | 'sort_order'>>): Promise<void> {
  const { error } = await supabase.from('product_colors').update(patch).eq('id', id);
  if (error) throw error;
}

export async function adminDeleteColor(id: string): Promise<void> {
  const { error } = await supabase.from('product_colors').delete().eq('id', id);
  if (error) throw error;
}

export async function adminUpdateColorSortOrders(productId: string, orderedIds: string[]): Promise<void> {
  const updates = orderedIds.map((id, i) =>
    supabase.from('product_colors').update({ sort_order: i }).eq('id', id).eq('product_id', productId)
  );
  const results = await Promise.all(updates);
  const firstError = results.find((r) => r.error);
  if (firstError?.error) throw firstError.error;
}

// Initialize default size rows for a color that has none
export async function adminInitColorSizes(productId: string, colorId: string): Promise<void> {
  const { data: existing, error: checkError } = await supabase
    .from('product_sizes')
    .select('id')
    .eq('product_id', productId)
    .eq('color_id', colorId)
    .limit(1);
  if (checkError) throw checkError;
  if (existing && existing.length > 0) return;

  const sizeRows = SIZE_LABELS.map((label) => ({
    product_id: productId,
    color_id: colorId,
    size_label: label,
    available: true,
    stock: 0,
  }));
  const { error } = await supabase.from('product_sizes').insert(sizeRows);
  if (error) throw error;
}

// Sizes
export async function adminUpdateSizeStock(
  productId: string,
  colorId: string,
  sizeLabel: string,
  stock: number
): Promise<void> {
  const nextStock = Math.max(0, Math.floor(Number(stock) || 0));

  const { error } = await supabase
    .from('product_sizes')
    .update({ stock: nextStock, available: nextStock > 0 })
    .eq('product_id', productId)
    .eq('color_id', colorId)
    .eq('size_label', sizeLabel);

  if (error) throw error;
}

// Size chart
export async function adminUpdateSizeChartRow(id: string, chest: number, length: number, shoulder: number): Promise<void> {
  const { error } = await supabase.from('size_chart_rows').update({ chest, length, shoulder }).eq('id', id);
  if (error) throw error;
}

export async function uploadHeroImage(file: File): Promise<string> {
  if (!(file instanceof File) || file.size <= 0) {
    throw new Error('Choose a non-empty image file before uploading.');
  }
  if (!PRODUCT_IMAGE_TYPES.has(file.type)) {
    throw new Error('Only JPG, PNG, and WebP images are supported.');
  }
  if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error('Images must be 10 MB or smaller.');
  }

  await requireAdminImageAccess();

  const fileExt = PRODUCT_IMAGE_EXTENSIONS[file.type];
  const uniqueId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const objectPath = `hero/${uniqueId}.${fileExt}`;

  const { data, error } = await supabase.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .upload(objectPath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || 'application/octet-stream',
    });

  if (error) throw error;
  const publicUrl = supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(data.path).data.publicUrl;
  if (!publicUrl) {
    throw new Error('Failed to create the uploaded image URL.');
  }

  return publicUrl;
}

// Hero slides
export async function adminCreateHero(input: Omit<HeroSlideRow, 'id' | 'created_at'>): Promise<void> {
  const insert: Record<string, unknown> = {
    image_url: input.image_url,
    eyebrow: input.eyebrow,
    title: input.title,
    subtitle: input.subtitle,
    sort_order: input.sort_order,
    active: input.active,
  };
  if (await hasHeroCtaColumns()) {
    insert.cta_text = input.cta_text ?? null;
    insert.cta_url = input.cta_url ?? null;
  }
  const { error } = await supabase.from('hero_slides').insert(insert);
  if (error) throw error;
}

export async function adminUpdateHero(id: string, patch: Partial<Omit<HeroSlideRow, 'id' | 'created_at'>>): Promise<void> {
  if (!(await hasHeroCtaColumns())) {
    delete patch.cta_text;
    delete patch.cta_url;
  }
  const { error } = await supabase.from('hero_slides').update(patch).eq('id', id);
  if (error) throw error;
}

export async function adminDeleteHero(id: string): Promise<void> {
  const { error } = await supabase.from('hero_slides').delete().eq('id', id);
  if (error) throw error;
}

let heroCtaAvailable: boolean | null = null;

/** Whether hero_slides has the cta_text/cta_url columns yet (migration-gated). */
export async function hasHeroCtaColumns(): Promise<boolean> {
  if (heroCtaAvailable !== null) return heroCtaAvailable;
  const { error } = await supabase.from('hero_slides').select('cta_text, cta_url').limit(1);
  heroCtaAvailable = !error;
  return heroCtaAvailable;
}

// Site settings (admin-controlled source of truth for storefront vitals)
export async function adminFetchSiteSettings(): Promise<SiteSettings> {
  const { data, error } = await supabase
    .from('site_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;

  const row = data as
    | {
        announcement_text?: string | null;
        announcement_active?: boolean | null;
        whatsapp_number?: string | null;
        default_moq?: number | null;
        dispatch_note?: string | null;
        delivery_note?: string | null;
      }
    | null;

  const fallback: SiteSettings = {
    announcement_text: 'SAME DAY DISPATCH • FOR RESELLERS & WHOLESALE ONLY • PAN INDIA DELIVERY',
    announcement_active: true,
    whatsapp_number: '919944676178',
    default_moq: 50,
    dispatch_note: 'Same Day Dispatch',
    delivery_note: 'Pan India',
  };

  if (!row) return fallback;

  return {
    announcement_text: row.announcement_text ?? fallback.announcement_text,
    announcement_active: row.announcement_active ?? fallback.announcement_active,
    whatsapp_number: (row.whatsapp_number ?? '').trim() || fallback.whatsapp_number,
    default_moq: Number(row.default_moq ?? 0) || fallback.default_moq,
    dispatch_note: row.dispatch_note ?? fallback.dispatch_note,
    delivery_note: row.delivery_note ?? fallback.delivery_note,
  };
}

export async function adminSaveSiteSettings(settings: SiteSettings): Promise<void> {
  const { error } = await supabase
    .from('site_settings')
    .update({
      announcement_text: settings.announcement_text,
      announcement_active: settings.announcement_active,
      whatsapp_number: settings.whatsapp_number,
      default_moq: settings.default_moq,
      dispatch_note: settings.dispatch_note,
      delivery_note: settings.delivery_note,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);
  if (error) throw error;
}

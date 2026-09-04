import { supabase } from '@/lib/supabase';
import type {
  CatalogProduct,
  HeroSlideRow,
  ProductColorRow,
  ProductRow,
  ProductSizeRow,
  RetailOrder,
} from '@/lib/types';
import { SIZE_LABELS } from '@/lib/types';
import { hasPublishColumns } from '@/lib/catalog';

export const PRODUCT_IMAGE_BUCKET = 'product-images';
const PRODUCT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
const PRODUCT_IMAGE_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const ALLOWED_SIZES = new Set<string>(SIZE_LABELS);
const SIZE_ORDER: Record<string, number> = { M: 0, L: 1, XL: 2 };

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
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
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
    size_chart: ((chart as Array<{ product_id: string }> | null)?.filter((r) => r.product_id === p.id) ?? []) as never,
  }));
}

export async function adminFetchHero(): Promise<HeroSlideRow[]> {
  const { data, error } = await supabase.from('hero_slides').select('*').order('sort_order');
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
  return (data as HeroSlideRow[]) ?? [];
}

export interface ProductInput {
  slug: string;
  name: string;
  code: string;
  category: string;
  badge: string | null;
  featured: boolean;
  published: boolean;
  new_drop: boolean;
  sort_order: number;
  moq: number | null;
  wholesale_price_50: number | null;
  wholesale_price_100: number | null;
  // Retail / D2C fields
  price: number | null;
  mrp: number | null;
  retail_visible: boolean;
}

export const WHOLESALE_COLUMNS = ['wholesale_price_50', 'wholesale_price_100'] as const;

let wholesaleColumnsAvailable: boolean | null = null;
let wholesaleProbeError: unknown = null;

/**
 * Detects whether the products table has the wholesale pricing columns
 * (wholesale_price_50 / wholesale_price_100). Probes ONLY those two columns —
 * an unrelated missing column (e.g. moq) must never make this report false.
 */
export async function hasWholesaleColumns(): Promise<boolean> {
  if (wholesaleColumnsAvailable !== null) return wholesaleColumnsAvailable;
  const { error } = await supabase
    .from('products')
    .select('wholesale_price_50, wholesale_price_100')
    .limit(1);
  wholesaleColumnsAvailable = !error;
  wholesaleProbeError = error ?? null;
  return wholesaleColumnsAvailable;
}

let retailColumnsAvailable: boolean | null = null;

/** Whether the products table has the retail_visible column (migration-gated). */
export async function hasRetailColumns(): Promise<boolean> {
  if (retailColumnsAvailable !== null) return retailColumnsAvailable;
  const { error } = await supabase.from('products').select('retail_visible').limit(1);
  retailColumnsAvailable = !error;
  return retailColumnsAvailable;
}

let moqColumnAvailable: boolean | null = null;

/** Whether the products table has the optional moq column. */
async function hasMoqColumn(): Promise<boolean> {
  if (moqColumnAvailable !== null) return moqColumnAvailable;
  const { error } = await supabase.from('products').select('moq').limit(1);
  moqColumnAvailable = !error;
  return moqColumnAvailable;
}

let newDropColumnAvailable: boolean | null = null;

/**
 * Whether the products table actually has the new_drop column. Checked
 * independently of published so the admin write path never sends a new_drop
 * value to PostgREST when the column is absent (which would throw a
 * schema-cache/42703 error).
 */
async function hasNewDropColumn(): Promise<boolean> {
  if (newDropColumnAvailable !== null) return newDropColumnAvailable;
  const { error } = await supabase.from('products').select('new_drop').limit(1);
  newDropColumnAvailable = !error;
  return newDropColumnAvailable;
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function isNetworkFailure(err: unknown, technical: string): boolean {
  if (err instanceof TypeError) return true;
  return /fetch failed|failed to fetch|networkerror|network error|load failed|ENOTFOUND|ECONNREFUSED|FETCH_ERROR|timeout/i.test(technical);
}

/**
 * Turns a Supabase/PostgREST/Storage failure into a short, accurate message.
 * Distinguishes: missing column, permission/RLS, authentication, network,
 * invalid query and other errors — and always logs the full technical detail
 * so the real Supabase error is visible in the console during development.
 */
export function describeSupabaseError(err: unknown, fallback: string): string {
  const envelope = (err ?? {}) as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
  const raw = firstString(envelope.message, envelope.details, envelope.hint, err instanceof Error ? err.message : null, typeof err === 'string' ? err : null);
  const code = typeof envelope.code === 'string' ? envelope.code : '';
  const technical = `${code} ${raw}`.trim();
  const isDev = Boolean(import.meta.env.DEV);

  console.error('[DSLANG] Supabase request failed:', err);

  if (isNetworkFailure(err, technical)) {
    return 'Network error — the database could not be reached. Check your connection and try again.';
  }
  if (/invalid api key|apikey|jwt|PGRST1012/i.test(technical)) {
    return 'Authentication error — this session is not fully authenticated. Sign in and try again.';
  }
  if (/42501|permission denied|row.?level security|PGRST301|PGRST302|forbidden/i.test(technical)) {
    return 'Permission denied — this account is not allowed to make that change.';
  }
  if (/42703|could not find the \w+ column|undefin\w* column|column \w+ does not exist|PGRST204/i.test(technical)) {
    return isDev
      ? `Missing database column — ${raw}.`
      : `A database column is missing (${raw}). The product editor needs wholesale_price_50 and wholesale_price_100 on the products table.`;
  }
  if (/could not find the table|42P01|PGRST205/i.test(technical)) {
    return `Table not found — ${raw}.`;
  }
  if (/could not find.*function|PGRST202/i.test(technical)) {
    return `Database function missing — ${raw}.`;
  }
  if (/42601|syntax error|PGRST200|PGRST201/i.test(technical)) {
    return `Invalid query — ${raw}.`;
  }
  if (isDev && technical) return technical.length > 220 ? `${technical.slice(0, 220)}…` : technical;
  return raw || fallback;
}

/**
 * Builds a product payload that only includes columns the live schema has, so
 * the admin panel works before and after schema changes. Wholesale pricing is
 * never silently dropped: if the wholesale columns are genuinely missing while
 * pricing was entered, the real Supabase error is surfaced instead.
 */
async function sanitizeProductPayload(input: Partial<ProductInput>): Promise<Partial<ProductInput>> {
  const clean = { ...input };

  if (!(await hasMoqColumn())) delete clean.moq;
  if (!(await hasPublishColumns())) delete clean.published;
  if (!(await hasNewDropColumn())) delete clean.new_drop;
  if (!(await hasRetailColumns())) delete clean.retail_visible;
  if (clean.price === null || clean.price === undefined) delete clean.price;

  const wholesale = await hasWholesaleColumns();
  const hasPricing =
    (clean.wholesale_price_50 !== null && clean.wholesale_price_50 !== undefined) ||
    (clean.wholesale_price_100 !== null && clean.wholesale_price_100 !== undefined);

  if (!wholesale) {
    if (hasPricing) {
      throw new Error(
        describeSupabaseError(
          wholesaleProbeError,
          'Could not save the wholesale price — the wholesale_price_50 / wholesale_price_100 fields could not be verified on the products table.'
        )
      );
    }
    for (const col of WHOLESALE_COLUMNS) delete clean[col];
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

  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
  const publicUrl = supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(data.path).data.publicUrl;
  if (!publicUrl) {
    throw new Error('Failed to create the uploaded image URL.');
  }

  return publicUrl;
}

export async function adminCreateProduct(input: ProductInput): Promise<ProductRow> {
  const clean = await sanitizeProductPayload(input);
  // moq is a NOT NULL column with a DB default (50). Sending an explicit null
  // would override that default and violate the not-null constraint, so drop it
  // whenever it is unset and let the database supply a valid integer.
  if (clean.moq === null || clean.moq === undefined) delete clean.moq;
  // The retail price is admin-editable (products.price); fabric/fit/care are
  // legacy NOT NULL columns satisfied with empty strings on insert.
  const priceValue = Number(clean.price ?? 0);
  if (!Number.isFinite(priceValue) || priceValue < 0) {
    throw new Error('Price must be a non-negative number.');
  }
  const payload: Record<string, unknown> = {
    ...clean,
    price: Math.floor(priceValue),
    mrp: clean.mrp !== null && clean.mrp !== undefined ? Number(clean.mrp) : null,
    fabric: '',
    fit: '',
    care: '',
  };
  const { data, error } = await supabase
    .from('products')
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));

  return data as ProductRow;
}

export async function adminUpdateProduct(id: string, input: Partial<ProductInput>): Promise<void> {
  const { slug: _slug, ...rest } = input;
  const payload = await sanitizeProductPayload(rest);
  // Never send an explicit null for the NOT NULL moq column (would override the
  // DB default / trip the not-null constraint on an existing row).
  if (payload.moq === null || payload.moq === undefined) delete payload.moq;
  const { error } = await supabase.from('products').update(payload).eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
}

export async function adminDeleteProduct(id: string): Promise<void> {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
}

/** Admin updates the D2C stock for one variant (color/size) via the existing
 * security-defined set_product_size_stock RPC (admin-gated in the database). */
export async function adminSetSizeStock(
  productId: string,
  colorId: string,
  sizeLabel: string,
  stock: number
): Promise<void> {
  const whole = Math.max(0, Math.floor(Number(stock) || 0));
  const { error } = await supabase.rpc('set_product_size_stock', {
    p_product_id: productId,
    p_color_id: colorId,
    p_size_label: sizeLabel,
    p_stock: whole,
  });
  if (error) throw new Error(describeSupabaseError(error, 'Could not update stock.'));
}

export async function adminFetchRetailOrders(): Promise<RetailOrder[]> {
  const { data, error } = await supabase
    .from('retail_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(describeSupabaseError(error, 'Could not load retail orders.'));
  return (data as RetailOrder[]) ?? [];
}

/**
 * Permanently deletes a single retail order via the admin-only
 * `delete_retail_order` RPC. The RPC authorizes against admin_users and
 * reverses any promo-code usage the order consumed. Throws if the order does
 * not exist (so the UI never pretends a delete happened).
 */
export async function adminDeleteRetailOrder(orderId: string): Promise<void> {
  const { data, error } = await supabase.rpc('delete_retail_order', {
    p_order_id: orderId,
  });
  if (error) throw new Error(describeSupabaseError(error, 'Could not delete the order.'));
  if ((data as number) !== 1) {
    throw new Error('The order could not be found and was not deleted.');
  }
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
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));

  return data as ProductColorRow;
}

export async function adminUpdateColor(id: string, patch: Partial<Pick<ProductColorRow, 'name' | 'hex' | 'images' | 'sort_order'>>): Promise<void> {
  const { error } = await supabase.from('product_colors').update(patch).eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
}

export async function adminDeleteColor(id: string): Promise<void> {
  const { error } = await supabase.from('product_colors').delete().eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
}

export async function adminUpdateColorSortOrders(productId: string, orderedIds: string[]): Promise<void> {
  const updates = orderedIds.map((id, i) =>
    supabase.from('product_colors').update({ sort_order: i }).eq('id', id).eq('product_id', productId)
  );
  const results = await Promise.all(updates);
  const firstError = results.find((r) => r.error);
  if (firstError?.error) throw new Error(describeSupabaseError(firstError.error, 'Could not reorder colors.'));
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

  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
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
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
}

export async function adminUpdateHero(id: string, patch: Partial<Omit<HeroSlideRow, 'id' | 'created_at'>>): Promise<void> {
  if (!(await hasHeroCtaColumns())) {
    delete patch.cta_text;
    delete patch.cta_url;
  }
  const { error } = await supabase.from('hero_slides').update(patch).eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
}

export async function adminDeleteHero(id: string): Promise<void> {
  const { error } = await supabase.from('hero_slides').delete().eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
}

let heroCtaAvailable: boolean | null = null;

/** Whether hero_slides has the cta_text/cta_url columns yet (migration-gated). */
export async function hasHeroCtaColumns(): Promise<boolean> {
  if (heroCtaAvailable !== null) return heroCtaAvailable;
  const { error } = await supabase.from('hero_slides').select('cta_text, cta_url').limit(1);
  heroCtaAvailable = !error;
  return heroCtaAvailable;
}


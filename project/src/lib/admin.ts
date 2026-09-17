import { supabase } from '@/lib/supabase';
import type {
  CatalogProduct,
  HeroSlideRow,
  ProductColorRow,
  ProductRow,
  ProductSizeRow,
  RetailOrder,
} from '@/lib/types';
import { sortSizeRows } from '@/lib/sizes';
import { hasPublishColumns, invalidateCatalog } from '@/lib/catalog';

export const PRODUCT_IMAGE_BUCKET = 'product-images';
const PRODUCT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
const PRODUCT_IMAGE_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function sortSizes(sizes: ProductSizeRow[]): ProductSizeRow[] {
  return sortSizeRows(sizes);
}

function cleanImageUrls(images: string[] | null | undefined): string[] {
  return (images ?? []).filter((image): image is string => typeof image === 'string' && image.trim().length > 0).map((image) => image.trim());
}

function decodeImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode this image.'));
    };
    img.src = url;
  });
}

interface OptimizedImage {
  blob: Blob;
  ext: string;
}

/**
 * Client-side re-encode + downscale before upload — zero server cost on the
 * free tier. A ~1.8 MB phone PNG typically becomes a few-hundred-KB WebP, so
 * product/hero images render far faster for shoppers without touching product
 * data (DB image URLs keep pointing at the same storage paths). Falls back to
 * the original file whenever the browser cannot re-encode (no canvas, WebP
 * encode unavailable, or WebP is not meaningfully smaller).
 */
async function optimizeImage(file: File, maxDim = 1600): Promise<OptimizedImage> {
  const originalExt = PRODUCT_IMAGE_EXTENSIONS[file.type] ?? 'jpg';

  let img: HTMLImageElement;
  try {
    img = await decodeImageFile(file);
  } catch {
    return { blob: file, ext: originalExt };
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return { blob: file, ext: originalExt };

  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
  if (!webp || webp.size >= file.size * 0.9) {
    return { blob: file, ext: originalExt };
  }
  return { blob: webp, ext: 'webp' };
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
  const { data, error } = await supabase
    .from('hero_slides')
    .select('id, image_url, sort_order, active, created_at')
    .order('sort_order');
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
  return (data as HeroSlideRow[]) ?? [];
}

export interface ProductInput {
  slug: string;
  name: string;
  code: string;
  category: string;
  featured: boolean;
  published: boolean;
  new_drop: boolean;
  sort_order: number;
  // Retail / D2C fields
  price: number | null;
  mrp: number | null;
  retail_visible: boolean;
}

let retailColumnsAvailable: boolean | null = null;

/** Whether the products table has the retail_visible column (migration-gated). */
export async function hasRetailColumns(): Promise<boolean> {
  if (retailColumnsAvailable !== null) return retailColumnsAvailable;
  const { error } = await supabase.from('products').select('retail_visible').limit(1);
  retailColumnsAvailable = !error;
  return retailColumnsAvailable;
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
      : `A database column is missing (${raw}). Reload the page and try again.`;
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
 * the admin panel works before and after schema changes.
 */
async function sanitizeProductPayload(input: Partial<ProductInput>): Promise<Partial<ProductInput>> {
  const clean = { ...input };

  if (!(await hasPublishColumns())) delete clean.published;
  if (!(await hasNewDropColumn())) delete clean.new_drop;
  if (!(await hasRetailColumns())) delete clean.retail_visible;
  if (clean.price === null || clean.price === undefined) delete clean.price;

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

  const optimized = await optimizeImage(file);
  const fileExt = optimized.ext;
  const safeColorName = colorName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'color';
  const uniqueId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const objectPath = `${productId}-${safeColorName}-${uniqueId}.${fileExt}`;

  const { data, error } = await supabase.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .upload(objectPath, optimized.blob, {
      cacheControl: '31536000, immutable',
      upsert: true,
      contentType: optimized.blob.type || 'image/webp',
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

  // A new product is immediately part of the storefront catalog.
  invalidateCatalog();
  return data as ProductRow;
}

export async function adminUpdateProduct(id: string, input: Partial<ProductInput>): Promise<void> {
  const { slug: _slug, ...rest } = input;
  const payload = await sanitizeProductPayload(rest);
  const { error } = await supabase.from('products').update(payload).eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
  invalidateCatalog();
}

export async function adminDeleteProduct(id: string): Promise<void> {
  // Collect every colour image first — product_colors rows cascade-delete with
  // the product, so their images must be gathered before the delete.
  const { data: colorRows } = await supabase
    .from('product_colors')
    .select('images')
    .eq('product_id', id);
  const productImages = (colorRows ?? []).flatMap((row) =>
    cleanImageUrls((row as { images?: string[] | null }).images)
  );

  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
  invalidateCatalog();

  if (productImages.length > 0) {
    noteCleanupResult(await deleteUnreferencedStorageObjects(productImages));
  }
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
  // Fresh stock figures must reach the storefront cards immediately.
  invalidateCatalog();
}

/**
 * Bulk updates stock for many variants in parallel. Respects the same
 * security-defined set_product_size_stock RPC as adminSetSizeStock but issues
 * a single catalog cache invalidation for the whole batch.
 */
export async function adminBulkSetSizeStock(
  updates: Array<{ productId: string; colorId: string; sizeLabel: string; stock: number }>
): Promise<void> {
  if (updates.length === 0) return;
  const jobs = updates.map(async ({ productId, colorId, sizeLabel, stock }) => {
    const whole = Math.max(0, Math.floor(Number(stock) || 0));
    const { error } = await supabase.rpc('set_product_size_stock', {
      p_product_id: productId,
      p_color_id: colorId,
      p_size_label: sizeLabel,
      p_stock: whole,
    });
    if (error) throw new Error(describeSupabaseError(error, 'Could not update stock.'));
  });
  await Promise.all(jobs);
  invalidateCatalog();
}

/**
 * Removes a size from a product entirely: deletes every variant row
 * (product_id + size_label across all colours) plus its size-chart rows.
 * Admin-gated by the product_sizes / size_chart_rows RLS policies.
 */
export async function adminRemoveProductSize(
  productId: string,
  sizeLabel: string
): Promise<void> {
  const sizesResult = await supabase
    .from('product_sizes')
    .delete()
    .eq('product_id', productId)
    .eq('size_label', sizeLabel);
  if (sizesResult.error) {
    throw new Error(describeSupabaseError(sizesResult.error, 'Could not remove this size.'));
  }
  const chartResult = await supabase
    .from('size_chart_rows')
    .delete()
    .eq('product_id', productId)
    .eq('size_label', sizeLabel);
  if (chartResult.error) {
    throw new Error(describeSupabaseError(chartResult.error, 'Could not remove this size.'));
  }
  invalidateCatalog();
}

export async function adminFetchRetailOrders(options?: { offset?: number; limit?: number }): Promise<RetailOrder[]> {
  const offset = Math.max(0, Math.floor(options?.offset ?? 0));
  const limit = Math.min(500, Math.max(1, Math.floor(options?.limit ?? 100)));
  const { data, error } = await supabase
    .from('retail_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
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

  invalidateCatalog();
  return data as ProductColorRow;
}

export async function adminUpdateColor(id: string, patch: Partial<Pick<ProductColorRow, 'name' | 'hex' | 'images' | 'sort_order'>>): Promise<void> {
  let oldImages: string[] = [];
  if (Array.isArray(patch.images)) {
    const { data: oldRows } = await supabase
      .from('product_colors')
      .select('images')
      .eq('id', id)
      .limit(1);
    oldImages = cleanImageUrls((oldRows?.[0] as { images?: string[] | null } | undefined)?.images);
  }

  const { error } = await supabase.from('product_colors').update(patch).eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
  invalidateCatalog();

  if (Array.isArray(patch.images)) {
    const newSet = new Set(cleanImageUrls(patch.images));
    const removed = oldImages.filter((url) => !newSet.has(url));
    if (removed.length > 0) {
      noteCleanupResult(await deleteUnreferencedStorageObjects(removed));
    }
  }
}

export async function adminDeleteColor(id: string): Promise<void> {
  const { data: oldRows } = await supabase
    .from('product_colors')
    .select('images')
    .eq('id', id)
    .limit(1);
  const oldImages = cleanImageUrls((oldRows?.[0] as { images?: string[] | null } | undefined)?.images);

  const { error } = await supabase.from('product_colors').delete().eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
  invalidateCatalog();

  if (oldImages.length > 0) {
    noteCleanupResult(await deleteUnreferencedStorageObjects(oldImages));
  }
}

export async function adminUpdateColorSortOrders(productId: string, orderedIds: string[]): Promise<void> {
  const updates = orderedIds.map((id, i) =>
    supabase.from('product_colors').update({ sort_order: i }).eq('id', id).eq('product_id', productId)
  );
  const results = await Promise.all(updates);
  const firstError = results.find((r) => r.error);
  if (firstError?.error) throw new Error(describeSupabaseError(firstError.error, 'Could not reorder colors.'));
  invalidateCatalog();
}

/**
 * Persists an admin-defined size display order for a product. Writes the same
 * sort_order to every variant row (product_id + size_label, all colours) and
 * mirrors it onto size_chart_rows so the size chart follows the same order.
 * Sizes absent from the list keep their existing values.
 */
export async function adminSetSizeOrder(productId: string, orderedLabels: string[]): Promise<void> {
  const updates = orderedLabels.flatMap((label, i) => {
    const rank = i + 1;
    return [
      supabase.from('product_sizes').update({ sort_order: rank }).eq('product_id', productId).eq('size_label', label),
      supabase.from('size_chart_rows').update({ sort_order: rank }).eq('product_id', productId).eq('size_label', label),
    ];
  });
  const results = await Promise.all(updates);
  const firstError = results.find((r) => r.error);
  if (firstError?.error) throw new Error(describeSupabaseError(firstError.error, 'Could not reorder sizes.'));
  invalidateCatalog();
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

  const optimized = await optimizeImage(file, 1920);
  const fileExt = optimized.ext;
  const uniqueId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const objectPath = `hero/${uniqueId}.${fileExt}`;

  const { data, error } = await supabase.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .upload(objectPath, optimized.blob, {
      cacheControl: '31536000, immutable',
      upsert: false,
      contentType: optimized.blob.type || 'image/webp',
    });

  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
  const publicUrl = supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(data.path).data.publicUrl;
  if (!publicUrl) {
    throw new Error('Failed to create the uploaded image URL.');
  }

  return publicUrl;
}

/* ---- Automatic old-image cleanup (Supabase Storage) ----

   When an admin replaces/removes an image the flow is always:
     1. Upload the new image           (done by uploadProductImage/uploadHeroImage)
     2. Persist the new DB reference   (done by the update functions below)
     3. ONLY THEN delete the old Storage object, and only if no other record
        still references the same path.

   Old objects are never deleted before the replacement succeeds, external
   URLs (not on our Storage host) are never touched, and any path still
   referenced by hero_slides or any product colour's images array is kept.
*/

const STORAGE_PUBLIC_PATH_RE = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/;

interface StorageObjectRef {
  bucket: string;
  path: string;
  key: string;
}

/** Extracts { bucket, path } from a Supabase Storage public URL, or null for
 *  external hosts (Pexels seeds, pasted URLs) which we never delete. */
function parseStorageObject(url: string): StorageObjectRef | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = STORAGE_PUBLIC_PATH_RE.exec(parsed.pathname);
    if (!match) return null;
    const bucket = decodeURIComponent(match[1]);
    const path = decodeURIComponent(match[2]);
    if (!bucket || !path) return null;
    return { bucket, path, key: `${bucket}/${path}` };
  } catch {
    return null;
  }
}

/** Reads the CURRENT database state and returns every Storage path still
 *  referenced by hero_slides or product_colors.images, keyed as
 *  `bucket/path`. Runs under the admin session so it sees all rows.
 *  Throws if either reference query errors: with an unknown reference set,
 *  no object may be deleted (deletion proceeds only on a complete read). */
async function collectReferencedStorageKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const addUrl = (url: unknown) => {
    const ref = parseStorageObject(typeof url === 'string' ? url : '');
    if (ref) keys.add(ref.key);
  };

  const [heroRes, colorsRes] = await Promise.all([
    supabase.from('hero_slides').select('image_url'),
    supabase.from('product_colors').select('images'),
  ]);

  if (heroRes.error || colorsRes.error) {
    throw new Error('Image references could not be verified — cleanup aborted for safety.');
  }
  (heroRes.data ?? []).forEach((row) => addUrl((row as { image_url?: unknown }).image_url));
  for (const row of (colorsRes.data ?? []) as Array<{ images?: unknown }>) {
    if (Array.isArray(row.images)) row.images.forEach(addUrl);
  }
  return keys;
}

interface CleanupResult {
  deleted: string[];
  kept: string[];
  failed: string[];
}

/** Deletes each Storage object whose path is no longer referenced anywhere.
 *  Always called AFTER the DB reference change has succeeded. External URLs,
 *  objects outside the managed bucket, and still-referenced paths are skipped.
 *  If the reference set cannot be read completely, NOTHING is deleted (the
 *  URLs are reported as failed so the admin sees a warning instead of a
 *  silently inconsistent result). */
async function deleteUnreferencedStorageObjects(urls: string[]): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: [], kept: [], failed: [] };
  const managed = Array.from(new Set(urls)).map((url) => parseStorageObject(url)).filter(
    (ref): ref is StorageObjectRef => ref !== null && ref.bucket === PRODUCT_IMAGE_BUCKET
  );
  if (managed.length === 0) return result;

  let refs: Set<string>;
  try {
    refs = await collectReferencedStorageKeys();
  } catch (err) {
    console.error('[DSLANG] Image cleanup aborted: reference set unavailable.', err);
    result.failed = managed.map((ref) => ref.key);
    return result;
  }

  for (const ref of managed) {
    if (refs.has(ref.key)) {
      // Still used by another hero slide or colour — keep it.
      result.kept.push(ref.key);
      continue;
    }
    const { error } = await supabase.storage.from(ref.bucket).remove([ref.path]);
    if (error) result.failed.push(ref.key);
    else result.deleted.push(ref.key);
  }
  return result;
}

let pendingCleanupWarning: string | null = null;

function noteCleanupResult(result: CleanupResult): void {
  if (result.failed.length > 0) {
    pendingCleanupWarning =
      `Saved, but ${result.failed.length} old image file(s) could not be removed from storage: ${result.failed.slice(0, 3).join(', ')}${result.failed.length > 3 ? '…' : ''}.`;
    console.error('[DSLANG] Storage cleanup failed:', result.failed);
  } else if (result.deleted.length > 0) {
    console.info('[DSLANG] Removed old image(s) from storage:', result.deleted);
  }
}

/** Returns (and clears) the most recent non-fatal image-cleanup warning. DB
 *  writes always succeed first; this is surfaced so the admin knows a Storage
 *  object could not be removed. */
export function latestImageCleanupWarning(): string | null {
  const warning = pendingCleanupWarning;
  pendingCleanupWarning = null;
  return warning;
}

// Hero slides
export async function adminCreateHero(input: Omit<HeroSlideRow, 'id' | 'created_at'>): Promise<void> {
  const insert: Record<string, unknown> = {
    image_url: input.image_url,
    sort_order: input.sort_order,
    active: input.active,
  };
  const { error } = await supabase.from('hero_slides').insert(insert);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));
}

export async function adminUpdateHero(id: string, patch: Partial<Omit<HeroSlideRow, 'id' | 'created_at'>>): Promise<void> {
  // Remember the image being replaced so it can be cleaned up AFTER the new
  // reference is persisted (never before — a failed update keeps the old file).
  let oldImage: string | null = null;
  if (typeof patch.image_url === 'string') {
    const { data: oldRows } = await supabase
      .from('hero_slides')
      .select('image_url')
      .eq('id', id)
      .limit(1);
    oldImage = (oldRows?.[0] as { image_url?: string | null } | undefined)?.image_url ?? null;
  }

  const { error } = await supabase.from('hero_slides').update(patch).eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));

  if (oldImage && oldImage !== patch.image_url) {
    noteCleanupResult(await deleteUnreferencedStorageObjects([oldImage]));
  }
}

export async function adminDeleteHero(id: string): Promise<void> {
  const { data: oldRows } = await supabase
    .from('hero_slides')
    .select('image_url')
    .eq('id', id)
    .limit(1);
  const oldImage = (oldRows?.[0] as { image_url?: string | null } | undefined)?.image_url ?? null;

  const { error } = await supabase.from('hero_slides').delete().eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'The request failed.'));

  if (oldImage) {
    noteCleanupResult(await deleteUnreferencedStorageObjects([oldImage]));
  }
}


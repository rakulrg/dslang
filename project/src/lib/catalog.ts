import { get } from '@/lib/rest';
import type {
  CatalogProduct,
  HeroSlideRow,
  ProductColorRow,
  ProductRow,
  ProductSizeRow,
  SizeChartRow,
} from '@/lib/types';
import { sortSizeRows } from '@/lib/sizes';
import { getSiteSettings } from '@/lib/settings';

export type { CatalogProduct, HeroSlideRow };

// Legacy contact fallbacks. The single source of truth for WhatsApp contact is
// the admin-controlled site_settings row: https://wa.me/... URLs read it.
export const WHATSAPP_NUMBER = '919944676178';
export const INSTAGRAM_URL = 'https://instagram.com/dslang.in';
export const EMAIL = 'hello.dslang@gmail.com';

function sortSizes(sizes: ProductSizeRow[]): ProductSizeRow[] {
  return sortSizeRows(sizes);
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Returns a clean #rgb/#rrggbb when the stored value holds one, else ''.
 *
 * The product_colors.hex column is filled by hand in the admin UI, so values
 * can carry stray whitespace (e.g. " #093624") or be null/empty. Every colour
 * consumer — card swatches, detail-page selectors, the colorHex written to
 * cart line items — must read the ACTUAL colour, not a byte-for-byte string
 * that the browser/CSS refuses to parse. Invalid rows degrade to '' and the
 * UI falls back to its pattern swatch instead of a transparent "broken" dot. */
export function normalizeHexColor(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim();
  return HEX_COLOR_RE.test(value) ? value : '';
}

export function cleanImageUrls(images: string[] | null | undefined): string[] {
  return (images ?? []).filter((image): image is string => typeof image === 'string' && image.trim().length > 0).map((image) => image.trim());
}

let publishColumnsAvailable: boolean | null = null;

/**
 * Whether the products table has the published column yet.
 * Migration-gated: before the site-control migration the storefront reads all
 * products; after it, only published ones are shown.
 */
export async function hasPublishColumns(): Promise<boolean> {
  if (publishColumnsAvailable !== null) return publishColumnsAvailable;
  try {
    await get('products', { limit: '1' }, { select: 'published' });
    publishColumnsAvailable = true;
  } catch {
    publishColumnsAvailable = false;
  }
  return publishColumnsAvailable;
}

let newDropColumnsAvailable: boolean | null = null;

/** Whether the products table has the new_drop column yet. */
async function hasNewDropColumns(): Promise<boolean> {
  if (newDropColumnsAvailable !== null) return newDropColumnsAvailable;
  try {
    await get('products', { limit: '1' }, { select: 'new_drop' });
    newDropColumnsAvailable = true;
  } catch {
    newDropColumnsAvailable = false;
  }
  return newDropColumnsAvailable;
}

let retailColumnsAvailable: boolean | null = null;

/** Whether the products table has the retail_visible column (migration-gated). */
async function hasRetailColumns(): Promise<boolean> {
  if (retailColumnsAvailable !== null) return retailColumnsAvailable;
  try {
    await get('products', { limit: '1' }, { select: 'retail_visible' });
    retailColumnsAvailable = true;
  } catch {
    retailColumnsAvailable = false;
  }
  return retailColumnsAvailable;
}

let productSizeOrderAvailable: boolean | null = null;

/** Whether product_sizes.sort_order exists yet (migration-gated). The column
 * only drives admin-defined size display order; sizes render in the shared
 * deterministic order without it, so the listing must not fail when absent. */
async function hasProductSizeOrder(): Promise<boolean> {
  if (productSizeOrderAvailable !== null) return productSizeOrderAvailable;
  try {
    await get('product_sizes', { limit: '1' }, { select: 'sort_order' });
    productSizeOrderAvailable = true;
  } catch {
    productSizeOrderAvailable = false;
  }
  return productSizeOrderAvailable;
}

/* ---- Single shared catalog cache ---- */

let catalogPromise: Promise<CatalogProduct[]> | null = null;
let catalogLoadedAt = 0;
const CATALOG_TTL_MS = 60_000;

/** Drops the cached catalog so the next call reads fresh data. Called by the
 * admin write paths whenever products/colors/sizes/stock change, so admin
 * edits show up on the storefront immediately (not after the TTL). */
export function invalidateCatalog(): void {
  catalogPromise = null;
  catalogLoadedAt = 0;
}

/** Forces a fresh catalog load from the database (used by admin reload flows). */
export function refreshCatalog(): Promise<CatalogProduct[]> {
  invalidateCatalog();
  return fetchProducts();
}

/**
 * THE catalog data source for every storefront surface (home, shop, new drops,
 * search, related products, account). All callers share ONE promise, so
 * Home → Shop → Product → back never refetches the same unchanged catalog, and
 * concurrent mounters (e.g. StrictMode, search while home renders) coalesce
 * into a single request. Errors evict the cache so a retry actually refetches;
 * a short TTL bounds staleness if someone edits the DB out-of-band.
 *
 * SAFETY: this caches LISTING data including the current per-variant stock
 * numbers. Purchase paths never trust it — the product detail page calls
 * fetchProduct() (always fresh) and cart/checkout re-validate live stock from
 * product_sizes via fetchLiveVariantStock(). Caching the catalog can never
 * cause overselling.
 */
export function fetchProducts(): Promise<CatalogProduct[]> {
  const now = Date.now();
  if (catalogPromise !== null && now - catalogLoadedAt < CATALOG_TTL_MS) {
    return catalogPromise;
  }
  catalogLoadedAt = now;
  catalogPromise = fetchCatalogFromDb().catch((err) => {
    catalogPromise = null;
    catalogLoadedAt = 0;
    throw err;
  });
  return catalogPromise;
}

/**
 * Fetches the catalog from the database with LISTING-ONLY data — just what
 * product cards / search / account stats need:
 *   - products: identity, retail price/MRP, category, flags, ordering. No
 *     descriptions, care/fabric/wash info or size charts.
 *   - colors: identity + swatch + images (required for card visuals).
 *   - sizes: every variant's identity + live stock (drives sold-out badges;
 *     purchasable-stock checks on cards), no size-chart payload.
 * The product detail page independently loads its full data via fetchProduct().
 */
async function fetchCatalogFromDb(): Promise<CatalogProduct[]> {
  // The migration-gated schema probes are independent of each other — run them
  // concurrently instead of serially. On a cold load this used to be three
  // sequential ~600 ms round-trips before the products query could even start.
  const [hasPublish, hasNewDrop, hasRetail, hasSizeOrder] = await Promise.all([
    hasPublishColumns(),
    hasNewDropColumns(),
    hasRetailColumns(),
    hasProductSizeOrder(),
  ]);
  const cols: string[] = ['id', 'slug', 'name', 'code', 'price', 'mrp', 'category', 'featured', 'sort_order', 'created_at'];
  if (hasPublish) cols.push('published');
  if (hasNewDrop) cols.push('new_drop');
  if (hasRetail) cols.push('retail_visible');

  const products = (await get<ProductRow>(
    'products',
    { ...(hasPublish ? { published: 'eq.true' } : {}), order: 'sort_order.asc' },
    { select: cols.join(',') },
  )) ?? [];
  if (products.length === 0) return [];

  const ids = products.map((p) => p.id);

  // size ordering is migration-gated: exclude the column when absent so an
  // optional display column can never break the whole collection.
  const sizeCols: string[] = ['id', 'product_id', 'color_id', 'size_label', 'stock'];
  if (hasSizeOrder) sizeCols.push('sort_order');

  // The products themselves are the valid result. A failure in the decorative
  // colour/image or size side-data must NEVER remove products that were
  // already fetched successfully — those lists degrade to empty and the cards
  // render with the placeholder instead. Only the product query above throws.
  // Colors and sizes are independent of each other, so fetch them concurrently.
  const [colors, sizes] = await Promise.all([
    get<ProductColorRow>('product_colors', { product_id: `in.(${ids.join(',')})`, order: 'sort_order.asc' }, { select: 'id, product_id, name, hex, images, sort_order' }).catch(() => null as ProductColorRow[] | null),
    get<ProductSizeRow>('product_sizes', { product_id: `in.(${ids.join(',')})` }, { select: sizeCols.join(',') }).catch(() => null as ProductSizeRow[] | null),
  ]);

  return products.map((p) => ({
    ...p,
    colors: (colors?.filter((c) => c.product_id === p.id) ?? []).map((color) => ({ ...color, hex: normalizeHexColor(color.hex), images: cleanImageUrls(color.images) })),
    sizes: sortSizes((sizes?.filter((s) => s.product_id === p.id) ?? []).map((s) => ({
      ...s,
      stock: Number(s.stock ?? 0),
      // Stock is the source of truth: a size is purchasable whenever stock is positive.
      available: Number(s.stock ?? 0) > 0,
    }))),
    // Size charts are only required on the product detail page (loaded fresh by
    // fetchProduct()), never by listing cards — don't ship them to listings.
    size_chart: [],
  }));
}

export async function fetchProduct(slug: string): Promise<CatalogProduct | null> {
  const params: Record<string, string> = { slug: `eq.${slug}`, limit: '1' };
  if (await hasPublishColumns()) params.published = 'eq.true';
  const products = await get<ProductRow>('products', params, { select: '*' });
  const p = products[0];
  if (!p) return null;

  // Colour/image, size and size-chart data are decorative side-data: when a
  // request fails, the page still renders (with the placeholder gallery / no
  // chart) rather than being lost to a secondary query error. Only the product
  // lookup above can fail the page. They are independent, so fetch concurrently.
  const [colors, sizes, chart] = await Promise.all([
    get<ProductColorRow>('product_colors', { product_id: `eq.${p.id}`, order: 'sort_order.asc' }, { select: '*' }).catch(() => null as ProductColorRow[] | null),
    get<ProductSizeRow>('product_sizes', { product_id: `eq.${p.id}` }, { select: '*' }).catch(() => null as ProductSizeRow[] | null),
    get<SizeChartRow>('size_chart_rows', { product_id: `eq.${p.id}`, order: 'sort_order.asc' }, { select: '*' }).catch(() => null as SizeChartRow[] | null),
  ]);

  return {
    ...p,
    colors: (colors ?? []).map((color) => ({ ...color, hex: normalizeHexColor(color.hex), images: cleanImageUrls(color.images) })),
    sizes: sortSizes((sizes ?? []).map((s) => ({
      ...s,
      stock: Number(s.stock ?? 0),
      available: Number(s.stock ?? 0) > 0,
    }))),
    size_chart: (chart ?? []) as SizeChartRow[],
  };
}

export async function fetchHeroSlides(): Promise<HeroSlideRow[]> {
  const rows = await get<HeroSlideRow>('hero_slides', { active: 'eq.true', order: 'sort_order.asc' }, { select: 'id, image_url, sort_order, active, created_at' });
  return rows ?? [];
}

export function formatPrice(n: number): string {
  return `₹\u2009${n.toLocaleString('en-IN')}`;
}

/* ---- Retail / D2C helpers ---- */

/** Retail (D2C) selling price for a product. The `products.price` column is the
 * canonical retail price; `mrp` is the compare-at for strikethrough display. */
export function getRetailPrice(product: ProductRow | CatalogProduct): number {
  return Math.max(0, Number(product.price ?? 0));
}

export function getMrp(product: ProductRow | CatalogProduct): number | null {
  const mrp = Number(product.mrp ?? 0);
  return mrp > 0 ? mrp : null;
}

/** Whether a product is visible on the retail (D2C) channel. Requires the
 * general published flag AND the retail-specific retail_visible gate. */
export function isRetailVisible(product: ProductRow | CatalogProduct): boolean {
  return (product.published !== false) && (product.retail_visible !== false);
}

/** Per-variant D2C stock for a color/size combination. Returns 0 when missing. */

/** The sizes offered for a specific color on a product, derived from the
 * per-color size rows so stock/availability is per variant. Any size the admin
 * configured is returned (no hardcoded size set). */
export function getSizesForColor(product: CatalogProduct, colorId: string): ProductSizeRow[] {
  return sortSizeRows(
    product.sizes.filter((s) => s.color_id === colorId)
  );
}

/** Total available units across every colour/size variant of a product. */
export function getTotalStock(product: CatalogProduct): number {
  return product.sizes.reduce((sum, s) => sum + Math.max(0, Number(s.stock ?? 0)), 0);
}

/** Whether at least one colour/size variant has stock (product is orderable). */
export function isProductInStock(product: CatalogProduct): boolean {
  return getTotalStock(product) > 0;
}

export interface RetailVariant {
  color: ProductColorRow;
  size: ProductSizeRow;
}

export function buildWhatsAppGeneralUrl(message: string): string {
  return `https://wa.me/${getSiteSettings().whatsapp_number}?text=${encodeURIComponent(message)}`;
}

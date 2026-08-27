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
import { getSiteSettings } from '@/lib/settings';

export type { CatalogProduct, HeroSlideRow };

// Legacy constants kept for internal fallbacks only. The single source of
// truth for WhatsApp contact and default MOQ is the admin-controlled
// site_settings row: https://wa.me/... URLs and MOQ gates below read it.
export const WHATSAPP_NUMBER = '919944676178';
export const INSTAGRAM_URL = 'https://instagram.com/dslang.in';
export const EMAIL = 'hello.dslang@gmail.com';

export const DEFAULT_MOQ = 50;
export const WHOLESALE_TIER_100 = 100;
export const WHOLESALE_TIER_DISCOUNT_STEP = 10;

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

let publishColumnsAvailable: boolean | null = null;

/**
 * Whether the products table has the published/new_drop columns yet.
 * Migration-gated: before the site-control migration the storefront reads all
 * products; after it, only published ones are shown.
 */
export async function hasPublishColumns(): Promise<boolean> {
  if (publishColumnsAvailable !== null) return publishColumnsAvailable;
  const { error } = await supabase.from('products').select('published').limit(1);
  publishColumnsAvailable = !error;
  return publishColumnsAvailable;
}

export async function fetchProducts(): Promise<CatalogProduct[]> {
  let query = supabase.from('products').select('*');
  if (await hasPublishColumns()) query = query.eq('published', true);
  const { data: products, error } = await query.order('sort_order', { ascending: true });

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
  let query = supabase.from('products').select('*');
  if (await hasPublishColumns()) query = query.eq('published', true);
  const { data: product, error } = await query.eq('slug', slug).maybeSingle();

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

/**
 * Sizes offered on a product (M/L/XL). Source of truth is the product-level
 * `available_sizes` column added in the wholesale rebuild migration; older
 * rows fall back to the standard M/L/XL set.
 */
export function getAvailableSizes(product: ProductRow | CatalogProduct): string[] {
  const raw = Array.isArray(product.available_sizes) ? product.available_sizes : [];
  const filtered = raw.filter((s): s is (typeof SIZE_LABELS)[number] => ALLOWED_SIZES.has(s));
  return filtered.length > 0 ? filtered : [...SIZE_LABELS];
}

export function formatPrice(n: number): string {
  return `₹\u2009${n.toLocaleString('en-IN')}`;
}

export function formatPerUnit(n: number): string {
  return `₹\u2009${n.toLocaleString('en-IN')}/PC`;
}

export interface ProductSpecs {
  // Raw admin-entered values only. Empty strings mean "not entered" and the
  // storefront hides those rows rather than showing invented defaults.
  fabric: string;
  gsm: number | null;
  wash: string;
  fit: string;
  printType: string;
}

/** Normalized wholesale-facing product specs with NO invented fallbacks. */
export function getProductSpecs(product: ProductRow | CatalogProduct): ProductSpecs {
  return {
    fabric: (product.fabric || '').trim(),
    gsm: Number(product.gsm ?? 0) || null,
    wash: (product.wash ?? '').trim(),
    fit: (product.fit || '').trim(),
    printType: (product.print_type ?? '').trim(),
  };
}

export interface WholesaleSlabs {
  moq: number;
  price50: number;
  price100: number;
}

/** Wholesale slab pricing for a product. Uses the per-product DB values when
 * present; otherwise falls back to the admin-controlled global site defaults.
 * Never derives a price — the "—" states in the UI mean the admin hasn't set a
 * price for this tier yet.
 */
export function getWholesaleSlabs(product: ProductRow | CatalogProduct): WholesaleSlabs {
  const settings = getSiteSettings();
  const moq = Number(product.moq ?? 0) || settings.default_moq;
  const price50 = Number(product.price50 ?? 0) || settings.wholesale_price_50 || 0;
  const price100 = Number(product.price100 ?? 0) || settings.wholesale_price_100 || 0;
  return { moq, price50, price100 };
}

export type WholesaleTier = 'below-moq' | '100' | '50';

export interface WholesaleTierState {
  tier: WholesaleTier;
  unitPrice: number; // per-piece price for the applied tier (price50 used as reference below MOQ)
  total: number;
}

export function getWholesaleTier(totalQty: number, slabs: WholesaleSlabs): WholesaleTierState {
  const minQty = getSiteSettings().min_order_quantity;
  if (totalQty >= WHOLESALE_TIER_100 && slabs.price100 > 0) {
    return { tier: '100', unitPrice: slabs.price100, total: slabs.price100 * totalQty };
  }
  if (totalQty >= minQty && slabs.price50 > 0) {
    return { tier: '50', unitPrice: slabs.price50, total: slabs.price50 * totalQty };
  }
  return { tier: 'below-moq', unitPrice: slabs.price50, total: slabs.price50 * totalQty };
}

/* ---- Fixed color-pack model ---- */

export interface PackConfig {
  packSize: number; // pieces in one pack of a color (6)
  m: number; // M pieces per pack (2)
  l: number; // L pieces per pack (2)
  xl: number; // XL pieces per pack (2)
}

/** The admin-controlled fixed color-pack ratio (source of truth: site_settings). */
export function getPackConfig(): PackConfig {
  const s = getSiteSettings();
  return {
    packSize: Math.max(1, s.pack_size || 6),
    m: Math.max(0, s.pack_m || 0),
    l: Math.max(0, s.pack_l || 0),
    xl: Math.max(0, s.pack_xl || 0),
  };
}

export interface PackQuantities {
  packs: number;
  m: number;
  l: number;
  xl: number;
  qty: number; // packs * packSize
}

/** Derives the fixed size quantities and total pieces from a whole pack count. */
export function packToQuantities(packs: number, cfg: PackConfig = getPackConfig()): PackQuantities {
  const p = Math.max(0, Math.floor(packs));
  return { packs: p, m: p * cfg.m, l: p * cfg.l, xl: p * cfg.xl, qty: p * cfg.packSize };
}

/** A single requested color-pack line of a wholesale order. */
export interface WholesaleSkuLine {
  productId: string;
  name: string;
  code: string;
  color: string;
  colorHex: string;
  image: string;
  slug: string;
  packs: number;
  m: number;
  l: number;
  xl: number;
  qty: number; // packs * packSize
  price50: number;
  price100: number;
}

export interface WholesaleWhatsAppPayload {
  lines: WholesaleSkuLine[];
  businessName?: string;
  phone?: string;
  city?: string;
  note?: string;
  orderRef?: string;
}

export interface WholesaleOrderSummary {
  totalQty: number;
  tiers: { name: string; unitPrice: number }[];
  total: number;
}

/**
 * Builds a wholesale order summary from a set of color-pack lines.
 * The per-piece price for each product depends on that product's own total
 * quantity (100+ PCS = price100 slab, otherwise the 50-PCS slab).
 */
export function summarizeWholesale(lines: WholesaleSkuLine[]): WholesaleOrderSummary {
  let totalQty = 0;
  const tiers: Record<string, number> = {};
  let total = 0;

  const byProduct = new Map<string, { qty: number; price50: number; price100: number }>();
  for (const line of lines) {
    if (line.packs <= 0) continue;
    if (!byProduct.has(line.productId)) byProduct.set(line.productId, { qty: 0, price50: line.price50, price100: line.price100 });
    byProduct.get(line.productId)!.qty += line.qty;
    totalQty += line.qty;
  }

  for (const [productId, group] of byProduct) {
    const unit = group.qty >= WHOLESALE_TIER_100 && group.price100 > 0 ? group.price100 : group.price50;
    if (unit <= 0) continue;
    tiers[String(unit)] = unit;
    for (const line of lines) {
      if (line.productId === productId) total += unit * line.qty;
    }
  }

  return {
    totalQty,
    tiers: Object.keys(tiers)
      .map(Number)
      .sort((a, b) => a - b)
      .map((p) => ({ name: `₹\u2009${p.toLocaleString('en-IN')}/PC`, unitPrice: p })),
    total,
  };
}

const PACK_LABELS = ['M', 'L', 'XL'] as const;

function packForLine(line: WholesaleSkuLine): string {
  const parts = PACK_LABELS.map((label) => {
    const qty = label === 'M' ? line.m : label === 'L' ? line.l : line.xl;
    return `${qty} ${label}`;
  });
  return parts.join(' · ');
}

function formatBreakdown(lines: WholesaleSkuLine[]): string {
  return lines
    .filter((l) => l.packs > 0)
    .map((line) => `  ${line.color}: ${line.packs} pack${line.packs > 1 ? 's' : ''} (${packForLine(line)}) — ${line.qty} PCS`)
    .join('\n');
}

/**
 * Pre-filled WhatsApp message for a wholesale order (product page or cart).
 * Includes the stored order reference when one exists, the per-color pack
 * breakdown, applied tier and total.
 */
export function buildWholesaleWhatsAppUrl(payload: WholesaleWhatsAppPayload): string {
  const summary = summarizeWholesale(payload.lines);
  const settings = getSiteSettings();

  const sellerDetails = [
    payload.businessName ? `Business: ${payload.businessName}` : null,
    payload.phone ? `WhatsApp: ${payload.phone}` : null,
    payload.city ? `City: ${payload.city}` : null,
    payload.note ? `Note: ${payload.note}` : null,
  ].filter(Boolean).join('\n');

  const productBlocks = new Map<string, WholesaleSkuLine[]>();
  for (const line of payload.lines) {
    if (line.packs <= 0) continue;
    const key = line.productId || line.name;
    if (!productBlocks.has(key)) productBlocks.set(key, []);
    productBlocks.get(key)!.push(line);
  }

  const productText = [...productBlocks.entries()]
    .map(([id, block]) => {
      const blockSummary = summarizeWholesale(block);
      const unit = blockSummary.tiers[0]?.unitPrice ?? 0;
      const first = block[0];
      return [
        `Product: ${first.name} (${first.code})`,
        `Breakdown:`,
        formatBreakdown(block),
        `Qty: ${blockSummary.totalQty} PCS`,
        unit > 0 ? `Rate: ₹\u2009${unit.toLocaleString('en-IN')}/PC` : null,
        '',
      ].filter(Boolean).join('\n');
    })
    .join('\n');

  const rep = payload.lines.find((l) => l.packs > 0);
  const orderable = summary.totalQty >= settings.min_order_quantity;
  const message = [
    ...(payload.businessName || payload.phone
      ? [`Hi DSLANG, wholesale order${payload.orderRef ? ` #${payload.orderRef}` : ''} request:`]
      : [`Hi DSLANG, I am interested in a wholesale order${payload.orderRef ? ` (Ref #${payload.orderRef})` : ''}:`]),
    '',
    productText.trim(),
    `Total Quantity: ${summary.totalQty} PCS`,
    orderable
      ? `Wholesale Pricing: ${summary.tiers.map((t) => t.name).join(' / ')}`
      : `Minimum order acceptance from ${settings.min_order_quantity} PCS (MOQ ${settings.default_moq} PCS).`,
    rep && orderable ? `Applicable Wholesale Price: ₹\u2009${(rep.qty >= WHOLESALE_TIER_100 && rep.price100 > 0 ? rep.price100 : rep.price50).toLocaleString('en-IN')}/PC` : null,
    rep && orderable ? `Order Total: ₹\u2009${summary.total.toLocaleString('en-IN')}` : null,
    ...(sellerDetails ? ['', 'My Details:', sellerDetails] : []),
    '',
    payload.orderRef
      ? `Order reference #${payload.orderRef} has been logged with DSLANG.`
      : null,
    'Please confirm availability and order details.',
  ].filter(Boolean).join('\n');

  return `https://wa.me/${settings.whatsapp_number}?text=${encodeURIComponent(message)}`;
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

  return `https://wa.me/${getSiteSettings().whatsapp_number}?text=${encodeURIComponent(message)}`;
}

export function buildWhatsAppGeneralUrl(message: string): string {
  return `https://wa.me/${getSiteSettings().whatsapp_number}?text=${encodeURIComponent(message)}`;
}

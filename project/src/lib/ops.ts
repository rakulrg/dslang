import { supabase } from '@/lib/supabase';
import { describeSupabaseError } from '@/lib/admin';
import { sortSizeLabels } from '@/lib/sizes';
import type {
  AdminActivity,
  AnalyticsResult,
  CustomerOverviewResult,
  DashboardStats,
  ProductSizeOpsRow,
  PurchaseOrder,
  PurchaseOrderItem,
  StockMovement,
  Supplier,
  VariantInventory,
} from '@/lib/types';

/* ----------------------------------------------------------------------------
 * DSLANG Operations client — the admin-only data layer for the Operations &
 * Inventory platform. Every server call below is gated in the database by an
 * in-body admin_users check (or an admin-only RLS policy), so hiding a button
 * in the UI is never the real security boundary.
 * -------------------------------------------------------------------------- */

export interface InventoryQuery {
  search?: string;
  collection?: string;
  productId?: string;
  colorId?: string;
  size?: string;
  stockStatus?: 'low' | 'out' | 'in' | 'all';
  incomingOnly?: boolean;
  sortBy?: 'name' | 'available' | 'on_hand' | 'value' | 'updated_at';
  sortDir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export interface InventoryPage {
  rows: VariantInventory[];
  total: number;
}

/**
 * Server-paginated inventory table query against the `variant_inventory_v` view
 * (real DB data only). Filtering/sorting/pagination all happen in Postgres —
 * the browser never holds the full inventory.
 */
export async function fetchInventory(opts: InventoryQuery = {}): Promise<InventoryPage> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const sortMap: Record<string, string> = {
    name: 'product_name',
    available: 'available',
    on_hand: 'on_hand',
    value: 'value',
    updated_at: 'updated_at',
  };
  const sortCol = sortMap[opts.sortBy ?? 'name'] ?? 'product_name';
  const sortDir = opts.sortDir === 'asc' ? 'asc' : 'desc';

  let q = supabase
    .from('variant_inventory_v')
    .select('*', { count: 'exact' });

  if (opts.search && opts.search.trim()) {
    const term = opts.search.trim();
    q = q.or(`product_name.ilike.%${term}%,product_code.ilike.%${term}%,color_name.ilike.%${term}%`);
  }
  if (opts.collection && opts.collection !== 'all') q = q.eq('category', opts.collection);
  if (opts.productId) q = q.eq('product_id', opts.productId);
  if (opts.colorId) q = q.eq('color_id', opts.colorId);
  if (opts.size) q = q.eq('size_label', opts.size);
  if (opts.stockStatus === 'low') q = q.eq('low_stock', true);
  if (opts.stockStatus === 'out') q = q.eq('out_of_stock', true);
  if (opts.stockStatus === 'in') q = q.gt('available', 0);
  if (opts.incomingOnly) q = q.gt('incoming', 0);

  q = q.order(sortCol, { ascending: sortDir === 'asc', nullsFirst: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw new Error(describeSupabaseError(error, 'Could not load inventory.'));
  return { rows: (data as VariantInventory[]) ?? [], total: count ?? 0 };
}

export interface ProductOpsWorkspace {
  productId: string;
  name: string;
  code: string;
  price: number;
  variants: ProductSizeOpsRow[];
  /** variant_key -> committed units from open orders */
  committedByVariant: Record<string, number>;
  colors: Array<{ id: string; name: string; hex: string }>;
  sizes: string[];
}

/**
 * Loads the full inventory workspace for one product: every colour/size variant
 * with live ops columns plus committed units derived server-side from open
 * orders (consistent with the `variant_inventory_v` view definition).
 */
export async function fetchProductOpsWorkspace(productId: string): Promise<ProductOpsWorkspace> {
  const [{ data: product, error: productError }, { data: variants, error: variantsError }, { data: colors }, view] =
    await Promise.all([
      supabase.from('products').select('id, name, code, price').eq('id', productId).single(),
      supabase.from('product_sizes').select('*').eq('product_id', productId),
      supabase.from('product_colors').select('id, name, hex').eq('product_id', productId).order('sort_order'),
      fetchInventory({ productId, limit: 200, sortBy: 'on_hand', sortDir: 'desc' }),
    ]);

  if (productError) throw new Error(describeSupabaseError(productError, 'Could not load the product.'));
  if (variantsError) throw new Error(describeSupabaseError(variantsError, 'Could not load variants.'));

  const committedByVariant: Record<string, number> = {};
  for (const v of view.rows) committedByVariant[variantMatrixKey(v.color_id, v.size_label)] = Number(v.committed ?? 0);

  const opsVariants = (variants as ProductSizeOpsRow[] | null) ?? [];
  return {
    productId,
    name: String((product as { name?: string } | null)?.name ?? ''),
    code: String((product as { code?: string } | null)?.code ?? ''),
    price: Number((product as { price?: number } | null)?.price ?? 0),
    variants: opsVariants,
    committedByVariant,
    colors: (colors as Array<{ id: string; name: string; hex: string }> | null) ?? [],
    sizes: [...new Set(opsVariants.map((v) => v.size_label))],
  };
}

/** Variant matrix key: `${colorId}|${sizeLabel}`. */
export function variantMatrixKey(colorId: string, sizeLabel: string): string {
  return `${colorId}|${sizeLabel}`;
}

/* ---- Stock adjustments & reorder levels ---- */

export interface AdjustStockInput {
  productId: string;
  colorId: string;
  sizeLabel: string;
  delta: number;
  reason: string;
  note?: string;
}

export async function adjustVariantStock(input: AdjustStockInput): Promise<{ previous: number; new: number; movement_type: string }> {
  const { data, error } = await supabase.rpc('adjust_variant_stock', {
    p_product_id: input.productId,
    p_color_id: input.colorId,
    p_size_label: input.sizeLabel,
    p_delta: input.delta,
    p_reason: input.reason,
    p_note: input.note ?? null,
    p_movement_type: null,
  });
  if (error) throw new Error(describeSupabaseError(error, 'Could not adjust stock.'));
  return data as { previous: number; new: number; movement_type: string };
}

export interface ReorderInput {
  productId: string;
  colorId: string;
  sizeLabel: string;
  reorderPoint: number;
  targetStock: number;
  minStock: number;
}

export async function setVariantReorder(input: ReorderInput): Promise<void> {
  const { error } = await supabase.rpc('set_variant_reorder', {
    p_product_id: input.productId,
    p_color_id: input.colorId,
    p_size_label: input.sizeLabel,
    p_reorder_point: input.reorderPoint,
    p_target_stock: input.targetStock,
    p_min_stock: input.minStock,
  });
  if (error) throw new Error(describeSupabaseError(error, 'Could not set reorder levels.'));
}

export async function bulkSetVariantReorder(items: ReorderInput[]): Promise<number> {
  const payload = items.map((i) => ({
    product_id: i.productId,
    color_id: i.colorId,
    size_label: i.sizeLabel,
    reorder_point: i.reorderPoint,
    target_stock: i.targetStock,
    min_stock: i.minStock,
  }));
  const { data, error } = await supabase.rpc('bulk_set_variant_reorder', { p_items: payload });
  if (error) throw new Error(describeSupabaseError(error, 'Could not set reorder levels.'));
  return Number(data ?? 0);
}

export async function setProductVisibility(productIds: string[], published: boolean): Promise<number> {
  const { data, error } = await supabase.rpc('set_product_visibility', {
    p_ids: productIds,
    p_published: published,
  });
  if (error) throw new Error(describeSupabaseError(error, published ? 'Could not restore the product.' : 'Could not archive the product.'));
  return Number(data ?? 0);
}

/* ---- Purchasing ---- */

export interface PurchasingCatalogOption {
  product_id: string;
  color_id: string;
  size_label: string;
  name: string;
  code: string;
  color: string;
  price: number;
  available: number;
  incoming: number;
}

export async function fetchPurchasingCatalog(): Promise<PurchasingCatalogOption[]> {
  const rows = await fetchInventory({ limit: 500, sortBy: 'name', sortDir: 'asc' });
  return rows.rows.map((v) => ({
    product_id: v.product_id,
    color_id: v.color_id,
    size_label: v.size_label,
    name: v.product_name,
    code: v.product_code,
    color: v.color_name,
    price: v.value && v.available ? Math.round(v.value / v.available) : 0,
    available: Number(v.available ?? 0),
    incoming: Number(v.incoming ?? 0),
  }));
}

export interface CreatePoInput {
  supplierId: string | null;
  items: Array<{ productId: string; colorId: string; sizeLabel: string; quantity: number; unitCost: number }>;
  expectedDate?: string | null;
  destination?: string;
  paymentTerms?: string;
  notes?: string;
  status?: 'DRAFT' | 'ORDERED';
}

export async function createPurchaseOrder(input: CreatePoInput): Promise<{ po_id: string; po_number: string; status: string }> {
  const payload = input.items.map((i) => ({
    product_id: i.productId,
    color_id: i.colorId,
    size_label: i.sizeLabel,
    quantity: i.quantity,
    unit_cost: i.unitCost,
  }));
  const { data, error } = await supabase.rpc('create_purchase_order', {
    p_supplier_id: input.supplierId,
    p_items: payload,
    p_expected_date: input.expectedDate ?? null,
    p_destination: input.destination ?? null,
    p_payment_terms: input.paymentTerms ?? null,
    p_notes: input.notes ?? null,
    p_status: input.status ?? 'DRAFT',
  });
  if (error) throw new Error(describeSupabaseError(error, 'Could not create the purchase order.'));
  return data as { po_id: string; po_number: string; status: string };
}

export async function updatePurchaseOrderStatus(poId: string, status: 'DRAFT' | 'ORDERED' | 'CANCELLED'): Promise<{ status: string; released_incoming: boolean }> {
  const { data, error } = await supabase.rpc('update_purchase_order_status', { p_po_id: poId, p_status: status });
  if (error) throw new Error(describeSupabaseError(error, 'Could not update the purchase order.'));
  return data as { status: string; released_incoming: boolean };
}

export interface ReceivingLine {
  itemId: string;
  received: number;
  rejected: number;
  reason?: string;
}

export async function receivePurchaseOrder(poId: string, lines: ReceivingLine[]): Promise<{ status: string; received: number; rejected: number }> {
  const payload = lines.map((l) => ({ item_id: l.itemId, received: l.received, rejected: l.rejected, reason: l.reason ?? null }));
  const { data, error } = await supabase.rpc('receive_purchase_order', { p_po_id: poId, p_lines: payload });
  if (error) throw new Error(describeSupabaseError(error, 'Could not receive the purchase order.'));
  return data as { status: string; received: number; rejected: number };
}

export async function fetchPurchaseOrders(limit = 100): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, suppliers(name)')
    .order('created_date', { ascending: false })
    .limit(limit);
  if (error) throw new Error(describeSupabaseError(error, 'Could not load purchase orders.'));
  return (data ?? []).map((row) => {
    const { suppliers, ...rest } = row as Record<string, unknown> & { suppliers?: { name?: string } | null };
    return { ...(rest as unknown as PurchaseOrder), supplier_name: suppliers?.name ?? null };
  });
}

export async function fetchPurchaseOrder(poId: string): Promise<{ po: PurchaseOrder; items: PurchaseOrderItem[] } | null> {
  const { data: po, error } = await supabase
    .from('purchase_orders')
    .select('*, suppliers(name)')
    .eq('id', poId)
    .single();
  if (error) throw new Error(describeSupabaseError(error, 'Could not load the purchase order.'));
  const { data: items, error: itemsError } = await supabase
    .from('purchase_order_items')
    .select('*, products(name), product_colors(name)')
    .eq('po_id', poId);
  if (itemsError) throw new Error(describeSupabaseError(itemsError, 'Could not load purchase order lines.'));

  const { suppliers, ...rest } = po as Record<string, unknown> & { suppliers?: { name?: string } | null };
  return {
    po: { ...(rest as unknown as PurchaseOrder), supplier_name: suppliers?.name ?? null },
    items: (items ?? []).map((row) => {
      const { products, product_colors, ...it } = row as Record<string, unknown> & { products?: { name?: string }; product_colors?: { name?: string } };
      return {
        ...(it as unknown as PurchaseOrderItem),
        product_name: products?.name,
        color_name: product_colors?.name,
      };
    }),
  };
}

/* ---- Suppliers ---- */

export async function fetchSuppliers(): Promise<Supplier[]> {
  const { data, error } = await supabase.from('suppliers').select('*').order('name');
  if (error) throw new Error(describeSupabaseError(error, 'Could not load suppliers.'));
  return (data as Supplier[]) ?? [];
}

export interface SupplierInput {
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  paymentTerms?: string;
  leadTimeDays?: number;
  notes?: string;
  active?: boolean;
}

export async function upsertSupplier(id: string | null, input: SupplierInput): Promise<Supplier> {
  const payload: Record<string, unknown> = {
    name: input.name.trim(),
    contact_person: input.contactPerson?.trim() || null,
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    address: input.address?.trim() || null,
    payment_terms: input.paymentTerms?.trim() || null,
    lead_time_days: input.leadTimeDays ?? null,
    notes: input.notes?.trim() || null,
    active: input.active ?? true,
  };
  if (id) {
    const { data, error } = await supabase.from('suppliers').update(payload).eq('id', id).select().single();
    if (error) throw new Error(describeSupabaseError(error, 'Could not update the supplier.'));
    return data as Supplier;
  }
  const { data, error } = await supabase.from('suppliers').insert(payload).select().single();
  if (error) throw new Error(describeSupabaseError(error, 'Could not create the supplier.'));
  return data as Supplier;
}

export async function deleteSupplier(id: string): Promise<void> {
  const { error } = await supabase.from('suppliers').delete().eq('id', id);
  if (error) throw new Error(describeSupabaseError(error, 'Could not delete the supplier.'));
}

/* ---- Stock movements ---- */

export interface MovementQuery {
  productId?: string;
  colorId?: string;
  size?: string;
  type?: string;
  offset?: number;
  limit?: number;
}

export async function fetchStockMovements(opts: MovementQuery = {}): Promise<{ rows: StockMovement[]; total: number }> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 100)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  let q = supabase.from('stock_movements').select('*', { count: 'exact' });
  if (opts.productId) q = q.eq('product_id', opts.productId);
  if (opts.colorId) q = q.eq('color_id', opts.colorId);
  if (opts.size) q = q.eq('size_label', opts.size);
  if (opts.type && opts.type !== 'ALL') q = q.eq('movement_type', opts.type);
  q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  const { data, error, count } = await q;
  if (error) throw new Error(describeSupabaseError(error, 'Could not load stock movements.'));

  const rows = (data as StockMovement[]) ?? [];
  const ids = [...new Set(rows.map((r) => r.product_id))];
  let names: Record<string, { name: string; color: string }> = {};
  if (ids.length > 0) {
    const [{ data: products }, { data: colors }] = await Promise.all([
      supabase.from('products').select('id, name').in('id', ids),
      supabase.from('product_colors').select('id, name').in('id', [...new Set(rows.map((r) => r.color_id))]),
    ]);
    names = {};
    for (const p of (products ?? []) as Array<{ id: string; name: string }>) names[p.id] = { name: p.name, color: '' };
    for (const c of (colors ?? []) as Array<{ id: string; name: string }>) {
      if (names[c.id]) names[c.id].color = c.name;
    }
  }
  return {
    rows: rows.map((r) => ({
      ...r,
      product_name: names[r.product_id]?.name ?? r.product_id.slice(0, 8),
      color_name: names[r.product_id]?.color ?? '',
    })),
    total: count ?? 0,
  };
}

/* ---- Activity ---- */

export interface ActivityQuery {
  entity?: string;
  limit?: number;
  offset?: number;
}

export async function fetchAdminActivity(opts: ActivityQuery = {}): Promise<{ rows: AdminActivity[]; total: number }> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 100)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  let q = supabase.from('admin_activity').select('*', { count: 'exact' });
  if (opts.entity) q = q.eq('entity', opts.entity);
  q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  const { data, error, count } = await q;
  if (error) throw new Error(describeSupabaseError(error, 'Could not load the activity log.'));
  return { rows: (data as AdminActivity[]) ?? [], total: count ?? 0 };
}

/* ---- Dashboard & customers ---- */

export async function fetchDashboardStats(range: '1D' | '7D' | '30D' | '3M' | '1Y' = '7D'): Promise<DashboardStats> {
  const { data, error } = await supabase.rpc('dashboard_overview_stats', { p_range: range });
  if (error) throw new Error(describeSupabaseError(error, 'Could not load dashboard statistics.'));
  return data as DashboardStats;
}

export async function fetchCustomers(offset = 0, limit = 100): Promise<CustomerOverviewResult> {
  const { data, error } = await supabase.rpc('customer_overview', { p_limit: limit, p_offset: offset });
  if (error) throw new Error(describeSupabaseError(error, 'Could not load customers.'));
  return data as CustomerOverviewResult;
}

export async function fetchAnalytics(): Promise<AnalyticsResult> {
  const { data, error } = await supabase.rpc('admin_analytics');
  if (error) throw new Error(describeSupabaseError(error, 'Could not load analytics.'));
  return data as AnalyticsResult;
}

/* ---- Shared formatting helpers ---- */

export function inr(n: number): string {
  return `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
}

export function formatOpsDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(iso);
  }
}

export function formatOpsDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return String(iso);
  }
}

export const MOVEMENT_TYPE_CLS: Record<string, string> = {
  SALE: 'bg-bone text-white',
  RESERVATION: 'bg-sky-100 text-sky-700',
  RELEASE: 'bg-amber-100 text-amber-700',
  RECEIPT: 'bg-green-600/10 text-green-700',
  ADJUSTMENT: 'bg-indigo-100 text-indigo-700',
  DAMAGE: 'bg-crimson/10 text-crimson',
  RETURN: 'bg-teal-100 text-teal-700',
  CANCELLATION: 'bg-grey/15 text-grey',
  PRODUCTION: 'bg-purple-100 text-purple-700',
  TRANSFER: 'bg-blue-100 text-blue-700',
  CORRECTION: 'bg-amber-100 text-amber-800',
  REJECTED: 'bg-rose-100 text-rose-700',
};

export const ADJUSTMENT_REASONS = [
  'Damaged',
  'Lost',
  'Found',
  'Quality control',
  'Manual correction',
  'Production',
  'Other',
];

export const PO_STATUS_CLS: Record<string, string> = {
  DRAFT: 'bg-grey/15 text-grey',
  ORDERED: 'bg-sky-100 text-sky-700',
  PARTIALLY_RECEIVED: 'bg-amber-100 text-amber-700',
  RECEIVED: 'bg-green-600/10 text-green-700',
  CANCELLED: 'bg-crimson/10 text-crimson',
};

/* ----------------------------------------------------------------------------
 * Inventory page metadata (all read-only, computed against the real schema).
 * -------------------------------------------------------------------------- */

export interface InventoryFilters {
  /** distinct product categories that actually have variants */
  categories: string[];
  colors: Array<{ id: string; name: string; hex: string }>;
  /** distinct size labels present in the catalog, size-sorted */
  sizes: string[];
}

export async function fetchInventoryFilters(): Promise<InventoryFilters> {
  const [{ data: cats }, { data: colors }, { data: sizeRows }] = await Promise.all([
    supabase.from('products').select('category').not('category', 'is', null),
    supabase.from('product_colors').select('id, name, hex').order('name'),
    supabase.from('product_sizes').select('size_label'),
  ]);
  const categories = [
    ...new Set(
      (cats ?? [])
        .map((r) => String((r as { category?: string }).category ?? '').trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const sizes = sortSizeLabels([...new Set((sizeRows ?? []).map((r) => String((r as { size_label: string }).size_label)))]);
  return {
    categories,
    colors: (colors ?? []) as Array<{ id: string; name: string; hex: string }>,
    sizes,
  };
}

export interface InventoryKpis {
  total: number;
  availableUnits: number | null;
  incomingUnits: number | null;
  lowStock: number;
  outOfStock: number;
  incomingVariants: number;
  healthy: number;
}

/**
 * Compact KPI set for the inventory header. Variant counts and unit sums all
 * come from the `variant_inventory_v` view (the existing inventory source of
 * truth) via exact-count head queries and column sums — no rows are shipped
 * and no analytics RPC is involved. `healthy` = variants that are neither low
 * nor out of stock.
 */
export async function fetchInventoryKpis(): Promise<InventoryKpis> {
  const [totalRes, lowRes, outRes, incomingRes, availRes, incomingSumRes] = await Promise.all([
    supabase.from('variant_inventory_v').select('variant_id', { count: 'exact', head: true }),
    supabase.from('variant_inventory_v').select('variant_id', { count: 'exact', head: true }).eq('low_stock', true),
    supabase.from('variant_inventory_v').select('variant_id', { count: 'exact', head: true }).eq('out_of_stock', true),
    supabase.from('variant_inventory_v').select('variant_id', { count: 'exact', head: true }).gt('incoming', 0),
    supabase.from('variant_inventory_v').select('available'),
    supabase.from('variant_inventory_v').select('incoming'),
  ]);

  const err = totalRes.error ?? lowRes.error ?? outRes.error ?? incomingRes.error ?? availRes.error ?? incomingSumRes.error;
  if (err) throw new Error(describeSupabaseError(err, 'Could not load inventory KPIs.'));

  const total = totalRes.count ?? 0;
  const lowStock = lowRes.count ?? 0;
  const outOfStock = outRes.count ?? 0;
  return {
    total,
    availableUnits: (availRes.data ?? []).reduce((s, r) => s + (Number((r as { available?: number }).available) || 0), 0),
    incomingUnits: (incomingSumRes.data ?? []).reduce((s, r) => s + (Number((r as { incoming?: number }).incoming) || 0), 0),
    lowStock,
    outOfStock,
    incomingVariants: incomingRes.count ?? 0,
    healthy: Math.max(0, total - lowStock - outOfStock),
  };
}

/** First catalog image per colour, used for the small table thumbnails. */
export async function fetchVariantThumbs(colorIds: string[]): Promise<Record<string, string | null>> {
  if (colorIds.length === 0) return {};
  const { data, error } = await supabase.from('product_colors').select('id, images').in('id', colorIds);
  const map: Record<string, string | null> = {};
  if (!error) {
    for (const c of (data ?? []) as Array<{ id: string; images: string[] | null }>) {
      const arr = c.images ?? [];
      map[c.id] = typeof arr[0] === 'string' && arr[0].trim() ? arr[0] : null;
    }
  }
  for (const id of colorIds) if (!(id in map)) map[id] = null;
  return map;
}
import { supabase } from '@/lib/supabase';
import { describeSupabaseError } from '@/lib/admin';
import { fetchVariantThumbs } from '@/lib/ops';
import type { RetailOrder, RetailOrderItem } from '@/lib/types';

export type DashRange = '7D' | '30D' | '90D';

export const DASH_RANGES: Array<{ key: DashRange; label: string }> = [
  { key: '7D', label: 'Last 7 days' },
  { key: '30D', label: 'Last 30 days' },
  { key: '90D', label: 'Last 90 days' },
];

export const RANGE_DAYS: Record<DashRange, number> = { '7D': 7, '30D': 30, '90D': 90 };

export function rangeLabel(range: DashRange): string {
  return DASH_RANGES.find((r) => r.key === range)?.label ?? 'Last 30 days';
}

export function rangeCaption(range: DashRange): string {
  return `previous ${RANGE_DAYS[range]} days`;
}

export interface PeriodMetric {
  value: number;
  prev: number | null;
  pct: number | null;
}

export interface DailySeries {
  label: string;
  current: number;
  prior: number;
}

export interface DashTopProduct {
  product_id: string;
  name: string;
  code: string;
  color_id: string;
  color: string;
  size_label: string;
  units: number;
  revenue: number;
  orders: number;
}

export interface DashRecentOrder {
  id: string;
  ref: string;
  customerName: string;
  created_at: string;
  payment_status: string;
  order_status: string;
  is_cod: boolean;
  total_amount: number;
  color_id: string | null;
  itemLabel: string;
}

export interface DashSnapshot {
  range: DashRange;
  from: string;
  to: string;
  prevFrom: string;
  totalOrders: PeriodMetric;
  revenue: PeriodMetric;
  /** Money actually collected. For a new COD order this contributes 0. */
  cashCollected: PeriodMetric;
  /** Still to be collected at the door on live COD orders. */
  codDue: PeriodMetric;
  /** How many live COD orders that amount is spread across. */
  codDueOrders: number;
  aov: PeriodMetric;
  units: PeriodMetric;
  ordersSeries: DailySeries[];
  revenueSeries: DailySeries[];
  cashSeries: DailySeries[];
  unitsSeries: DailySeries[];
  topProducts: DashTopProduct[];
  recentOrders: DashRecentOrder[];
  statusCounts: Array<{ status: string; count: number }>;
  inventory: { total: number; out: number; low: number; in: number; incomingUnits: number };
  thumbs: Record<string, string | null>;
  ts: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Money that has actually arrived via the gateway.
 *
 * Deliberately EXCLUDES 'cod_pending': a new COD order is confirmed but has
 * paid nothing online, so counting it here would report money that does not
 * exist. Legacy COD orders that genuinely paid an advance carry
 * payment_status = 'success' and are included for the real advance they paid.
 */
function isPaid(o: { payment_status: string }): boolean {
  return o.payment_status === 'success' || o.payment_status === 'paid';
}

/** An order that is still live — not failed, cancelled or refunded. */
function isLive(o: { payment_status: string; order_status: string }): boolean {
  return (
    o.payment_status !== 'failed' &&
    o.payment_status !== 'cancelled' &&
    o.payment_status !== 'refunded' &&
    o.order_status !== 'cancelled' &&
    o.order_status !== 'refunded'
  );
}

function pctChange(cur: number, prev: number): number | null {
  const c = Number.isFinite(cur) ? cur : 0;
  const p = Number.isFinite(prev) ? prev : 0;
  if (p > 0) return ((c - p) / p) * 100;
  return null;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function shortLabel(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

interface OrderRow extends RetailOrder {}

export async function fetchDashSnapshot(range: DashRange): Promise<DashSnapshot> {
  const days = RANGE_DAYS[range] ?? 30;
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY_MS);
  const priorFrom = new Date(from.getTime() - days * DAY_MS);

  const [ordersRes, vTotal, vLow, vOut, vIncoming] = await Promise.all([
    supabase
      .from('retail_orders')
        .select('id, ref, customer, items, total_qty, total_amount, amount_paid_upfront, amount_due_on_delivery, payment_status, order_status, is_cod, created_at')
      .gte('created_at', priorFrom.toISOString())
      .lt('created_at', now.toISOString())
      .order('created_at', { ascending: true }),
    supabase.from('variant_inventory_v').select('variant_id', { count: 'exact', head: true }),
    supabase.from('variant_inventory_v').select('variant_id', { count: 'exact', head: true }).eq('low_stock', true),
    supabase.from('variant_inventory_v').select('variant_id', { count: 'exact', head: true }).eq('out_of_stock', true),
    supabase.from('variant_inventory_v').select('incoming'),
  ]);
  const err = ordersRes.error ?? vTotal.error ?? vLow.error ?? vOut.error ?? vIncoming.error;
  if (err) throw new Error(describeSupabaseError(err, 'Could not load dashboard statistics.'));

  const rows = (ordersRes.data as OrderRow[] | null) ?? [];

  const curStart = startOfDay(from).getTime();
  const priStart = startOfDay(priorFrom).getTime();

  const ordersSeries: DailySeries[] = [];
  const revenueSeries: DailySeries[] = [];
  const cashSeries: DailySeries[] = [];
  const unitsSeries: DailySeries[] = [];
  const labels: string[] = [];
  for (let i = 0; i < days; i++) {
    labels.push(shortLabel(new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)));
    ordersSeries.push({ label: labels[labels.length - 1], current: 0, prior: 0 });
    revenueSeries.push({ label: labels[labels.length - 1], current: 0, prior: 0 });
    cashSeries.push({ label: labels[labels.length - 1], current: 0, prior: 0 });
    unitsSeries.push({ label: labels[labels.length - 1], current: 0, prior: 0 });
  }

  let curTotal = 0;
  let curPaid = 0;
  let curRevenue = 0;
  let curCash = 0;
  let curCodDue = 0;
  let curCodDueOrders = 0;
  let curUnits = 0;
  let priTotal = 0;
  let priPaid = 0;
  let priRevenue = 0;
  let priCash = 0;
  let priUnits = 0;

  const paidOnly = rows.filter(isPaid);
  const topMap = new Map<string, DashTopProduct>();
  const topOrderIds = new Map<string, Set<string>>();

  for (const o of rows) {
    const day = startOfDay(new Date(o.created_at)).getTime();
    const idx = Math.round((day - curStart) / DAY_MS);
    const inCurrent = idx >= 0 && idx < days;
    const inPrior = !inCurrent && Math.round((day - priStart) / DAY_MS) >= 0 && Math.round((day - priStart) / DAY_MS) < days;
    if (!inCurrent && !inPrior) continue;

    if (inCurrent) {
      curTotal += 1;
      ordersSeries[idx].current += 1;
      // Cash actually collected, tracked for EVERY live order regardless of
      // payment state. For a new COD order amount_paid_upfront is 0, so it
      // contributes nothing here and never inflates collected revenue, while
      // its full value still shows in total_amount and in the order count.
      curCash += Number(o.amount_paid_upfront) || 0;
      cashSeries[idx].current += Number(o.amount_paid_upfront) || 0;
      if (o.is_cod && isLive(o)) {
        curCodDue += Number(o.amount_due_on_delivery) || 0;
        curCodDueOrders += 1;
      }
      if (isPaid(o)) {
        curPaid += 1;
        // ORDER VALUE of confirmed orders, not cash: for an online order this
        // is the pre-discount sale value, and a COD order only reaches here
        // once it is settled. Kept as the pipeline/AOV number.
        const amt = Number(o.total_amount) || 0;
        const qty = Number(o.total_qty) || 0;
        curRevenue += amt;
        curUnits += qty;
        revenueSeries[idx].current += amt;
        unitsSeries[idx].current += qty;
      }
    } else {
      const pi = Math.round((day - priStart) / DAY_MS);
      priTotal += 1;
      ordersSeries[pi].prior += 1;
      priCash += Number(o.amount_paid_upfront) || 0;
      cashSeries[pi].prior += Number(o.amount_paid_upfront) || 0;
      if (isPaid(o)) {
        priPaid += 1;
        const amt = Number(o.total_amount) || 0;
        const qty = Number(o.total_qty) || 0;
        priRevenue += amt;
        priUnits += qty;
        revenueSeries[pi].prior += amt;
        unitsSeries[pi].prior += qty;
      }
    }
  }

  if (paidOnly.length > 0) {
    const monthFilter = new Set(paidOnly.filter((o) => {
      const day = startOfDay(new Date(o.created_at)).getTime();
      return day >= curStart && Math.round((day - curStart) / DAY_MS) < days;
    }).map((o) => o.id));
    for (const o of paidOnly) {
      if (!monthFilter.has(o.id)) continue;
      for (const it of (o.items ?? []) as RetailOrderItem[]) {
        const pid = it.product_id;
        const existing = topMap.get(pid);
        if (existing) {
          existing.units += Number(it.quantity) || 0;
          existing.revenue += Number(it.line_total) || 0;
        } else {
          const ids = topOrderIds.get(pid) ?? new Set<string>();
          topOrderIds.set(pid, ids);
          ids.add(o.id);
          topMap.set(pid, {
            product_id: pid,
            name: it.name,
            code: it.code,
            color_id: it.color_id,
            color: it.color,
            size_label: it.size_label,
            units: Number(it.quantity) || 0,
            revenue: Number(it.line_total) || 0,
            orders: 1,
          });
        }
        topOrderIds.get(pid)?.add(o.id);
      }
    }
  }

  for (const p of topMap.values()) {
    p.orders = topOrderIds.get(p.product_id)?.size ?? 1;
  }
  const topProducts = Array.from(topMap.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

  const recentOrders: DashRecentOrder[] = rows
    .filter((o) => Math.round((startOfDay(new Date(o.created_at)).getTime() - curStart) / DAY_MS) >= 0 && Math.round((startOfDay(new Date(o.created_at)).getTime() - curStart) / DAY_MS) < days)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 5)
    .map((o) => {
      const first = (o.items ?? [])[0] as RetailOrderItem | undefined;
      return {
        id: o.id,
        ref: o.ref,
        customerName: (o.customer as { name?: string } | null)?.name ?? 'Unknown customer',
        created_at: o.created_at,
        payment_status: o.payment_status,
        order_status: o.order_status,
        is_cod: Boolean(o.is_cod),
        total_amount: Number(o.total_amount) || 0,
        color_id: first?.color_id ?? null,
        itemLabel: first?.name ?? 'Order',
      };
    });

  const statusCounts: Array<{ status: string; count: number }> = [];
  const statusMap = new Map<string, number>();
  for (const o of rows) {
    const day = startOfDay(new Date(o.created_at)).getTime();
    const idx = Math.round((day - curStart) / DAY_MS);
    if (idx >= 0 && idx < days) {
      statusMap.set(o.order_status, (statusMap.get(o.order_status) ?? 0) + 1);
    }
  }
  for (const [status, count] of statusMap.entries()) statusCounts.push({ status, count });
  statusCounts.sort((a, b) => b.count - a.count);

  const colorIds = [
    ...recentOrders.map((o) => o.color_id),
    ...topProducts.map((p) => p.color_id),
  ].filter((id): id is string => Boolean(id));
  const thumbs = (await fetchVariantThumbs([...new Set(colorIds)]));

  const incomingUnits = (vIncoming.data ?? []).reduce((s, r) => s + (Number((r as { incoming?: number }).incoming) || 0), 0);
  const totalVariants = vTotal.count ?? 0;
  const outCount = vOut.count ?? 0;
  const lowCount = vLow.count ?? 0;

  const aovCur = curPaid > 0 ? curRevenue / curPaid : 0;
  const aovPri = priPaid > 0 ? priRevenue / priPaid : 0;

  return {
    range,
    from: from.toISOString(),
    to: now.toISOString(),
    prevFrom: priorFrom.toISOString(),
    totalOrders: { value: curTotal, prev: priTotal, pct: pctChange(curTotal, priTotal) },
    revenue: { value: curRevenue, prev: priRevenue, pct: pctChange(curRevenue, priRevenue) },
    cashCollected: { value: curCash, prev: priCash, pct: pctChange(curCash, priCash) },
    codDue: { value: curCodDue, prev: 0, pct: null },
    codDueOrders: curCodDueOrders,
    aov: { value: aovCur, prev: aovPri, pct: pctChange(aovCur, aovPri) },
    units: { value: curUnits, prev: priUnits, pct: pctChange(curUnits, priUnits) },
    ordersSeries,
    revenueSeries,
    cashSeries,
    unitsSeries,
    topProducts,
    recentOrders,
    statusCounts,
    inventory: {
      total: totalVariants,
      out: outCount,
      low: lowCount,
      in: Math.max(0, totalVariants - lowCount - outCount),
      incomingUnits,
    },
    thumbs,
    ts: now.toISOString(),
  };
}
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  RefreshCw,
  ShoppingCart,
  IndianRupee,
  BarChart3,
  Banknote,
  Boxes,
  ArrowUpRight,
  ArrowDownRight,
  Calendar,
  ChevronDown,
  CheckCircle2,
  TriangleAlert,
  ArrowDownToLine,
} from 'lucide-react';
import { inr, formatOpsDate, formatOpsDateOnly } from '@/lib/ops';
import {
  fetchDashSnapshot,
  DASH_RANGES,
  RANGE_DAYS,
  rangeLabel,
  rangeCaption,
  type DashRange,
  type DashSnapshot,
  type DailySeries,
  type PeriodMetric,
  type DashRecentOrder,
} from '@/pages/admin/dashboardData';
import { LoadingDots } from '@/components/LoadingDots';
import { ErrorBox, Btn } from '@/pages/admin/OpsUi';
import { ORDER_STATUS_LABEL } from '@/pages/admin/orderLabels';

function fmtNum(n: number): string {
  return new Intl.NumberFormat('en-IN').format(Math.round(Number(n) || 0));
}

function compactNum(n: number): string {
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
}

/* ------------------------------------------------------------------ */
/* Atoms                                                               */
/* ------------------------------------------------------------------ */

function Card({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-white border border-line rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.03)] overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h3 className="text-[11px] font-bold uppercase tracking-wide-2 text-bone-dim">{title}</h3>
        {action}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

function ViewAll({ onClick }: { onClick?: () => void }) {
  if (!onClick) return null;
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide-2 text-bone-dim hover:text-bone">
      View all <ArrowUpRight size={12} />
    </button>
  );
}

function RangeButton({ range, onChange }: { range: DashRange; onChange: (r: DashRange) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line bg-white text-[11px] font-medium text-bone-dim hover:text-bone hover:border-line-2 transition-colors"
      >
        <Calendar size={13} strokeWidth={1.8} />
        <span className="hidden sm:inline">{rangeLabel(range)}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-line rounded-xl shadow-xl overflow-hidden w-44 animate-slide-down" onClick={() => setOpen(false)}>
          {DASH_RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => onChange(r.key)}
              className={`block w-full text-left px-3 py-2 text-[12px] ${range === r.key ? 'bg-paper-2 font-semibold text-bone' : 'text-bone-dim hover:bg-paper-2'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Spark({ values, color = 'var(--color-bone)', className = 'h-8 w-full' }: { values: number[]; color?: string; className?: string }) {
  const W = 120;
  const H = 30;
  const nums = values.map((v) => Number(v) || 0);
  const max = Math.max(1, ...nums);
  const pts = nums.map((v, i) => {
    const x = nums.length <= 1 ? W / 2 : (i / (nums.length - 1)) * (W - 4) + 2;
    const y = H - 4 - (v / max) * (H - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Trend({ metric, caption }: { metric: PeriodMetric; caption: string }) {
  if (metric.pct === null || metric.prev === null) {
    return (
      <p className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-grey">
        <span className="tabular-nums">—</span>
        <span>no prior period</span>
        <span className="text-grey/60">vs {caption}</span>
      </p>
    );
  }
  const up = metric.pct >= 0;
  return (
    <p className={`mt-2 inline-flex items-center gap-1 text-[10px] font-semibold tabular-nums ${up ? 'text-green-600' : 'text-crimson'}`}>
      {up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
      {Math.abs(metric.pct).toFixed(1)}%
      <span className="font-normal text-grey">vs {caption}</span>
    </p>
  );
}

function KpiCard({
  icon: Icon,
  iconCls,
  label,
  value,
  spark,
  sparkColor,
  metric,
  caption,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  iconCls: string;
  label: string;
  value: string;
  spark: number[];
  sparkColor: string;
  metric: PeriodMetric;
  caption: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.03)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className={`grid place-items-center w-9 h-9 rounded-lg ${iconCls}`}>
          <Icon size={16} strokeWidth={2} />
        </div>
        <Spark values={spark} color={sparkColor} className="h-8 w-20" />
      </div>
      <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide-2 text-grey">{label}</p>
      <p className="mt-1.5 font-price text-[24px] leading-none text-bone tabular-nums">{value}</p>
      <Trend metric={metric} caption={caption} />
    </div>
  );
}

function PayPill({ o }: { o: DashRecentOrder }) {
  const p = o.payment_status;
  if (p === 'success' || p === 'paid') {
    return <span className="inline-flex rounded bg-green-600/10 text-green-700 text-[9px] uppercase tracking-wide-2 font-semibold px-1.5 py-0.5">Paid</span>;
  }
  if (p === 'failed') {
    return <span className="inline-flex rounded bg-crimson/10 text-crimson text-[9px] uppercase tracking-wide-2 font-semibold px-1.5 py-0.5">Failed</span>;
  }
  if (o.is_cod) {
    return <span className="inline-flex rounded bg-paper-3 text-bone-dim text-[9px] uppercase tracking-wide-2 font-semibold px-1.5 py-0.5">COD</span>;
  }
  return <span className="inline-flex rounded bg-amber-100 text-amber-700 text-[9px] uppercase tracking-wide-2 font-semibold px-1.5 py-0.5">Pending</span>;
}

/* ------------------------------------------------------------------ */
/* Charts (hand-rolled SVG — no chart dependency)                     */
/* ------------------------------------------------------------------ */

function LineChart({ labels, current, prior, format }: { labels: string[]; current: number[]; prior: number[]; format: (n: number) => string }) {
  const W = 760;
  const H = 220;
  const padL = 6;
  const padR = 6;
  const padT = 14;
  const padB = 20;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = labels.length;
  const yMax = Math.max(1, ...current, ...prior);
  const xFor = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yFor = (v: number) => H - padB - (v / yMax) * innerH;
  const curPts = current.map((v, i) => `${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`);
  const priPts = prior.map((v, i) => `${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`);
  const curPath = curPts.map((p, i) => `${i ? 'L' : 'M'} ${p}`).join(' ');
  const priPath = priPts.map((p, i) => `${i ? 'L' : 'M'} ${p}`).join(' ');
  const area = `${curPath} L ${xFor(n - 1).toFixed(1)} ${H - padB} L ${xFor(0).toFixed(1)} ${H - padB} Z`;
  const last = n - 1;
  const mid = Math.floor(n / 2);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Sales overview chart">
        <defs>
          <linearGradient id="dash-line-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--color-crimson)" stopOpacity="0.14" />
            <stop offset="1" stopColor="var(--color-crimson)" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={padL} y1={padT + innerH * f} x2={W - padR} y2={padT + innerH * f} stroke="var(--color-line)" strokeWidth="1" strokeDasharray="3 4" />
        ))}
        <text x={W - padR} y={padT - 4} textAnchor="end" fontSize="9" fill="var(--color-grey)">
          {format(yMax)}
        </text>
        <path d={area} fill="url(#dash-line-area)" />
        <path d={priPath} fill="none" stroke="#b7b7b7" strokeWidth="1.5" strokeDasharray="4 3" strokeLinecap="round" strokeLinejoin="round" />
        <path d={curPath} fill="none" stroke="var(--color-crimson)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {n > 0 && <circle cx={xFor(last)} cy={yFor(current[last] || 0)} r="3.5" fill="var(--color-crimson)" />}
        {[0, mid, last].filter((i, idx, arr) => idx === arr.indexOf(i)).map((i) => (
          <text key={i} x={xFor(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} fontSize="9" fill="var(--color-grey)">
            {labels[i] ?? ''}
          </text>
        ))}
      </svg>
    </div>
  );
}

function BarsChart({ series }: { series: DailySeries[] }) {
  const W = 760;
  const H = 200;
  const padL = 6;
  const padR = 6;
  const padT = 12;
  const padB = 18;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = series.length;
  const yMax = Math.max(1, ...series.map((d) => d.current));
  const slot = n > 0 ? innerW / n : innerW;
  const barW = Math.max(2, slot * 0.62);
  const mid = Math.floor(n / 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Daily revenue chart">
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="var(--color-line)" strokeWidth="1" />
      {series.map((d, i) => {
        const h = Math.max(0, (d.current / yMax) * innerH);
        const x = padL + i * slot + (slot - barW) / 2;
        return (
          <rect key={d.label} x={x} y={H - padB - h} width={barW} height={Math.max(h, 0)} rx="2" fill="var(--color-crimson)" opacity="0.85">
            <title>{`${d.label}: ${fmtNum(d.current)}`}</title>
          </rect>
        );
      })}
      {[0, mid, n > 1 ? n - 1 : 0].filter((i, idx, arr) => idx === arr.indexOf(i)).map((i) => (
        <text key={i} x={padL + i * slot + slot / 2} y={H - 5} textAnchor="middle" fontSize="9" fill="var(--color-grey)">
          {series[i]?.label ?? ''}
        </text>
      ))}
    </svg>
  );
}

function Donut({ segments, total }: { segments: Array<{ status: string; label: string; count: number; color: string }>; total: number }) {
  const r = 40;
  const cx = 60;
  const cy = 60;
  const C = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" className="w-[120px] h-[120px] shrink-0" role="img" aria-label="Order status donut">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-paper-3)" strokeWidth="13" />
        {total > 0 &&
          segments.map((s) => {
            const len = (s.count / total) * C;
            const seg = Math.max(0, len - 1.4);
            const el = (
              <circle
                key={s.status}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth="13"
                strokeDasharray={`${seg.toFixed(2)} ${(C - seg).toFixed(2)}`}
                strokeDashoffset={(-acc).toFixed(2)}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            );
            acc += len;
            return el;
          })}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="19" fontWeight="700" fill="var(--color-bone)">
          {fmtNum(total)}
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize="8" letterSpacing="1.5" fill="var(--color-grey)">
          ORDERS
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {segments.map((s) => (
          <li key={s.status} className="flex items-center gap-2 text-[11px]">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
            <span className="min-w-0 flex-1 truncate text-bone-dim">{s.label}</span>
            <span className="font-semibold text-bone tabular-nums">{fmtNum(s.count)}</span>
          </li>
        ))}
        {segments.length === 0 && <li className="text-[11px] text-grey">No orders in this period.</li>}
      </ul>
    </div>
  );
}

const STATUS_ORDER = ['pending', 'processing', 'shipped', 'delivered', 'rto', 'cancelled', 'refunded'] as const;

const STATUS_COLORS: Record<string, string> = {
  pending: '#f59e0b',
  processing: '#6366f1',
  shipped: '#818cf8',
  delivered: '#16a34a',
  rto: '#f97316',
  cancelled: '#d20a2e',
  refunded: '#94a3b8',
};

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

type Metric = 'orders' | 'revenue' | 'units';

export function OverviewSection({
  range,
  onRange,
  onOpenOrders,
  onOpenInventory,
  onOpenAnalytics,
  onOpenActivity,
}: {
  range: DashRange;
  onRange: (r: DashRange) => void;
  onOpenOrders?: () => void;
  onOpenInventory?: () => void;
  onOpenAnalytics?: () => void;
  onOpenActivity?: () => void;
}) {
  const [data, setData] = useState<DashSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [metric, setMetric] = useState<Metric>('orders');

  const load = useCallback(async (r: DashRange) => {
    setLoading(true);
    setError('');
    try {
      setData(await fetchDashSnapshot(r));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the dashboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
  }, [range, load]);

  const series = useMemo(() => {
    if (!data) return { labels: [], current: [], prior: [] };
    const src = metric === 'revenue' ? data.revenueSeries : metric === 'units' ? data.unitsSeries : data.ordersSeries;
    return {
      labels: src.map((d) => d.label),
      current: src.map((d) => d.current),
      prior: src.map((d) => d.prior),
    };
  }, [data, metric]);

  const currentTotal = useMemo(() => series.current.reduce((a, b) => a + b, 0), [series]);
  const priorTotal = useMemo(() => series.prior.reduce((a, b) => a + b, 0), [series]);

  const donutSegments = useMemo(() => {
    const counts = new Map<string, number>((data?.statusCounts ?? []).map((s) => [s.status, s.count]));
    return STATUS_ORDER.filter((s) => (counts.get(s as string) ?? 0) > 0).map((s) => ({
      status: s as string,
      label: ORDER_STATUS_LABEL[s as string]?.label ?? s as string,
      count: counts.get(s as string) ?? 0,
      color: STATUS_COLORS[s as string] ?? '#94a3b8',
    }));
  }, [data]);

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorBox message={error} />
        <Btn onClick={() => load(range)}>
          <RefreshCw size={13} /> Retry
        </Btn>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  const caption = rangeCaption(range);
  const orderTotal = data.totalOrders;
  const revenueTotal = data.revenue;
  const cashTotal = data.cashCollected;
  const codDueOrders = data.codDueOrders;
  const aovTotal = data.aov;
  const unitsTotal = data.units;

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold tracking-tight text-bone leading-none">Dashboard</h1>
          <p className="mt-1.5 text-[13px] text-grey">Overview of your store performance</p>
          <p className="mt-1 text-[10px] text-grey/80">
            {rangeLabel(range)} · {formatOpsDateOnly(data.from)} → {formatOpsDateOnly(data.to)} · updated {formatOpsDate(data.ts)}
          </p>
        </div>
        <button
          onClick={() => load(range)}
          title="Refresh"
          className="grid w-9 h-9 place-items-center rounded-lg border border-line bg-white text-bone-dim hover:text-bone hover:border-line-2 transition-colors"
        >
          <RefreshCw size={15} strokeWidth={1.8} />
        </button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 sm:gap-4">
        <KpiCard
          icon={ShoppingCart}
          iconCls="bg-sky-100 text-sky-700"
          label="Total orders"
          value={fmtNum(orderTotal.value)}
          spark={data.ordersSeries.map((d) => d.current)}
          sparkColor="#6366f1"
          metric={orderTotal}
          caption={caption}
        />
        <KpiCard
          icon={IndianRupee}
          iconCls="bg-crimson/10 text-crimson"
          label="Order value"
          value={inr(revenueTotal.value)}
          spark={data.revenueSeries.map((d) => d.current)}
          sparkColor="var(--color-crimson)"
          metric={revenueTotal}
          caption={caption}
        />
        <KpiCard
          icon={IndianRupee}
          iconCls="bg-green-600/10 text-green-700"
          label="Cash collected"
          value={inr(cashTotal.value)}
          spark={data.cashSeries.map((d) => d.current)}
          sparkColor="#16a34a"
          metric={cashTotal}
          caption={caption}
        />
        <KpiCard
          icon={BarChart3}
          iconCls="bg-paper-3 text-bone-dim"
          label="Avg order value"
          value={inr(aovTotal.value)}
          spark={data.revenueSeries.map((d) => d.current)}
          sparkColor="#9a9a9a"
          metric={aovTotal}
          caption={caption}
        />
        <KpiCard
          icon={Boxes}
          iconCls="bg-green-600/10 text-green-700"
          label="Products sold"
          value={fmtNum(unitsTotal.value)}
          spark={data.unitsSeries.map((d) => d.current)}
          sparkColor="#16a34a"
          metric={unitsTotal}
          caption={caption}
        />
      </div>

      {/* Cash reconciliation: an unpaid COD order is real order value but is not
          collected money, so the gap between the two cards is explained rather
          than left to look like a collection failure. */}
      {data.codDue.value > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-white px-3 py-2 text-[12px]">
          <Banknote size={14} strokeWidth={1.8} className="text-grey" />
          <span className="text-grey">Awaiting collection on delivery</span>
          <span className="font-medium text-bone tabular-nums">{inr(data.codDue.value)}</span>
          <span className="text-grey/80">
            across {fmtNum(codDueOrders)} COD order{codDueOrders === 1 ? '' : 's'} — included in order value, not yet in cash collected.
          </span>
        </div>
      )}

      {/* Main row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 sm:gap-4">
        {/* Sales overview */}
        <Card
          title="Sales overview"
          className="lg:col-span-7"
          action={
            <div className="flex items-center gap-2">
              <div className="hidden sm:inline-flex rounded-lg bg-paper-2 p-0.5">
                {(['orders', 'revenue', 'units'] as Metric[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMetric(m)}
                    className={`rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide-2 transition-colors ${
                      metric === m ? 'bg-bone text-white' : 'text-bone-dim hover:text-bone'
                    }`}
                  >
                    {m === 'revenue' ? 'Revenue' : m === 'units' ? 'Units' : 'Orders'}
                  </button>
                ))}
              </div>
              <RangeButton range={range} onChange={onRange} />
            </div>
          }
        >
          {currentTotal === 0 && priorTotal === 0 ? (
            <p className="py-12 text-center text-xs text-grey">No {metric === 'revenue' ? 'revenue' : metric === 'units' ? 'units' : 'orders'} in this period yet.</p>
          ) : (
            <>
              <LineChart
                labels={series.labels}
                current={series.current}
                prior={series.prior}
                format={(n) => (metric === 'revenue' ? inr(n) : fmtNum(n))}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                <div className="flex items-center gap-4 text-[10px] text-grey">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-1.5 rounded-full" style={{ backgroundColor: 'var(--color-crimson)' }} />
                    {metric === 'revenue' ? 'Revenue' : metric === 'units' ? 'Units' : 'Orders'} · current
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 border-t-2 border-dashed border-[#b7b7b7]" />
                    previous {RANGE_DAYS[data.range]} days
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="text-grey">
                    Current <b className="font-semibold text-bone tabular-nums">{fmtNum(currentTotal)}</b>
                  </span>
                  <span className="text-grey">
                    Previous <b className="font-semibold text-bone-dim tabular-nums">{priorTotal > 0 ? fmtNum(priorTotal) : '—'}</b>
                  </span>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* Recent orders */}
        <Card
          title="Recent orders"
          className="lg:col-span-3"
          action={<ViewAll onClick={onOpenOrders} />}
        >
          {data.recentOrders.length === 0 ? (
            <p className="py-10 text-center text-xs text-grey">No orders in this period.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.recentOrders.map((o) => (
                <li key={o.id} className="flex items-center gap-2.5 py-2.5">
                  <div className="w-8 h-10 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
                    {data.thumbs[o.color_id ?? ''] && <img src={data.thumbs[o.color_id ?? ''] ?? ''} alt="" className="h-full w-full object-cover" loading="lazy" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[12px] font-semibold text-bone">{o.ref}</p>
                      <PayPill o={o} />
                    </div>
                    <p className="truncate text-[10px] text-grey">{o.customerName}</p>
                    <p className="text-[10px] text-grey">{formatOpsDate(o.created_at)}</p>
                  </div>
                  <div className="shrink-0">
                    <p className="font-price text-[12px] text-bone tabular-nums">{inr(o.total_amount)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Top products */}
        <Card
          title="Top products"
          className="lg:col-span-2"
          action={<ViewAll onClick={onOpenAnalytics} />}
        >
          {data.topProducts.length === 0 ? (
            <p className="py-10 text-center text-xs text-grey">No paid sales in this period.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.topProducts.map((p, i) => {
                const pct = data.topProducts[0].units > 0 ? (p.units / data.topProducts[0].units) * 100 : 0;
                return (
                  <li key={`${p.product_id}-${p.color_id}`} className="py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-10 shrink-0 overflow-hidden bg-paper-3 border border-line rounded">
                        {data.thumbs[p.color_id] && <img src={data.thumbs[p.color_id] ?? ''} alt="" className="h-full w-full object-cover" loading="lazy" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-semibold text-bone">
                          <span className="text-grey tabular-nums mr-0.5">{i + 1}.</span>
                          {p.name}
                        </p>
                        <p className="text-[10px] text-grey">{fmtNum(p.units)} units</p>
                      </div>
                      <div className="shrink-0">
                        <p className="font-price text-[12px] text-bone tabular-nums">{inr(p.revenue)}</p>
                      </div>
                    </div>
                    <div className="mt-1.5 h-1 bg-paper-3 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, backgroundColor: 'var(--color-crimson)' }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
        {/* Order status */}
        <Card title="Order status" action={<ViewAll onClick={onOpenOrders} />}>
          <Donut segments={donutSegments} total={orderTotal.value} />
        </Card>

        {/* Inventory health */}
        <Card title="Inventory health" action={<ViewAll onClick={onOpenInventory} />}>
          <div className="space-y-2.5">
            {[
              { label: 'Out of stock', value: fmtNum(data.inventory.out), icon: Boxes, cls: 'bg-crimson/10 text-crimson' },
              { label: 'Low stock', value: fmtNum(data.inventory.low), icon: TriangleAlert, cls: 'bg-amber-100 text-amber-700' },
              { label: 'In stock', value: fmtNum(data.inventory.in), icon: CheckCircle2, cls: 'bg-sky-100 text-sky-700' },
              { label: 'Incoming', value: fmtNum(data.inventory.incomingUnits), icon: ArrowDownToLine, cls: 'bg-violet-100 text-violet-600' },
            ].map((row) => (
              <div key={row.label} className="flex items-center gap-2.5">
                <div className={`grid place-items-center w-7 h-7 rounded-lg shrink-0 ${row.cls}`}>
                  <row.icon size={14} strokeWidth={2} />
                </div>
                <span className="min-w-0 flex-1 flex items-center justify-between text-[12px]">
                  <span className="text-bone-dim">{row.label}</span>
                  <span className="font-semibold text-bone tabular-nums">{row.value}</span>
                </span>
              </div>
            ))}
            <p className="pt-1 text-[10px] text-grey">
              Low stock = available above zero, at or below the variant reorder point · incoming = units {data.inventory.total > 0 ? 'pending restock' : 'on purchase orders'}
            </p>
          </div>
        </Card>

        {/* Revenue breakdown */}
        <Card
          title="Revenue breakdown"
          className="md:col-span-2 xl:col-span-1"
          action={<RangeButton range={range} onChange={onRange} />}
        >
          {revenueTotal.value === 0 ? (
            <p className="py-12 text-center text-xs text-grey">No paid revenue in this period.</p>
          ) : (
            <div>
              <BarsChart series={data.revenueSeries} />
              <p className="mt-2 text-right text-[10px] text-grey">
                Total {inr(revenueTotal.value)} across {data.revenueSeries.length} days
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

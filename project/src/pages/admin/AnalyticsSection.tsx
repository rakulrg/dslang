import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchAnalytics, inr } from '@/lib/ops';
import type { AnalyticsResult } from '@/lib/types';
import { LoadingDots } from '@/components/LoadingDots';
import { Panel, Chip, ErrorBox, Td, Th, Btn, EmptyState, Donut, fmtNum } from '@/pages/admin/OpsUi';
import { ORDER_STATUS_LABEL } from '@/pages/admin/orderLabels';

const MIX_COLORS: Record<string, string> = {
  Online: 'var(--color-bone)',
  COD: 'var(--color-crimson)',
};

const FUNNEL_CLS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  processing: 'bg-sky-100 text-sky-700',
  shipped: 'bg-indigo-100 text-indigo-700',
  delivered: 'bg-green-600/10 text-green-700',
  rto: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-crimson/10 text-crimson',
  refunded: 'bg-grey/15 text-grey',
};

export function AnalyticsSection() {
  const [data, setData] = useState<AnalyticsResult | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      setData(await fetchAnalytics());
    } catch (e) {
      setData(null);
      setErr(e instanceof Error ? e.message : 'Could not load analytics.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <div className="space-y-3">
        <ErrorBox message={err} />
        <Btn onClick={load}><RefreshCw size={13} /> Retry</Btn>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  const repeatRate = data.repeat.customers > 0 ? Math.round((data.repeat.returning / data.repeat.customers) * 100) : 0;
  const maxFunnel = Math.max(1, ...data.status_funnel.map((s) => Number(s.count)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-grey">All-time analytics computed live from retail orders.</p>
        <Btn onClick={load}><RefreshCw size={13} /> Refresh</Btn>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Panel title="Payment mix" className="[&>div:last-child]:p-4">
          <Donut
            segments={(data.payment_mix ?? []).map((m) => ({
              label: m.method,
              value: m.orders,
              color: MIX_COLORS[m.method] ?? 'var(--color-grey)',
            }))}
          />
          <p className="px-4 pb-4 text-[11px] text-grey">
            {data.payment_mix?.map((m) => `${m.method}: ${inr(m.revenue)}`).join(' · ') || 'No orders yet.'}
          </p>
        </Panel>
        <Panel title="Status funnel" className="[&>div:last-child]:p-4">
          <div className="space-y-2">
            {(data.status_funnel ?? []).map((s) => (
              <div key={s.status} className="flex items-center gap-2">
                <span className="w-32 shrink-0 text-xs text-bone-dim truncate">
                  {ORDER_STATUS_LABEL[s.status]?.label ?? s.status}
                </span>
                <div className="flex-1 h-5 bg-paper-3 rounded-sm overflow-hidden relative">
                  <div
                    className="h-full bg-bone/80 rounded-sm"
                    style={{ width: `${Math.max(3, (Number(s.count) / maxFunnel) * 100)}%` }}
                  />
                </div>
                <span className="w-10 text-right text-xs tabular-nums text-bone">{fmtNum(s.count)}</span>
              </div>
            ))}
            {(!data.status_funnel || data.status_funnel.length === 0) && <p className="text-xs text-grey">No orders yet.</p>}
          </div>
          <p className="mt-4 text-[11px] text-grey">
            Returning customers <b className="text-bone">{fmtNum(data.repeat.returning)}</b> of {fmtNum(data.repeat.customers)} — {repeatRate}% repeat rate.
          </p>
        </Panel>
        <Panel title="Top cities" className="[&>div:last-child]:p-4">
          <div className="space-y-2">
            {(data.geo ?? []).map((g) => (
              <div key={g.city} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-bone truncate">{g.city}</span>
                <span className="shrink-0 text-xs text-grey tabular-nums">{fmtNum(g.orders)} · {inr(g.revenue)}</span>
              </div>
            ))}
            {(!data.geo || data.geo.length === 0) && <p className="text-xs text-grey">No orders yet.</p>}
          </div>
        </Panel>
        <Panel title="Repeat rate" className="[&>div:last-child]:p-4">
          <p className="font-price text-4xl text-bone">{repeatRate}%</p>
          <p className="mt-2 text-xs text-grey">
            {fmtNum(data.repeat.returning)} customers have ordered more than once out of {fmtNum(data.repeat.customers)} total.
          </p>
        </Panel>
      </div>

      <Panel title="Top products" action={<Chip label="all-time" cls="bg-paper-3 text-bone-dim" />}>
        {(!data.top_products || data.top_products.length === 0) ? (
          <EmptyState title="No sales yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="bg-paper-2">
                <tr>
                  <Th>#</Th>
                  <Th>Product</Th>
                  <Th>Colour · Size</Th>
                  <Th className="text-right">Units</Th>
                  <Th className="text-right">Orders</Th>
                  <Th className="text-right">Revenue</Th>
                </tr>
              </thead>
              <tbody>
                {data.top_products.map((p, i) => (
                  <tr key={`${p.product_id}-${p.color_id}-${p.size_label}-${i}`} className="border-t border-line">
                    <Td className="text-grey">{i + 1}</Td>
                    <Td>
                      <span className="font-semibold text-bone block">{p.name}</span>
                      <span className="text-[11px] text-grey">{p.code}</span>
                    </Td>
                    <Td className="text-bone-dim whitespace-nowrap">{p.color} · {p.size_label}</Td>
                    <Td className="text-right tabular-nums">{fmtNum(p.units)}</Td>
                    <Td className="text-right tabular-nums text-bone-dim">{fmtNum(p.orders)}</Td>
                    <Td className="text-right font-price tabular-nums">{inr(p.revenue)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

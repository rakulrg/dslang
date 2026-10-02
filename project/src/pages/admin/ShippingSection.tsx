import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Package, Truck, AlertTriangle, CheckCircle2, ArrowUpRight } from 'lucide-react';
import { adminFetchRetailOrders, describeSupabaseError } from '@/lib/admin';
import { formatPrice } from '@/lib/catalog';
import type { RetailOrder } from '@/lib/types';
import { LoadingDots } from '@/components/LoadingDots';
import { Panel, Chip, ErrorBox, Btn, EmptyState, Stat, fmtNum } from '@/pages/admin/OpsUi';

const PAY_CLS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  success: 'bg-green-600/10 text-green-700',
  paid: 'bg-green-600/10 text-green-700',
  failed: 'bg-crimson/10 text-crimson',
  // A full-COD order is CONFIRMED at creation (nothing is owed until the door),
  // so it is queued for packing exactly like a paid online order.
  cod: 'bg-bone/10 text-bone',
  cod_pending: 'bg-bone/10 text-bone',
};

/** Confirmed = committed and stock-reserved, so it may be picked and packed.
 *  COD counts: the money is collected on delivery, not at checkout. */
const CONFIRMED_PAYMENTS = new Set(['success', 'paid', 'cod', 'cod_pending']);

const ORDER_CLS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  processing: 'bg-sky-100 text-sky-700',
  shipped: 'bg-indigo-100 text-indigo-700',
  delivered: 'bg-green-600/10 text-green-700',
  rto: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-crimson/10 text-crimson',
  refunded: 'bg-grey/15 text-grey',
};

const SHIPPABLE = new Set(['pending', 'processing']);

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function Row({
  o,
  summary,
  onOpen,
}: {
  o: RetailOrder;
  summary?: string;
  onOpen: () => void;
}) {
  const pay = PAY_CLS[o.payment_status];
  const st = ORDER_CLS[o.order_status] ?? 'bg-grey/15 text-grey';
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-bone">{o.ref}</span>
          <Chip label={o.order_status} cls={st} />
          {pay && <Chip label={o.payment_status} cls={pay} />}
          {o.is_cod && <Chip label="COD" cls="bg-bone/10 text-bone" />}
          {summary && <span className="text-[11px] text-grey">{summary}</span>}
        </div>
        <p className="text-xs text-grey mt-0.5 truncate">
          {o.customer.name} · {o.customer.phone}
          {o.customer.city ? ` · ${o.customer.city}` : ''} · {fmt(o.created_at)}
        </p>
        {(o.awb_number || o.tracking_id) && (
          <p className="text-[11px] text-bone-dim mt-0.5 tabular-nums">
            {o.courier_name ? `${o.courier_name} · ` : ''}
            {o.awb_number || o.tracking_id}
            {o.tracking_current_status ? ` — ${o.tracking_current_status}` : ''}
          </p>
        )}
        {o.ship_attempt_error && (
          <p className="text-[11px] text-crimson mt-0.5 truncate">⚠ {o.ship_attempt_error}</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-semibold text-bone">{formatPrice(o.total_amount)}</p>
        <button onClick={onOpen} className="mt-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone">
          Open in Orders <ArrowUpRight size={11} />
        </button>
      </div>
    </div>
  );
}

function Queue({
  title,
  icon,
  items,
  empty,
  iconCls = 'text-bone',
  onOpen,
  summaryOf,
}: {
  title: string;
  icon: React.ReactNode;
  items: RetailOrder[];
  empty: string;
  iconCls?: string;
  onOpen: () => void;
  summaryOf?: (o: RetailOrder) => string;
}) {
  return (
    <Panel title={`${title} (${items.length})`} action={<span className={iconCls}>{icon}</span>}>
      {items.length === 0 ? (
        <EmptyState title="All clear" sub={empty} />
      ) : (
        <div className="divide-y divide-line">
          {items.map((o) => (
            <Row key={o.id} o={o} onOpen={onOpen} summary={summaryOf?.(o)} />
          ))}
        </div>
      )}
    </Panel>
  );
}

export function ShippingSection({ onOpenOrders }: { onOpenOrders: () => void }) {
  const [orders, setOrders] = useState<RetailOrder[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      setOrders(await adminFetchRetailOrders());
    } catch (e) {
      setOrders([]);
      setErr(e instanceof Error ? e.message : describeSupabaseError(e, 'Could not load orders.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasLive = (o: RetailOrder) =>
    Boolean(o.awb_number || o.tracking_id || (o.shiprocket_order_id && o.shiprocket_order_id !== 'creating'));

  const groups = useMemo(() => {
    const arr = orders ?? [];
    const confirmedShippable = arr.filter(
      (o) => CONFIRMED_PAYMENTS.has(o.payment_status) && SHIPPABLE.has(o.order_status),
    );
    return {
      packing: confirmedShippable,
      readyToShip: confirmedShippable.filter((o) => !hasLive(o) && !o.ship_attempt_error),
      exceptions: arr.filter((o) => o.ship_attempt_error && o.order_status !== 'delivered'),
      inTransit: arr.filter(
        (o) => o.order_status === 'shipped' || (hasLive(o) && o.order_status !== 'delivered' && o.payment_status !== 'failed'),
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);

  if (orders === null) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  const kpis: Array<{ label: string; value: string; sub?: string; tone?: 'default' | 'good' | 'warn' | 'bad' }> = [
    { label: 'Packing queue', value: fmtNum(groups.packing.length), tone: 'warn' },
    { label: 'Ready to ship', value: fmtNum(groups.readyToShip.length), sub: 'confirmed · no AWB yet' },
    { label: 'In transit', value: fmtNum(groups.inTransit.length) },
    { label: 'Exceptions', value: fmtNum(groups.exceptions.length), tone: groups.exceptions.length > 0 ? 'bad' : 'default' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-grey">Shipping pipeline — fulfilment monitored live from retail orders. Fulfilment actions (ship, AWB, label, address) live in <b className="text-bone-dim">Orders</b>.</p>
        <Btn onClick={load}><RefreshCw size={13} /> Refresh</Btn>
      </div>

      {err && <ErrorBox message={err} />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((k) => (
          <Stat key={k.label} {...k} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Queue
          title="Ready to ship"
          icon={<Truck size={15} />}
          items={groups.readyToShip}
          empty="No paid orders waiting for AWB."
          iconCls="text-amber-700"
          onOpen={onOpenOrders}
          summaryOf={(o) => (o.auto_ship_at ? 'auto-ship scheduled' : 'manual AWB')}
        />
        <Queue
          title="Packing queue"
          icon={<Package size={15} />}
          items={groups.packing}
          empty="Nothing waiting to be packed."
          iconCls="text-sky-700"
          onOpen={onOpenOrders}
        />
        <Queue
          title="In transit"
          icon={<Truck size={15} />}
          items={groups.inTransit}
          empty="No shipments in transit."
          iconCls="text-indigo-700"
          onOpen={onOpenOrders}
        />
        <Queue
          title="Exceptions"
          icon={<AlertTriangle size={15} />}
          items={groups.exceptions}
          empty="No failed shipment attempts."
          iconCls="text-crimson"
          onOpen={onOpenOrders}
        />
      </div>

      <p className="text-[11px] text-grey flex items-center gap-1.5">
        <CheckCircle2 size={12} /> Delivered/RTO/completed orders stay in the Orders tab — this surface focuses only on the live fulfilment queue.
      </p>
    </div>
  );
}

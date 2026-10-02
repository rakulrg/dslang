import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Phone } from 'lucide-react';
import { fetchCustomers, inr, formatOpsDate } from '@/lib/ops';
import { LoadingDots } from '@/components/LoadingDots';
import { Chip, ErrorBox, Td, Th, Btn, EmptyState, fmtNum } from '@/pages/admin/OpsUi';

const PAGE_SIZE = 100;

export function CustomersSection() {
  const [rows, setRows] = useState<null | Awaited<ReturnType<typeof fetchCustomers>>>(null);
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState('');

  const load = useCallback(async (off: number) => {
    setErr('');
    try {
      setRows(await fetchCustomers(off, PAGE_SIZE));
    } catch (e) {
      setRows({ total: 0, customers: [] });
      setErr(e instanceof Error ? e.message : 'Could not load customers.');
    }
  }, []);

  useEffect(() => { load(offset); }, [offset, load]);

  if (rows === null) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <LoadingDots />
      </div>
    );
  }

  const customers = rows.customers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-grey">
          {fmtNum(rows.total)} customer{rows.total === 1 ? '' : 's'} — grouped by phone across all paid orders.
        </p>
        <Btn onClick={() => load(offset)}><RefreshCw size={13} /> Refresh</Btn>
      </div>

      {err && <ErrorBox message={err} />}

      {customers.length === 0 ? (
        <EmptyState title="No customers yet" sub="Orders placed on the storefront will appear here." />
      ) : (
        <div className="bg-white border border-line rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead className="bg-paper-2">
                <tr>
                  <Th>Customer</Th>
                  <Th>Phone</Th>
                  <Th className="text-right">Orders</Th>
                  <Th className="text-right">Units</Th>
                  <Th className="text-right">Total spent</Th>
                  <Th className="text-right">Avg order</Th>
                  <Th className="text-center">COD</Th>
                  <Th>Last order</Th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.phone} className="border-t border-line">
                    <Td>
                      <span className="font-semibold text-bone">{c.name || '—'}</span>
                      {c.city && <span className="block text-[11px] text-grey">{c.city}</span>}
                    </Td>
                    <Td className="text-bone-dim">
                      <span className="inline-flex items-center gap-1.5">
                        <Phone size={12} className="text-grey" />
                        {c.phone}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums font-medium">{fmtNum(c.order_count)}</Td>
                    <Td className="text-right tabular-nums text-bone-dim">{fmtNum(c.units_ordered)}</Td>
                    <Td className="text-right font-price tabular-nums">{inr(c.total_spent)}</Td>
                    <Td className="text-right tabular-nums text-bone-dim">{inr(c.average_order)}</Td>
                    <Td className="text-center">{c.has_cod ? <Chip label="COD" cls="bg-bone/10 text-bone" /> : <span className="text-grey text-xs">online</span>}</Td>
                    <Td className="text-grey text-xs whitespace-nowrap">
                      {c.last_ref} · {formatOpsDate(c.last_order_at)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-grey">
          {customers.length > 0 ? `${fmtNum(offset + 1)}–${fmtNum(offset + customers.length)} of ${fmtNum(rows.total)}` : ''}
        </p>
        <div className="flex items-center gap-1">
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} className="p-2 border border-line rounded text-bone-dim hover:text-bone disabled:opacity-40 transition-colors">
            <ChevronLeft size={15} />
          </button>
          <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= rows.total} className="p-2 border border-line rounded text-bone-dim hover:text-bone disabled:opacity-40 transition-colors">
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
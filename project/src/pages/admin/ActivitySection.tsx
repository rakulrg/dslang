import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { fetchAdminActivity, formatOpsDate, MOVEMENT_TYPE_CLS } from '@/lib/ops';
import type { AdminActivity } from '@/lib/types';
import { LoadingDots } from '@/components/LoadingDots';
import { Chip, ErrorBox, Td, Th, Btn, EmptyState, fmtNum } from '@/pages/admin/OpsUi';

const PAGE_SIZE = 50;

const ENTITY_CLS: Record<string, string> = {
  product: 'bg-paper-3 text-bone-dim',
  variant: 'bg-paper-3 text-bone-dim',
  retail_order: 'bg-sky-100 text-sky-700',
  purchase_order: 'bg-amber-100 text-amber-700',
  promo_code: 'bg-indigo-100 text-indigo-700',
  supplier: 'bg-teal-100 text-teal-700',
};

const ACTION_CLS: Record<string, string> = {
  create: 'bg-green-600/10 text-green-700',
  CREATE: 'bg-green-600/10 text-green-700',
  update: 'bg-green-600/10 text-green-700',
  delete: 'bg-crimson/10 text-crimson',
  adjust_stock: 'bg-amber-100 text-amber-700',
  set_reorder: 'bg-paper-3 text-bone-dim',
  archive_product: 'bg-grey/15 text-grey',
  unarchive_product: 'bg-green-600/10 text-green-700',
  receive: 'bg-green-600/10 text-green-700',
  STATUS: 'bg-sky-100 text-sky-700',
};

export function ActivitySection() {
  const [rows, setRows] = useState<AdminActivity[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [entity, setEntity] = useState('all');
  const [err, setErr] = useState('');

  const load = useCallback(async (e: string, off: number) => {
    setErr('');
    try {
      const res = await fetchAdminActivity({ entity: e === 'all' ? undefined : e, offset: off, limit: PAGE_SIZE });
      setRows(res.rows);
      setTotal(res.total);
    } catch (err2) {
      setRows([]);
      setErr(err2 instanceof Error ? err2.message : 'Could not load the activity log.');
    }
  }, []);

  useEffect(() => { load(entity, offset); }, [entity, offset, load]);

  const entities = ['all', 'product', 'variant', 'retail_order', 'purchase_order', 'promo_code', 'supplier'];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {entities.map((e) => (
            <button
              key={e}
              onClick={() => { setEntity(e); setOffset(0); }}
              className={`px-2.5 py-1.5 text-[10px] uppercase tracking-wide-2 font-semibold rounded-full border transition-colors ${
                entity === e ? 'bg-bone text-white border-bone' : 'border-line text-bone-dim hover:border-bone'
              }`}
            >
              {e === 'all' ? 'All' : e.replace('_', ' ')}
            </button>
          ))}
        </div>
        <Btn onClick={() => load(entity, offset)}><RefreshCw size={13} /> Refresh</Btn>
      </div>

      {err && <ErrorBox message={err} />}

      {rows === null ? (
        <div className="min-h-[40vh] flex items-center justify-center"><LoadingDots /></div>
      ) : rows.length === 0 ? (
        <EmptyState title="No activity yet" sub="Admin actions across products, orders, promotions and purchasing appear here." />
      ) : (
        <div className="bg-white border border-line rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="bg-paper-2">
                <tr>
                  <Th>When</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Reference</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <Td className="text-grey text-xs whitespace-nowrap">{formatOpsDate(a.created_at)}</Td>
                    <Td className="text-bone-dim">{a.actor_email ?? '—'}</Td>
                    <Td><Chip label={a.action} cls={ACTION_CLS[a.action] ?? MOVEMENT_TYPE_CLS[a.action] ?? 'bg-paper-3 text-bone-dim'} /></Td>
                    <Td><Chip label={a.entity} cls={ENTITY_CLS[a.entity] ?? 'bg-paper-3 text-bone-dim'} /></Td>
                    <Td className="text-bone-dim text-xs">{a.entity_ref ?? (a.entity_id ? a.entity_id.slice(0, 13) : '—')}</Td>
                    <Td className="text-grey text-xs">
                      {a.metadata ? summarizeMetadata(a.metadata) : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-grey">{fmtNum(total)} logged actions</p>
        <div className="flex items-center gap-1">
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} className="p-2 border border-line rounded text-bone-dim hover:text-bone disabled:opacity-40 transition-colors">
            <ChevronLeft size={15} />
          </button>
          <span className="px-2 text-xs text-grey tabular-nums">{Math.floor(offset / PAGE_SIZE) + 1}/{Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
          <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total} className="p-2 border border-line rounded text-bone-dim hover:text-bone disabled:opacity-40 transition-colors">
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function summarizeMetadata(meta: Record<string, unknown>): string {
  try {
    const parts = Object.entries(meta)
      .slice(0, 6)
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}: ${v.length}×`;
        if (v && typeof v === 'object') return `${k}: {…}`;
        return `${k}: ${String(v)}`;
      });
    return parts.join(', ');
  } catch {
    return JSON.stringify(meta);
  }
}
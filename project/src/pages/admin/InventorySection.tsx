import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode, MouseEvent } from 'react';
import {
  RefreshCw,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  SlidersHorizontal,
  Layers,
  History,
  Plus,
  Minus,
  ArrowDownUp,
} from 'lucide-react';
import type { VariantInventory, StockMovement } from '@/lib/types';
import {
  fetchInventory,
  fetchInventoryFilters,
  fetchInventoryKpis,
  fetchProductOpsWorkspace,
  fetchStockMovements,
  fetchVariantThumbs,
  adjustVariantStock,
  setVariantReorder,
  bulkSetVariantReorder,
  variantMatrixKey,
  inr,
  formatOpsDate,
  ADJUSTMENT_REASONS,
  MOVEMENT_TYPE_CLS,
  type InventoryFilters,
  type InventoryKpis,
  type ProductOpsWorkspace,
} from '@/lib/ops';
import { sortSizeLabels } from '@/lib/sizes';
import { LoadingDots } from '@/components/LoadingDots';
import { Chip, ErrorBox, Td, Th, Btn, EmptyState, fmtNum } from '@/pages/admin/OpsUi';
import { stockStatus, STOCK_STATUS_CLS, STOCK_STATUS_LABEL, hasIncomingUnits } from '@/pages/admin/inventoryStatus';

const PAGE_SIZE = 50;

type StockFilter = 'all' | 'in' | 'low' | 'out' | 'incoming';
type SortKey = 'name' | 'available' | 'on_hand' | 'value' | 'updated_at';

/* ---- Shared pieces ---- */

function StatusPill({ v }: { v: VariantInventory }) {
  const s = stockStatus(v);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Chip label={STOCK_STATUS_LABEL[s]} cls={STOCK_STATUS_CLS[s]} />
      {hasIncomingUnits(v) && <Chip label="Incoming" cls="bg-sky-100 text-sky-700" />}
    </span>
  );
}

function Kpi({
  label,
  value,
  tone = 'default',
  active = false,
  onClick,
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'warn' | 'bad';
  active?: boolean;
  onClick?: () => void;
}) {
  const toneCls = tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-crimson' : 'text-bone';
  const cls = `bg-white border ${active ? 'border-bone ring-1 ring-bone' : 'border-line'} rounded-xl shadow-sm p-3.5 text-left transition-colors`;
  const inner = (
    <>
      <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">{label}</p>
      <p className={`mt-1 font-price text-xl sm:text-2xl leading-none tabular-nums ${toneCls}`}>{value}</p>
    </>
  );
  if (onClick) {
    return (
      <button onClick={onClick} className={`${cls} hover:border-bone/40`}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

function KpiSkeleton() {
  return <div className="bg-white border border-line rounded-xl shadow-sm p-3.5 animate-pulse"><div className="h-2.5 w-16 bg-paper-3 rounded" /><div className="mt-2 h-6 w-10 bg-paper-3 rounded" /></div>;
}

function HealthItem({
  label,
  n,
  dot,
  active,
  onClick,
}: {
  label: string;
  n: React.ReactNode;
  dot: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 text-xs transition-colors ${active ? 'text-bone font-semibold' : 'text-bone-dim hover:text-bone'}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label} <b className="tabular-nums">{n}</b>
    </button>
  );
}

function MenuRow({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs text-bone-dim hover:bg-paper-2 hover:text-bone transition-colors">
      {icon}
      {label}
    </button>
  );
}

/* ---- Desktop row ---- */

interface VariantRowProps {
  v: VariantInventory;
  selected: boolean;
  thumb: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onMatrix: () => void;
  onMenuToggle: (e: MouseEvent<HTMLButtonElement>) => void;
}

function VariantRow({ v, selected, thumb, onToggle, onOpen, onMatrix, onMenuToggle }: VariantRowProps) {
  return (
    <tr className="border-t border-line hover:bg-paper-2/60 transition-colors">
      <Td className="px-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="w-4 h-4 accent-bone" aria-label="Select variant" />
      </Td>
      <Td>
        <button onClick={onOpen} className="flex items-center gap-2.5 text-left group max-w-[280px]">
          <span className="w-9 h-9 rounded-md border border-line bg-paper-2 shrink-0 overflow-hidden flex items-center justify-center">
            {thumb ? (
              <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <span className="text-[9px] uppercase tracking-wide-2 text-grey">DS</span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-bone truncate group-hover:underline">{v.product_name}</span>
            <span className="block text-[11px] text-grey truncate">
              {v.product_code}
            </span>
          </span>
        </button>
      </Td>
      <Td>
        <span className="inline-flex items-center gap-2">
          {v.color_hex && (
            <span className="w-3 h-3 rounded-full border border-line shrink-0" style={{ backgroundColor: v.color_hex }} />
          )}
          <span className="text-bone-dim">{v.color_name}</span>
          <Chip label={v.size_label} cls="bg-paper-3 text-bone-dim" />
        </span>
      </Td>
      <Td>
        <span title={v.variant_id} className="font-mono text-[11px] text-bone-dim">
          {v.variant_id.slice(0, 8)}
        </span>
      </Td>
      <Td className="text-right font-price tabular-nums">{fmtNum(v.available)}</Td>
      <Td className="text-right tabular-nums text-bone-dim">{fmtNum(v.committed)}</Td>
      <Td className="text-right tabular-nums text-sky-700">{fmtNum(v.incoming)}</Td>
      <Td className="text-right tabular-nums text-bone-dim">{fmtNum(v.on_hand)}</Td>
      <Td className="text-right tabular-nums text-bone-dim">
        {v.reorder_point > 0 || v.target_stock > 0 ? `${v.reorder_point}/${v.target_stock}` : '—'}
      </Td>
      <Td><StatusPill v={v} /></Td>
      <Td className="text-right whitespace-nowrap">
        <div className="relative inline-flex items-center justify-end gap-1">
          <button onClick={onMatrix} title="Product matrix" className="text-grey hover:text-bone p-1" aria-label="Product matrix">
            <Layers size={14} strokeWidth={1.8} />
          </button>
          <button
            onClick={onMenuToggle}
            title="Actions"
            aria-label="Actions"
            className="text-grey hover:text-bone p-1"
          >
            <MoreVertical size={14} strokeWidth={1.8} />
          </button>
        </div>
      </Td>
    </tr>
  );
}

/* ---- Mobile card ---- */

function MobileVariantCard({
  v,
  thumb,
  onOpen,
  onAdjust,
}: {
  v: VariantInventory;
  thumb: string | null;
  onOpen: () => void;
  onAdjust: () => void;
}) {
  const s = stockStatus(v);
  return (
    <div className="bg-white border border-line rounded-xl shadow-sm overflow-hidden">
      <button onClick={onOpen} className="w-full text-left p-3.5">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-md border border-line bg-paper-2 shrink-0 overflow-hidden flex items-center justify-center">
            {thumb ? (
              <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <span className="text-[9px] uppercase tracking-wide-2 text-grey">DS</span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold text-bone truncate text-sm">{v.product_name}</p>
              <Chip label={STOCK_STATUS_LABEL[s]} cls={STOCK_STATUS_CLS[s]} />
            </div>
            <p className="text-[11px] text-grey truncate">{v.product_code}</p>
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-bone-dim">
              {v.color_hex && (
                <span className="w-2.5 h-2.5 rounded-full border border-line shrink-0" style={{ backgroundColor: v.color_hex }} />
              )}
              <span>{v.color_name}</span>
              <Chip label={v.size_label} cls="bg-paper-3 text-bone-dim" />
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-wide-2 text-grey">Available</p>
            <p className="font-price text-base tabular-nums">{fmtNum(v.available)}</p>
          </div>
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-wide-2 text-grey">Committed</p>
            <p className="text-base tabular-nums text-bone-dim">{fmtNum(v.committed)}</p>
          </div>
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-wide-2 text-grey">Incoming</p>
            <p className="text-base tabular-nums text-sky-700">{fmtNum(v.incoming)}</p>
          </div>
        </div>
      </button>
      <div className="px-3.5 pb-3.5 flex items-center gap-2">
        <Btn onClick={onAdjust} className="flex-1 justify-center text-bone-dim border border-line hover:text-bone" variant="ghost">
          <Plus size={13} /> Adjust stock
        </Btn>
        <button onClick={onOpen} className="p-2 text-grey hover:text-bone" aria-label="Details">
          <MoreVertical size={15} />
        </button>
      </div>
    </div>
  );
}

/* ---- Skeletons ---- */

function TableSkeleton() {
  return (
    <div className="bg-white border border-line rounded-xl overflow-hidden shadow-sm">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4 border-t border-line first:border-t-0 animate-pulse">
          <div className="h-8 w-8 rounded bg-paper-3" />
          <div className="h-9 w-9 rounded-md bg-paper-3" />
          <div className="flex-1">
            <div className="h-3 w-2/5 bg-paper-3 rounded" />
            <div className="mt-1.5 h-2 w-1/4 bg-paper-3 rounded" />
          </div>
          <div className="h-3 w-20 bg-paper-3 rounded" />
          <div className="h-3 w-12 bg-paper-3 rounded" />
          <div className="h-6 w-16 bg-paper-3 rounded" />
        </div>
      ))}
    </div>
  );
}

function MobileSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="bg-white border border-line rounded-xl shadow-sm p-3.5 space-y-3 animate-pulse">
          <div className="flex gap-3">
            <div className="h-10 w-10 rounded-md bg-paper-3" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 bg-paper-3 rounded" />
              <div className="h-2 w-1/3 bg-paper-3 rounded" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} className="h-8 rounded bg-paper-3" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Adjust stock modal ---- */

function AdjustModal({
  variant,
  onDone,
  onClose,
}: {
  variant: VariantInventory;
  onDone: (res: { previous: number; new: number }) => Promise<void> | void;
  onClose: () => void;
}) {
  const [sign, setSign] = useState<'add' | 'sub'>('add');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState(ADJUSTMENT_REASONS[3]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ previous: number; new: number } | null>(null);

  const qty = Number(delta.replace(/\D/g, '') || 0);
  const next = variant.available + (sign === 'add' ? qty : -qty);

  const submit = async () => {
    if (qty === 0) {
      setErr('Enter a non-zero quantity.');
      return;
    }
    const d = sign === 'add' ? qty : -qty;
    if (next < 0) {
      setErr(`Cannot go below 0 — only ${variant.available} available.`);
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await adjustVariantStock({
        productId: variant.product_id,
        colorId: variant.color_id,
        sizeLabel: variant.size_label,
        delta: d,
        reason,
        note: note.trim() || undefined,
      });
      setResult({ previous: res.previous, new: res.new });
      setDelta('');
      setNote('');
      await onDone({ previous: res.previous, new: res.new });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not adjust stock.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-2xl border border-line shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">Adjust stock</h3>
          <button onClick={onClose} aria-label="Close" className="text-grey hover:text-bone"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <p className="font-semibold text-bone">{variant.product_name}</p>
            <p className="text-xs text-bone-dim mt-0.5">
              {variant.color_name} · {variant.size_label} · {variant.product_code}
            </p>
          </div>

          <div className="flex items-end justify-between border border-line rounded-lg px-4 py-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Current available</span>
            <span className="font-price text-2xl tabular-nums text-bone">{fmtNum(variant.available)}</span>
          </div>

          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Adjustment</label>
            <div className="mt-1 flex items-center gap-2">
              <div className="flex border border-line rounded-lg overflow-hidden">
                <button
                  onClick={() => setSign('add')}
                  className={`inline-flex items-center gap-1 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide-2 transition-colors ${
                    sign === 'add' ? 'bg-green-600/10 text-green-700' : 'text-grey hover:text-bone'
                  }`}
                >
                  <Plus size={13} /> Add
                </button>
                <button
                  onClick={() => setSign('sub')}
                  className={`inline-flex items-center gap-1 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide-2 border-l border-line transition-colors ${
                    sign === 'sub' ? 'bg-crimson/10 text-crimson' : 'text-grey hover:text-bone'
                  }`}
                >
                  <Minus size={13} /> Remove
                </button>
              </div>
              <input
                value={delta}
                onChange={(e) => setDelta(e.target.value.replace(/\D/g, '').slice(0, 5))}
                inputMode="numeric"
                placeholder="0"
                autoFocus
                className="flex-1 border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded-lg focus:border-bone focus:outline-none font-price tabular-nums"
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-bone-dim">
            <span>New available</span>
            <span className="font-price text-base tabular-nums text-bone">
              {fmtNum(variant.available)} → {fmtNum(next < 0 ? variant.available : next)}
            </span>
          </div>

          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Reason</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full border border-line bg-white px-3 py-2.5 text-sm text-bone rounded-lg focus:border-bone focus:outline-none">
              {ADJUSTMENT_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Note <span className="normal-case text-grey/70">(optional)</span></label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Short context for the movement log" className="mt-1 w-full border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded-lg focus:border-bone focus:outline-none" />
          </div>

          {err && <div className="bg-crimson/5 border border-crimson/20 text-crimson text-xs px-3 py-2 rounded-lg">{err}</div>}
          {result && (
            <div className="bg-green-50 border border-green-200 text-green-700 text-xs px-3 py-2 rounded-lg">
              Saved — available is now <b>{fmtNum(result.new)}</b> (was {fmtNum(result.previous)}).
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Adjust stock'}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ---- Reorder levels modal (single + bulk) ---- */

function ReorderModal({
  variants,
  onDone,
  onClose,
}: {
  variants: VariantInventory[];
  onDone: () => Promise<void> | void;
  onClose: () => void;
}) {
  const first = variants[0];
  const [point, setPoint] = useState(first ? String(Math.max(0, first.reorder_point)) : '');
  const [target, setTarget] = useState(first ? String(Math.max(0, first.target_stock)) : '');
  const [min, setMin] = useState(first ? String(Math.max(0, first.min_stock)) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  const rp = Number(point || 0);
  const ts = Number(target || 0);
  const suggested = first ? Math.max(0, ts - first.available - (first.incoming ?? 0)) : 0;

  const submit = async () => {
    if (variants.length === 0) return;
    setBusy(true);
    setErr('');
    try {
      if (variants.length === 1) {
        await setVariantReorder({
          productId: variants[0].product_id,
          colorId: variants[0].color_id,
          sizeLabel: variants[0].size_label,
          reorderPoint: rp,
          targetStock: ts,
          minStock: min ? Number(min) : 0,
        });
      } else {
        await bulkSetVariantReorder(
          variants.map((v) => ({
            productId: v.product_id,
            colorId: v.color_id,
            sizeLabel: v.size_label,
            reorderPoint: rp,
            targetStock: ts,
            minStock: min ? Number(min) : 0,
          })),
        );
      }
      setSaved(true);
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not set reorder levels.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-2xl border border-line shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">
            {variants.length === 1 ? 'Stock levels' : `Stock levels (${variants.length} selected)`}
          </h3>
          <button onClick={onClose} aria-label="Close" className="text-grey hover:text-bone"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          {variants.length > 1 ? (
            <p className="text-xs text-grey">
              Applies to {variants.length} variants: {variants.slice(0, 3).map((v) => `${v.product_name} · ${v.size_label}`).join(', ')}
              {variants.length > 3 ? ` +${variants.length - 3} more` : ''}
            </p>
          ) : (
            <p className="text-xs text-bone-dim">
              {first?.product_name} · <span className="text-grey">{first?.color_name} · {first?.size_label}</span>
            </p>
          )}

          {first && (
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'Available', value: fmtNum(first.available), tone: 'text-bone' },
                { label: 'Incoming', value: fmtNum(first.incoming), tone: 'text-sky-700' },
                { label: 'Suggested', value: `+${fmtNum(suggested)}`, tone: 'text-green-700' },
              ].map((s) => (
                <div key={s.label} className="border border-line rounded-lg px-2 py-2.5">
                  <p className="text-[9px] font-semibold uppercase tracking-wide-2 text-grey">{s.label}</p>
                  <p className={`mt-0.5 font-price text-base tabular-nums ${s.tone}`}>{s.value}</p>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-grey -mt-2">
            Suggested = target stock − available − incoming. Shown for the first selected variant; informational only.
          </p>

          {[
            { label: 'Reorder point', value: point, set: setPoint, hint: 'When available drops to this, the variant reads as low stock.' },
            { label: 'Target stock', value: target, set: setTarget, hint: 'Quantity to aim for during replenishment.' },
            { label: 'Minimum stock', value: min, set: setMin, hint: 'Hard floor for buying decisions.' },
          ].map((f) => (
            <div key={f.label}>
              <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">{f.label}</label>
              <input
                value={f.value}
                onChange={(e) => f.set(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                className="mt-1 w-full border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded-lg focus:border-bone focus:outline-none tabular-nums"
              />
              <p className="mt-0.5 text-[11px] text-grey">{f.hint}</p>
            </div>
          ))}

          {err && <div className="bg-crimson/5 border border-crimson/20 text-crimson text-xs px-3 py-2 rounded-lg">{err}</div>}
          {saved && <div className="bg-green-50 border border-green-200 text-green-700 text-xs px-3 py-2 rounded-lg">Stock levels saved.</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save levels'}</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---- Variant detail drawer ---- */

function StockStat({ label, value, tone = '' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="border border-line rounded-lg px-3 py-2.5">
      <p className="text-[9px] font-semibold uppercase tracking-wide-2 text-grey">{label}</p>
      <p className={`mt-0.5 font-price text-lg leading-none tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function VariantDetail({
  variant,
  onClose,
  onAdjust,
  onReorder,
}: {
  variant: VariantInventory;
  onClose: () => void;
  onAdjust: (v: VariantInventory) => void;
  onReorder: (v: VariantInventory) => void;
}) {
  const [rows, setRows] = useState<StockMovement[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState('');

  const load = useCallback(async (off: number) => {
    setErr('');
    try {
      const res = await fetchStockMovements({
        productId: variant.product_id,
        colorId: variant.color_id,
        size: variant.size_label,
        offset: off,
        limit: 20,
      });
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      setRows([]);
      setErr(e instanceof Error ? e.message : 'Could not load movements.');
    }
  }, [variant.product_id, variant.color_id, variant.size_label]);

  useEffect(() => {
    setRows(null);
    load(0);
  }, [load]);

  const suggested = Math.max(0, variant.target_stock - variant.available - (variant.incoming ?? 0));

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-[640px] bg-white border-l border-line shadow-xl flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line sticky top-0 bg-white z-10">
          <div className="min-w-0">
            <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase truncate">{variant.product_name}</h3>
            <p className="text-[11px] text-grey mt-0.5">
              {variant.product_code} · <span className="inline-flex items-center gap-1">{variant.color_name} · {variant.size_label}</span>
            </p>
            <span className="mt-2 inline-block font-mono text-[10px] text-grey">{variant.variant_id}</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-grey hover:text-bone shrink-0"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          <section>
            <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-bone pb-2 border-b border-line">Current stock</p>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              <StockStat label="Available" value={fmtNum(variant.available)} tone={variant.available <= 0 ? 'text-crimson' : 'text-bone'} />
              <StockStat label="Committed" value={fmtNum(variant.committed)} tone="text-bone" />
              <StockStat label="Incoming" value={fmtNum(variant.incoming)} tone="text-sky-700" />
              <StockStat label="On hand" value={fmtNum(variant.on_hand)} tone="text-bone" />
              <StockStat label="Damaged" value={fmtNum(variant.damaged)} tone="text-bone-dim" />
              <StockStat label="Unavailable" value={fmtNum(variant.unavailable)} tone="text-bone-dim" />
              <StockStat label="Reserved" value={fmtNum(variant.reserved)} tone="text-bone-dim" />
            </div>
          </section>

          <section>
            <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-bone pb-2 border-b border-line">Replenishment</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <StockStat label="Reorder point" value={fmtNum(variant.reorder_point)} />
              <StockStat label="Target stock" value={fmtNum(variant.target_stock)} />
              <StockStat label="Min stock" value={fmtNum(variant.min_stock)} />
            </div>
            {variant.target_stock > 0 && (
              <p className="mt-2 text-[11px] text-grey">
                Suggested replenishment: <b className="text-green-700">+{fmtNum(suggested)} units</b> (target − available − incoming).
              </p>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between pb-2 border-b border-line">
              <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-bone">Movement history</p>
              <p className="text-[10px] text-grey tabular-nums">{fmtNum(total)} movements</p>
            </div>

            {err && <div className="mt-3"><ErrorBox message={err} /></div>}

            {rows === null ? (
              <div className="min-h-[24vh] flex items-center justify-center"><LoadingDots /></div>
            ) : rows.length === 0 ? (
              <EmptyState title="No movements" sub="Adjustments, receipts and checkout movements will appear here." />
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px]">
                  <thead>
                    <tr>
                      <Th className="px-2">Date</Th>
                      <Th className="px-2">Type</Th>
                      <Th className="px-2 text-right">Change</Th>
                      <Th className="px-2 text-right">Before → after</Th>
                      <Th className="px-2">Reason</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id} className="border-t border-line">
                        <Td className="px-2 text-xs text-grey whitespace-nowrap">{formatOpsDate(m.created_at)}</Td>
                        <Td className="px-2"><Chip label={m.movement_type} cls={MOVEMENT_TYPE_CLS[m.movement_type] ?? 'bg-paper-3 text-bone-dim'} /></Td>
                        <Td className={`px-2 text-right font-price tabular-nums ${Number(m.quantity) >= 0 ? 'text-green-700' : 'text-crimson'}`}>
                          {Number(m.quantity) >= 0 ? '+' : ''}{fmtNum(m.quantity)}
                        </Td>
                        <Td className="px-2 text-right tabular-nums text-grey whitespace-nowrap">{fmtNum(m.previous_stock)} → {fmtNum(m.new_stock)}</Td>
                        <Td className="px-2 text-bone-dim text-xs">{m.reason ?? '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {total > (rows.length || 0) && (
                  <button onClick={() => load(offset + 20)} className="mt-2 text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone">
                    Load more
                  </button>
                )}
              </div>
            )}
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line bg-white">
          <Btn variant="ghost" onClick={() => onReorder(variant)}>
            <SlidersHorizontal size={13} /> Set levels
          </Btn>
          <Btn onClick={() => onAdjust(variant)}>
            <Plus size={13} /> Adjust stock
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ---- Product matrix (colour × size) ---- */

function ProductDetail({
  productId,
  onClose,
}: {
  productId: string;
  onClose: () => void;
}) {
  const [ws, setWs] = useState<ProductOpsWorkspace | null>(null);
  const [err, setErr] = useState('');
  const [adjust, setAdjust] = useState<VariantInventory | null>(null);
  const [reorder, setReorder] = useState<VariantInventory[]>([]);

  const load = useCallback(async () => {
    setErr('');
    try {
      setWs(await fetchProductOpsWorkspace(productId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the product.');
    }
  }, [productId]);

  useEffect(() => {
    load();
  }, [load]);

  const sizes = useMemo(() => sortSizeLabels([...new Set(ws?.sizes ?? [])]), [ws]);

  const cell = (colorId: string, sizeLabel: string): ProductOpsWorkspace['variants'][number] | undefined =>
    ws?.variants.find((v) => v.color_id === colorId && v.size_label === sizeLabel);

  const committedFor = (colorId: string, sizeLabel: string) => ws?.committedByVariant[variantMatrixKey(colorId, sizeLabel)] ?? 0;

  const toVariant = (v: ProductOpsWorkspace['variants'][number], color: { id: string; name: string; hex: string }): VariantInventory => {
    const committed = committedFor(color.id, v.size_label);
    return {
      product_id: v.product_id,
      product_name: ws?.name ?? '',
      product_code: ws?.code ?? '',
      category: '',
      color_id: v.color_id,
      color_name: color.name,
      color_hex: color.hex,
      size_label: v.size_label,
      variant_id: v.id,
      available: v.stock,
      committed,
      on_hand: (v.stock || 0) + committed + (v.unavailable || 0) + (v.damaged || 0) + (v.reserved || 0),
      incoming: v.incoming,
      unavailable: v.unavailable,
      damaged: v.damaged,
      reserved: v.reserved,
      reorder_point: v.reorder_point,
      target_stock: v.target_stock,
      min_stock: v.min_stock,
      in_stock: v.stock > 0,
      low_stock: v.stock > 0 && v.reorder_point > 0 && v.stock <= v.reorder_point,
      out_of_stock: v.stock <= 0,
      value: v.stock * (ws?.price ?? 0),
      published: true,
      retail_visible: true,
      updated_at: v.updated_at,
      created_at: v.updated_at,
    };
  };

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-start justify-center overflow-y-auto p-3 sm:p-6" onClick={onClose}>
      <div className="bg-white w-full max-w-4xl rounded-2xl border border-line shadow-xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-white z-10 rounded-t-2xl">
          <div>
            <h3 className="font-display text-lg sm:text-xl tracking-wide-2 text-bone uppercase">{ws ? ws.name : 'Product'}</h3>
            <p className="text-[11px] text-grey mt-0.5">{ws ? `${ws.code} · ${inr(ws.price)}` : ''}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-grey hover:text-bone"><X size={18} /></button>
        </div>

        {err && <div className="p-5"><ErrorBox message={err} /></div>}

        {!ws && !err && (
          <div className="min-h-[40vh] flex items-center justify-center"><LoadingDots /></div>
        )}

        {ws && (
          <div className="overflow-x-auto">
            <div className="min-w-[720px] p-5 pt-0">
              <div className="pt-4 flex items-center gap-4 flex-wrap text-[11px] text-grey">
                <span><span className="w-2 h-2 inline-block rounded-full bg-paper-3 align-middle mr-1" />cell colour = availability state only</span>
                <span><b className="text-bone">Avail</b> — sellable</span>
                <span><b className="text-bone">c</b> — committed</span>
                <span className="text-sky-700"><b>in</b> — incoming</span>
                <span className="ml-auto"><button onClick={load} className="inline-flex items-center gap-1 text-bone-dim hover:text-bone uppercase tracking-wide-2 font-semibold"><RefreshCw size={12} /> Refresh</button></span>
              </div>

              <table className="w-full mt-4">
                <thead>
                  <tr>
                    <Th>Colour</Th>
                    {sizes.map((s) => (
                      <Th key={s} className="text-center font-semibold">{s}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ws.colors.map((color) => (
                    <tr key={color.id} className="border-t border-line align-top">
                      <Td className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          {color.hex && <span className="w-3.5 h-3.5 rounded-full border border-line" style={{ backgroundColor: color.hex }} />}
                          <span className="font-medium text-bone">{color.name}</span>
                        </span>
                      </Td>
                      {sizes.map((s) => {
                        const v = cell(color.id, s);
                        if (!v) {
                          return (
                            <Td key={s} className="text-center text-grey">—</Td>
                          );
                        }
                        const status = stockStatus({ available: v.stock, reorder_point: v.reorder_point });
                        const tone = status === 'out' ? 'text-crimson' : status === 'low' ? 'text-amber-700' : 'text-bone';
                        return (
                          <Td key={s} className="text-center min-w-[118px]">
                            <div className="inline-block text-left space-y-0.5">
                              <p className={`flex items-baseline gap-1.5 font-price text-base leading-none tabular-nums ${tone}`}>
                                <span className="w-2 h-2 rounded-full self-center shrink-0" style={{ backgroundColor: status === 'out' ? 'var(--color-crimson)' : status === 'low' ? '#d97706' : 'var(--color-paper-3)' }} />
                                {fmtNum(v.stock)}
                              </p>
                              <p className="text-[10px] text-grey tabular-nums">c {fmtNum(committedFor(color.id, s))} · in {fmtNum(v.incoming)}</p>
                              <p className="text-[10px] text-grey tabular-nums">ro {v.reorder_point} | t {v.target_stock}</p>
                              <div className="pt-1 flex gap-1">
                                <Btn onClick={() => setAdjust(toVariant(v, color))} className="px-2 py-1">
                                  Adjust
                                </Btn>
                                <Btn variant="ghost" onClick={() => setReorder([toVariant(v, color)])} className="px-2 py-1">
                                  Levels
                                </Btn>
                              </div>
                            </div>
                          </Td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {adjust && <AdjustModal variant={adjust} onClose={() => setAdjust(null)} onDone={() => load()} />}
      {reorder.length > 0 && <ReorderModal variants={reorder} onClose={() => setReorder([])} onDone={() => load()} />}
    </div>
  );
}

/* ---- Global movements log ---- */

function MovementsView() {
  const [rows, setRows] = useState<StockMovement[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [type, setType] = useState('ALL');
  const [err, setErr] = useState('');

  const load = useCallback(async (t: string, off: number) => {
    setErr('');
    try {
      const res = await fetchStockMovements({ type: t, offset: off, limit: PAGE_SIZE });
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      setRows([]);
      setErr(e instanceof Error ? e.message : 'Could not load movements.');
    }
  }, []);

  useEffect(() => {
    load(type, offset);
  }, [type, offset, load]);

  const types = ['ALL', 'SALE', 'RESERVATION', 'RELEASE', 'RECEIPT', 'ADJUSTMENT', 'DAMAGE', 'RETURN', 'CANCELLATION', 'PRODUCTION', 'TRANSFER', 'CORRECTION', 'REJECTED'];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <select value={type} onChange={(e) => { setOffset(0); setType(e.target.value); }} className="border border-line bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wide-2 text-bone-dim rounded-lg">
          {types.map((t) => (
            <option key={t} value={t}>{t === 'ALL' ? 'All types' : t}</option>
          ))}
        </select>
        <p className="text-[11px] text-grey">{fmtNum(total)} movements</p>
      </div>

      {err && <ErrorBox message={err} />}

      {rows === null ? (
        <div className="min-h-[20vh] flex items-center justify-center"><LoadingDots /></div>
      ) : rows.length === 0 ? (
        <EmptyState title="No movements" sub="Adjustments, receipts and checkout movements will appear here." />
      ) : (
        <div className="bg-white border border-line rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead className="bg-paper-2">
                <tr>
                  <Th>Type</Th>
                  <Th>Product</Th>
                  <Th>Colour · Size</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Avail before → after</Th>
                  <Th>Reason</Th>
                  <Th>Source</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-t border-line">
                    <Td><Chip label={m.movement_type} cls={MOVEMENT_TYPE_CLS[m.movement_type] ?? 'bg-paper-3 text-bone-dim'} /></Td>
                    <Td><span className="text-bone font-medium">{m.product_name}</span></Td>
                    <Td className="text-bone-dim whitespace-nowrap">{m.color_name} · {m.size_label}</Td>
                    <Td className={`text-right font-price tabular-nums ${Number(m.quantity) >= 0 ? 'text-green-700' : 'text-crimson'}`}>
                      {Number(m.quantity) >= 0 ? '+' : ''}{fmtNum(m.quantity)}
                    </Td>
                    <Td className="text-right tabular-nums text-grey">{fmtNum(m.previous_stock)} → {fmtNum(m.new_stock)}</Td>
                    <Td className="text-bone-dim">{m.reason ?? '—'}</Td>
                    <Td className="text-grey text-xs whitespace-nowrap">
                      {m.source_type}
                      {m.source_id ? ` · ${String(m.source_id).slice(0, 12)}` : ''}
                    </Td>
                    <Td className="text-grey text-xs whitespace-nowrap">{formatOpsDate(m.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Pager offset={offset} total={total} pageSize={PAGE_SIZE} onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))} onNext={() => setOffset(offset + PAGE_SIZE)} />
    </div>
  );
}

function Pager({ offset, total, pageSize, onPrev, onNext }: { offset: number; total: number; pageSize: number; onPrev: () => void; onNext: () => void }) {
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[11px] text-grey">
        {fmtNum(Math.min(total, offset + 1))}–{fmtNum(Math.min(total, offset + pageSize))} of {fmtNum(total)}
      </p>
      <div className="flex items-center gap-1">
        <button onClick={onPrev} disabled={offset === 0} className="p-2 border border-line rounded-lg text-bone-dim hover:text-bone disabled:opacity-40 transition-colors">
          <ChevronLeft size={15} />
        </button>
        <span className="px-2 text-xs text-grey tabular-nums">{page}/{pages}</span>
        <button onClick={onNext} disabled={offset + pageSize >= total} className="p-2 border border-line rounded-lg text-bone-dim hover:text-bone disabled:opacity-40 transition-colors">
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

/* ---- Main section ---- */

const selectCls = 'border border-line bg-white px-2.5 py-2 text-xs font-semibold uppercase tracking-wide-2 text-bone-dim rounded-lg focus:border-bone focus:outline-none';

export function InventorySection() {
  const [rows, setRows] = useState<VariantInventory[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StockFilter>('all');
  const [category, setCategory] = useState('all');
  const [colorId, setColorId] = useState('all');
  const [size, setSize] = useState('all');
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kpis, setKpis] = useState<InventoryKpis | null>(null);
  const [kpiErr, setKpiErr] = useState('');
  const [filters, setFilters] = useState<InventoryFilters | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const [detail, setDetail] = useState<VariantInventory | null>(null);
  const [adjust, setAdjust] = useState<VariantInventory | null>(null);
  const [reorder, setReorder] = useState<VariantInventory[]>([]);
  const [matrixProductId, setMatrixProductId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuRect, setMenuRect] = useState<{ top: number; right: number } | null>(null);
  const [movementLog, setMovementLog] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await fetchInventory({
        search,
        stockStatus: status === 'incoming' ? 'all' : status,
        incomingOnly: status === 'incoming',
        collection: category === 'all' ? undefined : category,
        colorId: colorId === 'all' ? undefined : colorId,
        size: size === 'all' ? undefined : size,
        sortBy,
        sortDir,
        offset,
        limit: PAGE_SIZE,
      });
      setRows(res.rows);
      setTotal(res.total);
      setSelected(new Set());
    } catch (e) {
      setRows([]);
      setErr(e instanceof Error ? e.message : 'Could not load inventory.');
    }
  }, [search, status, category, colorId, size, sortBy, sortDir, offset]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadKpis = useCallback(async () => {
    setKpiErr('');
    try {
      setKpis(await fetchInventoryKpis());
    } catch (e) {
      setKpis(null);
      setKpiErr(e instanceof Error ? e.message : 'Could not load inventory KPIs.');
    }
  }, []);

  useEffect(() => {
    loadKpis();
  }, [loadKpis]);

  useEffect(() => {
    fetchInventoryFilters().then(setFilters).catch(() => setFilters(null));
  }, []);

  useEffect(() => {
    const ids = Array.from(new Set((rows ?? []).map((r) => r.color_id)));
    if (ids.length === 0) {
      setThumbs({});
      return;
    }
    let live = true;
    fetchVariantThumbs(ids).then((t) => {
      if (live) setThumbs(t);
    });
    return () => {
      live = false;
    };
  }, [rows]);

  const refresh = useCallback(() => {
    load();
    loadKpis();
  }, [load, loadKpis]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedVariants = useMemo(
    () => (rows ?? []).filter((r) => selected.has(r.variant_id)),
    [rows, selected],
  );

  const pickStatus = (s: StockFilter) => {
    setStatus(s);
    setOffset(0);
  };

  const closeMenu = useCallback(() => {
    setMenuFor(null);
    setMenuRect(null);
  }, []);

  const openMenu = useCallback((id: string, e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenuRect({ top: r.bottom + 4, right: window.innerWidth - r.right });
    setMenuFor(id);
  }, []);

  const handleAdjusted = useCallback(
    (res: { previous: number; new: number }) => {
      const target = adjust;
      if (target) {
        const upd: VariantInventory = {
          ...target,
          available: res.new,
          in_stock: res.new > 0,
          out_of_stock: res.new <= 0,
          low_stock: res.new > 0 && target.reorder_point > 0 && res.new <= target.reorder_point,
        };
        setRows((prev) => (prev ? prev.map((r) => (r.variant_id === upd.variant_id ? upd : r)) : prev));
        if (detail && detail.variant_id === upd.variant_id) setDetail(upd);
      }
      refresh();
    },
    [adjust, detail, refresh],
  );

  const handleSavedLevels = useCallback(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-display text-lg sm:text-2xl tracking-wide-2 text-bone uppercase">Inventory</h2>
          <p className="text-xs sm:text-sm text-grey mt-0.5">Monitor stock, variants, movements and replenishment.</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedVariants.length > 0 ? (
            <Btn
              onClick={() => {
                if (selectedVariants.length === 1) setAdjust(selectedVariants[0]);
                else setReorder(selectedVariants);
              }}
            >
              <SlidersHorizontal size={13} />
              {selectedVariants.length === 1 ? 'Adjust stock' : `Set reorder (${selectedVariants.length})`}
            </Btn>
          ) : (
            <Btn variant="ghost" onClick={() => setMovementLog(true)}>
              <History size={13} /> Movements
            </Btn>
          )}
          <Btn variant="ghost" onClick={refresh}>
            <RefreshCw size={13} /> Refresh
          </Btn>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
        {kpis ? (
          <>
            <Kpi label="Total variants" value={fmtNum(kpis.total)} />
            <Kpi label="Available units" value={kpis.availableUnits != null ? fmtNum(kpis.availableUnits) : '—'} />
            <Kpi label="Incoming" value={kpis.incomingUnits != null ? fmtNum(kpis.incomingUnits) : '—'} />
            <Kpi label="Low stock" value={fmtNum(kpis.lowStock)} tone="warn" active={status === 'low'} onClick={() => pickStatus(status === 'low' ? 'all' : 'low')} />
            <Kpi label="Out of stock" value={fmtNum(kpis.outOfStock)} tone="bad" active={status === 'out'} onClick={() => pickStatus(status === 'out' ? 'all' : 'out')} />
          </>
        ) : (
          Array.from({ length: 5 }).map((_, i) => <KpiSkeleton key={i} />)
        )}
      </div>
      {kpiErr && <ErrorBox message={kpiErr} />}

      {/* Inventory health */}
      <div className="bg-white border border-line rounded-xl shadow-sm px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mr-1">Inventory health</p>
        <HealthItem label="Out of stock" n={kpis ? fmtNum(kpis.outOfStock) : '—'} dot="bg-crimson" active={status === 'out'} onClick={() => pickStatus(status === 'out' ? 'all' : 'out')} />
        <HealthItem label="Low stock" n={kpis ? fmtNum(kpis.lowStock) : '—'} dot="bg-amber-500" active={status === 'low'} onClick={() => pickStatus(status === 'low' ? 'all' : 'low')} />
        <HealthItem label="Incoming" n={kpis ? fmtNum(kpis.incomingVariants) : '—'} dot="bg-sky-500" active={status === 'incoming'} onClick={() => pickStatus(status === 'incoming' ? 'all' : 'incoming')} />
        <HealthItem label="Healthy" n={kpis ? fmtNum(kpis.healthy) : '—'} dot="bg-green-600" active={status === 'all' && search === '' && category === 'all' && colorId === 'all' && size === 'all'} onClick={() => { setStatus('all'); setCategory('all'); setColorId('all'); setSize('all'); setSearchInput(''); setSearch(''); setOffset(0); }} />
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-line rounded-xl shadow-sm p-3 flex flex-col lg:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-grey" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search product, code or variant…"
            className="w-full border border-line bg-paper-2 pl-8 pr-8 py-2 text-sm text-bone rounded-lg focus:border-bone focus:outline-none"
          />
          {searchInput && (
            <button
              onClick={() => { setSearchInput(''); setSearch(''); setOffset(0); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-grey hover:text-bone"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={status} onChange={(e) => pickStatus(e.target.value as StockFilter)} className={selectCls} aria-label="Status">
            <option value="all">All status</option>
            <option value="in">In stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
            <option value="incoming">Incoming</option>
          </select>
          <select value={category} onChange={(e) => { setCategory(e.target.value); setOffset(0); }} className={selectCls} aria-label="Product">
            <option value="all">All products</option>
            {(filters?.categories ?? []).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select value={colorId} onChange={(e) => { setColorId(e.target.value); setOffset(0); }} className={selectCls} aria-label="Colour">
            <option value="all">All colours</option>
            {(filters?.colors ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select value={size} onChange={(e) => { setSize(e.target.value); setOffset(0); }} className={selectCls} aria-label="Size">
            <option value="all">All sizes</option>
            {(filters?.sizes ?? []).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={`${sortBy}:${sortDir}`}
            onChange={(e) => {
              const [by, dir] = e.target.value.split(':');
              setSortBy(by as SortKey);
              setSortDir((dir as 'asc' | 'desc') ?? 'asc');
              setOffset(0);
            }}
            className={selectCls}
            aria-label="Sort"
          >
            <option value="name:asc">Name ↑</option>
            <option value="name:desc">Name ↓</option>
            <option value="available:desc">Available ↓</option>
            <option value="available:asc">Available ↑</option>
            <option value="on_hand:desc">On hand ↓</option>
            <option value="value:desc">Value ↓</option>
            <option value="updated_at:desc">Recently updated</option>
          </select>
        </div>
      </div>

      {/* Toolbar meta */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-grey">
          Inventory · <b className="text-bone tabular-nums">{fmtNum(total)}</b> variants
        </p>
        {selected.size > 0 && (
          <div className="flex items-center gap-3 text-xs text-bone-dim">
            <span>
              <b className="text-bone tabular-nums">{selected.size}</b> selected
            </span>
            {selected.size > 1 && (
              <Btn variant="ghost" onClick={() => setReorder(selectedVariants)} className="px-2.5 py-1">
                <SlidersHorizontal size={12} /> Set reorder
              </Btn>
            )}
            <button onClick={() => setSelected(new Set())} className="text-grey underline underline-offset-2 hover:text-bone">
              Clear
            </button>
          </div>
        )}
      </div>

      {err && (
        <div className="space-y-3">
          <ErrorBox message={err} />
          <Btn variant="ghost" onClick={refresh}>
            <RefreshCw size={13} /> Retry
          </Btn>
        </div>
      )}

      {!err && rows === null && (
        <>
          <div className="hidden lg:block"><TableSkeleton /></div>
          <div className="lg:hidden"><MobileSkeleton /></div>
        </>
      )}

      {!err && rows !== null && rows.length === 0 && (
        <EmptyState title="No inventory variants found" sub="Try removing filters, or adjust a variant to appear here." />
      )}

      {!err && rows !== null && rows.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden lg:block bg-white border border-line rounded-xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px]">
                <thead className="bg-paper-2">
                  <tr>
                    <Th className="px-3">
                      <span className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={rows.length > 0 && selected.size === rows.length}
                          onChange={() =>
                            setSelected(
                              selected.size === rows.length
                                ? new Set()
                                : new Set(rows.map((r) => r.variant_id)),
                            )
                          }
                          className="w-4 h-4 accent-bone"
                          aria-label="Select page"
                        />
                        <span className="inline-flex items-center gap-0.5"><ArrowDownUp size={11} /> {fmtNum(total)}</span>
                      </span>
                    </Th>
                    <Th>Product</Th>
                    <Th>Variant</Th>
                    <Th>SKU</Th>
                    <Th className="text-right">Available</Th>
                    <Th className="text-right">Committed</Th>
                    <Th className="text-right">Incoming</Th>
                    <Th className="text-right">On hand</Th>
                    <Th className="text-right">Reorder</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <VariantRow
                      key={v.variant_id}
                      v={v}
                      selected={selected.has(v.variant_id)}
                      thumb={thumbs[v.color_id] ?? null}
                      onToggle={() => toggle(v.variant_id)}
                      onOpen={() => setDetail(v)}
                      onMatrix={() => setMatrixProductId(v.product_id)}
                      onMenuToggle={(e) => openMenu(v.variant_id, e)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-2.5">
            {rows.map((v) => (
              <MobileVariantCard
                key={v.variant_id}
                v={v}
                thumb={thumbs[v.color_id] ?? null}
                onOpen={() => setDetail(v)}
                onAdjust={() => setAdjust(v)}
              />
            ))}
          </div>

          <Pager
            offset={offset}
            total={total}
            pageSize={PAGE_SIZE}
            onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            onNext={() => setOffset(offset + PAGE_SIZE)}
          />
        </>
      )}

      {/* Row action menu (fixed-position so the table overflow does not clip it) */}
      {menuFor && rows && (() => {
        const mv = rows.find((r) => r.variant_id === menuFor);
        if (!mv) return null;
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={closeMenu} />
            <div
              className="fixed z-50 w-48 bg-white border border-line rounded-lg shadow-xl py-1"
              style={{ top: menuRect?.top ?? 0, right: menuRect?.right ?? 0 }}
            >
              <MenuRow icon={<Plus size={13} />} label="Adjust stock" onClick={() => { closeMenu(); setAdjust(mv); }} />
              <MenuRow icon={<SlidersHorizontal size={13} />} label="Set reorder levels" onClick={() => { closeMenu(); setReorder([mv]); }} />
              <MenuRow icon={<History size={13} />} label="Movement history" onClick={() => { closeMenu(); setDetail(mv); }} />
            </div>
          </>
        );
      })()}

      {/* Overlays */}
      {adjust && (
        <AdjustModal
          variant={adjust}
          onClose={() => setAdjust(null)}
          onDone={handleAdjusted}
        />
      )}
      {reorder.length > 0 && (
        <ReorderModal variants={reorder} onClose={() => setReorder([])} onDone={handleSavedLevels} />
      )}
      {detail && (
        <VariantDetail
          variant={detail}
          onClose={() => setDetail(null)}
          onAdjust={(v) => setAdjust(v)}
          onReorder={(v) => setReorder([v])}
        />
      )}
      {matrixProductId && (
        <ProductDetail productId={matrixProductId} onClose={() => setMatrixProductId(null)} />
      )}
      {movementLog && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-3 sm:p-6 overflow-y-auto" onClick={() => setMovementLog(false)}>
          <div className="bg-white w-full max-w-5xl rounded-2xl border border-line shadow-xl my-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-white z-10 rounded-t-2xl">
              <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">Stock movements</h3>
              <button onClick={() => setMovementLog(false)} aria-label="Close" className="text-grey hover:text-bone"><X size={18} /></button>
            </div>
            <div className="p-4 sm:p-5">
              <MovementsView />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
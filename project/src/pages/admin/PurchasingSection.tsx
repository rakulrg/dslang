import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Trash2, Pencil, X } from 'lucide-react';
import {
  fetchPurchaseOrders,
  fetchPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  receivePurchaseOrder,
  fetchSuppliers,
  upsertSupplier,
  deleteSupplier,
  fetchPurchasingCatalog,
  inr,
  formatOpsDateOnly,
  PO_STATUS_CLS,
} from '@/lib/ops';
import type { PurchaseOrder, PurchaseOrderItem, Supplier } from '@/lib/types';
import { LoadingDots } from '@/components/LoadingDots';
import { Chip, ErrorBox, Td, Th, Btn, EmptyState, fmtNum } from '@/pages/admin/OpsUi';

interface LineDraft {
  key: number;
  productId: string;
  colorId: string;
  sizeLabel: string;
  label: string;
  qty: string;
  unitCost: string;
}

function emptyLine(): LineDraft {
  return { key: Date.now() + Math.random(), productId: '', colorId: '', sizeLabel: '', label: '', qty: '10', unitCost: '' };
}

/* ---- Create PO modal ---- */

function CreatePoModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof fetchPurchasingCatalog>>>([]);
  const [supplierId, setSupplierId] = useState('');
  const [status, setStatus] = useState<'DRAFT' | 'ORDERED'>('DRAFT');
  const [expected, setExpected] = useState('');
  const [destination, setDestination] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ po_number: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, c] = await Promise.all([fetchSuppliers(), fetchPurchasingCatalog()]);
        setSuppliers(s);
        setCatalog(c);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not load purchasing data.');
      }
    })();
  }, []);

  const updateLine = (key: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const products = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of catalog) {
      if (!map.has(c.product_id)) map.set(c.product_id, `${c.name} · ${c.code}`);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [catalog]);

  const variantsFor = (productId: string) => catalog.filter((c) => c.product_id === productId);

  const setProduct = (line: LineDraft, productId: string) => {
    const vs = variantsFor(productId);
    const pick = vs.find((v) => v.color_id && v.size_label);
    updateLine(line.key, {
      productId,
      colorId: pick ? pick.color_id : '',
      sizeLabel: pick ? pick.size_label : '',
      label: pick ? `${pick.color} · ${pick.size_label}` : '',
      unitCost: pick ? String(pick.price) : line.unitCost,
    });
  };

  const setVariant = (line: LineDraft, colorId: string, sizeLabel: string) => {
    const pick = catalog.find((c) => c.product_id === line.productId && c.color_id === colorId && c.size_label === sizeLabel);
    updateLine(line.key, {
      colorId,
      sizeLabel,
      label: pick ? `${pick.color} · ${pick.size_label}` : '',
      unitCost: pick && !line.unitCost ? String(pick.price) : line.unitCost,
    });
  };

  const submit = async () => {
    const items = lines
      .map((l) => ({
        productId: l.productId,
        colorId: l.colorId,
        sizeLabel: l.sizeLabel,
        quantity: Number(l.qty || 0),
        unitCost: Number(l.unitCost || 0),
      }))
      .filter((l) => l.productId && l.quantity > 0);
    if (items.length === 0) {
      setErr('Add at least one line with a quantity.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await createPurchaseOrder({
        supplierId: supplierId || null,
        items,
        expectedDate: expected || null,
        destination: destination || undefined,
        paymentTerms: paymentTerms || undefined,
        notes: notes || undefined,
        status,
      });
      setCreated({ po_number: res.po_number });
      await onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the purchase order.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-start justify-center overflow-y-auto p-3 sm:p-6" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl rounded border border-line shadow-lg my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-white z-10">
          <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">New purchase order</h3>
          <button onClick={onClose} className="text-grey hover:text-bone"><X size={18} /></button>
        </div>

        {created ? (
          <div className="p-8 text-center">
            <p className="font-label text-2xl uppercase tracking-wide-2 text-bone">Purchase order created</p>
            <p className="mt-2 text-sm text-grey">{created.po_number}</p>
            <Btn className="mt-6" onClick={onClose}>Close</Btn>
          </div>
        ) : (
          <div className="p-5 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Supplier</label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="mt-1 w-full border border-line bg-white px-3 py-2.5 text-sm text-bone rounded focus:border-bone focus:outline-none">
                  <option value="">— none (draft) —</option>
                  {suppliers?.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Create as</label>
                <div className="mt-1 flex gap-2">
                  {(['DRAFT', 'ORDERED'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatus(s)}
                      className={`flex-1 text-[10px] uppercase tracking-wide-2 font-semibold px-3 py-2.5 rounded border transition-colors ${
                        status === s ? 'bg-bone text-white border-bone' : 'border-line text-bone-dim hover:border-bone'
                      }`}
                    >
                      {s === 'DRAFT' ? 'Draft' : 'Order now'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Expected date</label>
                <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} className="mt-1 w-full border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded focus:border-bone focus:outline-none" />
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Destination</label>
                <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g. warehouse" className="mt-1 w-full border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded focus:border-bone focus:outline-none" />
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Payment terms</label>
                <input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="e.g. 50% advance" className="mt-1 w-full border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded focus:border-bone focus:outline-none" />
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey">Notes</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded focus:border-bone focus:outline-none" />
              </div>
            </div>

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide-2 text-grey mb-2">Line items</p>
              <div className="space-y-3">
                {lines.map((line) => (
                  <div key={line.key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                    <div className="sm:col-span-5">
                      <select value={line.productId} onChange={(e) => setProduct(line, e.target.value)} className="w-full border border-line bg-white px-3 py-2 text-sm text-bone rounded">
                        <option value="">Select product…</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-4">
                      <select
                        value={line.colorId && line.sizeLabel ? `${line.colorId}|${line.sizeLabel}` : ''}
                        onChange={(e) => {
                          const [cid, sz] = e.target.value.split('|');
                          setVariant(line, cid, sz);
                        }}
                        disabled={!line.productId}
                        className="w-full border border-line bg-white px-3 py-2 text-sm text-bone rounded disabled:opacity-50"
                      >
                        <option value="">Colour · size…</option>
                        {variantsFor(line.productId).map((v) => (
                          <option key={`${v.color_id}|${v.size_label}`} value={`${v.color_id}|${v.size_label}`}>
                            {v.color} · {v.size_label} (in {v.available}{v.incoming ? `/inc ${v.incoming}` : ''})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-1">
                      <input
                        value={line.qty}
                        onChange={(e) => updateLine(line.key, { qty: e.target.value.replace(/\D/g, '') })}
                        inputMode="numeric"
                        placeholder="Qty"
                        className="w-full border border-line bg-paper-2 px-3 py-2 text-sm text-bone rounded tabular-nums"
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <input
                        value={line.unitCost}
                        onChange={(e) => updateLine(line.key, { unitCost: e.target.value.replace(/[^\d.]/g, '') })}
                        inputMode="decimal"
                        placeholder="Cost"
                        className="w-full border border-line bg-paper-2 px-3 py-2 text-sm text-bone rounded tabular-nums"
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <button
                        onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                        disabled={lines.length === 1}
                        className="p-2 text-grey hover:text-crimson disabled:opacity-40 transition-colors"
                        aria-label="Remove line"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <Btn variant="ghost" className="mt-2" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
                <Plus size={13} /> Add line
              </Btn>
            </div>

            {err && <ErrorBox message={err} />}

            <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn onClick={submit} disabled={busy}>
                {busy ? 'Creating…' : status === 'ORDERED' ? 'Create & order' : 'Save draft'}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- PO detail with receiving ---- */

function PoDetailModal({
  po,
  onClose,
  onChanged,
}: {
  po: PurchaseOrder;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<PurchaseOrderItem[] | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [draft, setDraft] = useState<Record<string, { received: string; rejected: string; reason: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await fetchPurchaseOrder(po.id);
      if (res) {
        setItems(res.items);
        setReceiving(po.status === 'ORDERED' || po.status === 'PARTIALLY_RECEIVED');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the purchase order.');
    }
  }, [po.id, po.status]);

  useEffect(() => { load(); }, [load]);

  const transition = async (to: 'DRAFT' | 'ORDERED' | 'CANCELLED') => {
    setBusy(true);
    setErr('');
    try {
      const res = await updatePurchaseOrderStatus(po.id, to);
      setMsg(to === 'ORDERED' ? `PO ${res.status} — incoming committed.` : to === 'CANCELLED' ? `PO cancelled${res.released_incoming ? ' — incoming released.' : '.'}` : `PO back to ${res.status}.`);
      await onChanged();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update the purchase order.');
    } finally {
      setBusy(false);
    }
  };

  const receive = async () => {
    setBusy(true);
    setErr('');
    const lines = (items ?? [])
      .map((it) => {
        const d = draft[it.id];
        return {
          itemId: it.id,
          received: Number(d?.received || 0),
          rejected: Number(d?.rejected || 0),
          reason: d?.reason || undefined,
        } as const;
      })
      .filter((l) => l.received > 0 || l.rejected > 0);
    if (lines.length === 0) {
      setErr('Enter received or rejected quantities for at least one line.');
      setBusy(false);
      return;
    }
    try {
      const res = await receivePurchaseOrder(po.id, lines);
      setMsg(`Received ${res.received} units, rejected ${res.rejected} — status ${res.status}.`);
      await onChanged();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not receive the purchase order.');
    } finally {
      setBusy(false);
    }
  };

  const outstanding = (it: PurchaseOrderItem) => it.quantity_ordered - it.quantity_received - it.quantity_rejected;

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-start justify-center overflow-y-auto p-3 sm:p-6" onClick={onClose}>
      <div className="bg-white w-full max-w-4xl rounded border border-line shadow-lg my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-white z-10">
          <div>
            <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">{po.po_number}</h3>
            <p className="text-[11px] text-grey">{po.supplier_name ?? 'No supplier'} · {formatOpsDateOnly(po.created_date)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Chip label={po.status} cls={PO_STATUS_CLS[po.status]} />
            <button onClick={onClose} className="text-grey hover:text-bone"><X size={18} /></button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {err && <ErrorBox message={err} />}
          {msg && <div className="bg-green-50 border border-green-200 text-green-700 text-xs px-3 py-2 rounded">{msg}</div>}

          {items === null ? (
            <div className="min-h-[20vh] flex items-center justify-center"><LoadingDots /></div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-xs text-grey">
                  Total <span className="text-bone font-semibold">{inr(po.total_cost)}</span>
                  {po.payment_terms ? ` · ${po.payment_terms}` : ''}
                  {po.destination ? ` · ${po.destination}` : ''}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {po.status === 'DRAFT' && (
                    <>
                      <Btn variant="ghost" onClick={() => transition('CANCELLED')} disabled={busy}>Cancel</Btn>
                      <Btn onClick={() => transition('ORDERED')} disabled={busy}>Confirm order</Btn>
                    </>
                  )}
                  {(po.status === 'ORDERED' || po.status === 'PARTIALLY_RECEIVED') && (
                    <Btn variant="ghost" onClick={() => transition('CANCELLED')} disabled={busy}>Cancel PO</Btn>
                  )}
                  {receiving && (
                    <Btn onClick={receive} disabled={busy}>
                      {busy ? 'Saving…' : 'Receive checked-in units'}
                    </Btn>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead className="bg-paper-2">
                    <tr>
                      <Th>Product</Th>
                      <Th className="text-right">Ordered</Th>
                      <Th className="text-right">Received</Th>
                      <Th className="text-right">Rejected</Th>
                      <Th className="text-right">Outstanding</Th>
                      <Th className="text-right">Unit cost</Th>
                      <Th className="text-right">Line total</Th>
                      {receiving && <Th className="text-right">Receive now</Th>}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const d = draft[it.id] ?? { received: '', rejected: '', reason: '' };
                      const out = outstanding(it);
                      return (
                        <tr key={it.id} className="border-t border-line">
                          <Td>
                            <span className="font-medium text-bone">{it.product_name}</span>
                            <span className="block text-[11px] text-grey">{it.color_name} · {it.size_label}</span>
                          </Td>
                          <Td className="text-right tabular-nums">{fmtNum(it.quantity_ordered)}</Td>
                          <Td className="text-right tabular-nums text-green-700">{fmtNum(it.quantity_received)}</Td>
                          <Td className="text-right tabular-nums text-crimson">{fmtNum(it.quantity_rejected)}</Td>
                          <Td className={`text-right tabular-nums ${out > 0 ? 'text-amber-700 font-semibold' : 'text-grey'}`}>{fmtNum(out)}</Td>
                          <Td className="text-right tabular-nums text-grey">{inr(it.unit_cost)}</Td>
                          <Td className="text-right tabular-nums">{inr(it.total_cost)}</Td>
                          {receiving && (
                            <Td>
                              <div className="flex items-center gap-1.5 justify-end">
                                <input
                                  value={d.received}
                                  onChange={(e) => setDraft((prev) => ({ ...prev, [it.id]: { ...prev[it.id] ?? { rejected: '', reason: '' }, received: e.target.value.replace(/\D/g, '') } }))}
                                  placeholder="recv"
                                  inputMode="numeric"
                                  max={String(out)}
                                  className="w-14 border border-line bg-paper-2 px-2 py-1.5 text-sm text-bone rounded tabular-nums"
                                />
                                <input
                                  value={d.rejected}
                                  onChange={(e) => setDraft((prev) => ({ ...prev, [it.id]: { ...prev[it.id] ?? { received: '', reason: '' }, rejected: e.target.value.replace(/\D/g, '') } }))}
                                  placeholder="rej"
                                  inputMode="numeric"
                                  className="w-12 border border-line bg-paper-2 px-2 py-1.5 text-sm text-crimson rounded tabular-nums"
                                />
                              </div>
                              <input
                                value={d.reason}
                                onChange={(e) => setDraft((prev) => ({ ...prev, [it.id]: { ...prev[it.id] ?? { received: '', rejected: '' }, reason: e.target.value } }))}
                                placeholder="reject reason"
                                className="mt-1 w-full border border-line bg-paper-2 px-2 py-1 text-xs text-bone rounded"
                              />
                            </Td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {receiving && (
                <p className="text-[11px] text-grey">
                  Received units become sellable stock (+RECEIPT movement). Rejected units never touch stock (REJECTED movement).
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- Suppliers ---- */

function SupplierModal({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    name: supplier?.name ?? '',
    contactPerson: supplier?.contact_person ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    paymentTerms: supplier?.payment_terms ?? '',
    leadTimeDays: supplier?.lead_time_days != null ? String(supplier.lead_time_days) : '',
    notes: supplier?.notes ?? '',
    active: supplier?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const patch = (p: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...p }));

  const submit = async () => {
    if (!form.name.trim()) {
      setErr('Supplier name is required.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await upsertSupplier(supplier?.id ?? null, {
        name: form.name,
        contactPerson: form.contactPerson,
        phone: form.phone,
        email: form.email,
        address: form.address,
        paymentTerms: form.paymentTerms,
        leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : undefined,
        notes: form.notes,
        active: form.active,
      });
      await onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the supplier.');
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'mt-1 w-full border border-line bg-paper-2 px-3 py-2.5 text-sm text-bone rounded focus:border-bone focus:outline-none';
  const FieldCls = 'text-[10px] font-semibold uppercase tracking-wide-2 text-grey';

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-lg rounded border border-line shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <h3 className="font-display text-lg tracking-wide-2 text-bone uppercase">{supplier ? 'Edit supplier' : 'New supplier'}</h3>
          <button onClick={onClose} className="text-grey hover:text-bone"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className={FieldCls}>Name</label>
            <input value={form.name} onChange={(e) => patch({ name: e.target.value })} className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={FieldCls}>Contact person</label>
              <input value={form.contactPerson} onChange={(e) => patch({ contactPerson: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={FieldCls}>Phone</label>
              <input value={form.phone} onChange={(e) => patch({ phone: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={FieldCls}>Email</label>
              <input value={form.email} onChange={(e) => patch({ email: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={FieldCls}>Lead time (days)</label>
              <input value={form.leadTimeDays} onChange={(e) => patch({ leadTimeDays: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className={inputCls} />
            </div>
          </div>
          <div>
            <label className={FieldCls}>Address</label>
            <textarea value={form.address} onChange={(e) => patch({ address: e.target.value })} rows={2} className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={FieldCls}>Payment terms</label>
              <input value={form.paymentTerms} onChange={(e) => patch({ paymentTerms: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={FieldCls}>Notes</label>
              <input value={form.notes} onChange={(e) => patch({ notes: e.target.value })} className={inputCls} />
            </div>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.active} onChange={(e) => patch({ active: e.target.checked })} className="w-4 h-4 accent-bone" />
            <span className="text-sm text-bone-dim">Active supplier</span>
          </label>
          {err && <ErrorBox message={err} />}
          <button onClick={submit} disabled={busy} className="w-full inline-flex items-center justify-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-3 rounded hover:bg-ink transition-colors disabled:opacity-50">
            {busy ? 'Saving…' : 'Save supplier'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- Main section ---- */

export function PurchasingSection() {
  const [view, setView] = useState<'pos' | 'suppliers'>('pos');
  const [pos, setPos] = useState<PurchaseOrder[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [err, setErr] = useState('');
  const [openPo, setOpenPo] = useState<PurchaseOrder | null>(null);
  const [creating, setCreating] = useState(false);
  const [supplierModal, setSupplierModal] = useState<Supplier | null | 'new'>(null);

  const loadPos = useCallback(async () => {
    setErr('');
    try {
      setPos(await fetchPurchaseOrders());
    } catch (e) {
      setPos([]);
      setErr(e instanceof Error ? e.message : 'Could not load purchase orders.');
    }
  }, []);

  const loadSuppliers = useCallback(async () => {
    setErr('');
    try {
      setSuppliers(await fetchSuppliers());
    } catch (e) {
      setSuppliers([]);
      setErr(e instanceof Error ? e.message : 'Could not load suppliers.');
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadPos(), loadSuppliers()]);
  }, [loadPos, loadSuppliers]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const removeSupplier = async (s: Supplier) => {
    if (!window.confirm(`Delete supplier “${s.name}”? Purchase orders keep a reference.`)) return;
    setErr('');
    try {
      await deleteSupplier(s.id);
      await loadSuppliers();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete the supplier.');
    }
  };

  const tabs = [
    { value: 'pos', label: 'Purchase orders' },
    { value: 'suppliers', label: 'Suppliers' },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center gap-1 bg-paper-3 border border-line rounded-full p-1">
          {tabs.map((t) => (
            <button
              key={t.value}
              onClick={() => setView(t.value)}
              className={`px-3 py-1.5 text-[10px] uppercase tracking-wide-2 font-semibold rounded-full transition-colors ${
                view === t.value ? 'bg-bone text-white' : 'text-bone-dim hover:text-bone'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {view === 'pos' && (
            <Btn onClick={() => setCreating(true)}>
              <Plus size={13} /> New PO
            </Btn>
          )}
          {view === 'suppliers' && (
            <Btn onClick={() => setSupplierModal('new')}>
              <Plus size={13} /> New supplier
            </Btn>
          )}
          <Btn onClick={loadAll}><RefreshCw size={13} /> Refresh</Btn>
        </div>
      </div>

      {err && <ErrorBox message={err} />}

      {view === 'pos' ? (
        pos === null ? (
          <div className="min-h-[40vh] flex items-center justify-center"><LoadingDots /></div>
        ) : pos.length === 0 ? (
          <EmptyState title="No purchase orders" sub="Create a draft and confirm it once the supplier is finalised." />
        ) : (
          <div className="bg-white border border-line rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px]">
                <thead className="bg-paper-2">
                  <tr>
                    <Th>#</Th>
                    <Th>Supplier</Th>
                    <Th>Status</Th>
                    <Th>Created</Th>
                    <Th>Expected</Th>
                    <Th className="text-right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {pos.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => setOpenPo(p)}
                      className="border-t border-line cursor-pointer hover:bg-paper-2/60 transition-colors"
                    >
                      <Td className="font-semibold text-bone">{p.po_number}</Td>
                      <Td className="text-bone-dim">{p.supplier_name ?? '—'}</Td>
                      <Td><Chip label={p.status} cls={PO_STATUS_CLS[p.status]} /></Td>
                      <Td className="text-grey text-xs whitespace-nowrap">{formatOpsDateOnly(p.created_date)}</Td>
                      <Td className="text-grey text-xs whitespace-nowrap">{p.expected_date ? formatOpsDateOnly(p.expected_date) : '—'}</Td>
                      <Td className="text-right font-price tabular-nums">{inr(p.total_cost)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : suppliers === null ? (
        <div className="min-h-[40vh] flex items-center justify-center"><LoadingDots /></div>
      ) : suppliers.length === 0 ? (
        <EmptyState title="No suppliers" sub="Add your manufacturers and distributors." />
      ) : (
        <div className="bg-white border border-line rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="bg-paper-2">
                <tr>
                  <Th>Name</Th>
                  <Th>Contact</Th>
                  <Th>Phone · Email</Th>
                  <Th className="text-center">Lead time</Th>
                  <Th>Payment terms</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.id} className="border-t border-line">
                    <Td className="font-semibold text-bone">{s.name}</Td>
                    <Td className="text-bone-dim">{s.contact_person ?? '—'}</Td>
                    <Td className="text-grey text-xs">
                      {s.phone ?? ''}{s.phone && s.email ? ' · ' : ''}{s.email ?? ''}
                    </Td>
                    <Td className="text-center tabular-nums text-bone-dim">{s.lead_time_days != null ? `${s.lead_time_days} d` : '—'}</Td>
                    <Td className="text-bone-dim text-xs">{s.payment_terms ?? '—'}</Td>
                    <Td>{s.active ? <Chip label="Active" cls="bg-green-600/10 text-green-700" /> : <Chip label="Inactive" cls="bg-grey/15 text-grey" />}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setSupplierModal(s)} className="text-grey hover:text-bone p-1" aria-label="Edit supplier"><Pencil size={14} /></button>
                        <button onClick={() => removeSupplier(s)} className="text-grey hover:text-crimson p-1" aria-label="Delete supplier"><Trash2 size={14} /></button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating && <CreatePoModal onClose={() => setCreating(false)} onCreated={loadPos} />}
      {openPo && <PoDetailModal po={openPo} onClose={() => setOpenPo(null)} onChanged={loadPos} />}
      {supplierModal !== null &&
        (supplierModal === 'new' ? (
          <SupplierModal supplier={null} onClose={() => setSupplierModal(null)} onSaved={loadSuppliers} />
        ) : (
          <SupplierModal supplier={supplierModal} onClose={() => setSupplierModal(null)} onSaved={loadSuppliers} />
        ))}
    </div>
  );
}
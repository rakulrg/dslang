// Digital delivery note (admin print) — a clean, printable DSLANG DELIVERY
// sheet. Admin-only (route gated in App.tsx). Shows ONLY the fields needed to
// pack/label a parcel: brand, order ref, customer name/phone/complete address.
// No internal ids, no payment/shiprocket identifiers, no secrets.

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { linkHref } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';
import type { RetailOrder } from '@/lib/types';

export function PrintDeliveryPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<RetailOrder | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const { data, error: err } = await supabase
        .from('retail_orders')
        .select('*')
        .eq('id', orderId)
        .eq('order_type', 'retail')
        .maybeSingle();
      if (err) throw err;
      if (!data) throw new Error('Order not found.');
      setOrder(data as unknown as RetailOrder);
      setLoadState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this order.');
      setLoadState('error');
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadState === 'loading') {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-sm text-grey">
        Loading delivery details…
      </div>
    );
  }

  if (loadState === 'error' || !order) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-sm text-grey">{error || 'Could not load this order.'}</p>
          <a href={linkHref('/admin')} className="inline-block bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-2.5 rounded hover:bg-ink transition-colors">
            Back to admin
          </a>
        </div>
      </div>
    );
  }

  const c = order.customer ?? ({} as RetailOrder['customer']);
  const addressLines = [
    c.address,
    [c.city, c.state].filter(Boolean).join(', '),
    c.pincode,
    c.country && c.country !== 'India' ? c.country : null,
  ].filter(Boolean);
  const items = order.items ?? [];

  return (
    <div className="min-h-[70vh] flex flex-col items-start gap-6 p-4 sm:p-8">
      {/* On-screen controls — hidden when printing */}
      <div className="no-print flex items-center gap-3">
        <a href={linkHref('/admin')} className="text-[11px] uppercase tracking-wide-2 font-semibold text-bone-dim hover:text-bone transition-colors">
          ← Back to admin
        </a>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 bg-bone text-white text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-2.5 rounded hover:bg-ink transition-colors"
        >
          Print Delivery Details
        </button>
      </div>

      {/* The printable sheet — hidden everything else prints via CSS */}
      <div className="print-sheet w-full max-w-[600px] bg-white border border-line rounded-sm p-8 shadow-sm">
        <div className="flex items-start justify-between border-b-2 border-ink pb-4">
          <div>
            <p className="font-brand text-2xl tracking-[0.03em] text-ink">DSLANG</p>
            <p className="mt-1 text-[10px] uppercase tracking-[0.28em] text-grey">Delivery Note</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide-2 text-grey">Order No.</p>
            <p className="text-bone font-semibold tabular-nums">{order.ref}</p>
            <p className="mt-1 text-[10px] text-grey">{new Date(order.created_at).toLocaleDateString('en-IN')}</p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <p className="text-[10px] uppercase tracking-wide-2 text-grey mb-1">Ship To</p>
            <p className="font-semibold text-bone">{c.name}</p>
            {c.phone && <p className="mt-0.5 text-sm text-bone tabular-nums">{c.phone}</p>}
            <p className="mt-2 text-sm text-bone whitespace-pre-line">{addressLines.join('\n')}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-[10px] uppercase tracking-wide-2 text-grey mb-1">Items</p>
            <ul className="space-y-1">
              {items.map((it, i) => (
                <li key={i} className="text-sm text-bone">
                  {it.quantity}× {it.name} · {it.color} · {it.size_label}
                </li>
              ))}
            </ul>
            <p className="mt-3 pt-3 border-t border-line text-sm text-bone">
              Total: <span className="font-semibold tabular-nums">{formatPrice(order.total_amount ?? 0)}</span>
            </p>
          </div>
        </div>

        {(order.is_cod || order.amount_due_on_delivery) && (
          <div className="mt-6 border border-crimson/30 bg-crimson/5 px-3 py-2 rounded text-xs text-crimson">
            COD — collect <span className="font-semibold tabular-nums">{formatPrice(order.amount_due_on_delivery ?? 0)}</span> on delivery.
          </div>
        )}
      </div>

      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-sheet, .print-sheet * { visibility: visible; }
          .print-sheet {
            position: absolute; left: 0; top: 0; width: 100%;
            max-width: none; box-shadow: none; border: none;
          }
          .no-print { display: none !important; }
          @page { margin: 12mm; }
        }
      `}</style>
    </div>
  );
}

export default PrintDeliveryPage;
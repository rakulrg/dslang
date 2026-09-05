import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Package, Search, ShieldCheck, Truck, XCircle, RotateCcw, Clock } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useRouter } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';

/**
 * Track Order — a public, secure order look-up.
 *
 * DEPRECATED from reading retail_orders directly: orders are RLS-locked to
 * admins. Instead this calls the SECURITY DEFINER RPC `track_lookup_order`, which
 * requires the order ref AND the customer's 10-digit phone to match and returns
 * only safe fields (never the customer's personal data).
 */

interface TrackItem {
  name: string;
  code: string;
  color: string;
  size_label: string;
  quantity: number;
  line_total: number;
}

interface TrackedOrder {
  ref: string;
  order_status: string;
  payment_status: string;
  created_at: string;
  total_qty: number;
  subtotal: number;
  discount: number;
  shipping: number;
  total_amount: number;
  items: TrackItem[];
}

const STATUS_ORDER = ['pending', 'processing', 'shipped', 'delivered'] as const;

const STATUS_META: Record<string, { label: string; icon: typeof Clock }> = {
  pending: { label: 'Order Placed', icon: Clock },
  processing: { label: 'Processing', icon: Package },
  shipped: { label: 'Shipped', icon: Truck },
  delivered: { label: 'Delivered', icon: Check },
};

const TERMINAL_STATUSES = ['cancelled', 'refunded'];

export function TrackOrderPage({ refFromRoute }: { refFromRoute?: string }) {
  const { navigate } = useRouter();
  const initialRef = (refFromRoute ?? '').trim().toUpperCase();
  const [refInput, setRefInput] = useState(initialRef);
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [didLookup, setDidLookup] = useState(false);

  useEffect(() => {
    if (!refFromRoute) return;
    const r = refFromRoute.trim().toUpperCase();
    if (r) {
      setRefInput(r);
      // Pre-fill the phone so the customer only has to add their 10-digit number.
    }
  }, [refFromRoute]);

  const current = useMemo(() => {
    if (!order) return -1;
    const idx = STATUS_ORDER.indexOf(order.order_status as (typeof STATUS_ORDER)[number]);
    return idx === -1 ? -1 : idx;
  }, [order]);

  const isTerminal = !!order && TERMINAL_STATUSES.includes(order.order_status);

  const statusNote = useMemo(() => {
    if (!order) return '';
    if (order.payment_status === 'failed') {
      return 'Your payment did not complete and no amount was charged. Please try again or contact us.';
    }
    if (order.order_status === 'cancelled') return 'This order has been cancelled.';
    if (order.order_status === 'refunded') return 'This order has been refunded.';
    if (order.order_status === 'pending') return 'Your order is confirmed. We are reviewing it and will confirm dispatch on SMS.';
    if (order.order_status === 'processing') return 'Your order is being prepared for dispatch.';
    if (order.order_status === 'shipped') return 'Your order is on its way. You will receive delivery details on SMS.';
    if (order.order_status === 'delivered') return 'Your order has been delivered. Thank you for shopping with DSLANG.';
    return '';
  }, [order]);

  const handleLookup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const ref = refInput.trim().toUpperCase();
    const digits = phone.replace(/\D/g, '');
    if (!ref) return setError('Enter your order reference.');
    if (digits.length !== 10) return setError('Enter your 10-digit mobile number.');
    setLoading(true);
    setError('');
    setOrder(null);
    setDidLookup(false);
    try {
      const { data, error: rpcError } = await supabase.rpc('track_lookup_order', {
        p_ref: ref,
        p_phone: digits,
      });
      if (rpcError) throw rpcError;
      const res = data as { ok: boolean; reason?: string; order?: TrackedOrder };
      if (!res?.ok) {
        setError(res?.reason || 'We could not find that order.');
      } else if (res.order) {
        setOrder(res.order);
      } else {
        setError('We could not find that order.');
      }
    } catch {
      setError('Something went wrong while looking up your order. Please try again.');
    } finally {
      setLoading(false);
      setDidLookup(true);
    }
  };

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return iso;
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-6 md:px-12 lg:px-16 py-8 md:py-14">
      <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none">
        Track Order
      </h1>
      <p className="mt-3 text-sm text-grey leading-relaxed max-w-xl">
        Enter your order reference and the 10-digit mobile number you used at checkout to see the current status.
      </p>

      <form
        onSubmit={handleLookup}
        noValidate
        className="mt-7 grid grid-cols-1 sm:grid-cols-[1.2fr_1fr_auto] gap-3 items-end"
      >
        <label className="block">
          <span className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Order Reference</span>
          <input
            value={refInput}
            onChange={(e) => setRefInput(e.target.value.toUpperCase())}
            placeholder="e.g. DSL-R-ABCD1234"
            autoCapitalize="characters"
            spellCheck={false}
            className="mt-1.5 w-full border border-line bg-ink-2 px-3 py-3 text-sm text-bone placeholder:text-grey/60 focus:border-crimson focus:outline-none transition-colors"
          />
        </label>
        <label className="block">
          <span className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Mobile Number</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="10-digit number"
            inputMode="numeric"
            className="mt-1.5 w-full border border-line bg-ink-2 px-3 py-3 text-sm text-bone placeholder:text-grey/60 focus:border-crimson focus:outline-none transition-colors"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-[13px] hover:bg-crimson-dark transition-colors disabled:opacity-60"
        >
          {loading ? <Loader2 size={15} strokeWidth={2} className="animate-spin" /> : <Search size={15} strokeWidth={2} />}
          <span>{loading ? 'Checking…' : 'Track'}</span>
        </button>
      </form>

      {error && !loading && (
        <div className="mt-5 border border-crimson/20 bg-crimson/5 px-4 py-3 text-sm text-crimson">{error}</div>
      )}

      {!order && didLookup && !error && !loading && (
        <p className="mt-5 text-sm text-grey">No order matched that reference and number.</p>
      )}

      {order && (
        <div className="mt-8 border border-line bg-paper-3 p-5 md:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <div>
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Order</p>
              <p className="text-lg font-semibold text-bone mt-0.5">{order.ref}</p>
              <p className="text-xs text-grey mt-0.5">{fmtDate(order.created_at)}</p>
            </div>
            <div className="text-right">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Total</p>
              <p className="font-price text-lg font-bold text-crimson tabular-nums">{formatPrice(order.total_amount)}</p>
            </div>
          </div>

          {order.payment_status === 'failed' ? (
            <div className="mt-5 flex gap-3 border border-crimson/20 bg-crimson/5 px-4 py-3 text-sm text-crimson">
              <XCircle size={18} strokeWidth={1.8} className="shrink-0" /> {statusNote}
            </div>
          ) : isTerminal ? (
            <div className="mt-5 flex gap-3 border border-line bg-paper px-4 py-3 text-sm text-grey">
              <RotateCcw size={18} strokeWidth={1.8} className="shrink-0 text-crimson" /> {statusNote}
            </div>
          ) : (
            <div className="mt-6">
              <div className="flex flex-wrap gap-2">
                {STATUS_ORDER.map((s, i) => {
                  const meta = STATUS_META[s];
                  const Icon = meta.icon;
                  const reached = i <= current || i === 0;
                  const isCurrent = i === current;
                  return (
                    <div key={s} className="flex items-center gap-2">
                      <div
                        className={`inline-flex items-center gap-2 rounded px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold ${
                          reached ? 'bg-green-600/10 text-green-400' : 'bg-grey/10 text-grey'
                        }`}
                      >
                        <Icon size={14} strokeWidth={2} />
                        {meta.label}
                        {reached && <Check size={13} strokeWidth={2.5} />}
                      </div>
                      {i < STATUS_ORDER.length - 1 && <span className="text-grey/50">—</span>}
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-sm text-bone leading-relaxed">{statusNote}</p>
              <p className="mt-1 text-xs text-grey flex items-center gap-1.5">
                <ShieldCheck size={13} strokeWidth={1.8} />
                Payment {order.payment_status === 'success' ? 'confirmed' : order.payment_status}.
              </p>
            </div>
          )}

          {order.items.length > 0 && (
            <div className="mt-6 border-t border-line pt-4">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2">Your Products</p>
              <div className="divide-y divide-line">
                {order.items.map((it, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="text-bone">{it.name}</p>
                      <p className="text-[11px] text-grey">{it.color} · {it.size_label} × {it.quantity}</p>
                    </div>
                    <span className="text-bone font-medium whitespace-nowrap tabular-nums">{formatPrice(it.line_total)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm text-grey">
                <div className="flex justify-between"><span>Items ({order.total_qty})</span><span className="text-bone">{formatPrice(order.subtotal)}</span></div>
                {order.discount > 0 && (
                  <div className="flex justify-between"><span>Discount</span><span className="text-green-400">−{formatPrice(order.discount)}</span></div>
                )}
                <div className="flex justify-between"><span>Shipping</span><span className="text-bone">{order.shipping > 0 ? formatPrice(order.shipping) : 'FREE'}</span></div>
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-5">
            <button
              onClick={() => navigate('/contact')}
              className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3 hover:bg-crimson-dark transition-colors"
            >
              Need Help?
            </button>
            <button
              onClick={() => navigate('/collection')}
              className="inline-flex items-center gap-2 border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3 hover:bg-bone hover:text-paper transition-colors"
            >
              Continue Shopping
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
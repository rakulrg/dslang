import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Package, Search, ShieldCheck, Truck, XCircle, RotateCcw, Clock, ExternalLink } from 'lucide-react';
import { rpc } from '@/lib/rest';
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
  is_cod?: boolean;
  payment_discount?: number;
  amount_paid_upfront?: number;
  amount_due_on_delivery?: number;
  tracking_id?: string | null;
  tracking_url?: string | null;
  courier_name?: string | null;
  awb_number?: string | null;
  shipping_provider?: string | null;
  tracking_current_status?: string | null;
  tracking_location?: string | null;
  last_tracking_sync_at?: string | null;
  shiprocket_current_status?: string | null;
  shiprocket_location?: string | null;
  shiprocket_updated_at?: string | null;
  items: TrackItem[];
}

const STATUS_ORDER = ['confirmed', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered'] as const;

const STATUS_META: Record<string, { label: string; icon: typeof Clock }> = {
  confirmed: { label: 'Order Confirmed', icon: Check },
  processing: { label: 'Processing', icon: Package },
  packed: { label: 'Packed', icon: Package },
  shipped: { label: 'Shipped', icon: Truck },
  out_for_delivery: { label: 'Out for Delivery', icon: Truck },
  delivered: { label: 'Delivered', icon: Check },
};

const TERMINAL_STATUSES = ['cancelled', 'refunded', 'rto'];

export function TrackOrderPage({ refFromRoute }: { refFromRoute?: string }) {
  const { navigate } = useRouter();
  const initialRef = (refFromRoute ?? '').trim().toUpperCase();
  const [refInput, setRefInput] = useState(initialRef);
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [didLookup, setDidLookup] = useState(false);
  const refInputRef = useRef<HTMLInputElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);

  const focusField = (el: HTMLInputElement | null) => {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  };

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
    // Nothing is "confirmed" until the payment/advance is verified.
    if (order.payment_status !== 'success') return -1;
    const raw = (order.tracking_current_status ?? order.shiprocket_current_status ?? '').toUpperCase();
    if (order.order_status === 'delivered') return 5;
    if (raw.includes('DELIVERED')) return 5;
    if (
      raw.includes('OUT FOR DELIVERY') ||
      raw.includes('OUT_FOR_DELIVERY') ||
      raw.includes('ON THE WAY') ||
      raw.includes('OUTFOR')
    ) {
      return 4;
    }
    if (order.order_status === 'shipped' && raw) return 3; // picked up / in transit
    if (order.order_status === 'shipped') return 2; // packed, awaiting courier pickup
    if (order.order_status === 'processing') return 1;
    if (order.order_status === 'cod_partial_paid') return 0;
    if (order.order_status === 'pending') return 0; // paid but not yet processed
    return -1;
  }, [order]);

  const isTerminal = !!order && TERMINAL_STATUSES.includes(order.order_status);

  const statusNote = useMemo(() => {
    if (!order) return '';
    if (order.payment_status === 'failed') {
      return 'Your payment did not complete and no amount was charged. Please try again or contact us.';
    }
    if (order.order_status === 'cancelled') return 'This order has been cancelled.';
    if (order.order_status === 'refunded') return 'This order has been refunded.';
    if (order.order_status === 'rto') {
      return 'Your parcel could not be delivered and is being returned to us. We will contact you about the resolution.';
    }
    if (order.order_status === 'pending') {
      return order.payment_status === 'success'
        ? 'Your order is confirmed. We are reviewing it and will confirm dispatch.'
        : 'Your order is placed but payment is still being verified. It is not confirmed yet.';
    }
    if (order.order_status === 'cod_partial_paid') {
      return 'Your order is confirmed — the advance is received and the remaining amount will be collected from you at delivery.';
    }
    if (order.order_status === 'processing') return 'Your order is being prepared for dispatch.';
    if (order.order_status === 'shipped') return 'Your order is on its way. You can track delivery details below.';
    if (order.order_status === 'delivered') return 'Your order has been delivered. Thank you for shopping with DSLANG.';
    return '';
  }, [order]);

  const handleLookup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const ref = refInput.trim().toUpperCase();
    const digits = phone.replace(/\D/g, '');
    if (!ref) { setError('Enter your order reference.'); focusField(refInputRef.current); return; }
    if (digits.length !== 10) { setError('Enter your 10-digit mobile number.'); focusField(phoneInputRef.current); return; }
    setLoading(true);
    setError('');
    setOrder(null);
    setDidLookup(false);
    try {
      const data = await rpc<{ ok: boolean; reason?: string; order?: TrackedOrder }>('track_lookup_order', {
        p_ref: ref,
        p_phone: digits,
      });
      const res = data;
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
            ref={refInputRef}
            value={refInput}
            onChange={(e) => setRefInput(e.target.value.toUpperCase())}
            placeholder="e.g. DSL-R-ABCD1234"
            autoCapitalize="characters"
            spellCheck={false}
            className="mt-1.5 w-full border border-line bg-white px-3 py-3 text-sm text-bone placeholder:text-grey/60 focus:border-bone focus:outline-none transition-colors"
          />
        </label>
        <label className="block">
          <span className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Mobile Number</span>
          <input
            ref={phoneInputRef}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="10-digit number"
            inputMode="numeric"
            className="mt-1.5 w-full border border-line bg-white px-3 py-3 text-sm text-bone placeholder:text-grey/60 focus:border-bone focus:outline-none transition-colors"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="btn-primary text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-[13px] disabled:opacity-60"
        >
          {loading ? <Loader2 size={15} strokeWidth={2} className="animate-spin" /> : <Search size={15} strokeWidth={2} />}
          <span>{loading ? 'Checking…' : 'Track'}</span>
        </button>
      </form>

      {error && !loading && (
        <div className="mt-5 rounded-soft border border-line bg-paper-2 px-4 py-3 text-sm text-bone-dim">{error}</div>
      )}

      {!order && didLookup && !error && !loading && (
        <p className="mt-5 text-sm text-grey">No order matched that reference and number.</p>
      )}

      {order && (
        <div className="mt-8 panel p-5 md:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <div>
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Order</p>
              <p className="text-lg font-semibold text-bone mt-0.5">{order.ref}</p>
              <p className="text-xs text-grey mt-0.5">{fmtDate(order.created_at)}</p>
            </div>
            <div className="text-right">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey">Total</p>
              <p className="font-price text-lg font-bold text-bone tabular-nums">{formatPrice(order.total_amount)}</p>
            </div>
          </div>

          {order.payment_status === 'failed' ? (
            <div className="mt-5 flex gap-3 rounded-soft border border-line bg-paper-2 px-4 py-3 text-sm text-bone-dim">
              <XCircle size={18} strokeWidth={1.8} className="shrink-0" /> {statusNote}
            </div>
          ) : isTerminal ? (
            <div className="mt-5 flex gap-3 border border-line bg-paper px-4 py-3 text-sm text-grey">
              <RotateCcw size={18} strokeWidth={1.8} className="shrink-0 text-bone-dim" /> {statusNote}
            </div>
          ) : (
            <div className="mt-6">
              <div className="flex flex-wrap gap-2">
                {STATUS_ORDER.map((s, i) => {
                  const meta = STATUS_META[s];
                  const Icon = meta.icon;
                  const reached = i <= current;
                  return (
                    <div key={s} className="flex items-center gap-2">
                      <div
                        className={`inline-flex items-center gap-2 rounded px-3 py-2 text-[11px] uppercase tracking-wide-2 font-semibold ${
                          reached ? 'bg-green-600/10 text-green-700' : 'bg-grey/10 text-grey'
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
                {order.is_cod && order.payment_status === 'success' && (
                  <span className="font-medium text-bone">
                    (COD — {formatPrice(order.amount_paid_upfront ?? 0)} paid now · {formatPrice(order.amount_due_on_delivery ?? 0)} on delivery)
                  </span>
                )}
              </p>
              {order.is_cod && order.payment_status === 'success' && (
                <p className="mt-0.5 text-xs text-grey">
                  Keep {formatPrice(order.amount_due_on_delivery ?? 0)} ready for your delivery partner. If the parcel is returned or refused, the advance is kept as the restocking fee.
                </p>
              )}
            </div>
          )}

          {(order.order_status === 'shipped' || order.order_status === 'delivered' || order.order_status === 'rto') &&
            (order.tracking_id || order.tracking_url || order.awb_number || order.courier_name) && (
              <div className="mt-6 border border-line bg-paper px-4 py-3">
                <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2 flex items-center gap-1.5">
                  <Truck size={13} strokeWidth={1.8} /> Shipment Tracking
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  {order.courier_name && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wide-2 text-grey">Courier</p>
                      <p className="text-bone font-medium mt-0.5">{order.courier_name}</p>
                    </div>
                  )}
                  {(order.awb_number || order.tracking_id) && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wide-2 text-grey">AWB / Tracking Number</p>
                      <p className="text-bone font-medium mt-0.5 tabular-nums">{order.awb_number || order.tracking_id}</p>
                    </div>
                  )}
                  {(order.tracking_current_status || order.shiprocket_current_status) && (
                    <div className="sm:col-span-2">
                      <p className="text-[10px] uppercase tracking-wide-2 text-grey">Live Status</p>
                      <p className="text-bone font-medium mt-0.5 capitalize">
                        {order.tracking_current_status ?? order.shiprocket_current_status}
                        {order.tracking_location
                          ? ` · ${order.tracking_location}`
                          : order.shiprocket_location
                            ? ` · ${order.shiprocket_location}`
                            : ''}
                        {order.last_tracking_sync_at
                          ? ` · ${fmtDate(order.last_tracking_sync_at)}`
                          : order.shiprocket_updated_at
                            ? ` · ${fmtDate(order.shiprocket_updated_at)}`
                            : ''}
                      </p>
                    </div>
                  )}
                  {order.tracking_url && (
                    <div className="sm:col-span-2">
                      <a
                        href={order.tracking_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-bone underline underline-offset-2 hover:text-bone-dim"
                      >
                        {order.tracking_url.length > 48 ? `${order.tracking_url.slice(0, 48)}…` : order.tracking_url}
                        <ExternalLink size={12} />
                      </a>
                    </div>
                  )}
                </div>
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
                  <div className="flex justify-between"><span>Discount</span><span className="text-green-700">−{formatPrice(order.discount)}</span></div>
                )}
                <div className="flex justify-between"><span>Shipping</span><span className="text-bone">{order.shipping > 0 ? formatPrice(order.shipping) : 'FREE'}</span></div>
                {order.is_cod && order.payment_status === 'success' && (
                  <>
                    <div className="flex justify-between"><span>COD Advance</span><span className="text-green-700">{formatPrice(order.amount_paid_upfront ?? 0)}</span></div>
                    <div className="flex justify-between"><span>Pay at Delivery</span><span className="text-bone">{formatPrice(order.amount_due_on_delivery ?? 0)}</span></div>
                  </>
                )}
                {!order.is_cod && (order.payment_discount ?? 0) > 0 && (
                  <div className="flex justify-between"><span>Online Payment Discount</span><span className="text-green-700">−{formatPrice(order.payment_discount ?? 0)}</span></div>
                )}
                <div className="flex justify-between border-t border-line pt-1.5 font-semibold text-bone">
                  <span>{order.is_cod ? 'Total Order Value' : (order.payment_discount ?? 0) > 0 ? 'Online Payment Total' : 'Total'}</span>
                  <span>{formatPrice(order.is_cod || !(order.payment_discount ?? 0) ? order.total_amount : (order.total_amount - (order.payment_discount ?? 0)))}</span>
                </div>
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-5">
            <button
              onClick={() => navigate('/contact')}
              className="btn-soft btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-6 py-3"
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
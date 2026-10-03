import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Search, ShieldCheck, Truck, XCircle, RotateCcw, Clock, ExternalLink } from 'lucide-react';
import { rpc } from '@/lib/rest';
import { useRouter } from '@/lib/router';
import { formatPrice, type CatalogProduct } from '@/lib/catalog';
import { useOrderImages, imageForItem, type OrderImageIndex } from '@/lib/orderImages';
import { peekTrackHint, clearTrackHint } from '@/lib/trackHint';
import { peekCheckoutHistory } from '@/lib/trackHistory';
import {
  DELIVERED_NOTICE,
  NO_AWB_NOTICE,
  awbOf,
  hasAwb,
  shippingStatusLabel,
  shippingStatusMessage,
  shippingStatusOf,
  trackingLinkFor,
} from '@/lib/shipping';

/**
 * Track Order — a public, secure order look-up.
 *
 * DEPRECATED from reading retail_orders directly: orders are RLS-locked to
 * admins. Instead this calls the SECURITY DEFINER RPC `track_lookup_order`, which
 * requires the order ref AND the customer's 10-digit phone to match and returns
 * only safe fields (never the customer's personal data).
 *
 * SHIPPING STATE comes from `track_order_shipping`, the equally gated,
 * equally throttled shipping-only projection. It is asked for separately so the
 * main lookup's security-critical body never has to be rewritten, and its values
 * WIN over the main lookup's legacy shipping aliases: that projection still
 * coalesces a Shiprocket *location* into the courier-name slot, which would show a
 * customer a city where the courier name belongs. If the shipping RPC is not
 * available (the migration has not been applied yet) the page degrades to the
 * main lookup's values rather than breaking.
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
  shipping_status?: string | null;
  delivered_at?: string | null;
  shipped_at?: string | null;
  shiprocket_current_status?: string | null;
  shiprocket_location?: string | null;
  shiprocket_updated_at?: string | null;
  items: TrackItem[];
}

const TERMINAL_STATUSES = ['cancelled', 'refunded', 'rto'];

// ---------------------------------------------------------------------------
// 4-stage visual tracker (Order Placed -> Shipped -> Out for Delivery ->
// Delivered). The truck position is derived from the REAL shipment data already
// returned by track_lookup_order (shiprocket_current_status first, then the
// legacy tracking_current_status, then order_status as a fallback) — never a
// fake/random animation.
// ---------------------------------------------------------------------------
const TRACK_STAGES = [
  { label: 'Order Placed', icon: Check },
  { label: 'Shipped', icon: Truck },
  { label: 'Out for Delivery', icon: Truck },
  { label: 'Delivered', icon: Check },
] as const;

// Polling interval (auto-refresh without a page reload). 30s default; a `poll`
// seconds param in the hash is honoured for localhost testing only and clamped
// to [6, 120].
const POLL_DEFAULT_MS = 30_000;

function pollIntervalMs(): number {
  try {
    const qs = window.location.hash.replace(/^#/, '').split('?').slice(1).join('?');
    const secs = Number(new URLSearchParams(qs).get('poll') ?? 0);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(120, Math.max(6, Math.round(secs))) * 1000;
    }
  } catch {
    // fall through to default
  }
  return POLL_DEFAULT_MS;
}

// Shipment-scope terminal: stop the truck AND stop polling. Order-level
// terminals (rto / cancelled / refunded) stop polling too but let the existing
// banner explain the state.
function isShipmentTerminal(order: TrackedOrder): boolean {
  const s = (order.shiprocket_current_status ?? order.tracking_current_status ?? '').toUpperCase();
  return (
    /RTO|RETURN TO SHIPPER|RETURNED TO SHIPPER|REFUSED/.test(s) ||
    TERMINAL_STATUSES.includes(order.order_status) ||
    order.payment_status === 'failed'
  );
}

// 0..3 for the four visual stages; -1 when the order isn't placeable on the
// track yet (payment not confirmed / unknown status).
function visualStage(order: TrackedOrder): number {
  // A COD order is legitimately unsettled before delivery — its payment_status stays
  // 'cod_pending' until the agent collects cash. It must still render the normal
  // timeline, so COD is treated as a confirmed order rather than an unverified one.
  const cod = order.is_cod === true || order.payment_status === 'cod_pending';
  if (order.payment_status !== 'success' && !cod) return -1;
  if (isShipmentTerminal(order)) return 0;
  if (order.order_status === 'delivered') return 3;
  const s = (order.shiprocket_current_status ?? order.tracking_current_status ?? '').toUpperCase().trim();
  if (!s) {
    if (order.order_status === 'shipped') return 1;
    if (['pending', 'confirmed', 'processing'].includes(order.order_status)) return 0;
    return -1;
  }
  if (/\bDELIVERED\b/.test(s)) return 3;
  if (/OUT FOR DELIVERY|OUT_FOR_DELIVERY|OUTFOR|ON THE WAY|WITHDELIVERY|LAST ?MILE|UNDELIVERED|NOT DELIVERED/.test(s)) return 2;
  if (/IN TRANSIT|INTRANSIT|IN_TRANSIT|PICKED UP|PICKED|SHIPPED|DISPATCH|TRANSIT|MANIFEST|HUB|WAYBILL|AWB GENERATED|LABEL/.test(s)) return 1;
  if (/NEW|CREATED|BOOKED|PENDING|PROCESSING|PACKED|READY|PICKUP SCHEDULED|ORDER PLACED|ACCEPTED/.test(s)) return 0;
  return 0;
}

export function TrackOrderPage({ refFromRoute }: { refFromRoute?: string }) {
  const { navigate } = useRouter();
  const initialRef = (refFromRoute ?? '').trim().toUpperCase();
  const [refInput, setRefInput] = useState(initialRef);
  const [phone, setPhone] = useState('');

  // Decide whether to skip the manual form and auto-run the lookup:
  //   1. A right-after-checkout one-shot session hint (ref + phone) always wins
  //      for the same-session arrival (plain /track-order).
  //   2. Otherwise, when the arrival names a specific order (e.g. /track-order/
  //      REF) it auto-tracks ONLY if this browser's long-term checkout history
  //      contains that exact ref — a shared/unknown link never gets a guessed
  //      phone number.
  //   3. Otherwise the most recent order in this browser's checkout history
  //      (localStorage — survives tab/browser close) is auto-tracked.
  //   4. Nothing known -> the manual ref + phone form, exactly as before.
  // The lookup itself never changes: track_lookup_order still enforces the
  // server-side ref + 10-digit phone possession match, so this only ever skips
  // typing what this browser ALREADY knows from its own checkout.
  const [resolved] = useState(() => {
    const hint = peekTrackHint();
    const history = peekCheckoutHistory();
    if (initialRef) {
      if (hint?.ref === initialRef) return { ...hint, source: 'hint' as const };
      const matched = history.find((e) => e.ref === initialRef);
      if (matched) return { ref: matched.ref, phone: matched.phone, source: 'history' as const };
      return null;
    }
    if (hint) return { ...hint, source: 'hint' as const };
    if (history.length > 0) {
      const latest = history[0];
      return { ref: latest.ref, phone: latest.phone, source: 'history' as const };
    }
    return null;
  });
  const autoLookup = resolved !== null;
  const [loading, setLoading] = useState(() => resolved !== null);
  const [currentRef, setCurrentRef] = useState(() => resolved?.ref ?? '');
  const [error, setError] = useState('');
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [didLookup, setDidLookup] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [, setTick] = useState(0);
  // Public catalogue, loaded lazily and only to resolve product thumbnails.
  // `fetchProducts` is the shared cached loader every storefront surface already
  // uses, so this costs no extra request on a warm cache. A failure here must
  // never break order tracking, so it is swallowed and the rows simply render
  // the neutral fallback block. The resolver itself is shared app-wide — see
  // lib/orderImages.ts, which is the single place an order line gets a picture.
  const imageIndex = useOrderImages();
  const lookupStartedRef = useRef(false);
  const lastCredsRef = useRef({ ref: '', phone: '' });
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

  // The catalogue load that used to live here now runs inside `useOrderImages()`
  // (lib/orderImages.ts) so every order surface shares one loader and one index
  // shape. It is still off the critical path: the order renders immediately and
  // the thumbnails appear when the catalogue lands.

  useEffect(() => {
    if (!refFromRoute) return;
    const r = refFromRoute.trim().toUpperCase();
    if (r) {
      setRefInput(r);
      // Pre-fill the phone so the customer only has to add their 10-digit number.
    }
  }, [refFromRoute]);

  const isTerminal = !!order && TERMINAL_STATUSES.includes(order.order_status);

  /* Cash on Delivery is a single amount: nothing is charged online and the agent
     collects the order total on arrival. `amount_due_on_delivery` is read from the
     order row; for a full-COD order it equals total_amount, and for an older row it
     holds whatever balance that order genuinely has left to collect. */
  const codDue = order?.amount_due_on_delivery ?? order?.total_amount ?? 0;

  const statusNote = (() => {
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
      // COD is confirmed at placement — nothing is being verified, the amount is
      // simply due on delivery.
      if (order.is_cod || order.payment_status === 'cod_pending') {
        return `Your order is confirmed. ${formatPrice(codDue)} will be collected by the delivery agent on arrival.`;
      }
      return order.payment_status === 'success'
        ? 'Your order is confirmed. We are reviewing it and will confirm dispatch.'
        : 'Your order is placed but payment is still being verified. It is not confirmed yet.';
    }
    if (order.order_status === 'processing') return 'Your order is being prepared for dispatch.';
    if (order.order_status === 'shipped') return 'Your order is on its way. You can track delivery details below.';
    if (order.order_status === 'delivered') return 'Your order has been delivered. Thank you for shopping with DSLANG.';
    return '';
  })();

  // Shared lookup core used by BOTH the manual form AND the same-session auto
  // path. Validation never weakens: a 10-digit phone + ref are ALWAYS required
  // and the server still enforces the possession match in track_lookup_order.
  // With `silent` the fetch happens in the background for auto-polling: no
  // loading state, no clearing of the current view, and transient network
  // errors leave the last good data on screen untouched.
  const runLookup = useCallback(async (refValue: string, digitsValue: string, opts?: { focusOnError?: boolean; silent?: boolean }) => {
    const ref = refValue.trim().toUpperCase();
    const digits = digitsValue.replace(/\D/g, '');
    const silent = Boolean(opts?.silent);
    if (!silent) {
      if (!ref) {
        setError('Enter your order reference.');
        if (opts?.focusOnError !== false) focusField(refInputRef.current);
        return;
      }
      if (digits.length !== 10) {
        setError('Enter your 10-digit mobile number.');
        if (opts?.focusOnError !== false) focusField(phoneInputRef.current);
        return;
      }
      setLoading(true);
      setError('');
      setOrder(null);
      setDidLookup(false);
    }
    try {
      const data = await rpc<{ ok: boolean; reason?: string; order?: TrackedOrder }>('track_lookup_order', {
        p_ref: ref,
        p_phone: digits,
      });
      const res = data;
      if (!res?.ok) {
        if (silent) return;
        setError(res?.reason || 'We could not find that order.');
      } else if (res.order) {
        lastCredsRef.current = { ref, phone: digits };
        // The shipping projection is a SECOND, equally gated lookup. It is
        // best-effort on purpose: a failure here must never turn a successful
        // order lookup into an error page.
        let shipping: Partial<TrackedOrder> | null = null;
        try {
          const shipRes = await rpc<{ ok: boolean; order?: Partial<TrackedOrder> }>('track_order_shipping', {
            p_ref: ref,
            p_phone: digits,
          });
          if (shipRes?.ok && shipRes.order) shipping = shipRes.order;
        } catch {
          shipping = null;
        }
        setOrder(shipping ? { ...res.order, ...shipping } : res.order);
        setLastUpdated(Date.now());
      } else {
        if (silent) return;
        setError('We could not find that order.');
      }
    } catch {
      if (!silent) setError('Something went wrong while looking up your order. Please try again.');
    } finally {
      if (!silent) {
        setLoading(false);
        setDidLookup(true);
      }
    }
  }, []);

  const handleLookup = (e?: React.FormEvent) => {
    e?.preventDefault();
    setCurrentRef(refInput.trim().toUpperCase());
    void runLookup(refInput, phone);
  };

  // Auto path: a session hint (right after checkout), a history match for the
  // requested ref, or this browser's most recent order — whichever `resolved`
  // captured. Remove the ONE-SHOT session hint immediately (a revisit/cleared
  // storage falls back to the form); the long-term history is kept. The
  // lookupStartedRef guard keeps React StrictMode's double-invoked effect from
  // firing the RPC twice in dev.
  useEffect(() => {
    if (!resolved) return;
    clearTrackHint();
    if (lookupStartedRef.current) return;
    lookupStartedRef.current = true;
    setRefInput(resolved.ref);
    setPhone(resolved.phone);
    void runLookup(resolved.ref, resolved.phone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  // Gentle re-render tick so the "Last updated Xs/Xm ago" label stays fresh
  // (updates every 15s — never a per-second render loop).
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const lastStage = order ? visualStage(order) : -1;

  /* What the Shipping card must report.
     `shippingStatusOf` prefers a stored `shipping_status` over `order_status`.
     That is the right general precedence, but it is wrong in one reachable case:
     `shipping_status` is written by admin_set_order_shipping, which REFUSES any
     post-handoff state without an AWB, while `order_status` is advanced by a
     different workflow. An order marked delivered with no AWB on file therefore
     keeps `shipping_status = 'pending'` and the card told the customer their
     delivered parcel was still "Preparing your order".

     A delivered order is terminal, so it wins here. This re-orders two states at
     the display site ONLY — `shippingStatusOf` and the status logic are
     untouched, and remain the single shared source for admin and email. Nothing
     is hardcoded to Delivered: every other state still comes from the mapping. */
  const cardShippingStatus: string =
    order?.order_status === 'delivered' ? 'delivered' : shippingStatusOf(order);

  // Live auto-poll: keep the last lookup credentials (stable ref), skip polling
  // once the shipment is terminal (delivered / rto / cancelled / failed) so we
  // never waste network traffic. Cleaned up on navigation away by the effect
  // teardown, and re-armed whenever the order object (or stage) changes.
  useEffect(() => {
    if (!order || lastStage >= 3 || isShipmentTerminal(order)) return;
    const id = window.setInterval(() => {
      const creds = lastCredsRef.current;
      if (creds.ref && creds.phone.length === 10) {
        void runLookup(creds.ref, creds.phone, { silent: true, focusOnError: false });
      }
    }, pollIntervalMs());
    return () => window.clearInterval(id);
  }, [order, lastStage, runLookup]);

  const agoText = (() => {
    if (!lastUpdated) return '';
    const secs = Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.max(1, Math.floor(secs / 60));
    return `${mins}m ago`;
  })();

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return iso;
    }
  };

  // The lookup form is ALWAYS rendered, pre-filled.
  //
  // It used to be hidden whenever an auto-lookup was armed, with a
  // "Track a different order" expandable (a picker over this browser's saved
  // refs) plus a separate "Enter a different order reference" link as the only
  // ways back. Both are gone: a saved-order list on a tracking page is a
  // history leak on a shared device, and the direct route is now to open the
  // order you want and press TRACK ORDER on it.
  //
  // Keeping the form visible is what replaces those affordances. It is the
  // secure possession entry (ref + phone, still enforced server-side by
  // track_lookup_order), and because it stays on screen it is also simply where
  // a customer changes the reference — so removing the old UI cannot strand
  // someone on an order they did not choose.

  return (
    <div className="shell shell--content py-8 md:py-14">
      <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none">
        Track Order
      </h1>

        <>
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
              className="btn-primary text-[14px] uppercase tracking-wide-2 font-semibold px-6 py-[13px] disabled:opacity-60"
            >
              {loading ? <Loader2 size={15} strokeWidth={2} className="animate-spin" /> : <Search size={15} strokeWidth={2} />}
              <span>{loading ? 'Checking…' : 'Track'}</span>
            </button>
          </form>
      </>

      {autoLookup && loading && (
        <div className="mt-7 flex items-center gap-2 text-sm text-grey">
          <Loader2 size={15} strokeWidth={2} className="animate-spin" />
          Looking up your order…
        </div>
      )}

      {error && !loading && (
        <div className="mt-5 rounded-card border border-bone/20 bg-white px-4 py-3 text-sm text-crimson">{error}</div>
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
            <div className="mt-5 flex gap-3 rounded-card border border-bone/20 bg-white px-4 py-3 text-sm text-bone-dim">
              <XCircle size={18} strokeWidth={1.8} className="shrink-0" /> {statusNote}
            </div>
          ) : isTerminal ? (
            <div className="mt-5 flex gap-3 border border-line bg-paper px-4 py-3 text-sm text-grey">
              <RotateCcw size={18} strokeWidth={1.8} className="shrink-0 text-bone-dim" /> {statusNote}
            </div>
          ) : (
            <div className="mt-6">
              {lastStage >= 0 && (
                <div className="px-1 pt-2 pb-1">
                  <div className="relative flex justify-between">
                    <span className="track-line" />
                    <span
                      className="track-line-fill"
                      style={{ '--fill': lastStage / (TRACK_STAGES.length - 1) } as React.CSSProperties}
                      aria-hidden="true"
                    />
                    {TRACK_STAGES.map((s, i) => {
                      const Icon = s.icon;
                      const done = i < lastStage;
                      const isCurrent = i === lastStage;
                      return (
                        <div key={s.label} className="track-stage">
                          <span
                            className={`track-dot ${done ? 'done' : ''} ${isCurrent ? 'current' : ''}`}
                            aria-hidden="true"
                          >
                            {done ? <Check size={16} strokeWidth={2.5} /> : <Icon size={16} strokeWidth={2} />}
                          </span>
                          <span className={`track-label ${done || isCurrent ? 'text-bone font-semibold' : 'text-grey'}`}>
                            {s.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 flex items-center justify-end gap-1.5 text-right font-label text-[10px] uppercase tracking-wide-2 text-grey">
                    <Clock size={11} strokeWidth={1.8} />
                    {lastStage === 3 ? 'Delivered' : 'Live'} · Last updated {agoText || 'just now'}
                  </p>
                </div>
              )}
              <p className="mt-4 text-sm text-bone leading-relaxed">{statusNote}</p>
              <p className="mt-1 text-xs text-grey flex items-center gap-1.5">
                <ShieldCheck size={13} strokeWidth={1.8} />
                {order.is_cod || order.payment_status === 'cod_pending'
                  ? `Cash on Delivery — ${formatPrice(codDue)} due on delivery`
                  : `Payment ${order.payment_status === 'success' ? 'confirmed' : order.payment_status}.`}
              </p>
              {order.is_cod && (
                <p className="mt-0.5 text-xs text-grey">
                  Please keep {formatPrice(codDue)} ready for your delivery partner.
                </p>
              )}
            </div>
          )}

          {/* --- Shipping -----------------------------------------------------
              Two honest states, and only two:
                BEFORE an AWB exists -> "Preparing your order" and an explicit
                promise that tracking will follow. No courier, no AWB, no link,
                no claim that anything is moving.
                AFTER an AWB exists  -> the courier, the AWB, the stored status
                and a Track Shipment button ONLY when a real link is derivable. */}
          {order && (hasAwb(order) ? (
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
                <div>
                  <p className="text-[10px] uppercase tracking-wide-2 text-grey">AWB / Tracking Number</p>
                  {/* An AWB may be up to 60 unbroken characters, so it must be
                      allowed to wrap rather than push the layout sideways. */}
                  <p className="text-bone font-medium mt-0.5 tabular-nums break-all">{awbOf(order)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide-2 text-grey">Shipping status</p>
                  <p className="text-bone font-medium mt-0.5">{shippingStatusLabel(shippingStatusOf(order))}</p>
                </div>
                {order.shipped_at && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide-2 text-grey">Shipped on</p>
                    <p className="text-bone font-medium mt-0.5">{fmtDate(order.shipped_at)}</p>
                  </div>
                )}
                {/* The COURIER's own scan status, shown only when a provider
                    actually reported one. It is never used to invent movement. */}
                {(order.tracking_current_status || order.shiprocket_current_status) && (
                  <div className="sm:col-span-2">
                    <p className="text-[10px] uppercase tracking-wide-2 text-grey">Courier update</p>
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
              </div>
              {trackingLinkFor(order) ? (
                <a
                  href={trackingLinkFor(order) as string}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary text-[14px] uppercase tracking-wide-2 font-semibold px-5 py-3 mt-3"
                >
                  <Truck size={14} strokeWidth={1.8} /> Track Shipment
                  <ExternalLink size={12} strokeWidth={1.8} />
                </a>
              ) : (
                /* No stored link and no courier whose public tracking page we
                   know: show the AWB and stop. Inventing a URL would send the
                   customer somewhere that cannot track their parcel. */
                <p className="mt-3 text-xs text-grey">
                  Your tracking number is shown above. Live updates for this courier are not available on this
                  page yet — please quote the AWB if you contact us.
                </p>
              )}
            </div>
          ) : (
            <div className="mt-6 border border-line bg-paper px-4 py-3">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2 flex items-center gap-1.5">
                <Truck size={13} strokeWidth={1.8} /> Shipping
              </p>
              <p className="text-sm text-bone">Status: {shippingStatusMessage(cardShippingStatus)}</p>
              {/* Pre-AWB notice for every state still ahead of the courier. Once the
                  parcel has arrived it would be a promise that can never be kept,
                  so that state gets its own line instead. */}
              <p className="mt-1 text-xs text-grey">
                {cardShippingStatus === 'delivered' ? DELIVERED_NOTICE : NO_AWB_NOTICE}
              </p>
            </div>
          ))}

          {order.items.length > 0 && (
            <div className="mt-6 border-t border-line pt-4">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2">Your Products</p>
              <div className="divide-y divide-line">
                {order.items.map((it, idx) => {
                  const image = imageForItem(imageIndex, it);
                  return (
                    <div key={idx} className="flex items-center gap-3 py-2 text-sm">
                      {/* Same treatment as the cart drawer / product detail
                          image box: fixed 4:5-ish portrait, object-cover, and a
                          neutral paper block behind it so a missing or failed
                          image reads as an empty slot rather than a broken icon. */}
                      <div
                        className="w-[76px] h-[96px] shrink-0 overflow-hidden bg-paper-3 border border-line"
                        aria-hidden={!image}
                      >
                        {image && (
                          <img
                            src={image}
                            alt={it.name}
                            loading="lazy"
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              // A dead URL must degrade to the neutral block, not
                              // leave the browser's broken-image glyph on show.
                              e.currentTarget.style.visibility = 'hidden';
                            }}
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-bone">{it.name}</p>
                        <p className="text-[11px] text-grey">{it.color} · {it.size_label} × {it.quantity}</p>
                      </div>
                      <span className="text-bone font-medium whitespace-nowrap tabular-nums shrink-0">{formatPrice(it.line_total)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm text-grey">
                <div className="flex justify-between"><span>Items ({order.total_qty})</span><span className="text-bone">{formatPrice(order.subtotal)}</span></div>
                {order.discount > 0 && (
                  <div className="flex justify-between"><span>Discount</span><span className="text-green-700">−{formatPrice(order.discount)}</span></div>
                )}
                <div className="flex justify-between"><span>Shipping</span><span className="text-bone">{order.shipping > 0 ? formatPrice(order.shipping) : 'FREE'}</span></div>
                {order.is_cod ? (
                  /* One amount only. COD never involves a payment before delivery. */
                  <>
                    <div className="flex justify-between">
                      <span>Amount due on delivery</span>
                      <span className="text-bone">{formatPrice(codDue)}</span>
                    </div>
                    <div className="flex justify-between border-t border-line pt-1.5 font-semibold text-bone">
                      <span>Total (Cash on Delivery)</span>
                      <span>{formatPrice(codDue)}</span>
                    </div>
                  </>
                ) : (
                  <>
                    {(order.payment_discount ?? 0) > 0 && (
                      <div className="flex justify-between">
                        <span>Online Payment Discount</span>
                        <span className="text-green-700">−{formatPrice(order.payment_discount ?? 0)}</span>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-line pt-1.5 font-semibold text-bone">
                      <span>{(order.payment_discount ?? 0) > 0 ? 'Online Payment Total' : 'Total'}</span>
                      <span>
                        {formatPrice(
                          order.amount_paid_upfront ?? order.total_amount
                        )}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-5">
            <button
              onClick={() => navigate('/contact')}
              className="btn-soft btn-dark text-[14px] uppercase tracking-wide-2 font-semibold px-6 py-3"
            >
              Need Help?
            </button>
            <button
              onClick={() => navigate('/collections')}
              className="inline-flex items-center gap-2 border border-bone-dim text-bone text-[14px] uppercase tracking-wide-2 font-semibold px-6 py-3 hover:bg-bone hover:text-paper transition-colors"
            >
              Continue Shopping
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock, Loader2, ShieldCheck, Truck, XCircle } from 'lucide-react';
import { useD2cCart } from '@/lib/d2cCart';
import { useRouter } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';
import { createPaymentSession, verifyPayment, PaymentSessionError, ORDER_EXPIRED_MESSAGE } from '@/lib/payment';
import { openCashfreeCheckout, preloadCashfreeSdk } from '@/lib/cashfreeSdk';
import { rpc } from '@/lib/rest';
import { useOrderImages, imageForItem } from '@/lib/orderImages';
import { addCheckoutHistory } from '@/lib/trackHistory';
import { SaveDetailsPrompt } from '@/components/SaveDetailsPrompt';

const PENDING_PAYMENT_KEY = 'dslang_pending_order_v1';
const LIVE_ORDER_KEY = 'dslang_live_order_v1';
const CHECKOUT_FORM_KEY = 'dslang_checkout_form_v1';
const RESULT_KEY = 'dslang_order_result_v1';

type Verdict = 'checking' | 'paid' | 'failed' | 'pending' | 'unknown';

interface PendingPayload {
  ref: string;
  order_id: string;
  amount: number;
  itemsKey: string;
  at: number;
  phone?: string;
}

interface LiveOrder {
  ref: string;
  order_id: string;
  amount: number;
  itemsKey: string;
  /** A COD order is never payable online — this must survive rehydration. */
  is_cod?: boolean;
}

interface ResultLine {
  product_id?: string;
  name: string;
  color: string;
  size_label: string;
  quantity: number;
  line_total: number;
}

interface OrderSnapshot {
  ref: string;
  order_id: string;
  total_qty: number;
  subtotal: number;
  discount: number;
  shipping: number;
  total_amount: number;
  payment_status: string;
  order_status?: string;
  is_cod?: boolean;
  payment_discount?: number;
  amount_paid_upfront?: number;
  amount_due_on_delivery?: number;
  items: ResultLine[];
  customer?: { name: string; phone: string; email?: string; address: string; city: string; state: string; pincode: string };
}

function readHashRef(): string {
  try {
    const raw = window.location.hash.replace(/^#/, '');
    const qs = raw.includes('?') ? raw.split('?').slice(1).join('?') : '';
    const params = new URLSearchParams(qs);
    return (params.get('ref') ?? '').trim().toUpperCase();
  } catch {
    return '';
  }
}

function readPending(): PendingPayload | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as PendingPayload;
    if (typeof v?.ref !== 'string' || !v.ref) return null;
    return {
      ref: v.ref,
      order_id: typeof v.order_id === 'string' ? v.order_id : '',
      amount: Number(v.amount ?? 0),
      itemsKey: typeof v.itemsKey === 'string' ? v.itemsKey : '',
      at: Number(v.at ?? 0),
      phone: typeof v.phone === 'string' ? v.phone : undefined,
    };
  } catch {
    return null;
  }
}

function readLive(): LiveOrder | null {
  try {
    const raw = window.sessionStorage.getItem(LIVE_ORDER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as LiveOrder;
    if (typeof v?.ref !== 'string' || typeof v?.order_id !== 'string' || typeof v?.amount !== 'number') return null;
    // `is_cod` must survive rehydration: it is what stops this page from
    // offering (and attempting) an online payment for a COD order.
    return { ref: v.ref, order_id: v.order_id, amount: v.amount, itemsKey: typeof v.itemsKey === 'string' ? v.itemsKey : '', is_cod: v.is_cod === true };
  } catch {
    return null;
  }
}

function readResult(): { ref?: string; phone?: string } | null {
  try {
    const raw = window.localStorage.getItem(RESULT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.ref === 'string' ? { ref: v.ref, phone: typeof v.phone === 'string' ? v.phone : '' } : null;
  } catch {
    return null;
  }
}

function readFormPhone(): string {
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_FORM_KEY);
    if (!raw) return '';
    const v = JSON.parse(raw);
    return typeof v?.phone === 'string' ? v.phone : '';
  } catch {
    return '';
  }
}

function readFormName(): string {
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_FORM_KEY);
    if (!raw) return '';
    const v = JSON.parse(raw);
    return typeof v?.name === 'string' ? v.name : '';
  } catch {
    return '';
  }
}

function readFormEmail(): string {
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_FORM_KEY);
    if (!raw) return '';
    const v = JSON.parse(raw);
    return typeof v?.email === 'string' ? v.email : '';
  } catch {
    return '';
  }
}

// The checkout form's address for THIS order (still in session storage) is what
// the optional save-details prompt offers — the privacy-safe lookup RPC never
// returns customer data, and the key is cleared on settle.
function readFormCustomer(): { name: string; phone: string; email?: string; address: string; city: string; state: string; pincode: string } | null {
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_FORM_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v !== 'object' || !v) return null;
    const name = [String(v.firstName ?? ''), String(v.lastName ?? '')].filter(Boolean).join(' ').trim() || (typeof v.name === 'string' ? v.name.trim() : '');
    const phone = typeof v.phone === 'string' ? v.phone : '';
    if (!name || !phone) return null;
    return {
      name,
      phone,
      email: typeof v.email === 'string' && v.email ? v.email : undefined,
      address: typeof v.address === 'string' ? v.address : '',
      city: typeof v.city === 'string' ? v.city : '',
      state: typeof v.state === 'string' ? v.state : '',
      pincode: typeof v.pincode === 'string' ? v.pincode : '',
    };
  } catch {
    return null;
  }
}

function clearPending(): void {
  try {
    window.sessionStorage.removeItem(PENDING_PAYMENT_KEY);
  } catch {
    // ignore
  }
}

function clearLive(): void {
  try {
    window.sessionStorage.removeItem(LIVE_ORDER_KEY);
  } catch {
    // ignore
  }
}

function persistPending(live: LiveOrder, phone: string): void {
  try {
    window.sessionStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({ ...live, phone, at: Date.now() }));
  } catch {
    // ignore
  }
}

function persistResult(snap: OrderSnapshot, phone: string): void {
  try {
    window.localStorage.setItem(RESULT_KEY, JSON.stringify({ ref: snap.ref, phone, order: snap, at: Date.now() }));
  } catch {
    // ignore
  }
}

function fullItemsKey(items: { productId: string; colorId: string; sizeLabel: string; quantity: number }[]): string {
  return items.map((i) => `${i.productId}|${i.colorId}|${i.sizeLabel}|${i.quantity}`).join(',');
}

function reducedItemsKey(items: { productId: string; sizeLabel: string; quantity: number }[]): string {
  return items.map((i) => `${i.productId}|${i.sizeLabel}|${i.quantity}`).join(',');
}

function orderLinesKey(lines: ResultLine[]): string | null {
  const parts = lines.filter((l) => l.product_id).map((l) => `${l.product_id}|${l.size_label}|${l.quantity}`);
  return parts.length > 0 ? parts.join(',') : null;
}

function normalizeSnapshot(order: Record<string, unknown>, orderId: string): OrderSnapshot {
  const items = Array.isArray(order.items) ? (order.items as ResultLine[]) : [];
  return {
    ref: String(order.ref ?? ''),
    order_id: orderId,
    total_qty: Number(order.total_qty ?? 0),
    subtotal: Number(order.subtotal ?? 0),
    discount: Number(order.discount ?? 0),
    shipping: Number(order.shipping ?? 0),
    total_amount: Number(order.total_amount ?? 0),
    payment_status: String(order.payment_status ?? ''),
    order_status: String(order.order_status ?? 'pending'),
    is_cod: Boolean(order.is_cod),
    payment_discount: Number(order.payment_discount ?? 0),
    amount_paid_upfront: Number(order.amount_paid_upfront ?? 0),
    amount_due_on_delivery: Number(order.amount_due_on_delivery ?? 0),
    items,
    customer: (order.customer as OrderSnapshot['customer']) ?? undefined,
  };
}

function waitForHandoff(timeoutMs: number): Promise<'unloaded' | 'stalled'> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: 'unloaded' | 'stalled') => {
      if (done) return;
      done = true;
      window.removeEventListener('pagehide', onPageHide);
      window.clearTimeout(timer);
      resolve(value);
    };
    const onPageHide = () => finish('unloaded');
    window.addEventListener('pagehide', onPageHide);
    const timer = window.setTimeout(() => finish('stalled'), timeoutMs);
  });
}

interface TrackedLookupOrder {
  ref: string;
  payment_status: string;
  order_status?: string;
  stock_restored_at?: string | null;
  total_qty: number;
  subtotal: number;
  discount: number;
  shipping: number;
  total_amount: number;
  is_cod?: boolean;
  payment_discount?: number;
  amount_paid_upfront?: number;
  amount_due_on_delivery?: number;
  items: ResultLine[];
}

interface TrackedLookup {
  ok: boolean;
  reason?: string;
  order?: TrackedLookupOrder | null;
}

export function OrderStatusPage() {
  const { items, clear, removeAppliedPromo } = useD2cCart();
  const { navigate } = useRouter();
  // Order lines carry no image URL; this resolves each one from the public
  // catalogue by product id + colour (lib/orderImages.ts), the same source the
  // Product Details page renders from.
  const imageIndex = useOrderImages();

  const pendingRef = useRef<PendingPayload | null>(null);
  if (pendingRef.current === null) pendingRef.current = readPending();

  const initialRef = (() => {
    const fromHash = readHashRef();
    if (fromHash) return fromHash;
    if (pendingRef.current?.ref) return pendingRef.current.ref;
    // The live order (this session's most recent placement) is more current
    // than the persistent last-confirmed result — prefer it so a stale result
    // from a previous checkout can never hijack the status page.
    const live = readLive();
    if (live?.ref) return live.ref;
    const result = readResult();
    if (result?.ref) return result.ref;
    return '';
  })();
  const initialPhone = (() => {
    const p = pendingRef.current?.phone ?? readResult()?.phone ?? readFormPhone();
    return typeof p === 'string' ? p.replace(/\D/g, '').slice(0, 10) : '';
  })();

  const [formCustomer] = useState<OrderSnapshot['customer'] | null>(readFormCustomer);
  const [ref] = useState(initialRef);
  const [phone, setPhone] = useState(initialPhone);
  const [draftPhone, setDraftPhone] = useState(initialPhone);
  const [verdict, setVerdict] = useState<Verdict>(initialRef && initialPhone ? 'checking' : 'unknown');
  const [note, setNote] = useState('');
  const [snap, setSnap] = useState<OrderSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifyTick, setVerifyTick] = useState(0);
  const [expired, setExpired] = useState(false);
  // Escape hatch: a stuck (pending/failed) order must never be a dead end.
  // After 2-3 manual re-checks or a ~45s window without a resolution, surface
  // "Start New Order" so the customer can always begin a fresh checkout.
  const [recheckCount, setRecheckCount] = useState(0);
  const [showNewOrder, setShowNewOrder] = useState(false);

  const settlePaid = (order: Record<string, unknown>) => {
    const orderId = String(order.id ?? pendingRef.current?.order_id ?? '');
    const snapshot = normalizeSnapshot(order, orderId);
    clearPending();
    clearLive();
    try {
      window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
    } catch {
      // ignore
    }
    persistResult(snapshot, phone);
    addCheckoutHistory(snapshot.ref, phone);
    const pendingKey = pendingRef.current?.itemsKey ?? '';
    const full = fullItemsKey(items);
    const orderKey = orderLinesKey(snapshot.items);
    const cartReduced = reducedItemsKey(items);
    const sameCart =
      (Boolean(pendingKey) && full === pendingKey) ||
      (!pendingKey && Boolean(orderKey) && cartReduced === orderKey);
    if (sameCart) {
      clear();
      removeAppliedPromo();
    }
    setSnap(snapshot);
    setVerdict('paid');
    setNote('');
  };

  const settleFailed = (msg?: string) => {
    clearPending();
    setVerdict('failed');
    setNote(
      msg ??
        'Your payment could not be completed and you have not been charged. Your items are still safe in your bag — try paying again.'
    );
  };

  // Warm the Cashfree SDK as soon as the page loads so that "Try Again" hands
  // off to Cashfree instantly — the same near-instant pattern as Pay Now on the
  // checkout page (no visible loading between click and redirect).
  useEffect(() => {
    preloadCashfreeSdk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ref || !phone) return;
    let cancelled = false;
    setVerdict('checking');
    setNote('Confirming your payment…');

    const attempt = async (): Promise<'idle' | 'pending'> => {
      try {
        const v = await verifyPayment(ref, phone);
        if (cancelled) return 'idle';
        if (v?.verified && v.order) {
          settlePaid(v.order as Record<string, unknown>);
          return 'idle';
        }
        if (v?.status === 'failed') {
          const o = v.order as Record<string, unknown> | null;
          if (o?.stock_restored_at) {
            // The sweep (or an admin) already reclaimed this order's stock —
            // the reservation is gone, so retrying could over-sell. Surface the
            // clear message and point to a new checkout.
            clearLive();
            setExpired(true);
            settleFailed(ORDER_EXPIRED_MESSAGE);
          } else {
            settleFailed();
          }
          return 'idle';
        }
      } catch {
        // fall through to the track_lookup_order fallback below
      }
      try {
        const data = await rpc<TrackedLookup>('track_lookup_order', { p_ref: ref, p_phone: phone });
        if (cancelled) return 'idle';
        if (data?.ok && data.order) {
          const o = data.order;
          // A full-COD order is CONFIRMED the moment it is created: it carries
          // payment_status 'cod_pending' and collects the amount on delivery.
          // It therefore has no payment to confirm — treating it as "still
          // confirming" would tell a COD shopper that a payment is in flight
          // (and offer to pay again for an order that must not be paid online).
          if (o.payment_status === 'success' || (o.is_cod && o.payment_status === 'cod_pending')) {
            settlePaid({
              ref: o.ref,
              id: '',
              total_qty: o.total_qty,
              subtotal: o.subtotal,
              discount: o.discount ?? 0,
              shipping: o.shipping ?? 0,
              total_amount: o.total_amount,
              payment_status: o.payment_status,
              order_status: o.order_status,
              is_cod: o.is_cod,
              payment_discount: o.payment_discount,
              amount_paid_upfront: o.amount_paid_upfront,
              amount_due_on_delivery: o.amount_due_on_delivery,
              items: o.items,
            });
            return 'idle';
          }
          if (o.payment_status === 'failed') {
            if (o.stock_restored_at) {
              clearLive();
              setExpired(true);
              settleFailed(ORDER_EXPIRED_MESSAGE);
            } else {
              settleFailed();
            }
            return 'idle';
          }
        }
      } catch {
        // network hiccup — the loop will retry
      }
      return 'pending';
    };

    const confirm = async () => {
      for (let i = 0; i < 3; i++) {
        const done = await attempt();
        if (done === 'idle' || cancelled) return;
        await new Promise((r) => window.setTimeout(r, i === 0 ? 600 : 800));
        if (cancelled) return;
      }
      if (cancelled) return;
      setVerdict('pending');
      setNote(
        'Your payment is still being confirmed. If you have been charged, your order is safe — re-check below or contact us.'
      );
    };
    confirm();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, phone, verifyTick]);

  // Time-window escape hatch: if confirmation never comes to a head (stuck
  // "Still Confirming" / "Payment Not Completed"), offer "Start New Order"
  // after a short wait so the customer is never trapped on a stale screen.
  useEffect(() => {
    if (verdict !== 'pending' && verdict !== 'failed') return;
    if (expired) return;
    const t = window.setTimeout(() => setShowNewOrder(true), 45000);
    return () => window.clearTimeout(t);
  }, [verdict, expired, ref, verifyTick]);

  const retryHandle = (): LiveOrder | null => {
    // NEVER resurrect a different order: the retry must pay the SAME order
    // this page is showing (ref), otherwise a newer/older handle from storage
    // would stray to a previous checkout.
    const live = readLive();
    if (live && live.ref === ref) return live;
    const p = readPending();
    if (p && p.ref === ref && p.order_id && p.amount) {
      return { ref: p.ref, order_id: p.order_id, amount: p.amount, itemsKey: p.itemsKey };
    }
    if (snap && snap.ref === ref && snap.order_id && snap.total_amount) {
      return { ref: snap.ref, order_id: snap.order_id, amount: snap.total_amount, itemsKey: '', is_cod: snap.is_cod === true };
    }
    return null;
  };

  const handleTryAgain = async () => {
    if (busy) return;
    const handle = retryHandle();
    if (!handle) {
      setVerdict('unknown');
      setNote("We couldn't find the payment session for this order. Please place the order again.");
      return;
    }
    // A COD order is never payable online — it is collected in full on
    // delivery. Never open a gateway session for one, whatever storage says.
    if (handle.is_cod || snap?.is_cod) {
      setVerdict('paid');
      setNote('');
      return;
    }
    if (!phone) {
      setVerdict('unknown');
      setNote('Enter your 10-digit mobile number to pay for this order again.');
      return;
    }
    setBusy(true);
    setNote('');
    try {
      const session = await createPaymentSession({
        orderRef: handle.ref,
        orderId: handle.order_id,
        amount: handle.amount,
        customer: { name: readFormName() || 'DSLANG Customer', phone, email: readFormEmail() || undefined },
      });
      if (session.status !== 'pending' || !session.paymentSessionId) {
        throw new Error('The online payment could not be started. Your order has not been charged.');
      }
      persistPending(handle, phone);
      const redirected = await openCashfreeCheckout({
        paymentSessionId: session.paymentSessionId,
        environment: session.environment ?? 'TEST',
        redirectTarget: '_self',
      });
      if (!redirected) {
        throw new Error('The payment window could not be opened. Your order has not been charged.');
      }
      await waitForHandoff(4000);
    } catch (err) {
      if (err instanceof PaymentSessionError && (err.code === 'ORDER_EXPIRED' || err.code === 'ORDER_NOT_FOUND')) {
        // Reservation is gone (swept/admin-restocked): drop the retry handles
        // so a refresh doesn't re-offer a dead order, and switch the CTA to
        // "Start New Checkout".
        clearPending();
        clearLive();
        setExpired(true);
      }
      setVerdict('failed');
      setNote(
        err instanceof Error
          ? err.message
          : 'The payment could not be started. Your order has not been charged — please try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleManualVerify = (e?: React.FormEvent) => {
    e?.preventDefault();
    const digits = draftPhone.replace(/\D/g, '').slice(0, 10);
    if (digits.length !== 10) {
      setVerdict('unknown');
      setNote('Enter your 10-digit mobile number to confirm your order.');
      return;
    }
    setNote('');
    setPhone(digits);
  };

  if (verdict === 'paid' && snap) {
    /* Cash on Delivery is one amount, collected on arrival. Read from the row. */
    const codDue = snap.amount_due_on_delivery ?? snap.total_amount;
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-blush">
          <CheckCircle2 size={36} strokeWidth={1.5} className="text-bone animate-scale-in" />
          <span className="absolute inset-0 rounded-full border border-bone/25 animate-fade-in" aria-hidden />
        </div>
        <p className="mt-5 font-label text-[10px] uppercase tracking-ultra text-grey">Order Confirmed</p>
        <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-2">
          Thank You
        </h1>
        <p className="mt-4 text-sm text-grey max-w-md leading-relaxed">
          Your order <span className="font-semibold text-bone">#{snap.ref}</span> is confirmed and recorded. We are
          processing it and will confirm delivery details soon.
        </p>

        <div className="mt-8 w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-5 lg:gap-6 text-left">
          <div className="space-y-5">
            <div className="panel p-5">
              <div className="flex justify-between border-b border-line pb-2 text-sm">
                <span className="text-grey">Order</span>
                <span className="font-semibold text-bone">{snap.ref}</span>
              </div>
              <div className="flex justify-between border-b border-line py-2 text-sm">
                <span className="text-grey">Items</span>
                <span className="font-semibold text-bone">{snap.total_qty}</span>
              </div>
              <div className="flex justify-between border-b border-line py-2 text-sm">
                <span className="text-grey">Payment</span>
                <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone">
                  {snap.is_cod ? 'CASH ON DELIVERY' : 'PAID'}
                </span>
              </div>
              {snap.is_cod ? (
                /* One amount only. COD never involves a payment before delivery. */
                <div className="flex justify-between border-b border-line py-2 text-sm">
                  <span className="text-grey">Amount due on delivery</span>
                  <span className="font-semibold text-bone">{formatPrice(codDue)}</span>
                </div>
              ) : (
                <div className="flex justify-between border-b border-line py-2 text-sm">
                  <span className="text-grey">Paid</span>
                  <span className="font-semibold text-green-700">{formatPrice(snap.amount_paid_upfront ?? snap.total_amount)}</span>
                </div>
              )}
              {snap.discount > 0 && (
                <div className="flex justify-between border-b border-line py-2 text-sm">
                  <span className="text-grey">Discount</span>
                  <span className="font-semibold text-green-700">−{formatPrice(snap.discount)}</span>
                </div>
              )}
              {!snap.is_cod && (snap.payment_discount ?? 0) > 0 && (
                <div className="flex justify-between border-b border-line py-2 text-sm">
                  <span className="text-grey">Online Payment Discount</span>
                  <span className="font-semibold text-green-700">−{formatPrice(snap.payment_discount ?? 0)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 text-sm">
                <span className="text-grey">
                  {snap.is_cod
                    ? 'Total (Cash on Delivery)'
                    : (snap.payment_discount ?? 0) > 0
                      ? 'Online Payment Total'
                      : 'Total'}
                </span>
                <span className="font-price text-lg font-bold text-bone tabular-nums">
                  {formatPrice(
                    snap.is_cod ? codDue : (snap.amount_paid_upfront ?? snap.total_amount)
                  )}
                </span>
              </div>
            </div>

            {snap.items.length > 0 && (
              <div className="panel p-5">
                <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2">
                  Your Products
                </p>
                <ul className="divide-y divide-line">
                  {snap.items.map((it, idx) => {
                    const img = imageForItem(imageIndex, it);
                    return (
                      <li key={idx} className="flex items-center gap-3 py-2.5 text-sm">
                        <span className="h-14 w-11 shrink-0 overflow-hidden rounded border border-line bg-paper-3">
                          {img && <img src={img} alt={it.name} className="h-full w-full object-cover" loading="lazy" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-bone">{it.name}</span>
                          <span className="block text-[11px] text-bone-dim">
                            {it.color} · {it.size_label} × {it.quantity}
                          </span>
                        </span>
                        <span className="text-bone font-medium whitespace-nowrap tabular-nums">
                          {formatPrice(it.line_total)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <div className="space-y-5">
            <div className="panel p-5">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-3">
                What Happens Next
              </p>
              <ol className="space-y-3">
                <li className="flex gap-3 text-sm">
                  <span className="font-label text-bone font-semibold shrink-0">1</span>
                  <span className="text-grey leading-relaxed">
                    We personally review order <span className="text-bone font-medium">{snap.ref}</span> — every order
                    is checked by hand.
                  </span>
                </li>
                <li className="flex gap-3 text-sm">
                  <span className="font-label text-bone font-semibold shrink-0">2</span>
                  <span className="text-grey leading-relaxed">
                    Your order will be dispatched within 24–48 hours, with stock confirmed before it
                    ships.
                  </span>
                </li>
                <li className="flex gap-3 text-sm">
                  <span className="font-label text-bone font-semibold shrink-0">3</span>
                  <span className="text-grey leading-relaxed">
                    Track your order anytime with <span className="text-bone font-medium">{snap.ref}</span> on the
                    Track Order page — we will also email you at every step.
                  </span>
                </li>
                {snap.is_cod && (
                  <li className="flex gap-3 text-sm">
                    <span className="font-label text-bone font-semibold shrink-0">4</span>
                    <span className="text-grey leading-relaxed">
                      Pay <span className="text-bone font-medium">{formatPrice(codDue)}</span>{' '}
                      in cash or digitally to your delivery partner when the parcel arrives.
                    </span>
                  </li>
                )}
              </ol>
            </div>

            <div className="w-full border border-lime-300 bg-lime-50 px-4 py-3 text-xs text-green-800 leading-relaxed">
              {snap.is_cod
                ? `Order ${snap.ref} is confirmed. Pay ${formatPrice(codDue)} to the delivery agent on arrival.`
                : 'Your payment has been verified and received. We are preparing your order for dispatch.'}
            </div>

            <div className="panel p-5">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2 flex items-center gap-1.5">
                <ShieldCheck size={13} strokeWidth={1.8} /> Secure Payment
              </p>
              <p className="text-xs text-grey leading-relaxed">
                {snap.is_cod
                  ? 'This is a Cash on Delivery order. Nothing was charged online — the full amount is collected by the delivery agent on arrival.'
                  : 'Payment was processed securely and verified server-side against the order total before this confirmation. You will not be charged twice.'}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            onClick={() => navigate(`/track-order/${encodeURIComponent(snap.ref)}`)}
            className="btn-primary text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
          >
            <Truck size={15} strokeWidth={2} />
            Track Order
          </button>
          <button
            onClick={() => navigate('/collections')}
            className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Continue Shopping
          </button>
        </div>

        <SaveDetailsPrompt customer={snap.customer ?? formCustomer} />
      </div>
    );
  }

  if (verdict === 'failed' || verdict === 'pending') {
    const isFailed = verdict === 'failed';
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full bg-blush"
          role={!isFailed ? 'status' : undefined}
          aria-live={!isFailed ? 'polite' : undefined}
        >
          {isFailed ? (
            <XCircle size={32} strokeWidth={1.4} className="text-bone" />
          ) : (
            <Clock size={30} strokeWidth={1.4} className="text-bone" />
          )}
        </div>

        <p className="mt-5 font-label text-[10px] uppercase tracking-ultra text-grey">
          {isFailed ? 'Order' : 'Payment Pending'}
        </p>
        <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-2">
          {isFailed ? 'Payment Not Completed' : 'Still Confirming'}
        </h1>

        <div className="mt-4 space-y-1 text-sm text-grey">
          {ref && (
            <p>
              Order <span className="font-semibold text-bone">#{ref}</span>
            </p>
          )}
          {(snap?.total_amount ?? pendingRef.current?.amount ?? 0) > 0 && (
            <p className="font-price text-lg font-bold text-bone tabular-nums">
              {formatPrice(snap?.total_amount ?? pendingRef.current?.amount ?? 0)}
            </p>
          )}
        </div>

        <p className="mt-4 text-sm text-grey max-w-md leading-relaxed">{note}</p>
        {isFailed && !expired && (
          <p className="mt-2 text-xs text-grey/70 max-w-md leading-relaxed">
            Nothing has been charged. The order stays reserved for {ref ? `reference #${ref}` : 'you'} so paying again
            is quick and safe.
          </p>
        )}

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (isFailed) {
                if (expired) navigate('/checkout');
                else void handleTryAgain();
              } else {
                setRecheckCount((n) => n + 1);
                if (recheckCount + 1 >= 2) setShowNewOrder(true);
                setVerifyTick((n) => n + 1);
              }
            }}
            disabled={busy}
            className="btn-primary text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
          >
            {busy ? (
              <>
                <Loader2 size={15} strokeWidth={2} className="animate-spin" /> Paying Again…
              </>
            ) : isFailed ? (
              expired ? (
                'Start New Checkout'
              ) : (
                'Try Again'
              )
            ) : (
              'Re-check Status'
            )}
          </button>
          <button
            type="button"
            onClick={() => navigate('/collections')}
            className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Continue Shopping
          </button>
          {showNewOrder && !expired && (
            <button
              type="button"
              onClick={() => {
                // Drop the stuck order handles first — otherwise the checkout
                // would re-open on its result screen and never reach the form.
                clearPending();
                clearLive();
                navigate('/checkout');
              }}
              className="btn-soft border border-bone text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
            >
              Start New Order
            </button>
          )}
        </div>
        {showNewOrder && !expired && (
          <p className="mt-4 text-[11px] text-grey max-w-md leading-relaxed">
            Still stuck? Start a fresh order instead — your bag is untouched and a new reference will be created.
          </p>
        )}

        <p className="mt-6 text-[11px] text-grey">
          Need help?{' '}
          <a href="#/contact" className="text-bone underline hover:text-bone transition-colors">
            Contact us
          </a>
        </p>
      </div>
    );
  }

  if (verdict === 'checking') {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blush" role="status" aria-live="polite">
          <Loader2 size={32} strokeWidth={1.5} className="animate-spin text-bone" />
        </div>
        <p className="mt-5 font-label text-[10px] uppercase tracking-ultra text-grey">Payment</p>
        <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-2">
          Confirming Payment
        </h1>
        {ref && (
          <p className="mt-4 text-sm text-grey">
            Order <span className="font-semibold text-bone">#{ref}</span>
          </p>
        )}
        <p className="mt-4 text-sm text-grey max-w-md leading-relaxed">{note}</p>
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
      <Clock size={32} strokeWidth={1.4} className="text-bone" />
      <p className="mt-5 font-label text-[10px] uppercase tracking-ultra text-grey">Order Status</p>
      <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-2">
        {ref ? 'Confirm Your Order' : "We Couldn't Find Your Order"}
      </h1>
      {ref && (
        <p className="mt-4 text-sm text-grey">
          Order <span className="font-semibold text-bone">#{ref}</span>
        </p>
      )}
      <p className="mt-4 text-sm text-grey max-w-md leading-relaxed">
        {ref
          ? 'Enter the 10-digit mobile number you used at checkout to confirm your payment status.'
          : defaultUnknownNote}
      </p>

      {ref && (
        <form onSubmit={handleManualVerify} noValidate className="mt-6 w-full max-w-xs">
          <input
            value={draftPhone}
            onChange={(e) => setDraftPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="10-digit mobile number"
            inputMode="numeric"
            autoComplete="tel"
            aria-label="Mobile number"
            className="w-full border border-line bg-white px-3 py-3 text-sm text-bone placeholder:text-grey/60 focus:border-bone focus:outline-none transition-colors text-center"
          />
          <button
            type="submit"
            className="mt-3 w-full btn-primary text-[11px] uppercase tracking-wide-2 font-semibold py-3.5"
          >
            Confirm Payment Status
          </button>
        </form>
      )}

      {note && <p className="mt-4 text-sm text-bone-dim max-w-md leading-relaxed">{note}</p>}

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/track-order')}
          className="btn-soft btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
        >
          Track Order
        </button>
        <button
          type="button"
          onClick={() => navigate('/collections')}
          className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
        >
          Continue Shopping
        </button>
      </div>
    </div>
  );
}

const defaultUnknownNote =
  'Checkout did not hand over an order reference we could verify. Your cart is untouched — please continue shopping and place the order again, or contact us if you were charged.';

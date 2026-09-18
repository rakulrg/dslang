import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCircle2, Loader2, ShieldCheck, Tag, Truck } from 'lucide-react';
import { useD2cCart } from '@/lib/d2cCart';
import { useCartDrawer } from '@/lib/cartDrawer';
import { useRouter } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';
import { computeShipping } from '@/lib/settings';
import { createRetailOrder, type RetailOrderResult, type RetailCustomer, type RetailOrderLineSnapshot } from '@/lib/orders';
import { validatePromo, computeDiscount, promoApplies } from '@/lib/promo';
import {
  getPaymentConfig,
  paymentStatusMessage,
  createPaymentSession,
  verifyPayment,
} from '@/lib/payment';
import { openCashfreeCheckout, preloadCashfreeSdk } from '@/lib/cashfreeSdk';
import { fetchLiveVariantStock, reconcileCartWithLive, describeStockChanges, type LiveStockMap } from '@/lib/cartStock';
import { PaymentOverlay } from '@/components/PaymentOverlay';

/**
 * Retail checkout — places the order via the server-side create_retail_order
 * RPC (prices are recomputed there; the client never sends amounts). Payment
 * is deliberately NOT faked: until a gateway is configured the order is
 * recorded as pending and the customer sees an honest status + order ref.
 */

type Stage = 'form' | 'creating' | 'confirming' | 'success' | 'failure' | 'pending';

const PENDING_PAYMENT_KEY = 'dslang_pending_order_v1';
const LIVE_ORDER_KEY = 'dslang_live_order_v1';
const CHECKOUT_FORM_KEY = 'dslang_checkout_form_v1';

/**
 * Minimal handle of a successfully placed order, kept so a failed or interrupted
 * payment can be retried for the SAME order (re-using its Cashfree session)
 * instead of creating a fresh duplicate order. Stored in sessionStorage so the
 * retry survives a hard refresh after returning from the gateway.
 */
interface LiveOrder {
  ref: string;
  order_id: string;
  amount: number;
}

interface PendingPayload extends LiveOrder {
  at: number;
}

function persistLiveOrder(live: LiveOrder): void {
  try {
    window.sessionStorage.setItem(LIVE_ORDER_KEY, JSON.stringify(live));
  } catch {
    // ignore — persistence is best-effort
  }
}

function clearLiveOrderKey(): void {
  try {
    window.sessionStorage.removeItem(LIVE_ORDER_KEY);
  } catch {
    // ignore
  }
}

function persistPendingKey(live: LiveOrder): void {
  try {
    window.sessionStorage.setItem(
      PENDING_PAYMENT_KEY,
      JSON.stringify({ ...live, at: Date.now() } satisfies PendingPayload)
    );
  } catch {
    // ignore — verification will just not be auto-triggered on return
  }
}

function clearPendingKey(): void {
  try {
    window.sessionStorage.removeItem(PENDING_PAYMENT_KEY);
  } catch {
    // ignore
  }
}

/** Resolves 'unloaded' if the document starts navigating away (the Cashfree
 *  handoff), or 'stalled' if it hasn't after timeoutMs — so the checkout can
 *  recover instead of sitting on a frozen "taking you to payment" screen. */
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

/** Stable fingerprint of a cart's variants + quantities, used to decide whether
 *  a previously fetched live-stock snapshot is still valid for the cart. */
function itemsKeyOf(
  items: { productId: string; colorId: string; sizeLabel: string; quantity: number }[]
): string {
  return items
    .map((i) => `${i.productId}|${i.colorId}|${i.sizeLabel}|${i.quantity}`)
    .join(',');
}

/** How long a fetchLiveVariantStock result may be reused once the cart
 *  fingerprint hasn't changed. Well under the server's own revalidation gate in
 *  create_retail_order, so reusing a fresh snapshot costs nothing in safety. */
const STOCK_SNAPSHOT_MAX_AGE_MS = 20000;

interface CheckoutForm {
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
}

function toCustomer(f: CheckoutForm): RetailCustomer {
  return {
    name: f.name,
    phone: f.phone,
    email: f.email || undefined,
    address: f.address,
    city: f.city,
    state: f.state,
    pincode: f.pincode,
  };
}

function asDigits(v: string, max: number): string {
  return v.replace(/\D/g, '').slice(0, max);
}

const REQUIRED_FIELDS = ['name', 'phone', 'address', 'city', 'state', 'pincode'] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];

function validateField(key: keyof CheckoutForm, value: string): string | null {
  const v = value.trim();
  switch (key) {
    case 'name':
      return v ? null : 'Please enter your name';
    case 'phone':
      return v.replace(/\D/g, '').length === 10 ? null : 'Please enter a valid 10-digit mobile number';
    case 'address':
      return v ? null : 'Please enter your address';
    case 'city':
      return v ? null : 'Please enter your city';
    case 'state':
      return v ? null : 'Please enter your state';
    case 'pincode':
      return v.replace(/\D/g, '').length === 6 ? null : 'Please enter a valid PIN code';
    default:
      return null;
  }
}

function validateForm(f: CheckoutForm): Partial<Record<RequiredField, string>> {
  const errs: Partial<Record<RequiredField, string>> = {};
  for (const key of REQUIRED_FIELDS) {
    const msg = validateField(key, f[key]);
    if (msg) errs[key] = msg;
  }
  return errs;
}

export function CheckoutPage() {
  const { items, count, subtotal, clear, reconcileWithLiveStock, promo, applyPromo, removeAppliedPromo } = useD2cCart();
  const { openCart } = useCartDrawer();
  const { navigate } = useRouter();
  const shipping = computeShipping(subtotal);
  const placingRef = useRef(false);

  const [form, setForm] = useState<CheckoutForm>(() => {
    try {
      const raw = window.sessionStorage.getItem(CHECKOUT_FORM_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<CheckoutForm>;
        return {
          name: typeof saved.name === 'string' ? saved.name : '',
          phone: typeof saved.phone === 'string' ? saved.phone : '',
          email: typeof saved.email === 'string' ? saved.email : '',
          address: typeof saved.address === 'string' ? saved.address : '',
          city: typeof saved.city === 'string' ? saved.city : '',
          state: typeof saved.state === 'string' ? saved.state : '',
          pincode: typeof saved.pincode === 'string' ? saved.pincode : '',
        };
      }
    } catch {
      // ignore — fall back to an empty form
    }
    return { name: '', phone: '', email: '', address: '', city: '', state: '', pincode: '' };
  });
  const [stage, setStage] = useState<Stage>(() => {
    // If we're landing back from the payment gateway (a pending order ref is
    // stored), start in the confirming state so the transition overlay shows
    // immediately instead of flashing the form while verification runs.
    try {
      return window.sessionStorage.getItem(PENDING_PAYMENT_KEY) ? 'confirming' : 'form';
    } catch {
      return 'form';
    }
  });
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState<RetailOrderResult | null>(null);
  const [errors, setErrors] = useState<Partial<Record<RequiredField, string>>>({});
  const [overlayMsg, setOverlayMsg] = useState('Creating your order…');
  const [liveOrder, setLiveOrder] = useState<LiveOrder | null>(null);
  const [verifyAttempt, setVerifyAttempt] = useState(0);
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const stockSnapshotRef = useRef<{ at: number; itemsKey: string; live: LiveStockMap } | null>(null);

  // Promo code — single source of truth shared with the Cart drawer via the
  // cart context (backed by lib/promo.ts + localStorage). Applying or removing
  // a code here is instantly reflected in the Cart and vice versa.
  const [promoInput, setPromoInput] = useState('');
  const [applying, setApplying] = useState(false);
  const [promoError, setPromoError] = useState('');

  const discount = promoApplies(subtotal, promo) ? computeDiscount(subtotal, promo) : 0;
  const total = subtotal - discount + shipping;

  const set = (key: keyof CheckoutForm, value: string) => {
    if (key === 'phone') value = asDigits(value, 10);
    if (key === 'pincode') value = asDigits(value, 6);
    setForm((f) => ({ ...f, [key]: value }));
    if (REQUIRED_FIELDS.includes(key as RequiredField) && validateField(key, value)) return;
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key as RequiredField];
      return next;
    });
  };

  const scrollAndFocus = (key: RequiredField) => {
    const el = fieldRefs.current[key];
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  };

  const handleApplyPromo = async () => {
    if (applying) return;
    setApplying(true);
    setPromoError('');
    const res = await validatePromo(promoInput, subtotal);
    setApplying(false);
    if (res.ok && res.promo) {
      applyPromo(res.promo);
      setPromoInput('');
    } else {
      setPromoError(res.reason ?? 'This code is invalid or expired.');
    }
  };

  const handleRemovePromo = () => {
    removeAppliedPromo();
    setPromoInput('');
  };

  // Persist the partially-filled delivery form so it survives Cart <-> Checkout
  // navigation (SPA remount) without an abrupt blank/blink. Cleared on success.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(CHECKOUT_FORM_KEY, JSON.stringify(form));
    } catch {
      // ignore — persistence is best-effort
    }
  }, [form]);

  const paymentCfg = getPaymentConfig();

  // Warm the Cashfree SDK in the background as soon as checkout loads so that
  // when the customer clicks Pay the redirect to Cashfree starts without a
  // script-download wait. Scheduled via requestIdleCallback (with a 1.5s
  // fallback) so the SDK download never competes with first paint. Failures are
  // swallowed here — the real open still guards against a missing SDK at submit.
  useEffect(() => {
    if (!paymentCfg.configured) return;
    const win = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      const id = win.requestIdleCallback(() => preloadCashfreeSdk(), { timeout: 1500 });
      return () => { win.cancelIdleCallback?.(id); };
    }
    const t = window.setTimeout(() => preloadCashfreeSdk(), 0);
    return () => window.clearTimeout(t);
  }, [paymentCfg.configured]);

  // Re-validate the cart against live DB stock when checkout loads, so the
  // summary and the Place Order button reflect current availability. If lines
  // changed, reconcile the cart and surface a clear message. Skipped while a
  // post-gateway verification is in flight (the order was already placed).
  useEffect(() => {
    if (items.length === 0) return;
    try {
      if (window.sessionStorage.getItem(PENDING_PAYMENT_KEY)) return;
    } catch {
      // ignore — fall through to the revalidation below
    }
    let cancelled = false;
    (async () => {
      try {
        const live = await fetchLiveVariantStock(items);
        if (cancelled) return;
        // Keep a timestamped snapshot of this check so a same-cart Pay Now
        // click can reuse it instead of paying for a redundant GET before the
        // order is created. The server revalidates stock in create_retail_order
        // as the final gate regardless.
        stockSnapshotRef.current = { at: Date.now(), itemsKey: itemsKeyOf(items), live };
        const { changes } = reconcileCartWithLive(items, live);
        if (changes.changed) {
          setErrorMsg(describeStockChanges(changes) ?? 'Some items changed in your bag.');
          reconcileWithLiveStock(live);
        }
      } catch {
        // Non-blocking: the authoritative server-side check still runs at submit.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a gateway redirect back to #/checkout, ask the secure backend for the
  // verified payment state — never trust the browser's success redirect/params.
  // Runs on mount and again whenever the customer asks to re-verify (badge-level
  // "Try Again"). On success it clears the bag; on definitive failure the order
  // stays reusable so retry never creates a duplicate.
  useEffect(() => {
    if (!paymentCfg.configured) {
      clearPendingKey();
      return;
    }
    let cancelled = false;
    const raw = window.sessionStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return;

    const settleSuccess = (order: Record<string, unknown>) => {
      clearPendingKey();
      clearLiveOrderKey();
      window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
      clear();
      removeAppliedPromo();
      setLiveOrder(null);
      setResult({
        order_id: String(order.id),
        ref: String(order.ref),
        order_type: 'retail',
        total_qty: Number(order.total_qty ?? 0),
        subtotal: Number(order.subtotal ?? 0),
        discount: Number(order.discount ?? 0),
        shipping: Number(order.shipping ?? 0),
        total_amount: Number(order.total_amount ?? 0),
        payment_status: 'success',
        order_status: String(order.order_status ?? 'pending'),
        items: Array.isArray(order.items) ? (order.items as RetailOrderLineSnapshot[]) : [],
        customer: (order.customer as RetailCustomer) ?? undefined,
      });
      setStage('success');
    };

    const settleFailed = () => {
      clearPendingKey();
      setOverlayMsg('Payment Not Completed');
      setErrorMsg(
        "Your payment could not be completed and you have not been charged. Your items are still safe in your bag — try paying again or contact us."
      );
      setStage('failure');
    };

    const confirm = async () => {
      setStage('confirming');
      setOverlayMsg('Confirming your payment…');
      try {
        const pending = JSON.parse(raw) as { ref: string; order_id?: string; total_amount?: number };
        // Keep a handle on the placed order so a failed/uncertain payment can be
        // retried for the SAME order (its session), never a fresh duplicate.
        const pendingLive: LiveOrder | null =
          typeof pending.order_id === 'string' && typeof pending.total_amount === 'number'
            ? { ref: pending.ref, order_id: pending.order_id, amount: pending.total_amount }
            : null;
        if (pendingLive) {
          setLiveOrder(pendingLive);
          persistLiveOrder(pendingLive);
        }

        // Possession gate: the edge function only returns order data to a caller
        // who knows the ref AND the customer's 10-digit phone. If the gateway is
        // still confirming, re-poll a couple of times so the screen feels alive
        // rather than frozen — "almost there" — before giving an honest verdict.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (cancelled) return;
          if (attempt > 0) {
            setOverlayMsg('Almost there — confirming your payment…');
            await new Promise((r) => window.setTimeout(r, 2500));
            if (cancelled) return;
          }
          const v = await verifyPayment(pending.ref, form.phone);
          if (cancelled) return;
          if (v?.verified && v.order) {
            settleSuccess(v.order);
            return;
          }
          if (v?.status === 'failed') {
            settleFailed();
            return;
          }
          if (v?.status === 'success') {
            // Gateway reports paid but we couldn't positively verify (e.g. the
            // caller didn't pass the possession gate). Never loop on this — the
            // customer needs an honest, re-checkable state, not a spinner.
            setOverlayMsg('Still confirming your payment');
            setErrorMsg(
              "Your payment appears to have been received. We're still verifying it — if it doesn't confirm shortly, please refresh or contact us."
            );
            setStage('pending');
            return;
          }
          if (v?.status === 'pending') continue;
          // Verification unavailable / timed out — recoverable, not a dead end.
          setOverlayMsg('Still confirming your payment');
          setErrorMsg(
            "We couldn't confirm your payment right now. Nothing has been charged unless you saw a bank confirmation — please try again or contact us."
          );
          setStage('pending');
          return;
        }
        // Exhausted the poll window while the gateway is still pending.
        setOverlayMsg('Still confirming your payment');
        setErrorMsg(
          "Your bank is still confirming this payment. If you have been charged, your order is safe — please try again or contact us."
        );
        setStage('pending');
      } catch {
        // Keep the pending key; surface an honest error so this never becomes
        // an endless 'confirming' spinner.
        setOverlayMsg('Still confirming your payment');
        setErrorMsg(
          "We couldn't confirm your payment right now. Please try again or contact us — your order is safe."
        );
        setStage('pending');
      }
    };
    confirm();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentCfg.configured, verifyAttempt, clear, removeAppliedPromo]);

  // Drive the full-screen overlay as soon as Pay Now is clicked — before any
  // network call — and keep it up (one continuous screen) until the Cashfree
  // handoff starts. Never surfaces raw backend/gateway errors.
  const failWith = (message: string) => {
    placingRef.current = false;
    setOverlayMsg('Payment Not Completed');
    setErrorMsg(message);
    setStage('failure');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (items.length === 0 || placingRef.current) return;

    // Instant client-side validation FIRST so an invalid form never flashes a
    // loader — the overlay only appears once we're actually about to work.
    const errs = validateForm(form);
    if (REQUIRED_FIELDS.some((k) => errs[k])) {
      setErrors(errs);
      setErrorMsg('');
      const first = REQUIRED_FIELDS.find((k) => errs[k]);
      if (first) scrollAndFocus(first);
      return;
    }
    setErrors({});

    await startCheckout(false);
  };

  // Retry payment for an EXISTING order (never a duplicate). If no reusable
  // order exists (e.g. order creation failed before anything was recorded) fall
  // back to the checkout form so the customer can place a new one.
  const handleRetry = async () => {
    if (placingRef.current) return;
    if (!liveOrder) {
      setErrorMsg('');
      setStage('form');
      return;
    }
    await startCheckout(true);
  };

  const startCheckout = async (reuseOrder: boolean) => {
    if (placingRef.current) return;
    placingRef.current = true;
    setErrorMsg('');
    setOverlayMsg('Creating your order…');
    setStage('creating');

    try {
      let order: Pick<RetailOrderResult, 'ref' | 'order_id' | 'total_amount'>;

      if (reuseOrder && liveOrder) {
        // Same order, new Cashfree session — the stock was already reserved by
        // create_retail_order, so we skip it entirely to avoid a duplicate.
        order = { ref: liveOrder.ref, order_id: liveOrder.order_id, total_amount: liveOrder.amount };
      } else {
        // Authoritative re-validation against live DB stock before any order is
        // created. If stock changed while the customer was shopping, update the
        // cart and abort — never submit a stale/over-quantity order. The server
        // (create_retail_order) re-validates again as the final gate.
        try {
          const itemsKey = itemsKeyOf(items);
          const snap = stockSnapshotRef.current;
          let live: LiveStockMap;
          if (snap && snap.itemsKey === itemsKey && Date.now() - snap.at < STOCK_SNAPSHOT_MAX_AGE_MS) {
            // Cart unchanged and checked recently — reuse the snapshot to skip
            // a redundant network round-trip in the fast path.
            live = snap.live;
          } else {
            live = await fetchLiveVariantStock(items);
            stockSnapshotRef.current = { at: Date.now(), itemsKey, live };
          }
          const { changes } = reconcileCartWithLive(items, live);
          if (changes.changed) {
            const notice = describeStockChanges(changes);
            reconcileWithLiveStock(live);
            setErrorMsg(notice ?? 'Your bag was updated. Please review before placing the order.');
            setStage('form');
            placingRef.current = false;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
          }
        } catch {
          // A transient fetch failure must NOT allow an unvalidated order through.
          // Abort and ask the customer to retry rather than trusting client state.
          setErrorMsg('Could not verify stock right now. Please try again.');
          setStage('form');
          placingRef.current = false;
          return;
        }

        const res = await createRetailOrder({
          customer: toCustomer(form),
          items: items.map((i) => ({
            product_id: i.productId,
            name: i.name,
            code: i.code,
            color_id: i.colorId,
            color: i.color,
            color_hex: i.colorHex,
            size_label: i.sizeLabel,
            quantity: i.quantity,
            // unit_price/line_total intentionally NOT sent — the server re-prices.
          })),
          promoCode: promo?.code ?? null,
        });
        const liveOrderHandle: LiveOrder = {
          ref: res.ref,
          order_id: res.order_id,
          amount: res.total_amount,
        };
        setLiveOrder(liveOrderHandle);
        persistLiveOrder(liveOrderHandle);
        setResult(res);
        order = res;
      }

      await proceedToPayment(order);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[checkout] Order placement failed:', err);
      failWith("We couldn't place your order. Nothing has been charged — please try again or contact us.");
    }
  };

  const proceedToPayment = async (
    order: Pick<RetailOrderResult, 'ref' | 'order_id' | 'total_amount'>
  ) => {
    if (!paymentCfg.configured) {
      // No gateway on this deployment: record the order and finish cleanly.
      clear();
      removeAppliedPromo();
      window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      setStage('success');
      placingRef.current = false;
      return;
    }

    setOverlayMsg('Securing your payment…');
    try {
      const session = await createPaymentSession({
        orderRef: order.ref,
        orderId: order.order_id,
        amount: order.total_amount,
        customer: { name: form.name, phone: form.phone, email: form.email || undefined },
      });
      if (session.status !== 'pending' || !session.paymentSessionId) {
        failWith("We couldn't start the online payment. Your order has not been charged — please try again.");
        return;
      }
      persistPendingKey({ ref: order.ref, order_id: order.order_id, amount: order.total_amount });

      // One continuous screen straight into the Cashfree handoff.
      setOverlayMsg('Taking you to secure payment…');
      const redirected = await openCashfreeCheckout({
        paymentSessionId: session.paymentSessionId,
        environment: session.environment ?? 'TEST',
        redirectTarget: '_self',
      });
      placingRef.current = false;
      if (!redirected) {
        failWith("The payment window could not be opened. Your order has not been charged — please try again.");
        return;
      }

      // Cashfree is about to navigate the tab. If we're somehow still present
      // after a few seconds the hosted page didn't take over — recover instead
      // of leaving the customer on a frozen screen. The order stays safely
      // pending and can be retried for the same order.
      const handoff = await waitForHandoff(4000);
      if (handoff === 'stalled') {
        failWith("The secure payment page didn't open. Your order has not been charged — please try again.");
      }
    } catch (err) {
      // Never surface the raw gateway/technical error. Log it, then present
      // the customer with a clean, recoverable payment-start message.
      // eslint-disable-next-line no-console
      console.error('[checkout] Payment window error:', err);
      failWith("We couldn't start the online payment. Your order has not been charged — please try again.");
    }
  };

  if (
    items.length === 0 &&
    stage !== 'success' &&
    stage !== 'creating' &&
    stage !== 'confirming' &&
    stage !== 'failure' &&
    stage !== 'pending'
  ) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5">
        <p className="font-display text-5xl uppercase tracking-wide-2 text-bone leading-none">Empty</p>
        <p className="mt-3 text-sm text-grey">Your bag is empty.</p>
        <button
          onClick={() => navigate('/collection')}
          className="mt-8 btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
        >
          Shop The Collection
        </button>
      </div>
    );
  }

  /* ---- Success state ---- */
  if (stage === 'success' && result) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
        <CheckCircle2 size={40} strokeWidth={1.4} className="text-bone" />
        <p className="mt-5 font-label text-[10px] uppercase tracking-ultra text-grey">Order Confirmed</p>
        <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-2">
          Thank You
        </h1>
        <p className="mt-4 text-sm text-grey max-w-md leading-relaxed">
          Your order <span className="font-semibold text-bone">#{result.ref}</span> is confirmed and recorded.
          We are processing it and will confirm delivery details soon.
        </p>

        <div className="mt-8 w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-5 lg:gap-6 text-left">
          <div className="space-y-5">
            <div className="w-full border border-line bg-paper-3 p-5">
              <div className="flex justify-between border-b border-line pb-2 text-sm">
                <span className="text-grey">Order</span>
                <span className="font-semibold text-bone">{result.ref}</span>
              </div>
              <div className="flex justify-between border-b border-line py-2 text-sm">
                <span className="text-grey">Items</span>
                <span className="font-semibold text-bone">{result.total_qty}</span>
              </div>
              <div className="flex justify-between border-b border-line py-2 text-sm">
                <span className="text-grey">Payment</span>
                <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone">{result.payment_status === 'success' ? 'PAID' : 'PENDING'}</span>
              </div>
              {result.discount > 0 && (
                <div className="flex justify-between border-b border-line py-2 text-sm">
                  <span className="text-grey">Discount</span>
                  <span className="font-semibold text-green-700">−{formatPrice(result.discount)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 text-sm">
                <span className="text-grey">Total</span>
                <span className="font-price text-lg font-bold text-bone tabular-nums">{formatPrice(result.total_amount)}</span>
              </div>
            </div>

            {result.items && result.items.length > 0 && (
              <div className="w-full border border-line bg-paper-3 p-5">
                <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2">Your Products</p>
                <div className="divide-y divide-line">
                  {result.items.map((it, idx) => (
                    <div key={idx} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="text-bone">{it.name}</p>
                        <p className="text-[11px] text-grey">{it.color} · {it.size_label} × {it.quantity}</p>
                      </div>
                      <span className="text-bone font-medium whitespace-nowrap">{formatPrice(it.line_total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-5">
            {result.customer && (
              <div className="w-full border border-line bg-paper-3 p-5">
                <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-2">Delivery</p>
                <p className="text-sm text-bone">{result.customer.name} · {result.customer.phone}</p>
                {result.customer.email && <p className="text-xs text-grey mt-0.5">{result.customer.email}</p>}
                <p className="text-xs text-grey mt-1 leading-relaxed">
                  {result.customer.address}, {result.customer.city}, {result.customer.state} — {result.customer.pincode}
                </p>
              </div>
            )}

            <div
              className={
                result.payment_status === 'success'
                  ? 'w-full border border-lime-300 bg-lime-50 px-4 py-3 text-xs text-green-800 leading-relaxed'
                  : 'w-full border border-line bg-paper-3 px-4 py-3 text-xs text-grey leading-relaxed'
              }
            >
              {result.payment_status === 'success'
                ? 'Your payment has been verified and received. We are preparing your order for dispatch.'
                : paymentStatusMessage()}
            </div>

            <div className="w-full border border-line bg-paper-3 p-5">
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-3">What Happens Next</p>
              <ol className="space-y-3">
                <li className="flex gap-3 text-sm">
                  <span className="font-label text-bone font-semibold shrink-0">1</span>
                  <span className="text-grey leading-relaxed">We personally review order <span className="text-bone font-medium">{result.ref}</span> — every order is checked by hand.</span>
                </li>
                <li className="flex gap-3 text-sm">
                  <span className="font-label text-bone font-semibold shrink-0">2</span>
                  <span className="text-grey leading-relaxed">Your order is dispatched from Tiruppur within 24-48 hours, with stock confirmed before it ships.</span>
                </li>
                <li className="flex gap-3 text-sm">
                  <span className="font-label text-bone font-semibold shrink-0">3</span>
                  <span className="text-grey leading-relaxed">Track your order anytime with <span className="text-bone font-medium">{result.ref}</span> on the Track Order page — we will also keep you updated on WhatsApp.</span>
                </li>
              </ol>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            onClick={() => navigate(`/track-order/${encodeURIComponent(result.ref)}`)}
            className="btn-soft btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
          >
            <Truck size={15} strokeWidth={2} />
            Track Order
          </button>
          <button
            onClick={() => navigate('/collection')}
            className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Continue Shopping
          </button>
        </div>

        <div className="mt-8 w-full max-w-2xl mx-auto border-t border-line pt-5">
          <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-3">Useful Links</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <a href="#/shipping-policy" className="border border-line px-3 py-2.5 text-center text-grey hover:text-bone hover:border-bone transition-colors">Shipping Policy</a>
            <a href="#/return-policy" className="border border-line px-3 py-2.5 text-center text-grey hover:text-bone hover:border-bone transition-colors">Return Policy</a>
            <a href="#/privacy-policy" className="border border-line px-3 py-2.5 text-center text-grey hover:text-bone hover:border-bone transition-colors">Privacy Policy</a>
            <a href="#/contact" className="border border-line px-3 py-2.5 text-center text-grey hover:text-bone hover:border-bone transition-colors">Contact Us</a>
          </div>
        </div>
      </div>
    );
  }

  /* ---- Payment failure / uncertain results (full-screen overlay) ---- */
  if (stage === 'failure' || stage === 'pending') {
    return (
      <PaymentOverlay
        variant={stage === 'failure' ? 'failure' : 'pending'}
        message={overlayMsg || 'Payment Not Completed'}
        detail={errorMsg}
        onRetry={handleRetry}
        onRefresh={handleRetry}
        onContact={() => navigate('/contact')}
        onBackToBag={() => { openCart(); navigate('/'); }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 md:px-12 lg:px-16 py-8 md:py-14">
      {(stage === 'creating' || stage === 'confirming') && (
        <PaymentOverlay
          variant={stage}
          message={overlayMsg || (stage === 'creating' ? 'Creating your order…' : 'Confirming your payment…')}
          trustLine={paymentCfg.configured ? 'Securing your payment — Cashfree' : undefined}
        />
      )}
      <button
        onClick={() => { openCart(); navigate('/'); }}
        className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 text-grey hover:text-bone transition-colors"
      >
        <ArrowLeft size={14} strokeWidth={2} /> Back To Bag
      </button>
      <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-3">
        Checkout
      </h1>

      <form
        onSubmit={handleSubmit}
        noValidate
        className="mt-8 grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-8 items-start"
      >
        {/* Contact & Delivery */}
        <div className="lg:col-start-1 border border-line p-5 md:p-7">
          <h2 className="font-label text-xs uppercase tracking-wide-2 text-bone font-semibold">Contact & Delivery</h2>

          {stage === 'form' && errorMsg && (
            <p className="mt-4 text-sm text-crimson bg-crimson/5 border border-crimson/20 px-3 py-3">
              {errorMsg}
            </p>
          )}

          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Full Name" value={form.name} onChange={(v) => set('name', v)} autoComplete="name" required inputRef={(el) => { fieldRefs.current.name = el; }} errorMsg={errors.name} />
            <Field label="Phone" value={form.phone} onChange={(v) => set('phone', v)} inputMode="numeric" autoComplete="tel" required placeholder="10-digit mobile number" maxLength={10} inputRef={(el) => { fieldRefs.current.phone = el; }} errorMsg={errors.phone} />
            <Field label="Email (optional)" value={form.email} onChange={(v) => set('email', v)} type="email" autoComplete="email" className="md:col-span-2" />
            <Field label="Address" value={form.address} onChange={(v) => set('address', v)} autoComplete="street-address" required className="md:col-span-2" inputRef={(el) => { fieldRefs.current.address = el; }} errorMsg={errors.address} />
            <Field label="City" value={form.city} onChange={(v) => set('city', v)} autoComplete="address-level2" required inputRef={(el) => { fieldRefs.current.city = el; }} errorMsg={errors.city} />
            <Field label="State" value={form.state} onChange={(v) => set('state', v)} autoComplete="address-level1" required inputRef={(el) => { fieldRefs.current.state = el; }} errorMsg={errors.state} />
            <Field label="PIN Code" value={form.pincode} onChange={(v) => set('pincode', v)} inputMode="numeric" autoComplete="postal-code" required maxLength={6} inputRef={(el) => { fieldRefs.current.pincode = el; }} errorMsg={errors.pincode} />
          </div>
        </div>

        {/* Order Summary — on desktop sits in the right column, on mobile between
            the delivery form and the payment/place-order block */}
        <aside className="lg:col-start-2 lg:row-span-3 border border-line bg-paper-3 p-5 md:p-7">
          <h2 className="font-display text-2xl uppercase tracking-wide-2 text-bone">Order Summary</h2>
          <div className="mt-4 divide-y divide-line border-t border-line">
            {items.map((item) => (
              <div key={`${item.productId}-${item.colorId}-${item.sizeLabel}`} className="flex gap-3 py-3">
                <div className="w-14 h-[72px] shrink-0 border border-line bg-paper-3 overflow-hidden">
                  {item.image && <img src={item.image} alt={item.name} className="w-full h-full object-cover" loading="lazy" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-bone line-clamp-2">{item.name}</p>
                  <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey mt-0.5">
                    {item.color} · {item.sizeLabel} × {item.quantity}
                  </p>
                </div>
                <p className="font-price text-sm font-semibold text-bone tabular-nums whitespace-nowrap">
                  {formatPrice(item.unitPrice * item.quantity)}
                </p>
              </div>
            ))}
          </div>

          {/* Promo code — same component/logic as the Cart drawer */}
          <div className="mt-4 border-t border-line pt-4">
            <div className="flex items-center gap-2">
              <Tag size={13} strokeWidth={1.8} className="text-bone-dim" />
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold">Promo Code</p>
            </div>
            {promo ? (
              <>
                <div className="mt-2 flex items-center justify-between border border-green-300 bg-green-50 px-3 py-2.5">
                  <span className="inline-flex items-center gap-2 text-xs font-semibold text-green-800">
                    <Check size={14} strokeWidth={2.5} /> {promo.code} APPLIED
                  </span>
                  <button
                    type="button"
                    onClick={handleRemovePromo}
                    className="text-[10px] uppercase tracking-wide-2 font-semibold text-green-800 underline underline-offset-2 hover:text-green-900"
                  >
                    Remove
                  </button>
                </div>
                {!promoApplies(subtotal, promo) && (
                  <p className="mt-1.5 text-xs text-grey">
                    Add {formatPrice((promo.min_order_value || 0) - subtotal)} more to use this code — it will not
                    apply at checkout below that amount.
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="mt-2 flex gap-2">
                  <input
                    value={promoInput}
                    onChange={(e) => setPromoInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleApplyPromo(); }}
                    placeholder="Enter promo code"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="flex-1 min-w-0 border border-line bg-white px-3 py-2.5 text-sm text-bone placeholder:text-grey/60 focus:border-bone focus:outline-none transition-colors"
                  />
                  <button
                    type="button"
                    onClick={handleApplyPromo}
                    disabled={applying || !promoInput.trim()}
                    className="inline-flex items-center gap-1.5 shrink-0 bg-bone text-white text-[10px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 hover:bg-bone-dim transition-colors disabled:opacity-40"
                  >
                    {applying ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : 'Apply'}
                  </button>
                </div>
                {promoError && <p className="mt-1.5 text-xs text-crimson">{promoError}</p>}
              </>
            )}
          </div>

          <dl className="mt-3 space-y-2.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-grey">Items ({count})</dt>
              <dd className="font-semibold text-bone tabular-nums">{formatPrice(subtotal)}</dd>
            </div>
            {discount > 0 && (
              <div className="flex items-center justify-between">
                <dt className="text-grey">Discount ({promo?.code})</dt>
                <dd className="font-semibold text-green-700 tabular-nums">−{formatPrice(discount)}</dd>
              </div>
            )}
            <div className="flex items-center justify-between">
              <dt className="text-grey">Shipping</dt>
              <dd className="font-semibold text-bone tabular-nums">
                {shipping > 0 ? formatPrice(shipping) : <span className="text-green-700">FREE</span>}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-grey">
                {shipping > 0 ? 'FREE shipping on orders ₹999+' : "You've unlocked FREE shipping"}
              </p>
            </div>
            <div className="flex items-center justify-between border-t border-line pt-3 mt-3">
              <dt className="font-label text-xs uppercase tracking-wide-2 text-bone">Total</dt>
              <dd className="font-price text-2xl text-bone tabular-nums">{(total || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}</dd>
            </div>
          </dl>
        </aside>

        {/* Payment state (below the form fields; summary appears after it on mobile) */}
        <div className="lg:col-start-1 border border-line bg-paper-3 p-4">
          <div className="flex items-center gap-3">
            <ShieldCheck size={18} strokeWidth={1.6} className="text-bone shrink-0" />
            <div>
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-bone font-semibold">
                Payment
              </p>
              <p className="text-xs text-grey mt-0.5 leading-relaxed">{paymentStatusMessage()}</p>
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={stage === 'creating' || stage === 'confirming'}
          className="lg:col-start-1 w-full btn-dark text-[11px] uppercase tracking-wide-2 font-semibold py-4 px-5 disabled:opacity-60"
        >
          {stage === 'creating' ? (
            <>
              <Loader2 size={16} strokeWidth={2} className="animate-spin" /> Placing Order…
            </>
          ) : stage === 'confirming' ? (
            <>
              <Loader2 size={16} strokeWidth={2} className="animate-spin" /> Confirming Payment…
            </>
          ) : paymentCfg.configured ? (
            `Pay Now${total > 0 ? ` · ${formatPrice(total)}` : ''}`
          ) : (
            `Place Order${total > 0 ? ` · ${formatPrice(total)}` : ''}`
          )}
        </button>

        <p className="lg:col-start-1 text-[11px] leading-relaxed text-grey mt-3">
          Secure, backed by our{' '}
          <a href="#/return-policy" className="text-bone underline hover:text-bone transition-colors">Return Policy</a>,{' '}
          <a href="#/shipping-policy" className="text-bone underline hover:text-bone transition-colors">Shipping Policy</a>{' '}
          and{' '}
          <a href="#/contact" className="text-bone underline hover:text-bone transition-colors">support</a>. Review our{' '}
          <a href="#/privacy-policy" className="text-bone underline hover:text-bone transition-colors">Privacy Policy</a>{' '}
          any time.
        </p>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  className = '',
  inputMode,
  maxLength,
  autoComplete,
  placeholder,
  errorMsg,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  className?: string;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email';
  maxLength?: number;
  autoComplete?: string;
  placeholder?: string;
  errorMsg?: string | null;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="font-label text-[10px] uppercase tracking-wide-2 text-grey">
        {label} {required && <span className="text-bone">*</span>}
      </span>
      <input
        ref={inputRef}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={errorMsg ? true : undefined}
        className={`mt-1.5 w-full border bg-white px-3 py-3 text-sm text-bone placeholder:text-grey/60 focus:outline-none transition-colors ${
          errorMsg ? 'border-crimson focus:border-crimson' : 'border-line focus:border-bone'
        }`}
      />
      {errorMsg && <p className="mt-1.5 text-xs text-crimson" role="alert">{errorMsg}</p>}
    </label>
  );
}
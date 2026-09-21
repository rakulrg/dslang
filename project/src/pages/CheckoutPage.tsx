import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCircle2, ChevronDown, Clock, HelpCircle, Loader2, Search, ShieldCheck, Tag, Truck, XCircle } from 'lucide-react';
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
  PaymentSessionError,
  ORDER_EXPIRED_MESSAGE,
} from '@/lib/payment';
import { openCashfreeCheckout, preloadCashfreeSdk } from '@/lib/cashfreeSdk';
import { fetchLiveVariantStock, reconcileCartWithLive, describeStockChanges } from '@/lib/cartStock';

/**
 * Retail checkout — places the order via the server-side create_retail_order
 * RPC (prices are recomputed there; the client never sends amounts). Payment
 * is powered by Cashfree once configured.
 *
 * Flow:
 *   Pay Now   -> create_retail_order (server re-prices + reserves stock) then,
 *                the instant the Cashfree session is ready, openCashfreeCheckout
 *                hands the tab straight to Cashfree. The ONLY in-flight state is
 *                a disabled Pay Now button — no overlay, no loading screen.
 *   On return -> a single result page driven by a quick, quiet server-side
 *                verification (success / failed / pending) with the order ref.
 */

type Stage = 'form' | 'result';
type ResultVerdict = 'checking' | 'success' | 'failed' | 'pending';

const PENDING_PAYMENT_KEY = 'dslang_pending_order_v1';
const LIVE_ORDER_KEY = 'dslang_live_order_v1';
const CHECKOUT_FORM_KEY = 'dslang_checkout_form_v1';
/** Opt-in "Save this information for next time" copy of the delivery form, kept
 *  across sessions so a returning shopper starts pre-filled. */
const SAVED_CHECKOUT_KEY = 'dslang_saved_checkout_v1';
/** Last confirmed order, kept by OrderStatusPage so a fresh status visit can
 *  reach it without the URL ref. It must be dropped whenever a NEW checkout
 *  begins, otherwise an old order ref would leak onto the next result page. */
const RESULT_KEY = 'dslang_order_result_v1';

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
  /** Cart fingerprint at placement time — a retry only reuses the order while
   *  the cart is unchanged, so a paid session always matches what is in the bag. */
  itemsKey: string;
}

interface PendingPayload extends LiveOrder {
  at: number;
  /** Customer phone (possession factor) so the post-payment result page can
   *  verify/look up the order server-side without re-reading the form. */
  phone?: string;
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

function persistPendingKey(live: LiveOrder & { phone?: string }): void {
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

function clearResultKey(): void {
  try {
    window.localStorage.removeItem(RESULT_KEY);
  } catch {
    // ignore
  }
}

function readPendingPayload(): PendingPayload | null {
  return readSessionValue<PendingPayload | null>(PENDING_PAYMENT_KEY, (raw) => {
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
  });
}

/** Resolves 'unloaded' if the document starts navigating away (the Cashfree
 *  handoff), or 'stalled' if it hasn't after timeoutMs — so the checkout can
 *  recover with an inline error instead of silently doing nothing. */
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

/** Stable fingerprint of a cart's variants + quantities. Used to verify a
 *  live order still matches the customer's bag before it is reused. */
function itemsKeyOf(
  items: { productId: string; colorId: string; sizeLabel: string; quantity: number }[]
): string {
  return items
    .map((i) => `${i.productId}|${i.colorId}|${i.sizeLabel}|${i.quantity}`)
    .join(',');
}

interface CheckoutForm {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  address: string;
  apartment: string;
  city: string;
  state: string;
  pincode: string;
}

function toCustomer(f: CheckoutForm): RetailCustomer {
  return {
    name: [f.firstName, f.lastName].filter(Boolean).join(' '),
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

const REQUIRED_FIELDS = ['firstName', 'lastName', 'phone', 'address', 'city', 'state', 'pincode'] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];

function validateField(key: keyof CheckoutForm, value: string): string | null {
  const v = value.trim();
  switch (key) {
    case 'firstName':
      return v ? null : 'Please enter your first name';
    case 'lastName':
      return v ? null : 'Please enter your last name';
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
    case 'apartment':
    case 'email':
      return null;
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

function readSessionValue<T>(key: string, parse: (raw: string) => T | null): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return parse(raw);
  } catch {
    return null;
  }
}

export function CheckoutPage() {
  const { items, count, subtotal, clear, reconcileWithLiveStock, promo, applyPromo, removeAppliedPromo, reloadFromStorage } = useD2cCart();
  const { openCart } = useCartDrawer();
  const { navigate } = useRouter();
  const shipping = computeShipping(subtotal);
  const placingRef = useRef(false);

  const [form, setForm] = useState<CheckoutForm>(() => {
    const empty: CheckoutForm = {
      firstName: '', lastName: '', phone: '', email: '',
      address: '', apartment: '', city: '', state: '', pincode: '',
    };
    const readRaw = (key: string): Partial<CheckoutForm & { name?: string }> | null => {
      try {
        const raw = window.sessionStorage.getItem(key);
        if (!raw) return null;
        const saved = JSON.parse(raw) as Partial<CheckoutForm & { name?: string }>;
        return saved && typeof saved === 'object' ? saved : null;
      } catch {
        return null;
      }
    };
    // This session's form first; fall back to the saved-for-next-time copy so
    // a shopper who opted in gets their address back on the next checkout.
    const saved = readRaw(CHECKOUT_FORM_KEY) ?? readRaw(SAVED_CHECKOUT_KEY);
    if (!saved) return empty;
    const parts = (typeof saved.name === 'string' ? saved.name.trim() : '').split(/\s+/).filter(Boolean);
    const get = (k: keyof CheckoutForm, legacy?: string) =>
      typeof saved[k] === 'string' ? (saved[k] as string) : legacy ?? '';
    return {
      firstName: get('firstName', parts[0] ?? ''),
      lastName: get('lastName', parts.slice(1).join(' ') ?? ''),
      phone: get('phone'),
      email: get('email'),
      address: get('address'),
      apartment: get('apartment'),
      city: get('city'),
      state: get('state'),
      pincode: get('pincode'),
    };
  });
  // Landing back from the payment gateway (a pending order ref is stored) opens
  // straight into the single result page — never a flash of the form. BUT only
  // when the pending order still belongs to the current cart. If the bag has
  // changed since that order was placed (e.g. an old failed order A from a
  // previous cart), the pending/live/result handles are stale: drop them so a
  // brand-new checkout is created instead of resurrecting the old order ref.
  const [stage, setStage] = useState<Stage>(() => {
    const pending = readPendingPayload();
    if (!pending) return 'form';
    const bagEmpty = items.length === 0;
    const matches = bagEmpty || pending.itemsKey === itemsKeyOf(items);
    if (!matches) {
      clearPendingKey();
      clearLiveOrderKey();
      clearResultKey();
      return 'form';
    }
    return 'result';
  });
  const [verdict, setVerdict] = useState<ResultVerdict>('checking');
  const [placing, setPlacing] = useState(false);
  const [checkingNote, setCheckingNote] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState<RetailOrderResult | null>(null);
  const [errors, setErrors] = useState<Partial<Record<RequiredField, string>>>({});
  const [liveOrder, setLiveOrder] = useState<LiveOrder | null>(() => {
    const v = readSessionValue<LiveOrder | null>(LIVE_ORDER_KEY, (raw) => {
      const parsed = JSON.parse(raw) as LiveOrder;
      if (typeof parsed?.ref === 'string' && typeof parsed?.order_id === 'string' && typeof parsed?.amount === 'number') {
        return { ref: parsed.ref, order_id: parsed.order_id, amount: parsed.amount, itemsKey: typeof parsed.itemsKey === 'string' ? parsed.itemsKey : '' };
      }
      return null;
    });
    if (!v) return null;
    // A live order only belongs to THIS checkout if it still matches the bag.
    // A stale one (old cart) must never be reused for retry or shown as the ref.
    if (items.length > 0 && v.itemsKey !== itemsKeyOf(items)) {
      clearLiveOrderKey();
      return null;
    }
    return v;
  });
  const [verifyAttempt, setVerifyAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [expired, setExpired] = useState(false);
  // Escape hatch: a stuck (pending/failed) order must never be a dead end.
  // After 2-3 manual re-checks or a ~45s window without a resolution, surface
  // "Start New Order" so the customer can always begin a fresh checkout.
  const [recheckCount, setRecheckCount] = useState(0);
  const [showNewOrder, setShowNewOrder] = useState(false);
  // New Shopify-style checkout UI state (layout only — no order data impact).
  const [saveNext, setSaveNext] = useState(false);
  const [billingSame, setBillingSame] = useState(true);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [phoneHelpOpen, setPhoneHelpOpen] = useState(false);
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});

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

  // "Save this information for next time": while ticked, mirror the form into a
  // cross-session key so the NEXT checkout (fresh visit, cleared session) can
  // start pre-filled. Unticking removes the copy.
  useEffect(() => {
    try {
      if (saveNext) {
        window.localStorage.setItem(SAVED_CHECKOUT_KEY, JSON.stringify(form));
      } else {
        window.localStorage.removeItem(SAVED_CHECKOUT_KEY);
      }
    } catch {
      // ignore — persistence is best-effort
    }
  }, [saveNext, form]);

  const paymentCfg = getPaymentConfig();

  // Landing directly on /#/checkout (cold load, bookmark, shared link) must
  // render whatever cart is persisted, even when this context booted BEFORE the
  // items were written (e.g. a late write from another tab). Guarded to 'empty'
  // only: if the context already holds lines the storage read can't see we keep
  // the live context. A genuinely empty cart keeps the empty state below.
  useEffect(() => {
    if (items.length === 0) reloadFromStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warm the Cashfree SDK in the background as soon as checkout loads so that
  // when the customer clicks Pay the redirect to Cashfree starts without a
  // script-download wait. Scheduled via requestIdleCallback (with a 1.5s
  // fallback) so the SDK download never competes with first paint. Also
  // preconnects to the Cashfree checkout hosts so the hand-off POST lands on a
  // warm TLS connection. Failures are swallowed here — the real open still
  // guards against a missing SDK at submit.
  useEffect(() => {
    if (!paymentCfg.configured) return;
    const hosts = ['https://payments.cashfree.com', 'https://sandbox.cashfree.com', 'https://api.cashfree.com'];
    const links: HTMLLinkElement[] = [];
    for (const href of hosts) {
      const existing = document.querySelector<HTMLLinkElement>(`link[rel="preconnect"][href="${href}"]`);
      if (existing) {
        links.push(existing);
        continue;
      }
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = href;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
      links.push(link);
    }
    const win = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      const id = win.requestIdleCallback(() => preloadCashfreeSdk(), { timeout: 1500 });
      return () => {
        win.cancelIdleCallback?.(id);
        for (const link of links) link.remove();
      };
    }
    const t = window.setTimeout(() => preloadCashfreeSdk(), 0);
    return () => {
      window.clearTimeout(t);
      for (const link of links) link.remove();
    };
  }, [paymentCfg.configured]);

  // Re-validate the cart against live DB stock when checkout loads (background,
  // non-blocking): if lines changed, reconcile the cart and surface a clear
  // message. The authoritative server-side check ALWAYS re-runs inside
  // create_retail_order at submit, so this is a UX nicety — not a gate — and it
  // never delays Pay Now. Skipped while a post-gateway verification is in
  // flight (the order was already placed and stock already reserved).
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
        const { changes } = reconcileCartWithLive(items, live);
        if (changes.changed) {
          const notice = describeStockChanges(changes);
          reconcileWithLiveStock(live);
          setErrorMsg(notice ?? 'Some items changed in your bag.');
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
  // Runs quietly on the already-shown result page: it opens in "checking", does
  // a short quiet poll (never a separate loading screen), then settles on one
  // clean result. On success it clears the bag; on definitive failure the order
  // stays reusable so retry never creates a duplicate.
  useEffect(() => {
    if (!paymentCfg.configured) {
      clearPendingKey();
      return;
    }
    let cancelled = false;
    const raw = window.sessionStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return;

    let pending: PendingPayload;
    try {
      pending = JSON.parse(raw) as PendingPayload;
    } catch {
      clearPendingKey();
      return;
    }
    if (typeof pending.ref !== 'string' || !pending.ref) {
      clearPendingKey();
      return;
    }
    // Keep a handle on the placed order so a failed/uncertain payment can be
    // retried for the SAME order (its session), never a fresh duplicate.
    const pendingLive: LiveOrder | null =
      typeof pending.order_id === 'string' && typeof pending.amount === 'number'
        ? {
            ref: pending.ref,
            order_id: pending.order_id,
            amount: pending.amount,
            itemsKey: typeof pending.itemsKey === 'string' ? pending.itemsKey : '',
          }
        : null;
    if (pendingLive) {
      setLiveOrder(pendingLive);
      persistLiveOrder(pendingLive);
    }

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
      setVerdict('success');
    };

    const settleFailed = (msg?: string) => {
      clearPendingKey();
      setCheckingNote('');
      setVerdict('failed');
      setErrorMsg(
        msg ??
          "Your payment could not be completed and you have not been charged. Your items are still safe in your bag — try paying again or contact us."
      );
    };

    const attempt = async (): Promise<'idle' | 'pending'> => {
      const v = await verifyPayment(pending.ref, form.phone);
      if (cancelled) return 'idle';
      if (v?.verified && v.order) {
        settleSuccess(v.order);
        return 'idle';
      }
      if (v?.status === 'failed') {
        const o = v.order as Record<string, unknown> | null;
        if (o?.stock_restored_at) {
          // The sweep (or an admin) reclaimed this order's stock while payment
          // was still being confirmed — the reservation is gone, so retrying
          // could over-sell. Surface the clear message and direct to a new
          // checkout instead of offering "Try Again".
          clearLiveOrderKey();
          setLiveOrder(null);
          setExpired(true);
          settleFailed(ORDER_EXPIRED_MESSAGE);
        } else {
          settleFailed();
        }
        return 'idle';
      }
      if (v?.status === 'success') {
        // Gateway reports paid but we couldn't positively verify (e.g. the
        // caller didn't pass the possession gate). Never loop — the customer
        // needs an honest, re-checkable state, not a spinner.
        setVerdict('pending');
        setCheckingNote(
          "Your payment appears to have been received. We're still verifying it — re-check below or contact us if it doesn't confirm shortly."
        );
        return 'idle';
      }
      return 'pending';
    };

    const confirm = async () => {
      setStage('result');
      setVerdict('checking');
      setCheckingNote('Confirming your payment…');
      for (let i = 0; i < 3; i++) {
        const done = await attempt();
        if (done === 'idle') return;
        if (cancelled) return;
        // Short, quiet backoff — the result page is already visible; this is
        // just a non-blocking re-check on the SAME screen.
        await new Promise((r) => window.setTimeout(r, i === 0 ? 700 : 1200));
        if (cancelled) return;
      }
      setVerdict('pending');
      setCheckingNote(
        "Your payment is still being confirmed. If you have been charged, your order is safe — re-check below or contact us."
      );
    };
    confirm();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentCfg.configured, verifyAttempt, clear, removeAppliedPromo]);

  // Time-window escape hatch: if payment never resolves (stuck "Still
  // Confirming" / "Payment Not Completed"), offer "Start New Order" after a
  // short wait so the customer is never trapped on a stale result screen.
  useEffect(() => {
    if (stage !== 'result' || verdict === 'success') return;
    if (verdict !== 'pending' && verdict !== 'failed' && verdict !== 'checking') return;
    const t = window.setTimeout(() => setShowNewOrder(true), 45000);
    return () => window.clearTimeout(t);
  }, [stage, verdict]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (items.length === 0 || placingRef.current) return;

    // Instant client-side validation FIRST so an invalid form never triggers a
    // network call — the button only ever shows its micro-state in flight.
    const errs = validateForm(form);
    if (REQUIRED_FIELDS.some((k) => errs[k])) {
      setErrors(errs);
      setErrorMsg('');
      const first = REQUIRED_FIELDS.find((k) => errs[k]);
      if (first) scrollAndFocus(first);
      return;
    }
    setErrors({});

    void startCheckout(Boolean(liveOrder));
  };

  const startCheckout = async (reuseOrder: boolean) => {
    if (placingRef.current) return;
    placingRef.current = true;
    setPlacing(true);
    setErrorMsg('');

    // Kick the SDK download NOW so it overlaps order + session creation —
    // by the time the Cashfree link is ready the SDK is warm and the handoff
    // starts instantly. Idempotent: the module caches its loading promise.
    preloadCashfreeSdk();

    const t0 = performance.now();
    try {
      let order: Pick<RetailOrderResult, 'ref' | 'order_id' | 'total_amount'>;

      if (reuseOrder && liveOrder && liveOrder.itemsKey === itemsKeyOf(items)) {
        // Same order, new Cashfree session — stock was already reserved and the
        // cart still matches, so reuse it to avoid a duplicate.
        order = { ref: liveOrder.ref, order_id: liveOrder.order_id, total_amount: liveOrder.amount };
      } else {
        // Authoritative order creation: the server re-prices every line,
        // re-validates stock as the final gate, reserves inventory and records
        // the order. There is deliberately NO client-side stock pre-flight
        // round-trip here — the server check is authoritative and the 20s-old
        // snapshot on the checkout page keeps the bag honest in the meantime.
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
        // A brand-new order was created for this cart — anything the gateway
        // result page might remember from an OLD order is stale, drop it so a
        // later order-status visit can never resurrect the previous ref.
        clearResultKey();
        const liveOrderHandle: LiveOrder = {
          ref: res.ref,
          order_id: res.order_id,
          amount: res.total_amount,
          itemsKey: itemsKeyOf(items),
        };
        setLiveOrder(liveOrderHandle);
        persistLiveOrder(liveOrderHandle);
        setResult(res);
        order = res;
      }

      const finished = await proceedToPayment(order);
      if (finished && import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.info(`[checkout] Pay Now -> Cashfree handoff in ${Math.round(performance.now() - t0)}ms`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[checkout] Order placement failed:', err);
      // Keep liveOrder if the order was already created — the next Pay Now
      // reuses it (no duplicate), so the inline failure is always retryable.
      setErrorMsg(err instanceof Error ? err.message : "We couldn't place your order. Nothing has been charged — please try again or contact us.");
      if (stage === 'form') {
        setStage('form');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  };

  const proceedToPayment = async (
    order: Pick<RetailOrderResult, 'ref' | 'order_id' | 'total_amount'>
  ): Promise<boolean> => {
    if (!paymentCfg.configured) {
      // No gateway on this deployment: record the order and finish cleanly.
      clear();
      removeAppliedPromo();
      window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      setVerdict('success');
      setStage('result');
      return true;
    }

    let session;
    try {
      session = await createPaymentSession({
        orderRef: order.ref,
        orderId: order.order_id,
        amount: order.total_amount,
        customer: { name: toCustomer(form).name, phone: form.phone, email: form.email || undefined },
      });
    } catch {
      throw new Error("We couldn't start the online payment. Your order has not been charged — please try again.");
    }
    if (session.status !== 'pending' || !session.paymentSessionId) {
      throw new Error("We couldn't start the online payment. Your order has not been charged — please try again.");
    }
    persistPendingKey({
      ref: order.ref,
      order_id: order.order_id,
      amount: order.total_amount,
      itemsKey: itemsKeyOf(items),
      phone: String(form.phone ?? '').replace(/\D/g, '').slice(-10),
    });

    // The moment the session is ready, hand straight to Cashfree — no pause,
    // no transition, no text. The tab navigates to the hosted checkout.
    let redirected = false;
    try {
      redirected = await openCashfreeCheckout({
        paymentSessionId: session.paymentSessionId,
        environment: session.environment ?? 'TEST',
        redirectTarget: '_self',
      });
    } catch {
      throw new Error("The payment window could not be opened. Your order has not been charged — please try again.");
    }
    if (!redirected) {
      throw new Error("The payment window could not be opened. Your order has not been charged — please try again.");
    }

    // Cashfree is about to navigate the tab. If we're somehow still present
    // after a few seconds the hosted page didn't take over — recover with an
    // inline error instead of doing nothing. The order stays pending and can
    // be retried for the SAME order.
    const handoff = await waitForHandoff(4000);
    if (handoff === 'stalled') {
      throw new Error("The secure payment page didn't open. Your order has not been charged — please try again.");
    }
    return true;
  };

  /** Resolves the existing order for a retry — NEVER creates a new one. The
   *  reservation (and promo/cart state) belongs to the original order, so a
   *  retry reuses its ref/id/amount. The order is ONLY retried while it still
   *  matches the current bag (itemsKey) — if the cart has changed since the
   *  order was placed, it must not be resurrected and paid for a new cart. */
  const retryHandle = (): LiveOrder | null => {
    const bagEmpty = items.length === 0;
    const matchesBag = (key: string) => bagEmpty || key === itemsKeyOf(items);
    if (liveOrder?.order_id && matchesBag(liveOrder.itemsKey)) return liveOrder;
    if (result?.order_id && result?.ref && (result?.total_amount ?? 0) > 0) {
      return { ref: result.ref, order_id: result.order_id, amount: result.total_amount, itemsKey: itemsKeyOf(items) };
    }
    const pending = readPendingPayload();
    if (pending?.order_id && pending.amount > 0 && matchesBag(pending.itemsKey)) {
      return { ref: pending.ref, order_id: pending.order_id, amount: pending.amount, itemsKey: pending.itemsKey };
    }
    return null;
  };

  const startNewCheckout = () => {
    clearPendingKey();
    clearLiveOrderKey();
    clearResultKey();
    setLiveOrder(null);
    setResult(null);
    setExpired(false);
    setVerdict('checking');
    setCheckingNote('');
    setErrorMsg('');
    setStage('form');
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  };

  /** Retry for a failed payment: ONLY the session-creation step for the SAME
   *  order, then an immediate redirect — no create_retail_order, no promo/cart
   *  logic, no shared "confirming" loading screen (the SDK is already warm). */
  const handleRetryPayment = async () => {
    if (placingRef.current) return;
    const handle = retryHandle();
    if (!handle) {
      setErrorMsg("We couldn't find the payment session for this order. Please place the order again.");
      return;
    }
    placingRef.current = true;
    setPlacing(true);
    setRetrying(true);
    setErrorMsg('');
    try {
      // The SDK download is already cached (preloaded at checkout load + first
      // Pay Now), so the handoff below is instant once the session returns.
      preloadCashfreeSdk();
      const session = await createPaymentSession({
        orderRef: handle.ref,
        orderId: handle.order_id,
        amount: handle.amount,
        customer: { name: toCustomer(form).name || 'DSLANG Customer', phone: form.phone, email: form.email || undefined },
      });
      if (session.status !== 'pending' || !session.paymentSessionId) {
        throw new Error('The online payment could not be started. Your order has not been charged.');
      }
      persistPendingKey({
        ref: handle.ref,
        order_id: handle.order_id,
        amount: handle.amount,
        itemsKey: itemsKeyOf(items),
        phone: asDigits(form.phone, 10),
      });
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
        // The reservation is gone (swept/admin-restocked): drop the retry
        // handles so a refresh doesn't re-offer a dead order, and let the
        // "Start New Checkout" CTA take over.
        clearPendingKey();
        clearLiveOrderKey();
        setLiveOrder(null);
        setExpired(true);
      }
      setErrorMsg(err instanceof Error ? err.message : 'The payment could not be started. Your order has not been charged.');
    } finally {
      placingRef.current = false;
      setPlacing(false);
      setRetrying(false);
    }
  };

  if (items.length === 0 && stage === 'form' && !liveOrder) {
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

  /* ---- Single result page (returning from Cashfree) ---- */
  if (stage === 'result' && verdict === 'success' && result) {
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

  if (stage === 'result') {
    // Success / pending / still-checking / failed — ONE clean result page.
    const isSuccess = verdict === 'success';
    const isChecking = verdict === 'checking';
    const isPending = verdict === 'pending';
    const isFailed = verdict === 'failed';
    const ref = result?.ref ?? liveOrder?.ref ?? '';
    const orderId = result?.order_id ?? liveOrder?.order_id ?? '';
    const amount = result?.total_amount ?? liveOrder?.amount ?? 0;

    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
        <div
          className="relative flex h-14 w-14 items-center justify-center rounded-full bg-blush"
          role={isChecking ? 'status' : undefined}
          aria-live={isChecking ? 'polite' : undefined}
        >
          {isSuccess ? (
            <>
              <CheckCircle2 size={36} strokeWidth={1.5} className="text-crimson animate-scale-in" />
              <span className="absolute inset-0 rounded-full border border-crimson/25 animate-fade-in" aria-hidden />
            </>
          ) : isChecking ? (
            <Loader2 size={32} strokeWidth={1.5} className="animate-spin text-crimson" />
          ) : isPending ? (
            <Clock size={30} strokeWidth={1.4} className="text-crimson" />
          ) : (
            <XCircle size={32} strokeWidth={1.4} className="text-crimson" />
          )}
        </div>

        <p className="mt-5 font-label text-[10px] uppercase tracking-ultra text-grey">
          {isSuccess ? 'Order Confirmed' : isChecking ? 'Payment' : isPending ? 'Payment Pending' : 'Order'}
        </p>
        <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-2">
          {isSuccess ? 'Order Complete' : isChecking ? 'Confirming Payment' : isPending ? 'Still Confirming' : 'Payment Not Completed'}
        </h1>

        <div className="mt-4 space-y-1 text-sm text-grey">
          {ref && (
            <p>
              Order <span className="font-semibold text-bone">#{ref}</span>
            </p>
          )}
          {amount > 0 && (
            <p className="font-price text-lg font-bold text-bone tabular-nums">{formatPrice(amount)}</p>
          )}
          {orderId && isPending && (
            <p className="text-[11px] text-grey/70">{orderId}</p>
          )}
        </div>

        <p className="mt-4 text-sm text-grey max-w-md leading-relaxed">
          {checkingNote || errorMsg ||
            "Your payment could not be completed and you have not been charged. Your items are still safe in your bag — try paying again or contact us."}
        </p>
        {isFailed && !expired && (
          <p className="mt-2 text-xs text-grey/70 max-w-md leading-relaxed">
            Nothing has been charged. The order stays reserved for {ref ? `reference #${ref}` : 'you'} so paying again is quick and safe.
          </p>
        )}

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {!isChecking && (
            <button
              type="button"
              onClick={() => {
                if (isPending) {
                  setRecheckCount((n) => n + 1);
                  if (recheckCount + 1 >= 2) setShowNewOrder(true);
                  setVerifyAttempt((n) => n + 1);
                } else if (expired) {
                  startNewCheckout();
                } else {
                  void handleRetryPayment();
                }
              }}
              disabled={placing}
              className="btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
            >
              {placing ? (
                <>
                  <Loader2 size={15} strokeWidth={2} className="animate-spin" /> {retrying ? 'Paying Again…' : 'Placing Order…'}
                </>
              ) : isPending ? (
                'Re-check Status'
              ) : expired ? (
                'Start New Checkout'
              ) : (
                'Try Again'
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate('/collection')}
            className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Continue Shopping
          </button>
          {showNewOrder && !expired && (isPending || isFailed) && (
            <button
              type="button"
              onClick={startNewCheckout}
              className="btn-soft border border-crimson/60 text-crimson text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-crimson hover:text-paper transition-colors"
            >
              Start New Order
            </button>
          )}
        </div>
        {showNewOrder && !expired && (isPending || isFailed) && (
          <p className="mt-4 text-[11px] text-grey max-w-md leading-relaxed">
            Still stuck? Start a fresh order instead — your current bag is untouched and a new reference will be created.
          </p>
        )}

        {isFailed && (
          <p className="mt-6 text-[11px] text-grey">
            Need help?{' '}
            <a href="#/contact" className="text-bone underline hover:text-bone transition-colors">Contact us</a>
            {' '}or{' '}
            <a href="#/refund-and-cancellation" className="text-bone underline hover:text-bone transition-colors">refund & cancellation policy</a>.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 md:px-8 py-8">
      <button
        onClick={() => { openCart(); navigate('/'); }}
        className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 text-grey hover:text-bone transition-colors"
      >
        <ArrowLeft size={14} strokeWidth={2} /> Back To Bag
      </button>

      <form onSubmit={handleSubmit} noValidate className="mt-7">
        {errorMsg && (
          <p className="mb-6 text-sm text-crimson bg-crimson/5 border border-crimson/20 px-3 py-3" role="alert">
            {errorMsg}
          </p>
        )}

        {/* Delivery — full-width stacked fields with in-box placeholder labels */}
        <section>
          <h2 className="font-label text-xl font-bold tracking-tight text-bone">Delivery</h2>
          <div className="mt-5 space-y-3">
            <SelectField label="Country/Region" value="India" onChange={() => {}} autoComplete="country">
              <option value="India">India</option>
            </SelectField>
            <Field
              label="First name"
              value={form.firstName}
              onChange={(v) => set('firstName', v)}
              autoComplete="given-name"
              required
              inputRef={(el) => { fieldRefs.current.firstName = el; }}
              errorMsg={errors.firstName}
            />
            <Field
              label="Last name"
              value={form.lastName}
              onChange={(v) => set('lastName', v)}
              autoComplete="family-name"
              required
              inputRef={(el) => { fieldRefs.current.lastName = el; }}
              errorMsg={errors.lastName}
            />
            <Field
              label="Address"
              value={form.address}
              onChange={(v) => set('address', v)}
              autoComplete="street-address"
              required
              inputRef={(el) => { fieldRefs.current.address = el; }}
              errorMsg={errors.address}
              icon={<Search size={16} strokeWidth={2} />}
            />
            <Field
              label="Apartment, suite, etc. (optional)"
              value={form.apartment}
              onChange={(v) => set('apartment', v)}
              autoComplete="address-line2"
            />
            <Field
              label="City"
              value={form.city}
              onChange={(v) => set('city', v)}
              autoComplete="address-level2"
              required
              inputRef={(el) => { fieldRefs.current.city = el; }}
              errorMsg={errors.city}
            />
            <SelectField
              label="State"
              value={form.state}
              onChange={(v) => set('state', v)}
              autoComplete="address-level1"
              required
              elRef={(el) => { fieldRefs.current.state = el; }}
              errorMsg={errors.state}
              placeholder="State"
            >
              {form.state && !INDIAN_STATES.includes(form.state) && <option value={form.state}>{form.state}</option>}
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </SelectField>
            <Field
              label="PIN code"
              value={form.pincode}
              onChange={(v) => set('pincode', v)}
              inputMode="numeric"
              autoComplete="postal-code"
              required
              maxLength={6}
              inputRef={(el) => { fieldRefs.current.pincode = el; }}
              errorMsg={errors.pincode}
            />
            <Field
              label="Phone"
              value={form.phone}
              onChange={(v) => set('phone', v)}
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              required
              maxLength={10}
              inputRef={(el) => { fieldRefs.current.phone = el; }}
              errorMsg={errors.phone}
              icon={
                <button
                  type="button"
                  onClick={() => setPhoneHelpOpen((o) => !o)}
                  aria-expanded={phoneHelpOpen}
                  aria-label="Why we need your phone number"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line-2 text-grey transition-colors hover:border-bone-dim hover:text-bone"
                >
                  <HelpCircle size={11} strokeWidth={2} />
                </button>
              }
            />
            {phoneHelpOpen && (
              <p className="rounded-soft border border-line bg-paper-3 px-3.5 py-2.5 text-xs leading-relaxed text-bone-soft">
                We use this number to send delivery updates and to confirm your order.
              </p>
            )}
            <Field
              label="Email (optional)"
              value={form.email}
              onChange={(v) => set('email', v)}
              type="email"
              autoComplete="email"
            />
          </div>

          <button
            type="button"
            onClick={() => setSaveNext((s) => !s)}
            className="mt-4 inline-flex items-center gap-2.5 text-left"
          >
            <CheckboxSquare checked={saveNext} />
            <span className="text-[13px] text-grey">Save this information for next time</span>
          </button>
        </section>

        {/* Shipping method */}
        <section className="mt-9">
          <h2 className="font-label text-xl font-bold tracking-tight text-bone">Shipping method</h2>
          <div className="mt-4">
            {!form.address.trim() ? (
              <div className="rounded-soft border border-line bg-paper-3 px-4 py-4 text-[13px] italic text-bone-soft">
                Enter your shipping address to view available shipping methods.
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-soft border border-line bg-white px-4 py-4">
                <Truck size={20} strokeWidth={1.6} className="shrink-0 text-bone-soft" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-bone">Standard Shipping</p>
                  <p className="text-xs text-grey">
                    {shipping === 0 ? 'FREE' : formatPrice(shipping)}
                    {form.city ? ` to ${form.city}` : ''}{form.state ? `, ${form.state}` : ''}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Payment — one live method (Cashfree). COD/Snapmint are NOT enabled — business decisions, per spec. */}
        <section className="mt-9">
          <h2 className="font-label text-xl font-bold tracking-tight text-bone">Payment</h2>
          <p className="mt-1 text-xs text-grey">All transactions are secure and encrypted.</p>
          <div className="mt-4">
            <RadioOption
              selected
              title="Cashfree Payments"
              sub="(UPI, Cards, Int'l cards, Wallets)"
              onClick={() => {}}
              badges={
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded border border-line px-1.5 py-0.5 font-label text-[9px] uppercase tracking-wide-2 text-bone-soft">UPI</span>
                  <span className="rounded border border-line px-1.5 py-0.5 font-label text-[9px] uppercase tracking-wide-2 text-bone-soft">Card</span>
                  <span className="rounded border border-line px-1.5 py-0.5 font-label text-[9px] uppercase tracking-wide-2 text-bone-soft">+11</span>
                </span>
              }
            />
          </div>
        </section>

        {/* Billing address */}
        <section className="mt-9">
          <h2 className="font-label text-xl font-bold tracking-tight text-bone">Billing address</h2>
          <div className="mt-4 space-y-2.5">
            <RadioOption
              selected={billingSame}
              title="Same as shipping address"
              onClick={() => setBillingSame(true)}
            />
            <RadioOption
              selected={!billingSame}
              title="Use a different billing address"
              onClick={() => setBillingSame(false)}
            />
          </div>
          {!billingSame && (
            <p className="mt-3 rounded-soft border border-line bg-paper-3 px-4 py-3 text-xs leading-relaxed text-bone-soft">
              Your billing details are collected securely by the payment gateway when you pay.
              The delivery address above is always used for shipping.
            </p>
          )}
        </section>

        {/* Discount — collapsed pill that opens the promo entry */}
        <div className="mt-8">
          {!promo && (
            <button
              type="button"
              onClick={() => setDiscountOpen((o) => !o)}
              aria-expanded={discountOpen}
              className="flex w-full items-center justify-center gap-2 rounded-full border border-line-2 bg-white px-5 py-3 text-sm font-semibold text-bone transition-colors hover:border-bone-dim"
            >
              <Tag size={15} strokeWidth={2} className="text-bone-soft" />
              Add discount
              <ChevronDown size={15} strokeWidth={2} className={`text-bone-soft transition-transform ${discountOpen ? 'rotate-180' : ''}`} />
            </button>
          )}
          {discountOpen && !promo && (
            <div className="mt-2.5 animate-slide-down">
              <div className="flex gap-2">
                <input
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleApplyPromo(); }}
                  placeholder="Enter promo code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-soft border border-line-2 bg-white px-3.5 py-3 text-sm text-bone placeholder:text-grey focus:border-bone focus:outline-none transition-colors"
                />
                <button
                  type="button"
                  onClick={handleApplyPromo}
                  disabled={applying || !promoInput.trim()}
                  className="btn-dark shrink-0 text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 disabled:opacity-40"
                >
                  {applying ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : 'Apply'}
                </button>
              </div>
              {promoError && <p className="mt-1.5 text-xs text-crimson">{promoError}</p>}
            </div>
          )}
          {promo && (
            <div className="flex items-center justify-between rounded-soft border border-green-300 bg-green-50 px-4 py-3">
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-green-800">
                <Check size={15} strokeWidth={2.5} /> {promo.code} APPLIED
              </span>
              <button
                type="button"
                onClick={handleRemovePromo}
                className="text-[10px] uppercase tracking-wide-2 font-semibold text-green-800 underline underline-offset-2 hover:text-green-900"
              >
                Remove
              </button>
            </div>
          )}
          {promo && !promoApplies(subtotal, promo) && (
            <p className="mt-1.5 text-xs text-grey">
              Add {formatPrice((promo.min_order_value || 0) - subtotal)} more to use this code — it will not
              apply at checkout below that amount.
            </p>
          )}
        </div>

        {/* Total — compact row; chevron opens the itemized breakdown */}
        <div className="mt-8">
          <div className="flex items-center gap-3">
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-3">
              {items[0]?.image && (
                <img src={items[0].image} alt={items[0].name} className="h-full w-full object-cover" loading="lazy" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-bold leading-tight text-bone">Total</p>
              <p className="text-xs text-grey">{count} {count === 1 ? 'item' : 'items'}</p>
            </div>
            <span className="text-xs text-grey">INR</span>
            <span className="font-price text-xl font-bold text-bone tabular-nums">
              {(total || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <button
              type="button"
              onClick={() => setShowBreakdown((o) => !o)}
              aria-expanded={showBreakdown}
              aria-label={showBreakdown ? 'Hide order summary' : 'Show order summary'}
              className="shrink-0 text-grey transition-colors hover:text-bone"
            >
              <ChevronDown size={18} strokeWidth={2} className={`transition-transform ${showBreakdown ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {showBreakdown && (
            <div className="mt-4 animate-slide-down rounded-soft border border-line bg-paper-2 p-4">
              <div className="divide-y divide-line">
                {items.map((item) => (
                  <div key={`${item.productId}-${item.colorId}-${item.sizeLabel}`} className="flex gap-3 py-2.5">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded border border-line bg-paper-3">
                      {item.image && <img src={item.image} alt={item.name} className="h-full w-full object-cover" loading="lazy" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-xs font-semibold text-bone">{item.name}</p>
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
              <dl className="mt-3 space-y-2 border-t border-line pt-3 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-grey">Items ({count})</dt>
                  <dd className="font-semibold text-bone tabular-nums">{formatPrice(subtotal)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-grey">Shipping</dt>
                  <dd className="font-semibold text-bone tabular-nums">
                    {shipping > 0 ? formatPrice(shipping) : <span className="text-green-700">FREE</span>}
                  </dd>
                </div>
                {discount > 0 && (
                  <div className="flex items-center justify-between">
                    <dt className="text-grey">Discount ({promo?.code})</dt>
                    <dd className="font-semibold text-green-700 tabular-nums">−{formatPrice(discount)}</dd>
                  </div>
                )}
                <div className="flex items-center justify-between border-t border-line pt-3">
                  <dt className="font-label text-xs uppercase tracking-wide-2 text-bone">Total</dt>
                  <dd className="font-price text-xl text-bone tabular-nums">{(total || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        {/* Primary CTA — same order + Cashfree redirect flow as before */}
        <button
          type="submit"
          disabled={placing}
          className="mt-6 w-full btn-dark text-[11px] uppercase tracking-wide-2 font-semibold py-4 px-5 disabled:opacity-60"
        >
          {placing ? (
            <>
              <Loader2 size={16} strokeWidth={2} className="animate-spin" /> Placing Order…
            </>
          ) : paymentCfg.configured ? (
            `Pay Now${total > 0 ? ` · ${formatPrice(total)}` : ''}`
          ) : (
            `Place Order${total > 0 ? ` · ${formatPrice(total)}` : ''}`
          )}
        </button>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[11px] text-grey">
          <a href="#/return-policy" className="underline underline-offset-2 transition-colors hover:text-bone">Refund policy</a>
          <a href="#/shipping-policy" className="underline underline-offset-2 transition-colors hover:text-bone">Shipping</a>
          <a href="#/privacy-policy" className="underline underline-offset-2 transition-colors hover:text-bone">Privacy policy</a>
          <a href="#/terms-and-conditions" className="underline underline-offset-2 transition-colors hover:text-bone">Terms of service</a>
        </div>
      </form>
    </div>
  );
}

/** Middle-rounded bordered text input with an in-box placeholder label (no
 *  floating label above). Trailing `icon` renders inside the box's right edge. */
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
  errorMsg,
  inputRef,
  icon,
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
  errorMsg?: string | null;
  inputRef?: React.Ref<HTMLInputElement>;
  icon?: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="sr-only">{label}{required ? ' (required)' : ''}</span>
      <span
        className={`relative flex w-full items-center rounded-soft border bg-white transition-colors focus-within:border-bone ${
          errorMsg ? 'border-crimson' : 'border-line-2'
        }`}
      >
        <input
          ref={inputRef}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          inputMode={inputMode}
          maxLength={maxLength}
          autoComplete={autoComplete}
          placeholder={label}
          aria-invalid={errorMsg ? true : undefined}
          className="w-full min-w-0 bg-transparent px-3.5 py-3 text-[15px] leading-snug text-bone placeholder:text-grey focus:outline-none"
        />
        {icon && <span className="relative z-10 shrink-0 pr-3 text-grey">{icon}</span>}
      </span>
      {errorMsg && <p className="mt-1.5 text-xs text-crimson" role="alert">{errorMsg}</p>}
    </label>
  );
}

/** Dropdown variant of the bordered box — custom chevron on the right edge. */
function SelectField({
  label,
  value,
  onChange,
  required,
  className = '',
  autoComplete,
  errorMsg,
  elRef,
  placeholder,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  className?: string;
  autoComplete?: string;
  errorMsg?: string | null;
  elRef?: React.Ref<HTMLSelectElement>;
  placeholder?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="sr-only">{label}{required ? ' (required)' : ''}</span>
      <span
        className={`relative flex w-full items-center rounded-soft border bg-white transition-colors focus-within:border-bone ${
          errorMsg ? 'border-crimson' : 'border-line-2'
        }`}
      >
        <select
          ref={elRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          autoComplete={autoComplete}
          aria-invalid={errorMsg ? true : undefined}
          className={`w-full min-w-0 appearance-none bg-transparent px-3.5 py-3 text-[15px] leading-snug focus:outline-none ${
            value ? 'text-bone' : 'text-grey'
          }`}
        >
          {placeholder && <option value="" disabled>{placeholder}</option>}
          {children}
        </select>
        <span className="pointer-events-none shrink-0 pr-3 text-grey">
          <ChevronDown size={16} strokeWidth={2} />
        </span>
      </span>
      {errorMsg && <p className="mt-1.5 text-xs text-crimson" role="alert">{errorMsg}</p>}
    </label>
  );
}

/** Full-width option card with a radio dot — crimson for the selected state. */
function RadioOption({
  selected,
  title,
  sub,
  onClick,
  badges,
}: {
  selected: boolean;
  title: string;
  sub?: string;
  onClick: () => void;
  badges?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-soft border px-4 py-3.5 text-left transition-colors ${
        selected ? 'border-crimson bg-crimson/5' : 'border-line-2 bg-white hover:border-bone-dim'
      }`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
          selected ? 'border-crimson' : 'border-bone-dim/50'
        }`}
        aria-hidden
      >
        {selected && <span className="h-2.5 w-2.5 rounded-full bg-crimson" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold leading-snug text-bone">{title}</span>
        {sub && <span className="mt-0.5 block text-xs leading-snug text-grey">{sub}</span>}
      </span>
      {badges}
    </button>
  );
}

/** Small square checkbox used for the "Save this information for next time" row. */
function CheckboxSquare({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
        checked ? 'border-crimson bg-crimson text-white' : 'border-line-2 bg-white text-transparent'
      }`}
      aria-hidden
    >
      <Check size={12} strokeWidth={3} />
    </span>
  );
}

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh',
  'Lakshadweep', 'Puducherry',
];
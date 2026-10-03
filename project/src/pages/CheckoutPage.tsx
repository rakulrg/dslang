import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCircle2, ChevronDown, Clock, HelpCircle, Loader2, Search, ShieldCheck, Tag, Truck, XCircle } from 'lucide-react';
import { useD2cCart } from '@/lib/d2cCart';
import { useCartDrawer } from '@/lib/cartDrawer';
import { useRouter } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';
import { computeShipping } from '@/lib/settings';
import { createRetailOrder, convertRetailOrderToCod, type RetailOrderResult, type RetailCustomer, type RetailOrderLineSnapshot, type RetailPaymentMethod } from '@/lib/orders';
import { invokeFunction } from '@/lib/rest';
import { validatePromo, computeDiscount, promoApplies } from '@/lib/promo';
import { isIndianPincode } from '@/lib/pincodes';
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
import { NO_AWB_NOTICE, shippingStatusMessage } from '@/lib/shipping';
import { PaymentMethodsRow } from '@/components/PaymentMethodIcons';
import { ConfettiBurst } from '@/components/ConfettiBurst';
import { addCheckoutHistory } from '@/lib/trackHistory';
import { useAuth } from '@/lib/auth';
import { SaveDetailsPrompt } from '@/components/SaveDetailsPrompt';
import { customerToProfile, saveProfile, loadSavedProfile, attachOrderToUser } from '@/lib/account';

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
  /** Cart fingerprint at placement time - a retry only reuses the order while
   *  the cart is unchanged, so a paid session always matches what is in the bag. */
  itemsKey: string;
  /** COD orders never reach the Cashfree
   *  session or retry paths. */
  is_cod?: boolean;
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

// `email` is REQUIRED from this change on. The order-confirmation email is a
// genuine customer notification, and it can only be delivered if the order
// carries an address — every historical order placed before this was left
// untouched, and none of them have one (see the admin Audit Trail, which shows
// "no email on file" for them rather than inventing one).
//
// It was deliberately NOT made a login/OTP/password requirement: guest checkout
// stays exactly as it was — one field more to fill, and nothing else changes
// about ordering, payment or the COD flow.
const REQUIRED_FIELDS = ['firstName', 'lastName', 'phone', 'email', 'address', 'city', 'state', 'pincode'] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];
/** Every validated field is now a required one, so this is simply the union. */
type ValidatedField = RequiredField;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateField(key: keyof CheckoutForm, value: string): string | null {
  const v = value.trim();
  switch (key) {
    case 'firstName':
      return v ? null : 'Please enter your first name';
    case 'lastName':
      return v ? null : 'Please enter your last name';
    case 'phone': {
      const digits = v.replace(/\D/g, '');
      if (digits.length !== 10 || !/^[6-9]/.test(digits)) return 'Please enter a valid phone number';
      return null;
    }
    case 'address':
      return v ? null : 'Please enter your address';
    case 'city':
      return v ? null : 'Please enter your city';
    case 'state':
      return v ? null : 'Please enter your state';
    case 'pincode':
      return isIndianPincode(v) ? null : 'Please enter a valid pincode';
    case 'email':
      // Required: the order-confirmation email is sent to this address.
      if (!v) return 'Please enter your email for order updates';
      return EMAIL_RE.test(v) ? null : 'Enter a valid email address';
    case 'apartment':
      return null;
    default:
      return null;
  }
}

function validateForm(f: CheckoutForm): Partial<Record<ValidatedField, string>> {
  const errs: Partial<Record<ValidatedField, string>> = {};
  // 'email' is inside REQUIRED_FIELDS, so it is validated (and marked missing)
  // here exactly like every other required field.
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
  const { user } = useAuth();
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
  const [errors, setErrors] = useState<Partial<Record<ValidatedField, string>>>({});
  const [liveOrder, setLiveOrder] = useState<LiveOrder | null>(() => {
    const v = readSessionValue<LiveOrder | null>(LIVE_ORDER_KEY, (raw) => {
      const parsed = JSON.parse(raw) as LiveOrder;
      if (typeof parsed?.ref === 'string' && typeof parsed?.order_id === 'string' && typeof parsed?.amount === 'number') {
        // `is_cod` MUST survive the round-trip through sessionStorage. If it is
        // dropped here, a rehydrated COD handle looks like an online one and gets
        // reused for an online payment — which the server then refuses, leaving
        // the shopper unable to buy that cart online at all.
        return {
          ref: parsed.ref,
          order_id: parsed.order_id,
          amount: parsed.amount,
          itemsKey: typeof parsed.itemsKey === 'string' ? parsed.itemsKey : '',
          is_cod: parsed.is_cod === true,
        };
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
  const [discountOpen, setDiscountOpen] = useState(false);
  const [phoneHelpOpen, setPhoneHelpOpen] = useState(false);
  // Order summary collapsed on first paint. The collapsed header always shows
  // the payable amount, so the total is never hidden — only the per-item
  // breakdown and the price roll-up wait for a tap. Same behaviour at every
  // width, so the chevron is the single source of truth for its state.
  const [summaryOpen, setSummaryOpen] = useState(false);
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});

  // Promo code — single source of truth shared with the Cart drawer via the
  // cart context (backed by lib/promo.ts + localStorage). Applying or removing
  // a code here is instantly reflected in the Cart and vice versa.
  const [promoInput, setPromoInput] = useState('');
  const [applying, setApplying] = useState(false);
  const [promoError, setPromoError] = useState('');
  // Payment method: online via Cashfree, or COD (paid IN FULL by the delivery
  // agent — no advance, no online payment at all). Only 'cod' is sent to the
  // RPC. Persisted with the form so a failed-payment return to checkout (SPA
  // remount) restores the same selection — the displayed payable must always
  // match the reserved order, never silently switch the shopper to the other
  // method.
  const [paymentMethod, setPaymentMethod] = useState<RetailPaymentMethod>(() => {
    try {
      const raw = window.sessionStorage.getItem(CHECKOUT_FORM_KEY);
      if (!raw) return 'online';
      const saved = JSON.parse(raw) as { paymentMethod?: string };
      return saved?.paymentMethod === 'cod' ? 'cod' : 'online';
    } catch {
      return 'online';
    }
  });

  const discount = promoApplies(subtotal, promo) ? computeDiscount(subtotal, promo) : 0;
  const total = subtotal - discount + shipping;

  // Client-side DISPLAY math mirroring the server (create_retail_order) — the
  // server stays authoritative and re-computes every figure; these are only
  // used to show the shopper what will be charged.
  //   * COD:   the FULL amount, collected by the delivery agent. No online
  //            discount, no advance, no handling fee, and Cashfree is never
  //            called. ₹0 is charged now.
  //   * online: fixed ₹50 off the ORDER TOTAL after the promo (capped at the
  //            order value) and the whole reduced amount is charged now.
  //            Note this is the post-promo, shipping-inclusive total, NOT the
  //            "Sale Price" the summary headline shows — that one is the
  //            undiscounted product subtotal, purely for display.
  // Math.max(NaN, 0) is NaN, so a non-finite total must be floored to 0 rather
  // than propagated: the payment cards and the CTA would otherwise render a
  // non-amount. The server remains authoritative and re-prices every order.
  const safeTotal = Number.isFinite(total) ? Math.max(total, 0) : 0;
  const onlineDiscount = Math.min(50, safeTotal);
  const onlineTotal = safeTotal - onlineDiscount;
  // COD is never charged online — the entire total is due at delivery.
  const codDue = safeTotal;
  const payableNow = paymentMethod === 'cod' ? 0 : onlineTotal;

  // Pay Now gate: re-validated from the live form on every render (not just on
  // the error display state) so the button hard-blocks the moment anything is
  // invalid — before order creation or a Cashfree handoff can be reached.
  const set = (key: keyof CheckoutForm, value: string) => {
    if (key === 'phone') value = asDigits(value, 10);
    if (key === 'pincode') value = asDigits(value, 6);
    setForm((f) => ({ ...f, [key]: value }));
    // Live validation on every change: re-validate THIS field and refresh its
    // inline error immediately (clear when valid, show when invalid) — errors
    // never wait for a submit.
    const err = validateField(key, value);
    setErrors((prev) => {
      const k = key as ValidatedField;
      if (!err) {
        if (!(k in prev)) return prev;
        const next = { ...prev };
        delete next[k];
        return next;
      }
      return { ...prev, [k]: err };
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

  /**
   * Switching the payment method must never let a stale online total survive
   * into a COD order, or a pending Cashfree session leak into the new method.
   *
   * The displayed totals are derived from `paymentMethod` on every render, so
   * the numbers themselves recalculate immediately. What is NOT derived are the
   * side effects of a previous attempt, and those are dropped here:
   *   * a pending-payment record for a session that belongs to the OTHER method
   *     (a COD order must never resume an online session),
   *   * an error left over from the previous method's attempt.
   * A live order is intentionally kept: it still holds this cart's stock
   * reservation, and startCheckout only reuses it for the online path.
   */
  const changePaymentMethod = (next: RetailPaymentMethod) => {
    if (next === paymentMethod) return;
    setPaymentMethod(next);
    clearPendingKey();
    setErrorMsg('');
    setExpired(false);
    setVerdict('checking');
    setCheckingNote('');
  };

  // Persist the partially-filled delivery form so it survives Cart <-> Checkout
  // navigation (SPA remount) without an abrupt blank/blink. Cleared on success.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(CHECKOUT_FORM_KEY, JSON.stringify({ ...form, paymentMethod }));
    } catch {
      // ignore — persistence is best-effort
    }
  }, [form, paymentMethod]);

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

  // Signed-in prefill: a returning shopper with a saved profile gets their
  // address back on checkout. Priority stays storage-first (this session's form
  // or their opted-in local copy win); the profile only fills a BLANK checkout.
  // Loads through supabase-js (owned row via RLS) and silently no-ops on any
  // error — a missing migration never affects the guest path.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const hasStored =
          Boolean(window.sessionStorage.getItem(CHECKOUT_FORM_KEY)) ||
          Boolean(window.localStorage.getItem(SAVED_CHECKOUT_KEY));
        if (hasStored || cancelled) return;
        const p = await loadSavedProfile(user.id);
        if (cancelled || !p) return;
        const [firstName = '', ...rest] = (p.name || '').trim().split(/\s+/);
        setForm({
          firstName,
          lastName: rest.join(' '),
          phone: p.phone.replace(/\D/g, '').slice(0, 10),
          email: p.email ?? '',
          address: p.address,
          apartment: p.apartment ?? '',
          city: p.city,
          state: p.state,
          pincode: p.pincode,
        });
      } catch {
        // ignore — prefill is best-effort
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

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
        is_cod: Boolean(order.is_cod),
        payment_discount: Number(order.payment_discount ?? 0),
        amount_paid_upfront: Number(order.amount_paid_upfront ?? 0),
        amount_due_on_delivery: Number(order.amount_due_on_delivery ?? 0),
        items: Array.isArray(order.items) ? (order.items as RetailOrderLineSnapshot[]) : [],
        customer: (order.customer as RetailCustomer) ?? undefined,
      });
      addCheckoutHistory(String(order.ref), form.phone);
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
    // network call. The button stays enabled so this path is actually reachable;
    // each bad field already renders its own red message directly beneath
    // itself, so the summary this replaced was only ever a second copy of them.
    const errs = validateForm(form);
    if (Object.keys(errs).length > 0) {
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
    // COD never reaches a gateway, so it does not preload the SDK at all.
    if (paymentMethod !== 'cod') preloadCashfreeSdk();

    const t0 = performance.now();
    try {
      let order: Pick<RetailOrderResult, 'ref' | 'order_id' | 'total_amount' | 'amount_paid_upfront' | 'is_cod'>;

      if (reuseOrder && liveOrder && liveOrder.itemsKey === itemsKeyOf(items) && !liveOrder.is_cod) {
        // An order already exists and its stock is reserved. Two cases:
        //
        // 1. The method is UNCHANGED (online -> online). Reuse it verbatim: same
        //    order, new Cashfree session, no duplicate stock reservation.
        //
        // 2. The shopper just switched ONLINE -> COD. The reserved order is still
        //    an online row (is_cod = false, payment_status 'pending'), so
        //    confirming it as COD would produce an order the admin New Orders
        //    tab never shows and that expire-stale-orders would then cancel and
        //    restock. Calling create_retail_order() again instead would reserve
        //    the same stock a SECOND time. So the existing order is re-priced
        //    server-side, in place, keeping exactly one reservation.
        if (paymentMethod === 'cod') {
          // Any gateway state for the OLD online attempt is now stale.
          clearResultKey();
          clearPendingKey();
          const converted = await convertRetailOrderToCod(liveOrder.ref, form.phone);
          const liveOrderHandle: LiveOrder = {
            ref: converted.ref,
            order_id: converted.order_id,
            amount: 0,
            itemsKey: itemsKeyOf(items),
            is_cod: true,
          };
          setLiveOrder(liveOrderHandle);
          persistLiveOrder(liveOrderHandle);
          setResult(converted);
          order = {
            ref: converted.ref,
            order_id: converted.order_id,
            total_amount: converted.total_amount,
            amount_paid_upfront: converted.amount_paid_upfront,
            is_cod: true,
          };
        } else {
          order = { ref: liveOrder.ref, order_id: liveOrder.order_id, total_amount: liveOrder.amount, is_cod: false };
        }
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
          paymentMethod,
        });
        // A brand-new order was created for this cart — anything the gateway
        // result page might remember from an OLD order is stale, drop it so a
        // later order-status visit can never resurrect the previous ref.
        clearResultKey();
        const liveOrderHandle: LiveOrder = {
          ref: res.ref,
          order_id: res.order_id,
          amount: res.amount_paid_upfront ?? res.total_amount,
          itemsKey: itemsKeyOf(items),
          is_cod: Boolean(res.is_cod),
        };
        setLiveOrder(liveOrderHandle);
        persistLiveOrder(liveOrderHandle);
        setResult(res);
        order = res;
        if (user) {
          // Non-blocking account link + silent details save — never gates the
          // purchase flow. Both fail softly, and a claimed/guest order stays
          // fully trackable meanwhile.
          //
          // The phone is passed because the claim RPC now requires email AND
          // phone to match; `form.phone` is the number captured on this order
          // two lines above, so it is the proof, not a guess.
          void attachOrderToUser(res.ref, form.phone);
          void saveProfile(user.id, customerToProfile(toCustomer(form), form.apartment));
        }
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
    order: Pick<RetailOrderResult, 'ref' | 'order_id' | 'total_amount' | 'amount_paid_upfront' | 'is_cod'>
  ): Promise<boolean> => {
    /* ------------------------------------------------------------------ *
     * COD short-circuit. The order is already created, confirmed and
     * inventory-reserved by the time we get here, and the server stored
     * amount_paid_upfront = 0 for it. There is nothing to charge and nobody
     * to charge it to, so the flow ENDS here: no Cashfree session, no
     * /payment/return, no pending-payment record. The customer goes straight
     * to the confirmation screen with the full amount due on delivery.
     * ------------------------------------------------------------------ */
    if (order.is_cod || paymentMethod === 'cod') {
      clear();
      removeAppliedPromo();
      clearPendingKey();
      window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      addCheckoutHistory(order.ref, form.phone);
      setVerdict('success');
      setStage('result');
      return true;
    }

    if (!paymentCfg.configured) {
      // No gateway on this deployment: record the order and finish cleanly.
      clear();
      removeAppliedPromo();
      window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      addCheckoutHistory(order.ref, form.phone);
      setVerdict('success');
      setStage('result');
      return true;
    }

    let session;
    try {
      // The client-sent amount is IGNORED server-side (cashfree-order re-reads
      // amount_paid_upfront from the DB) — it exists only for display.
      const payableNow = order.amount_paid_upfront ?? order.total_amount;
      session = await createPaymentSession({
        orderRef: order.ref,
        orderId: order.order_id,
        amount: payableNow,
        customer: { name: toCustomer(form).name, phone: form.phone, email: form.email || undefined },
      });
    } catch (err) {
      // A PaymentSessionError already carries an honest, server-authored
      // message and code (ALREADY_PAID, ORDER_EXPIRED, ORDER_NOT_PAYABLE,
      // COD_NO_ONLINE_PAYMENT). Replacing it with a blanket "has not been
      // charged" would tell a customer who HAS paid that they were not charged,
      // so only genuinely unexpected failures get the generic wording.
      if (err instanceof PaymentSessionError) throw err;
      throw new Error("We couldn't start the online payment. Your order has not been charged — please try again.");
    }
    if (session.status !== 'pending' || !session.paymentSessionId) {
      throw new Error("We couldn't start the online payment. Your order has not been charged — please try again.");
    }
    persistPendingKey({
      ref: order.ref,
      order_id: order.order_id,
      amount: order.amount_paid_upfront ?? order.total_amount,
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
    // A COD order has amount_paid_upfront = 0 and never had a payment session,
    // so it can never be "retried" — there is nothing to retry. Refusing it here
    // keeps a COD order from ever being handed to the Cashfree retry path.
    const codGuard = (h: LiveOrder | null): LiveOrder | null =>
      h && (h.is_cod || paymentMethod === 'cod') ? null : h;
    if (liveOrder?.order_id && matchesBag(liveOrder.itemsKey)) return codGuard(liveOrder);
    if (result?.order_id && result?.ref && (result?.total_amount ?? 0) > 0) {
      return codGuard({ ref: result.ref, order_id: result.order_id, amount: result.amount_paid_upfront ?? result.total_amount, itemsKey: itemsKeyOf(items), is_cod: Boolean(result.is_cod) });
    }
    const pending = readPendingPayload();
    if (pending?.order_id && pending.amount > 0 && matchesBag(pending.itemsKey)) {
      return codGuard({ ref: pending.ref, order_id: pending.order_id, amount: pending.amount, itemsKey: pending.itemsKey });
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

  // COD order-confirmation email.
  //
  // A COD order is confirmed the moment the server commits it, and it never
  // touches Cashfree — so the paid-flip trigger that sends the ONLINE
  // confirmation could never fire for it, and COD customers got no mail at all.
  //
  // This watches for a settled COD result and asks the `cod-order-mail` edge
  // function to send it. The function is authoritative: it takes only the order
  // ref and the customer's 10-digit phone (the same possession factors
  // cashfree-status and track_lookup_order use), then re-reads the order, and
  // only mails a genuinely confirmed COD order. So this effect is a *trigger*,
  // not the decision: it cannot make a failed/cancelled order look confirmed,
  // cannot choose a recipient, and cannot alter any figure in the mail.
  //
  // Idempotent end to end — the function refuses a second 'confirmed' send
  // using retail_orders.last_email_kind, so re-running this on a retry, a
  // double-tap, or a page refresh that re-hydrates `result` still produces
  // exactly one email. Failures are swallowed: a mail problem must never fail
  // or roll back an order the server has already confirmed.
  useEffect(() => {
    const ref = result?.ref;
    if (!result?.is_cod || !ref) return;
    const phone = form.phone;
    if (!phone) return;
    let cancelled = false;
    void (async () => {
      try {
        await invokeFunction<{ ok?: boolean; sent?: boolean }>('cod-order-mail', {
          orderRef: ref,
          phone,
        });
      } catch {
        // Best-effort. Never surface a mail failure to the shopper and never
        // let it affect the order they just placed.
      } finally {
        void cancelled;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [result?.ref, result?.is_cod, form.phone]);

  if (items.length === 0 && stage === 'form' && !liveOrder) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5">
        <p className="font-display text-5xl uppercase tracking-wide-2 text-bone leading-none">Empty</p>
        <p className="mt-3 text-sm text-grey">Your bag is empty.</p>
        <button
          onClick={() => navigate('/collections')}
          className="mt-8 btn-dark text-[14px] uppercase tracking-wide-2 font-semibold px-7 py-4"
        >
          Shop The Collection
        </button>
      </div>
    );
  }

  /* ---- Single result page (returning from Cashfree) ---- */
  if (stage === 'result' && verdict === 'success' && result) {
    /* Cash on Delivery is one amount, collected on arrival. Read straight from
       the order row; never recomputed. */
    const codDue = result.amount_due_on_delivery ?? result.total_amount;
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
        {/* Fixed-layer celebration, mounted beside the mark rather than inside
            it: it is anchored to the viewport's bottom corners, not to this
            card, so nesting it in the 56px span would only misrepresent that.
            It renders a <div>, which is not valid inside a <span>. */}
        <ConfettiBurst />
        <span className="order-placed-badge">
          {/* The one place in the flow where the check is drawn rather than
              borrowed from lucide: the mark has to pop and the check has to draw
              itself in, and an <svg> icon carries no dash to animate. The disc is
              a sibling so the check stays painted on top of it, and the paths
              inherit their stroke from CSS (see .order-placed-badge__check). */}
          <span className="order-placed-badge__disc" />
          <svg
            className="order-placed-badge__check"
            viewBox="0 0 24 24"
            width="34"
            height="34"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M20 6.5 9.2 17.3 4 12.1" />
          </svg>
        </span>
        <p className="mt-5 font-label text-[10px] uppercase tracking-ultra text-grey">Order Confirmed</p>
        <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-2">
          Thank You
        </h1>
        <p className="mt-4 text-sm text-grey max-w-md leading-relaxed">
          Your order <span className="font-semibold text-bone">#{result.ref}</span> is confirmed and recorded.
          {result.is_cod
            ? ` Pay ${formatPrice(codDue)} to the delivery agent on arrival.`
            : ' We are processing it and will confirm delivery details soon.'}
        </p>

        <div className="mt-8 w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-5 lg:gap-6 text-left">
          <div className="space-y-5">
            <div className="panel p-5">
              <div className="flex justify-between border-b border-line pb-2 text-sm">
                <span className="text-grey">Order</span>
                <span className="font-semibold text-bone">{result.ref}</span>
              </div>
              <div className="flex justify-between border-b border-line py-2 text-sm">
                <span className="text-grey">Items</span>
                <span className="font-semibold text-bone">{result.total_qty}</span>
              </div>
              {/* Shipping is a fact in its own right, and at this moment the
                  only honest one is "we have not handed it to a courier yet".
                  No AWB, no courier and no movement are implied. */}
              <div className="flex justify-between border-b border-line py-2 text-sm">
                <span className="text-grey">Shipping</span>
                <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone">
                  {shippingStatusMessage('pending')}
                </span>
              </div>
              <p className="py-2 text-xs text-grey">{NO_AWB_NOTICE}</p>
              <div className="flex justify-between border-b border-line py-2 text-sm">
                <span className="text-grey">Payment</span>
                <span className="font-label text-[10px] uppercase tracking-wide-2 font-semibold text-bone">
                  {result.is_cod
                    ? 'CASH ON DELIVERY'
                    : result.payment_status === 'success'
                      ? 'PAID'
                      : 'PENDING'}
                </span>
              </div>
              {result.is_cod ? (
                /* One amount for the agent to collect on arrival. */
                <div className="flex justify-between border-b border-line py-2 text-sm">
                  <span className="text-grey">Amount due on delivery</span>
                  <span className="font-semibold text-bone">{formatPrice(codDue)}</span>
                </div>
              ) : (
                result.payment_status === 'success' && (
                  <div className="flex justify-between border-b border-line py-2 text-sm">
                    <span className="text-grey">Paid</span>
                    <span className="font-semibold text-green-700">{formatPrice(result.amount_paid_upfront ?? result.total_amount)}</span>
                  </div>
                )
              )}
              {result.discount > 0 && (
                <div className="flex justify-between border-b border-line py-2 text-sm">
                  <span className="text-grey">Discount</span>
                  <span className="font-semibold text-green-700">−{formatPrice(result.discount)}</span>
                </div>
              )}
              {!result.is_cod && (result.payment_discount ?? 0) > 0 && (
                <div className="flex justify-between border-b border-line py-2 text-sm">
                  <span className="text-grey">Online Payment Discount</span>
                  <span className="font-semibold text-green-700">−{formatPrice(result.payment_discount ?? 0)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 text-sm">
                <span className="text-grey">
                  {result.is_cod
                    ? 'Total (Cash on Delivery)'
                    : (result.payment_discount ?? 0) > 0
                      ? 'Online Payment Total'
                      : 'Total'}
                </span>
                <span className="font-price text-lg font-bold text-bone tabular-nums">
                  {formatPrice(
                    result.is_cod ? codDue : (result.amount_paid_upfront ?? result.total_amount)
                  )}
                </span>
              </div>
            </div>

            {result.items && result.items.length > 0 && (
              <div className="panel p-5">
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
            {/* Customer/delivery details are deliberately NOT repeated here.
                They were entered two screens ago, they are already on the
                order, and Track Order re-displays them for anyone who needs
                them. Echoing the full address back adds nothing and makes the
                confirmation feel like a receipt. */}
            <div
              className={
                result.payment_status === 'success'
                  ? 'w-full border border-lime-300 bg-lime-50 px-4 py-3 text-xs text-green-800 leading-relaxed'
                  : 'w-full rounded-card border border-bone/20 bg-white px-4 py-3 text-xs text-bone-dim leading-relaxed'
              }
            >
              {result.is_cod
                ? `Order ${result.ref} is confirmed. Pay ${formatPrice(codDue)} to the delivery agent when your order arrives.`
                : result.payment_status === 'success'
                  ? 'Your payment has been verified and received. We are preparing your order for dispatch.'
                  : paymentStatusMessage()}
            </div>

            {/* One plain sentence, no origin, no process theatre. The dispatch
                window is the only forward-looking fact a shopper actually
                needs at this moment. */}
            <div className="rounded-card border border-bone/20 bg-white px-4 py-3">
              <p className="text-sm text-bone-dim leading-relaxed">
                Your order will be dispatched within 24–48 hours.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            onClick={() => navigate(`/track-order/${encodeURIComponent(result.ref)}`)}
            className="btn-primary text-[14px] uppercase tracking-wide-2 font-semibold px-7 py-4"
          >
            <Truck size={15} strokeWidth={2} />
            Track Order
          </button>
          <button
            onClick={() => navigate('/collections')}
            className="btn-soft border border-bone-dim text-bone text-[14px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Continue Shopping
          </button>
        </div>

        <SaveDetailsPrompt customer={result.customer} apartment={form.apartment} />

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
    // The result page shows ONE paragraph for three different situations:
    // progress copy while we are still confirming, the failure reason once we
    // know it, and a generic "not charged" line as a last resort. Only the last
    // two are errors, so the colour is derived from the state rather than from
    // the string - the wording stays byte-for-byte what it was.
    const noteIsError = Boolean(errorMsg) || isFailed;
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
              <CheckCircle2 size={36} strokeWidth={1.5} className="text-bone animate-scale-in" />
              <span className="absolute inset-0 rounded-full border border-bone/25 animate-fade-in" aria-hidden />
            </>
          ) : isChecking ? (
            <Loader2 size={32} strokeWidth={1.5} className="animate-spin text-bone" />
          ) : isPending ? (
            <Clock size={30} strokeWidth={1.4} className="text-bone" />
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

        <p className={`mt-4 text-sm max-w-md leading-relaxed ${noteIsError ? 'text-crimson' : 'text-grey'}`}>
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
              className="btn-primary text-[14px] uppercase tracking-wide-2 font-semibold px-7 py-4"
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
            onClick={() => navigate('/collections')}
            className="btn-soft border border-bone-dim text-bone text-[14px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Continue Shopping
          </button>
          {/* Track Order is offered from EVERY post-checkout state that still
              has a live order, not just the success page: a pending payment and
              a failed payment both leave a real, reserved order behind, and
              those are exactly the visits where a customer wants to see it.
              Gated on `!expired` because a swept / restocked order no longer
              exists to track. TrackOrderPage picks the phone back up from this
              browser's own checkout history, so nothing is added to the URL. */}
          {ref && !expired && (isPending || isFailed) && (
            <button
              type="button"
              onClick={() => navigate(`/track-order/${encodeURIComponent(ref)}`)}
              className="btn-soft border border-bone-dim text-bone text-[14px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
            >
              <Truck size={15} strokeWidth={2} />
              Track Order
            </button>
          )}
          {showNewOrder && !expired && (isPending || isFailed) && (
            <button
              type="button"
              onClick={startNewCheckout}
              className="btn-soft border border-bone text-bone text-[14px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
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
      <div className="shell shell--form py-8">
        <button
          onClick={() => { openCart(); navigate('/'); }}
          className="inline-flex items-center gap-2 text-[14px] uppercase tracking-wide-2 text-grey hover:text-bone transition-colors"
        >
          <ArrowLeft size={14} strokeWidth={2} /> Back To Bag
        </button>

      {/* Desktop splits the two halves of the job: delivery on the left, the
          whole purchase (discount, summary, payment, CTA) on the right. The
          ratio leans slightly toward the summary, which is the denser of the
          two once the payment method moved into it. Below lg it collapses to
          a single column in the same DOM order, i.e. exactly the previous
          mobile layout. */}
      <form
        onSubmit={handleSubmit}
        noValidate
        className="mt-7 grid grid-cols-1 items-start gap-y-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-x-8 xl:gap-x-10"
      >
        {errorMsg && (
          <p className="mb-6 lg:col-span-2 text-sm text-crimson border border-bone/25 bg-bone/5 px-3 py-3 rounded-soft" role="alert">
            {errorMsg}
          </p>
        )}

        {/* Customer details column. Everything up to the discount is the
            "who and where" half of checkout. */}
        <div className="min-w-0">
        {/* Delivery — NO outer panel. The form sits directly on the page with
            the section's own gutters providing the side padding, so the whole
            checkout reads as one continuous surface instead of a card inside a
            card. Row pairing is decided per pair: first/last name stay side by
            side at every width (the two shortest labels, and the pairing the
            screenshots call for), while City/State and PIN/Phone only pair from
            sm up, where two real inputs still fit legibly. Address, Apartment
            and Email are always full width. */}
        <section>
          {/* One step below the Payment heading, so the delivery block reads as
              context rather than as the page's subject. */}
          {/* Same typography as the TRACK ORDER heading (see TrackOrderPage.tsx): the
              display face, uppercase, `tracking-wide-2`, and no weight class —
              Anton is a single-weight face, so `font-bold` would only be a
              SYNTHETIC emboldening that smears the strokes. Deliberately NOT
              copied from there are the SIZE and the line-height: this heading
              keeps its own `text-xl` and its inherited line-height, because a
              section title at the top of the checkout form must not jump to the
              page-title scale. Colour, position and the `mt-5` below it are
              untouched. */}
        <h2 className="font-display text-xl uppercase tracking-wide-2 text-bone">Delivery</h2>
          <div className="mt-5 space-y-3">
            {/* First + Last pair at EVERY width. Both are short single-word
                labels, so two columns still leave ~160px each on a 360px
                screen — enough for a real name. This is the one row the
                screenshots require to be side by side on mobile. */}
            <div className="grid grid-cols-2 gap-3">
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
            </div>
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
            <div className="grid gap-3 sm:grid-cols-2">
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
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
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
                <p className="rounded-soft border border-bone/20 bg-white px-3.5 py-2.5 text-xs leading-relaxed text-bone-dim sm:col-span-2">
                  We use this number to send delivery updates and to confirm your order.
                </p>
              )}
            </div>
            <Field
              label="Email"
              value={form.email}
              onChange={(v) => set('email', v)}
              type="email"
              autoComplete="email"
              errorMsg={errors.email}
              inputRef={(el) => { fieldRefs.current.email = el; }}
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
        </div>

        {/* Order summary column — discount, the collapsible summary, the payment
            section, the CTA and the legal line, held beside the details on wide
            screens. No wrapping panel here either: the right column is the same
            flat surface as the left, and the individual blocks (discount row,
            summary, payment) carry their own borders. The sticky offset keeps
            the payable amount in view while a long address form is filled in;
            below lg the column simply follows the form. */}
        <div className="min-w-0 lg:sticky lg:top-28">
        {/* Discount — quiet expandable row that opens the promo entry */}
        <div>
          {!promo && (
            <button
              type="button"
              onClick={() => setDiscountOpen((o) => !o)}
              aria-expanded={discountOpen}
              className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-line-2 bg-white px-3.5 py-3 text-left transition-colors hover:border-bone-dim/45"
            >
              <span className="inline-flex items-center gap-2.5">
                <Tag size={14} strokeWidth={2} className="shrink-0 text-bone-soft" />
                <span className="text-[13px] font-semibold text-bone">Add discount</span>
              </span>
              <ChevronDown
                size={15}
                strokeWidth={2}
                className={`shrink-0 text-bone-soft transition-transform duration-150 ${discountOpen ? 'rotate-180' : ''}`}
              />
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
                  className="btn-dark shrink-0 text-[14px] uppercase tracking-wide-2 font-semibold px-5 py-3 disabled:opacity-40"
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

        {/* Order summary — collapsible, and in the same light house style as
            the rest of the page rather than an inverted black slab. Collapsed
            by default: the header carries the payable amount so the total is
            always visible, and the per-item rows plus the price breakdown stay
            folded away until tapped. One button, one aria-expanded, one
            chevron that rotates to mirror its state. */}
        <div className="mt-5 overflow-hidden rounded-card border border-line-2 bg-white">
          <button
            type="button"
            onClick={() => setSummaryOpen((o) => !o)}
            aria-expanded={summaryOpen}
            className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-bone/[0.04] sm:px-5"
          >
            {/* The collapsed bar IS the product line — thumbnail, name, variant,
                then the product price and the chevron — so the shopper sees what
                they are buying before opening anything, instead of a caption
                telling them a summary exists.

                `items[0]` only, deliberately. This stays ONE compact row, and the
                full per-item list is already revealed on expand, so a leading
                product row outside the bar (or a second one inside it) would just
                duplicate what is one tap away. The existing data, image and `count`
                are reused as-is.

                The amount shown is the PRODUCT price (`subtotal`), matching the
                expanded item rows rather than the payable total: a number sitting
                beside the product name is read as that product's price, so a
                shipping-and-discount-inclusive, payment-method-dependent total did
                not belong here. The payable total is not hidden by this — the
                Payment Method cards and the CTA button still carry it. Both facts
                are pinned in `payment-rules.test.mjs`.

                The left block is `flex-1 min-w-0` so the name and variant
                `truncate`: a long product name gives way on a narrow screen
                rather than growing the bar's height or shoving the price past the
                right edge. The price/chevron span stays `shrink-0`, so the amount
                is never the thing that loses. */}
            <span className="flex min-w-0 flex-1 items-center gap-3">
              {items[0]?.image && (
                <span className="h-10 w-10 shrink-0 overflow-hidden rounded border border-line-2 bg-bone/[0.06]">
                  <img src={items[0].image} alt={items[0].name} className="h-full w-full object-cover" loading="lazy" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-bone">{items[0]?.name ?? 'Your bag'}</span>
                <span className="mt-0.5 block truncate font-label text-[10px] uppercase tracking-wide-2 text-bone-soft">
                  {items[0]
                    ? `${items[0].color} · ${items[0].sizeLabel} × ${items[0].quantity}`
                    : 'Nothing selected yet'}
                  {count > 1 && ` · ${count} items`}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {/* Product price, not the payable total (see above). */}
              <span className="font-price text-[15px] font-semibold text-bone tabular-nums">
                {formatPrice(subtotal)}
              </span>
              <ChevronDown
                size={16}
                strokeWidth={2}
                className={`text-bone-soft transition-transform duration-150 ${summaryOpen ? 'rotate-180' : ''}`}
              />
            </span>
          </button>

          {summaryOpen && (
            <div className="animate-slide-down border-t border-line-2 px-4 pb-4 pt-3.5 sm:px-5 sm:pb-5">
              <div className="divide-y divide-line-2">
                {items.map((item) => (
                  <div key={`${item.productId}-${item.colorId}-${item.sizeLabel}`} className="flex gap-3 py-2.5">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded border border-line-2 bg-bone/[0.06]">
                      {item.image && <img src={item.image} alt={item.name} className="h-full w-full object-cover" loading="lazy" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-xs font-semibold text-bone">{item.name}</p>
                      <p className="font-label text-[10px] uppercase tracking-wide-2 text-bone-soft mt-0.5">
                        {item.color} · {item.sizeLabel} × {item.quantity}
                      </p>
                    </div>
                    <p className="font-price text-sm font-semibold text-bone tabular-nums whitespace-nowrap">
                      {formatPrice(item.unitPrice * item.quantity)}
                    </p>
                  </div>
                ))}
              </div>
              <dl className="mt-4 space-y-2 border-t border-line-2 pt-4 text-sm">
                {/* The PRODUCT subtotal, deliberately NOT `total`.
                    `total` is subtotal - promo + shipping, i.e. it is already
                    discounted AND already includes shipping, so it is neither
                    the product price nor the amount the shopper actually pays
                    online. `subtotal` is the authoritative pre-discount figure:
                    useD2cCart derives it as SUM(unitPrice * quantity) straight
                    from the cart lines, with no promo and no shipping folded in.
                    The rows below list Shipping/Discount/Online Discount and
                    roll up to the payable total, so this is the one line that
                    must show the undiscounted product price. Calculations are
                    untouched; only the displayed source moved. */}
                <div className="flex items-center justify-between">
                  <dt className="text-bone-soft">Items ({count})</dt>
                  <dd className="font-semibold text-bone tabular-nums">{formatPrice(subtotal)}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-bone-soft">Shipping</dt>
                  <dd className="font-semibold text-bone tabular-nums">
                    {shipping > 0 ? formatPrice(shipping) : <span className="text-green-600">FREE</span>}
                  </dd>
                </div>
                {discount > 0 && (
                  <div className="flex items-center justify-between">
                    <dt className="text-bone-soft">Discount ({promo?.code})</dt>
                    <dd className="font-semibold text-green-600 tabular-nums">−{formatPrice(discount)}</dd>
                  </div>
                )}
                {paymentMethod === 'cod' ? (
                  /* COD: no advance, no remaining balance, no online discount —
                     the complete amount is due to the delivery agent. */
                  <div className="flex items-center justify-between">
                    <dt className="text-bone-soft">Amount due on delivery</dt>
                    <dd className="font-semibold text-bone tabular-nums">{formatPrice(codDue)}</dd>
                  </div>
                ) : (
                  onlineDiscount > 0 && (
                    <div className="flex items-center justify-between">
                      <dt className="text-bone-soft">Online Payment Discount</dt>
                      <dd className="font-semibold text-green-600 tabular-nums">−{formatPrice(onlineDiscount)}</dd>
                    </div>
                  )
                )}
                {/* The one place emphasis is allowed: the payable total. */}
                <div className="flex items-center justify-between border-t border-line-2 pt-3">
                  <dt className="font-label text-xs uppercase tracking-wide-2 text-bone-soft">
                    {paymentMethod === 'cod' ? 'Total (Cash on Delivery)' : onlineDiscount > 0 ? 'Online Payment Total' : 'Total'}
                  </dt>
                  <dd className="font-price text-xl text-bone tabular-nums">
                    {formatPrice(paymentMethod === 'cod' ? codDue : onlineTotal)}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>
        {/* Payment — a standalone section below the summary, not nested inside
            it. Section rhythm (margin + hairline rule) does the separating that
            a wrapping card used to do, so the page reads as one flat column. The
            RPC
            re-prices everything server-side; create_retail_order is the single
            authoritative calculator. COD is paid IN FULL by the delivery agent
            (no advance, no online payment); online gets the fixed ₹50
            payment-method discount. Cards are presentation-only and answer one
            question: which method? */}
        {/* The summary above is now a light outlined box, so it no longer
            doubles as the separator — a hairline here does that job. */}
        <section className="mt-7 border-t border-line-2 pt-6">
          {/* Payment is a sibling of the summary, not a child: the method sits
              directly above the CTA it drives, and the CTA lives INSIDE this
              section for exactly that reason — the method and the button that
              submits it read as one decision.

              Stacked, not baseline-aligned. Sharing one line was what kept both
              small: at 360px the heading and the security note fought for the
              same ~40px, so the note was set to 10.5px and the heading to 11px
              to fit. On its own line each can be the size it wants to be. The
              heading now carries real ink (text-bone, not the secondary
              bone-soft) because this is the section that decides how a customer
              pays, and the note steps down to supporting weight beneath it. */}
          {/* Exactly the same class string as the DELIVERY <h2>, so the two
              section headings are typographically identical: same family, size,
              weight, tracking, case and colour. They are peers on the page —
              one names each half of the single act of buying — and the previous
              `font-label text-[13px] font-bold` treatment made this heading
              read like a form label instead, competing with the ONLINE PAYMENT /
              COD option names it sits above. Matching DELIVERY's
              `font-display text-xl uppercase tracking-wide-2` is what makes them match,
              which is also the TRACK ORDER heading's typography; the `h2`/`h3` tag
              difference is kept because the document outline has always nested payment
              under the page-level h1. */}
          <h3 className="font-display text-xl uppercase tracking-wide-2 text-bone">
            Payment Method
          </h3>
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium leading-none text-bone-soft">
            <ShieldCheck size={13} strokeWidth={2} className="shrink-0 text-bone-soft" />
            Secure &amp; encrypted
          </p>

          <div className="mt-4 space-y-3" role="radiogroup" aria-label="Payment method">
            <PaymentMethodCard
              selected={paymentMethod === 'online'}
              name="ONLINE PAYMENT"
              sub="Pay securely with"
              onClick={() => changePaymentMethod('online')}
              price={
                <>
                  {/* Amount first, badge second: the price is the headline and
                      the saving is the supporting fact, which is also the
                      intended reading order. Putting the amount on top of the
                      right-hand column lines both cards' amounts up.

                      26px on mobile, 22px from sm: this is the number the
                      customer is about to be charged, and at 360px it was the
                      one piece of the card that could still be read at a glance
                      from arm's length. It steps back on desktop only because
                      there the card is beside a price summary and needs to sit
                      under the summary's own total, not compete with it.

                      ONE inline price value, not a ₹ glyph beside a number.
                      `formatPrice` joins them with U+2009 THIN SPACE, and a
                      space is a line-break opportunity: in the 88px right-hand
                      column "₹ 2,446" is ~89px at 26px bold tabular, so it broke
                      at that space and left the ₹ stranded on the first line with
                      the amount pushed below it — the ₹ read as raised simply
                      because it was on its own line. `whitespace-nowrap` makes the
                      pair unbreakable at every amount (₹99 through ₹12,34,567)
                      rather than special-casing one value, and the flex row with
                      `items-baseline` keeps the sign and the digits sharing one
                      baseline if the two ever become separate elements.
                      `justify-end` holds the right alignment the column gave it. */}
                  <span className="flex items-baseline justify-end whitespace-nowrap font-price text-[26px] font-bold leading-none text-bone tabular-nums sm:text-[22px]">
                    {formatPrice(onlineTotal)}
                  </span>
                  {/* Solid crimson pill, right-hand column under the amount.
                      The saving is real and unconditional, so it is stated once,
                      plainly. There is no timer and no "limited time" copy here —
                      the discount is ₹50 whenever the shopper picks online.

                      Slightly larger and given real side padding, because at
                      10px/px-2 the "SAVE ₹50" was the same optical weight as the
                      word "Saving" in the footnote directly under it — the
                      benefit was being stated twice at two different weights,
                      and the weaker of the two is the one a customer acts on. */}
                  <span className="relative mt-1.5 inline-flex overflow-hidden rounded-full bg-crimson px-2.5 py-1 align-middle">
                    <span className="text-[10.5px] font-bold uppercase leading-none tracking-[0.06em] text-white">
                      Save {formatPrice(onlineDiscount)}
                    </span>
                    <span
                      aria-hidden
                      className="save-badge-sheen pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/55 to-transparent"
                    />
                  </span>
                </>
              }
              extra={<PaymentMethodsRow />}
              footnote={`You save ${formatPrice(onlineDiscount)} by paying online`}
            />
            <PaymentMethodCard
              selected={paymentMethod === 'cod'}
              name="CASH ON DELIVERY (COD)"
              sub="Pay when your order arrives"
              onClick={() => changePaymentMethod('cod')}
              price={
                /* ₹698 is the amount the shopper will actually pay on delivery,
                   so it is set in the same full-strength ink and weight as the
                   online amount. Only the SIZE steps down — 21px against the
                   online card's 26px — which is what keeps online reading as the
                   better deal without making COD look unavailable. It is
                   deliberately NOT text-grey: a greyed price on a real,
                   selectable option reads as disabled. The 5px step is also
                   what keeps COD the clear SECONDARY choice; make it equal and
                   the page stops having a recommendation. */
                <span className="block font-price text-[21px] font-bold leading-none text-bone tabular-nums sm:text-[18px]">
                  {formatPrice(codDue)}
                </span>
              }
            />
          </div>

          {/* Primary CTA — clean, solid crimson; no glow, no shadow, no lift.
              Hover is a slightly darker colour transition only; active is a
              subtle 1px press. Same order + Cashfree redirect flow as before.
              Disabled while any field is invalid so it can never reach order
              creation until pincode/phone/email all pass.

              INSIDE the payment section, not after it. It is the button that
              submits the method chosen directly above it, and while it sat
              outside the <section> the only thing relating the two was shared
              margins — which the summary block above already used, so the
              button read as belonging to the summary's group instead. Nesting
              it makes the method and the button one unit in the DOM as well as
              on screen. mt-5 leaves clear air so it never looks welded on. */}
          <button
            type="submit"
            disabled={placing}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-[10px] bg-crimson px-5 py-4 text-[16px] font-bold uppercase tracking-[0.08em] text-white transition-[background-color,transform] duration-150 ease-out hover:bg-[#bd0929] active:translate-y-px disabled:opacity-60 disabled:hover:bg-crimson sm:py-3.5"
          >
            {placing ? (
              <>
                <Loader2 size={15} strokeWidth={2} className="animate-spin" /> Placing Order…
              </>
            ) : paymentMethod === 'cod' ? (
              `Place Order · ${formatPrice(codDue)}`
            ) : paymentCfg.configured ? (
              `Pay Now · ${formatPrice(onlineTotal)}`
            ) : (
              `Place Order${onlineTotal > 0 ? ` · ${formatPrice(onlineTotal)}` : ''}`
            )}
          </button>
        </section>

        {/* Legal — small and low-contrast so it reads as fine print beneath the
            CTA, never as another call to action. */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[10.5px] text-bone-soft">
          <a href="#/return-policy" className="underline underline-offset-2 transition-colors hover:text-bone">Refund policy</a>
          <a href="#/shipping-policy" className="underline underline-offset-2 transition-colors hover:text-bone">Shipping</a>
          <a href="#/privacy-policy" className="underline underline-offset-2 transition-colors hover:text-bone">Privacy policy</a>
          <a href="#/terms-and-conditions" className="underline underline-offset-2 transition-colors hover:text-bone">Terms of service</a>
        </div>
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
        className={`relative flex w-full items-center rounded-soft border bg-white field-focus float-box ${
          errorMsg ? 'is-invalid border-crimson/50 focus-within:border-crimson' : 'border-line-2'
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
          placeholder=" "
          aria-invalid={errorMsg ? true : undefined}
          className="float-input relative z-[1] w-full min-w-0 bg-transparent px-3.5 text-[15px] leading-snug focus:outline-none"
        />
        <span className="float-label" aria-hidden>{label}</span>
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
        className={`relative flex w-full items-center rounded-soft border bg-white field-focus float-box ${
          errorMsg ? 'is-invalid border-crimson/50 focus-within:border-crimson' : 'border-line-2'
        }`}
      >
        <select
          ref={elRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          autoComplete={autoComplete}
          aria-invalid={errorMsg ? true : undefined}
          className="float-select relative z-[1] w-full min-w-0 appearance-none bg-transparent px-3.5 text-[15px] leading-snug focus:outline-none"
        >
          {placeholder && <option value="" disabled>{placeholder}</option>}
          {children}
        </select>
        <span className="float-label" aria-hidden>{label}</span>
        <span className="pointer-events-none shrink-0 pr-3 text-grey">
          <ChevronDown size={16} strokeWidth={2} />
        </span>
      </span>
      {errorMsg && <p className="mt-1.5 text-xs text-crimson" role="alert">{errorMsg}</p>}
    </label>
  );
}

/** Payment-option row — one system shared by Online Payment and COD.
 *
 *  Default:  white fill, 1px light-gray border, small radius, no shadow.
 *  Selected: still white; only the border and the radio go crimson, with a
 *            barely-there red wash on the inner edge. The one solid red fill on
 *  the card is the SAVE pill, which is the point of the card.
 *
 *  TYPE. The method name is set in the site's label voice (--font-label, i.e.
 *  Open Sans) at `font-bold` and NORMAL tracking, deliberately NOT the display
 *  face the section headings above use. The name labels a control the customer
 *  taps, so it has to read as an option rather than as a title: setting it in the
 *  condensed display face at wide tracking turned ONLINE PAYMENT and CASH ON
 *  DELIVERY (COD) into spaced-out display text and set them competing with the
 *  DELIVERY / PAYMENT METHOD headings directly above. 13px (up from 12px) and
 *  `leading-[1.3]` keep it the card's own line; colour, position, the radio, the
 *  price column and the logos are all untouched. f336558 replaced the name and the
 *  headings with sentence-case Open Sans bold + tracking-tight, which is why the
 *  form read flat while the Order Confirmed and Track Order screens — which kept
 *  font-display throughout — did not.
 *
 *  The price lives in a right-hand column of RESERVED MINIMUM width. That is
 *  what keeps the two options on one grid: the amounts end at the same x, the
 *  row height does not change when the shopper switches methods, and the title
 *  can never be pushed into the price by its own width, because the column is
 *  reserved before the text is measured. The reservation is a minimum rather
 *  than a fixed width so that one unbreakable price value (see the ONLINE
 *  PAYMENT card) can widen the column instead of being split across two lines;
 *  the savings line spans the full card width on one line, and the card is
 *  sized only by what it actually contains.
 *
 *  The whole card is the tap target (it is a <button>), with a 250ms
 *  border/background/shadow transition on a decelerating curve and nothing
 *  else. The radio ring and dot share that curve, so the whole card resolves
 *  into its selected state as one movement. It is a CSS state transition with
 *  no keyframes or iteration count, so it plays once per change and never on
 *  its own. */
function PaymentMethodCard({
  selected,
  name,
  sub,
  note,
  price,
  onClick,
  extra,
  footnote,
}: {
  selected: boolean;
  name: string;
  sub?: string;
  /** Small muted third line under the sub, in the left text block. */
  note?: string;
  /** Right-hand column: the amount, right-aligned in a fixed width. */
  price: React.ReactNode;
  onClick: () => void;
  /** Full-width strip under the row (the accepted-methods marks). */
  extra?: React.ReactNode;
  /** One full-width line under `extra`, indented to the text block. Used for
   *  the online savings line: at card width it fits on a SINGLE line, where in
   *  the right-hand column it wrapped to three and was the single biggest
   *  contributor to the card's height. */
  footnote?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${name}. ${sub ?? ''}`}
      onClick={onClick}
      /* Selection animates rather than snaps: the border, the wash and the
         shadow ease out over 250ms on a decelerating curve, so the card
         settles into place instead of jumping. It is a state change only —
         there is no keyframe or loop, so nothing animates while the shopper is
         not switching methods.

         `payment-card-shine` is the periodic diagonal knife shine. One class on
         this shared card, so Online Payment and COD both get it and the CSS
         does the rest: an `::after` band sweeps across, and the class only
         supplies the `position: relative` / `overflow: hidden` pair that keeps
         it inside the rounded corner. No markup, no second element, no change
         to size, content or alignment — and because the band is
         `pointer-events: none` the whole card stays the tap target.

         PREMIUM BADGE TREATMENT, entirely in `box-shadow` + one radius token,
         so nothing about the box changes: no padding, no border width, no
         width, no height. Three layers, outside-in:
           1. a hairline outer ring, which is the "layered border" — it reads as
              a second, softer edge just outside the 1px border and separates
              the card from the page on a white background;
           2. a 1px inset white highlight along the top edge, which is what
              makes a flat rectangle read as a raised physical badge;
           3. a very light drop shadow directly under it, for the last fraction
              of depth.
         Because `box-shadow` is already in the transitioned property list, the
         whole treatment cross-fades with the existing 250ms curve — no new
         transition, no new timing.
         `rounded-xl` is 0.75rem, which is the site's own `--radius-card`, so
         the softer corner is a token already in use rather than a new number. */
      className={`payment-card-shine block w-full rounded-xl border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)] sm:py-2.5 ${
        // Selected reads as the primary decision, but by TINT and a hairline
        // weight — not by turning dark. The ring is layered into the shadow
        // rather than being a second border because a 1px->2px border change
        // would reflow the card by 1px on selection and make the two options
        // visibly jump. Soft shadows cost no layout and do the same "lifted"
        // work, so the whole badge treatment animates for free.
        selected
          ? 'border-crimson/60 bg-[#fff4f6] shadow-[0_0_0_1px_rgba(210,10,46,0.22),inset_0_1px_0_rgba(255,255,255,0.85),0_2px_10px_rgba(210,10,46,0.14)]'
          : 'border-line-2 bg-white shadow-[0_0_0_1px_rgba(26,26,26,0.045),inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(26,26,26,0.05)] hover:border-bone-dim/45'
      }`}
    >
      <span className="flex items-start gap-2.5 sm:gap-3">
        {/* The radio is the "which method" affordance, so it grows with the
            card on mobile: 17px there, 15px from sm. The selected ring also
            picks up a faint crimson fill so the chosen option is legible as
            chosen at a glance, without the dot itself getting bigger. */}
        <span
          className={`mt-[2px] flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border transition-[border-color,background-color] duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)] sm:mt-[3px] sm:h-[15px] sm:w-[15px] ${
            selected ? 'border-crimson bg-crimson/10' : 'border-bone-dim/45'
          }`}
          aria-hidden
        >
          {/* The dot grows AND fades on the same curve as the ring, so the
              indicator finishes filling the circle rather than popping in at
              75%. No overshoot or bounce — the deceleration carries it. */}
          <span className={`h-[7px] w-[7px] rounded-full bg-crimson transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${selected ? 'scale-100 opacity-100' : 'scale-75 opacity-0'}`} />
        </span>

        <span className="min-w-0 flex-1">
          {/* The option name sits a step above `sub` and `note` below it, so the
              card reads name > explanation > qualifier rather than three lines
              at one weight. Only the name changed: `sub` and `note` keep their
              lighter bone-soft treatment, which is what keeps them supporting. */}
          <span className="block font-label text-[13px] font-bold uppercase leading-[1.3] tracking-normal text-bone">{name}</span>
          {sub && <span className="mt-0.5 block text-[11.5px] font-normal leading-[1.35] text-bone-soft">{sub}</span>}
          {note && (
            <span className="mt-1 block text-[9.5px] font-medium uppercase leading-[1.4] tracking-[0.03em] text-bone-soft">
              {note}
            </span>
          )}
        </span>

        {/* Minimum width => the two amounts share one right-hand alignment and
            the column is still reserved before the text is measured, so the
            method name is never pushed into a price by a long one. But it is a
            MINIMUM, not a fixed width: the price is a single `whitespace-nowrap`
            value (see the ONLINE PAYMENT card), so a long amount can no longer be
            squeezed into 88px and broken across two lines. The column now grows
            to fit the amount instead, and every px it takes beyond 88px is taken
            from the method name, which wraps rather than collides. A short amount
            — COD's, and ONLINE PAYMENT's at normal order values — still lays out
            at exactly 88px, so this column is pixel-identical to the fixed width
            it replaces for every existing value.

            A flex column, not a plain block: as a block the amount and the pill
            were inline-level, so the pill sat in an anonymous line box and the
            inherited 24px line-height silently added 8px of empty space under
            it. Blockifying the children hands the column only its own content
            height. `items-end` is what right-aligns them. */}
        <span className="flex min-w-[88px] shrink-0 flex-col items-end text-right sm:min-w-[96px]">{price}</span>
      </span>

      {/* Also a flex container, for the same reason: as a block the logo strip
          is inline-level and its 22px row picked up an anonymous line box too.
          `items-center` re-asserts the centring the flex row was doing.
          mt-1.5 (6px) rather than mt-2: 6px of clear air under the price
          column already reads as separated, and the 22px logo row sits closer
          to the text it belongs to. */}
      {extra && (
        <span className="mt-1.5 flex items-center pl-[26px]">{extra}</span>
      )}
      {footnote && (
        /* The saving restated in words, under the logos. 11.5px rather than
           10.5px: this is the line that converts a price comparison into a
           decision, and it was previously the smallest text in the card. */
        <span className="mt-1.5 flex items-center pl-[26px] text-[11.5px] font-semibold leading-[1.35] text-crimson">
          {footnote}
        </span>
      )}
    </button>
  );
}

/** Small square checkbox used for the "Save this information for next time" row. */
function CheckboxSquare({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
        checked ? 'border-bone bg-bone text-white' : 'border-line-2 bg-white text-transparent'
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

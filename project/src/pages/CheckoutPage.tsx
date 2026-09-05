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
import { openCashfreeCheckout } from '@/lib/cashfreeSdk';
import { fetchLiveVariantStock, reconcileCartWithLive, describeStockChanges } from '@/lib/cartStock';
import { LoadingDots } from '@/components/LoadingDots';
import { lockScroll, unlockScroll } from '@/lib/scrollLock';

/**
 * Retail checkout — places the order via the server-side create_retail_order
 * RPC (prices are recomputed there; the client never sends amounts). Payment
 * is deliberately NOT faked: until a gateway is configured the order is
 * recorded as pending and the customer sees an honest status + order ref.
 */

type Stage = 'form' | 'placing' | 'success' | 'error' | 'failure' | 'confirming';

const PENDING_PAYMENT_KEY = 'dslang_pending_order_v1';
const CHECKOUT_FORM_KEY = 'dslang_checkout_form_v1';

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
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});

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

  // Re-validate the cart against live DB stock when checkout loads, so the
  // summary and the Place Order button reflect current availability. If lines
  // changed, reconcile the cart and surface a clear message.
  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const live = await fetchLiveVariantStock(items);
        if (cancelled) return;
        const { changes } = reconcileCartWithLive(items, live);
        if (changes.changed) {
          setErrorMsg(describeStockChanges(changes) ?? 'Some items changed in your bag.');
          reconcileWithLiveStock(live);
          setStage('error');
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
  useEffect(() => {
    if (!paymentCfg.configured) {
      window.sessionStorage.removeItem(PENDING_PAYMENT_KEY);
      return;
    }
    let cancelled = false;
    const raw = window.sessionStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return;
    const confirm = async () => {
      try {
        const pending = JSON.parse(raw) as { ref: string };
        const v = await verifyPayment(pending.ref);
        if (cancelled || !v || !v.order) return;
        if (v.verified) {
          window.sessionStorage.removeItem(PENDING_PAYMENT_KEY);
          window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
          clear();
          removeAppliedPromo();
          setResult({
            order_id: String(v.order.id),
            ref: String(v.order.ref),
            order_type: 'retail',
            total_qty: Number(v.order.total_qty ?? 0),
            subtotal: Number(v.order.subtotal ?? 0),
            discount: Number(v.order.discount ?? 0),
            shipping: Number(v.order.shipping ?? 0),
            total_amount: Number(v.order.total_amount ?? 0),
            payment_status: 'success',
            order_status: String(v.order.order_status ?? 'pending'),
            items: Array.isArray(v.order.items) ? (v.order.items as RetailOrderLineSnapshot[]) : [],
            customer: (v.order.customer as RetailCustomer) ?? undefined,
          });
          setStage('success');
        } else if (v.status === 'failed') {
          window.sessionStorage.removeItem(PENDING_PAYMENT_KEY);
          setStage('failure');
        } else {
          setStage('confirming');
        }
      } catch {
        // Keep the current stage; the customer can retry payment.
      }
    };
    confirm();
    return () => { cancelled = true; };
  }, [paymentCfg.configured, clear, removeAppliedPromo]);

  if (items.length === 0 && stage !== 'success' && stage !== 'confirming') {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5">
        <p className="font-display text-5xl uppercase tracking-wide-2 text-bone leading-none">Empty</p>
        <p className="mt-3 text-sm text-grey">Your bag is empty.</p>
        <button
          onClick={() => navigate('/collection')}
          className="mt-8 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-crimson-dark transition-colors"
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
        <CheckCircle2 size={40} strokeWidth={1.4} className="text-crimson" />
        <p className="mt-5 font-label text-[10px] uppercase tracking-ultra text-crimson">Order Confirmed</p>
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
                  <span className="font-semibold text-green-400">−{formatPrice(result.discount)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 text-sm">
                <span className="text-grey">Total</span>
                <span className="font-price text-lg font-bold text-crimson tabular-nums">{formatPrice(result.total_amount)}</span>
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
                  ? 'w-full border border-lime-900/70 bg-lime-950/50 px-4 py-3 text-xs text-lime-300 leading-relaxed'
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
                  <span className="font-label text-crimson font-semibold shrink-0">1</span>
                  <span className="text-grey leading-relaxed">We personally review order <span className="text-bone font-medium">{result.ref}</span> — every order is checked by hand.</span>
                </li>
                <li className="flex gap-3 text-sm">
                  <span className="font-label text-crimson font-semibold shrink-0">2</span>
                  <span className="text-grey leading-relaxed">Your order is dispatched from Tiruppur within 24-48 hours, with stock confirmed before it ships.</span>
                </li>
                <li className="flex gap-3 text-sm">
                  <span className="font-label text-crimson font-semibold shrink-0">3</span>
                  <span className="text-grey leading-relaxed">We send you a confirmation SMS with your order reference and a Track Order link.</span>
                </li>
              </ol>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            onClick={() => navigate(`/track-order/${encodeURIComponent(result.ref)}`)}
            className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-crimson-dark transition-colors"
          >
            <Truck size={15} strokeWidth={2} />
            Track Order
          </button>
          <button
            onClick={() => navigate('/collection')}
            className="inline-flex items-center gap-2 border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Continue Shopping
          </button>
        </div>

        <div className="mt-8 w-full max-w-2xl mx-auto border-t border-line pt-5">
          <p className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold mb-3">Useful Links</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <a href="#/shipping-policy" className="border border-line px-3 py-2.5 text-center text-grey hover:text-crimson hover:border-crimson transition-colors">Shipping Policy</a>
            <a href="#/return-policy" className="border border-line px-3 py-2.5 text-center text-grey hover:text-crimson hover:border-crimson transition-colors">Return Policy</a>
            <a href="#/privacy-policy" className="border border-line px-3 py-2.5 text-center text-grey hover:text-crimson hover:border-crimson transition-colors">Privacy Policy</a>
            <a href="#/contact" className="border border-line px-3 py-2.5 text-center text-grey hover:text-crimson hover:border-crimson transition-colors">Contact Us</a>
          </div>
        </div>
      </div>
    );
  }

  /* ---- Payment failure state (order was recorded; payment did not complete) ---- */
  if (stage === 'failure') {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
        <p className="font-label text-[10px] uppercase tracking-ultra text-crimson">Payment Not Completed</p>
        <h1 className="font-display text-4xl md:text-6xl uppercase tracking-wide-2 text-bone leading-none mt-2">
          Almost there
        </h1>
        <p className="mt-4 text-sm text-grey max-w-md leading-relaxed">
          Your order has been recorded, but online payment could not be completed. Please contact us for payment assistance.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            onClick={() => setStage('form')}
            className="inline-flex items-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-crimson-dark transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={() => navigate('/contact')}
            className="inline-flex items-center gap-2 border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Contact Us
          </button>
          <button
            onClick={() => { openCart(); navigate('/'); }}
            className="inline-flex items-center gap-2 border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
          >
            Back To Bag
          </button>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (items.length === 0) return;
    if (placingRef.current) return;
    placingRef.current = true;

    // Show the placing state immediately on click so the button never feels
    // unresponsive while stock is re-validated and the order/session is created.
    setStage('placing');
    setErrorMsg('');

    // Per-field validation first — never submit if any required field is invalid.
    const errs = validateForm(form);
    if (REQUIRED_FIELDS.some((k) => errs[k])) {
      placingRef.current = false;
      setErrors(errs);
      setErrorMsg('');
      setStage('form');
      const first = REQUIRED_FIELDS.find((k) => errs[k]);
      if (first) scrollAndFocus(first);
      return;
    }
    setErrors({});

    // Authoritative re-validation against live DB stock before any order is
    // created. If stock changed while the customer was shopping, update the
    // cart and abort — never submit a stale/over-quantity order. The server
    // (create_retail_order) re-validates again as the final gate.
    try {
      const live = await fetchLiveVariantStock(items);
      const { changes } = reconcileCartWithLive(items, live);
      if (changes.changed) {
        const notice = describeStockChanges(changes);
        reconcileWithLiveStock(live);
        setErrorMsg(notice ?? 'Your bag was updated. Please review before placing the order.');
        setStage('error');
        placingRef.current = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
    } catch {
      // A transient fetch failure must NOT allow an unvalidated order through.
      // Abort and ask the customer to retry rather than trusting client state.
      setErrorMsg('Could not verify stock right now. Please try again.');
      setStage('error');
      placingRef.current = false;
      return;
    }

    try {
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
      setResult(res);

      if (paymentCfg.configured) {
        const session = await createPaymentSession({
          orderRef: res.ref,
          orderId: res.order_id,
          amount: res.total_amount,
          customer: { name: form.name, phone: form.phone, email: form.email || undefined },
        });
        if (session.status !== 'pending' || !session.paymentSessionId) {
          placingRef.current = false;
          setErrorMsg("We couldn't start the online payment. Your order has not been charged. Please try again or choose another payment option.");
          setStage('error');
          return;
        }
        try {
          window.sessionStorage.setItem(
            PENDING_PAYMENT_KEY,
            JSON.stringify({ ref: res.ref, at: Date.now() })
          );
        } catch {
          // ignore — verification will just not be auto-triggered on return
        }
        try {
          // Open the hosted Cashfree checkout without navigating the app away
          // first. The button stays disabled until the promise settles. The
          // return URL was already configured on the Cashfree order server-side.
          await openCashfreeCheckout({
            paymentSessionId: session.paymentSessionId,
            environment: session.environment ?? 'TEST',
            redirectTarget: '_self',
          });
          // If Cashfree did not navigate the window (e.g. the customer closed
          // it) the order simply stays safely pending — restore the button.
          placingRef.current = false;
          return;
        } catch (err) {
          // Never surface the raw gateway/technical error. Log it, then present
          // the customer with a clean, recoverable payment-start message.
          // eslint-disable-next-line no-console
          console.error('[checkout] Payment window error:', err);
          placingRef.current = false;
          setErrorMsg("We couldn't start the online payment. Your order has not been charged. Please try again or choose another payment option.");
          setStage('error');
          return;
        }
      }

      clear();
      removeAppliedPromo();
      window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
      setStage('success');
      placingRef.current = false;
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    } catch (err) {
      placingRef.current = false;
      // Never surface raw backend/technical errors to the customer (they can
      // contain server or configuration detail). Log them server/debug-side and
      // present a clean, professional message.
      // eslint-disable-next-line no-console
      console.error('[checkout] Order placement failed:', err);
      setErrorMsg("We couldn't place your order. Nothing has been charged. Please try again.");
      setStage('error');
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-6 md:px-12 lg:px-16 py-8 md:py-14">
      {(stage === 'placing' || stage === 'confirming') && <TransitionOverlay stage={stage} />}
      <button
        onClick={() => { openCart(); navigate('/'); }}
        className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 text-grey hover:text-crimson transition-colors"
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

          {stage === 'error' && errorMsg && (
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
                <div className="w-14 h-[72px] shrink-0 border border-line bg-paper overflow-hidden">
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
                <div className="mt-2 flex items-center justify-between border border-green-900/70 bg-green-950/50 px-3 py-2.5">
                  <span className="inline-flex items-center gap-2 text-xs font-semibold text-green-400">
                    <Check size={14} strokeWidth={2.5} /> {promo.code} APPLIED
                  </span>
                  <button
                    type="button"
                    onClick={handleRemovePromo}
                    className="text-[10px] uppercase tracking-wide-2 font-semibold text-green-400 underline underline-offset-2 hover:text-green-300"
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
                    className="flex-1 min-w-0 border border-line bg-ink-2 px-3 py-2.5 text-sm text-bone placeholder:text-grey/60 focus:border-crimson focus:outline-none transition-colors"
                  />
                  <button
                    type="button"
                    onClick={handleApplyPromo}
                    disabled={applying || !promoInput.trim()}
                    className="inline-flex items-center gap-1.5 shrink-0 bg-bone text-ink text-[10px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 hover:bg-bone-dim transition-colors disabled:opacity-40"
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
                <dd className="font-semibold text-green-400 tabular-nums">−{formatPrice(discount)}</dd>
              </div>
            )}
            <div className="flex items-center justify-between">
              <dt className="text-grey">Shipping</dt>
              <dd className="font-semibold text-bone tabular-nums">
                {shipping > 0 ? formatPrice(shipping) : <span className="text-green-400">FREE</span>}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-grey">
                {shipping > 0 ? 'FREE shipping on orders ₹999+' : "You've unlocked FREE shipping"}
              </p>
            </div>
            <div className="flex items-center justify-between border-t border-line pt-3 mt-3">
              <dt className="font-label text-xs uppercase tracking-wide-2 text-bone">Total</dt>
              <dd className="font-price text-2xl text-crimson tabular-nums">{(total || 0).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}</dd>
            </div>
          </dl>
        </aside>

        {/* Payment state (below the form fields; summary appears after it on mobile) */}
        <div className="lg:col-start-1 border border-line bg-paper-3 p-4">
          <div className="flex items-center gap-3">
            <ShieldCheck size={18} strokeWidth={1.6} className="text-crimson shrink-0" />
            <div>
              <p className="font-label text-[10px] uppercase tracking-wide-2 text-bone font-semibold">
                Payment
              </p>
              <p className="text-xs text-grey mt-0.5 leading-relaxed">{paymentStatusMessage()}</p>
            </div>
          </div>
          {stage === 'confirming' && (
            <p className="mt-3 flex items-center gap-2 text-xs text-bone">
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              Confirming your payment…
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={stage === 'placing' || stage === 'confirming'}
          className="lg:col-start-1 w-full inline-flex items-center justify-center gap-2 bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold py-4 px-5 hover:bg-crimson-dark hover:glow-crimson focus-visible:glow-crimson transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:glow-crimson disabled:hover:bg-crimson"
        >
          {stage === 'placing' ? (
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
          <a href="#/return-policy" className="text-bone underline hover:text-crimson transition-colors">Return Policy</a>,{' '}
          <a href="#/shipping-policy" className="text-bone underline hover:text-crimson transition-colors">Shipping Policy</a>{' '}
          and{' '}
          <a href="#/contact" className="text-bone underline hover:text-crimson transition-colors">support</a>. Review our{' '}
          <a href="#/privacy-policy" className="text-bone underline hover:text-crimson transition-colors">Privacy Policy</a>{' '}
          any time.
        </p>
      </form>
    </div>
  );
}

/**
 * Full-screen transition overlay shown while an order is being placed (jump
 * INTO the payment gateway) and while a payment is being verified on return.
 * Pure visual state — it never affects the underlying request/response flow.
 * Auto-hides after 15s as a safety net so it can never trap the customer.
 */
function TransitionOverlay({ stage }: { stage: Stage }) {
  const [visible, setVisible] = useState(true);

  // Auto-hide as a safety net for slow networks / long-lived "pending" states.
  useEffect(() => {
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), 15000);
    return () => window.clearTimeout(t);
  }, [stage]);

  useEffect(() => {
    if (!visible) return;
    lockScroll();
    return () => unlockScroll();
  }, [visible]);

  const label = stage === 'placing' ? 'Securing your order' : 'Confirming your payment';

  return (
    <div
      className="fixed inset-0 z-[300] flex flex-col items-center justify-center bg-ink text-paper transition-opacity duration-300"
      style={{ opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none' }}
      role="status"
      aria-live="polite"
    >
      <LoadingDots />
      <p className="mt-6 font-display text-xl md:text-2xl uppercase tracking-wide-2">{label}</p>
      <p className="mt-2 text-[11px] uppercase tracking-wide-2 text-grey">Please do not close this page</p>
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
        {label} {required && <span className="text-crimson">*</span>}
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
        className={`mt-1.5 w-full border bg-ink-2 px-3 py-3 text-sm text-bone placeholder:text-grey/60 focus:outline-none transition-colors ${
          errorMsg ? 'border-crimson focus:border-crimson' : 'border-line focus:border-crimson'
        }`}
      />
      {errorMsg && <p className="mt-1.5 text-xs text-crimson" role="alert">{errorMsg}</p>}
    </label>
  );
}
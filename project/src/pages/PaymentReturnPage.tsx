import { useEffect, useRef, useState } from 'react';
import { Check, Truck } from 'lucide-react';
import { useD2cCart } from '@/lib/d2cCart';
import { replaceRoute } from '@/lib/router';
import { formatPrice } from '@/lib/catalog';
import { rpc } from '@/lib/rest';
import { setTrackHint } from '@/lib/trackHint';
import { addCheckoutHistory } from '@/lib/trackHistory';
import { SaveDetailsPrompt } from '@/components/SaveDetailsPrompt';
import { ConfettiBurst } from '@/components/ConfettiBurst';
import { useOrderImages, imageForItem } from '@/lib/orderImages';

const PENDING_PAYMENT_KEY = 'dslang_pending_order_v1';
const LIVE_ORDER_KEY = 'dslang_live_order_v1';
const CHECKOUT_FORM_KEY = 'dslang_checkout_form_v1';
const RESULT_KEY = 'dslang_order_result_v1';
const PLACED_LEFT_KEY = 'dslang_order_placed_left_v1';

export type PaymentReturnState = 'checking' | 'success';

// This page is the SUCCESS page and nothing else. It exists for exactly one
// outcome: the order's `payment_status` reads 'success' in the database, which
// only the signature-verified Cashfree webhook can write. It renders the single
// "Order Placed" screen for that case and the bag is cleared ONLY there.
//
// EVERY other outcome — cancelled at Cashfree, failed, still pending, unknown,
// or the status read itself failing — means the payment did NOT complete. Those
// go STRAIGHT back to /#/checkout, with the existing checkout restored (bag,
// quantities, promo, delivery form) so the customer can simply tap Pay Now
// again on the SAME reserved order, or switch to COD.
//
// There is deliberately NO intermediate screen: no polling loop, no retry loop,
// no waiting state, no spinner. A cancelled payment used to sit behind a
// multi-second "confirming" gate that the customer then had to click past, and
// the checkout could re-open that same confirmation state afterwards. Neither
// can happen now: this page decides in ONE read and hands a non-success return
// straight to CheckoutPage.

interface PendingPayload {
  ref: string;
  order_id: string;
  amount: number;
  itemsKey: string;
  at: number;
  phone?: string;
}

interface ResultLine {
  product_id?: string;
  name: string;
  color: string;
  size_label: string;
  quantity: number;
  line_total: number;
}

// Shape returned by the read-only `track_lookup_order` RPC (SECURITY DEFINER,
// possession-gated by ref + phone). It mirrors the order's DB row and never
// mutates anything — the ONLY writer of `payment_status` is the webhook.
interface TrackedLookupOrder {
  ref: string;
  payment_status: string;
  order_status?: string;
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

interface OrderSnapshot {
  ref: string;
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

function clearPending(): void {
  try {
    window.sessionStorage.removeItem(PENDING_PAYMENT_KEY);
  } catch {
    // ignore
  }
}

// The gateway-return pages don't get customer data back from the (privacy-safe)
// lookup RPC, but the checkout form for THIS order is still in session storage —
// its address is what the optional save-details prompt can offer, entirely
// client-side, before the key is cleared on settle.
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

function clearLive(): void {
  try {
    window.sessionStorage.removeItem(LIVE_ORDER_KEY);
  } catch {
    // ignore
  }
}

function clearForm(): void {
  try {
    window.sessionStorage.removeItem(CHECKOUT_FORM_KEY);
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

/* ------------------------------------------------------------------------- *
 * "Order Placed" is a ONE-TIME state, and this is what makes that true for
 * EVERY departure — not just the two buttons on the screen.
 *
 * The gateway created the history entry this screen is rendered at
 * (`/#/payment/return?ref=…`). The screen's own CTAs consume that entry with
 * `replaceRoute`, but a customer can also leave through the navbar, the footer,
 * the bag icon, or a bookmark — all of which PUSH, and leave the confirmation
 * sitting in history. One Back press then put "Order Placed" back in front of
 * someone who had already completed and deliberately left it.
 *
 * So the leaving itself is recorded: when this page unmounts while the document
 * stays alive — i.e. the customer navigated away inside the app — that ref is
 * marked consumed for this session. Arriving back at `/payment/return` for a
 * consumed ref can only ever be Back, Forward, or a stale link — never a fresh
 * payment — so the entry is replaced away instead of re-confirming.
 *
 * A reload is deliberately NOT counted as leaving: `pagehide` tells the two
 * apart, so refreshing the receipt the customer is looking at still shows it,
 * while Back/Forward can never bring it back.
 * ---------------------------------------------------------------------- */
function readPlacedLeft(): string {
  try {
    return window.sessionStorage.getItem(PLACED_LEFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function clearPlacedLeft(): void {
  try {
    window.sessionStorage.removeItem(PLACED_LEFT_KEY);
  } catch {
    // ignore
  }
}

function markPlacedLeft(ref: string): void {
  if (!ref) return;
  try {
    window.sessionStorage.setItem(PLACED_LEFT_KEY, ref);
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

function normalizeSnapshot(order: Record<string, unknown>): OrderSnapshot {
  const items = Array.isArray(order.items) ? (order.items as ResultLine[]) : [];
  return {
    ref: String(order.ref ?? ''),
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

export function PaymentReturnPage() {
  const { items, clear, removeAppliedPromo } = useD2cCart();
  // Order lines carry no image URL; resolved from the public catalogue by
  // product id + colour, same source as the Product Details page.
  const imageIndex = useOrderImages();

  // Trust the URL ref; if the gateway ever drops it, fall back to the pending
  // handle so verification can still run. If BOTH are missing there is nothing
  // to verify — hand back to the existing checkout (never a technical error).
  const [ref] = useState(() => readHashRef() || readPending()?.ref || '');
  const [formCustomer] = useState<OrderSnapshot['customer'] | null>(readFormCustomer);
  const [phone] = useState(() => {
    const p = readPending()?.phone ?? readFormPhone();
    return typeof p === 'string' ? p.replace(/\D/g, '').slice(0, 10) : '';
  });

  const pendingRef = useRef<PendingPayload | null>(null);
  if (pendingRef.current === null) pendingRef.current = readPending();

  const [state, setState] = useState<PaymentReturnState>('checking');
  const [snap, setSnap] = useState<OrderSnapshot | null>(null);

  const settleSuccess = (order: Record<string, unknown>) => {
    const snapshot = normalizeSnapshot(order);
    clearPending();
    clearLive();
    clearForm();
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
    setState('success');
  };

  // The order's CURRENT `payment_status`, read straight from the database via
  // the read-only `track_lookup_order` RPC (possession-gated by ref + phone).
  // It NEVER trusts a URL `?status=` parameter and NEVER writes anything.
  // `payment_status === 'success'` is the ONLY online way to reach "Order
  // Placed" — that value is set solely server-side by the signature-verified
  // Cashfree webhook.
  //
  // ONE read, no polling. A cancelled payment is not a slow success, so waiting
  // for it buys nothing: anything that is not an already-confirmed success goes
  // back to /#/checkout immediately. The pending-payment record is deliberately
  // LEFT IN PLACE for that handoff — CheckoutPage re-verifies it quietly in the
  // background (against `cashfree-status`, which re-checks Cashfree itself), so
  // a payment whose webhook is still in flight is still confirmed, and a
  // genuinely cancelled one is only cleared once the server has said so.
  useEffect(() => {
    if (!ref) {
      // REPLACE, not push: there is no ref, so nothing is worth keeping in
      // history, and a push here would leave `/payment/return` as a Back
      // destination that can only re-run this same redirect.
      replaceRoute('/checkout');
      return;
    }
    // This ref's confirmation has already been shown AND left in this session,
    // so arriving here again is a Back, a Forward or a stale link — never a new
    // payment. Consume the entry (replace, never push) and put the customer on
    // a normal page. Without this the one-time "Order Placed" screen came back
    // the moment they pressed Back after leaving it any other way.
    if (readPlacedLeft() === ref) {
      replaceRoute('/collections');
      return;
    }
    let cancelled = false;
    (async () => {
      let confirmed: Record<string, unknown> | null = null;
      try {
        const data = await rpc<TrackedLookup>('track_lookup_order', { p_ref: ref, p_phone: phone });
        if (cancelled) return;
        if (data?.ok) {
          const o = data.order as unknown as Record<string, unknown> | undefined;
          // A full-COD order is confirmed at creation with payment_status
          // 'cod_pending' and is never routed through Cashfree. If such a ref
          // ever lands here (e.g. a stale gateway redirect), confirm it rather
          // than bouncing the shopper back to checkout.
          if (o && (o.payment_status === 'success' || (o.is_cod && o.payment_status === 'cod_pending'))) {
            confirmed = o;
          }
        }
      } catch {
        // lookup errored — treated exactly like "anything else" below
      }
      if (cancelled) return;
      if (confirmed) {
        settleSuccess(confirmed);
        return;
      }
      // Not confirmed: the payment did NOT complete. Hand the customer straight
      // back to the checkout they came from. `clearPending()` is deliberately
      // NOT called here — CheckoutPage owns that decision, from a verified read.
      //
      // REPLACED, not pushed. This route is a transient hop between Cashfree and
      // checkout, and the entry Cashfree created for it must not survive: pushed,
      // Back would land on `/payment/return` again, which re-runs this redirect
      // and pushes `/checkout` again — an endless Back loop between two pages the
      // customer never meant to revisit. Replacing consumes the return entry, so
      // Back goes to whatever legitimately preceded the payment attempt (the
      // checkout, or the page before it).
      replaceRoute('/checkout');
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, phone]);

  // Record the moment the customer leaves this one-time screen.
  //
  // The write happens on unmount, and `pagehide` is what tells the two apart:
  // it fires only when the whole document is going away, so a refresh of the
  // receipt the customer is currently looking at does NOT count as leaving it.
  // An in-app navigation (navbar, footer, bag, either CTA) unmounts this page
  // with no `pagehide` in between, and that is the moment the ref is marked
  // consumed.
  //
  // It has to be the unmount rather than a `hashchange` listener: the router's
  // own `hashchange` handler is registered first, so it re-renders (and unmounts
  // this page) before any listener added later on the same event gets its turn.
  useEffect(() => {
    if (state !== 'success' || !snap?.ref) return;
    const shownRef = snap.ref;
    clearPlacedLeft();
    let unloading = false;
    const onPageHide = () => {
      unloading = true;
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      if (!unloading) markPlacedLeft(shownRef);
    };
  }, [state, snap]);

  // Not a confirmed order. Nothing is rendered here and nothing is ever waited
  // on — the redirect above is already in flight, and there is no spinner,
  // loader or 'confirming' state left in this flow to be seen.
  if (state !== 'success' || !snap) return null;

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-5 py-10">
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-bone checkmark-wrap">
        <Check size={20} strokeWidth={2.5} className="text-paper checkmark" />
        <span className="absolute inset-0 rounded-full ring ring-crimson/25 pulse-ring pointer-events-none" />
        <ConfettiBurst />
      </span>

      <h1 className="mt-8 font-display text-3xl md:text-5xl uppercase tracking-wide-2 text-bone leading-none fade-up">
        Order Placed
      </h1>

      <div className="fade-up fade-up-1">
        <p className="mt-3 font-label text-[11px] uppercase tracking-ultra text-grey">Order</p>
        <p className="mt-1 text-sm font-semibold text-bone">{snap.ref}</p>
      </div>

      <div className="mt-8 w-full max-w-md text-left fade-up fade-up-2">
        <div className="panel p-5">
          {snap.items && snap.items.length > 0 && (
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
          )}
          <div className="mt-2 flex items-center justify-between border-t border-line pt-3 text-sm">
            <span className="font-label text-[10px] uppercase tracking-wide-2 text-grey font-semibold">Total</span>
            <span className="font-price text-lg font-bold text-bone tabular-nums">{formatPrice(snap.total_amount)}</span>
          </div>
          {snap.is_cod ? (
            <p className="mt-2 text-xs text-grey leading-relaxed">
              Your order total of {formatPrice(snap.amount_due_on_delivery ?? snap.total_amount)} is due on delivery.
            </p>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-green-800">
              Your online payment of {formatPrice(snap.amount_paid_upfront ?? snap.total_amount)} has been received.
            </p>
          )}
        </div>
      </div>

      <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3 fade-up fade-up-3">
        <button
          onClick={() => {
            // Same-session hand-off for /track-order: pass ref + phone via a
            // ONE-SHOT session value (consumed and removed on the next page).
            // The phone never goes into the URL. Without a valid 10-digit phone
            // (rare), fall back to the plain ref-in-URL prefill as today.
            //
            // REPLACED, not pushed: "Order Placed" is a ONE-TIME terminal screen
            // for this order. Leaving it must consume its history entry, or Back
            // from Track Order would come straight back here and re-run the
            // lookup to show the completed order a second time.
            const digits = phone.replace(/\D/g, '').slice(0, 10);
            if (digits.length === 10) {
              setTrackHint(snap.ref, digits);
              replaceRoute('/track-order');
            } else {
              replaceRoute(`/track-order/${encodeURIComponent(snap.ref)}`);
            }
          }}
          className="btn-primary text-[14px] uppercase tracking-wide-2 font-semibold px-8 py-4"
        >
          <Truck size={16} strokeWidth={2} />
          Track Order
        </button>
        <button
          onClick={() => replaceRoute('/collections')}
          className="btn-soft border border-bone-dim text-bone text-[14px] uppercase tracking-wide-2 font-semibold px-8 py-4 hover:bg-bone hover:text-paper transition-colors"
        >
          Continue Shopping
        </button>
      </div>

      <SaveDetailsPrompt customer={snap.customer ?? formCustomer} />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Check, Truck } from 'lucide-react';
import { useD2cCart } from '@/lib/d2cCart';
import { useRouter } from '@/lib/router';
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

export type PaymentReturnState = 'checking' | 'success';

// Exactly two outcomes, decided by ONE authoritative read of the order's
// database `payment_status` (read-only RPC — never a URL param, never a
// client-side verdict):
//   * payment_status is 'success' -> a single "Order Placed" page (order ref,
//     items, total, Continue Shopping). The bag is cleared ONLY on this path.
//   * anything else (failed, pending, timeout, unknown, or the status read
//     itself erroring) -> back to the EXISTING checkout, which is kept fully
//     populated (cart, delivery form, live order) so the shopper just taps Pay
//     again on the SAME order — no duplicate creation.
// Intentionally: NO intermediate/spinner/confirming/failure screen, NO polling,
// NO retry loop, NO pages in between.

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
  const { navigate } = useRouter();
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
  // The webhook can land a few seconds AFTER the shopper returns from the hosted
  // checkout, so a single immediate read is not enough. We re-read for a short
  // grace window first. Only once that window closes do we clear the pending
  // handle and send the shopper back to /checkout — where they re-tap Pay Now on
  // the SAME order, so the stock reservation is never duplicated.
  useEffect(() => {
    if (!ref) {
      navigate('/checkout');
      return;
    }
    let cancelled = false;
    const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    // ~9s of grace, then give up and let checkout resume on the same order.
    const DEADLINE_MS = 9000;
    (async () => {
      const startedAt = Date.now();
      for (let attemptNo = 0; attemptNo < 6; attemptNo++) {
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
              settleSuccess(o);
              return;
            }
          }
        } catch {
          // lookup errored — treated exactly like "anything else" below
        }
        if (cancelled) return;
        if (Date.now() - startedAt >= DEADLINE_MS) break;
        await sleep(1500);
        if (cancelled) return;
      }
      clearPending();
      navigate('/checkout');
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, phone]);

  if (state !== 'success' || !snap) {
    // The single fast lookup is in flight; render nothing while it resolves.
    return null;
  }

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
          {snap.is_cod && (
            <p className="mt-2 text-xs text-grey leading-relaxed">
              This is a Cash on Delivery order. Nothing was charged online — the full
              amount is collected by the delivery agent on arrival.
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
            const digits = phone.replace(/\D/g, '').slice(0, 10);
            if (digits.length === 10) {
              setTrackHint(snap.ref, digits);
              navigate('/track-order');
            } else {
              navigate(`/track-order/${encodeURIComponent(snap.ref)}`);
            }
          }}
          className="btn-primary text-[11px] uppercase tracking-wide-2 font-semibold px-8 py-4"
        >
          <Truck size={16} strokeWidth={2} />
          Track Order
        </button>
        <button
          onClick={() => navigate('/collections')}
          className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-8 py-4 hover:bg-bone hover:text-paper transition-colors"
        >
          Continue Shopping
        </button>
      </div>

      <SaveDetailsPrompt customer={snap.customer ?? formCustomer} />
    </div>
  );
}

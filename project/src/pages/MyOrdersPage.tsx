import { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, UserRound, Truck, MapPin, Info } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useRouter } from '@/lib/router';
import { fetchMyOrders, claimGuestOrder, declineGuestOrder, type MyOrder } from '@/lib/account';
import { formatPrice } from '@/lib/catalog';
import { useOrderImages, imageForItem } from '@/lib/orderImages';
import { setTrackHint } from '@/lib/trackHint';
import {
  NO_AWB_NOTICE,
  awbOf,
  hasAwb,
  shippingStatusLabel,
  shippingStatusOf,
  trackingLinkFor,
} from '@/lib/shipping';
import { LoadingDots } from '@/components/LoadingDots';
import { GuestOrderConfirmCard } from './orderConfirm/GuestOrderConfirmCard';
import { formatOrderDate } from './orderConfirm/formatOrderDate';

function statusBadge(o: MyOrder): { label: string; tone: string } {
  const paid = o.payment_status === 'success';
  const isCod = o.is_cod === true || o.payment_status === 'cod_pending';
  if (isCod) {
    // COD is settled in full when the delivery arrives. Crimson, because it is
    // the one state that is still waiting on money — the accent earns its place
    // here, and it is the badge an operator scans for.
    return { label: 'COD · due on delivery', tone: 'text-crimson border-crimson/40 bg-crimson/8' };
  }
  const label = paid ? 'Paid' : o.payment_status === 'failed' ? 'Payment failed' : 'Pending';
  // Paid/failed keep their semantic colours. 'Pending' is a neutral, settled
  // fact on a white card — it must not read as a disabled control, so it is
  // ink-on-white rather than grey-on-grey.
  const tone = paid
    ? 'text-green-700 border-green-300 bg-green-50'
    : o.payment_status === 'failed'
      ? 'text-crimson border-crimson/25 bg-blush'
      : 'text-bone-dim border-line-2 bg-white';
  return { label, tone };
}

export function MyOrdersPage() {
  const { user } = useAuth();
  const { navigate } = useRouter();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [loadError, setLoadError] = useState('');
  // Refs the shopper chose to postpone rather than answer. Kept in component
  // state, NOT persisted: "ask me later" means "not right now", and a declined
  // order is the durable decision (that one is written server-side to
  // claim_declined_at). Persisting the postponement would hide the question
  // forever on the strength of one dismissed card.
  const [deferred, setDeferred] = useState<string[]>([]);
  // Product pictures for every order line, resolved from the public catalogue by
  // product code + colour. The order rows carry no image URL, so this is the one
  // source for every order surface (see lib/orderImages.ts).
  const imageIndex = useOrderImages();

  /**
   * Open the full tracking view for THIS order.
   *
   * The reference is already known, so it is never re-typed. The phone is handed
   * over as a ONE-SHOT session value (`setTrackHint`) rather than a query
   * parameter, so it never lands in the URL, browser history or a referrer
   * header. Track Order still runs the same server-side possession check
   * (`track_lookup_order` matches ref + 10-digit phone) — this only spares the
   * customer typing what this browser already legitimately holds.
   */
  const trackOrder = (o: MyOrder) => {
    const digits = String(o.customer?.phone ?? '').replace(/\D/g, '').slice(0, 10);
    if (digits.length === 10) {
      setTrackHint(o.ref, digits);
      navigate('/track-order');
    } else {
      // No usable phone on the order (rare): fall back to the plain ref route,
      // which asks for the number.
      navigate(`/track-order/${encodeURIComponent(o.ref)}`);
    }
  };

// The proof number the shopper typed to look for unclaimed guest orders.
  // Held in component state, never persisted: it is a possession proof, not a
  // preference, and the server re-checks it on every call regardless.
  const [proofPhone, setProofPhone] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookNote, setLookNote] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError('');
    const list = await fetchMyOrders(proofPhone || undefined);
    setOrders(list);
    setLoading(false);
  }, [user, proofPhone]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Look for unclaimed guest orders placed with this account's email.
   *
   * Since 20261020000000 an email match alone reveals nothing: My Orders reads
   * owned rows only, and an unclaimed guest order is discovered solely through
   * `list_retail_guest_candidates`, which needs this number as proof and returns
   * a PII-free projection. So the number is asked for up front rather than once
   * per candidate.
   */
  const lookForGuestOrders = useCallback(async () => {
    const digits = proofPhone.replace(/\D/g, '').slice(0, 10);
    if (!/^[6-9]\d{9}$/.test(digits)) {
      setLookNote('Enter the 10-digit phone number used on the order.');
      return;
    }
    setLooking(true);
    setLookNote('');
    await load();
    setLooking(false);
    setLookNote(
      'Searched. If a guest order was placed with this email and that number, it is listed below.',
    );
  }, [proofPhone, load]);

  /**
   * The orders still awaiting a decision, oldest first.
   *
   * Two exclusions, and the difference between them matters:
   *
   *   - DECLINED (`claim_declined_at` set) is permanent. The shopper answered
   *     "not mine" and the answer was written server-side, so the card must not
   *     come back on reload or on another device. A declined order is also no
   *     longer returned by the candidate lookup at all, so it does not appear
   *     here or below; it stays fully trackable on the public Track Order page.
   *   - DEFERRED is this session only; see the state comment above.
   *
   * Oldest first on purpose: the earliest unlinked order is the one most likely
   * to be mid-delivery, so it is the one worth asking about while it still
   * matters.
   *
   * No pre-filter on the order's stored phone: that field is not disclosed for a
   * candidate (the projection withholds the whole `customer` object), and every
   * row reaching here has already passed the server-side email + phone check.
   */
  const pendingClaims = useMemo(
    () =>
      orders
        .filter((o) => o.guest && !o.claim_declined_at && !deferred.includes(o.ref))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    [orders, deferred],
  );

  const handleConfirm = useCallback(
    async (o: MyOrder, phone: string) => {
      const res = await claimGuestOrder(o.ref, phone);
      if (res.ok) {
        // count 0 with ok true means the proof did not match THAT order — the
        // RPC reports a legitimate no-op as success rather than an error. Say so
        // instead of silently reloading into the same question.
        if (res.count === 0) {
          return {
            ok: false,
            error: 'That number does not match this order. Check it and try again.',
          };
        }
        await load();
        return { ok: true };
      }
      return { ok: false, error: res.error };
    },
    [load],
  );

  const handleDecline = useCallback(
    async (o: MyOrder, phone: string) => {
      const res = await declineGuestOrder(o.ref, phone);
      if (res.ok) {
        if (res.count === 0) {
          return {
            ok: false,
            error: 'That number does not match this order. Check it and try again.',
          };
        }
        await load();
        return { ok: true };
      }
      return { ok: false, error: res.error };
    },
    [load],
  );

  if (!user) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-5 py-10">
        <UserRound size={36} strokeWidth={1.4} className="text-grey" />
        <h1 className="font-display text-3xl md:text-4xl uppercase tracking-wide-2 text-bone leading-none mt-4">My Orders</h1>
        <p className="mt-4 text-sm text-bone-soft max-w-md leading-relaxed">
          Sign in to see the orders placed from this email address.
          Track Order stays open to everyone — no account needed.
        </p>
        <button
          onClick={() => navigate('/account')}
          className="mt-8 btn-primary text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
        >
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] shell shell--content py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-label text-[10px] uppercase tracking-ultra text-bone-dim">Your Account</p>
          <h1 className="font-display text-3xl md:text-4xl uppercase tracking-wide-2 text-bone leading-none mt-1">My Orders</h1>
        </div>
      </div>

      <p className="mt-4 text-xs text-bone-soft leading-relaxed">
        Orders placed with this email address, including any placed before you signed in. An email
        address alone isn't enough to reveal a guest order, so enter the number used on it and we'll
        check. You can always track any order with its reference on the Track Order page, and
        ordering never requires an account.
      </p>

      {/*
        Guest-order discovery.

        Since 20261020000000 the account can only read orders it already owns; an
        unclaimed guest order is found through `list_retail_guest_candidates`,
        which takes the phone as proof and returns a PII-free projection. So
        the number is asked once, here, rather than once per candidate.
      */}
      <div className="mt-5 border border-line-2 bg-white rounded-card px-4 py-4">
        <label
          htmlFor="guest-proof-phone"
          className="block font-label text-[10px] uppercase tracking-ultra text-bone-dim"
        >
          Phone used on a guest order
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            id="guest-proof-phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={10}
            value={proofPhone}
            onChange={(e) => setProofPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="10-digit mobile number"
            className="w-full sm:w-56 bg-transparent border border-bone/25 rounded-card px-3 py-2 text-sm text-bone focus:border-crimson focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void lookForGuestOrders()}
            disabled={looking || loading}
            className="btn-primary text-[11px] uppercase tracking-wide-2 font-semibold px-5 py-3 disabled:opacity-50"
          >
            {looking ? 'Checking...' : 'Find my order'}
          </button>
        </div>
        {lookNote && <p className="mt-2 text-[11px] text-bone-dim">{lookNote}</p>}
      </div>

      {/*
        One card at a time, oldest unlinked order first.

        This is the whole of the "is this you?" flow. It deliberately shows a
        single order rather than a list with N buttons: the shopper is being
        asked to identify THEIR order, and a screen of five near-identical cards
        answered with one guess is how the wrong order gets linked to the wrong
        account. Any others queue up behind this one automatically, because the
        reload that follows each decision re-derives the list.
      */}
      {pendingClaims.length > 0 && (
        <div className="mt-6 space-y-3">
          {pendingClaims.length > 1 && (
            <p className="flex items-center gap-2 text-[11px] text-bone-soft">
              <Info size={13} strokeWidth={2} className="shrink-0" />
              {pendingClaims.length} orders need confirming — we'll go through them one at a time.
            </p>
          )}
          <GuestOrderConfirmCard
            key={pendingClaims[0].ref}
            orderRef={pendingClaims[0].ref}
            totalAmount={pendingClaims[0].total_amount}
            createdAt={pendingClaims[0].created_at}
            itemSummary={`${pendingClaims[0].total_qty} item${pendingClaims[0].total_qty > 1 ? 's' : ''}`}
            onConfirm={(phone) => handleConfirm(pendingClaims[0], phone)}
            onDecline={(phone) => handleDecline(pendingClaims[0], phone)}
            onDismiss={() => setDeferred((d) => [...d, pendingClaims[0].ref])}
          />
        </div>
      )}

      {loadError && (
        <p className="mt-6 text-xs text-crimson bg-white border border-bone/20 px-4 py-3 rounded-card">{loadError}</p>
      )}

      <div className="mt-8 space-y-4">
        {loading ? (
          <div className="flex justify-center py-16"><LoadingDots /></div>
        ) : orders.length === 0 ? (
          <div className="group border border-line px-6 py-8 min-h-40">
            <Package size={28} strokeWidth={1.4} className="text-grey" />
            <h3 className="font-label text-sm uppercase tracking-wide-2 text-bone font-semibold mt-4">No orders yet</h3>
            <p className="mt-2 text-xs text-bone-soft max-w-md leading-relaxed">
              Nothing here yet. When you place an order while signed in — or with this email — it shows up here.
              New orders still work just fine without an account.
            </p>
          </div>
        ) : (
          orders.map((o) => {
            const badge = statusBadge(o);
            return (
              <div key={o.id} className="rounded-card border border-bone/25 bg-white px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-label text-sm tracking-wide-2 font-extrabold text-ink">
                      {o.ref}
                    </p>
                    <p className="text-[11px] text-bone-dim mt-0.5">
                      {formatOrderDate(o.created_at)} · {o.total_qty} item{o.total_qty > 1 ? 's' : ''}
                      {/*
                        "guest order" alone reads as a state, not as an action
                        still pending. Say which it is: awaiting an answer, or
                        answered "not mine" and left exactly as it is.
                      */}
                      {o.guest && !o.claim_declined_at && (
                        <span className="ml-2 text-amber-700">· not linked yet</span>
                      )}
                      {o.guest && o.claim_declined_at && (
                        <span className="ml-2 text-bone-soft">· confirmed not yours, left unlinked</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`rounded-sm border px-2.5 py-1 text-[10px] uppercase tracking-wide-2 font-semibold ${badge.tone}`}>
                      {badge.label}
                    </span>
                    <div className="text-right">
                      <span className="font-price text-lg font-bold text-ink tabular-nums">{formatPrice(o.total_amount)}</span>
                      {/* The amount due on delivery is not part of the PII-free
                          candidate projection, so a candidate never shows this
                          line rather than showing a fabricated zero. */}
                      {!o.candidate && (o.is_cod || o.payment_status === 'cod_pending') && (
                        <span className="block text-[10px] text-bone-dim">Due on delivery {formatPrice(o.amount_due_on_delivery ?? o.total_amount)}</span>
                      )}
                    </div>
                  </div>
                </div>
                {o.items.length > 0 && (
                  <ul className="mt-3 border-t border-line pt-3 space-y-2.5">
                    {o.items.map((it, i) => {
                      const img = imageForItem(imageIndex, it);
                      return (
                        <li key={i} className="flex items-center gap-3">
                          <span className="h-14 w-11 shrink-0 overflow-hidden rounded border border-line bg-paper-3">
                            {img && <img src={img} alt={it.name} className="h-full w-full object-cover" loading="lazy" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] font-medium text-bone">{it.name}</span>
                            <span className="block text-[11px] text-bone-dim">
                              {it.color} · {it.size_label} × {it.quantity}
                            </span>
                          </span>
                          <span className="shrink-0 text-[12px] font-medium text-bone tabular-nums">
                            {formatPrice(it.line_total ?? 0)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {/* Payment, shipping and the order's own state are three separate
                    facts. They are shown separately so a COD order that is still
                    awaiting collection is never read as "unpaid" or "unshipped". */}
                <div className="mt-3 border-t border-line pt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <p className="font-label text-[10px] uppercase tracking-ultra text-bone-dim">Payment</p>
                    <p className="text-[11px] text-bone mt-0.5">
                      {o.is_cod || o.payment_status === 'cod_pending'
                        ? 'Cash on delivery'
                        : o.payment_status === 'success' || o.payment_status === 'paid'
                          ? 'Paid'
                          : o.payment_status === 'failed'
                            ? 'Payment failed'
                            : 'Pending'}
                    </p>
                  </div>
                  <div>
                    <p className="font-label text-[10px] uppercase tracking-ultra text-bone-dim">Shipping</p>
                    <p className="text-[11px] text-bone mt-0.5">
                      {hasAwb(o) ? shippingStatusLabel(shippingStatusOf(o)) : 'Preparing order'}
                    </p>
                  </div>
                  {hasAwb(o) ? (
                    <>
                      <div>
                        <p className="font-label text-[10px] uppercase tracking-ultra text-bone-dim">Courier</p>
                        <p className="text-[11px] text-bone mt-0.5">{o.courier_name || '—'}</p>
                      </div>
                      <div>
                        <p className="font-label text-[10px] uppercase tracking-ultra text-bone-dim">AWB</p>
                        <p className="text-[11px] text-bone mt-0.5 tabular-nums break-all">{awbOf(o)}</p>
                      </div>
                    </>
                  ) : (
                    <div className="col-span-2 sm:col-span-1">
                      <p className="font-label text-[10px] uppercase tracking-ultra text-bone-dim">Tracking</p>
                      <p className="text-[11px] text-bone-soft mt-0.5">{NO_AWB_NOTICE}</p>
                    </div>
                  )}
                </div>
                {/* Delivery snapshot. Safe to show HERE and only here: an owned row is read
                    under `retail_orders_select_owner` (`user_id = auth.uid()`),
                    so it is this account's own order, and a candidate has no
                    `customer` at all because the candidate projection withholds
                    it. The public Track Order view is possession-gated and
                    deliberately returns no PII either. */}
                {o.customer && (o.customer.address || o.customer.city) && (
                  <div className="mt-3 border-t border-line pt-3">
                    <p className="font-label text-[10px] uppercase tracking-ultra text-bone-dim flex items-center gap-1.5">
                      <MapPin size={11} strokeWidth={2} /> Delivery
                    </p>
                    <p className="text-[11px] text-bone mt-1 leading-relaxed">
                      {o.customer.name}
                      {o.customer.name && (o.customer.city || o.customer.address) ? ' · ' : ''}
                      {[o.customer.address, o.customer.city, o.customer.state, o.customer.pincode]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {/* The direct route the removed "Track a different order"
                      picker used to serve: the order is already open, so track
                      THIS one directly — no reference re-entry. */}
                  <button
                    type="button"
                    onClick={() => trackOrder(o)}
                    className="btn-primary inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5"
                  >
                    <Truck size={13} strokeWidth={1.8} /> Track Order
                  </button>
                  {hasAwb(o) && trackingLinkFor(o) && (
                    <a
                      href={trackingLinkFor(o) as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-soft inline-flex items-center gap-2 border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 hover:bg-bone hover:text-paper transition-colors"
                    >
                      <Truck size={13} strokeWidth={1.8} /> Track Shipment
                    </a>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

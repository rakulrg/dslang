import { useState } from 'react';
import { Link, ShieldQuestion } from 'lucide-react';
import { formatPrice } from '@/lib/catalog';
import { formatOrderDate } from './formatOrderDate';

/**
 * The per-order "is this you?" decision.
 *
 * This replaced a single banner with one button that claimed EVERY matching
 * guest order at once, which was wrong twice over: it asked no question about
 * WHICH order was whose, and (before 20261019000000) it needed only an email
 * match, so anyone who knew a customer's email could pull that customer's
 * orders onto an account.
 *
 * The rules this component exists to enforce:
 *
 *   1. ONE order per card. The caller passes a single order, and the two RPCs
 *      are always given one `p_ref`. Nothing here can act on the whole list.
 *   2. A phone must be typed before either answer is sent. That number is the
 *      possession proof the RPC re-checks server-side against the phone captured
 *      on the order; it is never prefilled from the row, because the row is
 *      visible on an email match alone and echoing the number back would make
 *      the check theatre.
 *   3. Both answers require the same proof. "No" is just as gated as "Yes",
 *      otherwise anyone who knew an email could permanently suppress a real
 *      customer's order.
 *   4. A wrong number is an ordinary outcome, not an error state worth
 *      punishing — the message is shown inline and the card stays open.
 */
export function GuestOrderConfirmCard({
  orderRef,
  totalAmount,
  createdAt,
  itemSummary,
  onConfirm,
  onDecline,
  onDismiss,
}: {
  orderRef: string;
  totalAmount: number;
  createdAt: string;
  /** Short "2 items · ₹3,847" style line, built by the caller from the order. */
  itemSummary: string;
  onConfirm: (phone: string) => Promise<{ ok: boolean; error?: string }>;
  onDecline: (phone: string) => Promise<{ ok: boolean; error?: string }>;
  /** Close the card without deciding — the order stays unlinked and visible. */
  onDismiss: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState<'confirm' | 'decline' | null>(null);
  const [error, setError] = useState('');

  // The value holds a space after the fifth digit for legibility, so readiness
  // is judged on the digits alone.
  const digits = phone.replace(/\D/g, '');
  const phoneReady = /^[6-9]\d{9}$/.test(digits);

  const run = async (which: 'confirm' | 'decline') => {
    if (busy || !phoneReady) return;
    setBusy(which);
    setError('');
    const res = which === 'confirm' ? await onConfirm(digits) : await onDecline(digits);
    setBusy(null);
    if (res.ok) return; // The parent reloads; this card is gone by then.
    setError(res.error || 'Please try again.');
  };

  return (
    <div className="rounded-card border border-amber-300 bg-amber-50 px-5 py-5">
      <div className="flex items-start gap-2.5">
        <ShieldQuestion size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-amber-700" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-snug text-amber-900">
            Is order {orderRef} yours?
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800/90">
            It was placed with this email address before you had an account. Nothing is linked
            until you say so, and it stays trackable either way.
          </p>
        </div>
      </div>

      <dl className="mt-3.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-amber-300/60 pt-3 text-[11px]">
        <div className="flex items-baseline gap-1.5">
          <dt className="uppercase tracking-ultra text-amber-800/70">{itemSummary}</dt>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="uppercase tracking-ultra text-amber-800/70">Placed</dt>
          <dd className="font-medium text-amber-900">{formatOrderDate(createdAt)}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="uppercase tracking-ultra text-amber-800/70">Total</dt>
          <dd className="font-price font-semibold text-amber-900 tabular-nums">
            {formatPrice(totalAmount)}
          </dd>
        </div>
      </dl>

      {/* The proof field. Shared by both answers on purpose — the shopper types
          the number once and then picks. */}
      <div className="mt-4">
        <label
          htmlFor={`guest-claim-phone-${orderRef}`}
          className="block text-[10px] uppercase tracking-ultra text-amber-800/80"
        >
          Phone number used on the order
        </label>
        <input
          id={`guest-claim-phone-${orderRef}`}
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          maxLength={14}
        value={phone}
        disabled={busy !== null}
        onChange={(e) => {
          setError('');
          // Strip to the digit run and cap it at 10 — the field holds the proof
          // itself, so letting it grow past 10 only produces numbers the RPC
          // will reject. Separators are re-added so it still reads like a
          // phone number while being typed.
          const d = e.target.value.replace(/\D/g, '').slice(0, 10);
          setPhone(d.replace(/^(\d{5})(\d{5})$/, '$1 $2'));
        }}
        placeholder="10-digit mobile number"
          className="mt-1.5 w-full rounded-soft border border-amber-400 bg-white px-3.5 py-2.5 text-[15px] text-bone placeholder:text-bone-soft/60 focus:border-amber-600 focus:outline-none transition-colors disabled:opacity-60 sm:max-w-xs"
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-800/80">
          We ask because an email address alone isn't enough to prove an order is yours.
        </p>
      </div>

      {error && (
        <p className="mt-3 border border-crimson/30 bg-white px-3 py-2 text-[11px] leading-relaxed text-crimson" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={() => void run('confirm')}
          disabled={busy !== null || !phoneReady}
          className="inline-flex items-center gap-1.5 border border-amber-700 bg-amber-700 px-4 py-2.5 text-[14px] font-semibold uppercase tracking-wide-2 text-white transition-colors hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Link size={13} strokeWidth={2.2} />
          {busy === 'confirm' ? 'Linking…' : 'Yes, link it to my account'}
        </button>
        <button
          type="button"
          onClick={() => void run('decline')}
          disabled={busy !== null || !phoneReady}
          className="inline-flex items-center gap-1.5 border border-amber-500 px-4 py-2.5 text-[14px] font-semibold uppercase tracking-wide-2 text-amber-900 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy === 'decline' ? 'Saving…' : "No, not mine"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy !== null}
          className="ml-auto text-[14px] uppercase tracking-wide-2 text-amber-800/80 underline underline-offset-2 transition-colors hover:text-amber-900 disabled:opacity-50"
        >
          Ask me later
        </button>
      </div>
    </div>
  );
}

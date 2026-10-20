import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatPrice } from '@/lib/catalog';

/**
 * The confirmation step before a cancellation REQUEST is sent.
 *
 * This dialog exists to make one thing unmistakable: pressing the button asks an
 * administrator to review a cancellation — it does NOT cancel anything. So it
 * states, plainly and before the button:
 *
 *   - which order it is (the reference),
 *   - how it was paid and how much has actually been collected,
 *   - that stock is still reserved and the order is unchanged until an admin
 *     decides, and
 *   - that a paid order's refund is handled separately and by hand.
 *
 * The reason is optional. It is free text the customer chooses to give, passed
 * straight to `request_order_cancellation`; nothing here validates or interprets
 * it, and the length cap only keeps a pasted novel out of the row.
 *
 * The dialog owns its own busy/error state because a refusal (already requested,
 * shipped in the meantime, not the owner) is an ordinary answer from the server
 * that must be shown in place, with the dialog staying open.
 */
export function CancellationRequestDialog({
  orderRef,
  paymentLabel,
  amountPaid,
  refundDue,
  onConfirm,
  onClose,
}: {
  orderRef: string;
  /** Human label for how the order was paid — "Cash on delivery", "Paid", … */
  paymentLabel: string;
  /** What has actually been collected so far, in rupees. 0 for a COD order. */
  amountPaid: number;
  /** true when money was collected and a manual refund would be owed. */
  refundDue: boolean;
  onConfirm: (reason: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const res = await onConfirm(reason.trim());
    // On success the parent reloads and unmounts this dialog; on failure the
    // reason the server gave stays on screen so nothing is silently swallowed.
    setBusy(false);
    if (!res.ok) setError(res.error || 'Could not submit the request. Please try again.');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={busy ? undefined : onClose}
        className="absolute inset-0 bg-ink/60 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-request-title"
        className="relative w-full max-w-md bg-white border border-line rounded-lg p-5 sm:p-6 shadow-xl animate-fade-in max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-crimson" />
          <h3
            id="cancel-request-title"
            className="font-label text-sm uppercase tracking-wide-2 text-bone font-semibold"
          >
            Request cancellation of {orderRef}?
          </h3>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-line py-3 text-[11px]">
          <div>
            <dt className="font-label uppercase tracking-ultra text-bone-dim">Order</dt>
            <dd className="mt-0.5 font-label font-extrabold tracking-wide-2 text-ink">{orderRef}</dd>
          </div>
          <div>
            <dt className="font-label uppercase tracking-ultra text-bone-dim">Payment method</dt>
            <dd className="mt-0.5 text-bone">{paymentLabel}</dd>
          </div>
          <div>
            <dt className="font-label uppercase tracking-ultra text-bone-dim">Amount paid</dt>
            <dd className="mt-0.5 font-price font-semibold text-ink tabular-nums">
              {formatPrice(amountPaid)}
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs leading-relaxed text-bone-soft">
          This sends a request for an administrator to review. It does not cancel the order
          immediately, and nothing about your order changes until they decide.
          {refundDue
            ? ' If a cancellation is approved, any amount already paid is refunded separately and is shown as pending until the refund is made and confirmed.'
            : ' A cancellation is only possible before the order ships.'}
        </p>

        <div className="mt-4">
          <label
            htmlFor="cancel-request-reason"
            className="block font-label text-[10px] uppercase tracking-ultra text-bone-dim"
          >
            Reason (optional)
          </label>
          <textarea
            id="cancel-request-reason"
            value={reason}
            disabled={busy}
            maxLength={500}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Tell us why you'd like to cancel — helps us review faster."
            className="mt-1.5 w-full rounded-soft border border-bone/25 bg-white px-3.5 py-2.5 text-sm text-bone placeholder:text-bone-soft/60 focus:border-crimson focus:outline-none transition-colors disabled:opacity-60"
          />
        </div>

        {error && (
          <p className="mt-3 border border-crimson/30 bg-blush px-3 py-2 text-[11px] leading-relaxed text-crimson" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center gap-2 border border-line text-bone-dim hover:border-bone-dim hover:text-bone text-[14px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded transition-colors disabled:opacity-50"
          >
            Keep order
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex items-center gap-2 bg-crimson text-white text-[14px] uppercase tracking-wide-2 font-semibold px-4 py-2.5 rounded hover:bg-crimson/90 transition-colors disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Request cancellation'}
          </button>
        </div>
      </div>
    </div>
  );
}

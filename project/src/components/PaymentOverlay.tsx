import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { lockScroll, unlockScroll } from '@/lib/scrollLock';

/**
 * Full-screen payment overlay — the one continuous white screen shown from the
 * moment the customer hits Pay Now until the Cashfree handoff, and again while
 * the payment is being confirmed on return. Pure presentation; the checkout
 * page drives the variant + message and does all the real work behind it.
 *
 * Variants:
 *   creating    — "Creating your order…" -> "Securing your payment…" -> handoff
 *   confirming  — post-return verification; escalates to an "almost there" note
 *                 when verification takes a moment so it never looks frozen
 *   failure     — clear failure result with a working Try Again button
 *   pending     — gateway still awaiting an answer; honest + recoverable
 */

export type PaymentOverlayVariant = 'creating' | 'confirming' | 'failure' | 'pending';

export interface PaymentOverlayProps {
  variant: PaymentOverlayVariant;
  /** Primary line. Status for creating/confirming, title for failure/pending. */
  message: string;
  /** Muted secondary copy (failure/pending body). */
  detail?: string;
  /** Small muted trust line near the bottom of the block, e.g. the Cashfree label. */
  trustLine?: string;
  /** Re-run the flow for the SAME order (never creates a duplicate). */
  onRetry?: () => void;
  onContact?: () => void;
  onBackToBag?: () => void;
  /** Re-verify an in-flight/uncertain payment. */
  onRefresh?: () => void;
}

/** Brand circular spinner: bone ring with a crimson arc. */
function PaymentSpinner() {
  return (
    <span aria-hidden="true" className="dslang-spin block h-9 w-9 rounded-full border-2 border-bone/15 border-t-crimson" />
  );
}

export function PaymentOverlay({
  variant,
  message,
  detail,
  trustLine,
  onRetry,
  onContact,
  onBackToBag,
  onRefresh,
}: PaymentOverlayProps) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    lockScroll();
    return () => unlockScroll();
  }, []);

  // If the creating/confirming step is still running after ~6s, surface a
  // gentle "almost there" note instead of letting the screen look frozen.
  useEffect(() => {
    if (variant !== 'creating' && variant !== 'confirming') return;
    setSlow(false);
    const t = window.setTimeout(() => setSlow(true), 6000);
    return () => window.clearTimeout(t);
  }, [variant, message]);

  const isWorking = variant === 'creating' || variant === 'confirming';
  const showTryAgain = variant === 'failure' && onRetry;
  const showRefresh = variant === 'pending' && onRefresh;

  return (
    <div
      className="fixed inset-0 z-[300] flex flex-col items-center justify-center bg-white text-bone"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center px-6 py-10 text-center">
        {isWorking ? (
          <PaymentSpinner />
        ) : (
          <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center">
            <AlertTriangle size={30} strokeWidth={1.4} className="text-crimson" />
          </span>
        )}

        <p className="mt-6 font-display text-xl md:text-2xl uppercase tracking-wide-2 leading-none">
          {message}
        </p>

        {isWorking && slow && (
          <p className="mt-3 max-w-xs text-xs text-grey leading-relaxed">
            This is taking a little longer than usual — please hold on.
          </p>
        )}

        {detail && (
          <p className="mt-3 max-w-md text-sm text-grey leading-relaxed">{detail}</p>
        )}

        {showTryAgain && (
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={onRetry}
              className="btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
            >
              Try Again
            </button>
            {onContact && (
              <button
                type="button"
                onClick={onContact}
                className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
              >
                Contact Us
              </button>
            )}
            {onBackToBag && (
              <button
                type="button"
                onClick={onBackToBag}
                className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
              >
                Back To Bag
              </button>
            )}
          </div>
        )}

        {showRefresh && (
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={onRefresh}
              className="btn-dark text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4"
            >
              <RefreshCw size={15} strokeWidth={2} />
              Try Again
            </button>
            {onContact && (
              <button
                type="button"
                onClick={onContact}
                className="btn-soft border border-bone-dim text-bone text-[11px] uppercase tracking-wide-2 font-semibold px-7 py-4 hover:bg-bone hover:text-paper transition-colors"
              >
                Contact Us
              </button>
            )}
          </div>
        )}

        {trustLine && isWorking && (
          <p className="mt-10 font-label text-[10px] uppercase tracking-wide-2 text-grey">
            {trustLine}
          </p>
        )}
      </div>
    </div>
  );
}
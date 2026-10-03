import { useCallback, useEffect, useState } from 'react';
import { Check, Mail, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { LoginModal } from '@/components/LoginModal';
import { GoogleG } from '@/components/GoogleG';
import { linkHref } from '@/lib/router';
import { customerToProfile, saveProfile, savePromptDismissed, dismissSavePrompt, clearSavePromptDismissal } from '@/lib/account';
import type { RetailCustomer } from '@/lib/orders';

/**
 * The OPTIONAL "Save your details for faster checkout" call-to-action shown on
 * Order Confirmed screens. It is always:
 *   - guest-safe: checkout never requires it, and "No thanks" dismisses it;
 *   - logged-in automatic: a signed-in shopper's details are saved silently.
 * Every save is best-effort — if the DB migration hasn't landed yet the card
 * simply stays quiet and the confirmation remains fully functional.
 */
export function SaveDetailsPrompt({
  customer,
  apartment,
}: {
  customer: RetailCustomer | null | undefined;
  apartment?: string;
}) {
  const { user, signInWithGoogle } = useAuth();
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'skipped'>('idle');
  const [loginOpen, setLoginOpen] = useState(false);
  const [gBusy, setGBusy] = useState(false);
  const [gError, setGError] = useState('');

  // Skip persists ("don't ask again") until the shopper actually saves.
  useEffect(() => {
    if (!user && savePromptDismissed()) setState('skipped');
  }, [user]);

  const doSave = useCallback(async (userId: string) => {
    if (!customer) return;
    setState('saving');
    const ok = await saveProfile(userId, customerToProfile(customer, apartment));
    setState(ok ? 'saved' : 'idle');
    if (ok) clearSavePromptDismissal();
  }, [customer, apartment]);

  // Google OAuth round-trip: the shopper returns signed-in (the header Account
  // state flips) even though the prompt's state was reset on the hard reload —
  // save automatically the moment the session is applied.
  useEffect(() => {
    if (user && customer && state === 'idle') void doSave(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!customer) return null;

  // Logged-in: details were (or will be) saved silently — show a quiet,
  // non-actionable confirmation with a gateway to My Orders.
  if (user) {
    return (
      <div className="mt-8 w-full max-w-md mx-auto border border-line bg-white px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs text-bone-soft">
          <Check size={14} strokeWidth={2.5} className="text-green-700" />
          {state === 'saving' ? 'Saving your details…' : state === 'saved' ? 'Your details are saved for faster checkout.' : 'Your details will be saved to your account.'}
        </p>
        <a href={linkHref('/my-orders')} className="text-[11px] uppercase tracking-wide-2 font-semibold text-bone hover:text-bone-dim transition-colors">
          My Orders →
        </a>
      </div>
    );
  }

  if (state === 'skipped') return null;

  const handleGoogle = async () => {
    setGError('');
    setGBusy(true);
    const { error } = await signInWithGoogle();
    if (error) {
      setGBusy(false);
      setGError(error.message && /not configured|not enabled|disabled/i.test(error.message)
        ? 'Google sign-in isn’t enabled on this store yet — try Email instead.'
        : error.message || 'Google sign-in could not be started.');
      return;
    }
    // Success = full-page redirect to Google.
  };

  return (
    <>
      <div className="mt-8 w-full max-w-md mx-auto border border-line bg-white px-5 py-6 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <p className="font-label text-[11px] uppercase tracking-wide-2 text-bone font-semibold leading-snug">
            Save your details for faster checkout
          </p>
          <button
            onClick={() => { dismissSavePrompt(); setState('skipped'); }}
            className="-mt-1 -mr-1 shrink-0 p-1 text-grey/70 hover:text-bone-soft transition-colors"
            aria-label="No thanks"
            title="No thanks"
          >
            <X size={13} strokeWidth={1.8} />
          </button>
        </div>
        <p className="mt-2 text-xs text-bone-soft leading-relaxed">
          Optional &mdash; checkout stays open to everyone. Sign in to save your details and make your next checkout faster.
        </p>

        {/* Two account actions, identical in every dimension so neither reads as
            the odd one out. Neither is filled: the primary action on this screen
            is TRACK ORDER, so these stay quiet. */}
        <div className="mt-5 flex flex-col gap-2.5">
          <button
            onClick={() => setLoginOpen(true)}
            className="flex w-full items-center justify-center gap-2.5 rounded-[4px] border border-line-2 bg-white px-4 py-3 text-[13px] font-medium leading-5 text-bone transition-colors hover:bg-paper-2 hover:border-bone/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone"
          >
            <Mail size={15} strokeWidth={1.8} className="shrink-0 text-bone-soft" aria-hidden="true" />
            Continue with Email
          </button>
          <button
            onClick={handleGoogle}
            disabled={gBusy}
            className="flex w-full items-center justify-center gap-2.5 rounded-[4px] border border-line-2 bg-white px-4 py-3 text-[13px] font-medium leading-5 text-bone transition-colors hover:bg-paper-2 hover:border-bone/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <GoogleG className="h-[15px] w-[15px] shrink-0" />
            {gBusy ? 'Opening Google…' : 'Continue with Google'}
          </button>
        </div>

        {/* Tertiary: a text action, not a third button. */}
        <div className="mt-4 text-center">
          <button
            onClick={() => { dismissSavePrompt(); setState('skipped'); }}
            className="text-[12px] text-bone-soft underline underline-offset-4 decoration-line-2 hover:text-bone hover:decoration-bone-soft transition-colors"
          >
            Skip for now
          </button>
        </div>

        {gError && <p role="alert" className="mt-4 text-xs text-crimson bg-paper-2 border border-line px-3 py-2.5">{gError}</p>}
      </div>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} onSignedIn={async (u) => { await doSave(u.id); }} />
    </>
  );
}
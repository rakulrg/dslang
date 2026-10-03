import { useState, type FormEvent, useEffect, useLayoutEffect, useRef } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { useAuth, setForgetSession, consumeAuthNotice } from '@/lib/auth';
import { useRouter, linkHref } from '@/lib/router';
import { lockScroll, unlockScroll } from '@/lib/scrollLock';

// The two timings of a Login <-> Sign Up swap. Sign Up carries one field the
// login form does not (Full Name), so the box resizes while the content
// crossfades.
//
//   HEIGHT_MS  how long the panel takes to reach its new height
//   SWAP_MS    how long the swap is considered in flight — a little longer
//              than HEIGHT_MS so the card keeps clipping (rather than
//              scrolling) for the whole resize, then settles back to
//              overflow-y-auto
//
// The content fade is in CSS and deliberately finishes BEFORE the height does:
// by the time the incoming form is fully opaque the box is already tall enough
// to hold it, so nothing is ever seen half-clipped.
const HEIGHT_MS = 300;
const SWAP_MS = 340;

/** Customer-facing wording for the errors Supabase returns on a resend. */
function resendMessage(err: { message?: string }): string {
  if (/rate limit|too many|too soon|rate_limit|security/i.test(err.message ?? '')) {
    return 'You’ve asked for a few links already. Please wait a minute and try again.';
  }
  if (/already confirmed|already been confirmed|confirmed/i.test(err.message ?? '')) {
    return 'This email is already verified — you can log in now.';
  }
  if (/not found|does not exist|signups not allowed/i.test(err.message ?? '')) {
    return 'We couldn’t find an account for that email. Try creating an account.';
  }
  if (/network|failed to fetch/i.test(err.message ?? '')) {
    return 'Network issue — check your connection and try again.';
  }
  return 'The link could not be sent. Please try again.';
}

function googleMessage(err: { message?: string }): string {
  if (err.message && /not configured|not enabled|disabled/i.test(err.message)) {
    return 'Google sign-in isn’t enabled on this store yet — try Email instead.';
  }
  return err.message || 'Google sign-in could not be started. Try again.';
}

const fieldLabel = 'mb-1.5 block text-[13px] font-medium text-bone-soft';
const fieldBox = 'flex items-center gap-2 rounded-lg bg-[#f6f6f4] px-4 transition-colors focus-within:bg-white focus-within:ring-1 focus-within:ring-bone/30';
const fieldInput = 'min-w-0 flex-1 bg-transparent py-3 text-sm text-bone placeholder:text-grey focus:outline-none';
const eyeBtn = 'shrink-0 p-1 text-grey hover:text-bone transition-colors';
const primaryBtn =
  'w-full rounded-lg bg-bone py-3.5 text-[13px] font-semibold text-paper transition-colors hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone disabled:opacity-50 disabled:cursor-not-allowed';
const ghostBack = 'mt-3 text-[11px] uppercase tracking-wide-2 text-grey hover:text-bone transition-colors underline-offset-4 hover:underline';

function SignInUpTabs({ tab, onTab }: { tab: 'login' | 'signup'; onTab: (t: 'login' | 'signup') => void }) {
  return (
    <div className="mt-5 flex rounded-full bg-[#f1f0ec] p-1" role="tablist" aria-label="Account mode">
      {(['login', 'signup'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => onTab(t)}
          className={`flex-1 rounded-full py-2.5 text-[16px] transition-colors ${
            tab === t ? 'bg-bone font-semibold text-paper' : 'font-medium text-bone-dim hover:text-bone'
          }`}
        >
          {t === 'login' ? 'Log In' : 'Sign Up'}
        </button>
      ))}
    </div>
  );
}

function GoogleLogo() {
  return (
    <span className="flex items-center justify-center h-5 w-5" aria-hidden="true">
      <svg viewBox="0 0 48 48" className="h-5 w-5">
        <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34.6 6.1 29.5 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34.6 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.3C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
        <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.3C36.9 40.1 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/>
      </svg>
    </span>
  );
}

export function LoginModal({
  isOpen,
  onClose,
  initialMode = 'signin',
  onSignedIn,
}: {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'signin' | 'signup';
  /** Optional: when set, a successful login calls this instead of navigating
   *  to /account, so embedded flows (save-details on Order Confirmed) can stay
   *  in context. */
  onSignedIn?: (user: { id: string; email?: string | null }) => void;
}) {
  const { user, loading, isAdmin, isAdminLoading, signIn, signUp, resendVerification, signInWithGoogle, resetPassword } = useAuth();
  const { navigate } = useRouter();
  const [tab, setTab] = useState<'login' | 'signup'>(initialMode === 'signup' ? 'signup' : 'login');
  const [view, setView] = useState<'form' | 'verifyEmail' | 'forgot' | 'resetSent'>('form');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState('');
  // The verification screen's own transient state: a resend in flight, the
  // confirmation that it worked, and one extra customer-facing sentence when we
  // arrived here because an account for this address ALREADY exists (so the
  // reason we are not signing them in is not the signup itself).
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState('');
  const [verifyNote, setVerifyNote] = useState('');

  // Is a Login <-> Sign Up swap in flight? Presentation only: it holds no form
  // value, decides no validation and gates nothing. It exists to turn the
  // panel's height transition on for the duration of the resize and to keep the
  // card clipping instead of scrolling while the box is still catching up.
  const [swapping, setSwapping] = useState(false);
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Measured height of whichever form is on screen, and the refs used to get
  // it. `probe` is an unstyled in-flow wrapper around the modal's contents, so
  // it is always exactly as tall as the content it holds regardless of how the
  // panel is currently sized — which is what makes it safe to read while the
  // box is mid-animation. Measuring the card itself would not work: on the way
  // down it reports its own animated height back, and the transition would
  // chase itself.
  const probeRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);

  // Reset the form each time the modal opens, honoring the requested mode
  // (e.g. "Create Account" from the menu opens straight in signup).
  useEffect(() => {
    if (isOpen) {
      setTab(initialMode === 'signup' ? 'signup' : 'login');
      setView('form');
      setFullName('');
      setEmail('');
      setPassword('');
      setShowPw(false);
      setBusy(false);
      setGoogleBusy(false);
      setResendBusy(false);
      setResendNotice('');
      setVerifyNote('');
      // A swap still in flight belongs to the previous session of this modal.
      setSwapping(false);
      // A cancelled or failed Google round trip bounces the shopper back to
      // the storefront, so the explanation has to survive until the modal
      // (re)opens — otherwise a denied consent screen looks like nothing
      // happened.
      setError(consumeAuthNotice() ?? '');
    }
  }, [isOpen, initialMode]);

  // The swap is driven by a timer, and this component stays mounted while the
  // modal is closed - it renders null rather than unmounting - so a close has
  // to cancel the swap explicitly. Otherwise a timer left over from a swap the
  // shopper abandoned could fire after the modal reopened.
  useEffect(() => {
    if (isOpen) return;
    if (swapTimer.current) clearTimeout(swapTimer.current);
    setSwapping(false);
  }, [isOpen]);

  // Keep the panel's height on the measured height of its content.
  //
  // A layout effect does the first measurement before the first paint, so the
  // panel is never briefly laid out at zero height. The observer covers every
  // change after that — switching tab, a validation message appearing, the
  // checkbox wrapping onto a second line on a narrow phone — and each one
  // becomes a smooth resize rather than a snap.
  useLayoutEffect(() => {
    const probe = probeRef.current;
    const card = cardRef.current;
    if (!probe || !card) return;

    // The probe sits inside the card's padding, so its own height is the
    // content only; the panel's height is that plus the vertical padding.
    const apply = (contentHeight: number) => {
      const cs = getComputedStyle(card);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      setPanelHeight(Math.round(contentHeight + padY));
    };

    apply(probe.getBoundingClientRect().height);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(entry.contentRect.height);
    });
    ro.observe(probe);
    return () => ro.disconnect();
  }, [isOpen]);

  // Once signed in, admins go to the dashboard and everyone else to their
  // account. A Google round trip never lands here — it returns to a fresh
  // document and App restores the pre-OAuth route — so this only covers the
  // in-page email/password and embedded save-details flows.
  useEffect(() => {
    if (!isOpen || loading || isAdminLoading || !user) return;
    if (onSignedIn) {
      onSignedIn({ id: user.id, email: user.email ?? null });
      onClose();
      return;
    }
    // Only choose a destination once the admin_users check has settled, so a
    // real admin is never sent to /account on the strength of an unresolved
    // isAdmin (App's /account guard would then bounce them straight back).
    navigate(isAdmin ? '/admin' : '/account');
    onClose();
  }, [user, loading, isAdmin, isAdminLoading, navigate, onClose, onSignedIn, isOpen]);

  // Close the modal with Escape and lock body scroll while it is open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    lockScroll();
    return () => {
      window.removeEventListener('keydown', onKey);
      unlockScroll();
    };
  }, [isOpen, onClose]);

  // Safety net: an auth request should never leave the form permanently
  // loading. If a request genuinely never resolves, surface a timeout and
  // restore the buttons. Normal failures all settle via finally.
  useEffect(() => {
    if (!busy && !googleBusy) return;
    const t = setTimeout(() => {
      setError(busy ? 'This is taking too long. Please try again.' : 'Google sign-in is taking too long. Please try again.');
      setBusy(false);
      setGoogleBusy(false);
    }, 25000);
    return () => clearTimeout(t);
  }, [busy, googleBusy]);

  if (!isOpen) return null;

  // The only place `tab` moves, apart from the "already registered" recovery in
  // handleSubmit (which bypasses the animation deliberately — that path is an
  // error being corrected, not a shopper choosing a mode).
  //
  // The tab flips on the same click that turned the animation on. The panel's
  // new height is measured from the new content a frame later, which is
  // imperceptible, and it means the box is already moving while the outgoing
  // form is still fading rather than waiting for it to leave first.
  const switchTab = (t: 'login' | 'signup') => {
    if (t === tab) return;
    setError('');
    // Reduced motion drops the travel in CSS; collapse the timings here too,
    // so the panel resizes at once instead of easing for someone who asked it
    // not to.
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setSwapping(true);
    setTab(t);
    if (swapTimer.current) clearTimeout(swapTimer.current);
    swapTimer.current = setTimeout(() => setSwapping(false), calm ? 0 : SWAP_MS);
  };

  // The address as the ACCOUNT actually knows it. Signup and sign-in both send
  // the lower-cased, trimmed form, so the verification screen must name that
  // same address — otherwise a customer who typed "Customer@Email.com" reads a
  // different address than the one their link actually went to.
  const accountEmail = email.trim().toLowerCase();

  // The panel is the flex child of the centred overlay, so giving it an
  // explicit height keeps it centred while that height animates. `null` means
  // "not measured yet", which only happens before the first layout pass.
  const panelStyle =
    panelHeight === null
      ? undefined
      : {
          height: panelHeight,
          // The transition only exists for the duration of a swap. Leaving it
          // on permanently would ease every resize the observer reports —
          // including the window being resized or rotated.
          transition: swapping
            ? `height ${
                window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : HEIGHT_MS
              }ms cubic-bezier(0, 0, 0.2, 1)`
            : 'none',
        };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || googleBusy) return;
    setError('');

    const cleanEmail = email.trim();
    const cleanName = fullName.trim();
    if (tab === 'signup') {
      // Trimmed first, so a name of only spaces is treated as the empty name it
      // really is rather than accepted as a one-character "name".
      if (!cleanName) {
        setError('Please enter your full name.');
        return;
      }
    }
    if (!cleanEmail) {
      setError('Please enter your email address.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }
    if (tab === 'signup') {
      // The project's existing password rule (unchanged from the login form's
      // `minLength`): Supabase rejects anything shorter, so this only saves the
      // customer a round trip.
      if (password.length < 6) {
        setError('Password must be at least 6 characters.');
        return;
      }
    }

    setBusy(true);
    try {
      if (tab === 'signup') {
        const { error: signUpError, session, user: signedUp } = await signUp(
          cleanEmail.toLowerCase(),
          password,
          { fullName: cleanName, optsOut: false },
        );
        if (signUpError) {
          if (/already registered|user_already_exists|email already/i.test(signUpError.message)) {
            /* The address already has an account. Supabase will NOT create a
             * second one, and we must not pretend it did — so this is
             * recognised as the existing account rather than reported as a
             * failure, and the shopper is offered the two things that can
             * actually resolve it: resend the verification link, or log in.
             * Which one they need is decided by Supabase on the resend. */
            setView('verifyEmail');
            setResendNotice('');
            setVerifyNote('An account already exists for this email. Resend the verification link if you haven’t confirmed it yet.');
          } else if (/rate limit|too many|too soon|rate_limit/i.test(signUpError.message)) {
            setError('You\'re creating accounts too quickly. Please wait a few minutes and try again.');
          } else if (/password/i.test(signUpError.message)) {
            // Supabase's password complaint is already written for a human, and
            // it is the only technical error worth passing through verbatim.
            setError(signUpError.message);
          } else {
            setError('An account could not be created. Please try again.');
          }
          return;
        }
        if (signedUp && !session) {
          // Email confirmation is enabled: the account was created but the
          // visitor must confirm the link before the first sign-in. This is the
          // normal success path, NOT a failure — hence no error message.
          setView('verifyEmail');
          setResendNotice('');
          setVerifyNote('');
          return;
        }
        // A session came back, which means this project has email confirmation
        // switched OFF in the Supabase dashboard: the account is already usable
        // and the sign-in effect above takes it from here.
      } else {
        const { error: signInError } = await signIn(cleanEmail.toLowerCase(), password);
        if (signInError) {
          if (/rate limit|too many|too soon|rate_limit/i.test(signInError.message)) {
            setError('You\'re doing that too quickly. Please wait a few minutes and try again.');
          } else if (/invalid login credentials|invalid_credentials/i.test(signInError.message)) {
            setError('The email or password is incorrect. Please try again.');
          } else if (/email not confirmed|email_not_confirmed|unconfirmed/i.test(signInError.message)) {
            /* The account is real and the password was right, but the address is
             * still unverified — so this must NOT read as "incorrect password"
             * and must NOT leave the shopper stuck on a dead error. Go to the
             * verification screen, which is the one place a resend link can be
             * requested from. */
            setView('verifyEmail');
            setResendNotice('');
            setVerifyNote('This account still needs to be verified. Resend the link below.');
            return;
          } else if (/network|failed to fetch/i.test(signInError.message)) {
            setError('Network issue — check your connection and try again.');
          } else {
            setError('Sign-in failed. Please try again.');
          }
          return;
        }
        if (!remember) setForgetSession();
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  /* Resend the confirmation link from the verification screen.
   *
   * This is Supabase's own resend endpoint. No token is minted, stored or
   * checked here — the link it mails is the same one the original signup sent,
   * and the same one that flips the account to verified. */
  const handleResend = async () => {
    if (resendBusy) return;
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setResendNotice('Enter a valid email address first, then resend the link.');
      return;
    }
    setResendBusy(true);
    setResendNotice('');
    try {
      const { error: resendError } = await resendVerification(cleanEmail);
      if (resendError) {
        setResendNotice(resendMessage(resendError));
        return;
      }
      setResendNotice(`Sent again to ${cleanEmail}. It can take a minute to arrive.`);
    } catch {
      setResendNotice('The link could not be sent. Please try again.');
    } finally {
      setResendBusy(false);
    }
  };

  const handleGoogle = async () => {
    if (googleBusy || busy) return;
    setError('');
    setGoogleBusy(true);
    try {
      const { error: googleError } = await signInWithGoogle();
      if (googleError) {
        setError(googleMessage(googleError));
        return;
      }
      // Success = full-page redirect to Google; the browser leaves this page.
    } catch {
      setError('Google sign-in could not be started. Try again.');
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleForgot = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const cleanEmail = email.trim();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Please enter your email address.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const { error: forgotError } = await resetPassword(cleanEmail.toLowerCase());
      if (forgotError) {
        if (/rate limit|too many|too soon|rate_limit/i.test(forgotError.message)) {
          setError('You\'re doing that too quickly. Please wait a few minutes and try again.');
        } else {
          setError(forgotError.message || 'The reset link could not be sent. Please try again.');
        }
        return;
      }
      setView('resetSent');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (user) {
    return (
      <div role="dialog" aria-modal="true" aria-label="Account redirect" className="fixed inset-0 z-[80] flex items-center justify-center px-4">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
        <div className="relative w-[min(430px,calc(100%-32px))] bg-white rounded-2xl px-6 py-7 animate-scale-in">
          <button onClick={onClose} className="absolute top-4 right-4 text-grey hover:text-bone transition-colors" aria-label="Close">
            <X size={20} strokeWidth={1.8} />
          </button>
          <div className="flex justify-center">
            <span className="font-brand text-2xl tracking-[0.03em] text-bone">DSLANG</span>
          </div>
          <h2 className="mt-4 text-center font-price text-[26px] uppercase leading-[1.05]">
            {onSignedIn ? 'Signed in' : 'Welcome back'}
          </h2>
          <p className="mt-2 text-center text-sm text-bone-soft">
            You are signed in as {user.email ?? 'your account'}.
          </p>
          <p className="mt-4 text-center text-xs text-grey">
            {isAdmin && !onSignedIn ? 'Redirecting to Admin Dashboard…' : 'All set — continuing…'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="login-title" className="fixed inset-0 z-[80] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      {/* Two boxes, on purpose.

          The outer one is the flex child of this centred overlay and carries an
          explicit height, so when the height animates the panel grows and
          shrinks about its own centre instead of lurching towards the top of
          the screen. max-h keeps a tall Sign Up form inside the viewport.

          The inner card is absolutely positioned and fills that box exactly, so
          it keeps the rounded corners, the shadow and its own internal scroll
          while the box around it resizes. Width, padding and every other
          visual detail are unchanged — the card simply stopped owning its
          height. */}
      <div
        className="relative w-[min(430px,calc(100%-32px))] max-h-[92dvh] animate-scale-in"
        style={panelStyle}
      >
        <div
          ref={cardRef}
          className={`absolute inset-0 bg-white rounded-2xl px-6 py-7 shadow-[0_16px_48px_rgba(0,0,0,0.10)] overscroll-contain ${
            // While the box is resizing the card clips rather than scrolls:
            // a scrollbar flashing in for a few hundred milliseconds would be
            // more distracting than the couple of pixels the taller form is
            // briefly outside the box for — and those pixels are at very low
            // opacity, mid-fade, when it happens.
            swapping ? 'overflow-hidden auth-swap-in' : 'overflow-y-auto'
          }`}
        >
        {/* Measured, never styled: an unstyled block is always exactly as tall
            as what it contains, which is what lets the panel read a real
            content height without the animation feeding back into it. */}
        <div ref={probeRef}>
        <button onClick={onClose} className="absolute top-4 right-4 text-grey hover:text-bone transition-colors" aria-label="Close">
          <X size={20} strokeWidth={1.8} />
        </button>

        <div className="flex justify-center">
          <span className="font-brand text-2xl tracking-[0.03em] text-bone">DSLANG</span>
        </div>
        <h2 id="login-title" className="sr-only">Log in or create account</h2>

        {view === 'form' ? (
          <>
            <SignInUpTabs tab={tab} onTab={switchTab} />

            <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
                {/* Full Name is the one field Sign Up has that Log In does not,
                    and it is a profile value, never an auth credential: it is
                    handed to signUp as metadata and Supabase stores it on the
                    user's record. `autoComplete="name"` lets a returning
                    customer have it filled by their own browser.

                    Deliberately NOT autofocused — the email input below keeps
                    autoFocus, so switching tabs never leaves two fields fighting
                    over focus on a phone. */}
                {tab === 'signup' && (
                  <label className="block">
                    <span className={fieldLabel}>Full Name</span>
                    <div className={fieldBox}>
                      <input
                        type="text"
                        value={fullName}
                        onChange={(e) => { setFullName(e.target.value); setError(''); }}
                        placeholder="Your full name"
                        autoComplete="name"
                        className={fieldInput}
                      />
                    </div>
                  </label>
                )}

                <label className="block">
                  <span className={fieldLabel}>Email address</span>
                  <div className={fieldBox}>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); setError(''); }}
                      placeholder="you@example.com"
                      autoComplete="email"
                      autoFocus
                      className={fieldInput}
                    />
                  </div>
                </label>

                <label className="block">
                  <span className={fieldLabel}>Password</span>
                  <div className={fieldBox}>
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      minLength={6}
                      onChange={(e) => { setPassword(e.target.value); setError(''); }}
                      placeholder="Enter your password"
                      autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                      className={fieldInput}
                    />
                    <button type="button" onClick={() => setShowPw((v) => !v)} className={eyeBtn} aria-label={showPw ? 'Hide password' : 'Show password'} title={showPw ? 'Hide password' : 'Show password'}>
                      {showPw ? <EyeOff size={16} strokeWidth={1.8} /> : <Eye size={16} strokeWidth={1.8} />}
                    </button>
                  </div>
                </label>

                {/* Remember me / Forgot Password belong to Log In only. There is
                    no Confirm Password field: Supabase hashes and stores the
                    password itself, so the second entry box only ever
                    re-typed the same secret and made the form taller. */}
                {tab === 'login' && (
                  <div className="flex items-center justify-between pt-0.5">
                    <label className="flex cursor-pointer select-none items-center gap-2">
                      <input
                        type="checkbox"
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                        className="h-3.5 w-3.5 accent-bone"
                      />
                      <span className="text-xs text-bone-soft">Remember me</span>
                    </label>
                    <button type="button" onClick={() => { setError(''); setView('forgot'); }} className="text-xs text-bone-soft transition-colors hover:text-bone hover:underline underline-offset-2">
                      Forgot Password?
                    </button>
                  </div>
                )}

                {error && <p role="alert" aria-live="polite" className="text-xs text-crimson leading-relaxed">{error}</p>}

                <button type="submit" disabled={busy || googleBusy} className={primaryBtn}>
                  {busy ? 'Please wait…' : tab === 'login' ? 'Log In' : 'Create Account'}
                </button>
              </form>

              <div className="mt-5 flex items-center gap-3">
                <div className="flex-1 border-t border-dotted border-bone/25" />
                <span className="text-[11px] text-grey">{tab === 'login' ? 'Or log in with' : 'Or sign up with'}</span>
                <div className="flex-1 border-t border-dotted border-bone/25" />
              </div>

              <button
                type="button"
                onClick={handleGoogle}
                disabled={googleBusy || busy}
                className="mt-4 flex w-full items-center justify-center gap-3 rounded-lg border border-line bg-white py-3 text-[17px] font-medium text-bone transition-colors hover:bg-[#fafafa] hover:border-bone/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <GoogleLogo />
                {googleBusy ? 'Opening Google…' : 'Continue with Google'}
              </button>

              {/* The terms notice stays — it is a legal notice, not a form field, and the
                    signup form is about the three values above. The marketing
                    opt-in checkbox is gone: it was the last extra control in the
                    form and it is not part of an account. `marketing_opt_out`
                    is still written as false, so the subscriber tooling keeps
                    reading a consistent signal. */}
              {tab === 'signup' && (
                  <p className="mt-5 text-[11px] text-grey leading-relaxed">
                    By creating an account, you agree to our{' '}
                    <a href={linkHref('/terms-and-conditions')} onClick={onClose} className="underline underline-offset-2 hover:text-bone">Terms of Service</a>
                    {' '}and{' '}
                    <a href={linkHref('/privacy-policy')} onClick={onClose} className="underline underline-offset-2 hover:text-bone">Privacy Policy</a>.
                  </p>
                )}
            </>
        ) : view === 'verifyEmail' ? (
          /* The "not signed in yet, and that is expected" state. It is reached
             three ways — a fresh signup, an address that already had an
             unverified account, and a login attempt against one — and all three
             resolve the same way: click the emailed link. Nothing here decides
             or grants verification; it only asks Supabase to send the same
             confirmation email again and points the customer at the inbox. */
          <div className="mt-6">
            <p className="font-label text-[11px] uppercase tracking-wide-2 text-grey">Verify your email</p>
            <p className="mt-2 text-sm text-bone-soft leading-relaxed">
              We’ve sent a verification link to <span className="text-bone">{accountEmail}</span>
            </p>
            <p className="mt-1 text-sm text-bone-soft leading-relaxed">
              Check your inbox and click the verification link to activate your account.
            </p>

            {verifyNote && <p className="mt-3 text-xs text-bone-soft leading-relaxed">{verifyNote}</p>}

            {/* aria-live so the outcome of a resend is announced, not just seen. */}
            {resendNotice && (
              <p role="status" aria-live="polite" className="mt-3 text-xs text-bone-soft leading-relaxed">{resendNotice}</p>
            )}

            <button type="button" onClick={handleResend} disabled={resendBusy} className={`mt-5 ${primaryBtn}`}>
              {resendBusy ? 'Sending…' : 'Resend verification email'}
            </button>
            <button
              type="button"
              onClick={() => { setView('form'); setTab('login'); setError(''); setResendNotice(''); setVerifyNote(''); }}
              className={ghostBack}
            >
              Back to log in
            </button>
          </div>
        ) : view === 'forgot' ? (
          <form onSubmit={handleForgot} noValidate className="mt-6">
            <p className="font-label text-[11px] uppercase tracking-wide-2 text-grey">Reset your password</p>
            <p className="mt-2 text-sm text-bone-soft leading-relaxed">
              Enter the email address for your account and we'll send you a password-reset link.
            </p>
            <div className="mt-4 space-y-4">
              <label className="block">
                <span className={fieldLabel}>Email address</span>
                <div className={fieldBox}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setError(''); }}
                    autoComplete="email"
                    className={fieldInput}
                  />
                </div>
              </label>
              {error && <p role="alert" aria-live="polite" className="text-xs text-crimson leading-relaxed">{error}</p>}
              <button type="submit" disabled={busy} className={primaryBtn}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <button type="button" onClick={() => { setView('form'); setError(''); }} className={ghostBack}>
                Back to log in
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-6">
            <p className="font-label text-[11px] uppercase tracking-wide-2 text-grey">Password reset</p>
            <p className="mt-2 text-sm text-bone-soft leading-relaxed">
              If an account exists for <span className="text-bone">{accountEmail}</span>, a password-reset link is on its way. Check your inbox
              (and spam), then follow the link to set a new password and sign in.
            </p>
            <button type="button" onClick={() => { setView('form'); setError(''); }} className={ghostBack}>
              Back to log in
            </button>
          </div>
        )}
        </div>
        </div>
      </div>
    </div>
  );
}

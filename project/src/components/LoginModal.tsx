import { useState, type FormEvent, useEffect } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { useAuth, setForgetSession, consumeAuthNotice } from '@/lib/auth';
import { useRouter, linkHref } from '@/lib/router';
import { lockScroll, unlockScroll } from '@/lib/scrollLock';

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
          className={`flex-1 rounded-full py-2.5 text-[13px] transition-colors ${
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
  const { user, loading, isAdmin, isAdminLoading, signIn, signUp, signInWithGoogle, resetPassword } = useAuth();
  const { navigate } = useRouter();
  const [tab, setTab] = useState<'login' | 'signup'>(initialMode === 'signup' ? 'signup' : 'login');
  const [view, setView] = useState<'form' | 'confirmEmail' | 'forgot' | 'resetSent'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [optOut, setOptOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState('');

  // Reset the form each time the modal opens, honoring the requested mode
  // (e.g. "Create Account" from the menu opens straight in signup).
  useEffect(() => {
    if (isOpen) {
      setTab(initialMode === 'signup' ? 'signup' : 'login');
      setView('form');
      setEmail('');
      setPassword('');
      setConfirm('');
      setShowPw(false);
      setShowConfirmPw(false);
      setBusy(false);
      setGoogleBusy(false);
      // A cancelled or failed Google round trip bounces the shopper back to
      // the storefront, so the explanation has to survive until the modal
      // (re)opens — otherwise a denied consent screen looks like nothing
      // happened.
      setError(consumeAuthNotice() ?? '');
    }
  }, [isOpen, initialMode]);

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

  const switchTab = (t: 'login' | 'signup') => {
    setTab(t);
    setError('');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || googleBusy) return;
    setError('');

    const cleanEmail = email.trim();
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
      if (password.length < 6) {
        setError('Password must be at least 6 characters.');
        return;
      }
      if (confirm !== password) {
        setError('Passwords do not match.');
        return;
      }
    }

    setBusy(true);
    try {
      if (tab === 'signup') {
        const { error: signUpError, session, user: signedUp } = await signUp(cleanEmail.toLowerCase(), password, optOut);
        if (signUpError) {
          if (/already registered|user_already_exists|email already/i.test(signUpError.message)) {
            setError('An account already exists with this email. Sign in instead.');
            setTab('login');
          } else if (/rate limit|too many|too soon|rate_limit/i.test(signUpError.message)) {
            setError('You\'re creating accounts too quickly. Please wait a few minutes and try again.');
          } else if (/password/i.test(signUpError.message)) {
            setError(signUpError.message);
          } else {
            setError(signUpError.message || 'An account could not be created. Please try again.');
          }
          return;
        }
        if (signedUp && !session) {
          // Email confirmation is enabled: the account was created but the
          // visitor must confirm the link before the first sign-in.
          setView('confirmEmail');
          return;
        }
      } else {
        const { error: signInError } = await signIn(cleanEmail.toLowerCase(), password);
        if (signInError) {
          if (/rate limit|too many|too soon|rate_limit/i.test(signInError.message)) {
            setError('You\'re doing that too quickly. Please wait a few minutes and try again.');
          } else if (/invalid login credentials|invalid_credentials/i.test(signInError.message)) {
            setError('The email or password is incorrect. Please try again.');
          } else if (/email not confirmed|email_not_confirmed|unconfirmed/i.test(signInError.message)) {
            setError('Please verify your email first — we sent you a confirmation link.');
          } else if (/network|failed to fetch/i.test(signInError.message)) {
            setError('Network issue — check your connection and try again.');
          } else {
            setError(signInError.message || 'Sign-in failed. Please try again.');
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
      <div className="relative w-[min(430px,calc(100%-32px))] bg-white rounded-2xl px-6 py-7 max-h-[92dvh] overflow-y-auto overscroll-contain animate-scale-in shadow-[0_16px_48px_rgba(0,0,0,0.10)]">
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

              {tab === 'signup' ? (
                <label className="block">
                  <span className={fieldLabel}>Confirm Password</span>
                  <div className={fieldBox}>
                    <input
                      type={showConfirmPw ? 'text' : 'password'}
                      value={confirm}
                      minLength={6}
                      onChange={(e) => { setConfirm(e.target.value); setError(''); }}
                      placeholder="Re-enter your password"
                      autoComplete="new-password"
                      className={fieldInput}
                    />
                    <button type="button" onClick={() => setShowConfirmPw((v) => !v)} className={eyeBtn} aria-label={showConfirmPw ? 'Hide password' : 'Show password'} title={showConfirmPw ? 'Hide password' : 'Show password'}>
                      {showConfirmPw ? <EyeOff size={16} strokeWidth={1.8} /> : <Eye size={16} strokeWidth={1.8} />}
                    </button>
                  </div>
                </label>
              ) : (
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
              className="mt-4 flex w-full items-center justify-center gap-3 rounded-lg border border-line bg-white py-3 text-sm font-medium text-bone transition-colors hover:bg-[#fafafa] hover:border-bone/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <GoogleLogo />
              {googleBusy ? 'Opening Google…' : 'Continue with Google'}
            </button>

            {tab === 'signup' && (
              <div className="mt-5">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={optOut}
                    onChange={(e) => setOptOut(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-bone"
                  />
                  <span className="text-xs text-grey leading-snug">I don't want to receive emails about drops, offers, and updates.</span>
                </label>
                <p className="mt-3 text-[11px] text-grey leading-relaxed">
                  By creating an account, you agree to our{' '}
                  <a href={linkHref('/terms-and-conditions')} onClick={onClose} className="underline underline-offset-2 hover:text-bone">Terms of Service</a>
                  {' '}and{' '}
                  <a href={linkHref('/privacy-policy')} onClick={onClose} className="underline underline-offset-2 hover:text-bone">Privacy Policy</a>.
                </p>
              </div>
            )}
          </>
        ) : view === 'confirmEmail' ? (
          <div className="mt-6">
            <p className="font-label text-[11px] uppercase tracking-wide-2 text-grey">Check your email</p>
            <p className="mt-2 text-sm text-bone-soft leading-relaxed">
              We've sent a verification link to <span className="text-bone">{email}</span>. You can sign in once you confirm it.
            </p>
            <button type="button" onClick={() => { setView('form'); setError(''); }} className={ghostBack}>
              Go back
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
              If an account exists for <span className="text-bone">{email}</span>, a password-reset link is on its way. Check your inbox
              (and spam), then follow the link to set a new password and sign in.
            </p>
            <button type="button" onClick={() => { setView('form'); setError(''); }} className={ghostBack}>
              Back to log in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
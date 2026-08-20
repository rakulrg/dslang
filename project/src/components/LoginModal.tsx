import { useState, type FormEvent, useEffect, useCallback } from 'react';
import { X, Mail, ArrowRight, Lock } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useRouter } from '@/lib/router';

export function LoginModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { user, loading, isAdmin } = useAuth();
  const { navigate } = useRouter();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [optIn, setOptIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      const destination = isAdmin ? '/admin' : '/account';
      navigate(destination);
      onClose();
    }
  }, [user, loading, isAdmin, navigate, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { opt_in: optIn } },
        });
        if (signUpError) throw signUpError;
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed';
      setError(msg);
      setBusy(false);
    }
  };

  const handleContinue = () => {
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    setShowPassword(true);
    setError('');
  };

  if (user) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center px-5">
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
        <div className="relative w-full max-w-md bg-white border border-line rounded p-8 animate-scale-in">
          <button onClick={onClose} className="absolute top-4 right-4 text-grey hover:text-bone transition-colors" aria-label="Close">
            <X size={22} strokeWidth={1.8} />
          </button>
          <div className="flex items-center gap-3 mb-2">
            <span className="font-brand text-2xl tracking-[0.03em] text-bone">DSLANG<span className="text-crimson">.</span></span>
          </div>
          <h2 className="font-display text-2xl uppercase tracking-wide-2 text-bone mt-4">Welcome back</h2>
          <p className="mt-2 text-sm text-bone-soft">You are signed in as {user.email}.</p>
          <div className="mt-6 space-y-3">
            {isAdmin ? (
              <p className="text-sm text-bone-dim">Redirecting to Admin Dashboard…</p>
            ) : (
              <p className="text-sm text-bone-dim">Redirecting to your profile…</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center px-5">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white border border-line p-6 md:p-8 animate-scale-in max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-grey hover:text-bone transition-colors" aria-label="Close">
          <X size={22} strokeWidth={1.8} />
        </button>

        <div className="flex items-center justify-center mb-4">
          <span className="font-brand text-3xl tracking-[0.03em] text-bone">DSLANG<span className="text-crimson">.</span></span>
        </div>

        <h2 className="font-price text-[28px] md:text-[32px] uppercase tracking-[0.03em] text-bone text-center leading-[1.05]">
          SIGN IN OR CREATE<br />ACCOUNT
        </h2>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block">
            <span className="mb-2 block font-label text-[11px] uppercase tracking-wide-2 text-grey">Email</span>
            <div className="relative">
              <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-grey" strokeWidth={1.6} />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(''); }}
                placeholder="Email"
                className="w-full pl-10 pr-12 py-3.5 bg-white border border-line text-bone text-sm placeholder:text-grey focus:outline-none focus:border-crimson transition-colors"
              />
              {!showPassword && (
                <button
                  type="button"
                  onClick={handleContinue}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full text-bone-dim hover:text-crimson transition-colors"
                  aria-label="Continue"
                >
                  <ArrowRight size={16} strokeWidth={2} />
                </button>
              )}
            </div>
          </label>

          {showPassword && (
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-grey" strokeWidth={1.6} />
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(''); }}
                placeholder="Password (min 6 characters)"
                className="w-full pl-10 pr-4 py-3.5 bg-white border border-line text-bone text-sm placeholder:text-grey focus:outline-none focus:border-crimson transition-colors"
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">{error}</p>
          )}

          {showPassword && (
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold py-4 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50"
            >
              {busy ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          )}
        </form>

        <div className="mt-4 flex items-center gap-3">
          <div className="flex-1 h-px bg-line" />
          <span className="text-[10px] uppercase tracking-wide-2 text-grey">OR</span>
          <div className="flex-1 h-px bg-line" />
        </div>

        <label className="mt-4 flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={optIn}
            onChange={(e) => setOptIn(e.target.checked)}
            className="w-4 h-4 accent-crimson"
          />
          <span className="text-xs text-bone-soft">Email me with news and offers</span>
        </label>

        <p className="mt-5 text-center text-xs text-grey">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setShowPassword(false); }}
            className="text-crimson hover:text-crimson-dark font-medium"
          >
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}

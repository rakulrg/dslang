import { useState, useEffect, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { linkHref } from '@/lib/router';
import { Lock, ArrowLeft, Mail } from 'lucide-react';

export function AdminLoginPage() {
  const { user, loading, isAdmin } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      window.location.hash = isAdmin ? '#/admin' : '#/account';
    }
  }, [user, loading, isAdmin]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      if (data.user) {
        const { count } = await supabase
          .from('admin_users')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', data.user.id);
        if ((count ?? 0) > 0) {
          window.location.hash = '#/admin';
        } else {
          window.location.hash = '#/account';
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper-2 px-5 py-12">
      <div className="w-full max-w-md">
        <a
          href={linkHref('/')}
          className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide-2 text-grey hover:text-bone-dim transition-colors mb-8"
        >
          <ArrowLeft size={14} strokeWidth={2} /> Back to site
        </a>

        <div className="bg-white border border-line p-8 md:p-10 rounded">
          <div className="flex items-center gap-3 mb-2">
            <Lock size={22} className="text-crimson" strokeWidth={1.8} />
            <span className="font-display text-2xl tracking-wide-2 text-bone">
              DSLANG<span className="text-crimson">.</span>
            </span>
          </div>

          <h1 className="font-display text-3xl uppercase tracking-wide-2 text-bone leading-none mt-4">
            Admin Login
          </h1>
          <p className="mt-3 text-sm text-bone-soft">
            Sign in to manage products, prices, images, and drops.
          </p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-5">
            <div>
              <label className="text-[11px] uppercase tracking-wide-2 text-grey block mb-2">
                Email
              </label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-grey" strokeWidth={1.6} />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  placeholder="you@email.com"
                  className="w-full pl-10 pr-4 py-3 bg-white border border-line text-bone text-sm rounded placeholder:text-grey focus:outline-none focus:border-crimson transition-colors"
                />
              </div>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide-2 text-grey block mb-2">
                Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-4 py-3 bg-white border border-line text-bone text-sm rounded placeholder:text-grey focus:outline-none focus:border-crimson transition-colors"
              />
            </div>

            {error && (
              <p className="text-sm text-crimson bg-crimson/5 border border-crimson/20 px-4 py-3 rounded">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-crimson text-white text-[11px] uppercase tracking-wide-2 font-semibold py-4 rounded hover:bg-crimson-dark transition-colors disabled:opacity-50"
            >
              {busy ? 'Please wait…' : 'Sign In'}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-line">
            <a
              href={linkHref('/admin/signup')}
              className="text-[11px] uppercase tracking-wide-2 text-bone-dim hover:text-crimson transition-colors block text-center"
            >
              No admin account? Create one
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

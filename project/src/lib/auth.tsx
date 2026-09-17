import { createContext, useContext, useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import type { Session, User, AuthError } from '@supabase/supabase-js';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signUp: (email: string, password: string, optIn: boolean) => Promise<{ user: User | null; error: AuthError | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
  isAdmin: false,
  signIn: async () => ({ error: null }),
  signUp: async () => ({ user: null, error: null }),
  signOut: async () => {},
});

/**
 * Lazy-load the supabase-js client on first auth interaction instead of at
 * module scope. The 200 kB auth/realtime/storage bundle stays out of the
 * storefront's initial JS graph and only ships when the user opens the
 * login modal or navigates to a protected route.
 */
async function getSupabase() {
  const mod = await import('@/lib/supabase');
  return mod.supabase;
}

/**
 * Whether a supabase-js session was persisted in this browser. The client
 * stores the auth token under a `sb-<ref>-auth-token` localStorage key; when
 * none exists the visitor is anonymous, so the ~200 kB supabase chunk (and the
 * initial getSession call) can be skipped entirely on storefront page loads.
 * The login modal / protected routes load it on demand regardless.
 */
function hasPersistedSession(): boolean {
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && /^sb-[^-]+-auth-token$/.test(key)) {
        const raw = window.localStorage.getItem(key);
        if (raw && raw !== 'null') return true;
      }
    }
  } catch {
    // ignore — storage unavailable, fall through to the slow path
  }
  return false;
}

async function checkIsAdmin(sb: Awaited<ReturnType<typeof getSupabase>>, userId: string): Promise<boolean> {
  const { count, error } = await sb
    .from('admin_users')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) return false;
  return (count ?? 0) > 0;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => ({
    session: null,
    user: null,
    loading: true,
    isAdmin: false,
    signIn: async () => ({ error: null }),
    signUp: async () => ({ user: null, error: null }),
    signOut: async () => {},
  }));

  // Reads the session (and admin flag) straight from supabase-js and pushes it
  // into state. runAfterMutation is called by signIn/signUp/signOut so the SPA
  // reflects the new auth state even though the anonymous fast path never
  // subscribed to onAuthStateChange.
  const applyCurrentSession = useCallback(async (): Promise<void> => {
    const sb = await getSupabase();
    let session: Session | null = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data.session;
    } catch {
      session = null;
    }
    const user = session?.user ?? null;
    let isAdmin = false;
    if (user) isAdmin = await checkIsAdmin(sb, user.id);
    setState((prev) => ({ ...prev, session, user, loading: false, isAdmin }));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const sb = await getSupabase();
    const res = await sb.auth.signInWithPassword({ email, password });
    if (!res.error) await applyCurrentSession();
    return res;
  }, [applyCurrentSession]);

  const signUp = useCallback(async (email: string, password: string, optIn: boolean) => {
    const sb = await getSupabase();
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { opt_in: optIn } },
    });
    if (!error && data?.user) await applyCurrentSession();
    return { user: data?.user ?? null, error };
  }, [applyCurrentSession]);

  const signOut = useCallback(async () => {
    const sb = await getSupabase();
    await sb.auth.signOut();
    await applyCurrentSession();
  }, [applyCurrentSession]);

  const value = useMemo(() => ({ ...state, signIn, signUp, signOut }), [state, signIn, signUp, signOut]);

  useEffect(() => {
    let mounted = true;
    let unsub: (() => void) | undefined;

    (async () => {
      // Fast path for anonymous visitors: no stored session token means the
      // ~200 kB supabase-js chunk never has to load (nor does the initial
      // getSession call run) just to show the storefront's Sign In/Account
      // button. Authenticated flows load supabase-js on demand.
      if (!hasPersistedSession()) {
        if (mounted) setState((prev) => ({ ...prev, loading: false }));
        return;
      }

      const sb = await getSupabase();

      // After a remount (React StrictMode double-invoke in dev), the earlier
      // effect instance already cleaned up — bail out so we never double-
      // subscribe or set stale state.
      if (!mounted) return;

      const apply = async (session: Session | null) => {
        const user = session?.user ?? null;
        let isAdmin = false;
        if (user) isAdmin = await checkIsAdmin(sb, user.id);
        if (mounted) setState((prev) => ({ ...prev, session, user, loading: false, isAdmin }));
      };

      try {
        const { data } = await sb.auth.getSession();
        await apply(data.session);
      } catch {
        if (mounted) setState((prev) => ({ ...prev, session: null, user: null, loading: false, isAdmin: false }));
      }

      const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
        void apply(session);
      });
      unsub = () => sub.subscription.unsubscribe();
    })();

    return () => {
      mounted = false;
      unsub?.();
    };
  }, []);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
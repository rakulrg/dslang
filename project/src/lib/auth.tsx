import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { Session, User, AuthError } from '@supabase/supabase-js';
import {
  parseOAuthCallback,
  describeOAuthError,
  safeAuthDestination,
  sameRoute,
  stripOAuthFromUrl,
} from '@/lib/authOauth';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  /**
   * True only while the admin check for the CURRENT user is still in flight
   * (or has never run for it). UI that reveals admin affordances must hide
   * itself while this is true, so a new identity can never inherit the previous
   * identity's `isAdmin` for even one frame.
   */
  isAdminLoading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signUp: (email: string, password: string, optsOut: boolean) => Promise<{ user: User | null; error: AuthError | null; session: Session | null }>;
  signOut: () => Promise<void>;
  /** Google OAuth — full-page redirect to the provider; returns when the
   *  redirect is issued (errors surface immediately for disabled providers). */
  signInWithGoogle: () => Promise<{ error: AuthError | null }>;
  /** Emails a password-reset link to `email` (email-only accounts). */
  resetPassword: (email: string) => Promise<{ error: AuthError | null }>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
  isAdmin: false,
  isAdminLoading: false,
  signIn: async () => ({ error: null }),
  signUp: async () => ({ user: null, error: null, session: null }),
  signOut: async () => {},
  signInWithGoogle: async () => ({ error: null }),
  resetPassword: async () => ({ error: null }),
});

/**
 * Lazy-load the supabase-js client on first auth interaction instead of at
 * module scope. The 200 kB auth/realtime/storage bundle stays out of the
 * storefront's initial JS graph and only ships when the user opens the
 * login modal, returns from an OAuth round trip, or hits a protected route.
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

/* ---------------------------------------------------------------------------
 * OAuth return handling.
 *
 * A Google round trip is a FULL-PAGE redirect, so the returning document
 * re-boots the SPA with `?code=...` (or `?error=...`) in the query string and
 * the route in the hash. Nothing in the storefront statically imports
 * supabase-js, so the anonymous fast path below used to skip loading the client
 * entirely — which meant `detectSessionInUrl` never ran, the code was never
 * exchanged, and the shopper silently landed back on the same page signed out.
 * The boot effect therefore treats "OAuth params present" as a reason to load
 * supabase-js, exactly like a persisted session.
 *
 * The decisions (what counts as a callback, how an error reads, whether a
 * destination is safe) live in `@/lib/authOauth` so they can be executed by
 * `scripts/auth-oauth.test.mjs`; this file supplies the browser glue.
 * ------------------------------------------------------------------------ */

/** Current OAuth return params, or null when this is not an OAuth return. */
function oauthCallbackParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null;
  return parseOAuthCallback(window.location.search);
}

/**
 * Remove the one-shot OAuth params from the address bar, preserving the hash
 * and any unrelated query params, so a refresh cannot replay the same code.
 */
function stripOAuthParams(): void {
  if (typeof window === 'undefined' || !window.location.search) return;
  try {
    const cleaned = stripOAuthFromUrl(window.location.href);
    if (cleaned) window.history.replaceState(window.history.state, '', cleaned);
  } catch {
    // ignore — a stale param in the URL is cosmetic, not a security problem
  }
}

/* ---------------------------------------------------------------------------
 * Post-login destination.
 *
 * `redirectTo` used to be hard-coded to /#/account, so anyone who started a
 * Google login from the checkout page was dropped on the account page and lost
 * their place. The intended route is now carried in the OAuth return URL, with
 * a sessionStorage copy as a fallback for returns that lose the fragment.
 * ------------------------------------------------------------------------ */
const AUTH_DESTINATION_KEY = 'dslang_auth_destination_v1';

/** The in-app route the user is on right now, if it is worth restoring. */
function currentAuthDestination(): string | null {
  if (typeof window === 'undefined') return null;
  return safeAuthDestination(window.location.hash || '/');
}

/** Remember where to send the shopper once the OAuth round trip completes. */
function rememberAuthDestination(): void {
  const dest = currentAuthDestination();
  if (!dest || dest === '/') return;
  try {
    window.sessionStorage.setItem(AUTH_DESTINATION_KEY, dest);
  } catch {
    // storage unavailable — fall back to the default destination
  }
}

/**
 * Where the shopper was before the OAuth round trip, but ONLY when the return
 * URL actually lost it — some redirect policies and a few providers drop the
 * fragment, which would otherwise strand a returning shopper on the storefront
 * home. Strictly one-shot: the sessionStorage copy is cleared during boot and
 * this module slot is drained by the app, so it can never fire for an
 * unrelated later login.
 */
let authReturnDestination: string | null = null;

/** Read + clear the pending post-OAuth destination. */
export function takeAuthReturnDestination(): string | null {
  const destination = authReturnDestination;
  authReturnDestination = null;
  return destination;
}

/**
 * Run once an OAuth return has been handled: drop the stored pre-OAuth route,
 * and hand it to the app ONLY when the identity that resulted really is the
 * Google login that stored it. Tying the two together matters because the same
 * `?code=` return shape is used for password recovery and email confirmation —
 * without this check, a destination remembered by an abandoned Google attempt
 * would hijack an unrelated recovery link and drop the shopper on, say,
 * /checkout instead of the account page.
 */
function reconcileAuthReturnDestination(session: Session | null): void {
  if (typeof window === 'undefined') return;
  let stored: string | null = null;
  try {
    stored = safeAuthDestination(window.sessionStorage.getItem(AUTH_DESTINATION_KEY));
    window.sessionStorage.removeItem(AUTH_DESTINATION_KEY);
  } catch {
    // storage unavailable — nothing to reconcile
  }
  if (!stored) return;
  const provider = session?.user?.app_metadata?.provider;
  if (provider !== 'google') return;
  if (!sameRoute(stored, currentAuthDestination())) {
    authReturnDestination = stored;
  }
}

/* A one-shot human-readable message (e.g. "Google sign-in was cancelled") that
 * the login modal renders when the OAuth return drops the shopper back on the
 * storefront. Module-scoped because the return happens during boot, long
 * before the modal exists. */
let authNotice: string | null = null;

function setAuthNotice(message: string): void {
  authNotice = message;
}

/** Read + clear the pending OAuth notice. */
export function consumeAuthNotice(): string | null {
  const message = authNotice;
  authNotice = null;
  return message;
}

async function checkIsAdmin(sb: Awaited<ReturnType<typeof getSupabase>>, userId: string): Promise<boolean> {
  const { count, error } = await sb
    .from('admin_users')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) return false;
  return (count ?? 0) > 0;
}

const FORGET_FLAG = 'dslang_remember_me_off_v1';

/**
 * "Remember me" lives in the login modal: when unchecked, this flag is set so
 * the session keeps working for the current tab (the SPA holds it in memory)
 * but is dropped on the next page load — supabase-js persists the token in
 * localStorage, so the provider signs out once during boot when it sees the
 * flag. Checking remember-me again simply leaves the flag unset.
 */
function _shouldForgetSession(): boolean {
  try {
    return window.localStorage.getItem(FORGET_FLAG) === '1';
  } catch {
    return false;
  }
}

function _clearForgetSession(): void {
  try {
    window.localStorage.removeItem(FORGET_FLAG);
  } catch {
    // storage unavailable — nothing to clear
  }
}

/** Called by the login modal when "Remember me" was left unchecked. */
export function setForgetSession(): void {
  try {
    window.localStorage.setItem(FORGET_FLAG, '1');
  } catch {
    // storage unavailable — the session won't persist anyway
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => ({
    session: null,
    user: null,
    loading: true,
    isAdmin: false,
    isAdminLoading: false,
    signIn: async () => ({ error: null }),
    signUp: async () => ({ user: null, error: null, session: null }),
    signOut: async () => {},
    signInWithGoogle: async () => ({ error: null }),
    resetPassword: async () => ({ error: null }),
  }));

  /**
   * Monotonic token for "the auth resolution currently in flight".
   *
   * `applyRaw` awaits the admin_users check, so two of them can be outstanding
   * at once (a SIGNED_IN check racing a later SIGNED_OUT). Without this token
   * the slower, STALE one could land last and write `isAdmin: true` for a user
   * who has already signed out — which is exactly how a signed-out visitor kept
   * seeing ADMIN PANEL. Every applyRaw captures the token it was started with
   * and refuses to commit if a newer one has since begun.
   */
  const adminCheckToken = useRef(0);

  /**
   * Reads the session (and admin flag) straight from supabase-js and pushes it
   * into state. runAfterMutation is called by signIn/signUp/signOut so the SPA
   * reflects the new auth state even though the anonymous fast path never
   * subscribed to onAuthStateChange. When the "remember me" flag is set the
   * persisted session is dropped on this boot so the visitor starts signed out.
   */
  const applyRaw = useCallback(async (sb: Awaited<ReturnType<typeof getSupabase>>, session: Session | null): Promise<void> => {
    const token = ++adminCheckToken.current;

    let resolved = session;
    if (resolved && _shouldForgetSession()) {
      _clearForgetSession();
      resolved = null;
      // Deferred deliberately. applyRaw is also reached from the
      // onAuthStateChange callback below, and calling another auth method
      // from inside that callback can deadlock the supabase client. The
      // visitor is already treated as signed out here, so this is cleanup
      // rather than something we need to wait on.
      setTimeout(() => {
        void sb.auth.signOut().catch(() => {
          // storage/network unavailable — state is already signed out
        });
      }, 0);
    }
    const user = resolved?.user ?? null;

    // Identity changed (including signed out): the previous `isAdmin` belonged
    // to a DIFFERENT person, so clear it synchronously and mark the check as
    // pending. Publishing user=null + isAdmin=false in one commit is what makes
    // the Admin Panel vanish on the same tick as sign-out rather than after a
    // round trip — and guarantees no frame renders a stale admin flag against
    // the new identity.
    setState((prev) => {
      const sameUser = (prev.user?.id ?? null) === (user?.id ?? null);
      return {
        ...prev,
        session: resolved,
        user,
        // Keep a still-valid flag only when the very same user is being
        // re-resolved (e.g. TOKEN_REFRESHED, which must not flicker the UI).
        isAdmin: sameUser ? prev.isAdmin : false,
        isAdminLoading: user !== null,
        loading: false,
      };
    });

    if (!user) {
      // Signed out: no admin check to run and nothing to restore.
      if (token !== adminCheckToken.current) return;
      setState((prev) => (prev.isAdmin || prev.isAdminLoading
        ? { ...prev, isAdmin: false, isAdminLoading: false }
        : prev));
      return;
    }

    const isAdmin = await checkIsAdmin(sb, user.id);

    // A newer applyRaw started while this one awaited — it owns the state now.
    if (token !== adminCheckToken.current) return;

    setState((prev) => {
      // Belt and braces: if the identity moved on mid-flight, never attach this
      // result to it.
      if ((prev.user?.id ?? null) !== user.id) return prev;
      return { ...prev, isAdmin, isAdminLoading: false };
    });
  }, []);

  const applyCurrentSession = useCallback(async (): Promise<void> => {
    const sb = await getSupabase();
    let session: Session | null = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data.session;
    } catch {
      session = null;
    }
    await applyRaw(sb, session);
  }, [applyRaw]);

  /**
   * Every in-app sign-out funnels through here.
   *
   * The local Supabase client clears the session itself, but the context is a
   * SEPARATE copy of that state — anything that signed out by calling
   * `supabase.auth.signOut()` directly (the subscriber dashboard does exactly
   * that) would otherwise leave `user`/`isAdmin` frozen at their last values,
   * and the navigation drawer would keep offering ADMIN PANEL to a signed-out
   * visitor until a hard refresh. Resetting here makes the UI respond on the
   * same tick as the click, and `applyCurrentSession()` afterwards re-syncs
   * against the real session so a failed sign-out cannot strand the UI.
   */
  const signOut = useCallback(async () => {
    // Invalidate any admin check still in flight for the outgoing identity so it
    // cannot commit `isAdmin: true` after this reset.
    adminCheckToken.current += 1;
    setState((prev) => ({
      ...prev,
      session: null,
      user: null,
      isAdmin: false,
      isAdminLoading: false,
      loading: false,
    }));
    const sb = await getSupabase();
    try {
      await sb.auth.signOut();
    } catch {
      // Network/storage failure: the optimistic reset above still leaves the UI
      // signed out, and the re-sync below restores truth if the session survived.
    }
    await applyCurrentSession();
  }, [applyCurrentSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    const sb = await getSupabase();
    const res = await sb.auth.signInWithPassword({ email, password });
    if (!res.error) await applyCurrentSession();
    return res;
  }, [applyCurrentSession]);

  const signUp = useCallback(async (email: string, password: string, optsOut: boolean) => {
    const sb = await getSupabase();
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { marketing_opt_out: optsOut } },
    });
    if (!error && data?.user) await applyCurrentSession();
    // `session` is null when email confirmation is enabled: the account was
    // created but the caller must surface the "check your email" state instead
    // of waiting for a session that won't arrive until the link is clicked.
    return { user: data?.user ?? null, error, session: data?.session ?? null };
  }, [applyCurrentSession]);

  /**
   * Google OAuth. Lazy + non-blocking: the caller decides the UX (a modal can
   * just show "Opening Google…"), the browser then performs a full-page
   * redirect to the provider's authorize screen.
   *
   * `redirectTo` keeps the hash router intact and carries the route the
   * shopper started from, so a login begun on the checkout page comes back to
   * checkout instead of dumping them on /account. The route is sanitized to a
   * same-origin path before it is used, and the return is redeemed during the
   * next boot (see the effect below).
   *
   * If Google is not enabled in the Supabase Auth dashboard we short-circuit
   * here (no navigation) so the modal can show a clean error; otherwise the
   * authorize call surfaces any real problem through its returned error.
   */
  const signInWithGoogle = useCallback(async () => {
    const sb = await getSupabase();
    // Before issuing the full-page redirect, confirm Google is actually
    // enabled in the Supabase Auth dashboard. If it isn't (a brand-new
    // project with the provider unconfigured) the authorize URL would just
    // land on a gotrue error page — so short-circuit with a clean error
    // instead of leaving the modal hanging or bouncing the shopper to
    // a broken page.
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
      });
      if (res.ok) {
        const json = (await res.json()) as { external?: Record<string, boolean> };
        if (json.external?.['google'] !== true) {
          return { error: { message: 'Google sign-in is not enabled on this store yet.' } as unknown as AuthError };
        }
      }
    } catch {
      // settings unreadable (offline?) — fall through; the authorize request
      // itself (or the browser redirect) resolves the state
    }
    // Captured only once the redirect is actually about to happen, so a
    // short-circuited (provider-disabled) attempt leaves no stale destination.
    rememberAuthDestination();
    // The route the shopper started from is remembered in sessionStorage by
    // rememberAuthDestination() above, so redirectTo does NOT need to carry it.
    // Sending a bare origin is deliberate: it keeps the callback URL identical
    // for every entry point, which is what Supabase's redirect allowlist has to
    // match, and it leaves the fragment free to keep being the route. The
    // destination is restored by App.tsx from takeAuthReturnDestination().
    const redirectTo = `${window.location.origin}/`;
    const res = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    return { error: res.error ?? null };
  }, []);

  /** Email a password-reset link (works for confirmation-enabled projects). */
  const resetPassword = useCallback(async (email: string) => {
    const sb = await getSupabase();
    const res = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/#/account`,
    });
    return { error: res.error ?? null };
  }, []);

  const value = useMemo(
    () => ({ ...state, signIn, signUp, signOut, signInWithGoogle, resetPassword }),
    [state, signIn, signUp, signOut, signInWithGoogle, resetPassword]
  );

  useEffect(() => {
    let mounted = true;
    let unsub: (() => void) | undefined;

    (async () => {
      // A Google round trip returns to a FRESH document carrying `?code=` /
      // `?error=` in the query string, and by definition has no persisted
      // session yet. Both cases must load supabase-js: importing the client is
      // what runs `detectSessionInUrl` and turns the code into a session. A
      // persisted session is the third reason. Anything else is a plain
      // anonymous storefront visit and takes the fast path.
      const callback = oauthCallbackParams();
      if (!callback && !hasPersistedSession()) {
        if (mounted) setState((prev) => ({ ...prev, loading: false }));
        // No session, so there is nothing to observe *yet* — but a visitor can
        // sign in through the login modal, and from that moment a sign-out
        // performed anywhere (including directly on the supabase client, as the
        // subscriber dashboard does) must be reflected here. Subscribing now is
        // what makes the context track the real session instead of freezing at
        // whatever signIn() last pushed into it. This only costs the already
        // imported client, never an extra network call.
        const sb = await getSupabase();
        if (!mounted) return;
        const { data: anonSub } = sb.auth.onAuthStateChange((_event, nextSession) => {
          void applyRaw(sb, nextSession);
        });
        unsub = () => anonSub.subscription.unsubscribe();
        return;
      }

      const sb = await getSupabase();

      // After a remount (React StrictMode double-invoke in dev), the earlier
      // effect instance already cleaned up — bail out so we never double-
      // subscribe or set stale state.
      if (!mounted) return;

      const apply = async (session: Session | null) => {
        if (!mounted) return;
        await applyRaw(sb, session);
      };

      try {
        const { data } = await sb.auth.getSession();
        let session: Session | null = data.session;

        // getSession() is initialisation-guarded, so a `detectSessionInUrl`
        // exchange normally lands in the result above. If we are on an OAuth
        // return and still have no session, the implicit exchange did not run
        // (or the code was already spent) — it is still in the URL, so it is
        // ours to redeem rather than a replay.
        if (!session && callback?.has('code')) {
          const code = callback.get('code');
          if (code) {
            const { data: exchanged, error } = await sb.auth.exchangeCodeForSession(code);
            if (exchanged?.session) {
              session = exchanged.session;
            } else if (error) {
              setAuthNotice(describeOAuthError(callback));
            }
          }
        } else if (!session && callback?.has('error')) {
          setAuthNotice(describeOAuthError(callback));
        }

        await apply(session);
        if (callback) reconcileAuthReturnDestination(session);
      } catch {
        if (mounted) setState((prev) => ({ ...prev, session: null, user: null, loading: false, isAdmin: false, isAdminLoading: false }));
        if (callback) reconcileAuthReturnDestination(null);
      } finally {
        // Only safe once the code has been redeemed; keeps a refresh from
        // replaying it. Never let a failure here strand `loading: true`.
        stripOAuthParams();
      }

      if (!mounted) return;

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

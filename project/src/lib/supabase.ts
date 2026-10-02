import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error('Missing Supabase env vars. VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set.');
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // PKCE, not the auth-js default of 'implicit'.
    //
    // In the implicit flow GoTrue hands the session back in the URL FRAGMENT
    // (`#access_token=...&refresh_token=...`). This app routes on the fragment
    // — `router.ts#parseHash()` treats the whole hash as a route path — so a
    // token fragment was parsed as a route and the app rendered its own 404
    // page after a successful Google login. PKCE returns a one-time `?code=`
    // in the query string instead, which leaves the fragment free to keep being
    // the route, so the return lands on the page the shopper started from.
    //
    // The provider, redirect URL, allowlist and admin_users check are all
    // unchanged: this only changes how the code is carried back.
    flowType: 'pkce',
  },
});

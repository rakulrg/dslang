import { useEffect, useState, useCallback } from 'react';

// Never let the browser restore the previous scroll position automatically on
// refresh, back, or forward. All scrolling is controlled by the app (scroll to
// top on navigation, scroll to field/error on validation).
if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

export interface Route {
  path: string;
  segments: string[];
}

/**
 * Params GoTrue can leave in a URL fragment. An OAuth return in the implicit
 * flow used to land here and be parsed as a route path, which rendered the
 * site's own 404 page after a successful Google login. The auth flow is now
 * PKCE (code in the query string), so this should never appear — but a hash
 * carrying any of these is an auth artefact, never a DSLANG route, and must not
 * be routed as one.
 */
const AUTH_URL_MARKERS = ['access_token', 'refresh_token', 'expires_in', 'token_type', 'error_description', 'error_uri'];

function isAuthArtefact(hash: string): boolean {
  if (!hash || hash[0] !== '#') return false;
  const body = hash.slice(1);
  if (AUTH_URL_MARKERS.some((k) => body.includes(k))) return true;
  // A fragment that looks like query params rather than a route (`#/a=1`).
  return /^[^/]*[?&][^/]*=/.test(body);
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const clean = raw.split('?')[0];
  const path = clean.startsWith('/') ? clean : `/${clean}`;
  const segments = path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  return { path, segments };
}

export function useRouter() {
  const [route, setRoute] = useState<Route>(() => {
    // Treat an auth-carrying fragment as "no route": the auth layer is about to
    // redeem the code and take over navigation, so booting the storefront on a
    // bogus path (and 404-ing) is the worst available outcome.
    if (isAuthArtefact(window.location.hash)) return { path: '/', segments: [] };
    return parseHash();
  });

  useEffect(() => {
    // Hard refresh: always start at the top, never at a restored position.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });

    const onChange = () => {
      if (isAuthArtefact(window.location.hash)) {
        setRoute({ path: '/', segments: [] });
        return;
      }
      setRoute(parseHash());
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((to: string) => {
    const target = to.startsWith('/') ? to : `/${to}`;
    if (window.location.hash === `#${target}`) {
      window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
      return;
    }
    window.location.hash = target;
  }, []);

  return { route, navigate };
}

/**
 * Navigate WITHOUT adding a history entry.
 *
 * Use this for canonicalization redirects (`/collection` -> `/collections`):
 * the old URL is replaced in place, so Back goes to wherever the visitor came
 * from instead of bouncing them back through the legacy URL and re-redirecting
 * forever. Still fires `hashchange`, so `useRouter` updates normally.
 */
export function replaceRoute(to: string): void {
  if (typeof window === 'undefined') return;
  const target = to.startsWith('/') ? to : `/${to}`;
  const next = `#${target}`;
  if (window.location.hash === next) return;
  window.location.replace(next);
}

export function linkHref(to: string): string {
  const target = to.startsWith('/') ? to : `/${to}`;
  return `#${target}`;
}

/**
 * Path of the route currently in the address bar, ignoring the query.
 *
 * Same value `useRouter` exposes as `route.path`, but readable from outside
 * React. Needed by `hashchange` handlers that run before React has re-rendered:
 * after navigating away, the outgoing page's listener still fires, and without
 * this guard it could write its own state into the URL the visitor just asked
 * for.
 */
export function currentPath(): string {
  if (typeof window === 'undefined') return '/';
  return parseHash().path;
}

/**
 * Query string of the current hash route, e.g. `#/product/slug?color=black&size=XL`
 * -> `URLSearchParams{ color: 'black', size: 'XL' }`.
 *
 * The router's own `parseHash()` intentionally discards the query (routing is
 * path-based), so pages that want to express state in the URL read it through
 * here instead.
 */
export function readHashQuery(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  const raw = window.location.hash.replace(/^#/, '');
  const qIndex = raw.indexOf('?');
  if (qIndex === -1) return new URLSearchParams();
  try {
    return new URLSearchParams(raw.slice(qIndex + 1));
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Replace the query string of the current hash route WITHOUT navigating.
 *
 * Uses `history.replaceState`, which deliberately does NOT fire `hashchange`,
 * so `useRouter` does not re-render and the page is never torn down and
 * rebuilt — the selected variant updates in place and the Back button is not
 * polluted with one entry per swatch click.
 *
 * A `null`/`undefined`/`''` value removes that key, so callers can pass a full
 * desired set and let this prune the rest.
 */
export function replaceHashQuery(next: Record<string, string | null | undefined>): void {
  if (typeof window === 'undefined') return;
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const qIndex = raw.indexOf('?');
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? '' : raw.slice(qIndex + 1));

  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, value);
  }

  const qs = params.toString();
  window.history.replaceState(null, '', `#${path}${qs ? `?${qs}` : ''}`);
}

/** Remove keys from the current hash route's query, in place, without navigating. */
export function clearHashQuery(...keys: string[]): void {
  const next: Record<string, string | null> = {};
  for (const k of keys) next[k] = null;
  replaceHashQuery(next);
}

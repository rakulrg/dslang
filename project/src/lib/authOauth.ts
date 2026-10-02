/**
 * Pure helpers for the Google OAuth return path.
 *
 * Deliberately dependency-free (no React, no supabase-js) so the security
 * -relevant logic can be executed directly by `scripts/auth-oauth.test.mjs`.
 * `auth.tsx` supplies the browser glue (window/sessionStorage) and imports the
 * decisions from here.
 *
 * Background: a Google round trip is a FULL-PAGE redirect, so the returning
 * document re-boots the SPA with `?code=...` (or `?error=...`) in the query
 * string. Nothing in the storefront statically imports supabase-js, so the
 * provider's own `detectSessionInUrl` only runs if something loads the client
 * on that boot — see `AuthProvider`.
 */

/** Query params Supabase/GoTrue put on the OAuth return URL. */
export const OAUTH_PARAMS = ['code', 'error', 'error_code', 'error_description', 'error_uri'] as const;

/**
 * Parse OAuth return params out of a query string, or return null when this is
 * not an OAuth return. Only the params GoTrue actually uses are recognised, so
 * an ordinary `?utm_source=…` storefront link never looks like a callback.
 */
export function parseOAuthCallback(search: string): URLSearchParams | null {
  if (!search) return null;
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return null;
  const params = new URLSearchParams(query);
  return OAUTH_PARAMS.some((key) => params.has(key)) ? params : null;
}

/**
 * Turn GoTrue's OAuth error params into something worth showing. A cancelled
 * or denied consent screen is not an error the shopper can act on, so it gets a
 * plain sentence rather than a provider error code; a genuine rejection keeps
 * its description.
 */
export function describeOAuthError(params: URLSearchParams): string {
  const code = params.get('error_code') ?? '';
  const error = params.get('error') ?? '';
  if (code === 'user_cancelled' || error === 'access_denied') {
    return 'Google sign-in was cancelled. You can try again whenever you like.';
  }
  const description = params.get('error_description');
  if (description) return description.replace(/\+/g, ' ');
  if (error) return `Google sign-in failed (${error}). Please try again.`;
  return 'Google sign-in could not be completed. Please try again.';
}

/**
 * Reduce a candidate to a safe same-origin path, or null when unusable.
 *
 * The post-login destination is attacker-influenceable (it comes back through
 * a redirect URL), so it is never trusted verbatim: it must be a rooted path
 * on THIS origin. `//evil.com` and `/\evil.com` are protocol-relative and
 * would leave the site, and an absolute URL is not a route at all.
 */
export function safeAuthDestination(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const path = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!path.startsWith('/')) return null;
  if (path.startsWith('//') || path.startsWith('/\\')) return null;
  if (path.includes('://') || path.includes('\\')) return null;
  return path;
}

/** Normalize a path for comparison so a trailing slash is not a difference. */
export function sameRoute(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (path: string) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);
  return norm(a) === norm(b);
}

/**
 * Remove the one-shot OAuth params from a URL, preserving the hash and any
 * unrelated query params. Returns null when there is nothing to clean.
 *
 * Without this, a refresh (or a bookmark, or a shared link) replays the same
 * one-time code or error forever.
 */
export function stripOAuthFromUrl(href: string): string | null {
  const url = new URL(href);
  let changed = false;
  for (const key of OAUTH_PARAMS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? `${url.pathname}${url.search}${url.hash}` : null;
}

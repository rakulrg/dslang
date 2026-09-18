// Shared auth helpers for cron-triggered cleanup/payment edge functions.
//
// The scheduled job (pg_cron → net.http_post) calls the function with
// 'Authorization: Bearer <service_role>' (resolved from Supabase Vault at run
// time). The header may arrive exactly as 'Bearer <token>', or — depending on
// the gateway/runtime hop — as the bare '<token>', and may carry surrounding
// whitespace. These helpers normalize that while keeping the actual credential
// comparison exact and (near) constant-time.

/** Extracts the token from an Authorization header value. Accepts
 *  'Bearer <token>', 'bearer <token>' or a bare '<token>'. Returns null when
 *  the header is empty. The token is trimmed but otherwise compared verbatim,
 *  so a non-matching scheme ("Basic …") or a wrong token simply fails the
 *  later constant-time comparison. */
export function bearerToken(header: string | null | undefined): string | null {
  const t = (header ?? '').trim();
  if (!t) return null;
  const m = /^Bearer\s+(.+)$/i.exec(t);
  const tok = (m ? m[1] : t).trim();
  return tok || null;
}

/** Constant-time-ish comparison via SHA-256 digests: digests are always 32
 *  bytes, so the loop length is fixed regardless of input, and a mismatch
 *  cannot reveal the expected value byte-by-byte. (Standard hash-then-compare
 *  pattern; the secret is never exposed in error output.) */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ad = await crypto.subtle.digest('SHA-256', enc.encode(a));
  const bd = await crypto.subtle.digest('SHA-256', enc.encode(b));
  const A = new Uint8Array(ad);
  const B = new Uint8Array(bd);
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}
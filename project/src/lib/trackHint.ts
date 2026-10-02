const TRACK_HINT_KEY = 'dslang_track_hint_v1';

export interface TrackHint {
  ref: string;
  phone: string;
}

/** One-shot same-session hand-off from the Order Confirmed page to /track-order.
 *
 * The phone number must NEVER ride in a URL (browser history / shareable link).
 * It is stored in sessionStorage only, and removed by the Track Order page the
 * moment it arrives — after that a revisit (or a fresh tab / saved link /
 * direct URL) is indistinguishable from any anonymous visitor and falls back to
 * the manual ref + phone form. */
export function setTrackHint(ref: string, phone: string): void {
  try {
    const r = ref.trim().toUpperCase();
    const p = phone.replace(/\D/g, '').slice(0, 10);
    if (!r || p.length !== 10) return;
    window.sessionStorage.setItem(TRACK_HINT_KEY, JSON.stringify({ ref: r, phone: p, at: Date.now() }));
  } catch {
    // ignore
  }
}

/** Read-only peek: returns the validated hint WITHOUT removing it, so React's
 * StrictMode double-invoke of a state initializer stays idempotent. A corrupt
 * payload is removed and reported as absent. */
export function peekTrackHint(): TrackHint | null {
  try {
    const raw = window.sessionStorage.getItem(TRACK_HINT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as TrackHint;
    const ref = typeof v?.ref === 'string' ? v.ref.trim().toUpperCase() : '';
    const phone = typeof v?.phone === 'string' ? v.phone.replace(/\D/g, '').slice(0, 10) : '';
    if (!ref || phone.length !== 10) {
      window.sessionStorage.removeItem(TRACK_HINT_KEY);
      return null;
    }
    return { ref, phone };
  } catch {
    try {
      window.sessionStorage.removeItem(TRACK_HINT_KEY);
    } catch {
      // ignore
    }
    return null;
  }
}

/** Remove the hint — called exactly once when the Track Order page arrives. */
export function clearTrackHint(): void {
  try {
    window.sessionStorage.removeItem(TRACK_HINT_KEY);
  } catch {
    // ignore
  }
}
const CHECKOUT_HISTORY_KEY = 'dslang_checkout_history_v1';
const HISTORY_LIMIT = 20;

export interface CheckoutHistoryEntry {
  ref: string;
  phone: string;
  at: number;
}

/** Long-term, browser-local record of orders this device successfully checked
 *  out. Used by /track-order to auto-fill + auto-run the (still server-gated)
 *  lookup so a returning customer skips the manual form entirely.
 *
 *  lives in localStorage (survives tab/browser close) — unlike the one-shot
 *  session hint it is deliberately NOT removed after a lookup. It only ever
 *  stores what THIS browser already entered (ref + phone); it never bypasses
 *  the possession check because track_lookup_order still requires the ref AND
 *  the matching 10-digit phone and validates them server-side. A different
 *  device/browser/incognito has no history and falls back to the manual form. */

export function addCheckoutHistory(ref: string, phone: string): void {
  try {
    const r = ref.trim().toUpperCase();
    const p = phone.replace(/\D/g, '').slice(0, 10);
    if (!r || p.length !== 10) return;
    const next = [ { ref: r, phone: p, at: Date.now() } ];
    for (const entry of peekCheckoutHistory()) {
      if (entry.ref === r) continue;
      next.push(entry);
      if (next.length >= HISTORY_LIMIT) break;
    }
    window.localStorage.setItem(CHECKOUT_HISTORY_KEY, JSON.stringify(next));
  } catch {
    // ignore (private mode / quota) — never breaks checkout or tracking
  }
}

/** Newest-first list of this browser's checkout history. Corrupt entries are
 *  dropped; a fully corrupt payload is removed and reported as empty. */
export function peekCheckoutHistory(): CheckoutHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(CHECKOUT_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      window.localStorage.removeItem(CHECKOUT_HISTORY_KEY);
      return [];
    }
    const entries = parsed
      .filter((e): e is CheckoutHistoryEntry => validEntry(e))
      .sort((a, b) => b.at - a.at)
      .slice(0, HISTORY_LIMIT);
    return entries;
  } catch {
    return [];
  }
}

function validEntry(e: unknown): e is CheckoutHistoryEntry {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  return (
    typeof v.ref === 'string' &&
    v.ref.trim().length > 0 &&
    typeof v.phone === 'string' &&
    v.phone.replace(/\D/g, '').length === 10 &&
    typeof v.at === 'number' &&
    Number.isFinite(v.at)
  );
}
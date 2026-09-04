import { supabase } from '@/lib/supabase';

/**
 * Promo code support for the retail bag/checkout flow.
 *
 * Codes are validated server-side (validate_promo_code RPC) so an APPLY is
 * never trusted from the browser. The validated code + its terms are cached in
 * localStorage so the discount survives product → cart → checkout navigation,
 * and the order RPC re-derives the discount from the code server-side.
 */

export type PromoType = 'percent' | 'flat';

export interface Promo {
  code: string;
  label: string;
  discount_type: PromoType;
  discount_value: number;
  min_order_value: number;
  max_discount: number | null;
}

const PROMO_KEY = 'dslang_promo_v1';

export function normalizeCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9_-]/g, '').trim().toUpperCase().slice(0, 32);
}

export async function validatePromo(
  code: string,
  subtotal = 0
): Promise<{ ok: boolean; promo: Promo | null; reason?: string }> {
  const c = normalizeCode(code);
  if (!c) return { ok: false, promo: null, reason: 'Enter a promo code.' };
  try {
    const { data, error } = await supabase.rpc('validate_promo_code', {
      p_code: c,
      p_subtotal: Math.max(0, subtotal),
    });
    if (error) return { ok: false, promo: null, reason: 'Promo codes are unavailable right now.' };
    const res = data as { ok?: boolean; reason?: string; promo?: Promo } | null;
    if (!res || res.ok !== true || !res.promo) {
      return { ok: false, promo: null, reason: res?.reason || 'This code is invalid or expired.' };
    }
    return { ok: true, promo: res.promo };
  } catch {
    return { ok: false, promo: null, reason: 'Could not check this code. Try again.' };
  }
}

export function savePromo(promo: Promo): void {
  try {
    window.localStorage.setItem(PROMO_KEY, JSON.stringify(promo));
  } catch {
    // storage unavailable — discount just won't persist across navigation
  }
}

export function getPromo(): Promo | null {
  try {
    const raw = window.localStorage.getItem(PROMO_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (
      p &&
      typeof p.code === 'string' &&
      (p.discount_type === 'percent' || p.discount_type === 'flat') &&
      Number.isFinite(p.discount_value)
    ) {
      return p as Promo;
    }
    return null;
  } catch {
    return null;
  }
}

export function removePromo(): void {
  try {
    window.localStorage.removeItem(PROMO_KEY);
  } catch {
    // ignore
  }
}

/** Min-order rule (client hint only — the order RPC enforces the real rule). */
export function promoApplies(subtotal: number, promo: Promo | null): boolean {
  if (!promo || subtotal <= 0) return false;
  return subtotal >= (promo.min_order_value || 0);
}

/** Display discount — capped like the server (max_discount), non-negative. */
export function computeDiscount(subtotal: number, promo: Promo | null): number {
  if (!promo || subtotal <= 0) return 0;
  let d: number;
  if (promo.discount_type === 'flat') d = Math.min(promo.discount_value, subtotal);
  else d = Math.min(Math.round((subtotal * promo.discount_value) / 100), subtotal);
  if (promo.max_discount !== null && promo.max_discount !== undefined && promo.max_discount > 0) {
    d = Math.min(d, promo.max_discount);
  }
  return Math.max(0, Math.min(d, subtotal));
}
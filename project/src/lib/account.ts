import type { RetailCustomer } from '@/lib/orders';

/**
 * Account-scoped helpers (saved details + My Orders). These run ONLY while a
 * user is signed in, and talk through supabase-js (the user's own JWT + RLS),
 * never the anon rest client. The supabase-js chunk is lazy-loaded here the
 * same way auth.tsx does, so storefront bundles that only hit guest paths
 * never pull the auth/realtime/storage bundle.
 *
 * EVERY helper degrades gracefully when the accompanying DB migration has not
 * been applied yet (403 / missing column): callers get null/empty results and
 * the guest checkout path stays byte-for-byte unaffected.
 */

async function getSupabase() {
  const mod = await import('@/lib/supabase');
  return mod.supabase;
}

export interface SavedProfile {
  name: string;
  phone: string;
  email?: string;
  address: string;
  apartment?: string;
  city: string;
  state: string;
  pincode: string;
  country?: string;
}

export function customerToProfile(c: RetailCustomer, apartment?: string): SavedProfile {
  return {
    name: c.name,
    phone: c.phone,
    email: c.email ?? undefined,
    address: c.address,
    apartment: apartment || undefined,
    city: c.city,
    state: c.state,
    pincode: c.pincode,
    country: c.country ?? 'India',
  };
}

/** Fetch the signed-in user's saved details (own row only, via RLS). */
export async function loadSavedProfile(userId: string): Promise<SavedProfile | null> {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from('customer_profiles')
      .select('name, phone, email, address, apartment, city, state, pincode, country')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      name: String(data.name ?? ''),
      phone: String(data.phone ?? ''),
      email: typeof data.email === 'string' && data.email ? data.email : undefined,
      address: String(data.address ?? ''),
      apartment: typeof data.apartment === 'string' && data.apartment ? data.apartment : undefined,
      city: String(data.city ?? ''),
      state: String(data.state ?? ''),
      pincode: String(data.pincode ?? ''),
      country: typeof data.country === 'string' && data.country ? data.country : 'India',
    };
  } catch {
    return null;
  }
}

/**
 * Save (upsert) the signed-in user's details. Returns false when the write
 * couldn't land (e.g. migration not applied yet) so callers can decide whether
 * to reflect "saved" state.
 */
export async function saveProfile(userId: string, profile: SavedProfile): Promise<boolean> {
  try {
    const sb = await getSupabase();
    const { error } = await sb.from('customer_profiles').upsert(
      { user_id: userId, ...profile },
      { onConflict: 'user_id' }
    );
    return !error;
  } catch {
    return false;
  }
}

export interface MyOrder {
  id: string;
  ref: string;
  created_at: string;
  total_amount: number;
  amount_due_on_delivery?: number;
  order_status: string;
  payment_status: string;
  total_qty: number;
  is_cod?: boolean;
  // Shipping state, read under the same owner RLS as everything else above.
  // Optional so an order created before the shipping migration still loads.
  shipping_status?: string | null;
  courier_name?: string | null;
  awb_number?: string | null;
  tracking_id?: string | null;
  tracking_url?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  /** true when this order is a matched-but-unlinked guest order. */
  guest: boolean;
  /**
   * true when this row came from `list_retail_guest_candidates`, i.e. it is a
   * PII-free projection of an order the shopper has PROVED but not yet linked.
   *
   * The projection carries no `id`, `customer` or `items`, so the UI must not
   * present a candidate as though the order detail had been read: nothing about
   * the delivery or the basket is known on this row.
   */
  candidate?: boolean;
  /**
   * Set by `decline_retail_guest_order` when the shopper answered "not mine".
   *
   * This is a WRITTEN record, not a UI toggle: a declined order is permanently
   * ineligible for linking, so the confirmation card must not be raised for it
   * again — not on reload, not on another device. Since 20261020000000 it is
   * also no longer returned by the candidate lookup or readable under the owner
   * policy, so it disappears from My Orders entirely; it stays fully trackable
   * on the public Track Order page.
   *
   * Nullable/optional so a frontend deployed ahead of migration 19 still reads.
   */
  claim_declined_at?: string | null;
  items: {
    name: string;
    /** Immutable product code recorded on the order. The key lib/orderImages.ts
     *  resolves this line's picture from the public catalogue — the order row
     *  stores no image URL, by design. */
    code: string;
    color: string;
    size_label: string;
    quantity: number;
    line_total: number;
  }[];
  /** The order's own delivery snapshot. Returned only for rows this account
   *  OWNS, read under `retail_orders_select_owner` (`user_id = auth.uid()`), so
   *  it can never surface another customer's details. A guest candidate carries
   *  none: the candidate RPC withholds the whole object until the order is
   *  linked and readable as an owned row. */
  customer?: { name?: string; phone?: string; email?: string; address?: string; city?: string; state?: string; pincode?: string } | null;
}

/**
 * Orders the signed-in user can see.
 *
 * Two sources, joined here because the database splits them:
 *
 *   1. OWNED orders, read directly. `retail_orders_select_owner` is owned-rows
 *      ONLY (`user_id = auth.uid()`) as of 20261020000000 - an email match
 *      grants nothing, because guest checkout accepts any address and this row
 *      carries the full delivery jsonb.
 *   2. UNCLAIMED guest candidates, read through `list_retail_guest_candidates`,
 *      which needs email AND a 10-digit phone and returns a PII-free
 *      projection (no `id`, no `customer`, no `items`).
 *
 * Both are RLS/RPC-scoped, so no row from another account can appear. Returns []
 * when nothing can be read.
 */
export async function fetchMyOrders(proofPhone?: string): Promise<MyOrder[]> {
  try {
    const sb = await getSupabase();
    // PostgREST resolves the WHOLE select list against its schema cache up front,
    // so naming a column that does not exist yet fails the entire query with
    // PGRST204 rather than returning a partial row. Two column groups arrive
    // after the base list — the shipping columns and, from 20261019000000, the
    // guest-claim `claim_declined_at` — so a frontend deployed a moment ahead of
    // the schema would otherwise show the customer an empty order history. Ask
    // for everything, then step down one group at a time on exactly that error.
    // Each step costs one extra request ONLY in the degraded case; the normal
    // path is still a single query.
    //
    // `claim_declined_at` is a step of its own rather than folded into the
    // shipping fallback because the two are unrelated: losing shipping detail
    // only costs precision, whereas a lost decline would silently resurrect the
    // "is this you?" card for an order the customer already answered "not mine".
    // Degrading the shipping detail is a far better failure than degrading a
    // decision the customer gave.
    const SELECT_BASE =
      'id, ref, created_at, total_amount, amount_due_on_delivery, order_status, payment_status, total_qty, is_cod, user_id, items, customer';
    const SELECT_SHIPPING =
      'shipping_status, courier_name, awb_number, tracking_id, tracking_url, shipped_at, delivered_at';

    // Ordered most-complete first. The first one that does not fail on a
    // missing column wins.
    const selectLists = [
      `${SELECT_BASE}, ${SELECT_SHIPPING}, claim_declined_at`,
      `${SELECT_BASE}, ${SELECT_SHIPPING}`,
      SELECT_BASE,
    ];

    let data: unknown = null;
    let error: { code?: string; message?: string } | null = null;
    for (const cols of selectLists) {
      const res = await sb
        .from('retail_orders')
        .select(cols)
        .order('created_at', { ascending: false })
        .limit(50);
      if (!res.error) {
        data = res.data;
        error = null;
        break;
      }
      const missingColumn =
        res.error.code === 'PGRST204' ||
        res.error.code === '42703' ||
        /column .* does not exist|schema cache/i.test(String(res.error.message ?? ''));
      if (!missingColumn) {
        // A real failure (RLS, network, bad JWT): retrying with fewer columns
        // cannot help, so stop and report it.
        error = res.error;
        break;
      }
      // Missing column: fall through and try the next-narrower list.
      error = res.error;
    }
    if (error || !Array.isArray(data)) return [];

    const owned = (data as Record<string, any>[]).map((row) => ({
      id: String(row.id ?? ''),
      ref: String(row.ref ?? ''),
      created_at: String(row.created_at ?? ''),
      total_amount: Number(row.total_amount ?? 0),
      amount_due_on_delivery: Number(row.amount_due_on_delivery ?? 0),
      order_status: String(row.order_status ?? 'pending'),
      payment_status: String(row.payment_status ?? ''),
      total_qty: Number(row.total_qty ?? 0),
      is_cod: Boolean(row.is_cod),
      shipping_status: row.shipping_status ?? null,
      courier_name: row.courier_name ?? null,
      awb_number: row.awb_number ?? null,
      tracking_id: row.tracking_id ?? null,
      tracking_url: row.tracking_url ?? null,
      shipped_at: row.shipped_at ?? null,
      delivered_at: row.delivered_at ?? null,
      claim_declined_at: row.claim_declined_at ?? null,
        guest: row.user_id == null,
        customer: (row.customer ?? null) as MyOrder['customer'],
        items: Array.isArray(row.items)
          ? row.items.map(
              (it: { name?: unknown; code?: unknown; color?: unknown; size_label?: unknown; quantity?: unknown; line_total?: unknown }) => ({
                name: String(it.name ?? ''),
                // Older rows predate nothing here — `code` has been written on
                // every line since create_retail_order — but coerce anyway so a
                // hand-edited row cannot blank the image lookup.
                code: String(it.code ?? ''),
                color: String(it.color ?? ''),
                size_label: String(it.size_label ?? ''),
                quantity: Number(it.quantity ?? 0),
                line_total: Number(it.line_total ?? 0),
              })
            )
: [],
    }));

    // Unclaimed guest candidates, when the shopper supplied a proof number.
    // Absent on failure - a missing migration or a wrong phone must not take
    // the owned orders down with it.
    const candidates = proofPhone ? await fetchGuestCandidates(sb, proofPhone) : [];

    const merged = [...owned, ...candidates].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
    return merged;
  } catch {
    return [];
  }
}

/**
 * PII-free projection of unclaimed guest orders for the caller's own email.
 *
 * `list_retail_guest_candidates` (20261020000000) enforces email + 10-digit
 * phone server-side and returns only ref, created_at, total_amount, total_qty,
 * is_cod and payment_status. It deliberately withholds `id`, `customer` and
 * `items`, so these rows carry no delivery address, no product detail and no row
 * address that another endpoint could be pointed at.
 *
 * That is why a candidate is a strictly smaller object than an owned order:
 * `id` is synthesised from the ref because the real one is not disclosed, and
 * `customer`/`items` are empty. The UI already treats a missing customer or
 * item list as "nothing more to show", so it renders without special-casing.
 *
 * A declined order is excluded server-side, so it is never offered again.
 */
async function fetchGuestCandidates(
  sb: Awaited<ReturnType<typeof getSupabase>>,
  proofPhone: string,
): Promise<MyOrder[]> {
  const digits = normalisePhone(proofPhone);
  if (!PHONE_RE.test(digits)) return [];
  try {
    const { data, error } = await sb.rpc('list_retail_guest_candidates', { p_phone: digits });
    if (error || !Array.isArray(data)) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      // Not the row id: the projection does not disclose it, and nothing here
      // needs to address the row. `ref` is stable and already unique.
      id: String(row.ref ?? ''),
      ref: String(row.ref ?? ''),
      created_at: String(row.created_at ?? ''),
      total_amount: Number(row.total_amount ?? 0),
      amount_due_on_delivery: 0,
      order_status: 'pending',
      payment_status: String(row.payment_status ?? ''),
      total_qty: Number(row.total_qty ?? 0),
      is_cod: Boolean(row.is_cod),
      shipping_status: null,
      courier_name: null,
      awb_number: null,
      tracking_id: null,
      tracking_url: null,
      shipped_at: null,
      delivered_at: null,
      // Never surfaced for a candidate: the projection omits it, and a
      // declined order is filtered out server-side before it can get here.
      claim_declined_at: null,
      guest: true,
      candidate: true,
      // Withheld by the projection. The Track Order button falls back to
      // asking for the reference's phone, which re-proves possession anyway.
      customer: null,
      items: [],
    }));
  } catch {
    return [];
  }
}

/** 10 Indian mobile digits, the same shape every other possession check uses. */
const PHONE_RE = /^[6-9]\d{9}$/;

/** Reduce anything the customer typed to the 10 digits the RPC compares against. */
function normalisePhone(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '').slice(0, 10);
}

export interface GuestClaimOutcome {
  ok: boolean;
  /** Number of orders the server actually linked/declined. 0 = the proof did not
   *  match that order, or it was already linked or declined by someone else. */
  count: number;
  /** Set when ok is false. Safe to show to the customer verbatim. */
  error: string;
}

/**
 * The two guest-order decisions, asked ONE ORDER AT A TIME.
 *
 * Both go through the pair of SECURITY DEFINER RPCs from 20261019000000, and both
 * require the same two proofs: the order's guest email must equal the caller's
 * JWT email, AND the phone supplied here must equal the phone captured on the
 * order. The row guard re-verifies the phone itself out of the transaction-local
 * `dslang.claim_phone` setting, so neither RPC can be talked into linking an
 * order on an email match alone.
 *
 * `p_ref` is always passed. The RPC still permits `p_ref: null` to mean "every
 * eligible match", but the UI must never use that: a bulk claim would attach
 * every order that happens to share a phone number, which is exactly the
 * guessing this flow exists to prevent. One ref, one decision, one proof.
 *
 * `ok: false` is returned rather than thrown — these are user-facing flows where
 * a wrong phone is an ordinary outcome, not an exception, and the caller needs to
 * say so inline.
 */
async function decideGuestOrder(
  ref: string,
  phone: string,
  fn: 'claim_retail_guest_order' | 'decline_retail_guest_order',
  countKey: 'claimed' | 'declined',
): Promise<GuestClaimOutcome> {
  const digits = normalisePhone(phone);
  if (!PHONE_RE.test(digits)) {
    return {
      ok: false,
      count: 0,
      error: 'Enter the 10-digit phone number used on the order.',
    };
  }
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.rpc(fn, { p_ref: ref, p_phone: digits });
    if (error) {
      // The RPC raises 42501 with a customer-readable message for a bad phone
      // or a non-matching order; surface it instead of a generic failure.
      return { ok: false, count: 0, error: String(error.message || 'That did not work. Please try again.') };
    }
    const n = Number((data as Record<string, unknown> | null)?.[countKey] ?? 0);
    return { ok: true, count: Number.isFinite(n) ? n : 0, error: '' };
  } catch {
    return { ok: false, count: 0, error: 'Could not reach the server. Please try again.' };
  }
}

/**
 * "Yes, this is mine" — link ONE guest order to the signed-in account.
 *
 * Writes only `user_id`, server-side, taken from auth.uid(). Returns count 1
 * when linked; 0 when the phone did not match that order (which the RPC reports
 * as a successful no-op rather than an error, since the customer simply guessed
 * the number wrong).
 */
export async function claimGuestOrder(ref: string, phone: string): Promise<GuestClaimOutcome> {
  return decideGuestOrder(ref, phone, 'claim_retail_guest_order', 'claimed');
}

/**
 * "No, not mine" — record that decision for ONE guest order.
 *
 * Writes only `claim_declined_at`, and the RPC will not record it without the
 * same email + phone proof a claim needs. That proof is the point: an email
 * guess alone must not be able to permanently hide a real customer's order from
 * their own account view. The order itself is untouched and remains trackable.
 */
export async function declineGuestOrder(ref: string, phone: string): Promise<GuestClaimOutcome> {
  return decideGuestOrder(ref, phone, 'decline_retail_guest_order', 'declined');
}

/**
 * Attach a just-placed order to the signed-in user.
 *
 * The phone is REQUIRED. `claim_retail_guest_order` (20261019000000) refuses to
 * link anything on an email match alone, and re-checks the number against the
 * phone captured on the order server-side. We pass the number the shopper just
 * typed at checkout, which is the same number stored on the order, so the post
 * -checkout attach is still a one-call operation — it simply now proves
 * ownership instead of assuming it.
 *
 * Still best-effort and non-blocking: a failure here leaves the order as a
 * guest order, which stays fully trackable with ref + phone and can be linked
 * later from My Orders. It must never block or fail a purchase.
 */
export async function attachOrderToUser(ref: string, phone: string): Promise<void> {
  const digits = String(phone ?? '').replace(/\D/g, '').slice(0, 10);
  if (digits.length !== 10) return;
  try {
    const sb = await getSupabase();
    await sb.rpc('claim_retail_guest_order', { p_ref: ref, p_phone: digits });
  } catch {
    // ignore — guest order remains claimable
  }
}

/** Persisted "don't ask me again" flag for the Order Confirmed save prompt. */
const DISMISS_KEY = 'dslang_detail_save_dismissed_v1';

export function savePromptDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissSavePrompt(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // ignore — persistence is best-effort
  }
}

/** Reset the dismiss flag (used once a shopper saves their details). */
export function clearSavePromptDismissal(): void {
  try {
    window.localStorage.removeItem(DISMISS_KEY);
  } catch {
    // ignore
  }
}
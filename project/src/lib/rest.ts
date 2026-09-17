// Thin anonymous Supabase REST / RPC / Edge-Function client.
//
// The STOREFRONT only ever needs anon-role data: tables guarded by the
// public_read_* RLS policies and SECURITY DEFINER RPCs (validate_promo_code,
// create_retail_order, track_lookup_order). Calling PostgREST directly with the
// publishable anon key keeps the ~200 kB supabase-js client (Auth, Realtime,
// Storage) OFF the storefront's initial bundle — supabase-js remains only for
// sign-in + admin surfaces, loaded on demand.
//
// All requests here are UNAUTHENTICATED on the postgres role "anon" — they can
// only ever see what the RLS policies for anon allow. Never use this module for
// user-scoped data.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const HEADERS: Record<string, string> = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

export class RestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RestError';
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * fetch() with an abort timeout. A stalled network request must never hang the
 * checkout/UI forever — the caller gets a RestError(0, ...) the same way a
 * non-2xx response would, so every existing try/catch path already recovers.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new RestError(0, `Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface GetOptions {
  /** PostgREST `select`. Defaults to `*`. */
  select?: string;
  /** Abort the request after this many ms. */
  timeoutMs?: number;
}

/** GET a table — `params` are raw PostgREST filters/operators, e.g.
 * `{ published: 'eq.true', order: 'sort_order.asc', limit: '1' }`. */
export async function get<Row>(
  path: string,
  params: Record<string, string> = {},
  options: GetOptions = {}
): Promise<Row[]> {
  const qs = new URLSearchParams();
  qs.set('select', options.select ?? '*');
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') qs.set(key, value);
  }

  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}?${qs.toString()}`, {
    headers: HEADERS,
  }, options.timeoutMs);
  if (!res.ok) {
    throw new RestError(res.status, `Supabase GET ${path} failed (${res.status})`);
  }
  return res.json() as Promise<Row[]>;
}

/** POST a SECURITY DEFINER RPC function (anon role, granted via GRANT EXECUTE). */
export async function rpc<Result>(fn: string, body: unknown): Promise<Result> {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new RestError(res.status, `Supabase RPC ${fn} failed (${res.status})`);
  }
  return res.json() as Promise<Result>;
}

/** POST to a Supabase Edge Function with the anon key (gateway accepts the
 *  publishable key as a valid JWT). Used for password-less public functions. */
export async function invokeFunction<Result>(name: string, body: unknown): Promise<Result> {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new RestError(res.status, `Supabase function ${name} failed (${res.status})`);
  }
  return res.json() as Promise<Result>;
}
// Delhivery — configuration / env surface (staging-first, fail-closed).
//
// WHY staging-first: Delhivery has NO public sandbox that returns deliverable
// waybills, but staging-express.delhivery.com lets us validate create-order +
// waybill + tracking CONTRACTS against real (non-deliverable) test data before
// any production parcel can go out. The legacy Shiprocket connector could ONLY
// ever write real shipments; Delhivery gives us a safe rehearsal runway by
// default and we keep it that way.
//
// Go-live gate (never guess):
//   * DELHIVERY_ENV must be exactly 'production' for a real shipment to be
//     created. Anything else (or unset) = staging, and staging waybills are
//     test-only — they will NOT actually be picked up by a courier.
//   * DELHIVERY_API_TOKEN must be trimmed + non-empty. The token lives ONLY in
//     Supabase Edge Function secrets (hash-protected in the dashboard, never in
//     the repo, never in the browser, never in any log/DB column/error string).
//   * DELHIVERY_AUTH_HEADER (default 'authorization') lets us adapt to the URL
//     the account's Client Developer Portal documents if it ever differs from
//     the classic `Authorization: Token <api-key>` convention without a code
//     change. Default matches the documented convention.
//   * DELHIVERY_WEBHOOK_KEY — shared secret the Delhivery push-tracking webhook
//     must present (same model the Shiprocket webhook used). The Delhivery
//     webhook endpoint verifies it in constant time and fails closed.
//
// Delhivery documented base URLs (verified against the official docs):
//   * production create: https://track.delhivery.com
//   * staging create:    https://staging-express.delhivery.com
//   * production track:  https://track.delhivery.com/api/v1/packages/json/
//   * staging track:     https://staging-express.delhivery.com/api/v1/packages/json/

export type DelhiveryEnv = 'staging' | 'production';

export interface DelhiveryConfig {
  baseUrl: string;
  env: DelhiveryEnv;
  token: string;
  authHeader: string;
  webhookKey: string;
  /** Whether a real shipment COULD be attempted (token present + production). */
  productionReady: boolean;
}

const PROD_BASE = 'https://track.delhivery.com';
const STAGE_BASE = 'https://staging-express.delhivery.com';

/** Loads and validates the Delhivery environment surface. Never throws — a
 *  missing/misconfigured secret just makes the provider unavailable so every
 *  caller fails closed (reports "shipping not configured", flags for manual
 *  action) instead of guessing or shipping to the wrong environment. */
export function loadDelhiveryConfig(): DelhiveryConfig {
  const rawEnv = String(Deno.env.get('DELHIVERY_ENV') ?? '').trim().toLowerCase();
  const env: DelhiveryEnv = rawEnv === 'production' ? 'production' : 'staging';
  const token = String(Deno.env.get('DELHIVERY_API_TOKEN') ?? '').trim();
  const authHeader = String(Deno.env.get('DELHIVERY_AUTH_HEADER') ?? '').trim().toLowerCase() || 'authorization';
  const webhookKey = String(Deno.env.get('DELHIVERY_WEBHOOK_KEY') ?? '').trim();
  return {
    baseUrl: env === 'production' ? PROD_BASE : STAGE_BASE,
    env,
    token,
    authHeader,
    webhookKey,
    productionReady: env === 'production' && token.length > 0,
  };
}

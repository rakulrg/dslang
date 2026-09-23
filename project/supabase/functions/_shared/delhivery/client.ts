// Delhivery — configuration / client connection (shared, SINGLE surface).
//
// WHY one file: the legacy Shiprocket connector spread config across auth.ts +
// shiprocketConfigured + headers in several files. We keep the ENTIRE Delhivery
// env surface here so there is exactly one place that knows:
//   * the base URLs (staging vs production),
//   * how the API token is passed (`Token <key>`),
//   * the webhook key (constant-time verified, fail-closed),
//   * the pickup location + client account names (not secrets, but still never
//     read from the browser / DB / args).
// It must never be imported from anywhere except ../delhivery/* (the adapter).
//
// Staging-first (the whole point of this adapter):
//   * Delhivery has NO public sandbox that returns deliverable waybills, but
//     staging-express.delhivery.com validates the create-order / waybill /
//     track CONTRACTS against safe test data. We DEFAULT to staging and NEVER
//     create a real parcel unless DELHIVERY_ENV=production AND a token is
//     configured. Anything else fails closed.
//   * The token is an Edge Function secret (dashboard-managed, displayed only as
//     a hash here). It is never stored in the DB, never returned to the browser,
//     and never printed into logs / errors. The webhook receiver verifies
//     DELHIVERY_WEBHOOK_KEY in constant time and fail-closes.
//
// Base URLs (documented):
//   * production create/track: https://track.delhivery.com
//   * staging create/track:    https://staging-express.delhivery.com

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const DELHIVERY_STAGING_BASE = 'https://staging-express.delhivery.com';
export const DELHIVERY_PRODUCTION_BASE = 'https://track.delhivery.com';

export type DelhiveryEnv = 'staging' | 'production';

export interface DelhiveryConfig {
  baseUrl: string;
  env: DelhiveryEnv;
  token: string;
  webhookKey: string;
  configured: boolean;
  production: boolean;
}

/** Loads the effective config. Never throws; missing/invalid secrets simply
 *  yield an unconfigured, fail-closed surface. */
export function loadDelhiveryConfig(): DelhiveryConfig {
  const rawEnv = String(Deno.env.get('DELHIVERY_ENV') ?? '').trim().toLowerCase();
  const env: DelhiveryEnv = rawEnv === 'production' ? 'production' : 'staging';
  const token = String(Deno.env.get('DELHIVERY_API_TOKEN') ?? '').trim();
  const webhookKey = String(Deno.env.get('DELHIVERY_WEBHOOK_KEY') ?? '').trim();
  return {
    baseUrl: env === 'production' ? DELHIVERY_PRODUCTION_BASE : DELHIVERY_STAGING_BASE,
    env,
    token,
    webhookKey,
    configured: token.length > 0,
    production: env === 'production' && token.length > 0,
  };
}

/** Convenience alias used by adapter callers. */
export function delhiveryConfigured(): DelhiveryConfig {
  return loadDelhiveryConfig();
}

/** The resolved base URL for the current environment. */
export function delhiveryBase(): string {
  return loadDelhiveryConfig().baseUrl;
}

/** The pickup/warehouse name registered with Delhivery (sent as
 *  `pickup_location.name`; not a secret). */
export function delhiveryPickupLocation(): string {
  return String(Deno.env.get('DELHIVERY_PICKUP_LOCATION') ?? '').trim();
}

/** The registered client account name used for waybill/permalink calls (sent as
 *  `?cl=` / `client`; not a secret). */
export function delhiveryClient(): string {
  return String(Deno.env.get('DELHIVERY_CLIENT') ?? '').trim();
}

/** Authorization value, always `Token <key>` (the documented convention). */
export function delhiveryAuthHeader(token: string): string {
  return `Token ${token}`;
}

/** Standard request headers for Delhivery API calls. */
export function delhiveryHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: delhiveryAuthHeader(token),
    'Content-Type': 'application/json',
    ...(extra ?? {}),
  };
}

/** How many waybills to pre-fetch in one bulk call (0 disables pre-fetch —
 *  auto-assign on create instead, which is always safe). */
export function delhiveryWaybillPrefetchCount(): number {
  const n = Number(Deno.env.get('DELHIVERY_WAYBILL_PREFETCH') ?? '0');
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Re-exported for callers that only need the typed client surface. */
export { createClient };
export type { SupabaseClient };

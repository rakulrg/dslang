/**
 * Regression tests for the two P0 correctness fixes.
 *
 * FIX 1 — the Cashfree "late failure clobbers a success" race.
 *   A terminal FAILED / USER_DROPPED event can be delivered by the gateway
 *   AFTER a SUCCESS for the same order. Both `cashfree-status` and
 *   `cashfree-webhook` used to write `{ payment_status: 'failed',
 *   order_status: 'cancelled' }` filtered only by `.eq('id', ...)`, so a
 *   concurrent success was silently reverted: the order stopped being paid
 *   while still holding its stock reservation.
 *   The fix makes the failure branch a CAS (`.neq('payment_status',
 *   'success')`, plus the same independent `.neq(..., 'cod_pending')` guard the
 *   success branch already carried) and makes `cashfree-status` re-read and
 *   report the row's REAL state when it matches zero rows.
 *
 * FIX 2 — the Delhivery production gate.
 *   `processEligibleShipment` gated on `config.configured` (API token merely
 *   non-empty), so DELHIVERY_ENV=staging + a token would create a real staging
 *   waybill and stamp `awb_number` + `order_status = 'shipped'` on it. It now
 *   gates on `config.production`, which `loadDelhiveryConfig` defines as
 *   `env === 'production' && token.length > 0`.
 *
 * Style note: these follow the repo convention of asserting on the Edge
 * Function source (there is no Deno runtime in this environment — the same
 * constraint documented at the top of sql-structure.test.mjs). The Delhivery
 * config surface IS executed for real, via a Deno.env stub, because
 * `loadDelhiveryConfig` is a pure function.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const STATUS_FN = 'supabase/functions/cashfree-status/index.ts';
const WEBHOOK_FN = 'supabase/functions/cashfree-webhook/index.ts';
const SHIPMENT_LIB = 'supabase/functions/_shared/delhivery/shipment.ts';
const DELHIVERY_CLIENT = 'supabase/functions/_shared/delhivery/client.ts';

const statusCode = read(STATUS_FN);
const webhookCode = read(WEBHOOK_FN);
const shipmentCode = read(SHIPMENT_LIB);
const clientCode = read(DELHIVERY_CLIENT);

/** Strip comments, exactly like failed-payment-retry.test.mjs:43 does, so an
 *  assertion can never be satisfied (or broken) by prose in a comment. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const statusImpl = code(statusCode);
const webhookImpl = code(webhookCode);
const shipmentImpl = code(shipmentCode);

/** The failure-branch update, captured so we can assert on its exact filters. */
function failureBranch(src, label) {
  const at = src.indexOf("update({ payment_status: 'failed', order_status: 'cancelled' })");
  assert.notEqual(at, -1, `${label}: the failure-branch update must still exist`);
  // Walk forward to the end of the fluent chain (the `.select(...)`/statement end).
  const tail = src.slice(at, at + 600);
  const end = tail.indexOf(';');
  return tail.slice(0, end + 1);
}

// ===========================================================================
// FIX 1 — the success/failure race
// ===========================================================================

test('FIX 1: both failure branches are a compare-and-set, not a blind write', () => {
  for (const [label, src] of [['cashfree-status', statusImpl], ['cashfree-webhook', webhookImpl]]) {
    const branch = failureBranch(src, label);
    // The regression this closes: an unguarded `.eq('id')` write.
    assert.match(
      branch,
      /\.neq\('payment_status', 'success'\)/,
      `${label}: a late FAILED/USER_DROPPED must never overwrite a paid order`,
    );
    // Same independent COD guard the success branch already carried.
    assert.match(
      branch,
      /\.neq\('payment_status', 'cod_pending'\)/,
      `${label}: a full-COD order must never be settled through the gateway, in either direction`,
    );
    // The guard must be scoped to exactly one order, never a bulk update.
    assert.match(branch, /\.eq\('id', order\.id\)/, `${label}: the CAS must stay scoped to the single order`);
    assert.ok(
      !/\.is\('payment_status'/.test(branch),
      `${label}: guard on a concrete state, not an IS-NULL nullability check`,
    );
  }
});

test('FIX 1: the failure CAS reports how many rows it actually changed', () => {
  // PostgREST reports a zero-row conditional update as an empty array. Both
  // call sites must read that instead of assuming the write landed.
  assert.match(
    statusImpl,
    /const \{ data: failedRows, error: failureError \} = await supabase[\s\S]{0,260}select\('id'\)/,
    'cashfree-status must read the updated-row count',
  );
  assert.match(
    statusImpl,
    /if \(\(failedRows\?\.length \?\? 0\) > 0\)/,
    'cashfree-status must branch on whether the CAS won',
  );
  assert.match(
    webhookImpl,
    /const failureFlip = await supabase[\s\S]{0,260}select\('id'\)/,
    'cashfree-webhook must read the updated-row count',
  );
});

test('FIX 1: a lost race in cashfree-status reports the real state, never "failed"', () => {
  // The customer-facing half of the bug: after losing the CAS the handler must
  // re-read the row and answer `paid` if a concurrent confirmation succeeded —
  // otherwise a paid shopper is shown "Payment Not Completed".
  const lost = statusImpl.slice(statusImpl.indexOf('const racedPayment'));
  assert.notEqual(lost.length, 0, 'cashfree-status must handle the lost-race case explicitly');
  assert.match(lost, /payment_status/, 'the lost-race path must inspect the stored payment_status');
  assert.match(lost, /status: 'paid'/, 'a concurrently-succeeded order must be reported as paid');
  assert.match(
    lost,
    /verified: true, status: 'paid'/,
    'a concurrently-succeeded order must be reported as verified',
  );
  // `cod_pending` must never be reported as a gateway failure either.
  assert.match(lost, /status: 'pending'/, 'a COD row reached here must answer pending, not failed');
});

test('FIX 1: a genuine database error is never mistaken for a lost CAS', () => {
  // A failed UPDATE returns { data: null, error }. Without an explicit check that
  // is indistinguishable from "matched zero rows", and the fall-through would
  // report status:'failed' for a failure that was never recorded.
  assert.match(
    statusImpl,
    /const \{ data: failedRows, error: failureError \} = await supabase/,
    'cashfree-status must capture the error, not just the data',
  );
  const guard = statusImpl.slice(statusImpl.indexOf('const { data: failedRows, error: failureError }'));
  assert.match(
    guard,
    /if \(failureError\) \{[\s\S]{0,200}status: 'pending'[\s\S]{0,80}502/,
    'a DB error must answer 502 + pending, never a failure verdict',
  );
  // The error check must come BEFORE the zero-row branch, or it is dead code.
  assert.ok(
    guard.indexOf('if (failureError)') < guard.indexOf('if ((failedRows?.length ?? 0) > 0)'),
    'the error check must precede the lost-race branch',
  );
});

test('FIX 1: a webhook lost race is a silent no-op that still acknowledges 200', () => {
  // Returning non-2xx would make Cashfree redeliver a stale terminal event
  // forever, so the acknowledgement must stay unconditional.
  assert.ok(
    /return new Response\('{"ok":true}'/.test(webhookImpl),
    'cashfree-webhook must keep acknowledging deliveries with 200',
  );
  assert.match(
    webhookImpl,
    /if \(failureFlip\.error\)/,
    'a genuine database error must still surface as 502',
  );
});

test('FIX 1: the success path, auth, signature and amount validation are untouched', () => {
  // Guards against a fix that regresses the money path while closing the race.
  assert.match(statusImpl, /Math\.abs\(paidAmount - expected\) > 0\.005/, 'amount-tamper guard must survive');
  assert.match(statusImpl, /\.neq\('payment_status', 'cod_pending'\)/, 'COD hard guard must survive');
  assert.match(statusImpl, /\.is\('auto_ship_at', null\)/, 'grace-window idempotency must survive');
  assert.match(statusImpl, /amount_paid_upfront \?\? order\.total_amount/, 'authoritative amount must survive');

  // HMAC signature verification in the webhook.
  assert.match(webhookImpl, /x-webhook-timestamp/i, 'webhook signature header must survive');
  assert.match(webhookImpl, /verifyWebhookSignature|crypto\.subtle\.sign/, 'webhook HMAC verification must survive');
  assert.match(webhookImpl, /Math\.abs\(paidAmount - expected\) <= 0\.005/, 'webhook amount guard must survive');
  assert.match(webhookImpl, /\.eq\('payment_id', String\(orderId\)\)/, 'webhook order lookup must survive');
});

test('FIX 1: neither failure branch restocks or touches inventory', () => {
  // Releasing stock stays the sweep's exclusive job (pinned again by
  // failed-payment-retry.test.mjs and cancelled-payment-return.test.mjs).
  assert.ok(!/restock/i.test(statusImpl), 'cashfree-status must not restock');
  assert.ok(!/restock/i.test(webhookImpl), 'cashfree-webhook must not restock');
});

// ===========================================================================
// FIX 2 — the Delhivery production gate
// ===========================================================================

/** Compile `loadDelhiveryConfig` out of client.ts and run it against a Deno.env stub. */
function compileConfigLoader() {
  const at = clientCode.indexOf('export function loadDelhiveryConfig(');
  assert.notEqual(at, -1, 'loadDelhiveryConfig not found in client.ts');
  let i = clientCode.indexOf('{', at);
  let depth = 0;
  for (; i < clientCode.length; i++) {
    if (clientCode[i] === '{') depth++;
    else if (clientCode[i] === '}' && --depth === 0) break;
  }
  const body = clientCode
    .slice(at, i + 1)
    .replace('export function', 'function')
    .replace('(): DelhiveryConfig {', '() {')
    .replace('const env: DelhiveryEnv =', 'const env =');
  // The function resolves the two base URLs from module scope, so lift those two
  // literals in with it — taken from the real file, not restated here.
  const prodBase = /export const DELHIVERY_PRODUCTION_BASE = '([^']+)'/.exec(clientCode);
  const stageBase = /export const DELHIVERY_STAGING_BASE = '([^']+)'/.exec(clientCode);
  assert.ok(prodBase && stageBase, 'the Delhivery base URL constants must exist');
  const preamble = `const DELHIVERY_PRODUCTION_BASE = ${JSON.stringify(prodBase[1])};\n`
    + `const DELHIVERY_STAGING_BASE = ${JSON.stringify(stageBase[1])};\n`;
  // Resolve the env INSIDE the compiled scope: `Deno` is a `new Function`
  // parameter, so it must be consumed there rather than relied on to survive as
  // a closure across the boundary.
  return (vars) => new Function('Deno', `${preamble}${body}\n; return loadDelhiveryConfig();`)({
    env: { get: (k) => (k in vars ? vars[k] : undefined) },
  });
}

/** The real loadDelhiveryConfig, executed against a stubbed Deno.env. */
const delhiveryEnv = (vars) => compileConfigLoader()(vars);

test('FIX 2: shipment creation requires explicit production readiness', () => {
  assert.match(
    shipmentImpl,
    /if \(!config\.production\)/,
    'processEligibleShipment must gate on config.production, not merely a non-empty token',
  );
  // The regression: a token alone used to be enough.
  assert.ok(
    !/if \(!config\.configured\)/.test(shipmentImpl),
    'the token-only gate must be gone from the shipment path',
  );
  // It must still be a refusal, recorded on the order for the Admin to surface.
  assert.match(shipmentImpl, /recordFailure\(supabase, order\.id, msg, 'delhivery'\)/, 'a refusal must be recorded for manual action');
  assert.match(shipmentImpl, /return failOn\(\{ ok: false, error: msg \}\)/, 'a refusal must not report success');
  // No AWB may be written on the refusal path.
  const gate = shipmentImpl.slice(shipmentImpl.indexOf('if (!config.production)'));
  assert.ok(gate.indexOf('createDelhiveryOrder') > 0, 'the provider call must come after the gate');
});

test('FIX 2: staging and unset environments are refused; only production+token passes', () => {
  const load = delhiveryEnv;

  // Unset DELHIVERY_ENV — must NOT be production-ready.
  assert.equal(load({}).production, false, 'unset DELHIVERY_ENV must not be production-ready');
  assert.equal(load({}).configured, false, 'no token means not configured');

  // Explicit staging with a token: the exact configuration that used to ship.
  const staging = load({ DELHIVERY_ENV: 'staging', DELHIVERY_API_TOKEN: 'token-abc' });
  assert.equal(staging.configured, true, 'a staging token is still "configured"');
  assert.equal(
    staging.production,
    false,
    'a non-empty token with DELHIVERY_ENV=staging must NOT be production-ready',
  );
  assert.equal(staging.baseUrl, 'https://staging-express.delhivery.com', 'staging must resolve to the staging host');

  // Misspelt / ambiguous values fail closed to staging.
  for (const value of ['', 'prod', 'live', 'test', 'staging ', 'PROD']) {
    const cfg = load({ DELHIVERY_ENV: value, DELHIVERY_API_TOKEN: 'token-abc' });
    assert.equal(cfg.production, false, `DELHIVERY_ENV=${JSON.stringify(value)} must not be production-ready`);
  }

  // Case and surrounding whitespace are normalised intentionally
  // (`trim().toLowerCase()`), so these are the same as 'production'.
  for (const value of ['production', 'PRODUCTION', ' Production ']) {
    const cfg = load({ DELHIVERY_ENV: value, DELHIVERY_API_TOKEN: 'token-abc' });
    assert.equal(cfg.production, true, `DELHIVERY_ENV=${JSON.stringify(value)} is production after normalisation`);
    assert.equal(cfg.baseUrl, 'https://track.delhivery.com', 'normalised production must resolve to the production host');
  }

  // Production without a token is still refused.
  assert.equal(
    load({ DELHIVERY_ENV: 'production' }).production,
    false,
    'production without a token must not be production-ready',
  );
  // A whitespace-only token is not a token.
  assert.equal(
    load({ DELHIVERY_ENV: 'production', DELHIVERY_API_TOKEN: '   ' }).production,
    false,
    'a blank token must not be production-ready',
  );

  // The one configuration that legitimately ships.
  const prod = load({ DELHIVERY_ENV: 'production', DELHIVERY_API_TOKEN: 'token-abc' });
  assert.equal(prod.production, true, 'production + token must remain allowed');
  assert.equal(prod.baseUrl, 'https://track.delhivery.com', 'production must resolve to the production host');
});

test('FIX 2: webhook tracking behaviour is unchanged', () => {
  // Tracking is a contract rehearsal and must keep working in staging, so the
  // webhook path must NOT be gated on production readiness.
  const tracking = read('supabase/functions/_shared/delhivery/tracking.ts');
  assert.ok(!/config\.production/.test(tracking), 'the tracking webhook must not gain a production gate');
  assert.ok(
    !/if \(!config\.production\)/.test(read('supabase/functions/delhivery-webhook/index.ts')),
    'delhivery-webhook must not gain a production gate',
  );
});

test('FIX 2: shipment idempotency and duplicate-shipment protection are preserved', () => {
  // The neutral CAS claim that prevents a second AWB — untouched by the gate.
  assert.match(
    shipmentImpl,
    /shiprocket_order_id: CREATING_SENTINEL/,
    'the creating sentinel claim must survive',
  );
  assert.match(
    shipmentImpl,
    /\.is\('shiprocket_order_id', null\)/,
    'the claim must still be a compare-and-set',
  );
  assert.match(
    shipmentImpl,
    /\.is\('awb_number', null\)/,
    'a hand-entered AWB must still win over automation',
  );
  // An existing AWB of any provenance is an idempotent no-op, and that check
  // happens BEFORE the new gate so it keeps reporting alreadyShipped.
  assert.ok(
    shipmentImpl.indexOf('alreadyShipped: true') < shipmentImpl.indexOf('if (!config.production)'),
    'already-shipped detection must stay ahead of the production gate',
  );
  assert.match(shipmentImpl, /export const SHIPPABLE_STATUSES = new Set\(\['pending', 'processing'\]\)/, 'shippable statuses must be unchanged');
});

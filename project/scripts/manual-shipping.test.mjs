/**
 * Manual courier + AWB shipping regression suite.
 *
 * The feature under test: an admin types a courier and the AWB the courier gave
 * them, and a customer afterwards sees that courier, that AWB and the shipping
 * state — and NOTHING they did not actually do.
 *
 * The whole point of this feature is honesty under partial information, so the
 * assertions are weighted accordingly. The dominant failure mode is not "the
 * page crashes"; it is "the page tells a customer their parcel is on its way
 * when it is not", or "a customer can rewrite their own AWB". Both are silent,
 * both are customer-visible, and neither would be caught by a typecheck.
 *
 * There is no live Supabase here, so the database contract is asserted
 * lexically against the migration (the same technique rpc-privileges.test.mjs
 * and sql-structure.test.mjs already use) and the client contract is exercised
 * by importing the real shared module.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  COURIER_OPTIONS,
  NO_AWB_NOTICE,
  SHIPPING_STATUS_FLOW,
  awbOf,
  canTrackShipment,
  courierSlug,
  delhiveryTrackingUrl,
  hasAwb,
  isPostHandoff,
  isShippingStatus,
  shippingStatusLabel,
  shippingStatusMessage,
  shippingStatusOf,
  trackingLinkFor,
} from '../src/lib/shipping.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const MIGRATION = 'supabase/migrations/20261015000000_dslang_manual_courier_shipping.sql';
const MIG = read(MIGRATION);
const MIG_NO_COMMENTS = MIG.replace(/--[^\n]*/g, '');

/** Extracts the body of one create-or-replace function by name. */
function fnBody(name) {
  const d = fnDef(name);
  return d.body.replace(/--[^\n]*/g, '');
}

/** Extracts a whole create-or-replace function: modifiers (security definer,
 *  search_path) live BEFORE the `$$`, the statements live inside it. */
function fnDef(name) {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${name}\\s*\\([\\s\\S]*?\\)\\s*([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$`,
    'i',
  );
  const m = re.exec(MIG);
  assert.ok(m, `${name} not found in the shipping migration`);
  return { modifiers: m[1], body: m[2] };
}

// ===========================================================================
// 1. The customer contract: nothing is claimed before it happened.
// ===========================================================================

test('SHIPPING: an order with no AWB never looks shipped, in any wording', () => {
  // Every way the UI could leak a false claim is enumerated here, because a
  // single surviving path is enough to tell a customer the wrong thing.
  const noAwb = [
    {},
    { shipping_status: 'pending' },
    { order_status: 'pending' },
    { order_status: 'confirmed' },
    { order_status: 'processing' },
  ];
  for (const o of noAwb) {
    assert.equal(hasAwb(o), false, `hasAwb should be false for ${JSON.stringify(o)}`);
    const status = shippingStatusOf(o);
    assert.ok(
      !isPostHandoff(status),
      `${JSON.stringify(o)} derived a post-handoff status (${status}) with no AWB`,
    );
    assert.equal(canTrackShipment(o), false, 'no AWB must mean no track button');
    assert.equal(trackingLinkFor(o), null, 'no AWB must mean no tracking link');
    assert.doesNotMatch(
      shippingStatusMessage(status),
      /has been (?:shipped|handed|dispatched)|is in transit|is out for delivery|has been delivered/i,
      `the customer message for ${JSON.stringify(o)} claims movement already happened`,
    );
  }
});

test('SHIPPING: the pre-AWB customer message promises tracking, not movement', () => {
  // This exact sentence is the requirement: before an AWB, say nothing about
  // the courier and state that tracking is coming.
  assert.match(NO_AWB_NOTICE, /after shipment/i);
  assert.doesNotMatch(NO_AWB_NOTICE, /shipped|handed over|courier has/i);
  // Precise: the forbidden claim is that movement HAS happened. A future
  // statement ("will be handed to the courier shortly") is honest and required.
  const ALREADY_MOVED = /has been (?:shipped|handed|dispatched)|is in transit|is out for delivery|has been delivered/i;
  for (const pre of ['pending', 'packed']) {
    assert.doesNotMatch(
      shippingStatusMessage(pre),
      ALREADY_MOVED,
      `${pre} must not read as if the parcel is already moving`,
    );
  }
  for (const post of ['shipped', 'in_transit', 'out_for_delivery', 'delivered']) {
    assert.doesNotMatch(
      shippingStatusMessage(post),
      /preparing your order/i,
      `${post} must not still read as "preparing"`,
    );
  }
  assert.equal(shippingStatusMessage('pending'), 'Preparing your order');
  assert.match(shippingStatusMessage('packed'), /packed/i);
});

test('SHIPPING: a post-handoff status is only reachable once an AWB exists', () => {
  // The clamp lives in SQL, but the client must agree: an inconsistent row
  // (possible on historical data written before the RPC existed) must not put a
  // customer-facing "in transit" in front of someone with no waybill to check.
  for (const s of ['shipped', 'in_transit', 'out_for_delivery', 'delivered', 'rto']) {
    assert.equal(isPostHandoff(s), true, `${s} should be post-handoff`);
  }
  for (const s of ['pending', 'packed', 'cancelled']) {
    assert.equal(isPostHandoff(s), false, `${s} should not be post-handoff`);
  }
  // The tracked timeline is gated on hasAwb() at the call site, so the status
  // itself is still reported truthfully here — the gate, not a lie, is what
  // protects the customer.
  const inconsistent = { shipping_status: 'in_transit' };
  assert.equal(shippingStatusOf(inconsistent), 'in_transit', 'stored status is reported as-is');
  assert.equal(hasAwb(inconsistent), false, 'but it still has no AWB to show');
  assert.equal(canTrackShipment(inconsistent), false, 'and no track button');
});

test('SHIPPING: the AWB is read from the dedicated column, then the carrier id', () => {
  assert.equal(awbOf({ awb_number: 'ABC123' }), 'ABC123');
  assert.equal(awbOf({ tracking_id: 'TRK-9' }), 'TRK-9');
  // A dedicated AWB wins over a carrier id when both exist.
  assert.equal(awbOf({ awb_number: 'ABC123', tracking_id: 'TRK-9' }), 'ABC123');
  // Whitespace-only is not an AWB; it must not unlock the track button.
  assert.equal(awbOf({ awb_number: '   ' }), '');
  assert.equal(hasAwb({ awb_number: '   ' }), false);
  assert.equal(hasAwb({ tracking_id: '   ' }), false);
  assert.equal(hasAwb(null), false);
  assert.equal(awbOf(undefined), '');
});

test('SHIPPING: historical rows with no shipping_status still render the truth', () => {
  // Orders that predate the column must keep displaying what is actually known
  // rather than collapsing to "pending".
  assert.equal(shippingStatusOf({ awb_number: 'X1', order_status: 'shipped' }), 'shipped');
  assert.equal(shippingStatusOf({ awb_number: 'X1', order_status: 'delivered' }), 'delivered');
  assert.equal(shippingStatusOf({ awb_number: 'X1', order_status: 'rto' }), 'rto');
  assert.equal(shippingStatusOf({ order_status: 'delivered' }), 'delivered');
  assert.equal(shippingStatusOf({ order_status: 'shipped' }), 'shipped');
  assert.equal(shippingStatusOf({ order_status: 'processing' }), 'packed');
  assert.equal(shippingStatusOf({ order_status: 'cancelled' }), 'cancelled');
  assert.equal(shippingStatusOf({ order_status: 'refunded' }), 'cancelled');
  assert.equal(shippingStatusOf({}), 'pending');
  assert.equal(shippingStatusOf(null), 'pending');
  // An unrecognised stored value must not surface as raw jargon to a customer.
  assert.equal(isShippingStatus('teleported'), false);
  assert.equal(shippingStatusOf({ shipping_status: 'teleported', order_status: 'shipped' }), 'shipped');
});

// ===========================================================================
// 2. Tracking links: real destinations only, never an invented URL.
// ===========================================================================

test('SHIPPING: Delhivery resolves to the public tracking page, not the API', () => {
  const url = trackingLinkFor({ courier_name: 'Delhivery', awb_number: '1234567890123' });
  assert.equal(url, 'https://www.delhivery.com/track/package/1234567890123');
  // The authenticated API host must never be handed to a customer or an email.
  assert.doesNotMatch(String(url), /api\.delhivery\.com/i);
  // Case-insensitive courier name, and the slug form, both resolve.
  assert.equal(
    trackingLinkFor({ courier_name: 'delhivery', awb_number: 'A1' }),
    'https://www.delhivery.com/track/package/A1',
  );
  assert.equal(
    trackingLinkFor({ courier_name: 'Delhivery ', awb_number: 'A1' }),
    'https://www.delhivery.com/track/package/A1',
  );
});

test('SHIPPING: no tracking URL is invented for a courier we cannot link', () => {
  // The AWB is still shown as text; only the link is withheld.
  for (const courier of ['DTDC', 'Blue Dart', 'India Post', 'Ecom Express', 'Other', '']) {
    const o = { courier_name: courier, awb_number: 'AWB123' };
    assert.equal(trackingLinkFor(o), null, `${courier} must not get a fabricated URL`);
    assert.equal(canTrackShipment(o), false, `${courier} must not get a track button`);
    assert.equal(awbOf(o), 'AWB123', 'but the AWB is still readable');
  }
});

test('SHIPPING: a stored tracking URL is used only when it is a real http(s) link', () => {
  // This is the stored-XSS boundary: the value is rendered as an href.
  assert.equal(
    trackingLinkFor({ awb_number: 'A1', courier_name: 'DTDC', tracking_url: 'https://dtdc.com/track/A1' }),
    'https://dtdc.com/track/A1',
  );
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'not a url', '']) {
    const o = { awb_number: 'A1', courier_name: 'DTDC', tracking_url: bad };
    const link = trackingLinkFor(o);
    assert.ok(
      link === null || /^https?:\/\//i.test(link),
      `a non-http(s) stored URL leaked into an href: ${bad} -> ${link}`,
    );
  }
  // A stored URL is preferred over a derived one.
  assert.equal(
    trackingLinkFor({ courier_name: 'Delhivery', awb_number: 'A1', tracking_url: 'https://x.test/t' }),
    'https://x.test/t',
  );
  // But a bad stored URL must not block the honest Delhivery fallback.
  assert.equal(
    trackingLinkFor({ courier_name: 'Delhivery', awb_number: 'A1', tracking_url: 'javascript:alert(1)' }),
    'https://www.delhivery.com/track/package/A1',
  );
});

test('SHIPPING: the Delhivery URL is not built from an unvalidated AWB', () => {
  // Path traversal / injection through the AWB is refused outright.
  assert.equal(delhiveryTrackingUrl('../../admin'), null);
  assert.equal(delhiveryTrackingUrl('a/b'), null);
  assert.equal(delhiveryTrackingUrl('A B'), null);
  assert.equal(delhiveryTrackingUrl(''), null);
  assert.equal(delhiveryTrackingUrl('ABC-123'), 'https://www.delhivery.com/track/package/ABC-123');
});

// ===========================================================================
// 3. Vocabulary: every label exists for every state the UI can render.
// ===========================================================================

test('SHIPPING: the whole lifecycle is labelled and customer-readable', () => {
  for (const s of SHIPPING_STATUS_FLOW) {
    const label = shippingStatusLabel(s);
    assert.ok(label && label !== s, `${s} has no human label`);
    assert.ok(
      shippingStatusMessage(s).length > 0,
      `${s} has no customer-facing sentence`,
    );
  }
  // 'Other' is offered so no admin is ever blocked by a short courier list.
  assert.ok(COURIER_OPTIONS.includes('Other'));
  assert.equal(courierSlug('Blue Dart'), 'blue_dart');
  assert.equal(courierSlug('Ecom Express'), null, 'an unknown courier gets no invented slug');
  assert.equal(courierSlug(''), null);
});

// ===========================================================================
// 4. The database contract: invariants the UI cannot be trusted to enforce.
// ===========================================================================

test('SHIPPING: the migration adds only the two genuinely missing columns', () => {
  // The physical shipping fields already existed. Re-adding them would fork the
  // truth, so their absence here is the point.
  assert.match(MIG_NO_COMMENTS, /add column if not exists\s+shipping_status\s+text/i);
  assert.match(MIG_NO_COMMENTS, /add column if not exists\s+delivered_at\s+timestamptz/i);
  for (const existing of [
    'awb_number',
    'tracking_id',
    'tracking_url',
    'courier_name',
    'shipped_at',
    'shipping_provider',
    'ship_source',
  ]) {
    assert.doesNotMatch(
      MIG_NO_COMMENTS,
      new RegExp(`add column[^;]*\\b${existing}\\b`, 'i'),
      `${existing} already exists and must not be re-added`,
    );
  }
  // Nothing is dropped or deleted.
  assert.doesNotMatch(MIG_NO_COMMENTS, /\bdrop\s+column\b/i, 'no column may be dropped');
  assert.doesNotMatch(MIG_NO_COMMENTS, /\bdrop\s+table\b/i, 'no table may be dropped');
  assert.doesNotMatch(MIG_NO_COMMENTS, /\bdelete\s+from\s+public\.retail_orders/i, 'no order may be deleted');
});

test('SHIPPING: the migration never rewrites payment state or history', () => {
  const body = fnBody('admin_set_order_shipping');
  // The payment columns are readable by the row lock, but must never be written.
  for (const col of [
    'payment_status',
    'amount_paid_upfront',
    'amount_due_on_delivery',
    'payment_id',
    'payment_discount',
    'is_cod',
  ]) {
    assert.doesNotMatch(
      body,
      new RegExp(`\\b${col}\\s*=`, 'i'),
      `${col} must never be written by the manual shipping save`,
    );
  }
  // The backfill touches only the new column.
  const backfill = /update\s+public\.retail_orders\s+o\s+set\s+shipping_status/i.exec(MIG_NO_COMMENTS);
  assert.ok(backfill, 'a backfill of the new column is expected');
  assert.doesNotMatch(
    backfill[0],
    /payment_status|amount_|payment_id|is_cod/i,
    'the backfill must not touch payment',
  );
});

test('SHIPPING: the admin save requires an AWB before any post-handoff state', () => {
  const body = fnBody('admin_set_order_shipping');
  // Fail-closed on the same posture as every other admin RPC.
  assert.match(body, /auth\.uid\(\)\s+is\s+null/i, 'must reject anonymous callers');
  assert.match(body, /from\s+public\.admin_users\s+where\s+user_id\s*=\s*auth\.uid\(\)/i, 'must check admin_users');
  assert.match(
    fnDef('admin_set_order_shipping').modifiers,
    /security\s+definer/i,
    'the save must run as the owner so the admin gate is real',
  );
  // The clamp: a post-handoff state with no AWB is demoted, not accepted.
  assert.match(
    body,
    /if\s+v_awb\s+is\s+null[\s\S]{0,200}?v_status\s+in\s*\(\s*'shipped'/i,
    'a post-handoff status with no AWB must be demoted',
  );
  assert.match(body, /v_status\s*:=\s*'packed'/i, 'and demoted to packed');
  assert.match(body, /status_clamped/i, 'and the caller must be told it was demoted');

  // The vocabulary is guarded in SQL, not only by the <select>.
  assert.match(body, /if\s+v_status\s+not\s+in\s*\(/i, 'an unknown status must be rejected');

  // The AWB is sanity-checked, and the link is restricted to http(s) because it
  // is rendered as an href.
  assert.match(body, /v_awb\s+!~\s*'\^\[A-Za-z0-9\]/, 'the AWB shape is validated');
  assert.match(body, /v_url\s+!~\*\s*'\^https\?:\/\//i, 'the tracking URL is restricted to http(s)');

  // An AWB is written to BOTH id columns so no surface can disagree.
  assert.match(body, /'awb_number',\s*v_awb/i);
  assert.match(body, /'tracking_id',\s*v_awb/i);
});

test('SHIPPING: the manual save is recorded as manual and disarms auto-ship', () => {
  const body = fnBody('admin_set_order_shipping');
  assert.match(body, /'ship_source',\s*case\s+when\s+v_awb\s+is\s+null\s+then\s+null\s+else\s+'admin'/i);
  assert.match(body, /'auto_ship_at',\s*null/i, 'auto_ship_at must be cleared');
  // Shipped once, never re-stamped on a later status nudge.
  assert.match(body, /when\s+v_row\.shipped_at\s+is\s+not\s+null\s+then\s+v_row\.shipped_at/i);
  assert.match(body, /when\s+v_row\.delivered_at\s+is\s+not\s+null\s+then\s+v_row\.delivered_at/i);
  // Pre-handoff states must not overwrite the admin's coarse order status.
  assert.match(
    body,
    /if\s+v_status\s+in\s*\(\s*'shipped'\s*,\s*'in_transit'\s*,\s*'out_for_delivery'\s*\)/i,
    'only post-handoff states project onto order_status',
  );
  assert.doesNotMatch(
    body,
    /if\s+v_status\s*=\s*'packed'[\s\S]{0,80}?'order_status'/i,
    "packed must never write order_status",
  );
});

test('SHIPPING: the returned timestamps are the stored ones, not "now"', () => {
  // An order shipped last week must not report a handoff time of the moment the
  // RPC ran, so the return echoes the persisted values.
  const body = fnBody('admin_set_order_shipping');
  const ret = /return\s+jsonb_build_object\(([\s\S]*?)\n\s*\);/.exec(body);
  assert.ok(ret, 'the RPC returns a jsonb object');
  assert.match(ret[1], /'shipped_at',\s*nullif\(v_patch\s*->>\s*'shipped_at',\s*''\)/i);
  assert.match(ret[1], /'delivered_at',\s*nullif\(v_patch\s*->>\s*'delivered_at',\s*''\)/i);
  assert.doesNotMatch(ret[1], /else\s+v_now\s+end/, 'the return must not substitute v_now');
});

// ===========================================================================
// 5. Security: the shipping fields are admin-only at the database level.
// ===========================================================================

test('SHIPPING: no guest may update an order row', () => {
  assert.match(MIG_NO_COMMENTS, /revoke\s+update\s+on\s+(public\.)?retail_orders\s+from\s+anon/i);
});

test('SHIPPING: authenticated gets no column-level write on the shipping fields', () => {
  // The tempting `grant update (awb_number, …) to authenticated` is a real
  // escalation here: retail_orders has an UPDATE policy that lets a signed-in
  // customer claim a guest order by writing user_id, and with a shipping column
  // grant they could then PATCH their own AWB straight past admin_users. The
  // admin UI writes through the SECURITY DEFINER RPC and needs no grant.
  assert.doesNotMatch(
    MIG_NO_COMMENTS,
    /grant\s+update\s*\([^)]*\b(awb_number|courier_name|shipping_status|tracking_url|shipped_at|delivered_at)\b[^)]*\)\s+on\s+(public\.)?retail_orders\s+to\s+authenticated/i,
    'a column-level shipping UPDATE grant to authenticated is an escalation path',
  );
  assert.doesNotMatch(
    MIG_NO_COMMENTS,
    /grant\s+update\s+on\s+(public\.)?retail_orders\s+to\s+authenticated/i,
    'a blanket shipping UPDATE grant to authenticated is an escalation path',
  );
});

test('SHIPPING: a row-level trigger enforces the admin-only rule, not just a grant', () => {
  // A grant is only one of the doors in: the table already carries broad
  // table-level UPDATE from its original migration, so the decision has to be
  // made in the database at the row.
  assert.match(MIG_NO_COMMENTS, /create\s+or\s+replace\s+function\s+public\.retail_orders_guard_shipping_writes/i);
  const body = fnBody('retail_orders_guard_shipping_writes');
  assert.match(
    fnDef('retail_orders_guard_shipping_writes').modifiers,
    /security\s+definer/i,
    'the guard must read admin_users as the owner',
  );
  // The courier automation writes with the service key.
  assert.match(body, /auth\.role\(\)\s*\)?\s*=\s*'service_role'|=\s*'service_role'/i, 'service_role must be allowed');
  // Admins, including via the SECURITY DEFINER RPC (auth.uid() survives it).
  assert.match(body, /from\s+public\.admin_users\s+where\s+user_id\s*=\s*auth\.uid\(\)/i);
  assert.match(body, /raise\s+exception/i, 'anything else must be refused loudly');
  assert.match(body, /42501/, 'with an insufficient-privilege SQLSTATE');

  // A non-shipping update must pass through untouched, or the guest user_id
  // claim and ordinary order-status edits would break.
  assert.match(body, /is\s+not\s+distinct\s+from/i, 'unchanged shipping columns must short-circuit');
  assert.match(body, /return\s+new/i);

  // The trigger must actually be attached to the table.
  assert.match(
    MIG_NO_COMMENTS,
    /create\s+trigger\s+retail_orders_guard_shipping_writes[\s\S]{0,120}?before\s+update\s+on\s+(public\.)?retail_orders/i,
  );
  for (const col of ['awb_number', 'courier_name', 'shipping_status', 'tracking_url', 'shipped_at', 'delivered_at']) {
    assert.match(body, new RegExp(`\\b${col}\\b`), `${col} must be watched by the guard`);
  }
  // auto_ship_at is a scheduler, not customer-facing truth: guarding it would
  // break the payment-confirmation webhook.
  assert.doesNotMatch(body, /auto_ship_at/, 'auto_ship_at must not be in the guarded column set');
});

test('SHIPPING: the guest shipping read is possession-gated, throttled and PII-free', () => {
  const body = fnBody('track_order_shipping');
  // Same posture as the endpoint it parallels.
  assert.match(body, /customer\s*->>\s*'phone'/i, 'must compare the stored phone');
  assert.match(body, /p_phone/i);
  assert.match(body, /v_denied/i, 'bad ref and bad phone must be indistinguishable');
  assert.match(
    body,
    /dslang_track_lookup_register_failure/i,
    'it must share the throttle so the phone cannot be brute-forced through a second door',
  );
  // It returns the shipping projection and nothing else.
  for (const column of ['email', 'address', 'phone', 'name']) {
    assert.doesNotMatch(
      body,
      new RegExp(`'${column}'\\s*,\\s*v_row`, 'i'),
      `the guest shipping projection must not expose ${column}`,
    );
  }
  for (const col of ['shipping_status', 'courier_name', 'awb_number', 'shipped_at', 'delivered_at']) {
    assert.match(body, new RegExp(`'${col}'`), `${col} must be returned`);
  }
  // Both RPCs are revoked from the world before being granted narrowly.
  assert.match(MIG_NO_COMMENTS, /revoke\s+all\s+on\s+function\s+public\.admin_set_order_shipping/i);
  assert.match(MIG_NO_COMMENTS, /revoke\s+all\s+on\s+function\s+public\.track_order_shipping/i);
  // The admin RPC must never be callable by a logged-out visitor.
  assert.match(MIG_NO_COMMENTS, /revoke\s+execute\s+on\s+function\s+public\.admin_set_order_shipping[\s\S]{0,120}?from\s+anon/i);
  // The guest read is granted to anon deliberately, and that is the only such
  // grant in this migration.
  assert.match(MIG_NO_COMMENTS, /grant\s+execute\s+on\s+function\s+public\.track_order_shipping[\s\S]{0,120}?to\s+anon/i);
});

// ===========================================================================
// 6. Manual wins: automation must never overwrite a hand-entered AWB.
// ===========================================================================

test('SHIPPING: auto-ship skips any order that already carries an AWB', () => {
  const auto = read('supabase/functions/auto-ship-orders/index.ts');
  // The BULK sweep is the dangerous one: it picks orders nobody has looked at.
  // (The single-ref path is an explicit admin action on one known order, and the
  // Delhivery claim's compare-and-set is what stops it there.)
  const bulk = /\.select\([^)]*\)[\s\S]{0,600}?\.lte\('auto_ship_at'[\s\S]{0,600}?\.limit\(/g;
  const blocks = [...auto.matchAll(bulk)].map((m) => m[0]);
  assert.equal(blocks.length, 1, `expected exactly one bulk candidate query, found ${blocks.length}`);
  assert.match(
    blocks[0],
    /\.is\('awb_number',\s*null\)/,
    'the bulk candidate query must exclude orders that already have an AWB',
  );
});

test('SHIPPING: the Delhivery claim cannot overwrite a manual AWB', () => {
  const ship = read('supabase/functions/_shared/delhivery/shipment.ts');
  // The compare-and-set is the real barrier: only one writer can win.
  assert.match(
    ship,
    /update\(\{[^}]*CREATING_SENTINEL[\s\S]{0,400}?\.is\('awb_number',\s*null\)/i,
    'the claim CAS must require an empty awb_number',
  );
  // And any AWB at all — manual or Delhivery — short-circuits before a write.
  assert.match(
    ship,
    /if\s*\(String\(order\.awb_number\s*\?\?\s*''\)\s*!==\s*''\)/i,
    'an existing AWB must be detected up front',
  );
  // A manual AWB must not be reported as "another attempt in progress", which
  // would be a confusing and false state on an already-shipped order.
  assert.doesNotMatch(
    ship,
    /shipping_provider\s*===\s*'delhivery'\s*&&\s*recheck\.data\.awb_number/,
    'the already-shipped recheck must accept ANY courier, not just Delhivery',
  );
});

test('SHIPPING: a courier-created AWB also sets shipping_status', () => {
  // Otherwise a Delhivery shipment would keep the new column's `pending`
  // default and a customer holding a real AWB would be told it was still being
  // prepared.
  const ship = read('supabase/functions/_shared/delhivery/shipment.ts');
  assert.match(
    ship,
    /shipping_status:\s*'shipped'/i,
    'a courier shipment must set the shipping lifecycle to shipped',
  );
  // And a real delivered scan must advance it too.
  const track = read('supabase/functions/_shared/delhivery/tracking.ts');
  assert.match(track, /shipping_status\s*=\s*'delivered'/i);
  assert.match(track, /delivered_at\s*=/i);
  assert.match(track, /shipping_status\s*=\s*'rto'/i);
});

test('SHIPPING: shipping columns arriving late cannot break a courier webhook', () => {
  // The webhook/shipment functions may be deployed a moment before the schema
  // migration. A missing column must not discard the scan — or, far worse, the
  // waybill that Delhivery has already issued.
  const track = read('supabase/functions/_shared/delhivery/tracking.ts');
  assert.match(track, /PGRST204|42703/, 'the tracking write must detect a missing column');
  assert.match(
    track,
    /update\(base\)/,
    'and retry with the pre-migration columns only',
  );
  const ship = read('supabase/functions/_shared/delhivery/shipment.ts');
  assert.match(ship, /basePatch/, 'the shipment write must keep a pre-migration field set');
  assert.match(ship, /update\(basePatch\)/, 'and retry with it when the column is missing');
});

// ===========================================================================
// 7. Notifications: never tell a customer a parcel is moving when it is not.
// ===========================================================================

test('SHIPPING: a shipped email is impossible before an AWB exists', () => {
  const emails = read('supabase/functions/_shared/emails.ts');
  const guard = /if\s*\(kind\s*===\s*'shipped'[\s\S]{0,240}?awb_number/.exec(emails);
  assert.ok(guard, 'sendOrderEmail must refuse a shipped email with no AWB');
  // It must not be defeatable by `force`: a human clicking the button in Admin
  // is exactly the path that would otherwise send the false notice.
  const after = emails.slice(guard.index);
  const forceAfter = after.indexOf('force');
  const returnAfter = after.search(/return\s*\{/);
  assert.ok(
    returnAfter !== -1 && (forceAfter === -1 || returnAfter < forceAfter),
    'the AWB guard must come before any force handling',
  );
  // The refusal is a skip, not a crash.
  assert.match(after.slice(0, 400), /skipped:\s*true/);
});

test('SHIPPING: no email invents a courier the order does not have', () => {
  const emails = read('supabase/functions/_shared/emails.ts');
  // The old fallback named Delhivery for every order, which would tell a DTDC
  // customer their parcel was being tracked by Delhivery.
  assert.doesNotMatch(
    emails,
    /courier_name\s*\?\?\s*'Delhivery'/,
    'the shipped email must not default the courier to Delhivery',
  );
  assert.doesNotMatch(
    emails,
    /order\.tracking_url\s*\?\s*`/,
    'a tracking link must be validated before being rendered as an href',
  );
  assert.match(
    emails,
    /const safeLink\s*=\s*\/\^https\?/i,
    'the email link must be checked against http(s) before becoming an href',
  );
});

// ===========================================================================
// 8. The customer surfaces actually gate on an AWB.
// ===========================================================================

test('SHIPPING: the customer pages show the no-AWB state instead of a fake tracker', () => {
  for (const page of ['src/pages/TrackOrderPage.tsx', 'src/pages/MyOrdersPage.tsx']) {
    const src = read(page);
    assert.match(src, /NO_AWB_NOTICE/, `${page} must state that tracking follows shipment`);
    assert.match(src, /hasAwb\(/, `${page} must gate its tracking UI on a real AWB`);
    assert.match(src, /trackingLinkFor\(/, `${page} must derive the link through the shared helper`);
  }
  // The track button only exists behind a real link.
  const track = read('src/pages/TrackOrderPage.tsx');
  assert.match(track, /Track Shipment/);
  assert.match(track, /rel="noopener noreferrer"/, 'external links must not hand over the opener');
});

test('SHIPPING: My Orders keeps reading when the schema is not migrated yet', () => {
  // PostgREST resolves the whole select list up front, so naming a column that
  // does not exist fails the entire query with PGRST204 — the customer would see
  // an empty order history. A fallback is required, not optional.
  const account = read('src/lib/account.ts');
  assert.match(account, /PGRST204|42703/, 'the shipping column read must detect a missing column');
  // Three select lists, assembled from shared column-group constants: the full
  // one, the one without claim_declined_at, and the base one. They are built by
  // interpolation (`${SELECT_BASE}, ...`) rather than three literal .select()
  // calls, so the assertion below checks the GROUPS rather than counting call
  // sites — the fallback chain is a loop over one .select() now.
  for (const group of ['SELECT_BASE', 'SELECT_SHIPPING']) {
    assert.match(account, new RegExp(`const ${group}\\s*=`), `${group} must be defined`);
  }
  assert.match(account, /`\$\{SELECT_BASE\}, \$\{SELECT_SHIPPING\}, claim_declined_at`/, 'the full list is base + shipping + claim_declined_at');
  assert.match(account, /`\$\{SELECT_BASE\}, \$\{SELECT_SHIPPING\}`/, 'a shipping-without-claim fallback must exist');
  // claim_declined_at degrades SEPARATELY from shipping: losing shipping detail
  // only costs precision, whereas losing a decline would resurrect the "is this
  // you?" card for an order the customer already answered.
  const baseDecl = account.slice(account.indexOf('const SELECT_BASE'), account.indexOf('const SELECT_SHIPPING'));
  const shippingDecl = account.slice(account.indexOf('const SELECT_SHIPPING'), account.indexOf('// Ordered most-complete first'));
  assert.doesNotMatch(baseDecl, /claim_declined_at/, 'the base list must not request claim_declined_at');
  assert.doesNotMatch(shippingDecl, /claim_declined_at/, 'claim_declined_at must not be folded into the shipping group');

  // Every level of the chain must carry the same core fields, the same ordering
  // and the same row cap, or My Orders would silently behave differently
  // depending on which migrations happen to be applied.
  const baseCols = account.match(/const SELECT_BASE\s*=\s*'([^']+)'/s)?.[1] ?? '';
  const shipCols = account.match(/const SELECT_SHIPPING\s*=\s*'([^']+)'/s)?.[1] ?? '';
  for (const [name, cols] of [
    ['primary', baseCols],
    ['fallback', `${baseCols}, ${shipCols}`],
  ]) {
    for (const field of ['amount_due_on_delivery', 'order_status', 'payment_status', 'items']) {
      assert.ok(cols.includes(field), `the ${name} select must still read ${field}`);
    }
  }
  // The fallback chain is one .order()/.limit() pair inside a loop over the
  // column lists, so one call site must still mean every level is ordered and
  // capped identically.
  const orders = [...account.matchAll(/\.order\('created_at', \{ ascending: false \}\)/g)];
  assert.equal(orders.length, 1, 'the single query must be newest-first for every fallback level');
  const limits = [...account.matchAll(/\.limit\(50\)/g)];
  assert.equal(limits.length, 1, 'every fallback level must keep the row cap');
  // A non-missing-column error must NOT trigger a narrower retry — that would
  // just replay the same failure three times.
  assert.match(account, /if \(!missingColumn\) \{/, 'a real error must stop the fallback chain');
  assert.match(account, /if \(!res\.error\) \{/, 'a successful level must end the chain');
});

test('SHIPPING: order confirmation claims only what has happened', () => {
  const checkout = read('src/pages/CheckoutPage.tsx');
  assert.match(checkout, /NO_AWB_NOTICE/, 'the confirmation must state that tracking follows shipment');
  assert.match(
    checkout,
    /shippingStatusMessage\('pending'\)/,
    'a freshly placed order is preparing, never shipped',
  );
  // No courier or waybill is implied at confirmation time.
  assert.doesNotMatch(
    /Shipping[\s\S]{0,400}?(Delhivery|DTDC|AWB\s*#?\s*\d)/i.exec(checkout)?.[0] ?? '',
    /Delhivery|AWB/,
    'the confirmation must not name a courier or show an AWB',
  );
});

test('SHIPPING: the admin form can record a courier outside the list', () => {
  const admin = read('src/pages/admin/AdminDashboard.tsx');
  // "Other" must capture a real name; storing the literal word would tell the
  // customer their parcel went with a courier called "Other".
  assert.match(admin, /courier_other/, 'the admin form must capture a custom courier name');
  assert.match(
    admin,
    /form\.courier\s*===\s*'Other'\s*\?\s*form\.courier_other\s*:\s*form\.courier/,
    'the typed name must be what gets saved',
  );
  // The save goes through the gated RPC, not a direct table write.
  assert.match(admin, /adminSetOrderShipping\(/);
  assert.doesNotMatch(
    admin,
    /update\(\{[^}]*awb_number/i,
    'the admin must not write shipping columns directly',
  );
  assert.doesNotMatch(
    admin,
    /update\(\{[^}]*courier_name/i,
    'the admin must not write courier_name directly',
  );
});

test('SHIPPING: the admin wrapper calls the gated RPC with the right shape', () => {
  const adminLib = read('src/lib/admin.ts');
  const m = /adminSetOrderShipping[\s\S]{0,600}?rpc\('admin_set_order_shipping',\s*\{([\s\S]{0,400}?)\}/.exec(adminLib);
  assert.ok(m, 'adminSetOrderShipping must call the admin_set_order_shipping RPC');
  for (const param of ['p_order_id', 'p_courier', 'p_awb', 'p_tracking_url', 'p_shipping_status']) {
    assert.match(m[1], new RegExp(param), `${param} must be passed to the RPC`);
  }
  // Order id, not a user-supplied ref: the RPC resolves the row itself.
  assert.doesNotMatch(m[1], /p_ref/i, 'the RPC identifies the order by id, never by a client ref');
});

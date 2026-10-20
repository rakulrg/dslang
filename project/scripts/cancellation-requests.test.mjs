/**
 * Customer cancellation REQUEST + admin approval — regression suite.
 *
 * The workflow has one non-negotiable property that every other assertion here
 * protects: SUBMITTING A REQUEST CHANGES NOTHING. It writes a single row into
 * `order_cancellation_requests`; the order status, the payment status, the
 * refund state and the reserved stock are all untouched until an administrator
 * explicitly approves. Approval — and only approval — cancels the order and
 * releases stock, exactly once, through the pre-existing, already-idempotent
 * `restock_retail_order_items` guarded by `retail_orders.stock_restored_at`.
 *
 * Style note: these assert on the real source of the migration, the Delhivery
 * shipment library and the two React pages, because each behaviour needs a live
 * Supabase + gateway to execute. This matches the repo convention (see
 * gateway-shipment-guards.test.mjs and rpc-privileges.test.mjs).
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

const MIGRATION = 'supabase/migrations/20261023000000_dslang_order_cancellation_requests.sql';
const SHIPMENT = 'supabase/functions/_shared/delhivery/shipment.ts';
const CF_STATUS = 'supabase/functions/cashfree-status/index.ts';
const CF_WEBHOOK = 'supabase/functions/cashfree-webhook/index.ts';
const ACCOUNT_LIB = 'src/lib/account.ts';
const ADMIN_LIB = 'src/lib/admin.ts';
const MY_ORDERS = 'src/pages/MyOrdersPage.tsx';
const CANCEL_DIALOG = 'src/pages/orderConfirm/CancellationRequestDialog.tsx';
const ADMIN = 'src/pages/admin/AdminDashboard.tsx';

const sql = read(MIGRATION);
const shipment = read(SHIPMENT);
const cfStatus = read(CF_STATUS);
const cfWebhook = read(CF_WEBHOOK);
const accountLib = read(ACCOUNT_LIB);
const adminLib = read(ADMIN_LIB);
const myOrders = read(MY_ORDERS);
const cancelDialog = read(CANCEL_DIALOG);
const admin = read(ADMIN);

/** Strip comments so an assertion can never be satisfied by prose. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    // SQL line comments: a `--` comment could otherwise satisfy (or break) an
    // assertion about a function body, e.g. "payment_status is NOT changed here".
    .replace(/--[^\n]*/g, '');

/** One `create or replace function` body, by name, with comments stripped. */
function fnBody(src, name) {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${name}\\s*\\([\\s\\S]*?\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    'i',
  );
  const m = re.exec(src);
  assert.notEqual(m, null, `expected the definition of ${name}`);
  return code(m[1]);
}

const requestFn = fnBody(sql, 'request_order_cancellation');
const decideFn = fnBody(sql, 'decide_order_cancellation');
const completeFn = fnBody(sql, 'complete_order_cancellation_refund');

/* ================================================================== *
 * 1. Submitting a request changes nothing but the request table
 * ================================================================== */

test('CANCEL 1: the customer RPC writes ONLY into order_cancellation_requests', () => {
  // The only INSERT in the customer path targets the request table.
  assert.match(
    requestFn,
    /insert\s+into\s+public\.order_cancellation_requests\b/i,
    'the request must be recorded as a row',
  );
  // It must never touch the order, the stock or the payment.
  assert.doesNotMatch(
    requestFn,
    /update\s+public\.retail_orders\b/i,
    'submitting a request must not update the order',
  );
  assert.doesNotMatch(
    requestFn,
    /stock_restored_at|restock_retail_order_items|product_sizes/i,
    'submitting a request must not move stock',
  );
  assert.doesNotMatch(
    requestFn,
    /payment_status\s*=/i,
    'submitting a request must not change payment status',
  );
});

test('CANCEL 2: the request row is classified by its OWN status, separate from the order', () => {
  assert.match(
    sql,
    /request_status\s+text\s+not\s+null\s+default\s+'pending'/i,
    'the request carries its own lifecycle, defaulting to pending',
  );
  assert.match(
    sql,
    /check\s*\(\s*request_status\s+in\s*\(\s*'pending',\s*'approved',\s*'rejected',\s*'withdrawn'\s*\)\s*\)/i,
    'the request status domain is fixed and does not include an order status',
  );
  assert.match(
    sql,
    /refund_status\s+text\s+not\s+null\s+default\s+'none'/i,
    'refund state is tracked separately again',
  );
});

/* ================================================================== *
 * 2. Ownership, eligibility and duplicate prevention (server-side)
 * ================================================================== */

test('CANCEL 3: ownership is enforced server-side, by user_id, not by the UI', () => {
  assert.match(
    requestFn,
    /v_order\.user_id\s+is\s+distinct\s+from\s+v_uid/i,
    'a non-owner must be refused',
  );
  assert.match(
    requestFn,
    /'not_owner'/,
    'the refusal must be an explicit, reportable reason',
  );
});

test('CANCEL 4: a shipped or terminal order is refused at request time', () => {
  assert.match(
    requestFn,
    /order_status\s+in\s*\(\s*'shipped',\s*'delivered',\s*'rto',\s*'cancelled',\s*'refunded'\s*\)/i,
    'terminal order statuses must be refused',
  );
  assert.match(
    requestFn,
    /awb_number|shipped_at|shipping_status/i,
    'an existing shipment must be refused',
  );
});

test('CANCEL 5: a second live request for the same order is prevented', () => {
  // Hard guarantee: a partial unique index.
  assert.match(
    sql,
    /create\s+unique\s+index[\s\S]*?on\s+public\.order_cancellation_requests\s*\(order_id\)\s*where\s+request_status\s*=\s*'pending'/i,
    'at most one pending request per order, enforced by the database',
  );
  // Soft, idempotent answer.
  assert.match(
    requestFn,
    /'already_requested'/,
    'a repeat submit reports the existing request rather than erroring',
  );
});

/* ================================================================== *
 * 3. Admin authorization lives INSIDE the function
 * ================================================================== */

test('CANCEL 6: approval/rejection and refund completion are admin-gated in-body', () => {
  for (const [name, body] of [
    ['decide_order_cancellation', decideFn],
    ['complete_order_cancellation_refund', completeFn],
  ]) {
    assert.match(
      body,
      /from\s+public\.admin_users\s+where\s+user_id\s*=\s*v_uid/i,
      `${name} must re-check admin_users itself`,
    );
    assert.match(
      body,
      /raise\s+exception[\s\S]*?errcode\s*=\s*'42501'/i,
      `${name} must raise 42501 for a non-admin`,
    );
  }
  // A customer calling the admin RPC directly is refused regardless of the UI.
  assert.match(
    decideFn,
    /if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+public\.admin_users/i,
    'the gate must run before any decision logic',
  );
});

/* ================================================================== *
 * 4. Approval revalidates, cancels once, and releases stock once
 * ================================================================== */

test('CANCEL 7: approval REVALIDATES the current order state before acting', () => {
  // The shipment recheck reads the freshly-locked order row (v_order), not the
  // state captured when the customer asked.
  assert.match(
    decideFn,
    /select\s+\*\s+into\s+v_order[\s\S]*?from\s+public\.retail_orders[\s\S]*?for\s+update/i,
    'the order must be re-read and locked at decision time',
  );
  assert.match(
    decideFn,
    /'shipment_created'/,
    'a shipment that appeared since the request must refuse the approval',
  );
});

test('CANCEL 8: approval restocks through the EXISTING idempotent function', () => {
  assert.match(
    decideFn,
    /v_restored\s*:=\s*public\.restock_retail_order_items\s*\(\s*v_order\.id\s*\)/i,
    'release must go through restock_retail_order_items',
  );
  // It must not reimplement the release by writing a stock quantity.
  assert.doesNotMatch(
    decideFn,
    /update\s+public\.product_sizes|set\s+stock\s*=/i,
    'stock must never be written directly',
  );
});

test('CANCEL 9: stock_released_at is stamped only when stock was actually restored', () => {
  // A paid order is skipped by the existing restock function (paid stock is not
  // auto-returned), so the request must record a NULL release rather than a lie.
  assert.match(
    decideFn,
    /stock_released_at\s*=\s*case\s+when\s+v_restored\s*>\s*0\s+then\s+now\(\)\s+else\s+null\s+end/i,
    'the release stamp must reflect what the restock function reported',
  );
});

test('CANCEL 10: approval sets cancellation + stock release, and never touches stock twice', () => {
  // The order is only cancelled on a still-live row.
  assert.match(
    decideFn,
    /update\s+public\.retail_orders[\s\S]*?set\s+order_status\s*=\s*'cancelled'/i,
    'approval is the path that cancels the order',
  );
  assert.match(
    decideFn,
    /order_status\s+not\s+in\s*\(\s*'shipped',\s*'delivered',\s*'rto',\s*'refunded'\s*\)/i,
    'a terminal order must not be re-cancelled',
  );
  // The exactly-once authority is the order's own guard, reused not replaced.
  assert.match(
    sql,
    /stock_restored_at/i,
    'the migration must reason about the existing exactly-once guard',
  );
  assert.doesNotMatch(
    decideFn,
    /set\s+stock_restored_at\s*=/i,
    'the migration must not write the guard itself',
  );
});

/* ================================================================== *
 * 5. Refund tracking is manual, and payment_status is never faked
 * ================================================================== */

test('CANCEL 11: approval classifies a manual refund and never sets payment_status=refunded', () => {
  assert.match(
    decideFn,
    /v_refund\s*:=\s*'refund_pending'/,
    'a paid order owes a manual refund',
  );
  assert.match(
    decideFn,
    /'not_applicable'/,
    'an unpaid order owes nothing',
  );
  assert.doesNotMatch(
    decideFn,
    /payment_status\s*=\s*'refunded'/i,
    'approval must NEVER mark the payment refunded',
  );
  // The only ORDER update in the approval path must not rewrite payment_status.
  const orderUpdate = decideFn.slice(
    decideFn.indexOf('update public.retail_orders'),
    decideFn.indexOf('update public.retail_orders') + 300,
  );
  assert.notEqual(orderUpdate, '', 'the approval path must update the order to cancelled');
  assert.doesNotMatch(
    orderUpdate,
    /payment_status/i,
    'approval must not change payment_status at all',
  );
});

test('CANCEL 12: the ONLY place payment_status becomes refunded is the explicit completion RPC', () => {
  assert.match(
    completeFn,
    /set\s+payment_status\s*=\s*'refunded'/i,
    'a confirmed refund is recorded on the order',
  );
  // ...and only for a genuine online capture on an already-cancelled order.
  assert.match(
    completeFn,
    /is_cod\s+is\s+not\s+true/i,
    'a COD order keeps its own payment vocabulary',
  );
  assert.match(
    completeFn,
    /order_status\s*=\s*'cancelled'/i,
    'the order must already be cancelled',
  );
  assert.match(
    completeFn,
    /refund_status\s*=\s*'refund_completed'/,
    'the request records the completion',
  );
});

test('CANCEL 13: a rejection leaves the order and payment state exactly as they were', () => {
  // The rejection branch runs from `if not p_approve then` to its `end if;`,
  // BEFORE any cancellation logic. Assert nothing order-mutating lives inside.
  const start = decideFn.indexOf('if not p_approve then');
  assert.notEqual(start, -1, 'the rejection branch must exist');
  const end = decideFn.indexOf('end if;', start);
  assert.notEqual(end, -1, 'the rejection branch must close');
  const rejectWindow = decideFn.slice(start, end);
  assert.match(rejectWindow, /'rejected'/, 'the rejection branch records the decision');
  assert.doesNotMatch(
    rejectWindow,
    /order_status\s*=/i,
    'a rejection must not change the order status',
  );
  assert.doesNotMatch(
    rejectWindow,
    /update\s+public\.retail_orders/i,
    'a rejection must not touch the order row',
  );
  assert.doesNotMatch(
    rejectWindow,
    /restock_retail_order_items/i,
    'a rejection must not move stock',
  );
});

test('CANCEL 14: completing a refund is refused unless a manual refund is actually pending', () => {
  assert.match(
    completeFn,
    /refund_status\s*<>\s*'refund_pending'/i,
    'no refund due means no completion',
  );
  assert.match(
    completeFn,
    /request_status\s*<>\s*'approved'/i,
    'only an approved cancellation can complete a refund',
  );
});

/* ================================================================== *
 * 6. Shipment concurrency — a cancelled order can never be shipped
 * ================================================================== */

test('CANCEL 15: the shipment CLAIM refuses an order that is no longer shippable', () => {
  const claim = shipment.slice(shipment.indexOf('const claim'), shipment.indexOf('const claim') + 900);
  assert.match(
    claim,
    /\.in\(\s*'order_status'\s*,\s*\[\.\.\.SHIPPABLE_STATUSES\]\s*\)/,
    'the claim CAS must require a still-shippable order status',
  );
});

test('CANCEL 16: the final shipment PERSIST cannot overwrite a cancelled order', () => {
  const persist = shipment.slice(shipment.indexOf('const patch'), shipment.indexOf('const patch') + 1200);
  assert.match(
    persist,
    /\.in\(\s*'order_status'\s*,\s*\[\.\.\.SHIPPABLE_STATUSES\]\s*\)/,
    'the persist CAS must not flip cancelled back to shipped',
  );
});

test('CANCEL 17: a lost shipment race is reported, not silently marked shipped', () => {
  assert.match(
    shipment,
    /Cancellation won the race/i,
    'the conflict must be logged for Delhivery reconciliation',
  );
  // The report must return a failure that names the reconciliation, never a
  // success that pretends the order shipped.
  const report = shipment.slice(shipment.indexOf('Cancellation won the race'));
  assert.match(report, /ok:\s*false/, 'a lost race must surface as a failure');
  assert.match(report, /Reconcile the parcel in Delhivery/i, 'the operator must be told what to do');
});

test('CANCEL 18: all three shipment writes carry the CAS predicate', () => {
  const count = (shipment.match(/\.in\('order_status', \[\.\.\.SHIPPABLE_STATUSES\]\)/g) || []).length;
  assert.equal(count, 3, 'claim, persist and the missing-column retry must all be guarded');
});

/* ================================================================== *
 * 6b. Payment callbacks cannot revive a cancelled order
 * ================================================================== */

/**
 * The success branch of a payment handler — the ONLY write that can move an
 * order back to a fulfilled state. Extracted by its update payload so the
 * assertions cannot be satisfied by the failure branch (which also matches
 * `order_status`).
 */
function successBranch(src, label) {
  const at = src.indexOf("order_status: 'processing'");
  assert.notEqual(at, -1, `${label}: expected the success branch`);
  // The surrounding update chain runs from the `.update({` before it to the
  // `.select('id')` that closes it. End there precisely — the failure branch
  // further down also mentions 'cancelled', and must not leak into this slice.
  const start = src.lastIndexOf('.update({', at);
  const end = src.indexOf(".select('id')", at);
  assert.notEqual(start, -1, `${label}: success branch must be an update chain`);
  assert.notEqual(end, -1, `${label}: success branch must close with a select`);
  return src.slice(start, end + ".select('id')".length);
}

test('CANCEL 26: a late payment SUCCESS cannot revive an admin-cancelled order', () => {
  // THE BUG THIS CLOSES: approval sets order_status = 'cancelled' but an unpaid
  // order's payment_status stays 'pending'. The success CAS guarded only on
  // payment_status, so a gateway confirmation arriving after the cancellation
  // matched and dragged the order back to 'processing' — silently reviving a
  // cancelled, already-restocked order.
  for (const [label, src] of [['cashfree-status', cfStatus], ['cashfree-webhook', cfWebhook]]) {
    // Strip comments: the explanatory prose for this very guard mentions
    // 'cancelled', and a comment must never satisfy (or break) the assertions.
    const branch = code(successBranch(src, label));
    assert.match(
      branch,
      /\.in\('order_status',\s*\[\s*'pending',\s*'processing'\s*\]\)/,
      `${label}: the success flip must require a still-awaiting-fulfilment order`,
    );
    // Only a pre-fulfilment order may be settled — never cancelled/refunded.
    assert.doesNotMatch(
      branch,
      /'cancelled'/,
      `${label}: a cancelled order must not be a candidate for the success flip`,
    );
  }
});

/* ================================================================== *
 * 7. Client wiring
 * ================================================================== */

test('CANCEL 19: the customer wrapper calls the request RPC and surfaces refusals', () => {
  assert.match(
    accountLib,
    /sb\.rpc\('request_order_cancellation',\s*\{[\s\S]*?p_ref[\s\S]*?p_reason/,
    'the wrapper must call the request RPC with a ref and an optional reason',
  );
});

test('CANCEL 20: My Orders offers the action only when the order is still eligible', () => {
  // The eligibility helper refuses guests, pending requests, shipped parcels and
  // terminal statuses.
  assert.match(myOrders, /function canRequestCancellation/, 'eligibility must be computed, not assumed');
  assert.match(myOrders, /o\.cancellation\?\.request_status\s*===\s*'pending'/, 'a live request hides the button');
  assert.match(myOrders, /hasAwb\(o\)\s*\|\|\s*o\.shipped_at\s*\|\|\s*isPostHandoff/, 'a parcel hides the button');
});

test('CANCEL 21: the confirmation dialog states that approval is required and shows the facts', () => {
  assert.match(cancelDialog, /does not cancel the order\s*\n?\s*immediately|administrator to review/i, 'the dialog must explain the request is not a cancellation');
  assert.match(cancelDialog, /paymentLabel/, 'the dialog must show the payment method');
  assert.match(cancelDialog, /amountPaid/, 'the dialog must show the amount paid');
  assert.match(cancelDialog, /reason/, 'the dialog must allow a reason');
});

test('CANCEL 22: the admin panel approves/rejects and completes manual refunds', () => {
  assert.match(adminLib, /rpc\('decide_order_cancellation'/, 'the admin wrapper must call the decide RPC');
  assert.match(adminLib, /rpc\('complete_order_cancellation_refund'/, 'and the completion RPC');
  assert.match(admin, /CancellationRequestsPanel/, 'the orders tab must render the queue');
  assert.match(admin, /Approve cancellation/, 'an approve action must exist');
  assert.match(admin, /Mark refund completed/, 'a refund-completion action must exist');
});

test('CANCEL 23: the customer sees the request status and decision note in My Orders', () => {
  assert.match(myOrders, /awaiting admin review/i, 'the pending state must be shown');
  assert.match(myOrders, /Cancellation (approved|request)/, 'the decision outcome must be shown');
  assert.match(myOrders, /decision_note/, 'the admin decision note must be shown');
});

/* ================================================================== *
 * 8. No new notification mechanism, no guest flow, no unrelated surface
 * ================================================================== */

test('CANCEL 24: no cancellation email template or new notification path is introduced', () => {
  const emailTemplates = read('supabase/functions/_shared/emails.ts');
  assert.doesNotMatch(emailTemplates, /cancellation/i, 'no cancellation email template may be added');
});

test('CANCEL 25: there is no guest cancellation path in this release', () => {
  assert.doesNotMatch(
    requestFn,
    /claim_retail_guest_order|guest/i,
    'the request RPC must not open a guest flow',
  );
  // Ownership is required, which excludes an unclaimed guest order.
  assert.match(requestFn, /v_order\.user_id\s+is\s+distinct\s+from\s+v_uid/i);
});

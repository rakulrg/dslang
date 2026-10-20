/**
 * CANCELLATION & REFUND POLICY — regression suite.
 *
 * The cancellation feature ships with a customer-facing policy. The policy and
 * the code must tell the same story, so this suite is the seam between them: it
 * asserts that the Terms & Conditions and the Refund & Cancellation Policy
 * describe the workflow that actually exists — a REQUEST that an administrator
 * approves, with a MANUAL refund tracked as pending until it is confirmed — and
 * that neither page promises anything the implementation does not do.
 *
 * The most important assertions here are the NEGATIVE ones. It is easy for a
 * policy to drift into promising an automatic refund or a fixed timeline; those
 * are the claims DSLANG cannot reliably meet, so they are locked out explicitly
 * rather than left to reviewer memory.
 *
 * Style note: like cancellation-requests.test.mjs, these assert on the real
 * source of the two policy pages and the two customer-facing strings, because
 * rendering needs a browser. Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const TERMS = 'src/pages/TermsConditionsPage.tsx';
const REFUND = 'src/pages/RefundCancellationPage.tsx';
const MY_ORDERS = 'src/pages/MyOrdersPage.tsx';
const CANCEL_DIALOG = 'src/pages/orderConfirm/CancellationRequestDialog.tsx';

const terms = read(TERMS);
const refund = read(REFUND);
const myOrders = read(MY_ORDERS);
const cancelDialog = read(CANCEL_DIALOG);

/* ================================================================== *
 * 1. The Refund & Cancellation Policy documents the request workflow
 * ================================================================== */

test('POLICY 1: the refund policy describes the My Orders cancellation REQUEST', () => {
  // JSX prose wraps across lines; match across whitespace, not a literal space.
  const phrase = (s) => new RegExp(s.replace(/ /g, '\\s+'), 'i');
  assert.match(refund, /My Orders/, 'the request path must be named');
  assert.match(refund, phrase('request cancellation of an order'), 'a request (not an automatic cancel) must be described');
  // The load-bearing sentence: asking changes nothing.
  assert.match(
    refund,
    phrase('Submitting a request does not cancel your order'),
    'the policy must say a request does not cancel the order',
  );
  assert.match(refund, phrase('administrator will approve or reject it'), 'admin approval must be stated');
});

test('POLICY 2: the policy states approve cancels+restocks and reject changes nothing', () => {
  const phrase = (s) => new RegExp(s.replace(/ /g, '\\s+'), 'i');
  assert.match(refund, phrase('the order is cancelled and any reserved inventory is restored'), 'approval must state the cancellation + restore');
  assert.match(refund, phrase('rejected, your order and its payment state are left unchanged'), 'rejection must state nothing changes');
});

test('POLICY 3: shipped / incompatible orders are routed to support', () => {
  const phrase = (s) => new RegExp(s.replace(/ /g, '\\s+'), 'i');
  assert.match(refund, phrase('already been shipped, or that are in an incompatible shipping state'), 'shipped orders must be excluded');
  assert.match(refund, phrase('cannot be cancelled through this feature'), 'the feature must be scoped');
  assert.match(refund, /DSLANG support/i, 'the customer must be pointed at support');
});

test('POLICY 4: status is viewable in My Orders and guests are excluded', () => {
  const phrase = (s) => new RegExp(s.replace(/ /g, '\\s+'), 'i');
  assert.match(refund, phrase('follow the status of your request and its decision'), 'request/decision status must be viewable');
  assert.match(refund, phrase('not available for guest orders in this release'), 'guest orders must be explicitly excluded');
});

/* ================================================================== *
 * 2. Refund wording matches the MANUAL, tracked implementation
 * ================================================================== */

test('POLICY 5: approval is explicitly NOT a completed refund', () => {
  const phrase = (s) => new RegExp(s.replace(/ /g, '\\s+'), 'i');
  assert.match(
    refund,
    phrase('Approving a cancellation does not mean a refund has been completed'),
    'the policy must separate approval from a completed refund',
  );
  assert.match(refund, phrase('shown as pending until the money has actually been refunded'), 'pending-until-confirmed must be stated');
  assert.match(refund, /not automatic/i, 'refunds must be stated as manual, not automatic');
});

test('POLICY 6: the COD cases are both covered', () => {
  // The two clauses sit on the same JSX line but the surrounding prose wraps,
  // so both halves are matched across whitespace via one constructed regex.
  const across = (s) => new RegExp(s.replace(/ /g, '\\s+'), 'i');
  assert.match(
    refund,
    across('cash-on-delivery order where no amount was collected[\\s\\S]*?no refund is due'),
    'COD with nothing collected -> no refund due',
  );
  assert.match(
    refund,
    across('cash-on-delivery order where an advance amount was collected[\\s\\S]*?pending'),
    'COD with an advance -> refund pending',
  );
});

test('POLICY 7: the policy does not claim Cashfree refunds are integrated', () => {
  assert.doesNotMatch(refund, /cashfree/i, 'no gateway-integrated refund may be claimed');
});

/* ================================================================== *
 * 3. The fixed timeline is gone (the business cannot guarantee it)
 * ================================================================== */

test('POLICY 8: no fixed refund timeline is promised on any policy page', () => {
  // The removed claim: "Approved refunds are processed within 5 days ...".
  for (const [label, src] of [['refund policy', refund], ['terms', terms]]) {
    assert.doesNotMatch(
      src,
      /refunds? (are|will be) (processed|issued|made|completed) within \d+/i,
      `${label}: a fixed refund-processing timeline must not be promised`,
    );
    assert.doesNotMatch(
      src,
      /refund(ed)? within \d+ (days|working days)/i,
      `${label}: a fixed refund timeline must not be promised`,
    );
  }
  // And the policy says plainly that no fixed timeline is guaranteed.
  assert.match(refund, /cannot guarantee a fixed timeline/i, 'the policy must say no fixed timeline is guaranteed');
});

/* ================================================================== *
 * 4. Terms & Conditions carry the same story and link the policy
 * ================================================================== */

test('POLICY 9: the Terms describe the request/approval workflow and manual refund', () => {
  // JSX wraps prose across lines, so every phrase is matched with \s+ between
  // words rather than a literal space (a bare space would fail at a line break).
  const phrase = (s) => new RegExp(s.replace(/ /g, '\\s+'), 'i');
  assert.match(terms, /refund-and-cancellation/, 'the Terms must link the Refund & Cancellation Policy');
  assert.match(terms, phrase('request cancellation of an eligible order'), 'the Terms must describe the request');
  assert.match(terms, phrase('does not cancel the order by itself'), 'the Terms must say a request is not a cancellation');
  assert.match(terms, /administrator[\s\S]*approves or rejects/i, 'the Terms must state admin approval');
  assert.match(terms, phrase('handled separately and manually'), 'the Terms must state refunds are manual');
  assert.match(terms, phrase('does not mean a refund has been completed'), 'the Terms must separate approval from a completed refund');
  assert.match(terms, phrase('do not promise an automatic refund or a fixed refund timeline'), 'the Terms must disclaim a fixed timeline');
});

/* ================================================================== *
 * 5. The in-product copy tells the same story as the policy
 * ================================================================== */

test('POLICY 10: My Orders and the dialog do not promise a refund timeline', () => {
  for (const [label, src] of [['My Orders', myOrders], ['cancellation dialog', cancelDialog]]) {
    assert.doesNotMatch(
      src,
      /few working days/i,
      `${label}: a soft refund timeline must not be shown once the policy drops it`,
    );
  }
  // The dialog must still make clear that a request is not a cancellation.
  assert.match(cancelDialog, /does not cancel the order/i, 'the dialog must say a request is not a cancellation');
  assert.match(cancelDialog, /refunded separately and is shown as pending/i, 'the dialog must describe the pending refund');
});

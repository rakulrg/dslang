// Guest-order linking on My Orders: the per-order "is this you?" flow.
//
// These tests pin the FRONTEND contract against the two RPCs that migration
// 20261019000000 actually installed. The database side is covered elsewhere
// (retail-order-update-policy, rpc-privileges); what is asserted here is that
// the UI cannot reach those RPCs in any way that would defeat them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const ACCOUNT = read('src/lib/account.ts');
const PAGE = read('src/pages/MyOrdersPage.tsx');
const CARD = read('src/pages/orderConfirm/GuestOrderConfirmCard.tsx');

const M19 = read('supabase/migrations/20261019000000_dslang_guest_claim_phone_proof.sql');

/** Comments explain the rules, so they legitimately NAME the things they ban. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ---------------------------------------------------------------------------
// 1. The dead bulk-link button is gone.
// ---------------------------------------------------------------------------

test('GUEST: the bulk one-tap claim is removed from the data layer', () => {
  assert.doesNotMatch(
    ACCOUNT,
    /export async function claimGuestOrders\b/,
    'the bulk claimGuestOrders() helper must not exist any more',
  );
  // `p_ref: null` is the RPC\'s "claim EVERY eligible match" mode. The frontend
  // must never send it: a bulk claim links every order sharing a phone number,
  // which is the guessing this flow exists to prevent.
  assert.doesNotMatch(
    code(ACCOUNT),
    /p_ref:\s*null/,
    'no frontend call may pass p_ref: null (the RPC bulk-claims every match)',
  );
});

test('GUEST: My Orders has no bulk link button', () => {
  assert.doesNotMatch(
    PAGE,
    /Link \$\{|claimGuestOrders|We found \d+ order/,
    'the single bulk-link banner must be gone from My Orders',
  );
  // Both per-order RPCs are wired instead.
  assert.match(PAGE, /claimGuestOrder/);
  assert.match(PAGE, /declineGuestOrder/);
});

// ---------------------------------------------------------------------------
// 2. One order, one decision, one ref.
// ---------------------------------------------------------------------------

test('GUEST: the confirmation card is per-order and always passes a ref', () => {
  // The card receives a single orderRef and hands back a decision; it has no
  // access to the order list, so it cannot act on more than one order.
  assert.match(CARD, /orderRef: string;/);
  assert.match(CARD, /onConfirm: \(phone: string\)/);
  assert.match(CARD, /onDecline: \(phone: string\)/);
  assert.doesNotMatch(
    CARD,
    /orders\.map|forEach|filter\(/,
    'the card must not iterate orders — it decides on exactly one',
  );
  // The page renders the card for a single order, not for each in a list.
  assert.match(
    PAGE,
    /<GuestOrderConfirmCard[\s\S]{0,200}?orderRef=\{pendingClaims\[0\]\.ref\}/,
    'the card must be rendered for one specific order ref',
  );
  // …and shows at most one at a time.
  assert.doesNotMatch(
    PAGE,
    /pendingClaims\.map\(/,
    'only one card may be on screen, so the flow cannot be answered by one guess',
  );
});

test('GUEST: only orders that can actually be proven are put to the customer', () => {
  // The card needs a phone the shopper can type back. An order with no usable
  // phone on it can never be linked, so asking would be a dead end; it stays
  // visible in the list instead.
  assert.match(
    PAGE,
    /o\.guest\s*&&\s*!\s*o\.claim_declined_at\s*&&\s*!\s*deferred\.includes\(o\.ref\)/,
    'the pending list must exclude linked, declined and deferred orders',
  );
  // The number is asked for ONCE, up front, and the rows that reach the pending
  // list have already passed the server-side email + phone check — so the list
  // must NOT filter on the order's stored phone. That field is not even disclosed
  // for a candidate: the projection withholds the whole `customer` object.
  assert.doesNotMatch(
    PAGE,
    /o\.customer\?\.phone[\s\S]{0,80}deferred\.includes/,
    'the pending list must not gate on a phone the projection never returns',
  );
  assert.match(
    PAGE,
    /const digits = proofPhone\.replace\(\/\\D\/g, ''\)\.slice\(0, 10\)/,
    'the proof must be reduced to 10 digits before it is used',
  );
  assert.match(
    PAGE,
    /if \(!\/\^\[6-9\]\\d\{9\}\$\/\.test\(digits\)\)/,
    'a number that is not a 10-digit mobile must not reach the server',
  );
  assert.match(ACCOUNT, /sb\.rpc\('list_retail_guest_candidates', \{ p_phone: digits \}\)/);
  // Oldest first: the earliest unlinked order is the one most likely to already
  // be in transit.
  assert.match(
    PAGE,
    /sort\(\(a, b\) => Date\.parse\(a\.created_at\) - Date\.parse\(b\.created_at\)\)/,
    'pending orders must be offered oldest first',
  );
});

// ---------------------------------------------------------------------------
// 3. The phone proof — the whole point of the flow.
// ---------------------------------------------------------------------------

test('GUEST: both decisions are phone-gated in the data layer', () => {
  // One shared implementation means "Yes" and "No" cannot drift apart: the RPCs
  // are called through the same helper with the same validation.
  assert.match(ACCOUNT, /async function decideGuestOrder\(/);
  assert.match(ACCOUNT, /'claim_retail_guest_order' \| 'decline_retail_guest_order'/);
  // The proof is validated BEFORE the network call, so a short/empty number
  // never reaches the RPC as a request.
  assert.match(ACCOUNT, /if \(!PHONE_RE\.test\(digits\)\)/);
  assert.match(ACCOUNT, /const PHONE_RE = \/\^\[6-9\]\\d\{9\}\$\//);
  // The shared helper is what actually calls the RPC, and it is passed the
  // function name, so both wrappers necessarily send the same proof.
  assert.match(
    ACCOUNT,
    /sb\.rpc\(fn, \{ p_ref: ref, p_phone: digits \}\)/,
    'the shared helper must pass p_ref AND p_phone to whichever RPC it was given',
  );
  // …and each wrapper names one of the two real functions.
  assert.match(ACCOUNT, /decideGuestOrder\(ref, phone, 'claim_retail_guest_order', 'claimed'\)/);
  assert.match(ACCOUNT, /decideGuestOrder\(ref, phone, 'decline_retail_guest_order', 'declined'\)/);
  // The names must be the two that exist in migration 19 — not a typo that
  // would send every claim to a function that does not exist.
  for (const fn of ['claim_retail_guest_order', 'decline_retail_guest_order']) {
    assert.match(M19, new RegExp(`create or replace function public\\.${fn}\\(`), `${fn} must be defined by migration 19`);
  }
});

test('GUEST: the card will not send either answer without a valid phone', () => {
  assert.match(CARD, /if \(busy \|\| !phoneReady\) return;/);
  // Both buttons are gated, so "No" is as hard to submit as "Yes" — otherwise an
  // email guess could permanently hide a real customer\'s order.
  const buttons = [...CARD.matchAll(/disabled=\{busy !== null \|\| !phoneReady\}/g)];
  assert.equal(buttons.length, 2, 'both answer buttons must require a valid phone');
  // The field is never prefilled from the order row: the order's phone is not
  // disclosed to the account at all (the candidate projection withholds
  // `customer`), so echoing the number back would make the check theatre.
  assert.doesNotMatch(
    CARD,
    /useState\([^)]*(phone|defaultValue)/i,
    'the proof field must start empty',
  );
  assert.doesNotMatch(CARD, /defaultValue/, 'the proof must never be prefilled from the order');
});

test('GUEST: the phone shape the UI sends is the shape the RPCs require', () => {
  // The RPCs normalise with regexp_replace('[^0-9]','','g') and require length 10.
  // The UI must therefore send a 10-digit string and nothing else.
  assert.match(M19, /regexp_replace\(btrim\(coalesce\(p_phone, ''\)\), '\[\^0-9\]', '', 'g'\)/);
  assert.match(M19, /length\(v_phone\) <> 10/);
  // The UI strips to digits and caps at 10 before sending.
  assert.match(ACCOUNT, /function normalisePhone\([\s\S]{0,200}?replace\(\/\\D\/g, ''\)\.slice\(0, 10\)/);
  assert.match(CARD, /replace\(\/\\D\/g, ''\)\.slice\(0, 10\)/);
});

// ---------------------------------------------------------------------------
// 4. "No" is durable, "ask me later" is not.
// ---------------------------------------------------------------------------

test('GUEST: a decline is persisted server-side and is never re-asked', () => {
  // The RPC writes claim_declined_at…
  assert.match(
    M19,
    /set claim_declined_at = now\(\)[\s\S]{0,200}?and o\.claim_declined_at is null/,
    'the decline must write claim_declined_at and only onto un-declined orders',
  );
  // …the read requests it…
  assert.match(ACCOUNT, /claim_declined_at/);
  // …and the UI filters on it, so the card cannot reappear after a reload or on
  // another device.
  assert.match(
    PAGE,
    /!\s*o\.claim_declined_at/,
    'a declined order must be excluded from the pending list',
  );
});

test('GUEST: "ask me later" is session-only, a decline is not', () => {
  // A deferral must not be persisted: it would hide the question forever on the
  // strength of one dismissal. Only claim_declined_at is durable, and that is
  // written by the RPC, not the browser.
  assert.doesNotMatch(
    code(PAGE),
    /localStorage|sessionStorage/,
    'the deferral must live in component state only, never in storage',
  );
  assert.match(PAGE, /useState<string\[\]>\(\[\]\)/);
  assert.match(PAGE, /setDeferred\(\(d\) => \[\.\.\.d, pendingClaims\[0\]\.ref\]\)/);
});

test('GUEST: a declined order is never offered again, and stays trackable', () => {
  // CHANGED BY MIGRATION 20, deliberately. A declined order is not the
  // shopper's, it was never linked, and showing it in an account meant reading
  // a row under `retail_orders_select_owner` that the account does not own -
  // the delivery snapshot of somebody else's purchase. It is now excluded
  // server-side: the candidate RPC filters `claim_declined_at is null`, and the
  // owner policy no longer returns unclaimed rows at all.
  assert.match(
    read('supabase/migrations/20261020000000_dslang_owner_select_and_guest_candidate_projection.sql'),
    /o\.claim_declined_at is null/,
    'the candidate lookup must exclude declined orders server-side',
  );
  // The row can therefore never render a "not linked yet" state for one.
  assert.match(PAGE, /!o\.claim_declined_at/);
  // Tracking is unaffected and needs no account: the public page re-proves
  // possession with ref + phone on every visit.
  assert.match(PAGE, /Track Order page/i);
});

// ---------------------------------------------------------------------------
// 5. A proof that does not match is an outcome, not a crash.
// ---------------------------------------------------------------------------

test('GUEST: a non-matching phone is reported inline, never swallowed', () => {
  // The RPC reports a legitimate no-op as ok:true with count 0. Treating that as
  // success would silently reload into the same question forever, so count 0 is
  // surfaced as a message.
  assert.match(PAGE, /res\.count === 0/);
  assert.match(PAGE, /does not match this order/);
  // …on BOTH paths, since a wrong number blocks the decline too.
  const countZero = [...PAGE.matchAll(/res\.count === 0/g)];
  assert.equal(countZero.length, 2, 'both confirm and decline must handle a non-match');
  // The card renders the message with role="alert" and stays open.
  assert.match(CARD, /role="alert"/);
  assert.match(CARD, /if \(res\.ok\) return;/);
  // The server\'s own message is surfaced verbatim rather than swallowed.
  assert.match(ACCOUNT, /error\.message/);
});

// ---------------------------------------------------------------------------
// 6. Guest checkout stays guest checkout.
// ---------------------------------------------------------------------------

test('GUEST: nothing here adds a login, OTP, password or account requirement', () => {
  const touched = [ACCOUNT, PAGE, CARD].map(code).join('\n');
  for (const banned of [
    /\botp\b/i,
    /password/i,
    /signInWithPassword|signInWithOtp|signInWithOAuth/,
    /magic ?link/i,
    /requireAccount|forceLogin|isLoggedIn/,
  ]) {
    assert.doesNotMatch(touched, banned, `the guest-claim flow must not introduce ${banned}`);
  }
  // The card and the helpers are only ever reachable from a signed-in page, and
  // the RPCs are SECURITY DEFINER over auth.uid() — no new auth surface here.
  assert.match(PAGE, /if \(!user\)/, 'My Orders still requires a signed-in user to reach the flow');
  // Guest ordering is unaffected: nothing in these files touches create_retail_order
  // or the checkout's own required-field list.
  assert.doesNotMatch(touched, /create_retail_order|REQUIRED_FIELDS/);
});

test('GUEST: the subtitle states the phone requirement and keeps guest checkout open', () => {
  // Bound the slice from the subtitle to the card, searching FORWARD from the
  // subtitle: the component name also appears in the import at the top of the
  // file, so a bare indexOf would produce a negative-length slice.
  const subStart = PAGE.indexOf('Orders placed with this email address');
  const subtitle = PAGE.slice(subStart, PAGE.indexOf('GuestOrderConfirmCard', subStart));
  assert.match(subtitle, /before you signed in/i, 'the subtitle must explain why an order is listed');
  // The em dash in the source is a multi-byte character, so match across it
  // rather than pinning the exact punctuation.
  // Whitespace-tolerant: JSX hard-wraps the sentence across lines.
  assert.match(
    subtitle,
    /email\s+address\s+alone\s+isn't\s+enough/i,
    'the subtitle must say an email alone is not enough — the reason a phone is asked for',
  );
  assert.match(
    subtitle,
    /never requires an account/i,
    'the subtitle must state that ordering never requires an account',
  );
  assert.match(subtitle, /Track Order page/i, 'the guest tracking route must stay advertised');
});

test('GUEST: the secure post-checkout attach still uses the same proof', () => {
  // Checkout links the order it just placed, using the number the shopper typed
  // at checkout — proof, not a guess, and the same RPC the card uses.
  assert.match(
    ACCOUNT,
    /export async function attachOrderToUser\(ref: string, phone: string\)[\s\S]{0,700}?p_phone: digits/,
    'attachOrderToUser must send the phone proof',
  );
  assert.match(
    ACCOUNT,
    /if \(digits\.length !== 10\) return;/,
    'attachOrderToUser must refuse to call the RPC without a full number',
  );
  // Still best-effort: a failed link must never block a purchase.
  assert.match(ACCOUNT, /await sb\.rpc\('claim_retail_guest_order'[\s\S]{0,120}?catch/);
});

test('GUEST: the account read degrades one column-group at a time', () => {
  // claim_declined_at is its own fallback step: losing shipping detail costs
  // precision, but losing a decline would resurrect a question already answered.
  assert.match(ACCOUNT, /const SELECT_BASE\s*=/);
  assert.match(ACCOUNT, /const SELECT_SHIPPING\s*=/);
  assert.match(ACCOUNT, /`\$\{SELECT_BASE\}, \$\{SELECT_SHIPPING\}, claim_declined_at`/);
  assert.match(ACCOUNT, /`\$\{SELECT_BASE\}, \$\{SELECT_SHIPPING\}`/);
  // A genuine failure must not replay three times.
  assert.match(ACCOUNT, /if \(!missingColumn\) \{/);
});

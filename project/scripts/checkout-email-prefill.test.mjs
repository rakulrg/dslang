/**
 * SIGNED-IN CHECKOUT EMAIL PREFILL regression suite.
 *
 * The bug: a customer who is signed in but has never completed an order saw an
 * empty, required Email field ("Please enter your email for order updates"),
 * even though the verified account email was sitting on the Supabase session
 * the whole time. The prefill effect's ONLY email source was the optional
 * `customer_profiles` row, which is written after a successful order — so for a
 * first-time signed-in shopper there was no profile at all and the field stayed
 * blank.
 *
 * The fix gives the effect a second, always-available source (`user.email`) and
 * makes both sources fill a BLANK field only.
 *
 * These tests EXECUTE the shipped decision rather than restating it:
 *   * the email-selection expression is lifted out of `CheckoutPage.tsx` and
 *     run against real inputs (both the mount-time write and the profile-load
 *     write), and
 *   * the required-field rule and its message are lifted out of the same file,
 *     so the validation asserted here is the production one.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = 'src/pages/CheckoutPage.tsx';
const src = readFileSync(join(ROOT, CHECKOUT), 'utf8');

/**
 * Strip comments so a CODE assertion is not affected by explanatory prose.
 *
 * Line endings are normalised to LF FIRST. `CheckoutPage.tsx` is checked out
 * with CRLF on Windows and LF elsewhere, and the assertions below match
 * multi-line source with `\n` in the needle. Without this normalisation the
 * same file passes on one platform and fails on the other — a test that reports
 * the developer's git EOL setting rather than whether the fix is present. The
 * needles stay exact; only the file's line-ending convention is made irrelevant.
 */
const codeOnly = src
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* ================================================================== *
 * Lifted, verbatim, out of the shipped prefill effect
 * ================================================================== */

/** The mount-time write, exactly as shipped (session email fills a blank field). */
const MOUNT_WRITE = "setForm((f) => (f.email.trim() || !accountEmail ? f : { ...f, email: accountEmail }));";

/** The profile-load email decision, exactly as shipped. */
const PROFILE_EMAIL_LINE = "const email = f.email.trim() || p?.email?.trim() || accountEmail;";

/** The `!p` early return for a shopper with no profile row, exactly as shipped. */
const NO_PROFILE_RETURN = "if (!p) return { ...f, email };";

function lift(needle, label) {
  const at = codeOnly.indexOf(needle);
  assert.notEqual(at, -1, `expected the shipped ${label} in ${CHECKOUT}`);
  return needle;
}

/**
 * Run the REAL mount-time write. `accountEmail` is the trimmed session email,
 * `form.email` whatever the shopper had in the field.
 */
function applyMountWrite(form, accountEmail) {
  const body = lift(MOUNT_WRITE, 'mount-time session-email write').replace(/^setForm\(/, '').replace(/\);$/, '');
  const accountEmailDecl = `const accountEmail = ${JSON.stringify(accountEmail)};`;
  // `body` is the shipped `(f) => …` updater; call it with the current form.
  return new Function('f', `${accountEmailDecl}\nreturn (${body})(f);`)({ ...form });
}

/**
 * Run the REAL profile-load email decision, followed by the real no-profile
 * early return. `p` is the saved profile (or null when no row exists).
 */
function applyProfileWrite(form, p, accountEmail) {
  const emailLine = lift(PROFILE_EMAIL_LINE, 'profile-load email decision');
  const noProfile = lift(NO_PROFILE_RETURN, 'no-profile-row fallback');
  const fn = new Function(
    'f', 'p', 'accountEmail',
    `${emailLine}\n${noProfile}\nreturn { ...f, email };`,
  );
  const safeProfile = p && p.email === undefined ? { ...p, email: undefined } : p;
  return fn({ ...form }, safeProfile, accountEmail);
}

/** The shipped required-field rule for `email`, lifted from validateField. */
const REQUIRED_EMAIL_RULE = (() => {
  const at = codeOnly.indexOf("case 'email':");
  assert.notEqual(at, -1, 'expected the email case in validateField');
  const body = codeOnly.slice(at, codeOnly.indexOf("case 'apartment':", at));
  const emptyReturn = /if \(!v\) return '([^']+)'/.exec(body);
  assert.ok(emptyReturn, 'expected the empty-email error message');
  const reMatch = /EMAIL_RE\.test\(v\)/.test(body);
  assert.ok(reMatch, 'expected the format check');
  return { message: emptyReturn[1] };
})();

/** The shipped EMAIL_RE, lifted verbatim. */
const EMAIL_RE = (() => {
  const m = /const EMAIL_RE = (\/.*\/);/.exec(codeOnly);
  assert.ok(m, 'expected the EMAIL_RE constant');
  return new Function(`return ${m[1]};`)();
})();

/** Reproduce validateField('email', value) from the shipped rule. */
function validateEmail(value) {
  const v = String(value).trim();
  if (!v) return REQUIRED_EMAIL_RULE.message;
  return EMAIL_RE.test(v) ? null : 'Enter a valid email address';
}

const blankForm = () => ({
  firstName: '', lastName: '', phone: '', email: '',
  address: '', apartment: '', city: '', state: '', pincode: '',
});

const SESSION_EMAIL = 'shopper@example.com';

/* ================================================================== *
 * 1. Signed in WITH an email — the reported bug
 * ================================================================== */

test('EMAIL PREFILL 1: a signed-in shopper with an account email and NO profile row is prefilled', () => {
  // The reported bug: loadSavedProfile returns null (no customer_profiles row),
  // so the OLD effect returned at `if (!p) return;` and the field stayed blank.
  const accountEmail = SESSION_EMAIL.trim();
  let form = applyMountWrite(blankForm(), accountEmail);
  assert.equal(form.email, SESSION_EMAIL, 'the session email must fill the blank field');

  // Then the profile resolves to null — the fix must keep the field populated.
  form = applyProfileWrite(form, null, accountEmail);
  assert.equal(form.email, SESSION_EMAIL, 'a null profile must NOT blank the session email');
  assert.equal(validateEmail(form.email), null, 'the prefilled field must be valid');
});

test('EMAIL PREFILL 2: an empty profile email falls back to the account email', () => {
  const accountEmail = SESSION_EMAIL.trim();
  let form = applyMountWrite(blankForm(), accountEmail);
  form = applyProfileWrite(form, {
    name: 'Test Shopper', phone: '9876543210', email: undefined,
    address: '1 Main St', city: 'Pune', state: 'Maharashtra', pincode: '411001',
  }, accountEmail);
  assert.equal(form.email, SESSION_EMAIL,
    'an available account email must never be left blank for an empty profile email');
});

test('EMAIL PREFILL 3: the session email wins over a stale profile email only when the field is blank is NOT the rule — a blank field takes the profile when the session has none', () => {
  // No session email, profile has one: the profile must supply it.
  let form = applyMountWrite(blankForm(), '');
  assert.equal(form.email, '', 'with no session email the blank field stays blank at mount');
  form = applyProfileWrite(form, {
    name: 'A B', phone: '9876543210', email: 'profile@example.com',
    address: 'x', city: 'y', state: 'z', pincode: '411001',
  }, '');
  assert.equal(form.email, 'profile@example.com',
    'the saved profile email must still prefill when the session has none');
});

/* ================================================================== *
 * 2. Signed in WITHOUT a usable email
 * ================================================================== */

test('EMAIL PREFILL 4: a signed-in account with no email keeps the field empty and the requirement intact', () => {
  const accountEmail = (null ?? '').trim();
  let form = applyMountWrite(blankForm(), accountEmail);
  assert.equal(form.email, '', 'no email anywhere -> the field stays empty');

  form = applyProfileWrite(form, null, accountEmail);
  assert.equal(form.email, '', 'a null profile cannot invent an email');

  form = applyProfileWrite(form, { name: 'A B', phone: '9876543210', email: undefined, address: 'x', city: 'y', state: 'z', pincode: '411001' }, accountEmail);
  assert.equal(form.email, '', 'an empty profile email and no session email -> still empty');

  // The existing validation and its message are unchanged.
  assert.equal(validateEmail(form.email), REQUIRED_EMAIL_RULE.message,
    'the required-field error must still fire');
  assert.equal(REQUIRED_EMAIL_RULE.message, 'Please enter your email for order updates');
});

/* ================================================================== *
 * 3. A deliberately typed email is never overwritten
 * ================================================================== */

test('EMAIL PREFILL 5: an email already in the field is never overwritten by either source', () => {
  const accountEmail = SESSION_EMAIL.trim();
  const typed = 'typed-by-me@example.com';

  // Mount-time: the shopper (or a restored session form) already has a value.
  let form = applyMountWrite({ ...blankForm(), email: typed }, accountEmail);
  assert.equal(form.email, typed, 'the mount-time write must not clobber a typed email');

  // The async profile load resolves later and must also leave it alone, even
  // when BOTH the session and the profile carry a different address.
  form = applyProfileWrite(form, {
    name: 'Other Name', phone: '9000000000', email: 'profile@example.com',
    address: 'Elsewhere', city: 'Delhi', state: 'Delhi', pincode: '110001',
  }, accountEmail);
  assert.equal(form.email, typed, 'the profile load must not clobber a typed email');

  // The address projection is unchanged by this fix — it still runs for a
  // profile that exists (test 7 covers its values).
  assert.match(codeOnly, /address: p\.address/,
    'the profile must still prefill the address fields');
});

/* ================================================================== *
 * 4. Guest checkout is unchanged
 * ================================================================== */

test('EMAIL PREFILL 6: the effect returns before any email write when nobody is signed in', () => {
  // The shipped guard is the FIRST statement of the effect, ahead of the new
  // session-email write, so guests take exactly the old path.
  const guard = 'useEffect(() => {\n    if (!user) return;';
  assert.notEqual(codeOnly.indexOf(guard), -1, 'the guest early return must remain the first statement');
  const guardAt = codeOnly.indexOf(guard);
  const mountAt = codeOnly.indexOf(MOUNT_WRITE);
  const loadAt = codeOnly.indexOf('await loadSavedProfile(user.id)');
  assert.ok(guardAt < mountAt, 'the guest return must precede the new session-email write');
  assert.ok(guardAt < loadAt, 'the guest return must precede the profile load');
  // The guard is the effect's first statement, so a guest reaches no prefill code.
  assert.match(codeOnly, /useEffect\(\(\) => \{\n\s*if \(!user\) return;\n/,
    'the guest early return must be the very first statement of the effect');
});

/* ================================================================== *
 * 5. Name/phone/address prefill is preserved
 * ================================================================== */

test('EMAIL PREFILL 7: the saved profile still prefills name, phone and address', () => {
  const accountEmail = '';
  const profile = {
    name: 'Asha Kumar', phone: '9876543210', email: 'asha@example.com',
    address: '12 MG Road', apartment: 'Flat 4', city: 'Bengaluru',
    state: 'Karnataka', pincode: '560001',
  };
  const decision = applyProfileWrite(blankForm(), profile, accountEmail);
  // The email line is executed above; the address projection is the shipped
  // object literal, so assert the values it must produce.
  assert.equal(decision.email, 'asha@example.com');
  const projection = codeOnly.slice(codeOnly.indexOf('const [firstName = \'\', ...rest]'));
  assert.match(projection, /phone: p\.phone\.replace\(\/\\D\/g, ''\)\.slice\(0, 10\)/,
    'the phone must keep its 10-digit normalisation');
  assert.match(projection, /address: p\.address/);
  assert.match(projection, /apartment: p\.apartment \?\? ''/);
  assert.match(projection, /city: p\.city/);
  assert.match(projection, /state: p\.state/);
  assert.match(projection, /pincode: p\.pincode/);
});

test('EMAIL PREFILL 8: the session email is applied before the storage write and before the await', () => {
  // The immediate write must precede `await loadSavedProfile(...)` so there is no
  // window in which the required field renders blank (no invalid flash) and the
  // persisted form copy already carries the email.
  const mountAt = codeOnly.indexOf(MOUNT_WRITE);
  const awaitAt = codeOnly.indexOf('await loadSavedProfile(user.id)');
  const storageAt = codeOnly.indexOf('const hasStored =');
  assert.ok(mountAt > -1 && awaitAt > -1 && storageAt > -1);
  assert.ok(mountAt < awaitAt, 'the session email must be applied before the async profile load');
  assert.ok(mountAt < storageAt, 'the session email must be applied before the profile fetch is even attempted');
  // The email field is set only from a blank value, in both writes.
  assert.match(codeOnly, /f\.email\.trim\(\) \|\| !accountEmail \? f : \{ \.\.\.f, email: accountEmail \}/);
  assert.match(codeOnly, /const email = f\.email\.trim\(\) \|\| p\?\.email\?\.trim\(\) \|\| accountEmail/);
});

/* ================================================================== *
 * 6. The required-field contract itself is untouched
 * ================================================================== */

test('EMAIL PREFILL 9: email stays required and its message is unchanged', () => {
  assert.match(codeOnly, /REQUIRED_FIELDS = \[[^\]]*'email'[^\]]*\]/,
    'email must remain a required field');
  assert.match(codeOnly, /if \(!v\) return 'Please enter your email for order updates'/,
    'the required-field message must not change');
  // No weakened validation: the format check is still there.
  assert.match(codeOnly, /return EMAIL_RE\.test\(v\) \? null : 'Enter a valid email address'/);
  // A prefilled-but-malformed value is still rejected.
  assert.equal(validateEmail('not-an-email'), 'Enter a valid email address');
});

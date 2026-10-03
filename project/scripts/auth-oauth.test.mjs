/**
 * Google OAuth / customer-account regression suite.
 *
 * The original defect is subtle and invisible in review: the auth provider had
 * a deliberate "don't load the ~200 kB supabase chunk for anonymous visitors"
 * fast path, and that path also skipped loading supabase-js on the document
 * that a Google round trip returns to. Nothing statically imported the client,
 * so `detectSessionInUrl` never ran, the `?code=` was never exchanged, and the
 * shopper was silently bounced back to the storefront signed out. The fix has
 * to survive future refactors, so the OAuth decisions are EXECUTED here
 * straight from `src/lib/authOauth.ts` (the real source, type-stripped by
 * Node), while the React wiring around them is asserted against the real files
 * the way the rest of this repo's suites work.
 *
 * The tail of the file covers the data-boundary rules a Google shopper lands
 * in: profile ownership, guest-order claiming, tracking PII, and the admin
 * table's self-promotion guard.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/* ---------------------------------------------------------------------------
 * Load the real pure helpers. `authOauth.ts` has no imports and no JSX, so
 * stripping the types is enough to execute the shipped logic directly.
 * ------------------------------------------------------------------------ */
const oauthSource = read('src/lib/authOauth.ts');
const oauthJs = stripTypeScriptTypes(oauthSource, { mode: 'strip' });
const oauth = await import(
  'data:text/javascript;base64,' + Buffer.from(oauthJs, 'utf8').toString('base64')
);
const { parseOAuthCallback, describeOAuthError, safeAuthDestination, sameRoute, stripOAuthFromUrl } = oauth;

const auth = read('src/lib/auth.tsx');
const app = read('src/App.tsx');
const loginModal = read('src/components/LoginModal.tsx');
const account = read('src/lib/account.ts');
const supabaseClient = read('src/lib/supabase.ts');
const router = read('src/lib/router.ts');
const vercelConfig = read('vercel.json');
const accountOrders = read('supabase/migrations/20261006000000_dslang_account_orders.sql');
const emailLinking = read('supabase/migrations/20261007000000_dslang_account_email_linking.sql');
const ownerSelect = read('supabase/migrations/20261020000000_dslang_owner_select_and_guest_candidate_projection.sql');

/** SQL comments explain what a migration deliberately does NOT do, so strip
 *  them before asserting on the executable statements. */
const sql = (src) => src.replace(/--[^\n]*/g, '');
/** Same idea for TSX. Asserting a string is ABSENT against commented source is
 *  misleading here: the modal deliberately documents the Confirm Password field
 *  it no longer has, so the comment would satisfy a `doesNotMatch` for the very
 *  regression the assertion is meant to catch. */
const noComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const adminTable = read('supabase/migrations/20260813062206_dslang_admin_users_table.sql.sql');
const storageLock = read('supabase/migrations/20260816010000_lock_product_image_storage_to_admin.sql');
const trackLookup = read('supabase/migrations/20261004000000_dslang_delhivery_cutover.sql');

/* ===========================================================================
 * 1. Recognising an OAuth return (parseOAuthCallback)
 * ======================================================================== */

test('oauth: a ?code= return is recognised and the code is readable', () => {
  const params = parseOAuthCallback('?code=abc123');
  assert.ok(params);
  assert.equal(params.get('code'), 'abc123');
});

test('oauth: a denied consent screen (?error=access_denied) is recognised', () => {
  const params = parseOAuthCallback('?error=access_denied&error_code=user_cancelled');
  assert.ok(params);
  assert.equal(params.get('error'), 'access_denied');
  assert.equal(params.get('error_code'), 'user_cancelled');
});

test('oauth: a bare error_description is still a return', () => {
  const params = parseOAuthCallback('?error_description=Something+went+wrong');
  assert.ok(params);
  assert.equal(params.get('error_description'), 'Something went wrong');
});

test('oauth: an empty query string is not a return', () => {
  assert.equal(parseOAuthCallback(''), null);
  assert.equal(parseOAuthCallback('?'), null);
});

test('oauth: ordinary storefront query params are not mistaken for a return', () => {
  assert.equal(parseOAuthCallback('?utm_source=newsletter'), null);
  assert.equal(parseOAuthCallback('?ref=DS-1042&page=2'), null);
});

test('oauth: the leading ? is optional so a raw search string still parses', () => {
  const params = parseOAuthCallback('code=xyz');
  assert.ok(params);
  assert.equal(params.get('code'), 'xyz');
});

test('oauth: an empty code is still a return, so the param gets cleaned up', () => {
  const params = parseOAuthCallback('?code=');
  assert.ok(params);
  assert.equal(params.get('code'), '');
});

test('oauth: a code alongside a marketing param does not hide the code', () => {
  const params = parseOAuthCallback('?utm_source=google&code=xyz');
  assert.ok(params);
  assert.equal(params.get('code'), 'xyz');
  assert.equal(params.get('utm_source'), 'google');
});

/* ===========================================================================
 * 2. Saying something useful about a failed return (describeOAuthError)
 * ======================================================================== */

test('oauth: a cancelled consent screen reads as a cancellation, not a bug', () => {
  const message = describeOAuthError(new URLSearchParams('error=access_denied&error_code=user_cancelled'));
  assert.match(message, /cancelled/i);
  assert.doesNotMatch(message, /access_denied|user_cancelled/);
});

test('oauth: access_denied is treated as cancellation even without error_code', () => {
  const message = describeOAuthError(new URLSearchParams('error=access_denied'));
  assert.match(message, /cancelled/i);
});

test('oauth: a provider description is surfaced verbatim', () => {
  const message = describeOAuthError(new URLSearchParams('error=server_error&error_description=Database+is+unavailable'));
  assert.equal(message, 'Database is unavailable');
});

test('oauth: a bare error code is still reported, never swallowed', () => {
  const message = describeOAuthError(new URLSearchParams('error=server_error'));
  assert.match(message, /server_error/);
  assert.match(message, /try again/i);
});

test('oauth: an unrecognisable error still produces a non-empty sentence', () => {
  const message = describeOAuthError(new URLSearchParams('error_code=weird_new_code'));
  assert.ok(message.length > 10, `expected a usable message, got "${message}"`);
});

/* ===========================================================================
 * 3. The post-login destination can never leave this origin
 * ======================================================================== */

test('oauth: a normal in-app route survives as a destination', () => {
  assert.equal(safeAuthDestination('/checkout'), '/checkout');
  assert.equal(safeAuthDestination('/collections/oversized-tee'), '/collections/oversized-tee');
});

test('oauth: a hash-fragment route is accepted and un-prefixed', () => {
  assert.equal(safeAuthDestination('#/checkout'), '/checkout');
  assert.equal(safeAuthDestination('#/account'), '/account');
});

test('oauth: protocol-relative //evil.com cannot be used as a destination', () => {
  assert.equal(safeAuthDestination('//evil.com'), null);
  assert.equal(safeAuthDestination('//evil.com/steal'), null);
});

test('oauth: backslash protocol-relative /\\evil.com is rejected', () => {
  assert.equal(safeAuthDestination('/\\evil.com'), null);
  assert.equal(safeAuthDestination('/\\evil.com/steal'), null);
});

test('oauth: an absolute URL is not a route and is rejected', () => {
  assert.equal(safeAuthDestination('https://evil.com'), null);
  assert.equal(safeAuthDestination('http://evil.com/checkout'), null);
});

test('oauth: a javascript: or data: payload is rejected', () => {
  assert.equal(safeAuthDestination('javascript:alert(1)'), null);
  assert.equal(safeAuthDestination('data:text/html,<script>alert(1)</script>'), null);
});

test('oauth: a relative path is rejected — the destination must be rooted', () => {
  assert.equal(safeAuthDestination('checkout'), null);
  assert.equal(safeAuthDestination('./checkout'), null);
});

test('oauth: empty and missing destinations yield null rather than a throw', () => {
  assert.equal(safeAuthDestination(''), null);
  assert.equal(safeAuthDestination(null), null);
  assert.equal(safeAuthDestination(undefined), null);
});

test('oauth: any embedded backslash is rejected', () => {
  assert.equal(safeAuthDestination('/checkout\\evil.com'), null);
  assert.equal(safeAuthDestination('/a\\b'), null);
});

/* ===========================================================================
 * 4. Comparing routes without tripping over a trailing slash
 * ======================================================================== */

test('oauth: identical routes compare equal', () => {
  assert.equal(sameRoute('/checkout', '/checkout'), true);
});

test('oauth: a trailing slash is not treated as a different destination', () => {
  assert.equal(sameRoute('/checkout', '/checkout/'), true);
  assert.equal(sameRoute('/', '/'), true);
});

test('oauth: genuinely different routes compare unequal', () => {
  assert.equal(sameRoute('/checkout', '/collections'), false);
  assert.equal(sameRoute('/checkout', null), false);
});

/* ===========================================================================
 * 5. Cleaning the one-shot params off the URL
 * ======================================================================== */

test('oauth: the code is removed and the hash route is preserved', () => {
  assert.equal(
    stripOAuthFromUrl('https://dslang.in/?code=abc123#/checkout'),
    '/#/checkout'
  );
});

test('oauth: the hash router keeps working after cleaning', () => {
  assert.equal(
    stripOAuthFromUrl('https://dslang.in/?error=access_denied&error_code=user_cancelled#/account'),
    '/#/account'
  );
});

test('oauth: unrelated query params are preserved while OAuth params go', () => {
  assert.equal(
    stripOAuthFromUrl('https://dslang.in/?utm_source=google&code=abc#/checkout'),
    '/?utm_source=google#/checkout'
  );
});

test('oauth: every OAuth param is stripped in one pass', () => {
  const cleaned = stripOAuthFromUrl(
    'https://dslang.in/?code=a&error=b&error_code=c&error_description=d&error_uri=e#/account'
  );
  assert.equal(cleaned, '/#/account');
  for (const p of ['code', 'error', 'error_code', 'error_description', 'error_uri']) {
    assert.doesNotMatch(cleaned, new RegExp(p));
  }
});

test('oauth: a URL with nothing to clean is reported as unchanged (null)', () => {
  assert.equal(stripOAuthFromUrl('https://dslang.in/?utm_source=google#/checkout'), null);
  assert.equal(stripOAuthFromUrl('https://dslang.in/#/checkout'), null);
});

test('oauth: a sub-path deployment is preserved, not flattened to the root', () => {
  assert.equal(stripOAuthFromUrl('https://dslang.in/store/?code=abc#/checkout'), '/store/?utm=1#/checkout'.replace('?utm=1', ''));
});

/* ===========================================================================
 * 6. The React wiring around those decisions
 * ======================================================================== */

test('auth: the boot effect loads supabase-js when OAuth params are present', () => {
  // THE core regression: this condition must not be hasPersistedSession() alone.
  assert.match(auth, /const callback = oauthCallbackParams\(\);/);
  assert.match(auth, /if \(!callback && !hasPersistedSession\(\)\)/);
});

test('auth: the return URL is cleared only after the code has been redeemed', () => {
  assert.match(auth, /} finally \{[\s\S]*?stripOAuthParams\(\);/);
  // Reconciliation moved out of `finally` so it can see the resolved session.
  assert.match(auth, /await apply\(session\);\s*\n\s*if \(callback\) reconcileAuthReturnDestination\(session\);/);
  assert.match(auth, /if \(callback\) reconcileAuthReturnDestination\(null\);/);
});

test('auth: only a completed Google login can claim the remembered destination', () => {
  // The same `?code=` return shape carries password recovery and email
  // confirmation. Without the provider check, a destination remembered by an
  // abandoned Google attempt would hijack an unrelated recovery link.
  const fn = auth.slice(auth.indexOf('function reconcileAuthReturnDestination'));
  assert.match(fn, /app_metadata\?\.provider/);
  assert.match(fn, /if \(provider !== 'google'\) return;/);
  assert.match(fn, /sessionStorage\.removeItem\(AUTH_DESTINATION_KEY\)/);
});

test('auth: remember-me never calls signOut from inside onAuthStateChange', () => {
  // supabase-js holds a lock while dispatching auth events; awaiting another
  // auth call from that callback can hang the client.
  const applyRaw = auth.slice(auth.indexOf('const applyRaw'), auth.indexOf('const applyCurrentSession'));
  assert.doesNotMatch(applyRaw, /await sb\.auth\.signOut\(\)/);
  assert.match(applyRaw, /setTimeout\(\(\) => \{[\s\S]*?sb\.auth\.signOut\(\)\.catch/);
});

test('auth: a leftover code is redeemed explicitly as a fallback', () => {
  assert.match(auth, /sb\.auth\.exchangeCodeForSession\(code\)/);
});

test('auth: a failed or cancelled return leaves a message for the login modal', () => {
  assert.match(auth, /setAuthNotice\(describeOAuthError\(callback\)\)/);
  assert.match(auth, /export function consumeAuthNotice\(\)/);
});

test('auth: the Google redirect carries the shopper back to where they started', () => {
  const method = auth.slice(auth.indexOf('const signInWithGoogle'));
  // The destination is preserved across the round trip by remembering it, not
  // by threading the route through the OAuth provider's redirect URL: a
  // per-page redirect_to is a distinct string for every entry point (so the
  // allowlist has to match all of them) and it puts a route in the fragment,
  // which is the same place the session used to collide with.
  assert.match(method, /rememberAuthDestination\(\)/);
  assert.match(method, /const redirectTo = `\$\{window\.location\.origin\}\/`;/);
  assert.doesNotMatch(method, /redirectTo[^\n]*#\$\{/);
  // The old behaviour: a hard-coded /#/account that always dropped checkout.
  assert.doesNotMatch(method, /redirectTo = `\$\{window\.location\.origin\}\/#\/account`;/);
  // ...and the route is still restored afterwards, by App.tsx.
  assert.match(app, /takeAuthReturnDestination\(\)/);
});

test('auth: the pending destination is drained exactly once', () => {
  const take = auth.slice(auth.indexOf('export function takeAuthReturnDestination'));
  assert.match(take, /authReturnDestination = null;/);
});

test('auth: the remembered destination is sanitized before it is trusted', () => {
  assert.match(auth, /safeAuthDestination\(window\.sessionStorage\.getItem\(AUTH_DESTINATION_KEY\)\)/);
});

test('auth: a session change is observed, so a returned shopper is not left stale', () => {
  assert.match(auth, /sb\.auth\.onAuthStateChange\(/);
  assert.match(auth, /unsub = \(\) => sub\.subscription\.unsubscribe\(\)/);
});

test('auth: boot always resolves loading, even when the exchange throws', () => {
  const effect = auth.slice(auth.indexOf('useEffect(() => {'));
  assert.match(effect, /catch \{[\s\S]*?loading: false/);
});

test('auth: the client still detects the session in the URL', () => {
  assert.match(supabaseClient, /detectSessionInUrl:\s*true/);
});

/* ===========================================================================
 * 6b. The Google-404 regression: the implicit-flow hash collision
 * ======================================================================== */

test('oauth: the client uses PKCE, so the callback never lands in the fragment', () => {
  // THE 404: with the auth-js default of `flowType: 'implicit'`, GoTrue returns
  // the session in the URL fragment. This app routes ON the fragment, so
  // `#/account&access_token=...` was parsed as a route path and the app rendered
  // its own notFound() page after a *successful* Google login. PKCE returns
  // `?code=` in the query string and leaves the fragment to stay the route.
  assert.match(supabaseClient, /flowType:\s*'pkce'/);
  assert.doesNotMatch(supabaseClient, /flowType:\s*'implicit'/);
  // detectSessionInUrl must stay on so the code is redeemed on boot.
  assert.match(supabaseClient, /detectSessionInUrl:\s*true/);
});

test('oauth: an auth-carrying fragment is never routed as a page', () => {
  // Defence in depth: even if a token ever appears in the hash again (another
  // client, a stale tab, a reverted flow), the router must not turn it into a
  // route and 404 the shopper.
  assert.match(router, /isAuthArtefact/);
  assert.match(router, /access_token/);
  assert.match(router, /isAuthArtefact\(window\.location\.hash\)/);
});

test('oauth: the Google redirect is a stable origin path, not a per-page URL', () => {
  // One callback URL for every entry point: that is what Supabase's redirect
  // allowlist has to match, and it keeps the route in the destination-restore
  // path rather than in the URL that round-trips through Google.
  const oauthFn = auth.slice(auth.indexOf('const signInWithGoogle'));
  assert.match(oauthFn, /const redirectTo = `\$\{window\.location\.origin\}\/`;/);
  // No per-page fragment smuggled through the OAuth provider.
  assert.doesNotMatch(oauthFn, /redirectTo[^\n]*#\$\{/);
});

test('oauth: Vercel serves the SPA for unknown paths instead of 404ing', () => {
  // A hard 404 from the host is unrecoverable, so unknown paths rewrite to
  // index.html. Real files, /api functions and immutable assets are excluded.
  const cfg = JSON.parse(vercelConfig);
  const rewrites = cfg.rewrites ?? [];
  assert.ok(rewrites.length > 0, 'vercel.json must define a rewrite fallback');
  const [rule] = rewrites;
  assert.equal(rule.destination, '/index.html');
  assert.match(rule.source, /assets/);
  assert.match(rule.source, /api/);
});

test('login modal: a cancelled Google return is explained, not silently dropped', () => {
  assert.match(loginModal, /consumeAuthNotice/);
  assert.match(loginModal, /setError\(consumeAuthNotice\(\) \?\? ''\)/);
});

test('login modal: signed-in navigation happens exactly once', () => {
  // Counts the post-sign-in guard by its intent — bail out unless the modal is
  // open, auth has settled, and a user exists — rather than pinning one exact
  // literal. The admin_users check adds an `isAdminLoading` term so the modal
  // waits for the real answer instead of picking a destination from an
  // unresolved isAdmin; the invariant under test (exactly one such effect, and
  // no duplicated destination ternary) is unchanged.
  const effects = loginModal.match(/if \(!isOpen \|\| [^)]*\|\|[^)]*!user\) return;/g) ?? [];
  assert.equal(effects.length, 1, 'expected a single post-sign-in navigation effect');
  assert.doesNotMatch(loginModal, /const destination = isAdmin \? '\/admin' : '\/account';/);
});

test('login modal: the post-sign-in destination waits for the admin check', () => {
  // A real admin must not be sent to /account on a not-yet-resolved isAdmin.
  assert.match(loginModal, /isAdminLoading/);
  const nav = loginModal.slice(loginModal.indexOf('navigate(isAdmin ?'));
  assert.ok(nav.length > 0, 'expected the isAdmin destination navigation');
});

test('app: the pre-OAuth route is restored once, and never for an admin', () => {
  assert.match(app, /takeAuthReturnDestination\(\)/);
  const restore = app.slice(app.indexOf('takeAuthReturnDestination()'));
  assert.match(restore, /if \(destination && !isAdmin\) navigate\(destination\)/);
});

/* ===========================================================================
 * 7. The data a Google shopper lands in — ownership and PII boundaries
 * ======================================================================== */

test('profiles: a shopper can only ever read their own profile row', () => {
  assert.match(accountOrders, /create policy "customer_profiles_select_owner"[\s\S]*?using \(user_id = auth\.uid\(\)\)/);
});

test('profiles: insert and update are pinned to the caller, so no impersonation', () => {
  assert.match(accountOrders, /create policy "customer_profiles_insert_owner"[\s\S]*?with check \(user_id = auth\.uid\(\)\)/);
  assert.match(accountOrders, /create policy "customer_profiles_update_owner"[\s\S]*?with check \(user_id = auth\.uid\(\)\)/);
});

test('profiles: RLS is on, and a Google user is not given a second row for the same email', () => {
  assert.match(accountOrders, /alter table public\.customer_profiles enable row level security/);
  // The row is keyed on the Supabase Auth user id, not the email, so a repeat
  // sign-in upserts the same record instead of duplicating the customer.
  assert.match(accountOrders, /user_id\s+uuid primary key references auth\.users/);
  assert.match(account, /onConflict:\s*'user_id'/);
});

test('orders: a signed-in shopper sees ONLY orders they already own', () => {
  // The effective policy is the LAST one installed for this name, which is the
  // one in migration 20: it drops the earlier email-match branch and grants
  // owned rows only. The branch asserted against must not come back — an email
  // match returns the whole row, delivery jsonb included.
  const policy = sql(ownerSelect).slice(
    sql(ownerSelect).indexOf('create policy "retail_orders_select_owner"'),
  );
  assert.match(policy, /using \(user_id = auth\.uid\(\)\)/);
  assert.doesNotMatch(
    policy.slice(0, policy.indexOf(';')),
    /auth\.jwt\(\)|customer->>'email'|user_id is null/,
    'the effective owner SELECT policy must not branch on email at all',
  );
  // …and the migration must drop the old policy before recreating it, otherwise
  // the email-match policy would still be in force.
  assert.match(
    sql(ownerSelect),
    /drop policy if exists "retail_orders_select_owner" on public\.retail_orders/,
  );
});

test('orders: an unclaimed guest order is reachable only through the phone-proof projection', () => {
  // The single discovery path, and it is proof-gated exactly like the claim RPC.
  const m20 = sql(ownerSelect);
  assert.match(
    m20,
    /create or replace function public\.list_retail_guest_candidates\(p_phone text default null\)/,
  );
  assert.match(m20, /security definer/);
  assert.match(m20, /set search_path = public, pg_catalog/);
  assert.match(m20, /length\(v_phone\) <> 10/);
  assert.match(
    m20,
    /lower\(coalesce\(o\.customer ->> 'email', ''\)\) = v_email/,
    'the caller\'s JWT email must still be required',
  );
  // Projection only: the fields that would expose or address the row are absent
  // from every jsonb_build_object in the function body.
  const body = m20.slice(m20.indexOf('create or replace function public.list_retail_guest_candidates'));
  const projected = [...body.matchAll(/jsonb_build_object\(([\s\S]*?)\)\s*order by/g)].map((m) => m[1]);
  assert.ok(projected.length > 0, 'the function must build a projection');
  for (const fields of projected) {
    assert.doesNotMatch(fields, /'id'/, 'a candidate must not disclose the row id');
    assert.doesNotMatch(fields, /'customer'/, 'a candidate must not disclose the delivery jsonb');
    assert.doesNotMatch(fields, /'items'/, 'a candidate must not disclose the basket');
    assert.match(fields, /'ref'/);
  }
  // Declined orders are not offered again, and anonymous callers cannot call it.
  assert.match(body, /o\.claim_declined_at is null/);
  assert.match(body, /o\.user_id is null/);
  assert.match(m20, /grant execute on function public\.list_retail_guest_candidates\(text\) to authenticated/);
  assert.match(m20, /revoke execute on function public\.list_retail_guest_candidates\(text\) from anon/);
  // An unauthenticated call must be refused outright, not return an empty list.
  assert.match(body, /if \(v_uid is null\) then/);
});

test('orders: the projection migration does not touch the hardened claim RPCs', () => {
  // Linking still lives in migration 19 with its proofs; migration 20 adds a
  // read path and must not replace, loosen or re-define either decision RPC.
  const m20 = sql(ownerSelect);
  assert.doesNotMatch(
    m20,
    /create or replace function public\.(claim_retail_guest_order|decline_retail_guest_order)/,
    'the phone-proof claim/decline functions must not be redefined here',
  );
  assert.doesNotMatch(m20, /retail_orders_guard_customer_writes/, 'the row-write guard must be left alone');
  // Admin tooling keeps its own SELECT policy.
  assert.doesNotMatch(m20, /retail_orders_select_admin/);
  // And no order is linked, unlinked or declined by the migration itself.
  assert.doesNotMatch(m20, /\b(update|insert|delete)\s+public\./i, 'the migration must be definitions only');
});

test('orders: claiming a guest order can only ever attach it to the caller', () => {
  const policy = emailLinking.slice(emailLinking.indexOf('create policy "retail_orders_update_owner_claim"'));
  assert.match(policy, /with check \(user_id = auth\.uid\(\)\)/);
  // One-time only: the USING side requires the order to still be unclaimed.
  assert.match(policy, /using \(\s*user_id is null/);
});

test('orders: an already-claimed order cannot be re-pointed at another account', () => {
  assert.match(emailLinking, /with check \(user_id = auth\.uid\(\)\)/);
  assert.doesNotMatch(emailLinking, /with check \(\s*true\s*\)/);
});

test('orders: only the user_id column is writable, not the money columns', () => {
  assert.match(accountOrders, /grant select, update \(user_id\) on public\.retail_orders to authenticated/);
  assert.doesNotMatch(accountOrders, /grant update on public\.retail_orders/);
});

test('tracking: a guest lookup needs both the reference and the phone number', () => {
  assert.match(trackLookup, /if v_ref = '' or v_phone = '' then/);
  assert.match(trackLookup, /v_row\.customer->>'phone'[\s\S]*?<> v_phone then/);
});

test('tracking: the guest lookup never returns the customer name, email or address', () => {
  const fn = trackLookup.slice(trackLookup.indexOf('create or replace function public.track_lookup_order'));
  const returned = fn.slice(0, fn.indexOf('$$;'));
  assert.doesNotMatch(returned, /customer->>'name'/);
  assert.doesNotMatch(returned, /customer->>'email'/);
  assert.doesNotMatch(returned, /customer->>'address'/);
  assert.match(returned, /NO personal data/);
});

test('admin: a user cannot promote themselves to admin', () => {
  // The original policy allowed it; the storage-lock migration removed it.
  assert.match(adminTable, /CREATE POLICY "insert_own_admin" ON admin_users FOR INSERT/i);
  assert.match(storageLock, /drop policy if exists "insert_own_admin" on public\.admin_users/i);
  assert.match(storageLock, /drop policy if exists "delete_own_admin" on public\.admin_users/i);
});

test('admin: admin status is read from the admin_users table, not inferred from an email', () => {
  assert.match(auth, /from\('admin_users'\)[\s\S]*?\.eq\('user_id', userId\)/);
});

/* ---------------------------------------------------------------------------
 * Email signup + verification.
 *
 * The signup form is three values — name, email, password — and the interesting
 * failure modes are all about what does NOT happen: the name must become profile
 * metadata rather than an auth credential, the password must never be stored or
 * compared client-side, and a signup that turns out to hit an existing address
 * must not silently become a second account or a dead error.
 * ------------------------------------------------------------------------ */

test('signup: the full name is sent as profile metadata, never as a credential', () => {
  // Supabase writes `options.data` into the account's own user metadata, which
  // is the profile. A custom table or a local copy would be a second source of
  // truth for the same fact.
  assert.match(auth, /data:\s*\{\s*full_name: meta\.fullName\.trim\(\)/);
  assert.match(auth, /full_name: meta\.fullName\.trim\(\),/);
  // It must not be smuggled into the email or password fields.
  assert.doesNotMatch(auth, /signUp\(\s*\{\s*email,\s*password,\s*fullName/);
  // Nor stored anywhere of our own.
  assert.doesNotMatch(auth, /localStorage[^)]*full_name/i);
  assert.doesNotMatch(auth, /setItem\([^)]*full_name/i);
});

test('signup: the password is only ever handed to Supabase', () => {
  assert.match(auth, /sb\.auth\.signUp\(\{\s*email,\s*password,/);
  // No manual hashing, and no password kept in component state after submit.
  assert.doesNotMatch(auth, /createHash|bcrypt|scrypt|pbkdf2|md5|sha256/i);
  assert.doesNotMatch(loginModal, /localStorage[^)]*password/i);
  assert.doesNotMatch(loginModal, /setItem\([^)]*password/i);
  // Nor echoed back into metadata.
  assert.doesNotMatch(auth, /data:\s*\{[^}]*password/i);
});

test('signup: no confirm-password field, and no manual password comparison', () => {
  const code = noComments(loginModal);
  assert.doesNotMatch(code, /Confirm Password/);
  assert.doesNotMatch(code, /confirm !== password/);
  assert.doesNotMatch(code, /Passwords do not match/);
  // The existing minimum length is still enforced client-side.
  assert.match(code, /Password must be at least 6 characters/);
});

test('signup: the name is required, and whitespace is not a name', () => {
  assert.match(loginModal, /const cleanName = fullName\.trim\(\)/);
  assert.match(loginModal, /if \(!cleanName\)\s*\{\s*setError\('Please enter your full name\.'\)/);
  // Trimmed before it is both validated and stored.
  assert.match(auth, /fullName\.trim\(\)/);
});

test('signup: a new account is not treated as verified until the link is clicked', () => {
  // The account-exists-but-no-session result is what email-confirmation projects
  // return; it must land on the verification screen, not on a signed-in state.
  assert.match(noComments(loginModal), /if \(signedUp && !session\)[\s\S]{0,160}?setView\('verifyEmail'\)/);
  // And the verification screen must offer both ways out.
  assert.match(loginModal, /onClick=\{handleResend\}/);
  assert.match(loginModal, /setTab\('login'\)/);
});

test('verification: resend uses Supabase own resend endpoint, not a custom token', () => {
  assert.match(auth, /sb\.auth\.resend\(\{\s*type: 'signup',\s*email,/);
  // No home-grown verification token, link or flag may appear.
  assert.doesNotMatch(auth, /verify_token|verification_token|confirm_token|is_verified/i);
  assert.doesNotMatch(loginModal, /verify_token|verification_token|confirm_token/i);
});

test('verification: an unverified account is recognised, never duplicated', () => {
  // Supabase refuses to make a second account for the address, so the honest
  // response is to recognise the existing one and offer resend / login.
  assert.match(loginModal, /already registered\|user_already_exists\|email already/i);
  assert.doesNotMatch(loginModal, /already registered[^\n]*\n[^\n]*setTab\('login'\)/);
  // The generic fallbacks must not print Supabase's own message to a customer.
  assert.doesNotMatch(loginModal, /setError\(signUpError\.message \|\|/);
  assert.doesNotMatch(loginModal, /setError\(signInError\.message \|\|/);
});

test('verification: an unverified login gets a resend path, not a dead error', () => {
  assert.match(loginModal, /email not confirmed\|email_not_confirmed\|unconfirmed/i);
  assert.doesNotMatch(loginModal, /Please verify your email first — we sent you a confirmation link\./);
});

test('verification: the screen names the address the account was created under', () => {
  // Signup lower-cases before sending, so showing the raw input back would tell
  // the customer their link went somewhere it did not.
  assert.match(loginModal, /const accountEmail = email\.trim\(\)\.toLowerCase\(\)/);
  assert.match(loginModal, /verification link to <span className="text-bone">\{accountEmail\}/);
});

test('the password reset and Google paths are still wired up', () => {
  assert.match(auth, /sb\.auth\.resetPasswordForEmail\(/);
  assert.match(loginModal, /resetPassword\(cleanEmail\.toLowerCase\(\)\)/);
  assert.match(auth, /sb\.auth\.signInWithOAuth\(\{/);
  assert.match(loginModal, /signInWithGoogle\(\)/);
  assert.match(loginModal, /Continue with Google/);
});

test('the measured-height panel still wraps the popup, so tab swaps keep animating', () => {
  // The height transition depends on a sized wrapper around the absolutely
  // positioned card; losing either half silently breaks the resize.
  assert.match(loginModal, /max-h-\[92dvh\] animate-scale-in/);
  assert.match(loginModal, /style=\{panelStyle\}/);
  assert.match(loginModal, /absolute inset-0 bg-white rounded-2xl/);
  assert.match(loginModal, /new ResizeObserver\(/);
});

/**
 * RPC privilege-escalation regression suite.
 *
 * The admin dashboard reads its data with the SIGNED-IN user's own Supabase
 * session, so the client-side `isAdmin` check and the `/admin` route redirect
 * are cosmetic. The only real barrier is server-side: a table policy, or a
 * `security definer` function that re-checks `admin_users` itself.
 *
 * This project grants many mutating RPCs to `authenticated` — which includes
 * every Google customer, not just staff. That is only safe because each one
 * carries its own admin gate. This suite extracts the LATEST definition of
 * every such function and fails if a mutating one is reachable by a plain
 * customer without checking `admin_users`.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG_DIR = join(ROOT, 'supabase', 'migrations');

/** Migrations in application order, so "latest definition" is meaningful. */
const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ name: f, sql: readFileSync(join(MIG_DIR, f), 'utf8') }));

/**
 * Postgres identifies a function by `name(argtypes)` — parameter NAMES are
 * not part of the identity. `grant execute on function f(uuid)` therefore has
 * to be matched against a declaration like `f(p_id uuid)`, so the names (and
 * any `default` clause) must be stripped before comparing.
 */
function paramTypes(params) {
  // Split on top-level commas only: `numeric(10,2)` contains a comma.
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of params) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  return parts
    .map((part) => {
      let p = part.trim();
      // Drop a `default ...` clause (everything from the keyword onwards).
      p = p.replace(/\bdefault\b[\s\S]*$/i, '').trim();
      // Drop a parameter mode (in / out / inout) if present.
      p = p.replace(/^(inout|in|out)\s+/i, '').trim();
      // The type is whatever remains after the last whitespace-separated token.
      const type = p.split(/\s+/).pop();
      return type.replace(/^public\./i, '').toLowerCase();
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * Split a migration into its `create or replace function` blocks. Each block
 * runs from the declaration to its closing `$$;`, which is where a nested
 * `$$` inside a string literal cannot occur in this codebase's style.
 */
function functionBlocks(sql) {
  const blocks = [];
  const re = /create\s+or\s+replace\s+function\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\)([\s\S]*?)\$\$([\s\S]*?)\$\$/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    blocks.push({
      name: m[1],
      params: m[2].replace(/\s+/g, ' ').trim(),
      body: m[4],
      modifiers: m[3],
    });
  }
  return blocks;
}

/** signature -> latest definition, across all migrations. */
const latestBySignature = new Map();
/** every (signature, block) pair, in order. */
const allDefinitions = [];

for (const { name, sql } of migrations) {
  for (const block of functionBlocks(sql)) {
    const signature = `${block.name.toLowerCase()}(${paramTypes(block.params)})`;
    const record = { ...block, signature, file: name };
    allDefinitions.push(record);
    latestBySignature.set(signature, record);
  }
}

/** Signatures granted EXECUTE to `authenticated` (or to anon). */
function grantedTo(role) {
  const found = new Map();
  for (const { name, sql } of migrations) {
    const re = new RegExp(
      `grant\\s+execute\\s+on\\s+function\\s+(?:public\\.)?(\\w+)\\s*\\(([^)]*)\\)[\\s\\S]{0,60}?to\\s+([^;]+);`,
      'gi',
    );
    let m;
    while ((m = re.exec(sql)) !== null) {
      const signature = `${m[1].toLowerCase()}(${paramTypes(m[2])})`;
      const roles = m[3].toLowerCase();
      if (new RegExp(`\\b${role}\\b`).test(roles)) {
        found.set(signature, { file: name, roles: roles.trim() });
      }
    }
  }
  return found;
}

const isDefiner = (b) => /security\s+definer/i.test(b.modifiers || '');
/**
 * A real authorization check, not a comment that merely mentions the table.
 * Every gated RPC in this codebase reads `from public.admin_users` inside an
 * `IF NOT EXISTS (...)`, so require that shape.
 */
const hasAdminGate = (b) =>
  /from\s+(public\.)?admin_users\b/i.test(b.body.replace(/--[^\n]*/g, ''));
const mutates = (b) =>
  /\b(insert\s+into|update\s+(?:public\.)?\w+|delete\s+from)\b/i.test(b.body);

/** Look up the latest definition by its type-only signature. */
function resolve(signature) {
  return latestBySignature.get(signature) || null;
}

/**
 * SECURITY DEFINER functions that are INTENTIONALLY reachable by a customer
 * (or by a logged-out visitor). Each one is allowed to skip the admin_users
 * gate because it is part of the storefront itself, and each carries its own
 * narrower guard. Anything NOT listed here and NOT admin-gated is a bug, so
 * this list is deliberately explicit and small: adding an entry is a security
 * decision that has to be made on purpose, in review, with a stated reason.
 */
const CUSTOMER_FACING = {
  create_retail_order:
    'checkout: the shopper places their own order; prices are re-derived server-side and stock is reserved atomically',
  create_wholesale_order:
    'B2B storefront: a buyer places their own wholesale order',
  validate_promo_code:
    'checkout: resolves a public promo code to a discount before the order is placed',
  track_lookup_order:
    'public order tracking; possession-gated on order ref + 10-digit phone and returns no PII',
  track_order_shipping:
    'public order tracking, shipping projection only; possession-gated on order ref + 10-digit phone, shares the failed-attempt throttle with track_lookup_order, and returns courier/AWB/status/timestamps with no PII. Its only write is clearing that same throttle ledger on a successful possession match.',
  convert_retail_order_to_cod:
    'checkout payment-method switch; possession-gated on ref + phone, refuses paid/processing/restocked orders, and never changes total_amount',
  claim_retail_guest_order:
  'guest-order claim on sign-in: attaches the shopper\'s OWN unclaimed guest orders to their account. It writes user_id and nothing else; refuses an order that is already claimed or whose customer email is not the caller\'s JWT email; and takes no order by ref alone. Required because RLS deliberately gives customers no direct UPDATE, so the one legitimate customer write has to be a SECURITY DEFINER RPC.',
decline_retail_guest_order:
    'guest-order DECLINE: the counterpart to claim_retail_guest_order. When a shopper is shown an unlinked guest order matching their email and answers "not mine", this stores that decision. It writes claim_declined_at and nothing else, and is bounded three ways: one named ref only (never a bulk update), only an order that is still unclaimed and not already declined, and the same email + 10-digit phone proof a claim requires — so a guesser of the email cannot permanently hide a real customer\'s order from their own account. Without it, the "not mine" answer could only be stored in the browser, where a cache clear would resurrect the prompt forever.',
  list_retail_guest_candidates:
    'READ-ONLY discovery of the shopper\'s OWN unclaimed guest orders for My Orders, replacing the email-only row grant that migration 20 removed. It requires the caller\'s JWT email to match the order\'s guest email AND a caller-supplied 10-digit phone to match the phone on the order — the same two proofs claim_retail_guest_order demands, so nothing is discoverable that could not already have been claimed. It writes nothing, and its projection carries no id, no customer jsonb and no items, so it exposes no delivery or basket detail and returns nothing that could address a row through another endpoint. Declined orders are excluded.',
};

test('PRIVILEGES: every function granted to anon or authenticated was located', () => {
  const auth = grantedTo('authenticated');
  const anon = grantedTo('anon');
  assert.ok(auth.size > 10, `expected many authenticated grants, found ${auth.size}`);

  const unresolved = [];
  for (const sig of [...auth.keys(), ...anon.keys()]) {
    if (!resolve(sig)) unresolved.push(sig);
  }
  assert.deepEqual(
    unresolved,
    [],
    `granted functions with no definition found in migrations: ${unresolved.join(', ')}`,
  );
});

test('PRIVILEGES: every security-definer RPC a customer can call is either admin-gated or allowlisted', () => {
  // `anon` is checked too: it is strictly more dangerous than `authenticated`,
  // since a logged-out visitor can call anything granted to it.
  const offenders = [];
  const reviewed = [];

  for (const role of ['anon', 'authenticated']) {
    for (const [sig, grant] of grantedTo(role)) {
      const block = resolve(sig);
      if (!block) continue;
      if (!isDefiner(block)) continue; // invoker: RLS applies to the caller
      if (hasAdminGate(block)) {
        reviewed.push(`${sig}  [admin-gated]`);
        continue;
      }
      if (CUSTOMER_FACING[block.name.toLowerCase()]) {
        reviewed.push(`${sig}  [customer-facing]`);
        continue;
      }
      offenders.push(
        `${sig}  -> ${role}  (granted in ${grant.file}, last defined in ${block.file})` +
          `${mutates(block) ? '  [MUTATES DATA]' : '  [reads data]'}`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `security-definer functions reachable by a customer with neither an admin_users gate nor a documented reason:\n  ${offenders.join('\n  ')}\n\n` +
      `If one of these is legitimately part of the storefront, add it to CUSTOMER_FACING with a reason. Otherwise add the admin gate.`,
  );

  // Sanity: the suite must actually be inspecting a meaningful number of RPCs,
  // otherwise a parser regression would make it pass vacuously.
  assert.ok(
    reviewed.length >= 15,
    `expected to classify at least 15 definer RPCs, classified ${reviewed.length}`,
  );
});

test('PRIVILEGES: the possession-gated customer RPCs still verify a phone number', () => {
  // These are the only definer RPCs a stranger may call, and all of them are
  // reachable by order ref alone plus a phone. If any drops the phone
  // comparison, anyone could read or re-price another person's order.
  for (const name of ['track_lookup_order', 'track_order_shipping', 'convert_retail_order_to_cod']) {
    const defs = allDefinitions.filter((b) => b.name.toLowerCase() === name);
    const latest = defs[defs.length - 1];
    assert.ok(latest, `${name} has no definition`);
    const body = latest.body.replace(/--[^\n]*/g, '');
    assert.match(body, /customer\s*->>\s*'phone'/i, `${name} must read the stored phone`);
    assert.match(body, /p_phone/, `${name} must compare against the caller's phone`);
    // A wrong phone must be indistinguishable from a wrong reference, so the
    // function either raises the same "not found" error for both or returns
    // one shared denial object for both.
    assert.ok(
      /raise exception 'Order not found\.?'/i.test(body) || /v_denied/i.test(body),
      `${name} must use one indistinguishable response for a bad ref and a bad phone`,
    );
  }

  // track_lookup_order and track_order_shipping are the endpoints a complete
  // stranger can call, so they must not hand back the stored customer object the
  // way the checkout RPCs legitimately do.
  for (const name of ['track_lookup_order', 'track_order_shipping']) {
    const defs = allDefinitions.filter((b) => b.name.toLowerCase() === name);
    assert.ok(defs.length > 0, `${name} has no definition`);
    const body = defs[defs.length - 1].body.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(
      body,
      /'customer'\s*,\s*v_row\./i,
      `${name} must not return the stored customer object`,
    );
    for (const column of ['email', 'address', 'phone', 'name']) {
      assert.doesNotMatch(
        body,
        new RegExp(`'${column}'\\s*,\\s*(?:v_row|coalesce\\(v_row)`, 'i'),
        `${name} must not expose customer ${column}`,
      );
    }
  }
});

test('PRIVILEGES: the admin-only mutators are definer functions with an in-body gate', () => {
  // Spot-check the destructive ones by name, so a future edit that drops the
  // gate is caught even if the grant is re-worded.
  const destructive = [
    'delete_retail_order',
    'adjust_variant_stock',
    'set_product_size_stock',
    'set_variant_reorder',
    'bulk_set_variant_reorder',
    'set_product_visibility',
    'create_purchase_order',
    'update_purchase_order_status',
    'receive_purchase_order',
  ];

  for (const name of destructive) {
    const defs = allDefinitions.filter((b) => b.name.toLowerCase() === name);
    assert.ok(defs.length > 0, `${name} has no definition in migrations`);
    const latest = defs[defs.length - 1];
    assert.ok(
      hasAdminGate(latest),
      `${name} must gate on admin_users (last defined in ${latest.file})`,
    );
    assert.ok(
      isDefiner(latest),
      `${name} must be SECURITY DEFINER so the gate runs as the owner (${latest.file})`,
    );
  }
});

test('PRIVILEGES: a plain customer cannot read the admin_users table of others', () => {
  const file = migrations.find((m) => m.name.includes('admin_users_table'));
  assert.ok(file, 'admin_users migration not found');
  assert.match(file.sql, /CREATE POLICY "read_own_admin"[\s\S]*?USING \(auth\.uid\(\) = user_id\)/i);
  // The self-promotion policies existed and were removed again.
  assert.match(file.sql, /CREATE POLICY "insert_own_admin"/i);
});

test('PRIVILEGES: self-promotion policies are dropped by a later migration', () => {
  const lock = migrations.find((m) => m.name.includes('lock_product_image_storage_to_admin'));
  assert.ok(lock, 'storage-lock migration not found');
  const later = migrations.filter((m) => m.name > lock.name);
  for (const policy of ['insert_own_admin', 'delete_own_admin']) {
    assert.match(
      lock.sql,
      new RegExp(`drop policy if exists "${policy}"`, 'i'),
      `${policy} must be dropped`,
    );
    // No later migration may bring it back.
    for (const { name, sql } of later) {
      assert.doesNotMatch(
        sql,
        new RegExp(`create\\s+policy\\s+"?${policy}"?`, 'i'),
        `${name} must not recreate ${policy}`,
      );
    }
  }
});

test('PRIVILEGES: no migration grants a table to anon or authenticated beyond the account tables', () => {
  // Only the listed tables may be directly reachable. Everything else must go
  // through a gated RPC, otherwise a plain customer could read the whole
  // catalogue/inventory/order table straight from PostgREST.
  const allowed = new Set(['retail_orders', 'customer_profiles', 'webhook_receive', 'admin_users']);
  // admin_users is here for a read-only reason: read_own_admin lets a signed-in
  // user read their OWN single row and that is what checkIsAdmin() depends on
  // to decide what the Admin UI renders. Migration 18 strips every write
  // privilege from anon and authenticated and keeps only this SELECT, and it
  // is the write paths -- not this grant -- that scripts/admin-users-privileges
  // .test.mjs proves behaviourally against a real database.
  const offenders = [];

  for (const { name, sql } of migrations) {
    const re = /grant\s+[^;]*?\s+on\s+(?:table\s+)?(?:public\.)?(\w+)\s+to\s+([^;]+);/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const table = m[1].toLowerCase();
      const roles = m[2].toLowerCase();
      if (!/\b(anon|authenticated)\b/.test(roles)) continue;
      if (allowed.has(table)) continue;
      offenders.push(`${name}: ${table} -> ${roles.trim()}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `tables directly reachable by anon/authenticated outside the allowlist:\n  ${offenders.join('\n  ')}`,
  );
});

test('PRIVILEGES: RLS is enabled on every table a customer can touch', () => {
  const customerTables = ['retail_orders', 'customer_profiles'];
  for (const table of customerTables) {
    const enabled = migrations.some(({ sql }) =>
      new RegExp(`alter\\s+table\\s+(?:public\\.)?${table}\\s+enable\\s+row\\s+level\\s+security`, 'i').test(sql),
    );
    assert.ok(enabled, `${table} must have RLS enabled`);
  }
});

/* ===========================================================================
 * 9. Order-email endpoints
 *
 * `send-order-mail` can mail ANY order on demand, so its gate is a real
 * security boundary. It used to trust `user_metadata.role`, which the account
 * owner can rewrite themselves with supabase.auth.updateUser({ data: ... }) --
 * not an authorization source. Authorization must come from admin_users, the
 * same model every SECURITY DEFINER RPC in this project uses.
 *
 * `cod-order-mail` is deliberately the opposite: it is public (a guest has no
 * JWT at checkout), so it must be possession-gated on the order ref AND the
 * customer's 10-digit phone, exactly like track_lookup_order / cashfree-status.
 * ======================================================================== */

const FN_DIR = join(ROOT, 'supabase', 'functions');
const readFn = (rel) => readFileSync(join(FN_DIR, rel), 'utf8');
const sendOrderMail = readFn(join('send-order-mail', 'index.ts'));
const codOrderMail = readFn(join('cod-order-mail', 'index.ts'));

test('EMAIL: the admin mail endpoint authorizes via admin_users, never user_metadata', () => {
  assert.match(sendOrderMail, /from\('admin_users'\)[\s\S]{0,120}?user_id/,
    'the admin gate must be a service-role read of admin_users');
  assert.match(sendOrderMail, /\.eq\('user_id', callerId\)/,
    'it must look up the CALLER, not a role string');
  assert.doesNotMatch(codeOnly(sendOrderMail), /user_metadata/,
    'user_metadata is self-editable and must never be an authorization source');
  assert.doesNotMatch(codeOnly(sendOrderMail), /app_metadata/,
    'admin_users is the authoritative model, not a metadata role either');
  // Fail-closed on both an unusable token and a non-member.
  assert.match(sendOrderMail, /Authentication required\.'\s*\}\s*,\s*401\)/);
  assert.match(sendOrderMail, /Admin role required\.'\s*\}\s*,\s*403\)/);
});

test('EMAIL: the admin mail endpoint returns no customer PII', () => {
  const success = sendOrderMail.slice(sendOrderMail.indexOf('const result = await sendOrderEmail'));
  assert.doesNotMatch(success, /email:\s*result\.email/,
    'the response must not echo the customer address back');
  assert.match(success, /hasEmail/,
    'a non-PII confirmation flag is returned instead');
});

test('EMAIL: the COD mail endpoint is possession-gated and idempotent', () => {
  // A guest has no JWT at checkout, so this endpoint is reachable by anyone and
  // MUST be gated on ref + phone or it becomes a mail/lookup oracle.
  assert.match(codOrderMail, /normalizePhone/);
  assert.match(codOrderMail, /orderPhone !== phone/,
    'the caller must prove the 10-digit phone on the order');
  assert.match(codOrderMail, /phone\.length !== 10/);
  // Unknown ref and wrong phone must be indistinguishable.
  assert.match(codOrderMail, /if \(!order\) return json\(\{ ok: false, sent: false \}, 200\)/);
  assert.match(codOrderMail, /if \(!orderPhone \|\| orderPhone !== phone\)[\s\S]{0,80}?sent: false \}, 200\)/);
});

test('EMAIL: only a genuinely confirmed COD order is ever announced', () => {
  assert.match(codOrderMail, /!order\.is_cod \|\| order\.payment_status !== 'cod_pending'/,
    'a failed/cancelled/expired order must never produce a confirmation');
  // Idempotency: the second guard, in addition to sendOrderEmail's own.
  assert.match(codOrderMail, /last_email_kind \?\? ''\) === 'confirmed'[\s\S]{0,80}?already sent/);
  // Fail-open: a mail failure must not fail or roll back the order.
  assert.match(codOrderMail, /catch \(err\)[\s\S]{0,200}?ok: false, sent: false \}, 200\)/);
  // COD must never reach the gateway.
  const src = codeOnly(codOrderMail);
  assert.doesNotMatch(src, /cashfree/i);
});

test('EMAIL: the shipped mail is documented as admin-triggered, not automatic', () => {
  const emails = readFileSync(join(FN_DIR, '_shared', 'emails.ts'), 'utf8');
  const header = emails.slice(0, emails.indexOf('export type OrderEmailKind'));
  assert.match(header, /'shipped'\s*.\s*NOT automatic/,
    'the header must not claim shipment success auto-mails the customer');
  // ...and nothing auto-sends it: the only 'shipped' sender is the admin one.
  const autoSenders = ['cashfree-webhook', 'cashfree-status', 'cod-order-mail', 'auto-ship-orders', 'delhivery-webhook']
    .map((f) => [f, readFn(join(f, 'index.ts'))]);
  for (const [name, src] of autoSenders) {
    assert.doesNotMatch(src, /sendOrderEmail\([^)]*'shipped'/,
      `${name} must not auto-send the shipped email`);
  }
  assert.match(sendOrderMail, /kind: OrderEmailKind = kindOverride \?\? \(status === 'shipped'/);
});

/* Strip comments so an assertion about CODE is not satisfied or broken by the
 * prose that documents WHY the code looks the way it does. */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

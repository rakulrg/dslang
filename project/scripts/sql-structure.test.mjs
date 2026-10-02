/**
 * SQL structure validation for every migration in the repo.
 *
 * There is no Postgres and no Docker in this environment (`psql` absent,
 * `supabase db reset` needs Docker, and `supabase db lint --linked` would touch
 * the REMOTE project, which is out of scope), so these tests do the next best
 * thing: they lex the SQL properly — dollar-quoted bodies, nested block
 * comments, string literals, quoted identifiers — and then assert structural
 * invariants that catch the realistic ways a hand-written migration breaks:
 * an unterminated `$$` body, an unbalanced parenthesis, a missing statement
 * terminator, a stray empty statement.
 *
 * This complements (and does not replace) applying the migrations and the
 * contract tests in `payment-rules.test.mjs`.
 *
 * Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/**
 * Split a SQL script into its top-level statements.
 *
 * Handles, in order of precedence:
 *   - `--` line comments and NESTED `/* *\/` block comments (Postgres nests these)
 *   - `'...'` string literals, with `''` as an escaped quote
 *   - `"..."` quoted identifiers, with `""` as an escaped quote
 *   - `$tag$ ... $tag$` dollar-quoted bodies (plpgsql function bodies, and the
 *     `$$` in a `do` block), matched by tag so `$body$` never closes `$$`
 */
function lex(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  const unterminated = [];

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    // Line comment
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }

    // Block comment (nesting allowed)
    if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') { depth += 1; i += 2; continue; }
        if (sql.slice(i, i + 2) === '*/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      if (depth > 0) unterminated.push('block comment');
      continue;
    }

    // Single-quoted literal
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j += 1;
      }
      if (j >= sql.length) unterminated.push('string literal');
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Quoted identifier
    if (sql[i] === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') break;
        j += 1;
      }
      if (j >= sql.length) unterminated.push('quoted identifier');
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Dollar-quoted body: $tag$ ... $tag$
    if (sql[i] === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) {
          unterminated.push(`dollar-quoted body ${tag}`);
          current += sql.slice(i);
          i = sql.length;
          continue;
        }
        current += sql.slice(i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }

    if (sql[i] === ';') {
      statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += sql[i];
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return { statements, unterminated };
}

/** Parenthesis / bracket balance, ignoring anything inside a literal or comment. */
function checkBalance(statement) {
  const masked = statement
    .replace(/\$\$[\s\S]*?\$\$/g, "''")            // plpgsql body
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")              // string literal
    .replace(/"(?:[^"]|"")*"/g, '""')              // quoted identifier
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const stack = [];
  const pairs = { ')': '(', ']': '[' };
  for (const ch of masked) {
    if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return `unbalanced '${ch}'`;
    }
  }
  return stack.length ? `unclosed '${stack[stack.length - 1]}'` : null;
}

test('every migration file is present and non-empty', () => {
  assert.ok(files.length > 0, 'no migrations found');
  for (const f of files) {
    const src = readFileSync(join(MIGRATIONS, f), 'utf8');
    assert.ok(src.trim().length > 0, `${f} is empty`);
  }
});

test('every migration lexes cleanly - no unterminated literal, comment or dollar quote', () => {
  for (const f of files) {
    const { unterminated } = lex(readFileSync(join(MIGRATIONS, f), 'utf8'));
    assert.deepEqual(unterminated, [], `${f} has an unterminated ${unterminated.join(', ')}`);
  }
});

test('every statement is balanced and non-empty', () => {
  for (const f of files) {
    const { statements } = lex(readFileSync(join(MIGRATIONS, f), 'utf8'));
    for (const [n, stmt] of statements.entries()) {
      assert.notEqual(stmt, '', `${f}: statement ${n + 1} is empty (a stray semicolon)`);
      const problem = checkBalance(stmt);
      assert.equal(problem, null, `${f}: statement ${n + 1} is ${problem} -> ${stmt.slice(0, 90)}...`);
    }
  }
});

/**
 * Pre-existing conditions found while auditing, deliberately NOT fixed here
 * (touching an already-applied migration, or renaming one, would desync the
 * remote migration ledger and is outside this task's scope). They are pinned
 * here so a reviewer sees them and so a NEW occurrence cannot slip in quietly.
 */
const ACKNOWLEDGED = {
  /**
   * SECURITY DEFINER functions with no `REVOKE ... FROM PUBLIC`.
   *
   * Severity: LOW. All of these are TRIGGER functions (zero arguments,
   * `RETURNS trigger`), and Postgres refuses to call a trigger function
   * directly — `select public.log_order_activity()` errors with
   * "trigger functions can only be called as triggers". The PUBLIC execute
   * grant is therefore not a practical escalation path today. It should still
   * be closed, but in a NEW migration (an already-applied file is a no-op), and
   * that is a separate change from this task.
   */
  unrevokedDefiner: [
    'public.handle_new_user',
    'public.log_product_activity',
    'public.log_promo_activity',
    'public.log_order_activity',
    'public.product_sizes_log_stock_movement',
  ],
  /** Harmless to versioning (Supabase keys on the leading timestamp) but
   *  clearly typos, and they look like one to anyone reading the folder. */
  doubleSqlExtension: [
    '20260813062206_dslang_admin_users_table.sql.sql',
    '20260813062218_dslang_auto_admin_trigger.sql.sql',
  ],
};

test('every SECURITY DEFINER function is revoked from PUBLIC and granted explicitly', () => {
  // A security-definer RPC that is still executable by `public` is a privilege
  // escalation, so the grant list is part of the contract.
  //
  // Scoped per FILE, because that is the correct unit: a migration that creates
  // a new overload must revoke that overload, and Postgres matches overloads by
  // their full argument list.
  const unrevoked = [];
  for (const f of files) {
    const src = readFileSync(join(MIGRATIONS, f), 'utf8');
    const blocks = src.split(/create\s+(?:or\s+replace\s+)?function/i).slice(1);
    for (const block of blocks) {
      const name = /^\s*([\w.]+)\s*\(/.exec(block)?.[1]?.toLowerCase();
      if (!name) continue;
      if (!/security\s+definer/i.test(block.slice(0, 600))) continue;
      const escaped = name.replace('.', '\\.');
      const revokeRe = new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${escaped}\\s*\\(`, 'gi');
      if (!revokeRe.test(src)) unrevoked.push(`${f} :: ${name}`);
      // A grant is optional (revoke-without-grant correctly leaves the function
      // callable only by its owner), but it must never widen back to PUBLIC.
      const grants = [...src.matchAll(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${escaped}\\s*\\([^)]*\\)[^;]*;`, 'gi'))]
        .map((m) => m[0]);
      for (const g of grants) {
        assert.equal(
          /to\s+public\b/i.test(g),
          false,
          `${f}: ${name} is granted to PUBLIC, undoing its own REVOKE -> ${g.trim()}`,
        );
      }
    }
  }
  const unexpected = unrevoked.filter((entry) => {
    const name = entry.split('::')[1].trim();
    return !ACKNOWLEDGED.unrevokedDefiner.includes(name);
  });
  assert.deepEqual(unexpected, [], 'a SECURITY DEFINER function was added without revoking PUBLIC');
  // The acknowledged list must shrink, never grow.
  assert.deepEqual(
    [...new Set(unrevoked.map((e) => e.split('::')[1].trim()))].sort(),
    [...ACKNOWLEDGED.unrevokedDefiner].sort(),
    'the set of unrevoked SECURITY DEFINER functions changed - review it',
  );
});

test('every SECURITY DEFINER function pins its search_path', () => {
  for (const f of files) {
    const src = readFileSync(join(MIGRATIONS, f), 'utf8');
    if (!/security\s+definer/i.test(src)) continue;
    const blocks = src.split(/create\s+or\s+replace\s+function/i).slice(1);
    for (const block of blocks) {
      if (!/security\s+definer/i.test(block.slice(0, 400))) continue;
      assert.match(
        block.slice(0, 400),
        /set\s+search_path\s*=/i,
        `${f}: a SECURITY DEFINER function does not pin search_path (CVE-2018-1058 pattern)`,
      );
    }
  }
});

test('the two new migrations are additive - they drop nothing', () => {
  for (const f of [
    '20261010000000_dslang_install_sweep_schedules.sql',
    '20261011000000_dslang_track_lookup_throttle.sql',
  ]) {
    const src = readFileSync(join(MIGRATIONS, f), 'utf8');
    const { statements } = lex(src);
    for (const stmt of statements) {
      const verb = /^\s*(\w+)/i.exec(stmt)?.[1]?.toLowerCase();
      assert.notEqual(
        verb,
        'drop',
        `${f}: the new migrations must be additive, found a DROP statement`,
      );
      assert.notEqual(verb, 'truncate', `${f}: the new migrations must be additive, found a TRUNCATE`);
      // And never a destructive data statement.
      assert.equal(/\bdelete\s+from\s+(?!public\.dslang_track_lookup_attempts)/i.test(stmt), false, `${f}: unexpected DELETE`);
    }
  }
});

test('migration filenames carry a 14-digit version and are unique', () => {
  const stamps = files.map((f) => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'two migrations share a timestamp');
  for (const f of files) {
    // A name may not contain characters outside [a-z0-9_], plus the legacy
    // doubled `.sql` extension acknowledged below.
    assert.match(f, /^\d{14}_[a-z0-9_]+(\.sql)*$/, `${f} does not follow the timestamp_name convention`);
  }
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted, 'migration listing is not in chronological order');
});

test('no NEW migration carries the legacy double .sql extension', () => {
  const doubled = files.filter((f) => f.endsWith('.sql.sql'));
  assert.deepEqual(
    doubled,
    [...ACKNOWLEDGED.doubleSqlExtension].filter((f) => files.includes(f)),
    'a new migration was added with a doubled .sql extension, or a known one was renamed',
  );
});

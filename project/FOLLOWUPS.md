# Follow-ups

Open work that is deliberately **not** done yet, with enough context to pick it
up cold. Each entry says what is wrong, why it matters, and what "fixed" means.

---

## Rebuild the guest-claim test fixtures against migration 19

**Status:** open — not started, deliberately deferred.

**Files to change (and only these):**

- `scripts/retail-order-update-policy.test.mjs`
- `scripts/admin-users-privileges.test.mjs`

### What is wrong

Both files build synthetic PGlite databases by slicing function bodies out of
**pre-migration-19** migration files, then call the guest-claim RPC using the
**obsolete one-argument, email-only signature**:

| File | Line | Call |
|---|---|---|
| `retail-order-update-policy.test.mjs` | 387 | `claim_retail_guest_order('DSL-R-CLAIM-OK')` |
| `retail-order-update-policy.test.mjs` | 396 | `claim_retail_guest_order(null)` |
| `retail-order-update-policy.test.mjs` | 401 | `claim_retail_guest_order('DSL-R-BULK-3')` |
| `retail-order-update-policy.test.mjs` | 475 | `claim_retail_guest_order('DSL-R-REPOINT')` |
| `admin-users-privileges.test.mjs` | 530 / 560 / 584 | `claim_retail_guest_order('DSL-R-PROTECTED')` |

`admin-users-privileges.test.mjs:55-61` also reconstructs the grants as
`claim_retail_guest_order(text)` — one argument.

Neither file ever reads
`supabase/migrations/20261019000000_dslang_guest_claim_phone_proof.sql`:

- `retail-order-update-policy.test.mjs` loads migrations **12, 15, 17**
- `admin-users-privileges.test.mjs` loads migrations **17, 18**

So both are testing a function signature that **no longer exists in production**.

### What production actually looks like (verified 2026-09-29)

```sql
claim_retail_guest_order(p_ref text DEFAULT NULL, p_phone text DEFAULT NULL)
decline_retail_guest_order(p_ref text, p_phone text)
```

- `claim_retail_guest_order(text)` was **dropped**, not left alongside.
- Both require **BOTH** proofs: the order's `customer->>'email'` must equal the
  caller's JWT email, **and** `p_phone` must equal the order's phone after
  `regexp_replace(..., '[^0-9]', '', 'g')` and a length-10 check.
- Both are `SECURITY DEFINER`; `anon` has **no** EXECUTE on either.
- The row guard re-verifies the phone from the transaction-local
  `dslang.claim_phone` setting, so an RPC cannot be argued into linking on an
  email match alone.
- `decline_retail_guest_order` writes only `claim_declined_at`, and refuses
  orders that are already claimed **or already declined**.

### Why it matters

These tests currently pass, and that is the problem — they give **false
confidence**. Specifically:

- `retail-order-update-policy.test.mjs` test **"I2. the bulk claim path works and
  is bound to the caller JWT"** asserts `p_ref: null` claims everything and that
  *"a stranger must not claim another email's order"*. In production the RPC now
  additionally requires a phone, so this test proves nothing about the
  protection it is named for.
- `admin-users-privileges.test.mjs`'s anon-cannot-claim assertion is executed
  against a hand-written `revoke ... (text)` grant that no longer matches the
  real function identity. Postgres identifies a function by `name(argtypes)`,
  parameter names and defaults excluded, so the signature in the grant must be
  `(text, text)`.

A future regression that dropped or weakened the phone check would **not** fail
this suite.

### What "fixed" means

1. Slice the claim function **and** `decline_retail_guest_order` out of
   migration **19** (not 17) in both fixtures, including its
   `revoke`/`grant` statements at their real `(text, text)` identity.
2. Apply migration 19's row-guard trigger so the phone re-check is genuinely in
   the path being tested — otherwise the fixture proves less than production.
3. Give seeded orders a real 10-digit phone and pass that same `p_phone`.
4. Add the cases the current signature cannot express:
   - missing `p_phone` → raises
   - wrong-but-10-digit `p_phone` → `claimed = 0`, `user_id` stays `null`
   - correct `p_phone` → `claimed = 1`
   - `decline_retail_guest_order` with correct phone → writes `claim_declined_at`
   - a declined order is **permanently** ineligible for a later claim
   - a decline with the **wrong** phone writes nothing
5. Re-anchor `admin-users-privileges.test.mjs`'s anon assertion on
   `claim_retail_guest_order(text, text)`, and keep the expectation that `anon`
   is denied.
6. `npm test` green, and at least one new test that **fails** if the phone check
   is removed — otherwise the rebuild has not actually pinned anything.

### Out of scope

No production code, no database, no migrations, no frontend changes. Test
scaffolding only. Note that `scripts/guest-claim-flow.test.mjs` already pins the
**frontend** contract against migration 19; this work covers the **database**
fixtures, which is the gap it leaves.

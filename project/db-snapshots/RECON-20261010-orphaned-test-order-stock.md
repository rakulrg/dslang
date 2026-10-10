# Inventory reconciliation — orphaned units from the 2026-10-10 test-order deletions

**Status: OPEN — NO STOCK HAS BEEN CHANGED.**

This is a read-only reconciliation record. Nothing in this document has been
applied. No refund was issued, no payment status was altered, no inventory was
restored, and no order was deleted while producing it.

---

## 1. What happened

Five orders reached `payment_status='success'` / `order_status='processing'`,
then were removed through Admin → Orders → Delete Order on **2026-10-10
09:31–09:32 UTC**. `delete_retail_order` restocked before deleting, but
`restock_retail_order_items` declines paid orders by design, so the delete
removed the order row while its reserved stock stayed withdrawn.

The units are **orphaned, not merely miscounted**: with the order rows gone,
`variant_inventory_v` derives `committed` from live open orders, so these units
now appear in neither `available` nor `committed`. The ops dashboard cannot see
them.

Root-cause analysis and the fix: see `FOLLOWUPS.md`.

---

## 2. The six units

Attribution is per-order, from the `stock_movements` RESERVATION row that each
order created at placement, timestamp-matched to that order's own
`admin_activity` entry. Colour ids are read from the reservation row itself
(colour names are not unique across products — eight products have a "Black").

| Deleted order ref | Product code | Colour | Size | Units orphaned | Available now |
|---|---|---|---|---|---|
| DSL-R-1A5A627D | DS-ORG-0-3 | Black | L | 1 | 9 |
| DSL-R-8B3E63BE | DS-WF-0-3 | Maroon | M | 1 | 2 |
| DSL-R-30C46B0E | DS-ORG-0-3 | Black | M | 1 | 4 |
| DSL-R-31F1F07D | DS-ORG-0-3 | Black | M | 1 | 4 |
| DSL-R-1DF91C4F | DS-FF-0-3 | Green | M | 2 | 8 |
| **Total** | | | | **6** | |

### Distinct variants to reconcile (4)

| Product code | Colour | Size | Units to return |
|---|---|---|---|
| DS-ORG-0-3 | Black | M | 2 |
| DS-ORG-0-3 | Black | L | 1 |
| DS-WF-0-3 | Maroon | M | 1 |
| DS-FF-0-3 | Green | M | 2 |

### Money attached to these orders

All five captured a real successful payment on Cashfree:

| Order ref | Total | Reached |
|---|---|---|
| DSL-R-1A5A627D | ₹398 | success / processing |
| DSL-R-8B3E63BE | ₹698 | success / processing |
| DSL-R-30C46B0E | ₹498 | success / processing |
| DSL-R-31F1F07D | ₹398 | success / processing |
| DSL-R-1DF91C4F | ₹647 | success / processing |
| **Total** | **₹2,639** | |

**This figure is unverified.** `payment_id` stores only DSLANG's internal
reference; no Cashfree gateway order id, `txn_id`, or `paid_at` survives. The
amounts come from `admin_activity` metadata captured before deletion. Whether
₹2,639 of real money was captured is **not established** — see §3.

---

## 3. Why no stock has been touched

Restoring stock asserts that the goods were never sold and are still on the
shelf. For a captured payment that assertion is a financial claim, and two
things are unconfirmed:

1. **Cashfree environment.** Could not be confirmed from non-secret evidence.
   `CASHFREE_ENV` is an Edge Function / Vercel secret; `supabase secrets list`
   exposes names and digests only, never values. Every Supabase Edge Function
   path defaults to `TEST`/sandbox when the variable is unset
   (`cashfree-status/index.ts:58`, `cashfree-webhook/index.ts:64`,
   `expire-stale-orders/index.ts:120`), and all local config declares
   `CASHFREE_ENV=TEST`. That is *consistent with* sandbox but does not prove it.
   If production is actually running **production** Cashfree, real customer money
   was captured, these five are real paid orders, and returning stock would
   ship goods that are already paid for while the refund question stays open.

2. **Refunds.** No refund has been issued and none is recorded. If the payments
   were real, the correct sequence is refund first, stock second — not the
   reverse.

`DS-WF-0-3 / Maroon / M` is the sharpest constraint: available stock is **2**.
That variant is close to selling out, so an incorrect restore here is the most
likely to cause a customer-facing stockout.

**Precondition for acting:** Cashfree environment confirmed (test/sandbox), and
finance confirming no refund is owed. Until then this stays open.

---

## 4. How to reconcile once confirmed

Use the audited ops path — **not** the restock function, which correctly refuses
paid orders, and not `delete_retail_order`. `adjust_variant_stock` is
admin-gated, clamps at zero, and writes a `stock_movements` row plus an
`admin_activity` entry, so the correction is traceable.

```
-- Illustrative only. DO NOT RUN until §3 preconditions are met.
-- Verify each variant's current stock first; the numbers in §2 were a
-- read-only snapshot and will drift with new sales.
```

One call per variant, per line:

| product_id / color_id / size_label | delta | reason |
|---|---|---|
| DS-ORG-0-3 / Black / M | +2 | `Test order deleted without refund — no customer impact` |
| DS-ORG-0-3 / Black / L | +1 | same |
| DS-WF-0-3 / Maroon / M | +1 | same |
| DS-FF-0-3 / Green / M | +2 | same |

`adjust_variant_stock(product_id, color_id, size_label, delta, reason, note)`.
Pass a `note` naming this document so the movement links back to the incident.

### Re-verify afterwards

```
select product_code, color_name, size_label, available, committed, on_hand
from public.variant_inventory_v
where (product_code, color_name, size_label) in (
  ('DS-ORG-0-3','Black','M'), ('DS-ORG-0-3','Black','L'),
  ('DS-WF-0-3','Maroon','M'), ('DS-FF-0-3','Green','M'));
```

Expected: `available` up by the amounts above; `committed` unchanged (it was
never counting these units); `on_hand` unchanged, since these units were
physically on the shelf all along and only their *record* was lost.

---

## 5. Prevention

Deployed fix (applied to production on 2026-10-10): `delete_retail_order` now
refuses to delete an order with a captured payment, and refuses to strand a
reservation on a terminal-status order. A separately authorized
`delete_paid_retail_order` exists for confirmed test orders: admin-only,
requires a reason and a payment-settlement attestation, snapshots the full
payment and inventory record to `admin_activity` before deleting, and **never
restocks**.

This report is the reconciliation half of that split: deletion is auditable,
inventory returns only as a separate, deliberate, audited act.

---

## Reconciliation Completed — 2026-10-10

**Reference:** `RECON-20261010`
**Reason:** Test order deleted without refund - no customer impact.
**Actor:** `0c7509bc-9852-47ab-b395-50373ec2b258` (the single registered
administrator, confirmed present in `admin_users`)

### Root cause

Five paid test orders were deleted through the admin panel. `delete_retail_order`
restocked before deleting, but `restock_retail_order_items` declines paid orders
by design, so the delete removed the order row while its reserved stock stayed
withdrawn from `product_sizes.stock`. Six units across four variants were left
missing from inventory, and — because `variant_inventory_v` derives `committed`
from live open orders — invisible to the ops dashboard once the rows were gone.

Deleted test orders:

- `DSL-R-1DF91C4F`
- `DSL-R-31F1F07D`
- `DSL-R-30C46B0E`
- `DSL-R-8B3E63BE`
- `DSL-R-1A5A627D`

### Payment environment confirmed

**All five transactions were confirmed in the Cashfree Test Environment.** Two
were located first (`DSL-R-1DF91C4F` Rs 597, `DSL-R-31F1F07D` Rs 348); the
remaining three were then located after deriving the expected charge as
`total_amount - 50` (a rule verified deterministically against all 15 surviving
online orders). The two located transactions independently establish that the
deployed application creates payment orders against the Cashfree **sandbox**,
so **no real money was captured and no refund is owed**.

### Adjustments completed

All four were performed through the authenticated admin interface.

| # | Variant | Stock before | Stock after | Units | Recorded at (UTC) |
|---|---|---|---|---|---|
| 1 | DS-ORG-0-3 / Black / M | 4 | 6 | +2 | `2026-10-10T14:41:15.755550+00:00` |
| 2 | DS-ORG-0-3 / Black / L | 9 | 10 | +1 | `2026-10-10T14:41:15.874617+00:00` |
| 3 | DS-WF-0-3 / Maroon / M | 2 | 3 | +1 | `2026-10-10T14:41:51.775954+00:00` |
| 4 | DS-FF-0-3 / Green / M | 8 | 10 | +2 | `2026-10-10T14:42:16.088686+00:00` |

Timestamps are the exact `stock_movements.created_at` values recorded by the
database at the time of each adjustment; they were not estimated.

### Verification results (read-only, post-adjustment)

| Check | Result |
|---|---|
| Total stock | 478 -> 484 (+6) |
| Inventory variants | 100 (unchanged) |
| Negative-stock variants | 0 |
| Stock movements created | 4, no duplicates |
| Legitimate open orders / reserved units | 4 orders, 4 units, all intact |
| Orders total | 19 (unchanged) |
| `DSL100` used_count | 5 (unchanged) |
| Shipments / AWBs / tracking IDs / refunds / payment-status changes | none |
| Scheduler settings | unchanged |

The four open orders and their reservations were confirmed untouched, including
`DSL-R-8BE198F4`'s DS-ORG-0-3 / Black / M reservation, which was deliberately
excluded from this correction.

### Audit trail limitation

The four stock movements were generated through the **product variant stock
editor** (`set_product_size_stock`) rather than through `adjust_variant_stock`.
Consequently:

- The movements carry the trigger's generic text
  `Stock released (order failed / cancelled / restocked)` and
  `movement_type = 'RELEASE'`, not an adjustment-specific type.
- The movements **do not carry the `RECON-20261010` reference** or the intended
  explanatory note; `note` is empty on all four.
- `source_type` is `order` rather than the `manual` that `adjust_variant_stock`
  writes.
- **No `adjust_stock` entries exist in `admin_activity`** for these corrections.
  The only related rows are three product-level `UPDATE` entries carrying no
  variant, quantity or reason.
- The `actor` on all four movements is correct and is the registered
  administrator, so authorization was respected throughout.

The stock correction is complete and correct. The *narrative* trail is not:
the database contains no record linking this reconciliation to `RECON-20261010`
or to the five deleted test orders. **This Markdown section documents the
reconciliation; it does not repair or replace the missing database audit
trail.**

A one-off `admin_activity` note cannot be added through any existing supported
mechanism. `admin_activity` has no INSERT/UPDATE/DELETE policy, and
`record_admin_activity` is `REVOKE … FROM public` with no grant to
`authenticated` or `service_role` — deliberately, so that audit entries cannot be
forged by any client. Closing that gap would require a schema change, which was
deliberately not made.

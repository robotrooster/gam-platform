# Session 121 Handoff

**Theme:** Two backend gap-closers post-rebuild while we wait for Stripe
sandbox testing — (1) tenant-payer platform-fee passthrough on rent
charges (closes the loop S120 explicitly left open), (2) PM transfer
reconciliation cron (closes the retry gap S119 left open).

Both are pure backend, no product input needed, no Stripe API
dependencies.

## Architecture decisions

**Passthrough computed pre-charge, claim post-charge.** The route
SELECTs unpaid tenant-payer accruals BEFORE creating the destination
charge so `application_fee_amount` includes them. The `UPDATE … SET
tenant_charge_id` only runs AFTER `createRentDestinationCharge`
returns successfully — so a Stripe failure between SELECT and UPDATE
leaves the accruals unclaimed for the next attempt. No
"claimed-but-not-charged" half-state.

**Race-safe atomic claim via `tenant_charge_id IS NULL` filter.** Two
concurrent rent payments on the same property could both SELECT the
same unpaid accruals. Both would race the UPDATE; only one wins
because the WHERE clause includes `tenant_charge_id IS NULL`. The
loser's UPDATE matches zero rows — the loser already collected the
surcharge from the tenant via Stripe, creating an over-collection
edge case. Flagged for a future reconciliation job to detect and
refund. Rare in practice (one tenant per payment in the typical
flow) — defended at the DB layer; explicit reconciliation is the
follow-up.

**Reconciliation cron stale threshold = 1 hour.** Post-commit fires
in S119 land within seconds when Stripe is healthy. Anything older
than 1 hour is presumed failed and eligible for retry. Conservative
window — generous enough that a slow Stripe API call doesn't get
double-fired, tight enough that genuine failures get retried within
the next 24 hours.

**Recon cap at 500 stale groups per run.** Defensive against a Stripe
outage that backlogs hundreds of failed transfers. Catch-up across
multiple days is fine; pinning the API on a single run isn't.

**Recon piggybacks on existing 4am Phoenix prune block.** No new cron
schedule. The S103/S104 prune block already runs at 4am and is
failure-isolated per-handler, so adding `reconcilePmTransfers` as a
third handler in the same arrow is the cleanest landing.

## Shipped

### apps/api/src/routes/payments.ts

`POST /api/payments/:id/pay` extended:
- New JOIN on `units` to surface `property_id` (needed for the
  accrual lookup)
- Pre-charge SELECT: unpaid tenant-payer accruals on the property
- Sum added to `application_fee_amount` so Stripe collects on top
  of rent
- Post-charge UPDATE: atomically claims those accruals via
  `tenant_charge_id`, race-safe via `IS NULL` filter
- Response now includes `platformFeePassthrough` (dollar amount)
  and `accrualsClaimed` (count) for observability

### apps/api/src/jobs/pmTransferReconciliation.ts (new)

Standalone job. Walks DISTINCT (reference_type, reference_id) pairs
on `user_balance_ledger` where:
- `type = 'allocation_pm_company_fee'`
- `stripe_transfer_id IS NULL`
- `created_at < NOW() - INTERVAL '1 hour'`
- LIMIT 500

For each group, calls `firePmTransfersForReference(reference_type,
reference_id)`. Aggregates `fired` + `failed` counts; logs errors
without throwing.

### apps/api/src/jobs/scheduler.ts

Existing 4am Phoenix prune block (S103/S104) extended with a third
handler: dynamically imports `reconcilePmTransfers` and runs it
alongside the email + operational-log prunes. Same failure
isolation pattern.

## Files touched

- `apps/api/src/routes/payments.ts` (passthrough math + atomic claim)
- `apps/api/src/jobs/pmTransferReconciliation.ts` (new)
- `apps/api/src/jobs/scheduler.ts` (cron handler addition)
- `SESSION_121_HANDOFF.md` (this file)

No migrations. No schema changes (tenant_charge_id column already
existed from S114).

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 6-step smoke against dev DB:
  - **A1.** Unpaid tenant-payer accrual SELECT: 2 of 4 seeded rows
    picked up (skips already-claimed + landlord-payer rows) ✓
  - **A2.** Application fee math: $6 ACH base + $20 passthrough =
    $26 total ✓
  - **A3.** Post-charge atomic UPDATE claims both rows ✓
  - **A4.** Pre-existing claim NOT overwritten (race-safe `IS NULL`
    filter works) ✓
  - **B1.** Reconciliation cron picks up the stale (>1hr old)
    pm_company_fee row, attempts fire, hits no-Connect branch,
    counts as `failed=1` without throwing ✓
  - **B2.** Fresh (<1hr) row correctly NOT picked up by the staleness
    filter ✓

Dev DB returned to zero pollution post-test.

## What this session did NOT do

- **No over-collection reconciliation.** When two concurrent rent
  payments race, the loser already collected the passthrough from
  the tenant via Stripe but didn't claim the accrual row. A future
  cron should detect over-collection (multiple `tenant_charge_id`
  values referencing different payments where the same property
  shows passthrough on >1 charge in the same accrual_month) and
  flag for refund. Not built.
- **No live Stripe smoke.** Both pieces work entirely against GAM
  schema; no Stripe API call validation needed for these. The S119
  PM transfer call (which the recon cron retries) still needs
  sandbox validation as called out in S119 handoff.
- **No tenant-side UI for "you'll be charged $X platform fee with
  this rent."** Frontend pass needs to surface the passthrough
  amount on the pay-rent screen. Today the response payload includes
  it; the frontend just hasn't consumed it.

## What next session should target

Stripe sandbox testing remains the highest-priority next move (per
S120's recommendation). When you have a test API key + can walk
through the onboarding/charge/payout flow, that becomes the next
session.

While waiting for sandbox:

1. **Item 10 (utility billing payment integration)** — extend the
   rent-charge route to support utility line items as separate
   charges. Composes naturally with destination charges. ~1 session.
2. **Sub-permission gating on routes** — catalog defined S81;
   enforcement deferred. Mechanical pass touching most route files.
3. **Compliance-table retention policy** (S104 deferral) — needs
   your retention windows for `admin_action_log`, `audit_log`,
   `bulletin_reveal_log`, `ach_monitoring_log`. 30 min once you
   pick numbers.
4. **lease_fees `move_out` / `other` due_timing wire-up** — needs
   product call (build move-out generator vs strip enum values).
5. **ACH retry workflow** (NACHA up to 2 retries on failed ACH).
   Today `payment_intent.payment_failed` just sets `status='failed'`
   without retry queue.
6. **Frontend pass** — when you call this. Long list of backend-
   ready surfaces with no UI (PM management, email-failures,
   payouts/disputes/history, Connect onboarding mount, pay-rent
   button, platform fee preview).

Recommend **#1 (utility billing)** as the next pure-backend work
that doesn't need product input. Or **#5 (ACH retry)** if NACHA
compliance posture matters more before launch.

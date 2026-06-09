# Session 111 Handoff

**Theme:** PM Companies — secondary fee triggers (`per_unit`, `flat_monthly`,
`leasing_fee`) wired into the monthly accrual job and lease-creation hook,
plus a S110 mis-trigger fix. PM fee surface is now feature-complete on every
fee_type except `maintenance_markup_pct` (deferred — needs maintenance
invoice flow that doesn't exist yet).

## Architecture decisions

**S110 mis-trigger fix: `flat_monthly` moved out of the per-payment path
into the monthly accrual.** The in-house manager-fee model has always
split by trigger:
- `rent_percent` → fires per rent payment (allocation engine)
- `flat_monthly_fee` + `per_unit_fee` → fires monthly (accrual job)

PM should mirror that split. S110 wrongly put `flat_monthly` in
`computePmCutForRent()`, which means it would have fired on every
settled rent payment instead of once per month. Fixed by removing
flat_monthly from the per-payment switch (returns 0 there now) and
adding it to the new monthly accrual path below.

**Separate `pm_monthly_fee_accruals` table, not extending `monthly_fee_accruals`.**
The in-house table keys idempotency on `(property_id, accrual_month)`. PM
needs `(property_id, accrual_month, pm_company_id)` so a property
reassigned mid-month between two PM companies doesn't collide its prior
PM's accrual with the new one. Two tables, two clean idempotency stories.

**Mutual exclusion between in-house and PM monthly paths.** The existing
in-house candidates query now excludes `pm_company_id IS NOT NULL`
properties. The PM path picks them up. A property at any moment is
either in-house-managed OR PM-managed for the purposes of monthly
accrual; never both. Mirrors the per-payment exclusion shipped in S110.

**`leasing_fee` fires regardless of primary `fee_type`.** A PM plan can
have a primary fee_type of `flat_monthly` AND have `leasing_fee_amount`
set (composite plans, allowed by S108's loose-CHECK design). The
trigger condition is "`leasing_fee_amount > 0` on the property's
assigned plan," not "`fee_type = 'leasing_fee'`". This way composite
plans correctly fire monthly AND on lease creation. Same posture
intended for `maintenance_markup_pct` whenever that trigger lands.

**`leasing_fee` reference_type = 'lease'.** The S110 PM-cut entries
use `reference_type = 'payment'` (rent payment id). Monthly accruals
use `reference_type = 'pm_monthly_fee_accrual'` (S111 accrual id).
Leasing fees use `reference_type = 'lease'` (the new lease id). All
three are distinct so the existing rent-flow idempotency check in
`alreadyAllocated()` doesn't collide with monthly or lease triggers.

**Defense in depth on PM bank routing.** Every path that posts a PM
ledger entry independently checks that the PM company has a
`bank_account_id` resolving to a `user_bank_accounts.user_id`:
- Per-payment allocation (S110)
- Monthly accrual (S111)
- Leasing fee (S111)
Three checks for the same invariant. The property-assignment route
also enforces it at assignment time.

## Shipped

### Migration `20260504020000_pm_monthly_fee_accruals.sql`

Parallel to `monthly_fee_accruals`. Snapshot fields (`fee_type`,
`flat_amount`, `per_unit_amount`, `occupied_unit_count`,
`bank_account_id`) preserve historical math under future plan/bank
edits. UNIQUE on `(property_id, accrual_month, pm_company_id)`.
CHECK constrains `fee_type` to `{flat_monthly, per_unit}` — only
those fire monthly. Two indexes for the per-property-month and
per-pm-company-month queries the route layer will run.

### apps/api/src/services/allocation.ts

`computePmCutForRent()`: removed `flat_monthly` from the per-payment
switch (was a S110 over-trigger). Now only the three percent-based
fee types (`percent_of_rent`, `percent_with_floor`, `percent_with_ceiling`)
fire from rent allocation. Comment block updated to document the
trigger split.

### apps/api/src/jobs/monthlyFeeAccrual.ts

- `AccrualResult` extended with `pmPropertiesProcessed`, `pmFeesAccrued`,
  `pmSkippedZero`, `pmSkippedAlreadyAccrued` counters
- In-house candidates query now excludes `pm_company_id IS NOT NULL`
- New PM candidates query: properties with active PM company + active
  fee plan with `fee_type IN ('flat_monthly', 'per_unit')`
- New `accruePmCompanyFee(propertyId, pmCompanyId, pmFeePlanId, monthIso)`
  function — mirrors `accrueOneProperty` shape but writes to
  `pm_monthly_fee_accruals` and posts `allocation_pm_company_fee`
  ledger entries with `reference_type = 'pm_monthly_fee_accrual'`
- Per-(property, month, pm_company) advisory lock with a distinct key
  prefix from the in-house lock (`pm_monthly_fee_accrual:` vs
  `monthly_fee_accrual:`)

### apps/api/src/routes/esign.ts

- New helper `postLeasingFeeIfApplicable(client, leaseId, unitId)` that
  reads property → pm_company → pm_fee_plan, posts a one-time
  `allocation_pm_company_fee` ledger entry when `leasing_fee_amount > 0`
- `executeOriginalLease` calls the helper after the lease INSERT and
  the document→lease link UPDATE, before the lease_fees + utilities
  spec writes
- Helper throws 409 if PM company lacks bank routing — same defense as
  the allocation engine

## Files touched

- `apps/api/src/db/migrations/20260504020000_pm_monthly_fee_accruals.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated)
- `apps/api/src/services/allocation.ts` (S110 fix in computePmCutForRent)
- `apps/api/src/jobs/monthlyFeeAccrual.ts` (parallel PM accrual path)
- `apps/api/src/routes/esign.ts` (postLeasingFeeIfApplicable + hook)
- `SESSION_111_HANDOFF.md` (this file)

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Migration applied
- End-to-end smoke (Node ts-node, real `processMonthlyFeeAccrual` against
  dev DB, three scenarios):
  - **A. per_unit plan, $50/unit, 15 occupied units** → $750 accrual,
    correctly multiplied by occupancy, ledger entry written and linked
    via `ledger_entry_id`
  - **B. flat_monthly plan, $250** → $250 accrual on first run,
    `pmSkippedAlreadyAccrued = 1` on re-run (UNIQUE-constraint
    idempotency works)
  - **C. leasing_fee, $350** → ledger row with type
    `allocation_pm_company_fee`, `reference_type = 'lease'`,
    amount = $350
- Dev DB returned to zero pm_companies / pm_monthly_fee_accruals /
  user_balance_ledger rows post-test

## What this session did NOT do

- **No `maintenance_markup_pct` trigger.** The maintenance vendor invoice
  flow doesn't exist yet (`routes/maintenance-portal.ts` has
  purchase_requests but no clear vendor invoice approval path).
  Building this needs the invoice flow itself first.
- **No PM staff invitation flow** (email + accept token). Composes S101
  email infrastructure with S80 invitation pattern; ~half session.
- **No frontend.** Per UI/UX standing rule.
- **No CHECK constraint update on `pm_monthly_fee_accruals.fee_type`** —
  currently `{flat_monthly, per_unit}`. If percent-based plans ever need
  to be back-attributed to a month (e.g. for a "what did each PM company
  earn this month" report), this constraint may need to widen — or the
  report should JOIN against the per-payment ledger rows directly. Not
  blocking today.

## Pre-launch blockers still open

Same as S100–S110:
- Item 16 batch 2 — bank ACH origination provider
- Item 16 batch 3+ — OTP enablement
- Item 10 — utility billing payment integration

## What next session should target

PM fee surface is now feature-complete for every fee_type that has a
trigger built. Remaining PM work:

1. **PM staff invitation flow** — email + accept token. Composes
   existing infra; small session.
2. **`maintenance_markup_pct` trigger** — gated on the maintenance
   invoice/vendor-billing flow itself being built.
3. **Frontend pass** — PM Companies management surface, owner-cut
   dashboard card, email-failure dashboard. UI session.
4. **Master Schedule booking UI** (S92 schema shipped, UI gap).
5. **Sub-permission gating on routes** (catalog defined S81, gating
   pending).

Recommend **#1 (PM staff invitation)** if continuing PM work, or
move to a different domain (Master Schedule, sub-permissions, or the
frontend pass) per your priority. PM Companies is now production-
viable as a backend subsystem — the staff-add-by-uuid path from S109
covers the immediate need; the email-invite flow is UX polish.

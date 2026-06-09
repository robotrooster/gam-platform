# Session 110 Handoff

**Theme:** PM Companies — allocation-engine fee-cut wire-up + owner
visibility view. Closes the rent-flow money path: when a property is
assigned to a `pm_company`, the engine now claims the configured cut
from each settled rent payment, posts a `allocation_pm_company_fee`
ledger entry to the PM company's payout user, and reduces the owner
share accordingly.

## Architecture decisions

**PM cut REPLACES the in-house manager fee.** When
`properties.pm_company_id` is set, the in-house `manager_fee` path is
skipped entirely — the PM company is doing the management role for
this property. Owners contracting an external PM don't double-pay.
This matches Nic's S107 framing: "pm role is similar to landlord but
distinct" — the cut goes to the PM org, the owner sees their net
after.

**PM payout user = `pm_companies.bank_account_id`'s owner.** The 16a
invariant says ledger entries are user-scoped and the bank's owner is
the recipient. The PM company's assigned `bank_account_id` resolves
through `user_bank_accounts.user_id`. That user's `user_balance_ledger`
gets the cut. Auto-Friday payouts then sweep that user's balance like
any other user — no special path needed.

**Snapshot routing semantics preserved.** `bank_account_id` is stamped
on the ledger entry at write time; future reassignment of the PM
company's bank account doesn't retroactively re-route already-allocated
funds. Same posture as `owner_share` and `manager_fee`.

**Two-layer guard against unrouted PM companies.**
- **Property assignment route** (`PATCH /api/properties/:id/pm-assignment`)
  refuses to assign a PM company that has `bank_account_id IS NULL`
  with 409.
- **Allocation engine** independently throws 409 if it ever encounters
  a PM-assigned property whose company lacks bank routing. Belt and
  suspenders — the assignment route may have its check bypassed via
  a manual SQL update, or a route gap in the future.

**Rent-flow fee_types only.** `computePmCutForRent()` evaluates only
the four fee types that apply to recurring rent payments:
`percent_of_rent`, `flat_monthly`, `percent_with_floor`,
`percent_with_ceiling`. The other three are no-ops at allocation time:
- `per_unit` fires from the monthly accrual job (already exists for
  in-house manager fees; PM per_unit can layer onto that path in a
  future session)
- `leasing_fee` fires on lease-signed events (not built yet)
- `maintenance_markup_pct` fires on maintenance invoice events (not
  built yet)

**Idempotency expanded.** The `alreadyAllocated()` check now includes
`allocation_pm_company_fee` in its EXISTS query. Webhook redelivery
of a settled rent payment correctly short-circuits whether the
property is PM-managed or not.

**Owner-visibility view: per-property aggregate.** The endpoint
`GET /api/landlords/me/pm-impact?from=YYYY-MM-DD&to=YYYY-MM-DD`
returns one row per property the landlord owns, with summed
owner_net / pm_company_cut / in_house_manager_fee / total_split /
payment_count over the window. Backs the landlord-portal "your
properties under PM" dashboard card. From/to default to NULL
(unbounded — UI can pass a window).

## Shipped

### Migration `20260504010000_pm_company_fee_ledger_type.sql`

Drops + re-adds `user_balance_ledger_type_check` to add
`allocation_pm_company_fee` to the allowed list. No data migration
needed (no rows of the new type pre-existed).

### apps/api/src/services/allocation.ts

- `ALLOCATION_TYPES` extended with `allocation_pm_company_fee`
- `PropertyAndRuleRow` adds `pm_company_id` + `pm_fee_plan_id`
- New `PmFeeRow` type capturing pm_company bank routing + plan fields
- New `fetchPmFeeContext(client, pmCoId, planId)` — joins
  `pm_companies + pm_fee_plans + user_bank_accounts`. Returns null
  if the join is empty (deleted plan etc.); returns the row with
  `pm_payout_user_id = null` if the PM company has no bank routing
  (allocation engine then throws 409).
- New `computePmCutForRent(plan, splittable)` — pure function over
  the 4 rent-flow fee_types; returns 0 for non-rent-flow types so a
  composite plan that also has leasing_fee/markup fields doesn't
  double-charge here.
- `executeRentAllocation` integration:
  - PM cut computed before manager fee
  - 409 if cut > splittable (plan misconfig — floor too high)
  - In-house manager-fee path now also gated on
    `!pmCompanyContracted` so the two never run together
  - 409 if `managerFee + pmCompanyFee > splittable` (combined invariant)
  - `ownerShare = splittable - managerFee - pmCompanyFee`
  - New ledger entry post for `allocation_pm_company_fee` after the
    existing manager-fee post
- `alreadyAllocated()` updated to short-circuit on the new type

### apps/api/src/routes/properties.ts

`PATCH /api/properties/:id/pm-assignment` now refuses 409 when the
selected PM company has `bank_account_id IS NULL`.

### apps/api/src/routes/landlords.ts

New `GET /api/landlords/me/pm-impact` endpoint. Aggregates
`user_balance_ledger` entries by property, restricted to
`reference_type='payment'` and the three allocation types. Optional
`from` / `to` query params (validated as ISO YYYY-MM-DD). Returns
per-property:
- `property_id`, `property_name`
- `pm_company_id`, `pm_company_name` (NULL when self-managed)
- `pm_fee_plan_id`, `pm_fee_plan_name`, `pm_fee_type`
- `owner_net` (sum of owner_share entries)
- `pm_company_cut` (sum of pm_company_fee entries)
- `in_house_manager_fee` (sum of manager_fee entries)
- `total_split` (sum of all three — what was actually distributed)
- `payment_count` (DISTINCT count of rent payments contributing)

## Files touched

- `apps/api/src/db/migrations/20260504010000_pm_company_fee_ledger_type.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated)
- `apps/api/src/services/allocation.ts` (new types, helpers, integration)
- `apps/api/src/routes/properties.ts` (assignment route bank-routing guard)
- `apps/api/src/routes/landlords.ts` (new pm-impact endpoint)
- `SESSION_110_HANDOFF.md` (this file)

Plus a dist rebuild on `packages/shared` (recovered from a stale
ESM-shaped dist that had been blocking node-direct script invocation
since some prior session).

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Migration applied; CHECK constraint smoke confirmed allows the new
  type via `information_schema.check_constraints`
- End-to-end allocation engine smoke (Node ts-node, real
  executeRentAllocation against a real settled payment, three
  scenarios):
  - **A. Property without PM** → only `allocation_owner_share=1000.00`
    posts; pm_company_fee row count = 0 (regression check that
    pre-S110 path is unchanged when PM is not contracted)
  - **B. Property with PM company on 8% fee plan, $1000 rent** →
    `pm_company_fee=80.00`, `owner_share=920.00`, no in-house
    manager_fee row (correctly replaced by PM cut). Math verified:
    8% × $1000 = $80 cut, owner net = $920
  - **C. PM company has no bank_account_id** → allocation throws 409
    with the expected message identifying the company
- Owner-visibility query shape verified against rolled-back synthesized
  ledger data: aggregates correctly, returns NULL pm_company_id when
  property is self-managed
- Dev DB returned to zero pm_companies / user_balance_ledger /
  smoke-payment rows post-test

## What this session did NOT do

- **No per_unit fee accrual integration.** The monthly accrual job
  (`services/monthlyFeeAccrual.ts`) handles in-house per_unit fees;
  PM `per_unit` plans are recognized in the fee_type CHECK but do
  not yet post accruals. Future session: extend monthlyFeeAccrual
  to also walk `pm_fee_plans` for `per_unit` plans on assigned
  properties.
- **No leasing_fee trigger.** When a new lease is signed on a property
  contracted to a PM company with a `leasing_fee` plan, no entry is
  posted today. Needs an event hook in the lease-finalization flow.
- **No maintenance_markup_pct trigger.** Same — needs a hook on
  maintenance invoice creation/approval.
- **No allocation engine smoke for percent_with_floor /
  percent_with_ceiling / flat_monthly variants.** Only
  `percent_of_rent` was exercised end-to-end. The other three are
  pure-function paths in `computePmCutForRent()` that are easy to
  unit-test if a session adds proper Jest coverage.
- **No frontend.** Per UI/UX standing rule.
- **No auto-Friday payout integration check.** The architecture
  reasoning is sound (the PM company's payout user gets a normal
  user_balance_ledger row, which the existing 16a auto-payout sweep
  picks up), but a dedicated end-to-end test that fires the auto-payout
  cron and confirms the PM gets a disbursement was not done.

## Pre-launch blockers still open

Same as S100–S109:
- Item 16 batch 2 — bank ACH origination provider
- Item 16 batch 3+ — OTP enablement
- Item 10 — utility billing payment integration

## What next session should target

PM Companies subsystem is now feature-complete on the rent-flow path
(rent → split → owner net visible). Remaining PM-related work is
secondary triggers (per_unit accrual, leasing_fee, maintenance_markup_pct)
and the staff invitation flow. None are launch blockers — owners can
contract PMs and the money flows correctly today.

Recommended next:

1. **Frontend pass for PM Companies + email-failures dashboard.**
   Both have full backend wiring; UI is the gap. Per the UI/UX
   standing rule, batch with you when ready to verify.
2. **Master Schedule booking UI** (option #2 from the recon). Schema
   shipped S92; UI flow missing.
3. **Sub-permission gating on routes** (option #3). Catalog defined,
   enforcement deferred.
4. **PM staff invitation (email + accept) flow.** S101+ email
   infrastructure + S80 invitation pattern compose cleanly. ~half
   session.
5. **PM secondary triggers** (per_unit accrual, leasing_fee,
   maintenance_markup_pct). Each is independent and small. Could
   batch as one "PM secondary fees" session.

Recommend #1 if you're ready to compile the visual smoke list. Frontend
is now the main remaining work to make the recent backend builds
actually visible to users.

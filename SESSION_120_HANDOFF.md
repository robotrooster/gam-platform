# Session 120 Handoff

**Theme:** Stripe Connect rebuild — Final session. Per-occupied-unit
platform fee accrual cron lands. Closes the SaaS-side billing path
end-to-end on the backend; every active property now gets billed
monthly per the locked $2/unit + $10/property minimum model with
RV/STR aggregation and per-landlord overrides.

The S114–S120 rebuild is complete. Backend is feature-complete on
all six rebuild axes: schema, Connect onboarding, destination charges,
webhook handlers, dashboard backend, PM money-flow, platform fee
accrual.

## Architecture decisions

**Two-stage billing for tenant-payer properties.** The accrual cron
ALWAYS writes a `platform_fee_accruals` row regardless of who pays.
When `platform_fee_payer = 'landlord'`, the cron also posts a
`platform_fee_subscription` entry to `platform_revenue_ledger`
immediately — GAM keeps the money via the existing destination-charge
math (landlord's payouts already net out application_fee_amount).
When `platform_fee_payer = 'tenant'`, the cron writes ONLY the
accrual row and stamps `payer = 'tenant'`; a future session adds
the rent-charge code that consults unpaid tenant-payer accruals and
rolls them into the next rent's `application_fee_amount` as an
add-on. Two-stage shape lets the cron run independently of when the
tenant actually pays rent that month.

**Cron at 1:30am Phoenix on the 1st.** Just after the S69 manager-fee
accrual at 1:00am. Same advisory-lock pattern (per-property locked
on accrual_month) so concurrent retries can't double-bill. Different
lock key prefix (`platform_fee_accrual:` vs `monthly_fee_accrual:`)
prevents collision with the manager fee path.

**Rate cascade: override → default.** SQL CASCADE built into the
config lookup query — `LEFT JOIN landlord_platform_fee_overrides`
filtered to `effective_until IS NULL` (active row), then
`COALESCE(o.rate_per_unit, pfc.rate_per_unit)`. One query, two
sources, falls through cleanly. Snapshot on the accrual row preserves
historical billing under future rate edits.

**RV/STR aggregation rule (locked S113).** Two parallel SUMs per
property per month:
- Long-term unit count = `COUNT(DISTINCT l.unit_id)` from `leases`
  with active overlap to the billing month
- Short-stay nights = `SUM(LEAST(check_out, month_end+1d) -
  GREATEST(check_in, month_start))` from `unit_bookings` with
  `lease_type IN ('nightly','weekly')`, status not cancelled/no_show
- `total_billable = LT + CEIL(STR_nights / 30)`, round-up
- `fee = MAX(rate × total_billable, min_per_property)`

No per-unit classification, no exclusion logic. Lease + STR can
overlap on the same unit-month and BOTH revenue events count
(matches Nic's "all str nights aggregated. nothing skipped" rule).

**Idempotency via UNIQUE(landlord_id, property_id, accrual_month)**
on `platform_fee_accruals` — already in place from S114. Re-running
the cron returns `skippedAlreadyAccrued`, zero side effects.

**Vacant-property handling.** When `total_billable = 0` AND
`min_per_property = 0`, return `'zero'` outcome (no row written).
Default config has `min = $10`, so vacant properties under default
config still bill the $10 minimum. Per-landlord override CAN set
min to 0 to enable "completely free if vacant" arrangements.

## Shipped

### Migration `20260504090000_platform_fee_subscription_ledger_type.sql`

Extends `platform_revenue_ledger.type` CHECK to allow the new
`'platform_fee_subscription'` value alongside the existing types.
No data migration; new value used only by the new cron.

### apps/api/src/jobs/platformFeeAccrual.ts (new)

- `processPlatformFeeAccrual(now?)` — top-level entry point. Walks
  every property where `landlord_id IS NOT NULL`, calls
  `accrueOneProperty` per row.
- `accrueOneProperty` — opens a tx, takes the per-property advisory
  lock, checks idempotency, runs the long-term + short-stay queries,
  resolves rate via override→default cascade, writes the accrual
  row, conditionally posts to `platform_revenue_ledger` based on
  the `platform_fee_payer` toggle.
- `AccrualResult` returns `{ monthScanned, propertiesProcessed,
  feesAccrued, skippedZero, skippedAlreadyAccrued, errors[] }`.

### apps/api/src/jobs/scheduler.ts

New cron registration at `30 1 1 * *` (Phoenix). Imports the new
module dynamically (matches the S69/S111 pattern). Logs result JSON
on success, logs fatal errors but doesn't crash the scheduler.

## Files touched

- `apps/api/src/db/migrations/20260504090000_platform_fee_subscription_ledger_type.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated, 8295 → 8295 lines —
  CHECK swap doesn't move line count)
- `apps/api/src/jobs/platformFeeAccrual.ts` (new — 240 lines)
- `apps/api/src/jobs/scheduler.ts` (new cron registration)
- `SESSION_120_HANDOFF.md` (this file)

## Validation

- `npm run db:migrate` → 1 applied
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 4-scenario end-to-end smoke against dev DB:
  - **A. Baseline accrual run:** 6 properties processed, 6 accrued.
    Sample property: 9 long-term units × $2/unit = $18 total ✓
  - **C. Idempotency:** second run returns
    `feesAccrued=0, skippedAlreadyAccrued=6` ✓
  - **D. Per-landlord override:** $1.50/unit + $5/min applied;
    same 9 units now bill $13.50 (was $18) ✓
  - **E. Tenant-payer path:** accrual row created with
    `payer='tenant'`, `platform_revenue_ledger_id=null`, no
    ledger entry posted (correctly waiting for the rent charge to
    consume it later) ✓

Dev DB returned to zero accruals + zero overrides post-test. The
one remaining `platform_revenue_ledger` row (`banking_spread`) is
pre-existing seed data, not S120 pollution.

## What this session did NOT do

- **No tenant-payer rent-charge integration.** The accrual row is
  written with `payer='tenant'` but no code path yet consults
  unpaid tenant-payer accruals when the tenant pays rent. Future
  session: extend the `POST /api/payments/:id/pay` route (S117) to
  query for any unpaid tenant-payer `platform_fee_accruals` rows
  on the property and add their `total_amount` to
  `application_fee_amount`. Then mark the accrual row as paid via
  `tenant_charge_id`. Scope: half session.
- **No frontend.** Per UI/UX standing rule.
- **No live Stripe API exercise.** This session is pure GAM-side
  ledger math; no Stripe calls. The Connect rebuild's Stripe paths
  (S115 onboarding, S116 destination charges, S117 webhooks, S119
  PM transfers) all need sandbox testing post-contract.
- **No reconciliation cron for failed accruals.** If the cron fires
  and a single property errors out, the rest still process and the
  error gets logged; no automatic retry. Re-running the cron
  manually after a fix is the recovery path (idempotency makes it
  safe).

## Pre-launch blockers — STATUS

All seven rebuild sessions complete:
- ✅ S114 — Connect Express + pricing schema
- ✅ S115 — Connect onboarding flow (account create + Account Session)
- ✅ S116 — Destination charges + allocation engine refactor
- ✅ S117 — Tenant rent-pay route + payout/dispute webhooks
- ✅ S118 — GAM-native dashboard backend
- ✅ S119 — PM Companies money-flow refactor (Stripe Transfers)
- ✅ S120 — Per-occupied-unit platform fee accrual cron

Open items NOT in the rebuild:
- Item 16 batch 3+ (OTP under Connect) — gated on rate retry
  workflow, separate session
- Item 10 (utility billing payment) — composes naturally with
  destination charges; thin session to add `application_fee_amount`
  computation for utility line items
- Tenant-payer platform-fee passthrough on rent charges — future
  half-session per S120 above
- Reconciliation jobs for failed PM transfers + failed accruals
- ACH retry workflow (NACHA permits up to 2 retries)
- Frontend pass — payouts list, disputes inbox, payment history,
  PM company management UI, owner pm-impact dashboard, platform
  fee preview in landlord settings

## What next session should target

**Stripe sandbox end-to-end smoke.** With the contract sign-by date of
May 18 ahead, the next valuable thing is exercising the full chain
in Stripe's test mode:
1. Test STRIPE_SECRET_KEY in sandbox
2. Connect onboarding flow → real Connect Express account created
3. Destination charge → real PaymentIntent firing
4. account.updated, payout.*, charge.dispute.* webhooks landing
5. PM Transfer firing (validates whether plain transfers work or
   need source_transaction)
6. Manual payout schedule honored

If any path fails in sandbox, those become the priority sessions
before contract sign. If all pass, the May 18 deadline is met and
the next priority is the frontend pass.

After sandbox validation: pick from the "open items not in the
rebuild" list above based on whatever's most acutely blocking
launch readiness.

## Quick reference: full Stripe Connect rebuild bill of materials

**Schema additions** (S114, S115, S117, S119, S120):
- `users.stripe_connect_account_id`
- `users.stripe_connect_status_synced_at`
- `pm_companies.stripe_connect_account_id`
- `pm_companies.stripe_connect_status_synced_at`
- `property_allocation_rules.{ach,card,platform}_fee_payer` (replaced `banking_fee_payer`)
- `user_balance_ledger.stripe_transfer_id`
- New `platform_fee_config` (with $2/$10 seed)
- New `landlord_platform_fee_overrides`
- New `platform_fee_accruals`
- New `connect_payouts`
- New `connect_disputes`
- `platform_revenue_ledger.type` CHECK extended to include
  `platform_fee_subscription`

**Routes added/refactored:**
- `POST /api/stripe/connect/onboarding-session` (S115)
- `GET /api/stripe/connect/status` (S115)
- `POST /api/payments/:id/pay` (S117)
- `GET /api/landlords/me/payouts` (S118)
- `GET /api/landlords/me/disputes` (S118)
- `POST /api/landlords/me/disputes/:id/respond` (S118)
- `GET /api/landlords/me/payments-history` (S118)
- `GET /api/pm/companies/:id/payouts` (S118)
- `routes/properties.ts` allocation rule POST refactored to three toggles (S116)

**Service-layer additions:**
- `services/stripeConnect.ts` (new): `ensureConnectAccount`,
  `createOnboardingSession`, `fetchAccountStatus`,
  `recordAccountUpdated`, `createRentDestinationCharge`,
  `computeApplicationFee`, `recordPayoutEvent`,
  `recordDisputeEvent`, `createPmCompanyTransfer`,
  `firePmTransfersForReference`
- `services/allocation.ts` refactored to read 3-toggle fee model

**Webhook handlers added:**
- `account.updated`
- `payout.created`, `payout.paid`, `payout.failed`, `payout.canceled`
- `charge.dispute.created`, `charge.dispute.updated`,
  `charge.dispute.closed`

**Crons added:**
- 1:30am Phoenix monthly: `processPlatformFeeAccrual`

**Crons retired:**
- Old `banking_fee_payer` field, `disbursements.stripe_payout_id`
  legacy update path (replaced by Connect webhooks writing to
  `connect_payouts`)

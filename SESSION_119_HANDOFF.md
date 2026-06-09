# Session 119 Handoff

**Theme:** Stripe Connect rebuild — Session 6. PM Companies money-flow
refactor under destination charges. Adds a `stripe_transfer_id` column
on `user_balance_ledger`, a `createPmCompanyTransfer` Stripe API helper,
and a generic `firePmTransfersForReference(referenceType, referenceId)`
function that turns "ghost" PM cut ledger entries into real Stripe
Transfers from platform → PM company's Connect account. Wired into
all three PM cut sites (per-payment allocation, monthly accrual,
leasing fee).

## Architecture decisions

**Post-commit firing pattern.** Stripe API calls happen AFTER the DB
transaction commits, not inside it. Reasons: webhook handlers and
allocation engine should not hold transaction locks across unbounded
network round-trips; if Stripe fails, the ledger row sits without a
transfer id and a future reconciliation job retries (vs aborting the
allocation entirely on a transient Stripe blip). Implementation: each
of the three PM cut sites does its DB work inside a transaction,
COMMITs, then calls `firePmTransfersForReference` outside the tx.

**`firePmTransfersForReference` is generic over reference_type.** Same
helper drives all three sites by accepting `('payment' |
'pm_monthly_fee_accrual' | 'lease', referenceId)`. SELECTs unfired
`allocation_pm_company_fee` rows for that reference, fires a Stripe
Transfer per row, stamps the resulting transfer id back. One code
path, three callers.

**Idempotent on `stripe_transfer_id`.** The helper SELECTs only rows
where `stripe_transfer_id IS NULL`. A successfully-fired row gets
skipped on subsequent calls. The new partial UNIQUE index on the
column prevents accidental double-fires (two rows can't share the
same Stripe transfer id).

**Errors logged, not thrown.** A Stripe API failure on a single row
is logged + counted as `failed`, but the helper continues to the
next row. The failed row stays without a transfer id and is eligible
for re-firing later. Caller (webhook handler / accrual job / lease
build) wraps the helper in its own try/catch so even a catastrophic
failure inside the helper doesn't crash the upstream flow.

**Source-of-funds left to Stripe.** The transfer is from the GAM
platform balance to the PM company's Connect account. Under
destination-charge model the platform balance only contains the
`application_fee_amount` from each charge — likely insufficient on
its own to fund the PM cut. Stripe's `source_transaction` parameter
on Transfer can route funds via a specific charge, but the helper
doesn't pass it today (would require a stripe_charge_id lookup per
ledger row). Sandbox testing post-contract will validate whether the
plain transfer works or needs source_transaction layered in.

## Shipped

### Migration `20260504080000_user_balance_ledger_stripe_transfer.sql`

Adds `stripe_transfer_id text` (nullable) to `user_balance_ledger`
plus a partial UNIQUE index on the column where NOT NULL. Schema
regenerated 8287 → 8295 lines.

### apps/api/src/services/stripeConnect.ts

Two new exports:

- **`createPmCompanyTransfer(opts)`** — wraps `stripe.transfers.create`
  with the right shape. Optional `sourceTransactionId` for future
  use. Returns the Stripe Transfer object.
- **`firePmTransfersForReference(referenceType, referenceId)`** —
  generic post-commit firing. Returns `{ fired, failed }` counts.
  Skips rows that already have a transfer id, skips rows whose
  user has no Connect account (logs warning).

### Three call-site integrations

- **Rent flow** (`routes/webhooks.ts payment_intent.succeeded`):
  fires `firePmTransfersForReference('payment', payment.id)` after
  the allocation transaction commits. Iterates `settledRows`
  hoisted out of the try block so it's accessible post-finally.
- **Monthly accrual** (`jobs/monthlyFeeAccrual.ts:accruePmCompanyFee`):
  fires `firePmTransfersForReference('pm_monthly_fee_accrual',
  accrualId)` immediately after `client.query('COMMIT')`. Errors
  logged, accrual outcome still returns 'accrued' (the ledger entry
  did successfully land; only the Stripe Transfer side is at-risk).
- **Leasing fee** (`routes/esign.ts buildLeaseFromDocument` callsite):
  fires `firePmTransfersForReference('lease', leaseResult.leaseId)`
  immediately after the build returns. Same error-logging posture.

## Files touched

- `apps/api/src/db/migrations/20260504080000_user_balance_ledger_stripe_transfer.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated, 8287 → 8295 lines)
- `apps/api/src/services/stripeConnect.ts` (2 new exports)
- `apps/api/src/routes/webhooks.ts` (rent-flow integration + settledRows hoist)
- `apps/api/src/jobs/monthlyFeeAccrual.ts` (post-commit fire)
- `apps/api/src/routes/esign.ts` (post-commit fire after lease build)
- `SESSION_119_HANDOFF.md` (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 3-step end-to-end smoke against dev DB:
  - **A.** Already-fired row skipped via `WHERE stripe_transfer_id IS NULL`
    + wrong-type row skipped via `WHERE type='allocation_pm_company_fee'`
    → helper returns `{ fired: 0, failed: 0 }` for that reference; r1's
    transfer_id stayed unchanged ✓
  - **B.** Unfired row whose user has no Connect account: helper logs
    warning, returns `{ fired: 0, failed: 1 }`, ledger row stays
    without transfer_id (eligible for retry) ✓
  - **C.** Wrong-type ledger entry (manager_fee on same payment) never
    picked up by the type filter ✓

Live `stripe.transfers.create` deferred to sandbox post-contract
(May 18). Validation in sandbox will confirm whether plain Transfer
works or whether `source_transaction` layering is needed for funding.

## What this session did NOT do

- **No live Stripe Transfer call.** Schema + helper + wiring verified;
  the actual API call exercises in sandbox.
- **No `source_transaction` linkage.** The helper accepts the optional
  parameter but no caller passes it. Sandbox testing decides whether
  we need it. If yes, we add a `payments.stripe_charge_id` column or
  query Stripe to resolve the charge id from the PaymentIntent and
  pass it through.
- **No reconciliation job for failed transfers.** Rows with
  `stripe_transfer_id IS NULL` after a fire-attempt sit unfired
  indefinitely. A daily cron that re-runs `firePmTransfersForReference`
  on stale rows is a quarter-day session.
- **No frontend.** Per UI/UX standing rule.

## Pre-launch blockers still open

- ~~Tenant rent-pay route~~ — closed S117
- ~~Connect payout/dispute schema + webhooks~~ — closed S117
- ~~Native dashboard backend~~ — closed S118
- ~~PM Companies money-flow refactor~~ — closed S119
- Item 16 batch 3+ (OTP under Connect) — gated on rate retry workflow
- Item 10 (utility billing payment) — composes naturally with destination charges
- S120 — Per-occupied-unit platform fee accrual cron

## What next session (S120) targets

Final session in the rebuild plan. The per-occupied-unit platform fee
accrual cron — last piece needed for the locked $2/unit + $10/property
SaaS pricing to actually bill landlords monthly.

Concretely:
1. New table `platform_fee_accruals` already exists from S114 with
   the snapshot fields (long_term_unit_count, short_stay_nights,
   short_stay_equivalent, total_billable, rate_per_unit,
   min_per_property, total_amount, payer)
2. New cron handler in `jobs/scheduler.ts` (or new file) that fires
   monthly:
   - Walks every active landlord
   - For each property: classifies units per the locked S113 rule
     (long-term lease overlap + short-stay nights aggregated)
   - Computes total_billable = long_term_count + CEIL(short_stay_nights/30)
   - Looks up rate via `landlord_platform_fee_overrides` →
     `platform_fee_config` cascade
   - Computes fee = MAX(rate × total_billable, min_per_property)
   - Posts a `platform_revenue_ledger` entry attributed to the
     landlord (when `platform_fee_payer='landlord'`) OR adds it to
     the next rent charge as a tenant-passthrough item (when
     `platform_fee_payer='tenant'`)
3. Idempotency via UNIQUE(landlord_id, property_id, accrual_month)
   already in place from S114
4. Snapshot fields preserve historical billing under future rate edits

S120 is one focused session. Realistic to ship before May 18.

After S120, the Stripe Connect rebuild is feature-complete on the
backend. Frontend pass + sandbox testing close out the May 18
contract sign.

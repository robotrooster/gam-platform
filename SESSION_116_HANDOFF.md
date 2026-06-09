# Session 116 Handoff

**Theme:** Stripe Connect rebuild — Session 3. Allocation engine
refactor + destination-charge helper + `banking_fee_payer` retired.
Three-toggle fee model (S114) is now the live shape; the legacy
column is dropped.

## Architecture decisions

**`computeApplicationFee` is the single source of truth for GAM's cut.**
Pure function, no DB access. Inputs: amount, payment method,
optional card country. Output: dollar amount GAM keeps as
`application_fee_amount` on the destination charge. Rates from S113
locked numbers (1.0% ACH cap $6, 3.25% card flat, +1.5% Canadian
surcharge). Used at charge time by `createRentDestinationCharge` and
will be reused by any future fee-needs-computing site (utility,
deposit, leasing fee). Centralizing it here prevents rate drift
across charge sites.

**Allocation engine reads the three S114 toggles, not `banking_fee_payer`.**
The fee toggle that applies depends on the payment method:
- ACH payment → `ach_fee_payer` decides whether tenant pays the
  processing fee on top or landlord absorbs from gross
- Card payment → `card_fee_payer` does the same for the 3.25% card fee
- `platform_fee_payer` is unrelated to per-payment processing — it
  governs the monthly platform fee accrual (S120)

**Legacy `banking_fee_payer` column dropped.** Migration
`20260504060000_drop_banking_fee_payer.sql` removes the column +
its CHECK constraint after the route layer was updated to write the
three new fields. The route still accepts a legacy `banking_fee_payer`
BODY field for backward compat (mirrors into `ach_fee_payer` +
`card_fee_payer` when those aren't supplied) — but it's never
written to the column.

**Ledger model preserved alongside Stripe destination charges.** The
allocation engine still writes `user_balance_ledger` rows for
`allocation_owner_share` / `allocation_manager_fee` /
`allocation_pm_company_fee` even though Stripe handles the actual
money split via `transfer_data.destination`. Reasoning: those rows
are GAM's accounting + audit trail — the dashboard queries, the
owner-visibility view (S110), the PM cut-tracking (S110+) all read
the ledger. Replacing them with Stripe's API is a bigger refactor
that's not worth doing this session. The ledger entries become
audit records of what Stripe already did, not money-movement
directives.

**Generic `FEE_PAYER_VALUES` in shared package replaces
`BANKING_FEE_PAYER_VALUES`.** Same `['landlord','tenant']` shape but
the name reflects that it's the union for all three S116 toggles, not
just banking. Old name kept as deprecated alias for one cycle so
external consumers (frontend) don't break on import.

## Shipped

### Migration `20260504060000_drop_banking_fee_payer.sql`

Drops `banking_fee_payer` column + its CHECK constraint from
`property_allocation_rules`. Schema regenerated to 8137 lines (down
from 8146 — column drop more than offsets the new
`stripe_connect_status_synced_at` columns from S115).

### packages/shared/src/index.ts

- New `FEE_PAYER_VALUES` + `FeePayer` type — generic union.
- `BANKING_FEE_PAYER_VALUES` and `BankingFeePayer` retained as
  `@deprecated` aliases pointing at the new exports.

### apps/api/src/services/allocation.ts

- `PropertyAndRuleRow` interface drops `banking_fee_payer`, gains
  `ach_fee_payer`, `card_fee_payer`, `platform_fee_payer`
- Splittable computation reads the right toggle by payment method
- Allocation rule existence check now confirms ach + card are
  non-null (LEFT JOIN miss = no rule = 409)
- Header comment updated to document the trigger split

### apps/api/src/services/stripeConnect.ts

Two new exports:

- **`computeApplicationFee({ amount, paymentMethod, cardCountry? })`**
  — pure function. Returns dollar amount.
- **`createRentDestinationCharge(opts)`** — wraps
  `stripe.paymentIntents.create` with `transfer_data.destination` set
  to the recipient's Connect account and `application_fee_amount` set
  to GAM's cut. Handles ACH-specific mandate_data + financial_connections
  config conditionally based on `paymentMethodTypes`.

### apps/api/src/routes/properties.ts

- Allocation rule body schema: three new optional fields
  (`ach_fee_payer`, `card_fee_payer`, `platform_fee_payer` defaulting
  to 'landlord') + `banking_fee_payer` accepted as legacy
- `.refine()` requires either (ach + card) or legacy banking — caller
  can use either shape; new fields take precedence
- Allocation rule INSERT writes the three new columns; legacy mirror
  applied when the caller used the old shape
- Import switched from `BANKING_FEE_PAYER_VALUES` to `FEE_PAYER_VALUES`

## Files touched

- `apps/api/src/db/migrations/20260504060000_drop_banking_fee_payer.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated, 8146 → 8137 lines)
- `packages/shared/src/index.ts` (new FEE_PAYER_VALUES; old name deprecated alias)
- `apps/api/src/services/allocation.ts` (toggle reads, header comment)
- `apps/api/src/services/stripeConnect.ts` (computeApplicationFee + createRentDestinationCharge)
- `apps/api/src/routes/properties.ts` (three-toggle + legacy fallback schema, INSERT update)
- `SESSION_116_HANDOFF.md` (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 8137 lines
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- `npm run build` in `packages/shared` → exit 0
- End-to-end smoke (Node ts-node, real `executeRentAllocation`):
  - **A. computeApplicationFee** across 5 cases:
    - ACH $1000 → $6.00 (cap fires) ✓
    - ACH $400 → $4.00 (uncapped) ✓
    - ACH $50 → $0.50 ✓
    - Card $1000 US → $32.50 (3.25%) ✓
    - Card $1000 CA → $47.50 (3.25% + 1.5% surcharge) ✓
  - **B1. ACH with `ach_fee_payer='tenant'`**, $1000 rent →
    `allocation_owner_share = $1000.00` (tenant covered the fee,
    landlord receives full gross) ✓
  - **B2. Card with `card_fee_payer='landlord'`**, $1000 rent →
    `allocation_owner_share = $967.20` (landlord absorbed
    $0.30 + 3.25% × $1000 = $32.80 fee) ✓
- Dev DB returned to zero post-test

## What this session did NOT do

- **No live Stripe API call yet.** `createRentDestinationCharge`
  defined but not yet called from any route. The actual "tenant
  pays rent" route doesn't exist. S117 wires the rent-payment route
  + the route that triggers the destination charge.
- **No webhook handler for `payout.created` / `payout.failed` /
  `charge.dispute.created`.** Those are S117 work. `account.updated`
  was wired in S115; that's the only Connect event GAM listens for
  today.
- **No PM Companies money-flow refactor.** The S107–S112 PM ledger
  entries still post via `executeRentAllocation`. Under destination
  charges, the PM cut becomes a Stripe `Transfer` from the landlord's
  Connect to the PM's Connect after settlement. S119 work.
- **No platform fee accrual cron.** Schema is ready (S114). The
  monthly job that walks landlords, computes long-term + short-stay
  aggregation per the locked RV/STR rule, and posts to
  `platform_fee_accruals` lands in S120.
- **No frontend.** Per UI/UX standing rule.

## Pre-launch blockers still open

Same as S115 minus the closed `banking_fee_payer` deprecation:
- Item 16 batch 3+ (OTP under Connect) — gated on S117+
- Item 10 (utility billing payment) — composes with destination
  charges naturally
- Plus S117–S120 of the rebuild plan

## What next session (S117) targets

Webhook handlers + the rent-payment route. Concretely:

1. **Build the rent-payment route.** Today there's no route that
   creates a rent PaymentIntent. Tenants need a way to pay rent
   that consumes `createRentDestinationCharge` + computes
   `application_fee_amount`. Probably mounted under
   `/api/payments/rent` (or extends an existing `/api/payments`
   endpoint). Auth: tenant pays for their own lease only.
2. **Webhook handler — `payout.created`, `payout.failed`,
   `payout.paid` for Connect accounts.** The existing `payout.paid`
   handler updates the legacy `disbursements` table; under Connect
   each landlord's Connect account has its own payouts. Need to
   either repoint that handler to a new `connect_payouts` table or
   extend it to handle both legacy + Connect payouts.
3. **Webhook handler — `charge.dispute.created`.** Disputes hit
   GAM's platform balance (loss responsibility = application). Need
   a `disputes` table + handler that records and surfaces them.
4. **Webhook handler — `payment_intent.payment_failed` retry logic.**
   Existing handler just sets status='failed'. Should also kick a
   retry workflow for ACH (NACHA permits up to 2 retries per
   transaction).
5. **Per-Connect-account payout schedule config** — when a landlord
   completes onboarding, set their Connect account to manual payout
   schedule so GAM controls the auto-Friday cadence.

S117 is the heaviest of the remaining sessions. May spill across
S117a/b. After that, S118 (GAM-native dashboard backend), S119 (PM
money-flow refactor), S120 (platform fee accrual cron) are all
focused individual sessions.

May 18 contract sign deadline still on track.

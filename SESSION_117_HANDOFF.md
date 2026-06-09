# Session 117 Handoff

**Theme:** Stripe Connect rebuild — Session 4. Tenant rent-pay route +
Connect payout/dispute schema + the four corresponding webhook handlers
+ manual payout schedule on Connect account creation.

The destination-charge plumbing from S116 is now actually invokable:
a tenant can hit `POST /api/payments/:id/pay` to pay a pending rent
payment, and the Stripe events emitted as a result land in GAM-side
audit tables.

## Architecture decisions

**Tenant-initiated rent payments via destination charges.** Pre-S117
there was no GAM route a tenant could call to actually pay rent —
`POST /api/payments/initiate-rent-collection` is admin-only and
created pending rows without firing charges. S117 closes the gap:
the new endpoint accepts a tenant's saved `payment_method_id`,
computes `application_fee_amount` via S116's pure function, calls
`createRentDestinationCharge`, stamps `stripe_payment_intent_id` on
the payment row, and flips status to `processing` (ACH) or `settled`
(card — instant capture). The webhook handler later converts ACH
'processing' → 'settled' on `payment_intent.succeeded`.

**Card payments mark status='settled' synchronously.** Card charges
authorize and capture instantly when `confirm: true` is passed; ACH
takes 3–5 business days to settle. The route picks the right initial
status per payment method.

**Pre-flight check on landlord's `charges_enabled`.** Before creating
the destination charge, the route calls `stripe.accounts.retrieve` on
the landlord's Connect account and verifies `charges_enabled === true`.
If the landlord's KYC is incomplete, the tenant gets a clean 409 with
"onboarding incomplete — payments not yet enabled" rather than a
cryptic Stripe error. One extra round-trip per payment but worth the
UX.

**Cross-platform safety on payout webhooks.** Stripe sends
`payout.*` events with `event.account` set to the Connect account id
of the entity being paid out. `recordPayoutEvent` looks up the GAM
entity (user OR pm_company) via `stripe_connect_account_id`. Unknown
account ids are silent no-ops — defends against Stripe webhook
endpoints receiving events for other Stripe platforms.

**Manual payout schedule on Connect account creation.** Set at
`accounts.create` time via `settings.payouts.schedule.interval =
'manual'`. Without this, Stripe defaults to a daily payout schedule
on each Connect account, and GAM loses control of the auto-Friday
batching cadence. Setting it manual means GAM triggers each payout
explicitly via `Payout.create()` against the connected account.

**Disputes attribute to GAM payment + landlord via PaymentIntent
match.** When a dispute fires, GAM looks up the original payment via
`stripe_payment_intent_id` on the `payments` table; if found, the
dispute's `payment_id` and `landlord_id` are populated. If the
PaymentIntent isn't on a known GAM payment (e.g. a background-check
fee chargeback), those fields stay null — the dispute is still
recorded for the platform-level dashboard.

**`connect_disputes` status enum mirrors Stripe's exactly.** All eight
Stripe dispute statuses (`warning_needs_response`, `warning_under_review`,
`warning_closed`, `needs_response`, `under_review`, `charge_refunded`,
`won`, `lost`) are in the CHECK constraint so GAM can transition through
each Stripe sends. Avoids the brittleness of mapping to a smaller
GAM-local enum.

**Legacy `disbursements` table left alone.** The old `payout.paid`
handler that wrote to `disbursements` is replaced by the four new
Connect-aware handlers. The `disbursements` table itself is kept —
S119 (PM Companies money-flow refactor) decides whether to migrate
its rows to `connect_payouts` or retire it. For S117, only the
write path moves.

## Shipped

### Migration `20260504070000_connect_payouts_disputes.sql`

Two new tables:
- **`connect_payouts`** — one row per Stripe Payout. UNIQUE on
  `stripe_payout_id` (idempotent webhook handling). Stores
  user_id OR pm_company_id, amount, status, destination_bank_id,
  arrival_date, failure_code/message. Status CHECK:
  `pending|paid|failed|canceled|in_transit`.
- **`connect_disputes`** — one row per Stripe Dispute. UNIQUE on
  `stripe_dispute_id`. Stores GAM-side attribution (payment_id,
  landlord_id), amount, reason, status, evidence_due_by, response
  tracking, outcome. Status CHECK matches Stripe's eight statuses.

Indexes: payouts by user/pm-company status + by Connect account;
disputes by landlord status + a partial index on pending disputes
(needs_response / warning_needs_response) for the response-soon
query the dashboard runs.

### apps/api/src/services/stripeConnect.ts

- `createConnectAccount` now sets
  `settings.payouts.schedule.interval = 'manual'` so GAM controls
  payout cadence
- New `recordPayoutEvent(payout, accountId)` — UPSERT into
  `connect_payouts` keyed on `stripe_payout_id`. Resolves user vs
  pm_company via the Connect account id. Cross-platform-safe.
- New `recordDisputeEvent(dispute)` — UPSERT into `connect_disputes`
  keyed on `stripe_dispute_id`. Attributes to GAM payment +
  landlord via `stripe_payment_intent_id` match.

### apps/api/src/routes/payments.ts

New endpoint: `POST /api/payments/:id/pay`
- Body: `{ payment_method_id: string, payment_method_type: 'ach'|'card' }`
- Auth: tenant only; verifies the payment row's `tenant_id` matches
- Validates: payment isn't already settled or in flight; tenant has
  Stripe customer; landlord has Connect account; landlord's account
  is `charges_enabled`
- Reads card country from PaymentMethod for Canadian-USD surcharge
- Calls `computeApplicationFee` + `createRentDestinationCharge`
- Stamps `stripe_payment_intent_id`, flips status to processing/settled
- Returns `{ paymentIntentId, status, applicationFeeAmount }`

### apps/api/src/routes/webhooks.ts

Four new handler cases:
- `payout.created`, `payout.paid`, `payout.failed`, `payout.canceled`
  → all dispatch through `recordPayoutEvent`. Old `payout.paid`
  handler (which wrote to `disbursements`) replaced.
- `charge.dispute.created`, `charge.dispute.updated`,
  `charge.dispute.closed` → all dispatch through `recordDisputeEvent`.

Each returns 500 on SQL failure so Stripe retries with backoff.

## Files touched

- `apps/api/src/db/migrations/20260504070000_connect_payouts_disputes.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated, 8137 → 8287 lines)
- `apps/api/src/services/stripeConnect.ts` (manual payout schedule + 2 webhook recorders)
- `apps/api/src/routes/webhooks.ts` (7 new event types handled across 2 dispatchers)
- `apps/api/src/routes/payments.ts` (POST /:id/pay)
- `SESSION_117_HANDOFF.md` (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 8287 lines
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 7-step end-to-end smoke against dev DB:
  1. `recordPayoutEvent` INSERT with user attribution + cents-to-dollars
     conversion ✓
  2. Idempotency + status transition (UPSERT on `stripe_payout_id`) ✓
  3. Cross-platform no-op (unknown Connect account = no row inserted) ✓
  4. `recordDisputeEvent` INSERT with payment attribution via
     `stripe_payment_intent_id` match ✓
  5. Dispute status transition (UPSERT on `stripe_dispute_id`) ✓
  6. CHECK on `connect_payouts.status` rejects bad enum value ✓
  7. CHECK on `connect_disputes.status` rejects bad enum value ✓

Live Stripe API calls (PaymentIntent creation, Account retrieval,
PaymentMethod retrieval) require sandbox testing post-contract.

## What this session did NOT do

- **No live Stripe sandbox exercise.** Smoke verified the SQL paths
  + webhook handler shape. The actual destination-charge call
  (`stripe.paymentIntents.create` with `transfer_data.destination`)
  is exercised end-to-end after May 18 contract sign in Stripe's
  test mode.
- **No ACH retry workflow** on `payment_intent.payment_failed`.
  Existing handler still just sets `status='failed'`. NACHA permits
  up to 2 retries per transaction; the retry queue + cooldown logic
  is its own session.
- **No PM Companies money-flow refactor.** S107–S112 PM cuts still
  post via `executeRentAllocation` to `user_balance_ledger`. Under
  destination charges, the PM cut should become a Stripe `Transfer`
  from landlord's Connect to PM's Connect after settlement. S119 work.
- **No GAM-native dashboard backend.** S118 builds the routes that
  serve `connect_payouts` + `connect_disputes` data + a generic
  Stripe payments listing for the landlord portal.
- **No legacy `disbursements` table migration.** Existing rows
  (mostly empty in dev; some test data in prod will need a
  one-shot migration script) remain. S119 decides what to do with
  them.

## Pre-launch blockers still open

Same as S116 minus what S117 closed:
- ~~"No tenant rent-pay route"~~ — closed
- ~~"No Connect payout webhooks"~~ — closed
- ~~"No dispute tracking"~~ — closed
- Item 16 batch 3+ (OTP under Connect) — gated on rate config + retry
  workflow
- Item 10 (utility billing payment) — composes with destination
  charges naturally
- Plus S118–S120 of the rebuild plan

## What next session (S118) targets

GAM-native dashboard backend. The frontend renders payouts, account
state, payment history, disputes — but per the locked architecture,
GAM does NOT embed Stripe components for these (only the onboarding
component). Routes to build:

1. `GET /api/landlords/me/payouts` — paginated list of
   `connect_payouts` for the caller's user_id, with property/tenant
   context joined in
2. `GET /api/pm/companies/:id/payouts` — same shape for PM company
   staff (active staff role required)
3. `GET /api/landlords/me/disputes` — pending + recent disputes for
   the landlord
4. `POST /api/landlords/me/disputes/:id/respond` — submit response
   evidence to Stripe (calls `stripe.disputes.update` with evidence)
5. `GET /api/landlords/me/payments-history` — paginated charge
   history (joins `payments` + `connect_payouts` for the
   "rent-collected → payout-arrived" timeline)

S118 is straightforward route + query work. After S118 the surface
is feature-complete except for S119 (PM money-flow refactor) and
S120 (platform fee accrual cron).

May 18 contract deadline still on track.

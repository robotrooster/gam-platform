# Session 122 Handoff

**Theme:** Item 10 — utility billing payment integration. Closes the
gap that's been open since S90: utility_bills had a schema and a
generation engine but no way for tenants to actually pay them. New
tenant-facing route plus webhook integration ties utility payments
into the existing destination-charge + allocation-engine pipeline
without duplicating the rent-pay flow.

## Architecture decisions

**Utility payments reuse the rent-pay infrastructure.** Same
`createRentDestinationCharge` helper, same `computeApplicationFee`
math, same allocation engine, same PM transfer firing. The only
differences:
- New tenant route at `POST /api/utility/bills/:id/pay` that wraps
  the steps (bill validation → create payments row → fire charge)
- Allocation engine's webhook branch widened from `type='rent'` to
  `type IN ('rent','utility')`
- Post-allocation hook flips `utility_bills.status='paid'`

This is the cleanest integration. No new Stripe-side concepts; no
new destination-charge variant; no new allocation type.

**Bill must be in 'billed' status to pay.** The S90 generator
creates bills in 'unbilled' state. Landlord finalizes (separate
flow — possibly a future `POST /api/utility/bills/:id/finalize`)
which transitions to 'billed'. The pay route refuses 'unbilled',
'paid', 'void', and 'disputed'. Status discriminator prevents
accidental double-charges and forces the landlord-side workflow
to commit before tenants are billed.

**Bill links to payments row via `payment_id`.** Pre-existing
nullable column on `utility_bills`. Route inserts the payments row
first, then UPDATEs `utility_bills.payment_id`. If the Stripe call
later fails, the linked-but-unsettled payments row is recoverable:
`bill.payment_id IS NOT NULL` triggers the "already in flight" guard
on retry, forcing manual cleanup. Future reconciliation cron could
auto-clear stuck rows older than N days.

**Allocation engine runs identically for utility.** Manager fees,
PM cuts, banking spreads — all compute against utility amounts the
same way they do for rent. Per-property allocation rule applies
once and once only; if a landlord wants different splits for rent
vs utility, that's a future product feature, not a bug.

## Shipped

### apps/api/src/routes/utility.ts

New endpoint: `POST /api/utility/bills/:id/pay`
- Body: `{ payment_method_id, payment_method_type: 'ach'|'card' }`
- Auth: tenant only; verifies the bill's `tenant_id` matches caller
- Validates: bill is in `billed` status; not already linked to a
  payment; tenant has Stripe customer; landlord has Connect account;
  Connect account is `charges_enabled`
- Creates payments row (`type='utility'`,
  `entry_description='UTILITY'`) and links via
  `utility_bills.payment_id`
- Calls `computeApplicationFee` + `createRentDestinationCharge`
- Stamps `stripe_payment_intent_id` + status (settled for card,
  processing for ACH)
- Returns `{ paymentIntentId, status, applicationFeeAmount, billId,
  paymentId }`

### apps/api/src/routes/webhooks.ts

`payment_intent.succeeded` handler extended:
- Allocation now runs for `type IN ('rent','utility')` (was rent only)
- New post-allocation step: when `row.type === 'utility'`, UPDATEs
  the linked `utility_bills` row to `status='paid'`,
  `paid_at=NOW()`. Inside the same transaction so the flip is
  atomic with the allocation entries.
- PM transfer post-commit firing also extended to utility payments
  (any payment with a PM-managed property's destination charge
  needs the same Stripe Transfer follow-up).

## Files touched

- `apps/api/src/routes/utility.ts` (new endpoint)
- `apps/api/src/routes/webhooks.ts` (allocation widened to utility +
  post-settlement bill flip + PM transfer firing for utility)
- `SESSION_122_HANDOFF.md` (this file)

No migrations, no schema changes (utility_bills.payment_id +
payments.type='utility' + entry_description='UTILITY' all pre-existed).

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 5-step end-to-end smoke against dev DB:
  - **A.** Route SELECT joins utility_bill → tenant → landlord →
    users; surfaces `stripe_customer_id` and `stripe_connect_account_id`
    correctly ✓
  - **B.** payments INSERT with `type='utility'` + bill.payment_id
    link both work; CHECK constraints pass ✓
  - **C.** Webhook simulation: payment → settled → utility_bill flips
    to status='paid', paid_at stamped ✓
  - **D.** "Bill already has payment" pre-flight guard works ✓
  - **E.** "Bill is unbilled" pre-flight guard works ✓

Live Stripe destination charge deferred to sandbox post-contract.

## What this session did NOT do

- **No landlord finalize-bill route.** Bills sit in 'unbilled' until
  someone marks them 'billed'. S90 generator emits 'unbilled'; no
  route currently transitions to 'billed'. Half-session add: simple
  `POST /api/utility/bills/:id/finalize` that flips status with a
  permission gate.
- **No tenant-payer platform fee passthrough on utility charges.**
  S121's tenant-payer accrual passthrough only fires on rent payments.
  If a property has `platform_fee_payer='tenant'` and the tenant pays
  a utility bill (but no rent that month), the platform fee accrual
  stays unclaimed. Current model: rent is the primary capture point.
  Future refinement: extend the passthrough lookup to fire on utility
  charges too.
- **No live Stripe smoke.** Schema + route + webhook handler all
  verified in dev DB; the actual destination charge waits on sandbox.
- **No partial payment / dispute flow.** Bill is paid in full or not
  at all. 'disputed' status exists in the CHECK but no route
  transitions to it.
- **No frontend.** Per UI/UX standing rule.

## Pre-launch backend status

Closed during S114–S122 rebuild + post-rebuild gap-closers:
- ✅ Stripe Connect Express + destination charges + manual payouts
- ✅ Tenant rent-pay + tenant utility-pay routes
- ✅ Connect payout/dispute schema + 7 webhook handlers
- ✅ GAM-native dashboard backend (payouts, disputes, history)
- ✅ PM Companies money-flow under destination charges
- ✅ Per-occupied-unit platform fee accrual cron
- ✅ Tenant-payer platform fee passthrough on rent
- ✅ PM transfer reconciliation cron

Open items NOT yet built:
- Landlord finalize-bill route (utility — half session)
- Tenant-payer passthrough extension to utility charges (small)
- ACH retry workflow (NACHA permits up to 2 retries)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Sub-permission gating on routes (catalog defined, enforcement
  deferred since S81)
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- Frontend pass for everything backend-ready

## What next session should target

Same priority order as before — Stripe sandbox validation remains
the highest-priority next move. While waiting:

1. **ACH retry workflow** — NACHA-compliant retry queue for failed
   ACH on `payment_intent.payment_failed`. Includes cooldown logic
   + zero-tolerance gate (S99 patterns).
2. **Sub-permission route gating** — mechanical pass touching most
   route files; catalog already defined.
3. **Landlord finalize-bill route** + tenant-payer passthrough on
   utility (closes the two S122 gaps in one focused half-session).

Recommend **#3** as the next pure-backend follow-up — directly
extends S122 and closes the small-but-loose ends.

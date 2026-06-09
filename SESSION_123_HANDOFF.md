# Session 123 Handoff

**Theme:** Two S122 follow-ups in one focused session — the
landlord finalize-bill route + tenant-payer platform fee passthrough
on utility charges. Closes the small loose ends so the utility
billing path is end-to-end clean from generation through payment.

## Architecture decisions

**`properties.edit` permission for finalize-bill.** Same gate the
meter management routes use. Landlords + scoped workers with
`properties.edit` (S81 sub-permission catalog) can transition
unbilled→billed. Reusing the existing permission key vs adding a
new `payments.finalize_utility` since this is a property-level
admin action, not a payment-collection action.

**`canAccessLandlordResource` ownership check inside the route.**
`requirePerm('properties.edit')` validates the caller has the
permission on SOME landlord; the inner check ensures the bill they're
operating on belongs to that landlord. Same pattern S81 established
for landlord-scoped routes.

**Status transition is one-way: unbilled → billed only.** Pre-flight
rejects any other source status. Future product work might add
`billed → disputed` or `billed → void` paths but those aren't this
session.

**Tenant-payer passthrough on utility uses the same lookup as rent.**
`platform_fee_accruals` are property-scoped; the passthrough doesn't
care which payment instrument actually fires the charge. The route
mirrors S121's rent-pay logic exactly: SELECT unpaid + total_amount
> 0, sum into application_fee_amount, atomic UPDATE post-charge with
the race-safe `tenant_charge_id IS NULL` filter.

**Property-id resolution via the bill's unit.** `utility_bills`
doesn't carry property_id directly (resolves via `unit.property_id`).
Adds one extra query at pay time but avoids a schema change. Future
denormalization could add `utility_bills.property_id` if the lookup
becomes a perf bottleneck.

## Shipped

### apps/api/src/routes/utility.ts

Two new pieces:

- **`POST /api/utility/bills/:id/finalize`** — landlord/admin
  transitions a bill from `unbilled` to `billed`. `requirePerm('properties.edit')`
  + landlord-resource ownership check. Stamps `billed_at`.
- **Tenant-payer passthrough on `POST /api/utility/bills/:id/pay`**
  — extends the S122 pay route with the same passthrough lookup
  S121 added to the rent-pay route. Looks up unpaid tenant-payer
  `platform_fee_accruals` for the bill's property, sums them onto
  the `application_fee_amount`, atomically claims them post-charge.
  Response payload now includes `platformFeePassthrough` and
  `accrualsClaimed`.

## Files touched

- `apps/api/src/routes/utility.ts` (finalize endpoint + passthrough math)
- `SESSION_123_HANDOFF.md` (this file)

No migrations, no schema changes.

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 5-step smoke against dev DB:
  - **A0/A1.** Unbilled bill → finalize SQL → status='billed',
    billed_at stamped ✓
  - **A2.** Re-finalize pre-flight rejects already-billed bill ✓
  - **B1.** Passthrough lookup picks up the unpaid tenant-payer
    accrual ($14 = 7 units × $2/unit, above $10 min); sum = $14 ✓
  - **B2.** Atomic claim post-charge stamps `tenant_charge_id` ✓
  - **B3.** Re-lookup after claim returns 0 — claimed accrual no
    longer eligible, race-safe filter works ✓

Live Stripe destination charge for utility still deferred to
sandbox post-contract.

## What this session did NOT do

- **No `billed → disputed` or `billed → void` transitions.** The
  status enum allows these values; no route transitions to them
  today. Future product work.
- **No batch finalize-all-bills route.** Bills are finalized
  one-by-one. If a landlord generates 50 bills via S90 and wants
  them all billed, today they call the finalize route 50 times.
  A `POST /api/utility/bills/finalize-batch` body=[ids] is a
  half-session add if needed.
- **No "tenant pays bill that includes the platform fee" UX
  surface.** The response payload tells the frontend the passthrough
  amount; the tenant-facing pay screen needs to display "$X bill
  + $Y platform fee = $Z total" so the tenant sees what they're
  actually paying. Frontend pass.
- **No live Stripe smoke.**

## Pre-launch backend status

S122's two gaps closed. Backend is now feature-complete on:
- ✅ Stripe Connect Express + destination charges + manual payouts
- ✅ Tenant rent-pay route + tenant utility-pay route
- ✅ Connect payout/dispute schema + 7 webhook handlers
- ✅ GAM-native dashboard backend
- ✅ PM Companies money-flow under destination charges
- ✅ Per-occupied-unit platform fee accrual cron
- ✅ Tenant-payer platform fee passthrough on rent + utility
- ✅ PM transfer reconciliation cron
- ✅ Landlord finalize-bill route

Open items still NOT yet built (no longer including the closed S123
items):
- ACH retry workflow (NACHA permits up to 2 retries)
- Sub-permission gating on routes (catalog defined S81)
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

Same priority order — Stripe sandbox testing remains highest-priority
when ready. While waiting:

1. **ACH retry workflow** — NACHA-compliant retry queue. Today
   `payment_intent.payment_failed` just sets status='failed' without
   retry. ~1 session.
2. **Sub-permission gating on routes** — mechanical pass touching
   most route files; catalog already defined.

Recommend **#1** as the next pure-backend follow-up — matters for
NACHA compliance posture before launch and doesn't need product
input.

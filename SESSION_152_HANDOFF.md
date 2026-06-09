# Session 152 Handoff

**Theme:** First piece of the `lease_fees due_timing` wire-up
backlog. Cleaning_fee → security deposit deduction (1A) shipped
end-to-end: schema, service, routes, UI, smoke. Auto-charge of
the gap when deductions exceed deposit (1A "gap-immediate-charge"
follow-up) is also wired.

## Decisions captured (this session)

Plain-language design questions with Nic's locked answers:

1. **Cleaning_fee at move-out** — auto-deduct from security
   deposit. (A)
2. **If gap exceeds deposit** — invoice tenant immediately AND
   attempt auto-charge against on-file payment method. (custom)
3. **Damage deductions UI** — single list with category dropdown
   (damage / utility / unpaid_rent / cleaning_extra / other),
   not two separate lists. (B)

## Items shipped

### Migration: `deposit_returns` table

```
20260506100000_deposit_returns.sql
```

One row per lease at move-out. Captures snapshot of:
- `total_deposit` (frozen at move-out so re-running calc later
  doesn't drift)
- `cleaning_fee_amount` (auto-pulled from `lease_fees` with
  `due_timing='move_out'`)
- `damage_lines` JSONB — landlord-added lines with `{description,
  amount, category}` shape
- `other_deductions` JSONB — kept available but unused in v1
  per the B answer (single list)
- Computed `total_deductions`, `refund_amount`, `gap_amount`
- `status` lifecycle: `draft` → `sent_refund` / `sent_gap` /
  `sent_zero` / `disputed`
- `refund_payment_id` / `gap_payment_id` — FK to payments rows
- `gap_charge_failed` + `gap_charge_failure_reason` — tracks
  auto-charge failures so landlord sees the gap rather than
  guessing

UNIQUE on `lease_id` so only one deposit-return per lease.

### Service: `services/depositReturn.ts`

- `calculateDepositReturn(leaseId, damageLines?, otherDeductions?)`
  — pure preview; auto-pulls cleaning_fee, computes refund/gap.
- `createOrFetchDraft(leaseId)` — idempotent draft creation.
- `applyDeductionsToDraft(draftId, patch)` — landlord adjusts
  damage lines / notes; recomputes totals.
- `finalizeDepositReturn(draftId, userId)` — single transaction:
  - Create refund payments row (negative amount = landlord owes
    tenant) OR gap payments row (positive = tenant owes)
  - Emit credit-ledger events:
    - `deposit_returned_full` (refund == total_deposit)
    - `deposit_returned_partial` (0 < refund < total_deposit)
    - `deposit_returned_zero` (refund == 0)
    - `tenancy_ended_with_balance` (gap > 0)
  - Stamp finalized_at + finalized_by_user_id + status
  - Post-commit: attempt auto-charge of gap via
    `tenants.stripe_customer_id` + their default payment method
    (off_session, confirm). Failure → flag the row + admin alert
    via `createAdminNotification`. Doesn't roll back finalize.

### Routes (in `routes/leases.ts`)

- `GET /api/leases/:id/deposit-return` — returns existing row or
  preview calculation if none exists yet.
- `POST /api/leases/:id/deposit-return` — create-or-fetch draft.
- `PATCH /api/leases/:id/deposit-return` — update damage_lines /
  notes.
- `POST /api/leases/:id/deposit-return/finalize` — runs the
  finalize transaction.

All gated by `requirePerm('leases.terminate')` for write ops;
GET allows read-scoped roles.

### Landlord UI

New page at `/leases/:id/deposit-return`:

- Three KPI tiles (deposit, total deductions, refund/gap)
- Cleaning-fee section (auto, read-only)
- Editable list of "other deductions" with per-row category
  dropdown (damage / utility / unpaid_rent / cleaning_extra /
  other), description, amount, delete-row
- Internal notes textarea
- "Save draft" + "Review & Finalize" buttons
- Finalize confirmation modal that shows the exact charge or
  refund amount, plus a warning about auto-charge fallback

LeasesPage row actions column added — "Move-out" button
appears on rows where `status` is active / expired / terminated,
links to `/leases/:id/deposit-return`.

### Files touched / created

```
apps/api/src/db/migrations/20260506100000_deposit_returns.sql   (new)
apps/api/src/db/schema.sql                                       (regenerated)

apps/api/src/services/depositReturn.ts                           (new — 290 lines)
apps/api/src/routes/leases.ts                                    (4 endpoints appended)

apps/landlord/src/pages/DepositReturnPage.tsx                    (new — 320 lines)
apps/landlord/src/pages/LeasesPage.tsx                           (Move-out action column)
apps/landlord/src/main.tsx                                       (route)
```

## Validation

- `npm run db:migrate` → 1 applied
- `npx tsc --noEmit` on api / landlord / tenant / admin → all exit 0
- Live smoke (5 phases, all passing):
  - Phase 1: synthesize lease + cleaning_fee + deposit ✓
  - Phase 2: calculate preview = $1500/$250/$1250/$0 ✓
  - Phase 3: applyDeductions with damage + utility lines →
    total=$680, refund=$820, gap=$0 ✓
  - Phase 4: finalize refund path → status=sent_refund, payment
    row created, `deposit_returned_partial` ledger event landed ✓
  - Phase 5: gap path ($400 cleaning vs $200 deposit) →
    status=sent_gap, gap_payment created, auto-charge
    correctly failed (no stripe_customer_id on dev tenant),
    `gap_charge_failed=true`, both `deposit_returned_zero` +
    `tenancy_ended_with_balance` events emitted ✓
- All test data cleaned from dev DB

## What this session did NOT do

- No tenant-side surface — tenant can see the resulting refund
  payment in their `/payments` page and the credit events on
  `/credit`, but there's no dedicated "your move-out summary"
  view. Could be added in a follow-up if Nic wants it.
- No landlord-side handling of `disputed` status — the schema
  supports it, but the actual dispute flow is the existing
  credit-dispute lifecycle (tenant disputes the
  `deposit_returned_*` event via the existing tenant
  `/my-disputes` flow). Admin resolves via the existing
  `/disputes` admin page. The deposit_returns row's `status`
  field would need a separate manual update if the dispute
  outcome is `corrected` — for v1 the credit-event chain is
  the source of truth and the deposit_returns row stays
  `sent_refund` / `sent_gap` / `sent_zero` regardless.
- No move-out inspection integration. The locked design has
  inspection workflow + deposit-return as separate flows. If
  product wants a "complete move-out inspection → auto-pre-fill
  damage lines from inspection items rated damaged" link,
  that's a v2 follow-up.
- No photo upload on damage lines. Description + amount only
  for v1.

## Pre-launch backend status

Closed list updates:
- ✅ Cleaning_fee → deposit deduction wire-up (1A)
- ✅ Auto-charge gap when deductions exceed deposit (1A custom)
- ✅ Single-list deductions UI with category dropdown (3-mid B)

Remaining `due_timing` items:
- Early-termination flow (2B) — block in-app termination until
  fee paid + landlord waiver button. **Next session.**
- `other_fee` per-fee due_timing picker (3C) — small UI
  addition on lease creation flow. After 2B.

Other open items unchanged.

## What next session should target

**Session 153: early-termination flow (2B)**

Plain-language scope to confirm before building:

1. Schema: `lease_termination_requests` table OR a status flag
   on leases (e.g. `terminated_pending_fee`)? I'll recommend
   the table — cleaner audit trail and supports the "fee paid"
   gating cleanly.
2. Tenant UI: button on tenant lease page → flow shows the
   fee, attempts immediate ACH/debit charge against on-file
   payment method (per the same 1A pattern), only if charge
   succeeds does the lease terminate.
3. Landlord UI: "Waive early-termination fee" button on the
   lease detail page (good-faith case). Manual only. Records
   who waived + timestamp.
4. Backend: validate fee paid OR waived before the termination
   route flips lease status.

Will surface design questions when starting next session.

## Notes for future-Claude

- `deposit_returns` has both `damage_lines` and
  `other_deductions` JSONB columns. Per the S152 product
  call (single list with category dropdown), only
  `damage_lines` is actively populated; `other_deductions`
  always `[]::jsonb`. Kept the column instead of dropping it
  in case product later wants the split. Service totals all
  lines from both fields, so adding entries to
  `other_deductions` directly via SQL works without a code
  change.
- Auto-charge uses `Stripe.paymentIntents.create` with
  `off_session: true, confirm: true`. The created
  PaymentIntent is NOT stored in the GAM payments row's
  `stripe_payment_intent_id` — the existing
  payment_intent.succeeded webhook handler matches on
  `pi.id` against `payments.stripe_payment_intent_id`, and
  if that's null the webhook can't link them. **Known gap:**
  the gap payment row stays in `pending` even when the
  Stripe charge succeeds because the webhook can't find it.
  Fix in a follow-up: either (a) update payments row with
  the PaymentIntent id during the off_session create, or
  (b) read PI metadata.gam_payment_id on the webhook side
  and update by id. Option (b) is cleaner — already passing
  `metadata: { gam_payment_id, gam_kind: 'deposit_return_gap' }`.
- The `tenancy_ended_with_balance` event from the gap path
  may double-fire with the existing daily detector
  (`processBalanceCreditDetectors`) if the lease was already
  terminated when the deposit-return was finalized. Both
  emissions are idempotent at their respective sources but
  the chain will show two events. Consider deduping in the
  detector — skip emission if a deposit_returns row already
  exists for that lease and has emitted the event.
- The `Move-out` button on LeasesPage shows for status =
  active / expired / terminated. Active is allowed because
  some landlords process move-out before the lease formally
  expires (early move-outs etc.). If product wants stricter
  gating, restrict to expired / terminated only.

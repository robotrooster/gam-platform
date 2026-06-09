# Session 118 Handoff

**Theme:** Stripe Connect rebuild — Session 5. GAM-native dashboard
backend. Five routes that serve `connect_payouts`, `connect_disputes`,
and the rent-payment timeline data the landlord portal renders inline
without embedding Stripe components.

This is the route layer the frontend needs to render the payouts list,
the disputes inbox, the "rent collected → arrived in your bank"
timeline. Per S113's locked architecture, GAM doesn't embed
`<ConnectPayouts />` / `<ConnectAccountManagement />` — only the
one-time `<ConnectAccountOnboarding />` from S115. Everything else is
GAM-native UI calling these GAM-native routes.

## Architecture decisions

**Embedded onboarding ONLY; everything else native.** Locked S113.
This session is the proof: five routes serving Stripe data via GAM's
shape, no embed dependency for any post-onboarding surface.

**Per-role variants for payouts.** Landlords use
`/api/landlords/me/payouts` (scoped via `user_id`). PM company staff
use `/api/pm/companies/:id/payouts` (scoped via `pm_company_id` with
the active-staff gate). Same data, different access paths. Future
opt-in manager Connect accounts will reuse the user-scoped landlord
endpoint with the same ownership logic.

**Disputes ordered for action-first UX.** The `/me/disputes` query
sorts `needs_response` first, then `warning_needs_response`, then
everything else, with `evidence_due_by ASC NULLS LAST` as the
tiebreaker. Frontend gets disputes that need action at the top
without extra client-side sorting.

**Dispute respond uses Stripe's evidence shape directly.** Body is a
free-form `Record<string, string>` matching Stripe's
`dispute.evidence` parameters (`uncategorized_text`,
`customer_communication`, `receipt`, `service_documentation`, etc.)
and forwarded as-is to `stripe.disputes.update`. We don't pre-shape
or validate evidence keys at the GAM layer — Stripe is the
authoritative validator. Local stamp on `evidence_submitted_at` +
`response_notes` after the Stripe call succeeds.

**Payments-history is two queries unioned client-side.** Returning
two arrays (`charges` + `payouts`) instead of a SQL UNION ALL.
Reasons: the two row shapes are very different, the frontend
already knows how to interleave them by date, and a SQL union with
`UNION ALL` + a discriminator column would force every row through
the most-permissive shape. Two arrays is honest about the data
shapes; client-side merge is trivial.

**No "embedded notification banner" component.** Stripe offers
`<ConnectNotificationBanner />` for surfacing flagged action items
on the connected account (e.g. "verification incomplete"). Not
embedding it; GAM derives the same via `fetchAccountStatus` (S115)
+ a notification of GAM's own design. Keeps the architecture
"native everything-else" principle clean.

## Shipped

### apps/api/src/routes/landlords.ts

Four new endpoints (all `requireLandlord`):
- `GET /me/payouts` — list `connect_payouts` for the calling
  landlord's user_id. Optional `status` filter, `limit` 1–200
  default 50.
- `GET /me/disputes` — list disputes attributed to the calling
  landlord, ordered action-first. Optional `pending=true` filter.
- `POST /me/disputes/:id/respond` — submits evidence to Stripe via
  `stripe.disputes.update(disputeId, { evidence })`. Verifies the
  dispute belongs to this landlord and is in a status that accepts
  evidence. Stamps `evidence_submitted_at` + `response_notes`
  locally on success.
- `GET /me/payments-history` — returns `{ charges, payouts }` for
  the rent-collected → bank-arrived timeline.

Plus `import { z } from 'zod'` added (was missing — picked up here
because the dispute respond route validates body shape).

### apps/api/src/routes/pm.ts

One new endpoint:
- `GET /companies/:id/payouts` — same shape as the landlord variant
  but scoped via `pm_company_id`. Active staff (any role) can view.

## Files touched

- `apps/api/src/routes/landlords.ts` (4 new endpoints + zod import)
- `apps/api/src/routes/pm.ts` (1 new endpoint)
- `SESSION_118_HANDOFF.md` (this file)

No migrations, no schema changes (all schema landed in S114/S115/S117).

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 6-step end-to-end smoke against dev DB:
  1. `/me/payouts` returns all 3 seeded payouts (pending/paid/failed)
     ordered by created_at DESC ✓
  2. `?status=paid` filter returns exactly 1 row ✓
  3. `/me/disputes` shows attributed dispute with property/unit
     joined (MH 02 / RENT) AND unattributed dispute with NULL
     linkage; `needs_response` sorted first ✓
  4. `?pending=true` filter returns 1 row ✓
  5. `/me/payments-history` returns 1 charge + 3 payouts ✓
  6. Dispute respond eligibility check matches the `needs_response`
     row (would proceed to Stripe call in real flow) ✓

Live `stripe.disputes.update` deferred to sandbox post-contract.

## What this session did NOT do

- **No frontend.** Per UI/UX standing rule. The endpoints are wired;
  the landlord-portal pages that render the data are a frontend pass.
- **No live Stripe API call.** Schema + routing verified; the actual
  `disputes.update` call exercises in sandbox.
- **No bulk evidence file upload.** Stripe accepts file_upload objects
  in evidence (e.g. `customer_signature`, `receipt`). For now the
  route accepts plain string evidence (text fields). Future session
  can add `POST /me/disputes/:id/evidence-upload` that proxies a
  file to Stripe's Files API and returns the file id for inclusion.
- **No `connect_payouts` data backfill.** Webhooks fire forward only;
  any historical Stripe payouts pre-S117 don't appear. Sandbox
  testing will populate going forward.
- **No GAM-native equivalent of `<ConnectAccountManagement />`** for
  bank account update. That's its own endpoint set (probably
  `PATCH /api/landlords/me/connect-bank-accounts/:id`) that wraps
  Stripe's external accounts API. S119 or later.

## Pre-launch blockers still open

- ~~Tenant rent-pay route~~ — closed S117
- ~~Connect payout/dispute schema + webhooks~~ — closed S117
- ~~Native dashboard backend~~ — closed S118
- Item 16 batch 3+ (OTP under Connect) — gated on rate retry workflow
- Item 10 (utility billing payment) — composes naturally with
  destination charges
- S119 — PM Companies money-flow refactor
- S120 — Per-occupied-unit platform fee accrual cron

## What next session (S119) targets

PM Companies money-flow refactor under destination charges.

Today, when a property is contracted to a PM company:
- Rent payment fires → S116 destination charge sends gross to landlord's
  Connect, GAM keeps `application_fee_amount`
- Webhook → `executeRentAllocation` writes `allocation_owner_share` to
  landlord's user_balance_ledger AND `allocation_pm_company_fee` to
  PM company's user_balance_ledger (S110)

The PM cut entry on the ledger is now a "ghost" — the actual money
landed in the landlord's Connect account, not the PM's. To make the
ledger entry reflect reality, S119 should:

1. After the destination charge settles, fire a `Transfer` from the
   landlord's Connect to the PM company's Connect for the cut amount.
   `stripe.transfers.create({ amount, currency, destination: pmCompanyConnectId })`
2. Stamp the Stripe Transfer id on the `allocation_pm_company_fee`
   ledger entry for traceability
3. Same for the monthly accrual (S111 `pm_monthly_fee_accruals` rows)
4. Same for the leasing fee (S111 hook in `esign.ts`)

Three parallel `Transfer` flows, all keyed off settled events. Plus
a small migration to add `stripe_transfer_id` to
`user_balance_ledger` (or to a sibling `pm_company_transfers` table
if we want to keep the ledger generic).

After S119, S120 (platform fee accrual cron) is the last rebuild
session. May 18 contract sign deadline still on track.

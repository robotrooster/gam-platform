# Session 167 — closed

## Theme

S113 outbound payout rebuild + safety valve + lease_fees wiring +
production-readiness frontend cleanup + PM portal property drilldown.
Eight discrete shipped items; tsc clean across api + 7 portals
throughout.

S166 closed with the recommendation to start the S113 allocation-engine
rebuild. Recon during S167 reframed the problem: tenant-side rent
collection is already on destination charges (S114–S121 done), and PM
cuts already fire as Stripe Transfers (S119). The actual S113 hole was
**outbound payouts** — the disbursement queue, auto-Friday cron, and
manual on-demand withdrawals all still routed through a stub
`bank_ach`/`stub` rail in `services/disbursementFiring.ts`.

S167 ships the Stripe-Connect-native replacement.

## What S167 shipped

### Phase 1 — Manager-fee Stripe Transfer (mirror of PM cut pattern)

- **`apps/api/src/services/stripeConnect.ts`** — added
  `fireManagerTransfersForReference(referenceType, referenceId)`,
  parallels `firePmTransfersForReference` for type='allocation_manager_fee'.
  Handles managers without Connect by silent-skip (CLAUDE.md says manager
  Connect is opt-in, default off; reconciliation cron retries).
- **`apps/api/src/routes/webhooks.ts`** — post-commit fire next to PM
  Transfer firing in `payment_intent.succeeded` loop.
- **`apps/api/src/jobs/monthlyFeeAccrual.ts`** — post-commit fire after
  the in-house manager monthly accrual COMMIT.
- **`apps/api/src/jobs/managerTransferReconciliation.ts`** (NEW) — daily
  4am stale-row retry, mirrors `pmTransferReconciliation.ts`.
- **`apps/api/src/jobs/scheduler.ts`** — parallel cron entry next to PM
  reconciliation.

### Phase 3 — Stripe Payouts service

- **`apps/api/src/services/connectPayouts.ts`** (NEW) — pure service
  wrapper around `stripe.payouts.create({...}, { stripeAccount })`.
  Exports `firePayoutForConnectAccount`, `getConnectBalance`,
  `getAvailableUsdBalance`, `getInstantAvailableUsdBalance`. Idempotency
  key required at the call site.

### Phase 4 — Auto-Friday rebuild

- **`apps/api/src/jobs/autoPayouts.ts`** (full rewrite) — replaces
  `user_balance_ledger` per-bank scan + GAM-rail stub fire with: read
  Stripe Connect available USD balance per Connect-enabled
  user/pm_company, fire `stripe.payouts.create`. Idempotency
  key = `auto_friday_${accountId}_${yyyy_mm_dd}`. Audit row in
  `disbursements` written for user-side payouts (UI continuity).
- Holiday calendar logic kept as-is — traced through; current
  Monday-after-Friday-holiday behavior was already correct (a previous
  session's memory note flagged this as a "divergence to fix" but it
  isn't — current code handles Mon→Tue chain via `nextWeekday` which
  starts at Saturday and finds Monday).
- **`apps/api/src/services/stripeConnect.ts`** — `recordPayoutEvent`
  webhook handler now propagates Stripe payout status onto matching
  `disbursements` row (paid → settled, failed/canceled → failed).
- **PM company auto-Friday payouts ship in this phase too** but write
  no `disbursements` audit row (no `pm_company_id` column on that
  table). PM-side audit lives in `connect_payouts` only.

### Phase 2 — Owner-share read substitution (backend)

- **`apps/api/src/routes/finances.ts`** (rewrite) — `current_balance`
  now sourced from Stripe Connect `available` USD instead of
  `user_balance_ledger.balance_after`. Added `pending_balance`
  (Stripe pending USD) and `connect_ready` (boolean) to the response.
  `unrouted_balance` and `per_bank` returned as 0 / [] for back-compat;
  UI cleanup is its own session.
- Graceful fallback: callers without Connect (managers who haven't
  opted in, admin users) get zeros without 500ing. Stripe API hiccup
  is logged and treated as zero.

### Phase 5 — Manual on-demand rebuild

- **`apps/api/src/routes/withdrawals.ts`** (full rewrite of
  POST/preview) — reads Stripe Connect balance directly, fires payout
  with optional `method='instant'`. Drops the GAM manual-withdraw fee
  per S167 product call (see Decisions below). Stripe instant fee
  (1.5% min $0.50) passes through to user natively — Stripe deducts
  from Connect balance.
- Legacy `GET /me/disbursements/failed` and
  `POST /me/disbursements/:id/retry` kept in place to drain pre-Phase4/5
  rows from the old GAM-rail queue. Removable in a cleanup session
  once the queue is empty.

### Frontend cleanup (landlord app — matches new backend shapes)

- **`apps/landlord/src/pages/DisbursementsPage.tsx`** — replaced
  per-bank `BalanceWithdrawSection` + `WithdrawNowModal` with
  single-balance versions. New BalanceWithdrawSection renders an
  "Available Now" KPI + optional "Pending Settlement" KPI fed by
  `data.current_balance` / `data.pending_balance`. Withdraw button
  opens a redesigned modal with `standard` / `instant` toggle backed
  by the new `/me/withdrawals/preview` shape (`{ standard, instant }`).
  POST sends `{ method }` instead of `{ bank_account_id }`.
  Connect-readiness gate inline if `data.connect_ready === false`.
  Top alert text updated — drops the old "small fee" line, mentions
  Monday-on-holiday + the instant-payout option.
- **`apps/landlord/src/pages/DashboardPage.tsx`** — recent
  disbursements card simplified to four columns (Date / Amount /
  Trigger / Status) with graceful null handling on
  `createdAt`/`targetDate`. Drops the legacy `Units` and
  `SLA / Reserve` columns — neither concept survives under Stripe
  Connect destination charges.
- **`apps/landlord/src/pages/BankingPage.tsx`** — no functional
  changes needed. Failed-disbursements retry surface still works
  against the legacy queue. Cosmetic comment refresh deferred.

`cd apps/landlord && npx tsc --noEmit` exit 0.

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0 after each phase.
- No DB migrations this session.

## Decisions made (S167)

Locked during planning — also captured in
`memory/project_stripe_connect_rail.md`:

| Question | Decision |
|---|---|
| Architecture | Stripe Connect Express + destination charges (CLAUDE.md unchanged) |
| Landlord-facing Stripe surface | `stripe_dashboard.type = 'express'` stays for now; Custom-controller migration is a tracked future item. Nic dislikes Stripe being visible but accepts the current posture |
| Owner-share ledger | Keep `allocation_owner_share` rows as audit-only twins of money already routed to landlord Connect by destination charges |
| Manager fee | Per-payment Stripe Transfer (mirrors PM cut pattern) — Phase 1 above |
| Auto-payout cadence | Friday batched payouts; Monday if Friday is US fed holiday. Current `autoPayouts.ts` logic was already correct on this; no fix needed |
| Instant payout | User-facing button; calls `stripe.payouts.create` with `method:'instant'`; surcharge (1.5% min $0.50) deducted by Stripe from Connect balance, passes through to user |
| GAM manual-withdraw fee | DROPPED in Phase 5 (revised from earlier "keep it"). Reason: under Stripe Connect, there's no Stripe-native way for the platform to extract a fee from a Connect balance on outbound payouts; the original fee was cost-recovery for GAM-rail ACH origination which doesn't exist anymore. Standard manual payouts are now free |

## Files touched in S167

```
apps/api/src/services/stripeConnect.ts                  (+ fireManagerTransfersForReference, + recordPayoutEvent webhook propagation to disbursements)
apps/api/src/services/connectPayouts.ts                 NEW — Stripe Payouts service
apps/api/src/routes/webhooks.ts                         (+ manager-transfer post-commit fire next to PM)
apps/api/src/routes/withdrawals.ts                      FULL REWRITE — Stripe Payouts edition; legacy retry surface preserved
apps/api/src/jobs/autoPayouts.ts                        FULL REWRITE — Stripe Payouts edition
apps/api/src/jobs/monthlyFeeAccrual.ts                  (+ manager-transfer post-commit fire after in-house COMMIT)
apps/api/src/jobs/managerTransferReconciliation.ts      NEW — daily retry cron, mirror of pmTransferReconciliation.ts
apps/api/src/jobs/scheduler.ts                          (+ wire managerTransferReconciliation into the daily 4am cron block)
apps/api/src/routes/finances.ts                         REWRITE — current_balance from Stripe Connect; unrouted/per_bank deprecated as 0/[]
apps/landlord/src/pages/DisbursementsPage.tsx           REWRITE BalanceWithdrawSection + WithdrawNowModal for new /me/withdrawals shapes
apps/landlord/src/pages/DashboardPage.tsx               recent disbursements card simplified for null-safe display
apps/api/src/routes/webhooks.ts                         (+ stripe_charge_id snapshot on payment_intent.succeeded)
apps/api/src/services/stripeConnect.ts                  (+ sourceTransactionId on per-payment Transfers — Phase 2.5 fix)
apps/api/src/services/disbursementFiring.ts             DELETED — legacy GAM-rail stub
apps/api/src/routes/admin.ts                            (− /disbursements/:id/fire endpoint + import)
apps/api/src/routes/withdrawals.ts                      (− failed-list / retry endpoints; pre-launch, no queue to drain)
apps/landlord/src/pages/BankingPage.tsx                 (− FailedDisbursementsSection)
apps/api/src/lib/stripe.ts                              (refresh stale S67/S68 comment)
apps/api/src/jobs/scheduler.ts                          (cosmetic comment refresh; + auto-create deposit return draft on natural lease end)
apps/api/src/db/migrations/20260506180000_payments_platform_held.sql  NEW — A safety valve column
apps/api/src/services/landlordPassthrough.ts            NEW — A reconciliation flow (platform → landlord Connect)
apps/api/src/routes/payments.ts                         (+ A safety-valve fallback to platform charge when Connect not ready)
apps/api/src/services/depositReturn.ts                  (+ B: include 'other' due_timing alongside 'move_out')
apps/tenant/src/main.tsx                                (C: feature-requests link → VITE_ADMIN_APP_URL fallback)
apps/landlord/src/pages/UnitDetailPage.tsx              (C: photo upload/delete/img + listings link → VITE_API_URL + VITE_LISTINGS_APP_URL)
apps/landlord/src/pages/ESignPage.tsx                   (C: PDF base + upload → VITE_API_URL)
apps/listings/src/main.tsx                              (C: API + tenant deep-links → env-driven)
apps/admin/src/main.tsx                                 (C: GAM Books shortcut → VITE_BOOKS_APP_URL)
apps/property-intel/src/main.tsx                        (C: backend URLs + admin link → env-driven)
apps/books/src/main.tsx                                 (C: admin console link → VITE_ADMIN_APP_URL)
apps/api/src/index.ts                                   (C: CORS allowed-origins now env-driven for ports 3006-3011)
apps/api/src/routes/pm.ts                               (+ D: GET /companies/:id/properties/:propertyId/drilldown)
apps/pm-company/src/pages/PropertyDetailPage.tsx        NEW — D: PM-side property drilldown UI
apps/pm-company/src/pages/PropertiesPage.tsx            (+ D: property name link to /properties/:id)
apps/pm-company/src/main.tsx                            (+ D: route registration)
```

### D — PM portal property drilldown (FIXED)

`GET /api/pm/companies/:id/properties/:propertyId/drilldown` returns
property + units + active leases + recent maintenance + MTD fee impact
in a single round-trip. Auth: any active staff role gates on
`properties.pm_company_id` matching the URL :id (404 otherwise).

Frontend `PropertyDetailPage` renders four KPI cards (occupancy, MTD
gross, MTD PM fee, MTD owner net) + three sections (units / active
leases / recent maintenance). Property rows in `PropertiesPage` link
to the new route.

### C — localhost hardcode audit (FIXED, source files only)

13 hardcoded `localhost:` strings without env-var fallback rewritten
to follow the S162 PM-portal pattern:
`(import.meta as any).env?.VITE_X_APP_URL || 'http://localhost:NNNN'`.
All 7 portal apps + the API tsc-clean. Cross-portal env vars referenced:

```
VITE_API_URL                  (port 4000 — shared by every frontend)
VITE_PROPERTY_INTEL_API_URL   (port 4001 — property-intel only)
VITE_LANDLORD_APP_URL         (port 3001)
VITE_TENANT_APP_URL           (port 3002)
VITE_ADMIN_APP_URL            (port 3003)
VITE_BOOKS_APP_URL            (port 3006)
VITE_LISTINGS_APP_URL         (port 3008)
```

Server-side env vars on the API for CORS (now env-driven for ports
3006-3011 instead of hardcoded):
```
LANDLORD_APP_URL, TENANT_APP_URL, ADMIN_APP_URL, MARKETING_URL,
POS_APP_URL, BOOKS_APP_URL, PROPERTY_INTEL_APP_URL,
LISTINGS_APP_URL, ADMIN_OPS_APP_URL, PM_COMPANY_APP_URL
```

`.env` files NOT updated — per CLAUDE.md rule about asking before
touching .env. To deploy, you'll want to add the cross-portal
`VITE_*_APP_URL` env vars to each portal's `.env` (production URLs)
and the corresponding `*_APP_URL` server-side vars to the API's
`.env`. Local dev keeps working as-is via the localhost fallbacks.

### A — Rent safety valve (FIXED)

When a tenant rent payment hits a landlord whose Stripe Connect isn't
charges_enabled, the destination-charge model fails. Phase A handles
this:

- Migration `20260506180000_payments_platform_held.sql` adds
  `payments.platform_held boolean` + partial landlord index.
- `payments.ts /:id/pay` checks cached `users.connect_charges_enabled
  + connect_details_submitted`. If ready: existing destination charge.
  If not: `createRentPlatformCharge()` (no transfer_data, gross to
  platform balance), `platform_held=true`, admin notification fires.
- `services/landlordPassthrough.ts` (NEW) — `reconcilePlatformHeldPayments(landlordUserId)`
  sums every unfired `allocation_owner_share` row across platform_held
  payments for the landlord, fires a single Transfer from platform →
  landlord Connect, stamps stripe_transfer_id on each owner_share row,
  flips platform_held=false. Per-landlord advisory lock for idempotency.
- `services/stripeConnect.ts recordAccountUpdated` calls
  `tryReconcileForLandlordUserId` whenever a Connect account flips to
  charges_enabled+details_submitted. Best-effort; subsequent webhooks
  retry until reconciled.

### B — `lease_fees` move_out / other wiring (FIXED)

Per Nic's spec ("deduct from deposit. if fees arent covered by deposit
invoice the difference"):

- `services/depositReturn.ts calculateDepositReturn` now sums
  `due_timing IN ('move_out', 'other')` instead of just `'move_out'`.
  All configured lease_fees auto-deduct from the deposit at draft
  creation (cleaning_fee, early_termination_fee, other_fee).
- `scheduler.ts processLeaseEnds` auto-creates the deposit-return
  draft on natural expiry (replacing the old S144 unbilled-fees
  notification). Admin notification fires "deposit return draft
  awaiting review."
- Existing finalize flow handles refund + gap invoicing — landlord
  reviews damage lines, finalizes; if gap > 0 the existing
  `attemptGapAutoCharge` fires a Stripe charge against the tenant's
  payment method.

## Items considered + deferred this session

- **E — `apps/admin/src/main.tsx` file split** (~1700 lines, ~16
  inline page functions). Skipped per Nic — the file works fine and
  nothing else touched in S167 depends on it. Pure mechanical refactor
  for a fresh session whenever a real code-touch in admin/main.tsx
  triggers it.

## Carry-forward — what S168 should target

### Phase 2.5 — source_transaction fix (FIXED in S167)

Per-payment PM and manager Transfers now pass `source_transaction =
payments.stripe_charge_id` so funds pull from the destination Connect's
settlement (where destination charges deposited the gross) instead of
GAM's platform balance. Webhook `payment_intent.succeeded` handler
captures the charge id at settle time. Accruals (monthly_fee_accrual /
pm_monthly_fee_accrual / lease) legitimately fund from platform
balance — those references skip the source_transaction lookup.

### Manager Connect opt-in UX

CLAUDE.md says manager Connect is "opt-in toggle, default off." No flow
exists for a manager to opt in (no UI, no API, no `users.connect_*`
self-service path). Without it, every property with a separate
manager has its `allocation_manager_fee` rows accumulate forever as
silent-skipped reconciliation rows. Decision needed: build the manager
Connect opt-in path, OR change the allocation policy to fold manager
fee into owner share when manager has no Connect. Either way it's a
product-call session.

### `lease_fees.due_timing` move_out / other wiring

Still deferred from S144 — needs a product call.

### Legacy `disbursements` queue drain

Phase 4-5 keeps `routes/withdrawals.ts` retry surface and
`routes/admin.ts:445` admin retry endpoint for legacy rows queued via
the GAM-rail stub. Once `SELECT COUNT(*) FROM disbursements WHERE
status='pending' OR (status='failed' AND notes ILIKE '%connect_not_ready%')`
returns 0, those endpoints + `services/disbursementFiring.ts` can be
deleted in a cleanup session.

### Stale doc comment in `apps/api/src/lib/stripe.ts:51-57`

The "Connect helpers removed" comment is misleading post-S113. Should
be updated when the file is next touched.

## Manual verification

The S167 changes are behaviorally null until real money flows hit
them. To smoke them:

1. **Phase 1**: rent payment on a property where
   `managed_by_user_id ≠ owner_user_id` AND the manager has
   `users.stripe_connect_account_id` set → manager's Connect balance
   should increment by the manager_fee within ~10 seconds of the
   tenant payment settling.
2. **Phase 4**: any Friday (non-holiday) at 9am Phoenix, scheduler
   runs `processAutoPayouts`. With at least one user/pm_company
   carrying Connect balance > 0, expect a `disbursements` row
   (status='processing') for the user case and a `connect_payouts`
   row (webhook-fed shortly after) for both. Idempotency key at
   Stripe protects against same-day re-fires.
3. **Phase 5**: landlord with non-zero Connect balance hits
   `POST /api/withdrawals/me/withdrawals` with body
   `{ method: 'standard' }` → Stripe payout fires, `disbursements`
   row inserted, webhook later flips status to settled.
   `{ method: 'instant' }` → Stripe deducts the 1.5% surcharge from
   the Connect balance; payout amount in `disbursements.amount` is
   gross, `fee_charged` is the projected surcharge.

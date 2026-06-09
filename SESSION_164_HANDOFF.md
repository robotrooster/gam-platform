# Session 164 — Admin Connect dashboard + legacy field deprecation

## What S163 shipped

S163 closed Priorities 1–3 from the S162 handoff: Connect-readiness
backfill, failed-disbursement retry UI, and the tenant nudge CTA.

### Backend
- **`apps/api/src/routes/admin.ts`** — new endpoint
  `POST /api/admin/connect-readiness/backfill`. Walks every users +
  pm_companies row that has a `stripe_connect_account_id` but cached
  flags showing not-ready. For each, calls
  `fetchAccountStatus` live and updates the cached
  `connect_charges_enabled` / `connect_payouts_enabled` /
  `connect_details_submitted` columns. Synchronous (rate-limited
  Stripe calls happen in series; volume is small). Returns scanned /
  updated / errors counts plus a per-row error list. Audit-logged
  via `logAdminAction`.
- **`apps/api/src/routes/withdrawals.ts`** — two new endpoints:
  - `GET /api/withdrawals/me/disbursements/failed` — lists the
    caller's failed disbursements where notes contain
    `connect_not_ready`. Other failure reasons require manual
    support intervention and aren't surfaced here.
  - `POST /api/withdrawals/me/disbursements/:id/retry` — re-fires a
    failed disbursement via `fireDisbursement`. The S162
    Connect-readiness recheck inside `fireDisbursement` itself fast-
    fails the retry if the user still isn't ready, so the retry
    button is safe to expose.
- **`apps/api/src/services/email.ts`** — new helper
  `emailLandlordBankingNudge`. Soft, polite copy. Logged with
  `category: 'landlord_banking_nudge'` and
  `relatedEntityType: 'tenant_landlord_nudge'` for the rate-limit
  query.
- **`apps/api/src/routes/tenants.ts`** — new endpoint
  `POST /api/tenants/me/nudge-landlord-banking`. Rate-limited to one
  nudge per 24 hours by querying `email_send_log` for any prior
  send to the same tenant in the window — no new table or column
  needed. Returns 429 if a nudge is already in flight, 409 if the
  landlord's banking is now complete (the banner should hide on
  refetch but a stale client could still try).

### Frontend
- **`apps/landlord/src/pages/BankingPage.tsx`** — new
  `FailedDisbursementsSection` component. Self-hides when no
  retryable failed disbursements exist. Shows date + bank + amount
  + reason + Retry button. Retry invalidates the failed-list,
  disbursements list, and cash-position queries.
- **`apps/tenant/src/main.tsx`** — `LandlordBankingBanner` extended
  with the "Notify my landlord" button. Idle / Sending / Sent / Too
  soon / Error states. The button stays disabled in the success and
  too-soon states; the next 24-hour-window send opens automatically.

### Verification
- API `tsc --noEmit` exit 0.
- Landlord `tsc --noEmit` exit 0.
- Tenant `tsc --noEmit` exit 0.

## What S164 should target

### Priority 1 — Admin Connect-readiness dashboard

Pre-S163 the only way to see Connect state was per-user in the
landlord/PM portal. Admin needs a cross-account view to support
landlords and PMs calling in.

Build at `apps/admin/src/pages/ConnectAccountsPage.tsx` (new):
- List users + pm_companies with non-null `stripe_connect_account_id`.
- Columns: entity type, name/email, account id, charges_enabled,
  payouts_enabled, details_submitted, last synced_at.
- Filter: ready / not_ready / no_account.
- Refresh button on each row (calls a new
  `POST /api/admin/connect-readiness/refresh/:entity/:id` that calls
  `fetchAccountStatus` for that one row and updates the cached flags).
  Sub-endpoint of the bulk backfill from S163; saves a Stripe call
  on big tenants.
- Run-backfill button up top that hits the bulk
  `/connect-readiness/backfill` endpoint from S163.

Cheap to add; high support value.

### Priority 2 — Legacy `pm_companies.bank_account_id` audit & deprecation

The S108 schema added `pm_companies.bank_account_id` (FK to
`user_bank_accounts`) for the legacy 16a allocation engine. Under
S113 destination charges, the Stripe Connect account
(`stripe_connect_account_id`) is the routing destination — the legacy
field is dead.

Steps:
- Audit consumers: `grep -rn 'bank_account_id' apps/api/src/services/ apps/api/src/routes/` filtered to pm_companies references.
- Confirm allocation engine + monthly fee accrual + payouts no longer
  read it (services/allocation.ts → `fetchPmFeeContext` reads
  `c.bank_account_id` — verify this is still required or has migrated
  to Connect routing).
- If still in use, leave it for now; if dead, deprecate via comment +
  schedule removal in a follow-up migration.

If the audit finds lingering reads, it becomes a bigger session
(rebuilding fee routing under Connect transfers); if the audit is
clean, this is a 30-minute task.

### Priority 3 — Webhook-driven failed-disbursement auto-retry (optional)

S163 ships manual retry. A modest improvement: when
`account.updated` fires and flips `connect_payouts_enabled` true,
automatically re-queue any `connect_not_ready` failed disbursements
for that user. Inside `recordAccountUpdated`:
- Detect the false→true transition.
- Trigger a background sweep over that user's failed disbursements
  with `connect_not_ready` notes; fire each one.

Risk: if multiple disbursements are queued and the user's balance has
shifted, we shouldn't blindly fire all of them — they were correct at
queue time but may now exceed available balance. Better path: surface
"Retry all" as a button on the BankingPage failed list, not auto-retry.

Recommend: don't build this; the manual flow from S163 is correct.

### Priority 4 — Stripe webhook prod registration script / docs

The PROD CHECKLIST note added in S162 says "confirm Stripe Dashboard
webhook endpoint config has account.updated in the events list." This
is a manual step. We could either:
- Document it as part of the deploy runbook (when one exists).
- Write a one-shot CLI script that uses the Stripe API to verify the
  webhook endpoint events list.

Defer until deploy runbook is on the agenda.

## Files touched in S163

```
apps/api/src/routes/admin.ts                                             (+ Connect backfill)
apps/api/src/routes/withdrawals.ts                                       (+ failed/retry endpoints)
apps/api/src/routes/tenants.ts                                           (+ nudge-landlord-banking)
apps/api/src/services/email.ts                                           (+ emailLandlordBankingNudge)
apps/landlord/src/pages/BankingPage.tsx                                  (+ FailedDisbursementsSection)
apps/tenant/src/main.tsx                                                 (LandlordBankingBanner CTA + state)
```

## Carry-forward from earlier sessions still open

- **OTP disbursement engine integration** — `ONTIMEPAY`-tagged payments
  flowing into ACH push to landlord. Surfaces during S113 allocation
  engine rebuild.
- **OTP reenrollment override UI** — punted to first real default in beta.
- **`lease_fees.due_timing` move_out / other wiring** — needs product
  call (S144 mitigation in place via gap notification).
- **`apps/landlord/src/pages/PmInvitationsPage.tsx` autocomplete** —
  owner currently types PM company UUID by hand. Defer.
- **Connect endpoint duplication** — `/api/pm/companies/:id/connect/*`
  and `/api/stripe/connect/*` overlap. Revisit if a third caller emerges.

## Manual smoke flow (when Nic chooses to run it)

1. `dev.sh` → all 9 portals up.
2. **Admin :3003** → POST `/api/admin/connect-readiness/backfill` via
   curl or admin UI. Confirms the response counts match what's in
   `psql gam -c "SELECT COUNT(*) FROM users WHERE
   stripe_connect_account_id IS NOT NULL;"`.
3. **Landlord :3001** → fail a withdrawal (suspend the Connect
   account, attempt a withdrawal, observe failed status); on /banking
   the FailedDisbursementsSection shows it. Reactivate Connect →
   webhook flips → click Retry → status flips to processing.
4. **Tenant :3002** → on a unit whose landlord's Connect is
   incomplete, dashboard shows the gold banner with "Notify my
   landlord" button. Click it → button changes to "✓ Notified your
   landlord". Click it again within 24 hours → 429 with copy "You
   can send another nudge in 24 hours."
5. Confirm the email arrived at the landlord's address (test mode).

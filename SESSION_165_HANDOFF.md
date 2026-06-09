# Session 165 — open

## What S164 shipped

S164 closed Priorities 1 & 2 from the S163 handoff (admin Connect dashboard
+ legacy field audit). Priority 3 (auto-retry on webhook) was explicitly
not built per the S163 recommendation. Priority 4 (deploy webhook docs)
remains deferred.

### Backend
- **`apps/api/src/routes/admin.ts`** — two new endpoints:
  - `GET /api/admin/connect-readiness/accounts` — returns every users
    + pm_companies row that has a `stripe_connect_account_id`, with
    cached readiness flags + last synced_at. Sorted with not-ready
    rows first so admin sees them at a glance.
  - `POST /api/admin/connect-readiness/refresh/:entity/:id` —
    single-row Stripe live-state refresh (entity ∈ user|pm_company).
    Audit-logged via `logAdminAction` with `actionType:
    'connect_readiness_refresh'`.

### Frontend (admin portal)
- **`apps/admin/src/main.tsx`** — new `ConnectAccounts` page +
  `Bool` cell helper. Filter (all / ready / not ready), search
  (name/email/account-id), per-row Refresh button, top-right Run
  Backfill button (calls the S163 bulk endpoint). Route registered
  at `/connect-accounts`. Nav entry "🔌 Connect Accounts" between
  Disbursements and Reserve.

### Audit (Priority 2 from S163)
- **`pm_companies.bank_account_id`** is **still load-bearing**, not
  dead. Five consumers found:
  - `services/allocation.ts:367` — `fetchPmFeeContext` reads
    `c.bank_account_id AS pm_bank_account_id`
  - `services/allocation.ts:153` — throws if null (allocation refuses
    to split when PM bank routing isn't configured)
  - `jobs/monthlyFeeAccrual.ts:281` — monthly fee accrual joins
    user_bank_accounts via this column
  - `routes/pm.ts:86` — company detail response includes the field
  - `routes/esign.ts:355` — lease document generation reads the PM
    bank routing
- Deprecation is gated on the larger S113 allocation-engine rewrite
  that replaces GAM-book ledger writes with Stripe transfers between
  Connect accounts. Already captured in CLAUDE.md's "Pre-S113
  architecture artifacts" section. NOT a 30-minute cleanup; do not
  attempt to remove the column without rebuilding the legacy 16a
  paths first.

### Verification
- API `tsc --noEmit` exit 0.
- Admin `tsc --noEmit` exit 0.

## What S165 should target

The Connect-Express stack is now complete end-to-end across admin,
landlord, PM, and tenant portals (Sessions 157–164). Most remaining
Connect-related work belongs in the broader S113 allocation-engine
rebuild, not in incremental polish. Pick one of:

### Option A — S113 allocation-engine rebuild kickoff

The legacy 16a allocation engine (services/allocation.ts) splits rent
payments into GAM-book ledger entries. Under S113 destination charges,
splits should happen at charge time via `application_fee_amount` +
`transfer_data[]` (multi-destination) or post-charge `Transfer` calls.

This is the largest remaining engineering item. CLAUDE.md "S113+
rebuild order" outlines it:
1. Schema additions (already in place — Connect account ids on users
   and pm_companies; readiness flags on both)
2. Connect onboarding flow (S160 + S159 — done)
3. Destination-charge wiring + allocation engine refactor
4. Embedded onboarding component hosting (S160 + S159 — done)
5. Native dashboard build
6. Webhook handling for Connect events
7. PM Companies money-flow refactor under destination charges

Step 3 (destination charges + allocation refactor) is the next
critical-path item. Substantial: needs schema changes if the new
flow stamps differently, refactors `services/allocation.ts` and
`services/disbursementFiring.ts`, and works through the maze of
existing tests.

Recommend: Nic decides whether to commit a full session to this. It's
a multi-session lift even at fast pace.

### Option B — Operational polish + smaller features

If Nic wants to keep landing smaller wins before committing to S113:

- **Stripe webhook prod registration script** — CLI tool that uses the
  Stripe API to verify the prod webhook endpoint config has all the
  events GAM expects (`account.updated`, `payment_intent.*`,
  `payout.*`, `charge.dispute.*`). Defer flagged in S162; could be
  built in 1–2 hours.
- **Tenant nudge audit log surface** — admin view of which tenants
  have nudged which landlords + when. The data is already in
  `email_send_log` with `category='landlord_banking_nudge'`; just
  needs a small admin endpoint + page row.
- **PM portal property drilldown** — `apps/pm-company/src/pages/PropertiesPage.tsx`
  is a flat list. A row click could route to `/properties/:id`
  showing units / leases / maintenance / current month fee impact.
  Probably its own session given the data plumbing.
- **`apps/landlord/src/pages/PmInvitationsPage.tsx`** — UUID-by-hand
  PM company picker. Build the autocomplete deferred from S163.
- **`apps/admin/src/main.tsx`** is now ~1500 lines with 15+ inline
  page functions. Worth splitting into per-page files. Mechanical
  refactor; defer until something else triggers it.

### Option C — Production-readiness sweep

If Nic is starting to plan the first prod deploy:
- Audit env-var defaults — anywhere `localhost:` is hardcoded should
  be moved to env-driven. S162 did the PM portal cross-portal URLs;
  same audit needs to run across the other portals.
- Stripe webhook secret rotation procedure documented.
- Database migration runbook (since we use fix-forward, the runbook
  needs to cover what to do when a prod migration fails partway).
- Smoke-flow scripts for Connect onboarding end-to-end (would benefit
  from being CI-runnable).

## Files touched in S164

```
apps/api/src/routes/admin.ts                                             (+ accounts list, + per-row refresh)
apps/admin/src/main.tsx                                                  (+ ConnectAccounts page, route, nav)
```

## Carry-forward from earlier sessions still open

- **OTP disbursement engine integration** — `ONTIMEPAY`-tagged payments
  flowing into ACH push to landlord. Surfaces during S113 allocation
  engine rebuild.
- **OTP reenrollment override UI** — punted to first real default in beta.
- **`lease_fees.due_timing` move_out / other wiring** — needs product
  call (S144 mitigation in place via gap notification).
- **`apps/landlord/src/pages/PmInvitationsPage.tsx` autocomplete** —
  defer per S163 recommendation; revisit with real-world feedback.
- **Connect endpoint duplication** — `/api/pm/companies/:id/connect/*`
  and `/api/stripe/connect/*` overlap; intentionally kept.
- **`pm_companies.bank_account_id` deprecation** — gated on S113
  allocation rewrite (see S164 audit above).
- **Stripe webhook prod registration verification** — manual
  checklist note in webhooks.ts; could be automated.

## Manual smoke flow (when Nic chooses to run it)

1. `dev.sh` → all 9 portals up.
2. **Admin :3003/connect-accounts**:
   - Run Backfill button → POSTs `/admin/connect-readiness/backfill`,
     status counter shows users + PM companies updated.
   - Filter "Not ready" — narrows the list to accounts that need
     attention.
   - Search by name → row appears → Refresh button → live Stripe
     pull → cached flags update in place.
3. Confirm `psql gam -c "SELECT action_type, metadata FROM
   admin_action_log WHERE action_type LIKE 'connect_readiness%'
   ORDER BY created_at DESC LIMIT 5;"` shows the audit trail.

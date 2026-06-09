# Session 163 — Stripe Connect failure-mode polish + dev experience

## What S162 shipped

S162 closed the load-bearing Priority 2 from the S161 handoff (webhook
plumbing audit) and four follow-throughs.

### Backend
- **`apps/api/src/routes/webhooks.ts`** — audited the Stripe webhook
  router. The `account.updated` case IS already wired to
  `recordAccountUpdated` (S115). No code change required, but the
  inline comment was stale ("flags read live from Stripe") so I
  rewrote it to reflect S159+ reality (cached flags). Added a PROD
  CHECKLIST note: confirm Stripe Dashboard webhook endpoint config
  has `account.updated` in the events list — otherwise none of the
  readiness gates ever flip in production.
- **`apps/api/src/services/disbursementFiring.ts → fireDisbursement`** —
  added a Connect-readiness recheck right at the top of the firing
  path. Catches the queue→fire race window where a user got queued on
  Friday and their Connect account was suspended before Stripe
  firing. Marks disbursement failed with reason
  `connect_not_ready: user Connect account not payout-eligible`
  instead of leaving zombie pending rows.
- **`apps/api/src/routes/tenants.ts`** — new endpoint
  `GET /api/tenants/me/landlord-banking-status`. Tenant-scoped read of
  the active-lease landlord's `connect_payouts_enabled` +
  `connect_details_submitted`. Returns minimal `{ ready: boolean }` —
  no other landlord PII crosses the trust boundary.

### Frontend (tenant portal)
- **`apps/tenant/src/main.tsx`** — new `LandlordBankingBanner` component
  rendered on both the home dashboard and the Payments page. Self-hides
  when `ready === true`. Copy explicitly tells the tenant their
  landlord hasn't finished banking setup, asks them to reach out, and
  notes that lease + balance views are unaffected.

### Frontend (PM portal)
- **`apps/pm-company/src/pages/RegisterPage.tsx`** — cross-portal
  escape links now read from `import.meta.env.VITE_LANDLORD_APP_URL`
  / `VITE_TENANT_APP_URL`. Defaults to localhost values when unset
  (dev-friendly). Production deploys set the prod URLs in
  `apps/pm-company/.env`.

### Documentation
- **`.env.example`** — added `PM_COMPANY_APP_URL` to the server-side
  list and documented `VITE_LANDLORD_APP_URL` / `VITE_TENANT_APP_URL` /
  `VITE_PM_COMPANY_APP_URL` (browser-bundle vars, prefixed for Vite,
  set in per-app `.env` files).

### Verification
- API `tsc --noEmit` exit 0.
- Tenant `tsc --noEmit` exit 0.
- pm-company `tsc --noEmit` exit 0.
- Landlord `tsc --noEmit` exit 0.

## What S163 should target

### Priority 1 — Connect-readiness backfill for existing accounts

Pre-S160 landlord Connect accounts (and pre-S159 PM Connect accounts)
exist with `connect_payouts_enabled=false` even though they may be
fully verified at Stripe. The webhook will eventually re-fire
`account.updated` and the booleans will flip, but Stripe doesn't
guarantee a schedule.

One-shot job:
- Walk `users WHERE stripe_connect_account_id IS NOT NULL AND
  connect_payouts_enabled = false`.
- For each, call `fetchAccountStatus(connectAccountId)` and
  populate the booleans matching the live state.
- Same for `pm_companies WHERE stripe_connect_account_id IS NOT NULL
  AND connect_payouts_enabled = false`.

Run as a manual admin command (`POST /api/admin/connect-readiness/backfill`)
or as a one-off CLI script. Recommend the admin command — easier to
re-run if needed and admin context is appropriate for the rate-limited
Stripe calls.

### Priority 2 — Disbursement requeue when Connect re-readies

When a disbursement is marked failed with `connect_not_ready`, the
user's later KYC completion doesn't automatically reschedule the
payout. The user has to manually request another withdrawal.

Two options:
- **Cron**: scan `disbursements WHERE status='failed' AND notes LIKE
  '%connect_not_ready%'` after each `account.updated` webhook flip;
  re-queue if the user is now ready and there's still balance.
- **Manual**: surface failed disbursements on the BankingPage with a
  "Retry" button that re-queues. Simpler, gives the user agency.

Recommend manual. The cron approach is harder to reason about and the
failure rate should be low (only happens when KYC is suspended
mid-stream).

### Priority 3 — Tenant payment surface CTA

S162's `LandlordBankingBanner` is a pure read-only message. There's no
direct "ping your landlord" action. Two-step add:
- Backend endpoint `POST /api/tenants/me/nudge-landlord-banking` that
  emails the landlord with a "your tenant is waiting on you to finish
  banking onboarding" message.
- Frontend button on the banner.

Optional polish; defer if there are more pressing items.

### Priority 4 — `apps/admin` Connect-readiness dashboard

Admin-side surface that shows all Connect accounts and their cached
readiness state, with a button to refresh from Stripe live. Useful for
support — when a landlord calls saying "tenants can't pay," admin can
verify if it's a Connect-readiness issue at a glance.

### Priority 5 — Clean up the legacy `bank_account_id` field on `pm_companies`

Schema has both `bank_account_id` (S108, points at `user_bank_accounts`)
and `stripe_connect_account_id` (S115). Under S113 destination charges,
the Stripe Connect account is the routing destination; the legacy
`bank_account_id` field is dead code on PM companies.

Audit consumers, mark deprecated, remove in a later migration. NOT
urgent — current code paths don't choke on the unused column.

## Files touched in S162

```
apps/api/src/routes/webhooks.ts                                          (comment refresh + PROD CHECKLIST)
apps/api/src/services/disbursementFiring.ts                              (+ Connect-readiness recheck)
apps/api/src/routes/tenants.ts                                           (+ landlord-banking-status endpoint)
apps/tenant/src/main.tsx                                                 (+ LandlordBankingBanner)
apps/pm-company/src/pages/RegisterPage.tsx                               (env-driven cross-portal URLs)
.env.example                                                              (+ VITE_*_APP_URL docs)
```

## Carry-forward from earlier sessions still open

- **OTP disbursement engine integration** — `ONTIMEPAY`-tagged payments
  flowing into ACH push to landlord. Surfaces during S113 allocation
  engine rebuild.
- **OTP reenrollment override UI** — punted to first real default in beta.
- **`lease_fees.due_timing` move_out / other wiring** — needs product
  call (S144 mitigation in place via gap notification).
- **`apps/landlord/src/pages/PmInvitationsPage.tsx` autocomplete** —
  owner currently types PM company UUID by hand. Defer until real-
  world feedback.
- **Connect endpoint duplication** — `/api/pm/companies/:id/connect/*`
  and `/api/stripe/connect/*` overlap. Both intentionally kept;
  revisit if a third caller emerges.
- **`pm_companies.bank_account_id`** (S163 Priority 5) — legacy field
  superseded by stripe_connect_account_id under S113. Audit and
  deprecate later.

## Manual smoke flow (when Nic chooses to run it)

After S162, end-to-end Connect-readiness gating works on all four
trust boundaries (landlord write, PM write, tenant read, disbursement
fire):

1. `dev.sh` → all 9 portals up.
2. **Webhook check**: confirm Stripe Dashboard webhook endpoint config
   includes `account.updated` in the events list. Without it, every
   readiness gate stays at default false in prod.
3. **Tenant :3002**: with landlord's
   `users.connect_payouts_enabled=false`, the dashboard + Payments
   page show the gold-bordered "Online rent payment temporarily
   unavailable" banner.
4. After landlord completes Connect onboarding (via :3001/banking →
   embedded onboarding → webhook fires → flag flips), the tenant
   banner self-hides on next refetch.
5. **Disbursement firing**: a queued disbursement whose user got
   suspended between queue and fire now lands in `failed` status
   with notes `connect_not_ready` — no zombie pending row.
6. **PM RegisterPage**: cross-portal "I'm a landlord" / "I'm a tenant"
   buttons read from VITE_*_APP_URL env vars (default to localhost in
   dev).

# Session 162 — Tenant-side Connect-readiness UX + landlord disbursement-firing details

## What S161 shipped

S161 closed Priorities 1–3 from the S160 handoff: gate enforcement on
the readiness booleans added in S160, legacy PMDashboardPage removal,
and the small Accept-button polish in the PM portal.

### Backend
- **`apps/api/src/routes/withdrawals.ts`** — manual on-demand
  withdrawal route (`POST /api/withdrawals/me/withdrawals`) refuses
  with 409 when the caller's `users.connect_payouts_enabled=false` or
  `connect_details_submitted=false`. Error directs them to /banking.
  Same shape as the S159 PM-side accept guard.
- **`apps/api/src/jobs/autoPayouts.ts`** — Friday payout queueing
  skips users who aren't Connect-ready. New outcome
  `kind: 'connect_not_ready'` plus a `skippedConnectNotReady` counter
  on `PayoutResult`. Once a user finishes KYC and the webhook flips
  the flag, the next Friday's run picks them up automatically without
  manual intervention.

### Frontend
- **`apps/landlord/src/pages/PropertiesPage.tsx`** — new
  `ConnectReadinessBanner` component above the summary stats. Soft
  warning that links to /banking; doesn't block property creation
  (per Nic's "data lands first, rent rail comes up second" posture).
  Self-hides when `payouts_enabled && details_submitted` are both
  true. Reads from `/api/stripe/connect/status?entity=user`.
- **`apps/pm-company/src/pages/InvitationsPage.tsx`** — Accept button
  on `owner_to_pm + manage` invites now disables and shows a tooltip
  when the company's banking is known-incomplete. "Complete banking →"
  link rendered alongside. Reads `connect_payouts_enabled` +
  `connect_details_submitted` from the company query (existing
  GET /pm/companies/:id; `SELECT *` already includes them).

### Cleanup
- **Deleted `apps/landlord/src/pages/PMDashboardPage.tsx`** + its
  import + the `/pm` route in `apps/landlord/src/main.tsx`. Pre-S157
  inline PM-company-creation flow; redundant under the standalone
  PM portal at :3011. No data migration needed (rows it created live
  in the same `pm_companies` table as portal-created ones).

### Verification
- API `tsc --noEmit` exit 0.
- Landlord `tsc --noEmit` exit 0.
- pm-company `tsc --noEmit` exit 0.

## What S162 should target

### Priority 1 — Tenant-side Connect-readiness UX

When a tenant attempts to pay rent on a unit whose landlord's Connect
account isn't ready, the destination charge will fail at Stripe. We
should surface this BEFORE the tenant tries to pay:
- **Tenant payment-initiation page** — read the landlord's
  `connect_payouts_enabled` (via a new endpoint
  `GET /api/tenants/me/landlord-banking-status` or similar — only
  returns the boolean, not any other landlord PII) and replace the
  Pay button with "Your landlord hasn't finished banking setup. Ask
  them to finish it before paying online."
- **Tenant dashboard banner** — same surface, near rent-due cards.

Proposes one new endpoint for tenant scope. Keep the response minimal
(boolean only) — tenants shouldn't see Connect account state details.

### Priority 2 — Stripe webhook event for `account.updated` is registered

S159/S160 wrote the `recordAccountUpdated` handler that flips the
readiness booleans, but I haven't verified the webhook router actually
calls it on `account.updated` events. If the webhook config only
listens for `payment_intent.*` and `payout.*`, the readiness flags will
NEVER flip in production, and the gates from S161 will block forever.

Verification + fix:
- Find the webhook router (likely `routes/webhooks.ts` or inside
  `routes/stripe.ts`).
- Confirm the switch on `event.type` includes `'account.updated'` and
  routes to `recordAccountUpdated`.
- If not, add it. This is a one-line fix but high-impact.
- Also confirm Stripe's webhook endpoint config (in Stripe Dashboard
  or via API) has `account.updated` in the events list. Note for Nic
  to check this in his test mode.

### Priority 3 — `fireDisbursement` Connect-readiness handling

The auto-Friday queueing now skips Connect-not-ready users (S161). But
manually queued disbursements still go through `fireDisbursement` (in
`services/disbursementFiring.ts`) which presumably calls Stripe Payouts
or similar. If Stripe rejects the payout because the destination
account isn't ready, the disbursement row stays in 'pending' status
forever.

Investigate `services/disbursementFiring.ts`:
- What does it do when Stripe returns "destination account not
  payout-eligible"?
- Should it auto-retry on the next Friday after a webhook lands? Or
  flip the disbursement to a terminal failure state with a clear
  reason?

Recommend: terminal failure with reason='connect_not_ready'; require
manual re-queue once Connect is ready. Avoids zombie pending rows.

### Priority 4 — Tenant-portal cross-portal env URLs

S160 added cross-portal escape links to the PM RegisterPage with
hardcoded localhost URLs. Refactor those to be env-driven:
- `VITE_LANDLORD_APP_URL`, `VITE_TENANT_APP_URL` env vars
- Same change in any other portal that links cross-portal
- Document in `.env.example`

Five-minute task. Only matters when prod deploy is on the agenda.

### Priority 5 — `users` connect-readiness backfill

If any landlords had Connect accounts before the S160 migration that
added the readiness booleans, they're stuck at default false until
their next `account.updated` webhook fires. Stripe re-fires
`account.updated` periodically but not on a known schedule.

Two options:
- Wait for natural webhook re-fires.
- Write a one-shot job that walks `users WHERE
  stripe_connect_account_id IS NOT NULL` and pulls live state from
  Stripe via `fetchAccountStatus`, populating the booleans.

Recommend: wait. Pre-launch dev environment, no real users yet, the
backfill is unnecessary for now. Note in the handoff so it doesn't
get forgotten when production launches.

## Files touched in S161

```
apps/landlord/src/pages/PMDashboardPage.tsx                              DELETED
apps/landlord/src/main.tsx                                               (- import + route)
apps/landlord/src/pages/PropertiesPage.tsx                               (+ ConnectReadinessBanner)
apps/pm-company/src/pages/InvitationsPage.tsx                            (Accept gating)
apps/api/src/routes/withdrawals.ts                                       (+ readiness guard)
apps/api/src/jobs/autoPayouts.ts                                         (+ connect_not_ready outcome)
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
  (S159) and `/api/stripe/connect/*` (S115) overlap. Both are
  intentionally kept — namespacing reads cleanly at the client level.
  Revisit if a third caller emerges.

## Manual smoke flow

After S161, the readiness gates fire end-to-end in dev with Stripe test mode:
1. `dev.sh` → all 9 portals up (including PM at :3011).
2. **Landlord :3001/properties** → red "Connect onboarding incomplete"
   banner shows when `users.connect_payouts_enabled=false`.
3. **Landlord :3001** → try to manually withdraw — gets 409 with
   "Stripe Connect onboarding incomplete" message.
4. **Friday auto-payout cron run** → user gets skipped with
   `kind: 'connect_not_ready'`. Check the result: `skippedConnectNotReady > 0`.
5. **PM :3011/invitations** → an `owner_to_pm + manage` incoming
   invite shows Accept button disabled with tooltip until the PM
   completes banking.
6. Complete Connect onboarding via :3001/banking or :3011/banking →
   webhook flips `connect_payouts_enabled = true` → all four gates
   above unlock automatically.

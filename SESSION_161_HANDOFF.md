# Session 161 — Legacy cleanup + advanced PM portal features

## What S160 shipped

S160 closed Priorities 1–4 from the S159 handoff: landlord-side Connect
parity, the cron helper consolidation, and three PM portal polish items.

### Backend
- **Migration `20260506170000_users_connect_readiness.sql`** — three
  boolean readiness flags on `users`:
  `connect_charges_enabled`, `connect_payouts_enabled`,
  `connect_details_submitted`. Mirror of the pm_companies pattern from
  S159 migration 20260506160000. Default false. Partial index
  `idx_users_connect_ready`.
- **`apps/api/src/services/stripeConnect.ts`** — `recordAccountUpdated`
  now flips the readiness booleans on BOTH users and pm_companies in
  one webhook fire. The previous PM-only path is unchanged in behavior;
  the user UPDATE was added alongside it.
- **`apps/api/src/jobs/scheduler.ts`** — `processInvitationExpiry`
  switched its inline `pm_property_invitations` UPDATE to call
  `expireStaleInvitations` from `services/pm.ts`. The two
  `pm_invitations` (staff-onboarding) sweeps remain inline; consolidate
  later if a parallel helper lands.
- **No new endpoints needed** — recon during S160 found that
  `/api/stripe/connect/onboarding-session` and `/connect/status` (S115)
  already accept `entity='user'`. The landlord BankingPage uses these.
  Avoided duplicating with `/api/landlords/me/connect/*`.

### Frontend (landlord portal)
- **`apps/landlord/package.json`** — added `@stripe/connect-js` ^3.4.2
  and `@stripe/react-connect-js` ^3.4.1.
- **`apps/landlord/src/pages/BankingPage.tsx`** — new
  `StripeConnectSection` component above the legacy 16a bank-account
  catalog. Three-state status badge (Ready / Verifying / Onboarding
  incomplete), embedded `<ConnectAccountOnboarding />` flow,
  outstanding-requirements line, 3-second polling during active
  onboarding to catch capability flips before the webhook lands. Same
  pattern as the PM portal's BankingPage.

### Frontend (PM portal)
- **`apps/pm-company/src/pages/SettingsPage.tsx`** — read-only state
  swapped for an inline edit mode. Owner|manager only (read from
  `activePmCompany.my_role`). Editable fields: name, business_email,
  business_phone, business_street1/city/state/zip, ein. Save calls
  `PATCH /api/pm/companies/:id`. Cancel discards local state.
- **`apps/pm-company/src/pages/RegisterPage.tsx`** — new info banner
  on the company-creation step when a signed-in user has no pm_staff
  membership. Banner offers two-button shortcuts back to the Landlord
  Portal (3001) or Tenant Portal (3002) so cross-portal users aren't
  funneled into PM signup against their will.
- **`apps/pm-company/src/pages/PropertiesPage.tsx`** — `unit_count`
  placeholder column replaced with `total_units` + occupied count.
  No backend change (the existing `/api/properties` already returns
  these aggregates from S66+).

### Verification
- 1 migration applied (users readiness booleans).
- API `tsc --noEmit` exit 0.
- Landlord `tsc --noEmit` exit 0.
- pm-company `tsc --noEmit` exit 0.
- `@stripe/connect-js` + `@stripe/react-connect-js` installed in
  landlord (and pm-company already had them from S159).

## What S161 should target

### Priority 1 — Landlord Connect bank-readiness gates

The cached booleans on `users.connect_*_enabled` are populated by the
S160 webhook fix, but no business logic READS them yet. Likely gate
points:
- **Tenant ACH/card payment initiation** — when the landlord on the
  property hasn't completed Connect KYC, prompt the tenant with
  "your landlord hasn't finished banking setup; ask them to finish
  before paying online" rather than trying a destination charge that
  Stripe will reject.
- **Property creation / activation** — soft warning when a landlord
  with `connect_payouts_enabled=false` adds a property; doesn't block
  but surfaces a banner pointing at /banking.
- **Disbursement initiation (manual on-demand or auto-Friday)** —
  refuse if `connect_payouts_enabled` is false. Today the 16a path
  uses `user_bank_accounts`; under S113 this becomes Connect.

Recommend: start with property creation (cheapest, lowest risk) and
the disbursement initiation guard. Tenant-facing flow needs more
product input.

### Priority 2 — Legacy `apps/landlord/src/pages/PMDashboardPage.tsx`

Pre-S157 inline PM-company-creation flow. Now redundant under the
self-serve PM portal at `:3011`. S160 didn't touch it.

Options:
- **Delete** outright — orphan route at `/pm` removed from main.tsx
  too. Risk: any pm_companies created via this surface keep working
  (they're rows in the same table as portal-created ones); no data
  migration needed.
- **Convert to a redirect** — `/pm` → `/pm-invitations` so old
  bookmarks land on the new linkage management surface.
- **Keep** with a deprecation banner.

Recommend: delete. The schema is symmetric, the new portal is
end-to-end, and the surface duplicates what the landlord can do via
PM Invitations + the PM portal.

### Priority 3 — PM portal accept-blocking when Connect is incomplete

S159 added the backend guard. The PM portal InvitationsPage already
surfaces the "Open Banking page now?" confirm. But the `Accept`
button itself stays clickable even when banking is known-incomplete
(cached state on the company is visible to the PM). UX nit:
disable Accept and show a tooltip "Complete banking onboarding first"
when `connect_payouts_enabled=false`. Tiny change; nice polish.

### Priority 4 — Anti-duplication on Connect endpoints

S159 added `POST /api/pm/companies/:id/connect/onboarding-link` +
`GET /connect/account-status`. S115 had already shipped the shared
`POST /api/stripe/connect/onboarding-session` + `GET /status` that
serve both entity types. The two pairs do the same work via different
URLs.

Decision needed:
- **Keep both** — namespacing (pm/, stripe/) reads cleanly from the
  client and keeps PM-portal client code self-contained.
- **Collapse to shared** — one canonical home; both client portals
  call `/api/stripe/connect/*`.

Recommend: keep both for now. The duplication cost is low and the
namespacing is genuinely clearer at the client level. Revisit if a
third caller emerges.

### Priority 5 — Cross-portal session detection

S160 added the cross-portal escape links on the PM RegisterPage, but
they're hardcoded http://localhost:3001 / 3002. In production these
should be env-driven (e.g. `VITE_LANDLORD_APP_URL`,
`VITE_TENANT_APP_URL`). Five-minute fix; defer until a real prod
deploy is on the agenda.

## Files touched in S160

```
apps/api/src/db/migrations/20260506170000_users_connect_readiness.sql   NEW
apps/api/src/db/schema.sql                                              (auto-regenerated)
apps/api/src/services/stripeConnect.ts                                  (users readiness flips)
apps/api/src/jobs/scheduler.ts                                          (calls expireStaleInvitations helper)
apps/landlord/package.json                                              (+ @stripe SDK deps)
apps/landlord/src/pages/BankingPage.tsx                                 (+ StripeConnectSection)
apps/pm-company/src/pages/SettingsPage.tsx                              (read-only → inline edit)
apps/pm-company/src/pages/RegisterPage.tsx                              (no-membership banner + portal exits)
apps/pm-company/src/pages/PropertiesPage.tsx                            (unit_count → total_units)
```

## Carry-forward from earlier sessions still open

- **OTP disbursement engine integration** — `ONTIMEPAY`-tagged payments
  flowing into ACH push to landlord. Surfaces during S113 allocation
  engine rebuild.
- **OTP reenrollment override UI** — punted to first real default in beta.
- **`lease_fees.due_timing` move_out / other wiring** — needs product
  call (S144 mitigation in place via gap notification).
- **`apps/landlord/src/pages/PmInvitationsPage.tsx` autocomplete** —
  owner currently types PM company UUID by hand. PM-company
  autocomplete deferred until real-world feedback.

## Manual smoke flow (when Nic chooses to run it)

After S160, both sides of Connect Express onboarding are usable in dev:
1. `dev.sh` → all 9 portals up, including PM at :3011 and the API.
2. **Landlord side:** `:3001/banking` → "Start Stripe Onboarding" →
   embedded form → exit → status badge flips Ready once webhook fires.
3. **PM side:** identical flow at `:3011/banking`.
4. Webhook events from Stripe test mode populate
   `users.connect_*_enabled` and `pm_companies.connect_*_enabled`
   booleans. Verify with `psql gam -c "SELECT email,
   connect_payouts_enabled, connect_details_submitted FROM users
   WHERE stripe_connect_account_id IS NOT NULL;"`.
5. **PM Settings edit:** `:3011/settings` → Edit → change company
   name → Save → row reflects via PATCH /pm/companies/:id.

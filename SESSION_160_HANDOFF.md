# Session 160 — Connect onboarding for landlords + PM portal polish + cleanup

## What S159 shipped

S159 closed out Priorities 1 & 2 from S158's handoff: Stripe Connect
Express embedded onboarding for PM companies (production-blocking gate
on the S157 handshake) plus the deferred owner-visibility frontend.

### Backend
- **Migration `20260506160000_pm_companies_connect_readiness.sql`** —
  three boolean readiness flags on `pm_companies`:
  `connect_charges_enabled`, `connect_payouts_enabled`,
  `connect_details_submitted`. Default false. Plus partial index
  `idx_pm_companies_connect_ready` for the accept-time guard query.
  No backfill needed (no PM accounts have shipped yet).
- **`apps/api/src/services/stripeConnect.ts`** — `recordAccountUpdated`
  webhook handler now flips the three booleans on `pm_companies` from
  the incoming Stripe Account object's capability fields. Landlord
  side intentionally untouched in S159 (separate scope; same booleans
  on `users` should land in S160).
- **`apps/api/src/services/pm.ts → acceptPropertyInvitation`** — new
  bank-readiness guard. When direction='owner_to_pm' AND
  proposed_scope='manage', refuses with 409 unless
  `connect_payouts_enabled=true AND connect_details_submitted=true`.
  Error message directs the PM to /banking. 'view' scope and
  'pm_to_owner' direction skip the guard (no money flows there).
- **Two new endpoints on `routes/pm.ts`:**
  - `POST /api/pm/companies/:id/connect/onboarding-link` —
    idempotent. Calls `ensureConnectAccount({entity:'pm_company'})`
    then `createOnboardingSession`. Returns connect_account_id +
    client_secret. Caller must be active staff with role owner|manager.
  - `GET /api/pm/companies/:id/connect/account-status` — synchronous
    Stripe round-trip returning the live capability flags. Used by
    BankingPage during onboarding to show "verifying…" state before
    the webhook lands. Any active staff can call (read-only).

### Frontend (PM portal)
- **`apps/pm-company/src/pages/BankingPage.tsx`** — placeholder
  replaced with full Stripe Connect Express embedded onboarding.
  Three layers: cached state from `pm_companies.connect_*_enabled`,
  live state polled every 3s during active onboarding, and the
  embedded `<ConnectAccountOnboarding />` component itself. Status
  badge has three states: Ready (cached + live both true), Verifying…
  (live ready but webhook hasn't landed), Onboarding incomplete /
  Not started. Outstanding-requirements line surfaces Stripe's
  `requirements_currently_due` list.
- **`apps/pm-company/src/pages/InvitationsPage.tsx`** — accept
  handler now branches on the new "banking onboarding incomplete"
  409 error and offers "Open the Banking page now?" confirm. The
  existing currently-managed conflict-replay path is unchanged.
- **`apps/pm-company/package.json`** — added `@stripe/connect-js`
  ^3.4.2 + `@stripe/react-connect-js` ^3.4.1.

### Frontend (landlord portal)
- **`apps/landlord/src/pages/DashboardPage.tsx`** —
  `PmCutThisMonthCard` component added between the KPI grid and the
  OTP Pipeline section. Self-hides when no PM linkage exists or all
  pm_company_cut values are zero. Two-tile layout: PM Cut MTD (gold)
  and Net to You MTD (green). Click routes to /disbursements.
- **`apps/landlord/src/pages/DisbursementsPage.tsx`** —
  `PmImpactSection` component added between balance/withdraw and the
  payouts table. Per-property breakdown for the current month: PM
  company name, fee plan, gross/PM fee/your net columns. Header row
  shows totals across properties. Self-hides when no property has a
  PM company linked.
- **`apps/landlord/src/pages/PropertyDetailPage.tsx`** — `PmLinkageCard`
  component added between the stats grid and the occupancy bar. Two
  states: linked (gold accent, shows PM company + fee plan + Manage
  CTA) or unlinked (neutral card, "Invite PM Company" CTA). Both
  CTAs route to /pm-invitations.

### Verification
- 1 migration applied cleanly; 4 most-recent migrations confirmed in
  `schema_migrations`.
- API `tsc --noEmit` exit 0.
- Landlord `tsc --noEmit` exit 0.
- pm-company `tsc --noEmit` exit 0.
- `@stripe/connect-js` + `@stripe/react-connect-js` install clean.

## What S160 should target

### Priority 1 — Connect Express onboarding for landlords (parity with PMs)

The S159 readiness booleans + webhook flip + accept guard pattern is
PM-only. Landlord Connect accounts use the same `services/stripeConnect.ts`
helpers but landlord BankingPage doesn't yet host the embedded
onboarding component. Migration to add `users.connect_charges_enabled`
+ `users.connect_payouts_enabled` + `users.connect_details_submitted`,
extend `recordAccountUpdated` to populate them, add the matching
landlord-side endpoints (`POST /api/landlords/me/connect/onboarding-link`
+ `GET /api/landlords/me/connect/account-status`), and replace the
landlord BankingPage placeholder with the embedded component.
Symmetry check: any other place that needs to gate on landlord bank
readiness should now use the cached booleans instead of doing live
Stripe round-trips on the hot path.

### Priority 2 — `expireStaleInvitations` service helper

S158 wired the cron sweep inline (raw UPDATE). The companion service
helper `expireStaleInvitations()` exists in `services/pm.ts` and is
unused. Either:
- Switch the cron to call the helper (so future tests can exercise the
  same code path), or
- Delete the helper if the inline UPDATE is the canonical home.

Recommend: switch the cron to call the helper. Tests will appreciate
it and the duplication is small.

### Priority 3 — PM portal polish

- **`apps/pm-company/src/pages/SettingsPage.tsx`** — currently
  read-only. Wire the existing `PATCH /api/pm/companies/:id`
  endpoint for inline editing of company details (name, contact info,
  address, EIN). Owner|manager only.
- **`apps/pm-company/src/pages/PropertiesPage.tsx`** — `unit_count`
  column shows '—'. Either extend `/api/properties` to include
  unit_count or do a separate fetch + join client-side. Recommend
  extending the endpoint (cheap, value across portals).
- **PM portal "no membership" landing** — current behavior funnels
  signed-in users without pm_staff to /register. Edge case: a
  tenant or landlord landing on the PM portal gets the same funnel.
  Recommend: registration page becomes the landing for "no
  membership" with explicit "I'm a tenant/landlord — take me back"
  links to the appropriate portal (3001 / 3002).

### Priority 4 — Legacy cleanup

- **`apps/landlord/src/pages/PMDashboardPage.tsx`** — pre-S157 inline
  PM-company-creation flow. Now redundant under self-serve PM portal
  registration. Mark deprecated; delete in a later pass once Nic
  confirms no existing data flows through it. NOT urgent.
- **`apps/landlord/src/pages/PmInvitationsPage.tsx`** — currently
  asks the owner to type the PM company UUID by hand into the
  invite-send form (no directory). With landlords now seeing PM
  companies in the linked-properties picker (S158 SettingsPage),
  consider a "PM company autocomplete" widget that searches across
  pm_companies the user has interacted with (sent invites to,
  received invites from, currently linked). Defer until the PM portal
  is in real-world use and Nic has feedback on what discoverability
  should look like.

## Files touched in S159

```
apps/api/src/db/migrations/20260506160000_pm_companies_connect_readiness.sql   NEW
apps/api/src/db/schema.sql                                            (auto-regenerated)
apps/api/src/services/stripeConnect.ts                                (recordAccountUpdated populates new flags)
apps/api/src/services/pm.ts                                           (+ bank-readiness guard on accept)
apps/api/src/routes/pm.ts                                             (+ 2 Connect endpoints)
apps/pm-company/package.json                                          (+ @stripe SDK deps)
apps/pm-company/src/pages/BankingPage.tsx                             (full rewrite — embed)
apps/pm-company/src/pages/InvitationsPage.tsx                         (banking-incomplete branch)
apps/landlord/src/pages/DashboardPage.tsx                             (+ PmCutThisMonthCard)
apps/landlord/src/pages/DisbursementsPage.tsx                         (+ PmImpactSection)
apps/landlord/src/pages/PropertyDetailPage.tsx                        (+ PmLinkageCard)
```

## Carry-forward from S157/S158 still open

- **OTP disbursement engine integration** — `ONTIMEPAY`-tagged payments
  flowing into ACH push to landlord. Will surface naturally during
  S113 allocation engine rebuild.
- **OTP reenrollment override UI** — punted to first real default in beta.
- **`lease_fees.due_timing` move_out / other wiring** — still needs a
  product call (S144 mitigation in place via gap notification).

## Manual smoke flow (when Nic chooses to run it)

After S159, end-to-end PM handshake works in dev with a Stripe test
account:
1. `dev.sh` → all 9 portals up, including PM at :3011.
2. PM portal :3011 → register → create company → /banking → "Start
   Stripe Onboarding" → embedded form completes → webhook flips
   `connect_payouts_enabled` true → status badge flips Ready.
3. Landlord portal :3001 → /pm-invitations → Invite PM Company → use
   the PM company's UUID from step 2 → email sends to the PM.
4. PM portal :3011 → /invitations → incoming → Accept → guards pass
   (banking ready) → property linked.
5. Landlord :3001 → /dashboard → PmCutThisMonthCard appears once a
   payment hits with PM cut. /disbursements → PmImpactSection rows
   show per-property gross/PM fee/your net.
6. Property /properties/:id → PmLinkageCard shows the linked PM
   company + fee plan.

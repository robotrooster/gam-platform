# Session 159 — Stripe Connect Express onboarding for PMs + owner-visibility frontend

## What S158 shipped

S158 picked up the S157 follow-through: the PM property-link handshake
needed a PM-side surface (Path A from S157 left both halves of the
handshake landlord-only). S158 delivered the missing PM portal end-to-
end, plus several owner-visibility quick wins and a cron sweep.

### Backend
- **`apps/api/src/jobs/scheduler.ts`** — extended `processInvitationExpiry`
  cron to sweep `pm_property_invitations` alongside the existing
  in-house and PM staff sweeps. 72-hour TTL, no platform_events row
  (consistent with pm_invitations posture).
- **`apps/api/src/routes/landlords.ts`** — new endpoint
  `GET /api/landlords/me/linked-pm-companies`. Returns distinct
  `pm_companies` currently set on any of the landlord's properties,
  with property counts. Drives the SettingsPage default-PM picker
  (only previously-linked PMs are eligible defaults).

### Frontend (landlord portal)
- **`apps/landlord/src/pages/SettingsPage.tsx`** — new "Default PM
  Company" card. Shows current default with Clear button; picker over
  linked PMs only. Empty state directs the user to `/pm-invitations`
  if no PM is linked yet.

### Frontend (NEW: `apps/pm-company` standalone Vite app on port 3011)
**Port note:** Originally planned for 3008, but `apps/listings` already
occupied that (CLAUDE.md port table was stale, now corrected). 3010 was
also unavailable per Nic. Final pick: **3011**. CLAUDE.md port table
updated to list both `listings:3008` and `pm-company:3011`.

Files:
- `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`,
  `index.html` — standard Vite + React + TS scaffold mirroring landlord.
- `src/styles/globals.css` — copied wholesale from
  `apps/landlord/src/styles/globals.css` (gold/dark theme).
- `src/lib/api.ts` — axios instance with JWT attachment, 401 auto-logout.
- `src/context/AuthContext.tsx` — shared-JWT auth (one user across all
  GAM portals); also tracks the user's `pm_staff` memberships and
  exposes an `activePmCompany` selector for users who belong to
  multiple PM companies (with localStorage persistence).
- `src/main.tsx` — React Router setup with PrivateRoute that funnels
  users without any pm_staff membership to `/register`.
- `src/components/Layout.tsx` — sidebar with role/email footer + active-
  company switcher (rendered only when user has 2+ memberships).
- `src/pages/LoginPage.tsx` — shared-JWT login.
- `src/pages/RegisterPage.tsx` — two-step flow: account creation
  (POST /auth/register), then company creation (POST /pm/companies).
  Existing signed-in users skip step 1.
- `src/pages/DashboardPage.tsx` — KPI tiles (incoming pending invites,
  outgoing pending, recent payouts) + getting-started checklist.
- `src/pages/InvitationsPage.tsx` — PM-side mirror of landlord's
  PmInvitationsPage. Full handshake: list incoming/outgoing, send modal
  (property_id + landlord_id + email + scope + fee plan picker),
  accept/reject incoming with conflict-on-409 confirm-and-replay.
- `src/pages/PropertiesPage.tsx` — read-only list of linked properties
  (filters `/properties` to those where `pm_company_id == active company`).
- `src/pages/FeePlansPage.tsx` — CRUD-lite for `pm_fee_plans`. Create
  via modal (type-aware fields); deprecate via row action; no in-place
  edit (audit invariant — changes spawn a new plan via deprecation).
- `src/pages/StaffPage.tsx` — members table + pending invitations table
  + invite modal hitting the existing S109/S112 endpoints.
- `src/pages/BankingPage.tsx` — Connect status card + payouts table.
  Connect onboarding hook is a placeholder pointing to S159 work.
- `src/pages/SettingsPage.tsx` — read-only company details panel.

### dev.sh + CLAUDE.md
- `dev.sh` adds `apps/pm-company` startup line and includes 3011 in the
  port-kill array, port-listening sweep, and the printed port map.
- `CLAUDE.md` "Portals and ports" section now lists `apps/listings:3008`
  (was missing) and adds `apps/pm-company:3011`. PM-landmine entry's
  port reference updated from 3008 to 3011.

### Verification
- `npm run db:migrate` — already up-to-date (no new migrations in S158).
- API `tsc --noEmit` exit 0.
- Landlord `tsc --noEmit` exit 0.
- pm-company `tsc --noEmit` exit 0.
- `npm install --workspace=apps/pm-company` ran clean.

## What S159 should target

### Priority 1 — Stripe Connect Express embedded onboarding for PMs

The PM portal `BankingPage` currently shows a "coming soon" placeholder.
This blocks the end-to-end production usage of S157's handshake:
`acceptPropertyInvitation` should refuse owner_to_pm acceptances when
`pm_companies.bank_account_ready=false` (or whatever the Connect-
completed boolean ends up being), since money will flow on accept.

Steps:
1. In `apps/api/src/services/stripeConnect.ts`, add a parallel
   `createPmCompanyConnectAccount(pmCompanyId)` to the existing
   landlord helper. Account holder type = `company` for PMs.
2. New endpoint `POST /api/pm/companies/:id/connect/onboarding-link`
   returning the embedded session URL.
3. In `apps/pm-company/src/pages/BankingPage.tsx`, replace the
   placeholder with the embedded `<ConnectAccountOnboarding />`
   component (Stripe React Connect SDK). On completion, refetch the
   pm_company so the "Ready" badge flips.
4. In `apps/api/src/services/pm.ts → acceptPropertyInvitation`, add a
   guard: when `direction='owner_to_pm'`, fail with `409` and a clear
   error message if `pm_companies.bank_account_ready=false`. Update
   the matching error handling in
   `apps/pm-company/src/pages/InvitationsPage.tsx` to surface "complete
   onboarding first" with a link to `/banking`.
5. Webhook handling: extend the existing Stripe webhook router to
   handle `account.updated` events for PM Connect accounts (mirror
   landlord pattern). Flip `bank_account_ready` when `payouts_enabled`
   becomes true and `details_submitted=true`.

### Priority 2 — Owner-visibility quick wins (deferred from S158)

- **`apps/landlord/src/pages/DashboardPage.tsx`** — add tile "PM cut
  this month: $X / Net to you: $Y" linking to `/disbursements`. Data
  source: aggregate `pm_monthly_fee_accruals` + `user_balance_ledger`
  for the current month, joined on `landlord.id`. May need a new
  `GET /api/landlords/me/pm-cut-summary?month=YYYY-MM` aggregate.
- **`apps/landlord/src/pages/DisbursementsPage.tsx`** — add four
  columns (`gross`, `pm_fee`, `gam_fee`, `net_to_owner`) per row.
  Source: existing user_balance_ledger / platform_revenue_ledger
  joins; pm_fee from rows with type='allocation_pm_company_fee' on
  the same payment_id; gam_fee from platform_revenue_ledger entries
  on the same payment_id.
- **`apps/landlord/src/pages/PropertyDetailPage.tsx`** — add "PM
  Linkage" section near the top. Show current pm_company name + fee
  plan name if set. CTA: "Manage PM linkage" linking to `/pm-invitations`
  (or open a modal to send a new invite for this property pre-selected).

### Priority 3 — Misc cleanup

- **`apps/landlord/src/pages/PMDashboardPage.tsx`** — currently lets
  landlords inline-create PM companies, which is now redundant under
  S157's self-serve registration model. Mark deprecated; remove in a
  later pass. Don't delete yet — there may be existing PM-company
  rows created via this surface that the new portal flow needs to
  handle gracefully.
- **`apps/pm-company` Settings editing** — currently read-only.
  Wire the existing `PATCH /pm/companies/:id` endpoint to enable
  inline editing of company details.
- **`apps/pm-company` PropertiesPage** — replace the
  `unit_count` placeholder column with a real value from the
  properties endpoint (or extend the endpoint to include it).

### Priority 4 — auth refinement

The shared-JWT model means `apps/auth/login` returns the same payload
to all portals. The PM portal currently routes anyone signed in but
without pm_staff to `/register`. Edge case: an existing tenant or
landlord who lands on the PM portal will be funneled into PM signup
even if that's not their intent. Should the PM portal:
- Redirect cross-portal users to their primary portal? OR
- Show a "you're not part of any PM company — register one or sign
  out" landing page?

Recommend: registration page itself becomes the landing for "no
membership" state, with an explicit "I'm a tenant/landlord, take me
back" link to the appropriate portal.

## Files touched in S158

```
apps/api/src/jobs/scheduler.ts                   (+ pm_property_invitations sweep)
apps/api/src/routes/landlords.ts                 (+ /me/linked-pm-companies)
apps/landlord/src/pages/SettingsPage.tsx         (+ Default PM Company card)
apps/pm-company/                                  NEW directory tree:
  ├── package.json
  ├── vite.config.ts
  ├── tsconfig.json
  ├── tsconfig.node.json
  ├── index.html
  └── src/
      ├── main.tsx
      ├── styles/globals.css
      ├── lib/api.ts
      ├── context/AuthContext.tsx
      ├── components/Layout.tsx
      └── pages/
          ├── LoginPage.tsx
          ├── RegisterPage.tsx
          ├── DashboardPage.tsx
          ├── InvitationsPage.tsx
          ├── PropertiesPage.tsx
          ├── FeePlansPage.tsx
          ├── StaffPage.tsx
          ├── BankingPage.tsx
          └── SettingsPage.tsx
dev.sh                                            (+ pm-company startup line)
CLAUDE.md                                         (port table + landmine entry)
```

## Carry-forward from S157 still open

- **OTP disbursement engine integration** — `ONTIMEPAY`-tagged payments
  flowing into ACH push to landlord. Will surface naturally during S113
  allocation engine rebuild.
- **OTP reenrollment override UI** — punted to first real default in beta.
- **`lease_fees.due_timing` move_out / other wiring** — still needs a
  product call (S144 mitigation in place via gap notification).

## Smoke-walk-style sanity (end of S158, NOT a smoke walk per CLAUDE.md rules)

If/when Nic wants to bring the PM portal up:
1. `dev.sh` (kills old processes, runs migrations, starts all 9 apps).
2. Open http://localhost:3011 → redirects to /login.
3. Register flow: new user → new pm_company → routed to /dashboard.
4. From the **landlord portal at 3001**, Settings → "Default PM
   Company" picker should render but be empty (no linked PMs yet).
5. From the landlord portal, /pm-invitations → Invite PM Company →
   provide the new pm_company's UUID → invitation sent.
6. From the **PM portal at 3011**, /invitations → incoming should
   show the invite → Accept (no Connect onboarding yet, so the
   accept-time guard from Priority 1 doesn't exist; will gate in S159).
7. Property's `pm_company_id` should be set; landlord disbursements
   should reflect the PM cut on next allocation.

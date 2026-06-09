# Session 158 — apps/pm-company portal + Connect onboarding + owner visibility surfaces

## What S157 actually shipped (recap)

S157 opened against a stale handoff: the PM third-party-companies subsystem
was already built in S108–S112 (schema, allocation routing, maintenance
notification path, backend CRUD), not "NOT YET BUILT" as the S156 handoff
and CLAUDE.md PM-landmine entry both claimed. After recon-vs-handoff
contradiction, Nic chose Path A: layer on top of the existing model rather
than rebuild. The S157 build delivered:

### Backend
- **Migration `20260506140000_landlord_default_pm_company.sql`** —
  `landlords.default_pm_company_id` (nullable, FK to pm_companies, ON DELETE
  SET NULL) for landlord-level default. Property-level
  `properties.pm_company_id` still wins; default is fallback.
- **Migration `20260506150000_pm_property_invitations.sql`** —
  bidirectional consent handshake table. Columns: id, direction
  (`owner_to_pm`|`pm_to_owner`), pm_company_id, property_id, landlord_id,
  invited_email, invited_by_user_id, proposed_scope (`manage`|`view`),
  proposed_fee_plan_id, token (unique), status (pending/accepted/rejected
  /expired/revoked), expires_at, accepted_at, accepted_user_id,
  rejected_at, rejected_reason, revoked_at, revoked_by_user_id,
  replaced_pm_company_id (when accept-with-replace overrode an existing
  linkage). Partial unique on (pm_company_id, property_id) WHERE status
  ='pending'.
- **`apps/api/src/services/pm.ts`** (NEW, 11 KB) — single home for:
  - `getPmCompanyForProperty(propertyId)` resolver returning
    `{ source: 'property' | 'landlord_default' | null, pm_company_id, pm_fee_plan_id }`.
    Allocation engine intentionally does NOT route through this — it reads
    property columns directly because allocation requires both pm_company_id
    AND pm_fee_plan_id and the landlord default has no fee plan. Resolver
    is for UI / notification / conflict-check consumers.
  - `sendPropertyInvitation` — used by both pm.ts (PM→owner) and
    landlords.ts (owner→PM) endpoints.
  - `acceptPropertyInvitation` — write-through to properties.pm_company_id
    + pm_fee_plan_id. Conflict (existing different PM) returns 409 unless
    `replace=true` is passed; on replace, captures the prior pm_company_id
    in `replaced_pm_company_id` for audit.
  - `rejectPropertyInvitation`, `revokePropertyInvitation`,
    `expireStaleInvitations` (cron sweep helper).
- **Routes added to `routes/pm.ts`** (PM portal side of the handshake):
  - `POST /api/pm/companies/:id/property-invitations` — PM sends
    `pm_to_owner` invite
  - `GET /api/pm/companies/:id/property-invitations` — list
  - `POST /api/pm/companies/:id/property-invitations/:invId/accept`
  - `POST /api/pm/companies/:id/property-invitations/:invId/reject`
  - `DELETE /api/pm/companies/:id/property-invitations/:invId` (revoke)
  - `GET /api/pm/invitations/property/:token` (PUBLIC) — preview by token
- **Routes added to `routes/landlords.ts`** (owner side):
  - `PATCH /api/landlords/me/default-pm-company` — set/clear landlord
    default
  - `POST /api/landlords/me/pm-property-invitations` — owner sends
    `owner_to_pm` invite
  - `GET /api/landlords/me/pm-property-invitations` — list
  - `POST /api/landlords/me/pm-property-invitations/:invId/accept`
  - `POST /api/landlords/me/pm-property-invitations/:invId/reject`
  - `DELETE /api/landlords/me/pm-property-invitations/:invId` (revoke)
- **`services/email.ts`** — new helper `emailPmPropertyInvitation`
  (direction-aware framing, 72-hour expiry copy).
- **`packages/shared/src/index.ts`** — added `PM_PROPERTY_INVITE_DIRECTIONS`,
  `PM_PROPERTY_INVITE_STATUSES`, `PM_LINK_SCOPES` (with derived types).

### Frontend (landlord portal)
- **`apps/landlord/src/pages/PmInvitationsPage.tsx`** (NEW, 17 KB) — full
  invitation surface: list incoming / outgoing, send modal with PM company
  ID + property + email + scope + fee plan, accept/reject/revoke actions,
  conflict-confirm replay logic. Routed at `/pm-invitations`. Nav entry
  added under Admin section in `Layout.tsx` (uses `HeartHandshake` icon
  since `Handshake` isn't in the lucide-react version installed).

### Pricing
- Memory `project_gam_pricing_model.md` updated: Connect $1/mo Stripe fee
  **waived for any Connect account (landlord OR PM company) holding 10+
  billable units.** Conceptual / cost-allocation only — GAM never bills
  that fee to anyone, so no code change needed beyond documentation. Nic
  confirmed same posture for landlords (which it already was; this just
  formalizes the waiver threshold).

### CLAUDE.md
- PM landmine entry rewritten end-to-end. From "NOT YET BUILT" to "fully
  built; landmine cleared." Captures S108–S112 + S157 layered work and
  declares the subsystem free to touch in normal sessions.

## Decisions locked at S157 open

1. **PM portal — separate Vite app on port 3008** (NOT 3010 — that's
   already taken). To be built S158.
2. **Fee plan bundled in the invite** — owner→PM invite body includes
   `proposed_fee_plan_id`; on accept the route writes both pm_company_id
   AND pm_fee_plan_id atomically.
3. **Connect $1/mo waiver at 10+ units** for both landlords and PMs.
4. **Conflict-resolution UI** — accept returns 409 when property already
   linked to a different PM; UI surfaces "currently managed by X — replace?"
   confirm and replays with `replace=true`.
5. **Landlord default behavior** — auto-apply with bypass at property
   creation (UI work pending; backend resolver is in place).

## Path A vs B
Locked Path A (layer in). Existing `properties.pm_company_id` model from
S108 stays as source of truth; `pm_property_invitations` is the *consent
gate* that writes through to it. No `pm_property_links` join table.
The legacy `PATCH /api/properties/:id/pm-assignment` direct-set route is
preserved as the superadmin / data-migration escape hatch.

## What S158 should target

**PRIORITY 1 — `apps/pm-company` standalone Vite app on port 3008.**

This is the biggest remaining piece and deserves a focused session.

- Scaffold: Vite + React + TS, copy theme tokens from `apps/landlord`
  (gold/dark CSS variables), reuse `@gam/shared` for types, axios + JWT
  pattern from `apps/landlord/src/lib/api.ts`.
- Pages:
  - `LoginPage` / `RegisterPage` — same JWT flow as landlord; the
    register flow doubles as PM company creation (a single user signs up;
    on completion they call `POST /api/pm/companies` and become role=owner
    on a new `pm_staff` row, mirroring the existing flow inside
    PMDashboardPage but as a top-level signup).
  - `DashboardPage` — multi-owner portfolio overview. KPIs: properties
    managed, MTD fee accrued (`pm_monthly_fee_accruals`), pending payouts
    (`connect_payouts`), open invitations.
  - `PropertiesPage` — list of linked properties across all owners.
  - `StaffPage` — invite/manage staff via existing `pm_invitations`
    table.
  - `FeePlansPage` — CRUD for the company's fee plans.
  - `InvitationsPage` — analog of landlord PmInvitationsPage. Send
    `pm_to_owner` invites, view/accept/reject incoming `owner_to_pm`
    invites. Use the new endpoints already wired in S157.
  - `BankingPage` — Stripe Connect status + onboarding embed (see
    Priority 2).
  - `PayoutsPage` — list `connect_payouts` (endpoint
    `/api/pm/companies/:id/payouts` already exists from S118).
- Auth: shared `users` row, but the PM portal redirect should land users
  who have ANY `pm_staff` row with `status='active'`. Adjust
  `RoleRedirect` or the PM portal's own redirect to handle this.
- Port: 3008. Add to `dev.sh` startup. Update CLAUDE.md port table.

**PRIORITY 2 — Stripe Connect Express embedded onboarding for PM companies.**

- Reuse the pattern from `services/stripeConnect.ts` (already handles
  landlord Connect accounts). Extend to accept a `pm_company_id` instead
  of a `landlord_id` for the account_holder_type.
- New endpoint `POST /api/pm/companies/:id/connect/onboarding-link` —
  returns the embedded-onboarding session URL.
- KYC must complete before `pm_property_invitations` of direction=
  `owner_to_pm` can be accepted (because money will flow through the
  account on accept). Add a check in `services/pm.ts → acceptPropertyInvitation`
  that the pm_company has `bank_account_ready=true` (or whatever the
  Connect-completed boolean turns out to be).
- Same waiver: $1/mo absorbed into platform fee, waived at 10+ billable
  units (no code change — handled in pricing/cost-allocation framing).

**PRIORITY 3 — Owner-visibility surfaces in landlord portal:**

- `apps/landlord/src/pages/DashboardPage.tsx` — add tile "PM cut this
  month: $X / Net to you: $Y" linking to `/pm-invitations` or `/disbursements`.
  Data source: `pm_monthly_fee_accruals` joined against the landlord's
  properties for the current month.
- `apps/landlord/src/pages/DisbursementsPage.tsx` — add columns
  `gross`, `pm_fee`, `gam_fee`, `net_to_owner` per row. Pull from the
  existing user_balance_ledger / platform_revenue_ledger join already
  populating the page.
- `apps/landlord/src/pages/PropertyDetailPage.tsx` — add "PM Linkage"
  section showing current pm_company + fee plan if set, with a button
  to open PmInvitationsPage pre-filled to send a new invite for this
  property.
- `apps/landlord/src/pages/SettingsPage.tsx` — default-PM picker UI:
  current default (PM company name + ID), Clear button, picker showing
  the distinct PM companies currently linked to any of the landlord's
  properties. (The backend `PATCH /api/landlords/me/default-pm-company`
  endpoint already exists.)

**PRIORITY 4 — `expireStaleInvitations` cron wire.**

- Add a daily call in `apps/api/src/jobs/scheduler.ts` (or extend the
  existing processInvitationExpiry sweep that already handles
  `pm_invitations`) to also sweep `pm_property_invitations`.

## Files touched in S157

```
CLAUDE.md                                                  (PM landmine rewrite)
~/.claude/projects/.../memory/project_gam_pricing_model.md (Connect waiver note)
apps/api/src/db/migrations/20260506140000_landlord_default_pm_company.sql   NEW
apps/api/src/db/migrations/20260506150000_pm_property_invitations.sql        NEW
apps/api/src/db/schema.sql                                  (auto-regenerated)
packages/shared/src/index.ts                               (3 new const arrays)
apps/api/src/services/pm.ts                                 NEW (11 KB)
apps/api/src/services/email.ts                             (+ emailPmPropertyInvitation)
apps/api/src/routes/pm.ts                                  (+ property-invite endpoints)
apps/api/src/routes/landlords.ts                           (+ owner-side endpoints)
apps/landlord/src/pages/PmInvitationsPage.tsx               NEW (17 KB)
apps/landlord/src/main.tsx                                 (+ /pm-invitations route)
apps/landlord/src/components/layout/Layout.tsx             (+ nav entry)
```

## Verification

- `npm run db:migrate` applied both new migrations cleanly; schema.sql
  regenerated to 9966 lines.
- `psql gam -c "SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 5"`
  confirms both rows recorded.
- API `tsc --noEmit` exit 0.
- Landlord `tsc --noEmit` exit 0.

## Open questions for S158 start

1. **PM signup flow** — does the PM company register from a marketing
   landing page, or via a tokenized invite (e.g., owner invites a PM
   who doesn't have a GAM account yet, the email link routes them to
   PM signup with the property pairing pre-attached)? Recommend: support
   both. Marketing-driven self-signup goes to `/register` on port 3008;
   tokenized signup uses the public invitation lookup endpoint to pre-
   fill company pairing.
2. **PM portal auth model** — do PM staff log in via the same JWT issuer
   as landlords/tenants, with role detection routing them to port 3008?
   Or does the PM portal have a separate auth surface? Recommend: shared
   JWT (one user, possibly multiple roles across portals — they could be
   a tenant in one property AND PM staff at a company; landing page is
   role-aware).
3. **`PMDashboardPage` (existing)** — currently lets landlords create PM
   companies inline. Under S157's self-serve model, that's redundant.
   Keep as legacy / migrate functionality to the new PM portal / delete?
   Recommend: keep for now, mark deprecated; remove in a cleanup pass
   once apps/pm-company is launched and tested.
4. **Connect onboarding gating** — should attempting to accept an
   `owner_to_pm` invitation when the PM has not completed Connect KYC
   fail loudly, or queue the acceptance until KYC completes? Recommend:
   fail with a clear error directing the PM to complete onboarding first.
   Queueing adds state-machine complexity for an edge case.

## Items deferred (not S158-priority)

- **OTP disbursement engine integration** — `ONTIMEPAY`-tagged payments
  flowing into ACH push to landlord. Will surface naturally during S113
  allocation engine rebuild; PM-fee routing built in S157 is the same
  plumbing.
- **OTP reenrollment override UI** — punted to first real default in beta.
- **`lease_fees.due_timing` move_out / other wiring** — still needs a
  product call (S144 mitigation in place via gap notification).
- **Landlord-portal SettingsPage default-PM picker UI** — backend route
  exists; UI can be a 30-min add in S158 or later.

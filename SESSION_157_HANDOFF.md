# Session 157 — PM third-party-companies subsystem (schema + onboarding kickoff)

## Theme

Build the `pm_companies` / `pm_staff` / `pm_fee_plans` / `pm_property_links`
triad+ end-to-end. This is concept #2 from CLAUDE.md's PM landmine — the
third-party PM organizations that contract with owners, take a fee cut,
and need their own Stripe Connect accounts under S113's destination-charge
architecture. Self-serve onboarding (no GAM admin gate); property linkage
established via mutual invite handshake.

This session was teed up at the close of S156. All scope-shaping
questions are answered (Q1–Q5 below) so the next session opens at
schema and runs straight through.

## Scope-shaping decisions (locked at S156 close)

### Q1 — Assignment granularity: **C (both)**
- `landlords.default_pm_company_id` — landlord-level default (covers
  the common case where one PM manages the whole portfolio).
- `properties.pm_company_id` — per-property override for multi-PM owners.
- Resolution rule: property override wins when set; else fall back to
  the landlord default.

### Q2 — Fee plan model: **D (flexible)**
- `pm_fee_plans` table: `id`, `pm_company_id`, `landlord_id`,
  `mode`, `params jsonb`, `effective_from`, `effective_until`.
- `mode` CHECK in (`percent_of_rent`, `per_unit_flat`, `tiered`).
- `params` shape per mode:
  - percent_of_rent: `{ rate: 0.08, applies_to: ['rent','late_fee','application_fee'] }`
  - per_unit_flat: `{ amount_per_occupied_unit: 8000, applies_monthly: true }`
  - tiered: `{ first_month: { rate: 1.0 }, ongoing: { rate: 0.08 }, cap_per_month: 50000 }`
- One contract = one fee_plan row. Replacing a plan = effective_until
  the old, insert the new. Never mutate in place (audit trail for
  fee disputes).
- Single-source-of-truth: `PM_FEE_MODES` array exported from
  `packages/shared/src/index.ts`, type derived, CHECK matches.

### Q3 — Connect splitting: **A primary, B fallback**
- Primary path: charge-time multi-destination via PaymentIntent
  `transfer_data[]`. Tenant pays → Stripe splits at settle into
  PM Connect account, owner Connect account, GAM platform balance.
- Fallback path: single-destination to GAM + post-charge `Transfer`
  calls. Used when the fee math depends on settled state (late-fee
  bonus, NSF clawback, dispute deductions, reconciliation
  corrections).
- Engine decision: per-allocation, set in `services/allocation.ts`
  refactor under S113.

### Q4 — Onboarding model: **Self-serve + mutual invite handshake**

**No GAM admin approval gate.** PM companies register the same way
landlords do (own portal sign-up flow). Property linkage is the
trust boundary, NOT GAM. Both parties must consent before money
or data flows.

**Two invite directions:**

1. **Owner → PM invite** ("I hire you to manage this property")
   - Landlord initiates from landlord portal: "Grant PM Co X
     access to property Y" (or entire portfolio).
   - GAM emails the PM company a tokenized invite link.
   - PM accepts → `pm_property_links` row created with
     `status='active'`, `scope='manage'`.
   - Result: PM Co X now appears in property Y's fee-routing pipeline.
     Their staff can see/edit per their internal scopes.

2. **PM → Owner invite** ("I manage this property; you can see it")
   - PM initiates from PM portal: "Invite owner of property Y to
     view this property in their GAM account."
   - GAM emails the owner a tokenized invite link.
   - If owner doesn't have a GAM account yet, the link routes to a
     simplified landlord sign-up that pre-populates the property.
   - Owner accepts → `pm_property_links` row created with
     `scope='view'` (owner gets read-only visibility).
   - Result: owner sees their property's financials and operations
     through GAM without taking over the management surface.

**Cross-flag note:** the same property can have one
`pm_property_links` row per PM company (no double-management). If
a landlord already on GAM gets an invite from a PM whose linkage
would conflict with an existing PM, surface the conflict — owner
chooses which PM is canonical.

### Q5 — Owner visibility surface: **C (assumed — dashboard tile + Disbursements column)**

Nic didn't explicitly answer; taking silence as concurrence on the
S156 recommendation.
- Landlord dashboard: new tile "PM cut this month: $X / Net to you: $Y"
  linking to detail page.
- Disbursements page: add columns for `gross`, `pm_fee`, `gam_fee`,
  `net_to_owner` per disbursement row.
- No standalone /pm-cut route needed — the existing pages absorb it.

If Nic comes back with "actually I want a separate page," cheap to
fix; the data model doesn't change.

## Schema sketch (proposed; finalize at session start)

```sql
-- New tables ──────────────────────────────────────────────────────

CREATE TABLE pm_companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name      text NOT NULL,
  display_name    text,
  ein             text,
  primary_user_id uuid NOT NULL REFERENCES users(id),  -- founder/owner
  stripe_connect_account_id text,
  business_phone  text,
  business_email  text,
  business_address jsonb,
  onboarding_complete boolean NOT NULL DEFAULT FALSE,
  bank_account_ready  boolean NOT NULL DEFAULT FALSE,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE pm_staff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pm_company_id   uuid NOT NULL REFERENCES pm_companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('owner','admin','manager','staff')),
  permissions     jsonb NOT NULL DEFAULT '{}',  -- granular sub-permissions
  property_scopes jsonb NOT NULL DEFAULT '{"all_assigned": true}',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','suspended')),
  invited_by      uuid REFERENCES users(id),
  joined_at       timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (pm_company_id, user_id)
);

CREATE TABLE pm_fee_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pm_company_id   uuid NOT NULL REFERENCES pm_companies(id),
  landlord_id     uuid NOT NULL REFERENCES landlords(id),
  property_id     uuid REFERENCES properties(id),  -- null = all properties under this landlord
  mode            text NOT NULL CHECK (mode IN ('percent_of_rent','per_unit_flat','tiered')),
  params          jsonb NOT NULL,
  effective_from  date NOT NULL,
  effective_until date,  -- null = currently active
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE pm_property_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pm_company_id   uuid NOT NULL REFERENCES pm_companies(id),
  property_id     uuid NOT NULL REFERENCES properties(id),
  landlord_id     uuid NOT NULL REFERENCES landlords(id),
  scope           text NOT NULL CHECK (scope IN ('manage','view')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','suspended')),
  initiated_by    text NOT NULL CHECK (initiated_by IN ('owner','pm')),
  initiated_by_user_id uuid REFERENCES users(id),
  fee_plan_id     uuid REFERENCES pm_fee_plans(id),
  linked_at       timestamptz NOT NULL DEFAULT NOW(),
  removed_at      timestamptz,
  removed_by_user_id uuid REFERENCES users(id),
  removed_reason  text,
  UNIQUE (pm_company_id, property_id) WHERE status = 'active'  -- partial idx
);

CREATE TABLE pm_property_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction       text NOT NULL CHECK (direction IN ('owner_to_pm','pm_to_owner')),
  pm_company_id   uuid NOT NULL REFERENCES pm_companies(id),
  property_id     uuid NOT NULL REFERENCES properties(id),
  invited_email   text NOT NULL,
  invited_by_user_id uuid NOT NULL REFERENCES users(id),
  proposed_scope  text NOT NULL CHECK (proposed_scope IN ('manage','view')),
  proposed_fee_plan_id uuid REFERENCES pm_fee_plans(id),
  token           text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired','revoked')),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  rejected_reason text,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

-- Existing-table additions ────────────────────────────────────────

ALTER TABLE landlords     ADD COLUMN default_pm_company_id uuid REFERENCES pm_companies(id);
ALTER TABLE properties    ADD COLUMN pm_company_id        uuid REFERENCES pm_companies(id);
```

## Build order (next session)

1. **Migrations** — one file per concern (5 new tables + alters).
2. **Shared exports** — PM_FEE_MODES, PM_STAFF_ROLES,
   PM_LINK_SCOPES, PM_LINK_STATUSES, PM_INVITE_STATUSES.
3. **`apps/api/src/services/pm.ts`** — invite/accept/reject,
   linkage resolution (`getPmCompanyForProperty(propertyId)`),
   fee-plan lookup with override fallback.
4. **`apps/api/src/services/pmFeeRouting.ts`** — pure function:
   given a payment + property + fee_plan, return splits array.
   Plug into S113 allocation engine when that's rebuilt.
5. **Routes** — `routes/pmCompanies.ts` (PM portal), additions to
   `routes/landlords.ts` (invite send/accept from landlord side),
   additions to `routes/properties.ts` (linkage CRUD for owner).
6. **Patch** `routeMaintenanceNotification` — restore the PM-staff
   notification path that S107 lost (alongside the existing
   in-house manager path).
7. **Frontend — landlord portal:**
   - PM Companies tab inside Settings (or top-level nav?
     decide first thing in S157).
   - Invite-send form per property.
   - Dashboard tile "PM cut this month."
   - Disbursements columns for gross/pm_fee/gam_fee/net.
8. **Frontend — PM portal (probably a new app):**
   - This is its own lift. Could fold into landlord portal
     under role-based navigation OR stand up `apps/pm-company`
     as a separate Vite app on a new port.
   - Open question for S157 start.
9. **Stripe Connect Express onboarding for PM companies:**
   - Same embedded `<ConnectAccountOnboarding />` pattern as landlords.
   - PM company gets a Connect account at sign-up; KYC happens before
     they can accept invitations.

## Open questions for S157 start (ask Nic first thing)

1. **PM portal — separate Vite app or role-based subsection of
   landlord portal?** Recommendation: separate app on port 3010
   (`apps/pm-company`). Cleaner permission model, different
   information architecture (PM dashboard centers on multi-owner
   portfolio; landlord dashboard centers on a single owner's
   properties). Cost: another build target, another auth surface.
2. **Fee plan attachment timing.** Does the owner-to-PM invite
   include a proposed fee plan that PM accepts as a package, or
   are fee plans negotiated/edited separately after linkage?
   Recommendation: include in the invite (one-step accept of both
   linkage and fee plan). Fee plan can still be amended later via
   a new `pm_fee_plans` row.
3. **Connect account billing.** PMs pay $1/mo per active Connect
   account to Stripe. Absorbed into GAM platform fee like landlord
   accounts? Recommendation: yes; no new billing line for PMs.
4. **Conflict resolution UI.** When a PM-to-Owner invite arrives
   for a property already linked to another PM, what's the owner's
   accept flow? Recommendation: show "Property X is currently
   managed by PM Co A. Accepting this invite from PM Co B will
   replace that linkage." with confirm. Drives a reroute of the
   existing fee plan.
5. **`landlords.default_pm_company_id` semantics.** Does it auto-
   apply to newly-added properties under that landlord? Or is it
   only a hint that gets re-confirmed per property? Recommendation:
   auto-apply with a UI bypass at property creation ("This
   property is NOT managed by [default PM]").

## Items deferred from S156

- **OTP disbursement engine integration** — `ONTIMEPAY`-tagged
  payments need flow into the ACH push to landlord. Will surface
  naturally during S113 allocation engine rebuild; the PM-fee
  routing built in S157 is the same plumbing.
- **OTP reenrollment override UI** — punted to first real default
  in beta.
- **`lease_fees.due_timing` move_out / other wiring** — still needs
  a product call (S144 mitigation in place via gap notification).

## Files that S157 will touch (no changes yet)

```
apps/api/src/db/migrations/                   (5 new files)
apps/api/src/db/schema.sql                    (auto-regenerated)
packages/shared/src/index.ts                  (5 new constant arrays)
apps/api/src/services/pm.ts                   (NEW)
apps/api/src/services/pmFeeRouting.ts         (NEW)
apps/api/src/services/maintenance.ts          (PM staff notification path restore)
apps/api/src/routes/pmCompanies.ts            (NEW)
apps/api/src/routes/landlords.ts              (invite endpoints)
apps/api/src/routes/properties.ts             (linkage CRUD)
apps/landlord/src/pages/SettingsPage.tsx      (PM Companies subsection)
apps/landlord/src/pages/PropertyDetailPage.tsx (PM linkage section)
apps/landlord/src/pages/DisbursementsPage.tsx  (PM fee column)
apps/landlord/src/pages/DashboardPage.tsx      (PM cut tile)
apps/pm-company/                               (NEW Vite app — pending Q1 answer)
```

## What S157 should NOT do

- Don't refactor the S113 allocation engine yet. Build the
  fee-routing as a pure function that the engine will call later.
- Don't rip out any existing code that references `pm_company_id`
  fields on landlords/properties — those columns don't exist yet,
  so there's nothing to rip out, but be mindful that S107
  conflated concept #1 and concept #2 in some maintenance
  notification paths. Restore the missing pm_staff notification
  alongside the existing property_manager_scopes one — don't
  replace.
- Don't build a "PM company directory" or any cross-PM matchmaking
  feature. PMs and owners find each other off-platform; GAM is
  the operational layer once they've decided to work together.

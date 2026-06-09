# Session 108 Handoff

**Theme:** PM Companies subsystem — schema only (S108). Three new tables
(`pm_companies`, `pm_staff`, `pm_fee_plans`) plus per-property pointers
on `properties`. Routes, allocation-engine wire-up, owner-visibility
view, staff invite flow, and notification path land in S109+.

## Architecture decisions

**Per-property assignment, not per-landlord.** Matches the existing 16a
grain (`properties.owner_user_id` + `properties.managed_by_user_id`).
Lets one owner have a mixed portfolio: some properties self-managed,
some on PM Company A under Plan X, some on PM Company B under Plan Y.

**pm_companies are top-level entities, not per-landlord.** A single
PM company can manage properties across many different landlords. The
landlord→PM relationship lives on each property row, not on landlords.
Eliminates needing a join-table for the many-to-many. The `pm_companies`
table itself is independent of landlords.

**pm_staff is a separate concept from property_manager_scopes.**
- `property_manager_scopes` = OWNER's in-house property managers
  (employees of the landlord). Already built S80.
- `pm_staff` = THIRD-PARTY PM company staff (employees of an external
  org). Built this session.
The two coexist on the same property: a property contracted to a PM
company can also have in-house workers from the owner side. Both
should receive maintenance notifications when wired in S109.

**pm_company.bank_account_id → user_bank_accounts.id.** Preserves the
16a invariant that all bank accounts are user-owned. The PM org's
owner-user adds the company's bank account through their personal
banking flow, then the PM company points at it. No new
`pm_company_bank_accounts` table needed.

**Fee plan field set is loose by design.** Different `fee_type` values
need different fields (percent_of_rent → percent; flat_monthly →
flat_amount; percent_with_floor → percent + floor_amount; composite
plans need multiple). Rather than an explosion of partial CHECKs that
constrain every combination, the migration keeps all amount fields
nullable and lets the application layer enforce which fields are
required for which type. Tighter per-type CHECKs can be added in a
future migration once usage stabilizes.

**Cross-table fee_plan/pm_company invariant enforced in app code.**
A property's `pm_fee_plan_id` must belong to its own `pm_company_id`.
PostgreSQL CHECK constraints can't reach across tables, so this
invariant is documented in the migration header for the S109 route
that wires assignment to enforce.

**ON DELETE policy:**
- `pm_companies` deleted → `pm_staff` and `pm_fee_plans` CASCADE
  (the org going away takes its staff and plans with it)
- `pm_companies` or `pm_fee_plans` deleted → `properties.pm_company_id`
  / `pm_fee_plan_id` SET NULL (the property survives, just unassigned)
- `users` deleted → `pm_staff` CASCADE (no orphan staff rows)
- `user_bank_accounts` deleted → `pm_companies.bank_account_id`
  SET NULL (company survives, payout routing nulled until reassigned)

## Shipped

### packages/shared/src/index.ts

Five new exported value-arrays + derived types, all anchored under the
`SECURITY_DEPOSIT_STATUSES` block:
- `PM_COMPANY_STATUSES` = `['active', 'inactive', 'suspended']`
- `PM_STAFF_ROLES` = `['owner', 'manager', 'staff']` (internal to the
  PM org, distinct from the platform-level user role)
- `PM_STAFF_STATUSES` = `['active', 'inactive', 'removed']`
- `PM_FEE_TYPES` = 7 values: `percent_of_rent`, `flat_monthly`,
  `percent_with_floor`, `percent_with_ceiling`, `per_unit`,
  `leasing_fee`, `maintenance_markup_pct`
- `PM_FEE_PLAN_STATUSES` = `['active', 'inactive', 'deprecated']`

Each has its derived `typeof X[number]` type alias.

### Migration `20260504000000_pm_companies_subsystem.sql`

```
pm_companies
  id, name (NOT NULL), business_email, business_phone,
  business_street1/city/state/zip, ein,
  bank_account_id → user_bank_accounts(id) ON DELETE SET NULL,
  status (CHECK), created_by_user_id → users(id), created_at, updated_at

pm_staff
  id, pm_company_id → pm_companies(id) ON DELETE CASCADE,
  user_id → users(id) ON DELETE CASCADE,
  role (CHECK), permissions jsonb, status (CHECK),
  invited_by_user_id, joined_at, removed_at, created_at, updated_at,
  UNIQUE(pm_company_id, user_id)

pm_fee_plans
  id, pm_company_id → pm_companies(id) ON DELETE CASCADE,
  name, fee_type (CHECK),
  percent (0-100 CHECK), flat_amount, floor_amount, ceiling_amount,
  leasing_fee_amount, maintenance_markup_pct (0-100 CHECK),
  status (CHECK),
  CHECK (floor_amount <= ceiling_amount when both set)

properties
  + pm_company_id  → pm_companies(id) ON DELETE SET NULL
  + pm_fee_plan_id → pm_fee_plans(id) ON DELETE SET NULL
```

Indexes:
- `idx_pm_companies_status`
- `idx_pm_companies_created_by` (partial, WHERE NOT NULL)
- `idx_pm_staff_company_status` (the "list active staff for a company"
  query the route layer will run)
- `idx_pm_staff_user_status` (the "what companies does this user work
  at" query for cross-company login flows)
- `idx_pm_fee_plans_company_status`
- `idx_properties_pm_company` (partial, WHERE NOT NULL — for "what
  properties does this PM company manage" join)

## Files touched

- `apps/api/src/db/migrations/20260504000000_pm_companies_subsystem.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated, 7531 → 7741 lines)
- `packages/shared/src/index.ts` (PM enums + types)
- `SESSION_108_HANDOFF.md` (this file)

No route changes. No service-layer changes. Pure schema + shared exports.

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 7741 lines
- `npm run build` in `packages/shared` → exit 0
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 8-step end-to-end smoke walk against dev DB inside a rolled-back
  transaction:
  1. `pm_companies` INSERT — row created, status default 'active'
  2. `pm_staff` INSERT (role='owner') — succeeds
  3. UNIQUE(pm_company_id, user_id) — duplicate insert rejected
     with code 23505
  4. Three `pm_fee_plans` inserts spanning percent_of_rent,
     percent_with_floor (with collar), and a composite
     flat_monthly + leasing_fee + maintenance_markup_pct — all
     succeed
  5. CHECK `percent <= 100` — 101 rejected by
     `pm_fee_plans_percent_range`
  6. CHECK `floor <= ceiling` — floor=500/ceiling=100 rejected by
     `pm_fee_plans_floor_ceiling`
  7. `properties.pm_company_id` + `pm_fee_plan_id` assignment —
     both pointers persist
  8. CASCADE on `pm_company` DELETE — `properties` pointers nulled
     via SET NULL; `pm_staff` and `pm_fee_plans` rows for that
     company gone via CASCADE
- ROLLBACK — dev DB unchanged

## What this session did NOT do

- **No routes.** No CRUD endpoints for pm_companies, pm_staff, or
  pm_fee_plans yet. No assignment endpoint for properties.
- **No allocation-engine wire-up.** The existing 16a allocation
  engine in `services/allocation.ts` does not yet call
  `pm_fee_plans` to claim a cut before the owner ledger entry.
- **No owner-visibility view.** No "rent collected / PM cut / your
  net" surface (route or query) for owners to see the impact of
  their PM company assignment.
- **No notification path.** `routeMaintenanceNotification` still
  only notifies in-house property_manager_scopes (S107). The
  parallel pm_staff notification path (filtered by which staff
  cover this property's pm_company) lands in S109+.
- **No staff invite flow.** No mechanism for a pm_company owner
  to invite additional staff users.
- **No bank-account assignment endpoint.** The
  `pm_companies.bank_account_id` column exists but no route lets
  a pm_company owner pick which of their user_bank_accounts to
  point at.
- **No JWT / auth role surface.** The platform-level user role
  for pm_company staff is an open product question. Today they're
  just normal users; the pm_staff row is the only signal that
  they're employed by a PM company. Future product call: do they
  need a 'pm_staff' enum value on users.role, or does pm_staff
  membership stand alone?

## Pre-launch blockers still open

Same as S100–S107:
- Item 16 batch 2 — bank ACH origination provider
- Item 16 batch 3+ — OTP enablement
- Item 10 — utility billing payment integration

Plus the rest of the PM Companies build (S109+).

## What next session should target

S109 plan, in order:

1. **CRUD routes for pm_companies + pm_staff + pm_fee_plans.**
   Probably mounted at `/api/pm/companies`, `/api/pm/companies/:id/staff`,
   `/api/pm/companies/:id/fee-plans`. Auth: a user can manage a
   pm_company they're an `owner` or `manager` staff of.
2. **Property assignment endpoint.**
   `PATCH /api/properties/:id/pm-assignment` with
   `{ pm_company_id, pm_fee_plan_id }` body. Enforces the
   cross-table invariant (plan must belong to company). Owner
   only.
3. **Allocation engine wire-up.** When tenant rent settles and
   `services/allocation.ts` splits into ledger entries, look up
   the property's pm_fee_plan, compute the PM cut per the
   fee_type rule, post a `pm_company_fee` ledger entry to the PM
   company's user (via bank_account_id), reduce the owner's
   ledger entry by that cut.
4. **Owner-visibility view.** `GET /api/landlords/me/pm-impact`
   returns per-property: rent collected this month, PM cut, owner
   net. Backs the landlord-portal dashboard card showing the cut.
5. **routeMaintenanceNotification parallel pm_staff path.** Add
   the second SELECT (UNION or separate query) that fetches
   pm_staff for the property's pm_company filtered to those whose
   internal-permissions include maintenance, and notify them
   alongside the existing in-house PMs.
6. **PM company creation flow.** Probably `POST /api/pm/companies`
   creates the row, auto-creates a `pm_staff` row for the caller
   with role='owner'. Open product question: any user can create,
   or gated behind some onboarding flow?

S109 is realistically 2 sessions of work (1, 2, 5 in one; 3, 4, 6
in another) given the allocation-engine integration touches money
math and needs careful smoke. Recommend splitting at that line.

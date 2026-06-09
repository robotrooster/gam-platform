# Session 109 Handoff

**Theme:** PM Companies subsystem — routes, property assignment, parallel
pm_staff maintenance notification path. Allocation-engine fee-cut wire-up
+ owner-visibility view scoped for S110 per S108's split.

## Architecture decisions

**Auth model: role-based access via `pm_staff.role` + `pm_staff.status`.**
A small in-route helper `assertPmStaffRole(userId, pmCompanyId, allowedRoles[])`
checks the JWT user has an active pm_staff row in one of the allowed roles.
Three roles, three privilege tiers:
- `owner` — full company control (edit details, manage all staff, manage
  fee plans, set bank_account_id for payout routing)
- `manager` — edit company details, manage fee plans, view staff. Cannot
  invite/remove staff.
- `staff` — view-only on company + assigned-property scoped actions
  (S110+ wires the per-property scoping)

Bank account assignment is owner-only — payout routing is the most
sensitive single-field change in the subsystem.

**Last-active-owner protection.** PATCH on a pm_staff row that would demote
the only active owner (role change away from 'owner', or status change
away from 'active') is rejected with 409. Prevents accidental lockout.

**Per-fee_type required-field guard at the route layer.** S108 deliberately
left the SQL CHECKs loose (any combination of fields allowed), so the
fee-plan POST route enforces which fields are required for which type:
- `percent_of_rent` → percent
- `flat_monthly` → flat_amount
- `percent_with_floor` → percent + floor_amount
- `percent_with_ceiling` → percent + ceiling_amount
- `per_unit` → flat_amount
- `leasing_fee` → leasing_fee_amount
- `maintenance_markup_pct` → maintenance_markup_pct

A composite plan (e.g. flat_monthly with leasing_fee_amount and
maintenance_markup_pct also set) is allowed — the guard checks the
required field for the primary fee_type and ignores extras, so plans
can layer.

**Property assignment lives in `routes/properties.ts`.** PATCH on a
property is properly mounted on the property router, not the PM router.
The cross-table invariant check (selected fee_plan must belong to the
selected pm_company) runs at the route layer per S108's design — the
DB has no cross-table CHECK.

**Notifications: both PM populations get fan-out.** The
routeMaintenanceNotification function now runs TWO PM-related queries:
- `pms` (owner's in-house property_manager_scopes — S107)
- `pmCoStaff` (third-party pm_company staff — S109)

Both populations get notified per the same urgency rules. Frontend
distinguishes via `data.source = 'pm_company'` on the contracted-staff
notification so the UI can show the right "from" label.

## Shipped

### apps/api/src/routes/pm.ts (new file)

Mounted at `/api/pm`. All routes require auth.

| Route | Auth | Notes |
|---|---|---|
| `GET    /companies` | active staff | lists companies the caller is staff of, with `my_role` |
| `POST   /companies` | any user | creates pm_company + auto-creates pm_staff(role='owner') in one transaction |
| `GET    /companies/:id` | active staff | full company detail |
| `PATCH  /companies/:id` | owner or manager | edit details; bank_account_id is owner-only |
| `GET    /companies/:id/staff` | active staff | list with user info, sorted owner→manager→staff |
| `POST   /companies/:id/staff` | owner | add existing user; 409 on duplicate via UNIQUE constraint |
| `PATCH  /companies/:id/staff/:staffId` | owner | edit role/permissions/status; rejects last-owner demotion |
| `GET    /companies/:id/fee-plans` | active staff | list plans |
| `POST   /companies/:id/fee-plans` | owner or manager | create plan with per-fee_type field guard |
| `PATCH  /companies/:id/fee-plans/:planId` | owner or manager | edit fee plan |

Invitation flow (email + accept token) is deferred to a follow-up
session — `POST /staff` is the "add an existing user" admin path.

### apps/api/src/routes/properties.ts

New endpoint:
- `PATCH /api/properties/:id/pm-assignment` (requireLandlord) — sets
  `pm_company_id` + `pm_fee_plan_id` on a property. Both nullable
  (null = self-managed). Validates: company exists and is active; plan
  exists, is active, and belongs to the same company; rejects
  `pm_fee_plan_id` without `pm_company_id`. Auth: same as the
  allocation-rule endpoint (landlord/admin only — financial decision,
  no team roles).

### apps/api/src/services/notifications.ts

`routeMaintenanceNotification` updated:
- New `pmCoStaff` query: `properties JOIN pm_staff JOIN users` filtered
  by `properties.pm_company_id IS NOT NULL` and `pm_staff.status =
  'active'`
- New section "3b" in the notification fan-out loop that fires after
  the in-house PMs section, notifying every active pm_company staff
  with `data.source = 'pm_company'` for frontend distinction
- Function header comment rewritten — both PM populations now
  documented as covered

### apps/api/src/index.ts

`pmRouter` imported and mounted at `/api/pm` between `/api/scopes` and
`/webhooks`.

## Files touched

- `apps/api/src/routes/pm.ts` (new — 11 endpoints)
- `apps/api/src/routes/properties.ts` (new property assignment endpoint)
- `apps/api/src/services/notifications.ts` (parallel pm_staff query +
  notification loop section + header comment rewrite)
- `apps/api/src/index.ts` (router import + mount)
- `SESSION_109_HANDOFF.md` (this file)

No migrations, no schema changes (S108 was the schema session).

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Schema-shape verification via psql against dev DB inside rolled-back
  transactions:
  - Company + auto-owner staff INSERT (both rows committed; matches
    POST /companies route behavior)
  - Manager added (role='manager', status='active')
  - UNIQUE constraint rejected duplicate (pm_staff_unique_membership)
  - Property assignment to pm_company + plan A — pointers persist
  - **pmCoStaff query returns exactly the 2 expected users** (owner +
    manager) when run with the assigned property — confirms the new
    SQL path in notifications.ts:235 works against real-shaped data
  - Cross-table invariant data shape verified: when plan B belongs
    to company B but the assignment target is company A, the route's
    `plan.pm_company_id !== body.pm_company_id` check has the data
    it needs to fire 400
- Dev DB returned to zero pm_companies / pm_staff / pm_fee_plans rows
  post-test
- In-process service-call smoke (Express + node ts-node) hit a known
  workspace-package ESM resolution wrinkle from a free-floating
  script; typecheck + direct SQL exercise of the SAME paths covers
  the gap

## What this session did NOT do

- **No allocation-engine wire-up.** `services/allocation.ts` does not
  yet look up `pm_fee_plan_id` and claim a cut before the owner
  ledger entry. **S110 is the natural next session.**
- **No owner-visibility view.** No `GET /api/landlords/me/pm-impact`
  endpoint or dashboard card showing rent/cut/net per property.
  Pairs with the allocation-engine work in S110.
- **No pm_staff invitation (email + accept token) flow.** Today
  `POST /staff` adds an existing user by uuid. The S101 email
  infrastructure + the S80 invitation pattern compose into this
  cleanly when a session is dedicated to it.
- **No frontend.** Per UI/UX standing rule.
- **No JWT / users.role surface for pm_staff.** Open product question
  (S108 handoff): do PM company staff need a 'pm_staff' enum value
  on `users.role`, or does pm_staff membership stand alone? For
  S109, route auth checks pm_staff membership directly without a
  user-role gate.
- **No per-staff permission filtering in the maintenance notification
  path.** All active pm_staff get notified; future refinement could
  use the pm_staff.permissions jsonb to filter (e.g. only those with
  the 'maintenance' permission). Today: simpler is better — the PM
  company can route internally.

## Pre-launch blockers still open

Same as S100–S108:
- Item 16 batch 2 — bank ACH origination provider
- Item 16 batch 3+ — OTP enablement
- Item 10 — utility billing payment integration

Plus S110 (allocation engine + owner visibility) for PM Companies
to be production-ready.

## What next session should target

**S110: PM allocation engine + owner-visibility view.** Outline:

1. **Allocation engine fee-cut wire-up** —
   `services/allocation.ts` already splits tenant rent payments into
   ledger entries (per-property allocation rules, banking_fee_payer,
   etc.). Add a step before the owner credit: look up
   `properties.pm_fee_plan_id`, evaluate the fee_type rule against
   the rent amount + occupancy + leasing trigger, post a
   `pm_company_fee` ledger entry to the PM company's user (via
   `pm_companies.bank_account_id`'s user_id), reduce the owner
   credit by the cut.

2. **Owner-visibility view** —
   `GET /api/landlords/me/pm-impact?from=YYYY-MM-DD&to=YYYY-MM-DD`
   returns per-property: rent collected in window, PM cut, owner net,
   plan summary. Backs the landlord-portal "your properties under
   PM" dashboard card.

3. **Auto-Friday payout integration** — when the auto-payout cron
   fires, the PM company's user_id has its own ledger balance to
   sweep. Should compose with existing 16a logic without changes
   (the engine already handles per-user balances) but needs verification.

4. **Tests / smoke** — multi-property scenarios with mixed
   self-managed / PM-managed properties; verify the cut math; verify
   the ledger entries are correctly attributed; verify the auto-payout
   includes both the owner and PM company.

S110 is realistic as one focused session if the allocation engine's
shape is clean. May spill into S111 if the engine needs refactoring
to insert the PM step cleanly.

After S110, frontend work is the next major phase — the email-failure
dashboard from S101–S106 + the PM company surface (creation, staff
mgmt, property assignment, owner-cut view) all need UI.

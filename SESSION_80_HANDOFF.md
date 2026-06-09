# Session 80 Handoff

**Theme:** Item 8 a + b + d — sub-permissions storage on scope tables,
unified TeamPage UI with per-permission toggles, dead `routes/team.ts`
ripped. 8c (route gates) still outstanding as its own session.

## Architecture decision recorded

Pre-S80 had two parallel team-membership concepts: `team_members` (pre-S62
cruft, zero rows in dev) and per-role `*_scopes` tables (live, used).
S80 collapsed them: sub-permissions now live on each scope table as a
`permissions jsonb DEFAULT '{}'` column. `team_members` dropped.
Bookkeeper is special-cased — its `access_level` (read_only | read_write)
is the right granularity for that role, no sub-permissions needed.

## Shipped

### Migration 20260503060000_team_permissions_consolidation.sql
- ADD COLUMN `permissions jsonb NOT NULL DEFAULT '{}'::jsonb` on
  `property_manager_scopes`, `onsite_manager_scopes`,
  `maintenance_worker_scopes`.
- DROP TABLE `team_members`.
- No backfill (zero rows).

### routes/auth.ts
- `getScopeForUser(userId, role)` helper — role-keyed dispatch into the
  right scope table; returns `{ landlordId, permissions }`. Bookkeeper
  packs `access_level` into the same permissions shape so JWT consumers
  don't need to special-case.
- Login query: replaced LEFT JOIN team_members with the helper. Worker
  roles without a scope row get 403 "deactivated" (matches pre-S80
  behavior — scope-row absence is the deactivation signal).

### services/notifications.ts
- Maintenance team query at line 149 switched from `team_members` join
  to UNION across `maintenance_worker_scopes` and `onsite_manager_scopes`.

### routes/scopes.ts
- New `GET /api/scopes/team` — unified roll-up across all 4 scope tables
  + pending invitations. Single endpoint feeds TeamPage. Registered
  BEFORE `/:roleType` so Express doesn't match 'team' as a roleType.
- New `PATCH /api/scopes/:roleType/:userId/permissions` — sub-permission
  toggle update. Bookkeeper rejected (use existing `/:roleType/:userId`
  PATCH with accessLevel for that role).

### apps/landlord/src/pages/TeamPage.tsx
- Was a 38-line read-only stub. Now: unified table of everyone across
  all 4 roles, click-to-expand per row, per-permission checkbox toggles
  using `SUB_PERMISSIONS_BY_ROLE` + `SUB_PERMISSION_LABEL` from shared.
  Bookkeeper expanded row shows `accessLevel` selector. Pending
  invitations rendered as a separate card below.

### Dead code
- `apps/api/src/routes/team.ts` — deleted from disk.
- `apps/api/src/index.ts` — `teamRouter` import + `/api/team` mount removed.

## Files touched

- apps/api/src/db/migrations/20260503060000_team_permissions_consolidation.sql (new)
- apps/api/src/routes/auth.ts (login query + getScopeForUser helper)
- apps/api/src/services/notifications.ts (maintenance team query)
- apps/api/src/routes/scopes.ts (GET /team + PATCH /permissions)
- apps/api/src/routes/team.ts (deleted)
- apps/api/src/index.ts (teamRouter unmount)
- apps/landlord/src/pages/TeamPage.tsx (rewrite)
- DEFERRED.md (8a/8b/8d shipped, 8c still outstanding)
- SESSION_80_HANDOFF.md (this file)

## Validation

- `npm run db:migrate` → 1 applied, schema.sql regenerated to 5939 lines
- `cd apps/api && npx tsc --noEmit` → exit 0
- `cd apps/landlord && npx tsc --noEmit` → exit 0
- `psql gam`: `team_members` confirmed dropped, `permissions` column
  confirmed on the 3 scope tables.

## What this session did NOT do

**8c — Wire sub-permission gates into routes.** The toggles are now a
UI affordance and a JWT claim, but routes today still gate on role only.
A new POS employee with `pos.refund=false` will currently still hit the
refund endpoint successfully. Until 8c lands, the toggles are
descriptive, not enforcing.

## Pre-launch blockers still open

- Item 8c — wire sub-permission gates into routes (per-route audit + a
  `requirePerm(key)` middleware reading JWT.permissions).
- Item 16 batch 2 — bank ACH origination provider selection + real
  `fireViaBankAch` call + settlement webhook/polling handler.
- Item 16 batch 3+ — applicant bg check payment, OTP enablement, pool
  unlock $1, mock pi_* replacement.
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day).
- Item 11 — Master Schedule finish-or-strip (needs Nic's product call).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- Item 19 — Email systems consolidation.

## What next session should target

Top picks for S81:

1. **Item 8c — wire route gates.** Direct continuation of 8a/8b. Per-route
   audit + `requirePerm(key)` middleware. Bounded but tedious; deliver
   in one session.
2. **Item 19 — Email consolidation** — Resend vs nodemailer cleanup
   with nodemailer audit blockers.
3. **Item 16 batch 3** — applicant bg check payment via Stripe
   PaymentIntent. Rail-independent of batch 2.

Recommend **8c** if you want Item 8 fully closed before moving on; **19**
or **16 batch 3** if you want a different domain.

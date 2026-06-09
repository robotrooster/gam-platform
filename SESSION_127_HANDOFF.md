# Session 127 Handoff

**Theme:** Sub-permission route gating — pass 2 (reports.ts).
Continues the S126 swap by opening the reports endpoints to team
workers with the right perms. Also extracted the
`resolveLandlordIdForUser` helper out of `landlords.ts` into a
shared `lib/scope.ts` so future swaps don't duplicate it.

## Architecture decisions

**Two perms in play, not one.** S126 used a single perm
(`payments.view_all`) because all three routes were Connect
dashboard reads. Reports splits cleanly into two domains:
- **Financial dashboard** (`/summary`, `/monthly-statement`,
  `/property-pl`) — same shape as the Connect reads. Gated by
  `payments.view_all`.
- **Tax / 1099 prep** (`/tax-summary`, `/work-trade-1099`) — these
  produce 1099-eligible totals and surface tenant EINs. Bookkeeper
  domain. Gated by `books.view`.

Splitting the gates lets a landlord opt to grant the property
manager financial visibility without giving them tax/EIN data,
and grant the bookkeeper tax data without giving them
allocation-level operational reads.

**Router-level `requireLandlord` lifted.** The previous
`reportsRouter.use(requireAuth, requireLandlord)` blanket gate was
incompatible with per-route perms (worker roles would 403 at the
router before reaching the per-route check). Replaced with
`reportsRouter.use(requireAuth)` and per-route `requirePerm()`.
Owners auto-pass via `requirePerm`'s OWNER_ROLES short-circuit, so
no owner regression.

**Admin path on `/summary` preserves whole-platform scope.** The
`isAdmin` branch in `/summary` queries unscoped (no
`landlord_id=$1` filter). Admins skip the helper entirely; only
non-admins must resolve a landlord. This keeps the admin
"platform-wide collected MTD" view working.

**Shared helper, not duplicated.** Moved
`resolveLandlordIdForUser` out of `landlords.ts` into
`apps/api/src/lib/scope.ts`. Single source of truth for the
owner-vs-team-worker scope-resolution rule. `landlords.ts` now
imports it.

## Shipped

### apps/api/src/lib/scope.ts (new)

One export: `resolveLandlordIdForUser(user)`. Owner →
`profileId`; team worker (property_manager, onsite_manager,
maintenance, bookkeeper) → `landlordId` JWT claim; everyone else
(admin, super_admin, tenant) → null. Centralizes the rule
established in S126.

### apps/api/src/routes/reports.ts

Five endpoints gated:
- `GET /summary` → `requirePerm('payments.view_all')` + helper
  (admin path preserved)
- `GET /monthly-statement` → `requirePerm('payments.view_all')`
- `GET /tax-summary` → `requirePerm('books.view')`
- `GET /property-pl` → `requirePerm('payments.view_all')`
- `GET /work-trade-1099` → `requirePerm('books.view')`

Router-level `requireLandlord` removed; `requireAuth` retained.
All five handlers swap `req.user!.profileId` for
`resolveLandlordIdForUser(req.user!)` with a 400 on missing
scope.

### apps/api/src/routes/landlords.ts

Local `resolveLandlordIdForUser` removed; imported from
`lib/scope` instead. Behavior unchanged.

## Files touched

- `apps/api/src/lib/scope.ts` (new)
- `apps/api/src/routes/reports.ts` (5 perm gates + helper swap)
- `apps/api/src/routes/landlords.ts` (helper extracted to lib/scope)
- `SESSION_127_HANDOFF.md` (this file)

No migrations, no schema changes, no shared package changes.

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Manual review: every `req.user!.profileId` reference in the
  five reports handlers replaced with the helper-resolved
  landlordId; admin path on `/summary` left as platform-wide.

Live API smoke deferred (dev server not running this session).

## What this session did NOT do

- **No swap on writes.** Reports is read-only, so this didn't
  apply.
- **No new perms added.** Used existing `payments.view_all` and
  `books.view` from the S81 catalog.
- **No frontend.** Per UI/UX standing rule.

## Pre-launch backend status

Add to closed list:
- ✅ Sub-permission gating — reports module (5 routes)

Open items:
- Sub-permission gating — remaining ~20 routes across 7 files:
  - `landlords.ts`: `/me/todos`, `/me/email-failures`,
    `/me/pm-impact`, `/me/disputes/:id/respond`, `/flexcharge/*`,
    `/complete-onboarding`, `PATCH /me`
  - `units.ts`: `/:id/eviction-mode`, `/:id/activate`,
    `/:id/cancel-scheduled-activation`
  - `properties.ts`: `PATCH /:id/allocation-rule`,
    `PATCH /:id/pm-assignment`
  - `bulletin.ts`: `GET /landlord`
  - `notifications.ts`: `POST /bulk`
  - `workTrade.ts`: 5 routes (needs catalog extension —
    `work_trade.view`, `work_trade.reconcile`)
  - `books.ts`: `/bookkeeper/clients`, `/bookkeeper/all`,
    `/bookkeeper/invite`, `/bookkeeper/assign`,
    `/bookkeeper/revoke`
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Admin notification surface (long-standing deferral)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

Continuing the sub-permission swap by domain. Suggested order:

1. **units.ts — activate / cancel-scheduled-activation** (open
   to `units.edit`); **eviction-mode** stays owner-only (legal).
   Quick mechanical pass.
2. **bulletin.ts/landlord + notifications.ts/bulk** — open to
   tenant-message perms (likely `tenants.create` is too narrow;
   may need a new `tenants.message` or reuse `payments.view_all`
   for the broadcast list view). Light catalog discussion.
3. **workTrade.ts** — needs catalog extension. Bigger pass.
4. **landlords.ts remaining routes** — mostly stay owner-only;
   final review pass.

Recommend **#1 (units.ts)** as the next session — small, contained,
follows the established pattern.

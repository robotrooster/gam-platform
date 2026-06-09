# Session 130 Handoff

**Theme:** Sub-permission route gating — pass 5 (workTrade.ts).
Adds 3 new catalog perms, gates 5 routes, and fixes two
pre-existing bugs in the work-trade scope helper that would have
blocked team-worker access entirely.

## Architecture decisions

**Three perms, separated by authority level.**
- `work_trade.view` — read agreements, read dashboard. Lowest
  authority; PM with read-only delegation can see arrangements
  without acting on them.
- `work_trade.manage` — create new agreements + update status
  (pause/end). Setup authority.
- `work_trade.reconcile` — approve/reject submitted hours +
  monthly period reconciliation. The "what counts as paid" gate.
  Distinct from `manage` because a landlord may want a PM to set
  up agreements but reserve the financial close to themselves
  (or to a bookkeeper).

Three perms instead of one means a landlord can grant operational
oversight (`view` + `manage`) without granting close-the-books
authority (`reconcile`). Mirrors the same separation used in S81's
`payments.view_all` vs `payments.initiate_disbursement`.

**Bug fix folded in (fix-it-right).** Two pre-existing bugs in
the workTrade helper were silently broken:

1. `getAgreementForLandlord(id, landlordProfileId)` compared
   `agreement.landlord_id` to `req.user!.profileId`. For a
   landlord owner this works (profileId = landlord.id). For a
   team worker this would have always 403'd because
   profileId = team_member.id, not landlord.id. The function
   was never reachable by anyone but a landlord owner under the
   prior `requireLandlord` gate, so the bug was invisible. Once
   we open the gate, the bug becomes a regression — fixed in
   the same pass.

2. `isAdmin(landlordProfileId)` queried `users.role` with the
   landlord's profileId (which is `landlord.id`, not `user.id`).
   Always returned `null`/falsy. Admin override was non-functional.
   Replaced with the standard `canManageLandlordResource` helper
   which handles admin / super_admin / landlord / team-role
   matching in one place.

The new helper `getAgreementForUser(id, user)` takes the full
user object and delegates the scope check to
`canManageLandlordResource(user, agreement.landlord_id,
['property_manager'])` — same pattern S128 used for unit
activation.

**Bookkeeper not yet in the loop.** Bookkeeper has its own gating
model (`requireBooksRead` / `requireBooksWrite`) and isn't part
of the property_manager sub-permissions catalog. Granting
bookkeeper access to `work_trade.reconcile` is a future expansion
once we decide whether to merge bookkeeper into the same catalog
or treat work-trade reconciliation as separate from books.

## Shipped

### packages/shared/src/index.ts

- `PROPERTY_MANAGER_SUB_PERMISSIONS` extended with 3 new perms:
  `work_trade.view`, `work_trade.manage`, `work_trade.reconcile`.
- `SUB_PERMISSION_LABEL` extended with all 3 labels.
- Rebuilt: `cd packages/shared && npm run build` → exit 0.

### apps/api/src/routes/workTrade.ts

5 routes swapped:
- `GET /` → `requirePerm('work_trade.view')` + helper for landlordId
- `POST /` → `requirePerm('work_trade.manage')` + helper for landlordId
- `PATCH /:id` → `requirePerm('work_trade.manage')` + new
  `getAgreementForUser` helper
- `PATCH /logs/:logId` → `requirePerm('work_trade.reconcile')` +
  helper
- `POST /:id/reconcile` → `requirePerm('work_trade.reconcile')` +
  helper

Helper rewrite:
- Old `getAgreementForLandlord(id, profileId)` → new
  `getAgreementForUser(id, user)`. Uses
  `canManageLandlordResource(user, agreement.landlord_id,
  ['property_manager'])` for owner+team scope check.
- Old broken `isAdmin(userId)` deleted. Admin/super_admin
  pass-through is handled by `canManageLandlordResource`.

`requireLandlord` import dropped; `requirePerm`,
`resolveLandlordIdForUser`, `canManageLandlordResource` added.

## Files touched

- `packages/shared/src/index.ts` (catalog + labels)
- `packages/shared/dist/*` (rebuilt)
- `apps/api/src/routes/workTrade.ts` (5 perm gates + helper
  rewrite + bug fixes)
- `SESSION_130_HANDOFF.md` (this file)

No DB migrations.

## Validation

- `cd packages/shared && npm run build` → exit 0
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Manual review:
  - `requireLandlord`, `getAgreementForLandlord`, `isAdmin` all
    gone (`grep` confirmed only the comment in the new helper
    references them by name)
  - `req.user!.profileId` no longer used as a landlord identity
    in any of the 5 handlers — replaced by helper-resolved
    `landlordId` or by `canManageLandlordResource`
  - all 5 handlers either land via `getAgreementForUser` (which
    blocks unauthorized scope) or do their own
    `resolveLandlordIdForUser` + `landlord_id=$1` filter

Live API smoke deferred (dev server not running).

## What this session did NOT do

- **No frontend.** Per UI/UX standing rule. New perms surface in
  the team-permissions panel automatically once the panel is
  built.
- **No bookkeeper expansion.** Bookkeeper's gating model is
  separate; future session.
- **No default-grant migration.** Existing scope rows don't
  acquire the new perms automatically (least-privilege).

## Pre-launch backend status

Add to closed list:
- ✅ Sub-permission gating — workTrade module (5 routes, 3 new
  catalog perms)
- ✅ Bug fix — workTrade scope check no longer relies on broken
  profileId comparison + broken isAdmin lookup

Open items:
- Sub-permission gating — final cleanup pass (~8 routes):
  - `landlords.ts` remaining: `/me/todos`, `/me/email-failures`,
    `/me/pm-impact`, `/me/disputes/:id/respond`, `/flexcharge/*`,
    `/complete-onboarding`, `PATCH /me`
  - `properties.ts`: `PATCH /:id/allocation-rule`,
    `PATCH /:id/pm-assignment`
  - `books.ts/bookkeeper/*` (5 — likely stay owner-only;
    bookkeeper has own gating)
  - `units.ts/eviction-mode` (intentionally stays owner-only)
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Admin notification surface (long-standing deferral)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

Most of the remaining `requireLandlord` routes are intentionally
owner-only (legal/financial actions) and don't need a swap. The
right next pass is a **review-and-document** session that walks
each remaining route, decides "stay owner-only" vs "open with
new perm," and either swaps or annotates the handler with a
brief comment so future readers don't need to re-derive the
decision.

Estimated 30 min for the cleanup. After that the sub-permission
gating track is closed pre-launch.

Recommend the cleanup pass next, since the meaningful swaps
(reads, broadcast, work trade) are all done.

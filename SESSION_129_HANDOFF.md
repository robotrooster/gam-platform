# Session 129 Handoff

**Theme:** Sub-permission route gating — pass 4 (bulletin +
notifications). Adds two new perms to the catalog and gates the
two outstanding broadcast-style endpoints.

## Architecture decisions

**Two new perms, not one.** `bulletin.view` (read tenant bulletin
posts on the landlord's properties) and `notifications.send_bulk`
(broadcast email/SMS to property tenants) are different domains:
- `bulletin.view` is read-only oversight of tenant chatter — fits
  for property_manager AND onsite_manager (the onsite manager is
  the role most likely to read the property's board day-to-day).
- `notifications.send_bulk` is a write/comms surface — fits for
  property_manager (and could later expand to other roles, but
  default to PM only since onsite-manager comms are usually
  point-to-point, not broadcast).

Splitting them lets a landlord grant board visibility without
broadcast authority and vice versa.

**No migration needed.** Sub-permissions live in the
`property_manager_scopes.permissions` jsonb (and analogous tables
for the other roles); no schema change is required to add new
keys to the catalog. Existing scope rows that don't include the
new keys default to "not granted" — preserves least-privilege.

**Catalog labels updated.** Both perms got entries in
`SUB_PERMISSION_LABEL` so the team-permissions UI will surface
them with human-readable text when the frontend pass happens.

**Both routes use `resolveLandlordIdForUser`.** Same scope-resolution
pattern as S126/S127. notifications/bulk also imports `AppError`
which it didn't need before.

## Shipped

### packages/shared/src/index.ts

- `PROPERTY_MANAGER_SUB_PERMISSIONS` extended with
  `notifications.send_bulk` and `bulletin.view`.
- `ONSITE_MANAGER_SUB_PERMISSIONS` extended with `bulletin.view`.
- `SUB_PERMISSION_LABEL` extended with both labels.
- Rebuilt: `cd packages/shared && npm run build` → exit 0.

### apps/api/src/routes/bulletin.ts

- `GET /landlord` swapped: `requireLandlord` →
  `requirePerm('bulletin.view')`.
- Handler uses `resolveLandlordIdForUser` (drops the unused
  `requireLandlord` import; added `requirePerm` and `lib/scope`
  imports).
- 400 on missing landlord scope.

### apps/api/src/routes/notifications.ts

- `POST /bulk` swapped: `requireLandlord` →
  `requirePerm('notifications.send_bulk')`.
- Handler uses `resolveLandlordIdForUser` (drops `requireLandlord`,
  adds `requirePerm`, `lib/scope`, `AppError`).
- 400 on missing landlord scope.

## Files touched

- `packages/shared/src/index.ts` (catalog + labels)
- `packages/shared/dist/*` (rebuilt)
- `apps/api/src/routes/bulletin.ts` (1 perm gate + helper)
- `apps/api/src/routes/notifications.ts` (1 perm gate + helper)
- `SESSION_129_HANDOFF.md` (this file)

No DB migrations.

## Validation

- `cd packages/shared && npm run build` → exit 0
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Manual review:
  - `requireLandlord` no longer imported in either file
  - both handlers use the helper correctly
  - new perms exist in both PROPERTY_MANAGER and (where applicable)
    ONSITE_MANAGER catalogs
- `grep -rn "notifications.send_bulk\|bulletin.view" apps/landlord
  apps/admin apps/admin-ops` → no hits, confirming no frontend
  refs to update (frontend pass is separate per CLAUDE.md).

Live API smoke deferred (dev server not running).

## What this session did NOT do

- **No frontend.** Per UI/UX standing rule. The team-permissions
  UI will surface the new perms once the catalog drives that
  panel — that's a frontend pass task.
- **No default-grant migration.** Existing property_manager_scopes
  rows don't auto-acquire the new perms; landlords must grant
  them explicitly. This is correct (least-privilege) but means
  nobody can use these new gates today until a landlord toggles
  them on for a worker.
- **No swap on bulletin POST/super-admin routes.** Only the
  landlord-facing read view changed.

## Pre-launch backend status

Add to closed list:
- ✅ Sub-permission gating — bulletin/landlord + notifications/bulk
  (2 routes, 2 new catalog perms)

Open items:
- Sub-permission gating — remaining ~13 routes:
  - `workTrade.ts` (5 — needs catalog extension)
  - `books.ts/bookkeeper/*` (5 — likely stay owner-only)
  - `landlords.ts` remaining (~3 — most stay owner-only)
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Admin notification surface (long-standing deferral)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

1. **workTrade.ts** — needs new catalog perms (`work_trade.view`,
   `work_trade.reconcile`). 5 routes. Bigger pass than the prior
   sub-permission swaps but follows the same pattern. ~45 min.
2. **books.ts/bookkeeper management + landlords.ts financial
   leftovers** — final review pass; document which stay
   owner-only and close the sub-permission track. ~30 min.

Recommend **#1 (workTrade)** to finish the meaningful swaps
before the cleanup pass.

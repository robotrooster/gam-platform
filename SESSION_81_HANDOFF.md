# Session 81 Handoff

**Theme:** Item 8c — wire sub-permission gates into routes. Built
`requirePerm(...keys)` + bookkeeper-specific helpers, audited every
landlord-side route, mapped each to a perm key from the shared catalog.

## Architecture decision recorded

Three layers now collaborate on auth:

1. **`requireAuth`** — JWT validity + `req.user` populated. Unchanged.
2. **`requirePerm(...keys)`** (NEW) — admission gate at the route entry.
   Owner roles (admin / super_admin / landlord) bypass. Worker roles
   pass if `JWT.permissions[key] === true` for any of the listed keys.
3. **`canAccessLandlordResource` / `canManageLandlordResource`** —
   in-handler scope check against the specific resource's
   `landlord_id`. Unchanged from S78.

Two specialty bookkeeper helpers (`requireBooksRead`, `requireBooksWrite`)
handle the bookkeeper `access_level` shape (`read_only` | `read_write`)
without forcing every books route to special-case the role.

Until S81 the route-entry gate (`requireLandlord`) only admitted
`admin / super_admin / landlord`, so a worker's JWT could log in but
got 403 on every landlord route. The S80 sub-permission toggles were
purely cosmetic. They now enforce.

## Shipped

### middleware/auth.ts
- New `requirePerm(...keys)` — owner-bypass + key OR-check on
  `req.user.permissions`.
- New `requireBooksRead` — admits owner, bookkeeper (any access_level),
  property_manager with `books.view`.
- New `requireBooksWrite` — admits owner, bookkeeper (`read_write`),
  property_manager with `books.edit`.
- AuthPayload.permissions widened to `Record<string, boolean | string>`
  to fit bookkeeper's string-valued `access_level` alongside the
  boolean sub-permission keys.

### Routes audited and gated

- **pos.ts (33 endpoints):** `pos.ring_sale`, `pos.refund`, `pos.void`,
  `pos.discount`, `pos.end_of_day`, `pos.manage_inventory` mapped per
  endpoint. Read endpoints accept multiple OR-perms (cashier needs to
  see items + categories + tax rates).
- **books.ts (40 endpoints):** all GET → `requireBooksRead`, all
  POST/PATCH/DELETE → `requireBooksWrite`. `/bookkeeper/*`
  invite/assign/revoke endpoints kept on `requireLandlord` (managing
  bookkeepers themselves is landlord-only).
- **maintenance-portal.ts (16 endpoints):** previously bare
  `requireAuth` — any tenant could clock in or approve POs. Now gated
  per-endpoint on `time.clock_in_out`, `work_orders.create/complete/
  reassign`, `purchases.request/approve`, `unit_access.view`.
- **esign.ts (18 endpoints):** templates / documents → `leases.create`;
  send → `leases.sign`; void / addendum-remove → `leases.terminate`.
- **properties.ts (10 endpoints):** `properties.create`,
  `properties.edit`, `units.edit`, `units.create`, `units.view_status`,
  `tenants.create` (applications). `/allocation-rule` PATCH kept on
  `requireLandlord` (financial, no perm key in catalog).
- **units.ts (10 endpoints):** `units.create`, `units.edit`,
  `units.view_status`, `guests.check_in`, `guests.check_out`.
  `/eviction-mode`, `/economics`, `/activate`,
  `/cancel-scheduled-activation` kept on `requireLandlord` (legally
  fraught / financial / kicks off billing).
- **tenants.ts (3 endpoints):** `/invite` was bare `requireAuth` —
  any authenticated user could invite tenants — now `requirePerm
  ('tenants.create')`. `/transfer` and `/available-units` →
  `tenants.archive`.
- **leases.ts (1 endpoint):** PATCH /:id → `requirePerm('leases.create',
  'leases.terminate')`. In-handler `canManageLandlordResource` widened
  to admit `property_manager`.
- **maintenance.ts (3 endpoints):** PATCH /:id → `work_orders.complete
  / reassign / maintenance.approve_above_threshold`. POST /:id/approve
  → `maintenance.approve_above_threshold`. Stats summary likewise.
- **payments.ts:** GET / list — added in-handler `payments.view_all`
  perm check inside the team-role branch (returns empty if missing).
  POST endpoints stay on `requireAdmin` (system calls).
- **disbursements.ts:** unchanged. GET / scopes by `user_id`; workers
  have no disbursements so the data is naturally empty.
- **scopes.ts (9 endpoints):** team management. GET endpoints →
  `team.invite OR team.manage_permissions`; invite/resend/revoke →
  `team.invite`; permission/scope updates + delete → `team.manage_
  permissions`. `getLandlordIdFromReq` now accepts property_manager
  callers (uses their `req.user.landlordId`).
- **background.ts (6 endpoints):** all landlord-side review / pool
  workflow → `tenants.run_background_check`.
- **terminal.ts (4 endpoints):** Stripe Terminal endpoints →
  `pos.ring_sale`.
- **landlords.ts (12 endpoints):** all `/me/onboard-tenant*` and
  `/me/pending-tenants*` → `tenants.create`. `/flexcharge*`,
  `/complete-onboarding`, `/me PATCH`, `/me/todos` kept on
  `requireLandlord` (landlord-self profile/financial).

### Routes deliberately NOT changed

Kept on `requireLandlord` because the catalog has no matching perm
and the action is landlord-self/financial/policy:

- `properties.ts`: PATCH `/:id/allocation-rule`
- `units.ts`: `/:id/eviction-mode`, `/:id/economics`, `/:id/activate`,
  `/:id/cancel-scheduled-activation`
- `landlords.ts`: `/flexcharge*`, `/complete-onboarding`, `/me PATCH`,
  `/me/todos`
- `reports.ts`: router-level (financial reports)
- `notifications.ts`: POST `/bulk` (no specific catalog key)
- `bulletin.ts`: GET `/landlord` (no specific catalog key)
- `workTrade.ts`: 5 endpoints (no specific catalog key — financial
  setup of work trade agreements)
- `books.ts`: `/bookkeeper/invite`, `/bookkeeper/assign`,
  `/bookkeeper/revoke`, `/bookkeeper/clients`, `/bookkeeper/all` —
  managing bookkeepers themselves is landlord-only

## Catalog gaps surfaced (future expansion candidates)

These actions exist as routes but have no matching perm key in
`SUB_PERMISSIONS_BY_ROLE`. If product wants finer-grained access,
add the key, then point the route at it:

- `units.unit_photos` — onsite managers refresh photos per existing
  comment but no perm exists. Currently piggybacks on `units.edit`.
- `properties.allocation_rule` — no PM access at all today.
- `landlords.todos_view` — landlord dashboard data, PMs can't see.
- `payments.view_all` exists but currently only enforced on `GET
  /api/payments`. No catalog entry for `payments.refund_initiate` or
  similar finer actions (those happen platform-side via admin endpoints).
- `reports.view` — no PM access to financial reports.
- `notifications.send_bulk` — no PM access.
- `bulletin.post` — no PM access.
- `work_trade.manage` — no PM access to work trade agreements.

## Files touched

- apps/api/src/middleware/auth.ts (requirePerm + requireBooksRead/Write
  + AuthPayload.permissions widened)
- apps/api/src/routes/pos.ts (33 endpoints)
- apps/api/src/routes/properties.ts (10 endpoints)
- apps/api/src/routes/units.ts (10 endpoints)
- apps/api/src/routes/tenants.ts (3 endpoints)
- apps/api/src/routes/leases.ts (1 endpoint)
- apps/api/src/routes/payments.ts (in-handler perm check)
- apps/api/src/routes/maintenance.ts (3 endpoints)
- apps/api/src/routes/maintenance-portal.ts (16 endpoints)
- apps/api/src/routes/books.ts (40 endpoints)
- apps/api/src/routes/scopes.ts (9 endpoints + getLandlordIdFromReq)
- apps/api/src/routes/background.ts (6 endpoints)
- apps/api/src/routes/esign.ts (18 endpoints)
- apps/api/src/routes/landlords.ts (12 onboarding endpoints)
- apps/api/src/routes/terminal.ts (4 endpoints)
- DEFERRED.md (8c marked shipped)
- SESSION_81_HANDOFF.md (this file)

## Validation

- `cd apps/api && npx tsc --noEmit` → exit 0
- `cd apps/landlord && npx tsc --noEmit` → exit 0
- `requirePerm` use count across routes: 134
- Remaining `requireLandlord` use count across routes: 31 (intentional —
  the deliberately-unchanged set listed above)

## What this session did NOT do

- **No frontend changes.** Worker logins still need landlord-portal UI
  to expose worker-relevant pages (today the landlord portal navbar
  doesn't filter by perm). Any worker logging in to the landlord
  portal sees the full nav and gets 403 on routes they don't have a
  perm for. UI hide-on-no-perm is its own session.
- **No catalog expansion.** Kept the S79/S80 perm catalog as-is.
  Added catalog gaps to handoff for future product decisions.
- **No tests.** Manual smoke walk only — recommended for the high-
  stakes endpoints (POS refund/void, maintenance approve, bg check).

## Pre-launch blockers still open

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

Top picks for S82:

1. **Frontend perm-aware nav** — landlord portal sidebar should hide
   pages the worker doesn't have perms for. Otherwise workers see a
   nav full of dead links. Bounded one session.
2. **Item 16 batch 3** — applicant bg check payment via Stripe
   PaymentIntent. Rail-independent of batch 2.
3. **Item 19 — Email consolidation** — Resend vs nodemailer cleanup.

Recommend **frontend perm-aware nav** to make the S81 work usable
end-to-end before moving to other domains. Without it, perm gates
deny but the UI doesn't tell the user why.

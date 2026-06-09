# Session 82 Handoff

**Theme:** Frontend perm-aware nav. Closes the loop on S81 — workers now
see only the nav items they actually have backend permission to hit.

## Architecture decision recorded

Nav-item visibility is now a two-stage filter:

1. **Role admission** (`item.roles` includes `req.user.role`). Same
   shape as before S82.
2. **Permission gate** (NEW, optional `item.perm` array). Owner roles
   (admin / super_admin / landlord) bypass entirely. Worker roles only
   see the item if they hold ANY of the listed sub-permission keys.
   Items with no `perm` field are role-only — used for landlord-self
   pages (`/banking`, `/disbursements`, `/reports`, `/settings`,
   `/work-trade`).

This keeps nav visibility exactly aligned with backend `requirePerm`
gates from S81. A PM with `tenants.create` toggled off no longer
sees Tenant Onboarding in their sidebar.

Source of truth for live perms is `/api/auth/me`, re-fetched on every
page load via AuthContext.refresh(). Toggle changes by the landlord
land on the worker's nav at next refresh — no logout required.

## Shipped

### apps/api/src/routes/auth.ts — /auth/me
- Now includes `landlordId` + `permissions` for worker roles, both
  re-fetched from the scope table (not pulled from JWT — so toggle
  edits propagate without re-login).
- Owner roles get `landlordId: null, permissions: null`.
- Emitted in both snake_case and camelCase to remain compatible with
  any legacy consumer.

### apps/landlord/src/context/AuthContext.tsx
- `AuthUser` interface gained `landlordId?: string | null` and
  `permissions?: Record<string, boolean | string> | null`.

### apps/landlord/src/components/layout/Layout.tsx
- `NAV_ITEMS` typed and extended with optional `perm: string[]`
  per item.
- `visibleItems` filter now applies the role + perm gate described
  above.
- Removed `property_manager` from `roles` on `/reports` and
  `/work-trade` — backend gates those routes on `requireLandlord`
  with no perm-key alternative, so showing them to PMs would have
  been a guaranteed 403.
- Added `property_manager` to `roles` on `/team`, `/pool`,
  `/background` (gated on the appropriate sub-perm) and
  `onsite_manager` to `/inventory` (gated on `pos.manage_inventory`).
  These routes already accept those roles per S81 backend wiring.

### Per-item perm map (worker view)

| Nav item            | Perm keys (any of)                                                              |
| ------------------- | ------------------------------------------------------------------------------- |
| Properties          | properties.create / properties.edit / properties.archive                        |
| Unit Overview       | units.create / units.edit / units.view_status                                   |
| Master Schedule     | units.view_status / units.edit / guests.check_in / guests.check_out             |
| Tenants             | tenants.create / tenants.archive / tenants.run_background_check                 |
| Tenant Onboarding   | tenants.create                                                                  |
| Leases              | leases.create / leases.sign / leases.terminate                                  |
| E-Sign              | leases.create / leases.sign / leases.terminate                                  |
| Payments            | payments.view_all                                                               |
| Maintenance         | work_orders.* / maintenance.approve_above_threshold                             |
| Documents           | leases.create / leases.sign / leases.terminate                                  |
| Point of Sale       | pos.ring_sale / pos.refund / pos.void / pos.discount / pos.end_of_day / pos.manage_inventory |
| Inventory           | pos.manage_inventory                                                            |
| Applicant Pool      | tenants.run_background_check                                                    |
| Background Checks   | tenants.run_background_check                                                    |
| Team                | team.invite / team.manage_permissions                                           |
| Dashboard           | (role-only — landlord/PM)                                                        |
| Disbursements       | (landlord-only — financial)                                                     |
| Banking             | (landlord-only — financial)                                                     |
| Reports             | (landlord-only — no catalog perm)                                               |
| Work Trade          | (landlord-only — no catalog perm)                                               |
| Settings            | (landlord-only)                                                                  |

## Files touched

- apps/api/src/routes/auth.ts (/auth/me adds landlordId + permissions)
- apps/landlord/src/context/AuthContext.tsx (AuthUser type)
- apps/landlord/src/components/layout/Layout.tsx (NAV_ITEMS + filter)
- SESSION_82_HANDOFF.md (this file)

## Validation

- `cd apps/api && npx tsc --noEmit` → exit 0
- `cd apps/landlord && npx tsc --noEmit` → exit 0

## What this session did NOT do

- **No URL-bar protection.** A worker who manually navigates to a URL
  they don't have nav for (e.g. `/work-trade`) still loads the page.
  The backend will 403 their data fetches. We don't redirect them
  away from the page or show a dedicated "no access" screen.
  Acceptable for v1 — they can't actually do anything once they land
  there. If we want hard URL gating, add a `<RequirePerm>` wrapper
  around routes in `main.tsx`. Defer.
- **No changes to other portals.** Admin / tenant / POS / books portals
  are unchanged. Only the landlord portal serves worker-role users.
- **No empty-state copy on pages.** If a worker lands on a page their
  perms allow but the data is empty (e.g. PM with `payments.view_all`
  but no payments yet), the existing empty states still apply.
- **Pre-existing snake/camel mismatch on /auth/me.** The endpoint
  returned snake_case raw SQL fields (`first_name`, `profile_id`)
  while AuthUser typed them camelCase. Out of scope; left alone.
  S82 added new fields with both casings to avoid making it worse.

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

Top picks for S83:

1. **Item 16 batch 3 — applicant bg check payment** via Stripe
   PaymentIntent. Rail-independent of batch 2 (still blocked on Nic
   picking the bank ACH provider).
2. **Item 19 — Email consolidation** — Resend vs nodemailer cleanup.
3. **Item 15 — E-sign frontend smoke** — visual polish + e2e walk
   given the S29 hardening you already shipped.

Recommend **16 batch 3** — it's a concrete pre-launch blocker, no
external dependencies, and continues the Stripe/payments thread.

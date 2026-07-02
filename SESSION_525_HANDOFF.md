# SESSION 525 HANDOFF

## Theme
Built the **modular per-user permission system** end-to-end (the "cashier"/staff-role
request evolved into a full permission matrix), then used it to consolidate the
landlord nav: merged **Bookings → Master Schedule** and **Booking Sites → Master
Schedule**. Also: POS negative-input hardening (start of session), Resend go-live,
and a new **Outstanding Balances** front-desk view. Uncommitted (Nic commits).

---

## SHIPPED

### 1. POS negative-input block (frontend + backend)
- `apps/landlord/src/pages/POSPage.tsx`: shared `nonNeg` guard (min=0 + block `-`/`+`/`e`
  keydown + block paste of `-`) spread into all 20 numeric inputs.
- `apps/api/src/routes/pos.ts`: `assertNonNeg()` helper on every write path (items, tax,
  discounts, vendors, PO, transactions incl. walk-up + surcharge, sessions, refund).
- Fixed a **pre-existing** red test (`pos-inventory-vendors.test.ts` cross-landlord
  category check sent singular `propertyId` instead of `propertyIds:[...]` + wrong regex).
  All POS suites green.

### 2. Modular per-user PERMISSION SYSTEM (the big build) — see [[gam-cashier-role]] memory
**HARD DIRECTIVE: no roles, just users.** Every staff user built from toggles;
"cashier"/"front desk" are PRESETS, not roles. Internal backing role = `onsite_manager`
(invisible to landlord). Owners (landlord/admin/super_admin) bypass ALL gating.

- **Property lock** (Sub-step 1A): `middleware/auth.ts assertPropertyInScope()` (reads
  scope fresh from DB, owners + all_properties bypass) on POS sale/session routes.
  Migration `20260701140000_pos_transactions_property_id.sql` (sales now store property).
  `getScopeForUser` carries propertyIds/allProperties → /me + login body. POSPage register
  dropdown filtered to scope. Tests: `pos-property-scope.test.ts` (5 pass).
- **Catalog** (`packages/shared/src/index.ts`): `PERMISSION_CATALOG` (single source of
  truth) = category → sections → items `{key,label,hint?,sensitive?}`. **~106 keys, ~29
  categories**. `PermissionItem/PermissionGroup/PermissionPreset` interfaces,
  `ALL_CATALOG_PERMISSION_KEYS`, `PERMISSION_PRESETS` (front_desk). Built from 5 parallel
  audit agents that read every landlord page.
- **Dedicated permissions page**: `StaffPermissionsPage.tsx` + route `/team/:userId/permissions`.
  Renders catalog as grouped toggles + "Quick presets" (Front Desk) + sensitive badges;
  each flip full-replaces the scope `permissions` jsonb via PATCH `/scopes/:role/:userId/permissions`.
  Reached via "Permissions →" on each Team row.
- **Nav driven by catalog** (`Layout.tsx`): each NAV_ITEM has a `category`; staff see it iff
  they hold ANY key in that category (`CATALOG_KEYS_BY_CATEGORY`). Owners see all. Team +
  Work Trade = owner-only. Dropped old `roles`/`perm` arrays.
- **Every page gated** (5 parallel agents): sub-tabs filtered + action buttons wrapped on
  catalog keys via `apps/landlord/src/lib/permissions.ts usePerms().can()`.
- **Backend lockdown** (5 parallel agents): `requirePerm('<catalog key>')` on action routes
  (properties/units/schedule/bookings/tenants/leases/subleases/esign/maintenance/inspections/
  commonAreas/entryRequests/pm-invitations/settings/applicant-pool). **26 suites / 695 tests pass.**
- **Staff invite/accept flow**: Team "Add a staff member" form (first/last/email/phone, NO
  role dropdown, NO job categories). Migration `20260701150000_invitations_prefill_name_phone.sql`.
  Built the MISSING staff accept page `AcceptInvitePage.tsx` + route `/invite/:token` (flow was
  backend-only before — dead link). Accept auto-verifies email (invite link = proof).
- **BUG FIXED — camelCase middleware** (`lib/caseConversion.ts`): was mangling `pos.ring_sale`
  → `pos.ringSale` on the wire, silently breaking every underscore permission on the frontend.
  Now preserves DOTTED keys in `permissions` maps (still camelCases `access_level`).

### 3. Outstanding Balances (front-desk "who owes" view)
- `routes/balances.ts` GET /api/balances (requirePerm `balances.view`): per tenant+unit unpaid
  invoice balance + contact. `BalancesPage.tsx` + nav + route. `balances` catalog category.

### 4. Front Desk preset + Bookings→Master Schedule merge + Booking Sites consolidation
- **Front Desk preset**: one-click grants Reservations(bookings)/Leases/Master Schedule/
  Outstanding Balances views + guest-ops. Presets are a general mechanism.
- **Bookings merged into Master Schedule** as `reservations` + `requests` tabs (agent port).
  Standalone Bookings retired: nav removed, `/bookings`→`/schedule` redirect.
- **Booking Sites merged into Master Schedule** as `booking_page` tab (slug/welcome/publish +
  rates/tax/deposit, owner-gated `booking_sites.view`/`.edit`). Retired: nav removed,
  `/booking-sites`→`/schedule`.
- **Rename "Bookings"→"Reservations"** (user-facing labels only; `bookings.*` keys unchanged).
- Removed the unit-type filter chips from Master Schedule toolbar (kept the create-time picker).
- Fixed Team-row count "11/10 enabled" → "N permissions granted".

---

## DECISIONS (Nic)
- No roles — just users + toggles. "cashier"/"front desk" = presets. Everything grantable;
  sensitive keys just badge-flagged; EXCEPT `settings.security` (own 2FA) excluded from catalog.
- `guest_access` = one shared key (schedule + bookings).
- Online bookings = **Option A** (auto-confirm after deposit, land in Reservations tab; front
  desk reviews via source filter). "i forgot we were taking deposits."
- Booking Sites has no independent value beyond publishing the public page → fully consolidated.
- Self-service financial routes (bank-account add/archive, Connect onboarding, /me withdrawals)
  are NOT gated (caller's own account, not a landlord-staff action) → reverted both FE+BE; those
  catalog keys removed.

---

## KEY GOTCHAS
- `requirePerm` blocks ALL non-owners incl. **tenants** (no perms) — tenant-reachable routes
  (maintenance create/comment, inspection sign, entry-request respond, sublease terminate,
  common-area cancel) were deliberately LEFT UNGATED.
- Login limiter = 10/15min in-memory; repeated test logins → 429 "Login failed". Clear via
  `touch apps/api/src/index.ts` (respawn).
- Demo landlord realestaterhoades landlord_id is now `7b93d017-…` (CLAUDE.md's 08cd56b0 is stale).
  Test staff: `teststaff-demo@golddoor.io` / `asdfasdf` (Jane, onsite_manager, front_desk preset).

---

## DEFERRED / NEXT SESSION
1. **Retire the old Team-row expandable permission grid** (still uses old SUB_PERMISSIONS_BY_ROLE
   + ScopePicker) — two competing permission UIs now; the `/team/:userId/permissions` page is canonical.
2. **Default landing papercut**: onsite_manager → `/pos` even without POS access (RoleRedirect,
   main.tsx). Should land on first-permitted page. Front-desk Jane lands on empty POS.
3. **Property-scope the balances + schedule** to a front-desk person's assigned property
   (currently landlord-wide).
4. **Cosmetic (UI batch)**: Master Schedule's search bar + stats + "+New Reservation" still render
   above the non-timeline tabs (reservations/requests/booking_page) — scope the toolbar to timeline.
5. Optional: auto-login on staff accept (accept POST returns no token → routes to /login).
6. Fold FlexDeposit advance→custody code rework (unrelated, pre-existing).

## LAUNCH ACCOUNTS (see [[gam-launch-accounts]])
- **Resend DONE** (domain verified, test email delivered).
- **Stripe BLOCKED** on Nic's sales rep (custom-rate account under a different, non-work email;
  can't self-verify rates / contact sales). Walkthrough (Parts A–D) drafted + ready.
- Backend still on dev stack; harden to launchd (`deploy/install-services.sh`) at go-live.

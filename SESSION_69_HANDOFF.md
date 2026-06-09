# Session 69 Handoff

**Theme:** Item 17a Pass 2 continued — `maintenance.ts` and `documents.ts` retrofitted to `scope.ts` helpers. Closed two cross-tenant leak classes plus a missing-auth bug on a high-traffic GET.

Single coherent batch.

## Findings + fixes

### `apps/api/src/routes/maintenance.ts`

Six sites retrofitted; three real bugs.

1. **GET `/` listing — role fall-through bug.** Pre-S69 used `role !== 'admin'` to decide between the tenant-scoped and landlord-scoped filter. Two consequences: super_admin (`role === 'super_admin'`) was caught by the landlord-scope branch and got filtered to their own profileId (returning nothing); team roles (PM, onsite_manager, maintenance) hit the same wrong branch. Replaced with explicit per-role branches: `tenant` → `tenant_id` filter; `landlord` → `landlord_id = profileId`; team roles → `landlord_id = landlordId` JWT claim with empty-result fallback when claim is missing; admin/super_admin → no filter; unknown role → empty result rather than leak.

2. **GET `/:id` — no scope check at all.** Pre-S69 simply joined and returned. Any authenticated user could read any maintenance request by guessing the UUID. Now: tenant must be `request.tenant_id`; everyone else gated through `canAccessLandlordResource(request.landlord_id)`.

3. **POST `/:id/comments` — leak.** Tenant branch was correct (`request.tenant_id !== profileId` → 403). Everyone else fell through with no check, so any non-tenant authenticated user could comment on any request platform-wide. Now gated through `canAccessLandlordResource`.

4. **PATCH `/:id` + POST `/:id/approve`** — fetch-then-check pattern via `canManageLandlordResource`. Approve specifically locked to landlord/admin only (passed `[]` for allowed team roles) since approval over the threshold is a financial/policy decision.

5. **GET `/stats/summary`** — same role fall-through fix as listing endpoint. Admin gets platform-wide rollup; team roles inherit landlord scope via JWT claim; unknown role → empty.

6. **Bug fix in PATCH `/:id`**: when computing the auto-approval gate, the threshold lookup was using `req.user!.profileId` for the landlords WHERE clause — wrong for admin-on-behalf-of (would have returned 0 threshold and triggered awaiting_approval erroneously). Now uses `request.landlord_id`.

### `apps/api/src/routes/documents.ts`

Single GET endpoint. Same role fall-through class:
- Pre-S69 only landlord and tenant had filters; everyone else (PM, onsite_manager, maintenance, **admin, super_admin**) hit the empty `else` and saw every document on the platform.
- Note: under the pre-S69 logic, admin's full-platform visibility was *accidental* (it's the right behavior, but only by virtue of falling through). Team-role visibility was a real leak.
- Replaced with explicit per-role branches matching the maintenance.ts pattern. Admin/super_admin sees all (intentional); team roles + bookkeeper inherit landlord scope via JWT claim; unknown role → empty.

## Files touched

- apps/api/src/routes/maintenance.ts
- apps/api/src/routes/documents.ts
- DEFERRED.md (Item 17a updated)
- SESSION_69_HANDOFF.md (this file)

## Validation

- `cd apps/api && npx tsc --noEmit` → exit 0
- No frontend changes; no migration.

## DEFERRED.md update

Item 17a — added S69 row to the shipped list (maintenance.ts, documents.ts). Remaining files: pos.ts, landlords.ts, esign.ts.

## Pre-launch blockers still open

- Item 16 — Stripe ACH credit firing (held until 2026-05-05 per memory).
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day).
- Item 11 — Master Schedule finish-or-strip (needs Nic's product call).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- 17a Pass 2 continued — pos.ts, landlords.ts, esign.ts.
- Item 18 batches 1B + 2–5 — CHECK constraint centralization.
- Item 19 — Email systems consolidation.

## What next session should target

Top picks (none Stripe-blocked):
1. **17a Pass 2 — pos.ts + landlords.ts** — same muscle, last two file passes before esign.ts (which is bigger and may need its own session).
2. **Item 18 Batch 1B** — LEASE_STATUSES + late-fee triplet centralization. Per S63 needs file-by-file read.
3. **Item 11 — Master Schedule** — needs Nic's build-vs-strip call before code can land.

Today is 2026-05-02. Stripe rate work resumes 2026-05-05.

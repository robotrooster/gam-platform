# Session 70 Handoff

**Theme:** Item 17a Pass 2 continued — `pos.ts` and `landlords.ts` audited and retrofitted. Smaller batch than S69 because pos.ts is gated by `requireLandlord` (admin/super_admin/landlord only, no team-role exposure), so the leak surface was narrower than expected. Found one real cross-landlord bug there. landlords.ts is huge (1776 lines) but most routes are landlord-self by design (`/me/...` and `/:id` flavors); two routes had inline scope checks that excluded team-role users.

Single coherent batch.

## Findings + fixes

### `apps/api/src/routes/pos.ts`

The `requireLandlord` middleware gate (admin/super_admin/landlord only) means no team-role traffic ever lands here, and there's no per-record fetch-then-check needed for most of the file — every catalog query already filters by `landlord_id = profileId` for the calling landlord. Admin ends up with no visibility (their profileId doesn't match any landlord_id), but that's a known limitation rather than a leak.

**One real bug found and fixed:**

POST `/transactions` (line 148) — the line-item INSERT loop fetched `pos_items` by id with no scope check. A landlord could submit a transaction body referencing another landlord's item UUID and decrement *their* stock + write to *their* `pos_inventory_log`. Tiny attack surface (you'd need to know the other landlord's item UUID), but a real cross-landlord write. Fixed by adding `AND landlord_id = $2` to the catalog lookup.

### `apps/api/src/routes/landlords.ts`

Most of this file is `/me/...` self-referential routes — no scope concern by design. Two `/:id`-style routes had inline scope checks excluding team-role users:

1. **GET `/:id`** — pre-S70: `id !== profileId && role !== admin/super_admin → 403`. Excluded PM/onsite_manager/maintenance from viewing the landlord they're scoped to. Replaced with `canAccessLandlordResource`.

2. **GET `/:id/dashboard`** — same exclusion class. The dashboard returns financial rollup (monthly_rent_volume, disbursements totals, revenue trend) — team roles shouldn't see this regardless of whether the inline check let them through. Replaced with `canViewLandlordFinances` (landlord/admin only), which is stricter than the original but matches the data sensitivity.

Other inline `landlord_id !== landlordId` check in `/me/onboard-tenant` (line 505) is correct as-is — it's a sanity guard that the unit being onboarded belongs to the calling user's own landlord scope, and the route is `/me/...` so admin override doesn't apply.

## Files touched

- apps/api/src/routes/pos.ts
- apps/api/src/routes/landlords.ts
- DEFERRED.md (Item 17a updated)
- SESSION_70_HANDOFF.md (this file)

## Validation

- `cd apps/api && npx tsc --noEmit` → exit 0
- No frontend changes; no migration.

## DEFERRED.md update

Item 17a — added pos.ts + landlords.ts (`/:id` + `/:id/dashboard`) to shipped. esign.ts remains; flagged as deserving its own session given its size.

## Pre-launch blockers still open

- Item 16 — Stripe ACH credit firing (held until 2026-05-05).
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day).
- Item 11 — Master Schedule finish-or-strip (needs Nic's product call).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- 17a Pass 2 final — esign.ts only.
- Item 18 batches 1B + 2–5 — CHECK constraint centralization.
- Item 19 — Email systems consolidation.

## What next session should target

Top picks (none Stripe-blocked):
1. **Item 18 Batch 1B** — LEASE_STATUSES + late-fee triplet centralization. Fresh-context precision work; per S63 the tokens overlap with billing-period and accrual configs.
2. **17a Pass 2 — esign.ts** — last 17a file. Bigger scope than the others; expect at least one real leak given the pattern from preceding sessions.
3. **Item 11 — Master Schedule** — needs Nic's build-vs-strip call before code can land.

Today is 2026-05-02. Stripe rate work resumes 2026-05-05 (3 days out).

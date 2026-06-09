# Session 67 Handoff

**Theme:** Stripe Connect tear-out. Replaced the pre-16a Connect onboarding model with the per-user bank-account catalog (16a) end-to-end. Closes a major dead-code chunk + a real cross-app type drift.

Single coherent batch — not split into sub-batches like S66. No Stripe-rate-blocked work touched (Nic asked to defer until 2026-05-05; Connect tear-out is independent of rate confirmation).

## Architectural decision

Pre-16a, "is this user banking-ready?" was gated on `landlords.stripe_bank_verified`, a flag set by Stripe Connect onboarding. Under 16a, GAM is the sole merchant of record and landlords don't have Connect accounts — they add bank accounts directly to their `user_bank_accounts` catalog and route per-property.

S67 replaces every reader of `stripe_bank_verified` with an `EXISTS` check against `user_bank_accounts (status='active')`, deletes the Connect helpers/routes/columns, and rewrites OnboardingPage step 2 to use the bank-account UX shipped in S66.

## Migration

- `apps/api/src/db/migrations/20260503030000_drop_landlords_stripe_connect_columns.sql` — drops `landlords.stripe_account_id` + `landlords.stripe_bank_verified`. Applied; schema.sql regenerated to 5910 lines.

## Backend changes

- **`apps/api/src/routes/auth.ts:121`** — GET `/api/auth/me` no longer selects `l.stripe_bank_verified`. New derived field `bank_account_ready` from `EXISTS (... user_bank_accounts ...)`.
- **`apps/api/src/routes/landlords.ts`**
  - GET `/` (admin landlord list) — adds `bank_account_ready` derived column.
  - GET `/me/todos` — replaces `stripe_bank_verified` lookup with the same EXISTS check; the "Connect and verify your bank account" todo becomes "Add a bank account" linking to /banking instead of /settings.
- **`apps/api/src/routes/admin.ts`**
  - `/onboarding/overview` — `landlords_no_bank` metric now counts landlords with no active `user_bank_accounts` row (was: `stripe_bank_verified=FALSE` count).
  - `/onboarding/landlord/:id` — landlord query adds `bank_account_ready`. Checklist key renamed `bank_verified` → `bank_account_added`, derived from active bank account count instead of Connect flag.
- **`apps/api/src/routes/payments.ts:67`** — `initiate-rent-collection` query no longer joins on `l.stripe_account_id IS NOT NULL`. Replaced with EXISTS against active bank accounts. (Cron job that pulls rent for the next month — was filtering out landlords without Connect; now filters out landlords without a configured payout bank.)
- **`apps/api/src/routes/stripe.ts`** — deleted POST `/connect/onboard` and GET `/connect/status` entirely. Tenant ACH setup routes (`/tenant/setup`, `/tenant/confirm-setup`) remain — those are valid under the merchant-of-record model.
- **`apps/api/src/lib/stripe.ts`** — deleted `createConnectOnboardingLink`. Tombstone comment notes both that and the S68 `createLandlordPayout` deletion. `getStripe`, `createRentPaymentIntent`, `createTenantAchSetup`, and `calcStripeRentCost` remain.
- **`apps/api/src/db/seed.ts`** — both landlord seed INSERTs no longer reference `stripe_bank_verified`.

## Shared types

- **`packages/shared/src/index.ts:1195`** — Landlord interface: removed `stripeAccountId?` and `stripeBankVerified: boolean`. Added `bankAccountReady?: boolean` (server-derived).

## Frontend changes

- **`apps/landlord/src/context/AuthContext.tsx`** — AuthUser interface: `stripeBankVerified` → `bankAccountReady`.
- **`apps/pos/src/context/AuthContext.tsx`** — same rename.
- **`apps/landlord/src/pages/SettingsPage.tsx:84-89`** — "Stripe Bank · Verified/Not Verified" badge → "Bank Account · Ready/Not configured".
- **`apps/admin/src/main.tsx`** — six `stripeBankVerified` reader sites swept to `bankAccountReady` (camelCased on the wire).
- **`apps/admin-ops/src/main.tsx`** — six sites — these were `stripe_bank_verified` (snake_case), which is a **pre-existing bug**: the API converts response keys to camelCase via the outgoing middleware, so admin-ops was reading `undefined` everywhere and rendering "Missing" for every landlord. Fixed in this pass by switching to `bankAccountReady`.
- **`apps/landlord/src/pages/OnboardingPage.tsx`** — full step 2 rewrite. Removed `useSearchParams` Stripe redirect handling, removed the `connectStripeMut` mutation, removed the `useQuery('stripe-status')` poll. Step 2 now reads `apiGet('/bank-accounts')` directly; step is complete when at least one active account exists. New `AddBankAccountInlineModal` component appended (mirrors the BankingPage modal but inlined for onboarding flow). Removed `Shield`, `DollarSign`, `Briefcase`, `Phone`, `Mail`, `MapPin`, `ExternalLink` imports; added `Landmark`, `Plus`, `X` and the `@gam/shared` enum imports for the modal form.

## Files touched (S67)

- apps/api/src/db/migrations/20260503030000_drop_landlords_stripe_connect_columns.sql (new)
- apps/api/src/db/schema.sql (auto-regenerated, 5910 lines — net -2 from column drops)
- apps/api/src/routes/auth.ts
- apps/api/src/routes/landlords.ts
- apps/api/src/routes/admin.ts
- apps/api/src/routes/payments.ts
- apps/api/src/routes/stripe.ts
- apps/api/src/lib/stripe.ts
- apps/api/src/db/seed.ts
- packages/shared/src/index.ts
- apps/landlord/src/context/AuthContext.tsx
- apps/pos/src/context/AuthContext.tsx
- apps/landlord/src/pages/SettingsPage.tsx
- apps/landlord/src/pages/OnboardingPage.tsx
- apps/admin/src/main.tsx
- apps/admin-ops/src/main.tsx
- DEFERRED.md (Item 16 entry trimmed, S67 added to the cleanup tombstone)
- SESSION_67_HANDOFF.md (this file)

## Validation

- `cd apps/api && npx tsc --noEmit` → exit 0
- `cd apps/landlord && npx tsc --noEmit` → exit 0
- `cd apps/admin-ops && npx tsc --noEmit` → exit 0
- `cd apps/admin && npx tsc --noEmit` → exit 2 BUT the only error is `src/main.tsx:11:84` (`localStorage.getItem('gam_admin_token', {enabled:...})` — a 2-arg call to a 1-arg API). Pre-existing, confirmed via `git stash` — not from S67. Flagged for separate cleanup.
- Migration applied cleanly via `npm run db:migrate`.

Not validated: end-to-end smoke (UI/UX work batched per standing rule).

## DEFERRED.md cleanup

- Item 16 (Stripe wiring) — Connect tear-out language removed (no longer pending — done). Cleanup tombstone updated to credit S67/S68.

## Pre-launch blockers still open

- **Item 16 — Stripe ACH credit firing** for queued disbursements (held until 2026-05-05 per memory).
- **Item 2 — FCRA adverse action notice infrastructure.**
- **Item 7 — Notifications schema rebuild** (notification_preferences phantom + 7 phantom cols + dead notification types).
- **Item 10 — Utility billing subsystem** (mandatory pre-launch with E2E smoke confirmed; multi-day per DEFERRED).
- **Item 11 — Master Schedule finish-or-strip** (9 phantom cols).
- **Item 14 — POS app completion** (13 phantom pos_* tables; multi-day).
- **Item 15 — E-sign frontend visual + e2e smoke.**
- **17a Pass 2 continued** — maintenance.ts, documents.ts, pos.ts, landlords.ts, esign.ts.
- **Item 18 batches 1B + 2–5** — CHECK constraint centralization.
- **Item 19 — Email systems consolidation.**

## What next session should target

Top picks (none Stripe-blocked):
1. **Item 7 — Notifications schema rebuild** — concrete phantom-column inventory, single migration + route updates + UI cleanup. Closes a DEFERRED category cleanly.
2. **17a Pass 2 continued** — same muscle from S70/S71. Each route file ~30–60 minutes; can do 2–3 in one session.
3. **Item 11 — Master Schedule finish-or-strip** — 9 phantom cols on units + unit_bookings. Per S63 notes, has drift findings already documented.

Avoid in a single session: utility billing (#10), POS completion (#14) — each is multi-day.

Tooling note: today is 2026-05-02. Stripe rate work resumes 2026-05-05 (Tuesday). Memory `project_stripe_pause.md` will remind future sessions.

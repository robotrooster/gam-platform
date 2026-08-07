# SESSION 579 HANDOFF — Account-first screening flow + onboarding-window grandfather (Slice 1 done)

> Continues the S578 pre-onboarding sweep. This session took S578's §CURRENT-WIP
> (Checkr applicant-flow frontend) and, through design work with Nic, expanded it
> into the full **account-first screening flow + property-linkage + onboarding-
> window grandfather** design. **Slice 1 (account-first flow) is BUILT + verified.
> Slice 2 (linkage + window/grandfather + landlord UI) is designed, NOT built.**
> Nothing committed/deployed (S578 sweep rule: one deploy at the very end).

---

## DESIGN LOCK (Nic-confirmed this session) — see memory `gam-screening-grandfather-onboarding-window`

**Single, linear flow (NO dual entry, NO inline account creation on the bg page):**
account created FIRST via a dedicated signup page (name/email/password + **mandatory
email-2FA**) → prospect lands in the gated tenant portal → completes a **minimal**
background check → landlord accept / adverse-action → then lease.

- **Linking a check to a property:** the landlord **invite** carries the landlord +
  **PROPERTY** binding (property-level, not unit — unit chosen later at lease). No
  invite → general **renter pool**. Reuse/extend existing `/tenants/invite` +
  `/accept-invite`.
- **Waive ("existing resident, skip screening") is NOT a landlord toggle.** It's the
  **onboarding-window grandfather:** during a property's onboarding window the landlord
  declares the occupancy roster (each unit Occupied-by-sitting-tenant or Vacant).
  Declared sitting tenant of an occupied unit = grandfather slot → new lease, NO check.
  **One grandfather per occupied unit, consumed once used.** A **vacancy-fill = a NEW
  applicant → mandatory screening EVEN during the window.** After the window closes,
  **every** new tenant MUST screen — no skip control exists (enforced by date, server-side).
- **Window:** PER-PROPERTY, opens at property creation. Length = **14 days + 1/10 units,
  capped at 30 (one billing cycle).** Closes early on "onboarding complete." Admin-only
  extension. Target is DAYS not weeks (closer/PM owns fast migration — disruption wedge).
  Existing anchor to migrate: `landlords.reconciliation_until` (S568, per-landlord 21d).
- **Guardrails:** landlord attests each grandfather (false attestation = landlord
  liability); every grandfather logged; **applicant ALWAYS pays** (no landlord cost
  incentive to skip). `background/status` already reads `tenants.background_check_status`
  as an override; the portal gate treats anything ≠ not_started/submitted/denied as pass.

---

## SLICE 1 — BUILT + VERIFIED (account-first flow). NOT committed.

Typechecks clean: **api, tenant, listings.** Affected backend suites green: **64 tests**
(auth 35 · tenants-invite 15 · esign-standalone 8 · leaseOnboardingPipeline 6).

**Backend (`apps/api/src/routes/`):**
- `auth.ts` `register-prospect` (pool signup) → **mandatory email-2FA**: sets
  `email_2fa_enabled=TRUE`, `signEmailOtpSessionToken`, `issueEmailOtp`, returns
  `{ requiresEmailOtp, emailOtpSession, user }` (was a full token). Removed the
  verify-LINK email (the emailed code doubles as verification via `/email-otp/verify`).
- `tenants.ts` `accept-invite` (landlord invite) → **mandatory email-2FA + 12-char
  password** (was 8). Same pending-session shape. Lease auto-draft + landlord-notify
  side effects preserved. Imported `signEmailOtpSessionToken, issueEmailOtp`.
- Tests updated: `auth.test.ts` (register-prospect block → requiresEmailOtp; the "email
  fired" test now asserts a `login_email_otps` row, not a verify link),
  `tenants-invite.test.ts` (12-char + pending session), `leaseOnboardingPipeline.test.ts`
  + `esign-standalone.test.ts` (password → 12+, contact activation now 2FA).

**Frontend:**
- `apps/tenant/src/main.tsx`: added `AuthProvider.signup()` (calls register-prospect,
  returns `{emailOtpSession}`) + `SignupInput` type; **new inline `SignupPage`** (account
  details → emailed code step, reuses `loginWithEmailOtp`/`resendEmailOtp`); route
  `/signup`; "Create account" link on LoginPage; renter-pool CTA repointed to `/signup`.
- `apps/tenant/src/pages/AcceptInvitePage.tsx`: **added step-2 email-code UI**
  (`verifyCode`/`resendCode` via `/auth/email-otp/verify`+`/resend`), password min 8→12,
  submit now yields a pending session then the code step.
- `apps/tenant/src/pages/BackgroundCheckPage.tsx`: **authenticated-only now** — mount
  redirect to `/signup` if no token; removed the inline `register-prospect` account
  creation from the pay-step effect; removed the dead email/password fields + gate from
  step 0 (account exists before this page).
- `apps/listings/src/main.tsx`: all 3 apply/screening CTAs `/background-check` → `/signup`
  (params preserved for landlord/unit attribution).

**State after Slice 1 (all working, nothing broken):**
- Self-serve: listings/login CTA → `/signup` → account+2FA → portal → bg check.
- Invited: invite email → `/accept-invite` → password(12)+2FA → portal → bg check.
- Direct hit on public `/background-check` with no token → redirects to `/signup`.

---

## SLICE 2 BACKEND — BUILT + VERIFIED (this session). NOT committed.

Typecheck clean (api). New/affected suites green: **screening-grandfather (8) + 78
regression** (auth 35, tenants-invite 15, onboarding 14, esign-standalone 8,
leaseOnboardingPipeline 6) + background suites (30) + properties (37).

**Migrations (applied to dev + regenerated schema.sql; gam_test rebuilds from schema):**
- `20260804120000_screening_property_linkage.sql` — `property_id` on
  `pending_tenant_intents` + `background_checks`.
- `20260804120100_property_onboarding_window.sql` — `onboarding_started_at` /
  `onboarding_window_until` / `onboarding_completed_at` on `properties`; existing
  properties backfilled to CLOSED (no retroactive grandfather).
- `20260804120200_screening_waive_grandfather.sql` — `tenants.background_check_status`
  gains `'waived'`; grandfather audit cols on `pending_tenant_intents`
  (`screening_waived` / `_by` / `_at` / `screening_attested`).
- `20260804120300_screening_waived_unit.sql` — `screening_waived_unit_id` (records the
  grandfathered occupied unit WITHOUT using `unit_id`, so no lease auto-draft collision).

**Service `apps/api/src/services/onboardingWindow.ts`:** `computeWindowDays` (14 + 1/10
units, cap 30), `openOnboardingWindow`, `getOnboardingWindow` (authoritative, recomputes
from current unit count), `isGrandfatherEligible`, `closeOnboardingWindow`.

**Routes:**
- `properties.ts` create → `openOnboardingWindow(prop.id, client)`. Added
  `GET /:id/onboarding-window` (status) + `POST /:id/onboarding-complete` (early close).
- `tenants.ts` `/invite` → now accepts `propertyId` (property-level); a property-level
  invite (no unit) creates a property-bound intent with `unit_id NULL` (no auto-draft).
  Legacy unit-bound invite path left behaviourally unchanged.
- `tenants.ts` NEW `POST /:tenantId/waive-screening` — window-gated grandfather:
  requires open window + `attested:true` + occupied `unitId`; enforces one-grandfather-
  per-unit; sets `background_check_status='waived'` + audit; records
  `screening_waived_unit_id` (NOT `unit_id`, so no auto-draft).
- `tenants.ts` `/me` → exposes `landlordId` + `propertyId` from the live intent (so an
  applicant with no lease has a property to attribute the check to).
- `background.ts` `/submit` → stamps `property_id` on the check (from unit or live intent).
- `test/dbHelpers.ts` `cleanupAllSchema` → deletes `pending_tenant_intents` before
  properties/units (property-level intents have NULL unit_id → not reached by cascade).

## SLICE 2 FRONTEND — BUILT + VERIFIED (this session). NOT committed.

Typecheck clean: api, tenant, landlord, listings. **139 backend tests green** across
auth/invite/onboarding/e-sign/background/properties/grandfather.

- **Grandfather onboarding UI (landlord — what Nic operates):** `TenantOnboardingPage`
  `NewLeaseInviteMode` + `SingleTenantMode` each show, per selected unit, the property's
  onboarding-window status (`GET /properties/:id/onboarding-window`) with an **"Existing
  resident — skip background check"** attestation checkbox + days-remaining. Sends
  `existingResident` → the onboard routes call `applyScreeningWaive` (window-gated,
  per-occupied-unit, audited) → sets `background_check_status='waived'`. Window closed →
  a "this tenant will complete a background check" notice, no waive. Page copy updated.
- **Backend wiring:** `landlords.ts` `/onboard-new-lease-tenant` + `/onboard-tenant-pending`
  now grandfather (post-commit, best-effort, `screeningWaived` in the response). A shared
  `applyScreeningWaive` service is the single source (waive endpoint + both onboard routes).
- **BackgroundCheckPage minimal Checkr rewrite (tenant, Slice 2c):** provider-aware STEPS —
  Checkr → `['Consent','Review & Pay']` (name prefilled from the account; FCRA credit/criminal
  consent moved to Checkr's hosted flow; PII nulled on submit); mock/dev keeps the full 6-step
  intake. All step render blocks/effects/canNext rekeyed by step NAME.

## SLICE 2 — ALSO BUILT THIS SESSION (mark-complete + telemetry)

- **"Mark onboarding complete" banner (landlord):** `TenantOnboardingPage` now shows an
  `OnboardingWindowsBanner` at the top listing every property with an OPEN window +
  days-remaining + an inline two-step "Mark onboarding complete" (no native dialog). Backed by
  `GET /api/landlords/me/onboarding-windows` (new) + `POST /api/properties/:id/onboarding-complete`.
- **Onboarding telemetry (backend metric — the "track on backend" ask):**
  `GET /api/admin/onboarding-metrics` — per-property duration (creation → complete), e-sign vs
  imported-PDF lease split, closer/PM attribution + summary (avg days, completed/ongoing).
  SQL validated against dev DB.

## POLISH — ALSO DONE THIS SESSION (all typecheck clean)

1. **Admin telemetry UI** — `AdminOnboardingOverview` (apps/admin) now shows an "Onboarding
   Speed" card off `GET /api/admin/onboarding-metrics` (avg days + per-property table: units,
   e-sign vs PDF, closer, days; slow >7d flagged red).
2. **Landlord new-applicant screening invite** — `InviteTenantModal` gained a "Require
   background check (new applicant)" toggle (default ON) → sends `POST /api/tenants/invite
   { propertyId }` (property-level, they screen; unit assigned at lease). Off → legacy unit invite.
   Success copy conditional.
3. **`landlords.reconciliation_until`** — RESOLVED: NOT superseded. `payments.ts` (L77, L1008)
   reads it for autopay-overlap protection during old-system migration — distinct from the
   per-property screening window. Left in place.

## S578 SWEEP — SUBSYSTEM 2 (Stripe money-flow) — STARTED (this session)

Baseline: 94 core money tests green (verified-good). **Finding #1 (confirmed bug) — FIXED
foundationally:** `landlordPassthrough.reconcilePlatformHeldPayments` fired the platform→Connect
Transfer INSIDE its DB txn with no idempotency key → on a commit-after-transfer failure the
auto-retry double-paid the landlord. Rebuilt as a durable fire-after-commit state machine:
- migration `20260804130000_platform_transfer_intents.sql` (pending→transferred/failed).
- `stripeConnect.createPmCompanyTransfer` gained `idempotencyKey`.
- `landlordPassthrough.ts` = RESERVE (txn: claim owner-share, net reversals, write pending
  intent, flip platform_held, stamp `intent:<id>` sentinel) → EXECUTE (fire Transfer with
  `platform_passthrough_<id>` idempotency key) → CONFIRM (stamp real id) → RECOVER (re-fire
  stuck pending intents; dedup at Stripe → never double-pays / never strands money).
- `autoPayouts.ts` runs `recoverPendingPlatformTransfers()` at the top of each weekly run.
- Tests: failure test rewritten to new semantics + 3 new (reserved-not-stranded, no-double-pay,
  recovery-with-idempotency). 147 money-flow tests green; API typechecks clean.

**STILL TO TRACE in Subsystem 2:** webhooks.ts (1229), payments.ts (1064), paymentReversal,
reversalRecovery, withdrawals, disbursements, balances, platformFee, stripeConnectCharges. Then
Subsystems 3–24. (Sweep = go in order 2→24; one deploy at the very end.)

## THE CHECKR/SCREENING/ONBOARDING-WINDOW BUILD IS COMPLETE.
Nothing left on it. All 5 projects (api, tenant, landlord, listings, admin) typecheck clean;
migrations applied; backend suites green. NOT committed (one-deploy-at-end).

**Not yet built (noted for completeness):** admin-only window *extension* past the 30-day cap
(rare; portfolio-manager-assisted). `landlords.reconciliation_until` (S568 per-landlord window)
is NOT yet migrated off — the new per-property window supersedes it for screening; audit whether
anything else still reads `reconciliation_until` before removing.

---

## KEY GOTCHAS
- Tests: `cd apps/api && DB_NAME=gam_test npx vitest run src/…` (NEVER repo root — wipes dev DB).
- Typecheck: `npx tsc -p apps/api/tsconfig.json --noEmit`; frontends `cd apps/<app> && npx tsc --noEmit -p tsconfig.json`.
- Standalone e-sign `contact` activation ALSO goes through `accept-invite` → now 2FA'd too
  (consistent with universal-2FA); its frontend (AcceptInvitePage) handles it.
- `PASSWORD_MIN_LEN=12` (auth.ts). register-prospect + accept-invite + SignupPage all enforce 12.
- S578 broader sweep (subsystems 2–24: Stripe money-flow, invoicing, leases, etc.) is STILL
  pending — see `SESSION_578_HANDOFF.md` progress chart.

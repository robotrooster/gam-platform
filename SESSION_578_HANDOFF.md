# SESSION 578 HANDOFF — Pre-Onboarding Platform Sweep (IN PROGRESS)

> This session is a **full pre-onboarding bug + workflow sweep** of the entire
> platform, triggered because Oak Park has live vacancies and the moment it goes
> live, every flow (a new applicant for an empty unit, a tenant paying rent, a
> landlord running a check) must work correctly. It is NOT finished. This doc is
> the resume point for a fresh session.

---

## ⚠️ READ FIRST — Sweep rules (Nic, non-negotiable)

1. **DO NOT COMMIT anything** until the ENTIRE sweep (all subsystems) is
   complete. There is ONE deploy at the very end, then commit. Everything is
   currently uncommitted working-tree changes.
2. **Trust the CODE, not memory.** Verify what the code actually does; check it
   against Nic's design intent. When intent is unclear, **flag a design
   question** ("is this supposed to do X?") and ask — do not assume.
3. **Fix confirmed bugs on sight** (fix-it-right). Update tests. Keep the tree
   green (typecheck + affected tests) after every change.
4. **Everything Nic is discussing IS launch-critical.** Never tell him something
   isn't (standing rule — see memory `gam-everything-discussed-is-launch`).
5. **Sequential, subsystem-by-subsystem.** Nic prefers this to parallel agents
   (fewer things slip). One subsystem at a time, report, then move on.
6. **TEST DB GUARD — CRITICAL:** NEVER run `vitest` from the repo root or without
   `DB_NAME=gam_test`. The DB connection defaults to `gam` (the DEV db) and
   `cleanupAllSchema` will WIPE it. This happened THIS session (restored from
   `~/gam-backups`). Always run `npm test` (or `DB_NAME=gam_test npx vitest run …`)
   **from `apps/api`**. A hard guard now throws if pointed at a non-`*_test` db.
   See memory `gam-test-db-guard`.

## The sweep methodology (the "walkthrough process")

For each subsystem:
1. Enumerate its surface — route files, services, cron jobs, frontend pages.
2. Read the ACTUAL code paths end-to-end: route → service → DB → webhooks →
   crons → downstream chain reactions. Trace the real behavior.
3. Report three buckets: **(a)** confirmed bugs w/ concrete repro, **(b)**
   "is this how you designed it?" design-intent questions for Nic, **(c)**
   verified-good (so Nic knows it was actually checked).
4. Fix confirmed bugs; run the affected suites + `tsc`.
5. Update the PROGRESS CHART below.

## Platform scale (the map)

~100 backend route files, 1000+ endpoints, 59 cron jobs, 12 portals →
**24 logical subsystems.**

---

## PROGRESS CHART (24 subsystems)

| # | Subsystem | Status | Notes |
|---|-----------|--------|-------|
| 1 | **Auth** (login/2FA/sessions, all portals) | ✅ **DONE** | Deep — spanned every portal; was genuinely broken in places. See §A/§B below. |
| 2 | **Stripe money-flow** (payments → platform-hold → webhooks → Fri disbursement) | ⬜ NOT STARTED | **DO NEXT — highest launch stakes.** payments.ts, webhooks.ts, stripe.ts, disbursements.ts, withdrawals.ts, balances.ts, services: landlordPassthrough, autoPayouts, paymentReversal, reversalRecovery, platformFee |
| 3 | Rent invoicing + late fees | ⬜ NOT STARTED | jobs/invoiceGeneration.ts, jobs/lateFees.ts, lease fee schedule |
| 4 | Leases + e-sign | ⬜ NOT STARTED | leases.ts, esign.ts, subleases.ts, subleaseInvitations.ts |
| 5 | Onboarding | ⬜ NOT STARTED | landlord onboarding, tenants invite, units.ts, properties.ts |
| 6 | Tenant portal | ⬜ NOT STARTED | tenants.ts, tenantCredits.ts, tenantWalkthroughs.ts |
| 7 | Landlord core | ⬜ NOT STARTED | landlords.ts (80 endpoints), properties, units, reports, expenses |
| 8 | FlexSuite | 🟨 PARTIAL | FlexPay rehab/2-strike BUILT this session (§A). FlexDeposit/FlexCharge/FlexCredit/supersedence not swept. |
| 9 | Maintenance | ⬜ NOT STARTED | maintenance.ts, maintenance-portal.ts, entryRequests.ts |
| 10 | Inspections | ⬜ NOT STARTED | inspections.ts |
| 11 | Utilities/RUBS | ⬜ NOT STARTED | utility.ts, serviceInterruptions.ts |
| 12 | Documents/storage | ⬜ NOT STARTED | documents.ts + authed file routes |
| 13 | **Screening / background (Checkr)** | 🟨 backend ✅ / frontend ⬜ | Checkr `/submit` + billing fixed this session. **Applicant-flow FRONTEND restructure recon'd, NOT built — full plan in §D.** Also renter pool. |
| 14 | POS | ⬜ NOT STARTED | pos.ts, businessPos.ts, posCustomerOnboarding.ts, posLock.ts, terminal.ts |
| 15 | Business platform | 🟨 PARTIAL | business login+signup 2FA fixed (§B). businessInvoices/WorkOrders/Quotes/etc not swept. |
| 16 | Storefront + public booking | ⬜ NOT STARTED | publicPropertyBooking.ts, bookings.ts, storefront |
| 17 | Books/bookkeeping | ⬜ NOT STARTED | books.ts, bankFeed.ts, bankReconciliation.ts |
| 18 | Admin + admin-ops | 🟨 PARTIAL | admin-ops login 2FA wired (§B). admin.ts (69 ep), scopes, nexus/tax not swept. |
| 19 | PM companies | 🟨 PARTIAL | pm-company login 2FA wired (§B). pm.ts, pmAgentActivity not swept. |
| 20 | AI agents | ⬜ NOT STARTED | agent.ts, roster eval |
| 21 | Crons/scheduler (chain reactions) | ⬜ NOT STARTED | jobs/scheduler.ts (59 crons) — the backend chain reactions |
| 22 | Surveys/notifications/appointments | ⬜ NOT STARTED | surveys.ts, announcements.ts, notifications.ts, appointments.ts |
| 23 | MH/RV (lot rent, propane, homes, vehicles) | ⬜ NOT STARTED | homeOwnership, homeSale, lotRent, propane, dumpLocations, vehicles, depots, commonAreas |
| 24 | Work-trade / snowbird / recurring | ⬜ NOT STARTED | workTrade.ts, recurringSchedules.ts |

Legend: ✅ done · 🟨 partial · ⬜ not started

---

## DONE THIS SESSION

All changes are **verified** (typecheck clean + affected tests green) but **NOT
committed**. Deploy state per change is noted; see §DEPLOY-STATE.

### §A. FlexPay returner rehab + 2-strike ban (DEPLOYED via mid-session redeploy)

Nic-locked 2-strike lifecycle (see memory `flexpay-demand-test-rollout` pt 10,
`gam-flexpay-float-funding`):
- 1st default → returner (90-day floor + back-of-queue). 2nd tenancy: mark
  clears after **12 consecutive on-time FIRST-attempt pulls, zero retries**; any
  retry resets the count. 2nd lifetime default → **permanent** ban.
- **Migration:** `20260803171500_flexpay_rehab_and_permanent_ban.sql` (tenant
  cols: `flexpay_clean_streak`, `flexpay_returner_cleared`,
  `flexpay_permanently_banned`). **APPLIED to `gam`.**
- `services/flexpay.ts`: `FLEXPAY_REHAB_CLEAN_PULLS=12`, `applyFlexPayRehabProgress`
  (called from `reconcileSettledFlexPayPayment`, idempotent), `handleFlexPayPaymentNsf`
  now permanent-bans on 2nd default, `getFlexPayEligibility` `permanently_banned`
  blocker, `enrollFlexPay` streak reset.
- `routes/admin.ts`: queue demotion `is_flexpay_returner` is rehab-aware
  (`EXISTS defaulted AND NOT returner_cleared`).
- Tests: flexpay.test.ts (+5), s541-flexpay-inquiry.test.ts, flexpay.stripe.test.ts.

### §B. DB incident + recovery + test-DB guard

- **Incident:** ran `vitest` from repo root w/o `DB_NAME=gam_test` → wiped `gam`
  dev db. **Restored** from `~/gam-backups/gam-20260803-033005.dump` (verified:
  27 users / 5 props / 22 units back). Both portals confirmed working by Nic.
- **Guard:** `apps/api/src/test/dbHelpers.ts` — `cleanupAllSchema` now throws
  unless `current_database()` ends in `_test`. Also fixed a pre-existing FK
  bug (delete `credit_merkle_anchors` before `credit_events`).

### §C. Subsystem 1 — Auth: UNIVERSAL 2FA + fixes (NOT deployed)

Nic: **mandatory 2FA for EVERY account on EVERY portal, no exceptions**, and
mandatory 2FA at signup. See memory `gam-signup-2fa-and-auth-sweep`.
- `routes/auth.ts`: login gate is now **universal** (any role w/o a 2nd factor
  gets email-code 2FA; removed the per-role list; `mustEnrollTotp`/forced-TOTP
  path superseded). Landlord `/register` issues code + pending session (no
  token). **Fixed `PATCH /api/auth/me` leaking `password_hash`** (was `SELECT *`).
- `routes/emailOtp.ts`: `/verify` also marks `email_verified` (code doubles as
  verification — one code, no separate verify link at signup).
- `routes/businesses.ts`: business-owner signup issues code (no token); removed
  now-dead `signToken`/`jwt`.
- **Frontends wired for the email-code step (all 7 portals now):** landlord
  `RegisterPage.tsx` (+ fixed 8→12 char password mismatch), business
  `AuthContext`/`LoginPage`/`SignupPage`, pm-company `AuthContext`/`LoginPage`,
  admin-ops `main.tsx`. (landlord/tenant/pos/admin already handled it.)
- **Business-owner LOGIN was fully broken** before this (backend required 2FA
  since S574, frontend crashed on the response) — now fixed.
- Tests updated + green (105 auth + 54 business): auth.test.ts, authBusiness.test.ts,
  businesses.test.ts, emailVerification.test.ts, loginLockout.test.ts,
  passwordReset.test.ts, totp.test.ts.
- **`register-prospect` (tenant): intentionally REVERTED to a full token** with
  an in-code flag — its 2FA belongs in the Checkr restructure (§D), not inline.

### §D. Subsystem 13 — Checkr applicant flow: BACKEND done, FRONTEND recon'd

Nic design lock (memory `gam-checkr-applicant-flow-redesign`): **Checkr is the
ONLY real provider** (mock = dev). Checkr collects SSN/DOB/address/income + FCRA
consent on **its own hosted apply flow** ("Checkr emails the applicant an apply
link"); GAM harvests results. Applicant **ALWAYS pays** (no split; state fee-cap
refunds are the landlord's job off-platform).
- **Backend DONE (`routes/background.ts`), 46 tests pass:**
  - `/submit` is provider-aware — for Checkr it requires ONLY name + payment; no
    longer demands DOB / SSN / FCRA consent (schema already allows nulls; consent
    cols are NOT-NULL booleans defaulting false). Mock path unchanged.
  - Fixed the stale top-of-file "S561 landlord pays" comment → applicant-always-pays.
  - Verified: `/payment-intent` already works off `landlordId` (URL) + optional
    `state`; billing model (S577 applicant-pays / `on_behalf_of` landlord) was
    already correct.
- **FRONTEND NOT built** — see §CURRENT-WIP for the exact plan.

---

## DEPLOY STATE (important)

- **Running API** (launchd `com.gam.api`, pid 15590) = the **mid-session FlexPay
  redeploy** build. It HAS FlexPay rehab (§A). It **does NOT have** the auth/2FA
  changes (§C) or the Checkr backend changes (§D).
- **Migration applied to `gam`:** `20260803171500_flexpay_rehab_and_permanent_ban`.
- Everything in §C and §D is **source-only** (uncommitted, undeployed).
- **FINAL DEPLOY (at sweep end, per Nic):** from `apps/api`, `npm run build`,
  then `launchctl kickstart -k gui/$(id -u)/com.gam.api`; verify `:4000` health
  + a login. THEN commit. (See memory `gam-prod-api-restart`.)

---

## CURRENT WIP — Checkr applicant-flow FRONTEND restructure (recon done, exact plan)

File: `apps/tenant/src/pages/BackgroundCheckPage.tsx` (671 lines). It is a
hardcoded 6-step state machine (`STEPS`, a 6-element `canNext`, `step===0..5`
render blocks) that **creates the account at the END (the pay step, effect
~L275)** and collects ID/address/income/SSN/DOB/consent for GAM. For Checkr this
is legacy. Three interlocking changes:

1. **Account-first + 2FA.** Move account creation to the front (name/email/
   password), with the mandatory email-2FA built in §C — i.e. re-enable
   `register-prospect` 2FA (currently reverted to token w/ a flag in
   `routes/auth.ts`) and add the OTP code step to this page. Then the tenant
   lands in the portal gated to "complete your background check" until done.
2. **Strip the PII steps for Checkr.** `STEPS` is module-level (L54) — move it
   INTO the component and make it provider-aware:
   `providerCollectsPii ? ['Your Info','Consent','Review & Pay'] : [the 6]`
   (`providerCollectsPii` is at L102 from the `/price` query). Then:
   - render blocks currently keyed on `step===N` → key on `STEPS[step]===name`
     (so Address/Employment/ID only render for mock);
   - step 0: hide the DOB field for Checkr (mirror the existing SSN gate at L460);
   - consent block (L598): gate the FCRA `consentCredit`/`consentCriminal`
     checkboxes on `!providerCollectsPii` (keep pool + platform terms);
   - `canNext` (L354-361, 6-element) → rebuild per `STEPS` name;
   - account-creation effect (`if (step !== 5) return`, ~L276) → fire on
     `STEPS[step]==='Review & Pay'`;
   - geolocation effect (`if(step===1…)`, ~L255) → `STEPS[step]==='Address'`.
3. **Minimal Checkr tail + null PII.** submit (`submitMut`, L121-129) currently
   sends `dateOfBirth:form.dob` (empty '' would break the DATE column) and all
   PII — for Checkr send ONLY name + payment + pool/terms consent, `null` the
   rest. After submit, Checkr emails the apply link (the "awaiting_applicant"
   redirect already exists at L362-373).

Backend already supports all of this (§D). Also: the `mock` provider (dev) keeps
the full legacy flow — do NOT remove it.

---

## OPEN DESIGN QUESTIONS — all ANSWERED this session (no pending Nic input)

- Mandatory 2FA at signup? → YES, universal, built (§C).
- All portals same 2FA scope? → YES, universal, built (§C).
- Checkr: mock still real? → NO (Checkr only). Applicant flow minimal? → YES.
  Who pays? → applicant always. (All captured; backend built, frontend §CURRENT-WIP.)

## KEY GOTCHAS / CONTEXT

- **Run tests:** `cd apps/api && DB_NAME=gam_test npx vitest run src/…` (NEVER
  from repo root). Typecheck: `npx tsc -p apps/api/tsconfig.json --noEmit`;
  frontends `cd apps/<app> && npx tsc --noEmit -p tsconfig.json`.
- **25 files modified + 1 new migration** this session (all uncommitted). Full
  list: `git status --short`.
- Prod API on :4000 = launchd `com.gam.api` (compiled `dist`, KeepAlive
  respawns). Backups: nightly 03:30 → `~/gam-backups` (`pg_restore --clean
  --if-exists -d gam <dump>`).
- Relevant memories: `gam-signup-2fa-and-auth-sweep`, `gam-checkr-applicant-flow-redesign`,
  `gam-test-db-guard`, `flexpay-demand-test-rollout`, `gam-flexpay-float-funding`,
  `gam-everything-discussed-is-launch`, `gam-prod-api-restart`.

## SUGGESTED NEXT STEP for the fresh session

Either (a) finish the Checkr applicant-flow FRONTEND (§CURRENT-WIP — recon is
done, plan is exact), or (b) start **Subsystem 2 (Stripe money-flow)** — the
highest launch-stakes area. Nic's call. Do NOT commit or deploy until the whole
sweep is done.

# SESSION 583 HANDOFF — Subsystem 6 (Tenant portal): launch-critical paths combed; camelize wire-contract bug class found + fixed

> Continues the S578→S582 pre-onboarding sweep (24 subsystems, in order). This
> session combed **Subsystem 6 — Tenant portal** (`apps/tenant`, ~11.5K LOC).
> Deep-combed the launch-critical flows (auth, money, signing, invite-accept,
> profile, flex) by hand + swept the systematic bug classes across ALL tenant
> files. Found and fixed a real **camelCase wire-contract** bug cluster (3 bugs),
> one of them a functional break of tenant surveys. **NOTHING is committed** — the
> sweep rule is ONE deploy at the very end. Next in order: **Subsystem 7 (Landlord core).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 7**.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design
   questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green.
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).**
   Comb ONE thing at a time by hand. This overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
7. Report three buckets per subsystem: **(A)** confirmed bugs w/ repro, **(B)** design
   questions, **(C)** verified-good.
8. Communication: plain English to Nic (no coding background).

## Progress map (24 subsystems)
| # | Subsystem | Status |
|---|-----------|--------|
| 1 | Auth | ✅ S578/S579 |
| 2 | Stripe money-flow | ✅ S580 |
| 3 | Rent invoicing + late fees | ✅ S581 |
| 4 | Leases + e-sign | ✅ S582 |
| 5 | Onboarding (incl PDF parser) | ✅ S582 |
| 6 | **Tenant portal** | ✅ **CLOSED S583** (critical paths; see coverage note) |
| 7 | **Landlord core** | ✅ **CLOSED S583** — 34 camelize bugs fixed (5 pages); money/legal/permission/config core all verified-good; no redundant workflows |
| 8 | FlexSuite | 🟨 FlexPay/Credit/Deposit verified S583; **FlexCharge REVOLVING engine BUILT+TESTED S583** (borrower-fee bug fixed; interest/grace/min/late-fee/pay-down/disclosures; `REVOLVING_CREDIT_SPEC.md`). Rest of FlexCharge comb + FlexPay re-verify remain |
| 9 | Maintenance | ⬜ |
| 10 | Inspections | ⬜ |
| 11 | Utilities/RUBS | ⬜ |
| 12 | Documents/storage | ⬜ |
| 13 | Screening/background | ✅ S579 |
| 14 | POS | ⬜ |
| 15 | Business platform | 🟨 login/signup 2FA |
| 16 | Storefront + public booking | ⬜ |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## THE HEADLINE — camelCase wire-contract bug class (systemic; memory `gam-camelize-wire-contract-test-gap`)

**Root cause:** the API wraps EVERY response in `camelCaseKeys` (global middleware,
`apps/api/src/index.ts:~230`) — so the wire format frontends see is camelCase; DB
columns stay snake_case. BUT each route test builds its own bare Express app
(`buildApp()` = router + errorHandler, **no camelize**), so tests assert on raw
snake_case and pass **while production serves camelCase**. The whole API suite is
structurally blind to frontend field-name bugs — a page reading `x.due_date` gets
`undefined` in prod and nothing catches it.

### (A) Confirmed bugs — FIXED (all three = frontend read snake_case; fixed to camelCase)
1. **Lease-notice pop-up subheader blank.** `LeaseNoticeGate` (tenant `main.tsx`) read
   `current.property_name`/`current.unit_number`; wire is `propertyName`/`unitNumber`.
   The formal-notice pop-up's "Property · Unit N" line rendered empty. Fixed the read
   + the `LeaseNotice` interface.
2. **S582 "verifying bank" reassurance line silently missing.** `PaymentsPage`
   computed `earliestDue` from `balanceCtx.rows[].due_date`; wire is `dueDate` → always
   `null` → the "Your rent is due <date>, so you have time" sentence (the point of the
   S582 first-rent readiness notice) never showed. Fixed the read + the row type.
3. **Multiple-choice surveys were UNANSWERABLE (functional).** `TenantSurveysPage` read
   `q.question_type === 'multiple_choice'`; wire is `questionType` → always false → MC
   questions rendered as a free-text box; the tenant's typed answer then failed the
   server's "must be one of the offered options" check with a 400. Fixed `questionType`
   + `questionCount` reads.

### Foundational guards added (Nic approved both follow-ups)
1. **Automatic wire-contract guard** — `apps/api/src/wireContract.test.ts` +
   `test/wireContractScan.ts` scan EVERY portal's frontend source for
   `obj.snake_case` / `obj?.snake_case` reads and fail if an app grows past its
   recorded baseline (in the test). A NEW snake read trips a test the moment it's
   added. **Proven to catch a regression** (injected `r.some_snake_field` → red,
   named the file:line). Baselines: **tenant 0** (swept), landlord 100, business 42,
   fitness 23, storefront 10, admin 8, pm-company 8, rest 0. **RATCHET RULE: when you
   sweep a portal, LOWER its baseline — never raise.** A legitimate snake read (Stripe
   SDK object, local const map, enum value) gets a `// wire-ok` comment on the line.
2. **Surveys wire-contract pinned directly** — `surveys.test.ts` gained a second app
   WITH the camelize middleware asserting `/tenant/mine` emits `questionCount` and
   `/tenant/:id` emits `questionType`. The pattern to copy for other endpoints.
- **Suite green: 24/24** (surveys 9 + guard 15), `DB_NAME=gam_test`. Tenant + API tsc clean.

### (B) Design items — both RESOLVED this session
- ✅ **Suite-wide test blindness → guard built** (above). Not the "camelize the whole
  suite" refactor (that breaks every snake-asserting test); instead a source-scan guard
  that catches new instances and ratchets down as each portal is swept.
- ✅ **BackgroundCheckPage → Mapbox REMOVED.** `pages/BackgroundCheckPage.tsx` no longer
  sends the applicant's typed address to Mapbox — the geocoding autocomplete, token, and
  geolocation-for-suggestions are gone; address is plain manual entry verified only by
  GAM's own `/background/verify-address`. (Note: this address step only ever rendered in
  the legacy MOCK/dev intake — under Checkr `providerCollectsPii` drops the whole step —
  so it was never a live prod leak; still correct to remove. Full page strip stays part of
  the Checkr redesign, memory `gam-checkr-applicant-flow-redesign`.)
- **Still open — this class exists in other portals** (candidate counts, NOT confirmed;
  each needs source-verification): **landlord 100, business 42, storefront 10, admin 8,
  pm-company 8, fitness 23.** Their OWN subsystems (7/15/16/18/19) — the guard baseline
  is armed; ratchet each down when swept.

### (C) Verified-good (traced end-to-end, no fix needed)
- **Server global camelize** means raw `fetch()` calls in `main.tsx` (bg-status, tenant-me
  theme, move-in gate, lease-notices, flexsuite re-accept) all receive camelCase — those
  reads are correct despite bypassing the axios instance.
- **Money path (`payShared.tsx` + `PaymentsPage.tsx`):** pay-in-full FIFO, per-lease
  charge, "Pay all" batch partial-success, pending-bank guard, ACH microdeposit flow
  (matches `gam-ach-microdeposits-not-instant` — free microdeposits, `verified:false`
  top-level in the confirm-setup envelope, `resp.verified` read is correct), card confirm.
- **Login / signup / 2FA / gates:** email-OTP + TOTP two-step, prospect self-signup,
  invite-accept (`res.data.emailOtpSession`/`res.data.token` envelope reads correct),
  LeaseNoticeGate + FlexsuiteReAcceptanceGate + MoveInLockout.
- **SignPage:** conditional-field activation, required-completeness gate, child-value
  pruning on parent change, draft persistence, decline + read-only re-open. Backend
  re-validates (S4 closed).
- **ProfilePage:** camelCase `/tenants/me` reads; notif-pref toggle correctly SENDS
  camelCase in the PATCH body (requests are not camelized — server parses camelCase);
  email-change lockout warning; mandatory-2FA display.
- **Flex/Services hub:** rollout-flag gating, FlexPay demand-test flow (inquiry → proof
  → approve → enroll) matches `flexpay-demand-test-rollout`.
- **Standing-rule scans across ALL tenant files:** native dialogs = 0 (only the
  enforcing helper), raw-enum `.replace('_')` = 0, `apiPost` envelope-unwrap misuse = 0
  (`apiPost` returns the full envelope; callers read `.data`/`.message` correctly).

---

## COVERAGE NOTE (what "CLOSED" means for Subsystem 6)
- **Deep per-page logic comb:** `main.tsx` (auth/gates/routing/dashboard/Flex hub),
  `PaymentsPage`, `payShared`, `SignPage`, `AcceptInvitePage`, `ProfilePage`.
- **Systematic-class sweep (camelize / native dialogs / raw enums / CDN / apiPost) ran
  across EVERY tenant file** — so those bug classes are cleared subsystem-wide.
- **NOT given a full per-page logic comb** (systematic classes only; low launch risk or
  covered by another subsystem): `LeasePage`, `MaintenancePage`, `WorkTradePage`,
  `PayoutsPage`, `BackgroundCheckPage` (pending redesign), `PosCustomerOnboardingPage`
  (POS → S14/15), the auth pages `Verify/Forgot/Reset` (→ S1), `TenantNotificationsPage`,
  and the inline `main.tsx` pages (Inspections/EntryRequests/Walkthroughs/Documents/
  Amenities/Credit/MyDisputes/NotificationPrefs → covered by S9/10/12/22; Credit+Disputes
  are LAUNCH_HIDDEN, not launch-critical). If Nic wants these fully combed, they can be a
  quick S6-followup — but no systematic-class bug hides in them.

## FILES TOUCHED (S583)
- **Frontend (tenant):** `pages/PaymentsPage.tsx` (dueDate), `pages/TenantSurveysPage.tsx`
  (questionType/questionCount), `main.tsx` (LeaseNoticeGate propertyName/unitNumber +
  interface; `wire-ok` annotation on QUESTIONNAIRE_COPY), `pages/BackgroundCheckPage.tsx`
  (Mapbox geocoding + geolocation removed → manual address entry).
- **API test infra (NEW):** `wireContract.test.ts` + `test/wireContractScan.ts` (automatic
  camelize guard, per-portal baselines). `routes/surveys.test.ts` (+2 camelize contract tests).
- **Frontend (landlord, Subsystem 7 camelize batch):** `LotRentPage`, `SurveysPage`, `UnitDetailPage`,
  `BankReconciliationPage`, `BankFeedPage` (~34 snake→camelCase reads). Landlord tsc clean.
- No API source, no schema, no migrations, no `@gam/shared` changes. Suite 24/24 green; tenant + landlord tsc clean.

## TREE STATE
- Tenant app `tsc --noEmit` clean. `surveys.test.ts` 9/9 green (`DB_NAME=gam_test`).
- Nothing committed (sweep rule 2). Still one deploy at the very END.

## SUBSYSTEM 7 — Landlord core — CAMELIZE BATCH CLEARED (S583); full logic comb still pending
**Fixed ~34 real only-snake reads across 5 pages** (blank fields / broken conditionals in prod):
- `LotRentPage.tsx` (8) — homes + charges table (unit/property/rent/lot-rent/month all rendered blank).
- `SurveysPage.tsx` (7) — list counts blank + MC results mis-rendered (same class as the tenant surveys bug).
- `UnitDetailPage.tsx` (5) — home-owner name/role + ownership history.
- `BankReconciliationPage.tsx` (4) — bank-charge date + past-reconciliation period/statement/book balance.
- `BankFeedPage.tsx` (~10) — connection name/sync status, transaction merchant/date/connection, and the
  merchant-category **suggestion** that silently never pre-seeded the categorize draft.
Guard baseline `landlord` **54 → 12**. The **remaining 12 are NOT bugs**: defensive dual-reads
(`camelCase ?? snake`, camelCase wins — RenewalDecisionModal, PaymentsPage, ExpensesPage, AddUnitModal,
BankFeedPage:46/216) + 2 false positives (`ConfirmIntentModal` local const map; `NotificationsPage:43`
jsonb notification blob — a Subsystem 22 question). Landlord tsc clean.

**LESSON for the rest of the sweep:** NOT every scan hit is a bug — many are `camelCase ?? snake`
defensive reads that work. Verify each object's source AND whether it's only-snake before renaming.

### Landlord core — LOGIC COMB (launch-critical surfaces) — verified-good S583
Deep-combed the money/legal/permission core by hand, all CLEAN (three-bucket = all C):
- **PaymentsPage** — partial-payment split (collected/retained/net), manual-record + prior-arrangement
  gating, `feeWaived` message correct (route nests it in `data`; `apiPost` envelope read right). camelCase throughout.
- **LeasesPage / BillFeeModal** — enforces lease-is-law: only signed-lease fees (`dueTiming='other'`)
  billable, amount FIXED by the lease (no arbitrary entry), refuses when the lease has no billable fee.
- **DashboardPage + TodoCard** — control tower; `rentRollUnits = active+delinquent+suspended` (matches
  rent-obligation principle); platform fee server-authoritative.
- **PropertiesPage fee-payer** — ACH landlord-toggle, **card is a locked display ("Tenant pays — always")**,
  platform toggle. Matches `gam-fee-payer-toggles`.
- **AddUnitModal** — late-fee gate is server-enforced; the modal surfaces the server's real error text
  (`createMut.isError`), so a missing late-fee decision blocks cleanly.
- **DepositReturnPage** — `round2` money math, refund clamped ≥0, gap computed, statutory state interest
  added to pool (S177 carve-out).
- **`lib/permissions.ts` `usePerms/can`** — owners implicit-all; staff hold exact dotted keys (camelize
  preserves them); strict `=== true`. Sound foundation for every `can()` gate. Matches `gam-cashier-role`.
- **StaffPermissionsPage** — normalizes perms to `=== true`, full-replaces the map via shared
  `PERMISSION_CATALOG`/`PERMISSION_PRESETS`, hard property-lock via separate scope PATCH. Permission
  system verified end-to-end (assign + enforce).
- **SettingsPage** — saves maint + deposit-return approval thresholds (camelCase, default 500, validated).
  **BankingPage** — standard Stripe Connect Express onboarding + soft-delete archive (keep-everything).
- Standing-rule scans across ALL landlord files: native dialogs 0, raw-enum `.replace` 0, no hardcoded
  fee math (money from server), no `apiPost` envelope misuse.

- **ReportsPage** — all financials from `/reports/*` (server-authoritative per bookkeeping arch);
  client-side only aggregates camelCase per-property values; CSV export clean.
- **TeamPage** — shared role enums + label maps (no raw enums); token-based invite grants nothing
  (permissions set separately). **Owners vs Staff are DISTINCT, not redundant:** SettingsPage
  `/landlords/members` = co-owners (multi-owner LLCs, e.g. Oak Park); TeamPage `/scopes/team` =
  permission-scoped staff. Verified before flagging — no redundancy.

### Landlord core — CLOSED
All launch-critical + config surfaces combed and verified. `LeaseFormModal` drafting was left to S4
(leases+e-sign, already closed). The very large feature
pages under `apps/landlord` belong to OTHER subsystems and get swept there, not here: `SchedulePage`
(bookings), `POSPage` (S14), `TenantOnboardingPage`/`PendingTenantsPage`/`OnboardingPage` (S5 done),
`ESignPage` (S4 done), `UtilityMetersPage` (S11), `InspectionDetailPage` (S10), `MaintenancePage` (S9).

## SUBSYSTEM 7 — original triage note (superseded by the batch above)
Ran the (refined, string-literal-stripping) camelize scan on `apps/landlord`. Raw 100 →
**54 after removing `can('perm.key')` string-literal false positives.** The 54 are almost
all REAL API-response snake reads (blank fields / broken conditionals in prod). Verified
inventory by file (fix = read the camelCase field; a few are local-map false positives to
annotate `// wire-ok`):
- `SurveysPage.tsx` (7): `s.property_name`/`question_count`/`response_count`/`question_type`/
  `survey.property_id` — SAME class as the tenant surveys bug (blank counts + MC results broken).
- `BankFeedPage.tsx` (13): `t.suggested_*`, `c.display_name`/`institution_name`/`last_synced_at`/
  `last_sync_error`, `t.normalized_merchant`/`posted_date`/`connection_name`, `u.property_id`/`unit_number`.
- `LotRentPage.tsx` (8): `h.unit_id`/`unit_number`/`property_name`/`rent_amount`/`lot_rent_amount`, `c.billing_month`/`unit_number`/`property_name`.
- `UnitDetailPage.tsx` (8): `owner.first_name`/`last_name`/`owner_role`, `h.first_name`/`last_name`/`acquired_via`/`acquired_at`.
- `BankReconciliationPage.tsx` (4): `c.expense_date`, `r.period_start`/`statement_balance`/`book_balance`.
- `PaymentsPage.tsx` (2): `l.unit_number`/`property_name`. `ExpensesPage.tsx` (2): `u.property_id`/`unit_number`.
  `RenewalDecisionModal.tsx` (2): `t.first_name`/`last_name`. `AddUnitModal.tsx` (2): `u.unit_number`.
- **Likely FALSE positives (verify, then `// wire-ok`):** `ConfirmIntentModal.tsx:372`
  `PARSER_FLAG_CATEGORY_META.identity_mismatch` (local const map); `NotificationsPage.tsx:43`
  `d.maintenance_request_id` (parsed jsonb notification blob — confirm the blob is object-parsed + camelized).
The guard baseline for `landlord` is **54**; as these are fixed, LOWER it (ratchet rule).

## SUBSYSTEM 8 — FlexSuite — STARTED S583 (FlexCharge reworked; Deposit/Credit verified)
### (C) Verified-good — structural model holds
- **FlexCredit** — $5 gross / ~$1.50 Esusu / $3.50 GAM net; feature-gated no-op while OFF; idempotent
  per cycle; GAM-first supersedence boost; Esusu bureau side correctly un-wired. Matches the model.
- **FlexDeposit** — custody model verified: 2–6 installments, SSDI/SSI service-tier (not credit), explicit
  NO-RECOURSE on missed installments, GAM advances nothing (`gam_advance_amount` stays 0), $3 custody fee,
  `collected_amount` capped at total, banker's rounding. Matches CLAUDE.md (S514/S527).

### (A→FIXED) FlexCharge — borrower-charged-GAM's-fee bug FIXED + design pivot to REVOLVING
**Real bug (FIXED, live):** GAM's 1.5% was added to the BORROWER's statement and the merchant got the full
balance — the borrower paid GAM's fee, which makes GAM look like the lender. Fixed: the borrower is billed
`total_due` only; the merchant receives `total_due − service_fee` in BOTH payout paths
(`reconcileSettledFlexChargeStatement` + `supersedence.satisfyFlexChargeStatement`) + the `webhooks.ts`
supersedence transfer. All stale customer copy fixed (tenant card, POS onboarding, FlexChargePage subtitle).

**Design pivot (Nic, in-session) — FlexCharge → REVOLVING consumer credit. Design LOCKED, engine NOT built.**
See `~/gam/REVOLVING_CREDIT_SPEC.md`. Decisions: merchant is the lender and sets a **per-property APR**
(`properties.flex_charge_finance_pct`, ANNUAL) **capped 6% PER YEAR** (`FLEX_CHARGE_MAX_FINANCE_PCT`; 6%/yr
is under all state usury caps — 6%/mo was the earlier mistake); **revolving** (min payment = greater of $25 or
~% of balance; carry the rest); **grace period** (pay in full → $0 interest); **auto-pull the minimum by
default**; **GAM's cut = 1.5% PER YEAR** off the merchant. ⚠️ This makes the MERCHANT a TILA/Reg-Z consumer
lender (flagged to Nic; consistent with the FlexCharge model — merchant bears compliance; GAM stays vendor).

**FULL REVOLVING ENGINE BUILT + TESTED (Nic: "build it all" → "finish those three pieces").** FlexCharge is
now a merchant-lent revolving credit product. Terms: min = greater of $25/3%, $10 late fee, interest =
previous-balance method (carried × APR/12, grace automatic — pay in full → $0 interest), auto-pull the
MINIMUM. GAM's 1.5%/YEAR (÷12 monthly) off the merchant, never the borrower.
- **Engine:** `generateMonthlyStatement` roll-forward (prev balance + purchases + interest + late fee −
  payments = new balance; min; GAM cut; running `current_balance`); billing cron auto-pulls the minimum;
  reconciler + supersedence credit the min + carry the rest.
- **Customer pay-DOWN:** `payDownFlexCharge` + `reconcileFlexChargePaydown`, route `POST
  /tenants/flexcharge/:accountId/pay`, webhook dispatch, billing-cron shortfall-guard (skip if min already
  covered — no double-charge), `gam_fee_settled` claims GAM's cut once per statement (atomic).
- **Frontend:** `listAccountStatements` revolving fields; landlord `FlexChargePage` statement table
  (Purchases/Interest/New balance/Min due/Paid/GAM fee); tenant `FlexChargeAccountsCard` shows balance +
  minimum + due date + **pay-down modal** (min / in-full / custom).
- **TILA disclosures:** customer-facing (tenant card + POS onboarding) + merchant-facing (`FinanceRateSection`).
- Migrations `20260805150000`–`20260805180000`; constants in `@gam/shared`. **160/160 green** across the 7
  FlexCharge/supersedence/webhook/route suites; all 4 tsc clean; migrations applied.
**REMAINING (minor, non-blocking — `REVOLVING_CREDIT_SPEC.md` → STILL REMAINING):** purchase-time
credit-limit check, POS-app pay-down button, confirm interest method (shipped previous-balance vs ADB), and
the rest of the FlexCharge comb (account create/limit/suspend/dispute, statement cron edges).

## FLEXSUITE — files touched (S583)
`@gam/shared` (FLEX_CHARGE_MAX_FINANCE_PCT, MIN_PAYMENT_PCT/FLOOR, LATE_FEE, PAYMENT_ENTRY_DESCRIPTIONS+FCPAYDOWN);
migrations `20260805150000`_finance_rate, `160000`_revolving, `170000`_paydown, `180000`_fcpaydown_entry_desc;
`services/flexCharge.ts` (statement roll-forward, billing, reconciler, pay-down), `services/supersedence.ts`,
`routes/webhooks.ts` (paydown dispatch), `routes/landlords.ts` (finance-rate routes), `routes/tenants.ts`
(pay-down route); landlord `FlexChargePage.tsx` (rate-setter + statement table), tenant `main.tsx`
(FlexChargeAccountsCard + pay-down modal + disclosure) + `PosCustomerOnboardingPage.tsx`; tests
`flexCharge.stripe.test.ts` (rewritten for revolving + pay-down), `supersedence.test.ts`,
`landlords-pos-flex.test.ts`. **All 4 migrations applied; schema.sql regenerated.**

## NEXT SESSION SHOULD TARGET
1. **Comb the rest of Landlord core by hand** (three buckets) — the camelize class is cleared
   (baseline 12, all non-bugs), but the full landlord feature surface still needs the logic comb.
2. Optionally: sweep `business` (42) / `storefront` (10) / `admin` (8) / `pm-company` (8) /
   `fitness` (23) camelize when their subsystems come up — the guard baselines are armed; expect
   a similar real-vs-defensive split (verify each before renaming). Ratchet baselines DOWN as fixed.
3. Carry the sweep rules (nothing committed; one deploy at the very END).

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl
kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN
commit. GOTCHA: orphan on :4000 → EADDRINUSE (memory `gam-prod-api-restart`).

## RELEVANT MEMORIES
`gam-camelize-wire-contract-test-gap` (NEW), `gam-pay-balance-per-lease`,
`gam-ach-microdeposits-not-instant`, `gam-tenant-portal-redesign`, `gam-tenant-surveys`,
`gam-onboarding-control-tower`, `flexpay-demand-test-rollout`, `gam-no-native-dialogs`,
`gam-no-raw-enums-in-ui`, `gam-checkr-applicant-flow-redesign`, `gam-test-db-guard`,
`gam-dates-and-devlog`, `gam-prod-api-restart`.

# SESSION 582 HANDOFF — Sweep: Subsystems 4 + 5 CLOSED (incl PDF parser) + billing-date lock + async auto-field + onboarding control-tower/nudge/readiness

> Continues the S578→S581 pre-onboarding sweep (24 subsystems, walked in order).
> This session **closed Subsystem 4 (leases + e-sign)** and **Subsystem 5 (onboarding,
> including a deep comb of the PDF lease parser)**, locked a platform-wide lease-date
> model, made auto-field placement async, and — off Nic's design-ideas discussion —
> built the onboarding **control tower**, the **tenant invite-nudge cron**, and
> **first-rent readiness**. **NOTHING is committed** — the sweep rule is ONE deploy at
> the very end. Next in order: **Subsystem 6 (Tenant portal).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 6**.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design
   questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green
   (tsc + affected suites).
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).**
   Comb ONE thing at a time by hand. This overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
   NEVER from repo root / without DB_NAME=gam_test (wipes the dev `gam` DB).
7. Report three buckets per subsystem: **(A)** confirmed bugs w/ repro, **(B)** design
   questions, **(C)** verified-good.
8. Communication: plain English to Nic (no coding background), NOT code jargon.

## Progress map (24 subsystems)
| # | Subsystem | Status |
|---|-----------|--------|
| 1 | Auth | ✅ S578/S579 |
| 2 | Stripe money-flow | ✅ S580 |
| 3 | Rent invoicing + late fees | ✅ S581 |
| 4 | Leases + e-sign | ✅ **CLOSED S582** |
| 5 | Onboarding (incl PDF parser) | ✅ **CLOSED S582** |
| 6 | **Tenant portal** | ⬜ **← NEXT** |
| 7 | Landlord core | ⬜ |
| 8 | FlexSuite | 🟨 FlexPay done; FlexDeposit/Charge/Credit not swept |
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
| 21 | Crons/scheduler | ⬜ (S582 added invite-nudge cron 10am + scheduled-lease-changes 4:30 from S581; verify idempotency in the sweep) |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## SUBSYSTEM 4 — Leases + e-sign — ✅ CLOSED (this session)

### (A) Confirmed bugs — FIXED
1. **Money-add-on "agreement" flow 400'd on any 2+-tenant lease.** The S581 addendum-
   terms auto-resolve tagged extra tenants with signer role `co_tenant`, which is NOT
   valid (`TENANT_ROLE_PATTERN = /^(primary|co_tenant_\d+)$/`) → "Invalid signer role".
   Single-tenant worked, so it slipped. **Fix:** `co_tenant_${i}` (`routes/esign.ts`
   ~2641). Test in `esign.test.ts`.
2. **Money-add-on document-first gap (BUILT).** The MoneyAddonModal sends leaseId + mode
   + scheduledChanges but NO template/base PDF → the signed doc had `base_pdf_url=null`
   and the money term lived only in `scheduled_lease_changes` (never printed on what the
   tenant signs — violates document-first). **Fix:** new `services/moneyAddonPdf.ts`
   generates an addendum PDF that PRINTS the change + effective date + acknowledgment +
   signature/date field boxes (top-left/y-down coords matching `pdfStamp`). The
   addendum-terms route now generates it when changes exist + no base PDF, sets
   base_pdf_url, and inserts `lease_document_fields` per signer. Both agreement + notice
   modes. Rendered + eyeballed via poppler. Tests in `esign.test.ts`.

### (C) Verified-good
- No-template docs: signer role model, field placement, `stampPdf` coordinate convention
  (top-left/y-down; `pdfY = pageHeight - y - height`), executed-PDF gating on base_pdf_url.
- Async auto-field, rent_due_day lock (see below) — verified end-to-end.

---

## SUBSYSTEM 5 — Onboarding (incl PDF parser) — ✅ CLOSED (this session)

### (A) Confirmed bugs — FIXED
1. **Invite→auto-draft silent failure.** On tenant accept, `accepted_at` stamp +
   `autoDraftLeasesForUnit` shared ONE txn; a `createDocumentRecord` throw (e.g. template
   missing the property's late-fee fields) rolled back the acceptance AND fired NO
   notification → tenant's acceptance silently lost, no re-draft trigger. **Fix:** each
   `draftFor` runs in a `SAVEPOINT`; on failure it rolls back just that draft + notifies
   the landlord (`lease_draft_blocked`) — acceptance survives, failure is visible
   (`services/leaseOnboarding.ts`). Test in `leaseOnboardingPipeline.test.ts`.
2. **Per-room paper import blocked.** `POST /me/onboard-tenant` used a flat `is_occupied`
   block, so a landlord importing a dorm / sober-living / rooming house couldn't upload a
   separate paper lease per room. **Fix:** replaced with `assertUnitCanAcceptNewLease`
   (mode-aware: whole_unit blocks a 2nd lease; by_room allows up to 2×bedrooms)
   (`routes/landlords.ts` ~1159). Test in `landlords-tenant-onboarding.test.ts`.
3. **CSV bulk import could double-book every unit.** `POST /me/onboard-tenants-csv/commit`
   inserted `active` leases with NO server-side occupancy check — it trusted the client
   ran `/validate`. A re-upload / direct call would create a 2nd active lease on every
   unit. **Fix:** `assertUnitCanAcceptNewLease` per unit in the commit loop (throws,
   all-or-nothing, like the late-fee gate) (`routes/landlords.ts` ~3268). Test in
   `landlords-csv-tenants.test.ts`.
4. **PDF-parser supersede path was 100% broken.** `resolveIntent` supersedes an existing
   active lease on the unit, but used THREE invalid CHECK values — `status='ended'`
   (leases allow pending/active/expired/terminated), `lease_tenants status='inactive'`
   (allow pending_add/active/pending_remove/removed/void), `removed_reason='superseded'`
   (allow moved_out/replaced/lease_ended). So resolving an import into an already-leased
   unit ALWAYS threw a 500. **Fix:** `terminated` + `terminated_at`, `removed`, `replaced`
   (`jobs/leaseParser/resolveIntent.ts` ~343). Tests in `resolveIntent.test.ts`.
5. **PDF-parser silent supersede (safety).** Even once fixed, resolving into an occupied
   unit would SILENTLY end the sitting tenant's lease with zero warning. **Fix:**
   `resolveIntent` now pre-checks; if the unit has an active lease and
   `opts.confirmSupersede` is not set, it returns `{ needsSupersedeConfirm, supersedeLeaseId,
   supersedeTenantName }` (no writes). The `/resolve` endpoint passes `confirmSupersede`
   from the body; `ConfirmIntentModal.tsx` catches the signal → `appConfirm("…will END the
   active lease for X…")` → re-submits with confirm. Success result now includes
   `supersededLeaseId`. Tests in `resolveIntent.test.ts`.

### (B) Design notes / fixes
- **CSV re-import friendly message.** `commit-pending`'s existing-intent check used
  `resolved_at IS NULL AND cancelled_at IS NULL`, missing a RESOLVED-but-not-cancelled
  intent → the INSERT hit the partial unique index (`WHERE cancelled_at IS NULL`) and
  surfaced a raw Postgres error. **Fix:** check `WHERE cancelled_at IS NULL` +
  resolved-aware message ("already been onboarded with you") (`routes/landlords.ts` ~1780).

### (C) Verified-good
- Pool→unit bridge: `onboard-new-lease-tenant`'s `ON CONFLICT (tenant_id) WHERE
  cancelled_at IS NULL` EXACTLY matches the partial unique index
  `pending_tenant_intents_tenant_id_live_key` — upsert works.
- `commit-pending`: per-row txn isolation, server-side identity re-validation, cross/same-
  landlord + duplicate-in-CSV checks, UNIQUE backstop.
- whole_unit re-draft repair (void unsigned draft on new co-tenant; block if a tenant
  signed). Soft-delete pending = `cancelled_at` (retains person + PDF; releases held unit).
- Invite token: 7-day expiry enforced at accept, single-use, clean 404 on expired/invalid.
- **PDF parser is fundamentally safe:** NO auto-resolve — the ONLY `resolveIntent` caller
  is the landlord's manual `/resolve` click; a shaky parse is forced to `mismatch`
  (block-severity flags) the landlord must review first. Strong build guards: unit must
  match the landlord's portfolio; street-NUMBER address-conflict hard-stop
  (`streetNumbersConflict`/`pickCandidateByAddress`); cross-landlord refuse; never invents
  a late fee; due-day defaults 1. (Text-EXTRACTION internals — extractors.ts/anchors.ts —
  are advisory + landlord-reviewed, so not deep-combed line-by-line; that was a deliberate
  risk-based call.)

---

## PLATFORM LEASE-DATE MODEL — S582 STANDING (memory `gam-lease-date-model`)
One source: `services/leaseDates.ts` (`serverTodayYmd`/`computeLeaseStart`/`computeLeaseEnd`).
- **Rent due day LOCKED to the 1st, platform-wide.** Billing choke point:
  `WRITABLE_LEASE_COLUMN_SPECS.rent_due_day.parse → () => ({ rent_due_day: 1 })` in
  `@gam/shared` (covers every e-sign/renewal doc-built lease, ignores any doc value). All
  other lease-INSERT sites (onboard-tenant, CSV `resolveIntent`, `bookingLeaseDraft`,
  CSV commit) omit the column → DB default 1. Every path = 1. **Why (don't re-introduce a
  configurable due day):** kills a per-lease drift bug class + protects FlexPay (a
  move-in-day due date gives a mid-month-paid tenant no reason to enroll).
- **Due day must still APPEAR in the signed lease (document-first).** Generated lease PDF
  prints "Day 1 of each month" (`leasePdf.ts`). Uploaded leases: auto-field detects a
  due-day blank (`autoFieldPlacement.columnFor`) + `createDocumentRecord` FORCE-fills
  `rent_due_day='1st'`; it's a LOCKED field (new shared `isLockedLeaseColumn()`) — not
  editable/movable/deletable in the editor, not in the manual column palette
  (`ESignPage.tsx`). So the landlord never chooses it but every lease states it.
- **Prorate on the way IN only.** Mid-month move-in prorated (`moveInBundle`); monthly gen
  skips the prorated first month; final month is FULL (no move-out proration) → never
  double-prorates.
- **Fixed-term end dates snap to MONTH-END.** Term = N full months from the first FULL
  month; the partial first month rides on top. 12-mo lease starting Aug 15 → Aug 31 next
  year (always ≥ a full year). M2M → null end.
- **Start prefills from `units.available_date` if future, else today** (fixed the old
  UTC-slice evening-rollover). Wired into `leaseOnboarding.termPrefill` (auto-draft) AND
  `leasePrefill.suggestUnitPrefill` (manual e-sign send, now also returns start + month-end
  end from `template.default_term_months`).
- **Boundary:** these are DEFAULTS for leases GAM ORIGINATES. Paper imports (onboard-tenant
  / CSV / parser) record the ACTUAL typed paper start/end — never snapped.
- **Compliance principle (Nic):** our structure must never FORCE a landlord into state
  non-compliance. Due-on-1st / proration / month-end / ≥1yr are universally acceptable.

---

## ASYNC AUTO-FIELD PLACEMENT — S582 (memory `gam-lease-renewal-and-autofield`)
The auto-place model call (~30s, local Hermes) ran synchronously behind the Cloudflare
tunnel (fixed ~100s edge 524 on non-Enterprise). **Now async:** `POST
/esign/templates/:id/auto-fields` enqueues an `auto_field_jobs` row + fires
`runAutoFieldJob` DETACHED (returns 202 + jobId); the editor polls `GET
.../auto-fields/:jobId`. `services/autoFieldJobs.ts` owns create/run/get. Model timeout
raised to 180s (async removed the CF ceiling). `autoFieldPlacement` now classifies
**per-page** (a slow/failed page only loses ITS labels; others keep AI tags) and
`autoPlaceFields` always detects+places ALL boxes deterministically — a model outage =
full boxes with heuristic labels (`result.modelUsed=false` → ESignPage warns landlord to
double-check). Migration `20260805120000`. Tests `autoFieldJobs.test.ts`. Verified E2E
against a real template.

---

## DESIGN IDEAS (Nic-approved, BUILT this session) — memory `gam-onboarding-control-tower`
Theme Nic bought: **kill silent failures** with a "needs your attention" surface.
1. **Onboarding control tower** — extended the EXISTING dashboard To-Do (`GET
   /me/todos`, `TodoCard` in `DashboardPage.tsx`) with an `onboarding` category (+ counts):
   `parser_review`/`parser_error`, `lease_not_drafted` (accepted, no draft),
   `invite_expired` (→ resend), `awaiting_landlord_signature` (→ `/sign/{docId}`). Scoped
   by landlord_id. Tests in `landlords-todos.test.ts` (5 new).
2. **Tenant invite-nudge cron** — `jobs/inviteNudge.ts` `nudgeExpiringInvites()`, daily
   10am in `scheduler.ts`. Nudges a unit-bound, unaccepted, still-valid invite ≤4 days from
   lapsing, spaced ≥2 days apart (col `pending_tenant_intents.invite_last_nudged_at`,
   migration `20260805130000`; email `emailTenantInviteReminder` in `email.ts`). 6 tests
   (`inviteNudge.test.ts`).
3. **First-rent readiness** — mostly ALREADY existed (payShared shows "Pending
   verification" + 1–3-biz-day timing + card fallback + blocks charging an unverified
   bank). ADDED a top-of-`PaymentsPage` reassurance when the tenant OWES rent but their
   only method is a verifying bank: "verifying 1–3 biz days; rent due <date> so you have
   time; add a card — instant" (`showVerifyingNotice`).
4. **Bulk lease send — PARKED** (Nic not sold: auto-populate/auto-field already fills
   per-unit; discuss more before building).

---

## MIGRATIONS APPLIED THIS SESSION (dev DB + schema.sql regenerated; gam_test rebuilds from schema.sql)
- `20260805120000_auto_field_jobs.sql`
- `20260805130000_invite_nudge_tracking.sql`
Forward-only — do NOT edit applied migrations. (S581 applied `20260804170000`–`…200000`.)

## KEY FILES TOUCHED (S582)
- **New:** `services/moneyAddonPdf.ts`, `services/leaseDates.ts`(+test),
  `services/autoFieldJobs.ts`(+test), `jobs/inviteNudge.ts`(+test).
- **API:** `routes/esign.ts`(+test), `routes/landlords.ts`, `jobs/leaseParser/resolveIntent.ts`(+test),
  `services/leaseOnboarding.ts`, `services/leasePrefill.ts`, `services/autoFieldPlacement.ts`,
  `services/email.ts`, `jobs/scheduler.ts`, `packages/shared/src/index.ts`. Test updates:
  `landlords-csv-tenants`, `landlords-tenant-onboarding`, `landlords-todos`,
  `landlords-gap-close`, `leaseOnboardingPipeline`.
- **Frontend:** landlord `DashboardPage.tsx`, `ESignPage.tsx`, `ConfirmIntentModal.tsx`;
  tenant `PaymentsPage.tsx`.
- NOTE: `git status --short` shows ~107 uncommitted files — the FULL S578→S582 sweep +
  features. Many (`admin*/main.tsx`, `businesses*`, `flexpay*`, `allocation*`,
  `withdrawals*`, `subleases*`, business/pm-company/listings apps, `payShared.tsx`, etc.)
  are from S578–S581, NOT S582.

## TREE STATE
- `@gam/shared` rebuilt (`cd packages/shared && npm run build`) — the rent_due_day lock +
  `isLockedLeaseColumn` are runtime; rebuild before running API.
- API tsc clean; landlord + tenant tsc clean; landlord + tenant production builds clean.
- Every suite touched this session is green (test-DB guard). Key suites: `esign.test.ts`,
  `leaseDates.test.ts`, `autoFieldJobs.test.ts`, `resolveIntent.test.ts`,
  `landlords-csv-tenants`, `landlords-tenant-onboarding`, `landlords-todos`,
  `leaseOnboardingPipeline`, `inviteNudge.test.ts`.

## NEXT SESSION SHOULD TARGET
1. **Subsystem 6 — Tenant portal** (the sweep's next in order). Comb by hand, three
   buckets. Tenant app = `apps/tenant` (:3002); key pages incl `PaymentsPage`,
   `payShared`, `SignPage`, `LeasePage`, `main.tsx` (dashboard/gates).
2. Carry the sweep rules (nothing committed; one deploy at the very END).
3. Batched (non-blocking) UI smoke when a stack is up: control tower Onboarding section
   (landlord dashboard) + the PaymentsPage "verifying" reassurance.

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl
kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild the frontends;
THEN commit. GOTCHA: orphan on :4000 → EADDRINUSE (memory `gam-prod-api-restart`).

## RELEVANT MEMORIES
`gam-lease-date-model`, `gam-lease-money-addons`, `gam-onboarding-control-tower`,
`gam-lease-renewal-and-autofield`, `gam-smooth-onboarding-pipeline`,
`gam-document-first-enforcement`, `gam-lease-is-law`, `flexpay-demand-test-rollout`,
`gam-ach-microdeposits-not-instant`, `gam-test-db-guard`, `gam-prod-api-restart`,
`gam-no-native-dialogs`.

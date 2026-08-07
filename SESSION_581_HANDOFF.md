# SESSION 581 HANDOFF — Pre-onboarding sweep: Subsystem 3 complete + Subsystem 4 (mostly) + money add-ons built

> Continues the S578→S580 pre-onboarding sweep (24 subsystems, walked in order).
> This session finished **Subsystem 3 (rent invoicing + late fees)**, swept most of
> **Subsystem 4 (leases + e-sign)** (5 bugs fixed, lots verified), corrected 3 stale
> money tests, and — off a Subsystem-4 finding — **built a new money-add-on feature**
> (recurring charge / rent change via addendum that reaches billing on a date).
> **Nothing is committed** — the sweep rule is ONE deploy at the very end.

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory.** Trace real paths end-to-end. Flag design questions;
   don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way** (build for scale, no bolt-ons).
   Update tests. Keep tree green (tsc + affected suites).
5. **NO FAN-OUT / NO PARALLEL agents (Nic, S581 — emphatic).** Comb ONE thing at a
   time by hand. Parallelizing "misses things." Do NOT use the Workflow tool for this
   sweep even if an ultracode reminder suggests it — Nic's instruction overrides it.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
   NEVER from repo root / without DB_NAME=gam_test (wipes the dev `gam` DB).
7. Report three buckets per subsystem: **(A)** confirmed bugs w/ repro, **(B)** design
   questions / notes, **(C)** verified-good (so Nic knows it was actually checked).
8. Communication: plain English to Nic, NOT code jargon (he has no coding background).

## Progress map
| # | Subsystem | Status |
|---|-----------|--------|
| 1 | Auth (login/2FA/sessions) | ✅ S578/S579 |
| 2 | Stripe money-flow | ✅ S580 |
| 3 | **Rent invoicing + late fees** | ✅ **THIS SESSION** |
| 4 | **Leases + e-sign** | 🟨 **THIS SESSION — 5 bugs fixed + most verified; ONE comb area left (onboarding/auto-field) + money-add-on PDF-print** |
| 5 | Onboarding | 🟨 largely covered by S579; residual overlaps Subsystem 4's onboarding comb |
| 6 | Tenant portal | ⬜ |
| 7 | Landlord core | ⬜ |
| 8 | FlexSuite | 🟨 FlexPay done (S578) + single-lease gate (S581); FlexDeposit/Charge/Credit not swept |
| 9 | Maintenance | ⬜ |
| 10 | Inspections | ⬜ |
| 11 | Utilities/RUBS | ⬜ |
| 12 | Documents/storage | ⬜ |
| 13 | Screening/background | ✅ built S579 |
| 14 | POS | ⬜ |
| 15 | Business platform | 🟨 login/signup 2FA (S578) |
| 16 | Storefront + public booking | ⬜ |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA (S578) |
| 19 | PM companies | 🟨 login 2FA (S578) |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ (note: S581 added ONE cron — scheduled-lease-changes 4:30am — verify it in the sweep) |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## SUBSYSTEM 3 — Rent invoicing + late fees — ✅ COMPLETE (this session)

### (A) Confirmed bugs — FIXED
1. **Move-in month double-billed when `rent_due_day > 1`** (`jobs/invoiceGeneration.ts`
   ~line 295). The move-in invoice prorates rent for the ENTIRE start calendar month,
   but daily-gen skipped only the due date exactly equal to `start_date`. A lease with
   a mid-month `rent_due_day` billed the first month TWICE (double deposit + double
   first rent). **Fix:** skip the WHOLE start month (`d.slice(0,7) !== startMonth`).
   Confined to e-signed leases with a mid-month due day (imported=`needs_review`,
   booking/imported default day 1). Test: `jobs/invoiceMoveInMonth.test.ts` (new, 3
   tests; verified fails-without-fix). Booking-lease + due_day=1 paths unchanged.
2. **Percent-of-rent late fee based on the wrong number** (`jobs/lateFees.ts` ~214).
   `SELECT amount … type='rent' LIMIT 1` picked ONE rent row arbitrarily — when rent
   was split by a partial credit (settled slice + remainder) it could pick the
   already-paid slice, under-basing the fee. **Fix (Nic — Option A "% of full rent"):**
   `SUM(amount) … WHERE status IN ('pending','processing','settled')` = the live full
   rent, correct across credit-splits and reversal reopens without double-counting.
3. **Per-lease pay-balance + "Pay all"** (`routes/payments.ts` `/pay-balance` +
   `/balance-context`; tenant `PaymentsPage.tsx`, `payShared.tsx`). Was one lump charge
   for ALL of a tenant's leases → one landlord. Nic: **each lease = its own ACH/card
   charge + receipt + capped fee** (partial-success beats all-or-nothing; per-lease
   capped fee closes a shared-bank-account scam + revenue leak; independent eviction
   holds across landlords). Added optional `leaseId` to `/pay-balance`; `/balance-context`
   returns per-lease `leases[]`. UI: one Pay card per lease + a "Pay all" button that
   shows ONLY with 2+ payable leases (one method → separate charge per lease). Money was
   already routing correctly per-lease under platform-holds — the fix was separate
   charges/receipts/fees. Tests in `routes/s537-payment-fifo.test.ts` (+3). Memory:
   `gam-pay-balance-per-lease`.
4. **FlexPay single-lease-only gate** (Nic — no exceptions). `services/flexpay.ts`
   `getFlexPayEligibility` adds a `multiple_leases` blocker (a tenant on 2+ active
   leases can never enroll); the advance cron excludes multi-lease tenants (was
   silently dropping one lease's front). `/tenants/me` exposes `flexpay_paused_multi_lease`;
   tenant Flex Advantage card + home dashboard row show "⏸ Paused." Tests:
   `services/flexpay.test.ts` (+1), `routes/tenants-profile-dashboard.test.ts` (+1).
   Memory: `flexsuite-product-rules` (updated), `gam-pay-balance-per-lease`.

### (C) Verified-good
Invoice idempotency (`ux_invoices_lease_due_date` + `ux_payments_rent_idempotent`,
per-lease try/catch isolation); late-fee engine (grace gate, retroactive anchors, cap
w/ cap-edge partial, `ux_payments_late_fee_idempotent`, reopen back-fill); pay-in-full
enforcement + FIFO; move-in proration; deposit-return unpaid-sweep; `properties.timezone`
is `NOT NULL DEFAULT 'America/Phoenix'` so the per-tz cron can't strand a lease; only the
per-tz invoice engine is scheduled (no double-run).

---

## SUBSYSTEM 4 — Leases + e-sign — 🟨 MOSTLY SWEPT (this session)

### (A) Confirmed bugs — FIXED
1. **E-sign finalization could build a lease TWICE** (`routes/esign.ts`
   `buildLeaseFromDocument` ~405). Completion is detected POST-commit with a
   check-then-act COUNT, and the lease INSERT has NO DB backstop → a duplicate/racing
   final signature (double-click, tied-order co-tenants) built a 2nd lease + move-in
   invoice (double deposit + double first rent + double PM fee). **Fix:** per-document
   `pg_advisory_xact_lock` + a uniform `finalized_at` guard (all doc types) — migration
   `20260804170000_lease_document_finalized_at.sql`. `buildLeaseFromDocument` now
   returns `alreadyBuilt`; Phase C skips side-effects on a deduped call. Tests in
   `routes/esign.test.ts` (+2, verified fails-without-fix). **buildLeaseFromDocument is
   now exported** for the test.
2. **Sublease markup leak under platform-holds** (`services/allocation.ts`,
   `routes/payments.ts`, `services/subleaseAllocation.ts`). The sublessor's markup was
   diverted via the now-dead `application_fee_amount` (S560 killed it) — so the landlord
   got the FULL sub amount AND the sublessor got the markup → GAM ate it every marked-up
   sublease payment. **Fix:** stamp `sublease_markup_amount` on the payment (migration
   `20260804180000`), subtract it in allocation so the landlord nets `master_share`;
   the sublessor is credited the same immutable amount (sub_monthly − master_share never
   changes post-creation). Test: `services/allocation.test.ts` (+1, verified
   fails-without-fix); the 12 existing sublessor-credit tests still green.
3. **Terminated-sublease resurrection via invite-accept** (`routes/subleaseInvitations.ts`,
   `routes/subleases.ts`). The accept flip had no status guard, and terminate never
   cancelled the invitation → an invitee could accept a terminated sublease, flip it
   back to `pending`, and create a real tenant account. **Fix:** accept guards on
   `status='pending_invite'` (rolls back the whole signup if dead); terminate cancels
   the linked `sent` invitation. Test: `routes/subleaseInvitations.test.ts` (+1,
   verified fails-without-fix).

### (B) Design question → became the money-add-on feature (see next section)
`executeAddendumTerms` was **record-only** (no lease mutation). Nic confirmed addendums
DO carry money (optional recurring charges like parking; mobile-home space-rent
increases). Built out — see "MONEY ADD-ONS" below.

### (C) Verified-good (traced, correct — no changes)
- Signer state machine (`POST /sign/:documentId`): strict signing order, landlord-first,
  server-side required-field validation, field-spoof guards, landlord-terms-locked-before-tenant.
- Renewal / non-renewal binding: landlord non-renewal + tenant "no" only disarm auto_renew
  (no early termination — tenant liable through `end_date`); lease-end processor
  (`jobs/scheduler.ts:processLeaseEnds`) expires ONLY at `end_date`, auto-renew genuinely
  retired, hands off only to a signed successor.
- Deposit carry-forward on renewal: same `security_deposits` row rebound (interest clock
  continuous), no re-bill, top-up not double-counted.
- `bill-fee` / lease-is-law: amount comes from the signed lease's `lease_fees` row (client
  sends a row id, never an amount); only `due_timing='other'` billable.
- Sublessor credit accrual + withdrawal: idempotent (`sublease_credit_applied` + FOR UPDATE),
  Transfer-then-commit.
- Sublease create/decision/terminate: tenant-only create with BOTH subleasing toggles gated,
  perm-gated decision with `status='pending'` guard, party-authorized terminate.
- Deposit derivation: `deposit = rent × template.deposit_months` (`services/depositPolicy.ts`,
  `leasePrefill.ts`) — only fills blanks, NEVER invents a deposit when no multiplier.
- Addendum **add**/**remove** executes: thorough precondition re-validation, correct
  remove-primary-then-promote ordering, naturally idempotent (+ finalized_at guard).

---

## NEW FEATURE — MONEY ADD-ONS (built this session; one piece left)

**What:** a terms addendum can carry a MONEY change that reaches billing on a
landlord-set effective date. Two modes (landlord picks per add-on, per their local law —
GAM never decides by state):
- **agreement** — tenant opts in + SIGNS (parking, garage).
- **notice** — landlord issues; NO tenant signature (e.g. AZ mobile-home space-rent
  increase). Tenant gets a BLOCKING portal pop-up to Acknowledge; viewed_at +
  acknowledged_at captured as proof of notice.

**Change kinds:** `rent` (updates `leases.rent_amount` on the date) · `recurring_fee`
(inserts a `monthly_ongoing` `lease_fees` row on the date — feeType must be a recurring
lease_fees enum). **Rent increase does NOT top up the deposit** (Nic — prior decision, stands).

**How it applies:** a nightly cron (`jobs/scheduler.ts`, 04:30, before the 07:00 invoice
run) applies due `scheduled` changes → existing billing picks up the new rent/fee with NO
billing-code change.

**BUILT + TESTED (backend all green; both frontends typecheck + build):**
- Migrations: `20260804190000_scheduled_lease_changes.sql`,
  `20260804200000_addendum_notice_mode.sql` (adds `lease_documents.delivery_mode` +
  `lease_notices` table).
- `services/scheduledLeaseChanges.ts` (NEW): createDraftScheduledChange / activate
  (on completion) / cancel (on void) / **applyDueScheduledChanges** (cron) /
  createLeaseNoticesForDocument. Test: `services/scheduledLeaseChanges.test.ts` (8 tests).
- `routes/esign.ts`:
  - `POST /documents/addendum-terms` now takes `mode` + `scheduledChanges`, and
    **AUTO-RESOLVES signers** from the lease (landlord + tenants for agreement, landlord-
    only for notice) when `signers` omitted. Notice mode skips the all-tenants-sign rule.
  - `executeAddendumTerms` now activates the scheduled changes + (notice) creates tenant
    lease_notices.
  - void handler cancels the addendum's pending changes.
- `routes/tenants.ts`: `GET /tenants/lease-notices` (marks viewed) + `POST
  /tenants/lease-notices/:id/acknowledge`.
- Landlord UI: `MoneyAddonModal` on `pages/LeasesPage.tsx` — a per-lease "Add-on / rent
  change" button (mode + change type + amount + effective date → creates addendum + sends).
- Tenant UI: `LeaseNoticeGate` blocking pop-up in `apps/tenant/src/main.tsx` (rendered in
  the shell alongside `FlexsuiteReAcceptanceGate`; NOT dismissible — only Acknowledge closes).
- Memory: `gam-lease-money-addons`.

**⚠️ STILL TODO (scoped, NOT built) — do first next session:**
1. **Document-first PRINTING of the money term onto the signed addendum PDF.** Right now
   the change is attached behind the scenes but not auto-rendered into the PDF the tenant
   signs. Matters for **agreement** mode (violates `gam-document-first-enforcement` until
   done). **Notice** mode is effectively covered — the tenant sees the exact change in the
   acknowledge pop-up and we record they saw it. This hooks into the e-sign field/PDF
   rendering pipeline (`services/leasePdf.ts` / `stampPdf` + `lease_document_fields`) —
   real work, needs its own focused pass.
2. **Live/preview visual verification of both new screens** (MoneyAddonModal +
   LeaseNoticeGate) — batched UI smoke; requires a running stack + fabricated state.

---

## DETOUR — 3 stale money tests corrected (`routes/moneyTriplet.test.ts`)
Nic asked me to check 3 red tests I flagged. **All 3 were stale tests, NOT bugs** — the
S580 instant-withdrawal rebuild + S567 portfolio-manager scoping changed the intended
behavior and the tests weren't updated:
- withdrawal preview net `45.06`→`45`, instant net `95.05`→`95` (S580 "no pre-pull": pay
  net = available − fee; margin recorded owed, not transferred at withdrawal).
- "admin sees all disbursements" → rewritten to S567 scoping (a regular admin sees only
  landlords they manage; only super_admin sees all — that test already passed).
The code was correct; the tests now match it.

---

## READY FOR NEXT SESSION (scoped, ready to build/comb)
1. **Money-add-on PDF printing** (agreement mode) — see the feature section above.
2. **Subsystem 4 last comb area: onboarding + auto-field PDF placement.** Files:
   `services/leaseOnboarding.ts`, the paper-import vs new-lease e-sign flows
   (`routes/landlords.ts` CSV import + invite→draft), occupancy modes (whole_unit/by_room),
   and the auto-field placement feature (spec `~/gam/AUTO_FIELD_PLACEMENT_SPEC.md` —
   auto-placing e-sign boxes onto an uploaded lease PDF: coordinate mapping correctness,
   detection-failure handling, guaranteed placement of required fields). CHECK against
   memories `gam-smooth-onboarding-pipeline`, `gam-lease-renewal-and-autofield`.

## NOT YET SCOPED (remaining sweep)
Subsystems 6, 7, 9–12, 14, 16, 17, 20–24 fully unswept; 5/8/15/18/19/21 partially. Continue
in order after Subsystem 4 closes. NOTE: Subsystem 21 (crons) must verify the NEW
scheduled-lease-changes cron's idempotency (it's already tested, but re-verify in context).

---

## KEY CONTEXT
- **Uncommitted work this session (S581)** — all of the above. Key modified: `esign.ts`,
  `payments.ts`, `allocation.ts`, `subleaseAllocation.ts`, `subleaseInvitations.ts`,
  `subleases.ts`, `flexpay.ts`, `lateFees.ts`, `invoiceGeneration.ts`, `scheduler.ts`,
  `tenants.ts`, landlord `LeasesPage.tsx`, tenant `main.tsx` + `PaymentsPage.tsx` +
  `payShared.tsx`. New: `services/scheduledLeaseChanges.ts` + its test,
  `jobs/invoiceMoveInMonth.test.ts`. (Earlier-session uncommitted work also present —
  S578/579/580 screening/money-flow — `git status --short` for the full picture. Some
  modified files like `admin*/main.tsx`, `listings/main.tsx`, a few `*.test.ts` are from
  those prior sessions, not S581.)
- **Migrations applied this session (dev DB + schema.sql regenerated; gam_test rebuilds
  from schema.sql):** `20260804170000` (lease_document finalized_at), `…180000` (payments
  sublease_markup_amount), `…190000` (scheduled_lease_changes), `…200000` (addendum notice
  mode + lease_notices + delivery_mode). Forward-only — do NOT edit applied migrations.
- **Test guard:** `cd apps/api && DB_NAME=gam_test npx vitest run src/…` — NEVER without it.
- **Tree state:** every suite touched this session is green; API + landlord + tenant tsc
  clean; landlord + tenant production builds clean. (Aggregate this session: 250+ tests
  across the touched suites.)
- **FINAL deploy at sweep end (NOT now):** `cd apps/api && npm run build && launchctl
  kickstart -k gui/$(id -u)/com.gam.api`, verify :4000 + a login, THEN commit. GOTCHA:
  orphan on :4000 → EADDRINUSE (memory `gam-prod-api-restart`).
- **Relevant memories:** `gam-pay-balance-per-lease`, `gam-lease-money-addons`,
  `flexsuite-product-rules`, `gam-lease-is-law`, `gam-document-first-enforcement`,
  `gam-auto-renew-retired-binding-nonrenewal`, `gam-lease-renewal-and-autofield`,
  `gam-smooth-onboarding-pipeline`, `gam-money-flow-platform-holds`, `gam-test-db-guard`,
  `gam-prod-api-restart`, `gam-no-native-dialogs`, `gam-button-color-rule`.

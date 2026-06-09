# Session 331 — closed

## Theme

First test coverage on the S314→S330 acceptance + FlexDeposit
eligibility subsystems. 26 new Vitest cases (15 eligibility +
11 acceptance) land regression protection on the SLA-not-loan
structural defense chain.

Full suite: **264 tests across 21 files, all passing**.

## Items shipped

### Test files

**`apps/api/src/services/flexDeposit.test.ts`** (NEW, 15 tests)
covers `getFlexDepositEligibility`:

Pre-S330 blockers:
- `tenant_not_found` for non-existent tenant id
- `ach_unverified`
- `bg_not_approved` for `not_started` default status
- `bg_not_approved` for `submitted` (in-progress) status
- `risk_level_missing` (BG approved but no risk_level)
- `tenant_suspended_nsf` with future disqualification timestamp
- `no_deposit_row`

S330 new blockers:
- `insufficient_platform_tenure` (tenant created < 30 days ago)
- Tenure passes (tenant > 30 days)
- `prior_flexdeposit_default` (permanent)

S330 on-time payment history:
- First-lease-ever exempt → eligible despite zero on-time history
- Has prior lease + zero on-time payments → blocked
- Has prior lease + 1 on-time payment in 90d → eligible
- On-time payment OUTSIDE 90d window → still blocked

Happy path:
- All checks pass + `max_installments` returned + `deposit_amount`
  + `risk_level` populated

**`apps/api/src/services/flexsuiteAcceptance.test.ts`** (NEW,
11 tests) covers the audit chain + re-acceptance flow:

`recordAcceptance`:
- Row insertion + sha256 hash on rendered_text (verified by
  hashing the test input independently and comparing)

`getPendingReAcceptances`:
- Empty for tenant with no enrollments
- Returns FlexPay pending when enrolled + no acceptance row
  (`currentVersion: '(none)'` — pre-S314 enrollment case)
- Empty when enrolled + latest acceptance at current version
- Returns pending when latest acceptance at OLD version
- Returns FlexDeposit pending when active plan + no acceptance

`renderReAcceptanceTerms`:
- FlexPay text renders with tenant's current pullDay + fee
- FlexDeposit text renders with persisted installment schedule
- Throws 409 when product is flexpay but tenant not enrolled

`commitReAcceptance`:
- Writes new acceptance row at current template version
- Clears the pending re-acceptance for that product after commit

### Test infra additions

**`apps/api/src/test/dbHelpers.ts`** — `cleanupAllSchema()` now
wipes `flexsuite_enrollment_acceptances`, `flex_deposit_installments`,
and `background_checks` (the latter FKs to tenants + landlords; was
silently blocking cleanup of any test that seeded BG rows).

### Bug fix discovered + landed

**`apps/api/src/services/flexsuitePdf.ts`** — `sanitizeForWinAnsi`
extended with `→` (right arrow), `←` (left arrow), and `✓`
(checkmark). The PDF renderer was throwing on `→` because the
re-acceptance UI / SLA copy contains "Read full terms →" and
Helvetica's WinAnsi encoding doesn't support those chars. Was
caught only because the post-commit email path fires through
`renderAcceptancePdf` in test, surfacing the error in logs (best-
effort .catch() prevents test failure but the email never sends
for real users). Now sanitized like the other unicode chars from
S322.

## Files touched (S331)

```
apps/api/src/services/
  flexDeposit.test.ts                      (NEW; 15 tests)
  flexsuiteAcceptance.test.ts              (NEW; 11 tests)
  flexsuitePdf.ts                          (3 chars added to
                                            sanitizer)

apps/api/src/test/
  dbHelpers.ts                             (3 tables added to
                                            cleanupAllSchema)

SESSION_331_HANDOFF.md                     (this file)
```

No production code changes besides the PDF sanitizer fix. No
schema changes. No new migrations.

## Decisions made during build

| Question | Decision |
|---|---|
| Use withRollback or cleanupAllSchema? | **cleanupAllSchema.** Both `getFlexDepositEligibility` and `commitReAcceptance` go through the singleton pool — they don't see the test's BEGIN/ROLLBACK on a separate client. Pattern matches `depositReturn.test.ts`. |
| Test the dispute-resolve corrected-event path (S325 regression)? | **Deferred.** Requires the full credit-dispute lifecycle setup (open dispute → submit evidence → admin resolve corrected). Significant test infra around credit_disputes + credit_subjects + credit_events. Best done as its own dedicated session on credit-ledger test coverage. |
| `no_bg_result` blocker test — keep? | **Replaced with `bg_not_approved` for `not_started`.** Recon found `tenants.background_check_status` has a NOT NULL CHECK constraint that disallows the values the original `no_bg_result` path triggers on. The blocker is now historically reachable; the actual test case uses the `not_started` default which goes through `bg_not_approved`. Documented inline. |
| Compare `suspended_until` string to Date object? | **Convert via `new Date().toISOString()`** at the assert site. The pg driver returns timestamps as Date objects; the function passes them through. Out-of-scope to refactor the function's return type for this test. |
| Patch the PDF sanitizer when surfaced via test? | **Yes.** Three chars (`→`, `←`, `✓`) added in the same session — fix-it-right, since the test surfaced a real production bug (the email-with-PDF path never sends for re-acceptance because the arrow in "Read full terms →" trips Helvetica). |

## Verification

- `npx tsc --noEmit` on `apps/api`: clean.
- `npm test` on `apps/api`: **264 tests passed, 21 files, no
  failures**. Duration ~127s.
- The 26 new tests (15 + 11) integrate cleanly with the existing
  21-file suite. No flakiness on three runs.

## Items deferred — what S332 could target

### A. Credit-ledger dispute-resolve test coverage

Specifically the corrected-event path that S325 found broken
(mixed-casing bug between `correctedEvent`/`subject_type`).
Requires setting up the full dispute lifecycle in fixtures.

### B. POS request-body migration

Offline-sync queue care. Persisted IndexedDB payloads.

### C. Unicode-capable font in flexsuitePdf

Removes the now-10-char sanitizer entirely. ~300KB bundle add.

### D. Remaining long-tail S312 reads (tenant Maintenance,
Disbursements, Documents, Reports)

The S327 scan flagged these but they haven't been migrated yet.

### E. flexsuitePdf test coverage

The sanitizer + page-break + footer-on-every-page logic has
zero tests. Surface bug from this session (arrow char) would
have been caught earlier.

## Items deferred (cross-session docket)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- FlexCharge Business Account Agreement signature capture
  (S309 option B — not a launch feature).
- Standalone POS-operator auth (S309 option D).
- Deposit-return ↔ unpaid-installment offset architecture
  call (S310 carryover).
- SchedulePage booking-vs-lease shape audit.
- POS request-body migration.
- Embed Unicode-capable font in flexsuitePdf.
- Credit-ledger dispute-resolve test coverage (S325 fix
  regression protection).
- flexsuitePdf rendering test coverage.
- Remaining long-tail S312-class reads on tenant pages.
- Nic-visual-review of the reconstructed
  PmInvitationsPage.tsx (S329 regression).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing call.
- Visual review of reconstructed PmInvitationsPage.

## What S332 should target

Test coverage thread can continue with **A** (credit-ledger
dispute lifecycle) or **E** (flexsuitePdf renderer). Real
product remaining: **D** (tenant long-tail) or **B** (POS).

---

End of S331 handoff. Closed clean. First regression-protection
tests on the SLA-not-loan structural-defense chain landed.

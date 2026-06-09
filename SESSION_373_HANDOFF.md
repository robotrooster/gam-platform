# Session 373 — closed (admin.ts arc truly complete, 42/42)

## Theme

Audit-driven gap-closer for admin.ts before pivoting to
tenants.ts. S372 closed the arc claiming 41 routes
covered, but a real audit of the file's 42 routes found
4 uncovered. Nic flagged the readiness question
("anything left for admin before doing tenants?") — that
question forced the audit and surfaced the gaps.

The 4 gaps:
- **GET /admin/property-flags** (list) — S362 covered the
  POST /resolve but missed the GET
- **PATCH /admin/landlords/:id/otp-rollout** — super_admin
  OTP rollout toggle, never tested
- **POST /admin/platform-review-statuses/.../unverify** —
  S368 explicitly skipped as "same shape as verify"
- **GET /admin/platform-claims/promoted** — S368 explicitly
  skipped as "straightforward SELECT"

The two explicit skips (S368) were yield-optimization
calls that don't align with the thoroughness framing.
Closing them now keeps admin.ts at 42/42.

The slice surfaced **0 production bugs**. 6 new test
cases pin the gaps.

Suite at S372 close: **1081 / 61 files**.
Suite at S373 close: **1087 / 62 files** (+6 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Test coverage — 6 cases / 4 describe blocks

New file: `apps/api/src/routes/admin-arc-gaps.test.ts`

**GET /admin/property-flags (2)**
- Default `status=pending`: returns unresolved flags only
  (resolved excluded); multi-table JOIN columns
  (new_landlord_email + orig_landlord_email) present in
  response
- `?status=resolved`: returns resolved flags only; the
  `resolution` field reflects the prior /resolve action

**PATCH /admin/landlords/:id/otp-rollout (2)**
- Plain admin → 403 (super_admin gate); flag unchanged
- super_admin happy: flips `landlords.otp_rollout_enabled`
  to true

**POST /admin/platform-review-statuses/.../unverify (1)**
- Pre-verify the slot, then unverify: mapping_status
  flips back to 'unverified', verified_at + verified_by
  cleared to NULL, notes from body persisted; audit log
  row written with `action_type='platform_review_status.
  unverify'` (verifies the S368 F1 fix is also healing
  this route — same pattern, same fix)

**GET /admin/platform-claims/promoted (1)**
- Returns previously-promoted claim names; ordered by
  promoted_at DESC; promoter info joined from users
  (promoter_first_name); example_raw_name present

### Test infra additions

None — all required tables already in cleanup.

## Files touched

```
apps/api/src/routes/
  admin-arc-gaps.test.ts   (NEW — 195 lines, 6 cases)
```

No production code touched. No migrations. No schema
changes. No cleanup helper changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Trust the S372 "arc complete" claim or audit? | **Audit.** Nic's question ("anything left for admin?") was the right prompt. Counting routes (42) against handoff claims (41) surfaced the discrepancy in one grep. Worth treating arc-closure declarations as requiring an explicit route-count verification, not just per-slice handoff math. |
| The two explicit S368 skips ("same shape as verify", "straightforward SELECT") — re-test them or accept the prior call? | **Re-test.** The skips were yield-optimization calls. The thoroughness framing (memory: `feedback_finish_arcs_before_pivoting`) extends to within-arc skip decisions, not just file-pivoting. "Same shape as verify" stops being a valid skip when arc coverage = number of routes is the goal. |
| Pin the audit_log write on /unverify too? | **Yes.** It's the same logAdminAction pattern S368 fixed; verifying it writes correctly here is the regression pin for the entire fix class. |
| Combine the 4 routes into fewer tests (e.g., parametrize)? | **No — separate describes.** Each route's contract is distinct enough that combined assertions would hurt readability. 6 small tests is fine. |
| Add an `admin.ts route coverage check` test that asserts 42 == # tested? | **No — not the right shape for the test suite.** This is the kind of check that belongs in a CI lint or handoff-template requirement, not a runtime test. Noted as future hardening. |
| Update the S372 handoff to reflect "actually 38/42 covered, not 41/41"? | **No — write a new handoff (S373) reflecting the truth.** Editing past handoffs revises history; better to acknowledge the miss in the new handoff. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1087 tests across 62 files, 0
  failures**, ~610s.
- 6 new test cases (`admin-arc-gaps.test.ts`).
- 0 production bug fixes.
- 0 production regressions.

No frontend touched, no shared-package touched.

## admin.ts arc — TRULY complete after S373

42/42 routes covered across 7 slices (S362 + S368-S373).

| S | Slice | Routes | Cases | Bugs |
|---|---|---|---|---|
| 362 | overview + flags POST + features + notifications | 9 | 12 | 0 |
| 368 | CSV review queue + platform claims | 11 | 13 | **1** |
| 369 | bulletin + income + landlord onboarding detail | 6 | 11 | 0 |
| 370 | audit-log + backfill + email-fail + NACHA | 4 | 10 | **1** |
| 371 | deposit-portability + connect-readiness + nudges | 6 | 11 | 0 |
| 372 | OTP/FlexCharge retry + tenant detail + acceptances + resend | 5 | 8 | 0 |
| **373** | **gap-closer: flags GET + otp-rollout + unverify + promoted GET** | **4** | **6** | **0** |
| **TOTAL** | **7 slices, 42 routes** | | **71 tests** | **2 bugs** |

## Items deferred — what S374 could target

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Nic obtained Checkr Partner credentials
2026-05-26. The next fresh-context session starts with
wiring `background.ts` to live Checkr.

### Next arc candidates (admin.ts truly done)

```
tenants.ts               1326  NO TESTS  ← largest remaining unwalked
books.ts                 1330  NO TESTS
background.ts            1065  NO TESTS  ← Checkr-blocked, see memory
credit.ts                 839  NO TESTS
reports.ts                489  NO TESTS
payments.ts               429  NO TESTS
utility.ts                387  NO TESTS
workTrade.ts              331  NO TESTS
stripe.ts                 279  NO TESTS
subleaseInvitations.ts    269  NO TESTS
bulletin.ts               261  NO TESTS
posCustomerOnboarding.ts  253  NO TESTS
fitness.ts                215  NO TESTS
withdrawals.ts            181  NO TESTS
finances.ts               138  NO TESTS
bankAccounts.ts           129  NO TESTS
notifications.ts           84  NO TESTS
terminal.ts                66  NO TESTS
disbursements.ts           45  NO TESTS
documents.ts               32  NO TESTS
announcements.ts           20  NO TESTS
```

Recommended next: **tenants.ts** (1326 lines, largest
unwalked, mirrors the landlords.ts arc shape).

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged

- **action.url scheme validation in adminNotifications**
- **logAdminAction targetId-uuid audit** (codebase-wide
  hygiene pass)
- **silent-failure pattern audit** (try/catch swallow
  class)
- **schema-drift audit** — S355/S360/S370 instances
- **NEW S373:** **arc-completeness verification at close
  time** — route-count audit should be part of every
  arc-closing handoff, not just per-slice math

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S372.)

## Items deferred (cross-session docket, post-S373)

- Consumer-side retention framing decision (S300) — Nic-pending
- Campground Master import path — Nic-blocked on sample
- 2FA fan-out — walkthrough-blocked
- Yardi GL-export columns, Rentec template (S293) — vendor-blocked
- FlexCharge Business Account Agreement signature capture (S309 option B)
- FlexDeposit eligibility-check workflow (S309 option C)
- Standalone POS-operator auth (S309 option D)
- Deposit-return ↔ unpaid-installment offset architecture call — Nic-pending
- SchedulePage booking-vs-lease shape audit — walkthrough-blocked
- Embed Unicode-capable font in flexsuitePdf — open architectural pick
- Credit-score formula + recompute test coverage — locked v1.0.0
- Visual review of reconstructed PmInvitationsPage — walkthrough-blocked
- posTerminal service tests (Stripe-boundary, low marginal yield)
- action.url scheme validation (defense-in-depth, no live risk)
- pm.ts remaining slices: property invitations / Connect / payouts / drilldown
- units.ts remaining: /:id/economics / /:id/eviction-mode (walkthrough-blocked)
- properties.ts remaining: units/bulk + photos + listings + apply + applications
- ~~admin.ts remaining~~ — **ARC TRULY COMPLETE S373 (42/42)**
- logAdminAction targetId-uuid audit (codebase-wide hygiene pass)
- silent-failure pattern audit (try/catch swallow class)
- schema-drift audit on admin.ts SQL columns
- arc-completeness verification at close time (process hardening)
- **NEXT FRESH-CONTEXT SESSION:** Wire background.ts → Checkr API (credentials in hand 2026-05-26)

## Nic-pending (unchanged minus Checkr)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- ~~Checkr Partner credentials~~ — UNBLOCKED 2026-05-26
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S374 should target

**S374 should open the tenants.ts arc.** Largest
remaining unwalked file (1326 lines). Multi-session arc.
Pick a well-bounded first slice (profile + dashboard or
similar tenant-portal data surface).

If clearing for fresh context: per memory note, start
S374 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S373 handoff. **admin.ts arc truly complete (42/42
routes across 7 slices).** 1087 tests / 62 files / 0
failures. Cumulative sweep so far: ~346 route-level
tests, 18 production bugs caught. Process note: arc-
closure declarations need route-count verification, not
just handoff math.

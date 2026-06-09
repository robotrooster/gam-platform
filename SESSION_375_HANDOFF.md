# Session 375 — closed

## Theme

tenants.ts arc continues. **Slice 2 of N:** FlexCharge +
FlexPay + FlexDeposit + FlexSuite re-acceptance + deposit
portability (13 routes — full tenant-side Flex surface).

The slice surfaced **0 production bugs**. All Flex routes
delegate to services with consistent gate-then-call shape;
the validation guards held under probe.

16 new test cases pin the slice.

Suite at S374 close: **1099 / 63 files**.
Suite at S375 close: **1115 / 64 files** (+16 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Test coverage — 16 cases / 5 describe blocks

New file: `apps/api/src/routes/tenants-flex.test.ts`

**FlexCharge — GET + dispute (2)**
- GET /flexcharge visible=false → `{visible: false}`;
  service NOT called
- POST /flexcharge/dispute/:txId: reason < 3 chars → 400;
  happy passes `{transactionId, disputerTenantId, reason}`
  to service

**FlexPay — GET + enroll + terms + DELETE (5)**
- GET visible=false → `{visible: false}`
- GET happy: returns enrollment row + eligibility +
  `previewFee` derived from calculateFlexPayFee(pullDay)
- POST /enroll service ok:false → 400 with reason; happy
  passes through with acceptanceId
- GET /terms pullDay out of range → 400 "1..28"; happy
  returns version + fee + renderedText
- DELETE calls cancelFlexPay(tenantId)

**FlexSuite re-acceptance — status + accept (2)**
- GET /status returns pending array
- POST /re-accept: invalid product → 400; missing
  acceptedTerms → 400; happy returns acceptanceId

**FlexDeposit — GET + enroll + terms + retry (4)**
- GET visible=false → `{visible: false}`
- GET happy: returns eligibility + installments plan +
  deposit context (seeded full landlord/property/unit/
  lease/deposit chain with flex_deposit_enabled=TRUE)
- POST /enroll service ok:false → 400; happy returns
  plan + acceptanceId
- GET /terms installmentCount out of range → 400 "2..4";
  happy returns rendered SLA
- POST /retry-acceleration service ok:false → 400; happy
  passes through

**Deposit portability — eligibility + authorize (2)**
- GET /eligibility missing leaseId → 400; happy passes
  `{leaseId, tenantId}` to detectPortabilityEligible
- POST /authorize missing fields → 400; happy passes
  `{tenantId, depositId, targetLeaseId, signature, ip}`
  to service

### Test infra additions

- Mocks for ~20 service functions across 5 service
  modules (flexCharge, flexpay, flexDeposit,
  flexsuiteAcceptance, depositPortability). vi.hoisted
  pattern with narrowed return types where the route
  branches on `ok:true|false`.

## Files touched

```
apps/api/src/routes/
  tenants-flex.test.ts   (NEW — 400 lines, 16 cases)
```

No production code touched. No migrations. No schema
changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Bundle all 13 Flex routes into one slice or split (e.g., FlexCharge separate from FlexDeposit)? | **One slice.** All five Flex services share the same shape (visibility gate + delegating route). Splitting would create 3-4 micro-slices for marginal organization gain; one focused file is cleaner. |
| Test the GET /flexpay shape for the disqualified-state fields (flexpay_disqualified_until/reason)? | **Implicit in happy path.** The route SELECTs them; the happy test asserts the enrolled+pull_day+monthly_fee fields landed. Disqualified state is just `NULL` in the response when not set — mechanical. |
| Probe for schema-drift on FlexPay columns (S374 caught one on /verify-ach)? | **Verified via schema grep.** flexpay_enrolled, flexpay_pull_day, flexpay_monthly_fee, flexpay_enrolled_at, flexpay_disqualified_until, flexpay_disqualified_reason — all present in current schema. The happy-path test would have crashed if any were missing. |
| Test the POST /decline portability route too? | **Skipped — pass-through with minimal validation.** Same shape as authorize but simpler (only depositId). Adding it would be ceremony; authorize covers the validation pattern. |
| Test the GET /re-acceptance-preview route? | **Skipped — pass-through with the same validation as /re-accept (invalid product).** /re-accept covers the product validation + happy path; preview is a read-only mirror of the same logic. |
| Test the deposit happy-path with the full landlord/property/unit chain seeded, or use random uuids? | **Full chain.** S375 hit an FK violation on first attempt with random uuids — security_deposits has lease_id NOT NULL with FK to leases. The full seed pattern (landlord → property → unit → lease → tenant → lease_tenant → security_deposit) matches the test patterns established in prior sessions (S360, S371) and is the only correct way to land the row. |
| Pin the visibility=false case across all 3 Flex products? | **Yes — 3 separate tests.** The visibility gate is the first thing the UI checks; if it regresses, the entire surface goes dark. Each Flex product has its own visibility service; testing each pins the contract independently. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1115 tests across 64 files, 0
  failures**, ~564s.
- 16 new test cases (`tenants-flex.test.ts`).
- 0 production bug fixes.
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S376 could target

### tenants.ts remaining slices (~22 routes left)

S374 + S375 covered 18 of tenants.ts's 40 routes (~45%).
Remaining:

- **OTP + credit enrollment** (2 routes)
- **Payments history** (1 route)
- **Invite + accept-invite + invite-info** (3 routes —
  tenant-add flow public)
- **Admin-facing /:id/profile + /:id/transfer +
  /:id/available-units** (3 routes)
- **Profile patch + avatar + password** (4 routes)
- **Lease views** (3 routes — read lease + sign + addendums)
- **Work-trade + charge-account** (2 routes)
- **portability/decline** (1 route, skipped in slice 2)
- **re-acceptance/preview** (1 route, skipped in slice 2)

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Per `feedback_checkr_otp_unrelated.md`, frame
Checkr as background-check product going live, NOT as
unblocking OTP.

### **CONTEXT RECOMMENDATION (S375 closing note)**

This session was opened on Nic's explicit "do you still
have context to handle it accurately?" question. I
committed to one slice and clean closure. **S376 should
be opened with /clear for a fresh context window.** The
chain is at 29 sessions deep; further work without a
clear risks accuracy drift on cross-session reasoning
(e.g., remembering which slices covered what within
tenants.ts).

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf**
- **responsibleParty source-comment drift fix**

### Hardening flagged

- **logAdminAction targetId-uuid audit**
- **silent-failure pattern audit**
- **schema-drift audit** — 4 instances (S355/S360/S370/S374)
- **arc-completeness verification at close time**

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S374.)

## Items deferred (cross-session docket, post-S375)

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
- logAdminAction targetId-uuid audit (codebase-wide hygiene pass)
- silent-failure pattern audit (try/catch swallow class)
- schema-drift audit (4 instances — codebase-wide grep priority)
- arc-completeness verification at close time (process hardening)
- tenants.ts remaining: OTP/credit + payments history + invite/accept + admin /:id/* + profile-patch/avatar/password + lease views + work-trade + charge-account + portability-decline + re-acceptance-preview
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

## What S376 should target

**Recommended: clear context for S376.** The session
chain is 29 deep; accuracy drift on multi-session
reasoning is the risk. Memory + handoffs hold all
required state for a fresh window to resume.

If continuing the chain anyway: tenants.ts OTP + credit
+ payments history (3 small routes, ~6-8 tests).

If clearing: per memory note, start S376 with the
**Checkr API integration in background.ts** before
returning to the test sweep.

---

End of S375 handoff. tenants.ts arc slice 2 of N covered
(13 Flex routes). 1115 tests / 64 files / 0 failures. 0
production bugs surfaced. **Recommend /clear before
S376** — context window is deep; clean handoff is the
safer move.

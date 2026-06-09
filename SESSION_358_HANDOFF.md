# Session 358 — closed

## Theme

Continued the landlords.ts arc. **Slice 3:** payouts +
disputes + payments-history (money-adjacent SQL rollups —
4 routes, ~175 LoC). Per S357 recommendation, the
highest-yield remaining surface in the landlords.ts arc
before CSV onboarding.

The slice surfaced **1 production bug** — a SQL ambiguous-
column crash on `GET /api/landlords/me/disputes?pending=true`.
The pending-filter clause appended `AND status IN (...)`
without an alias, and the query JOINs `payments p` which
also has a `status` column. Every pending=true call
crashed 500 with "column reference 'status' is ambiguous".
Fix: alias to `d.status`.

This was a "filter never exercised" bug — the test DB has
no payments rows joined to the dispute, so the ambiguity
wouldn't surface without seeding cross-table fixtures. The
sweep test triggered it on first run.

11 new test cases pin the slice including the F1 fix.

Suite at S357 close: **910 / 46 files**.
Suite at S358 close: **921 / 47 files** (+11 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Bug fix (1)

**F1 — `GET /me/disputes?pending=true` 500 (ambiguous column)**
- `landlords.ts:3343-3351` — pendingClause changed from
  `AND status IN (...)` to `AND d.status IN (...)`. The
  query at line 3349 JOINs `payments p` (which has its
  own `status` column), making the bare `status` reference
  ambiguous. Postgres rejected with "column reference
  'status' is ambiguous" → 500 with raw error to client.
- Pre-fix: every pending=true call from the landlord
  PaymentsPage's "needs response" filter chip crashed.
- Test "pending=true filter returns only needs_response
  statuses" pins the fix — seeds two disputes (one
  needs_response, one won), asserts filter narrows
  correctly.

### Test coverage — 11 cases / 4 describe blocks

New file: `apps/api/src/routes/landlords-payouts.test.ts`

**GET /api/landlords/me/payouts (3)**
- Empty → []
- Returns payouts keyed on landlord user_id; cross-
  landlord excluded (a's payout doesn't show in b's
  list)
- status query param narrows results (paid vs failed)

**GET /api/landlords/me/disputes (3)**
- Empty → []
- Ordering: needs_response priority 1, warning_needs_
  response priority 2, others 3; secondary by
  evidence_due_by ASC NULLS LAST
- **F1 pin:** pending=true filter returns only needs_
  response / warning_needs_response statuses

**POST /api/landlords/me/disputes/:id/respond (3)**
- Happy path: stamps evidence_submitted_at +
  response_notes; calls stripe.disputes.update with the
  evidence payload (verified via mock)
- Non-respondable status (won) → 409 + Stripe NOT
  called
- Cross-landlord dispute id → 404 + Stripe NOT called

**GET /api/landlords/me/payments-history (2)**
- Returns `charges` + `payouts` shape; both landlord-
  scoped (a sees only a's, not b's)
- Charges WHERE filters out pre-Stripe rows (rows where
  stripe_payment_intent_id IS NULL — the legacy off-
  platform payments that shouldn't surface in the
  Stripe timeline)

### Test infra additions

- Mock for `lib/stripe.getStripe()` → returns
  `{ disputes: { update: stripeDisputesUpdateMock } }`.
  Used by POST /me/disputes/:id/respond; lets the test
  verify Stripe was called with the right payload OR not
  called at all (for guards).
- `dbHelpers.cleanupAllSchema` extended for
  `connect_payouts`. Both FKs (users + pm_companies) are
  SET NULL, so rows survive parent deletes — explicit
  cleanup required.

### Surfaces NOT covered (out of slice — for future
sessions)

- landlords.ts remaining: POS customers + FlexCharge +
  tenant onboarding + CSV imports + OTP + pm property
  invitations + /me/email-failures + /me/pm-impact

## Files touched

```
apps/api/src/routes/
  landlords.ts                  (+5 -1 lines: F1 fix)
  landlords-payouts.test.ts     (NEW — 290 lines, 11 cases)

apps/api/src/test/
  dbHelpers.ts                  (+4 lines: connect_payouts cleanup)
```

No migrations. No schema changes. No frontend changes.
No shared-package changes.

## Decisions made during build

| Question | Decision |
|---|---|
| F1 fix posture — qualify `status` alias only in the pending clause, or audit the whole query for similar drift? | **Qualify only the broken clause.** The SELECT, ORDER BY, and other WHERE clauses already use `d.status` / `d.evidence_due_by` / etc. with explicit aliases. The pending clause was the one site where the string-concat pattern dropped the alias. Auditing the rest would be speculative; the test catches any future drift in this clause via the explicit pending=true coverage. |
| Probe other JOIN-ambiguity sites in landlords.ts (similar shape: a child-table JOIN with a same-named column)? | **No proactive probe.** Each route's test slice would catch its own drift if tested. The pattern (string-concat WHERE clauses dropping aliases) is something to watch in future slices but not chase across the file in this session. |
| Mock the Stripe SDK at the module boundary (`lib/stripe`) or the call site? | **Module boundary.** Standard pattern matches existing tests (esign / webhooks). The route does `const stripe = (await import('../lib/stripe')).getStripe()` — mocking `getStripe` lets the test return any shape needed. |
| Test ordering with 3 disputes vs minimum 2 (needs + non-needs)? | **3 — pins both priority tiers.** needs_response (priority 1), warning_needs_response (priority 2), and "other" (won, lost, etc., priority 3) all need to be in correct order. 2 disputes would only pin one transition; 3 pins both. |
| Test the limit cap (200 max)? | **Skipped.** Mechanical Math.min/max math; not a regression risk that warrants a dedicated test. The route's parseInt + clamp is short and obvious. |
| Test payments-history with payouts + charges interleaved (timeline-style)? | **Just verified shape.** The route returns two arrays — the frontend stitches them visually. Testing the stitch is frontend work; backend just needs to return both halves correctly scoped, which the existing test asserts. |
| Test cross-landlord POST /respond explicitly even though loadRequest-style scoping is already tested elsewhere? | **Yes.** This is a write that hits Stripe live in prod — high blast radius if it ever leaks cross-tenant. Explicit pin: 404 + Stripe NOT called (the Stripe mock assertion catches anyone removing the WHERE scoping check). |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **921 tests across 47 files, 0
  failures**, ~483s.
- 11 new test cases (`landlords-payouts.test.ts`).
- 1 production bug fix (`landlords.ts` F1 — ambiguous
  column in pending clause).
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S359 could target

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Nic obtained Checkr Partner credentials
2026-05-26. The next fresh-context session starts with
wiring `background.ts` to live Checkr (not a test slice —
real product integration). After that, resume the
test-sweep arc.

Note: Checkr and OTP are **unrelated surfaces** (per
`feedback_checkr_otp_unrelated.md`, recorded after I
mistakenly framed them as connected). Frame the Checkr
value as background-check product going live, not as
unblocking OTP.

### landlords.ts remaining slices

S356 + S357 + S358 covered 13 routes (~25% of
landlords.ts). Remaining surfaces:

- **POS customers + FlexCharge** (8 routes, ~150 LoC)
- **Tenant onboarding** (4 routes, ~600 LoC, complex)
- **CSV onboarding** (10 routes, ~1500 LoC; multi-stage
  validate+commit; F1-probe heavy)
- **Email failures + PM impact** (2 routes)
- **OTP** (5 routes)
- **PM property invitations** (7 routes)

### Admin-surface route slices still uncovered

```
admin.ts                 1514  NO TESTS
tenants.ts               1326  NO TESTS
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

**Recommended next picks for S359 (if continuing chain):**

1. **landlords.ts CSV onboarding slice** — biggest
   remaining landlords.ts slice (10 routes, ~1500 LoC,
   multi-stage validate+commit). High bug-yield
   expected given complexity.
2. **admin.ts** (1514, NO TESTS) — third-biggest
   unwalked file. First slice of multi-session arc.
3. **landlords.ts POS customers + FlexCharge** —
   smaller, faster slice (~150 LoC) that closes another
   landlords.ts surface block.
4. **tenants.ts** (1326, NO TESTS) — tenant-facing
   surface; tenant portal data.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S357.)

## Items deferred (cross-session docket, post-S358)

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
- landlords.ts remaining: POS customers + FlexCharge + tenant onboarding + CSV imports + OTP + pm property invitations
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

## What S359 should target

Bug-yield over the last 12 sessions:
- S347 (POS inventory): 2 / 10
- S348 (maintenance-portal): 5 / 15
- S349 (scopes): 1 / 18
- S350 (bookings): 0 / 8
- S351 (entryRequests): 1 / 13
- S352 (pm slice 1): 0 / 17
- S353 (pm design follow-ups): 0 / 4
- S354 (units): 1 / 14
- S355 (properties): 1 / 16
- S356 (landlords slice 1): 0 / 15
- S357 (landlords /me/todos): 0 / 10
- S358 (landlords payouts/disputes): 1 / 11

Running 12-session average: ~1.0 bugs/session, ~3.5%
per-test rate. S358's F1 was a real money-path bug
(landlord PaymentsPage's "needs response" filter
broken). Bug-pipeline pattern continues at material rate
on SQL-heavy surfaces with JOIN ambiguity drift.

If continuing chain: **landlords.ts CSV onboarding
slice** is the highest-yield candidate (1500 LoC,
multi-stage validate+commit, never tested — high
likelihood of F1-class bugs).

If clearing for fresh context: per memory note, start
S359 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S358 handoff. Closed clean. 921 tests / 47 files
/ 0 failures. landlords.ts payouts + disputes + payments-
history slice covered. 1 real bug caught + fixed (F1:
`GET /me/disputes?pending=true` ambiguous column crash —
landlord PaymentsPage "needs response" filter broken in
production).

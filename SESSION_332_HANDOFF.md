# Session 332 — closed

## Theme

Extended S331's test coverage thread to the credit-ledger
dispute lifecycle. 8 new Vitest cases cover
`openDispute → submitDisputeEvidence → resolveDispute` with
the three outcomes (upheld / no_change / corrected). The
**corrected** path locks in the S325 latent-bug regression
target.

Full suite: **272 tests across 22 files, all passing**.

## Items shipped

### Test file

**`apps/api/src/services/creditDispute.test.ts`** (NEW, 8
tests):

`openDispute`:
- Creates a `credit_disputes` row with `status='open'` +
  reason + notes correctly captured.
- Appends a `dispute_opened` event on the disputing
  subject's chain, FK'd to the dispute row via
  `dispute_open_event_id`.

`submitDisputeEvidence`:
- Appends a `dispute_evidence_submitted` event with the
  evidence merged into `event_data`.
- Flips the dispute status from `'open'` to
  `'evidence_pending'`.
- Refuses to submit evidence on a dispute already in
  `'resolved_*'` status.

`resolveDispute` — three outcomes:
- **`upheld`**: status flips to `'resolved_upheld'`,
  appends `dispute_resolved_upheld` event, original
  disputed event stays un-superseded.
- **`no_change`**: status flips to `'resolved_no_change'`,
  appends `dispute_resolved_no_change`, no chain change.
- **`corrected`** (S325 regression target): appends the
  new corrected event on the chain, `supersedeEvent` sets
  the original event's `superseded_by` + `superseded_reason`,
  dispute status flips to `'resolved_corrected'`, the
  resolution event's `event_data` captures
  `corrected_event_id`, `resolved_by_user_id`, and
  `outcome='corrected'` for audit attribution.
- **Validation guard**: refuses `outcome='corrected'`
  without a `correctedEvent` payload (covers the route-
  layer's structural prerequisite).

`resolveDispute` — re-resolve guard:
- Refuses to re-resolve a dispute already in a
  `resolved_*` state.

### Test infra additions

**`apps/api/src/test/dbHelpers.ts`** — `cleanupAllSchema()`
now wipes `credit_disputes`, `credit_hardship_contexts`,
`credit_scores`, `credit_stats` (FK to credit_events /
credit_subjects). Required for the dispute tests to leave
clean state for subsequent tests; broader value for any
future credit-ledger test work.

## Files touched (S332)

```
apps/api/src/services/
  creditDispute.test.ts                    (NEW; 8 tests)

apps/api/src/test/
  dbHelpers.ts                             (4 tables added to
                                            cleanupAllSchema)

SESSION_332_HANDOFF.md                     (this file)
```

No production code changes. No schema changes. No migrations.

## Decisions made during build

| Question | Decision |
|---|---|
| Test fixture for the dispute lifecycle — synthetic chain or real `appendEvent`? | **Real `appendEvent`.** The hash-chain integrity is implicit in `appendEvent` (calls `getOrCreateSubject` + `pg_advisory_xact_lock` + computes `this_hash` from `prev_hash` + canonical payload). Constructing chain rows manually would be fragile + miss real-world ordering / locking interactions. Single test helper `seedTenantWithLateEvent` wraps the setup. |
| `recomputeAndSnapshot` error in corrected-outcome path — fix or document? | **Document.** The corrected outcome triggers `recomputeAndSnapshot(subjectId)` after commit, which fails in test because no `credit_score_formulas` row is seeded. The service has a `.catch()` that logs and continues; no test failure. Adding a formula seed to the test would couple this suite to score-formula schema; if a future session adds credit-score tests, the formula seed lives there. |
| `appendEvent` event-type values like `'payment_received_late_major'` — strongly typed or cast as any? | **Cast as any in test.** The `@gam/shared` CreditEventType union is broad enough that mocking + casting through the test's seed helpers is cleaner than threading the type all the way. Production code paths still hit the type check. |
| Re-resolve guard error message check — string match or just `.toThrow()`? | **String match.** `/already resolved/` is specific enough to catch the intended path without over-coupling to the exact wording. Same posture as other test files in this suite. |

## Verification

- `npx tsc --noEmit` on `apps/api`: clean.
- `npm test` on `apps/api`: **272 tests passed, 22 files, no
  failures**. Duration ~135s.
- The 8 new dispute tests integrate cleanly with the
  existing 21-file suite + the 26 tests added in S331. No
  flakiness across multiple runs.

## Items deferred — what S333 could target

### A. flexsuitePdf renderer test coverage

Zero tests on the renderer. The S331 bug discovery (`→`
char) would have been caught earlier with a render-the-
expected-content test. Sanitizer + pagination + footer
logic all testable.

### B. POS request-body migration

Offline-sync queue care. Persisted IndexedDB payloads.

### C. Unicode-capable font in flexsuitePdf

Removes the 10-char sanitizer entirely. ~300KB bundle add.

### D. Remaining long-tail S312 reads (tenant Maintenance,
Disbursements, Documents, Reports)

The S327 scan flagged these but they haven't been migrated.

### E. Credit-score formula + recompute test coverage

The `recomputeAndSnapshot` path is exercised in S332 but
swallowed via .catch(); the formula itself has no tests.
Bigger fixture surface (CREDIT_SCORE_FORMULAS_V1 seed +
multiplicative score math).

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
- flexsuitePdf rendering test coverage.
- Credit-score formula + recompute test coverage.
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

## What S333 should target

Test-coverage thread can continue with **A**
(flexsuitePdf) or **E** (credit-score recompute). Real
product remaining: **D** (tenant long-tail) or **B** (POS).

---

End of S332 handoff. Closed clean. Credit-ledger dispute
lifecycle regression protection landed.

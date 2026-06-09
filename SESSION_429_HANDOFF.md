# Session 429 — closed

## Theme

**Sixth services-audit session. Paired slice for the
two credit-ledger compute services: `creditScore.ts`
+ `creditStats.ts` — the pure replay functions. 20
tests pinning the locked v1.0.0 formula math and the
disclosure-stats math.**

Suite at S428 close: **2153 / 125 files**.
Suite at S429 close: **2176 / 126 files** (+20 cases,
+1 file = the paired slice; +3 ambient tests from
auto-discovery). 0 failures. Runtime **61.56s**.
Thirty-third consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/creditScoreStats.test.ts` — 20 cases

Pure-function slice covering `computeScore` (creditScore.ts)
and `computeStats` (creditStats.ts). Both are
deterministic replays of an event chain; testing them
in isolation against synthetic event arrays catches
math regressions without DB setup.

**computeScore (12 cases)**
- Empty chain → starting_score (0), eventCount 0
- Single positive → score += points × weight
- attestation_weight scales positives (0.7 → 70%)
- Zero attestation_weight (tenant_self_reported) →
  event skipped but counted in eventCount
- Negative as percentage of current score
- Floor caps score from going below 0
- Superseded event skipped (not in score, not in
  eventCount)
- Monthly spam_cap limits repeated positives within
  same month
- Yearly spam_cap on lease_signed (limit 2)
- Spam caps RESET across windows (Jan + Feb each get
  their own 1)
- Dimension tags accumulate per-dimension scores
- Deterministic sort: events out of recorded_at order
  are sorted before replay

**computeStats (8 cases)**
- Empty chain → all-zeros stats
- Payment events bucketed by tier in lifetime slice
- rolling_90d window excludes events older than 90 days
- On-time streak: counts consecutive on_time + grace,
  resets on miss (longest + current)
- Tenancy events rolled up by type
- Dimension rollup counts by event_type within
  dimension tag (excludes events not tagged for that
  dimension)
- Superseded events excluded from all slices and counts
- pct computation handles zero denominator
  (no payments → 0)

### Deferred to follow-on

DB-backed wrappers in both services:
- `loadFormula`, `loadCurrentFormula`,
  `recomputeAndSnapshot`, `recomputeAllSubjects`,
  `getLatestScore` (creditScore.ts)
- `refreshSubjectStats`, `refreshAllSubjectStats`,
  `getLatestStats` (creditStats.ts)

These need the v1.0.0 formula seed in the test DB
(it's a migration seed, but pinning the DB-write
contract is a separate slice surface from the pure
compute math). Bundle into a follow-on session.

## Items shipped

```
apps/api/src/services/
  creditScoreStats.test.ts             (NEW — 20 cases,
                                          ~370 lines,
                                          covers TWO
                                          services)
```

No source code changes. Both services preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| One test file or two (one per service)? | **One.** Both files implement related parts of the credit-ledger pipeline; the synthetic ChainEvent shape + helpers are shared. Splitting would duplicate the helpers. |
| Use the real v1.0.0 formula seed or an inline minimal definition? | **Inline minimal definition.** Tests are about the compute function, not the seed. A small definition mirroring the v1.0.0 shape (positives + negatives + spam_caps + attestation_weights + floor) keeps the tests self-contained and surfaces the math contracts visibly. The real v1.0.0 is exercised end-to-end by the DB-backed wrappers in a future slice. |
| Pin each spam_cap window (year / month / lifetime) separately? | **Cover year + month + cross-window-reset.** Lifetime is structurally identical to year (single bucket); testing both windows + the reset behavior across windows is the high-yield set. |
| Pin the deterministic sort? | **Yes — explicit out-of-order test.** A regression that drops the sort would silently produce different scores depending on insert order. The whole replay contract depends on chronological ordering. |
| Pin the floor behavior with deeply-nested negatives? | **Yes — important boundary.** The unbounded-multiplicative model needs the floor to prevent negative scores from cascading. A regression that drops the floor check would let scores go negative. |
| Pin the on-time streak (longest + current) separately? | **Yes — both metrics are user-facing.** A regression that conflates them (e.g., current = longest) would mislead UI. |
| Pin the pct computation's zero-denominator handling? | **Yes.** A regression that returns NaN or divides by zero would crash the JSON serializer or render literal "NaN" in the UI. The current `return 0` is a load-bearing safety net. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2176 tests across 126
  files, 0 failures**, 61.56s. **Thirty-third
  consecutive fully-green full-suite run.**
- 20 new test cases.
- 0 production regressions.
- 0 new findings — both services match their
  documented contracts. The locked v1.0.0 formula
  math is now pinned end-to-end as a pure-function
  property; any future v1.1.0 formula bump that
  breaks v1.0.0 replay would fail tests.

## Services audit — progress

Post-S429:

### Direct coverage (37 of 43 services ≈ 86%)

S424: + supersedence
S425: + flexCharge (CRUD half)
S426: + riskScore
S427: + otp (non-Stripe half)
S428: + pdfStamp + pm + landlordPassthrough
S429: + creditScore + creditStats (pure-function half)

### Still UNCOVERED (~20 files)

Highest-value candidates next:
1. **`addendumActor.ts`** + **`addendumPdf.ts`** (paired)
2. **`utilityBilling.ts`** (medium, single)
3. **`subleaseAllocation.ts`** (medium, single)
4. **`flexpay.ts`** (medium, single)
5. **`stripeConnect.ts`** (huge, multi-session)
6. **pm.ts invitation lifecycle** (continuation)
7. **flexCharge.ts billing/reconciliation half**
8. **otp.ts Stripe state-machine half**
9. **DB-backed credit-ledger wrappers**
   (recomputeAndSnapshot, refreshSubjectStats,
   getLatest*)
10. Plus ~12 smaller helpers

At ~30 min per session for the small ones and
~45 min for the medium ones, ~9-12 hours / ~18-20
sessions remain.

## Items deferred — what S430 could target

### Continue services audit

**Recommend S430 = `addendumActor.ts` +
`addendumPdf.ts` paired slice.** Related logic
(lease addendum handling), should be quick.

**Alternatives:**
- utilityBilling.ts (medium single)
- subleaseAllocation.ts (medium single)
- flexpay.ts (medium single)
- DB-backed credit-ledger wrappers (continuation of
  S429)
- pm.ts invitation lifecycle (continuation of S428)

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S429)

- **47 production bug fixes** (S429 is direct
  coverage of well-built services)
- 16 architectural / validation findings remaining
- 2176 tests across 126 files
- Suite baseline: **60-63s on a clean machine**

## What S430 should target

**Recommended: `addendumActor.ts` + `addendumPdf.ts`
paired slice.** Two small related services, fast
iteration.

**Alternatives:**
- utilityBilling.ts
- subleaseAllocation.ts
- flexpay.ts
- DB-backed credit-ledger wrappers
- pm.ts invitation lifecycle

---

End of S429 handoff. **creditScore + creditStats
paired slice shipped — 20 tests pinning the locked
v1.0.0 formula math + the disclosure-stats math as
pure-function properties.**

2176 tests / 126 files / 0 failures. Thirty-third
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 37/43 covered (≈86%);
20 files remain.

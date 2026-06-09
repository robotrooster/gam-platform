# Session 426 — closed

## Theme

**Third services-audit session.
`services/riskScore.ts` direct coverage. 28 tests
across all four scoring categories + level mapping
+ score-cap behavior.**

Suite at S425 close: **2063 / 120 files**.
Suite at S426 close: **2091 / 121 files** (+28 cases,
+1 file). 0 failures. Runtime **62.31s**.
Thirtieth consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/riskScore.test.ts` — 28 cases

`calculateRiskScore` aggregates four categories
(identity / financial / behavioral / duplicate) into
`{ score, level, flags, categories }`. Mostly pure
logic; behavioral + duplicate hit DB for IP velocity
and prior-denial lookups.

**Baseline (2 cases)**
- Clean intake → 0 score (income/rent credit), level
  low, no flags
- Returns the categorized flags shape

**Identity (11 cases)**
- Unrealistic first name (consonants only) → flag
- Unrealistic last name → flag
- Keyboard-walk name → flag
- Disposable email domain → +40
- Suspicious email keyword (temp/trash/spam) → +20
- SSN with 5 identical digits → flag
- SSN sequential ascending → flag
- SSN sequential descending → flag
- SSN repeating-prefix pattern → flag
- Under-18 dob → +50
- Over-100 dob → +30

**Financial (5 cases)**
- Income < 2× rent → +35
- Income 2–3× rent → +10
- Unemployed + high income → +20
- Employed + < $500 income → +20
- Self-employed under 22 + high income → +15

**Behavioral (3 cases)**
- Completed under 60s → +30
- Completed 60–120s → +10
- 3+ background_checks same IP in 24h → flag (real
  DB seed pins the velocity lookup)

**Duplicate (2 cases)**
- Matching SSN_last4 + DOB but different name → flag
  (real DB seed)
- Prior denials under same email → flag (real DB
  seed)

**Level mapping + score cap (5 cases)**
- score ≥ 70 → very_high
- score in [45, 69] → high
- score in [20, 44] → medium
- score < 20 → low
- Score caps at 100 when stacked flags would exceed

## Items shipped

```
apps/api/src/services/
  riskScore.test.ts                    (NEW — 28 cases,
                                          ~310 lines)
```

No source code changes. riskScore.ts behavior
preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Test each individual SSN-pattern branch separately? | **Yes — 4 distinct cases** (5+ identical, sequential ascending, sequential descending, repeating prefix). Each has a different score weight and is independent; conflating them would mask a regression that drops one branch. |
| Pick the baseline SSN carefully? | **Yes — `147258369`.** Mixed digits, no 3-in-a-row sequence, no repeating prefix, no digit count ≥ 4. The first attempt (`321456789`) tripped the descending-sequence flag and broke baseline expectations. |
| Pin the over-100 / under-18 boundaries? | **Yes — both.** Edge cases on age math; a regression that flips the comparison would silently let minors through. |
| Test behavioral IP-velocity with real DB inserts? | **Yes — required.** The function queries `background_checks WHERE ip_address=...` directly. A mock would obscure the live SQL filter. |
| Pin the income/rent credit (income ≥ 3× rent → -5)? | **Implicit via baseline test.** The baseline scores 0 with income=5000, rent=1000 (ratio 5); a regression that drops the credit would push baseline score above 0. |
| Cap the very_high test at exactly 100? | **No — relaxed to ≥ 70.** Stacking under_18 + disposable_email = 90 hits the threshold but income/rent credit subtracts 5 → 85. The level transition is what matters; the absolute cap is tested separately. |
| Pin the score cap at 100? | **Yes — explicit test.** Stack 6 flags totaling well over 100; verify the result is exactly 100, not 150+. A regression that drops the `Math.min(100, ...)` would silently inflate scores. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2091 tests across 121
  files, 0 failures**, 62.31s. **Thirtieth consecutive
  fully-green full-suite run.**
- 28 new test cases.
- 0 production regressions.
- 0 new findings — riskScore behavior matches its
  documented scoring rules.

## Services audit — progress

Post-S426, the tally:

### Direct coverage (31 of 43 services ≈ 72%)

S424: + supersedence
S425: + flexCharge (8 of 20+ exports — first pass)
S426: + riskScore

### Still UNCOVERED (~26 files)

Highest-value candidates next:
1. **`otp.ts`** + **`otpScheduler.ts`** — On-Time Pay
   advancement math (small pair, paired logic)
2. **`creditScore.ts`** + **`creditStats.ts`** — credit
   ledger formula + stats
3. **`utilityBilling.ts`** — utility billing math
4. **`subleaseAllocation.ts`** — sublease ledger
5. **`pdfStamp.ts`** — signed PDF stamping (small)
6. **`pm.ts`** — PM company resolution (small)
7. **`landlordPassthrough.ts`** — banking-fee
   passthrough (small)
8. **`addendumActor.ts`** + **`addendumPdf.ts`** (small
   pair)
9. **`flexpay.ts`** — FlexPay subscription math
10. **`stripeConnect.ts`** — destination-charge math
    (deferred — multi-session)
11. **flexCharge.ts statement/billing/reconciliation
    half** still uncovered

At ~30 min per session, ~13 hours / ~26 sessions
remain.

## Items deferred — what S427 could target

### Continue services audit

**Recommend S427 = `otp.ts` + `otpScheduler.ts` paired
slice.** Small pair, related logic. Fast iteration
with two services closed.

**Alternatives:**
- pdfStamp.ts (small, single file)
- pm.ts (small, single file)
- landlordPassthrough.ts (small)
- creditScore + creditStats pair
- continue flexCharge billing half (already in
  context)

### Validation-hygiene backlog (15 items, mostly Nic-pending)

Unchanged from S424.

### Cumulative bug-sweep totals (post-S426)

- **47 production bug fixes** (S426 is direct
  coverage of an existing well-built service, no
  new bugs surfaced)
- 15 architectural / validation findings remaining
- 2091 tests across 121 files
- Suite baseline: **60-62s on a clean machine**

## What S427 should target

**Recommended: `otp.ts` + `otpScheduler.ts` paired
slice.** Closes two services in one session.

**Alternatives:**
- pdfStamp.ts (smallest)
- creditScore + creditStats pair
- pm.ts
- landlordPassthrough.ts

---

End of S426 handoff. **riskScore service slice
shipped — 28 tests across all four scoring
categories + level mapping + score cap.**

2091 tests / 121 files / 0 failures. Thirtieth
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 31/43 covered (≈72%);
26 files remain.

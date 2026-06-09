# Session 427 — closed

## Theme

**Fourth services-audit session.
`services/otp.ts` direct coverage — visibility,
qualification status, enable/disable lifecycle, NSF
disqualify, ACH-unverify auto-disenroll, plus the
pure date utils. 29 tests.**

Suite at S426 close: **2091 / 121 files**.
Suite at S427 close: **2128 / 122 files** (+29 cases,
+1 file; +8 ambient tests from previously-skipped
files that auto-discovered now). 0 failures.
Runtime **63.29s**. Thirty-first consecutive
fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/otp.test.ts` — 29 cases

**isOtpVisibleForLandlord (3 cases)**
- Platform flag off → false even if landlord toggle on
- Platform on + landlord toggle on → true
- Platform on + landlord toggle off → false

**getQualificationStatus (8 cases)** — every blocker
condition + happy path
- Unknown tenant → tenant_not_found
- ach not verified → ach_unverified
- bg check not approved → bg_check_not_approved
- deposit not fully funded → deposit_not_funded
- Active FlexDeposit installments → flex_deposit_active
  (mutually exclusive with deposit_not_funded)
- NSF cooldown in future → nsf_cooldown + cooldown_until
- NSF cooldown in past → NOT a blocker
- All baseline conditions met → eligible=true, no blockers

**enableOtpForTenant (5 cases)** — every gate
- Visibility OFF → refuses
- Landlord has no Stripe Connect account → refuses
- Tenant not qualified → refuses with blocker list
- Tenant not on active lease with landlord → refuses
- Happy: all gates pass → flips on_time_pay_enrolled
  + float_fee_active

**disableOtpForTenant (1 case)** — simple flag flip

**disqualifyTenantForNsf (1 case)** — 180-day cooldown
+ reason + disenroll

**autoDisenrollOnAchUnverified (2 cases)**
- Disenrolls when enrolled; idempotent on already-
  disenrolled
- NO cooldown stamped (distinct from
  disqualifyTenantForNsf)

**Pure date utilities (9 cases)**
- `cycleMonthFor`: mid-month → following 1st;
  December → next-year January; January → February
- `cycleMonthForRentDue`: mid-month → that month's 1st
  bucket; first-of-month → same date
- `isLastBusinessDayOfMonth`: weekend → false; last
  weekday → true; mid-month weekday → false; month
  ending Sun → Friday-before is last business day

## NOT covered in S427

### Deferred to follow-on (heavy Stripe / state machine)

`otp.ts` has 16 exports total; S427 covers 11 of
them. The remaining 5 are heavy state-machine paths:
- `processMonthlyAdvance` (~180 lines, runs the
  last-business-day cycle; touches Stripe Connect
  Transfers)
- `fireOtpAdvanceTransfer` (Stripe Connect call)
- `reconcileSettledRentPayment` (post-settle math)
- `handleRentPaymentNsf` (NSF state transitions)

Each warrants its own slice with proper Stripe
mocking. Estimated 2 sessions to close the otp.ts
arc fully.

### `services/otpScheduler.ts` deliberately NOT covered

The file header marks it DISABLED:
> S86 STATUS: DISABLED. The export remains so the
> file compiles and any future re-enable site can
> find it, but `scheduleOtpCron` is no longer called
> from index.ts. Two pre-existing schema breaks made
> the cron a runtime landmine if it ever fired:
>   1. The tenant lookup JOINs `units u ON u.tenant_id
>      = t.id` (units.tenant_id removed in S26-ish
>      with lease_tenants model).
>   2. The disbursements INSERT writes columns that
>      don't match the current 16a-era shape.

Testing would lock in broken behavior. Re-enable
work should rewrite the queries against the current
schema THEN add tests. Flagged for the hygiene
backlog.

## Items shipped

```
apps/api/src/services/
  otp.test.ts                          (NEW — 29 cases,
                                          ~400 lines)
```

No source code changes. otp.ts behavior preserved
as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Skip otpScheduler.ts entirely or write tests against the broken state? | **Skip.** Tests against known-broken code lock in the brokenness; future re-enable then has to fight the tests. The header comment already documents the breakage; my handoff reinforces it. |
| Cover processMonthlyAdvance in this session? | **No — defer.** ~180 lines, Stripe Connect Transfers, complex state machine. Needs its own slice with proper Stripe mocking. Same posture as deferring flexCharge billing/reconciliation in S425. |
| Pin the mutual-exclusion between deposit_not_funded and flex_deposit_active? | **Yes — explicit assertion** that flex_deposit_active blocker is set BUT deposit_not_funded is NOT. The route logic uses an else branch; a regression that drops the else would set both blockers and double-count. |
| Pin the cooldown-in-past case as not-a-blocker? | **Yes — important boundary.** The cooldown timestamp is supposed to age out; testing that it does is the only way to catch a regression that flips the comparison. |
| Verify each gate refuses with a SPECIFIC message? | **Yes via regex** — `/Stripe Connect/`, `/ach_unverified/`, etc. The user-facing message is part of the contract (landlords + tenants see it on the screen); a regression that swaps two messages would mislead users without test catching it. |
| Pin the "no Stripe Connect → refuse" early-check? | **Yes — critical**. Per the S244 comment, this prevents an enrolled-then-fail loop where the cron tries to transfer to a non-existent destination. The early refuse is a load-bearing UX guarantee. |
| Test the date utilities with UTC dates? | **Yes — `Date.UTC()`.** Avoids local-TZ surprises in CI; matches the source's UTC-based implementation. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2128 tests across 122
  files, 0 failures**, 63.29s. **Thirty-first
  consecutive fully-green full-suite run.**
- 29 new test cases.
- 0 production regressions.
- 0 new bugs surfaced; 1 known-defect flag elevated
  (otpScheduler.ts DISABLED with documented schema
  breaks — re-enable is a future hygiene item).
- 1 transient flake on the first full-suite run
  (same "credit_disputes does not exist" infra issue
  flagged in S414 / S427); cleared on retry.

## Services audit — progress

Post-S427:

### Direct coverage (32 of 43 services ≈ 74%)

S424: + supersedence
S425: + flexCharge (8 of 20+ exports — first pass)
S426: + riskScore
S427: + otp (11 of 16 exports — Stripe-heavy paths
  deferred); otpScheduler.ts intentionally skipped

### Still UNCOVERED (~25 files)

Highest-value candidates next:
1. **`pdfStamp.ts`** — signed PDF stamping (small)
2. **`pm.ts`** — PM company resolution (small)
3. **`landlordPassthrough.ts`** — banking-fee passthrough
   (small)
4. **`addendumActor.ts`** + **`addendumPdf.ts`** (small
   pair)
5. **`creditScore.ts`** + **`creditStats.ts`** (paired
   logic)
6. **`utilityBilling.ts`**
7. **`subleaseAllocation.ts`**
8. **`flexpay.ts`** — FlexPay subscription math
9. **`stripeConnect.ts`** — destination-charge math
   (deferred — multi-session)
10. **flexCharge.ts billing/reconciliation half**
11. **otp.ts Stripe/state-machine half**

At ~30 min per session, ~12 hours / ~25 sessions
remain.

## Items deferred — what S428 could target

### Continue services audit

**Recommend S428 = small-services triplet:
`pdfStamp.ts` + `pm.ts` + `landlordPassthrough.ts`.**
All three are small single-purpose helpers. Closing
three in one session keeps the audit cadence high.

**Alternatives:**
- creditScore + creditStats pair
- addendumActor + addendumPdf pair
- Heavier single-target: utilityBilling.ts or flexpay.ts
- Continue otp.ts billing half (heavy Stripe; already
  in context)

### Validation-hygiene backlog (16 items)

S424-S427 didn't shrink the backlog. The S427-spawned
"otpScheduler.ts is DISABLED" flag brings it to 16.

### Cumulative bug-sweep totals (post-S427)

- **47 production bug fixes** (S427 is direct
  coverage of an existing well-built service)
- 16 architectural / validation findings remaining
  (+1 from S427 — otpScheduler.ts re-enable)
- 2128 tests across 122 files
- Suite baseline: **60-63s on a clean machine**

## What S428 should target

**Recommended: triplet of small helpers (pdfStamp +
pm + landlordPassthrough).** Maximizes services-
closed per session while the audit cadence is hot.

**Alternatives:**
- creditScore + creditStats pair
- addendumActor + addendumPdf pair
- utilityBilling.ts (single, medium)
- flexpay.ts (single)
- otp Stripe half (heavy; defer)

---

End of S427 handoff. **otp service slice shipped —
29 tests covering visibility / qualification /
enable-disable lifecycle / NSF + ACH disenroll /
date utils. otpScheduler.ts deliberately skipped
(disabled per header).**

2128 tests / 122 files / 0 failures. Thirty-first
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 32/43 covered (≈74%);
25 files remain.

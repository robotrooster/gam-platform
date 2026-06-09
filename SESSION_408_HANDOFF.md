# Session 408 — closed — **ROUTE-TEST SWEEP ARC CLOSED**

## Theme

**reports.ts gap-close slice — closes the file at 5/5
(100%). 28 new test cases, 1 production bug fix
(`/work-trade-1099` was dead in production), 2
architectural findings flagged.**

**MILESTONE: This session closes the route-test sweep
arc.** Last medium-band file shipped. All targeted route
files now have coverage.

Suite at S407 close: **1754 / 94 files**.
Suite at S408 close: **1782 / 95 files** (+28 cases,
+1 file). 0 failures. Runtime 1337.08s. Twelfth
consecutive fully-green full-suite run.

Zero tsc regressions.

## Production bug fixes shipped

### `GET /api/reports/work-trade-1099` was completely dead in production

**Severity: HIGH — the entire 1099 work-trade reporting
surface was non-functional. Every call returned 500.**

The route's main query at reports.ts:465 SELECTed
`t.ein as tenant_ein` from the `tenants` table —
but `tenants` has no `ein` column. (`ein` exists on
`landlords`, `pm_companies`, and `books_contractors`
only.) Every call to this route failed with
`42703 column "t.ein" does not exist` → 500.

Reproduction is one-step: hit the endpoint with a
valid landlord JWT. The 1099-eligibility report
that landlords would use at year-end for tax filing
returned nothing usable.

**Fix:** drop the broken SELECT. Tenant TIN/EIN
storage is a separate hygiene item — nowhere on
tenants to capture it today, so we can't return it
even if we wanted to. Flagged for validation-hygiene
as a "where do we put tenant TINs for 1099 filing?"
product/schema question.

## Architectural findings (flagged for validation-hygiene)

### Finding A: `/monthly-statement` defaults to LAST month

`parseInt(req.query.month) || new Date().getMonth()`
uses 0-indexed default but the explicit-input path is
1-indexed. Calling without `?month` returns the prior
calendar month's data. Could be deliberate (showing the
just-completed month) or an off-by-one. Needs product
input.

Pinned in slice: `'S408 finding A: defaults to LAST
calendar month when ?month omitted (0-indexed trap)'`.
If/when fixed, this test fails — visible regression.

### Finding B: `$15` hardcoded platform fee in 3 routes

Three routes (monthly-statement, tax-summary,
property-pl) hardcode `$15` as the per-non-vacant-unit
platform fee per month. Per CLAUDE.md current pricing
is `$2/occupied-unit + $10/property/mo`. The hardcoded
$15 is ~7× too high for unit fee alone, and counts the
wrong units (non-vacant vs occupied).

Real-world impact: tax-summary deductions are wrong;
landlords reading their tax forms get inflated
platform-fee deductions. Severity: medium-high but
needs:
- Decision on whether to read historical actual fees
  (from `platform_fee_accruals` table) vs current rate
- Product input on what historical periods need
  re-statement
- Multi-route refactor (3 SQL queries + 1 frontend
  calc fix)

Pinned in slice on all 3 routes as
`'S408 finding B: ... uses STALE $15/.../month
hardcode'`. If/when fixed, the tests fail and
expectations update to the corrected value.

## Items shipped

### Test coverage — 28 cases / 5 describe blocks

New file: `apps/api/src/routes/reports.test.ts`
(~470 lines)

**GET /summary — 6 cases**
- Landlord-scoped: includes only own collected MTD +
  own units
- Admin sees platform-wide totals
- occupancyRate = round(100 * active / total)
- Zero units → occupancyRate 0 (no divide-by-zero)
- Non-owner without payments.view_all → 403
- Monthly array is last 6 months sorted DESC

**GET /monthly-statement — 6 cases**
- Happy: explicit year+month returns expected shape
- **S408 finding A:** defaults to LAST calendar month
  when ?month omitted (pinned pre-fix behavior)
- **S408 finding B:** summary.totalPlatformFees uses
  stale $15/unit hardcode (pinned pre-fix value)
- Caller with perm but no landlord scope → 400
- Non-owner without payments.view_all → 403
- Cross-landlord: payments returned are caller-scoped only

**GET /tax-summary — 6 cases**
- Happy: returns year, landlord, income, deductions,
  deposits, w2099Threshold
- totalRent sums settled payments for the year
  (excludes prior-year payments)
- **S408 finding B:** deductions.platformFees uses
  stale $15/non-vacant-unit hardcode
- w2099Threshold filters work trade with ytd_value
  ≥ 600
- Owner without books.view auto-passes via OWNER_ROLES
- Bookkeeper without books.view → 403

**GET /property-pl — 5 cases**
- Happy: returns properties array scoped to caller
- rent_collected sums settled payments in year window
- month filter narrows window
- **S408 finding B:** platform_fees uses stale $15
  hardcode (year mode: $15*12, month mode: $15)
- Non-owner without payments.view_all → 403

**GET /work-trade-1099 — 5 cases**
- **S408 fix happy:** returns landlord, agreements,
  eligible, summary (was 500 pre-fix)
- eligible1099Count = agreements with ytd_value ≥ 600
- Cross-landlord agreements not returned
- Non-owner without books.view → 403
- Caller without landlord scope → 400

## Files touched

```
apps/api/src/routes/
  reports.ts                           (1 surgical fix:
                                         drop broken
                                         t.ein SELECT)
  reports.test.ts                      (NEW — ~470 lines,
                                         28 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the dead `/work-trade-1099` route in the same pass? | **Yes — fix-it-right.** Production route was completely non-functional; surgical fix (drop one column from SELECT). The TIN-storage question is a separate hygiene item — don't conflate. |
| Fix the stale $15 hardcode in S408? | **No — flag, defer.** Three routes affected; needs product input on historical-vs-current pricing; needs platform_fee_accruals integration. Bundle into hygiene session. Pinning current value in tests creates visible regression when fixed. |
| Fix the monthly-statement off-by-one in S408? | **No — flag, defer.** Could be deliberate (statement showing completed month). Needs product input. Pinning in tests so the deliberate-or-fix question is visible. |
| Pin BOTH findings as test cases? | **Yes — pin current behavior** so any fix surfaces as a test diff. This is the standard pre-fix-pinning pattern from earlier slices. |
| Test cross-landlord scoping on every list route? | **Yes — uniform contract.** Reports surfaces are financial data; cross-tenant leakage is the highest-impact bug class for the file. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1782 tests across 95 files,
  0 failures**, 1337.08s. **Twelfth consecutive fully-
  green full-suite run.**
- 28 new test cases.
- 1 production bug fix (`/work-trade-1099` dead route).
- 2 architectural findings (monthly-statement off-by-one,
  $15 hardcoded fee across 3 routes).
- 0 production regressions.

## ROUTE-TEST SWEEP ARC SUMMARY (S375 — S408, 34 sessions)

Closed today. Cumulative arc totals:

- **44 production bug fixes** across 34 sessions
  - 1 CRITICAL (S401 SQL injection on bulletin/landlord)
  - 4 HIGH (eviction-mode dead route S400, double-bill
    on initiate-rent-collection S407, dead /reveal route
    S401, dead /work-trade-1099 S408)
  - The rest medium / low — cross-tenant scope bypasses,
    XSS extension-mismatch (4 instances), metadata
    override, team-role landlord-id misresolution,
    payment-method ownership verify
- **29 architectural / validation findings flagged**
- **1782 tests across 95 files** — 0 failures
- ~95% of audited route files now have coverage
  (~400 / 422 routes; the residuals are walkthrough-
  blocked /:id/economics, background.ts/Checkr, and
  a handful of routes deemed redundant to other
  slices)

## Items deferred — what S409 could target

The route-test sweep arc is closed. Three larger arcs
remain:

### A. Validation-hygiene micro-session (now 29 items)

S407 carryover (27) + S408 finding A (monthly-statement
off-by-one) + S408 finding B (stale $15 platform fee in
3 routes). Plus the S398 product decisions:
- S376 rent-reporting label rename
- S377 invite token (3 sub-fixes)
- S380 avatar XSS strong fix
- S380 email validation (3 sub-fixes)
- S384 contractor required fields
- S386 overpayment policy

Estimated 1-2 sessions to clear.

### B. Services audit (~80 service files)

No coverage today. Same per-file slice pattern as the
route arc; ~30 sessions of work.

### C. Jobs audit (~15 job files)

Several already have slice coverage (allocation,
lateFees, moveInBundle, monthlyFeeAccrual). Remaining
~10 files; ~5 sessions of work.

### D. background.ts + Checkr wire-up (UNBLOCKED)

Credentials in hand per memory. Different arc — live
API integration. Estimated 2-3 sessions.

### Pending Nic decisions

- S398 product decisions (6 items) — captured in memory
- S408 finding A (monthly-statement default) — new
- S408 finding B implementation approach — new

### Cumulative bug-sweep totals (post-S408)

- **44 production bug fixes** (+1 in S408)
- 29 architectural / validation findings flagged
- 1782 tests covering ~400 of 422 audited routes (~95%)

## What S409 should target — RECOMMEND CHOOSING A PHASE

The route-test sweep is closed. Next phase choices
(needs Nic input):

1. **Validation-hygiene micro-session** — Clear the
   29-item backlog + 6 S398 product decisions.
   Highest-density work; smallest sessions; closes the
   "loose ends" docket. **Recommended next.**

2. **Checkr wire-up (background.ts)** — Unblocks the
   live background-check integration. Per memory:
   credentials in hand. Different kind of work (live
   API).

3. **Services audit** — Largest remaining arc; same
   pattern as route sweep. Probably 30 sessions.

4. **Jobs audit** — ~10 files; ~5 sessions.

---

End of S408 handoff. **reports.ts arc CLOSED at 5/5
routes (100%).** Slice / 28 tests / 1 HIGH-severity
production bug fix (`/work-trade-1099` was dead in
production) / 2 architectural findings flagged.

**ROUTE-TEST SWEEP ARC CLOSED.** 44 cumulative
production bug fixes shipped across 34 sessions.

1782 tests / 95 files / 0 failures. Twelfth
consecutive fully-green full-suite run.

Next phase: Nic picks between hygiene micro-session,
Checkr wire-up, services audit, or jobs audit.

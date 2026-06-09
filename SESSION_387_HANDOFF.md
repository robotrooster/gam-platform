# Session 387 — closed

## Theme

**books.ts arc CLOSED at 40/40 routes (100%).**
Slice 5 of 5: reports — pl + balance-sheet + cash-flow +
owner-statements + tax/summary + rent-roll (6 routes).

The slice surfaced **2 production bugs**, both
"over-restricting" scope-key bugs (the inverse of the
under-restricting cluster from S385+S386). 16 new test
cases pin the slice + the fixes.

Suite at S386 close: **1264 / 74 files**.
Suite at S387 close: **1280 / 75 files** (+16 cases, +1 file).
Runtime ~700s.

**Two pre-existing tests failing in the suite run.**
Both are timezone-boundary flakes in unrelated files
(`csvImportTenantBalance.test.ts` + `esign.test.ts`).
Discussed below; NOT regressions from S387 work.

Zero tsc regressions, zero S387-introduced regressions.

## Bugs found + fixed

Same root cause as S385+S386 cross-tenant cluster — wrong
scope key used — but **inverted direction**: pre-S387,
these routes were OVER-restricting (filtering out legit
bookkeeper/admin views) instead of under-restricting
(exposing cross-tenant data).

### Bug 1 — GET /reports/pl rentIncome scope key

**Symptom:** the rentIncome aggregation subqueried
`landlords WHERE user_id=$1` with `req.user.userId`.
- For landlord callers: `userId` matches `landlords.user_id`
  → returns correct rent income (by coincidence).
- For admin callers: `userId` is the admin's user_id, which
  doesn't match any landlord row → returns $0.
- For bookkeeper callers: same — bookkeeper's `userId`
  matches no landlord → returns $0.

The route had `.catch(() => ({ rows: [{ total: 0 }] }))`
swallowing any error, so the bug presented as
"gamRentIncome silently equals 0 for non-landlord callers."

**Fix:** drop the user_id subquery; use `lid` directly
against `payments.landlord_id` — same shape as every
other report query in the file. Two test cases pin both
the admin and bookkeeper-scoped read paths.

### Bug 2 — GET /rent-roll over-restrictive AND clause

**Symptom:** the WHERE clause had a redundant
`AND ($2::boolean OR l.user_id = $3::uuid)` after the
correct `l.id = $1::uuid` scope filter. The second clause
was meant to enforce ownership but used `l.user_id =
caller.userId` — same broken assumption as Bug 1. For
bookkeepers with valid X-Client-Id scope, the
`l.id = lid` filter correctly narrowed to the assigned
client, but the redundant clause then filtered out
every row (bookkeeper user_id matches no landlord).

**Fix:** drop the redundant clause. The `l.id = lid`
filter is set by `landlordScope()` (which the S383
middleware enforces for bookkeepers via X-Client-Id
validation against bookkeeper_scopes). That's the
correct trust boundary; the user_id check was
duplicative and buggy.

### Cross-tenant scope-key audit signal — strengthened

**8 bug fixes across S385+S386+S387** in `books.ts`
alone, all variants of "wrong scope key used":
- 3 under-restricting (write paths granting cross-tenant)
- 3 cross-tenant ID-not-validated (journal/tx/bills)
- 2 over-restricting (bookkeeper-invisible reports)

The cross-tenant pattern audit (recommended since S383)
is now overdue. **Next slot it before moving to esign /
credit / pm.** Pattern signatures grew to include:
- `landlord_id = $N` where $N from `req.body`
- `user_id = req.user.userId` used as proxy for landlord
  scope (the S387 bugs)
- `WHERE id = $N AND (landlord_id = $M OR $M IS NULL)`
  with $M from user-controlled body
- Any `<scope>Id` in INSERT/UPDATE/DELETE without
  ownership check
- Any `user_id =` predicate used where `landlord_id =`
  is the intended trust boundary

## Items shipped

### Test coverage — 16 cases / 6 describe blocks

New file: `apps/api/src/routes/books-reports.test.ts`

**GET /reports/pl — 4 cases**
- Empty: zero totals + empty period arrays + 1 income +
  1 expense account (both at period_amount=0)
- Happy: posts two balanced journal entries (income +
  expense), verifies totalIncome=1000, totalExpenses=300,
  netIncome=700
- **S387 fix: bookkeeper sees rent income** (was: $0)
- **S387 fix: admin sees rent income** (was: $0)

**GET /reports/balance-sheet — 3 cases**
- Groups by asset/liability/equity; balances=true on
  Assets = Liab + Equity
- Out-of-balance: balances=false
- Cross-landlord: landlord B sees empty arrays (no
  accounts on B)

**GET /reports/cash-flow — 2 cases**
- Aggregates rent (1500) + tx income (200) + tx expense
  (100); net = 1600; netCashFlow = 1600
- Bookkeeper with X-Client-Id sees client cash flow

**GET /reports/owner-statements — 2 cases**
- Landlord-scoped: returns 1 statement
- Admin sees all landlords (2 statements)

**GET /tax/summary — 1 case**
- Rolls up YTD payroll + 1099 contractors (≥$600
  threshold filter) + employees + filingDeadlines

**GET /rent-roll — 4 cases**
- Landlord sees their own units
- **S387 fix: bookkeeper sees client rent roll** (was: empty)
- Admin sees rent roll across landlords
- Cross-landlord isolation: landlord B sees empty units array

## Files touched

```
apps/api/src/routes/
  books.ts                              (MODIFIED — 2 scope-
                                         key bug fixes)
  books-reports.test.ts                 (NEW — 412 lines,
                                         16 cases)
```

No migrations. No schema changes. No frontend touched.

## Two pre-existing TZ flakes in the full suite

The slice's own test file is 16/16 green. The full-suite
run surfaced 2 failures in unrelated files:

- `csvImportTenantBalance.test.ts:207` — asserts
  `Postgres CURRENT_DATE` (server-local TZ) equals
  `new Date().toISOString().slice(0,10)` (UTC).
- `esign.test.ts:2192` — same pattern on a
  `landlord_consent_date` field.

Both fail right now because the system-local date
(2026-05-31 evening) is one day behind UTC (already
2026-06-01). Re-running the suite tomorrow morning
(both clocks aligned) would pass.

**Not regressions from S387.** Both tests were green
through S386's suite run earlier today; the difference
is the current clock position relative to UTC midnight,
not any code change.

The right fix: replace the JS-side `new Date().toISOString()`
in both tests with a Postgres-side `SELECT CURRENT_DATE`
read so both sides use the same TZ. One-line change per
test. Flagged as a follow-up; **NOT bundling into S387**
because the slice's scope is books.ts arc closure, and
the fixes touch two unrelated files.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the two TZ flakes in pass to make the suite green? | **No — flag.** They're in unrelated files; fixing them under "books.ts slice 5" would muddy the diff. The fix is a 1-line change per test (read CURRENT_DATE from Postgres instead of computing in JS). One follow-up commit, separately. The S387 slice itself is 16/16 green; suite-level failure is a known TZ-boundary flake unrelated to S387 work. |
| Test the over-restriction fix at the contract level (bookkeeper sees data) or at the SQL level (the predicate is gone)? | **Contract level.** "Bookkeeper with valid X-Client-Id sees client rent roll" maps directly to the user-visible bug. A SQL-level test would catch the symptom but not the user impact. |
| Pin the `gamRentIncome` value to a specific dollar amount or just "non-zero"? | **Specific amount.** $1500 seeded payment → expect $1500 in response. Pre-fix would have asserted $0 for admin/bookkeeper and the test fails. Specific value catches future "off by one column" regressions too. |
| Seed accounts via the route or raw INSERT? | **Raw INSERT in the fixture.** The 5 account rows (one of each type) are scaffolding for reports tests; using the route would couple the fixture to POST /accounts contract changes. Raw insert is fine — slice 1 already tested the POST. |
| Test cross-landlord isolation on balance-sheet + rent-roll explicitly? | **Yes.** With S385+S386+S387 cluster of scope bugs in this file, every cross-landlord pin is cheap insurance against the next refactor accidentally re-opening the gate. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npx vitest run src/routes/books-reports.test.ts`:
  **16/16 passed, 24.56s.**
- Full `npm test`: **1278/1280 passed, 73/75 files**.
  Two pre-existing TZ flakes (unrelated to S387) — see
  above section.
- **2 production bug fixes** (gamRentIncome scope key +
  rent-roll over-restriction).
- 0 production regressions from S387 work.

## books.ts arc summary (S383–S387, 5 sessions)

| Slice | Session | Routes | Tests | Bugs fixed |
|---|---|---:|---:|---:|
| 1 | S383 | accounts + employees (8) | 20 | 1 CRITICAL (cross-tenant scope bypass via missing X-Client-Id) |
| 2 | S384 | contractors + vendors (6) | 12 | 0 (2 findings flagged) |
| 3 | S385 | payroll + bookkeeper-mgmt (10) | 26 | 3 HIGH (cross-landlord grant/assign/revoke) |
| 4 | S386 | journal + transactions + bills (10) | 27 | 4 (1 CRITICAL always-500 endpoint + 3 cross-tenant scope) |
| 5 | S387 | reports (6) | 16 | 2 (over-restricting scope-key bugs) |
| **Total** | **S383–S387** | **40 / 40 (100%)** | **101** | **10 production fixes + 3 findings flagged** |

**Bug yield: 2.0 fixes per session** — significantly
higher than the tenants.ts arc rate (1.0 per session).
The audit's "critical band" classification of books.ts
as #1 priority was correct; the audit's bug-yield
estimate for the critical band (40-60 across 7 files)
is on pace or higher.

## Items deferred — what S388 could target

### **STRONGLY recommended: cross-tenant scope-bypass pattern audit**

Now overdue. 8 instances across books.ts in 3 sessions
— the codebase-wide grep should yield 5-15 more across
the remaining 252 uncovered routes (esign, credit, pm,
properties, units, etc.). One dedicated session.

The grep is now well-defined (see "Cross-tenant scope-key
audit signal" section above). Output: a prioritized list
of every route file with a suspect predicate, ranked by
severity.

### Pre-existing TZ flake fix (low priority)

Replace `new Date().toISOString()` with `SELECT CURRENT_DATE`
in `csvImportTenantBalance.test.ts:207` and
`esign.test.ts:2192`. One-line each. Run between today's
midnight UTC and the next ~24h to verify the fix doesn't
introduce any inverse flake.

### Next route file (after pattern audit)

Per COVERAGE_AUDIT_S382.md ranking:
- **background.ts** (25/25, 0% covered) — but **parked
  for Checkr fresh-context session per locked priority**
- **pos.ts** (23/55 uncovered, 58% covered) — inventory /
  vendor / PO / low-stock paths
- **maintenance-portal.ts** (17/17, 0%) — field-tech
  daily tasks + scheduled maint
- **esign.ts** (16/25 uncovered, 36%) — envelope /
  signer / template flows
- **credit.ts** (16/16, 0%) — credit-ledger route layer

Recommend **pos.ts inventory slice** (or
maintenance-portal.ts) next after the pattern audit.
Both have high coverage gaps in non-Checkr territory.

### Pending Nic decisions (accumulated)

Unchanged from S386 close:
- (S376) FlexCredit ↔ rent-reporting naming
- (S377) Invite token leakage / column overload / expiry
- (S380) Avatar upload XSS posture
- (S380) PATCH /profile email validation policy
- (S384) POST /contractors required-field rule
- (S386) POST /bills/:id/pay overpayment policy
- Consumer-side retention framing (S300)
- FlexCredit Lender partner
- SLA § 9.1.4(iii) deposit-return offset
- Stripe live keys / Resend / Plaid / Stripe Terminal

### Per directive: fix all bugs before Checkr

books.ts arc: 5 sessions, **10 production bugs fixed**,
40/40 routes covered. Arc complete. Per audit estimate
~40-50 more sessions to close all remaining uncovered
routes; expected ~30-50 more bugs at the current yield
rate.

## Items deferred (cross-session docket, post-S387)

(Unchanged from S386 + the pre-existing TZ flake fix and
the books arc completion record.)

## What S388 should target

**Recommended: cross-tenant scope-bypass pattern audit
across all routes/*.ts.** One session. Outputs a
prioritized list of suspect predicates to fix.

After the audit: the next slice of un-Checkr critical-band
work (pos.ts inventory or maintenance-portal.ts).

---

End of S387 handoff. **books.ts arc CLOSED at 40/40
routes (100%).** Slice 5 / 6 routes / 16 tests / 2
production bug fixes (over-restricting scope-key bugs
in /reports/pl + /rent-roll).

Across the 5-session books arc: **101 new tests, 10
production bug fixes** (1 CRITICAL bookkeeper read
bypass, 3 HIGH cross-landlord writes, 1 CRITICAL
always-500 endpoint, 3 cross-tenant ID validation, 2
over-restricting scope keys). The cross-tenant
scope-bypass pattern is the dominant theme — 8 of 10
bug fixes were variants of it. **The codebase-wide
pattern audit is now the highest-yield single session
left in the docket.**

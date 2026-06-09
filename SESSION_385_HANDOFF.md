# Session 385 — closed

## Theme

**books.ts arc slice 3 of 5:** payroll runs + bookkeeper
invites/assigns/revokes (10 routes — biggest single
slice in the books arc).

The slice surfaced **3 production bugs**, all
HIGH-severity cross-landlord scope bypasses in the
bookkeeper write paths. All three fixed in the same
pass. Same class as the S383 read-path bypass — pattern
audit recommendation reinforced.

26 new test cases pin the slice + all 3 fixes.

Suite at S384 close: **1211 / 72 files**.
Suite at S385 close: **1237 / 73 files** (+26 cases, +1 file).
Runtime ~739s (slowest yet — payroll txns + bookkeeper
flows are DB-heavy).

Zero tsc regressions, zero production regressions.

## Bugs found + fixed — 3 HIGH-severity cross-landlord
scope bypasses

All three bugs share the same shape: a landlord caller
passes a `landlordId` (or `landlordIds[]`) parameter in
the request body, and the route uses it directly in
INSERT/DELETE against `bookkeeper_scopes` with no check
that the caller actually owns that landlord_id. Admin
callers legitimately need cross-landlord authority; the
fixes preserve that.

### Bug 1 — POST /bookkeeper/invite cross-tenant grant

**Pre-fix:** `landlordIds: [<any-other-landlord-id>]` in
the body created a `bookkeeper_scopes` row pointing at
the stranger landlord. Landlord A could effectively grant
a proxy bookkeeper read/write access to Landlord B's
books — privilege escalation across the multi-tenant
boundary.

**Fix:** if caller role is landlord, every entry in
`landlordIds` must equal `req.user.profileId`. Reject 403
otherwise.

### Bug 2 — POST /bookkeeper/assign cross-tenant grant

**Pre-fix:** same flaw, narrower surface — landlord caller
could assign an existing bookkeeper to any other landlord
by passing that landlord's id.

**Fix:** identical pattern — landlord caller's
`landlordId` must equal `req.user.profileId`.

### Bug 3 — DELETE /bookkeeper/revoke cross-tenant DoS

**Pre-fix:** landlord A could revoke landlord B's
bookkeeper at will by passing the `bookkeeperUserId` +
`landlordId: <B's id>`. **Denial-of-service across the
multi-tenant boundary** — A pre-launch landlord could
sabotage another's books access. Also no missing-field
check (could send `{}` and call the DELETE on nothing,
which returned 200 success).

**Fix:** same landlord-must-match-own-profileId guard +
added `bookkeeperUserId && landlordId required` 400.

### Combined with S383

S383 fixed the *read-side* bookkeeper bypass (a
bookkeeper with no X-Client-Id seeing all landlords'
data). S385 fixes the *write-side* bypasses on the
inverse: a landlord granting/assigning/revoking
bookkeeper scopes against landlords they don't own.

**Two arcs are now covered:**
- *bookkeeper acting on landlord's data* → S383
- *landlord acting on another landlord's bookkeeper
  relationships* → S385

The audit recommendation from S383 was a "cross-tenant
scope-bypass pattern audit" — grep every `WHERE X=$1 OR
$1 IS NULL` for $1 derived from user-controlled inputs.
S385 reinforces that recommendation; the same pattern
keeps surfacing. **Worth a dedicated session** before the
books arc closes.

## Items shipped

### Test coverage — 26 cases / 10 describe blocks

New file: `apps/api/src/routes/books-payroll-bookkeeper.test.ts`

**Payroll runs — 11 cases**
- GET /payroll/runs landlord-scoped (1)
- GET /:id unknown → 404; cross-landlord blocked → 404;
  happy with employee-name join (3)
- POST /payroll/runs missing fields → 400; no active
  employees → 400; happy salary + biweekly math (2000 =
  52000/26) with totals matching line sums; happy hourly
  with hoursMap (4)
- POST /:id/approve unknown → 404; non-draft → 400; happy
  flips status + bumps YTD totals on employee row (3)

**Bookkeeper management — 15 cases (including 3 security pins)**
- GET /clients bookkeeper-self / admin-cross / landlord-403 (3)
- GET /all admin / non-admin 403 (2)
- POST /invite missing → 400; **landlord cross-tenant
  → 403 (S385 fix)**; landlord-own → 201; admin
  multi-landlord → 201 (4)
- POST /assign **landlord cross-tenant → 403 (S385
  fix)**; happy upsert downgrade (2)
- DELETE /revoke **landlord cross-tenant → 403 + row
  intact (S385 fix)**; landlord-own → row removed (2)
- POST /payroll/runs/:id/void already-voided → 400;
  voiding an approved run reverses YTD (2)

### Test infra updates

cleanupAllSchema now includes `payroll_runs` (added
before `books_employees` clear because
`payroll_run_lines` is RESTRICT-FK to employees).
Cumulative S381–S385 cleanup additions:
- work_trade_agreements (S381)
- books_accounts (S383)
- books_employees (S383)
- books_contractors (S384)
- books_vendors (S384)
- payroll_runs (S385)

## Files touched

```
apps/api/src/routes/
  books.ts                              (MODIFIED — 3 scope-
                                         bypass fixes on
                                         bookkeeper write
                                         routes)
  books-payroll-bookkeeper.test.ts      (NEW — 388 lines,
                                         26 cases)

apps/api/src/test/
  dbHelpers.ts                          (MODIFIED — added
                                         payroll_runs to
                                         cleanupAllSchema)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix all 3 bypass bugs in one pass or split? | **One pass.** Same root cause, same fix shape (5-line check per route), same test fixture. Splitting would triple the handoff overhead and the bugs are mutually reinforcing — leaving one unfixed undermines the security posture of the other two. |
| Test the payroll tax math in detail or just shape? | **Shape, not math.** `calcTaxes` already has implicit coverage via the happy-path test asserting that line totals = run totals. Re-deriving the exact federal/SS/medicare/state numbers in the test would couple the test to the simplified-IRS-tables comment ("production would use IRS tables") which is itself a known approximation. Pinning shape + relationships (totals = sum of lines) is the right contract level. |
| Test the upsert behavior on POST /bookkeeper/assign? | **Yes — explicit downgrade test.** The route uses ON CONFLICT DO UPDATE. A future refactor to ON CONFLICT DO NOTHING would silently leave old access_level in place, which is a real footgun for revocation flows. The "re-assign read_write scope as read_only" test catches that. |
| Test the YTD reversal math on void exactly or just relationship? | **Exactly = 0.** The test seeds an approved run with known YTD totals, voids it, and asserts YTD returns to exactly 0. A future refactor that uses `ytd_gross - line.gross_pay` instead of GREATEST(0, ytd_gross - line.gross_pay) would still pass this test, but a refactor that breaks the line-iteration loop would not. Catch-rate is acceptable for the cost. |
| Cover GET /bookkeeper/clients despite the route having its own pre-auth bypass path? | **Yes.** The route was the lone exception to the S383 middleware fix; pinning its 3-role contract (bookkeeper-self / admin-all / landlord-403) documents the deliberate carve-out and would catch a future "make this middleware-aware" refactor that breaks the discovery flow. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1237 tests across 73 files,
  0 failures**, 738.63s.
- 26 new test cases.
- **3 production bug fixes** (cross-landlord scope
  bypasses on bookkeeper invite/assign/revoke).
- 0 production regressions.

## Items deferred — what S386 could target

### books.ts arc remaining

S383 + S384 + S385 covered 24 of 40 books.ts routes
(60%). Two slices to close:

- **Slice 4 — journal + transactions + bills** (~9
  routes). Double-entry bookkeeping — high yield if the
  journal lines don't enforce DR=CR balance, or if the
  reconciliation paths skip permission checks.
- **Slice 5 — reports** (p&l / balance-sheet /
  cash-flow / owner / tax / rent-roll, ~6 routes).
  Aggregations only. Lower yield unless joins are off.

**Recommend slice 4 (journal/transactions/bills) for
S386.** Same money-handling severity as payroll; if
there's a double-entry imbalance bug, it'll surface
here.

### Pattern audit RECOMMENDED for S387 or sooner

The S383+S385 pattern (cross-tenant scope checks
missing on routes that take a `<scope>Id` from
request body) keeps surfacing in this arc. **One
dedicated session to grep every routes/*.ts for the
pattern would likely surface 5-15 more instances**
across the rest of the codebase. Pattern signatures
to grep for:

- `landlord_id = $N` where $N comes from `req.body.*`
- `WHERE id = $N AND (landlord_id = $M OR $M IS NULL)`
  with $M from user-controlled scope helper
- Any `tenant_id`, `landlord_id`, `pm_company_id`,
  `unit_id` used in WHERE/INSERT/DELETE without an
  explicit ownership check

Worth slotting between books slice 4 and slice 5 —
either way before moving to other route files (esign,
credit, pm, properties).

### Pending Nic decisions (carried)

Unchanged from S381–S384:
- (S376) FlexCredit ↔ rent-reporting naming
- (S377) Invite token leakage / column overload / expiry
- (S380) Avatar upload XSS posture
- (S380) PATCH /profile email validation policy
- (S384) POST /contractors required-field rule
- Consumer-side retention framing (S300)
- FlexCredit Lender partner
- SLA § 9.1.4(iii) deposit-return offset
- Stripe live keys / Resend / Plaid / Stripe Terminal

### Per directive: fix all bugs before Checkr

books.ts arc continues. ~30 sessions of test-arc work
remaining per audit estimate. The bug-yield rate so far
in the books arc: **4 production fixes across 3 slices
(S383/S385) — higher than the tenants.ts arc rate of 1
per ~5 routes.** Recommended budget: 2 more slices to
close books.ts, then the cross-tenant pattern audit,
then move to esign / credit / pm.

## Items deferred (cross-session docket, post-S385)

Unchanged from S384 close + the 3 new findings folded
into the S385 fixes (which are no longer deferred — they
shipped). The pattern-audit recommendation moves up
from "carried" to "recommended next-after-slice-4."

## Nic-pending

Unchanged from S384.

## What S386 should target

**Recommended:** books.ts slice 4 — journal +
transactions + bills (~9 routes, ~18-22 tests). Same
money-handling severity as payroll; double-entry
correctness is the high-yield surface.

After slice 4: cross-tenant scope-bypass pattern audit
(1 session) before slice 5 (reports). Then close books
arc and move to the next critical-band file (esign or
credit per audit ranking).

---

End of S385 handoff. **books.ts slice 3 / 10 routes / 26
tests / 3 HIGH-severity bug fixes (cross-landlord
bookkeeper scope grant/assign/revoke).** 1237 tests / 73
files / 0 failures.

The bookkeeper scope-bypass cluster (S383 read-side +
S385 write-side) is the second multi-bug security
finding of the bug sweep, after the tenants.ts S377
invite-flow cluster. Both clusters were the same kind:
auth/scope middleware misapplied or skipped. **The
cross-tenant scope-bypass pattern audit is now the
highest-yield single session in the docket** —
recommend slotting it after books slice 4.

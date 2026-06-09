# Session 383 — closed

## Theme

**books.ts arc opens. Slice 1 of 5:** accounts CRUD +
employees CRUD (8 routes).

Per Nic's directive "we need to fix all bugs before
Checkr," the cross-portal bug sweep continues (per
COVERAGE_AUDIT_S382.md priority order: books.ts is the
highest-yield untested file in the codebase).

The slice surfaced **1 critical-severity production
bug**: cross-tenant privilege escalation in the bookkeeper
client-scope middleware. Fixed in the same pass.

20 new test cases pin the slice + the fix.

Suite at S382 close: **1179 / 70 files** (no test work
in S382, just the audit).
Suite at S383 close: **1199 / 71 files** (+20 cases, +1 file).
Runtime ~656s.

Zero tsc regressions, zero production regressions.

## Bug found + fixed — CRITICAL: bookkeeper cross-tenant
scope bypass

### Symptom

The X-Client-Id middleware in `books.ts` (pre-fix lines
17-23) read the header value blindly and stored it on
`req.user.activeClientId`, with no validation that the
bookkeeper actually had a `bookkeeper_scopes` row for
the claimed landlord. The `landlordScope` helper
returned `activeClientId || null`, so:

- A bookkeeper request with **no X-Client-Id header** →
  `activeClientId = null` → `landlordScope` returns `null`.
- A bookkeeper request with **X-Client-Id pointing at any
  random landlord id** → `activeClientId = that-id` →
  `landlordScope` returns the unverified value.

Every books.ts SQL guard is of the shape:
```sql
WHERE (landlord_id = $1 OR $1 IS NULL)
```

With `$1 = null` (case 1), the predicate becomes
`landlord_id = NULL OR NULL IS NULL` → `OR TRUE` →
**matches every row across every landlord**. A bookkeeper
invited by Landlord A could:
- GET /api/books/accounts → see every account across
  every landlord in the system
- PATCH /api/books/accounts/<any-id> → modify any
  account
- DELETE /api/books/accounts/<any-id> → soft-delete any
  account
- Same on /employees, /contractors, /vendors, /payroll,
  /journal, /transactions, /bills, /reports — every
  route that uses landlordScope (~35 routes in books.ts)

With case 2 (X-Client-Id set to a stranger landlord),
the bookkeeper could narrowly target one specific other
landlord's books without even needing to know
landlord-IDs across the system.

This bug has been live since the bookkeeper subsystem
shipped (S91 era). **Estimated severity: critical.**
Bookkeeper role is intentionally cross-landlord by design
(a single bookkeeper can be assigned to multiple
landlords), so the impact surface is exactly the set of
landlords who have ever invited a bookkeeper.

### Fix

Rewrote the middleware to:
1. Require `X-Client-Id` header for bookkeeper requests
   (400 if missing).
2. Look up the claimed `landlord_id` in
   `bookkeeper_scopes` for the calling bookkeeper's
   `user_id` (403 if not assigned).
3. Re-stamp `permissions.access_level` from the live
   scope row onto `req.user.permissions`. This means a
   revoked scope (or a downgraded access_level) takes
   effect on the very next request instead of being
   stuck on the JWT's signed-at-login value until token
   expiry.

Discovery routes (`GET /bookkeeper/clients`) are
explicitly exempted — that endpoint IS how a bookkeeper
discovers their valid clients, so it must work without
an X-Client-Id.

### Verification

The slice 1 test file pins all three branches:
- `bookkeeper WITHOUT X-Client-Id → 400` — was a bypass,
  now blocked
- `bookkeeper WITH X-Client-Id pointing at unassigned
  landlord → 403` — was cross-tenant access, now blocked
- `bookkeeper with no scopes at all → 403 on any client
  id` — confirms the deny-by-default posture
- `bookkeeper WITH valid X-Client-Id → 200, scoped to
  that client` — happy path
- `bookkeeper JWT claims read_write but live scope is
  read_only → middleware re-stamps; writes blocked` —
  confirms the access_level re-stamping

## Items shipped

### Test coverage — 20 cases / 7 describe blocks

New file: `apps/api/src/routes/books-accounts-employees.test.ts`

**Security: bookkeeper scope validation — 5 cases**
- Missing X-Client-Id → 400 (S383 fix verification)
- X-Client-Id on unassigned landlord → 403
- Bookkeeper with no scopes → 403 on any client id
- Valid X-Client-Id → 200 scoped to that client only
- JWT read_write but live scope read_only → write blocked

**GET /accounts — 2 cases**
- Landlord sees only their own active accounts (excludes
  inactive)
- Admin sees all active accounts across landlords

**POST /accounts — 3 cases**
- Missing code/name/type → 400
- Duplicate code per landlord → 409
- Happy 201 with landlord_id scoping

**PATCH /accounts/:id — 2 cases**
- Cross-landlord modify blocked → 404 (verifies the SQL
  guard works for landlord callers — separate from the
  bookkeeper bypass)
- COALESCE-update preserves untouched fields

**DELETE /accounts/:id — 1 case**
- Soft-deletes (active=FALSE) + subsequent GET excludes

**POST /accounts/seed — 1 case**
- Seeds 41 standard accounts + idempotent on re-call
  (route's "exists" check correctly skips on second pass)

**GET /employees — 1 case**
- Landlord-scoped

**POST /employees — 2 cases**
- Missing required fields → 400
- Happy 201 + `azWithholdingPct` legacy alias maps to
  `state_withholding_pct` (S91 backward-compat retained)
- `stateWithholdingPct` takes precedence over legacy

**PATCH /employees/:id — 2 cases**
- Cross-landlord blocked → 404
- COALESCE-update preserves untouched fields

## Files touched

```
apps/api/src/routes/
  books.ts                              (MODIFIED — bookkeeper
                                         scope-bypass fix)
  books-accounts-employees.test.ts      (NEW — 380 lines, 20 cases)

apps/api/src/test/
  dbHelpers.ts                          (MODIFIED — added
                                         books_accounts + books_employees
                                         to cleanupAllSchema)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the scope-bypass in pass or flag? | **Fix in pass.** This is the most severe security finding of the entire bug sweep so far. The fix is contained (one middleware rewrite, ~20 lines), the regression risk is well-bounded (per-request DB lookup adds ~1ms per bookkeeper call), and shipping the slice without the fix would mean writing tests against known-broken behavior. |
| Bundle the access_level re-stamping with the scope-bypass fix, or defer? | **Bundle.** The JWT staleness was a separate but related vulnerability — a bookkeeper whose scope gets revoked could continue acting with their stale JWT until expiry (7 days). Adding the live re-stamping was 3 extra lines in the same middleware function. Cheap defense-in-depth. |
| Add the per-request DB lookup to the middleware, or only at the route level? | **Middleware.** Putting it at the middleware is one place to verify; route-level would mean threading the check through 35+ routes and risking drift. The cost is a single SELECT per bookkeeper request — bookkeeper traffic is low relative to tenant/landlord, so negligible. |
| Test the 41-account seed count explicitly or just "seeds something"? | **Explicit count.** The standard accounts list is hardcoded; a future edit (add/remove a line) would silently change the seed count and the seed.ts call elsewhere might rely on a specific number. Pin to 41 → red flag on accidental list changes. |
| Test the `azWithholdingPct` legacy alias? | **Yes.** S91 explicitly preserved backward-compat for clients that haven't migrated; the test acts as a regression pin against a future "clean up the legacy field" PR that might drop the alias too aggressively. |
| Spot-check the audit's `admin.ts` 100% claim from S382? | **Deferred — out of slice scope.** Not blocking the books arc; can be addressed in S400+ hardening sweep. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1199 tests across 71 files,
  0 failures**, 655.71s.
- 20 new test cases.
- **1 critical-severity bug fix** (bookkeeper cross-
  tenant scope bypass).
- 0 production regressions.

## Items deferred — what S384 could target

### books.ts arc remaining (per audit slice plan)

S383 covered 8 of 40 books.ts routes (20%). Remaining
slices:

- **Slice 2 — contractors + vendors CRUD** (~6 routes).
  Same shape as accounts/employees; should reuse the
  fixture pattern. ~12-15 tests.
- **Slice 3 — payroll runs + bookkeeper invites** (~9
  routes). Payroll has real money-handling (run/approve/
  void); bookkeeper invites are landlord-only actions
  with scope-row creation. Likely highest bug-yield in
  the remaining slices.
- **Slice 4 — journal + transactions + bills** (~9
  routes). Double-entry bookkeeping correctness — high
  bug-yield potential if the journal balances aren't
  enforced.
- **Slice 5 — reports** (p&l / balance-sheet /
  cash-flow / owner-statements / tax / rent-roll, ~7
  routes). Aggregations only; lower bug-yield unless
  the SQL has joins on wrong columns.

**Recommend slice 2 (contractors + vendors) for S384.**
Smallest natural batch; closes the CRUD pattern before
moving to the more complex flows.

### Per Nic's directive: fix all bugs before Checkr

This session is the first slice of the post-tenants.ts
arc. The full worklist per COVERAGE_AUDIT_S382.md is
~40-53 sessions; at the tenants.ts arc bug-yield rate,
the remaining 252 uncovered routes should surface
~50-60 more bugs.

Checkr stays parked.

### Pending Nic decisions (carried, accumulated)

Same as S381–S382:
- (S376) FlexCredit ↔ rent-reporting product naming
- (S377) Invite token leakage / column overload / expiry
- (S380) Avatar upload XSS posture (3 options laid out)
- (S380) PATCH /profile email validation policy
- Consumer-side retention framing (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing
- Stripe live keys / Resend domain / Plaid prod keys /
  Stripe Terminal hardware (vendor signups)

### Hardening flagged (carried + new from S383)

- **schema-drift audit** — HIGH YIELD (9 known instances)
- **Public-route hoist audit** — MEDIUM YIELD
- **silent-failure pattern audit**
- **NEW (S383):** Cross-tenant scope-bypass pattern audit
  — books.ts pattern was `WHERE id=$1 OR $1 IS NULL` with
  $1 from unvalidated user-provided header. Worth
  grepping every route file for any SQL guard whose
  `IS NULL` branch is reachable from non-admin callers.
  Could surface in admin.ts, pm.ts, anywhere multi-tenant
  scoping uses the same pattern.

### Anomalies from S382 audit (carry until verified)

- `admin.ts` shows 100% covered — spot-check before
  declaring done
- `fitness.ts` shows 0 routes / 216 lines — read file to
  confirm dead-code or non-standard registration
- `tenants.ts` shows 39/40 — `DELETE /api/tenants/
  flexdeposit` untested; backfill on next opportunistic
  touch of the file

## Items deferred (cross-session docket, post-S383)

(Carried from S381–S382 with one new addition.)

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
- schema-drift audit (9 instances — HIGH YIELD)
- Public-route hoist audit (2 known instances)
- arc-completeness verification at close time
- **(S383-new)** Cross-tenant scope-bypass pattern audit
  — grep all SQL `WHERE X=$1 OR $1 IS NULL` for non-admin
  exposure
- books.ts remaining slices (2-5): contractors+vendors,
  payroll+bookkeeper-invites, journal+transactions+bills,
  reports
- **(S376–S380)** Nic-pending product decisions
- **(S378)** Route-test coverage audit — done in S382;
  worklist lives at COVERAGE_AUDIT_S382.md
- **NEXT FRESH-CONTEXT SESSION (post-bug-sweep):** Wire
  background.ts → Checkr API (credentials in hand
  2026-05-26)

## Nic-pending

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call
- **(S376)** FlexCredit vs. rent-reporting product disambiguation
- **(S377)** Invite token leakage / column overload / expiry
- **(S380)** Avatar upload XSS posture
- **(S380)** PATCH /profile email validation policy

## What S384 should target

**Recommended path:** books.ts slice 2 — contractors +
vendors CRUD (6 routes). Same fixture pattern as slice
1; ~12-15 tests. Closes the CRUD shapes before the more
complex slices 3-5.

The critical scope-bypass fix landed in slice 1. The
remaining books.ts work should surface lower-severity
issues but is still high-yield (40-route file at 0%
coverage pre-S383, now 20%).

---

End of S383 handoff. **books.ts slice 1 / 8 routes / 20
tests / 1 CRITICAL bug fix (cross-tenant scope bypass
via missing X-Client-Id and / or unverified header
value).** 1199 tests / 71 files / 0 failures.

The bookkeeper scope-bypass fix is the most severe
security finding of the bug sweep to date — any
bookkeeper account in production could read/write/delete
any landlord's books data by omitting one HTTP header.
Worth a heads-up to anyone who's been using the books
subsystem in pre-launch testing with the assumption
that scoping worked.

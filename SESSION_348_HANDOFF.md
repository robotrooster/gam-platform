# Session 348 — closed

## Theme

Pivot from POS to the next-thinnest admin surface per the
S347 recalibration: unwalked admin routes are still surfacing
real runtime bugs at material rate. Picked
`maintenance-portal.ts` (230 lines, 17 routes, **NO TESTS**
pre-S348) as the highest-EV slice.

Recon caught a real **cross-tenant security bug** at
`/scheduled/:id/complete` before writing any tests: both the
SELECT (data leak) and the UPDATE (cross-tenant write) used
`WHERE id=$1` with no landlord scope. Any caller with the
`work_orders.complete` permission (or any owner role) could
mark any landlord's scheduled_maintenance row complete and
read the row contents back via the SELECT data.

Also surfaced and fixed a pattern of **silent-success-on-
missing-row** across 4 PATCH endpoints: `/tasks/:id/complete`,
`/parts/:id`, `/purchases/:id/approve`, `/purchases/:id/deny`
each returned `200 { success: true, data: null }` when the
target row didn't exist or belonged to another landlord. Now
404s. Confusing-UX-bug per route; not security-class but
fix-it-right pass while in the file.

15 new test cases pin the slice + verify both fix categories.
Cleanup helper extended for the 5 new landlord-FK'd tables.

Suite at S347 close: **780 / 37 files**.
Suite at S348 close: **795 / 38 files** (+15 cases, +1 file).

Zero tsc regressions, zero production regressions across the
suite.

## Items shipped

### Bug fixes (5)

**F1 — `/scheduled/:id/complete` cross-tenant scope leak**
- `maintenance-portal.ts:193-216` — added `AND landlord_id=$2`
  to both the SELECT (preventing row-content data leak) and
  the UPDATE (preventing cross-tenant write of last_completed
  + next_due).
- Pre-fix: any caller with `work_orders.complete` permission
  (or owner role bypass) could mark *any landlord's*
  scheduled_maintenance row complete and read the row back.
- Test `F1 fix: cross-landlord id → 404 (no data leak, no
  cross-tenant write)` pins the post-fix scoping. The test
  would have hit 200-with-stamped-data pre-fix; now 404.

**F2 — Silent success on missing row (4 routes)**

Pattern: `UPDATE...RETURNING` followed by
`res.json({ success: true, data: x })` where `x` could be
null. Fixed in same pass:
- `/tasks/:id/complete` — adds `if (!task) throw 404`
- `/parts/:id` PATCH — adds `if (!part) throw 404`
- `/purchases/:id/approve` — adds `if (!pr) throw 404`
- `/purchases/:id/deny` — adds `if (!pr) throw 404`

Pre-fix: clients calling these routes on a deleted, wrong-id,
or cross-landlord target got `200 { success: true, data: null }`,
which any reasonable frontend would either crash on (trying
to read `.id`) or display as a bogus "Success!" toast. Now
clean 404.

### Test coverage — 15 cases / 6 describe blocks

New file: `apps/api/src/routes/maintenancePortal.test.ts`

**Shifts (3)**
- clock-in happy path → row inserted with user_id + landlord_id
- clock-in second call while still clocked in → 400
- clock-out without active shift → 400
- clock-out persists notes + stamps clocked_out_at

**Tasks (2)**
- complete: stamps completed_by + completed_at on landlord-
  scoped row
- F2: cross-landlord task id → 404 (was 200 data:null pre-fix);
  victim row's `completed` stays false

**Parts (2)**
- POST happy path: defaults applied, landlord-scoped
- F2: PATCH cross-landlord id → 404; victim row's quantity
  unchanged

**Purchases (3)**
- POST: items JSONB roundtrip, status=pending default,
  landlord + requester stamped
- approve: status flip, approver/budget stamped, approved_at
  not null
- F2: deny on cross-landlord id → 404; victim row's status
  stays pending

**Scheduled (3)**
- happy path: weekly recurrence bumps next_due by exactly
  7 days from last_completed (pins the recurrenceMap →
  INTERVAL math)
- F1 fix: cross-landlord id → 404; victim row's last_completed
  stays null + next_due stays at original seed value
- unknown id → 404 (not silent success)

**GET /shifts/active (2)**
- returns landlord-scoped active list + myShift for caller
- other landlord's active shifts not returned (landlord-scope)

### Test infra additions

`dbHelpers.cleanupAllSchema` now wipes the 5 maintenance-
portal tables before the `landlords` delete:
- `purchase_requests`, `parts_inventory`, `daily_tasks`,
  `scheduled_maintenance`, `shifts`
- All FK landlords with RESTRICT; pre-S348 the cleanup
  worked only because no prior test had inserted into any
  of them. The first `seedMPFixture` + `clock-in` left a
  `shifts` row that blocked the next test's
  `DELETE FROM landlords`.

### Surfaces NOT covered

Documented in the test file header. The GET endpoints
(`/tasks`, `/parts`, `/purchases`, `/scheduled`, `/work-orders`)
are mechanical SELECTs with landlord-scoped WHERE. Per-surface
GET tests would be low yield; skip until a walkthrough surfaces
something worth pinning.

## Files touched

```
apps/api/src/routes/
  maintenance-portal.ts        (+24 -7 lines: F1 + F2 fixes)
  maintenancePortal.test.ts    (NEW — 235 lines, 15 cases)

apps/api/src/test/
  dbHelpers.ts                 (+10 lines: maintenance-portal cleanup)
```

No migrations. No schema changes. No frontend changes. No
shared-package changes.

## Decisions made during build

| Question | Decision |
|---|---|
| Pick maintenance-portal.ts or one of the larger candidates (entryRequests / scopes / pm / payments)? | **maintenance-portal.** Smallest unwalked admin surface (230 lines) — fits cleanly in one session with depth. Larger files would have spread testing thinner. F1 alone justifies the pick: it's a real cross-tenant security bug that no other admin surface would have surfaced. |
| Fix F1 (security) and F2 (cosmetic) in same pass or split? | **Same pass.** F2 routes were touched by tests that needed clean 404 semantics to assert "victim row untouched after cross-landlord call." The fix is 1 line per route + a comment. Splitting would have left 4 ambiguous 200-data-null routes in the code that the new tests would either (a) skip asserting the right shape, or (b) lock in the broken shape. |
| F2 — broaden to all PATCH routes in landlords.ts / properties.ts / etc? | **No — surgical fix only.** The same `UPDATE...RETURNING` → `res.json data:x` pattern likely exists across other admin route files; the scope here is the file being tested. A broader sweep across all routes would be 30+ files of speculative work with no test coverage to back it up. If a future test slice surfaces the same pattern, fix it there. |
| seedMPFixture re-use seedLandlord or seed a maintenance-worker user with explicit scope perms? | **Re-use seedLandlord (owner role, auto-bypass requirePerm).** Testing the per-permission gate is a different test (auth.requirePerm), not in scope for the route slice. The slice exercises the SQL + landlord scope + business logic. Using a maintenance-worker fixture would have required also seeding maintenance_worker_scopes rows — significant ceremony for zero coverage gain on the routes themselves. |
| F1 fix posture — collapse SELECT + UPDATE into a single UPDATE-with-CTE, or add landlord_id to both queries? | **Add landlord_id to both.** The SELECT loads `item.recurrence` to compute the interval, then the UPDATE runs with the computed value. Combining would require a CTE with the recurrence lookup, which interpolates the same `INTERVAL '${interval}'` string anyway (no way to parameterize a postgres INTERVAL from a column value cleanly). Two-query shape is fine; the bug was missing scope, not the structure. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **795 tests across 38 files, 0
  failures**, ~383s.
- 15 new test cases (`maintenancePortal.test.ts`).
- 5 production bug fixes (F1 + F2 × 4).
- 0 production regressions.

No frontend touched, no shared-package touched, so per-portal
tsc sweeps not needed this session.

## Items deferred — what S349 could target

### Admin-surface route slices still uncovered

Survey from S348 recon (route file → has tests?):

```
admin.ts                 1514  NO TESTS
auth.ts                   566  NO TESTS  (passwordReset/loginLockout/emailVerification/totp cover slices)
background.ts            1065  NO TESTS
bankAccounts.ts           129  NO TESTS
bookings.ts               104  NO TESTS  ← tiny, recently-unblocked per S143
bulletin.ts               261  NO TESTS
books.ts                 1330  NO TESTS  ← cleared from quarantine S145
credit.ts                 839  NO TESTS
disbursements.ts           45  NO TESTS
documents.ts               32  NO TESTS
entryRequests.ts          439  NO TESTS  ← credit-ledger workflow
fitness.ts                215  NO TESTS
landlords.ts             3817  NO TESTS  ← biggest, highest bug-yield potential
maintenance.ts            390  has tests
notifications.ts           84  NO TESTS
payments.ts               429  NO TESTS  ← money path untested
pm.ts                    1078  NO TESTS  ← third-party PM subsystem
posCustomerOnboarding.ts  253  NO TESTS
properties.ts            1025  NO TESTS
reports.ts                489  NO TESTS
scopes.ts                 735  NO TESTS  ← team permissions security-critical
stripe.ts                 279  NO TESTS
subleaseInvitations.ts    269  NO TESTS
tenants.ts               1326  NO TESTS  ← biggest non-admin
terminal.ts                66  NO TESTS
units.ts                  513  NO TESTS
utility.ts                387  NO TESTS
withdrawals.ts            181  NO TESTS  ← money path
workTrade.ts              331  NO TESTS
```

**Recommended next picks (in order):**

1. **`scopes.ts`** (735 lines, NO TESTS) — team permissions
   are security-critical. Maintenance-worker / onsite-manager
   / property-manager scope grants live here. A scope bug
   could give a fired worker continued access or grant an
   onsite manager cross-landlord visibility. Has the same
   "high bug-yield because unwalked admin surface" profile
   as maintenance-portal.
2. **`bookings.ts`** (104 lines, NO TESTS) — tiny, recently-
   unblocked per S143. Fast win + book the Master Schedule
   subsystem into the test suite.
3. **`entryRequests.ts`** (439 lines, NO TESTS) — credit-
   ledger workflow per CLAUDE.md; recent build means recent
   refactor risk.
4. **`landlords.ts`** (3817 lines, NO TESTS) — biggest file
   in the codebase, almost certainly hides multiple
   regressions. Would need a multi-session sweep; pick a
   slice (signup / profile / Connect onboarding / etc.) for
   any single session.

Skip-for-now:
- `payments.ts` (429, NO TESTS) — money path, but
  webhooks.ts + stripeConnectTransfers.test.ts + S345 POS
  payment-intent route tests already cover the meat of the
  flow. Diminishing returns vs. unwalked admin surfaces.
- `documents.ts` / `disbursements.ts` (45-32 lines) — too
  small to be worth a slice; will read 1-2 endpoints when a
  consumer route touches them.

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since S333.
- **responsibleParty source-comment drift fix** — one-liner.

### Hardening flagged (no live risk, carried)

- **action.url scheme validation in adminNotifications** —
  flagged S344.

### Vendor-blocked

- Stripe live keys, Resend domain auth, Plaid production
  keys, Stripe Terminal hardware, Checkr Partner credentials.

### Walkthrough-blocked

- 2FA fan-out (admin-ops / landlord / pm-company / tenant)
- Visual review of reconstructed PmInvitationsPage
- SchedulePage booking-vs-lease shape audit
- Inventory Log page (S347)
- PO management receive flow (S347)
- Scheduled Maintenance worker UI (S348 F1 caught here)

### Dev-team scope

- Deploy host pick + Dockerfile / render.yaml
- Production cron runner
- DB backups + PITR

## Items deferred (cross-session docket, post-S348)

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

## Nic-pending (unchanged)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Checkr Partner credentials
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S349 should target

S347 caught 2 real bugs (1 cosmetic, 1 cosmetic) in 10 tests.
S348 caught 5 real bugs (1 cross-tenant security, 4 cosmetic
silent-success) in 15 tests. **The bug pipeline is not
tapering on unwalked admin surfaces — it may be accelerating.**
Sessions where I scope a route file with NO TESTS, recon
catches real bugs at materially higher rate than money-path
or covered surfaces.

Top recommendation for S349: **`scopes.ts`** (735 lines, NO
TESTS). Permissions code is the highest-class-of-bug surface —
a missing scope check is a security incident, and `scopes.ts`
hasn't been tested or walked since the S80+ team consolidation.
The maintenance-portal F1 bug (cross-tenant scope on one
endpoint) is the kind of thing that's likely to surface 2-3
times in scopes.ts.

Backup picks if scopes.ts is too big to slice cleanly:
- `bookings.ts` (104 lines) — fast win, Master Schedule book-
  in
- `entryRequests.ts` (439) — credit-ledger workflow

Same posture: launch-blockers are vendor / walkthrough /
dev-team. The marginal launch-risk reduction from each route
slice is no longer marginal; admin-surface coverage is paying
off at high rate.

---

End of S348 handoff. Closed clean. 795 tests / 38 files / 0
failures. 5 real bugs caught + fixed: 1 cross-tenant security
(/scheduled/:id/complete) + 4 silent-success-on-missing-row
(tasks/parts/purchases endpoints). maintenance-portal slice
covered. Bug pipeline pattern reconfirmed — unwalked admin
surfaces continue surfacing real bugs at high per-test rate.

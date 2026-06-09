# Session 370 — closed

## Theme

admin.ts arc continues. **Slice 4 of N:** audit log
viewer + invoices backfill + email failures + NACHA
monitoring (4 super_admin/admin routes covering ops-trail
reads + the invoice backfill job-trigger).

The slice surfaced **1 real production bug** —
`/api/admin/nacha/monitoring` referenced a non-existent
column `zero_tolerance_flag` in its stats rollup. Every
call 500s with "column zero_tolerance_flag does not
exist." **The admin NACHA monitoring page has been
broken since the schema landed in this shape.** Same
class as S355's GROUP BY drift bug.

10 new test cases pin the slice including the F1 fix.

Suite at S369 close: **1052 / 58 files**.
Suite at S370 close: **1062 / 59 files** (+10 cases, +1
file).

Zero tsc regressions, zero production regressions.

## Items shipped

### Bug fix (1)

**F1 — `/admin/nacha/monitoring` 500 on every call (missing
column reference)**
- `admin.ts:66-79` — stats query at line 69 referenced
  `COUNT(*) FILTER (WHERE zero_tolerance_flag=TRUE)`. The
  `ach_monitoring_log` schema has no `zero_tolerance_flag`
  column — only `flagged` (boolean) and `event_type` (text
  with CHECK constraint including 'zero_tolerance_block').
- Pre-fix: every call returned 500 with raw postgres
  "column 'zero_tolerance_flag' does not exist" error.
- Fix: changed predicate to `event_type='zero_tolerance_
  block'`. Matches the CHECK enum semantic for the
  specific zero-tolerance event type. Distinct from
  `/overview`'s broader `flagged=TRUE AND resolved=FALSE`
  predicate (which is correct for that route's "unresolved
  flagged events" framing). Comment in the fix explains
  why the two routes use different predicates.
- Impact: admin NACHA monitoring page non-functional
  since the schema shipped. Bug class identical to S355
  (properties.ts) and S360 (leaseFeesSync) —
  schema-drift latent bugs in unwalked admin surfaces.

### Test coverage — 10 cases / 4 describe blocks

New file: `apps/api/src/routes/admin-audit-email-nacha.test.ts`

**GET /admin/audit-log (3)**
- Plain admin → 403 (super_admin only)
- Empty fixture → rows/total/actionTypes/admins all
  empty
- action_type filter narrows; total reflects filtered
  count; actionTypes returns DISTINCT list (with rows
  outside the filter still listed for the UI dropdown)

**POST /admin/invoices/backfill (3)**
- Missing `from` → 400 with format hint
- Non-uuid landlord_id → 400
- dry_run=true: passes through to backfillInvoices with
  dryRun flag; returns service result; writes audit log
  with action_type='invoices_backfill_dry_run' and notes
  carrying the invoice/lease counts

**GET /admin/email-failures (2)**
- Default `status='failed'`; sent rows excluded
- `?category=marketing` narrows to that category only

**GET /admin/nacha/monitoring (2)**
- Empty fixture → logs:[], stats with zero counters.
  **This test was the F1 surfacing path** — pre-fix
  the empty-fixture case 500'd because the FILTER
  predicate ran against a non-existent column on every
  call, regardless of seeded data.
- Seeded ach_monitoring_log: 3 rows (velocity_flag,
  zero_tolerance_block with return_code='R01',
  first_sender). Stats correctly aggregate
  `total_returns=1` (one row with return_code) +
  `zero_tolerance_events≥1` + per-event-type counts.

### Test infra additions

`dbHelpers.cleanupAllSchema` extended for
`ach_monitoring_log` (FK payments + tenants with NO ACTION
default — blocks parent deletes when seeded).

## Files touched

```
apps/api/src/routes/
  admin.ts                              (+9 -1 lines: F1 fix)
  admin-audit-email-nacha.test.ts       (NEW — 260 lines, 10 cases)

apps/api/src/test/
  dbHelpers.ts                          (+2 lines: ach_monitoring_log cleanup)
```

No migrations. No schema changes. No frontend changes.

## Decisions made during build

| Question | Decision |
|---|---|
| F1 fix: which predicate semantic — `flagged=TRUE` (matches /overview) or `event_type='zero_tolerance_block'` (matches CHECK enum)? | **event_type semantic.** The route's column is named "zero_tolerance_events" — that name maps directly to the `zero_tolerance_block` event_type CHECK enum value. /overview's predicate is `flagged=TRUE AND resolved=FALSE` which is a different (broader) concept. Both are correct for their respective routes; comment in the fix explains why. |
| Sweep other admin.ts routes for missing-column drift? | **Surgical fix.** The S355/S360/S370 pattern is real but a codebase-wide schema-drift audit is a separate hardening pass. Test slices catch these as they hit each route; the test coverage is the audit. Logged as deferred. |
| Test the audit-log pagination (offset)? | **Skipped.** Pagination math is mechanical; the offset clamp is the only logic and it's a `Math.max(0, …)` clamp. Lower yield than the filter+counts tests. |
| Test the invoices/backfill committing path (dry_run=false)? | **Skipped — duplicates the dry_run path.** Both branches call backfillInvoices with the same args (just different dryRun flag). The dry_run test pins the contract; the commit path is identical except for the action_type stamp on the audit log. Mechanical. |
| Test email-failures `since_days` window? | **Skipped — mechanical NOW() - INTERVAL math.** The since_days clamp is `Math.min(365, Math.max(1, ...))`. Status + category filters are the interesting business-logic. |
| Mock backfillInvoices or let it actually run with seeded fixtures? | **Mock.** Backfill is a service with its own coverage (jobs/invoiceGeneration); testing it here would duplicate that coverage AND require seeding a lease + rent + payment fixture chain. Mocking pins the route-contract (args + audit log) without dragging in the engine. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1062 tests across 59 files, 0
  failures**, ~529s.
- 10 new test cases (`admin-audit-email-nacha.test.ts`).
- 1 production bug fix (`admin.ts` F1 —
  zero_tolerance_flag → event_type='zero_tolerance_block').
- 0 production regressions.

No frontend touched, no shared-package touched.

## Items deferred — what S371 could target

### admin.ts remaining slices (~6 routes left)

S362 + S368 + S369 + S370 covered ~30 of admin.ts's ~40
routes (~75%). Remaining surfaces:

- **OTP advance retry + FlexCharge statement retry** (2
  routes — Stripe boundary operational helpers)
- **Deposit-portability** (2 routes — pending list +
  mark-transferred)
- **Connect-readiness** (3 routes — backfill, list,
  refresh-by-entity)
- **Landlord banking nudges** (1 route)
- **Tenant onboarding detail + FlexSuite acceptances**
  (2 routes — parallel to S369's landlord detail)

Recommended next pick: **deposit-portability + connect-
readiness + landlord banking nudges** (6 routes, all
admin operational tools, can bundle if Stripe boundary
work is light).

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is the
priority. Nic obtained Checkr Partner credentials
2026-05-26. The next fresh-context session starts with
wiring `background.ts` to live Checkr (real product
integration). Per `feedback_checkr_otp_unrelated.md`,
frame Checkr as background-check product going live, NOT
as unblocking OTP.

### Other admin-surface route slices (after admin.ts arc
completes)

(Unchanged from S369.)

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf** — open since
  S333.
- **responsibleParty source-comment drift fix** —
  one-liner.

### Hardening flagged

- **action.url scheme validation in adminNotifications** —
  flagged S344
- **logAdminAction targetId-uuid audit** (codebase-wide
  hygiene pass) — surfaced S368
- **silent-failure pattern audit** (try/catch swallow
  class) — leaseFeesSync (S360) + logAdminAction (S368)
  hid bugs
- **schema-drift audit on admin.ts SQL columns** —
  S355/S360/S370 are three instances of the same class
  (route SELECT references a column that doesn't exist
  on the table); worth a grep for similar patterns

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S369.)

## Items deferred (cross-session docket, post-S370)

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
- admin.ts remaining: OTP/FlexCharge retry + deposit-portability + connect-readiness + landlord banking nudges + tenant onboarding detail + FlexSuite acceptances
- logAdminAction targetId-uuid audit (codebase-wide hygiene pass)
- silent-failure pattern audit (try/catch swallow class)
- schema-drift audit on admin.ts SQL columns
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

## What S371 should target

Bug-yield count after S370: **18 bugs caught total**
across 24 sessions of route-test sweep. S370's F1 is the
**third schema-drift / missing-column bug** caught in
admin/landlord surfaces (S355, S360, S370). All three
share the same shape: SQL column reference that the
schema doesn't carry, latent because the route was never
walked.

**S371 should continue the admin.ts arc.** ~6 routes
left. Next slice: deposit-portability + connect-
readiness + landlord banking nudges (6 routes — admin
operational tools, likely Stripe-mocked).

If clearing for fresh context: per memory note, start
S371 with the **Checkr API integration in background.ts**
before returning to the test sweep.

---

End of S370 handoff. Closed clean. 1062 tests / 59 files
/ 0 failures. admin.ts slice 4 of N covered (audit-log +
invoices backfill + email failures + NACHA). **1 real
bug fixed: F1 — admin NACHA monitoring page was 500'ing
on every call due to schema-drift missing column.**
admin.ts arc ~75% complete.

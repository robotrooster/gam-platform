# Route-test coverage audit — S382

Generated 2026-05-31 after tenants.ts arc closure (S381).

This document is the **prioritized worklist** for the
cross-portal bug-sweep. Methodology, raw per-file numbers,
and the full uncovered-route list follow at the bottom.

---

## TL;DR

- **39 route files**, **506 routes total**, **246 covered
  (48%)**, **260 uncovered (52%)**.
- 7 files account for **152 of 260 uncovered routes (58%)**
  — `books.ts`, `background.ts`, `pos.ts`,
  `maintenance-portal.ts`, `esign.ts`, `credit.ts`,
  `pm.ts`.
- 4 files are fully covered: `admin.ts`, `tenants.ts*`,
  `totp.ts`, `bookings.ts`, `webhooks.ts`. (*tenants.ts
  has 1 untested route: `DELETE /api/tenants/flexdeposit`
  — gap from S375 slice 2; should add to slice arc closer
  if we touch the file again.)
- One file (`fitness.ts`) has 0 routes and may be a stub
  or candidate for removal.

## Coverage methodology

Per-file analysis script at `/tmp/route_coverage_audit.py`.
For each `apps/api/src/routes/*.ts` (non-test):

1. Extract router var (`export const fooRouter = Router()`)
2. Extract mount path from `apps/api/src/index.ts`
   (e.g., `app.use('/api/foo', fooRouter)`)
3. Extract all `fooRouter.method('/path', ...)` route
   definitions
4. For each route, grep ALL `*.test.ts` files (under
   `apps/api/src/`) for a matching
   `.method('/api/foo/path')` call, with `:param`
   substitution via regex (matches both raw segments and
   `${...}` template interpolation)
5. Route is "covered" if any test file references its
   METHOD + PATH

**Heuristic limitations.** False negatives possible: tests
that build URLs entirely dynamically (e.g., from a config
object) won't match; tests that mount a route under a
non-standard prefix won't match. False positives possible
if a path string appears in a non-test context — but the
script only scans `*.test.ts` files, so this is rare.

The numbers err conservative — actual coverage is probably
~5% higher than reported.

## Priority bands

### Critical (do FIRST) — large surface, low/zero coverage

These are the highest expected bug yield based on
tenants.ts arc precedent (1 bug per ~5 routes for files
of comparable complexity).

| File | Uncovered / Total | Cov % | Lines | Why critical | Est. sessions |
|---|---:|---:|---:|---|---:|
| **`books.ts`** | 40 / 40 | 0% | 1,331 | GAM Books — full accounting subsystem, never tested. Payroll runs, journal entries, transactions, reports. **Highest bug-yield candidate in the codebase.** | 6-8 |
| **`background.ts`** | 25 / 25 | 0% | 1,066 | Checkr integration parked here pending API wire-up (memory note locked). Pricing flow + applicant intake + provider webhook + adverse-action notice generation. | 4-5 |
| **`pos.ts`** | 23 / 55 | 58% | 1,850 | POS subsystem. Inventory + vendors + purchase orders + categories + low-stock. Existing coverage hits transactions/payment paths but inventory side is bare. | 3-4 |
| **`maintenance-portal.ts`** | 17 / 17 | 0% | 249 | Field-tech portal. Daily tasks, scheduled maint, purchase requests. Small per-route but business-critical for crew operations. | 2-3 |
| **`esign.ts`** | 16 / 25 | 36% | 2,533 | E-sign document flow. Has S29b coverage on the core sign path but envelope creation / signer management / template flows are uncovered. | 3-4 |
| **`credit.ts`** | 16 / 16 | 0% | 840 | Credit-ledger API surface. The ledger SERVICE is well-tested but the route layer (admin-views, tenant-views) is bare. | 2-3 |
| **`pm.ts`** | 14 / 23 | 39% | 1,101 | PM Companies subsystem. S109+ work tested the company/staff/fee plans paths; property invitations + Connect + payouts + drilldown are uncovered. | 2-3 |

**Subtotal: 7 files, 151 uncovered routes, ~22-30 sessions.**

### High (do SECOND) — medium surface, low coverage

| File | Uncovered / Total | Cov % | Lines | Why | Est. sessions |
|---|---:|---:|---:|---|---:|
| `utility.ts` | 12 / 12 | 0% | 388 | Utility billing — meters + bills + payments. Money-handling. | 2 |
| `properties.ts` | 9 / 17 | 47% | 1,031 | units/bulk + photos + listings + apply + applications (per S279+ deferred). | 2 |
| `units.ts` | 9 / 17 | 47% | 540 | /:id/economics + /:id/eviction-mode (walkthrough-blocked) + other unit operations. | 2 |
| `landlords.ts` | 8 / 55 | 85% | 3,822 | High existing coverage from S289–S290 OTP work. Final gap-closer slice. | 1 |
| `workTrade.ts` | 8 / 8 | 0% | 332 | Work-trade agreements + logs + periods. Tenant-facing surface partially covered via /api/tenants/work-trade (S381). | 1-2 |
| `leases.ts` | 6 / 15 | 60% | 982 | Lease lifecycle paths uncovered: termination / renewal / status transitions. | 1-2 |

**Subtotal: 6 files, 52 uncovered routes, ~9-11 sessions.**

### Medium (do THIRD) — small surface, zero/low coverage

| File | Uncovered / Total | Cov % | Lines |
|---|---:|---:|---:|
| `notifications.ts` | 6 / 6 | 0% | 85 |
| `bulletin.ts` | 5 / 5 | 0% | 262 |
| `reports.ts` | 5 / 5 | 0% | 490 |
| `stripe.ts` | 5 / 5 | 0% | 280 |
| `bankAccounts.ts` | 4 / 4 | 0% | 130 |
| `payments.ts` | 4 / 4 | 0% | 430 |
| `terminal.ts` | 4 / 4 | 0% | 67 |
| `posCustomerOnboarding.ts` | 3 / 3 | 0% | 254 |

**Subtotal: 8 files, 36 uncovered routes, ~6-8 sessions.**

These could be batched 2 files per session.

### Low (do LAST) — closers + gap-fills

| File | Uncovered / Total | Cov % |
|---|---:|---:|
| `auth.ts` | 3 / 10 | 70% |
| `scopes.ts` | 3 / 10 | 70% |
| `subleaseInvitations.ts` | 2 / 2 | 0% |
| `withdrawals.ts` | 2 / 2 | 0% |
| `inspections.ts` | 2 / 9 | 77% |
| `subleases.ts` | 2 / 7 | 71% |
| `tenants.ts` | 1 / 40 | 97% |
| `maintenance.ts` | 1 / 7 | 85% |
| `entryRequests.ts` | 1 / 6 | 83% |
| `announcements.ts` | 1 / 1 | 0% |
| `disbursements.ts` | 1 / 1 | 0% |
| `documents.ts` | 1 / 1 | 0% |
| `finances.ts` | 1 / 1 | 0% |

**Subtotal: 13 files, 21 uncovered routes, ~3-4 sessions
(batched).**

### Anomalies — verify before slicing

- **`admin.ts` shows 100% covered** (42/42). The actual
  coverage feels high — admin.ts has ~6 test files
  hitting it (admin-arc-closer, admin-arc-gaps,
  admin-audit-email-nacha, admin-bulletin-income,
  admin-csv-review, admin-deposit-connect, admin.test).
  Plausible the heuristic over-counts due to permissive
  `:param` matching. Worth a manual spot-check before
  trusting "no work needed."
- **`fitness.ts` 0 routes / 0 covered, 216 lines.** Likely
  exports-only or registers a sub-router via a non-standard
  pattern that the regex misses. Verify by reading the
  file; may be a dead-code candidate.
- **`tenants.ts` shows 39/40.** The 1 untested route is
  `DELETE /api/tenants/flexdeposit` — gap from S375 slice
  2 that the closer (S381) didn't catch. **Add to the
  next opportunistic touch of the file.**

## Total estimated worklist

| Band | Files | Uncovered routes | Est. sessions |
|---|---:|---:|---:|
| Critical | 7 | 151 | 22-30 |
| High | 6 | 52 | 9-11 |
| Medium | 8 | 36 | 6-8 |
| Low | 13 | 21 | 3-4 |
| **TOTAL** | **34** | **260** | **40-53** |

(Plus ~1 session for the anomaly verification.)

At ~1 production bug per 5 routes (tenants.ts arc rate),
this work would surface an estimated **40-60 production
bugs** across the rest of the codebase.

## Recommended slice order (next 10 sessions)

### S383 — Checkr API wire-up (FRESH CONTEXT)

Per locked priority memory `project_checkr_access_unblocked.md`,
open S383 with `/clear` for fresh context and start with
the Checkr integration in `background.ts`. This is NOT a
test slice — it's the live wiring that unblocks the
background-check route family.

After Checkr is live, slice 1 of background.ts's coverage
arc becomes naturally next (the routes will have a real
provider to integrate with).

### S384–S388 — books.ts arc (5 sessions)

`books.ts` is the highest-yield single file: 40 routes,
0% coverage, GAM Books accounting subsystem. Slice it
~8 routes per session:

- S384: accounts + employees (CRUD, ~8 routes)
- S385: contractors + vendors (CRUD, ~6 routes)
- S386: payroll runs + bookkeeper invites (~6 routes)
- S387: journal + transactions + bills (~8 routes)
- S388: reports (pl/balance-sheet/cash-flow/owner/tax/
  rent-roll, ~7 routes)

### S389–S392 — pos.ts inventory gap + maintenance-portal (4 sessions)

- S389-S390: pos.ts inventory + vendor + PO + low-stock
  (~12 routes across 2 slices)
- S391-S392: maintenance-portal.ts full coverage (17 routes
  across 2 small slices)

### S393+ — esign / credit / pm continuation

Then rotate through the remaining critical-band files at
~5 routes per session.

## Per-file ranking by uncovered surface

| Rank | File | Uncovered | % | Band |
|---:|---|---:|---:|---|
| 1 | `books.ts` | 40 | 0% | Critical |
| 2 | `background.ts` | 25 | 0% | Critical |
| 3 | `pos.ts` | 23 | 58% | Critical |
| 4 | `maintenance-portal.ts` | 17 | 0% | Critical |
| 5 | `esign.ts` | 16 | 36% | Critical |
| 6 | `credit.ts` | 16 | 0% | Critical |
| 7 | `pm.ts` | 14 | 39% | Critical |
| 8 | `utility.ts` | 12 | 0% | High |
| 9 | `properties.ts` | 9 | 47% | High |
| 10 | `units.ts` | 9 | 47% | High |
| 11 | `landlords.ts` | 8 | 85% | High |
| 12 | `workTrade.ts` | 8 | 0% | High |
| 13 | `leases.ts` | 6 | 60% | High |
| 14 | `notifications.ts` | 6 | 0% | Medium |
| 15 | `bulletin.ts` | 5 | 0% | Medium |
| 16 | `reports.ts` | 5 | 0% | Medium |
| 17 | `stripe.ts` | 5 | 0% | Medium |
| 18 | `bankAccounts.ts` | 4 | 0% | Medium |
| 19 | `payments.ts` | 4 | 0% | Medium |
| 20 | `terminal.ts` | 4 | 0% | Medium |
| 21 | `auth.ts` | 3 | 70% | Low |
| 22 | `scopes.ts` | 3 | 70% | Low |
| 23 | `posCustomerOnboarding.ts` | 3 | 0% | Medium |
| 24 | `subleaseInvitations.ts` | 2 | 0% | Low |
| 25 | `withdrawals.ts` | 2 | 0% | Low |
| 26 | `inspections.ts` | 2 | 77% | Low |
| 27 | `subleases.ts` | 2 | 71% | Low |
| 28 | `tenants.ts` | 1 | 97% | Low (DELETE /flexdeposit) |
| 29 | `maintenance.ts` | 1 | 85% | Low |
| 30 | `entryRequests.ts` | 1 | 83% | Low |
| 31 | `announcements.ts` | 1 | 0% | Low |
| 32 | `disbursements.ts` | 1 | 0% | Low |
| 33 | `documents.ts` | 1 | 0% | Low |
| 34 | `finances.ts` | 1 | 0% | Low |
| 35 | `admin.ts` | 0 | 100% | Verify anomaly |
| 36 | `totp.ts` | 0 | 100% | Done |
| 37 | `bookings.ts` | 0 | 100% | Done |
| 38 | `webhooks.ts` | 0 | 100% | Done |
| 39 | `fitness.ts` | 0 | n/a | Verify anomaly |

## Cross-cutting hardening sessions to interleave

These three sweeps would each surface 10-30 bugs cross-codebase and are worth interleaving with the route-arc work:

1. **Schema-drift audit** — grep every `WHERE X='Y'` and
   `FILTER (WHERE X='Y')` against the schema enum
   constraints. 9 known instances from prior arcs;
   estimated 15-30 more codebase-wide. HIGHEST cross-
   cutting yield.
2. **Public-route hoist audit** — grep every
   `<router>.use(requireAuth)` and check whether any
   inherently-public routes (image serves, public token
   landing pages, invite endpoints) are gated below
   them. 2 instances surfaced in tenants.ts arc.
3. **silent-failure pattern audit** — grep `} catch ...` blocks
   that swallow errors without surfacing or logging.
   Class of bug that hides production failures.

Each is a 1-session sweep; budget S400+ for them if not
sooner.

## What this audit does NOT cover

- Services (`apps/api/src/services/*.ts`) — service-layer
  coverage is a separate audit. Some service tests exist
  (creditLedger, allocation, flexDeposit, etc.) but no
  systematic mapping has been done.
- Jobs (`apps/api/src/jobs/*.ts`) — cron/scheduler
  coverage. Same — some tests exist, no systematic map.
- Frontend (`apps/*/src/`) — out of scope for this
  backend audit. Walkthrough-blocked items live there.
- Static helpers / middleware / libs — out of scope.

These three layers (services, jobs, frontends) are
follow-on audits worth running if the route-test arc
proves yield.

---

## Raw per-file numbers

| File | Mount | Routes | Covered | Uncovered | % | Lines |
|---|---|---:|---:|---:|---:|---:|
| `books.ts` | `/api/books` | 40 | 0 | 40 | 0% | 1331 |
| `background.ts` | `/api/background` | 25 | 0 | 25 | 0% | 1066 |
| `pos.ts` | `/api/pos` | 55 | 32 | 23 | 58% | 1850 |
| `maintenance-portal.ts` | `/api/maint-portal` | 17 | 0 | 17 | 0% | 249 |
| `esign.ts` | `/api/esign` | 25 | 9 | 16 | 36% | 2533 |
| `credit.ts` | `/api/credit` | 16 | 0 | 16 | 0% | 840 |
| `pm.ts` | `/api/pm` | 23 | 9 | 14 | 39% | 1101 |
| `utility.ts` | `/api/utility` | 12 | 0 | 12 | 0% | 388 |
| `properties.ts` | `/api/properties` | 17 | 8 | 9 | 47% | 1031 |
| `units.ts` | `/api/units` | 17 | 8 | 9 | 47% | 540 |
| `landlords.ts` | `/api/landlords` | 55 | 47 | 8 | 85% | 3822 |
| `workTrade.ts` | `/api/work-trade` | 8 | 0 | 8 | 0% | 332 |
| `leases.ts` | `/api/leases` | 15 | 9 | 6 | 60% | 982 |
| `notifications.ts` | `/api/notifications` | 6 | 0 | 6 | 0% | 85 |
| `bulletin.ts` | `/api/bulletin` | 5 | 0 | 5 | 0% | 262 |
| `reports.ts` | `/api/reports` | 5 | 0 | 5 | 0% | 490 |
| `stripe.ts` | `/api/stripe` | 5 | 0 | 5 | 0% | 280 |
| `bankAccounts.ts` | `/api/bank-accounts` | 4 | 0 | 4 | 0% | 130 |
| `payments.ts` | `/api/payments` | 4 | 0 | 4 | 0% | 430 |
| `terminal.ts` | `` | 4 | 0 | 4 | 0% | 67 |
| `auth.ts` | `/api/auth` | 10 | 7 | 3 | 70% | 567 |
| `scopes.ts` | `/api/scopes` | 10 | 7 | 3 | 70% | 746 |
| `posCustomerOnboarding.ts` | `/api/pos-customer-onboarding` | 3 | 0 | 3 | 0% | 254 |
| `inspections.ts` | `/api/inspections` | 9 | 7 | 2 | 77% | 652 |
| `subleases.ts` | `/api/subleases` | 7 | 5 | 2 | 71% | 785 |
| `subleaseInvitations.ts` | `/api/sublease-invitations` | 2 | 0 | 2 | 0% | 270 |
| `withdrawals.ts` | `/api/users` | 2 | 0 | 2 | 0% | 182 |
| `tenants.ts` | `/api/tenants` | 40 | 39 | 1 | 97% | 1364 |
| `maintenance.ts` | `/api/maintenance` | 7 | 6 | 1 | 85% | 391 |
| `entryRequests.ts` | `/api/entry-requests` | 6 | 5 | 1 | 83% | 449 |
| `announcements.ts` | `/api/announcements` | 1 | 0 | 1 | 0% | 21 |
| `disbursements.ts` | `/api/disbursements` | 1 | 0 | 1 | 0% | 46 |
| `documents.ts` | `/api/documents` | 1 | 0 | 1 | 0% | 33 |
| `finances.ts` | `/api/users` | 1 | 0 | 1 | 0% | 139 |
| `admin.ts` | `/api/admin` | 42 | 42 | 0 | 100% | 1530 |
| `totp.ts` | `/api/auth/totp` | 4 | 4 | 0 | 100% | 315 |
| `bookings.ts` | `/api/bookings` | 1 | 1 | 0 | 100% | 105 |
| `webhooks.ts` | `/webhooks` | 1 | 1 | 0 | 100% | 759 |
| `fitness.ts` | `` | 0 | 0 | 0 | 0% | 216 |
| **TOTAL** | — | **506** | **246** | **260** | **48%** | — |

## Full uncovered-route list

See `/tmp/coverage_audit.md` for the per-file uncovered
list (370+ lines). To regenerate at any time:

```
python3 /tmp/route_coverage_audit.py > /tmp/coverage_audit.md
```

The script lives at `/tmp/route_coverage_audit.py` and is
self-contained — re-run it after each slice to track
progress on the worklist.

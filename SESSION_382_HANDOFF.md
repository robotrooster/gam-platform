# Session 382 — closed

## Theme

**Cross-portal route-test coverage audit** (the deliverable
Nic asked for in S378's closing recommendation, now executed).

No tests written, no production code changed. Output is a
prioritized worklist at `COVERAGE_AUDIT_S382.md` (repo root)
that drives the next 40-50 sessions of bug-sweep work.

## Items shipped

### `COVERAGE_AUDIT_S382.md` (repo root, 339 lines)

The consolidated audit doc with:
- TL;DR — 39 route files, 506 routes, 246 covered (48%),
  260 uncovered
- Methodology — heuristic regex-based per-route coverage
  detection (script + caveats documented)
- Priority bands — Critical (7 files, 151 uncovered) /
  High (6 files, 52 uncovered) / Medium (8 files, 36
  uncovered) / Low (13 files, 21 uncovered)
- Per-file table sorted by uncovered surface
- Recommended slice order for the next 10 sessions
  (Checkr first, then books.ts arc, then
  pos.ts/maintenance-portal, then esign/credit/pm)
- Three cross-cutting hardening sessions to interleave
  (schema-drift, public-route hoist, silent-failure)
- Anomaly flags (admin.ts shows 100%, fitness.ts has 0
  routes, tenants.ts has 1 untested DELETE)
- Total worklist estimate: 40-53 sessions to close all
  260 uncovered routes; estimated 40-60 production bugs
  surfaced at the tenants.ts arc bug-yield rate

### `COVERAGE_AUDIT_S382_FULL.md` (repo root, 374 lines)

The full per-file uncovered-route list (METHOD + PATH for
every uncovered route), the raw output of the analysis
script. Useful as the line-by-line shopping list during
slice planning.

### `/tmp/route_coverage_audit.py` (analysis script)

The Python script that generates the audit. Self-contained,
regenerates from current source state. Documented in the
audit doc with a re-run command:

```
python3 /tmp/route_coverage_audit.py > /tmp/coverage_audit.md
```

Re-running after each slice tracks progress; a future
session could copy this to a non-tmp location in the
repo if we want it preserved beyond the next reboot.

## Headline findings

### Top 7 highest-yield files (CRITICAL band)

| File | Uncovered | Cov % | Lines | Notes |
|---|---:|---:|---:|---|
| **books.ts** | 40/40 | 0% | 1,331 | Full GAM Books accounting subsystem. Never tested. **Single highest bug-yield candidate in the codebase.** |
| **background.ts** | 25/25 | 0% | 1,066 | Checkr integration parked here. Locked priority for next fresh-context session. |
| **pos.ts** | 23/55 | 58% | 1,850 | Inventory + vendor + PO + low-stock paths uncovered (transactions side OK from S338-S343). |
| **maintenance-portal.ts** | 17/17 | 0% | 249 | Field-tech portal. Daily tasks + scheduled maint + purchase requests. |
| **esign.ts** | 16/25 | 36% | 2,533 | Core sign path covered (S29b); envelope/signer/template flows uncovered. |
| **credit.ts** | 16/16 | 0% | 840 | Credit-ledger ROUTE layer bare (service is well-tested). |
| **pm.ts** | 14/23 | 39% | 1,101 | PM Companies property invitations + Connect + payouts + drilldown uncovered. |

These 7 files account for **151 of 260 uncovered routes
(58%)**. Closing them is ~22-30 sessions of work.

### Coverage rate at tenants.ts close vs across the codebase

- tenants.ts arc: 8 sessions → 93 tests → 8 production
  bugs fixed → 4 architectural findings → 100% route
  coverage (1 small gap to backfill).
- Codebase-wide: 246 of 506 routes covered = 48%. At the
  tenants.ts bug-yield rate (~1 fix per 5 covered routes),
  the remaining 260 uncovered routes likely hide **40-60
  more production bugs**.

### Three cross-cutting hardening sweeps worth interleaving

The audit doc calls these out separately because they are
each ~1-session sweeps and would surface bugs across the
entire codebase, not just one route file:

1. **Schema-drift audit** (HIGH YIELD): 9 known instances
   from prior arcs; estimated 15-30 more codebase-wide.
2. **Public-route hoist audit** (MEDIUM YIELD): grep
   every `<router>.use(requireAuth)` for the S377/S380
   pattern (router-level auth gating inherently-public
   routes).
3. **silent-failure pattern audit** (UNKNOWN YIELD): `}
   catch ...` blocks that swallow errors without
   surfacing or logging.

## Anomalies to verify before trusting the audit

- **admin.ts shows 100% covered.** Has 6 test files
  hitting it. Coverage might be inflated by permissive
  `:param` matching. **Spot-check before declaring "no
  work needed."**
- **fitness.ts: 0 routes, 216 lines.** Likely a stub or
  uses a non-standard route-registration pattern the
  regex misses. **Read the file to confirm dead-code
  status.**
- **tenants.ts: 39/40.** `DELETE /api/tenants/flexdeposit`
  was missed in S375 slice 2's coverage. **Add to next
  opportunistic touch of the file.**

## Decisions made during build

| Question | Decision |
|---|---|
| Build the audit script in Python or bash one-liners? | **Python.** Two regex passes per route × 47 test files = thousands of comparisons; bash loops would be slow and the script needs `:param` interpolation handling which is awkward in bash. Python keeps the logic readable for future readers. |
| Trust the heuristic numbers or do a manual audit? | **Trust + flag anomalies.** Manual audit of 39 files would take a full session by itself. The heuristic is conservative (favors false-negatives over false-positives) so the "uncovered" list is actionable as-is. The anomaly flags (admin.ts 100%, fitness.ts 0) are explicit so they get spot-checked before slicing. |
| Order priority bands by uncovered count or by estimated bug yield? | **Uncovered count, with bug-yield as a secondary signal in the "why critical" column.** Bug yield is a guess; uncovered count is data. The two are usually correlated (large untested surface = more places for bugs) but where they diverge (e.g., maintenance-portal.ts is small but business-critical), the table's notes call it out. |
| Include service + job + frontend coverage in this audit? | **No — out of scope.** This is the ROUTE audit; service / job / frontend audits are separate one-session passes if the route arc proves yield. Documented in "what this audit does NOT cover" section. |
| Recommend the next 10 sessions or just hand over the table? | **Recommend the next 10.** The table is the source of truth, but a concrete slice order (S383 = Checkr / S384-S388 = books.ts / S389-S392 = pos+maint-portal) gives momentum. Easier to redirect a concrete plan than to re-plan from raw data each session. |

## Files touched

```
/Users/gold/Downloads/gam/
  COVERAGE_AUDIT_S382.md         (NEW — 339 lines, the
                                  prioritized worklist)
  COVERAGE_AUDIT_S382_FULL.md    (NEW — 374 lines, the raw
                                  per-file uncovered list)

/tmp/
  route_coverage_audit.py        (NEW — analysis script,
                                  re-runnable for progress
                                  tracking)
  coverage_audit.md              (NEW — script output,
                                  identical to COVERAGE_
                                  AUDIT_S382_FULL.md)
```

No production code changed. No tests added. No
migrations. No frontend touched.

## Verification

- `npx tsc --noEmit` not re-run — no code changes.
- `npm test` not re-run — last green run was S381 close
  (1179 / 70 files / 0 failures).
- Audit script ran clean; output reviewed for accuracy
  via spot-checks on tenants.ts (knew the answer),
  scopes.ts (caught a regex bug in the first pass, fixed),
  bookings.ts (caught a trailing-slash issue in the first
  pass, fixed).

## What S383 should target

**Recommended path: open S383 with `/clear` for fresh
context.** S378-S382 ran on a single context across 5
sessions; the audit pass is a natural break point. The
locked priority for the next fresh-context session has
been **Checkr API wire-up in background.ts** since S375
(memory note `project_checkr_access_unblocked.md`,
credentials in hand 2026-05-26).

If continuing the chain without /clear:

1. **books.ts slice 1** is the natural next test-arc
   start (40 routes, 0% coverage, single biggest
   bug-yield candidate). Slice ~8 routes per session →
   5 sessions to close.

If you want to do something cross-cutting instead:

2. **Schema-drift audit** would surface 15-30 bugs in a
   single session (highest single-session yield in the
   docket).

## Items deferred (cross-session docket, post-S382)

Unchanged from S381 close, with the audit doc now serving
as the canonical reference for "what's left."

Top of the docket:
- **NEXT FRESH-CONTEXT SESSION**: Wire background.ts →
  Checkr API (credentials in hand 2026-05-26)
- **(S382 new)**: Execute the worklist in
  `COVERAGE_AUDIT_S382.md` — ~40-53 sessions across the
  4 priority bands
- **(S381 carried)**: Schema-drift audit (9 known
  instances, est. 15-30 codebase-wide); Public-route
  hoist audit (2 known patterns); silent-failure audit

Nic-pending decisions (carried from S376-S380):
- (S376) FlexCredit ↔ rent-reporting product naming
- (S377) Invite token leakage / column overload / expiry
- (S380) Avatar upload XSS posture (3 options)
- (S380) PATCH /profile email validation policy
- Consumer-side retention framing (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call
- Stripe live keys / Resend domain / Plaid prod keys /
  Stripe Terminal hardware (vendor signups)

---

End of S382 handoff. **Cross-portal coverage audit
shipped.** Worklist at `COVERAGE_AUDIT_S382.md` drives
the next ~40-50 sessions. Recommended: `/clear` then
S383 = Checkr API wire-up (locked priority); or
continuing-chain S383 = books.ts slice 1 (highest-
yield single file in the codebase).

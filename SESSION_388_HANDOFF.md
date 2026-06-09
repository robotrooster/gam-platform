# Session 388 — closed

## Theme

**Cross-tenant scope-bypass pattern audit** across all
`routes/*.ts` files. Triggered by the books.ts arc
(S383–S387) surfacing 8 cross-tenant scope-bypass bugs
in one file; the question was: how many more instances
exist elsewhere in the codebase?

No tests written, no code touched. Output is a single
audit doc at `SCOPE_BYPASS_AUDIT_S388.md` (repo root)
documenting all findings + false-positives +
remediation plan.

## Headline result

**Estimate was 5-15 more instances; actual is 3, all
LOW-severity.** The rest of the codebase generally
follows the right pattern (explicit ownership checks at
the route or service layer). books.ts was an outlier —
its high route density × zero prior coverage × custom
`lid` scope-helper pattern produced the concentration.

## Audit findings

### Pattern A (scope ID from req.body, no ownership check) — 3 new LOW-severity

| # | File | Route | Field | Severity |
|---|---|---|---|---|
| 1 | maintenance-portal.ts:191 | POST /scheduled | propertyId, unitId, assignedTo | LOW (cross-tenant ref pollution) |
| 2 | esign.ts:1164 | POST /documents | unitId fallback | LOW-MED (cross-tenant lease doc) |
| 3 | pos.ts:189 | PATCH /items | vendorId | LOW (cross-tenant ref pollution) |

All three: same class as the S386 cluster but lower
severity (caller pollutes their own rows with foreign
references, not exposing strangers' data). Fix is 4-6
lines each — recommend folding into the relevant
file's test-slice work per audit priority.

### Pattern B (user_id used as landlord scope) — 0 new

The S387 books.ts `gamRentIncome` + `/rent-roll` bugs
were the only instances. Other matches (fitness.ts) are
legitimate user-keyed data, not scope-bypass.

### Pattern C (`OR $N IS NULL` bypass-eligible) — 0 new

**Pattern is entirely contained in books.ts.** 38 of 39
route files use explicit ownership checks instead. The
S383 X-Client-Id middleware fix secures every books.ts
instance.

## False positives confirmed clean (representative list)

19 of the ~30 Pattern A hits validated as not-bugs:
- **Public routes** (anonymous caller, body is the
  input): properties.ts /apply, auth.ts /register-prospect,
  tenants.ts /accept-invite + /invite-info, etc.
- **Service-layer ownership validation**: landlords.ts
  /flex-charge/accounts → createFlexChargeAccount checks;
  notifications.ts /bulk → service filters by
  caller's landlord.
- **Explicit per-route validation**: tenants.ts /invite
  (canAccessLandlordResource), units.ts /:id/bookings/:bookingId
  (validates target unit's landlord), pos.ts /items
  POST (categoryId + propertyId ownership), pos.ts
  /transactions (service validates), pos.ts /purchase-orders
  (vendorId via service).

The audit doc has the full per-file breakdown.

## Items shipped

```
/Users/gold/Downloads/gam/
  SCOPE_BYPASS_AUDIT_S388.md   (NEW — ~290 lines)
```

No production code changed. No tests added. No
migrations. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the 3 new findings in pass or flag for slice work? | **Flag.** All 3 are LOW-severity (cross-tenant reference pollution, not data exposure). The relevant test slices per COVERAGE_AUDIT_S382.md are scheduled within the next 5-10 sessions (pos.ts S389-390, maintenance-portal S391-392, esign S393-396). Folding the fix in with the slice's normal test-pin work is more efficient than 3 standalone micro-PRs without tests. |
| Cover services + jobs + frontend in the same audit? | **No — backend route audit only.** Services and jobs are separate one-session passes if yield justifies. Frontend is out of scope. Documented in "what this audit did NOT cover." |
| Audit READ paths too (cross-tenant JOIN without explicit landlord_id filter)? | **No — write paths only.** Read paths are a different pattern (information disclosure vs. cross-tenant write) and the methodology to audit them is different (need to inspect every JOIN). Worth a future audit if yield warrants. |
| Re-grep with broader patterns to catch tenants_id and other less common scope keys? | **Yes — included `tenantId`, `posCustomerId`, `bookkeeperUserId` in the Pattern A grep.** No additional hits beyond the 3 documented. |
| Spot-check the 4 anomalies from COVERAGE_AUDIT_S382.md (admin 100% / fitness 0 / tenants 39-of-40)? | **Out of scope — separate hardening item.** The audit is focused on scope-bypass, not coverage anomalies. |

## Verification

The audit is read-only — no tests to run, no tsc to
re-validate. The 3 new findings will be regression-pinned
when their respective file slices run.

## Items deferred — what S389 could target

### Pre-existing TZ flake fix from S387

Two tests still failing today (2026-06-01 evening UTC vs
local TZ alignment): `csvImportTenantBalance.test.ts:207`
+ `esign.test.ts:2192`. Both compare `Postgres CURRENT_DATE`
to `new Date().toISOString()` — broken assumption when
local TZ ≠ UTC. One-line fix per test (read from
Postgres instead of JS). **Should fix soon** so the suite
goes back to 0 failures for the TZ-flaky window of every
day.

### Test slices remaining (per COVERAGE_AUDIT_S382.md)

Critical-band files still uncovered:
- **pos.ts** (23/55 uncovered) — inventory + vendor + PO
  + low-stock. Slice 1 of pos arc could be inventory CRUD.
- **maintenance-portal.ts** (17/17 uncovered) — daily
  tasks + scheduled maint + purchase requests.
- **esign.ts** (16/25 uncovered) — envelope / signer /
  template flows.
- **credit.ts** (16/16 uncovered) — credit-ledger route
  layer.
- **pm.ts remaining** (14/23 uncovered) — property
  invitations / Connect / payouts / drilldown.

**Recommend pos.ts inventory slice for S389** — biggest
remaining file by route count (55 routes, only 32
covered). Bundles the S388 PATCH /items vendorId fix.

### Pending Nic decisions (carried)

Unchanged from S387 close. Full list in
SESSION_387_HANDOFF.md.

### Per directive: fix all bugs before Checkr

Books arc complete (10 bug fixes shipped S383-S387).
Audit completed (3 more LOW-severity findings + 19
false positives confirmed). Next: pos.ts arc + the
other critical-band files. Estimated 30-50 more
sessions to close all uncovered routes; expected
~30-50 more bug fixes at the current yield rate.

## Items deferred (cross-session docket, post-S388)

Unchanged from S387 + the 3 new findings (folded into
upcoming slice work, not standalone items).

## Nic-pending

Unchanged from S387.

## What S389 should target

**Recommended: pos.ts inventory slice** — largest
remaining critical-band file. Bundles the S388 PATCH
/items vendorId fix into the slice's normal test-pin
flow. ~8-12 routes, ~15-20 tests.

Or: **TZ flake fix as a 10-minute micro-session** before
S389 starts, so the suite stops being flaky around UTC
midnight.

---

End of S388 handoff. **Cross-tenant scope-bypass audit
complete.** 3 new LOW-severity findings (vs. 5-15
predicted); 19 false-positives confirmed clean.
**Books.ts was an outlier, not a codebase-wide pattern.**
Audit doc at `SCOPE_BYPASS_AUDIT_S388.md`; findings to
be folded into upcoming test slices on
maintenance-portal, esign, and pos.

No tests added, no code changed in this session — pure
audit. Suite count unchanged from S387 close: **1278
green + 2 pre-existing TZ-boundary flakes (unrelated)**.

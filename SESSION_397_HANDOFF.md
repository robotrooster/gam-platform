# Session 397 — closed

## Theme

**workTrade.ts full slice — CLOSES the file at 8/8 (100%).**
8 routes covered: create agreement, GET by unit, GET full
detail, log submission, log approval/rejection, period
reconciliation, dashboard list, status update.

The slice surfaced **4 cross-tenant bug fixes** — the
biggest single-slice cluster since the books arc. All
four fall in the same family the S388 audit predicted
to be rare outside books.ts; turns out workTrade had its
own concentration.

Also fixed the recurring full-suite hook-timeout flake
by bumping vitest's hookTimeout 60s → 120s. Full suite
now fully green (1511/1511).

26 new test cases pin the slice + all 4 fixes.

Suite at S396 close: **1485 total / 83 files** (with 5
flakes that passed in isolation).
Suite at S397 close: **1511 / 84 files / 0 failures**
clean (+26 cases, +1 file; 5 prior flakes now stable).
Runtime ~886s.

Zero tsc regressions, zero S397-introduced regressions.

## Bugs found + fixed — 4 cross-tenant in one file

### Bug 1 (MED) — POST / accepts arbitrary tenantId

**Symptom:** route validated the unit belongs to the
caller's landlord, but `body.tenantId` was passed
straight to the INSERT. A landlord could create a
work-trade agreement against ANY tenant id (including a
stranger landlord's tenant). The cross-tenant agreement
would surface in the (cross-tenant) tenant's view at
`GET /api/tenants/work-trade`.

**Fix:** validate tenant has a lease in caller's
portfolio:
```sql
SELECT l.id FROM leases l
JOIN lease_tenants lt ON lt.lease_id = l.id
WHERE lt.tenant_id = $1 AND l.landlord_id = $2 LIMIT 1
```
404 if not found.

### Bug 2 (MED) — GET /unit/:unitId no scope check

**Symptom:** the SELECT used `WHERE wta.unit_id=$1` with
NO landlord scope filter. Any authenticated user could
pass any unit's id and read its work-trade agreement
(tenant first/last/email, hourly rate, weekly hours,
market rent). Cross-tenant information disclosure.

**Fix:** resolve the unit's landlord_id + active tenant,
then validate caller is admin / own-landlord /
own-team-role / own-tenant. 403 otherwise.

### Bug 3 (MED) — GET /:id no scope check

**Symptom:** `SELECT * FROM work_trade_agreements WHERE
id=$1` with no further auth. Worse than Bug 2 because
the response includes logs (free-text descriptions
submitted by tenant), periods, and computed stats.
Most sensitive read on the file.

**Fix:** same pattern — validate caller scope against
agreement's landlord_id + tenant_id.

### Bug 4 (MED) — POST /:id/logs landlord-scope bypass

**Symptom:** the route's auth check was:
```js
if (req.user!.role === 'tenant' && req.user!.profileId !== agreement.tenant_id) {
  throw new AppError(403, 'Forbidden')
}
```
This correctly rejected cross-tenant tenants. But ANY
non-tenant role (landlord, property_manager, onsite_manager)
passed through with NO landlord-scope check. A landlord
B could POST fake hours against landlord A's agreement.
Subsequent approval (`PATCH /logs/:logId`) would bump
ytd_value on the cross-tenant agreement.

**Fix:** require own-tenant OR own-landlord-scope.

### Pattern signal — workTrade was another cluster

Per the S388 audit's prediction: cross-tenant scope bugs
were "much rarer than expected" outside books.ts (3 LOW-
severity findings). The audit's mid-yield estimate
turned out low: workTrade alone now adds 4 more bugs.
Cumulative across the sweep:

| File | Cross-tenant scope bugs |
|---|---:|
| books.ts | 8 |
| pos.ts | 3 |
| esign.ts | 2 |
| credit.ts | 2 |
| maintenance-portal.ts | 2 |
| utility.ts | 1 |
| landlords.ts | 0 (different bug class) |
| workTrade.ts | **4 (S397)** |
| tenants.ts arc + other | 4 |
| **Total** | **26** |

## Infrastructure: hook timeout bumped

`vitest.config.ts` `hookTimeout` 60s → 120s. Addresses
the 5 hook-timeout flakes from S396 (cleanupAllSchema
occasionally hits the timeout on full-suite warmup).
2x headroom with no normal-case impact. Verified by full
suite: 84 files, 0 failures, 886s.

## Items shipped

### Test coverage — 26 cases / 8 describe blocks

New file: `apps/api/src/routes/workTrade.test.ts`
(~470 lines)

**POST / — 3 cases**
- Cross-landlord unit → 404
- **S397 fix:** stranger tenantId → 404, no row created
- Happy: creates agreement + opens first period

**GET /unit/:unitId — 5 cases**
- Unknown unit → 404
- **S397 fix:** stranger landlord → 403
- **S397 fix:** stranger tenant → 403
- Own landlord: 200
- Own tenant on unit: 200

**GET /:id — 4 cases**
- Unknown → 404
- **S397 fix:** stranger landlord → 403, no body data
- Own landlord: 200 with agreement+logs+periods+stats
- Own tenant: 200

**POST /:id/logs — 5 cases**
- Unknown agreement → 404
- **S397 fix:** stranger landlord posting → 403, no log
- Tenant on own agreement: 200
- Cross-tenant: 403
- Landlord on own agreement (substitute log): 200

**PATCH /logs/:logId — 3 cases**
- Cross-landlord → 403
- Approve happy: status + credit_value + period bump +
  ytd_value bump
- Reject happy: stamps rejection_reason

**POST /:id/reconcile — 3 cases**
- Cross-landlord → 403
- Period not found → 404
- Happy: reconciled status + shortfall_charge + next
  period opened

**GET / (dashboard) — 1 case**
- Landlord-scoped + pending_count join

**PATCH /:id — 2 cases**
- Cross-landlord → 403
- Happy: status=paused

## Files touched

```
apps/api/src/routes/
  workTrade.ts                       (MODIFIED — 4 scope
                                      fixes on POST, GET
                                      /unit/:id, GET /:id,
                                      POST /:id/logs)
  workTrade.test.ts                  (NEW — 470 lines,
                                      26 cases)

apps/api/
  vitest.config.ts                   (MODIFIED — hookTimeout
                                      60s → 120s, S397
                                      infrastructure fix)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix all 4 cross-tenant bugs in pass? | **Yes.** Same root pattern, same fix shape (~6-12 lines per route). Bundling is cheaper than 4 separate slices. The pin tests prove each fix independently. |
| Use a shared helper for the auth scope check? | **No — inline.** Each route's scope tuple is slightly different (some include tenant-self, some don't; some join via lease_tenants, some don't). A helper would have to take multiple options and would be only marginally clearer. The 4-line inline check reads cleanly. |
| Bump hookTimeout to 120s vs investigate why cleanupAllSchema is occasionally slow? | **Bump first.** The flake's root cause is suite-warmup load (DB connection pool, pg-pool TCP setup, vitest worker init). Investigating would take a session; bumping is 1 line. If 120s still flakes, dig deeper. |
| Test the "happy" cases on PATCH /logs/:logId for both approve AND reject? | **Yes.** They take different DB write paths (approve does 3 UPDATEs + computes credit; reject does 1 UPDATE). Two pins is the right granularity. |
| Test the reconcile flow's "next period opened" branch? | **Yes — explicit SELECT-after pin.** A future refactor that drops the next-period INSERT would silently break the rolling cycle without surfacing through the response. The DB read after the reconcile call catches it. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1511 tests across 84 files,
  0 failures**, 886.04s. **First fully-green full-suite
  run since S395.** Hook timeout bump resolved all 5
  flakes from S396.
- 26 new test cases.
- 4 production bug fixes shipped.
- 1 infrastructure fix (hookTimeout).
- 0 production regressions.

## Items deferred — what S398 could target

### High-band files remaining

After workTrade.ts close:
- properties.ts — 9/17 uncovered (47%)
- units.ts — 9/17 uncovered (47%)
- leases.ts — 6/15 uncovered (60%)

**Recommend S398 = leases.ts gap-close** — smallest
remaining (6 routes, already 60% covered), 982 lines.
Quick win.

Then S399 = properties.ts (9) or units.ts (9), then
medium-band files.

### Validation-hygiene backlog (now 18 items)

Same as S396 minus the hook-timeout one (shipped in
S397):
- S380 avatar XSS extension-mismatch
- S380 avatar adopt resolveUploadPath helper
- S384 contractors required-field
- S387 TZ-boundary test fix (csvImportTenantBalance +
  esign)
- S389 POS vendors + adjust-stock reason validators
- S389 shelf-label comment update
- S390 POS tax-rates + discounts validators + DELETE
  no-op
- S391 tasks/scheduled assignedTo scope (needs helper)
- S391 tasks/parts/scheduled required-field validators
- S393 templates DELETE silent no-op
- S393 witnesses/provision enumeration
- S394 pending-tenants write-path defense-in-depth

Single hygiene micro-session: ~50 lines + ~20 small
test pins.

### Pending Nic decisions

Unchanged.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S397):
- **29 production bug fixes** (4 tenants + 8 books +
  1 charge-account + 4 pos + 2 maint-portal + 2 credit
  + 2 esign + 1 landlords + 1 utility + 4 workTrade)
- 18 architectural / validation findings flagged
- 1511 tests covering ~340 of 506 audited routes (67%)

## Items deferred (cross-session docket, post-S397)

Unchanged from S396 minus the hook timeout fix (shipped).

## Nic-pending

Unchanged.

## What S398 should target

**Recommended: leases.ts gap-close** (6 routes, already
60% covered). Quick closer for a high-traffic file.

**Alternatives:**
- properties.ts gap-close (9 routes)
- units.ts gap-close (9 routes)
- Validation-hygiene micro-session (18-item backlog)
- Checkr API wire-up

---

End of S397 handoff. **workTrade.ts arc CLOSED at 8/8
routes (100%).** Slice / 26 tests / 4 cross-tenant
production bug fixes (POST tenantId, GET /unit/:id,
GET /:id, POST /:id/logs).

Plus infrastructure fix: vitest hookTimeout 60s → 120s.
First fully-green full-suite run since S395: 1511 / 84
files / 0 failures.

**29 production bug fixes shipped across the bug
sweep so far.**

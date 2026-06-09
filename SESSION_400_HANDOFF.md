# Session 400 — closed

## Theme

**units.ts gap-close slice — closes the file at 16/17
(94%, the 1 remaining route /:id/economics is
walkthrough-blocked). 31 new test cases, 3 production
bug fixes, 1 architectural finding.**

Suite at S399 close: **1560 / 86 files**.
Suite at S400 close: **1591 / 87 files** (+31 cases, +1 file).
0 failures. Runtime 959.72s. Fourth consecutive
fully-green full-suite run since the S397 hookTimeout bump.

Zero tsc regressions.

## Production bug fixes shipped

### 1. `POST /api/units/:id/eviction-mode` 500 on every call

**Severity: HIGH — the eviction-mode toggle was completely
non-functional in production.**

The UPDATE statement assigns `$2` (req.user.userId, a uuid
string) into the uuid column `payment_block_set_by` from
inside a `CASE WHEN $1 THEN $2 ELSE NULL END` expression.
Postgres defaults bind parameters to `text` when nothing
disambiguates the type; the CASE expression hides the
target column type from the inference path, so the
assignment fails with `42804 column "payment_block_set_by"
is of type uuid but expression is of type text`. Every
eviction-mode enable AND disable returned 500.

Fix: cast `$2::uuid` in the CASE branch. Same class as the
S313 / S339 parameter-ambiguity bugs flagged in earlier
sessions.

### 2. `GET /api/units` team-role landlord-id misresolution

**Severity: medium — every team-role user (PM /
maintenance_worker / onsite_manager) saw an empty units
list.**

The route filtered by `req.user!.profileId`, which is the
`landlord_id` for `role=landlord` but the **user_id** for
team roles. user_id never matches `units.landlord_id`, so
team members got `[]` back silently — no error, just an
empty surface.

Fix: resolve to `landlordId` for non-landlord, non-admin
roles, matching the existing `credit.ts:109` pattern:
```ts
const callerLandlordId = req.user!.role === 'landlord'
  ? req.user!.profileId
  : req.user!.landlordId
```

### 3. `GET /api/units/schedule/master` same misresolution

**Severity: medium — master schedule page was empty for
every team-role user.**

Same bug pattern as #2 in three queries (units, bookings,
leases). All three filters used `req.user!.profileId` →
team members got `{units:[], bookings:[], leases:[]}`.
Fixed with the same callerLandlordId resolution applied to
all three.

## Architectural finding (worth recording)

**`LEASE_TYPE_MATRIX` ↔ `units_unit_type_check` CHECK
constraint drift.** The route at units.ts:184 defines:
```ts
const LEASE_TYPE_MATRIX: Record<string, string[]> = {
  residential:     [...], rv_spot: [...], storage: [...],
  parking:         [...], short_term_cabin: [...],
}
```
The schema CHECK on `units.unit_type` allows:
```
['apartment', 'single_family', 'rv_spot', 'mobile_home',
 'storage', 'commercial']
```

Three matrix keys (`residential`, `parking`,
`short_term_cabin`) are NOT valid `unit_type` values
per the CHECK. The route's `||'residential'` default also
fails the CHECK on any unknown input. Consequence: passing
one of these "matrix-only" types as `unitType` returns
500 (23514 check_constraint_violation) instead of a clean
400. Pinned in `PATCH /:id/type > S400 finding` test case.

Per CLAUDE.md "Single source of truth for enums and CHECK
constraints" — this is the exact class of drift that rule
forbids. Fix should:
1. Decide the canonical `UNIT_TYPES` list in
   `packages/shared/src/index.ts`
2. Migration to rewrite the CHECK to match
3. Update the matrix to use the canonical keys
4. Add zod validation at the route layer so invalid types
   return 400, not 500

Bundle into the validation-hygiene micro-session
(now 21 items in the backlog).

## Items shipped

### Test coverage — 31 cases / 9 describe blocks

New file: `apps/api/src/routes/units-gap-close.test.ts`
(~390 lines)

**GET /api/units — 4 cases**
- Landlord sees only own units (cross-tenant filtered)
- Admin sees all
- propertyId filter narrows
- **S400 fix:** PM team-role sees their landlord's units
  (was empty pre-fix)

**PATCH /api/units/:id/status — 4 cases**
- Happy: status set
- Cross-landlord → 403
- Unknown unit → 404
- Invalid enum → 400

**POST /api/units/:id/eviction-mode — 5 cases**
- **S400 fix happy:** enable+confirm sets payment_block ON
- **S400 fix happy:** disable clears block + timestamp + actor
- Missing confirm → 400 (zod refine)
- Cross-landlord → 403
- Property_manager team member → 403 (high-stakes
  blocked from team roles by canManageLandlordResource
  with [] allowlist)

**PATCH /api/units/:id/type — 3 cases**
- Happy: rv_spot type + lease_types_allowed matrix
- **S400 finding:** matrix↔CHECK drift pinned
- Cross-landlord → 403

**GET /api/units/:id/availability — 3 cases**
- Happy: returns seeded booking in 90d window
- Cross-landlord → 403
- Unknown unit → 404

**GET /api/units/:id/bookings — 2 cases**
- Happy: returns booking + requires_booking_acknowledgment
- Cross-landlord → 403

**PATCH /api/units/:id/bookings/:bookingId/acknowledge — 4 cases**
- Happy: stamps acknowledgment_signed_at
- Idempotent: re-ack is a no-op
- Cross-landlord → 403
- Unknown booking → 404

**GET /api/units/schedule/master — 3 cases**
- Happy: units + bookings + leases scoped to caller landlord
- unitType filter narrows
- **S400 fix:** PM team-role sees their landlord's schedule
  (was empty pre-fix)

**POST /api/units/:id/cancel-scheduled-activation — 3 cases**
- Happy: clears scheduled_activation_at + by
- No scheduled activation → 400
- Cross-landlord → 403

## Files touched

```
apps/api/src/routes/
  units.ts                              (3 surgical fixes:
                                          uuid cast in
                                          eviction-mode +
                                          callerLandlordId
                                          resolution in
                                          GET / and
                                          GET /schedule/master)
  units-gap-close.test.ts               (NEW — ~390 lines,
                                          31 cases)
```

No migrations. No schema changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Fix the eviction-mode 500 in the same pass? | **Yes — fix-it-right.** Surfaced during recon by running the happy-path test. High-severity production bug (toggle non-functional). One-character cast fix, no scope expansion. |
| Fix both team-role misresolution bugs in the same pass? | **Yes.** Same class (callerLandlordId), same fix shape (5 lines each), both in units.ts. Both silently returned empty data — invisible UX failure. |
| Fix the LEASE_TYPE_MATRIX↔CHECK drift in S400? | **No — flag and defer.** This is a wider fix that requires (a) deciding the canonical unit-type list, (b) a migration, (c) backfill consideration. Belongs in the validation-hygiene micro-session, not a gap-close slice. |
| Seed the PM team-member as a real user row? | **No.** The route layer trusts JWT claims for landlordId; no DB user row needed for the test. Auth middleware is `jwt.verify` only, no DB lookup. (Same posture as other team-role tests in the codebase.) |
| Cover /:id/economics? | **No — walkthrough-blocked.** Per S398 deferred list. Will land alongside the other walkthrough-blocked items when Nic surfaces them. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1591 tests across 87 files,
  0 failures**, 959.72s. **Fourth consecutive fully-green
  full-suite run.**
- 31 new test cases.
- 3 production bug fixes (eviction-mode 500 + GET / team
  misresolution + schedule/master team misresolution).
- 1 architectural finding (LEASE_TYPE_MATRIX ↔ CHECK
  drift).
- 0 production regressions.

## Items deferred — what S401 could target

### High-band files remaining

After units.ts close, the remaining routes-pre-services
work:
- **background.ts — 25 routes (Checkr wire-up;
  credentials in hand per memory)**
- **Medium-band batch — notifications + bulletin +
  reports + stripe + bankAccounts + payments + terminal +
  posCustomerOnboarding (~36 routes across 8 files)**

**Recommend S401 = medium-band batch start (notifications
or bulletin or reports — pick the smallest first to ship
a clean slice).** Defer background.ts/Checkr wire-up
until route-test sweep is fully closed; Checkr is a
different kind of work (live API integration) and
breaking it up keeps the slice cadence clean.

### Validation-hygiene backlog (now 21 items)

Same as S399 + the S400 LEASE_TYPE_MATRIX ↔ CHECK drift
finding. One hygiene micro-session ~50 lines + ~20 small
pins. Includes the 6 S398 product decisions.

### Pending Nic decisions

Unchanged (S398 product decisions captured in
`project_s398_product_decisions.md`).

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S400):
- **36 production bug fixes** (+3 in S400)
- 21 architectural / validation findings flagged
- 1591 tests covering ~364 of 506 audited routes (72%)

## Items deferred (cross-session docket, post-S400)

Unchanged from S399 + the LEASE_TYPE_MATRIX ↔ CHECK drift
note above.

## Nic-pending

Unchanged.

## What S401 should target

**Recommended: medium-band batch — start with the
smallest file (notifications or bulletin or reports).**
Ships a clean slice + closes another route file. Pick the
file with the fewest uncovered routes for fastest
slice-to-handoff turnaround.

**Alternatives:**
- Validation-hygiene micro-session (21-item backlog +
  S398 product decisions implementation)
- background.ts gap-close + Checkr wire-up (credentials
  in hand, but bigger arc — recommend AFTER all
  route-test sweep is closed)

---

End of S400 handoff. **units.ts arc CLOSED at 16/17
routes** (the 1 remaining is /:id/economics,
walkthrough-blocked). Slice / 31 tests / 3 production bug
fixes / 1 architectural finding.

1591 tests / 87 files / 0 failures. Fourth consecutive
fully-green full-suite run.

**36 cumulative production bug fixes shipped across the
bug sweep.** Notably: the eviction-mode toggle was
completely non-functional in production prior to S400 —
the highest-severity bug surfaced in the sweep since
S388.

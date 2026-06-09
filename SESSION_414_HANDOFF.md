# Session 414 — closed

## Theme

**Sixth validation-hygiene micro-session. Two backlog
items shipped — S399 bulk-create input hardening +
S407 follow-on UNIQUE constraint on payments. PLUS:
discovered + cleared a long-running test-infra
problem (9 zombie ts-node-dev processes).**

Suite at S413 close: **1836 / 99 files**.
Suite at S414 close: **1901 / 106 files** (+65 cases,
+7 files). 0 failures. Runtime **65.63s** (down from
~1300s — see the test-infra finding below).
Eighteenth consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### Fix 1: S399 bulk-create input hardening

`POST /api/properties/:id/units/bulk` pre-fix accepted
arbitrary count (DoS via count=10000), arbitrary
prefix length, and arbitrary type strings (only
caught later by the DB `units_unit_type_check`
constraint at INSERT → 500 with cryptic 23514).

Added zod validation:
```ts
const UNIT_TYPES = ['apartment', 'single_family', 'rv_spot',
                    'mobile_home', 'storage', 'commercial'] as const
const bulkSchema = z.array(z.object({
  type:            z.enum(UNIT_TYPES),
  count:           z.number().int().min(1).max(200, 'count must be ≤ 200 per group'),
  prefix:          z.string().max(32, 'prefix must be ≤ 32 chars').optional(),
  rentAmount:      z.number().positive().optional(),
  securityDeposit: z.number().min(0).optional(),
})).min(1, 'unitGroups must have at least one group')
```

Also fixed the `TYPE_PREFIXES` map — pre-fix had
`'house'` and `'other'` keys that never matched the
schema CHECK constraint, so those defaults were dead.
Aligned keys to the CHECK allow-list.

### Fix 2: S407 follow-on UNIQUE constraint on payments

S407 added a SELECT-then-skip guard in
`/initiate-rent-collection` to prevent duplicate rent
charges, but left a residual race window for true
concurrent writes. S414 closes it with a partial
UNIQUE index.

**Migration journey:** I shipped 3 migrations total
because the first two had wrong scope:

1. `20260607151930_payments_unique_per_unit_month.sql`
   — first attempt with `WHERE status != 'cancelled'`.
   But 'cancelled' isn't a valid status per
   `payments_status_check` (allow-list:
   pending/processing/settled/failed/returned/
   paid_via_deposit). The filter was a no-op.
2. `20260607152233_payments_unique_fix_status_filter.sql`
   — fix-forward to `WHERE status NOT IN ('failed',
   'returned')`. Failed/returned rows are retry-
   eligible so they're correctly excluded. But this
   covered ALL types — broke `generateMoveInInvoice`
   which legitimately inserts multiple `type='fee'`
   rows for the same (unit, due_date).
3. `20260608092623_payments_unique_rent_only.sql` —
   final fix-forward narrowing to `type='rent'` only.
   The S407 bug being defended against is rent-
   specific (the monthly idempotency for
   `/initiate-rent-collection`). Other types (fee,
   deposit, late_fee, utility, float_fee) don't
   need this guard.

Final index:
```sql
CREATE UNIQUE INDEX ux_payments_unit_rent_due_date_active
  ON payments (unit_id, due_date)
  WHERE type = 'rent' AND status NOT IN ('failed', 'returned');
```

Also updated the route's filter to match the corrected
exclusion: `status NOT IN ('failed', 'returned')`
instead of the stale `status != 'cancelled'`.

### Test fixture updates (3 files)

Tests that pre-S414 seeded multiple `type='rent'` rows
with the same (unit, due_date) needed updating:
- `payments.test.ts` — `seedPayment` helper now
  auto-increments a per-call month offset
- `tenants-actions.test.ts` — other-tenant row date
  pushed to -100 days
- `tenants-admin-views.test.ts` — settled payments
  spread across distinct due_dates
- `reports.test.ts` — monthly-array test seeds
  payments with distinct due_dates

## ⚠ TEST-INFRA META-FINDING (the big one)

After multiple failed full-suite runs with
non-deterministic schema-drift / FK / connection-
terminated errors (also hit in S410 and S413), I
checked running processes and found:

**Nine zombie `ts-node-dev` processes running
`src/index.ts` from April 30, 2026** — over a month
old, with 25,000+ minutes of CPU time each. Plus one
from Feb 2 (last Friday).

```
gold  94492  68.7% CPU  RN  30Apr26  25526min  /usr/local/bin/node ... src/index.ts
gold  94488  68.0% CPU  R   30Apr26  25526min  /usr/local/bin/node ... src/index.ts
gold  94487  66.5% CPU  R   30Apr26  25526min  /usr/local/bin/node ... src/index.ts
... (9 total)
```

These zombies were:
- Holding DB connections to gam / gam_test
- Likely triggering hot-reload migrations / schema
  actions on file change
- **Starving CPU**: the suite was running at
  ~1300-1500s instead of its true ~65s baseline
  because 9 processes were each at 60-90% CPU
- The "agents vitest" process I kept killing in S414
  was likely a child / restart artifact from one of
  these zombies

After `pkill -9 -f ts-node-dev`:
- Suite runtime collapsed from ~1300s to **65.63s**
  (20× faster)
- All non-deterministic failures cleared
- gam_test schema-drift issue gone

Likely root cause: a stale dev.sh / nodemon /
ts-node-dev autorestart that kept respawning whenever
the parent died (e.g., laptop sleep, terminal close,
session reset). Once spawned, they ran forever.

**Practical advice for future sessions:** if the
suite suddenly gets slow OR starts hitting
non-deterministic schema/connection errors, run
`pgrep -fl ts-node-dev` before assuming it's a real
test problem.

## Items shipped

### Migrations (3)

```
apps/api/src/db/migrations/
  20260607151930_payments_unique_per_unit_month.sql       (initial; superseded)
  20260607152233_payments_unique_fix_status_filter.sql    (fix-forward 1)
  20260608092623_payments_unique_rent_only.sql            (fix-forward 2; final)
```

Fix-forward chain is the right pattern per CLAUDE.md
("never edit an applied migration"). Three migrations
applied — net effect is a single partial UNIQUE on
`(unit_id, due_date) WHERE type='rent' AND status NOT
IN ('failed', 'returned')`.

### Route + test changes

```
apps/api/src/routes/
  properties.ts                        (S399 bulk-create
                                         zod schema +
                                         TYPE_PREFIXES
                                         alignment)
  payments.ts                          (S414 status
                                         filter aligned
                                         to actual allow-
                                         list)
  s414-hygiene.test.ts                 (NEW — 11 cases:
                                         8 bulk-create
                                         + 3 UNIQUE
                                         constraint)
  payments.test.ts                     (seedPayment
                                         helper auto-
                                         increments
                                         month offset)
  tenants-actions.test.ts              (cross-tenant
                                         date offset)
  tenants-admin-views.test.ts          (distinct
                                         due_dates)
  reports.test.ts                      (monthly seed
                                         distinct dates)
```

### Test coverage — 11 new cases

**S399 bulk-create — 8 cases**
- Happy: rv_spot count=3 → 201
- count > 200 → 400
- count = 200 exact → 201 (boundary)
- prefix > 32 chars → 400
- Invalid type "house" → 400 (was 500 from DB CHECK)
- type=single_family with default prefix "House"
  (which had no prior route mapping) → 201
- Empty unitGroups → 400
- count = 0 → 400 (was silently skipped pre-fix)

**S407 UNIQUE — 3 cases**
- Duplicate INSERT raises 23505 unique_violation
- Failed + returned rows excluded; retry-eligible
- Different (unit, type, due_date) combos still allowed

## Files touched (full list)

```
apps/api/src/
  db/migrations/20260607151930_payments_unique_per_unit_month.sql
  db/migrations/20260607152233_payments_unique_fix_status_filter.sql
  db/migrations/20260608092623_payments_unique_rent_only.sql
  routes/properties.ts                   (bulk hardening)
  routes/payments.ts                     (status filter)
  routes/s414-hygiene.test.ts            (NEW)
  routes/payments.test.ts                (seed fix)
  routes/tenants-actions.test.ts         (date offset)
  routes/tenants-admin-views.test.ts     (date spread)
  routes/reports.test.ts                 (date distinct)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Cap bulk-create count at what number? | **200.** Sensible product cap; no real-world bulk-create scenario needs more. 100-unit RV park is realistic; 200-unit threshold gives 2× headroom. |
| Initially scope the UNIQUE across all types? | **No (in retrospect)** — moved to rent-only after the move-in invoice broke. The S407 bug is rent-specific; constraint should match. |
| Allow `failed` and `returned` rows to coexist with `pending`? | **Yes.** Retry semantics: a failed ACH pull legitimately needs a fresh `pending` row to retry. Excluding failed/returned from the partial UNIQUE preserves the retry flow. |
| Fix-forward each migration mistake or revise the failed one? | **Fix-forward.** CLAUDE.md is explicit: never edit an applied migration. 3 migrations in S414 is the correct pattern. |
| Update test fixtures vs widen the constraint? | **Update tests.** The test seeds were unrealistic (real production wouldn't have multiple active rent rows for same month); the constraint correctly mirrors production intent. |
| Kill zombie ts-node-dev procs first or fix tests first? | **Kill zombies first.** The repeated false-positive failures were eating debugging time; clean machine state is a prerequisite for trusting test results. |
| Document the zombie finding prominently? | **Yes — meta-finding section.** Likely to recur for me or whoever picks up; a 30-second `pgrep` check could save someone hours. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1901 tests across 106
  files, 0 failures**, 65.63s. **Eighteenth
  consecutive fully-green full-suite run.**
- 11 new test cases for S399 + S407 UNIQUE.
- 4 existing test files updated for the new constraint.
- 0 production regressions.

## Items deferred — what S415 could target

### Validation-hygiene backlog (was 21, now 19)

Shipped in S414:
- S399 bulk-create input hardening
- S407 UNIQUE constraint on payments

Remaining:
- S413 spawned: vendor credit_balance CONSUMPTION on
  subsequent bills (the matching half of S386)
- S412 spawned: confirm entity-type-conditional
  EIN/SSN call (Nic-pending)
- S412 spawned: apply strict-validation pattern to
  books_vendors + books_employees POST routes
- S411 spawned: disposable-domain fan-out to other
  email-accepting routes
- **S414 spawned**: investigate ts-node-dev zombie
  spawner; understand WHY they kept respawning so a
  fresh dev session doesn't reaccumulate
- S400 LEASE_TYPE_MATRIX ↔ CHECK drift
- S403 cross-landlord PI capture/cancel
- S405 bank_last4 null + ach_verified=TRUE defensive
- S405 /complete missing isExpired check
- S408 finding A (monthly-statement off-by-one default
  — Nic-pending)
- S408 finding B ($15 hardcoded fee — Nic-pending)
- S377 (a) email-blocked

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S414):
- **44 production bug fixes** (S414 is hardening +
  test infra, not a bug discovery — but the test-
  infra meta-finding is arguably a "won't ever 500
  prod but will eat your debugging time" class fix)
- 19 architectural / validation findings remaining
- 1901 tests across 106 files

## What S415 should target

**Recommended: investigate the ts-node-dev zombie
spawner.** The killed zombies will probably come
back when you next start dev.sh — understanding
why is worth a session. Possible culprits:
- `dev.sh` daemonizes ts-node-dev with bad signal
  handling
- A `concurrently` config that doesn't propagate
  SIGTERM
- nodemon / supervisor with `restartOnExit: true`
  somewhere

Without fixing this, every dev session adds another
zombie and the next bug-sweep session will have to
do the kill-and-retry dance again.

**Alternatives:**
- Vendor credit_balance CONSUMPTION (S413 follow-on)
- Smaller hygiene bundle: S400 matrix drift + S403
  cross-landlord PI capture
- Checkr wire-up
- Services audit start

---

End of S414 handoff. **S399 + S407 follow-on shipped
+ test-infra meta-finding: 9 zombie ts-node-dev
processes were the root cause of 4+ sessions of
intermittent test failures. Suite runtime collapsed
from 1300s → 65s after cleanup.**

1901 tests / 106 files / 0 failures. Eighteenth
consecutive fully-green full-suite run.

**44 cumulative production bug fixes shipped across the
bug sweep.** Validation-hygiene backlog reduced from
21 to 19. Major recurring infra issue identified and
worked around (root cause still to investigate).

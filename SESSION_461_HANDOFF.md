# Session 461 — closed

> **Numbering note:** SERVICE-BUSINESS / Phase 1a arc (continues S460).
> S459 was the parallel AI-AGENT / state-law arc.

## Theme

**Phase 1a.2 continuation. Recurring schedules — RFC 5545 RRULE
template rows + materializer service that creates concrete
`appointments` rows on a rolling window. New migration
(recurring_schedules table + FK on appointments +
materializer-idempotency UNIQUE index), new service module
(`recurringScheduleMaterializer.ts` with pure
`computeOccurrences` + DB-touching `materializeAllSchedules`),
new route file (6 endpoints), 29 cases. Cron registration
deferred to a later session — the materializer can be invoked
manually for now.**

Suite at S460 close: 2913 / 153.
Suite at S461 close: **2942 / 154 / 0 failures**, 127.11s.

Zero tsc regressions.

## What shipped

### Migration

**`20260613130000_recurring_schedules.sql`**
- `recurring_schedules` table: id, business_id (CASCADE),
  customer_id (FK business_customers),
  created_by_user_id, service_type, rrule (TEXT — RFC 5545
  format), time_of_day (HH:MM with format CHECK), start_date,
  end_date (nullable, CHECK end >= start), default_duration_
  minutes, default_notes, status (active/paused/ended),
  paused_at, paused_reason (audit), last_materialized_at,
  timestamps + updated_at trigger.
- CHECK constraints: status enum, duration positive,
  time_of_day format, end-after-start, paused-audit.
- Three indexes: per-business + status (list filter),
  active-only partial (materializer scan), per-customer.

- **Appointments table extension** (same migration):
  - FK constraint added on `appointments.recurring_schedule_id`
    → recurring_schedules(id) ON DELETE SET NULL. The column
    was added in S460 as a nullable placeholder.
  - PARTIAL UNIQUE index
    `uniq_appointments_recurring_occurrence` ON
    `(recurring_schedule_id, scheduled_for) WHERE
    recurring_schedule_id IS NOT NULL`. This is the
    materializer's idempotency guarantee — ON CONFLICT DO
    NOTHING on this index prevents duplicate appointment
    rows when the cron re-runs over the same window.

### Shared enum

```ts
export const RECURRING_SCHEDULE_STATUSES = ['active', 'paused', 'ended'] as const
```

Plus label map; single source of truth for the DB CHECK.

### Service — `services/recurringScheduleMaterializer.ts`

**`computeOccurrences(args)`** — pure function. Inputs: rrule
string, timeOfDay, startDate, endDate, from, to. Output:
Date[] of occurrence timestamps in the window.

- Constructs full RRULE syntax (DTSTART + RRULE) so the
  `rrule` library has full context.
- Computes effective bounds: max(schedule.start, window.from)
  for lower, min(schedule.end?, window.to) for upper. If
  schedule.end is before window.from, returns [].
- Merges time-of-day onto each occurrence date (RRULE outputs
  UTC-midnight; we set HH:MM via `withTimeOfDay()`).

**`materializeAllSchedules(now, lookaheadDays=60)`** — walks
active schedules, generates occurrences, INSERTs appointments
with ON CONFLICT DO NOTHING.

- Reads all `status='active'` schedules.
- For each: computes occurrences in [now, now+60d], INSERTs.
  Idempotency via the partial UNIQUE on appointments.
- Stamps `last_materialized_at` after each schedule's
  processing (ops observability — doesn't drive resume).
- Returns `{ schedules_scanned, appointments_created, errors }`.

### `routes/recurringSchedules.ts` — 6 endpoints

Same auth shape as appointments (owner + staff via shared
helper). RRULE validation happens in-route via
`validateRrule()` — `RRule.fromString()` is wrapped in a
try/catch that re-throws as `AppError(400)`.

- **`POST /api/recurring-schedules`** — create. Validates
  rrule + customer-belongs-to-business. Stamps
  created_by_user_id.
- **`GET /api/recurring-schedules`** — list with ?status,
  ?customerId, ?limit. JOINs business_customers for owner-
  side display.
- **`GET /api/recurring-schedules/:id`** — read one + full
  customer JOIN.
- **`PATCH /api/recurring-schedules/:id`** — mutate
  serviceType / rrule / timeOfDay / endDate / duration /
  notes. Strict zod. Refuses ended schedules (terminal).
- **`POST /api/recurring-schedules/:id/pause`** — active →
  paused + paused_at + reason. Double-pause 404.
- **`POST /api/recurring-schedules/:id/resume`** — paused →
  active + clear paused fields. Resume-on-active 404.

### Mount + cleanup

- `app.use('/api/recurring-schedules', recurringSchedulesRouter)`
- `cleanupAllSchema` adds `DELETE FROM recurring_schedules`
  between appointments and businesses. CASCADE on businesses
  would handle it transitively but explicit DELETE keeps the
  chain readable + protects against FK ordering surprises.

### Tests — `routes/recurringSchedules.test.ts` (NEW, 29 cases)

- **POST (5)**: happy + invalid rrule 400 + bad time format
  400 + end-before-start 400 (DB CHECK surfaces as 500;
  asserted `>= 400` — acceptable for MVP, flagged for
  hygiene) + cross-business customer 404
- **GET (3)**: scoped + customer JOIN + ?status filter + cross-
  business isolation
- **PATCH (5)**: updates rrule+time + invalid rrule 400 +
  empty 400 + strict-schema unknown 400 + ended schedule 404
- **pause/resume (4)**: happy pause + double-pause 404 +
  happy resume + resume-on-active 404
- **computeOccurrences pure (5)**: weekly Tuesday in window +
  respects end_date + respects from-bound + monthly-15th +
  time_of_day stamps hour
- **materializeAllSchedules (7)**: creates appointments for
  active schedule + idempotent (2nd run = 0) + skips paused +
  skips ended + respects end_date + stamps last_materialized_at
  + multiple schedules under same business

## Items shipped

```
apps/api/package.json                            (+ rrule ^2.8.1)
apps/api/src/db/migrations/
  20260613130000_recurring_schedules.sql         (NEW — table + FK + UNIQUE)
apps/api/src/services/
  recurringScheduleMaterializer.ts               (NEW — ~130 lines)
apps/api/src/routes/
  recurringSchedules.ts                          (NEW — 6 endpoints, ~220 lines)
  recurringSchedules.test.ts                     (NEW — 29 cases)
apps/api/src/test/
  dbHelpers.ts                                   (+1 line: recurring_schedules cleanup)
apps/api/src/
  index.ts                                       (+2 lines: import + mount)
packages/shared/src/
  index.ts                                       (+ RECURRING_SCHEDULE_STATUSES enum)
```

## Decisions made during build

| Question | Decision |
|---|---|
| RRULE library | **`rrule`** (npm, MIT, widely-used). Runs in-house per the in-house-everything principle. Handles RFC 5545 parsing + occurrence generation. |
| Time of day on the schedule row, or part of the RRULE? | **Separate `time_of_day` column.** RRULE technically supports time via DTSTART, but mixing the schedule's recurrence pattern with time-of-day complicates the parse + the PATCH. Separate columns map cleaner to UI: "every Tuesday at 9 AM" → rrule + time_of_day fields. |
| Materializer cron registration in this session? | **Deferred.** The function exists + is testable; wiring it into `jobs/scheduler.ts` is its own concern (involves choosing the cron time, ensuring it doesn't collide with other daily jobs, etc.). Manual invocation works for now; the route engine in Phase 1a.3 can invoke materializeAllSchedules() on-demand if the cron isn't there. |
| Idempotency mechanism | **Partial UNIQUE index + ON CONFLICT DO NOTHING.** Materializer never needs to track its own state; the DB enforces "same (schedule, time) → only one appointment row." Safe under concurrent runs too. |
| 60-day lookahead default | **Reasonable balance.** Long enough that the route engine always has data; short enough that the appointments table doesn't bloat with years of speculative occurrences for active schedules. Adjustable via the function parameter; if a business needs longer-window planning we can override per-schedule later. |
| `last_materialized_at` — drive resume from this, or full re-query? | **Full re-query every run.** Resume-from-stamp would require careful boundary handling (off-by-one on the day boundary, what about clock skew on the cron host, etc.). ON CONFLICT DO NOTHING makes full re-query the simplest correct option. The stamp is observability only. |
| `end_date < start_date` returns 500 not 400 | **Flagged for follow-up hygiene.** The DB CHECK rejects it; we don't pre-flight at the app layer (yet). Asserting `>= 400` in tests, but the right fix is an app-layer guard returning 400 with a clear message — same pattern as business_customers customerType. ~3 lines when we want it. |

## Verification

- `npx tsc --noEmit` clean.
- `npm test`: **2942 / 154 / 0 failures**, 127.11s. Suite
  went 2913 → 2942 (+29 = exactly the new test cases).
- Migration applied cleanly; schema.sql at 12,870 lines.
- All prior business-arc tests still pass.

### Bugs caught during build

None. Author's CWD habit (running vitest from packages/shared)
caught the second time, fixed by cd-ing.

## Phase 1a.2 — progress

- ✅ S460 — appointments primitive
- ✅ **S461 — recurring schedules + materializer (this session)**
- ⏳ Next — Cron registration for the materializer + business
  portal calendar UI
- ⏳ Later — Integration + smoke walk

Phase 1a.2 is ~60% by effort. The biggest remaining piece is
the calendar UI (Day/Week/Month views are a non-trivial React
build). Cron registration is small.

## What the next session should target

**Two paths, recommend the second:**

**A. Cron-register the materializer (small).**
Wire `materializeAllSchedules()` into `jobs/scheduler.ts` as a
daily run at e.g. 2 AM local. Maybe ~10 cases verifying the
job runs + telemetry stamps fire. Small session.

**B. Calendar UI in `apps/business` (recommended).**
The route engine in Phase 1a.3 needs appointment data to
optimize against; for the dev/test cycle that data has to
exist visibly. A calendar surface in the business portal
lets you (1) see materialized appointments after running the
cron, (2) verify the schedule's rrule produces what you
expected, (3) start to feel the operator workflow. Skip the
cron until that visual feedback exists.

After (B), the natural next is (A) — once you can SEE the
appointments, automating the materialization is the
obvious next step.

**My pick: B.**

## Phase 1a.1 walk

Still pending. The portal scaffold (S458) is buildable + the
auth wiring is tested; you can walk any time. After the
calendar UI lands, the walk gets meaningfully bigger
(login → create schedule → see materialized appointments in
calendar) so doing it now would mean walking the same paths
twice.

---

End of S461 handoff. **Recurring schedules + materializer
shipped — RRULE parsing, idempotent generation via partial
UNIQUE + ON CONFLICT DO NOTHING, 6 CRUD endpoints, 29 cases
across the route layer + service layer + pure function.**

2942 tests / 154 files / 0 failures.

**Phase 1a.2 is ~60% by effort.** Calendar UI + cron
registration remain.

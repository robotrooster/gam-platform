# Session 460 — closed

> **Numbering note:** this is the SERVICE-BUSINESS / Phase 1a arc
> (continues S458). S459 was the parallel AI-AGENT / state-law arc;
> both arcs increment the same counter, so numbers interleave.

## Theme

**Phase 1a.2 opened. Appointments primitive — the one-row-
per-time-slot foundation that the route engine (Phase 1a.3)
will consume. Migration + 6-endpoint route file + 31 cases.
Both business_owner and business_staff can CRUD; the helper
`requireBusinessId` resolves businessId differently per role
(owner via businesses table, staff via JWT). Recurring
schedules + materializer cron come next.**

Suite at S458 close: 2882 / 152 (no API changes).
Suite at S460 close: **2913 / 153 / 0 failures**, 113.02s.

Zero tsc regressions.

## What shipped

### Migration

**`20260613120000_appointments_table.sql`**
- `appointments` table: id, business_id (CASCADE), customer_id
  (FK business_customers), created_by_user_id (FK users —
  NULL for future cron-generated rows), service_type (free-
  form text), scheduled_for, duration_minutes (default 30),
  status (scheduled / completed / cancelled / no_show),
  notes, completed_at, cancelled_at, cancelled_reason,
  recurring_schedule_id (NULL placeholder for the next-
  session FK), timestamps + updated_at trigger.
- CHECK constraints: status enum, duration positive,
  completed/cancelled audit (terminal states must carry
  their stamp).
- Indexes: (business_id, scheduled_for) WHERE
  status='scheduled' — load-bearing for the Phase 1a.3
  route generation; (customer_id, scheduled_for DESC) for
  per-customer history; (business_id, status,
  scheduled_for DESC) for analytics views.

### Shared enum exports (`packages/shared/src/index.ts`)

```ts
export const APPOINTMENT_STATUSES = ['scheduled','completed','cancelled','no_show'] as const
export type AppointmentStatus = typeof APPOINTMENT_STATUSES[number]
export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = { … }
```

Single source of truth for the CHECK constraint values.

### `routes/appointments.ts` — 6 endpoints

**Auth helper**: `requireBusinessId(req)` resolves the calling
user's businessId. Owners go through `businesses.owner_user_id`;
staff use the JWT.businessId set at /login (S454). Non-business
roles get 403. Staff without businessId on JWT (edge case) get
403.

**`POST /api/appointments`**
- Body: customerId, serviceType, scheduledFor (ISO datetime),
  durationMinutes (optional, defaults 30), notes (optional).
- Customer existence + cross-business isolation: customer
  must belong to the same business + be status='active'.
- Stamps created_by_user_id from the JWT.

**`GET /api/appointments`**
- Filters: `?date=YYYY-MM-DD` (single day),
  `?from=ISO&to=ISO` (range), `?customerId=`, `?status=`,
  `?limit=` (max 1000).
- JOIN business_customers — surfaces customer name +
  address + lat/lon directly on each row so the future
  route generator can consume one query result.
- ORDER BY scheduled_for ASC (the natural order for daily
  route review).

**`GET /api/appointments/:id`**
- Returns the appointment + full customer JOIN for the
  detail page.
- Cross-business 404.

**`PATCH /api/appointments/:id`**
- Mutable: serviceType, scheduledFor, durationMinutes, notes.
- Strict zod schema (`.strict()`) refuses unknown keys —
  status changes go through /complete or /cancel, never
  through PATCH.
- WHERE status='scheduled' — cancelled/completed rows can't
  be PATCHed (no accidental re-activation). Generic 404
  hides the "already finalized" distinction.
- Cross-business 404.

**`POST /api/appointments/:id/complete`**
- Idempotency: WHERE status='scheduled' so double-complete
  404s.

**`POST /api/appointments/:id/cancel`**
- Body: `{ reason?: string, no_show?: boolean }`.
- `no_show=true` flips status to 'no_show' instead of
  'cancelled' — distinct outcomes for the future analytics
  surface (no-shows are tenant-facing pattern; cancellations
  are operational).
- Double-cancel 404.

### `index.ts` mount + `dbHelpers.ts` cleanup

- `app.use('/api/appointments', appointmentsRouter)`.
- `cleanupAllSchema` adds `DELETE FROM appointments` before
  the businesses wipe. CASCADE on businesses would transitively
  clear them but explicit DELETE keeps the order readable.

### Tests — `routes/appointments.test.ts` (NEW, 31 cases)

- **POST (10)**: happy owner + happy staff (creates with
  staffUserId as created_by) + cross-business customer 404
  + archived customer 404 + non-business role 403 + staff
  without JWT.businessId 403 + invalid datetime 400 +
  missing serviceType 400 + custom duration persists + 401
- **GET (8)**: no-filter returns all + ?date day + ?from/?to
  range + ?customerId + ?status (cancelled rows return) +
  cross-business isolation + JOIN row shape includes customer
  fields + ORDER BY scheduled_for ASC
- **GET /:id (3)**: happy w/ customer detail + cross-business
  404 + unknown id 404
- **PATCH (5)**: reschedule + duration + empty 400 + strict-
  schema unknown 400 + PATCH on cancelled appointment 404 +
  cross-business 404
- **POST complete (2)**: happy stamp + double-complete 404
- **POST cancel (3)**: happy w/ reason + no_show flag flips
  to 'no_show' + double-cancel 404

## Items shipped

```
apps/api/src/db/migrations/
  20260613120000_appointments_table.sql       (NEW)
apps/api/src/routes/
  appointments.ts                              (NEW — 6 endpoints, ~250 lines)
  appointments.test.ts                         (NEW — 31 cases)
apps/api/src/test/
  dbHelpers.ts                                 (+1 line: appointments cleanup)
apps/api/src/
  index.ts                                     (+2 lines: import + mount)
packages/shared/src/
  index.ts                                     (+ APPOINTMENT_STATUSES enum)
```

## Decisions made during build

| Question | Decision |
|---|---|
| service_type — enum or free-form text? | **Free-form text.** Different business types (trash, lawn, AC repair, equipment delivery) have wildly different services. Enum would either be too restrictive or sprawl into hundreds of categories nobody maintains. |
| One row per occurrence or one row per recurring template? | **One row per occurrence.** Recurring schedules will be a SEPARATE table; the materializer cron creates concrete appointment rows for the next N days. Route engine reads concrete rows. |
| Staff vs owner CRUD differentiation? | **Both can do all six operations for MVP.** Per-staff-role gating lands when the permission framework is built. |
| PATCH allowed on cancelled/completed? | **No.** Once status leaves 'scheduled', PATCH 404s. Prevents accidental "edit the cancelled visit" patterns that would corrupt audit. |
| no_show as separate status or just cancelled+reason? | **Separate status.** No-shows are customer behavior; cancellations are operational. Different downstream analytics + different billing impact. |
| created_by_user_id required? | **Nullable.** Future recurring-schedule materializer cron creates rows without a user — that's SYSTEM creation, not actor creation. |
| `recurring_schedule_id` column added now or later? | **Now, FK constraint added later.** Adding the column alongside the table avoids a future ALTER TABLE lock. |
| Customer filter — query param or path-based? | **Query param.** Single source of truth for listing; one route, multiple optional filters. |

## Verification

- `npx tsc --noEmit` clean.
- `npm test`: **2913 / 153 / 0 failures**, 113.02s. Suite
  went 2882 → 2913 (+31 = exactly the new test cases).
- Migration applied cleanly; schema.sql regenerated to
  12,765 lines.

### Bugs caught during test authoring

None.

## Phase 1a.2 — progress

- ✅ **S460 — appointments primitive (this session)**
- ⏳ Next — Recurring schedules table + materializer cron
- ⏳ Later — Portal calendar UI (mounts on apps/business)
- ⏳ Later — Integration + smoke walk for the appointments
  flow

Phase 1a.2 is ~25% by effort.

## What the next session should target

**Recommended: `recurring_schedules` table + materializer.**

Migration:
- `recurring_schedules` table: id, business_id, customer_id,
  service_type, rrule (RFC 5545 format), start_date,
  end_date (nullable), default_duration_minutes,
  default_notes, status (active/paused/ended), timestamps.
- ALTER appointments: add FK constraint on
  recurring_schedule_id.

API:
- POST /api/recurring-schedules
- GET /api/recurring-schedules
- PATCH /api/recurring-schedules/:id
- POST /api/recurring-schedules/:id/pause
- POST /api/recurring-schedules/:id/resume

Materializer cron (services/recurringScheduleMaterializer.ts):
- Daily run that walks active recurring_schedules
- For each, compute next 60 days of occurrences from the
  rrule, INSERT appointment rows for any not already
  materialized (idempotent via UNIQUE on
  recurring_schedule_id + scheduled_for)
- ~30-40 tests across the API + materializer paths

RRULE library: `rrule` (npm, MIT, in-house).

## Phase 1a.1 walk — still your call

The smoke walk for Phase 1a.1 (login → dashboard → settings
PATCH → customer create → staff invite) is still pending.
The API foundation is fully tested and the portal builds clean.
Walk-script was in the S458 handoff if needed.

## Items uncommitted in tree

Phase 1a.1 (S453-S458) + Phase 1a.2 first slice (S460) all
uncommitted alongside the prior state-law + .env.example
threads.

---

End of S460 handoff. **Appointments primitive shipped — one
row per concrete time slot, 6 CRUD endpoints, 31 cases
covering owner + staff auth paths, cross-business isolation,
strict PATCH schema, terminal-state guards. Phase 1a.2 is
opened.**

2913 tests / 153 files / 0 failures.

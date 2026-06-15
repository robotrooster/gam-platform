# Session 473 — closed

> SERVICE-BUSINESS / Phase 1a arc (continues S472).

## Theme

**Two polish closures: (1) the stale-route cleanup cron — daily
hard-delete of generated_routes that never got started past
their planned date + 7-day grace, with FK cascade pulling the
route_stops along; (2) `lastServicedAt` column on the customers
list, surfaced as a tinted-amber-after-14-days indicator so the
dispatcher can spot stale customers. Plus a hygiene flag noted
for next session: the route-stop complete handler doesn't
propagate to the linked appointment.status, so the appointments
table has stale data after every route run.**

Suite (api) at S472 close: 3024 / 159.
Suite (api) at S473 close: **3030 / 160 / 0 failures** (+6 from
the new cron's coverage, +1 file).

apps/business `npm run build`: clean. **321.06 KB JS / 91.05 KB
gzipped** (+0.5 KB vs S472). 1494 modules.

apps/business tsc: clean. apps/api tsc: clean.

## What shipped

### `apps/api/src/jobs/routeCleanup.ts` — NEW

`processRouteCleanup(retentionDays = 7): Promise<{routes_deleted, stops_deleted}>`

- Hard-deletes `generated_routes` rows where:
  - `status = 'generated'` (never started)
  - `generated_for_date < CURRENT_DATE - retentionDays`
- `in_progress` and `completed` routes are NEVER touched —
  they carry execution history (actual_arrival timestamps,
  driver notes, skip reasons).
- Reports both counts. The route_stops cascade is reported
  separately for ops visibility; cascade is via existing
  `route_stops.route_id REFERENCES generated_routes ON DELETE
  CASCADE`.
- Idempotent: re-runs are no-ops once backlog cleared.

### `apps/api/src/jobs/routeCleanup.test.ts` — NEW

6 cases:
- Happy delete + cascade reports correct stop count
- 3-day-old route preserved (inside window)
- in_progress + completed never touched regardless of age (60d
  old proof)
- Configurable retention: 30-day window skips 10-day-old route
- Idempotent: second run = 0/0
- No rows at all = 0/0

### `apps/api/src/jobs/scheduler.ts`

Registered at **1:45am Phoenix daily** — sits between the
recurring-schedule materializer (1:15am) and the lease-end
processor (2am). Avoids the 1:30am 1st-only platform-fee
accrual. Lazy import, log-on-non-zero pattern (matches every
other Phase 1a / Connect / FlexPay cron).

Startup log line added:
```
✓ Route cleanup:        Daily 1:45am Phoenix (stale unstarted routes, 7-day retention)
```

### `apps/api/src/routes/businessCustomers.ts`

GET / list now joins a LATERAL subquery that pulls the most
recent completed route_stop's `actual_departure` per customer:

```sql
LEFT JOIN LATERAL (
  SELECT rs.actual_departure AS last_serviced_at
    FROM route_stops rs
    JOIN appointments a ON a.id = rs.appointment_id
   WHERE a.customer_id = bc.id
     AND rs.status = 'completed'
     AND rs.actual_departure IS NOT NULL
   ORDER BY rs.actual_departure DESC
   LIMIT 1
) ls ON true
```

WHERE clause built with `bc.` table-alias prefix from the
start (cleaner than text-mangling after the fact). The
existing search/status filters survive intact; tests pass.

### `apps/business/src/pages/CustomersPage.tsx`

- `lastServicedAt: string | null` added to `CustomerRow`
  interface (camelCase per the response transform)
- New "Last serviced" table column
- `fmtLastServiced(iso)` helper:
  - `null` → em dash
  - `0 days` → "today"
  - `1 day` → "yesterday"
  - `<14 days` → "{N}d ago" in default text color
  - `14-59 days` → "{N}d ago" tinted **amber** (stale heuristic)
  - `60+ days` → "{N}mo ago" amber

The amber-after-14 threshold matches the typical trash-pickup
cadence (weekly to biweekly); 14 days roughly = "missed two
weeks." A future tuning could read the customer's recurring
schedule and flag stale based on the rule, but the simple
days-since heuristic is fine for v1.

## Hygiene flagged for next session

**Appointment-status propagation gap.** Today
`POST /routes/:id/stops/:stopId/complete` updates
`route_stops.status='completed'` but does NOT touch the linked
`appointments` row. The `appointments.status` enum
('scheduled' / 'completed' / 'cancelled' / 'no_show') was
designed to flip via the route_stop complete/skip — that
propagation never landed. Consequence today:
- `appointments.status='scheduled'` rows pile up indefinitely,
  even after the driver worked them
- The S473 last-serviced rollup correctly uses `route_stops`
  as source-of-truth (chose this deliberately)
- Future appointment-completion analytics, calendar
  rendering, or third-party integrations would read stale data

Fix scope:
- Stop complete → `appointments.status='completed', completed_at=NOW()`
- Stop skip → `appointments.status='no_show', cancelled_at=NOW()` (or
  add a new status='skipped' depending on semantics)
- Inside the same UPDATE...FROM CTE so it's atomic

Small (~30 lines + 3-4 tests). Worth doing soon — the appointments
table's CHECK constraints already require the audit timestamps
when status flips, so any future consumer would crash on the
write if we ship it after months of stale rows.

## Items shipped

```
apps/api/src/jobs/
  routeCleanup.ts                              (NEW — ~55 lines)
  routeCleanup.test.ts                         (NEW — ~115 lines, 6 cases)
  scheduler.ts                                 (+ cron block + startup log)
apps/api/src/routes/
  businessCustomers.ts                         (LATERAL join for last_serviced_at)
apps/business/src/pages/
  CustomersPage.tsx                            (+ lastServicedAt column
                                                + fmtLastServiced helper)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Soft-delete (status=abandoned) vs hard-delete stale routes | **Hard-delete.** No audit value — the row records intent that never happened. Migration to add a new status would be heavier than the value it provides. Stops cascade via existing FK. |
| Retention window | **7 days.** Long enough to absorb "I generated yesterday, planned to use today" usage patterns; short enough that the backlog doesn't pile up. Configurable parameter for future tuning. |
| Cron time slot | **1:45am Phoenix.** Free of conflict with materializer (1:15), platform-fee (1:30 1st-only), lease-end (2am). Sequential placement of all the Phase 1a jobs in a 15-min slot keeps the operational window tight. |
| Last-serviced source: appointments.status or route_stops.actual_departure | **route_stops.actual_departure.** Source of truth is the driver's tap-complete; appointments.status is currently stale (separate flag). When the propagation lands, both sources align. |
| Stale threshold for amber tint | **14 days.** Weekly trash → biweekly = max regular cadence. After 14 days something's off; dispatcher should look. Customer-specific tuning (read the rrule) deferred. |
| Format buckets — show in days, weeks, or months? | **Days for <60, months for ≥60.** "53d ago" is more actionable than "1.7mo"; "180d ago" is harder to read than "6mo ago." Switchover at 60. |
| Customer search clause prefix | **Build with `bc.` from the start.** Mangling after the fact (regex chains) is fragile. Original was unprefixed; new query needs the alias. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/business && npx tsc --noEmit`: clean.
- `cd apps/api && npm test`: **3030 / 160 / 0 failures** (+6 from S472).
  - Targeted `vitest run routeCleanup.test.ts businessCustomers.test.ts`:
    41 passed (35 + 6).
- `cd apps/business && npm run build`: clean. 1494 modules.
  321.06 KB JS / 91.05 KB gzipped.

### Bugs caught during build

- **Test seed missing NOT NULL columns**: First test run failed on
  `total_miles` NOT NULL — fixed by including the 4 required
  summary columns + the audit-stamp timestamps for non-generated
  status rows.
- **route_stops NOT NULL `estimated_arrival`**: Caught next; fixed
  with default test timestamps. Production cascade test uses
  realistic stops.

## Phase 1a — status (unchanged from S472 + 2 polish closures)

- Onboarding: complete (S466–S471)
- Operations: complete (S468)
- Driver UX: complete (S472)
- Edit / Archive: complete (S471)
- Hygiene: S465 closed (S470), route cleanup closed (S473)
- Polish: last-serviced column (S473)

The trash-company-onboard arc is feature-complete by effort
plus polish. Outstanding small flag is the appointment-status
propagation gap (above).

## What the next session should target

**Strongly recommend: appointment-status propagation.** It's
the most load-bearing hygiene item in the Phase 1a code surface
and ages badly — every route run since Phase 1a.3 launched is
a row that should be `completed`/`no_show` but isn't. Small
backend fix, ~30 lines + tests. Pairs naturally with this
session's last-serviced work since both touch the same data
flow.

After that:
- **Phase 1a.1 walk** — every Phase 1a flag is closed
- **Product input** — Phase 1a.4 scope or trash-billing product
- **Mobile driver UI polish** — geolocation-aware "you're at the
  stop" cue (would need OSRM-level data work; defer)

---

End of S473 handoff. **Route cleanup cron + last-serviced
column shipped. Appointment-status propagation flagged for
next session as the remaining material backend hygiene.**

3030 tests / 160 files / 0 failures.

**Phase 1a is feature-complete + polished.** One backend
hygiene item remains; UI work is done.

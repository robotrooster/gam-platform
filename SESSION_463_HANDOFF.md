# Session 463 — closed

> SERVICE-BUSINESS / Phase 1a arc (continues S462).

## Theme

**Phase 1a.3 continuation — route persistence + lifecycle API.
Two new tables (generated_routes + route_stops), one new
service (routeGeneration: pulls appointments → calls optimizer
→ persists), seven endpoints across the route + per-stop
lifecycle, 23 cases. The trash company now has the END-TO-END
backend path: customer → appointment → generate route →
drivers see ordered stops → drivers mark each one
done/skipped.**

Suite at S462 close: 2959 / 155.
Suite at S463 close: **2982 / 156 / 0 failures**, 127.20s.

Zero tsc regressions.

## What shipped

### Migration

**`20260613150000_routes_persistence.sql`** — two tables.

**`generated_routes`**: id, business_id (CASCADE), vehicle_id,
depot_id, generated_for_date (date — not timestamp), start_at_
planned (the optimizer's startAt), generated_by_user_id (NULL
allowed for future cron generation), status (generated/
in_progress/completed), started_at, completed_at, total_miles,
total_minutes, stop_count, dump_count, **skipped_ungeocoded_
count** (surfaces in the API so dispatchers know they have
customer-geocoding work to do), notes, timestamps. Lifecycle
CHECKs (started/completed audit). Indexes: (business_id, date
DESC), (vehicle_id, date DESC), and a partial on non-completed
status.

**`route_stops`**: id, route_id (CASCADE), sequence_order
(0-indexed), stop_kind (customer/dump/depot_return), XOR
references (appointment_id OR dump_location_id depending on
kind), estimated_arrival, estimated_departure (NULL for
depot_return), actual_arrival, actual_departure, status
(planned/completed/skipped), driver_notes, timestamps.
**Three CHECK constraints** enforce the XOR — customer rows
require appointment_id and forbid dump_location_id, vice versa
for dump, both NULL for depot_return. UNIQUE (route_id,
sequence_order) so the optimized order can't be ambiguous.

### Shared enum exports

Added GENERATED_ROUTE_STATUSES, ROUTE_STOP_KINDS,
ROUTE_STOP_STATUSES + types. Single source of truth for the
CHECK constraints.

### Service — `services/routeGeneration.ts`

Single function: `generateRoute(args): GenerateRouteResult`.
Transactional.

1. Resolves vehicle + home_depot in one JOIN query; 404 if
   not in business or not active.
2. Pulls appointments for the date + business + status='scheduled'
   with customer JOIN for lat/lon.
3. Splits into geocoded (feeds optimizer) and ungeocoded (counted
   for the response, skipped from the route).
4. Pulls dump_locations for the business.
5. Calls `optimizeRoute` (S462 pure function).
6. Begins transaction → inserts generated_routes row → loops
   the optimizer's `RouteLeg[]` and INSERTs one route_stops row
   per leg with the right XOR fields → commits.

The function is the single load-bearing path between optimizer
output and the persisted plan. Tested both directly (via the
route slice's happy path) and through the API.

### `routes/routes.ts` — 7 endpoints

Same `requireBusinessId` helper pattern as the rest of the
business arc.

- **`POST /api/routes/generate`** — body: vehicleId, date,
  startAt (ISO). Calls generateRoute; returns the result
  envelope (routeId + counts + miles).
- **`GET /api/routes`** — list with ?date, ?vehicleId, ?status,
  ?limit. JOINs vehicles + depots for the list view's name
  columns.
- **`GET /api/routes/:id`** — full plan. Returns
  `{ route, stops }`. Stops JOIN business_customers +
  appointments + dump_locations so the driver UI gets every
  field in one round-trip (name, address, lat/lon, service
  type, dump name).
- **`POST /api/routes/:id/start`** — driver flips
  generated → in_progress + started_at. Idempotency via the
  status filter (double-start 404s).
- **`POST /api/routes/:id/complete`** — in_progress → completed.
- **`POST /api/routes/:id/stops/:stopId/complete`** — single
  stop. driverNotes optional. Stamps actual_arrival (if not
  already) + actual_departure + flips status to 'completed'.
  Cross-business 404 enforced via the JOIN to generated_routes
  + business_id.
- **`POST /api/routes/:id/stops/:stopId/skip`** — driver
  couldn't do the stop. **driverNotes REQUIRED** here (must
  have a reason).

### Tests — `routes/routes.test.ts` (NEW, 23 cases)

- **POST /generate (8)**: happy w/ correct counts + DB stop
  shape ['customer', 'depot_return'] + un-geocoded skip
  counter surfaces + cross-business vehicle 404 + archived
  vehicle 404 + only status=scheduled appts included
  (cancelled excluded) + zero appts still creates route +
  invalid date 400 + non-business role 403
- **GET / (3)**: scoped w/ vehicle + depot name JOINs +
  ?date filter + cross-business isolation
- **GET /:id (3)**: returns route + stops w/ customer +
  service detail + cross-business 404 + unknown id 404
- **Route lifecycle (4)**: start happy + start-twice 404 +
  complete happy + complete-on-non-started 404
- **Stop lifecycle (5)**: stop-complete w/ notes + actual_
  departure stamped + double-complete 404 + skip w/ required
  notes + skip missing notes 400 + cross-business 404

## Items shipped

```
apps/api/src/db/migrations/
  20260613150000_routes_persistence.sql       (NEW — 2 tables)
apps/api/src/services/
  routeGeneration.ts                          (NEW — ~150 lines)
apps/api/src/routes/
  routes.ts                                   (NEW — 7 endpoints, ~250 lines)
  routes.test.ts                              (NEW — 23 cases)
apps/api/src/test/
  dbHelpers.ts                                (+4 lines: 2-table cleanup
                                               BEFORE appointments)
apps/api/src/
  index.ts                                    (+2 lines: import + mount)
packages/shared/src/
  index.ts                                    (+ 3 new enums)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Allow regenerating a route for same vehicle+date? | **Yes — no UNIQUE.** Dispatcher might add a customer mid-day, weather hits, etc. Old route stays for audit; dispatcher decides which is canonical. Versioning concept is overkill for MVP. |
| Skip vs reject un-geocoded appointments | **Skip + count.** Rejecting the whole request because one customer wasn't geocoded would punish dispatchers for incomplete data they didn't choose. Skip + surface the count so they know to fix it. |
| Driver notes required on skip but optional on complete | **Yes.** A skip is a deviation from the plan — knowing WHY matters (gate locked, customer not home, hazardous conditions). A successful pickup is the happy path; notes are useful but not required. |
| Cross-business isolation on stop-level endpoints | **JOIN to generated_routes + business_id filter.** A stop's `business_id` lives on the parent route; the UPDATE FROM generated_routes WHERE pattern enforces it in one query. |
| Lifecycle order: stop-complete possible without route start? | **Yes — no transition gate at MVP.** A driver might finish a stop before the dispatcher marks the route "started" in the system. Forcing a synchronous start adds friction. Trust the driver; analyze the order later if it becomes an issue. |
| `actual_arrival` stamping on stop-complete | **COALESCE — only set if not already set.** Driver might tap "arrived" on the way + then "complete" when done; we want both timestamps. If only complete is tapped, both arrive + depart get NOW(). |
| `route_stops.driver_notes` overwrite on stop-complete | **COALESCE — don't clobber.** Driver might add notes via a separate edit (future) then tap complete; the complete shouldn't wipe their notes. New notes via complete merge in. |
| Show dump_location info on /:id read? | **Yes — full LEFT JOIN.** Driver UI shows dump stops too (address, name). Single query saves a roundtrip vs lazy-load. |

## Verification

- `npx tsc --noEmit` clean.
- `npm test`: **2982 / 156 / 0 failures**, 127.20s. Suite went
  2959 → 2982 (+23 = exactly the new test cases).
- Migration applied; schema.sql at 13,226 lines.

### Bugs caught during build

None. The S462 abstraction held — routeGeneration consumes
the optimizer's output without surprises.

## Phase 1a.3 — progress

- ✅ S462 — Optimizer + infrastructure tables
- ✅ **S463 — Persistence + generation API + lifecycle (this session)**
- ⏳ Next — Driver UI on `apps/business`: today's route view,
  tap-to-complete, tap-to-skip with reason
- ⏳ Later — Owner UI on `apps/business`: generate-route
  button + customer geocoder + vehicle/depot/dump CRUD
- ⏳ Eventually — vroom swap (one-file change in
  routeOptimizer.ts; needs dev-team install of vroom binary
  + OSRM data)

Phase 1a.3 is ~50% by effort. Backend is essentially done.
The UI work is the remaining bulk.

## Critical path read — where we are vs trash-company-onboards

✅ Customer roster
✅ Recurring schedules + materializer
✅ Appointments
✅ Route generation
✅ Stop-complete API

**What's still gating trash-company-onboard:**
- ⏳ Geocoder — customers don't have lat/lon, so route
  generation skips them
- ⏳ Driver UI — drivers need a phone-friendly screen to see
  their route + tap stops
- ⏳ Vehicle / depot / dump CRUD — currently DB-only

The geocoder is small (one external API call per customer
create, populates lat/lon; same in-house-everything constraint
applies, so probably a Nominatim self-host or a paid
geocoding API per the Stripe/Resend/Checkr-style exception
pattern — Nic-decision). The driver UI is medium-sized. The
vehicle/depot/dump CRUD is small (mirror of business_customers
CRUD).

## What the next session should target

**Recommend: vehicle / depot / dump_location CRUD APIs.**

Smallest meaningful slice. Three route files (~150 lines each),
~25 tests. Lets the dispatcher seed the data they need via
the API + sets up the API surface the portal will consume
when the UI lands.

After that: geocoder decision (Nic) → portal UI → vroom swap.

**Alternatives:**
- Geocoder integration first (gates real routes). Needs the
  Nic product call on in-house Nominatim vs paid SaaS first.
- Driver UI first (visible progress) — but the dispatcher
  can't seed real data without the depot/vehicle/dump CRUD.

---

End of S463 handoff. **Route persistence + lifecycle API
shipped — generate, list, read-with-stops, start, complete,
stop-complete, stop-skip. Generation service is the load-
bearing transactional path. 23 cases covering every gate +
isolation boundary + lifecycle order.**

2982 tests / 156 files / 0 failures.

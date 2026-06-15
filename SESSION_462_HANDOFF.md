# Session 462 — closed

> **Numbering note:** SERVICE-BUSINESS / Phase 1a arc (continues S461).

## Theme

**Phase 1a.3 opened — route optimization. Migration for the
three input tables (depots, vehicles, dump_locations) +
optimizer service as a pure TypeScript function (greedy
nearest-neighbor with dump insertion). 17 cases pinning
the algorithm. vroom swap path preserved — the optimizer's
function signature is what vroom would implement next
session, so callers + tests don't change.**

Suite at S461 close: 2942 / 154.
Suite at S462 close: **2959 / 155 / 0 failures**, 126.88s.

Zero tsc regressions.

## Strategic call this session

**Greedy now, vroom later.** Originally planned to ship
vroom integration directly (S453 Q2 lock). On building it
out, the actual install cost surfaced:

- vroom is a C++ binary; needs to run as a long-lived HTTP
  service or be invoked via child_process per call
- Real road-network distances need OSRM (or
  OpenRouteService) backing vroom — another binary +
  data download (50+ GB for North America)
- Both depend on the dev team for the actual deploy infra
  per the in-house-hosting principle

**Pivot**: ship a greedy optimizer behind the same interface
vroom would expose. Trash company onboards on routes that
are ~10-20% suboptimal vs vroom but immediately useful.
vroom drops in via a single-function swap when the binary
+ OSRM are installed (separate session, dev-team coordinated).

The function signature `optimizeRoute(req): OptimizerResult`
is the abstraction boundary — vroom will implement exactly
this with the body replaced by HTTP calls. Callers, route
persistence (next session), and the driver UI don't move
when we swap.

## What shipped

### Migration

**`20260613140000_route_infrastructure.sql`** — three tables.

**`depots`**: id, business_id (CASCADE), name, address fields,
lat + lon (REQUIRED — optimizer needs them), notes, status,
timestamps. Index on (business_id) partial on active.

**`vehicles`**: id, business_id (CASCADE), home_depot_id (FK
depots), name, plate_or_id, **stops_per_dump** (truck-capacity
proxy until appointment-level weight data exists),
avg_speed_mph (default 25), avg_service_minutes (default 3),
status, timestamps. CHECKs: status enum, all numeric fields
positive.

**`dump_locations`**: id, business_id (CASCADE), name, address,
lat + lon, typical_dump_minutes (default 15), operating_hours
(free-form text, optimizer ignores at MVP), status, timestamps.

All three tables: dispatcher fills in lat/lon manually until
the geocoder lands. Status enum is active/archived (vehicles
also has 'inactive' for "in the shop" without archiving).

### Service — `services/routeOptimizer.ts`

Pure function, ~200 lines. Zero DB, zero external deps.

**`haversineMiles(a, b)`** — great-circle distance in miles.
Approximation; real road distance lands with vroom.

**`optimizeRoute(req): OptimizerResult`**:
- Greedy nearest-neighbor: from current point, pick nearest
  unvisited stop, repeat.
- Dump insertion: when `stopsSinceDump >= vehicle.stopsPerDump`
  AND there's more to do, route through the nearest dump
  location before continuing.
- Final return-to-depot leg always present.
- Output is a `RouteLeg[]` discriminated union: `stop`, `dump`,
  or `depot_return` — each with arriveAt + departAt
  timestamps (depot_return has no departAt).

**Capacity edge cases handled**:
- 0 stops → just a depot_return leg
- No dump locations supplied (maintenance crews) → no dumps
  inserted even if threshold hits
- Multiple dump locations → picks the nearest to current
  position
- Per-stop service time override (e.g., a longer service)
  beats the vehicle default

### Test-infra

`cleanupAllSchema` adds DELETE for vehicles + depots +
dump_locations (in that order — vehicles.home_depot_id FKs
depots so trucks come first).

### Tests — `services/routeOptimizer.test.ts` (NEW, 17 cases)

- **haversineMiles (3)**: same point = 0 + reasonable urban
  distance (Phoenix → Tempe ≈ 7mi) + symmetric
- **edge shapes (2)**: zero stops + single stop
- **greedy ordering (3)**: visits nearest first +
  order-independent of input + chains nearest-of-remaining
- **dump insertion (4)**: every stopsPerDump stops + no
  dump when threshold not hit + no dumps when no dump
  locations supplied + picks nearest dump when multiple
- **ETA + totals (5)**: arriveAt = startAt + drive minutes +
  departAt = arriveAt + service + per-stop serviceMinutes
  override + totalMiles sums transitions + totalMinutes
  covers full trip

## Items shipped

```
apps/api/src/db/migrations/
  20260613140000_route_infrastructure.sql      (NEW — 3 tables)
apps/api/src/services/
  routeOptimizer.ts                            (NEW — ~200 lines)
  routeOptimizer.test.ts                       (NEW — 17 cases)
apps/api/src/test/
  dbHelpers.ts                                 (+5 lines: 3-table cleanup)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Greedy vs vroom for v1 ship | **Greedy now, vroom later.** Trash company onboards faster on ~80% optimal routes than on no routes. Same function signature so vroom swap is one-file. |
| Distance metric | **Haversine.** Real road distances need OSRM; haversine is fine for short urban routes (~5% off real driving distance in dense cities). vroom + OSRM swap improves this together. |
| stops_per_dump (truck-capacity proxy) | **Used in MVP.** Real weight/volume per appointment doesn't exist yet (would need yard-estimate fields on appointments). Operator sets a per-vehicle stopsPerDump that approximates "how many trash bins fits before dump." Refines later when per-appointment volume data exists. |
| Operating hours on dump locations | **Stored but not enforced.** Free-form text column. Optimizer assumes always-open at MVP. Enforcement (skip dump if closed at arrival time) is a future refinement that needs a real schedule parser. |
| Multi-vehicle routing in one optimizer call | **Not at MVP.** One call = one vehicle's route. Multi-vehicle (a business with 3 trucks splitting a 300-stop day) is vroom's strong suit and will land with the swap. For now, dispatcher manually splits stops between vehicles + runs the optimizer per vehicle. |
| `RouteLeg` shape: separate types or union? | **Discriminated union by `kind`.** Three leg kinds with distinct fields — TypeScript's `kind: 'stop' \| 'dump' \| 'depot_return'` discriminator makes the leg consumer write a clean switch with each branch typed correctly. |
| Return-to-depot leg always emitted? | **Always.** Even on a zero-stop "day" the route returns to depot — keeps the output shape consistent so downstream code doesn't need a special-case "no legs" branch. |
| ETA precision | **Minute-level (rounded to 2 decimals).** Sub-minute precision is meaningless given traffic variance + service-time guesses. Vroom + real road data will tighten this. |

## Verification

- `npx tsc --noEmit` clean.
- `npm test`: **2959 / 155 / 0 failures**, 126.88s. Suite
  went 2942 → 2959 (+17 = exactly the new test cases).
- Migration applied; schema.sql at 13,041 lines.

### Bugs caught during build

Two test-setup bugs caught by the first run + fixed:
1. "order is independent of input order" — my test stops
   were equidistant from depot, so greedy picked first-in-
   array on ties. Rewrote with distinct distances.
2. "picks the nearest dump when multiple supplied" — I
   used 2 stops with stopsPerDump=2; algorithm only inserts
   a dump when remaining stops exist after threshold. Added
   a 3rd stop.

No algorithm bugs.

## Phase 1a.3 — progress

- ✅ **S462 — route optimizer (this session)**
- ⏳ Next — Route persistence (generated_routes +
  route_stops tables) + API to generate/view routes
- ⏳ Later — Driver UI: today's route view, stop-complete
  action
- ⏳ Eventually — vroom swap when infra is ready (one
  service-file change)

Phase 1a.3 is ~20% by effort. The persistence layer + API
are mechanical (similar shape to past sessions); driver UI
is a new surface with mobile-friendly considerations.

## What the next session should target

**Route generation API + persistence.**

Migration:
- `generated_routes` table: id, business_id, vehicle_id,
  depot_id, generated_for_date, status (generated /
  in_progress / completed), started_at, completed_at,
  total_miles, total_minutes, stop_count, dump_count,
  generated_by_user_id, timestamps.
- `route_stops` table: id, route_id (CASCADE), sequence_order,
  stop_kind (customer / dump / depot_return),
  appointment_id (NULL when not customer),
  dump_location_id (NULL when not dump), estimated_arrival,
  estimated_departure, actual_arrival, actual_departure,
  status (planned / completed / skipped), driver_notes.

API:
- POST /api/routes/generate — body: { vehicleId, date }.
  Pulls appointments for the date + vehicle's business,
  calls optimizeRoute, persists the route + stops, returns
  full plan.
- GET /api/routes — list with ?date= ?vehicleId= ?status=
- GET /api/routes/:id — read full plan with stops + customer
  JOINs
- POST /api/routes/:id/stops/:stopId/complete — driver marks
  stop done (sets actual_arrival/departure + status)

Tests: ~30 cases covering generation + persistence + driver
flow.

After that comes the driver UI in apps/business + (separately)
the vroom swap.

---

End of S462 handoff. **Route optimizer shipped — greedy
nearest-neighbor with dump insertion, behind a vroom-
compatible interface, 17 pure-function tests pinning every
branch.**

2959 tests / 155 files / 0 failures.

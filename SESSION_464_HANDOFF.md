# Session 464 — closed

> SERVICE-BUSINESS / Phase 1a arc (continues S463).

## Theme

**Phase 1a.3 continuation — depots + vehicles + dump_locations
CRUD. Three small route files mirroring the businessCustomers
pattern, one combined test file (19 cases). All owner-only.
Closes the "operator-config" surface so dispatchers can stop
seeding routes via raw SQL.**

Suite at S463 close: 2982 / 156.
Suite at S464 close: **3001 / 157 / 0 failures**, 132.03s.

**Crossed the 3,000-test milestone.**

Zero tsc regressions.

## What shipped

### Three route files

All three share the same shape: owner-only `requireOwnerBusinessId`
helper + POST/GET/GET-by-id/PATCH/archive. Strict zod schemas;
COALESCE-preserves-omitted-fields pattern. ~150 lines each.

**`routes/depots.ts`** — name + full address + lat/lon (manually
entered until geocoder lands) + notes. Status: active/archived.

**`routes/vehicles.ts`** — name + home_depot_id (cross-business
check on every create/patch — the depot must belong to the same
business AND be active) + plate_or_id + stops_per_dump (default
50) + avg_speed_mph (default 25) + avg_service_minutes (default
3). Status: active / inactive / archived. Inactive is for "truck
in the shop" (still on roster, not assigned routes).

**`routes/dumpLocations.ts`** — name + full address + lat/lon +
typical_dump_minutes (default 15) + operating_hours (free-form
text, optimizer ignores at MVP). Status: active/archived.

### Mounts

```ts
app.use('/api/depots',         depotsRouter)
app.use('/api/vehicles',       vehiclesRouter)
app.use('/api/dump-locations', dumpLocationsRouter)
```

### Tests — `routes/routeInfraCrud.test.ts` (NEW, 19 cases)

Combined file across the three. Detailed validation branches
skipped — the businessCustomers tests already pin the pattern.

- **depots (6)**: POST happy + staff role 403 + ?status filter +
  PATCH COALESCE preserves + cross-business GET 404 + archive
  with double-archive 404
- **vehicles (7)**: POST happy with defaults + foreign-business
  depot 404 on POST + GET includes home_depot_name JOIN +
  PATCH same-business depot succeeds + PATCH foreign-business
  depot 404 + PATCH status → inactive + archive
- **dump_locations (6)**: POST happy with default dump time +
  custom dump time persists + cross-business empty list +
  PATCH operating_hours + archive + staff 403

## Items shipped

```
apps/api/src/routes/
  depots.ts                                    (NEW — ~140 lines)
  vehicles.ts                                  (NEW — ~170 lines)
  dumpLocations.ts                             (NEW — ~150 lines)
  routeInfraCrud.test.ts                       (NEW — 19 cases)
apps/api/src/
  index.ts                                     (+5 lines: 3 mounts + imports)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Owner-only or include staff? | **Owner-only.** Operator-config like business_customers — owner sets up infrastructure, staff use it. Per-staff-role gating (managers + dispatchers can edit) lands with the permission framework. |
| One combined test file vs three | **One combined.** Same shape across all three; detailed validation tested at the businessCustomers layer. Combined file is 19 cases instead of 30+ across three. Focused on each table's distinct concerns (vehicles: home_depot cross-business check; dump_locations: operating_hours; depots: standard CRUD). |
| Inactive vs archived for vehicles | **Both.** Inactive = temporary (truck in shop, comes back later). Archived = terminal (truck sold). Both excluded from `?status=active`. PATCH WHERE `status <> 'archived'` allows changing INTO inactive but not OUT of archived. |
| home_depot cross-business check on PATCH | **Yes, explicit query before UPDATE.** Otherwise an owner could move their truck's home_depot to a foreign business's depot, breaking the route generator. Same posture as customer cross-business check at create. |
| lat/lon required at create | **Yes.** Optimizer can't function without coords. Until the geocoder lands, dispatcher enters them manually (look up the address on Google Maps, copy coords). Friction is real but bounded — only setup-time. |
| typical_dump_minutes default | **15.** Industry-typical for transfer stations. Operator overrides per-site. |
| stops_per_dump default 50 | **From earlier Q3 lock at S453 planning.** Approximation until per-appointment volume data exists. |

## Verification

- `npx tsc --noEmit` clean.
- `npm test`: **3001 / 157 / 0 failures**, 132.03s. Suite went
  2982 → 3001 (+19 = exactly the new cases). Milestone: crossed
  3,000.
- All prior routes still pass — additive only.

### Bugs caught during build

None.

## Phase 1a.3 — progress

- ✅ S462 — Optimizer + infrastructure tables
- ✅ S463 — Persistence + generation API + lifecycle
- ✅ **S464 — Operator-config CRUD (this session)**
- ⏳ Next — geocoder (Nic-decision: in-house Nominatim vs
  paid SaaS infra exception) OR driver UI on apps/business
- ⏳ Eventually — vroom swap when binary + OSRM install
  coordinated with dev team

Phase 1a.3 is ~65% by effort. Backend is essentially done
end-to-end. Remaining: geocoder, UI surfaces, vroom swap.

## Critical path read

The trash company can now onboard via API:
1. Owner self-signs up at POST /api/businesses
2. POST /api/depots (yard)
3. POST /api/vehicles (truck pointing at the yard)
4. POST /api/dump-locations (transfer station)
5. POST /api/business-customers (each customer house) +
   provide lat/lon manually
6. POST /api/recurring-schedules (Mrs. Smith, every Tuesday at 9 AM)
7. Wait overnight → materializer creates appointment rows
8. POST /api/routes/generate (vehicle + tomorrow's date)
9. Driver receives the route via GET /api/routes/:id
10. Driver taps complete on each stop

Real onboarding still gated by:
- **Geocoder** — step 5's manual coordinate entry is friction;
  someone needs to decide in-house Nominatim vs paid SaaS
- **Driver UI** — step 9 + 10 currently API-only; drivers need
  a mobile screen
- **Owner UI** — steps 2-6 are all setup; a UI makes onboarding
  10× faster

## What the next session should target

**Two real options. Recommend asking Nic.**

**A. Geocoder integration.** Needs Nic product call on the
infra-exception list: do we add Nominatim self-host (true
in-house, ~50 GB OSM data download, ~1 GB RAM) or a paid
geocoding SaaS (Google / MapBox / Geoapify — quick to wire,
~$0.50-1.50 per 1000 lookups). Either way, ~1 session to
integrate once decided. Without this, real onboarding is
manual-coord-entry painful.

**B. Owner-side portal UI for operator-config.** Mirror the
existing apps/business pages but add tables for depots /
vehicles / dump_locations with create forms. ~1-2 sessions.
Doesn't unlock anything new but reduces onboarding friction
for owners.

**My pick: A.** Step 5 (customer create with coords) is the
single highest-friction onboarding moment. Removing it
unblocks real-world testing in a way the portal UI doesn't.

Either way, the **driver UI** comes after. That's the last
piece before the trash company can use GAM for actual daily
operations.

## Phase 1a.1 smoke walk

Still pending. The portal scaffold + auth wiring builds clean
but hasn't been browser-walked. With more API surface to
exercise now (routes, customers, schedules, infrastructure),
the eventual walk gets more meaningful.

---

End of S464 handoff. **Operator-config CRUD shipped — depots
+ vehicles + dump_locations across three route files + 19
cases.**

3001 tests / 157 files / 0 failures.

**Phase 1a.3 is ~65% done.** Trash company can now be onboarded
end-to-end via API. Geocoder + UI surfaces remain.

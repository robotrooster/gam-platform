# Session 474 — closed

> SERVICE-BUSINESS / Phase 1a arc (continues S473).

## Theme

**Appointment-status propagation. The S473-flagged backend
hygiene closed: route-stop complete now flips the linked
`appointments.status` to `completed` (with `completed_at`
stamped); route-stop skip flips to `no_show`. Both wrapped in
atomic CTEs so the route_stop and appointment moves are
guaranteed consistent. With this in place, the appointments
table is finally an accurate record of what actually happened
in the field, and downstream consumers (analytics, calendar
rendering, future integrations) can read it as truth.**

Suite (api) at S473 close: 3030 / 160.
Suite (api) at S474 close: **3034 / 160 / 0 failures** (+4
propagation cases).

apps/api tsc: clean.

## What shipped

### `apps/api/src/routes/routes.ts` — two endpoints rewritten as CTEs

**`POST /:id/stops/:stopId/complete`:**

```sql
WITH stop_update AS (
  UPDATE route_stops rs
     SET status         = 'completed',
         actual_arrival = COALESCE(rs.actual_arrival, NOW()),
         actual_departure = NOW(),
         driver_notes   = COALESCE($1, rs.driver_notes)
    FROM generated_routes r
   WHERE rs.id = $2 AND rs.route_id = $3
     AND rs.route_id = r.id AND r.business_id = $4
     AND rs.status = 'planned'
  RETURNING rs.id, rs.status, rs.appointment_id
),
appt_update AS (
  UPDATE appointments a
     SET status       = 'completed',
         completed_at = COALESCE(a.completed_at, NOW()),
         updated_at   = NOW()
    FROM stop_update s
   WHERE a.id = s.appointment_id
     AND s.appointment_id IS NOT NULL
  RETURNING a.id
)
SELECT id, status FROM stop_update
```

**`POST /:id/stops/:stopId/skip`:** same shape, sets
`appointments.status='no_show'`. `no_show` has no
audit-timestamp CHECK so the flip is one-column +
`updated_at`. The driver_notes on the route_stop carries the
reason; we keep it there rather than copying into appointment
notes (single source of truth, the route execution layer).

**Why CTE not separate transactions:**
- Atomic: stop + appointment commit together or neither does.
- No risk of orphaned states from a connection drop between
  two separate UPDATE statements.
- Dump + depot_return stops have `appointment_id IS NULL`; the
  appt-update WHERE silently short-circuits — no error, no
  no-op log noise.

**Why `COALESCE(completed_at, NOW())`:**
- Defends against a hypothetical re-emit path that would
  re-stamp the field. Today the planned-status filter prevents
  double-complete (returns 404), so this is belt-and-suspenders
  against future code paths that might bypass that filter.

### `apps/api/src/routes/routes.test.ts` — 4 new propagation cases

```
S474: stop-complete propagates → appointments.status=completed + completed_at
S474: stop-skip propagates → appointments.status=no_show
S474: dump stop (appointment_id NULL) complete does not error
S474: completed_at preserved across hypothetical re-emit (COALESCE)
```

The dump-stop case exercises a realistic plan structure by
forcing `vehicles.stops_per_dump=1` so the optimizer inserts a
dump between customer stops, then completing that dump stop
(NULL appointment_id) exercises the WHERE short-circuit in
the CTE.

The COALESCE case pre-stamps `completed_at` to a known
historical timestamp, then calls complete via the API and
asserts the original timestamp survives.

## Items shipped

```
apps/api/src/routes/
  routes.ts                                    (stop-complete + stop-skip → CTE with appt propagation)
  routes.test.ts                               (+4 S474 propagation cases)
```

## Decisions made during build

| Question | Decision |
|---|---|
| skip → 'no_show' or 'cancelled' | **'no_show'.** The driver tried; the appointment didn't happen. 'cancelled' implies a proactive cancellation (customer called and asked, or dispatcher pulled it). 'no_show' is closer to "we showed up and couldn't service." |
| Two UPDATE statements vs one CTE | **CTE.** Atomic guarantee + no orphan risk + reads cleanly. Marginal SQL complexity vs the alternative two-statement transactional UPDATE. |
| Backfill historical appointments | **No.** The propagation gap dates from S463 (Phase 1a.3 launch). Pre-launch volume is zero, so there's nothing to backfill. If volume had accumulated, the migration would walk `route_stops.status='completed'` rows and flip the linked appointments — straightforward but unneeded today. |
| Stamp `cancelled_at` on no_show? | **No.** The appointments schema CHECK doesn't require it; the appointments.cancelled_at column is semantically for proactive cancellations. driver_notes on the route_stop carries the "why" for no_show. |
| COALESCE on completed_at | **Yes.** Future code paths might re-emit; we want the first stamp to be the source of truth, not the last one. Costs ~10 chars; defends against an entire class of "why is this timestamp wrong?" bugs. |
| Update appointments.updated_at | **Yes.** The audit-style trigger on appointments expects updated_at on every mutation. Even though no DB trigger automatically refreshes it (the migrations table doesn't add one I can see), the column convention is "stamp it." |
| What if appointment was already 'cancelled' (proactive) before stop-complete fired? | **App-layer decision: route-stop complete overrides to 'completed'.** The driver's tap is the field reality; if a dispatcher cancelled the appointment in the DB while the driver was en route, the field action wins. This matches the existing UPDATE semantic (no WHERE clause excluding cancelled). |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- Targeted: `vitest run src/routes/routes.test.ts` — 27 passed
  (23 prior + 4 S474).
- Full: `npm test` — **3034 / 160 / 0 failures** (+4 from S473).

### Bugs caught during build

- **toISOString format mismatch in the COALESCE test**: PG
  returns `2026-01-01T12:00:00.000Z` while my literal string was
  `2026-01-01T12:00:00Z`. Fixed by comparing `.getTime()`
  numerically rather than string-comparing ISOs.

## Phase 1a — final status

Every Phase 1a flag is closed:

| Surface | State |
|---|---|
| Onboarding flow | ✅ S466–S471 |
| Operations (routes generate / detail) | ✅ S468 |
| Mobile driver UX | ✅ S472 |
| Edit / Archive CRUD ring | ✅ S471 |
| S465 hygiene (PATCH lat/lon + defensive geocode) | ✅ S470 |
| Materializer cron registered | ✅ S469 |
| Route cleanup cron registered | ✅ S473 |
| Last-serviced rollup column | ✅ S473 |
| Appointment-status propagation | ✅ **S474** |

The trash-company-onboard product is complete + polished.
Pre-launch state is "walk-ready"; backend has no open hygiene
flags; UI surfaces have full CRUD + lifecycle + edit/archive.

## What the next session should target

**Phase 1a is closed.** Open candidates outside the arc:

- **Phase 1a.1 smoke walk** — Nic-initiated only per CLAUDE.md.
  The portal is feature-complete; whenever Nic decides to walk,
  it'll go end-to-end (signup → depots → vehicles → dumps →
  customers → schedules → routes → driver UI → complete) without
  any API-only steps.
- **Phase 1a.4 planning** — scope for the next sub-phase. Multi-
  driver routing? Customer self-service? Recurring billing?
  Needs Nic product input.
- **Trash-billing product** — substantial new arc. Tenant-side
  product surface (Customer Account Holders, FlexCharge per
  S304/S472 framing). Would warrant a planning conversation.
- **Other GAM arcs** — credit ledger v1 polish, PM company
  surfaces, FlexSuite tenant-facing pages, etc. — any of the
  in-flight non-Phase-1a threads.

Without a specific direction, the natural close is "Phase 1a
shippable, awaiting product direction."

---

End of S474 handoff. **Appointment-status propagation wired
via atomic CTEs. Every Phase 1a backend hygiene flag is now
closed.**

3034 tests / 160 files / 0 failures.

**Phase 1a is shippable end-to-end.** Next direction: smoke
walk (Nic-initiated) or new arc (product input).

/**
 * S462 / Phase 1a.3 — route optimizer.
 *
 * Pure function. Inputs: depot + vehicle + dump_locations + stops
 * (each with lat/lon). Output: ordered route plan with stops + dump
 * insertions + return-to-depot.
 *
 * Algorithm at MVP: greedy nearest-neighbor with periodic dump
 * insertion when stops_per_dump is reached. Suboptimal vs vroom by
 * ~10-20% on total drive time, but:
 *   - Runs in pure TypeScript with zero external deps
 *   - Deterministic + testable
 *   - Same interface vroom would implement
 *
 * vroom swap path: replace `optimizeRoute` body with an HTTP call to
 * a vroom server while preserving the function signature. Callers
 * + tests don't change.
 *
 * Distance metric: Haversine (great-circle). Acceptable approximation
 * for short urban routes; real road distance via OSRM ships with
 * vroom in the swap session.
 */

export interface GeoPoint {
  lat: number
  lon: number
}

export interface OptimizerStop extends GeoPoint {
  /** Stable identifier — typically an appointment id. Returned in the
   *  output so callers can match back to their domain rows. */
  id: string
  /** Service time at this stop (minutes). Overrides the vehicle's
   *  default if set. */
  serviceMinutes?: number
}

export interface OptimizerDumpLocation extends GeoPoint {
  id: string
  dumpMinutes: number
}

export interface OptimizerVehicle {
  /** How many customer stops the truck can hold before needing a dump. */
  stopsPerDump: number
  avgSpeedMph: number
  /** Default service time per stop (minutes) if a stop doesn't override. */
  avgServiceMinutes: number
}

export interface OptimizerRequest {
  depot:         GeoPoint
  vehicle:       OptimizerVehicle
  dumpLocations: OptimizerDumpLocation[]
  stops:         OptimizerStop[]
  /** Start time of the route, ISO. ETAs in the output are computed
   *  forward from this. */
  startAt:       Date
  /** Where the truck physically starts this (re-)optimization. Defaults
   *  to the depot for a fresh route. For a LIVE INSERT mid-route it's
   *  the last finalized stop's location, so the remaining plan is
   *  optimized from where the driver actually is. The depot is still
   *  the return target regardless. */
  startFrom?:    GeoPoint
}

export type RouteLeg =
  | { kind: 'stop';  stopId: string;       arriveAt: Date; departAt: Date }
  | { kind: 'dump';  dumpLocationId: string; arriveAt: Date; departAt: Date }
  | { kind: 'depot_return';                arriveAt: Date }

export interface OptimizerResult {
  legs: RouteLeg[]
  /** Total drive miles (Haversine sum across all transitions). */
  totalMiles: number
  /** Total elapsed minutes from startAt to depot return. */
  totalMinutes: number
  /** Number of customer stops on the route. */
  stopCount: number
  /** Number of dump trips inserted. */
  dumpCount: number
}

// ── distance + ETA primitives ────────────────────────────────

const EARTH_MI = 3958.7613

/** Haversine distance in miles between two points. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_MI * Math.asin(Math.sqrt(h))
}

function travelMinutes(miles: number, mph: number): number {
  return (miles / mph) * 60
}

function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000)
}

// ── core optimizer ───────────────────────────────────────────

/** Pick the nearest dump location to a reference point. Returns null
 *  if no dump locations are supplied (e.g., maintenance crews don't
 *  use dumps). */
function nearestDump(from: GeoPoint, dumps: OptimizerDumpLocation[]): OptimizerDumpLocation | null {
  if (dumps.length === 0) return null
  let best = dumps[0]
  let bestD = haversineMiles(from, best)
  for (let i = 1; i < dumps.length; i++) {
    const d = haversineMiles(from, dumps[i])
    if (d < bestD) { best = dumps[i]; bestD = d }
  }
  return best
}

/** Pick the nearest unvisited stop to a reference point. */
function nearestStop(from: GeoPoint, remaining: OptimizerStop[]): { stop: OptimizerStop; idx: number; miles: number } {
  let bestIdx = 0
  let bestD = haversineMiles(from, remaining[0])
  for (let i = 1; i < remaining.length; i++) {
    const d = haversineMiles(from, remaining[i])
    if (d < bestD) { bestIdx = i; bestD = d }
  }
  return { stop: remaining[bestIdx], idx: bestIdx, miles: bestD }
}

/**
 * Run the greedy optimizer. Pure function — no DB, no clock dep
 * beyond the supplied startAt.
 */
export function optimizeRoute(req: OptimizerRequest): OptimizerResult {
  const legs: RouteLeg[] = []
  let totalMiles = 0
  let dumpCount = 0
  let stopCount = 0

  // Working state
  const remaining = [...req.stops]
  let current: GeoPoint = req.startFrom ?? req.depot
  let currentTime = new Date(req.startAt)
  let stopsSinceDump = 0

  while (remaining.length > 0) {
    // Pick nearest unvisited
    const { stop, idx, miles } = nearestStop(current, remaining)
    remaining.splice(idx, 1)

    // Travel + arrive
    const driveMin = travelMinutes(miles, req.vehicle.avgSpeedMph)
    const arrive = addMinutes(currentTime, driveMin)
    const service = stop.serviceMinutes ?? req.vehicle.avgServiceMinutes
    const depart = addMinutes(arrive, service)
    legs.push({ kind: 'stop', stopId: stop.id, arriveAt: arrive, departAt: depart })
    totalMiles += miles
    currentTime = depart
    current = stop
    stopCount += 1
    stopsSinceDump += 1

    // Dump-insertion: when we hit the threshold AND there's more to
    // do, route through the nearest dump location. (No need to dump
    // if we're about to head home anyway — the depot return handles
    // that case at the end.)
    if (stopsSinceDump >= req.vehicle.stopsPerDump && remaining.length > 0) {
      const dump = nearestDump(current, req.dumpLocations)
      if (dump) {
        const toDumpMi = haversineMiles(current, dump)
        const toDumpMin = travelMinutes(toDumpMi, req.vehicle.avgSpeedMph)
        const arriveDump = addMinutes(currentTime, toDumpMin)
        const departDump = addMinutes(arriveDump, dump.dumpMinutes)
        legs.push({
          kind: 'dump',
          dumpLocationId: dump.id,
          arriveAt: arriveDump,
          departAt: departDump,
        })
        totalMiles += toDumpMi
        currentTime = departDump
        current = dump
        dumpCount += 1
        stopsSinceDump = 0
      }
      // If no dump locations supplied, just continue — operators
      // without dumps (maintenance, mobile rentals) don't need them.
    }
  }

  // Return to depot
  const finalMi = haversineMiles(current, req.depot)
  const finalMin = travelMinutes(finalMi, req.vehicle.avgSpeedMph)
  const arriveDepot = addMinutes(currentTime, finalMin)
  legs.push({ kind: 'depot_return', arriveAt: arriveDepot })
  totalMiles += finalMi

  const totalMinutes = (arriveDepot.getTime() - req.startAt.getTime()) / 60_000

  return {
    legs,
    totalMiles: Math.round(totalMiles * 100) / 100,
    totalMinutes: Math.round(totalMinutes * 100) / 100,
    stopCount,
    dumpCount,
  }
}

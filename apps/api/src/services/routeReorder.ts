/**
 * Pre-start manual reorder (service-business / route ops, S510, #16).
 *
 * Lets the dispatcher hand-arrange a route's stops BEFORE it starts —
 * e.g. "work back toward the transfer station" so the truck ends near
 * the dump. Allowed only while the route is still `generated` (nothing
 * finalized, no live timeline to disturb).
 *
 * The chosen order is honored exactly (no re-optimization) — we just
 * re-TIME it: walk the new sequence from the depot at the planned
 * start, recomputing each stop's estimated arrival/departure from
 * Haversine drive time + service/dump time, then the depot return.
 * Route totals (miles/minutes) are refreshed; the stop set is
 * unchanged so counts stay put.
 */

import { queryOne, query, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { haversineMiles, GeoPoint } from './routeOptimizer'

export interface ReorderArgs {
  routeId:        string
  businessId:     string
  /** Customer + dump stop ids in the desired order. depot_return is
   *  excluded — it's always re-pinned last. Must be a permutation of
   *  the route's current non-return stops. */
  orderedStopIds: string[]
}

export interface ReorderResult {
  routeId:      string
  totalMiles:   number
  totalMinutes: number
}

interface StopRow {
  id: string
  stop_kind: 'customer' | 'dump' | 'depot_return'
  status: string
  cust_lat: string | null
  cust_lon: string | null
  expected_seconds: number | null
  dump_lat: string | null
  dump_lon: string | null
  dump_minutes: number | null
}

export async function reorderRouteStops(args: ReorderArgs): Promise<ReorderResult> {
  const route = await queryOne<{
    id: string; status: string; start_at_planned: Date
    avg_speed_mph: number; avg_service_minutes: number
    depot_lat: string; depot_lon: string
  }>(
    `SELECT r.id, r.status, r.start_at_planned,
            v.avg_speed_mph, v.avg_service_minutes,
            d.lat::text AS depot_lat, d.lon::text AS depot_lon
       FROM generated_routes r
       JOIN vehicles v ON v.id = r.vehicle_id
       JOIN depots   d ON d.id = r.depot_id
      WHERE r.id = $1 AND r.business_id = $2`,
    [args.routeId, args.businessId])
  if (!route) throw new AppError(404, 'Route not found')
  if (route.status !== 'generated') {
    throw new AppError(409, 'Stops can only be reordered before the route starts')
  }

  const stops = await query<StopRow>(
    `SELECT rs.id, rs.stop_kind, rs.status,
            c.lat::text AS cust_lat, c.lon::text AS cust_lon, rs.expected_seconds,
            dl.lat::text AS dump_lat, dl.lon::text AS dump_lon, dl.typical_dump_minutes AS dump_minutes
       FROM route_stops rs
       LEFT JOIN appointments a       ON a.id  = rs.appointment_id
       LEFT JOIN business_customers c ON c.id  = a.customer_id
       LEFT JOIN dump_locations dl    ON dl.id = rs.dump_location_id
      WHERE rs.route_id = $1`,
    [args.routeId])

  const byId = new Map(stops.map(s => [s.id, s]))
  const depotReturn = stops.find(s => s.stop_kind === 'depot_return')
  const reorderable = stops.filter(s => s.stop_kind !== 'depot_return')

  // The provided ids must be exactly the route's non-return stops.
  const provided = new Set(args.orderedStopIds)
  if (provided.size !== args.orderedStopIds.length) throw new AppError(400, 'Duplicate stop ids in order')
  if (provided.size !== reorderable.length || !reorderable.every(s => provided.has(s.id))) {
    throw new AppError(400, 'Order must list exactly the route’s current stops')
  }

  const depot: GeoPoint = { lat: Number(route.depot_lat), lon: Number(route.depot_lon) }
  const locOf = (s: StopRow): GeoPoint | null =>
    s.stop_kind === 'customer' && s.cust_lat && s.cust_lon ? { lat: Number(s.cust_lat), lon: Number(s.cust_lon) }
    : s.stop_kind === 'dump' && s.dump_lat && s.dump_lon ? { lat: Number(s.dump_lat), lon: Number(s.dump_lon) }
    : null
  const driveMin = (mi: number) => (mi / route.avg_speed_mph) * 60
  const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000)

  // Re-time along the chosen order.
  const start = new Date(route.start_at_planned)
  let current = depot
  let time = start
  let totalMiles = 0
  const timed: { id: string; arrive: Date; depart: Date }[] = []
  for (const id of args.orderedStopIds) {
    const s = byId.get(id)!
    const loc = locOf(s)
    if (!loc) throw new AppError(409, 'A stop is missing coordinates — geocode it first')
    const mi = haversineMiles(current, loc)
    const arrive = addMin(time, driveMin(mi))
    const svc = s.stop_kind === 'customer'
      ? (s.expected_seconds != null ? s.expected_seconds / 60 : route.avg_service_minutes)
      : (s.dump_minutes ?? 0)
    const depart = addMin(arrive, svc)
    timed.push({ id, arrive, depart })
    totalMiles += mi
    current = loc
    time = depart
  }
  const returnMi = haversineMiles(current, depot)
  const arriveDepot = addMin(time, driveMin(returnMi))
  totalMiles += returnMi
  const totalMinutes = Math.round(((arriveDepot.getTime() - start.getTime()) / 60_000) * 100) / 100
  const totalMilesR = Math.round(totalMiles * 100) / 100

  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Clear the sequence range first to dodge the UNIQUE(route_id, sequence_order).
    await client.query(`UPDATE route_stops SET sequence_order = sequence_order + 100000 WHERE route_id = $1`, [args.routeId])

    let seq = 0
    for (const t of timed) {
      await client.query(
        `UPDATE route_stops SET sequence_order = $2, estimated_arrival = $3, estimated_departure = $4, updated_at = NOW()
          WHERE id = $1`,
        [t.id, seq, t.arrive.toISOString(), t.depart.toISOString()])
      seq += 1
    }
    if (depotReturn) {
      await client.query(
        `UPDATE route_stops SET sequence_order = $2, estimated_arrival = $3, estimated_departure = NULL, updated_at = NOW()
          WHERE id = $1`,
        [depotReturn.id, seq, arriveDepot.toISOString()])
    }
    await client.query(
      `UPDATE generated_routes SET total_miles = $2, total_minutes = $3, updated_at = NOW() WHERE id = $1`,
      [args.routeId, totalMilesR, totalMinutes])
    await client.query('COMMIT')
    return { routeId: args.routeId, totalMiles: totalMilesR, totalMinutes }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

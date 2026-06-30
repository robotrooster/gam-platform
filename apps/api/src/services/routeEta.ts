/**
 * Live downstream ETA (service-business, S510).
 *
 * On each driver GPS ping we record the route's last position and
 * project an ETA for every not-yet-finalized stop: walk from the
 * driver's current location through the remaining stops in order,
 * accumulating Haversine drive time + per-stop service/dwell. Each
 * stop's `projected_eta` is what the customer portal shows
 * ("arriving ~2:45"). Cheap, recomputed every ping; no road-network
 * call (Haversine approximation, same basis as the optimizer).
 */

import { queryOne, query, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { haversineMiles, GeoPoint } from './routeOptimizer'

export interface RoutePositionArgs {
  routeId:    string
  businessId: string
  lat:        number
  lon:        number
}

export interface RoutePositionResult {
  updatedStops: number
}

interface PlannedStopRow {
  id: string
  stop_kind: 'customer' | 'dump' | 'depot_return'
  expected_seconds: number | null
  dump_minutes: number | null
  cust_lat: string | null
  cust_lon: string | null
  dump_lat: string | null
  dump_lon: string | null
  depot_lat: string
  depot_lon: string
}

export async function updateRoutePositionAndEta(
  args: RoutePositionArgs,
  now: Date = new Date(),
): Promise<RoutePositionResult> {
  const route = await queryOne<{ id: string; avg_speed_mph: number; dwell_seconds: number }>(
    `SELECT r.id, v.avg_speed_mph, COALESCE(b.stop_dwell_seconds, 60) AS dwell_seconds
       FROM generated_routes r
       JOIN vehicles v   ON v.id = r.vehicle_id
       JOIN businesses b ON b.id = r.business_id
      WHERE r.id = $1 AND r.business_id = $2
        AND r.status IN ('generated', 'in_progress')`,
    [args.routeId, args.businessId])
  if (!route) throw new AppError(404, 'Route not found or not active')

  await query(
    `UPDATE generated_routes SET last_lat = $2, last_lon = $3, last_position_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [args.routeId, args.lat, args.lon])

  const stops = await query<PlannedStopRow>(
    `SELECT rs.id, rs.stop_kind, rs.expected_seconds, dl.typical_dump_minutes AS dump_minutes,
            c.lat::text AS cust_lat, c.lon::text AS cust_lon,
            dl.lat::text AS dump_lat, dl.lon::text AS dump_lon,
            d.lat::text AS depot_lat, d.lon::text AS depot_lon
       FROM route_stops rs
       JOIN generated_routes r        ON r.id  = rs.route_id
       JOIN depots d                  ON d.id  = r.depot_id
       LEFT JOIN appointments a       ON a.id  = rs.appointment_id
       LEFT JOIN business_customers c ON c.id  = a.customer_id
       LEFT JOIN dump_locations dl    ON dl.id = rs.dump_location_id
      WHERE rs.route_id = $1 AND rs.status = 'planned'
      ORDER BY rs.sequence_order ASC`,
    [args.routeId])

  const driveMin = (mi: number) => (mi / route.avg_speed_mph) * 60
  const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000)

  let current: GeoPoint = { lat: args.lat, lon: args.lon }
  let t = now
  let updated = 0
  const client = await getClient()
  try {
    await client.query('BEGIN')
    for (const s of stops) {
      const loc: GeoPoint | null =
        s.stop_kind === 'customer' && s.cust_lat && s.cust_lon ? { lat: Number(s.cust_lat), lon: Number(s.cust_lon) }
        : s.stop_kind === 'dump' && s.dump_lat && s.dump_lon ? { lat: Number(s.dump_lat), lon: Number(s.dump_lon) }
        : s.stop_kind === 'depot_return' ? { lat: Number(s.depot_lat), lon: Number(s.depot_lon) }
        : null
      if (!loc) continue  // ungeocoded — leave its ETA null
      const arrive = addMin(t, driveMin(haversineMiles(current, loc)))
      await client.query(`UPDATE route_stops SET projected_eta = $2 WHERE id = $1`, [s.id, arrive.toISOString()])
      updated++
      const serviceMin = s.stop_kind === 'customer'
        ? (s.expected_seconds != null ? s.expected_seconds / 60 : route.dwell_seconds / 60)
        : s.stop_kind === 'dump' ? (s.dump_minutes ?? 0)
        : 0
      current = loc
      t = addMin(arrive, serviceMin)
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  return { updatedStops: updated }
}

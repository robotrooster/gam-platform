/**
 * Live stop insert (service-business / route ops, S510).
 *
 * Adds a scheduled appointment to an already-generated or in_progress
 * route. Finalized stops (completed/skipped) are LOCKED history and
 * never touched; the remaining planned portion — plus the new stop — is
 * re-optimized from the truck's current anchor (the last finalized
 * stop, or the depot if none finalized yet) and rewritten.
 *
 * The route auto-advance timer (jobs/routeAutoAdvance.ts) then drives
 * the new plan: it anchors each leg off the previous stop's finalize
 * time + the planned drive leg the optimizer just computed.
 *
 * Counts (stop_count/dump_count) are recomputed exactly. total_miles =
 * the already-driven finalized legs (Haversine) + the re-optimized
 * remainder; total_minutes = projected depot-return minus the planned
 * start. The dump cadence resets across the re-optimized segment
 * (acceptable MVP approximation — the threshold is per-segment).
 */

import { queryOne, query, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import {
  optimizeRoute, haversineMiles,
  OptimizerStop, OptimizerDumpLocation, GeoPoint,
} from './routeOptimizer'

export interface InsertStopArgs {
  routeId:       string
  businessId:    string
  appointmentId: string
}

export interface InsertStopResult {
  routeId:      string
  stopCount:    number
  dumpCount:    number
  totalMiles:   number
  totalMinutes: number
}

interface StopRow {
  id: string
  sequence_order: number
  stop_kind: 'customer' | 'dump' | 'depot_return'
  appointment_id: string | null
  status: 'planned' | 'completed' | 'skipped'
  actual_departure: Date | null
  estimated_departure: Date | null
  estimated_arrival: Date | null
  cust_lat: string | null
  cust_lon: string | null
  expected_seconds: number | null
  dump_lat: string | null
  dump_lon: string | null
}

export async function insertStopIntoRoute(args: InsertStopArgs): Promise<InsertStopResult> {
  // 1) Route + vehicle params + depot coords; must be live (not completed).
  const route = await queryOne<{
    id: string; status: string; depot_id: string
    start_at_planned: Date; started_at: Date | null
    stops_per_dump: number; avg_speed_mph: number; avg_service_minutes: number
    service_seconds_per_unit: number
    depot_lat: string; depot_lon: string
  }>(
    `SELECT r.id, r.status, r.depot_id, r.start_at_planned, r.started_at,
            v.stops_per_dump, v.avg_speed_mph, v.avg_service_minutes,
            b.service_seconds_per_unit,
            d.lat::text AS depot_lat, d.lon::text AS depot_lon
       FROM generated_routes r
       JOIN vehicles v   ON v.id = r.vehicle_id
       JOIN depots   d   ON d.id = r.depot_id
       JOIN businesses b ON b.id = r.business_id
      WHERE r.id = $1 AND r.business_id = $2`,
    [args.routeId, args.businessId])
  if (!route) throw new AppError(404, 'Route not found')
  if (route.status === 'completed') throw new AppError(409, 'Route is already completed')

  // 2) The appointment to insert: business-scoped, scheduled, geocoded.
  const appt = await queryOne<{ id: string; lat: string | null; lon: string | null; unit_count: number }>(
    `SELECT a.id, c.lat::text AS lat, c.lon::text AS lon, c.unit_count
       FROM appointments a
       JOIN business_customers c ON c.id = a.customer_id
      WHERE a.id = $1 AND a.business_id = $2 AND a.status = 'scheduled'`,
    [args.appointmentId, args.businessId])
  if (!appt) throw new AppError(404, 'Appointment not found or not schedulable')
  if (appt.lat === null || appt.lon === null) {
    throw new AppError(409, 'Customer has no map coordinates — geocode them first')
  }

  // 3) Existing stops, with coords for anchoring + re-optimizing.
  const stops = await query<StopRow>(
    `SELECT rs.id, rs.sequence_order, rs.stop_kind, rs.appointment_id, rs.status,
            rs.actual_departure, rs.estimated_departure, rs.estimated_arrival,
            c.lat::text AS cust_lat, c.lon::text AS cust_lon, rs.expected_seconds,
            dl.lat::text AS dump_lat, dl.lon::text AS dump_lon
       FROM route_stops rs
       LEFT JOIN appointments a       ON a.id  = rs.appointment_id
       LEFT JOIN business_customers c ON c.id  = a.customer_id
       LEFT JOIN dump_locations dl    ON dl.id = rs.dump_location_id
      WHERE rs.route_id = $1
      ORDER BY rs.sequence_order ASC`,
    [args.routeId])

  if (stops.some(s => s.appointment_id === args.appointmentId && s.status !== 'skipped')) {
    throw new AppError(409, 'That appointment is already on this route')
  }

  const finalized = stops.filter(s => s.status === 'completed' || s.status === 'skipped')
  const plannedCustomers = stops.filter(s => s.status === 'planned' && s.stop_kind === 'customer')

  const depot: GeoPoint = { lat: Number(route.depot_lat), lon: Number(route.depot_lon) }

  // 4) Anchor: where/when the re-optimized remainder begins.
  const stopLoc = (s: StopRow): GeoPoint =>
    s.stop_kind === 'customer' && s.cust_lat && s.cust_lon ? { lat: Number(s.cust_lat), lon: Number(s.cust_lon) }
    : s.stop_kind === 'dump' && s.dump_lat && s.dump_lon ? { lat: Number(s.dump_lat), lon: Number(s.dump_lon) }
    : depot

  const lastFinal = finalized.length > 0 ? finalized[finalized.length - 1] : null
  const startFrom = lastFinal ? stopLoc(lastFinal) : depot
  const anchorTime = lastFinal
    ? new Date(lastFinal.actual_departure ?? lastFinal.estimated_departure ?? lastFinal.estimated_arrival ?? route.started_at ?? route.start_at_planned)
    : new Date(route.started_at ?? route.start_at_planned)
  const maxFinalizedSeq = finalized.reduce((m, s) => Math.max(m, s.sequence_order), -1)

  // Already-driven distance: depot → each finalized stop in order.
  let finalizedMiles = 0
  let prev = depot
  for (const s of finalized) {
    const loc = stopLoc(s)
    finalizedMiles += haversineMiles(prev, loc)
    prev = loc
  }

  // 5) Re-optimize remaining planned customers + the new appointment.
  //    Service time = each stop's expected_seconds (rate × units); the new
  //    appointment's is computed from the owner rate × its customer's units.
  const rate = route.service_seconds_per_unit
  const expectedById = new Map<string, number>()
  const optimizerStops: OptimizerStop[] = plannedCustomers
    .filter(s => s.cust_lat && s.cust_lon)
    .map(s => {
      const exp = s.expected_seconds ?? rate
      expectedById.set(s.appointment_id!, exp)
      return { id: s.appointment_id!, lat: Number(s.cust_lat), lon: Number(s.cust_lon), serviceMinutes: exp / 60 }
    })
  const newExpected = rate * (appt.unit_count ?? 1)
  expectedById.set(appt.id, newExpected)
  optimizerStops.push({
    id: appt.id, lat: Number(appt.lat), lon: Number(appt.lon),
    serviceMinutes: newExpected / 60,
  })

  const dumpRows = await query<{ id: string; lat: string; lon: string; typical_dump_minutes: number }>(
    `SELECT id, lat::text AS lat, lon::text AS lon, typical_dump_minutes
       FROM dump_locations WHERE business_id = $1 AND status = 'active'`,
    [args.businessId])
  const dumps: OptimizerDumpLocation[] = dumpRows.map(d => ({
    id: d.id, lat: Number(d.lat), lon: Number(d.lon), dumpMinutes: d.typical_dump_minutes,
  }))

  const result = optimizeRoute({
    depot, startFrom,
    vehicle: {
      stopsPerDump: route.stops_per_dump,
      avgSpeedMph: route.avg_speed_mph,
      avgServiceMinutes: route.avg_service_minutes,
    },
    dumpLocations: dumps,
    stops: optimizerStops,
    startAt: anchorTime,
  })

  const depotReturn = result.legs[result.legs.length - 1]
  const totalMinutes = Math.round(
    ((depotReturn.arriveAt.getTime() - new Date(route.start_at_planned).getTime()) / 60_000) * 100) / 100
  const totalMiles = Math.round((finalizedMiles + result.totalMiles) * 100) / 100

  const finalizedCustomers = finalized.filter(s => s.stop_kind === 'customer').length
  const finalizedDumps = finalized.filter(s => s.stop_kind === 'dump').length

  // 6) Persist: drop the old planned tail, write the re-optimized one
  //    after the finalized stops, refresh route totals.
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM route_stops WHERE route_id = $1 AND status = 'planned'`, [args.routeId])

    let seq = maxFinalizedSeq + 1
    for (const leg of result.legs) {
      if (leg.kind === 'stop') {
        await client.query(
          `INSERT INTO route_stops (route_id, sequence_order, stop_kind, appointment_id, estimated_arrival, estimated_departure, expected_seconds)
           VALUES ($1, $2, 'customer', $3, $4, $5, $6)`,
          [args.routeId, seq, leg.stopId, leg.arriveAt, leg.departAt, expectedById.get(leg.stopId) ?? null])
      } else if (leg.kind === 'dump') {
        await client.query(
          `INSERT INTO route_stops (route_id, sequence_order, stop_kind, dump_location_id, estimated_arrival, estimated_departure)
           VALUES ($1, $2, 'dump', $3, $4, $5)`,
          [args.routeId, seq, leg.dumpLocationId, leg.arriveAt, leg.departAt])
      } else {
        await client.query(
          `INSERT INTO route_stops (route_id, sequence_order, stop_kind, estimated_arrival)
           VALUES ($1, $2, 'depot_return', $3)`,
          [args.routeId, seq, leg.arriveAt])
      }
      seq += 1
    }

    const stopCount = finalizedCustomers + result.stopCount
    const dumpCount = finalizedDumps + result.dumpCount
    await client.query(
      `UPDATE generated_routes
          SET stop_count = $2, dump_count = $3, total_miles = $4, total_minutes = $5, updated_at = NOW()
        WHERE id = $1`,
      [args.routeId, stopCount, dumpCount, totalMiles, totalMinutes])

    await client.query('COMMIT')
    return { routeId: args.routeId, stopCount, dumpCount, totalMiles, totalMinutes }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

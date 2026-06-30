/**
 * S462 / Phase 1a.3 — route generation: pulls appointments + calls
 * the optimizer + persists the route + stops.
 *
 * Transactional. Single function used by `POST /api/routes/generate`.
 * Tests exercise it via the route slice + via the materializer's
 * end-to-end happy path.
 *
 * Un-geocoded appointments (lat/lon null on the customer) get
 * silently skipped — count surfaces on the response so the
 * dispatcher knows to backfill the geocoder.
 */

import { db, query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import {
  optimizeRoute,
  OptimizerStop,
  OptimizerDumpLocation,
} from './routeOptimizer'

export interface GenerateRouteArgs {
  businessId:        string
  vehicleId:         string
  /** YYYY-MM-DD format. */
  date:              string
  /** ISO datetime; the optimizer's startAt. */
  startAt:           Date
  generatedByUserId: string | null
}

export interface GenerateRouteResult {
  routeId:                  string
  stopCount:                number
  dumpCount:                number
  totalMiles:               number
  totalMinutes:             number
  skippedUngeocodedCount:   number
}

export async function generateRoute(args: GenerateRouteArgs): Promise<GenerateRouteResult> {
  // 1) Resolve vehicle + depot (single query) + sanity-check business ownership
  const vehicle = await queryOne<{
    id: string; business_id: string; home_depot_id: string
    stops_per_dump: number; avg_speed_mph: number; avg_service_minutes: number
    service_seconds_per_unit: number
    depot_lat: string; depot_lon: string
  }>(
    `SELECT v.id, v.business_id, v.home_depot_id,
            v.stops_per_dump, v.avg_speed_mph, v.avg_service_minutes,
            b.service_seconds_per_unit,
            d.lat::text AS depot_lat, d.lon::text AS depot_lon
       FROM vehicles v
       JOIN depots d     ON d.id = v.home_depot_id
       JOIN businesses b ON b.id = v.business_id
      WHERE v.id = $1 AND v.business_id = $2
        AND v.status = 'active' AND d.status = 'active'`,
    [args.vehicleId, args.businessId])
  if (!vehicle) throw new AppError(404, 'Vehicle not found')

  // 2) Pull appointments for the date + business; JOIN customer for
  //    coords. status='scheduled' only — completed/cancelled rows
  //    don't belong on today's route.
  const appointments = await query<{
    id: string; lat: string | null; lon: string | null
    unit_count: number
  }>(
    `SELECT a.id,
            c.lat::text AS lat,
            c.lon::text AS lon,
            c.unit_count
       FROM appointments a
       JOIN business_customers c ON c.id = a.customer_id
      WHERE a.business_id = $1
        AND a.status = 'scheduled'
        AND a.scheduled_for >= $2::date
        AND a.scheduled_for <  ($2::date + INTERVAL '1 day')`,
    [args.businessId, args.date])

  // Split into geocoded + un-geocoded buckets. Service time per stop =
  // owner rate × the customer's unit count (Nic's "1 min per can");
  // expected_seconds is snapshotted onto each stop for efficiency.
  const ratePerUnit = vehicle.service_seconds_per_unit
  const expectedById = new Map<string, number>()
  const optimizerStops: OptimizerStop[] = []
  let skippedUngeocodedCount = 0
  for (const a of appointments) {
    if (a.lat === null || a.lon === null) {
      skippedUngeocodedCount += 1
      continue
    }
    const expectedSeconds = ratePerUnit * (a.unit_count ?? 1)
    expectedById.set(a.id, expectedSeconds)
    optimizerStops.push({
      id: a.id,
      lat: Number(a.lat),
      lon: Number(a.lon),
      serviceMinutes: expectedSeconds / 60,
    })
  }

  // 3) Pull dump locations for the business.
  const dumpRows = await query<{
    id: string; lat: string; lon: string; typical_dump_minutes: number
  }>(
    `SELECT id, lat::text AS lat, lon::text AS lon, typical_dump_minutes
       FROM dump_locations
      WHERE business_id = $1 AND status = 'active'`,
    [args.businessId])
  const dumps: OptimizerDumpLocation[] = dumpRows.map(d => ({
    id: d.id, lat: Number(d.lat), lon: Number(d.lon),
    dumpMinutes: d.typical_dump_minutes,
  }))

  // 4) Optimize.
  const result = optimizeRoute({
    depot: { lat: Number(vehicle.depot_lat), lon: Number(vehicle.depot_lon) },
    vehicle: {
      stopsPerDump:      vehicle.stops_per_dump,
      avgSpeedMph:       vehicle.avg_speed_mph,
      avgServiceMinutes: vehicle.avg_service_minutes,
    },
    dumpLocations: dumps,
    stops: optimizerStops,
    startAt: args.startAt,
  })

  // 5) Persist transactionally.
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows: [r] } = await client.query<{ id: string }>(
      `INSERT INTO generated_routes
         (business_id, vehicle_id, depot_id, generated_for_date,
          start_at_planned, generated_by_user_id,
          total_miles, total_minutes, stop_count, dump_count,
          skipped_ungeocoded_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [args.businessId, args.vehicleId, vehicle.home_depot_id,
       args.date, args.startAt, args.generatedByUserId,
       result.totalMiles, result.totalMinutes,
       result.stopCount, result.dumpCount,
       skippedUngeocodedCount])
    const routeId = r.id

    // Insert one route_stops row per leg, in order.
    let seq = 0
    for (const leg of result.legs) {
      if (leg.kind === 'stop') {
        await client.query(
          `INSERT INTO route_stops
             (route_id, sequence_order, stop_kind, appointment_id,
              estimated_arrival, estimated_departure, expected_seconds)
           VALUES ($1, $2, 'customer', $3, $4, $5, $6)`,
          [routeId, seq, leg.stopId, leg.arriveAt, leg.departAt, expectedById.get(leg.stopId) ?? null])
      } else if (leg.kind === 'dump') {
        await client.query(
          `INSERT INTO route_stops
             (route_id, sequence_order, stop_kind, dump_location_id,
              estimated_arrival, estimated_departure)
           VALUES ($1, $2, 'dump', $3, $4, $5)`,
          [routeId, seq, leg.dumpLocationId, leg.arriveAt, leg.departAt])
      } else {
        // depot_return — no departure
        await client.query(
          `INSERT INTO route_stops
             (route_id, sequence_order, stop_kind, estimated_arrival)
           VALUES ($1, $2, 'depot_return', $3)`,
          [routeId, seq, leg.arriveAt])
      }
      seq += 1
    }

    await client.query('COMMIT')

    return {
      routeId,
      stopCount:               result.stopCount,
      dumpCount:               result.dumpCount,
      totalMiles:              result.totalMiles,
      totalMinutes:            result.totalMinutes,
      skippedUngeocodedCount,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

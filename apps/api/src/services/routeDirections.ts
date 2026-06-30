/**
 * Road-following directions for the in-app driver map (service-business,
 * S510). Without this the map only draws crow-flies lines between stops
 * — useless for driving. OSRM turns the stop coordinates into the real
 * road path plus a turn list ("turn left onto Main St"), which the map
 * renders as visual turn-by-turn (no audio).
 *
 * OSRM is open-source OSM routing — same data family as the geocoder
 * (Nominatim) and the map tiles. Dev points at the public demo server;
 * production self-hosts via OSRM_URL (no usage limits, sovereign).
 *
 * Failure-tolerant: any OSRM error returns an empty route so the map
 * falls back to straight lines rather than breaking. NEVER throws for
 * routing failures (only for auth/ownership).
 */

import { queryOne, query } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { GeoPoint } from './routeOptimizer'

const OSRM_DEFAULT = 'https://router.project-osrm.org'
const REQUEST_TIMEOUT_MS = 8000
// Cap coordinates per request so the public demo doesn't reject long
// days; production self-host has no such limit.
const MAX_COORDS = 25

export interface TurnStep {
  instruction: string
  lat: number
  lon: number
  distanceM: number
}
export interface RouteDirections {
  /** [lon, lat] pairs following the road network (GeoJSON order). */
  geometry: [number, number][]
  steps: TurnStep[]
}

interface OsrmStep {
  distance: number
  name?: string
  maneuver: { type: string; modifier?: string; location: [number, number] }
}

function maneuverText(s: OsrmStep): string {
  const name = s.name && s.name.length ? s.name : 'the road'
  const mod = s.maneuver.modifier ? ` ${s.maneuver.modifier}` : ''
  switch (s.maneuver.type) {
    case 'depart':       return `Head out on ${name}`
    case 'arrive':       return 'Arrive at stop'
    case 'turn':         return `Turn${mod} onto ${name}`
    case 'end of road':  return `Turn${mod} onto ${name}`
    case 'new name':     return `Continue onto ${name}`
    case 'continue':     return `Continue${mod} on ${name}`
    case 'merge':        return `Merge${mod} onto ${name}`
    case 'on ramp':      return `Take the ramp onto ${name}`
    case 'off ramp':     return `Take the exit toward ${name}`
    case 'fork':         return `Keep${mod} at the fork onto ${name}`
    case 'roundabout':
    case 'rotary':       return `Take the roundabout onto ${name}`
    default:             return `${s.maneuver.type}${mod} onto ${name}`.trim()
  }
}

export async function getRouteDirections(args: {
  routeId: string
  businessId: string
  from?: GeoPoint | null
}): Promise<RouteDirections> {
  const route = await queryOne<{ id: string; depot_lat: string; depot_lon: string }>(
    `SELECT r.id, d.lat::text AS depot_lat, d.lon::text AS depot_lon
       FROM generated_routes r
       JOIN depots d ON d.id = r.depot_id
      WHERE r.id = $1 AND r.business_id = $2`,
    [args.routeId, args.businessId])
  if (!route) throw new AppError(404, 'Route not found')

  const depot: GeoPoint = { lat: Number(route.depot_lat), lon: Number(route.depot_lon) }

  const stops = await query<{ stop_kind: string; cust_lat: string | null; cust_lon: string | null; dump_lat: string | null; dump_lon: string | null }>(
    `SELECT rs.stop_kind,
            c.lat::text AS cust_lat, c.lon::text AS cust_lon,
            dl.lat::text AS dump_lat, dl.lon::text AS dump_lon
       FROM route_stops rs
       LEFT JOIN appointments a       ON a.id  = rs.appointment_id
       LEFT JOIN business_customers c ON c.id  = a.customer_id
       LEFT JOIN dump_locations dl    ON dl.id = rs.dump_location_id
      WHERE rs.route_id = $1 AND rs.status = 'planned'
      ORDER BY rs.sequence_order ASC`,
    [args.routeId])

  // Build the coordinate path: where the driver is (or depot) → each
  // remaining stop → depot return.
  const coords: GeoPoint[] = []
  coords.push(args.from ?? depot)
  for (const s of stops) {
    const loc: GeoPoint | null =
      s.stop_kind === 'customer' && s.cust_lat && s.cust_lon ? { lat: Number(s.cust_lat), lon: Number(s.cust_lon) }
      : s.stop_kind === 'dump' && s.dump_lat && s.dump_lon ? { lat: Number(s.dump_lat), lon: Number(s.dump_lon) }
      : s.stop_kind === 'depot_return' ? depot
      : null
    if (loc) coords.push(loc)
  }
  const capped = coords.slice(0, MAX_COORDS)
  if (capped.length < 2) return { geometry: [], steps: [] }

  const path = capped.map(c => `${c.lon},${c.lat}`).join(';')
  const base = process.env.OSRM_URL ?? OSRM_DEFAULT
  const url = `${base}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=true`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) { logger.warn({ status: res.status }, '[directions] OSRM non-200'); return { geometry: [], steps: [] } }
    const body = await res.json() as any
    if (body.code !== 'Ok' || !body.routes?.[0]) return { geometry: [], steps: [] }
    const r = body.routes[0]
    const geometry: [number, number][] = r.geometry?.coordinates ?? []
    const steps: TurnStep[] = []
    for (const leg of r.legs ?? []) {
      for (const s of (leg.steps ?? []) as OsrmStep[]) {
        if (s.maneuver.type === 'depart' && steps.length > 0) continue  // dedupe mid-route departs
        const [lon, lat] = s.maneuver.location
        steps.push({ instruction: maneuverText(s), lat, lon, distanceM: Math.round(s.distance) })
      }
    }
    return { geometry, steps }
  } catch (e) {
    logger.warn({ err: e }, '[directions] OSRM request failed')
    return { geometry: [], steps: [] }
  } finally {
    clearTimeout(timer)
  }
}

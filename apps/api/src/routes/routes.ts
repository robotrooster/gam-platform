/**
 * S462 / Phase 1a.3 — generated routes lifecycle.
 *
 * Seven endpoints serving the route lifecycle from generation
 * through driver-side execution:
 *
 *   POST   /api/routes/generate                 (owner + staff)
 *   GET    /api/routes                          (owner + staff)
 *   GET    /api/routes/:id                      (owner + staff)
 *   GET    /api/routes/:id/directions           (owner + staff)  — OSRM turn-by-turn
 *   GET    /api/routes/:id/insertable-appointments  (owner + staff)
 *   POST   /api/routes/:id/stops                (owner + staff)  — live insert
 *   PATCH  /api/routes/:id/stop-order           (owner + staff)  — pre-start reorder
 *   POST   /api/routes/:id/position             (owner + staff)  — GPS ping → ETA
 *   POST   /api/routes/:id/stops/:stopId/arrive (owner + staff)  — GPS geofence arrival
 *   POST   /api/routes/:id/start                (owner + staff)
 *   POST   /api/routes/:id/complete             (owner + staff)
 *   POST   /api/routes/:id/stops/:stopId/complete  (owner + staff)
 *   POST   /api/routes/:id/stops/:stopId/skip      (owner + staff)
 *
 * Drivers (business_staff with staff_role='driver') are the primary
 * users of the stop-complete / stop-skip endpoints. All routes are
 * accessible to all business members for MVP; per-role gating lands
 * with the permission framework.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { generateRoute } from '../services/routeGeneration'
import { notifyStopCustomer } from '../services/customerPush'

export const routesRouter = Router()

async function requireBusinessId(req: any): Promise<string> {
  if (req.user!.role === 'business_owner') {
    const biz = await queryOne<{ id: string }>(
      `SELECT id FROM businesses
        WHERE owner_user_id = $1 AND status IN ('active', 'suspended')
        ORDER BY created_at DESC LIMIT 1`,
      [req.user!.userId])
    if (!biz) throw new AppError(404, 'No active business for this owner')
    return biz.id
  }
  if (req.user!.role === 'business_staff') {
    if (!req.user!.businessId) {
      throw new AppError(403, 'Staff account is not scoped to a business')
    }
    return req.user!.businessId
  }
  throw new AppError(403, 'Business-portal access required')
}

// ═══════════════════════════════════════════════════════════════
//  POST /generate
// ═══════════════════════════════════════════════════════════════

const generateSchema = z.object({
  vehicleId: z.string().uuid(),
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startAt:   z.string().datetime(),
})

routesRouter.post('/generate', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = generateSchema.parse(req.body)
    const result = await generateRoute({
      businessId,
      vehicleId:         body.vehicleId,
      date:              body.date,
      startAt:           new Date(body.startAt),
      generatedByUserId: req.user!.userId,
    })
    res.status(201).json({ success: true, data: result })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /  — list
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  vehicleId: z.string().uuid().optional(),
  status:    z.enum(['generated', 'in_progress', 'completed']).optional(),
  limit:     z.coerce.number().int().positive().max(500).optional(),
})

routesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let whereSql = 'WHERE r.business_id = $1'
    if (q.date)      { params.push(q.date);      whereSql += ` AND r.generated_for_date = $${params.length}` }
    if (q.vehicleId) { params.push(q.vehicleId); whereSql += ` AND r.vehicle_id = $${params.length}` }
    if (q.status)    { params.push(q.status);    whereSql += ` AND r.status = $${params.length}` }
    params.push(q.limit ?? 100)
    const rows = await query<any>(
      `SELECT r.id, r.vehicle_id, r.depot_id, r.generated_for_date,
              r.start_at_planned, r.status, r.started_at, r.completed_at,
              r.total_miles, r.total_minutes,
              r.stop_count, r.dump_count, r.skipped_ungeocoded_count,
              r.created_at,
              v.name AS vehicle_name,
              d.name AS depot_name
         FROM generated_routes r
         JOIN vehicles v ON v.id = r.vehicle_id
         JOIN depots   d ON d.id = r.depot_id
         ${whereSql}
        ORDER BY r.generated_for_date DESC, r.created_at DESC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id  — full plan with stops
// ═══════════════════════════════════════════════════════════════

routesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const route = await queryOne<any>(
      `SELECT r.*, v.name AS vehicle_name,
              d.name AS depot_name, d.lat AS depot_lat, d.lon AS depot_lon,
              b.arrival_geofence_meters
         FROM generated_routes r
         JOIN vehicles v   ON v.id = r.vehicle_id
         JOIN depots   d   ON d.id = r.depot_id
         JOIN businesses b ON b.id = r.business_id
        WHERE r.id = $1 AND r.business_id = $2`,
      [req.params.id, businessId])
    if (!route) throw new AppError(404, 'Route not found')

    const stops = await query<any>(
      `SELECT rs.id, rs.sequence_order, rs.stop_kind,
              rs.appointment_id, rs.dump_location_id,
              rs.estimated_arrival, rs.estimated_departure,
              rs.actual_arrival, rs.actual_departure,
              rs.expected_seconds,
              rs.status, rs.driver_notes,
              -- Customer detail for customer stops
              bc.first_name, bc.last_name, bc.company_name,
              bc.email, bc.phone,
              bc.street1, bc.city, bc.state, bc.zip,
              bc.lat AS customer_lat, bc.lon AS customer_lon,
              a.service_type, a.notes AS appointment_notes,
              -- Dump location detail for dump stops
              dl.name AS dump_name,
              dl.street1 AS dump_street1, dl.city AS dump_city,
              dl.state AS dump_state, dl.zip AS dump_zip,
              dl.lat AS dump_lat, dl.lon AS dump_lon
         FROM route_stops rs
         LEFT JOIN appointments a ON a.id = rs.appointment_id
         LEFT JOIN business_customers bc ON bc.id = a.customer_id
         LEFT JOIN dump_locations dl ON dl.id = rs.dump_location_id
        WHERE rs.route_id = $1
        ORDER BY rs.sequence_order ASC`,
      [req.params.id])
    res.json({ success: true, data: { route, stops } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id/directions  — road-following geometry + turn list (OSRM)
// ═══════════════════════════════════════════════════════════════
//
// Powers the in-app map's visual turn-by-turn. Optional ?from=lat,lon
// (the driver's live position) anchors the first leg; otherwise the
// depot. Returns empty geometry on any OSRM failure (map falls back to
// straight lines).

routesRouter.get('/:id/directions', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    let from: { lat: number; lon: number } | null = null
    if (typeof req.query.from === 'string') {
      const [lat, lon] = req.query.from.split(',').map(Number)
      if (Number.isFinite(lat) && Number.isFinite(lon)) from = { lat, lon }
    }
    const { getRouteDirections } = await import('../services/routeDirections')
    const data = await getRouteDirections({ routeId: req.params.id, businessId, from })
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id/insertable-appointments  — schedulable adds for #14
// ═══════════════════════════════════════════════════════════════
//
// Scheduled appointments for this route's business + date that aren't
// already on this route (a previously-skipped one may be re-added).
// `geocoded` flags whether the customer has coordinates — un-geocoded
// ones can't be inserted (the optimizer needs lat/lon) and the UI
// disables them.

routesRouter.get('/:id/insertable-appointments', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const route = await queryOne<{ generated_for_date: string }>(
      `SELECT generated_for_date FROM generated_routes WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!route) throw new AppError(404, 'Route not found')

    const rows = await query<any>(
      `SELECT a.id, a.service_type, a.scheduled_for, a.duration_minutes,
              c.first_name, c.last_name, c.company_name,
              c.street1, c.city, c.state, c.zip,
              (c.lat IS NOT NULL AND c.lon IS NOT NULL) AS geocoded
         FROM appointments a
         JOIN business_customers c ON c.id = a.customer_id
        WHERE a.business_id = $1
          AND a.status = 'scheduled'
          AND a.scheduled_for >= $2::date
          AND a.scheduled_for <  ($2::date + INTERVAL '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM route_stops rs
             WHERE rs.appointment_id = a.id AND rs.route_id = $3
               AND rs.status <> 'skipped')
        ORDER BY a.scheduled_for ASC`,
      [businessId, route.generated_for_date, req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/stops  — live-insert an appointment into the route (#14)
// ═══════════════════════════════════════════════════════════════

const insertStopSchema = z.object({ appointmentId: z.string().uuid() })

routesRouter.post('/:id/stops', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = insertStopSchema.parse(req.body ?? {})
    const { insertStopIntoRoute } = await import('../services/routeInsert')
    const result = await insertStopIntoRoute({
      routeId: req.params.id, businessId, appointmentId: body.appointmentId,
    })
    res.status(201).json({ success: true, data: result })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id/stop-order  — pre-start manual reorder (#16)
// ═══════════════════════════════════════════════════════════════

const reorderSchema = z.object({ orderedStopIds: z.array(z.string().uuid()).min(1) })

routesRouter.patch('/:id/stop-order', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = reorderSchema.parse(req.body ?? {})
    const { reorderRouteStops } = await import('../services/routeReorder')
    const result = await reorderRouteStops({
      routeId: req.params.id, businessId, orderedStopIds: body.orderedStopIds,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/position  — driver GPS ping → recompute downstream ETAs
// ═══════════════════════════════════════════════════════════════

const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
})

routesRouter.post('/:id/position', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = positionSchema.parse(req.body ?? {})
    const { updateRoutePositionAndEta } = await import('../services/routeEta')
    const data = await updateRoutePositionAndEta({
      routeId: req.params.id, businessId, lat: body.lat, lon: body.lon,
    })
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/stops/:stopId/arrive  — GPS geofence arrival (#GPS)
// ═══════════════════════════════════════════════════════════════
//
// The in-app map posts this when the device enters the current stop's
// geofence. Stamps actual_arrival (idempotent); the auto-advance job
// then completes the stop a configurable dwell later. Only the current
// planned stop of an in_progress route.

routesRouter.post('/:id/stops/:stopId/arrive', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const r = await query<{ id: string; actual_arrival: string }>(
      `UPDATE route_stops rs
          SET actual_arrival = COALESCE(rs.actual_arrival, NOW()), updated_at = NOW()
         FROM generated_routes r
        WHERE rs.id = $1 AND rs.route_id = $2
          AND rs.route_id = r.id AND r.business_id = $3
          AND r.status = 'in_progress' AND rs.status = 'planned'
        RETURNING rs.id, rs.actual_arrival`,
      [req.params.stopId, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Stop not found, route not in progress, or already finalized')
    // Push "you're next" to the following stop's customer (fire-and-forget).
    void (async () => {
      const next = await queryOne<{ id: string }>(
        `SELECT id FROM route_stops
          WHERE route_id = $1 AND status = 'planned'
            AND sequence_order > (SELECT sequence_order FROM route_stops WHERE id = $2)
          ORDER BY sequence_order ASC LIMIT 1`,
        [req.params.id, req.params.stopId])
      if (next) await notifyStopCustomer(next.id, 'next')
    })()
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/start  — driver starts the route
// ═══════════════════════════════════════════════════════════════

routesRouter.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const r = await query<{ id: string; status: string; started_at: string }>(
      `UPDATE generated_routes
          SET status = 'in_progress', started_at = NOW()
        WHERE id = $1 AND business_id = $2 AND status = 'generated'
        RETURNING id, status, started_at`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Route not found or already started')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/complete  — driver finishes the route
// ═══════════════════════════════════════════════════════════════

routesRouter.post('/:id/complete', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const r = await query<{ id: string; status: string; completed_at: string }>(
      `UPDATE generated_routes
          SET status = 'completed', completed_at = NOW()
        WHERE id = $1 AND business_id = $2 AND status = 'in_progress'
        RETURNING id, status, completed_at`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Route not found or not in progress')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/stops/:stopId/complete  — mark a single stop done
// ═══════════════════════════════════════════════════════════════

const stopCompleteSchema = z.object({
  driverNotes: z.string().optional(),
})

routesRouter.post('/:id/stops/:stopId/complete', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = stopCompleteSchema.parse(req.body ?? {})
    // Cross-business isolation: the stop's route must belong to
    // this business. SQL FK via the route.
    //
    // S474: in one atomic CTE, flip the route_stop AND propagate to
    // appointments.status. Customer stops have appointment_id NOT
    // NULL via the route_stops CHECK; dump + depot_return stops have
    // appointment_id NULL and the appt-update WHERE silently
    // short-circuits for them. completed_at only stamped on the
    // first transition (COALESCE preserves an earlier value if any
    // future re-emit path lands).
    const r = await query<{ id: string; status: string }>(
      `WITH stop_update AS (
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
       SELECT id, status FROM stop_update`,
      [body.driverNotes ?? null,
       req.params.stopId, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Stop not found or already finalized')
    void notifyStopCustomer(req.params.stopId, 'completed')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/stops/:stopId/skip  — driver couldn't do the stop
// ═══════════════════════════════════════════════════════════════

const skipSchema = z.object({
  driverNotes: z.string().min(1),  // require a reason
})

routesRouter.post('/:id/stops/:stopId/skip', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = skipSchema.parse(req.body ?? {})
    // S474: propagate to appointments.status='no_show'. The driver
    // tried but the service didn't happen — the appointment enum's
    // no_show captures that better than 'cancelled' (which implies
    // a proactive cancellation).
    //
    // Skip is the driver's ONLY manual action. Because stops auto-
    // complete on a timer (jobs/routeAutoAdvance.ts), the driver may
    // need to skip a stop the timer ALREADY flipped to 'completed'
    // (e.g. couldn't actually service it) — so we accept 'planned' OR
    // 'completed' while the route is in_progress, and flip the
    // appointment back to no_show. Stamping actual_departure = NOW()
    // re-anchors the cascade's next leg off the real skip moment.
    const r = await query<{ id: string; status: string }>(
      `WITH stop_update AS (
         UPDATE route_stops rs
            SET status           = 'skipped',
                driver_notes     = $1,
                actual_departure = NOW(),
                updated_at       = NOW()
           FROM generated_routes r
          WHERE rs.id = $2 AND rs.route_id = $3
            AND rs.route_id = r.id AND r.business_id = $4
            AND r.status = 'in_progress'
            AND rs.status IN ('planned', 'completed')
          RETURNING rs.id, rs.status, rs.appointment_id
       ),
       appt_update AS (
         UPDATE appointments a
            SET status     = 'no_show',
                updated_at = NOW()
           FROM stop_update s
          WHERE a.id = s.appointment_id
            AND s.appointment_id IS NOT NULL
          RETURNING a.id
       )
       SELECT id, status FROM stop_update`,
      [body.driverNotes,
       req.params.stopId, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Stop not found, route not in progress, or already skipped')
    void notifyStopCustomer(req.params.stopId, 'skipped')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

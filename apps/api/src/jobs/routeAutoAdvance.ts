/**
 * Route auto-advance — GPS-arrival + dwell completion (service-business).
 *
 * Stops complete on REAL departure: the in-app map stamps actual_arrival
 * when the truck STOPS in a stop's geofence, and POSTs .../complete when
 * it leaves — that gives the true on-site time. This job is only the
 * BACKSTOP so a route can't hang when the device never reports departure
 * (driver closed the app mid-stop, or used external Maps the whole time):
 *
 *   - arrived but no departure → complete BACKSTOP_AFTER_ARRIVAL_MS later
 *   - never arrived           → complete once well past planned departure
 *   - depot return            → complete on GPS arrival at the yard, else
 *                               at its planned arrival (the work is done)
 *
 * Completion propagates the appointment to 'completed' with a timestamp
 * — the customer-facing truth. Runs every minute; catch-up safe and
 * idempotent (only finalizes stops whose time has passed).
 */

import { getClient } from '../db'
import { logger } from '../lib/logger'
import { notifyStopCustomer } from '../services/customerPush'

// Backstop after a real arrival when no departure was ever reported
// (app closed mid-stop). Generous so a true GPS departure normally
// completes the stop first.
const BACKSTOP_AFTER_ARRIVAL_MS = 30 * 60 * 1000  // 30 minutes
// Backstop for a stop that never even registered an arrival (driver
// stayed in external Maps): complete once well past its planned departure.
const BACKSTOP_GRACE_MS = 2 * 60 * 60 * 1000  // 2 hours

export interface RouteAutoAdvanceResult {
  stops_completed: number
  routes_completed: number
}

export async function processRouteAutoAdvance(
  now: Date = new Date(),
): Promise<RouteAutoAdvanceResult> {
  const client = await getClient()
  let stopsCompleted = 0
  let routesCompleted = 0
  try {
    const { rows: routes } = await client.query<{ id: string }>(
      `SELECT r.id FROM generated_routes r
        WHERE r.status = 'in_progress' AND r.started_at IS NOT NULL`)

    for (const route of routes) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { rows: curRows } = await client.query<{
          id: string; stop_kind: string; appointment_id: string | null
          actual_arrival: Date | null
          estimated_arrival: Date; estimated_departure: Date | null
        }>(
          `SELECT id, stop_kind, appointment_id, actual_arrival, estimated_arrival, estimated_departure
             FROM route_stops
            WHERE route_id = $1 AND status = 'planned'
            ORDER BY sequence_order ASC
            LIMIT 1`, [route.id])

        const cur = curRows[0]
        if (!cur) {
          await client.query(
            `UPDATE generated_routes
                SET status = 'completed', completed_at = NOW(), updated_at = NOW()
              WHERE id = $1 AND status = 'in_progress'`, [route.id])
          routesCompleted++
          break
        }

        // Backstop only — real completion is the GPS-departure POST.
        const arrived = cur.actual_arrival ? new Date(cur.actual_arrival) : null
        let dueAt: Date
        if (cur.stop_kind === 'depot_return') {
          // Work is done; complete on arrival at the yard, else at planned return.
          dueAt = arrived ? arrived : new Date(cur.estimated_arrival)
        } else if (arrived) {
          dueAt = new Date(arrived.getTime() + BACKSTOP_AFTER_ARRIVAL_MS)
        } else {
          const plannedDepart = new Date(cur.estimated_departure ?? cur.estimated_arrival)
          dueAt = new Date(plannedDepart.getTime() + BACKSTOP_GRACE_MS)
        }

        if (dueAt.getTime() > now.getTime()) break  // not due yet

        await client.query(
          `UPDATE route_stops
              SET status = 'completed',
                  actual_arrival   = COALESCE(actual_arrival, $2),
                  actual_departure = $2,
                  updated_at = NOW()
            WHERE id = $1 AND status = 'planned'`,
          [cur.id, dueAt.toISOString()])

        if (cur.appointment_id) {
          await client.query(
            `UPDATE appointments
                SET status = 'completed',
                    completed_at = COALESCE(completed_at, $2),
                    updated_at = NOW()
              WHERE id = $1`,
            [cur.appointment_id, dueAt.toISOString()])
        }
        void notifyStopCustomer(cur.id, 'completed')
        stopsCompleted++
      }
    }
  } catch (e) {
    logger.error({ err: e }, '[route-auto-advance] fatal')
    throw e
  } finally {
    client.release()
  }
  return { stops_completed: stopsCompleted, routes_completed: routesCompleted }
}

/**
 * S473 / Phase 1a.3 — stale-route cleanup.
 *
 * Hard-deletes `generated_routes` rows that were created for a date
 * more than RETENTION_DAYS ago but never moved past status='generated'.
 * Those are routes the dispatcher generated and then abandoned — the
 * truck didn't go out, or the driver started a different route, or
 * the date passed without anyone acting on the plan.
 *
 * Why hard-delete instead of soft-mark:
 *   - No audit value. The row records intent that never executed; it
 *     never had real consequences (no money moved, no contract
 *     obligation, no tenant-facing surface).
 *   - The dispatcher can always regenerate for a future date. The
 *     route_stops cascade via FK ON DELETE CASCADE.
 *
 * `in_progress` and `completed` routes are never touched — those
 * carry execution history (actual_arrival timestamps, driver notes,
 * skip reasons) which is real operational data.
 *
 * Idempotent: re-runs are no-ops once the backlog is cleared.
 */

import { query } from '../db'

const DEFAULT_RETENTION_DAYS = 7

export interface RouteCleanupResult {
  routes_deleted: number
  stops_deleted: number  // FK cascade collateral, reported for ops visibility
}

export async function processRouteCleanup(
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<RouteCleanupResult> {
  // Two-step to report both counts. The FK from route_stops to
  // generated_routes is ON DELETE CASCADE, so the stop count is
  // derived BEFORE the delete (counting after-the-fact would be zero).
  const [{ stop_count }] = await query<{ stop_count: number }>(
    `SELECT COUNT(*)::int AS stop_count
       FROM route_stops rs
       JOIN generated_routes r ON r.id = rs.route_id
      WHERE r.status = 'generated'
        AND r.generated_for_date < CURRENT_DATE - ($1::int || ' days')::interval`,
    [retentionDays],
  )

  const deleted = await query<{ id: string }>(
    `DELETE FROM generated_routes
      WHERE status = 'generated'
        AND generated_for_date < CURRENT_DATE - ($1::int || ' days')::interval
     RETURNING id`,
    [retentionDays],
  )

  return {
    routes_deleted: deleted.length,
    stops_deleted: stop_count,
  }
}

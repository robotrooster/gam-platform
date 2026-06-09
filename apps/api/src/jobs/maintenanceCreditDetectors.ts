import { query, getClient } from '../db'
import {
  emitRecurringRepairEvent,
  emitHabitabilityUnresolvedEvent,
} from '../services/creditLedgerEmitters'
import { logger } from '../lib/logger'

// ============================================================
// Daily detectors over the maintenance-request history. Two passes:
//
//   1. recurring_repair_same_issue:
//        Walks resolved maintenance_requests. If a request resolved
//        in the last 24 hours has a prior resolved request on the
//        SAME unit, SAME category, completed within 90 days BEFORE
//        the current one was created — emit one
//        recurring_repair_same_issue event tagged to the landlord
//        subject. Idempotent: we look up whether this
//        (current_request_id) has already been emitted before
//        firing.
//
//   2. habitability_complaint_unresolved_30d:
//        Walks open maintenance_requests where category is in the
//        habitability set (hvac/plumbing/electrical/structural)
//        AND created_at is older than 30 days. Emit
//        habitability_complaint_unresolved_30d once per request
//        (idempotent: check credit_events for an existing emission
//        with this request_id).
//
// Both detectors fail-isolate per row so a single bad maintenance
// request can't kill the daily run.
// ============================================================

const HABITABILITY_CATEGORIES = ['hvac', 'plumbing', 'electrical', 'structural'] as const
const RECURRING_WINDOW_DAYS = 90

export interface DetectorResult {
  recurring_emitted: number
  habitability_emitted: number
  errors: number
}

export async function processMaintenanceCreditDetectors(): Promise<DetectorResult> {
  let recurringEmitted = 0
  let habitabilityEmitted = 0
  let errors = 0

  // 1. recurring_repair_same_issue
  const recentResolved = await query<{
    id: string
    unit_id: string
    landlord_id: string
    category: string
    completed_at: string
    created_at: string
  }>(
    `SELECT id, unit_id, landlord_id, category, completed_at, created_at
       FROM maintenance_requests
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND completed_at >= NOW() - INTERVAL '1 day'`,
  )

  for (const cur of recentResolved) {
    try {
      const prior = await query<{ id: string }>(
        `SELECT id
           FROM maintenance_requests
          WHERE unit_id = $1
            AND category = $2
            AND status = 'completed'
            AND completed_at IS NOT NULL
            AND completed_at < $3
            AND completed_at >= $3::timestamptz - INTERVAL '${RECURRING_WINDOW_DAYS} days'
            AND id != $4
          ORDER BY completed_at DESC
          LIMIT 1`,
        [cur.unit_id, cur.category, cur.created_at, cur.id],
      )
      if (prior.length === 0) continue

      const alreadyEmitted = await query(
        `SELECT 1
           FROM credit_events
          WHERE event_type = 'recurring_repair_same_issue'
            AND event_data ->> 'current_request_id' = $1
          LIMIT 1`,
        [cur.id],
      )
      if (alreadyEmitted.length > 0) continue

      const client = await getClient()
      try {
        await client.query('BEGIN')
        await emitRecurringRepairEvent(client, {
          landlordId: cur.landlord_id,
          priorRequestId: prior[0].id,
          currentRequestId: cur.id,
          category: cur.category,
          occurredAt: new Date(cur.completed_at),
        })
        await client.query('COMMIT')
        recurringEmitted += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      logger.error({ err: e, current_id: cur.id }, '[maint-credit-detector][recurring]')
      errors += 1
    }
  }

  // 2. habitability_complaint_unresolved_30d
  const openHab = await query<{
    id: string
    landlord_id: string
    category: string
    created_at: string
  }>(
    `SELECT id, landlord_id, category, created_at
       FROM maintenance_requests
      WHERE status NOT IN ('completed', 'cancelled')
        AND category = ANY($1::text[])
        AND created_at <= NOW() - INTERVAL '30 days'`,
    [HABITABILITY_CATEGORIES],
  )

  for (const req of openHab) {
    try {
      const alreadyEmitted = await query(
        `SELECT 1
           FROM credit_events
          WHERE event_type = 'habitability_complaint_unresolved_30d'
            AND event_data ->> 'maintenance_request_id' = $1
          LIMIT 1`,
        [req.id],
      )
      if (alreadyEmitted.length > 0) continue

      const daysOpen = Math.floor((Date.now() - new Date(req.created_at).getTime()) / 86_400_000)

      const client = await getClient()
      try {
        await client.query('BEGIN')
        await emitHabitabilityUnresolvedEvent(client, {
          landlordId: req.landlord_id,
          requestId: req.id,
          category: req.category,
          daysOpen,
          detectedAt: new Date(),
        })
        await client.query('COMMIT')
        habitabilityEmitted += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      logger.error({ err: e, request_id: req.id }, '[maint-credit-detector][habitability]')
      errors += 1
    }
  }

  return {
    recurring_emitted: recurringEmitted,
    habitability_emitted: habitabilityEmitted,
    errors,
  }
}

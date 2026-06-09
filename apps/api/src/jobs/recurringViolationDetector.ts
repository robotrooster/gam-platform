import { query, getClient } from '../db'
import { appendEvent } from '../services/creditLedger'
import { logger } from '../lib/logger'

// ============================================================
// Daily detector for recurring_lease_violation. Walks
// lease_violation_notice_issued events on tenant subjects in the last
// 24h, groups by violation_type within a 90-day window, and emits
// recurring_lease_violation when the same tenant + violation_type
// has 2+ occurrences in the window. Idempotent: skips if a prior
// recurring_lease_violation event already references the current
// triggering event_id.
// ============================================================

const RECURRING_WINDOW_DAYS = 90

export interface RecurringViolationResult {
  emitted: number
  errors: number
}

export async function processRecurringViolationDetector(): Promise<RecurringViolationResult> {
  let emitted = 0
  let errors = 0

  // Find all violation_notice_issued events from the last 24h that have
  // a violation_type and aren't already superseded.
  const recent = await query<{
    id: string
    subject_id: string
    subject_ref_id: string
    occurred_at: string
    violation_type: string | null
  }>(
    `SELECT e.id, e.subject_id, s.subject_ref_id, e.occurred_at,
            e.event_data ->> 'violation_type' AS violation_type
       FROM credit_events e
       JOIN credit_subjects s ON s.id = e.subject_id
      WHERE e.event_type = 'lease_violation_notice_issued'
        AND e.recorded_at >= NOW() - INTERVAL '1 day'
        AND e.superseded_by IS NULL
        AND s.subject_type = 'tenant'`,
  )

  for (const cur of recent) {
    try {
      if (!cur.violation_type) continue

      // Look back 90 days for prior violations of the same type on the
      // same subject.
      const prior = await query<{ id: string }>(
        `SELECT id
           FROM credit_events
          WHERE subject_id = $1
            AND event_type = 'lease_violation_notice_issued'
            AND superseded_by IS NULL
            AND event_data ->> 'violation_type' = $2
            AND occurred_at < $3
            AND occurred_at >= $3::timestamptz - INTERVAL '${RECURRING_WINDOW_DAYS} days'
            AND id != $4
          ORDER BY occurred_at DESC
          LIMIT 1`,
        [cur.subject_id, cur.violation_type, cur.occurred_at, cur.id],
      )
      if (prior.length === 0) continue

      // Idempotency: don't re-emit if a recurring_lease_violation event
      // has already been written referencing the current triggering id.
      const dup = await query(
        `SELECT 1
           FROM credit_events
          WHERE subject_id = $1
            AND event_type = 'recurring_lease_violation'
            AND event_data ->> 'current_event_id' = $2
          LIMIT 1`,
        [cur.subject_id, cur.id],
      )
      if (dup.length > 0) continue

      const client = await getClient()
      try {
        await client.query('BEGIN')
        await appendEvent(
          {
            subjectType: 'tenant',
            subjectRefId: cur.subject_ref_id,
            eventType: 'recurring_lease_violation',
            eventData: {
              violation_type: cur.violation_type,
              prior_event_id: prior[0].id,
              current_event_id: cur.id,
            },
            occurredAt: new Date(cur.occurred_at),
            attestationSource: 'system_derived',
            attestationEvidence: {
              prior_event_id: prior[0].id,
              current_event_id: cur.id,
            },
            dimensionTags: ['tenancy_stability', 'community_fit'],
            networkVisibility: 'visible_to_gam_network',
          },
          client,
        )
        await client.query('COMMIT')
        emitted += 1
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    } catch (e) {
      logger.error({ err: e, current_id: cur.id }, '[recurring-violation-detector]')
      errors += 1
    }
  }

  return { emitted, errors }
}

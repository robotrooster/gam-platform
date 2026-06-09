/**
 * S199: daily processor that auto-terminates subleases whose end_date
 * has passed. Fires every day at 2:30am Phoenix from scheduler.ts.
 *
 * For each affected sublease:
 *   1. UPDATE status='terminated', terminated_at=NOW(),
 *      terminated_reason='end_of_term'
 *   2. Emit sublease_completed_natural credit-ledger event (subjects
 *      the sublessor — completing as agreed is positive behavior)
 *   3. Best-effort notify all three parties (sublessor, sublessee,
 *      landlord) via notifySubleaseTerminated
 *
 * Distinct from the early-termination flow at PATCH /api/subleases/:id/terminate
 * which emits sublease_terminated_early. This cron fires when the
 * sublease ends as originally planned.
 */

import { query, queryOne } from '../db'
import { appendEvent } from '../services/creditLedger'
import { logger } from '../lib/logger'

export interface SubleaseEndOfTermResult {
  terminated_count: number
  notification_errors: number
  ledger_errors: number
  date: string  // YYYY-MM-DD of the run
}

interface ExpiredSublease {
  id: string
  master_lease_id: string
  sublessor_tenant_id: string
  sublessee_tenant_id: string
  end_date: string
  landlord_id: string
  unit_number: string
  property_name: string
  sublessor_user_id: string
  sublessor_email: string
  sublessee_user_id: string
  sublessee_email: string
  landlord_user_id: string
  landlord_email: string
}

export async function processSubleaseEndOfTerm(): Promise<SubleaseEndOfTermResult> {
  const today = new Date().toISOString().slice(0, 10)
  const result: SubleaseEndOfTermResult = {
    terminated_count: 0,
    notification_errors: 0,
    ledger_errors: 0,
    date: today,
  }

  // Find active subleases past their end_date. NULL end_date = open-
  // ended (no auto-termination). Limit to a sane batch in case of
  // backlog so a single run doesn't lock up.
  const expired = await query<ExpiredSublease>(
    `SELECT s.id,
            s.master_lease_id,
            s.sublessor_tenant_id,
            s.sublessee_tenant_id,
            s.end_date::text AS end_date,
            l.landlord_id,
            u.unit_number,
            p.name AS property_name,
            tu_or.id    AS sublessor_user_id,
            tu_or.email AS sublessor_email,
            tu_ee.id    AS sublessee_user_id,
            tu_ee.email AS sublessee_email,
            lu.id       AS landlord_user_id,
            lu.email    AS landlord_email
       FROM subleases s
       JOIN leases     l   ON l.id = s.master_lease_id
       JOIN units      u   ON u.id = l.unit_id
       JOIN properties p   ON p.id = u.property_id
       JOIN landlords  la  ON la.id = l.landlord_id
       JOIN users      lu  ON lu.id = la.user_id
       JOIN tenants    t_or ON t_or.id = s.sublessor_tenant_id
       JOIN users      tu_or ON tu_or.id = t_or.user_id
       JOIN tenants    t_ee  ON t_ee.id = s.sublessee_tenant_id
       JOIN users      tu_ee ON tu_ee.id = t_ee.user_id
      WHERE s.status = 'active'
        AND s.end_date IS NOT NULL
        AND s.end_date < CURRENT_DATE
      ORDER BY s.end_date ASC
      LIMIT 500`,
  )

  for (const s of expired) {
    try {
      // 1. Flip to terminated.
      await query(
        `UPDATE subleases
            SET status = 'terminated',
                terminated_at = NOW(),
                terminated_reason = 'end_of_term: reached end_date ' || $2,
                updated_at = NOW()
          WHERE id = $1
            AND status = 'active'`,
        [s.id, s.end_date],
      )
      result.terminated_count += 1

      // 2. Credit-ledger event — sublessor completed sublease as
      // planned. Positive tenancy_stability signal.
      try {
        await appendEvent({
          subjectType: 'tenant',
          subjectRefId: s.sublessor_tenant_id,
          eventType: 'sublease_completed_natural',
          eventData: {
            sublease_id: s.id,
            master_lease_id: s.master_lease_id,
            end_date: s.end_date,
          },
          occurredAt: new Date(),
          attestationSource: 'gam_workflow_auto',
          attestationEvidence: { sublease_id: s.id },
          dimensionTags: ['tenancy_stability'],
          networkVisibility: 'visible_to_current_landlord',
        })
      } catch (e) {
        result.ledger_errors += 1
        logger.error({ err: e, sublease_id: s.id }, '[sublease-end-of-term][credit]')
      }

      // 3. Notify all three parties — this is a "happened naturally"
      // event so everyone gets a ping (no skip-the-trigger logic
      // since the cron triggered, not a party).
      try {
        const { notifySubleaseTerminated } = await import('../services/notifications')
        for (const r of [
          { userId: s.sublessor_user_id, email: s.sublessor_email },
          { userId: s.sublessee_user_id, email: s.sublessee_email },
          { userId: s.landlord_user_id,  email: s.landlord_email  },
        ]) {
          await notifySubleaseTerminated({
            recipientUserId: r.userId,
            recipientEmail:  r.email,
            subleaseId:      s.id,
            unitNumber:      s.unit_number,
            propertyName:    s.property_name,
            // Reuse the existing terminator label set with a
            // synthetic value. Frontend label maps don't
            // distinguish; the body text covers it.
            triggeredBy:     'landlord_terminated',
            reason:          'End of term reached (' + s.end_date + ')',
          })
        }
      } catch (e) {
        result.notification_errors += 1
        logger.error({ err: e, sublease_id: s.id }, '[sublease-end-of-term][notify]')
      }
    } catch (e) {
      logger.error({ err: e, sublease_id: s.id }, '[sublease-end-of-term] failed for sublease')
    }
  }

  // Suppress unused-import (queryOne is reserved for any future
  // single-row lookup variant).
  void queryOne

  return result
}

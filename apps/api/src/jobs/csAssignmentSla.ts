/**
 * S598: customer-service 24-hour assignment SLA.
 *
 * Every landlord that needs its OWN CS specialist — self-closed, or closed by a
 * party who can't do platform CS (a referring landlord, or a non-rep person-level
 * upline) — must carry a `landlords.service_manager_id` so the monthly commission
 * accrual (jobs/commissionAccrual.ts) pays the mandatory CS 25¢ to a person
 * instead of skipping it. This mirrors that job's `closerDoesCs` logic exactly:
 * a REP closer (portfolio_manager/admin/super_admin) does their own CS, so their
 * landlords intentionally keep service_manager_id NULL and are NEVER swept here.
 *
 * Nic's rule (S598): if such a landlord is still unassigned 24h after signup,
 * auto-assign it to the OWNER — the default (and, today, only) CS rep. When more
 * agents exist, a claim / round-robin layer slots in AHEAD of this fallback; this
 * job stays the backstop that guarantees the 24h SLA is always met.
 *
 * Safety: the accrual only READS service_manager_id when the closer can't do CS,
 * so even a mis-assignment here cannot misroute a cent. Idempotent — only touches
 * rows still NULL; safe to run hourly.
 */

import { query, queryOne } from '../db'
import { OWNER_EMAIL } from '../middleware/auth'
import { logger } from '../lib/logger'

export interface CsAssignmentSlaResult {
  assigned: number
  ownerId: string | null
  landlordIds: string[]
}

export async function processCsAssignmentSla(now: Date = new Date()): Promise<CsAssignmentSlaResult> {
  // Default CS rep = the owner; fall back to the earliest super_admin.
  let owner = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [OWNER_EMAIL])
  if (!owner) {
    owner = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE role = 'super_admin' ORDER BY created_at LIMIT 1`)
  }
  if (!owner) {
    logger.error('[cs-sla] no owner / super_admin found to serve as default CS rep — skipping')
    return { assigned: 0, ownerId: null, landlordIds: [] }
  }

  // Assign in one atomic, idempotent statement. The WHERE mirrors
  // commissionAccrual.closerDoesCs === false (the landlords whose CS needs a
  // separate specialist) AND only rows still unassigned + older than 24h.
  const rows = await query<{ id: string }>(
    `UPDATE landlords l
        SET service_manager_id = $1, updated_at = now()
       FROM users ou
       LEFT JOIN users up ON up.id = ou.referred_by_user_id
      WHERE ou.id = l.user_id
        AND l.service_manager_id IS NULL
        AND l.created_at < $2::timestamptz - interval '24 hours'
        AND (
          l.referred_by_user_id IS NOT NULL
          OR (l.portfolio_manager_id IS NULL
              AND (ou.referred_by_user_id IS NULL
                   OR up.role NOT IN ('portfolio_manager','admin','super_admin')))
        )
     RETURNING l.id`,
    [owner.id, now.toISOString()])

  const landlordIds = rows.map((r) => r.id)
  const assigned = landlordIds.length

  if (assigned > 0) {
    logger.info({ assigned, ownerId: owner.id }, '[cs-sla] auto-assigned unclaimed CS landlords to owner')
    await query(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ('info', 'cs_auto_assign', $1, $2, $3::jsonb)`,
      [`Auto-assigned ${assigned} landlord${assigned === 1 ? '' : 's'} to you for CS`,
       `No rep claimed within 24h of signup — routed to you so customer service is covered and the CS commission is paid.`,
       JSON.stringify({ assigned, ownerId: owner.id, landlordIds })]
    ).catch((err) => logger.error({ err }, '[cs-sla] notify insert failed'))
  }

  return { assigned, ownerId: owner.id, landlordIds }
}

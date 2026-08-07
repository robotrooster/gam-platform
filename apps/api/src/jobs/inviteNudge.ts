/**
 * S582 (Nic): tenant invite nudge. A 7-day tenant invite that's never accepted
 * lapses silently. This daily job reminds the tenant BEFORE it expires, reducing
 * onboarding drop-off. (The onboarding control tower alerts the LANDLORD once an
 * invite has already lapsed — this is the proactive half.)
 *
 * Eligible: a unit-bound pending intent that is unaccepted + unresolved +
 * uncancelled, whose invite is still valid but expiring within EXPIRING_WINDOW,
 * and that we haven't nudged within MIN_GAP. So over the back half of the 7-day
 * window a tenant gets ~2 reminders, spaced out — never a daily barrage.
 */
import { query } from '../db'
import { logger } from '../lib/logger'
import { emailTenantInviteReminder } from '../services/email'

const TENANT_APP_URL = process.env.TENANT_APP_URL || 'http://localhost:3002'
const EXPIRING_WINDOW = '4 days'   // start nudging when ≤4 days remain (i.e. ~day 3 of 7)
const MIN_GAP = '2 days'           // don't nudge the same invite more often than this

export interface InviteNudgeResult {
  nudged: number
  errors: number
}

export async function nudgeExpiringInvites(): Promise<InviteNudgeResult> {
  const rows = await query<any>(`
    SELECT pti.id,
           u.email, u.first_name AS tenant_first, u.tenant_invite_token,
           EXTRACT(DAY FROM (u.tenant_invite_expires_at - NOW()))::int AS days_left,
           un.unit_number, p.name AS property_name,
           lu.first_name AS ll_first, lu.last_name AS ll_last,
           pti.landlord_id, pti.tenant_id
      FROM pending_tenant_intents pti
      JOIN tenants  t  ON t.id = pti.tenant_id
      JOIN users    u  ON u.id = t.user_id
      JOIN units    un ON un.id = pti.unit_id
      JOIN properties p ON p.id = un.property_id
      JOIN landlords la ON la.id = pti.landlord_id
      JOIN users    lu ON lu.id = la.user_id
     WHERE pti.unit_id IS NOT NULL
       AND pti.accepted_at IS NULL
       AND pti.resolved_at IS NULL
       AND pti.cancelled_at IS NULL
       AND u.tenant_invite_token IS NOT NULL
       AND u.tenant_invite_expires_at > NOW()
       AND u.tenant_invite_expires_at <= NOW() + INTERVAL '${EXPIRING_WINDOW}'
       AND (pti.invite_last_nudged_at IS NULL OR pti.invite_last_nudged_at < NOW() - INTERVAL '${MIN_GAP}')
  `)

  let nudged = 0
  let errors = 0
  for (const r of rows) {
    try {
      const landlordName = [r.ll_first, r.ll_last].filter(Boolean).join(' ').trim() || 'Your landlord'
      const unitLabel = `${r.property_name} — Unit ${r.unit_number}`
      const activationUrl = `${TENANT_APP_URL}/accept-invite?token=${r.tenant_invite_token}`
      // days_left can be 0 on the final day; floor at 1 for copy ("expires tomorrow").
      const daysLeft = Math.max(1, Number(r.days_left) || 1)
      await emailTenantInviteReminder(
        r.email, r.tenant_first || 'there', landlordName, unitLabel, activationUrl, daysLeft,
        { landlordId: r.landlord_id, tenantId: r.tenant_id })
      await query(`UPDATE pending_tenant_intents SET invite_last_nudged_at = NOW(), updated_at = NOW() WHERE id = $1`, [r.id])
      nudged++
    } catch (e) {
      errors++
      logger.error({ err: e, intentId: r.id }, '[invite-nudge] failed for intent')
    }
  }

  if (nudged > 0 || errors > 0) logger.info({ nudged, errors }, '[invite-nudge] daily run complete')
  return { nudged, errors }
}

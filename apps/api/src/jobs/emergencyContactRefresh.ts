/**
 * S640 — the yearly "is this still who we'd call?"
 *
 * Nic: "maybe make a thing where we can ping tenants to update an emergency
 * contact — maybe once a year, we make sure it's still relevant. Just a name and
 * phone number and that basic stuff... if there's no emergency contact on the
 * leases, then we send the sort of survey in the tenant portal."
 *
 * Two groups, one ask:
 *   * a resident with nothing reachable on file, and
 *   * a resident whose contact nobody has confirmed in a year.
 *
 * Deliberately quiet. It notifies the RESIDENT, not the landlord, and it stamps
 * asked_at so a household hears from us about this once a year and not once a
 * night — the signing reminders taught that lesson expensively (952 emails to 39
 * people). Nothing here is urgent enough to be worth annoying somebody over; a
 * contact that goes unconfirmed simply shows on the desk's list, where a person
 * standing at the counter is a far better prompt than an email.
 */
import { query, queryOne } from '../db'
import { createNotification } from '../services/notifications'
import { logger } from '../lib/logger'

export interface RefreshResult { due: number; asked: number; skipped: number }

/** How long a confirmation is good for, and how long before we ask again. */
const STALE_AFTER = '1 year'
const ASK_AT_MOST_EVERY = '90 days'

export async function pingTenantsForEmergencyContact(
  opts: { limit?: number } = {},
): Promise<RefreshResult> {
  const out: RefreshResult = { due: 0, asked: 0, skipped: 0 }

  const rows = await query<{
    tenant_id: string; user_id: string; first_name: string;
    contact_id: string | null; contact_name: string | null; has_phone: boolean
  }>(
    `SELECT t.id AS tenant_id, u.id AS user_id, u.first_name,
            ec.id AS contact_id, ec.name AS contact_name,
            (ec.phone IS NOT NULL) AS has_phone
       FROM lease_tenants lt
       JOIN leases l  ON l.id = lt.lease_id AND l.status = 'active'
       JOIN tenants t ON t.id = lt.tenant_id
       JOIN users u   ON u.id = t.user_id
       LEFT JOIN LATERAL (
         SELECT * FROM emergency_contacts e
          WHERE e.tenant_id = t.id
          ORDER BY (e.phone IS NOT NULL) DESC, e.sort_order, e.created_at
          LIMIT 1
       ) ec ON TRUE
      WHERE lt.role = 'primary'
        -- Nothing reachable, or nobody has said it is still right in a year.
        AND (ec.id IS NULL
             OR ec.phone IS NULL
             OR ec.confirmed_at IS NULL
             OR ec.confirmed_at < NOW() - INTERVAL '${STALE_AFTER}')
        -- ...and we have not already asked this household recently.
        AND (ec.asked_at IS NULL
             OR ec.asked_at < NOW() - INTERVAL '${ASK_AT_MOST_EVERY}')
      ORDER BY ec.confirmed_at NULLS FIRST
      LIMIT $1`,
    [opts.limit ?? 200],
  )
  out.due = rows.length

  for (const r of rows) {
    try {
      const known = r.contact_name && r.has_phone
      await createNotification({
        userId: r.user_id,
        type: 'emergency_contact_refresh',
        title: 'Who should we call in an emergency?',
        body: known
          ? `We have ${r.contact_name} down as your emergency contact. If that is still right, no action needed — if it has changed, update it in your portal.`
          : 'We do not have an emergency contact on file for you. It takes a moment to add one — a name and a phone number is enough.',
        actionUrl: '/profile#emergency-contact',
      })
      // Stamp even when there is no row yet, so a household with nothing on
      // file is not asked every single night. A contact created later inherits
      // a clean slate.
      if (r.contact_id) {
        await query(`UPDATE emergency_contacts SET asked_at = NOW() WHERE id = $1`, [r.contact_id])
      } else {
        // WHERE NOT EXISTS rather than ON CONFLICT: there is no unique key on
        // tenant_id (a resident may legitimately name two people), so the guard
        // has to be the absence of any row at all.
        await query(
          `INSERT INTO emergency_contacts (tenant_id, source, asked_at, sort_order)
           SELECT $1, 'tenant', NOW(), 0
            WHERE NOT EXISTS (SELECT 1 FROM emergency_contacts WHERE tenant_id = $1)`,
          [r.tenant_id])
      }
      out.asked++
    } catch (e) {
      out.skipped++
      logger.error({ err: e, tenantId: r.tenant_id }, '[emergency-contact-refresh] could not ask')
    }
  }
  if (out.asked > 0) logger.info(out, '[emergency-contact-refresh]')
  return out
}

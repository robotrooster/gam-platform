/**
 * Application → lease packet (S593 door, S653 rebuilt).
 *
 * The listings marketplace is the long-term public door; a landlord onboarding
 * a (background-cleared) applicant lands them on the Master Schedule. Until
 * S653 this drafted a lease SHELL — a `leases` row with no tenant on it and no
 * document — and sent the landlord to an edit form. Nic: "creating the bare
 * lease row with no tenant or document and opens an empty edit window. That
 * edit window should not even fucking exist."
 *
 * Now it does what every other approval does (services/householdPacketDraft):
 * the applicant is recorded on the space and the SIGNING PACKET is drafted off
 * the unit's default template with them on it as primary, carrying the move-in
 * date and term from their application. The lease row is created by the
 * packet. Idempotent through the intent's (tenant, unit) uniqueness and the
 * drafter's own "already drafted" check.
 */
import { queryOne } from '../db'
import { logger } from '../lib/logger'
import { draftPacketForHousehold, type HouseholdPacketResult } from './householdPacketDraft'

export async function draftLeaseFromApplication(
  applicationId: string,
  actorUserId?: string | null,
): Promise<{ drafted: boolean; reason?: string } & Partial<HouseholdPacketResult>> {
  const app = await queryOne<any>(
    `SELECT a.id, a.unit_id, a.landlord_id, a.applicant_user_id,
            to_char(a.move_in_date, 'YYYY-MM-DD') AS move_in_date, a.desired_term_months
       FROM unit_applications a
      WHERE a.id = $1`, [applicationId])
  if (!app) return { drafted: false, reason: 'not_found' }
  if (!app.unit_id) return { drafted: false, reason: 'no_unit' }        // property-level application
  if (!app.applicant_user_id) return { drafted: false, reason: 'no_account' }

  const out = await draftPacketForHousehold({
    unitId: app.unit_id,
    applicantUserId: app.applicant_user_id,
    landlordScope: [app.landlord_id],
    startDate: app.move_in_date || null,
    termMonths: Number(app.desired_term_months) > 0 ? Math.trunc(Number(app.desired_term_months)) : null,
    monthToMonth: !(Number(app.desired_term_months) > 0),
    actorUserId: actorUserId ?? null,
  })
  logger.info({ applicationId, documentId: out.documentId }, '[application-lease-draft] packet drafted from application')
  return { ...out, reason: out.needsTemplate ? 'needs_template' : undefined }
}

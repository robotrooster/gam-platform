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
    // ── 10/24 (Nic, DIRECTIVE) — SAME RULE AS THE SCREENING DOOR ─────────────
    //
    //   "The 3 months becomes a note, not a contract term, and every drafted
    //    lease starts month to month with no end date."
    //
    // The applicant's desired_term_months is their own guess on the application
    // form. It used to be handed through as the lease term, which computed a
    // hard month-end end date and set lease_type = 'fixed_term' — the same
    // defect that put a 2027-01-31 end date on James Fenton's RV 15 lease via
    // the screening door (routes/background draftLeaseForApprovedCheck). Both
    // doors now draft month-to-month; the number stays on unit_applications,
    // which is where the follow-up prompt reads it from.
    termMonths: null,
    monthToMonth: true,
    actorUserId: actorUserId ?? null,
  })
  logger.info({ applicationId, documentId: out.documentId }, '[application-lease-draft] packet drafted from application')
  return { ...out, reason: out.needsTemplate ? 'needs_template' : undefined }
}

/**
 * Application → draft lease (S593 — defragment the two public channels).
 *
 * The short-term booking storefront already converges on the Master Schedule:
 * a long stay auto-drafts a lease via `maybeDraftLeaseFromBooking`. This is the
 * mirror for the LONG-TERM listings marketplace — when a landlord onboards a
 * (background-cleared) applicant, we draft a pending/needs-review lease so the
 * unit lands on the SAME schedule. One occupancy source of truth, two doors.
 *
 * Deliberately mirrors bookingLeaseDraft: draft the lease SHELL (no tenant link
 * — the existing e-sign/review flow attaches the tenant at sign time with the
 * correct lease_tenants lifecycle) and carry `source_application_id` so the
 * applicant stays recoverable. Idempotent via the unique partial index.
 */
import { query, queryOne } from '../db'
import { createNotification } from './notifications'
import { logger } from '../lib/logger'

export async function draftLeaseFromApplication(
  applicationId: string,
): Promise<{ drafted: boolean; leaseId?: string; reason?: string }> {
  const app = await queryOne<any>(
    `SELECT a.id, a.unit_id, a.landlord_id, a.applicant_user_id,
            a.first_name, a.last_name, a.move_in_date,
            u.rent_amount, u.unit_number, u.status AS unit_status,
            p.name AS property_name
       FROM unit_applications a
       JOIN units u      ON u.id = a.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE a.id = $1`,
    [applicationId],
  )
  if (!app) return { drafted: false, reason: 'not_found' }
  if (!app.unit_id) return { drafted: false, reason: 'no_unit' } // property-level application

  // One draft per application (the unique partial index backs this up).
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM leases WHERE source_application_id = $1`, [applicationId])
  if (existing) return { drafted: false, leaseId: existing.id, reason: 'already_drafted' }

  const rent = Number(app.rent_amount) > 0 ? Number(app.rent_amount) : 0

  const rows = await query<{ id: string }>(
    `INSERT INTO leases
       (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
        needs_review, lease_source, source_application_id)
     VALUES ($1, $2, $3, 'month_to_month', 'pending', COALESCE($4::date, CURRENT_DATE), NULL,
             TRUE, 'application_draft', $5)
     ON CONFLICT (source_application_id) WHERE source_application_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [app.unit_id, app.landlord_id, rent, app.move_in_date || null, applicationId],
  )
  const leaseId = rows[0]?.id
  if (!leaseId) {
    // Lost a concurrent race — return whichever draft won.
    const now = await queryOne<{ id: string }>(
      `SELECT id FROM leases WHERE source_application_id = $1`, [applicationId])
    return { drafted: false, leaseId: now?.id, reason: 'already_drafted' }
  }

  // Screening heads-up. The listings marketplace gates apply-to-contact on a
  // cleared check, so most applicants arrive screened; surface it either way.
  let bgLine = ''
  if (app.applicant_user_id) {
    const t = await queryOne<{ background_check_status: string }>(
      `SELECT background_check_status FROM tenants WHERE user_id = $1`, [app.applicant_user_id])
    bgLine = t && ['approved', 'waived'].includes(t.background_check_status)
      ? ' Their GAM background check is cleared.'
      : ' Their background check is not yet cleared — screen before sending the lease.'
  }

  try {
    const owner = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [app.landlord_id])
    if (owner) {
      await createNotification({
        userId: owner.user_id,
        landlordId: app.landlord_id,
        type: 'lease_drafted_from_application',
        title: 'New applicant — review the draft lease',
        body: `${app.first_name} ${app.last_name} applied for unit ${app.unit_number} at ${app.property_name}. `
          + `A draft lease is ready on your Leases page — review the terms and dates, then send it for signing.${bgLine}`,
        data: { leaseId, applicationId, applicantUserId: app.applicant_user_id },
        actionUrl: `/leases?open=${leaseId}`,
      })
    }
  } catch (err) {
    logger.error({ err, applicationId, leaseId }, '[application-lease-draft] notification failed')
  }

  logger.info({ applicationId, leaseId }, '[application-lease-draft] draft lease created from application')
  return { drafted: true, leaseId }
}

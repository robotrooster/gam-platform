import { query } from '../db'
import { notifyInspectionScheduledReminder } from '../services/notifications'
import { logger } from '../lib/logger'

// ============================================================
// Operational nudges:
//   1. Inspection scheduled-for reminder — pings both parties when
//      a non-finalized inspection's scheduled_for is within the next
//      24h. Idempotent via unit_inspections.reminder_sent_at.
//   2. Entry-request stale auto-cancel — flips pending entry
//      requests past their proposed_entry_window_end to 'cancelled'.
// ============================================================

export interface OperationalNudgesResult {
  inspection_reminders_sent: number
  entry_requests_auto_cancelled: number
  errors: number
}

export async function processOperationalNudges(): Promise<OperationalNudgesResult> {
  let remindersSent = 0
  let autoCancelled = 0
  let errors = 0

  // 1. Inspection reminders
  const dueSoon = await query<{
    id: string
    inspection_type: 'move_in' | 'move_out' | 'periodic'
    scheduled_for: string
    tenant_user_id: string | null
    tenant_email: string | null
    tenant_phone: string | null
    landlord_id: string
    property_id: string | null
    unit_number: string | null
  }>(
    `SELECT i.id,
            i.inspection_type,
            i.scheduled_for,
            tu.id    AS tenant_user_id,
            tu.email AS tenant_email,
            tu.phone AS tenant_phone,
            l.id     AS landlord_id,
            un.property_id,
            un.unit_number
       FROM unit_inspections i
       LEFT JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN users tu  ON tu.id = t.user_id
       LEFT JOIN units un  ON un.id = i.unit_id
       JOIN landlords l ON l.id = i.landlord_id
      WHERE i.scheduled_for IS NOT NULL
        AND i.scheduled_for >= NOW()
        AND i.scheduled_for <= NOW() + INTERVAL '24 hours'
        AND i.status NOT IN ('finalized','cancelled')
        AND i.reminder_sent_at IS NULL`,
  )

  // S186: routed through responsible-party resolver. Inspection
  // reminders are operational; under PM company / individual
  // delegation the manager (not owner) handles them day-of.
  const { getPropertyResponsibleParty } = await import('../services/responsibleParty')

  for (const row of dueSoon) {
    try {
      const targets = row.property_id
        ? await getPropertyResponsibleParty(row.property_id)
        : null
      const recipients = targets?.primaries ?? []
      for (const recipient of recipients) {
        await notifyInspectionScheduledReminder({
          tenantUserId: row.tenant_user_id ?? undefined,
          tenantEmail:  row.tenant_email ?? undefined,
          tenantPhone:  row.tenant_phone ?? undefined,
          landlordUserId: recipient.user_id,
          landlordId:     row.landlord_id,
          landlordEmail:  recipient.email,
          inspectionId:   row.id,
          inspectionType: row.inspection_type,
          scheduledFor:   row.scheduled_for,
          unitNumber:     row.unit_number ?? undefined,
        })
      }
      await query(
        `UPDATE unit_inspections SET reminder_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [row.id],
      )
      remindersSent += 1
    } catch (e) {
      logger.error({ err: e, row_id: row.id }, '[operational-nudges][inspection-reminder]')
      errors += 1
    }
  }

  // 2. Entry-request stale auto-cancel
  const stale = await query<{ id: string }>(
    `UPDATE unit_entry_requests
        SET status = 'cancelled', updated_at = NOW()
      WHERE status IN ('pending','granted','denied')
        AND proposed_entry_window_end < NOW() - INTERVAL '6 hours'
        AND entry_actual_at IS NULL
      RETURNING id`,
  )
  autoCancelled = stale.length

  return {
    inspection_reminders_sent: remindersSent,
    entry_requests_auto_cancelled: autoCancelled,
    errors,
  }
}

/**
 * S518 — appointment reminder sender.
 *
 * Finds scheduled appointments entering the next-24h window that haven't
 * been reminded yet, emails the customer, and stamps `reminder_sent_at`
 * so each appointment is reminded exactly once. Best-effort per row: a
 * single email failure logs + skips the stamp (so it retries next run)
 * without aborting the batch.
 *
 * Called by the hourly cron in jobs/scheduler.ts. Exported standalone so
 * it can be unit-tested without the scheduler.
 */

import { query } from '../db'
import { logger } from '../lib/logger'
import { emailBusinessAppointmentReminder } from './email'

export interface ReminderRunResult {
  considered: number
  sent: number
  failed: number
}

export async function sendAppointmentReminders(): Promise<ReminderRunResult> {
  // Appointments that are scheduled, start within the next 24h, are still
  // in the future, have an email on file, and haven't been reminded.
  const rows = await query<{
    id: string
    business_id: string
    service_type: string
    scheduled_for: string
    duration_minutes: number
    customer_email: string | null
    customer_first_name: string | null
    customer_last_name: string | null
    business_name: string
  }>(
    `SELECT a.id, a.business_id, a.service_type, a.scheduled_for, a.duration_minutes,
            c.email AS customer_email,
            c.first_name AS customer_first_name,
            c.last_name AS customer_last_name,
            b.name AS business_name
       FROM appointments a
       JOIN business_customers c ON c.id = a.customer_id
       JOIN businesses b ON b.id = a.business_id
      WHERE a.status = 'scheduled'
        AND a.reminder_sent_at IS NULL
        AND a.scheduled_for > NOW()
        AND a.scheduled_for <= NOW() + interval '24 hours'
        AND c.email IS NOT NULL
        AND b.appointment_reminders_enabled = TRUE`,
    [])

  let sent = 0, failed = 0
  for (const r of rows) {
    const name = `${r.customer_first_name ?? ''} ${r.customer_last_name ?? ''}`.trim() || null
    try {
      await emailBusinessAppointmentReminder({
        to: r.customer_email!,
        customerName: name,
        businessName: r.business_name,
        serviceType: r.service_type,
        scheduledFor: new Date(r.scheduled_for),
        durationMinutes: r.duration_minutes,
        ctx: { businessId: r.business_id, appointmentId: r.id },
      })
      // Stamp only after a successful send so a failure retries next run.
      await query(
        `UPDATE appointments SET reminder_sent_at = NOW() WHERE id = $1`, [r.id])
      sent++
    } catch (e) {
      failed++
      logger.error({ err: e, appointment_id: r.id }, '[appointment-reminders] send failed')
    }
  }

  if (rows.length > 0) {
    logger.info(`[appointment-reminders] considered ${rows.length}, sent ${sent}, failed ${failed}`)
  }
  return { considered: rows.length, sent, failed }
}

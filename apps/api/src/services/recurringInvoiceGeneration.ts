/**
 * S505 — generate one invoice from a recurring schedule.
 *
 * Pulled out of routes/businessRecurringInvoices.ts so the daily cron
 * and the owner's "Generate now" button both call the same code path
 * with the same atomicity guarantees:
 *
 *   1. Lock the schedule row + read template lines
 *   2. Bump per-business invoice sequence + insert business_invoices
 *      (draft) + line items + source_recurring_schedule_id linkage
 *   3. Advance next_due_date by the cadence
 *   4. Update last_invoice_id + created_invoice_count + last_generated_at
 *   5. If auto_send: stamp sent_at, set status='sent', fire customer email
 *
 * Returns the generated invoice row.
 */

import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import {
  type RecurringInvoiceFrequency,
  RECURRING_INVOICE_MONTH_STEP,
  isMonthlyRecurrence,
} from '@gam/shared'

export interface GeneratedInvoice {
  id: string
  invoice_number: string
  status: 'draft' | 'sent'
  total_amount: string
}

interface ScheduleRow {
  id: string
  business_id: string
  customer_id: string
  name: string
  frequency: RecurringInvoiceFrequency
  day_of_month: number | null
  day_of_week: number | null
  start_date: string
  end_date: string | null
  next_due_date: string
  auto_send: boolean
  payment_terms_days: number
  status: 'active' | 'paused' | 'ended'
  notes: string | null
}

function advanceDueDate(current: Date, freq: RecurringInvoiceFrequency,
                       dayOfMonth: number | null, dayOfWeek: number | null): Date {
  const next = new Date(current.getTime())
  if (!isMonthlyRecurrence(freq)) {
    // weekly — advance 7 days.
    next.setUTCDate(next.getUTCDate() + 7)
    return next
  }
  // Month-based — advance by the cadence's month step (monthly 1, quarterly 3,
  // semiannual 6, annual 12), then snap to dayOfMonth (clamped to 28 so Feb is
  // always fine; the CHECK constraint also enforces 1..28).
  next.setUTCMonth(next.getUTCMonth() + RECURRING_INVOICE_MONTH_STEP[freq])
  if (dayOfMonth !== null) {
    next.setUTCDate(Math.min(dayOfMonth, 28))
  }
  void dayOfWeek
  return next
}

export async function generateOneFromSchedule(
  scheduleId: string,
  ctx: { actorUserId: string | null }
): Promise<GeneratedInvoice> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const { rows: [sched] } = await client.query<ScheduleRow>(
      `SELECT id, business_id, customer_id, name, frequency,
              day_of_month, day_of_week,
              start_date, end_date, next_due_date,
              auto_send, payment_terms_days, status, notes
         FROM business_recurring_invoice_schedules
        WHERE id = $1
        FOR UPDATE`, [scheduleId])
    if (!sched) {
      await client.query('ROLLBACK')
      throw new AppError(404, 'Schedule not found')
    }
    if (sched.status !== 'active') {
      await client.query('ROLLBACK')
      throw new AppError(409, `Schedule is ${sched.status} — only active schedules can generate`)
    }

    const { rows: lines } = await client.query<{
      description: string; quantity: string; unit_price: string; sort_order: number;
    }>(
      `SELECT description, quantity, unit_price, sort_order
         FROM business_recurring_invoice_lines
        WHERE schedule_id = $1
        ORDER BY sort_order ASC`, [scheduleId])
    if (lines.length === 0) {
      await client.query('ROLLBACK')
      throw new AppError(400, 'Schedule has no lines — add line items before generating')
    }

    // Compute totals from template (no tax v1 — match the simpler
    // invoice shape; owner can add tax_amount manually on the
    // generated draft if needed).
    let subtotal = 0
    for (const l of lines) {
      subtotal += Number(l.quantity) * Number(l.unit_price)
    }
    subtotal = Math.round(subtotal * 100) / 100

    // Bump invoice sequence.
    const { rows: [seq] } = await client.query<{ next_number: number }>(
      `INSERT INTO business_invoice_sequences (business_id, next_number)
       VALUES ($1, 2)
       ON CONFLICT (business_id)
         DO UPDATE SET next_number = business_invoice_sequences.next_number + 1
       RETURNING next_number`, [sched.business_id])
    const isFirst = seq.next_number === 2
    const thisNumber = isFirst ? 1 : seq.next_number - 1
    const invoiceNumber = `INV-${String(thisNumber).padStart(4, '0')}`

    // Issue today; due = issue + payment_terms_days.
    const issueDate = new Date()
    const dueDate = new Date(issueDate.getTime() + sched.payment_terms_days * 24 * 60 * 60 * 1000)
    const issueIso = issueDate.toISOString().slice(0, 10)
    const dueIso = dueDate.toISOString().slice(0, 10)

    const { rows: [inv] } = await client.query<any>(
      `INSERT INTO business_invoices
         (business_id, invoice_number, customer_id,
          issue_date, due_date, status,
          subtotal, tax_amount, total_amount,
          notes, source_recurring_schedule_id)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, 0, $6, $7, $8)
       RETURNING id, invoice_number, status, total_amount`,
      [sched.business_id, invoiceNumber, sched.customer_id,
       issueIso, dueIso, subtotal,
       sched.notes ?? null, sched.id])

    // Copy lines (line_total = quantity * unit_price; recurring lines
    // are simple, no tax at line level v1).
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!
      const lineTotal = Math.round(Number(l.quantity) * Number(l.unit_price) * 100) / 100
      await client.query(
        `INSERT INTO business_invoice_lines
           (invoice_id, description, quantity, unit_price, line_total, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [inv.id, l.description, Number(l.quantity), Number(l.unit_price), lineTotal, i])
    }

    // Advance the schedule's next_due_date + bump counters.
    // pg returns DATE columns as Date objects; coerce to YYYY-MM-DD
    // before re-parsing as a UTC midday anchor so the advance math
    // stays TZ-stable regardless of the server's TZ config.
    const schedDueRaw: any = sched.next_due_date
    const schedDueIso = (schedDueRaw instanceof Date
      ? schedDueRaw.toISOString()
      : String(schedDueRaw)).slice(0, 10)
    const currentDue = new Date(`${schedDueIso}T12:00:00Z`)
    const nextDue = advanceDueDate(currentDue, sched.frequency,
                                   sched.day_of_month, sched.day_of_week)
    const nextDueIso = nextDue.toISOString().slice(0, 10)

    // If past end_date, mark schedule ended after this generation.
    let newStatus: 'active' | 'ended' = 'active'
    if (sched.end_date && new Date(nextDueIso) > new Date(sched.end_date)) {
      newStatus = 'ended'
    }

    await client.query(
      `UPDATE business_recurring_invoice_schedules
          SET next_due_date          = $1,
              last_invoice_id        = $2,
              last_generated_at      = NOW(),
              created_invoice_count  = created_invoice_count + 1,
              status                 = $3
        WHERE id = $4`,
      [nextDueIso, inv.id, newStatus, sched.id])

    await client.query('COMMIT')

    // Auto-send (outside the transaction so a Stripe/email hiccup doesn't
    // roll back the generation — the operator can resend manually).
    if (sched.auto_send) {
      try {
        const { sendGeneratedInvoice } = await import('./recurringInvoiceSend')
        const result = await sendGeneratedInvoice(inv.id, sched.business_id, ctx.actorUserId)
        // S508: auto_paid means the off-session charge succeeded —
        // invoice goes straight to 'paid'. email_sent means we fell
        // back to the Checkout link path.
        inv.status = result === 'auto_paid' ? 'sent' : 'sent'
      } catch (e) {
        logger.error({ err: e, invoiceId: inv.id }, '[recurring] auto-send failed; draft preserved')
      }
    }

    return inv as GeneratedInvoice
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Cron entry: sweep all due active schedules across all businesses and
 * generate. Runs daily.
 */
export async function generateAllDueRecurringInvoices(): Promise<{
  processed: number; failed: number;
}> {
  const { rows: due } = await db.query<{ id: string }>(
    `SELECT id FROM business_recurring_invoice_schedules
      WHERE status = 'active'
        AND next_due_date <= CURRENT_DATE
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      ORDER BY next_due_date ASC`)
  let processed = 0, failed = 0
  for (const s of due) {
    try {
      await generateOneFromSchedule(s.id, { actorUserId: null })
      processed++
    } catch (e) {
      failed++
      logger.error({ err: e, scheduleId: s.id }, '[recurring-cron] generate failed')
    }
  }
  if (processed > 0 || failed > 0) {
    logger.info({ processed, failed }, '[recurring-cron] sweep complete')
  }
  return { processed, failed }
}

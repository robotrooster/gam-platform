/**
 * S505 — recurring invoice schedules.
 *
 * Endpoints:
 *   POST   /api/business-recurring-invoices                            (create + lines)
 *   GET    /api/business-recurring-invoices                            (list)
 *   GET    /api/business-recurring-invoices/:id                        (detail)
 *   PATCH  /api/business-recurring-invoices/:id                        (header — name, auto_send, terms, end_date)
 *   POST   /api/business-recurring-invoices/:id/pause
 *   POST   /api/business-recurring-invoices/:id/resume
 *   POST   /api/business-recurring-invoices/:id/end
 *   POST   /api/business-recurring-invoices/:id/generate-now
 *
 * Owner + staff with invoices.write can manage schedules. Sub-actions
 * use the relevant invoices.* permission (generate uses .send since
 * it triggers customer-facing send).
 */

import { Router } from 'express'
import { z } from 'zod'
import { db, query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireBusinessAccess } from '../middleware/businessAccess'

export const businessRecurringInvoicesRouter = Router()

const requireRead  = async (req: any) => (await requireBusinessAccess(req, { permission: 'invoices.read',  feature: 'invoicing' })).businessId
const requireWrite = async (req: any) => (await requireBusinessAccess(req, { permission: 'invoices.write', feature: 'invoicing' })).businessId
const requireSend  = async (req: any) => (await requireBusinessAccess(req, { permission: 'invoices.send',  feature: 'invoicing' })).businessId

// ── helpers ────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// Compute the first next_due_date >= start_date that matches the
// cadence. Used at create time.
function computeInitialNextDue(
  freq: 'weekly' | 'monthly',
  dayOfMonth: number | null,
  dayOfWeek: number | null,
  startDateIso: string
): string {
  const d = new Date(`${startDateIso}T12:00:00Z`)
  if (freq === 'monthly') {
    if (dayOfMonth === null) throw new Error('day_of_month required for monthly')
    // If current month's day_of_month >= start_date's day, use this month;
    // otherwise advance to next month.
    const cand = new Date(d.getTime())
    cand.setUTCDate(Math.min(dayOfMonth, 28))
    if (cand < d) {
      cand.setUTCMonth(cand.getUTCMonth() + 1)
      cand.setUTCDate(Math.min(dayOfMonth, 28))
    }
    return cand.toISOString().slice(0, 10)
  }
  // weekly: find next dayOfWeek >= start_date.
  if (dayOfWeek === null) throw new Error('day_of_week required for weekly')
  const cur = d.getUTCDay()
  const delta = (dayOfWeek - cur + 7) % 7
  const cand = new Date(d.getTime() + delta * 24 * 60 * 60 * 1000)
  return cand.toISOString().slice(0, 10)
}

// ═══════════════════════════════════════════════════════════════
//  POST / — create
// ═══════════════════════════════════════════════════════════════

const lineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity:    z.number().positive(),
  unitPrice:   z.number().min(0),
})

const createSchema = z.discriminatedUnion('frequency', [
  z.object({
    frequency:    z.literal('monthly'),
    dayOfMonth:   z.number().int().min(1).max(28),
  }),
  z.object({
    frequency:    z.literal('weekly'),
    dayOfWeek:    z.number().int().min(0).max(6),
  }),
]).and(z.object({
  customerId:        z.string().uuid(),
  name:              z.string().min(1).max(200),
  startDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  autoSend:          z.boolean().optional(),
  paymentTermsDays:  z.number().int().positive().max(365).optional(),
  notes:             z.string().max(2000).nullable().optional(),
  internalNotes:     z.string().max(2000).nullable().optional(),
  lines:             z.array(lineSchema).min(1).max(50),
}))

businessRecurringInvoicesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = createSchema.parse(req.body)

    // Verify customer.
    const customer = await queryOne<{ id: string }>(
      `SELECT id FROM business_customers
        WHERE id = $1 AND business_id = $2 AND status = 'active'`,
      [body.customerId, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    if (body.endDate && body.endDate < body.startDate) {
      throw new AppError(400, 'end_date must be on or after start_date')
    }

    const initialNextDue = computeInitialNextDue(
      body.frequency,
      body.frequency === 'monthly' ? body.dayOfMonth : null,
      body.frequency === 'weekly' ? body.dayOfWeek : null,
      body.startDate)

    const client = await db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [sched] } = await client.query<any>(
        `INSERT INTO business_recurring_invoice_schedules
           (business_id, customer_id, name, frequency,
            day_of_month, day_of_week,
            start_date, end_date, next_due_date,
            auto_send, payment_terms_days,
            notes, internal_notes, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [businessId, body.customerId, body.name.trim(), body.frequency,
         body.frequency === 'monthly' ? body.dayOfMonth : null,
         body.frequency === 'weekly' ? body.dayOfWeek : null,
         body.startDate, body.endDate ?? null, initialNextDue,
         body.autoSend ?? true,
         body.paymentTermsDays ?? 30,
         body.notes?.trim() ?? null,
         body.internalNotes?.trim() ?? null,
         req.user!.userId])

      for (let i = 0; i < body.lines.length; i++) {
        const l = body.lines[i]!
        await client.query(
          `INSERT INTO business_recurring_invoice_lines
             (schedule_id, description, quantity, unit_price, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [sched.id, l.description.trim(), l.quantity, l.unitPrice, i])
      }

      await client.query('COMMIT')
      res.status(201).json({ success: true, data: { ...sched, lines: body.lines } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET / — list
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  status:     z.enum(['active', 'paused', 'ended']).optional(),
  customerId: z.string().uuid().optional(),
  limit:      z.coerce.number().int().positive().max(500).optional(),
})

businessRecurringInvoicesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let where = 'WHERE s.business_id = $1'
    if (q.status)     { params.push(q.status);     where += ` AND s.status = $${params.length}` }
    if (q.customerId) { params.push(q.customerId); where += ` AND s.customer_id = $${params.length}` }
    params.push(q.limit ?? 100)
    const rows = await query<any>(
      `SELECT s.id, s.name, s.frequency, s.day_of_month, s.day_of_week,
              s.start_date, s.end_date, s.next_due_date,
              s.auto_send, s.payment_terms_days, s.status,
              s.created_invoice_count, s.last_invoice_id, s.last_generated_at,
              s.customer_id,
              s.created_at, s.updated_at,
              c.first_name AS customer_first_name,
              c.last_name AS customer_last_name,
              c.company_name AS customer_company_name,
              (SELECT COALESCE(SUM(quantity * unit_price), 0)
                 FROM business_recurring_invoice_lines WHERE schedule_id = s.id) AS cycle_amount
         FROM business_recurring_invoice_schedules s
         JOIN business_customers c ON c.id = s.customer_id
         ${where}
        ORDER BY s.status ASC, s.next_due_date ASC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id — detail
// ═══════════════════════════════════════════════════════════════

businessRecurringInvoicesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const s = await queryOne<any>(
      `SELECT s.*,
              c.first_name AS customer_first_name,
              c.last_name AS customer_last_name,
              c.company_name AS customer_company_name,
              c.email AS customer_email
         FROM business_recurring_invoice_schedules s
         JOIN business_customers c ON c.id = s.customer_id
        WHERE s.id = $1 AND s.business_id = $2`,
      [req.params.id, businessId])
    if (!s) throw new AppError(404, 'Schedule not found')
    const lines = await query<any>(
      `SELECT id, description, quantity, unit_price, sort_order
         FROM business_recurring_invoice_lines
        WHERE schedule_id = $1
        ORDER BY sort_order ASC`, [s.id])
    res.json({ success: true, data: { ...s, lines } })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id — header (no cadence change v1 — that'd require careful
//  next_due recompute. End the schedule + start a new one instead.)
// ═══════════════════════════════════════════════════════════════

const patchSchema = z.object({
  name:              z.string().min(1).max(200).optional(),
  autoSend:          z.boolean().optional(),
  paymentTermsDays:  z.number().int().positive().max(365).optional(),
  endDate:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes:             z.string().max(2000).nullable().optional(),
  internalNotes:     z.string().max(2000).nullable().optional(),
}).strict()

businessRecurringInvoicesRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = patchSchema.parse(req.body)
    if (Object.keys(body).length === 0) throw new AppError(400, 'Nothing to update')

    const r = await query<any>(
      `UPDATE business_recurring_invoice_schedules
          SET name               = COALESCE($1, name),
              auto_send          = COALESCE($2, auto_send),
              payment_terms_days = COALESCE($3, payment_terms_days),
              end_date           = COALESCE($4, end_date),
              notes              = COALESCE($5, notes),
              internal_notes     = COALESCE($6, internal_notes)
        WHERE id = $7 AND business_id = $8
        RETURNING *`,
      [body.name?.trim() ?? null,
       body.autoSend ?? null,
       body.paymentTermsDays ?? null,
       body.endDate === undefined ? null : body.endDate,
       body.notes === undefined ? null : (body.notes?.trim() ?? null),
       body.internalNotes === undefined ? null : (body.internalNotes?.trim() ?? null),
       req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Schedule not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  Pause / Resume / End
// ═══════════════════════════════════════════════════════════════

businessRecurringInvoicesRouter.post('/:id/pause', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const r = await query<any>(
      `UPDATE business_recurring_invoice_schedules
          SET status = 'paused'
        WHERE id = $1 AND business_id = $2 AND status = 'active'
        RETURNING *`, [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Schedule not found or not active')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

businessRecurringInvoicesRouter.post('/:id/resume', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    // If next_due_date is in the past, bump to today so we don't
    // generate a flood of back-cycles at the next cron.
    const r = await query<any>(
      `UPDATE business_recurring_invoice_schedules
          SET status = 'active',
              next_due_date = GREATEST(next_due_date, CURRENT_DATE)
        WHERE id = $1 AND business_id = $2 AND status = 'paused'
        RETURNING *`, [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Schedule not found or not paused')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

businessRecurringInvoicesRouter.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const r = await query<any>(
      `UPDATE business_recurring_invoice_schedules
          SET status = 'ended',
              end_date = COALESCE(end_date, CURRENT_DATE)
        WHERE id = $1 AND business_id = $2 AND status <> 'ended'
        RETURNING *`, [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Schedule not found or already ended')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  Generate now (manual trigger — same code path as the cron)
// ═══════════════════════════════════════════════════════════════

businessRecurringInvoicesRouter.post('/:id/generate-now', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireSend(req)
    // Verify schedule belongs to this business before kicking the
    // generator (which would otherwise expose by-id access).
    const sched = await queryOne<{ id: string }>(
      `SELECT id FROM business_recurring_invoice_schedules
        WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!sched) throw new AppError(404, 'Schedule not found')
    const { generateOneFromSchedule } = await import('../services/recurringInvoiceGeneration')
    const inv = await generateOneFromSchedule(sched.id, { actorUserId: req.user!.userId })
    res.json({ success: true, data: inv })
  } catch (e) { next(e) }
})

void todayIso  // reserved for future "include start_date in current cycle" logic

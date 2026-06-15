/**
 * S459 / Phase 1a.2 — appointments CRUD.
 *
 * Six endpoints serving the appointment lifecycle:
 *
 *   POST   /api/appointments              (owner + staff)
 *   GET    /api/appointments              (owner + staff, filtered)
 *   GET    /api/appointments/:id          (owner + staff)
 *   PATCH  /api/appointments/:id          (owner + staff)
 *   POST   /api/appointments/:id/complete (owner + staff)
 *   POST   /api/appointments/:id/cancel   (owner + staff)
 *
 * Both business_owner and business_staff can CRUD appointments. The
 * driver-only-sees-assigned-routes gating lands later when the
 * per-staff-role permission framework is built; for now all staff
 * see all appointments under their business.
 *
 * Recurring schedules + materializer arrive in S460. This file only
 * handles concrete one-off appointment rows.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { APPOINTMENT_STATUSES } from '@gam/shared'

export const appointmentsRouter = Router()

// ── helpers ────────────────────────────────────────────────────

/** Resolve the businessId for any business-portal user. Owners go
 *  through the businesses table (one query); staff have it on their
 *  JWT directly (set at /login per S454). Errors for non-business
 *  roles. */
async function requireBusinessId(req: any): Promise<string> {
  if (req.user!.role === 'business_owner') {
    const biz = await queryOne<{ id: string }>(
      `SELECT id FROM businesses
        WHERE owner_user_id = $1 AND status IN ('active', 'suspended')
        ORDER BY created_at DESC LIMIT 1`,
      [req.user!.userId])
    if (!biz) throw new AppError(404, 'No active business for this owner')
    return biz.id
  }
  if (req.user!.role === 'business_staff') {
    if (!req.user!.businessId) {
      throw new AppError(403, 'Staff account is not scoped to a business')
    }
    return req.user!.businessId
  }
  throw new AppError(403, 'Business-portal access required')
}

// ═══════════════════════════════════════════════════════════════
//  POST /  — create one-off appointment
// ═══════════════════════════════════════════════════════════════

const createSchema = z.object({
  customerId:      z.string().uuid(),
  serviceType:     z.string().min(1),
  scheduledFor:    z.string().datetime(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  notes:           z.string().optional(),
})

appointmentsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = createSchema.parse(req.body)

    // Customer must belong to this business (cross-business isolation).
    const customer = await queryOne<{
      id: string; email: string | null;
      first_name: string | null; last_name: string | null; company_name: string | null;
    }>(
      `SELECT id, email, first_name, last_name, company_name
         FROM business_customers
        WHERE id = $1 AND business_id = $2 AND status = 'active'`,
      [body.customerId, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    const [row] = await query<{ id: string }>(
      `INSERT INTO appointments
         (business_id, customer_id, created_by_user_id,
          service_type, scheduled_for, duration_minutes, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [businessId, body.customerId, req.user!.userId,
       body.serviceType, body.scheduledFor,
       body.durationMinutes ?? 30,
       body.notes ?? null])

    const full = await queryOne<any>(
      `SELECT * FROM appointments WHERE id = $1`, [row.id])

    // S500: best-effort confirmation email. Skipped silently if customer
    // has no email; never throws.
    if (customer.email) {
      try {
        const biz = await queryOne<{ name: string }>(
          `SELECT name FROM businesses WHERE id = $1`, [businessId])
        if (biz?.name) {
          const { emailBusinessAppointmentConfirmed } = await import('../services/email')
          const fullName = `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim()
          const customerName = customer.company_name || fullName || null
          await emailBusinessAppointmentConfirmed({
            to:              customer.email,
            customerName,
            businessName:    biz.name,
            serviceType:     body.serviceType,
            scheduledFor:    new Date(body.scheduledFor),
            durationMinutes: body.durationMinutes ?? 30,
            notes:           body.notes ?? null,
            ctx: { businessId, appointmentId: row.id },
          })
        }
      } catch {/* logged at email-service layer */}
    }

    res.status(201).json({ success: true, data: full })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /  — list with date / customer / status filters
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  from:       z.string().datetime().optional(),
  to:         z.string().datetime().optional(),
  date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customerId: z.string().uuid().optional(),
  status:     z.enum(APPOINTMENT_STATUSES).optional(),
  limit:      z.coerce.number().int().positive().max(1000).optional(),
})

appointmentsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let whereSql = 'WHERE a.business_id = $1'

    if (q.date) {
      params.push(q.date)
      const i = params.length
      whereSql += ` AND a.scheduled_for >= $${i}::date
                    AND a.scheduled_for <  ($${i}::date + INTERVAL '1 day')`
    } else if (q.from || q.to) {
      if (q.from) {
        params.push(q.from)
        whereSql += ` AND a.scheduled_for >= $${params.length}`
      }
      if (q.to) {
        params.push(q.to)
        whereSql += ` AND a.scheduled_for <= $${params.length}`
      }
    }
    if (q.customerId) {
      params.push(q.customerId)
      whereSql += ` AND a.customer_id = $${params.length}`
    }
    if (q.status) {
      params.push(q.status)
      whereSql += ` AND a.status = $${params.length}`
    }

    params.push(q.limit ?? 200)
    const rows = await query<any>(
      `SELECT a.id, a.customer_id, a.service_type, a.scheduled_for,
              a.duration_minutes, a.status, a.notes,
              a.completed_at, a.cancelled_at, a.cancelled_reason,
              a.created_at, a.updated_at,
              c.first_name, c.last_name, c.company_name,
              c.street1, c.city, c.state, c.zip,
              c.lat, c.lon
         FROM appointments a
         JOIN business_customers c ON c.id = a.customer_id
         ${whereSql}
        ORDER BY a.scheduled_for ASC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id  — read one
// ═══════════════════════════════════════════════════════════════

appointmentsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const row = await queryOne<any>(
      `SELECT a.*,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name,
              c.street1, c.city, c.state, c.zip, c.lat, c.lon
         FROM appointments a
         JOIN business_customers c ON c.id = a.customer_id
        WHERE a.id = $1 AND a.business_id = $2`,
      [req.params.id, businessId])
    if (!row) throw new AppError(404, 'Appointment not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id  — reschedule / change service / edit notes
// ═══════════════════════════════════════════════════════════════

const patchSchema = z.object({
  serviceType:     z.string().min(1).optional(),
  scheduledFor:    z.string().datetime().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  notes:           z.string().nullable().optional(),
}).strict()

appointmentsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const patch = patchSchema.parse(req.body)
    if (Object.keys(patch).length === 0) {
      throw new AppError(400, 'Nothing to update')
    }
    // PATCH only on scheduled appointments — once completed/cancelled,
    // edit is via /complete or /cancel (which carry their own audit
    // stamps). Block rescheduling a cancelled appointment to avoid
    // accidental re-activation.
    const r = await query<{ id: string; status: string }>(
      `UPDATE appointments
          SET service_type     = COALESCE($1, service_type),
              scheduled_for    = COALESCE($2, scheduled_for),
              duration_minutes = COALESCE($3, duration_minutes),
              notes            = COALESCE($4, notes)
        WHERE id = $5 AND business_id = $6
          AND status = 'scheduled'
        RETURNING id, status`,
      [patch.serviceType     ?? null,
       patch.scheduledFor    ?? null,
       patch.durationMinutes ?? null,
       patch.notes           ?? null,
       req.params.id, businessId])
    if (r.length === 0) {
      // Either not found, wrong business, or already completed/cancelled
      // — generic 404 so we don't leak the distinction.
      throw new AppError(404, 'Appointment not found or no longer editable')
    }
    const full = await queryOne<any>(
      `SELECT * FROM appointments WHERE id = $1`, [r[0].id])
    res.json({ success: true, data: full })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/complete
// ═══════════════════════════════════════════════════════════════

appointmentsRouter.post('/:id/complete', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const r = await query<{ id: string; status: string; completed_at: string }>(
      `UPDATE appointments
          SET status = 'completed', completed_at = NOW()
        WHERE id = $1 AND business_id = $2 AND status = 'scheduled'
        RETURNING id, status, completed_at`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Appointment not found or already finalized')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/cancel
// ═══════════════════════════════════════════════════════════════

const cancelSchema = z.object({
  reason:    z.string().min(1).optional(),
  no_show:   z.boolean().optional(),
})

appointmentsRouter.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = cancelSchema.parse(req.body ?? {})
    const status = body.no_show ? 'no_show' : 'cancelled'
    const r = await query<{ id: string; status: string }>(
      `UPDATE appointments
          SET status           = $1,
              cancelled_at     = NOW(),
              cancelled_reason = $2
        WHERE id = $3 AND business_id = $4 AND status = 'scheduled'
        RETURNING id, status`,
      [status, body.reason ?? null, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Appointment not found or already finalized')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

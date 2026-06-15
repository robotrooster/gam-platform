/**
 * S460 / Phase 1a.2 — recurring-schedules CRUD.
 *
 * Six endpoints serving the template lifecycle:
 *
 *   POST   /api/recurring-schedules         (owner + staff)
 *   GET    /api/recurring-schedules         (owner + staff)
 *   GET    /api/recurring-schedules/:id     (owner + staff)
 *   PATCH  /api/recurring-schedules/:id     (owner + staff)
 *   POST   /api/recurring-schedules/:id/pause   (owner + staff)
 *   POST   /api/recurring-schedules/:id/resume  (owner + staff)
 *
 * RRULE validation happens at the route layer (RRule.fromString
 * throws on malformed input → caught → 400). A bad rrule never
 * lands in the table.
 *
 * Materializer (services/recurringScheduleMaterializer.ts) reads
 * these rows and generates appointment rows nightly. POST + status
 * transitions update last_materialized_at on the next cron run, NOT
 * synchronously here.
 */

import { Router } from 'express'
import { z } from 'zod'
import { RRule } from 'rrule'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { RECURRING_SCHEDULE_STATUSES } from '@gam/shared'

export const recurringSchedulesRouter = Router()

/** Resolve the businessId for any business-portal user (same shape
 *  as appointments.ts). Owners look up via businesses; staff use
 *  the JWT. */
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

/** Validate an RRULE string. Throws AppError(400) if malformed.
 *  We attach a DTSTART so the parser has full context — the actual
 *  start_date is set per-schedule and merged at materialization. */
function validateRrule(rrule: string) {
  try {
    RRule.fromString(`DTSTART:20260101T000000Z\nRRULE:${rrule}`)
  } catch (e: any) {
    throw new AppError(400, `Invalid RRULE: ${e?.message ?? 'parse failed'}`)
  }
}

// ═══════════════════════════════════════════════════════════════
//  POST /  — create
// ═══════════════════════════════════════════════════════════════

const createSchema = z.object({
  customerId:             z.string().uuid(),
  serviceType:            z.string().min(1),
  rrule:                  z.string().min(1),
  timeOfDay:              z.string().regex(/^[0-2]\d:[0-5]\d$/),
  startDate:              z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate:                z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  defaultDurationMinutes: z.number().int().positive().max(24 * 60).optional(),
  defaultNotes:           z.string().optional(),
})

recurringSchedulesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = createSchema.parse(req.body)
    validateRrule(body.rrule)

    const customer = await queryOne<{ id: string }>(
      `SELECT id FROM business_customers
        WHERE id = $1 AND business_id = $2 AND status = 'active'`,
      [body.customerId, businessId])
    if (!customer) throw new AppError(404, 'Customer not found')

    const [row] = await query<{ id: string }>(
      `INSERT INTO recurring_schedules
         (business_id, customer_id, created_by_user_id,
          service_type, rrule, time_of_day,
          start_date, end_date,
          default_duration_minutes, default_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [businessId, body.customerId, req.user!.userId,
       body.serviceType, body.rrule, body.timeOfDay,
       body.startDate, body.endDate ?? null,
       body.defaultDurationMinutes ?? 30,
       body.defaultNotes ?? null])

    const full = await queryOne<any>(
      `SELECT * FROM recurring_schedules WHERE id = $1`, [row.id])
    res.status(201).json({ success: true, data: full })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /  — list
// ═══════════════════════════════════════════════════════════════

const listSchema = z.object({
  status:     z.enum(RECURRING_SCHEDULE_STATUSES).optional(),
  customerId: z.string().uuid().optional(),
  limit:      z.coerce.number().int().positive().max(500).optional(),
})

recurringSchedulesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId]
    let whereSql = 'WHERE rs.business_id = $1'

    if (q.status) {
      params.push(q.status)
      whereSql += ` AND rs.status = $${params.length}`
    }
    if (q.customerId) {
      params.push(q.customerId)
      whereSql += ` AND rs.customer_id = $${params.length}`
    }

    params.push(q.limit ?? 100)
    const rows = await query<any>(
      `SELECT rs.id, rs.customer_id, rs.service_type,
              rs.rrule, rs.time_of_day,
              rs.start_date, rs.end_date,
              rs.default_duration_minutes, rs.default_notes,
              rs.status, rs.last_materialized_at,
              rs.created_at, rs.updated_at,
              c.first_name, c.last_name, c.company_name
         FROM recurring_schedules rs
         JOIN business_customers c ON c.id = rs.customer_id
         ${whereSql}
        ORDER BY rs.created_at DESC
        LIMIT $${params.length}`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id
// ═══════════════════════════════════════════════════════════════

recurringSchedulesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const row = await queryOne<any>(
      `SELECT rs.*,
              c.first_name AS customer_first_name,
              c.last_name  AS customer_last_name,
              c.company_name AS customer_company_name
         FROM recurring_schedules rs
         JOIN business_customers c ON c.id = rs.customer_id
        WHERE rs.id = $1 AND rs.business_id = $2`,
      [req.params.id, businessId])
    if (!row) throw new AppError(404, 'Schedule not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id
// ═══════════════════════════════════════════════════════════════

const patchSchema = z.object({
  serviceType:            z.string().min(1).optional(),
  rrule:                  z.string().min(1).optional(),
  timeOfDay:              z.string().regex(/^[0-2]\d:[0-5]\d$/).optional(),
  endDate:                z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  defaultDurationMinutes: z.number().int().positive().max(24 * 60).optional(),
  defaultNotes:           z.string().nullable().optional(),
}).strict()

recurringSchedulesRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const patch = patchSchema.parse(req.body)
    if (Object.keys(patch).length === 0) {
      throw new AppError(400, 'Nothing to update')
    }
    if (patch.rrule) validateRrule(patch.rrule)

    // PATCH on ended schedules is refused (terminal state). active +
    // paused are mutable; the pause/resume endpoints handle status
    // transitions specifically.
    const r = await query<{ id: string }>(
      `UPDATE recurring_schedules
          SET service_type             = COALESCE($1, service_type),
              rrule                    = COALESCE($2, rrule),
              time_of_day              = COALESCE($3, time_of_day),
              end_date                 = COALESCE($4, end_date),
              default_duration_minutes = COALESCE($5, default_duration_minutes),
              default_notes            = COALESCE($6, default_notes)
        WHERE id = $7 AND business_id = $8
          AND status <> 'ended'
        RETURNING id`,
      [patch.serviceType            ?? null,
       patch.rrule                  ?? null,
       patch.timeOfDay              ?? null,
       patch.endDate                ?? null,
       patch.defaultDurationMinutes ?? null,
       patch.defaultNotes           ?? null,
       req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Schedule not found or no longer editable')
    const full = await queryOne<any>(
      `SELECT * FROM recurring_schedules WHERE id = $1`, [r[0].id])
    res.json({ success: true, data: full })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/pause
// ═══════════════════════════════════════════════════════════════

const pauseSchema = z.object({
  reason: z.string().min(1).optional(),
})

recurringSchedulesRouter.post('/:id/pause', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const body = pauseSchema.parse(req.body ?? {})
    const r = await query<{ id: string; status: string }>(
      `UPDATE recurring_schedules
          SET status        = 'paused',
              paused_at     = NOW(),
              paused_reason = $1
        WHERE id = $2 AND business_id = $3 AND status = 'active'
        RETURNING id, status`,
      [body.reason ?? null, req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Schedule not found or not active')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/resume
// ═══════════════════════════════════════════════════════════════

recurringSchedulesRouter.post('/:id/resume', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireBusinessId(req)
    const r = await query<{ id: string; status: string }>(
      `UPDATE recurring_schedules
          SET status        = 'active',
              paused_at     = NULL,
              paused_reason = NULL
        WHERE id = $1 AND business_id = $2 AND status = 'paused'
        RETURNING id, status`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Schedule not found or not paused')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

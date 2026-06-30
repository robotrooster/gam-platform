/**
 * S507 — bookable services catalog (owner-side CRUD).
 *
 * Endpoints (owner-side, authenticated):
 *   POST   /api/business-bookable-services
 *   GET    /api/business-bookable-services
 *   GET    /api/business-bookable-services/:id
 *   PATCH  /api/business-bookable-services/:id
 *   DELETE /api/business-bookable-services/:id
 *
 * Each service has: name, description, duration_minutes, optional
 * price, is_active toggle, sort_order. The duration drives slot
 * computation on the public booking page.
 *
 * Permission: appointments.write (services are tied to the
 * appointments feature; if the business doesn't have appointments on,
 * the bookable catalog is meaningless).
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { requireBusinessAccess } from '../middleware/businessAccess'
import { BOOKABLE_SERVICE_RECURRENCES } from '@gam/shared'

export const businessBookableServicesRouter = Router()

const requireRead  = async (req: any) => (await requireBusinessAccess(req, { permission: 'appointments.read',  feature: 'appointments' })).businessId
const requireWrite = async (req: any) => (await requireBusinessAccess(req, { permission: 'appointments.write', feature: 'appointments' })).businessId

// ── Schemas ───────────────────────────────────────────────────

// S511: recurrence (owner-set cadence) + recurrence_day_of_week (owner-fixed day
// for recurring services). Pairing — one_time has no day; recurring needs one.
const recurrenceFields = {
  recurrence:          z.enum(BOOKABLE_SERVICE_RECURRENCES).optional(),
  recurrenceDayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
}
function checkRecurrencePairing(
  b: { recurrence?: string; recurrenceDayOfWeek?: number | null },
  ctx: z.RefinementCtx,
) {
  if (b.recurrence && b.recurrence !== 'one_time' && (b.recurrenceDayOfWeek === undefined || b.recurrenceDayOfWeek === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'recurrenceDayOfWeek is required for a recurring service', path: ['recurrenceDayOfWeek'] })
  }
  if (b.recurrence === 'one_time' && b.recurrenceDayOfWeek != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'one_time services cannot have a recurrenceDayOfWeek', path: ['recurrenceDayOfWeek'] })
  }
}

const createSchema = z.object({
  name:            z.string().min(1).max(120),
  description:     z.string().max(2000).nullable().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60),
  price:           z.number().min(0).max(1_000_000).nullable().optional(),
  sortOrder:       z.number().int().min(0).optional(),
  ...recurrenceFields,
}).superRefine(checkRecurrencePairing)

const patchSchema = z.object({
  name:            z.string().min(1).max(120).optional(),
  description:     z.string().max(2000).nullable().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  price:           z.number().min(0).max(1_000_000).nullable().optional(),
  sortOrder:       z.number().int().min(0).optional(),
  isActive:        z.boolean().optional(),
  ...recurrenceFields,
}).strict().superRefine(checkRecurrencePairing)

// ── POST / — create ──────────────────────────────────────────

businessBookableServicesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = createSchema.parse(req.body)
    const recurrence = body.recurrence ?? 'one_time'
    const recurrenceDow = recurrence === 'one_time' ? null : (body.recurrenceDayOfWeek ?? null)
    const r = await queryOne<any>(
      `INSERT INTO business_bookable_services
         (business_id, name, description, duration_minutes, price, sort_order,
          recurrence, recurrence_day_of_week)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [businessId, body.name.trim(),
       body.description?.trim() ?? null,
       body.durationMinutes,
       body.price ?? null,
       body.sortOrder ?? 0,
       recurrence, recurrenceDow])
    res.status(201).json({ success: true, data: r })
  } catch (e) { next(e) }
})

// ── GET / — list ─────────────────────────────────────────────

businessBookableServicesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const rows = await query<any>(
      `SELECT id, name, description, duration_minutes, price,
              is_active, sort_order, recurrence, recurrence_day_of_week,
              created_at, updated_at
         FROM business_bookable_services
        WHERE business_id = $1
        ORDER BY sort_order ASC, name ASC`,
      [businessId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── GET /:id — detail ────────────────────────────────────────

businessBookableServicesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const r = await queryOne<any>(
      `SELECT * FROM business_bookable_services
        WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!r) throw new AppError(404, 'Service not found')
    res.json({ success: true, data: r })
  } catch (e) { next(e) }
})

// ── PATCH /:id ────────────────────────────────────────────────

businessBookableServicesRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = patchSchema.parse(req.body)
    if (Object.keys(body).length === 0) throw new AppError(400, 'Nothing to update')
    // Recurrence + day move together: when recurrence is in the patch we set
    // both columns ($9 NULL means "not changing recurrence" → keep day). When
    // switching to one_time the day clears to NULL (COALESCE can't express that).
    const r = await query<any>(
      `UPDATE business_bookable_services
          SET name             = COALESCE($1, name),
              description      = COALESCE($2, description),
              duration_minutes = COALESCE($3, duration_minutes),
              price            = COALESCE($4, price),
              sort_order       = COALESCE($5, sort_order),
              is_active        = COALESCE($6, is_active),
              recurrence       = COALESCE($9, recurrence),
              recurrence_day_of_week = CASE
                WHEN $9 IS NULL              THEN recurrence_day_of_week
                WHEN $9 = 'one_time'         THEN NULL
                ELSE $10 END
        WHERE id = $7 AND business_id = $8
        RETURNING *`,
      [body.name?.trim() ?? null,
       body.description === undefined ? null : (body.description?.trim() ?? null),
       body.durationMinutes ?? null,
       body.price ?? null,
       body.sortOrder ?? null,
       body.isActive ?? null,
       req.params.id, businessId,
       body.recurrence ?? null,
       body.recurrenceDayOfWeek ?? null])
    if (r.length === 0) throw new AppError(404, 'Service not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

// ── DELETE /:id ───────────────────────────────────────────────

businessBookableServicesRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const r = await query<{ id: string }>(
      `DELETE FROM business_bookable_services
        WHERE id = $1 AND business_id = $2
        RETURNING id`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Service not found')
    res.json({ success: true, data: { id: r[0].id } })
  } catch (e) { next(e) }
})

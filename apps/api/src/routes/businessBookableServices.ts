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

export const businessBookableServicesRouter = Router()

const requireRead  = async (req: any) => (await requireBusinessAccess(req, { permission: 'appointments.read',  feature: 'appointments' })).businessId
const requireWrite = async (req: any) => (await requireBusinessAccess(req, { permission: 'appointments.write', feature: 'appointments' })).businessId

// ── Schemas ───────────────────────────────────────────────────

const createSchema = z.object({
  name:            z.string().min(1).max(120),
  description:     z.string().max(2000).nullable().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60),
  price:           z.number().min(0).max(1_000_000).nullable().optional(),
  sortOrder:       z.number().int().min(0).optional(),
})

const patchSchema = z.object({
  name:            z.string().min(1).max(120).optional(),
  description:     z.string().max(2000).nullable().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  price:           z.number().min(0).max(1_000_000).nullable().optional(),
  sortOrder:       z.number().int().min(0).optional(),
  isActive:        z.boolean().optional(),
}).strict()

// ── POST / — create ──────────────────────────────────────────

businessBookableServicesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireWrite(req)
    const body = createSchema.parse(req.body)
    const r = await queryOne<any>(
      `INSERT INTO business_bookable_services
         (business_id, name, description, duration_minutes, price, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [businessId, body.name.trim(),
       body.description?.trim() ?? null,
       body.durationMinutes,
       body.price ?? null,
       body.sortOrder ?? 0])
    res.status(201).json({ success: true, data: r })
  } catch (e) { next(e) }
})

// ── GET / — list ─────────────────────────────────────────────

businessBookableServicesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireRead(req)
    const rows = await query<any>(
      `SELECT id, name, description, duration_minutes, price,
              is_active, sort_order, created_at, updated_at
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
    const r = await query<any>(
      `UPDATE business_bookable_services
          SET name             = COALESCE($1, name),
              description      = COALESCE($2, description),
              duration_minutes = COALESCE($3, duration_minutes),
              price            = COALESCE($4, price),
              sort_order       = COALESCE($5, sort_order),
              is_active        = COALESCE($6, is_active)
        WHERE id = $7 AND business_id = $8
        RETURNING *`,
      [body.name?.trim() ?? null,
       body.description === undefined ? null : (body.description?.trim() ?? null),
       body.durationMinutes ?? null,
       body.price ?? null,
       body.sortOrder ?? null,
       body.isActive ?? null,
       req.params.id, businessId])
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

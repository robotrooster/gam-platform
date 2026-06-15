/**
 * S464 / Phase 1a.3 — vehicles CRUD.
 *
 * Owner-only. Each vehicle requires a home_depot_id pointing to a
 * depot in the same business — enforced at the route layer with a
 * cross-business check.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const vehiclesRouter = Router()

async function requireOwnerBusinessId(req: any): Promise<string> {
  if (req.user!.role !== 'business_owner') {
    throw new AppError(403, 'Only business owners can manage vehicles')
  }
  const biz = await queryOne<{ id: string }>(
    `SELECT id FROM businesses
      WHERE owner_user_id = $1 AND status IN ('active', 'suspended')
      ORDER BY created_at DESC LIMIT 1`,
    [req.user!.userId])
  if (!biz) throw new AppError(404, 'No active business for this owner')
  return biz.id
}

const createSchema = z.object({
  name:              z.string().min(1),
  homeDepotId:       z.string().uuid(),
  plateOrId:         z.string().optional(),
  stopsPerDump:      z.number().int().positive().max(1000).optional(),
  avgSpeedMph:       z.number().int().positive().max(150).optional(),
  avgServiceMinutes: z.number().int().positive().max(240).optional(),
  notes:             z.string().optional(),
})

vehiclesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const body = createSchema.parse(req.body)
    // Cross-business check on the home_depot_id.
    const depot = await queryOne<{ id: string }>(
      `SELECT id FROM depots
        WHERE id = $1 AND business_id = $2 AND status = 'active'`,
      [body.homeDepotId, businessId])
    if (!depot) throw new AppError(404, 'Home depot not found')

    const [row] = await query<{ id: string }>(
      `INSERT INTO vehicles
         (business_id, home_depot_id, name, plate_or_id,
          stops_per_dump, avg_speed_mph, avg_service_minutes, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [businessId, body.homeDepotId, body.name, body.plateOrId ?? null,
       body.stopsPerDump      ?? 50,
       body.avgSpeedMph       ?? 25,
       body.avgServiceMinutes ?? 3,
       body.notes             ?? null])
    const full = await queryOne<any>(`SELECT * FROM vehicles WHERE id = $1`, [row.id])
    res.status(201).json({ success: true, data: full })
  } catch (e) { next(e) }
})

const listSchema = z.object({
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  limit:  z.coerce.number().int().positive().max(500).optional(),
})

vehiclesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId, q.status ?? 'active']
    params.push(q.limit ?? 100)
    const rows = await query<any>(
      `SELECT v.*, d.name AS home_depot_name
         FROM vehicles v
         JOIN depots d ON d.id = v.home_depot_id
        WHERE v.business_id = $1 AND v.status = $2
        ORDER BY v.created_at DESC
        LIMIT $3`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

vehiclesRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const row = await queryOne<any>(
      `SELECT v.*, d.name AS home_depot_name
         FROM vehicles v JOIN depots d ON d.id = v.home_depot_id
        WHERE v.id = $1 AND v.business_id = $2`,
      [req.params.id, businessId])
    if (!row) throw new AppError(404, 'Vehicle not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

const patchSchema = z.object({
  name:              z.string().min(1).optional(),
  homeDepotId:       z.string().uuid().optional(),
  plateOrId:         z.string().nullable().optional(),
  stopsPerDump:      z.number().int().positive().max(1000).optional(),
  avgSpeedMph:       z.number().int().positive().max(150).optional(),
  avgServiceMinutes: z.number().int().positive().max(240).optional(),
  status:            z.enum(['active', 'inactive']).optional(),
  notes:             z.string().nullable().optional(),
}).strict()

vehiclesRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const patch = patchSchema.parse(req.body)
    if (Object.keys(patch).length === 0) throw new AppError(400, 'Nothing to update')
    if (patch.homeDepotId) {
      const depot = await queryOne<{ id: string }>(
        `SELECT id FROM depots
          WHERE id = $1 AND business_id = $2 AND status = 'active'`,
        [patch.homeDepotId, businessId])
      if (!depot) throw new AppError(404, 'Home depot not found')
    }
    const r = await query<{ id: string }>(
      `UPDATE vehicles
          SET name                = COALESCE($1, name),
              home_depot_id       = COALESCE($2, home_depot_id),
              plate_or_id         = COALESCE($3, plate_or_id),
              stops_per_dump      = COALESCE($4, stops_per_dump),
              avg_speed_mph       = COALESCE($5, avg_speed_mph),
              avg_service_minutes = COALESCE($6, avg_service_minutes),
              status              = COALESCE($7, status),
              notes               = COALESCE($8, notes)
        WHERE id = $9 AND business_id = $10 AND status <> 'archived'
        RETURNING id`,
      [patch.name              ?? null,
       patch.homeDepotId       ?? null,
       patch.plateOrId         ?? null,
       patch.stopsPerDump      ?? null,
       patch.avgSpeedMph       ?? null,
       patch.avgServiceMinutes ?? null,
       patch.status            ?? null,
       patch.notes             ?? null,
       req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Vehicle not found or archived')
    const full = await queryOne<any>(`SELECT * FROM vehicles WHERE id = $1`, [r[0].id])
    res.json({ success: true, data: full })
  } catch (e) { next(e) }
})

vehiclesRouter.post('/:id/archive', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const r = await query<{ id: string; status: string }>(
      `UPDATE vehicles SET status = 'archived'
        WHERE id = $1 AND business_id = $2 AND status <> 'archived'
        RETURNING id, status`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Vehicle not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

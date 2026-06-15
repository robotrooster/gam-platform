/**
 * S464 / Phase 1a.3 — dump_locations CRUD.
 *
 * Owner-only. Trash/waste businesses need at least one; other
 * business types (maintenance) may not have any — that's fine, the
 * optimizer handles empty dump lists.
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const dumpLocationsRouter = Router()

async function requireOwnerBusinessId(req: any): Promise<string> {
  if (req.user!.role !== 'business_owner') {
    throw new AppError(403, 'Only business owners can manage dump locations')
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
  name:                z.string().min(1),
  street1:             z.string().min(1),
  street2:             z.string().optional(),
  city:                z.string().min(1),
  state:               z.string().min(1),
  zip:                 z.string().min(1),
  lat:                 z.number(),
  lon:                 z.number(),
  typicalDumpMinutes:  z.number().int().positive().max(240).optional(),
  operatingHours:      z.string().optional(),
  notes:               z.string().optional(),
})

dumpLocationsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const body = createSchema.parse(req.body)
    const [row] = await query<{ id: string }>(
      `INSERT INTO dump_locations
         (business_id, name, street1, street2, city, state, zip,
          lat, lon, typical_dump_minutes, operating_hours, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [businessId, body.name, body.street1, body.street2 ?? null,
       body.city, body.state, body.zip, body.lat, body.lon,
       body.typicalDumpMinutes ?? 15,
       body.operatingHours     ?? null,
       body.notes              ?? null])
    const full = await queryOne<any>(`SELECT * FROM dump_locations WHERE id = $1`, [row.id])
    res.status(201).json({ success: true, data: full })
  } catch (e) { next(e) }
})

const listSchema = z.object({
  status: z.enum(['active', 'archived']).optional(),
  limit:  z.coerce.number().int().positive().max(500).optional(),
})

dumpLocationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const q = listSchema.parse(req.query)
    const params: any[] = [businessId, q.status ?? 'active']
    params.push(q.limit ?? 100)
    const rows = await query<any>(
      `SELECT * FROM dump_locations
        WHERE business_id = $1 AND status = $2
        ORDER BY created_at DESC
        LIMIT $3`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

dumpLocationsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const row = await queryOne<any>(
      `SELECT * FROM dump_locations WHERE id = $1 AND business_id = $2`,
      [req.params.id, businessId])
    if (!row) throw new AppError(404, 'Dump location not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

const patchSchema = z.object({
  name:                z.string().min(1).optional(),
  street1:             z.string().min(1).optional(),
  street2:             z.string().nullable().optional(),
  city:                z.string().min(1).optional(),
  state:               z.string().min(1).optional(),
  zip:                 z.string().min(1).optional(),
  lat:                 z.number().optional(),
  lon:                 z.number().optional(),
  typicalDumpMinutes:  z.number().int().positive().max(240).optional(),
  operatingHours:      z.string().nullable().optional(),
  notes:               z.string().nullable().optional(),
}).strict()

dumpLocationsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const patch = patchSchema.parse(req.body)
    if (Object.keys(patch).length === 0) throw new AppError(400, 'Nothing to update')
    const r = await query<{ id: string }>(
      `UPDATE dump_locations
          SET name                 = COALESCE($1,  name),
              street1              = COALESCE($2,  street1),
              street2              = COALESCE($3,  street2),
              city                 = COALESCE($4,  city),
              state                = COALESCE($5,  state),
              zip                  = COALESCE($6,  zip),
              lat                  = COALESCE($7,  lat),
              lon                  = COALESCE($8,  lon),
              typical_dump_minutes = COALESCE($9,  typical_dump_minutes),
              operating_hours      = COALESCE($10, operating_hours),
              notes                = COALESCE($11, notes)
        WHERE id = $12 AND business_id = $13
        RETURNING id`,
      [patch.name                ?? null,
       patch.street1             ?? null,
       patch.street2             ?? null,
       patch.city                ?? null,
       patch.state               ?? null,
       patch.zip                 ?? null,
       patch.lat                 ?? null,
       patch.lon                 ?? null,
       patch.typicalDumpMinutes  ?? null,
       patch.operatingHours      ?? null,
       patch.notes               ?? null,
       req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Dump location not found')
    const full = await queryOne<any>(`SELECT * FROM dump_locations WHERE id = $1`, [r[0].id])
    res.json({ success: true, data: full })
  } catch (e) { next(e) }
})

dumpLocationsRouter.post('/:id/archive', requireAuth, async (req, res, next) => {
  try {
    const businessId = await requireOwnerBusinessId(req)
    const r = await query<{ id: string; status: string }>(
      `UPDATE dump_locations SET status = 'archived'
        WHERE id = $1 AND business_id = $2 AND status <> 'archived'
        RETURNING id, status`,
      [req.params.id, businessId])
    if (r.length === 0) throw new AppError(404, 'Dump location not found')
    res.json({ success: true, data: r[0] })
  } catch (e) { next(e) }
})

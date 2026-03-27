import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const propertiesRouter = Router()
propertiesRouter.use(requireAuth)

propertiesRouter.get('/', async (req, res, next) => {
  try {
    const filter = req.user!.role !== 'admin' ? `WHERE p.landlord_id = '${req.user!.profileId}'` : ''
    const props = await query<any>(`
      SELECT p.*, COUNT(u.id)::int AS total_units,
        COUNT(u.id) FILTER (WHERE u.status='active')::int AS occupied_units,
        COUNT(u.id) FILTER (WHERE u.status='vacant')::int AS vacant_units
      FROM properties p LEFT JOIN units u ON u.property_id = p.id
      ${filter} GROUP BY p.id ORDER BY p.name`)
    res.json({ success: true, data: props })
  } catch (e) { next(e) }
})

propertiesRouter.post('/', requireLandlord, async (req, res, next) => {
  try {
    const body = z.object({
      name:    z.string().min(1),
      street1: z.string(), street2: z.string().optional(),
      city: z.string(), state: z.string().default('AZ'), zip: z.string(),
      type: z.enum(['residential','rv_longterm','rv_weekly','rv_nightly']).default('residential'),
    }).parse(req.body)
    const [prop] = await query<any>(`
      INSERT INTO properties (landlord_id,name,street1,street2,city,state,zip,type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user!.profileId,body.name,body.street1,body.street2??null,body.city,body.state,body.zip,body.type])
    res.status(201).json({ success: true, data: prop })
  } catch (e) { next(e) }
})

propertiesRouter.get('/:id', async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT * FROM properties WHERE id=$1`,[req.params.id])
    if (!p) throw new AppError(404,'Property not found')
    if (req.user!.role !== 'admin' && p.landlord_id !== req.user!.profileId) throw new AppError(403,'Forbidden')
    res.json({ success: true, data: p })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id
propertiesRouter.patch('/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { name, street1, street2, city, state, zip, type, description, amenities } = req.body
    const prop = await queryOne<any>('SELECT * FROM properties WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!prop) throw new AppError(404, 'Property not found')

    const updated = await queryOne<any>(`
      UPDATE properties SET
        name        = COALESCE($1, name),
        street1     = COALESCE($2, street1),
        street2     = COALESCE($3, street2),
        city        = COALESCE($4, city),
        state       = COALESCE($5, state),
        zip         = COALESCE($6, zip),
        type        = COALESCE($7, type),
        description = COALESCE($8, description),
        amenities   = COALESCE($9, amenities),
        updated_at  = NOW()
      WHERE id=$10 RETURNING *`,
      [name||null, street1||null, street2||null, city||null, state||null,
       zip||null, type||null, description||null,
       amenities ? JSON.stringify(amenities) : null, req.params.id]
    )
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

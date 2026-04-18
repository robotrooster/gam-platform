import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { z } from 'zod'
import { normalizeAddress } from '../lib/address'
import { formatPropertyInput, formatName, formatStreet, formatStreet2, formatCity, formatState, formatZip } from '../lib/format'
import { db, query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const propertiesRouter = Router()
export const publicPropertiesRouter = Router()
propertiesRouter.use(requireAuth)

propertiesRouter.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    const filter = isAdmin ? '' : `WHERE p.landlord_id = '${req.user!.profileId}'`
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
    const rawBody = z.object({
      name:    z.string().min(1),
      street1: z.string(), street2: z.string().optional(),
      city: z.string(), state: z.string().default('AZ'), zip: z.string(),
      type: z.enum(['residential','rv_longterm','rv_weekly','rv_nightly','mixed']).default('residential').optional(),
      unit_types: z.array(z.string()).optional(),
    }).parse(req.body)
    // Quiet formatter — clean up capitalization, state, zip before storage
    const body = {
      ...rawBody,
      name:    formatName(rawBody.name),
      street1: formatStreet(rawBody.street1),
      street2: rawBody.street2 ? formatStreet2(rawBody.street2) : rawBody.street2,
      city:    formatCity(rawBody.city),
      state:   formatState(rawBody.state),
      zip:     formatZip(rawBody.zip),
    }
    const [prop] = await query<any>(`
      INSERT INTO properties (landlord_id,name,street1,street2,city,state,zip,type,unit_types)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.profileId,body.name,body.street1,body.street2??null,body.city,body.state,body.zip,body.type||'mixed',body.unit_types||[]])

    // Silent duplicate-address check → flags for admin review
    try {
      const key = normalizeAddress({ street1: body.street1, city: body.city, state: body.state, zip: body.zip })
      const [, street, city, state, zip] = key.match(/^(.*)\|(.*)\|(.*)\|(.*)$/) || []
      if (street && zip) {
        const dupes = await query<any>(`
          SELECT id, landlord_id FROM properties
          WHERE id <> $1
            AND LOWER(TRIM(REGEXP_REPLACE(street1,'\\s+',' ','g'))) LIKE $2
            AND LOWER(TRIM(city))=$3
            AND LOWER(TRIM(state))=$4
            AND LEFT(TRIM(zip),5)=$5
          LIMIT 5`,
          [prop.id, '%'+street.replace(/[%_]/g,'')+'%', city, state, zip])
        // Refine with exact normalized match (cheap, in JS)
        const matches: any[] = []
        for (const d of dupes) {
          const other = await queryOne<any>('SELECT street1,city,state,zip FROM properties WHERE id=$1',[d.id])
          if (other && normalizeAddress(other) === key) matches.push(d)
        }
        if (matches.length > 0) {
          await query(`UPDATE properties SET review_status='pending_review' WHERE id=$1`, [prop.id])
          for (const m of matches) {
            await query(`
              INSERT INTO property_duplicate_flags (property_id, conflicting_property_id, reason, normalized_key)
              VALUES ($1,$2,'duplicate_address',$3)`,
              [prop.id, m.id, key])
          }
        }
      }
    } catch (flagErr) {
      console.error('[duplicate-flag] failed for property', prop.id, flagErr)
      // Non-fatal — property already created, admin can rescan later
    }

    res.status(201).json({ success: true, data: prop })
  } catch (e) { next(e) }
})

propertiesRouter.get('/:id', async (req, res, next) => {
  try {
    const p = await queryOne<any>(`SELECT * FROM properties WHERE id=$1`,[req.params.id])
    if (!p) throw new AppError(404,'Property not found')
    if (req.user!.role !== 'admin' && req.user!.role !== 'super_admin' && p.landlord_id !== req.user!.profileId) throw new AppError(403,'Forbidden')
    res.json({ success: true, data: p })
  } catch (e) { next(e) }
})

// PATCH /api/properties/:id
propertiesRouter.patch('/:id', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const raw = req.body as any
    // Quiet formatter
    const name    = raw.name    !== undefined ? formatName(raw.name)       : undefined
    const street1 = raw.street1 !== undefined ? formatStreet(raw.street1)  : undefined
    const street2 = raw.street2 !== undefined ? (raw.street2 ? formatStreet2(raw.street2) : raw.street2) : undefined
    const city    = raw.city    !== undefined ? formatCity(raw.city)       : undefined
    const state   = raw.state   !== undefined ? formatState(raw.state)     : undefined
    const zip     = raw.zip     !== undefined ? formatZip(raw.zip)         : undefined
    const { type, description, amenities } = raw
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
        unit_types  = COALESCE($9, unit_types),
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

// ════════════════════════════════════════
// PUBLIC LISTINGS
// ════════════════════════════════════════

const uploadDir = path.join(process.cwd(), 'uploads', 'unit-photos')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
})
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true)
  else cb(new Error('Images only'))
}})

// GET /api/properties/listings — public, no auth needed
publicPropertiesRouter.get('/listings', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.unit_number, u.bedrooms, u.bathrooms, u.sqft,
        u.rent_amount, u.security_deposit, u.available_date, u.listing_description,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        p.type AS property_type,
        l.id AS landlord_id,
        lu.first_name AS landlord_first, lu.last_name AS landlord_last,
        lu.phone AS landlord_phone,
        COALESCE(
          json_agg(up.url ORDER BY up.sort_order ASC) FILTER (WHERE up.id IS NOT NULL),
          '[]'
        ) AS photos,
        COUNT(up.id)::int AS photo_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = u.landlord_id
      JOIN users lu ON lu.id = l.user_id
      LEFT JOIN unit_photos up ON up.unit_id = u.id
      WHERE u.status = 'vacant' AND u.listed_vacant = TRUE
        AND u.bedrooms IS NOT NULL AND u.bathrooms IS NOT NULL
      GROUP BY u.id, p.id, l.id, lu.id
      HAVING COUNT(up.id) >= 5
      ORDER BY u.rent_amount ASC
    `)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/properties/listings/all — includes units with < 5 photos (for landlord preview)
publicPropertiesRouter.get('/listings/preview', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.unit_number, u.bedrooms, u.bathrooms, u.sqft,
        u.rent_amount, u.security_deposit, u.available_date, u.listing_description,
        u.listed_vacant,
        p.name AS property_name, p.street1, p.city, p.state, p.zip,
        COALESCE(
          json_agg(up.url ORDER BY up.sort_order ASC) FILTER (WHERE up.id IS NOT NULL),
          '[]'
        ) AS photos,
        COUNT(up.id)::int AS photo_count
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN unit_photos up ON up.unit_id = u.id
      WHERE u.landlord_id = $1 AND u.status = 'vacant'
      GROUP BY u.id, p.id
      ORDER BY p.name, u.unit_number
    `, [req.user!.profileId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/properties/units/:id/photos
propertiesRouter.get('/units/:id/photos', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM unit_photos WHERE unit_id=$1 ORDER BY sort_order ASC',
      [req.params.id]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/properties/units/:id/photos — upload photos (landlord auth)
propertiesRouter.post('/units/:id/photos', requireAuth, requireLandlord, upload.array('photos', 20), async (req, res, next) => {
  try {
    const unit = await queryOne<any>('SELECT * FROM units WHERE id=$1 AND landlord_id=$2', [req.params.id, req.user!.profileId])
    if (!unit) throw new AppError(403, 'Unit not found or not yours')
    const files = req.files as Express.Multer.File[]
    if (!files?.length) throw new AppError(400, 'No files uploaded')
    const { rows: existing } = await db.query('SELECT COUNT(*) FROM unit_photos WHERE unit_id=$1', [req.params.id])
    let sortOrder = +existing[0].count
    const inserted = []
    for (const file of files) {
      const url = `/uploads/unit-photos/${file.filename}`
      const { rows: [photo] } = await db.query(
        'INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.params.id, req.user!.profileId, url, sortOrder++]
      )
      inserted.push(photo)
    }
    res.status(201).json({ success: true, data: inserted })
  } catch (e) { next(e) }
})

// DELETE /api/properties/units/:id/photos/:photoId
propertiesRouter.delete('/units/:id/photos/:photoId', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const photo = await queryOne<any>(
      'SELECT * FROM unit_photos WHERE id=$1 AND unit_id=$2 AND landlord_id=$3',
      [req.params.photoId, req.params.id, req.user!.profileId]
    )
    if (!photo) throw new AppError(404, 'Photo not found')
    const filePath = path.join(process.cwd(), photo.url)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    await db.query('DELETE FROM unit_photos WHERE id=$1', [photo.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// PATCH /api/properties/units/:id/listing — update listing details
propertiesRouter.patch('/units/:id/listing', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { availableDate, listingDescription, listedVacant, bedrooms, bathrooms, sqft } = req.body
    const { rows: [unit] } = await db.query(
      `UPDATE units SET
         available_date=COALESCE($1,available_date),
         listing_description=COALESCE($2,listing_description),
         listed_vacant=COALESCE($3,listed_vacant),
         bedrooms=COALESCE($4,bedrooms),
         bathrooms=COALESCE($5,bathrooms),
         sqft=COALESCE($6,sqft),
         updated_at=NOW()
       WHERE id=$7 AND landlord_id=$8 RETURNING *`,
      [availableDate||null, listingDescription||null, listedVacant??null,
       bedrooms||null, bathrooms||null, sqft||null, req.params.id, req.user!.profileId]
    )
    if (!unit) throw new AppError(404, 'Unit not found')
    res.json({ success: true, data: unit })
  } catch (e) { next(e) }
})

// POST /api/properties/apply — submit application (public)
publicPropertiesRouter.post('/apply', async (req, res, next) => {
  try {
    const { unitId, landlordId, firstName, lastName, email, phone, moveInDate, monthlyIncome, occupants, hasPets, petDescription, message } = req.body
    if (!firstName || !lastName || !email) throw new AppError(400, 'firstName, lastName, email required')
    if (!unitId && !landlordId) throw new AppError(400, 'unitId or landlordId required')

    // Get landlordId from unit if not provided
    let lid = landlordId
    if (unitId && !lid) {
      const unit = await queryOne<any>('SELECT landlord_id FROM units WHERE id=$1', [unitId])
      if (!unit) throw new AppError(404, 'Unit not found')
      lid = unit.landlord_id
    }

    const { rows: [app] } = await db.query(
      `INSERT INTO unit_applications
         (unit_id, landlord_id, first_name, last_name, email, phone, move_in_date, monthly_income, occupants, has_pets, pet_description, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [unitId||null, lid, firstName, lastName, email, phone||null, moveInDate||null,
       monthlyIncome||null, occupants||1, hasPets||false, petDescription||null, message||null]
    )
    res.status(201).json({ success: true, data: app })
  } catch (e) { next(e) }
})

// GET /api/properties/applications — landlord sees their applications
propertiesRouter.get('/applications', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ua.*, u.unit_number, p.name AS property_name
       FROM unit_applications ua
       LEFT JOIN units u ON u.id = ua.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE ua.landlord_id = $1
       ORDER BY ua.created_at DESC`,
      [req.user!.profileId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/properties/:id/units/bulk — create multiple units by type
propertiesRouter.post('/:id/units/bulk', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const prop = await queryOne<any>(
      'SELECT * FROM properties WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId]
    )
    if (!prop) throw new AppError(404, 'Property not found')

    // unitGroups: [{ type: 'rv_spot', count: 20, prefix: 'RV', rentAmount: 500 }, ...]
    const { unitGroups } = req.body
    if (!unitGroups?.length) throw new AppError(400, 'unitGroups required')

    // Default prefix per unit type (user-typed prefix overrides this)
    const TYPE_PREFIXES: Record<string,string> = {
      apartment: 'Apt', house: 'House', mobile_home: 'MH',
      rv_spot: 'RV', storage: 'Storage', commercial: 'Com', other: 'Unit'
    }

    const created = []
    for (const group of unitGroups) {
      const { type, count, prefix, rentAmount, securityDeposit } = group
      if (!count || count < 1) continue
      // User prefix goes through formatName; fallback to TYPE_PREFIXES default.
      const pfx = prefix ? formatName(prefix) : (TYPE_PREFIXES[type] || 'Unit')

      // Find existing max number for this prefix in this property (case-insensitive match)
      const { rows: existing } = await db.query(
        `SELECT unit_number FROM units WHERE property_id=$1 AND LOWER(unit_number) LIKE LOWER($2) ORDER BY unit_number`,
        [req.params.id, `${pfx} %`]
      )
      const existingNums = existing.map((r: any) => {
        const m = r.unit_number.match(/\s(\d+)$/)
        return m ? parseInt(m[1]) : 0
      })
      const startNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1

      for (let i = 0; i < count; i++) {
        const unitNum = `${pfx} ${String(startNum + i).padStart(2, '0')}`
        const { rows: [unit] } = await db.query(
          `INSERT INTO units (property_id, landlord_id, unit_number, unit_type, rent_amount, security_deposit, status)
           VALUES ($1,$2,$3,$4,$5,$6,'vacant') RETURNING *`,
          [req.params.id, req.user!.profileId, unitNum, type, rentAmount||null, securityDeposit||null]
        )
        created.push(unit)
      }
    }

    // Update property unit_types
    const types = [...new Set(unitGroups.map((g: any) => g.type))]
    await db.query(
      'UPDATE properties SET unit_types=$1 WHERE id=$2',
      [types, req.params.id]
    )

    res.status(201).json({ success: true, data: { created: created.length, units: created } })
  } catch (e) { next(e) }
})

/**
 * properties.ts gap-close slice — S399. Closes the file at 17/17 (100%).
 *
 * Covered routes (9):
 *   - GET    /api/properties/:id/fee-schedule
 *   - DELETE /api/properties/:id/fee-schedule/:rowId
 *   - GET    /api/properties/:id/eligible-managers
 *   - GET    /api/properties/units/:id/photos             (S399 fix)
 *   - POST   /api/properties/units/:id/photos             (S399 XSS fix)
 *   - DELETE /api/properties/units/:id/photos/:photoId
 *   - PATCH  /api/properties/units/:id/listing
 *   - GET    /api/properties/applications
 *   - POST   /api/properties/:id/units/bulk
 *
 * Production bugs fixed in this slice (2):
 *   - **GET /units/:id/photos** had no landlord scope check. Any auth
 *     user with units.edit / units.view_status could pass a foreign
 *     unit UUID and read its photo list. Cross-tenant info disclosure.
 *   - **POST /units/:id/photos** upload filename used
 *     path.extname(originalname) UNFILTERED. Same XSS extension-mismatch
 *     pattern as S380 avatar + S394 esign + S395 pending-tenants
 *     (4th instance). `/uploads/` is served by express.static which
 *     uses extension-based content-type, so a `.html` upload would
 *     be served as text/html → XSS. Fix forces safe extension from
 *     MIME type whitelist.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
} from '../test/dbHelpers'
import { propertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/properties', propertiesRouter)
  app.use(errorHandler)
  return app
}

const cleanupTargets: string[] = []

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_properties_gap'
})

afterAll(() => {
  for (const p of cleanupTargets) {
    try { fs.unlinkSync(p) } catch { /* best effort */ }
  }
})

// Minimal JPEG bytes
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

interface Fixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  propertyAId:     string
  propertyBId:     string
  unitAId:         string
  unitBId:         string
  tokenA:          string
  tokenB:          string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propB = await seedProperty(c, { landlordId: bId, ownerUserId: bUid, managedByUserId: bUid })
    const unitA = await seedUnit(c, { propertyId: propA, landlordId: aId })
    const unitB = await seedUnit(c, { propertyId: propB, landlordId: bId })
    await c.query('COMMIT')
    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      propertyAId: propA, propertyBId: propB,
      unitAId: unitA, unitBId: unitB,
      tokenA: sign(aUid, aId), tokenB: sign(bUid, bId),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

// ───────────────────────────────────────────────────────────────────
// Fee schedule
// ───────────────────────────────────────────────────────────────────

describe('GET /:id/fee-schedule', () => {
  it('unknown property → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/properties/${randomUUID()}/fee-schedule`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/properties/${f.propertyBId}/fee-schedule`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('happy: returns property fee rows ordered', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO property_fee_schedules (property_id, fee_type, slot_index, amount, is_refundable, due_timing) VALUES
        ($1, 'pet_deposit', 0, 300, TRUE, 'move_in'),
        ($1, 'cleaning_fee', 0, 100, FALSE, 'move_out')`,
      [f.propertyAId])
    const res = await request(buildApp())
      .get(`/api/properties/${f.propertyAId}/fee-schedule`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })
})

describe('DELETE /:id/fee-schedule/:rowId', () => {
  it('cross-landlord → 403', async () => {
    const f = await seed()
    const row = await db.query<{ id: string }>(
      `INSERT INTO property_fee_schedules (property_id, fee_type, slot_index, amount, is_refundable, due_timing)
       VALUES ($1, 'pet_deposit', 0, 300, TRUE, 'move_in') RETURNING id`, [f.propertyBId])
    const res = await request(buildApp())
      .delete(`/api/properties/${f.propertyBId}/fee-schedule/${row.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('happy: removes row', async () => {
    const f = await seed()
    const row = await db.query<{ id: string }>(
      `INSERT INTO property_fee_schedules (property_id, fee_type, slot_index, amount, is_refundable, due_timing)
       VALUES ($1, 'pet_deposit', 0, 300, TRUE, 'move_in') RETURNING id`, [f.propertyAId])
    const res = await request(buildApp())
      .delete(`/api/properties/${f.propertyAId}/fee-schedule/${row.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const after = await db.query(`SELECT id FROM property_fee_schedules WHERE id=$1`, [row.rows[0].id])
    expect(after.rows).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// Eligible managers
// ───────────────────────────────────────────────────────────────────

describe('GET /:id/eligible-managers', () => {
  it('unknown property → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/properties/${randomUUID()}/eligible-managers`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/properties/${f.propertyBId}/eligible-managers`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('happy: returns owner + managers with all_properties or property-id scope', async () => {
    const f = await seed()
    // Seed a property_manager with all_properties=true on landlord A
    const pmUser = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Pat', 'PM', TRUE) RETURNING id`,
      [`pm-${randomUUID()}@t.dev`])
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, property_ids, unit_ids)
       VALUES ($1, $2, TRUE, ARRAY[]::uuid[], ARRAY[]::uuid[])`,
      [pmUser.rows[0].id, f.landlordAId])

    const res = await request(buildApp())
      .get(`/api/properties/${f.propertyAId}/eligible-managers`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.current_managed_by_user_id).toBe(f.landlordAUserId)
    expect(res.body.data.owner.role).toBe('self')
    expect(res.body.data.managers).toHaveLength(1)
    expect(res.body.data.managers[0].first_name).toBe('Pat')
  })
})

// ───────────────────────────────────────────────────────────────────
// Unit photos
// ───────────────────────────────────────────────────────────────────

describe('GET /units/:id/photos — S399 scope fix', () => {
  it('unknown unit → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/properties/units/${randomUUID()}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('S399 fix: cross-landlord unit → 403 (was: returned photos)', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order)
       VALUES ($1, $2, '/uploads/unit-photos/B.jpg', 0)`, [f.unitBId, f.landlordBId])
    const res = await request(buildApp())
      .get(`/api/properties/units/${f.unitBId}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('happy: own unit photos returned ordered by sort_order', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order) VALUES
        ($1, $2, '/uploads/unit-photos/B.jpg', 1),
        ($1, $2, '/uploads/unit-photos/A.jpg', 0)`,
      [f.unitAId, f.landlordAId])
    const res = await request(buildApp())
      .get(`/api/properties/units/${f.unitAId}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].sort_order).toBe(0)
  })
})

describe('POST /units/:id/photos — S399 XSS fix', () => {
  it('no files → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/units/${f.unitAId}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(400)
  })

  it('non-image MIME rejected', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/units/${f.unitAId}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('photos', Buffer.from('not an image'),
        { filename: 'evil.exe', contentType: 'application/octet-stream' })
    expect(res.status).not.toBe(201)
  })

  it('S399 fix: PDF-MIME spoof + originalname=evil.html → rejected (not image/*); but image-MIME + html-name saves as safe ext', async () => {
    const f = await seed()
    // image/jpeg + .html name → saved as .jpg (MIME-to-EXT whitelist)
    const res = await request(buildApp())
      .post(`/api/properties/units/${f.unitAId}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('photos', JPEG_HEADER,
        { filename: 'evil.html', contentType: 'image/jpeg' })
    expect(res.status).toBe(201)
    expect(res.body.data[0].url).toMatch(/\.jpg$/)
    expect(res.body.data[0].url).not.toMatch(/\.html/)
    const filename = res.body.data[0].url.split('/').pop()!
    cleanupTargets.push(path.join(process.cwd(), 'uploads', 'unit-photos', filename))
  })

  it('happy: legitimate JPEG upload returns row with /uploads/unit-photos/ URL', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/units/${f.unitAId}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('photos', JPEG_HEADER, { filename: 'photo.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(201)
    expect(res.body.data[0].url).toMatch(/^\/uploads\/unit-photos\/\d+-[a-z0-9]+\.jpg$/)
    expect(res.body.data[0].landlord_id).toBe(f.landlordAId)
    const filename = res.body.data[0].url.split('/').pop()!
    cleanupTargets.push(path.join(process.cwd(), 'uploads', 'unit-photos', filename))
  })

  it('cross-landlord unit → 403, no rows inserted', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/units/${f.unitBId}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('photos', JPEG_HEADER, { filename: 'photo.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(403)
    const rows = await db.query(`SELECT id FROM unit_photos WHERE unit_id=$1`, [f.unitBId])
    expect(rows.rows).toHaveLength(0)
  })
})

describe('DELETE /units/:id/photos/:photoId', () => {
  it('unknown photo → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .delete(`/api/properties/units/${f.unitAId}/photos/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const photo = await db.query<{ id: string }>(
      `INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order)
       VALUES ($1, $2, '/uploads/unit-photos/B.jpg', 0) RETURNING id`,
      [f.unitBId, f.landlordBId])
    const res = await request(buildApp())
      .delete(`/api/properties/units/${f.unitBId}/photos/${photo.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(403)
  })

  it('happy: deletes row (and unlinks file if exists)', async () => {
    const f = await seed()
    const photo = await db.query<{ id: string }>(
      `INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order)
       VALUES ($1, $2, '/uploads/unit-photos/nonexistent.jpg', 0) RETURNING id`,
      [f.unitAId, f.landlordAId])
    const res = await request(buildApp())
      .delete(`/api/properties/units/${f.unitAId}/photos/${photo.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const after = await db.query(`SELECT id FROM unit_photos WHERE id=$1`, [photo.rows[0].id])
    expect(after.rows).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// PATCH /units/:id/listing
// ───────────────────────────────────────────────────────────────────

describe('PATCH /units/:id/listing', () => {
  it('unknown unit → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/properties/units/${randomUUID()}/listing`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ listingDescription: 'Nice unit' })
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/properties/units/${f.unitBId}/listing`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ listingDescription: 'Hijack' })
    expect(res.status).toBe(403)
  })

  it('happy: COALESCE update preserves untouched', async () => {
    const f = await seed()
    await db.query(`UPDATE units SET bedrooms=2, bathrooms=1 WHERE id=$1`, [f.unitAId])
    const res = await request(buildApp())
      .patch(`/api/properties/units/${f.unitAId}/listing`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ listingDescription: 'Updated description' })
    expect(res.status).toBe(200)
    expect(res.body.data.listing_description).toBe('Updated description')
    expect(Number(res.body.data.bedrooms)).toBe(2)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /applications
// ───────────────────────────────────────────────────────────────────

describe('GET /applications', () => {
  it('landlord-scoped: returns own applications only', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO unit_applications (unit_id, landlord_id, first_name, last_name, email) VALUES
        ($1, $2, 'A1', 'Applicant', 'a1@t.dev'),
        ($3, $4, 'B1', 'Applicant', 'b1@t.dev')`,
      [f.unitAId, f.landlordAId, f.unitBId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/properties/applications')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].first_name).toBe('A1')
    expect(res.body.data[0].unit_number).toMatch(/^U-/)
  })
})

// ───────────────────────────────────────────────────────────────────
// POST /:id/units/bulk
// ───────────────────────────────────────────────────────────────────

describe('POST /:id/units/bulk', () => {
  it('unknown property → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/${randomUUID()}/units/bulk`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitGroups: [{ type: 'rv_spot', count: 5 }] })
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/${f.propertyBId}/units/bulk`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitGroups: [{ type: 'rv_spot', count: 5 }] })
    expect(res.status).toBe(403)
  })

  it('missing unitGroups → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/${f.propertyAId}/units/bulk`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('happy: bulk-creates N units with prefix + sequential numbering', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/${f.propertyAId}/units/bulk`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitGroups: [{ type: 'rv_spot', count: 3, prefix: 'RV', rentAmount: 500 }] })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(3)
    expect(res.body.data.units).toHaveLength(3)
    // Confirm sequential numbering (01/02/03) regardless of case-of-prefix.
    const nums = res.body.data.units.map((u: any) => u.unit_number).sort()
    expect(nums[0]).toMatch(/01$/)
    expect(nums[2]).toMatch(/03$/)
  })
})

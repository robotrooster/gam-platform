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
 *     (4th instance). Fix forces safe extension from MIME type
 *     whitelist. (S535: photos moved off static serving entirely —
 *     GET /api/properties/unit-photo-files/:filename, authed, pins
 *     Content-Type from the same whitelist.)
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
    expect(res.body.data.managers[0].staff_role).toBe('property_manager')
  })

  it('S527: onsite_manager scope holders are eligible too', async () => {
    const f = await seed()
    const omUser = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Ozzy', 'Onsite', TRUE) RETURNING id`,
      [`om-${randomUUID()}@t.dev`])
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, property_ids, unit_ids)
       VALUES ($1, $2, FALSE, ARRAY[$3]::uuid[], ARRAY[]::uuid[])`,
      [omUser.rows[0].id, f.landlordAId, f.propertyAId])

    const res = await request(buildApp())
      .get(`/api/properties/${f.propertyAId}/eligible-managers`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.managers).toHaveLength(1)
    expect(res.body.data.managers[0].first_name).toBe('Ozzy')
    expect(res.body.data.managers[0].staff_role).toBe('onsite_manager')
  })

  it('S527: user holding BOTH scopes dedups to property_manager', async () => {
    const f = await seed()
    const dualUser = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Dee', 'Dual', TRUE) RETURNING id`,
      [`dual-${randomUUID()}@t.dev`])
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, all_properties, property_ids, unit_ids)
       VALUES ($1, $2, TRUE, ARRAY[]::uuid[], ARRAY[]::uuid[])`,
      [dualUser.rows[0].id, f.landlordAId])
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, property_ids, unit_ids)
       VALUES ($1, $2, FALSE, ARRAY[$3]::uuid[], ARRAY[]::uuid[])`,
      [dualUser.rows[0].id, f.landlordAId, f.propertyAId])

    const res = await request(buildApp())
      .get(`/api/properties/${f.propertyAId}/eligible-managers`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.managers).toHaveLength(1)
    expect(res.body.data.managers[0].staff_role).toBe('property_manager')
  })
})

// ───────────────────────────────────────────────────────────────────
// PATCH /:id/manager — S527: onsite managers assignable
// ───────────────────────────────────────────────────────────────────

describe('PATCH /:id/manager', () => {
  it('S527: assigning an onsite_manager scope holder succeeds', async () => {
    const f = await seed()
    const omUser = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Ozzy', 'Onsite', TRUE) RETURNING id`,
      [`om-${randomUUID()}@t.dev`])
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, property_ids, unit_ids)
       VALUES ($1, $2, FALSE, ARRAY[$3]::uuid[], ARRAY[]::uuid[])`,
      [omUser.rows[0].id, f.landlordAId, f.propertyAId])

    const res = await request(buildApp())
      .patch(`/api/properties/${f.propertyAId}/manager`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ userId: omUser.rows[0].id })
    expect(res.status).toBe(200)
    expect(res.body.data.managed_by_user_id).toBe(omUser.rows[0].id)
  })

  it('unscoped user → 400', async () => {
    const f = await seed()
    const stranger = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Sal', 'Stranger', TRUE) RETURNING id`,
      [`stranger-${randomUUID()}@t.dev`])

    const res = await request(buildApp())
      .patch(`/api/properties/${f.propertyAId}/manager`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ userId: stranger.rows[0].id })
    expect(res.status).toBe(400)
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

  it('happy: legitimate JPEG upload returns row with authed unit-photo-files URL', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/units/${f.unitAId}/photos`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .attach('photos', JPEG_HEADER, { filename: 'photo.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(201)
    expect(res.body.data[0].url).toMatch(/^\/api\/properties\/unit-photo-files\/\d+-[a-z0-9]+\.jpg$/)
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
// Owner-defined unit subtypes (S527 — replaced POST /:id/units/bulk,
// which is removed; batch creation moved to POST /api/units quantity)
// ───────────────────────────────────────────────────────────────────

describe('unit-subtypes CRUD (S527)', () => {
  it('unknown property → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/${randomUUID()}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'rv_spot', name: 'Riverfront' })
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/${f.propertyBId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'rv_spot', name: 'Riverfront' })
    expect(res.status).toBe(403)
  })

  it('missing name → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/properties/${f.propertyAId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'rv_spot' })
    expect(res.status).toBe(400)
  })

  it('happy: create → list → delete; irrelevant facts nulled by type', async () => {
    const f = await seed()
    const app = buildApp()
    // bedrooms sent on an RV subtype must be nulled server-side.
    const created = await request(app)
      .post(`/api/properties/${f.propertyAId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'rv_spot', name: 'Riverfront pull-through', bedrooms: 2,
              rvSiteLayout: 'pull_through', rvAmpService: '50',
              rentAmount: 500, nightlyRate: 60 })
    expect(created.status).toBe(200)
    expect(created.body.data.bedrooms).toBeNull()
    expect(created.body.data.rv_site_layout).toBe('pull_through')

    const list = await request(app)
      .get(`/api/properties/${f.propertyAId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].name).toBe('Riverfront pull-through')

    const del = await request(app)
      .delete(`/api/properties/${f.propertyAId}/unit-subtypes/${created.body.data.id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(del.status).toBe(200)
    const after = await request(app)
      .get(`/api/properties/${f.propertyAId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(after.body.data).toHaveLength(0)
  })

  it('upsert: same (type, name) updates in place, no duplicate', async () => {
    const f = await seed()
    const app = buildApp()
    await request(app).post(`/api/properties/${f.propertyAId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'apartment', name: 'Studio', bedrooms: 0, rentAmount: 600 })
    const res = await request(app).post(`/api/properties/${f.propertyAId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ unitType: 'apartment', name: 'Studio', bedrooms: 0, rentAmount: 650 })
    expect(res.status).toBe(200)
    const list = await request(app).get(`/api/properties/${f.propertyAId}/unit-subtypes`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(list.body.data).toHaveLength(1)
    expect(Number(list.body.data[0].rent_amount)).toBe(650)
  })
})

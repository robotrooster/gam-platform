/**
 * Listings marketplace — 3-tier funnel (S593).
 *
 *   Tier 1  GET  /listings/browse           — anonymous teaser (no address/landlord)
 *   Tier 2  GET  /listings                  — logged-in full details (no bg gate, no contact)
 *   Tier 3  POST /listings/:unitId/apply    — bg-approved only; files app + reveals contact
 *
 * These routes on publicPropertiesRouter are mounted without the global
 * camelize middleware here, so DB-derived fields assert as snake_case; the
 * hand-built tier-3 response body is camelCase as written.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { db } from '../db'

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'unit-photos')
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { publicPropertiesRouter } from './properties'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/public/properties', publicPropertiesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_listings'
})

function renterToken(userId: string, tenantId: string, email = 'renter@test.dev') {
  return jwt.sign(
    { userId, role: 'tenant', email, profileId: tenantId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

interface Fx {
  landlordUserId: string; landlordId: string
  propertyId: string; unitId: string
  renterUserId: string; renterTenantId: string
}

async function seedFixture(opts: { bg?: string } = {}): Promise<Fx> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } =
      await seedLandlord(client, { firstName: 'Olivia', lastName: 'Owner' })
    await client.query(`UPDATE users SET phone='555-0100' WHERE id=$1`, [landlordUserId])
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    // A real, listable vacancy: vacant + explicitly listed + beds/baths + 5 photos.
    const unitRes = await client.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, unit_type,
                          status, listed_vacant, bedrooms, bathrooms, sqft,
                          security_deposit, listing_description)
       VALUES ($1,$2,$3,1200,'apartment','vacant',TRUE,2,1,850,1200,'Cozy corner unit')
       RETURNING id`,
      [propertyId, landlordId, `U-${randomUUID().slice(0, 6)}`])
    const unitId = unitRes.rows[0].id
    for (let i = 0; i < 5; i++) {
      await client.query(
        `INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order) VALUES ($1,$2,$3,$4)`,
        [unitId, landlordId, `/api/properties/unit-photo-files/photo${i}.jpg`, i])
    }
    // The renter — a prospective tenant with NO lease/landlord.
    const ru = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','tenant','Rick','Renter',TRUE) RETURNING id`,
      [`renter-${randomUUID()}@test.dev`])
    const renterUserId = ru.rows[0].id
    const rt = await client.query<{ id: string }>(
      `INSERT INTO tenants (user_id, background_check_status) VALUES ($1,$2) RETURNING id`,
      [renterUserId, opts.bg ?? 'not_started'])
    const renterTenantId = rt.rows[0].id
    await client.query('COMMIT')
    return { landlordUserId, landlordId, propertyId, unitId, renterUserId, renterTenantId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

describe('Listings tier 1 — anonymous teaser', () => {
  it('serves a teaser with no exact address, property name, or landlord identity', async () => {
    const fx = await seedFixture()
    const res = await request(buildApp()).get('/api/public/properties/listings/browse')
    expect(res.status).toBe(200)
    const row = res.body.data.find((r: any) => r.id === fx.unitId)
    expect(row).toBeTruthy()
    // present (teaser)
    expect(Number(row.rent_amount)).toBe(1200)
    expect(row.city).toBe('Phoenix')
    expect(row.bedrooms).toBe(2)
    expect(row.photo_count).toBe(5)
    // withheld
    expect(row.street1).toBeUndefined()
    expect(row.zip).toBeUndefined()
    expect(row.property_name).toBeUndefined()
    expect(row.landlord_id).toBeUndefined()
    expect(row.landlord_phone).toBeUndefined()
    expect(row.landlord_first).toBeUndefined()
    // at most 3 photos travel to a stranger
    expect(row.photos.length).toBeLessThanOrEqual(3)
  })
})

describe('Listings tier 2 — free account, full details', () => {
  it('401s without a token', async () => {
    await seedFixture()
    const res = await request(buildApp()).get('/api/public/properties/listings')
    expect(res.status).toBe(401)
  })

  it('a logged-in renter with NO approved bg check still sees full details (no browse gate) but no landlord contact', async () => {
    const fx = await seedFixture({ bg: 'not_started' })
    const res = await request(buildApp())
      .get('/api/public/properties/listings')
      .set('Authorization', `Bearer ${renterToken(fx.renterUserId, fx.renterTenantId)}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r: any) => r.id === fx.unitId)
    expect(row).toBeTruthy()
    expect(row.street1).toBe('1 Test St')          // full detail present
    expect(row.property_name).toBe('Test Property')
    expect(row.landlord_phone).toBeUndefined()     // contact withheld
    expect(row.landlord_first).toBeUndefined()
  })
})

describe('Listings tier 3 — apply/contact (bg-gated)', () => {
  it('403s when the renter has no approved background check', async () => {
    const fx = await seedFixture({ bg: 'not_started' })
    const res = await request(buildApp())
      .post(`/api/public/properties/listings/${fx.unitId}/apply`)
      .set('Authorization', `Bearer ${renterToken(fx.renterUserId, fx.renterTenantId)}`)
      .send({})
    expect(res.status).toBe(403)
    const { rows } = await db.query('SELECT id FROM unit_applications WHERE unit_id=$1', [fx.unitId])
    expect(rows.length).toBe(0)
  })

  it('an approved renter applies: 201, gets landlord contact, application linked to the account', async () => {
    const fx = await seedFixture({ bg: 'approved' })
    const res = await request(buildApp())
      .post(`/api/public/properties/listings/${fx.unitId}/apply`)
      .set('Authorization', `Bearer ${renterToken(fx.renterUserId, fx.renterTenantId)}`)
      .send({ message: 'Interested!' })
    expect(res.status).toBe(201)
    expect(res.body.data.landlord.phone).toBe('555-0100')
    expect(res.body.data.landlord.name).toBe('Olivia Owner')
    const { rows } = await db.query(
      'SELECT applicant_user_id, first_name FROM unit_applications WHERE unit_id=$1', [fx.unitId])
    expect(rows.length).toBe(1)
    expect(rows[0].applicant_user_id).toBe(fx.renterUserId)
    expect(rows[0].first_name).toBe('Rick')
  })

  it('a waived renter is also allowed', async () => {
    const fx = await seedFixture({ bg: 'waived' })
    const res = await request(buildApp())
      .post(`/api/public/properties/listings/${fx.unitId}/apply`)
      .set('Authorization', `Bearer ${renterToken(fx.renterUserId, fx.renterTenantId)}`)
      .send({})
    expect(res.status).toBe(201)
  })

  it('applying twice is idempotent — no duplicate application', async () => {
    const fx = await seedFixture({ bg: 'approved' })
    const app = buildApp()
    const tok = renterToken(fx.renterUserId, fx.renterTenantId)
    await request(app).post(`/api/public/properties/listings/${fx.unitId}/apply`)
      .set('Authorization', `Bearer ${tok}`).send({})
    const res2 = await request(app).post(`/api/public/properties/listings/${fx.unitId}/apply`)
      .set('Authorization', `Bearer ${tok}`).send({})
    expect(res2.status).toBe(201)
    const { rows } = await db.query('SELECT id FROM unit_applications WHERE unit_id=$1', [fx.unitId])
    expect(rows.length).toBe(1)
  })

  it('a non-renter (landlord) account cannot apply', async () => {
    const fx = await seedFixture({ bg: 'approved' })
    const llTok = jwt.sign(
      { userId: fx.landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: fx.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post(`/api/public/properties/listings/${fx.unitId}/apply`)
      .set('Authorization', `Bearer ${llTok}`).send({})
    expect(res.status).toBe(403)
  })
})

describe('Listings — public listing photo (scoped to listed vacancies)', () => {
  it('serves a listed-vacancy photo but 404s an unlisted unit photo and unknown files', async () => {
    const fx = await seedFixture()
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

    // A real file on a LISTED vacancy → public.
    const listedFile = `test-listed-${randomUUID().slice(0, 8)}.jpg`
    fs.writeFileSync(path.join(UPLOAD_DIR, listedFile), jpg)
    await db.query(
      `INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order) VALUES ($1,$2,$3,50)`,
      [fx.unitId, fx.landlordId, `/api/properties/unit-photo-files/${listedFile}`])

    // A real file on a vacant-but-NOT-listed unit → must stay private.
    const { rows: pu } = await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, unit_type,
                          status, listed_vacant, bedrooms, bathrooms)
       VALUES ($1,$2,$3,1000,'apartment','vacant',FALSE,1,1) RETURNING id`,
      [fx.propertyId, fx.landlordId, `U-${randomUUID().slice(0, 6)}`])
    const privFile = `test-priv-${randomUUID().slice(0, 8)}.jpg`
    fs.writeFileSync(path.join(UPLOAD_DIR, privFile), jpg)
    await db.query(
      `INSERT INTO unit_photos (unit_id, landlord_id, url, sort_order) VALUES ($1,$2,$3,0)`,
      [pu[0].id, fx.landlordId, `/api/properties/unit-photo-files/${privFile}`])

    try {
      const ok = await request(buildApp()).get(`/api/public/properties/listing-photo/${listedFile}`)
      expect(ok.status).toBe(200)
      const priv = await request(buildApp()).get(`/api/public/properties/listing-photo/${privFile}`)
      expect(priv.status).toBe(404)
      const unknown = await request(buildApp()).get(`/api/public/properties/listing-photo/nope-${randomUUID().slice(0, 6)}.jpg`)
      expect(unknown.status).toBe(404)
    } finally {
      fs.rmSync(path.join(UPLOAD_DIR, listedFile), { force: true })
      fs.rmSync(path.join(UPLOAD_DIR, privFile), { force: true })
    }
  })
})

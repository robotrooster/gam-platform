/**
 * S457 — routes/businessCustomers.ts coverage.
 *
 * Five endpoints, ~22 cases. No external mocks (no email, no Stripe).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

// S465: stub the geocoder to return null so the existing S457 tests
// don't make real HTTP calls to Nominatim. Behavior of the geocoder
// integration is covered separately in geocoderIntegration.test.ts.
vi.mock('../services/geocoder', () => ({
  geocode: vi.fn(async () => null),
}))

import { db } from '../db'
import { businessCustomersRouter } from './businessCustomers'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'
import {
  getOrCreateCustomerPortalToken,
  resolveCustomerPortalToken,
} from '../services/customerPortalTokens'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-customers', businessCustomersRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s457'
})

async function seedOwner(): Promise<{
  userId: string; businessId: string; token: string
}> {
  const password = 'super-strong-password-12!'
  const hash = await bcrypt.hash(password, 12)
  const email = `owner-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1, 'Hauling Co', 'trash_hauling', $2) RETURNING id`,
    [u.id, email])
  const token = jwt.sign(
    { userId: u.id, role: 'business_owner', email,
      profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId: u.id, businessId: b.id, token }
}

const validCustomer = (over: Record<string, any> = {}) => ({
  customerType: 'individual',
  firstName:    'Jane',
  lastName:     'Doe',
  email:        `c-${randomUUID()}@example.com`,
  phone:        '555-0100',
  street1:      '100 Elm',
  city:         'Phoenix',
  state:        'AZ',
  zip:          '85001',
  ...over,
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/business-customers — create
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-customers', () => {
  it('happy individual: 201 + full row, lat/lon null (geocoder lands later)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer())
    expect(res.status).toBe(201)
    expect(res.body.data.customer_type).toBe('individual')
    expect(res.body.data.first_name).toBe('Jane')
    expect(res.body.data.business_id).toBe(o.businessId)
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.lat).toBeNull()
    expect(res.body.data.lon).toBeNull()
  })

  it('happy business: companyName persists', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer({
        customerType: 'business', companyName: 'Acme Property Mgmt',
        firstName: 'Pat', lastName: 'Property',
      }))
    expect(res.status).toBe(201)
    expect(res.body.data.customer_type).toBe('business')
    expect(res.body.data.company_name).toBe('Acme Property Mgmt')
  })

  it('customerType=business without companyName → 400 (app-layer guard)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer({ customerType: 'business' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/companyName is required/i)
  })

  it('individual customer ignores companyName even if supplied', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer({ customerType: 'individual', companyName: 'ShouldDrop' }))
    expect(res.status).toBe(201)
    expect(res.body.data.company_name).toBeNull()
  })

  it('missing address (no street1) → 400', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer({ street1: undefined }))
    expect(res.status).toBe(400)
  })

  it('invalid email → 400', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer({ email: 'not-an-email' }))
    expect(res.status).toBe(400)
  })

  it('email omitted entirely is OK (nullable)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer({ email: undefined }))
    expect(res.status).toBe(201)
    expect(res.body.data.email).toBeNull()
  })

  it('non-owner role → 403', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'T', 'T') RETURNING id`,
      [`t-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'tenant', email: 't@t.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${token}`)
      .send(validCustomer())
    expect(res.status).toBe(403)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp())
      .post('/api/business-customers').send(validCustomer())
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /  — list
// ═══════════════════════════════════════════════════════════════

describe('GET /api/business-customers', () => {
  async function seedTwoCustomers(token: string): Promise<{ a: any; b: any }> {
    const a = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${token}`)
      .send(validCustomer({ firstName: 'Alpha' }))
    const b = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${token}`)
      .send(validCustomer({ firstName: 'Beta' }))
    return { a: a.body.data, b: b.body.data }
  }

  it('returns active customers by default', async () => {
    const o = await seedOwner()
    await seedTwoCustomers(o.token)
    const res = await request(buildApp())
      .get('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    for (const c of res.body.data) expect(c.status).toBe('active')
  })

  it('?status=archived returns only archived', async () => {
    const o = await seedOwner()
    const { a } = await seedTwoCustomers(o.token)
    await request(buildApp())
      .post(`/api/business-customers/${a.id}/archive`).set('Authorization', `Bearer ${o.token}`)
    const res = await request(buildApp())
      .get('/api/business-customers?status=archived')
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].id).toBe(a.id)
  })

  it('?q= narrows by name/company/email', async () => {
    const o = await seedOwner()
    await seedTwoCustomers(o.token)
    const res = await request(buildApp())
      .get('/api/business-customers?q=alpha').set('Authorization', `Bearer ${o.token}`)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].first_name).toBe('Alpha')
  })

  it('?q is case-insensitive', async () => {
    const o = await seedOwner()
    await seedTwoCustomers(o.token)
    const res = await request(buildApp())
      .get('/api/business-customers?q=ALPHA').set('Authorization', `Bearer ${o.token}`)
    expect(res.body.data).toHaveLength(1)
  })

  it('cross-business: other owner\'s customers not returned', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${b.token}`)
      .send(validCustomer({ firstName: 'ForB' }))
    const res = await request(buildApp())
      .get('/api/business-customers').set('Authorization', `Bearer ${a.token}`)
    expect(res.body.data).toHaveLength(0)
  })

  it('?limit caps the result count', async () => {
    const o = await seedOwner()
    for (let i = 0; i < 5; i++) {
      await request(buildApp())
        .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
        .send(validCustomer({ firstName: `C${i}` }))
    }
    const res = await request(buildApp())
      .get('/api/business-customers?limit=2').set('Authorization', `Bearer ${o.token}`)
    expect(res.body.data).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id  — read one
// ═══════════════════════════════════════════════════════════════

describe('GET /api/business-customers/:id', () => {
  it('happy: returns the row', async () => {
    const o = await seedOwner()
    const c = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer())
    const res = await request(buildApp())
      .get(`/api/business-customers/${c.body.data.id}`).set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(c.body.data.id)
  })

  it('cross-business: another owner\'s customer → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const c = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${b.token}`)
      .send(validCustomer())
    const res = await request(buildApp())
      .get(`/api/business-customers/${c.body.data.id}`).set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(404)
  })

  it('unknown id → 404', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .get(`/api/business-customers/${randomUUID()}`).set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id  — update
// ═══════════════════════════════════════════════════════════════

describe('PATCH /api/business-customers/:id', () => {
  async function seedOne(token: string, over: Record<string, any> = {}) {
    const c = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${token}`)
      .send(validCustomer(over))
    return c.body.data
  }

  it('happy multi-field update', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token, { phone: '555-1111', city: 'Mesa' })
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ phone: '555-9999', city: 'Tucson' })
    expect(res.status).toBe(200)
    expect(res.body.data.phone).toBe('555-9999')
    expect(res.body.data.city).toBe('Tucson')
  })

  it('COALESCE preserves omitted fields', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token, { phone: '555-1111', city: 'Mesa' })
    await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ city: 'Tucson' })
    const reread = await request(buildApp())
      .get(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
    expect(reread.body.data.phone).toBe('555-1111')
    expect(reread.body.data.city).toBe('Tucson')
  })

  it('empty patch → 400', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('unknown key (e.g. status) → 400 (strict schema)', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ status: 'archived' })
    expect(res.status).toBe(400)
  })

  it('changing customerType → business on an individual row without companyName → 400 (app-layer guard)', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token, { customerType: 'individual' })
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ customerType: 'business' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/companyName must be set/i)
  })

  it('changing customerType → business with companyName supplied succeeds', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token, { customerType: 'individual' })
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ customerType: 'business', companyName: 'Newly LLC' })
    expect(res.status).toBe(200)
    expect(res.body.data.customer_type).toBe('business')
    expect(res.body.data.company_name).toBe('Newly LLC')
  })

  it('cross-business: another owner\'s customer → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const c = await seedOne(b.token)
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${a.token}`)
      .send({ phone: '555-7777' })
    expect(res.status).toBe(404)
  })

  // S469 hygiene: manual lat/lon entry.
  it('happy manual lat/lon: both supplied → persisted as decimals', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ lat: 33.4484, lon: -112.0740 })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.lat)).toBeCloseTo(33.4484, 4)
    expect(Number(res.body.data.lon)).toBeCloseTo(-112.0740, 4)
  })

  it('lat without lon → 400 (both-or-neither)', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ lat: 33.5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/together/i)
  })

  it('lon without lat → 400 (both-or-neither)', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ lon: -112.07 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/together/i)
  })

  it('lat out of bounds (>90) → 400 (zod)', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ lat: 95, lon: -112 })
    expect(res.status).toBe(400)
  })

  it('lon out of bounds (<-180) → 400 (zod)', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ lat: 33, lon: -200 })
    expect(res.status).toBe(400)
  })

  it('both null → clears existing coords', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    // Pre-seed coords via PATCH so we have something to clear.
    await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ lat: 33.5, lon: -112.0 })
    const res = await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ lat: null, lon: null })
    expect(res.status).toBe(200)
    expect(res.body.data.lat).toBeNull()
    expect(res.body.data.lon).toBeNull()
  })

  it('omitting lat/lon preserves existing coords', async () => {
    const o = await seedOwner()
    const c = await seedOne(o.token)
    await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ lat: 33.5, lon: -112.0 })
    await request(buildApp())
      .patch(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
      .send({ phone: '555-2222' })  // unrelated update
    const reread = await request(buildApp())
      .get(`/api/business-customers/${c.id}`).set('Authorization', `Bearer ${o.token}`)
    expect(Number(reread.body.data.lat)).toBeCloseTo(33.5, 4)
    expect(Number(reread.body.data.lon)).toBeCloseTo(-112.0, 4)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/archive
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-customers/:id/archive', () => {
  it('flips status to archived + stamps archived_at', async () => {
    const o = await seedOwner()
    const c = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer())
    const res = await request(buildApp())
      .post(`/api/business-customers/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('archived')
    const { rows: [row] } = await db.query<any>(
      `SELECT archived_at FROM business_customers WHERE id=$1`,
      [c.body.data.id])
    expect(row.archived_at).not.toBeNull()
  })

  it('already archived → 404', async () => {
    const o = await seedOwner()
    const c = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer())
    await request(buildApp())
      .post(`/api/business-customers/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${o.token}`)
    const res = await request(buildApp())
      .post(`/api/business-customers/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(404)
  })

  it('cross-business: another owner\'s customer → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const c = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${b.token}`)
      .send(validCustomer())
    const res = await request(buildApp())
      .post(`/api/business-customers/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S515 (D) — POST /import : bulk CSV import
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-customers/import', () => {
  it('imports valid rows, reports invalid ones', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers/import')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ customers: [
        { firstName: 'Jane', lastName: 'Doe', street1: '1 Elm', city: 'Phoenix', state: 'AZ', zip: '85001', email: 'jane@x.com' },
        { firstName: 'Acme', lastName: 'Inc', companyName: 'Acme Inc', street1: '2 Oak', city: 'Mesa', state: 'AZ', zip: '85201' },
        { firstName: '', lastName: 'NoFirst', street1: '3 Pine', city: 'Tempe', state: 'AZ', zip: '85281' }, // invalid
        { firstName: 'NoAddr', lastName: 'X' }, // missing street/city/state/zip → invalid
      ] })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(2)
    expect(res.body.data.skipped).toBe(2)
    expect(res.body.data.total).toBe(4)
    expect(res.body.data.errors.length).toBe(2)

    // The business row was inferred from companyName.
    const { rows } = await db.query<{ customer_type: string }>(
      `SELECT customer_type FROM business_customers WHERE business_id = $1 AND company_name = 'Acme Inc'`,
      [o.businessId])
    expect(rows[0]?.customer_type).toBe('business')
  })

  it('empty email string is stored as null', async () => {
    const o = await seedOwner()
    await request(buildApp())
      .post('/api/business-customers/import')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ customers: [
        { firstName: 'No', lastName: 'Email', email: '', street1: '1 Elm', city: 'Phoenix', state: 'AZ', zip: '85001' },
      ] })
    const { rows } = await db.query<{ email: string | null }>(
      `SELECT email FROM business_customers WHERE business_id = $1`, [o.businessId])
    expect(rows[0]?.email).toBeNull()
  })

  it('rejects an empty array', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/business-customers/import')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ customers: [] })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/business-customers/:id/revoke-portal-access
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-customers/:id/revoke-portal-access', () => {
  async function makeCustomer(o: { token: string }): Promise<string> {
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.token}`)
      .send(validCustomer())
    return res.body.data.id
  }

  it('revokes a live link and the token then fails to resolve', async () => {
    const o = await seedOwner()
    const customerId = await makeCustomer(o)
    const { token } = await getOrCreateCustomerPortalToken({
      businessId: o.businessId, customerId })
    // Live before revoke.
    expect(await resolveCustomerPortalToken(token)).not.toBeNull()

    const res = await request(buildApp())
      .post(`/api/business-customers/${customerId}/revoke-portal-access`)
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.revoked).toBe(1)
    // Dead after revoke (fails closed).
    expect(await resolveCustomerPortalToken(token)).toBeNull()
  })

  it('is idempotent — revoking with no live link returns revoked:0', async () => {
    const o = await seedOwner()
    const customerId = await makeCustomer(o)
    const res = await request(buildApp())
      .post(`/api/business-customers/${customerId}/revoke-portal-access`)
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.revoked).toBe(0)
  })

  it("404s for another business's customer (no cross-tenant revoke)", async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const customerId = await makeCustomer(a)
    await getOrCreateCustomerPortalToken({ businessId: a.businessId, customerId })

    const res = await request(buildApp())
      .post(`/api/business-customers/${customerId}/revoke-portal-access`)
      .set('Authorization', `Bearer ${b.token}`)
    expect(res.status).toBe(404)
  })
})

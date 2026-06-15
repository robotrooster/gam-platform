/**
 * S455 — routes/businesses.ts coverage.
 *
 * Pins all 5 endpoints. The owner-signup path is the load-bearing one
 * (only way to create a business until S456 adds invitations), so it
 * gets the most cases. PATCH /me uses the COALESCE-preserves-omitted
 * pattern verified for /api/auth/me in S450; same pinning approach
 * here.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { businessesRouter } from './businesses'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/businesses', businessesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s455'
})

const validSignup = (over: Record<string, any> = {}) => ({
  businessName: 'Test Hauling Co',
  businessType: 'trash_hauling',
  firstName:    'Biz',
  lastName:     'Owner',
  email:        `signup-${randomUUID()}@example.com`,
  password:     'super-strong-password-12!',
  phone:        '555-9001',
  acceptedTerms: true,
  ...over,
})

async function seedOwner(opts: {
  businessName?: string
  businessType?: 'trash_hauling' | 'maintenance_crew' | 'mobile_rental' | 'equipment_rental' | 'mini_market' | 'mechanic_stationary' | 'mechanic_mobile' | 'other'
  ein?: string
} = {}): Promise<{
  userId: string; businessId: string; token: string; email: string
}> {
  const password = 'super-strong-password-12!'
  const hash = await bcrypt.hash(password, 12)
  const email = `owner-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  // S492: mirror the production POST signup behavior — apply default
  // feature set from the business_type catalog.
  const { BUSINESS_TYPE_DEFAULT_FEATURES } = await import('@gam/shared')
  const bt = opts.businessType ?? 'trash_hauling'
  const defaultFeatures = BUSINESS_TYPE_DEFAULT_FEATURES[bt] ?? []
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses
       (owner_user_id, name, business_type, email, ein, enabled_features)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [u.id,
     opts.businessName ?? 'Seeded Hauling',
     bt,
     email,
     opts.ein ?? null,
     defaultFeatures])
  const token = jwt.sign(
    { userId: u.id, role: 'business_owner', email,
      profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId: u.id, businessId: b.id, token, email }
}

async function seedAdmin(): Promise<{ userId: string; token: string }> {
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'admin', 'A', 'Dmin', TRUE) RETURNING id`,
    [`admin-${randomUUID()}@test.dev`])
  const token = jwt.sign(
    { userId: u.id, role: 'admin', email: 'a@a.dev', profileId: u.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId: u.id, token }
}

// ═══════════════════════════════════════════════════════════════
//  POST /api/businesses — owner self-signup
// ═══════════════════════════════════════════════════════════════

describe('POST /api/businesses', () => {
  it('happy: 201 + token + user + business; users row has role=business_owner + ToS stamps', async () => {
    const body = validSignup()
    const res = await request(buildApp())
      .post('/api/businesses').send(body)
    expect(res.status).toBe(201)
    expect(res.body.data.token).toEqual(expect.any(String))
    expect(res.body.data.user.role).toBe('business_owner')
    expect(res.body.data.user.businessId).toEqual(expect.any(String))
    expect(res.body.data.user.profileId).toBe(res.body.data.user.businessId)
    expect(res.body.data.business.name).toBe(body.businessName)
    expect(res.body.data.business.businessType).toBe('trash_hauling')
    expect(res.body.data.business.status).toBe('active')

    const { rows: [u] } = await db.query<any>(
      `SELECT role, accepted_tos_at, accepted_privacy_at FROM users WHERE email=$1`,
      [body.email])
    expect(u.role).toBe('business_owner')
    expect(u.accepted_tos_at).not.toBeNull()
    expect(u.accepted_privacy_at).not.toBeNull()
  })

  it('JWT carries businessId + staffRole=null', async () => {
    const body = validSignup()
    const res = await request(buildApp())
      .post('/api/businesses').send(body)
    const decoded = jwt.decode(res.body.data.token) as any
    expect(decoded.role).toBe('business_owner')
    expect(decoded.businessId).toBe(res.body.data.business.id)
    expect(decoded.staffRole).toBeNull()
    expect(decoded.profileId).toBe(decoded.businessId)
  })

  it('acceptedTerms missing → 400', async () => {
    const res = await request(buildApp())
      .post('/api/businesses').send(validSignup({ acceptedTerms: undefined }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Terms of Service/i)
  })

  it('acceptedTerms=false → 400', async () => {
    const res = await request(buildApp())
      .post('/api/businesses').send(validSignup({ acceptedTerms: false }))
    expect(res.status).toBe(400)
  })

  it('password under 12 chars → 400', async () => {
    const res = await request(buildApp())
      .post('/api/businesses').send(validSignup({ password: 'short-pw1' }))
    expect(res.status).toBe(400)
  })

  it('invalid businessType → 400 (zod enum)', async () => {
    const res = await request(buildApp())
      .post('/api/businesses').send(validSignup({ businessType: 'food_truck' }))
    expect(res.status).toBe(400)
  })

  it('disposable email → 400', async () => {
    const res = await request(buildApp())
      .post('/api/businesses').send(validSignup({ email: 'x@mailinator.com' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Disposable/i)
  })

  it('duplicate email (case-insensitive) → 409', async () => {
    const body = validSignup({ email: 'fixed@example.com' })
    await request(buildApp()).post('/api/businesses').send(body)
    const dup = await request(buildApp())
      .post('/api/businesses').send(validSignup({ email: 'FIXED@example.com' }))
    expect(dup.status).toBe(409)
    expect(dup.body.error).toMatch(/already exists/i)
  })

  it('email collision with an existing tenant account → 409 (cross-role isolation)', async () => {
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('shared@example.com', 'x', 'tenant', 'T', 'U')`)
    const res = await request(buildApp())
      .post('/api/businesses').send(validSignup({ email: 'shared@example.com' }))
    expect(res.status).toBe(409)
  })

  it('full address fields persist when supplied', async () => {
    const body = validSignup({
      street1: '123 Main', street2: 'Ste 4', city: 'Phoenix',
      state: 'AZ', zip: '85001', ein: '12-3456789',
    })
    const res = await request(buildApp())
      .post('/api/businesses').send(body)
    expect(res.status).toBe(201)
    const { rows: [b] } = await db.query<any>(
      `SELECT street1, street2, city, state, zip, ein FROM businesses
        WHERE id=$1`, [res.body.data.business.id])
    expect(b.street1).toBe('123 Main')
    expect(b.street2).toBe('Ste 4')
    expect(b.city).toBe('Phoenix')
    expect(b.state).toBe('AZ')
    expect(b.zip).toBe('85001')
    expect(b.ein).toBe('12-3456789')
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/businesses/me
// ═══════════════════════════════════════════════════════════════

describe('GET /api/businesses/me', () => {
  it('happy: returns full business shape for the owner', async () => {
    const o = await seedOwner({ ein: '99-9999999' })
    const res = await request(buildApp())
      .get('/api/businesses/me').set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(o.businessId)
    expect(res.body.data.owner_user_id).toBe(o.userId)
    expect(res.body.data.business_type).toBe('trash_hauling')
    expect(res.body.data.ein).toBe('99-9999999')
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.connect_payouts_enabled).toBe(false)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp()).get('/api/businesses/me')
    expect(res.status).toBe(401)
  })

  it('non-business_owner (landlord) → 403', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'landlord', 'L', 'L') RETURNING id`,
      [`ll-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'landlord', email: 'll@l.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/businesses/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('owner with no business row → 404', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'business_owner', 'No', 'Biz') RETURNING id`,
      [`nobiz-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'business_owner', email: 'n@n.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/businesses/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('archived business → 404 (filter excludes archived)', async () => {
    const o = await seedOwner()
    await db.query(`UPDATE businesses SET status='archived' WHERE id=$1`, [o.businessId])
    const res = await request(buildApp())
      .get('/api/businesses/me').set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(404)
  })

  it('suspended business → 200 (still visible to owner per filter)', async () => {
    const o = await seedOwner()
    await db.query(`UPDATE businesses SET status='suspended' WHERE id=$1`, [o.businessId])
    const res = await request(buildApp())
      .get('/api/businesses/me').set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('suspended')
  })
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /api/businesses/me
// ═══════════════════════════════════════════════════════════════

describe('PATCH /api/businesses/me', () => {
  it('updates businessName + city + phone (multi-field)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch('/api/businesses/me').set('Authorization', `Bearer ${o.token}`)
      .send({ businessName: 'New Co', city: 'Tucson', phone: '555-7777' })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('New Co')
    expect(res.body.data.city).toBe('Tucson')
    expect(res.body.data.phone).toBe('555-7777')
  })

  it('COALESCE: omitted fields preserve current values', async () => {
    const o = await seedOwner({ businessName: 'Initial' })
    // Seed phone + city first.
    await db.query(
      `UPDATE businesses SET phone='111-1111', city='Mesa' WHERE id=$1`,
      [o.businessId])
    // Patch only businessName; phone + city must NOT clear.
    const res = await request(buildApp())
      .patch('/api/businesses/me').set('Authorization', `Bearer ${o.token}`)
      .send({ businessName: 'Renamed' })
    expect(res.status).toBe(200)
    const { rows: [b] } = await db.query<any>(
      `SELECT name, phone, city FROM businesses WHERE id=$1`, [o.businessId])
    expect(b.name).toBe('Renamed')
    expect(b.phone).toBe('111-1111')
    expect(b.city).toBe('Mesa')
  })

  it('empty patch (no keys) → 400 "Nothing to update"', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch('/api/businesses/me').set('Authorization', `Bearer ${o.token}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Nothing to update/i)
  })

  it('invalid businessType → 400 (zod enum)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch('/api/businesses/me').set('Authorization', `Bearer ${o.token}`)
      .send({ businessType: 'food_truck' })
    expect(res.status).toBe(400)
  })

  it('unknown key (e.g. status) → 400 (strict schema)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch('/api/businesses/me').set('Authorization', `Bearer ${o.token}`)
      .send({ status: 'archived' })
    expect(res.status).toBe(400)
  })

  it('cannot mutate another owner\'s business (cross-owner isolation)', async () => {
    const a = await seedOwner({ businessName: 'A' })
    const b = await seedOwner({ businessName: 'B' })
    await request(buildApp())
      .patch('/api/businesses/me').set('Authorization', `Bearer ${a.token}`)
      .send({ businessName: 'Hacked' })
    const { rows: [other] } = await db.query<any>(
      `SELECT name FROM businesses WHERE id=$1`, [b.businessId])
    expect(other.name).toBe('B')   // unchanged
  })

  it('non-business_owner role → 403', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'T', 'T') RETURNING id`,
      [`t-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'tenant', email: 't@t.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .patch('/api/businesses/me').set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'X' })
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/businesses (admin list)
// ═══════════════════════════════════════════════════════════════

describe('GET /api/businesses', () => {
  it('admin: returns all businesses with owner_email joined', async () => {
    const adm = await seedAdmin()
    await seedOwner({ businessName: 'Co A' })
    await seedOwner({ businessName: 'Co B' })
    const res = await request(buildApp())
      .get('/api/businesses').set('Authorization', `Bearer ${adm.token}`)
    expect(res.status).toBe(200)
    const names = (res.body.data as any[]).map(r => r.name).sort()
    expect(names).toEqual(['Co A', 'Co B'])
    for (const row of res.body.data) {
      expect(row.owner_email).toEqual(expect.any(String))
      expect(row.owner_first_name).toBe('Biz')
    }
  })

  it('non-admin (business_owner) → 403', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .get('/api/businesses').set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(403)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp()).get('/api/businesses')
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /api/businesses/:id/status (admin)
// ═══════════════════════════════════════════════════════════════

describe('PATCH /api/businesses/:id/status', () => {
  it('admin flips active → suspended', async () => {
    const adm = await seedAdmin()
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch(`/api/businesses/${o.businessId}/status`)
      .set('Authorization', `Bearer ${adm.token}`)
      .send({ status: 'suspended' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('suspended')
  })

  it('admin flips active → archived', async () => {
    const adm = await seedAdmin()
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch(`/api/businesses/${o.businessId}/status`)
      .set('Authorization', `Bearer ${adm.token}`)
      .send({ status: 'archived' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('archived')
  })

  it('invalid status → 400 (zod enum)', async () => {
    const adm = await seedAdmin()
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch(`/api/businesses/${o.businessId}/status`)
      .set('Authorization', `Bearer ${adm.token}`)
      .send({ status: 'paused' })
    expect(res.status).toBe(400)
  })

  it('unknown business id → 404', async () => {
    const adm = await seedAdmin()
    const res = await request(buildApp())
      .patch(`/api/businesses/${randomUUID()}/status`)
      .set('Authorization', `Bearer ${adm.token}`)
      .send({ status: 'archived' })
    expect(res.status).toBe(404)
  })

  it('non-admin → 403', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch(`/api/businesses/${o.businessId}/status`)
      .set('Authorization', `Bearer ${o.token}`)
      .send({ status: 'suspended' })
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  S492: feature toggle infrastructure
// ═══════════════════════════════════════════════════════════════════

describe('S492 — POST signup applies BUSINESS_TYPE_DEFAULT_FEATURES', () => {
  it('trash_hauling → seeds {customers, staff, recurring_schedules, routing, invoicing, payments}', async () => {
    const body = validSignup({ businessType: 'trash_hauling' })
    const res = await request(buildApp())
      .post('/api/businesses').send(body)
    expect(res.status).toBe(201)
    const features: string[] = res.body.data.business.enabledFeatures
    expect(features.sort()).toEqual([
      'customers', 'invoicing', 'payments',
      'recurring_schedules', 'routing', 'staff',
    ].sort())
  })

  it('mini_market → seeds {customers, staff, pos, inventory, invoicing, payments}', async () => {
    const body = validSignup({ businessType: 'mini_market' })
    const res = await request(buildApp())
      .post('/api/businesses').send(body)
    expect(res.status).toBe(201)
    const features: string[] = res.body.data.business.enabledFeatures
    expect(features.sort()).toEqual([
      'customers', 'inventory', 'invoicing',
      'payments', 'pos', 'staff',
    ].sort())
  })

  it('mechanic_mobile → seeds full mechanic + routing kit', async () => {
    const body = validSignup({ businessType: 'mechanic_mobile' })
    const res = await request(buildApp())
      .post('/api/businesses').send(body)
    expect(res.status).toBe(201)
    const features: string[] = res.body.data.business.enabledFeatures
    expect(features).toContain('routing')
    expect(features).toContain('work_orders')
    expect(features).toContain('customer_vehicles')
    expect(features).toContain('inventory')
    expect(features).toContain('invoicing')
    expect(features).toContain('payments')
  })
})

describe('S492 — GET /api/businesses/me returns enabled_features', () => {
  it('happy: includes enabled_features array', async () => {
    const o = await seedOwner({ businessType: 'mini_market' })
    const res = await request(buildApp())
      .get('/api/businesses/me')
      .set('Authorization', `Bearer ${o.token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.enabled_features)).toBe(true)
    expect(res.body.data.enabled_features).toContain('pos')
    expect(res.body.data.enabled_features).toContain('inventory')
  })
})

describe('S492 — PATCH /api/businesses/me/features', () => {
  it('owner can toggle features on/off', async () => {
    const o = await seedOwner()
    // Turn ON appointments (not in trash_hauling defaults).
    const r1 = await request(buildApp())
      .patch('/api/businesses/me/features')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ enabledFeatures: ['recurring_schedules', 'routing', 'appointments', 'invoicing', 'payments'] })
    expect(r1.status).toBe(200)
    expect(r1.body.data.enabled_features).toContain('appointments')
    expect(r1.body.data.enabled_features).toContain('routing')
  })

  it('always-on features are re-added even if omitted', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch('/api/businesses/me/features')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ enabledFeatures: ['appointments'] })  // customers + staff omitted
    expect(res.status).toBe(200)
    expect(res.body.data.enabled_features).toContain('customers')
    expect(res.body.data.enabled_features).toContain('staff')
    expect(res.body.data.enabled_features).toContain('appointments')
  })

  it('unknown feature key → 400 (zod rejects)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .patch('/api/businesses/me/features')
      .set('Authorization', `Bearer ${o.token}`)
      .send({ enabledFeatures: ['not_a_real_feature'] })
    expect(res.status).toBe(400)
  })

  it('non-owner role → 403', async () => {
    const o = await seedOwner()
    // Mint a JWT with a tenant role.
    const tenantToken = jwt.sign(
      { userId: randomUUID(), role: 'tenant', email: 't@x.dev',
        profileId: randomUUID(), permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .patch('/api/businesses/me/features')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ enabledFeatures: ['customers', 'staff'] })
    expect(res.status).toBe(403)
    expect(o.businessId).toEqual(expect.any(String))
  })

  it('new business types accepted at signup', async () => {
    for (const bt of ['mini_market', 'mechanic_stationary', 'mechanic_mobile'] as const) {
      const body = validSignup({ businessType: bt })
      const res = await request(buildApp())
        .post('/api/businesses').send(body)
      expect(res.status).toBe(201)
      expect(res.body.data.business.businessType).toBe(bt)
    }
  })
})

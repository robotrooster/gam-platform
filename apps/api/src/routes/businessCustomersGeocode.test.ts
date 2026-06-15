/**
 * S465 — geocoder wiring on businessCustomers.
 *
 * Pins the integration: POST create auto-geocodes, POST /:id/geocode
 * backfills. Geocoder service is mocked at module level so tests are
 * deterministic.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

const { geocodeMock } = vi.hoisted(() => ({
  geocodeMock: vi.fn(async () => null as null | { lat: number; lon: number }),
}))
vi.mock('../services/geocoder', () => ({ geocode: geocodeMock }))

import { db } from '../db'
import { businessCustomersRouter } from './businessCustomers'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-customers', businessCustomersRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  geocodeMock.mockReset()
  geocodeMock.mockResolvedValue(null)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s465'
})

async function seedOwner(): Promise<{ ownerToken: string }> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1, 'Hauling Co', 'trash_hauling', $2) RETURNING id`,
    [u.id, email])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken }
}

const validCustomer = (over: Record<string, any> = {}) => ({
  customerType: 'individual',
  firstName:    'Jane',
  lastName:     'Doe',
  street1:      '100 Elm',
  city:         'Phoenix',
  state:        'AZ',
  zip:          '85001',
  ...over,
})

// ═══════════════════════════════════════════════════════════════
//  POST / — geocoder fires on create
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-customers — geocoder wiring', () => {
  it('geocoder returns coords → lat/lon persisted on the row', async () => {
    const o = await seedOwner()
    geocodeMock.mockResolvedValueOnce({ lat: 33.4484, lon: -112.0740 })
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validCustomer())
    expect(res.status).toBe(201)
    expect(Number(res.body.data.lat)).toBeCloseTo(33.4484, 4)
    expect(Number(res.body.data.lon)).toBeCloseTo(-112.0740, 4)
    expect(geocodeMock).toHaveBeenCalledTimes(1)
    // Geocoder receives the customer's address fields.
    const arg = (geocodeMock.mock.calls[0] as any[])[0]
    expect(arg.street1).toBe('100 Elm')
    expect(arg.city).toBe('Phoenix')
    expect(arg.state).toBe('AZ')
    expect(arg.zip).toBe('85001')
  })

  it('geocoder returns null → customer row created with lat/lon null', async () => {
    const o = await seedOwner()
    geocodeMock.mockResolvedValueOnce(null)
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validCustomer())
    expect(res.status).toBe(201)
    expect(res.body.data.lat).toBeNull()
    expect(res.body.data.lon).toBeNull()
  })

  it('geocoder hypothetically throwing should NOT fail the create (S469: route now wraps defensively)', async () => {
    const o = await seedOwner()
    // The service's geocode() catches everything internally and returns
    // null. S469 added a belt-and-suspenders try/catch on the route side
    // so a hypothetical contract slip still lets create succeed with
    // lat/lon=null.
    geocodeMock.mockRejectedValueOnce(new Error('hypothetical'))
    const res = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validCustomer())
    expect(res.status).toBe(201)
    expect(res.body.data.lat).toBeNull()
    expect(res.body.data.lon).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/geocode — backfill
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-customers/:id/geocode', () => {
  async function createWithoutCoords(token: string): Promise<string> {
    geocodeMock.mockResolvedValueOnce(null)
    const c = await request(buildApp())
      .post('/api/business-customers').set('Authorization', `Bearer ${token}`)
      .send(validCustomer())
    return c.body.data.id
  }

  it('happy backfill: returns coords + persists', async () => {
    const o = await seedOwner()
    const id = await createWithoutCoords(o.ownerToken)
    geocodeMock.mockResolvedValueOnce({ lat: 33.5, lon: -112.0 })
    const res = await request(buildApp())
      .post(`/api/business-customers/${id}/geocode`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.lat)).toBeCloseTo(33.5, 4)
    expect(Number(res.body.data.lon)).toBeCloseTo(-112.0, 4)
  })

  it('geocoder returns null → 422 with manual-entry hint', async () => {
    const o = await seedOwner()
    const id = await createWithoutCoords(o.ownerToken)
    geocodeMock.mockResolvedValueOnce(null)
    const res = await request(buildApp())
      .post(`/api/business-customers/${id}/geocode`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/could not be geocoded/i)
    expect(res.body.error).toMatch(/manually/i)
  })

  it('unknown customer id → 404', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post(`/api/business-customers/${randomUUID()}/geocode`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(404)
  })

  it('archived customer → 404 (status filter)', async () => {
    const o = await seedOwner()
    const id = await createWithoutCoords(o.ownerToken)
    await db.query(`UPDATE business_customers SET status='archived' WHERE id=$1`, [id])
    geocodeMock.mockResolvedValueOnce({ lat: 33, lon: -112 })
    const res = await request(buildApp())
      .post(`/api/business-customers/${id}/geocode`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(404)
  })

  it('cross-business → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const id = await createWithoutCoords(b.ownerToken)
    geocodeMock.mockResolvedValueOnce({ lat: 33, lon: -112 })
    const res = await request(buildApp())
      .post(`/api/business-customers/${id}/geocode`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

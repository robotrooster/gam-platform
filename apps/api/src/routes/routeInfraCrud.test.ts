/**
 * S464 — depots + vehicles + dump_locations CRUD.
 *
 * Three routes share the same shape; one test file covers all three
 * with focused happy + isolation + role-gate cases. Detailed validation
 * branches (every zod gate) are skipped — the pattern is identical to
 * the businessCustomers tests already pinning that behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { depotsRouter } from './depots'
import { vehiclesRouter } from './vehicles'
import { dumpLocationsRouter } from './dumpLocations'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/depots', depotsRouter)
  app.use('/api/vehicles', vehiclesRouter)
  app.use('/api/dump-locations', dumpLocationsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s464'
})

async function seedOwner(): Promise<{ ownerToken: string; businessId: string }> {
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
  const token = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken: token, businessId: b.id }
}

async function seedStaffToken(businessId: string): Promise<string> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_staff', 'S', 'T', TRUE) RETURNING id`,
    [`s-${randomUUID()}@test.dev`, hash])
  await db.query(
    `INSERT INTO business_users (business_id, user_id, staff_role, status)
     VALUES ($1, $2, 'dispatcher', 'active')`, [businessId, u.id])
  return jwt.sign(
    { userId: u.id, role: 'business_staff', email: 's@t.dev',
      profileId: businessId, businessId, staffRole: 'dispatcher' },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

const depotBody = (over: Record<string, any> = {}) => ({
  name: 'Main Yard', street1: '1 Yard Way', city: 'Phoenix', state: 'AZ',
  zip: '85001', lat: 33.4484, lon: -112.0740, ...over,
})

// ═══════════════════════════════════════════════════════════════
//  depots
// ═══════════════════════════════════════════════════════════════

describe('depots CRUD', () => {
  it('POST happy: 201 with full row', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(depotBody())
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Main Yard')
    expect(Number(res.body.data.lat)).toBeCloseTo(33.4484, 4)
    expect(res.body.data.status).toBe('active')
  })

  it('staff role → 403 (owner-only)', async () => {
    const o = await seedOwner()
    const staffToken = await seedStaffToken(o.businessId)
    const res = await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${staffToken}`)
      .send(depotBody())
    expect(res.status).toBe(403)
  })

  it('GET returns active depots; ?status=archived shows archived', async () => {
    const o = await seedOwner()
    const c1 = await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(depotBody({ name: 'A' }))
    await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(depotBody({ name: 'B' }))
    await request(buildApp())
      .post(`/api/depots/${c1.body.data.id}/archive`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    const active = await request(buildApp())
      .get('/api/depots').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(active.body.data).toHaveLength(1)
    expect(active.body.data[0].name).toBe('B')
    const arch = await request(buildApp())
      .get('/api/depots?status=archived').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(arch.body.data).toHaveLength(1)
    expect(arch.body.data[0].name).toBe('A')
  })

  it('PATCH: COALESCE preserves omitted fields', async () => {
    const o = await seedOwner()
    const c = await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(depotBody({ city: 'Mesa', notes: 'Old' }))
    await request(buildApp())
      .patch(`/api/depots/${c.body.data.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ city: 'Tucson' })
    const re = await request(buildApp())
      .get(`/api/depots/${c.body.data.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
    expect(re.body.data.city).toBe('Tucson')
    expect(re.body.data.notes).toBe('Old')
  })

  it('cross-business GET /:id → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const c = await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${b.ownerToken}`)
      .send(depotBody())
    const res = await request(buildApp())
      .get(`/api/depots/${c.body.data.id}`).set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })

  it('archive: status flips; double-archive 404', async () => {
    const o = await seedOwner()
    const c = await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(depotBody())
    const r1 = await request(buildApp())
      .post(`/api/depots/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(r1.body.data.status).toBe('archived')
    const r2 = await request(buildApp())
      .post(`/api/depots/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(r2.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  vehicles
// ═══════════════════════════════════════════════════════════════

describe('vehicles CRUD', () => {
  async function seedDepot(o: Awaited<ReturnType<typeof seedOwner>>): Promise<string> {
    const c = await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(depotBody())
    return c.body.data.id
  }

  it('POST happy with defaults', async () => {
    const o = await seedOwner()
    const depotId = await seedDepot(o)
    const res = await request(buildApp())
      .post('/api/vehicles').set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ name: 'Truck 1', homeDepotId: depotId })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Truck 1')
    expect(res.body.data.stops_per_dump).toBe(50)
    expect(res.body.data.avg_speed_mph).toBe(25)
  })

  it('POST: home_depot in different business → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const foreignDepot = await seedDepot(b)
    const res = await request(buildApp())
      .post('/api/vehicles').set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ name: 'Truck X', homeDepotId: foreignDepot })
    expect(res.status).toBe(404)
  })

  it('GET list includes home_depot_name', async () => {
    const o = await seedOwner()
    const depotId = await seedDepot(o)
    await request(buildApp())
      .post('/api/vehicles').set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ name: 'Truck 1', homeDepotId: depotId })
    const res = await request(buildApp())
      .get('/api/vehicles').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data[0].home_depot_name).toBe('Main Yard')
  })

  it('PATCH: change home_depot to another in-business depot succeeds', async () => {
    const o = await seedOwner()
    const d1 = await seedDepot(o)
    const d2c = await request(buildApp())
      .post('/api/depots').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(depotBody({ name: 'Yard 2' }))
    const v = await request(buildApp())
      .post('/api/vehicles').set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ name: 'T', homeDepotId: d1 })
    const res = await request(buildApp())
      .patch(`/api/vehicles/${v.body.data.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ homeDepotId: d2c.body.data.id })
    expect(res.status).toBe(200)
    expect(res.body.data.home_depot_id).toBe(d2c.body.data.id)
  })

  it('PATCH: change home_depot to foreign-business depot → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const aDepot = await seedDepot(a)
    const bDepot = await seedDepot(b)
    const v = await request(buildApp())
      .post('/api/vehicles').set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ name: 'T', homeDepotId: aDepot })
    const res = await request(buildApp())
      .patch(`/api/vehicles/${v.body.data.id}`).set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ homeDepotId: bDepot })
    expect(res.status).toBe(404)
  })

  it('PATCH status to inactive (e.g. truck in shop)', async () => {
    const o = await seedOwner()
    const depotId = await seedDepot(o)
    const v = await request(buildApp())
      .post('/api/vehicles').set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ name: 'T', homeDepotId: depotId })
    const res = await request(buildApp())
      .patch(`/api/vehicles/${v.body.data.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ status: 'inactive' })
    expect(res.body.data.status).toBe('inactive')
  })

  it('archive happy', async () => {
    const o = await seedOwner()
    const depotId = await seedDepot(o)
    const v = await request(buildApp())
      .post('/api/vehicles').set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ name: 'T', homeDepotId: depotId })
    const res = await request(buildApp())
      .post(`/api/vehicles/${v.body.data.id}/archive`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data.status).toBe('archived')
  })
})

// ═══════════════════════════════════════════════════════════════
//  dump_locations
// ═══════════════════════════════════════════════════════════════

describe('dump_locations CRUD', () => {
  const body = (over: Record<string, any> = {}) => ({
    name: 'Transfer Station', street1: '999 Dump', city: 'Phoenix',
    state: 'AZ', zip: '85003', lat: 33.49, lon: -112.05, ...over,
  })

  it('POST happy with default dump time', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/dump-locations').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(body())
    expect(res.status).toBe(201)
    expect(res.body.data.typical_dump_minutes).toBe(15)
  })

  it('POST with custom dump time persists', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/dump-locations').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(body({ typicalDumpMinutes: 30 }))
    expect(res.body.data.typical_dump_minutes).toBe(30)
  })

  it('cross-business GET → empty list', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    await request(buildApp())
      .post('/api/dump-locations').set('Authorization', `Bearer ${b.ownerToken}`)
      .send(body())
    const res = await request(buildApp())
      .get('/api/dump-locations').set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.body.data).toHaveLength(0)
  })

  it('PATCH operating_hours persists', async () => {
    const o = await seedOwner()
    const c = await request(buildApp())
      .post('/api/dump-locations').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(body())
    await request(buildApp())
      .patch(`/api/dump-locations/${c.body.data.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ operatingHours: '06:00-18:00 weekdays' })
    const re = await request(buildApp())
      .get(`/api/dump-locations/${c.body.data.id}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(re.body.data.operating_hours).toBe('06:00-18:00 weekdays')
  })

  it('archive', async () => {
    const o = await seedOwner()
    const c = await request(buildApp())
      .post('/api/dump-locations').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(body())
    const res = await request(buildApp())
      .post(`/api/dump-locations/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data.status).toBe('archived')
  })

  it('staff role → 403', async () => {
    const o = await seedOwner()
    const staffToken = await seedStaffToken(o.businessId)
    const res = await request(buildApp())
      .post('/api/dump-locations').set('Authorization', `Bearer ${staffToken}`)
      .send(body())
    expect(res.status).toBe(403)
  })
})

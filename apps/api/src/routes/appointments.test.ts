/**
 * S459 — routes/appointments.ts coverage.
 *
 * Six endpoints, ~30 cases. No external mocks. Exercises both
 * business_owner and business_staff auth paths (the helper
 * `requireBusinessId` handles them differently — owner via
 * businesses table query, staff via JWT.businessId).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

// S500: mock the appointment-confirm email helper so we can assert it
// fires + survives failures.
const { emailBusinessAppointmentConfirmedMock } = vi.hoisted(() => ({
  emailBusinessAppointmentConfirmedMock: vi.fn(async () => undefined),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessAppointmentConfirmed: emailBusinessAppointmentConfirmedMock }
})

import { db } from '../db'
import { appointmentsRouter } from './appointments'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/appointments', appointmentsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailBusinessAppointmentConfirmedMock.mockClear()
  emailBusinessAppointmentConfirmedMock.mockImplementation(async () => undefined)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s459'
})

async function seedOwner(): Promise<{
  ownerUserId: string; businessId: string; ownerToken: string; customerId: string
}> {
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
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe', '100 Elm', 'Phoenix', 'AZ', '85001')
     RETURNING id`, [b.id])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email,
      profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerUserId: u.id, businessId: b.id, ownerToken, customerId: c.id }
}

async function seedStaff(businessId: string): Promise<{ userId: string; token: string }> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `s-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_staff', 'S', 'Taff', TRUE) RETURNING id`,
    [email, hash])
  await db.query(
    `INSERT INTO business_users (business_id, user_id, staff_role, status)
     VALUES ($1, $2, 'dispatcher', 'active')`, [businessId, u.id])
  const token = jwt.sign(
    { userId: u.id, role: 'business_staff', email,
      profileId: businessId, businessId, staffRole: 'dispatcher' },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId: u.id, token }
}

const validBody = (over: Record<string, any> = {}) => ({
  customerId: '00000000-0000-0000-0000-000000000000', // overridden
  serviceType: 'Weekly trash pickup',
  scheduledFor: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  ...over,
})

// ═══════════════════════════════════════════════════════════════
//  POST /  — create
// ═══════════════════════════════════════════════════════════════

describe('POST /api/appointments', () => {
  it('happy (owner): 201 + full row with defaults', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('scheduled')
    expect(res.body.data.service_type).toBe('Weekly trash pickup')
    expect(res.body.data.duration_minutes).toBe(30)
    expect(res.body.data.business_id).toBe(o.businessId)
    expect(res.body.data.created_by_user_id).toBe(o.ownerUserId)
  })

  it('happy (staff): same business → 201', async () => {
    const o = await seedOwner()
    const s = await seedStaff(o.businessId)
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${s.token}`)
      .send(validBody({ customerId: o.customerId }))
    expect(res.status).toBe(201)
    expect(res.body.data.created_by_user_id).toBe(s.userId)
  })

  it('customer in different business → 404 (cross-business isolation)', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${a.ownerToken}`)
      .send(validBody({ customerId: b.customerId }))
    expect(res.status).toBe(404)
  })

  it('archived customer → 404', async () => {
    const o = await seedOwner()
    await db.query(`UPDATE business_customers SET status='archived' WHERE id=$1`, [o.customerId])
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    expect(res.status).toBe(404)
  })

  it('non-business role → 403', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'T', 'T') RETURNING id`,
      [`t-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'tenant', email: 't@t.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${token}`)
      .send(validBody())
    expect(res.status).toBe(403)
  })

  it('staff JWT without businessId → 403', async () => {
    const token = jwt.sign(
      { userId: randomUUID(), role: 'business_staff', email: 's@s.dev',
        profileId: randomUUID() },  // no businessId
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${token}`)
      .send(validBody())
    expect(res.status).toBe(403)
  })

  it('invalid scheduledFor (not ISO) → 400', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId, scheduledFor: 'tomorrow at 9' }))
    expect(res.status).toBe(400)
  })

  it('missing serviceType → 400', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId, serviceType: undefined }))
    expect(res.status).toBe(400)
  })

  it('custom durationMinutes persists', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId, durationMinutes: 90 }))
    expect(res.status).toBe(201)
    expect(res.body.data.duration_minutes).toBe(90)
  })

  it('no auth → 401', async () => {
    const res = await request(buildApp()).post('/api/appointments').send(validBody())
    expect(res.status).toBe(401)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /  — list
// ═══════════════════════════════════════════════════════════════

describe('GET /api/appointments', () => {
  async function seedOne(o: Awaited<ReturnType<typeof seedOwner>>, over: Record<string, any> = {}) {
    return request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId, ...over }))
      .then(r => r.body.data)
  }

  it('returns all for the business (default no filter)', async () => {
    const o = await seedOwner()
    await seedOne(o)
    await seedOne(o)
    const res = await request(buildApp())
      .get('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })

  it('?date filter narrows to one day', async () => {
    const o = await seedOwner()
    await seedOne(o, { scheduledFor: '2026-08-01T09:00:00Z' })
    await seedOne(o, { scheduledFor: '2026-08-02T09:00:00Z' })
    const res = await request(buildApp())
      .get('/api/appointments?date=2026-08-01').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data).toHaveLength(1)
    expect(new Date(res.body.data[0].scheduled_for).toISOString()).toBe('2026-08-01T09:00:00.000Z')
  })

  it('?from + ?to range filter', async () => {
    const o = await seedOwner()
    await seedOne(o, { scheduledFor: '2026-08-01T09:00:00Z' })
    await seedOne(o, { scheduledFor: '2026-08-05T09:00:00Z' })
    await seedOne(o, { scheduledFor: '2026-08-10T09:00:00Z' })
    const res = await request(buildApp())
      .get('/api/appointments?from=2026-08-03T00:00:00Z&to=2026-08-08T00:00:00Z')
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data).toHaveLength(1)
  })

  it('?customerId filter', async () => {
    const o = await seedOwner()
    const { rows: [c2] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers
         (business_id, customer_type, first_name, last_name,
          street1, city, state, zip)
       VALUES ($1, 'individual', 'Other', 'Person', '200 Oak', 'Mesa', 'AZ', '85201')
       RETURNING id`, [o.businessId])
    await seedOne(o, { customerId: o.customerId })
    await seedOne(o, { customerId: c2.id })
    const res = await request(buildApp())
      .get(`/api/appointments?customerId=${c2.id}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].customer_id).toBe(c2.id)
  })

  it('?status filter (cancelled rows return)', async () => {
    const o = await seedOwner()
    const a = await seedOne(o)
    await request(buildApp())
      .post(`/api/appointments/${a.id}/cancel`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ reason: 'rain' })
    await seedOne(o)  // still scheduled
    const res = await request(buildApp())
      .get('/api/appointments?status=cancelled').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].status).toBe('cancelled')
  })

  it('cross-business: other owner\'s appointments not returned', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    await seedOne(b)
    const res = await request(buildApp())
      .get('/api/appointments').set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.body.data).toHaveLength(0)
  })

  it('row shape includes customer JOIN fields for the route engine', async () => {
    const o = await seedOwner()
    await seedOne(o)
    const res = await request(buildApp())
      .get('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data[0]).toMatchObject({
      first_name: 'Jane',
      last_name:  'Doe',
      street1:    '100 Elm',
      city:       'Phoenix',
      state:      'AZ',
      zip:        '85001',
    })
    expect(res.body.data[0].lat).toBeNull()  // geocoder lands later
  })

  it('orders by scheduled_for ASC', async () => {
    const o = await seedOwner()
    await seedOne(o, { scheduledFor: '2026-08-10T09:00:00Z' })
    await seedOne(o, { scheduledFor: '2026-08-05T09:00:00Z' })
    await seedOne(o, { scheduledFor: '2026-08-15T09:00:00Z' })
    const res = await request(buildApp())
      .get('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
    const dates = res.body.data.map((r: any) => r.scheduled_for)
    expect(dates).toEqual([...dates].sort())
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id  — read
// ═══════════════════════════════════════════════════════════════

describe('GET /api/appointments/:id', () => {
  it('happy: returns with customer detail', async () => {
    const o = await seedOwner()
    const create = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    const res = await request(buildApp())
      .get(`/api/appointments/${create.body.data.id}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.customer_first_name).toBe('Jane')
    expect(res.body.data.customer_last_name).toBe('Doe')
  })

  it('cross-business → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const create = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${b.ownerToken}`)
      .send(validBody({ customerId: b.customerId }))
    const res = await request(buildApp())
      .get(`/api/appointments/${create.body.data.id}`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })

  it('unknown id → 404', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .get(`/api/appointments/${randomUUID()}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id
// ═══════════════════════════════════════════════════════════════

describe('PATCH /api/appointments/:id', () => {
  async function seedScheduled(o: Awaited<ReturnType<typeof seedOwner>>) {
    const create = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    return create.body.data
  }

  it('reschedule + change duration', async () => {
    const o = await seedOwner()
    const a = await seedScheduled(o)
    const newTime = '2026-09-01T14:30:00Z'
    const res = await request(buildApp())
      .patch(`/api/appointments/${a.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ scheduledFor: newTime, durationMinutes: 60 })
    expect(res.status).toBe(200)
    expect(res.body.data.duration_minutes).toBe(60)
  })

  it('empty patch → 400', async () => {
    const o = await seedOwner()
    const a = await seedScheduled(o)
    const res = await request(buildApp())
      .patch(`/api/appointments/${a.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('unknown key (e.g. status) → 400 (strict schema)', async () => {
    const o = await seedOwner()
    const a = await seedScheduled(o)
    const res = await request(buildApp())
      .patch(`/api/appointments/${a.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ status: 'completed' })
    expect(res.status).toBe(400)
  })

  it('PATCH on cancelled appointment → 404 (cannot reschedule a cancelled row)', async () => {
    const o = await seedOwner()
    const a = await seedScheduled(o)
    await request(buildApp())
      .post(`/api/appointments/${a.id}/cancel`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ reason: 'rain' })
    const res = await request(buildApp())
      .patch(`/api/appointments/${a.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ scheduledFor: '2026-09-01T10:00:00Z' })
    expect(res.status).toBe(404)
  })

  it('cross-business → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const apt = await seedScheduled(b)
    const res = await request(buildApp())
      .patch(`/api/appointments/${apt.id}`).set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ notes: 'hacked' })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/complete
// ═══════════════════════════════════════════════════════════════

describe('POST /api/appointments/:id/complete', () => {
  it('happy: scheduled → completed + completed_at stamped', async () => {
    const o = await seedOwner()
    const create = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    const res = await request(buildApp())
      .post(`/api/appointments/${create.body.data.id}/complete`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('completed')
    expect(res.body.data.completed_at).not.toBeNull()
  })

  it('double-complete → 404 (status filter blocks)', async () => {
    const o = await seedOwner()
    const create = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    await request(buildApp())
      .post(`/api/appointments/${create.body.data.id}/complete`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    const res = await request(buildApp())
      .post(`/api/appointments/${create.body.data.id}/complete`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/cancel
// ═══════════════════════════════════════════════════════════════

describe('POST /api/appointments/:id/cancel', () => {
  it('happy: scheduled → cancelled + cancelled_at + reason', async () => {
    const o = await seedOwner()
    const create = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    const res = await request(buildApp())
      .post(`/api/appointments/${create.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ reason: 'Customer not home' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('cancelled')

    const { rows: [row] } = await db.query<any>(
      `SELECT cancelled_at, cancelled_reason FROM appointments WHERE id=$1`,
      [create.body.data.id])
    expect(row.cancelled_at).not.toBeNull()
    expect(row.cancelled_reason).toBe('Customer not home')
  })

  it('no_show=true → status flips to "no_show"', async () => {
    const o = await seedOwner()
    const create = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    const res = await request(buildApp())
      .post(`/api/appointments/${create.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ no_show: true })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('no_show')
  })

  it('double-cancel → 404', async () => {
    const o = await seedOwner()
    const create = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    await request(buildApp())
      .post(`/api/appointments/${create.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({})
    const res = await request(buildApp())
      .post(`/api/appointments/${create.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S500 — appointment confirmation email
// ═══════════════════════════════════════════════════════════════

describe('POST /api/appointments — confirmation email (S500)', () => {
  it('fires emailBusinessAppointmentConfirmed when customer has email', async () => {
    const o = await seedOwner()
    await db.query(
      `UPDATE business_customers SET email = 'jane@x.dev' WHERE id = $1`,
      [o.customerId])
    await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    expect(emailBusinessAppointmentConfirmedMock).toHaveBeenCalledTimes(1)
    const arg = (emailBusinessAppointmentConfirmedMock.mock.calls as any[])[0][0]
    expect(arg.to).toBe('jane@x.dev')
    expect(arg.serviceType).toBe('Weekly trash pickup')
    expect(arg.durationMinutes).toBe(30)
    expect(arg.scheduledFor instanceof Date).toBe(true)
  })

  it('skips email when customer has no email', async () => {
    const o = await seedOwner()
    await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    expect(emailBusinessAppointmentConfirmedMock).not.toHaveBeenCalled()
  })

  it('email failure does NOT break the create', async () => {
    emailBusinessAppointmentConfirmedMock.mockImplementationOnce(async () => {
      throw new Error('resend down')
    })
    const o = await seedOwner()
    await db.query(
      `UPDATE business_customers SET email = 'jane@x.dev' WHERE id = $1`,
      [o.customerId])
    const res = await request(buildApp())
      .post('/api/appointments').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('scheduled')
  })
})

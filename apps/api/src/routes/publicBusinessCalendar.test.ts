/**
 * S511 — calendar sync: owner feed-URL endpoints + public ICS feed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessAppointmentConfirmed: vi.fn(async () => undefined) }
})

import { db } from '../db'
import { appointmentsRouter } from './appointments'
import { publicBusinessCalendarRouter } from './publicBusinessCalendar'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/appointments', appointmentsRouter)
  app.use('/api/public', publicBusinessCalendarRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s511'
  process.env.API_PUBLIC_URL = 'http://localhost:4000'
})

async function seed() {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`, [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1, 'Acme Hauling', 'trash_hauling', $2) RETURNING id`, [u.id, email])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name, street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe', '100 Elm', 'Mesa', 'AZ', '85201')
     RETURNING id`, [b.id])
  await db.query(
    `INSERT INTO appointments (business_id, customer_id, service_type, scheduled_for, duration_minutes, status)
     VALUES ($1, $2, 'Weekly trash pickup', NOW() + INTERVAL '2 days', 30, 'scheduled')`,
    [b.id, c.id])
  const token = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { businessId: b.id, ownerToken: token, customerId: c.id }
}

describe('GET /api/appointments/calendar-feed', () => {
  it('mints a token lazily and returns url + webcalUrl', async () => {
    const s = await seed()
    const res = await request(buildApp())
      .get('/api/appointments/calendar-feed')
      .set('Authorization', `Bearer ${s.ownerToken}`)
    expect(res.status).toBe(200)
    const { token, url, webcalUrl } = res.body.data
    expect(token).toMatch(/^[0-9a-f-]{36}$/i)
    expect(url).toBe(`http://localhost:4000/api/public/business-calendar/${token}.ics`)
    expect(webcalUrl).toBe(`webcal://localhost:4000/api/public/business-calendar/${token}.ics`)
    // Persisted on the business.
    const { rows: [b] } = await db.query<{ calendar_feed_token: string }>(
      `SELECT calendar_feed_token FROM businesses WHERE id = $1`, [s.businessId])
    expect(b.calendar_feed_token).toBe(token)
  })

  it('is stable across calls (same token)', async () => {
    const s = await seed()
    const a = await request(buildApp()).get('/api/appointments/calendar-feed')
      .set('Authorization', `Bearer ${s.ownerToken}`)
    const b = await request(buildApp()).get('/api/appointments/calendar-feed')
      .set('Authorization', `Bearer ${s.ownerToken}`)
    expect(a.body.data.token).toBe(b.body.data.token)
  })
})

describe('POST /api/appointments/calendar-feed/rotate', () => {
  it('rotates the token, revoking the old feed', async () => {
    const s = await seed()
    const before = await request(buildApp()).get('/api/appointments/calendar-feed')
      .set('Authorization', `Bearer ${s.ownerToken}`)
    const oldToken = before.body.data.token

    const rot = await request(buildApp()).post('/api/appointments/calendar-feed/rotate')
      .set('Authorization', `Bearer ${s.ownerToken}`)
    expect(rot.status).toBe(200)
    expect(rot.body.data.token).not.toBe(oldToken)

    // Old token now 404s on the public feed.
    const stale = await request(buildApp()).get(`/api/public/business-calendar/${oldToken}.ics`)
    expect(stale.status).toBe(404)
  })
})

describe('GET /api/public/business-calendar/:token.ics', () => {
  it('serves a text/calendar feed with the appointment', async () => {
    const s = await seed()
    const feed = await request(buildApp()).get('/api/appointments/calendar-feed')
      .set('Authorization', `Bearer ${s.ownerToken}`)
    const token = feed.body.data.token

    const res = await request(buildApp()).get(`/api/public/business-calendar/${token}.ics`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/calendar')
    expect(res.text).toContain('BEGIN:VCALENDAR')
    expect(res.text).toContain('SUMMARY:Weekly trash pickup — Jane Doe')
    expect(res.text).toContain('BEGIN:VEVENT')
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp())
      .get(`/api/public/business-calendar/${randomUUID()}.ics`)
    expect(res.status).toBe(404)
  })

  it('malformed token → 404 (no enumeration signal)', async () => {
    const res = await request(buildApp())
      .get('/api/public/business-calendar/not-a-uuid.ics')
    expect(res.status).toBe(404)
  })

  it('works without the .ics suffix too', async () => {
    const s = await seed()
    const feed = await request(buildApp()).get('/api/appointments/calendar-feed')
      .set('Authorization', `Bearer ${s.ownerToken}`)
    const res = await request(buildApp())
      .get(`/api/public/business-calendar/${feed.body.data.token}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('BEGIN:VCALENDAR')
  })
})

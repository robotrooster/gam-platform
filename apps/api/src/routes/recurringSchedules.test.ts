/**
 * S460 — routes/recurringSchedules.ts + the materializer service.
 *
 * Two test surfaces in one file:
 *   1. Routes — 6 endpoints (POST/GET/GET-by-id/PATCH/pause/resume)
 *   2. Materializer — services/recurringScheduleMaterializer.ts
 *      (computeOccurrences pure function + materializeAllSchedules
 *      side-effect function that hits the DB)
 *
 * Combined because they share the same fixture shape (a schedule
 * with a customer in a business) and exercise opposite ends of the
 * same lifecycle.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { recurringSchedulesRouter } from './recurringSchedules'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'
import {
  materializeAllSchedules,
  computeOccurrences,
} from '../services/recurringScheduleMaterializer'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/recurring-schedules', recurringSchedulesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s460'
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

const validBody = (over: Record<string, any> = {}) => ({
  customerId: '00000000-0000-0000-0000-000000000000', // overridden
  serviceType: 'Weekly trash pickup',
  rrule: 'FREQ=WEEKLY;BYDAY=TU',
  timeOfDay: '09:00',
  startDate: '2026-07-01',
  ...over,
})

// ═══════════════════════════════════════════════════════════════
//  POST /  — create
// ═══════════════════════════════════════════════════════════════

describe('POST /api/recurring-schedules', () => {
  it('happy: 201 with full row + defaults', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.service_type).toBe('Weekly trash pickup')
    expect(res.body.data.rrule).toBe('FREQ=WEEKLY;BYDAY=TU')
    expect(res.body.data.time_of_day).toBe('09:00')
    expect(res.body.data.default_duration_minutes).toBe(30)
    expect(res.body.data.business_id).toBe(o.businessId)
    expect(res.body.data.created_by_user_id).toBe(o.ownerUserId)
  })

  it('invalid rrule → 400 with "Invalid RRULE"', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId, rrule: 'NOT_A_VALID_RRULE' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid RRULE/i)
  })

  it('time_of_day in bad format → 400 (zod regex)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId, timeOfDay: '9am' }))
    expect(res.status).toBe(400)
  })

  it('end_date before start_date → 400 (CHECK constraint surfaced)', async () => {
    const o = await seedOwner()
    const res = await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({
        customerId: o.customerId,
        startDate: '2026-08-01', endDate: '2026-07-01',
      }))
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('customer in different business → 404', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    const res = await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${a.ownerToken}`)
      .send(validBody({ customerId: b.customerId }))
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /  — list
// ═══════════════════════════════════════════════════════════════

describe('GET /api/recurring-schedules', () => {
  it('returns scoped + customer JOIN fields', async () => {
    const o = await seedOwner()
    await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    const res = await request(buildApp())
      .get('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].first_name).toBe('Jane')
  })

  it('?status filter', async () => {
    const o = await seedOwner()
    const a = await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    await request(buildApp())
      .post(`/api/recurring-schedules/${a.body.data.id}/pause`)
      .set('Authorization', `Bearer ${o.ownerToken}`).send({})
    await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
    const res = await request(buildApp())
      .get('/api/recurring-schedules?status=paused').set('Authorization', `Bearer ${o.ownerToken}`)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].status).toBe('paused')
  })

  it('cross-business isolation', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    await request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${b.ownerToken}`)
      .send(validBody({ customerId: b.customerId }))
    const res = await request(buildApp())
      .get('/api/recurring-schedules').set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.body.data).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /:id
// ═══════════════════════════════════════════════════════════════

describe('PATCH /api/recurring-schedules/:id', () => {
  async function seedOne(o: Awaited<ReturnType<typeof seedOwner>>) {
    return request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
      .then(r => r.body.data)
  }

  it('updates rrule + time_of_day', async () => {
    const o = await seedOwner()
    const s = await seedOne(o)
    const res = await request(buildApp())
      .patch(`/api/recurring-schedules/${s.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ rrule: 'FREQ=WEEKLY;BYDAY=TH', timeOfDay: '14:30' })
    expect(res.status).toBe(200)
    expect(res.body.data.rrule).toBe('FREQ=WEEKLY;BYDAY=TH')
    expect(res.body.data.time_of_day).toBe('14:30')
  })

  it('invalid rrule on patch → 400', async () => {
    const o = await seedOwner()
    const s = await seedOne(o)
    const res = await request(buildApp())
      .patch(`/api/recurring-schedules/${s.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ rrule: 'XXX' })
    expect(res.status).toBe(400)
  })

  it('empty patch → 400', async () => {
    const o = await seedOwner()
    const s = await seedOne(o)
    const res = await request(buildApp())
      .patch(`/api/recurring-schedules/${s.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('unknown key (status) → 400 strict schema', async () => {
    const o = await seedOwner()
    const s = await seedOne(o)
    const res = await request(buildApp())
      .patch(`/api/recurring-schedules/${s.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ status: 'ended' })
    expect(res.status).toBe(400)
  })

  it('ended schedule → 404 (terminal)', async () => {
    const o = await seedOwner()
    const s = await seedOne(o)
    await db.query(`UPDATE recurring_schedules SET status='ended' WHERE id=$1`, [s.id])
    const res = await request(buildApp())
      .patch(`/api/recurring-schedules/${s.id}`).set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ rrule: 'FREQ=WEEKLY;BYDAY=MO' })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/pause + /:id/resume
// ═══════════════════════════════════════════════════════════════

describe('pause + resume', () => {
  async function seedActive(o: Awaited<ReturnType<typeof seedOwner>>) {
    return request(buildApp())
      .post('/api/recurring-schedules').set('Authorization', `Bearer ${o.ownerToken}`)
      .send(validBody({ customerId: o.customerId }))
      .then(r => r.body.data)
  }

  it('pause: active → paused + paused_at + reason', async () => {
    const o = await seedOwner()
    const s = await seedActive(o)
    const res = await request(buildApp())
      .post(`/api/recurring-schedules/${s.id}/pause`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ reason: 'Customer on vacation' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('paused')
    const { rows: [r] } = await db.query<any>(
      `SELECT paused_at, paused_reason FROM recurring_schedules WHERE id=$1`, [s.id])
    expect(r.paused_at).not.toBeNull()
    expect(r.paused_reason).toBe('Customer on vacation')
  })

  it('double-pause → 404 (status filter)', async () => {
    const o = await seedOwner()
    const s = await seedActive(o)
    await request(buildApp())
      .post(`/api/recurring-schedules/${s.id}/pause`)
      .set('Authorization', `Bearer ${o.ownerToken}`).send({})
    const res = await request(buildApp())
      .post(`/api/recurring-schedules/${s.id}/pause`)
      .set('Authorization', `Bearer ${o.ownerToken}`).send({})
    expect(res.status).toBe(404)
  })

  it('resume: paused → active + paused fields cleared', async () => {
    const o = await seedOwner()
    const s = await seedActive(o)
    await request(buildApp())
      .post(`/api/recurring-schedules/${s.id}/pause`)
      .set('Authorization', `Bearer ${o.ownerToken}`).send({ reason: 'r' })
    const res = await request(buildApp())
      .post(`/api/recurring-schedules/${s.id}/resume`)
      .set('Authorization', `Bearer ${o.ownerToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('active')
    const { rows: [r] } = await db.query<any>(
      `SELECT paused_at, paused_reason FROM recurring_schedules WHERE id=$1`, [s.id])
    expect(r.paused_at).toBeNull()
    expect(r.paused_reason).toBeNull()
  })

  it('resume on active schedule → 404', async () => {
    const o = await seedOwner()
    const s = await seedActive(o)
    const res = await request(buildApp())
      .post(`/api/recurring-schedules/${s.id}/resume`)
      .set('Authorization', `Bearer ${o.ownerToken}`).send({})
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  computeOccurrences (pure)
// ═══════════════════════════════════════════════════════════════

describe('computeOccurrences', () => {
  it('weekly Tuesday: returns Tuesdays in window', () => {
    // 2026-07-01 is a Wednesday; first Tuesday after is 2026-07-07.
    const dates = computeOccurrences({
      rrule:     'FREQ=WEEKLY;BYDAY=TU',
      timeOfDay: '09:00',
      startDate: '2026-07-01',
      endDate:   null,
      from:      new Date('2026-07-01T00:00:00Z'),
      to:        new Date('2026-07-31T23:59:59Z'),
    })
    // 4 Tuesdays in July 2026 (7, 14, 21, 28).
    expect(dates).toHaveLength(4)
    expect(dates[0].toISOString()).toBe('2026-07-07T09:00:00.000Z')
    expect(dates[1].toISOString()).toBe('2026-07-14T09:00:00.000Z')
  })

  it('respects end_date', () => {
    const dates = computeOccurrences({
      rrule:     'FREQ=WEEKLY;BYDAY=TU',
      timeOfDay: '09:00',
      startDate: '2026-07-01',
      endDate:   '2026-07-15',
      from:      new Date('2026-07-01T00:00:00Z'),
      to:        new Date('2026-07-31T23:59:59Z'),
    })
    // Only 7 + 14 fall within [2026-07-01, 2026-07-15].
    expect(dates).toHaveLength(2)
  })

  it('respects from-bound (no rows before window even if schedule started earlier)', () => {
    const dates = computeOccurrences({
      rrule:     'FREQ=WEEKLY;BYDAY=TU',
      timeOfDay: '09:00',
      startDate: '2026-01-01',
      endDate:   null,
      from:      new Date('2026-07-01T00:00:00Z'),
      to:        new Date('2026-07-31T23:59:59Z'),
    })
    expect(dates.every(d => d.getTime() >= new Date('2026-07-01T00:00:00Z').getTime())).toBe(true)
  })

  it('monthly on 15th: one occurrence per month', () => {
    const dates = computeOccurrences({
      rrule:     'FREQ=MONTHLY;BYMONTHDAY=15',
      timeOfDay: '08:00',
      startDate: '2026-07-01',
      endDate:   null,
      from:      new Date('2026-07-01T00:00:00Z'),
      to:        new Date('2026-09-30T23:59:59Z'),
    })
    // July 15, August 15, September 15.
    expect(dates).toHaveLength(3)
    expect(dates[0].toISOString().slice(0, 10)).toBe('2026-07-15')
  })

  it('time_of_day stamps the hour correctly', () => {
    const dates = computeOccurrences({
      rrule:     'FREQ=WEEKLY;BYDAY=TU',
      timeOfDay: '14:30',
      startDate: '2026-07-01',
      endDate:   null,
      from:      new Date('2026-07-01T00:00:00Z'),
      to:        new Date('2026-07-31T23:59:59Z'),
    })
    expect(dates[0].toISOString()).toBe('2026-07-07T14:30:00.000Z')
  })
})

// ═══════════════════════════════════════════════════════════════
//  materializeAllSchedules (side-effecting)
// ═══════════════════════════════════════════════════════════════

describe('materializeAllSchedules', () => {
  async function seedSchedule(opts: {
    customerId?: string
    rrule?: string
    timeOfDay?: string
    startDate?: string
    endDate?: string | null
    status?: 'active' | 'paused' | 'ended'
  } = {}): Promise<{ ownerSeed: Awaited<ReturnType<typeof seedOwner>>; scheduleId: string }> {
    const o = await seedOwner()
    const { rows: [s] } = await db.query<{ id: string }>(
      `INSERT INTO recurring_schedules
         (business_id, customer_id, service_type, rrule, time_of_day,
          start_date, end_date, status, paused_at)
       VALUES ($1, $2, 'Weekly trash', $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [o.businessId,
       opts.customerId ?? o.customerId,
       opts.rrule ?? 'FREQ=WEEKLY;BYDAY=TU',
       opts.timeOfDay ?? '09:00',
       opts.startDate ?? '2026-07-01',
       opts.endDate ?? null,
       opts.status ?? 'active',
       opts.status === 'paused' ? new Date() : null])
    return { ownerSeed: o, scheduleId: s.id }
  }

  it('creates appointments for active schedule in window', async () => {
    const { ownerSeed: o, scheduleId } = await seedSchedule()
    const r = await materializeAllSchedules(new Date('2026-07-01T00:00:00Z'), 60)
    expect(r.schedules_scanned).toBe(1)
    // 60-day window from July 1 → 9 weekly Tuesdays.
    expect(r.appointments_created).toBeGreaterThanOrEqual(8)
    expect(r.errors).toBe(0)

    const { rows } = await db.query<any>(
      `SELECT business_id, customer_id, recurring_schedule_id,
              service_type, duration_minutes, status
         FROM appointments WHERE recurring_schedule_id = $1
        ORDER BY scheduled_for`,
      [scheduleId])
    expect(rows.length).toBeGreaterThanOrEqual(8)
    for (const row of rows) {
      expect(row.business_id).toBe(o.businessId)
      expect(row.customer_id).toBe(o.customerId)
      expect(row.service_type).toBe('Weekly trash')
      expect(row.duration_minutes).toBe(30)
      expect(row.status).toBe('scheduled')
    }
  })

  it('idempotent: second run creates zero new appointments', async () => {
    await seedSchedule()
    const r1 = await materializeAllSchedules(new Date('2026-07-01T00:00:00Z'), 60)
    expect(r1.appointments_created).toBeGreaterThan(0)
    const r2 = await materializeAllSchedules(new Date('2026-07-01T00:00:00Z'), 60)
    expect(r2.appointments_created).toBe(0)   // ON CONFLICT DO NOTHING
  })

  it('skips paused schedules', async () => {
    await seedSchedule({ status: 'paused' })
    const r = await materializeAllSchedules(new Date('2026-07-01T00:00:00Z'), 60)
    expect(r.schedules_scanned).toBe(0)
    expect(r.appointments_created).toBe(0)
  })

  it('skips ended schedules', async () => {
    await seedSchedule({ status: 'ended' })
    const r = await materializeAllSchedules(new Date('2026-07-01T00:00:00Z'), 60)
    expect(r.schedules_scanned).toBe(0)
  })

  it('respects end_date — no rows after window cutoff', async () => {
    await seedSchedule({
      startDate: '2026-07-01', endDate: '2026-07-15',
    })
    const r = await materializeAllSchedules(new Date('2026-07-01T00:00:00Z'), 60)
    // 2 Tuesdays in [July 1, July 15]: 7 + 14.
    expect(r.appointments_created).toBe(2)
  })

  it('stamps last_materialized_at', async () => {
    const { scheduleId } = await seedSchedule()
    const now = new Date('2026-07-01T12:00:00Z')
    await materializeAllSchedules(now, 60)
    const { rows: [s] } = await db.query<any>(
      `SELECT last_materialized_at FROM recurring_schedules WHERE id=$1`,
      [scheduleId])
    expect(s.last_materialized_at).not.toBeNull()
  })

  it('multiple schedules under same business — each materializes', async () => {
    const o = await seedOwner()
    // Two schedules for the same business.
    await db.query(
      `INSERT INTO recurring_schedules
         (business_id, customer_id, service_type, rrule, time_of_day, start_date)
       VALUES ($1, $2, 'A', 'FREQ=WEEKLY;BYDAY=MO', '08:00', '2026-07-01'),
              ($1, $2, 'B', 'FREQ=WEEKLY;BYDAY=FR', '15:00', '2026-07-01')`,
      [o.businessId, o.customerId])
    const r = await materializeAllSchedules(new Date('2026-07-01T00:00:00Z'), 28)
    expect(r.schedules_scanned).toBe(2)
    // 4 Mondays + 4 Fridays in 28-day window.
    expect(r.appointments_created).toBe(8)
  })
})

/**
 * S507 — public self-service booking coverage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

// Mock the appointment-confirmation email so the route doesn't try to
// hit Resend. The booking endpoint also calls this for the owner —
// both calls share the same mock.
const { emailBusinessAppointmentConfirmedMock } = vi.hoisted(() => ({
  emailBusinessAppointmentConfirmedMock: vi.fn(async () => undefined),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessAppointmentConfirmed: emailBusinessAppointmentConfirmedMock }
})

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { publicBookingRouter } from './publicBooking'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/public', publicBookingRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailBusinessAppointmentConfirmedMock.mockClear()
  emailBusinessAppointmentConfirmedMock.mockImplementation(async () => undefined)
})

interface Fixture {
  businessId: string
  serviceId: string
  slug: string
}

async function seed(opts: {
  enabled?: boolean
  slug?: string
  hours?: any
  serviceMinutes?: number
  routing?: boolean
  vehicles?: boolean
  recurrence?: string
  recurrenceDow?: number
} = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('pw', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'B', 'O', TRUE) RETURNING id`,
    [email, hash])
  const slug = opts.slug ?? `shop-${randomUUID().slice(0, 6)}`
  const hoursJson = JSON.stringify(opts.hours ?? {
    '0': null,
    '1': { open: '09:00', close: '17:00' },
    '2': { open: '09:00', close: '17:00' },
    '3': { open: '09:00', close: '17:00' },
    '4': { open: '09:00', close: '17:00' },
    '5': { open: '09:00', close: '17:00' },
    '6': null,
  })
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses
       (owner_user_id, name, business_type, email, enabled_features,
        public_booking_enabled, public_booking_slug, public_booking_intro,
        business_hours, street1, city, state, zip)
     VALUES ($1, 'Test Shop', 'mechanic_stationary', $2,
             $6::text[],
             $3, $4, 'Welcome!', $5::jsonb,
             '100 Main', 'Phoenix', 'AZ', '85001')
     RETURNING id`,
    [u.id, email, opts.enabled ?? true, slug, hoursJson,
     ['customers', 'staff', 'appointments',
      ...(opts.routing ? ['routing'] : []),
      ...(opts.vehicles ? ['customer_vehicles'] : [])]])
  const recurrence = opts.recurrence ?? 'one_time'
  const recDow = recurrence === 'one_time' ? null : (opts.recurrenceDow ?? 2)
  const { rows: [s] } = await db.query<{ id: string }>(
    `INSERT INTO business_bookable_services
       (business_id, name, description, duration_minutes, price,
        recurrence, recurrence_day_of_week)
     VALUES ($1, 'Oil change', 'Standard oil + filter', $2, 79.99, $3, $4)
     RETURNING id`, [b.id, opts.serviceMinutes ?? 30, recurrence, recDow])
  return { businessId: b.id, serviceId: s.id, slug }
}

// ═══════════════════════════════════════════════════════════════
//  GET /booking/:slug
// ═══════════════════════════════════════════════════════════════

describe('GET /booking/:slug — public profile', () => {
  it('returns business + services when enabled', async () => {
    const f = await seed()
    const res = await request(buildApp()).get(`/api/public/booking/${f.slug}`)
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Test Shop')
    expect(res.body.data.intro).toBe('Welcome!')
    expect(res.body.data.services.length).toBe(1)
    expect(res.body.data.services[0].name).toBe('Oil change')
  })

  it('returns 404 when public_booking_enabled is false', async () => {
    const f = await seed({ enabled: false })
    const res = await request(buildApp()).get(`/api/public/booking/${f.slug}`)
    expect(res.status).toBe(404)
  })

  it('returns 404 for unknown slug', async () => {
    const res = await request(buildApp()).get('/api/public/booking/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('inactive services excluded', async () => {
    const f = await seed()
    await db.query(
      `UPDATE business_bookable_services SET is_active = FALSE WHERE id = $1`,
      [f.serviceId])
    const res = await request(buildApp()).get(`/api/public/booking/${f.slug}`)
    expect(res.body.data.services.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /availability
// ═══════════════════════════════════════════════════════════════

describe('GET /booking/:slug/availability', () => {
  it('returns 14 days of slots when no toDate supplied', async () => {
    const f = await seed()
    const today = new Date().toISOString().slice(0, 10)
    const res = await request(buildApp())
      .get(`/api/public/booking/${f.slug}/availability?serviceId=${f.serviceId}&fromDate=${today}`)
    expect(res.status).toBe(200)
    expect(res.body.data.days.length).toBe(14)
  })

  it('returns empty slots on closed days', async () => {
    const f = await seed({
      hours: {
        '0': null, '1': null, '2': null, '3': null, '4': null, '5': null, '6': null,
      },
    })
    const today = new Date().toISOString().slice(0, 10)
    const res = await request(buildApp())
      .get(`/api/public/booking/${f.slug}/availability?serviceId=${f.serviceId}&fromDate=${today}`)
    expect(res.body.data.days.every((d: any) => d.slots.length === 0)).toBe(true)
  })

  it('existing scheduled appointment blocks its slot', async () => {
    const f = await seed({ serviceMinutes: 30 })
    // Pick a Monday two weeks out at 10:00 (well clear of "now")
    const monday = nextMondayIso(14)
    const start = new Date(`${monday}T10:00:00`)
    // Create a customer
    const { rows: [c] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers
         (business_id, customer_type, first_name, last_name,
          street1, city, state, zip)
       VALUES ($1, 'individual', 'X', 'Y', 'a', 'b', 'AZ', '12345')
       RETURNING id`, [f.businessId])
    await db.query(
      `INSERT INTO appointments
         (business_id, customer_id, service_type,
          scheduled_for, duration_minutes, status)
       VALUES ($1, $2, 'Oil change', $3, 30, 'scheduled')`,
      [f.businessId, c.id, start.toISOString()])

    const res = await request(buildApp())
      .get(`/api/public/booking/${f.slug}/availability?serviceId=${f.serviceId}` +
           `&fromDate=${monday}&toDate=${monday}`)
    const day = res.body.data.days[0]
    expect(day.slots).not.toContain('10:00')
    // 09:00, 09:15 still OK (don't overlap)
    expect(day.slots).toContain('09:00')
  })

  it('disabled booking → 404', async () => {
    const f = await seed({ enabled: false })
    const today = new Date().toISOString().slice(0, 10)
    const res = await request(buildApp())
      .get(`/api/public/booking/${f.slug}/availability?serviceId=${f.serviceId}&fromDate=${today}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /booking/:slug/book
// ═══════════════════════════════════════════════════════════════

describe('POST /booking/:slug/book', () => {
  const validBody = (serviceId: string, scheduledFor: string) => ({
    serviceId,
    scheduledFor,
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.dev',
    phone: '555-0100',
    notes: 'New customer',
  })

  it('creates a new customer + appointment + sends confirmation email', async () => {
    const f = await seed()
    // Pick a slot 2 weeks out (well clear of "now")
    const monday = nextMondayIso(14)
    const slot = new Date(`${monday}T11:00:00`).toISOString()
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send(validBody(f.serviceId, slot))
    expect(res.status).toBe(201)
    expect(res.body.data.appointment_id).toBeDefined()

    const { rows: customers } = await db.query<{
      id: string; email: string; first_name: string;
    }>(`SELECT id, email, first_name FROM business_customers WHERE business_id = $1`,
        [f.businessId])
    expect(customers.length).toBe(1)
    expect(customers[0]!.email).toBe('jane@example.dev')
    expect(customers[0]!.first_name).toBe('Jane')

    const { rows: appts } = await db.query<{
      id: string; service_type: string; status: string;
    }>(`SELECT id, service_type, status FROM appointments WHERE business_id = $1`,
        [f.businessId])
    expect(appts.length).toBe(1)
    expect(appts[0]!.service_type).toBe('Oil change')

    // 2 emails — one to customer, one to business owner
    expect(emailBusinessAppointmentConfirmedMock).toHaveBeenCalledTimes(2)
  })

  it('matches existing customer by email instead of duplicating', async () => {
    const f = await seed()
    // Pre-create customer with the same email
    await db.query(
      `INSERT INTO business_customers
         (business_id, customer_type, first_name, last_name,
          email, phone, street1, city, state, zip)
       VALUES ($1, 'individual', 'Old', 'Customer',
               'jane@example.dev', '555-9999', 'a', 'b', 'AZ', '00000')`,
      [f.businessId])
    const monday = nextMondayIso(14)
    const slot = new Date(`${monday}T11:00:00`).toISOString()
    await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send(validBody(f.serviceId, slot))
    const { rows: customers } = await db.query(
      `SELECT id FROM business_customers WHERE business_id = $1`, [f.businessId])
    expect(customers.length).toBe(1)  // still one
  })

  it('slot already booked → 409', async () => {
    const f = await seed()
    const monday = nextMondayIso(14)
    const slot = new Date(`${monday}T11:00:00`).toISOString()
    await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send(validBody(f.serviceId, slot))
    // Second booking on same slot with a different customer
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send({ ...validBody(f.serviceId, slot), email: 'other@example.dev' })
    expect(res.status).toBe(409)
  })

  it('too-soon slot rejected with 400', async () => {
    const f = await seed()
    const soon = new Date(Date.now() + 10 * 60_000).toISOString()  // 10 minutes
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send(validBody(f.serviceId, soon))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least 60 minutes/i)
  })

  it('email failure does NOT block booking', async () => {
    emailBusinessAppointmentConfirmedMock.mockImplementation(async () => {
      throw new Error('Resend down')
    })
    const f = await seed()
    const monday = nextMondayIso(14)
    const slot = new Date(`${monday}T11:00:00`).toISOString()
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send(validBody(f.serviceId, slot))
    expect(res.status).toBe(201)
  })

  it('disabled booking → 404', async () => {
    const f = await seed({ enabled: false })
    const monday = nextMondayIso(14)
    const slot = new Date(`${monday}T11:00:00`).toISOString()
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send(validBody(f.serviceId, slot))
    expect(res.status).toBe(404)
  })

  it('cross-business service id → 404', async () => {
    const a = await seed()
    const b = await seed()
    const monday = nextMondayIso(14)
    const slot = new Date(`${monday}T11:00:00`).toISOString()
    // Book against business A's slug with business B's serviceId
    const res = await request(buildApp())
      .post(`/api/public/booking/${a.slug}/book`)
      .send(validBody(b.serviceId, slot))
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S511 — recurring + route-aware (day-mode) booking
// ═══════════════════════════════════════════════════════════════

describe('S511 booking modes', () => {
  it('non-route business profile is slot-mode with a one_time service', async () => {
    const f = await seed()
    const res = await request(buildApp()).get(`/api/public/booking/${f.slug}`)
    expect(res.body.data.booking_mode).toBe('slot')
    expect(res.body.data.services[0].recurrence).toBe('one_time')
  })

  it('routing business profile is day-mode; availability returns days, not slots', async () => {
    const f = await seed({ routing: true })
    const profile = await request(buildApp()).get(`/api/public/booking/${f.slug}`)
    expect(profile.body.data.booking_mode).toBe('day')
    const avail = await request(buildApp())
      .get(`/api/public/booking/${f.slug}/availability?serviceId=${f.serviceId}&fromDate=${new Date().toISOString().slice(0, 10)}`)
    expect(avail.body.data.mode).toBe('day')
    expect(avail.body.data.days.some((d: any) => d.available === true)).toBe(true)
    expect(avail.body.data.days[0].slots).toBeUndefined()
  })

  it('recurring service booking ENROLLS into a recurring_schedule (no one-off appointment)', async () => {
    const f = await seed({ routing: true, recurrence: 'weekly', recurrenceDow: 2 }) // Tuesdays
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send({ serviceId: f.serviceId, firstName: 'Dana', lastName: 'B', email: 'dana@x.dev', phone: '5551234' })
    expect(res.status).toBe(201)
    expect(res.body.data.enrolled).toBe(true)
    const sched = await db.query(
      `SELECT rrule, time_of_day FROM recurring_schedules WHERE business_id = $1`, [f.businessId])
    expect(sched.rows.length).toBe(1)
    expect(sched.rows[0].rrule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TU')
    const appts = await db.query(`SELECT id FROM appointments WHERE business_id = $1`, [f.businessId])
    expect(appts.rows.length).toBe(0) // materializer creates appts later, not the book call
  })

  it('one-time route booking creates an appointment on the picked day (no time pick)', async () => {
    const f = await seed({ routing: true }) // one_time service, day mode
    const day = nextMondayIso(7)
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send({ serviceId: f.serviceId, scheduledDate: day, firstName: 'Sam', lastName: 'P', email: 'sam@x.dev', phone: '5559999' })
    expect(res.status).toBe(201)
    const appts = await db.query<{ scheduled_for: Date }>(
      `SELECT scheduled_for FROM appointments WHERE business_id = $1`, [f.businessId])
    expect(appts.rows.length).toBe(1)
    expect(new Date(appts.rows[0]!.scheduled_for).toISOString().slice(0, 10)).toBe(day)
  })

  it('#11: customer-entered vehicle is filed when the business tracks vehicles', async () => {
    const f = await seed({ vehicles: true })
    const profile = await request(buildApp()).get(`/api/public/booking/${f.slug}`)
    expect(profile.body.data.collects_vehicle).toBe(true)
    const slot = new Date(`${nextMondayIso(14)}T11:00:00`).toISOString()
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send({ serviceId: f.serviceId, scheduledFor: slot, firstName: 'Val', lastName: 'V',
              email: 'val@x.dev', phone: '5550000',
              vehicleYear: 2019, vehicleMake: 'Toyota', vehicleModel: 'Tacoma', vehiclePlate: 'ABC123' })
    expect(res.status).toBe(201)
    const v = await db.query<{ year: number; make: string; model: string; license_plate: string }>(
      `SELECT year, make, model, license_plate FROM business_customer_vehicles WHERE business_id = $1`, [f.businessId])
    expect(v.rows.length).toBe(1)
    expect(v.rows[0]).toMatchObject({ year: 2019, make: 'Toyota', model: 'Tacoma', license_plate: 'ABC123' })
  })

  it('#11: vehicle fields ignored when the business does NOT track vehicles', async () => {
    const f = await seed() // no customer_vehicles
    const slot = new Date(`${nextMondayIso(14)}T11:00:00`).toISOString()
    await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send({ serviceId: f.serviceId, scheduledFor: slot, firstName: 'Val', lastName: 'V',
              email: 'val2@x.dev', phone: '5550000', vehicleMake: 'Toyota' })
    const v = await db.query(`SELECT id FROM business_customer_vehicles WHERE business_id = $1`, [f.businessId])
    expect(v.rows.length).toBe(0)
  })

  it('day-mode booking without a date → 400', async () => {
    const f = await seed({ routing: true })
    const res = await request(buildApp())
      .post(`/api/public/booking/${f.slug}/book`)
      .send({ serviceId: f.serviceId, firstName: 'Sam', lastName: 'P', email: 'sam@x.dev', phone: '5559999' })
    expect(res.status).toBe(400)
  })
})

// ── Helpers ───────────────────────────────────────────────────

function nextMondayIso(daysAhead: number): string {
  // Returns a Monday at least `daysAhead` days from now.
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

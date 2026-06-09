/**
 * bookings route slice — S350.
 *
 * Single-route file: GET /api/bookings (portfolio-wide list).
 * Per-unit booking CRUD lives under /api/units/:id/bookings (units.ts);
 * this route is the queryable rollup for the BookingsPage.
 *
 * Coverage focus:
 *   - Landlord scope: own bookings only, cross-landlord rows excluded
 *   - Admin sees across landlords
 *   - Team role without landlordId claim → 403
 *   - status / unitId / from-to / q text filters
 *   - canAccessLandlordResource defense-in-depth (verified by the
 *     landlord-scope test — SQL filter + post-query filter both work)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { bookingsRouter } from './bookings'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/bookings', bookingsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_bookings'
})

interface BookingsFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  unitId:         string
  landlordToken:  string
  adminToken:     string
}

async function seedBookingsFixture(): Promise<BookingsFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    // Admin user — for cross-landlord access tests
    const adminRes = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'admin', 'Test', 'Admin', TRUE) RETURNING id`,
      [`admin-${randomUUID()}@test.dev`])
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    const adminToken = jwt.sign(
      { userId: adminRes.rows[0].id, role: 'admin', email: 'admin@test.dev', profileId: adminRes.rows[0].id, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, propertyId, unitId, landlordToken, adminToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

interface BookingOpts {
  guestName?:   string
  guestEmail?:  string
  status?:      'tentative' | 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled' | 'no_show'
  source?:      string
  leaseType?:   'nightly' | 'weekly' | 'month_to_month' | 'long_term' | 'lease_hold'
  checkIn?:     string  // YYYY-MM-DD
  checkOut?:    string
  nightlyRate?: number
  unitId?:      string  // override
  landlordId?: string  // override
}

async function seedBooking(f: BookingsFixture, opts: BookingOpts = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (landlord_id, unit_id, guest_name, guest_email,
        lease_type, check_in, check_out, nights, nightly_rate, total_amount,
        status, source)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date,
             (($7::date - $6::date)),
             $8::numeric, ($8::numeric * ($7::date - $6::date)), $9, $10)
     RETURNING id`,
    [
      opts.landlordId ?? f.landlordId,
      opts.unitId ?? f.unitId,
      opts.guestName  ?? `Guest-${randomUUID().slice(0, 6)}`,
      opts.guestEmail ?? `guest-${randomUUID().slice(0, 6)}@test.dev`,
      opts.leaseType  ?? 'nightly',
      opts.checkIn    ?? '2026-06-01',
      opts.checkOut   ?? '2026-06-03',
      opts.nightlyRate ?? 100,
      opts.status     ?? 'confirmed',
      opts.source     ?? 'direct',
    ])
  return r.rows[0].id
}

describe('GET /api/bookings — landlord scope', () => {
  it('returns own landlord\'s bookings; cross-landlord rows excluded', async () => {
    const a = await seedBookingsFixture()
    const b = await seedBookingsFixture()
    const aId = await seedBooking(a)
    await seedBooking(b)  // b's booking — must not surface for a

    const res = await request(buildApp())
      .get('/api/bookings')
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(aId)
    expect(res.body.data[0].landlord_id).toBe(a.landlordId)
  })

  it('admin sees bookings across landlords', async () => {
    const a = await seedBookingsFixture()
    const b = await seedBookingsFixture()
    await seedBooking(a)
    await seedBooking(b)

    const res = await request(buildApp())
      .get('/api/bookings')
      .set('Authorization', `Bearer ${a.adminToken}`)
    expect(res.status).toBe(200)
    // Admin can read all; canAccessLandlordResource also returns true
    // for admin so the post-query filter doesn't drop them either.
    expect(res.body.data.length).toBe(2)
  })

  it('team-role JWT without landlordId claim → 403', async () => {
    const f = await seedBookingsFixture()
    // PM token with no landlordId claim (the manager hasn't been
    // assigned to a landlord at JWT-mint time — defensive guard).
    const teamToken = jwt.sign(
      { userId: randomUUID(), role: 'property_manager', email: 'pm@test.dev',
        profileId: randomUUID(), permissions: { 'team.invite': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    await seedBooking(f)
    const res = await request(buildApp())
      .get('/api/bookings')
      .set('Authorization', `Bearer ${teamToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/No landlord scope/)
  })
})

describe('GET /api/bookings — filters', () => {
  it('status filter narrows results', async () => {
    const f = await seedBookingsFixture()
    const confirmedId = await seedBooking(f, { status: 'confirmed' })
    await seedBooking(f, { status: 'cancelled' })
    await seedBooking(f, { status: 'checked_out' })

    const res = await request(buildApp())
      .get('/api/bookings?status=confirmed')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(confirmedId)
  })

  it('unitId filter scopes to single unit', async () => {
    const f = await seedBookingsFixture()
    // Seed a second unit under the same landlord/property and book it
    const client = await db.connect()
    let otherUnitId = ''
    try {
      await client.query('BEGIN')
      otherUnitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

    const aId = await seedBooking(f)  // f.unitId
    await seedBooking(f, { unitId: otherUnitId })

    const res = await request(buildApp())
      .get(`/api/bookings?unitId=${f.unitId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(aId)
  })

  it('from/to date window excludes out-of-range bookings', async () => {
    const f = await seedBookingsFixture()
    // Booking 1: check_in=05-01 / check_out=05-03 (before window)
    await seedBooking(f, { checkIn: '2026-05-01', checkOut: '2026-05-03' })
    // Booking 2: check_in=06-15 / check_out=06-20 (inside window)
    const insideId = await seedBooking(f, { checkIn: '2026-06-15', checkOut: '2026-06-20' })
    // Booking 3: check_in=07-25 / check_out=07-28 (after window)
    await seedBooking(f, { checkIn: '2026-07-25', checkOut: '2026-07-28' })

    // from filter uses check_out >= $from; to filter uses check_in <= $to.
    // Window: from 2026-06-01 to 2026-06-30 should return only the
    // inside-window booking.
    const res = await request(buildApp())
      .get('/api/bookings?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(insideId)
  })

  it('q text search matches guest_name OR guest_email, case-insensitively', async () => {
    const f = await seedBookingsFixture()
    const aliceId = await seedBooking(f, { guestName: 'Alice Smith', guestEmail: 'alice@x.dev' })
    const bobId   = await seedBooking(f, { guestName: 'Bob Jones',   guestEmail: 'BOB@y.dev' })
    await seedBooking(f, { guestName: 'Charlie Day', guestEmail: 'charlie@z.dev' })

    // Search "alice" → matches by name (case-insensitive)
    const r1 = await request(buildApp())
      .get('/api/bookings?q=ALICE')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(r1.body.data.length).toBe(1)
    expect(r1.body.data[0].id).toBe(aliceId)

    // Search "@y.dev" → matches by email
    const r2 = await request(buildApp())
      .get('/api/bookings?q=%40y.dev')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(r2.body.data.length).toBe(1)
    expect(r2.body.data[0].id).toBe(bobId)
  })

  it('combined status + unitId filters AND together', async () => {
    const f = await seedBookingsFixture()
    const target = await seedBooking(f, { status: 'confirmed' })
    await seedBooking(f, { status: 'cancelled' })  // wrong status
    // Wrong unit, right status — seed another unit
    const client = await db.connect()
    let otherUnitId = ''
    try {
      await client.query('BEGIN')
      otherUnitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    await seedBooking(f, { status: 'confirmed', unitId: otherUnitId })  // wrong unit

    const res = await request(buildApp())
      .get(`/api/bookings?status=confirmed&unitId=${f.unitId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].id).toBe(target)
  })
})

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
 *
 * S655 (money plan Step 6): an early check-out through the per-unit PATCH
 * (units.ts) moves the check-out to the day they left — the property's own
 * today, or an earlier day typed in — so the schedule and GAM's per-night count
 * stop there, and moves no money: the total is not repriced and the booking's
 * lease is not touched (the lease is law). Undoing a mistaken check-out puts
 * the booked day back, again without moving money.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { NIGHTS_AGGREGATION_UNIT_TYPES, priceStay, priceStayBetween } from '@gam/shared'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedUtilityMeter } from '../test/dbHelpers'
import { bookingsRouter } from './bookings'
import { unitsRouter } from './units'
import { billableUnitsForProperty } from '../services/billableUnits'
import { dispatchPortalAction, __setTransport } from '../services/agents/portalDispatch'
import { errorHandler } from '../middleware/errorHandler'

// S655 (Step 6 fix round 6): the extension rule's move of the next reservation
// (scheduleCompression relocateBlockingBookings) runs for real; a test can set
// `afterRelocation` to make something happen the moment that move is written —
// the way a change by somebody else can land between the move and the save.
const relocationHook = vi.hoisted(() => ({ afterRelocation: null as null | (() => Promise<void>) }))
vi.mock('../services/scheduleCompression', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/scheduleCompression')>()
  return {
    ...real,
    relocateBlockingBookings: async (...args: Parameters<typeof real.relocateBlockingBookings>) => {
      const out = await real.relocateBlockingBookings(...args)
      if (relocationHook.afterRelocation) await relocationHook.afterRelocation()
      return out
    },
  }
})

// 10/3 (review, fix pass): the site check (findStayConflict) runs for real; a
// test can set `beforeCheck` to make something happen at the moment a save
// that holds its locks is about to check a site — the way somebody else's
// save can arrive right then.
const conflictCheckHook = vi.hoisted(() => ({
  beforeCheck: null as null | ((unitId: string, w: { excludeBookingId?: string | null }) => Promise<void>),
}))
vi.mock('../services/unitAvailability', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/unitAvailability')>()
  return {
    ...real,
    findStayConflict: async (...args: Parameters<typeof real.findStayConflict>) => {
      if (conflictCheckHook.beforeCheck) await conflictCheckHook.beforeCheck(args[0], args[1])
      return real.findStayConflict(...args)
    },
  }
})

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
    // assigned to a landlord at JWT-mint time — defensive guard). Carries
    // bookings.view so it passes requirePerm and reaches the scope guard.
    const teamToken = jwt.sign(
      { userId: randomUUID(), role: 'property_manager', email: 'pm@test.dev',
        profileId: randomUUID(), permissions: { 'bookings.view': true } },
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

// ── S655 (money plan Step 6): early check-out moves the date, not the money ──
//
// The clock is pinned to 2026-10-03 03:00 UTC. In Phoenix (UTC-7, no DST) that
// is still the evening of Oct 2; in Auckland (UTC+13 in October) it is the
// afternoon of Oct 3. The server's own UTC day is Oct 3. A check-out that read
// the server's clock instead of the property's would put a Phoenix guest's
// departure on a day that has not started there yet.
//
// Only Date is faked: timers stay real so supertest, pg and the fire-and-forget
// lease work behind the PATCH all still run.
const NOW = new Date('2026-10-03T03:00:00Z')
const PHOENIX_TODAY = '2026-10-02'
const AUCKLAND_TODAY = '2026-10-03'

function buildUnitsApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

// The PATCH starts best-effort work after it answers (the lease draft check,
// the change history, and — on a date edit — the lease sync). Let it finish so
// "nothing happened to the lease" is a real observation, not a race.
const settle = () => new Promise(r => setTimeout(r, 250))

interface StayFixture {
  landlordId: string
  propertyId: string
  unitId: string
  token: string
}

async function seedStayFixture(opts: { timezone?: string; unitType?: string } = {}): Promise<StayFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(
      `UPDATE properties SET timezone = $2, timezone_source = 'manual' WHERE id = $1`,
      [propertyId, opts.timezone ?? 'America/Phoenix'])
    const unitId = await seedUnit(client, { propertyId, landlordId, unitType: opts.unitType ?? 'rv_spot' })
    // Rates are set so that ANY reprice would show: a 61-night monthly stay
    // booked at $3,000 reprices to a different number for any other length.
    await client.query(
      `UPDATE units SET lease_types_allowed = '{}', is_bookable = TRUE,
                        nightly_rate = 60, weekly_rate = 350, monthly_rate = 1500
        WHERE id = $1`, [unitId])
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, unitId, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedStay(f: StayFixture, o: {
  checkIn: string; checkOut: string; status?: string; leaseType?: string; total?: number; guestName?: string
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
        total_amount, platform_fee, status, source)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, ($6::date - $5::date), $7, 0, $8, 'direct')
     RETURNING id`,
    [f.landlordId, f.unitId, o.guestName ?? 'Pat Ruiz', o.leaseType ?? 'nightly',
     o.checkIn, o.checkOut, o.total ?? 500, o.status ?? 'checked_in'])
  return r.rows[0].id
}

// A second site at the same park, with its own rates.
async function seedOtherSite(f: StayFixture, rates: { nightly: number; weekly: number; monthly: number }): Promise<string> {
  const c = await db.connect()
  try {
    const id = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, unitType: 'rv_spot' })
    await c.query(
      `UPDATE units SET lease_types_allowed = '{}', is_bookable = TRUE,
                        nightly_rate = $2, weekly_rate = $3, monthly_rate = $4
        WHERE id = $1`, [id, rates.nightly, rates.weekly, rates.monthly])
    return id
  } finally { c.release() }
}

// 10/3 (decisions #33): the check-out the stay was sold for, as stored.
async function bookedCheckOut(id: string): Promise<string | null> {
  return (await db.query<{ d: string | null }>(
    `SELECT to_char(booked_check_out, 'YYYY-MM-DD') AS d FROM unit_bookings WHERE id = $1`, [id])).rows[0].d
}

// The fixture property's short-term lodging tax, as a percent.
async function taxPctOf(f: { propertyId: string }): Promise<number> {
  return Number((await db.query<{ t: string | null }>(
    `SELECT short_term_tax_rate::text AS t FROM properties WHERE id = $1`, [f.propertyId])).rows[0].t || 0)
}

async function stayRow(id: string) {
  const r = await db.query<{
    status: string; check_in: string; check_out: string; nights: number; total_amount: string; platform_fee: string
  }>(
    `SELECT status, to_char(check_in, 'YYYY-MM-DD') AS check_in, to_char(check_out, 'YYYY-MM-DD') AS check_out,
            nights, total_amount::text, platform_fee::text
       FROM unit_bookings WHERE id = $1`, [id])
  return r.rows[0]
}

const patchStay = (f: StayFixture, bookingId: string, body: Record<string, unknown>) =>
  request(buildUnitsApp())
    .patch(`/api/units/${f.unitId}/bookings/${bookingId}`)
    .set('Authorization', `Bearer ${f.token}`)
    .send(body)

// A three-month stay — Sep 1 to Dec 1 at $1,500 a month, booked at $4,500 —
// with its signed lease running to the booked day: September and October paid,
// November still owed. The rows are chosen so that a lease sync on ANY earlier
// end shows in every one of them. Synced to an Oct 2 end, the lease would end
// Oct 2, November's unpaid rent (due after the new end) would be deleted, and
// $1,451.61 — the $3,000 paid, less the $1,548.39 a Sep 1 to Oct 2 stay owes
// on the calendar schedule — would be banked as money paid ahead.
async function seedLongStayWithLease(f: StayFixture): Promise<{ stay: string; leaseId: string }> {
  const stay = await seedStay(f, {
    checkIn: '2026-09-01', checkOut: '2026-12-01', leaseType: 'month_to_month', total: 4500,
  })
  const c = await db.connect()
  let tenantId = ''
  try { tenantId = await seedTenant(c) } finally { c.release() }
  const leaseId = (await db.query<{ id: string }>(
    `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
                         lease_source, source_booking_id)
     VALUES ($1, $2, 1500, 'fixed_term', 'active', '2026-09-01', '2026-12-01', 'booking_draft', $3)
     RETURNING id`, [f.unitId, f.landlordId, stay])).rows[0].id
  await db.query(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
     VALUES ($1, $2, $3, $4, 'rent', 1500, 'settled', 'RENT', '2026-09-01'),
            ($1, $2, $3, $4, 'rent', 1500, 'settled', 'RENT', '2026-10-01'),
            ($1, $2, $3, $4, 'rent', 1500, 'pending', 'RENT', '2026-11-01')`,
    [f.unitId, tenantId, f.landlordId, leaseId])
  return { stay, leaseId }
}

// What a lease sync would change: the lease end, the rent rows, money banked.
async function leaseMoney(leaseId: string) {
  const lease = (await db.query<{ status: string; end_date: string }>(
    `SELECT status, to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leases WHERE id = $1`, [leaseId])).rows[0]
  const rent = (await db.query<{ status: string; due: string }>(
    `SELECT status, to_char(due_date, 'YYYY-MM-DD') AS due FROM payments WHERE lease_id = $1 ORDER BY due_date`,
    [leaseId])).rows
  const banked = (await db.query<{ amount: string; voided: boolean }>(
    `SELECT amount_original::text AS amount, (voided_at IS NOT NULL) AS voided
       FROM lease_prepaid_credits WHERE lease_id = $1 ORDER BY created_at, id`, [leaseId])).rows
  return { lease, rent, banked }
}
const LEASE_UNTOUCHED = {
  lease: { status: 'active', end_date: '2026-12-01' },
  rent: [
    { status: 'settled', due: '2026-09-01' },
    { status: 'settled', due: '2026-10-01' },
    { status: 'pending', due: '2026-11-01' },
  ],
  banked: [],
}
// 10/4 (decisions #38 Q8, Nic: "a long stay on a lease is NEVER billed past the
// day they leave"): an early check-out ends the lease that day. Sep 1 to Oct 2
// owes $1,548.39 on the calendar schedule, so November's unpaid rent goes and
// the $1,451.61 already paid past Oct 2 is banked as money paid ahead (it then
// gets the refund choices on the schedule's Check out window).
const LEASE_ENDED_TODAY = {
  lease: { status: 'active', end_date: PHOENIX_TODAY },
  rent: [
    { status: 'settled', due: '2026-09-01' },
    { status: 'settled', due: '2026-10-01' },
  ],
  banked: [{ amount: '1451.61', voided: false }],
}
// The check-out put back: the lease runs to the booked day again, and the money
// banked for the nights after the day they left is taken back (those nights are
// part of the stay again). November is billed by the regular bill run.
const LEASE_PUT_BACK = {
  lease: { status: 'active', end_date: '2026-12-01' },
  rent: [
    { status: 'settled', due: '2026-09-01' },
    { status: 'settled', due: '2026-10-01' },
  ],
  banked: [{ amount: '1451.61', voided: true }],
}

describe('PATCH /api/units/:id/bookings/:bookingId — early check-out (S655)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => { vi.useRealTimers() })

  it('an early check-out moves the check-out to the day they left', async () => {
    const phx = await seedStayFixture({ timezone: 'America/Phoenix' })
    const akl = await seedStayFixture({ timezone: 'Pacific/Auckland' })
    const phxStay = await seedStay(phx, { checkIn: '2026-09-28', checkOut: '2026-10-06' })
    const aklStay = await seedStay(akl, { checkIn: '2026-09-28', checkOut: '2026-10-06' })

    const r1 = await patchStay(phx, phxStay, { status: 'checked_out' })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(r1.body.checkOutMoved).toEqual({ from: '2026-10-06', to: PHOENIX_TODAY })
    expect(await stayRow(phxStay)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-28', check_out: PHOENIX_TODAY, nights: 4,
    })

    // Same instant, a park twenty hours ahead: its guest left on ITS today.
    const r2 = await patchStay(akl, aklStay, { status: 'checked_out' })
    expect(r2.status, JSON.stringify(r2.body)).toBe(200)
    expect(r2.body.checkOutMoved).toEqual({ from: '2026-10-06', to: AUCKLAND_TODAY })
    expect(await stayRow(aklStay)).toMatchObject({ check_out: AUCKLAND_TODAY, nights: 5 })

    // The schedule's history says what happened to the dates.
    await settle()
    const ev = await db.query<{ event_type: string }>(
      `SELECT event_type FROM unit_booking_events WHERE booking_id = $1 ORDER BY event_type`, [phxStay])
    expect(ev.rows.map(e => e.event_type)).toEqual(['dates_changed', 'status_changed'])
  })

  it('it keeps the booked total and ends the lease on the day they left (decisions #38 Q8)', async () => {
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)

    const res = await patchStay(f, stay, { status: 'checked_out' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.checkOutMoved).toEqual({ from: '2026-12-01', to: PHOENIX_TODAY })
    await settle()

    // The stay's own total is not repriced (the lease bills the stay); the
    // lease ends Oct 2, November's rent is gone and the $1,451.61 paid past the
    // day they left is banked as money paid ahead.
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_out: PHOENIX_TODAY, nights: 31, total_amount: '4500.00', platform_fee: '0.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)
    // Nothing about that money is decided here: it waits on the stay for the
    // schedule's Check out window, and the owner has a to-do.
    expect(res.body.moneyDecisionNeeded).toBe(
      'Pat Ruiz paid $1,451.61 more than the nights they stayed are worth. What to do with it waits on the stay: '
      + 'open it on the schedule and press Decide the money.')
    const d = await db.query<{ status: string; question: string; paid: string }>(
      `SELECT status, question, paid::text FROM stay_checkout_decisions WHERE booking_id = $1`, [stay])
    expect(d.rows).toEqual([{ status: 'pending', question: 'overpaid', paid: '1451.61' }])
    const todo = await db.query<{ type: string }>(
      `SELECT type FROM notifications WHERE landlord_id = $1 AND type = 'stay_money_decision'`, [f.landlordId])
    expect(todo.rows).toHaveLength(1)
  })

  it('a later edit of the guest\'s details keeps the total and the lease where they were', async () => {
    // The edit form sends check-in, check-out and the site back on every save.
    // Unchanged, they are not a date change: no reprice, no lease sync.
    const f = await seedStayFixture()
    const stay = await seedStay(f, {
      checkIn: '2026-09-01', checkOut: '2026-10-31', leaseType: 'month_to_month', total: 3000,
    })
    const leaseId = (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
                           lease_source, source_booking_id)
       VALUES ($1, $2, 1500, 'fixed_term', 'active', '2026-09-01', '2026-10-31', 'booking_draft', $3)
       RETURNING id`, [f.unitId, f.landlordId, stay])).rows[0].id
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)

    const edit = await patchStay(f, stay, {
      guestName: 'Pat Ruiz', guestEmail: null, guestPhone: '602-555-0101',
      checkIn: '2026-09-01', checkOut: PHOENIX_TODAY, unitId: f.unitId, notes: 'Left early — family emergency',
      requiredSiteLayout: 'none', requiredAmpService: 'none', avoidedUnitIds: [],
    })
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    await settle()
    expect(await stayRow(stay)).toMatchObject({ check_out: PHOENIX_TODAY, total_amount: '3000.00' })
    // 10/4 (decisions #38 Q8): the check-out ended the lease on the day they
    // left; the later edit leaves it there.
    const lease = await db.query<{ end_date: string }>(
      `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leases WHERE id = $1`, [leaseId])
    expect(lease.rows[0].end_date).toBe(PHOENIX_TODAY)
  })

  it('checking out on or after the booked day changes nothing', async () => {
    const f = await seedStayFixture()
    // Leaving on the booked day.
    const onTime = await seedStay(f, { checkIn: '2026-09-29', checkOut: PHOENIX_TODAY })
    const r1 = await patchStay(f, onTime, { status: 'checked_out' })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(r1.body.checkOutMoved).toBeNull()
    expect(await stayRow(onTime)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, nights: 3 })

    // Marked out two days late: a late departure is not an extension.
    const g = await seedStayFixture()
    const late = await seedStay(g, { checkIn: '2026-09-25', checkOut: '2026-09-30' })
    const r2 = await patchStay(g, late, { status: 'checked_out' })
    expect(r2.status, JSON.stringify(r2.body)).toBe(200)
    expect(r2.body.checkOutMoved).toBeNull()
    expect(await stayRow(late)).toMatchObject({ status: 'checked_out', check_out: '2026-09-30', nights: 5 })

    // Already checked out: saying it again moves nothing.
    const h = await seedStayFixture()
    const done = await seedStay(h, { checkIn: '2026-09-28', checkOut: '2026-10-06', status: 'checked_out' })
    const r3 = await patchStay(h, done, { status: 'checked_out' })
    expect(r3.status, JSON.stringify(r3.body)).toBe(200)
    expect(r3.body.checkOutMoved).toBeNull()
    expect(await stayRow(done)).toMatchObject({ check_out: '2026-10-06', nights: 8 })

    // Late, with the day they left typed in — the agent's natural call for
    // "Pat left today" on a stay booked to end Sep 30. Still a late departure,
    // not an extension: no reprice at today's rates, the lease keeps its end,
    // and the next guest booked onto the site from Oct 1 is not moved.
    const k = await seedStayFixture()
    const lateTyped = await seedStay(k, { checkIn: '2026-09-25', checkOut: '2026-09-30', total: 500 })
    const lateLease = (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
                           lease_source, source_booking_id)
       VALUES ($1, $2, 500, 'fixed_term', 'active', '2026-09-25', '2026-09-30', 'booking_draft', $3)
       RETURNING id`, [k.unitId, k.landlordId, lateTyped])).rows[0].id
    const nextGuest = await seedStay(k, {
      checkIn: '2026-10-01', checkOut: '2026-10-04', status: 'confirmed', guestName: 'Next Guest',
    })
    const r4 = await patchStay(k, lateTyped, { status: 'checked_out', checkOut: PHOENIX_TODAY })
    expect(r4.status, JSON.stringify(r4.body)).toBe(200)
    expect(r4.body.checkOutMoved).toBeNull()
    expect(r4.body.extendedGuestMovedTo).toBeNull()
    await settle()
    expect(await stayRow(lateTyped)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-25', check_out: '2026-09-30', nights: 5, total_amount: '500.00',
    })
    const lateLeaseEnd = await db.query<{ end_date: string }>(
      `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leases WHERE id = $1`, [lateLease])
    expect(lateLeaseEnd.rows[0].end_date).toBe('2026-09-30')
    const nextRow = await db.query<{ unit_id: string; check_in: string }>(
      `SELECT unit_id, to_char(check_in, 'YYYY-MM-DD') AS check_in FROM unit_bookings WHERE id = $1`, [nextGuest])
    expect(nextRow.rows[0]).toEqual({ unit_id: k.unitId, check_in: '2026-10-01' })
  })

  it('a guest who leaves on the day they arrived keeps one night', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: PHOENIX_TODAY, checkOut: '2026-10-06' })
    const res = await patchStay(f, stay, { status: 'checked_out' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.checkOutMoved).toEqual({ from: '2026-10-06', to: '2026-10-03' })
    expect(await stayRow(stay)).toMatchObject({ check_in: PHOENIX_TODAY, check_out: '2026-10-03', nights: 1 })
    // The stored check-out is the day after (the one night kept); the day they
    // actually left is in the history, for the closing meter read.
    const ev = await db.query<{ detail: any }>(
      `SELECT detail FROM unit_booking_events WHERE booking_id = $1 AND event_type = 'dates_changed'`, [stay])
    expect(ev.rows[0].detail).toMatchObject({ early_check_out: true, left_on: PHOENIX_TODAY, to: { check_out: '2026-10-03' } })
  })

  it('checking out a guest who has not arrived is refused, and nothing changes', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, {
      checkIn: '2026-10-05', checkOut: '2026-10-08', status: 'confirmed', guestName: 'Lee Park', total: 300,
    })
    const refused =
      'Lee Park has not arrived yet — check-in is October 5, 2026. To take the reservation off the schedule, cancel it instead.'
    // No day given, and — fix round — any day typed in: after today (it used
    // to be stored as checked out before arrival and repriced from $300 for
    // three nights to two), today, or before today.
    for (const body of [
      { status: 'checked_out' },
      { status: 'checked_out', checkOut: '2026-10-07' },
      { status: 'checked_out', checkOut: PHOENIX_TODAY },
      { status: 'checked_out', checkOut: '2026-10-01' },
    ]) {
      const res = await patchStay(f, stay, body)
      expect(res.status, JSON.stringify(body)).toBe(409)
      expect(res.body.error).toBe(refused)
    }
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'confirmed', check_in: '2026-10-05', check_out: '2026-10-08', nights: 3, total_amount: '300.00',
    })
    const none = await db.query(`SELECT 1 FROM unit_booking_events WHERE booking_id = $1`, [stay])
    expect(none.rows).toHaveLength(0)

    // The arrival the save would leave is the one that counts: a stay that is
    // here today, sent out with its check-in moved to a day that has not come.
    const g = await seedStayFixture()
    const here = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', guestName: 'Sam Cole', total: 480 })
    const moved = await patchStay(g, here, { status: 'checked_out', checkIn: '2026-10-04', checkOut: '2026-10-06' })
    expect(moved.status).toBe(409)
    expect(moved.body.error).toBe(
      'Sam Cole has not arrived yet — check-in is October 4, 2026. To take the reservation off the schedule, cancel it instead.')
    expect(await stayRow(here)).toMatchObject({
      status: 'checked_in', check_in: '2026-09-28', check_out: '2026-10-06', nights: 8, total_amount: '480.00',
    })
  })

  it('a status that is not a reservation status is refused in words, and nothing changes', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    for (const status of ['gone', 'Checked out', 7]) {
      const res = await patchStay(f, stay, { status, guestPhone: '602-555-0199' })
      expect(res.status, String(status)).toBe(400)
      // Never the database's own constraint text.
      expect(res.body.error).toBe(
        'That is not a reservation status. Use Tentative, Confirmed, Checked in, Checked out, Canceled or No-show.')
    }
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_out: '2026-10-06', nights: 8, total_amount: '480.00',
    })
    const phone = await db.query<{ guest_phone: string | null }>(`SELECT guest_phone FROM unit_bookings WHERE id = $1`, [stay])
    expect(phone.rows[0].guest_phone).toBeNull()
    // Absent or blank still leaves the status as it is.
    const blank = await patchStay(f, stay, { status: '', guestPhone: '602-555-0199' })
    expect(blank.status, JSON.stringify(blank.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_out: '2026-10-06' })
  })

  it("GAM's per-night count and the site's hold stop on the day they left", async () => {
    const f = await seedStayFixture({ unitType: 'rv_spot' })
    const stay = await seedStay(f, { checkIn: '2026-09-25', checkOut: '2026-10-10' })
    const octoberNights = async () => {
      const c = await db.connect()
      try {
        // October's nights, as the bill run reads them (in arrears).
        const b = await billableUnitsForProperty(c, f.propertyId, '2026-11-01', '2026-10-01', NIGHTS_AGGREGATION_UNIT_TYPES)
        return b.shortStayNights
      } finally { c.release() }
    }
    const book = () => request(buildUnitsApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseType: 'nightly', checkIn: PHOENIX_TODAY, checkOut: '2026-10-05', guestName: 'Next Guest' })

    expect(await octoberNights()).toBe(9)          // Oct 1–9 while still booked
    expect((await book()).status).toBe(409)        // the site is held through Oct 9

    const res = await patchStay(f, stay, { status: 'checked_out' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    expect(await octoberNights()).toBe(1)          // only the night of Oct 1
    const next = await book()
    expect(next.status, JSON.stringify(next.body)).toBe(201)   // free from the day they left
  })

  it('a check-out with the day they left typed in moves the date, not the money', async () => {
    // Staff on the schedule are the only sender of a check-out (the landlord
    // agent is refused in portalActions refuseAgentCheckOut). Their call for
    // "Pat left early today" carries the day:
    // {status:'checked_out', checkOut:<today>}. It is still the day they
    // left — not a new length of stay to reprice, and not a lease to shorten.
    const f = await seedStayFixture()
    const nightly = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 500 })
    const r1 = await patchStay(f, nightly, { status: 'checked_out', checkOut: PHOENIX_TODAY })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(r1.body.checkOutMoved).toEqual({ from: '2026-10-06', to: PHOENIX_TODAY })
    expect(await stayRow(nightly)).toMatchObject({
      status: 'checked_out', check_out: PHOENIX_TODAY, nights: 4, total_amount: '500.00',
    })

    // "They left yesterday": an earlier day is the day they left, too — and
    // the lease ends that day (decisions #38 Q8): a Sep 1 to Oct 1 stay owes
    // September, so the $1,500.00 paid for October is banked.
    const g = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(g)
    const r2 = await patchStay(g, stay, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(r2.status, JSON.stringify(r2.body)).toBe(200)
    expect(r2.body.checkOutMoved).toEqual({ from: '2026-12-01', to: '2026-10-01' })
    await settle()
    expect(await stayRow(stay)).toMatchObject({ check_out: '2026-10-01', nights: 30, total_amount: '4500.00' })
    expect(await leaseMoney(leaseId)).toEqual({
      ...LEASE_ENDED_TODAY, lease: { status: 'active', end_date: '2026-10-01' }, banked: [{ amount: '1500.00', voided: false }],
    })

    // A day typed before they arrived is a wrong day, not a departure: refused,
    // and the stay keeps every night (fix round 4 — it used to drop to one).
    const h = await seedStayFixture()
    const short = await seedStay(h, { checkIn: PHOENIX_TODAY, checkOut: '2026-10-06', total: 500 })
    const r3 = await patchStay(h, short, { status: 'checked_out', checkOut: '2026-09-30' })
    expect(r3.status).toBe(400)
    expect(r3.body.error).toBe(
      "Pat Ruiz arrived October 2, 2026, so they can't have left September 30, 2026. Check the day and try again.")
    expect(await stayRow(short)).toMatchObject({
      status: 'checked_in', check_out: '2026-10-06', nights: 4, total_amount: '500.00',
    })
  })

  it("a check-out with a later day typed in is refused: the guest hasn't left, and nothing changes", async () => {
    // Fix round 6: a day after today is not a day anybody left on. It used to
    // be read as the landlord setting a new length of stay: "Pat leaves
    // Monday, check her out" stored the stay as Checked out days before the
    // guest left, repriced it and ended the lease on that day. Staff on the
    // schedule are the only sender of a check-out (the landlord agent is
    // refused in portalActions refuseAgentCheckOut). Changing how long a stay
    // runs is the Edit form's check-out on its own (S548).
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    const eventsBefore = (await db.query(`SELECT 1 FROM unit_booking_events WHERE booking_id = $1`, [stay])).rows.length
    const res = await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-10-20' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(
      "Pat Ruiz hasn't left yet. To change how long the stay and its lease run, change the check-out with Edit; "
      + 'check them out on the day they leave.')
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_in: '2026-09-01', check_out: '2026-12-01', nights: 91, total_amount: '4500.00',
    })
    // The lease, its rent rows and the money banked: as they were.
    expect(await leaseMoney(leaseId)).toEqual(LEASE_UNTOUCHED)
    const eventsAfter = (await db.query(`SELECT 1 FROM unit_booking_events WHERE booking_id = $1`, [stay])).rows.length
    expect(eventsAfter).toBe(eventsBefore)

    // The probe's stay: Sep 28 to Oct 10 at $600, sent out on Oct 2 with Oct 5
    // typed in. It used to be stored as Checked out with check-out Oct 5 and
    // repriced to $392. No lease, so the words name only the stay. Its own
    // booked day, still ahead, is refused the same way.
    const g = await seedStayFixture()
    const nightly = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-10', total: 600 })
    for (const day of ['2026-10-05', '2026-10-03', '2026-10-12']) {
      const r = await patchStay(g, nightly, { status: 'checked_out', checkOut: day })
      expect(r.status, day).toBe(409)
      expect(r.body.error).toBe(
        "Pat Ruiz hasn't left yet. To change how long the stay runs, change the check-out with Edit; "
        + 'check them out on the day they leave.')
    }
    await settle()
    expect(await stayRow(nightly)).toMatchObject({
      status: 'checked_in', check_out: '2026-10-10', nights: 12, total_amount: '600.00',
    })
    // The Edit form's check-out on its own is still the landlord's date edit.
    const edit = await patchStay(g, nightly, { checkOut: '2026-10-05' })
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    expect(await stayRow(nightly)).toMatchObject({ status: 'checked_in', check_out: '2026-10-05', nights: 7 })
  })

  it('a check-out saved together with a new arrival day or site is refused, and nothing changes', async () => {
    // Fix round 6: two acts in one save used to skip the check-out rules and
    // take the date edit: repriced, the lease sync run on whatever check-out
    // the save left, and — with no day typed in — the stay stored as Checked
    // out with the site still held to the booked day.
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    const other = await seedOtherSite(f, { nightly: 90, weekly: 500, monthly: 2000 })
    const arrival = await patchStay(f, stay, { status: 'checked_out', checkIn: '2026-09-02' })
    expect(arrival.status).toBe(409)
    expect(arrival.body.error).toBe(
      "Pat Ruiz's check-out can't be saved together with a new arrival day. "
      + 'Make that change with Edit first, then check them out.')
    const site = await patchStay(f, stay, { status: 'checked_out', checkOut: PHOENIX_TODAY, unitId: other })
    expect(site.status).toBe(409)
    expect(site.body.error).toBe(
      "Pat Ruiz's check-out can't be saved together with a new site. "
      + 'Make that change with Edit first, then check them out.')
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_in: '2026-09-01', check_out: '2026-12-01', total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_UNTOUCHED)

    // Correcting the day a checked-out guest left, with a new arrival day too:
    // refused the same way, and the early check-out stays as it was (its lease
    // ended on the day they left, decisions #38 Q8).
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    await settle()
    const both = await patchStay(f, stay, { status: 'checked_out', checkIn: '2026-09-02', checkOut: '2026-10-01' })
    expect(both.status).toBe(409)
    expect(both.body.error).toBe(
      "Pat Ruiz's check-out can't be saved together with a new arrival day. "
      + 'Make that change with Edit first, then set the day they left.')
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-01', check_out: PHOENIX_TODAY, total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)
    // The arrival-day correction on its own (status sent along, the way the
    // agent might) is still the plain edit after an early check-out: no money.
    const fix = await patchStay(f, stay, { status: 'checked_out', checkIn: '2026-09-02' })
    expect(fix.status, JSON.stringify(fix.body)).toBe(200)
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-02', check_out: PHOENIX_TODAY, total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)
  })

  it('a one-date edit of a month-to-month stay is priced by the one rule (10/6: whole months, weeks and nights — never prorated)', async () => {
    // "They are staying two more nights" sends only the new check-out. The
    // other day comes from the stored stay; it used to arrive as a database
    // Date the monthly schedule could not read, and the edit failed with a 500.
    const f = await seedStayFixture()
    const stay = await seedStay(f, {
      checkIn: '2026-09-01', checkOut: '2026-10-31', leaseType: 'month_to_month', total: 3000,
    })
    // 10/5 (Nic, R2): a longer stay of 30+ nights carries the desk's lease-or-stay answer.
    const out = await patchStay(f, stay, { checkOut: '2026-11-02', stayTerms: 'stay' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    // 10/6 (Nic): two calendar months (Sep 1 → Nov 1) and one night — the
    // cheapest way to cover 62 nights — never a prorated calendar schedule.
    const afterOut = priceStayBetween({ nightly: 60, weekly: 350, monthly: 1500 }, 0, '2026-09-01', '2026-11-02').total
    expect(afterOut).toBe(3060)
    expect(await stayRow(stay)).toMatchObject({ check_out: '2026-11-02', nights: 62, total_amount: afterOut.toFixed(2) })

    // And the other way round: only the check-in.
    const inn = await patchStay(f, stay, { checkIn: '2026-09-02' })
    expect(inn.status, JSON.stringify(inn.body)).toBe(200)
    const afterIn = priceStayBetween({ nightly: 60, weekly: 350, monthly: 1500 }, 0, '2026-09-02', '2026-11-02').total
    expect(afterIn).toBe(3000) // exactly two calendar months
    expect(await stayRow(stay)).toMatchObject({ check_in: '2026-09-02', nights: 61, total_amount: afterIn.toFixed(2) })
    await settle()
  })

  it('a reservation with no price takes the site\'s price when it is saved from the edit form', async () => {
    // A $0 reservation was booked before the site had rates. The register
    // refuses it until it has a price, and the schedule has no price box:
    // saving it from the edit form (dates unchanged) is how it gets one.
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 0, status: 'confirmed' })
    const tax = Number((await db.query<{ t: string }>(
      `SELECT COALESCE(short_term_tax_rate, 0)::text AS t FROM properties WHERE id = $1`, [f.propertyId])).rows[0].t)
    const sitePrice = priceStay({ nightly: 60, weekly: 350, monthly: 1500 }, tax, '2026-09-28', 8).total
    expect(sitePrice).toBeGreaterThan(0)

    // A status change alone (the check-in button) does not price it.
    expect((await patchStay(f, stay, { status: 'checked_in' })).status).toBe(200)
    expect((await stayRow(stay)).total_amount).toBe('0.00')

    const save = await patchStay(f, stay, {
      guestName: 'Pat Ruiz', guestPhone: '602-555-0101',
      checkIn: '2026-09-28', checkOut: '2026-10-06', unitId: f.unitId,
      requiredSiteLayout: 'none', requiredAmpService: 'none', avoidedUnitIds: [],
    })
    expect(save.status, JSON.stringify(save.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ check_out: '2026-10-06', total_amount: sitePrice.toFixed(2) })

    // A $0 stay that already took money keeps what it was sold at.
    const paid = await seedStay(f, { checkIn: '2026-10-10', checkOut: '2026-10-12', total: 0 })
    await db.query(`UPDATE unit_bookings SET balance_paid_at = NOW() WHERE id = $1`, [paid])
    const save2 = await patchStay(f, paid, {
      checkIn: '2026-10-10', checkOut: '2026-10-12', unitId: f.unitId, guestPhone: '602-555-0102',
    })
    expect(save2.status, JSON.stringify(save2.body)).toBe(200)
    expect((await stayRow(paid)).total_amount).toBe('0.00')

    // A check-out moves no money, even when it carries the dates and the site:
    // checking out a $0 stay a day late does not price it.
    const late = await seedStay(f, { checkIn: '2026-09-25', checkOut: '2026-09-30', total: 0, guestName: 'Lee Park' })
    const out = await patchStay(f, late, {
      status: 'checked_out', checkIn: '2026-09-25', checkOut: PHOENIX_TODAY, unitId: f.unitId,
    })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(await stayRow(late)).toMatchObject({ status: 'checked_out', check_out: '2026-09-30', total_amount: '0.00' })
  })

  it('undoing a mistaken check-out puts the booked day back, and the lease with it', async () => {
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    // The site has a submeter, never read. The check-out makes a closing read
    // look due; the undo is the same guest going back onto their own site, so
    // it must not be held up for that read.
    const c = await db.connect()
    try {
      const meterId = await seedUtilityMeter(c, { propertyId: f.propertyId })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, f.unitId])
    } finally { c.release() }

    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    expect((await stayRow(stay)).check_out).toBe(PHOENIX_TODAY)
    await settle()
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)

    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toEqual({ from: PHOENIX_TODAY, to: '2026-12-01' })
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_in: '2026-09-01', check_out: '2026-12-01', nights: 91, total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_PUT_BACK)

    // The reservation itself holds the site again. (This stay's own lease runs
    // to Dec 1 and would block the site with or without the undo, so the
    // refusal has to be the reservation's — the lease is checked after it.
    // 'undoing a check-out holds the site for the guest again' shows the same
    // on a stay with no lease.)
    const other = await request(buildUnitsApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseType: 'nightly', checkIn: '2026-10-03', checkOut: '2026-10-05', guestName: 'Next Guest' })
    expect(other.status).toBe(409)
    expect(other.body.error).toBe('Unit is already booked for those dates')

    // The history says what happened, in words; and the undo happens once.
    const ev = await db.query<{ event_type: string; summary: string }>(
      `SELECT event_type, summary FROM unit_booking_events WHERE booking_id = $1 ORDER BY created_at, event_type`, [stay])
    expect(ev.rows.map(e => e.summary)).toEqual([
      'Pat Ruiz checked out early — check-out moved from December 1, 2026 to October 2, 2026 (60 days removed)',
      'Pat Ruiz status: Checked in → Checked out',
      "Pat Ruiz's check-out undone — check-out back to December 1, 2026 (60 days added back)",
      'Pat Ruiz status: Checked out → Checked in',
    ])
    const again = await patchStay(f, stay, { status: 'checked_in' })
    expect(again.status).toBe(200)
    expect(again.body.checkOutRestored).toBeNull()
  })

  it('undoing a check-out holds the site for the guest again', async () => {
    // A stay with no lease, so the only thing that can hold the site for the
    // freed nights is the reservation itself.
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06' })
    const book = () => request(buildUnitsApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseType: 'nightly', checkIn: '2026-10-03', checkOut: '2026-10-05', guestName: 'Next Guest' })

    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    // Checked out: the nights after the day they left are free to book.
    const free = await book()
    expect(free.status, JSON.stringify(free.body)).toBe(201)
    // (That booking is taken back off, so the undo below has nothing in its way.)
    const cancel = await patchStay(f, free.body.data.id, { status: 'cancelled' })
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200)

    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toEqual({ from: PHOENIX_TODAY, to: '2026-10-06' })

    // Undone: the guest holds those nights again.
    const held = await book()
    expect(held.status).toBe(409)
    expect(held.body.error).toBe('Unit is already booked for those dates')
  })

  it('undoing a check-out from the edit form, with the booked day typed back in, is still the undo', async () => {
    // An edit-form save or the agent sends the dates and the site along with
    // the status. The booked day typed back in — or the early check-out sent
    // back unchanged — is the undo, not a date edit: nothing is repriced, even
    // though the site's rates have gone up since the check-out.
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    await db.query(
      `UPDATE units SET nightly_rate = 90, weekly_rate = 500, monthly_rate = 2100 WHERE id = $1`, [f.unitId])

    const undo = await patchStay(f, stay, {
      status: 'checked_in', checkIn: '2026-09-01', checkOut: '2026-12-01', unitId: f.unitId,
    })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toEqual({ from: PHOENIX_TODAY, to: '2026-12-01' })
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_in: '2026-09-01', check_out: '2026-12-01', nights: 91, total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_PUT_BACK)

    // The early check-out sent back as it stands is the undo too.
    const g = await seedStayFixture()
    const nightly = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    expect((await patchStay(g, nightly, { status: 'checked_out' })).status).toBe(200)
    await db.query(`UPDATE units SET nightly_rate = 90 WHERE id = $1`, [g.unitId])
    const undo2 = await patchStay(g, nightly, {
      status: 'checked_in', checkIn: '2026-09-28', checkOut: PHOENIX_TODAY, unitId: g.unitId,
    })
    expect(undo2.status, JSON.stringify(undo2.body)).toBe(200)
    expect(undo2.body.checkOutRestored).toEqual({ from: PHOENIX_TODAY, to: '2026-10-06' })
    expect(await stayRow(nightly)).toMatchObject({ check_out: '2026-10-06', nights: 8, total_amount: '480.00' })
  })

  it('after an early check-out, moving the stay to another site or correcting its arrival day moves no money', async () => {
    // The guest has left; the stored check-out is the day they left, not a
    // length of stay. A drag down the schedule, a save from Edit or the agent's
    // edit that leaves the check-out alone must not price the stay on the
    // shortened length or sync the lease to the day they left. The other site
    // is dearer, so any reprice — on any length — would show.
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    const other = await seedOtherSite(f, { nightly: 80, weekly: 450, monthly: 1800 })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)

    // A site move with the dates as they stand.
    const move = await patchStay(f, stay, { unitId: other, checkIn: '2026-09-01', checkOut: PHOENIX_TODAY })
    expect(move.status, JSON.stringify(move.body)).toBe(200)
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-01', check_out: PHOENIX_TODAY, nights: 31, total_amount: '4500.00',
    })
    expect((await db.query<{ unit_id: string }>(
      `SELECT unit_id FROM unit_bookings WHERE id = $1`, [stay])).rows[0].unit_id).toBe(other)
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)

    // An arrival-day correction — the agent sends only the day.
    const arrival = await patchStay(f, stay, { checkIn: '2026-09-02' })
    expect(arrival.status, JSON.stringify(arrival.body)).toBe(200)
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      check_in: '2026-09-02', check_out: PHOENIX_TODAY, nights: 30, total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)
    const said = await db.query<{ summary: string }>(
      `SELECT summary FROM unit_booking_events
        WHERE booking_id = $1 AND event_type = 'dates_changed' ORDER BY created_at DESC LIMIT 1`, [stay])
    expect(said.rows[0].summary).toBe(
      "Pat Ruiz's check-in moved from September 1, 2026 to September 2, 2026. "
      + 'They had already checked out early, so the check-out, the price and any lease stay as they were')

    // After the correction the stay still knows the day they left is not its
    // length: a second move (back to the first site) moves no money either…
    const back = await patchStay(f, stay, { unitId: f.unitId })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    await settle()
    expect(await stayRow(stay)).toMatchObject({ check_out: PHOENIX_TODAY, total_amount: '4500.00' })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)

    // …and the check-out can still be undone back to the booked day.
    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toEqual({ from: PHOENIX_TODAY, to: '2026-12-01' })
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_in: '2026-09-02', check_out: '2026-12-01', total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_PUT_BACK)

    // A nightly stay, moved to another site after leaving early, keeps its total.
    const g = await seedStayFixture()
    const nightly = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const gOther = await seedOtherSite(g, { nightly: 80, weekly: 450, monthly: 1800 })
    expect((await patchStay(g, nightly, { status: 'checked_out' })).status).toBe(200)
    const gMove = await patchStay(g, nightly, { unitId: gOther, checkIn: '2026-09-28', checkOut: PHOENIX_TODAY })
    expect(gMove.status, JSON.stringify(gMove.body)).toBe(200)
    expect(await stayRow(nightly)).toMatchObject({ check_out: PHOENIX_TODAY, nights: 4, total_amount: '480.00' })
  })

  it('after an early check-out, a reservation with no price is priced on the nights it was booked for', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 0 })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    const tax = Number((await db.query<{ t: string }>(
      `SELECT COALESCE(short_term_tax_rate, 0)::text AS t FROM properties WHERE id = $1`, [f.propertyId])).rows[0].t)
    const eightNights = priceStay({ nightly: 60, weekly: 350, monthly: 1500 }, tax, '2026-09-28', 8).total

    const save = await patchStay(f, stay, { checkIn: '2026-09-28', checkOut: PHOENIX_TODAY, unitId: f.unitId })
    expect(save.status, JSON.stringify(save.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ check_out: PHOENIX_TODAY, nights: 4, total_amount: eightNights.toFixed(2) })
  })

  it('undoing a check-out and moving the stay in one save is refused with the next step, and nothing changes', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const other = await seedOtherSite(f, { nightly: 80, weekly: 450, monthly: 1800 })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)

    const both = await patchStay(f, stay, { status: 'checked_in', unitId: other })
    expect(both.status).toBe(409)
    expect(both.body.error).toBe(
      'Pat Ruiz checked out early, so put the check-out back first: set the status to Checked in on its own. '
      + 'Then change the site or the arrival day.')
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_out: PHOENIX_TODAY, nights: 4, total_amount: '480.00',
    })
  })

  it('an undo is refused when somebody has been booked into the freed nights, and nothing changes', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', guestName: 'Pat Ruiz' })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    const next = await request(buildUnitsApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseType: 'nightly', checkIn: PHOENIX_TODAY, checkOut: '2026-10-05', guestName: 'Next Guest' })
    expect(next.status, JSON.stringify(next.body)).toBe(201)

    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status).toBe(409)
    expect(undo.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 2, 2026 and October 6, 2026, '
      // The other reservation starts on the day Pat left, so an Edit has no
      // night to give back: moving it is the one step (fix round 5).
      + "so Pat Ruiz's stay can't be put back to October 6, 2026. Move that reservation first.")
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, nights: 4 })
  })

  it('after a later date edit, an undo no longer puts the old booked day back', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06' })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    // The landlord then sets the check-out themselves (a deliberate date edit).
    // That is still the one edit that moves money after an early check-out:
    // the stay is repriced on the dates the landlord set.
    const edit = await patchStay(f, stay, { checkOut: '2026-10-01' })
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    await settle()
    const tax = Number((await db.query<{ t: string }>(
      `SELECT COALESCE(short_term_tax_rate, 0)::text AS t FROM properties WHERE id = $1`, [f.propertyId])).rows[0].t)
    const threeNights = priceStay({ nightly: 60, weekly: 350, monthly: 1500 }, tax, '2026-09-28', 3).total
    expect((await stayRow(stay)).total_amount).toBe(threeNights.toFixed(2))

    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toBeNull()
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_out: '2026-10-01', nights: 3 })
  })

  it('a save is refused when someone else changed the stay a moment before, and nothing is written over it', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06' })
    // Another desk is mid-save on this stay: it holds the row while it moves
    // the check-out. Our check-out request reads the stay as it was, then
    // waits for the row; by the time it gets it, the stay has changed.
    const other = await db.connect()
    try {
      await other.query('BEGIN')
      await other.query(`SELECT 1 FROM unit_bookings WHERE id = $1 FOR UPDATE`, [stay])
      const mine = patchStay(f, stay, { status: 'checked_out', guestPhone: '602-555-0199' }).then(r => r)
      // Wait until our request is queued behind the other desk's lock.
      for (let i = 0; i < 100; i++) {
        const w = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%FROM unit_bookings WHERE id = $1 FOR UPDATE%'`)
        if (w.rows[0].n > 0) break
        await new Promise(r => setTimeout(r, 20))
      }
      await other.query(`UPDATE unit_bookings SET check_out = '2026-10-04', nights = 6 WHERE id = $1`, [stay])
      await other.query('COMMIT')
      const res = await mine
      expect(res.status).toBe(409)
      // 10/3: staff screens put the latest in place, so the words never say
      // "open it again" — they say what happened and what to do.
      expect(res.body.error).toBe(
        "Pat Ruiz's reservation was just changed by someone else, so your change was not saved. "
        + 'The latest is shown now; make your change again if it is still needed.')
      // Fix round: the refusal says which kind it is and carries the stay as it
      // is now, so the schedule can put the latest in front of staff in place.
      expect(res.body.code).toBe('reservation_changed')
      expect(res.body.data).toMatchObject({ id: stay, status: 'checked_in', nights: 6 })
    } finally { other.release() }
    // Theirs stands; nothing of ours was written.
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_out: '2026-10-04', nights: 6 })
    const phone = await db.query<{ guest_phone: string | null }>(`SELECT guest_phone FROM unit_bookings WHERE id = $1`, [stay])
    expect(phone.rows[0].guest_phone).toBeNull()
  })

  it('a date edit that leaves no night, or is not a date, is refused in words', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06' })
    const same = await patchStay(f, stay, { checkOut: '2026-09-28' })
    expect(same.status).toBe(400)
    expect(same.body.error).toBe('Check-out has to be at least one day after check-in.')
    const before = await patchStay(f, stay, { checkIn: '2026-10-07' })
    expect(before.status).toBe(400)
    const junk = await patchStay(f, stay, { checkOut: '2026-02-30' })
    expect(junk.status).toBe(400)
    expect(junk.body.error).toBe('Check-out is not a date. Pick the day from the calendar and try again.')
    expect(await stayRow(stay)).toMatchObject({ check_in: '2026-09-28', check_out: '2026-10-06', nights: 8 })
  })

  // ── Fix round 3 ──────────────────────────────────────────────────────────

  it('correcting the day a checked-out guest left moves the date, not the money', async () => {
    // "Pat left today", then "actually it was yesterday": the agent sends the
    // check-out again with the corrected day. It is still the day they left —
    // not a new length of stay to reprice, and not a lease to shorten.
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    expect((await stayRow(stay)).check_out).toBe(PHOENIX_TODAY)

    const fix = await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fix.status, JSON.stringify(fix.body)).toBe(200)
    expect(fix.body.checkOutMoved).toEqual({ from: PHOENIX_TODAY, to: '2026-10-01' })
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-01', check_out: '2026-10-01', nights: 30, total_amount: '4500.00',
    })
    // 10/4 (decisions #38 Q8): the lease follows the corrected day — it ends
    // Oct 1, and the $48.39 more now paid past it is banked beside the first.
    expect(await leaseMoney(leaseId)).toEqual({
      ...LEASE_ENDED_TODAY, lease: { status: 'active', end_date: '2026-10-01' },
      banked: [{ amount: '1451.61', voided: false }, { amount: '48.39', voided: false }],
    })
    const said = await db.query<{ summary: string; detail: any }>(
      `SELECT summary, detail FROM unit_booking_events
        WHERE booking_id = $1 AND event_type = 'dates_changed' ORDER BY created_at DESC LIMIT 1`, [stay])
    expect(said.rows[0].summary).toBe(
      'Pat Ruiz left earlier than recorded — check-out moved from October 2, 2026 to October 1, 2026 (1 day removed)')
    expect(said.rows[0].detail).toMatchObject({
      early_check_out: true, booked_check_out: '2026-12-01', left_on: '2026-10-01', left_on_corrected: true,
    })

    // After the correction, an undo still puts the booked day back — no money.
    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toEqual({ from: '2026-10-01', to: '2026-12-01' })
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_out: '2026-12-01', nights: 91, total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual({
      ...LEASE_PUT_BACK, banked: [{ amount: '1451.61', voided: true }, { amount: '48.39', voided: true }],
    })

    // A nightly stay: corrected earlier, then later again — the $480 never moves.
    const g = await seedStayFixture()
    const nightly = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    expect((await patchStay(g, nightly, { status: 'checked_out' })).status).toBe(200)
    const earlier = await patchStay(g, nightly, { status: 'checked_out', checkOut: '2026-09-30' })
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200)
    expect(await stayRow(nightly)).toMatchObject({ check_out: '2026-09-30', nights: 2, total_amount: '480.00' })
    const laterFix = await patchStay(g, nightly, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(laterFix.status, JSON.stringify(laterFix.body)).toBe(200)
    expect(laterFix.body.checkOutMoved).toEqual({ from: '2026-09-30', to: '2026-10-01' })
    expect(await stayRow(nightly)).toMatchObject({ check_out: '2026-10-01', nights: 3, total_amount: '480.00' })
    const laterSaid = await db.query<{ summary: string }>(
      `SELECT summary FROM unit_booking_events
        WHERE booking_id = $1 AND event_type = 'dates_changed' ORDER BY created_at DESC LIMIT 1`, [nightly])
    expect(laterSaid.rows[0].summary).toBe(
      'Pat Ruiz left later than recorded — check-out moved from September 30, 2026 to October 1, 2026 (1 day added back)')
    // The same day sent again changes nothing.
    const same = await patchStay(g, nightly, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect(same.body.checkOutMoved).toBeNull()
    expect(await stayRow(nightly)).toMatchObject({ check_out: '2026-10-01', total_amount: '480.00' })

    // A guest checked out on the booked day who in fact left the day before.
    const h = await seedStayFixture()
    const onTime = await seedStay(h, { checkIn: '2026-09-28', checkOut: PHOENIX_TODAY, total: 240 })
    expect((await patchStay(h, onTime, { status: 'checked_out' })).body.checkOutMoved).toBeNull()
    const onTimeFix = await patchStay(h, onTime, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(onTimeFix.status, JSON.stringify(onTimeFix.body)).toBe(200)
    expect(onTimeFix.body.checkOutMoved).toEqual({ from: PHOENIX_TODAY, to: '2026-10-01' })
    expect(await stayRow(onTime)).toMatchObject({ check_out: '2026-10-01', nights: 3, total_amount: '240.00' })
  })

  it('a correction that says they stayed to the booked day puts it back, and moves no money', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-25', checkOut: '2026-09-30', total: 500 })
    const out = await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-09-28' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect((await stayRow(stay)).check_out).toBe('2026-09-28')

    // "Actually Pat was here until yesterday" — past the booked Sep 30. A late
    // departure is not an extension: the booked day comes back, no more.
    const fix = await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fix.status, JSON.stringify(fix.body)).toBe(200)
    expect(fix.body.checkOutMoved).toBeNull()
    expect(fix.body.checkOutRestored).toEqual({ from: '2026-09-28', to: '2026-09-30' })
    expect(fix.body.extendedGuestMovedTo).toBeNull()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-25', check_out: '2026-09-30', nights: 5, total_amount: '500.00',
    })
    const said = await db.query<{ summary: string }>(
      `SELECT summary FROM unit_booking_events
        WHERE booking_id = $1 AND event_type = 'dates_changed' ORDER BY created_at DESC LIMIT 1`, [stay])
    expect(said.rows[0].summary).toBe(
      'Pat Ruiz stayed to the day they had booked — check-out back to September 30, 2026 (2 days added back)')
    // Nothing early is left to undo.
    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toBeNull()
    expect(await stayRow(stay)).toMatchObject({ check_out: '2026-09-30', total_amount: '500.00' })
  })

  it('a correction that gives back nights somebody has since booked is refused, and nothing changes', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    expect((await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-10-01' })).status).toBe(200)
    await seedStay(f, { checkIn: '2026-10-01', checkOut: '2026-10-04', status: 'confirmed', guestName: 'Next Guest' })

    const fix = await patchStay(f, stay, { status: 'checked_out', checkOut: PHOENIX_TODAY })
    expect(fix.status).toBe(409)
    expect(fix.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 1, 2026 and October 2, 2026, '
      + "so Pat Ruiz's check-out can't be moved to October 2, 2026. Move that reservation first.")
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: '2026-10-01', total_amount: '480.00' })
  })

  it('a cancelled or no-show reservation cannot be checked out, and nothing changes', async () => {
    const f = await seedStayFixture()
    const cancelled = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', status: 'cancelled' })
    await db.query(`UPDATE unit_bookings SET cancelled_at = '2026-09-20T12:00:00Z' WHERE id = $1`, [cancelled])
    const r1 = await patchStay(f, cancelled, { status: 'checked_out' })
    expect(r1.status).toBe(409)
    expect(r1.body.error).toBe(
      "Pat Ruiz's reservation was canceled, so there is no stay to check out. To bring it back, set it to Confirmed first.")
    expect(await stayRow(cancelled)).toMatchObject({ status: 'cancelled', check_out: '2026-10-06', nights: 8 })
    const stamp = await db.query<{ cancelled_at: Date | null }>(
      `SELECT cancelled_at FROM unit_bookings WHERE id = $1`, [cancelled])
    expect(stamp.rows[0].cancelled_at).not.toBeNull()

    const g = await seedStayFixture()
    const noShow = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', status: 'no_show', guestName: 'Lee Park' })
    const r2 = await patchStay(g, noShow, { status: 'checked_out', checkOut: PHOENIX_TODAY })
    expect(r2.status).toBe(409)
    expect(r2.body.error).toBe(
      'Lee Park was marked a no-show, so there is no stay to check out. If they did come, set the reservation to Checked in first.')
    expect(await stayRow(noShow)).toMatchObject({ status: 'no_show', check_out: '2026-10-06', nights: 8 })
  })

  // Final fix (fix pass 1, decisions #53): the refusals no longer tell staff
  // to set the stay back to Confirmed first — that step does not exist on the
  // Schedule, and undoing a stay that happened is how rent for nights stayed
  // got zeroed. A stay that happened stays on the schedule as its record.
  it('a checked-out stay cannot be marked a no-show or canceled — the words name no way around it (it stays as its record) — and its booked day is never lost', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)

    const noShow = await patchStay(f, stay, { status: 'no_show' })
    expect(noShow.status).toBe(409)
    expect(noShow.body.error).toBe(
      "Pat Ruiz checked in and out, so they came and can't be marked a no-show — the stay stays on the schedule as its record, and nothing was changed.")
    const cancel = await patchStay(f, stay, { status: 'cancelled' })
    expect(cancel.status).toBe(409)
    expect(cancel.body.error).toBe(
      "Pat Ruiz has already checked out, so the stay can't be canceled — a stay that happened stays on the schedule as its record, and nothing was changed.")
    for (const r of [noShow, cancel]) expect(r.body.error).not.toMatch(/Confirmed/)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '480.00' })

    // An undo of the check-out through the API (a correction — the Schedule
    // has no such button) still brings the booked day back with it.
    const back = await patchStay(f, stay, { status: 'confirmed' })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body.checkOutRestored).toEqual({ from: PHOENIX_TODAY, to: '2026-10-06' })
    const marked = await patchStay(f, stay, { status: 'no_show' })
    expect(marked.status, JSON.stringify(marked.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'no_show', check_out: '2026-10-06', nights: 8, total_amount: '480.00' })
  })

  it('an early check-out ends the lease on the day they left, so there is no lease note (decisions #38 Q8)', async () => {
    // Nic (10/3): "a long stay on a lease is NEVER billed past the day they
    // leave. Leaving = the lease ends that day and a FINAL bill is made." The
    // S655 rule this replaces kept the lease (and its autopay) running to the
    // booked day and told staff how to end it by hand.
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    const out = await patchStay(f, stay, { status: 'checked_out' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.leaseNote).toBeNull()
    await settle()
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)
    const november = await db.query(
      `SELECT 1 FROM payments WHERE lease_id = $1 AND due_date = '2026-11-01'`, [leaseId])
    expect(november.rows).toHaveLength(0)
    // The stay's own total is left as booked — the lease bills the stay.
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '4500.00' })

    // A stay with no lease has nothing to say either.
    const g = await seedStayFixture()
    const nightly = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const plain = await patchStay(g, nightly, { status: 'checked_out' })
    expect(plain.status, JSON.stringify(plain.body)).toBe(200)
    expect(plain.body.leaseNote).toBeNull()
  })

  it("the landlord agent cannot check a guest out: refused before anything is sent, and nothing changes (decisions #38 Q6)", async () => {
    // Nic (10/3): "the AI assistant must NOT check guests out or make any money
    // decision." The agent's real dispatch runs the action's own refusal
    // (portalActions refuseAgentCheckOut) before calling the booking PATCH.
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    const claims = jwt.decode(f.token) as Record<string, unknown>
    const actor = {
      userId: String(claims.userId), role: 'landlord', profileId: '', landlordIds: [f.landlordId], auth: claims,
    } as any
    const sent: string[] = []
    __setTransport(async (url: string, init: any) => {
      sent.push(url)
      const r = await request(buildUnitsApp())
        .patch(new URL(url).pathname)
        .set(init.headers)
        .send(init.body ? JSON.parse(init.body) : {})
      return { status: r.status, json: r.body }
    })
    const agent = (args: Record<string, unknown>) =>
      dispatchPortalAction('update_unit_booking', { unitId: f.unitId, bookingId: stay, ...args }, actor)
    try {
      for (const args of [{ status: 'checked_out' }, { status: 'checked_out', checkOut: '2026-10-01' }, { checkOut: '2026-10-01' }]) {
        const out = await agent(args)
        expect(out.ok, JSON.stringify(args)).toBe(false)
        expect(out.error).toMatch(/on the schedule/)
      }
      expect(sent).toHaveLength(0)
      await settle()
      expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_out: '2026-12-01', total_amount: '4500.00' })
      expect(await leaseMoney(leaseId)).toEqual(LEASE_UNTOUCHED)

      // A plain edit still goes through, and its row reads exactly as it always did.
      const plain = await agent({ notes: 'Gate code 4411' })
      expect(plain.ok, JSON.stringify(plain)).toBe(true)
      for (const k of ['leaseNote', 'checkOutMoved', 'checkOutRestored', 'extendedGuestMovedTo', 'moneyDecisionNeeded']) {
        expect(plain.data as any).not.toHaveProperty(k)
      }
    } finally {
      __setTransport(null)
    }
  })

  it('a departure day before the arrival is refused, and nothing changes', async () => {
    // A wrong month or year typed in (by staff or the agent) is not a
    // departure. It used to be read as "left on the arrival day": the stay
    // dropped to one night, cutting the nights GAM bills for, and the history
    // recorded a departure that never happened.
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const first = await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-09-01' })
    expect(first.status).toBe(400)
    expect(first.body.error).toBe(
      "Pat Ruiz arrived September 28, 2026, so they can't have left September 1, 2026. Check the day and try again.")
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_in: '2026-09-28', check_out: '2026-10-06', nights: 8, total_amount: '480.00',
    })
    const none = await db.query(`SELECT 1 FROM unit_booking_events WHERE booking_id = $1`, [stay])
    expect(none.rows).toHaveLength(0)

    // A correction after the check-out: refused the same way, and the
    // check-out, the money, the lease and the booked day all stay put.
    const g = await seedStayFixture()
    const { stay: long, leaseId } = await seedLongStayWithLease(g)
    expect((await patchStay(g, long, { status: 'checked_out' })).status).toBe(200)
    const fix = await patchStay(g, long, { status: 'checked_out', checkOut: '2026-08-15' })
    expect(fix.status).toBe(400)
    expect(fix.body.error).toBe(
      "Pat Ruiz arrived September 1, 2026, so they can't have left August 15, 2026. Check the day and try again.")
    await settle()
    expect(await stayRow(long)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-01', check_out: PHOENIX_TODAY, nights: 31, total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)
    const moves = await db.query<{ detail: any }>(
      `SELECT detail FROM unit_booking_events WHERE booking_id = $1 AND event_type = 'dates_changed'`, [long])
    expect(moves.rows).toHaveLength(1)
    expect(moves.rows[0].detail).toMatchObject({ left_on: PHOENIX_TODAY, booked_check_out: '2026-12-01' })
    // The undo still finds the booked day.
    const undo = await patchStay(g, long, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toEqual({ from: PHOENIX_TODAY, to: '2026-12-01' })
  })

  it('a cancelled or no-show reservation is not brought back onto nights somebody else now holds', async () => {
    // Setting it back to Tentative, Confirmed or Checked in is a status change
    // only — and the site check used to run only when the dates or the site
    // changed, so both reservations ended up holding the same site.
    const f = await seedStayFixture()
    const cancelled = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', status: 'cancelled', total: 480 })
    await db.query(`UPDATE unit_bookings SET cancelled_at = '2026-09-20T12:00:00Z' WHERE id = $1`, [cancelled])
    const lee = await seedStay(f, {
      checkIn: '2026-09-29', checkOut: '2026-10-05', status: 'checked_in', guestName: 'Lee Park', total: 360,
    })
    for (const status of ['confirmed', 'tentative', 'checked_in']) {
      const r = await patchStay(f, cancelled, { status })
      expect(r.status, status).toBe(409)
      expect(r.body.error).toBe(
        "Another reservation now holds this site for some of Pat Ruiz's nights. "
        + 'Move that reservation first, or give Pat Ruiz new dates with Edit.')
    }
    await settle()
    expect(await stayRow(cancelled)).toMatchObject({
      status: 'cancelled', check_in: '2026-09-28', check_out: '2026-10-06', nights: 8, total_amount: '480.00',
    })
    const stamp = await db.query<{ cancelled_at: Date | null }>(
      `SELECT cancelled_at FROM unit_bookings WHERE id = $1`, [cancelled])
    expect(stamp.rows[0].cancelled_at).not.toBeNull()
    expect(await stayRow(lee)).toMatchObject({ status: 'checked_in', check_in: '2026-09-29', check_out: '2026-10-05' })

    // The next step it names: new dates with Edit, on nights that are free.
    const moved = await patchStay(f, cancelled, { status: 'confirmed', checkIn: '2026-10-05', checkOut: '2026-10-09' })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(await stayRow(cancelled)).toMatchObject({
      status: 'confirmed', check_in: '2026-10-05', check_out: '2026-10-09', nights: 4,
    })

    // A no-show who did come, after somebody else took the site.
    const g = await seedStayFixture()
    const noShow = await seedStay(g, {
      checkIn: '2026-09-28', checkOut: '2026-10-06', status: 'no_show', guestName: 'Sam Cole', total: 480,
    })
    await seedStay(g, { checkIn: '2026-09-29', checkOut: '2026-10-05', status: 'checked_in', guestName: 'Lee Park' })
    const r2 = await patchStay(g, noShow, { status: 'checked_in' })
    expect(r2.status).toBe(409)
    expect(r2.body.error).toBe(
      "Another reservation now holds this site for some of Sam Cole's nights. "
      + 'Move that reservation first, or give Sam Cole new dates with Edit.')
    await settle()
    expect(await stayRow(noShow)).toMatchObject({ status: 'no_show', check_out: '2026-10-06', nights: 8, total_amount: '480.00' })

    // A site that is still free takes them back, as before.
    const h = await seedStayFixture()
    const late = await seedStay(h, { checkIn: '2026-09-28', checkOut: '2026-10-06', status: 'no_show', total: 480 })
    const ok = await patchStay(h, late, { status: 'checked_in' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await stayRow(late)).toMatchObject({ status: 'checked_in', check_out: '2026-10-06', total_amount: '480.00' })

    // Not only a reservation holds a site: the owner's own use does too.
    const k = await seedStayFixture()
    const gone = await seedStay(k, { checkIn: '2026-09-28', checkOut: '2026-10-06', status: 'cancelled', total: 480 })
    await db.query(`UPDATE units SET status = 'owner_use' WHERE id = $1`, [k.unitId])
    const r3 = await patchStay(k, gone, { status: 'confirmed' })
    expect(r3.status).toBe(409)
    expect(r3.body.error).toBe(
      "That site is in the owner's own use, so Pat Ruiz's reservation can't be brought back on this site. "
      + 'Give Pat Ruiz new dates or another site with Edit.')
    expect(await stayRow(gone)).toMatchObject({ status: 'cancelled', check_out: '2026-10-06' })
  })

  // ── Fix round 5 ──────────────────────────────────────────────────────────

  it("a checked-out guest can't be given a departure day after today, and nothing changes", async () => {
    // A guest who has already left cannot have left on a day that has not
    // come yet. On a stay already checked out, this check-out-shaped request
    // used to fall through to the date edit: the Oct 3 case below was
    // repriced to $1,596.77, its lease ended Oct 3, November's rent deleted
    // and $1,403.23 banked as money paid ahead.
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    await settle()
    const eventsBefore = (await db.query(
      `SELECT 1 FROM unit_booking_events WHERE booking_id = $1`, [stay])).rows.length

    const refused =
      "Pat Ruiz has already checked out, so the day they left can't be after today. "
      + 'To change how long the stay and its lease run, change the check-out with Edit.'
    const tomorrow = await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-10-03' })
    expect(tomorrow.status).toBe(409)
    expect(tomorrow.body.error).toBe(refused)
    // The booked day, still ahead, is refused the same way — even sent with
    // the arrival day unchanged, the way the agent might.
    const booked = await patchStay(f, stay, { status: 'checked_out', checkIn: '2026-09-01', checkOut: '2026-12-01' })
    expect(booked.status).toBe(409)
    expect(booked.body.error).toBe(refused)
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_in: '2026-09-01', check_out: PHOENIX_TODAY, nights: 31, total_amount: '4500.00',
    })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)
    const eventsAfter = (await db.query(
      `SELECT 1 FROM unit_booking_events WHERE booking_id = $1`, [stay])).rows.length
    expect(eventsAfter).toBe(eventsBefore)
    // The undo still finds the booked day, and puts the lease back with it.
    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body.checkOutRestored).toEqual({ from: PHOENIX_TODAY, to: '2026-12-01' })
    await settle()
    expect(await leaseMoney(leaseId)).toEqual(LEASE_PUT_BACK)

    // A nightly stay checked out early, then handed back its booked day
    // (still ahead): the $900 stays, and the site is not held again for a
    // guest who has gone — the nights they gave up can still be booked.
    const g = await seedStayFixture()
    const nightly = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 900 })
    expect((await patchStay(g, nightly, { status: 'checked_out' })).status).toBe(200)
    const back = await patchStay(g, nightly, { status: 'checked_out', checkOut: '2026-10-06' })
    expect(back.status).toBe(409)
    expect(back.body.error).toBe(
      "Pat Ruiz has already checked out, so the day they left can't be after today. "
      + 'To change how long the stay runs, change the check-out with Edit.')
    expect(await stayRow(nightly)).toMatchObject({
      status: 'checked_out', check_out: PHOENIX_TODAY, nights: 4, total_amount: '900.00',
    })
    const next = await request(buildUnitsApp())
      .post(`/api/units/${g.unitId}/bookings`)
      .set('Authorization', `Bearer ${g.token}`)
      .send({ leaseType: 'nightly', checkIn: PHOENIX_TODAY, checkOut: '2026-10-06', guestName: 'Next Guest' })
    expect(next.status, JSON.stringify(next.body)).toBe(201)

    // Fix round 6: a guest not yet checked out who is given a later day is
    // refused too — they haven't left (it used to be the date edit).
    const h = await seedStayFixture()
    const sitting = await seedStay(h, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const later = await patchStay(h, sitting, { status: 'checked_out', checkOut: '2026-10-08' })
    expect(later.status).toBe(409)
    expect(later.body.error).toBe(
      "Pat Ruiz hasn't left yet. To change how long the stay runs, change the check-out with Edit; "
      + 'check them out on the day they leave.')
    expect(await stayRow(sitting)).toMatchObject({
      status: 'checked_in', check_out: '2026-10-06', nights: 8, total_amount: '480.00',
    })
  })

  it('with the freed nights booked again, the undo names the step that works; the lease already ended on the day they left', async () => {
    const f = await seedStayFixture()
    const { stay, leaseId } = await seedLongStayWithLease(f)
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    await settle()
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)
    const leeId = await seedStay(f, {
      checkIn: PHOENIX_TODAY, checkOut: '2026-10-09', status: 'confirmed', guestName: 'Lee Park', total: 420,
    })

    // The undo names the one step that works: Lee arrives on the day Pat
    // left, so no Edit can give a night back.
    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status).toBe(409)
    expect(undo.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 2, 2026 and December 1, 2026, '
      + "so Pat Ruiz's stay can't be put back to December 1, 2026. Move that reservation first.")

    // An Edit save of the day they left changes nothing, and has nothing to
    // say about the lease: it already ends that day.
    const edit = await patchStay(f, stay, {
      guestName: 'Pat Ruiz', guestEmail: null, guestPhone: null,
      checkIn: '2026-09-01', checkOut: PHOENIX_TODAY, unitId: f.unitId, notes: null,
      requiredSiteLayout: 'none', requiredAmpService: 'none', avoidedUnitIds: [],
    })
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    expect(edit.body.leaseNote).toBeNull()
    await settle()
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '4500.00' })
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)

    // "Actually Pat left yesterday": the lease follows the corrected day.
    const fix = await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fix.status, JSON.stringify(fix.body)).toBe(200)
    expect(fix.body.leaseNote).toBeNull()
    await settle()
    const lease = await db.query<{ end_date: string }>(
      `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leases WHERE id = $1`, [leaseId])
    expect(lease.rows[0].end_date).toBe('2026-10-01')

    // Once Lee moves, the undo goes through and the lease runs to the booked day again.
    const other = await seedOtherSite(f, { nightly: 60, weekly: 350, monthly: 1500 })
    expect((await patchStay(f, leeId, { unitId: other })).status).toBe(200)
    const back = await patchStay(f, stay, { status: 'checked_in' })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body.checkOutRestored).toEqual({ from: '2026-10-01', to: '2026-12-01' })
    await settle()
    const after = await db.query<{ end_date: string }>(
      `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leases WHERE id = $1`, [leaseId])
    expect(after.rows[0].end_date).toBe('2026-12-01')
  })

  it('an undo refused over held nights names only a step that works', async () => {
    // The other reservation starts after the day they left: an Edit can still
    // give back the nights up to its arrival.
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    await seedStay(f, { checkIn: '2026-10-04', checkOut: '2026-10-06', status: 'confirmed', guestName: 'Lee Park' })
    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status).toBe(409)
    expect(undo.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 2, 2026 and October 6, 2026, '
      + "so Pat Ruiz's stay can't be put back to October 6, 2026. "
      + 'Move that reservation first, or use Edit to set a check-out no later than October 4, 2026 '
      + '(the stay is priced on the shorter dates), then set it back to Checked in.')
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '480.00' })
    // The path it names does what it says. The Edit is the landlord's
    // deliberate date change: the stay is then sold — and priced — for the
    // shorter dates (decisions #33), and is still Checked out...
    const edit = await patchStay(f, stay, { checkIn: '2026-09-28', checkOut: '2026-10-04', unitId: f.unitId })
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    const shorter = priceStay({ nightly: 60, weekly: 350, monthly: 1500 }, await taxPctOf(f), '2026-09-28', 6).total
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_out: '2026-10-04', nights: 6, total_amount: shorter.toFixed(2),
    })
    expect(await bookedCheckOut(stay)).toBe('2026-10-04')
    // ...until the second save sets it back to Checked in.
    const back = await patchStay(f, stay, { status: 'checked_in' })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_in', check_out: '2026-10-04', nights: 6, total_amount: shorter.toFixed(2),
    })

    // A site held some other way (here marked out of order after the guest
    // left) has to be freed first. With a lease, a save of the day they left
    // says the same.
    const g = await seedStayFixture()
    const { stay: long, leaseId } = await seedLongStayWithLease(g)
    expect((await patchStay(g, long, { status: 'checked_out' })).status).toBe(200)
    await db.query(
      `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason)
       VALUES ($1, $2, '2026-10-10', '2026-10-20', 'Pad repair')`, [g.unitId, g.landlordId])
    const undo2 = await patchStay(g, long, { status: 'checked_in' })
    expect(undo2.status).toBe(409)
    expect(undo2.body.error).toBe(
      "That site is out of order for those dates, so Pat Ruiz's stay can't be put back to December 1, 2026. "
      + 'Free those nights on the site first, then try again.')
    // 10/4 (decisions #38 Q8): the check-out already ended the lease on the day
    // they left, so a save of that day has nothing to say about it.
    const save = await patchStay(g, long, { checkIn: '2026-09-01', checkOut: PHOENIX_TODAY, unitId: g.unitId })
    expect(save.status, JSON.stringify(save.body)).toBe(200)
    expect(save.body.leaseNote).toBeNull()
    await settle()
    expect(await leaseMoney(leaseId)).toEqual(LEASE_ENDED_TODAY)

    // Fix round 6: the site is out of order for nights before the other
    // reservation starts. The Edit up to that reservation's arrival would run
    // into the out-of-order nights and fail, so no Edit is named. 10/3: and
    // moving the reservation alone would be refused again over those nights,
    // so both steps are named.
    const h = await seedStayFixture()
    const nightly = await seedStay(h, { checkIn: '2026-09-28', checkOut: '2026-10-20', total: 1320 })
    expect((await patchStay(h, nightly, { status: 'checked_out' })).status).toBe(200)
    await db.query(
      `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason)
       VALUES ($1, $2, '2026-10-04', '2026-10-06', 'Pad repair')`, [h.unitId, h.landlordId])
    await seedStay(h, { checkIn: '2026-10-12', checkOut: '2026-10-15', status: 'confirmed', guestName: 'Lee Park' })
    const undo3 = await patchStay(h, nightly, { status: 'checked_in' })
    expect(undo3.status).toBe(409)
    expect(undo3.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 2, 2026 and October 20, 2026, '
      + "so Pat Ruiz's stay can't be put back to October 20, 2026. "
      + 'Move that reservation and free those nights on the site first.')
    expect(await stayRow(nightly)).toMatchObject({
      status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '1320.00',
    })
    // The Edit the old wording named is indeed refused.
    const oldEdit = await patchStay(h, nightly, { checkIn: '2026-09-28', checkOut: '2026-10-12', unitId: h.unitId })
    expect(oldEdit.status).toBe(409)
    expect(await stayRow(nightly)).toMatchObject({ check_out: PHOENIX_TODAY, total_amount: '1320.00' })

    // Fix round 6: on a stay with a lease, that Edit is the landlord's
    // deliberate shortening (S548) — it would end the lease on that day, drop
    // November's rent and bank the rest. Staff putting the guest back are
    // never sent there: only the move is named, and the lease is untouched.
    // (Lee is seeded directly: the stay's own active lease keeps the create
    // route off these nights.)
    const k = await seedStayFixture()
    const { stay: leased, leaseId: leasedId } = await seedLongStayWithLease(k)
    expect((await patchStay(k, leased, { status: 'checked_out' })).status).toBe(200)
    await seedStay(k, { checkIn: '2026-10-10', checkOut: '2026-10-15', status: 'confirmed', guestName: 'Lee Park' })
    const undo4 = await patchStay(k, leased, { status: 'checked_in' })
    expect(undo4.status).toBe(409)
    expect(undo4.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 2, 2026 and December 1, 2026, '
      + "so Pat Ruiz's stay can't be put back to December 1, 2026. Move that reservation first.")
    await settle()
    expect(await stayRow(leased)).toMatchObject({
      status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '4500.00',
    })
    expect(await leaseMoney(leasedId)).toEqual(LEASE_ENDED_TODAY)

    // The same with an unsigned (pending) booking-draft lease, where the
    // create route does book the freed nights.
    const p = await seedStayFixture()
    const { stay: drafted, leaseId: draftId } = await seedLongStayWithLease(p)
    await db.query(`UPDATE leases SET status = 'pending' WHERE id = $1`, [draftId])
    expect((await patchStay(p, drafted, { status: 'checked_out' })).status).toBe(200)
    const lee = await request(buildUnitsApp())
      .post(`/api/units/${p.unitId}/bookings`)
      .set('Authorization', `Bearer ${p.token}`)
      .send({ leaseType: 'nightly', checkIn: '2026-10-10', checkOut: '2026-10-15', guestName: 'Lee Park' })
    expect(lee.status, JSON.stringify(lee.body)).toBe(201)
    const undo5 = await patchStay(p, drafted, { status: 'checked_in' })
    expect(undo5.status).toBe(409)
    expect(undo5.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 2, 2026 and December 1, 2026, '
      + "so Pat Ruiz's stay can't be put back to December 1, 2026. Move that reservation first.")
    await settle()
    expect(await stayRow(drafted)).toMatchObject({
      status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '4500.00',
    })
    // An unsigned draft simply follows the stay's dates (it bills nothing yet).
    expect(await leaseMoney(draftId)).toEqual({
      ...LEASE_UNTOUCHED, lease: { status: 'pending', end_date: PHOENIX_TODAY },
    })
  })

  // ── Fix round: nights given back are checked again at the moment of the write ──

  // A reservation for the nights Oct 3 to Oct 5 on the fixture's site, written
  // straight in by "somebody else" on their own connection.
  const NEXT_GUEST_SQL =
    `INSERT INTO unit_bookings
       (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
        total_amount, platform_fee, status, source)
     VALUES ($1, $2, 'Next Guest', 'nightly', '2026-10-03', '2026-10-05', 2, 120, 0, 'confirmed', 'direct')`

  // Wait until our request is queued behind a lock the test holds: a backend
  // of this database waiting on a lock while running a statement like `like`.
  async function waitForLockWait(like: string, waitEvent: string | null = null) {
    for (let i = 0; i < 250; i++) {
      const w = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND ($2::text IS NULL OR wait_event = $2) AND query LIKE $1`, [like, waitEvent])
      if (w.rows[0].n > 0) return
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`nothing waited on a lock while running ${like}`)
  }

  // Every stay on the site that holds any of the nights Oct 3 to Oct 5.
  const holdersOfOct3 = async (unitId: string) => (await db.query<{ guest_name: string }>(
    `SELECT guest_name FROM unit_bookings
      WHERE unit_id = $1 AND status NOT IN ('cancelled')
        AND check_in < '2026-10-05' AND check_out > '2026-10-03'
      ORDER BY guest_name`, [unitId])).rows.map(r => r.guest_name)

  const UNDO_REFUSED_OVER_NEXT_GUEST =
    'Another reservation now holds this site for some of the nights between October 2, 2026 and October 6, 2026, '
    + "so Pat Ruiz's stay can't be put back to October 6, 2026. "
    + 'Move that reservation first, or use Edit to set a check-out no later than October 3, 2026 '
    + '(the stay is priced on the shorter dates), then set it back to Checked in.'

  it('an undo is refused when somebody books the freed nights while it waits, and nothing changes', async () => {
    // The review's probe: another desk holds this stay a moment, our undo
    // waits for it, and in that moment a reservation lands on the nights the
    // check-out freed. The undo used to check the site only before it waited,
    // and both stays ended up holding Oct 3 to Oct 5.
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    await settle()
    const other = await db.connect()
    let res: request.Response
    try {
      await other.query('BEGIN')
      await other.query(`SELECT 1 FROM unit_bookings WHERE id = $1 FOR UPDATE`, [stay])
      const undo = patchStay(f, stay, { status: 'checked_in' }).then(r => r)
      await waitForLockWait('%FROM unit_bookings WHERE id = $1 FOR UPDATE%')
      await other.query(NEXT_GUEST_SQL, [f.landlordId, f.unitId])
      await other.query('COMMIT')
      res = await undo
    } finally { other.release() }
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe(UNDO_REFUSED_OVER_NEXT_GUEST)
    await settle()
    expect(await stayRow(stay)).toMatchObject({
      status: 'checked_out', check_out: PHOENIX_TODAY, nights: 4, total_amount: '480.00',
    })
    expect(await holdersOfOct3(f.unitId)).toEqual(['Next Guest'])
  })

  it('an undo waits for a sale or a booking-page booking on the same site, and is refused if it took the nights', async () => {
    // The register (services/registerStay) and the booking page
    // (services/propertyBooking) each serialize on their own per-site key.
    // The undo now takes both, so whichever of them is mid-booking finishes
    // first and the undo then sees what it booked.
    const keys = [
      { lockSql: `SELECT pg_advisory_xact_lock(hashtext($1))`, key: (u: string) => `unit-booking:${u}`,
        waitsOn: '%pg_advisory_xact_lock(hashtext($1))%' },
      { lockSql: `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key: (u: string) => `unit_booking:${u}`,
        waitsOn: '%pg_advisory_xact_lock(hashtextextended($1, 0))%' },
    ]
    for (const k of keys) {
      const f = await seedStayFixture()
      const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
      expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
      await settle()
      const other = await db.connect()
      let res: request.Response
      try {
        await other.query('BEGIN')
        await other.query(k.lockSql, [k.key(f.unitId)])
        const undo = patchStay(f, stay, { status: 'checked_in' }).then(r => r)
        await waitForLockWait(k.waitsOn, 'advisory')
        await other.query(NEXT_GUEST_SQL, [f.landlordId, f.unitId])
        await other.query('COMMIT')
        res = await undo
      } finally { other.release() }
      expect(res.status, `${k.waitsOn} ${JSON.stringify(res.body)}`).toBe(409)
      expect(res.body.error).toBe(UNDO_REFUSED_OVER_NEXT_GUEST)
      expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, nights: 4 })
      expect(await holdersOfOct3(f.unitId)).toEqual(['Next Guest'])
    }
  })

  it('a cancelled reservation brought back while somebody books its nights is refused, and nothing changes', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-10-03', checkOut: '2026-10-05', status: 'cancelled', total: 120 })
    const other = await db.connect()
    let res: request.Response
    try {
      await other.query('BEGIN')
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${f.unitId}`])
      const back = patchStay(f, stay, { status: 'confirmed' }).then(r => r)
      await waitForLockWait('%pg_advisory_xact_lock(hashtext($1))%', 'advisory')
      await other.query(NEXT_GUEST_SQL, [f.landlordId, f.unitId])
      await other.query('COMMIT')
      res = await back
    } finally { other.release() }
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe(
      "Another reservation now holds this site for some of Pat Ruiz's nights. "
      + 'Move that reservation first, or give Pat Ruiz new dates with Edit.')
    expect(await stayRow(stay)).toMatchObject({ status: 'cancelled', check_in: '2026-10-03', check_out: '2026-10-05' })
    expect(await holdersOfOct3(f.unitId)).toEqual(['Next Guest'])
  })

  it('a reservation made on the schedule waits for a sale on the same site, and is refused if the sale took the nights', async () => {
    // The schedule's own create path now takes the same per-site locks, so a
    // stay put back by an undo (or sold at the register) and a new
    // reservation cannot both pass their checks before either is stored.
    const f = await seedStayFixture()
    const other = await db.connect()
    let res: request.Response
    try {
      await other.query('BEGIN')
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${f.unitId}`])
      const made = request(buildUnitsApp())
        .post(`/api/units/${f.unitId}/bookings`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ leaseType: 'nightly', checkIn: '2026-10-04', checkOut: '2026-10-06', guestName: 'Walk In' })
        .then(r => r)
      await waitForLockWait('%pg_advisory_xact_lock(hashtext($1))%', 'advisory')
      await other.query(NEXT_GUEST_SQL, [f.landlordId, f.unitId])
      await other.query('COMMIT')
      res = await made
    } finally { other.release() }
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe('Unit is already booked for those dates')
    expect(await holdersOfOct3(f.unitId)).toEqual(['Next Guest'])
    const walkIn = await db.query(`SELECT 1 FROM unit_bookings WHERE unit_id = $1 AND guest_name = 'Walk In'`, [f.unitId])
    expect(walkIn.rows).toHaveLength(0)
  })

  // ── Fix round 6: an extension's move of the next guest, and two reservations at once ──

  // More sites at the fixture's park that the extension rule (W-20) can move a
  // reservation onto, and that a moved unpaid hold can go to: the same type,
  // vacant, taking nightly and weekly stays. The fixture's own site too.
  async function movableSites(f: StayFixture, n: number): Promise<string[]> {
    const more: string[] = []
    for (let i = 0; i < n; i++) more.push(await seedOtherSite(f, { nightly: 60, weekly: 350, monthly: 1500 }))
    await db.query(
      `UPDATE units SET lease_types_allowed = '{nightly,weekly}', status = 'vacant' WHERE id = ANY($1::uuid[])`,
      [[f.unitId, ...more]])
    return more
  }

  async function stayOn(f: StayFixture, unitId: string, o: {
    checkIn: string; checkOut: string; status: string; guestName: string; total: number
  }): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
          total_amount, platform_fee, status, source)
       VALUES ($1, $2, $3, 'nightly', $4::date, $5::date, ($5::date - $4::date), $6, 0, $7, 'direct')
       RETURNING id`, [f.landlordId, unitId, o.guestName, o.checkIn, o.checkOut, o.total, o.status])
    return r.rows[0].id
  }

  const siteOf = async (bookingId: string) => (await db.query<{ unit_id: string }>(
    `SELECT unit_id FROM unit_bookings WHERE id = $1`, [bookingId])).rows[0].unit_id

  // No night on any of these sites is held by two stays.
  async function expectNoSharedNights(unitIds: string[]) {
    const shared = await db.query(
      `SELECT a.id FROM unit_bookings a JOIN unit_bookings b
          ON b.unit_id = a.unit_id AND b.id > a.id
         AND b.check_in < a.check_out AND b.check_out > a.check_in
       WHERE a.unit_id = ANY($1::uuid[])
         AND a.status <> 'cancelled' AND b.status <> 'cancelled'`, [unitIds])
    expect(shared.rows).toHaveLength(0)
  }

  it('an extension refused as changed by someone else leaves the next guest where they were', async () => {
    // The review's probe: Pat (Sep 28 to Oct 6) is extended to Oct 8 while
    // Next Guest holds Oct 6 to Oct 9 on the same site. Another desk is
    // mid-save on Pat's stay and moves her arrival. The extension used to move
    // Next Guest to the other site first, then find Pat changed and refuse —
    // leaving Next Guest moved for an extension that never happened.
    const f = await seedStayFixture()
    const [s2] = await movableSites(f, 1)
    const pat = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const next = await stayOn(f, f.unitId, {
      checkIn: '2026-10-06', checkOut: '2026-10-09', status: 'confirmed', guestName: 'Next Guest', total: 180,
    })
    const other = await db.connect()
    let res: request.Response
    // Whether the move of Next Guest ran at all: the refusal now comes first.
    let moveRan = false
    relocationHook.afterRelocation = async () => { moveRan = true }
    try {
      await other.query('BEGIN')
      await other.query(`SELECT 1 FROM unit_bookings WHERE id = $1 FOR UPDATE`, [pat])
      const ext = patchStay(f, pat, { checkOut: '2026-10-08' }).then(r => r)
      await waitForLockWait('%FROM unit_bookings WHERE id = $1 FOR UPDATE%')
      await other.query(`UPDATE unit_bookings SET check_in = '2026-09-27', nights = nights + 1 WHERE id = $1`, [pat])
      await other.query('COMMIT')
      res = await ext
    } finally { other.release(); relocationHook.afterRelocation = null }
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.code).toBe('reservation_changed')
    expect(res.body.data).toMatchObject({ id: pat })
    expect(await stayRow(pat)).toMatchObject({ check_in: '2026-09-27', check_out: '2026-10-06', total_amount: '480.00' })
    expect(moveRan).toBe(false)
    expect(await siteOf(next)).toBe(f.unitId)

    // Sent again, with nobody else mid-save, the extension moves Next Guest
    // and is saved — the move itself still works.
    const again = await patchStay(f, pat, { checkOut: '2026-10-08' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(await siteOf(next)).toBe(s2)
    expect(await stayRow(pat)).toMatchObject({ check_out: '2026-10-08' })
    await expectNoSharedNights([f.unitId, s2])
  })

  it('an extension refused after the next guest was moved puts them back, unless their nights were taken', async () => {
    // Somebody else's change lands the moment the move is written: the save
    // finds Pat changed and refuses, and Next Guest goes back to the site.
    const f = await seedStayFixture()
    const [s2] = await movableSites(f, 1)
    const pat = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const next = await stayOn(f, f.unitId, {
      checkIn: '2026-10-06', checkOut: '2026-10-09', status: 'confirmed', guestName: 'Next Guest', total: 180,
    })
    let movedAway = false
    relocationHook.afterRelocation = async () => {
      relocationHook.afterRelocation = null
      movedAway = (await siteOf(next)) === s2
      await db.query(`UPDATE unit_bookings SET check_in = '2026-09-27', nights = nights + 1 WHERE id = $1`, [pat])
    }
    let res: request.Response
    try { res = await patchStay(f, pat, { checkOut: '2026-10-08' }) }
    finally { relocationHook.afterRelocation = null }
    expect(movedAway).toBe(true)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.code).toBe('reservation_changed')
    expect(await siteOf(next)).toBe(f.unitId)
    expect(await stayRow(pat)).toMatchObject({ check_in: '2026-09-27', check_out: '2026-10-06' })
    await expectNoSharedNights([f.unitId, s2])

    // A walk-in is booked onto the nights the move freed before the save:
    // the extension is refused, and Next Guest stays on the site they were
    // moved to — their old nights are taken, and nobody shares a night.
    const g = await seedStayFixture()
    const [g2] = await movableSites(g, 1)
    const pat2 = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const next2 = await stayOn(g, g.unitId, {
      checkIn: '2026-10-06', checkOut: '2026-10-09', status: 'confirmed', guestName: 'Next Guest', total: 180,
    })
    relocationHook.afterRelocation = async () => {
      relocationHook.afterRelocation = null
      await stayOn(g, g.unitId, {
        checkIn: '2026-10-06', checkOut: '2026-10-08', status: 'confirmed', guestName: 'Walk In', total: 120,
      })
    }
    let res2: request.Response
    try { res2 = await patchStay(g, pat2, { checkOut: '2026-10-08' }) }
    finally { relocationHook.afterRelocation = null }
    expect(res2.status, JSON.stringify(res2.body)).toBe(409)
    expect(res2.body.error).toBe('Unit is already booked for those dates')
    expect(await stayRow(pat2)).toMatchObject({ check_out: '2026-10-06' })
    expect(await siteOf(next2)).toBe(g2)
    await expectNoSharedNights([g.unitId, g2])
  })

  it('a guest moved for a refused extension goes back while a pay link is sent for their site: neither is ended by a deadlock', async () => {
    // The review's reasoning (fix pass): putting Next Guest back took the
    // stay's row and the site first and reached the site's own row last (the
    // write's foreign-key check), while a pay link being sent for that site
    // holds the row and then waits for the site — the two ended each other
    // with a deadlock and the link answered with a 500 at the counter. Now
    // the put-back takes the site's row first, like a move on the schedule.
    const f = await seedStayFixture()
    const [s2] = await movableSites(f, 1)
    const pat = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const next = await stayOn(f, f.unitId, {
      checkIn: '2026-10-06', checkOut: '2026-10-09', status: 'confirmed', guestName: 'Next Guest', total: 180,
    })
    const { createStayBooking } = await import('../services/registerStay')
    const link = await db.connect()
    let linkSent: Promise<unknown> = Promise.resolve()
    let linkError: unknown = null
    let linkStarted = false
    // Somebody else's change lands the moment the move is written, so the
    // extension is refused and Next Guest is put back.
    relocationHook.afterRelocation = async () => {
      relocationHook.afterRelocation = null
      await db.query(`UPDATE unit_bookings SET check_in = '2026-09-27', nights = nights + 1 WHERE id = $1`, [pat])
    }
    // The moment the put-back checks Next Guest's old nights, a pay link is
    // sent for that site, in the link's own order: the site's row, then the site.
    conflictCheckHook.beforeCheck = async (_unitId, w) => {
      if (w.excludeBookingId !== next) return
      conflictCheckHook.beforeCheck = null
      linkStarted = true
      linkSent = (async () => {
        await link.query('BEGIN')
        await link.query(`SELECT id FROM units WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [f.unitId, f.landlordId])
        await createStayBooking(link, {
          landlordId: f.landlordId, propertyId: f.propertyId, posTransactionId: null, status: 'tentative',
          lines: [{ itemId: randomUUID(), qty: 2, stayUnit: 'night', lineTotal: 120, name: 'Nightly stay' }],
          details: { unitId: f.unitId, checkIn: '2026-10-20', guestName: 'Link Guest' },
        })
        await link.query('COMMIT')
      })().catch(async (e: unknown) => { linkError = e; await link.query('ROLLBACK').catch(() => {}) })
      // The link is now waiting on a lock the put-back holds.
      await waitForWaiters(1)
    }
    let res: request.Response
    try {
      res = await patchStay(f, pat, { checkOut: '2026-10-08' })
      await linkSent
    } finally {
      relocationHook.afterRelocation = null
      conflictCheckHook.beforeCheck = null
      link.release()
    }
    expect(linkStarted).toBe(true)
    expect(linkError, String((linkError as { message?: string } | null)?.message)).toBeNull()
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.code).toBe('reservation_changed')
    expect(await siteOf(next)).toBe(f.unitId)
    expect(await guestOn(f.unitId, 'Link Guest')).toEqual([{ ci: '2026-10-20', co: '2026-10-22' }])
    expect(await stayRow(pat)).toMatchObject({ check_in: '2026-09-27', check_out: '2026-10-06' })
    await expectNoSharedNights([f.unitId, s2])
  })

  it('when the extending guest moves to another site instead, a guest moved for them goes back', async () => {
    // Pat extends to Oct 9. Next Guest (Oct 6 to Oct 7) can be moved; the one
    // after (Oct 7 to Oct 9) was already told their site and cannot. So Pat
    // moves to a site where the whole stay fits (W-20 fallback) — and Next
    // Guest, moved to make room on a site Pat then left, goes back to it.
    const f = await seedStayFixture()
    const [s2, s3] = await movableSites(f, 2)
    const pat = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const next = await stayOn(f, f.unitId, {
      checkIn: '2026-10-06', checkOut: '2026-10-07', status: 'confirmed', guestName: 'Next Guest', total: 60,
    })
    const told = await stayOn(f, f.unitId, {
      checkIn: '2026-10-07', checkOut: '2026-10-09', status: 'confirmed', guestName: 'Told Guest', total: 120,
    })
    await db.query(`UPDATE unit_bookings SET site_reveal_sent_at = NOW() WHERE id = $1`, [told])
    const res = await patchStay(f, pat, { checkOut: '2026-10-09' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.extendedGuestMovedTo?.unitId).toBeDefined()
    expect([s2, s3]).toContain(res.body.extendedGuestMovedTo.unitId)
    expect(await siteOf(pat)).toBe(res.body.extendedGuestMovedTo.unitId)
    expect(await siteOf(next)).toBe(f.unitId)
    expect(await siteOf(told)).toBe(f.unitId)
    await expectNoSharedNights([f.unitId, s2, s3])
  })

  it('the history names the length the stay was sold for, the way readers of the stored dates can find it', async () => {
    // The contract other readers rely on until the stay keeps its booked
    // check-out in a column of its own (short-stay tax on stay deposits, the
    // register's "what is left to pay", GAM's short-stay revenue split): the
    // latest 'dates_changed' event, when it is marked early_check_out and its
    // `to` is the stored dates, carries the booked check-out. Pinned here in
    // SQL, as those readers would write it.
    const BOOKED_NIGHTS_SQL = `
      SELECT COALESCE((
        SELECT (e.detail->>'booked_check_out')::date
          FROM (SELECT ev.detail FROM unit_booking_events ev
                 WHERE ev.booking_id = b.id AND ev.event_type = 'dates_changed'
                 ORDER BY ev.created_at DESC, ev.id DESC LIMIT 1) e
         WHERE (e.detail->>'early_check_out')::boolean IS TRUE
           AND e.detail->'to'->>'check_in'  = to_char(b.check_in,  'YYYY-MM-DD')
           AND e.detail->'to'->>'check_out' = to_char(b.check_out, 'YYYY-MM-DD')
           AND (e.detail->>'booked_check_out')::date > b.check_out
      ), b.check_out) - b.check_in AS n
        FROM unit_bookings b WHERE b.id = $1`
    const bookedNights = async (id: string) => (await db.query<{ n: number }>(BOOKED_NIGHTS_SQL, [id])).rows[0].n
    const f = await seedStayFixture()
    // Sold Sep 28 to Oct 30: 32 nights, untaxed; the guest leaves Oct 2.
    // (Seeded straight into the table the way a path that does not know the
    // column writes it: booked_check_out is empty, so it reads as check_out.)
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-30', total: 1500 })
    expect(await bookedNights(stay)).toBe(32)
    expect(await bookedCheckOut(stay)).toBeNull()
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ check_out: PHOENIX_TODAY, nights: 4 })
    expect(await bookedNights(stay)).toBe(32)
    // 10/3 (decisions #33): the column keeps the day it was sold to, from the
    // check-out on — the early check-out moved check_out only.
    expect(await bookedCheckOut(stay)).toBe('2026-10-30')
    // An arrival-day correction after it carries the booked day forward.
    expect((await patchStay(f, stay, { checkIn: '2026-09-29' })).status).toBe(200)
    expect(await bookedNights(stay)).toBe(31)
    expect(await bookedCheckOut(stay)).toBe('2026-10-30')
    // The undo puts the booked day back in the stored dates themselves.
    expect((await patchStay(f, stay, { status: 'checked_in' })).status).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ check_out: '2026-10-30' })
    expect(await bookedNights(stay)).toBe(31)
    expect(await bookedCheckOut(stay)).toBe('2026-10-30')
    // The landlord's deliberate shortening is a new length of stay.
    expect((await patchStay(f, stay, { checkOut: '2026-10-10' })).status).toBe(200)
    await settle()
    expect(await bookedNights(stay)).toBe(11)
    expect(await bookedCheckOut(stay)).toBe('2026-10-10')
    // A reservation made on the schedule is stored with the length it was sold for.
    const made = await request(buildUnitsApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseType: 'nightly', checkIn: '2026-11-02', checkOut: '2026-11-06', guestName: 'Lee Park' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(await bookedCheckOut(made.body.data.id)).toBe('2026-11-06')
  })

  it('two paid reservations made at the same moment, each moving a hold onto the other site, are both saved', async () => {
    // The review's probe: Hold One holds site 1 Oct 3 to 5 and Hold Two holds
    // site 2 Oct 10 to 12, both unpaid. Paid reservations for exactly those
    // nights arrive together. Each moves its hold onto the other site, which
    // the other one holds. That used to end one of them with a deadlock (a 500
    // with the database's own text). Now each takes its own site first, gives
    // up the other's instead of waiting for it, and saves again from the top
    // until one has gone first.
    const f = await seedStayFixture()
    const [s2] = await movableSites(f, 1)
    const s1 = f.unitId
    const hold1 = await stayOn(f, s1, {
      checkIn: '2026-10-03', checkOut: '2026-10-05', status: 'tentative', guestName: 'Hold One', total: 120,
    })
    const hold2 = await stayOn(f, s2, {
      checkIn: '2026-10-10', checkOut: '2026-10-12', status: 'tentative', guestName: 'Hold Two', total: 120,
    })
    const post = (unitId: string, checkIn: string, checkOut: string, guestName: string) =>
      request(buildUnitsApp())
        .post(`/api/units/${unitId}/bookings`)
        .set('Authorization', `Bearer ${f.token}`)
        .send({ leaseType: 'nightly', checkIn, checkOut, guestName })
        .then(r => r)
    // Line them up: both stop at the site their hold moves to, then go together.
    const other = await db.connect()
    let a: request.Response, b: request.Response
    try {
      await other.query('BEGIN')
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s1}`])
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s2}`])
      const pa = post(s1, '2026-10-03', '2026-10-05', 'Payer A')
      const pb = post(s2, '2026-10-10', '2026-10-12', 'Payer B')
      for (let i = 0; i < 250; i++) {
        const w = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event = 'advisory'`)
        if (w.rows[0].n >= 2) break
        await new Promise(r => setTimeout(r, 20))
      }
      await other.query('COMMIT')
      ;[a, b] = await Promise.all([pa, pb])
    } finally { other.release() }
    expect(a.status, JSON.stringify(a.body)).toBe(201)
    expect(b.status, JSON.stringify(b.body)).toBe(201)
    expect(await siteOf(hold1)).toBe(s2)
    expect(await siteOf(hold2)).toBe(s1)
    const payers = await db.query<{ guest_name: string; unit_id: string }>(
      `SELECT guest_name, unit_id FROM unit_bookings WHERE guest_name IN ('Payer A', 'Payer B') ORDER BY guest_name`)
    expect(payers.rows).toEqual([{ guest_name: 'Payer A', unit_id: s1 }, { guest_name: 'Payer B', unit_id: s2 }])
    await expectNoSharedNights([s1, s2])
  })

  // ── 10/3: a timed hold, a hold already moved, and holds that land while a save waits ──

  // An unpaid hold on the fixture's site for the nights Oct 3 to Oct 5.
  async function holdOn(f: StayFixture, unitId: string, o: { guestName: string; timed?: boolean; movedFrom?: string }) {
    return (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
          total_amount, platform_fee, status, source, hold_expires_at, displaced_at, displaced_from_unit)
       VALUES ($1, $2, $3, 'nightly', '2026-10-03', '2026-10-05', 2, 120, 0, 'tentative', 'direct',
               CASE WHEN $4 THEN NOW() + INTERVAL '30 minutes' END,
               CASE WHEN $5::uuid IS NOT NULL THEN NOW() END, $5::uuid)
       RETURNING id`,
      [f.landlordId, unitId, o.guestName, o.timed === true, o.movedFrom ?? null])).rows[0].id
  }
  const bookOct3 = (f: StayFixture, unitId: string, guestName: string) => request(buildUnitsApp())
    .post(`/api/units/${unitId}/bookings`)
    .set('Authorization', `Bearer ${f.token}`)
    .send({ leaseType: 'nightly', checkIn: '2026-10-03', checkOut: '2026-10-05', guestName })
    .then(r => r)

  it('a reservation made on the schedule is refused over a guest paying online right now', async () => {
    // A guest on the booking page holds the site for the minutes it takes to
    // pay (a timed hold). A paid reservation on the schedule used to step over
    // it — the online guest's money then landed for a site sold twice.
    const f = await seedStayFixture()
    await movableSites(f, 1)
    const online = await holdOn(f, f.unitId, { guestName: 'Online Guest', timed: true })
    const res = await bookOct3(f, f.unitId, 'Walk In')
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe('Unit is already booked for those dates')
    expect(await holdersOfOct3(f.unitId)).toEqual(['Online Guest'])
    expect(await siteOf(online)).toBe(f.unitId)

    // A hold already moved once for somebody who paid is not moved again (the
    // register keeps it off its list too): refused the same way.
    const g = await seedStayFixture()
    const [g2] = await movableSites(g, 1)
    const moved = await holdOn(g, g.unitId, { guestName: 'Moved Guest', movedFrom: g2 })
    const res2 = await bookOct3(g, g.unitId, 'Walk In')
    expect(res2.status, JSON.stringify(res2.body)).toBe(409)
    expect(await holdersOfOct3(g.unitId)).toEqual(['Moved Guest'])
    expect(await siteOf(moved)).toBe(g.unitId)

    // An unpaid hold with no clock still yields to the guest who pays.
    const h = await seedStayFixture()
    const [h2] = await movableSites(h, 1)
    const plain = await holdOn(h, h.unitId, { guestName: 'Plain Hold' })
    const res3 = await bookOct3(h, h.unitId, 'Walk In')
    expect(res3.status, JSON.stringify(res3.body)).toBe(201)
    expect(await siteOf(plain)).toBe(h2)
    await expectNoSharedNights([h.unitId, h2])
  })

  it('a paid reservation waiting for its site moves a hold that lands there meanwhile, or is refused over one already moved', async () => {
    // The review's probe (V8): this save cleared the site's unpaid holds, then
    // waited for the site. A hold that landed on the site in that wait was
    // neither moved nor refused, and two stays shared Oct 3 to Oct 5.
    for (const variant of ['new hold', 'moved here by a sale'] as const) {
      const f = await seedStayFixture()
      const [s2, s3] = await movableSites(f, 2)
      const s1 = f.unitId
      // The other variant's hold starts on site 2, where a sale will take it from.
      const away = variant === 'moved here by a sale' ? await holdOn(f, s2, { guestName: 'Hold H' }) : null
      const other = await db.connect()
      let res: request.Response
      let hold = away
      try {
        await other.query('BEGIN')
        await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s1}`])
        const made = bookOct3(f, s1, 'Payer A')
        await waitForLockWait('%pg_advisory_xact_lock(hashtext($1))%', 'advisory')
        if (variant === 'new hold') {
          // A pay link sent for site 1 while this save waited.
          hold = (await other.query<{ id: string }>(
            `INSERT INTO unit_bookings
               (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
                total_amount, platform_fee, status, source)
             VALUES ($1, $2, 'Hold H', 'nightly', '2026-10-03', '2026-10-05', 2, 120, 0, 'tentative', 'register')
             RETURNING id`, [f.landlordId, s1])).rows[0].id
        } else {
          // A sale on site 2 moves Hold H onto site 1 (holdDisplacement) and takes site 2.
          await other.query(
            `UPDATE unit_bookings SET unit_id = $2, displaced_at = NOW(), displaced_from_unit = $3 WHERE id = $1`,
            [away, s1, s2])
          await other.query(
            `INSERT INTO unit_bookings
               (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights,
                total_amount, platform_fee, status, source, deposit_paid_at)
             VALUES ($1, $2, 'Sale', 'nightly', '2026-10-03', '2026-10-05', 2, 120, 0, 'confirmed', 'register', NOW())`,
            [f.landlordId, s2])
        }
        await other.query('COMMIT')
        res = await made
      } finally { other.release() }
      if (variant === 'new hold') {
        // Moved to a free site, and the paid reservation has site 1.
        expect(res.status, `${variant} ${JSON.stringify(res.body)}`).toBe(201)
        expect([s2, s3]).toContain(await siteOf(hold!))
        expect(await holdersOfOct3(s1)).toEqual(['Payer A'])
      } else {
        // Already moved once: it keeps site 1 and the payer is told the site is taken.
        expect(res.status, `${variant} ${JSON.stringify(res.body)}`).toBe(409)
        expect(res.body.error).toBe('Unit is already booked for those dates')
        expect(await holdersOfOct3(s1)).toEqual(['Hold H'])
      }
      await expectNoSharedNights([s1, s2, s3])
    }
  })

  it('a register sale holding a hold on the site is never ended by a paid reservation waiting for that site', async () => {
    // The review's probe G: a paid reservation waits for site 1; an unpaid
    // hold lands on site 1; the register's sale locks that hold (to move it)
    // and waits for site 1 too. The reservation then got site 1 and waited
    // for the hold — each waiting on the other — and the database ended the
    // register's sale with a deadlock error. Now the reservation never waits
    // for a hold while it has the site: it lets go and saves again from the
    // top, the sale goes through, and the reservation is told the site is taken.
    const f = await seedStayFixture()
    const [s2] = await movableSites(f, 1)
    const s1 = f.unitId
    const { clearUnpaidHolds } = await import('../services/holdDisplacement')
    const { createStayBooking } = await import('../services/registerStay')
    const holder = await db.connect()
    const register = await db.connect()
    let res: request.Response
    let saleError: unknown = null
    try {
      // Somebody else is booking site 1, so the reservation waits for it.
      await holder.query('BEGIN')
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s1}`])
      const made = bookOct3(f, s1, 'Payer A')
      await waitForLockWait('%pg_advisory_xact_lock(hashtext($1))%', 'advisory')
      // A pay link sent for site 1 meanwhile.
      const hold = await holdOn(f, s1, { guestName: 'Hold H' })
      // The register's sale, in its own order: the hold first (moved to site
      // 2), then site 1 itself, which it waits for.
      await register.query('BEGIN')
      await clearUnpaidHolds(register, s1, '2026-10-03', '2026-10-05', 'A paid sale at the counter took this site')
      const sale = createStayBooking(register, {
        landlordId: f.landlordId, propertyId: f.propertyId, posTransactionId: null,
        lines: [{ itemId: randomUUID(), qty: 2, stayUnit: 'night', lineTotal: 120, name: 'Nightly stay' }],
        details: { unitId: s1, checkIn: '2026-10-03', guestName: 'Register Sale' },
      }).catch((e: unknown) => { saleError = e; return null })
      for (let i = 0; i < 250; i++) {
        const w = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event = 'advisory'`)
        if (w.rows[0].n >= 2) break
        await new Promise(r => setTimeout(r, 20))
      }
      // Site 1 is let go: the reservation is first in line for it.
      await new Promise(r => setTimeout(r, 500))
      await holder.query('COMMIT')
      const sold = await sale
      expect(saleError, String((saleError as { message?: string } | null)?.message)).toBeNull()
      expect(sold).not.toBeNull()
      await register.query('COMMIT')
      res = await made
      expect(await siteOf(hold)).toBe(s2)
    } finally {
      await register.query('ROLLBACK').catch(() => {})
      holder.release(); register.release()
    }
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe('Unit is already booked for those dates')
    expect(await holdersOfOct3(s1)).toEqual(['Register Sale'])
    await expectNoSharedNights([s1, s2])
  })

  // ── 10/3 (fix round 3): a paid reservation never ends a register sale or a pay link with a deadlock ──

  // An unpaid hold on any nights (holdOn above is Oct 3 to Oct 5 only).
  const holdFor = (f: StayFixture, unitId: string, checkIn: string, checkOut: string, guestName: string) =>
    stayOn(f, unitId, { checkIn, checkOut, status: 'tentative', guestName, total: 120 })
  const bookPaid = (f: StayFixture, unitId: string, checkIn: string, checkOut: string, guestName: string) =>
    request(buildUnitsApp())
      .post(`/api/units/${unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ leaseType: 'nightly', checkIn, checkOut, guestName })
      .then(r => r)
  // The register's sale of a stay, in its own order (pos.ts POST /transactions):
  // the unpaid holds on its site first (moved elsewhere), then the site itself.
  const registerSale = async (f: StayFixture, c: import('pg').PoolClient, unitId: string, checkIn: string, nights: number) => {
    const { clearUnpaidHolds } = await import('../services/holdDisplacement')
    const { createStayBooking, checkOutFor } = await import('../services/registerStay')
    await clearUnpaidHolds(c, unitId, checkIn, checkOutFor(checkIn, 'night', nights), 'A paid sale at the counter took this site')
    return createStayBooking(c, {
      landlordId: f.landlordId, propertyId: f.propertyId, posTransactionId: null,
      lines: [{ itemId: randomUUID(), qty: nights, stayUnit: 'night', lineTotal: 60 * nights, name: 'Nightly stay' }],
      details: { unitId, checkIn, guestName: 'Register Sale' },
    })
  }
  // Wait until this many saves are waiting on a lock of any kind.
  async function waitForWaiters(n: number) {
    for (let i = 0; i < 250; i++) {
      const w = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`)
      if (w.rows[0].n >= n) return
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`fewer than ${n} saves waited on a lock`)
  }
  const guestOn = async (unitId: string, guestName: string) => (await db.query<{ ci: string; co: string }>(
    `SELECT to_char(check_in, 'YYYY-MM-DD') AS ci, to_char(check_out, 'YYYY-MM-DD') AS co
       FROM unit_bookings WHERE unit_id = $1 AND guest_name = $2 AND status <> 'cancelled'`, [unitId, guestName])).rows

  it('a register sale moving a hold onto the site a paid reservation is clearing is never ended by a deadlock', async () => {
    // The review's probe PE: a paid reservation for site 1 (Oct 3 to 5) moves
    // Hold One to site 2; at the same moment the register sells site 2 (Oct 10
    // to 12) and moves Hold Two to site 1. The reservation used to take site 2
    // (where its hold went) and then wait for site 1, while the sale held site
    // 1 (where its hold went) and waited for site 2: the database ended the
    // sale (a 500 at the counter). Now the reservation takes its own site
    // first and never waits on anything after that, so both go through.
    for (let run = 0; run < 3; run++) {
      const f = await seedStayFixture()
      const [s2] = await movableSites(f, 1)
      const s1 = f.unitId
      const holdOne = await holdFor(f, s1, '2026-10-03', '2026-10-05', 'Hold One')
      const holdTwo = await holdFor(f, s2, '2026-10-10', '2026-10-12', 'Hold Two')
      const other = await db.connect()
      const register = await db.connect()
      let res: request.Response
      let saleError: unknown = null
      try {
        // Somebody else is on both sites, so the two line up behind them.
        await other.query('BEGIN')
        await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s1}`])
        await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s2}`])
        const made = bookPaid(f, s1, '2026-10-03', '2026-10-05', 'Payer A')
        await register.query('BEGIN')
        const sale = registerSale(f, register, s2, '2026-10-10', 2).catch((e: unknown) => { saleError = e; return null })
        await waitForWaiters(2)
        await other.query('COMMIT')
        const sold = await sale
        expect(saleError, String((saleError as { message?: string } | null)?.message)).toBeNull()
        expect(sold).not.toBeNull()
        await register.query('COMMIT')
        res = await made
      } finally {
        await register.query('ROLLBACK').catch(() => {})
        other.release(); register.release()
      }
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(await siteOf(holdOne)).toBe(s2)
      expect(await siteOf(holdTwo)).toBe(s1)
      expect(await guestOn(s1, 'Payer A')).toEqual([{ ci: '2026-10-03', co: '2026-10-05' }])
      expect(await guestOn(s2, 'Register Sale')).toEqual([{ ci: '2026-10-10', co: '2026-10-12' }])
      await expectNoSharedNights([s1, s2])
    }
  })

  it('a register sale and a paid reservation on the same site, each moving its own hold to the same free site, both go through', async () => {
    // Site 1 has Hold One (Oct 3 to 5) and Hold Two (Oct 10 to 12); site 2 is
    // free. A paid reservation takes Oct 3 to 5 while the register sells Oct
    // 10 to 12. The sale holds site 2 (where Hold Two goes) and waits for site
    // 1; a reservation that held site 1 and then WAITED for site 2 (where Hold
    // One goes) would be the other half of a deadlock that ends the sale.
    for (let run = 0; run < 3; run++) {
      const f = await seedStayFixture()
      const [s2] = await movableSites(f, 1)
      const s1 = f.unitId
      const holdOne = await holdFor(f, s1, '2026-10-03', '2026-10-05', 'Hold One')
      const holdTwo = await holdFor(f, s1, '2026-10-10', '2026-10-12', 'Hold Two')
      const other = await db.connect()
      const register = await db.connect()
      let res: request.Response
      let saleError: unknown = null
      try {
        await other.query('BEGIN')
        await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s1}`])
        await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s2}`])
        const made = bookPaid(f, s1, '2026-10-03', '2026-10-05', 'Payer A')
        await register.query('BEGIN')
        const sale = registerSale(f, register, s1, '2026-10-10', 2).catch((e: unknown) => { saleError = e; return null })
        await waitForWaiters(2)
        await other.query('COMMIT')
        const sold = await sale
        expect(saleError, String((saleError as { message?: string } | null)?.message)).toBeNull()
        expect(sold).not.toBeNull()
        await register.query('COMMIT')
        res = await made
      } finally {
        await register.query('ROLLBACK').catch(() => {})
        other.release(); register.release()
      }
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(await siteOf(holdOne)).toBe(s2)
      expect(await siteOf(holdTwo)).toBe(s2)
      expect(await guestOn(s1, 'Payer A')).toEqual([{ ci: '2026-10-03', co: '2026-10-05' }])
      expect(await guestOn(s1, 'Register Sale')).toEqual([{ ci: '2026-10-10', co: '2026-10-12' }])
      await expectNoSharedNights([s1, s2])
    }
  })

  it('a pay link sent for a site while a paid reservation saves on it is never ended by a deadlock', async () => {
    // Sending a stay link (posPayLinks) locks the site's row, then waits for
    // the site; the reservation had the site and then needed the site's row
    // for its own write. The database ended the link (a 500 at the counter).
    // Now the reservation takes the site's row before the site, the link
    // waits its turn, and both are saved.
    const f = await seedStayFixture()
    const s1 = f.unitId
    const other = await db.connect()
    const link = await db.connect()
    let res: request.Response
    let linkError: unknown = null
    try {
      await other.query('BEGIN')
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s1}`])
      const made = bookPaid(f, s1, '2026-10-03', '2026-10-05', 'Payer A')
      await waitForLockWait('%pg_advisory_xact_lock(hashtext($1))%', 'advisory')
      // The link's own order: the site's row, then the site (createStayBooking).
      const { createStayBooking } = await import('../services/registerStay')
      await link.query('BEGIN')
      const sent = (async () => {
        await link.query(`SELECT id FROM units WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [s1, f.landlordId])
        return createStayBooking(link, {
          landlordId: f.landlordId, propertyId: f.propertyId, posTransactionId: null, status: 'tentative',
          lines: [{ itemId: randomUUID(), qty: 2, stayUnit: 'night', lineTotal: 120, name: 'Nightly stay' }],
          details: { unitId: s1, checkIn: '2026-10-10', guestName: 'Link Guest' },
        })
      })().catch((e: unknown) => { linkError = e; return null })
      await waitForWaiters(2)
      await other.query('COMMIT')
      res = await made
      const booked = await sent
      expect(linkError, String((linkError as { message?: string } | null)?.message)).toBeNull()
      expect(booked).not.toBeNull()
      await link.query('COMMIT')
    } finally {
      await link.query('ROLLBACK').catch(() => {})
      other.release(); link.release()
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await guestOn(s1, 'Payer A')).toEqual([{ ci: '2026-10-03', co: '2026-10-05' }])
    expect(await guestOn(s1, 'Link Guest')).toEqual([{ ci: '2026-10-10', co: '2026-10-12' }])
    await expectNoSharedNights([s1])
  })

  it('a register sale and a pay link sent for the same site at the same moment are both saved', async () => {
    // The register's sale (createStayBooking) took the site and then, for its
    // write, the site's row; a pay link being sent took the row and then
    // waited for the site. The database ended the sale (a 500 at the counter,
    // three runs out of three). The sale now takes the row first, like the link.
    const f = await seedStayFixture()
    const s1 = f.unitId
    const { createStayBooking } = await import('../services/registerStay')
    const other = await db.connect()
    const register = await db.connect()
    const link = await db.connect()
    let saleError: unknown = null
    let linkError: unknown = null
    try {
      await other.query('BEGIN')
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s1}`])
      await register.query('BEGIN')
      const sale = createStayBooking(register, {
        landlordId: f.landlordId, propertyId: f.propertyId, posTransactionId: null,
        lines: [{ itemId: randomUUID(), qty: 2, stayUnit: 'night', lineTotal: 120, name: 'Nightly stay' }],
        details: { unitId: s1, checkIn: '2026-10-03', guestName: 'Register Sale' },
      }).catch((e: unknown) => { saleError = e; return null })
      await waitForWaiters(1)
      await link.query('BEGIN')
      const sent = (async () => {
        await link.query(`SELECT id FROM units WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [s1, f.landlordId])
        return createStayBooking(link, {
          landlordId: f.landlordId, propertyId: f.propertyId, posTransactionId: null, status: 'tentative',
          lines: [{ itemId: randomUUID(), qty: 2, stayUnit: 'night', lineTotal: 120, name: 'Nightly stay' }],
          details: { unitId: s1, checkIn: '2026-10-10', guestName: 'Link Guest' },
        })
      })().catch((e: unknown) => { linkError = e; return null })
      await waitForWaiters(2)
      await other.query('COMMIT')
      const sold = await sale
      expect(saleError, String((saleError as { message?: string } | null)?.message)).toBeNull()
      expect(sold).not.toBeNull()
      await register.query('COMMIT')
      const booked = await sent
      expect(linkError, String((linkError as { message?: string } | null)?.message)).toBeNull()
      expect(booked).not.toBeNull()
      await link.query('COMMIT')
    } finally {
      await register.query('ROLLBACK').catch(() => {})
      await link.query('ROLLBACK').catch(() => {})
      other.release(); register.release(); link.release()
    }
    expect(await guestOn(s1, 'Register Sale')).toEqual([{ ci: '2026-10-03', co: '2026-10-05' }])
    expect(await guestOn(s1, 'Link Guest')).toEqual([{ ci: '2026-10-10', co: '2026-10-12' }])
    await expectNoSharedNights([s1])
  })

  // ── 10/3 (fix pass 2): a move on the schedule is never ended by a deadlock ──

  it('a stay moved on the schedule onto a site while a pay link is sent for it: neither is ended by a deadlock', async () => {
    // The review's probe C3: the move took the new site and then needed the
    // site's row for its write, while the link held that row and waited for
    // the site. The database ended one of the two (the move: a 500 reading
    // "deadlock detected", 3 runs out of 3). Now the move takes the site's row
    // first, waits for the link while holding nothing, and both are saved.
    const f = await seedStayFixture()
    const [x] = await movableSites(f, 1)
    const y = f.unitId
    const stay = await stayOn(f, y, {
      checkIn: '2026-10-20', checkOut: '2026-10-22', status: 'confirmed', guestName: 'Moved Guest', total: 120,
    })
    const { createStayBooking } = await import('../services/registerStay')
    // The move saving again after a deadlock would hide one: it must not need to.
    const { logger } = await import('../lib/logger')
    const warn = vi.spyOn(logger, 'warn')
    const link = await db.connect()
    let res: request.Response
    let linkError: unknown = null
    try {
      // The link's own order: the site's row, then the site (createStayBooking).
      await link.query('BEGIN')
      await link.query(`SELECT id FROM units WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [x, f.landlordId])
      const moved = patchStay(f, stay, { unitId: x, checkIn: '2026-10-20', checkOut: '2026-10-22' }).then(r => r)
      await waitForWaiters(1)
      const booked = await createStayBooking(link, {
        landlordId: f.landlordId, propertyId: f.propertyId, posTransactionId: null, status: 'tentative',
        lines: [{ itemId: randomUUID(), qty: 2, stayUnit: 'night', lineTotal: 120, name: 'Nightly stay' }],
        details: { unitId: x, checkIn: '2026-10-10', guestName: 'Link Guest' },
      }).catch((e: unknown) => { linkError = e; return null })
      expect(linkError, String((linkError as { message?: string } | null)?.message)).toBeNull()
      expect(booked).not.toBeNull()
      await link.query('COMMIT')
      res = await moved
    } finally {
      await link.query('ROLLBACK').catch(() => {})
      link.release()
    }
    const deadlocked = warn.mock.calls.filter(c => String(c[1] ?? c[0]).includes('deadlocked'))
    warn.mockRestore()
    expect(deadlocked).toEqual([])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await siteOf(stay)).toBe(x)
    expect(await guestOn(x, 'Moved Guest')).toEqual([{ ci: '2026-10-20', co: '2026-10-22' }])
    expect(await guestOn(x, 'Link Guest')).toEqual([{ ci: '2026-10-10', co: '2026-10-12' }])
    await expectNoSharedNights([x, y])
  })

  // Somebody else holds site X, and when the move is waiting for it, grabs the
  // moving stay's row: each waits on the other, and the database ends the move.
  // `rounds` times; the grab is undone each time and site X is kept, so the
  // move's next try meets the same thing. Answers what the move answered.
  //
  // 10/3 (review, fix pass): the database ends whichever side's deadlock check
  // runs first, and both checks were set at one second. The move starts
  // waiting only 1-20 ms before the grab, so a few milliseconds of a busy
  // machine decided it, and sometimes the GRAB was ended (an uncaught
  // "deadlock detected" here, with nothing wrong in the code under test). This
  // side's own check is put off to 10 seconds (SET LOCAL: this transaction
  // only), so the move's one-second check always runs first and the move is
  // always the one ended.
  async function moveThroughDeadlocks(f: StayFixture, stay: string, x: string, rounds: number) {
    const other = await db.connect()
    let done = false
    let deadlocks = 0
    try {
      await other.query('BEGIN')
      await other.query(`SET LOCAL deadlock_timeout = '10s'`)
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${x}`])
      const moved = patchStay(f, stay, { unitId: x, checkIn: '2026-10-20', checkOut: '2026-10-22' })
        .then(r => { done = true; return r })
      while (!done && deadlocks < rounds) {
        let waiting = false
        for (let i = 0; i < 250 && !done; i++) {
          const w = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`)
          if (w.rows[0].n > 0) { waiting = true; break }
          await new Promise(r => setTimeout(r, 20))
        }
        if (!waiting) break
        await other.query('SAVEPOINT grab')
        await other.query(`SELECT 1 FROM unit_bookings WHERE id = $1 FOR UPDATE`, [stay])
        await other.query('ROLLBACK TO SAVEPOINT grab')
        deadlocks++
      }
      // Site X is let go: a move still trying gets it now.
      await other.query('COMMIT')
      return { res: await moved, deadlocks }
    } finally {
      await other.query('ROLLBACK').catch(() => {})
      other.release()
    }
  }

  it('a schedule move the database ends with a deadlock saves again from the top and goes through', async () => {
    const f = await seedStayFixture()
    const [x] = await movableSites(f, 1)
    const stay = await stayOn(f, f.unitId, {
      checkIn: '2026-10-20', checkOut: '2026-10-22', status: 'confirmed', guestName: 'Moved Guest', total: 120,
    })
    const { res, deadlocks } = await moveThroughDeadlocks(f, stay, x, 1)
    expect(deadlocks).toBe(1)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await siteOf(stay)).toBe(x)
    expect(await guestOn(x, 'Moved Guest')).toEqual([{ ci: '2026-10-20', co: '2026-10-22' }])
  })

  it('a schedule move that meets a deadlock on every try is refused in plain words, and nothing changes', async () => {
    const f = await seedStayFixture()
    const [x] = await movableSites(f, 1)
    const stay = await stayOn(f, f.unitId, {
      checkIn: '2026-10-20', checkOut: '2026-10-22', status: 'confirmed', guestName: 'Moved Guest', total: 120,
    })
    const { res, deadlocks } = await moveThroughDeadlocks(f, stay, x, 99)
    expect(deadlocks).toBe(6)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe(
      'Another reservation was being saved for the same sites at the same moment, so this one was not saved. Try again.')
    expect(await siteOf(stay)).toBe(f.unitId)
    expect(await guestOn(x, 'Moved Guest')).toEqual([])
  }, 30_000)

  it('a paid reservation whose hold\'s new site is busy for a moment waits its turn and goes through', async () => {
    // Somebody is selling site 2 right now (a card being taken at the
    // register can hold it for a second or two). The reservation for site 1
    // needs site 2 for the hold it moves; it lets go, waits, and tries again
    // instead of refusing the guest.
    const f = await seedStayFixture()
    const [s2] = await movableSites(f, 1)
    const s1 = f.unitId
    const hold = await holdFor(f, s1, '2026-10-03', '2026-10-05', 'Hold H')
    const other = await db.connect()
    let res: request.Response
    try {
      await other.query('BEGIN')
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s2}`])
      const made = bookPaid(f, s1, '2026-10-03', '2026-10-05', 'Payer A')
      await new Promise(r => setTimeout(r, 400))
      await other.query('COMMIT')
      res = await made
    } finally { other.release() }
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await siteOf(hold)).toBe(s2)
    expect(await holdersOfOct3(s1)).toEqual(['Payer A'])
    await expectNoSharedNights([s1, s2])
  })

  it('a paid reservation whose hold\'s new site stays busy is refused in plain words, and nothing changes', async () => {
    const f = await seedStayFixture()
    const [s2] = await movableSites(f, 1)
    const s1 = f.unitId
    const hold = await holdFor(f, s1, '2026-10-03', '2026-10-05', 'Hold H')
    const other = await db.connect()
    let res: request.Response
    try {
      await other.query('BEGIN')
      await other.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`unit-booking:${s2}`])
      res = await bookPaid(f, s1, '2026-10-03', '2026-10-05', 'Payer A')
      await other.query('COMMIT')
    } finally { other.release() }
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe(
      'Another reservation was being saved for the same sites at the same moment, so this one was not saved. Try again.')
    expect(await siteOf(hold)).toBe(s1)
    expect(await holdersOfOct3(s1)).toEqual(['Hold H'])
    expect(await guestOn(s1, 'Payer A')).toEqual([])
  })

  // ── 10/3: checking a guest in or out is its own permission ──

  // A team member at the fixture's landlord with these permissions and every property in scope.
  async function staffToken(f: StayFixture, permissions: Record<string, boolean>): Promise<string> {
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'property_manager', 'Desk', 'Staff', TRUE) RETURNING id`,
      [`desk-${randomUUID()}@test.dev`])).rows[0].id
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, '{}', TRUE)`, [u, f.landlordId])
    return jwt.sign({ userId: u, role: 'property_manager', email: 'desk@test.dev', profileId: u,
      landlordId: f.landlordId, permissions }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  }
  const patchAs = (f: StayFixture, token: string, bookingId: string, body: Record<string, unknown>) =>
    request(buildUnitsApp())
      .patch(`/api/units/${f.unitId}/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)

  it('"Edit / move / cancel reservations" alone cannot check a guest in; "Check guests in" can', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: PHOENIX_TODAY, checkOut: '2026-10-06', status: 'confirmed' })
    const editOnly = await staffToken(f, { 'schedule.edit_reservation': true })
    const refused = await patchAs(f, editOnly, stay, { status: 'checked_in' })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe(
      'Checking a guest in needs the "Check guests in" permission, and nothing was changed. '
      + 'Ask the account owner to turn on "Check guests in" for you on the Team page.')
    expect(await stayRow(stay)).toMatchObject({ status: 'confirmed', check_out: '2026-10-06' })
    // The rest of the reservation is still theirs to edit.
    const phone = await patchAs(f, editOnly, stay, { guestPhone: '602-555-0101' })
    expect(phone.status, JSON.stringify(phone.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'confirmed' })

    const canCheckIn = await staffToken(f, { 'schedule.edit_reservation': true, 'guests.check_in': true })
    const ok = await patchAs(f, canCheckIn, stay, { status: 'checked_in' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in' })
  })

  it('"Edit / move / cancel reservations" alone cannot check a guest out or correct the day they left; "Check guests out" can', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const editOnly = await staffToken(f, { 'schedule.edit_reservation': true, 'guests.check_in': true })
    const refused = await patchAs(f, editOnly, stay, { status: 'checked_out' })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe(
      'Checking a guest out needs the "Check guests out" permission, and nothing was changed. '
      + 'Ask the account owner to turn on "Check guests out" for you on the Team page.')
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_out: '2026-10-06', total_amount: '480.00' })

    const canCheckOut = await staffToken(f, { 'schedule.edit_reservation': true, 'guests.check_out': true })
    const out = await patchAs(f, canCheckOut, stay, { status: 'checked_out' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY })

    // Correcting the day they left is a check-out too.
    const fix = await patchAs(f, editOnly, stay, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fix.status).toBe(403)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY })
    const fixed = await patchAs(f, canCheckOut, stay, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: '2026-10-01', total_amount: '480.00' })
  })

  // ── 10/3 (fix pass 2): "Check guests in" or "Check guests out" alone is enough for that act, and only that ──

  const NEEDS_EDIT = (what: string) =>
    `${what} needs the "Edit / move / cancel reservations" permission, and nothing was changed. `
    + 'Ask the account owner to turn on "Edit / move / cancel reservations" for you on the Team page.'

  it('a desk person with only "Check guests in" checks a guest in, and can change nothing else', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: PHOENIX_TODAY, checkOut: '2026-10-06', status: 'confirmed', total: 240 })
    const desk = await staffToken(f, { 'guests.check_in': true })

    // Anything but the check-in is the edit permission's, and nothing is written.
    const phone = await patchAs(f, desk, stay, { guestPhone: '602-555-0101' })
    expect(phone.status).toBe(403)
    expect(phone.body.error).toBe(NEEDS_EDIT("Changing the guest's details"))
    const longer = await patchAs(f, desk, stay, { status: 'checked_in', checkOut: '2026-10-08' })
    expect(longer.status).toBe(403)
    expect(longer.body.error).toBe(NEEDS_EDIT('Changing the check-out day'))
    const moved = await patchAs(f, desk, stay, { status: 'checked_in', checkIn: '2026-10-01', notes: 'Early arrival' })
    expect(moved.status).toBe(403)
    expect(moved.body.error).toBe(NEEDS_EDIT('Changing the arrival day and notes'))
    const cancel = await patchAs(f, desk, stay, { status: 'cancelled' })
    expect(cancel.status).toBe(403)
    expect(cancel.body.error).toBe(NEEDS_EDIT('Changing a reservation from Confirmed to Canceled'))
    expect(await stayRow(stay)).toMatchObject({
      status: 'confirmed', check_in: PHOENIX_TODAY, check_out: '2026-10-06', total_amount: '240.00',
    })
    const untouched = (await db.query<{ guest_phone: string | null; notes: string | null }>(
      `SELECT guest_phone, notes FROM unit_bookings WHERE id = $1`, [stay])).rows[0]
    expect(untouched).toEqual({ guest_phone: null, notes: null })

    // The check-in goes through — also when the stay's own dates and site are sent back with it.
    const ok = await patchAs(f, desk, stay, {
      status: 'checked_in', unitId: f.unitId, checkIn: PHOENIX_TODAY, checkOut: '2026-10-06',
    })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_out: '2026-10-06', total_amount: '240.00' })

    // Checking the guest out is "Check guests out"'s.
    const out = await patchAs(f, desk, stay, { status: 'checked_out' })
    expect(out.status).toBe(403)
    expect(out.body.error).toBe(
      'Checking a guest out needs the "Check guests out" permission, and nothing was changed. '
      + 'Ask the account owner to turn on "Check guests out" for you on the Team page.')
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_out: '2026-10-06' })

    // With none of the three, the route stays closed.
    const none = await staffToken(f, { 'schedule.tab.timeline': true })
    const shut = await patchAs(f, none, stay, { status: 'checked_in' })
    expect(shut.status).toBe(403)
    expect(shut.body.error).toBe('Insufficient permissions')
  })

  it('a desk person with only "Check guests out" checks a guest out and corrects the day they left, and can change nothing else', async () => {
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const desk = await staffToken(f, { 'guests.check_out': true })

    const notes = await patchAs(f, desk, stay, { notes: 'Leaving early' })
    expect(notes.status).toBe(403)
    expect(notes.body.error).toBe(NEEDS_EDIT('Changing the notes'))
    const arrival = await patchAs(f, desk, stay, { checkIn: '2026-09-29' })
    expect(arrival.status).toBe(403)
    expect(arrival.body.error).toBe(NEEDS_EDIT('Changing the arrival day'))
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_in: '2026-09-28', check_out: '2026-10-06' })

    // The check-out, and a correction of the day they left, go through and move no money.
    const out = await patchAs(f, desk, stay, { status: 'checked_out' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '480.00' })
    const fixed = await patchAs(f, desk, stay, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: '2026-10-01', total_amount: '480.00' })

    // Putting the guest back is not a check-out: it is "Check guests in"'s, or an edit.
    const undoIn = await patchAs(f, desk, stay, { status: 'checked_in' })
    expect(undoIn.status).toBe(403)
    expect(undoIn.body.error).toBe(
      'Checking a guest in needs the "Check guests in" permission, and nothing was changed. '
      + 'Ask the account owner to turn on "Check guests in" for you on the Team page.')
    const undoConfirmed = await patchAs(f, desk, stay, { status: 'confirmed' })
    expect(undoConfirmed.status).toBe(403)
    expect(undoConfirmed.body.error).toBe(NEEDS_EDIT('Changing a reservation from Checked out to Confirmed'))
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: '2026-10-01', total_amount: '480.00' })

    // A guest never marked Checked in is checked in first (or by somebody who may edit).
    const lee = await seedStay(f, {
      checkIn: '2026-10-01', checkOut: '2026-10-04', status: 'confirmed', guestName: 'Lee Park', total: 180,
    })
    const leeOut = await patchAs(f, desk, lee, { status: 'checked_out' })
    expect(leeOut.status).toBe(403)
    expect(leeOut.body.error).toBe(NEEDS_EDIT('Changing a reservation from Confirmed to Checked out'))
    expect(await stayRow(lee)).toMatchObject({ status: 'confirmed', check_out: '2026-10-04' })
  })

  // ── 10/3: the undo's refusal names every step, and the meter read puts the next guest back ──

  it('an undo over nights held by a reservation and by something else names both steps', async () => {
    // Lee is booked Oct 12 to 15 and the site is out of order Oct 16 to 18:
    // moving Lee alone would only be refused again.
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-28', checkOut: '2026-10-20', total: 1320 })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    await seedStay(f, { checkIn: '2026-10-12', checkOut: '2026-10-15', status: 'confirmed', guestName: 'Lee Park' })
    await db.query(
      `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason)
       VALUES ($1, $2, '2026-10-16', '2026-10-18', 'Pad repair')`, [f.unitId, f.landlordId])
    const undo = await patchStay(f, stay, { status: 'checked_in' })
    expect(undo.status).toBe(409)
    expect(undo.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 2, 2026 and October 20, 2026, '
      + "so Pat Ruiz's stay can't be put back to October 20, 2026. "
      + 'Move that reservation and free those nights on the site first, or use Edit to set a check-out no later than '
      + 'October 12, 2026 (the stay is priced on the shorter dates), then set it back to Checked in.')
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY, total_amount: '1320.00' })

    // The other reservation arriving on the day they left: no Edit can give a
    // night back, so only the two steps.
    const g = await seedStayFixture()
    const stay2 = await seedStay(g, { checkIn: '2026-09-28', checkOut: '2026-10-20', total: 1320 })
    expect((await patchStay(g, stay2, { status: 'checked_out' })).status).toBe(200)
    await seedStay(g, { checkIn: PHOENIX_TODAY, checkOut: '2026-10-05', status: 'confirmed', guestName: 'Lee Park' })
    await db.query(
      `INSERT INTO unit_out_of_order (unit_id, landlord_id, starts_on, ends_on, reason)
       VALUES ($1, $2, '2026-10-16', '2026-10-18', 'Pad repair')`, [g.unitId, g.landlordId])
    const undo2 = await patchStay(g, stay2, { status: 'checked_in' })
    expect(undo2.status).toBe(409)
    expect(undo2.body.error).toBe(
      'Another reservation now holds this site for some of the nights between October 2, 2026 and October 20, 2026, '
      + "so Pat Ruiz's stay can't be put back to October 20, 2026. "
      + 'Move that reservation and free those nights on the site first.')
  })

  it('an extension at check-in refused for a closing meter read leaves the next guest where they were', async () => {
    // The review's probe (V1): a guest left site 1 on Sep 30 and its submeter
    // has not been read since. Pat (Oct 2 to 6) is checked in and extended to
    // Oct 8 in one save while Next Guest holds Oct 6 to 9. The extension moved
    // Next Guest to site 2, then the meter read refused the check-in — and Next
    // Guest stayed moved for an extension that never happened.
    const f = await seedStayFixture()
    const [s2] = await movableSites(f, 1)
    const c = await db.connect()
    try {
      const meterId = await seedUtilityMeter(c, { propertyId: f.propertyId })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, f.unitId])
    } finally { c.release() }
    await stayOn(f, f.unitId, {
      checkIn: '2026-09-27', checkOut: '2026-09-30', status: 'checked_out', guestName: 'Prior Guest', total: 180,
    })
    const pat = await seedStay(f, { checkIn: PHOENIX_TODAY, checkOut: '2026-10-06', status: 'confirmed', total: 240 })
    const next = await stayOn(f, f.unitId, {
      checkIn: '2026-10-06', checkOut: '2026-10-09', status: 'confirmed', guestName: 'Next Guest', total: 180,
    })
    let movedAway = false
    relocationHook.afterRelocation = async () => {
      relocationHook.afterRelocation = null
      movedAway = (await siteOf(next)) === s2
    }
    let res: request.Response
    try { res = await patchStay(f, pat, { status: 'checked_in', checkOut: '2026-10-08' }) }
    finally { relocationHook.afterRelocation = null }
    expect(movedAway).toBe(true)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.code).toBe('meter_read_due')
    expect(await siteOf(next)).toBe(f.unitId)
    expect(await stayRow(pat)).toMatchObject({ status: 'confirmed', check_out: '2026-10-06', total_amount: '240.00' })
    await expectNoSharedNights([f.unitId, s2])
  })

  // ── 10/3 (decisions #33): a stay is priced, taxed and split by the length it was sold for ──

  it('what a reservation still owes does not change across an early check-out', async () => {
    const { reservationDue } = await import('../services/registerStay')
    // Rung at the register for 40 nights (no lease drafted): charged whole,
    // $500 paid ahead, $1,500 left. The guest leaves Oct 2 — 12 nights.
    const f = await seedStayFixture()
    await db.query(`UPDATE properties SET short_term_tax_rate = 12 WHERE id = $1`, [f.propertyId])
    const register = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights, total_amount, platform_fee,
          status, source, deposit_amount, deposit_paid_at)
       VALUES ($1, $2, 'Pat Ruiz', 'nightly', '2026-09-20', '2026-10-30', 40, 2000, 0,
               'checked_in', 'register', 500, NOW())
       RETURNING id`, [f.landlordId, f.unitId])).rows[0].id
    const before = await reservationDue(db, register)
    expect(before).toMatchObject({ nights: 40, bookedNights: 40, total: 2000, paid: 500, owed: 1500, leaseBillsRest: false })
    expect((await patchStay(f, register, { status: 'checked_out' })).status).toBe(200)
    const after = await reservationDue(db, register)
    expect(after).toMatchObject({
      checkOut: PHOENIX_TODAY, nights: 12, bookedCheckOut: '2026-10-30', bookedNights: 40,
      total: 2000, paid: 500, owed: 1500, leaseBillsRest: false,
    })

    // Made on the schedule for 40 nights with a lease chosen (10/5, R2 — a
    // lease bills a stay only when one was chosen): its lease bills the stay,
    // the register takes only the deposit — already paid, so nothing. An early
    // check-out on Oct 2 (22 nights) used to make it a short stay the counter
    // charged whole: $1,600 asked where nothing was due.
    const g = await seedStayFixture()
    const direct = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights, total_amount, platform_fee,
          status, source, deposit_amount, deposit_paid_at, stay_terms)
       VALUES ($1, $2, 'Pat Ruiz', 'month_to_month', '2026-09-10', '2026-10-20', 40, 1750, 0,
               'checked_in', 'direct', 150, NOW(), 'lease')
       RETURNING id`, [g.landlordId, g.unitId])).rows[0].id
    const before2 = await reservationDue(db, direct)
    expect(before2).toMatchObject({ leaseBillsRest: true, depositDue: 150, owed: 0, paidInFull: true })
    expect((await patchStay(g, direct, { status: 'checked_out' })).status).toBe(200)
    const after2 = await reservationDue(db, direct)
    expect(after2).toMatchObject({ nights: 22, bookedNights: 40, leaseBillsRest: true, depositDue: 150, owed: 0, paidInFull: true })
  })

  it('an extra night added outside the schedule, then an early check-out, keeps the length sold at the extended length', async () => {
    const { reservationDue } = await import('../services/registerStay')
    // The review's probe D: made on the schedule Sep 25 to Oct 10 (the column
    // says Oct 10), then the guest agent's extra night moves check-out to
    // Oct 11 without writing the column (services/agents/tools/
    // requestBookingChange). The early check-out on Oct 2 used to keep the
    // column's Oct 10, so the length sold dropped from 16 nights to 15.
    const f = await seedStayFixture()
    const stay = await seedStay(f, { checkIn: '2026-09-25', checkOut: '2026-10-10', total: 900 })
    await db.query(`UPDATE unit_bookings SET booked_check_out = check_out WHERE id = $1`, [stay])
    await db.query(
      `UPDATE unit_bookings SET check_out = check_out + INTERVAL '1 day', nights = COALESCE(nights, 0) + 1 WHERE id = $1`,
      [stay])
    expect(await reservationDue(db, stay)).toMatchObject({ bookedCheckOut: '2026-10-11', bookedNights: 16 })

    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_out', check_out: PHOENIX_TODAY })
    expect(await bookedCheckOut(stay)).toBe('2026-10-11')
    expect(await reservationDue(db, stay)).toMatchObject({ bookedCheckOut: '2026-10-11', bookedNights: 16 })

    // Correcting the day they left keeps it.
    const fixed = await patchStay(f, stay, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ check_out: '2026-10-01' })
    expect(await bookedCheckOut(stay)).toBe('2026-10-11')
    expect(await reservationDue(db, stay)).toMatchObject({ bookedNights: 16 })

    // A row whose column was never written still gets the booked day the
    // history recorded on a correction (not the day they left).
    await db.query(`UPDATE unit_bookings SET booked_check_out = NULL WHERE id = $1`, [stay])
    expect((await patchStay(f, stay, { status: 'checked_out', checkOut: PHOENIX_TODAY })).status).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ check_out: PHOENIX_TODAY })
    expect(await bookedCheckOut(stay)).toBe('2026-10-11')

    // The undo puts the extended day back, and the length sold with it.
    expect((await patchStay(f, stay, { status: 'checked_in' })).status).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ status: 'checked_in', check_out: '2026-10-11' })
    expect(await bookedCheckOut(stay)).toBe('2026-10-11')
    expect(await reservationDue(db, stay)).toMatchObject({ bookedNights: 16 })
  })

  it('a register long stay checked out early still records no tax when the rest is paid', async () => {
    // The review's probe (V3): 40 untaxed nights at $2,000, $500 paid ahead,
    // checked out early on Oct 2. Paying the $1,500 left at the counter used to
    // record $160.71 of 12% lodging tax inside a price that never had any.
    const { posRouter } = await import('./pos')
    const { camelCaseKeys } = await import('../lib/caseConversion')
    const posApp = express()
    posApp.use(express.json())
    posApp.use((_req, res, next) => {
      const json = res.json.bind(res)
      res.json = (body: any) => json(camelCaseKeys(body))
      next()
    })
    posApp.use('/api/pos', posRouter)
    posApp.use(errorHandler)

    const f = await seedStayFixture()
    const userId = (jwt.decode(f.token) as any).userId as string
    await db.query(`UPDATE properties SET short_term_tax_rate = 12 WHERE id = $1`, [f.propertyId])
    const cat = (await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1, 'Stays', 1, TRUE) RETURNING id`,
      [f.landlordId])).rows[0].id
    const stayItem = (await db.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate,
                              stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1, $2, 'RV site — nightly', $3, 0, 0, 0, 999, 0, 999, 'night') RETURNING id`,
      [f.landlordId, f.propertyId, cat])).rows[0].id
    const stay = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings
         (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights, total_amount, platform_fee,
          status, source, deposit_amount, deposit_paid_at)
       VALUES ($1, $2, 'Pat Ruiz', 'nightly', '2026-09-20', '2026-10-30', 40, 2000, 0,
               'checked_in', 'register', 500, NOW())
       RETURNING id`, [f.landlordId, f.unitId])).rows[0].id
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ check_out: PHOENIX_TODAY, nights: 12 })

    const ticket = (await db.query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
       VALUES ($1, $2, $3, $4::jsonb, 'Pat Ruiz · the rest of the stay', $5) RETURNING id`,
      [f.landlordId, f.propertyId, userId,
       JSON.stringify([{ id: stayItem, name: 'RV site — nightly', qty: 40, price: 0, tax: 0 }]), stay])).rows[0].id
    const auth = { Authorization: `Bearer ${f.token}` }
    const opened = await request(posApp).get(`/api/pos/tickets/${ticket}?propertyId=${f.propertyId}&kind=ticket`).set(auth)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const line = opened.body.data.items[0]
    expect(line).toMatchObject({ id: stayItem, price: 1500 })
    const sale = await request(posApp).post('/api/pos/transactions').set(auth)
      .send({ paymentMethod: 'cash', propertyId: f.propertyId, items: [line], openTicketId: ticket })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(sale.body.data).toMatchObject({ subtotal: '1500.00', taxAmount: '0.00', total: '1500.00' })
  })

  it("a stay checked out early counts in GAM's short-stay revenue as sold: Sep 25 to Oct 10 at $1,500, left Oct 2, is Sep $600 + Oct $900", async () => {
    // Short stays on a non-RV space bill a share of their revenue, month by
    // month. Split by the shortened stay (7 nights) the months came to more or
    // less than the $1,500 sold; split by the 15 nights sold, September has its
    // 6 nights ($600) and October its 1 night plus the 8 sold but not stayed
    // (the month the guest left): $900.
    const { processPlatformFeeAccrual } = await import('../jobs/platformFeeAccrual')
    const f = await seedStayFixture({ unitType: 'apartment' })
    const stay = await seedStay(f, { checkIn: '2026-09-25', checkOut: '2026-10-10', total: 1500 })
    expect((await patchStay(f, stay, { status: 'checked_out' })).status).toBe(200)
    expect(await stayRow(stay)).toMatchObject({ check_out: PHOENIX_TODAY, total_amount: '1500.00' })
    expect(await bookedCheckOut(stay)).toBe('2026-10-10')

    await db.query(`UPDATE landlords SET billing_starts_at = '2026-09-01' WHERE id = $1`, [f.landlordId])
    await db.query(
      `INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer)
       VALUES ($1, 'tenant', 'tenant', 'landlord') ON CONFLICT DO NOTHING`, [f.propertyId])
    const cfg = (await db.query<{ id: string }>(
      `INSERT INTO platform_fee_config (rate_per_unit, min_per_connect_account, notes)
       SELECT 2.00, 10.00, 'bookings.test (decisions #33)'
        WHERE NOT EXISTS (SELECT 1 FROM platform_fee_config WHERE effective_until IS NULL)
       RETURNING id`)).rows[0]?.id
    try {
      await processPlatformFeeAccrual(new Date('2026-10-01T09:00:00Z'))   // September's nights
      await processPlatformFeeAccrual(new Date('2026-11-01T09:00:00Z'))   // October's
    } finally {
      if (cfg) await db.query(`DELETE FROM platform_fee_config WHERE id = $1`, [cfg])
    }
    const months = await db.query<{ month: string; str_revenue: string }>(
      `SELECT to_char(accrual_month, 'YYYY-MM-DD') AS month, str_revenue::text
         FROM platform_fee_accruals WHERE property_id = $1 ORDER BY accrual_month`, [f.propertyId])
    // Billed with the next month's fee (S650: short-stay nights in arrears).
    expect(months.rows).toEqual([
      { month: '2026-10-01', str_revenue: '600.00' },
      { month: '2026-11-01', str_revenue: '900.00' },
    ])

    // The landlord's fee estimate splits it the same way (one formula).
    const { stayRevenueInMonthSql } = await import('../services/platformFee')
    const split = await db.query<{ sep: string; oct: string }>(
      `SELECT ROUND(${stayRevenueInMonthSql('b', `'2026-09-01'::date`)}, 2)::text AS sep,
              ROUND(${stayRevenueInMonthSql('b', `'2026-10-01'::date`)}, 2)::text AS oct
         FROM unit_bookings b WHERE b.id = $1`, [stay])
    expect(split.rows[0]).toEqual({ sep: '600.00', oct: '900.00' })
  })
})

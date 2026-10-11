/**
 * units route slice — S354.
 *
 * Closes the booking subsystem: pinning per-unit CRUD that companions
 * S350's bookings.ts list endpoint. Also covers status flow
 * (mark-available / mark-vacant) and activation guards (active lease
 * required, scheduledFor future-only).
 *
 * S354 fix pinned: POST /:id/bookings missing required fields
 * (leaseType / checkIn / checkOut) now produces 400 via zod instead
 * of 500 via DB CHECK / NOT NULL violation. checkOut <= checkIn also
 * now 400 instead of silently producing 0 or negative nights.
 *
 * Out of scope:
 *   - /:id/economics (financial P&L — separate slice if needed)
 *   - /:id/eviction-mode (high-stakes legal toggle — single-route
 *     test wouldn't add value without product walkthrough)
 *   - /schedule/master (rollup; same pattern as bookings.ts list)
 *   - /:id/type (lease-type matrix; pure mechanical mapping)
 *   - /:id/cancel-scheduled-activation (mechanical mirror of activate)
 *   - /:id/bookings/:bookingId/acknowledge (mechanical idempotent
 *     status flip)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLateFeeDecision, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { unitsRouter } from './units'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_units'
})

interface UnitsFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  unitId:         string
  landlordToken:  string
}

async function seedUnitsFixture(): Promise<UnitsFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    // Open up lease_types_allowed so booking tests can use nightly etc.
    // (seedUnit defaults to '{}' which blocks all booking lease types via
    // the route's lease_types_allowed check.)
    await client.query(
      `UPDATE units SET lease_types_allowed = $1::text[] WHERE id = $2`,
      [['nightly', 'weekly', 'month_to_month', 'long_term', 'lease_hold'], unitId])
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, propertyId, unitId, landlordToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

describe('POST /api/units — create', () => {
  it('happy path: inserts unit + returns 201 with derived fields', async () => {
    const f = await seedUnitsFixture()
    // S537: unit creation gates on an explicit late-fee decision for the
    // class (no unitType in the body → defaults to apartment).
    const c = await db.connect()
    try { await seedLateFeeDecision(c, { propertyId: f.propertyId, unitType: 'apartment' }) }
    finally { c.release() }
    const res = await request(buildApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        unitNumber: 'Apt 101',   // S605: unit numbers require a prefix
        bedrooms: 2, bathrooms: 1.5, sqft: 850,
        rentAmount: 1450, securityDeposit: 1000,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.landlord_id).toBe(f.landlordId)
    expect(res.body.data.property_id).toBe(f.propertyId)
    expect(Number(res.body.data.rent_amount)).toBe(1450)
  })

  it('cross-landlord property → 403', async () => {
    const a = await seedUnitsFixture()
    const b = await seedUnitsFixture()
    const res = await request(buildApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ propertyId: b.propertyId, unitNumber: 'Apt 999', rentAmount: 1000 })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/units/:id', () => {
  it('cross-landlord unit → 403', async () => {
    const a = await seedUnitsFixture()
    const b = await seedUnitsFixture()
    const res = await request(buildApp())
      .get(`/api/units/${b.unitId}`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
    expect(res.status).toBe(403)
  })
})

describe('POST /api/units/:id/bookings — create', () => {
  it('happy path: returns 201; nights computed; platform_fee 0 (S526: no fee on reservations)', async () => {
    const f = await seedUnitsFixture()
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        leaseType: 'nightly',
        checkIn: '2026-07-01', checkOut: '2026-07-05',
        guestName: 'Alice', guestEmail: 'a@x.dev',
        totalAmount: 400,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.nights).toBe(4)
    expect(Number(res.body.data.platform_fee)).toBe(0)  // S526: reservations carry no platform fee
    expect(res.body.data.landlord_id).toBe(f.landlordId)
    expect(res.body.data.source).toBe('direct')  // default
  })

  it('S354 F1: missing leaseType → 400 (was 500 pre-fix from DB CHECK)', async () => {
    const f = await seedUnitsFixture()
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkIn: '2026-07-01', checkOut: '2026-07-05' })  // no leaseType
    expect(res.status).toBe(400)
  })

  it('S354 F1: checkOut <= checkIn → 400 (was silently 0/negative nights pre-fix)', async () => {
    const f = await seedUnitsFixture()
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        leaseType: 'nightly',
        checkIn: '2026-07-05', checkOut: '2026-07-05',  // same day
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/checkOut must be after checkIn/)
    const rows = await db.query(`SELECT id FROM unit_bookings`)
    expect(rows.rows.length).toBe(0)
  })

  it('overlap with existing booking → 409', async () => {
    const f = await seedUnitsFixture()
    // First booking: 07-01 to 07-05
    await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-07-01', checkOut: '2026-07-05' })

    // Overlapping: 07-03 to 07-07
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-07-03', checkOut: '2026-07-07' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already booked/)
  })

  // S527: active leases block reservations too — pre-fix only other bookings
  // were checked, so a leased unit accepted overlapping short stays.
  const insertLease = (f: any, status: string, start: string, end: string | null) =>
    db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1, $2, 1000, 'fixed_term', $3, $4, $5) RETURNING id`,
      [f.unitId, f.landlordId, status, start, end])

  it('S527: overlap with ACTIVE lease → 409', async () => {
    const f = await seedUnitsFixture()
    await insertLease(f, 'active', '2026-01-01', '2026-12-31')
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-07-01', checkOut: '2026-07-05' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/active lease/)
  })

  it('S527: open-ended active lease (NULL end_date) blocks indefinitely', async () => {
    const f = await seedUnitsFixture()
    await insertLease(f, 'active', '2026-01-01', null)
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2030-07-01', checkOut: '2030-07-05' })
    expect(res.status).toBe(409)
  })

  it('S527: same-day turnover allowed — check-in ON the lease end date → 201', async () => {
    const f = await seedUnitsFixture()
    await insertLease(f, 'active', '2026-01-01', '2026-07-01')
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-07-01', checkOut: '2026-07-05' })
    expect(res.status).toBe(201)
  })

  it('S527: pending lease does NOT block', async () => {
    const f = await seedUnitsFixture()
    await insertLease(f, 'pending', '2026-01-01', '2026-12-31')
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-07-01', checkOut: '2026-07-05' })
    expect(res.status).toBe(201)
  })

  it('S527: PATCH move onto lease-covered dates → 409; own booking-draft lease exempt', async () => {
    const f = await seedUnitsFixture()
    const c = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-06-01', checkOut: '2026-06-05' })
    const bookingId = c.body.data.id

    // Active lease later in the year: extending into it must 409…
    await insertLease(f, 'active', '2026-07-01', '2026-12-31')
    const blocked = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-07-03' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toMatch(/active lease/)

    // …but a lease drafted FROM this booking (later activated) is exempt.
    await db.query(`UPDATE leases SET source_booking_id=$1, lease_source='booking_draft' WHERE unit_id=$2 AND status='active'`,
      [bookingId, f.unitId])
    const allowed = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-07-03' })
    expect(allowed.status).toBe(200)
  })
})

describe('PATCH /api/units/:id/bookings/:bookingId — update', () => {
  it('happy path: date change recomputes nights (checkout-only PATCH — mixed date representations)', async () => {
    const f = await seedUnitsFixture()
    const c = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-07-01', checkOut: '2026-07-05' })
    // S553: assert the arrange step loudly — a create failure here used to
    // surface as a baffling 404/undefined downstream.
    expect(c.status, JSON.stringify(c.body)).toBe(201)
    const bookingId = c.body.data.id
    expect(bookingId).toBeTruthy()

    // Patching ONLY checkout makes the route mix a pg DATE (midnight
    // LOCAL) with a 'YYYY-MM-DD' string (midnight UTC) — the S553 dayDiff
    // regression shape. Raw ms math here was host-timezone-dependent.
    const res = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-07-08' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.nights).toBe(7)  // 07-01 to 07-08
  })

  // 10/6 (Nic): "would anything inadvertently push her into spot 14...? We
  // need it to actually do something in the schedule." When the extending
  // guest is the one moved, a site they asked not to have is never where they
  // go — and with nothing else open, the extension is refused rather than
  // landing them there.
  it('W-20 extension fallback never moves the extending guest onto a site they asked not to have', async () => {
    const f = await seedUnitsFixture()
    const mk = async (n: string) => (await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, is_bookable, lease_types_allowed)
       VALUES ($1, $2, $3, 900, TRUE, ARRAY['nightly','weekly']) RETURNING id`,
      [f.propertyId, f.landlordId, n])).rows[0].id
    const rv98 = await mk('RV 98')
    const rv99 = await mk('RV 99')
    await db.query(`UPDATE units SET is_bookable=TRUE WHERE id=$1`, [f.unitId])
    const sit = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-01', checkOut: '2026-08-05', guestName: 'Jo Avery', avoidedUnitIds: [rv98] })
    expect(sit.status, JSON.stringify(sit.body)).toBe(201)
    const inc = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-05', checkOut: '2026-08-09', guestName: 'Incoming' })
    // The incoming guest was told their site, so they cannot be moved.
    await db.query(`UPDATE unit_bookings SET site_reveal_sent_at=now() WHERE id=$1`, [inc.body.data.id])
    const ext = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${sit.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-08-07' })
    expect(ext.status, JSON.stringify(ext.body)).toBe(200)
    // RV 98 is the first open site, but it is on Jo's list.
    expect(ext.body.extendedGuestMovedTo?.unitNumber).toBe('RV 99')
    expect((await db.query(`SELECT unit_id FROM unit_bookings WHERE id=$1`, [sit.body.data.id])).rows[0].unit_id).toBe(rv99)

    // Only the avoided site open: the extension is refused, nobody is moved there.
    const sit2 = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-12', checkOut: '2026-08-15', guestName: 'Jo Avery', avoidedUnitIds: [rv98] })
    const inc2 = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-15', checkOut: '2026-08-18', guestName: 'Incoming 2' })
    await db.query(`UPDATE unit_bookings SET site_reveal_sent_at=now() WHERE id=$1`, [inc2.body.data.id])
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status, site_reveal_sent_at)
       VALUES ($1, $2, 'nightly', '2026-08-10', '2026-08-20', 'confirmed', now())`, [rv99, f.landlordId])
    const ext2 = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${sit2.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-08-17' })
    expect(ext2.status).toBe(409)
    expect(ext2.body.error).toMatch(/no open site fits the extended stay/)
    expect((await db.query(`SELECT unit_id FROM unit_bookings WHERE id=$1`, [sit2.body.data.id])).rows[0].unit_id).toBe(f.unitId)
  })

  // 10/6 (review): the avoid list sent WITH the extension is the one honored —
  // a site added to it in the same save is never where the guest is moved.
  it('W-20 extension fallback honors a site added to the avoid list in the same save', async () => {
    const f = await seedUnitsFixture()
    const mk = async (n: string) => (await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, is_bookable, lease_types_allowed)
       VALUES ($1, $2, $3, 900, TRUE, ARRAY['nightly','weekly']) RETURNING id`,
      [f.propertyId, f.landlordId, n])).rows[0].id
    const rv98 = await mk('RV 98')
    const rv99 = await mk('RV 99')
    await db.query(`UPDATE units SET is_bookable=TRUE WHERE id=$1`, [f.unitId])
    const sit = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-01', checkOut: '2026-08-05', guestName: 'Pat Ruiz' })
    expect(sit.status, JSON.stringify(sit.body)).toBe(201)
    const inc = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-05', checkOut: '2026-08-09', guestName: 'Incoming' })
    await db.query(`UPDATE unit_bookings SET site_reveal_sent_at=now() WHERE id=$1`, [inc.body.data.id])
    const ext = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${sit.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-08-07', avoidedUnitIds: [rv98] })
    expect(ext.status, JSON.stringify(ext.body)).toBe(200)
    expect(ext.body.extendedGuestMovedTo?.unitNumber).toBe('RV 99')
    const row = (await db.query(`SELECT unit_id, avoided_unit_ids FROM unit_bookings WHERE id=$1`, [sit.body.data.id])).rows[0]
    expect(row.unit_id).toBe(rv99)
    expect(row.avoided_unit_ids).toEqual([rv98])
  })

  it('W-20 extension protection: boots the following unrevealed reservation; falls back to MOVING THE EXTENDING GUEST; 409s when neither works', async () => {
    const f = await seedUnitsFixture()
    // A second bookable site at the property.
    const u2 = (await db.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, is_bookable, lease_types_allowed)
       VALUES ($1, $2, 'RV 99', 900, TRUE, ARRAY['nightly','weekly']) RETURNING id`,
      [f.propertyId, f.landlordId])).rows[0].id
    await db.query(`UPDATE units SET is_bookable=TRUE WHERE id=$1`, [f.unitId])

    // Sitting guest on unit 1; incoming back-to-back on unit 1.
    const sit = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-01', checkOut: '2026-08-05' })
    const inc = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-05', checkOut: '2026-08-09', guestName: 'Incoming' })
    const sitId = sit.body.data.id, incId = inc.body.data.id

    // 1. Extend into the incoming stay → incoming gets booted to RV 99.
    const ext1 = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${sitId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-08-07' })
    expect(ext1.status).toBe(200)
    expect(ext1.body.extendedGuestMovedTo).toBeNull()
    const incUnit = await db.query(`SELECT unit_id FROM unit_bookings WHERE id=$1`, [incId])
    expect(incUnit.rows[0].unit_id).toBe(u2)

    // 2. Pin the incoming guest (revealed) back on unit 1 and fill RV 99 so
    //    the incoming can't move — the EXTENDING guest moves instead.
    await db.query(`UPDATE unit_bookings SET unit_id=$1, site_reveal_sent_at=now() WHERE id=$2`, [f.unitId, incId])
    await db.query(`UPDATE unit_bookings SET check_out='2026-08-05' WHERE id=$1`, [sitId])
    const ext2 = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${sitId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-08-07' })
    expect(ext2.status).toBe(200)
    expect(ext2.body.extendedGuestMovedTo?.unitNumber).toBe('RV 99')
    const sitUnit = await db.query(`SELECT unit_id FROM unit_bookings WHERE id=$1`, [sitId])
    expect(sitUnit.rows[0].unit_id).toBe(u2)

    // 3. Nothing open anywhere → 409 with both reasons.
    //    (RV 99 now holds the extended sitting guest; add a revealed block on
    //    it for a fresh extension attempt from a third booking on unit 1.)
    const third = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-08-09', checkOut: '2026-08-12' })
    const thirdId = third.body.data.id
    // Incoming (revealed) sits 08-05→08-09 on unit 1; extend third backward? Use forward:
    // occupy RV 99 across the third booking's would-be extension window.
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status, site_reveal_sent_at)
       VALUES ($1, $2, 'nightly', '2026-08-10', '2026-08-20', 'confirmed', now())`,
      [u2, f.landlordId])
    // A revealed incoming on unit 1 right after the third booking:
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status, site_reveal_sent_at)
       VALUES ($1, $2, 'nightly', '2026-08-12', '2026-08-16', 'confirmed', now())`,
      [f.unitId, f.landlordId])
    const ext3 = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${thirdId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-08-14' })
    expect(ext3.status).toBe(409)
    expect(ext3.body.error).toMatch(/no open site fits the extended stay/i)
  })

  it('unit swap to cross-landlord unit → 404 "Target unit not found"', async () => {
    const a = await seedUnitsFixture()
    const b = await seedUnitsFixture()
    const c = await request(buildApp())
      .post(`/api/units/${a.unitId}/bookings`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-07-01', checkOut: '2026-07-05' })
    const bookingId = c.body.data.id

    const res = await request(buildApp())
      .patch(`/api/units/${a.unitId}/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${a.landlordToken}`)
      .send({ unitId: b.unitId })  // b's unit, a's booking
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Target unit not found/)
  })
})

describe('POST /api/units/:id/mark-available + /mark-vacant', () => {
  it('mark-available rejected when unit not vacant → 400', async () => {
    const f = await seedUnitsFixture()
    // Default status is whatever seedUnit gives. Force to 'active' to assert
    // the route rejects non-vacant transitions.
    await db.query(`UPDATE units SET status='active' WHERE id=$1`, [f.unitId])
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/mark-available`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Only vacant units can be marked available/)
  })

  it('mark-vacant rejected when unit not available → 400', async () => {
    const f = await seedUnitsFixture()
    await db.query(`UPDATE units SET status='vacant' WHERE id=$1`, [f.unitId])
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/mark-vacant`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Only available units can be marked vacant/)
  })

  it('mark-available happy path: vacant → available', async () => {
    const f = await seedUnitsFixture()
    await db.query(`UPDATE units SET status='vacant' WHERE id=$1`, [f.unitId])
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/mark-available`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('available')
  })
})

describe('POST /api/units/:id/activate', () => {
  it('rejected when no active lease → 400', async () => {
    const f = await seedUnitsFixture()
    await db.query(`UPDATE units SET status='vacant', rent_amount=1500 WHERE id=$1`, [f.unitId])
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/activate`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/active lease/)
  })

  it('scheduledFor in past → 400', async () => {
    const f = await seedUnitsFixture()
    await db.query(`UPDATE units SET status='vacant', rent_amount=1500 WHERE id=$1`, [f.unitId])
    // Seed an active lease so the active-lease check passes. Minimal
    // schema columns (no tenant link required for the activation check).
    //
    // S618: start date is in the FUTURE, deliberately. A lease that has
    // already started now marks its unit occupied
    // (trg_occupy_unit_on_active_lease, migration 20260823120000), so the old
    // CURRENT_DATE version left the unit 'active' and the route answered
    // "Unit is already active" before it ever reached the scheduledFor check.
    // The route's active-lease test has no start-date condition, so a lease
    // starting next month satisfies it while the unit stays vacant — which is
    // also the real scenario for scheduling an activation.
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, start_date, lease_type, rent_amount, status)
       VALUES ($1, $2, CURRENT_DATE + INTERVAL '30 days', 'month_to_month', 1500, 'active')`,
      [f.unitId, f.landlordId])

    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/activate`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ scheduledFor: '2020-01-01T00:00:00Z' })  // in the past
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/scheduledFor must be in the future/)
  })
})


// ── S605 (Nic): a bare meter must not freeze a unit's number ────────────────
// Bulk-adding RV sites with electric submetering attached a meter to every
// unit, which then locked the numbers: "I cannot renumber the units even though
// no bills have gone out, no anything." Renumbering during onboarding is normal
// — gaps and 14/14A blocks only become obvious once the list is on screen.
describe('S605 renumbering during onboarding', () => {
  it('a meter with NO readings does not block a renumber', async () => {
    const f = await seedUnitsFixture()
    const meter = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits)
       VALUES ($1,'electric',$2,'submeter',6) RETURNING id`,
      [f.propertyId, 'RV 03 electric'])
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
      [meter.rows[0].id, f.unitId])

    const res = await request(buildApp()).patch(`/api/units/${f.unitId}/number`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ unitNumber: 'RV 14' })
    expect(res.status).toBe(200)
  })

  it('renumbering rewrites the generated meter label', async () => {
    const f = await seedUnitsFixture()
    await db.query(`UPDATE units SET unit_number='RV 03' WHERE id=$1`, [f.unitId])
    const meter = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits)
       VALUES ($1,'electric','RV 03 electric','submeter',6) RETURNING id`, [f.propertyId])
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
      [meter.rows[0].id, f.unitId])

    await request(buildApp()).patch(`/api/units/${f.unitId}/number`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ unitNumber: '14A' })
    const { rows } = await db.query<any>(`SELECT label FROM utility_meters WHERE id=$1`, [meter.rows[0].id])
    // Canonicalised against the unit's TYPE (the fixture unit is an apartment).
    expect(rows[0].label).toBe('APT 14A electric')   // not the stale 'RV 03 electric'
  })

  // S641: the number is no longer locked by history. A reading is exactly the
  // case Nic had in mind — "would we just say that we're changing the unit
  // number in the system, show a timeline" — and unit_number_history keeps what
  // the space was called when that reading was taken, so the record still reads
  // correctly after the rename.
  it('renumbers even with a meter reading on record, and keeps the old name', async () => {
    const f = await seedUnitsFixture()
    const meter = await db.query<any>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits)
       VALUES ($1,'electric','RV 03 electric','submeter',6) RETURNING id`, [f.propertyId])
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
      [meter.rows[0].id, f.unitId])
    await db.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, reason, created_by_user_id)
       VALUES ($1,'2026-08-01',1000,'2026-08-01','baseline',$2)`,
      [meter.rows[0].id, f.landlordUserId])

    const res = await request(buildApp()).patch(`/api/units/${f.unitId}/number`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ unitNumber: 'RV 14' })
    expect(res.status).toBe(200)

    const hist = await db.query<any>(
      `SELECT unit_number, effective_to FROM unit_number_history
        WHERE unit_id=$1 ORDER BY effective_from`, [f.unitId])
    expect(hist.rows.length).toBeGreaterThanOrEqual(2)
    expect(hist.rows.at(-1).effective_to).toBeNull()
    expect(hist.rows.at(-2).effective_to).not.toBeNull()
  })
})


// ── S605: a bare number can no longer be CREATED, because the platform supplies
// the prefix (see the standardized-numbering describe below). The earlier
// reject-on-bare-number rule was superseded by canonicalisation — kept here as
// the behavior it became, so nobody re-adds a 400 that can never fire.
describe('S605 bare numbers are canonicalised, not rejected', () => {
  it('a bare number is accepted and gains the type prefix', async () => {
    const f = await seedUnitsFixture()
    const res = await request(buildApp()).post('/api/units')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, unitNumber: '37', unitType: 'rv_spot', rentAmount: 500 })
    expect(res.status).toBe(201)
    expect(res.body.data.unitNumber ?? res.body.data.unit_number).toBe('RV 37')
  })

  it('a bare number with a letter suffix keeps the suffix', async () => {
    const f = await seedUnitsFixture()
    const res = await request(buildApp()).post('/api/units')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, unitNumber: '14A', unitType: 'rv_spot', rentAmount: 500 })
    expect(res.status).toBe(201)
    expect(res.body.data.unitNumber ?? res.body.data.unit_number).toBe('RV 14A')
  })

  it('renaming to a bare number re-canonicalises instead of failing', async () => {
    const f = await seedUnitsFixture()
    const res = await request(buildApp()).patch(`/api/units/${f.unitId}/number`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ unitNumber: '37' })
    expect(res.status).toBe(200)
    expect(res.body.data.unit_number ?? res.body.data.unitNumber).toMatch(/ 37$/)
  })
})


// ── S605 (Nic, DIRECTIVE): standard platform prefix per unit type ──────────
// "Each unit type should have a standard platform prefix. I don't want it to be
// mobile home site one spelled out on one property and MH one on a different
// property." The prefix is no longer the landlord's to type or omit.
describe('S605 standardized unit numbering', () => {
  const create = (f: any, body: any) =>
    request(buildApp()).post('/api/units')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, rentAmount: 500, ...body })

  it('supplies the type prefix and zero-pads a single digit', async () => {
    const f = await seedUnitsFixture()
    const res = await create(f, { unitNumber: '7', unitType: 'rv_spot' })
    expect(res.status).toBe(201)
    expect(res.body.data.unitNumber ?? res.body.data.unit_number).toBe('RV 07')
  })

  it('normalizes a spelled-out label to the standard prefix', async () => {
    const f = await seedUnitsFixture()
    const res = await create(f, { unitNumber: 'Mobile Home Site 1', unitType: 'mobile_home' })
    expect(res.status).toBe(201)
    expect(res.body.data.unitNumber ?? res.body.data.unit_number).toBe('MH 01')
  })

  it('does not double up when the landlord types the prefix too', async () => {
    const f = await seedUnitsFixture()
    const res = await create(f, { unitNumber: 'RV 12', unitType: 'rv_spot' })
    expect(res.status).toBe(201)
    expect(res.body.data.unitNumber ?? res.body.data.unit_number).toBe('RV 12')
  })

  // Nic: "units could also be a, b, c, d ... apartment a, apartment b".
  it('keeps a lettered identifier and never mistakes it for a label', async () => {
    const f = await seedUnitsFixture()
    const res = await create(f, { unitNumber: 'A', unitType: 'apartment' })
    expect(res.status).toBe(201)
    expect(res.body.data.unitNumber ?? res.body.data.unit_number).toBe('APT A')
  })

  it('renumbering re-canonicalises against the unit type', async () => {
    const f = await seedUnitsFixture()
    const made = await create(f, { unitNumber: '3', unitType: 'rv_spot' })
    const id = made.body.data.id
    const res = await request(buildApp()).patch(`/api/units/${id}/number`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ unitNumber: '9' })
    expect(res.status).toBe(200)
    expect(res.body.data.unit_number ?? res.body.data.unitNumber).toBe('RV 09')
  })
})


// ── S605 (Nic): the number field is the STARTING NUMBER ────────────────────
// "The prefix for the unit is automatically chosen by the unit type it's
// picked. Unit number is a starting point. They add however many units, and it
// tacks on to the counter."
describe('S605 bulk numbering starts where the landlord says', () => {
  it('starts the batch at the typed number', async () => {
    const f = await seedUnitsFixture()
    const res = await request(buildApp()).post('/api/units')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, unitNumber: '1', unitType: 'rv_spot',
              quantity: 3, rentAmount: 500 })
    expect(res.status).toBe(201)
    const { rows } = await db.query<any>(
      `SELECT unit_number FROM units WHERE property_id=$1 AND unit_number LIKE 'RV %' ORDER BY unit_number`,
      [f.propertyId])
    expect(rows.map((r: any) => r.unit_number)).toEqual(['RV 01', 'RV 02', 'RV 03'])
  })

  // The second block of a park: RV 20-36 alongside an existing RV 1-3 — the
  // landlord names where it starts and the counter runs from there.
  it('a later block starts at its own number, not after the highest', async () => {
    const f = await seedUnitsFixture()
    const app = buildApp()
    await request(app).post('/api/units').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, unitNumber: '1', unitType: 'rv_spot', quantity: 3, rentAmount: 500 })
    await request(app).post('/api/units').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, unitNumber: '20', unitType: 'rv_spot', quantity: 2, rentAmount: 500 })
    const { rows } = await db.query<any>(
      `SELECT unit_number FROM units WHERE property_id=$1 AND unit_number LIKE 'RV %' ORDER BY unit_number`,
      [f.propertyId])
    expect(rows.map((r: any) => r.unit_number)).toEqual(['RV 01', 'RV 02', 'RV 03', 'RV 20', 'RV 21'])
  })
})


// S605 (Nic, DIRECTIVE): "I want consistency platform wide. Remove those number
// padding options." A client sending padWidth must not be able to bypass it.
it('S605: padWidth from a client is ignored — always two digits', async () => {
  const f = await seedUnitsFixture()
  const res = await request(buildApp()).post('/api/units')
    .set('Authorization', `Bearer ${f.landlordToken}`)
    .send({ propertyId: f.propertyId, unitNumber: '8', unitType: 'rv_spot',
            quantity: 2, padWidth: 1, rentAmount: 500 })
  expect(res.status).toBe(201)
  const { rows } = await db.query<any>(
    `SELECT unit_number FROM units WHERE property_id=$1 AND unit_number LIKE 'RV %' ORDER BY unit_number`,
    [f.propertyId])
  expect(rows.map((r: any) => r.unit_number)).toEqual(['RV 08', 'RV 09'])   // not RV 8 / RV 9
})

/**
 * S629 — a pending invite from EITHER door has to hide the unit.
 *
 * Nic's S613 rule stops one space being offered to two households. It was only
 * half applied: pending_invite_count counted pending_lease_drafts (the Invite
 * Tenant modal) and not pending_tenant_intents (New Lease — Invite to Sign).
 *
 * Live, APT 04 had two people invited through the second door and reported
 * zero, so it stayed in the dropdown and could have been offered again.
 */
describe('pending_invite_count sees both invite flows', () => {
  it('counts a pending_tenant_intents invite, not just a lease draft', async () => {
    const c = await db.connect()
    let unitId = ''
    let token = ''
    try {
      await c.query('BEGIN')
      const { userId: llUser, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
      unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      // Invited, not yet accepted — the live-invite case.
      await c.query(
        `UPDATE users SET tenant_invite_expires_at = NOW() + INTERVAL '7 days'
          WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
      await c.query(
        `INSERT INTO pending_tenant_intents (unit_id, tenant_id, landlord_id, property_id)
         VALUES ($1,$2,$3,$4)`, [unitId, tenantId, landlordId, propertyId])
      await c.query('COMMIT')
      token = jwt.sign(
        { userId: llUser, role: 'landlord', email: 'll@t.dev', profileId: landlordId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await request(buildApp()).get('/api/units').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const unit = res.body.data.find((u: any) => u.id === unitId)
    expect(unit, 'the unit should be returned').toBeTruthy()
    // This harness mounts the router without the camelize interceptor, so the
    // response keeps the column's own name.
    expect(unit.pending_invite_count ?? unit.pendingInviteCount).toBe(1)
  })
})

// S653 (Nic): "on the space for mobile home three that I marked as owner use,
// there's no way to put an occupant name in there just for contact information."
describe('S653 owner-use occupant', () => {
  it('stores who is in an owner-use space and lists them on the emergency roster', async () => {
    const { seedLandlord, seedProperty, seedUnit } = await import('../test/dbHelpers')
    const jwt = (await import('jsonwebtoken')).default
    const c = await db.connect()
    let landlordId = '', userId = '', unitId = ''
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c); landlordId = ll.landlordId; userId = ll.userId
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      unitId = await seedUnit(c, { propertyId, landlordId })
      await c.query(`UPDATE units SET status='owner_use', unit_number='MH 03' WHERE id=$1`, [unitId])
      await c.query('COMMIT')
    } finally { c.release() }
    const token = jwt.sign({ userId, role: 'landlord', email: 'x@t.dev', landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp()).patch(`/api/units/${unitId}/details`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ownerOccupantName: 'Grandpa Rhoades', ownerOccupantPhone: '520-555-0100', ownerOccupantEmail: ' gp@example.com ' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const u = (await db.query(`SELECT owner_occupant_name, owner_occupant_phone, owner_occupant_email FROM units WHERE id=$1`, [unitId])).rows[0]
    expect(u).toEqual({ owner_occupant_name: 'Grandpa Rhoades', owner_occupant_phone: '520-555-0100', owner_occupant_email: 'gp@example.com' })
    const { emergencyContactRoster } = await import('../services/emergencyContacts')
    const roster = await emergencyContactRoster({ landlordIds: [landlordId], propertyIds: null })
    expect(roster.some((r: any) => r.tenant_id === null && r.tenant_first === 'Grandpa Rhoades' && r.unit_number === 'MH 03' && r.tenant_phone === '520-555-0100')).toBe(true)
  })
})

// ── S655: who sees which units ───────────────────────────────────────────────
//
// Two parks under one company, a resident living at each. The resident at
// park 1 is flagged SSI/SSDI.
async function seedTwoParks() {
  const f = await seedUnitsFixture()
  const c = await db.connect()
  try {
    const p2 = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId })
    const u2 = await seedUnit(c, { propertyId: p2, landlordId: f.landlordId })
    const t1 = await seedTenant(c)
    const t2 = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId: await seedLease(c, { unitId: f.unitId, landlordId: f.landlordId }), tenantId: t1 })
    await seedLeaseTenant(c, { leaseId: await seedLease(c, { unitId: u2, landlordId: f.landlordId }), tenantId: t2 })
    await c.query(`UPDATE tenants SET ssi_ssdi = TRUE WHERE id = $1`, [t1])
    const { rows: [staff] } = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Park', 'Two', TRUE) RETURNING id`, [`os-${randomUUID()}@test.dev`])
    await c.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3::uuid[], FALSE)`, [staff.id, f.landlordId, [p2]])
    const staffToken = jwt.sign(
      { userId: staff.id, role: 'onsite_manager', email: 'os@test.dev', profileId: null,
        landlordId: f.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { ...f, p2, u2, t1, t2, staffId: staff.id, staffToken }
  } finally { c.release() }
}

describe('S655: SSI/SSDI never reaches a landlord or staff member', () => {
  // Nic, 10/2: "That's our check for the flex products." It stays GAM-side.
  it('the unit page and the unit list carry no SSI/SSDI flag, for the owner or for staff', async () => {
    const f = await seedTwoParks()
    await db.query(`UPDATE onsite_manager_scopes SET all_properties = TRUE WHERE user_id = $1`, [f.staffId])
    for (const token of [f.landlordToken, f.staffToken]) {
      const one = await request(buildApp()).get(`/api/units/${f.unitId}`).set('Authorization', `Bearer ${token}`)
      expect(one.status).toBe(200)
      expect(one.body.data.tenant_id).toBe(f.t1)          // the flagged resident lives here
      expect(JSON.stringify(one.body)).not.toMatch(/ssi_ssdi|ssiSsdi/i)
      const list = await request(buildApp()).get('/api/units').set('Authorization', `Bearer ${token}`)
      expect(list.status).toBe(200)
      expect(list.body.data.map((u: any) => u.tenant_id)).toContain(f.t1)
      expect(JSON.stringify(list.body)).not.toMatch(/ssi_ssdi|ssiSsdi/i)
    }
  })
})

describe('S655: a staff member assigned to one property sees that property\'s units only', () => {
  it('the unit list (the Tenants page) shows their property\'s units and residents; all-properties staff and the owner see both parks; no properties shows none', async () => {
    const f = await seedTwoParks()
    const list = async (token: string) => {
      const res = await request(buildApp()).get('/api/units').set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      return res.body.data as any[]
    }

    const scoped = await list(f.staffToken)
    expect(scoped.map(u => u.id)).toEqual([f.u2])
    expect(scoped.map(u => u.tenant_id)).toEqual([f.t2])
    // Asking for the other park by name does not get around it.
    const res = await request(buildApp()).get(`/api/units?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.staffToken}`)
    expect(res.body.data).toEqual([])

    expect((await list(f.landlordToken)).map(u => u.id).sort()).toEqual([f.unitId, f.u2].sort())

    await db.query(`UPDATE onsite_manager_scopes SET all_properties = TRUE WHERE user_id = $1`, [f.staffId])
    expect((await list(f.staffToken)).map(u => u.id).sort()).toEqual([f.unitId, f.u2].sort())

    await db.query(`UPDATE onsite_manager_scopes SET all_properties = FALSE, property_ids = '{}'::uuid[] WHERE user_id = $1`, [f.staffId])
    expect(await list(f.staffToken)).toEqual([])
  })

  it('opening a unit at another property is refused in plain words; their own property\'s unit opens', async () => {
    const f = await seedTwoParks()
    const open = (unitId: string) => request(buildApp()).get(`/api/units/${unitId}`).set('Authorization', `Bearer ${f.staffToken}`)

    const refused = await open(f.unitId)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/at a property you're not assigned to/)
    expect(JSON.stringify(refused.body)).not.toContain('@')   // no resident contact rides along

    const mine = await open(f.u2)
    expect(mine.status).toBe(200)
    expect(mine.body.data.tenant_id).toBe(f.t2)

    // The owner is never property-limited.
    const owner = await request(buildApp()).get(`/api/units/${f.unitId}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(owner.status).toBe(200)
  })
})

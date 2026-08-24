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
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLateFeeDecision,
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

  // The original protection must survive: once a meter has a reading, the number
  // is genuinely load-bearing on records and stays locked.
  it('a meter WITH a reading still blocks the renumber', async () => {
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
    expect(res.status).toBe(409)
  })
})


// ── S605: a bare number can no longer be CREATED, because the platform supplies
// the prefix (see the standardized-numbering describe below). The earlier
// reject-on-bare-number rule was superseded by canonicalisation — kept here as
// the behaviour it became, so nobody re-adds a 400 that can never fire.
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

  it('normalises a spelled-out label to the standard prefix', async () => {
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

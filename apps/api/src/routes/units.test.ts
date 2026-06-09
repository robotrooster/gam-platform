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
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit,
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
    const res = await request(buildApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        unitNumber: '101',
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
      .send({ propertyId: b.propertyId, unitNumber: '999', rentAmount: 1000 })
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
  it('happy path: returns 201; nights computed; platform_fee 5%', async () => {
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
    expect(Number(res.body.data.platform_fee)).toBe(20)  // 5% of 400
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
})

describe('PATCH /api/units/:id/bookings/:bookingId — update', () => {
  it('happy path: date change recomputes nights', async () => {
    const f = await seedUnitsFixture()
    const c = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ leaseType: 'nightly', checkIn: '2026-07-01', checkOut: '2026-07-05' })
    const bookingId = c.body.data.id

    const res = await request(buildApp())
      .patch(`/api/units/${f.unitId}/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ checkOut: '2026-07-08' })
    expect(res.status).toBe(200)
    expect(res.body.data.nights).toBe(7)  // 07-01 to 07-08
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
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, start_date, lease_type, rent_amount, status)
       VALUES ($1, $2, CURRENT_DATE, 'month_to_month', 1500, 'active')`,
      [f.unitId, f.landlordId])

    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/activate`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ scheduledFor: '2020-01-01T00:00:00Z' })  // in the past
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/scheduledFor must be in the future/)
  })
})

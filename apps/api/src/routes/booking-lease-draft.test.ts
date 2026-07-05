/**
 * S526: long stays auto-draft a lease. A reservation of 30+ nights (7+ when
 * the property runs weekly leases) creates a pending, needs_review lease
 * (lease_source 'booking_draft') linked via source_booking_id — idempotent
 * per booking, and never blocks the reservation itself.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_lease_draft'
})

async function seed(opts: { weeklyLeaseMode?: boolean } = {}) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    if (opts.weeklyLeaseMode) {
      await client.query(`UPDATE properties SET weekly_lease_mode = TRUE WHERE id = $1`, [propId])
    }
    const unitId = await seedUnit(client, { propertyId: propId, landlordId })
    await client.query(
      `UPDATE units SET lease_types_allowed = '{}', is_bookable = TRUE WHERE id = $1`, [unitId])
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, unitId, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

const book = (app: any, token: string, unitId: string, checkIn: string, checkOut: string) =>
  request(app)
    .post(`/api/units/${unitId}/bookings`)
    .set('Authorization', `Bearer ${token}`)
    .send({ guestName: 'Long Stayer', leaseType: 'month_to_month', checkIn, checkOut })

// The draft fires post-response (best-effort) — settle the microtask queue.
const settle = () => new Promise(r => setTimeout(r, 150))

describe('booking → auto lease draft', () => {
  it('short stay (< 30 nights) drafts nothing', async () => {
    const f = await seed()
    const res = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-03-10')
    expect(res.status).toBe(201)
    await settle()
    const leases = await db.query(`SELECT id FROM leases WHERE source_booking_id = $1`, [res.body.data.id])
    expect(leases.rows.length).toBe(0)
  })

  it('30+ night stay drafts a pending needs_review lease with the stay dates', async () => {
    const f = await seed()
    const res = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-04-05')
    expect(res.status).toBe(201)
    await settle()
    const { rows } = await db.query(
      `SELECT status, needs_review, lease_source, lease_type, start_date::text, end_date::text, rent_amount
         FROM leases WHERE source_booking_id = $1`, [res.body.data.id])
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('pending')
    expect(rows[0].needs_review).toBe(true)
    expect(rows[0].lease_source).toBe('booking_draft')
    expect(rows[0].start_date).toBe('2027-03-01')
    expect(rows[0].end_date).toBe('2027-04-05')
  })

  it('extending a booking past the threshold drafts once — and only once', async () => {
    const f = await seed()
    const app = buildApp()
    const created = await book(app, f.token, f.unitId, '2027-03-01', '2027-03-10')
    expect(created.status).toBe(201)
    await settle()
    // Extend to 40 nights.
    const ext = await request(app)
      .patch(`/api/units/${f.unitId}/bookings/${created.body.data.id}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ checkOut: '2027-04-10' })
    expect(ext.status).toBe(200)
    await settle()
    // Extend again — still exactly one draft.
    await request(app)
      .patch(`/api/units/${f.unitId}/bookings/${created.body.data.id}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ checkOut: '2027-04-15' })
    await settle()
    const { rows } = await db.query(
      `SELECT id FROM leases WHERE source_booking_id = $1`, [created.body.data.id])
    expect(rows.length).toBe(1)
  })

  it('weekly_lease_mode property drafts at 7+ nights', async () => {
    const f = await seed({ weeklyLeaseMode: true })
    const res = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-03-09')
    expect(res.status).toBe(201)
    await settle()
    const { rows } = await db.query(
      `SELECT id FROM leases WHERE source_booking_id = $1`, [res.body.data.id])
    expect(rows.length).toBe(1)
  })
})

describe('POST /units — storage size + RV defaults (S526)', () => {
  it('storage unit stores its size; rv unit is bookable with all stay lengths', async () => {
    const f = await seed()
    const app = buildApp()
    const stor = await request(app).post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: (await db.query(`SELECT property_id FROM units WHERE id=$1`, [f.unitId])).rows[0].property_id,
              unitNumber: 'S-1', unitType: 'storage', rentAmount: 80, storageSize: '10x10' })
    expect(stor.status).toBe(201)
    expect(stor.body.data.storage_size).toBe('10x10')

    const rv = await request(app).post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: stor.body.data.property_id, unitNumber: 'RV-1', unitType: 'rv_spot',
              rentAmount: 500, rvSiteLayout: 'pull_through', rvAmpService: '50' })
    expect(rv.status).toBe(201)
    expect(rv.body.data.is_bookable).toBe(true)
    expect(rv.body.data.lease_types_allowed).toEqual(['nightly', 'weekly', 'month_to_month', 'long_term'])
  })
})

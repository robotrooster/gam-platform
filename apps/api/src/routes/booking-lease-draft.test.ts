/**
 * 10/5 (Nic, R2/R3): no lease is drafted on its own any more. S526 drafted one
 * for every reservation of 30+ nights (7+ when the property ran weekly
 * leases); now the schedule asks the front counter "lease or stay?" for a
 * stay of 30+ continuous nights and does what they answer: a lease chosen
 * drafts a month-to-month lease (no end date) for the landlord to review; a
 * stay drafts nothing and is held only through what is paid. The weekly-lease
 * setting no longer moves anything (R14).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const { utilityInviteMock, depositLinkMock, feeLinkMock } = vi.hoisted(() => ({
  utilityInviteMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  depositLinkMock: vi.fn(async (..._a: any[]) => ({ id: 'link-deposit', url: 'https://pay.test/deposit' })),
  feeLinkMock: vi.fn(async (..._a: any[]) => ({ id: 'link-fee', url: 'https://pay.test/fee' })),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailUtilityServiceInvite: utilityInviteMock,
}))
// 10/5 (A2): a stay that needs the background check's fee goes out as a pay
// link (or to the register). The links themselves are routes/posPayLinks' own
// tests; here they only have to be sent.
vi.mock('./posPayLinks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createBookingDepositLink: depositLinkMock,
  createScreeningFeeLink: feeLinkMock,
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLateFeeDecision } from '../test/dbHelpers'
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
  utilityInviteMock.mockClear()
  depositLinkMock.mockClear()
  feeLinkMock.mockClear()
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

const book = (app: any, token: string, unitId: string, checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/units/${unitId}/bookings`)
    .set('Authorization', `Bearer ${token}`)
    .send({ guestName: 'Long Stayer', guestEmail: 'long.stayer@t.dev', leaseType: 'month_to_month', checkIn, checkOut, ...extra })

const leasesOf = async (bookingId: string) => (await db.query(
  `SELECT status, needs_review, lease_source, lease_type, start_date::text AS start_date, end_date::text AS end_date
     FROM leases WHERE source_booking_id = $1`, [bookingId])).rows

describe('the schedule asks lease or stay — no lease is drafted on its own (10/5, R2/R3)', () => {
  it('a short stay (< 30 nights) asks nothing and drafts nothing', async () => {
    const f = await seed()
    const res = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-03-10')
    expect(res.status).toBe(201)
    expect(await leasesOf(res.body.data.id)).toEqual([])
    expect(res.body.data.stay.terms).toBeNull()
  })

  it('a 30+ night stay with no answer is refused with the question, and nothing is written', async () => {
    const f = await seed()
    const res = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-04-05')
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('stay_terms_needed')
    expect(res.body.nights).toBe(35)
    expect(res.body.error).toMatch(/A lease holds the site for as long as they stay/)
    const rows = await db.query(`SELECT id FROM unit_bookings WHERE unit_id = $1`, [f.unitId])
    expect(rows.rows.length).toBe(0)
  })

  it('lease chosen → a month-to-month draft with no end date, from the arrival day', async () => {
    const f = await seed()
    // A2: 35 nights with no check on file — the check's fee rides on the deposit link.
    const res = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-04-05', { stayTerms: 'lease', sendDepositLink: true })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const rows = await leasesOf(res.body.data.id)
    expect(rows).toEqual([{
      status: 'pending', needs_review: true, lease_source: 'booking_draft', lease_type: 'month_to_month',
      start_date: '2027-03-01', end_date: null,
    }])
    expect(res.body.data.stay).toMatchObject({ terms: 'lease', nights: 35 })
    const b = await db.query(`SELECT stay_terms, screening_required FROM unit_bookings WHERE id = $1`, [res.body.data.id])
    expect(b.rows[0]).toEqual({ stay_terms: 'lease', screening_required: true })
  })

  it('stay chosen → no lease; the landlord is told the site is held only through check-out', async () => {
    const f = await seed()
    const res = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-04-05', { stayTerms: 'stay', sendDepositLink: true })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await leasesOf(res.body.data.id)).toEqual([])
    expect(res.body.data.stay.terms).toBe('stay')
    expect(res.body.data.stay.heldThrough).toMatch(/held through April 5, 2027/)
    const n = await db.query(
      `SELECT title FROM notifications WHERE type = 'long_stay_no_lease' AND data->>'bookingId' = $1`, [res.body.data.id])
    expect(n.rows.map(r => r.title)).toEqual(['Long stay — no lease'])
  })

  it('extending past 30 nights asks; the lease answer drafts once, and a later extension asks nothing', async () => {
    const f = await seed()
    const app = buildApp()
    const created = await book(app, f.token, f.unitId, '2027-03-01', '2027-03-10')
    expect(created.status).toBe(201)
    const id = created.body.data.id
    const patch = (body: Record<string, unknown>) => request(app)
      .patch(`/api/units/${f.unitId}/bookings/${id}`).set('Authorization', `Bearer ${f.token}`).send(body)

    const asked = await patch({ checkOut: '2027-04-10' })
    expect(asked.status).toBe(409)
    expect(asked.body.code).toBe('stay_terms_needed')
    expect((await db.query(`SELECT check_out::text AS d FROM unit_bookings WHERE id = $1`, [id])).rows[0].d).toBe('2027-03-10')

    const ext = await patch({ checkOut: '2027-04-10', stayTerms: 'lease' })
    expect(ext.status, JSON.stringify(ext.body)).toBe(200)
    expect(await leasesOf(id)).toHaveLength(1)
    // M3: the longer stay now needs a background check — its fee went out on a pay link of its own.
    expect(feeLinkMock).toHaveBeenCalledTimes(1)
    expect(ext.body.data.stay).toMatchObject({ screening: 'fee_due', screeningFeeLink: { id: 'link-fee' } })

    // Longer again: the stay has its answer (the lease) — no question, no second draft,
    // and the month-to-month lease keeps no end date.
    const again = await patch({ checkOut: '2027-04-15' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    const rows = await leasesOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].end_date).toBeNull()
  })

  it('a check-in click on a long stay never drafts a lease (the S526 re-check on every save is gone)', async () => {
    const f = await seed()
    const created = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-03-20')
    const id = created.body.data.id
    // Booked before 10/5 at 35 nights, no answer: stays as it was (R15).
    await db.query(`UPDATE unit_bookings SET check_out = '2027-04-05', nights = 35 WHERE id = $1`, [id])
    await request(buildApp()).patch(`/api/units/${f.unitId}/bookings/${id}`)
      .set('Authorization', `Bearer ${f.token}`).send({ notes: 'phone changed' })
    expect(await leasesOf(id)).toEqual([])
  })

  it('weekly_lease_mode no longer drafts at 7+ nights (R14)', async () => {
    const f = await seed({ weeklyLeaseMode: true })
    const res = await book(buildApp(), f.token, f.unitId, '2027-03-01', '2027-03-09')
    expect(res.status).toBe(201)
    expect(await leasesOf(res.body.data.id)).toEqual([])
  })

  it('a stay of more than three weeks needs the guest\'s email', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ guestName: 'No Email', leaseType: 'weekly', checkIn: '2027-03-01', checkOut: '2027-03-25' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/needs the guest's email/)
  })
})

describe('POST /units — storage size + RV defaults (S526)', () => {
  it('storage unit stores its size; rv unit is bookable with all stay lengths', async () => {
    const f = await seed()
    const app = buildApp()
    // S537 gate: POST /units refuses undecided late-fee classes — seed
    // explicit no-fee decisions for the two classes this test creates.
    {
      const client = await db.connect()
      try {
        const propId = (await client.query(`SELECT property_id FROM units WHERE id=$1`, [f.unitId])).rows[0].property_id
        await seedLateFeeDecision(client, { propertyId: propId, unitType: 'storage', noLateFee: true })
        await seedLateFeeDecision(client, { propertyId: propId, unitType: 'rv_spot', noLateFee: true })
      } finally { client.release() }
    }
    const stor = await request(app).post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: (await db.query(`SELECT property_id FROM units WHERE id=$1`, [f.unitId])).rows[0].property_id,
              unitNumber: 'S-1', unitType: 'storage', rentAmount: 80, storageSize: '10x10' })
    expect(stor.status).toBe(201)
    expect(stor.body.data.storage_size).toBe('10x10')
    // S538: storage is locked out of short-term rental at creation.
    expect(stor.body.data.lease_types_allowed).toEqual(['month_to_month', 'long_term'])
    expect(stor.body.data.is_bookable).toBe(false)

    const rv = await request(app).post('/api/units')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: stor.body.data.property_id, unitNumber: 'RV-1', unitType: 'rv_spot',
              rentAmount: 500, rvSiteLayout: 'pull_through', rvAmpService: '50' })
    expect(rv.status).toBe(201)
    expect(rv.body.data.is_bookable).toBe(true)
    expect(rv.body.data.lease_types_allowed).toEqual(['nightly', 'weekly', 'month_to_month', 'long_term'])
  })
})

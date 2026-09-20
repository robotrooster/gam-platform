/**
 * S652 — the counter's reservation, end to end through the real endpoint.
 *
 * Nic's flow, in his words: "pick arrival AND end date → 'Show available'
 * filters out anything not free for the whole stay → the counter tells the
 * customer what IS available (30 amp, back-in, pull-through) → the customer
 * chooses from what exists → THEN the counter picks the space → THEN name,
 * phone, email → emailed a deposit pay link. Names come last, after the
 * negotiation, not first."
 *
 * What is tested here is the end of that: what the server does once the counter
 * has a space and a name — the hold with no clock on it, the lock, and the fact
 * that an unpaid hold steps aside for a reservation somebody is paying for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

// No real pay link, no real email: this suite is about the booking rows.
vi.mock('./posPayLinks', async (orig) => {
  const actual: any = await orig()
  return { ...actual, createBookingDepositLink: vi.fn(async () => ({ id: 'link_1', url: 'https://pay/x' })) }
})

let unitsRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_counter'
  ;({ unitsRouter } = await import('./units'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

async function seed(sites = 2) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    // The deposit percentage is one of four the schema allows (5/10/15/20).
    await c.query(`UPDATE properties SET booking_deposit_pct = 20 WHERE id = $1`, [propertyId])
    const unitIds: string[] = []
    for (let i = 1; i <= sites; i++) {
      const u = await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, is_bookable, rv_site_layout, rv_amp_service)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',40,TRUE,'pull_through','50') RETURNING id`,
        [propertyId, landlordId, `RV 0${i}`])
      unitIds.push(u.rows[0].id)
    }
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitIds, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const reserve = (f: any, unitId: string, body: any = {}) =>
  request(buildApp()).post(`/api/units/${unitId}/bookings`)
    .set('Authorization', `Bearer ${f.token}`)
    .send({
      guestName: 'Dale Carter', guestEmail: 'dale@t.dev', guestPhone: '520-555-0110',
      leaseType: 'nightly', checkIn: '2027-03-06', checkOut: '2027-03-13',
      source: 'direct', ...body,
    })

describe('the counter takes a reservation', () => {
  it('holds the site with no clock on it when a deposit link goes out', async () => {
    // A timer would throw away real business for the crime of being slow — a
    // link sent at five on a Friday, read on Monday, and the site is gone.
    const f = await seed()
    const res = await reserve(f, f.unitIds[0], { sendDepositLink: true })
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const [b] = await query<any>(`SELECT status, hold_expires_at, locked_to_unit FROM unit_bookings`)
    expect(b.status).toBe('tentative')
    expect(b.hold_expires_at).toBeNull()
    expect(b.locked_to_unit).toBe(false)     // movable unless the counter said otherwise
  })

  it('pins the stay when the counter promised them that exact space', async () => {
    const f = await seed()
    await reserve(f, f.unitIds[0], { sendDepositLink: true, lockedToUnit: true })
    const [b] = await query<any>(`SELECT locked_to_unit FROM unit_bookings`)
    expect(b.locked_to_unit).toBe(true)
  })

  it('an unpaid hold moves aside for a reservation being paid for', async () => {
    const f = await seed(2)
    await reserve(f, f.unitIds[0], { sendDepositLink: true })      // holds RV 01, unpaid

    // Somebody else takes RV 01 for the same week and is not waiting on a link.
    const paid = await reserve(f, f.unitIds[0], { guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev' })
    expect(paid.status, JSON.stringify(paid.body)).toBe(201)

    const rows = await query<any>(
      `SELECT guest_name, unit_id, status FROM unit_bookings ORDER BY guest_name`)
    const dale = rows.find((r: any) => r.guest_name === 'Dale Carter')
    const pat  = rows.find((r: any) => r.guest_name === 'Pat Ruiz')
    expect(pat.unit_id).toBe(f.unitIds[0])       // the payer got the site
    expect(dale.unit_id).toBe(f.unitIds[1])      // the holder was moved, not dropped
    expect(dale.status).toBe('tentative')        // and is still coming
  })

  it('costs the holder the site only when the park has nothing else', async () => {
    const f = await seed(1)
    await reserve(f, f.unitIds[0], { sendDepositLink: true })
    const paid = await reserve(f, f.unitIds[0], { guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev' })
    expect(paid.status).toBe(201)

    const [dale] = await query<any>(
      `SELECT status, displaced_reason FROM unit_bookings WHERE guest_name = 'Dale Carter'`)
    expect(dale.status).toBe('cancelled')
    expect(dale.displaced_reason).toMatch(/nothing else free/i)
  })

  it('one unpaid hold cannot bump another', async () => {
    // Two holds on one site is a double booking with extra steps.
    const f = await seed(2)
    await reserve(f, f.unitIds[0], { sendDepositLink: true })
    const second = await reserve(f, f.unitIds[0], {
      sendDepositLink: true, guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev' })
    expect(second.status).toBe(409)
  })

  it('a paid reservation is never displaced by another paid one', async () => {
    const f = await seed(2)
    const first = await reserve(f, f.unitIds[0])
    expect(first.status).toBe(201)
    const second = await reserve(f, f.unitIds[0], { guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev' })
    expect(second.status).toBe(409)
  })
})

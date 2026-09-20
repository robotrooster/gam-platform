/**
 * S651 — the whole path: ring a stay at the counter, get a booking on the
 * Master Schedule.
 *
 * The service is tested on its own (services/registerStay.test.ts). This is the
 * wiring: the real endpoint, the real payload the register sends, and the row
 * that has to come out the other side. A sale that takes the money and records
 * no stay is the bug this exists to stop, and it lived in the route, not the
 * service.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'

vi.mock('../services/posTax', async (orig) => {
  const actual: any = await orig()
  return {
    ...actual,
    calculateCartTax: async (_l: string, cart: any[]) => ({
      subtotal: cart.reduce((s, l) => s + l.qty * l.unitPrice, 0),
      taxAmount: 0,
      lines: cart.map((l) => ({ itemId: l.itemId, lineSubtotal: l.qty * l.unitPrice, lineTax: 0 })),
    }),
  }
})

let posRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stays'
  ;({ posRouter } = await import('./pos'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

async function seed(stayUnit: 'night' | 'week' | 'month' = 'night', price = 49) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const cat = await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1,'Stays',1,TRUE) RETURNING id`, [landlordId])
    const item = await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,$3,$4,$5,0,0,999,0,999,$6) RETURNING id`,
      [landlordId, propertyId, `RV site — ${stayUnit}`, cat.rows[0].id, price, stayUnit])
    const unit = await c.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type)
       VALUES ($1,$2,'RV 01','vacant',500,'rv_spot') RETURNING id`, [propertyId, landlordId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, itemId: item.rows[0].id, unitId: unit.rows[0].id, token, price }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const sell = (f: any, body: any = {}) =>
  request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${f.token}`)
    .send({
      items: [{ id: f.itemId, name: 'RV site', qty: 3, price: f.price, tax: 0 }],
      paymentMethod: 'cash', propertyId: f.propertyId,
      stay: { unitId: f.unitId, checkIn: '2026-10-01', guestName: 'Dale Carter', guestPhone: '520-555-0110' },
      ...body,
    })

describe('ringing a stay at the register', () => {
  it('records the sale AND the booking', async () => {
    const f = await seed()
    const res = await sell(f)
    expect(res.status).toBe(201)
    expect(res.body.data.stayBooking).toBeTruthy()
    expect(res.body.data.stayBooking.checkOut).toBe('2026-10-04')

    const [b] = await query<any>(
      `SELECT guest_name, check_in::text, check_out::text, nights, source,
              total_amount::text, pos_transaction_id
         FROM unit_bookings WHERE unit_id = $1`, [f.unitId])
    expect(b.guest_name).toBe('Dale Carter')
    expect(b.check_out).toBe('2026-10-04')       // 3 nights from the 1st
    expect(b.nights).toBe(3)
    expect(b.source).toBe('register')
    expect(Number(b.total_amount)).toBe(147)     // 3 × $49, the register's price
    expect(b.pos_transaction_id).toBe(res.body.data.id)
  })

  it('refuses a stay with no site or date, and takes no money', async () => {
    // The whole failure this replaces: money taken, nothing on the schedule.
    const f = await seed()
    const res = await sell(f, { stay: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/site and an arrival date/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('rolls the sale back when the site is already taken', async () => {
    // A paid stay on a site somebody else has is worse than a refused sale.
    const f = await seed()
    expect((await sell(f)).status).toBe(201)
    const second = await sell(f, { stay: { unitId: f.unitId, checkIn: '2026-10-02', guestName: 'Someone Else' } })
    expect(second.status).toBe(409)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(1)   // only the first
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(1)
  })

  it('leaves an ordinary sale completely alone', async () => {
    const f = await seed()
    await query(`UPDATE pos_items SET stay_unit = NULL WHERE id = $1`, [f.itemId])
    const res = await sell(f, { stay: null })
    expect(res.status).toBe(201)
    expect(res.body.data.stayBooking).toBeNull()
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(0)
  })

  it('a week of quantity two is fourteen nights', async () => {
    const f = await seed('week', 250)
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [{ id: f.itemId, name: 'RV site', qty: 2, price: 250, tax: 0 }],
        paymentMethod: 'cash', propertyId: f.propertyId,
        stay: { unitId: f.unitId, checkIn: '2026-10-01', guestName: 'Dale Carter' },
      })
    expect(res.status).toBe(201)
    expect(res.body.data.stayBooking.checkOut).toBe('2026-10-15')
    expect(res.body.data.stayBooking.nights).toBe(14)
  })
})

describe('what the cashier is offered', () => {
  it('lists only sites that are actually free', async () => {
    const f = await seed()
    const free = () => request(buildApp())
      .get(`/api/pos/stays/available?propertyId=${f.propertyId}&checkIn=2026-10-01&stayUnit=night&qty=3`)
      .set('Authorization', `Bearer ${f.token}`)

    expect((await free()).body.data.units).toHaveLength(1)
    await sell(f)
    // Now booked — and gone from the list, rather than offered and refused at
    // the counter with a customer standing there.
    const after = await free()
    expect(after.body.data.units).toHaveLength(0)
    expect(after.body.data.checkOut).toBe('2026-10-04')
  })
})

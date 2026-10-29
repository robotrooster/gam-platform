/**
 * 10/21 (Nic) — A BACKGROUND CHECK AT THE COUNTER, WITH NO STAY UNDER IT.
 *
 *   "Somebody pays for a background check in person. The only way to get there
 *    is to book 22 nights or more. What happens? They have to pay not only for
 *    the check, but the whole 22 nights just to do the check. And then what
 *    happens if the landlord denies them? Maybe we need a way for them to just
 *    pay directly for the background check right then and there... for people
 *    that just legitimately want to move in, they need to be able to just do
 *    the background check first and see if they're going to be approved."
 *
 * Before this, the register could only carry a screening line that a 22-night
 * stay had put there — so an applicant had to buy three weeks to buy a check,
 * and a denial left them holding a stay they could not use.
 *
 * It is one price, $46.03, the same as every other way a check is sold, and the
 * card fee is never added on top of it (its processing is already inside).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
const h = vi.hoisted(() => ({
  receiptMock: vi.fn(async (..._a: any[]) => null),
  screeningMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailBackgroundCheckScreeningRequest: h.screeningMock,
  emailPosReceipt: h.receiptMock,
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PROCESSING_FEES } from '@gam/shared'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { posRouter } from './pos'
import { screeningIntakeFee } from './background'

function app() {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => { const j = res.json.bind(res); res.json = (b: any) => j(camelCaseKeys(b)); next() })
  a.use('/api/pos', posRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  h.screeningMock.mockClear(); h.receiptMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_counter_screening'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_cs_' || replace($1::text,'-','') WHERE id = $1`, [landlordId])
    await c.query(`UPDATE properties SET register_card_fee_payer = 'customer' WHERE id = $1`, [propertyId])
    const cat = (await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Shop',1,TRUE) RETURNING id`, [landlordId])).rows[0].id
    const soda = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Soda',$3,2,1,0,999,0,999) RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const month = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — monthly',$3,0,0,0,999,0,999,'month') RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const unitId = (await c.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, monthly_rate, is_bookable)
       VALUES ($1,$2,'RV 01','vacant',500,'rv_spot',40,440,TRUE) RETURNING id`, [propertyId, landlordId])).rows[0].id
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, soda, month, unitId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type F = Awaited<ReturnType<typeof seed>>
const auth = (f: F) => ({ Authorization: `Bearer ${f.token}` })

const WALKIN = { name: 'Pat Walkin', email: 'Pat@Walkin.dev' }

const ring = (f: F, body: any = {}) => request(app()).post('/api/pos/transactions').set(auth(f))
  .send({ propertyId: f.propertyId, paymentMethod: 'cash', items: [], screening: WALKIN, ...body })

const quote = (f: F, body: any = {}) => request(app()).post('/api/pos/cart-quote').set(auth(f))
  .send({ propertyId: f.propertyId, paymentMethod: 'cash', items: [], screening: WALKIN, ...body })

describe('a background check rung on its own at the counter', () => {
  it('is the one price a check costs anywhere — nothing about it comes from the cart', async () => {
    const f = await seed()
    const fee = (await screeningIntakeFee('AZ')).total
    const q = await quote(f)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data.screening).toMatchObject({ name: 'Pat Walkin', email: 'pat@walkin.dev' })
    expect(q.body.data.total).toBe(fee)
    // And a register that tries to name its own price is ignored, not obeyed.
    const lying = await quote(f, { screening: { ...WALKIN, price: 1 } })
    expect(lying.body.data.total).toBe(fee)
  })

  it('takes no card fee on top of it, because its processing is already inside the price', async () => {
    const f = await seed()
    const fee = (await screeningIntakeFee('AZ')).total
    const onCard = await quote(f, { paymentMethod: 'card' })
    expect(onCard.body.data.surcharge).toBe(0)
    expect(onCard.body.data.total).toBe(fee)
    // A soda beside it still pays its own fee — only the check is left out.
    const withSoda = await quote(f, { paymentMethod: 'card', items: [{ id: f.soda, name: 'Soda', qty: 1, price: 2, tax: 0 }] })
    expect(withSoda.body.data.surcharge)
      .toBe(Math.round((2 * PROCESSING_FEES.CARD_PCT + PROCESSING_FEES.CARD_FLAT) * 100) / 100)
    expect(withSoda.body.data.total).toBe(Math.round((fee + 2 + withSoda.body.data.surcharge) * 100) / 100)
  })

  it('records it as paid and waiting, with no booking, and emails them the link', async () => {
    const f = await seed()
    const fee = (await screeningIntakeFee('AZ')).total
    const sale = await ring(f)
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)

    const [sp] = await query<any>(
      `SELECT amount::float AS amount, email, booking_id, status, source, landlord_charge_id
         FROM screening_prepayments`)
    expect(sp).toMatchObject({ amount: fee, email: 'pat@walkin.dev', booking_id: null, status: 'unused', source: 'register' })
    // Cash is in the landlord's drawer, so GAM takes its fee from their payout.
    expect(sp.landlord_charge_id).not.toBeNull()
    expect(h.screeningMock).toHaveBeenCalledTimes(1)
    expect(h.screeningMock.mock.calls[0][0]).toBe('pat@walkin.dev')
  })

  it('refuses without a name, and without an email it can actually reach them at', async () => {
    const f = await seed()
    const noName = await ring(f, { screening: { email: 'pat@walkin.dev' } })
    expect(noName.status).toBe(400)
    expect(noName.body.error).toMatch(/needs the person's name/)
    const badEmail = await ring(f, { screening: { name: 'Pat', email: 'pat at walkin' } })
    expect(badEmail.status).toBe(400)
    // The email is not a nicety: it is how they sign in, and every account has
    // email 2FA on, so a wrong one locks them out of what they just paid for.
    expect(badEmail.body.error).toMatch(/they sign in with it/)
    expect(await query('SELECT 1 FROM screening_prepayments')).toHaveLength(0)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('never a second check on a stay that already carries one', async () => {
    const f = await seed()
    // A 30-night stay brings its own check (R8, a line the cart cannot remove).
    // Asking for a standalone one beside it would sell the same person two.
    const fee = (await screeningIntakeFee('AZ')).total
    const both = await ring(f, {
      items: [{ id: f.month, name: 'RV site — monthly', qty: 1, price: 440, tax: 0,
                stayUnitId: f.unitId, stayCheckIn: '2027-06-01' }],
      stay: { unitId: f.unitId, checkIn: '2027-06-01', guestName: 'Dale Carter',
              guestEmail: 'dale@t.dev', stayTerms: 'stay', screeningFee: fee },
    })
    expect(both.status).toBe(409)
    expect(both.body.error).toMatch(/already has a background check on it/)
    expect(await query('SELECT 1 FROM screening_prepayments')).toHaveLength(0)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('the register cannot write a background-check line itself — only the server puts one on a cart', async () => {
    const f = await seed()
    // Belt and braces under the 409 above: even a cart that hand-writes the
    // line is refused before any of this is reached, because a register may
    // not invent an item, let alone price a screening.
    const forged = await request(app()).post('/api/pos/transactions').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash',
              items: [{ id: null, name: 'Background check', qty: 1, price: 1, tax: 0, screening: true }] })
    expect(forged.status).toBe(400)
    expect(forged.body.error).toMatch(/Every register item is one you set up/)
    expect(await query('SELECT 1 FROM screening_prepayments')).toHaveLength(0)
  })

  it('is not put on a charge account — a check is not credit', async () => {
    const f = await seed()
    const res = await ring(f, { paymentMethod: 'charge' })
    expect(res.status).toBe(400)
    expect(await query('SELECT 1 FROM screening_prepayments')).toHaveLength(0)
  })

  it('a cart with nothing in it and no check is still nothing', async () => {
    const f = await seed()
    const res = await ring(f, { screening: {} })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await query('SELECT 1 FROM screening_prepayments')).toHaveLength(0)
  })
})

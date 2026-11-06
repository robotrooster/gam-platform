/**
 * 11/5 (Nic) — A COUNTER TAB NOBODY CAME BACK FOR.
 *
 *   "Hey, my card wasn't working when I went to buy some propane, and I'm
 *    going to come back with a new card," and they never do. That wasn't a
 *    lease or a stay."
 *
 * And, from 10/24, why the open list has never had a Discard:
 *
 *   "Anything that's a ticket is a outstanding balance that needs to be paid.
 *    If I send somebody a point of sale ticket and they never pay it, that's a
 *    left owing money situation. Those are not able to be discarded."
 *
 * So the desk says so, and nothing else does. The alternative — sweep any tab
 * open past N days — was weighed against the real list at Mountain View and
 * refused: September's electric on RV 30 IS a walk-away, but a ticket held for
 * a stay next January and two unpaid reservation deposits are not, and a
 * walk-away debt follows somebody to every other park on the platform. Those
 * two reservation shapes are refused here even when somebody presses it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { posRouter } from './pos'
import { leftOwingFlagFor } from '../services/leftOwing'

function app() {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  a.use('/api/pos', posRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_never_came_back'
})

async function seed(o: { phone?: string | null; email?: string | null } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const other = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const cat = (await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1,'Propane',1,TRUE) RETURNING id`, [landlordId])).rows[0].id
    const item = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'20 lb propane fill',$3,31.49,18,0,99,0,99) RETURNING id`,
      [landlordId, propertyId, cat])).rows[0].id
    const site = (await c.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount,
                          unit_type, nightly_rate, is_bookable)
       VALUES ($1,$2,'RV 30','vacant',500,'rv_spot',40,TRUE) RETURNING id`,
      [propertyId, landlordId])).rows[0].id
    // A register customer with no account — exactly who walks up to a counter.
    const customer = (await c.query(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone)
       VALUES ($1,'Dale','Wisener',$2,$3) RETURNING id`,
      [landlordId,
       o.email === undefined ? 'dale@t.dev' : o.email,
       o.phone === undefined ? '928-555-0144' : o.phone])).rows[0].id
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId,
        landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, otherLandlordId: other.landlordId, propertyId, item, site, customer,
             token, auth: { Authorization: `Bearer ${token}` } }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A tab held at the counter for somebody to come back and pay. */
async function tab(f: any, o: { bookingId?: string } = {}) {
  const r = await request(app()).post('/api/pos/tickets').set(f.auth).send({
    propertyId: f.propertyId, posCustomerId: f.customer,
    items: [{ id: f.item, name: '20 lb propane fill', qty: 1, price: 31.49 }],
    note: 'Card declined — coming back with another one',
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const id = r.body.data.id
  if (o.bookingId) await query(`UPDATE pos_open_tickets SET booking_id = $2 WHERE id = $1`, [id, o.bookingId])
  return id
}

const press = (f: any, id: string) =>
  request(app()).post(`/api/pos/tickets/${id}/never-came-back`).set(f.auth).send({})

const list = async (f: any) =>
  (await request(app()).get(`/api/pos/tickets?propertyId=${f.propertyId}`).set(f.auth)).body.data

const parts = async () => await query<any>(
  `SELECT p.kind, p.source_key, p.amount::float8 AS amount, p.voided_at
     FROM tenant_left_owing_parts p ORDER BY p.created_at`)

// ── THE PROPANE CASE ────────────────────────────────────────────────────────
describe('the desk says nobody came back for a tab', () => {
  it('records it, leaves the ticket owed, and another park is told', async () => {
    const f = await seed()
    const id = await tab(f)

    const r = await press(f, id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data).toMatchObject({ amount: 31.49, owedInAll: 31.49, who: 'Dale Wisener' })

    // ONE part, against the tab itself.
    expect(await parts()).toMatchObject([{ kind: 'counter', source_key: id, amount: 31.49, voided_at: null }])

    // THE TICKET IS NOT CLOSED. 10/24: "those are not able to be discarded" —
    // it is still money owed, so it stays on the list, now marked.
    const rows = await list(f)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, status: 'open' })
    expect(Number(rows[0].leftOwingAmount)).toBe(31.49)

    // And this is the whole point: another landlord screening them sees it.
    const flag = await leftOwingFlagFor({ name: 'Dale Wisener', phone: '9285550144' },
                                         [f.otherLandlordId])
    expect(flag.flagged).toBe(true)
  })

  it('restates rather than recording twice when it is pressed again', async () => {
    const f = await seed()
    const id = await tab(f)
    await press(f, id)
    const again = await press(f, id)
    expect(again.status).toBe(200)
    expect((await parts()).filter((p: any) => !p.voided_at)).toHaveLength(1)
    expect((await query<any>(`SELECT count(*)::int AS n FROM tenant_left_owing`))[0].n).toBe(1)
  })

  it('comes straight back off when they come back and pay it', async () => {
    const f = await seed()
    const id = await tab(f)
    await press(f, id)

    const sale = await request(app()).post('/api/pos/transactions').set(f.auth).send({
      propertyId: f.propertyId, paymentMethod: 'cash', openTicketId: id,
      items: [{ id: f.item, name: '20 lb propane fill', qty: 1, price: 31.49 }],
      cashReceived: 40,
    })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)

    // Paid, so the part is withdrawn and the flag stops. Somebody who paid
    // must not stay flagged at every other park on the platform.
    expect((await parts()).every((p: any) => p.voided_at)).toBe(true)
    const flag = await leftOwingFlagFor({ name: 'Dale Wisener', phone: '9285550144' },
                                         [f.otherLandlordId])
    expect(flag.flagged).toBe(false)
  })
})

// ── WHAT A TIMER WOULD HAVE GOT WRONG ───────────────────────────────────────
describe('money that belongs to a reservation', () => {
  /** A hold for a stay that has not happened yet — the William Smith case. */
  async function futureStay(f: any) {
    return (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out,
                                  total_amount, guest_name, guest_phone, status)
       VALUES ($1,$2,'nightly', CURRENT_DATE + 60, CURRENT_DATE + 65, 200,
               'William Smith','928-555-0199','confirmed') RETURNING id`,
      [f.site, f.landlordId]))[0].id
  }

  it('a tab held for a stay that has not finished is refused in words', async () => {
    const f = await seed()
    const id = await tab(f, { bookingId: await futureStay(f) })
    const r = await press(f, id)
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('reservation that has not finished')
    expect(r.body.error).toContain('cancel it on the schedule')
    // NOTHING was written. A timer would have flagged William Smith across the
    // whole platform for a stay he has not taken yet.
    expect(await parts()).toEqual([])
  })

  it('an unpaid reservation deposit link is refused too — a hold just lapses', async () => {
    const f = await seed()
    const bookingId = await futureStay(f)
    const link = (await query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label,
                                  items, subtotal, total, customer_name, customer_email,
                                  booking_id, status)
       SELECT 'tok_' || replace(gen_random_uuid()::text,'-',''), $1, $2, u.id, 'one_time',
              'Reservation deposit', '[]'::jsonb, 10.45, 10.45, 'Kevin Watson',
              'kevin@t.dev', $3, 'open'
         FROM users u JOIN landlords l ON l.user_id = u.id WHERE l.id = $1
        RETURNING id`, [f.landlordId, f.propertyId, bookingId]))[0].id

    const r = await press(f, link)
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('reservation that has not finished')
    expect(await parts()).toEqual([])
  })

  it('but a tab left behind by a stay that is OVER can be recorded', async () => {
    const f = await seed()
    const gone = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out,
                                  total_amount, guest_name, guest_phone, status)
       VALUES ($1,$2,'weekly', CURRENT_DATE - 20, CURRENT_DATE - 6, 700,
               'Dale Wisener','928-555-0144','checked_out') RETURNING id`,
      [f.site, f.landlordId]))[0].id
    const id = await tab(f, { bookingId: gone })
    const r = await press(f, id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.amount).toBe(31.49)
  })
})

// ── FOOLPROOF: IT SAYS WHAT IS MISSING ──────────────────────────────────────
describe('a tab with nobody to match', () => {
  it('is refused with the thing to go and add', async () => {
    // A name alone cannot be matched at another park, so the debt would flag
    // nobody and sit forever — worse than no debt at all.
    const f = await seed({ phone: null, email: null })
    const id = await tab(f)
    const r = await press(f, id)
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('no email or phone')
    expect(r.body.error).toContain('Add their phone number')
    expect(await parts()).toEqual([])
  })
})

/**
 * S652 — a sale written up where the goods are measured, settled where the
 * customer is.
 *
 * Nic, on propane delivered off the park: "we would need to somehow create the
 * tickets in the office because that's where the dispenser is pumping propane
 * and you have to reset the propane counter before you can pump the next
 * person. So we need a list of who the tank belongs to and how many gallons
 * went into it."
 *
 * And why it is not a pay link: "That's product actually out and payment needs
 * to be rendered right then instead of chasing somebody down later."
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

vi.mock('../services/posTax', async (orig) => {
  const actual: any = await orig()
  return {
    ...actual,
    calculateCartTax: async (_l: string, cart: any[]) => ({
      subtotal: cart.reduce((s, l) => s + l.qty * l.unitPrice, 0),
      taxAmount: 0,
      lines: cart.map((l) => ({ ...l, taxRate: 0, tax: 0 })),
    }),
  }
})

let posRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tickets'
  ;({ posRouter } = await import('./pos'))
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
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const cat = await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1,'Fuel',1,TRUE) RETURNING id`, [landlordId])
    const item = await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Propane (per gal)',$3,3.30,0,0,99999,0,99999) RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])
    const stayItem = await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — nightly',$3,0,0,0,999,0,999,'night') RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])
    const cust = await c.query(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email)
       VALUES ($1,'Ray','Delgado','ray@t.dev') RETURNING id`, [landlordId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, itemId: item.rows[0].id, stayItemId: stayItem.rows[0].id,
             customerId: cust.rows[0].id, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const writeTicket = (f: any, body: any = {}) =>
  request(buildApp()).post('/api/pos/tickets').set('Authorization', `Bearer ${f.token}`)
    .send({
      propertyId: f.propertyId, posCustomerId: f.customerId,
      items: [{ id: f.itemId, name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 }],
      note: 'Two 20lb tanks, left by the gate', ...body,
    })

describe('writing a ticket up at the pump', () => {
  it('records who the tank belongs to and how many gallons went in', async () => {
    const f = await seed()
    const res = await writeTicket(f)
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const [t] = await query<any>(`SELECT * FROM pos_open_tickets`)
    expect(t.status).toBe('open')
    expect(t.pos_customer_id).toBe(f.customerId)
    expect(Number(t.items[0].qty)).toBe(18.4)
    expect(t.note).toMatch(/two 20lb tanks/i)
  })

  it('holds no total, because the price is decided when it is rung', async () => {
    // Freezing a price at write-up would be a second pricing authority, which
    // is the exact thing this session spent its morning deleting.
    const f = await seed()
    await writeTicket(f)
    const cols = await query<any>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'pos_open_tickets'`)
    const names = cols.map((c: any) => c.column_name)
    expect(names).not.toContain('total')
    expect(names).not.toContain('tax_amount')
  })

  it('refuses a ticket for nobody', async () => {
    const f = await seed()
    const res = await writeTicket(f, { posCustomerId: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/one person/i)
  })

  it('refuses an item that is not on the register', async () => {
    const f = await seed()
    const res = await writeTicket(f, {
      items: [{ id: '00000000-0000-0000-0000-000000000000', qty: 1 }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not on your register/i)
  })

  it('refuses a stay, which needs a site and dates', async () => {
    const f = await seed()
    const res = await writeTicket(f, { items: [{ id: f.stayItemId, qty: 1 }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/site and dates/i)
  })

  it('cannot be written against another company\'s customer', async () => {
    const f = await seed()
    const other = await seed()
    const res = await writeTicket(f, { posCustomerId: other.customerId })
    expect(res.status).toBe(404)
  })
})

describe('settling it at the door', () => {
  const settle = (f: any, ticketId: string, body: any = {}) =>
    request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [{ id: f.itemId, name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 }],
        paymentMethod: 'cash', propertyId: f.propertyId, posCustomerId: f.customerId,
        openTicketId: ticketId, ...body,
      })

  it('closes the ticket and points the sale back at it', async () => {
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    const res = await settle(f, t.id)
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const [ticket] = await query<any>(`SELECT status, settled_transaction_id FROM pos_open_tickets`)
    expect(ticket.status).toBe('settled')
    expect(ticket.settled_transaction_id).toBe(res.body.data.id)
    const [tx] = await query<any>(`SELECT open_ticket_id FROM pos_transactions`)
    expect(tx.open_ticket_id).toBe(t.id)
  })

  it('the second driver to open the same ticket loses, rather than charging twice', async () => {
    // Two phones on one ticket is the ordinary case, not the exotic one.
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    expect((await settle(f, t.id)).status).toBe(201)
    const again = await settle(f, t.id)
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already been settled/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(1)
  })

  it('a voided ticket cannot be settled', async () => {
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    await request(buildApp()).post(`/api/pos/tickets/${t.id}/void`)
      .set('Authorization', `Bearer ${f.token}`).send({ reason: 'Tank came back' })
    const res = await settle(f, t.id)
    expect(res.status).toBe(409)
  })

  it('a voided ticket is kept, with its reason', async () => {
    // GAM does not erase records, and an abandoned ticket is part of the story
    // of a day's deliveries.
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    await request(buildApp()).post(`/api/pos/tickets/${t.id}/void`)
      .set('Authorization', `Bearer ${f.token}`).send({ reason: 'Tank came back' })
    const [row] = await query<any>(`SELECT status, void_reason FROM pos_open_tickets`)
    expect(row.status).toBe('voided')
    expect(row.void_reason).toBe('Tank came back')
  })

  it('the driver sees only what is still out, with a name on it', async () => {
    const f = await seed()
    const open = (await writeTicket(f)).body.data
    const done = (await writeTicket(f)).body.data
    await settle(f, done.id)

    const list = await request(buildApp())
      .get(`/api/pos/tickets?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].id).toBe(open.id)
    expect(list.body.data[0].customerName).toBe('Ray Delgado')
  })
})

/**
 * S652 — the register charges a card that is already on file.
 *
 * Nic: "maybe if they save a payment method on file as a point of sale
 * customer, we can just auto charge them on delivery and we don't even have to
 * take the reader with us."
 *
 * And, correcting me when I claimed tenants could not have one: "when somebody
 * is a tenant and they sign up, it is save and pay. The same button click does
 * both. So once they're already a tenant, the card is saved." He is right —
 * rent's own charge carries setup_future_usage (S603), so a tenant who has paid
 * once by card has a card on file as a by-product.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

const created: any[] = []
let cardOnCustomer: any = { id: 'pm_saved', type: 'card', card: { brand: 'visa', last4: '4242' } }
let chargeBehaviour: 'ok' | 'auth_required' | 'declined' = 'ok'

vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    customers:      { retrieve: async () => ({ id: 'cus_1', invoice_settings: {} }) },
    paymentMethods: {
      list:     async () => ({ data: cardOnCustomer ? [cardOnCustomer] : [] }),
      retrieve: async () => cardOnCustomer,
    },
    paymentIntents: {
      create: async (args: any) => {
        created.push(args)
        if (chargeBehaviour === 'auth_required') {
          const e: any = new Error('auth needed'); e.code = 'authentication_required'; throw e
        }
        if (chargeBehaviour === 'declined') {
          const e: any = new Error('Your card was declined'); e.code = 'card_declined'; throw e
        }
        return { id: 'pi_on_file', status: 'succeeded' }
      },
    },
  }),
}))
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
  created.length = 0
  cardOnCustomer = { id: 'pm_saved', type: 'card', card: { brand: 'visa', last4: '4242' } }
  chargeBehaviour = 'ok'
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_cof'
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
    // The property absorbs the card fee, so the totals in these tests are the
    // cart — what is under test is the CHARGE, not the fee split.
    await c.query(`UPDATE properties SET register_card_fee_payer = 'landlord' WHERE id = $1`, [propertyId])
    const cat = await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1,'Fuel',1,TRUE) RETURNING id`, [landlordId])
    const item = await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Propane',$3,20,0,0,999,0,999) RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])
    const cust = await c.query(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, stripe_customer_id)
       VALUES ($1,'Ray','Delgado','ray@t.dev','cus_1') RETURNING id`, [landlordId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, itemId: item.rows[0].id, customerId: cust.rows[0].id, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const sell = (f: any, body: any = {}) =>
  request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${f.token}`)
    .send({
      items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20, tax: 0 }],
      paymentMethod: 'card_on_file', propertyId: f.propertyId,
      posCustomerId: f.customerId, ...body,
    })

describe('charging the card already on file', () => {
  it('takes the money off-session and records the sale against that intent', async () => {
    const f = await seed()
    const res = await sell(f)
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    // off_session is the whole point: nobody is standing there to be challenged.
    expect(created[0].off_session).toBe(true)
    expect(created[0].payment_method).toBe('pm_saved')
    expect(created[0].amount).toBe(2000)

    const [tx] = await query<any>(
      `SELECT payment_method, stripe_payment_intent_id FROM pos_transactions`)
    expect(tx.payment_method).toBe('card_on_file')
    expect(tx.stripe_payment_intent_id).toBe('pi_on_file')
  })

  it('refuses when they have no card, and says what to do instead', async () => {
    // "Run it on the reader" is the useful answer: it saves the card in the
    // same motion, so the next sale can use this button.
    const f = await seed()
    cardOnCustomer = null
    const res = await sell(f)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/reader/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('records no sale when the bank wants the cardholder present', async () => {
    const f = await seed()
    chargeBehaviour = 'auth_required'
    const res = await sell(f)
    expect(res.status).toBe(402)
    expect(res.body.error).toMatch(/cardholder present|reader/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('records no sale on a decline', async () => {
    // A sale row for money that never arrived is worse than no row.
    const f = await seed()
    chargeBehaviour = 'declined'
    const res = await sell(f)
    expect(res.status).toBe(402)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('will not charge a card without being told whose it is', async () => {
    const f = await seed()
    const res = await sell(f, { posCustomerId: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/who this sale is for/i)
  })

  it('cannot reach another company\'s customer', async () => {
    const f = await seed()
    const other = await seed()
    const res = await sell(f, { posCustomerId: other.customerId })
    expect(res.status).toBe(404)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('the card fee is the same one every other card pays', async () => {
    // memory: gam-card-fee-every-card-payment — the counter terminal, the
    // register, pay links and this all pass the same fee.
    const f = await seed()
    await query(`UPDATE properties SET register_card_fee_payer = 'customer' WHERE id = $1`, [f.propertyId])
    const res = await sell(f)
    expect(res.status).toBe(201)
    // 3.5% + $0.55 on $20, passed to the customer.
    expect(Number(res.body.data.total)).toBeGreaterThan(20)
    expect(created[0].amount).toBe(Math.round(Number(res.body.data.total) * 100))
  })
})

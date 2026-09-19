/**
 * POS property-lock — the cashier scoping guard (assertPropertyInScope).
 *
 * A scoped worker (onsite_manager / future "cashier" preset) is hard-locked to
 * the property_ids on their scope row. They may ring a sale only on a property
 * in that set; any other property → 403. Owners (landlord) + all_properties
 * bypass. Also asserts the sale persists its property_id (the S… column add).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { posRouter } from './pos'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pos_scope'
})

interface Fixture {
  landlordId:   string
  ownerToken:   string   // role landlord — bypasses scope
  cashierToken: string   // onsite_manager scoped to property A only
  propAId:      string
  propBId:      string
}

async function seed(opts: { allProperties?: boolean } = {}): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: ownerUid, landlordId } = await seedLandlord(client)
    const propAId = await seedProperty(client, { landlordId, ownerUserId: ownerUid, managedByUserId: ownerUid })
    const propBId = await seedProperty(client, { landlordId, ownerUserId: ownerUid, managedByUserId: ownerUid })

    // A front-counter cashier: onsite_manager user scoped to property A only.
    const cashier = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Front', 'Counter', TRUE) RETURNING id`,
      [`cashier-${landlordId.slice(0, 8)}@test.dev`])
    await client.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3, $4)`,
      [cashier.rows[0].id, landlordId, opts.allProperties ? [] : [propAId], !!opts.allProperties])
    await client.query('COMMIT')

    // S633: a landlord session names no entity — the ACCOUNT's companies ride in
    // landlordIds. A TEAM session is genuinely scoped to one landlord and carries
    // it in the `landlordId` claim (S82), which is what auth.ts has minted for
    // worker roles all along; this fixture was still using the pre-S82 shape of
    // stuffing it into profileId, and only got away with it because the old scope
    // helper fell back to profileId — the same fallback that let a TENANT's
    // profileId read as a company.
    const ownerToken = jwt.sign(
      { userId: ownerUid, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const cashierToken = jwt.sign(
      { userId: cashier.rows[0].id, role: 'onsite_manager', email: 'c@t.dev', profileId: cashier.rows[0].id, landlordId, permissions: { 'pos.ring_sale': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, ownerToken, cashierToken, propAId, propBId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

// A minimal walk-up cash sale (no catalog id → server trusts the line).
const sale = (propertyId: string | null) => ({
  items: [{ id: null, name: 'Propane', qty: 1, price: 20, tax: 0, cat: 'misc' }],
  paymentMethod: 'cash',
  propertyId,
})

describe('POS property-lock (assertPropertyInScope)', () => {
  it('cashier can ring on their assigned property (A)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.cashierToken}`)
      .send(sale(f.propAId))
    expect(res.status).toBe(201)
    expect(res.body.data.property_id).toBe(f.propAId)   // sale persists its property
  })

  it('cashier is BLOCKED (403) on a property outside their scope (B)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.cashierToken}`)
      .send(sale(f.propBId))
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not assigned to this property/i)
  })

  it('cashier with no property selected → 400', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.cashierToken}`)
      .send(sale(null))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/property must be selected/i)
  })

  it('all_properties cashier can ring on any property (B)', async () => {
    const f = await seed({ allProperties: true })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.cashierToken}`)
      .send(sale(f.propBId))
    expect(res.status).toBe(201)
  })

  it('owner (landlord) bypasses scope — rings on any property', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(sale(f.propBId))
    expect(res.status).toBe(201)
    expect(res.body.data.property_id).toBe(f.propBId)
  })
})

// S650 (Nic): the front counter rings sales and sends pay links — it does not
// discount and it does not change prices. Prices arrive from the browser, so
// the server holds a cashier to the catalog.
describe('front-counter pricing lockdown', () => {
  async function catalogItem(f: Fixture, price: number): Promise<string> {
    const cat = await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, property_id) VALUES ($1, 'Stays', $2) RETURNING id`,
      [f.landlordId, f.propAId])
    const r = await db.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, name, sell_price, cost_price, tax_rate, stock_qty, property_id, category_id)
       VALUES ($1, 'RV site — daily', $2, 0, 0, 999, $3, $4) RETURNING id`, [f.landlordId, price, f.propAId, cat.rows[0].id])
    return r.rows[0].id
  }
  const ring = (f: Fixture, token: string, body: any) => request(buildApp())
    .post('/api/pos/transactions').set('Authorization', `Bearer ${token}`)
    .send({ paymentMethod: 'cash', propertyId: f.propAId, ...body })

  it('a cashier rings a catalog item at its own price', async () => {
    const f = await seed()
    const id = await catalogItem(f, 49)
    const res = await ring(f, f.cashierToken, { items: [{ id, name: 'RV site — daily', qty: 1, price: 49, tax: 0 }] })
    expect(res.status).toBe(201)
  })

  it('a cashier cannot ring it at a lower price', async () => {
    const f = await seed()
    const id = await catalogItem(f, 49)
    const res = await ring(f, f.cashierToken, { items: [{ id, name: 'RV site — daily', qty: 1, price: 10, tax: 0 }] })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/differs from the item's price/)
  })

  it('a cashier cannot apply a discount', async () => {
    const f = await seed()
    const id = await catalogItem(f, 49)
    const res = await ring(f, f.cashierToken, {
      items: [{ id, name: 'RV site — daily', qty: 1, price: 49, tax: 0 }], discountAmount: 5 })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Apply discounts/)
  })

  it('the owner can still change a price and discount', async () => {
    const f = await seed()
    const id = await catalogItem(f, 49)
    const res = await ring(f, f.ownerToken, {
      items: [{ id, name: 'RV site — daily', qty: 1, price: 40, tax: 0 }], discountAmount: 5 })
    expect(res.status).toBe(201)
  })
})

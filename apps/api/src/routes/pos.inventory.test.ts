/**
 * POS inventory CRUD slice — S347.
 *
 * Pins admin-side inventory management routes under pos.ts that the
 * S338+ test sweep didn't cover (those focused on the money path:
 * /transactions, /transactions/:id/refund, /eod/*, /sessions).
 *
 * Surfaces covered:
 *   - POST /items            (S227 categoryId required, S241 propertyId required, cross-landlord category guard)
 *   - POST /categories       (S227 duplicate-name 409)
 *   - DELETE /categories/:id (soft-delete via is_active=false)
 *   - POST /purchase-orders  (cross-landlord vendor 404)
 *   - PATCH /purchase-orders/:id status=received (restocks items + writes inventory_log)
 *   - POST /purchase-orders/:id/items (draft-only gate)
 *   - GET /inventory-log     (S347 fix: i.category column doesn't exist post-S227,
 *                             now JOINs pos_categories — test pins the JOIN)
 *
 * Lower-yield surfaces NOT covered (mechanical CRUD with the same
 * landlord-scoped WHERE pattern as the surfaces above; coverage gain
 * per test is small):
 *   - GET/POST/PATCH /vendors, /tax-rates, /discounts, /items/:id/variants
 *   - PATCH /items, POST /items/:id/adjust-stock
 *   - GET /low-stock, GET /items/:id/shelf-label
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pos_inv'
})

interface InvFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  categoryId:     string
  token:          string
}

async function seedInvFixture(): Promise<InvFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const cat = await client.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1, $2, 1, TRUE) RETURNING id`,
      [landlordId, `Cat-${randomUUID().slice(0, 6)}`])
    await client.query('COMMIT')
    const token = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, propertyId, categoryId: cat.rows[0].id, token }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedVendor(landlordId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_vendors (landlord_id, name)
     VALUES ($1, $2) RETURNING id`,
    [landlordId, `V-${randomUUID().slice(0, 6)}`])
  return r.rows[0].id
}

async function seedItem(f: InvFixture, opts: { stockQty?: number; stockMin?: number } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_items
       (landlord_id, property_id, category_id, name, sell_price,
        stock_qty, stock_min, stock_max)
     VALUES ($1, $2, $3, $4, 10, $5, $6, 50)
     RETURNING id`,
    [f.landlordId, f.propertyId, f.categoryId,
     `Item-${randomUUID().slice(0, 6)}`,
     opts.stockQty ?? 5, opts.stockMin ?? 2])
  return r.rows[0].id
}

describe('POST /api/pos/items', () => {
  it('happy path: creates item with categoryId + propertyId, returns 201', async () => {
    const f = await seedInvFixture()
    const res = await request(buildApp())
      .post('/api/pos/items')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        name:        'Test Widget',
        categoryId:  f.categoryId,
        propertyId:  f.propertyId,
        sellPrice:   12.50,
        costPrice:   5.00,
        taxRate:     0.08,
        stockQty:    25,
        stockMin:    5,
      })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Test Widget')
    expect(res.body.data.category_id).toBe(f.categoryId)
    expect(res.body.data.property_id).toBe(f.propertyId)
    expect(Number(res.body.data.sell_price)).toBe(12.50)
    // margin_pct derived: (12.50 - 5.00) / 12.50 * 100 = 60
    expect(Number(res.body.data.margin_pct)).toBe(60)
  })

  it('missing propertyId → 400 (S241: items are per-property)', async () => {
    const f = await seedInvFixture()
    const res = await request(buildApp())
      .post('/api/pos/items')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: 'No Prop', categoryId: f.categoryId, sellPrice: 5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/propertyId/)
  })

  it('cross-landlord categoryId → 400 (cross-tenant guard)', async () => {
    const a = await seedInvFixture()
    const b = await seedInvFixture()  // separate landlord
    const res = await request(buildApp())
      .post('/api/pos/items')
      .set('Authorization', `Bearer ${a.token}`)
      .send({
        name: 'Stolen Cat', categoryId: b.categoryId,  // b's category, a's token
        propertyId: a.propertyId, sellPrice: 5,
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/categoryId/)
  })
})

describe('POST /api/pos/categories', () => {
  it('duplicate name within same landlord → 409 (S227 collision handler)', async () => {
    const f = await seedInvFixture()
    const name = `Dup-${randomUUID().slice(0, 6)}`
    const first = await request(buildApp())
      .post('/api/pos/categories')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name, icon: '🔥', sortOrder: 5 })
    expect(first.status).toBe(201)
    const second = await request(buildApp())
      .post('/api/pos/categories')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name })
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/already exists/)
  })
})

describe('DELETE /api/pos/categories/:id', () => {
  it('soft-deletes via is_active=false (row preserved for FK integrity)', async () => {
    const f = await seedInvFixture()
    const res = await request(buildApp())
      .delete(`/api/pos/categories/${f.categoryId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const row = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM pos_categories WHERE id = $1`, [f.categoryId])
    expect(row.rows[0].is_active).toBe(false)
  })
})

describe('POST /api/pos/purchase-orders', () => {
  it('cross-landlord vendorId → 404 (vendor lookup is landlord-scoped)', async () => {
    const a = await seedInvFixture()
    const b = await seedInvFixture()
    const bVendorId = await seedVendor(b.landlordId)
    const res = await request(buildApp())
      .post('/api/pos/purchase-orders')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ vendorId: bVendorId, items: [] })  // b's vendor, a's token
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Vendor/i)
  })
})

describe('PATCH /api/pos/purchase-orders/:id — status=received', () => {
  it('restocks each line item + writes po_received inventory_log row', async () => {
    const f = await seedInvFixture()
    const vendorId = await seedVendor(f.landlordId)
    const itemId   = await seedItem(f, { stockQty: 10 })

    // Create draft PO with one item via the route, so the qty/cost flow
    // matches the production code path.
    const createRes = await request(buildApp())
      .post('/api/pos/purchase-orders')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        vendorId,
        items: [{ itemId, itemName: 'Restock Widget', qtyOrdered: 15, unitCost: 4 }],
      })
    expect(createRes.status).toBe(201)
    const poId = createRes.body.data.id

    const recvRes = await request(buildApp())
      .patch(`/api/pos/purchase-orders/${poId}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ status: 'received' })
    expect(recvRes.status).toBe(200)
    expect(recvRes.body.data.status).toBe('received')
    expect(recvRes.body.data.received_at).not.toBeNull()

    // Stock restocked: 10 + 15 = 25
    const stockRow = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM pos_items WHERE id = $1`, [itemId])
    expect(stockRow.rows[0].stock_qty).toBe(25)

    // Inventory log row with reason='po_received' and reference_id=poId
    const logRow = await db.query<{ change_qty: number; reason: string; reference_id: string; stock_before: number; stock_after: number }>(
      `SELECT change_qty, reason, reference_id, stock_before, stock_after
         FROM pos_inventory_log WHERE item_id = $1 AND reason = 'po_received'`,
      [itemId])
    expect(logRow.rows.length).toBe(1)
    expect(logRow.rows[0].change_qty).toBe(15)
    expect(logRow.rows[0].reference_id).toBe(poId)
    expect(logRow.rows[0].stock_before).toBe(10)
    expect(logRow.rows[0].stock_after).toBe(25)
  })
})

describe('POST /api/pos/purchase-orders/:id/items — draft-only gate', () => {
  it('adding to a non-draft PO → 400', async () => {
    const f = await seedInvFixture()
    const vendorId = await seedVendor(f.landlordId)
    const createRes = await request(buildApp())
      .post('/api/pos/purchase-orders')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ vendorId, items: [] })
    const poId = createRes.body.data.id

    // Flip to approved out-of-band so we can confirm the route blocks
    // adds against non-draft POs.
    await db.query(`UPDATE pos_purchase_orders SET status='approved' WHERE id=$1`, [poId])

    const addRes = await request(buildApp())
      .post(`/api/pos/purchase-orders/${poId}/items`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ itemName: 'Late Add', qtyOrdered: 1, unitCost: 1 })
    expect(addRes.status).toBe(400)
    expect(addRes.body.error).toMatch(/draft/i)
  })
})

describe('GET /api/pos/inventory-log', () => {
  // S347 fix: pre-S347 selected i.category (non-existent column post-S227)
  // and crashed at runtime. JOIN to pos_categories now surfaces the
  // category name; this test pins the working shape.
  it('returns landlord-scoped log rows with category name JOINed in', async () => {
    const f = await seedInvFixture()
    const itemId = await seedItem(f)
    // Seed a manual adjustment inventory_log row directly (the /items/:id
    // /adjust-stock route writes the same shape; we bypass to keep this
    // test scoped to the GET surface).
    await db.query(
      `INSERT INTO pos_inventory_log
         (item_id, landlord_id, change_qty, reason, stock_before, stock_after)
       VALUES ($1, $2, 5, 'adjustment', 5, 10)`,
      [itemId, f.landlordId])

    const res = await request(buildApp())
      .get('/api/pos/inventory-log')
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(1)
    const row = res.body.data[0]
    expect(row.item_id).toBe(itemId)
    expect(row.change_qty).toBe(5)
    expect(row.reason).toBe('adjustment')
    expect(row.item_name).toMatch(/^Item-/)
    // category column comes from the JOIN, not i.category (the S347 fix).
    // The seed sets pos_categories.name to a Cat-* uuid prefix.
    expect(row.category).toMatch(/^Cat-/)
  })

  it('landlord-scoped: another landlord\'s log rows are not returned', async () => {
    const a = await seedInvFixture()
    const b = await seedInvFixture()
    const bItem = await seedItem(b)
    await db.query(
      `INSERT INTO pos_inventory_log
         (item_id, landlord_id, change_qty, reason, stock_before, stock_after)
       VALUES ($1, $2, 1, 'adjustment', 0, 1)`,
      [bItem, b.landlordId])

    const res = await request(buildApp())
      .get('/api/pos/inventory-log')
      .set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(0)
  })
})

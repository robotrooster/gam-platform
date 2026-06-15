/**
 * S496 — business-portal inventory CRUD coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessInventoryRouter } from './businessInventory'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-inventory', businessInventoryRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s496'
})

interface Fixture {
  ownerToken: string
  businessId: string
}

async function seedFixture(opts: {
  inventoryEnabled?: boolean
} = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const features = opts.inventoryEnabled === false
    ? ['customers', 'staff']
    : ['customers', 'staff', 'inventory']
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Co', 'mini_market', $2, $3) RETURNING id`,
    [u.id, email, features])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email,
      profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id }
}

async function createCategory(token: string, name = 'Beverages') {
  const r = await request(buildApp())
    .post('/api/business-inventory/categories')
    .set('Authorization', `Bearer ${token}`)
    .send({ name })
  return r.body.data.id as string
}

async function createItem(token: string, body: Record<string, any> = {}) {
  const r = await request(buildApp())
    .post('/api/business-inventory/items')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Widget', sku: 'WDG-001',
      costPrice: 1.50, sellPrice: 4.99, taxRate: 0.0875,
      stockQty: 10, stockMin: 3, stockMax: 50,
      ...body,
    })
  return r
}

// ═══════════════════════════════════════════════════════════════
//  Feature gate
// ═══════════════════════════════════════════════════════════════

describe('Feature gate', () => {
  it('inventory off → all endpoints 403 with hint', async () => {
    const f = await seedFixture({ inventoryEnabled: false })
    const a = await request(buildApp())
      .get('/api/business-inventory/items')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(a.status).toBe(403)
    expect(a.body.error).toMatch(/Inventory is not enabled/i)

    const b = await request(buildApp())
      .post('/api/business-inventory/items')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ name: 'Widget' })
    expect(b.status).toBe(403)
  })

  it('non-owner role → 403', async () => {
    const hash = await bcrypt.hash('pw', 12)
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'tenant', 'T', 'T', TRUE) RETURNING id`,
      [`t-${randomUUID()}@test.dev`, hash])
    const token = jwt.sign(
      { userId: u.id, role: 'tenant', email: 't@t.dev' },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/business-inventory/items')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Categories
// ═══════════════════════════════════════════════════════════════

describe('Categories', () => {
  it('create + list + delete; deleting category SET NULLs items', async () => {
    const f = await seedFixture()
    const catId = await createCategory(f.ownerToken, 'Snacks')

    const list = await request(buildApp())
      .get('/api/business-inventory/categories')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data.length).toBe(1)
    expect(list.body.data[0].name).toBe('Snacks')

    const itm = await createItem(f.ownerToken, { categoryId: catId })
    expect(itm.body.data.category_id).toBe(catId)

    const del = await request(buildApp())
      .delete(`/api/business-inventory/categories/${catId}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(del.status).toBe(200)

    // Item still exists, category_id now null.
    const detail = await request(buildApp())
      .get(`/api/business-inventory/items/${itm.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.category_id).toBeNull()
  })

  it('duplicate category name within business → 500/4xx (unique constraint)', async () => {
    const f = await seedFixture()
    await createCategory(f.ownerToken, 'Snacks')
    const r = await request(buildApp())
      .post('/api/business-inventory/categories')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ name: 'Snacks' })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Items — create + list
// ═══════════════════════════════════════════════════════════════

describe('POST /items', () => {
  it('happy: creates item; initial stock writes a count audit row', async () => {
    const f = await seedFixture()
    const r = await createItem(f.ownerToken, { stockQty: 25 })
    expect(r.status).toBe(201)
    expect(r.body.data.stock_qty).toBe(25)

    const detail = await request(buildApp())
      .get(`/api/business-inventory/items/${r.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.adjustments.length).toBe(1)
    expect(detail.body.data.adjustments[0].adjustment_type).toBe('count')
    expect(detail.body.data.adjustments[0].quantity_delta).toBe(25)
    expect(detail.body.data.adjustments[0].stock_qty_after).toBe(25)
  })

  it('starting stock 0 → no audit row written', async () => {
    const f = await seedFixture()
    const r = await createItem(f.ownerToken, { stockQty: 0 })
    expect(r.status).toBe(201)
    const detail = await request(buildApp())
      .get(`/api/business-inventory/items/${r.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.adjustments.length).toBe(0)
  })

  it('cross-business category → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const otherCat = await createCategory(b.ownerToken, 'OtherCat')
    const r = await request(buildApp())
      .post('/api/business-inventory/items')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ name: 'Widget', categoryId: otherCat })
    expect(r.status).toBe(404)
  })

  it('duplicate sku within business rejected by unique constraint', async () => {
    const f = await seedFixture()
    await createItem(f.ownerToken, { sku: 'DUPLICATE-001' })
    const r = await createItem(f.ownerToken, {
      name: 'Other', sku: 'DUPLICATE-001',
    })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('tax_rate >= 1 rejected by CHECK (zod blocks first)', async () => {
    const f = await seedFixture()
    const r = await createItem(f.ownerToken, { taxRate: 1.5 })
    expect(r.status).toBe(400)
  })
})

describe('GET /items', () => {
  it('lists own items only; cross-business excluded', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await createItem(a.ownerToken, { name: 'A-Widget', sku: 'A1' })
    await createItem(b.ownerToken, { name: 'B-Widget', sku: 'B1' })

    const res = await request(buildApp())
      .get('/api/business-inventory/items')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].name).toBe('A-Widget')
  })

  it('lowStock filter only returns items at or below stock_min', async () => {
    const f = await seedFixture()
    await createItem(f.ownerToken, { name: 'Lo', sku: 'LO', stockQty: 2, stockMin: 5 })
    await createItem(f.ownerToken, { name: 'Hi', sku: 'HI', stockQty: 50, stockMin: 5 })
    await createItem(f.ownerToken, { name: 'NoMin', sku: 'NM', stockQty: 0, stockMin: 0 })

    const res = await request(buildApp())
      .get('/api/business-inventory/items?lowStock=true')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].name).toBe('Lo')
  })

  it('search q matches name OR sku, case-insensitive', async () => {
    const f = await seedFixture()
    await createItem(f.ownerToken, { name: 'Apple Juice', sku: 'APL-001' })
    await createItem(f.ownerToken, { name: 'Soda', sku: 'SDA-001' })

    const r1 = await request(buildApp())
      .get('/api/business-inventory/items?q=apple')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(r1.body.data.length).toBe(1)
    expect(r1.body.data[0].name).toBe('Apple Juice')

    const r2 = await request(buildApp())
      .get('/api/business-inventory/items?q=sda')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(r2.body.data.length).toBe(1)
    expect(r2.body.data[0].sku).toBe('SDA-001')
  })

  it('archived items excluded by default; includeArchived returns them', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken)
    await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${f.ownerToken}`)

    const def = await request(buildApp())
      .get('/api/business-inventory/items')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(def.body.data.length).toBe(0)

    const all = await request(buildApp())
      .get('/api/business-inventory/items?includeArchived=true')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(all.body.data.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Stock adjustments
// ═══════════════════════════════════════════════════════════════

describe('POST /items/:id/adjust', () => {
  it('received: positive delta increases stock + writes audit', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken, { stockQty: 10 })
    const r = await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/adjust`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ adjustmentType: 'received', quantityDelta: 7, notes: 'PO 123' })
    expect(r.status).toBe(200)
    expect(r.body.data.quantity_delta).toBe(7)
    expect(r.body.data.stock_qty_after).toBe(17)

    const detail = await request(buildApp())
      .get(`/api/business-inventory/items/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.stock_qty).toBe(17)
    expect(detail.body.data.adjustments.length).toBe(2)  // initial + received
  })

  it('sold: negative delta reduces stock', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken, { stockQty: 10 })
    const r = await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/adjust`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ adjustmentType: 'sold', quantityDelta: -3 })
    expect(r.status).toBe(200)
    expect(r.body.data.stock_qty_after).toBe(7)
  })

  it('count: absolute resultingQty sets stock; delta computed', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken, { stockQty: 10 })
    const r = await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/adjust`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ adjustmentType: 'count', resultingQty: 8, notes: 'physical count' })
    expect(r.status).toBe(200)
    expect(r.body.data.quantity_delta).toBe(-2)
    expect(r.body.data.stock_qty_after).toBe(8)
  })

  it('adjustment that would drop stock below zero → 400', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken, { stockQty: 3 })
    const r = await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/adjust`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ adjustmentType: 'sold', quantityDelta: -10 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/below 0/i)
  })

  it('count requires resultingQty', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken, { stockQty: 10 })
    const r = await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/adjust`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ adjustmentType: 'count' })
    expect(r.status).toBe(400)
  })

  it('non-count requires quantityDelta', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken, { stockQty: 10 })
    const r = await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/adjust`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ adjustmentType: 'received' })
    expect(r.status).toBe(400)
  })

  it('cross-business item → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const other = await createItem(b.ownerToken)
    const r = await request(buildApp())
      .post(`/api/business-inventory/items/${other.body.data.id}/adjust`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ adjustmentType: 'received', quantityDelta: 1 })
    expect(r.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  PATCH + archive
// ═══════════════════════════════════════════════════════════════

describe('PATCH /items/:id', () => {
  it('updates name + price; stock_qty NOT touched by PATCH', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken, { stockQty: 10 })
    const r = await request(buildApp())
      .patch(`/api/business-inventory/items/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ name: 'Renamed Widget', sellPrice: 9.99 })
    expect(r.status).toBe(200)
    expect(r.body.data.name).toBe('Renamed Widget')
    expect(Number(r.body.data.sell_price)).toBe(9.99)
    expect(r.body.data.stock_qty).toBe(10)
  })

  it('PATCH with stockQty in body → 400 (strict schema)', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken)
    const r = await request(buildApp())
      .patch(`/api/business-inventory/items/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ stockQty: 99 })
    expect(r.status).toBe(400)
  })

  it('cross-business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const other = await createItem(b.ownerToken)
    const r = await request(buildApp())
      .patch(`/api/business-inventory/items/${other.body.data.id}`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ name: 'X' })
    expect(r.status).toBe(404)
  })
})

describe('POST /items/:id/archive', () => {
  it('archives + sets is_active=false; archiving twice → 404', async () => {
    const f = await seedFixture()
    const c = await createItem(f.ownerToken)
    const r = await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(r.status).toBe(200)
    expect(r.body.data.is_active).toBe(false)

    const again = await request(buildApp())
      .post(`/api/business-inventory/items/${c.body.data.id}/archive`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(again.status).toBe(404)
  })
})

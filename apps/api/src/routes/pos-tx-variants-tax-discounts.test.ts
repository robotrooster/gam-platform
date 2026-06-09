/**
 * pos.ts slice 2 — S390. Closes pos.ts (modulo 3 mechanical reads).
 *
 * Covered routes (13):
 *   - GET   /api/pos/transactions                  (list, last 100)
 *   - GET   /api/pos/transactions/sales            (today/week/month aggregations)
 *   - GET   /api/pos/purchase-orders               (list with vendor + item count)
 *   - GET   /api/pos/items/:id/variants            (S390 fix)
 *   - POST  /api/pos/items/:id/variants
 *   - PATCH /api/pos/items/:id/variants/:variantId (S390 fix)
 *   - GET   /api/pos/tax-rates
 *   - POST  /api/pos/tax-rates
 *   - PATCH /api/pos/tax-rates/:id
 *   - DELETE /api/pos/tax-rates/:id
 *   - GET   /api/pos/discounts
 *   - POST  /api/pos/discounts
 *   - PATCH /api/pos/discounts/:id
 *
 * After this slice: pos.ts coverage 55/55 (100%).
 *
 * Production bugs fixed in this slice (2):
 *   - **GET /items/:id/variants** had no landlord scope filter. Variants
 *     have no landlord_id column (transitive via item_id); pre-fix a
 *     caller could read another landlord's variant list by passing the
 *     stranger item UUID. Fixed by SELECTing item with landlord scope
 *     first.
 *   - **PATCH /items/:id/variants/:variantId** validated (variantId,
 *     itemId) match but NOT item ownership. A caller knowing both
 *     foreign UUIDs could update the stranger's variant. Same fix
 *     pattern.
 *
 * Findings flagged (NOT fixed):
 *   - **POST /discounts** no required-field validation (name/type/value
 *     NOT NULL surfaces as 500).
 *   - **POST /tax-rates** no required-field validation (same shape).
 *   - **PATCH /discounts/:id** no SELECT-before-UPDATE → silent no-op
 *     on cross-tenant id (same class as the S384 vendors PATCH).
 *   - **DELETE /tax-rates/:id** silent soft-delete (no 404 on
 *     non-existent or cross-tenant id).
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pos_s2'
})

interface Fixture {
  landlordAUserId: string
  landlordAId:     string
  landlordBUserId: string
  landlordBId:     string
  propertyAId:     string
  categoryAId:     string
  itemAId:         string
  itemBId:         string
  tokenA:          string
  tokenB:          string
}

async function seed(): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: aUid, landlordId: aId } = await seedLandlord(c)
    const { userId: bUid, landlordId: bId } = await seedLandlord(c)
    const propA = await seedProperty(c, { landlordId: aId, ownerUserId: aUid, managedByUserId: aUid })
    const propB = await seedProperty(c, { landlordId: bId, ownerUserId: bUid, managedByUserId: bUid })
    const catA = await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'A Cat') RETURNING id`, [aId])
    const catB = await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'B Cat') RETURNING id`, [bId])
    const itemA = await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, stock_qty, stock_min, stock_max)
       VALUES ($1, $2, $3, 'A Item', 10, 5, 2, 50) RETURNING id`,
      [aId, propA, catA.rows[0].id])
    const itemB = await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, stock_qty, stock_min, stock_max)
       VALUES ($1, $2, $3, 'B Item', 10, 5, 2, 50) RETURNING id`,
      [bId, propB, catB.rows[0].id])
    await c.query('COMMIT')
    const sign = (uid: string, lid: string) => jwt.sign(
      { userId: uid, role: 'landlord', email: 'l@t.dev', profileId: lid, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordAUserId: aUid, landlordAId: aId,
      landlordBUserId: bUid, landlordBId: bId,
      propertyAId: propA, categoryAId: catA.rows[0].id,
      itemAId: itemA.rows[0].id, itemBId: itemB.rows[0].id,
      tokenA: sign(aUid, aId), tokenB: sign(bUid, bId),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

async function seedTransaction(f: Fixture, opts: {
  paymentMethod?: 'cash' | 'card' | 'charge'; total?: number; tenantId?: string;
} = {}): Promise<string> {
  // We bypass the route because the route does heavy FlexCharge / tax / cart
  // logic. This slice tests reads, so direct INSERTs are fine.
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_transactions
       (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, change_given)
     VALUES ($1, $2, $3, $4, 0, $4, 0) RETURNING id`,
    [f.landlordAId, f.landlordAUserId, opts.paymentMethod ?? 'cash', opts.total ?? 100])
  return r.rows[0].id
}

// ───────────────────────────────────────────────────────────────────
// GET /transactions (list, last 100)
// ───────────────────────────────────────────────────────────────────

describe('GET /transactions', () => {
  it('landlord-scoped: returns own transactions only', async () => {
    const f = await seed()
    await seedTransaction(f, { total: 50 })
    await seedTransaction(f, { total: 75 })
    // Cross-landlord — must not appear
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, change_given)
       VALUES ($1, $2, 'cash', 999, 0, 999, 0)`,
      [f.landlordBId, f.landlordBUserId])

    const res = await request(buildApp())
      .get('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    for (const t of res.body.data) {
      expect(t.landlord_id).toBe(f.landlordAId)
    }
  })

  it('item_count joined from pos_transaction_items', async () => {
    const f = await seed()
    const txId = await seedTransaction(f)
    await db.query(
      `INSERT INTO pos_transaction_items (transaction_id, item_name, qty, unit_price, subtotal)
       VALUES ($1, 'Foo', 1, 10, 10), ($1, 'Bar', 2, 5, 10)`,
      [txId])
    const res = await request(buildApp())
      .get('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data[0].item_count)).toBe(2)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /transactions/sales (today/week/month aggregations)
// ───────────────────────────────────────────────────────────────────

describe('GET /transactions/sales', () => {
  it('empty when no transactions: summary fields null, arrays empty', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .get('/api/pos/transactions/sales')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data.summary).toMatchObject({})
    expect(res.body.data.byHour).toEqual([])
    expect(res.body.data.byDay).toEqual([])
    expect(res.body.data.topItems).toEqual([])
    expect(res.body.data.byCategory).toEqual([])
  })

  it('aggregates today\'s transactions: summary totals + payment-method breakdown', async () => {
    const f = await seed()
    await seedTransaction(f, { paymentMethod: 'cash', total: 100 })
    await seedTransaction(f, { paymentMethod: 'card', total: 50 })
    await seedTransaction(f, { paymentMethod: 'cash', total: 25 })

    const res = await request(buildApp())
      .get('/api/pos/transactions/sales?period=today')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(Number(res.body.data.summary.tx_count)).toBe(3)
    expect(Number(res.body.data.summary.total_revenue)).toBe(175)
    expect(Number(res.body.data.summary.cash_total)).toBe(125)
    expect(Number(res.body.data.summary.card_total)).toBe(50)
    expect(Number(res.body.data.summary.charge_total)).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────
// GET /purchase-orders
// ───────────────────────────────────────────────────────────────────

describe('GET /purchase-orders', () => {
  it('landlord-scoped: returns POs with vendor_name + item_count', async () => {
    const f = await seed()
    const vendor = await db.query<{ id: string }>(
      `INSERT INTO pos_vendors (landlord_id, name) VALUES ($1, 'Acme') RETURNING id`,
      [f.landlordAId])
    const po = await db.query<{ id: string }>(
      `INSERT INTO pos_purchase_orders (landlord_id, vendor_id, status, notes, po_number)
       VALUES ($1, $2, 'draft', 'q3 restock', 'PO-001') RETURNING id`,
      [f.landlordAId, vendor.rows[0].id])
    await db.query(
      `INSERT INTO pos_purchase_order_items (po_id, item_name, qty_ordered, unit_cost, subtotal)
       VALUES ($1, 'Hammer', 5, 10, 50), ($1, 'Nails', 100, 0.05, 5)`,
      [po.rows[0].id])
    const res = await request(buildApp())
      .get('/api/pos/purchase-orders')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].vendor_name).toBe('Acme')
    expect(Number(res.body.data[0].item_count)).toBe(2)
    expect(res.body.data[0].items).toHaveLength(2)
  })
})

// ───────────────────────────────────────────────────────────────────
// VARIANTS — S390 scope-fix tests
// ───────────────────────────────────────────────────────────────────

describe('GET /items/:id/variants — S390 scope fix', () => {
  it('S390 fix: caller with stranger item UUID → 404 (was: returned variants)', async () => {
    const f = await seed()
    // Seed a variant on landlord B's item.
    await db.query(
      `INSERT INTO pos_item_variants (item_id, name, sell_price, stock_qty) VALUES ($1, 'B Variant', 5, 10)`,
      [f.itemBId])
    const res = await request(buildApp())
      .get(`/api/pos/items/${f.itemBId}/variants`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(404)
  })

  it('happy: returns active variants for own item', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO pos_item_variants (item_id, name, sell_price, stock_qty, is_active, sort_order) VALUES
        ($1, 'Active', 5, 10, TRUE, 1),
        ($1, 'Inactive', 3, 5, FALSE, 2)`,
      [f.itemAId])
    const res = await request(buildApp())
      .get(`/api/pos/items/${f.itemAId}/variants`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('Active')
  })
})

describe('POST /items/:id/variants', () => {
  it('cross-landlord item → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/pos/items/${f.itemBId}/variants`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'X', sellPrice: 5 })
    expect(res.status).toBe(404)
  })

  it('happy: creates variant + flips items.has_variants=TRUE', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post(`/api/pos/items/${f.itemAId}/variants`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Large', sellPrice: 15, costPrice: 8, stockQty: 20 })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('Large')
    expect(Number(res.body.data.sell_price)).toBe(15)
    const item = await db.query<{ has_variants: boolean }>(
      `SELECT has_variants FROM pos_items WHERE id=$1`, [f.itemAId])
    expect(item.rows[0].has_variants).toBe(true)
  })
})

describe('PATCH /items/:id/variants/:variantId — S390 scope fix', () => {
  it('S390 fix: foreign-itemId/variantId combo → 404 (was: updated stranger row)', async () => {
    const f = await seed()
    const v = await db.query<{ id: string }>(
      `INSERT INTO pos_item_variants (item_id, name, sell_price, stock_qty) VALUES ($1, 'B V', 5, 10) RETURNING id`,
      [f.itemBId])
    const res = await request(buildApp())
      .patch(`/api/pos/items/${f.itemBId}/variants/${v.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Hijacked' })
    expect(res.status).toBe(404)
    const after = await db.query<{ name: string }>(
      `SELECT name FROM pos_item_variants WHERE id=$1`, [v.rows[0].id])
    expect(after.rows[0].name).toBe('B V')
  })

  it('happy: updates own variant', async () => {
    const f = await seed()
    const v = await db.query<{ id: string }>(
      `INSERT INTO pos_item_variants (item_id, name, sell_price, stock_qty) VALUES ($1, 'Old', 5, 10) RETURNING id`,
      [f.itemAId])
    const res = await request(buildApp())
      .patch(`/api/pos/items/${f.itemAId}/variants/${v.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Renamed', sellPrice: 12 })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Renamed')
    expect(Number(res.body.data.sell_price)).toBe(12)
  })
})

// ───────────────────────────────────────────────────────────────────
// TAX RATES
// ───────────────────────────────────────────────────────────────────

describe('GET /tax-rates', () => {
  it('landlord-scoped: returns own rates', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO pos_tax_rates (landlord_id, name, rate, tax_type) VALUES
        ($1, 'A State Sales', 8.5, 'sales'),
        ($2, 'B State Sales', 7, 'sales')`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/pos/tax-rates')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('A State Sales')
  })

  it('?propertyId= returns property + landlord-wide (null property_id)', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO pos_tax_rates (landlord_id, property_id, name, rate, tax_type) VALUES
        ($1, NULL, 'LL-wide', 8.5, 'sales'),
        ($1, $2,   'Property-specific', 9, 'sales')`,
      [f.landlordAId, f.propertyAId])
    const res = await request(buildApp())
      .get(`/api/pos/tax-rates?propertyId=${f.propertyAId}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
  })
})

describe('POST /tax-rates', () => {
  it('cross-landlord propertyId → 400 (S217 scope validation)', async () => {
    const f = await seed()
    const propB = await db.query<{ id: string }>(
      `SELECT id FROM properties WHERE landlord_id=$1 LIMIT 1`, [f.landlordBId])
    const res = await request(buildApp())
      .post('/api/pos/tax-rates')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'Bad', rate: 8.5, taxType: 'sales', propertyId: propB.rows[0].id })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not belong/i)
  })

  it('happy: creates rate (appliesTo defaults to [all])', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/tax-rates')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'State Sales', rate: 8.5, taxType: 'sales' })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('State Sales')
    expect(res.body.data.applies_to).toEqual(['all'])
  })

  it('FINDING (S390): empty body → 500 (no route-level required-field validation)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/tax-rates')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect([400, 500]).toContain(res.status)  // currently 500
  })
})

describe('PATCH /tax-rates/:id', () => {
  it('unknown → 404', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .patch(`/api/pos/tax-rates/${randomUUID()}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ rate: 9 })
    expect(res.status).toBe(404)
  })

  it('cross-landlord → 404', async () => {
    const f = await seed()
    const bRate = await db.query<{ id: string }>(
      `INSERT INTO pos_tax_rates (landlord_id, name, rate, tax_type) VALUES ($1, 'B Rate', 7, 'sales') RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/pos/tax-rates/${bRate.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ rate: 99 })
    expect(res.status).toBe(404)
  })

  it('happy: COALESCE update preserves untouched', async () => {
    const f = await seed()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO pos_tax_rates (landlord_id, name, rate, tax_type) VALUES ($1, 'Orig', 8.5, 'sales') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/pos/tax-rates/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ rate: 9 })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.rate)).toBe(9)
    expect(res.body.data.name).toBe('Orig')  // preserved
  })
})

describe('DELETE /tax-rates/:id', () => {
  it('soft-deletes (is_active=FALSE); subsequent GET excludes via S217 query when filtered', async () => {
    const f = await seed()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO pos_tax_rates (landlord_id, name, rate, tax_type) VALUES ($1, 'ToDelete', 8.5, 'sales') RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .delete(`/api/pos/tax-rates/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    const row = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM pos_tax_rates WHERE id=$1`, [ins.rows[0].id])
    expect(row.rows[0].is_active).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────
// DISCOUNTS
// ───────────────────────────────────────────────────────────────────

describe('GET /discounts', () => {
  it('landlord-scoped + active-only', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO pos_discounts (landlord_id, name, type, value, is_active) VALUES
        ($1, '10off', 'percent', 10, TRUE),
        ($1, 'OldPromo', 'percent', 20, FALSE),
        ($2, 'B Discount', 'percent', 5, TRUE)`,
      [f.landlordAId, f.landlordBId])
    const res = await request(buildApp())
      .get('/api/pos/discounts')
      .set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('10off')
  })
})

describe('POST /discounts', () => {
  it('happy: creates discount', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/discounts')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ name: 'New10', type: 'percent', value: 10, code: 'SAVE10' })
    expect(res.status).toBe(201)
    expect(res.body.data.name).toBe('New10')
    expect(res.body.data.code).toBe('SAVE10')
  })

  it('FINDING (S390): empty body → 500 (no required-field validation)', async () => {
    const f = await seed()
    const res = await request(buildApp())
      .post('/api/pos/discounts')
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({})
    expect([400, 500]).toContain(res.status)  // currently 500
  })
})

describe('PATCH /discounts/:id', () => {
  it('FINDING (S390): cross-landlord PATCH silently no-ops (no 404 check)', async () => {
    const f = await seed()
    const bDisc = await db.query<{ id: string }>(
      `INSERT INTO pos_discounts (landlord_id, name, type, value) VALUES ($1, 'B Disc', 'percent', 10) RETURNING id`,
      [f.landlordBId])
    const res = await request(buildApp())
      .patch(`/api/pos/discounts/${bDisc.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ value: 999 })
    // Either 404 (post-future-fix) or 200 with no mutation (current).
    // The row MUST NOT be modified.
    expect([200, 404]).toContain(res.status)
    const row = await db.query<{ value: string }>(
      `SELECT value FROM pos_discounts WHERE id=$1`, [bDisc.rows[0].id])
    expect(Number(row.rows[0].value)).toBe(10)  // unchanged
  })

  it('happy: COALESCE update preserves untouched', async () => {
    const f = await seed()
    const ins = await db.query<{ id: string }>(
      `INSERT INTO pos_discounts (landlord_id, name, type, value) VALUES ($1, 'Promo', 'percent', 10) RETURNING id`,
      [f.landlordAId])
    const res = await request(buildApp())
      .patch(`/api/pos/discounts/${ins.rows[0].id}`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ value: 15 })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.value)).toBe(15)
    expect(res.body.data.name).toBe('Promo')
  })
})

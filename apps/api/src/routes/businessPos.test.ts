/**
 * S497 — business-portal POS register coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessPosRouter } from './businessPos'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-pos', businessPosRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s497'
})

interface Fixture {
  ownerToken: string
  businessId: string
  itemA: string
  itemB: string
  customerId: string
}

async function seedFixture(opts: {
  posEnabled?: boolean
  inventoryEnabled?: boolean
  itemAStock?: number
  itemBStock?: number
  itemAPrice?: number
  itemBPrice?: number
  itemATax?: number
} = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const features = ['customers', 'staff']
  if (opts.posEnabled !== false)       features.push('pos')
  if (opts.inventoryEnabled !== false) features.push('inventory')
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Co', 'mini_market', $2, $3) RETURNING id`,
    [u.id, email, features])
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO business_inventory_items
       (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty)
     VALUES ($1, 'Apple', 'APL', 0.50, $2, $3, $4) RETURNING id`,
    [b.id, opts.itemAPrice ?? 1.00, opts.itemATax ?? 0.0875, opts.itemAStock ?? 10])
  const { rows: [bb] } = await db.query<{ id: string }>(
    `INSERT INTO business_inventory_items
       (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty)
     VALUES ($1, 'Soda', 'SDA', 0.75, $2, 0.0875, $3) RETURNING id`,
    [b.id, opts.itemBPrice ?? 2.50, opts.itemBStock ?? 5])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe', '100 Elm', 'Phoenix', 'AZ', '85001')
     RETURNING id`, [b.id])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email,
      profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id, itemA: a.id, itemB: bb.id, customerId: c.id }
}

// ═══════════════════════════════════════════════════════════════
//  Feature gate
// ═══════════════════════════════════════════════════════════════

describe('Feature gate', () => {
  it('pos off → 403 with hint', async () => {
    const f = await seedFixture({ posEnabled: false })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'cash', amountTendered: 5,
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/POS is not enabled/i)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /transactions
// ═══════════════════════════════════════════════════════════════

describe('POST /transactions', () => {
  it('cash sale: computes totals, decrements stock, returns receipt + change', async () => {
    const f = await seedFixture({ itemAPrice: 1.00, itemATax: 0.10 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'cash',
        amountTendered: 5.00,
        lines: [{ itemId: f.itemA, quantity: 3 }],  // 3 * 1.00 + 10% tax = 3.30
      })
    expect(res.status).toBe(201)
    expect(res.body.data.receipt_number).toBe('TXN-000001')
    expect(Number(res.body.data.subtotal)).toBeCloseTo(3.00)
    expect(Number(res.body.data.tax_amount)).toBeCloseTo(0.30)
    expect(Number(res.body.data.total_amount)).toBeCloseTo(3.30)
    expect(Number(res.body.data.change_due)).toBeCloseTo(1.70)
    expect(res.body.data.lines.length).toBe(1)
    expect(res.body.data.lines[0].name_snapshot).toBe('Apple')

    // Stock decremented from 10 → 7
    const { rows: [it] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`,
      [f.itemA])
    expect(it.stock_qty).toBe(7)

    // Audit row written
    const { rows: adj } = await db.query<{
      adjustment_type: string; quantity_delta: number; reference_type: string;
    }>(
      `SELECT adjustment_type, quantity_delta, reference_type
         FROM business_inventory_adjustments
        WHERE item_id = $1 AND adjustment_type = 'sold'`,
      [f.itemA])
    expect(adj.length).toBe(1)
    expect(adj[0]!.quantity_delta).toBe(-3)
    expect(adj[0]!.reference_type).toBe('pos_transaction')
  })

  it('card_recorded: no tendered required; change_due null', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.payment_method).toBe('card_recorded')
    expect(res.body.data.change_due).toBeNull()
    expect(res.body.data.amount_tendered).toBeNull()
  })

  it('multi-line: totals across two items', async () => {
    const f = await seedFixture({ itemAPrice: 1.00, itemATax: 0, itemBPrice: 2.50 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        lines: [
          { itemId: f.itemA, quantity: 2 },  // 2.00
          { itemId: f.itemB, quantity: 1 },  // 2.50 + 0.21875 ≈ 2.72
        ],
      })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.subtotal)).toBeCloseTo(4.50)
    expect(res.body.data.lines.length).toBe(2)
  })

  it('insufficient stock → 400 with item name', async () => {
    const f = await seedFixture({ itemAStock: 2 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        lines: [{ itemId: f.itemA, quantity: 5 }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Not enough stock/i)
    expect(res.body.error).toMatch(/Apple/)

    // Stock unchanged
    const { rows: [it] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`,
      [f.itemA])
    expect(it.stock_qty).toBe(2)
  })

  it('rollback: if one line fails, stock on the other line is NOT decremented', async () => {
    const f = await seedFixture({ itemAStock: 100, itemBStock: 1 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        lines: [
          { itemId: f.itemA, quantity: 5 },   // ok
          { itemId: f.itemB, quantity: 99 },  // fails
        ],
      })
    expect(res.status).toBe(400)
    const { rows: [a] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`,
      [f.itemA])
    expect(a.stock_qty).toBe(100)  // unchanged
    // No transaction row written
    const { rows: txns } = await db.query(
      `SELECT id FROM business_pos_transactions WHERE business_id = $1`,
      [f.businessId])
    expect(txns.length).toBe(0)
  })

  it('cash sale: tendered less than total → 400', async () => {
    const f = await seedFixture({ itemAPrice: 5.00, itemATax: 0 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'cash',
        amountTendered: 4.00,
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/less than total/i)
  })

  it('cash sale without amountTendered → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'cash',
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/amountTendered required/i)
  })

  it('cross-business item → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        lines: [{ itemId: b.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(404)
  })

  it('cross-business customer → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        customerId: b.customerId,
        lines: [{ itemId: a.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(404)
  })

  it('archived item rejected', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE business_inventory_items SET is_active = FALSE WHERE id = $1`,
      [f.itemA])
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/archived/i)
  })

  it('sequential receipt numbers per business', async () => {
    const f = await seedFixture()
    const r1 = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    const r2 = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    expect(r1.body.data.receipt_number).toBe('TXN-000001')
    expect(r2.body.data.receipt_number).toBe('TXN-000002')
  })

  it('zero lines → 400 (zod min(1))', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', lines: [] })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S506 — POS honors customer tax exemption
// ═══════════════════════════════════════════════════════════════

describe('Tax exemption (S506)', () => {
  it('tax-exempt customer → line_tax = 0 even though item has tax_rate', async () => {
    const f = await seedFixture({ itemATax: 0.10, itemAPrice: 100 })
    await db.query(
      `UPDATE business_customers SET tax_exempt = TRUE WHERE id = $1`,
      [f.customerId])
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        customerId: f.customerId,
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.tax_amount)).toBe(0)
    expect(Number(res.body.data.total_amount)).toBe(100)
  })

  it('non-exempt customer → tax applies as normal', async () => {
    const f = await seedFixture({ itemATax: 0.10, itemAPrice: 100 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        customerId: f.customerId,
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(Number(res.body.data.tax_amount)).toBeCloseTo(10)
  })

  it('walk-in (no customer) → tax applies as normal', async () => {
    const f = await seedFixture({ itemATax: 0.10, itemAPrice: 100 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(Number(res.body.data.tax_amount)).toBeCloseTo(10)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S512 — POS tips
// ═══════════════════════════════════════════════════════════════

describe('Tips (S512)', () => {
  it('card sale with tip: tip stored separately, total_amount stays sale-only', async () => {
    const f = await seedFixture({ itemAPrice: 10.00, itemATax: 0 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        tipAmount: 2.50,
        lines: [{ itemId: f.itemA, quantity: 1 }],  // sale = 10.00
      })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.subtotal)).toBeCloseTo(10.00)
    expect(Number(res.body.data.tip_amount)).toBeCloseTo(2.50)
    // total_amount is the SALE only — tip is not folded in.
    expect(Number(res.body.data.total_amount)).toBeCloseTo(10.00)
  })

  it('cash sale with tip: change computed against grand total (sale + tip)', async () => {
    const f = await seedFixture({ itemAPrice: 10.00, itemATax: 0 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'cash',
        tipAmount: 3.00,
        amountTendered: 20.00,   // grand total = 13.00 → change 7.00
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.tip_amount)).toBeCloseTo(3.00)
    expect(Number(res.body.data.change_due)).toBeCloseTo(7.00)
  })

  it('cash sale: tendered covers sale but not the tip → 400', async () => {
    const f = await seedFixture({ itemAPrice: 10.00, itemATax: 0 })
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'cash',
        tipAmount: 5.00,
        amountTendered: 12.00,   // covers 10 sale but not 15 grand total
        lines: [{ itemId: f.itemA, quantity: 1 }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/less than total/i)
  })

  it('no tip → tip_amount defaults to 0', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.tip_amount)).toBe(0)
  })

  it('negative tip rejected by zod', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', tipAmount: -1,
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S513 — POS discount codes
// ═══════════════════════════════════════════════════════════════

describe('Discounts (S513)', () => {
  async function makeCode(businessId: string, type: 'percent' | 'fixed', value: number,
    opts: { code?: string; max?: number | null } = {}) {
    const { rows: [r] } = await db.query<{ id: string; code: string; redemption_count: number }>(
      `INSERT INTO business_discount_codes
         (business_id, code, discount_type, discount_value, max_redemptions)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [businessId, opts.code ?? 'SAVE', type, value, opts.max ?? null])
    return r
  }

  it('percent discount: reduces total, scales tax, consumes a redemption', async () => {
    const f = await seedFixture({ itemAPrice: 10.00, itemATax: 0.10 })  // sub 10, tax 1
    const code = await makeCode(f.businessId, 'percent', 20)            // 20% off
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', discountCode: 'save',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.subtotal)).toBeCloseTo(10.00)       // full price
    expect(Number(res.body.data.discount_amount)).toBeCloseTo(2.00) // 20% of 10
    expect(Number(res.body.data.tax_amount)).toBeCloseTo(0.80)      // 1.00 * (8/10)
    expect(Number(res.body.data.total_amount)).toBeCloseTo(8.80)    // 8 + 0.80

    const { rows: [after] } = await db.query<{ redemption_count: number }>(
      `SELECT redemption_count FROM business_discount_codes WHERE id = $1`, [code.id])
    expect(after.redemption_count).toBe(1)
  })

  it('fixed discount clamps to subtotal', async () => {
    const f = await seedFixture({ itemAPrice: 10.00, itemATax: 0 })
    await makeCode(f.businessId, 'fixed', 100, { code: 'BIG' })  // more than the sale
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', discountCode: 'BIG',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.discount_amount)).toBeCloseTo(10.00)
    expect(Number(res.body.data.total_amount)).toBeCloseTo(0)
  })

  it('unknown code → 404 and no sale row written', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', discountCode: 'NOPE',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    expect(res.status).toBe(404)
    const { rows } = await db.query(
      `SELECT id FROM business_pos_transactions WHERE business_id = $1`, [f.businessId])
    expect(rows.length).toBe(0)
  })

  it('redemption cap blocks the sale → 409', async () => {
    const f = await seedFixture()
    const code = await makeCode(f.businessId, 'fixed', 1, { code: 'ONCE', max: 1 })
    await db.query(`UPDATE business_discount_codes SET redemption_count = 1 WHERE id = $1`, [code.id])
    const res = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', discountCode: 'ONCE',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    expect(res.status).toBe(409)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /transactions
// ═══════════════════════════════════════════════════════════════

describe('GET /transactions', () => {
  it('lists own sales newest-first; customer name joined', async () => {
    const f = await seedFixture()
    await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              customerId: f.customerId,
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    const res = await request(buildApp())
      .get('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    expect(res.body.data[0].receipt_number).toBe('TXN-000002')
    expect(res.body.data[1].customer_first_name).toBe('Jane')
  })

  it('cross-business excluded', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: a.itemA, quantity: 1 }] })
    await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: b.itemA, quantity: 1 }] })
    const res = await request(buildApp())
      .get('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.body.data.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POST /:id/refund
// ═══════════════════════════════════════════════════════════════

describe('POST /:id/refund', () => {
  it('restores stock + flips status', async () => {
    const f = await seedFixture({ itemAStock: 10 })
    const sale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: f.itemA, quantity: 4 }] })
    // After sale: stock 6
    const { rows: [mid] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`,
      [f.itemA])
    expect(mid.stock_qty).toBe(6)

    const res = await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'Customer returned the box' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('refunded')
    expect(res.body.data.refund_reason).toBe('Customer returned the box')

    // Stock back to 10
    const { rows: [after] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`,
      [f.itemA])
    expect(after.stock_qty).toBe(10)

    // 'received' audit row written for the refund
    const { rows: rec } = await db.query(
      `SELECT * FROM business_inventory_adjustments
        WHERE item_id = $1 AND adjustment_type = 'received'`,
      [f.itemA])
    expect(rec.length).toBe(1)
  })

  it('partial line refund → partially_refunded, restores only that qty', async () => {
    const f = await seedFixture({ itemAStock: 10, itemAPrice: 10, itemATax: 0 })
    const sale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: f.itemA, quantity: 4 }] })  // stock 10→6, total 40
    const lineId = sale.body.data.lines[0].id
    const res = await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'returned 1', lines: [{ lineId, quantity: 1 }] })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('partially_refunded')
    expect(Number(res.body.data.refunded_amount)).toBeCloseTo(10)   // 1 of 4 @ $40 total
    expect(res.body.data.lines[0].refunded_qty).toBe(1)

    const { rows: [after] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`, [f.itemA])
    expect(after.stock_qty).toBe(7)  // 6 + 1 back
  })

  it('refunding the remaining qty flips it to refunded', async () => {
    const f = await seedFixture({ itemAStock: 10, itemAPrice: 10, itemATax: 0 })
    const sale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', lines: [{ itemId: f.itemA, quantity: 4 }] })
    const lineId = sale.body.data.lines[0].id
    await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'r1', lines: [{ lineId, quantity: 1 }] })
    const res = await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'r2', lines: [{ lineId, quantity: 3 }] })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('refunded')
    expect(Number(res.body.data.refunded_amount)).toBeCloseTo(40)
  })

  it('refunding more than remains → 400', async () => {
    const f = await seedFixture({ itemAPrice: 10, itemATax: 0 })
    const sale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', lines: [{ itemId: f.itemA, quantity: 2 }] })
    const lineId = sale.body.data.lines[0].id
    const res = await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'too much', lines: [{ lineId, quantity: 5 }] })
    expect(res.status).toBe(400)
  })

  it('discounted sale: full refund returns the discounted total, not list price', async () => {
    const f = await seedFixture({ itemAPrice: 10, itemATax: 0 })
    await db.query(
      `INSERT INTO business_discount_codes (business_id, code, discount_type, discount_value)
       VALUES ($1, 'HALF', 'percent', 50)`, [f.businessId])
    const sale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded', discountCode: 'HALF',
              lines: [{ itemId: f.itemA, quantity: 2 }] })  // list 20, discounted total 10
    expect(Number(sale.body.data.total_amount)).toBeCloseTo(10)
    const res = await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'full' })
    expect(res.body.data.status).toBe('refunded')
    expect(Number(res.body.data.refunded_amount)).toBeCloseTo(10)  // discounted, not 20
  })

  it('cannot double-refund', async () => {
    const f = await seedFixture()
    const sale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'first' })
    const second = await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'second' })
    expect(second.status).toBe(409)
  })

  it('reason required → 400 without it', async () => {
    const f = await seedFixture()
    const sale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: f.itemA, quantity: 1 }] })
    const res = await request(buildApp())
      .post(`/api/business-pos/transactions/${sale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('cross-business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const bsale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .send({ paymentMethod: 'card_recorded',
              lines: [{ itemId: b.itemA, quantity: 1 }] })
    const res = await request(buildApp())
      .post(`/api/business-pos/transactions/${bsale.body.data.id}/refund`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ reason: 'no' })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id detail
// ═══════════════════════════════════════════════════════════════

describe('GET /:id', () => {
  it('returns lines in sort order', async () => {
    const f = await seedFixture()
    const sale = await request(buildApp())
      .post('/api/business-pos/transactions')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        paymentMethod: 'card_recorded',
        lines: [
          { itemId: f.itemA, quantity: 1 },
          { itemId: f.itemB, quantity: 2 },
        ],
      })
    const res = await request(buildApp())
      .get(`/api/business-pos/transactions/${sale.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.lines.length).toBe(2)
    expect(res.body.data.lines[0].sort_order).toBe(0)
    expect(res.body.data.lines[1].sort_order).toBe(1)
  })
})

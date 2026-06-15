/**
 * S503 — business-portal reports coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessReportsRouter } from './businessReports'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-reports', businessReportsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s503'
})

interface Fixture {
  ownerToken: string
  businessId: string
  customerId: string
}

async function seedFixture(opts: { features?: string[] } = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'B', 'O', TRUE) RETURNING id`,
    [email, hash])
  const features = opts.features ?? [
    'customers', 'staff',
    'pos', 'inventory', 'invoicing', 'work_orders', 'quotes',
  ]
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Co', 'other', $2, $3) RETURNING id`,
    [u.id, email, features])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe', '100 Elm', 'Phoenix', 'AZ', '85001')
     RETURNING id`, [b.id])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id, customerId: c.id }
}

// ═══════════════════════════════════════════════════════════════
//  Permission gate
// ═══════════════════════════════════════════════════════════════

describe('Permission gate', () => {
  it('owner gets through', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
  })

  it('staff without reports.view → 403', async () => {
    const f = await seedFixture()
    const hash = await bcrypt.hash('pw', 12)
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'business_staff', 'X', 'Y', TRUE) RETURNING id`,
      [`s-${randomUUID()}@test.dev`, hash])
    await db.query(
      `INSERT INTO business_users (business_id, user_id, staff_role, permissions, status)
       VALUES ($1, $2, 'office', '["dashboard.view"]'::jsonb, 'active')`,
      [f.businessId, u.id])
    const token = jwt.sign(
      { userId: u.id, role: 'business_staff', email: 'x@x.dev',
        profileId: f.businessId, businessId: f.businessId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/reports\.view/)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Feature-conditional sections
// ═══════════════════════════════════════════════════════════════

describe('Feature gating per section', () => {
  it('no optional features → revenue + top_customers only, others null', async () => {
    const f = await seedFixture({ features: ['customers', 'staff'] })
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.revenue).toBeDefined()
    expect(res.body.data.top_customers).toBeDefined()
    expect(res.body.data.pos).toBeNull()
    expect(res.body.data.inventory).toBeNull()
    expect(res.body.data.work_orders).toBeNull()
    expect(res.body.data.quotes).toBeNull()
  })

  it('each feature on → its section appears', async () => {
    const f = await seedFixture({
      features: ['customers', 'staff', 'pos', 'inventory', 'work_orders', 'quotes'],
    })
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.pos).not.toBeNull()
    expect(res.body.data.inventory).not.toBeNull()
    expect(res.body.data.work_orders).not.toBeNull()
    expect(res.body.data.quotes).not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
//  Revenue math
// ═══════════════════════════════════════════════════════════════

describe('Revenue', () => {
  it('daily series spans the full range, default 30 days', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.range).toBe('30d')
    expect(res.body.data.days).toBe(30)
    expect(res.body.data.revenue.daily_series.length).toBe(30)
  })

  it('range=90d returns 90-day series', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/business-reports/overview?range=90d')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.days).toBe(90)
    expect(res.body.data.revenue.daily_series.length).toBe(90)
  })

  it('sums POS + invoiced + collected for the current period', async () => {
    const f = await seedFixture()
    // Today's POS sale (created_at default NOW())
    await db.query(
      `INSERT INTO business_pos_transactions
         (business_id, receipt_number, status, subtotal, tax_amount, total_amount, payment_method)
       VALUES ($1, 'TXN-1', 'completed', 100, 0, 100, 'cash')`,
      [f.businessId])
    // Today's paid invoice — use CURRENT_DATE SQL-side so timezones
    // line up regardless of how the test runner parses dates.
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at, paid_at)
       VALUES ($1, $2, 'INV-1', 'paid', CURRENT_DATE, CURRENT_DATE + 30, 500, 0, 500, 500, NOW(), NOW())`,
      [f.businessId, f.customerId])

    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(Number(res.body.data.revenue.period_totals.pos)).toBeCloseTo(100)
    expect(Number(res.body.data.revenue.period_totals.invoiced)).toBeCloseTo(500)
    expect(Number(res.body.data.revenue.period_totals.collected)).toBeCloseTo(500)
  })

  it('refunded POS sales excluded from totals', async () => {
    const f = await seedFixture()
    await db.query(
      `INSERT INTO business_pos_transactions
         (business_id, receipt_number, status, subtotal, tax_amount, total_amount, payment_method, refunded_at, refund_reason)
       VALUES
         ($1, 'TXN-A', 'completed', 50,  0, 50,  'cash', NULL, NULL),
         ($1, 'TXN-B', 'refunded',  500, 0, 500, 'cash', NOW(), 'test')`,
      [f.businessId])
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(Number(res.body.data.revenue.period_totals.pos)).toBeCloseTo(50)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Top customers
// ═══════════════════════════════════════════════════════════════

describe('Top customers', () => {
  it('ranks by combined POS + invoiced revenue', async () => {
    const f = await seedFixture()
    const { rows: [c2] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers
         (business_id, customer_type, first_name, last_name, street1, city, state, zip)
       VALUES ($1, 'individual', 'Bob', 'Smith', '200 Oak', 'Phoenix', 'AZ', '85001')
       RETURNING id`, [f.businessId])
    // Jane: POS $100
    await db.query(
      `INSERT INTO business_pos_transactions
         (business_id, customer_id, receipt_number, status, subtotal, tax_amount, total_amount, payment_method)
       VALUES ($1, $2, 'TXN-1', 'completed', 100, 0, 100, 'cash')`,
      [f.businessId, f.customerId])
    // Bob: invoice $500 (use SQL-side dates to avoid TZ drift)
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at)
       VALUES ($1, $2, 'INV-1', 'sent', CURRENT_DATE, CURRENT_DATE + 30, 500, 0, 500, 0, NOW())`,
      [f.businessId, c2.id])
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.top_customers.length).toBe(2)
    expect(res.body.data.top_customers[0].first_name).toBe('Bob')  // $500 > $100
    expect(Number(res.body.data.top_customers[0].total_revenue)).toBeCloseTo(500)
  })

  it('excludes customers with zero revenue', async () => {
    const f = await seedFixture()
    // Customer with no activity — should be excluded.
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.top_customers.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  POS
// ═══════════════════════════════════════════════════════════════

describe('POS section', () => {
  it('top_items ranks by revenue', async () => {
    const f = await seedFixture()
    const { rows: [itemA] } = await db.query<{ id: string }>(
      `INSERT INTO business_inventory_items
         (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty)
       VALUES ($1, 'Item A', 'A', 1, 5, 0, 100) RETURNING id`, [f.businessId])
    const { rows: [itemB] } = await db.query<{ id: string }>(
      `INSERT INTO business_inventory_items
         (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty)
       VALUES ($1, 'Item B', 'B', 1, 20, 0, 100) RETURNING id`, [f.businessId])
    const { rows: [txn] } = await db.query<{ id: string }>(
      `INSERT INTO business_pos_transactions
         (business_id, receipt_number, status, subtotal, tax_amount, total_amount, payment_method)
       VALUES ($1, 'TXN-1', 'completed', 0, 0, 0, 'cash') RETURNING id`, [f.businessId])
    await db.query(
      `INSERT INTO business_pos_transaction_lines
         (transaction_id, item_id, name_snapshot, sku_snapshot,
          quantity, unit_price, tax_rate, line_subtotal, line_tax, line_total, sort_order)
       VALUES
         ($1, $2, 'Item A', 'A', 10, 5,  0,  50, 0,  50, 0),
         ($1, $3, 'Item B', 'B',  2, 20, 0,  40, 0,  40, 1)`,
      [txn.id, itemA.id, itemB.id])
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.pos.top_items.length).toBe(2)
    expect(res.body.data.pos.top_items[0].name_snapshot).toBe('Item A')  // $50 > $40
    expect(res.body.data.pos.top_items[0].units_sold).toBe(10)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Inventory
// ═══════════════════════════════════════════════════════════════

describe('Inventory section', () => {
  it('stock value at cost = SUM(stock_qty * cost_price)', async () => {
    const f = await seedFixture()
    await db.query(
      `INSERT INTO business_inventory_items
         (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty)
       VALUES
         ($1, 'A', 'A',  5, 10, 0, 10),
         ($1, 'B', 'B', 20, 50, 0, 3)`,
      [f.businessId])
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    // 10*5 + 3*20 = 110
    expect(Number(res.body.data.inventory.stock_value_at_cost)).toBeCloseTo(110)
  })

  it('shrinkage value = SUM(-delta * cost_price) for shrinkage adjustments', async () => {
    const f = await seedFixture()
    const { rows: [it] } = await db.query<{ id: string }>(
      `INSERT INTO business_inventory_items
         (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty)
       VALUES ($1, 'Widget', 'W', 10, 25, 0, 100) RETURNING id`, [f.businessId])
    await db.query(
      `INSERT INTO business_inventory_adjustments
         (business_id, item_id, adjustment_type, quantity_delta, stock_qty_after, notes)
       VALUES ($1, $2, 'shrinkage', -3, 97, 'broken')`,
      [f.businessId, it.id])
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.inventory.shrinkage_units).toBe(3)
    expect(Number(res.body.data.inventory.shrinkage_value)).toBeCloseTo(30)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Quotes
// ═══════════════════════════════════════════════════════════════

describe('Quotes section', () => {
  it('acceptance_rate = accepted / (accepted + declined); pending/expired excluded', async () => {
    const f = await seedFixture()
    await db.query(
      `INSERT INTO business_quotes
         (business_id, quote_number, customer_id, status,
          sent_at, accepted_at, declined_at, decline_reason,
          subtotal, tax_amount, total_amount)
       VALUES
         ($1, 'Q-1', $2, 'accepted', NOW(), NOW(), NULL,  NULL,         100, 0, 100),
         ($1, 'Q-2', $2, 'accepted', NOW(), NOW(), NULL,  NULL,         200, 0, 200),
         ($1, 'Q-3', $2, 'accepted', NOW(), NOW(), NULL,  NULL,         300, 0, 300),
         ($1, 'Q-4', $2, 'declined', NOW(), NULL,  NOW(), 'too pricey', 400, 0, 400),
         ($1, 'Q-5', $2, 'sent',     NOW(), NULL,  NULL,  NULL,         500, 0, 500)`,
      [f.businessId, f.customerId])
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    // 3 accepted, 1 declined → 75% of decisions
    expect(res.body.data.quotes.acceptance_rate).toBeCloseTo(0.75)
    expect(res.body.data.quotes.accepted_count).toBe(3)
    expect(res.body.data.quotes.declined_count).toBe(1)
    expect(Number(res.body.data.quotes.accepted_value)).toBeCloseTo(600)
  })

  it('no decisions yet → acceptance_rate is null', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.quotes.acceptance_rate).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
//  Cross-business isolation
// ═══════════════════════════════════════════════════════════════

describe('Cross-business isolation', () => {
  it('only own-business data counted', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    // Sale to business B
    await db.query(
      `INSERT INTO business_pos_transactions
         (business_id, receipt_number, status, subtotal, tax_amount, total_amount, payment_method)
       VALUES ($1, 'TXN-X', 'completed', 9999, 0, 9999, 'cash')`,
      [b.businessId])
    const res = await request(buildApp())
      .get('/api/business-reports/overview')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(Number(res.body.data.revenue.period_totals.pos)).toBe(0)
  })
})

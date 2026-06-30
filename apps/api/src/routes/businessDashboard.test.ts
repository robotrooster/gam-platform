/**
 * S499 — business-portal dashboard overview coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessDashboardRouter } from './businessDashboard'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-dashboard', businessDashboardRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s499'
})

interface Fixture {
  ownerToken: string
  businessId: string
  customerId: string
}

async function seedFixture(opts: {
  features?: string[]
} = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const features = opts.features ?? ['customers', 'staff']
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Co', 'mechanic_stationary', $2, $3) RETURNING id`,
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
//  Auth + role
// ═══════════════════════════════════════════════════════════════

describe('GET /overview — auth', () => {
  it('owner returns 200', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
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
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Feature gating per section
// ═══════════════════════════════════════════════════════════════

describe('Feature gating', () => {
  it('no features → revenue + banking returned, other sections null', async () => {
    const f = await seedFixture({ features: ['customers', 'staff'] })
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.revenue).toBeDefined()
    expect(res.body.data.banking).toBeDefined()
    expect(res.body.data.ar_aging).toBeNull()
    expect(res.body.data.today_appointments).toBeNull()
    expect(res.body.data.open_work_orders).toBeNull()
    expect(res.body.data.low_stock).toBeNull()
  })

  it('invoicing on → ar_aging populated', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'invoicing'] })
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.ar_aging).not.toBeNull()
    expect(res.body.data.ar_aging.current).toBeDefined()
  })

  it('appointments on → today_appointments populated', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'appointments'] })
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.today_appointments).toEqual([])
  })

  it('work_orders on → open_work_orders + stats populated', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'work_orders'] })
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.open_work_orders).toEqual([])
    expect(res.body.data.open_work_order_stats).toBeDefined()
  })

  it('inventory on → low_stock array', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'inventory'] })
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.low_stock).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════
//  Revenue tiles
// ═══════════════════════════════════════════════════════════════

describe('Revenue', () => {
  it('today_pos sums today\'s completed POS sales; ignores refunded', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'pos', 'inventory'] })
    // Insert two completed sales + one refunded.
    const seq = await db.query<{ next_number: number }>(
      `INSERT INTO business_pos_sequences (business_id, next_number) VALUES ($1, 4)
       RETURNING next_number`, [f.businessId])
    void seq
    await db.query(
      `INSERT INTO business_pos_transactions
         (business_id, receipt_number, status, subtotal, tax_amount, total_amount, payment_method, refunded_at, refund_reason)
       VALUES
         ($1, 'TXN-000001', 'completed', 50, 5, 55, 'cash',          NULL, NULL),
         ($1, 'TXN-000002', 'completed', 100, 10, 110, 'card_recorded', NULL, NULL),
         ($1, 'TXN-000003', 'refunded', 30, 3, 33, 'cash',           NOW(), 'test')`,
      [f.businessId])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(Number(res.body.data.revenue.today_pos)).toBeCloseTo(165)
    expect(res.body.data.revenue.today_pos_count).toBe(2)
  })

  it('month_invoiced sums sent + paid for current month', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'invoicing'] })
    // First-of-month for current month
    const fom = new Date()
    fom.setDate(1)
    const today = new Date()
    const todayIso = today.toISOString().slice(0, 10)
    const fomIso = fom.toISOString().slice(0, 10)
    const due = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at, paid_at)
       VALUES
         ($1, $2, 'INV-0001', 'sent', $3, $4, 100, 0, 100, 0, NOW(), NULL),
         ($1, $2, 'INV-0002', 'paid', $5, $4, 200, 0, 200, 200, NOW(), NOW()),
         ($1, $2, 'INV-0003', 'draft', $3, $4, 999, 0, 999, 0, NULL, NULL)`,
      [f.businessId, f.customerId, fomIso, due, todayIso])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(Number(res.body.data.revenue.month_invoiced)).toBeCloseTo(300)
    expect(Number(res.body.data.revenue.month_collected)).toBeCloseTo(200)
  })
})

// ═══════════════════════════════════════════════════════════════
//  AR aging buckets
// ═══════════════════════════════════════════════════════════════

describe('AR aging', () => {
  it('places invoices in correct buckets by days overdue', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'invoicing'] })
    const today = new Date()
    const days = (n: number) => {
      const d = new Date(today.getTime() + n * 24 * 60 * 60 * 1000)
      return d.toISOString().slice(0, 10)
    }
    // current (not overdue), 15d, 45d, 75d, 120d overdue
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at)
       VALUES
         ($1, $2, 'INV-0001', 'sent', $3, $4,  100, 0, 100, 0, NOW()),
         ($1, $2, 'INV-0002', 'sent', $5, $6,  200, 0, 200, 0, NOW()),
         ($1, $2, 'INV-0003', 'sent', $7, $8,  300, 0, 300, 0, NOW()),
         ($1, $2, 'INV-0004', 'sent', $9, $10, 400, 0, 400, 0, NOW()),
         ($1, $2, 'INV-0005', 'sent', $11, $12, 500, 0, 500, 0, NOW())`,
      [f.businessId, f.customerId,
       days(-90), days(7),     // current: due in 7 days
       days(-30), days(-15),   // 15 days overdue → 1-30 bucket
       days(-90), days(-45),   // 45 days overdue → 31-60 bucket
       days(-120), days(-75),  // 75 days overdue → 61-90 bucket
       days(-200), days(-120), // 120 days overdue → over 90 bucket
      ])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const a = res.body.data.ar_aging
    expect(a.current.count).toBe(1)
    expect(Number(a.current.amount)).toBeCloseTo(100)
    expect(a.d1to30.count).toBe(1)
    expect(Number(a.d1to30.amount)).toBeCloseTo(200)
    expect(a.d31to60.count).toBe(1)
    expect(Number(a.d31to60.amount)).toBeCloseTo(300)
    expect(a.d61to90.count).toBe(1)
    expect(Number(a.d61to90.amount)).toBeCloseTo(400)
    expect(a.d90plus.count).toBe(1)
    expect(Number(a.d90plus.amount)).toBeCloseTo(500)
  })

  it('partially-paid invoice owed = total - amount_paid', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'invoicing'] })
    const today = new Date().toISOString().slice(0, 10)
    const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at)
       VALUES ($1, $2, 'INV-0001', 'sent', $3, $4, 1000, 0, 1000, 400, NOW())`,
      [f.businessId, f.customerId, today, due])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(Number(res.body.data.ar_aging.current.amount)).toBeCloseTo(600)
  })

  it('void / draft / paid invoices excluded', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'invoicing'] })
    const today = new Date().toISOString().slice(0, 10)
    const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at, paid_at, voided_at, void_reason)
       VALUES
         ($1, $2, 'INV-0001', 'paid',  $3, $4, 1000, 0, 1000, 1000, NOW(), NOW(), NULL, NULL),
         ($1, $2, 'INV-0002', 'draft', $3, $4, 1000, 0, 1000, 0,    NULL, NULL, NULL, NULL),
         ($1, $2, 'INV-0003', 'void',  $3, $4, 1000, 0, 1000, 0,    NULL, NULL, NOW(), 'mistake')`,
      [f.businessId, f.customerId, today, due])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const a = res.body.data.ar_aging
    const total = [a.current, a.d1to30, a.d31to60, a.d61to90, a.d90plus]
      .reduce((s, b) => s + Number(b.amount), 0)
    expect(total).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Open work orders
// ═══════════════════════════════════════════════════════════════

describe('Open work orders', () => {
  it('only returns open/in_progress/awaiting_parts; stats count each', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'work_orders'] })
    await db.query(
      `INSERT INTO business_work_orders
         (business_id, wo_number, customer_id, status, completed_at, cancelled_at, cancel_reason)
       VALUES
         ($1, 'WO-000001', $2, 'open',           NULL, NULL, NULL),
         ($1, 'WO-000002', $2, 'open',           NULL, NULL, NULL),
         ($1, 'WO-000003', $2, 'in_progress',    NULL, NULL, NULL),
         ($1, 'WO-000004', $2, 'awaiting_parts', NULL, NULL, NULL),
         ($1, 'WO-000005', $2, 'completed',      NOW(), NULL, NULL),
         ($1, 'WO-000006', $2, 'cancelled',      NULL, NOW(), 'x')`,
      [f.businessId, f.customerId])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.open_work_orders.length).toBe(4)
    expect(res.body.data.open_work_order_stats.open).toBe(2)
    expect(res.body.data.open_work_order_stats.in_progress).toBe(1)
    expect(res.body.data.open_work_order_stats.awaiting_parts).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Low stock
// ═══════════════════════════════════════════════════════════════

describe('Low stock', () => {
  it('returns items at or below stock_min; count matches', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'inventory'] })
    await db.query(
      `INSERT INTO business_inventory_items
         (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty, stock_min)
       VALUES
         ($1, 'Low A',    'LA', 1, 5, 0, 4,  5),
         ($1, 'Low B',    'LB', 1, 5, 0, 0,  10),
         ($1, 'OK',       'OK', 1, 5, 0, 50, 5),
         ($1, 'NoReorder','NR', 1, 5, 0, 0,  0)`,
      [f.businessId])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.low_stock.length).toBe(2)
    expect(res.body.data.low_stock_count).toBe(2)
    // Worst offender first (largest gap stock_min - stock_qty)
    expect(res.body.data.low_stock[0].name).toBe('Low B')
  })

  it('archived items excluded', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'inventory'] })
    await db.query(
      `INSERT INTO business_inventory_items
         (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty, stock_min, is_active, archived_at)
       VALUES ($1, 'Archived', 'AR', 1, 5, 0, 0, 5, FALSE, NOW())`,
      [f.businessId])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.low_stock.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Today's appointments
// ═══════════════════════════════════════════════════════════════

describe('Today\'s appointments', () => {
  it('returns scheduled-for-today only; excludes other days + completed', async () => {
    const f = await seedFixture({ features: ['customers', 'staff', 'appointments'] })
    const today9 = new Date(); today9.setHours(9, 0, 0, 0)
    const today14 = new Date(); today14.setHours(14, 0, 0, 0)
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    tomorrow.setHours(9, 0, 0, 0)
    await db.query(
      `INSERT INTO appointments
         (business_id, customer_id, service_type, scheduled_for, status, duration_minutes, completed_at)
       VALUES
         ($1, $2, 'Oil change',   $3, 'scheduled', 30, NULL),
         ($1, $2, 'Tire rotation',$4, 'scheduled', 60, NULL),
         ($1, $2, 'Diagnostic',   $5, 'scheduled', 45, NULL),
         ($1, $2, 'Done one',     $3, 'completed', 30, NOW())`,
      [f.businessId, f.customerId,
       today9.toISOString(), today14.toISOString(), tomorrow.toISOString()])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.today_appointments.length).toBe(2)
    // Ordered by time ASC
    expect(res.body.data.today_appointments[0].service_type).toBe('Oil change')
    expect(res.body.data.today_appointments[1].service_type).toBe('Tire rotation')
  })
})

// ═══════════════════════════════════════════════════════════════
//  Banking
// ═══════════════════════════════════════════════════════════════

describe('Banking', () => {
  it('reflects connect column state', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE businesses
          SET stripe_connect_account_id = 'acct_test',
              connect_payouts_enabled = FALSE,
              connect_details_submitted = TRUE
        WHERE id = $1`, [f.businessId])
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.banking.has_connect_account).toBe(true)
    expect(res.body.data.banking.payouts_enabled).toBe(false)
    expect(res.body.data.banking.details_submitted).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Cross-business isolation
// ═══════════════════════════════════════════════════════════════

describe('Cross-business isolation', () => {
  it('only counts own business data', async () => {
    const a = await seedFixture({ features: ['customers', 'staff', 'invoicing'] })
    const b = await seedFixture({ features: ['customers', 'staff', 'invoicing'] })

    const today = new Date().toISOString().slice(0, 10)
    const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at)
       VALUES ($1, $2, 'INV-0001', 'sent', $3, $4, 5000, 0, 5000, 0, NOW())`,
      [b.businessId, b.customerId, today, due])

    // Owner A loads dashboard — should see $0 outstanding, not $5000
    const res = await request(buildApp())
      .get('/api/business-dashboard/overview')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    const total = ['current', 'd1to30', 'd31to60', 'd61to90', 'd90plus']
      .reduce((s, k) => s + Number(res.body.data.ar_aging[k].amount), 0)
    expect(total).toBe(0)
  })
})

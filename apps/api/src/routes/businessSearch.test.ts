/**
 * S511 — global search coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessSearchRouter } from './businessSearch'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-search', businessSearchRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s511'
})

interface Fixture {
  ownerToken: string
  businessId: string
}

async function seedFixture(opts: { features?: string[] } = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('pw', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'B', 'O', TRUE) RETURNING id`,
    [email, hash])
  const features = opts.features ?? [
    'customers', 'staff', 'invoicing', 'quotes', 'work_orders', 'appointments',
  ]
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Shop', 'mechanic_stationary', $2, $3) RETURNING id`,
    [u.id, email, features])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id }
}

async function seedCustomer(businessId: string, overrides: Record<string, string> = {}): Promise<string> {
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        email, phone, street1, city, state, zip)
     VALUES ($1, 'individual', $2, $3, $4, $5, '100 Elm', 'Phoenix', 'AZ', '85001')
     RETURNING id`,
    [businessId,
     overrides.firstName ?? 'Jane',
     overrides.lastName ?? 'Doe',
     overrides.email ?? 'jane@example.dev',
     overrides.phone ?? '555-0100'])
  return c.id
}

// ═══════════════════════════════════════════════════════════════
//  Query validation
// ═══════════════════════════════════════════════════════════════

describe('GET /', () => {
  it('empty q → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/business-search')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(400)
  })

  it('q present but no matches → 0 total, empty groups', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get('/api/business-search?q=zzznomatch')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Customers
// ═══════════════════════════════════════════════════════════════

describe('Customers', () => {
  it('matches by first name', async () => {
    const f = await seedFixture()
    await seedCustomer(f.businessId, { firstName: 'Jasmine' })
    const res = await request(buildApp())
      .get('/api/business-search?q=jasm')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.results.customers.length).toBe(1)
    expect(res.body.data.results.customers[0].first_name).toBe('Jasmine')
  })

  it('matches by email substring', async () => {
    const f = await seedFixture()
    await seedCustomer(f.businessId, { email: 'unique@biz.dev' })
    const res = await request(buildApp())
      .get('/api/business-search?q=unique@')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.results.customers.length).toBe(1)
  })

  it('matches by phone substring', async () => {
    const f = await seedFixture()
    await seedCustomer(f.businessId, { phone: '555-9999' })
    const res = await request(buildApp())
      .get('/api/business-search?q=9999')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.results.customers.length).toBe(1)
  })

  it('cross-business customer NOT returned', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await seedCustomer(b.businessId, { firstName: 'OtherBiz' })
    const res = await request(buildApp())
      .get('/api/business-search?q=other')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.body.data.results.customers.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Invoices + Quotes + WOs + Appointments
// ═══════════════════════════════════════════════════════════════

describe('Multi-entity match', () => {
  it('invoice number prefix matches', async () => {
    const f = await seedFixture()
    const cId = await seedCustomer(f.businessId)
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at)
       VALUES ($1, $2, 'INV-0042', 'sent', CURRENT_DATE, CURRENT_DATE + 30, 100, 0, 100, 0, NOW())`,
      [f.businessId, cId])
    const res = await request(buildApp())
      .get('/api/business-search?q=INV-0042')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.results.invoices.length).toBe(1)
    expect(res.body.data.results.invoices[0].invoice_number).toBe('INV-0042')
  })

  it('work-order complaint match', async () => {
    const f = await seedFixture()
    const cId = await seedCustomer(f.businessId)
    await db.query(
      `INSERT INTO business_work_orders
         (business_id, wo_number, customer_id, status, complaint)
       VALUES ($1, 'WO-000007', $2, 'open', 'Brake squeal from front-right wheel')`,
      [f.businessId, cId])
    const res = await request(buildApp())
      .get('/api/business-search?q=squeal')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.results.work_orders.length).toBe(1)
  })

  it('quote + invoice in one query', async () => {
    const f = await seedFixture()
    const cId = await seedCustomer(f.businessId, { lastName: 'Magnusson' })
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at)
       VALUES ($1, $2, 'INV-0099', 'sent', CURRENT_DATE, CURRENT_DATE + 30, 100, 0, 100, 0, NOW())`,
      [f.businessId, cId])
    await db.query(
      `INSERT INTO business_quotes
         (business_id, customer_id, quote_number, status,
          subtotal, tax_amount, total_amount, sent_at)
       VALUES ($1, $2, 'Q-000003', 'sent', 100, 0, 100, NOW())`,
      [f.businessId, cId])
    const res = await request(buildApp())
      .get('/api/business-search?q=magnusson')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.results.customers.length).toBe(1)
    expect(res.body.data.results.invoices.length).toBe(1)
    expect(res.body.data.results.quotes.length).toBe(1)
    expect(res.body.data.total).toBe(3)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Permission/feature gating
// ═══════════════════════════════════════════════════════════════

describe('Permission gating', () => {
  it('staff without invoices.read → invoices key not in results', async () => {
    const f = await seedFixture()
    const cId = await seedCustomer(f.businessId)
    await db.query(
      `INSERT INTO business_invoices
         (business_id, customer_id, invoice_number, status, issue_date, due_date,
          subtotal, tax_amount, total_amount, amount_paid, sent_at)
       VALUES ($1, $2, 'INV-0001', 'sent', CURRENT_DATE, CURRENT_DATE + 30, 100, 0, 100, 0, NOW())`,
      [f.businessId, cId])
    // Staff with ONLY customers.read
    const hash = await bcrypt.hash('pw', 12)
    const email = `s-${randomUUID()}@test.dev`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, $2, 'business_staff', 'S', 'S', TRUE) RETURNING id`,
      [email, hash])
    await db.query(
      `INSERT INTO business_users (business_id, user_id, staff_role, permissions, status)
       VALUES ($1, $2, 'office', '["customers.read"]'::jsonb, 'active')`,
      [f.businessId, u.id])
    const staffToken = jwt.sign(
      { userId: u.id, role: 'business_staff', email,
        profileId: f.businessId, businessId: f.businessId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/business-search?q=Jane')
      .set('Authorization', `Bearer ${staffToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.results.customers).toBeDefined()
    expect(res.body.data.results.invoices).toBeUndefined()
    expect(res.body.data.results.work_orders).toBeUndefined()
  })

  it('feature off → category excluded', async () => {
    const f = await seedFixture({ features: ['customers', 'staff'] })  // no invoicing
    await seedCustomer(f.businessId)
    const res = await request(buildApp())
      .get('/api/business-search?q=Jane')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.results.invoices).toBeUndefined()
    expect(res.body.data.results.customers).toBeDefined()
  })
})

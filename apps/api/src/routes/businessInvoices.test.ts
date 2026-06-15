/**
 * S493 — business-portal invoicing CRUD coverage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

// S500: mock the email helper so we can assert it fires on invoice send.
const { emailBusinessInvoiceSentMock } = vi.hoisted(() => ({
  emailBusinessInvoiceSentMock: vi.fn(async () => undefined),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessInvoiceSent: emailBusinessInvoiceSentMock }
})

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessInvoicesRouter } from './businessInvoices'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-invoices', businessInvoicesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailBusinessInvoiceSentMock.mockClear()
  emailBusinessInvoiceSentMock.mockImplementation(async () => undefined)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s493'
})

interface Fixture {
  ownerToken: string
  businessId: string
  customerId: string
}

async function seedFixture(opts: {
  invoicingEnabled?: boolean
} = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const features = opts.invoicingEnabled === false
    ? ['customers', 'staff']
    : ['customers', 'staff', 'invoicing']
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Co', 'trash_hauling', $2, $3) RETURNING id`,
    [u.id, email, features])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe',
             '100 Elm', 'Phoenix', 'AZ', '85001')
     RETURNING id`, [b.id])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email,
      profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id, customerId: c.id }
}

const validCreate = (customerId: string, over: Record<string, any> = {}) => ({
  customerId,
  issueDate: '2026-06-14',
  dueDate:   '2026-07-14',
  taxAmount: 0,
  notes:     'Thanks for your business!',
  lines: [
    { description: 'Weekly trash pickup',  quantity: 4, unitPrice: 25 },
    { description: 'Extra haul (1 yard)',  quantity: 1, unitPrice: 50 },
  ],
  ...over,
})

// ═══════════════════════════════════════════════════════════════
//  POST / — create
// ═══════════════════════════════════════════════════════════════

describe('POST /api/business-invoices', () => {
  it('happy: creates draft + lines + sequential invoice number', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('draft')
    expect(res.body.data.invoice_number).toBe('INV-0001')
    expect(Number(res.body.data.subtotal)).toBe(150)  // 4*25 + 1*50
    expect(Number(res.body.data.total_amount)).toBe(150)
    expect(res.body.data.lines.length).toBe(2)
    expect(res.body.data.lines[0].sort_order).toBe(0)

    // Second invoice → INV-0002
    const res2 = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    expect(res2.body.data.invoice_number).toBe('INV-0002')
  })

  it('feature gate: invoicing off → 403 with hint', async () => {
    const f = await seedFixture({ invoicingEnabled: false })
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Invoicing is not enabled/i)
  })

  it('cross-business customer → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send(validCreate(b.customerId))
    expect(res.status).toBe(404)
  })

  it('due_date before issue_date → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId, {
        issueDate: '2026-07-01', dueDate: '2026-06-01',
      }))
    expect(res.status).toBe(400)
  })

  it('zero lines → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId, { lines: [] }))
    expect(res.status).toBe(400)
  })

  it('tax adds to total', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId, { taxAmount: 12.50 }))
    expect(Number(res.body.data.subtotal)).toBe(150)
    expect(Number(res.body.data.tax_amount)).toBe(12.50)
    expect(Number(res.body.data.total_amount)).toBe(162.50)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET / — list
// ═══════════════════════════════════════════════════════════════

describe('GET /api/business-invoices', () => {
  it('lists own invoices in newest-first order; customer name joined', async () => {
    const f = await seedFixture()
    await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId, { notes: 'first' }))
    await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId, { notes: 'second' }))
    const res = await request(buildApp())
      .get('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    expect(res.body.data[0].invoice_number).toBe('INV-0002')
    expect(res.body.data[0].customer_first_name).toBe('Jane')
  })

  it('status filter works', async () => {
    const f = await seedFixture()
    const c1 = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    await request(buildApp())
      .post(`/api/business-invoices/${c1.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))

    const res = await request(buildApp())
      .get('/api/business-invoices?status=sent')
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].status).toBe('sent')
  })

  it('cross-business rows excluded', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send(validCreate(a.customerId))
    await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .send(validCreate(b.customerId))

    const res = await request(buildApp())
      .get('/api/business-invoices')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.body.data.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Lifecycle: send / mark-paid / void
// ═══════════════════════════════════════════════════════════════

describe('POST /:id/send', () => {
  it('draft → sent with sent_at stamp', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('sent')
    expect(res.body.data.sent_at).not.toBeNull()
  })

  it('sending an already-sent invoice → 404', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(404)
  })

  // S494: without Connect, send still succeeds but hosted_pay_url is
  // null. Owner records cash/check via mark-paid later.
  it('S494: send without Connect configured → hosted_pay_url null', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('sent')
    expect(res.body.data.hosted_pay_url).toBeNull()

    // Detail also reflects null.
    const detail = await request(buildApp())
      .get(`/api/business-invoices/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.hosted_pay_url).toBeNull()
    expect(detail.body.data.stripe_checkout_session_id).toBeNull()
  })
})

describe('POST /:id/mark-paid', () => {
  it('happy: sent → paid with method + amount', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/mark-paid`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'cash' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('paid')

    const detail = await request(buildApp())
      .get(`/api/business-invoices/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.payment_method).toBe('cash')
    expect(Number(detail.body.data.amount_paid)).toBe(150)  // full total default
  })

  it('mark-paid on draft auto-stamps sent_at too', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/mark-paid`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'check', amount: 150 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('paid')
  })

  it('cannot mark a voided invoice paid → 409', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/void`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'mistake' })
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/mark-paid`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'cash' })
    expect(res.status).toBe(409)
  })
})

describe('POST /:id/void', () => {
  it('happy: draft → void with reason persisted', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/void`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'Wrong customer' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('void')

    const detail = await request(buildApp())
      .get(`/api/business-invoices/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.void_reason).toBe('Wrong customer')
  })

  it('cannot void a paid invoice → 404', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/mark-paid`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ paymentMethod: 'cash' })
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/void`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'change of mind' })
    expect(res.status).toBe(404)
  })

  it('reason required → 400 without it', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/void`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id — detail with lines
// ═══════════════════════════════════════════════════════════════

describe('GET /:id', () => {
  it('returns customer name + email + lines in sort order', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE business_customers SET email = 'jane@x.dev' WHERE id = $1`,
      [f.customerId])
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    const res = await request(buildApp())
      .get(`/api/business-invoices/${c.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.customer_email).toBe('jane@x.dev')
    expect(res.body.data.lines.length).toBe(2)
    expect(res.body.data.lines[0].description).toBe('Weekly trash pickup')
  })

  it('cross-business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .send(validCreate(b.customerId))
    const res = await request(buildApp())
      .get(`/api/business-invoices/${c.body.data.id}`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S506 — auto-tax on invoice create
// ═══════════════════════════════════════════════════════════════

describe('POST / — auto-tax (S506)', () => {
  // validCreate explicitly sends taxAmount:0, which counts as "owner
  // override" under the auto-tax semantics. These tests exercise the
  // auto-fill path by stripping taxAmount from the body.
  const noTax = (customerId: string, over: Record<string, any> = {}) => {
    const body = validCreate(customerId, over)
    delete (body as any).taxAmount
    return body
  }

  it('auto-fills tax from business.default_tax_rate when omitted', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE businesses SET default_tax_rate = 0.0875 WHERE id = $1`,
      [f.businessId])
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(noTax(f.customerId))
    expect(res.status).toBe(201)
    // subtotal = 150, tax = 150 * 0.0875 = 13.125 → 13.13 (rounded)
    expect(Number(res.body.data.tax_amount)).toBeCloseTo(13.13)
    expect(Number(res.body.data.total_amount)).toBeCloseTo(163.13)
  })

  it('explicit taxAmount wins over business default', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE businesses SET default_tax_rate = 0.0875 WHERE id = $1`,
      [f.businessId])
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId, { taxAmount: 99 }))
    expect(Number(res.body.data.tax_amount)).toBe(99)
  })

  it('tax-exempt customer → tax_amount is 0 even with business rate set', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE businesses SET default_tax_rate = 0.0875 WHERE id = $1`,
      [f.businessId])
    await db.query(
      `UPDATE business_customers SET tax_exempt = TRUE WHERE id = $1`,
      [f.customerId])
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(noTax(f.customerId))
    expect(Number(res.body.data.tax_amount)).toBe(0)
    expect(Number(res.body.data.total_amount)).toBe(150)
  })

  it('default rate 0 → tax 0 (no-tax business)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(noTax(f.customerId))
    expect(Number(res.body.data.tax_amount)).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S504 — PDF endpoint
// ═══════════════════════════════════════════════════════════════

describe('GET /:id/pdf', () => {
  it('returns application/pdf with %PDF magic', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    const res = await request(buildApp())
      .get(`/api/business-invoices/${c.body.data.id}/pdf`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .responseType('blob')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF')
  })

  it('cross-business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .send(validCreate(b.customerId))
    const res = await request(buildApp())
      .get(`/api/business-invoices/${c.body.data.id}/pdf`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  S500 — invoice send email
// ═══════════════════════════════════════════════════════════════

describe('POST /:id/send — customer email (S500)', () => {
  it('fires emailBusinessInvoiceSent when customer has email', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE business_customers SET email = 'jane@x.dev' WHERE id = $1`,
      [f.customerId])
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)

    expect(emailBusinessInvoiceSentMock).toHaveBeenCalledTimes(1)
    const arg = (emailBusinessInvoiceSentMock.mock.calls as any[])[0][0]
    expect(arg.to).toBe('jane@x.dev')
    expect(arg.businessName).toBe('Test Co')
    expect(arg.invoiceNumber).toBe('INV-0001')
    expect(arg.totalAmount).toBeCloseTo(150)
    expect(arg.dueDate).toBe('2026-07-14')
    expect(arg.payUrl).toBeNull()        // no Connect, no Checkout session
  })

  it('skips email when customer has no email', async () => {
    const f = await seedFixture()
    // Don't set email on the customer.
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(emailBusinessInvoiceSentMock).not.toHaveBeenCalled()
  })

  it('email failure does NOT break the send transition', async () => {
    emailBusinessInvoiceSentMock.mockImplementationOnce(async () => {
      throw new Error('resend api down')
    })
    const f = await seedFixture()
    await db.query(
      `UPDATE business_customers SET email = 'jane@x.dev' WHERE id = $1`,
      [f.customerId])
    const c = await request(buildApp())
      .post('/api/business-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validCreate(f.customerId))
    const res = await request(buildApp())
      .post(`/api/business-invoices/${c.body.data.id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('sent')
  })
})

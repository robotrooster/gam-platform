/**
 * S501 — quotes / estimates coverage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

// Mock the quote-sent email helper so we can assert it fires + survive
// failures.
const { emailBusinessQuoteSentMock } = vi.hoisted(() => ({
  emailBusinessQuoteSentMock: vi.fn(async () => undefined),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessQuoteSent: emailBusinessQuoteSentMock }
})

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessQuotesRouter } from './businessQuotes'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-quotes', businessQuotesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailBusinessQuoteSentMock.mockClear()
  emailBusinessQuoteSentMock.mockImplementation(async () => undefined)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s501'
})

interface Fixture {
  ownerToken: string
  businessId: string
  customerId: string
  itemId: string
}

async function seedFixture(opts: {
  features?: string[]
  itemStock?: number
  itemPrice?: number
} = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const features = opts.features ?? ['customers', 'staff', 'quotes', 'invoicing', 'work_orders', 'inventory']
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
  const { rows: [item] } = await db.query<{ id: string }>(
    `INSERT INTO business_inventory_items
       (business_id, name, sku, cost_price, sell_price, tax_rate, stock_qty)
     VALUES ($1, 'Brake Pad', 'BRK-001', 8.00, $2, 0.0875, $3) RETURNING id`,
    [b.id, opts.itemPrice ?? 25.00, opts.itemStock ?? 10])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id, customerId: c.id, itemId: item.id }
}

async function newQuote(token: string, customerId: string): Promise<string> {
  const r = await request(buildApp())
    .post('/api/business-quotes')
    .set('Authorization', `Bearer ${token}`)
    .send({ customerId })
  return r.body.data.id
}

// ═══════════════════════════════════════════════════════════════
//  Feature gating
// ═══════════════════════════════════════════════════════════════

describe('Feature gate', () => {
  it('quotes off → 403 with hint', async () => {
    const f = await seedFixture({ features: ['customers', 'staff'] })
    const res = await request(buildApp())
      .post('/api/business-quotes')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Quotes is not enabled/i)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Create + list
// ═══════════════════════════════════════════════════════════════

describe('POST /business-quotes', () => {
  it('sequential Q-NNNNNN per business', async () => {
    const f = await seedFixture()
    const r1 = await request(buildApp())
      .post('/api/business-quotes')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId, intakeDescription: 'Brake inspection' })
    expect(r1.status).toBe(201)
    expect(r1.body.data.quote_number).toBe('Q-000001')
    expect(r1.body.data.status).toBe('draft')

    const r2 = await request(buildApp())
      .post('/api/business-quotes')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ customerId: f.customerId })
    expect(r2.body.data.quote_number).toBe('Q-000002')
  })

  it('cross-business customer → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-quotes')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({ customerId: b.customerId })
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Lines
// ═══════════════════════════════════════════════════════════════

describe('POST /:id/lines', () => {
  it('labor: computes hours × rate; updates header totals', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Brake replacement', hours: 2, hourlyRate: 100, taxRate: 0 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.line_subtotal)).toBeCloseTo(200)
    const detail = await request(buildApp())
      .get(`/api/business-quotes/${id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(Number(detail.body.data.subtotal)).toBeCloseTo(200)
    expect(Number(detail.body.data.total_amount)).toBeCloseTo(200)
  })

  it('part: snapshots item name + price but does NOT decrement stock', async () => {
    const f = await seedFixture({ itemStock: 10 })
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 4 })
    expect(res.status).toBe(201)
    expect(res.body.data.description).toBe('Brake Pad')
    // Stock unchanged
    const { rows: [item] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`, [f.itemId])
    expect(item.stock_qty).toBe(10)
    // No adjustment rows
    const { rows: adj } = await db.query(
      `SELECT * FROM business_inventory_adjustments WHERE item_id = $1`, [f.itemId])
    expect(adj.length).toBe(0)
  })

  it('generic: free-form qty × unit_price', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'generic', description: 'Service bundle', quantity: 3, unitPrice: 50, taxRate: 0 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.line_subtotal)).toBeCloseTo(150)
  })

  it('cannot add lines to a sent quote', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'x', hours: 1, hourlyRate: 100 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'y', hours: 1, hourlyRate: 100 })
    expect(res.status).toBe(409)
  })
})

describe('Line tax defaulting (S506)', () => {
  it('labor line without taxRate falls back to business default_tax_rate', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE businesses SET default_tax_rate = 0.0875 WHERE id = $1`,
      [f.businessId])
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Diag', hours: 1, hourlyRate: 100 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.tax_rate)).toBeCloseTo(0.0875)
    expect(Number(res.body.data.line_tax)).toBeCloseTo(8.75)
  })

  it('exempt customer zeros the default rate', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE businesses SET default_tax_rate = 0.0875 WHERE id = $1`,
      [f.businessId])
    await db.query(
      `UPDATE business_customers SET tax_exempt = TRUE WHERE id = $1`,
      [f.customerId])
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Diag', hours: 1, hourlyRate: 100 })
    expect(Number(res.body.data.tax_rate)).toBe(0)
    expect(Number(res.body.data.line_tax)).toBe(0)
  })

  it('explicit taxRate overrides the default', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE businesses SET default_tax_rate = 0.0875 WHERE id = $1`,
      [f.businessId])
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Diag', hours: 1, hourlyRate: 100, taxRate: 0.05 })
    expect(Number(res.body.data.tax_rate)).toBeCloseTo(0.05)
  })

  it('part line: exempt customer zeros item tax_rate snapshot', async () => {
    const f = await seedFixture()
    await db.query(
      `UPDATE business_customers SET tax_exempt = TRUE WHERE id = $1`,
      [f.customerId])
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 1 })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.tax_rate)).toBe(0)
  })
})

describe('DELETE /:id/lines/:lineId', () => {
  it('removes line + recomputes totals', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    const add = await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'x', hours: 1, hourlyRate: 100 })
    await request(buildApp())
      .delete(`/api/business-quotes/${id}/lines/${add.body.data.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const detail = await request(buildApp())
      .get(`/api/business-quotes/${id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.lines.length).toBe(0)
    expect(Number(detail.body.data.total_amount)).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Send
// ═══════════════════════════════════════════════════════════════

describe('POST /:id/send', () => {
  it('happy: flips draft → sent, sets sent_at + expires_at, fires email', async () => {
    const f = await seedFixture()
    await db.query(`UPDATE business_customers SET email = 'jane@x.dev' WHERE id = $1`, [f.customerId])
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Service', hours: 2, hourlyRate: 100 })
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ expiresInDays: 14 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('sent')
    expect(res.body.data.sent_at).not.toBeNull()
    expect(res.body.data.expires_at).not.toBeNull()

    expect(emailBusinessQuoteSentMock).toHaveBeenCalledTimes(1)
    const arg = (emailBusinessQuoteSentMock.mock.calls as any[])[0][0]
    expect(arg.to).toBe('jane@x.dev')
    expect(arg.quoteNumber).toBe('Q-000001')
    expect(arg.lines.length).toBe(1)
  })

  it('cannot send with zero lines → 400', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('email failure does NOT break send', async () => {
    emailBusinessQuoteSentMock.mockImplementationOnce(async () => {
      throw new Error('resend down')
    })
    const f = await seedFixture()
    await db.query(`UPDATE business_customers SET email = 'jane@x.dev' WHERE id = $1`, [f.customerId])
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'x', hours: 1, hourlyRate: 100 })
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('sent')
  })
})

// ═══════════════════════════════════════════════════════════════
//  Accept / decline
// ═══════════════════════════════════════════════════════════════

describe('Accept / decline', () => {
  it('accept: sent → accepted', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'x', hours: 1, hourlyRate: 100 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/accept`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('accepted')
    expect(res.body.data.accepted_at).not.toBeNull()
  })

  it('decline: requires reason', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'x', hours: 1, hourlyRate: 100 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    const bad = await request(buildApp())
      .post(`/api/business-quotes/${id}/decline`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    expect(bad.status).toBe(400)
    const good = await request(buildApp())
      .post(`/api/business-quotes/${id}/decline`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ reason: 'Too expensive' })
    expect(good.body.data.status).toBe('declined')
    expect(good.body.data.decline_reason).toBe('Too expensive')
  })

  it('cannot accept a draft (must be sent first)', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/accept`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Convert to invoice
// ═══════════════════════════════════════════════════════════════

describe('Convert to invoice', () => {
  it('happy: accepted → draft invoice; both rows linked', async () => {
    const f = await seedFixture({ itemPrice: 25, itemStock: 10 })
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Service', hours: 2, hourlyRate: 100, taxRate: 0 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 2 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    await request(buildApp())
      .post(`/api/business-quotes/${id}/accept`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const conv = await request(buildApp())
      .post(`/api/business-quotes/${id}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    expect(conv.status).toBe(201)
    expect(conv.body.data.invoice_number).toMatch(/^INV-\d{4}$/)
    expect(conv.body.data.status).toBe('draft')
    expect(conv.body.data.source_quote_id).toBe(id)

    const detail = await request(buildApp())
      .get(`/api/business-quotes/${id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.invoice_id).toBe(conv.body.data.id)
  })

  it('double-convert → 409', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'x', hours: 1, hourlyRate: 100 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    await request(buildApp())
      .post(`/api/business-quotes/${id}/accept`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/convert-to-invoice`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ issueDate: '2026-06-14', dueDate: '2026-07-14' })
    expect(res.status).toBe(409)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Convert to work order
// ═══════════════════════════════════════════════════════════════

describe('Convert to work order', () => {
  it('happy: accepted → open WO; part lines decrement stock', async () => {
    const f = await seedFixture({ itemStock: 10, itemPrice: 25 })
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'Service', hours: 2, hourlyRate: 100, taxRate: 0 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 3 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    await request(buildApp())
      .post(`/api/business-quotes/${id}/accept`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const conv = await request(buildApp())
      .post(`/api/business-quotes/${id}/convert-to-work-order`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(conv.status).toBe(201)
    expect(conv.body.data.wo_number).toMatch(/^WO-\d{6}$/)
    expect(conv.body.data.source_quote_id).toBe(id)
    expect(conv.body.data.status).toBe('open')

    // Stock decremented
    const { rows: [item] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`, [f.itemId])
    expect(item.stock_qty).toBe(7)
    // Audit row written
    const { rows: adj } = await db.query<{ adjustment_type: string }>(
      `SELECT adjustment_type FROM business_inventory_adjustments WHERE item_id = $1`, [f.itemId])
    expect(adj.length).toBe(1)
    expect(adj[0]!.adjustment_type).toBe('used')

    // Reverse linkage
    const detail = await request(buildApp())
      .get(`/api/business-quotes/${id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(detail.body.data.work_order_id).toBe(conv.body.data.id)
  })

  it('insufficient stock at convert time → 400; rollback (WO not created)', async () => {
    const f = await seedFixture({ itemStock: 1 })
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'part', itemId: f.itemId, quantity: 5 })
    await request(buildApp())
      .post(`/api/business-quotes/${id}/send`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({})
    await request(buildApp())
      .post(`/api/business-quotes/${id}/accept`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const conv = await request(buildApp())
      .post(`/api/business-quotes/${id}/convert-to-work-order`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(conv.status).toBe(400)
    // Stock unchanged
    const { rows: [item] } = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM business_inventory_items WHERE id = $1`, [f.itemId])
    expect(item.stock_qty).toBe(1)
    // No WO row written
    const { rows: wos } = await db.query(
      `SELECT id FROM business_work_orders WHERE business_id = $1`, [f.businessId])
    expect(wos.length).toBe(0)
  })

  it('cannot convert a draft to a WO', async () => {
    const f = await seedFixture()
    const id = await newQuote(f.ownerToken, f.customerId)
    await request(buildApp())
      .post(`/api/business-quotes/${id}/lines`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ lineType: 'labor', description: 'x', hours: 1, hourlyRate: 100 })
    const res = await request(buildApp())
      .post(`/api/business-quotes/${id}/convert-to-work-order`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(409)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Cross-business isolation
// ═══════════════════════════════════════════════════════════════

describe('Cross-business isolation', () => {
  it('list + detail excluded; cannot manipulate other-business quote', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const bQ = await newQuote(b.ownerToken, b.customerId)

    const list = await request(buildApp())
      .get('/api/business-quotes')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(list.body.data.length).toBe(0)

    const detail = await request(buildApp())
      .get(`/api/business-quotes/${bQ}`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(detail.status).toBe(404)

    const send = await request(buildApp())
      .post(`/api/business-quotes/${bQ}/send`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send({})
    expect(send.status).toBe(404)
  })
})

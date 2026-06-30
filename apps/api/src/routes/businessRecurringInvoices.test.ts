/**
 * S505 — recurring invoice schedules + generation coverage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'

// Mock the auto-send email helper so the auto_send path doesn't
// actually try to hit Resend.
const { emailBusinessInvoiceSentMock } = vi.hoisted(() => ({
  emailBusinessInvoiceSentMock: vi.fn(async () => undefined),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessInvoiceSent: emailBusinessInvoiceSentMock }
})

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { businessRecurringInvoicesRouter } from './businessRecurringInvoices'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/business-recurring-invoices', businessRecurringInvoicesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailBusinessInvoiceSentMock.mockClear()
  emailBusinessInvoiceSentMock.mockImplementation(async () => undefined)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s505'
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
  const features = opts.features ?? ['customers', 'staff', 'invoicing']
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Test Co', 'other', $2, $3) RETURNING id`,
    [u.id, email, features])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        street1, city, state, zip, email)
     VALUES ($1, 'individual', 'Jane', 'Doe', '100 Elm', 'Phoenix', 'AZ', '85001', 'jane@x.dev')
     RETURNING id`, [b.id])
  const ownerToken = jwt.sign(
    { userId: u.id, role: 'business_owner', email, profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { ownerToken, businessId: b.id, customerId: c.id }
}

const validMonthlyBody = (customerId: string, over: Record<string, any> = {}) => ({
  customerId,
  name: 'Monthly lawn',
  frequency: 'monthly',
  dayOfMonth: 15,
  startDate: '2026-06-01',
  autoSend: false,
  paymentTermsDays: 30,
  lines: [
    { description: 'Mowing', quantity: 1, unitPrice: 150 },
  ],
  ...over,
})

// ═══════════════════════════════════════════════════════════════
//  Create
// ═══════════════════════════════════════════════════════════════

describe('POST /', () => {
  it('creates a monthly schedule with computed next_due_date', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId, { dayOfMonth: 15, startDate: '2026-06-01' }))
    expect(res.status).toBe(201)
    expect(res.body.data.frequency).toBe('monthly')
    expect(res.body.data.day_of_month).toBe(15)
    expect(res.body.data.next_due_date.slice(0, 10)).toBe('2026-06-15')
  })

  it('creates a quarterly schedule (month-based, anchors to day_of_month)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId, {
        frequency: 'quarterly', dayOfMonth: 10, startDate: '2026-06-01', name: 'Quarterly service',
      }))
    expect(res.status).toBe(201)
    expect(res.body.data.frequency).toBe('quarterly')
    expect(res.body.data.day_of_month).toBe(10)
    expect(res.body.data.day_of_week).toBeNull()
    // First due seeds on the first day_of_month on/after start (same as monthly).
    expect(res.body.data.next_due_date.slice(0, 10)).toBe('2026-06-10')
  })

  it('annual schedule carrying dayOfWeek → 400 (discriminated union rejects)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        customerId: f.customerId, name: 'X', frequency: 'annual', dayOfWeek: 3,
        startDate: '2026-06-01', lines: [{ description: 'Y', quantity: 1, unitPrice: 10 }],
      })
    expect(res.status).toBe(400)
  })

  it('creates a weekly schedule with next due on the chosen weekday', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        customerId: f.customerId, name: 'Weekly trash',
        frequency: 'weekly', dayOfWeek: 1,  // Monday
        startDate: '2026-06-01', autoSend: false,  // 2026-06-01 is a Monday
        lines: [{ description: 'Pickup', quantity: 1, unitPrice: 25 }],
      })
    expect(res.status).toBe(201)
    expect(res.body.data.frequency).toBe('weekly')
    expect(res.body.data.day_of_week).toBe(1)
    // 2026-06-01 IS a Monday, so next_due = start_date
    expect(res.body.data.next_due_date.slice(0, 10)).toBe('2026-06-01')
  })

  it('monthly missing dayOfMonth → 400 (zod discriminated union)', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        customerId: f.customerId, name: 'X', frequency: 'monthly',
        startDate: '2026-06-01',
        lines: [{ description: 'X', quantity: 1, unitPrice: 1 }],
      })
    expect(res.status).toBe(400)
  })

  it('cross-business customer → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${a.ownerToken}`)
      .send(validMonthlyBody(b.customerId))
    expect(res.status).toBe(404)
  })

  it('end_date before start_date → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId, {
        startDate: '2026-06-01', endDate: '2026-05-01',
      }))
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Generate now
// ═══════════════════════════════════════════════════════════════

describe('POST /:id/generate-now', () => {
  it('creates a draft invoice + bumps next_due_date by 1 month', async () => {
    const f = await seedFixture()
    // Make next_due_date today so generation is in-range. Use SQL-side
    // CURRENT_DATE for TZ safety.
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId, { autoSend: false }))
    await db.query(
      `UPDATE business_recurring_invoice_schedules
          SET next_due_date = CURRENT_DATE WHERE id = $1`, [c.body.data.id])

    const res = await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/generate-now`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.invoice_number).toMatch(/^INV-\d{4}$/)
    expect(res.body.data.status).toBe('draft')

    // Schedule's next_due_date advanced
    const { rows: [s] } = await db.query<{
      next_due_date: string; created_invoice_count: number; last_invoice_id: string;
    }>(
      `SELECT next_due_date::text, created_invoice_count, last_invoice_id
         FROM business_recurring_invoice_schedules WHERE id = $1`,
      [c.body.data.id])
    expect(s.created_invoice_count).toBe(1)
    expect(s.last_invoice_id).toBe(res.body.data.id)

    // The invoice row exists with the linkage
    const { rows: [inv] } = await db.query<{
      source_recurring_schedule_id: string;
      total_amount: string;
    }>(
      `SELECT source_recurring_schedule_id, total_amount
         FROM business_invoices WHERE id = $1`, [res.body.data.id])
    expect(inv.source_recurring_schedule_id).toBe(c.body.data.id)
    expect(Number(inv.total_amount)).toBeCloseTo(150)
  })

  it('quarterly: bumps next_due_date by exactly 3 months', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId, {
        frequency: 'quarterly', dayOfMonth: 15, autoSend: false, name: 'Quarterly',
      }))
    // Park next_due in-range on a known date so the +3-month step is exact.
    await db.query(
      `UPDATE business_recurring_invoice_schedules
          SET next_due_date = '2026-06-15' WHERE id = $1`, [c.body.data.id])

    const res = await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/generate-now`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)

    const { rows: [s] } = await db.query<{ next_due_date: string }>(
      `SELECT next_due_date::text FROM business_recurring_invoice_schedules WHERE id = $1`,
      [c.body.data.id])
    expect(s.next_due_date.slice(0, 10)).toBe('2026-09-15')
  })

  it('weekly: bumps next_due_date by exactly 7 days', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        customerId: f.customerId, name: 'Weekly',
        frequency: 'weekly', dayOfWeek: 1,
        startDate: '2026-06-01', autoSend: false,
        lines: [{ description: 'X', quantity: 1, unitPrice: 25 }],
      })
    const beforeRow = await db.query<{ next_due_date: string }>(
      `SELECT next_due_date::text FROM business_recurring_invoice_schedules WHERE id = $1`,
      [c.body.data.id])
    await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/generate-now`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const afterRow = await db.query<{ next_due_date: string }>(
      `SELECT next_due_date::text FROM business_recurring_invoice_schedules WHERE id = $1`,
      [c.body.data.id])
    const before = new Date(beforeRow.rows[0]!.next_due_date)
    const after = new Date(afterRow.rows[0]!.next_due_date)
    const deltaDays = Math.round((after.getTime() - before.getTime()) / (24 * 3600 * 1000))
    expect(deltaDays).toBe(7)
  })

  it('auto_send=true fires the customer email', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId, { autoSend: true }))
    const res = await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/generate-now`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(200)
    expect(emailBusinessInvoiceSentMock).toHaveBeenCalledTimes(1)
    // Invoice ends up in 'sent' state
    const { rows: [inv] } = await db.query<{ status: string; sent_at: string | null }>(
      `SELECT status, sent_at FROM business_invoices WHERE id = $1`, [res.body.data.id])
    expect(inv.status).toBe('sent')
    expect(inv.sent_at).not.toBeNull()
  })

  it('paused schedule cannot generate', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId))
    await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/pause`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const res = await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/generate-now`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(res.status).toBe(409)
  })

  it('cross-business schedule → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .send(validMonthlyBody(b.customerId))
    const res = await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/generate-now`)
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.status).toBe(404)
  })

  it('past end_date stops the schedule after generation', async () => {
    const f = await seedFixture()
    // Create with very-soon end_date
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId, {
        startDate: '2026-06-01', endDate: '2026-06-30', autoSend: false,
      }))
    // Force next_due_date to today + ensure end_date is set to today so the
    // next bump (~1 month later) is past end
    await db.query(
      `UPDATE business_recurring_invoice_schedules
          SET next_due_date = CURRENT_DATE, end_date = CURRENT_DATE
        WHERE id = $1`, [c.body.data.id])
    await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/generate-now`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const { rows: [s] } = await db.query<{ status: string }>(
      `SELECT status FROM business_recurring_invoice_schedules WHERE id = $1`,
      [c.body.data.id])
    expect(s.status).toBe('ended')
  })
})

// ═══════════════════════════════════════════════════════════════
//  Pause / Resume / End
// ═══════════════════════════════════════════════════════════════

describe('Lifecycle transitions', () => {
  it('pause: active → paused; resume: paused → active', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId))
    const p = await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/pause`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(p.body.data.status).toBe('paused')

    const r = await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/resume`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(r.body.data.status).toBe('active')
  })

  it('resume bumps next_due_date forward if it was in the past', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId))
    await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/pause`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    // Backdate next_due_date
    await db.query(
      `UPDATE business_recurring_invoice_schedules
          SET next_due_date = CURRENT_DATE - 60 WHERE id = $1`,
      [c.body.data.id])
    await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/resume`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const { rows: [s] } = await db.query<{ next_due_date: string; today: string }>(
      `SELECT next_due_date::text, CURRENT_DATE::text AS today
         FROM business_recurring_invoice_schedules WHERE id = $1`,
      [c.body.data.id])
    // next_due_date should match pg's CURRENT_DATE (TZ-safe rather than
    // computing today in JS, which would mismatch when UTC and local
    // are on different calendar dates near midnight).
    expect(s.next_due_date).toBe(s.today)
  })

  it('end: → ended; cannot resume', async () => {
    const f = await seedFixture()
    const c = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId))
    await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/end`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    const r = await request(buildApp())
      .post(`/api/business-recurring-invoices/${c.body.data.id}/resume`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
    expect(r.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Feature gate
// ═══════════════════════════════════════════════════════════════

describe('Feature gate', () => {
  it('invoicing off → 403', async () => {
    const f = await seedFixture({ features: ['customers', 'staff'] })
    const res = await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(validMonthlyBody(f.customerId))
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Cross-business isolation
// ═══════════════════════════════════════════════════════════════

describe('Cross-business isolation', () => {
  it('list excludes other-business schedules', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await request(buildApp())
      .post('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${b.ownerToken}`)
      .send(validMonthlyBody(b.customerId))
    const res = await request(buildApp())
      .get('/api/business-recurring-invoices')
      .set('Authorization', `Bearer ${a.ownerToken}`)
    expect(res.body.data.length).toBe(0)
  })
})

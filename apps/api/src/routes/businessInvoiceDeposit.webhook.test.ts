/**
 * S511 — business-invoice deposit / two-stage payment via the Stripe webhook.
 *
 * Fires simulated checkout.session.completed events and asserts the ledger +
 * invoice recompute: a deposit payment keeps the invoice 'sent' with the
 * balance still due; the balance payment flips it to 'paid'. Re-delivery of a
 * session is idempotent (amount_paid is an additive SUM — a double credit would
 * corrupt the balance).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) =>
    JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr' })) }
    this.paymentIntents = { create: vi.fn(), retrieve: vi.fn() }
    this.paymentMethods = { retrieve: vi.fn() }
  }
  return { default: FakeStripe }
})

import { webhooksRouter } from './webhooks'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test'
})

async function seedInvoice(opts: { total: number; deposit: number; depositType?: string | null }) {
  const email = `o-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'business_owner', 'B', 'O', TRUE) RETURNING id`, [email])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1, 'Acme', 'trash_hauling', $2) RETURNING id`, [u.id, email])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name, street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe', '100 Elm', 'Mesa', 'AZ', '85201') RETURNING id`, [b.id])
  const { rows: [inv] } = await db.query<{ id: string }>(
    `INSERT INTO business_invoices
       (business_id, customer_id, invoice_number, status, issue_date, due_date,
        subtotal, tax_amount, total_amount, amount_paid, sent_at,
        deposit_amount, deposit_type)
     VALUES ($1, $2, 'INV-0001', 'sent', CURRENT_DATE, CURRENT_DATE,
             $3, 0, $3, 0, NOW(), $4, $5)
     RETURNING id`,
    [b.id, c.id, opts.total, opts.deposit, opts.depositType ?? null])
  return { businessId: b.id, invoiceId: inv.id }
}

function checkoutCompleted(opts: {
  invoiceId?: string; amount: number; kind: string; sessionId: string; pi: string
}): string {
  return JSON.stringify({
    id: 'evt_' + opts.sessionId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: opts.sessionId,
        amount_total: Math.round(opts.amount * 100),
        payment_intent: opts.pi,
        customer: null,
        metadata: {
          gam_purpose: 'business_invoice',
          ...(opts.invoiceId ? { business_invoice_id: opts.invoiceId } : {}),
          payment_kind: opts.kind,
        },
      },
    },
  })
}

async function fire(body: string) {
  return request(buildApp())
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'sig')
    .send(body)
}

async function readInvoice(id: string) {
  const { rows: [r] } = await db.query<any>(
    `SELECT status, amount_paid::float8 AS amount_paid, deposit_paid_at, paid_at
       FROM business_invoices WHERE id = $1`, [id])
  return r
}
async function paymentCount(id: string) {
  const { rows: [r] } = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM business_invoice_payments WHERE invoice_id = $1`, [id])
  return Number(r.n)
}

describe('deposit → balance two-stage payment', () => {
  it('deposit payment keeps invoice sent + balance due; stamps deposit_paid_at', async () => {
    const { invoiceId } = await seedInvoice({ total: 1000, deposit: 300, depositType: 'service' })
    const res = await fire(checkoutCompleted({ invoiceId, amount: 300, kind: 'deposit', sessionId: 'cs_dep', pi: 'pi_dep' }))
    expect(res.status).toBe(200)
    const inv = await readInvoice(invoiceId)
    expect(inv.amount_paid).toBeCloseTo(300)
    expect(inv.status).toBe('sent')
    expect(inv.deposit_paid_at).not.toBeNull()
    expect(inv.paid_at).toBeNull()
    expect(await paymentCount(invoiceId)).toBe(1)
  })

  it('balance payment after deposit flips to paid', async () => {
    const { invoiceId } = await seedInvoice({ total: 1000, deposit: 300, depositType: 'service' })
    await fire(checkoutCompleted({ invoiceId, amount: 300, kind: 'deposit', sessionId: 'cs_dep', pi: 'pi_dep' }))
    await fire(checkoutCompleted({ invoiceId, amount: 700, kind: 'balance', sessionId: 'cs_bal', pi: 'pi_bal' }))
    const inv = await readInvoice(invoiceId)
    expect(inv.amount_paid).toBeCloseTo(1000)
    expect(inv.status).toBe('paid')
    expect(inv.paid_at).not.toBeNull()
    expect(await paymentCount(invoiceId)).toBe(2)
  })

  it('re-delivering the same session is idempotent (no double credit)', async () => {
    const { invoiceId } = await seedInvoice({ total: 1000, deposit: 300, depositType: 'service' })
    const ev = checkoutCompleted({ invoiceId, amount: 300, kind: 'deposit', sessionId: 'cs_dep', pi: 'pi_dep' })
    await fire(ev)
    const dup = await fire(ev)
    expect(dup.status).toBe(200)
    const inv = await readInvoice(invoiceId)
    expect(inv.amount_paid).toBeCloseTo(300) // not 600
    expect(await paymentCount(invoiceId)).toBe(1)
  })

  it('no-deposit full payment flips straight to paid', async () => {
    const { invoiceId } = await seedInvoice({ total: 500, deposit: 0, depositType: null })
    await fire(checkoutCompleted({ invoiceId, amount: 500, kind: 'full', sessionId: 'cs_full', pi: 'pi_full' }))
    const inv = await readInvoice(invoiceId)
    expect(inv.amount_paid).toBeCloseTo(500)
    expect(inv.status).toBe('paid')
  })

  it('unknown invoice id → 200 no-op, no ledger row', async () => {
    const res = await fire(checkoutCompleted({ invoiceId: randomUUID(), amount: 300, kind: 'deposit', sessionId: 'cs_x', pi: 'pi_x' }))
    expect(res.status).toBe(200)
    const { rows: [r] } = await db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM business_invoice_payments`)
    expect(Number(r.n)).toBe(0)
  })
})

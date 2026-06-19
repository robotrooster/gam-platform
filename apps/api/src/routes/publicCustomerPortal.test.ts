/**
 * S502 — customer self-service portal (public, token-scoped).
 *
 * Covers: account view (history + balance, draft/void hidden, payable flag),
 * bad-token fail-closed, and the pay endpoint reusing the hosted link / 409 on
 * a non-open invoice. The Stripe-mint branch mirrors the tested invoice-send
 * path and is not re-exercised here.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { publicCustomerPortalRouter } from './publicCustomerPortal'
import { getOrCreateCustomerPortalToken } from '../services/customerPortalTokens'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/public', publicCustomerPortalRouter)
  app.use(errorHandler)
  return app
}

let n = 0
async function seed() {
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`, [email])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Acme Hauling', 'trash_hauling', $2, ARRAY['customers','invoicing']) RETURNING id`,
    [u.id, email])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers (business_id, customer_type, first_name, last_name, street1, city, state, zip, email)
     VALUES ($1, 'individual', 'Jane', 'Doe', '1 Elm', 'Phoenix', 'AZ', '85001', 'jane@cust.dev') RETURNING id`,
    [b.id])
  return { businessId: b.id, customerId: c.id }
}

async function addInvoice(businessId: string, customerId: string, opts: {
  status: string; total: number; paid?: number; hostedPayUrl?: string | null;
}) {
  n += 1
  // Satisfy the status-audit CHECKs: sent/paid need sent_at, paid needs
  // paid_at, void needs voided_at.
  const sentAt = ['sent', 'paid'].includes(opts.status) ? 'now()' : 'NULL'
  const paidAt = opts.status === 'paid' ? 'now()' : 'NULL'
  const voidedAt = opts.status === 'void' ? 'now()' : 'NULL'
  const { rows: [i] } = await db.query<{ id: string }>(
    `INSERT INTO business_invoices
       (business_id, customer_id, invoice_number, status, issue_date, due_date,
        subtotal, tax_amount, total_amount, amount_paid, hosted_pay_url,
        sent_at, paid_at, voided_at)
     VALUES ($1, $2, $3, $4, '2026-06-14', '2026-07-14',
        $5, 0, $5, $6, $7, ${sentAt}, ${paidAt}, ${voidedAt}) RETURNING id`,
    [businessId, customerId, `INV-${n}`, opts.status, opts.total, opts.paid ?? 0, opts.hostedPayUrl ?? null])
  return i.id
}

beforeEach(async () => { await cleanupAllSchema() })

describe('GET /api/public/customer/:token', () => {
  it('returns the account: balance + invoices, draft/void hidden, payable flagged', async () => {
    const { businessId, customerId } = await seed()
    await addInvoice(businessId, customerId, { status: 'draft', total: 999 })   // hidden
    await addInvoice(businessId, customerId, { status: 'void', total: 999 })    // hidden
    await addInvoice(businessId, customerId, { status: 'sent', total: 100, hostedPayUrl: 'https://pay/x' })
    await addInvoice(businessId, customerId, { status: 'paid', total: 50, paid: 50 })
    const { token } = await getOrCreateCustomerPortalToken({ businessId, customerId })

    const res = await request(buildApp()).get(`/api/public/customer/${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.business.name).toBe('Acme Hauling')
    expect(res.body.data.customer.name).toBe('Jane Doe')
    expect(res.body.data.invoices).toHaveLength(2) // draft + void excluded
    expect(res.body.data.outstanding).toBeCloseTo(100)
    const sent = res.body.data.invoices.find((i: any) => i.status === 'sent')
    expect(sent.payable).toBe(true)
    expect(sent.amountDue).toBeCloseTo(100)
    const paid = res.body.data.invoices.find((i: any) => i.status === 'paid')
    expect(paid.payable).toBe(false)
  })

  it('a sent invoice with a partial payment shows the remaining balance', async () => {
    const { businessId, customerId } = await seed()
    await addInvoice(businessId, customerId, { status: 'sent', total: 100, paid: 30, hostedPayUrl: 'https://pay/x' })
    const { token } = await getOrCreateCustomerPortalToken({ businessId, customerId })
    const res = await request(buildApp()).get(`/api/public/customer/${token}`)
    expect(res.body.data.outstanding).toBeCloseTo(70)
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp()).get(`/api/public/customer/${'a'.repeat(64)}`)
    expect(res.status).toBe(404)
  })

  it('revoked token → 404 (fails closed)', async () => {
    const { businessId, customerId } = await seed()
    const { token } = await getOrCreateCustomerPortalToken({ businessId, customerId })
    await db.query(`UPDATE business_customer_portal_tokens SET revoked_at = now() WHERE token = $1`, [token])
    const res = await request(buildApp()).get(`/api/public/customer/${token}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/public/customer/:token/invoices/:id/pay', () => {
  it('returns the existing hosted pay link for an open invoice', async () => {
    const { businessId, customerId } = await seed()
    const invId = await addInvoice(businessId, customerId, { status: 'sent', total: 100, hostedPayUrl: 'https://pay/already' })
    const { token } = await getOrCreateCustomerPortalToken({ businessId, customerId })
    const res = await request(buildApp()).post(`/api/public/customer/${token}/invoices/${invId}/pay`)
    expect(res.status).toBe(200)
    expect(res.body.data.hostedUrl).toBe('https://pay/already')
  })

  it('a paid invoice is not open for payment → 409', async () => {
    const { businessId, customerId } = await seed()
    const invId = await addInvoice(businessId, customerId, { status: 'paid', total: 100, paid: 100 })
    const { token } = await getOrCreateCustomerPortalToken({ businessId, customerId })
    const res = await request(buildApp()).post(`/api/public/customer/${token}/invoices/${invId}/pay`)
    expect(res.status).toBe(409)
  })

  it('cannot pay another customer’s invoice through this token → 404', async () => {
    const a = await seed()
    const b = await seed()
    const otherInv = await addInvoice(b.businessId, b.customerId, { status: 'sent', total: 100, hostedPayUrl: 'https://pay/x' })
    const { token } = await getOrCreateCustomerPortalToken({ businessId: a.businessId, customerId: a.customerId })
    const res = await request(buildApp()).post(`/api/public/customer/${token}/invoices/${otherInv}/pay`)
    expect(res.status).toBe(404)
  })
})

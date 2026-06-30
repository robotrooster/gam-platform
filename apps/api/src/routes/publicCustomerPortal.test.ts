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
  deposit?: number; depositType?: 'service' | 'materials' | null;
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
        deposit_amount, deposit_type,
        sent_at, paid_at, voided_at)
     VALUES ($1, $2, $3, $4, '2026-06-14', '2026-07-14',
        $5, 0, $5, $6, $7, $8, $9, ${sentAt}, ${paidAt}, ${voidedAt}) RETURNING id`,
    [businessId, customerId, `INV-${n}`, opts.status, opts.total, opts.paid ?? 0,
     opts.hostedPayUrl ?? null, opts.deposit ?? 0, opts.depositType ?? null])
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

  it('S511: a deposit invoice exposes deposit fields + amount-due-now (deposit first)', async () => {
    const { businessId, customerId } = await seed()
    await addInvoice(businessId, customerId, { status: 'sent', total: 1000, paid: 0, deposit: 300, depositType: 'materials' })
    const { token } = await getOrCreateCustomerPortalToken({ businessId, customerId })
    const res = await request(buildApp()).get(`/api/public/customer/${token}`)
    const inv = res.body.data.invoices[0]
    expect(inv.depositAmount).toBeCloseTo(300)
    expect(inv.depositType).toBe('materials')
    expect(inv.depositPaid).toBe(false)
    expect(inv.nextPaymentKind).toBe('deposit')
    expect(inv.amountDueNow).toBeCloseTo(300)
  })

  it('S511: after the deposit is covered, amount-due-now is the balance', async () => {
    const { businessId, customerId } = await seed()
    await addInvoice(businessId, customerId, { status: 'sent', total: 1000, paid: 300, deposit: 300, depositType: 'service' })
    const { token } = await getOrCreateCustomerPortalToken({ businessId, customerId })
    const res = await request(buildApp()).get(`/api/public/customer/${token}`)
    const inv = res.body.data.invoices[0]
    expect(inv.depositPaid).toBe(true)
    expect(inv.nextPaymentKind).toBe('balance')
    expect(inv.amountDueNow).toBeCloseTo(700)
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

async function addAppointment(businessId: string, customerId: string, opts: {
  status: string; scheduledFor: string; completedAt?: string | null;
}) {
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO appointments (business_id, customer_id, service_type, scheduled_for, status, completed_at)
     VALUES ($1, $2, 'pickup', $3::timestamptz, $4, $5::timestamptz) RETURNING id`,
    [businessId, customerId, opts.scheduledFor, opts.status, opts.completedAt ?? null])
  return a.id
}

/** Attach a skipped route_stop (with reason + departure time) to an appointment. */
async function addSkippedStop(businessId: string, apptId: string, opts: { reason: string; departedAt: string }) {
  const { rows: [d] } = await db.query<{ id: string }>(
    `INSERT INTO depots (business_id, name, street1, city, state, zip, lat, lon)
     VALUES ($1, 'Yard', '1 Yard', 'Phoenix', 'AZ', '85001', 33.4, -112.0) RETURNING id`, [businessId])
  const { rows: [v] } = await db.query<{ id: string }>(
    `INSERT INTO vehicles (business_id, home_depot_id, name) VALUES ($1, $2, 'Truck 1') RETURNING id`, [businessId, d.id])
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO generated_routes
       (business_id, vehicle_id, depot_id, generated_for_date, start_at_planned,
        status, started_at, total_miles, total_minutes, stop_count, dump_count)
     VALUES ($1, $2, $3, '2026-06-19', '2026-06-19T15:00:00Z', 'in_progress',
             '2026-06-19T15:00:00Z', 1, 10, 1, 0) RETURNING id`, [businessId, v.id, d.id])
  await db.query(
    `INSERT INTO route_stops
       (route_id, sequence_order, stop_kind, appointment_id, estimated_arrival,
        estimated_departure, status, driver_notes, actual_departure)
     VALUES ($1, 1, 'customer', $2, '2026-06-19T15:10:00Z', '2026-06-19T15:15:00Z',
             'skipped', $3, $4::timestamptz)`, [r.id, apptId, opts.reason, opts.departedAt])
}

describe('GET /api/public/customer/:token/service', () => {
  it('reports completed / skipped / scheduled with timestamps + skip reason', async () => {
    const { businessId, customerId } = await seed()
    await addAppointment(businessId, customerId, { status: 'completed', scheduledFor: '2026-06-20T15:00:00Z', completedAt: '2026-06-20T15:11:00Z' })
    const skipAppt = await addAppointment(businessId, customerId, { status: 'no_show', scheduledFor: '2026-06-19T15:00:00Z' })
    await addSkippedStop(businessId, skipAppt, { reason: 'Gate locked', departedAt: '2026-06-19T15:20:00Z' })
    await addAppointment(businessId, customerId, { status: 'scheduled', scheduledFor: '2026-06-25T15:00:00Z' })
    const { token } = await getOrCreateCustomerPortalToken({ businessId, customerId })

    const res = await request(buildApp()).get(`/api/public/customer/${token}/service`)
    expect(res.status).toBe(200)
    const appts = res.body.data.appointments
    expect(appts).toHaveLength(3)
    expect(appts.find((a: any) => a.state === 'completed').completedAt).toBeTruthy()
    const skipped = appts.find((a: any) => a.state === 'skipped')
    expect(skipped.skipReason).toBe('Gate locked')
    expect(skipped.skippedAt).toBeTruthy()
    expect(appts.find((a: any) => a.state === 'scheduled')).toBeTruthy()
  })

  it('only this customer’s appointments are visible', async () => {
    const a = await seed()
    const b = await seed()
    await addAppointment(b.businessId, b.customerId, { status: 'completed', scheduledFor: '2026-06-20T15:00:00Z', completedAt: '2026-06-20T15:11:00Z' })
    const { token } = await getOrCreateCustomerPortalToken({ businessId: a.businessId, customerId: a.customerId })
    const res = await request(buildApp()).get(`/api/public/customer/${token}/service`)
    expect(res.body.data.appointments).toHaveLength(0)
  })

  it('unknown token → 404', async () => {
    const res = await request(buildApp()).get(`/api/public/customer/${'a'.repeat(64)}/service`)
    expect(res.status).toBe(404)
  })
})

async function setSlug(businessId: string, slug: string) {
  await db.query(`UPDATE businesses SET public_booking_slug = $2 WHERE id = $1`, [businessId, slug])
}

describe('POST /api/public/portal-login/:slug', () => {
  it('a matching email mints a portal token (generic 200)', async () => {
    const { businessId } = await seed()
    await setSlug(businessId, 'acme-hauling')
    const res = await request(buildApp()).post('/api/public/portal-login/acme-hauling').send({ email: 'jane@cust.dev' })
    expect(res.status).toBe(200)
    expect(res.body.data.sent).toBe(true)
    const { rows } = await db.query(`SELECT 1 FROM business_customer_portal_tokens WHERE business_id = $1`, [businessId])
    expect(rows).toHaveLength(1)
  })

  it('a non-matching email still returns 200 but mints nothing (no enumeration)', async () => {
    const { businessId } = await seed()
    await setSlug(businessId, 'acme-hauling')
    const res = await request(buildApp()).post('/api/public/portal-login/acme-hauling').send({ email: 'nobody@nope.dev' })
    expect(res.status).toBe(200)
    const { rows } = await db.query(`SELECT 1 FROM business_customer_portal_tokens WHERE business_id = $1`, [businessId])
    expect(rows).toHaveLength(0)
  })

  it('an unknown slug still returns 200 (no enumeration)', async () => {
    const res = await request(buildApp()).post('/api/public/portal-login/no-such-biz').send({ email: 'jane@cust.dev' })
    expect(res.status).toBe(200)
  })
})

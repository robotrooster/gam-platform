/**
 * S537: FIFO payment application — ONE tenant "Pay now", oldest-first.
 *
 * Rules under test (Nic-locked):
 *   - Every dollar applies to the oldest outstanding balance first; the
 *     tenant never picks targets (POST /payments/pay-balance).
 *   - Partial coverage SPLITS the charge row (propane pattern) so
 *     "short is short" late-fee mechanics stay truthful.
 *   - Landlords may reject partials per property (eviction-clock
 *     protection): amount < total → 422; pay-ahead stays allowed.
 *   - Pay-ahead remainder becomes a lease_prepaid_credit at webhook
 *     settle, and the next invoice generation consumes it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

// pay-balance creates real Stripe charges — stub the charge creators and
// the raw SDK (card-country lookup). ACH path never touches getStripe.
vi.mock('../services/stripeConnect', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createRentDestinationCharge: vi.fn(async () => ({ id: 'pi_fifo_test', status: 'processing' })),
    createRentPlatformCharge:    vi.fn(async () => ({ id: 'pi_fifo_test', status: 'processing' })),
  }
})
vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) =>
    JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.paymentMethods = { retrieve: vi.fn(async () => ({ card: { country: 'US' } })) }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_mock' })) }
  }
  return { default: FakeStripe }
})

import { paymentsRouter } from './payments'
import { webhooksRouter } from './webhooks'

function buildApp() {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use(express.json())
  app.use('/api/payments', paymentsRouter)
  app.use('/webhooks', webhooksRouter)
  app.use(errorHandler)
  return app
}

function tenantToken(userId: string, tenantId: string) {
  return jwt.sign({ userId, role: 'tenant', profileId: tenantId },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

async function fixture(opts: { acceptPartials?: boolean } = {}) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    if (opts.acceptPartials === false) {
      await client.query(`UPDATE properties SET accept_partial_payments = FALSE WHERE id=$1`, [propertyId])
    }
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(client)
    const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
    await client.query(`UPDATE tenants SET stripe_customer_id='cus_test_fifo' WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, { unitId, landlordId: ll.landlordId, rentAmount: 440 })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    return { ...ll, propertyId, unitId, tenantId, tenantUserId: tu.rows[0].user_id, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function seedCharge(f: any, type: string, amount: number, dueDate: string): Promise<string> {
  const desc = type === 'late_fee' ? 'LATEFEE' : 'RENT'
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8) RETURNING id`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, type, amount.toFixed(2), dueDate, desc])
  return r.rows[0].id
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_fifo'
})

describe('S537 POST /payments/pay-balance — FIFO application', () => {
  it('oldest first: old late fee consumed in full, rent row split, remainder stays pending', async () => {
    const f = await fixture()
    const feeId = await seedCharge(f, 'late_fee', 60, '2026-06-06')
    const rentId = await seedCharge(f, 'rent', 440, '2026-07-01')
    // FAILED rows are still owed — they join the FIFO set (oldest of all).
    const failedId = await seedCharge(f, 'rent', 40, '2026-05-01')
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_old_fail' WHERE id=$1`, [failedId])

    const res = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 480, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(res.body.data.appliedTotal).toBe(480)
    expect(res.body.data.payAhead).toBe(0)

    // The failed May rent is the OLDEST — covered first, back to processing.
    const failed = await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [failedId])
    expect(failed.rows[0].status).toBe('processing')
    expect(failed.rows[0].stripe_payment_intent_id).toBe('pi_fifo_test')

    const fee = await db.query<any>(`SELECT status, amount::float AS amount, stripe_payment_intent_id FROM payments WHERE id=$1`, [feeId])
    expect(fee.rows[0].status).toBe('processing')
    expect(fee.rows[0].amount).toBe(60)
    expect(fee.rows[0].stripe_payment_intent_id).toBe('pi_fifo_test')

    // Rent row split: applied slice ($380) carries the PI; remainder ($60)
    // is a fresh pending row — "short is short" stays truthful.
    const rent = await db.query<any>(`SELECT status, amount::float AS amount FROM payments WHERE id=$1`, [rentId])
    expect(rent.rows[0].status).toBe('processing')
    expect(rent.rows[0].amount).toBe(380)
    const remainder = await db.query<any>(
      `SELECT amount::float AS amount, status, is_remainder FROM payments
        WHERE lease_id=$1 AND type='rent' AND is_remainder`, [f.leaseId])
    expect(remainder.rows.length).toBe(1)
    expect(remainder.rows[0].amount).toBe(60)
    expect(remainder.rows[0].status).toBe('pending')
    expect(remainder.rows[0].is_remainder).toBe(true)

    const lines = await db.query<any>(
      `SELECT amount_applied::float AS a FROM remittance_applications ORDER BY a`)
    expect(lines.rows.map((r: any) => r.a)).toEqual([40, 60, 380])
  })

  it('property rejects partials → 422 under total; exact total passes', async () => {
    const f = await fixture({ acceptPartials: false })
    await seedCharge(f, 'late_fee', 60, '2026-06-06')
    await seedCharge(f, 'rent', 440, '2026-07-01')

    const short = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 100, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(short.status).toBe(422)
    expect(short.body.error).toMatch(/full outstanding balance/i)

    const full = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 500, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(full.status).toBe(200)
  })

  it('pay-ahead: webhook settle banks the remainder as a prepaid credit', async () => {
    const f = await fixture()
    const feeId = await seedCharge(f, 'late_fee', 100, '2026-06-06')

    const app = buildApp()
    const res = await request(app)
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 150, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(res.body.data.payAhead).toBe(50)
    const remittanceId = res.body.data.remittanceId

    const event = {
      type: 'payment_intent.succeeded',
      data: { object: {
        id: 'pi_fifo_test',
        metadata: { gam_remittance_id: remittanceId, tenant_id: f.tenantId, landlord_id: f.landlordId },
        charges: { data: [{ id: 'ch_mock', payment_method_details: { type: 'us_bank_account' } }] },
      } },
    }
    const hook = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'sig_mock')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event))
    expect(hook.status).toBe(200)

    const fee = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [feeId])
    expect(fee.rows[0].status).toBe('settled')
    const rem = await db.query<any>(`SELECT status FROM tenant_remittances WHERE id=$1`, [remittanceId])
    expect(rem.rows[0].status).toBe('settled')
    const credit = await db.query<any>(
      `SELECT amount_remaining::float AS remaining FROM lease_prepaid_credits WHERE lease_id=$1`, [f.leaseId])
    expect(credit.rows.length).toBe(1)
    expect(credit.rows[0].remaining).toBe(50)
  })

  it('invoice generation consumes prepaid credit oldest-first', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining)
       VALUES ($1, $2, 100, 100)`, [f.leaseId, f.tenantId])
    // Lease due today so generation fires now.
    const today = new Date()
    await db.query(`UPDATE leases SET rent_due_day = $2, start_date = '2026-01-01' WHERE id=$1`,
      [f.leaseId, Math.min(today.getUTCDate(), 28)])

    const { generateInvoices } = await import('../jobs/invoiceGeneration')
    const result = await generateInvoices()
    expect(result.invoicesInserted).toBeGreaterThanOrEqual(1)

    // $100 credit against the generated rent: a $100 slice settled via
    // credit, its $340 remainder pending, credit fully drawn. (Generation
    // may produce more than one invoice depending on the lease window —
    // assert the credit-specific rows rather than a global count.)
    const settled = await db.query<any>(
      `SELECT amount::float AS amount FROM payments
        WHERE lease_id=$1 AND type='rent' AND status='settled'`, [f.leaseId])
    expect(settled.rows.map((r: any) => r.amount)).toEqual([100])
    const remainder = await db.query<any>(
      `SELECT amount::float AS amount FROM payments
        WHERE lease_id=$1 AND type='rent' AND status='pending' AND is_remainder`, [f.leaseId])
    expect(remainder.rows.map((r: any) => r.amount)).toEqual([340])
    const credit = await db.query<any>(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE lease_id=$1`, [f.leaseId])
    expect(credit.rows[0].r).toBe(0)
  })
})

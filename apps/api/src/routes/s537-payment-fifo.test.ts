/**
 * S537: FIFO payment application — ONE tenant "Pay now", oldest-first.
 *
 * Rules under test (Nic-locked):
 *   - PAY-IN-FULL ONLY. There are no partial payments anywhere in the system
 *     (a partial can reset a landlord's eviction clock). /pay-balance requires
 *     the EXACT outstanding balance — under- OR over-payment → 422.
 *   - Every dollar applies to the oldest outstanding balance first; the
 *     tenant never picks targets, and the full-balance payment settles all
 *     rows with no split and no remainder.
 *   - (Prepaid credits still exist via invoice generation, but pay-ahead is
 *     gone — the tenant UI has no amount field.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import * as stripeConnect from '../services/stripeConnect'

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

async function fixture() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
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
  ;(stripeConnect.createRentPlatformCharge as any).mockClear()
})

// S562: the lump pay-balance charge must include the tenant-borne processing
// fee (else GAM eats Stripe's cost on every FIFO payment). Fee computed once on
// the whole lump (single capped ACH transaction), resolved from the first row's
// property allocation rule.
describe('S562 POST /payments/pay-balance — processing-fee collection', () => {
  async function ruleFixture(ach: 'tenant' | 'landlord') {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const ll = await seedLandlord(client)
      const propertyId = await seedProperty(client, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      await seedAllocationRule(client, { propertyId, achFeePayer: ach, cardFeePayer: 'tenant' })
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

  it('tenant pays fee → lump charge = balance + flat $6 ACH fee', async () => {
    const f = await ruleFixture('tenant')
    await seedCharge(f, 'rent', 440, '2026-07-01')
    const res = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 440, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    // S600: ACH is a FLAT $6.00 — the old 1%-capped-at-$6 formula is retired.
    // 440 + 6.00 = 446.00
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBeCloseTo(446.00, 2)
  })

  it('landlord pays fee → lump charge = balance only', async () => {
    const f = await ruleFixture('landlord')
    await seedCharge(f, 'rent', 440, '2026-07-01')
    const res = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 440, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0].amount).toBeCloseTo(440, 2)
  })
})

describe('S537 POST /payments/pay-balance — FIFO application', () => {
  it('oldest-first: paying the FULL balance settles every row (pay-in-full, no split)', async () => {
    const f = await fixture()
    const feeId = await seedCharge(f, 'late_fee', 60, '2026-06-06')
    const rentId = await seedCharge(f, 'rent', 440, '2026-07-01')
    // FAILED rows are still owed — they join the FIFO set (oldest of all).
    const failedId = await seedCharge(f, 'rent', 40, '2026-05-01')
    await db.query(`UPDATE payments SET status='failed', stripe_payment_intent_id='pi_old_fail' WHERE id=$1`, [failedId])

    // Pay-in-full only: the tenant pays the ENTIRE balance (40 + 60 + 440 = 540).
    const res = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 540, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)
    expect(res.body.data.appliedTotal).toBe(540)
    expect(res.body.data.payAhead).toBe(0)

    // Every row (oldest-first) carries the PI — none split, none left pending.
    for (const id of [failedId, feeId, rentId]) {
      const row = await db.query<any>(`SELECT status, amount::float AS amount, stripe_payment_intent_id FROM payments WHERE id=$1`, [id])
      expect(row.rows[0].status).toBe('processing')
      expect(row.rows[0].stripe_payment_intent_id).toBe('pi_fifo_test')
    }
    // Rent stays whole ($440) — no remainder row exists.
    const rent = await db.query<any>(`SELECT amount::float AS amount FROM payments WHERE id=$1`, [rentId])
    expect(rent.rows[0].amount).toBe(440)
    const remainder = await db.query<any>(
      `SELECT 1 FROM payments WHERE lease_id=$1 AND is_remainder`, [f.leaseId])
    expect(remainder.rows.length).toBe(0)

    const lines = await db.query<any>(
      `SELECT amount_applied::float AS a FROM remittance_applications ORDER BY a`)
    expect(lines.rows.map((r: any) => r.a)).toEqual([40, 60, 440])
  })

  it('pay-in-full enforced: under-payment AND over-payment both → 422; exact total passes', async () => {
    const f = await fixture()
    await seedCharge(f, 'late_fee', 60, '2026-06-06')
    await seedCharge(f, 'rent', 440, '2026-07-01')  // total = 500

    const under = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 100, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(under.status).toBe(422)
    expect(under.body.error).toMatch(/paid in full/i)

    // No pay-ahead either — over the balance is rejected too.
    const over = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 600, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(over.status).toBe(422)
    expect(over.body.error).toMatch(/paid in full/i)

    const full = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 500, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(full.status).toBe(200)
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

// S581 (Nic): ONE lease per charge. A tenant with balances on two leases (an
// overlap move, or two different landlords) pays each lease as its OWN charge +
// receipt — separate ACH means a shortfall/eviction-hold on one never blocks the
// other, and the capped processing fee is charged per lease (no shared-bank-
// account fee dodge).
describe('S581 POST /payments/pay-balance — per-lease charges', () => {
  // One tenant, TWO landlords, one lease each: the strongest separation case.
  async function twoLeaseFixture() {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const tenantId = await seedTenant(client)
      const tu = await client.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await client.query(`UPDATE tenants SET stripe_customer_id='cus_test_multi' WHERE id=$1`, [tenantId])

      const a = await seedLandlord(client)
      const propA = await seedProperty(client, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
      const unitA = await seedUnit(client, { propertyId: propA, landlordId: a.landlordId, withLateFeeDecision: true })
      const leaseA = await seedLease(client, { unitId: unitA, landlordId: a.landlordId, rentAmount: 440 })
      await seedLeaseTenant(client, { leaseId: leaseA, tenantId })

      const b = await seedLandlord(client)
      const propB = await seedProperty(client, { landlordId: b.landlordId, ownerUserId: b.userId, managedByUserId: b.userId })
      const unitB = await seedUnit(client, { propertyId: propB, landlordId: b.landlordId, withLateFeeDecision: true })
      const leaseB = await seedLease(client, { unitId: unitB, landlordId: b.landlordId, rentAmount: 300 })
      await seedLeaseTenant(client, { leaseId: leaseB, tenantId })
      await client.query('COMMIT')
      return {
        tenantId, tenantUserId: tu.rows[0].user_id,
        A: { landlordId: a.landlordId, unitId: unitA, leaseId: leaseA },
        B: { landlordId: b.landlordId, unitId: unitB, leaseId: leaseB },
      }
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }

  async function chargeFor(g: any, tenantId: string, amount: number, dueDate: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, 'rent', $5, 'pending', $6, 'RENT') RETURNING id`,
      [g.unitId, g.leaseId, tenantId, g.landlordId, amount.toFixed(2), dueDate])
    return r.rows[0].id
  }

  it('refuses to pay when the tenant spans two leases without choosing one', async () => {
    const f = await twoLeaseFixture()
    await chargeFor(f.A, f.tenantId, 440, '2026-07-01')
    await chargeFor(f.B, f.tenantId, 300, '2026-07-01')
    const res = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 440, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/more than one lease/i)
  })

  it('leaseId scopes the charge to ONE lease; the other lease is untouched', async () => {
    const f = await twoLeaseFixture()
    const aId = await chargeFor(f.A, f.tenantId, 440, '2026-07-01')
    const bId = await chargeFor(f.B, f.tenantId, 300, '2026-07-01')

    const res = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 440, leaseId: f.A.leaseId, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(res.status).toBe(200)

    // Lease A charged; lease B still fully pending, no PI.
    const aRow = await db.query<any>(`SELECT status FROM payments WHERE id=$1`, [aId])
    expect(aRow.rows[0].status).toBe('processing')
    const bRow = await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE id=$1`, [bId])
    expect(bRow.rows[0].status).toBe('pending')
    expect(bRow.rows[0].stripe_payment_intent_id).toBeNull()

    // Exactly one remittance, tied to lease A, for A's balance only.
    const rem = await db.query<any>(`SELECT lease_id, amount::float AS amount FROM tenant_remittances`)
    expect(rem.rows.length).toBe(1)
    expect(rem.rows[0].lease_id).toBe(f.A.leaseId)
    expect(rem.rows[0].amount).toBe(440)
  })

  it('an eviction hold on one landlord’s lease never blocks paying the other', async () => {
    const f = await twoLeaseFixture()
    await chargeFor(f.A, f.tenantId, 440, '2026-07-01')
    await chargeFor(f.B, f.tenantId, 300, '2026-07-01')
    // Landlord A puts their unit in eviction mode.
    await db.query(`UPDATE units SET payment_block=true WHERE id=$1`, [f.A.unitId])

    // balance-context reports the block PER LEASE (checked while both are still
    // outstanding), not globally.
    const ctx = await request(buildApp())
      .get('/api/payments/balance-context')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
    const byLease: Record<string, boolean> = {}
    for (const l of ctx.body.data.leases) byLease[l.leaseId] = l.paymentBlocked
    expect(byLease[f.A.leaseId]).toBe(true)
    expect(byLease[f.B.leaseId]).toBe(false)
    expect(ctx.body.data.paymentBlocked).toBe(false)  // legacy scalar: not ALL blocked

    // Paying A is refused; paying B still goes through.
    const blocked = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 440, leaseId: f.A.leaseId, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toMatch(/eviction/i)

    const ok = await request(buildApp())
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 300, leaseId: f.B.leaseId, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })
    expect(ok.status).toBe(200)
  })
})

// S539: the tenant-facing "where every dollar went" read — remittances
// with their per-line applications + outstanding prepaid credit.
describe('S539 GET /payments/remittances — per-line application display', () => {
  it('returns lines oldest-first with charge context (full-balance payment)', async () => {
    const f = await fixture()
    // Settling a RENT row runs the allocation engine — it needs an
    // allocation rule + active processing rate (unlike the fee-only
    // pay-ahead test above).
    {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await seedAllocationRule(client, { propertyId: f.propertyId })
        // platform_processing_rates survives cleanupAllSchema — guard the
        // insert (suite convention) so repeated runs don't stack rows.
        await client.query(
          `INSERT INTO platform_processing_rates
             (payment_method, customer_facing_flat, customer_facing_percent,
              stripe_cost_flat, stripe_cost_percent)
           SELECT 'ach', 0, 1, 0, 0.5
            WHERE NOT EXISTS (
              SELECT 1 FROM platform_processing_rates
               WHERE payment_method = 'ach' AND effective_until IS NULL)`)
        await client.query('COMMIT')
      } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    }
    await seedCharge(f, 'late_fee', 60, '2026-06-06')
    await seedCharge(f, 'rent', 440, '2026-07-01')

    const app = buildApp()
    const pay = await request(app)
      .post('/api/payments/pay-balance')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
      .send({ amount: 500, paymentMethodId: 'pm_test', paymentMethodType: 'ach' })  // full balance
    expect(pay.status).toBe(200)
    const remittanceId = pay.body.data.remittanceId

    // Settle via webhook so the remittance + its lines finalize.
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: {
        id: 'pi_fifo_test',
        metadata: { gam_remittance_id: remittanceId, tenant_id: f.tenantId, landlord_id: f.landlordId },
        latest_charge: { id: 'ch_mock', payment_method_details: { type: 'us_bank_account' } }, // S560: modern Stripe shape
      } },
    }
    const hook = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'sig_mock')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event))
    expect(hook.status).toBe(200)

    const res = await request(app)
      .get('/api/payments/remittances')
      .set('Authorization', `Bearer ${tenantToken(f.tenantUserId, f.tenantId)}`)
    expect(res.status).toBe(200)

    const { remittances, prepaidRemaining } = res.body.data
    expect(remittances.length).toBe(1)
    const r = remittances[0]
    expect(r.id).toBe(remittanceId)
    expect(r.status).toBe('settled')
    expect(r.amount).toBe(500)
    expect(r.applied_amount).toBe(500)
    expect(r.unapplied_amount).toBe(0)
    // Lines come back oldest-first with the covered charge's context.
    expect(r.lines.map((ln: any) => [ln.type, ln.amount_applied])).toEqual(
      [['late_fee', 60], ['rent', 440]])
    expect(r.lines[0].due_date).toBe('2026-06-06')
    expect(r.lines.every((ln: any) => ln.payment_status === 'settled')).toBe(true)
    expect(prepaidRemaining).toBe(0)
  })

  it('rejects non-tenant callers', async () => {
    const f = await fixture()
    const landlordJwt = jwt.sign({ userId: f.userId, role: 'landlord', profileId: f.landlordId },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .get('/api/payments/remittances')
      .set('Authorization', `Bearer ${landlordJwt}`)
    expect(res.status).toBe(403)
  })
})

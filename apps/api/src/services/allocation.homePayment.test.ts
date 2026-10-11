/**
 * A home payment the tenant pays is split like rent.
 *
 * A park-owned home sold to the household on payments is billed like rent
 * (homeSale.ts). Paid by the tenant's card or bank it lands on GAM's balance;
 * until allocation split it there was no owner share, so the Tuesday batch
 * never paid the landlord for it. Paid at the desk it is the landlord's money
 * already and never pays out.
 *
 * Being split here does not make FlexPay pay it: FlexPay never pays a home
 * payment (decisions #35 point 7(e) — a payment toward owning a home is a
 * real-property interest GAM will not hold a claim in). That rule lives in
 * flexpay's cover, and its test is in flexpay.stripe.test.ts.
 *
 * Driven through the real Stripe webhook (the SDK is mocked, as in
 * routes/webhooks.test.ts) and the real desk settle.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('./email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendNotificationEmail: vi.fn(async () => undefined),
}))

vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_mock' })) }
    this.customers = { retrieve: vi.fn(async () => ({})), update: vi.fn(async () => ({})) }
    this.paymentIntents = { create: vi.fn(async () => ({ id: 'pi_mock' })) }
    this.paymentMethods = { retrieve: vi.fn(async () => ({ id: 'pm_mock' })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
  }
  return { default: FakeStripe }
})

import { webhooksRouter } from '../routes/webhooks'
import { db, getClient } from '../db'
import { settleManualRentPayment } from './manualPaymentSettle'
import { heldOwnerShareForUser } from './landlordPassthrough'
import { executeRentAllocation, ALLOCATABLE_PAYMENT_TYPES } from './allocation'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule,
} from '../test/dbHelpers'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
  await db.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
     VALUES ('ach', 0, 1.0, 0, 0.5)
     ON CONFLICT DO NOTHING`)
})

interface Park { ownerUserId: string; landlordId: string; tenantId: string; unitId: string; leaseId: string }

/** A park, one resident on a lease, the tenant paying the processing fee. */
async function park(): Promise<Park> {
  const c = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 450 })
    const leaseId = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1, $2, 450, 'month_to_month', 'active', '2026-01-01') RETURNING id`, [unitId, landlordId])).rows[0].id
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    return { ownerUserId, landlordId, tenantId, unitId, leaseId }
  } finally { c.release() }
}

/** An open charge on the October bill. */
async function charge(p: Park, a: { type: 'rent' | 'home_payment'; amount: number }): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                           entry_description, revenue_owner, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', '2026-10-01', $7, 'landlord', '2026-09-25T17:00:00Z')
     RETURNING id`,
    [p.unitId, p.leaseId, p.tenantId, p.landlordId, a.type, a.amount, a.type === 'rent' ? 'RENT' : 'HOMEPMT'])).rows[0].id
}

/** The tenant pays these rows by bank: the charge route puts them in flight on GAM's balance. */
async function inFlight(ids: string[], pi: string) {
  await db.query(
    `UPDATE payments SET status = 'processing', platform_held = TRUE, stripe_payment_intent_id = $2
      WHERE id = ANY($1::uuid[])`, [ids, pi])
}

/** Stripe says the bank payment cleared. */
async function cleared(pi: string) {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  const res = await request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stub')
    .send(JSON.stringify({
      id: `evt_${pi}`, type: 'payment_intent.succeeded',
      data: { object: { id: pi, metadata: {}, latest_charge: { id: `ch_${pi}`, payment_method_details: { type: 'us_bank_account' } } } },
    }))
  expect(res.status).toBe(200)
}

const ownerShares = async (paymentId: string) => (await db.query<{ user_id: string; amount: string }>(
  `SELECT user_id, amount::text AS amount FROM user_balance_ledger
    WHERE reference_id = $1 AND reference_type = 'payment' AND type = 'allocation_owner_share'`, [paymentId])).rows

describe('a home payment the tenant pays is split like rent', () => {
  it('home_payment is one of the kinds allocation splits', () => {
    expect(ALLOCATABLE_PAYMENT_TYPES).toContain('home_payment')
  })

  it('a home payment paid by bank books the owner share once and lands in the landlord\'s payout', async () => {
    const p = await park()
    const rent = await charge(p, { type: 'rent', amount: 450 })
    const home = await charge(p, { type: 'home_payment', amount: 200 })
    await inFlight([rent, home], 'pi_home_bank_1')

    await cleared('pi_home_bank_1')
    // Stripe sends the same event again; nothing is booked twice.
    await cleared('pi_home_bank_1')

    const homeShare = await ownerShares(home)
    expect(homeShare).toHaveLength(1)
    expect(homeShare[0]).toMatchObject({ user_id: p.ownerUserId, amount: '200.00' })
    expect(await ownerShares(rent)).toMatchObject([{ user_id: p.ownerUserId, amount: '450.00' }])
    // What the next Tuesday batch can pay this landlord: rent and the home payment.
    expect(await heldOwnerShareForUser(p.ownerUserId)).toBe(650)
    // Running allocation again by hand books nothing more.
    const c = await getClient()
    try { await executeRentAllocation(c, home, 'ach') } finally { c.release() }
    expect(await ownerShares(home)).toHaveLength(1)
    // The processing fee is booked once for the charge, spread over its rows by money.
    const fee = (await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(customer_fee_charged), 0)::text AS total FROM platform_revenue_ledger
        WHERE reference_type = 'payment' AND type = 'banking_spread' AND reference_id = ANY($1::uuid[])`,
      [[rent, home]])).rows[0].total
    const rate = (await db.query<{ flat: string; pct: string; cap: string | null }>(
      `SELECT customer_facing_flat::text AS flat, customer_facing_percent::text AS pct, customer_facing_cap::text AS cap
         FROM platform_processing_rates WHERE payment_method = 'ach' AND effective_until IS NULL`)).rows[0]
    const whole = Math.min(Number(rate.flat) + 650 * Number(rate.pct) / 100, rate.cap == null ? Infinity : Number(rate.cap))
    expect(Number(fee)).toBeCloseTo(Math.round(whole * 100) / 100, 2)
  })

  it('a home payment paid by bank writes no on-time mark of its own; the rent beside it does', async () => {
    const p = await park()
    const rent = await charge(p, { type: 'rent', amount: 450 })
    const home = await charge(p, { type: 'home_payment', amount: 200 })
    await inFlight([rent, home], 'pi_home_bank_2')
    await cleared('pi_home_bank_2')
    const marks = (await db.query<{ payment_id: string }>(
      `SELECT ce.event_data->>'payment_id' AS payment_id FROM credit_events ce
         JOIN credit_subjects cs ON cs.id = ce.subject_id
        WHERE cs.subject_type = 'tenant' AND cs.subject_ref_id = $1`, [p.tenantId])).rows.map(r => r.payment_id)
    expect(marks).toEqual([rent])
  })

  it('a home payment paid at the desk never pays out', async () => {
    const p = await park()
    const home = await charge(p, { type: 'home_payment', amount: 200 })
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const r = await settleManualRentPayment(c, {
        payment: { id: home, landlord_id: p.landlordId, tenant_id: p.tenantId, unit_id: p.unitId, lease_id: p.leaseId, due_date: '2026-10-01' },
        method: 'cash', settledAt: null, settleHousehold: true, amountTendered: 200,
      })
      await c.query('COMMIT')
      expect(r.settledPaymentIds).toEqual([home])
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const row = (await db.query<{ status: string; platform_held: boolean; manual_method: string }>(
      `SELECT status, platform_held, manual_method FROM payments WHERE id = $1`, [home])).rows[0]
    expect(row).toEqual({ status: 'settled', platform_held: false, manual_method: 'cash' })
    expect(await ownerShares(home)).toHaveLength(0)
    expect(await heldOwnerShareForUser(p.ownerUserId)).toBe(0)
  })
})

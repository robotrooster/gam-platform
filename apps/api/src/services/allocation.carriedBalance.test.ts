/**
 * A carried-over balance paid online is split like rent.
 *
 * An old balance (carried over from the landlord's previous system, or a
 * work-trade shortfall) is the landlord's money. The tenant can pay it down
 * online in any amount (rentCharge, S622): the money lands on GAM's balance
 * with platform_held set, like rent. Until allocation split it, no owner share
 * was booked for it, so the Tuesday batch never paid the landlord, and the
 * charge's processing fee went unbooked when the balance was all it paid.
 *
 * Driven through the real charge (rentCharge.chargeLeaseBalance, the Stripe SDK
 * mocked) and the real Stripe webhook, as allocation.homePayment.test does.
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
    this.paymentIntents = { create: vi.fn(async () => ({ id: 'pi_mock' })), cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })) }
    this.paymentMethods = { retrieve: vi.fn(async () => ({ id: 'pm_mock', card: { country: 'US' } })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
  }
  return { default: FakeStripe }
})

let piSeq = 0
vi.mock('./stripeConnect', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRentPlatformCharge: vi.fn(async () => ({ id: `pi_carried_${++piSeq}`, status: 'processing' })),
}))

import { webhooksRouter } from '../routes/webhooks'
import { db, getClient } from '../db'
import { chargeLeaseBalance } from './rentCharge'
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
    await c.query(`UPDATE tenants SET stripe_customer_id = 'cus_carried' WHERE id = $1`, [tenantId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 800 })
    const leaseId = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1, $2, 800, 'month_to_month', 'active', '2026-01-01') RETURNING id`, [unitId, landlordId])).rows[0].id
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    return { ownerUserId, landlordId, tenantId, unitId, leaseId }
  } finally { c.release() }
}

/** An open charge: this month's rent, or the old balance carried over. */
async function open(p: Park, a: { type: 'rent' | 'carried_balance'; amount: number; due: string }): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                           entry_description, revenue_owner)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, 'landlord')
     RETURNING id`,
    [p.unitId, p.leaseId, p.tenantId, p.landlordId, a.type, a.amount, a.due,
     a.type === 'rent' ? 'RENT' : 'BALANCE'])).rows[0].id
}

/** The tenant pays online by bank (the real charge route). */
async function payOnline(p: Park, amount: number): Promise<string> {
  const r = await chargeLeaseBalance({
    tenantId: p.tenantId, leaseId: p.leaseId, amount,
    paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'portal', credit: null,
  })
  return r.paymentIntentId!
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

/** The processing fee booked for these rows (GAM's spread rows carry what the customer paid). */
const feeBooked = async (ids: string[]) => Number((await db.query<{ total: string; n: string }>(
  `SELECT COALESCE(SUM(customer_fee_charged), 0)::text AS total FROM platform_revenue_ledger
    WHERE reference_type = 'payment' AND type = 'banking_spread' AND reference_id = ANY($1::uuid[])`,
  [ids])).rows[0].total)

/** The fee the active ACH rate puts on a payment of `amount`. */
async function wholeFee(amount: number): Promise<number> {
  const rate = (await db.query<{ flat: string; pct: string; cap: string | null }>(
    `SELECT customer_facing_flat::text AS flat, customer_facing_percent::text AS pct, customer_facing_cap::text AS cap
       FROM platform_processing_rates WHERE payment_method = 'ach' AND effective_until IS NULL`)).rows[0]
  const whole = Math.min(Number(rate.flat) + amount * Number(rate.pct) / 100, rate.cap == null ? Infinity : Number(rate.cap))
  return Math.round(whole * 100) / 100
}

describe('a carried-over balance paid online is split like rent', () => {
  it('carried_balance is one of the kinds allocation splits', () => {
    expect(ALLOCATABLE_PAYMENT_TYPES).toContain('carried_balance')
  })

  it('a carried balance paid online books the owner share once and lands in the payout', async () => {
    const p = await park()
    await open(p, { type: 'carried_balance', amount: 1000, due: '2026-01-01' })
    const rent = await open(p, { type: 'rent', amount: 800, due: '2026-10-01' })

    // Rent first, then $150 toward the old balance (S622: the only part payment).
    const pi = await payOnline(p, 950)
    const paidSlice = (await db.query<{ id: string; amount: string; platform_held: boolean }>(
      `SELECT id, amount::text AS amount, platform_held FROM payments
        WHERE lease_id = $1 AND type = 'carried_balance' AND stripe_payment_intent_id = $2`, [p.leaseId, pi])).rows
    expect(paidSlice).toEqual([{ id: expect.any(String), amount: '150.00', platform_held: true }])
    const slice = paidSlice[0].id

    await cleared(pi)
    // Stripe sends the same event again; nothing is booked twice.
    await cleared(pi)

    expect(await ownerShares(slice)).toEqual([{ user_id: p.ownerUserId, amount: '150.00' }])
    expect(await ownerShares(rent)).toEqual([{ user_id: p.ownerUserId, amount: '800.00' }])
    // What the next Tuesday batch pays this landlord: the rent and the $150.
    expect(await heldOwnerShareForUser(p.ownerUserId)).toBe(950)
    // Running allocation again by hand books nothing more.
    const c = await getClient()
    try { await executeRentAllocation(c, slice, 'ach') } finally { c.release() }
    expect(await ownerShares(slice)).toHaveLength(1)
    // The processing fee is booked once for the charge, on all of its money.
    expect(await feeBooked([rent, slice])).toBeCloseTo(await wholeFee(950), 2)

    // What is still owed on the old balance stays open and pays nothing out.
    const rest = (await db.query<{ id: string; amount: string; status: string }>(
      `SELECT id, amount::text AS amount, status FROM payments
        WHERE lease_id = $1 AND type = 'carried_balance' AND id <> $2`, [p.leaseId, slice])).rows
    expect(rest).toEqual([{ id: expect.any(String), amount: '850.00', status: 'pending' }])
    expect(await ownerShares(rest[0].id)).toHaveLength(0)
  })

  it('a payment toward the old balance alone books its owner share and its processing fee', async () => {
    const p = await park()
    const carried = await open(p, { type: 'carried_balance', amount: 1000, due: '2026-01-01' })

    // Nothing else owed: $250 toward the old balance, nothing else on the charge.
    const pi = await payOnline(p, 250)
    await cleared(pi)

    expect(await ownerShares(carried)).toEqual([{ user_id: p.ownerUserId, amount: '250.00' }])
    expect(await heldOwnerShareForUser(p.ownerUserId)).toBe(250)
    // Before, no row on this charge was split, so its fee was booked by nobody.
    expect(await feeBooked([carried])).toBeCloseTo(await wholeFee(250), 2)
  })
})

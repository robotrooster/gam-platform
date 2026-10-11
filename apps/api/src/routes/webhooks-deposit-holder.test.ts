/**
 * Step 9 review (fix pass 3) — decisions #46.3 through the real Stripe webhook.
 *
 * "A deposit is held by whoever collected it": a security deposit paid
 * electronically through GAM (the portal, autopay, the counter card reader —
 * every one settles by payment_intent.succeeded) is GAM's to hold where the
 * S604 custody gate lets GAM hold deposits, and the landlord's where it does
 * not. These post a real succeeded event for a deposit row as a GAM charge
 * leaves it (claimed, platform_held, its intent on it) and read the deposit
 * record the webhook's settle (webhooks.ts → leaseFeesSync
 * .reconcileSettledDepositPayment) leaves behind — so a regression in that
 * call, or in platform_held being set at charge time, cannot go unnoticed.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

vi.mock('stripe', () => {
  const constructEvent = (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent }
    this.transfers = { create: vi.fn(async () => ({ id: 'tr_mock' })) }
    this.customers = { retrieve: vi.fn(async (id: string) => ({ id, invoice_settings: { default_payment_method: null } })), update: vi.fn(async (id: string) => ({ id })) }
    this.paymentIntents = { create: vi.fn(async () => ({ id: 'pi_mock' })), cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })) }
    this.paymentMethods = { retrieve: vi.fn(async (id: string) => ({ id })), update: vi.fn(async (id: string) => ({ id })), list: vi.fn(async () => ({ data: [] })) }
    this.setupIntents = { list: vi.fn(async () => ({ data: [] })) }
    this.charges = { retrieve: vi.fn(async (id: string) => ({ id })) }
  }
  return { default: FakeStripe }
})

import { webhooksRouter } from './webhooks'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { syncSecurityDepositRow } from '../services/leaseFeesSync'

function buildApp() {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
  await db.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
     VALUES ('ach', 0, 1.0, 0, 0.5) ON CONFLICT DO NOTHING`)
})

/** A native lease in a state GAM may (or may not) hold deposits in, with its $500 deposit record planned at billing. */
async function leaseWithDeposit(custody: 'supported' | 'blocked') {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const state = custody === 'supported' ? 'XZ' : 'XB'
    await c.query(`UPDATE properties SET state = $1 WHERE id = $2`, [state, propertyId])
    await c.query(
      `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ($1, $2, $3, 'test') ON CONFLICT (state_code) DO UPDATE SET custody_status = EXCLUDED.custody_status,
              allows_treasury_bills = EXCLUDED.allows_treasury_bills`,
      [state, custody, custody === 'supported'])
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await syncSecurityDepositRow(leaseId, 500, c)
    return { landlordId, tenantId, unitId, leaseId }
  } finally { c.release() }
}

/** The security-deposit charge as a GAM card/bank charge leaves it: claimed, on GAM's balance, its intent on it. */
async function claimedDepositCharge(s: Awaited<ReturnType<typeof leaseWithDeposit>>, intent: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date,
                           stripe_payment_intent_id, platform_held)
     VALUES ($1, $2, $3, $4, 'deposit', 500, 'processing', 'DEPOSIT', CURRENT_DATE, $5, TRUE) RETURNING id`,
    [s.landlordId, s.tenantId, s.leaseId, s.unitId, intent])).rows[0].id
}

const succeeded = (intent: string, method: 'card' | 'us_bank_account' | 'card_present') => JSON.stringify({
  id: 'evt_' + intent,
  type: 'payment_intent.succeeded',
  data: { object: { id: intent, metadata: {}, latest_charge: { id: 'ch_' + intent, payment_method_details: { type: method } } } },
})

const record = async (leaseId: string) => (await db.query(
  `SELECT held_by, status, collected_amount::float AS collected FROM security_deposits WHERE lease_id = $1`, [leaseId])).rows[0]

describe('decisions #46.3 through the webhook: a deposit paid through GAM is recorded by who collected it', () => {
  it.each(['card', 'us_bank_account', 'card_present'] as const)(
    'paid through GAM (%s) where GAM may hold deposits: the record is funded and GAM holds it', async (method) => {
      const s = await leaseWithDeposit('supported')
      expect((await record(s.leaseId)).held_by).toBe('gam_escrow')        // the plan
      const pay = await claimedDepositCharge(s, `pi_dep_${method}`)
      const res = await request(buildApp()).post('/webhooks/stripe')
        .set('Content-Type', 'application/json').set('stripe-signature', 'sig').send(succeeded(`pi_dep_${method}`, method))
      expect(res.status).toBe(200)
      expect((await db.query(`SELECT status, platform_held FROM payments WHERE id = $1`, [pay])).rows[0])
        .toEqual({ status: 'settled', platform_held: true })
      expect(await record(s.leaseId)).toEqual({ held_by: 'gam_escrow', status: 'funded', collected: 500 })
    })

  it('paid through GAM where the custody gate does not let GAM hold deposits: the record is funded and the landlord holds it', async () => {
    const s = await leaseWithDeposit('blocked')
    expect((await record(s.leaseId)).held_by).toBe('landlord')            // the plan
    await claimedDepositCharge(s, 'pi_dep_blocked')
    const res = await request(buildApp()).post('/webhooks/stripe')
      .set('Content-Type', 'application/json').set('stripe-signature', 'sig').send(succeeded('pi_dep_blocked', 'card'))
    expect(res.status).toBe(200)
    expect(await record(s.leaseId)).toEqual({ held_by: 'landlord', status: 'funded', collected: 500 })
  })

  it('the same event delivered twice raises the record once', async () => {
    const s = await leaseWithDeposit('supported')
    await claimedDepositCharge(s, 'pi_dep_twice')
    for (let i = 0; i < 2; i++) {
      await request(buildApp()).post('/webhooks/stripe')
        .set('Content-Type', 'application/json').set('stripe-signature', 'sig').send(succeeded('pi_dep_twice', 'card'))
    }
    expect(await record(s.leaseId)).toEqual({ held_by: 'gam_escrow', status: 'funded', collected: 500 })
  })
})

/**
 * Fix pass (rev8) — decisions #54 / S512 "GAM never absorbs": the kept-share
 * top-up (paymentReversal.topUpDepositKeptAsk) counts what EVERY record on a
 * deposit payment still has to recover, not only the latest record's.
 *
 * (Fixture shared in shape with routes/deskRepaysReopenedDeposit.test.ts.)
 *
 * A GAM-held $500 deposit paid by card; the move-out kept $250 for damage
 * (paid to the landlord) and refunded $250 to the card; then the card holder
 * disputed all $500. GAM is out $500 and takes $250 back off the landlord's
 * next payout; the tenant owes the $500 again on the reopened deposit charge.
 * When they pay it in CASH at the desk, the landlord holds the whole $500:
 * the $250 kept share is theirs again out of it, and the other $250 — what
 * refills GAM — comes off their next payout. Every manual path goes through
 * settleManualRentPayment, which now resolves the reversal inside the settle
 * transaction (resolveReversalOnTenantPayment, landlordHoldsCash).
 *
 * Stripe is mocked: nothing reaches it.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stripeMocks = vi.hoisted(() => ({
  refundsCreate: vi.fn(async (params: any, _opts?: any): Promise<any> =>
    ({ id: `re_${params.payment_intent}_${params.amount}`, status: 'succeeded', metadata: params.metadata })),
  refundsList: vi.fn(async (_params: any): Promise<any> => ({ data: [] })),
  paymentIntentsRetrieve: vi.fn(async (id: string): Promise<any> => ({ id, status: 'succeeded' })),
  paymentIntentsCancel: vi.fn(async (id: string): Promise<any> => ({ id, status: 'canceled' })),
  transfersCreate: vi.fn(async (..._args: any[]) => ({ id: 'tr_test' })),
}))
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getStripe: () => ({
      refunds: { create: stripeMocks.refundsCreate, list: stripeMocks.refundsList },
      paymentIntents: { retrieve: stripeMocks.paymentIntentsRetrieve, cancel: stripeMocks.paymentIntentsCancel },
      transfers: { create: stripeMocks.transfersCreate },
    }),
  }
})
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.webhooks = { constructEvent: (body: Buffer | string) => JSON.parse(typeof body === 'string' ? body : body.toString('utf8')) }
    this.balanceTransactions = { retrieve: async () => ({ fee: 0 }) }
    this.charges = { retrieve: async (id: string) => ({ id }) }
    this.paymentIntents = { retrieve: stripeMocks.paymentIntentsRetrieve, cancel: stripeMocks.paymentIntentsCancel }
    this.refunds = { create: stripeMocks.refundsCreate, list: stripeMocks.refundsList }
    this.transfers = { create: stripeMocks.transfersCreate }
  }
  return { default: FakeStripe }
})
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { finalizeDepositReturn } from './depositReturn'
import { webhooksRouter } from '../routes/webhooks'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
  seedSecurityDeposit, seedDepositReturnDraft,
} from '../test/dbHelpers'

beforeEach(async () => {
  await cleanupAllSchema()
  vi.clearAllMocks()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_desk_deposit'
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mocked'
})

interface Stack { ownerUserId: string; landlordId: string; tenantId: string; unitId: string; leaseId: string; depositId: string; token: string }

async function stack(): Promise<Stack> {
  const c = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    await c.query(`UPDATE users SET first_name='Jane', last_name='Doe' WHERE id=$1`, [tenantUserId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    await c.query(`UPDATE units SET unit_number='RV 22' WHERE id=$1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const depositId = await seedSecurityDeposit(c, { unitId, leaseId, tenantId, totalAmount: 500, heldBy: 'gam_escrow' })
    await c.query(`UPDATE landlords SET stripe_connect_account_id='acct_landlord_test' WHERE id=$1`, [landlordId])
    const token = jwt.sign({ userId: ownerUserId, role: 'landlord', email: 'owner@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { ownerUserId, landlordId, tenantId, unitId, leaseId, depositId, token }
  } finally { c.release() }
}

/** A $500 security deposit paid by card through GAM (on GAM's balance). */
async function depositPaidByCard(s: Stack): Promise<{ id: string; intent: string }> {
  const tag = randomUUID().slice(0, 8)
  const intent = `pi_dep_${tag}`
  const id = (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           revenue_owner, settled_at, platform_held, stripe_payment_intent_id, stripe_charge_id)
     VALUES ($1,$2,$3,$4,'deposit',500,'settled',CURRENT_DATE - 30,'DEPOSIT','landlord',NOW() - INTERVAL '30 days',
             TRUE,$5,$6) RETURNING id`,
    [s.unitId, s.leaseId, s.tenantId, s.landlordId, intent, `ch_${tag}`])).rows[0].id
  await db.query(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method, stripe_payment_intent_id, status)
     VALUES ($1,$2,$3,500,500,'card',$4,'settled')`,
    [s.tenantId, s.leaseId, s.landlordId, intent])
  return { id, intent }
}

async function finalizeWithDamage(s: Stack, damage: number) {
  const c = await getClient()
  let draftId: string
  try {
    draftId = await seedDepositReturnDraft(c, {
      leaseId: s.leaseId, tenantId: s.tenantId, landlordId: s.landlordId, securityDepositId: s.depositId,
      totalDeposit: 500, damageLines: [{ description: 'Broken window', amount: damage }],
    })
  } finally { c.release() }
  return finalizeDepositReturn(draftId, s.ownerUserId)
}

async function disputeOf(intent: string, cents: number, tag: string) {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  const body = JSON.stringify({ id: `evt_dispute_${tag}_${randomUUID().slice(0, 8)}`, type: 'charge.dispute.created', data: { object: {
    id: `dp_${intent}_${tag}`, charge: `ch_${intent}`, payment_intent: intent, amount: cents, currency: 'usd',
    reason: 'fraudulent', status: 'needs_response', balance_transactions: [{ fee: 1500 }] } } })
  return request(app).post('/webhooks/stripe').set('stripe-signature', 'sig').set('Content-Type', 'application/json').send(body)
}

const lines = async () => (await db.query<any>(
  `SELECT source_id, amount::float AS amount FROM held_payout_items
    WHERE source_type = 'dispute' AND source_id LIKE 'owner\\_share\\_%' ORDER BY created_at, source_id`)).rows
const recordOf = async (paymentId: string) => (await db.query<any>(
  `SELECT id, outcome, status FROM payment_reversals WHERE payment_id = $1 ORDER BY created_at`, [paymentId])).rows
describe('Fix pass (rev8): the kept-share top-up counts every record on the payment', () => {
  it('two partial disputes counted against a refund not known sent, then the refund turns out sent: the landlord is asked for both disputes\' kept share ($200), never only the latest one\'s', async () => {
    const s = await stack()
    const pay = await depositPaidByCard(s)
    // The card refund of the $250 cannot be confirmed: Stripe is down when it is sent and when the disputes arrive.
    stripeMocks.refundsCreate.mockImplementation(async () => { throw new Error('Stripe is down') })
    stripeMocks.refundsList.mockImplementation(async () => { throw new Error('Stripe is down') })
    const final = await finalizeWithDamage(s, 250)
    const part = (await db.query<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE deposit_return_id = $1`, [final.id])).rows[0]
    expect((await disputeOf(pay.intent, 10000, 'a')).status).toBe(200)
    expect((await disputeOf(pay.intent, 10000, 'b')).status).toBe(200)
    // Both disputes were counted against the $250 refund not known sent: nothing asked of the landlord yet.
    const recs = await recordOf(pay.id)
    expect(recs).toHaveLength(2)
    expect(await lines()).toEqual([])
    // The refund did reach the card after all: the $200 the disputes took landed on the kept share.
    stripeMocks.refundsList.mockImplementation(async () => ({ data: [
      { id: 're_lost', status: 'succeeded', metadata: { gam_stay_refund_part_id: part.id } }] }))
    const { noteDepositRefundOfReturnedPayment } = await import('./depositRefundSend')
    await noteDepositRefundOfReturnedPayment(pay.id)
    const asked = (await lines()).filter((l: any) => l.source_id.startsWith('owner_share_withheld:'))
    expect(asked.reduce((t: number, l: any) => t + l.amount, 0)).toBe(-200)
    // Spread over both records: each recovered its $100.
    expect((await db.query<any>(
      `SELECT reversed_amount::float AS reversed, recovered_amount::float AS recovered, recovery_status FROM payment_reversals
        WHERE payment_id = $1 ORDER BY created_at`, [pay.id])).rows).toEqual([
      { reversed: 100, recovered: 100, recovery_status: 'recovered' },
      { reversed: 100, recovered: 100, recovery_status: 'recovered' },
    ])
    // Once: running it again asks nothing more.
    await noteDepositRefundOfReturnedPayment(pay.id)
    expect((await lines()).filter((l: any) => l.source_id.startsWith('owner_share_withheld:'))).toHaveLength(asked.length)
  })
})

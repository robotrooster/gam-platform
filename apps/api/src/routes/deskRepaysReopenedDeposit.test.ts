/**
 * Fix pass (rev8) — decisions #54 / S512 "GAM never absorbs", through the
 * desk route (POST /api/payments/:id/record-manual).
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
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendNotificationEmail: vi.fn(async () => undefined) }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { finalizeDepositReturn } from '../services/depositReturn'
import { paymentsRouter } from './payments'
import { webhooksRouter } from './webhooks'
import { errorHandler } from '../middleware/errorHandler'
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

async function disputeAll(intent: string) {
  const app = express()
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))
  app.use('/webhooks', webhooksRouter)
  const body = JSON.stringify({ id: `evt_dispute_${randomUUID().slice(0, 8)}`, type: 'charge.dispute.created', data: { object: {
    id: `dp_${intent}`, charge: `ch_${intent}`, payment_intent: intent, amount: 50000, currency: 'usd',
    reason: 'fraudulent', status: 'needs_response', balance_transactions: [{ fee: 1500 }] } } })
  return request(app).post('/webhooks/stripe').set('stripe-signature', 'sig').set('Content-Type', 'application/json').send(body)
}

function deskApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentsRouter)
  app.use(errorHandler)
  return app
}

const lines = async () => (await db.query<any>(
  `SELECT source_id, amount::float AS amount FROM held_payout_items
    WHERE source_type = 'dispute' AND source_id LIKE 'owner\\_share\\_%' ORDER BY created_at, source_id`)).rows
const recordOf = async (paymentId: string) => (await db.query<any>(
  `SELECT id, outcome, status FROM payment_reversals WHERE payment_id = $1 ORDER BY created_at`, [paymentId])).rows
const book = async () => {
  const { loadPlatformBalanceBook } = await import('../services/stripeCosts')
  const b = await loadPlatformBalanceBook()
  return { depositsInTrust: b.depositsInTrust, heldItemsOwed: b.heldItemsOwed }
}

describe('Fix pass (rev8): a reopened move-out deposit charge paid in cash at the desk', () => {
  it('the landlord keeps the $250 kept share out of the $500 cash once, the $250 that refills GAM comes off their payout, and GAM ends whole', async () => {
    const s = await stack()
    const pay = await depositPaidByCard(s)
    await finalizeWithDamage(s, 250)
    expect(stripeMocks.transfersCreate).toHaveBeenCalledTimes(1)   // the kept $250 went to the landlord
    expect((await disputeAll(pay.intent)).status).toBe(200)
    const [rec] = await recordOf(pay.id)
    const reopened = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE reversal_id = $1 AND status = 'pending'`, [rec.id])).rows
    expect(reopened).toHaveLength(1)
    // Before the cash: GAM is out the $500, and $250 comes back off the landlord's payout.
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -250 })

    const res = await request(deskApp()).post(`/api/payments/${reopened[0].id}/record-manual`)
      .set('Authorization', `Bearer ${s.token}`)
      .send({ method: 'cash', amountTendered: 500 })
    expect(res.status).toBe(200)
    expect(res.body.data.settledPaymentIds ?? res.body.data.settled_payment_ids ?? [reopened[0].id]).toContain(reopened[0].id)

    expect((await db.query<any>(`SELECT status, manual_method FROM payments WHERE id = $1`, [reopened[0].id])).rows[0])
      .toEqual({ status: 'settled', manual_method: 'cash' })
    // The record is closed as paid by the tenant.
    expect((await recordOf(pay.id))[0]).toMatchObject({ outcome: 'tenant_paid', status: 'resolved' })
    // The landlord holds the $500 cash: the $250 kept share stays given back on its line, and the
    // other $250 (what the dispute took from GAM) comes off their payout — never paid to them twice.
    expect(await lines()).toEqual([
      { source_id: `owner_share_withheld:${rec.id}`, amount: -250 },
      { source_id: `owner_share_refill:${rec.id}`, amount: -250 },
    ])
    const refill = (await db.query<any>(`SELECT description FROM held_payout_items WHERE source_id = $1`, [`owner_share_refill:${rec.id}`])).rows[0]
    expect(refill.description).toBe('Move-out at RV 22: Jane Doe paid the reopened deposit charge again to you in person — $250.00 of it makes up what the dispute or bank return took back, so it comes out of this payout (the part kept for the deductions stays yours)')
    // GAM's book: the $500 Stripe took comes back off the landlord's payouts — GAM whole, nothing left in trust.
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -500 })
    // The repayment is the move-out's, never a deposit GAM holds or a payout of its own.
    expect((await db.query<any>(`SELECT platform_held, released_by_deposit_return_id IS NOT NULL AS stamped FROM payments WHERE id = $1`,
      [reopened[0].id])).rows[0]).toEqual({ platform_held: false, stamped: true })
    // The closed move-out's deposit record is left as the move-out left it: still held by GAM.
    expect((await db.query<any>(`SELECT held_by FROM security_deposits WHERE id = $1`, [s.depositId])).rows[0].held_by).toBe('gam_escrow')
    // The landlord holds the repayment (late fees paid with it included).
    expect((await db.query<any>(`SELECT late_fee_owner FROM payment_reversals WHERE id = $1`, [rec.id])).rows[0].late_fee_owner).toBe('landlord')
    // Resolving it again while the cash still pays the bill (a later call, any path) changes nothing.
    const { resolveReversalOnTenantPayment } = await import('../services/paymentReversal')
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await resolveReversalOnTenantPayment(c as any, rec.id)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect(await lines()).toHaveLength(2)
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -500 })
  })
})

/** Through the deposit's dispute and the cash at the desk: the record and the reopened row. */
async function paidInCashAtTheDesk(s: Stack): Promise<{ recId: string; rowId: string; payId: string }> {
  const pay = await depositPaidByCard(s)
  await finalizeWithDamage(s, 250)
  expect((await disputeAll(pay.intent)).status).toBe(200)
  const [rec] = await recordOf(pay.id)
  const rowId = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id = $1`, [rec.id])).rows[0].id
  const res = await request(deskApp()).post(`/api/payments/${rowId}/record-manual`)
    .set('Authorization', `Bearer ${s.token}`).send({ method: 'cash', amountTendered: 500 })
  expect(res.status).toBe(200)
  return { recId: rec.id, rowId, payId: pay.id }
}
/** The cash taken back off the bill, as a bank-deposit match undone leaves it: the row owed again. */
const takenOffTheBill = (rowId: string) => db.query(
  `UPDATE payments SET status = 'pending', settled_at = NULL, manual_method = NULL, platform_held = FALSE WHERE id = $1`, [rowId])
const refillNet = async (recId: string) => (await db.query<any>(
  `SELECT COALESCE(SUM(amount), 0)::float AS s FROM held_payout_items
    WHERE source_id LIKE 'owner\\_share\\_refill%' AND source_id LIKE '%' || $1 || '%'`, [recId])).rows[0].s

describe('Fix pass 2 (review): a cash repayment of a reopened deposit charge taken back off the bill', () => {
  it('undoing the resolution gives the $250 refill back and leaves the reversal open as the dispute left it', async () => {
    const s = await stack()
    const x = await paidInCashAtTheDesk(s)
    await takenOffTheBill(x.rowId)
    const { undoTenantPaidResolution } = await import('../services/paymentReversal')
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await undoTenantPaidResolution(c as any, x.recId)
      await undoTenantPaidResolution(c as any, x.recId)   // idempotent
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    // The landlord is charged nothing for cash they no longer have: the refill is given back on the same payout.
    expect(await refillNet(x.recId)).toBe(0)
    const back = (await db.query<any>(`SELECT amount::float AS a, description FROM held_payout_items WHERE source_id LIKE 'owner\\_share\\_refill\\_back:%'`)).rows
    expect(back).toEqual([{ a: 250, description: 'Move-out at RV 22: the in-person payment of Jane Doe\'s reopened deposit charge was taken off the bill, so the $250.00 taken off your payout for it is given back' }])
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -250 })
    // The record is back as the dispute left it (the kept $250 recovered off the landlord's payout).
    expect((await db.query<any>(`SELECT outcome, status FROM payment_reversals WHERE id = $1`, [x.recId])).rows[0])
      .toEqual({ outcome: 'landlord_clawback', status: 'resolved' })
    expect((await db.query<any>(`SELECT released_by_deposit_return_id IS NULL AS free FROM payments WHERE id = $1`, [x.rowId])).rows[0].free).toBe(true)

    // Paid in cash again: the refill is charged once more — never twice.
    const res = await request(deskApp()).post(`/api/payments/${x.rowId}/record-manual`)
      .set('Authorization', `Bearer ${s.token}`).send({ method: 'cash', amountTendered: 500 })
    expect(res.status).toBe(200)
    expect(await refillNet(x.recId)).toBe(-250)
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: -500 })
    expect((await db.query<any>(`SELECT outcome FROM payment_reversals WHERE id = $1`, [x.recId])).rows[0].outcome).toBe('tenant_paid')
  })

  it('left stale and then paid online, the online repayment resolves it afresh: the refill is given back and the kept share paid back once', async () => {
    const s = await stack()
    const x = await paidInCashAtTheDesk(s)
    await takenOffTheBill(x.rowId)
    // The tenant pays the reopened charge online: the success path settles the row and resolves its record.
    const { resolveReversalOnTenantPayment } = await import('../services/paymentReversal')
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE payments SET status = 'settled', settled_at = NOW() WHERE id = $1`, [x.rowId])
      await resolveReversalOnTenantPayment(c as any, x.recId)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    // GAM keeps the $500 online (it refills what the dispute took); the cash refill is given back,
    // and the kept $250 the landlord gave back is paid to them again — once.
    expect(await refillNet(x.recId)).toBe(0)
    expect((await db.query<any>(`SELECT amount::float AS a FROM held_payout_items WHERE source_id = $1`, [`owner_share_returned:${x.recId}`])).rows)
      .toEqual([{ a: 250 }])
    expect(await book()).toEqual({ depositsInTrust: 0, heldItemsOwed: 0 })
    expect((await db.query<any>(`SELECT outcome, status FROM payment_reversals WHERE id = $1`, [x.recId])).rows[0])
      .toEqual({ outcome: 'tenant_paid', status: 'resolved' })
  })
})

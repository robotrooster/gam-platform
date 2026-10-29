/**
 * 10/20 (review) — WHETHER A UTILITY BILL IS STILL OWED IS THE CHARGE'S ANSWER,
 * NEVER THE BILL'S STATUS ON ITS OWN.
 *
 * utility_bills.status is moved by one trigger (utility_bills_follow_payment)
 * and only when a charge reaches 'settled'. Three reachable states never get
 * there, and in every one of them the bill goes on reading 'billed' while its
 * money is already answered for:
 *
 *   IN FLIGHT — the resident paid their invoice by ACH, so the utility charge
 *     carries an intent and clears in three to five business days.
 *   TAKEN FROM THE DEPOSIT — move-out swept the unpaid charge to
 *     'paid_via_deposit' (services/depositReturn); no trigger fires on that
 *     status, so the bill stays 'billed' for good.
 *   PAID WITH HOURS — the charge is suspended under work trade. "Work trade is
 *     hours, not wages": there is no cash to ask anybody for.
 *
 * Before the fix the pay-link door said yes in all three: the bill was listed,
 * Send sent it, the payer paid it a second time by card, the bill flipped
 * 'paid', and when the ACH landed the trigger's UPDATE found a bill already
 * marked paid and did nothing. voidUnowedCharges only touches 'pending' and
 * 'failed', so nothing was voided and nothing was held either — the only trace
 * of the second collection was one more register sale.
 *
 * The third case is not hypothetical. The production read on 10/20 found SIX
 * live bills whose charge is suspended under work trade — $368.62 across
 * Country Acres, Mountain View and Oak Park — and they are what this door
 * would have been pointed at first.
 *
 * Each case below leaves the bill reading exactly what production reads, and
 * then asks the door for it, at all three places the door asks: the list, the
 * Send refusal, and the gate the payment goes through as it lands.
 *
 * Run (the settlements migration is not on production yet; it needs the propane
 * lane's two as well, which is what TEST_APPLY_MIGRATIONS_AFTER picks up):
 *   DB_NAME=gam_upl_test TEST_DB_NAME=gam_upl_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/routes/utilityPayLinkChargeAnswered.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailPayLinkMock, checkoutMock, readSaleCardMock, notifyMock } = vi.hoisted(() => ({
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
  checkoutMock: vi.fn(async (_p: any) => ({ id: `cs_${Math.random().toString(36).slice(2)}`, url: 'https://checkout.stripe.test/x' })),
  readSaleCardMock: vi.fn(async (_pi: string): Promise<any> => null),
  notifyMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({ ...(await orig() as any), emailPayLink: emailPayLinkMock }))
vi.mock('../services/posCustomerCards', async (orig) => ({ ...(await orig() as any), readSaleCard: readSaleCardMock }))
vi.mock('../services/notifications', async (orig) => ({ ...(await orig() as any), createNotification: notifyMock }))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({
    checkout: { sessions: { create: checkoutMock, retrieve: async (id: string) => ({ id, status: 'open', payment_status: 'unpaid' }), expire: async (id: string) => ({ id, status: 'expired' }) } },
    refunds: { create: async (p: any) => ({ id: `re_${p.payment_intent}`, status: 'succeeded' }) },
  }),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { posPayLinksRouter, finalizePayLink, payLinkCharge } from './posPayLinks'
import { posRouter } from './pos'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/pos/pay-links', posPayLinksRouter)
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailPayLinkMock.mockClear(); checkoutMock.mockClear(); notifyMock.mockClear()
  readSaleCardMock.mockReset(); readSaleCardMock.mockResolvedValue(null)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_utility_paylink_charge'
})

/**
 * Mountain View's shape: an RV space with its own electric submeter, a resident
 * whose $44.94 of September power is a 'billed' bill AND a pending charge row on
 * their invoice — the common case, and the only one that can go wrong this way.
 */
async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`,
      [landlordId, `acct_test_answered_${Math.random().toString(36).slice(2, 10)}`])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 589 })
    // S652: display_label is what the park calls the space and what prints.
    await c.query(`UPDATE units SET display_label = 'RV 27' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c, { email: `answered-${Math.random().toString(36).slice(2)}@example.com` })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 589 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric' })

    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, tenant_id, unit_id, invoice_number, status, due_date,
                             total_amount, subtotal_rent, subtotal_utilities)
       VALUES ($1,$2,$3,$4,$5,'pending',CURRENT_DATE, 44.94, 0, 44.94) RETURNING id`,
      [landlordId, leaseId, tenantId, unitId, `INV-${Math.random().toString(36).slice(2, 8)}`])
    const pay = await c.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,$5,'utility',44.94,'pending',CURRENT_DATE,'UTILITY','Electric — September 2026') RETURNING id`,
      [inv.rows[0].id, unitId, leaseId, tenantId, landlordId])
    const billId = await seedUtilityBill(c, {
      meterId, unitId, tenantId, leaseId, landlordId,
      chargeAmount: 44.94, utilityType: 'electric',
      billingCycleMonth: '2026-09-01', status: 'billed', paymentId: pay.rows[0].id,
    })

    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: null,
      landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId, meterId, billId,
             paymentId: pay.rows[0].id, invoiceId: inv.rows[0].id, token }
  } finally { c.release() }
}

const sendBill = (f: any) => request(buildApp()).post('/api/pos/pay-links/utility-bills')
  .set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId, billIds: [f.billId] })

const listSendable = (f: any) => request(buildApp())
  .get(`/api/pos/pay-links/utility-bills?propertyId=${f.propertyId}`)
  .set('Authorization', `Bearer ${f.token}`)

const paid = (linkId: string, amount: number, pi: string) => ({
  id: `cs_${pi}`, amount_total: Math.round(amount * 100), payment_intent: pi,
  metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: linkId },
})

const bill = (id: string) => db.query<any>(
  `SELECT status, paid_at, payment_id FROM utility_bills WHERE id = $1`, [id]).then(r => r.rows[0])
const settlements = (linkId: string) => db.query<any>(
  `SELECT * FROM utility_pay_link_settlements WHERE pay_link_id = $1 ORDER BY created_at, id`, [linkId]).then(r => r.rows)
const charge = (id: string) => db.query<any>(
  `SELECT status, stripe_payment_intent_id, work_trade_suspended_at, voided_at
     FROM payments WHERE id = $1`, [id]).then(r => r.rows[0])

type How = 'in_flight' | 'from_deposit' | 'work_trade'

/** Put the bill's charge into one of the three states, leaving the bill owed. */
async function putCharge(f: any, how: How) {
  if (how === 'in_flight') {
    // Paid by ACH on their invoice: an intent is attached and it clears in
    // three to five business days.
    await db.query(
      `UPDATE payments SET status = 'processing', stripe_payment_intent_id = $2 WHERE id = $1`,
      [f.paymentId, `pi_ach_${Math.random().toString(36).slice(2, 10)}`])
  } else if (how === 'from_deposit') {
    // Move-out swept it from the security deposit (services/depositReturn).
    await db.query(
      `UPDATE payments SET status = 'paid_via_deposit', settled_at = NOW() WHERE id = $1`, [f.paymentId])
  } else {
    // The hours pay it: "work trade is hours, not wages".
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE id = $1`, [f.paymentId])
  }
  // THE PREMISE OF THE WHOLE FAULT: the bill has not moved. This is what
  // production reads while the money is already answered for.
  expect(await bill(f.billId)).toMatchObject({ status: 'billed', paid_at: null })
}

describe('a bill whose charge already answered for the money is never asked for again', () => {
  it.each([
    ['being paid by ACH right now', 'in_flight' as How, /has not cleared/i],
    ['already paid out of the security deposit', 'from_deposit' as How, /security deposit/i],
    ['being paid with work-trade hours', 'work_trade' as How, /work-trade hours/i],
  ])('a bill %s is off the list and Send refuses it', async (_what, how, words) => {
    const f = await seed()
    // Owed, and offered, while nothing has answered for it.
    expect((await listSendable(f)).body.data).toHaveLength(1)

    await putCharge(f, how)

    const list = await listSendable(f)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(0)

    const sent = await sendBill(f)
    expect(sent.status, JSON.stringify(sent.body)).toBe(409)
    expect(sent.body.error).toMatch(words)
    // Nothing went out, so nothing is holding the bill either.
    expect((await db.query(`SELECT 1 FROM pos_pay_links WHERE property_id = $1`, [f.propertyId])).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM utility_pay_link_settlements WHERE utility_bill_id = $1`, [f.billId])).rows).toHaveLength(0)
  })

  it.each([
    ['the ACH is still clearing', 'in_flight' as How, 'processing'],
    ['the deposit already paid it', 'from_deposit' as How, 'paid_via_deposit'],
    ['the hours are paying it', 'work_trade' as How, 'pending'],
  ])('a payment that lands while %s is HELD, not taken a second time', async (_what, how, left) => {
    const f = await seed()
    // The real order of events: the link goes out while the bill is owed, and
    // the money is answered for afterwards — the ACH is paid on their portal
    // bill, or the move-out sweeps the deposit, while the card page is open.
    const link = (await sendBill(f)).body.data
    expect(link.id).toBeTruthy()
    await putCharge(f, how)

    const { charged } = payLinkCharge(44.94)
    const pi = `pi_answered_${how}`
    const r = await finalizePayLink(paid(link.id, charged, pi))

    // THE MONEY IS NOT TAKEN TWICE.
    expect(r.recorded).toBe(false)
    expect(r.reason).toBe('utility bill already settled')
    expect(r.heldPaymentId).toBeTruthy()
    const held = (await db.query<any>(
      `SELECT reason, note FROM pos_held_payments WHERE stripe_payment_intent_id = $1`, [pi])).rows[0]
    expect(held.reason).toBe('paid_twice')

    // No sale, nothing closed out, and the charge is exactly as it was — never
    // voided out from under a payment that is still clearing.
    expect((await db.query(`SELECT 1 FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows).toHaveLength(0)
    expect(await bill(f.billId)).toMatchObject({ status: 'billed', paid_at: null })
    expect((await settlements(link.id))[0]).toMatchObject({ status: 'open', pos_transaction_id: null })
    const c = await charge(f.paymentId)
    expect(c.voided_at).toBeNull()
    expect(c.status).toBe(left)
    // And a person is told, with a plain reason and a refund button.
    expect(notifyMock).toHaveBeenCalled()
  })

  it.each([
    ['failed', 'failed'],
    ['voided', 'voided'],
  ])('a charge that %s leaves the bill genuinely owed and sendable', async (_what, st) => {
    // The companion rule, so the fix is never read as "any charge at all shuts
    // the door": money that came back or never went is owed again, and the
    // ordinary ask is right. payments_voided_is_stamped wants the day and the
    // reason on a voided row.
    const f = await seed()
    await db.query(
      `UPDATE payments SET status = $2,
              voided_at = CASE WHEN $2 = 'voided' THEN NOW() END,
              void_reason = CASE WHEN $2 = 'voided' THEN 'Nobody owes it' END
        WHERE id = $1`, [f.paymentId, st])
    expect((await listSendable(f)).body.data).toHaveLength(1)
    expect((await sendBill(f)).status).toBe(200)
  })
})

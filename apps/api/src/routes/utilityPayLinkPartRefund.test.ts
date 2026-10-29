/**
 * 10/20 — THE MONTHLY INVOICE RUN AND A REFUNDED UTILITY LINE.
 *
 * utilityPayLink.test.ts holds the rule itself: the whole sale going back puts
 * the bill back on the books, a part refund leaves it closed out. This file
 * holds the thing that rule is FOR, which is a different question and reads a
 * different row.
 *
 * What actually re-bills a resident is jobs/invoiceGeneration: when it builds
 * next month's invoice it sweeps up every utility bill on the lease with no
 * payment_id and a status of 'unbilled' or 'billed'. Nothing consults
 * utility_pay_link_settlements on the way. So the first build's reopen —
 * status = 'billed', paid_at = NULL, payment_id = NULL on every bill the sale
 * had settled, for a refund of any size — did not merely mislabel a row: it
 * handed the bill straight back to the invoice run, with no human in the loop.
 * On a two-bill final link (a link can carry 24), refunding August's $44.94
 * re-asked September's $44.94 as well, which had been paid, was correct, and
 * had never had a cent refunded.
 *
 * So these two cases assert against invoiceGeneration's own predicate rather
 * than against the bill's status column:
 *
 *   a part refund  → the run picks up NOTHING, and the resident's next invoice
 *                    is clean.
 *   the rest of it → both bills are owed again AND the run picks up both, which
 *                    is the whole point of reopening them.
 *
 * Run (the settlements migration is not on production yet; it needs the propane
 * lane's two as well, which is what TEST_APPLY_MIGRATIONS_AFTER picks up):
 *   DB_NAME=gam_prfix_test TEST_DB_NAME=gam_prfix_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/routes/utilityPayLinkPartRefund.test.ts
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_utility_paylink_part'
})

/**
 * RV 27 at Mountain View, its own electric submeter, and August and September
 * power at $44.94 each — both already a charge row on the resident's invoice,
 * which is the ordinary shape (jobs/invoiceGeneration writes it) and the one
 * that makes an automatic re-bill possible at all.
 */
async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`,
      [landlordId, `acct_test_part_${Math.random().toString(36).slice(2, 10)}`])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 589 })
    await c.query(`UPDATE units SET display_label = 'RV 27' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c, { email: `part-${Math.random().toString(36).slice(2)}@example.com` })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 589 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric' })

    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, tenant_id, unit_id, invoice_number, status, due_date,
                             total_amount, subtotal_rent, subtotal_utilities)
       VALUES ($1,$2,$3,$4,$5,'pending',CURRENT_DATE, 89.88, 0, 89.88) RETURNING id`,
      [landlordId, leaseId, tenantId, unitId, `INV-${Math.random().toString(36).slice(2, 8)}`])
    const bills: Array<{ billId: string; paymentId: string; cycle: string }> = []
    for (const cycle of ['2026-08-01', '2026-09-01']) {
      const pay = await c.query<{ id: string }>(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                               due_date, entry_description, notes)
         VALUES ($1,$2,$3,$4,$5,'utility',44.94,'pending',CURRENT_DATE,'UTILITY',$6) RETURNING id`,
        [inv.rows[0].id, unitId, leaseId, tenantId, landlordId, `Electric — ${cycle}`])
      const billId = await seedUtilityBill(c, {
        meterId, unitId, tenantId, leaseId, landlordId,
        chargeAmount: 44.94, utilityType: 'electric',
        billingCycleMonth: cycle, status: 'billed', paymentId: pay.rows[0].id,
      })
      bills.push({ billId, paymentId: pay.rows[0].id, cycle })
    }

    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: null,
      landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId, meterId, invoiceId: inv.rows[0].id, bills, token }
  } finally { c.release() }
}

const bill = (id: string) => db.query<any>(
  `SELECT status, paid_at, payment_id FROM utility_bills WHERE id = $1`, [id]).then(r => r.rows[0])
const settlementStatuses = (linkId: string) => db.query<any>(
  `SELECT status FROM utility_pay_link_settlements WHERE pay_link_id = $1 ORDER BY billing_cycle_month`,
  [linkId]).then(r => r.rows.map((x: any) => x.status))
const sale = (linkId: string) => db.query<any>(
  `SELECT id, status, total::text AS total FROM pos_transactions WHERE pay_link_id = $1`,
  [linkId]).then(r => r.rows[0])

/**
 * jobs/invoiceGeneration's straggler query, on the columns that decide: a
 * utility bill on this lease with NO payment_id, a status of unbilled or
 * billed, a cycle not in the future and something to charge rides the next
 * invoice automatically. This is the harm — not the status column on its own —
 * so it is what the cases below read.
 */
const theInvoiceRunWouldPickUp = (leaseId: string) => db.query<{ id: string }>(
  `SELECT ub.id FROM utility_bills ub
    WHERE ub.lease_id = $1 AND ub.payment_id IS NULL
      AND ub.status IN ('unbilled','billed')
      AND ub.billing_cycle_month <= date_trunc('month', CURRENT_DATE)::date
      AND (ub.charge_amount + ub.tax_amount) > 0
    ORDER BY ub.billing_cycle_month`, [leaseId]).then(r => r.rows.map(x => x.id))

const noteOfType = (type: string) => notifyMock.mock.calls.map((c: any[]) => c[0])
  .find((a: any) => a?.type === type)

/** Both cycles on one link, paid in full, both bills closed out. */
async function sendBothAndPay(f: Awaited<ReturnType<typeof seed>>, pi: string) {
  const sent = await request(buildApp()).post('/api/pos/pay-links/utility-bills')
    .set('Authorization', `Bearer ${f.token}`)
    .send({ propertyId: f.propertyId, billIds: f.bills.map(b => b.billId) })
  expect(sent.status, JSON.stringify(sent.body)).toBe(200)
  const link = sent.body.data
  const { charged } = payLinkCharge(89.88)
  expect((await finalizePayLink({ id: `cs_${pi}`, amount_total: Math.round(charged * 100), payment_intent: pi,
    metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id } })).recorded).toBe(true)
  for (const b of f.bills) expect(await bill(b.billId)).toMatchObject({ status: 'paid' })
  // Both are closed out, so the invoice run has nothing of theirs to bill.
  expect(await theInvoiceRunWouldPickUp(f.leaseId)).toEqual([])
  return link
}

const refund = (f: Awaited<ReturnType<typeof seed>>, saleId: string, amount: number) => request(buildApp())
  .post(`/api/pos/transactions/${saleId}/refund`)
  .set('Authorization', `Bearer ${f.token}`)
  .send({ amount, refundMethod: 'cash', reason: 'August reading was wrong' })

describe('a refunded utility line and the invoice run', () => {
  it('a part refund leaves nothing for the monthly run to pick up', async () => {
    const f = await seed()
    const link = await sendBothAndPay(f, 'pi_part_two_bills')
    const s = await sale(link.id)

    // August's reading was wrong: $44.94 of an $89.88-plus-card-fee sale goes back.
    const r = await refund(f, s.id, 44.94)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await sale(link.id)).status).toBe('partial_refund')

    // NOBODY IS RE-ASKED. Part of the sale came back, which line it came off is
    // not something GAM knows, and both bills really were paid.
    for (const b of f.bills) {
      const row = await bill(b.billId)
      expect(row.status).toBe('paid')
      expect(row.paid_at).not.toBeNull()
      expect(row.payment_id).not.toBeNull()
    }
    expect(await settlementStatuses(link.id)).toEqual(['settled', 'settled'])
    // The one that matters: next month's invoice carries neither bill.
    expect(await theInvoiceRunWouldPickUp(f.leaseId)).toEqual([])
    expect(noteOfType('utility_bill_owed_again')).toBeFalsy()
  })

  it('when the rest of the sale goes back, both bills are owed again and the run takes both', async () => {
    const f = await seed()
    const link = await sendBothAndPay(f, 'pi_part_then_full')
    const s = await sale(link.id)

    expect((await refund(f, s.id, 44.94)).status).toBe(200)
    const left = Math.round((Number(s.total) - 44.94) * 100) / 100
    expect((await refund(f, s.id, left)).status).toBe(200)
    expect((await sale(link.id)).status).toBe('refunded')

    // Every dollar is back, so every bill the sale closed out is owed again —
    // and now the run SHOULD take them, which is what reopening is for.
    for (const b of f.bills) {
      expect(await bill(b.billId)).toMatchObject({ status: 'billed', paid_at: null, payment_id: null })
    }
    expect(await settlementStatuses(link.id)).toEqual(['refunded', 'refunded'])
    expect(await theInvoiceRunWouldPickUp(f.leaseId)).toEqual(f.bills.map(b => b.billId))
    expect(noteOfType('utility_bill_owed_again')).toBeTruthy()
  })
})

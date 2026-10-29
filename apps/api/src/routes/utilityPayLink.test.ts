/**
 * 10/20 (Nic) — A UTILITY BILL SENT AS A PAY LINK, AND A PAY LINK'S UTILITY
 * LINE SETTLING THE BILL.
 *
 *   "Paylink closes out electric. Yeah, do that. A utility bill can be sent as
 *    a paylink, and a paylink's utility line settles the bill and counts as
 *    recovery. Let's do that."
 *
 * The two shapes, both held here:
 *
 *   RAISED FROM A BILL — the final electric bill of somebody who has moved out.
 *     The link names the bill, the bill is closed out when it is paid, the
 *     charge comes off their invoice so nobody is asked twice, and the money is
 *     counted ONCE (the recovery report's register sweep must not also pick the
 *     line up, or the same $44.94 reads as $89.88 recovered).
 *
 *   RUNG UP BY HAND — Andres Razo's shape, read out of production: a clerk taps
 *     the "Electric (per kWh)" button at $0.21, 387 kWh, on a pay link, with no
 *     utility bill behind it at all. It still has to count as recovery, and it
 *     has to do so WITHOUT inventing a utility_bills row for a cycle nobody
 *     read into.
 *
 * Run (migration 20261022100000 is not on production yet; it needs the propane
 * lane's two as well, which is what TEST_APPLY_MIGRATIONS_AFTER picks up):
 *   DB_NAME=gam_pl_test TEST_DB_NAME=gam_pl_test \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/routes/utilityPayLink.test.ts
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_utility_paylink'
})

/**
 * Mountain View's shapes: an RV space with its own electric submeter, a resident
 * who has left, and the register's "Electric (per kWh)" button at $0.21 marked
 * as electric bill-back (pos_items.recovers_utility, 10/20).
 */
async function seed(opts: { onInvoice?: boolean } = {}) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    // Unique per landlord in the schema, so unique per seed — a second park in
    // one test is a real shape (the cross-property refusal below needs two).
    await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`,
      [landlordId, `acct_test_utility_${Math.random().toString(36).slice(2, 10)}`])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 589 })
    // S652: display_label is what the park calls the space and what prints.
    await c.query(`UPDATE units SET display_label = 'RV 27' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c, { email: `razo-${Math.random().toString(36).slice(2)}@example.com` })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 589 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric' })

    // The bill: $44.94 of September electric on RV 27, still owed.
    let paymentId: string | null = null
    let invoiceId: string | null = null
    if (opts.onInvoice) {
      // The common case — the final bill is already a charge row on an invoice
      // (jobs/invoiceGeneration generateFinalUtilityInvoice).
      const inv = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, lease_id, tenant_id, unit_id, invoice_number, status, due_date,
                               total_amount, subtotal_rent, subtotal_utilities)
         VALUES ($1,$2,$3,$4,$5,'pending',CURRENT_DATE, 44.94, 0, 44.94) RETURNING id`,
        [landlordId, leaseId, tenantId, unitId, `INV-${Math.random().toString(36).slice(2, 8)}`])
      invoiceId = inv.rows[0].id
      const pay = await c.query<{ id: string }>(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                               due_date, entry_description, notes)
         VALUES ($1,$2,$3,$4,$5,'utility',44.94,'pending',CURRENT_DATE,'UTILITY','Electric — September 2026') RETURNING id`,
        [invoiceId, unitId, leaseId, tenantId, landlordId])
      paymentId = pay.rows[0].id
    }
    const billId = await seedUtilityBill(c, {
      meterId, unitId, tenantId, leaseId, landlordId,
      chargeAmount: 44.94, utilityType: 'electric',
      billingCycleMonth: '2026-09-01', status: opts.onInvoice ? 'billed' : 'unbilled',
      paymentId,
    })

    const cat = await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Utilities') RETURNING id`, [landlordId])
    const item = await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price,
                              stock_qty, stock_min, stock_max, tax_rate, recovers_utility)
       VALUES ($1,$2,$3,'Electric (per kWh)',0.21,0,999,0,0,0,'electric') RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])

    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: null,
      landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId, meterId, billId,
             paymentId, invoiceId, electricItemId: item.rows[0].id, token }
  } finally { c.release() }
}

const sendBill = (f: any, body: any = {}) => request(buildApp()).post('/api/pos/pay-links/utility-bills')
  .set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId, billIds: [f.billId], ...body })

/** Puts a real name on a seeded resident, so a refusal that names people can be read. */
async function nameResident(tenantId: string, first: string, last: string): Promise<void> {
  await db.query(`UPDATE users SET first_name = $2, last_name = $3
                   WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
}

/**
 * THE NEIGHBOR: a second household at the SAME park, with their own space, own
 * submeter, and their own $63.40 of September electric already on their invoice.
 * The whole point of the shape — two residents of one property, which is what a
 * clerk sees on the sendable list and can pick across.
 */
async function seedNeighbor(f: any): Promise<{ tenantId: string; unitId: string; billId: string; paymentId: string; invoiceId: string }> {
  const c = await db.connect()
  try {
    const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, unitType: 'rv_spot', rentAmount: 589 })
    await c.query(`UPDATE units SET display_label = 'RV 10' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c, { email: `cardoza-${Math.random().toString(36).slice(2)}@example.com` })
    const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId, rentAmount: 589 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const meterId = await seedUtilityMeter(c, { propertyId: f.propertyId, utilityType: 'electric' })
    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, tenant_id, unit_id, invoice_number, status, due_date,
                             total_amount, subtotal_rent, subtotal_utilities)
       VALUES ($1,$2,$3,$4,$5,'pending',CURRENT_DATE, 63.40, 0, 63.40) RETURNING id`,
      [f.landlordId, leaseId, tenantId, unitId, `INV-${Math.random().toString(36).slice(2, 8)}`])
    const pay = await c.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,$5,'utility',63.40,'pending',CURRENT_DATE,'UTILITY','Electric — September 2026') RETURNING id`,
      [inv.rows[0].id, unitId, leaseId, tenantId, f.landlordId])
    const billId = await seedUtilityBill(c, {
      meterId, unitId, tenantId, leaseId, landlordId: f.landlordId,
      chargeAmount: 63.40, utilityType: 'electric',
      billingCycleMonth: '2026-09-01', status: 'billed', paymentId: pay.rows[0].id,
    })
    return { tenantId, unitId, billId, paymentId: pay.rows[0].id, invoiceId: inv.rows[0].id }
  } finally { c.release() }
}

const paid = (linkId: string, amount: number, pi: string) => ({
  id: `cs_${pi}`, amount_total: Math.round(amount * 100), payment_intent: pi,
  metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: linkId },
})

const bill = (id: string) => db.query<any>(
  `SELECT status, paid_at, payment_id FROM utility_bills WHERE id = $1`, [id]).then(r => r.rows[0])
const settlements = (linkId: string) => db.query<any>(
  `SELECT * FROM utility_pay_link_settlements WHERE pay_link_id = $1 ORDER BY created_at, id`, [linkId]).then(r => r.rows)

// What routes/utility.ts's recovery report counts off register sales today: a
// category starting "utilit" and a name naming a metered utility. A bill-raised
// line must be invisible to it (the BILL is the record), or the same dollar is
// counted twice.
const sweptAsRecovery = (saleId: string) => db.query<any>(
  `SELECT ti.item_name, ti.item_category, ti.recovers_utility,
          ROUND(ti.subtotal * (1 + COALESCE(ti.tax_rate, 0)), 2)::text AS amount,
          (COALESCE(ti.item_category, '') ILIKE 'utilit%' AND ti.item_name ~* '\\melectric') AS swept
     FROM pos_transaction_items ti WHERE ti.transaction_id = $1 ORDER BY ti.item_name`, [saleId]).then(r => r.rows)

describe('sending a utility bill as a pay link', () => {
  it('lists what can be sent, names the bill on the line, and holds the bill open until it is paid', async () => {
    const f = await seed()
    const list = await request(buildApp()).get(`/api/pos/pay-links/utility-bills?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ billId: f.billId, utilityType: 'electric', amount: 44.94 })
    // Plain words on the line — never a raw enum, and the space's printed name.
    expect(list.body.data[0].lineName).toBe('Electric — September 2026 (RV 27)')

    const res = await sendBill(f)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ total: 44.94, bills: 1, emailed: true })

    const link = (await db.query<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [res.body.data.id])).rows[0]
    expect(Number(link.total)).toBe(44.94)
    expect(link.expires_at).toBeNull()          // a final bill does not die quietly
    expect(link.customer_email).toMatch(/razo-/)
    // THE MATCH IS CARRIED, not guessed: the line names its bill, and carries no
    // merchandising category (a bill being collected is not a catalog sale).
    expect(link.items).toHaveLength(1)
    expect(link.items[0]).toMatchObject({ id: null, qty: 1, price: 44.94, utilityBillId: f.billId })
    expect(link.items[0].cat).toBeUndefined()

    // Sent is not paid: the bill is exactly as owed as it was.
    expect(await bill(f.billId)).toMatchObject({ status: 'unbilled', paid_at: null })
    const s = await settlements(link.id)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ status: 'open', utility_bill_id: f.billId, utility_type: 'electric',
      unit_id: f.unitId, meter_id: f.meterId, pos_transaction_id: null })
    expect(Number(s[0].charge_amount)).toBe(44.94)
  })

  it('refuses a second link for the same bill, and lets go of it when the link is closed', async () => {
    const f = await seed()
    const first = await sendBill(f)
    expect(first.status).toBe(200)
    const again = await sendBill(f)
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already out/i)

    const closed = await request(buildApp()).post(`/api/pos/pay-links/${first.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(closed.status).toBe(200)
    expect((await settlements(first.body.data.id))[0]).toMatchObject({ status: 'cancelled' })
    // The bill never moved, so it can go out again.
    expect(await bill(f.billId)).toMatchObject({ status: 'unbilled' })
    expect((await sendBill(f)).status).toBe(200)
  })

  it('refuses a bill that is already paid, and one that is not at this property', async () => {
    const f = await seed()
    await db.query(`UPDATE utility_bills SET status = 'paid', paid_at = NOW() WHERE id = $1`, [f.billId])
    const r = await sendBill(f)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/already paid/i)

    const g = await seed()
    const cross = await request(buildApp()).post('/api/pos/pay-links/utility-bills')
      .set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId, billIds: [g.billId] })
    expect(cross.status).toBe(404)
  })

  it('the bill line is the bill: Adjust cannot retype its amount or take it off', async () => {
    const f = await seed()
    const link = (await sendBill(f)).body.data
    const edit = await request(buildApp()).patch(`/api/pos/pay-links/${link.id}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ items: [{ id: null, name: 'Electric — September 2026 (RV 27)', qty: 1, price: 10 }] })
    expect(edit.status).toBe(400)
    expect(edit.body.error).toMatch(/is the bill itself/i)
  })
})

describe('a pay link\'s utility line settles the bill', () => {
  it('closes out the bill, takes the charge off their invoice, and counts the money exactly once', async () => {
    const f = await seed({ onInvoice: true })
    const link = (await sendBill(f)).body.data
    const { charged } = payLinkCharge(44.94)
    expect((await finalizePayLink(paid(link.id, charged, 'pi_bill_1'))).recorded).toBe(true)

    // THE BILL IS CLOSED OUT.
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })
    expect((await bill(f.billId)).paid_at).not.toBeNull()

    const sale = (await db.query<any>(`SELECT * FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows[0]
    const s = await settlements(link.id)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ status: 'settled', utility_bill_id: f.billId, pos_transaction_id: sale.id })
    expect(s[0].settled_at).not.toBeNull()

    // NOBODY IS ASKED TWICE: the charge on their invoice is voided — kept, with
    // its reason, and in no balance — and the invoice's totals follow it.
    const charge = (await db.query<any>(`SELECT status, void_reason, voided_at FROM payments WHERE id = $1`, [f.paymentId!])).rows[0]
    expect(charge.status).toBe('voided')
    expect(charge.void_reason).toMatch(/Collected on a pay link/)
    const inv = (await db.query<any>(`SELECT status, total_amount, subtotal_utilities FROM invoices WHERE id = $1`, [f.invoiceId!])).rows[0]
    expect(Number(inv.total_amount)).toBe(0)
    expect(Number(inv.subtotal_utilities)).toBe(0)

    // COUNTED ONCE. The bill is the record; the sale's line is invisible to the
    // recovery report's register sweep (no category to match, and no
    // recovers_utility snapshot — a typed line invents no recovery).
    const lines = await sweptAsRecovery(sale.id)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ item_category: 'misc', recovers_utility: null, swept: false })
  })

  it('the Andres shape: an electric line rung up by hand with no bill behind it still counts as recovery', async () => {
    const f = await seed()
    // 387 kWh of August power at $0.21 — exactly how $81.27 was collected from
    // Andres Razo on a link in production, with no utility bill in existence.
    const sent = await request(buildApp()).post('/api/pos/pay-links')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, items: [{ id: f.electricItemId, name: 'Electric (per kWh)', cat: 'Utilities', qty: 387, price: 0.21 }],
              customer: { name: 'Andres Razo', email: 'razoandres60@example.com' } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(Number(sent.body.data.total)).toBe(81.27)
    const { charged } = payLinkCharge(81.27)
    expect((await finalizePayLink(paid(sent.body.data.id, charged, 'pi_hand_1'))).recorded).toBe(true)

    const sale = (await db.query<any>(`SELECT * FROM pos_transactions WHERE pay_link_id = $1`, [sent.body.data.id])).rows[0]
    const s = await settlements(sent.body.data.id)
    expect(s).toHaveLength(1)
    // Recorded as recovery with NO bill — and no bill invented for it either.
    expect(s[0]).toMatchObject({ status: 'settled', utility_bill_id: null, utility_type: 'electric', pos_transaction_id: sale.id })
    expect(Number(s[0].charge_amount)).toBe(81.27)
    expect(s[0].billing_cycle_month).toBeNull()   // nobody said which cycle; NULL is the honest answer
    expect(s[0].unit_id).toBeNull()
    expect((await db.query(`SELECT 1 FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = '2026-08-01'`, [f.meterId])).rows).toHaveLength(0)

    // Which utility came off the ITEM'S OWN COLUMN, not its name: the sale line
    // carries the snapshot the propane lane added.
    const lines = await sweptAsRecovery(sale.id)
    expect(lines[0]).toMatchObject({ recovers_utility: 'electric', item_category: 'Utilities', amount: '81.27' })

    // The untouched bill on the same meter is still owed and still sendable.
    expect(await bill(f.billId)).toMatchObject({ status: 'unbilled' })
  })

  it('a bill paid some other way while the card page was open is held, never recorded, and the bill is untouched', async () => {
    const f = await seed()
    const link = (await sendBill(f)).body.data
    // Settled at the desk in the meantime.
    await db.query(`UPDATE utility_bills SET status = 'paid', paid_at = NOW() WHERE id = $1`, [f.billId])
    const { charged } = payLinkCharge(44.94)
    const r = await finalizePayLink(paid(link.id, charged, 'pi_twice_1'))
    expect(r.recorded).toBe(false)
    expect(r.reason).toBe('utility bill already settled')
    expect(r.heldPaymentId).toBeTruthy()
    // No sale, and the settlement row is still just an open ask.
    expect((await db.query(`SELECT 1 FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows).toHaveLength(0)
    expect((await settlements(link.id))[0]).toMatchObject({ status: 'open' })
    const held = (await db.query<any>(`SELECT reason, amount FROM pos_held_payments WHERE stripe_payment_intent_id = 'pi_twice_1'`)).rows[0]
    expect(held.reason).toBe('paid_twice')
  })

  it('a payment at the wrong amount is held and settles nothing (a pay link is never part paid)', async () => {
    const f = await seed()
    const link = (await sendBill(f)).body.data
    const r = await finalizePayLink(paid(link.id, 20, 'pi_short_1'))
    expect(r.recorded).toBe(false)
    expect(r.reason).toBe('amount mismatch')
    expect(await bill(f.billId)).toMatchObject({ status: 'unbilled', paid_at: null })
    expect((await settlements(link.id))[0]).toMatchObject({ status: 'open' })
  })
})

/**
 * 10/20 (review) — THE SAME LINK, PAID AT THE COUNTER.
 *
 * Nic's words are about the LINK, not about Stripe: "a paylink's utility line
 * settles the bill and counts as recovery." A final bill emailed to somebody
 * who then walks in and pays cash is the ordinary case at a park office, and
 * the register is built for exactly it — POSPage loads the link ("This is
 * already out on the open list — charge it here") and the clerk presses Charge.
 *
 * Before this fix that door took the money, marked the link paid and settled
 * nothing: the bill stayed 'billed', the charge stayed on the payer's invoice,
 * the settlement row stayed 'open' forever (so the bill could never be sent
 * again, and /cancel refuses a link that is not open), and the recovery report
 * still read the money as owed. Andres Razo's $163.17 is the live shape.
 */
describe('a utility bill settled at the counter, not online', () => {
  const settle = (f: any, body: any = {}) => request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${f.token}`)
    .send({ paymentMethod: 'cash', propertyId: f.propertyId, items: [], ...body })

  it('closes out the bill, takes the charge off their invoice, and records the recovery', async () => {
    const f = await seed({ onInvoice: true })
    const link = (await sendBill(f)).body.data

    // The clerk opens the link at the register and presses Charge. An empty
    // cart settles it exactly as it was sent.
    const res = await settle(f, { payLinkId: link.id })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBeCloseTo(44.94, 2)
    expect((await db.query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link.id])).rows[0].status).toBe('paid')

    // THE BILL IS CLOSED OUT — the same answer the card page gives.
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })
    expect((await bill(f.billId)).paid_at).not.toBeNull()
    const s = await settlements(link.id)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ status: 'settled', utility_bill_id: f.billId, pos_transaction_id: res.body.data.id })
    expect(s[0].settled_at).not.toBeNull()

    // NOBODY IS ASKED TWICE: the charge on their invoice is voided and the
    // invoice's totals follow it. Without this, their next statement asks for
    // the same $44.94 they just paid in cash.
    const charge = (await db.query<any>(`SELECT status, void_reason FROM payments WHERE id = $1`, [f.paymentId!])).rows[0]
    expect(charge.status).toBe('voided')
    expect(charge.void_reason).toMatch(/Collected on a pay link/)
    expect(Number((await db.query<any>(`SELECT total_amount FROM invoices WHERE id = $1`, [f.invoiceId!])).rows[0].total_amount)).toBe(0)

    // COUNTED ONCE at the counter too: the bill is the record, and the sale's
    // bill line is invisible to the recovery report's register sweep (no
    // category to match, no recovers_utility snapshot).
    const swept = await sweptAsRecovery(res.body.data.id)
    expect(swept).toHaveLength(1)
    expect(swept[0]).toMatchObject({ recovers_utility: null, swept: false })

    // And the bill is off the sendable list for good — not stuck behind a
    // settlement row nobody can close.
    const list = await request(buildApp()).get(`/api/pos/pay-links/utility-bills?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data).toHaveLength(0)
  })

  it('the Andres shape at the counter: an electric line rung by hand counts as recovery', async () => {
    const f = await seed()
    // 387 kWh of August power at $0.21 — the link he was actually sent — paid
    // in cash at the desk instead of on the card page.
    const sent = await request(buildApp()).post('/api/pos/pay-links')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, items: [{ id: f.electricItemId, name: 'Electric (per kWh)', cat: 'Utilities', qty: 387, price: 0.21 }],
              customer: { name: 'Andres Razo', email: 'razoandres60@example.com' } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)

    const res = await settle(f, { payLinkId: sent.body.data.id })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const s = await settlements(sent.body.data.id)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ status: 'settled', utility_bill_id: null, utility_type: 'electric',
      pos_transaction_id: res.body.data.id })
    expect(Number(s[0].charge_amount)).toBe(81.27)
  })

  it('refuses the link when the bill was paid some other way — nothing is charged', async () => {
    const f = await seed()
    const link = (await sendBill(f)).body.data
    // Paid on their portal bill, or settled at another register, in the
    // meantime. Taking cash for it here would be the same money twice.
    await db.query(`UPDATE utility_bills SET status = 'paid', paid_at = NOW() WHERE id = $1`, [f.billId])

    const res = await settle(f, { payLinkId: link.id })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toMatch(/already paid/i)
    expect(res.body.error).toMatch(/[Nn]othing was charged/)
    // And the step it gives has to work: opening the link again would refuse
    // again. Closing it is what lets go of the bill.
    expect(res.body.error).toMatch(/close the link under Pay Links/i)
    // No sale, the link is still out, and its settlement row is still just an ask.
    expect((await db.query(`SELECT 1 FROM pos_transactions`)).rows).toHaveLength(0)
    expect((await db.query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link.id])).rows[0].status).toBe('open')
    expect((await settlements(link.id))[0]).toMatchObject({ status: 'open' })
  })

  it('the bill line cannot be taken off at the counter — a bill is never closed by a sale that did not charge it', async () => {
    const f = await seed({ onInvoice: true })
    const link = (await sendBill(f)).body.data
    // The clerk clears the bill line and rings up something else on the link.
    const res = await settle(f, { payLinkId: link.id,
      items: [{ id: f.electricItemId, name: 'Electric (per kWh)', qty: 5, price: 0.21, tax: 0 }] })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body.error).toMatch(/that line is the bill itself/i)
    // Nothing moved: the bill is still owed and still on their invoice.
    expect(await bill(f.billId)).toMatchObject({ status: 'billed', paid_at: null })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [f.paymentId!])).rows[0].status).toBe('pending')
    expect((await settlements(link.id))[0]).toMatchObject({ status: 'open' })
  })
})

describe('a refund undoes the recovery', () => {
  const refund = (f: any, saleId: string, body: any) => request(buildApp())
    .post(`/api/pos/transactions/${saleId}/refund`)
    .set('Authorization', `Bearer ${f.token}`).send({ refundMethod: 'cash', reason: 'Overbilled', ...body })

  const noteOfType = (type: string) =>
    notifyMock.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.type === type)

  /** A link out for one $44.94 bill, paid. Returns the sale. */
  async function paidBillLink(f: any, pi: string) {
    const link = (await sendBill(f)).body.data
    const { charged } = payLinkCharge(44.94)
    await finalizePayLink(paid(link.id, charged, pi))
    const sale = (await db.query<any>(`SELECT id, total::text AS total FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows[0]
    return { link, sale, charged }
  }

  it('the WHOLE sale going back puts the bill back on the books and stops it counting', async () => {
    const f = await seed({ onInvoice: true })
    const { link, sale } = await paidBillLink(f, 'pi_refund_full')

    const r = await refund(f, sale.id, {})          // no amount = the whole sale
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    // Every dollar went back, so none of it was recovered.
    expect((await settlements(link.id))[0]).toMatchObject({ status: 'refunded' })
    expect((await settlements(link.id))[0].refunded_at).not.toBeNull()
    // The bill is owed again, and stranded so the sweep can re-bill it.
    expect(await bill(f.billId)).toMatchObject({ status: 'billed', paid_at: null, payment_id: null })
    // The voided charge stays voided — GAM writes a new ask, never rewrites an old one.
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [f.paymentId!])).rows[0].status).toBe('voided')
    // And somebody is told.
    const note = noteOfType('utility_bill_owed_again')
    expect(note).toBeTruthy()
    expect(note.title).toMatch(/\$44\.94 of utility back on the books/)
  })

  // 10/20 (fix) — THE $5 THAT RE-BILLED $44.94.
  //
  // The desk sends September's $44.94 of electric as a link, the payer pays it,
  // then the desk hands $5 back (misread, goodwill, whatever). The first build
  // put the WHOLE $44.94 back on the books with payment_id cleared, so the
  // straggler sweep re-attached it to an invoice and the resident was asked
  // again for $39.94 that is sitting in the landlord's bank.
  it('a PART refund leaves the bill closed out and asks nobody for money the landlord is holding', async () => {
    const f = await seed({ onInvoice: true })
    const { link, sale } = await paidBillLink(f, 'pi_refund_part')

    const r = await refund(f, sale.id, { amount: 5 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    // The refund itself happened — this is not a refusal, it is what follows it.
    expect(Number((await db.query<any>(
      `SELECT COALESCE(SUM(amount),0)::text AS s FROM pos_refunds WHERE transaction_id = $1`, [sale.id])).rows[0].s)).toBe(5)

    // THE BILL IS STILL CLOSED OUT. Nobody is re-billed for money still here.
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })
    expect((await bill(f.billId)).paid_at).not.toBeNull()
    // The settlement still says the money was collected — and says underneath
    // it that part of the sale went back.
    const s = (await settlements(link.id))[0]
    expect(s).toMatchObject({ status: 'settled', refunded_at: null })
    expect(s.notes).toMatch(/Refunded \$5\.00/)
    expect(s.notes).toMatch(/part of the sale only/)

    // And the account holder is told, with the real figures, that it is theirs
    // to call — never told a bill came back, because none did.
    expect(noteOfType('utility_bill_owed_again')).toBeFalsy()
    const note = noteOfType('utility_part_refund_kept')
    expect(note).toBeTruthy()
    expect(note.title).toBe('$5.00 was refunded on a sale that had paid $44.94 of utility')
    expect(note.body).toMatch(/still closed out/)
    expect(note.body).toMatch(/money you are still holding/)
    expect(note.data).toMatchObject({ refunded: 5, stillCollected: 44.94 })
  })

  // The sharper edge of the same bug: a link can carry up to 24 bills, and
  // refunding one of them used to reopen ALL of them.
  it('a part refund on a two-bill link reopens neither — not even the one whose figure it matches', async () => {
    const f = await seed()
    const c = await db.connect()
    let second: string
    try {
      second = await seedUtilityBill(c, {
        meterId: f.meterId, unitId: f.unitId, tenantId: f.tenantId, leaseId: f.leaseId,
        landlordId: f.landlordId, chargeAmount: 81.90, utilityType: 'electric',
        billingCycleMonth: '2026-08-01', status: 'unbilled',
      })
    } finally { c.release() }

    const link = (await sendBill(f, { billIds: [f.billId, second] })).body.data
    expect(Number(link.total)).toBe(126.84)
    const { charged } = payLinkCharge(126.84)
    await finalizePayLink(paid(link.id, charged, 'pi_refund_two_bills'))
    const sale = (await db.query<any>(`SELECT id FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows[0]
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })
    expect(await bill(second)).toMatchObject({ status: 'paid' })

    // Exactly August's figure handed back. It still proves nothing: the money
    // could have come off either line, and GAM does not guess with money.
    expect((await refund(f, sale.id, { amount: 81.90 })).status).toBe(200)
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })
    expect(await bill(second)).toMatchObject({ status: 'paid' })
    expect((await settlements(link.id)).map((x: any) => x.status)).toEqual(['settled', 'settled'])
    expect(noteOfType('utility_bill_owed_again')).toBeFalsy()
    expect(noteOfType('utility_part_refund_kept').title)
      .toBe('$81.90 was refunded on a sale that had paid $126.84 of utility')
  })

  it('part refunds that add up to the whole sale put the bill back on the books on the last one', async () => {
    const f = await seed({ onInvoice: true })
    const { link, sale, charged } = await paidBillLink(f, 'pi_refund_in_two')

    expect((await refund(f, sale.id, { amount: 5 })).status).toBe(200)
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })

    // The rest of it. Now every dollar of the sale has gone back.
    expect((await refund(f, sale.id, { amount: Math.round((charged - 5) * 100) / 100 })).status).toBe(200)
    expect(await bill(f.billId)).toMatchObject({ status: 'billed', paid_at: null, payment_id: null })
    expect((await settlements(link.id))[0]).toMatchObject({ status: 'refunded' })
    expect(noteOfType('utility_bill_owed_again')).toBeTruthy()
  })

  // ANDRES RAZO'S OWN LINK, the live shape read out of production: $589 of RV
  // site rent and two hand-rung electric lines, $81.27 of August and $81.90 of
  // September, $752.17 in lines. If the desk hands back the $589 because the
  // stay was cancelled, every cent of the $163.17 of power is still here — and
  // the sale's other line is exactly why a part refund proves nothing about it.
  it('the Andres shape: refunding the rent off a mixed link leaves all the power counted as recovered', async () => {
    const f = await seed()
    const sent = await request(buildApp()).post('/api/pos/pay-links')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, customer: { name: 'Andres Razo', email: 'razoandres60@example.com' },
              items: [
                { id: null, name: 'RV site — monthly', cat: 'Stays', qty: 1, price: 589 },
                { id: f.electricItemId, name: 'Electric (per kWh)', cat: 'Utilities', qty: 387, price: 0.21 },
                { id: f.electricItemId, name: 'Electric (per kWh) — September, RV 27', cat: 'Utilities', qty: 390, price: 0.21 },
              ] })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(Number(sent.body.data.total)).toBe(752.17)
    const { charged } = payLinkCharge(752.17)
    expect((await finalizePayLink(paid(sent.body.data.id, charged, 'pi_andres_part'))).recorded).toBe(true)
    const sale = (await db.query<any>(`SELECT id FROM pos_transactions WHERE pay_link_id = $1`, [sent.body.data.id])).rows[0]
    // $163.17 of electric, recorded as recovery with no bill behind it.
    const before = await settlements(sent.body.data.id)
    expect(before).toHaveLength(2)
    expect(Math.round(before.reduce((s: number, x: any) => s + Number(x.charge_amount), 0) * 100) / 100).toBe(163.17)

    // The stay is cancelled and the rent goes back. The power does not.
    expect((await refund(f, sale.id, { amount: 589 })).status).toBe(200)
    const after = await settlements(sent.body.data.id)
    expect(after.map((x: any) => x.status)).toEqual(['settled', 'settled'])
    expect(after.every((x: any) => x.refunded_at === null)).toBe(true)
    expect(Math.round(after.reduce((s: number, x: any) => s + Number(x.charge_amount), 0) * 100) / 100).toBe(163.17)
    expect(noteOfType('utility_bill_owed_again')).toBeFalsy()
    expect(noteOfType('utility_part_refund_kept').title)
      .toBe('$589.00 was refunded on a sale that had paid $163.17 of utility')
  })
})

describe('the migration is expand-only and re-runnable', () => {
  const FILE = '20261022100000_a_pay_links_utility_line_settles_the_bill.sql'

  it('applies twice more with no error and leaves the same shape', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8')
    // globalSetup already applied it once; these are applies two and three.
    await db.query(sql)
    await db.query(sql)
    const cols = (await db.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'utility_pay_link_settlements'
          AND column_name IN ('utility_bill_id','unit_id','meter_id','billing_cycle_month',
                              'utility_type','charge_amount','tax_amount','status','pos_transaction_item_id')
        ORDER BY column_name`)).rows
    expect(cols.map(c => [c.column_name, c.is_nullable])).toEqual([
      ['billing_cycle_month', 'YES'],
      ['charge_amount', 'NO'],
      ['meter_id', 'YES'],
      ['pos_transaction_item_id', 'YES'],
      ['status', 'NO'],
      ['tax_amount', 'NO'],
      ['unit_id', 'YES'],
      ['utility_bill_id', 'YES'],
      ['utility_type', 'NO'],
    ])
    // The two guards that make a double count impossible rather than unlikely,
    // and the change journal every money table carries.
    const idx = (await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'utility_pay_link_settlements'
        AND indexname IN ('upls_one_open_link_per_bill','upls_one_settlement_per_bill','upls_one_row_per_sale_line')
        ORDER BY indexname`)).rows
    expect(idx.map(i => i.indexname)).toEqual(
      ['upls_one_open_link_per_bill', 'upls_one_row_per_sale_line', 'upls_one_settlement_per_bill'])
    const trg = (await db.query(
      `SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
        WHERE c.relname = 'utility_pay_link_settlements' AND NOT g.tgisinternal
          AND g.tgfoid = 'audit_row_change'::regproc`)).rows
    expect(trg).toHaveLength(1)
  })

  it('the database refuses a second settlement of one bill, and a utility it does not know', async () => {
    const f = await seed()
    const link = (await sendBill(f)).body.data
    const { charged } = payLinkCharge(44.94)
    await finalizePayLink(paid(link.id, charged, 'pi_guard_1'))
    const settled = (await settlements(link.id))[0]
    await expect(db.query(
      `INSERT INTO utility_pay_link_settlements
         (pay_link_id, landlord_id, property_id, utility_bill_id, utility_type, charge_amount,
          status, settled_at, pos_transaction_id)
       VALUES ($1,$2,$3,$4,'electric',44.94,'settled',NOW(),$5)`,
      [link.id, f.landlordId, f.propertyId, f.billId, settled.pos_transaction_id]),
    ).rejects.toThrow(/upls_one_settlement_per_bill/)
    await expect(db.query(
      `INSERT INTO utility_pay_link_settlements
         (pay_link_id, landlord_id, property_id, utility_bill_id, utility_type, charge_amount, status)
       VALUES ($1,$2,$3,NULL,'electricity',1,'open')`,
      [link.id, f.landlordId, f.propertyId]),
    ).rejects.toThrow(/upls_utility_type_check|upls_no_bill_means_a_sale/)
  })
})

/**
 * 10/20 (review) — ONE LINK IS ONE PERSON'S BILL.
 *
 * Nic's words for what this door is: "the system needs to distinguish when a pay
 * link is sent to A PERSON that it closes out that electric." A link is that
 * person's invoice, and paying it closes out EVERY bill on it: each bill's
 * charge is voided off whatever invoice it sits on with the words "collected on
 * a pay link", each bill reads 'paid', and each is written down as utility
 * recovered.
 *
 * So two households' bills on ONE link is one household paying off the other's
 * debt without knowing it. Send Andres his $81.27 of power and Victor's $63.40
 * on the same link, and when Andres pays $144.67: Victor's utility charge is
 * voided off his bill as though he had paid it, his invoice is retotaled down,
 * his bill reads paid, and the $63.40 is recorded as money given back. GAM has
 * lost both the right to ask Victor for it and any sign it was ever owed — and
 * the void is the same void every honest collection writes, so nothing
 * downstream can tell them apart afterwards.
 *
 * Before the fix the link went out: the code noticed the payers differed and
 * simply named nobody on the sale, then emailed whichever bill yielded an
 * address first.
 */
describe('one link is one person\'s bill', () => {
  it('refuses two people\'s bills on one link, and sends each of them their own', async () => {
    const f = await seed({ onInvoice: true })
    await nameResident(f.tenantId, 'Andres', 'Razo')
    const n = await seedNeighbor(f)
    await nameResident(n.tenantId, 'Victor', 'Cardoza')

    // Both on the sendable list — one property, so one list, which is exactly
    // how a clerk comes to pick across two households.
    const list = await request(buildApp()).get(`/api/pos/pay-links/utility-bills?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data).toHaveLength(2)

    const both = await sendBill(f, { billIds: [f.billId, n.billId] })
    expect(both.status, JSON.stringify(both.body)).toBe(400)
    // Plain words that name both people and both bills, and a next step the
    // clerk has on the screen they are looking at.
    expect(both.body.error).toMatch(/not all one person's/i)
    expect(both.body.error).toContain('Andres Razo')
    expect(both.body.error).toContain('Victor Cardoza')
    expect(both.body.error).toContain('(RV 27)')
    expect(both.body.error).toContain('(RV 10)')
    expect(both.body.error).toMatch(/nothing was sent/i)

    // NOTHING WAS WRITTEN. No link went out, no bill is held, and no email left.
    expect((await db.query(`SELECT 1 FROM pos_pay_links`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM utility_pay_link_settlements`)).rows).toHaveLength(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()

    // Each person's own bill goes out on its own link, which is the whole of
    // what the clerk lost: two presses instead of one.
    const his = await sendBill(f)
    expect(his.status, JSON.stringify(his.body)).toBe(200)
    expect(his.body.data).toMatchObject({ total: 44.94, bills: 1 })
    const hers = await sendBill(f, { billIds: [n.billId] })
    expect(hers.status, JSON.stringify(hers.body)).toBe(200)
    expect(hers.body.data).toMatchObject({ total: 63.40, bills: 1 })
    // Each link names its own payer, so each sale lands on the right register
    // history instead of on nobody.
    const named = await db.query<any>(
      `SELECT id, tenant_id, customer_email FROM pos_pay_links WHERE id = ANY($1::uuid[])`,
      [[his.body.data.id, hers.body.data.id]])
    expect(named.rows.find((r: any) => r.id === his.body.data.id).tenant_id).toBe(f.tenantId)
    expect(named.rows.find((r: any) => r.id === hers.body.data.id).tenant_id).toBe(n.tenantId)
    expect(named.rows.find((r: any) => r.id === hers.body.data.id).customer_email).toMatch(/cardoza-/)

    // AND THE MONEY STAYS WHERE IT BELONGS. Andres pays his; Victor's bill is
    // as owed as it ever was — the charge still on his invoice, unvoided, at
    // its full figure.
    const { charged } = payLinkCharge(44.94)
    expect((await finalizePayLink(paid(his.body.data.id, charged, 'pi_one_payer'))).recorded).toBe(true)
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })
    expect(await bill(n.billId)).toMatchObject({ status: 'billed', paid_at: null })
    const victorsCharge = (await db.query<any>(
      `SELECT status, void_reason FROM payments WHERE id = $1`, [n.paymentId])).rows[0]
    expect(victorsCharge.status).toBe('pending')
    expect(victorsCharge.void_reason).toBeNull()
    expect(Number((await db.query<any>(
      `SELECT total_amount FROM invoices WHERE id = $1`, [n.invoiceId])).rows[0].total_amount)).toBe(63.40)
    // Nothing recorded Victor's $63.40 as recovered.
    expect((await db.query<any>(
      `SELECT 1 FROM utility_pay_link_settlements WHERE utility_bill_id = $1 AND status = 'settled'`,
      [n.billId])).rows).toHaveLength(0)
  })

  it('one person holding two spaces is still one person: both their bills ride one link', async () => {
    // "Household = one balance" (S652). The refusal is about PEOPLE, not about
    // tenancy rows — a resident who rents two spaces in the same park gets one
    // link for both, the way they get one balance.
    const f = await seed({ onInvoice: true })
    await nameResident(f.tenantId, 'Andres', 'Razo')
    const n = await seedNeighbor(f)
    // The second space is the SAME person's: one user, two tenancies.
    await db.query(`UPDATE tenants SET user_id = (SELECT user_id FROM tenants WHERE id = $2) WHERE id = $1`,
      [n.tenantId, f.tenantId])

    const both = await sendBill(f, { billIds: [f.billId, n.billId] })
    expect(both.status, JSON.stringify(both.body)).toBe(200)
    expect(both.body.data).toMatchObject({ total: 108.34, bills: 2 })
    // Both bills are held by the one link, and it names one of their tenancies
    // rather than nobody.
    expect(await settlements(both.body.data.id)).toHaveLength(2)
    const link = (await db.query<any>(`SELECT tenant_id FROM pos_pay_links WHERE id = $1`, [both.body.data.id])).rows[0]
    expect([f.tenantId, n.tenantId]).toContain(link.tenant_id)
  })
})

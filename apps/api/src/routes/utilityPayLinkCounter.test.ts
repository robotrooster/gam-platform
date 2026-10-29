/**
 * 10/20 (Nic) — THE OTHER DOOR: A UTILITY BILL'S PAY LINK PAID AT THE COUNTER.
 *
 *   "A lot of people that move out are going to get their final electric bill
 *    as a pay link anyway. So the system needs to distinguish when a pay link
 *    is sent to a person that it closes out that electric."
 *
 *   "to send somebody a pay link for their final bill, you would have to do it
 *    through the point of sale, right?... The point of sale is just an extension
 *    of things."
 *
 * The emailed card page was wired (finalizePayLink). THE TILL WAS NOT, and the
 * till is where a good share of these land: the final bill goes out as a link,
 * the payer walks in with cash, and the clerk charges the link at the counter.
 * That took the money, stamped the link paid, and left the bill owed — so the
 * resident was asked for the same kilowatts again on their next invoice, the
 * recovery report read the money as still owed (the gap bigger than the truth by
 * exactly what came in), and the bill was wedged: off the sendable list because
 * its settlement row was still an open ask, un-sendable because "a link is
 * already out", and the link could no longer be closed to let go of it.
 *
 * Run:
 *   DB_NAME=gam_plc_test TEST_DB_NAME=gam_plc_test GAM_TEST_WORKERS=1 \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261021220000 \
 *   npx vitest run src/routes/utilityPayLinkCounter.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailPayLinkMock, checkoutMock, notifyMock } = vi.hoisted(() => ({
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
  checkoutMock: vi.fn(async (_p: any) => ({ id: `cs_${Math.random().toString(36).slice(2)}`, url: 'https://checkout.stripe.test/x' })),
  notifyMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({ ...(await orig() as any), emailPayLink: emailPayLinkMock }))
vi.mock('../services/notifications', async (orig) => ({ ...(await orig() as any), createNotification: notifyMock }))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({
    checkout: { sessions: { create: checkoutMock, retrieve: async (id: string) => ({ id, status: 'open', payment_status: 'unpaid' }), expire: async (id: string) => ({ id, status: 'expired' }) } },
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
import { posPayLinksRouter } from './posPayLinks'
import { posRouter } from './pos'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/pos/pay-links', posPayLinksRouter)
  app.use('/api/pos', posRouter)
  app.use('/api/utility', utilityRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailPayLinkMock.mockClear(); checkoutMock.mockClear(); notifyMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_utility_paylink_counter'
})

/**
 * Mountain View's shapes: an RV space with its own electric submeter, a
 * resident who has left with $44.94 of September power on their invoice, and
 * the register's own "Electric (per kWh)" button at $0.21.
 */
async function seed() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`,
      [landlordId, `acct_test_counter_${Math.random().toString(36).slice(2, 10)}`])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 589 })
    // S652: display_label is what the park calls the space, and what prints.
    await c.query(`UPDATE units SET display_label = 'RV 27' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c, { email: `razo-${Math.random().toString(36).slice(2)}@example.com` })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 589 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric' })

    // The common case: the final bill is already a charge row on an invoice.
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

    const cat = await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Utilities') RETURNING id`, [landlordId])
    const item = await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price,
                              stock_qty, stock_min, stock_max, tax_rate, recovers_utility)
       VALUES ($1,$2,$3,'Electric (per kWh)',0.21,0,999,0,0,0,'electric') RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])

    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId,
      landlordId, landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId, meterId, billId,
             paymentId: pay.rows[0].id, invoiceId: inv.rows[0].id, electricItemId: item.rows[0].id, token }
  } finally { c.release() }
}

type F = Awaited<ReturnType<typeof seed>>

const sendBill = (f: F, body: any = {}) => request(buildApp()).post('/api/pos/pay-links/utility-bills')
  .set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId, billIds: [f.billId], ...body })

/** The clerk charges the link at the counter — cash in hand, no card page. */
const chargeAtCounter = (f: F, body: any) => request(buildApp()).post('/api/pos/transactions')
  .set('Authorization', `Bearer ${f.token}`).send({ paymentMethod: 'cash', propertyId: f.propertyId, ...body })

const bill = (id: string) => db.query<any>(
  `SELECT status, paid_at, payment_id FROM utility_bills WHERE id = $1`, [id]).then(r => r.rows[0])
const settlements = (linkId: string) => db.query<any>(
  `SELECT * FROM utility_pay_link_settlements WHERE pay_link_id = $1 ORDER BY created_at, id`, [linkId]).then(r => r.rows)
const link = (id: string) => db.query<any>(
  `SELECT status, pos_transaction_id FROM pos_pay_links WHERE id = $1`, [id]).then(r => r.rows[0])
const salesFor = (linkId: string) => db.query<any>(
  `SELECT * FROM pos_transactions WHERE pay_link_id = $1`, [linkId]).then(r => r.rows)
const sendable = async (f: F) => (await request(buildApp())
  .get(`/api/pos/pay-links/utility-bills?propertyId=${f.propertyId}`)
  .set('Authorization', `Bearer ${f.token}`)).body.data
/** The electric line of the recovery report, the way the landlord's page asks for it. */
const recovery = async (f: F) => ((await request(buildApp())
  .get(`/api/utility/recovery?propertyId=${f.propertyId}&from=2026-01-01&to=2026-12-31`)
  .set('Authorization', `Bearer ${f.token}`)).body.data?.lines ?? []).find((l: any) => l.utilityType === 'electric')

describe('a utility bill\'s pay link charged at the counter', () => {
  it('closes the bill out, takes the charge off their invoice, and the report stops reading it as owed', async () => {
    const f = await seed()
    const sent = await sendBill(f)
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    const linkId = sent.body.data.id

    // Sent, not paid: billed back and still owed.
    expect(await recovery(f)).toMatchObject({ recovered: 44.94, collected: 0, stillOwed: 44.94 })

    // The payer comes in with cash and the clerk charges the link.
    const sale = await chargeAtCounter(f, { payLinkId: linkId })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)

    // THE BILL IS CLOSED OUT — the same as if they had paid the card page.
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })
    expect((await bill(f.billId)).paid_at).not.toBeNull()
    expect(await link(linkId)).toMatchObject({ status: 'paid', pos_transaction_id: sale.body.data.id })

    // The settlement row is settled and names the sale that took the money —
    // not left as an open ask forever.
    const s = await settlements(linkId)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ status: 'settled', utility_bill_id: f.billId, pos_transaction_id: sale.body.data.id })
    expect(s[0].settled_at).not.toBeNull()

    // NOBODY IS ASKED TWICE: the charge on their invoice is voided — kept,
    // with its reason, and in no balance — and the invoice follows it.
    const charge = (await db.query<any>(`SELECT status, void_reason FROM payments WHERE id = $1`, [f.paymentId])).rows[0]
    expect(charge.status).toBe('voided')
    expect(charge.void_reason).toMatch(/Collected on a pay link/)
    const invoice = (await db.query<any>(`SELECT total_amount, subtotal_utilities FROM invoices WHERE id = $1`, [f.invoiceId])).rows[0]
    expect(Number(invoice.total_amount)).toBe(0)
    expect(Number(invoice.subtotal_utilities)).toBe(0)

    // AND THE MONEY READS AS RECOVERED, EXACTLY ONCE. Still $44.94 billed back
    // (the bill is the record; the sale's bill-raised line carries no
    // recovers_utility, so the register sweep cannot count it again), and now
    // collected in full rather than reading as a $44.94 shortfall.
    expect(await recovery(f)).toMatchObject({ recovered: 44.94, collected: 44.94, stillOwed: 0 })
  })

  it('leaves the bill off the sendable list and says it was PAID, not that a link is still out', async () => {
    const f = await seed()
    const linkId = (await sendBill(f)).body.data.id
    expect((await chargeAtCounter(f, { payLinkId: linkId })).status).toBe(201)

    expect(await sendable(f)).toHaveLength(0)
    // The wedge: while the settlement row sat open and the bill sat 'billed',
    // this said "a pay link is already out — close that link under Pay Links
    // first", and the link was paid by then, so the one step offered could
    // never be taken. The honest answer is that the money is in.
    const again = await sendBill(f)
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already paid/i)
    expect(again.body.error).not.toMatch(/already out/i)
    expect(again.body.error).not.toMatch(/Close that link/i)
  })

  it('refuses a bill that was paid some other way, charges nothing, and leaves the link alone', async () => {
    const f = await seed()
    const linkId = (await sendBill(f)).body.data.id
    // Settled at another register, or on their portal bill, in the meantime.
    await db.query(`UPDATE utility_bills SET status = 'paid', paid_at = NOW() WHERE id = $1`, [f.billId])

    const sale = await chargeAtCounter(f, { payLinkId: linkId })
    expect(sale.status, JSON.stringify(sale.body)).toBe(409)
    expect(sale.body.error).toMatch(/already paid/i)
    expect(sale.body.error).toMatch(/Nothing was charged here/)

    // Nothing was taken and nothing moved: no sale, the link is still open,
    // and the settlement row is still just an open ask.
    expect(await salesFor(linkId)).toHaveLength(0)
    expect(await link(linkId)).toMatchObject({ status: 'open' })
    expect((await settlements(linkId))[0]).toMatchObject({ status: 'open' })
    // Their invoice charge is untouched — the money came in somewhere else.
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [f.paymentId])).rows[0].status).toBe('pending')

    // AND THE STEP IT OFFERS WORKS. The link is still open, so closing it is
    // reachable and it lets go of the bill — never a refusal whose only advice
    // is to open the link again and be refused again.
    expect(sale.body.error).toMatch(/close the link/i)
    const closed = await request(buildApp()).post(`/api/pos/pay-links/${linkId}/cancel`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect((await settlements(linkId))[0]).toMatchObject({ status: 'cancelled' })
  })

  it('the bill line is the bill at the till too: it cannot be retyped, shrunk or left out of the cart', async () => {
    const f = await seed()
    const sentLink = (await sendBill(f)).body.data
    // The line as the REGISTER sends it back: the server's marks (the bill id
    // among them) do not survive the round trip through the cart (apps/pos
    // wireLine), which is exactly why the match is made on what it charges.
    const sent = (await db.query<any>(`SELECT items FROM pos_pay_links WHERE id = $1`, [sentLink.id])).rows[0].items[0]
    expect(sent.utilityBillId).toBe(f.billId)
    const line = { id: null, name: sent.name, qty: sent.qty, price: sent.price, tax: sent.tax }

    // Retyped at $10 — one amount taken, another closed out.
    const retyped = await chargeAtCounter(f, { payLinkId: sentLink.id, items: [{ ...line, price: 10 }] })
    expect(retyped.status, JSON.stringify(retyped.body)).toBe(400)
    expect(retyped.body.error).toMatch(/that line is the bill itself and stays as it is/i)
    expect(retyped.body.error).toMatch(/to stop asking for it, close the link/i)

    // Lifted out of the cart altogether and something else rung instead — the
    // bill would have read paid with nothing taken for it at all.
    const dropped = await chargeAtCounter(f, { payLinkId: sentLink.id,
      items: [{ id: f.electricItemId, name: 'Electric (per kWh)', cat: 'Utilities', qty: 10, price: 0.21 }] })
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(400)
    expect(dropped.body.error).toMatch(/that line is the bill itself and stays as it is/i)

    // Nothing was charged either time, and the bill is exactly as owed as it was.
    expect(await salesFor(sentLink.id)).toHaveLength(0)
    expect(await bill(f.billId)).toMatchObject({ status: 'billed', paid_at: null })
    expect(await link(sentLink.id)).toMatchObject({ status: 'open' })
    expect((await settlements(sentLink.id))[0]).toMatchObject({ status: 'open' })
  })

  /**
   * 10/20 (review) — AND THE DISCOUNT IS THE SAME THEFT WITH NOBODY'S
   * FINGERPRINTS ON THE LINE.
   *
   * The line guard above compares the line: its name, its price, its quantity
   * and its tax. A cart-level discount touches none of them. A manager loads
   * RV 27's $81.27 final electric into the register, presses Charge with $75.25
   * off, and the line guard passes: $6.02 in the drawer, the bill closed out as
   * paid in full, the whole $81.27 voided off the resident's debt with the same
   * "collected on a pay link" note an honest collection writes, and the
   * recovery report told $81.27 came in. Nothing afterwards reads as wrong.
   */
  it('a discount cannot come off the bill — not at the till, and not on the link', async () => {
    const f = await seed()
    // RV 27's final electric with the park's 8% utility tax on it: $75.25 + $6.02.
    await db.query(`UPDATE utility_bills SET charge_amount = 75.25, tax_rate_pct = 8, tax_amount = 6.02 WHERE id = $1`, [f.billId])
    await db.query(`UPDATE payments SET amount = 81.27 WHERE id = $1`, [f.paymentId])
    await db.query(`UPDATE invoices SET total_amount = 81.27, subtotal_utilities = 81.27 WHERE id = $1`, [f.invoiceId])
    const sentLink = (await sendBill(f)).body.data
    expect(sentLink.total).toBe(81.27)
    expect(await recovery(f)).toMatchObject({ recovered: 81.27, collected: 0, stillOwed: 81.27 })
    const sent = (await db.query<any>(`SELECT items FROM pos_pay_links WHERE id = $1`, [sentLink.id])).rows[0].items[0]
    const line = { id: null, name: sent.name, qty: sent.qty, price: sent.price, tax: sent.tax }

    // The whole charge knocked off: the till takes the tax and nothing else.
    const discounted = await chargeAtCounter(f, { payLinkId: sentLink.id, items: [line], discountAmount: 75.25 })
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(400)
    expect(discounted.body.error).toMatch(/no discount comes off it/i)
    expect(discounted.body.error).toMatch(/to stop asking for the bill, close the link/i)

    // A dollar off is the same answer — a bill is collected in full or it is
    // not collected. There is no size of discount that is honest here.
    const dollarOff = await chargeAtCounter(f, { payLinkId: sentLink.id, items: [line], discountAmount: 1 })
    expect(dollarOff.status, JSON.stringify(dollarOff.body)).toBe(400)

    // Nothing was charged: the bill is as owed as it was, the charge is still
    // on their invoice, and the link is still out with its open ask.
    expect(await salesFor(sentLink.id)).toHaveLength(0)
    expect(await bill(f.billId)).toMatchObject({ status: 'billed', paid_at: null })
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [f.paymentId])).rows[0].status).toBe('pending')
    expect(await link(sentLink.id)).toMatchObject({ status: 'open' })
    expect((await settlements(sentLink.id))[0]).toMatchObject({ status: 'open' })

    // NOR ON THE LINK ITSELF. Adjust can put a discount on an open link, which
    // would leave the payer's own card page asking $6.02 for a bill that closes
    // out at $81.27 — the till's hole, reached from the Pay Links screen.
    const adjusted = await request(buildApp()).patch(`/api/pos/pay-links/${sentLink.id}`)
      .set('Authorization', `Bearer ${f.token}`).send({ items: [line], discountAmount: 75.25 })
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(400)
    expect(adjusted.body.error).toMatch(/no discount comes off it/i)
    const stillAsks = (await db.query<any>(
      `SELECT discount_amount, total FROM pos_pay_links WHERE id = $1`, [sentLink.id])).rows[0]
    expect(Number(stillAsks.discount_amount)).toBe(0)
    expect(Number(stillAsks.total)).toBe(81.27)

    // AND THE HONEST COLLECTION STILL GOES THROUGH, at the bill's own figure.
    const paid = await chargeAtCounter(f, { payLinkId: sentLink.id, items: [line] })
    expect(paid.status, JSON.stringify(paid.body)).toBe(201)
    expect(Number(paid.body.data.total)).toBe(81.27)
    expect(await bill(f.billId)).toMatchObject({ status: 'paid' })
    expect(await recovery(f)).toMatchObject({ recovered: 81.27, collected: 81.27, stillOwed: 0 })
  })
})

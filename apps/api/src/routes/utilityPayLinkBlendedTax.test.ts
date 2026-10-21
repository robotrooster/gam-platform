/**
 * 10/20 (fix) — ONE BILL, TWO DOORS, AND THEY HAVE TO ASK FOR THE SAME MONEY.
 *
 * A utility bill's tax is not always one rate. Sewer rides the water meter
 * (S533: there is no sewer meter in the field, and the tenant sees ONE line
 * item), so a water bill's tax is water × the water rate PLUS sewer × the
 * sewer rate, while utility_bills.tax_rate_pct snapshots only the first of the
 * two. Oak Park's answers on the Utilities page — Water 8%, Sewer left blank —
 * are both ordinary, and leaving a field blank is the common case.
 *
 * The emailed card page asked the bill's own money and was right. The SAME link
 * settled at the counter re-derived the tax from that one percentage and was
 * wrong by 96¢ on a $28.20 bill: it took $29.16, closed the bill out at $28.20
 * anyway, and booked the difference as sales tax owed to an agency nobody owes
 * it to. Swap the landlord's two answers (Water blank, Sewer 8%) and the
 * counter took NO tax while the bill read $0.96 of tax paid in full. Neither
 * left a trace anybody could read afterwards: the bill says paid in full, the
 * recovery report says collected, and only the drawer disagrees.
 *
 * So the rate on a bill's line is the BILL'S OWN TWO FIGURES DIVIDED
 * (payLinkLineForBill / billLineTaxRate), and a line the server wrote comes
 * back from the register at the server's figures, not the register's copy of
 * them (assertUtilityBillLinesKept, keepLinkServerLines).
 *
 * The bill here is written by the real billing arithmetic
 * (utilityBilling generateBillsForMeter) off a real pair of meter reads, so the
 * premise is production's and not this file's.
 *
 * Run:
 *   DB_NAME=gam_blend_test TEST_DB_NAME=gam_blend_test GAM_TEST_WORKERS=1 \
 *   npx vitest run src/routes/utilityPayLinkBlendedTax.test.ts
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
  seedUtilityMeter,
} from '../test/dbHelpers'
import { generateBillsForMeter } from '../services/utilityBilling'
import { posPayLinksRouter } from './posPayLinks'
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_utility_paylink_blend'
})

const CYCLE = '2026-09-01'

/**
 * RV 27's water submeter: 0.005/gal of water with 0.004/gal of sewer riding
 * it, read at 0 on 8/31 and 3,000 on 9/30. 3,000 gallons is $15.00 of water
 * and $12.00 of sewer — one $27.00 charge on one bill, as the tenant sees it.
 *
 * `taxes` is what the landlord typed into the Utilities page's tax card, with
 * a blank field simply absent — the shape the page actually writes.
 */
async function seed(taxes: { water?: number; sewer?: number }) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`,
      [landlordId, `acct_test_blend_${Math.random().toString(36).slice(2, 10)}`])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 589 })
    await c.query(`UPDATE units SET display_label = 'RV 27' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c, { email: `blend-${Math.random().toString(36).slice(2)}@example.com` })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 589 })
    await seedLeaseTenant(c, { leaseId, tenantId })

    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'water' })
    await c.query(
      `UPDATE utility_meters SET rate_per_unit = 0.005, sewer_rate_per_unit = 0.004 WHERE id = $1`, [meterId])
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    await c.query(
      `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
       VALUES ($1, 'water', TRUE)`, [leaseId])
    for (const [type, pct] of Object.entries(taxes)) {
      await c.query(
        `INSERT INTO property_utility_tax_rates (property_id, utility_type, tax_rate_pct) VALUES ($1, $2, $3)`,
        [propertyId, type, pct])
    }
    // The read before (the 8/31 walk) and this cycle's own (the 9/30 walk).
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, billing_cycle_month, reading_value, reading_date, reason, created_by_user_id)
       VALUES ($1, '2026-08-01', 0, '2026-08-31', 'monthly_cycle', $2)`, [meterId, userId])
    await c.query(
      `INSERT INTO utility_meter_readings (meter_id, billing_cycle_month, reading_value, reading_date, reason, created_by_user_id)
       VALUES ($1, $3, 3000, '2026-09-30', 'monthly_cycle', $2)`, [meterId, userId, CYCLE])

    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId,
      landlordId, landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId, meterId, token }
  } finally { c.release() }
}

type F = Awaited<ReturnType<typeof seed>>

/** The bill production's own arithmetic writes for this cycle. */
async function billTheRealWay(f: F) {
  const r = await generateBillsForMeter(f.meterId, new Date(`${CYCLE}T12:00:00Z`))
  const rows = (await db.query<any>(
    `SELECT id, charge_amount::text AS charge, tax_amount::text AS tax, tax_rate_pct::text AS pct, status
       FROM utility_bills WHERE meter_id = $1 AND billing_cycle_month = $2`, [f.meterId, CYCLE])).rows
  expect(rows, `generateBillsForMeter: ${r.reason ?? ''}`).toHaveLength(1)
  return { ...rows[0], charge: Number(rows[0].charge), tax: Number(rows[0].tax), pct: Number(rows[0].pct) }
}

const sendBill = (f: F, billId: string) => request(buildApp()).post('/api/pos/pay-links/utility-bills')
  .set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId, billIds: [billId] })

/** The clerk charges the link at the counter — cash in hand, no card page. */
const chargeAtCounter = (f: F, body: any) => request(buildApp()).post('/api/pos/transactions')
  .set('Authorization', `Bearer ${f.token}`).send({ paymentMethod: 'cash', propertyId: f.propertyId, ...body })

const linkRow = (id: string) => db.query<any>(
  `SELECT items, subtotal::text AS subtotal, tax_amount::text AS tax, total::text AS total
     FROM pos_pay_links WHERE id = $1`, [id]).then(r => r.rows[0])
const saleRow = (id: string) => db.query<any>(
  `SELECT subtotal::text AS subtotal, tax_amount::text AS tax, total::text AS total FROM pos_transactions WHERE id = $1`,
  [id]).then(r => r.rows[0])
const settlementRow = (linkId: string) => db.query<any>(
  `SELECT status, charge_amount::text AS charge, tax_amount::text AS tax
     FROM utility_pay_link_settlements WHERE pay_link_id = $1`, [linkId]).then(r => r.rows[0])

describe('a utility bill whose tax is more than one rate', () => {
  it('Water 8% with Sewer blank: the counter takes the BILL\'S $28.20, not $29.16', async () => {
    const f = await seed({ water: 8 })
    const b = await billTheRealWay(f)

    // THE PREMISE, from production's own arithmetic: $15.00 of water at 8% and
    // $12.00 of sewer at nothing is $1.20 of tax on a $27.00 charge — and the
    // percentage the bill snapshotted is the WATER rate alone, which does not
    // reproduce it. That is the whole trap.
    expect(b.charge).toBeCloseTo(27, 2)
    expect(b.tax).toBeCloseTo(1.2, 2)
    expect(b.pct).toBeCloseTo(8, 4)
    expect(b.charge * b.pct / 100).toBeCloseTo(2.16, 2)   // what re-deriving gives
    expect(b.charge * b.pct / 100).not.toBeCloseTo(b.tax, 2)

    // THE ONLINE DOOR asks the bills' own money.
    const sent = await sendBill(f, b.id)
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(Number(sent.body.data.total)).toBeCloseTo(28.2, 2)
    const link = await linkRow(sent.body.data.id)
    expect(Number(link.subtotal)).toBeCloseTo(27, 2)
    expect(Number(link.tax)).toBeCloseTo(1.2, 2)
    expect(Number(link.total)).toBeCloseTo(28.2, 2)

    // THE COUNTER DOOR, on the same link, must ask the same money. An empty
    // cart is the clean path: the server's own line, straight off the link.
    const sale = await chargeAtCounter(f, { payLinkId: sent.body.data.id })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    const tx = await saleRow(sale.body.data.id)
    expect(Number(tx.subtotal)).toBeCloseTo(27, 2)
    expect(Number(tx.tax)).toBeCloseTo(1.2, 2)      // was 2.16
    expect(Number(tx.total)).toBeCloseTo(28.2, 2)   // was 29.16

    // And the bill is closed out at the figure that was actually taken.
    expect(await settlementRow(sent.body.data.id)).toMatchObject({ status: 'settled' })
    const s = await settlementRow(sent.body.data.id)
    expect(Number(s.charge)).toBeCloseTo(27, 2)
    expect(Number(s.tax)).toBeCloseTo(1.2, 2)

    // The sale's own line records the tax AS TAX at the rate that produced it,
    // so GAM Books splits the sale's tax by the line it came off.
    const li = (await db.query<any>(
      `SELECT subtotal::text AS subtotal, tax_rate::text AS rate FROM pos_transaction_items WHERE transaction_id = $1`,
      [sale.body.data.id])).rows
    expect(li).toHaveLength(1)
    expect(Number(li[0].subtotal) * Number(li[0].rate)).toBeCloseTo(1.2, 2)
  })

  it('the register\'s own copy of the line settles it at the same money', async () => {
    const f = await seed({ water: 8 })
    const b = await billTheRealWay(f)
    const linkId = (await sendBill(f, b.id)).body.data.id
    // The line as the register sends it back: the server's marks (the bill id
    // among them) do not survive the round trip through the cart.
    const l = (await linkRow(linkId)).items[0]
    const sale = await chargeAtCounter(f, { payLinkId: linkId,
      items: [{ id: null, name: l.name, qty: l.qty, price: l.price, tax: l.tax }] })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number((await saleRow(sale.body.data.id)).total)).toBeCloseTo(28.2, 2)
  })

  it('Water blank with Sewer 8%: the counter takes the $0.96 of tax, not nothing', async () => {
    const f = await seed({ sewer: 8 })
    const b = await billTheRealWay(f)
    // The mirror image: the bill's snapshotted percentage is ZERO, so
    // re-deriving collected no tax at all on a bill that says $0.96 is owed.
    expect(b.charge).toBeCloseTo(27, 2)
    expect(b.tax).toBeCloseTo(0.96, 2)
    expect(b.pct).toBeCloseTo(0, 4)

    const sent = await sendBill(f, b.id)
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(Number(sent.body.data.total)).toBeCloseTo(27.96, 2)

    const sale = await chargeAtCounter(f, { payLinkId: sent.body.data.id })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    const tx = await saleRow(sale.body.data.id)
    expect(Number(tx.tax)).toBeCloseTo(0.96, 2)     // was 0.00
    expect(Number(tx.total)).toBeCloseTo(27.96, 2)  // was 27.00
  })

  it('Adjust cannot re-rate the bill either — the line goes back as the server wrote it', async () => {
    const f = await seed({ water: 8 })
    const b = await billTheRealWay(f)
    const linkId = (await sendBill(f, b.id)).body.data.id
    const l = (await linkRow(linkId)).items[0]

    // Same name, same price, same quantity — and the tax stripped off. Every
    // figure the kept-line guard matches on is untouched, so it passed, and the
    // link was re-priced to $27.00 while the bill still read $28.20.
    const adjusted = await request(buildApp()).patch(`/api/pos/pay-links/${linkId}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ items: [{ id: null, name: l.name, qty: l.qty, price: l.price, tax: 0 }] })
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200)
    const after = await linkRow(linkId)
    expect(Number(after.tax)).toBeCloseTo(1.2, 2)      // was 0.00
    expect(Number(after.total)).toBeCloseTo(28.2, 2)   // was 27.00
    expect(Number(after.items[0].price) * Number(after.items[0].tax)).toBeCloseTo(1.2, 2)
    // And it is still the bill's line: the id it closes out rode through.
    expect(after.items[0].utilityBillId).toBe(b.id)
  })
})

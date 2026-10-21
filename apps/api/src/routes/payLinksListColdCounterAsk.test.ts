/**
 * 10/20 (review) — THE PAY LINKS LIST IS THE OTHER DOOR A DEAD COUNTER ASK HAS
 * TO BE LET GO AT.
 *
 * A closing read raised at the register opens an ask ("the desk is collecting
 * this right now"), and that ask is what keeps the bill off the Pay Links list
 * while the ticket is open — one place to pay, which is the whole of D1. Every
 * press that ends the ticket lets the ask go; the one case no press covers is
 * the browser dying mid-ticket, and for that there is the twelve-hour sweep
 * (releaseStaleCounterAsks).
 *
 * The sweep hung off ONE door: the counter's own lookup. So it only ran when
 * somebody at that park took ANOTHER closing read. At a park where nobody does
 * — Nic has two, and one of them is quiet for days at a stretch — the bill sat
 * off the Pay Links list and on nobody's invoice for as long as the quiet
 * lasted, which is days, not twelve hours. D2 says an uncollected bill is owed
 * the ordinary way; it cannot be owed the ordinary way at a door that is still
 * hiding it.
 *
 * The list the bill is MISSING FROM is the right place to check, and it costs
 * one UPDATE on a page a landlord opens by hand.
 *
 * Run:
 *   DB_NAME=gam_sweepdoor_test TEST_DB_NAME=gam_sweepdoor_test GAM_TEST_WORKERS=1 \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261022140000 \
 *   npx vitest run src/routes/payLinksListColdCounterAsk.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Nothing in here sends anything. The mocks are the suite's standing guard
// against a real address being reached from a test.
const { emailMock } = vi.hoisted(() => ({ emailMock: vi.fn(async (..._a: any[]) => undefined) }))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  sendEmail: emailMock, emailPayLink: emailMock,
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
  seedUtilityMeter,
} from '../test/dbHelpers'
import { posPayLinksRouter } from './posPayLinks'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/pos/pay-links', posPayLinksRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_cold_counter_ask'
})

const cycle = () => `${new Date().toISOString().slice(0, 8)}01`

/**
 * A quiet park with ONE departing resident's electric bill on it, and the
 * counter's ask for that bill still open — raised `askAgeHours` ago on a ticket
 * nobody ever settled. `askAgeHours` is the only thing that differs between a
 * desk that is mid-ticket right now and a browser that died yesterday.
 */
async function parkHoldingABill(opts: { askAgeHours: number }) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 589 })
    await c.query(`UPDATE units SET display_label = 'RV 27' WHERE id = $1`, [unitId])
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric' })
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 589, status: 'expired' })
    await seedLeaseTenant(c, { leaseId, tenantId })

    // The final bill, exactly as the counter's confirm door leaves it: owed,
    // on nobody's invoice, nothing emailed for it.
    const bill = await c.query<{ id: string }>(
      `INSERT INTO utility_bills
         (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
          usage_amount, charge_amount, tax_amount, tax_rate_pct, utility_type, status)
       VALUES ($1,$2,$3,$4,$5,$6::date, 311, 65.31, 5.22, 8, 'electric', 'unbilled')
       RETURNING id`,
      [meterId, unitId, tenantId, leaseId, landlordId, cycle()])
    const billId = bill.rows[0].id

    // The counter's ask, in the same book the emailed version writes to.
    const ask = await c.query<{ id: string }>(
      `INSERT INTO utility_pay_link_settlements
         (pay_link_id, raised_at_counter, landlord_id, property_id, utility_bill_id,
          unit_id, meter_id, billing_cycle_month, utility_type, charge_amount, tax_amount,
          status, created_by, created_at)
       VALUES (NULL, TRUE, $1, $2, $3, $4, $5, $6::date, 'electric', 65.31, 5.22,
               'open', $7, NOW() - ($8 || ' hours')::interval)
       RETURNING id`,
      [landlordId, propertyId, billId, unitId, meterId, cycle(), userId, String(opts.askAgeHours)])

    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId,
      landlordId, landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, meterId, billId, askId: ask.rows[0].id, token }
  } finally { c.release() }
}
type Park = Awaited<ReturnType<typeof parkHoldingABill>>

/** The landlord opening Pay Links → utility bills: what could be sent as a link. */
const sendableList = (p: Park) => request(buildApp())
  .get(`/api/pos/pay-links/utility-bills?propertyId=${p.propertyId}`)
  .set('Authorization', `Bearer ${p.token}`)

const ask = (askId: string) => db.query<any>(
  `SELECT status, cancelled_at, notes FROM utility_pay_link_settlements WHERE id = $1`, [askId])
  .then(r => r.rows[0])
const bill = (billId: string) => db.query<any>(
  `SELECT status, paid_at, payment_id FROM utility_bills WHERE id = $1`, [billId])
  .then(r => r.rows[0])

describe('a counter ask nobody came back to, at a park where nobody takes another read', () => {
  it('is let go when the list it is hiding the bill from is opened, and the bill is offered again', async () => {
    const p = await parkHoldingABill({ askAgeHours: 20 })

    // Before: the ask holds the bill off the list, which is correct while a
    // desk is collecting it — and wrong forever after the browser died.
    expect((await ask(p.askId)).status).toBe('open')

    const list = await sendableList(p)
    expect(list.status, JSON.stringify(list.body)).toBe(200)

    // D2: the ask is let go (kept, with its reason — GAM never erases) and the
    // bill is on the list to be emailed, exactly as the ordinary route expects
    // to find it.
    const a = await ask(p.askId)
    expect(a.status).toBe('cancelled')
    expect(a.cancelled_at).not.toBeNull()
    expect(String(a.notes)).toMatch(/never settled/i)
    expect(list.body.data.map((b: any) => b.billId)).toContain(p.billId)

    // Nothing was written off and nothing was emailed: the bill is owed exactly
    // as it was, and the landlord is the one who decides to send it.
    expect(await bill(p.billId)).toMatchObject({ status: 'unbilled', paid_at: null, payment_id: null })
    expect(emailMock).not.toHaveBeenCalled()
  })

  it('does not touch an ask raised minutes ago — that desk is collecting it right now', async () => {
    const p = await parkHoldingABill({ askAgeHours: 1 })

    const list = await sendableList(p)
    expect(list.status, JSON.stringify(list.body)).toBe(200)

    // One place to pay (D1): while the ticket is open the bill is the ticket's,
    // so it is not offered as a link beside it.
    expect((await ask(p.askId)).status).toBe('open')
    expect(list.body.data.map((b: any) => b.billId)).not.toContain(p.billId)
  })
})

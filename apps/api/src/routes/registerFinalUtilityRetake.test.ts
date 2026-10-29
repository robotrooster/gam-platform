/**
 * 10/21 — TAKING THE CLOSING READ A SECOND TIME.
 *
 *   "I don't want it to generate a bill."  (D1 — the ticket IS the bill)
 *
 * The desk raises Curtis's final electric at the counter, the card page refuses,
 * and the desk does the only thing a front desk ever does next: takes the read
 * again with Curtis still standing there. Before this, that was the end of the
 * road. The bill was left owed on purpose (D2) and still occupied the one slot
 * per meter, space and month, so the engine's insert hit that index, answered
 * false, and the desk was told "this month was already billed on this space (the
 * monthly run read it)" — which it was not. Nothing went on the ticket, no fresh
 * ask was raised, and the $87.77 was reachable only by emailing a pay link: the
 * second place to pay that D1 exists to prevent, and the one with nobody
 * standing at it.
 *
 * Every press also wrote another 'move_out_final' row, so a card that failed
 * twice left three readings of a meter somebody read once.
 *
 * These live in their own file rather than beside the rest of the counter's
 * suite because the retake is its own question — can this door be used twice —
 * and because the answer has to stay provable on its own when that suite grows.
 *
 * Run:
 *   DB_NAME=gam_cread_test TEST_DB_NAME=gam_cread_test GAM_TEST_WORKERS=1 \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261022140000 \
 *   npx vitest run src/routes/registerFinalUtilityRetake.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// NOTHING IS EVER SENT FROM A TEST. Both senders are mocked and both are
// asserted on: D1's whole point is that this door emails nobody, so a silent
// real send would be the bug passing itself.
const { notifyMock, emailMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(async (..._a: any[]) => undefined),
  emailMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/notifications', async (orig) => ({ ...(await orig() as any), createNotification: notifyMock }))
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
import { posRouter } from './pos'
import { posPayLinksRouter } from './posPayLinks'
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
  notifyMock.mockClear(); emailMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_register_final_utility_retake'
})

const day = (n: number) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Mountain View's shape, the same one the counter's own suite uses: an RV space
 * with its own electric submeter at $0.21 a kilowatt, the park's 8% utility tax,
 * and a prior read of 48,000 taken eight days ago. A closing read of 48,387 is
 * 387 kWh — $81.27 plus $6.50 tax, the $87.77 in the defect.
 */
async function park() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`,
      [landlordId, `acct_test_rfu_${Math.random().toString(36).slice(2, 10)}`])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 589 })
    await c.query(`UPDATE units SET display_label = 'RV 27' WHERE id = $1`, [unitId])
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric' })
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    await c.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
       VALUES ($1, 'electric', 0.21, 0)`, [propertyId])
    await c.query(
      `INSERT INTO property_utility_tax_rates (property_id, utility_type, tax_rate_pct)
       VALUES ($1, 'electric', 8)`, [propertyId])
    await c.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, $2::date, 48000, date_trunc('month', $2::date)::date, $3, 'monthly_cycle')`,
      [meterId, day(-8), userId])
    const cat = await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Store') RETURNING id`, [landlordId])
    const ice = await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price,
                              stock_qty, stock_min, stock_max, tax_rate)
       VALUES ($1,$2,$3,'Ice',3.00,1,999,0,0,0) RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])

    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId,
      landlordId, landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, meterId, iceItemId: ice.rows[0].id, token }
  } finally { c.release() }
}
type Park = Awaited<ReturnType<typeof park>>

/** Curtis: a resident on the space whose lease just ended, with a register record. */
async function resident(p: Park) {
  const c = await db.connect()
  try {
    const tenantId = await seedTenant(c, { email: `curtis-${Math.random().toString(36).slice(2)}@example.com` })
    const leaseId = await seedLease(c, { unitId: p.unitId, landlordId: p.landlordId, rentAmount: 589, status: 'expired' })
    await c.query(`UPDATE leases SET end_date = $2::date WHERE id = $1`, [leaseId, day(0)])
    await seedLeaseTenant(c, { leaseId, tenantId })
    return { tenantId, leaseId }
  } finally { c.release() }
}

/** A guest who took the same space later in the same month, paying their own utilities. */
async function laterStay(p: Park) {
  const c = await db.connect()
  try {
    const email = `andres-${Math.random().toString(36).slice(2)}@example.com`
    const tenantId = await seedTenant(c, { email })
    const b = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, tenant_id, check_in, check_out, booked_check_out,
                                  status, lease_type, stay_terms, guest_name, guest_email)
       VALUES ($1,$2,$3,$4::date,$5::date,$5::date,'checked_out','month_to_month','stay','Andres Razo',$6)
       RETURNING id`,
      [p.unitId, p.landlordId, tenantId, day(-5), day(0), email])
    await c.query(
      `INSERT INTO utility_service_agreements
         (landlord_id, unit_id, tenant_id, booking_id, status, start_date, end_date)
       VALUES ($1,$2,$3,$4,'ended',$5::date,$6::date)`,
      [p.landlordId, p.unitId, tenantId, b.rows[0].id, day(-5), day(0)])
    return { bookingId: b.rows[0].id, tenantId }
  } finally { c.release() }
}

const putOnTicket = (p: Park, body: any) => request(buildApp()).post('/api/pos/final-utility/confirm')
  .set('Authorization', `Bearer ${p.token}`).send({ propertyId: p.propertyId, ...body })

const release = (p: Park, billIds: string[]) => request(buildApp()).post('/api/pos/final-utility/release')
  .set('Authorization', `Bearer ${p.token}`).send({ propertyId: p.propertyId, billIds })

const charge = (p: Park, body: any) => request(buildApp()).post('/api/pos/transactions')
  .set('Authorization', `Bearer ${p.token}`).send({ paymentMethod: 'cash', propertyId: p.propertyId, ...body })

const readings = (meterId: string) => db.query<any>(
  `SELECT id, reading_value::text AS v, reason FROM utility_meter_readings
    WHERE meter_id = $1 ORDER BY created_at`, [meterId]).then(r => r.rows)
const bills = (meterId: string) => db.query<any>(
  `SELECT id, status, charge_amount::text AS charge, tax_amount::text AS tax, usage_amount::text AS usage,
          reading_end::text AS reading_end, paid_at
     FROM utility_bills WHERE meter_id = $1 ORDER BY created_at`, [meterId]).then(r => r.rows)
const asks = (billId: string) => db.query<any>(
  `SELECT id, status, raised_at_counter, notes FROM utility_pay_link_settlements
    WHERE utility_bill_id = $1 ORDER BY created_at`, [billId]).then(r => r.rows)
const salesOf = (landlordId: string) => db.query<any>(
  `SELECT id, total::text AS total FROM pos_transactions WHERE landlord_id = $1`, [landlordId])
  .then(r => r.rows)

/** Raise Curtis's final electric at the counter and hand back the ticket line. */
async function raised(p: Park, leaseId: string, value = 48387) {
  const r = await putOnTicket(p, { closing: { kind: 'lease', id: leaseId }, reads: [{ meterId: p.meterId, value }] })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the closing read is not a one-shot — a bill nobody paid for goes back on the ticket', () => {
  it('the card page refused, so the desk takes the read again and the SAME bill is back on the ticket', async () => {
    const p = await park()
    const c = await resident(p)

    const first = await raised(p, c.leaseId)
    const line = first.body.data.lines[0]
    expect(line.price).toBe(81.27)
    expect(Number(line.amount)).toBeCloseTo(87.77, 2)

    // THE CARD PAGE REFUSED. Everything that follows a refusal lets the ask go
    // and leaves the bill owed, exactly as D2 says — the desk pressing Clear,
    // taking the read off the ticket, or the ticket going cold overnight all
    // come through here.
    expect((await release(p, [line.utilityBillId])).body.data.released).toBe(1)
    expect((await bills(p.meterId))[0].status).toBe('unbilled')

    // THE DESK TAKES THE READ AGAIN, WITH CURTIS STILL AT THE COUNTER.
    const again = await raised(p, c.leaseId)

    // IT IS BACK ON THE TICKET, at the same figure, naming the same bill. This
    // is the whole fix: before it, lines came back empty.
    expect(again.body.data.lines).toHaveLength(1)
    expect(again.body.data.lines[0].utilityBillId).toBe(line.utilityBillId)
    expect(Number(again.body.data.lines[0].amount)).toBeCloseTo(87.77, 2)

    // AND THE DESK IS NOT TOLD AN UNTRUE REASON. Nothing ran a monthly cycle
    // here; the bill in the slot is the one this door raised four lines ago.
    expect(JSON.stringify(again.body.data.notes)).not.toMatch(/monthly run/i)
    expect(again.body.data.notes).toHaveLength(0)

    // ONE BILL, not two — the same kilowatts must never land on two bills.
    expect(await bills(p.meterId)).toHaveLength(1)
    // A FRESH ASK holds it, and the released one is kept with its reason
    // (GAM never erases).
    const a = await asks(line.utilityBillId)
    expect(a).toHaveLength(2)
    expect(a[0]).toMatchObject({ status: 'cancelled', raised_at_counter: true })
    expect(a[1]).toMatchObject({ status: 'open', raised_at_counter: true })

    // Still nothing emailed and nothing on an invoice: D1 holds on the retake.
    expect(notifyMock).not.toHaveBeenCalled()
    expect(emailMock).not.toHaveBeenCalled()
  })

  it('and the money is actually collectable at the counter after the retake', async () => {
    const p = await park()
    const c = await resident(p)
    const line = (await raised(p, c.leaseId)).body.data.lines[0]
    await release(p, [line.utilityBillId])
    const back = (await raised(p, c.leaseId)).body.data.lines[0]

    // The power and a bag of ice, on one ticket, paid once.
    //
    // Rung WITHOUT naming the customer on the sale, which is not what the desk
    // would do, because naming one currently 500s on an unrelated in-flight
    // change: routes/pos.ts around line 3498 builds `cp = [saleCustomerId]`,
    // lets askingAs() push the caller onto it as $2, and then runs the query
    // with `[saleCustomerId]` instead of `cp` — "bind message supplies 1
    // parameters, but prepared statement requires 2". It breaks the counter's
    // own suite the same way. Put `tenantId: c.tenantId` back on both sales here
    // once that is passing; what this test is for — that a re-raised bill is
    // collectable and closes out — does not go through that code at all, because
    // the settle finds the charge from the BILL, never from the named customer.
    const sale = await charge(p, { items: [
      { id: null, name: back.name, qty: 1, price: back.price, tax: back.tax, utilityBillId: back.utilityBillId },
      { id: p.iceItemId, name: 'Ice', cat: 'Store', qty: 1, price: 3.0 },
    ] })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBeCloseTo(90.77, 2)

    const bl = await bills(p.meterId)
    expect(bl).toHaveLength(1)
    expect(bl[0].status).toBe('paid')
    expect(bl[0].paid_at).not.toBeNull()
    // ONE settlement for one bill — the re-raised ask became it, and the
    // released one stayed cancelled.
    const a = await asks(back.utilityBillId)
    expect(a.filter((x: any) => x.status === 'settled')).toHaveLength(1)
    expect(a.filter((x: any) => x.status === 'open')).toHaveLength(0)
  })

  it('a retake measures from where the month started, not from the read it is replacing', async () => {
    const p = await park()
    const c = await resident(p)
    const line = (await raised(p, c.leaseId)).body.data.lines[0]
    await release(p, [line.utilityBillId])

    // By now the FIRST closing read is the meter's newest clean read, so left
    // alone this door would measure 48,500 − 48,387 = 113 kWh of a month that
    // has used 500 — and a same-figure retake would come out at 0 kWh and $0.00
    // while the payer still owed $87.77. The span comes off the bill instead.
    const q = await request(buildApp()).post('/api/pos/final-utility/quote')
      .set('Authorization', `Bearer ${p.token}`)
      .send({ propertyId: p.propertyId, closing: { kind: 'lease', id: c.leaseId },
              reads: [{ meterId: p.meterId, value: 48500 }] })
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data.reads[0].usage).toBe(500)              // 48,500 − 48,000
    expect(Number(q.body.data.reads[0].amount)).toBeCloseTo(113.4, 2)
  })

  it('the retake never re-prices the bill — it cannot shrink what somebody already owes', async () => {
    const p = await park()
    const c = await resident(p)
    const line = (await raised(p, c.leaseId)).body.data.lines[0]
    await release(p, [line.utilityBillId])

    // A genuinely later read on the retake. The bill is the record of this
    // money and it is collected at its own figure, the same rule the till
    // insists on at Charge — so the figure does not move, and the desk is handed
    // the number to read out rather than left reading the quote.
    const again = await raised(p, c.leaseId, 48500)
    expect(again.body.data.lines).toHaveLength(1)
    expect(again.body.data.lines[0].utilityBillId).toBe(line.utilityBillId)
    expect(again.body.data.lines[0].price).toBe(81.27)
    expect(again.body.data.notes).toHaveLength(1)
    expect(again.body.data.notes[0]).toMatch(/stands at \$87\.77/)
    expect(again.body.data.notes[0]).toMatch(/a bill is collected at its own figure/i)

    // ONE bill, untouched — no money row was rewritten by a retake at a counter.
    const bl = await bills(p.meterId)
    expect(bl).toHaveLength(1)
    expect(bl[0]).toMatchObject({ status: 'unbilled', charge: '81.27', tax: '6.50' })
    expect(Number(bl[0].reading_end)).toBe(48387)
    const journal = await db.query<any>(
      `SELECT op FROM audit_row_changes WHERE table_name = 'utility_bills' AND row_id = $1`,
      [line.utilityBillId])
    expect(journal.rows).toHaveLength(0)
  })

  it('a bill that was already PAID is never re-raised, and the desk is told why in true words', async () => {
    const p = await park()
    const c = await resident(p)
    const line = (await raised(p, c.leaseId)).body.data.lines[0]

    // They paid it at the counter and came back to the desk about something
    // else, and somebody took the read again. The re-raise must not become a
    // door that asks for settled money a second time. (Unnamed sale — see the
    // pos.ts:3498 note above.)
    const sale = await charge(p, { items: [line] })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect((await bills(p.meterId))[0].status).toBe('paid')

    const again = await raised(p, c.leaseId)
    expect(again.body.data.lines).toHaveLength(0)
    expect(again.body.data.notes).toHaveLength(1)
    expect(again.body.data.notes[0]).toMatch(/already paid/i)
    expect(again.body.data.notes[0]).not.toMatch(/monthly run/i)
    // No second ask was opened against a paid bill, and no second sale exists.
    expect((await asks(line.utilityBillId)).filter((x: any) => x.status === 'open')).toHaveLength(0)
    expect(await salesOf(p.landlordId)).toHaveLength(1)
    // THE READ STILL STANDS: it is the next arrival's starting point.
    expect((await readings(p.meterId)).filter((r: any) => r.reason === 'move_out_final')).toHaveLength(1)
  })

  it('a bill their own ACH is clearing for is not re-raised either — the same money twice', async () => {
    const p = await park()
    const c = await resident(p)
    const line = (await raised(p, c.leaseId)).body.data.lines[0]
    await release(p, [line.utilityBillId])

    // Invoiced the ordinary way overnight and paid by ACH from their portal:
    // three to five business days, so nothing has settled and the bill still
    // reads 'billed'. The till was corrected for exactly this on 10/20; the
    // retake is the same money.
    const inv = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, tenant_id, unit_id, invoice_number, status, due_date,
                             total_amount, subtotal_rent, subtotal_utilities)
       VALUES ($1,$2,$3,$4,$5,'pending',CURRENT_DATE, 87.77, 0, 87.77) RETURNING id`,
      [p.landlordId, c.leaseId, c.tenantId, p.unitId, `INV-${Math.random().toString(36).slice(2, 8)}`])
    const pay = await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,$5,'utility',87.77,'pending',CURRENT_DATE,'UTILITY','pi_ach_in_flight') RETURNING id`,
      [inv.rows[0].id, p.unitId, c.leaseId, c.tenantId, p.landlordId])
    await db.query(`UPDATE utility_bills SET payment_id = $2, status = 'billed' WHERE id = $1`,
      [line.utilityBillId, pay.rows[0].id])

    const again = await raised(p, c.leaseId)
    expect(again.body.data.lines).toHaveLength(0)
    expect(again.body.data.notes[0]).toMatch(/already answered for/i)
    // Their ACH is untouched, the bill is as it was, and nothing was re-priced
    // under an invoice that already carries the figure.
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [pay.rows[0].id])).rows[0].status).toBe('pending')
    expect((await bills(p.meterId))[0]).toMatchObject({ status: 'billed', charge: '81.27' })
    expect((await asks(line.utilityBillId)).filter((x: any) => x.status === 'open')).toHaveLength(0)
  })
})

describe('the re-raise never crosses households', () => {
  it('a space that turned over mid-month does not put the last household\'s bill on this payer\'s ticket', async () => {
    const p = await park()
    const c = await resident(p)

    // Curtis closes out and the card page refuses, so his bill is left owed.
    const line = (await raised(p, c.leaseId)).body.data.lines[0]
    await release(p, [line.utilityBillId])

    // Andres took the same space a few days later, pays his own utilities, and
    // is now at the counter closing out. There is one bill slot per meter,
    // space and month, and it is holding CURTIS'S bill — so the engine refuses
    // to write a second one and the re-raise is reached with somebody else's
    // money sitting in the slot.
    const a = await laterStay(p)
    const his = await putOnTicket(p, { closing: { kind: 'stay', id: a.bookingId },
                                       reads: [{ meterId: p.meterId, value: 48500 }] })
    expect(his.status, JSON.stringify(his.body)).toBe(201)

    // NOTHING ON ANDRES'S TICKET. This is the one mistake the whole door exists
    // to make impossible, and the re-raise must not become the way in.
    expect(his.body.data.lines).toHaveLength(0)
    expect(his.body.data.notes).toHaveLength(1)
    expect(his.body.data.notes[0]).toMatch(/not the one being closed out here/i)
    // And he is NOT told it was already paid — it is not his bill and no money
    // of his is in.
    expect(his.body.data.notes[0]).not.toMatch(/already paid|answered for|monthly run/i)

    // Curtis's bill is untouched: still his, still owed, still at his figure,
    // and nothing opened an ask against it on Andres's ticket.
    const bl = await bills(p.meterId)
    expect(bl).toHaveLength(1)
    expect(bl[0]).toMatchObject({ status: 'unbilled', charge: '81.27' })
    expect((await asks(line.utilityBillId)).filter((x: any) => x.status === 'open')).toHaveLength(0)
    // ANDRES'S READ STILL STANDS — it is the next arrival's starting point.
    expect((await readings(p.meterId)).some((r: any) => Number(r.v) === 48500)).toBe(true)
  })
})

describe('pressing Confirm twice is one read taken once', () => {
  it('the same figure re-confirmed writes no second reading and opens no second ask', async () => {
    const p = await park()
    const c = await resident(p)
    const line = (await raised(p, c.leaseId)).body.data.lines[0]

    // The browser double-fired, or the desk pressed it again because the card
    // page was still spinning. Nothing was released, so the ask is still open.
    const again = await raised(p, c.leaseId)

    // THE LINE COMES BACK so the cart can hold it (POSPage replaces a line with
    // the same bill id rather than doubling it), and nothing else moved.
    expect(again.body.data.lines).toHaveLength(1)
    expect(again.body.data.lines[0].utilityBillId).toBe(line.utilityBillId)

    // ONE closing read of a meter somebody read once. Before this, every press
    // wrote another 'move_out_final' row and the landlord's Utilities page
    // showed three closing reads of one space.
    const rd = await readings(p.meterId)
    expect(rd).toHaveLength(2)                                    // the prior monthly read + one closing read
    expect(rd.filter((r: any) => r.reason === 'move_out_final')).toHaveLength(1)
    // One bill, and exactly ONE open ask — upls_one_open_link_per_bill would
    // have thrown a raw unique-index error at the desk.
    expect(await bills(p.meterId)).toHaveLength(1)
    expect((await asks(line.utilityBillId)).filter((x: any) => x.status === 'open')).toHaveLength(1)
  })

  it('a DIFFERENT figure the same day still writes its own read — that is a correction, and both stand', async () => {
    const p = await park()
    const c = await resident(p)
    await raised(p, c.leaseId, 48387)
    await raised(p, c.leaseId, 48400)

    const rd = await readings(p.meterId)
    expect(rd.filter((r: any) => r.reason === 'move_out_final').map((r: any) => Number(r.v)).sort())
      .toEqual([48387, 48400])
  })
})

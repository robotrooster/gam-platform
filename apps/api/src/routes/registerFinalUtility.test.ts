/**
 * 10/20 (Nic) — THE FINAL UTILITY BILL, RAISED AT THE REGISTER.
 *
 *   "I don't want it to generate a bill."
 *   "desk picks the customer and gam should know the site from the reservation.
 *    no reason for the front counter to pick a space too"
 *
 * The desk reads the meter off the pole with the payer standing there and the
 * power goes on the same ticket as the propane. Nothing is emailed and nothing
 * goes on an invoice while the ticket is open; paying the ticket closes the bill
 * out; not paying it leaves the bill owed the ordinary way. The READING always
 * stands.
 *
 * Run:
 *   DB_NAME=gam_fin_test TEST_DB_NAME=gam_fin_test GAM_TEST_WORKERS=1 \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261022140000 \
 *   npx vitest run src/routes/registerFinalUtility.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

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
import { db, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
  seedUtilityMeter,
} from '../test/dbHelpers'
import { posRouter } from './pos'
import { posPayLinksRouter } from './posPayLinks'
import { utilityRouter } from './utility'
import { errorHandler } from '../middleware/errorHandler'
import { expectNoFigures } from '../test/noLeaks'

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
  notifyMock.mockClear(); emailMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_register_final_utility'
})

const day = (n: number) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const cycle = () => `${new Date().toISOString().slice(0, 8)}01`

/**
 * Mountain View's shape: an RV space with its own electric submeter at $0.21 a
 * kilowatt, the park's 8% utility tax, a prior read of 48,000 taken eight days
 * ago, and the register's own "Ice" button for something else to ring.
 */
async function park(opts: { priorValue?: number; priorDaysAgo?: number } = {}) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`,
      [landlordId, `acct_test_cfu_${Math.random().toString(36).slice(2, 10)}`])
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
    // The reading of record the counter measures from.
    const prior = await c.query<{ id: string }>(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, $2::date, $3, date_trunc('month', $2::date)::date, $4, 'monthly_cycle')
       RETURNING id`,
      [meterId, day(-(opts.priorDaysAgo ?? 8)), opts.priorValue ?? 48000, userId])
    const cat = await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Store') RETURNING id`, [landlordId])
    const ice = await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price,
                              stock_qty, stock_min, stock_max, tax_rate)
       VALUES ($1,$2,$3,'Ice',3.00,1,999,0,0,0) RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])

    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId,
      landlordId, landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, meterId, priorReadingId: prior.rows[0].id,
             iceItemId: ice.rows[0].id, token }
  } finally { c.release() }
}
type Park = Awaited<ReturnType<typeof park>>

/** A guest on a site, for however many nights, with or without a utility agreement. */
async function stay(p: Park, o: {
  email: string; phone?: string | null; nights: number
  checkIn?: string; checkOut?: string; bookedCheckOut?: string | null
  withAgreement?: boolean
  /** Default 'checked_out' — the guest at the counter on their way out. */
  status?: string
  /** The reservation's own price, so what it still owes is a real figure. */
  total?: number
  unitId?: string
}) {
  const c = await db.connect()
  try {
    const checkIn = o.checkIn ?? day(-o.nights)
    const checkOut = o.checkOut ?? day(0)
    const leaseType = o.nights >= 28 ? 'month_to_month' : o.nights >= 7 ? 'weekly' : 'nightly'
    const b = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out,
                                  status, lease_type, stay_terms, guest_name, guest_email, guest_phone, total_amount)
       VALUES ($1,$2,$3::date,$4::date,$5::date,$9,$6,'stay','Andres Razo',$7,$8,$10)
       RETURNING id`,
      [o.unitId ?? p.unitId, p.landlordId, checkIn, checkOut, o.bookedCheckOut ?? checkOut,
       leaseType, o.email, o.phone ?? null, o.status ?? 'checked_out', o.total ?? null])
    let agreementId: string | null = null
    let tenantId: string | null = null
    if (o.withAgreement) {
      tenantId = await seedTenant(c, { email: o.email })
      const sa = await c.query<{ id: string }>(
        `INSERT INTO utility_service_agreements
           (landlord_id, unit_id, tenant_id, booking_id, status, start_date, end_date)
         VALUES ($1,$2,$3,$4,'ended',$5::date,$6::date) RETURNING id`,
        [p.landlordId, p.unitId, tenantId, b.rows[0].id, checkIn, checkOut])
      agreementId = sa.rows[0].id
    }
    return { bookingId: b.rows[0].id, agreementId, tenantId, checkIn, checkOut }
  } finally { c.release() }
}

/** A resident on the space, with a register record so the desk can pick them. */
async function resident(p: Park, o: { email: string; phone?: string | null }) {
  const c = await db.connect()
  try {
    const tenantId = await seedTenant(c, { email: o.email })
    if (o.phone) await c.query(`UPDATE users SET phone = $2 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`,
      [tenantId, o.phone])
    const leaseId = await seedLease(c, { unitId: p.unitId, landlordId: p.landlordId, rentAmount: 589, status: 'expired' })
    await c.query(`UPDATE leases SET end_date = $2::date WHERE id = $1`, [leaseId, day(0)])
    await seedLeaseTenant(c, { leaseId, tenantId })
    const cust = await c.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, tenant_id, first_name, last_name, email, phone)
       VALUES ($1,$2,'Andres','Razo',$3,$4) RETURNING id`,
      [p.landlordId, tenantId, o.email, o.phone ?? null])
    return { tenantId, leaseId, posCustomerId: cust.rows[0].id }
  } finally { c.release() }
}

/** A register customer with no tenancy at all — a guest the desk added. */
async function guestRecord(p: Park, o: { email: string; phone?: string | null }) {
  const c = await db.connect()
  try {
    const cust = await c.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone)
       VALUES ($1,'Andres','Razo',$2,$3) RETURNING id`, [p.landlordId, o.email, o.phone ?? null])
    return { posCustomerId: cust.rows[0].id }
  } finally { c.release() }
}

// ── the three doors ──────────────────────────────────────────────────────────

const lookUp = (p: Park, q: Record<string, string>) => request(buildApp())
  .get(`/api/pos/final-utility/customer?propertyId=${p.propertyId}&`
    + Object.entries(q).map(([k, v]) => `${k}=${v}`).join('&'))
  .set('Authorization', `Bearer ${p.token}`)

const checkRead = (p: Park, body: any) => request(buildApp()).post('/api/pos/final-utility/quote')
  .set('Authorization', `Bearer ${p.token}`).send({ propertyId: p.propertyId, ...body })

const putOnTicket = (p: Park, body: any) => request(buildApp()).post('/api/pos/final-utility/confirm')
  .set('Authorization', `Bearer ${p.token}`).send({ propertyId: p.propertyId, ...body })

const charge = (p: Park, body: any) => request(buildApp()).post('/api/pos/transactions')
  .set('Authorization', `Bearer ${p.token}`).send({ paymentMethod: 'cash', propertyId: p.propertyId, ...body })

const release = (p: Park, billIds: string[]) => request(buildApp()).post('/api/pos/final-utility/release')
  .set('Authorization', `Bearer ${p.token}`).send({ propertyId: p.propertyId, billIds })

// ── what the database says afterwards ────────────────────────────────────────

const readings = (meterId: string) => db.query<any>(
  `SELECT id, reading_value::text AS v, reason, needs_review, review_note
     FROM utility_meter_readings WHERE meter_id = $1 ORDER BY created_at`, [meterId]).then(r => r.rows)
const bills = (meterId: string) => db.query<any>(
  `SELECT id, status, charge_amount::text AS charge, tax_amount::text AS tax, usage_amount::text AS usage,
          payment_id, paid_at, lease_id, service_agreement_id
     FROM utility_bills WHERE meter_id = $1 ORDER BY created_at`, [meterId]).then(r => r.rows)
const asks = (billId: string) => db.query<any>(
  `SELECT * FROM utility_pay_link_settlements WHERE utility_bill_id = $1 ORDER BY created_at`, [billId])
  .then(r => r.rows)
const absorbed = (meterId: string) => db.query<any>(
  `SELECT reason, charge_amount::text AS charge, tax_amount::text AS tax, usage_amount::text AS usage, notes
     FROM utility_absorbed_charges WHERE meter_id = $1 ORDER BY created_at`, [meterId]).then(r => r.rows)
const invoices = (landlordId: string) => db.query<any>(
  `SELECT id, total_amount::text AS total FROM invoices WHERE landlord_id = $1`, [landlordId]).then(r => r.rows)
const salesOf = (landlordId: string) => db.query<any>(
  `SELECT id, total::text AS total, status FROM pos_transactions WHERE landlord_id = $1`, [landlordId])
  .then(r => r.rows)
/** The electric line of the recovery report, as the landlord's page asks for it. */
const recovery = async (p: Park) => ((await request(buildApp())
  .get(`/api/utility/recovery?propertyId=${p.propertyId}&from=${day(-400)}&to=${day(400)}`)
  .set('Authorization', `Bearer ${p.token}`)).body.data?.lines ?? [])
  .find((l: any) => l.utilityType === 'electric')

// ─────────────────────────────────────────────────────────────────────────────

describe('D3 — GAM finds the site from their own reservation or lease', () => {
  it('matches on their exact email and shows their own stay, never a list of spaces', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })
    const g = await guestRecord(p, { email })

    const r = await lookUp(p, { posCustomerId: g.posCustomerId })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.matchedBy).toBe('email')
    expect(r.body.data.closings).toHaveLength(1)
    expect(r.body.data.closings[0]).toMatchObject({ kind: 'stay', id: s.bookingId, payer: 'service_agreement' })
    // The space comes from the stay — the desk never picks one.
    expect(r.body.data.closings[0].what).toMatch(/RV 27/)
    expect(r.body.data.closings[0].meters).toHaveLength(1)
  })

  it('falls through to their exact phone number when the email does not match', async () => {
    const p = await park()
    const s = await stay(p, { email: 'typo@example.com', phone: '(520) 555-0184', nights: 40, withAgreement: true })
    const g = await guestRecord(p, { email: `other-${Math.random().toString(36).slice(2)}@example.com`, phone: '520-555-0184' })

    const r = await lookUp(p, { posCustomerId: g.posCustomerId })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.matchedBy).toBe('phone')
    expect(r.body.data.closings.map((c: any) => c.id)).toEqual([s.bookingId])
  })

  it('two rigs: the desk confirms WHICH one, and both are that person\'s own', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const a = await stay(p, { email, nights: 40, checkIn: day(-80), checkOut: day(-40), withAgreement: true })
    const b = await stay(p, { email, nights: 35, withAgreement: false })
    const g = await guestRecord(p, { email })

    const r = await lookUp(p, { posCustomerId: g.posCustomerId })
    expect(r.body.data.closings).toHaveLength(2)
    expect(r.body.data.closings.map((c: any) => c.id).sort()).toEqual([a.bookingId, b.bookingId].sort())
  })

  it('says plainly that there is no final bill to raise when GAM has nobody', async () => {
    const p = await park()
    const g = await guestRecord(p, { email: `nobody-${Math.random().toString(36).slice(2)}@example.com` })
    const r = await lookUp(p, { posCustomerId: g.posCustomerId })
    expect(r.status).toBe(200)
    expect(r.body.data.closings).toHaveLength(0)
    expect(r.body.data.note).toMatch(/no final bill to raise/i)
    // And never a name match offered as the way round it.
    expect(r.body.data.note).not.toMatch(/name/i)
  })
})

describe('D5 — typing the number writes nothing; confirming writes the reading and the bill', () => {
  it('shows the usage and the dollar amount, and writes NOTHING before Confirm is pressed', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })

    const q = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48387 }] })
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    const line = q.body.data.reads[0]
    // 387 kWh at $0.21 is $81.27, plus the park's 8% is $6.50.
    expect(line).toMatchObject({ usage: 387, charge: 81.27, tax: 6.5, amount: 87.77, block: null })
    expect(line.note).toMatch(/387 kWh/)
    expect(line.note).toMatch(/\$87\.77/)
    // Blind entry still holds: the quote never says what the meter read before.
    expectNoFigures(q.body, [48000])

    // NOTHING WAS WRITTEN. No reading beyond the one that was already there, no
    // bill, no absorbed row.
    expect(await readings(p.meterId)).toHaveLength(1)
    expect(await bills(p.meterId)).toHaveLength(0)
    expect(await absorbed(p.meterId)).toHaveLength(0)
  })

  it('a monthly stay with no lease is billed off the typed read, on no invoice and with nothing emailed', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })

    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48387 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.lines).toHaveLength(1)

    // THE LINE IS THE PAY-LINK SHAPE, to the letter: no catalog item, the charge
    // before tax, the bill's own two figures as the rate, naming its bill.
    const line = r.body.data.lines[0]
    expect(line.id).toBeNull()
    expect(line.name).toMatch(/^Electric — /)
    expect(line.name).toMatch(/RV 27/)
    expect(line.price).toBe(81.27)
    expect(line.qty).toBe(1)
    expect(Math.round(line.price * line.tax * 100) / 100).toBe(6.5)
    expect(line.utilityBillId).toBeTruthy()

    // THE READ LANDED ON THE METER, as the closing read, not held.
    const rd = await readings(p.meterId)
    expect(rd).toHaveLength(2)
    expect(rd[1]).toMatchObject({ v: '48387', reason: 'move_out_final', needs_review: false })

    // THE BILL IS THERE, owed, and billed to the stay's utility agreement.
    const bl = await bills(p.meterId)
    expect(bl).toHaveLength(1)
    expect(bl[0]).toMatchObject({ status: 'unbilled', charge: '81.27', tax: '6.50', payment_id: null })
    expect(bl[0].service_agreement_id).toBe(s.agreementId)

    // D1 — NOTHING WAS SENT AND IT IS ON NO INVOICE. The move-out path's own
    // last act emails "pay it from your portal, or it settles from your
    // deposit"; with the payer at the counter that is a second place to pay.
    expect(await invoices(p.landlordId)).toHaveLength(0)
    expect(notifyMock).not.toHaveBeenCalled()
    expect(emailMock).not.toHaveBeenCalled()

    // The open ask is in the one book for utility money collected through the
    // POS, raised at the counter and holding no pay link.
    const ask = await asks(line.utilityBillId)
    expect(ask).toHaveLength(1)
    expect(ask[0]).toMatchObject({ status: 'open', raised_at_counter: true, pay_link_id: null })
    expect(ask[0].meter_reading_id).toBe(rd[1].id)
  })

  it('an upward slipped digit is caught: nothing is billed, and the desk is told without a figure', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })

    // 120000 for 12000 on a six-digit face: 72,000 kWh, a $15,120 charge.
    const q = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 120000 }] })
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data.reads[0].block).toBe('double_check')
    expect(q.body.data.reads[0].note).toMatch(/double-check/i)
    // Blind: no figure, and no hint which direction they were off.
    expect(q.body.data.reads[0].note).not.toMatch(/\d/)
    expect(q.body.data.reads[0].amount).toBe(0)

    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 120000 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.lines).toHaveLength(0)
    expect(r.body.data.notes[0]).toMatch(/double-check/i)

    // The read is KEPT and flagged for the landlord; nothing was billed and
    // nothing was emailed.
    const rd = await readings(p.meterId)
    expect(rd).toHaveLength(2)
    expect(rd[1]).toMatchObject({ v: '120000', needs_review: true })
    expect(rd[1].review_note).toBeTruthy()
    expect(await bills(p.meterId)).toHaveLength(0)
    expect(await invoices(p.landlordId)).toHaveLength(0)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('a figure below the last read gets the SAME sentence as one that came in too high', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })
    // 4800 typed against a prior 48000 — a dropped digit at a pull-out.
    const low = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 4800 }] })
    const high = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 120000 }] })
    expect(low.body.data.reads[0].block).toBe('double_check')
    // Indistinguishable on purpose: anything that tells them apart is the
    // previous read, a guess at a time.
    expect(low.body.data.reads[0].note).toBe(high.body.data.reads[0].note)
  })

  it('a held figure on a stay whose power is in its rate leads with "nothing to collect"', async () => {
    // 10/24 — PATRICK NEUMAN, RV 06. Lisa typed 39999 against a previous read
    // of 40000 and got back only "this one waits on the landlord's
    // double-check", read it as money pending, and went looking for a ticket to
    // open. He was a work camper on a stay with no cash due: there was never
    // anything to collect from him whatever the figure turned out to be.
    //
    // Nic: "The front desk person needs to be able to finalize things... I
    // don't really want the front desk making judgment calls. I want the
    // computer to do it for them."
    const p = await park()
    const email = `neuman-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 27, withAgreement: false })

    const low = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 4800 }] })
    expect(low.status, JSON.stringify(low.body)).toBe(200)
    // The figure still goes to the landlord — it is the next guest's starting
    // point too, and which of a slipped digit or a swapped meter it was is
    // theirs to settle.
    expect(low.body.data.reads[0].block).toBe('double_check')
    expect(low.body.data.reads[0].amount).toBe(0)
    // But the money answer comes FIRST, and it is the one the counter needed.
    expect(low.body.data.reads[0].note).toMatch(/^.*nothing to collect/i)
    expect(low.body.data.reads[0].note).toMatch(/in the rate they already paid/i)
    expect(low.body.data.reads[0].note).toMatch(/nothing for you to do/i)
    // STILL BLIND. No figure, and a high read says exactly the same thing as a
    // low one — anything that tells the two apart is the previous read.
    expect(low.body.data.reads[0].note).not.toMatch(/\d/)
    const high = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 920000 }] })
    expect(high.body.data.reads[0].block).toBe('double_check')
    expect(high.body.data.reads[0].note).toBe(low.body.data.reads[0].note)

    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 4800 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.lines).toHaveLength(0)
    expect(r.body.data.notes[0]).toMatch(/nothing to collect/i)

    // The read is kept and flagged; nothing billed, nothing emailed.
    const rd = await readings(p.meterId)
    expect(rd).toHaveLength(2)
    expect(rd[1]).toMatchObject({ v: '4800', needs_review: true })
    expect(await bills(p.meterId)).toHaveLength(0)
    expect(await invoices(p.landlordId)).toHaveLength(0)
    expect(notifyMock).not.toHaveBeenCalled()
    // AND NOTHING IS ABSORBED YET. A wrapped read measures very nearly a full
    // meter of kilowatts, and writing that onto the in-the-rate book would
    // overstate what the park recovered inside its rate on the one column that
    // exists to be trustworthy. It lands there when the landlord settles the
    // figure, not before.
    expect(await absorbed(p.meterId)).toHaveLength(0)
  })

  // 10/24 (Nic) — RV 06, AND THE RULE IT PRODUCED.
  //   "if a meter read is within one or two digits of the other read, even if
  //    it's lower, just go straight into marking it as potentially broken...
  //    Maybe last month somebody rounded it to 40,000 and this month it was
  //    read as 39999. So it could, when it's within one or two, like it could
  //    be really just broken, not actually less than before."
  describe('a face that barely moved is a meter to look at, not a wrap', () => {
    // 39999 against 40000 is what Lisa actually typed. The old rule read it as
    // an odometer wrap and measured 99,999 kWh.
    for (const [what, value] of [['one under (the RV 06 case)', 39999],
                                 ['two under', 39998],
                                 ['dead level — the one nothing caught before', 40000]] as const) {
      it(`${what}: no wrap, nothing billed, and the METER is flagged — the read is not held`, async () => {
        const p = await park({ priorValue: 40000, priorDaysAgo: 23 })
        const email = `stuck-${Math.random().toString(36).slice(2)}@example.dev`
        const s = await stay(p, { email, nights: 27, withAgreement: true })

        const q = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value }] })
        expect(q.status, JSON.stringify(q.body)).toBe(200)
        // ── 10/25 (Nic) — THE METER IS FLAGGED, NOT THE READ ─────────────────
        //
        //   "A meter rolling back is not a rule that I asked for. If it's 40,000
        //    and it rolls back 39999, that just needs to flag in the system that
        //    the meter may be broken. I don't want to have to double check a
        //    read."
        //
        // This test used to assert block 'double_check' and needs_review TRUE,
        // from my misreading of his 10/24 words — he said mark the METER
        // potentially broken and I held the READ. That is what left Patrick
        // Neuman's finished stay carrying both a "closing read still due" and a
        // "reading to double-check": "Neither of those should be there... The
        // system is not operating correctly if those are there. Full stop."
        expect(q.body.data.reads[0].block).toBeNull()
        // THE PART THAT DOES NOT CHANGE: not 99,999 kWh and not a $21,000
        // charge. A rollback still reads as no usage, never a wrap.
        expect(q.body.data.reads[0].amount).toBe(0)
        expect(q.body.data.reads[0].charge).toBe(0)

        const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value }] })
        expect(r.status, JSON.stringify(r.body)).toBe(201)
        expect(await invoices(p.landlordId)).toHaveLength(0)

        // The read stands, unheld — nothing for him to double-check.
        const rd = await readings(p.meterId)
        expect(rd).toHaveLength(2)
        expect(rd[1]).toMatchObject({ v: String(value), needs_review: false })

        // The METER carries the suspicion instead, and says why.
        const m = await query<any>(
          `SELECT looks_broken_at, looks_broken_reason FROM utility_meters WHERE id = $1`, [p.meterId])
        expect(m[0].looks_broken_at).not.toBeNull()
        expect(m[0].looks_broken_reason).toMatch(/barely moved|backwards/i)
        // NOT out of service: a flag must never stop a meter being billed.
        const svc = await query<any>(`SELECT out_of_service FROM utility_meters WHERE id = $1`, [p.meterId])
        expect(svc[0].out_of_service).toBe(false)
      })
    }

    it('three under is still a wrap question, not a stuck face — the line is at two', async () => {
      const p = await park({ priorValue: 40000, priorDaysAgo: 23 })
      const email = `wrap-${Math.random().toString(36).slice(2)}@example.dev`
      const s = await stay(p, { email, nights: 27, withAgreement: true })
      const q = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 39997 }] })
      expect(q.body.data.reads[0].block).toBe('double_check')
      const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 39997 }] })
      expect(r.status).toBe(201)
      const rd = await readings(p.meterId)
      expect(rd[1].review_note).toMatch(/slipped digit/i)
      expect(rd[1].review_note).not.toMatch(/may not be turning/i)
    })

    it('two ABOVE is real usage and bills, because a face that moved up did move up', async () => {
      const p = await park({ priorValue: 40000, priorDaysAgo: 23 })
      const email = `frugal-${Math.random().toString(36).slice(2)}@example.dev`
      const s = await stay(p, { email, nights: 27, withAgreement: true })
      const q = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 40002 }] })
      expect(q.body.data.reads[0].block).toBeNull()
      expect(q.body.data.reads[0].usage).toBe(2)
      expect(q.body.data.reads[0].amount).toBeGreaterThan(0)
    })
  })

  it('refuses more digits than the face has, and records nothing at all for it', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })
    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 1234567 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    expect(r.body.error).toMatch(/more digits than/i)
    expect(await readings(p.meterId)).toHaveLength(1)
  })
})

describe('D6 — a short stay\'s power is in its rate, and that is finally written down', () => {
  for (const [what, nights] of [['a weekly guest', 9], ['a nightly guest', 3]] as const) {
    it(`${what} is billed nothing, the reason is on screen, and the usage is recorded as in-the-rate`, async () => {
      const p = await park({ priorDaysAgo: nights + 2 })
      const email = `guest-${Math.random().toString(36).slice(2)}@example.com`
      const s = await stay(p, { email, nights, withAgreement: false })

      const q = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48120 }] })
      expect(q.body.data.reads[0]).toMatchObject({ block: 'in_the_rate', usage: 120, amount: 0 })
      expect(q.body.data.reads[0].note).toMatch(/in the rate they already paid/i)

      const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48120 }] })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(r.body.data.lines).toHaveLength(0)
      expect(r.body.data.notes[0]).toMatch(/nothing to collect/i)
      expect(r.body.data.notes[0]).toMatch(/in the rate they already paid/i)

      // THE READ LANDED, and nobody was billed.
      expect(await readings(p.meterId)).toHaveLength(2)
      expect(await bills(p.meterId)).toHaveLength(0)

      // AND THE KILOWATTS ARE ON THE BOOK — the column that has read $0.00 at
      // every property because nothing ever wrote it.
      const ab = await absorbed(p.meterId)
      expect(ab).toHaveLength(1)
      expect(ab[0]).toMatchObject({ reason: 'short_stay_in_rate', charge: '25.20', tax: '2.02', usage: '120.0000' })
      const rec = await recovery(p)
      expect(rec.inTheRate).toBeCloseTo(27.22, 2)
      expect(rec.recovered).toBeCloseTo(27.22, 2)
      expect(rec.stillOwed).toBe(0)
    })
  }

  it('two guests through one site in a month both count — the second never overwrites the first', async () => {
    const p = await park({ priorDaysAgo: 20, priorValue: 48000 })
    const a = await stay(p, { email: `a-${Math.random().toString(36).slice(2)}@example.com`, nights: 4,
                              checkIn: day(-18), checkOut: day(-14) })
    const b = await stay(p, { email: `b-${Math.random().toString(36).slice(2)}@example.com`, nights: 4,
                              checkIn: day(-6), checkOut: day(-2) })
    expect((await putOnTicket(p, { closing: { kind: 'stay', id: a.bookingId }, reads: [{ meterId: p.meterId, value: 48100 }] })).status).toBe(201)
    expect((await putOnTicket(p, { closing: { kind: 'stay', id: b.bookingId }, reads: [{ meterId: p.meterId, value: 48160 }] })).status).toBe(201)
    const ab = await absorbed(p.meterId)
    expect(ab).toHaveLength(1)          // one row per meter, space and month
    expect(ab[0].usage).toBe('160.0000')   // 100 + 60, added, never replaced
    expect(ab[0].charge).toBe('33.60')
  })
})

describe('THE WASH — called, not re-decided', () => {
  it('a guest who left early at a park that kept their money is billed nothing, and it is absorbed', async () => {
    const p = await park({ priorDaysAgo: 6 })
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    // Booked through a week from now, drove off two days ago, and the park kept
    // the unused money.
    const s = await stay(p, { email, nights: 40, checkIn: day(-38), checkOut: day(-2),
                              bookedCheckOut: day(7), withAgreement: true })
    await db.query(
      `INSERT INTO early_departure_washes
         (landlord_id, property_id, unit_id, tenant_id, booking_id, departed_on, paid_through, amount_kept, notes)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,51.00,'Left early, kept no refund.')`,
      [p.landlordId, p.propertyId, p.unitId, s.tenantId, s.bookingId, day(-2), day(7)])

    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48387 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.lines).toHaveLength(0)
    expect(r.body.data.notes[0]).toMatch(/wash/i)
    expect(r.body.data.notes[0]).toMatch(/absorbed/i)

    // The read stands, nothing was billed, and the power is on the absorbed
    // book under the wash — written by the wash module, not by this door.
    expect(await readings(p.meterId)).toHaveLength(2)
    expect(await bills(p.meterId)).toHaveLength(0)
    const ab = await absorbed(p.meterId)
    expect(ab).toHaveLength(1)
    expect(ab[0].reason).toBe('early_departure_wash')
    expect(ab[0].charge).toBe('81.27')
    expect(await invoices(p.landlordId)).toHaveLength(0)
  })
})

describe('D1 / D2 — the ticket IS the bill, and an unpaid one is owed the ordinary way', () => {
  it('paying the ticket closes the bill out, and the kilowatts are counted ONCE', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })
    const raised = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48387 }] })
    const line = raised.body.data.lines[0]

    // Billed back and still owed while the ticket is open.
    expect(await recovery(p)).toMatchObject({ recovered: 87.77, collected: 0, stillOwed: 87.77 })

    // The ticket: their power and a bag of ice.
    const sale = await charge(p, { items: [
      { id: null, name: line.name, qty: 1, price: line.price, tax: line.tax, utilityBillId: line.utilityBillId },
      { id: p.iceItemId, name: 'Ice', cat: 'Store', qty: 1, price: 3.0 },
    ] })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBeCloseTo(90.77, 2)

    // THE BILL IS CLOSED OUT and the ask is the settlement, naming the sale.
    const bl = await bills(p.meterId)
    expect(bl[0].status).toBe('paid')
    expect(bl[0].paid_at).not.toBeNull()
    const ask = await asks(line.utilityBillId)
    expect(ask).toHaveLength(1)
    expect(ask[0]).toMatchObject({ status: 'settled', raised_at_counter: true, pay_link_id: null,
                                   pos_transaction_id: sale.body.data.id })

    // COUNTED ONCE. The bill is the record of what was billed back AND of what
    // came in; the sale's bill-raised line carries no recovers_utility, so the
    // register sweep cannot count the same kilowatts a second time.
    expect(await recovery(p)).toMatchObject({ recovered: 87.77, collected: 87.77, stillOwed: 0 })
    const lineRows = await db.query<any>(
      `SELECT item_name, recovers_utility FROM pos_transaction_items
        WHERE transaction_id = $1 ORDER BY item_name`, [sale.body.data.id])
    expect(lineRows.rows.find((l: any) => l.item_name === line.name).recovers_utility).toBeNull()

    // Still nothing emailed and nothing on an invoice — it was paid at the desk.
    expect(await invoices(p.landlordId)).toHaveLength(0)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('an unpaid ticket leaves the bill OWED, and the reading stands', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })
    const line = (await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48387 }] }))
      .body.data.lines[0]

    // They walk off, or the desk clears the cart.
    const rel = await release(p, [line.utilityBillId])
    expect(rel.status, JSON.stringify(rel.body)).toBe(200)
    expect(rel.body.data.released).toBe(1)

    // NOTHING WAS WRITTEN OFF. The bill is owed exactly as it was, on nobody's
    // invoice yet, and the ask is let go (kept, with its reason — GAM never
    // erases).
    const bl = await bills(p.meterId)
    expect(bl[0]).toMatchObject({ status: 'unbilled', paid_at: null, payment_id: null })
    const ask = await asks(line.utilityBillId)
    expect(ask[0].status).toBe('cancelled')
    expect(ask[0].notes).toMatch(/owed as usual/i)
    expect(await salesOf(p.landlordId)).toHaveLength(0)
    // THE READING ALWAYS STANDS.
    expect(await readings(p.meterId)).toHaveLength(2)
    // And the ordinary route has it: it is offered to be emailed as a link again.
    const sendable = await request(buildApp())
      .get(`/api/pos/pay-links/utility-bills?propertyId=${p.propertyId}`)
      .set('Authorization', `Bearer ${p.token}`)
    expect(sendable.body.data.map((b: any) => b.billId)).toContain(line.utilityBillId)
  })

  it('an ask left open by a dead ticket goes cold and the bill comes back to the ordinary route', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })
    const line = (await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48387 }] }))
      .body.data.lines[0]
    // The browser died mid-ticket: nobody pressed Charge, Clear or Take it off.
    await db.query(
      `UPDATE utility_pay_link_settlements SET created_at = NOW() - interval '20 hours'
        WHERE utility_bill_id = $1`, [line.utilityBillId])
    // While it was open the bill was off the Pay Links list — one place to pay.
    // The next closing read at this park lets the dead one go.
    const g = await guestRecord(p, { email: `someone-${Math.random().toString(36).slice(2)}@example.com` })
    expect((await lookUp(p, { posCustomerId: g.posCustomerId })).status).toBe(200)

    expect((await asks(line.utilityBillId))[0]).toMatchObject({ status: 'cancelled' })
    expect((await asks(line.utilityBillId))[0].notes).toMatch(/owed as usual/i)
    expect((await bills(p.meterId))[0]).toMatchObject({ status: 'unbilled', paid_at: null })
    const sendable = await request(buildApp())
      .get(`/api/pos/pay-links/utility-bills?propertyId=${p.propertyId}`)
      .set('Authorization', `Bearer ${p.token}`)
    expect(sendable.body.data.map((b: any) => b.billId)).toContain(line.utilityBillId)
  })

  it('a released bill cannot then be charged at the till — the ticket no longer holds it', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })
    const line = (await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48387 }] }))
      .body.data.lines[0]
    await release(p, [line.utilityBillId])
    const sale = await charge(p, { items: [{ id: null, name: line.name, qty: 1, price: line.price, tax: line.tax, utilityBillId: line.utilityBillId }] })
    expect(sale.status, JSON.stringify(sale.body)).toBe(409)
    expect(await salesOf(p.landlordId)).toHaveLength(0)
    expect((await bills(p.meterId))[0].status).toBe('unbilled')
  })

  it('refuses a bill their own ACH is already clearing for — the same money twice', async () => {
    const p = await park()
    const email = `curtis-${Math.random().toString(36).slice(2)}@example.com`
    const res = await resident(p, { email })
    const line = (await putOnTicket(p, { closing: { kind: 'lease', id: res.leaseId }, reads: [{ meterId: p.meterId, value: 48387 }] }))
      .body.data.lines[0]
    // Invoiced overnight the ordinary way, and they paid it by ACH from their
    // portal — three to five business days, so nothing has settled and the bill
    // still reads 'billed'.
    const inv = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, tenant_id, unit_id, invoice_number, status, due_date,
                             total_amount, subtotal_rent, subtotal_utilities)
       VALUES ($1,$2,$3,$4,$5,'pending',CURRENT_DATE, 87.77, 0, 87.77) RETURNING id`,
      [p.landlordId, res.leaseId, res.tenantId, p.unitId, `INV-${Math.random().toString(36).slice(2, 8)}`])
    const pay = await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,$5,'utility',87.77,'pending',CURRENT_DATE,'UTILITY','pi_ach_in_flight') RETURNING id`,
      [inv.rows[0].id, p.unitId, res.leaseId, res.tenantId, p.landlordId])
    await db.query(`UPDATE utility_bills SET payment_id = $2, status = 'billed' WHERE id = $1`,
      [line.utilityBillId, pay.rows[0].id])

    const sale = await charge(p, { items: [line], tenantId: res.tenantId })
    expect(sale.status, JSON.stringify(sale.body)).toBe(409)
    expect(sale.body.error).toMatch(/already answered for/i)
    expect(await salesOf(p.landlordId)).toHaveLength(0)
    // Their ACH is untouched and the bill is exactly as it was.
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [pay.rows[0].id])).rows[0].status).toBe('pending')
    expect((await bills(p.meterId))[0].status).toBe('billed')
  })

  it('the line is the bill at the till: it cannot be retyped, dropped or discounted', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })
    const line = (await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: p.meterId, value: 48387 }] }))
      .body.data.lines[0]

    const retyped = await charge(p, { items: [{ ...line, price: 10 }] })
    expect(retyped.status, JSON.stringify(retyped.body)).toBe(400)
    expect(retyped.body.error).toMatch(/is their bill/i)

    const discounted = await charge(p, { items: [line], discountAmount: 75.25 })
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(400)
    expect(discounted.body.error).toMatch(/no discount comes off it/i)

    // Nothing was charged either time and the bill is as owed as it was.
    expect(await salesOf(p.landlordId)).toHaveLength(0)
    expect((await bills(p.meterId))[0]).toMatchObject({ status: 'unbilled', paid_at: null })
    expect((await asks(line.utilityBillId))[0].status).toBe('open')
  })

  it('another company\'s bill id on a cart line buys nothing', async () => {
    const mine = await park()
    const theirs = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(theirs, { email, nights: 35, withAgreement: true })
    const line = (await putOnTicket(theirs, { closing: { kind: 'stay', id: s.bookingId }, reads: [{ meterId: theirs.meterId, value: 48387 }] }))
      .body.data.lines[0]
    const sale = await charge(mine, { items: [{ id: null, name: line.name, qty: 1, price: line.price, tax: line.tax, utilityBillId: line.utilityBillId }] })
    expect(sale.status, JSON.stringify(sale.body)).toBe(409)
    expect(await salesOf(mine.landlordId)).toHaveLength(0)
    expect((await bills(theirs.meterId))[0].status).toBe('unbilled')
  })
})

describe('a lease at the counter', () => {
  it('bills the departing household off the typed read and takes the charge off their invoice when it is paid', async () => {
    const p = await park()
    const email = `curtis-${Math.random().toString(36).slice(2)}@example.com`
    const res = await resident(p, { email })

    const look = await lookUp(p, { tenantId: res.tenantId })
    expect(look.status, JSON.stringify(look.body)).toBe(200)
    expect(look.body.data.closings.map((c: any) => c.id)).toContain(res.leaseId)
    expect(look.body.data.closings.find((c: any) => c.id === res.leaseId).payer).toBe('lease')

    const raised = await putOnTicket(p, { closing: { kind: 'lease', id: res.leaseId }, reads: [{ meterId: p.meterId, value: 48387 }] })
    expect(raised.status, JSON.stringify(raised.body)).toBe(201)
    const line = raised.body.data.lines[0]
    expect(line.price).toBe(81.27)
    // D1: the bill is on no invoice and nothing was emailed — the thing the
    // ordinary move-out read does the moment it bills a lease.
    expect(await invoices(p.landlordId)).toHaveLength(0)
    expect(notifyMock).not.toHaveBeenCalled()
    expect((await bills(p.meterId))[0].lease_id).toBe(res.leaseId)

    // The ordinary route reaches it overnight before they come in: the bill is
    // invoiced the usual way, with a charge on their invoice.
    const inv = await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, tenant_id, unit_id, invoice_number, status, due_date,
                             total_amount, subtotal_rent, subtotal_utilities)
       VALUES ($1,$2,$3,$4,$5,'pending',CURRENT_DATE, 87.77, 0, 87.77) RETURNING id`,
      [p.landlordId, res.leaseId, res.tenantId, p.unitId, `INV-${Math.random().toString(36).slice(2, 8)}`])
    const pay = await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                             due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,$5,'utility',87.77,'pending',CURRENT_DATE,'UTILITY','Final electric') RETURNING id`,
      [inv.rows[0].id, p.unitId, res.leaseId, res.tenantId, p.landlordId])
    await db.query(`UPDATE utility_bills SET payment_id = $2, status = 'billed' WHERE id = $1`,
      [line.utilityBillId, pay.rows[0].id])

    const sale = await charge(p, { items: [line], tenantId: res.tenantId })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)

    // NOBODY IS ASKED TWICE: the charge is voided — kept, with its reason, and
    // in no balance — and the invoice follows it.
    const ch = (await db.query<any>(`SELECT status, void_reason FROM payments WHERE id = $1`, [pay.rows[0].id])).rows[0]
    expect(ch.status).toBe('voided')
    expect(ch.void_reason).toMatch(/Collected at the register/)
    const after = (await db.query<any>(`SELECT total_amount::text AS t, subtotal_utilities::text AS u FROM invoices WHERE id = $1`,
      [inv.rows[0].id])).rows[0]
    expect(Number(after.t)).toBe(0)
    expect(Number(after.u)).toBe(0)
    expect((await bills(p.meterId))[0].status).toBe('paid')
    expect(await recovery(p)).toMatchObject({ recovered: 87.77, collected: 87.77, stillOwed: 0 })
  })
})

describe('both meters on one site, on one ticket (D4)', () => {
  it('electric and water come back as two lines, and a slip in one writes neither', async () => {
    const p = await park()
    const c = await db.connect()
    let waterMeterId = ''
    try {
      waterMeterId = await seedUtilityMeter(c, { propertyId: p.propertyId, utilityType: 'water' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [waterMeterId, p.unitId])
      await c.query(`INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
                     VALUES ($1,'water',0.005,0)`, [p.propertyId])
      await c.query(
        `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
         VALUES ($1, $2::date, 1000, date_trunc('month', $2::date)::date, $3, 'monthly_cycle')`,
        [waterMeterId, day(-8), p.userId])
    } finally { c.release() }

    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })

    // Every submeter the site has gets a box.
    const look = await lookUp(p, { posCustomerId: (await guestRecord(p, { email })).posCustomerId })
    expect(look.body.data.closings[0].meters).toHaveLength(2)

    // A slip in the second box writes NEITHER read: one screen, one confirm.
    const slip = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId },
      reads: [{ meterId: p.meterId, value: 48387 }, { meterId: waterMeterId, value: 9999999 }] })
    expect(slip.status, JSON.stringify(slip.body)).toBe(400)
    expect(await readings(p.meterId)).toHaveLength(1)
    expect(await readings(waterMeterId)).toHaveLength(1)

    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId },
      reads: [{ meterId: p.meterId, value: 48387 }, { meterId: waterMeterId, value: 4000 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.lines).toHaveLength(2)
    expect(r.body.data.lines.map((l: any) => l.name.split(' —')[0]).sort()).toEqual(['Electric', 'Water'])
    expect(await readings(p.meterId)).toHaveLength(2)
    expect(await readings(waterMeterId)).toHaveLength(2)
    expect(await invoices(p.landlordId)).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 10/20 (review) — THE READ BELONGS TO THE CLOSING'S OWN SPACE.
 *
 * "desk picks the customer and gam should know the site from the reservation.
 *  no reason for the front counter to pick a space too"
 *
 * GAM knowing the site is the whole instruction, and it is only kept if the
 * METER is checked against that site too. It was not: the closing was re-read
 * and the meter's PROPERTY was re-read, and the one relationship that decides
 * whose power it is — the meter against the space — was read once to build the
 * list for the browser and never checked when the browser sent one back.
 *
 * So a cashier with nothing but register access could name the guest on RV 27
 * and the submeter on RV 05 in the same request, and two separate things went
 * wrong, both of them money:
 *
 *   RV 05's kilowatts were priced and billed to the RV 27 guest — the bill's
 *     unique slot is (meter, SPACE, cycle, utility), so it did not collide with
 *     RV 05's own bill; it inserted cleanly and went on the ticket as that
 *     guest's.
 *   AND RV 05's reading of record was overwritten — a 'move_out_final' read,
 *     needs_review false, dated today, which is exactly the row the next bill
 *     measures from. RV 05's own occupant's next bill would have started from a
 *     figure that was never theirs.
 */
describe('the closing\'s own space is what a read may be taken on', () => {
  /** RV 05 — the space next door, with its own submeter and its own baseline. */
  async function spaceNextDoor(p: Park) {
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId,
        unitType: 'rv_spot', rentAmount: 589 })
      await c.query(`UPDATE units SET display_label = 'RV 05' WHERE id = $1`, [unitId])
      const meterId = await seedUtilityMeter(c, { propertyId: p.propertyId, utilityType: 'electric' })
      await c.query(`UPDATE utility_meters SET label = 'RV 05 pedestal' WHERE id = $1`, [meterId])
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
      // Its own reading of record — the figure its occupant's next bill is
      // measured from, and the thing a cross-wired closing read destroys.
      await c.query(
        `INSERT INTO utility_meter_readings
           (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
         VALUES ($1, $2::date, 48000, date_trunc('month', $2::date)::date, $3, 'monthly_cycle')`,
        [meterId, day(-8), p.userId])
      return { unitId, meterId }
    } finally { c.release() }
  }

  it('refuses another space\'s meter at both doors, and names neither it nor its space', async () => {
    const p = await park()
    const next = await spaceNextDoor(p)
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })

    // The browser is handed the RIGHT list: the closing's own space's meters,
    // and only those. The fault was never the list — it was trusting one back.
    const look = await lookUp(p, { posCustomerId: (await guestRecord(p, { email })).posCustomerId })
    expect(look.body.data.closings[0].meters.map((m: any) => m.meterId)).toEqual([p.meterId])

    // TYPING IT PRICES NOTHING. 1,000 kWh at $0.21 is $210 of somebody else's
    // power, and the desk is never shown the figure.
    const q = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId },
      reads: [{ meterId: next.meterId, value: 49000 }] })
    expect(q.status, JSON.stringify(q.body)).toBe(404)
    expect(q.body.error).toMatch(/not on the space being closed out/i)
    // Blind entry: the refusal is the same one a meter at another park gets, so
    // nothing typed here tells the two apart.
    expect(JSON.stringify(q.body)).not.toMatch(/RV 05|pedestal/)
    expectNoFigures(q.body, [210, 226])

    // AND CONFIRMING IT WRITES NOTHING.
    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId },
      reads: [{ meterId: next.meterId, value: 49000 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(404)
    expect(r.body.data).toBeUndefined()

    // RV 05's READING OF RECORD IS THE ONE IT HAD. No move_out_final dated
    // today, so its own occupant's next bill still measures from 48,000.
    const onNext = await readings(next.meterId)
    expect(onNext).toHaveLength(1)
    expect(onNext[0]).toMatchObject({ reason: 'monthly_cycle', needs_review: false })
    expect(Number(onNext[0].v)).toBe(48000)

    // AND NOBODY WAS BILLED ANYBODY ELSE'S KILOWATTS — not on RV 05's meter,
    // not on RV 27's, and nothing absorbed on either book.
    expect(await bills(next.meterId)).toHaveLength(0)
    expect(await bills(p.meterId)).toHaveLength(0)
    expect(await absorbed(next.meterId)).toHaveLength(0)
    expect(await absorbed(p.meterId)).toHaveLength(0)
    expect(await invoices(p.landlordId)).toHaveLength(0)
    expect(emailMock).not.toHaveBeenCalled()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('slipped in beside the right meter, it writes NEITHER read', async () => {
    const p = await park()
    const next = await spaceNextDoor(p)
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })

    // One screen, one confirm (D4): the site's own meter is checked and good,
    // and the second box names the space next door. Neither read lands.
    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId },
      reads: [{ meterId: p.meterId, value: 48387 }, { meterId: next.meterId, value: 49000 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(404)
    expect(await readings(p.meterId)).toHaveLength(1)
    expect(await readings(next.meterId)).toHaveLength(1)
    expect(await bills(p.meterId)).toHaveLength(0)
    expect(await bills(next.meterId)).toHaveLength(0)

    // The desk retypes it on the site's own meter and the ordinary read works.
    const ok = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId },
      reads: [{ meterId: p.meterId, value: 48387 }] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.data.lines[0].price).toBe(81.27)
    expect(await readings(next.meterId)).toHaveLength(1)
    expect(await bills(next.meterId)).toHaveLength(0)
  })
})

/**
 * ONE BOX PER POLE — found in the same pass as the space fault above, and the
 * same shape of fault: a `reads` list from a browser taken at its word.
 *
 * Nothing refused two boxes for one meter. The quote prices every box against
 * the meter's reading of record BEFORE anything is written, so both boxes
 * quoted off the same old figure; the confirm then re-read the meter box by
 * box, so the second box was measured from the FIRST box's just-written
 * figure. The desk read one amount out to the payer and a different one went on
 * the ticket, with a second closing read left on the pole — and the figure on
 * the screen agreeing with the figure on the ticket is the one promise this
 * door makes.
 */
describe('a pole is read once', () => {
  it('refuses the same meter sent twice, at both doors, and writes nothing', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, withAgreement: true })

    const r = await putOnTicket(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [
      { meterId: p.meterId, value: 48387 },
      { meterId: p.meterId, value: 48500 },
    ] })
    expect(r.status, JSON.stringify(r.body)).toBe(400)
    // Blind at a refusal too: what to do, never a figure.
    expect(r.body.error).not.toMatch(/\d/)

    // Not one read, not one bill — refused before either door touched a meter.
    expect(await readings(p.meterId)).toHaveLength(1)
    expect(await bills(p.meterId)).toHaveLength(0)
    expect(await absorbed(p.meterId)).toHaveLength(0)
    expect(await invoices(p.landlordId)).toHaveLength(0)

    // And the quote door answers it identically — both doors, one answer.
    const q = await checkRead(p, { closing: { kind: 'stay', id: s.bookingId }, reads: [
      { meterId: p.meterId, value: 48387 },
      { meterId: p.meterId, value: 48500 },
    ] })
    expect(q.status, JSON.stringify(q.body)).toBe(400)
    expect(q.body.error).toBe(r.body.error)
  })
})


/**
 * 10/21 (Nic) — THE CHECKOUT TAB'S OWN DOOR.
 *
 *   "on the point of sale, how we have the tabs at the top for register,
 *    history, customers, maybe there's another one that says checkout… when
 *    somebody's checking out, the point of sale should communicate with the
 *    unit and any submeters applicable to that unit… I want the determination
 *    of checking out to automatically know all of the things to bill for, not
 *    just targeted electric."
 *
 * The tab opens on who is due out — the schedule's own answer, not a status
 * anybody typed — and picking one of them reaches the SAME closing the person
 * search reaches, with the same meters and the same figures.
 */
describe('10/21 (Nic): who is due out, and what checking them out knows to bill for', () => {
  const dueOut = (p: Park) => request(buildApp())
    .get(`/api/pos/checkout/due-out?propertyId=${p.propertyId}`)
    .set('Authorization', `Bearer ${p.token}`)

  it('lists the guest whose last day has come or gone and who is still here, with every meter on their site and what their stay still owes', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    // Still here, their week up yesterday, $300 stay with nothing paid on it.
    const here = await stay(p, { email, nights: 8, checkIn: day(-8), checkOut: day(-1), status: 'checked_in', total: 300 })

    const r = await dueOut(p)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.closings.map((c: any) => [c.kind, c.id, c.spaceLabel, c.who, c.owed, c.meters.length]))
      .toEqual([['stay', here.bookingId, 'RV 27', 'Andres Razo', 300, 1]])
    // The site's own meter, named as the landlord named it — the unit answers,
    // the counter never picks a space.
    expect(r.body.data.closings[0].meters[0]).toMatchObject({ meterId: p.meterId, utilityType: 'electric' })
  })

  it('is the schedule, not a list of everyone: not a guest still running, not one already checked out, not a lease-backed stay, not another park\'s', async () => {
    const p = await park()
    const mine = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const here = await stay(p, { email: mine, nights: 8, checkIn: day(-8), checkOut: day(-1), status: 'checked_in', total: 300 })
    // Still running: their last day is tomorrow.
    await stay(p, { email: `later-${mine}`, nights: 3, checkIn: day(-2), checkOut: day(1), status: 'checked_in' })
    // Already checked out: settled up and gone, and found by name if need be.
    await stay(p, { email: `gone-${mine}`, nights: 3, checkIn: day(-9), checkOut: day(-6), status: 'checked_out' })
    // A stay its lease bills is the lease's, never a stay to close out here.
    const c = await db.connect()
    try {
      const other = await seedUnit(c, { propertyId: p.propertyId, landlordId: p.landlordId, unitType: 'rv_spot', rentAmount: 589 })
      const leased = await stay(p, { email: `leased-${mine}`, nights: 40, checkIn: day(-40), checkOut: day(-1), status: 'checked_in', unitId: other })
      const leaseId = await seedLease(c, { unitId: other, landlordId: p.landlordId, rentAmount: 589, status: 'active' })
      await c.query(`UPDATE leases SET source_booking_id = $2 WHERE id = $1`, [leaseId, leased.bookingId])
    } finally { c.release() }

    const r = await dueOut(p)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.closings.map((x: any) => x.id)).toEqual([here.bookingId])

    // Another company's register cannot read this park's departures at all —
    // refused on the property, before a single booking is read (the same guard
    // every other door at this register uses).
    const q = await park()
    const theirs = await request(buildApp())
      .get(`/api/pos/checkout/due-out?propertyId=${p.propertyId}`)
      .set('Authorization', `Bearer ${q.token}`)
    expect(theirs.status).toBe(400)
    expect(JSON.stringify(theirs.body)).not.toContain(here.bookingId)
  })

  it('a closing reached from the list reads and bills exactly as one reached by name', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 35, checkIn: day(-35), checkOut: day(-1), status: 'checked_in', withAgreement: true })
    const g = await guestRecord(p, { email })

    const listed = (await dueOut(p)).body.data.closings[0]
    const byName = (await lookUp(p, { posCustomerId: g.posCustomerId })).body.data.closings
      .find((c: any) => c.id === s.bookingId)
    expect(listed).toEqual(byName)

    // And the read taken off it goes on the ticket the ordinary way.
    const r = await putOnTicket(p, { closing: { kind: listed.kind, id: listed.id }, reads: [{ meterId: p.meterId, value: 48387 }] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.lines).toHaveLength(1)
    expect(await bills(p.meterId)).toHaveLength(1)
    // Nothing emailed, nothing on an invoice — the ticket is the bill.
    expect(emailMock).not.toHaveBeenCalled()
    expect(await invoices(p.landlordId)).toHaveLength(0)
  })

  it('a lease says nothing is owed on it here — rent is its household\'s invoice, never a register line', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const who = await resident(p, { email })
    const r = await lookUp(p, { tenantId: who.tenantId })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const lease = r.body.data.closings.find((c: any) => c.kind === 'lease')
    expect(lease).toMatchObject({ owed: null, who: null })
  })

  it('a cancelled stay asks for nothing — a closed reservation never becomes a figure at the counter', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await stay(p, { email, nights: 4, checkIn: day(-4), checkOut: day(-1), total: 300 })
    await db.query(`UPDATE unit_bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [s.bookingId])
    const g = await guestRecord(p, { email })
    const r = await lookUp(p, { posCustomerId: g.posCustomerId })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    // Cancelled is not one of the statuses a closing is read from at all.
    expect(r.body.data.closings.filter((c: any) => c.kind === 'stay')).toHaveLength(0)
  })
})

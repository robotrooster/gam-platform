/**
 * 10/5 (Nic) — PREPAID STAYS AT THE REGISTER AND ON PAY LINKS.
 *
 *   "At the point of sale, same thing, except it's the front counter person
 *    that's clicking lease or no lease. And either way, it goes to me. ...
 *    point of sale cannot prorate a stay. And if they choose the lease option,
 *    then it can prorate according to the property settings."
 *
 * The rules live in services/stayTerms (stayNeeds and friends) and are tested
 * there. This is the register's door: a stay rung at the counter or sent on a
 * link is priced whole (R5), asks for an email over three weeks and for lease
 * or no lease at 30+ nights (R2/R7), carries the background check's fee as a
 * line nobody can take off (R8), and "Add a month" lengthens the stay that is
 * here now (R6).
 *
 * Stripe and the emails are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  checkoutMock: vi.fn(async (_p: any) => ({ id: `cs_test_${Math.random().toString(36).slice(2)}`, url: 'https://checkout.stripe.test/x' })),
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
  screeningMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  utilityInviteMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  receiptMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  // The card reader (10/5 A5: a card sale at the register).
  retrieveIntentMock: vi.fn(async (_o: any): Promise<any> => null),
  captureMock: vi.fn(async (o: any) => ({ id: o.paymentIntentId, status: 'succeeded' })),
}))
vi.mock('../services/posTerminal', async (orig) => ({
  ...(await orig() as any),
  retrieveTerminalPaymentIntentWithCharge: h.retrieveIntentMock,
  captureTerminalPaymentIntent: h.captureMock,
}))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ checkout: { sessions: { create: h.checkoutMock, retrieve: async (id: string) => ({ id, status: 'expired', payment_status: 'unpaid' }), expire: async () => undefined } } }),
}))
vi.mock('../services/stripeConnect', async (orig) => ({ ...(await orig() as any), expirePayLinkCheckoutSession: vi.fn(async () => undefined) }))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailPayLink: h.emailPayLinkMock,
  emailBackgroundCheckScreeningRequest: h.screeningMock,
  emailUtilityServiceInvite: h.utilityInviteMock,
  emailPosReceipt: h.receiptMock,
}))
vi.mock('../services/posCustomerCards', async (orig) => ({ ...(await orig() as any), readSaleCard: vi.fn(async () => null) }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { stayHeldWords } from '@gam/shared'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { posRouter } from './pos'
import { posPayLinksRouter, finalizePayLink, payLinkCharge, createScreeningFeeLink, createBookingDepositLink } from './posPayLinks'
import { stayNeeds } from '../services/stayTerms'
import { reservationDue, SCREENING_LINE_NAME } from '../services/registerStay'
import { incomeEvents } from '../services/incomeBasis'

function app() {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  a.use('/api/pos/pay-links', posPayLinksRouter)
  a.use('/api/pos', posRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  for (const m of [h.checkoutMock, h.emailPayLinkMock, h.screeningMock, h.utilityInviteMock, h.receiptMock, h.retrieveIntentMock, h.captureMock]) m.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pos_stay_terms'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_stay_' || replace($1::text,'-','') WHERE id = $1`, [landlordId])
    await c.query(`UPDATE properties SET booking_monthly_deposit = 150 WHERE id = $1`, [propertyId])
    const cat = (await c.query(`INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stays',1,TRUE) RETURNING id`, [landlordId])).rows[0].id
    const month = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — monthly',$3,0,0,0,999,0,999,'month') RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const sites: string[] = []
    for (const n of ['RV 01', 'RV 02']) {
      sites.push((await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, monthly_rate, is_bookable)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',40,440,TRUE) RETURNING id`, [propertyId, landlordId, n])).rows[0].id)
    }
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, month, sites, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type F = Awaited<ReturnType<typeof seed>>
const auth = (f: F) => ({ Authorization: `Bearer ${f.token}` })

/** The background check's fee for a guest with nothing on file — the server's own figure. */
async function feeFor(f: F, email: string, checkIn: string, checkOut: string): Promise<number> {
  const n = await stayNeeds({ landlordId: f.landlordId, propertyId: f.propertyId, email, checkIn, checkOut })
  expect(n.screening).toBe('fee_due')
  return n.screeningFee!.amount
}
const monthLine = (f: F, extra: any = {}) => ({ id: f.month, name: 'RV site — monthly', qty: 1, price: 440, tax: 0, ...extra })
const ring = (f: F, stay: any, extra: any = {}) => request(app()).post('/api/pos/transactions').set(auth(f))
  .send({ propertyId: f.propertyId, paymentMethod: 'cash', items: [monthLine(f, { stayUnitId: stay.unitId, stayCheckIn: stay.checkIn, ...(extra.line ?? {}) })], stay, ...(extra.body ?? {}) })
const dale = (f: F, more: any = {}) => ({ unitId: f.sites[0], checkIn: '2027-06-01', guestName: 'Dale Carter', ...more })

describe('a month rung at the register (30 nights, Jun 1 → Jul 1)', () => {
  it('needs the guest\'s email and the counter\'s lease-or-no-lease answer before any money moves', async () => {
    const f = await seed()
    const noEmail = await ring(f, dale(f))
    expect(noEmail.status).toBe(400)
    expect(noEmail.body.error).toMatch(/^This stay comes to 30 nights in a row — a stay over three weeks needs the guest's email/)
    const noAnswer = await ring(f, dale(f, { guestEmail: 'dale@t.dev' }))
    expect(noAnswer.status).toBe(409)
    expect(noAnswer.body.error).toMatch(/so ask them: lease or no lease\? A lease holds their site for as long as they stay\. A stay holds it only through the time they have paid for\./)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(0)
  })

  it('the stay picker\'s quote is the server\'s: whole month at the monthly rate, the fee due, the answer needed — then the held-through words', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const quote = (body: any) => request(app()).post('/api/pos/stays/quote').set(auth(f))
      .send({ propertyId: f.propertyId, itemId: f.month, qty: 1, unitId: f.sites[0], checkIn: '2027-06-01', guestEmail: 'dale@t.dev', ...body })
    const first = await quote({})
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.data).toMatchObject({ checkOut: '2027-07-01', nights: 30, charge: 440, stayTotal: 440, lodgingTax: 0,
      screening: 'fee_due', screeningFee: fee, screeningLineName: SCREENING_LINE_NAME, leaseChoice: 'needed', terms: null, heldWords: null })
    const stay = await quote({ stayTerms: 'stay' })
    expect(stay.body.data).toMatchObject({ terms: 'stay', heldWords: stayHeldWords('2027-07-01') })
    const lease = await quote({ stayTerms: 'lease' })
    expect(lease.body.data).toMatchObject({ terms: 'lease', depositOnly: true, charge: 150, heldWords: null })
  })

  it('no lease: sold whole, the background check its own line — recorded as GAM\'s, taken from the landlord\'s payout, never refunded from the drawer', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    // A fee the register never showed is never charged.
    const unseen = await ring(f, dale(f, { guestEmail: 'dale@t.dev', stayTerms: 'stay' }))
    expect(unseen.status).toBe(409)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)

    const sale = await ring(f, dale(f, { guestEmail: 'dale@t.dev', stayTerms: 'stay', screeningFee: fee }))
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBe(Math.round((440 + fee) * 100) / 100)
    expect(sale.body.data.items).toEqual([
      { id: f.month, name: 'RV site — monthly — 30 nights at site RV 01 (Jun 1 → Jul 1)', qty: 1, price: 440, tax: 0 },
      { id: null, name: SCREENING_LINE_NAME, qty: 1, price: fee, tax: 0 },
    ])
    expect(sale.body.data.stayBooking).toMatchObject({ terms: 'stay', heldWords: stayHeldWords('2027-07-01'), screeningFee: fee, screeningEmail: 'dale@t.dev' })
    const [b] = await query<any>(
      `SELECT id, stay_terms, screening_required, total_amount::float AS total, balance_paid_at, guest_email FROM unit_bookings`)
    expect(b).toMatchObject({ stay_terms: 'stay', screening_required: true, total: 440, guest_email: 'dale@t.dev' })
    expect(b.balance_paid_at).not.toBeNull()
    // The stay's money is the stay's — the check is not part of it.
    expect(await query<any>(`SELECT toward_stay::text FROM stay_payments WHERE booking_id = $1`, [b.id])).toEqual([{ toward_stay: '440.00' }])
    const [sp] = await query<any>(`SELECT amount::float AS amount, source, source_id, status, landlord_charge_id FROM screening_prepayments WHERE booking_id = $1`, [b.id])
    expect(sp).toMatchObject({ amount: fee, source: 'register', source_id: sale.body.data.id, status: 'unused' })
    expect(await query<any>(`SELECT kind, amount::float AS amount FROM landlord_gam_charges WHERE id = $1`, [sp.landlord_charge_id]))
      .toEqual([{ kind: 'screening_fee', amount: fee }])
    expect(h.screeningMock).toHaveBeenCalledTimes(1)
    // "Either way, it goes to me."
    expect(await query<any>(`SELECT type FROM notifications WHERE landlord_id = $1 AND type LIKE 'long_stay%'`, [f.landlordId]))
      .toEqual([{ type: 'long_stay_no_lease' }])

    // The drawer hands back the stay at most — never GAM's check.
    const all = await request(app()).post(`/api/pos/transactions/${sale.body.data.id}/refund`).set(auth(f)).send({ reason: 'Leaving', refundMethod: 'cash' })
    expect(all.status).toBe(400)
    expect(all.body.error).toBe(`$${fee.toFixed(2)} of this sale is the guest's background check, which is not refunded — $440.00 at most can be refunded here. Change the amount, then press Refund again.`)
  })

  it('lease: the sale takes its deposit (and the check), and a month-to-month lease is drafted for the landlord', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const sale = await ring(f, dale(f, { guestEmail: 'dale@t.dev', stayTerms: 'lease', screeningFee: fee }), { line: { stayTotal: 150 } })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBe(Math.round((150 + fee) * 100) / 100)
    expect(sale.body.data.items[0].name).toBe('RV site — monthly — 30 nights at site RV 01 (Jun 1 → Jul 1) — the deposit now; its lease bills the rest')
    const [b] = await query<any>(`SELECT id, stay_terms, deposit_amount::float AS deposit, total_amount::float AS total, balance_paid_at FROM unit_bookings`)
    expect(b).toMatchObject({ stay_terms: 'lease', deposit: 150, total: 440, balance_paid_at: null })
    const [lease] = await query<any>(`SELECT id, lease_type, status, end_date, lease_source FROM leases WHERE source_booking_id = $1`, [b.id])
    expect(lease).toMatchObject({ lease_type: 'month_to_month', status: 'pending', end_date: null, lease_source: 'booking_draft' })
    expect(sale.body.data.stayBooking).toMatchObject({ terms: 'lease', leaseId: lease.id, heldWords: null })
    expect(await reservationDue(db, b.id)).toMatchObject({ leaseBillsRest: true, owed: 0 })
  })
})

describe('Add a month at the register (R6)', () => {
  /** Dale's month, paid at the counter, his check already paid for. */
  async function hereNow(f: F) {
    const b = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, booked_check_out, nights,
                                  total_amount, status, source, deposit_paid_at, balance_billed_at, balance_paid_at, stay_terms, screening_required)
       VALUES ($1,$2,'Dale Carter','dale@t.dev','month_to_month','2027-06-01','2027-07-01','2027-07-01',30,440,'checked_in','register',NOW(),NOW(),NOW(),'stay',TRUE)
       RETURNING id`, [f.sites[0], f.landlordId]))[0].id
    await query(`INSERT INTO screening_prepayments (landlord_id, property_id, booking_id, email, amount, source) VALUES ($1,$2,$3,'dale@t.dev',42.94,'register')`,
      [f.landlordId, f.propertyId, b])
    return b
  }
  const addMonth = (f: F, b: string, extra: any = {}) => ring(f, { extendBookingId: b, unitId: f.sites[0], checkIn: '2027-07-01', ...extra })

  it('lengthens the SAME booking a calendar month at the monthly rate, paid here — no second stay, no proration', async () => {
    const f = await seed()
    const b = await hereNow(f)
    const listed = await request(app()).get(`/api/pos/stays/current?propertyId=${f.propertyId}&q=dale`).set(auth(f))
    expect(listed.body.data.map((x: any) => x.bookingId)).toEqual([b])
    const sale = await addMonth(f, b)
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBe(440)
    expect(sale.body.data.stayBooking).toMatchObject({ bookingId: b, checkOut: '2027-08-01', heldWords: stayHeldWords('2027-08-01') })
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(1)
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-08-01', total: 880, paid: 880, owed: 0, paidInFull: true })
  })

  it('is refused when somebody else has the site for any night of that month — nothing is charged', async () => {
    const f = await seed()
    const b = await hereNow(f)
    await query(`INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type, check_in, check_out, nights, total_amount, status)
                 VALUES ($1,$2,'Next Guest','nightly','2027-07-20','2027-07-22',2,80,'confirmed')`, [f.sites[0], f.landlordId])
    const sale = await addMonth(f, b)
    expect(sale.status).toBe(409)
    expect(sale.body.error).toMatch(/^Site RV 01 is not free for the whole month from July 1, 2027 to August 1, 2027/)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-07-01', total: 440 })
  })
})

describe('a stay sent on a pay link', () => {
  const sendLink = (f: F, body: any) => request(app()).post('/api/pos/pay-links').set(auth(f))
    .send({ propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Dale Carter', email: 'dale@t.dev' }, ...body })
  const paidOnline = (link: any, pi: string) => finalizePayLink({
    id: link.last_checkout_session_id ?? 'cs_any', amount_total: Math.round(payLinkCharge(Number(link.total)).charged * 100), payment_intent: pi,
    metadata: { gam_pay_link_id: link.id, gam_landlord_id: link.landlord_id ?? link.landlordId },
    customer_details: { name: 'Dale Carter', email: 'dale@t.dev' },
  })

  it('carries the background check as its own line; paid online, the check waits for the guest and the landlord is told', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const sent = await sendLink(f, { items: [monthLine(f)], stay: dale(f, { guestEmail: 'dale@t.dev', stayTerms: 'stay', screeningFee: fee }) })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(Number(sent.body.data.total)).toBe(Math.round((440 + fee) * 100) / 100)
    const link = (await query<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [sent.body.data.id]))[0]
    expect(link.label).toBe('RV site — monthly — 30 nights at site RV 01 (Jun 1 → Jul 1)')
    expect(link.items.find((l: any) => l.screening)).toMatchObject({ id: null, name: SCREENING_LINE_NAME, price: fee, qty: 1 })
    expect(await reservationDue(db, link.booking_id)).toMatchObject({ total: 440, owed: 440, leaseBillsRest: false })

    expect(await paidOnline(link, 'pi_stay_link')).toEqual({ recorded: true })
    expect(await reservationDue(db, link.booking_id)).toMatchObject({ paid: 440, owed: 0, paidInFull: true })
    const [sp] = await query<any>(`SELECT amount::float AS amount, source, source_id, landlord_charge_id FROM screening_prepayments WHERE booking_id = $1`, [link.booking_id])
    // 10/5 (A5): paid online, the check is on GAM's balance — kept out of the
    // landlord's payout share and never also charged back to them.
    expect(sp).toEqual({ amount: fee, source: 'pay_link', source_id: link.id, landlord_charge_id: null })
    expect(await query('SELECT 1 FROM landlord_gam_charges')).toHaveLength(0)
    const [sale] = await query<any>(`SELECT id FROM pos_transactions WHERE pay_link_id = $1`, [link.id])
    expect(await query<any>(`SELECT amount::float AS amount FROM held_payout_items WHERE source_type = 'pos_sale' AND source_id = $1`, [sale.id]))
      .toEqual([{ amount: Math.round((payLinkCharge(Number(link.total)).held - fee) * 100) / 100 }])
    expect(h.screeningMock).toHaveBeenCalledTimes(1)
    // The email the guest was sent says how long the site is held (R13) and what the check is for.
    const note = String(h.emailPayLinkMock.mock.calls[0][0].note)
    expect(note.startsWith(stayHeldWords('2027-07-01'))).toBe(true)
    expect(note).toContain('Your stay comes to more than three weeks, so a background check is required.')
    expect(await query<any>(`SELECT type FROM notifications WHERE landlord_id = $1 AND type LIKE 'long_stay%'`, [f.landlordId]))
      .toEqual([{ type: 'long_stay_no_lease' }])
  })

  it('a lease is sent for its deposit; Adjust cannot take the check off', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const sent = await sendLink(f, { items: [monthLine(f, { stayTotal: 150 })], stay: dale(f, { guestEmail: 'dale@t.dev', stayTerms: 'lease', screeningFee: fee }) })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(Number(sent.body.data.total)).toBe(Math.round((150 + fee) * 100) / 100)
    const link = (await query<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [sent.body.data.id]))[0]
    expect(await reservationDue(db, link.booking_id)).toMatchObject({ leaseBillsRest: true, owed: 150 })
    const adjusted = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth(f))
      .send({ items: link.items.filter((l: any) => !l.screening) })
    expect(adjusted.status).toBe(400)
    expect(adjusted.body.error).toMatch(/^This link carries the guest's background check/)
  })

  it('"Add a month" on a link takes the month off the board when it is sent; closed unpaid, the month goes back', async () => {
    const f = await seed()
    const b = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, booked_check_out, nights,
                                  total_amount, status, source, deposit_paid_at, balance_billed_at, balance_paid_at)
       VALUES ($1,$2,'Dale Carter','dale@t.dev','nightly','2027-06-01','2027-06-11','2027-06-11',10,400,'checked_in','register',NOW(),NOW(),NOW())
       RETURNING id`, [f.sites[0], f.landlordId]))[0].id
    // Ten nights plus a month is 40 nights in a row: the check's fee and the counter's answer.
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-11')
    const sent = await sendLink(f, { items: [monthLine(f)], stay: { extendBookingId: b, stayTerms: 'stay', screeningFee: fee } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(Number(sent.body.data.total)).toBe(Math.round((440 + fee) * 100) / 100)
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-07-11', total: 840, paid: 400, owed: 440 })
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(1)
    const closed = await request(app()).post(`/api/pos/pay-links/${sent.body.data.id}/cancel`).set(auth(f))
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect(closed.body.data).toEqual({ stayCancelled: false, monthGivenBack: true })
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-06-11', total: 400, owed: 0, paidInFull: true })
  })
})


// ── 10/5 fix round: A5 money, the schedule's ticket (M2), Add a month answered lease (M5),
//    the fee-only link and the deposit link (A2), landlord income (M10), the receipt (F6) ──

describe('the background check by card at the register (A5)', () => {
  it('stays on GAM\'s balance — out of the landlord\'s payout share, no charge line', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const stay = dale(f, { guestEmail: 'dale@t.dev', stayTerms: 'stay', screeningFee: fee })
    const items = [monthLine(f, { stayUnitId: stay.unitId, stayCheckIn: stay.checkIn })]
    const quote = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ propertyId: f.propertyId, items, stay, paymentMethod: 'card' })
    expect(quote.status, JSON.stringify(quote.body)).toBe(200)
    const total = Number(quote.body.data.total)
    const cardFee = Number(quote.body.data.cardFee)
    h.retrieveIntentMock.mockResolvedValue({ id: 'pi_card_stay', status: 'requires_capture', amount: Math.round(total * 100),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId } })
    const sale = await request(app()).post('/api/pos/transactions').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'card', stripePaymentIntentId: 'pi_card_stay', items, stay })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(h.captureMock).toHaveBeenCalledTimes(1)
    const [sp] = await query<any>(`SELECT source, landlord_charge_id FROM screening_prepayments`)
    expect(sp).toEqual({ source: 'register', landlord_charge_id: null })
    expect(await query('SELECT 1 FROM landlord_gam_charges')).toHaveLength(0)
    expect(await query<any>(`SELECT amount::float AS amount FROM held_payout_items WHERE source_type = 'pos_sale' AND source_id = $1`, [sale.body.data.id]))
      .toEqual([{ amount: Math.round((total - cardFee - fee) * 100) / 100 }])
  })
})

describe('a reservation ticket from the schedule that carries the background check (M2)', () => {
  /** Dale's month on the schedule, unpaid, handed to the till with the check's fixed line. */
  async function scheduled(f: F, fee: number) {
    const b = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, booked_check_out, nights,
                                  total_amount, status, source, stay_terms, screening_required)
       VALUES ($1,$2,'Dale Carter','dale@t.dev','month_to_month','2027-06-01','2027-07-01','2027-07-01',30,440,'tentative','manual','stay',TRUE)
       RETURNING id`, [f.sites[0], f.landlordId]))[0].id
    const t = (await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
       VALUES ($1,$2,$3,$4::jsonb,'Dale · site RV 01',$5) RETURNING id`,
      [f.landlordId, f.propertyId, f.userId, JSON.stringify([
        { id: f.month, name: 'RV site — monthly', qty: 1, price: 0, tax: 0 },
        { id: null, name: SCREENING_LINE_NAME, qty: 1, price: fee, tax: 0, screening: true },
      ]), b]))[0].id
    return { b, t }
  }
  const opened = async (f: F, t: string) => {
    const r = await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}`).set(auth(f))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return r.body.data.items.map((i: any) => ({ id: i.id ?? null, name: i.name, qty: i.qty, price: i.price, tax: i.tax, ...(i.reservation ? { reservation: true } : {}) }))
  }

  it('settles in cash: the check is recorded as the guest\'s (source schedule) and taken from the landlord\'s payout', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const { b, t } = await scheduled(f, fee)
    const cart = await opened(f, t)
    expect(cart.find((i: any) => i.name === SCREENING_LINE_NAME)).toMatchObject({ id: null, price: fee, qty: 1 })
    // It cannot be taken off.
    const without = await request(app()).post('/api/pos/transactions').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', openTicketId: t, items: cart.filter((i: any) => i.name !== SCREENING_LINE_NAME) })
    expect(without.status).toBe(400)
    expect(without.body.error).toMatch(/^This ticket carries the guest's background check/)
    const sale = await request(app()).post('/api/pos/transactions').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', openTicketId: t, items: cart })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBe(Math.round((440 + fee) * 100) / 100)
    const [sp] = await query<any>(`SELECT amount::float AS amount, source, source_id, landlord_charge_id FROM screening_prepayments WHERE booking_id = $1`, [b])
    expect(sp).toMatchObject({ amount: fee, source: 'schedule', source_id: sale.body.data.id })
    expect(await query<any>(`SELECT kind, amount::float AS amount FROM landlord_gam_charges WHERE id = $1`, [sp.landlord_charge_id]))
      .toEqual([{ kind: 'screening_fee', amount: fee }])
    expect(await query<any>(`SELECT toward_stay::text FROM stay_payments WHERE booking_id = $1`, [b])).toEqual([{ toward_stay: '440.00' }])
    expect(h.screeningMock).toHaveBeenCalledTimes(1)
    // M10: the landlord's income is the stay, never GAM's check.
    const ev = await incomeEvents({ landlordIds: [f.landlordId], start: '2026-01-01', end: '2028-12-31', basis: 'received' })
    expect(ev.filter((e) => e.line === 'registerAndStays').reduce((n, e) => n + e.amount, 0)).toBeCloseTo(440, 2)
  })

  it('a charge account cannot take it', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const { t } = await scheduled(f, fee)
    const sale = await request(app()).post('/api/pos/transactions').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'charge', openTicketId: t, items: await opened(f, t) })
    expect(sale.status).toBe(400)
    expect(sale.body.error).toBe('A background check cannot go on a charge account — it is paid when the stay is sold. Take cash, a check or a card for this sale, then press Charge again. Nothing was charged.')
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('put back on the list, the ticket keeps the check exactly as the schedule wrote it', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const { t } = await scheduled(f, fee)
    const put = await request(app()).put(`/api/pos/tickets/${t}`).set(auth(f))
      .send({ propertyId: f.propertyId, items: [{ id: f.month, name: 'RV site — monthly', qty: 1, price: 0, tax: 0 },
                                                { id: null, name: SCREENING_LINE_NAME, qty: 1, price: 1, tax: 0 }] })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    const [row] = await query<any>(`SELECT items FROM pos_open_tickets WHERE id = $1`, [t])
    expect(row.items.filter((i: any) => i.screening)).toEqual([{ id: null, name: SCREENING_LINE_NAME, qty: 1, price: fee, tax: 0, screening: true }])
  })
})

describe('Add a month answered lease (M5)', () => {
  it('sells no month: the quote says so, Charge refuses, and Draft their lease drafts it', async () => {
    const f = await seed()
    const b = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, booked_check_out, nights,
                                  total_amount, status, source, deposit_paid_at, balance_billed_at, balance_paid_at, screening_required)
       VALUES ($1,$2,'Dale Carter','dale@t.dev','nightly','2027-06-01','2027-06-11','2027-06-11',10,400,'checked_in','register',NOW(),NOW(),NOW(),FALSE)
       RETURNING id`, [f.sites[0], f.landlordId]))[0].id
    await query(`INSERT INTO screening_prepayments (landlord_id, property_id, booking_id, email, amount, source) VALUES ($1,$2,$3,'dale@t.dev',42.94,'register')`,
      [f.landlordId, f.propertyId, b])
    const quote = await request(app()).post('/api/pos/stays/quote').set(auth(f))
      .send({ propertyId: f.propertyId, itemId: f.month, qty: 1, extendBookingId: b, stayTerms: 'lease' })
    expect(quote.status, JSON.stringify(quote.body)).toBe(200)
    expect(quote.body.data).toMatchObject({ terms: 'lease', leaseInstead: true })
    const sale = await ring(f, { extendBookingId: b, unitId: f.sites[0], checkIn: '2027-06-11', stayTerms: 'lease' })
    expect(sale.status).toBe(409)
    expect(sale.body.error).toMatch(/^They chose a lease, so no month is sold here/)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
    const drafted = await request(app()).post('/api/pos/stays/lease').set(auth(f)).send({ propertyId: f.propertyId, bookingId: b })
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(200)
    const [lease] = await query<any>(`SELECT id, lease_type, status, end_date FROM leases WHERE source_booking_id = $1`, [b])
    expect(lease).toMatchObject({ id: drafted.body.data.leaseId, lease_type: 'month_to_month', status: 'pending', end_date: null })
    // No month was added on top of the lease.
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-06-11' })
  })

  it('a link for the month answered lease is refused — nothing is sent', async () => {
    const f = await seed()
    const b = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, booked_check_out, nights,
                                  total_amount, status, source, deposit_paid_at, balance_billed_at, balance_paid_at)
       VALUES ($1,$2,'Dale Carter','dale@t.dev','nightly','2027-06-01','2027-06-11','2027-06-11',10,400,'checked_in','register',NOW(),NOW(),NOW())
       RETURNING id`, [f.sites[0], f.landlordId]))[0].id
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-11')
    const sent = await request(app()).post('/api/pos/pay-links').set(auth(f))
      .send({ propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Dale Carter', email: 'dale@t.dev' },
              items: [monthLine(f)], stay: { extendBookingId: b, stayTerms: 'lease', screeningFee: fee } })
    expect(sent.status).toBe(409)
    expect(sent.body.error).toMatch(/^They chose a lease, so no month is sent/)
    expect(await query('SELECT 1 FROM pos_pay_links')).toHaveLength(0)
    expect(await reservationDue(db, b)).toMatchObject({ checkOut: '2027-06-11' })
  })
})

describe('links the schedule sends for the background check (A2)', () => {
  async function confirmedStay(f: F) {
    return (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, booked_check_out, nights,
                                  total_amount, status, source, deposit_paid_at, balance_billed_at, balance_paid_at, stay_terms, screening_required)
       VALUES ($1,$2,'Dale Carter','dale@t.dev','month_to_month','2027-06-01','2027-07-01','2027-07-01',30,440,'confirmed','manual',NOW(),NOW(),NOW(),'stay',TRUE)
       RETURNING id`, [f.sites[0], f.landlordId]))[0].id
  }
  const paidOnline = (link: any, pi: string) => finalizePayLink({
    id: 'cs_any', amount_total: Math.round(payLinkCharge(Number(link.total)).charged * 100), payment_intent: pi,
    metadata: { gam_pay_link_id: link.id, gam_landlord_id: link.landlord_id }, customer_details: { name: 'Dale Carter', email: 'dale@t.dev' },
  })

  it('the fee alone: one link per stay, never toward the reservation; paid online it is GAM\'s and recorded from the schedule', async () => {
    const f = await seed()
    const b = await confirmedStay(f)
    expect(await createScreeningFeeLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 0, guestName: 'Dale', guestEmail: 'dale@t.dev' })).toBeNull()
    const one = await createScreeningFeeLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 42.94, guestName: 'Dale', guestEmail: 'Dale@T.dev' })
    const again = await createScreeningFeeLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 42.94, guestName: 'Dale', guestEmail: 'dale@t.dev' })
    expect(again).toEqual(one)
    expect(h.emailPayLinkMock).toHaveBeenCalledTimes(1)
    expect(h.emailPayLinkMock.mock.calls[0][0]).toMatchObject({ to: 'dale@t.dev', amount: 42.94, neverExpires: true })
    expect(h.emailPayLinkMock.mock.calls[0][0].note).toMatch(/background check is required/)
    const [link] = await query<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [one!.id])
    expect(link).toMatchObject({ booking_id: null, kind: 'one_time', status: 'open', expires_at: null })
    expect(link.items).toEqual([{ id: null, name: SCREENING_LINE_NAME, qty: 1, price: 42.94, tax: 0, screening: true, bookingId: b }])

    // 10/5 (review): the check alone is GAM's money, not the company's
    // payers' — paying it does not end the landlord's free onboarding.
    await query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [f.landlordId])
    expect(await paidOnline(link, 'pi_fee_only')).toEqual({ recorded: true })
    expect((await query<any>(`SELECT billing_starts_at FROM landlords WHERE id = $1`, [f.landlordId]))[0].billing_starts_at).toBeNull()
    const [sp] = await query<any>(`SELECT amount::float AS amount, source, source_id, landlord_charge_id FROM screening_prepayments WHERE booking_id = $1`, [b])
    expect(sp).toEqual({ amount: 42.94, source: 'schedule', source_id: link.id, landlord_charge_id: null })
    // Nothing of it is the landlord's: no payout share, no charge line, no income.
    const [sale] = await query<any>(`SELECT id FROM pos_transactions WHERE pay_link_id = $1`, [link.id])
    expect(await query(`SELECT 1 FROM held_payout_items WHERE source_id = $1`, [sale.id])).toHaveLength(0)
    expect(await query('SELECT 1 FROM landlord_gam_charges')).toHaveLength(0)
    const ev = await incomeEvents({ landlordIds: [f.landlordId], start: '2026-01-01', end: '2028-12-31', basis: 'received' })
    expect(ev.filter((e) => e.line === 'registerAndStays').reduce((n, e) => n + e.amount, 0)).toBeCloseTo(0, 2)
    // Paid for now — no second link.
    expect(await createScreeningFeeLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 42.94, guestName: 'Dale', guestEmail: 'dale@t.dev' })).toBeNull()
  })

  it('a deposit link carries the fee as its own line; a $0 deposit with a fee sends the fee alone', async () => {
    const f = await seed()
    const b = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, nights, total_amount, status, source, stay_terms)
       VALUES ($1,$2,'Dale Carter','dale@t.dev','month_to_month','2027-06-01','2027-07-01',30,440,'tentative','manual','stay') RETURNING id`,
      [f.sites[0], f.landlordId]))[0].id
    const dep = await createBookingDepositLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 150, guestName: 'Dale', guestEmail: 'dale@t.dev', screeningFee: 42.94 })
    const [link] = await query<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [dep!.id])
    expect(link).toMatchObject({ booking_id: b, total: '192.94', label: 'Reservation deposit and background check' })
    expect(link.items).toEqual([{ id: null, name: 'Reservation deposit', qty: 1, price: 150, tax: 0 },
                                { id: null, name: SCREENING_LINE_NAME, qty: 1, price: 42.94, tax: 0, screening: true }])
    await query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [f.landlordId])
    expect(await paidOnline(link, 'pi_dep_fee')).toEqual({ recorded: true })
    // 10/5: the deposit is the company's payer's money — onboarding ends.
    expect((await query<any>(`SELECT billing_starts_at = date_trunc('month', now())::date AS ok FROM landlords WHERE id = $1`, [f.landlordId]))[0].ok).toBe(true)
    expect(await reservationDue(db, b)).toMatchObject({ paid: 150, owed: 290 })
    const [sp] = await query<any>(`SELECT source, source_id, landlord_charge_id FROM screening_prepayments WHERE booking_id = $1`, [b])
    expect(sp).toEqual({ source: 'pay_link', source_id: link.id, landlord_charge_id: null })
    const [sale] = await query<any>(`SELECT id FROM pos_transactions WHERE pay_link_id = $1`, [link.id])
    expect(await query<any>(`SELECT amount::float AS amount FROM held_payout_items WHERE source_id = $1`, [sale.id])).toEqual([{ amount: 150 }])

    const b2 = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, nights, total_amount, status, source)
       VALUES ($1,$2,'Ann Lee','ann@t.dev','nightly','2027-08-01','2027-08-24',23,920,'tentative','manual') RETURNING id`,
      [f.sites[1], f.landlordId]))[0].id
    const feeOnly = await createBookingDepositLink({ bookingId: b2, landlordId: f.landlordId, propertyId: f.propertyId, amount: 0, guestName: 'Ann', guestEmail: 'ann@t.dev', screeningFee: 42.94 })
    const [l2] = await query<any>(`SELECT booking_id, total, items FROM pos_pay_links WHERE id = $1`, [feeOnly!.id])
    expect(l2).toMatchObject({ booking_id: null, total: '42.94' })
    expect(l2.items[0]).toMatchObject({ screening: true, bookingId: b2 })
  })
})

describe('the receipt of a 30+ night stay with no lease (F6, R13)', () => {
  it('says how long the site is held, in the email and on the PDF', async () => {
    const f = await seed()
    const fee = await feeFor(f, 'dale@t.dev', '2027-06-01', '2027-07-01')
    const sale = await ring(f, dale(f, { guestEmail: 'dale@t.dev', stayTerms: 'stay', screeningFee: fee }))
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    const sent = await request(app()).post(`/api/pos/transactions/${sale.body.data.id}/email-receipt`).set(auth(f)).send({ email: 'dale@t.dev' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(h.receiptMock).toHaveBeenCalledTimes(1)
    expect(h.receiptMock.mock.calls[0][6]).toEqual({ note: stayHeldWords('2027-07-01') })
  })
})

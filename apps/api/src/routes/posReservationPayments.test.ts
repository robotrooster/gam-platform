/**
 * 10/2 (review) — ONE PAYMENT, ONE CHARGE; A RESERVATION AT ITS OWN PRICE.
 *
 * Three ways the register could take money twice, or the wrong amount:
 *
 *   1. A pay link's Stripe card page open on the payer's phone while the desk
 *      settles the same link — both took the money. The desk now closes the
 *      page at Stripe first and charges nothing if the payer got there first;
 *      a payment that lands after the desk settled it records no second sale
 *      and tells the landlord, once.
 *   2. A reservation ticket written at $0 by the schedule's hand-off showed $0
 *      on the register — cash, change and the card all worked from $0 while the
 *      sale charged the site's rate. The server now prices it wherever a cart is
 *      totaled: the ticket, the quote, the card reader's charge, the sale.
 *   3. decisions #9: a reservation (ticket or link) charges exactly its own
 *      quoted price less what was paid — never item rate × quantity, never a
 *      discount — and paying it in full closes every other way of paying it.
 *
 * Stripe is mocked: the card pages (Checkout Sessions) and the card reader.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const pages = new Map<string, string>()   // checkout session id → its status at Stripe
  // onExpire: something that happens at Stripe the moment a page is being
  // closed — the payer opening the link again while the desk is mid-sale.
  const state = { stripeDown: false, n: 0, onExpire: null as null | (() => Promise<void>) }
  return {
    pages, state,
    // Stripe's checkout.sessions.create: a new card page, open.
    checkoutMock: vi.fn(async (_p: any) => {
      const id = `cs_test_${++state.n}`
      pages.set(id, 'open')
      return { id, url: `https://checkout.stripe.test/${id}` }
    }),
    expireMock: vi.fn(async (_landlordId: string, sessionId: string) => {
      if (state.stripeDown) throw new Error('stripe is down')
      if (pages.get(sessionId) === 'open') pages.set(sessionId, 'expired')
      const then = state.onExpire
      if (then) { state.onExpire = null; await then() }
    }),
    retrieveMock: vi.fn(async (sessionId: string) => {
      if (state.stripeDown) throw new Error('stripe is down')
      const status = pages.get(sessionId) ?? 'expired'
      return { id: sessionId, status, payment_status: status === 'complete' ? 'paid' : 'unpaid' }
    }),
    emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
    createIntentMock: vi.fn(async (o: any) => ({ id: 'pi_res_1', status: 'requires_payment_method', client_secret: 'pi_res_1_secret', amount: o.amountCents })),
    retrieveIntentMock: vi.fn(async (_o: any): Promise<any> => null),
    captureMock: vi.fn(async (o: any) => ({ id: o.paymentIntentId, status: 'succeeded' })),
    processMock: vi.fn(async (o: any) => ({ id: o.stripeReaderId, action: { status: 'in_progress' } })),
    // 10/3 (decisions #13): a held payment refunded through Stripe — only when the owner presses it.
    refundsMock: vi.fn(async (p: any, _o?: any) => ({ id: `re_${p.payment_intent}`, status: 'succeeded' })),
    // 10/3 (decisions #22): Stripe's fee on a payment ($0.37 here) — what it keeps when it is refunded.
    piRetrieveMock: vi.fn(async (id: string, _o?: any): Promise<any> => ({ id, latest_charge: { balance_transaction: { fee: 37 } } })),
    // 10/3 (S652): a guest whose unpaid hold was moved by a paid sale is emailed their new site.
    siteChangedMock: vi.fn(async (..._a: any[]) => undefined),
  }
})
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ checkout: { sessions: { create: h.checkoutMock, retrieve: h.retrieveMock, expire: async () => undefined } },
                      refunds: { create: h.refundsMock }, paymentIntents: { retrieve: h.piRetrieveMock } }),
}))
vi.mock('../services/stripeConnect', async (orig) => ({
  ...(await orig() as any), expirePayLinkCheckoutSession: h.expireMock,
}))
vi.mock('../services/email', async (orig) => ({ ...(await orig() as any), emailPayLink: h.emailPayLinkMock, emailBookingSiteChanged: h.siteChangedMock }))
vi.mock('../services/posCustomerCards', async (orig) => ({ ...(await orig() as any), readSaleCard: vi.fn(async () => null) }))
vi.mock('../services/posTerminal', async (orig) => ({
  ...(await orig() as any),
  createCardPresentPaymentIntent: h.createIntentMock,
  retrieveTerminalPaymentIntent: h.retrieveIntentMock,
  retrieveTerminalPaymentIntentWithCharge: h.retrieveIntentMock,
  captureTerminalPaymentIntent: h.captureMock,
  processPaymentIntentOnReader: h.processMock,
  showCartOnReader: vi.fn(async () => true),
  clearCartOnReader: vi.fn(async () => true),
  readerAction: vi.fn(async () => null),
  holdForTheCart: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { posRouter } from './pos'
import { posPayLinksRouter, publicPayRouter, finalizePayLink, payLinkCharge } from './posPayLinks'

function app() {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  a.use('/api/public', publicPayRouter)
  a.use('/api/pos/pay-links', posPayLinksRouter)
  a.use('/api/pos', posRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  h.pages.clear(); h.state.stripeDown = false; h.state.n = 0; h.state.onExpire = null
  for (const m of [h.checkoutMock, h.expireMock, h.retrieveMock, h.emailPayLinkMock, h.createIntentMock, h.retrieveIntentMock, h.captureMock, h.processMock, h.refundsMock, h.piRetrieveMock, h.siteChangedMock]) m.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_reservation_payments'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_resv_' || replace($1::text,'-','') WHERE id = $1`, [landlordId])
    const cat = (await c.query(`INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stuff',1,TRUE) RETURNING id`, [landlordId])).rows[0].id
    // Both taxed 10% on the item — a reservation's tax is in its quote, so its line is not taxed again.
    const propane = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Propane (20 lb)',$3,20,8,0.1,999,0,999) RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const stayItem = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — nightly',$3,0,0,0.1,999,0,999,'night') RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const sites: string[] = []
    for (const n of ['RV 01', 'RV 02']) {
      sites.push((await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, is_bookable)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',40,TRUE) RETURNING id`, [propertyId, landlordId, n])).rows[0].id)
    }
    await c.query(`INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname) VALUES ($1,$2,'tmr_desk','Desk')`, [landlordId, propertyId])
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, propane, stayItem, sites, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type F = Awaited<ReturnType<typeof seed>>

const auth = (f: F) => ({ Authorization: `Bearer ${f.token}` })
const propaneLine = (f: F, qty = 1) => ({ id: f.propane, name: 'Propane (20 lb)', qty, price: 20, tax: 0.1 })
const sales = async (f: F) => query<any>(`SELECT id, total::float AS total, pay_link_id FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])
const linkRow = async (id: string) => (await query<any>(`SELECT status, last_checkout_session_id FROM pos_pay_links WHERE id = $1`, [id]))[0]
const bookingRow = async (id: string) => (await query<any>(
  `SELECT status, total_amount::float AS total, deposit_paid_at, balance_paid_at, pos_transaction_id FROM unit_bookings WHERE id = $1`, [id]))[0]
const twiceNotices = async (f: F) => query<any>(`SELECT title, body, data, action_url FROM notifications WHERE landlord_id = $1 AND type = 'pay_link_paid_twice'`, [f.landlordId])
const heldRows = async (f: F) => query<any>(`SELECT id, reason, status, amount::float AS amount FROM pos_held_payments WHERE landlord_id = $1 ORDER BY created_at`, [f.landlordId])

async function heldBooking(f: F, unitId: string, total: number) {
  return (await query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, status, total_amount, guest_email, guest_name)
     VALUES ($1,$2,'nightly','2027-05-01','2027-05-08',7,'tentative',$3,'gina@t.dev','Gina Guest') RETURNING id`,
    [unitId, f.landlordId, total]))[0].id
}
/** A reservation ticket the way the schedule hands it to the till: its stay at $0. */
async function reservationTicket(f: F, bookingId: string) {
  return (await query<{ id: string }>(
    `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
     VALUES ($1,$2,$3,$4::jsonb,'Gina Guest · site RV 01',$5) RETURNING id`,
    [f.landlordId, f.propertyId, f.userId, JSON.stringify([{ id: f.stayItem, name: 'RV site — nightly', qty: 7, price: 0, tax: 0 }]), bookingId]))[0].id
}
const sendLink = (f: F, body: any) => request(app()).post('/api/pos/pay-links').set(auth(f))
  .send({ propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Pat Payer', email: 'pat@t.dev' }, ...body })
/** The payer opens the link: a card page is made for it at Stripe. */
async function openPage(link: any): Promise<string> {
  const r = await request(app()).get(`/api/public/pay/${link.token}`)
  expect(r.status, r.text).toBe(303)
  return (await linkRow(link.id)).last_checkout_session_id
}
const settleAtCounter = (f: F, body: any) => request(app()).post('/api/pos/transactions').set(auth(f))
  .send({ paymentMethod: 'cash', propertyId: f.propertyId, ...body })
const paidOnline = (link: any, paymentIntent: string, amount = payLinkCharge(Number(link.total)).charged) => finalizePayLink({
  id: link.last_checkout_session_id ?? 'cs_any', amount_total: Math.round(amount * 100), payment_intent: paymentIntent,
  metadata: { gam_pay_link_id: link.id, gam_landlord_id: link.landlord_id ?? link.landlordId },
  customer_details: { name: 'Pat Payer', email: 'pat@t.dev' },
})
const linkById = async (id: string) => (await query<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [id]))[0]

describe('a reservation ticket is priced by the server wherever a cart is totaled', () => {
  it('the ticket, the quote, the card reader\'s charge and breakdown, and the sale all charge its own quote — untaxed — beside taxed propane', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[0], 280)
    const t = await reservationTicket(f, b)
    const opened = await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const stayLine = opened.body.data.items[0]
    expect(stayLine).toMatchObject({ id: f.stayItem, qty: 1, price: 280, tax: 0, stay: true, reservation: true })
    const cart = [stayLine, propaneLine(f)]

    // The quote: $280 + $20 propane + $2 tax on the propane only (the stay item's 10% is not added to the quote).
    const quote = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ items: cart, paymentMethod: 'cash', propertyId: f.propertyId, openTicketId: t })
    expect(quote.status, JSON.stringify(quote.body)).toBe(200)
    expect(quote.body.data).toMatchObject({ subtotal: 300, taxAmount: 2, total: 302 })
    // The reader's calls name the ticket on the stay line instead — priced the same.
    const onLine = [{ ...stayLine, openTicketId: t }, propaneLine(f)]
    const quote2 = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ items: onLine, paymentMethod: 'cash', propertyId: f.propertyId })
    expect(quote2.body.data).toMatchObject({ subtotal: 300, taxAmount: 2, total: 302 })
    // A register still showing the $0 line is told the real figure; nothing is quoted.
    const stale = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ items: [{ id: f.stayItem, name: 'RV site — nightly', qty: 7, price: 0, tax: 0 }], paymentMethod: 'cash', propertyId: f.propertyId, openTicketId: t })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/comes to \$280\.00 — the cart shows something else, and nothing was charged/)

    // The card reader's charge is minted at that figure plus the card fee.
    const intent = await request(app()).post('/api/pos/terminal/payment-intents').set(auth(f))
      .send({ items: cart, propertyId: f.propertyId, openTicketId: t })
    expect(intent.status, JSON.stringify(intent.body)).toBe(201)
    const amountCents = h.createIntentMock.mock.calls[0][0].amountCents
    expect(amountCents).toBe(Math.round(Number(intent.body.data.total) * 100))
    expect(Number(intent.body.data.total)).toBeGreaterThan(302)        // the card fee on top of $302
    expect(Number(intent.body.data.total)).toBeLessThan(302 * 1.05 + 1)
    h.retrieveIntentMock.mockResolvedValue({ id: 'pi_res_1', status: 'requires_capture', amount: amountCents,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId } })
    // The breakdown on the reader agrees with the charge (no "the cart changed").
    const shown = await request(app()).post('/api/pos/terminal/payment-intents/pi_res_1/process').set(auth(f))
      .send({ stripeReaderId: 'tmr_desk', items: onLine, cartOnReader: true })
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)

    // The sale takes exactly that, and the booking keeps its own price.
    const sale = await settleAtCounter(f, { items: cart, paymentMethod: 'card', stripePaymentIntentId: 'pi_res_1', openTicketId: t })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Math.round(Number(sale.body.data.total) * 100)).toBe(amountCents)
    expect(h.captureMock).toHaveBeenCalledTimes(1)
    expect(await bookingRow(b)).toMatchObject({ status: 'confirmed', total: 280, pos_transaction_id: sale.body.data.id })
    expect((await bookingRow(b)).balance_paid_at).not.toBeNull()
    // 10/4 (decisions #37.B, #38): the $280 toward the stay is itemized on its
    // card, with its share of the card fee the guest paid on top (the propane
    // took the rest of the sale) — an early check-out gives it back to that card.
    const [sp] = await query<any>(
      `SELECT kind, method, toward_stay::float AS toward, card_fee::float AS fee, stripe_payment_intent_id AS pi FROM stay_payments WHERE booking_id = $1`, [b])
    const surcharge = Number(sale.body.data.surcharge)
    expect(sp).toMatchObject({ kind: 'pos_sale', method: 'card', toward: 280, pi: 'pi_res_1' })
    expect(sp.fee).toBeCloseTo(Math.round(surcharge * 280 / (Number(sale.body.data.total) - surcharge) * 100) / 100, 2)
  })
})

describe('a pay link paid online while the counter charges it', () => {
  it('the counter closes the open card page first — one the payer already finished is refused, and nothing is charged here', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const page = await openPage(link)
    h.pages.set(page, 'complete')   // they paid on their phone a moment ago
    const r = await settleAtCounter(f, { items: [propaneLine(f)], payLinkId: link.id })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('That link was just paid online — nothing was charged here. Press Clear.')
    expect(h.expireMock).toHaveBeenCalledWith(f.landlordId, page)
    expect(await sales(f)).toHaveLength(0)
    expect((await linkRow(link.id)).status).toBe('open')   // the payment records itself as it lands
  })

  it('a page still open is closed at Stripe, then charged here; the online payment that lands after records no second sale and tells the landlord once', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const page = await openPage(link)
    const r = await settleAtCounter(f, { items: [propaneLine(f)], payLinkId: link.id })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(h.pages.get(page)).toBe('expired')
    expect((await linkRow(link.id)).status).toBe('paid')

    const row = await linkById(link.id)
    const first = await paidOnline(row, 'pi_late_1')
    expect(first).toMatchObject({ recorded: false, reason: 'already paid' })
    expect(await sales(f)).toHaveLength(1)
    // 10/3 (decisions #13): recorded — held, not a sale, not in payouts — never lost, never refunded on its own.
    expect(await heldRows(f)).toEqual([{ id: first.heldPaymentId, reason: 'paid_twice', status: 'held', amount: payLinkCharge(22).charged }])
    const notices = await twiceNotices(f)
    expect(notices).toHaveLength(1)
    expect(notices[0].title).toMatch(/^Pat Payer paid twice — \$\d+\.\d\d is held for you to refund$/)
    expect(notices[0].body).toMatch(/after it had already been paid \(at the counter, or on another card page\)/)
    expect(notices[0].body).toMatch(/GAM is holding it: it was not recorded as a sale and it is not in your payouts\. Open this notice and press Refund this payment to send it back to their card — do not pay it back from the drawer\./)
    expect(notices[0].data).toMatchObject({ payLinkId: link.id, paymentIntentId: 'pi_late_1', posTransactionId: r.body.data.id, heldPaymentId: first.heldPaymentId })
    expect(notices[0].action_url).toBe(`/pos?tab=paylinks&held=${first.heldPaymentId}`)
    // Stripe delivers the same event again: still one sale, one held payment, one notice.
    expect(await paidOnline(row, 'pi_late_1')).toMatchObject({ recorded: false, reason: 'already held' })
    expect(await sales(f)).toHaveLength(1)
    expect(await heldRows(f)).toHaveLength(1)
    expect(await twiceNotices(f)).toHaveLength(1)
  })

  it('when Stripe cannot be asked about the open page, nothing is charged', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    await openPage(link)
    h.state.stripeDown = true
    const r = await settleAtCounter(f, { items: [propaneLine(f)], payLinkId: link.id })
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('The card page sent with this pay link could not be closed just now — nothing was charged. Wait a moment, then press Charge again.')
    expect(await sales(f)).toHaveLength(0)
    expect((await linkRow(link.id)).status).toBe('open')
  })

  it('changing a link closes its card page first; one the payer already finished is not changed', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const page = await openPage(link)
    h.pages.set(page, 'complete')
    const refused = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth(f)).send({ items: [propaneLine(f, 2)] })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/^That link was just paid online — nothing was changed\./)
    expect(Number((await linkById(link.id)).total)).toBe(22)   // $20 + 10% tax, as sent
    const other = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const otherPage = await openPage(other)
    const changed = await request(app()).patch(`/api/pos/pay-links/${other.id}`).set(auth(f)).send({ items: [propaneLine(f, 2)] })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    expect(h.pages.get(otherPage)).toBe('expired')
    expect(Number((await linkById(other.id)).total)).toBe(44)
  })

  it('closing a link closes its card page first; one the payer already finished is not closed; a QR code is always retired', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const page = await openPage(link)
    h.pages.set(page, 'complete')
    const refused = await request(app()).post(`/api/pos/pay-links/${link.id}/cancel`).set(auth(f))
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/^That link was just paid online — it was not closed\./)
    expect((await linkRow(link.id)).status).toBe('open')

    const other = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const otherPage = await openPage(other)
    const closed = await request(app()).post(`/api/pos/pay-links/${other.id}/cancel`).set(auth(f))
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect(h.pages.get(otherPage)).toBe('expired')
    expect((await linkRow(other.id)).status).toBe('cancelled')

    // A standing QR code: each finished page is its own payment, never a reason to keep it up.
    const qr = (await request(app()).post('/api/pos/pay-links').set(auth(f))
      .send({ propertyId: f.propertyId, kind: 'standing', label: 'Dump station', items: [{ id: null, name: 'Dump station', qty: 1, price: 15 }] })).body.data
    const qrPage = await openPage(qr)
    h.pages.set(qrPage, 'complete')
    const retired = await request(app()).post(`/api/pos/pay-links/${qr.id}/cancel`).set(auth(f))
    expect(retired.status, JSON.stringify(retired.body)).toBe(200)
    expect((await linkRow(qr.id)).status).toBe('cancelled')
  })
})

describe('a reservation link (decisions #9)', () => {
  const stayBody = (f: F, extra: any = {}) => ({
    items: [{ id: f.stayItem, name: 'RV site — nightly', qty: 2, price: 40 }],
    stay: { unitId: f.sites[0], checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev' },
    ...extra,
  })
  const discountWords = (press: string) =>
    `A reservation is charged at its own price — take the discount off, then press ${press} again. To change what it costs, change the reservation on the schedule.`

  it('takes no discount — sending, adjusting or settling it', async () => {
    const f = await seed()
    const off = await sendLink(f, stayBody(f, { discountAmount: 5 }))
    expect(off.status).toBe(400)
    expect(off.body.error).toBe(discountWords('Send link'))
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(0)
    const link = (await sendLink(f, stayBody(f))).body.data
    expect(link.bookingId).toBeTruthy()
    const adjust = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth(f))
      .send({ items: link.items, discountAmount: 5 })
    expect(adjust.status).toBe(400)
    expect(adjust.body.error).toBe(discountWords('Save changes'))
    const settle = await settleAtCounter(f, { items: link.items, payLinkId: link.id, discountAmount: 5 })
    expect(settle.status).toBe(400)
    expect(settle.body.error).toBe(discountWords('Charge'))
    expect(await sales(f)).toHaveLength(0)
    // A reservation ticket is the same: charged whole.
    const b = await heldBooking(f, f.sites[1], 280)
    const t = await reservationTicket(f, b)
    const line = (await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))).body.data.items[0]
    const ticketOff = await settleAtCounter(f, { items: [line], openTicketId: t, discountAmount: 5 })
    expect(ticketOff.status).toBe(400)
    expect(ticketOff.body.error).toBe(discountWords('Charge'))
  })

  it('paid in full at the counter, every other link on the reservation closes — its card page shut — and a link for it is refused from then on', async () => {
    const f = await seed()
    const link = (await sendLink(f, stayBody(f))).body.data
    const bookingId = link.bookingId
    // The office also emailed an amount toward the same reservation; the guest opened it.
    const extra = (await sendLink(f, { bookingId, items: [{ id: null, name: 'Extra toward the stay', qty: 1, price: 30, tax: 0 }] })).body.data
    const extraPage = await openPage(extra)
    const r = await settleAtCounter(f, { items: link.items, payLinkId: link.id })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(h.expireMock).toHaveBeenCalledWith(f.landlordId, extraPage)   // closed BEFORE the money moved
    expect(h.pages.get(extraPage)).toBe('expired')
    expect((await linkRow(extra.id)).status).toBe('cancelled')
    const paid = await bookingRow(bookingId)
    expect(paid.status).toBe('confirmed')
    expect(paid.balance_paid_at).not.toBeNull()

    // The closed one, opened by the guest: closed, nothing charged.
    expect((await request(app()).get(`/api/public/pay/${extra.token}`)).status).toBe(410)
    // A link for it that is somehow still open: refused at the counter, "already paid" online.
    await query(`UPDATE pos_pay_links SET status = 'open' WHERE id = $1`, [extra.id])
    const again = await settleAtCounter(f, { items: extra.items, payLinkId: extra.id })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('That reservation is already paid — nothing was charged. Press Clear.')
    const pageNow = await request(app()).get(`/api/public/pay/${extra.token}`)
    expect(pageNow.status).toBe(200)
    expect(pageNow.text).toMatch(/This reservation is already paid/)
    expect(pageNow.text).toMatch(/nothing was charged/)
    // Paid online all the same: no second sale — held for the landlord to refund; the landlord is told.
    expect(await paidOnline(await linkById(extra.id), 'pi_extra_late')).toMatchObject({ recorded: false, reason: 'already paid' })
    expect(await sales(f)).toHaveLength(1)
    expect((await heldRows(f)).map((r: any) => r.reason)).toEqual(['paid_twice'])
    const notices = await twiceNotices(f)
    expect(notices).toHaveLength(1)
    expect(notices[0].body).toMatch(/after the reservation it was for had already been paid in full/)
    // Nothing more is sent for it.
    const late = await sendLink(f, { bookingId, items: [{ id: null, name: 'Another amount', qty: 1, price: 10, tax: 0 }] })
    expect(late.status).toBe(409)
    expect(late.body.error).toBe('That reservation is already paid — nothing was sent. Press Cancel.')
  })

  it('a counter payment in full is refused when another link on the reservation was just paid online', async () => {
    const f = await seed()
    const link = (await sendLink(f, stayBody(f))).body.data
    const extra = (await sendLink(f, { bookingId: link.bookingId, items: [{ id: null, name: 'Extra toward the stay', qty: 1, price: 30, tax: 0 }] })).body.data
    const extraPage = await openPage(extra)
    h.pages.set(extraPage, 'complete')
    const r = await settleAtCounter(f, { items: link.items, payLinkId: link.id })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('That reservation was just paid online — nothing was charged here. Press Clear, then open it again to see what is still owed.')
    expect(await sales(f)).toHaveLength(0)
    expect((await linkRow(link.id)).status).toBe('open')
  })

  it('paid in full online, a stay link closes the other links on its reservation and voids its open ticket', async () => {
    const f = await seed()
    const link = (await sendLink(f, stayBody(f))).body.data
    const extra = (await sendLink(f, { bookingId: link.bookingId, items: [{ id: null, name: 'Extra toward the stay', qty: 1, price: 30, tax: 0 }] })).body.data
    const extraPage = await openPage(extra)
    const ticket = await reservationTicket(f, link.bookingId)
    const row = await linkById(link.id)
    expect(await paidOnline(row, 'pi_stay_online')).toEqual({ recorded: true })
    expect(await sales(f)).toHaveLength(1)
    expect((await linkRow(link.id)).status).toBe('paid')
    expect((await linkRow(extra.id)).status).toBe('cancelled')
    expect(h.pages.get(extraPage)).toBe('expired')
    const [t] = await query<any>(`SELECT status, void_reason FROM pos_open_tickets WHERE id = $1`, [ticket])
    expect(t).toMatchObject({ status: 'voided', void_reason: 'The reservation was paid in full' })
    expect((await bookingRow(link.bookingId)).balance_paid_at).not.toBeNull()
  })

  it('a deposit paid toward it leaves the rest owed — and the other links open', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[1], 280)
    const typed = (await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Deposit', qty: 1, price: 50, tax: 0 }] })).body.data
    const rest = (await sendLink(f, { bookingId: b, items: [{ id: null, name: 'The rest', qty: 1, price: 230, tax: 0 }] })).body.data
    expect(await paidOnline(await linkById(typed.id), 'pi_deposit')).toEqual({ recorded: true })
    // What it paid is recorded on the reservation, so what is still owed is right.
    const [bk] = await query<any>(`SELECT deposit_amount::float AS deposit, deposit_paid_at, balance_paid_at FROM unit_bookings WHERE id = $1`, [b])
    expect(bk.deposit).toBe(50)
    expect(bk.balance_paid_at).toBeNull()
    // 10/4 (decisions #37.B, #38): paid online by card — itemized toward the stay.
    expect(await query<any>(`SELECT kind, method, toward_stay::text, stripe_payment_intent_id FROM stay_payments WHERE booking_id = $1`, [b]))
      .toEqual([{ kind: 'pos_sale', method: 'card', toward_stay: '50.00', stripe_payment_intent_id: 'pi_deposit' }])
    expect((await linkRow(rest.id)).status).toBe('open')
    const t = await reservationTicket(f, b)
    const line = (await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))).body.data.items[0]
    expect(line).toMatchObject({ price: 230 })
    expect(line.name).toMatch(/balance after \$50\.00 paid$/)
    // The rest, paid at the till, closes the link sent for it.
    const ok = await settleAtCounter(f, { items: [line], openTicketId: t })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect((await linkRow(rest.id)).status).toBe('cancelled')
  })
})

// ── 10/2 (review, second pass) ─────────────────────────────────────────────
//
// ONE CARD PAGE AT A TIME. Every load of a link opened a new Stripe page and
// forgot the one before; the desk, settling, changing or closing the link,
// closed only the last page id it had read when it started. Probes: (P1) the
// payer opened the link twice and the desk settled it — the first page could
// still be paid; (P2) the payer opened it while the desk sale went through —
// the new page stayed open behind a paid link; (P3) a page at the old amount,
// paid after Adjust, was recorded as nothing and nobody was told.

const onlyOpenPages = () => [...h.pages.entries()].filter(([, s]) => s === 'open').map(([id]) => id)
const noticesOf = async (f: F, type: string) => query<any>(`SELECT title, body, data FROM notifications WHERE landlord_id = $1 AND type = $2`, [f.landlordId, type])

describe('10/2 (review) one card page at a time', () => {
  it('opening the link again closes the page it opened before; settled at the desk, no page is left open; each page closes itself in 32 minutes', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const a = await openPage(link)
    const b = await openPage(link)   // a second tab, or back from Stripe's cancel button
    expect(b).not.toBe(a)
    expect(h.pages.get(a)).toBe('expired')
    expect(onlyOpenPages()).toEqual([b])
    for (const [args] of h.checkoutMock.mock.calls) {
      const minutes = (args.expires_at - Date.now() / 1000) / 60
      expect(minutes).toBeGreaterThan(31)
      expect(minutes).toBeLessThanOrEqual(32)
    }
    const r = await settleAtCounter(f, { items: [propaneLine(f)], payLinkId: link.id })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(onlyOpenPages()).toEqual([])
    // Opened after it was settled: paid, and no page is made.
    const after = await request(app()).get(`/api/public/pay/${link.token}`)
    expect(after.status).toBe(200)
    expect(after.text).toMatch(/Already paid — thank you/)
    expect(h.checkoutMock).toHaveBeenCalledTimes(2)
  })

  it('a page the payer already paid on is not followed by a new one; when Stripe cannot be asked, no new page opens', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const a = await openPage(link)
    h.pages.set(a, 'complete')
    const paid = await request(app()).get(`/api/public/pay/${link.token}`)
    expect(paid.status).toBe(200)
    expect(paid.text).toMatch(/Already paid — thank you/)
    expect(h.checkoutMock).toHaveBeenCalledTimes(1)
    expect((await linkRow(link.id)).last_checkout_session_id).toBe(a)

    const other = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    await openPage(other)
    h.state.stripeDown = true
    const down = await request(app()).get(`/api/public/pay/${other.token}`)
    expect(down.status).toBe(503)
    expect(down.text).toMatch(/Nothing was charged\. Please open the link again in a minute\./)
    expect(h.checkoutMock).toHaveBeenCalledTimes(2)
  })

  it('the payer opens the link while the desk sale goes through: nothing is charged; pressed again, it goes through and closes that page too', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    await openPage(link)
    let during = ''
    h.state.onExpire = async () => { during = await openPage(link) }   // while the desk closes the old page
    const r = await settleAtCounter(f, { items: [propaneLine(f)], payLinkId: link.id })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('The payer opened this link on their phone just now — nothing was charged here. Press Charge again.')
    expect(await sales(f)).toHaveLength(0)
    expect(await linkRow(link.id)).toEqual({ status: 'open', last_checkout_session_id: during })
    const again = await settleAtCounter(f, { items: [propaneLine(f)], payLinkId: link.id })
    expect(again.status, JSON.stringify(again.body)).toBe(201)
    expect(h.pages.get(during)).toBe('expired')
    expect(onlyOpenPages()).toEqual([])
  })

  it('a link changed (Adjust) or closed while the payer opens it again is refused, then goes through when pressed again', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    await openPage(link)
    let during = ''
    h.state.onExpire = async () => { during = await openPage(link) }
    const adjust = () => request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth(f)).send({ items: [propaneLine(f, 2)] })
    const refused = await adjust()
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('The payer opened this link on their phone just now — nothing was changed here. Press Save changes again.')
    expect(Number((await linkById(link.id)).total)).toBe(22)
    expect((await adjust()).status).toBe(200)
    expect(h.pages.get(during)).toBe('expired')
    expect(Number((await linkById(link.id)).total)).toBe(44)

    const next = await openPage(link)
    h.state.onExpire = async () => { during = await openPage(link) }
    const close = () => request(app()).post(`/api/pos/pay-links/${link.id}/cancel`).set(auth(f))
    const notClosed = await close()
    expect(notClosed.status).toBe(409)
    expect(notClosed.body.error).toBe('The payer opened this link on their phone just now — it is still open. Press Close again.')
    expect((await linkRow(link.id)).status).toBe('open')
    expect(h.pages.get(next)).toBe('expired')
    expect((await close()).status).toBe(200)
    expect((await linkRow(link.id)).status).toBe('cancelled')
    expect(onlyOpenPages()).toEqual([])
    // Opened once it is closed: no page is made.
    const n = h.checkoutMock.mock.calls.length
    expect((await request(app()).get(`/api/public/pay/${link.token}`)).status).toBe(410)
    expect(h.checkoutMock).toHaveBeenCalledTimes(n)
  })

  it('a standing QR code is never closed for the next scanner — every scanner has their own page', async () => {
    const f = await seed()
    const qr = (await request(app()).post('/api/pos/pay-links').set(auth(f))
      .send({ propertyId: f.propertyId, kind: 'standing', label: 'Dump station', items: [{ id: null, name: 'Dump station', qty: 1, price: 15 }] })).body.data
    const first = await openPage(qr)
    h.pages.set(first, 'complete')   // the first scanner paid
    const second = await openPage(qr)
    const third = await openPage(qr)
    expect(h.pages.get(first)).toBe('complete')
    expect(onlyOpenPages().sort()).toEqual([second, third].sort())
  })

  it('another link on the reservation opened while the desk pays it in full: nothing is charged; pressed again, it goes through', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[0], 280)
    const t = await reservationTicket(f, b)
    const extra = (await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Deposit', qty: 1, price: 50, tax: 0 }] })).body.data
    await openPage(extra)
    const line = (await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))).body.data.items[0]
    let during = ''
    h.state.onExpire = async () => { during = await openPage(extra) }
    const r = await settleAtCounter(f, { items: [line], openTicketId: t })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('A pay link for this reservation was opened on the guest\'s phone just now — nothing was charged here. Press Charge again.')
    expect(await sales(f)).toHaveLength(0)
    expect((await bookingRow(b)).balance_paid_at).toBeNull()
    expect((await query<any>(`SELECT status FROM pos_open_tickets WHERE id = $1`, [t]))[0].status).toBe('open')
    const again = await settleAtCounter(f, { items: [line], openTicketId: t })
    expect(again.status, JSON.stringify(again.body)).toBe(201)
    expect(h.pages.get(during)).toBe('expired')
    expect((await linkRow(extra.id)).status).toBe('cancelled')
    expect(onlyOpenPages()).toEqual([])
  })
})

describe('10/2 (review) money that lands where it was not expected is never silent', () => {
  it('a page paid at the old amount after Adjust is not a sale — the landlord is told once, with the refund step and what the link asks now', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    await openPage(link)
    const old = await linkById(link.id)
    expect((await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth(f)).send({ items: [propaneLine(f, 2)] })).status).toBe(200)
    const oldCharge = payLinkCharge(22).charged
    const r = await paidOnline(old, 'pi_old_amount', oldCharge)
    expect(r).toMatchObject({ recorded: false, reason: 'amount mismatch' })
    expect(await sales(f)).toHaveLength(0)
    expect(await heldRows(f)).toEqual([{ id: r.heldPaymentId, reason: 'wrong_amount', status: 'held', amount: oldCharge }])
    const told = await noticesOf(f, 'pay_link_amount_mismatch')
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe(`Pat Payer paid $${oldCharge.toFixed(2)} on an old version of a pay link — it is held for you to refund`)
    expect(told[0].body).toMatch(new RegExp(`had been changed to \\$${payLinkCharge(44).charged.toFixed(2).replace('.', '\\.')} after they opened it`))
    expect(told[0].body).toMatch(/GAM is holding it: it was not recorded as a sale and it is not in your payouts\. Open this notice and press Refund this payment/)
    expect(told[0].body).toMatch(/The link is still open for \$\d+\.\d\d — once the refund is under way, press Send again on it under Pay Links, or settle it at the counter\./)
    expect(told[0].data).toMatchObject({ payLinkId: link.id, paymentIntentId: 'pi_old_amount', paid: oldCharge, heldPaymentId: r.heldPaymentId })
    // Delivered again by Stripe: still nothing recorded as a sale, one held payment, one notice.
    expect(await paidOnline(old, 'pi_old_amount', oldCharge)).toMatchObject({ recorded: false, reason: 'already held' })
    expect(await heldRows(f)).toHaveLength(1)
    expect(await noticesOf(f, 'pay_link_amount_mismatch')).toHaveLength(1)
  })

  it('an emailed link the office closed, paid anyway on a page still open: recorded, and the landlord is told once to check it was not paid twice', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    await openPage(link)
    expect((await request(app()).post(`/api/pos/pay-links/${link.id}/cancel`).set(auth(f))).status).toBe(200)
    const row = await linkById(link.id)
    expect(await paidOnline(row, 'pi_after_close')).toEqual({ recorded: true })
    const [sale] = await sales(f)
    const told = await noticesOf(f, 'pay_link_paid_after_close')
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe('Pat Payer paid a pay link that had been closed — check it was not paid twice')
    expect(told[0].body).toMatch(/after it had been closed\. The payment is recorded as a register sale and is in your payouts\. If they also paid for this another way .* refund one of the two sales under Point of Sale → History\./)
    expect(told[0].data).toMatchObject({ payLinkId: link.id, paymentIntentId: 'pi_after_close', posTransactionId: sale.id })
    expect(await paidOnline(row, 'pi_after_close')).toEqual({ recorded: false, reason: 'already recorded' })
    expect(await noticesOf(f, 'pay_link_paid_after_close')).toHaveLength(1)
  })
})

describe('10/2 (review) what is paid toward a reservation adds up', () => {
  it('a deposit link then the rest at the counter: the reservation is paid in full, the ticket is gone, and arrival day bills nothing again', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[1], 280)
    const deposit = (await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Deposit', qty: 1, price: 50, tax: 0 }] })).body.data
    const rest = (await sendLink(f, { bookingId: b, items: [{ id: null, name: 'The rest', qty: 1, price: 230, tax: 0 }] })).body.data
    const t = await reservationTicket(f, b)
    expect(await paidOnline(await linkById(deposit.id), 'pi_dep_50')).toEqual({ recorded: true })
    const r = await settleAtCounter(f, { items: rest.items, payLinkId: rest.id })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const [bk] = await query<any>(
      `SELECT deposit_amount::float AS paid, deposit_paid_at, balance_billed_at, balance_paid_at, status FROM unit_bookings WHERE id = $1`, [b])
    expect(bk).toMatchObject({ paid: 280, status: 'confirmed' })
    expect(bk.balance_billed_at).not.toBeNull()
    expect(bk.balance_paid_at).not.toBeNull()
    // Nothing left for the till: its ticket was voided with the reservation paid in full.
    expect((await query<any>(`SELECT status, void_reason FROM pos_open_tickets WHERE id = $1`, [t]))[0])
      .toEqual({ status: 'voided', void_reason: 'The reservation was paid in full' })
    // Arrival day bills nothing (it used to bill the $230 again).
    const { billStayBalances } = await import('../services/stayBalance')
    h.emailPayLinkMock.mockClear()
    expect((await billStayBalances(new Date('2027-05-01T19:00:00Z'))).billed).toBe(0)
    expect(h.emailPayLinkMock).not.toHaveBeenCalled()
  })

  // 10/3 (review): a link never charges more than is left on its reservation —
  // sent, it is refused; at the counter and on its page it charges what is
  // left (decisions #9: the reservation's own price less what was paid). A
  // register still showing the old figure is told the real one; nothing moves.
  it('a link never charges more than is left — refused when sent; at the counter and on its page it charges what is left', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[1], 280)
    const deposit = (await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Deposit', qty: 1, price: 50, tax: 0 }] })).body.data
    const whole = (await sendLink(f, { bookingId: b, items: [{ id: null, name: 'The stay', qty: 1, price: 280, tax: 0 }] })).body.data
    expect(await paidOnline(await linkById(deposit.id), 'pi_dep_first')).toEqual({ recorded: true })
    const sent = await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Too much', qty: 1, price: 250, tax: 0 }] })
    expect(sent.status).toBe(400)
    expect(sent.body.error).toBe('That reservation has $230.00 left to pay — a link for it can ask for that much at most. Change the amount, then press Send link again. To change what the reservation costs, use the schedule.')
    // A register still showing the link as sent: told the real figure, nothing charged.
    const atDesk = await settleAtCounter(f, { items: whole.items, payLinkId: whole.id })
    expect(atDesk.status).toBe(409)
    expect(atDesk.body.error).toBe('This link\'s reservation — 7 nights at site RV 02 (May 1 → May 8) — comes to $230.00 now ($50.00 was already paid toward it) — '
      + 'the cart shows something else, and nothing was charged. Press Clear, open the link again from the list, then press Charge.')
    expect(atDesk.body.error).not.toMatch(/close this link|part was paid another way/)
    // Its page charges what is left.
    expect((await request(app()).get(`/api/public/pay/${whole.token}`)).status).toBe(303)
    const pageLines = h.checkoutMock.mock.calls.at(-1)![0].line_items
    expect(pageLines[0].price_data.unit_amount).toBe(23000)
    expect(Number((await linkById(whole.id)).total)).toBe(230)
    // Opened at the counter: the reservation's line at what is left; it settles.
    const opened = await request(app()).get(`/api/pos/tickets/${whole.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body.data.items).toEqual([expect.objectContaining({ id: null, price: 230, qty: 1, reservation: true, name: 'The stay — what is left on the reservation' })])
    const ok = await settleAtCounter(f, { items: opened.body.data.items.map((i: any) => ({ ...i, payLinkId: whole.id })), payLinkId: whole.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(230)
    const [bk] = await query<any>(`SELECT deposit_amount::float AS paid, balance_paid_at FROM unit_bookings WHERE id = $1`, [b])
    expect(bk.paid).toBe(280)
    expect(bk.balance_paid_at).not.toBeNull()
    expect(await sales(f)).toHaveLength(2)
  })
})

describe('10/2 (review) a quote is for the register\'s own property', () => {
  async function cashierAt(f: F, propertyIds: string[]): Promise<string> {
    const u = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    const perms = { 'pos.ring_sale': true }
    await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u[0].id, f.landlordId, propertyIds, JSON.stringify(perms)])
    return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }

  it('another property\'s reservation is never read out through /cart-quote — a property is required, and it must be one the cashier works', async () => {
    const f = await seed()
    const c = await db.connect()
    let other = ''
    try { other = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId }) } finally { c.release() }
    const b = await heldBooking(f, f.sites[0], 280)
    const t = await reservationTicket(f, b)   // at f.propertyId
    const cashier = await cashierAt(f, [other])
    const cart = [{ id: f.stayItem, name: 'RV site — nightly', qty: 7, price: 0, tax: 0 }]
    const quote = (body: any) => request(app()).post('/api/pos/cart-quote').set('Authorization', `Bearer ${cashier}`)
      .send({ items: cart, paymentMethod: 'cash', openTicketId: t, ...body })
    const none = await quote({})
    expect(none.status).toBe(400)
    expect(none.body.error).toBe('A property must be selected — pick it at the top of the register; sales are per-property.')
    const notTheirs = await quote({ propertyId: f.propertyId })
    expect(notTheirs.status).toBe(403)
    const theirs = await quote({ propertyId: other })
    expect(theirs.status).toBe(400)
    expect(theirs.body.error).toBe('That ticket is for another property — nothing was charged. Switch the register to that property, then press Charge again.')
    for (const r of [none, notTheirs, theirs]) expect(JSON.stringify(r.body)).not.toMatch(/RV 01|280|May 1/)
  })
})

describe('10/2 (review) a reservation ticket with nothing left to take is voided, never left open and hidden', () => {
  // 10/3 (review): one that carries anything besides the stay (propane held
  // on it) gives up only the stay — the propane is still owed, open, voidable.
  it('cancelled on the schedule, marked a no-show, or paid elsewhere: the stay comes off the moment the register looks — voided when it was all, kept open for the rest', async () => {
    const f = await seed()
    const cancelled = await heldBooking(f, f.sites[0], 280)
    const noShow = await heldBooking(f, f.sites[1], 280)
    const tCancelled = await reservationTicket(f, cancelled)
    const tNoShow = await reservationTicket(f, noShow)
    // The clerk had added propane and pressed Clear: the ticket holds lines.
    await query(`UPDATE pos_open_tickets SET items = items || $2::jsonb WHERE id = $1`, [tCancelled, JSON.stringify([propaneLine(f)])])
    await query(`UPDATE unit_bookings SET status = 'cancelled' WHERE id = $1`, [cancelled])
    await query(`UPDATE unit_bookings SET status = 'no_show' WHERE id = $1`, [noShow])

    const opened = await request(app()).get(`/api/pos/tickets/${tNoShow}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))
    expect(opened.status).toBe(409)
    expect(opened.body.error).toBe('That reservation was marked a no-show — there is nothing to charge on this ticket, so it was taken off the list. Look it up on the schedule.')
    const list = await request(app()).get(`/api/pos/tickets?propertyId=${f.propertyId}`).set(auth(f))
    expect(list.status).toBe(200)
    const listed = list.body.data.find((x: any) => x.id === tCancelled)
    expect(listed.items).toEqual([propaneLine(f)])
    expect(listed.note).toMatch(/The reservation was canceled — its stay was taken off this ticket; the rest is still owed$/)
    expect(list.body.data.map((x: any) => x.id)).not.toContain(tNoShow)
    const rows = await query<any>(`SELECT id, status, void_reason FROM pos_open_tickets ORDER BY status, id`)
    expect(rows).toEqual(expect.arrayContaining([
      { id: tCancelled, status: 'open', void_reason: null },
      { id: tNoShow, status: 'voided', void_reason: 'The reservation was marked a no-show' },
    ]))
    // Opened: an ordinary ticket with the propane on it; charged as one.
    const again = await request(app()).get(`/api/pos/tickets/${tCancelled}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data.items).toEqual([propaneLine(f)])
    const sale = await settleAtCounter(f, { items: again.body.data.items, openTicketId: tCancelled })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBe(22)
    expect((await bookingRow(cancelled)).status).toBe('cancelled')
    // A reservation paid in full some other way: same — the stay comes off, the propane stays.
    const paidElsewhere = await heldBooking(f, f.sites[0], 280)
    const tPaid = await reservationTicket(f, paidElsewhere)
    await query(`UPDATE pos_open_tickets SET items = items || $2::jsonb WHERE id = $1`, [tPaid, JSON.stringify([propaneLine(f, 2)])])
    await query(`UPDATE unit_bookings SET status = 'confirmed', deposit_paid_at = NOW(), balance_paid_at = NOW() WHERE id = $1`, [paidElsewhere])
    const openedPaid = await request(app()).get(`/api/pos/tickets/${tPaid}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))
    expect(openedPaid.status).toBe(200)
    expect(openedPaid.body.data.items).toEqual([propaneLine(f, 2)])
    expect(openedPaid.body.data.notice).toBe('The reservation was paid in full — its stay was taken off this ticket. The rest is still owed; charge it, or press Void.')
  })
})

// ── 10/3 (review, third pass) ──────────────────────────────────────────────

/** A pay link written straight onto a reservation, the way the schedule's deposit link or the arrival-day balance link is. */
async function typedLink(f: F, bookingId: string, name: string, amount: number, opts: { balance?: boolean } = {}) {
  const row = (await query<any>(
    `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, tax_amount, discount_amount, total,
                                customer_name, customer_email, booking_id, card_fee_on_top)
     VALUES (md5(random()::text) || substr(md5(random()::text), 1, 16), $1, $2, $3, 'one_time', $4, $5::jsonb, $6, 0, 0, $6,
             'Gina Guest', 'gina@t.dev', $7, TRUE) RETURNING *`,
    [f.landlordId, f.propertyId, f.userId, name, JSON.stringify([{ id: null, name, qty: 1, price: amount, tax: 0 }]), amount, bookingId]))[0]
  if (opts.balance) await query(`UPDATE unit_bookings SET balance_pay_link_id = $2, balance_billed_at = NOW() WHERE id = $1`, [bookingId, row.id])
  return row
}

describe('10/3 (review) a payment toward a reservation is checked against what it still owes as it lands', () => {
  it('two links, both paid online: the second one asks more than is left — held whole for the landlord to refund, the overage told once; its old page was closed when the first landed', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[1], 280)
    const big = await typedLink(f, b, 'Toward the stay', 200)
    const small = await typedLink(f, b, 'More toward the stay', 100)
    const smallPage = await openPage(small)                       // the payer opens the $100 link first
    expect(await paidOnline(await linkById(big.id), 'pi_big')).toEqual({ recorded: true })
    // $80 is left: the $100 link's open page now asks too much, so it was closed.
    expect(h.pages.get(smallPage)).toBe('expired')
    expect((await linkRow(small.id)).status).toBe('open')
    // Paid on that old page anyway (it was mid-payment): held, not a sale; the reservation is not overpaid.
    const late = await paidOnline(await linkById(small.id), 'pi_small_late')
    expect(late).toMatchObject({ recorded: false, reason: 'more than owed' })
    expect(await sales(f)).toHaveLength(1)
    expect((await query<any>(`SELECT deposit_amount::float AS paid, balance_paid_at FROM unit_bookings WHERE id = $1`, [b]))[0])
      .toEqual({ paid: 200, balance_paid_at: null })
    expect(await heldRows(f)).toEqual([{ id: late.heldPaymentId, reason: 'over_owed', status: 'held', amount: payLinkCharge(100).charged }])
    const told = await noticesOf(f, 'pay_link_over_owed')
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe(`Pat Payer paid $20.00 more than their reservation owed — $${payLinkCharge(100).charged.toFixed(2)} is held for you to refund`)
    expect(told[0].body).toMatch(/but only \$80\.00 was left to pay on it when the payment landed — \$20\.00 more than was owed \(another payment toward it came in first\)\. GAM is holding it/)
    // 10/3 (review): the link was not paid (the money is held), so it still asks — now what is left. The step is one that works.
    expect(told[0].body).toMatch(/This link is still open and now asks the \$80\.00 still owed\. Once the refund is under way, press Send again on it under Pay Links, or take it at the counter\.$/)
    expect(told[0].body).not.toMatch(/send a new link/)
    // Opened again, the $100 link charges what is left: $80.
    h.checkoutMock.mockClear()
    expect((await request(app()).get(`/api/public/pay/${small.token}`)).status).toBe(303)
    expect(h.checkoutMock.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(8000)
  })

  it('the arrival-day balance link is the rest only while nothing else was paid: at the counter it charges what is left, never its old figure', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[1], 280)
    await query(`UPDATE unit_bookings SET status = 'confirmed', deposit_amount = 50, deposit_paid_at = NOW() WHERE id = $1`, [b])
    const balance = await typedLink(f, b, 'Stay balance', 230, { balance: true })
    const extra = await typedLink(f, b, 'Toward the stay', 100)
    expect(await paidOnline(await linkById(extra.id), 'pi_extra_100')).toEqual({ recorded: true })
    // A register showing the balance link as it was sent ($230): told the real figure, nothing charged.
    const stale = await settleAtCounter(f, { items: balance.items, payLinkId: balance.id })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/comes to \$130\.00 now \(\$150\.00 was already paid toward it\)/)
    expect(await sales(f)).toHaveLength(1)
    const opened = await request(app()).get(`/api/pos/tickets/${balance.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.body.data.items).toEqual([expect.objectContaining({ price: 130, reservation: true })])
    const ok = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: balance.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(130)
    const [bk] = await query<any>(`SELECT deposit_amount::float AS paid, balance_paid_at FROM unit_bookings WHERE id = $1`, [b])
    expect(bk.balance_paid_at).not.toBeNull()
    expect(await heldRows(f)).toHaveLength(0)
  })

  it('a link that is refused on its page also closes the page it last opened', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[1], 280)
    const link = await typedLink(f, b, 'Toward the stay', 100)
    const page = await openPage(link)
    await query(`UPDATE unit_bookings SET status = 'cancelled' WHERE id = $1`, [b])
    const r = await request(app()).get(`/api/public/pay/${link.token}`)
    expect(r.status).toBe(410)
    expect(h.pages.get(page)).toBe('expired')
  })
})

describe('10/3 (decisions #9) a stay link is charged the reservation\'s own price — repriced on the schedule, the link follows', () => {
  const stayBody = (f: F) => ({
    items: [{ id: f.stayItem, name: 'RV site — nightly', qty: 2, price: 40 }],
    stay: { unitId: f.sites[0], checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev' },
  })

  it('the reservation repriced lower: the counter opens it at the new price and settles it; the page charges it too — nobody is told to close a link that holds a site', async () => {
    const f = await seed()
    await query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [f.propertyId])
    const link = (await sendLink(f, stayBody(f))).body.data
    // Sent: 2 nights × $40 + the property's 10% lodging tax = $88 (the schedule's
    // pricing, decisions #21) — the reservation's own price from the start.
    expect((await bookingRow(link.bookingId)).total).toBe(88)
    await query(`UPDATE unit_bookings SET total_amount = 60 WHERE id = $1`, [link.bookingId])
    const stale = await settleAtCounter(f, { items: link.items, payLinkId: link.id })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('This link\'s reservation — 2 nights at site RV 01 (Jun 1 → Jun 3) — comes to $60.00 now — the cart shows something else, and nothing was charged. '
      + 'Press Clear, open the link again from the list, then press Charge.')
    // The page opens at $60.
    expect((await request(app()).get(`/api/public/pay/${link.token}`)).status).toBe(303)
    expect(h.checkoutMock.mock.calls.at(-1)![0].line_items[0].price_data.unit_amount).toBe(6000)
    const opened = await request(app()).get(`/api/pos/tickets/${link.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.body.data.items).toEqual([expect.objectContaining({ id: f.stayItem, price: 60, qty: 1, reservation: true, nights: 2 })])
    const ok = await settleAtCounter(f, { items: opened.body.data.items.map((i: any) => ({ ...i, payLinkId: link.id })), payLinkId: link.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(60)
    expect(await bookingRow(link.bookingId)).toMatchObject({ status: 'confirmed', total: 60 })
  })

  it('a moved hold keeps its link (decisions #12): the page still opens, and the counter still settles it, for the new site', async () => {
    const f = await seed()
    await query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [f.propertyId])
    const link = (await sendLink(f, stayBody(f))).body.data
    const { clearUnpaidHolds } = await import('../services/holdDisplacement')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const out = await clearUnpaidHolds(c, f.sites[0], '2027-06-01', '2027-06-03')
      expect(out[0]).toMatchObject({ outcome: 'moved', toUnitNumber: 'RV 02', linkKept: true })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    expect((await linkRow(link.id)).status).toBe('open')
    expect((await request(app()).get(`/api/public/pay/${link.token}`)).status).toBe(303)
    const opened = await request(app()).get(`/api/pos/tickets/${link.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.body.data.items[0].name).toMatch(/at site RV 02/)
    const ok = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: link.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(88)
  })
})

describe('10/3 (review) the counter settles one thing at a time, and never a reservation that is over', () => {
  it('a sale naming both a ticket and a pay link is refused before anything moves', async () => {
    const f = await seed()
    const b1 = await heldBooking(f, f.sites[0], 80)
    const b2 = await heldBooking(f, f.sites[1], 80)
    const link = await typedLink(f, b1, 'Toward the stay', 80)
    const t = await reservationTicket(f, b2)
    const line = (await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))).body.data.items[0]
    const r = await settleAtCounter(f, { items: [line, ...link.items], openTicketId: t, payLinkId: link.id })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('A sale settles one ticket or one pay link — press Clear, then open just one.')
    expect(await sales(f)).toHaveLength(0)
    expect((await bookingRow(b1)).deposit_paid_at).toBeNull()
    expect((await bookingRow(b2)).deposit_paid_at).toBeNull()
    // The quote says the same.
    const q = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ items: [{ ...line, openTicketId: t }, { ...link.items[0], payLinkId: link.id, reservation: true }], paymentMethod: 'cash', propertyId: f.propertyId })
    expect(q.status).toBe(400)
  })

  it('a link whose reservation was marked a no-show is refused at the counter, as on its page; one cancelled on the schedule is never said to have lost its site', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[0], 80)
    const link = await typedLink(f, b, 'Toward the stay', 80)
    await query(`UPDATE unit_bookings SET status = 'no_show' WHERE id = $1`, [b])
    const r = await settleAtCounter(f, { items: link.items, payLinkId: link.id })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('The reservation on this pay link was marked a no-show — nothing was charged. Press Clear, then close the link under Pay Links; if they still want to stay, ring the stay fresh with a site and dates.')
    expect((await request(app()).get(`/api/public/pay/${link.token}`)).status).toBe(410)
    await query(`UPDATE unit_bookings SET status = 'cancelled' WHERE id = $1`, [b])
    const c = await settleAtCounter(f, { items: link.items, payLinkId: link.id })
    expect(c.body.error).toMatch(/^The reservation on this pay link was canceled on the schedule — nothing was charged\./)
    expect(await sales(f)).toHaveLength(0)
    expect((await bookingRow(b)).deposit_paid_at).toBeNull()
  })
})

// decisions #15: a reservation that becomes a lease is never charged whole at the register.
describe('10/3 (decisions #15) a long stay is charged only its deposit at the register — its lease bills the rest', () => {
  async function longStay(f: F, opts: { source?: string } = {}) {
    await query(`UPDATE units SET monthly_rate = 1200 WHERE id = $1`, [f.sites[0]])
    await query(`UPDATE properties SET booking_monthly_deposit = 150 WHERE id = $1`, [f.propertyId])
    return (await query<{ id: string }>(
      // 10/5 (Nic, R2/R3): a lease bills a stay only when one was chosen — this one's was.
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, status, total_amount, guest_email, guest_name, source, stay_terms)
       VALUES ($1,$2,'month_to_month','2027-05-01','2027-05-31',30,'tentative',1200,'gina@t.dev','Gina Guest',$3,'lease') RETURNING id`,
      [f.sites[0], f.landlordId, opts.source ?? 'direct']))[0].id
  }

  it('a 30-night ticket opens at, and charges, the deposit only; the booking records a deposit, never the stay paid; nothing more is taken for it here', async () => {
    const f = await seed()
    const b = await longStay(f)
    const t = await reservationTicket(f, b)
    const opened = await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const line = opened.body.data.items[0]
    expect(line).toMatchObject({ price: 150, qty: 1, reservation: true })
    expect(line.name).toMatch(/30 nights at site RV 01 \(May 1 → May 31\) — the deposit now; its lease bills the rest$/)
    // The old whole-stay figure is refused; the deposit is charged.
    const whole = await settleAtCounter(f, { items: [{ ...line, price: 1200 }], openTicketId: t })
    expect(whole.status).toBe(409)
    const sale = await settleAtCounter(f, { items: [line], openTicketId: t })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBe(150)
    const [bk] = await query<any>(`SELECT status, deposit_amount::float AS deposit, deposit_paid_at, balance_billed_at, balance_paid_at FROM unit_bookings WHERE id = $1`, [b])
    expect(bk).toMatchObject({ status: 'confirmed', deposit: 150, balance_billed_at: null, balance_paid_at: null })
    expect(bk.deposit_paid_at).not.toBeNull()
    // Nothing more is sent for it from the register: its lease bills the rest.
    const more = await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Toward the stay', qty: 1, price: 100, tax: 0 }] })
    expect(more.status).toBe(409)
    expect(more.body.error).toBe('The deposit on that reservation is paid — its lease bills the rest of the stay, not the register, so nothing was sent. Press Cancel.')
  })

  it('a link toward a long stay charges at most its deposit; a 30-night stay with no lease chosen is charged whole', async () => {
    const f = await seed()
    const b = await longStay(f)
    const link = await typedLink(f, b, 'Toward the stay', 1200)
    expect((await request(app()).get(`/api/public/pay/${link.token}`)).status).toBe(303)
    expect(h.checkoutMock.mock.calls.at(-1)![0].line_items[0].price_data.unit_amount).toBe(15000)
    const { reservationDue } = await import('../services/registerStay')
    expect(await reservationDue(db, b)).toMatchObject({ leaseBillsRest: true, depositDue: 150, owed: 150 })
    // 10/5 (Nic, R3): length alone never makes a lease — a stay answered "no lease" is owed whole.
    await query(`UPDATE unit_bookings SET stay_terms = 'stay' WHERE id = $1`, [b])
    expect(await reservationDue(db, b)).toMatchObject({ leaseBillsRest: false, depositDue: null, owed: 1200 })
    // …unless a lease was drafted from it after all.
    await query(`INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, needs_review, lease_source, source_booking_id)
                 VALUES ($1,$2,1200,'fixed_term','pending','2027-05-01','2027-05-31',TRUE,'booking_draft',$3)`, [f.sites[0], f.landlordId, b])
    expect(await reservationDue(db, b)).toMatchObject({ leaseBillsRest: true, owed: 150 })
  })
})

describe('10/3 (decisions #13) a held payment is refunded by the account owner — one click, once, never on its own', () => {
  it('the owner sees it on the Pay Links tab and refunds it through Stripe; staff and other companies cannot; pressed twice it refunds once; Stripe down, nothing changes', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const held = await paidOnline(await linkById(link.id), 'pi_held_refund', 3.5)   // an amount the link never asked
    expect(held).toMatchObject({ recorded: false, reason: 'amount mismatch' })
    const heldPaymentId = held.heldPaymentId!
    expect(h.refundsMock).not.toHaveBeenCalled()
    // Staff see nothing and cannot refund.
    const u = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    const perms = { 'pos.ring_sale': true }
    await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
    const desk = { Authorization: `Bearer ${jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'd@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })}` }
    const staffList = await request(app()).get('/api/pos/held-payments').set(desk)
    expect(staffList.status).toBe(200)
    expect(staffList.body.data).toEqual([])
    const staffRefund = await request(app()).post(`/api/pos/held-payments/${heldPaymentId}/refund`).set(desk)
    expect(staffRefund.status).toBe(403)
    expect(staffRefund.body.error).toBe('Only the account owner can refund a held payment — ask them to open the notice and press Refund this payment.')
    // Another company's owner cannot see or refund it.
    const c = await db.connect()
    let otherToken = ''
    try {
      const o = await seedLandlord(c)
      otherToken = jwt.sign({ userId: o.userId, role: 'landlord', email: 'o@t.dev', profileId: o.landlordId, landlordIds: [o.landlordId], permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
    } finally { c.release() }
    expect((await request(app()).get('/api/pos/held-payments').set({ Authorization: `Bearer ${otherToken}` })).body.data).toEqual([])
    expect((await request(app()).post(`/api/pos/held-payments/${heldPaymentId}/refund`).set({ Authorization: `Bearer ${otherToken}` })).status).toBe(404)
    expect(h.refundsMock).not.toHaveBeenCalled()
    // The owner sees it and refunds it — the whole payment, to the card, through Stripe.
    const list = await request(app()).get('/api/pos/held-payments').set(auth(f))
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ id: heldPaymentId, reason: 'wrong_amount', status: 'held', linkLabel: 'Propane (20 lb)' })
    const done = await request(app()).post(`/api/pos/held-payments/${heldPaymentId}/refund`).set(auth(f))
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data).toMatchObject({ refunded: true, amount: 3.5 })
    expect(h.refundsMock).toHaveBeenCalledTimes(1)
    expect(h.refundsMock.mock.calls[0][0]).toMatchObject({ payment_intent: 'pi_held_refund' })
    expect(h.refundsMock.mock.calls[0][1]).toEqual({ idempotencyKey: `pos-held-refund-${heldPaymentId}` })
    const [row] = await query<any>(`SELECT status, stripe_refund_id, refunded_by, refunded_at FROM pos_held_payments WHERE id = $1`, [heldPaymentId])
    expect(row).toMatchObject({ status: 'refunded', stripe_refund_id: 're_pi_held_refund', refunded_by: f.userId })
    // Pressed again: no second refund.
    const again = await request(app()).post(`/api/pos/held-payments/${heldPaymentId}/refund`).set(auth(f))
    expect(again.status).toBe(200)
    expect(again.body.data).toMatchObject({ refunded: true, already: true })
    expect(h.refundsMock).toHaveBeenCalledTimes(1)
    // Stripe down: nothing is marked refunded, and the owner is told to press again.
    const second = await paidOnline(await linkById(link.id), 'pi_held_down', 2)
    h.refundsMock.mockRejectedValueOnce(new Error('stripe down'))
    const down = await request(app()).post(`/api/pos/held-payments/${second.heldPaymentId}/refund`).set(auth(f))
    expect(down.status).toBe(502)
    expect(down.body.error).toBe('The refund could not be started just now — nothing was refunded. Wait a moment, then press Refund this payment again.')
    expect((await query<any>(`SELECT status FROM pos_held_payments WHERE id = $1`, [second.heldPaymentId]))[0].status).toBe('held')
  })
})

describe('10/3 (decisions #22) Stripe keeps its fee on a refunded held payment — the landlord\'s loss, said before and recorded after', () => {
  it('the Refund button is told Stripe\'s fee; the refund records it on the held row; when Stripe cannot say, the refund still goes and nothing is made up', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const held = await paidOnline(await linkById(link.id), 'pi_fee_kept', 3.5)
    const list = await request(app()).get('/api/pos/held-payments').set(auth(f))
    expect(list.body.data[0].id).toBe(held.heldPaymentId)
    expect(Number(list.body.data[0].stripeFeeKept)).toBe(0.37)
    expect(list.body.data[0].stripePaymentIntentId).toBeUndefined()
    expect(h.piRetrieveMock.mock.calls[0]).toEqual(['pi_fee_kept', { expand: ['latest_charge.balance_transaction'] }])
    const done = await request(app()).post(`/api/pos/held-payments/${held.heldPaymentId}/refund`).set(auth(f))
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data).toMatchObject({ refunded: true, amount: 3.5, stripeFeeKept: 0.37 })
    expect((await query<any>(`SELECT status, stripe_fee_kept::float AS fee FROM pos_held_payments WHERE id = $1`, [held.heldPaymentId]))[0])
      .toEqual({ status: 'refunded', fee: 0.37 })
    // Stripe cannot say: the list shows no figure (the button says "its processing fee"), the refund still goes.
    const other = await paidOnline(await linkById(link.id), 'pi_fee_unknown', 2)
    h.piRetrieveMock.mockRejectedValue(new Error('stripe down'))
    try {
      const l2 = await request(app()).get('/api/pos/held-payments').set(auth(f))
      expect(l2.body.data.find((r: any) => r.id === other.heldPaymentId).stripeFeeKept).toBeNull()
      const r2 = await request(app()).post(`/api/pos/held-payments/${other.heldPaymentId}/refund`).set(auth(f))
      expect(r2.status).toBe(200)
      expect(r2.body.data).toMatchObject({ refunded: true, stripeFeeKept: null })
    } finally { h.piRetrieveMock.mockReset(); h.piRetrieveMock.mockImplementation(async (id: string) => ({ id, latest_charge: { balance_transaction: { fee: 37 } } })) }
  })
})

// ── 10/3 (review, second pass) ─────────────────────────────────────────────

/** A front-desk worker who rings sales — with extra permissions when given. */
async function deskToken(f: F, extra: Record<string, boolean> = {}): Promise<string> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
  const perms = { 'pos.ring_sale': true, ...extra }
  await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
    [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
  return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'd@t.dev', landlordId: f.landlordId, permissions: perms },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}
const stayLink = (f: F, nights = 2, extra: any = {}) => sendLink(f, {
  items: [{ id: f.stayItem, name: 'RV site — nightly', qty: nights, price: 40 }],
  stay: { unitId: f.sites[0], checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev' }, ...extra })
const saleRow = async (paymentIntent: string) => (await query<any>(
  `SELECT id, subtotal::float AS subtotal, tax_amount::float AS tax, surcharge::float AS surcharge, total::float AS total, tax_breakdown
     FROM pos_transactions WHERE stripe_payment_intent_id = $1`, [paymentIntent]))[0]
const saleLines = async (saleId: string) => query<any>(
  `SELECT item_name, unit_price::float AS price, tax_rate::float AS rate, subtotal::float AS subtotal
     FROM pos_transaction_items WHERE transaction_id = $1 ORDER BY subtotal DESC`, [saleId])

describe('10/3 (review) a held payment lets go of the page it was paid on — the link works again', () => {
  it('a payment held for more than was owed: the link no longer points at the paid page, its page opens again at what is left, and the counter settles it', async () => {
    const f = await seed()
    const b = await heldBooking(f, f.sites[1], 280)
    const big = await typedLink(f, b, 'Toward the stay', 200)
    const small = await typedLink(f, b, 'More toward the stay', 100)
    const smallPage = await openPage(small)
    expect(await paidOnline(await linkById(big.id), 'pi_big_first')).toEqual({ recorded: true })
    // The payer finishes the $100 page anyway — at Stripe it is complete.
    h.pages.set(smallPage, 'complete')
    const late = await paidOnline(await linkById(small.id), 'pi_small_finished')
    expect(late).toMatchObject({ recorded: false, reason: 'more than owed' })
    // The probe: the link let go of the paid page in the same step that held the money.
    expect(await linkRow(small.id)).toEqual({ status: 'open', last_checkout_session_id: null })
    // Opened again, it is not "already paid": a fresh page for what is left ($80).
    h.checkoutMock.mockClear()
    const again = await request(app()).get(`/api/public/pay/${small.token}`)
    expect(again.status, again.text).toBe(303)
    expect(h.checkoutMock.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(8000)
    // And the counter settles it (closing that new page first) — never refused as "just paid online".
    const opened = await request(app()).get(`/api/pos/tickets/${small.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.body.data.items).toEqual([expect.objectContaining({ price: 80, reservation: true })])
    const ok = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: small.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(80)
    expect(await heldRows(f)).toEqual([expect.objectContaining({ reason: 'over_owed', status: 'held' })])
  })

  it('a page paid at an amount the link does not ask: held, and the link can still be changed, closed or opened again', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const page = await openPage(link)
    h.pages.set(page, 'complete')
    expect(await paidOnline({ ...(await linkById(link.id)), last_checkout_session_id: page }, 'pi_odd_amount', 3.5))
      .toMatchObject({ recorded: false, reason: 'amount mismatch' })
    expect((await linkRow(link.id)).last_checkout_session_id).toBeNull()
    expect((await request(app()).get(`/api/public/pay/${link.token}`)).status).toBe(303)
    const adjusted = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth(f)).send({ items: [propaneLine(f, 2)] })
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200)
    expect((await request(app()).post(`/api/pos/pay-links/${link.id}/cancel`).set(auth(f))).status).toBe(200)
    expect(h.refundsMock).not.toHaveBeenCalled()
  })
})

describe('10/3 (review) the arrival-day balance link pays toward what is owed — never stamps more paid than it paid', () => {
  async function repricedUp(f: F) {
    // A $330 stay with $50 paid ahead; its balance link went out for $280; then
    // the schedule repriced the stay to $370 — $320 is owed now.
    const b = await heldBooking(f, f.sites[1], 330)
    await query(`UPDATE unit_bookings SET status = 'confirmed', deposit_amount = 50, deposit_paid_at = NOW() WHERE id = $1`, [b])
    const balance = await typedLink(f, b, 'Stay balance', 280, { balance: true })
    await query(`UPDATE unit_bookings SET total_amount = 370 WHERE id = $1`, [b])
    return { b, balance }
  }
  const bookingPaid = async (b: string) => (await query<any>(
    `SELECT deposit_amount::float AS paid, balance_paid_at FROM unit_bookings WHERE id = $1`, [b]))[0]

  it('paid online: its $280 is added to what was paid, the balance is not stamped paid, and $40 stays owed', async () => {
    const f = await seed()
    const { b, balance } = await repricedUp(f)
    await openPage(balance)
    expect(h.checkoutMock.mock.calls.at(-1)![0].line_items[0].price_data.unit_amount).toBe(28000)
    expect(await paidOnline(await linkById(balance.id), 'pi_balance_280')).toEqual({ recorded: true })
    expect(await bookingPaid(b)).toEqual({ paid: 330, balance_paid_at: null })
    const { reservationDue } = await import('../services/registerStay')
    expect(await reservationDue(db, b)).toMatchObject({ total: 370, paid: 330, owed: 40, paidInFull: false })
  })

  it('at the counter: the same — $40 stays owed; a payment that covers what is owed stamps the balance paid', async () => {
    const f = await seed()
    const { b, balance } = await repricedUp(f)
    const opened = await request(app()).get(`/api/pos/tickets/${balance.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.body.data.items).toEqual([expect.objectContaining({ price: 280, reservation: true })])
    const ok = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: balance.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(await bookingPaid(b)).toEqual({ paid: 330, balance_paid_at: null })
    // The $40 left, paid on a link of its own, finishes it.
    const rest = await typedLink(f, b, 'Toward the stay', 40)
    const restOpened = await request(app()).get(`/api/pos/tickets/${rest.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    const done = await settleAtCounter(f, { items: restOpened.body.data.items, payLinkId: rest.id })
    expect(done.status, JSON.stringify(done.body)).toBe(201)
    const after = await bookingPaid(b)
    expect(after.paid).toBe(370)
    expect(after.balance_paid_at).not.toBeNull()
  })
})

describe('10/3 (decisions #21) a stay sold on a pay link records its lodging tax on the sale', () => {
  it('at the counter: the stay at its price before tax, the lodging tax as tax, propane taxed as usual — the total unchanged', async () => {
    const f = await seed()
    await query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [f.propertyId])
    const sent = await stayLink(f, 2, { items: [{ id: f.stayItem, name: 'RV site — nightly', qty: 2, price: 40 }, propaneLine(f)] })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    // $80 + $8 lodging tax, and $20 propane + $2: the link asks $110.
    expect(Number(sent.body.data.total)).toBe(110)
    expect(Number(sent.body.data.subtotal)).toBe(100)
    expect(Number(sent.body.data.taxAmount)).toBe(10)
    const opened = await request(app()).get(`/api/pos/tickets/${sent.body.data.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    // The register shows the stay at what the guest pays for it.
    expect(opened.body.data.items[0]).toMatchObject({ price: 88, reservation: true, nights: 2 })
    const quote = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', payLinkId: sent.body.data.id, items: opened.body.data.items })
    expect(quote.body.data).toMatchObject({ subtotal: 100, taxAmount: 10, total: 110 })
    const sale = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: sent.body.data.id })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(sale.body.data).toMatchObject({ subtotal: '100.00', taxAmount: '10.00', total: '110.00' })
    expect(sale.body.data.taxBreakdown).toEqual(expect.arrayContaining([{ name: 'Lodging tax', rate: 0.1, amount: 8 }]))
    expect(sale.body.data.taxBreakdown.reduce((n: number, t: any) => n + t.amount, 0)).toBeCloseTo(10, 2)
    const lines = await saleLines(sale.body.data.id)
    expect(lines[0]).toMatchObject({ price: 80, rate: 0.1, subtotal: 80 })
    expect(lines[0].item_name).toMatch(/^RV site — nightly — 2 nights at site RV 01/)
    expect(lines[1]).toMatchObject({ price: 20, rate: 0.1, subtotal: 20 })
  })

  it('paid online: the same split — subtotal, tax, the card fee, and the total charged', async () => {
    const f = await seed()
    await query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [f.propertyId])
    const sent = (await stayLink(f, 2)).body.data
    await openPage(sent)
    expect(await paidOnline(await linkById(sent.id), 'pi_stay_online')).toEqual({ recorded: true })
    const fee = payLinkCharge(88)
    const row = await saleRow('pi_stay_online')
    expect(row).toMatchObject({ subtotal: 80, tax: 8, surcharge: fee.customerFee, total: fee.charged })
    expect(row.tax_breakdown).toEqual([{ name: 'Lodging tax', rate: 0.1, amount: 8 }])
    expect(await saleLines(row.id)).toEqual([expect.objectContaining({ price: 80, rate: 0.1, subtotal: 80 })])
  })

  it('a reservation ticket from the schedule records its lodging tax too; a 30-night stay carries none', async () => {
    const f = await seed()
    await query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [f.propertyId])
    const b = await heldBooking(f, f.sites[1], 308)   // 7 nights × $40 + 10%
    const t = await reservationTicket(f, b)
    const line = (await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))).body.data.items[0]
    const sale = await settleAtCounter(f, { items: [line], openTicketId: t })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(sale.body.data).toMatchObject({ subtotal: '280.00', taxAmount: '28.00', total: '308.00' })
  })
})

describe('10/3 (decisions #23) a reservation\'s nights change only on the schedule — never at the counter, in a quote or by Adjust', () => {
  const words = (press: string, nothing: string, what = '3 nights at site RV 01 (Jun 1 → Jun 4)') =>
    `This link holds ${what} — a reservation's nights, site and price change only on the schedule, so nothing was ${nothing}. `
    + `Put the stay back the way the link has it, then press ${press} again. To change the stay, change the reservation on the schedule first — the link then asks what it owes.`

  const nightsNow = 'This link\'s reservation is 3 nights at site RV 01 (Jun 1 → Jun 4) now — a reservation\'s nights, site and price change only on the schedule, '
    + 'and the cart shows other nights, so nothing was charged. Press Clear, open the link again from the list, then press Charge.'

  it('at the counter: fewer nights are refused — at the quote and at Charge, whoever presses it, even with the schedule permission — and nothing is charged', async () => {
    const f = await seed()
    const link = (await stayLink(f, 3)).body.data
    const plain = await deskToken(f)
    const allowed = await deskToken(f, { 'schedule.edit_reservation': true })
    const opened = await request(app()).get(`/api/pos/tickets/${link.id}?propertyId=${f.propertyId}&kind=pay_link`).set({ Authorization: `Bearer ${plain}` })
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const resLine = opened.body.data.items[0]
    expect(resLine).toMatchObject({ price: 120, nights: 3 })
    for (const tok of [plain, allowed, f.token]) {
      const quote = await request(app()).post('/api/pos/cart-quote').set({ Authorization: `Bearer ${tok}` })
        .send({ propertyId: f.propertyId, paymentMethod: 'cash', payLinkId: link.id, priceStay: true, items: [{ ...resLine, nights: 2, payLinkId: link.id }] })
      expect(quote.status).toBe(409)
      expect(quote.body.error).toBe(nightsNow)
      const refused = await settleAtCounter(f, { items: [{ ...resLine, nights: 2, price: 80, payLinkId: link.id }], payLinkId: link.id })
        .set({ Authorization: `Bearer ${tok}` })
      expect(refused.status).toBe(409)
      expect(refused.body.error).toBe(nightsNow)
      // The link's own stay line with fewer nights (an old screen): the same refusal, pointing to the schedule.
      const raw = await settleAtCounter(f, { items: [{ id: f.stayItem, name: 'RV site — nightly', qty: 2, price: 40 }], payLinkId: link.id })
        .set({ Authorization: `Bearer ${tok}` })
      expect(raw.status).toBe(400)
      expect(raw.body.error).toBe(words('Charge', 'charged'))
    }
    expect(await sales(f)).toHaveLength(0)
    expect(await bookingRow(link.bookingId)).toMatchObject({ status: 'tentative', total: 120 })
    // The whole stay needs no extra permission.
    const ok = await settleAtCounter(f, { items: [{ ...resLine, payLinkId: link.id }], payLinkId: link.id })
      .set({ Authorization: `Bearer ${plain}` })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(120)
    expect(await bookingRow(link.bookingId)).toMatchObject({ status: 'confirmed', total: 120 })
  })

  it('by Adjust: fewer nights are refused for everybody (nothing changed); the whole stay saves', async () => {
    const f = await seed()
    const link = (await stayLink(f, 3)).body.data
    const stayLine = (qty: number) => ({ id: f.stayItem, name: 'RV site — nightly', qty, price: 40 })
    for (const tok of [await deskToken(f), await deskToken(f, { 'schedule.edit_reservation': true }), f.token]) {
      const refused = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set({ Authorization: `Bearer ${tok}` }).send({ items: [stayLine(2)] })
      expect(refused.status).toBe(400)
      expect(refused.body.error).toBe(words('Save changes', 'changed'))
    }
    expect(await bookingRow(link.bookingId)).toMatchObject({ total: 120 })
    expect(Number((await linkById(link.id)).total)).toBe(120)
    expect((await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth(f)).send({ items: [stayLine(3)] })).status).toBe(200)
  })
})

describe('10/3 (decisions #21, #23) a stay link is priced by the schedule\'s own pricing from the moment it is sent — and follows the schedule after', () => {
  it('3 nights sent, then shortened to 2 on the schedule: the list, Send again, the card page and the counter all ask the schedule\'s figure', async () => {
    const f = await seed()
    await query(`UPDATE properties SET short_term_tax_rate = 12 WHERE id = $1`, [f.propertyId])
    const { priceStayBySchedule } = await import('../services/registerStay')
    const link = (await stayLink(f, 3)).body.data
    const three = await priceStayBySchedule(db, f.sites[0], '2027-06-01', '2027-06-04')
    // (12% lodging tax — the item's own 10% would have made it $132.)
    expect(three).toMatchObject({ total: 134.4, base: 120, tax: 14.4 })
    expect(Number(link.total)).toBe(134.4)
    expect(await bookingRow(link.bookingId)).toMatchObject({ total: 134.4 })
    // The schedule shortens it to two nights and reprices it by its own pricing.
    const two = await priceStayBySchedule(db, f.sites[0], '2027-06-01', '2027-06-03')
    expect(two.total).toBe(89.6)
    await query(`UPDATE unit_bookings SET check_out = '2027-06-03', nights = 2, total_amount = $2 WHERE id = $1`, [link.bookingId, two.total])
    // The Pay Links list.
    const listed = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth(f))).body.data.find((r: any) => r.id === link.id)
    expect(listed).toMatchObject({ subtotal: 80, taxAmount: 9.6, total: 89.6, charged: payLinkCharge(89.6).charged })
    // Send again: the link is saved at it first, and the email says it.
    const resent = await request(app()).post(`/api/pos/pay-links/${link.id}/resend`).set(auth(f))
    expect(resent.status, JSON.stringify(resent.body)).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ subtotal: '80.00', tax_amount: '9.60', total: '89.60' })
    expect(h.emailPayLinkMock.mock.calls.at(-1)![0]).toMatchObject({ amount: 89.6, cardFee: payLinkCharge(89.6).customerFee })
    // The card page.
    await openPage(await linkById(link.id))
    expect(h.checkoutMock.mock.calls.at(-1)![0].line_items[0].price_data.unit_amount).toBe(8960)
    // The counter.
    const opened = await request(app()).get(`/api/pos/tickets/${link.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.body.data.items[0]).toMatchObject({ price: 89.6, nights: 2 })
    expect(Number(opened.body.data.total)).toBe(89.6)
    const sale = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: link.id })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(sale.body.data).toMatchObject({ subtotal: '80.00', taxAmount: '9.60', total: '89.60' })
    expect((await query<any>(`SELECT total_amount::float AS total, nights, check_out::text AS check_out FROM unit_bookings WHERE id = $1`, [link.bookingId]))[0])
      .toEqual({ total: 89.6, nights: 2, check_out: '2027-06-03' })
  })

  it('Send again with nothing changed sends the same figure and touches no card page; a reservation that is over sends nothing', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const page = await openPage(link)
    const resent = await request(app()).post(`/api/pos/pay-links/${link.id}/resend`).set(auth(f))
    expect(resent.status, JSON.stringify(resent.body)).toBe(200)
    expect(h.emailPayLinkMock.mock.calls.at(-1)![0]).toMatchObject({ amount: 80 })
    expect((await linkRow(link.id)).last_checkout_session_id).toBe(page)
    expect(h.expireMock).not.toHaveBeenCalled()
    await query(`UPDATE unit_bookings SET status = 'cancelled' WHERE id = $1`, [link.bookingId])
    const sends = h.emailPayLinkMock.mock.calls.length
    const over = await request(app()).post(`/api/pos/pay-links/${link.id}/resend`).set(auth(f))
    expect(over.status).toBe(409)
    expect(over.body.error).toBe('The reservation on this pay link was canceled on the schedule — nothing was sent. Close the link under Pay Links; if they still want to stay, ring the stay fresh with a site and dates.')
    expect(h.emailPayLinkMock.mock.calls.length).toBe(sends)
    // The list says so beside it, with what to press.
    const listed = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth(f))).body.data.find((r: any) => r.id === link.id)
    expect(listed.note).toBe('The reservation on this pay link was canceled on the schedule — nothing can be paid on this link. Press Close; if they still want to stay, ring the stay fresh with a site and dates.')
  })

  // 10/5 (Nic, R5): the register sells a stay in whole nights, weeks or months
  // at the price of the button rung — never repriced or prorated. A week is
  // the weekly rate when it is rung as a week; seven nights rung on the nightly
  // button are seven nights.
  it('a week rung as a week is the weekly rate; seven nights rung by the night are seven nights (R5)', async () => {
    const f = await seed()
    await query(`UPDATE units SET weekly_rate = 231 WHERE id = $1`, [f.sites[0]])
    const weekItem = (await query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       SELECT landlord_id, property_id, 'RV site — weekly', category_id, 0, 0, 0.1, 999, 0, 999, 'week' FROM pos_items WHERE id = $1
       RETURNING id`, [f.stayItem]))[0].id
    const week = await stayLink(f, 1, { items: [{ id: weekItem, name: 'RV site — weekly', qty: 1, price: 231 }] })
    expect(week.status, JSON.stringify(week.body)).toBe(201)
    expect(Number(week.body.data.total)).toBe(231)
    expect(await bookingRow(week.body.data.bookingId)).toMatchObject({ total: 231 })
    const nights = (await stayLink(f, 7, { stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev' } })).body.data
    expect(Number(nights.total)).toBe(280)
  })
})

describe('10/3 (review) a reservation is described only as it is', () => {
  it('a long stay with nothing due now is never "deposit paid": its hand-off ticket goes with the true reason', async () => {
    const f = await seed()
    await query(`UPDATE units SET monthly_rate = 1200 WHERE id = $1`, [f.sites[0]])
    await query(`UPDATE properties SET booking_monthly_deposit = 0 WHERE id = $1`, [f.propertyId])
    const b = (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, status, total_amount, guest_email, guest_name, source, stay_terms)
       VALUES ($1,$2,'month_to_month','2027-05-01','2027-05-31',30,'tentative',1200,'gina@t.dev','Gina Guest','direct','lease') RETURNING id`,
      [f.sites[0], f.landlordId]))[0].id
    const { reservationDue } = await import('../services/registerStay')
    expect(await reservationDue(db, b)).toMatchObject({ leaseBillsRest: true, depositDue: 0, paid: 0, owed: 0, paidInFull: true })
    const t = await reservationTicket(f, b)
    const opened = await request(app()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))
    expect(opened.status).toBe(409)
    expect(opened.body.error).toBe('Nothing is due on that reservation at the register — its lease bills the stay, so there is nothing to charge on this ticket and it was taken off the list.')
    const [ticket] = await query<any>(`SELECT status, void_reason FROM pos_open_tickets WHERE id = $1`, [t])
    expect(ticket).toEqual({ status: 'voided', void_reason: 'Nothing is due on the reservation at the register — its lease bills the stay' })
    expect(ticket.void_reason).not.toMatch(/deposit/)
  })

  it('a hold that was moved to another site and then cancelled on the schedule is "cancelled on the schedule", never "lost its site"', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const { clearUnpaidHolds } = await import('../services/holdDisplacement')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      expect((await clearUnpaidHolds(c, f.sites[0], '2027-06-01', '2027-06-03'))[0]).toMatchObject({ outcome: 'moved' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await query(`UPDATE unit_bookings SET status = 'cancelled' WHERE id = $1`, [link.bookingId])
    const { reservationDue } = await import('../services/registerStay')
    expect(await reservationDue(db, link.bookingId)).toMatchObject({ closed: true, displaced: false })
    const r = await settleAtCounter(f, { items: link.items, payLinkId: link.id })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/^The reservation on this pay link was canceled on the schedule — nothing was charged\./)
    // One that lost its site with nowhere to go is said to have.
    const other = (await stayLink(f, 2, { stay: { unitId: f.sites[0], checkIn: '2027-07-01', guestName: 'Hal Holder' } })).body.data
    await query(`UPDATE unit_bookings SET status = 'cancelled', displaced_at = NOW(), displaced_from_unit = unit_id WHERE id = $1`, [other.bookingId])
    expect(await reservationDue(db, other.bookingId)).toMatchObject({ displaced: true })
  })
})

// ── 10/3 (review, third pass) ──────────────────────────────────────────────

const lodgingNotices = async (f: F) => query<any>(
  `SELECT title, body, data FROM notifications WHERE landlord_id = $1 AND type = 'pay_link_left_owed' ORDER BY created_at`, [f.landlordId])

describe('10/3 (review, decisions #21) a deposit or balance link toward a short stay records its share of the lodging tax', () => {
  /** A 7-night $308 stay at 10% lodging tax ($280 + $28) with $30.80 paid ahead, and its $277.20 arrival-day balance link. */
  async function balanceDue(f: F) {
    await query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [f.propertyId])
    const b = await heldBooking(f, f.sites[1], 308)
    await query(`UPDATE unit_bookings SET status = 'confirmed', deposit_amount = 30.80, deposit_paid_at = NOW() WHERE id = $1`, [b])
    const balance = await typedLink(f, b, 'Stay balance', 277.2, { balance: true })
    return { b, balance }
  }

  it('paid online: the balance is $252.00 of stay and $25.20 of lodging tax — the same split the counter records', async () => {
    const f = await seed()
    const { balance } = await balanceDue(f)
    await openPage(balance)
    expect(await paidOnline(await linkById(balance.id), 'pi_balance_tax')).toEqual({ recorded: true })
    const fee = payLinkCharge(277.2)
    const row = await saleRow('pi_balance_tax')
    expect(row).toMatchObject({ subtotal: 252, tax: 25.2, surcharge: fee.customerFee, total: fee.charged })
    expect(row.tax_breakdown).toEqual([{ name: 'Lodging tax', rate: 0.1, amount: 25.2 }])
    expect(await saleLines(row.id)).toEqual([expect.objectContaining({ item_name: 'Stay balance', price: 252, rate: 0.1, subtotal: 252 })])
  })

  it('at the counter: the same balance link records the same $252.00 + $25.20', async () => {
    const f = await seed()
    const { balance } = await balanceDue(f)
    const opened = await request(app()).get(`/api/pos/tickets/${balance.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.body.data.items).toEqual([expect.objectContaining({ price: 277.2, reservation: true })])
    const quote = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', payLinkId: balance.id, items: opened.body.data.items })
    expect(quote.body.data).toMatchObject({ subtotal: 252, taxAmount: 25.2, total: 277.2 })
    const sale = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: balance.id })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(sale.body.data).toMatchObject({ subtotal: '252.00', taxAmount: '25.20', total: '277.20' })
    expect(sale.body.data.taxBreakdown).toEqual([{ name: 'Lodging tax', rate: 0.1, amount: 25.2 }])
    // The register is handed the sale's own lines: the balance before its tax, so the lines and the tax add up.
    expect(sale.body.data.items).toEqual([expect.objectContaining({ name: 'Stay balance', qty: 1, price: 252, tax: 0.1 })])
  })

  it('a deposit paid online and the balance paid at the counter: the tax on the two sales adds up to the stay\'s tax', async () => {
    const f = await seed()
    await query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [f.propertyId])
    const b = await heldBooking(f, f.sites[1], 308)
    const deposit = await typedLink(f, b, 'Deposit', 30.8)
    await openPage(deposit)
    expect(await paidOnline(await linkById(deposit.id), 'pi_deposit_tax')).toEqual({ recorded: true })
    const first = await saleRow('pi_deposit_tax')
    expect(first).toMatchObject({ subtotal: 28, tax: 2.8 })
    const balance = await typedLink(f, b, 'Stay balance', 277.2, { balance: true })
    const opened = await request(app()).get(`/api/pos/tickets/${balance.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    const second = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: balance.id })
    expect(second.status, JSON.stringify(second.body)).toBe(201)
    expect(Number(second.body.data.taxAmount)).toBe(25.2)
    const { priceStayBySchedule } = await import('../services/registerStay')
    const whole = await priceStayBySchedule(db, f.sites[1], '2027-05-01', '2027-05-08')
    expect(whole).toMatchObject({ total: 308, tax: 28 })
    expect(Math.round((first.tax + Number(second.body.data.taxAmount)) * 100)).toBe(2800)
    expect(Math.round((first.subtotal + Number(second.body.data.subtotal)) * 100)).toBe(28000)
  })

  it('the parts always add up, whatever the split — to the cent', async () => {
    const { taxInsidePayment, taxInside } = await import('../services/registerStay')
    for (const [total, rate, parts] of [[308, 0.1, [30.8, 277.2]], [258.72, 0.12, [25.87, 100, 132.85]], [99.99, 0.0635, [10, 0.01, 89.98]]] as [number, number, number[]][]) {
      let paid = 0, tax = 0
      for (const p of parts) { tax += taxInsidePayment(paid, p, rate); paid = Math.round((paid + p) * 100) / 100 }
      expect(paid).toBe(total)
      expect(Math.round(tax * 100)).toBe(Math.round(taxInside(total, rate) * 100))
    }
  })
})

// 10/5 (Nic, R5): "point of sale cannot prorate a stay" — the register and a link sent from it
// sell whole nights, weeks and months. 10/6 (Nic): "six nights for $312. Well, our weekly price is
// $269. It should be charging them ... the cheapest option." Seven nights rung as nights are charged
// the week ($231 + 12% lodging tax = $258.72), never 7 × $40 ($313.60) — the same figure the
// schedule, the booking site and a link charge.
describe('10/3 (review, decisions #9) the same nights cost the same on a link and at the counter (10/5 R5: whole nights, never prorated)', () => {
  /** Mountain View's shape: $40 a night, $231 a week, 12% lodging tax — and a stay ITEM taxed 10%. */
  async function park(f: F) {
    await query(`UPDATE units SET weekly_rate = 231 WHERE id = ANY($1::uuid[])`, [f.sites])
    await query(`UPDATE properties SET short_term_tax_rate = 12 WHERE id = $1`, [f.propertyId])
  }
  const stayCartLine = (f: F, extra: any = {}) => ({ id: f.stayItem, name: 'RV site — nightly', qty: 7, price: 40, tax: 0.1, ...extra })

  it('seven nights: $258.72 (the week) on Send link, on Charge, in the site list and on the schedule — recorded as $231.00 + $27.72 lodging tax', async () => {
    const f = await seed()
    await park(f)
    const { priceStayBySchedule } = await import('../services/registerStay')
    const schedule = await priceStayBySchedule(db, f.sites[1], '2027-06-01', '2027-06-08')
    expect(schedule).toMatchObject({ total: 258.72, base: 231, tax: 27.72 })   // 10/6: the register charges the same

    // Send link (site 1).
    const link = (await stayLink(f, 7)).body.data
    expect(Number(link.total)).toBe(258.72)

    // The register's site list prices each site the same way. (10/3, S652: the
    // site the link holds unpaid is still offered — last, flagged — because a
    // payment here would move that hold.)
    const list = await request(app()).get(`/api/pos/stays/available?propertyId=${f.propertyId}&checkIn=2027-06-01&stayUnit=night&qty=7`).set(auth(f))
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(list.body.data.units).toEqual([
      expect.objectContaining({ id: f.sites[1], rate: 40, lineTotal: 258.72, lodgingTax: 27.72, heldByUnpaidHold: false,
                                lowerRateWords: 'charged at the weekly rate, the lower price' }),
      expect.objectContaining({ id: f.sites[0], rate: 40, lineTotal: 258.72, lodgingTax: 27.72, heldByUnpaidHold: true })])

    // The quote, with the site and arrival riding on the stay's own line (as the reader's calls carry them).
    const onLine = stayCartLine(f, { stayUnitId: f.sites[1], stayCheckIn: '2027-06-01', stayTotal: 258.72 })
    const quote = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', items: [onLine, propaneLine(f)] })
    expect(quote.status, JSON.stringify(quote.body)).toBe(200)
    expect(quote.body.data).toMatchObject({ subtotal: 251, taxAmount: 29.72, total: 280.72 })   // + $20 propane and its $2

    // A cart showing the stay at another figure is refused before any money moves.
    const stale = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', items: [{ ...onLine, stayTotal: 313.6 }] })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('This stay — 7 nights at site RV 02 (Jun 1 → Jun 8) — charged at the weekly rate, the lower price — comes to $258.72 — the cart shows something else, and nothing was charged. '
      + 'Tap the site and dates above Charge, press Use this site, then press Charge again.')

    // The card reader is never asked to charge a stay with no site.
    const noSite = await request(app()).post('/api/pos/terminal/payment-intents').set(auth(f))
      .send({ propertyId: f.propertyId, items: [stayCartLine(f)] })
    expect(noSite.status).toBe(400)
    expect(noSite.body.error).toBe('A stay needs a site and an arrival date before it can be charged — press Pick a site and dates, then press Charge again.')
    expect(h.createIntentMock).not.toHaveBeenCalled()
    const intent = await request(app()).post('/api/pos/terminal/payment-intents').set(auth(f))
      .send({ propertyId: f.propertyId, items: [onLine] })
    expect(intent.status, JSON.stringify(intent.body)).toBe(201)
    expect(h.createIntentMock.mock.calls[0][0].amountCents).toBe(Math.round(payLinkCharge(258.72).charged * 100))

    // Charge (site 2): the same figure, recorded split, and the booking at that price.
    const sale = await settleAtCounter(f, { items: [onLine], stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Walk In' } })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(sale.body.data).toMatchObject({ subtotal: '231.00', taxAmount: '27.72', total: '258.72' })
    expect(sale.body.data.taxBreakdown).toEqual([{ name: 'Lodging tax', rate: 0.12, amount: 27.72 }])
    const lines = await saleLines(sale.body.data.id)
    // The receipt says why it is less than seven nights.
    expect(lines).toEqual([{ item_name: 'RV site — nightly — 7 nights at site RV 02 (Jun 1 → Jun 8) — charged at the weekly rate, the lower price', price: 231, rate: 0.12, subtotal: 231 }])
    const [bk] = await query<any>(`SELECT total_amount::float AS total, nights, source FROM unit_bookings WHERE id = $1`, [sale.body.data.stayBooking.bookingId])
    expect(bk).toEqual({ total: 258.72, nights: 7, source: 'register' })
  })

  it('a stay line priced for one site or day, rung with another picked, is refused before any money moves', async () => {
    const f = await seed()
    await park(f)
    const line = stayCartLine(f, { stayUnitId: f.sites[1], stayCheckIn: '2027-06-01', stayTotal: 258.72 })
    const words = 'The stay in the cart was priced for another site or arrival date than the one picked — nothing was charged. '
      + 'Tap the site and dates above Charge, press Use this site, then press Charge again.'
    const otherSite = await settleAtCounter(f, { items: [line], stay: { unitId: f.sites[0], checkIn: '2027-06-01', guestName: 'Walk In' } })
    expect(otherSite.status).toBe(409)
    expect(otherSite.body.error).toBe(words)
    const otherDay = await settleAtCounter(f, { items: [line], stay: { unitId: f.sites[1], checkIn: '2027-06-02', guestName: 'Walk In' } })
    expect(otherDay.status).toBe(409)
    expect(otherDay.body.error).toBe(words)
    const quote = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', items: [line], stay: { unitId: f.sites[0], checkIn: '2027-06-01' } })
    expect(quote.status).toBe(409)
    expect(await sales(f)).toHaveLength(0)
    expect(await query(`SELECT 1 FROM unit_bookings WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
    const ok = await settleAtCounter(f, { items: [line], stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Walk In' } })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(258.72)
  })

  it('a sale that sends the stay with no figure of its own is charged the site\'s price for those nights, never the browser\'s', async () => {
    const f = await seed()
    await park(f)
    const sale = await settleAtCounter(f, { items: [stayCartLine(f, { price: 49 })], stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Walk In' } })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBe(258.72)
  })
})

describe('10/3 (review, decisions #15) a long stay\'s deposit is paid whole — never collapsed to a part of it', () => {
  /** A 35-night stay its lease bills, with a $500 deposit due. */
  async function longStay(f: F) {
    await query(`UPDATE units SET monthly_rate = 1200 WHERE id = $1`, [f.sites[0]])
    return (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, status, total_amount, deposit_amount, guest_email, guest_name, source, stay_terms)
       VALUES ($1,$2,'month_to_month','2027-05-01','2027-06-05',35,'tentative',1400,500,'gina@t.dev','Gina Guest','direct','lease') RETURNING id`,
      [f.sites[0], f.landlordId]))[0].id
  }
  const depositRow = async (b: string) => (await query<any>(
    `SELECT deposit_amount::float AS deposit, deposit_paid_at FROM unit_bookings WHERE id = $1`, [b]))[0]

  it('a link for part of it is refused when it is sent; the whole deposit goes out', async () => {
    const f = await seed()
    const b = await longStay(f)
    const { reservationDue } = await import('../services/registerStay')
    expect(await reservationDue(db, b)).toMatchObject({ leaseBillsRest: true, depositDue: 500, owed: 500 })
    const part = await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Toward the deposit', qty: 1, price: 200, tax: 0 }] })
    expect(part.status).toBe(400)
    expect(part.body.error).toBe('This asks $200.00 toward a long stay whose deposit is $500.00 — a long stay\'s deposit is paid whole (its lease bills the rest), so nothing was sent. '
      + 'Change the amount to $500.00, then press Send link again.')
    const whole = await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Deposit', qty: 1, price: 500, tax: 0 }] })
    expect(whole.status, JSON.stringify(whole.body)).toBe(201)
  })

  it('a part link already out is refused at the counter and on its page; one paid on a page opened earlier is held, and the deposit is still $500 due', async () => {
    const f = await seed()
    const b = await longStay(f)
    const part = await typedLink(f, b, 'Toward the deposit', 200)
    const opened = await request(app()).get(`/api/pos/tickets/${part.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    expect(opened.status).toBe(409)
    expect(opened.body.error).toBe('This asks $200.00 toward a long stay whose deposit is $500.00 — a long stay\'s deposit is paid whole (its lease bills the rest), so nothing was charged. '
      + 'Close this link under Pay Links, then take the $500.00 at the counter or send a new link for it.')
    const page = await request(app()).get(`/api/public/pay/${part.token}`)
    expect(page.status).toBe(409)
    expect(page.text).toMatch(/This link needs updating/)
    // A page opened before (when it could still be opened) and paid now.
    const late = await paidOnline({ ...part, last_checkout_session_id: 'cs_old' }, 'pi_part_deposit')
    expect(late).toMatchObject({ recorded: false, reason: 'part of a long stay\'s deposit' })
    expect(await heldRows(f)).toEqual([expect.objectContaining({ reason: 'deposit_part', status: 'held', amount: payLinkCharge(200).charged })])
    // 10/3 (review): told what happened — never "an old version of the link" (nobody changed it) — and steps that work.
    const paid = `$${payLinkCharge(200).charged.toFixed(2)}`
    expect(await noticesOf(f, 'pay_link_amount_mismatch')).toHaveLength(0)
    const told = await noticesOf(f, 'pay_link_deposit_part')
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe(`Pat Payer paid ${paid} toward a long stay's $500.00 deposit — it is held for you to refund`)
    expect(told[0].body).toBe(`Pat Payer paid ${paid} online on the pay link "Toward the deposit" toward the reservation for site RV 01, `
      + 'which is now a long stay whose deposit is $500.00 — a deposit is paid whole, so this payment is held. '
      + 'GAM is holding it: it was not recorded as a sale and it is not in your payouts. '
      + 'Open this notice and press Refund this payment to send it back to their card — do not pay it back from the drawer. '
      + 'Then close this link under Pay Links, and take the $500.00 deposit at the counter or send a new link for it.')
    expect(told[0].data).toMatchObject({ heldPaymentId: late.heldPaymentId, deposit: 500 })
    // The steps work: the link closes, and the whole deposit goes out on a new link.
    const closed = await request(app()).post(`/api/pos/pay-links/${part.id}/cancel`).set(auth(f))
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    const whole = await sendLink(f, { bookingId: b, items: [{ id: null, name: 'Deposit', qty: 1, price: 500, tax: 0 }] })
    expect(whole.status, JSON.stringify(whole.body)).toBe(201)
    expect(await sales(f)).toHaveLength(0)
    expect(await depositRow(b)).toEqual({ deposit: 500, deposit_paid_at: null })
    const { reservationDue } = await import('../services/registerStay')
    expect(await reservationDue(db, b)).toMatchObject({ depositDue: 500, owed: 500, paidInFull: false })
  })

  it('a link that HOLDS the stay, paid for part of the deposit after the stay became long: held, and the landlord is told to keep the link (closing it cancels the stay) and press Send again — it now asks the whole deposit', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const page = await openPage(link)
    // The schedule lengthens it into a long stay and the counter answers LEASE
    // (10/5, R3: a lease is never drafted on its own) — its lease bills the
    // rest, with a $500 deposit.
    await query(`UPDATE unit_bookings SET source = 'direct', check_out = '2027-07-06', nights = 35, total_amount = 1400, deposit_amount = 500, stay_terms = 'lease' WHERE id = $1`, [link.bookingId])
    const late = await paidOnline({ ...(await linkById(link.id)), last_checkout_session_id: page }, 'pi_stay_part_deposit')
    expect(late).toMatchObject({ recorded: false, reason: 'part of a long stay\'s deposit' })
    const paid = `$${payLinkCharge(80).charged.toFixed(2)}`
    const told = await noticesOf(f, 'pay_link_deposit_part')
    expect(told).toHaveLength(1)
    // 10/5: a stay link is named for the stay it sells.
    expect(told[0].body).toBe(`Pat Payer paid ${paid} online on the pay link "RV site — nightly — 2 nights at site RV 01 (Jun 1 → Jun 3)" toward the reservation for site RV 01, `
      + 'which is now a long stay whose deposit is $500.00 — a deposit is paid whole, so this payment is held. '
      + 'GAM is holding it: it was not recorded as a sale and it is not in your payouts. '
      + 'Open this notice and press Refund this payment to send it back to their card — do not pay it back from the drawer. '
      + 'This link holds their reservation, so keep it open (closing it would cancel the stay) — it now asks the whole $500.00 deposit. '
      + 'Once the refund is under way, press Send again on it under Pay Links, or take the $500.00 at the counter.')
    expect(told[0].body).not.toMatch(/close this link/i)
    // And that is true: the link stays open, lists at $500, and Send again emails $500.
    expect((await linkRow(link.id)).status).toBe('open')
    const listed = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth(f))).body.data.find((r: any) => r.id === link.id)
    expect(Number(listed.total)).toBe(500)
    const resent = await request(app()).post(`/api/pos/pay-links/${link.id}/resend`).set(auth(f))
    expect(resent.status, JSON.stringify(resent.body)).toBe(200)
    expect(h.emailPayLinkMock.mock.calls.at(-1)![0]).toMatchObject({ amount: 500 })
    expect(Number((await linkById(link.id)).total)).toBe(500)
    expect((await bookingRow(link.bookingId)).status).toBe('tentative')
  })

  it('a whole-deposit link paid after the deposit was lowered: held as more than owed — and nobody is told another payment came first, because none did', async () => {
    const f = await seed()
    const b = await longStay(f)
    const whole = await typedLink(f, b, 'Deposit', 500)
    await query(`UPDATE unit_bookings SET deposit_amount = 300 WHERE id = $1`, [b])
    const late = await paidOnline(whole, 'pi_deposit_lowered')
    expect(late).toMatchObject({ recorded: false, reason: 'more than owed' })
    expect(await heldRows(f)).toEqual([expect.objectContaining({ reason: 'over_owed', status: 'held' })])
    const told = await noticesOf(f, 'pay_link_over_owed')
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/but only \$300\.00 was left to pay on it when the payment landed — \$200\.00 more than was owed\. GAM is holding it/)
    expect(told[0].body).not.toMatch(/another payment/)
  })
})

describe('10/3 (review) a payment that leaves something owed that nothing will ask for — the landlord is told once', () => {
  async function repricedUp(f: F) {
    const b = await heldBooking(f, f.sites[1], 330)
    await query(`UPDATE unit_bookings SET status = 'confirmed', deposit_amount = 50, deposit_paid_at = NOW() WHERE id = $1`, [b])
    const balance = await typedLink(f, b, 'Stay balance', 280, { balance: true })
    await query(`UPDATE unit_bookings SET total_amount = 370 WHERE id = $1`, [b])
    return { b, balance }
  }
  const words = (paid: string) => `Pat Payer paid ${paid} on the pay link "Stay balance" toward the reservation for site RV 02 (2027-05-01 to 2027-05-08), `
    + 'but $40.00 is still owed on it, and nothing is set to ask for it: no other pay link or register ticket is out for it, and no arrival-day bill will ask for it. '
    + 'Take the $40.00 at the counter, or send them a new link for it.'

  it('a balance link paid online after the stay was repriced up: told once, with the amount and the next step', async () => {
    const f = await seed()
    const { balance } = await repricedUp(f)
    await openPage(balance)
    const row = await linkById(balance.id)
    expect(await paidOnline(row, 'pi_left_owed')).toEqual({ recorded: true })
    expect(await paidOnline(row, 'pi_left_owed')).toMatchObject({ recorded: false, reason: 'already recorded' })
    const n = await lodgingNotices(f)
    expect(n).toHaveLength(1)
    expect(n[0].title).toBe('Pat Payer still owes $40.00 on their reservation — nothing is set to ask for it')
    expect(n[0].body).toBe(words('$280.00'))
    expect(n[0].data).toMatchObject({ owed: 40, paid: 280, bookingId: balance.booking_id })
  })

  it('the same at the counter', async () => {
    const f = await seed()
    const { balance } = await repricedUp(f)
    const opened = await request(app()).get(`/api/pos/tickets/${balance.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    const ok = await settleAtCounter(f, { items: opened.body.data.items, payLinkId: balance.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    const n = await lodgingNotices(f)
    expect(n).toHaveLength(1)
    expect(n[0].body).toBe(words('$280.00').replace('Pat Payer', 'Gina Guest').replace('Pat Payer', 'Gina Guest'))
  })

  it('nobody is told when something else will ask for it: another link out for it, or the arrival-day bill still to come', async () => {
    const f = await seed()
    const { b, balance } = await repricedUp(f)
    await typedLink(f, b, 'The rest', 40)
    await openPage(balance)
    expect(await paidOnline(await linkById(balance.id), 'pi_other_link_out')).toEqual({ recorded: true })
    expect(await lodgingNotices(f)).toHaveLength(0)
    // A deposit on a stay that has not arrived yet: its arrival-day bill asks for the rest.
    const later = await heldBooking(f, f.sites[0], 280)
    const deposit = await typedLink(f, later, 'Deposit', 28)
    await openPage(deposit)
    expect(await paidOnline(await linkById(deposit.id), 'pi_deposit_only')).toEqual({ recorded: true })
    expect(await lodgingNotices(f)).toHaveLength(0)
  })
})

describe('10/3 (review) a stay rung at the counter: no discount, nothing unpriced on the customer\'s screen, and a link at the figure the clerk saw', () => {
  /** Mountain View's shape: $40 a night, $231 a week, 12% lodging tax — and a stay ITEM taxed 10%. */
  async function park(f: F) {
    await query(`UPDATE units SET weekly_rate = 231 WHERE id = ANY($1::uuid[])`, [f.sites])
    await query(`UPDATE properties SET short_term_tax_rate = 12 WHERE id = $1`, [f.propertyId])
  }
  const stayCartLine = (f: F, extra: any = {}) => ({ id: f.stayItem, name: 'RV site — nightly', qty: 7, price: 40, tax: 0.1, ...extra })
  const onSite = (f: F) => stayCartLine(f, { stayUnitId: f.sites[1], stayCheckIn: '2027-06-01', stayTotal: 258.72 })
  const NO_DISCOUNT = 'A stay is charged at the schedule\'s price — take the discount off, then press Charge again. '
    + 'To charge less for the stay, change its price on the schedule; to discount other items, ring them on a sale of their own.'

  it('a discount on a cart with a stay is refused by the quote, the card reader and the sale — nothing is charged, recorded or booked', async () => {
    const f = await seed()
    await park(f)
    for (const items of [[onSite(f)], [onSite(f), propaneLine(f)], [stayCartLine(f)]]) {
      const quote = await request(app()).post('/api/pos/cart-quote').set(auth(f))
        .send({ propertyId: f.propertyId, paymentMethod: 'cash', items, discountAmount: 10 })
      expect(quote.status, JSON.stringify(quote.body)).toBe(400)
      expect(quote.body.error).toBe(NO_DISCOUNT)
    }
    const intent = await request(app()).post('/api/pos/terminal/payment-intents').set(auth(f))
      .send({ propertyId: f.propertyId, items: [onSite(f)], discountAmount: 10 })
    expect(intent.status).toBe(400)
    expect(intent.body.error).toBe(NO_DISCOUNT)
    expect(h.createIntentMock).not.toHaveBeenCalled()
    const sale = await settleAtCounter(f, { items: [onSite(f)], discountAmount: 10, stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Walk In' } })
    expect(sale.status).toBe(400)
    expect(sale.body.error).toBe(NO_DISCOUNT)
    expect(await sales(f)).toHaveLength(0)
    expect(await query(`SELECT 1 FROM unit_bookings WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
    // Without the discount it goes through at the schedule's price; propane alone still takes one.
    const ok = await settleAtCounter(f, { items: [onSite(f)], stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Walk In' } })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(258.72)
    const propane = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', items: [propaneLine(f)], discountAmount: 5 })
    expect(propane.status, JSON.stringify(propane.body)).toBe(200)
  })

  it('before a site is picked the reader\'s breakdown leaves the stay off, and out of its total; once picked it shows at the schedule\'s figure', async () => {
    const f = await seed()
    await park(f)
    const terminal = await import('../services/posTerminal')
    const show = vi.mocked(terminal.showCartOnReader)
    const clear = vi.mocked(terminal.clearCartOnReader)
    show.mockClear(); clear.mockClear()
    const put = (items: any[]) => request(app()).post('/api/pos/terminal/readers/tmr_desk/cart').set(auth(f))
      .send({ propertyId: f.propertyId, items })

    // Propane and a stay with no site: only the propane, at the propane's card total.
    const both = await put([stayCartLine(f), propaneLine(f)])
    expect(both.status, JSON.stringify(both.body)).toBe(200)
    const propaneOnly = await request(app()).post('/api/pos/cart-quote').set(auth(f))
      .send({ propertyId: f.propertyId, paymentMethod: 'card', items: [propaneLine(f)] })
    expect(both.body.data).toMatchObject({ shown: true, totalCents: Math.round(Number(propaneOnly.body.data.total) * 100) })
    const shownLines = (show.mock.calls[0][0] as any).lines.map((l: any) => l.description)
    expect(shownLines.some((d: string) => /RV site/.test(d))).toBe(false)
    expect(shownLines[0]).toBe('Propane (20 lb)')

    // The stay alone, with no site: nothing to show — the reader is cleared, never shown $0 or a made-up figure.
    show.mockClear()
    const alone = await put([stayCartLine(f)])
    expect(alone.status, JSON.stringify(alone.body)).toBe(200)
    expect(alone.body.data).toMatchObject({ shown: false, stayNotPriced: true })
    expect(show).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalled()

    // Picked: the stay shows at what its nights cost.
    const picked = await put([onSite(f)])
    expect(picked.body.data).toMatchObject({ shown: true, totalCents: Math.round(payLinkCharge(258.72).charged * 100) })
    expect((show.mock.calls[0][0] as any).lines[0].description).toMatch(/^RV site — nightly — 7 nights at site RV 02/)
  })

  it('a stay link goes out only at the figure the register showed — a figure the site\'s rates no longer give is refused before anything is held or sent', async () => {
    const f = await seed()
    await park(f)
    const send = (stayTotal: number) => sendLink(f, {
      items: [stayCartLine(f, { stayTotal })],
      stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev' } })
    // The register showed $313.60 (a screen from before 10/6); the stay is $258.72 now.
    const stale = await send(313.6)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('This stay — 7 nights at site RV 02 (Jun 1 → Jun 8) — charged at the weekly rate, the lower price — comes to $258.72 now — the register shows something else, and nothing was sent. '
      + 'Press Cancel, tap the site and dates above Charge, press Use this site, then press Email a pay link again.')
    expect(await query(`SELECT 1 FROM pos_pay_links WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
    expect(await query(`SELECT 1 FROM unit_bookings WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
    expect(h.emailPayLinkMock).not.toHaveBeenCalled()
    const ok = await send(258.72)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(258.72)
  })
})

// ── 10/3 (review, third pass) ──────────────────────────────────────────────

describe('10/3 (review) Adjust on a link whose reservation is over says what Adjust did — nothing changed — with a step Adjust has', () => {
  it('paid, then cancelled on the schedule: Save changes is refused in its own words; the link and its card page are untouched', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const page = await openPage(link)
    h.expireMock.mockClear()
    const adjust = async () => request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth(f))
      .send({ items: [...(await linkById(link.id)).items, propaneLine(f)] })
    await query(`UPDATE unit_bookings SET balance_paid_at = NOW() WHERE id = $1`, [link.bookingId])
    const paid = await adjust()
    expect(paid.status).toBe(409)
    expect(paid.body.error).toBe('That reservation is already paid — nothing was changed. Close the link under Pay Links.')
    await query(`UPDATE unit_bookings SET balance_paid_at = NULL, status = 'cancelled' WHERE id = $1`, [link.bookingId])
    const gone = await adjust()
    expect(gone.status).toBe(409)
    expect(gone.body.error).toBe('The reservation on this pay link was canceled on the schedule — nothing was changed. '
      + 'Close the link under Pay Links; if they still want to stay, ring the stay fresh with a site and dates.')
    for (const r of [paid, gone]) expect(r.body.error).not.toMatch(/Press Clear|nothing was charged/)
    expect(await linkRow(link.id)).toEqual({ status: 'open', last_checkout_session_id: page })
    expect(Number((await linkById(link.id)).total)).toBe(80)
    expect(h.expireMock).not.toHaveBeenCalled()
  })
})

describe('10/3 (review) a stay link paid for more than its reservation owed: the landlord is told to keep it open, never to close it', () => {
  it('paid after the schedule repriced the stay down: held; the notice says the link holds the stay, what it asks now, and Send again', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    await openPage(link)
    await query(`UPDATE unit_bookings SET total_amount = 60 WHERE id = $1`, [link.bookingId])
    const late = await paidOnline(await linkById(link.id), 'pi_stay_repriced_down')
    expect(late).toMatchObject({ recorded: false, reason: 'more than owed' })
    const told = await noticesOf(f, 'pay_link_over_owed')
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/This link holds their reservation, so keep it open \(closing it cancels the stay\)\. It now asks the \$60\.00 still owed\. Once the refund is under way, press Send again on it under Pay Links, or take it at the counter\.$/)
    expect(told[0].body).not.toMatch(/send a new link|close this link/i)
    // And that is true: still open, the stay still held, listed at what it owes — and Send again sends that.
    expect((await linkRow(link.id)).status).toBe('open')
    expect((await bookingRow(link.bookingId)).status).toBe('tentative')
    const listed = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth(f))).body.data.find((r: any) => r.id === link.id)
    expect(Number(listed.total)).toBe(60)
    const resent = await request(app()).post(`/api/pos/pay-links/${link.id}/resend`).set(auth(f))
    expect(resent.status, JSON.stringify(resent.body)).toBe(200)
    expect(h.emailPayLinkMock.mock.calls.at(-1)![0]).toMatchObject({ amount: 60 })
  })
})

// 10/3 (review): the notice's "keep it open (closing it cancels the stay)"
// only when Close really would — the same test the Pay Links row and Close use
// (stayCloseCancels). A stay link whose booking another payment already
// confirmed is an ordinary open link: closing it cancels nothing.
describe('10/3 (review) a held payment on a stay link whose booking is already confirmed: the notice never says closing it cancels the stay', () => {
  it('a $30 deposit link paid first confirms the booking; the $80 stay link paid after is held — told the plain open-link words, and Close cancels nothing', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    await openPage(link)
    const deposit = (await sendLink(f, { bookingId: link.bookingId, items: [{ id: null, name: 'Deposit', qty: 1, price: 30, tax: 0 }] })).body.data
    expect(await paidOnline(await linkById(deposit.id), 'pi_p1_deposit')).toEqual({ recorded: true })
    expect((await bookingRow(link.bookingId)).status).toBe('confirmed')
    const late = await paidOnline(await linkById(link.id), 'pi_p1_stay', payLinkCharge(80).charged)
    expect(late).toMatchObject({ recorded: false, reason: 'more than owed' })
    expect(await heldRows(f)).toEqual([expect.objectContaining({ reason: 'over_owed', status: 'held', amount: payLinkCharge(80).charged })])
    const told = await noticesOf(f, 'pay_link_over_owed')
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/This link is still open and now asks the \$50\.00 still owed\. Once the refund is under way, press Send again on it under Pay Links, or take it at the counter\.$/)
    expect(told[0].body).not.toMatch(/holds their reservation|cancels the stay|cancel the stay/)
    // And that is what the Pay Links row and Close say: nothing to cancel.
    const listed = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth(f))).body.data.find((r: any) => r.id === link.id)
    expect(listed.holdsStay ?? null).toBeNull()
    expect(Number(listed.total)).toBe(50)
    const closed = await request(app()).post(`/api/pos/pay-links/${link.id}/cancel`).set(auth(f))
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect(closed.body.data).toEqual({ stayCancelled: false })
    expect((await bookingRow(link.bookingId)).status).toBe('confirmed')
  })

  it('a stay link for part of a long stay\'s deposit, the booking confirmed on the schedule: told the link is still open and asks the whole deposit — never that closing it cancels the stay', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const page = await openPage(link)
    await query(`UPDATE unit_bookings SET source = 'direct', status = 'confirmed', check_out = '2027-07-06', nights = 35, total_amount = 1400, deposit_amount = 500, stay_terms = 'lease' WHERE id = $1`, [link.bookingId])
    const late = await paidOnline({ ...(await linkById(link.id)), last_checkout_session_id: page }, 'pi_p1_part_deposit')
    expect(late).toMatchObject({ recorded: false, reason: 'part of a long stay\'s deposit' })
    const told = await noticesOf(f, 'pay_link_deposit_part')
    expect(told).toHaveLength(1)
    expect(told[0].body).toMatch(/do not pay it back from the drawer\. This link is still open and now asks the whole \$500\.00 deposit\. Once the refund is under way, press Send again on it under Pay Links, or take the \$500\.00 at the counter\.$/)
    expect(told[0].body).not.toMatch(/holds their reservation|cancel the stay|close this link/i)
    const listed = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth(f))).body.data.find((r: any) => r.id === link.id)
    expect(listed.holdsStay ?? null).toBeNull()
    expect(Number(listed.total)).toBe(500)
    const closed = await request(app()).post(`/api/pos/pay-links/${link.id}/cancel`).set(auth(f))
    expect(closed.body.data).toEqual({ stayCancelled: false })
    expect((await bookingRow(link.bookingId)).status).toBe('confirmed')
  })
})

describe('10/3 (review) Close on a link that holds a stay cancels the reservation — the Pay Links row says so first, and Close says it did', () => {
  it('only a link holding its own unpaid hold is flagged; Close reports whether a reservation went with it', async () => {
    const f = await seed()
    const stay = (await stayLink(f, 2)).body.data
    const paidStay = (await stayLink(f, 2, { stay: { unitId: f.sites[1], checkIn: '2027-07-01', guestName: 'Sam Stay', guestEmail: 's@t.dev' } })).body.data
    await query(`UPDATE unit_bookings SET status = 'confirmed', deposit_amount = 80, deposit_paid_at = NOW() WHERE id = $1`, [paidStay.bookingId])
    const plain = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const b = await heldBooking(f, f.sites[1], 280)
    const toward = await typedLink(f, b, 'Toward the stay', 100)
    const rows = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth(f))).body.data
    expect(Object.fromEntries(rows.map((r: any) => [r.id, r.holdsStay ?? null]))).toEqual({
      [stay.id]: { guest: 'Gina Guest', site: 'RV 01', dates: 'Jun 1 → Jun 3' },
      [paidStay.id]: null, [plain.id]: null, [toward.id]: null,
    })
    const close = (id: string) => request(app()).post(`/api/pos/pay-links/${id}/cancel`).set(auth(f))
    const closed = await close(stay.id)
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect(closed.body.data).toEqual({ stayCancelled: true })
    expect((await bookingRow(stay.bookingId)).status).toBe('cancelled')
    for (const id of [paidStay.id, plain.id, toward.id]) expect((await close(id)).body.data).toEqual({ stayCancelled: false })
    expect((await bookingRow(paidStay.bookingId)).status).toBe('confirmed')
    expect((await bookingRow(b)).status).toBe('tentative')
  })
})

describe('10/3 (review) Stripe\'s kept fee is recorded even when Stripe could not say before the refund; a list load asks for a few, recent, side by side', () => {
  it('Stripe cannot say before the refund but can after: the fee is read again and recorded for the payout', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const held = await paidOnline(await linkById(link.id), 'pi_fee_after', 3.5)
    expect(held).toMatchObject({ recorded: false, reason: 'amount mismatch' })
    h.piRetrieveMock.mockClear()
    h.piRetrieveMock.mockRejectedValueOnce(new Error('not yet'))
    const done = await request(app()).post(`/api/pos/held-payments/${held.heldPaymentId}/refund`).set(auth(f))
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data).toMatchObject({ refunded: true, stripeFeeKept: 0.37 })
    expect(h.piRetrieveMock).toHaveBeenCalledTimes(2)
    expect((await query<any>(`SELECT stripe_fee_kept::float AS fee FROM pos_held_payments WHERE id = $1`, [held.heldPaymentId]))[0].fee).toBe(0.37)
  })

  it('a Pay Links load asks Stripe about five held payments at most, only ones held in the last two weeks, and never again once recorded', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const ids: string[] = []
    for (let n = 1; n <= 7; n++) {
      const r = await paidOnline(await linkById(link.id), `pi_cap_${n}`, 3 + n / 100)
      expect(r).toMatchObject({ recorded: false, reason: 'amount mismatch' })
      ids.push(r.heldPaymentId!)
    }
    await query(`UPDATE pos_held_payments SET created_at = NOW() - INTERVAL '20 days' WHERE id = $1`, [ids[0]])
    h.piRetrieveMock.mockClear()
    const load = () => request(app()).get('/api/pos/held-payments').set(auth(f))
    expect((await load()).body.data).toHaveLength(7)
    expect(h.piRetrieveMock).toHaveBeenCalledTimes(5)
    await load()
    expect(h.piRetrieveMock).toHaveBeenCalledTimes(6)
    const asked = h.piRetrieveMock.mock.calls.map((c) => c[0])
    expect(asked).not.toContain('pi_cap_1')
    expect(new Set(asked).size).toBe(6)
    await load()
    expect(h.piRetrieveMock).toHaveBeenCalledTimes(6)
  })
})

// ── 10/3 (review, third pass): the six register changes, each proved ───────

const feeLines = async (f: F) => query<any>(
  `SELECT landlord_id, business_id, source_type, source_id, amount::float AS amount, payout_intent_id
     FROM held_payout_items WHERE landlord_id = $1 ORDER BY created_at`, [f.landlordId])
const refundHeld = (f: F, id: string) => request(app()).post(`/api/pos/held-payments/${id}/refund`).set(auth(f))

describe('10/3 (decisions #22) Stripe\'s kept fee rides the landlord\'s next payout as ONE negative line, written with the refunded mark', () => {
  it('refunded: one -$0.37 line, the landlord\'s, keyed on Stripe\'s refund; pressed again, still one; pressed twice at once, still one', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const held = await paidOnline(await linkById(link.id), 'pi_fee_line', 3.5)
    expect(held).toMatchObject({ recorded: false, reason: 'amount mismatch' })
    const done = await refundHeld(f, held.heldPaymentId!)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data).toMatchObject({ refunded: true, stripeFeeKept: 0.37 })
    expect(await feeLines(f)).toEqual([{ landlord_id: f.landlordId, business_id: null, source_type: 'refund',
      source_id: 're_pi_fee_line', amount: -0.37, payout_intent_id: null }])
    // Pressed again: nothing new at Stripe, nothing new on the payout.
    const again = await refundHeld(f, held.heldPaymentId!)
    expect(again.body.data).toMatchObject({ refunded: true, already: true })
    expect(h.refundsMock).toHaveBeenCalledTimes(1)
    expect(await feeLines(f)).toHaveLength(1)
    // Two presses at the same moment (two tabs): one refund mark, one line.
    const other = await paidOnline(await linkById(link.id), 'pi_fee_twice', 2.5)
    const both = await Promise.all([refundHeld(f, other.heldPaymentId!), refundHeld(f, other.heldPaymentId!)])
    expect(both.map((r) => r.status)).toEqual([200, 200])
    expect((await feeLines(f)).filter((l: any) => l.source_id === 're_pi_fee_twice')).toEqual([
      expect.objectContaining({ amount: -0.37, source_type: 'refund', landlord_id: f.landlordId })])
    expect(await feeLines(f)).toHaveLength(2)
  })

  it('a refund recorded before the fee line existed gets its one line on the next press, never two; no fee known, no line', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const old = await paidOnline(await linkById(link.id), 'pi_fee_old', 3.5)
    await query(`UPDATE pos_held_payments SET status = 'refunded', refunded_at = NOW(), stripe_refund_id = 're_old_one', stripe_fee_kept = 0.37 WHERE id = $1`,
      [old.heldPaymentId])
    const unknown = await paidOnline(await linkById(link.id), 'pi_fee_none', 2.5)
    await query(`UPDATE pos_held_payments SET status = 'refunded', refunded_at = NOW(), stripe_refund_id = 're_no_fee', stripe_fee_kept = NULL WHERE id = $1`,
      [unknown.heldPaymentId])
    for (let n = 0; n < 2; n++) {
      const r = await refundHeld(f, old.heldPaymentId!)
      expect(r.body.data).toMatchObject({ refunded: true, already: true, stripeFeeKept: 0.37 })
      expect((await refundHeld(f, unknown.heldPaymentId!)).body.data).toMatchObject({ already: true, stripeFeeKept: null })
    }
    expect(h.refundsMock).not.toHaveBeenCalled()
    expect(await feeLines(f)).toEqual([expect.objectContaining({ source_id: 're_old_one', amount: -0.37 })])
  })

  it('the line and the refunded mark commit together: the line cannot be written → the payment stays held; pressed again (Stripe\'s same refund) both land', async () => {
    const f = await seed()
    const link = (await sendLink(f, { items: [propaneLine(f)] })).body.data
    const held = await paidOnline(await linkById(link.id), 'pi_fee_atomic', 3.5)
    await query(`CREATE OR REPLACE FUNCTION test_refuse_fee_line() RETURNS trigger LANGUAGE plpgsql AS $$
                   BEGIN IF NEW.source_id = 're_pi_fee_atomic' THEN RAISE EXCEPTION 'test: the fee line cannot be written'; END IF; RETURN NEW; END $$`)
    await query(`CREATE TRIGGER test_refuse_fee_line BEFORE INSERT ON held_payout_items FOR EACH ROW EXECUTE FUNCTION test_refuse_fee_line()`)
    try {
      const failed = await refundHeld(f, held.heldPaymentId!)
      expect(failed.status).toBe(500)
      expect((await query<any>(`SELECT status, stripe_refund_id FROM pos_held_payments WHERE id = $1`, [held.heldPaymentId]))[0])
        .toEqual({ status: 'held', stripe_refund_id: null })
      expect(await feeLines(f)).toEqual([])
    } finally {
      await query(`DROP TRIGGER IF EXISTS test_refuse_fee_line ON held_payout_items`)
      await query(`DROP FUNCTION IF EXISTS test_refuse_fee_line()`)
    }
    const again = await refundHeld(f, held.heldPaymentId!)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(h.refundsMock).toHaveBeenCalledTimes(2)
    expect(h.refundsMock.mock.calls.map((c) => c[1])).toEqual([
      { idempotencyKey: `pos-held-refund-${held.heldPaymentId}` }, { idempotencyKey: `pos-held-refund-${held.heldPaymentId}` }])
    expect((await query<any>(`SELECT status FROM pos_held_payments WHERE id = $1`, [held.heldPaymentId]))[0].status).toBe('refunded')
    expect(await feeLines(f)).toEqual([expect.objectContaining({ source_id: 're_pi_fee_atomic', amount: -0.37 })])
  })
})

const siteList = (f: F, checkIn: string, nights: number) => request(app())
  .get(`/api/pos/stays/available?propertyId=${f.propertyId}&checkIn=${checkIn}&stayUnit=night&qty=${nights}`).set(auth(f))
const listed = async (f: F, checkIn: string, nights: number) => {
  const r = await siteList(f, checkIn, nights)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.data.units.map((u: any) => [u.unitNumber, u.heldByUnpaidHold])
}
/**
 * The schedule lengthens the link's hold to a long stay and a lease is chosen for it — 10/5 (Nic, R3):
 * never drafted by length alone, only when lease was chosen (services/stayTerms draftLeaseFromStay).
 */
async function lengthenToLongStay(bookingId: string, checkOut = '2027-07-01') {
  await query(`UPDATE unit_bookings SET check_out = $2::date, nights = ($2::date - check_in) WHERE id = $1`, [bookingId, checkOut])
  const { draftLeaseFromStay } = await import('../services/stayTerms')
  const d = await draftLeaseFromStay(bookingId)
  expect(d.drafted).toBe(true)
  return d.leaseId!
}
const leaseOf = async (leaseId: string) => (await query<any>(`SELECT status, unit_id FROM leases WHERE id = $1`, [leaseId]))[0]

describe('10/3 (review) Close on a stay link lets go of the hold AND the unsigned lease drafted from it — the site is offered again', () => {
  it('a hold lengthened to a long stay: Close terminates its drafted lease, cancels the hold, and the site is listed (and can be sent) again', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const leaseId = await lengthenToLongStay(link.bookingId)
    expect(await leaseOf(leaseId)).toEqual({ status: 'pending', unit_id: f.sites[0] })
    const closed = await request(app()).post(`/api/pos/pay-links/${link.id}/cancel`).set(auth(f))
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect(closed.body.data).toEqual({ stayCancelled: true })
    expect((await bookingRow(link.bookingId)).status).toBe('cancelled')
    expect((await leaseOf(leaseId)).status).toBe('terminated')
    // The site is free again for those 30 nights — listed, and not as held.
    expect(await listed(f, '2027-06-01', 30)).toEqual([['RV 01', false], ['RV 02', false]])
    // And a new link can take it (a pending lease left behind would refuse it).
    // 10/5 (Nic): 30 nights need the counter's answer (R2) and, with no check
    // on file, carry the background check's fee as the register showed it (R8).
    const { stayNeeds } = await import('../services/stayTerms')
    const needs = await stayNeeds({ landlordId: f.landlordId, propertyId: f.propertyId, email: 'gina@t.dev', checkIn: '2027-06-01', checkOut: '2027-07-01' })
    const next = await stayLink(f, 30, { stay: { unitId: f.sites[0], checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev',
                                                  stayTerms: 'stay', screeningFee: needs.screeningFee?.amount ?? null } })
    expect(next.status, JSON.stringify(next.body)).toBe(201)
  })

  it('a signed lease is never touched by Close, and neither is the lease of a hold that is already paid', async () => {
    const f = await seed()
    const signed = (await stayLink(f, 2)).body.data
    const signedLease = await lengthenToLongStay(signed.bookingId)
    await query(`UPDATE leases SET status = 'active' WHERE id = $1`, [signedLease])
    const paid = (await stayLink(f, 2, { stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Sam Stay', guestEmail: 's@t.dev' } })).body.data
    const paidLease = await lengthenToLongStay(paid.bookingId)
    await query(`UPDATE unit_bookings SET status = 'confirmed', deposit_amount = 80, deposit_paid_at = NOW() WHERE id = $1`, [paid.bookingId])
    const close = (id: string) => request(app()).post(`/api/pos/pay-links/${id}/cancel`).set(auth(f))
    expect((await close(signed.id)).body.data).toEqual({ stayCancelled: true })
    expect((await leaseOf(signedLease)).status).toBe('active')
    expect((await close(paid.id)).body.data).toEqual({ stayCancelled: false })
    expect((await leaseOf(paidLease)).status).toBe('pending')
    expect((await bookingRow(paid.bookingId)).status).toBe('confirmed')
  })
})

const refundSale = (f: F, saleId: string, body: any = {}) =>
  request(app()).post(`/api/pos/transactions/${saleId}/refund`).set(auth(f)).send({ reason: 'Not staying', ...body })
const stayCartLine2 = (f: F, nights = 2) => ({ id: f.stayItem, name: 'RV site — nightly', qty: nights, price: 40, tax: 0.1 })

describe('10/3 (review, decisions #23) a refund says what to hand back, and whether a reservation is still on the schedule', () => {
  it('a plain sale: no reservation; a stay rung here: still on the schedule — until it is canceled there', async () => {
    const f = await seed()
    const plain = await settleAtCounter(f, { items: [propaneLine(f)] })
    expect(plain.status, JSON.stringify(plain.body)).toBe(201)
    const r1 = await refundSale(f, plain.body.data.id)
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(r1.body.data).toEqual({ refundAmount: 22, refundMethod: 'cash', reservationStillOnSchedule: false })

    const stay = await settleAtCounter(f, { items: [stayCartLine2(f)], stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Walk In' } })
    expect(stay.status, JSON.stringify(stay.body)).toBe(201)
    const r2 = await refundSale(f, stay.body.data.id, { amount: 30, refundMethod: 'check' })
    expect(r2.body.data).toEqual({ refundAmount: 30, refundMethod: 'check', reservationStillOnSchedule: true })
    // A refund never touches the reservation (decisions #23).
    expect((await bookingRow(stay.body.data.stayBooking.bookingId)).status).toBe('confirmed')
    // A stay that is over (checked out) is no reservation to cancel — nothing to say.
    await query(`UPDATE unit_bookings SET status = 'checked_out' WHERE id = $1`, [stay.body.data.stayBooking.bookingId])
    expect((await refundSale(f, stay.body.data.id, { amount: 20 })).body.data.reservationStillOnSchedule).toBe(false)
    await query(`UPDATE unit_bookings SET status = 'cancelled' WHERE id = $1`, [stay.body.data.stayBooking.bookingId])
    const r3 = await refundSale(f, stay.body.data.id, { amount: 30 })
    expect(r3.body.data).toEqual({ refundAmount: 30, refundMethod: 'cash', reservationStillOnSchedule: false })
  })

  it('a stay link and a reservation ticket settled at the counter: still on the schedule; one marked a no-show: not', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const openedLink = await request(app()).get(`/api/pos/tickets/${link.id}?propertyId=${f.propertyId}&kind=pay_link`).set(auth(f))
    const viaLink = await settleAtCounter(f, { items: openedLink.body.data.items, payLinkId: link.id })
    expect(viaLink.status, JSON.stringify(viaLink.body)).toBe(201)
    expect((await refundSale(f, viaLink.body.data.id, { amount: 10 })).body.data.reservationStillOnSchedule).toBe(true)

    const b = await heldBooking(f, f.sites[1], 280)
    const ticket = await reservationTicket(f, b)
    const openedTicket = await request(app()).get(`/api/pos/tickets/${ticket}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))
    const viaTicket = await settleAtCounter(f, { items: openedTicket.body.data.items, openTicketId: ticket })
    expect(viaTicket.status, JSON.stringify(viaTicket.body)).toBe(201)
    expect((await refundSale(f, viaTicket.body.data.id, { amount: 10 })).body.data.reservationStillOnSchedule).toBe(true)
    await query(`UPDATE unit_bookings SET status = 'no_show' WHERE id = ANY($1::uuid[])`, [[b, link.bookingId]])
    expect((await refundSale(f, viaTicket.body.data.id, { amount: 10 })).body.data.reservationStillOnSchedule).toBe(false)
    expect((await refundSale(f, viaLink.body.data.id, { amount: 10 })).body.data.reservationStillOnSchedule).toBe(false)
  })
})

describe('10/3 (review) a stay link\'s hold and the link are written in ONE transaction; the email goes after it commits', () => {
  it('a link that cannot be written leaves no hold behind and sends nothing — the site is free for the next link', async () => {
    const f = await seed()
    await query(`CREATE OR REPLACE FUNCTION test_refuse_pay_link() RETURNS trigger LANGUAGE plpgsql AS $$
                   BEGIN IF NEW.customer_email = 'boom@t.dev' THEN RAISE EXCEPTION 'test: the link cannot be written'; END IF; RETURN NEW; END $$`)
    await query(`CREATE TRIGGER test_refuse_pay_link BEFORE INSERT ON pos_pay_links FOR EACH ROW EXECUTE FUNCTION test_refuse_pay_link()`)
    try {
      const failed = await stayLink(f, 2, { customer: { name: 'Pat Payer', email: 'boom@t.dev' } })
      expect(failed.status).toBe(500)
      expect(await query(`SELECT 1 FROM unit_bookings WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
      expect(await query(`SELECT 1 FROM pos_pay_links WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
      expect(h.emailPayLinkMock).not.toHaveBeenCalled()
    } finally {
      await query(`DROP TRIGGER IF EXISTS test_refuse_pay_link ON pos_pay_links`)
      await query(`DROP FUNCTION IF EXISTS test_refuse_pay_link()`)
    }
    expect(await listed(f, '2027-06-01', 2)).toEqual([['RV 01', false], ['RV 02', false]])
    const ok = await stayLink(f, 2)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect((await bookingRow(ok.body.data.bookingId)).status).toBe('tentative')
  })

  it('when the email goes out, the link and its hold are already on the books (seen from another connection); a failed email undoes nothing', async () => {
    const f = await seed()
    const seen: any[] = []
    h.emailPayLinkMock.mockImplementationOnce(async (a: any) => {
      seen.push((await query<any>(
        `SELECT l.status AS link, b.status AS hold FROM pos_pay_links l JOIN unit_bookings b ON b.id = l.booking_id WHERE l.id = $1`,
        [a.ctx.payLinkId]))[0] ?? null)
    })
    const ok = await stayLink(f, 2)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(seen).toEqual([{ link: 'open', hold: 'tentative' }])
    h.emailPayLinkMock.mockRejectedValueOnce(new Error('resend down'))
    const second = await stayLink(f, 2, { stay: { unitId: f.sites[1], checkIn: '2027-06-01', guestName: 'Sam Stay', guestEmail: 's@t.dev' } })
    expect(second.status, JSON.stringify(second.body)).toBe(201)
    expect((await linkRow(second.body.data.id)).status).toBe('open')
    expect((await bookingRow(second.body.data.bookingId)).status).toBe('tentative')
  })
})

/** Another site at the property, with something (or nothing) on it for Jun 1 → Jun 3. */
async function siteWith(f: F, unitNumber: string, booking?: { status: string; paid: boolean; displaced?: boolean; expired?: boolean }) {
  const unitId = (await query<{ id: string }>(
    `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, is_bookable)
     VALUES ($1,$2,$3,'vacant',500,'rv_spot',40,TRUE) RETURNING id`, [f.propertyId, f.landlordId, unitNumber]))[0].id
  if (booking) {
    await query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, status, total_amount, guest_name,
                                  deposit_paid_at, displaced_at, hold_expires_at)
       VALUES ($1,$2,'nightly','2027-06-01','2027-06-03',2,$3,80,'Someone',
               CASE WHEN $4 THEN NOW() END, CASE WHEN $5 THEN NOW() END, CASE WHEN $6 THEN NOW() - INTERVAL '1 hour' END)`,
      [unitId, f.landlordId, booking.status, booking.paid, !!booking.displaced, !!booking.expired])
  }
  return unitId
}

describe('10/3 (S652: an unpaid hold yields to anyone who pays) what the counter is offered, and what a pay link may take', () => {
  it('a site held only by an unpaid hold is listed LAST and flagged; anything paid, confirmed or already moved once stays hidden', async () => {
    const f = await seed()
    expect((await stayLink(f, 2)).status).toBe(201)                       // RV 01: an unpaid hold
    await siteWith(f, 'RV 03', { status: 'confirmed', paid: true })        // paid and confirmed: hidden
    await siteWith(f, 'RV 04', { status: 'tentative', paid: true })        // a deposit taken: hidden, whatever its status
    await siteWith(f, 'RV 05', { status: 'tentative', paid: false, displaced: true })   // moved once already: hidden
    await siteWith(f, 'RV 06', { status: 'tentative', paid: false, expired: true })     // a lapsed booking-site hold: free
    await siteWith(f, 'RV 07', { status: 'cancelled', paid: false })       // canceled: free
    expect(await listed(f, '2027-06-01', 2)).toEqual([
      ['RV 02', false], ['RV 06', false], ['RV 07', false], ['RV 01', true]])
    // Other dates: the hold is not in the way, so RV 01 is just another free site.
    expect((await listed(f, '2027-06-10', 2))[0]).toEqual(['RV 01', false])
  })

  it('a pay link cannot take a site an unpaid hold is on — refused in plain words, nothing held or sent', async () => {
    const f = await seed()
    expect((await stayLink(f, 2)).status).toBe(201)
    h.emailPayLinkMock.mockClear()
    const refused = await stayLink(f, 3, { stay: { unitId: f.sites[0], checkIn: '2027-06-02', guestName: 'Sam Stay', guestEmail: 's@t.dev' } })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('That site is not free for those dates — it is taken or someone is holding it, and a pay link cannot move a hold (only a payment can). '
      + 'Pick another site or other dates, then press Send link again — or charge for it here at the counter.')
    expect(await query(`SELECT 1 FROM unit_bookings WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(1)
    expect(await query(`SELECT 1 FROM pos_pay_links WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(1)
    expect(h.emailPayLinkMock).not.toHaveBeenCalled()
  })
})

const walkIn = (f: F, unitId: string, nights = 2, checkIn = '2027-06-01') =>
  settleAtCounter(f, { items: [stayCartLine2(f, nights)], stay: { unitId, checkIn, guestName: 'Walk In', guestEmail: 'walk@t.dev' } })
const holdRow = async (id: string) => (await query<any>(
  `SELECT unit_id, status, displaced_from_unit, displaced_reason, displaced_at FROM unit_bookings WHERE id = $1`, [id]))[0]

describe('10/3 (S652) a stay rung at the counter on a site an unpaid hold is on — the hold yields to the payment', () => {
  it('the hold moves to an equivalent free site (its link still pays it), the sale and its booking are recorded, and the guest is told once', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const sale = await walkIn(f, f.sites[0])
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBe(80)
    const mine = await query<any>(`SELECT unit_id, status, pos_transaction_id FROM unit_bookings WHERE id = $1`, [sale.body.data.stayBooking.bookingId])
    expect(mine).toEqual([{ unit_id: f.sites[0], status: 'confirmed', pos_transaction_id: sale.body.data.id }])
    expect(await holdRow(link.bookingId)).toMatchObject({ unit_id: f.sites[1], status: 'tentative', displaced_from_unit: f.sites[0] })
    expect((await linkRow(link.id)).status).toBe('open')
    expect(h.siteChangedMock).toHaveBeenCalledTimes(1)
    expect(h.siteChangedMock.mock.calls[0].slice(0, 5)).toEqual(['gina@t.dev', 'Gina Guest', expect.any(String), 'RV 01', 'RV 02'])
    const moved = await noticesOf(f, 'booking_moved')
    expect(moved).toHaveLength(1)
    expect(moved[0].title).toBe('Gina Guest moved to site RV 02')
    expect(moved[0].body).toMatch(/Their pay link still works — it now pays for site RV 02; nothing to resend\./)
    expect(await noticesOf(f, 'booking_displaced')).toHaveLength(0)
    expect(await sales(f)).toHaveLength(1)
  })

  it('the park is full: the hold is canceled, its link and card page closed, the landlord told once to call — never the guest — and the sale goes through', async () => {
    const f = await seed()
    await query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, status, total_amount, guest_name, deposit_paid_at)
       VALUES ($1,$2,'nightly','2027-05-30','2027-06-05',6,'confirmed',240,'Paid Already',NOW())`, [f.sites[1], f.landlordId])
    const link = (await stayLink(f, 2)).body.data
    const page = await openPage(link)
    const sale = await walkIn(f, f.sites[0])
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    const hold = await holdRow(link.bookingId)
    expect(hold).toMatchObject({ unit_id: f.sites[0], status: 'cancelled' })
    expect(hold.displaced_reason).toMatch(/A paid sale at the counter took this site — the property had nothing else free for those dates/)
    expect((await linkRow(link.id)).status).toBe('cancelled')
    expect(h.pages.get(page)).toBe('expired')
    const lost = await noticesOf(f, 'booking_displaced')
    expect(lost).toHaveLength(1)
    expect(lost[0].title).toBe('Gina Guest lost site RV 01 — call them')
    expect(lost[0].body).toMatch(/Their unpaid pay link was closed, so it can no longer be paid\./)
    expect(h.siteChangedMock).not.toHaveBeenCalled()
    expect(await sales(f)).toHaveLength(1)
  })

  it('a sale that is refused after the hold was moved rolls the move back — nobody is told, nothing is charged', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data      // Jun 1 → Jun 3 on RV 01
    await query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, status, total_amount, guest_name, deposit_paid_at)
       VALUES ($1,$2,'nightly','2027-06-03','2027-06-05',2,'confirmed',80,'Paid Already',NOW())`, [f.sites[0], f.landlordId])
    const refused = await walkIn(f, f.sites[0], 4)      // Jun 1 → Jun 5: the paid nights are in the way
    expect(refused.status).toBe(409)
    expect(await holdRow(link.bookingId)).toMatchObject({ unit_id: f.sites[0], status: 'tentative', displaced_at: null })
    expect(h.siteChangedMock).not.toHaveBeenCalled()
    expect(await noticesOf(f, 'booking_moved')).toHaveLength(0)
    expect(await sales(f)).toHaveLength(0)
  })

  it('a long-stay hold (its lease drafted) is offered too, flagged — sold here, the hold and its unsigned lease move together', async () => {
    const f = await seed()
    const link = (await stayLink(f, 2)).body.data
    const leaseId = await lengthenToLongStay(link.bookingId)            // Jun 1 → Jul 1 on RV 01
    expect(await listed(f, '2027-06-01', 2)).toEqual([['RV 02', false], ['RV 01', true]])
    const sale = await walkIn(f, f.sites[0])
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(await holdRow(link.bookingId)).toMatchObject({ unit_id: f.sites[1], status: 'tentative' })
    expect(await leaseOf(leaseId)).toEqual({ status: 'pending', unit_id: f.sites[1] })
    expect(h.siteChangedMock).toHaveBeenCalledTimes(1)
  })
})

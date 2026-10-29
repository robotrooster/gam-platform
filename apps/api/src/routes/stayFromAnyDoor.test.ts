/**
 * 10/17 (Nic) — A STAY SOLD ANYWHERE LANDS ON THE MASTER SCHEDULE, AND A
 * RESERVATION CAN TAKE MONEY.
 *
 *   "when I go to add a reservation, it won't generate a pay link from doing the
 *    reservation... somebody paid for a week, um, and it did not generate a stay
 *    to occupy a site. So we have some important things to address there before
 *    the schedule starts getting convoluted."
 *
 * Four rules, from his own answers, each one a case below:
 *
 *   1. A reservation routed to a DEPOSIT LINK comes back with the link, and one
 *      routed to the REGISTER comes back with a ticket that already carries the
 *      stay — so the cashier only presses Charge ("would it be difficult to send
 *      the ticket to pos so its already made by creating the stay?").
 *   2. A stay on a pay link does not wait for the clerk to pick a site: "the
 *      system can assign it but may move it as needed for compression." The site
 *      comes off the board when the link is SENT, and the GUEST is never told
 *      which one — "no site details given to the customer until morning of
 *      arrival."
 *   3. "reservations are only locked in with deposits. still reserved without
 *      deposits but can be booted when space is limited by other paying people."
 *   4. A paid week whose guest never shows holds the whole week; the site frees
 *      itself after the last night and the money stays earned.
 *
 * Stripe and the emails are mocked; everything else is the real route.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  checkoutMock: vi.fn(async (_p: any) => ({ id: `cs_test_${Math.random().toString(36).slice(2)}`, url: 'https://checkout.stripe.test/x' })),
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
  guestAccessMock: vi.fn(async (..._a: any[]) => undefined),
  // 10/17: the receipt the guest is emailed — captured so the case below can
  // read the lines it printed.
  emailReceiptMock: vi.fn(async (..._a: any[]) => undefined),
  renderReceiptMock: vi.fn(async (_p: any) => Buffer.from('pdf')),
}))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ checkout: { sessions: { create: h.checkoutMock, retrieve: async (id: string) => ({ id, status: 'expired', payment_status: 'unpaid' }), expire: async () => undefined } } }),
}))
vi.mock('../services/stripeConnect', async (orig) => ({ ...(await orig() as any), expirePayLinkCheckoutSession: vi.fn(async () => undefined) }))
vi.mock('../services/email', async (orig) => ({ ...(await orig() as any), emailPayLink: h.emailPayLinkMock, emailPosReceipt: h.emailReceiptMock }))
vi.mock('../services/businessPdf', async (orig) => ({ ...(await orig() as any), renderPosReceiptPdf: h.renderReceiptMock }))
vi.mock('../services/bookingGuestTokens', async (orig) => ({ ...(await orig() as any), sendBookingGuestAccessEmail: h.guestAccessMock }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { posPayLinksRouter, publicPayRouter } from './posPayLinks'
import { posRouter } from './pos'
import { unitsRouter } from './units'
import { chooseFreeSite } from '../services/propertyBooking'
import { findStayConflict } from '../services/unitAvailability'
import { unpaidHoldsOn } from '../services/holdDisplacement'

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
  a.use('/api/units', unitsRouter)
  a.use('/api/public', publicPayRouter)
  a.use(errorHandler)
  return a
}

const RATES = { nightly: 49, weekly: 269, monthly: 589 }

beforeEach(async () => {
  await cleanupAllSchema()
  h.checkoutMock.mockClear(); h.emailPayLinkMock.mockClear(); h.guestAccessMock.mockClear()
  h.emailReceiptMock.mockClear(); h.renderReceiptMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stay_any_door'
})

async function seed(siteNumbers = ['RV 01', 'RV 02', 'RV 03']) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_door_' || replace($1::text,'-','') WHERE id = $1`, [landlordId])
    await c.query(
      `UPDATE properties SET booking_deposit_pct = 10, booking_monthly_deposit = 150, short_term_tax_rate = 6.35 WHERE id = $1`,
      [propertyId])
    const cat = (await c.query(`INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stays',1,TRUE) RETURNING id`, [landlordId])).rows[0].id
    const items: Record<string, string> = {}
    for (const [name, unit] of [['RV site — daily', 'night'], ['RV site — weekly', 'week'], ['RV site — monthly', 'month']]) {
      items[unit] = (await c.query(
        `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
         VALUES ($1,$2,$3,$4,0,0,0,999,0,999,$5) RETURNING id`, [landlordId, propertyId, name, cat, unit])).rows[0].id
    }
    const sites: string[] = []
    for (const n of siteNumbers) {
      // 10/17: the shape every real RV site at Mountain View and Oak Park has —
      // switched on for short stays, nightly and weekly among its allowed lease
      // types. The empty allow-list this used to seed exists nowhere in
      // production and hid the whole question of which sites GAM may pick.
      sites.push((await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, weekly_rate, monthly_rate, is_bookable, lease_types_allowed)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',$4,$5,$6,TRUE,
                 ARRAY['nightly','weekly','month_to_month','long_term']) RETURNING id`,
        [propertyId, landlordId, n, RATES.nightly, RATES.weekly, RATES.monthly])).rows[0].id)
    }
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, items, sites, siteNumbers, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type F = Awaited<ReturnType<typeof seed>>
const auth = (f: F) => ({ Authorization: `Bearer ${f.token}` })

const reserve = (f: F, unitId: string, body: Record<string, unknown>) =>
  request(app()).post(`/api/units/${unitId}/bookings`).set(auth(f)).send({
    guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev', guestPhone: '520-555-0101',
    leaseType: 'weekly', checkIn: '2027-05-01', checkOut: '2027-05-08', source: 'direct', ...body,
  })

// ── 1. A reservation can take money: the link, and the ticket ───────────────

describe('a reservation routed to the money (Nic 10/17)', () => {
  it('"Email a deposit link": the link is made, is named on the response, and holds the site unpaid', async () => {
    const f = await seed()
    const r = await reserve(f, f.sites[0], { sendDepositLink: true })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    // The screen can only say "a link was sent" if the save hands one back.
    expect(r.body.data.depositLink).toMatchObject({ url: expect.stringContaining('/api/public/pay/') })
    expect(r.body.data.registerTicketId).toBeNull()
    expect(r.body.data.status).toBe('tentative')

    const [link] = await query<any>(`SELECT label, total::float AS total, booking_id, customer_email FROM pos_pay_links WHERE booking_id = $1`, [r.body.data.id])
    // 10% of the taxed week ($269 + 6.35% = $286.08).
    expect(link).toMatchObject({ label: 'Reservation deposit', total: 28.61, customer_email: 'pat@t.dev' })
    expect(h.emailPayLinkMock).toHaveBeenCalledTimes(1)
    // Unpaid: reserved, not locked in (case 3 below).
    const [b] = await query<any>(`SELECT deposit_paid_at, deposit_amount::float AS deposit FROM unit_bookings WHERE id = $1`, [r.body.data.id])
    expect(b).toMatchObject({ deposit_paid_at: null, deposit: 28.61 })
  })

  it('"Paying at the counter": the ticket is ALREADY MADE, carries the stay line and the reservation, so the cashier only presses Charge', async () => {
    const f = await seed()
    const r = await reserve(f, f.sites[0], { payAtRegister: true })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.registerTicketId).toEqual(expect.any(String))
    expect(r.body.data.depositLink).toBeNull()

    const [t] = await query<any>(`SELECT booking_id, items, note, property_id FROM pos_open_tickets WHERE id = $1`, [r.body.data.registerTicketId])
    expect(t.booking_id).toBe(r.body.data.id)
    expect(t.property_id).toBe(f.propertyId)
    // The stay's own register button, at the quantity the week comes to — the
    // cashier types nothing.
    expect(t.items).toEqual([{ id: f.items.week, name: 'RV site — weekly', qty: 1, price: 0, tax: 0 }])
    expect(t.note).toContain('Pat Ruiz')
    expect(t.note).toContain('RV 01')
  })

  it('REGRESSION (Nic 10/17, "it won\'t generate a pay link from doing the reservation"): a save that asks for NEITHER gets neither — which is why the schedule has to send the choice', async () => {
    const f = await seed()
    const r = await reserve(f, f.sites[0], {})
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    // Confirmed on the spot, no link, no ticket. This is exactly what the
    // per-site "+ Book" form used to do on every reservation, because it passed
    // no pay route at all — the stay was real and the money never happened.
    expect(r.body.data).toMatchObject({ status: 'confirmed', depositLink: null, registerTicketId: null })
    expect(await query(`SELECT 1 FROM pos_pay_links`)).toHaveLength(0)
    expect(await query(`SELECT 1 FROM pos_open_tickets`)).toHaveLength(0)
  })

  it('a stay this park asks no deposit on sends no link, and says THAT rather than reporting a failure', async () => {
    const f = await seed()
    // A park that takes no deposit on a long stay. (A SHORT stay's percentage
    // cannot be zero — the column only allows 5/10/15/20 — so the flat
    // long-stay deposit is the reachable way to owe nothing.) The guest has
    // stayed here before, so there is no background check to collect either.
    await query(`UPDATE properties SET booking_monthly_deposit = 0 WHERE id = $1`, [f.propertyId])
    const r = await reserve(f, f.sites[0], {
      sendDepositLink: true, leaseType: 'month_to_month',
      checkIn: '2027-05-01', checkOut: '2027-06-01', stayTerms: 'stay', returningGuest: true,
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.depositLink).toBeNull()
    // The difference the screen needs: nothing was owed, so nothing broke.
    expect(r.body.data.stay.depositNothingOwed).toBe(true)
    expect(await query(`SELECT 1 FROM pos_pay_links`)).toHaveLength(0)
  })

  it('a link that WAS sent does not claim nothing was owed', async () => {
    const f = await seed()
    const r = await reserve(f, f.sites[0], { sendDepositLink: true })
    expect(r.status).toBe(201)
    expect(r.body.data.stay.depositNothingOwed).toBe(false)
  })

  it('a deposit link is never sent without the email it would go to — the stay is confirmed instead, and the screen is told so', async () => {
    const f = await seed()
    const r = await reserve(f, f.sites[0], { sendDepositLink: true, guestEmail: null })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data).toMatchObject({ status: 'confirmed', depositLink: null })
  })
})

// ── 2. A stay on a pay link: GAM picks the site, the guest is not told ──────

describe('a stay on a pay link (Nic 10/17)', () => {
  const sendStayLink = (f: F, stay: Record<string, unknown>, qty = 1, unit: 'night' | 'week' | 'month' = 'week') =>
    request(app()).post('/api/pos/pay-links').set(auth(f)).send({
      propertyId: f.propertyId, kind: 'one_time',
      customer: { name: 'Dale Carter', email: 'dale@t.dev' },
      items: [{ id: f.items[unit], name: `RV site — ${unit === 'night' ? 'daily' : unit === 'week' ? 'weekly' : 'monthly'}`, qty, price: 0, tax: 0 }],
      stay,
    })

  it('no site named: GAM picks a free one, the stay is on the schedule from the moment the link is SENT, and the money is not taken yet', async () => {
    const f = await seed()
    const sent = await sendStayLink(f, { checkIn: '2027-05-01', guestName: 'Dale Carter' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.data.bookingId).toEqual(expect.any(String))

    const [b] = await query<any>(
      `SELECT b.status, b.source, b.nights, b.total_amount::float AS total, b.deposit_paid_at, b.hold_expires_at, u.unit_number
         FROM unit_bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = $1`, [sent.body.data.bookingId])
    // The first free site, in unit-number order, so the park fills predictably.
    expect(b).toMatchObject({
      status: 'tentative', source: 'pay_link', nights: 7, total: 286.08,
      deposit_paid_at: null, hold_expires_at: null, unit_number: 'RV 01',
    })
  })

  it('"Pay link" is a source the Source filter can actually be set to (review) — every GAM door is in the one list', async () => {
    const { BOOKING_SOURCES, BOOKING_SOURCE_LABEL } = await import('@gam/shared')
    // The schedule and the reservations list FILTER on this column, so a value
    // written by one of GAM's own doors and missing from the list could be seen
    // and never filtered for. These four are those doors.
    for (const s of ['direct', 'public', 'register', 'pay_link'] as const) {
      expect(BOOKING_SOURCES).toContain(s)
      expect(BOOKING_SOURCE_LABEL[s]).toBeTruthy()
      expect(BOOKING_SOURCE_LABEL[s]).not.toMatch(/_/)   // never a raw enum on screen
    }
  })

  it('the GUEST is never told the site — the label the email and the card page print names nights and dates only', async () => {
    const f = await seed()
    const sent = await sendStayLink(f, { checkIn: '2027-05-01', guestName: 'Dale Carter' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const [link] = await query<any>(`SELECT label FROM pos_pay_links WHERE id = $1`, [sent.body.data.id])
    expect(link.label).toBe('RV site — weekly — 7 nights (May 1 → May 8)')
    expect(link.label).not.toMatch(/RV 0/)
    // And the email carries that same label, nothing else about the site.
    const emailed = h.emailPayLinkMock.mock.calls[0][0] as any
    expect(emailed.label).toBe('RV site — weekly — 7 nights (May 1 → May 8)')
    expect(JSON.stringify(emailed)).not.toMatch(/RV 0/)
  })

  it('NOR DOES THE RECEIPT (review): a receipt emailed before arrival drops the site, and prints it once the morning-of reveal has gone out', async () => {
    const f = await seed()
    // A reservation handed to the till and rung up there. The sale's stored
    // line is the one the CASHIER reads, and it names the site on purpose —
    // which is how the site reached a guest's receipt.
    const r = await reserve(f, f.sites[0], { payAtRegister: true, checkIn: '2027-05-01', checkOut: '2027-05-08' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const t = await request(app())
      .get(`/api/pos/tickets/${r.body.data.registerTicketId}?propertyId=${f.propertyId}&kind=ticket`).set(auth(f))
    expect(t.status, JSON.stringify(t.body)).toBe(200)
    const line = (t.body.data.items as any[]).find((i) => i.stay)
    expect(line.name).toContain('at site RV 01')
    const sale = await request(app()).post('/api/pos/transactions').set(auth(f)).send({
      propertyId: f.propertyId, openTicketId: r.body.data.registerTicketId, paymentMethod: 'cash',
      items: [{ id: line.id, name: line.name, qty: 1, price: line.price, tax: 0 }], amountTendered: 300,
    })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    const saleId = sale.body.data.id
    // The sale's own record keeps the site — staff read it.
    const [stored] = await query<any>(`SELECT item_name FROM pos_transaction_items WHERE transaction_id = $1`, [saleId])
    expect(stored.item_name).toContain('at site RV 01')

    const sent = await request(app()).post(`/api/pos/transactions/${saleId}/email-receipt`).set(auth(f)).send({ email: 'pat@t.dev' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    const printed = ((h.renderReceiptMock.mock.calls[0][0] as any).lines as any[]).map((l) => String(l.description))
    expect(printed.join(' | ')).not.toMatch(/at site/)
    expect(printed[0]).toContain('7 nights (May 1 → May 8)')

    // Once the site has been revealed on the morning of arrival it is theirs,
    // and a second copy of the receipt says which one.
    await query(`UPDATE unit_bookings SET site_reveal_sent_at = NOW() WHERE id = $1`, [r.body.data.id])
    h.renderReceiptMock.mockClear()
    expect((await request(app()).post(`/api/pos/transactions/${saleId}/email-receipt`).set(auth(f)).send({ email: 'pat@t.dev' })).status).toBe(200)
    expect(String((h.renderReceiptMock.mock.calls[0][0] as any).lines[0].description)).toContain('at site RV 01')
  })

  it('a clerk may still name the site when somebody was promised one, and then it is the site that is held', async () => {
    const f = await seed()
    const sent = await sendStayLink(f, { unitId: f.sites[2], checkIn: '2027-05-01', guestName: 'Dale Carter' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const [b] = await query<any>(
      `SELECT u.unit_number FROM unit_bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = $1`, [sent.body.data.bookingId])
    expect(b.unit_number).toBe('RV 03')
  })

  it('a link skips a site the counter is holding — a link is not payment, so it displaces nobody', async () => {
    const f = await seed()
    // RV 01 taken for those nights by a paid stay at the counter.
    const held = await reserve(f, f.sites[0], { checkIn: '2027-05-01', checkOut: '2027-05-08' })
    expect(held.status).toBe(201)
    const sent = await sendStayLink(f, { checkIn: '2027-05-01', guestName: 'Dale Carter' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const [b] = await query<any>(
      `SELECT u.unit_number FROM unit_bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = $1`, [sent.body.data.bookingId])
    expect(b.unit_number).toBe('RV 02')
  })

  it('"may move it as needed for compression" (Nic 10/17): the hold a link puts on a site is one the nightly packer can move, because it lands where the packer looks', async () => {
    const f = await seed(['RV 01', 'RV 02'])
    // Both sites wide open, so the link lands on RV 01.
    const sent = await sendStayLink(f, { checkIn: '2027-05-01', guestName: 'Dale Carter' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    // Then two stays pinned to RV 02 leave a gap of exactly this week between
    // them — the snug slot the packer exists to fill.
    for (const [ci, co] of [['2027-04-24', '2027-05-01'], ['2027-05-08', '2027-05-15']]) {
      const r = await reserve(f, f.sites[1], { checkIn: ci, checkOut: co })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      await query(`UPDATE unit_bookings SET locked_to_unit = TRUE WHERE id = $1`, [r.body.data.id])
    }
    const { compressPropertySchedule } = await import('../services/scheduleCompression')
    const moves = await compressPropertySchedule(f.propertyId)
    expect(moves).toEqual([expect.objectContaining({ bookingId: sent.body.data.bookingId, fromUnit: 'RV 01', toUnit: 'RV 02' })])
    // Nobody was told RV 01, so nothing was broken by moving them.
    const [b] = await query<any>(
      `SELECT u.unit_number, b.site_reveal_sent_at FROM unit_bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = $1`,
      [sent.body.data.bookingId])
    expect(b).toMatchObject({ unit_number: 'RV 02', site_reveal_sent_at: null })
  })

  it('a full park is refused in plain words, and nothing is written — no money taken against a stay nobody can have', async () => {
    const f = await seed(['RV 01'])
    const held = await reserve(f, f.sites[0], { checkIn: '2027-05-01', checkOut: '2027-05-08' })
    expect(held.status).toBe(201)
    const sent = await sendStayLink(f, { checkIn: '2027-05-01', guestName: 'Dale Carter' })
    expect(sent.status).toBe(409)
    expect(sent.body.error).toMatch(/Every site is taken for those nights/)
    expect(await query(`SELECT 1 FROM pos_pay_links`)).toHaveLength(0)
    expect(h.emailPayLinkMock).not.toHaveBeenCalled()
  })

  it('a stay still cannot go out with no arrival date and no name — and the refusal no longer asks for a site', async () => {
    const f = await seed()
    const sent = await request(app()).post('/api/pos/pay-links').set(auth(f)).send({
      propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Dale Carter', email: 'dale@t.dev' },
      items: [{ id: f.items.week, name: 'RV site — weekly', qty: 1, price: 0, tax: 0 }],
    })
    expect(sent.status).toBe(400)
    expect(sent.body.error).toMatch(/needs an arrival date and who it is for/)
    expect(sent.body.error).not.toMatch(/needs a site/)
  })

  it('ANDRES RAZO (Nic 10/17, "paid for a week and it did not generate a stay"): a link selling a stay with nothing on the schedule refuses to open — before the card page, so nothing is charged', async () => {
    const f = await seed()
    // A link in the shape the one sent on 9/18 was in: a month of site rent in
    // the cart, no site, no dates, no reservation. None can be made this way
    // any more; this is the door shut behind the ones that were.
    const token = 'a'.repeat(48)
    await query(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items,
                                  subtotal, tax_amount, discount_amount, total, customer_email, status)
       VALUES ($1,$2,$3,$4,'one_time','3 items',$5::jsonb,589,0,0,589,'andres@t.dev','open')`,
      [token, f.landlordId, f.propertyId, f.userId,
       JSON.stringify([{ id: f.items.month, name: 'RV site — monthly', qty: 1, price: 589, tax: 0 }])])

    const page = await request(app()).get(`/api/public/pay/${token}`)
    expect(page.status).toBe(409)
    expect(page.text).toMatch(/needs updating/i)
    // No card page was ever opened, so there is no charge to refund.
    expect(h.checkoutMock).not.toHaveBeenCalled()
    expect(await query(`SELECT 1 FROM unit_bookings`)).toHaveLength(0)
    const [still] = await query<any>(`SELECT status, last_checkout_session_id FROM pos_pay_links WHERE token = $1`, [token])
    expect(still).toMatchObject({ status: 'open', last_checkout_session_id: null })
  })

  it('…and the counter will not settle it either — the last way to pay for a week and get no site', async () => {
    const f = await seed()
    const token = 'b'.repeat(48)
    const line = { id: f.items.month, name: 'RV site — monthly', qty: 1, price: 589, tax: 0 }
    const [link] = await query<any>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items,
                                  subtotal, tax_amount, discount_amount, total, customer_email, status)
       VALUES ($1,$2,$3,$4,'one_time','3 items',$5::jsonb,589,0,0,589,'andres@t.dev','open')
       RETURNING id`,
      [token, f.landlordId, f.propertyId, f.userId, JSON.stringify([line])])

    const rung = await request(app()).post('/api/pos/transactions').set(auth(f)).send({
      propertyId: f.propertyId, payLinkId: link.id, paymentMethod: 'cash',
      items: [line], amountTendered: 589,
    })
    expect(rung.status, JSON.stringify(rung.body)).toBe(409)
    expect(rung.body.error).toMatch(/holds no site or dates/)
    expect(await query(`SELECT 1 FROM pos_transactions`)).toHaveLength(0)
    expect(await query(`SELECT 1 FROM unit_bookings`)).toHaveLength(0)
  })

  it('a link that DOES hold its reservation still opens normally', async () => {
    const f = await seed()
    const sent = await sendStayLink(f, { checkIn: '2027-05-01', guestName: 'Dale Carter' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const [link] = await query<any>(`SELECT token FROM pos_pay_links WHERE id = $1`, [sent.body.data.id])
    const page = await request(app()).get(`/api/public/pay/${link.token}`)
    expect(page.status).toBe(303)
    expect(h.checkoutMock).toHaveBeenCalledTimes(1)
  })

  it('MOUNTAIN VIEW (review): a vacant mobile home the park has switched OFF for short stays is never picked, though it sorts first and prices off the park', async () => {
    const f = await seed(['RV 01'])
    const c = await db.connect()
    try {
      // The seven of these at Mountain View: vacant, no rate of their own (so
      // the park's RV rate is what the fallback finds), allowed only
      // month-to-month and long-term, is_bookable OFF. 'MH 3.5' sorts ahead of
      // every 'RV …'.
      await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            is_bookable, lease_types_allowed)
         VALUES ($1,$2,'MH 3.5','vacant',500,'mobile_home',FALSE,ARRAY['month_to_month','long_term'])`,
        [f.propertyId, f.landlordId])
      const picked = await chooseFreeSite(c, {
        propertyId: f.propertyId, landlordId: f.landlordId,
        checkIn: '2027-05-01', checkOut: '2027-05-08', stayUnit: 'week',
      })
      expect(picked?.unitNumber).toBe('RV 01')
      // And with the RV site taken, the park is FULL — the mobile home is not a
      // fallback. It is also the only set the nightly packer can move a stay
      // within, so a stay parked there could never be compressed.
      await reserve(f, f.sites[0], { checkIn: '2027-05-01', checkOut: '2027-05-08' })
      expect(await chooseFreeSite(c, {
        propertyId: f.propertyId, landlordId: f.landlordId,
        checkIn: '2027-05-01', checkOut: '2027-05-08', stayUnit: 'week',
      })).toBeNull()
    } finally { c.release() }
  })

  it('it picks BEST FIT, the way the booking site does — a week slots into the snug gap, not onto the wide-open site', async () => {
    const f = await seed(['RV 01', 'RV 02'])
    // RV 02 has stays either side of exactly the week being sold; RV 01 is
    // wide open. Unit-number order would take RV 01 and leave a one-week hole
    // nothing else fits in.
    await reserve(f, f.sites[1], { checkIn: '2027-04-24', checkOut: '2027-05-01' })
    await reserve(f, f.sites[1], { checkIn: '2027-05-08', checkOut: '2027-05-15' })
    const c = await db.connect()
    try {
      const picked = await chooseFreeSite(c, {
        propertyId: f.propertyId, landlordId: f.landlordId,
        checkIn: '2027-05-01', checkOut: '2027-05-08', stayUnit: 'week',
      })
      expect(picked?.unitNumber).toBe('RV 02')
    } finally { c.release() }
  })

  it('a guest who paid for a week and never showed still holds those nights — the chooser skips their site', async () => {
    const f = await seed(['RV 01', 'RV 02'])
    const r = await reserve(f, f.sites[0], { checkIn: '2027-05-01', checkOut: '2027-05-08' })
    expect(r.status).toBe(201)
    await query(`UPDATE unit_bookings SET deposit_paid_at = NOW(), balance_paid_at = NOW(), status = 'no_show' WHERE id = $1`, [r.body.data.id])
    const c = await db.connect()
    try {
      const picked = await chooseFreeSite(c, {
        propertyId: f.propertyId, landlordId: f.landlordId,
        checkIn: '2027-05-01', checkOut: '2027-05-08', stayUnit: 'week',
      })
      expect(picked?.unitNumber).toBe('RV 02')
    } finally { c.release() }
  })

  it('the chooser never offers storage, a site with no rate for the length, or one that is out of order', async () => {
    const f = await seed(['RV 01', 'RV 02'])
    // RV 01 has no weekly rate; RV 02 is a storage unit, which is hard-locked
    // out of short-term stays whatever its rates say.
    await query(`UPDATE units SET weekly_rate = NULL WHERE id = $1`, [f.sites[0]])
    await query(`UPDATE units SET unit_type = 'storage' WHERE id = $1`, [f.sites[1]])
    await query(`UPDATE properties SET weekly_rate = NULL WHERE id = $1`, [f.propertyId])
    const c = await db.connect()
    try {
      expect(await chooseFreeSite(c, {
        propertyId: f.propertyId, landlordId: f.landlordId,
        checkIn: '2027-05-01', checkOut: '2027-05-08', stayUnit: 'week',
      })).toBeNull()
    } finally { c.release() }
  })
})

// ── 3. Reserved vs locked in ────────────────────────────────────────────────

describe('"reservations are only locked in with deposits" (Nic 10/17)', () => {
  it('an unpaid reservation yields to a paying guest; one with a deposit paid is never even a candidate', async () => {
    const f = await seed()
    const soft = await reserve(f, f.sites[0], { sendDepositLink: true, checkIn: '2027-05-01', checkOut: '2027-05-08' })
    expect(soft.status).toBe(201)
    const locked = await reserve(f, f.sites[1], { sendDepositLink: true, checkIn: '2027-05-01', checkOut: '2027-05-08' })
    expect(locked.status).toBe(201)
    // The deposit on the second one landed.
    await query(`UPDATE unit_bookings SET deposit_paid_at = NOW(), status = 'confirmed' WHERE id = $1`, [locked.body.data.id])

    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const onSoft = await unpaidHoldsOn(c, f.sites[0], '2027-05-01', '2027-05-08')
      const onLocked = await unpaidHoldsOn(c, f.sites[1], '2027-05-01', '2027-05-08')
      await c.query('ROLLBACK')
      expect(onSoft.map((x) => x.id)).toEqual([soft.body.data.id])
      expect(onLocked).toEqual([])
    } finally { c.release() }

    // And the site under the locked one cannot be sold to a payer at all.
    expect(await findStayConflict(f.sites[1], { checkIn: '2027-05-01', checkOut: '2027-05-08', ignoreUnpaidHolds: true })).toBe('booking')
    // The unpaid one's site can be.
    expect(await findStayConflict(f.sites[0], { checkIn: '2027-05-01', checkOut: '2027-05-08', ignoreUnpaidHolds: true })).toBeNull()
  })

  it('the schedule says which is which in plain words, and never in a third status', async () => {
    const { stayHoldWords, BOOKING_STATUSES } = await import('@gam/shared')
    expect(stayHoldWords('tentative', false)).toMatch(/Reserved, not paid for/)
    expect(stayHoldWords('tentative', true)).toMatch(/Locked in/)
    expect(stayHoldWords('confirmed', true)).toMatch(/Locked in/)
    // Over, gone, or on the site: the question has stopped mattering.
    for (const s of ['checked_in', 'checked_out', 'cancelled', 'no_show'] as const) {
      expect(stayHoldWords(s, true)).toBeNull()
    }
    expect(BOOKING_STATUSES).not.toContain('soft_hold')
  })
})

// ── 4. The guest who never showed ───────────────────────────────────────────

describe('a paid week whose guest never showed (Nic 10/17)', () => {
  it('holds every night that was paid for, then the site frees itself after the last one — and the money is not given back', async () => {
    const f = await seed()
    const r = await reserve(f, f.sites[0], { checkIn: '2027-05-01', checkOut: '2027-05-08' })
    expect(r.status).toBe(201)
    const id = r.body.data.id
    await query(`UPDATE unit_bookings SET deposit_paid_at = NOW(), balance_paid_at = NOW(), status = 'confirmed' WHERE id = $1`, [id])

    const marked = await request(app()).patch(`/api/units/${f.sites[0]}/bookings/${id}`).set(auth(f)).send({ status: 'no_show' })
    expect(marked.status, JSON.stringify(marked.body)).toBe(200)
    const [b] = await query<any>(
      `SELECT status, total_amount::float AS total, to_char(check_out,'YYYY-MM-DD') AS check_out,
              to_char(booked_check_out,'YYYY-MM-DD') AS booked FROM unit_bookings WHERE id = $1`, [id])
    // The week stays sold for what it was sold for.
    expect(b).toMatchObject({ status: 'no_show', total: 286.08, check_out: '2027-05-08', booked: '2027-05-08' })

    // Nobody else can have the nights the no-show paid for…
    expect(await findStayConflict(f.sites[0], { checkIn: '2027-05-03', checkOut: '2027-05-05' })).toBe('booking')
    // …not even somebody paying (a no-show is not an unpaid hold)…
    expect(await findStayConflict(f.sites[0], { checkIn: '2027-05-03', checkOut: '2027-05-05', ignoreUnpaidHolds: true })).toBe('booking')
    // …and from the morning after the last night the site is free again, with
    // nobody having had to do anything to it.
    expect(await findStayConflict(f.sites[0], { checkIn: '2027-05-08', checkOut: '2027-05-15' })).toBeNull()
  })
})

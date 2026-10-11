/**
 * 10/6 (Nic) — ONE PRICE FOR THE SAME NIGHTS, AT EVERY DOOR.
 *
 *   "It's saying six nights for $312. Well, our weekly price is $269. It should
 *    be charging them the price, the configuration that's going to be the
 *    cheapest option for them."
 *
 * He chose: everywhere — the reservation form, the schedule, the booking site,
 * pay links, the register and the guest/visitor assistant's quotes. So for the
 * same site and the same dates every one of those doors must quote and charge
 * the shared priceStay figure: the cheapest whole months, weeks and nights that
 * cover the stay, plus the lodging tax under 30 nights. These go through the
 * real routes (camelized, as the app answers) against a site at $49 a night,
 * $269 a week and $589 a month with a 10% lodging tax.
 *
 * Stripe and the emails are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  checkoutMock: vi.fn(async (_p: any) => ({ id: `cs_test_${Math.random().toString(36).slice(2)}`, url: 'https://checkout.stripe.test/x' })),
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ checkout: { sessions: { create: h.checkoutMock, retrieve: async (id: string) => ({ id, status: 'expired', payment_status: 'unpaid' }), expire: async () => undefined } } }),
}))
vi.mock('../services/stripeConnect', async (orig) => ({ ...(await orig() as any), expirePayLinkCheckoutSession: vi.fn(async () => undefined) }))
vi.mock('../services/email', async (orig) => ({ ...(await orig() as any), emailPayLink: h.emailPayLinkMock }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { priceStay } from '@gam/shared'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { posRouter } from './pos'
import { posPayLinksRouter } from './posPayLinks'
import { unitsRouter } from './units'
import { publicPropertyBookingRouter } from './publicPropertyBooking'
import { reservationDue } from '../services/registerStay'

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
  a.use('/api/public', publicPropertyBookingRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  h.checkoutMock.mockClear(); h.emailPayLinkMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stay_doors'
})

const RATES = { nightly: 49, weekly: 269, monthly: 589 }
const TAX = 10

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_doors_' || replace($1::text,'-','') WHERE id = $1`, [landlordId])
    await c.query(
      `UPDATE properties SET public_booking_enabled = TRUE, booking_slug = 'doors-park', booking_deposit_pct = 20,
              short_term_tax_rate = $2 WHERE id = $1`, [propertyId, TAX])
    const cat = (await c.query(`INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stays',1,TRUE) RETURNING id`, [landlordId])).rows[0].id
    const daily = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — daily',$3,0,0,0,999,0,999,'night') RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const sites: string[] = []
    for (const n of ['RV 01', 'RV 02']) {
      sites.push((await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, weekly_rate, monthly_rate,
                            is_bookable, lease_types_allowed)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',$4,$5,$6,TRUE,ARRAY['nightly','weekly'])
         RETURNING id`, [propertyId, landlordId, n, RATES.nightly, RATES.weekly, RATES.monthly])).rows[0].id)
    }
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, daily, sites, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type F = Awaited<ReturnType<typeof seed>>
const auth = (f: F) => ({ Authorization: `Bearer ${f.token}` })
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)

// [nights, total with the 10% tax, how it is charged]
const STAYS: Array<[number, number, string]> = [
  [6, 295.9, '1 week'],             // the week ($269), not six nights ($294 — $323.40 with tax)
  [8, 349.8, '1 week + 1 night'],   // $318
  [13, 591.8, '2 weeks'],           // $538
]

describe('the same nights on the same site cost the same at every door', () => {
  for (const [nights, total, chargedAs] of STAYS) {
    it(`${nights} nights: the booking site, the register, a pay link, the reservation form and the assistant all say $${total.toFixed(2)}`, async () => {
      const f = await seed()
      const checkIn = '2027-06-01'
      const checkOut = addDays(checkIn, nights)
      expect(priceStay(RATES, TAX, checkIn, nights).total).toBe(total)

      // The booking site (the guest's quote, camelized).
      const site = await request(app()).get(`/api/public/property/doors-park/availability?siteTypeId=general&checkIn=${checkIn}&checkOut=${checkOut}`)
      expect(site.status, JSON.stringify(site.body)).toBe(200)
      expect(site.body.data).toMatchObject({ available: true, total, chargedAs })

      // The visitor assistant quotes the booking site's figure.
      const { checkPropertyAvailability } = await import('../services/agents/tools/checkPropertyAvailability')
      const said: any = await checkPropertyAvailability.execute({ checkIn, checkOut }, { propertyId: f.propertyId, role: 'visitor' } as any)
      expect(said.ok, JSON.stringify(said)).toBe(true)
      expect(said.siteTypes[0]).toMatchObject({ total, chargedAs })

      // The register's site list and its stay quote, rung as nights.
      const list = await request(app()).get(`/api/pos/stays/available?propertyId=${f.propertyId}&checkIn=${checkIn}&stayUnit=night&qty=${nights}`).set(auth(f))
      expect(list.status, JSON.stringify(list.body)).toBe(200)
      for (const u of list.body.data.units) {
        expect(u).toMatchObject({ lineTotal: total, lowerRateWords: 'charged at the weekly rate, the lower price' })
      }
      const quote = await request(app()).post('/api/pos/stays/quote').set(auth(f))
        .send({ propertyId: f.propertyId, itemId: f.daily, qty: nights, unitId: f.sites[1], checkIn, guestName: 'Dale Carter' })
      expect(quote.status, JSON.stringify(quote.body)).toBe(200)
      expect(quote.body.data).toMatchObject({ stayTotal: total, charge: total })
      // The ticket and the receipt say why it is lower.
      expect(quote.body.data.what).toContain('— charged at the weekly rate, the lower price')

      // The reservation form (the schedule's New Reservation) on RV 01.
      const booked = await request(app()).post(`/api/units/${f.sites[0]}/bookings`).set(auth(f))
        .send({ guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev', guestPhone: '520-555-0101', leaseType: nights >= 7 ? 'weekly' : 'nightly',
                checkIn, checkOut, source: 'direct' })
      expect(booked.status, JSON.stringify(booked.body)).toBe(201)
      expect(Number(booked.body.data.totalAmount)).toBe(total)

      // A pay link sent from the register for RV 02, the same dates.
      const sent = await request(app()).post('/api/pos/pay-links').set(auth(f))
        .send({ propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Dale Carter', email: 'dale@t.dev' },
                items: [{ id: f.daily, name: 'RV site — daily', qty: nights, price: 49, tax: 0, stayTotal: total }],
                stay: { unitId: f.sites[1], checkIn, guestName: 'Dale Carter' } })
      expect(sent.status, JSON.stringify(sent.body)).toBe(201)
      expect(Number(sent.body.data.total)).toBe(total)
      const [link] = await query<any>(`SELECT booking_id, label FROM pos_pay_links WHERE id = $1`, [sent.body.data.id])
      expect(link.label).toContain('charged at the weekly rate, the lower price')
      expect(await reservationDue(db, link.booking_id)).toMatchObject({ total, owed: total })
    })
  }

  it('a week rung as a week is not explained — it is what it was rung as', async () => {
    const f = await seed()
    const list = await request(app()).get(`/api/pos/stays/available?propertyId=${f.propertyId}&checkIn=2027-06-01&stayUnit=week&qty=1`).set(auth(f))
    expect(list.status).toBe(200)
    expect(list.body.data.units[0]).toMatchObject({ lineTotal: 295.9, lowerRateWords: null })
  })

  it('the guest assistant prices one more night by the same rule — a sixth night at the week price costs nothing extra', async () => {
    const f = await seed()
    const { requestBookingChange } = await import('../services/agents/tools/requestBookingChange')
    const make = async (checkIn: string, nights: number) => {
      const r = await request(app()).post(`/api/units/${f.sites[0]}/bookings`).set(auth(f))
        .send({ guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev', guestPhone: '520-555-0101', leaseType: 'nightly',
                checkIn, checkOut: addDays(checkIn, nights), source: 'direct' })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      return r.body.data.id as string
    }
    // Six nights are already the week's price, so the seventh adds nothing.
    const six = await make('2027-06-01', 6)
    const q6: any = await requestBookingChange.execute({ request_type: 'extra_night' }, { role: 'guest', bookingId: six } as any)
    expect(q6).toMatchObject({ quoteOnly: true, extraNightPrice: 0 })
    expect(q6.message).toMatch(/costs nothing extra/)
    // Seven nights → eight is one night, $49 + 10%.
    const seven = await make('2027-07-01', 7)
    const q7: any = await requestBookingChange.execute({ request_type: 'extra_night' }, { role: 'guest', bookingId: seven } as any)
    expect(q7).toMatchObject({ quoteOnly: true, extraNightPrice: 53.9 })
    expect(q7.message).toMatch(/\$53\.90/)
    // Said yes: the night is on the reservation's price, as the schedule would price eight nights.
    const done: any = await requestBookingChange.execute({ request_type: 'extra_night', confirmed: true }, { role: 'guest', bookingId: seven } as any)
    expect(done).toMatchObject({ ok: true, autoApproved: true, newCheckOut: '2027-07-09' })
    const [row] = await query<any>(`SELECT total_amount::float AS total, nights FROM unit_bookings WHERE id = $1`, [seven])
    expect(row).toEqual({ total: priceStay(RATES, TAX, '2027-07-01', 8).total, nights: 8 })
  })

  it('a stay already paid in full owes the extra night — the register is asked for it (10/6 review)', async () => {
    const f = await seed()
    const { requestBookingChange } = await import('../services/agents/tools/requestBookingChange')
    const r = await request(app()).post(`/api/units/${f.sites[0]}/bookings`).set(auth(f))
      .send({ guestName: 'Pat Ruiz', guestEmail: 'pat@t.dev', guestPhone: '520-555-0101', leaseType: 'nightly',
              checkIn: '2027-08-01', checkOut: '2027-08-08', source: 'direct' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const id = r.body.data.id as string
    const week = priceStay(RATES, TAX, '2027-08-01', 7).total
    await db.query(`UPDATE unit_bookings SET balance_paid_at = now() WHERE id = $1`, [id])
    expect(await reservationDue(db, id)).toMatchObject({ total: week, paid: week, owed: 0, paidInFull: true })
    const done: any = await requestBookingChange.execute({ request_type: 'extra_night', confirmed: true }, { role: 'guest', bookingId: id } as any)
    expect(done).toMatchObject({ ok: true, autoApproved: true })
    const eight = priceStay(RATES, TAX, '2027-08-01', 8).total
    const due = await reservationDue(db, id)
    expect(due).toMatchObject({ total: eight, paid: week, paidInFull: false })
    expect(due!.owed).toBeCloseTo(eight - week, 2)
    expect(due!.owed).toBeCloseTo(53.9, 2)
  })
})

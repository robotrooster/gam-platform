/**
 * 10/3 — the landlord's balance breakdown for a STAY pay link (components/
 * BalanceBreakdowns.tsx, PayLinkBreakdown) reads a reservation the way the
 * register does. This holds the server side of what that screen sends:
 *
 *   - it opens the link through GET /pos/tickets/:id?kind=pay_link and shows
 *     the reservation's line at what it owes NOW (never the stored lines) — the
 *     same figure the Pay Links list shows (decisions #23: one amount);
 *   - decisions #23: a reservation's nights change ONLY on the schedule. The
 *     link's stay line sent back with fewer units — to POST /pos/cart-quote or
 *     to PATCH /pos/pay-links/:id — is refused in words that point to the
 *     schedule, and nothing changes; a stay changed on the schedule is followed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/email', async (orig) => ({ ...(await orig() as any), emailPayLink: vi.fn(async () => undefined) }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { posRouter } from './pos'
import { posPayLinksRouter } from './posPayLinks'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_balance_stay_link'
})

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_bal_' || replace($1::text,'-','') WHERE id = $1`, [landlordId])
    const cat = (await c.query(`INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stays',1,TRUE) RETURNING id`, [landlordId])).rows[0].id
    const stayItem = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — nightly',$3,0,0,0,999,0,999,'night') RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const site = (await c.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, is_bookable)
       VALUES ($1,$2,'RV 01','vacant',500,'rv_spot',40,TRUE) RETURNING id`, [propertyId, landlordId])).rows[0].id
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, stayItem, site, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('a stay pay link on the landlord\'s balance breakdown', () => {
  const words = (press: string, nothing: string, what = '3 nights at site RV 01 (Jun 1 → Jun 4)') =>
    `This link holds ${what} — a reservation's nights, site and price change only on the schedule, so nothing was ${nothing}. `
    + `Put the stay back the way the link has it, then press ${press} again. To change the stay, change the reservation on the schedule first — the link then asks what it owes.`

  it('opens at what the reservation owes now — the list says the same — and a shorter stay is refused at the quote and by Adjust', async () => {
    const f = await seed()
    const auth = { Authorization: `Bearer ${f.token}` }
    const sent = await request(app()).post('/api/pos/pay-links').set(auth).send({
      propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Gina Guest', email: 'gina@t.dev' },
      items: [{ id: f.stayItem, name: 'RV site — nightly', qty: 3, price: 40 }],
      stay: { unitId: f.site, checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev' },
    })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const link = sent.body.data

    // The schedule repriced the reservation after the link went out: the
    // breakdown shows the reservation's price, not the $120 stored on the link.
    await query(`UPDATE unit_bookings SET total_amount = 105 WHERE id = $1`, [link.bookingId])
    const opened = await request(app()).get(`/api/pos/tickets/${link.id}?kind=pay_link&propertyId=${f.propertyId}`).set(auth)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body.data.bookingId).toBe(link.bookingId)
    expect(opened.body.data.items[0]).toMatchObject({ reservation: true, price: 105, nights: 3, id: f.stayItem })
    expect(opened.body.data.items[0].maxNights).toBeUndefined()
    expect(Number(opened.body.data.total)).toBe(105)
    expect(Number((await query<any>(`SELECT total FROM pos_pay_links WHERE id = $1`, [link.id]))[0].total)).toBe(120)
    // decisions #23: the Pay Links list shows the same $105 (its stored lines as they are).
    const stored = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth)).body.data
      .find((r: any) => r.id === link.id)
    expect(Number(stored.total)).toBe(105)
    expect(stored.note).toBeNull()
    const stayLine = stored.items.find((l: any) => l.id === f.stayItem)
    expect(stayLine).toMatchObject({ qty: 3, price: 40 })

    // One night fewer: refused at the quote and when saved — nothing changes.
    const quote = await request(app()).post('/api/pos/cart-quote').set(auth).send({
      propertyId: f.propertyId, paymentMethod: 'cash', payLinkId: link.id, priceStay: true,
      items: [{ ...stayLine, qty: 2 }],
    })
    expect(quote.status).toBe(400)
    expect(quote.body.error).toBe(words('Charge', 'charged'))
    const saved = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth).send({ items: [{ ...stayLine, qty: 2 }] })
    expect(saved.status).toBe(400)
    expect(saved.body.error).toBe(words('Save changes', 'changed'))
    const b = (await query<any>(`SELECT nights, total_amount::float AS total, check_out::text AS check_out FROM unit_bookings WHERE id = $1`, [link.bookingId]))[0]
    expect(b).toEqual({ nights: 3, total: 105, check_out: '2027-06-04' })
    expect(Number((await query<any>(`SELECT total FROM pos_pay_links WHERE id = $1`, [link.id]))[0].total)).toBe(120)

    // The whole stay, saved: the link asks what the reservation owes.
    const whole = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth).send({ items: [stayLine] })
    expect(whole.status, JSON.stringify(whole.body)).toBe(200)
    expect(Number(whole.body.data.total)).toBe(105)
  })

  it('a stay shortened on the schedule is followed: the breakdown, the list and Adjust all ask the shorter stay\'s price', async () => {
    const f = await seed()
    const auth = { Authorization: `Bearer ${f.token}` }
    const link = (await request(app()).post('/api/pos/pay-links').set(auth).send({
      propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Gina Guest', email: 'gina@t.dev' },
      items: [{ id: f.stayItem, name: 'RV site — nightly', qty: 3, price: 40 }],
      stay: { unitId: f.site, checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev' },
    })).body.data
    // The schedule shortens it to two nights and reprices it ($80).
    await query(`UPDATE unit_bookings SET check_out = '2027-06-03', nights = 2, total_amount = 80 WHERE id = $1`, [link.bookingId])
    const opened = await request(app()).get(`/api/pos/tickets/${link.id}?kind=pay_link&propertyId=${f.propertyId}`).set(auth)
    expect(opened.body.data.items[0]).toMatchObject({ reservation: true, price: 80, nights: 2 })
    expect(opened.body.data.items[0].name).toMatch(/2 nights at site RV 01 \(Jun 1 → Jun 3\)/)
    const listed = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth)).body.data.find((r: any) => r.id === link.id)
    expect(Number(listed.total)).toBe(80)
    // The register's line sends back the reservation's own nights: it charges $80.
    const quote = await request(app()).post('/api/pos/cart-quote').set(auth).send({
      propertyId: f.propertyId, paymentMethod: 'cash', payLinkId: link.id, items: opened.body.data.items,
    })
    expect(quote.status, JSON.stringify(quote.body)).toBe(200)
    expect(Number(quote.body.data.total)).toBe(80)
    // Sending the old three nights back is refused — the reservation has two now.
    const stale = await request(app()).post('/api/pos/cart-quote').set(auth).send({
      propertyId: f.propertyId, paymentMethod: 'cash', payLinkId: link.id, items: [{ ...opened.body.data.items[0], nights: 3 }],
    })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('This link\'s reservation is 2 nights at site RV 01 (Jun 1 → Jun 3) now — a reservation\'s nights, site and price change only on the schedule, '
      + 'and the cart shows other nights, so nothing was charged. Press Clear, open the link again from the list, then press Charge.')
  })
})

/**
 * 10/3 (decisions #23) — what the landlord's balance breakdown sends when a
 * reservation pay link is adjusted (components/BalanceBreakdowns.tsx,
 * PayLinkBreakdown). The shorten-the-stay control is gone: the reservation's
 * line is read-only at what it owes now, and "Adjust the other lines" changes
 * only the link's other lines — the reservation's own lines go back exactly as
 * the link stores them (GET /pos/pay-links). This holds that contract against
 * the server: the screen's save is accepted and charges the reservation's
 * current price plus the other lines as changed; a changed stay is refused.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_balance_stay_link_adjust'
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
    const propane = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Propane — 20 lb tank',$3,20,0,0,999,0,999) RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const site = (await c.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, is_bookable)
       VALUES ($1,$2,'RV 01','vacant',500,'rv_spot',40,TRUE) RETURNING id`, [propertyId, landlordId])).rows[0].id
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, stayItem, propane, site, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('adjusting a reservation pay link from the balance breakdown', () => {
  it('the other lines change; the reservation goes back as stored and is charged what it owes now', async () => {
    const f = await seed()
    const auth = { Authorization: `Bearer ${f.token}` }
    const sent = await request(app()).post('/api/pos/pay-links').set(auth).send({
      propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Gina Guest', email: 'gina@t.dev' },
      items: [{ id: f.stayItem, name: 'RV site — nightly', qty: 3, price: 40 }, { id: f.propane, name: 'Propane — 20 lb tank', qty: 1, price: 20 }],
      stay: { unitId: f.site, checkIn: '2027-06-01', guestName: 'Gina Guest', guestEmail: 'gina@t.dev' },
    })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const link = sent.body.data
    // The schedule repriced the reservation after the link went out.
    await query(`UPDATE unit_bookings SET total_amount = 105 WHERE id = $1`, [link.bookingId])

    // What the breakdown opens with: the reservation (read-only) and the other line.
    const opened = (await request(app()).get(`/api/pos/tickets/${link.id}?kind=pay_link&propertyId=${f.propertyId}`).set(auth)).body.data
    const reservation = opened.items.filter((i: any) => i.reservation)
    const others = opened.items.filter((i: any) => !i.reservation)
    expect(reservation).toHaveLength(1)
    expect(reservation[0]).toMatchObject({ id: f.stayItem, price: 105, qty: 1 })
    expect(others).toMatchObject([{ id: f.propane, qty: 1, price: 20 }])
    expect(Number(opened.total)).toBe(125)

    // "Adjust the other lines": the stored lines, split the way the screen splits them.
    const stored = (await request(app()).get(`/api/pos/pay-links?propertyId=${f.propertyId}`).set(auth)).body.data
      .find((r: any) => r.id === link.id).items as any[]
    const isReservationLine = (l: any) => String(l?.id ?? '').toLowerCase() === String(reservation[0].id).toLowerCase()
    const kept = stored.filter(isReservationLine)
    const rest = stored.filter((l) => !isReservationLine(l))
    expect(kept).toMatchObject([{ id: f.stayItem, qty: 3, price: 40 }])

    // Two tanks instead of one: accepted, the reservation still at $105.
    const two = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth)
      .send({ items: [...kept, { ...rest[0], qty: 2 }] })
    expect(two.status, JSON.stringify(two.body)).toBe(200)
    expect(Number(two.body.data.total)).toBe(145)
    const after = (await request(app()).get(`/api/pos/tickets/${link.id}?kind=pay_link&propertyId=${f.propertyId}`).set(auth)).body.data
    expect(after.items.find((i: any) => i.reservation)).toMatchObject({ price: 105 })
    expect(Number(after.total)).toBe(145)

    // The other line taken off: the link is its reservation alone.
    const alone = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth).send({ items: kept })
    expect(alone.status, JSON.stringify(alone.body)).toBe(200)
    expect(Number(alone.body.data.total)).toBe(105)

    // The stay itself is never changed from here — the server refuses it too.
    const shorter = await request(app()).patch(`/api/pos/pay-links/${link.id}`).set(auth)
      .send({ items: [{ ...kept[0], qty: 2 }] })
    expect(shorter.status).toBe(400)
    expect(shorter.body.error).toContain('change only on the schedule')
    const b = (await query<any>(`SELECT nights, total_amount::float AS total FROM unit_bookings WHERE id = $1`, [link.bookingId]))[0]
    expect(b).toEqual({ nights: 3, total: 105 })
  })
})

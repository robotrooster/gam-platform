/**
 * 10/21 (Nic) — QR CODES MADE FROM REGISTER ITEMS, AND CUT FOR AN ENGRAVER.
 *
 *   "I would also like it to be set up where QR codes can be generated from
 *    point of sale items or self-service. I still want to do my dump station QR
 *    code, or, you know, people doing a late check-in... It'd be nice to have
 *    set QR codes for point of sale items, and then I can make nice signs
 *    engraved on wood and maybe use a laser engraver to actually like do the QR
 *    code the right way, so it looks nice and professional."
 *
 * Standing QR codes already existed, but only as a label and a price typed by
 * hand — a second price for something the register already sells, which drifts
 * the day the item's price changes and the sign on the wall does not. A code
 * made FROM the item carries the catalog's own price and reads as a sale of
 * that item everywhere sales are counted.
 *
 * And the SVG matters more than it sounds: a laser cutter wants paths. Tracing
 * a PNG rounds the corners of the modules, which is how an engraved code ends
 * up not scanning off a plank of wood.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('../services/stripeConnect', async (orig) => ({ ...(await orig() as any) }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { posPayLinksRouter } from './posPayLinks'

function app() {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => { const j = res.json.bind(res); res.json = (b: any) => j(camelCaseKeys(b)); next() })
  a.use('/api/pos/pay-links', posPayLinksRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => { await cleanupAllSchema(); process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_qr_item' })

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_qr_' || replace($1::text,'-','') WHERE id = $1`, [landlordId])
    const cat = (await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Services',1,TRUE) RETURNING id`, [landlordId])).rows[0].id
    const dump = (await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Dump station',$3,15,0,0,999,0,999) RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, dump, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type F = Awaited<ReturnType<typeof seed>>
const auth = (f: F) => ({ Authorization: `Bearer ${f.token}` })

const makeQr = (f: F, items: any[], label: string) =>
  request(app()).post('/api/pos/pay-links').set(auth(f))
    .send({ propertyId: f.propertyId, kind: 'standing', label, items })

describe('a standing QR code made from a register item', () => {
  it('carries the item, so a scan is a sale of that item and not a stray amount', async () => {
    const f = await seed()
    const res = await makeQr(f, [{ id: f.dump, name: 'Dump station', qty: 1, price: 15, tax: 0 }], 'Dump station')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const [link] = await query<any>(`SELECT kind, label, total::float AS total, items FROM pos_pay_links`)
    expect(link).toMatchObject({ kind: 'standing', label: 'Dump station', total: 15 })
    expect(link.items[0].id).toBe(f.dump)
  })

  it('still takes a one-off with no item behind it — the old way never went away', async () => {
    const f = await seed()
    const res = await makeQr(f, [{ id: null, name: 'Late check-in', qty: 1, price: 40, tax: 0, cat: 'misc' }], 'Late check-in')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const [link] = await query<any>(`SELECT total::float AS total, items FROM pos_pay_links`)
    expect(link.total).toBe(40)
    expect(link.items[0].id).toBeNull()
  })

  it('hands the engraver vector art, not pixels', async () => {
    const f = await seed()
    const made = await makeQr(f, [{ id: f.dump, name: 'Dump station', qty: 1, price: 15, tax: 0 }], 'Dump station')
    const id = made.body.data.id
    const svg = await request(app()).get(`/api/pos/pay-links/${id}/qr.svg`).set(auth(f)).buffer(true)
    expect(svg.status, JSON.stringify(svg.body)).toBe(200)
    expect(svg.headers['content-type']).toMatch(/image\/svg\+xml/)
    // Named after the sign, so a folder of them is readable.
    expect(svg.headers['content-disposition']).toMatch(/filename="dump-station\.svg"/)
    // Paths, and a path is what a laser follows.
    const art = String(svg.text || svg.body)
    expect(art).toMatch(/<svg/)
    expect(art).toMatch(/<path/)
    // The PNG is still there for anything that only takes an image.
    const png = await request(app()).get(`/api/pos/pay-links/${id}/qr.png`).set(auth(f))
    expect(png.status).toBe(200)
    expect(png.headers['content-type']).toMatch(/image\/png/)
  })

  it('a code for another company is not readable by this one', async () => {
    const f = await seed()
    const made = await makeQr(f, [{ id: f.dump, name: 'Dump station', qty: 1, price: 15, tax: 0 }], 'Dump station')
    const id = made.body.data.id
    const c = await db.connect()
    let otherToken = ''
    try {
      const other = await seedLandlord(c)
      otherToken = jwt.sign({ userId: other.userId, role: 'landlord', email: 'x@t.dev', profileId: other.landlordId,
                              landlordIds: [other.landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    } finally { c.release() }
    const svg = await request(app()).get(`/api/pos/pay-links/${id}/qr.svg`).set({ Authorization: `Bearer ${otherToken}` })
    expect(svg.status).toBeGreaterThanOrEqual(400)
  })
})

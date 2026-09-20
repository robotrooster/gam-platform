/**
 * S651 — the whole path: ring a stay at the counter, get a booking on the
 * Master Schedule.
 *
 * The service is tested on its own (services/registerStay.test.ts). This is the
 * wiring: the real endpoint, the real payload the register sends, and the row
 * that has to come out the other side. A sale that takes the money and records
 * no stay is the bug this exists to stop, and it lived in the route, not the
 * service.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

vi.mock('../services/posTax', async (orig) => {
  const actual: any = await orig()
  return {
    ...actual,
    calculateCartTax: async (_l: string, cart: any[]) => ({
      subtotal: cart.reduce((s, l) => s + l.qty * l.unitPrice, 0),
      taxAmount: 0,
      lines: cart.map((l) => ({ itemId: l.itemId, lineSubtotal: l.qty * l.unitPrice, lineTax: 0 })),
    }),
  }
})

let posRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stays'
  ;({ posRouter } = await import('./pos'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

/**
 * The camelCase middleware is mounted here on purpose.
 *
 * index.ts camelizes every response on the way out, so production serves
 * `rvSiteLayout` and `unitNumber` while a bare router in a test serves
 * `rv_site_layout`. Without it the register's site list would be asserted in a
 * shape the register never receives. (memory: gam-camelize-wire-contract)
 */
function buildApp() {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

const DEFAULT_SITE_RATES = { night: 40, week: 200, month: 440 } as const

async function seed(
  stayUnit: 'night' | 'week' | 'month' = 'night',
  price = 49,
  siteRates: { night: number | null; week: number | null; month: number | null } =
    { ...DEFAULT_SITE_RATES },
) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const cat = await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1,'Stays',1,TRUE) RETURNING id`, [landlordId])
    const item = await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,$3,$4,$5,0,0,999,0,999,$6) RETURNING id`,
      [landlordId, propertyId, `RV site — ${stayUnit}`, cat.rows[0].id, price, stayUnit])
    // S652: the SITE carries the price. The catalog price above is deliberately
    // left at a different number in these fixtures so that any test asserting a
    // total is asserting which of the two won.
    const unit = await c.query(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                          nightly_rate, weekly_rate, monthly_rate, rv_site_layout, rv_amp_service)
       VALUES ($1,$2,'RV 01','vacant',500,'rv_spot',$3,$4,$5,'pull_through','50') RETURNING id`,
      [propertyId, landlordId, siteRates.night, siteRates.week, siteRates.month])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, itemId: item.rows[0].id, unitId: unit.rows[0].id, token, price, siteRates }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const sell = (f: any, body: any = {}) =>
  request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${f.token}`)
    .send({
      items: [{ id: f.itemId, name: 'RV site', qty: 3, price: f.price, tax: 0 }],
      paymentMethod: 'cash', propertyId: f.propertyId,
      stay: { unitId: f.unitId, checkIn: '2026-10-01', guestName: 'Dale Carter', guestPhone: '520-555-0110' },
      ...body,
    })

describe('ringing a stay at the register', () => {
  it('records the sale AND the booking', async () => {
    const f = await seed()
    const res = await sell(f)
    expect(res.status).toBe(201)
    expect(res.body.data.stayBooking).toBeTruthy()
    expect(res.body.data.stayBooking.checkOut).toBe('2026-10-04')

    const [b] = await query<any>(
      `SELECT guest_name, check_in::text, check_out::text, nights, source,
              total_amount::text, pos_transaction_id
         FROM unit_bookings WHERE unit_id = $1`, [f.unitId])
    expect(b.guest_name).toBe('Dale Carter')
    expect(b.check_out).toBe('2026-10-04')       // 3 nights from the 1st
    expect(b.nights).toBe(3)
    expect(b.source).toBe('register')
    // S652: 3 × $40, the SITE's nightly rate — not 3 × $49, the catalog price
    // the browser sent. One price, and it is the unit's.
    expect(Number(b.total_amount)).toBe(120)
    expect(Number(res.body.data.total)).toBe(120)
    expect(b.pos_transaction_id).toBe(res.body.data.id)
  })

  it('refuses a stay with no site or date, and takes no money', async () => {
    // The whole failure this replaces: money taken, nothing on the schedule.
    const f = await seed()
    const res = await sell(f, { stay: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/site and an arrival date/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('rolls the sale back when the site is already taken', async () => {
    // A paid stay on a site somebody else has is worse than a refused sale.
    const f = await seed()
    expect((await sell(f)).status).toBe(201)
    const second = await sell(f, { stay: { unitId: f.unitId, checkIn: '2026-10-02', guestName: 'Someone Else' } })
    expect(second.status).toBe(409)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(1)   // only the first
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(1)
  })

  it('leaves an ordinary sale completely alone', async () => {
    const f = await seed()
    await query(`UPDATE pos_items SET stay_unit = NULL WHERE id = $1`, [f.itemId])
    const res = await sell(f, { stay: null })
    expect(res.status).toBe(201)
    expect(res.body.data.stayBooking).toBeNull()
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(0)
  })

  it('a week of quantity two is fourteen nights', async () => {
    const f = await seed('week', 250)
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [{ id: f.itemId, name: 'RV site', qty: 2, price: 250, tax: 0 }],
        paymentMethod: 'cash', propertyId: f.propertyId,
        stay: { unitId: f.unitId, checkIn: '2026-10-01', guestName: 'Dale Carter' },
      })
    expect(res.status).toBe(201)
    expect(res.body.data.stayBooking.checkOut).toBe('2026-10-15')
    expect(res.body.data.stayBooking.nights).toBe(14)
  })
})

/**
 * S652 (Nic): "There's no variation allowed in terms of charging one price in
 * the booking flow and one price if they come in and get it on the POS and one
 * price if they do whatever. It's all the same. It's based on the unit."
 *
 * Mountain View's units said $269 a week while its register item said $250, and
 * nobody could have told you which one a guest owed. These are the tests that
 * keep that from coming back.
 */
describe('one price, and it is the site\'s', () => {
  it('ignores the price the browser sent and charges the site\'s rate', async () => {
    const f = await seed()
    // The register sends $49 a night. The site says $40. The guest owes $120.
    const res = await sell(f)
    expect(res.status).toBe(201)
    expect(Number(res.body.data.total)).toBe(120)

    const [line] = await query<any>(
      `SELECT unit_price::text, subtotal::text FROM pos_transaction_items
        WHERE transaction_id = $1`, [res.body.data.id])
    // The receipt has to agree with the total, or the guest is handed a piece
    // of paper that contradicts what came out of their wallet.
    expect(Number(line.unit_price)).toBe(40)
    expect(Number(line.subtotal)).toBe(120)
  })

  it('charges a week from the weekly rate, not a multiple of nights', async () => {
    const f = await seed('week', 250)
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [{ id: f.itemId, name: 'RV site', qty: 2, price: 250, tax: 0 }],
        paymentMethod: 'cash', propertyId: f.propertyId,
        stay: { unitId: f.unitId, checkIn: '2026-10-01', guestName: 'Dale Carter' },
      })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.total)).toBe(400)          // 2 × $200, the site's week
  })

  it('falls back to the property rate, exactly as the booking site does', async () => {
    // Mountain View priced at the property level and at the site level both.
    // A register that read only the site would refuse a stay the booking site
    // was selling that same minute.
    const f = await seed('week', 250, { night: 40, week: null, month: 440 })
    await query(`UPDATE properties SET weekly_rate = 275 WHERE id = $1`, [f.propertyId])
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [{ id: f.itemId, name: 'RV site', qty: 1, price: 250, tax: 0 }],
        paymentMethod: 'cash', propertyId: f.propertyId,
        stay: { unitId: f.unitId, checkIn: '2026-10-01', guestName: 'Dale Carter' },
      })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBe(275)
  })

  it('refuses the sale when the site has no rate for that length, and says which', async () => {
    // The honest failure. Charging the catalog price instead is exactly how the
    // two numbers drifted apart in the first place.
    const f = await seed('month', 589, { night: 40, week: 200, month: null })
    await query(`UPDATE properties SET monthly_rate = NULL WHERE id = $1`, [f.propertyId])
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [{ id: f.itemId, name: 'RV site', qty: 1, price: 589, tax: 0 }],
        paymentMethod: 'cash', propertyId: f.propertyId,
        stay: { unitId: f.unitId, checkIn: '2026-10-01', guestName: 'Dale Carter' },
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/monthly rate/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(0)
  })

  it('a cashier with no pricing permission can still ring a stay', async () => {
    // The catalog check would otherwise refuse every stay, because the site's
    // rate and the item's sell_price are not the same number and are not meant
    // to be.
    const f = await seed()
    // A real desk worker: one landlord, scoped to the property they stand in.
    const deskUserId = (await query<any>(
      `INSERT INTO users (email, password_hash, first_name, last_name, role)
       VALUES ('desk652@t.dev','x','Desk','Worker','onsite_manager') RETURNING id`))[0].id
    await query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1,$2,ARRAY[$3]::uuid[],FALSE)`,
      [deskUserId, f.landlordId, f.propertyId])
    const cashier = jwt.sign(
      // A team role carries ONE landlord as `landlordId` (S82), not the account's
      // `landlordIds` list — that claim is a landlord's own.
      { userId: deskUserId, role: 'onsite_manager', email: 'desk652@t.dev',
        landlordId: f.landlordId, permissions: { 'pos.ring_sale': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${cashier}`)
      .send({
        items: [{ id: f.itemId, name: 'RV site', qty: 3, price: 49, tax: 0 }],
        paymentMethod: 'cash', propertyId: f.propertyId,
        stay: { unitId: f.unitId, checkIn: '2026-10-01', guestName: 'Dale Carter' },
      })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBe(120)
  })
})

describe('what the cashier is offered', () => {
  it('lists only sites that are actually free', async () => {
    const f = await seed()
    const free = () => request(buildApp())
      .get(`/api/pos/stays/available?propertyId=${f.propertyId}&checkIn=2026-10-01&stayUnit=night&qty=3`)
      .set('Authorization', `Bearer ${f.token}`)

    expect((await free()).body.data.units).toHaveLength(1)
    await sell(f)
    // Now booked — and gone from the list, rather than offered and refused at
    // the counter with a customer standing there.
    const after = await free()
    expect(after.body.data.units).toHaveLength(0)
    expect(after.body.data.checkOut).toBe('2026-10-04')
  })

  it('carries each site\'s own price and what the site IS', async () => {
    // Nic's counter script: the customer is told what is available — back-in,
    // pull-through, what amp service, and the price — and chooses from that.
    const f = await seed()
    const res = await request(buildApp())
      .get(`/api/pos/stays/available?propertyId=${f.propertyId}&checkIn=2026-10-01&stayUnit=night&qty=3`)
      .set('Authorization', `Bearer ${f.token}`)
    const [u] = res.body.data.units
    expect(u.rate).toBe(40)
    expect(u.lineTotal).toBe(120)
    expect(u.rvSiteLayout).toBe('pull_through')
    expect(u.rvAmpService).toBe('50')
  })

  it('still lists a site with no rate, because an empty site is not an occupied one', async () => {
    const f = await seed('month', 589, { night: 40, week: 200, month: null })
    const res = await request(buildApp())
      .get(`/api/pos/stays/available?propertyId=${f.propertyId}&checkIn=2026-10-01&stayUnit=month&qty=1`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.body.data.units).toHaveLength(1)
    expect(res.body.data.units[0].rate).toBeNull()
  })
})

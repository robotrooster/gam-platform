/**
 * 10/17 (Nic) — ONE HOME FOR A TAX RATE.
 *
 * A lodging rate lived in three places and they drifted: the property's stay
 * percentage (what actually priced a stay — still 6.35%), the named tax the
 * landlord changed to 6.6% on 9/25, and a legacy 6.35% on the stay items. So
 * every short-term stay was taxed at 6.35% for three weeks after the rate was
 * changed, and the figure the company files with the state did not match what
 * it collected.
 *
 * Nic: "ONE source of truth for a tax rate, the others following it or
 * retired... it must be impossible for a landlord to change a rate in one
 * screen and leave a stay priced at the old one. Owner AND bookkeeper may
 * change a rate. Journal every change with who and when so a filing traces to
 * the rate in force. A stay already priced and paid keeps the rate it was
 * charged at — never reprice history."
 *
 * What is pinned here:
 *   - the named tax list is the one home: a rate set (or turned off) there is
 *     what the property prices stays with, in the same breath;
 *   - the counter, a pay link and the booking site all quote that one rate —
 *     no second step, no second screen;
 *   - a stay is taxed ONCE: the tax is inside the price every door quotes, and
 *     the register's cart never taxes a stay line again — not even when the
 *     tax is ticked onto the site item, which is how the rate used to be said;
 *   - a tax on goods still reaches the goods;
 *   - a stay already priced keeps the rate it was charged at;
 *   - every change is kept with who made it and when.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { posRouter } from '../routes/pos'
import { errorHandler } from '../middleware/errorHandler'
import { calculateCartTax } from './posTax'
import { priceWholeStay, priceStayBySchedule, reservationDue, stayTaxRate, taxInside, taxInsidePayment } from './registerStay'
import { resolvePropertyById, bookableUnits, groupSiteTypes, typeAvailability } from './propertyBookingQuote'
import { isBookkeeperRequestAllowed, bookkeeperHasPerm } from '../lib/bookkeeperAccess'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stay_tax_one_home'
})

const round2 = (n: number) => Math.round(n * 100) / 100

interface World {
  userId: string
  landlordId: string
  propertyId: string
  unitId: string
  /** "RV site — daily": the register's own stay item, carrying the stale 6.35%. */
  stayItemId: string
  /** Propane: ordinary goods, so a goods tax can be shown still reaching them. */
  goodsItemId: string
  token: string
}

/** A park that takes stays at $100 a night, on its booking site and at its counter. */
async function world(): Promise<World> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query(
      `UPDATE properties SET public_booking_enabled = TRUE, booking_slug = $2, booking_deposit_pct = 10,
              nightly_rate = 100, weekly_rate = 600, monthly_rate = 2000, timezone = 'America/Phoenix'
        WHERE id = $1`, [propertyId, `park-${randomUUID().slice(0, 8)}`])
    await c.query(
      `UPDATE units SET is_bookable = TRUE, lease_types_allowed = ARRAY['nightly','weekly']::text[],
              nightly_rate = 100, weekly_rate = 600, monthly_rate = 2000
        WHERE id = $1`, [unitId])
    const catId = (await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, property_id) VALUES ($1, 'Sites', $2) RETURNING id`,
      [landlordId, propertyId])).rows[0].id
    // The stale third copy of the rate, exactly as production had it.
    const stayItemId = (await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, tax_rate, stay_unit)
       VALUES ($1, $2, $3, 'RV site — daily', 100, 0.0635, 'night') RETURNING id`,
      [landlordId, propertyId, catId])).rows[0].id
    const goodsItemId = (await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, tax_rate)
       VALUES ($1, $2, $3, 'Propane', 3.30, 0) RETURNING id`,
      [landlordId, propertyId, catId])).rows[0].id
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'owner@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, stayItemId, goodsItemId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** The percent the property prices a stay with, as every door reads it. */
async function stayTaxPct(propertyId: string): Promise<number> {
  return Number((await db.query<{ p: string }>(
    `SELECT short_term_tax_rate::text AS p FROM properties WHERE id = $1`, [propertyId])).rows[0].p)
}

/** Add a named tax on the Taxes screen. `onStays` is the one tick that prices a stay. */
async function addTax(w: World, body: Record<string, unknown>) {
  const res = await request(buildApp()).post('/api/pos/tax-rates')
    .set('Authorization', `Bearer ${w.token}`)
    .send({ propertyId: w.propertyId, ...body })
  expect(res.status).toBe(201)
  return res.body.data
}

async function changeTax(w: World, id: string, body: Record<string, unknown>) {
  const res = await request(buildApp()).patch(`/api/pos/tax-rates/${id}`)
    .set('Authorization', `Bearer ${w.token}`).send(body)
  expect(res.status).toBe(200)
  return res.body.data
}

/** The booking site's own quote for `nights` at this park. */
async function bookingSiteQuote(w: World, checkIn: string, checkOut: string, nights: number) {
  const prop = await resolvePropertyById(w.propertyId)
  expect(prop).not.toBeNull()
  const types = groupSiteTypes(await bookableUnits(w.propertyId))
  expect(types.length).toBe(1)
  return typeAvailability(prop!, types[0], nights, checkIn, checkOut)
}

describe('the named tax list is the one home for a stay rate', () => {
  it('a rate ticked "charged on a stay here" is what the property prices stays with', async () => {
    const w = await world()
    expect(await stayTaxPct(w.propertyId)).toBe(0)
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    expect(tax.on_stays).toBe(true)
    expect(await stayTaxPct(w.propertyId)).toBe(6.35)
  })

  it('changing the rate moves the stay price in the same breath — no second screen', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    // Amado, unincorporated Santa Cruz County: 5.5% state + 1.1% county.
    await changeTax(w, tax.id, { rate: 0.066 })
    expect(await stayTaxPct(w.propertyId)).toBe(6.60)
  })

  it('an ordinary sales tax never touches what a stay is priced at', async () => {
    const w = await world()
    await addTax(w, { name: 'Transaction privilege tax', rate: 0.066, itemIds: [w.goodsItemId] })
    expect(await stayTaxPct(w.propertyId)).toBe(0)
  })

  it('turning the stay tax off stops taxing stays here', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.066, onStays: true })
    expect(await stayTaxPct(w.propertyId)).toBe(6.60)
    const gone = await request(buildApp()).delete(`/api/pos/tax-rates/${tax.id}`)
      .set('Authorization', `Bearer ${w.token}`)
    expect(gone.status).toBe(200)
    expect(await stayTaxPct(w.propertyId)).toBe(0)
  })
})

describe('every door quotes the one rate', () => {
  it('the counter, a pay link and the booking site all move with it, together', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })

    // Three nights at $100, before and after the rate is changed.
    const counterBefore = await priceWholeStay(db, w.unitId, 'night', 3, '2026-11-02')
    expect(counterBefore.base).toBe(300)
    expect(counterBefore.taxRate).toBe(0.0635)
    expect(counterBefore.tax).toBe(19.05)

    await changeTax(w, tax.id, { rate: 0.066 })

    // The counter (registerStay priceWholeStay — what "Charge" rings up).
    const counter = await priceWholeStay(db, w.unitId, 'night', 3, '2026-11-02')
    expect(counter.taxRate).toBe(0.066)
    expect(counter.tax).toBe(19.80)
    expect(counter.total).toBe(319.80)

    // A pay link / the schedule (priceStayBySchedule — "Send link").
    const link = await priceStayBySchedule(db, w.unitId, '2026-11-02', '2026-11-05')
    expect(link.taxRate).toBe(0.066)
    expect(link.tax).toBe(19.80)
    expect(link.total).toBe(319.80)

    // The booking site's own quote.
    const site = await bookingSiteQuote(w, '2026-11-02', '2026-11-05', 3)
    expect(site.available).toBe(true)
    expect(site.base).toBe(300)
    expect(site.tax).toBe(19.80)
    expect(site.total).toBe(319.80)
  })
})

describe('a stay is taxed once', () => {
  it('the register never taxes a stay line — not even with the tax ticked on the site item', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.066, onStays: true })
    // How the rate used to be said: ticked onto the site items. Harmless now.
    await changeTax(w, tax.id, { itemIds: [w.stayItemId] })

    const cart = await calculateCartTax(w.landlordId, [{ itemId: w.stayItemId, qty: 3, unitPrice: 100 }])
    expect(cart.subtotal).toBe(300)
    expect(cart.taxAmount).toBe(0)
    expect(cart.lines[0].appliedRates).toEqual([])

    // The one helping of tax is the one inside the price the guest is quoted.
    const priced = await priceWholeStay(db, w.unitId, 'night', 3, '2026-11-02')
    expect(priced.tax).toBe(19.80)
    expect(taxInside(priced.total, priced.taxRate)).toBe(19.80)
  })

  it('the stay item\'s own legacy rate is never charged either', async () => {
    const w = await world()
    // No named tax at all: the item still carries the old 6.35%, and a stay is
    // still not taxed by the cart — its tax comes from the one home or nowhere.
    const cart = await calculateCartTax(w.landlordId, [{ itemId: w.stayItemId, qty: 1, unitPrice: 100 }])
    expect(cart.taxAmount).toBe(0)
    expect(await stayTaxPct(w.propertyId)).toBe(0)
  })

  it('a tax on goods still reaches the goods', async () => {
    const w = await world()
    await addTax(w, { name: 'Lodging tax', rate: 0.066, onStays: true })
    await addTax(w, { name: 'Transaction privilege tax', rate: 0.066, itemIds: [w.goodsItemId] })
    const cart = await calculateCartTax(w.landlordId, [{ itemId: w.goodsItemId, qty: 4, unitPrice: 3.30 }])
    expect(cart.subtotal).toBe(13.20)
    expect(cart.taxAmount).toBe(0.87)
    expect(cart.lines[0].appliedRates.map((r) => r.name)).toEqual(['Transaction privilege tax'])
  })

  it('a deposit and the arrival balance add up to the tax inside the stay, exactly once', async () => {
    const w = await world()
    await addTax(w, { name: 'Lodging tax', rate: 0.066, onStays: true })
    const priced = await priceWholeStay(db, w.unitId, 'night', 3, '2026-11-02')
    const deposit = 31.98   // 10% of the quoted total, as the booking site asks
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status,
                                  total_amount, deposit_amount, deposit_paid_at, source)
       VALUES ($1,$2,'2026-11-02','2026-11-05','2026-11-05','nightly','confirmed',$3,$4,now(),'public')
       RETURNING id`, [w.unitId, w.landlordId, priced.total, deposit])).rows[0].id

    const due = await reservationDue(db, bookingId)
    expect(due).not.toBeNull()
    expect(due!.paid).toBe(deposit)
    const rate = stayTaxRate(due!.rates, due!.taxPct, due!.bookedNights,
      { checkIn: due!.checkIn, total: due!.total, monthStay: due!.monthStay })
    expect(rate).toBe(0.066)
    const onDeposit = taxInsidePayment(0, deposit, rate)
    const onBalance = taxInsidePayment(deposit, due!.owed, rate)
    expect(round2(onDeposit + onBalance)).toBe(priced.tax)
  })
})

describe('a stay already priced keeps the rate it was charged at', () => {
  it('a later change to the named tax does not re-rate a stay already sold', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const priced = await priceWholeStay(db, w.unitId, 'night', 3, '2026-11-02')
    expect(priced.total).toBe(319.05)
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status, total_amount)
       VALUES ($1,$2,'2026-11-02','2026-11-05','2026-11-05','nightly','confirmed',$3) RETURNING id`,
      [w.unitId, w.landlordId, priced.total])).rows[0].id
    // The rate it was priced at is stamped on it.
    expect(Number((await db.query<{ r: string }>(
      `SELECT stay_tax_rate::text AS r FROM unit_bookings WHERE id = $1`, [bookingId])).rows[0].r)).toBe(0.0635)

    await changeTax(w, tax.id, { rate: 0.066 })

    const due = await reservationDue(db, bookingId)
    expect(due!.taxPct).toBe(6.35)
    const rate = stayTaxRate(due!.rates, due!.taxPct, due!.bookedNights,
      { checkIn: due!.checkIn, total: due!.total, monthStay: due!.monthStay })
    expect(rate).toBe(0.0635)
    // What is owed on it still has the 6.35% it was sold with inside it.
    expect(taxInsidePayment(0, due!.owed, rate)).toBe(19.05)
    // And a stay priced from now on is priced at the new rate.
    expect((await priceWholeStay(db, w.unitId, 'night', 3, '2026-12-02')).taxRate).toBe(0.066)
  })

  it('repricing the stay on the schedule stamps the rate it is repriced at', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status, total_amount)
       VALUES ($1,$2,'2026-11-02','2026-11-05','2026-11-05','nightly','confirmed',319.05) RETURNING id`,
      [w.unitId, w.landlordId])).rows[0].id
    await changeTax(w, tax.id, { rate: 0.066 })
    // The schedule reprices those nights: 3 × $100 + 6.6%.
    const again = await priceStayBySchedule(db, w.unitId, '2026-11-02', '2026-11-05')
    await db.query(`UPDATE unit_bookings SET total_amount = $2 WHERE id = $1`, [bookingId, again.total])
    const due = await reservationDue(db, bookingId)
    expect(due!.taxPct).toBe(6.60)
  })
})

describe('every change is kept, with who and when', () => {
  it('the journal has the rate before and after, and the person who changed it', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    await changeTax(w, tax.id, { rate: 0.066 })

    const res = await request(buildApp())
      .get(`/api/pos/tax-rates/changes?propertyId=${w.propertyId}`)
      .set('Authorization', `Bearer ${w.token}`)
    expect(res.status).toBe(200)
    const rows = res.body.data
    expect(rows).toHaveLength(2)
    // Newest first: 6.35% → 6.6%.
    expect(rows[0].name).toBe('Lodging tax')
    expect(rows[0].old_rate).toBe(0.0635)
    expect(rows[0].new_rate).toBe(0.066)
    expect(rows[0].new_on_stays).toBe(true)
    expect(rows[0].changed_by).toBe(w.userId)
    expect(rows[0].changed_at).toBeTruthy()
    // The tax being made in the first place: nothing before it.
    expect(rows[1].old_rate).toBeNull()
    expect(rows[1].new_rate).toBe(0.0635)
    expect(rows[1].changed_by).toBe(w.userId)
  })

  it('turning a tax off is kept too', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.066, onStays: true })
    await request(buildApp()).delete(`/api/pos/tax-rates/${tax.id}`)
      .set('Authorization', `Bearer ${w.token}`)
    const res = await request(buildApp()).get('/api/pos/tax-rates/changes')
      .set('Authorization', `Bearer ${w.token}`)
    expect(res.body.data[0].old_is_active).toBe(true)
    expect(res.body.data[0].new_is_active).toBe(false)
    expect(res.body.data[0].changed_by).toBe(w.userId)
  })

  it('the journal cannot be edited or thrown away', async () => {
    const w = await world()
    await addTax(w, { name: 'Lodging tax', rate: 0.066, onStays: true })
    await expect(db.query(`UPDATE pos_tax_rate_changes SET new_rate = 0.01 WHERE landlord_id = $1`, [w.landlordId]))
      .rejects.toThrow(/append-only/i)
    await expect(db.query(`DELETE FROM pos_tax_rate_changes WHERE landlord_id = $1`, [w.landlordId]))
      .rejects.toThrow(/append-only/i)
  })
})

describe('owner AND bookkeeper may change a rate (Nic)', () => {
  it('the tax list is the only part of the register a bookkeeper reaches', async () => {
    const id = randomUUID()
    expect(isBookkeeperRequestAllowed('GET', '/api/pos/tax-rates')).toBe(true)
    expect(isBookkeeperRequestAllowed('GET', '/api/pos/tax-rates/changes')).toBe(true)
    expect(isBookkeeperRequestAllowed('POST', '/api/pos/tax-rates')).toBe(true)
    expect(isBookkeeperRequestAllowed('PATCH', `/api/pos/tax-rates/${id}`)).toBe(true)
    expect(isBookkeeperRequestAllowed('DELETE', `/api/pos/tax-rates/${id}`)).toBe(true)
    // Nothing else of the register: not the items, the sales or the customers.
    for (const [method, path] of [
      ['GET', '/api/pos/items'], ['PATCH', `/api/pos/items/${id}`], ['POST', '/api/pos/transactions'],
      ['GET', '/api/pos/customers'], ['GET', '/api/pos/transactions'], ['POST', '/api/pos/cart-quote'],
    ] as const) {
      expect(isBookkeeperRequestAllowed(method, path), `${method} ${path}`).toBe(false)
    }
  })

  it('a bookkeeper holds the key the tax routes ask for, and no register key', async () => {
    expect(bookkeeperHasPerm({}, 'taxes.edit')).toBe(true)
    expect(bookkeeperHasPerm({}, 'pos.manage_inventory')).toBe(false)
    expect(bookkeeperHasPerm({}, 'pos.ring_sale')).toBe(false)
  })

  it('the company\'s bookkeeper changes the rate, the stay price follows, and the journal names them', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const bkId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'Bo', 'Keeper', TRUE) RETURNING id`,
      [`bk-${randomUUID()}@test.dev`])).rows[0].id
    await db.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide)
       VALUES ($1, $2, 'read_only', $3, TRUE)`, [bkId, w.landlordId, [w.propertyId]])
    const bkToken = jwt.sign(
      { userId: bkId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: w.landlordId,
        permissions: { access_level: 'read_only' } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    const changed = await request(buildApp()).patch(`/api/pos/tax-rates/${tax.id}`)
      .set('Authorization', `Bearer ${bkToken}`).send({ rate: 0.066 })
    expect(changed.status).toBe(200)
    expect(await stayTaxPct(w.propertyId)).toBe(6.60)
    expect((await priceWholeStay(db, w.unitId, 'night', 3, '2026-11-02')).taxRate).toBe(0.066)

    const journal = await request(buildApp()).get('/api/pos/tax-rates/changes')
      .set('Authorization', `Bearer ${bkToken}`)
    expect(journal.status).toBe(200)
    expect(journal.body.data[0].changed_by).toBe(bkId)
    expect(journal.body.data[0].changed_by_name).toBe('Bo Keeper')

    // And nothing else of the register opens to them.
    const items = await request(buildApp()).get('/api/pos/items')
      .set('Authorization', `Bearer ${bkToken}`)
    expect(items.status).toBe(403)
  })
})

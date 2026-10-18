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
import { isBookkeeperRequestAllowed, bookkeeperHasPerm, BOOKKEEPER_GRANTED_PERMS, TAXES_EDIT_PERM } from '../lib/bookkeeperAccess'
import { ALL_CATALOG_PERMISSION_KEYS } from '@gam/shared'
import { camelCaseKeys } from '../lib/caseConversion'

/**
 * The app as it is DEPLOYED: every response passes the outgoing camelCase
 * middleware (index.ts) on its way out, which is the shape the Sales & Tax
 * card and the register's Taxes screen read. Asserting the snake_case the DB
 * hands back would test a response nobody is ever served.
 */
function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use((_req, res, next) => {
    const json = res.json.bind(res)
    res.json = (body: any) => json(camelCaseKeys(body))
    next()
  })
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
    expect(tax.onStays).toBe(true)
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
    expect(rows[0].oldRate).toBe(0.0635)
    expect(rows[0].newRate).toBe(0.066)
    expect(rows[0].newOnStays).toBe(true)
    expect(rows[0].changedBy).toBe(w.userId)
    expect(rows[0].changedAt).toBeTruthy()
    // The tax being made in the first place: nothing before it.
    expect(rows[1].oldRate).toBeNull()
    expect(rows[1].newRate).toBe(0.0635)
    expect(rows[1].changedBy).toBe(w.userId)
  })

  it('turning a tax off is kept too', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.066, onStays: true })
    await request(buildApp()).delete(`/api/pos/tax-rates/${tax.id}`)
      .set('Authorization', `Bearer ${w.token}`)
    const res = await request(buildApp()).get('/api/pos/tax-rates/changes')
      .set('Authorization', `Bearer ${w.token}`)
    expect(res.body.data[0].oldIsActive).toBe(true)
    expect(res.body.data[0].newIsActive).toBe(false)
    expect(res.body.data[0].changedBy).toBe(w.userId)
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
    expect(isBookkeeperRequestAllowed('PATCH', `/api/pos/tax-rates/${id}`)).toBe(true)
    // Nic's words reach a RATE. Making a tax and removing one are the owner's:
    // a removal untaxes every stay booked after it, which is not a correction.
    expect(isBookkeeperRequestAllowed('POST', '/api/pos/tax-rates')).toBe(false)
    expect(isBookkeeperRequestAllowed('DELETE', `/api/pos/tax-rates/${id}`)).toBe(false)
    // Nothing else of the register: not the items, the sales or the customers.
    for (const [method, path] of [
      ['GET', '/api/pos/items'], ['PATCH', `/api/pos/items/${id}`], ['POST', '/api/pos/transactions'],
      ['GET', '/api/pos/customers'], ['GET', '/api/pos/transactions'], ['POST', '/api/pos/cart-quote'],
    ] as const) {
      expect(isBookkeeperRequestAllowed(method, path), `${method} ${path}`).toBe(false)
    }
  })

  it('a bookkeeper holds the key the tax routes ask for, and no register key', async () => {
    expect(bookkeeperHasPerm({}, TAXES_EDIT_PERM)).toBe(true)
    expect(bookkeeperHasPerm({}, 'pos.manage_inventory')).toBe(false)
    expect(bookkeeperHasPerm({}, 'pos.ring_sale')).toBe(false)
  })

  it('that key is a real permission, in the one catalog every key lives in', async () => {
    // A key that exists only as a string in two API files can never be granted
    // or seen on the permissions page, and nothing holds it in step
    // (CLAUDE.md, single source of truth). Every key a bookkeeper holds is a
    // catalog key.
    expect(ALL_CATALOG_PERMISSION_KEYS).toContain(TAXES_EDIT_PERM)
    for (const k of BOOKKEEPER_GRANTED_PERMS) expect(ALL_CATALOG_PERMISSION_KEYS, k).toContain(k)
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
    expect(journal.body.data[0].changedBy).toBe(bkId)
    expect(journal.body.data[0].changedByName).toBe('Bo Keeper')

    // And nothing else of the register opens to them.
    const items = await request(buildApp()).get('/api/pos/items')
      .set('Authorization', `Bearer ${bkToken}`)
    expect(items.status).toBe(403)

    // The RATE, and only the rate: turning the tax off by another name, moving
    // it to another park or taking it off stays is the owner's. The refusal
    // says where it is done rather than just "no".
    for (const body of [{ isActive: false }, { onStays: false }, { name: 'Something else' },
                        { rate: 0.07, isActive: false }, { appliesTo: ['all'] }]) {
      const no = await request(buildApp()).patch(`/api/pos/tax-rates/${tax.id}`)
        .set('Authorization', `Bearer ${bkToken}`).send(body)
      expect(no.status, JSON.stringify(body)).toBe(403)
      expect(no.body.error).toMatch(/Taxes screen/)
    }
    // Nothing moved: the stay is still priced at the rate they set.
    expect(await stayTaxPct(w.propertyId)).toBe(6.60)
  })

  it('a bookkeeper kept to one park never sees or moves another park\'s rate', async () => {
    // Nic, on a bookkeeper: "They don't need to see anything with Oak Park."
    const w = await world()
    const theirs = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const c = await db.connect()
    let otherProp: string
    let otherTax: string
    try {
      otherProp = await seedProperty(c, { landlordId: w.landlordId, ownerUserId: w.userId, managedByUserId: w.userId })
      otherTax = (await c.query<{ id: string }>(
        `INSERT INTO pos_tax_rates (landlord_id, property_id, name, rate, tax_type, applies_to, on_stays)
         VALUES ($1, $2, 'Lodging tax', 0.12, 'sales', '{}'::text[], TRUE) RETURNING id`,
        [w.landlordId, otherProp])).rows[0].id
    } finally { c.release() }

    const bkId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'bookkeeper', 'One', 'Park', TRUE) RETURNING id`,
      [`bk-${randomUUID()}@test.dev`])).rows[0].id
    await db.query(
      `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide)
       VALUES ($1, $2, 'read_write', $3, FALSE)`, [bkId, w.landlordId, [w.propertyId]])
    const bkToken = jwt.sign(
      { userId: bkId, role: 'bookkeeper', email: 'bk@t.dev', profileId: null, landlordId: w.landlordId,
        permissions: { access_level: 'read_write' } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    // The list and the journal hold their park only.
    const list = await request(buildApp()).get('/api/pos/tax-rates')
      .set('Authorization', `Bearer ${bkToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data.map((r: any) => r.id)).toEqual([theirs.id])
    const journal = await request(buildApp()).get('/api/pos/tax-rates/changes')
      .set('Authorization', `Bearer ${bkToken}`)
    expect(journal.body.data.map((r: any) => r.rateId)).toEqual([theirs.id])

    // And the other park's rate cannot be moved — which would have changed
    // what every stay there is priced at.
    const no = await request(buildApp()).patch(`/api/pos/tax-rates/${otherTax}`)
      .set('Authorization', `Bearer ${bkToken}`).send({ rate: 0.2 })
    expect(no.status).toBe(403)
    expect(await stayTaxPct(otherProp)).toBe(12.00)

    // Their own park's rate still is.
    const yes = await request(buildApp()).patch(`/api/pos/tax-rates/${theirs.id}`)
      .set('Authorization', `Bearer ${bkToken}`).send({ rate: 0.066 })
    expect(yes.status).toBe(200)
    expect(await stayTaxPct(w.propertyId)).toBe(6.60)
  })

  it('a clerk kept to one park cannot write the company\'s own rate', async () => {
    // A rate bound to no property prices stays at every park of the company.
    const w = await world()
    const staffId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Des', 'Clerk', TRUE) RETURNING id`,
      [`clerk-${randomUUID()}@test.dev`])).rows[0].id
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3, FALSE)`, [staffId, w.landlordId, [w.propertyId]])
    const token = jwt.sign(
      { userId: staffId, role: 'onsite_manager', email: 'clerk@t.dev', profileId: null, landlordId: w.landlordId,
        permissions: { 'pos.manage_inventory': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })

    const wide = await request(buildApp()).post('/api/pos/tax-rates')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Lodging tax', rate: 0.2, onStays: true })
    expect(wide.status).toBe(403)
    expect(wide.body.error).toMatch(/account owner/)
    expect(await stayTaxPct(w.propertyId)).toBe(0)

    // Their own park's, they may.
    const mine = await request(buildApp()).post('/api/pos/tax-rates')
      .set('Authorization', `Bearer ${token}`)
      .send({ propertyId: w.propertyId, name: 'Lodging tax', rate: 0.066, onStays: true })
    expect(mine.status).toBe(201)
    expect(await stayTaxPct(w.propertyId)).toBe(6.60)
  })
})

describe('a price change never re-rates a stay that took money (review 10/17)', () => {
  /** A three-night stay sold and PAID at `pct`, with its payment on record. */
  async function soldAndPaid(w: World, pct: number): Promise<{ bookingId: string; total: number }> {
    const priced = await priceWholeStay(db, w.unitId, 'night', 3, '2026-11-02')
    expect(priced.taxRate).toBe(pct)
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status,
                                  total_amount, deposit_amount, deposit_paid_at, balance_paid_at, source)
       VALUES ($1,$2,'2026-11-02','2026-11-05','2026-11-05','nightly','confirmed',$3,$3,now(),now(),'desk')
       RETURNING id`, [w.unitId, w.landlordId, priced.total])).rows[0].id
    // The deposit's own row, as the booking site's webhook writes it.
    await db.query(
      `INSERT INTO stay_payments (booking_id, landlord_id, kind, method, stripe_payment_intent_id,
                                  toward_stay, lodging_tax_amount)
       VALUES ($1, $2, 'site_deposit', 'card', $3, $4, $5)`,
      [bookingId, w.landlordId, `pi_${randomUUID().slice(0, 12)}`,
       priced.total.toFixed(2), priced.tax.toFixed(2)])
    return { bookingId, total: priced.total }
  }

  const stampOf = async (bookingId: string) => Number((await db.query<{ r: string }>(
    `SELECT stay_tax_rate::text AS r FROM unit_bookings WHERE id = $1`, [bookingId])).rows[0].r)

  it('charging only the nights stayed keeps the rate the money came in at', async () => {
    // The guest paid 3 nights at 6.35%. The rate then went to 6.6%, and the
    // early check-out writes a new price — which used to re-stamp the stay at
    // 6.6% and hand back tax at a rate nobody was ever charged.
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const { bookingId } = await soldAndPaid(w, 0.0635)
    await changeTax(w, tax.id, { rate: 0.066 })

    // What services/earlyCheckOut writes for 'nights_only' (2 nights kept).
    await db.query(
      `UPDATE unit_bookings SET total_amount = $2, platform_fee = 0,
              booked_check_out = check_out, updated_at = NOW() WHERE id = $1`, [bookingId, '212.70'])
    expect(await stampOf(bookingId)).toBe(0.0635)
    const due = await reservationDue(db, bookingId)
    expect(due!.taxPct).toBe(6.35)
    // And what the early check-out itself reads to work out the money going
    // back (services/earlyCheckOut loadStay) is that same 6.35%.
    const { loadStay } = await import('./earlyCheckOut')
    expect((await loadStay(db, bookingId))!.tax_pct).toBe(6.35)
  })

  it('a month added at the counter keeps it too, and so does taking the month back', async () => {
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const { bookingId, total } = await soldAndPaid(w, 0.0635)
    await changeTax(w, tax.id, { rate: 0.066 })

    // registerStay extendStayByMonth: the month's price is added on.
    await db.query(
      `UPDATE unit_bookings SET check_out = '2026-12-05', booked_check_out = '2026-12-05', nights = 33,
              total_amount = COALESCE(total_amount, 0) + 2000, balance_paid_at = NULL WHERE id = $1`, [bookingId])
    expect(await stampOf(bookingId)).toBe(0.0635)
    // undoStayExtension: and back off again.
    await db.query(
      `UPDATE unit_bookings SET check_out = '2026-11-05', booked_check_out = '2026-11-05', nights = 3,
              total_amount = total_amount - 2000 WHERE id = $1`, [bookingId])
    expect(await stampOf(bookingId)).toBe(0.0635)
    expect(Number((await db.query<{ t: string }>(
      `SELECT total_amount::text AS t FROM unit_bookings WHERE id = $1`, [bookingId])).rows[0].t)).toBe(total)
  })

  it('money on record is enough on its own, with no paid stamp on the booking', async () => {
    // The paid flags and the stay's payment rows are two different records of
    // the same fact, and a part-paid stay can carry the rows without the
    // flags. Either one means money came in at the old rate.
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status, total_amount)
       VALUES ($1,$2,'2026-11-02','2026-11-05','2026-11-05','nightly','confirmed',319.05) RETURNING id`,
      [w.unitId, w.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO stay_payments (booking_id, landlord_id, kind, method, stripe_payment_intent_id,
                                  toward_stay, lodging_tax_amount)
       VALUES ($1, $2, 'site_deposit', 'card', $3, 31.91, 1.91)`,
      [bookingId, w.landlordId, `pi_${randomUUID().slice(0, 12)}`])
    await changeTax(w, tax.id, { rate: 0.066 })
    await db.query(`UPDATE unit_bookings SET total_amount = 212.70 WHERE id = $1`, [bookingId])
    expect(await stampOf(bookingId)).toBe(0.0635)
  })

  it('a stay that has taken nothing is re-priced at today\'s rate', async () => {
    // Nic's rule is about money already collected. A hold nobody has paid a
    // cent on carries no old rate to protect, so a date change prices it now.
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status, total_amount)
       VALUES ($1,$2,'2026-11-02','2026-11-05','2026-11-05','nightly','confirmed',319.05) RETURNING id`,
      [w.unitId, w.landlordId])).rows[0].id
    expect(await stampOf(bookingId)).toBe(0.0635)
    await changeTax(w, tax.id, { rate: 0.066 })
    const again = await priceStayBySchedule(db, w.unitId, '2026-11-02', '2026-11-05')
    await db.query(`UPDATE unit_bookings SET total_amount = $2 WHERE id = $1`, [bookingId, again.total])
    expect(await stampOf(bookingId)).toBe(0.066)
  })

  it('the booking site\'s deposit records the rate the card was charged at', async () => {
    // The booking row exists before the deposit lands (the checkout session is
    // stored on it), and a rate change in between is now instant — so the one
    // STORED tax figure has to come off the stay's own stamp, not off the
    // property's rate at webhook time.
    const w = await world()
    const tax = await addTax(w, { name: 'Lodging tax', rate: 0.0635, onStays: true })
    const priced = await priceWholeStay(db, w.unitId, 'night', 3, '2026-11-02')
    const bookingId = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, booked_check_out, lease_type, status,
                                  total_amount, source)
       VALUES ($1,$2,'2026-11-02','2026-11-05','2026-11-05','nightly','confirmed',$3,'public') RETURNING id`,
      [w.unitId, w.landlordId, priced.total])).rows[0].id
    await changeTax(w, tax.id, { rate: 0.066 })

    const deposit = 31.91
    const { siteDepositLodgingTax } = await import('./stayPayments')
    // 31.91 − ROUND(31.91 ÷ 1.0635, 2) = 31.91 − 30.00 = 1.91, at 6.35%.
    expect(await siteDepositLodgingTax(db, bookingId, deposit)).toBe(1.91)
  })
})

describe('a property added after the tax was named follows it (review 10/17)', () => {
  it('a park born under a company-wide lodging tax is priced at it, not at nothing', async () => {
    const w = await world()
    // A company-wide rate: no property named, so it reaches every park.
    const wide = await request(buildApp()).post('/api/pos/tax-rates')
      .set('Authorization', `Bearer ${w.token}`)
      .send({ name: 'Lodging tax', rate: 0.066, onStays: true })
    expect(wide.status).toBe(201)
    expect(await stayTaxPct(w.propertyId)).toBe(6.60)

    const c = await db.connect()
    let later: string
    try {
      later = await seedProperty(c, { landlordId: w.landlordId, ownerUserId: w.userId, managedByUserId: w.userId })
    } finally { c.release() }
    // Before the fix this read 0.00 while the one home said 6.6%, and nothing
    // but an unrelated tax edit would ever have corrected it.
    expect(await stayTaxPct(later)).toBe(6.60)
  })

  it('a park whose company names no stay tax is left at nothing', async () => {
    const w = await world()
    const c = await db.connect()
    let later: string
    try {
      later = await seedProperty(c, { landlordId: w.landlordId, ownerUserId: w.userId, managedByUserId: w.userId })
    } finally { c.release() }
    expect(await stayTaxPct(later)).toBe(0)
  })
})

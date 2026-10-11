/**
 * S652 — a sale written up where the goods are measured, settled where the
 * customer is.
 *
 * Nic, on propane delivered off the park: "we would need to somehow create the
 * tickets in the office because that's where the dispenser is pumping propane
 * and you have to reset the propane counter before you can pump the next
 * person. So we need a list of who the tank belongs to and how many gallons
 * went into it."
 *
 * And why it is not a pay link: "That's product actually out and payment needs
 * to be rendered right then instead of chasing somebody down later."
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
      lines: cart.map((l) => ({ ...l, taxRate: 0, tax: 0 })),
    }),
  }
})

// 10/2: the reader's breakdown is checked for WHO it names; the Stripe side is mocked.
const { showCartOnReaderMock, clearCartOnReaderMock } = vi.hoisted(() => ({
  showCartOnReaderMock: vi.fn(async (_o: any): Promise<any> => true),
  clearCartOnReaderMock: vi.fn(async (_r: string, _o: string): Promise<any> => true),
}))
vi.mock('../services/posTerminal', async (orig) => ({
  ...(await orig<any>()),
  showCartOnReader: showCartOnReaderMock,
  clearCartOnReader: clearCartOnReaderMock,
  readerAction: vi.fn(async () => null),
  holdForTheCart: vi.fn(async () => undefined),
}))

let posRouter: any, errorHandler: any
beforeEach(async () => {
  showCartOnReaderMock.mockClear(); clearCartOnReaderMock.mockClear()
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_tickets'
  ;({ posRouter } = await import('./pos'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

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

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const cat = await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1,'Fuel',1,TRUE) RETURNING id`, [landlordId])
    const item = await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Propane (per gal)',$3,3.30,0,0,99999,0,99999) RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])
    const stayItem = await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — nightly',$3,0,0,0,999,0,999,'night') RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])
    const cust = await c.query(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email)
       VALUES ($1,'Ray','Delgado','ray@t.dev') RETURNING id`, [landlordId])
    // A pay link refuses to go out with nowhere to pay the landlord, and that
    // check fires before anything these tests are about.
    await c.query(
      `UPDATE landlords SET stripe_connect_account_id = 'acct_652_' || replace($1::text,'-','')
        WHERE id = $1`, [landlordId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, itemId: item.rows[0].id, stayItemId: stayItem.rows[0].id,
             customerId: cust.rows[0].id, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const writeTicket = (f: any, body: any = {}) =>
  request(buildApp()).post('/api/pos/tickets').set('Authorization', `Bearer ${f.token}`)
    .send({
      propertyId: f.propertyId, posCustomerId: f.customerId,
      items: [{ id: f.itemId, name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 }],
      note: 'Two 20lb tanks, left by the gate', ...body,
    })

describe('writing a ticket up at the pump', () => {
  it('records who the tank belongs to and how many gallons went in', async () => {
    const f = await seed()
    const res = await writeTicket(f)
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const [t] = await query<any>(`SELECT * FROM pos_open_tickets`)
    expect(t.status).toBe('open')
    expect(t.pos_customer_id).toBe(f.customerId)
    expect(Number(t.items[0].qty)).toBe(18.4)
    expect(t.note).toMatch(/two 20lb tanks/i)
  })

  it('holds no total, because the price is decided when it is rung', async () => {
    // Freezing a price at write-up would be a second pricing authority, which
    // is the exact thing this session spent its morning deleting.
    const f = await seed()
    await writeTicket(f)
    const cols = await query<any>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'pos_open_tickets'`)
    const names = cols.map((c: any) => c.column_name)
    expect(names).not.toContain('total')
    expect(names).not.toContain('tax_amount')
  })

  it('refuses a ticket for nobody', async () => {
    const f = await seed()
    const res = await writeTicket(f, { posCustomerId: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/one person/i)
  })

  it('refuses an item that is not on the register', async () => {
    const f = await seed()
    const res = await writeTicket(f, {
      items: [{ id: '00000000-0000-0000-0000-000000000000', qty: 1 }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not on your register/i)
  })

  it('refuses a stay, which needs a site and dates', async () => {
    const f = await seed()
    const res = await writeTicket(f, { items: [{ id: f.stayItemId, qty: 1 }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/site and dates/i)
  })

  it('cannot be written against another company\'s customer', async () => {
    const f = await seed()
    const other = await seed()
    const res = await writeTicket(f, { posCustomerId: other.customerId })
    expect(res.status).toBe(404)
  })
})

describe('settling it at the door', () => {
  const settle = (f: any, ticketId: string, body: any = {}) =>
    request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [{ id: f.itemId, name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 }],
        paymentMethod: 'cash', propertyId: f.propertyId, posCustomerId: f.customerId,
        openTicketId: ticketId, ...body,
      })

  it('closes the ticket and points the sale back at it', async () => {
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    const res = await settle(f, t.id)
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const [ticket] = await query<any>(`SELECT status, settled_transaction_id FROM pos_open_tickets`)
    expect(ticket.status).toBe('settled')
    expect(ticket.settled_transaction_id).toBe(res.body.data.id)
    const [tx] = await query<any>(`SELECT open_ticket_id FROM pos_transactions`)
    expect(tx.open_ticket_id).toBe(t.id)
  })

  it('the second driver to open the same ticket loses, rather than charging twice', async () => {
    // Two phones on one ticket is the ordinary case, not the exotic one.
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    expect((await settle(f, t.id)).status).toBe(201)
    const again = await settle(f, t.id)
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already been settled/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(1)
  })

  it('a voided ticket cannot be settled', async () => {
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    await request(buildApp()).post(`/api/pos/tickets/${t.id}/void`)
      .set('Authorization', `Bearer ${f.token}`).send({ reason: 'Tank came back' })
    const res = await settle(f, t.id)
    expect(res.status).toBe(409)
  })

  it('10/3 (review) voiding an id that is no ticket of this company\'s says the ticket is gone, in plain words — never a raw database error', async () => {
    const f = await seed()
    const other = await seed()
    const theirs = (await writeTicket(other)).body.data
    const gone = 'That ticket is not on the open list any more — it may have been settled or voided at another register. Open the list again to see what is still out.'
    // Not a uuid at all; 36 characters that only look like one; a uuid that is no ticket; another company's ticket.
    for (const id of ['not-a-uuid', '------------------------------------', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa----',
                      '6f1c2a8e-0000-4000-8000-000000000000', theirs.id]) {
      const r = await request(buildApp()).post(`/api/pos/tickets/${id}/void`)
        .set('Authorization', `Bearer ${f.token}`).send({ reason: 'Tank came back' })
      expect(r.status, `${id}: ${JSON.stringify(r.body)}`).toBe(404)
      expect(r.body.error).toBe(gone)
    }
    expect((await query<any>(`SELECT status FROM pos_open_tickets WHERE id = $1`, [theirs.id]))[0].status).toBe('open')
  })

  it('a voided ticket is kept, with its reason', async () => {
    // GAM does not erase records, and an abandoned ticket is part of the story
    // of a day's deliveries.
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    await request(buildApp()).post(`/api/pos/tickets/${t.id}/void`)
      .set('Authorization', `Bearer ${f.token}`).send({ reason: 'Tank came back' })
    const [row] = await query<any>(`SELECT status, void_reason FROM pos_open_tickets`)
    expect(row.status).toBe('voided')
    expect(row.void_reason).toBe('Tank came back')
  })

  it('the driver sees only what is still out, with a name on it', async () => {
    const f = await seed()
    const open = (await writeTicket(f)).body.data
    const done = (await writeTicket(f)).body.data
    await settle(f, done.id)

    const list = await request(buildApp())
      .get(`/api/pos/tickets?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].id).toBe(open.id)
    expect(list.body.data[0].customerName).toBe('Ray Delgado')
  })
})

/**
 * S652 — a stay sent as a pay link takes the site off the board.
 *
 * Nic: "Think of the stays like almost inventory where I've only got so many
 * sites on January 12th. The inventory replenishes January 13th because it's a
 * new day and new nights can be paid for. So when I send a pay link, it should
 * use up inventory according to what spot was booked and for how long."
 *
 * The narrow failure this replaces: a cashier could tap a stay item into the
 * cart and press "Email a pay link" instead of taking payment. That path had no
 * notion of a site or a date to ask for, so it emailed a link, took money, and
 * the Master Schedule never heard about it.
 */
describe('a stay on a pay link', () => {
  let posPayLinksRouter: any
  beforeEach(async () => { ({ posPayLinksRouter } = await import('./posPayLinks')) })

  function linkApp() {
    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => {
      const originalJson = res.json.bind(res)
      res.json = (body: any) => originalJson(camelCaseKeys(body))
      next()
    })
    app.use("/api/pos/pay-links", posPayLinksRouter)
    app.use(errorHandler)
    return app
  }

  async function seedSite(f: any) {
    const u = await query<any>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                          nightly_rate, is_bookable)
       VALUES ($1,$2,'RV 01','vacant',500,'rv_spot',40,TRUE) RETURNING id`,
      [f.propertyId, f.landlordId])
    return u[0].id
  }

  const send = (f: any, body: any = {}) =>
    request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${f.token}`)
      .send({
        propertyId: f.propertyId, kind: 'one_time',
        customer: { name: 'Dale Carter', email: 'dale@t.dev' },
        items: [{ id: f.stayItemId, name: 'RV site — nightly', qty: 3, price: 49, tax: 0 }],
        ...body,
      })

  it('refuses to send without a site and a date', async () => {
    const f = await seed()
    const res = await send(f)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/site and an arrival date/i)
  })

  it('holds the site from the moment the link is sent, unpaid', async () => {
    const f = await seed()
    const unitId = await seedSite(f)
    const res = await send(f, { stay: { unitId, checkIn: '2027-01-12', guestName: 'Dale Carter' } })
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const [b] = await query<any>(
      `SELECT status, deposit_paid_at, hold_expires_at, check_in::text AS ci, check_out::text AS co,
              total_amount::text AS total
         FROM unit_bookings`)
    expect(b.status).toBe('tentative')       // spoken for, not sold
    expect(b.deposit_paid_at).toBeNull()     // and therefore displaceable
    expect(b.hold_expires_at).toBeNull()     // with no clock on it
    expect(b.ci).toBe('2027-01-12')
    expect(b.co).toBe('2027-01-15')          // three nights of inventory, not one
    // Priced from the SITE ($40), not the catalog price the browser sent ($49).
    expect(Number(b.total)).toBe(120)
  })

  it('will not sell the same nights twice', async () => {
    const f = await seed()
    const unitId = await seedSite(f)
    const first = await send(f, { stay: { unitId, checkIn: '2027-01-12', guestName: 'Dale Carter' } })
    expect(first.status).toBe(201)
    const second = await send(f, { stay: { unitId, checkIn: '2027-01-13', guestName: 'Pat Ruiz' } })
    expect(second.status).toBe(409)
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(1)
  })

  it('frees the inventory again on the next day', async () => {
    // "The inventory replenishes January 13th because it's a new day."
    const f = await seed()
    const unitId = await seedSite(f)
    const first = await send(f, { stay: { unitId, checkIn: '2027-01-12', guestName: 'Dale Carter' } })
    expect(first.status).toBe(201)
    const later = await send(f, { stay: { unitId, checkIn: '2027-01-15', guestName: 'Pat Ruiz' } })
    expect(later.status).toBe(201)
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(2)
  })
})

// S652 (Nic): "put the pay links as an open ticket as well. That way they can
// be resolved in person when somebody comes in."
describe('an emailed pay link on the open list', () => {
  const mkLink = async (f: any) => (await query<{ id: string }>(
    `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_name, customer_email)
     VALUES (md5(random()::text) || md5(random()::text), $1, $2,
             (SELECT user_id FROM landlords WHERE id = $1), 'one_time', '2 items', $3::jsonb, 649.72, 649.72, 'Andres Razo', 'razo@example.com')
     RETURNING id`,
    [f.landlordId, f.propertyId, JSON.stringify([
      { id: f.stayItemId, cat: 'Stays', name: 'RV site — nightly', qty: 1, price: 589, tax: 0 },
      { id: f.itemId, cat: 'Fuel', name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 },
    ])]))[0].id

  it('is listed beside the tickets, marked as a pay link', async () => {
    const f = await seed()
    await writeTicket(f)
    const link = await mkLink(f)
    const res = await request(buildApp()).get(`/api/pos/tickets?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const kinds = res.body.data.map((r: any) => r.kind).sort()
    expect(kinds).toEqual(['pay_link', 'ticket'])
    const row = res.body.data.find((r: any) => r.kind === 'pay_link')
    expect(row).toMatchObject({ id: link, customerName: 'Andres Razo' })
    expect(row.note).toMatch(/Emailed pay link/)
  })

  it('settled at the register, the link is paid and the sale points at it — cashier adjustments included, its stay line as sent', async () => {
    const f = await seed()
    const link = await mkLink(f)
    // The cashier loads the link and adds the 10 gallons pumped since it went out.
    const res = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [
                { id: f.stayItemId, name: 'RV site — nightly', qty: 1, price: 589, tax: 0 },
                { id: f.itemId, name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 },
                { id: f.itemId, name: 'Propane (per gal)', qty: 10, price: 3.30, tax: 0 },
              ],
              paymentMethod: 'cash', propertyId: f.propertyId, payLinkId: link })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBeCloseTo(682.72, 2)   // 649.72 + 10 × 3.30
    const [l] = await query<any>(`SELECT status, pos_transaction_id FROM pos_pay_links WHERE id = $1`, [link])
    expect(l.status).toBe('paid')
    expect(l.pos_transaction_id).toBe(res.body.data.id)
    const [tx] = await query<any>(`SELECT pay_link_id FROM pos_transactions`)
    expect(tx.pay_link_id).toBe(link)
    // Gone from the open list, and it cannot be settled twice.
    const list = await request(buildApp()).get(`/api/pos/tickets?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data).toHaveLength(0)
    const again = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [{ id: f.itemId, qty: 1, price: 1 }], paymentMethod: 'cash', propertyId: f.propertyId, payLinkId: link })
    expect(again.status).toBe(409)
  })

  it('an empty cart settles the link exactly as it was sent', async () => {
    const f = await seed()
    const link = await mkLink(f)
    const res = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [], paymentMethod: 'cash', propertyId: f.propertyId, payLinkId: link })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBeCloseTo(649.72, 2)
  })

  // 10/2 (review): the link's stay was priced from its site, and the site held,
  // when it was sent. Settling the link never sells a stay the schedule has
  // not heard of, at a price nobody checked.
  it('a stay line the link never had — more nights, another price, an extra stay — is refused; nothing is paid', async () => {
    const f = await seed()
    const link = await mkLink(f)
    const settle = (items: any[]) => request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items, paymentMethod: 'cash', propertyId: f.propertyId, payLinkId: link })
    const propaneLine = { id: f.itemId, name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 }
    const stay = (qty: number, price: number, name = 'RV site — nightly') => ({ id: f.stayItemId, name, qty, price, tax: 0 })
    for (const items of [
      [stay(1, 589), propaneLine, stay(2, 49, 'Extra nights — Oct 1–2')],   // an extra stay
      [stay(2, 589), propaneLine],                                        // more nights than the link
      [stay(1, 1), propaneLine],                                          // the stay at another price
    ]) {
      const res = await settle(items)
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.error).toMatch(/is not the stay on this pay link — nothing was charged.*with a site and dates/)
    }
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link]))[0].status).toBe('open')
    expect(await query(`SELECT 1 FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
    // The stay as sent still settles.
    const ok = await settle([stay(1, 589), propaneLine])
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBeCloseTo(649.72, 2)
  })

  it('an adjustment keeps the stay at its site\'s price and never adds nights', async () => {
    const f = await seed()
    const link = await mkLink(f)
    const { posPayLinksRouter } = await import('./posPayLinks')
    const app = express(); app.use(express.json()); app.use('/api/pos/pay-links', posPayLinksRouter); app.use(errorHandler)
    const adjust = (items: any[]) => request(app).patch(`/api/pos/pay-links/${link}`).set('Authorization', `Bearer ${f.token}`).send({ items })
    const propaneLine = { id: f.itemId, name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 }
    for (const stayLine of [
      { id: f.stayItemId, name: 'RV site — nightly', qty: 1, price: 5, tax: 0 },
      { id: f.stayItemId, name: 'RV site — nightly', qty: 3, price: 589, tax: 0 },
    ]) {
      const res = await adjust([stayLine, propaneLine])
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.error).toMatch(/is a stay — a link keeps the stay it was sent with, at its price; its nights, site and price change only on the schedule.*press Save changes/)
    }
    expect(Number((await query<any>(`SELECT total FROM pos_pay_links WHERE id = $1`, [link]))[0].total)).toBeCloseTo(649.72, 2)
    // A line's quantity that cannot be read is answered in plain words.
    const bad = await adjust([{ ...propaneLine, qty: 0 }])
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('A line in the cart needs a quantity above zero — fix how many, then press Save changes again.')
  })

  // S652 (Nic): "once the link is sent is it fixed to those items?" No.
  it('an open link can be adjusted before it is paid; the person sees the new total', async () => {
    const f = await seed()
    const link = await mkLink(f)
    const { posPayLinksRouter } = await import('./posPayLinks')
    const app = express(); app.use(express.json()); app.use('/api/pos/pay-links', posPayLinksRouter); app.use(errorHandler)
    const res = await request(app).patch(`/api/pos/pay-links/${link}`).set('Authorization', `Bearer ${f.token}`)
      .send({ items: [
        { id: f.stayItemId, name: 'RV site — nightly', qty: 1, price: 589, tax: 0 },
        { id: f.itemId, name: 'Propane (per gal)', qty: 18.4, price: 3.30, tax: 0 },
        { id: f.itemId, name: 'Final electric — RV 27 (110 kWh)', qty: 110, price: 0.21, tax: 0 },
      ] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(Number(res.body.data.total)).toBeCloseTo(672.82, 2)   // 649.72 + 23.10
    expect(res.body.data.label).toBe('3 items')
    const [row] = await query<any>(`SELECT total, jsonb_array_length(items) AS n FROM pos_pay_links WHERE id = $1`, [link])
    expect(Number(row.total)).toBeCloseTo(672.82, 2)
    expect(Number(row.n)).toBe(3)
    // Paid links are fixed.
    await query(`UPDATE pos_pay_links SET status = 'paid', paid_at = NOW() WHERE id = $1`, [link])
    const locked = await request(app).patch(`/api/pos/pay-links/${link}`).set('Authorization', `Bearer ${f.token}`)
      .send({ items: [{ id: f.itemId, name: 'x', qty: 1, price: 1 }] })
    expect(locked.status).toBe(409)
  })
})

// ── 10/2: the Scott Duffy ticket ───────────────────────────────────────────
//
// Live, 10/2: Scott Duffy had two invites at Mountain View (both cancelled) and
// no lease. A ticket for his propane could not be cleared or charged, and the
// reader would not show it: "That resident is not at one of this company's
// properties." The person at the register is never gated on residency.

async function tenantNamed(first: string, last: string): Promise<string> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','tenant',$2,$3,TRUE) RETURNING id`, [`${first}.${last}.${Math.random().toString(36).slice(2)}@t.dev`.toLowerCase(), first, last])
  return (await query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u[0].id]))[0].id
}
async function readerFor(f: any): Promise<string> {
  const id = `tmr_${Math.random().toString(36).slice(2, 10)}`
  await query(`INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname, status) VALUES ($1,$2,$3,'Front desk','active')`,
    [f.landlordId, f.propertyId, id])
  return id
}
const propane = (f: any, qty = 18.4) => ({ id: f.itemId, name: 'Propane (per gal)', qty, price: 3.30, tax: 0 })
const getTicket = (f: any, id: string, kind = 'ticket') =>
  request(buildApp()).get(`/api/pos/tickets/${id}?propertyId=${f.propertyId}&kind=${kind}`).set('Authorization', `Bearer ${f.token}`)
const putBack = (f: any, id: string, body: any) =>
  request(buildApp()).put(`/api/pos/tickets/${id}`).set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId, ...body })
const showOnReader = (f: any, readerId: string, body: any) =>
  request(buildApp()).post(`/api/pos/terminal/readers/${readerId}/cart`).set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId, ...body })
const openTickets = async (f: any) => query<any>(`SELECT id, items, tenant_id, pos_customer_id FROM pos_open_tickets WHERE landlord_id = $1 AND status = 'open'`, [f.landlordId])

describe('10/2 a person on a ticket is never gated on residency — the Scott Duffy ticket', () => {
  it('a tenant with only cancelled invites here: the ticket saves, reopens by name, shows on the reader, goes back on Clear, and charges', async () => {
    const f = await seed()
    const scott = await tenantNamed('Scott', 'Duffy')
    await query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id, cancelled_at) VALUES ($1,$2,$3,NOW()), ($1,$2,NULL,NOW())`,
      [f.landlordId, scott, f.propertyId])

    // Saves.
    const t = await writeTicket(f, { posCustomerId: null, tenantId: scott })
    expect(t.status, JSON.stringify(t.body)).toBe(201)
    // Reopens, fresh, with his name for the chip.
    const opened = await getTicket(f, t.body.data.id)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body.data).toMatchObject({ id: t.body.data.id, kind: 'ticket', tenantId: scott, customerName: 'Scott Duffy' })
    // Shows on the reader, by name; comes down again.
    const readerId = await readerFor(f)
    const shown = await showOnReader(f, readerId, { items: [propane(f)], tenantId: scott })
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    expect(shown.body.data.shown).toBe(true)
    expect(showCartOnReaderMock.mock.calls[0][0].who).toBe('Scott Duffy')
    const down = await showOnReader(f, readerId, { items: [], tenantId: scott })
    expect(down.status).toBe(200)
    expect(clearCartOnReaderMock).toHaveBeenCalledTimes(1)
    // Clear puts the same ticket back — no second ticket.
    const back = await putBack(f, t.body.data.id, { items: [propane(f)] })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect((await openTickets(f)).map((r: any) => r.id)).toEqual([t.body.data.id])
    // Charges.
    const sale = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [propane(f)], paymentMethod: 'cash', propertyId: f.propertyId, tenantId: scott, openTicketId: t.body.data.id })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    const [tx] = await query<any>(`SELECT tenant_id, open_ticket_id FROM pos_transactions`)
    expect(tx).toEqual({ tenant_id: scott, open_ticket_id: t.body.data.id })
    expect(await openTickets(f)).toHaveLength(0)
  })

  it('a tenant tied by an earlier register sale, a booking, or a register record is somebody this register sells to', async () => {
    const f = await seed()
    const bySale = await tenantNamed('Sal', 'Earlier')
    await query(`INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status, property_id, tenant_id)
                 VALUES ($1,(SELECT user_id FROM landlords WHERE id = $1),'cash',1,0,1,'completed',$2,$3)`, [f.landlordId, f.propertyId, bySale])
    const byRecord = await tenantNamed('Rec', 'Ord')
    await query(`INSERT INTO pos_customers (landlord_id, first_name, last_name, tenant_id) VALUES ($1,'Rec','Ord',$2)`, [f.landlordId, byRecord])
    const byBooking = await tenantNamed('Bo', 'Oking')
    const unit = await query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type) VALUES ($1,$2,'RV 09','vacant',500,'rv_spot') RETURNING id`,
      [f.propertyId, f.landlordId])
    await query(`INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status, tenant_id)
                 VALUES ($1,$2,'nightly','2027-02-01','2027-02-03','cancelled',$3)`, [unit[0].id, f.landlordId, byBooking])
    for (const tenantId of [bySale, byRecord, byBooking]) {
      const r = await writeTicket(f, { posCustomerId: null, tenantId })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
    }
  })

  it('a tenant this company has never had is refused on a ticket — and the reader just shows no name for them', async () => {
    const f = await seed()
    const other = await seed()
    const stranger = await tenantNamed('Never', 'Here')
    await query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id) VALUES ($1,$2,$3)`, [other.landlordId, stranger, other.propertyId])
    const r = await writeTicket(f, { posCustomerId: null, tenantId: stranger })
    expect(r.status).toBe(404)
    expect(r.body.error).toMatch(/remove them \(×\)/)
    const readerId = await readerFor(f)
    const shown = await showOnReader(f, readerId, { items: [propane(f)], tenantId: stranger })
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    expect(showCartOnReaderMock.mock.calls[0][0].who).toBeNull()
    const nonsense = await showOnReader(f, readerId, { items: [propane(f)], tenantId: 'not-an-id', posCustomerId: f.customerId })
    expect(nonsense.status).toBe(200)
    expect(showCartOnReaderMock.mock.calls[1][0].who).toBeNull()
  })
})

// ── 10/2: Clear on a reopened ticket puts it back ─────────────────────────
//
// Clear on a ticket opened from the list used to POST a SECOND ticket and leave
// the first open — two tickets for one tank, and a double charge waiting.
describe('10/2 Clear on a reopened ticket puts the original back — never a second ticket', () => {
  it('reopened and cleared as it was: still exactly one open ticket, the same one, its person kept', async () => {
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    expect((await getTicket(f, t.id)).status).toBe(200)
    const back = await putBack(f, t.id, { items: [propane(f)] })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    const open = await openTickets(f)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ id: t.id, pos_customer_id: f.customerId })
  })

  it('reopened, an item added, cleared: the same ticket with the new items', async () => {
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    const ice = await query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Ice',(SELECT category_id FROM pos_items WHERE id = $3),3.99,0,0,99,0,99) RETURNING id`, [f.landlordId, f.propertyId, f.itemId])
    const back = await putBack(f, t.id, { items: [propane(f, 20), { id: ice[0].id, name: 'Ice', qty: 2, price: 3.99, tax: 0 }] })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body.data.id).toBe(t.id)
    const open = await openTickets(f)
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(t.id)
    expect(open[0].items.map((i: any) => [i.name, Number(i.qty)])).toEqual([['Propane (per gal)', 20], ['Ice', 2]])
  })

  it('the person can change on the way back; never to somebody this company does not have', async () => {
    const f = await seed()
    const other = await seed()
    const t = (await writeTicket(f)).body.data
    const ray2 = await query<{ id: string }>(`INSERT INTO pos_customers (landlord_id, first_name, last_name) VALUES ($1,'Raya','Delgado') RETURNING id`, [f.landlordId])
    expect((await putBack(f, t.id, { items: [propane(f)], posCustomerId: ray2[0].id })).status).toBe(200)
    expect((await openTickets(f))[0].pos_customer_id).toBe(ray2[0].id)
    // A person who cannot go on it is not a ticket that is gone (404/409 clear
    // the register's cart): 422, the server's own words, the ticket untouched.
    const stranger = await putBack(f, t.id, { items: [propane(f)], posCustomerId: other.customerId })
    expect(stranger.status).toBe(422)
    expect(stranger.body.error).toMatch(/not on this register — remove them/i)
    expect((await putBack(f, t.id, { items: [propane(f)], posCustomerId: ray2[0].id, tenantId: await tenantNamed('Two', 'People') })).status).toBe(400)
    // Same lines rules as writing one up.
    expect((await putBack(f, t.id, { items: [{ id: f.stayItemId, qty: 1 }] })).status).toBe(400)
    expect((await putBack(f, t.id, { items: [{ id: other.itemId, qty: 1 }] })).status).toBe(400)
    expect((await openTickets(f))[0].pos_customer_id).toBe(ray2[0].id)
  })

  it("another company's ticket is not found; a settled or voided one is not put back, and says so", async () => {
    const f = await seed()
    const other = await seed()
    const theirs = (await writeTicket(other)).body.data
    expect((await putBack(f, theirs.id, { items: [propane(f)] })).status).toBe(404)
    expect((await getTicket(f, theirs.id)).status).toBe(404)
    expect((await query<any>(`SELECT items FROM pos_open_tickets WHERE id = $1`, [theirs.id]))[0].items[0].qty).toBe(18.4)

    const settled = (await writeTicket(f)).body.data
    await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [propane(f)], paymentMethod: 'cash', propertyId: f.propertyId, posCustomerId: f.customerId, openTicketId: settled.id })
    const late = await putBack(f, settled.id, { items: [propane(f, 1)] })
    expect(late.status).toBe(409)
    expect(late.body.error).toMatch(/already settled/i)
    expect((await getTicket(f, settled.id)).status).toBe(409)

    const voided = (await writeTicket(f)).body.data
    await request(buildApp()).post(`/api/pos/tickets/${voided.id}/void`).set('Authorization', `Bearer ${f.token}`).send({ reason: 'Tank came back' })
    expect((await putBack(f, voided.id, { items: [propane(f)] })).status).toBe(409)
    expect(await openTickets(f)).toHaveLength(0)
  })

  it('a cashier works only the properties they are assigned to', async () => {
    const f = await seed()
    const t = (await writeTicket(f)).body.data
    const u = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    const perms = { 'pos.ring_sale': true }
    const otherPark = await query<{ id: string }>(`SELECT gen_random_uuid() AS id`)
    await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u[0].id, f.landlordId, [otherPark[0].id], JSON.stringify(perms)])
    const desk = jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp()).put(`/api/pos/tickets/${t.id}`).set('Authorization', `Bearer ${desk}`).send({ items: [propane(f, 1)] })
    expect(res.status).toBe(403)
    expect((await request(buildApp()).get(`/api/pos/tickets/${t.id}`).set('Authorization', `Bearer ${desk}`)).status).toBe(403)
    expect(Number((await openTickets(f))[0].items[0].qty)).toBe(18.4)
  })

  it('a reservation ticket keeps its stay, and needs nobody named', async () => {
    const f = await seed()
    const unit = await query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type) VALUES ($1,$2,'RV 04','vacant',500,'rv_spot') RETURNING id`,
      [f.propertyId, f.landlordId])
    const booking = await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status) VALUES ($1,$2,'nightly','2027-03-01','2027-03-03','tentative') RETURNING id`,
      [unit[0].id, f.landlordId])
    const t = await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
       VALUES ($1,$2,(SELECT user_id FROM landlords WHERE id = $1),$3::jsonb,'Walk-in · site RV 04',$4) RETURNING id`,
      [f.landlordId, f.propertyId, JSON.stringify([{ id: f.stayItemId, name: 'RV site — nightly', qty: 2, price: 0, tax: 0 }]), booking[0].id])
    const stay = { id: f.stayItemId, name: 'RV site — nightly', qty: 2, price: 0, tax: 0 }
    expect((await putBack(f, t[0].id, { items: [stay, propane(f, 5)] })).status).toBe(200)
    const lost = await putBack(f, t[0].id, { items: [propane(f, 5)] })
    expect(lost.status).toBe(400)
    expect(lost.body.error).toMatch(/put the stay back/i)
    const open = await openTickets(f)
    expect(open[0]).toMatchObject({ tenant_id: null, pos_customer_id: null })
    expect(open[0].items).toHaveLength(2)
  })
})

// ── 10/2: opening a ticket or pay link reads it fresh ─────────────────────
describe('10/2 opening a ticket or pay link reads it from the server, not the list', () => {
  const linkWith = async (f: any, items: any[], extra: { customerId?: string } = {}) => (await query<{ id: string }>(
    `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_name, customer_email, pos_customer_id)
     VALUES (md5(random()::text) || md5(random()::text), $1, $2, (SELECT user_id FROM landlords WHERE id = $1), 'one_time', 'Stay balance',
             $3::jsonb, $4, $4, 'Dale Carter', 'dale@t.dev', $5) RETURNING id`,
    [f.landlordId, f.propertyId, JSON.stringify(items), items.reduce((a, i) => a + i.qty * i.price, 0), extra.customerId ?? null]))[0].id

  it('a pay link opens with its person by their own name; one paid a moment ago says so instead', async () => {
    const f = await seed()
    const link = await linkWith(f, [propane(f, 2)], { customerId: f.customerId })
    const opened = await getTicket(f, link, 'pay_link')
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body.data).toMatchObject({ id: link, kind: 'pay_link', payLinkId: link, posCustomerId: f.customerId, customerName: 'Ray Delgado' })
    await query(`UPDATE pos_pay_links SET status = 'paid', paid_at = NOW() WHERE id = $1`, [link])
    const gone = await getTicket(f, link, 'pay_link')
    expect(gone.status).toBe(409)
    expect(gone.body.error).toMatch(/open the list again/i)
    const other = await seed()
    expect((await getTicket(other, link, 'pay_link')).status).toBe(404)
  })

  it('a stay balance link — a line with no register item — settles at the register; a line the link never had does not', async () => {
    const f = await seed()
    const balance = { id: null, name: 'Stay balance', qty: 1, price: 120, tax: 0 }
    const link = await linkWith(f, [balance])
    const invented = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [balance, { id: null, name: 'Something else', qty: 1, price: 5, tax: 0 }], paymentMethod: 'cash', propertyId: f.propertyId, payLinkId: link })
    expect(invented.status).toBe(400)
    const res = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [balance], paymentMethod: 'cash', propertyId: f.propertyId, payLinkId: link })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBeCloseTo(120, 2)
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link]))[0].status).toBe('paid')
    // Without a pay link, an uncatalogued line is still refused.
    const walkUp = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [balance], paymentMethod: 'cash', propertyId: f.propertyId })
    expect(walkUp.status).toBe(400)
  })
})

// ── 10/2 (review): a reopened pay link keeps its discount ─────────────────
//
// Found by probe: a link sent at $20 less $5 ($15) was settled at the counter
// for $20 — the register loaded the link's lines into the cart and dropped its
// discount, and the server only used the link's discount for an empty cart.
describe('10/2 a pay link settled at the register costs what was sent, discount and all', () => {
  const discounted = async (f: any) => (await query<{ id: string }>(
    `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, discount_amount, total, customer_name, customer_email)
     VALUES (md5(random()::text) || md5(random()::text), $1, $2, (SELECT user_id FROM landlords WHERE id = $1), 'one_time', 'Propane',
             $3::jsonb, 20, 5, 15, 'Dale Carter', 'dale@t.dev') RETURNING id`,
    [f.landlordId, f.propertyId, JSON.stringify([{ id: f.itemId, name: 'Propane (per gal)', qty: 1, price: 20, tax: 0 }])]))[0].id
  const line = (f: any) => ({ id: f.itemId, name: 'Propane (per gal)', qty: 1, price: 20, tax: 0 })
  async function cashier(f: any): Promise<string> {
    const u = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    const perms = { 'pos.ring_sale': true }
    await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
    return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }
  const settle = (f: any, token: string, body: any) => request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${token}`).send({ paymentMethod: 'cash', propertyId: f.propertyId, ...body })

  it('opened fresh, the link carries its discount for the cart', async () => {
    const f = await seed()
    const link = await discounted(f)
    const opened = await getTicket(f, link, 'pay_link')
    expect(opened.status).toBe(200)
    expect(Number(opened.body.data.discountAmount)).toBe(5)
  })

  it('the register sends the cart with the link discount: $15', async () => {
    const f = await seed()
    const link = await discounted(f)
    const res = await settle(f, f.token, { items: [line(f)], discountAmount: 5, payLinkId: link })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBeCloseTo(15, 2)
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link]))[0].status).toBe('paid')
  })

  it('a cart that says nothing about a discount keeps the link\'s: $15, never $20', async () => {
    const f = await seed()
    const link = await discounted(f)
    const res = await settle(f, f.token, { items: [line(f)], payLinkId: link })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBeCloseTo(15, 2)
    expect(Number(res.body.data.discountAmount)).toBeCloseTo(5, 2)
  })

  it('a cashier without the discount permission settles it at $15 — the discount is the link\'s, not theirs — but cannot add one of their own', async () => {
    const f = await seed()
    const desk = await cashier(f)
    const link = await discounted(f)
    // Their own discount on top: refused, nothing paid.
    const more = await settle(f, desk, { items: [line(f)], discountAmount: 8, payLinkId: link })
    expect(more.status).toBe(403)
    // The breakdown on the reader shows the link's discount for them too.
    const readerId = await readerFor(f)
    const shown = await showOnReader(f, readerId, { items: [line(f)], discountAmount: 5 })
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    const deskShown = await request(buildApp()).post(`/api/pos/terminal/readers/${readerId}/cart`).set('Authorization', `Bearer ${desk}`)
      .send({ propertyId: f.propertyId, items: [line(f)], discountAmount: 5 })
    expect(deskShown.status, JSON.stringify(deskShown.body)).toBe(200)
    const deskMore = await request(buildApp()).post(`/api/pos/terminal/readers/${readerId}/cart`).set('Authorization', `Bearer ${desk}`)
      .send({ propertyId: f.propertyId, items: [line(f)], discountAmount: 8 })
    expect(deskMore.status).toBe(403)
    // The link's own discount: settled.
    const res = await settle(f, desk, { items: [line(f)], discountAmount: 5, payLinkId: link })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(Number(res.body.data.total)).toBeCloseTo(15, 2)
    // An empty cart (the link as sent) works for them too.
    const link2 = await discounted(f)
    const asSent = await settle(f, desk, { items: [], payLinkId: link2 })
    expect(asSent.status, JSON.stringify(asSent.body)).toBe(201)
    expect(Number(asSent.body.data.total)).toBeCloseTo(15, 2)
  })
})

// ── 10/2 (review): what a pay link's own terms cover at the counter ────────
//
// A link's prices and discount were set when it was sent, so a cashier
// settling it is not held to their own pricing rule for THOSE terms — but only
// for as much as the link carries, and only for the link's own property.
describe('10/2 a pay link settled at the register: its terms, its property, its quantities', () => {
  const linkOf = async (f: any, items: any[], extra: { discount?: number; kind?: string; propertyId?: string } = {}) => {
    const subtotal = items.reduce((a, i) => a + i.qty * i.price, 0)
    return (await query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, discount_amount, total, customer_name, customer_email)
       VALUES (md5(random()::text) || md5(random()::text), $1, $2, (SELECT user_id FROM landlords WHERE id = $1), $3, 'Propane',
               $4::jsonb, $5, $6, $7, 'Dale Carter', 'dale@t.dev') RETURNING id`,
      [f.landlordId, extra.propertyId ?? f.propertyId, extra.kind ?? 'one_time', JSON.stringify(items), subtotal,
       extra.discount ?? 0, subtotal - (extra.discount ?? 0)]))[0].id
  }
  async function deskFor(f: any): Promise<string> {
    const u = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    const perms = { 'pos.ring_sale': true }
    await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
    return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }
  async function parkB(f: any): Promise<string> {
    const c = await db.connect()
    try {
      const owner = (await c.query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [f.landlordId])).rows[0].user_id
      return await seedProperty(c, { landlordId: f.landlordId, ownerUserId: owner, managedByUserId: owner })
    } finally { c.release() }
  }
  const settle = (f: any, token: string, body: any) => request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${token}`).send({ paymentMethod: 'cash', propertyId: f.propertyId, ...body })
  // One tank at a special price ($2.00 a gallon; the register's is $3.30).
  const special = (f: any, qty = 1) => ({ id: f.itemId, name: 'Propane (per gal)', qty, price: 2, tax: 0 })

  it('a cashier settles the link\'s own special-price line — but no more of it than the link carries', async () => {
    const f = await seed()
    const desk = await deskFor(f)
    const link = await linkOf(f, [special(f, 5)])
    // More gallons at the link's special price than the link carries: the
    // extra is the cashier's own pricing, and they cannot set prices.
    const more = await settle(f, desk, { items: [special(f, 50)], payLinkId: link })
    expect(more.status, JSON.stringify(more.body)).toBe(403)
    // Split across two lines the same way: still more than the link carries.
    const split = await settle(f, desk, { items: [special(f, 5), special(f, 1)], payLinkId: link })
    expect(split.status).toBe(403)
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link]))[0].status).toBe('open')
    // Extra gallons at the register's own price are fine; the link's 5 at $2 stay the link's.
    const ok = await settle(f, desk, { items: [special(f, 5), { ...special(f, 3), price: 3.30 }], payLinkId: link })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBeCloseTo(10 + 9.9, 2)
  })

  it('a cashier may settle for the link\'s discount or less — never more', async () => {
    const f = await seed()
    const desk = await deskFor(f)
    const link = await linkOf(f, [{ ...special(f, 1), price: 20 }], { discount: 5 })
    expect((await settle(f, desk, { items: [{ ...special(f, 1), price: 20 }], discountAmount: 6, payLinkId: link })).status).toBe(403)
    const less = await settle(f, desk, { items: [{ ...special(f, 1), price: 20 }], discountAmount: 3, payLinkId: link })
    expect(less.status, JSON.stringify(less.body)).toBe(201)
    expect(Number(less.body.data.total)).toBeCloseTo(17, 2)
  })

  it('a link is settled only at its own property, only while it is an open emailed link that has not run out', async () => {
    const f = await seed()
    const b = await parkB(f)
    const theirs = await linkOf(f, [special(f, 1)], { propertyId: b })
    const atA = await settle(f, f.token, { items: [special(f, 1)], payLinkId: theirs })
    expect(atA.status).toBe(400)
    expect(atA.body.error).toMatch(/pay link is for another property — nothing was charged\. Switch the register to that property/)
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [theirs]))[0].status).toBe('open')
    // Opening it from this property's register: not on this register's list.
    const opened = await getTicket(f, theirs, 'pay_link')
    expect(opened.status).toBe(404)
    expect(opened.body.error).toMatch(/open the list again/)
    // At its own property it opens.
    const own = await request(buildApp()).get(`/api/pos/tickets/${theirs}?propertyId=${b}&kind=pay_link`).set('Authorization', `Bearer ${f.token}`)
    expect(own.status, JSON.stringify(own.body)).toBe(200)

    // A standing QR link is never "paid" by one sale at the counter.
    const standing = await linkOf(f, [special(f, 1)], { kind: 'standing' })
    const qr = await settle(f, f.token, { items: [special(f, 1)], payLinkId: standing })
    expect(qr.status).toBe(404)
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [standing]))[0].status).toBe('open')

    // A link that has run out says so; nothing is charged.
    const old = await linkOf(f, [special(f, 1)])
    await query(`UPDATE pos_pay_links SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [old])
    const expired = await settle(f, f.token, { items: [special(f, 1)], payLinkId: old })
    expect(expired.status).toBe(409)
    expect(expired.body.error).toMatch(/run out — nothing was charged/)
    expect(await query(`SELECT 1 FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
  })

  it('a ticket is settled only at its own property; opened from another property\'s register it is not on the list', async () => {
    const f = await seed()
    const b = await parkB(f)
    const t = await writeTicket(f)
    expect(t.status, JSON.stringify(t.body)).toBe(201)
    const atB = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [propane(f)], paymentMethod: 'cash', propertyId: b, posCustomerId: f.customerId, openTicketId: t.body.data.id })
    expect(atB.status).toBe(400)
    expect(atB.body.error).toMatch(/ticket is for another property — nothing was charged/)
    expect((await openTickets(f)).map((x: any) => x.id)).toEqual([t.body.data.id])
    const fromB = await request(buildApp()).get(`/api/pos/tickets/${t.body.data.id}?propertyId=${b}&kind=ticket`).set('Authorization', `Bearer ${f.token}`)
    expect(fromB.status).toBe(404)
    // At its own property it settles.
    const ok = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [propane(f)], paymentMethod: 'cash', propertyId: f.propertyId, posCustomerId: f.customerId, openTicketId: t.body.data.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(await openTickets(f)).toHaveLength(0)
  })

  it('a ticket line whose quantity or price cannot be used is refused in plain words', async () => {
    const f = await seed()
    const zero = await writeTicket(f, { items: [{ ...propane(f), qty: 0 }] })
    expect(zero.status).toBe(400)
    expect(zero.body.error).toBe('A line in the cart needs a quantity above zero — fix how many, then press the button again.')
    const negative = await writeTicket(f, { items: [{ ...propane(f), price: -1 }] })
    expect(negative.status).toBe(400)
    expect(negative.body.error).toBe('A line in the cart has a price below zero — take that line out, add it again, then press the button again.')
    const sale = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [{ ...propane(f), qty: -2 }], paymentMethod: 'cash', propertyId: f.propertyId })
    expect(sale.status).toBe(400)
    expect(sale.body.error).toBe('A line in the cart needs a quantity above zero — fix how many, then press Charge again.')
    for (const r of [zero, negative, sale]) expect(r.body.error).not.toMatch(/items\.|Number must|cannot be negative/)
  })
})

// ── 10/2 (review): a stay link paid at the desk, ids in capitals, typed amounts ──
//
// Found by probe. (C) A link sent for three nights and settled at the counter
// was marked paid while its booking stayed an unpaid hold — the very thing the
// next paying guest displaces. (D) An item id sent in capitals slipped every
// check keyed by the database's own (lowercase) id: a cashier rang a $20 tank at
// a penny, and settled a $120 link stay at $1 a night. (7) A cashier could send
// themselves a one-time link with a typed-in line at any price and settle it.
describe('10/2 (review) a stay link paid at the desk is the guest\'s; ids in capitals are the same items; typed amounts need the permission', () => {
  let posPayLinksRouter: any
  let clearUnpaidHolds: any
  beforeEach(async () => {
    ({ posPayLinksRouter } = await import('./posPayLinks'))
    ;({ clearUnpaidHolds } = await import('../services/holdDisplacement'))
  })
  function linkApp() {
    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => {
      const originalJson = res.json.bind(res)
      res.json = (body: any) => originalJson(camelCaseKeys(body))
      next()
    })
    app.use('/api/pos/pay-links', posPayLinksRouter)
    app.use(errorHandler)
    return app
  }
  async function siteAt(f: any, n = '01') {
    return (await query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, is_bookable)
       VALUES ($1,$2,$3,'vacant',500,'rv_spot',40,TRUE) RETURNING id`, [f.propertyId, f.landlordId, `RV ${n}`]))[0].id
  }
  const stayLine = (f: any, qty = 3, price = 40) => ({ id: f.stayItemId, name: 'RV site — nightly', qty, price, tax: 0 })
  const sendStay = (f: any, unitId: string, extra: any = {}, token = f.token) =>
    request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${token}`)
      .send({ propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Dale Carter', email: 'dale@t.dev' },
              items: [stayLine(f)], stay: { unitId, checkIn: '2027-01-12', guestName: 'Dale Carter' }, ...extra })
  const settle = (f: any, body: any, token = f.token) => request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${token}`).send({ paymentMethod: 'cash', propertyId: f.propertyId, ...body })
  const booking = async () => (await query<any>(
    `SELECT id, status, deposit_paid_at, pos_transaction_id, balance_billed_at, balance_paid_at,
            check_out::text AS check_out, nights, total_amount::float AS total FROM unit_bookings`))[0]
  async function desk(f: any, perms: Record<string, boolean> = { 'pos.ring_sale': true }): Promise<string> {
    const u = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
    return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }

  it('settled at the counter, the link\'s booking is confirmed, names the sale, and is never displaced by a later payer', async () => {
    const f = await seed()
    const unitId = await siteAt(f)
    const sent = await sendStay(f, unitId)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    // The booking holds the stay's own price — not the link's whole subtotal.
    expect(await booking()).toMatchObject({ status: 'tentative', deposit_paid_at: null, total: 120 })
    const paid = await settle(f, { items: [], payLinkId: sent.body.data.id })
    expect(paid.status, JSON.stringify(paid.body)).toBe(201)
    const b = await booking()
    expect(b).toMatchObject({ status: 'confirmed', pos_transaction_id: paid.body.data.id, check_out: '2027-01-15', nights: 3 })
    expect(b.deposit_paid_at).not.toBeNull()
    // Paid in full: nothing is left to bill on arrival day.
    expect(b.balance_billed_at).not.toBeNull()
    expect(b.balance_paid_at).not.toBeNull()
    // A later payer for the same nights does not take it.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      expect(await clearUnpaidHolds(c, unitId, '2027-01-12', '2027-01-15')).toEqual([])
      await c.query('ROLLBACK')
    } finally { c.release() }
    expect((await booking()).status).toBe('confirmed')
  })

  // 10/3 (decisions #23, superseding #14 and #20): a reservation's nights,
  // site and price change ONLY on the schedule. A stay link is settled at the
  // counter whole — what the reservation owes now — and a cart with fewer or
  // more nights, or without the stay (that would leave the site held for
  // nothing), is refused before any money moves, in words that point to the
  // schedule. A stay the schedule changes is followed.
  const removedWords = (press: string) => `This link holds 3 nights at site RV 01 (Jan 12 → Jan 15) for "RV site — nightly" — keep its stay in the cart, then press ${press} again. `
    + 'To give up the stay altogether, close the link under Pay Links (that lets the site go).'
  const nightsNowWords = (what: string) => `This link's reservation is ${what} now — a reservation's nights, site and price change only on the schedule, `
    + 'and the cart shows other nights, so nothing was charged. Press Clear, open the link again from the list, then press Charge.'
  const onScheduleWords = (press: string, nothing: string, what = '3 nights at site RV 01 (Jan 12 → Jan 15)') =>
    `This link holds ${what} — a reservation's nights, site and price change only on the schedule, so nothing was ${nothing}. `
    + `Put the stay back the way the link has it, then press ${press} again. To change the stay, change the reservation on the schedule first — the link then asks what it owes.`

  it('the counter charges a stay link whole: fewer nights, more nights or no stay is refused and nothing is charged; the whole stay is paid and the booking left as the schedule has it', async () => {
    const f = await seed()
    const unitId = await siteAt(f)
    const link = (await sendStay(f, unitId)).body.data.id
    const out = await settle(f, { items: [{ id: f.itemId, name: 'Propane (per gal)', qty: 1, price: 3.30, tax: 0 }], payLinkId: link })
    expect(out.status).toBe(400)
    expect(out.body.error).toBe(removedWords('Charge'))
    const two = await settle(f, { items: [stayLine(f, 2)], payLinkId: link })
    expect(two.status).toBe(400)
    expect(two.body.error).toBe(onScheduleWords('Charge', 'charged'))
    const four = await settle(f, { items: [stayLine(f, 4)], payLinkId: link })
    expect(four.status).toBe(400)
    expect(four.body.error).toBe(onScheduleWords('Charge', 'charged'))
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link]))[0].status).toBe('open')
    expect(await query(`SELECT 1 FROM pos_transactions`)).toHaveLength(0)
    expect(await booking()).toMatchObject({ status: 'tentative', check_out: '2027-01-15', nights: 3, total: 120 })
    // The whole stay, as the link carries it: $120 — and the booking keeps its nights.
    const whole = await settle(f, { items: [stayLine(f, 3)], payLinkId: link })
    expect(whole.status, JSON.stringify(whole.body)).toBe(201)
    expect(Number(whole.body.data.total)).toBeCloseTo(120, 2)
    const b = await booking()
    expect(b).toMatchObject({ status: 'confirmed', check_out: '2027-01-15', nights: 3, total: 120, pos_transaction_id: whole.body.data.id })
    expect(b.balance_paid_at).not.toBeNull()
  })

  it('the register\'s reservation line keeps the reservation\'s nights — the quote and Charge refuse other nights; a stay the schedule shortened is charged at the schedule\'s figure, its lodging tax recorded', async () => {
    const f = await seed()
    const unitId = await siteAt(f)
    const link = (await sendStay(f, unitId)).body.data.id
    await query(`UPDATE properties SET short_term_tax_rate = 10 WHERE id = $1`, [f.propertyId])
    // The register opens the link: its stay as one line at what the reservation owes, with its nights — and no way to change them.
    const opened = await request(buildApp()).get(`/api/pos/tickets/${link}?propertyId=${f.propertyId}&kind=pay_link`).set('Authorization', `Bearer ${f.token}`)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const resLine = opened.body.data.items[0]
    expect(resLine).toMatchObject({ id: f.stayItemId, qty: 1, price: 120, reservation: true, nights: 3 })
    expect(resLine.maxNights).toBeUndefined()
    // One night fewer, from an old screen: refused at the quote and at Charge — never priced.
    const quote = await request(buildApp()).post('/api/pos/cart-quote').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, paymentMethod: 'cash', payLinkId: link, priceStay: true,
              items: [{ ...resLine, nights: 2, payLinkId: link }] })
    expect(quote.status).toBe(409)
    expect(quote.body.error).toBe(nightsNowWords('3 nights at site RV 01 (Jan 12 → Jan 15)'))
    const fewer = await settle(f, { items: [{ ...resLine, nights: 2, price: 88, payLinkId: link }], payLinkId: link })
    expect(fewer.status).toBe(409)
    expect(fewer.body.error).toBe(nightsNowWords('3 nights at site RV 01 (Jan 12 → Jan 15)'))
    expect(await query(`SELECT 1 FROM pos_transactions`)).toHaveLength(0)
    expect(await booking()).toMatchObject({ status: 'tentative', check_out: '2027-01-15', nights: 3, total: 120 })

    // The schedule shortens it to two nights at its own price ($80 + 10% = $88): the register follows.
    await query(`UPDATE unit_bookings SET check_out = '2027-01-14', nights = 2, total_amount = 88`)
    const again = await request(buildApp()).get(`/api/pos/tickets/${link}?propertyId=${f.propertyId}&kind=pay_link`).set('Authorization', `Bearer ${f.token}`)
    const now = again.body.data.items[0]
    expect(now).toMatchObject({ price: 88, nights: 2 })
    expect(now.name).toMatch(/2 nights at site RV 01 \(Jan 12 → Jan 14\)/)
    // A cart that still shows the 3-night line is refused, nothing charged.
    const stale = await settle(f, { items: [{ ...resLine, payLinkId: link }], payLinkId: link })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe(nightsNowWords('2 nights at site RV 01 (Jan 12 → Jan 14)'))
    const sale = await settle(f, { items: [{ ...now, payLinkId: link }], payLinkId: link })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(Number(sale.body.data.total)).toBeCloseTo(88, 2)
    // 10/3 (decisions #21): the $8 lodging tax inside the stay's price is recorded as tax — the total is the same.
    expect(Number(sale.body.data.subtotal)).toBeCloseTo(80, 2)
    expect(Number(sale.body.data.tax_amount ?? sale.body.data.taxAmount)).toBeCloseTo(8, 2)
    expect(sale.body.data.taxBreakdown ?? sale.body.data.tax_breakdown).toEqual([{ name: 'Lodging tax', rate: 0.1, amount: 8 }])
    const [recorded] = await query<any>(`SELECT unit_price::float AS price, tax_rate::float AS rate, subtotal::float AS subtotal FROM pos_transaction_items WHERE transaction_id = $1`, [sale.body.data.id])
    expect(recorded).toEqual({ price: 80, rate: 0.1, subtotal: 80 })
    // The booking is the schedule's, untouched but for being paid.
    expect(await booking()).toMatchObject({ status: 'confirmed', check_out: '2027-01-14', nights: 2, total: 88 })
  })

  it('a link whose site went to a guest who paid first is refused at the counter — nothing is charged', async () => {
    const f = await seed()
    const unitId = await siteAt(f)
    const sent = (await sendStay(f, unitId)).body.data
    const link = sent.id
    await query(`UPDATE unit_bookings SET status = 'cancelled', displaced_at = NOW()`)
    const res = await settle(f, { items: [], payLinkId: link })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/reservation on this pay link was canceled.*nothing was charged/)
    expect(await query(`SELECT 1 FROM pos_transactions`)).toHaveLength(0)
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link]))[0].status).toBe('open')
    // Nor is it sold to the guest from the link itself.
    const { publicPayRouter } = await import('./posPayLinks')
    const pub = express(); pub.use('/api/public', publicPayRouter)
    const page = await request(pub).get(`/api/public/pay/${sent.token}`)
    expect(page.status).toBe(410)
    expect(page.text).toMatch(/no longer available/)
  })

  it('adjusting a link never changes its stay — fewer nights, more nights or the stay dropped are refused, other lines can change; closing it lets the site go', async () => {
    const f = await seed()
    const unitId = await siteAt(f)
    const link = (await sendStay(f, unitId)).body.data.id
    const adjust = (items: any[]) => request(linkApp()).patch(`/api/pos/pay-links/${link}`).set('Authorization', `Bearer ${f.token}`).send({ items })
    const dropped = await adjust([{ id: f.itemId, name: 'Propane (per gal)', qty: 1, price: 3.30, tax: 0 }])
    expect(dropped.status).toBe(400)
    expect(dropped.body.error).toBe(removedWords('Save changes'))
    const four = await adjust([stayLine(f, 4)])
    expect(four.status).toBe(400)
    expect(four.body.error).toMatch(/is a stay — a link keeps the stay it was sent with, at its price; its nights, site and price change only on the schedule/)
    const two = await adjust([stayLine(f, 2)])
    expect(two.status).toBe(400)
    expect(two.body.error).toBe(onScheduleWords('Save changes', 'changed'))
    expect(await booking()).toMatchObject({ status: 'tentative', check_out: '2027-01-15', nights: 3, total: 120 })
    expect(Number((await query<any>(`SELECT total FROM pos_pay_links WHERE id = $1`, [link]))[0].total)).toBeCloseTo(120, 2)
    // Other lines beside the whole stay can still change.
    const more = await adjust([stayLine(f, 3), { id: f.itemId, name: 'Propane (per gal)', qty: 2, price: 3.30, tax: 0 }])
    expect(more.status, JSON.stringify(more.body)).toBe(200)
    expect(Number(more.body.data.total)).toBeCloseTo(126.6, 2)
    expect(await booking()).toMatchObject({ status: 'tentative', nights: 3, total: 120 })
    const closed = await request(linkApp()).post(`/api/pos/pay-links/${link}/cancel`).set('Authorization', `Bearer ${f.token}`)
    expect(closed.status).toBe(200)
    expect((await booking()).status).toBe('cancelled')
    expect((await sendStay(f, unitId, { customer: { email: 'pat@t.dev' } })).status).toBe(201)
  })

  it('an item id in capitals is the same item: a cashier\'s price on it is checked, and a link\'s stay in capitals at another price is refused', async () => {
    const f = await seed()
    const token = await desk(f)
    const lower = await settle(f, { items: [{ id: f.itemId, name: 'Propane (per gal)', qty: 1, price: 0.01, tax: 0 }] }, token)
    expect(lower.status).toBe(403)
    const upper = await settle(f, { items: [{ id: String(f.itemId).toUpperCase(), name: 'Propane (per gal)', qty: 1, price: 0.01, tax: 0 }] }, token)
    expect(upper.status, JSON.stringify(upper.body)).toBe(403)
    expect(upper.body.error).toMatch(/differs from the item's price/)
    // At the right price, in capitals, it rings — as the item itself.
    const ok = await settle(f, { items: [{ id: String(f.itemId).toUpperCase(), name: 'Propane (per gal)', qty: 1, price: 3.30, tax: 0 }] }, token)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect((await query<any>(`SELECT item_id FROM pos_transaction_items WHERE transaction_id = $1`, [ok.body.data.id]))[0].item_id).toBe(f.itemId)
    // A link's stay, settled with the stay id in capitals at $1 a night.
    const unitId = await siteAt(f)
    const link = (await sendStay(f, unitId)).body.data.id
    for (const tok of [token, f.token]) {
      const cheap = await settle(f, { items: [{ ...stayLine(f, 3, 1), id: String(f.stayItemId).toUpperCase() }], payLinkId: link }, tok)
      expect(cheap.status, JSON.stringify(cheap.body)).toBe(409)
      expect(cheap.body.error).toMatch(/comes to \$120\.00 now — the cart shows something else, and nothing was charged/)
    }
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link]))[0].status).toBe('open')
    // Someone else's item, in any case, is refused in words — never a database error.
    const other = await seed()
    const foreign = await settle(f, { items: [{ id: String(other.itemId).toUpperCase(), name: 'Propane', qty: 1, price: 3.30, tax: 0 }] }, token)
    expect(foreign.status).toBe(400)
    expect(foreign.body.error).toMatch(/not on your register any more/)
    // A ticket written with an id in capitals stores the item's own id.
    const t = await writeTicket(f, { items: [{ ...propane(f), id: String(f.itemId).toUpperCase() }] })
    expect(t.status, JSON.stringify(t.body)).toBe(201)
    expect(t.body.data.items[0].id).toBe(f.itemId)
  })

  it('a cashier cannot send a typed-in amount (or price a QR code); one with the permission can, and a cashier keeps a link\'s own typed line', async () => {
    const f = await seed()
    const token = await desk(f)
    const typed = { id: null, name: 'Propane', qty: 1, price: 1, tax: 0 }
    const sendTyped = (tok: string, extra: any = {}) => request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${tok}`)
      .send({ propertyId: f.propertyId, kind: 'one_time', customer: { email: 'pat@t.dev' }, items: [typed], ...extra })
    const refused = await sendTyped(token)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/One-off amounts need the "Apply discounts" permission — ask the owner or a manager/)
    const qr = await sendTyped(token, { kind: 'standing', label: 'Dump station', customer: undefined })
    expect(qr.status).toBe(403)
    expect(qr.body.error).toMatch(/price on a QR code needs the "Apply discounts" permission/)
    expect(await query(`SELECT 1 FROM pos_pay_links`)).toHaveLength(0)
    expect((await sendTyped(await desk(f, { 'pos.ring_sale': true, 'pos.discount': true }))).status).toBe(201)
    // A system-made line (a stay balance) on a link the cashier adjusts: kept, never added to.
    const owners = await sendTyped(f.token, { items: [{ id: null, name: 'Stay balance', qty: 1, price: 120, tax: 0 }] })
    expect(owners.status).toBe(201)
    const adjust = (items: any[]) => request(linkApp()).patch(`/api/pos/pay-links/${owners.body.data.id}`).set('Authorization', `Bearer ${token}`).send({ items })
    const keep = await adjust([{ id: null, name: 'Stay balance', qty: 1, price: 120, tax: 0 }, propane(f, 2)])
    expect(keep.status, JSON.stringify(keep.body)).toBe(200)
    const add = await adjust([{ id: null, name: 'Stay balance', qty: 1, price: 120, tax: 0 }, typed])
    expect(add.status).toBe(403)
  })
})

// ── 10/2 (review): what a link or ticket for a reservation is paid with ──────
//
// Found by probe. (1) A $100 deposit link settled at the counter with a $20 tank
// of propane — or the deposit at a penny — confirmed the reservation and stamped
// the deposit paid; the arrival-day bill then took it as paid and $80 was never
// billed. (2) A seven-night reservation ticket rung as one night stamped the
// whole stay paid for $40. (3) A stay at half a night left the booking 0 nights.
// (4) A line of nothing put a raw 500 on the screen. (5) A link's whole discount
// rode along whatever part of it a cashier kept.
describe('10/2 (review) a reservation is paid as it was booked; a stay is whole nights; a link\'s discount is for the whole order', () => {
  let posPayLinksRouter: any
  let createBookingDepositLink: any, createStayBalanceLink: any
  beforeEach(async () => {
    ({ posPayLinksRouter, createBookingDepositLink, createStayBalanceLink } = await import('./posPayLinks'))
  })
  function linkApp() {
    const app = express()
    app.use(express.json())
    app.use((_req, res, next) => {
      const originalJson = res.json.bind(res)
      res.json = (body: any) => originalJson(camelCaseKeys(body))
      next()
    })
    app.use('/api/pos/pay-links', posPayLinksRouter)
    app.use(errorHandler)
    return app
  }
  async function desk(f: any, perms: Record<string, boolean> = { 'pos.ring_sale': true }): Promise<string> {
    const u = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
    return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  }
  async function siteAt(f: any, n: string, rates: { nightly?: number; weekly?: number } = {}) {
    return (await query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type, nightly_rate, weekly_rate, is_bookable)
       VALUES ($1,$2,$3,'vacant',500,'rv_spot',$4,$5,TRUE) RETURNING id`,
      [f.propertyId, f.landlordId, `RV ${n}`, rates.nightly ?? 40, rates.weekly ?? null]))[0].id
  }
  async function heldBooking(f: any, unitId: string, checkIn: string, checkOut: string, nights: number, total: number) {
    return (await query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, status, total_amount, guest_email, guest_name)
       VALUES ($1,$2,'nightly',$3,$4,$5,'tentative',$6,'gina@t.dev','Gina Guest') RETURNING id`,
      [unitId, f.landlordId, checkIn, checkOut, nights, total]))[0].id
  }
  const bookingRow = async (id: string) => (await query<any>(
    `SELECT status, check_in::text AS check_in, check_out::text AS check_out, nights, total_amount::float AS total,
            deposit_paid_at, balance_billed_at, balance_paid_at, pos_transaction_id FROM unit_bookings WHERE id = $1`, [id]))[0]
  const settle = (f: any, body: any, token = f.token) => request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${token}`).send({ paymentMethod: 'cash', propertyId: f.propertyId, ...body })
  const linkStatus = async (id: string) => (await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [id]))[0].status
  const sales = async (f: any) => query<any>(`SELECT id, total FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])
  const depositLine = (price = 100, qty = 1) => ({ id: null, name: 'Reservation deposit', qty, price, tax: 0 })

  it('a deposit link is settled with its deposit line whole, or not at all — at the counter, by anyone', async () => {
    const f = await seed()
    const cashier = await desk(f)
    const unitId = await siteAt(f, '05')
    const b = await heldBooking(f, unitId, '2027-04-01', '2027-04-08', 7, 280)
    const link = await createBookingDepositLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 100, guestName: 'Gina Guest', guestEmail: 'gina@t.dev' })
    const words = /This link pays for a reservation — keep the "Reservation deposit" line just as it was \(the whole amount\), then press Charge again\. To change the reservation, use the schedule\./
    for (const [label, items, tok] of [
      ['propane instead', [propane(f, 1)], cashier],
      ['a penny of it', [depositLine(100, 0.01)], cashier],
      ['half of it', [depositLine(100, 0.5)], f.token],
      ['at another price', [depositLine(1)], f.token],
      ['twice', [depositLine(100, 2)], f.token],
    ] as const) {
      const r = await settle(f, { items, payLinkId: link.id }, tok)
      expect(r.status, label).toBe(400)
      expect(r.body.error, label).toMatch(words)
    }
    expect(await sales(f)).toHaveLength(0)
    expect(await linkStatus(link.id)).toBe('open')
    expect(await bookingRow(b)).toMatchObject({ status: 'tentative', deposit_paid_at: null, pos_transaction_id: null })
    // Whole — with a tank of propane beside it — it settles, and the reservation is the guest's.
    const ok = await settle(f, { items: [depositLine(), propane(f, 1)], payLinkId: link.id }, cashier)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBeCloseTo(103.3, 2)
    const after = await bookingRow(b)
    expect(after).toMatchObject({ status: 'confirmed', pos_transaction_id: ok.body.data.id, balance_paid_at: null })
    expect(after.deposit_paid_at).not.toBeNull()
  })

  it('a stay-balance link is settled with its balance line whole, or not at all', async () => {
    const f = await seed()
    const unitId = await siteAt(f, '06')
    const b = await heldBooking(f, unitId, '2027-04-01', '2027-04-08', 7, 280)
    await query(`UPDATE unit_bookings SET status = 'confirmed', deposit_amount = 100, deposit_paid_at = NOW() WHERE id = $1`, [b])
    const link = await createStayBalanceLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, label: 'Stay balance — site RV 06',
      amount: 180, guestName: 'Gina Guest', guestEmail: 'gina@t.dev' })
    const line = { id: null, name: 'Stay balance — site RV 06', qty: 1, price: 180, tax: 0 }
    const short = await settle(f, { items: [{ ...line, qty: 0.5 }], payLinkId: link.id })
    expect(short.status).toBe(400)
    expect(short.body.error).toMatch(/keep the "Stay balance — site RV 06" line just as it was/)
    expect((await bookingRow(b)).balance_paid_at).toBeNull()
    const ok = await settle(f, { items: [line], payLinkId: link.id })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect((await bookingRow(b)).balance_paid_at).not.toBeNull()
  })

  it('adjusting a deposit link keeps the deposit line whole; a link for a reservation always carries what is owed on it', async () => {
    const f = await seed()
    const unitId = await siteAt(f, '07')
    const b = await heldBooking(f, unitId, '2027-04-01', '2027-04-08', 7, 280)
    const link = await createBookingDepositLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 100, guestName: 'Gina Guest', guestEmail: 'gina@t.dev' })
    const adjust = (items: any[]) => request(linkApp()).patch(`/api/pos/pay-links/${link.id}`).set('Authorization', `Bearer ${f.token}`).send({ items })
    for (const items of [[propane(f, 1)], [depositLine(40)], [depositLine(100, 0.5)]]) {
      const r = await adjust(items)
      expect(r.status, JSON.stringify(items)).toBe(400)
      expect(r.body.error).toMatch(/keep the "Reservation deposit" line just as it was \(the whole amount\), then press Save changes again/)
    }
    expect(Number((await query<any>(`SELECT total FROM pos_pay_links WHERE id = $1`, [link.id]))[0].total)).toBe(100)
    const more = await adjust([depositLine(), propane(f, 1)])
    expect(more.status, JSON.stringify(more.body)).toBe(200)
    expect(Number(more.body.data.total)).toBeCloseTo(103.3, 2)
    // A link sent for a reservation already on the schedule, with nothing on it
    // for the reservation, is refused — even from the owner.
    const bare = await request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, kind: 'one_time', bookingId: b, customer: { email: 'gina@t.dev' }, items: [propane(f, 1)] })
    expect(bare.status).toBe(400)
    expect(bare.body.error).toMatch(/A link for a reservation carries the amount owed on it/)
  })

  // 10/2 (decisions #9): a reservation ticket charges the reservation's OWN
  // quoted price — what is still owed on it — never the stay item's rate × a
  // quantity, and the booking's price is never overwritten by the till.
  it('a reservation ticket charges the reservation\'s own price, as the ticket shows it — any other figure is refused before any money moves', async () => {
    const f = await seed()
    const cashier = await desk(f)
    const unitId = await siteAt(f, '07')
    const cheap = await siteAt(f, '99', { nightly: 1 })
    // Quoted at $300 for the week (the site's rate says $40 a night — $280).
    const b = await heldBooking(f, unitId, '2027-05-01', '2027-05-08', 7, 300)
    const t = (await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
       VALUES ($1,$2,(SELECT user_id FROM landlords WHERE id = $1),$3::jsonb,'Walk-in · site RV 07',$4) RETURNING id`,
      [f.landlordId, f.propertyId, JSON.stringify([{ id: f.stayItemId, name: 'RV site — nightly', qty: 7, price: 0, tax: 0 }]), b]))[0].id
    const opened = await request(buildApp()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set('Authorization', `Bearer ${cashier}`)
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    const line = opened.body.data.items[0]
    expect(line).toMatchObject({ id: f.stayItemId, qty: 1, price: 300, tax: 0, reservation: true, stay: true })
    expect(line.name).toBe('RV site — nightly — 7 nights at site RV 07 (May 1 → May 8)')
    // The open list shows it at the same price.
    const listed = (await request(buildApp()).get(`/api/pos/tickets?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${cashier}`))
      .body.data.find((x: any) => x.id === t)
    expect(listed.items[0]).toMatchObject({ qty: 1, price: 300, reservation: true })

    const words = 'This reservation — 7 nights at site RV 07 (May 1 → May 8) — comes to $300.00 — the cart shows something else, '
      + 'and nothing was charged. Press Clear, open the ticket again, then press Charge.'
    const night = (qty: number, price = 0) => ({ id: f.stayItemId, name: 'RV site — nightly', qty, price, tax: 0 })
    // Item rate × nights, a night short, the old $0 line: refused.
    for (const items of [[night(7, 40)], [night(6, 40)], [night(1, 0)], [night(7)]]) {
      const r = await settle(f, { items, openTicketId: t }, cashier)
      expect(r.status, JSON.stringify(items)).toBe(409)
      expect(r.body.error).toBe(words)
    }
    const split = await settle(f, { items: [night(1, 150), night(1, 150)], openTicketId: t }, cashier)
    expect(split.status).toBe(400)
    expect(split.body.error).toMatch(/keep just one stay line for it, then press Charge again/)
    const half = await settle(f, { items: [night(6.5)], openTicketId: t }, cashier)
    expect(half.status).toBe(400)
    expect(half.body.error).toBe('A stay is whole nights — fix how many on "RV site — nightly", then press Charge again.')
    // A reservation is charged whole: no discount, even from the owner.
    const off = await settle(f, { items: [line], openTicketId: t, discountAmount: 20 })
    expect(off.status).toBe(400)
    expect(off.body.error).toBe('A reservation is charged at its own price — take the discount off, then press Charge again. To change what it costs, change the reservation on the schedule.')
    expect(await sales(f)).toHaveLength(0)
    expect(await bookingRow(b)).toMatchObject({ status: 'tentative', deposit_paid_at: null, balance_paid_at: null, total: 300 })
    expect(await openTickets(f)).toHaveLength(1)
    // As the ticket showed it — and a site of the cart's own choosing changes nothing.
    const ok = await settle(f, { items: [line], openTicketId: t, stay: { unitId: cheap, checkIn: '2027-05-01', guestName: 'Gina Guest' } }, cashier)
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(300)
    const paid = await bookingRow(b)
    expect(paid).toMatchObject({ status: 'confirmed', check_in: '2027-05-01', check_out: '2027-05-08', nights: 7, total: 300, pos_transaction_id: ok.body.data.id })
    expect(paid.balance_paid_at).not.toBeNull()
    expect(await query(`SELECT 1 FROM unit_bookings`)).toHaveLength(1)
    // Paid in full: the ticket is off the list, and nothing can be charged on it again.
    expect(await openTickets(f)).toHaveLength(0)
    const again = await settle(f, { items: [line], openTicketId: t }, cashier)
    expect(again.status).toBe(409)
  })

  it('a reservation the schedule handed over in weeks it does not fill is charged its own price — never the weekly rate × weeks', async () => {
    const f = await seed()
    const week = (await query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — weekly',(SELECT category_id FROM pos_items WHERE id = $3),0,0,0,999,0,999,'week') RETURNING id`,
      [f.landlordId, f.propertyId, f.stayItemId]))[0].id
    const unitId = await siteAt(f, '08', { nightly: 40, weekly: 250 })
    const ticketFor = async (b: string, qty: number) => (await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
       VALUES ($1,$2,(SELECT user_id FROM landlords WHERE id = $1),$3::jsonb,'Walk-in · site RV 08',$4) RETURNING id`,
      [f.landlordId, f.propertyId, JSON.stringify([{ id: week, name: 'RV site — weekly', qty, price: 0, tax: 0 }]), b]))[0].id
    const open = async (t: string) => (await request(buildApp()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`)
      .set('Authorization', `Bearer ${f.token}`)).body.data
    // Ten nights, handed over as one week (the schedule rounds): $400, as quoted.
    const ten = await heldBooking(f, unitId, '2027-06-01', '2027-06-11', 10, 400)
    const tenTicket = await ticketFor(ten, 1)
    const tenOpen = await open(tenTicket)
    expect(tenOpen.items[0]).toMatchObject({ id: week, qty: 1, price: 400, reservation: true })
    expect(tenOpen.items[0].name).toBe('RV site — weekly — 10 nights at site RV 08 (Jun 1 → Jun 11)')
    const one = await settle(f, { items: [{ id: week, name: 'RV site — weekly', qty: 1, price: 250, tax: 0 }], openTicketId: tenTicket })
    expect(one.status).toBe(409)
    expect((await bookingRow(ten)).balance_paid_at).toBeNull()
    const r = await settle(f, { items: tenOpen.items, openTicketId: tenTicket })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(Number(r.body.data.total)).toBe(400)
    expect(await bookingRow(ten)).toMatchObject({ status: 'confirmed', nights: 10, total: 400 })
    // Fourteen nights quoted at $560: two weeks at the weekly rate would be $500 — it is $560.
    const two = await heldBooking(f, unitId, '2027-07-01', '2027-07-15', 14, 560)
    const twoTicket = await ticketFor(two, 2)
    const twoOpen = await open(twoTicket)
    expect(twoOpen.items[0]).toMatchObject({ qty: 1, price: 560 })
    const ok = await settle(f, { items: twoOpen.items, openTicketId: twoTicket })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(560)
    expect(await bookingRow(two)).toMatchObject({ status: 'confirmed', check_out: '2027-07-15', nights: 14, total: 560 })
  })

  // 10/2 (decisions #9): what is owed is the reservation's price less what was
  // paid toward it; paying the rest in full closes every other way of paying it.
  it('a deposit paid online first: the ticket charges the rest; paid in full, the deposit link closes and its card page is shut', async () => {
    const f = await seed()
    const unitId = await siteAt(f, '10')
    const b = await heldBooking(f, unitId, '2027-08-01', '2027-08-08', 7, 280)
    const t = (await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
       VALUES ($1,$2,(SELECT user_id FROM landlords WHERE id = $1),$3::jsonb,'Walk-in · site RV 10',$4) RETURNING id`,
      [f.landlordId, f.propertyId, JSON.stringify([{ id: f.stayItemId, name: 'RV site — nightly', qty: 7, price: 0, tax: 0 }]), b]))[0].id
    const deposit = await createBookingDepositLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 56, guestName: 'Gina Guest', guestEmail: 'gina@t.dev' })
    const balanceLink = await createBookingDepositLink({ bookingId: b, landlordId: f.landlordId, propertyId: f.propertyId, amount: 56, guestName: 'Gina Guest', guestEmail: 'gina@t.dev' })
    expect(balanceLink).toBeNull()   // one deposit per reservation
    const open = async () => request(buildApp()).get(`/api/pos/tickets/${t}?propertyId=${f.propertyId}&kind=ticket`).set('Authorization', `Bearer ${f.token}`)
    // Before the deposit: all of it.
    const before = (await open()).body.data.items[0]
    expect(before).toMatchObject({ price: 280 })
    // The deposit is paid at the counter (as it would be online): $224 left.
    const dep = await settle(f, { items: [depositLine(56)], payLinkId: deposit!.id })
    expect(dep.status, JSON.stringify(dep.body)).toBe(201)
    const stale = await settle(f, { items: [before], openTicketId: t })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/comes to \$224\.00 after the \$56\.00 already paid — the cart shows something else, and nothing was charged/)
    const after = (await open()).body.data.items[0]
    expect(after).toMatchObject({ qty: 1, price: 224 })
    expect(after.name).toMatch(/balance after \$56\.00 paid$/)
    // A second link left open on the reservation (an amount the office emailed) closes with full payment.
    const extra = await request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, kind: 'one_time', bookingId: b, customer: { email: 'gina@t.dev' }, items: [{ id: null, name: 'Stay balance', qty: 1, price: 224, tax: 0 }] })
    expect(extra.status, JSON.stringify(extra.body)).toBe(201)
    const ok = await settle(f, { items: [after], openTicketId: t })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(Number(ok.body.data.total)).toBe(224)
    expect(await bookingRow(b)).toMatchObject({ status: 'confirmed', total: 280 })
    expect((await bookingRow(b)).balance_paid_at).not.toBeNull()
    expect(await linkStatus(extra.body.data.id)).toBe('cancelled')
    // Paid in full: a link sent for it now is refused, and so is settling one.
    const late = await request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, kind: 'one_time', bookingId: b, customer: { email: 'gina@t.dev' }, items: [{ id: null, name: 'Stay balance', qty: 1, price: 10, tax: 0 }] })
    expect(late.status).toBe(409)
    expect(late.body.error).toBe('That reservation is already paid — nothing was sent. Press Cancel.')
  })

  it('a stay is whole nights everywhere a stay quantity is read', async () => {
    const f = await seed()
    const unitId = await siteAt(f, '09')
    const stayLine = (qty: number) => ({ id: f.stayItemId, name: 'RV site — nightly', qty, price: 40, tax: 0 })
    const words = (press: string) => `A stay is whole nights — fix how many on "RV site — nightly", then press ${press} again.`
    // Sending a link.
    const sendStay = (qty: number) => request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Dale Carter', email: 'dale@t.dev' },
              items: [stayLine(qty)], stay: { unitId, checkIn: '2027-06-12', guestName: 'Dale Carter' } })
    const halfLink = await sendStay(2.5)
    expect(halfLink.status).toBe(400)
    expect(halfLink.body.error).toBe(words('Send link'))
    expect(await query(`SELECT 1 FROM unit_bookings`)).toHaveLength(0)
    const sent = await sendStay(3)
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const link = sent.body.data.id
    // Adjusting it.
    const adjusted = await request(linkApp()).patch(`/api/pos/pay-links/${link}`).set('Authorization', `Bearer ${f.token}`).send({ items: [stayLine(1.5)] })
    expect(adjusted.status).toBe(400)
    expect(adjusted.body.error).toBe(words('Save changes'))
    // Settling it at the counter: the probe's half a night.
    const half = await settle(f, { items: [stayLine(0.5)], payLinkId: link })
    expect(half.status).toBe(400)
    expect(half.body.error).toBe(words('Charge'))
    expect(await query<any>(`SELECT check_in::text AS ci, check_out::text AS co, nights, status FROM unit_bookings`))
      .toEqual([{ ci: '2027-06-12', co: '2027-06-15', nights: 3, status: 'tentative' }])
    expect(await linkStatus(link)).toBe('open')
    // A walk-up stay, the quote and the card charge.
    const walkUp = await settle(f, { items: [stayLine(1.5)], stay: { unitId, checkIn: '2027-08-01', guestName: 'Pat Ruiz' } })
    expect(walkUp.status).toBe(400)
    expect(walkUp.body.error).toBe(words('Charge'))
    const quote = await request(buildApp()).post('/api/pos/cart-quote').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [stayLine(1.5)], paymentMethod: 'card', propertyId: f.propertyId })
    expect(quote.status).toBe(400)
    expect(quote.body.error).toBe(words('Charge'))
    // A reservation ticket put back.
    const b = await heldBooking(f, unitId, '2027-09-01', '2027-09-03', 2, 80)
    const t = (await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, note, booking_id)
       VALUES ($1,$2,(SELECT user_id FROM landlords WHERE id = $1),$3::jsonb,'Walk-in · site RV 09',$4) RETURNING id`,
      [f.landlordId, f.propertyId, JSON.stringify([{ id: f.stayItemId, name: 'RV site — nightly', qty: 2, price: 0, tax: 0 }]), b]))[0].id
    const back = await putBack(f, t, { items: [{ id: f.stayItemId, name: 'RV site — nightly', qty: 1.5, price: 0, tax: 0 }] })
    expect(back.status).toBe(400)
    expect(back.body.error).toBe(words('Clear'))
    expect(Number((await openTickets(f)).find((x: any) => x.id === t).items[0].qty)).toBe(2)
    expect(await sales(f)).toHaveLength(0)
  })

  it('a line of nothing is refused in the clerk\'s words — never a database error — and so is a link\'s own line at nothing', async () => {
    const f = await seed()
    const zero = await settle(f, { items: [propane(f, 0)] })
    expect(zero.status).toBe(400)
    expect(zero.body.error).toBe('A line in the cart needs a quantity above zero — fix how many, then press Charge again.')
    const missing = await settle(f, { items: [{ id: f.itemId, name: 'Propane (per gal)', price: 3.30, tax: 0 }] })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('A line in the cart needs a quantity above zero — fix how many, then press Charge again.')
    const typed = await request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, kind: 'one_time', customer: { email: 'pat@t.dev' }, items: [{ id: null, name: 'Late checkout', qty: 1, price: 15, tax: 0 }, propane(f, 1)] })
    expect(typed.status, JSON.stringify(typed.body)).toBe(201)
    const own = await settle(f, { items: [{ id: null, name: 'Late checkout', qty: 0, price: 15, tax: 0 }, propane(f, 1)], payLinkId: typed.body.data.id })
    expect(own.status).toBe(400)
    expect(own.body.error).toBe('A line in the cart needs a quantity above zero — fix how many, then press Charge again.')
    expect(await sales(f)).toHaveLength(0)
  })

  it('a link\'s discount covers the share of the link kept: all of it for the whole order, its share for part, never all of it for part', async () => {
    const f = await seed()
    const cashier = await desk(f)
    // The owner sends ten gallons with $10 off: $33.00 − $10.00.
    const send = async () => {
      const r = await request(linkApp()).post('/api/pos/pay-links').set('Authorization', `Bearer ${f.token}`)
        .send({ propertyId: f.propertyId, kind: 'one_time', customer: { email: 'pat@t.dev' }, items: [propane(f, 10)], discountAmount: 10 })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(Number(r.body.data.total)).toBe(23)
      return r.body.data.id as string
    }
    const words = (press: string) => `The link's discount was for the whole order — put back the lines you took out, or ask a manager to change the discount, then press ${press} again.`
    // At the counter: three of the ten, still $10 off — refused.
    const a = await send()
    const whole = await settle(f, { items: [propane(f, 3)], discountAmount: 10, payLinkId: a }, cashier)
    expect(whole.status).toBe(403)
    expect(whole.body.error).toBe(words('Charge'))
    expect(await linkStatus(a)).toBe('open')
    // Its share ($3 of the $10) is the link's own: $9.90 − $3.00.
    const share = await settle(f, { items: [propane(f, 3)], discountAmount: 3, payLinkId: a }, cashier)
    expect(share.status, JSON.stringify(share.body)).toBe(201)
    expect(Number(share.body.data.total)).toBeCloseTo(6.9, 2)
    // Saying nothing about a discount, the share is applied.
    const b = await send()
    const quiet = await settle(f, { items: [propane(f, 3)], payLinkId: b }, cashier)
    expect(quiet.status, JSON.stringify(quiet.body)).toBe(201)
    expect(Number(quiet.body.data.total)).toBeCloseTo(6.9, 2)
    // The whole order keeps the whole discount.
    const c = await send()
    const all = await settle(f, { items: [propane(f, 10)], discountAmount: 10, payLinkId: c }, cashier)
    expect(all.status, JSON.stringify(all.body)).toBe(201)
    expect(Number(all.body.data.total)).toBe(23)
    // Adjusting a link: the same rule.
    const d = await send()
    const adjust = (body: any) => request(linkApp()).patch(`/api/pos/pay-links/${d}`).set('Authorization', `Bearer ${cashier}`).send(body)
    const kept = await adjust({ items: [propane(f, 10)], discountAmount: 10 })
    expect(kept.status, JSON.stringify(kept.body)).toBe(200)
    expect(Number(kept.body.data.total)).toBe(23)
    const carried = await adjust({ items: [propane(f, 3)], discountAmount: 10 })
    expect(carried.status).toBe(403)
    expect(carried.body.error).toBe(words('Save changes'))
    const fewer = await adjust({ items: [propane(f, 3)] })
    expect(fewer.status, JSON.stringify(fewer.body)).toBe(200)
    expect(Number(fewer.body.data.discountAmount)).toBe(3)
    expect(Number(fewer.body.data.total)).toBeCloseTo(6.9, 2)
    // Put back to ten, the discount does not grow back on its own.
    const again = await adjust({ items: [propane(f, 10)] })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(Number(again.body.data.discountAmount)).toBe(3)
  })
})

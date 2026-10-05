/**
 * S652 — the register charges a card that is already on file.
 *
 * Nic: "maybe if they save a payment method on file as a point of sale
 * customer, we can just auto charge them on delivery and we don't even have to
 * take the reader with us."
 *
 * And, correcting me when I claimed tenants could not have one: "when somebody
 * is a tenant and they sign up, it is save and pay. The same button click does
 * both. So once they're already a tenant, the card is saved." He is right —
 * rent's own charge carries setup_future_usage (S603), so a tenant who has paid
 * once by card has a card on file as a by-product.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

const created: any[] = []
// 10/2: a card on file is held, then captured as the sale is written — or let go.
const captured: string[] = []
const released: string[] = []
let cardOnCustomer: any = { id: 'pm_saved', type: 'card', card: { brand: 'visa', last4: '4242' } }
let chargeBehavior: 'ok' | 'auth_required' | 'declined' = 'ok'
// 10/2: cards kept on OTHER Stripe customers (a record folded into another
// keeps its card on its own Stripe customer), by PaymentMethod id.
let otherCards: Record<string, any> = {}

vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    customers:      { retrieve: async (id: string) => ({ id, invoice_settings: {} }) },
    paymentMethods: {
      list:     async (args: any) => ({ data: args?.customer === 'cus_1' && cardOnCustomer ? [cardOnCustomer]
        : Object.values(otherCards).filter((c: any) => c.customer === args?.customer) }),
      retrieve: async (id: string) => otherCards[id] ?? cardOnCustomer,
    },
    paymentIntents: {
      create: async (args: any) => {
        created.push(args)
        if (chargeBehavior === 'auth_required') {
          const e: any = new Error('auth needed'); e.code = 'authentication_required'; throw e
        }
        if (chargeBehavior === 'declined') {
          const e: any = new Error('Your card was declined'); e.code = 'card_declined'; throw e
        }
        return { id: 'pi_on_file', status: args?.capture_method === 'manual' ? 'requires_capture' : 'succeeded' }
      },
      capture: async (id: string) => { captured.push(id); return { id, status: 'succeeded' } },
      cancel:  async (id: string) => { released.push(id); return { id, status: 'canceled' } },
    },
  }),
}))
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

let posRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  created.length = 0; captured.length = 0; released.length = 0
  cardOnCustomer = { id: 'pm_saved', type: 'card', card: { brand: 'visa', last4: '4242' } }
  otherCards = {}
  chargeBehavior = 'ok'
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_cof'
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
    // The property absorbs the card fee, so the totals in these tests are the
    // cart — what is under test is the CHARGE, not the fee split.
    await c.query(`UPDATE properties SET register_card_fee_payer = 'landlord' WHERE id = $1`, [propertyId])
    const cat = await c.query(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1,'Fuel',1,TRUE) RETURNING id`, [landlordId])
    const item = await c.query(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price,
                              cost_price, tax_rate, stock_qty, stock_min, stock_max)
       VALUES ($1,$2,'Propane',$3,20,0,0,999,0,999) RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])
    const cust = await c.query(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, stripe_customer_id)
       VALUES ($1,'Ray','Delgado','ray@t.dev','cus_1') RETURNING id`, [landlordId])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, itemId: item.rows[0].id, customerId: cust.rows[0].id, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const sell = (f: any, body: any = {}) =>
  request(buildApp()).post('/api/pos/transactions')
    .set('Authorization', `Bearer ${f.token}`)
    .send({
      items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20, tax: 0 }],
      paymentMethod: 'card_on_file', propertyId: f.propertyId,
      posCustomerId: f.customerId, ...body,
    })

describe('charging the card already on file', () => {
  it('takes the money off-session and records the sale against that intent', async () => {
    const f = await seed()
    const res = await sell(f)
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    // off_session is the whole point: nobody is standing there to be challenged.
    expect(created[0].off_session).toBe(true)
    expect(created[0].payment_method).toBe('pm_saved')
    expect(created[0].amount).toBe(2000)

    const [tx] = await query<any>(
      `SELECT payment_method, stripe_payment_intent_id FROM pos_transactions`)
    expect(tx.payment_method).toBe('card_on_file')
    expect(tx.stripe_payment_intent_id).toBe('pi_on_file')
    // Held first, taken as the sale was written.
    expect(created[0].capture_method).toBe('manual')
    expect(captured).toEqual(['pi_on_file'])
    expect(released).toEqual([])
  })

  // 10/2: "On file" took the money BEFORE the sale was written, so a ticket
  // settled at another register a moment earlier meant a charge with no sale.
  it('a sale that cannot be written is never charged — the hold on the card is let go', async () => {
    const f = await seed()
    const ticket = await request(buildApp()).post('/api/pos/tickets').set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: f.propertyId, posCustomerId: f.customerId, items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20, tax: 0 }] })
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201)
    // Settled at the other register first.
    const cash = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.token}`)
      .send({ items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20, tax: 0 }], paymentMethod: 'cash', propertyId: f.propertyId,
              posCustomerId: f.customerId, openTicketId: ticket.body.data.id })
    expect(cash.status).toBe(201)
    const late = await sell(f, { openTicketId: ticket.body.data.id })
    expect(late.status).toBe(409)
    expect(late.body.error).toMatch(/nothing was charged/i)
    expect(created).toHaveLength(1)
    expect(captured).toEqual([])
    expect(released).toEqual(['pi_on_file'])
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(1)
  })

  it('refuses when they have no card, and says what to do instead', async () => {
    // "Run it on the reader" is the useful answer: it saves the card in the
    // same motion, so the next sale can use this button.
    const f = await seed()
    cardOnCustomer = null
    const res = await sell(f)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/reader/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('records no sale when the bank wants the cardholder present', async () => {
    const f = await seed()
    chargeBehavior = 'auth_required'
    const res = await sell(f)
    expect(res.status).toBe(402)
    expect(res.body.error).toMatch(/cardholder present|reader/i)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('records no sale on a decline', async () => {
    // A sale row for money that never arrived is worse than no row.
    const f = await seed()
    chargeBehavior = 'declined'
    const res = await sell(f)
    expect(res.status).toBe(402)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('will not charge a card without being told whose it is', async () => {
    const f = await seed()
    const res = await sell(f, { posCustomerId: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/who this sale is for/i)
  })

  it('cannot reach another company\'s customer', async () => {
    const f = await seed()
    const other = await seed()
    const res = await sell(f, { posCustomerId: other.customerId })
    expect(res.status).toBe(404)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
  })

  it('the card fee is the same one every other card pays', async () => {
    // memory: gam-card-fee-every-card-payment — the counter terminal, the
    // register, pay links and this all pass the same fee.
    const f = await seed()
    await query(`UPDATE properties SET register_card_fee_payer = 'customer' WHERE id = $1`, [f.propertyId])
    const res = await sell(f)
    expect(res.status).toBe(201)
    // 3.5% + $0.55 on $20, passed to the customer.
    expect(Number(res.body.data.total)).toBeGreaterThan(20)
    expect(created[0].amount).toBe(Math.round(Number(res.body.data.total) * 100))
  })

  // Defect 4: a card kept on the reader lives on the Stripe customer of the
  // record it was kept on. Folding that record into another moved the card's
  // row, but the survivor kept its own Stripe customer — so "On file" looked
  // there, found nothing, and the saved card could not be charged.
  it('a card kept on a record that was merged away is still found and charged through its own Stripe customer', async () => {
    const f = await seed()
    cardOnCustomer = null   // Ray's own Stripe customer holds no card
    const folded = (await query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, created_from, stripe_customer_id)
       VALUES ($1,'Card','Customer','card_reader','cus_b') RETURNING id`, [f.landlordId]))[0].id
    await query(
      `INSERT INTO pos_customer_cards (landlord_id, pos_customer_id, fingerprint, brand, last4, stripe_payment_method_id, saved_at)
       VALUES ($1,$2,'fp_b','mastercard','5100','pm_b',NOW())`, [f.landlordId, folded])
    otherCards = { pm_b: { id: 'pm_b', type: 'card', customer: 'cus_b', card: { brand: 'mastercard', last4: '5100' } } }
    const merged = await request(buildApp()).post(`/api/pos/customers/${folded}/merge`)
      .set('Authorization', `Bearer ${f.token}`).send({ into: f.customerId })
    expect(merged.status, JSON.stringify(merged.body)).toBe(200)

    const shown = await request(buildApp()).get(`/api/pos/card-on-file?propertyId=${f.propertyId}&posCustomerId=${f.customerId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(shown.status).toBe(200)
    expect(shown.body.data).toMatchObject({ brand: 'mastercard', last4: '5100' })
    const res = await sell(f)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(created[0]).toMatchObject({ payment_method: 'pm_b', customer: 'cus_b', off_session: true })
  })
})

// 10/2 (review): naming somebody on a sale needs only a tie of any kind — an
// invite, even a cancelled one. Their OWN card (the one on their GAM account,
// saved paying rent, possibly to another company) is reached only when they
// lease here. Found by probe: a company that invited an email and cancelled it
// saw the card and charged it off-session.
describe('whose card this company may take', () => {
  async function tenantWithCard(stripeCustomerId: string, first = 'Jane', last = 'Probe'): Promise<string> {
    const u = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone, email_verified)
       VALUES ($1,'x','tenant',$2,$3,'(520) 555-0142',TRUE) RETURNING id`,
      [`${first}.${Math.random().toString(36).slice(2)}@probe.dev`.toLowerCase(), first, last])
    const t = await query<{ id: string }>(`INSERT INTO tenants (user_id, stripe_customer_id) VALUES ($1,$2) RETURNING id`, [u[0].id, stripeCustomerId])
    otherCards = { ...otherCards, [`pm_${stripeCustomerId}`]: { id: `pm_${stripeCustomerId}`, type: 'card', customer: stripeCustomerId, card: { brand: 'visa', last4: '4242' } } }
    return t[0].id
  }
  const cardOnFile = (f: any, q: string) => request(buildApp()).get(`/api/pos/card-on-file?propertyId=${f.propertyId}&${q}`)
    .set('Authorization', `Bearer ${f.token}`)

  it('a tenant tied only by a cancelled invite: no card on file, the sale is refused, nothing is charged, and their account contact stays hidden', async () => {
    const f = await seed()
    const jane = await tenantWithCard('cus_tenant_x')
    await query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id, cancelled_at) VALUES ($1,$2,$3,NOW())`,
      [f.landlordId, jane, f.propertyId])

    // Named on a sale: yes (the any-tie rule). Her card: no.
    const shown = await cardOnFile(f, `tenantId=${jane}`)
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    expect(shown.body.data).toBeNull()
    const sale = await sell(f, { posCustomerId: null, tenantId: jane })
    expect(sale.status).toBe(409)
    expect(sale.body.error).toMatch(/no card on file/i)

    // Nor through a register record of this company's that carries her tenant id.
    const rec = (await query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, tenant_id) VALUES ($1,'Jane','Probe',$2) RETURNING id`,
      [f.landlordId, jane]))[0].id
    const viaRecord = await cardOnFile(f, `posCustomerId=${rec}`)
    expect(viaRecord.status).toBe(200)
    expect(viaRecord.body.data).toBeNull()
    const sale2 = await sell(f, { posCustomerId: rec })
    expect(sale2.status).toBe(409)
    expect(created).toHaveLength(0)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)

    // The record shows her by name; the email and phone on her account do not cross.
    const list = await request(buildApp()).get(`/api/pos/customers?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.token}`)
    const row = list.body.data.find((r: any) => r.id === rec)
    expect(row).toMatchObject({ firstName: 'Jane', lastName: 'Probe', email: null, phone: null })
    const found = await request(buildApp()).get(`/api/pos/people?propertyId=${f.propertyId}&q=Probe`).set('Authorization', `Bearer ${f.token}`)
    expect(found.status).toBe(200)
    const hit = found.body.data.find((h: any) => h.customerId === rec)
    expect(hit).toBeTruthy()
    expect(hit.email).toBeNull()
    expect(hit.phone).toBeNull()
    expect(JSON.stringify(found.body)).not.toMatch(/555-?0142|probe\.dev/i)
  })

  // (A lease only the landlord signed counts when this company is the only one
  // they have dealt with — the residents it onboarded itself, a paper lease imported.)
  it('a resident who leases here: the card on their account is on file, and it is charged', async () => {
    const f = await seed()
    const ray = await tenantWithCard('cus_tenant_r', 'Ray', 'Lease')
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: ray })
    } finally { c.release() }
    const shown = await cardOnFile(f, `tenantId=${ray}`)
    expect(shown.body.data).toMatchObject({ brand: 'visa', last4: '4242', holderName: 'Ray Lease' })
    const sale = await sell(f, { posCustomerId: null, tenantId: ray })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(created[0]).toMatchObject({ customer: 'cus_tenant_r', payment_method: 'pm_cus_tenant_r', off_session: true })
    expect(captured).toEqual(['pi_on_file'])
  })

  it('a voided place on a lease here is not a lease here', async () => {
    const f = await seed()
    const ex = await tenantWithCard('cus_tenant_v', 'Vic', 'Void')
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId })
      const lt = await seedLeaseTenant(c, { leaseId, tenantId: ex })
      await c.query(`UPDATE lease_tenants SET status = 'void' WHERE id = $1`, [lt])
    } finally { c.release() }
    const shown = await cardOnFile(f, `tenantId=${ex}`)
    expect(shown.status).toBe(200)
    expect(shown.body.data).toBeNull()
    expect(created).toHaveLength(0)
  })

  // 10/2 (review): a landlord drafts a 'pending_add' place alone — an
  // addendum adding somebody to a lease, before anyone signs. Found by probe:
  // invite an email, draft that addendum, and the person's own card and the
  // phone on their account were behind the "On file" button. A place counts
  // only once it is TAKEN: active, on its way off, or held once.
  it('an invite plus a place drafted for them (pending_add) is not a lease here: no card on file, nothing charged, their account contact stays hidden', async () => {
    const f = await seed()
    const jane = await tenantWithCard('cus_tenant_pa', 'Jane', 'Addendum')
    await query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id) VALUES ($1,$2,$3)`, [f.landlordId, jane, f.propertyId])
    let placeId = ''
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId })
      placeId = await seedLeaseTenant(c, { leaseId, tenantId: jane, role: 'co_tenant' })
      await c.query(`UPDATE lease_tenants SET status = 'pending_add' WHERE id = $1`, [placeId])
    } finally { c.release() }

    const shown = await cardOnFile(f, `tenantId=${jane}`)
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    expect(shown.body.data).toBeNull()
    const sale = await sell(f, { posCustomerId: null, tenantId: jane })
    expect(sale.status).toBe(409)
    expect(sale.body.error).toMatch(/no card on file/i)
    expect(created).toHaveLength(0)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)

    // Typed at the register: listed by name, as somebody on their way in —
    // never with the email or phone on their own account, and not found by them.
    const search = (q: string) => request(buildApp()).get(`/api/pos/people?propertyId=${f.propertyId}&q=${encodeURIComponent(q)}`)
      .set('Authorization', `Bearer ${f.token}`)
    const found = await search('Addendum')
    expect(found.status).toBe(200)
    expect(found.body.data).toHaveLength(1)
    expect(found.body.data[0]).toMatchObject({ kind: 'resident', tenantId: jane, name: 'Jane Addendum', email: null, phone: null })
    expect(found.body.data[0].hint).toMatch(/^invited/)
    expect(JSON.stringify(found.body)).not.toMatch(/555-?0142|probe\.dev/i)
    expect((await search('0142')).body.data).toEqual([])
    // A cash sale names her; her register record shows no account contact either.
    const cash = await sell(f, { posCustomerId: null, tenantId: jane, paymentMethod: 'cash' })
    expect(cash.status, JSON.stringify(cash.body)).toBe(201)
    expect(cash.body.data.customer).toMatchObject({ firstName: 'Jane', lastName: 'Addendum', email: null })
    const list = await request(buildApp()).get(`/api/pos/customers?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.token}`)
    expect(list.body.data.find((r: any) => r.tenantId === jane)).toMatchObject({ email: null, phone: null })

    // Once she signs and the place is hers, the card on her account is on file.
    await query(`UPDATE lease_tenants SET status = 'active' WHERE id = $1`, [placeId])
    const now = await cardOnFile(f, `tenantId=${jane}`)
    expect(now.body.data).toMatchObject({ brand: 'visa', last4: '4242', holderName: 'Jane Addendum' })
    const hit = (await search('Addendum')).body.data[0]
    expect(hit).toMatchObject({ email: expect.stringMatching(/probe\.dev$/), phone: '(520) 555-0142', hint: expect.stringMatching(/^resident/) })
    // 10/2 (decisions #10): a place she held once (moved off) keeps neither
    // her card nor her account's live contact at this register — she is found
    // by name, and only what this company's own record holds comes back.
    await query(`UPDATE lease_tenants SET status = 'removed' WHERE id = $1`, [placeId])
    expect((await cardOnFile(f, `tenantId=${jane}`)).body.data).toBeNull()
    const gone = await search('Addendum')
    expect(gone.body.data[0]).toMatchObject({ tenantId: jane, name: 'Jane Addendum', email: null, phone: null })
    expect(JSON.stringify(gone.body)).not.toMatch(/555-?0142|probe\.dev/i)
    expect((await search('0142')).body.data).toEqual([])
  })

  // 10/2 (review, decided): the card on a resident's own GAM account reaches a
  // company's register only while they LIVE there — a current place on a
  // current lease. A company a person once leased from kept charging their
  // account card after they left, including a card they saved later paying rent
  // at a different company. decisions #10: their LIVE contact goes with them
  // too — the company they left sees only what its own register record holds.
  it('a former resident: the card on their account is not on file once they leave, and neither is its contact — only the record\'s own', async () => {
    const f = await seed()
    const ray = await tenantWithCard('cus_tenant_f', 'Ray', 'Former')
    let leaseId = '', placeId = ''
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      leaseId = await seedLease(c, { unitId, landlordId: f.landlordId })
      placeId = await seedLeaseTenant(c, { leaseId, tenantId: ray })
    } finally { c.release() }
    // Living here: on file.
    expect((await cardOnFile(f, `tenantId=${ray}`)).body.data).toMatchObject({ last4: '4242', holderName: 'Ray Former' })
    // On their way off (pending_remove): still here, still on file.
    await query(`UPDATE lease_tenants SET status = 'pending_remove' WHERE id = $1`, [placeId])
    expect((await cardOnFile(f, `tenantId=${ray}`)).body.data).toMatchObject({ last4: '4242' })
    // The lease ended — expired, or terminated: not on file, and nothing is charged.
    for (const ended of ['expired', 'terminated']) {
      await query(`UPDATE leases SET status = $2 WHERE id = $1`, [leaseId, ended])
      const shown = await cardOnFile(f, `tenantId=${ray}`)
      expect(shown.status, ended).toBe(200)
      expect(shown.body.data, ended).toBeNull()
      const sale = await sell(f, { posCustomerId: null, tenantId: ray })
      expect(sale.status, ended).toBe(409)
      expect(sale.body.error).toMatch(/no card on file/i)
    }
    // Moved off a lease that is still running for others: the same.
    await query(`UPDATE leases SET status = 'active' WHERE id = $1`, [leaseId])
    await query(`UPDATE lease_tenants SET status = 'removed' WHERE id = $1`, [placeId])
    expect((await cardOnFile(f, `tenantId=${ray}`)).body.data).toBeNull()
    // Through their register record too.
    const rec = (await query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, tenant_id) VALUES ($1,'Ray','Former',$2) RETURNING id`,
      [f.landlordId, ray]))[0].id
    expect((await cardOnFile(f, `posCustomerId=${rec}`)).body.data).toBeNull()
    expect((await sell(f, { posCustomerId: rec })).status).toBe(409)
    expect(created).toHaveLength(0)
    expect(await query('SELECT 1 FROM pos_transactions')).toHaveLength(0)
    // decisions #10: the live email and phone on their account are not this
    // register's any more — the Customers tab, the search and the sale show
    // only what the register record itself holds (nothing, here).
    const customers = () => request(buildApp()).get(`/api/pos/customers?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.token}`)
    const people = (q: string) => request(buildApp()).get(`/api/pos/people?propertyId=${f.propertyId}&q=${encodeURIComponent(q)}`).set('Authorization', `Bearer ${f.token}`)
    expect((await customers()).body.data.find((r: any) => r.id === rec)).toMatchObject({ email: null, phone: null })
    const found = await people('Former')
    expect(found.body.data[0]).toMatchObject({ tenantId: ray, name: 'Ray Former', email: null, phone: null, hint: expect.stringMatching(/^former resident/) })
    expect(JSON.stringify(found.body)).not.toMatch(/555-?0142|probe\.dev/i)
    const cash = await sell(f, { posCustomerId: rec, paymentMethod: 'cash' })
    expect(cash.status, JSON.stringify(cash.body)).toBe(201)
    expect(cash.body.data.customer).toMatchObject({ firstName: 'Ray', lastName: 'Former', email: null })
    // What the register record holds of its own is still shown — it is this company's.
    await query(`UPDATE pos_customers SET email = 'ray.counter@desk.test', phone = '520-555-7788' WHERE id = $1`, [rec])
    expect((await customers()).body.data.find((r: any) => r.id === rec)).toMatchObject({ email: 'ray.counter@desk.test', phone: '520-555-7788' })
    expect((await people('Former')).body.data[0]).toMatchObject({ tenantId: ray, email: 'ray.counter@desk.test', phone: '520-555-7788' })
    // Moved back in (a current place again): the account's own contact is shown.
    await query(`UPDATE lease_tenants SET status = 'active' WHERE id = $1`, [placeId])
    expect((await customers()).body.data.find((r: any) => r.id === rec)).toMatchObject({ email: expect.stringMatching(/probe\.dev$/), phone: '(520) 555-0142' })
    expect((await people('Former')).body.data[0]).toMatchObject({ tenantId: ray, email: expect.stringMatching(/probe\.dev$/), phone: '(520) 555-0142', hint: expect.stringMatching(/^resident/) })
  })

  // 10/2 (review): since S647 the landlord's signature alone builds a lease —
  // active, the person's place 'active', signed_by_tenant false. A company could
  // invite another company's resident, sign a lease for them, and reach the card
  // they saved paying rent there and the email and phone on their account.
  // Nobody is attached to a company without their OWN signature.
  it('another company\'s resident on a lease here only the landlord signed: no card on file, nothing charged, no account contact — until they sign it', async () => {
    const y = await seed()
    const x = await seed()
    const jane = await tenantWithCard('cus_tenant_x', 'Jane', 'Elsewhere')
    let leaseY = ''
    const c = await db.connect()
    try {
      // Jane leases at company X and saved her card there paying rent.
      const ux = await seedUnit(c, { propertyId: x.propertyId, landlordId: x.landlordId })
      const lx = await seedLease(c, { unitId: ux, landlordId: x.landlordId })
      await c.query(`UPDATE leases SET signed_by_landlord = TRUE, signed_by_tenant = TRUE WHERE id = $1`, [lx])
      await seedLeaseTenant(c, { leaseId: lx, tenantId: jane })
      // Company Y invites her email and signs a lease for her by itself.
      await c.query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id) VALUES ($1,$2,$3)`, [y.landlordId, jane, y.propertyId])
      const uy = await seedUnit(c, { propertyId: y.propertyId, landlordId: y.landlordId })
      leaseY = await seedLease(c, { unitId: uy, landlordId: y.landlordId })
      await c.query(`UPDATE leases SET signed_by_landlord = TRUE, signed_by_tenant = FALSE WHERE id = $1`, [leaseY])
      await seedLeaseTenant(c, { leaseId: leaseY, tenantId: jane })
    } finally { c.release() }

    const shown = await cardOnFile(y, `tenantId=${jane}`)
    expect(shown.status, JSON.stringify(shown.body)).toBe(200)
    expect(shown.body.data).toBeNull()
    const sale = await sell(y, { posCustomerId: null, tenantId: jane })
    expect(sale.status).toBe(409)
    expect(sale.body.error).toMatch(/no card on file/i)
    expect(created).toHaveLength(0)
    const search = () => request(buildApp()).get(`/api/pos/people?propertyId=${y.propertyId}&q=Elsewhere`).set('Authorization', `Bearer ${y.token}`)
    const found = await search()
    expect(found.body.data.find((h: any) => h.tenantId === jane)).toMatchObject({ name: 'Jane Elsewhere', email: null, phone: null })
    expect(JSON.stringify(found.body)).not.toMatch(/555-?0142|probe\.dev/i)
    const cash = await sell(y, { posCustomerId: null, tenantId: jane, paymentMethod: 'cash' })
    expect(cash.status, JSON.stringify(cash.body)).toBe(201)
    expect(cash.body.data.customer).toMatchObject({ firstName: 'Jane', lastName: 'Elsewhere', email: null })
    const list = await request(buildApp()).get(`/api/pos/customers?propertyId=${y.propertyId}`).set('Authorization', `Bearer ${y.token}`)
    expect(list.body.data.find((r: any) => r.tenantId === jane)).toMatchObject({ email: null, phone: null })

    // She signs it: the lease is hers, and so is everything it unlocks.
    await query(`UPDATE leases SET signed_by_tenant = TRUE WHERE id = $1`, [leaseY])
    expect((await cardOnFile(y, `tenantId=${jane}`)).body.data).toMatchObject({ brand: 'visa', last4: '4242', holderName: 'Jane Elsewhere' })
    const paid = await sell(y, { posCustomerId: null, tenantId: jane })
    expect(paid.status, JSON.stringify(paid.body)).toBe(201)
    expect(created[0]).toMatchObject({ customer: 'cus_tenant_x', off_session: true })
    expect((await search()).body.data.find((h: any) => h.tenantId === jane))
      .toMatchObject({ email: expect.stringMatching(/probe\.dev$/), phone: '(520) 555-0142' })
  })

  it('on a lease here nobody but the landlord signed, any dealing with another company keeps their account to themselves', async () => {
    const y = await seed()
    const x = await seed()
    const ties: Record<string, (t: string) => Promise<unknown>> = {
      'a cancelled invite elsewhere': (t) => query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id, cancelled_at) VALUES ($1,$2,$3,NOW())`, [x.landlordId, t, x.propertyId]),
      'a booking elsewhere': async (t) => {
        const c = await db.connect()
        try {
          const u = await seedUnit(c, { propertyId: x.propertyId, landlordId: x.landlordId })
          await c.query(`INSERT INTO unit_bookings (unit_id, landlord_id, tenant_id, check_in, check_out, lease_type, status)
                         VALUES ($1,$2,$3,'2026-09-01','2026-09-03','nightly','checked_out')`, [u, x.landlordId, t])
        } finally { c.release() }
      },
      'a screening for another company (its fee card is kept on their account)': (t) =>
        query(`INSERT INTO background_checks (user_id, landlord_id) SELECT user_id, $1 FROM tenants WHERE id = $2`, [x.landlordId, t]),
    }
    for (const [what, tie] of Object.entries(ties)) {
      const t = await tenantWithCard(`cus_${what.replace(/\W+/g, '_')}`, 'Tied', 'Elsewhere')
      await tie(t)
      const c = await db.connect()
      try {
        const uy = await seedUnit(c, { propertyId: y.propertyId, landlordId: y.landlordId })
        const ly = await seedLease(c, { unitId: uy, landlordId: y.landlordId })
        await c.query(`UPDATE leases SET signed_by_landlord = TRUE WHERE id = $1`, [ly])
        await seedLeaseTenant(c, { leaseId: ly, tenantId: t })
      } finally { c.release() }
      expect((await cardOnFile(y, `tenantId=${t}`)).body.data, what).toBeNull()
    }
    expect(created).toHaveLength(0)
  })

  it('a card kept at THIS register is still on file for a loosely tied person', async () => {
    // The company's own card rows are its own: the strict tie guards only the
    // card on their GAM account.
    const f = await seed()
    const jane = await tenantWithCard('cus_tenant_k', 'Kim', 'Kept')
    await query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id, cancelled_at) VALUES ($1,$2,$3,NOW())`,
      [f.landlordId, jane, f.propertyId])
    const rec = (await query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, tenant_id, stripe_customer_id) VALUES ($1,'Kim','Kept',$2,'cus_1') RETURNING id`,
      [f.landlordId, jane]))[0].id
    const shown = await cardOnFile(f, `posCustomerId=${rec}`)
    expect(shown.body.data).toMatchObject({ brand: 'visa', last4: '4242' })
    const sale = await sell(f, { posCustomerId: rec })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(created[0]).toMatchObject({ customer: 'cus_1', payment_method: 'pm_saved' })
  })
})

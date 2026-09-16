/**
 * S648 (Nic) — register pay links for people who are not on a lease.
 *
 *   "We need a way to generate an item, a charge and send it to a link so they
 *    can pay by email... having the QR code for the dump station so people can
 *    scan it, pay their bill."
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailPayLinkMock, checkoutMock } = vi.hoisted(() => ({
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
  checkoutMock: vi.fn(async (..._a: any[]) => ({ sessionId: 'cs_test_1', hostedUrl: 'https://checkout.stripe.test/cs_test_1' })),
}))
vi.mock('../services/email', async (orig) => ({ ...(await orig() as any), emailPayLink: emailPayLinkMock }))
vi.mock('../services/stripeConnect', async (orig) => ({
  ...(await orig() as any), createPayLinkCheckoutSession: checkoutMock,
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { posPayLinksRouter, publicPayRouter, finalizePayLink, payLinkCharge } from './posPayLinks'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/pos/pay-links', posPayLinksRouter)
  app.use('/api/public', publicPayRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  emailPayLinkMock.mockClear()
  checkoutMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_paylinks'
})

async function seed(opts: { connect?: boolean } = {}) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    if (opts.connect !== false) {
      await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_test_paylink' WHERE id = $1`, [landlordId])
    }
    const cat = await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Propane') RETURNING id`, [landlordId])
    const item = await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price, stock_qty, stock_min, stock_max, tax_rate)
       VALUES ($1, $2, $3, 'Propane (20 lb)', 20, 8, 999, 0, 0, 0) RETURNING id`,
      [landlordId, propertyId, cat.rows[0].id])
    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: null,
      landlordIds: [landlordId], permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, itemId: item.rows[0].id, token }
  } finally { c.release() }
}

const create = (f: any, body: any) => request(buildApp()).post('/api/pos/pay-links')
  .set('Authorization', `Bearer ${f.token}`).send({ propertyId: f.propertyId, ...body })

describe('creating a pay link', () => {
  // The desk's cart is the price, exactly as at the counter; the customer's
  // page can change nothing.
  it('totals the desk\'s cart and emails it', async () => {
    const f = await seed()
    const res = await create(f, {
      items: [{ id: f.itemId, name: 'Propane (20 lb)', qty: 2, price: 20 }],
      customer: { name: 'Pat', email: 'pat@example.com' },
    })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.total)).toBe(40)
    expect(res.body.data.url).toMatch(/\/api\/public\/pay\/[a-f0-9]{48}$/)
    expect(emailPayLinkMock).toHaveBeenCalledTimes(1)
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ to: 'pat@example.com', amount: 40 })
  })

  it('needs an email for a one-time link, and a payout account for any link', async () => {
    const f = await seed()
    expect((await create(f, { items: [{ id: f.itemId, name: 'x', qty: 1, price: 0 }] })).status).toBe(400)
    const g = await seed({ connect: false })
    const res = await create(g, { items: [{ id: g.itemId, name: 'x', qty: 1, price: 0 }], customer: { email: 'a@example.com' } })
    expect(res.status).toBe(409)
  })

  it('a standing link (the dump-station QR) needs no customer and has a printable code', async () => {
    const f = await seed()
    const res = await create(f, { kind: 'standing', label: 'Dump station',
      items: [{ id: null, name: 'Dump station', qty: 1, price: 15 }] })
    expect(res.status).toBe(201)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
    const png = await request(buildApp()).get(`/api/pos/pay-links/${res.body.data.id}/qr.png`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(png.status).toBe(200)
    expect(png.headers['content-type']).toBe('image/png')
  })
})

describe('the public link', () => {
  it('sends the payer to the card page for the fixed amount plus the card fee', async () => {
    const f = await seed()
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'pat@example.com' } })).body.data
    const res = await request(buildApp()).get(`/api/public/pay/${link.token}`)
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('https://checkout.stripe.test/cs_test_1')
    const args = checkoutMock.mock.calls[0][0]
    const { fee } = payLinkCharge(20)
    expect(args.lineItems.map((l: any) => l.amountCents)).toEqual([2000, Math.round(fee * 100)])
    // S648: charged on GAM's account — no Connect account, no transfer.
    expect(args.platformCutCents).toBeUndefined()
    expect(args.landlordConnectAccountId).toBeUndefined()
  })

  it('a bad or closed link never reaches the card page', async () => {
    const f = await seed()
    expect((await request(buildApp()).get('/api/public/pay/nope')).status).toBe(404)
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'pat@example.com' } })).body.data
    await request(buildApp()).post(`/api/pos/pay-links/${link.id}/cancel`).set('Authorization', `Bearer ${f.token}`)
    expect((await request(buildApp()).get(`/api/public/pay/${link.token}`)).status).toBe(410)
    expect(checkoutMock).not.toHaveBeenCalled()
  })
})

describe('when it is paid', () => {
  const paid = (linkId: string, amount: number, pi = 'pi_test_1') => ({
    id: 'cs_test_1', amount_total: Math.round(amount * 100), payment_intent: pi,
    metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: linkId },
  })

  it('records one card sale, closes a one-time link, and never records it twice', async () => {
    const f = await seed()
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'pat@example.com' } })).body.data
    const { charged, fee } = payLinkCharge(20)
    expect((await finalizePayLink(paid(link.id, charged))).recorded).toBe(true)
    expect((await finalizePayLink(paid(link.id, charged))).recorded).toBe(false)
    const tx = (await db.query(`SELECT * FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows
    expect(tx).toHaveLength(1)
    expect(tx[0].payment_method).toBe('card')
    expect(Number(tx[0].total)).toBe(charged)
    expect(Number(tx[0].surcharge)).toBe(fee)
    // The landlord is owed the link total, paid in the weekly batch.
    const held = (await db.query(`SELECT amount FROM held_payout_items WHERE source_id = $1`, [tx[0].id])).rows
    expect(Number(held[0].amount)).toBe(20)
    const l = (await db.query(`SELECT status FROM pos_pay_links WHERE id = $1`, [link.id])).rows[0]
    expect(l.status).toBe('paid')
  })

  it('refuses an amount that is not the link\'s', async () => {
    const f = await seed()
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'pat@example.com' } })).body.data
    const r = await finalizePayLink(paid(link.id, 1))
    expect(r).toEqual({ recorded: false, reason: 'amount mismatch' })
  })

  it('a standing link stays open and records every payment', async () => {
    const f = await seed()
    const link = (await create(f, { kind: 'standing', label: 'Dump station',
      items: [{ id: null, name: 'Dump station', qty: 1, price: 15 }] })).body.data
    const { charged } = payLinkCharge(15)
    await finalizePayLink(paid(link.id, charged, 'pi_a'))
    await finalizePayLink(paid(link.id, charged, 'pi_b'))
    expect((await db.query(`SELECT 1 FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows).toHaveLength(2)
    expect((await db.query(`SELECT status FROM pos_pay_links WHERE id = $1`, [link.id])).rows[0].status).toBe('open')
  })

  it('confirms the stay the link was sent for', async () => {
    const f = await seed()
    const c = await db.connect()
    let bookingId = ''
    try {
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      bookingId = (await c.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_email, lease_type, check_in, check_out, nights, total_amount, status, hold_expires_at)
         VALUES ($1,$2,'pat@example.com','nightly','2026-10-01','2026-10-03',2,80,'tentative', NOW() + INTERVAL '1 hour') RETURNING id`,
        [unitId, f.landlordId])).rows[0].id
    } finally { c.release() }
    const link = (await create(f, { bookingId, items: [{ id: null, name: 'RV site — 2 nights', qty: 1, price: 80 }],
      customer: { email: 'pat@example.com' } })).body.data
    await finalizePayLink({ ...paid(link.id, payLinkCharge(80).charged),
      custom_fields: null, customer_details: { name: 'Pat Guest' } })
    const b = (await db.query(`SELECT status, guest_name, hold_expires_at FROM unit_bookings WHERE id = $1`, [bookingId])).rows[0]
    expect(b.status).toBe('confirmed')
    expect(b.guest_name).toBe('Pat Guest')
    expect(b.hold_expires_at).toBeNull()
  })
})

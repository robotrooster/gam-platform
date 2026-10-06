/**
 * S648 (Nic) — register pay links for people who are not on a lease.
 *
 *   "We need a way to generate an item, a charge and send it to a link so they
 *    can pay by email... having the QR code for the dump station so people can
 *    scan it, pay their bill."
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailPayLinkMock, checkoutMock, readSaleCardMock, pages, pageState, refundsMock } = vi.hoisted(() => {
  // Stripe's card pages (Checkout Sessions): id → its status at Stripe.
  const pages = new Map<string, string>()
  const pageState = { n: 0 }
  return {
    pages, pageState,
    emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
    checkoutMock: vi.fn(async (_p: any) => {
      const id = `cs_test_${++pageState.n}`
      pages.set(id, 'open')
      return { id, url: `https://checkout.stripe.test/${id}` }
    }),
    // 10/2: the card a paid link was paid with, read back from Stripe.
    readSaleCardMock: vi.fn(async (_pi: string): Promise<any> => null),
    // 10/3 (decisions #13): a held payment refunded through Stripe, by the owner.
    refundsMock: vi.fn(async (p: any, _o?: any) => ({ id: `re_${p.payment_intent}`, status: 'succeeded' })),
  }
})
vi.mock('../services/email', async (orig) => ({ ...(await orig() as any), emailPayLink: emailPayLinkMock }))
vi.mock('../services/posCustomerCards', async (orig) => ({ ...(await orig() as any), readSaleCard: readSaleCardMock }))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ checkout: { sessions: {
    create: checkoutMock,
    retrieve: async (id: string) => {
      const status = pages.get(id) ?? 'expired'
      return { id, status, payment_status: status === 'complete' ? 'paid' : 'unpaid' }
    },
    expire: async (id: string) => { if (pages.get(id) === 'open') pages.set(id, 'expired'); return { id, status: 'expired' } },
  } }, refunds: { create: refundsMock } }),
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
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
  checkoutMock.mockClear(); pages.clear(); pageState.n = 0
  readSaleCardMock.mockReset(); readSaleCardMock.mockResolvedValue(null)
  refundsMock.mockClear()
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

  // 10/2 (review): the register honors a link's prices and discount as they
  // were sent, so sending one is held to the rule for ringing a sale.
  it('a cashier without "Apply discounts" sends the catalog price and no discount; the owner may do either', async () => {
    const f = await seed()
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
    const perms = { 'pos.ring_sale': true }
    await db.query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
      [u.rows[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
    const desk = { ...f, token: jwt.sign({ userId: u.rows[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
      process.env.JWT_SECRET!, { expiresIn: '1h' }) }
    const line = (price: number) => [{ id: f.itemId, name: 'Propane (20 lb)', qty: 1, price }]
    const customer = { name: 'Pat', email: 'pat@example.com' }
    expect((await create(desk, { items: line(20), discountAmount: 5, customer })).status).toBe(403)
    expect((await create(desk, { items: line(12), customer })).status).toBe(403)
    const ok = await create(desk, { items: line(20), customer })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    // Editing it is held to the same rule.
    const edit = await request(buildApp()).patch(`/api/pos/pay-links/${ok.body.data.id}`).set('Authorization', `Bearer ${desk.token}`)
      .send({ items: line(20), discountAmount: 5 })
    expect(edit.status).toBe(403)
    expect((await create(f, { items: line(12), discountAmount: 2, customer })).status).toBe(201)
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
    expect(args.line_items.map((l: any) => l.price_data.unit_amount)).toEqual([2000, Math.round(fee * 100)])
    // S648: charged on GAM's account — no Connect account, no transfer.
    expect(args.payment_intent_data.transfer_data).toBeUndefined()
    expect(args.payment_intent_data.application_fee_amount).toBeUndefined()
    expect(args.metadata).toEqual({ gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id, gam_landlord_id: f.landlordId })
    // 10/2 (review): the page closes itself after half an hour (Stripe's shortest, plus two minutes).
    const inMinutes = (args.expires_at - Date.now() / 1000) / 60
    expect(inMinutes).toBeGreaterThan(31)
    expect(inMinutes).toBeLessThanOrEqual(32)
  })

  // S648 (Nic): the landlord can absorb the card fee instead.
  it('a property that absorbs the fee sends a link for the price alone, and holds price less fee', async () => {
    const f = await seed()
    await db.query(`UPDATE properties SET register_card_fee_payer = 'landlord' WHERE id = $1`, [f.propertyId])
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'pat@example.com' } })).body.data
    expect(emailPayLinkMock.mock.calls[0][0]).toMatchObject({ amount: 20, cardFee: 0 })
    await request(buildApp()).get(`/api/public/pay/${link.token}`)
    // No fee line at $0: the payer sees the price alone.
    expect(checkoutMock.mock.calls[0][0].line_items.map((l: any) => l.price_data.unit_amount)).toEqual([2000])
    // Changing the setting later doesn't change a link already sent.
    await db.query(`UPDATE properties SET register_card_fee_payer = 'customer' WHERE id = $1`, [f.propertyId])
    const r = await finalizePayLink({ id: 'cs_abs', amount_total: 2000, payment_intent: 'pi_abs',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id } })
    expect(r.recorded).toBe(true)
    const { fee, held } = payLinkCharge(20, 'landlord')
    const tx = (await db.query<any>(`SELECT id, surcharge, platform_fee FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows[0]
    expect(Number(tx.surcharge)).toBe(0)
    expect(Number(tx.platform_fee)).toBe(fee)
    const h = (await db.query<any>(`SELECT amount FROM held_payout_items WHERE source_id = $1`, [tx.id])).rows[0]
    expect(Number(h.amount)).toBe(held)
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
    expect(tx[0].paid_online).toBe(true)   // S653: history shows it as a pay link, not the reader
    expect(Number(tx[0].total)).toBe(charged)
    expect(Number(tx[0].surcharge)).toBe(fee)
    // The landlord is owed the link total, paid in the weekly batch.
    const held = (await db.query(`SELECT amount FROM held_payout_items WHERE source_id = $1`, [tx[0].id])).rows
    expect(Number(held[0].amount)).toBe(20)
    const l = (await db.query(`SELECT status FROM pos_pay_links WHERE id = $1`, [link.id])).rows[0]
    expect(l.status).toBe('paid')
  })

  // 10/3 (decisions #13): a payment at an amount that is not the link's is
  // not a sale — but it is RECORDED (held, keyed on its payment), never lost,
  // and never refunded until the owner presses Refund this payment.
  it('holds an amount that is not the link\'s: not a sale, not in payouts, recorded once, the owner told with a refund button', async () => {
    const f = await seed()
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'pat@example.com' } })).body.data
    const r = await finalizePayLink(paid(link.id, 1))
    expect(r).toMatchObject({ recorded: false, reason: 'amount mismatch' })
    expect(r.heldPaymentId).toBeTruthy()
    const held = (await db.query(`SELECT reason, amount::float AS amount, status, pay_link_id, stripe_payment_intent_id FROM pos_held_payments`)).rows
    expect(held).toEqual([{ reason: 'wrong_amount', amount: 1, status: 'held', pay_link_id: link.id, stripe_payment_intent_id: 'pi_test_1' }])
    expect((await db.query(`SELECT 1 FROM pos_transactions`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM held_payout_items`)).rows).toHaveLength(0)
    const told = (await db.query(`SELECT type, body, action_url FROM notifications WHERE landlord_id = $1`, [f.landlordId])).rows
    expect(told).toHaveLength(1)
    expect(told[0].action_url).toBe(`/pos?tab=paylinks&held=${r.heldPaymentId}`)
    expect(told[0].body).toMatch(/press Refund this payment to send it back to their card/)
    expect(refundsMock).not.toHaveBeenCalled()   // never on its own
    // Stripe delivers it again: still one held row, one notice.
    expect(await finalizePayLink(paid(link.id, 1))).toMatchObject({ recorded: false, reason: 'already held', heldPaymentId: r.heldPaymentId })
    expect((await db.query(`SELECT 1 FROM pos_held_payments`)).rows).toHaveLength(1)
    expect((await db.query(`SELECT 1 FROM notifications WHERE landlord_id = $1`, [f.landlordId])).rows).toHaveLength(1)
  })

  // 10/5 (Nic): "money movement is the end of onboarding."
  it('a paid link ends the landlord\'s free onboarding window; so does a payment that lands and is held', async () => {
    const startsThisMonth = async (landlordId: string) => (await db.query(
      `SELECT COALESCE(billing_starts_at = date_trunc('month', now())::date, false) AS ok FROM landlords WHERE id = $1`,
      [landlordId])).rows[0].ok
    const f = await seed()
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [f.landlordId])
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'pat@example.com' } })).body.data
    expect(await startsThisMonth(f.landlordId)).toBe(false)
    expect((await finalizePayLink(paid(link.id, payLinkCharge(20).charged))).recorded).toBe(true)
    expect(await startsThisMonth(f.landlordId)).toBe(true)

    // A second company (each payout account belongs to one).
    await db.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_test_paylink_first' WHERE id = $1`, [f.landlordId])
    const g = await seed()
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [g.landlordId])
    const other = (await create(g, { items: [{ id: g.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'sam@example.com' } })).body.data
    expect(await finalizePayLink(paid(other.id, 1, 'pi_test_held'))).toMatchObject({ recorded: false, reason: 'amount mismatch' })
    expect(await startsThisMonth(g.landlordId)).toBe(true)
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

  // 10/2 (review): the payer had the card page open when the reservation's
  // site went to a guest who paid first (only NEW page loads are refused). The
  // money is real and is recorded; the cancelled booking is not stamped paid,
  // and the landlord is told to refund or rebook.
  it('paid for a reservation that was cancelled meanwhile: the sale is recorded, the booking stays cancelled and unpaid, and the landlord is told', async () => {
    const f = await seed()
    const c = await db.connect()
    let bookingId = ''
    try {
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      bookingId = (await c.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, guest_email, guest_name, lease_type, check_in, check_out, nights, total_amount, status)
         VALUES ($1,$2,'pat@example.com','Pat Guest','nightly','2026-11-01','2026-11-03',2,80,'tentative') RETURNING id`,
        [unitId, f.landlordId])).rows[0].id
    } finally { c.release() }
    const link = (await create(f, { bookingId, items: [{ id: null, name: 'Reservation deposit', qty: 1, price: 40 }],
      customer: { name: 'Pat Guest', email: 'pat@example.com' } })).body.data
    // The site goes to somebody who paid first while Pat's card page is open
    // (holdDisplacement: cancelled where it stood — displaced from its own site).
    await db.query(`UPDATE unit_bookings SET status = 'cancelled', displaced_at = NOW(), displaced_from_unit = unit_id WHERE id = $1`, [bookingId])
    const r = await finalizePayLink(paid(link.id, payLinkCharge(40).charged, 'pi_gone'))
    expect(r.recorded).toBe(true)
    const sale = (await db.query(`SELECT id, total FROM pos_transactions WHERE stripe_payment_intent_id = 'pi_gone'`)).rows
    expect(sale).toHaveLength(1)
    expect((await db.query(`SELECT status, pos_transaction_id FROM pos_pay_links WHERE id = $1`, [link.id])).rows[0])
      .toMatchObject({ status: 'paid', pos_transaction_id: sale[0].id })
    const b = (await db.query(`SELECT status, deposit_paid_at, balance_paid_at, pos_transaction_id FROM unit_bookings WHERE id = $1`, [bookingId])).rows[0]
    expect(b).toMatchObject({ status: 'cancelled', deposit_paid_at: null, balance_paid_at: null, pos_transaction_id: null })
    const told = (await db.query(`SELECT user_id, landlord_id, type, title, body FROM notifications WHERE landlord_id = $1`, [f.landlordId])).rows
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ user_id: f.userId, type: 'pay_link_reservation_gone' })
    expect(told[0].title).toBe('Pat Guest paid for a reservation that was no longer on — refund or rebook')
    expect(told[0].body).toMatch(/but that reservation had already been canceled \(its site went to a guest who paid first\)\./)
    expect(told[0].body).toMatch(/refund the sale under Point of Sale → History, or book them a site on the schedule/)
    // Paid again for the same payment: nothing more, and nobody is told twice.
    expect((await finalizePayLink(paid(link.id, payLinkCharge(40).charged, 'pi_gone'))).recorded).toBe(false)
    expect((await db.query(`SELECT 1 FROM notifications WHERE landlord_id = $1`, [f.landlordId])).rows).toHaveLength(1)
  })

  // 10/3 (review): the cause is stated only as far as it is known.
  it('a reservation cancelled on the schedule (not lost to a payer) is never said to have lost its site; a no-show says so', async () => {
    const f = await seed()
    const c = await db.connect()
    const ids: string[] = []
    try {
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      for (const ci of ['2026-11-01', '2026-11-10']) {
        ids.push((await c.query<{ id: string }>(
          `INSERT INTO unit_bookings (unit_id, landlord_id, guest_email, guest_name, lease_type, check_in, check_out, nights, total_amount, status)
           VALUES ($1,$2,'pat@example.com','Pat Guest','nightly',$3::date,$3::date + 2,2,80,'tentative') RETURNING id`,
          [unitId, f.landlordId, ci])).rows[0].id)
      }
    } finally { c.release() }
    const [onSchedule, noShow] = ids
    const linkA = (await create(f, { bookingId: onSchedule, items: [{ id: null, name: 'Reservation deposit', qty: 1, price: 40 }],
      customer: { name: 'Pat Guest', email: 'pat@example.com' } })).body.data
    const linkB = (await create(f, { bookingId: noShow, items: [{ id: null, name: 'Reservation deposit', qty: 1, price: 40 }],
      customer: { name: 'Pat Guest', email: 'pat@example.com' } })).body.data
    await db.query(`UPDATE unit_bookings SET status = 'cancelled' WHERE id = $1`, [onSchedule])
    await db.query(`UPDATE unit_bookings SET status = 'no_show' WHERE id = $1`, [noShow])
    expect((await finalizePayLink(paid(linkA.id, payLinkCharge(40).charged, 'pi_sched'))).recorded).toBe(true)
    expect((await finalizePayLink(paid(linkB.id, payLinkCharge(40).charged, 'pi_noshow'))).recorded).toBe(true)
    const bodies = (await db.query(`SELECT body FROM notifications WHERE landlord_id = $1 ORDER BY created_at`, [f.landlordId])).rows.map((r: any) => r.body)
    expect(bodies[0]).toMatch(/but that reservation had already been canceled on the schedule\./)
    expect(bodies[1]).toMatch(/but that reservation had already been marked a no-show\./)
    for (const b of bodies) expect(b).not.toMatch(/guest who paid first/)
    // Neither booking is stamped paid.
    const rows = (await db.query(`SELECT deposit_paid_at FROM unit_bookings WHERE id = ANY($1::uuid[])`, [ids])).rows
    expect(rows.every((r: any) => r.deposit_paid_at === null)).toBe(true)
  })
})

// S649 (Nic): find the person for a bill. Your own tenants by any part of a
// name; someone else's only by their full email — never browsable.
describe('finding who to send a link to', () => {
  it('finds your invited tenant by part of a name; a stranger too (10/2), as a name and a masked hint — never their email', async () => {
    const f = await seed()
    const mkTenant = async (first: string, last: string, email: string) => {
      const u = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','tenant',$2,$3,TRUE) RETURNING id`, [email, first, last])
      return (await db.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])).rows[0].id
    }
    const mine = await mkTenant('Andres', 'Razo', 'razo@example.com')
    await db.query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id) VALUES ($1, $2, $3)`, [f.landlordId, mine, f.propertyId])
    await mkTenant('Stella', 'Stranger', 'stella@elsewhere.com')
    const find = async (q: string) => (await request(buildApp()).get(`/api/pos/pay-links/people?propertyId=${f.propertyId}&q=${encodeURIComponent(q)}`)
      .set('Authorization', `Bearer ${f.token}`)).body.data.map((p: any) => [p.name, p.email, p.hint])
    // 10/2 (review): an invite alone is a loose tie — they are listed by name;
    // the email and phone on their own GAM account wait until they take a
    // place on one of this company's leases.
    expect(await find('raz')).toEqual([['Andres Razo', null, 'invited']])
    // Not yours: found by part of a name, shown with a masked hint, never their address.
    expect(await find('stel')).toEqual([['Stella Stranger', null, 's•••@elsewhere.com']])
    expect(await find('stella@elsewhere.com')).toEqual([['Stella Stranger', null, 's•••@elsewhere.com']])
  })
})

// 10/2: the same search the register uses — and the leak it closes. Searching
// a stranger by email used to hand back their phone number too.
describe('the pay-link search is the register\'s search', () => {
  it('a stranger found by email comes back with their name and a masked hint only — no email, no full phone, no ids; a property is required', async () => {
    const f = await seed()
    const other = await seed({ connect: false })
    await db.query(`INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone) VALUES ($1,'Zed','Elsewhere','zed@elsewhere.com','602-555-0199')`,
      [other.landlordId])
    const res = await request(buildApp()).get(`/api/pos/pay-links/people?propertyId=${f.propertyId}&q=zed%40elsewhere.com`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    // 10/2 (review): found by the email typed whole, the hint is that email
    // masked — never digits of their phone.
    expect(res.body.data[0]).toMatchObject({ kind: 'elsewhere', name: 'Zed Elsewhere', email: null, phone: null, customerId: null, tenantId: null,
                                             hint: 'z•••@elsewhere.com' })
    expect(JSON.stringify(res.body)).not.toContain('0199')
    for (const leak of ['zed@elsewhere.com', '602-555-0199', '6025550199', other.landlordId, other.propertyId]) {
      expect(JSON.stringify(res.body)).not.toContain(leak)
    }
    // Over 120 characters is refused here too.
    expect((await request(buildApp()).get(`/api/pos/pay-links/people?propertyId=${f.propertyId}&q=${'z'.repeat(121)}`)
      .set('Authorization', `Bearer ${f.token}`)).status).toBe(400)
    expect((await request(buildApp()).get('/api/pos/pay-links/people?q=zed').set('Authorization', `Bearer ${f.token}`)).status).toBe(400)
    // Another company's property is not searched from here.
    expect((await request(buildApp()).get(`/api/pos/pay-links/people?propertyId=${other.propertyId}&q=zed`)
      .set('Authorization', `Bearer ${f.token}`)).status).toBe(403)
  })
})

// 10/2 (review): picking someone from elsewhere in the pay-link window keeps the
// sealed pick; their record here is made with the link — backing out of the
// window leaves nothing behind.
describe('a pay link for someone picked from elsewhere', () => {
  it('makes their record here only when the link goes out', async () => {
    const f = await seed()
    const other = await seed({ connect: false })
    await db.query(`INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone) VALUES ($1,'Zed','Elsewhere','zed@elsewhere.com','602-555-0199')`,
      [other.landlordId])
    const hit = (await request(buildApp()).get(`/api/pos/pay-links/people?propertyId=${f.propertyId}&q=zed%40elsewhere.com`)
      .set('Authorization', `Bearer ${f.token}`)).body.data[0]
    expect(hit).toMatchObject({ kind: 'elsewhere', name: 'Zed Elsewhere' })
    const mine = () => db.query<any>(`SELECT id, first_name, last_name, email, elsewhere_ref FROM pos_customers WHERE landlord_id = $1`, [f.landlordId])
    expect((await mine()).rows).toHaveLength(0)
    // A link refused before it goes out makes nothing either.
    const refused = await create(f, { items: [{ id: f.itemId, name: 'Propane (20 lb)', qty: 1, price: 20 }], match: { pick: hit.pick } })
    expect(refused.status).toBe(400)
    expect((await mine()).rows).toHaveLength(0)
    const sent = await create(f, { items: [{ id: f.itemId, name: 'Propane (20 lb)', qty: 1, price: 20 }],
      customer: { name: 'Zed Elsewhere', email: 'zed@elsewhere.com' }, match: { pick: hit.pick } })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const rows = (await mine()).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ first_name: 'Zed', last_name: 'Elsewhere', email: 'zed@elsewhere.com' })
    expect(sent.body.data.pos_customer_id).toBe(rows[0].id)
    // A pick is one person: never with an id beside it.
    const both = await create(f, { items: [{ id: f.itemId, name: 'Propane (20 lb)', qty: 1, price: 20 }],
      customer: { email: 'zed@elsewhere.com' }, match: { pick: hit.pick }, posCustomerId: rows[0].id })
    expect(both.status).toBe(400)
  })
})

// Defect 2: a link stored whatever tenant or customer id it was sent, unchecked —
// another company's person could be put on this company's bill.
describe('who a link is for', () => {
  it('refuses another company\'s customer or resident; nothing is stored or sent', async () => {
    const f = await seed()
    const other = await seed({ connect: false })
    const theirCustomer = (await db.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name) VALUES ($1,'Not','Mine') RETURNING id`, [other.landlordId])).rows[0].id
    const c = await db.connect()
    let theirResident = ''
    try {
      theirResident = await seedTenant(c)
      const unitId = await seedUnit(c, { propertyId: other.propertyId, landlordId: other.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: other.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: theirResident })
    } finally { c.release() }
    const items = [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }]
    expect((await create(f, { items, customer: { email: 'x@example.com' }, posCustomerId: theirCustomer })).status).toBe(404)
    expect((await create(f, { items, customer: { email: 'x@example.com' }, tenantId: theirResident })).status).toBe(404)
    expect((await create(f, { items, customer: { email: 'x@example.com' }, tenantId: theirResident, posCustomerId: theirCustomer })).status).toBe(400)
    expect((await db.query(`SELECT 1 FROM pos_pay_links WHERE landlord_id = $1`, [f.landlordId])).rows).toHaveLength(0)
    expect(emailPayLinkMock).not.toHaveBeenCalled()
  })

  it('when paid, the card goes on the person the link was for — and a resident\'s sale names their register record too', async () => {
    const f = await seed()
    const c = await db.connect()
    let ann = ''
    try {
      ann = await seedTenant(c)
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: ann })
    } finally { c.release() }
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }],
      customer: { email: 'ann@example.com' }, tenantId: ann })).body.data
    expect(link.tenant_id).toBe(ann)
    readSaleCardMock.mockResolvedValueOnce({ fingerprint: 'fp_ann_online', brand: 'visa', last4: '4242', cardholderName: 'Ann T', generatedCard: null })
    const { charged } = payLinkCharge(20)
    const r = await finalizePayLink({ id: 'cs_ann', amount_total: Math.round(charged * 100), payment_intent: 'pi_ann_online',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id } })
    expect(r.recorded).toBe(true)
    expect(readSaleCardMock).toHaveBeenCalledWith('pi_ann_online')
    const tx = (await db.query<any>(`SELECT tenant_id, pos_customer_id FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows[0]
    expect(tx.tenant_id).toBe(ann)
    expect(tx.pos_customer_id).toBeTruthy()
    expect((await db.query<any>(`SELECT tenant_id FROM pos_customers WHERE id = $1`, [tx.pos_customer_id])).rows[0].tenant_id).toBe(ann)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_ann_online'`)).rows[0].pos_customer_id).toBe(tx.pos_customer_id)
  })

  it('a link for nobody puts its card on the card\'s own record, so the next tap of it finds the same person; a card that cannot be read records the sale anyway', async () => {
    const f = await seed()
    const items = [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }]
    const link = (await create(f, { items, customer: { email: 'pat@example.com' } })).body.data
    readSaleCardMock.mockResolvedValueOnce({ fingerprint: 'fp_pat_online', brand: 'visa', last4: '1881', cardholderName: 'Pat Guest', generatedCard: null })
    const { charged } = payLinkCharge(20)
    expect((await finalizePayLink({ id: 'cs_pat', amount_total: Math.round(charged * 100), payment_intent: 'pi_pat',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id } })).recorded).toBe(true)
    const tx = (await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows[0]
    const who = (await db.query<any>(`SELECT first_name, last_name, created_from FROM pos_customers WHERE id = $1`, [tx.pos_customer_id])).rows[0]
    expect(who).toEqual({ first_name: 'Pat', last_name: 'Guest', created_from: 'card_reader' })
    // Stripe unreachable: the sale is still recorded, naming nobody.
    const link2 = (await create(f, { items, customer: { email: 'q@example.com' } })).body.data
    readSaleCardMock.mockRejectedValueOnce(new Error('stripe down'))
    expect((await finalizePayLink({ id: 'cs_q', amount_total: Math.round(charged * 100), payment_intent: 'pi_q',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: link2.id } })).recorded).toBe(true)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE pay_link_id = $1`, [link2.id])).rows[0].pos_customer_id).toBeNull()
  })

  // Review fix: the resident was looked up before the card found anyone, so
  // such a sale named the resident's register record but not the resident.
  it('a link for nobody, paid with a card already on a resident\'s register record, names the resident on the sale too', async () => {
    const f = await seed()
    const c = await db.connect()
    let ann = ''
    try {
      ann = await seedTenant(c)
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: f.landlordId })
      await seedLeaseTenant(c, { leaseId, tenantId: ann })
    } finally { c.release() }
    const record = (await db.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, created_from, tenant_id) VALUES ($1, 'Ann', 'T', 'manual', $2) RETURNING id`,
      [f.landlordId, ann])).rows[0].id
    await db.query(`INSERT INTO pos_customer_cards (landlord_id, pos_customer_id, fingerprint, brand, last4) VALUES ($1, $2, 'fp_ann_known', 'visa', '7070')`,
      [f.landlordId, record])
    const link = (await create(f, { items: [{ id: f.itemId, name: 'Propane', qty: 1, price: 20 }], customer: { email: 'someone@example.com' } })).body.data
    expect(link.tenant_id ?? null).toBeNull()
    readSaleCardMock.mockResolvedValueOnce({ fingerprint: 'fp_ann_known', brand: 'visa', last4: '7070', cardholderName: null, generatedCard: null })
    const { charged } = payLinkCharge(20)
    expect((await finalizePayLink({ id: 'cs_ann_known', amount_total: Math.round(charged * 100), payment_intent: 'pi_ann_known',
      metadata: { gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id } })).recorded).toBe(true)
    expect((await db.query<any>(`SELECT pos_customer_id, tenant_id FROM pos_transactions WHERE pay_link_id = $1`, [link.id])).rows[0])
      .toEqual({ pos_customer_id: record, tenant_id: ann })
  })
})

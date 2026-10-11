/**
 * 10/4 (decisions #37.B, #38) — EARLY CHECK-OUT: WHAT HAPPENS TO THE MONEY.
 *
 * The schedule's Check out window (routes/stayCheckOut, services/earlyCheckOut):
 *   - the quote: what was booked, stayed and paid, and ONE question;
 *   - "Keep the price as booked" / "Charge only the nights stayed" (never more
 *     than the booked price, Q7);
 *   - "No refund" / "Refund the unused nights" / "Refund a different amount"
 *     (Q1), which re-price nothing and close the stay with nothing owed (Q2),
 *     each payment back the way it was paid, most recent first (Q3, Q10), the
 *     card fee given back with it and the landlord bearing Stripe's kept fee
 *     (Q4);
 *   - staff without "Issue refunds" can check an overpaid guest out and the
 *     money waits on the stay with an owner to-do (Q5);
 *   - a long stay's lease ends on the day they left (Q8);
 *   - once a refund went out the check-out cannot be undone (Q11).
 *
 * Stripe is mocked (refunds, intents). "Today" is Oct 2, 2026 in Phoenix.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const made: any[] = []
  // gate: a refund being sent waits on it (a send still running);
  // declineNext: the card company turns the next refund down at once;
  // staleRefusal: the booking PATCH's first look at the refusal (before its
  // transaction) answers "nothing stops it" — as when a refund is decided
  // right after that look.
  const state = { n: 0, failNext: 0, syncFail: 0, declineNext: 0, staleRefusal: 0, gate: null as null | Promise<void> }
  return {
    made, state,
    refundsCreate: vi.fn(async (p: any, _o?: any) => {
      if (state.failNext > 0) { state.failNext--; throw new Error('Stripe is down') }
      if (state.gate) await state.gate
      const declined = state.declineNext > 0 && state.declineNext-- > 0
      const r = { id: `re_${++state.n}`, status: declined ? 'failed' : 'succeeded', amount: p.amount, payment_intent: p.payment_intent, metadata: p.metadata }
      made.push(r)
      return r
    }),
    refundsList: vi.fn(async (p: any) => ({ data: made.filter((r) => r.payment_intent === p.payment_intent) })),
    piRetrieve: vi.fn(async (id: string) => ({ id })),
    expireMock: vi.fn(async () => undefined),
  }
})
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({
    refunds: { create: h.refundsCreate, list: h.refundsList },
    paymentIntents: { retrieve: h.piRetrieve },
    checkout: { sessions: { expire: async () => undefined, retrieve: async (id: string) => ({ id, status: 'expired' }) } },
  }),
}))
vi.mock('../services/stripeConnect', async (orig) => ({ ...(await orig() as any), expirePayLinkCheckoutSession: h.expireMock }))
// The booking PATCH's first look at the refusal (three arguments; the look
// inside its transaction is the service's own and is never this one).
vi.mock('../services/earlyCheckOut', async (orig) => {
  const real = await orig() as any
  return {
    ...real,
    checkOutChangeRefusal: async (...args: any[]) => {
      if (h.state.staleRefusal > 0 && args.length < 4) { h.state.staleRefusal--; return null }
      return real.checkOutChangeRefusal(...args)
    },
  }
})
// The lease sync, failing on demand (#38 Q8: a lease that could not be ended is never silent).
vi.mock('../services/bookingLeaseBilling', async (orig) => {
  const real = await orig() as any
  return {
    ...real,
    syncLeaseWithBookingDates: async (bookingId: string) => {
      if (h.state.syncFail > 0) { h.state.syncFail--; throw new Error('lease sync is down') }
      return real.syncLeaseWithBookingDates(bookingId)
    },
  }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db, query } from '../db'
import { PERMISSION_CATALOG, priceStay, processingFeeFor, STAY_REFUND_PART_STATUSES } from '@gam/shared'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { camelCaseKeys } from '../lib/caseConversion'
import { stayCheckOutRouter } from './stayCheckOut'
import { unitsRouter } from './units'
import { landlordsRouter } from './landlords'
import { posRouter } from './pos'
import { recordSaleTowardStay } from '../services/stayPayments'
import { reservationDue } from '../services/registerStay'
import { stripeRefundFailed, LEASE_NOT_ENDED_WORDS } from '../services/earlyCheckOut'
import { confirmBookingDeposit } from '../services/propertyBooking'
import { incomeEvents } from '../services/incomeBasis'
import { generateEodSettlement, generateEodForAllActiveLandlords } from '../services/posEod'

function app() {
  const a = express()
  a.use(express.json())
  a.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  a.use('/api/units', stayCheckOutRouter)
  a.use('/api/units', unitsRouter)
  a.use('/api/landlords', landlordsRouter)
  a.use('/api/pos', posRouter)
  a.use(errorHandler)
  return a
}

const NOW = new Date('2026-10-03T03:00:00Z')
const TODAY = '2026-10-02'
const settle = () => new Promise((r) => setTimeout(r, 250))

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_stay_checkout'
  h.made.length = 0; h.state.n = 0; h.state.failNext = 0; h.state.syncFail = 0
  h.state.declineNext = 0; h.state.staleRefusal = 0; h.state.gate = null
  for (const m of [h.refundsCreate, h.refundsList, h.piRetrieve, h.expireMock]) m.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { vi.useRealTimers() })

interface F { userId: string; landlordId: string; propertyId: string; unitId: string; token: string }

async function seed(opts: { taxPct?: number } = {}): Promise<F> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix', timezone_source = 'manual', short_term_tax_rate = $2 WHERE id = $1`,
      [propertyId, opts.taxPct ?? 0])
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot' })
    await c.query(`UPDATE units SET unit_number = 'RV 07', lease_types_allowed = '{}', is_bookable = TRUE,
                          nightly_rate = 60, weekly_rate = 350, monthly_rate = 1500 WHERE id = $1`, [unitId])
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A front-desk worker with these permissions, at these properties (all when omitted). */
async function staff(f: F, perms: Record<string, boolean>, propertyIds?: string[]): Promise<string> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Lisa','Desk',TRUE) RETURNING id`, [`desk-${randomUUID()}@t.dev`])
  await query(`INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,$4,$5)`,
    [u[0].id, f.landlordId, propertyIds ?? [], !propertyIds, JSON.stringify(perms)])
  return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

async function stay(f: F, o: { checkIn: string; checkOut: string; total: number; status?: string; guest?: string; leaseType?: string }): Promise<string> {
  return (await query<{ id: string }>(
    `INSERT INTO unit_bookings (landlord_id, unit_id, guest_name, lease_type, check_in, check_out, nights, total_amount,
                                platform_fee, status, source, booked_check_out)
     VALUES ($1,$2,$3,$4,$5::date,$6::date,($6::date - $5::date),$7,0,$8,'direct',$6::date) RETURNING id`,
    [f.landlordId, f.unitId, o.guest ?? 'Jane Doe', o.leaseType ?? 'nightly', o.checkIn, o.checkOut, o.total, o.status ?? 'checked_in']))[0].id
}

let piN = 0
/**
 * A register sale that paid `toward` toward the stay — the way the counter
 * records one: cash, a card on the reader, a card on file (each with GAM's
 * card fee on top, `fee`, or covered by the landlord, `landlordFee`), or the
 * charge account. Then the booking's paid flags, as the real paths stamp them.
 */
async function paySale(f: F, bookingId: string, o: {
  method: 'cash' | 'card' | 'card_on_file' | 'charge'; toward: number; fee?: number; landlordFee?: number; payLink?: boolean
}): Promise<{ saleId: string; pi: string | null }> {
  const pi = o.method === 'card' || o.method === 'card_on_file' ? `pi_sale_${++piN}` : null
  const fee = o.fee ?? 0
  const total = Math.round((o.toward + fee) * 100) / 100
  const sale = (await query<{ id: string }>(
    `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total,
                                   platform_fee, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9) RETURNING id`,
    [f.landlordId, f.propertyId, f.userId, o.method, o.toward, fee, total, fee + (o.landlordFee ?? 0), pi]))[0].id
  if (o.payLink) {
    const link = (await query<{ id: string }>(
      `INSERT INTO pos_pay_links (landlord_id, property_id, created_by, kind, label, token, items, subtotal, tax_amount, total, status, booking_id, customer_email)
       VALUES ($1,$2,$3,'one_time','Stay',$4,'[]'::jsonb,$5,0,$5,'paid',$6,'jane@t.dev') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId, `tok_${randomUUID()}`, o.toward, bookingId]))[0].id
    await query(`UPDATE pos_transactions SET pay_link_id = $2, paid_online = TRUE WHERE id = $1`, [sale, link])
  }
  const c = await db.connect()
  try { await recordSaleTowardStay(c, { bookingId, saleId: sale, toward: o.toward }) } finally { c.release() }
  if (o.method === 'charge') {
    const acct = await chargeAccount(f)
    await query(`INSERT INTO flex_charge_transactions (account_id, pos_transaction_id, amount) VALUES ($1,$2,$3)`, [acct, sale, total])
  }
  await stampPaid(bookingId)
  return { saleId: sale, pi }
}

async function chargeAccount(f: F): Promise<string> {
  const had = await query<{ id: string }>(`SELECT a.id FROM flex_charge_accounts a WHERE a.landlord_id = $1 LIMIT 1`, [f.landlordId])
  if (had[0]) return had[0].id
  const cust = (await query<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name) VALUES ($1,'Jane','Doe') RETURNING id`, [f.landlordId]))[0].id
  return (await query<{ id: string }>(
    `INSERT INTO flex_charge_accounts (landlord_id, property_id, pos_customer_id, credit_limit, status) VALUES ($1,$2,$3,1000,'active') RETURNING id`,
    [f.landlordId, f.propertyId, cust]))[0].id
}

/** The booking's paid flags from what was paid toward it (deposit_amount = running total; balance once it covers the price). */
async function stampPaid(bookingId: string) {
  await query(
    `UPDATE unit_bookings b
        SET deposit_amount = s.paid, deposit_paid_at = COALESCE(b.deposit_paid_at, NOW()),
            balance_paid_at = CASE WHEN s.paid >= b.total_amount THEN COALESCE(b.balance_paid_at, NOW()) ELSE b.balance_paid_at END
       FROM (SELECT COALESCE(SUM(toward_stay), 0) AS paid FROM stay_payments WHERE booking_id = $1) s
      WHERE b.id = $1`, [bookingId])
}

const url = (f: F, b: string, tail = '') => `/api/units/${f.unitId}/bookings/${b}/check-out${tail}`
const getQuote = (f: F, b: string, token = f.token, leftOn?: string) =>
  request(app()).get(url(f, b, leftOn ? `?leftOn=${leftOn}` : '')).set('Authorization', `Bearer ${token}`)
async function decide(f: F, b: string, body: Record<string, unknown>, token = f.token) {
  const q = body.quoteToken ? null : await getQuote(f, b, token, body.leftOn as string | undefined)
  return request(app()).post(url(f, b)).set('Authorization', `Bearer ${token}`)
    .send({ idempotencyKey: randomUUID(), quoteToken: q?.body?.data?.quoteToken, ...body })
}
const row = async (b: string) => (await query<any>(
  `SELECT status, to_char(check_out, 'YYYY-MM-DD') AS check_out, to_char(booked_check_out, 'YYYY-MM-DD') AS booked_check_out,
          total_amount::text AS total, balance_paid_at FROM unit_bookings WHERE id = $1`, [b]))[0]
const parts = async (b: string) => query<any>(
  `SELECT seq, kind, status, toward_amount::text AS toward, card_fee_back::text AS fee, amount::text AS amount,
          payout_drop::text AS drop, stripe_refund_id, label, reversed_at IS NOT NULL AS reversed,
          replaces_part_id IS NOT NULL AS replaces
     FROM stay_refund_parts WHERE booking_id = $1 ORDER BY seq, created_at, (replaces_part_id IS NOT NULL)`, [b])
const held = async (f: F) => query<any>(
  `SELECT source_type, source_id, amount::text AS amount FROM held_payout_items WHERE landlord_id = $1 AND source_type = 'refund' ORDER BY created_at`, [f.landlordId])
const decisions = async (b: string) => query<any>(
  `SELECT status, question, choice, booked_price::text AS b, stayed_worth::text AS s, paid::text AS p, refund_total::text AS refunded
     FROM stay_checkout_decisions WHERE booking_id = $1 ORDER BY created_at`, [b])
const owed = async (b: string) => (await reservationDue(db, b))!.owed

// ─── The question ─────────────────────────────────────────────────────────────

describe('the quote: one question, decided on the server', () => {
  it('leaving on the booked day: no question — one button, and nothing about the money changes', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: TODAY, total: 240 })
    await paySale(f, b, { method: 'cash', toward: 240 })
    const q = await getQuote(f, b)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toMatchObject({ early: false, question: 'none', choices: [], paid: 240, leftOn: TODAY })
    const out = await decide(f, b, { choice: null })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data).toMatchObject({ checkedOut: true, next: 'done', words: ['Jane Doe is checked out.'] })
    expect(await row(b)).toMatchObject({ status: 'checked_out', check_out: TODAY, total: '240.00' })
    expect(await decisions(b)).toEqual([])
    expect(h.refundsCreate).not.toHaveBeenCalled()
  })

  it('still owes (paid less than the nights stayed are worth): keep the price, or charge only the nights stayed', async () => {
    const f = await seed()
    // Sep 28 to Oct 6, 8 nights at $60 = $480; $120 paid; left today after 4 nights ($240).
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 120 })
    const q = (await getQuote(f, b)).body.data
    expect(q).toMatchObject({
      early: true, question: 'owes', paid: 120,
      booked: { checkOut: '2026-10-06', nights: 8, price: 480 }, stayed: { checkOut: TODAY, nights: 4, worth: 240 },
    })
    expect(q.choices.map((c: any) => [c.choice, c.label, c.result])).toEqual([
      ['keep_price', 'Keep the price as booked', 'They will owe $360.00'],
      ['nights_only', 'Charge only the nights stayed (4 nights, $240.00)', 'They will owe $120.00'],
    ])

    // Keep the price: nothing about the money changes; they owe the rest.
    const keep = await decide(f, b, { choice: 'keep_price' })
    expect(keep.status, JSON.stringify(keep.body)).toBe(200)
    expect(await row(b)).toMatchObject({ status: 'checked_out', check_out: TODAY, total: '480.00', booked_check_out: '2026-10-06' })
    expect(await owed(b)).toBe(360)
    expect(await decisions(b)).toEqual([{ status: 'decided', question: 'owes', choice: 'keep_price', b: '480.00', s: '240.00', p: '120.00', refunded: '0.00' }])
    const ev = await query<any>(`SELECT summary FROM unit_booking_events WHERE booking_id = $1 AND event_type = 'money_settled'`, [b])
    expect(ev.map((e) => e.summary)).toEqual(['Jane Doe left early — kept the price as booked ($480.00)'])

    // Charge only the nights stayed: the stay is now sold for the nights stayed.
    const g = await seed()
    const b2 = await stay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(g, b2, { method: 'cash', toward: 120 })
    const nights = await decide(g, b2, { choice: 'nights_only' })
    expect(nights.status, JSON.stringify(nights.body)).toBe(200)
    expect(await row(b2)).toMatchObject({ total: '240.00', booked_check_out: TODAY, check_out: TODAY })
    expect(await owed(b2)).toBe(120)
  })

  it('charge only the nights stayed, paid exactly that: the stay closes and every other way of paying it closes too', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 240 })
    const link = (await query<{ id: string }>(
      `INSERT INTO pos_pay_links (landlord_id, property_id, created_by, kind, label, token, items, subtotal, tax_amount, total, status, booking_id, customer_email)
       VALUES ($1,$2,$3,'one_time','Stay',$4,'[]'::jsonb,240,0,240,'open',$5,'jane@t.dev') RETURNING id`,
      [f.landlordId, f.propertyId, f.userId, `tok_${randomUUID()}`, b]))[0].id
    const q = (await getQuote(f, b)).body.data
    expect(q.question).toBe('owes')
    expect(q.choices[1].result).toBe('Nothing more is owed')
    expect((await decide(f, b, { choice: 'nights_only' })).status).toBe(200)
    expect(await owed(b)).toBe(0)
    expect((await row(b)).balance_paid_at).not.toBeNull()
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link]))[0].status).toBe('cancelled')
  })

  it('paid more than the nights stayed but less than booked (Q1): the refund choices; No refund leaves the rest owed', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 300 })
    const q = (await getQuote(f, b)).body.data
    expect(q).toMatchObject({ question: 'overpaid', unused: 60, maxRefund: 300, paid: 300 })
    expect(q.choices.map((c: any) => [c.choice, c.label, c.result])).toEqual([
      ['no_refund', 'No refund (keep the price as booked)', 'Nothing goes back, and they still owe $180.00'],
      ['refund_unused', 'Refund the unused nights ($60.00)', 'Hand back $60.00 in cash now'],
      ['refund_other', 'Refund a different amount', 'Type any amount up to $300.00'],
    ])
    expect((await decide(f, b, { choice: 'no_refund' })).status).toBe(200)
    expect(await owed(b)).toBe(180)
    expect(await row(b)).toMatchObject({ total: '480.00' })
    expect(await parts(b)).toEqual([])
  })

  it('a weekly stay cut short: the nights stayed at the nightly tier, lodging tax inside — and never more than the booked price (Q7)', async () => {
    const f = await seed({ taxPct: 10 })
    const weekly = priceStay({ nightly: 60, weekly: 350, monthly: 1500 }, 10, '2026-09-28', 7).total
    expect(weekly).toBe(385)
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-05', total: weekly, leaseType: 'weekly' })
    await paySale(f, b, { method: 'cash', toward: 385 })
    const q = (await getQuote(f, b)).body.data
    // 4 nights at $60 plus 10% = $264.
    expect(q).toMatchObject({ question: 'overpaid', stayed: { nights: 4, worth: 264 }, unused: 121 })

    // Left after 6 nights: $360 + 10% = $396 is more than the $385 week — the week stands, no question.
    const g = await seed({ taxPct: 10 })
    const b2 = await stay(g, { checkIn: '2026-09-26', checkOut: '2026-10-03', total: weekly, leaseType: 'weekly' })
    await paySale(g, b2, { method: 'cash', toward: 385 })
    const q2 = (await getQuote(g, b2, g.token, '2026-10-02')).body.data
    expect(q2).toMatchObject({ early: true, question: 'none', stayed: { nights: 6, worth: 385 } })
    const g2 = await seed({ taxPct: 10 })
    const b3 = await stay(g2, { checkIn: '2026-09-26', checkOut: '2026-10-03', total: weekly, leaseType: 'weekly' })
    await paySale(g2, b3, { method: 'cash', toward: 100 })
    // Owes either way, and "Charge only the nights stayed" would cost more: not offered.
    expect((await getQuote(g2, b3)).body.data).toMatchObject({ question: 'none', choices: [] })
  })

  it('money GAM holds aside (paid twice, more than owed) is never counted as paid toward the stay', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 120 })
    await query(`INSERT INTO pos_held_payments (landlord_id, property_id, booking_id, stripe_payment_intent_id, reason, amount)
                 VALUES ($1,$2,$3,'pi_twice','paid_twice',480)`, [f.landlordId, f.propertyId, b])
    expect((await getQuote(f, b)).body.data).toMatchObject({ paid: 120, question: 'owes' })
  })

  it('a refund made at the register before check-out is not counted as paid: what they paid is what is still with the landlord', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const { saleId } = await paySale(f, b, { method: 'cash', toward: 300 })
    const reg = await request(app()).post(`/api/pos/transactions/${saleId}/refund`).set('Authorization', `Bearer ${f.token}`)
      .send({ amount: 100, refundMethod: 'cash', reason: 'mid-stay' })
    expect(reg.status, JSON.stringify(reg.body)).toBe(200)
    // $300 paid, $100 given back at the register: $200 paid. Left after 4 nights ($240) — they still owe.
    const q = (await getQuote(f, b)).body.data
    expect(q).toMatchObject({ paid: 200, question: 'owes', unused: 0, maxRefund: 0 })
    expect(q.choices.map((c: any) => [c.choice, c.result])).toEqual([
      ['keep_price', 'They will owe $280.00'],
      ['nights_only', 'They will owe $40.00'],
    ])
    expect((await decide(f, b, { choice: 'refund_other', refundAmount: 60 })).status).toBe(409)
    const out = await decide(f, b, { choice: 'nights_only' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(await owed(b)).toBe(40)

    // A sale with other items on it: a register refund comes off those first.
    const g = await seed()
    const b2 = await stay(g, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480, guest: 'Sam Roe' })
    const mixed = (await query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total, platform_fee)
       VALUES ($1,$2,$3,'cash',400,0,0,400,0) RETURNING id`, [g.landlordId, g.propertyId, g.userId]))[0].id
    const c = await db.connect()
    try { await recordSaleTowardStay(c, { bookingId: b2, saleId: mixed, toward: 300 }) } finally { c.release() }
    await stampPaid(b2)
    expect((await request(app()).post(`/api/pos/transactions/${mixed}/refund`).set('Authorization', `Bearer ${g.token}`)
      .send({ amount: 100, refundMethod: 'cash' })).status).toBe(200)
    expect((await getQuote(g, b2)).body.data).toMatchObject({ paid: 300, question: 'overpaid', unused: 60, maxRefund: 300 })
  })
})

// ─── Refunds ──────────────────────────────────────────────────────────────────

describe('a refund goes back the way it was paid', () => {
  it('a reader card sale: the part plus the card fee paid on it back to the card; the payout drops by that; the register, income and the close all see it', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const { saleId, pi } = await paySale(f, b, { method: 'card', toward: 300, fee: 11.05 })
    const q = (await getQuote(f, b)).body.data
    const unused = q.choices.find((c: any) => c.choice === 'refund_unused')
    // $60 of the $300 plus its share of the $11.05 card fee ($2.21).
    expect(unused.refund.parts).toEqual([expect.objectContaining({ kind: 'card', amount: 62.21 })])
    expect(unused.refund.cost).toBe(
      'Stripe keeps its processing fee on a refund, and that is your cost: your next payout drops by $62.21 — $2.21 more than you were paid for this part of the stay.')

    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data.next).toBe('done')
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    const [params, opts] = h.refundsCreate.mock.calls[0]
    expect(params).toMatchObject({ payment_intent: pi, amount: 6221, metadata: expect.objectContaining({ gam_purpose: 'stay_early_checkout_refund' }) })
    const [part] = await parts(b)
    expect(opts).toEqual({ idempotencyKey: expect.stringMatching(/^gam-stay-refund-[0-9a-f-]{36}-1$/) })
    expect(part).toMatchObject({ kind: 'card', status: 'refunded', toward: '60.00', fee: '2.21', amount: '62.21', drop: '62.21', stripe_refund_id: 're_1' })
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_1', amount: '-62.21' }])
    expect(await query<any>(`SELECT refund_method, amount::text, card_fee_refunded::text, stripe_refund_id FROM pos_refunds WHERE transaction_id = $1`, [saleId]))
      .toEqual([{ refund_method: 'card', amount: '62.21', card_fee_refunded: '2.21', stripe_refund_id: 're_1' }])
    expect((await query<any>(`SELECT status, refund_amount::text FROM pos_transactions WHERE id = $1`, [saleId]))[0])
      .toEqual({ status: 'partial_refund', refund_amount: '62.21' })
    // Q2: re-prices nothing; the stay closes with nothing owed.
    expect(await row(b)).toMatchObject({ total: '480.00', booked_check_out: '2026-10-06' })
    expect(await owed(b)).toBe(0)
    // Income: only the stay part comes off, on the refund day — never the card fee.
    const ev = await incomeEvents({ landlordIds: [f.landlordId], start: '2026-01-01', end: '2027-12-31', basis: 'received' })
    expect(ev.filter((e) => e.amount < 0).map((e) => [e.line, e.amount])).toEqual([['registerAndStays', -60]])
    // The close counts the card refund, outside the drawer.
    const day = (await query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Phoenix')::date, 'YYYY-MM-DD') AS d`))[0].d
    const eod = await generateEodSettlement(f.landlordId, f.propertyId, day)
    expect(eod).toMatchObject({ cardRefunds: 62.21, cashRefunds: 0 })
  })

  it('a card on file whose fee the landlord covered: the guest gets back what they paid, and the cost is said', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card_on_file', toward: 480, landlordFee: 17.35 })
    const out = await decide(f, b, { choice: 'refund_other', refundAmount: 240 })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(h.refundsCreate.mock.calls[0][0]).toMatchObject({ amount: 24000 })
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', toward: '240.00', fee: '0.00', amount: '240.00', drop: '240.00' })])
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_1', amount: '-240.00' }])
  })

  it('a pay link (card fee on top) goes back to the card it was paid with, labeled as the pay link', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480, fee: 17.35, payLink: true })
    const q = (await getQuote(f, b)).body.data
    expect(q.sources[0].label).toMatch(/^Card · pay link /)
    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    // $240 plus half the $17.35 fee ($8.68, to the cent).
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', toward: '240.00', fee: '8.68', amount: '248.68' })])
  })

  it('a booking-site deposit is itemized when it lands, and goes back to its card', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480, status: 'tentative' })
    // A $300 deposit with GAM's $11.05 card fee on top.
    await query(`UPDATE unit_bookings SET stripe_checkout_session_id = 'cs_dep', deposit_amount = 300 WHERE id = $1`, [b])
    await confirmBookingDeposit(b, 'cs_dep', { paymentIntentId: 'pi_dep', amountTotalCents: 31105 })
    expect(await query<any>(`SELECT kind, method, toward_stay::text, card_fee::text, stripe_payment_intent_id FROM stay_payments WHERE booking_id = $1`, [b]))
      .toEqual([{ kind: 'site_deposit', method: 'card', toward_stay: '300.00', card_fee: '11.05', stripe_payment_intent_id: 'pi_dep' }])
    await query(`UPDATE unit_bookings SET status = 'checked_in' WHERE id = $1`, [b])
    // Left after 4 nights ($240): $60 of it is unused; the whole deposit can go back.
    const out = await decide(f, b, { choice: 'refund_other', refundAmount: 300 })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(h.refundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: 'pi_dep', amount: 31105 })
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_1', amount: '-311.05' }])
    expect(await query(`SELECT 1 FROM pos_refunds`)).toHaveLength(0)
    const ev = await incomeEvents({ landlordIds: [f.landlordId], start: '2026-01-01', end: '2027-12-31', basis: 'received' })
    expect(ev.filter((e) => e.amount < 0).map((e) => [e.line, e.category, e.amount])).toEqual([['registerAndStays', 'stays_and_pay_links', -300]])
  })

  it('a card deposit then a cash balance: most recent first — cash handed back at the desk, then the card; the parts add up', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const card = await paySale(f, b, { method: 'card', toward: 100, fee: 4.05 })
    await query(`UPDATE stay_payments SET paid_at = NOW() - INTERVAL '3 days' WHERE pos_transaction_id = $1`, [card.saleId])
    const cash = await paySale(f, b, { method: 'cash', toward: 380 })
    // The unused nights ($240) all go back from the newest payment, the cash.
    const unused = (await getQuote(f, b)).body.data.choices.find((c: any) => c.choice === 'refund_unused')
    expect(unused.refund.parts.map((p: any) => p.words)).toEqual(['Hand back $240.00 in cash now'])
    // $400: all $380 of the cash, then $20 of the card (with its $0.81 of fee).
    const out = await decide(f, b, { choice: 'refund_other', refundAmount: 400 })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data.words[0]).toBe('Hand back $380.00 in cash now.')
    expect(await parts(b)).toEqual([
      expect.objectContaining({ seq: 1, kind: 'cash', status: 'handed_back', toward: '380.00', amount: '380.00', drop: '0.00' }),
      expect.objectContaining({ seq: 2, kind: 'card', status: 'refunded', toward: '20.00', fee: '0.81', amount: '20.81' }),
    ])
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(h.refundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: card.pi, amount: 2081 })
    expect(await query<any>(`SELECT refund_method, amount::text FROM pos_refunds WHERE transaction_id = $1`, [cash.saleId]))
      .toEqual([{ refund_method: 'cash', amount: '380.00' }])
    expect((await decisions(b))[0]).toMatchObject({ choice: 'refund_other', refunded: '400.00' })
  })

  it('a charge account is refunded back onto the account', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const { saleId } = await paySale(f, b, { method: 'charge', toward: 480 })
    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'charge', status: 'refunded', amount: '240.00' })])
    expect(await query<any>(`SELECT amount::text FROM flex_charge_transactions WHERE pos_transaction_id = $1 ORDER BY created_at`, [saleId]))
      .toEqual([{ amount: '480.00' }, { amount: '-240.00' }])
    expect(h.refundsCreate).not.toHaveBeenCalled()
  })

  it('"Refund a different amount": nothing at $0 or over what was paid; the whole amount paid is the full refund', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 480 })
    const zero = await decide(f, b, { choice: 'refund_other', refundAmount: 0 })
    expect(zero.status).toBe(400)
    expect(zero.body.error).toBe('Type how much to refund (more than $0.00), then confirm again.')
    const over = await decide(f, b, { choice: 'refund_other', refundAmount: 480.01 })
    expect(over.status).toBe(400)
    expect(over.body.error).toBe('That is more than can be refunded — $480.00 at most. Change the amount, then confirm again.')
    expect(await row(b)).toMatchObject({ status: 'checked_in' })
    expect(await decisions(b)).toEqual([])
    const preview = await request(app()).get(url(f, b, '/refund-preview?amount=100')).set('Authorization', `Bearer ${f.token}`)
    expect(preview.body.data.parts.map((p: any) => p.words)).toEqual(['Hand back $100.00 in cash now'])
    const full = await decide(f, b, { choice: 'refund_other', refundAmount: 480 })
    expect(full.status, JSON.stringify(full.body)).toBe(200)
    expect((await decisions(b))[0]).toMatchObject({ refunded: '480.00' })
    expect(await owed(b)).toBe(0)
  })
})

// ─── Who may do what ───────────────────────────────────────────────────────────

describe('permissions', () => {
  it('"Check guests out" checks an overpaid guest out without "Issue refunds"; the money waits for the owner, who decides it', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 480 })
    const desk = await staff(f, { 'guests.check_out': true })
    const q = (await getQuote(f, b, desk)).body.data
    // The refund choices are not in the quote at all for them.
    expect(q).toMatchObject({ question: 'overpaid', canRefund: false, choices: [] })
    expect(q.waitsForRefund).toBe(
      'Jane Doe paid $240.00 more than the nights they stayed are worth. You can check them out now; '
      + 'what to do with that money waits on the stay for someone who can issue refunds, and the owner gets a to-do.')
    const refused = await decide(f, b, { choice: 'refund_unused' }, desk)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/^Refunding needs the "Issue refunds" permission, and nothing was changed/)
    expect(await row(b)).toMatchObject({ status: 'checked_in' })

    const out = await decide(f, b, { choice: null }, desk)
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data.next).toBe('waits')
    expect(await row(b)).toMatchObject({ status: 'checked_out', check_out: TODAY })
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'pending', question: 'overpaid', choice: null })])
    const todo = await query<any>(`SELECT title, action_url FROM notifications WHERE landlord_id = $1 AND type = 'stay_money_decision'`, [f.landlordId])
    expect(todo).toEqual([{ title: "Decide the money for Jane Doe's early check-out — RV 07", action_url: `/schedule?checkout=${b}&unit=${f.unitId}` }])
    const todos = await request(app()).get('/api/landlords/me/todos').set('Authorization', `Bearer ${f.token}`)
    expect(todos.body.data.stayMoney).toEqual([expect.objectContaining({ type: 'stay_money_decision', href: `/schedule?checkout=${b}&unit=${f.unitId}` })])
    // The schedule marks it.
    const sched = await request(app()).get(`/api/units/schedule/master?from=2026-09-20&to=2026-10-20&propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${desk}`)
    expect(sched.status, JSON.stringify(sched.body)).toBe(200)
    expect(sched.body.data.bookings.find((x: any) => x.id === b).moneyDecisionPending).toBe(true)

    // The owner opens it and decides: the refund choices are there now.
    const oq = (await getQuote(f, b)).body.data
    expect(oq).toMatchObject({ checkedOut: true, question: 'overpaid', unused: 240, canRefund: true })
    const done = await decide(f, b, { choice: 'refund_unused' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'decided', choice: 'refund_unused', refunded: '240.00' })])
    expect((await request(app()).get('/api/landlords/me/todos').set('Authorization', `Bearer ${f.token}`)).body.data.stayMoney).toEqual([])
  })

  it('without "Check guests out" nobody checks a guest out; out-of-scope staff reach nothing', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const noPerm = await staff(f, { 'schedule.tab.timeline': true })
    expect((await getQuote(f, b, noPerm)).status).toBe(403)
    expect((await request(app()).post(url(f, b)).set('Authorization', `Bearer ${noPerm}`).send({ choice: null })).status).toBe(403)
    // "Issue refunds" alone can decide money, but not check a guest out.
    const refundsOnly = await staff(f, { 'pos.refund': true })
    const r = await decide(f, b, { choice: 'keep_price' }, refundsOnly)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('Checking a guest out needs the "Check guests out" permission, and nothing was changed. Ask the account owner to turn it on for you in My Team.')
    const c = await db.connect()
    let other = ''
    try { other = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId }) } finally { c.release() }
    const elsewhere = await staff(f, { 'guests.check_out': true, 'pos.refund': true }, [other])
    expect((await getQuote(f, b, elsewhere)).status).toBe(403)
    expect(await row(b)).toMatchObject({ status: 'checked_in' })
  })

  it('every permission label the new hints quote is a real label', () => {
    const labels = new Set(PERMISSION_CATALOG.flatMap((g) => g.sections.flatMap((s) => s.items.map((i) => i.label))))
    const items = PERMISSION_CATALOG.flatMap((g) => g.sections.flatMap((s) => s.items))
    const checkOut = items.find((i) => i.key === 'guests.check_out')!
    for (const quoted of (checkOut.hint ?? '').match(/"([^"]+)"/g) ?? []) expect(labels.has(quoted.slice(1, -1)), quoted).toBe(true)
    expect(checkOut.hint).toMatch(/"Issue refunds"/)
  })
})

// ─── Two staff, double clicks, things changing underneath ──────────────────────

describe('decided once', () => {
  it('a double click refunds once; a second person is told who decided what', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    const q = (await getQuote(f, b)).body.data
    const key = randomUUID()
    const send = () => request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: 'refund_unused', quoteToken: q.quoteToken, idempotencyKey: key })
    const one = await send()
    const two = await send()
    expect(one.status, JSON.stringify(one.body)).toBe(200)
    expect(two.status, JSON.stringify(two.body)).toBe(200)
    expect(two.body.data.decision.id).toBe(one.body.data.decision.id)
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(await held(f)).toHaveLength(1)

    const other = await request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: 'no_refund', quoteToken: q.quoteToken, idempotencyKey: randomUUID() })
    expect(other.status).toBe(409)
    expect(other.body.code).toBe('already_decided')
    expect(other.body.error).toMatch(/^Test Landlord already decided this check-out: Refund the unused nights/)
  })

  it('a double click landing at the same moment waits on the first and gets its result — one refund', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    const q = (await getQuote(f, b)).body.data
    const key = randomUUID()
    const both = await Promise.all([1, 2].map(() => request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: 'refund_unused', quoteToken: q.quoteToken, idempotencyKey: key })))
    expect(both.map((x) => x.status), JSON.stringify(both.map((x) => x.body))).toEqual([200, 200])
    expect(both[0].body.data.decision.id).toBe(both[1].body.data.decision.id)
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(await held(f)).toHaveLength(1)
    expect(await parts(b)).toEqual([expect.objectContaining({ status: 'refunded' })])
  })

  it('a quote that changed underneath is refused with the fresh one; two presses at once decide once', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 120 })
    const stale = (await getQuote(f, b)).body.data
    await paySale(f, b, { method: 'cash', toward: 200 })   // a payment lands meanwhile
    const r = await request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: 'keep_price', quoteToken: stale.quoteToken, idempotencyKey: randomUUID() })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('checkout_changed')
    expect(r.body.data).toMatchObject({ paid: 320, question: 'overpaid' })
    expect(await row(b)).toMatchObject({ status: 'checked_in' })

    const fresh = r.body.data
    const both = await Promise.all([1, 2].map(() => request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: 'refund_unused', quoteToken: fresh.quoteToken, idempotencyKey: randomUUID() })))
    expect(both.map((x) => x.status).sort()).toEqual([200, 409])
    expect(await decisions(b)).toHaveLength(1)
    expect(await parts(b)).toHaveLength(1)
  })
  it('the same press sent again after a check-out with no money question returns what it did, never a false error', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: TODAY, total: 240 })
    await paySale(f, b, { method: 'cash', toward: 240 })
    const q = (await getQuote(f, b)).body.data
    const key = randomUUID()
    const send = () => request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: null, quoteToken: q.quoteToken, idempotencyKey: key })
    const both = await Promise.all([send(), send()])
    expect(both.map((x) => x.status), JSON.stringify(both.map((x) => x.body))).toEqual([200, 200])
    const third = await send()
    expect(third.status, JSON.stringify(third.body)).toBe(200)
    for (const r of [...both, third]) expect(r.body.data).toMatchObject({ checkedOut: true, next: 'done', words: ['Jane Doe is checked out.'] })
    expect(await query(`SELECT 1 FROM unit_booking_events WHERE booking_id = $1 AND event_type = 'status_changed'`, [b])).toHaveLength(1)
    // A new press on a stay already out with nothing open says so too.
    const fresh = await request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: null, quoteToken: 'stale', idempotencyKey: randomUUID() })
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200)
    expect(fresh.body.data.words).toEqual(['Jane Doe is checked out.'])
  })

  it('"Issue refunds" alone never re-prices a stay: keeping the price or charging only the nights stayed needs "Check guests out"', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 120 })
    // Checked out off the window: the "still owes" question waits on the stay.
    const p = await request(app()).patch(`/api/units/${f.unitId}/bookings/${b}`).set('Authorization', `Bearer ${f.token}`).send({ status: 'checked_out' })
    expect(p.status, JSON.stringify(p.body)).toBe(200)
    const refundsOnly = await staff(f, { 'pos.refund': true })
    const q = (await getQuote(f, b, refundsOnly)).body.data
    expect(q).toMatchObject({ question: 'owes', choices: [], canCheckOut: false,
      waitsForCheckOut: 'Jane Doe left early and still owes for the stay. Only someone with "Check guests out" can choose whether to keep the price as booked or charge only the nights stayed.' })
    const r = await request(app()).post(url(f, b)).set('Authorization', `Bearer ${refundsOnly}`)
      .send({ choice: 'nights_only', quoteToken: q.quoteToken, idempotencyKey: randomUUID() })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('Choosing whether to keep the price as booked or charge only the nights stayed needs the "Check guests out" permission, and nothing was changed. Ask the account owner to turn it on for you in My Team.')
    expect(await row(b)).toMatchObject({ total: '480.00' })
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'pending', question: 'owes' })])
    // Pressing the window's button without a choice says who can decide it — never a refund line.
    const wait = await request(app()).post(url(f, b)).set('Authorization', `Bearer ${refundsOnly}`)
      .send({ choice: null, quoteToken: q.quoteToken, idempotencyKey: randomUUID() })
    expect(wait.status, JSON.stringify(wait.body)).toBe(200)
    expect(wait.body.data).toMatchObject({ next: 'waits', words: [q.waitsForCheckOut] })
    // The owner (who can check guests out) still can.
    expect((await decide(f, b, { choice: 'nights_only' })).status).toBe(200)
    expect(await row(b)).toMatchObject({ total: '240.00' })
  })

  it('"Issue refunds" alone, on a guest not checked out yet (reached by a link): no choices, one line saying who can check them out', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 480 })
    const refundsOnly = await staff(f, { 'pos.refund': true })
    const q = (await getQuote(f, b, refundsOnly)).body.data
    expect(q).toMatchObject({ checkedOut: false, question: 'overpaid', choices: [], canCheckOut: false, canRefund: true,
      waitsForCheckOut: 'Jane Doe is not checked out yet. Only someone with "Check guests out" can check them out.' })
    const r = await request(app()).post(url(f, b)).set('Authorization', `Bearer ${refundsOnly}`)
      .send({ choice: 'refund_unused', quoteToken: q.quoteToken, idempotencyKey: randomUUID() })
    expect(r.status).toBe(403)
    expect(await row(b)).toMatchObject({ status: 'checked_in' })
    expect(h.refundsCreate).not.toHaveBeenCalled()
  })
})

// ─── Failures ──────────────────────────────────────────────────────────────────

describe('when Stripe fails', () => {
  it('a card refund that fails says so and offers Try again; the retry sends it exactly once', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 100 })
    const card = await paySale(f, b, { method: 'card', toward: 380 })
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_other', refundAmount: 400 })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data.next).toBe('try_again')
    const failed = (await parts(b)).find((p) => p.kind === 'card')
    expect(failed).toMatchObject({ status: 'failed', amount: '380.00' })
    expect(out.body.data.words).toContain('$380.00 could not be refunded to the card yet — press Try again.')
    expect(await held(f)).toEqual([])

    const partId = out.body.data.decision.parts.find((p: any) => p.kind === 'card').id
    const retry = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(retry.status, JSON.stringify(retry.body)).toBe(200)
    expect(retry.body.data.next).toBe('done')
    expect(h.refundsCreate).toHaveBeenCalledTimes(2)
    expect(h.refundsCreate.mock.calls[1][0]).toMatchObject({ payment_intent: card.pi, amount: 38000 })
    expect(h.refundsCreate.mock.calls[1][1]).toEqual({ idempotencyKey: `gam-stay-refund-${partId}-2` })
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_1', amount: '-380.00' }])
    // Pressed again: nothing more goes out.
    await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(h.refundsCreate).toHaveBeenCalledTimes(2)
  })

  it('a try whose answer was lost is found at Stripe, never sent twice', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    // Stripe made the refund, but the answer never came back.
    h.refundsCreate.mockImplementationOnce(async (p: any) => {
      h.made.push({ id: 're_lost', status: 'succeeded', amount: p.amount, payment_intent: p.payment_intent, metadata: p.metadata })
      throw new Error('socket hang up')
    })
    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.body.data.next).toBe('try_again')
    const partId = out.body.data.decision.parts[0].id
    const retry = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(retry.body.data.next).toBe('done')
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_lost', amount: '-240.00' }])
  })

  it('Stripe reports a sent refund failed: the part reopens for Try again, the payout gets the money back, the owner is told', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    expect((await decide(f, b, { choice: 'refund_unused' })).status).toBe(200)
    expect(await stripeRefundFailed({ id: 're_1', status: 'failed', metadata: { gam_purpose: 'stay_early_checkout_refund' } })).toBe(true)
    // The refund that went out keeps its record (reversed now); a new part carries what is still owed to the guest.
    expect(await parts(b)).toEqual([
      expect.objectContaining({ kind: 'card', status: 'refunded', reversed: true, replaces: false, stripe_refund_id: 're_1' }),
      expect.objectContaining({ kind: 'card', status: 'failed', reversed: false, replaces: true, amount: '240.00', stripe_refund_id: null }),
    ])
    expect(await held(f)).toEqual([
      { source_type: 'refund', source_id: 're_1', amount: '-240.00' },
      { source_type: 'refund', source_id: 're_1:failed', amount: '240.00' },
    ])
    const told = await query<any>(`SELECT title FROM notifications WHERE landlord_id = $1 AND type = 'stay_refund_failed'`, [f.landlordId])
    expect(told).toEqual([{ title: 'A refund to Jane Doe came back' }])
    // The window shows the part to send again, with both ways out named.
    const q = (await getQuote(f, b)).body.data
    expect(q.decision.parts).toEqual([expect.objectContaining({ status: 'failed',
      failure: 'The card company sent this refund back — press Try again, or hand it back in cash and press "Give it back in cash instead".' })])
    // Said twice by Stripe: once.
    await stripeRefundFailed({ id: 're_1', status: 'failed' })
    expect(await held(f)).toHaveLength(2)
    expect(await parts(b)).toHaveLength(2)
    // Some other refund is not ours.
    expect(await stripeRefundFailed({ id: 're_unknown', status: 'failed' })).toBe(false)
    // Try again sends the new part once.
    const retry = await request(app()).post(url(f, b, `/parts/${q.decision.parts[0].id}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(retry.body.data.next, JSON.stringify(retry.body)).toBe('done')
    expect(h.refundsCreate).toHaveBeenCalledTimes(2)
    expect(await held(f)).toEqual([
      { source_type: 'refund', source_id: 're_1', amount: '-240.00' },
      { source_type: 'refund', source_id: 're_1:failed', amount: '240.00' },
      { source_type: 'refund', source_id: 're_2', amount: '-240.00' },
    ])
  })
  it('a refund that fails at once is never lost: the owner is told once, the schedule and the to-dos show it, and Try again from the decided stay sends it exactly once', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480, fee: 17.35 })
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data.next).toBe('try_again')
    const partId = out.body.data.decision.parts[0].id
    // The stay says nothing is owed — the refund is what is still owed to the guest.
    expect((await row(b)).balance_paid_at).not.toBeNull()
    const told = async () => query<any>(`SELECT title, action_url FROM notifications WHERE landlord_id = $1 AND type = 'stay_refund_failed'`, [f.landlordId])
    expect(await told()).toEqual([{ title: 'A refund to Jane Doe did not go out', action_url: `/schedule?checkout=${b}&unit=${f.unitId}` }])
    const todos = async () => (await request(app()).get('/api/landlords/me/todos').set('Authorization', `Bearer ${f.token}`)).body.data.stayMoney
    expect(await todos()).toEqual([expect.objectContaining({
      type: 'stay_refund_retry', title: 'Send the refund again: Jane Doe left early (RV 07)', href: `/schedule?checkout=${b}&unit=${f.unitId}` })])
    const flags = async () => (await request(app()).get(`/api/units/schedule/master?from=2026-09-20&to=2026-10-20&propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)).body.data.bookings.find((x: any) => x.id === b)
    expect(await flags()).toMatchObject({ status: 'checked_out', moneyDecisionPending: false, refundNeedsRetry: true })

    // The done screen was closed. Opened again later (the notification's link):
    // what was decided, with the failed part to try again — opening sends nothing.
    const q = (await getQuote(f, b)).body.data
    expect(q.decision).toMatchObject({ status: 'decided', choice: 'refund_unused', parts: [expect.objectContaining({ id: partId, status: 'failed' })] })
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    // Only someone who can issue refunds can send it.
    const desk = await staff(f, { 'guests.check_out': true })
    expect((await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${desk}`).send({})).status).toBe(403)
    // It fails again: still waiting, and the owner is not told twice.
    h.state.failNext = 1
    const again = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(again.body.data.next).toBe('try_again')
    expect(await told()).toHaveLength(1)
    // Then it goes — once.
    const sent = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(sent.body.data.next).toBe('done')
    expect(h.refundsCreate).toHaveBeenCalledTimes(3)
    expect(h.refundsCreate.mock.calls[2][0]).toMatchObject({ amount: 24868 })
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_1', amount: '-248.68' }])
    expect(await todos()).toEqual([])
    expect(await flags()).toMatchObject({ refundNeedsRetry: false })
    await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(h.refundsCreate).toHaveBeenCalledTimes(3)
  })

  it('a refund left "sending" by a crash is flagged after 10 minutes and goes out when the stay is opened', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    const partId = out.body.data.decision.parts[0].id
    // As a crash between the decision and Stripe leaves it.
    await query(`UPDATE stay_refund_parts SET status = 'pending', failure = NULL, created_at = NOW() - INTERVAL '11 minutes' WHERE id = $1`, [partId])
    const sched = await request(app()).get(`/api/units/schedule/master?from=2026-09-20&to=2026-10-20&propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(sched.body.data.bookings.find((x: any) => x.id === b).refundNeedsRetry).toBe(true)
    const q = (await getQuote(f, b)).body.data
    expect(q.decision.parts).toEqual([expect.objectContaining({ id: partId, status: 'refunded' })])
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_1', amount: '-240.00' }])
  })

  it('Stripe reports a register card refund failed: the refund day is never rewritten — the sale, income, the close and the card fee line are reversed on the day it came back, until Try again sends it', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const { saleId } = await paySale(f, b, { method: 'card', toward: 300, fee: 11.05 })
    expect((await decide(f, b, { choice: 'refund_unused' })).status).toBe(200)
    // The sale was 3 days ago and the refund went out 2 days ago; Stripe sends it back today.
    await query(`UPDATE pos_transactions SET created_at = created_at - INTERVAL '3 days' WHERE id = $1`, [saleId])
    await query(`UPDATE pos_refunds SET created_at = created_at - INTERVAL '2 days' WHERE transaction_id = $1`, [saleId])
    await query(`UPDATE stay_refund_parts SET refunded_at = refunded_at - INTERVAL '2 days', created_at = created_at - INTERVAL '2 days' WHERE booking_id = $1`, [b])
    const days = (await query<{ d0: string; d2: string; d3: string }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS d0, to_char(d - 2, 'YYYY-MM-DD') AS d2, to_char(d - 3, 'YYYY-MM-DD') AS d3
         FROM (SELECT (now() AT TIME ZONE 'America/Phoenix')::date AS d) x`))[0]
    const sorted = (xs: Array<[string, string, number]>) =>
      [...xs].sort((x, y) => (x[0] + x[1] + String(x[2])).localeCompare(y[0] + y[1] + String(y[2])))
    const sale = async () => (await query<any>(`SELECT status, refund_amount::text AS refunded, refunded_at IS NOT NULL AS stamped FROM pos_transactions WHERE id = $1`, [saleId]))[0]
    const saleRefunds = async () => query<any>(
      `SELECT refund_method, amount::text, stripe_refund_id, reversed_at IS NOT NULL AS reversed FROM pos_refunds WHERE transaction_id = $1 ORDER BY created_at`, [saleId])
    const income = async () => sorted((await incomeEvents({ landlordIds: [f.landlordId], start: '2026-01-01', end: '2027-12-31', basis: 'received' }))
      .filter((e) => e.line === 'registerAndStays' || e.line === 'refundCardFees')
      .map((e) => [e.day, e.line, e.amount] as [string, string, number]))
    const close = async (d: string) => (await generateEodSettlement(f.landlordId, f.propertyId, d)).cardRefunds
    expect(await sale()).toEqual({ status: 'partial_refund', refunded: '62.21', stamped: true })
    // The card fee the guest got back is the landlord's cost, its own line beside the total.
    const before: Array<[string, string, number]> = [
      [days.d2, 'refundCardFees', 2.21], [days.d2, 'registerAndStays', -60], [days.d3, 'registerAndStays', 300],
    ]
    expect(await income()).toEqual(sorted(before))
    expect(await close(days.d2)).toBe(62.21)

    expect(await stripeRefundFailed({ id: 're_1', status: 'failed' })).toBe(true)
    h.made.find((r) => r.id === 're_1')!.status = 'failed'   // what Stripe's list says from now on
    // The sale's card refund row stays as the record; it no longer counts as refunded.
    expect(await saleRefunds()).toEqual([{ refund_method: 'card', amount: '62.21', stripe_refund_id: 're_1', reversed: true }])
    expect(await sale()).toEqual({ status: 'completed', refunded: '0.00', stamped: false })
    // The refund day is exactly as it was; today carries the reversal.
    expect(await income()).toEqual(sorted([[days.d0, 'refundCardFees', -2.21], [days.d0, 'registerAndStays', 60], ...before]))
    expect(await close(days.d2)).toBe(62.21)
    expect(await close(days.d0)).toBe(-62.21)
    expect(await query<any>(`SELECT title FROM notifications WHERE landlord_id = $1 AND type = 'stay_refund_failed'`, [f.landlordId]))
      .toEqual([{ title: 'A refund to Jane Doe came back' }])

    const partId = (await getQuote(f, b)).body.data.decision.parts[0].id
    const retry = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(retry.body.data.next, JSON.stringify(retry.body)).toBe('done')
    expect(await saleRefunds()).toEqual([
      { refund_method: 'card', amount: '62.21', stripe_refund_id: 're_1', reversed: true },
      { refund_method: 'card', amount: '62.21', stripe_refund_id: 're_2', reversed: false },
    ])
    expect(await sale()).toEqual({ status: 'partial_refund', refunded: '62.21', stamped: true })
    const today = (await income()).filter((e) => e[0] === days.d0)
    expect(today.filter((e) => e[1] === 'registerAndStays').reduce((a, e) => a + e[2], 0)).toBe(0)
    expect(today.filter((e) => e[1] === 'refundCardFees').reduce((a, e) => a + e[2], 0)).toBe(0)
    expect(await close(days.d2)).toBe(62.21)
    expect(await close(days.d0)).toBe(0)
    expect(await held(f)).toEqual([
      { source_type: 'refund', source_id: 're_1', amount: '-62.21' },
      { source_type: 'refund', source_id: 're_1:failed', amount: '62.21' },
      { source_type: 'refund', source_id: 're_2', amount: '-62.21' },
    ])
  })

  it('a failed card refund can never be paid twice: the register refuses the sale while it waits, and "Give it back in cash instead" records it so Try again sends nothing', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const { saleId } = await paySale(f, b, { method: 'card', toward: 480 })
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.body.data.next).toBe('try_again')
    const partId = out.body.data.decision.parts[0].id
    expect(out.body.data.decision.parts[0].failure)
      .toBe('Stripe could not send this refund just now — press Try again, or hand it back in cash and press "Give it back in cash instead".')
    // The register: nothing on the sale while the card refund waits — said once, pointing to the stay.
    const reg = await request(app()).post(`/api/pos/transactions/${saleId}/refund`).set('Authorization', `Bearer ${f.token}`)
      .send({ amount: 240, refundMethod: 'cash', reason: 'left early' })
    expect(reg.status).toBe(409)
    expect(reg.body.error).toBe('This sale has a $240.00 refund to the card waiting for a guest who left early, so nothing was refunded here. '
      + "Finish that first on the schedule: open the stay's Check out window and press Try again, or Give it back in cash instead.")
    expect(await query(`SELECT 1 FROM pos_refunds WHERE transaction_id = $1`, [saleId])).toHaveLength(0)

    // Only someone who can issue refunds gives it back in cash.
    const desk = await staff(f, { 'guests.check_out': true })
    expect((await request(app()).post(url(f, b, `/parts/${partId}/cash-instead`)).set('Authorization', `Bearer ${desk}`).send({})).status).toBe(403)
    const cash = await request(app()).post(url(f, b, `/parts/${partId}/cash-instead`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(cash.status, JSON.stringify(cash.body)).toBe(200)
    expect(cash.body.data.next).toBe('done')
    expect(cash.body.data.words[0]).toBe('Hand back $240.00 in cash now.')
    expect(cash.body.data.decision.parts).toEqual([expect.objectContaining({ kind: 'cash', status: 'handed_back', amount: 240, words: '$240.00 handed back in cash' })])
    expect(await parts(b)).toEqual([
      expect.objectContaining({ kind: 'card', status: 'replaced', replaces: false }),
      expect.objectContaining({ kind: 'cash', status: 'handed_back', amount: '240.00', drop: '0.00', replaces: true }),
    ])
    expect(await query<any>(`SELECT refund_method, amount::text FROM pos_refunds WHERE transaction_id = $1`, [saleId]))
      .toEqual([{ refund_method: 'cash', amount: '240.00' }])
    // Nothing more to do: no Try again, no to-do; the payout never moved.
    const todos = (await request(app()).get('/api/landlords/me/todos').set('Authorization', `Bearer ${f.token}`)).body.data.stayMoney
    expect(todos).toEqual([])
    const sched = await request(app()).get(`/api/units/schedule/master?from=2026-09-20&to=2026-10-20&propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.token}`)
    expect(sched.body.data.bookings.find((x: any) => x.id === b).refundNeedsRetry).toBe(false)
    expect(await held(f)).toEqual([])
    // A stale Try again, or the same press again: nothing is sent, nothing handed back twice.
    const retry = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(retry.status).toBe(200)
    expect(retry.body.data.words.some((w: string) => /^Hand back/.test(w))).toBe(false)
    const again = await request(app()).post(url(f, b, `/parts/${partId}/cash-instead`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(again.body.data.words.some((w: string) => /^Hand back/.test(w))).toBe(false)
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(await query(`SELECT 1 FROM pos_refunds WHERE transaction_id = $1`, [saleId])).toHaveLength(1)
    // The register can refund what is left on the sale now — never more.
    const over = await request(app()).post(`/api/pos/transactions/${saleId}/refund`).set('Authorization', `Bearer ${f.token}`)
      .send({ amount: 240.01, refundMethod: 'cash' })
    expect(over.status).toBe(400)
    // Income: the stay part comes off once.
    const ev = await incomeEvents({ landlordIds: [f.landlordId], start: '2026-01-01', end: '2027-12-31', basis: 'received' })
    expect(ev.filter((e) => e.amount < 0).map((e) => [e.line, e.amount])).toEqual([['registerAndStays', -240]])
  })

  it('a card refund that has nothing left on its sale is never sent: the money already given back at the register is not sent to the card too', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const { saleId } = await paySale(f, b, { method: 'card', toward: 480 })
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    const partId = out.body.data.decision.parts[0].id
    // As if the register had refunded the sale anyway, written past GAM's own
    // paths (since review r3 the decision holds the sale while it decides, and
    // the register refuses while the card refund waits — see "a register
    // refund and an early check-out on the same sale at the same moment").
    await query(`INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method) VALUES ($1, $2, 300, 'cash')`, [saleId, f.landlordId])
    const retry = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(retry.body.data.next).toBe('try_again')
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(retry.body.data.decision.parts[0].failure).toBe(
      'Nothing was sent to the card: this sale was already refunded at the register, so only $180.00 is left on it. Ask the owner to check what the guest got back before giving anything more.')
    // Cash instead cannot pay it twice either.
    const cash = await request(app()).post(url(f, b, `/parts/${partId}/cash-instead`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(cash.status).toBe(409)
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', status: 'failed' })])
  })

  it('a refund Stripe sent back can be given back in cash: the payout keeps the money it got back, the cash comes from the drawer', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480, fee: 17.35 })
    expect((await decide(f, b, { choice: 'refund_unused' })).status).toBe(200)
    await stripeRefundFailed({ id: 're_1', status: 'failed' })
    const failed = (await getQuote(f, b)).body.data.decision.parts[0]
    const cash = await request(app()).post(url(f, b, `/parts/${failed.id}/cash-instead`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(cash.status, JSON.stringify(cash.body)).toBe(200)
    // The guest gets back what the card refund would have given them, card fee included (#38 Q4).
    expect(cash.body.data.words[0]).toBe('Hand back $248.68 in cash now.')
    expect(await held(f)).toEqual([
      { source_type: 'refund', source_id: 're_1', amount: '-248.68' },
      { source_type: 'refund', source_id: 're_1:failed', amount: '248.68' },
    ])
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
  })

  it('"Give it back in cash instead" on a try whose answer was lost finds the refund at Stripe and hands back nothing', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    h.refundsCreate.mockImplementationOnce(async (p: any) => {
      h.made.push({ id: 're_lost', status: 'succeeded', amount: p.amount, payment_intent: p.payment_intent, metadata: p.metadata })
      throw new Error('socket hang up')
    })
    const out = await decide(f, b, { choice: 'refund_unused' })
    const partId = out.body.data.decision.parts[0].id
    const cash = await request(app()).post(url(f, b, `/parts/${partId}/cash-instead`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(cash.status, JSON.stringify(cash.body)).toBe(200)
    expect(cash.body.data.words[0]).toBe('This refund had already gone to the card after all, so nothing is handed back in cash.')
    expect(cash.body.data.words.some((w: string) => /^Hand back/.test(w))).toBe(false)
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', status: 'refunded', stripe_refund_id: 're_lost' })])
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_lost', amount: '-240.00' }])
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
  })

  it('a legacy destination charge is taken back from the landlord once: reverse_transfer, and no payout line too', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    h.piRetrieve.mockImplementationOnce(async (id: string) => ({ id, transfer_data: { destination: 'acct_1' } }) as any)
    expect((await decide(f, b, { choice: 'refund_unused' })).status).toBe(200)
    expect(h.refundsCreate.mock.calls[0][0]).toMatchObject({ reverse_transfer: true, metadata: expect.objectContaining({ gam_reverse_transfer: '1' }) })
    expect(await held(f)).toEqual([])
    // Sent back: nothing to put back on the payout either.
    await stripeRefundFailed({ id: 're_1', status: 'failed' })
    expect(await held(f)).toEqual([])
  })
})

// ─── The booking PATCH (an API caller other than the window) ──────────────────

describe('the booking PATCH never decides money', () => {
  const patch = (f: F, b: string, body: any) =>
    request(app()).patch(`/api/units/${f.unitId}/bookings/${b}`).set('Authorization', `Bearer ${f.token}`).send(body)

  it('an early check-out there leaves the question waiting, in words; the window then decides it; once a refund went out the check-out cannot be undone', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 480 })
    const out = await patch(f, b, { status: 'checked_out' })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data.moneyDecisionNeeded).toBe(
      'Jane Doe paid $240.00 more than the nights they stayed are worth. What to do with it waits on the stay: open it on the schedule and press Decide the money.')
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'pending', question: 'overpaid' })])
    expect(await parts(b)).toEqual([])

    const done = await decide(f, b, { choice: 'refund_unused' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data.words).toEqual(['Hand back $240.00 in cash now.'])

    const undo = await patch(f, b, { status: 'checked_in' })
    expect(undo.status).toBe(409)
    expect(undo.body.error).toBe('A refund already went to Jane Doe for this early check-out, so the check-out can\'t be undone. Nothing was changed.')
    expect(await row(b)).toMatchObject({ status: 'checked_out', check_out: TODAY })
    const fix = await patch(f, b, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fix.status).toBe(409)
    expect(fix.body.error).toBe('A refund already went to Jane Doe for this early check-out, so the day they left can\'t be changed. Nothing was changed.')
  })

  it('undoing a check-out charged only the nights stayed puts the booked price back with the booked day', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 240 })
    expect((await decide(f, b, { choice: 'nights_only' })).status).toBe(200)
    expect(await row(b)).toMatchObject({ total: '240.00' })
    expect(await owed(b)).toBe(0)
    const undo = await patch(f, b, { status: 'checked_in' })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(await row(b)).toMatchObject({ status: 'checked_in', check_out: '2026-10-06', booked_check_out: '2026-10-06', total: '480.00', balance_paid_at: null })
    expect(await owed(b)).toBe(240)
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'undone', choice: 'nights_only' })])
    // Checking out again asks again.
    expect((await getQuote(f, b)).body.data).toMatchObject({ question: 'owes', decision: null })
  })
})

// ─── A long stay (#38 Q8) ─────────────────────────────────────────────────────

describe('a long stay on a lease', () => {
  /** Sep 1 to Dec 1 at $1,500 a month: September paid in cash, October by card (pi_rent_oct), November billed. */
  async function longStay(f: F) {
    const b = await stay(f, { checkIn: '2026-09-01', checkOut: '2026-12-01', total: 4500, leaseType: 'month_to_month' })
    const c = await db.connect()
    let tenantId = ''
    try { tenantId = await seedTenant(c) } finally { c.release() }
    const leaseId = (await query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, lease_source, source_booking_id)
       VALUES ($1,$2,1500,'fixed_term','active','2026-09-01','2026-12-01','booking_draft',$3) RETURNING id`,
      [f.unitId, f.landlordId, b]))[0].id
    await query(`INSERT INTO lease_tenants (lease_id, tenant_id, role, status) VALUES ($1,$2,'primary','active')`, [leaseId, tenantId])
    const rent = async (due: string, status: string) => (await query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date, settled_at)
       VALUES ($1,$2,$3,$4,'rent',1500,$5,'RENT',$6::date, CASE WHEN $5 = 'settled' THEN $6::timestamptz END) RETURNING id`,
      [f.unitId, tenantId, f.landlordId, leaseId, status, due]))[0].id
    const remit = async (payment: string, method: string, pi: string | null, at: string) => {
      const r = (await query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method,
                                         stripe_payment_intent_id, settled_at, gross_amount, processing_fee_amount)
         VALUES ($1,$2,$3,1500,1500,'settled',$4,$5,$6::timestamptz,1500,0) RETURNING id`,
        [tenantId, leaseId, f.landlordId, method, pi, at]))[0].id
      await query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,1500)`, [r, payment])
    }
    await remit(await rent('2026-09-01', 'settled'), 'cash', null, '2026-09-01T18:00:00Z')
    await remit(await rent('2026-10-01', 'settled'), 'card', 'pi_rent_oct', '2026-10-01T18:00:00Z')
    await rent('2026-11-01', 'pending')
    return { b, leaseId, tenantId }
  }

  it('checking out ends the lease that day; the rent paid past it gets the refund choices and goes back the way it was paid', async () => {
    const f = await seed()
    const { b, leaseId } = await longStay(f)
    const q = (await getQuote(f, b)).body.data
    expect(q.lease).toEqual({ id: leaseId, endsOn: TODAY,
      words: 'Checking Jane Doe out ends their lease on October 2, 2026, the day they left, and their final bill is made. Rent already paid past that day can be refunded next.' })
    expect(q.question).toBe('none')

    const out = await decide(f, b, { choice: null })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data.next).toBe('decide')
    const lease = await query<any>(`SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leases WHERE id = $1`, [leaseId])
    expect(lease[0].end_date).toBe(TODAY)
    expect(await query(`SELECT 1 FROM payments WHERE lease_id = $1 AND due_date = '2026-11-01'`, [leaseId])).toHaveLength(0)
    const fresh = out.body.data.quote
    expect(fresh).toMatchObject({ checkedOut: true, question: 'overpaid', unused: 1451.61 })
    // The newest rent payment first: October's card.
    const unused = fresh.choices.find((c: any) => c.choice === 'refund_unused')
    expect(unused.refund.parts).toEqual([expect.objectContaining({ kind: 'card', amount: 1451.61 })])

    const done = await request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: 'refund_unused', quoteToken: fresh.quoteToken, idempotencyKey: randomUUID() })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(h.refundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: 'pi_rent_oct', amount: 145161 })
    expect(await held(f)).toEqual([{ source_type: 'refund', source_id: 're_1', amount: '-1451.61' }])
    // The paid-ahead money is spent by the refund, on the record.
    const uses = await query<any>(`SELECT source, status, amount::text, refund_part_id IS NOT NULL AS to_refund FROM credit_uses WHERE lease_id = $1`, [leaseId])
    expect(uses).toEqual([{ source: 'refund', status: 'applied', amount: '1451.61', to_refund: true }])
    const left = await query<any>(`SELECT amount_remaining::text FROM lease_prepaid_credits WHERE lease_id = $1`, [leaseId])
    expect(left).toEqual([{ amount_remaining: '0.00' }])
    const ev = await incomeEvents({ landlordIds: [f.landlordId], start: '2026-01-01', end: '2027-12-31', basis: 'received' })
    expect(ev.filter((e) => e.line === 'paidAheadRefunded').map((e) => e.amount)).toEqual([-1451.61])
    // A use's refund target is part of the record: it never moves.
    await expect(query(`UPDATE credit_uses SET refund_part_id = NULL WHERE lease_id = $1`, [leaseId]))
      .rejects.toThrow(/A credit use is a record: only its status moves/)
  })

  it('No refund leaves the money paid ahead on their account; staff without "Issue refunds" leave it for the owner', async () => {
    const f = await seed()
    const { b, leaseId } = await longStay(f)
    const desk = await staff(f, { 'guests.check_out': true })
    const out = await decide(f, b, { choice: null }, desk)
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data.next).toBe('waits')
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'pending', question: 'overpaid', p: '1451.61' })])
    expect(await query(`SELECT 1 FROM notifications WHERE landlord_id = $1 AND type = 'stay_money_decision'`, [f.landlordId])).toHaveLength(1)
    const owner = await decide(f, b, { choice: 'no_refund' })
    expect(owner.status, JSON.stringify(owner.body)).toBe(200)
    expect(await query<any>(`SELECT amount_remaining::text, voided_at IS NULL AS live FROM lease_prepaid_credits WHERE lease_id = $1`, [leaseId]))
      .toEqual([{ amount_remaining: '1451.61', live: true }])
    expect(h.refundsCreate).not.toHaveBeenCalled()
    await settle()
  })
  it('if the lease cannot be ended that day, nobody is told it was: GAM and the owner are told once, and opening the stay ends it', async () => {
    const f = await seed()
    const { b, leaseId } = await longStay(f)
    const end = async () => (await query<any>(`SELECT to_char(end_date, 'YYYY-MM-DD') AS e FROM leases WHERE id = $1`, [leaseId]))[0].e
    h.state.syncFail = 1
    const q0 = (await getQuote(f, b)).body.data
    const key = randomUUID()
    const press = () => request(app()).post(url(f, b)).set('Authorization', `Bearer ${f.token}`)
      .send({ choice: null, quoteToken: q0.quoteToken, idempotencyKey: key })
    const out = await press()
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body.data).toMatchObject({ checkedOut: true, next: 'done', words: [LEASE_NOT_ENDED_WORDS] })
    expect(await row(b)).toMatchObject({ status: 'checked_out', check_out: TODAY })
    expect(await end()).toBe('2026-12-01')
    expect(await query(`SELECT 1 FROM admin_notifications WHERE category = 'stay_checkout_lease_not_ended' AND context->>'booking_id' = $1`, [b])).toHaveLength(1)
    expect(await query<any>(`SELECT title FROM notifications WHERE landlord_id = $1 AND type = 'stay_lease_not_ended'`, [f.landlordId]))
      .toEqual([{ title: "Jane Doe's lease did not end on the day they left — RV 07" }])
    const todos = async () => (await request(app()).get('/api/landlords/me/todos').set('Authorization', `Bearer ${f.token}`)).body.data.stayMoney
    expect((await todos()).map((t: any) => t.type)).toEqual(['stay_lease_not_ended'])

    // The same press again (a lost answer): it tries the lease again and says what is true now.
    const again = await press()
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.data.next).toBe('decide')
    expect(await end()).toBe(TODAY)
    expect(again.body.data.quote).toMatchObject({ checkedOut: true, question: 'overpaid', unused: 1451.61 })
    expect((await todos()).map((t: any) => t.type)).toEqual(['stay_money_decision'])
    expect(await query(`SELECT 1 FROM admin_notifications WHERE category = 'stay_checkout_lease_not_ended'`)).toHaveLength(1)
  })

  it('the schedule opening ends a lease whose end failed, and the paid-ahead money waits for the owner', async () => {
    const f = await seed()
    const { b, leaseId } = await longStay(f)
    h.state.syncFail = 1
    const desk = await staff(f, { 'guests.check_out': true })
    const out = await decide(f, b, { choice: null }, desk)
    expect(out.body.data.words).toEqual([LEASE_NOT_ENDED_WORDS])
    const sched = await request(app()).get(`/api/units/schedule/master?from=2026-09-20&to=2026-12-20&propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${desk}`)
    expect(sched.status, JSON.stringify(sched.body)).toBe(200)
    expect((await query<any>(`SELECT to_char(end_date, 'YYYY-MM-DD') AS e FROM leases WHERE id = $1`, [leaseId]))[0].e).toBe(TODAY)
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'pending', question: 'overpaid', p: '1451.61' })])
    expect(sched.body.data.bookings.find((x: any) => x.id === b)?.moneyDecisionPending).toBe(true)
    await settle()
  })

  it('a card rent payment whose fee the landlord covered: the cost line says how much more the refund costs than they were paid', async () => {
    const f = await seed()
    const { b } = await longStay(f)
    // 10/5: one choice per property — covering covers card and bank alike.
    await query(`INSERT INTO property_allocation_rules (property_id, ach_fee_payer, card_fee_payer) VALUES ($1, 'landlord', 'landlord')`, [f.propertyId])
    const out = await decide(f, b, { choice: null })
    const unused = out.body.data.quote.choices.find((c: any) => c.choice === 'refund_unused')
    const covered = processingFeeFor({ amount: 1500, paymentMethod: 'card' })
    const extra = Math.round(1451.61 * covered / 1500 * 100) / 100
    expect(unused.refund.parts).toEqual([expect.objectContaining({ kind: 'card', amount: 1451.61 })])
    expect(unused.refund.cost).toBe(
      `Stripe keeps its processing fee on a refund, and that is your cost: your next payout drops by $1,451.61 — $${extra.toFixed(2)} more than you were paid for this part of the stay.`)
    await settle()
  })
})

// ─── Review r3 (fix pass 1) ───────────────────────────────────────────────────

describe('money already received is never rewritten (§0.0, #33)', () => {
  it('the day a booking-site deposit arrived stays as it was: with the property covering the card fee, a register refund, then No refund, Keep the price or Charge only the nights stayed', async () => {
    for (const choice of ['no_refund', 'keep_price', 'nights_only'] as const) {
      const f = await seed()
      await query(`UPDATE properties SET booking_card_fee_payer = 'landlord' WHERE id = $1`, [f.propertyId])
      // Overpaid (No refund): Sep 28 to Oct 6, $480. Still owes (the other two): Sep 24 to Oct 10, $960.
      const b = choice === 'no_refund'
        ? await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480, status: 'tentative' })
        : await stay(f, { checkIn: '2026-09-24', checkOut: '2026-10-10', total: 960, status: 'tentative' })
      // A $200 deposit on the booking site, the property covering GAM's card fee (charged $200).
      await query(`UPDATE unit_bookings SET stripe_checkout_session_id = $2, deposit_amount = 200 WHERE id = $1`, [b, `cs_dep_${choice}`])
      await confirmBookingDeposit(b, `cs_dep_${choice}`, { paymentIntentId: `pi_dep_${choice}`, amountTotalCents: 20000 })
      await query(`UPDATE unit_bookings SET status = 'checked_in', deposit_paid_at = '2026-09-29T18:00:00Z' WHERE id = $1`, [b])
      await query(`UPDATE stay_payments SET paid_at = '2026-09-29T18:00:00Z' WHERE booking_id = $1`, [b])
      // $180 cash at the register toward the stay, then $50 of it refunded there.
      const { saleId } = await paySale(f, b, { method: 'cash', toward: 180 })
      await query(`UPDATE unit_bookings SET pos_transaction_id = $2 WHERE id = $1`, [b, saleId])   // as the counter's stay sale names it
      const reg = await request(app()).post(`/api/pos/transactions/${saleId}/refund`).set('Authorization', `Bearer ${f.token}`)
        .send({ amount: 50, refundMethod: 'cash', reason: 'mid-stay' })
      expect(reg.status, JSON.stringify(reg.body)).toBe(200)
      const depositDay = async () => (await incomeEvents({ landlordIds: [f.landlordId], start: '2026-09-01', end: '2026-12-31', basis: 'received' }))
        .filter((e) => e.day === '2026-09-29' && e.line === 'registerAndStays').reduce((a, e) => a + e.amount, 0)
      expect(await depositDay()).toBe(200)
      const out = await decide(f, b, { choice })
      expect(out.status, `${choice}: ${JSON.stringify(out.body)}`).toBe(200)
      // The paid flags were put in step with what is still with the landlord ($330)…
      expect((await query<any>(`SELECT deposit_amount::text AS d FROM unit_bookings WHERE id = $1`, [b]))[0].d, choice).toBe('330.00')
      // …and the day the deposit arrived still reads the $200 that arrived.
      expect(await depositDay(), choice).toBe(200)
    }
  })
})

describe('once a refund went out the check-out cannot be undone (#38 Q11), even at the same moment', () => {
  const patch = (f: F, b: string, body: any) =>
    request(app()).patch(`/api/units/${f.unitId}/bookings/${b}`).set('Authorization', `Bearer ${f.token}`).send(body)

  it('a refund decided right after another person\'s save looked: the save is refused inside its transaction, in the same words, and nothing is undone', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    // Checked out with the money left waiting; then the refund is decided.
    expect((await patch(f, b, { status: 'checked_out' })).status).toBe(200)
    expect((await decide(f, b, { choice: 'refund_unused' })).status).toBe(200)
    // The other person's save had looked before that refund.
    h.state.staleRefusal = 1
    const undo = await patch(f, b, { status: 'checked_in' })
    expect(undo.status).toBe(409)
    expect(undo.body.error).toBe('A refund already went to Jane Doe for this early check-out, so the check-out can\'t be undone. Nothing was changed.')
    expect(h.state.staleRefusal).toBe(0)
    expect(await row(b)).toMatchObject({ status: 'checked_out', check_out: TODAY })
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'decided', choice: 'refund_unused' })])
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', status: 'refunded' })])

    // A new length set on the checked-out stay at that same moment: refused too.
    h.state.staleRefusal = 1
    const redate = await patch(f, b, { checkOut: '2026-10-05' })
    expect(redate.status).toBe(409)
    expect(redate.body.error).toBe('A refund already went to Jane Doe for this early check-out, so the stay\'s dates can\'t be changed. Nothing was changed.')
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'decided' })])
  })

  it('a stay charged only the nights stayed right after a correction looked: the day they left is not corrected', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'cash', toward: 120 })
    expect((await decide(f, b, { choice: 'nights_only' })).status).toBe(200)
    h.state.staleRefusal = 1
    const fix = await patch(f, b, { status: 'checked_out', checkOut: '2026-10-01' })
    expect(fix.status).toBe(409)
    expect(fix.body.error).toBe('Jane Doe\'s stay was already charged only the nights they stayed, so the day they left can\'t be changed here. '
      + 'Put the check-out back first (set the status back), then check them out again on the right day.')
    expect(await row(b)).toMatchObject({ status: 'checked_out', check_out: TODAY, total: '240.00' })
    expect(await decisions(b)).toEqual([expect.objectContaining({ status: 'decided', choice: 'nights_only' })])
  })
})

describe('a register refund and an early check-out on the same sale at the same moment', () => {
  it('a register refund committing while the check-out is decided is waited for and seen: the press is refused with the fresh numbers, and nothing is sent past what the sale has left', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    const { saleId } = await paySale(f, b, { method: 'card', toward: 480 })
    const q = (await getQuote(f, b)).body.data
    expect(q).toMatchObject({ paid: 480, question: 'overpaid', unused: 240 })
    // The register is refunding $300 of the sale right now (it holds the sale).
    const register = await db.connect()
    try {
      await register.query('BEGIN')
      await register.query(`SELECT 1 FROM pos_transactions WHERE id = $1 FOR UPDATE`, [saleId])
      await register.query(`INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method) VALUES ($1, $2, 300, 'cash')`, [saleId, f.landlordId])
      const pressing = decide(f, b, { choice: 'refund_unused', quoteToken: q.quoteToken })
      await new Promise((r) => setTimeout(r, 300))
      await register.query('COMMIT')
      const out = await pressing
      expect(out.status, JSON.stringify(out.body)).toBe(409)
      expect(out.body.code).toBe('checkout_changed')
      // $480 paid, $300 back at the register: $180 — less than the nights stayed ($240).
      expect(out.body.data).toMatchObject({ paid: 180, question: 'owes', maxRefund: 0 })
    } finally { register.release() }
    expect(h.refundsCreate).not.toHaveBeenCalled()
    expect(await parts(b)).toEqual([])
    expect(await decisions(b)).toEqual([])
    expect(await row(b)).toMatchObject({ status: 'checked_in' })
  })
})

describe('a refund Stripe says failed before GAM recorded it is never lost', () => {
  it('said while the refund is still being sent: answered "send it again", and once recorded it is reversed for Try again', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    let open!: () => void
    h.state.gate = new Promise<void>((r) => { open = r })
    const pressing = decide(f, b, { choice: 'refund_unused' })
    // The refund is out at Stripe; GAM has not recorded it yet.
    let partId = ''
    for (let i = 0; i < 50 && !partId; i++) {
      await new Promise((r) => setTimeout(r, 50))
      partId = (await query<{ id: string }>(`SELECT id FROM stay_refund_parts WHERE booking_id = $1`, [b]))[0]?.id ?? ''
    }
    expect(partId).not.toBe('')
    await new Promise((r) => setTimeout(r, 100))
    const early = { id: 're_1', status: 'failed', metadata: { gam_purpose: 'stay_early_checkout_refund', gam_stay_refund_part_id: partId } }
    expect(await stripeRefundFailed(early)).toBe('retry')
    h.state.gate = null
    open()
    expect((await pressing).status).toBe(200)
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', status: 'refunded', stripe_refund_id: 're_1' })])
    // Stripe sends it again: now it is reversed, and a new part waits for Try again.
    expect(await stripeRefundFailed(early)).toBe(true)
    expect(await parts(b)).toEqual([
      expect.objectContaining({ kind: 'card', status: 'refunded', reversed: true, stripe_refund_id: 're_1' }),
      expect.objectContaining({ kind: 'card', status: 'failed', replaces: true, amount: '240.00' }),
    ])
    expect(await held(f)).toEqual([
      { source_type: 'refund', source_id: 're_1', amount: '-240.00' },
      { source_type: 'refund', source_id: 're_1:failed', amount: '240.00' },
    ])
    const told = await query<any>(`SELECT title FROM notifications WHERE landlord_id = $1 AND type = 'stay_refund_failed'`, [f.landlordId])
    expect(told).toEqual([{ title: 'A refund to Jane Doe came back' }])
  })

  it('said after a refund the card company turned down at once: nothing more to put back — the part waits for Try again and the owner was told once', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    h.state.declineNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.body.data.next).toBe('try_again')
    const partId = out.body.data.decision.parts[0].id
    expect(await stripeRefundFailed({ id: 're_1', status: 'failed',
      metadata: { gam_purpose: 'stay_early_checkout_refund', gam_stay_refund_part_id: partId } })).toBe(true)
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', status: 'failed', stripe_refund_id: null, replaces: false })])
    expect(await held(f)).toEqual([])
    expect(await query(`SELECT 1 FROM notifications WHERE landlord_id = $1 AND type = 'stay_refund_failed'`, [f.landlordId])).toHaveLength(1)
    // A refund tagged for a part GAM never had is not ours.
    expect(await stripeRefundFailed({ id: 're_x', status: 'failed', metadata: { gam_stay_refund_part_id: randomUUID() } })).toBe(false)
  })
})

describe('Try again while someone else holds the refund for a moment', () => {
  const holdPart = async (partId: string) => {
    const c = await db.connect()
    await c.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`stay-refund-part:${partId}`])
    return { release: async () => { await c.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stay-refund-part:${partId}`]); c.release() } }
  }

  it('a late Stripe answer holding the part for a moment: Try again waits for it and sends the refund exactly once', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.body.data.next).toBe('try_again')
    const partId = out.body.data.decision.parts[0].id
    const held = await holdPart(partId)
    setTimeout(() => { held.release() }, 300)
    const retry = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(retry.status, JSON.stringify(retry.body)).toBe(200)
    expect(retry.body.data.next).toBe('done')
    expect(retry.body.data.words.join(' ')).not.toContain('another request')
    expect(h.refundsCreate).toHaveBeenCalledTimes(2)
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', status: 'refunded' })])
  })

  it('held the whole time: Try again sends nothing and says so once, with the next step — pressed again later it sends once', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    const partId = out.body.data.decision.parts[0].id
    const held = await holdPart(partId)
    let retry: any
    try {
      retry = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    } finally { await held.release() }
    expect(retry.status, JSON.stringify(retry.body)).toBe(200)
    expect(retry.body.data.next).toBe('try_again')
    const busy = 'This refund was being worked on by another request at that same moment, so it was not sent again. Wait a moment, then press Try again.'
    expect(retry.body.data.words[0]).toBe(busy)
    expect(retry.body.data.words.filter((w: string) => w === busy)).toHaveLength(1)
    expect(h.refundsCreate).toHaveBeenCalledTimes(1)
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', status: 'failed' })])
    const again = await request(app()).post(url(f, b, `/parts/${partId}/retry`)).set('Authorization', `Bearer ${f.token}`).send({})
    expect(again.body.data.next).toBe('done')
    expect(again.body.data.words.join(' ')).not.toContain('another request')
    expect(h.refundsCreate).toHaveBeenCalledTimes(2)
  }, 15000)
})

describe('the end-of-day close', () => {
  it('cash handed back instead of a booking-site deposit card refund comes out of the drawer on the day it was handed back', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480, status: 'tentative' })
    await query(`UPDATE unit_bookings SET stripe_checkout_session_id = 'cs_dep', deposit_amount = 300 WHERE id = $1`, [b])
    await confirmBookingDeposit(b, 'cs_dep', { paymentIntentId: 'pi_dep', amountTotalCents: 31105 })
    await query(`UPDATE unit_bookings SET status = 'checked_in' WHERE id = $1`, [b])
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    expect(out.body.data.next).toBe('try_again')
    const cash = await request(app()).post(url(f, b, `/parts/${out.body.data.decision.parts[0].id}/cash-instead`))
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(cash.status, JSON.stringify(cash.body)).toBe(200)
    // $60 unused plus the card fee the guest paid on it, handed back at the desk.
    const handed = (await query<any>(
      `SELECT amount::float AS amount, to_char(refunded_at AT TIME ZONE 'America/Phoenix', 'YYYY-MM-DD') AS day
         FROM stay_refund_parts WHERE booking_id = $1 AND kind = 'cash'`, [b]))[0]
    expect(handed.amount).toBe(Math.round((60 + 60 * 11.05 / 300) * 100) / 100)
    expect(await query(`SELECT 1 FROM pos_refunds`)).toHaveLength(0)
    const eod = await generateEodSettlement(f.landlordId, f.propertyId, handed.day)
    expect(eod).toMatchObject({ cashRefunds: handed.amount, cardRefunds: 0, drawerExpected: -handed.amount })
    // Another property's close does not see it.
    const other = await query<{ id: string }>(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip, owner_user_id, managed_by_user_id)
       SELECT landlord_id, 'Other', street1, city, state, zip, owner_user_id, managed_by_user_id FROM properties WHERE id = $1 RETURNING id`,
      [f.propertyId]).catch(() => null)
    if (other?.[0]) expect((await generateEodSettlement(f.landlordId, other[0].id, handed.day)).cashRefunds).toBe(0)
  })

  it('a day whose only drawer activity is cash handed back at an early check-out still closes on its own, and that cash counts as a refund', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480, status: 'tentative' })
    await query(`UPDATE unit_bookings SET stripe_checkout_session_id = 'cs_dep', deposit_amount = 300 WHERE id = $1`, [b])
    await confirmBookingDeposit(b, 'cs_dep', { paymentIntentId: 'pi_dep', amountTotalCents: 31105 })
    await query(`UPDATE unit_bookings SET status = 'checked_in' WHERE id = $1`, [b])
    h.state.failNext = 1
    const out = await decide(f, b, { choice: 'refund_unused' })
    const cash = await request(app()).post(url(f, b, `/parts/${out.body.data.decision.parts[0].id}/cash-instead`))
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(cash.status, JSON.stringify(cash.body)).toBe(200)
    const handed = (await query<any>(
      `SELECT amount::float AS amount, to_char(refunded_at AT TIME ZONE 'America/Phoenix', 'YYYY-MM-DD') AS day
         FROM stay_refund_parts WHERE booking_id = $1 AND kind = 'cash'`, [b]))[0]
    // No register sale and no register refund that day: only the cash handed back.
    expect(await query(`SELECT 1 FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])).toHaveLength(0)
    expect(await query(`SELECT 1 FROM pos_refunds`)).toHaveLength(0)
    const closed = await generateEodForAllActiveLandlords(handed.day)
    expect(closed).toEqual([expect.objectContaining({
      landlordId: f.landlordId, propertyId: f.propertyId, cashRefunds: handed.amount, refundCount: 1, drawerExpected: -handed.amount })])
    // The day before closes nothing for it.
    const before = new Date(`${handed.day}T12:00:00Z`); before.setUTCDate(before.getUTCDate() - 1)
    expect(await generateEodForAllActiveLandlords(before.toISOString().slice(0, 10))).toEqual([])
  })
})

describe('the database connections a refund uses', () => {
  it('a card refund gives back every connection it took: none is left checked out once it is recorded', async () => {
    const f = await seed()
    const b = await stay(f, { checkIn: '2026-09-28', checkOut: '2026-10-06', total: 480 })
    await paySale(f, b, { method: 'card', toward: 480 })
    await settle()
    const inUse = () => (db as any).totalCount - (db as any).idleCount
    const before = inUse()
    expect((await decide(f, b, { choice: 'refund_unused' })).status).toBe(200)
    expect(await parts(b)).toEqual([expect.objectContaining({ kind: 'card', status: 'refunded' })])
    await settle()
    expect(inUse()).toBe(before)
  })
})

describe('one list of refund part statuses', () => {
  it('STAY_REFUND_PART_STATUSES is exactly what the database allows', async () => {
    const def = (await query<{ d: string }>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'stay_refund_parts_status_check'`))[0].d
    const allowed = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()
    expect(allowed).toEqual([...STAY_REFUND_PART_STATUSES].sort())
  })
})

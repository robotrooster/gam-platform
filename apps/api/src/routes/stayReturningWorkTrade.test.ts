/**
 * 10/6 (Nic) — RETURNING GUESTS AND WORK TRADE ON A STAY.
 *
 *   "I need a way when I'm manually adding a reservation by hand to confirm
 *    that that person's been here before... I need to verify that the system
 *    is not going to try to do a background check on them."
 *
 *   "Can I mark somebody as work trade through the reservation flow? Hey,
 *    they're going to be staying for two months. Mark them as work trade. Boom."
 *
 * A. "Returning guest — they've stayed with us before" on every landlord-side
 *    door that makes or lengthens a stay needing screening: no fee, no check
 *    link, check-in never waits; the attestation is on the stay (who, when);
 *    the SAME rolling-year allowance invites use, one count per person per
 *    property per year; refused when used up; owner / managers only; never on
 *    the booking site; later legs inherit it.
 * B. Work trade on a stay: everything covered by default, trusted/monitored,
 *    hours per the property; follows the stay; site charge $0; covered
 *    utilities not billed; the space still counts for GAM's fee; 22+ still
 *    screens unless returning; a lease drafted from it carries the trade.
 *
 * Stripe, the pay links the schedule hands to, and the emails are mocked.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  screeningMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  utilityInviteMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  depositLinkMock: vi.fn(async (..._a: any[]) => ({ id: 'link-deposit', url: 'https://pay.test/deposit' })),
  feeLinkMock: vi.fn(async (..._a: any[]) => ({ id: 'link-fee', url: 'https://pay.test/fee' })),
  checkoutMock: vi.fn(async (_p: any) => ({ id: `cs_test_${Math.random().toString(36).slice(2)}`, url: 'https://checkout.stripe.test/x' })),
  emailPayLinkMock: vi.fn(async (..._a: any[]) => undefined),
  receiptMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  wtInviteMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailBackgroundCheckScreeningRequest: h.screeningMock,
  emailUtilityServiceInvite: h.utilityInviteMock,
  emailPayLink: h.emailPayLinkMock,
  emailPosReceipt: h.receiptMock,
  emailStayWorkTradeInvite: h.wtInviteMock,
}))
vi.mock('./posPayLinks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createBookingDepositLink: h.depositLinkMock,
  createScreeningFeeLink: h.feeLinkMock,
}))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ checkout: { sessions: { create: h.checkoutMock, retrieve: async (id: string) => ({ id, status: 'expired', payment_status: 'unpaid' }), expire: async () => undefined } } }),
}))
vi.mock('../services/stripeConnect', async (orig) => ({ ...(await orig() as any), expirePayLinkCheckoutSession: vi.fn(async () => undefined) }))
vi.mock('../services/posCustomerCards', async (orig) => ({ ...(await orig() as any), readSaleCard: vi.fn(async () => null) }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { WORK_TRADE_COVERABLE } from '@gam/shared'
import { db, getClient, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedTenant, seedUtilityMeter } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'
import { errorHandler } from '../middleware/errorHandler'
import { unitsRouter } from './units'
import { posRouter } from './pos'
import { posPayLinksRouter } from './posPayLinks'
import { publicPropertyBookingRouter } from './publicPropertyBooking'
import { workTradeRouter } from './workTrade'
import { clearUnpaidHolds, notifyDisplacedHolds } from '../services/holdDisplacement'
import { relocateBlockingBookings } from '../services/scheduleCompression'
import { stayNeeds, checkInBlock, syncStayUtilityAgreement, RETURNING_GUEST_NOT_ALLOWED, draftLeaseFromStay } from '../services/stayTerms'
import {
  applyReturningResidentWaive, returningResidentAllowance, RETURNING_ALLOWANCE_USED_MESSAGE,
} from '../services/onboardingWindow'
import { syncStayWorkTrade } from '../services/stayWorkTrade'
import { generateBillsForMeter } from '../services/utilityBilling'
import { generateServiceAgreementInvoices } from '../jobs/serviceAgreementInvoices'
import { billableUnitsForProperty } from '../services/billableUnits'
import { screeningIntakeFee } from './background'

function app() {
  const a = express()
  a.use(express.json({ limit: '2mb' }))
  a.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  a.use('/api/units', unitsRouter)
  a.use('/api/pos/pay-links', posPayLinksRouter)
  a.use('/api/pos', posRouter)
  a.use('/api/public', publicPropertyBookingRouter)
  a.use('/api/work-trade', workTradeRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  for (const m of Object.values(h)) m.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_returning_work_trade'
})

interface Fx {
  userId: string; landlordId: string; propertyId: string; unitId: string; unit2Id: string
  token: string; month: string; state: string | null; slug: string
}

/** One park, two RV sites (so the returning allowance is 1: 25% of 2, rounded up). */
async function seed(): Promise<Fx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const slug = `returning-rv-${randomUUID().slice(0, 6)}`
    await c.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_rw_' || replace($1::text,'-','') WHERE id = $1`, [landlordId])
    await c.query(
      `UPDATE properties SET work_trade_hours_target = 40, booking_monthly_deposit = 150,
              public_booking_enabled = TRUE, booking_slug = $2, booking_deposit_pct = 20
        WHERE id = $1`, [propertyId, slug])
    const sites: string[] = []
    for (const n of ['RV 07', 'RV 08']) {
      sites.push((await c.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, weekly_rate, monthly_rate, is_bookable, lease_types_allowed)
         VALUES ($1,$2,$3,'vacant',1500,'rv_spot',60,350,1500,TRUE,'{}') RETURNING id`,
        [propertyId, landlordId, n])).rows[0].id)
    }
    const cat = (await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stays',1,TRUE) RETURNING id`,
      [landlordId])).rows[0].id
    let month = ''
    for (const [name, unit] of [['RV site — weekly', 'week'], ['RV site — monthly', 'month']]) {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate,
                                stock_qty, stock_min, stock_max, stay_unit)
         VALUES ($1,$2,$3,$4,0,0,0,999,0,999,$5) RETURNING id`, [landlordId, propertyId, name, cat, unit])).rows[0].id
      if (unit === 'month') month = id
    }
    const state = (await c.query<{ state: string | null }>(`SELECT state FROM properties WHERE id = $1`, [propertyId])).rows[0].state
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId: sites[0], unit2Id: sites[1], token, month, state, slug }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A front-desk login at the park: may create reservations, may not invite tenants. */
async function deskToken(f: Fx, perms: Record<string, boolean> = {}): Promise<string> {
  const desk = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'onsite_manager', 'Front', 'Desk', TRUE) RETURNING id`, [`desk-${randomUUID().slice(0, 8)}@t.dev`])).rows[0].id
  await db.query(
    `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties) VALUES ($1, $2, $3, false)`,
    [desk, f.landlordId, [f.propertyId]])
  return jwt.sign({ userId: desk, role: 'onsite_manager', email: 'd@t.dev', profileId: desk, landlordId: f.landlordId,
    permissions: { 'schedule.create_reservation': true, 'schedule.edit_reservation': true, ...perms } },
  process.env.JWT_SECRET!, { expiresIn: '1h' })
}

async function guest(): Promise<{ tenantId: string; userId: string; email: string }> {
  const email = `guest-${randomUUID().slice(0, 8)}@t.dev`
  const c = await db.connect()
  try {
    const tenantId = await seedTenant(c, { email })
    const { rows: [t] } = await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])
    return { tenantId, userId: t.user_id, email }
  } finally { c.release() }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const create = (f: Fx, body: Record<string, unknown>, o: { unitId?: string; token?: string } = {}) =>
  request(app()).post(`/api/units/${o.unitId ?? f.unitId}/bookings`).set(auth(o.token ?? f.token))
    .send({ guestName: 'Pat Ruiz', guestPhone: '555-0100', leaseType: 'weekly', ...body })
const patch = (f: Fx, id: string, body: Record<string, unknown>, o: { unitId?: string; token?: string } = {}) =>
  request(app()).patch(`/api/units/${o.unitId ?? f.unitId}/bookings/${id}`).set(auth(o.token ?? f.token)).send(body)
const row = async (id: string) => (await db.query(
  `SELECT status, unit_id, to_char(check_in, 'YYYY-MM-DD') AS check_in, to_char(check_out, 'YYYY-MM-DD') AS check_out,
          total_amount::float AS total, screening_required, returning_guest_at, returning_guest_by, stay_terms
     FROM unit_bookings WHERE id = $1`, [id])).rows[0]
const tradeOf = async (bookingId: string) => (await db.query(
  `SELECT id, status, unit_id, tenant_id, booking_id, to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date, covered_charges, trusted, tracks_hours, monthly_hours_target
     FROM work_trade_agreements WHERE booking_id = $1`, [bookingId])).rows[0]
const feeFor = async (state: string | null) => {
  const i = await screeningIntakeFee(state)
  return Math.round((i.screening + i.gamFee + i.tax) * 100) / 100
}
const day = async (offset: number): Promise<string> =>
  (await db.query<{ d: string }>(`SELECT (CURRENT_DATE + $1::int)::text AS d`, [offset])).rows[0].d

// 25 nights: needs a background check, not a lease-or-stay answer.
const LONG = { checkIn: '2027-03-01', checkOut: '2027-03-26' }

// ── A. RETURNING GUEST ───────────────────────────────────────────────────────
describe('returning guest on the new-reservation form', () => {
  it('skips screening: no fee, no check link, confirmed straight on, check-in not blocked — the attestation on the stay', async () => {
    const f = await seed()
    const g = await guest()
    const r = await create(f, { guestEmail: g.email, ...LONG, returningGuest: true })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data).toMatchObject({ status: 'confirmed', depositLink: null, registerTicketId: null })
    expect(r.body.data.stay).toMatchObject({ screening: 'returning', screeningFee: null, returningGuest: true })
    expect(h.depositLinkMock).not.toHaveBeenCalled()
    expect(h.feeLinkMock).not.toHaveBeenCalled()
    expect(h.screeningMock).not.toHaveBeenCalled()
    const b = await row(r.body.data.id)
    expect(b.returning_guest_at).toBeTruthy()
    expect(b.returning_guest_by).toBe(f.userId)
    expect(b.screening_required).toBe(false)
    expect(await query('SELECT 1 FROM screening_prepayments')).toHaveLength(0)
    expect(await checkInBlock(r.body.data.id)).toBeNull()
    const inn = await patch(f, r.body.data.id, { status: 'checked_in' })
    expect(inn.status, JSON.stringify(inn.body)).toBe(200)
  })

  it('without it, the check-fee question offers it as the third choice', async () => {
    const f = await seed()
    const g = await guest()
    const r = await create(f, { guestEmail: g.email, ...LONG })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'screening_fee_route_needed', returning: { available: true, free: false, message: null } })
  })

  it('counts against the property\'s allowance; refused when used up (greyed with the words, never the count); the same person again that year is free', async () => {
    const f = await seed()
    const a = await guest()
    const b = await guest()
    expect((await returningResidentAllowance(f.propertyId))).toMatchObject({ used: 0, allowance: 1 })
    expect((await create(f, { guestEmail: a.email, ...LONG, returningGuest: true })).status).toBe(201)
    expect((await returningResidentAllowance(f.propertyId))).toMatchObject({ used: 1, left: 0 })

    // someone else: the choice is greyed, and sending it anyway is refused — nothing written
    const asked = await create(f, { guestEmail: b.email, ...LONG }, { unitId: f.unit2Id })
    expect(asked.body.returning).toEqual({ available: false, free: false, message: RETURNING_ALLOWANCE_USED_MESSAGE })
    expect(JSON.stringify(asked.body)).not.toMatch(/"used"|"allowance"|"left"/)
    const refused = await create(f, { guestEmail: b.email, ...LONG, returningGuest: true }, { unitId: f.unit2Id })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(RETURNING_ALLOWANCE_USED_MESSAGE)
    expect(await query(`SELECT 1 FROM unit_bookings WHERE lower(guest_email) = $1`, [b.email])).toHaveLength(0)

    // the first guest, back in the autumn: free, no new count
    const again = await create(f, { guestEmail: a.email, checkIn: '2027-09-01', checkOut: '2027-09-26', returningGuest: true })
    expect(again.status, JSON.stringify(again.body)).toBe(201)
    expect((await returningResidentAllowance(f.propertyId)).used).toBe(1)
  })

  it('one allowance with invites: a reservation\'s guest invited back is free; an invite\'s returning resident fills it for the next guest', async () => {
    const f = await seed()
    const a = await guest()
    expect((await create(f, { guestEmail: a.email, ...LONG, returningGuest: true })).status).toBe(201)
    // an invite for the same person is free even with the allowance used
    await expect(applyReturningResidentWaive({ tenantId: a.tenantId, landlordId: f.landlordId, propertyId: f.propertyId, unitId: f.unit2Id, byUserId: f.userId }))
      .resolves.toMatchObject({ waived: true, used: 1, allowance: 1 })
    expect((await returningResidentAllowance(f.propertyId)).used).toBe(1)

    // a fresh park: an invite's returning resident uses the allowance → a reservation is refused
    const f2 = await seed()
    const c = await guest()
    await applyReturningResidentWaive({ tenantId: c.tenantId, landlordId: f2.landlordId, propertyId: f2.propertyId, unitId: f2.unit2Id, byUserId: f2.userId })
    const d = await guest()
    const r = await create(f2, { guestEmail: d.email, ...LONG, returningGuest: true })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe(RETURNING_ALLOWANCE_USED_MESSAGE)
  })

  it('front-desk staff without the invite permission never see it and are refused it; with it, they may', async () => {
    const f = await seed()
    const g = await guest()
    const desk = await deskToken(f)
    const asked = await create(f, { guestEmail: g.email, ...LONG }, { token: desk })
    expect(asked.status).toBe(409)
    expect(asked.body.returning).toBeNull()
    const refused = await create(f, { guestEmail: g.email, ...LONG, returningGuest: true }, { token: desk })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe(RETURNING_GUEST_NOT_ALLOWED)
    expect(await query('SELECT 1 FROM unit_bookings')).toHaveLength(0)
    const manager = await deskToken(f, { 'tenants.invite': true })
    expect((await create(f, { guestEmail: g.email, ...LONG, returningGuest: true }, { token: manager })).status).toBe(201)
  })

  it('on a reservation edit: an existing long stay waiting on screening is marked returning and checks in', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, ...LONG, payAtRegister: true })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data.id
    await db.query(`UPDATE unit_bookings SET status = 'confirmed' WHERE id = $1`, [id])
    expect((await row(id)).screening_required).toBe(true)
    expect((await patch(f, id, { status: 'checked_in' })).status).toBe(409)
    const marked = await patch(f, id, { returningGuest: true })
    expect(marked.status, JSON.stringify(marked.body)).toBe(200)
    expect(await row(id)).toMatchObject({ screening_required: false })
    expect((await row(id)).returning_guest_at).toBeTruthy()
    expect((await patch(f, id, { status: 'checked_in' })).status).toBe(200)
  })

  it('a lengthening edit (drag to 25 nights) with it asks for no fee and sends no link', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, checkIn: '2027-03-01', checkOut: '2027-03-08' })
    expect(made.status).toBe(201)
    const r = await patch(f, made.body.data.id, { checkOut: '2027-03-26', returningGuest: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.stay).toMatchObject({ screening: 'returning', screeningFee: null, screeningFeeLink: null })
    expect(h.feeLinkMock).not.toHaveBeenCalled()
    expect(await checkInBlock(made.body.data.id)).toBeNull()
  })

  it('Add a month: the quote offers it; with it, no fee goes on the ticket, and the stay is marked', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, checkIn: '2027-03-01', checkOut: '2027-03-08' })
    const id = made.body.data.id
    await db.query(`UPDATE unit_bookings SET deposit_paid_at = NOW(), balance_billed_at = NOW(), balance_paid_at = NOW() WHERE id = $1`, [id])
    const q = await request(app()).get(`/api/units/${f.unitId}/bookings/${id}/add-month`).set(auth(f.token))
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toMatchObject({ screening: 'fee_due', returning: { available: true } })
    const r = await request(app()).post(`/api/units/${f.unitId}/bookings/${id}/add-month`).set(auth(f.token))
      .send({ stayTerms: 'stay', returningGuest: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.addedMonth).toMatchObject({ screening: 'returning', screeningFee: null })
    const t = (await query<any>(`SELECT items FROM pos_open_tickets WHERE booking_id = $1`, [id]))[0]
    expect((t.items as any[]).some((i) => i.screening)).toBe(false)
    expect((await row(id)).returning_guest_at).toBeTruthy()
    expect((await row(id)).screening_required).toBe(false)
  })

  it('later legs inherit it: a back-to-back stay of the same guest needs no check', async () => {
    const f = await seed()
    const g = await guest()
    const first = await create(f, { guestEmail: g.email, ...LONG, returningGuest: true })
    expect(first.status).toBe(201)
    const n = await stayNeeds({ landlordId: f.landlordId, propertyId: f.propertyId, email: g.email, checkIn: '2027-03-26', checkOut: '2027-04-02' })
    expect(n.screening).toBe('returning')
    const next = await create(f, { guestEmail: g.email, checkIn: '2027-03-26', checkOut: '2027-04-02', stayTerms: 'stay' })
    expect(next.status, JSON.stringify(next.body)).toBe(201)
    expect(next.body.data.stay.screening).toBe('returning')
    expect(await checkInBlock(next.body.data.id)).toBeNull()
  })
})

describe('returning guest at the register and on a pay link', () => {
  const monthLine = (f: Fx, extra: any = {}) => ({ id: f.month, name: 'RV site — monthly', qty: 1, price: 1500, tax: 0, ...extra })

  it('the register quote drops the fee; the sale records the attestation and nothing for screening', async () => {
    const f = await seed()
    const g = await guest()
    const quote = await request(app()).post('/api/pos/stays/quote').set(auth(f.token)).send({
      propertyId: f.propertyId, itemId: f.month, qty: 1, unitId: f.unitId, checkIn: '2027-06-01', guestEmail: g.email, stayTerms: 'stay',
    })
    expect(quote.body.data).toMatchObject({ screening: 'fee_due', returning: { available: true } })
    const withIt = await request(app()).post('/api/pos/stays/quote').set(auth(f.token)).send({
      propertyId: f.propertyId, itemId: f.month, qty: 1, unitId: f.unitId, checkIn: '2027-06-01', guestEmail: g.email, stayTerms: 'stay', returningGuest: true,
    })
    expect(withIt.body.data).toMatchObject({ screening: 'returning', screeningFee: null, returningGuest: true })

    const stay = { unitId: f.unitId, checkIn: '2027-06-01', guestName: 'Dale Carter', guestEmail: g.email, stayTerms: 'stay', returningGuest: true }
    const sale = await request(app()).post('/api/pos/transactions').set(auth(f.token)).send({
      propertyId: f.propertyId, paymentMethod: 'cash', stay,
      items: [monthLine(f, { stayUnitId: f.unitId, stayCheckIn: '2027-06-01' })],
    })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    const b = (await query<any>(`SELECT id, screening_required, returning_guest_at, returning_guest_by FROM unit_bookings`))[0]
    expect(b).toMatchObject({ screening_required: false, returning_guest_by: f.userId })
    expect(b.returning_guest_at).toBeTruthy()
    expect(await query('SELECT 1 FROM screening_prepayments')).toHaveLength(0)
    expect(await checkInBlock(b.id)).toBeNull()
  })

  it('a desk without the permission is refused it at the register', async () => {
    const f = await seed()
    const g = await guest()
    const desk = await deskToken(f, { 'pos.ring_sale': true })
    const r = await request(app()).post('/api/pos/stays/quote').set(auth(desk)).send({
      propertyId: f.propertyId, itemId: f.month, qty: 1, unitId: f.unitId, checkIn: '2027-06-01', guestEmail: g.email, stayTerms: 'stay', returningGuest: true,
    })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe(RETURNING_GUEST_NOT_ALLOWED)
  })

  it('a pay link carries no background-check line, and the held stay is marked returning', async () => {
    const f = await seed()
    const g = await guest()
    const sent = await request(app()).post('/api/pos/pay-links').set(auth(f.token)).send({
      propertyId: f.propertyId, kind: 'one_time', customer: { name: 'Dale Carter', email: g.email },
      items: [monthLine(f)],
      stay: { unitId: f.unitId, checkIn: '2027-06-01', guestName: 'Dale Carter', guestEmail: g.email, stayTerms: 'stay', returningGuest: true },
    })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const link = (await query<any>(`SELECT items, booking_id FROM pos_pay_links WHERE id = $1`, [sent.body.data.id]))[0]
    expect((link.items as any[]).some((i) => i.screening)).toBe(false)
    expect(await row(link.booking_id)).toMatchObject({ screening_required: false })
    expect((await row(link.booking_id)).returning_guest_at).toBeTruthy()
  })
})

describe('the booking site never offers it', () => {
  it('a 25-night quote online carries the check\'s fee and no returning choice, whatever is sent', async () => {
    const f = await seed()
    await db.query(`UPDATE units SET lease_types_allowed = ARRAY['nightly','weekly'] WHERE property_id = $1`, [f.propertyId])
    const fee = await feeFor(f.state)
    const res = await request(app())
      .get(`/api/public/property/${f.slug}/availability?checkIn=2027-03-01&checkOut=2027-03-26&returningGuest=true`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const t = res.body.data.siteTypes[0]
    expect(t, JSON.stringify(res.body)).toBeTruthy()
    expect(t.screeningFee).toBe(fee)
    expect(JSON.stringify(res.body)).not.toMatch(/returning/i)
  })
})

// ── B. WORK TRADE ON A STAY ──────────────────────────────────────────────────
describe('work trade on the new-reservation form', () => {
  // 60 nights, answered "stay" (no lease), returning so the check is not in the way.
  const TWO_MONTHS = { checkIn: '2027-03-01', checkOut: '2027-04-30', leaseType: 'month_to_month', stayTerms: 'stay' }

  it('"Mark them as work trade. Boom.": covers everything by default, monitored, the property\'s hours — site charge $0, confirmed directly', async () => {
    const f = await seed()
    const g = await guest()
    const r = await create(f, { guestEmail: g.email, ...TWO_MONTHS, returningGuest: true, workTrade: {} })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data).toMatchObject({ status: 'confirmed', depositLink: null, registerTicketId: null })
    expect(Number(r.body.data.totalAmount)).toBe(0)
    expect(r.body.data.stay.workTrade).toMatchObject({ rentTraded: true, trusted: false })
    const t = await tradeOf(r.body.data.id)
    expect(t).toMatchObject({ status: 'active', unit_id: f.unitId, tenant_id: g.tenantId, start_date: '2027-03-01', end_date: '2027-04-30',
      trusted: false, tracks_hours: true, monthly_hours_target: 40 })
    expect([...t.covered_charges].sort()).toEqual([...WORK_TRADE_COVERABLE].sort())
  })

  it('trusted, no hours, only some charges: the site is priced as usual when rent is not covered', async () => {
    const f = await seed()
    const g = await guest()
    const r = await create(f, { guestEmail: g.email, ...TWO_MONTHS, returningGuest: true,
      workTrade: { coveredCharges: ['electric', 'water'], trusted: true, tracksHours: false, hoursTarget: 20 } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(Number(r.body.data.totalAmount)).toBeGreaterThan(0)
    expect(await tradeOf(r.body.data.id)).toMatchObject({ covered_charges: ['electric', 'water'], trusted: true, tracks_hours: false, monthly_hours_target: 20 })
  })

  it('a guest with no account yet gets a placeholder resident account; an owner\'s login is refused', async () => {
    const f = await seed()
    const fresh = `new-${randomUUID().slice(0, 6)}@t.dev`
    const r = await create(f, { guestEmail: fresh, ...TWO_MONTHS, returningGuest: true, workTrade: {} })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const t = await tradeOf(r.body.data.id)
    const owner = (await query<any>(`SELECT u.email, u.role FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [t.tenant_id]))[0]
    expect(owner).toEqual({ email: fresh, role: 'tenant' })
    const ownerEmail = (await query<any>(`SELECT email FROM users WHERE id = $1`, [f.userId]))[0].email
    const bad = await create(f, { guestEmail: ownerEmail, checkIn: '2027-03-01', checkOut: '2027-03-08', workTrade: {} }, { unitId: f.unit2Id })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/belongs to an owner or staff login/)
    expect(await query(`SELECT 1 FROM unit_bookings WHERE unit_id = $1`, [f.unit2Id])).toHaveLength(0)
  })

  it('needs the work-trade permission', async () => {
    const f = await seed()
    const g = await guest()
    const desk = await deskToken(f, { 'tenants.invite': true })
    const r = await create(f, { guestEmail: g.email, ...TWO_MONTHS, returningGuest: true, workTrade: {} }, { token: desk })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/Create \/ update work-trade agreements/)
  })

  it('22+ nights without "returning" still needs the background check — its fee alone goes on the deposit link', async () => {
    const f = await seed()
    const g = await guest()
    const fee = await feeFor(f.state)
    const asked = await create(f, { guestEmail: g.email, ...LONG, workTrade: {} })
    expect(asked.status).toBe(409)
    expect(asked.body.code).toBe('screening_fee_route_needed')
    const sent = await create(f, { guestEmail: g.email, ...LONG, workTrade: {}, sendDepositLink: true })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.data.status).toBe('tentative')
    expect(h.depositLinkMock).toHaveBeenCalledTimes(1)
    expect(h.depositLinkMock.mock.calls[0][0]).toMatchObject({ amount: 0, screeningFee: fee })
    expect(await row(sent.body.data.id)).toMatchObject({ screening_required: true, total: 0 })
  })

  it('a short stay under work trade asks nothing: confirmed straight on even when a deposit link was picked', async () => {
    const f = await seed()
    const g = await guest()
    const r = await create(f, { guestEmail: g.email, checkIn: '2027-03-01', checkOut: '2027-03-08', workTrade: {}, sendDepositLink: true })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data).toMatchObject({ status: 'confirmed', depositLink: null })
    expect(h.depositLinkMock).not.toHaveBeenCalled()
  })

  it('follows the stay: extended, shortened, moved to another site — priced $0 throughout', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, checkIn: '2027-03-01', checkOut: '2027-03-08', workTrade: {} })
    const id = made.body.data.id
    const longer = await patch(f, id, { checkOut: '2027-03-15' })
    expect(longer.status, JSON.stringify(longer.body)).toBe(200)
    expect((await tradeOf(id)).end_date).toBe('2027-03-15')
    expect((await row(id)).total).toBe(0)
    const shorter = await patch(f, id, { checkOut: '2027-03-10' })
    expect(shorter.status).toBe(200)
    expect((await tradeOf(id)).end_date).toBe('2027-03-10')
    const moved = await patch(f, id, { unitId: f.unit2Id })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(await tradeOf(id)).toMatchObject({ unit_id: f.unit2Id, status: 'active' })
    expect((await row(id)).total).toBe(0)
  })

  it('taken off on an edit: the trade ends and the stay is priced at the site\'s rate', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, checkIn: '2027-03-01', checkOut: '2027-03-08', workTrade: {} })
    const id = made.body.data.id
    const tradeId = (await tradeOf(id)).id
    const off = await patch(f, id, { workTrade: null })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    // ended, and no longer tied to the stay (bringing the stay back never brings it back)
    expect((await query<any>(`SELECT status, booking_id FROM work_trade_agreements WHERE id = $1`, [tradeId]))[0])
      .toEqual({ status: 'ended', booking_id: null })
    expect((await row(id)).total).toBeGreaterThan(0)
  })

  it('cancelled: the trade ends; checked out early: it ends the day they left', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, checkIn: '2027-03-01', checkOut: '2027-03-08', workTrade: {} })
    const cancelled = await patch(f, made.body.data.id, { status: 'cancelled' })
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect((await tradeOf(made.body.data.id)).status).toBe('ended')

    const h2 = await guest()
    const from = await day(-5)
    const to = await day(5)
    const here = await create(f, { guestEmail: h2.email, checkIn: from, checkOut: to, workTrade: {} }, { unitId: f.unit2Id })
    expect(here.status, JSON.stringify(here.body)).toBe(201)
    const id = here.body.data.id
    expect((await patch(f, id, { status: 'checked_in' }, { unitId: f.unit2Id })).status).toBe(200)
    const out = await patch(f, id, { status: 'checked_out' }, { unitId: f.unit2Id })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(await tradeOf(id)).toMatchObject({ status: 'ended', end_date: await day(0) })
  })

  it('the space still counts for GAM\'s platform fee', async () => {
    const f = await seed()
    const g = await guest()
    const r = await create(f, { guestEmail: g.email, ...TWO_MONTHS, returningGuest: true, workTrade: {} })
    expect(Number(r.body.data.totalAmount)).toBe(0)
    const c = await getClient()
    try {
      const u = await billableUnitsForProperty(c, f.propertyId, '2027-03-01', '2027-02-01', ['rv_spot'])
      expect(u.monthStays).toBe(1)
      expect(u.total).toBeGreaterThanOrEqual(1)
    } finally { c.release() }
  })

  it('30+ nights answered lease: the drafted lease carries the work trade (it no longer follows the stay)', async () => {
    const f = await seed()
    const g = await guest()
    const r = await create(f, { guestEmail: g.email, ...TWO_MONTHS, stayTerms: 'lease', returningGuest: true, workTrade: {} })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.stay.leaseId).toBeTruthy()
    const t = (await query<any>(
      `SELECT booking_id, status, to_char(end_date, 'YYYY-MM-DD') AS end_date, unit_id, tenant_id
         FROM work_trade_agreements WHERE tenant_id = $1`, [g.tenantId]))
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ booking_id: null, status: 'active', end_date: null, unit_id: f.unitId })
    // and a lease drafted later from a stay (Offer a lease) does the same
    const g2 = await guest()
    const s2 = await create(f, { guestEmail: g2.email, ...TWO_MONTHS, returningGuest: false, workTrade: {}, sendDepositLink: true }, { unitId: f.unit2Id })
    expect(s2.status, JSON.stringify(s2.body)).toBe(201)
    await draftLeaseFromStay(s2.body.data.id)
    expect((await query<any>(`SELECT booking_id, end_date FROM work_trade_agreements WHERE tenant_id = $1`, [g2.tenantId]))[0])
      .toEqual({ booking_id: null, end_date: null })
  })
})

/** A 30+ night stay with no lease, two submetered utilities, and a work trade covering rent + electric. */
async function utilityStay(f: Fx, g: { email: string }, terms: Partial<{ tracksHours: boolean; trusted: boolean; hoursTarget: number | null }> = {}) {
  const meter = async (type: 'electric' | 'water') => {
    const c = await getClient()
    let id = ''
    try { await c.query('BEGIN'); id = await seedUtilityMeter(c, { propertyId: f.propertyId, utilityType: type }); await c.query('COMMIT') }
    finally { c.release() }
    await db.query(`UPDATE utility_meters SET rate_per_unit = 0.10, base_fee = 0 WHERE id = $1`, [id])
    await db.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [id, f.unitId])
    return id
  }
  const read = (meterId: string, d: string, v: number) => db.query(
    `INSERT INTO utility_meter_readings (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
     VALUES ($1, $2, $3, date_trunc('month', $2::date)::date, $4, 'monthly_cycle')`, [meterId, d, v, f.userId])
  const electric = await meter('electric')
  const water = await meter('water')
  await read(electric, '2026-02-28', 1000)
  await read(water, '2026-02-28', 500)
  // a stay with no lease, 30+ nights: its utilities are billed through a stay agreement
  const b = (await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, check_in, check_out, status, lease_type, total_amount, stay_terms)
     VALUES ($1, $2, 'Guest', $3, '2026-03-01', '2026-04-20', 'confirmed', 'month_to_month', 0, 'stay') RETURNING id`,
    [f.unitId, f.landlordId, g.email])).rows[0].id
  expect((await syncStayWorkTrade(b, { terms: { coveredCharges: ['rent', 'electric'], tracksHours: false, hoursTarget: null, duties: null, trusted: true, ...terms } })).action).toBe('created')
  const made = await syncStayUtilityAgreement(b)
  expect(made.action).toBe('created')
  const agreementId = (made as any).agreementId as string
  await read(electric, '2026-03-31', 1300)
  await read(water, '2026-03-31', 600)
  await generateBillsForMeter(electric, new Date(Date.UTC(2026, 2, 1)))
  await generateBillsForMeter(water, new Date(Date.UTC(2026, 2, 1)))
  return { bookingId: b, agreementId }
}
const utilityLines = (agreementId: string) => query<any>(
  `SELECT p.amount::text AS amount, p.status, (p.work_trade_suspended_at IS NOT NULL) AS suspended, ub.utility_type, p.notes
     FROM payments p JOIN utility_bills ub ON ub.payment_id = p.id
    WHERE ub.service_agreement_id = $1 ORDER BY ub.utility_type`, [agreementId])

describe('a stay\'s covered utilities are not billed (its utility agreement)', () => {
  it('a covered utility rides as a suspended line; an uncovered one is billed — and a period opens to release it, even with no hours tracked', async () => {
    const f = await seed()
    const g = await guest()
    const { bookingId, agreementId } = await utilityStay(f, g)

    const r = await generateServiceAgreementInvoices(new Date('2026-04-02T17:00:00Z'))
    expect(r.utilitiesInserted).toBe(2)
    const lines = await utilityLines(agreementId)
    expect(lines.map(({ notes, ...l }: any) => l)).toEqual([
      { amount: '30.00', status: 'pending', suspended: true, utility_type: 'electric' },
      { amount: '10.00', status: 'pending', suspended: false, utility_type: 'water' },
    ])
    const inv = (await query<any>(
      `SELECT id, total_amount::text AS total, subtotal_utilities::text AS utilities, late_fee_exempt, work_trade_agreement_id
         FROM invoices WHERE service_agreement_id = $1`, [agreementId]))[0]
    expect(inv).toMatchObject({ total: '10.00', utilities: '40.00', late_fee_exempt: true })
    expect(inv.work_trade_agreement_id).toBeTruthy()
    // 10/6 (review): Track hours off (trusted) — the period still opens, asking 0
    // hours, so the month-close releases the suspended line (S637).
    const trade = await tradeOf(bookingId)
    const periods = await query<any>(
      `SELECT invoice_id, target_hours::float AS target, basis_amount::text AS basis FROM work_trade_settlements WHERE agreement_id = $1`, [trade.id])
    expect(periods).toEqual([{ invoice_id: inv.id, target: 0, basis: '30.00' }])
  })

  it('a monitored trade that tracks hours opens its period at the property\'s hours', async () => {
    const f = await seed()
    const g = await guest()
    const { bookingId } = await utilityStay(f, g, { tracksHours: true, trusted: false })
    await generateServiceAgreementInvoices(new Date('2026-04-02T17:00:00Z'))
    const trade = await tradeOf(bookingId)
    expect((await query<any>(`SELECT target_hours::float AS target FROM work_trade_settlements WHERE agreement_id = $1`, [trade.id])))
      .toEqual([{ target: 40 }])
  })

  it('10/6 (review): billed after the trade ENDED (the last bill after check-out) — the covered line is settled as covered, never left suspended', async () => {
    const f = await seed()
    const g = await guest()
    const { bookingId, agreementId } = await utilityStay(f, g, { tracksHours: true, trusted: false })
    // checked out: the trade ended (its own end settlement already ran)
    await db.query(`UPDATE work_trade_agreements SET status = 'ended', end_date = '2026-04-20' WHERE booking_id = $1`, [bookingId])
    await generateServiceAgreementInvoices(new Date('2026-04-02T17:00:00Z'))
    const lines = await utilityLines(agreementId)
    expect(lines[0]).toMatchObject({ amount: '0.00', status: 'settled', suspended: false, utility_type: 'electric' })
    expect(lines[0].notes).toMatch(/Covered by work trade \(\$30\.00\)/)
    expect(lines[1]).toMatchObject({ amount: '10.00', status: 'pending', suspended: false, utility_type: 'water' })
    expect((await query<any>(`SELECT total_amount::text AS total FROM invoices WHERE service_agreement_id = $1`, [agreementId]))[0].total).toBe('10.00')
    expect(await query(`SELECT 1 FROM work_trade_settlements`)).toHaveLength(0)
  })
})

// ── 10/6 REVIEW FIXES ────────────────────────────────────────────────────────
describe('review fixes', () => {
  it('a traded 22+ night stay whose check fee was paid stays $0 when re-dated; taking the trade off prices it', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, ...LONG, workTrade: {}, sendDepositLink: true })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data.id
    // the $0 + fee link was paid
    await db.query(`UPDATE unit_bookings SET deposit_paid_at = NOW(), status = 'confirmed' WHERE id = $1`, [id])
    const moved = await patch(f, id, { checkOut: '2027-03-28' })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect((await row(id)).total).toBe(0)
    const site = await patch(f, id, { unitId: f.unit2Id })
    expect(site.status, JSON.stringify(site.body)).toBe(200)
    expect((await row(id)).total).toBe(0)
    const off = await patch(f, id, { workTrade: null }, { unitId: f.unit2Id })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect((await row(id)).total).toBeGreaterThan(0)
  })

  it('a trade the landlord PAUSED on the Work Trade page stays paused when the stay changes; one they ENDED there never comes back', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, checkIn: '2027-03-01', checkOut: '2027-03-08', workTrade: {} })
    const id = made.body.data.id
    const tradeId = (await tradeOf(id)).id
    const paused = await request(app()).patch(`/api/work-trade/${tradeId}`).set(auth(f.token)).send({ status: 'paused' })
    expect(paused.status, JSON.stringify(paused.body)).toBe(200)
    expect((await patch(f, id, { checkOut: '2027-03-10' })).status).toBe(200)
    expect(await tradeOf(id)).toMatchObject({ status: 'paused', end_date: '2027-03-10' })

    const ended = await request(app()).patch(`/api/work-trade/${tradeId}`).set(auth(f.token)).send({ status: 'ended' })
    expect(ended.status, JSON.stringify(ended.body)).toBe(200)
    expect((await query<any>(`SELECT status, booking_id FROM work_trade_agreements WHERE id = $1`, [tradeId]))[0])
      .toEqual({ status: 'ended', booking_id: null })
    expect((await patch(f, id, { checkOut: '2027-03-12' })).status).toBe(200)
    expect((await query<any>(`SELECT status FROM work_trade_agreements WHERE id = $1`, [tradeId]))[0].status).toBe('ended')
    expect(await tradeOf(id)).toBeUndefined()
  })

  it('a traded hold moved by a paying guest takes its trade to the new site; one cancelled for want of a site ends it', async () => {
    const f = await seed()
    const g = await guest()
    const made = await create(f, { guestEmail: g.email, ...LONG, workTrade: {}, sendDepositLink: true })
    expect(made.body.data.status).toBe('tentative')
    const id = made.body.data.id
    const move = async (unitId: string) => {
      const c = await getClient()
      let out: any[] = []
      try {
        await c.query('BEGIN')
        out = await clearUnpaidHolds(c, unitId, LONG.checkIn, LONG.checkOut)
        await c.query('COMMIT')
      } finally { c.release() }
      await notifyDisplacedHolds(f.landlordId, f.propertyId, out)
      return out
    }
    expect((await move(f.unitId))[0]).toMatchObject({ outcome: 'moved', toUnitId: f.unit2Id })
    expect(await tradeOf(id)).toMatchObject({ unit_id: f.unit2Id, status: 'active' })
    // nowhere left (the other site holds the first guest): a second traded hold is cancelled, its trade ended
    const g2 = await guest()
    const second = await create(f, { guestEmail: g2.email, ...LONG, workTrade: {}, sendDepositLink: true })
    expect(second.status, JSON.stringify(second.body)).toBe(201)
    expect((await move(f.unitId))[0]).toMatchObject({ outcome: 'displaced', holdId: second.body.data.id })
    expect((await tradeOf(second.body.data.id)).status).toBe('ended')
  })

  it('a traded stay relocated for another guest\'s extension takes its trade along', async () => {
    const f = await seed()
    const g = await guest()
    await db.query(`UPDATE units SET lease_types_allowed = ARRAY['nightly','weekly'] WHERE property_id = $1`, [f.propertyId])
    const made = await create(f, { guestEmail: g.email, checkIn: '2027-03-01', checkOut: '2027-03-08', workTrade: {} })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data.id
    const relo = await relocateBlockingBookings(f.unitId, { checkIn: '2027-03-01', checkOut: '2027-03-08' }, randomUUID())
    expect(relo.ok, JSON.stringify(relo)).toBe(true)
    expect(await tradeOf(id)).toMatchObject({ unit_id: f.unit2Id })
  })

  it('a guest with no login gets their account\'s set-up link for the work trade — once, never twice with the utility invite', async () => {
    const f = await seed()
    const fresh = `wt-${randomUUID().slice(0, 6)}@t.dev`
    const r = await create(f, { guestEmail: fresh, checkIn: '2027-03-01', checkOut: '2027-03-08', workTrade: {} })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(h.wtInviteMock).toHaveBeenCalledTimes(1)
    const sent = h.wtInviteMock.mock.calls[0][0] as any
    expect(sent).toMatchObject({ to: fresh, logsHours: true, siteLabel: 'site RV 07' })
    expect(sent.activationUrl).toMatch(/accept-invite\?token=[0-9a-f]{64}/)

    // 30+ nights, "stay": its utility agreement's email carries the same link — one email
    h.wtInviteMock.mockClear(); h.utilityInviteMock.mockClear()
    const fresh2 = `wt-${randomUUID().slice(0, 6)}@t.dev`
    const two = await create(f, { guestEmail: fresh2, checkIn: '2027-03-01', checkOut: '2027-04-30', leaseType: 'month_to_month', stayTerms: 'stay', returningGuest: true, workTrade: {} }, { unitId: f.unit2Id })
    expect(two.status, JSON.stringify(two.body)).toBe(201)
    expect(h.utilityInviteMock).toHaveBeenCalledTimes(1)
    expect(h.wtInviteMock).not.toHaveBeenCalled()
  })

  it('returning chosen after the check fee went out: the fee comes off the ticket and the links; a $0 traded stay is confirmed', async () => {
    const f = await seed()
    const g = await guest()
    const fee = await feeFor(f.state)
    // a stay at the register: its ticket carries the fee
    const made = await create(f, { guestEmail: g.email, ...LONG, payAtRegister: true })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const id = made.body.data.id
    const ticketId = made.body.data.registerTicketId
    // and links already sent: a deposit link (deposit + fee) and a link for the fee alone
    const link = async (bookingId: string | null, items: any[], total: number) => (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, booking_id, last_checkout_session_id)
       VALUES ($1, $2, $3, $4, 'one_time', 'Stay', $5::jsonb, $6, $6, $7, $8, 'cs_test_open') RETURNING id`,
      [randomUUID(), f.landlordId, f.propertyId, f.userId, JSON.stringify(items), total, g.email, bookingId])).rows[0].id
    const checkLine = (extra: any = {}) => ({ id: null, name: 'Background check', qty: 1, price: fee, tax: 0, screening: true, ...extra })
    const deposit = await link(id, [{ id: null, name: 'Deposit', qty: 1, price: 150, tax: 0 }, checkLine()], 150 + fee)
    const feeOnly = await link(null, [checkLine({ bookingId: id })], fee)

    await db.query(`UPDATE unit_bookings SET status = 'confirmed' WHERE id = $1`, [id])
    const r = await patch(f, id, { returningGuest: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.returningFeeNote).toMatch(/^Returning guest: no background check\./)
    const t = (await query<any>(`SELECT status, items FROM pos_open_tickets WHERE id = $1`, [ticketId]))[0]
    expect(t.status).toBe('open')
    expect((t.items as any[]).some((i) => i.screening)).toBe(false)
    const d = (await query<any>(`SELECT status, total::float AS total, subtotal::float AS subtotal, items, last_checkout_session_id FROM pos_pay_links WHERE id = $1`, [deposit]))[0]
    expect(d).toMatchObject({ status: 'open', total: 150, subtotal: 150, last_checkout_session_id: null })
    expect((d.items as any[]).some((i) => i.screening)).toBe(false)
    expect((await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [feeOnly]))[0].status).toBe('cancelled')
    expect(await query('SELECT 1 FROM screening_prepayments')).toHaveLength(0)

    // a work-trade stay held only for its $0 + fee ticket: the ticket closes and the stay is confirmed
    const g2 = await guest()
    const traded = await create(f, { guestEmail: g2.email, ...LONG, workTrade: {}, payAtRegister: true }, { unitId: f.unit2Id })
    expect(traded.status, JSON.stringify(traded.body)).toBe(201)
    expect(traded.body.data.status).toBe('tentative')
    // the allowance (1) is used by the first guest — make room (that one dated past the rolling year)
    await db.query(`UPDATE unit_bookings SET returning_guest_at = NOW() - INTERVAL '400 days' WHERE id = $1`, [id])
    const r2 = await patch(f, traded.body.data.id, { returningGuest: true }, { unitId: f.unit2Id })
    expect(r2.status, JSON.stringify(r2.body)).toBe(200)
    expect((await query<any>(`SELECT status FROM pos_open_tickets WHERE id = $1`, [traded.body.data.registerTicketId]))[0].status).toBe('voided')
    expect((await row(traded.body.data.id)).status).toBe('confirmed')
  })

  it('the invite door takes the allowance lock: two returning residents at once on the last place — one is refused', async () => {
    const f = await seed()
    const a = await guest()
    const b = await guest()
    const out = await Promise.allSettled([a, b].map(p => applyReturningResidentWaive({
      tenantId: p.tenantId, landlordId: f.landlordId, propertyId: f.propertyId, unitId: f.unitId, byUserId: f.userId })))
    expect(out.filter(o => o.status === 'fulfilled')).toHaveLength(1)
    const refused = out.find(o => o.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason.message).toBe(RETURNING_ALLOWANCE_USED_MESSAGE)
    expect((await returningResidentAllowance(f.propertyId)).used).toBe(1)
  })
})

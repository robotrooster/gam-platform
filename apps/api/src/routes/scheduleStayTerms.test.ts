/**
 * 10/5 (Nic) — PREPAID STAYS ON THE SCHEDULE (routes/units.ts).
 *
 *   R9  A stay of more than three weeks checks in only once its background
 *       check's results are back AND the landlord has decided (approved or
 *       denied). No override — owners included.
 *   R8  The schedule takes no money: a stay that needs a check with nothing on
 *       file carries the check's fee on the register ticket it is handed to.
 *   R6  "Add a month" extends the same stay one calendar month at the monthly
 *       rate, rung up at the register; 30+ nights asks lease or stay first.
 *   R2  "Offer a lease" drafts the month-to-month lease for a stay with none.
 *   The landlord assistant never answers lease or stay itself.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const { screeningMock, utilityInviteMock, depositLinkMock, feeLinkMock } = vi.hoisted(() => ({
  screeningMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  utilityInviteMock: vi.fn(async (..._a: any[]) => 'msg_mock'),
  depositLinkMock: vi.fn(async (..._a: any[]) => ({ id: 'link-deposit', url: 'https://pay.test/deposit' })),
  feeLinkMock: vi.fn(async (..._a: any[]) => ({ id: 'link-fee', url: 'https://pay.test/fee' })),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailBackgroundCheckScreeningRequest: screeningMock,
  emailUtilityServiceInvite: utilityInviteMock,
}))
// The pay links themselves are routes/posPayLinks' own tests; here the schedule
// only has to hand the stay (and the check's fee) to them.
vi.mock('./posPayLinks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createBookingDepositLink: depositLinkMock,
  createScreeningFeeLink: feeLinkMock,
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedTenant } from '../test/dbHelpers'
import { unitsRouter } from './units'
import { errorHandler } from '../middleware/errorHandler'
import { screeningIntakeFee } from './background'
import { SCREENING_LINE_NAME } from '../services/registerStay'
import {
  refuseAgentCheckOut, refuseAgentStayTerms, AGENT_CANNOT_CHOOSE_STAY_TERMS, getPortalAction,
} from '../services/agents/portalActions'
import { requestBookingChange } from '../services/agents/tools/requestBookingChange'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  screeningMock.mockClear()
  utilityInviteMock.mockClear()
  depositLinkMock.mockClear()
  feeLinkMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_schedule_stay_terms'
})

interface Fx { landlordId: string; propertyId: string; unitId: string; token: string; state: string | null }

async function seed(): Promise<Fx> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = (await c.query<{ id: string }>(
      `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                          nightly_rate, weekly_rate, monthly_rate, is_bookable, lease_types_allowed)
       VALUES ($1,$2,'RV 07','vacant',1500,'rv_spot',60,350,1500,TRUE,'{}') RETURNING id`,
      [propertyId, landlordId])).rows[0].id
    // The register buttons a stay is handed to the till on.
    const cat = (await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1,'Stays',1,TRUE) RETURNING id`,
      [landlordId])).rows[0].id
    for (const [name, unit] of [['RV site — weekly', 'week'], ['RV site — monthly', 'month']]) {
      await c.query(
        `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate,
                                stock_qty, stock_min, stock_max, stay_unit)
         VALUES ($1,$2,$3,$4,0,0,0,999,0,999,$5)`, [landlordId, propertyId, name, cat, unit])
    }
    const state = (await c.query<{ state: string | null }>(`SELECT state FROM properties WHERE id = $1`, [propertyId])).rows[0].state
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, propertyId, unitId, token, state }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
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

async function stay(f: Fx, o: {
  checkIn: string; checkOut: string; email?: string | null; status?: string; terms?: 'lease' | 'stay' | null
  total?: number; paidWhole?: boolean; screeningRequired?: boolean
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings
       (landlord_id, unit_id, guest_name, guest_email, lease_type, check_in, check_out, nights,
        total_amount, platform_fee, status, source, stay_terms, screening_required,
        booked_check_out, deposit_paid_at, balance_billed_at, balance_paid_at)
     VALUES ($1, $2, 'Pat Ruiz', $3, 'weekly', $4::date, $5::date, ($5::date - $4::date),
             $6, 0, $7, 'direct', $8, $9, $5::date,
             CASE WHEN $10::boolean THEN NOW() END, CASE WHEN $10::boolean THEN NOW() END,
             CASE WHEN $10::boolean THEN NOW() END)
     RETURNING id`,
    [f.landlordId, f.unitId, o.email ?? null, o.checkIn, o.checkOut, o.total ?? 900,
     o.status ?? 'confirmed', o.terms ?? null, o.screeningRequired ?? false, o.paidWhole ?? false])
  return r.rows[0].id
}

async function check(f: Fx, g: { tenantId: string; userId: string }, o: { status: string; summary: boolean }): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO background_checks (landlord_id, user_id, tenant_id, status, decided_at, report_summary)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $4 IN ('approved', 'denied') THEN NOW() END,
             CASE WHEN $5::boolean THEN '{"result":"clear"}'::jsonb END)
     RETURNING id`, [f.landlordId, g.userId, g.tenantId, o.status, o.summary])
  return r.rows[0].id
}

const patch = (f: Fx, id: string, body: Record<string, unknown>) =>
  request(buildApp()).patch(`/api/units/${f.unitId}/bookings/${id}`).set('Authorization', `Bearer ${f.token}`).send(body)

const row = async (id: string) => (await db.query(
  `SELECT status, to_char(check_out, 'YYYY-MM-DD') AS check_out, to_char(booked_check_out, 'YYYY-MM-DD') AS booked_check_out,
          total_amount::text AS total, stay_terms, screening_required
     FROM unit_bookings WHERE id = $1`, [id])).rows[0]

const feeFor = async (state: string | null) => {
  const i = await screeningIntakeFee(state)
  return Math.round((i.screening + i.gamFee + i.tax) * 100) / 100
}

// ── R9 ──────────────────────────────────────────────────────────────────────
describe('check-in waits on the background check (R9)', () => {
  it('no check on file: refused in plain words, nothing written — and there is no override, owners included', async () => {
    const f = await seed()
    const g = await guest()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-26', email: g.email, screeningRequired: true })
    const r = await patch(f, id, { status: 'checked_in', overrideMeterRead: true })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'screening_pending', waitingOn: 'no_check' })
    expect(r.body.error).toMatch(/more than three weeks/)
    expect((await row(id)).status).toBe('confirmed')
  })

  it('results back but undecided: waits for the landlord; approved or denied: checks in', async () => {
    const f = await seed()
    const g = await guest()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-26', email: g.email, screeningRequired: true })
    const bc = await check(f, g, { status: 'complete', summary: true })
    const waiting = await patch(f, id, { status: 'checked_in' })
    expect(waiting.status).toBe(409)
    expect(waiting.body).toMatchObject({ code: 'screening_pending', waitingOn: 'decision', checkId: bc })

    await db.query(`UPDATE background_checks SET status = 'approved', decided_at = NOW() WHERE id = $1`, [bc])
    const ok = await patch(f, id, { status: 'checked_in' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await row(id)).status).toBe('checked_in')
  })

  it('after a denial the landlord may still check them in (Nic)', async () => {
    const f = await seed()
    const g = await guest()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-26', email: g.email, screeningRequired: true })
    await check(f, g, { status: 'denied', summary: true })
    const ok = await patch(f, id, { status: 'checked_in' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it('A6: a decided check clears check-in — a decision is only taken once results are back', async () => {
    const f = await seed()
    const g = await guest()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-26', email: g.email, screeningRequired: true })
    // an approval with no report on the row (decided before A6) is not held up forever
    await check(f, g, { status: 'approved', summary: false })
    const r = await patch(f, id, { status: 'checked_in' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })

  it('A7: a long stay booked before this change (never marked as needing screening) checks in as before', async () => {
    const f = await seed()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-04-15', email: 'before@t.dev' })
    const r = await patch(f, id, { status: 'checked_in' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })

  it('a stay of three weeks or less checks in as before', async () => {
    const f = await seed()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-15', email: 'short@t.dev' })
    const r = await patch(f, id, { status: 'checked_in' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })

  it('the schedule shows what a waiting stay is waiting on', async () => {
    const f = await seed()
    const g = await guest()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-26', email: g.email, screeningRequired: true })
    const r = await request(buildApp()).get('/api/units/schedule/master?from=2027-02-25&to=2027-04-01')
      .set('Authorization', `Bearer ${f.token}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const b = r.body.data.bookings.find((x: any) => x.id === id)
    expect(b.screening_block).toMatchObject({ code: 'screening_pending', waitingOn: 'no_check' })
    expect(b.stay_lease_id).toBeNull()
  })
})

// ── R8 ──────────────────────────────────────────────────────────────────────
describe('the check\'s fee goes to the till with the stay (R8)', () => {
  it('a 24-night stay handed to the register carries the background check as a fixed line', async () => {
    const f = await seed()
    const r = await request(buildApp()).post(`/api/units/${f.unitId}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ guestName: 'Dale Carter', guestEmail: `dale-${randomUUID().slice(0, 6)}@t.dev`, leaseType: 'weekly',
              checkIn: '2027-03-01', checkOut: '2027-03-25', payAtRegister: true })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const fee = await feeFor(f.state)
    expect(r.body.data.stay).toMatchObject({ screening: 'fee_due', screeningFee: fee, screeningFeeUncollected: false })
    const t = await db.query(`SELECT items FROM pos_open_tickets WHERE id = $1`, [r.body.data.registerTicketId])
    const screeningLine = t.rows[0].items.find((i: any) => i.screening === true)
    expect(screeningLine).toMatchObject({ id: null, name: SCREENING_LINE_NAME, qty: 1, price: fee })
    expect((await row(r.body.data.id)).screening_required).toBe(true)
  })
})

// ── A2 / M3 ─────────────────────────────────────────────────────────────────
describe('a stay that needs the check\'s fee is paid through a link or the register (A2, M3)', () => {
  const create = (f: Fx, body: Record<string, unknown>) => request(buildApp()).post(`/api/units/${f.unitId}/bookings`)
    .set('Authorization', `Bearer ${f.token}`)
    .send({ guestName: 'Dale Carter', leaseType: 'weekly', checkIn: '2027-03-01', checkOut: '2027-03-25', ...body })

  it('is not confirmed straight onto the schedule: refused in plain words, nothing written, both ways offered', async () => {
    const f = await seed()
    const fee = await feeFor(f.state)
    const r = await create(f, { guestEmail: `dale-${randomUUID().slice(0, 6)}@t.dev` })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'screening_fee_route_needed', nights: 24, screeningFee: fee, canSendLink: true })
    expect(r.body.error).toMatch(/can't be confirmed straight onto the schedule/)
    expect(r.body.error).toMatch(/pay link/)
    expect(r.body.error).toMatch(/register/)
    expect((await db.query(`SELECT id FROM unit_bookings WHERE unit_id = $1`, [f.unitId])).rows).toHaveLength(0)
  })

  it('a deposit link carries the fee as its own line', async () => {
    const f = await seed()
    const fee = await feeFor(f.state)
    const r = await create(f, { guestEmail: `dale-${randomUUID().slice(0, 6)}@t.dev`, sendDepositLink: true })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(depositLinkMock).toHaveBeenCalledTimes(1)
    expect(depositLinkMock.mock.calls[0][0]).toMatchObject({ bookingId: r.body.data.id, screeningFee: fee })
    expect(r.body.data.stay).toMatchObject({ screening: 'fee_due', screeningFee: fee, screeningFeeUncollected: false })
    expect((await row(r.body.data.id)).screening_required).toBe(true)
  })

  it('an edit that makes a stay need the check emails a pay link for the fee — once per stay', async () => {
    const f = await seed()
    const g = await guest()
    const fee = await feeFor(f.state)
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-15', email: g.email, total: 700, paidWhole: true })
    const r = await patch(f, id, { checkOut: '2027-03-26' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(feeLinkMock).toHaveBeenCalledTimes(1)
    expect(feeLinkMock.mock.calls[0][0]).toMatchObject({ bookingId: id, amount: fee, guestEmail: g.email })
    expect(r.body.data.stay).toMatchObject({
      nights: 25, screening: 'fee_due', screeningFee: fee,
      screeningFeeLink: { id: 'link-fee' }, screeningFeeUncollected: false, emailedTo: g.email,
    })
    expect((await row(id)).screening_required).toBe(true)
  })

  it('no second fee when an open register ticket of the stay already carries it', async () => {
    const f = await seed()
    const g = await guest()
    const fee = await feeFor(f.state)
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-15', email: g.email, total: 700, paidWhole: true })
    await db.query(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, booking_id)
       VALUES ($1, $2, (SELECT user_id FROM landlords WHERE id = $1), $3::jsonb, $4)`,
      [f.landlordId, f.propertyId, JSON.stringify([{ id: null, name: SCREENING_LINE_NAME, qty: 1, price: fee, tax: 0, screening: true }]), id])
    const r = await patch(f, id, { checkOut: '2027-03-26' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(feeLinkMock).not.toHaveBeenCalled()
    expect(r.body.data.stay).toMatchObject({ screening: 'fee_due', screeningFeeLink: null, screeningFeeUncollected: false })
  })
})

// ── M14 (10/5 Nic: a paid screening is not refunded on a cancel or no-show) ──
describe('a canceled or no-show stay keeps the background check it paid for', () => {
  for (const status of ['cancelled', 'no_show'] as const) {
    it(`${status}: the prepayment stays unused and the landlord's charge for it stands`, async () => {
      const f = await seed()
      const g = await guest()
      const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-26', email: g.email, screeningRequired: true })
      const sp = (await db.query<{ id: string }>(
        `INSERT INTO screening_prepayments (landlord_id, property_id, booking_id, email, amount, source)
         VALUES ($1, $2, $3, $4, 45, 'schedule') RETURNING id`, [f.landlordId, f.propertyId, id, g.email])).rows[0].id
      const r = await patch(f, id, { status })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const after = await db.query(`SELECT status, voided_at FROM screening_prepayments WHERE id = $1`, [sp])
      expect(after.rows[0].status).toBe('unused')
      expect(after.rows[0].voided_at).toBeNull()
    })
  }
})

// ── F1: the guest assistant ─────────────────────────────────────────────────
describe('the guest assistant\'s extra night never crosses 22 or 30 nights on its own (F1)', () => {
  const actorFor = (id: string) => ({ userId: 'tok', role: 'guest' as const, profileId: id, bookingId: id })

  it('the night that makes the stay 22 goes to the host; nothing on the stay changes', async () => {
    const f = await seed()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-22', email: 'pat@t.dev' })
    const r: any = await requestBookingChange.execute({ request_type: 'extra_night', confirmed: true }, actorFor(id) as any)
    expect(r.ok).toBe(true)
    expect(r.autoApproved).toBeUndefined()
    expect((await row(id)).check_out).toBe('2027-03-22')
    const cr = await db.query(`SELECT status FROM booking_change_requests WHERE booking_id = $1`, [id])
    expect(cr.rows.map((x: any) => x.status)).toEqual(['requested'])
    const n = await db.query(
      `SELECT body FROM notifications WHERE type = 'booking_change_request' AND data->>'bookingId' = $1`, [id])
    expect(n.rows[0].body).toMatch(/22 nights in a row/)
  })

  it('a night that crosses neither is confirmed as before', async () => {
    const f = await seed()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-10', email: 'pat@t.dev' })
    const r: any = await requestBookingChange.execute({ request_type: 'extra_night', confirmed: true }, actorFor(id) as any)
    expect(r.autoApproved).toBe(true)
    expect(await row(id)).toMatchObject({ check_out: '2027-03-11', booked_check_out: '2027-03-11' })
  })
})

// ── R6 ──────────────────────────────────────────────────────────────────────
describe('Add a month (R6)', () => {
  it('quotes the month on its own; 30+ asks lease or stay first; stay → the same stay runs a month longer, on the register ticket', async () => {
    const f = await seed()
    const g = await guest()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-15', email: g.email, total: 700, paidWhole: true })
    const app = buildApp()

    const q = await request(app).get(`/api/units/${f.unitId}/bookings/${id}/add-month`).set('Authorization', `Bearer ${f.token}`)
    expect(q.status, JSON.stringify(q.body)).toBe(200)
    expect(q.body.data).toMatchObject({
      fromCheckOut: '2027-03-15', newCheckOut: '2027-04-15', addedNights: 31, monthPrice: 1500,
      nights: 45, leaseChoice: 'needed', screening: 'fee_due',
    })

    const asked = await request(app).post(`/api/units/${f.unitId}/bookings/${id}/add-month`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(asked.status).toBe(409)
    expect(asked.body.code).toBe('stay_terms_needed')
    expect((await row(id)).check_out).toBe('2027-03-15')

    const done = await request(app).post(`/api/units/${f.unitId}/bookings/${id}/add-month`)
      .set('Authorization', `Bearer ${f.token}`).send({ stayTerms: 'stay' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data.extended).toBe(true)
    expect(await row(id)).toMatchObject({
      check_out: '2027-04-15', booked_check_out: '2027-04-15', total: '2200.00',
      stay_terms: 'stay', screening_required: true,
    })
    const fee = await feeFor(f.state)
    const t = await db.query(`SELECT items, booking_id FROM pos_open_tickets WHERE id = $1`, [done.body.data.addedMonth.registerTicketId])
    expect(t.rows[0].booking_id).toBe(id)
    expect(t.rows[0].items.find((i: any) => i.screening === true)).toMatchObject({ price: fee })
    const ev = await db.query(
      `SELECT detail FROM unit_booking_events WHERE booking_id = $1 AND event_type = 'dates_changed'`, [id])
    expect(ev.rows.some((e: any) => e.detail.added_month === true && Number(e.detail.month_price) === 1500)).toBe(true)
    // Never a second reservation stacked behind it.
    expect((await db.query(`SELECT id FROM unit_bookings WHERE unit_id = $1`, [f.unitId])).rows).toHaveLength(1)
  })

  it('lease chosen → the lease is drafted instead, and no month is added', async () => {
    const f = await seed()
    const g = await guest()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-15', email: g.email, total: 700, paidWhole: true })
    const r = await request(buildApp()).post(`/api/units/${f.unitId}/bookings/${id}/add-month`)
      .set('Authorization', `Bearer ${f.token}`).send({ stayTerms: 'lease' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data).toMatchObject({ extended: false })
    expect((await row(id)).check_out).toBe('2027-03-15')
    const l = await db.query(`SELECT lease_type, end_date FROM leases WHERE id = $1`, [r.body.data.leaseId])
    expect(l.rows[0]).toEqual({ lease_type: 'month_to_month', end_date: null })
  })

  it('a month somebody else holds a night of is refused, with nothing changed', async () => {
    const f = await seed()
    const g = await guest()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-03-15', email: g.email, total: 700, paidWhole: true, terms: 'stay' })
    await stay(f, { checkIn: '2027-04-01', checkOut: '2027-04-05', email: 'next@t.dev' })
    const r = await request(buildApp()).post(`/api/units/${f.unitId}/bookings/${id}/add-month`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(r.status).toBe(409)
    expect(await row(id)).toMatchObject({ check_out: '2027-03-15', total: '700.00' })
    expect((await db.query(`SELECT id FROM pos_open_tickets WHERE booking_id = $1`, [id])).rows).toHaveLength(0)
  })
})

// ── R2/R4 ───────────────────────────────────────────────────────────────────
describe('Offer a lease (R2/R4)', () => {
  it('drafts the month-to-month lease for a stay with none — once', async () => {
    const f = await seed()
    const id = await stay(f, { checkIn: '2027-03-01', checkOut: '2027-04-05', email: 'offer@t.dev', terms: 'stay' })
    const app = buildApp()
    const first = await request(app).post(`/api/units/${f.unitId}/bookings/${id}/offer-lease`).set('Authorization', `Bearer ${f.token}`)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const l = await db.query(
      `SELECT lease_type, status, end_date, lease_source FROM leases WHERE source_booking_id = $1`, [id])
    expect(l.rows).toEqual([{ lease_type: 'month_to_month', status: 'pending', end_date: null, lease_source: 'booking_draft' }])
    expect((await row(id)).stay_terms).toBe('lease')
    const again = await request(app).post(`/api/units/${f.unitId}/bookings/${id}/offer-lease`).set('Authorization', `Bearer ${f.token}`)
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual({ leaseId: first.body.data.leaseId, drafted: false })
  })
})

// ── The assistant ───────────────────────────────────────────────────────────
describe('the landlord assistant never answers lease or stay', () => {
  it('Add a month and Offer a lease are actions it can take, read back first; Add a month never carries an answer (F2)', async () => {
    const add = getPortalAction('add_month_to_stay')!
    const offer = getPortalAction('offer_lease_for_stay')!
    expect(add).toMatchObject({ method: 'POST', path: '/api/units/:unitId/bookings/:bookingId/add-month', confirmFirst: true })
    expect(offer).toMatchObject({ method: 'POST', path: '/api/units/:unitId/bookings/:bookingId/offer-lease', confirmFirst: true })
    expect(await add.refuse!({ unitId: 'u', bookingId: 'b', stayTerms: 'stay' })).toBe(AGENT_CANNOT_CHOOSE_STAY_TERMS)
    expect(await add.refuse!({ unitId: 'u', bookingId: 'b' })).toBeNull()
  })

  it('a booking call carrying an answer is refused before it is sent', async () => {
    expect(await refuseAgentStayTerms({ stayTerms: 'lease' })).toBe(AGENT_CANNOT_CHOOSE_STAY_TERMS)
    expect(await refuseAgentStayTerms({ checkOut: '2027-04-10' })).toBeNull()
    expect(await refuseAgentCheckOut({ bookingId: randomUUID(), checkOut: '2027-04-10', stayTerms: 'stay' }))
      .toBe(AGENT_CANNOT_CHOOSE_STAY_TERMS)
  })
})

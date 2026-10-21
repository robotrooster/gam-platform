/**
 * 10/20 (review) — A STAY RE-DATED UNDER THIRTY NIGHTS IS BACK IN THE RATE.
 *
 * A stay of 30+ nights with no lease pays its own site's utilities through a
 * utility service agreement; a nightly or weekly guest's power is inside the
 * rate they already paid and is billed to NOBODY. Both doors read that off the
 * agreement — and the agreement had been written once and never asked about
 * again.
 *
 *   services/stayTerms syncStayUtilityAgreement counted the nights only on its
 *     way to CREATING an agreement. Its update branch re-dated whatever row it
 *     found and set it active again, with no second look at the length of the
 *     stay. routes/units afterStaySaved calls it on every save of a
 *     reservation — "made, re-dated, moved or given another month".
 *   services/registerFinalUtility asked "is there a row for this booking",
 *     which answers a question about the past, not about who owes this power.
 *
 * So Andres books 35 nights on RV 27 and pays his own power; the landlord drags
 * his reservation in on the schedule to 10 nights. He is a weekly guest now.
 * The stale row said "he pays his own", the counter priced 387 kWh at $87.77,
 * and the desk would have read that figure out to him with him standing there —
 * while the in-the-rate column that exists to catch exactly this usage was
 * never written for his stay.
 *
 * Driven through the production path: the agreement is made the way the product
 * makes it, the re-date goes through the schedule's own save, and the counter's
 * three doors are the ones the register calls.
 *
 * Run:
 *   DB_NAME=gam_fin_test TEST_DB_NAME=gam_fin_test GAM_TEST_WORKERS=1 \
 *   TEST_APPLY_MIGRATIONS_AFTER=20261022140000 \
 *   npx vitest run src/services/reDatedStayUtilities.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Nothing leaves this process. The stay-agreement door can send a set-up link
// and the schedule can tell a guest their site changed; both are mocked so the
// suite can assert nobody was written to at all.
const { emailMock, notifyMock } = vi.hoisted(() => ({
  emailMock: vi.fn(async (..._a: any[]) => undefined),
  notifyMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('./email', async (orig) => ({
  ...(await orig() as any),
  sendEmail: emailMock, emailUtilityServiceInvite: emailMock, emailBookingSiteChanged: emailMock,
}))
vi.mock('./notifications', async (orig) => ({ ...(await orig() as any), createNotification: notifyMock }))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import { syncStayUtilityAgreement } from './stayTerms'
import {
  counterClosings, counterClosingById, quoteCounterReads, recordCounterReads,
} from './registerFinalUtility'
import { unitsRouter } from '../routes/units'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  await cleanupAllSchema()
  emailMock.mockClear(); notifyMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_redated_stay'
})

const day = async (n: number): Promise<string> =>
  (await db.query<{ d: string }>(`SELECT (CURRENT_DATE + $1::int)::text AS d`, [n])).rows[0].d

/**
 * Mountain View's shape: RV 27 with its own electric submeter at $0.21 a
 * kilowatt, the park's 8% utility tax, and a prior read of 48,000 nine days ago.
 */
async function park() {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, unitType: 'rv_spot', rentAmount: 589 })
    await c.query(`UPDATE units SET display_label = 'RV 27' WHERE id = $1`, [unitId])
    const meterId = await seedUtilityMeter(c, { propertyId, utilityType: 'electric' })
    await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1, $2)`, [meterId, unitId])
    await c.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
       VALUES ($1, 'electric', 0.21, 0)`, [propertyId])
    await c.query(
      `INSERT INTO property_utility_tax_rates (property_id, utility_type, tax_rate_pct)
       VALUES ($1, 'electric', 8)`, [propertyId])
    await c.query(
      `INSERT INTO utility_meter_readings
         (meter_id, reading_date, reading_value, billing_cycle_month, created_by_user_id, reason)
       VALUES ($1, CURRENT_DATE - 9, 48000, date_trunc('month', CURRENT_DATE - 9)::date, $2, 'monthly_cycle')`,
      [meterId, userId])
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId,
        landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, unitId, meterId, token }
  } finally { c.release() }
}
type Park = Awaited<ReturnType<typeof park>>

/** The schedule's own save — the door whose answer had gone stale. */
const reDate = (p: Park, bookingId: string, body: any) => {
  const app = express()
  app.use(express.json())
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return request(app).patch(`/api/units/${p.unitId}/bookings/${bookingId}`)
    .set('Authorization', `Bearer ${p.token}`).send(body)
}

/**
 * A long stay whose agreement is made the way the product makes it — the stay's
 * own account, through services/stayTerms. Writing the row in by hand is what
 * hid this: a fixture cannot go stale, and the live row did.
 */
async function longStayOn(p: Park, o: { email: string; from: number; to: number }) {
  const c = await getClient()
  let tenantId = ''
  try { tenantId = await seedTenant(c, { email: o.email }) } finally { c.release() }
  const b = await db.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, tenant_id, check_in, check_out, booked_check_out,
                                status, lease_type, stay_terms, guest_name, guest_email)
     VALUES ($1,$2,$3,CURRENT_DATE + $4::int, CURRENT_DATE + $5::int, CURRENT_DATE + $5::int,
             'checked_in','month_to_month','stay','Andres Razo',$6)
     RETURNING id`,
    [p.unitId, p.landlordId, tenantId, o.from, o.to, o.email])
  const made = await syncStayUtilityAgreement(b.rows[0].id, { byUserId: p.userId })
  expect(made.action, JSON.stringify(made)).toBe('created')
  return { bookingId: b.rows[0].id, tenantId, agreementId: (made as any).agreementId as string }
}

const agreement = (id: string) => db.query<any>(
  `SELECT status, start_date::text AS s, end_date::text AS e
     FROM utility_service_agreements WHERE id = $1`, [id]).then(r => r.rows[0])

const readings = (meterId: string) => db.query<any>(
  `SELECT reading_value::text AS v, reason, needs_review FROM utility_meter_readings
    WHERE meter_id = $1 ORDER BY created_at`, [meterId]).then(r => r.rows)
const bills = (meterId: string) => db.query<any>(
  `SELECT charge_amount::text AS charge, tax_amount::text AS tax, status, service_agreement_id
     FROM utility_bills WHERE meter_id = $1 ORDER BY created_at`, [meterId]).then(r => r.rows)
const absorbed = (meterId: string) => db.query<any>(
  `SELECT reason, charge_amount::text AS charge, tax_amount::text AS tax, usage_amount::text AS usage
     FROM utility_absorbed_charges WHERE meter_id = $1 ORDER BY created_at`, [meterId]).then(r => r.rows)
const invoiceCount = (landlordId: string) => db.query<{ n: number }>(
  `SELECT COUNT(*)::int AS n FROM invoices WHERE landlord_id = $1`, [landlordId]).then(r => r.rows[0].n)

/** The desk opening the customer up, as routes/pos hands the lookup its ids. */
const lookUp = (p: Park, email: string) =>
  counterClosings(db as any, { landlordId: p.landlordId, propertyId: p.propertyId, email })

/** Confirming the read, in the transaction the register's confirm door uses. */
async function confirmRead(p: Park, closing: any, reads: Array<{ meterId: string; value: number }>) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const out = await recordCounterReads(c, {
      landlordId: p.landlordId, propertyId: p.propertyId, userId: p.userId, closing, reads,
    })
    await c.query('COMMIT')
    return out
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

describe('a stay re-dated under thirty nights is back in the rate', () => {
  it('the re-date ends the agreement, and the counter collects nothing from him', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    // 35 nights: his site's power is his to pay, through the stay's agreement.
    const s = await longStayOn(p, { email, from: -10, to: 25 })
    expect(await agreement(s.agreementId)).toMatchObject({ status: 'active', e: await day(25) })

    // The landlord drags him in on the schedule — 10 nights, leaving today.
    const moved = await reDate(p, s.bookingId, { checkOut: await day(0) })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)

    // THE AGREEMENT STOPPED BEING ANYBODY'S PAYER. Ended the day it began: the
    // row is kept, because GAM never erases and the landlord can still see it
    // was made, and it bills nothing anywhere because it covers no day.
    const sa = await agreement(s.agreementId)
    expect(sa.status).toBe('ended')
    expect(sa.e).toBe(sa.s)

    // THE DESK OPENS HIM UP: his own stay, and nobody is the payer for it.
    const look = await lookUp(p, email)
    expect(look.matchedBy).toBe('email')
    expect(look.closings).toHaveLength(1)
    expect(look.closings[0]).toMatchObject({ kind: 'stay', id: s.bookingId, payer: 'in_the_rate' })
    expect(look.closings[0].what).toMatch(/RV 27/)
    // The id that comes back from the browser is re-read, and answers the same.
    const closing = await counterClosingById(db as any, {
      landlordId: p.landlordId, propertyId: p.propertyId, kind: 'stay', id: s.bookingId })
    expect(closing.payer).toBe('in_the_rate')

    // THE READ IS QUOTED AT NOTHING TO COLLECT. The usage is still shown — the
    // desk asked for a read and a blank answer looks like a broken screen — and
    // what is shown is that there is nothing to collect.
    const q = await quoteCounterReads(db as any, {
      landlordId: p.landlordId, propertyId: p.propertyId, closing,
      reads: [{ meterId: p.meterId, value: 48387 }] })
    expect(q[0]).toMatchObject({ block: 'in_the_rate', usage: 387, charge: 0, tax: 0, amount: 0 })
    expect(q[0].note).toMatch(/in the rate they already paid/i)
    // The figure he would have been asked for is nowhere on the screen.
    expect(JSON.stringify(q)).not.toMatch(/87\.77|81\.27/)

    // AND CONFIRMING PUTS NOTHING ON THE TICKET: the read lands, no bill is
    // raised, and the kilowatts go on the book as in-the-rate — the column that
    // reads $0.00 at every property because nothing ever wrote it.
    const done = await confirmRead(p, closing, [{ meterId: p.meterId, value: 48387 }])
    expect(done.lines).toHaveLength(0)
    expect(done.readings).toHaveLength(1)
    expect(done.notes[0]).toMatch(/nothing to collect/i)
    expect(await bills(p.meterId)).toHaveLength(0)
    const rd = await readings(p.meterId)
    expect(rd).toHaveLength(2)
    expect(rd[1]).toMatchObject({ v: '48387', reason: 'move_out_final', needs_review: false })
    const ab = await absorbed(p.meterId)
    expect(ab).toHaveLength(1)
    expect(ab[0]).toMatchObject({ reason: 'short_stay_in_rate', charge: '81.27', tax: '6.50', usage: '387.0000' })

    // Nothing was emailed and nothing went on an invoice, either way (D1).
    expect(await invoiceCount(p.landlordId)).toBe(0)
    expect(emailMock).not.toHaveBeenCalled()
  })

  it('and checking him out does not hand the agreement a real span back', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await longStayOn(p, { email, from: -10, to: 25 })
    expect((await reDate(p, s.bookingId, { checkOut: await day(0) })).status).toBe(200)

    // He leaves, and the check-out save runs the same door again. The branch
    // that follows a corrected day of leaving used to give any ended agreement
    // the stay's check-out as its end date, which would have made this one the
    // payer again on his way out the gate — the one thing the zero length is
    // there to prevent. (A no-show's agreement has always had the same shape
    // and the same exposure.)
    await db.query(`UPDATE unit_bookings SET status = 'checked_out' WHERE id = $1`, [s.bookingId])
    expect(await syncStayUtilityAgreement(s.bookingId, { byUserId: p.userId })).toEqual({ action: 'none' })
    const sa = await agreement(s.agreementId)
    expect(sa.status).toBe('ended')
    expect(sa.e).toBe(sa.s)

    // And the counter still collects nothing from him.
    const closing = await counterClosingById(db as any, {
      landlordId: p.landlordId, propertyId: p.propertyId, kind: 'stay', id: s.bookingId })
    expect(closing.payer).toBe('in_the_rate')
    const done = await confirmRead(p, closing, [{ meterId: p.meterId, value: 48387 }])
    expect(done.lines).toHaveLength(0)
    expect(await bills(p.meterId)).toHaveLength(0)
    expect((await absorbed(p.meterId))[0]).toMatchObject({ reason: 'short_stay_in_rate' })
  })

  it('dragged back out over thirty nights, he pays his own power again', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await longStayOn(p, { email, from: -10, to: 25 })

    // In to 10 nights, then back out to 35 — a landlord correcting a slip.
    expect((await reDate(p, s.bookingId, { checkOut: await day(0) })).status).toBe(200)
    expect((await agreement(s.agreementId)).status).toBe('ended')
    const back = await reDate(p, s.bookingId, { checkOut: await day(25), stayTerms: 'stay' })
    expect(back.status, JSON.stringify(back.body)).toBe(200)

    // The SAME row is the payer again, running to the day he now leaves — the
    // way an undone check-out brings one back. One row per stay, never two.
    expect(await agreement(s.agreementId)).toMatchObject({ status: 'active', e: await day(25) })
    expect((await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM utility_service_agreements WHERE booking_id = $1`,
      [s.bookingId])).rows[0].n).toBe(1)

    // And the counter bills him for his own power again: 387 kWh, $81.27 plus
    // the park's 8%.
    const closing = await counterClosingById(db as any, {
      landlordId: p.landlordId, propertyId: p.propertyId, kind: 'stay', id: s.bookingId })
    expect(closing.payer).toBe('service_agreement')
    const done = await confirmRead(p, closing, [{ meterId: p.meterId, value: 48387 }])
    expect(done.lines).toHaveLength(1)
    expect(done.lines[0].price).toBe(81.27)
    const bl = await bills(p.meterId)
    expect(bl).toHaveLength(1)
    expect(bl[0]).toMatchObject({ charge: '81.27', tax: '6.50', status: 'unbilled' })
    expect(bl[0].service_agreement_id).toBe(s.agreementId)
    expect(await absorbed(p.meterId)).toHaveLength(0)
  })

  it('an agreement that covers no day is nobody\'s payer, whatever the row says', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await longStayOn(p, { email, from: -10, to: 25 })
    // The shape a re-date leaves behind, and the shape a no-show has always
    // left behind: the row is still there, ended the day it began. The old
    // payer test read the row's EXISTENCE, so this billed — and the billing
    // engine, asked the same question properly, would have found nobody, so
    // the kilowatts fell out of the world entirely.
    await db.query(
      `UPDATE utility_service_agreements SET status = 'ended', end_date = start_date WHERE id = $1`,
      [s.agreementId])

    expect((await lookUp(p, email)).closings[0]).toMatchObject({ payer: 'in_the_rate' })
    const closing = await counterClosingById(db as any, {
      landlordId: p.landlordId, propertyId: p.propertyId, kind: 'stay', id: s.bookingId })
    const done = await confirmRead(p, closing, [{ meterId: p.meterId, value: 48387 }])
    expect(done.lines).toHaveLength(0)
    expect(await bills(p.meterId)).toHaveLength(0)
    expect((await absorbed(p.meterId))[0]).toMatchObject({ reason: 'short_stay_in_rate' })
  })

  // ── one box per pole ───────────────────────────────────────────────────────
  //
  // Two boxes for one meter is not a read anybody takes, and left to run the
  // second figure would be priced off the FIRST typed figure the moment the
  // first read landed: the amount read out to the payer and the amount written
  // to the ticket would be different numbers.
  it('refuses the same pole twice at both doors, with nothing written and no figure said', async () => {
    const p = await park()
    const email = `razo-${Math.random().toString(36).slice(2)}@example.com`
    const s = await longStayOn(p, { email, from: -10, to: 25 })
    const closing = await counterClosingById(db as any, {
      landlordId: p.landlordId, propertyId: p.propertyId, kind: 'stay', id: s.bookingId })
    const twice = [{ meterId: p.meterId, value: 48387 }, { meterId: p.meterId, value: 48500 }]

    await expect(quoteCounterReads(db as any, {
      landlordId: p.landlordId, propertyId: p.propertyId, closing, reads: twice,
    })).rejects.toThrow(/a pole is read once/i)
    await expect(confirmRead(p, closing, twice)).rejects.toThrow(/a pole is read once/i)

    // Blind at a refusal too, and nothing landed.
    await expect(quoteCounterReads(db as any, {
      landlordId: p.landlordId, propertyId: p.propertyId, closing, reads: twice,
    })).rejects.toThrow(/^[^\d]*$/)
    expect(await readings(p.meterId)).toHaveLength(1)
    expect(await bills(p.meterId)).toHaveLength(0)
    expect(await absorbed(p.meterId)).toHaveLength(0)
  })
})

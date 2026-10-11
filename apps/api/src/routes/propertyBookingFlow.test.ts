/**
 * S517 / Walkthrough #11 — public property booking + waitlist flow.
 * Stripe Checkout + email are mocked so the state machine is tested without creds.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { processingFeeFor, stayHeldWords } from '@gam/shared'

// 10/5: the booking site builds its own checkout (services/propertyBooking
// createSiteCheckoutSession) so a background check can ride as its own line.
// The confirmation reads the check's fee back off the checkout it was built
// with (M12), so sessions keep their metadata.
const { sessionsCreate, sessionsRetrieve, screeningEmail } = vi.hoisted(() => {
  let n = 0
  const made = new Map<string, any>()
  return {
    sessionsCreate: vi.fn(async (p: any) => {
      const id = `cs_test_${++n}`
      made.set(id, { id, metadata: p.metadata ?? {} })
      return { id, url: 'https://checkout.stripe.test/session' }
    }),
    sessionsRetrieve: vi.fn(async (id: string) => made.get(id) ?? { id, metadata: {} }),
    screeningEmail: vi.fn(async (..._a: any[]) => 'msg_test'),
  }
})
vi.mock('../lib/stripe', async (orig) => {
  const actual = await (orig() as any)
  return { ...actual, getStripe: () => ({ checkout: { sessions: { create: sessionsCreate, retrieve: sessionsRetrieve } } }) }
})
vi.mock('../services/email', async (orig) => {
  const actual = await (orig() as any)
  return {
    ...actual,
    sendNotificationEmail: vi.fn(async () => 'msg_test'),
    emailGuestStayLink: vi.fn(async () => 'msg_test'),
    emailBackgroundCheckScreeningRequest: screeningEmail,
    emailUtilityServiceInvite: vi.fn(async () => 'msg_test'),
  }
})

import express from 'express'
import request from 'supertest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { publicPropertyBookingRouter } from './publicPropertyBooking'
import { confirmBookingDeposit, promoteNextWaitlister, sweepBookingHoldsAndClaims } from '../services/propertyBooking'
import { errorHandler } from '../middleware/errorHandler'
import { todayIn, addDaysTo } from '../lib/timezone'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/public', publicPropertyBookingRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { await cleanupAllSchema(); sessionsCreate.mockClear(); sessionsRetrieve.mockClear(); screeningEmail.mockClear() })

/** The checkout's lines, in cents, by name. */
const lines = (call: any): Record<string, number> => Object.fromEntries(
  call.line_items.map((l: any) => [l.price_data.product_data.name, l.price_data.unit_amount]))

// S654: N days from the property's today (seeded properties default to
// America/Phoenix, the test DB's zone too). Local setDate + UTC toISOString
// jumped a day ahead after 5 pm in Phoenix.
function plusDays(n: number): string {
  return addDaysTo(todayIn(null), n)
}

async function seedSite(opts: { connect?: boolean } = {}) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    if (opts.connect !== false) {
      await client.query(`UPDATE users SET stripe_connect_account_id='acct_test' WHERE id=$1`, [userId])
    }
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(
      `UPDATE properties SET public_booking_enabled=TRUE, booking_slug='sunny', booking_deposit_pct=20 WHERE id=$1`,
      [propertyId])
    const unitId = await seedUnit(client, { propertyId, landlordId })
    await client.query(
      `UPDATE units SET is_bookable=TRUE, lease_types_allowed=ARRAY['nightly','weekly'], nightly_rate=100, weekly_rate=600 WHERE id=$1`,
      [unitId])
    await client.query('COMMIT')
    return { userId, landlordId, propertyId, unitId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

// W-20 (S531): the public contract books a SITE TYPE, not a unit — units
// without a subtype group under the 'general' type. This suite seeds ONE
// bookable unit, so best-fit always lands on it.
const guest = (ci = plusDays(30), co = plusDays(33)) => ({
  siteTypeId: 'general', guestName: 'Pat Guest', guestEmail: 'pat@guest.dev', checkIn: ci, checkOut: co, stayType: 'nightly',
})

describe('POST /book', () => {
  it('happy: tentative hold + deposit checkout', async () => {
    const s = await seedSite()
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
    expect(res.status).toBe(200)
    expect(res.body.data.checkoutUrl).toContain('checkout.stripe.test')
    expect(res.body.data.depositAmount).toBe(60) // 20% of 300
    const bk = await db.query<any>('SELECT * FROM unit_bookings WHERE id=$1', [res.body.data.bookingId])
    expect(bk.rows[0].status).toBe('tentative')
    expect(bk.rows[0].source).toBe('public')
    expect(Number(bk.rows[0].deposit_amount)).toBe(60) // 20% of 300
    expect(bk.rows[0].stripe_checkout_session_id).toMatch(/^cs_test_/)
    expect(bk.rows[0].hold_expires_at).not.toBeNull()
  })

  // S648 (Nic): deposits are card only with the card fee on top, charged by GAM.
  it('the deposit checkout adds the card fee and pays nobody directly', async () => {
    await seedSite()
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
    expect(res.body.data.cardFee).toBe(processingFeeFor({ amount: 60, paymentMethod: 'card' }))
    expect(res.body.data.screeningFee).toBe(0)
    const arg = sessionsCreate.mock.calls.at(-1)![0]
    expect(Object.values(lines(arg))).toEqual([6000, Math.round(processingFeeFor({ amount: 60, paymentMethod: 'card' }) * 100)])
    expect(arg.payment_intent_data.transfer_data).toBeUndefined()
    expect(arg.metadata.gam_purpose).toBe('booking_deposit')
    expect(arg.metadata.gam_booking_id).toBe(res.body.data.bookingId)
    // 10/5 (review): the card page closes with the hold (Stripe's minimum is
    // 30 minutes; the hold is 30, the page a minute more) — never Stripe's
    // 24-hour default, which let a guest pay for a hold the sweep had dropped.
    const left = arg.expires_at - Math.floor(Date.now() / 1000)
    expect(left).toBeGreaterThanOrEqual(30 * 60)
    expect(left).toBeLessThanOrEqual(31 * 60 + 5)
  })

  it('no landlord Connect → 409 in production', async () => {
    const s = await seedSite({ connect: false })
    const prevEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
      expect(res.status).toBe(409)
    } finally { process.env.NODE_ENV = prevEnv }
  })

  it('no landlord Connect outside production → S547 dev-mock checkout, auto-confirmed', async () => {
    const s = await seedSite({ connect: false })
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
    expect(res.status).toBe(200)
    // No Stripe hop: the "checkout" URL is the confirmation page itself.
    expect(res.body.data.checkoutUrl).toContain(`/booked?booking=${res.body.data.bookingId}`)
    const bk = await db.query<any>('SELECT * FROM unit_bookings WHERE id=$1', [res.body.data.bookingId])
    expect(bk.rows[0].status).toBe('confirmed')
    expect(bk.rows[0].deposit_paid_at).not.toBeNull()
    expect(bk.rows[0].stripe_checkout_session_id).toMatch(/^mock_/)
  })

  it('dates already booked → 409 full', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status)
       VALUES ($1,$2,'nightly',$3,$4,'confirmed')`,
      [s.unitId, s.landlordId, plusDays(30), plusDays(33)])
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(31), plusDays(34)))
    expect(res.status).toBe(409)
    expect(res.body.full).toBe(true)
  })

  // S593 defrag: the Master Schedule is the single occupancy truth — a unit
  // under an ACTIVE long-term lease can't be short-term-booked over it.
  it('S593: dates under an active long-term lease → 409 full', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1,$2,1200,'fixed_term','active',$3,$4)`,
      [s.unitId, s.landlordId, plusDays(20), plusDays(60)])
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(31), plusDays(34)))
    expect(res.status).toBe(409)
    expect(res.body.full).toBe(true)
  })

  it('S593: an open-ended (month-to-month, null end) active lease also blocks', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1,$2,1200,'month_to_month','active',$3,NULL)`,
      [s.unitId, s.landlordId, plusDays(1)])
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(31), plusDays(34)))
    expect(res.status).toBe(409)
  })

  it('S593: a PENDING draft lease also blocks (matches the ranker occupancy model)', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1,$2,1200,'fixed_term','pending',$3,$4)`,
      [s.unitId, s.landlordId, plusDays(20), plusDays(60)])
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(31), plusDays(34)))
    expect(res.status).toBe(409)
  })

  it('S593: a terminated lease does NOT block bookings (only active/pending occupy)', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1,$2,1200,'fixed_term','terminated',$3,$4)`,
      [s.unitId, s.landlordId, plusDays(20), plusDays(60)])
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(31), plusDays(34)))
    expect(res.status).toBe(200)
  })
})

describe('deposit confirmation', () => {
  it('confirmBookingDeposit flips tentative → confirmed', async () => {
    const s = await seedSite()
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
    const id = res.body.data.bookingId
    const sess = (await db.query<any>('SELECT stripe_checkout_session_id FROM unit_bookings WHERE id=$1', [id])).rows[0].stripe_checkout_session_id
    await confirmBookingDeposit(id, sess)
    const bk = (await db.query<any>('SELECT * FROM unit_bookings WHERE id=$1', [id])).rows[0]
    expect(bk.status).toBe('confirmed')
    expect(bk.deposit_paid_at).not.toBeNull()
    expect(bk.hold_expires_at).toBeNull()
  })

  it('S648: when the landlord absorbs the fee the guest pays the deposit alone, and the fee comes out of the payout', async () => {
    const s = await seedSite()
    await db.query(`UPDATE properties SET booking_card_fee_payer = 'landlord' WHERE id = $1`, [s.propertyId])
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
    expect(res.body.data.cardFee).toBe(0)
    expect(Object.values(lines(sessionsCreate.mock.calls.at(-1)![0]))).toEqual([6000])
    const id = res.body.data.bookingId
    const sess = (await db.query<any>('SELECT stripe_checkout_session_id FROM unit_bookings WHERE id=$1', [id])).rows[0].stripe_checkout_session_id
    await confirmBookingDeposit(id, sess, { paymentIntentId: 'pi_abs', amountTotalCents: 6000 })
    const held = (await db.query<any>(`SELECT amount FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(Number(held[0].amount)).toBe(Math.round((60 - processingFeeFor({ amount: 60, paymentMethod: 'card' })) * 100) / 100)
  })

  // 10/5 (Nic): "money movement is the end of onboarding."
  it('a deposit paid on the booking site ends the landlord\'s free onboarding window', async () => {
    const s = await seedSite()
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [s.landlordId])
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
    const id = res.body.data.bookingId
    const sess = (await db.query<any>('SELECT stripe_checkout_session_id FROM unit_bookings WHERE id=$1', [id])).rows[0].stripe_checkout_session_id
    const charged = Math.round((60 + processingFeeFor({ amount: 60, paymentMethod: 'card' })) * 100)
    await confirmBookingDeposit(id, sess, { paymentIntentId: 'pi_onboard', amountTotalCents: charged })
    const l = (await db.query<any>(
      `SELECT COALESCE(billing_starts_at = date_trunc('month', now())::date, false) AS ok FROM landlords WHERE id = $1`,
      [s.landlordId])).rows[0]
    expect(l.ok).toBe(true)
  })

  it('S648: a paid deposit is held for the landlord, less the card fee, once', async () => {
    const s = await seedSite()
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
    const id = res.body.data.bookingId
    const sess = (await db.query<any>('SELECT stripe_checkout_session_id FROM unit_bookings WHERE id=$1', [id])).rows[0].stripe_checkout_session_id
    const charged = Math.round((60 + processingFeeFor({ amount: 60, paymentMethod: 'card' })) * 100)
    await confirmBookingDeposit(id, sess, { paymentIntentId: 'pi_dep', amountTotalCents: charged })
    await confirmBookingDeposit(id, sess, { paymentIntentId: 'pi_dep', amountTotalCents: charged })
    const held = (await db.query<any>(`SELECT amount FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(held).toEqual([{ amount: '60.00' }])
    const bk = (await db.query<any>('SELECT stripe_payment_intent_id FROM unit_bookings WHERE id=$1', [id])).rows[0]
    expect(bk.stripe_payment_intent_id).toBe('pi_dep')
    // A second delivery of a confirmed booking is not a payment after the hold.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'booking_paid_after_hold'`)).rows).toHaveLength(0)
  })

  // 10/5 (review): a guest who paid after the sweep dropped the hold. The money
  // is on GAM's account all the same: the landlord's free onboarding ends, and
  // a person is told to refund or rebook — never a silent no-op.
  it('a payment that lands after the hold was dropped ends onboarding and tells a person, once', async () => {
    const s = await seedSite()
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [s.landlordId])
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest())
    const id = res.body.data.bookingId
    const sess = (await db.query<any>('SELECT stripe_checkout_session_id FROM unit_bookings WHERE id=$1', [id])).rows[0].stripe_checkout_session_id
    await db.query(`UPDATE unit_bookings SET hold_expires_at = now() - INTERVAL '1 minute' WHERE id = $1`, [id])
    await sweepBookingHoldsAndClaims()
    const charged = Math.round((60 + processingFeeFor({ amount: 60, paymentMethod: 'card' })) * 100)
    await confirmBookingDeposit(id, sess, { paymentIntentId: 'pi_late', amountTotalCents: charged })
    await confirmBookingDeposit(id, sess, { paymentIntentId: 'pi_late', amountTotalCents: charged })
    const bk = (await db.query<any>('SELECT status, deposit_paid_at FROM unit_bookings WHERE id=$1', [id])).rows[0]
    expect(bk).toMatchObject({ status: 'cancelled', deposit_paid_at: null })
    expect((await db.query<any>(
      `SELECT COALESCE(billing_starts_at = date_trunc('month', now())::date, false) AS ok FROM landlords WHERE id = $1`,
      [s.landlordId])).rows[0].ok).toBe(true)
    const told = (await db.query<any>(
      `SELECT body, context FROM admin_notifications WHERE category = 'booking_paid_after_hold'`)).rows
    expect(told).toHaveLength(1)
    expect(told[0].context).toMatchObject({ booking_id: id, stripe_checkout_session_id: sess, stripe_payment_intent_id: 'pi_late' })
    expect(told[0].body).toMatch(/Refund it in Stripe \(pi_late\)/)
    // Nothing was recorded as the landlord's.
    expect((await db.query(`SELECT 1 FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])).rows).toHaveLength(0)
  })
})

describe('waitlist', () => {
  async function seedFull() {
    const s = await seedSite()
    const blocker = await db.query<any>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status)
       VALUES ($1,$2,'nightly',$3,$4,'confirmed') RETURNING id`,
      [s.unitId, s.landlordId, plusDays(30), plusDays(33)])
    return { ...s, blockerId: blocker.rows[0].id }
  }

  it('join when full → waiting row at position 1', async () => {
    const s = await seedFull()
    const res = await request(buildApp()).post('/api/public/property/sunny/waitlist').send(guest())
    expect(res.status).toBe(200)
    expect(res.body.data.position).toBe(1)
    const w = (await db.query<any>('SELECT * FROM unit_booking_waitlists WHERE id=$1', [res.body.data.waitlistId])).rows[0]
    expect(w.status).toBe('waiting')
  })

  it('cancel frees dates → promote mints a claim token', async () => {
    const s = await seedFull()
    await request(buildApp()).post('/api/public/property/sunny/waitlist').send(guest())
    // free the dates, then promote
    await db.query(`UPDATE unit_bookings SET status='cancelled' WHERE id=$1`, [s.blockerId])
    const promoted = await promoteNextWaitlister(s.unitId)
    expect(promoted).toBe(true)
    const w = (await db.query<any>(`SELECT * FROM unit_booking_waitlists WHERE unit_id=$1`, [s.unitId])).rows[0]
    expect(w.status).toBe('notified')
    expect(w.claim_token).toBeTruthy()
    expect(w.claim_expires_at).not.toBeNull()
  })

  it('promotes a property-wide waiter (unit_id NULL) and pins it to the freed unit', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO unit_booking_waitlists (unit_id, property_id, landlord_id, guest_name, guest_email, check_in, check_out)
       VALUES (NULL,$1,$2,'Pat','pat@g.dev',$3,$4)`,
      [s.propertyId, s.landlordId, plusDays(30), plusDays(33)])
    const promoted = await promoteNextWaitlister(s.unitId)
    expect(promoted).toBe(true)
    const w = (await db.query<any>(`SELECT * FROM unit_booking_waitlists WHERE property_id=$1`, [s.propertyId])).rows[0]
    expect(w.status).toBe('notified')
    expect(w.unit_id).toBe(s.unitId) // pinned to the unit that freed up
  })

  it('promote is a no-op while dates still booked', async () => {
    const s = await seedFull()
    await request(buildApp()).post('/api/public/property/sunny/waitlist').send(guest())
    const promoted = await promoteNextWaitlister(s.unitId) // blocker still confirmed
    expect(promoted).toBe(false)
  })

  it('claim → tentative booking + deposit checkout', async () => {
    const s = await seedFull()
    await request(buildApp()).post('/api/public/property/sunny/waitlist').send(guest())
    await db.query(`UPDATE unit_bookings SET status='cancelled' WHERE id=$1`, [s.blockerId])
    await promoteNextWaitlister(s.unitId)
    const token = (await db.query<any>(`SELECT claim_token FROM unit_booking_waitlists WHERE unit_id=$1`, [s.unitId])).rows[0].claim_token

    const info = await request(buildApp()).get(`/api/public/property/sunny/claim/${token}`)
    expect(info.status).toBe(200)
    expect(info.body.data.expired).toBe(false)

    const res = await request(buildApp()).post(`/api/public/property/sunny/claim/${token}`).send({ stayType: 'nightly' })
    expect(res.status).toBe(200)
    expect(res.body.data.checkoutUrl).toBeTruthy()
    const w = (await db.query<any>(`SELECT * FROM unit_booking_waitlists WHERE unit_id=$1`, [s.unitId])).rows[0]
    expect(w.status).toBe('claimed')
    expect(w.claimed_booking_id).toBe(res.body.data.bookingId)
  })
})

describe('sweep', () => {
  it('expires abandoned holds and stale claims, promotes next', async () => {
    const s = await seedSite()
    // abandoned tentative hold (past expiry) blocking the dates
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status, hold_expires_at)
       VALUES ($1,$2,'nightly',$3,$4,'tentative', now() - interval '1 minute')`,
      [s.unitId, s.landlordId, plusDays(30), plusDays(33)])
    // a guest waiting on those dates
    await request(buildApp()).post('/api/public/property/sunny/waitlist').send(guest())

    const r = await sweepBookingHoldsAndClaims()
    expect(r.holdsExpired).toBe(1)
    expect(r.promoted).toBe(1)
    const w = (await db.query<any>(`SELECT status FROM unit_booking_waitlists WHERE unit_id=$1`, [s.unitId])).rows[0]
    expect(w.status).toBe('notified')
  })
})

// ── 10/5 (Nic): PREPAID STAYS on the booking site ─────────────────────────────
//
//   "If they're booking online, it will ask them a lease guarantees your spot
//    indefinitely and the stay only guarantees it for the time that you've
//    paid ahead of time. ... If they choose to do the lease, then it drafts
//    one for me."
describe('10/5 long stays on the booking site', () => {
  const round2 = (n: number) => Math.round(n * 100) / 100
  const cents = (n: number) => Math.round(n * 100)

  async function seedLongSite(opts: { connect?: boolean } = {}) {
    const s = await seedSite(opts)
    await db.query(`UPDATE units SET monthly_rate = 900 WHERE id = $1`, [s.unitId])
    return s
  }
  /** The background check's fixed line: the applicant intake price before processing. */
  async function checkFee(): Promise<number> {
    const { screeningIntakeFee } = await import('./background')
    const f = await screeningIntakeFee(null)
    return round2(f.screening + f.gamFee + f.tax)
  }
  const monthOut = (ymd: string) => DateTime.fromISO(ymd).plus({ months: 1 }).toISODate()!
  const sessionOf = async (id: string) =>
    (await db.query<any>('SELECT stripe_checkout_session_id FROM unit_bookings WHERE id=$1', [id])).rows[0].stripe_checkout_session_id

  it('R2: a 30+ night stay is not booked until the guest chooses a lease or a stay', async () => {
    await seedLongSite()
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(10), plusDays(75)))
    expect(res.status).toBe(409)
    expect(res.body.needsStayTerms).toBe(true)
    expect(res.body.words).toBe("A lease holds your site for as long as you stay. A stay holds it only through the time you've paid for.")
    expect((await db.query('SELECT 1 FROM unit_bookings')).rows).toHaveLength(0)
    expect(sessionsCreate).not.toHaveBeenCalled()
  })

  it('STAY (R5): books and charges the first calendar month only, the check as its own line, held-through words', async () => {
    await seedLongSite()
    const fee = await checkFee()
    const ci = plusDays(10)
    const res = await request(buildApp()).post('/api/public/property/sunny/book')
      .send({ ...guest(ci, plusDays(75)), stayTerms: 'stay' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const out = monthOut(ci)
    const b = (await db.query<any>(
      `SELECT check_out::text AS check_out, stay_terms, screening_required, deposit_amount::text, total_amount::text, lease_type
         FROM unit_bookings WHERE id = $1`, [res.body.data.bookingId])).rows[0]
    expect(b).toEqual({ check_out: out, stay_terms: 'stay', screening_required: true,
                        deposit_amount: '900.00', total_amount: '900.00', lease_type: 'month_to_month' })
    const card = processingFeeFor({ amount: 900 + fee, paymentMethod: 'card' })
    expect(res.body.data).toMatchObject({
      checkOut: out, stayTerms: 'stay', depositAmount: 900, screeningFee: fee, cardFee: card,
      dueNow: round2(900 + fee + card), heldWords: stayHeldWords(out),
    })
    const l = lines(sessionsCreate.mock.calls.at(-1)![0])
    expect(Object.values(l)).toEqual([90000, cents(fee), cents(card)])
    expect(Object.keys(l)[1]).toMatch(/^Background check/)
    expect(sessionsCreate.mock.calls.at(-1)![0].metadata.gam_screening_fee).toBe(fee.toFixed(2))
  })

  it('R3: nothing is drafted at the hold; a STAY once paid is recorded, the check prepaid, the landlord told — no lease', async () => {
    const s = await seedLongSite()
    const fee = await checkFee()
    const res = await request(buildApp()).post('/api/public/property/sunny/book')
      .send({ ...guest(plusDays(10), plusDays(75)), stayTerms: 'stay' })
    const id = res.body.data.bookingId
    expect((await db.query('SELECT 1 FROM leases WHERE source_booking_id = $1', [id])).rows).toHaveLength(0)

    await confirmBookingDeposit(id, await sessionOf(id), { paymentIntentId: 'pi_stay', amountTotalCents: cents(res.body.data.dueNow) })
    expect((await db.query('SELECT 1 FROM leases WHERE source_booking_id = $1', [id])).rows).toHaveLength(0)
    const n = (await db.query<any>(`SELECT type FROM notifications WHERE data->>'bookingId' = $1`, [id])).rows
    expect(n.map(r => r.type)).toEqual(['long_stay_no_lease'])
    const sp = (await db.query<any>(`SELECT amount::text, source, status FROM screening_prepayments WHERE booking_id = $1`, [id])).rows
    expect(sp).toEqual([{ amount: fee.toFixed(2), source: 'booking_site', status: 'unused' }])
    expect(screeningEmail).toHaveBeenCalledTimes(1)
    // The landlord's payout holds the month, never GAM's screening money.
    const held = (await db.query<any>(`SELECT amount::text, description FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(held).toEqual([{ amount: '900.00', description: 'Stay payment' }])
    // 10/5 (Nic, A5): paid online, the check's money is already on GAM's
    // balance — nothing is charged back to the landlord (never both).
    const charge = (await db.query<any>(`SELECT kind, amount::text FROM landlord_gam_charges WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(charge).toEqual([])
  })

  it('LEASE (R4): today\'s deposit and the check; once paid a month-to-month draft lease waits for the landlord', async () => {
    const s = await seedLongSite()
    const fee = await checkFee()
    const res = await request(buildApp()).post('/api/public/property/sunny/book')
      .send({ ...guest(plusDays(10), plusDays(75)), stayTerms: 'lease' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const id = res.body.data.bookingId
    // The flat long-stay deposit ($150 default, capped at a month), the whole stay asked for.
    expect(res.body.data).toMatchObject({ depositAmount: 150, screeningFee: fee, stayTerms: 'lease', heldWords: null, checkOut: plusDays(75) })
    expect((await db.query('SELECT 1 FROM leases WHERE source_booking_id = $1', [id])).rows).toHaveLength(0)

    const charged = cents(res.body.data.dueNow)
    await confirmBookingDeposit(id, await sessionOf(id), { paymentIntentId: 'pi_lease', amountTotalCents: charged })
    const lease = (await db.query<any>(
      `SELECT lease_type, status, end_date, lease_source FROM leases WHERE source_booking_id = $1`, [id])).rows
    expect(lease).toEqual([{ lease_type: 'month_to_month', status: 'pending', end_date: null, lease_source: 'booking_draft' }])
    const n = (await db.query<any>(`SELECT type FROM notifications WHERE data->>'bookingId' = $1`, [id])).rows
    expect(n.map(r => r.type)).toEqual(['lease_drafted_from_booking'])
    // An early check-out gives back only the stay's share — never the check.
    const pay = (await db.query<any>(`SELECT toward_stay::text FROM stay_payments WHERE booking_id = $1`, [id])).rows
    expect(pay).toEqual([{ toward_stay: '150.00' }])
    const held = (await db.query<any>(`SELECT amount::text FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(held).toEqual([{ amount: '150.00' }])
  })

  // 10/5 (review): a checkout that carried nothing for the stay — the check
  // alone — is GAM's screening money, not the company's payers', so it does
  // not end free onboarding (the line billingActivation draws).
  it('a checkout for the background check alone does not end the landlord\'s free onboarding', async () => {
    const s = await seedLongSite()
    await db.query(`UPDATE properties SET booking_monthly_deposit = 0 WHERE id = $1`, [s.propertyId])
    await db.query(`UPDATE landlords SET billing_starts_at = NULL WHERE id = $1`, [s.landlordId])
    const res = await request(buildApp()).post('/api/public/property/sunny/book')
      .send({ ...guest(plusDays(10), plusDays(75)), stayTerms: 'lease' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ depositAmount: 0, screeningFee: await checkFee() })
    const id = res.body.data.bookingId
    await confirmBookingDeposit(id, await sessionOf(id), { paymentIntentId: 'pi_check_only', amountTotalCents: cents(res.body.data.dueNow) })
    expect((await db.query<any>('SELECT status FROM unit_bookings WHERE id=$1', [id])).rows[0].status).toBe('confirmed')
    expect((await db.query<any>('SELECT billing_starts_at FROM landlords WHERE id = $1', [s.landlordId])).rows[0].billing_starts_at).toBeNull()
  })

  it('a stay of 22–29 nights carries the check but asks nothing', async () => {
    await seedLongSite()
    const fee = await checkFee()
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(10), plusDays(35)))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ screeningFee: fee, stayTerms: null, heldWords: null })
    const b = (await db.query<any>(`SELECT stay_terms, screening_required FROM unit_bookings WHERE id = $1`, [res.body.data.bookingId])).rows[0]
    expect(b).toEqual({ stay_terms: null, screening_required: true })
  })

  it('M12: the check recorded is the one the checkout charged, even if a check came on file since the hold', async () => {
    const s = await seedLongSite()
    const fee = await checkFee()
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(10), plusDays(35)))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const id = res.body.data.bookingId
    const deposit = res.body.data.depositAmount
    // Between the hold and the payment, a paid check lands for this guest —
    // stayNeeds would now say none is due, but the money was already charged.
    await db.query(
      `INSERT INTO screening_prepayments (landlord_id, email, amount, source, status)
       VALUES ($1, $2, $3, 'register', 'unused')`, [s.landlordId, guest(plusDays(10), plusDays(35)).guestEmail, fee])
    sessionsRetrieve.mockClear()
    await confirmBookingDeposit(id, await sessionOf(id), { paymentIntentId: 'pi_m12', amountTotalCents: cents(res.body.data.dueNow) })
    expect(sessionsRetrieve).toHaveBeenCalledTimes(1)
    const sp = (await db.query<any>(`SELECT amount::text, source FROM screening_prepayments WHERE booking_id = $1`, [id])).rows
    expect(sp).toEqual([{ amount: fee.toFixed(2), source: 'booking_site' }])
    // GAM's check money stays out of the landlord's held share (A5).
    const held = (await db.query<any>(`SELECT amount::text FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(held).toEqual([{ amount: deposit.toFixed(2) }])
    expect((await db.query(`SELECT 1 FROM landlord_gam_charges WHERE landlord_id = $1`, [s.landlordId])).rows).toHaveLength(0)
  })

  it('a checkout that carried no check records no screening and holds the stay part as before', async () => {
    const s = await seedLongSite()
    const res = await request(buildApp()).post('/api/public/property/sunny/book').send(guest(plusDays(10), plusDays(35)))
    const id = res.body.data.bookingId
    const deposit = res.body.data.depositAmount
    const charged = cents(deposit + processingFeeFor({ amount: deposit, paymentMethod: 'card' }))
    // The caller holding the session passes its (absent) gam_screening_fee.
    await confirmBookingDeposit(id, await sessionOf(id), { paymentIntentId: 'pi_x', amountTotalCents: charged, screeningFee: null })
    expect((await db.query('SELECT 1 FROM screening_prepayments')).rows).toHaveLength(0)
    const held = (await db.query<any>(`SELECT amount::text FROM held_payout_items WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(held).toEqual([{ amount: deposit.toFixed(2) }])
  })

  it('the confirmation page says what the choice means (R13)', async () => {
    await seedLongSite({ connect: false })   // dev-mock: confirmed at once
    const ci = plusDays(10)
    const res = await request(buildApp()).post('/api/public/property/sunny/book')
      .send({ ...guest(ci, plusDays(75)), stayTerms: 'stay' })
    const page = await request(buildApp()).get(`/api/public/property/sunny/booking/${res.body.data.bookingId}`)
    expect(page.body.data).toMatchObject({ status: 'confirmed', leaseChosen: false, heldWords: stayHeldWords(monthOut(ci)) })
  })

  it('a 30+ night waitlist claim asks the same question, then books', async () => {
    const s = await seedLongSite()
    await db.query(
      `INSERT INTO unit_booking_waitlists (unit_id, property_id, landlord_id, guest_name, guest_email, check_in, check_out)
       VALUES ($1,$2,$3,'Pat','pat@guest.dev',$4,$5)`,
      [s.unitId, s.propertyId, s.landlordId, plusDays(10), plusDays(75)])
    await promoteNextWaitlister(s.unitId)
    const token = (await db.query<any>(`SELECT claim_token FROM unit_booking_waitlists WHERE unit_id=$1`, [s.unitId])).rows[0].claim_token

    const info = await request(buildApp()).get(`/api/public/property/sunny/claim/${token}`)
    expect(info.body.data.quote).toMatchObject({ askStayTerms: true, lease: { dueNow: { stay: 150 } }, stay: { dueNow: { stay: 900 } } })

    const no = await request(buildApp()).post(`/api/public/property/sunny/claim/${token}`).send({})
    expect(no.status).toBe(409)
    expect(no.body.needsStayTerms).toBe(true)
    const yes = await request(buildApp()).post(`/api/public/property/sunny/claim/${token}`).send({ stayTerms: 'stay' })
    expect(yes.status, JSON.stringify(yes.body)).toBe(200)
    expect(yes.body.data.stayTerms).toBe('stay')
  })
})

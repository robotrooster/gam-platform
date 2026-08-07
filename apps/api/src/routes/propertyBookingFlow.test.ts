/**
 * S517 / Walkthrough #11 — public property booking + waitlist flow.
 * Stripe Checkout + email are mocked so the state machine is tested without creds.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

let sessionN = 0
vi.mock('../services/stripeConnect', async (orig) => {
  const actual = await (orig() as any)
  return {
    ...actual,
    createBookingDepositCheckoutSession: vi.fn(async () => ({
      sessionId: `cs_test_${++sessionN}`,
      hostedUrl: 'https://checkout.stripe.test/session',
    })),
  }
})
vi.mock('../services/email', async (orig) => {
  const actual = await (orig() as any)
  return { ...actual, sendNotificationEmail: vi.fn(async () => 'msg_test') }
})

import express from 'express'
import request from 'supertest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { publicPropertyBookingRouter } from './publicPropertyBooking'
import { confirmBookingDeposit, promoteNextWaitlister, sweepBookingHoldsAndClaims } from '../services/propertyBooking'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/public', publicPropertyBookingRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { await cleanupAllSchema() })

function plusDays(n: number): string {
  const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10)
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
      `UPDATE properties SET public_booking_enabled=TRUE, booking_slug='sunny', booking_deposit_pct=25 WHERE id=$1`,
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
    expect(res.body.data.depositAmount).toBe(75) // 25% of 300
    const bk = await db.query<any>('SELECT * FROM unit_bookings WHERE id=$1', [res.body.data.bookingId])
    expect(bk.rows[0].status).toBe('tentative')
    expect(bk.rows[0].source).toBe('public')
    expect(Number(bk.rows[0].deposit_amount)).toBe(75)
    expect(bk.rows[0].stripe_checkout_session_id).toMatch(/^cs_test_/)
    expect(bk.rows[0].hold_expires_at).not.toBeNull()
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

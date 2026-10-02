/**
 * S517 / Walkthrough #11 — public per-property booking site, read APIs.
 * Stage 2: GET profile + GET availability (unauthenticated, slug-keyed).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Settings } from 'luxon'
import express from 'express'
import request from 'supertest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { publicPropertyBookingRouter, computeStayTotal } from './publicPropertyBooking'
import { errorHandler } from '../middleware/errorHandler'
import { todayIn, addDaysTo } from '../lib/timezone'

const { emailGuestStayLinkMock } = vi.hoisted(() => ({
  emailGuestStayLinkMock: vi.fn(async () => 'msg'),
}))
vi.mock('../services/email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailGuestStayLink: emailGuestStayLinkMock }
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/public', publicPropertyBookingRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { await cleanupAllSchema(); emailGuestStayLinkMock.mockClear() })

// date N days from today, as YYYY-MM-DD (avoids coupling to a fixed clock)
// S654: N days from the property's today (seeded properties default to
// America/Phoenix, the test DB's zone too). Local setDate + UTC toISOString
// jumped a day ahead after 5 pm in Phoenix.
function plusDays(n: number): string {
  return addDaysTo(todayIn(null), n)
}

async function seedSite(opts: { enabled?: boolean; minStay?: number } = {}) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(
      `UPDATE properties SET public_booking_enabled=$1, booking_slug='sunny-rv-park',
              booking_intro='Welcome', booking_deposit_pct=20 WHERE id=$2`,
      [opts.enabled !== false, propertyId])
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    await client.query(
      `UPDATE units SET is_bookable=TRUE, lease_types_allowed=ARRAY['nightly','weekly'],
              nightly_rate=100, weekly_rate=600, min_stay_nights=$2 WHERE id=$1`,
      [unitId, opts.minStay ?? null])
    await client.query('COMMIT')
    return { landlordId, propertyId, unitId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

// ── computeStayTotal (pure) ──────────────────────────────────
describe('computeStayTotal', () => {
  it('nightly = nights × rate', () => {
    expect(computeStayTotal('nightly', 3, 100, 600)).toBe(300)
  })
  it('weekly = whole weeks at weekly_rate + remainder nights at nightly', () => {
    expect(computeStayTotal('weekly', 7, 100, 600)).toBe(600)
    expect(computeStayTotal('weekly', 9, 100, 600)).toBe(800) // 600 + 2×100
  })
  it('returns null when the chosen rate is missing', () => {
    expect(computeStayTotal('nightly', 3, null, 600)).toBeNull()
    expect(computeStayTotal('weekly', 7, 100, null)).toBeNull()
  })
})

// ── GET /property/:slug ──────────────────────────────────────
describe('GET /api/public/property/:slug', () => {
  it('returns profile + site TYPES (W-20: no per-unit inventory)', async () => {
    await seedSite()
    const res = await request(buildApp()).get('/api/public/property/sunny-rv-park')
    expect(res.status).toBe(200)
    expect(res.body.data.property.name).toBe('Test Property')
    expect(res.body.data.property.depositPct).toBe(20)
    // Units without a subtype pool into the 'general' type; unit numbers
    // are never exposed to the public payload.
    expect(res.body.data.siteTypes).toHaveLength(1)
    expect(res.body.data.siteTypes[0].id).toBe('general')
    expect(res.body.data.siteTypes[0].nightlyRate).toBe(100)
    expect(res.body.data.siteTypes[0].siteCount).toBe(1)
    expect(JSON.stringify(res.body.data)).not.toMatch(/unitNumber/)
  })

  it('unknown slug → 404', async () => {
    const res = await request(buildApp()).get('/api/public/property/nope')
    expect(res.status).toBe(404)
  })

  it('disabled site → 404', async () => {
    await seedSite({ enabled: false })
    const res = await request(buildApp()).get('/api/public/property/sunny-rv-park')
    expect(res.status).toBe(404)
  })
})

// ── GET /property/:slug/availability ─────────────────────────
describe('GET availability', () => {
  it('free dates → available with price + deposit', async () => {
    const s = await seedSite()
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?siteTypeId=general&checkIn=${plusDays(30)}&checkOut=${plusDays(33)}&stayType=nightly`)
    expect(res.status).toBe(200)
    expect(res.body.data.available).toBe(true)
    expect(res.body.data.nights).toBe(3)
    expect(res.body.data.total).toBe(300)
    expect(res.body.data.depositAmount).toBe(60) // 20% of 300
  })

  it('weekly pricing uses weekly_rate', async () => {
    const s = await seedSite()
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?siteTypeId=general&checkIn=${plusDays(30)}&checkOut=${plusDays(37)}&stayType=weekly`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(600)
    expect(res.body.data.depositAmount).toBe(120) // 20% of 600
  })

  it('overlapping booking → unavailable (booked)', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status)
       VALUES ($1,$2,'nightly',$3,$4,'confirmed')`,
      [s.unitId, s.landlordId, plusDays(30), plusDays(33)])
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?siteTypeId=general&checkIn=${plusDays(31)}&checkOut=${plusDays(34)}&stayType=nightly`)
    expect(res.status).toBe(200)
    expect(res.body.data.available).toBe(false)
    expect(res.body.data.unavailableReason).toBe('booked')
  })

  it('expired unpaid hold does NOT block', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status, hold_expires_at)
       VALUES ($1,$2,'nightly',$3,$4,'tentative', now() - interval '1 hour')`,
      [s.unitId, s.landlordId, plusDays(30), plusDays(33)])
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?siteTypeId=general&checkIn=${plusDays(30)}&checkOut=${plusDays(33)}&stayType=nightly`)
    expect(res.body.data.available).toBe(true)
  })

  it('below min stay → unavailable', async () => {
    const s = await seedSite({ minStay: 3 })
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?siteTypeId=general&checkIn=${plusDays(30)}&checkOut=${plusDays(31)}&stayType=nightly`)
    expect(res.body.data.available).toBe(false)
    expect(res.body.data.unavailableReason).toMatch(/Minimum stay/)
  })

  it('past check-in → 400', async () => {
    const s = await seedSite()
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?siteTypeId=general&checkIn=${plusDays(-5)}&checkOut=${plusDays(2)}&stayType=nightly`)
    expect(res.status).toBe(400)
  })
})

// ── S654: "past" is the park's calendar, not the server's ────
describe('same-day check-in on the property calendar', () => {
  it('a check-in for today, booked at 6 pm Phoenix on a UTC server, is not "in the past"', async () => {
    await seedSite()
    const today = todayIn('America/Phoenix')
    // 6 pm Phoenix = 01:00 UTC the next day. The server runs on UTC, so its
    // own "today" has already turned over; the park's has not.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${today}T18:00:00-07:00`))
    const prevZone = Settings.defaultZone
    Settings.defaultZone = 'UTC'
    try {
      const res = await request(buildApp())
        .post('/api/public/property/sunny-rv-park/waitlist')
        .send({ siteTypeId: 'general', guestName: 'Pat Guest', guestEmail: 'pat@example.com',
                checkIn: today, checkOut: addDaysTo(today, 2) })
      expect(res.status).toBe(200)
      expect(res.body.data.position).toBe(1)

      // Yesterday on the park's calendar is still refused.
      const past = await request(buildApp())
        .post('/api/public/property/sunny-rv-park/waitlist')
        .send({ siteTypeId: 'general', guestName: 'Pat Guest', guestEmail: 'pat@example.com',
                checkIn: addDaysTo(today, -1), checkOut: addDaysTo(today, 2) })
      expect(past.status).toBe(400)
      expect(JSON.stringify(past.body)).toMatch(/in the past/)
    } finally {
      Settings.defaultZone = prevZone
      vi.useRealTimers()
    }
  })

  // S654: the booking site asks availability before it books, so this route
  // has to agree with the book path on what "today" is.
  it('availability for today, asked at 6 pm Phoenix on a UTC server, is allowed', async () => {
    await seedSite()
    const today = todayIn('America/Phoenix')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${today}T18:00:00-07:00`))
    const prevZone = Settings.defaultZone
    Settings.defaultZone = 'UTC'
    try {
      const res = await request(buildApp())
        .get(`/api/public/property/sunny-rv-park/availability?siteTypeId=general&checkIn=${today}&checkOut=${addDaysTo(today, 2)}&stayType=nightly`)
      expect(res.status).toBe(200)
      expect(res.body.data.available).toBe(true)

      const past = await request(buildApp())
        .get(`/api/public/property/sunny-rv-park/availability?siteTypeId=general&checkIn=${addDaysTo(today, -1)}&checkOut=${addDaysTo(today, 2)}&stayType=nightly`)
      expect(past.status).toBe(400)
      expect(JSON.stringify(past.body)).toMatch(/in the past/)
    } finally {
      Settings.defaultZone = prevZone
      vi.useRealTimers()
    }
  })
})

// ── S654: "still staying" is the park's calendar, not the database's ────
describe('POST stay-link', () => {
  it("links only stays that have not checked out on the park's calendar", async () => {
    const s = await seedSite()
    // A zone far from the database's, so the two days differ most of the time.
    await db.query(`UPDATE properties SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [s.propertyId])
    const parkToday = todayIn('Pacific/Kiritimati')
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, status)
       VALUES ($1, $2, 'Gone Guest',  'pat@example.com', 'nightly', $3, $4, 'confirmed'),
              ($1, $2, 'Here Guest',  'pat@example.com', 'nightly', $4, $5, 'confirmed')`,
      [s.unitId, s.landlordId, addDaysTo(parkToday, -4), addDaysTo(parkToday, -1), addDaysTo(parkToday, 2)])
    const res = await request(buildApp())
      .post('/api/public/property/sunny-rv-park/stay-link')
      .send({ email: 'pat@example.com' })
    expect(res.status).toBe(200)
    expect(emailGuestStayLinkMock).toHaveBeenCalledTimes(1)
    expect((emailGuestStayLinkMock.mock.calls as any[][])[0][1]).toBe('Here Guest')
  })
})

// ── S654: the claim landing names calendar days ────
describe('GET claim link', () => {
  it("returns the stay's dates as YYYY-MM-DD", async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO unit_booking_waitlists
         (unit_id, property_id, landlord_id, guest_name, guest_email, check_in, check_out,
          status, claim_token, notified_at, claim_expires_at)
       VALUES ($1,$2,$3,'Pat Guest','pat@example.com',$4,$5,'notified','tok-s654',now(),now() + interval '1 hour')`,
      [s.unitId, s.propertyId, s.landlordId, plusDays(10), plusDays(12)])
    const res = await request(buildApp()).get('/api/public/property/sunny-rv-park/claim/tok-s654')
    expect(res.status).toBe(200)
    expect(res.body.data.checkIn).toBe(plusDays(10))
    expect(res.body.data.checkOut).toBe(plusDays(12))
    expect(res.body.data.expired).toBe(false)
  })
})

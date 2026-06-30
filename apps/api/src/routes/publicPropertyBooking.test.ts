/**
 * S517 / Walkthrough #11 — public per-property booking site, read APIs.
 * Stage 2: GET profile + GET availability (unauthenticated, slug-keyed).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { publicPropertyBookingRouter, computeStayTotal } from './publicPropertyBooking'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/public', publicPropertyBookingRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { await cleanupAllSchema() })

// date N days from today, as YYYY-MM-DD (avoids coupling to a fixed clock)
function plusDays(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

async function seedSite(opts: { enabled?: boolean; minStay?: number } = {}) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(
      `UPDATE properties SET public_booking_enabled=$1, booking_slug='sunny-rv-park',
              booking_intro='Welcome', booking_deposit_pct=25 WHERE id=$2`,
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
  it('returns profile + bookable units', async () => {
    const s = await seedSite()
    const res = await request(buildApp()).get('/api/public/property/sunny-rv-park')
    expect(res.status).toBe(200)
    expect(res.body.data.property.name).toBe('Test Property')
    expect(res.body.data.property.depositPct).toBe(25)
    expect(res.body.data.units).toHaveLength(1)
    expect(res.body.data.units[0].nightlyRate).toBe(100)
    expect(res.body.data.units[0].stayTypes).toEqual(['nightly', 'weekly'])
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
      .get(`/api/public/property/sunny-rv-park/availability?unitId=${s.unitId}&checkIn=${plusDays(30)}&checkOut=${plusDays(33)}&stayType=nightly`)
    expect(res.status).toBe(200)
    expect(res.body.data.available).toBe(true)
    expect(res.body.data.nights).toBe(3)
    expect(res.body.data.total).toBe(300)
    expect(res.body.data.depositAmount).toBe(75) // 25% of 300
  })

  it('weekly pricing uses weekly_rate', async () => {
    const s = await seedSite()
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?unitId=${s.unitId}&checkIn=${plusDays(30)}&checkOut=${plusDays(37)}&stayType=weekly`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(600)
    expect(res.body.data.depositAmount).toBe(150)
  })

  it('overlapping booking → unavailable (booked)', async () => {
    const s = await seedSite()
    await db.query(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status)
       VALUES ($1,$2,'nightly',$3,$4,'confirmed')`,
      [s.unitId, s.landlordId, plusDays(30), plusDays(33)])
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?unitId=${s.unitId}&checkIn=${plusDays(31)}&checkOut=${plusDays(34)}&stayType=nightly`)
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
      .get(`/api/public/property/sunny-rv-park/availability?unitId=${s.unitId}&checkIn=${plusDays(30)}&checkOut=${plusDays(33)}&stayType=nightly`)
    expect(res.body.data.available).toBe(true)
  })

  it('below min stay → unavailable', async () => {
    const s = await seedSite({ minStay: 3 })
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?unitId=${s.unitId}&checkIn=${plusDays(30)}&checkOut=${plusDays(31)}&stayType=nightly`)
    expect(res.body.data.available).toBe(false)
    expect(res.body.data.unavailableReason).toMatch(/Minimum stay/)
  })

  it('past check-in → 400', async () => {
    const s = await seedSite()
    const res = await request(buildApp())
      .get(`/api/public/property/sunny-rv-park/availability?unitId=${s.unitId}&checkIn=${plusDays(-5)}&checkOut=${plusDays(2)}&stayType=nightly`)
    expect(res.status).toBe(400)
  })
})

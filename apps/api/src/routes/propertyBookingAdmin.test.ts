/**
 * S517 / Walkthrough #11 — landlord booking-site config + waitlist view.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { propertyBookingAdminRouter } from './propertyBookingAdmin'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', propertyBookingAdminRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_booking'
})

async function seed() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const a = await seedLandlord(c)
    const b = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: a.landlordId, ownerUserId: a.userId, managedByUserId: a.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: a.landlordId })
    await c.query('COMMIT')
    const sign = (uid: string, lid: string) => jwt.sign({ userId: uid, role: 'landlord', email: 'x@t.dev', profileId: lid, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { propertyId, unitId, landlordId: a.landlordId, tokenA: sign(a.userId, a.landlordId), tokenB: sign(b.userId, b.landlordId) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('PATCH /properties/:id/booking-config', () => {
  it('sets slug + enables; GET reflects it', async () => {
    const f = await seed()
    const res = await request(buildApp()).patch(`/api/properties/${f.propertyId}/booking-config`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ slug: 'my-rv-park', enabled: true, depositPct: 30 })
    expect(res.status).toBe(200)
    expect(res.body.data.slug).toBe('my-rv-park')
    expect(res.body.data.enabled).toBe(true)
    expect(res.body.data.depositPct).toBe(30)
    const get = await request(buildApp()).get(`/api/properties/${f.propertyId}/booking-config`).set('Authorization', `Bearer ${f.tokenA}`)
    expect(get.body.data.slug).toBe('my-rv-park')
  })

  it('sets stay rates + short-term tax; preserves unmentioned rates', async () => {
    const f = await seed()
    const a = await request(buildApp()).patch(`/api/properties/${f.propertyId}/booking-config`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ nightlyRate: 100, weeklyRate: 600, monthlyRate: 2000, shortTermTaxRate: 12 })
    expect(a.status).toBe(200)
    expect(a.body.data.nightlyRate).toBe(100)
    expect(a.body.data.shortTermTaxRate).toBe(12)
    // touching only the nightly rate must keep weekly/monthly/tax intact
    const b = await request(buildApp()).patch(`/api/properties/${f.propertyId}/booking-config`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ nightlyRate: 125 })
    expect(b.body.data.nightlyRate).toBe(125)
    expect(b.body.data.weeklyRate).toBe(600)
    expect(b.body.data.monthlyRate).toBe(2000)
    expect(b.body.data.shortTermTaxRate).toBe(12)
  })

  it('enabling without a slug → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).patch(`/api/properties/${f.propertyId}/booking-config`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ enabled: true })
    expect(res.status).toBe(400)
  })

  it('bad slug format → 400', async () => {
    const f = await seed()
    const res = await request(buildApp()).patch(`/api/properties/${f.propertyId}/booking-config`)
      .set('Authorization', `Bearer ${f.tokenA}`).send({ slug: 'Bad Slug!!' })
    expect(res.status).toBe(400)
  })

  it('duplicate slug → 409', async () => {
    const f = await seed()
    await db.query(`UPDATE properties SET booking_slug='taken' WHERE id=$1`, [f.propertyId])
    const other = await getClient()
    let otherProp = ''
    try {
      await other.query('BEGIN')
      const l = await seedLandlord(other)
      otherProp = await seedProperty(other, { landlordId: l.landlordId, ownerUserId: l.userId, managedByUserId: l.userId })
      const tok = jwt.sign({ userId: l.userId, role: 'landlord', email: 'o@t.dev', profileId: l.landlordId, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
      await other.query('COMMIT')
      const res = await request(buildApp()).patch(`/api/properties/${otherProp}/booking-config`)
        .set('Authorization', `Bearer ${tok}`).send({ slug: 'taken' })
      expect(res.status).toBe(409)
    } finally { other.release() }
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp()).patch(`/api/properties/${f.propertyId}/booking-config`)
      .set('Authorization', `Bearer ${f.tokenB}`).send({ slug: 'nope' })
    expect(res.status).toBe(403)
  })
})

describe('POST /properties/:id/waitlist', () => {
  it('creates a property-wide waitlist entry (unit_id NULL)', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/properties/${f.propertyId}/waitlist`)
      .set('Authorization', `Bearer ${f.tokenA}`)
      .send({ guestName: 'Walt Wait', guestEmail: 'walt@wait.dev', checkIn: '2026-09-01', checkOut: '2026-09-05' })
    expect(res.status).toBe(201)
    const row = (await db.query<any>('SELECT * FROM unit_booking_waitlists WHERE id=$1', [res.body.data.waitlistId])).rows[0]
    expect(row.unit_id).toBeNull()
    expect(row.property_id).toBe(f.propertyId)
    expect(row.status).toBe('waiting')
  })

  it('cross-landlord → 403', async () => {
    const f = await seed()
    const res = await request(buildApp()).post(`/api/properties/${f.propertyId}/waitlist`)
      .set('Authorization', `Bearer ${f.tokenB}`)
      .send({ guestName: 'X', guestEmail: 'x@x.dev', checkIn: '2026-09-01', checkOut: '2026-09-05' })
    expect(res.status).toBe(403)
  })
})

describe('GET /units/:id/waitlist', () => {
  it('returns waiting + notified rows', async () => {
    const f = await seed()
    await db.query(
      `INSERT INTO unit_booking_waitlists (unit_id, property_id, landlord_id, guest_name, guest_email, check_in, check_out, status)
       VALUES ($1,$2,$3,'A','a@g.dev','2026-09-01','2026-09-03','waiting'),
              ($1,$2,$3,'B','b@g.dev','2026-09-05','2026-09-08','notified'),
              ($1,$2,$3,'C','c@g.dev','2026-09-10','2026-09-12','expired')`,
      [f.unitId, f.propertyId, f.landlordId])
    const res = await request(buildApp()).get(`/api/units/${f.unitId}/waitlist`).set('Authorization', `Bearer ${f.tokenA}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2) // waiting + notified, not expired
  })
})

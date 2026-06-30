/**
 * S517 / Walkthrough #10 — Master Schedule booking change-history.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { recordBookingChange } from './bookingEvents'
import { unitsRouter } from '../routes/units'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_events'
})

async function seed() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitA = await seedUnit(c, { propertyId, landlordId })
    const unitB = await seedUnit(c, { propertyId, landlordId })
    const bk = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, status, guest_name)
       VALUES ($1,$2,'nightly','2026-09-01','2026-09-04','confirmed','Jane Doe') RETURNING id`,
      [unitA, landlordId])
    await c.query('COMMIT')
    const token = jwt.sign({ userId, role: 'landlord', email: 'x@t.dev', profileId: landlordId, permissions: {} }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, unitA, unitB, bookingId: bk.rows[0].id, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const booking = (f: any, over: any = {}) => ({
  id: f.bookingId, landlord_id: f.landlordId, unit_id: f.unitA,
  status: 'confirmed', check_in: '2026-09-01', check_out: '2026-09-04', guest_name: 'Jane Doe', ...over,
})

const events = async (landlordId: string) =>
  (await db.query<any>('SELECT * FROM unit_booking_events WHERE landlord_id=$1 ORDER BY created_at', [landlordId])).rows

describe('recordBookingChange', () => {
  it('cancel → one cancelled event (no others)', async () => {
    const f = await seed()
    await recordBookingChange(booking(f), booking(f, { status: 'cancelled' }), f.userId)
    const ev = await events(f.landlordId)
    expect(ev).toHaveLength(1)
    expect(ev[0].event_type).toBe('cancelled')
    expect(ev[0].summary).toMatch(/cancelled/i)
  })

  it('extend checkout by a day → dates_changed with "1 day added"', async () => {
    const f = await seed()
    await recordBookingChange(booking(f), booking(f, { check_out: '2026-09-05' }), f.userId)
    const ev = await events(f.landlordId)
    expect(ev).toHaveLength(1)
    expect(ev[0].event_type).toBe('dates_changed')
    expect(ev[0].summary).toMatch(/1 day added/)
    expect(ev[0].detail.delta).toBe('1 day added')
  })

  it('shorten checkout → "1 day removed"', async () => {
    const f = await seed()
    await recordBookingChange(booking(f), booking(f, { check_out: '2026-09-03' }), f.userId)
    const ev = await events(f.landlordId)
    expect(ev[0].summary).toMatch(/1 day removed/)
  })

  it('move to another unit → moved event', async () => {
    const f = await seed()
    await recordBookingChange(booking(f), booking(f, { unit_id: f.unitB }), f.userId)
    const ev = await events(f.landlordId)
    expect(ev).toHaveLength(1)
    expect(ev[0].event_type).toBe('moved')
    expect(ev[0].detail.to_unit_id).toBe(f.unitB)
  })

  it('no change → no event', async () => {
    const f = await seed()
    await recordBookingChange(booking(f), booking(f), f.userId)
    expect(await events(f.landlordId)).toHaveLength(0)
  })
})

describe('GET /api/units/schedule/history', () => {
  function buildApp() {
    const app = express()
    app.use(express.json())
    app.use('/api/units', unitsRouter)
    app.use(errorHandler)
    return app
  }

  it('returns events newest-first with unit number', async () => {
    const f = await seed()
    await recordBookingChange(booking(f), booking(f, { check_out: '2026-09-06' }), f.userId)
    await recordBookingChange(booking(f), booking(f, { status: 'cancelled' }), f.userId)
    const res = await request(buildApp()).get('/api/units/schedule/history').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    expect(res.body.data[0].event_type).toBe('cancelled') // newest first
    expect(res.body.data[0].unit_number).toBeTruthy()
  })
})

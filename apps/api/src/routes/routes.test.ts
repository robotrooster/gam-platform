/**
 * S463 — routes/routes.ts coverage.
 *
 * Seven endpoints + the routeGeneration service end-to-end. ~25
 * cases covering the full lifecycle: generate from appointments,
 * persist stops, read full plan, driver-start, stop-complete,
 * stop-skip, route-complete.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { routesRouter } from './routes'
import { errorHandler } from '../middleware/errorHandler'
import { cleanupAllSchema } from '../test/dbHelpers'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/routes', routesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s463'
})

const PHX_DEPOT = { lat: 33.4484, lon: -112.0740 }

async function seedFixture(): Promise<{
  ownerUserId: string; businessId: string; token: string
  depotId: string; vehicleId: string; dumpId: string
  customerId: string
}> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`,
    [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1, 'Hauling Co', 'trash_hauling', $2) RETURNING id`,
    [u.id, email])
  const { rows: [d] } = await db.query<{ id: string }>(
    `INSERT INTO depots
       (business_id, name, street1, city, state, zip, lat, lon)
     VALUES ($1, 'Main Yard', '1 Yard', 'Phoenix', 'AZ', '85001', $2, $3)
     RETURNING id`, [b.id, PHX_DEPOT.lat, PHX_DEPOT.lon])
  const { rows: [v] } = await db.query<{ id: string }>(
    `INSERT INTO vehicles
       (business_id, home_depot_id, name, stops_per_dump,
        avg_speed_mph, avg_service_minutes)
     VALUES ($1, $2, 'Truck 1', 50, 25, 3)
     RETURNING id`, [b.id, d.id])
  const { rows: [dump] } = await db.query<{ id: string }>(
    `INSERT INTO dump_locations
       (business_id, name, street1, city, state, zip, lat, lon, typical_dump_minutes)
     VALUES ($1, 'Transfer Station', '999 Dump', 'Phoenix', 'AZ', '85003',
             $2, $3, 15)
     RETURNING id`, [b.id, PHX_DEPOT.lat + 0.05, PHX_DEPOT.lon + 0.05])
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        street1, city, state, zip, lat, lon)
     VALUES ($1, 'individual', 'Jane', 'Doe',
             '100 Elm', 'Phoenix', 'AZ', '85002',
             $2, $3)
     RETURNING id`, [b.id, PHX_DEPOT.lat + 0.013, PHX_DEPOT.lon])
  const token = jwt.sign(
    { userId: u.id, role: 'business_owner', email,
      profileId: b.id, businessId: b.id },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return {
    ownerUserId: u.id, businessId: b.id, token,
    depotId: d.id, vehicleId: v.id, dumpId: dump.id,
    customerId: c.id,
  }
}

async function seedAppointment(args: {
  businessId: string; customerId: string
  date?: string  // YYYY-MM-DD
  hour?: number
}): Promise<string> {
  const date = args.date ?? '2026-07-01'
  const hour = args.hour ?? 9
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO appointments
       (business_id, customer_id, service_type, scheduled_for)
     VALUES ($1, $2, 'Weekly trash', ($3 || 'T' || lpad($4::text, 2, '0') || ':00:00Z')::timestamptz)
     RETURNING id`,
    [args.businessId, args.customerId, date, String(hour)])
  return a.id
}

// ═══════════════════════════════════════════════════════════════
//  POST /generate
// ═══════════════════════════════════════════════════════════════

describe('POST /api/routes/generate', () => {
  it('happy: persists generated_routes + route_stops; counts match optimizer output', async () => {
    const f = await seedFixture()
    await seedAppointment({ businessId: f.businessId, customerId: f.customerId })
    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({
        vehicleId: f.vehicleId,
        date:      '2026-07-01',
        startAt:   '2026-07-01T08:00:00Z',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.routeId).toEqual(expect.any(String))
    expect(res.body.data.stopCount).toBe(1)
    expect(res.body.data.dumpCount).toBe(0)
    expect(res.body.data.skippedUngeocodedCount).toBe(0)
    expect(res.body.data.totalMiles).toBeGreaterThan(0)

    // DB-side: route + 2 stops (1 customer + 1 depot_return).
    const { rows: [r] } = await db.query<any>(
      `SELECT business_id, vehicle_id, depot_id, status, stop_count
         FROM generated_routes WHERE id=$1`, [res.body.data.routeId])
    expect(r.business_id).toBe(f.businessId)
    expect(r.vehicle_id).toBe(f.vehicleId)
    expect(r.depot_id).toBe(f.depotId)
    expect(r.status).toBe('generated')

    const { rows: stops } = await db.query<any>(
      `SELECT sequence_order, stop_kind FROM route_stops
        WHERE route_id=$1 ORDER BY sequence_order`,
      [res.body.data.routeId])
    expect(stops.map(s => s.stop_kind)).toEqual(['customer', 'depot_return'])
  })

  it('un-geocoded appointments are skipped; count surfaces', async () => {
    const f = await seedFixture()
    // Seed a second customer WITHOUT lat/lon.
    const { rows: [c2] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers
         (business_id, customer_type, first_name, last_name,
          street1, city, state, zip)
       VALUES ($1, 'individual', 'No', 'Coords', '999 Nowhere',
               'Phoenix', 'AZ', '85099')
       RETURNING id`, [f.businessId])
    await seedAppointment({ businessId: f.businessId, customerId: f.customerId })
    await seedAppointment({ businessId: f.businessId, customerId: c2.id })

    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({
        vehicleId: f.vehicleId, date: '2026-07-01',
        startAt:   '2026-07-01T08:00:00Z',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.stopCount).toBe(1)
    expect(res.body.data.skippedUngeocodedCount).toBe(1)
  })

  it('vehicle in different business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${a.token}`)
      .send({
        vehicleId: b.vehicleId, date: '2026-07-01',
        startAt: '2026-07-01T08:00:00Z',
      })
    expect(res.status).toBe(404)
  })

  it('archived vehicle → 404', async () => {
    const f = await seedFixture()
    await db.query(`UPDATE vehicles SET status='archived' WHERE id=$1`, [f.vehicleId])
    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({
        vehicleId: f.vehicleId, date: '2026-07-01',
        startAt: '2026-07-01T08:00:00Z',
      })
    expect(res.status).toBe(404)
  })

  it('only includes status=scheduled appointments', async () => {
    const f = await seedFixture()
    const a1 = await seedAppointment({ businessId: f.businessId, customerId: f.customerId, hour: 9 })
    const a2 = await seedAppointment({ businessId: f.businessId, customerId: f.customerId, hour: 11 })
    // Cancel one.
    await db.query(
      `UPDATE appointments SET status='cancelled', cancelled_at=NOW() WHERE id=$1`, [a2])
    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({
        vehicleId: f.vehicleId, date: '2026-07-01',
        startAt: '2026-07-01T08:00:00Z',
      })
    expect(res.body.data.stopCount).toBe(1)
    expect(a1).toEqual(expect.any(String))
  })

  it('zero appointments → still creates route with depot_return only', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({
        vehicleId: f.vehicleId, date: '2026-07-01',
        startAt: '2026-07-01T08:00:00Z',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.stopCount).toBe(0)
    const { rows: stops } = await db.query<any>(
      `SELECT stop_kind FROM route_stops WHERE route_id=$1`, [res.body.data.routeId])
    expect(stops.map(s => s.stop_kind)).toEqual(['depot_return'])
  })

  it('invalid date format → 400', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({
        vehicleId: f.vehicleId, date: 'July 1st',
        startAt: '2026-07-01T08:00:00Z',
      })
    expect(res.status).toBe(400)
  })

  it('non-business role → 403', async () => {
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ($1, 'x', 'tenant', 'T', 'T') RETURNING id`,
      [`t-${randomUUID()}@test.dev`])
    const token = jwt.sign(
      { userId: u.id, role: 'tenant', email: 't@t.dev', profileId: u.id },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${token}`)
      .send({ vehicleId: randomUUID(), date: '2026-07-01', startAt: '2026-07-01T08:00:00Z' })
    expect(res.status).toBe(403)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /
// ═══════════════════════════════════════════════════════════════

describe('GET /api/routes', () => {
  async function gen(f: Awaited<ReturnType<typeof seedFixture>>, date: string): Promise<string> {
    await seedAppointment({ businessId: f.businessId, customerId: f.customerId, date })
    const res = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({ vehicleId: f.vehicleId, date, startAt: `${date}T08:00:00Z` })
    return res.body.data.routeId
  }

  it('returns scoped routes with vehicle + depot names', async () => {
    const f = await seedFixture()
    await gen(f, '2026-07-01')
    await gen(f, '2026-07-02')
    const res = await request(buildApp())
      .get('/api/routes').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    for (const r of res.body.data) {
      expect(r.vehicle_name).toBe('Truck 1')
      expect(r.depot_name).toBe('Main Yard')
    }
  })

  it('?date filter', async () => {
    const f = await seedFixture()
    await gen(f, '2026-07-01')
    await gen(f, '2026-07-02')
    const res = await request(buildApp())
      .get('/api/routes?date=2026-07-01').set('Authorization', `Bearer ${f.token}`)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].generated_for_date).toMatch(/^2026-07-01/)
  })

  it('cross-business isolation', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await gen(b, '2026-07-01')
    const res = await request(buildApp())
      .get('/api/routes').set('Authorization', `Bearer ${a.token}`)
    expect(res.body.data).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  GET /:id  — full plan
// ═══════════════════════════════════════════════════════════════

describe('GET /api/routes/:id', () => {
  it('returns route + stops with customer + dump detail', async () => {
    const f = await seedFixture()
    await seedAppointment({ businessId: f.businessId, customerId: f.customerId })
    const gen = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({ vehicleId: f.vehicleId, date: '2026-07-01', startAt: '2026-07-01T08:00:00Z' })
    const res = await request(buildApp())
      .get(`/api/routes/${gen.body.data.routeId}`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.route.id).toBe(gen.body.data.routeId)
    expect(res.body.data.stops).toHaveLength(2)  // customer + depot_return
    const customerStop = res.body.data.stops.find((s: any) => s.stop_kind === 'customer')
    expect(customerStop.first_name).toBe('Jane')
    expect(customerStop.service_type).toBe('Weekly trash')
  })

  it('cross-business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    await seedAppointment({ businessId: b.businessId, customerId: b.customerId })
    const gen = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${b.token}`)
      .send({ vehicleId: b.vehicleId, date: '2026-07-01', startAt: '2026-07-01T08:00:00Z' })
    const res = await request(buildApp())
      .get(`/api/routes/${gen.body.data.routeId}`).set('Authorization', `Bearer ${a.token}`)
    expect(res.status).toBe(404)
  })

  it('unknown id → 404', async () => {
    const f = await seedFixture()
    const res = await request(buildApp())
      .get(`/api/routes/${randomUUID()}`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Lifecycle: start / complete
// ═══════════════════════════════════════════════════════════════

describe('route lifecycle', () => {
  async function gen(f: Awaited<ReturnType<typeof seedFixture>>): Promise<string> {
    await seedAppointment({ businessId: f.businessId, customerId: f.customerId })
    const r = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({ vehicleId: f.vehicleId, date: '2026-07-01', startAt: '2026-07-01T08:00:00Z' })
    return r.body.data.routeId
  }

  it('start: generated → in_progress + started_at', async () => {
    const f = await seedFixture()
    const id = await gen(f)
    const res = await request(buildApp())
      .post(`/api/routes/${id}/start`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('in_progress')
    expect(res.body.data.started_at).toEqual(expect.any(String))
  })

  it('start twice → 404 (status filter blocks)', async () => {
    const f = await seedFixture()
    const id = await gen(f)
    await request(buildApp())
      .post(`/api/routes/${id}/start`).set('Authorization', `Bearer ${f.token}`)
    const res = await request(buildApp())
      .post(`/api/routes/${id}/start`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(404)
  })

  it('complete: in_progress → completed + completed_at', async () => {
    const f = await seedFixture()
    const id = await gen(f)
    await request(buildApp())
      .post(`/api/routes/${id}/start`).set('Authorization', `Bearer ${f.token}`)
    const res = await request(buildApp())
      .post(`/api/routes/${id}/complete`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('completed')
  })

  it('complete on non-started route → 404', async () => {
    const f = await seedFixture()
    const id = await gen(f)
    const res = await request(buildApp())
      .post(`/api/routes/${id}/complete`).set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
//  Stop-complete + stop-skip
// ═══════════════════════════════════════════════════════════════

describe('stop lifecycle', () => {
  async function genAndGetStops(f: Awaited<ReturnType<typeof seedFixture>>) {
    await seedAppointment({ businessId: f.businessId, customerId: f.customerId })
    const r = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({ vehicleId: f.vehicleId, date: '2026-07-01', startAt: '2026-07-01T08:00:00Z' })
    const routeId = r.body.data.routeId
    const stops = await request(buildApp())
      .get(`/api/routes/${routeId}`).set('Authorization', `Bearer ${f.token}`)
    return { routeId, stops: stops.body.data.stops }
  }

  it('stop-complete: planned → completed + actual_departure stamped', async () => {
    const f = await seedFixture()
    const { routeId, stops } = await genAndGetStops(f)
    const customerStop = stops.find((s: any) => s.stop_kind === 'customer')
    const res = await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/complete`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ driverNotes: 'Bin curbside as expected' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('completed')

    const { rows: [row] } = await db.query<any>(
      `SELECT actual_departure, driver_notes FROM route_stops WHERE id=$1`,
      [customerStop.id])
    expect(row.actual_departure).not.toBeNull()
    expect(row.driver_notes).toBe('Bin curbside as expected')
  })

  it('stop-complete: double-complete → 404', async () => {
    const f = await seedFixture()
    const { routeId, stops } = await genAndGetStops(f)
    const customerStop = stops.find((s: any) => s.stop_kind === 'customer')
    await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    const res = await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(404)
  })

  it('stop-skip: planned → skipped + notes (required)', async () => {
    const f = await seedFixture()
    const { routeId, stops } = await genAndGetStops(f)
    const customerStop = stops.find((s: any) => s.stop_kind === 'customer')
    const res = await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/skip`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ driverNotes: 'Gate locked, customer not home' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('skipped')
  })

  it('stop-skip: missing notes → 400', async () => {
    const f = await seedFixture()
    const { routeId, stops } = await genAndGetStops(f)
    const customerStop = stops.find((s: any) => s.stop_kind === 'customer')
    const res = await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/skip`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(400)
  })

  it('stop-complete cross-business → 404', async () => {
    const a = await seedFixture()
    const b = await seedFixture()
    const { routeId, stops } = await genAndGetStops(b)
    const customerStop = stops.find((s: any) => s.stop_kind === 'customer')
    const res = await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/complete`)
      .set('Authorization', `Bearer ${a.token}`).send({})
    expect(res.status).toBe(404)
  })

  // ─────────────────────────────────────────────────────────────
  //  S474: appointment-status propagation
  // ─────────────────────────────────────────────────────────────

  it('S474: stop-complete propagates → appointments.status=completed + completed_at', async () => {
    const f = await seedFixture()
    const { routeId, stops } = await genAndGetStops(f)
    const customerStop = stops.find((s: any) => s.stop_kind === 'customer')
    await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    const { rows: [appt] } = await db.query<any>(
      `SELECT status, completed_at FROM appointments WHERE id=$1`,
      [customerStop.appointment_id])
    expect(appt.status).toBe('completed')
    expect(appt.completed_at).not.toBeNull()
  })

  it('S474: stop-skip propagates → appointments.status=no_show', async () => {
    const f = await seedFixture()
    const { routeId, stops } = await genAndGetStops(f)
    const customerStop = stops.find((s: any) => s.stop_kind === 'customer')
    await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/skip`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ driverNotes: 'Gate locked' })
    const { rows: [appt] } = await db.query<any>(
      `SELECT status, cancelled_at FROM appointments WHERE id=$1`,
      [customerStop.appointment_id])
    expect(appt.status).toBe('no_show')
    // no_show has no audit-timestamp CHECK; cancelled_at stays NULL.
    expect(appt.cancelled_at).toBeNull()
  })

  it('S474: dump stop (appointment_id NULL) complete does not error', async () => {
    const f = await seedFixture()
    // Seed enough appointments to force a dump stop into the plan.
    // vehicles.stops_per_dump=50 default; we need stops_per_dump=1 to
    // force a dump after a single customer stop.
    await db.query(`UPDATE vehicles SET stops_per_dump=1 WHERE id=$1`, [f.vehicleId])
    await seedAppointment({ businessId: f.businessId, customerId: f.customerId, hour: 9 })
    // Second customer + appointment so the route has 2 customer stops
    // (dump goes between them given stops_per_dump=1).
    const { rows: [c2] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers
         (business_id, customer_type, first_name, last_name,
          street1, city, state, zip, lat, lon)
       VALUES ($1, 'individual', 'John', 'Smith',
               '200 Oak', 'Phoenix', 'AZ', '85002', 33.46, -112.07)
       RETURNING id`, [f.businessId])
    await seedAppointment({ businessId: f.businessId, customerId: c2.id, hour: 10 })

    const r = await request(buildApp())
      .post('/api/routes/generate').set('Authorization', `Bearer ${f.token}`)
      .send({ vehicleId: f.vehicleId, date: '2026-07-01', startAt: '2026-07-01T08:00:00Z' })
    const routeId = r.body.data.routeId
    const detail = await request(buildApp())
      .get(`/api/routes/${routeId}`).set('Authorization', `Bearer ${f.token}`)
    const dumpStop = detail.body.data.stops.find((s: any) => s.stop_kind === 'dump')
    expect(dumpStop).toBeDefined()
    expect(dumpStop.appointment_id).toBeNull()

    // Completing the dump stop should succeed without erroring on the
    // appointment CTE (the WHERE silently short-circuits on NULL).
    const res = await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${dumpStop.id}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('completed')
  })

  it('S474: completed_at preserved across hypothetical re-emit (COALESCE)', async () => {
    // Pin: the CTE uses COALESCE so completed_at stamps once. Since
    // double-complete is blocked by the planned-status filter today,
    // the only way to exercise this is to pre-stamp completed_at and
    // confirm a fresh complete doesn't overwrite it.
    const f = await seedFixture()
    const { routeId, stops } = await genAndGetStops(f)
    const customerStop = stops.find((s: any) => s.stop_kind === 'customer')
    // Pre-stamp the appointment with a known historical timestamp.
    const pastMs = Date.parse('2026-01-01T12:00:00Z')
    await db.query(
      `UPDATE appointments SET status='completed', completed_at=$1 WHERE id=$2`,
      [new Date(pastMs).toISOString(), customerStop.appointment_id])
    await request(buildApp())
      .post(`/api/routes/${routeId}/stops/${customerStop.id}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    const { rows: [appt] } = await db.query<any>(
      `SELECT completed_at FROM appointments WHERE id=$1`,
      [customerStop.appointment_id])
    expect(new Date(appt.completed_at).getTime()).toBe(pastMs)
  })
})

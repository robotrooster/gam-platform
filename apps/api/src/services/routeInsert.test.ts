/**
 * Live stop insert (#14) coverage. Builds the initial route with the
 * real generateRoute, then inserts an extra appointment and asserts the
 * re-optimized result: finalized stops stay locked, the new stop lands,
 * counts/sequence stay coherent.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { generateRoute } from './routeGeneration'
import { insertStopIntoRoute } from './routeInsert'

const DATE = '2026-06-22'
const START = new Date('2026-06-22T15:00:00.000Z')

beforeEach(async () => { await cleanupAllSchema() })

interface Fixture { businessId: string; vehicleId: string }

async function seedFixture(): Promise<Fixture> {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'B', 'O', TRUE) RETURNING id`, [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1, 'Hauling Co', 'trash_hauling', $2) RETURNING id`, [u.id, email])
  const { rows: [d] } = await db.query<{ id: string }>(
    `INSERT INTO depots (business_id, name, street1, city, state, zip, lat, lon)
     VALUES ($1, 'Yard', '1 Yard', 'Mesa', 'AZ', '85201', 33.42, -111.83) RETURNING id`, [b.id])
  const { rows: [v] } = await db.query<{ id: string }>(
    `INSERT INTO vehicles (business_id, home_depot_id, name) VALUES ($1, $2, 'Truck 1') RETURNING id`, [b.id, d.id])
  return { businessId: b.id, vehicleId: v.id }
}

let cn = 0
async function addAppt(fx: Fixture, lat: number | null, lon: number | null): Promise<string> {
  cn += 1
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers (business_id, customer_type, first_name, last_name, street1, city, state, zip, lat, lon)
     VALUES ($1, 'individual', 'Cust', $2, $3, 'Mesa', 'AZ', '85201', $4, $5) RETURNING id`,
    [fx.businessId, `N${cn}`, `${cn} Main St`, lat, lon])
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO appointments (business_id, customer_id, service_type, scheduled_for, status)
     VALUES ($1, $2, 'pickup', $3::timestamptz, 'scheduled') RETURNING id`,
    [fx.businessId, c.id, `${DATE}T16:00:00Z`])
  return a.id
}

const stopsOf = (routeId: string) =>
  db.query<{ id: string; sequence_order: number; stop_kind: string; appointment_id: string | null; status: string }>(
    `SELECT id, sequence_order, stop_kind, appointment_id, status
       FROM route_stops WHERE route_id = $1 ORDER BY sequence_order ASC`, [routeId])
    .then(r => r.rows)

describe('insertStopIntoRoute', () => {
  it('adds a stop to a generated route and re-optimizes', async () => {
    const fx = await seedFixture()
    await addAppt(fx, 33.40, -111.80)
    await addAppt(fx, 33.45, -111.85)
    const gen = await generateRoute({ businessId: fx.businessId, vehicleId: fx.vehicleId, date: DATE, startAt: START, generatedByUserId: null })
    expect(gen.stopCount).toBe(2)

    const extra = await addAppt(fx, 33.43, -111.82)
    const res = await insertStopIntoRoute({ routeId: gen.routeId, businessId: fx.businessId, appointmentId: extra })

    expect(res.stopCount).toBe(3)
    const stops = await stopsOf(gen.routeId)
    const customerAppts = stops.filter(s => s.stop_kind === 'customer').map(s => s.appointment_id)
    expect(customerAppts).toContain(extra)
    expect(customerAppts).toHaveLength(3)
    // exactly one depot_return, and it's last
    expect(stops.filter(s => s.stop_kind === 'depot_return')).toHaveLength(1)
    expect(stops[stops.length - 1].stop_kind).toBe('depot_return')
    // sequence is contiguous from 0
    expect(stops.map(s => s.sequence_order)).toEqual(stops.map((_, i) => i))
  })

  it('preserves finalized stops and appends the re-optimized tail after them', async () => {
    const fx = await seedFixture()
    await addAppt(fx, 33.40, -111.80)
    await addAppt(fx, 33.45, -111.85)
    const gen = await generateRoute({ businessId: fx.businessId, vehicleId: fx.vehicleId, date: DATE, startAt: START, generatedByUserId: null })

    // Start the route + finalize the first stop.
    await db.query(`UPDATE generated_routes SET status='in_progress', started_at=$2 WHERE id=$1`, [gen.routeId, START.toISOString()])
    const before = await stopsOf(gen.routeId)
    const first = before[0]
    await db.query(
      `UPDATE route_stops SET status='completed', actual_arrival=$2, actual_departure=$3 WHERE id=$1`,
      [first.id, new Date(START.getTime() + 10 * 60000).toISOString(), new Date(START.getTime() + 15 * 60000).toISOString()])

    const extra = await addAppt(fx, 33.43, -111.82)
    await insertStopIntoRoute({ routeId: gen.routeId, businessId: fx.businessId, appointmentId: extra })

    const stops = await stopsOf(gen.routeId)
    // finalized stop survived unchanged
    const survived = stops.find(s => s.id === first.id)
    expect(survived?.status).toBe('completed')
    // new appt present, and every planned stop sits after the finalized seq
    const customerAppts = stops.filter(s => s.stop_kind === 'customer').map(s => s.appointment_id)
    expect(customerAppts).toContain(extra)
    const planned = stops.filter(s => s.status === 'planned')
    expect(planned.every(s => s.sequence_order > survived!.sequence_order)).toBe(true)
  })

  it('rejects a completed route', async () => {
    const fx = await seedFixture()
    await addAppt(fx, 33.40, -111.80)
    const gen = await generateRoute({ businessId: fx.businessId, vehicleId: fx.vehicleId, date: DATE, startAt: START, generatedByUserId: null })
    await db.query(`UPDATE generated_routes SET status='completed', started_at=$2, completed_at=$2 WHERE id=$1`, [gen.routeId, START.toISOString()])
    const extra = await addAppt(fx, 33.43, -111.82)
    await expect(insertStopIntoRoute({ routeId: gen.routeId, businessId: fx.businessId, appointmentId: extra }))
      .rejects.toThrow(/completed/i)
  })

  it('rejects an un-geocoded appointment', async () => {
    const fx = await seedFixture()
    await addAppt(fx, 33.40, -111.80)
    const gen = await generateRoute({ businessId: fx.businessId, vehicleId: fx.vehicleId, date: DATE, startAt: START, generatedByUserId: null })
    const ungeo = await addAppt(fx, null, null)
    await expect(insertStopIntoRoute({ routeId: gen.routeId, businessId: fx.businessId, appointmentId: ungeo }))
      .rejects.toThrow(/coordinates/i)
  })

  it('rejects an appointment already on the route', async () => {
    const fx = await seedFixture()
    const onRoute = await addAppt(fx, 33.40, -111.80)
    const gen = await generateRoute({ businessId: fx.businessId, vehicleId: fx.vehicleId, date: DATE, startAt: START, generatedByUserId: null })
    await expect(insertStopIntoRoute({ routeId: gen.routeId, businessId: fx.businessId, appointmentId: onRoute }))
      .rejects.toThrow(/already on this route/i)
  })
})

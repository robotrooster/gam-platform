/**
 * Route auto-advance cron coverage — BACKSTOP only.
 *
 * Real completion is the GPS-departure POST (.../complete). This job
 * just keeps a route from hanging: an arrived-but-never-departed stop
 * completes 30 min after arrival; a never-arrived stop completes 2h
 * past its planned departure; the depot return completes on arrival.
 * T0 = started_at = start_at_planned.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { processRouteAutoAdvance } from './routeAutoAdvance'

const T0 = new Date('2026-06-20T15:00:00.000Z')
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000)
const iso = (mins: number) => at(mins).toISOString()

beforeEach(async () => { await cleanupAllSchema() })

interface Fixture { businessId: string; depotId: string; vehicleId: string }

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
     VALUES ($1, 'Main Yard', '1 Yard', 'Phoenix', 'AZ', '85001', 33.4, -112.0) RETURNING id`, [b.id])
  const { rows: [v] } = await db.query<{ id: string }>(
    `INSERT INTO vehicles (business_id, home_depot_id, name)
     VALUES ($1, $2, 'Truck 1') RETURNING id`, [b.id, d.id])
  return { businessId: b.id, depotId: d.id, vehicleId: v.id }
}

async function seedRoute(fx: Fixture) {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO generated_routes
       (business_id, vehicle_id, depot_id, generated_for_date, start_at_planned,
        status, started_at, total_miles, total_minutes, stop_count, dump_count)
     VALUES ($1,$2,$3,'2026-06-20'::date,$4::timestamptz,'in_progress',$4::timestamptz,10,45,2,0)
     RETURNING id`,
    [fx.businessId, fx.vehicleId, fx.depotId, T0.toISOString()])
  const stopIds: string[] = []
  const apptIds: string[] = []
  for (const c of [{ seq: 1, arr: 10, dep: 15 }, { seq: 2, arr: 30, dep: 35 }]) {
    const { rows: [cust] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers (business_id, customer_type, first_name, last_name, street1, city, state, zip)
       VALUES ($1,'individual','C',$2,'5 Main','Mesa','AZ','85201') RETURNING id`, [fx.businessId, `S${c.seq}`])
    const { rows: [appt] } = await db.query<{ id: string }>(
      `INSERT INTO appointments (business_id, customer_id, service_type, scheduled_for, status)
       VALUES ($1,$2,'pickup',$3::timestamptz,'scheduled') RETURNING id`, [fx.businessId, cust.id, iso(c.arr)])
    apptIds.push(appt.id)
    const { rows: [stop] } = await db.query<{ id: string }>(
      `INSERT INTO route_stops (route_id, sequence_order, stop_kind, appointment_id, estimated_arrival, estimated_departure)
       VALUES ($1,$2,'customer',$3,$4::timestamptz,$5::timestamptz) RETURNING id`,
      [r.id, c.seq, appt.id, iso(c.arr), iso(c.dep)])
    stopIds.push(stop.id)
  }
  const { rows: [ret] } = await db.query<{ id: string }>(
    `INSERT INTO route_stops (route_id, sequence_order, stop_kind, estimated_arrival)
     VALUES ($1,3,'depot_return',$2::timestamptz) RETURNING id`, [r.id, iso(45)])
  stopIds.push(ret.id)
  return { routeId: r.id, stopIds, apptIds }
}

const stopStatus = async (id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM route_stops WHERE id=$1`, [id])).rows[0].status
const routeStatus = async (id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM generated_routes WHERE id=$1`, [id])).rows[0].status
const markArrived = (id: string, mins: number) =>
  db.query(`UPDATE route_stops SET actual_arrival=$2::timestamptz WHERE id=$1`, [id, iso(mins)])

describe('processRouteAutoAdvance (backstop)', () => {
  it('does NOT complete an arrived stop before the 30-min backstop', async () => {
    const fx = await seedFixture()
    const { stopIds } = await seedRoute(fx)
    await markArrived(stopIds[0], 12)
    expect((await processRouteAutoAdvance(at(30))).stops_completed).toBe(0) // 18 min in
    expect(await stopStatus(stopIds[0])).toBe('planned')
  })

  it('backstops an arrived-but-never-departed stop 30 min after arrival', async () => {
    const fx = await seedFixture()
    const { stopIds, apptIds } = await seedRoute(fx)
    await markArrived(stopIds[0], 12)
    const res = await processRouteAutoAdvance(at(43)) // 31 min after arrival
    expect(res.stops_completed).toBe(1)
    expect(await stopStatus(stopIds[0])).toBe('completed')
    expect(await stopStatus(stopIds[1])).toBe('planned')
    const { rows: [a] } = await db.query<{ status: string }>(`SELECT status FROM appointments WHERE id=$1`, [apptIds[0]])
    expect(a.status).toBe('completed')
  })

  it('does NOT complete a never-arrived stop before the 2h backstop', async () => {
    const fx = await seedFixture()
    const { stopIds } = await seedRoute(fx)
    expect((await processRouteAutoAdvance(at(90))).stops_completed).toBe(0)
    expect(await stopStatus(stopIds[0])).toBe('planned')
  })

  it('backstops a never-arrived stop well past its planned departure', async () => {
    const fx = await seedFixture()
    const { stopIds } = await seedRoute(fx)
    // stop1 planned departure T0+15; 2h backstop = T0+135.
    const res = await processRouteAutoAdvance(at(140))
    expect(res.stops_completed).toBeGreaterThanOrEqual(1)
    expect(await stopStatus(stopIds[0])).toBe('completed')
  })

  it('completes the depot return on arrival and finishes the route', async () => {
    const fx = await seedFixture()
    const { routeId, stopIds } = await seedRoute(fx)
    await markArrived(stopIds[0], 10)
    await markArrived(stopIds[1], 30)
    await markArrived(stopIds[2], 44)   // depot arrival
    // Past both 30-min backstops + depot arrival.
    await processRouteAutoAdvance(at(70))
    expect(await stopStatus(stopIds[0])).toBe('completed')
    expect(await stopStatus(stopIds[1])).toBe('completed')
    expect(await stopStatus(stopIds[2])).toBe('completed')
    expect(await routeStatus(routeId)).toBe('completed')
  })
})

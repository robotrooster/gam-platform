/**
 * Live ETA recompute coverage: a driver position ping projects an ETA
 * onto each planned stop and records the route's last position.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { updateRoutePositionAndEta } from './routeEta'

const T0 = new Date('2026-06-20T15:00:00.000Z')
beforeEach(async () => { await cleanupAllSchema() })

async function seed() {
  const hash = await bcrypt.hash('super-strong-password-12!', 12)
  const email = `o-${randomUUID()}@example.com`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,$2,'business_owner','B','O',TRUE) RETURNING id`, [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email)
     VALUES ($1,'Hauling Co','trash_hauling',$2) RETURNING id`, [u.id, email])
  const { rows: [d] } = await db.query<{ id: string }>(
    `INSERT INTO depots (business_id, name, street1, city, state, zip, lat, lon)
     VALUES ($1,'Yard','1 Yard','Mesa','AZ','85201',33.42,-111.83) RETURNING id`, [b.id])
  const { rows: [v] } = await db.query<{ id: string }>(
    `INSERT INTO vehicles (business_id, home_depot_id, name) VALUES ($1,$2,'Truck 1') RETURNING id`, [b.id, d.id])
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO generated_routes (business_id, vehicle_id, depot_id, generated_for_date, start_at_planned,
        status, started_at, total_miles, total_minutes, stop_count, dump_count)
     VALUES ($1,$2,$3,'2026-06-20'::date,$4::timestamptz,'in_progress',$4::timestamptz,10,45,2,0) RETURNING id`,
    [b.id, v.id, d.id, T0.toISOString()])
  const stopIds: string[] = []
  for (const c of [{ seq: 1, lat: 33.40, lon: -111.80 }, { seq: 2, lat: 33.46, lon: -111.88 }]) {
    const { rows: [cust] } = await db.query<{ id: string }>(
      `INSERT INTO business_customers (business_id, customer_type, first_name, last_name, street1, city, state, zip, lat, lon)
       VALUES ($1,'individual','C',$2,'5 Main','Mesa','AZ','85201',$3,$4) RETURNING id`, [b.id, `S${c.seq}`, c.lat, c.lon])
    const { rows: [appt] } = await db.query<{ id: string }>(
      `INSERT INTO appointments (business_id, customer_id, service_type, scheduled_for, status)
       VALUES ($1,$2,'pickup',$3::timestamptz,'scheduled') RETURNING id`, [b.id, cust.id, T0.toISOString()])
    const { rows: [stop] } = await db.query<{ id: string }>(
      `INSERT INTO route_stops (route_id, sequence_order, stop_kind, appointment_id, estimated_arrival, estimated_departure)
       VALUES ($1,$2,'customer',$3,$4::timestamptz,$4::timestamptz) RETURNING id`, [r.id, c.seq, appt.id, T0.toISOString()])
    stopIds.push(stop.id)
  }
  return { businessId: b.id, routeId: r.id, stopIds }
}

const etaOf = async (id: string) =>
  (await db.query<{ projected_eta: Date | null }>(`SELECT projected_eta FROM route_stops WHERE id=$1`, [id])).rows[0].projected_eta

describe('updateRoutePositionAndEta', () => {
  it('projects an ETA onto each planned stop and records last position', async () => {
    const { businessId, routeId, stopIds } = await seed()
    const res = await updateRoutePositionAndEta({ businessId, routeId, lat: 33.42, lon: -111.83 }, T0)
    expect(res.updatedStops).toBe(2)
    const e1 = await etaOf(stopIds[0])
    const e2 = await etaOf(stopIds[1])
    expect(e1).not.toBeNull()
    expect(e2).not.toBeNull()
    expect(new Date(e1!).getTime()).toBeGreaterThanOrEqual(T0.getTime())
    const { rows: [r] } = await db.query<{ last_lat: string; last_position_at: Date }>(
      `SELECT last_lat, last_position_at FROM generated_routes WHERE id=$1`, [routeId])
    expect(Number(r.last_lat)).toBeCloseTo(33.42, 2)
    expect(r.last_position_at).not.toBeNull()
  })

  it('rejects a route from another business', async () => {
    const a = await seed()
    const b = await seed()
    await expect(updateRoutePositionAndEta({ businessId: b.businessId, routeId: a.routeId, lat: 33.4, lon: -111.8 }))
      .rejects.toThrow(/not found/i)
  })
})

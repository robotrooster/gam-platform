/**
 * Pre-start manual reorder (#16) coverage. Build a route with the real
 * generateRoute, reorder its stops, assert the new sequence + re-timed
 * ETAs, and that it's blocked once the route has started.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { generateRoute } from './routeGeneration'
import { reorderRouteStops } from './routeReorder'

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
async function addAppt(fx: Fixture, lat: number, lon: number): Promise<string> {
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
  db.query<{ id: string; sequence_order: number; stop_kind: string; estimated_arrival: Date }>(
    `SELECT id, sequence_order, stop_kind, estimated_arrival
       FROM route_stops WHERE route_id = $1 ORDER BY sequence_order ASC`, [routeId])
    .then(r => r.rows)

describe('reorderRouteStops', () => {
  it('honors a chosen order, re-pins depot_return last, and re-times', async () => {
    const fx = await seedFixture()
    await addAppt(fx, 33.40, -111.80)
    await addAppt(fx, 33.46, -111.88)
    const gen = await generateRoute({ businessId: fx.businessId, vehicleId: fx.vehicleId, date: DATE, startAt: START, generatedByUserId: null })

    const before = await stopsOf(gen.routeId)
    const customerIds = before.filter(s => s.stop_kind === 'customer').map(s => s.id)
    const reversed = [...customerIds].reverse()

    await reorderRouteStops({ routeId: gen.routeId, businessId: fx.businessId, orderedStopIds: reversed })

    const after = await stopsOf(gen.routeId)
    const afterCustomerIds = after.filter(s => s.stop_kind === 'customer').map(s => s.id)
    expect(afterCustomerIds).toEqual(reversed)
    // depot_return stays last
    expect(after[after.length - 1].stop_kind).toBe('depot_return')
    // first stop's ETA = planned start + some drive time (> start)
    expect(new Date(after[0].estimated_arrival).getTime()).toBeGreaterThan(START.getTime())
    // contiguous sequence from 0
    expect(after.map(s => s.sequence_order)).toEqual(after.map((_, i) => i))
  })

  it('blocks reordering once the route has started', async () => {
    const fx = await seedFixture()
    await addAppt(fx, 33.40, -111.80)
    await addAppt(fx, 33.46, -111.88)
    const gen = await generateRoute({ businessId: fx.businessId, vehicleId: fx.vehicleId, date: DATE, startAt: START, generatedByUserId: null })
    await db.query(`UPDATE generated_routes SET status='in_progress', started_at=$2 WHERE id=$1`, [gen.routeId, START.toISOString()])
    const ids = (await stopsOf(gen.routeId)).filter(s => s.stop_kind === 'customer').map(s => s.id)
    await expect(reorderRouteStops({ routeId: gen.routeId, businessId: fx.businessId, orderedStopIds: ids.reverse() }))
      .rejects.toThrow(/before the route starts/i)
  })

  it('rejects an order that is not the route’s stop set', async () => {
    const fx = await seedFixture()
    await addAppt(fx, 33.40, -111.80)
    await addAppt(fx, 33.46, -111.88)
    const gen = await generateRoute({ businessId: fx.businessId, vehicleId: fx.vehicleId, date: DATE, startAt: START, generatedByUserId: null })
    const ids = (await stopsOf(gen.routeId)).filter(s => s.stop_kind === 'customer').map(s => s.id)
    await expect(reorderRouteStops({ routeId: gen.routeId, businessId: fx.businessId, orderedStopIds: [ids[0]] }))
      .rejects.toThrow(/exactly the route/i)
  })
})

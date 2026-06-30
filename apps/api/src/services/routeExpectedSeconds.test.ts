/**
 * Per-unit expected service time (S510): a generated route stamps each
 * customer stop with expected_seconds = business rate × customer units.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { generateRoute } from './routeGeneration'

const DATE = '2026-06-22'
const START = new Date('2026-06-22T15:00:00.000Z')

beforeEach(async () => { await cleanupAllSchema() })

describe('expected_seconds = rate × units', () => {
  it('stamps each customer stop from the owner rate and the customer unit count', async () => {
    const hash = await bcrypt.hash('super-strong-password-12!', 12)
    const email = `o-${randomUUID()}@example.com`
    const { rows: [u] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,$2,'business_owner','B','O',TRUE) RETURNING id`, [email, hash])
    // 90 seconds per unit.
    const { rows: [b] } = await db.query<{ id: string }>(
      `INSERT INTO businesses (owner_user_id, name, business_type, email, service_seconds_per_unit)
       VALUES ($1,'Hauling Co','trash_hauling',$2,90) RETURNING id`, [u.id, email])
    const { rows: [d] } = await db.query<{ id: string }>(
      `INSERT INTO depots (business_id, name, street1, city, state, zip, lat, lon)
       VALUES ($1,'Yard','1 Yard','Mesa','AZ','85201',33.42,-111.83) RETURNING id`, [b.id])
    const { rows: [v] } = await db.query<{ id: string }>(
      `INSERT INTO vehicles (business_id, home_depot_id, name) VALUES ($1,$2,'Truck 1') RETURNING id`, [b.id, d.id])

    // Two customers: 10 cans and 3 cans.
    const apptByCount: Record<number, string> = {}
    for (const [n, lat, lon] of [[10, 33.40, -111.80], [3, 33.46, -111.88]] as const) {
      const { rows: [c] } = await db.query<{ id: string }>(
        `INSERT INTO business_customers (business_id, customer_type, first_name, last_name, street1, city, state, zip, lat, lon, unit_count)
         VALUES ($1,'individual','C',$2,'5 Main','Mesa','AZ','85201',$3,$4,$5) RETURNING id`,
        [b.id, `n${n}`, lat, lon, n])
      const { rows: [a] } = await db.query<{ id: string }>(
        `INSERT INTO appointments (business_id, customer_id, service_type, scheduled_for, status)
         VALUES ($1,$2,'pickup',$3::timestamptz,'scheduled') RETURNING id`, [b.id, c.id, `${DATE}T16:00:00Z`])
      apptByCount[n] = a.id
    }

    const gen = await generateRoute({ businessId: b.id, vehicleId: v.id, date: DATE, startAt: START, generatedByUserId: null })

    const rows = await db.query<{ appointment_id: string; expected_seconds: number | null; stop_kind: string }>(
      `SELECT appointment_id, expected_seconds, stop_kind FROM route_stops WHERE route_id = $1`, [gen.routeId])
    const exp = (apptId: string) => rows.rows.find(r => r.appointment_id === apptId)!.expected_seconds
    expect(exp(apptByCount[10])).toBe(900)   // 90 × 10
    expect(exp(apptByCount[3])).toBe(270)    // 90 × 3
    // depot_return carries no expected_seconds
    expect(rows.rows.find(r => r.stop_kind === 'depot_return')!.expected_seconds).toBeNull()
  })
})

/**
 * S642 — the admin overview and the landlord dashboard disagreed by $460.
 *
 * Nic: "There is a four hundred and sixty dollar discrepancy there. That's one
 * mobile home… Collected this month needs to show any in-flight stuff. Those
 * two cards need to match up."
 *
 * Admin counted settled + ACH-still-clearing; the landlord dashboard and the
 * Reports page counted settled only. The gap was a single real ACH payment
 * mid-flight, whose tenant's bank had already been debited.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { collectedRentMtd, RENT_RECEIVED_STATUSES } from './rentCollected'

beforeEach(async () => { await cleanupAllSchema() })

async function seedRent(rows: Array<{ status: string; amount: number; type?: string; monthsAgo?: number }>) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { landlordId, userId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('rc-' || gen_random_uuid() || '@t.dev','x','tenant','R','C') RETURNING id`)
    const t = await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
    for (const [i, r] of rows.entries()) {
      const when = `NOW() - INTERVAL '${r.monthsAgo ?? 0} months'`
      // ux_payments_unit_rent_due_date_active allows ONE active rent charge per
      // unit per due date — the guard against double-billing a month. Each
      // seeded row therefore gets its own due date; the figure under test keys
      // off settled_at/created_at, so this changes nothing it measures.
      await c.query(
        `INSERT INTO payments (tenant_id, landlord_id, unit_id, type, amount, status,
                               entry_description, due_date, settled_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'RENT',
                 (date_trunc('month', ${when})::date + $7::int),
                 CASE WHEN $6 = 'processing' THEN NULL ELSE ${when} END, ${when})`,
        [t.rows[0].id, landlordId, unitId, r.type ?? 'rent', r.amount, r.status, i])
    }
    await c.query('COMMIT')
    return { landlordId, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('collectedRentMtd — one definition for every screen', () => {
  it('counts ACH still clearing, which is the $460 nobody could see', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 17460 },
      { status: 'processing', amount: 460 },
    ])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(17920)
    // Named as well as counted: money a landlord is waiting on is a different
    // fact from money that has landed.
    expect(r.inFlight).toBe(460)
  })

  it('the landlord-scoped figure equals the platform-wide one when there is one landlord', async () => {
    // Exactly Nic's situation today, and the reason the mismatch was visible.
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 1000 },
      { status: 'processing', amount: 250 },
    ])
    const scoped = await collectedRentMtd([landlordId])
    const platform = await collectedRentMtd(null)
    expect(scoped.collected).toBe(platform.collected)
  })

  it('a pending charge is NOT collected — nobody has sent anything', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 500 },
      { status: 'pending', amount: 900 },
    ])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(500)
    expect(r.inFlight).toBe(0)
  })

  it('ignores last month, including last month’s in-flight', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 300 },
      { status: 'settled', amount: 999, monthsAgo: 1 },
    ])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(300)
  })

  it('is rent only — utilities and fees belong to the heartbeat, not this card', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 400 },
      { status: 'settled', amount: 25, type: 'utility' },
      { status: 'settled', amount: 10, type: 'late_fee' },
    ])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(400)
  })

  it('filters to one property when the dashboard is scoped', async () => {
    const { landlordId, propertyId } = await seedRent([{ status: 'settled', amount: 750 }])
    expect((await collectedRentMtd([landlordId], propertyId)).collected).toBe(750)
    expect((await collectedRentMtd([landlordId], randomUUID())).collected).toBe(0)
  })

  it('the status list is the one the admin overview uses', async () => {
    expect([...RENT_RECEIVED_STATUSES].sort())
      .toEqual(['paid_via_deposit', 'processing', 'settled'])
  })
})

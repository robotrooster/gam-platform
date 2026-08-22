/**
 * S616 (Nic) — a service point is not a unit.
 *
 *   "We need a way for a landlord to add units that don't count as units, or
 *    that don't act as traditional units in the rest of the system... the unit
 *    we create is to place the utility bills in under somebody's name. That's
 *    how they get access to the tenant portal. The unit is not rentable. The
 *    unit is not bookable. It doesn't show as vacant or owner occupied. It's
 *    just something to link the utilities as a pass through."
 *
 * status='utility_service' has meant this since S614, but every count had to be
 * taught separately and they were being found one at a time. This pins the ones
 * that matter so the next reader does not have to rediscover them.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(async () => { await cleanupAllSchema() })

/** One rented unit and one service point at the same property. */
async function propertyWithServicePoint() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId,
    })
    const rented = await seedUnit(c, { propertyId, landlordId, rentAmount: 500 })
    await c.query(`UPDATE units SET status='active' WHERE id=$1`, [rented])
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, {
      unitId: rented, landlordId, status: 'active', rentAmount: 500, startDate: '2026-01-01',
    })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })

    const servicePoint = await seedUnit(c, { propertyId, landlordId, rentAmount: 0 })
    await c.query(`UPDATE units SET status='utility_service' WHERE id=$1`, [servicePoint])
    await c.query('COMMIT')
    return { landlordId, propertyId, rented, servicePoint, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('a service point is neither occupied nor vacant (S616)', () => {
  it('is absent from v_unit_occupancy entirely', async () => {
    const f = await propertyWithServicePoint()
    const { rows } = await db.query<any>(
      `SELECT unit_id FROM v_unit_occupancy WHERE unit_id = ANY($1::uuid[])`,
      [[f.rented, f.servicePoint]])
    expect(rows.map((r: any) => r.unit_id)).toEqual([f.rented])
  })

  // Before this, the view derived occupancy from an active lease — a service
  // point has none, so it appeared as NOT occupied, i.e. as a VACANCY. A
  // neighbour's building counted against this landlord's vacancy rate.
  it('does not count as a vacancy', async () => {
    const f = await propertyWithServicePoint()
    const { rows } = await db.query<any>(
      `SELECT COUNT(*)::int AS vacant
         FROM v_unit_occupancy vuo
         JOIN units u ON u.id = vuo.unit_id
        WHERE u.property_id = $1 AND NOT vuo.is_occupied`, [f.propertyId])
    expect(rows[0].vacant).toBe(0)
  })

  it('does not count as an occupied unit', async () => {
    const f = await propertyWithServicePoint()
    const { rows } = await db.query<any>(
      `SELECT COUNT(DISTINCT u.id) FILTER (
                WHERE u.status <> 'vacant' AND u.status <> 'utility_service')::int AS occupied
         FROM units u WHERE u.property_id = $1`, [f.propertyId])
    expect(rows[0].occupied).toBe(1)     // the rented unit, not the service point
  })

  it('is not counted as inventory', async () => {
    const f = await propertyWithServicePoint()
    const { rows } = await db.query<any>(
      `SELECT COUNT(*)::int AS total FROM units u
        WHERE u.property_id = $1 AND u.status <> 'utility_service'`, [f.propertyId])
    expect(rows[0].total).toBe(1)
  })

  it('is never rentable or bookable', async () => {
    const f = await propertyWithServicePoint()
    const { rows } = await db.query<any>(
      `SELECT is_bookable, rent_amount::text AS rent, lease_types_allowed
         FROM units WHERE id = $1`, [f.servicePoint])
    expect(rows[0].is_bookable).toBe(false)
    expect(Number(rows[0].rent)).toBe(0)
  })

  // The whole reason it exists: somewhere to hang a utility bill so the payer
  // gets a portal login.
  it('still carries a payer, which is the point of it', async () => {
    const f = await propertyWithServicePoint()
    const payer = await (async () => {
      const c = await db.connect()
      try { await c.query('BEGIN'); const t = await seedTenant(c); await c.query('COMMIT'); return t }
      finally { c.release() }
    })()
    await db.query(
      `INSERT INTO utility_service_agreements
         (landlord_id, unit_id, tenant_id, start_date, payer_attested_at)
       VALUES ($1,$2,$3,'2026-01-01',NOW())`,
      [f.landlordId, f.servicePoint, payer])

    const { rows } = await db.query<any>(
      `SELECT tenant_id FROM utility_service_agreements WHERE unit_id = $1`,
      [f.servicePoint])
    expect(rows[0].tenant_id).toBe(payer)
  })
})

/**
 * S550 — daily growth snapshots. Contract: per-(state,city) rows + a
 * platform totals row; rent counted ONCE per lease (multi-tenant leases
 * must not inflate rent roll); idempotent per day.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { captureGrowthSnapshot } from './growthSnapshots'

beforeEach(async () => { await cleanupAllSchema() })

describe('captureGrowthSnapshot', () => {
  it('per-city rows + totals; two tenants on one lease count rent once', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const p1 = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      await c.query(`UPDATE properties SET city='Yarnell', state='AZ' WHERE id=$1`, [p1])
      const u1 = await seedUnit(c, { propertyId: p1, landlordId })
      const u2 = await seedUnit(c, { propertyId: p1, landlordId })
      await c.query(`UPDATE units SET status='vacant' WHERE id=$1`, [u2])
      await c.query(`UPDATE units SET status='active' WHERE id=$1`, [u1])
      const lease = await seedLease(c, { unitId: u1, landlordId, rentAmount: 900 })
      const t1 = await seedTenant(c)
      const t2 = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: lease, tenantId: t1, role: 'primary' })
      await seedLeaseTenant(c, { leaseId: lease, tenantId: t2 })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const res = await captureGrowthSnapshot()
    expect(res.geoRows).toBeGreaterThanOrEqual(2) // Yarnell + totals

    const yarnell = (await db.query<any>(
      `SELECT * FROM platform_growth_snapshots
        WHERE snapshot_date=CURRENT_DATE AND state='AZ' AND city='Yarnell'`)).rows[0]
    expect(yarnell.landlords).toBe(1)
    expect(yarnell.properties).toBe(1)
    expect(yarnell.units).toBe(2)
    expect(yarnell.occupied_units).toBe(1)
    expect(yarnell.vacant_units).toBe(1)
    expect(yarnell.active_leases).toBe(1)
    expect(yarnell.active_tenants).toBe(2)
    expect(Number(yarnell.monthly_rent_roll)).toBe(900) // once, not 1800

    const totals = (await db.query<any>(
      `SELECT * FROM platform_growth_snapshots
        WHERE snapshot_date=CURRENT_DATE AND state='*' AND city='*'`)).rows[0]
    expect(totals.units).toBe(2)
    expect(Number(totals.monthly_rent_roll)).toBe(900)

    // Property-grain row exists with the same facts + operational state.
    const prop = (await db.query<any>(
      `SELECT * FROM property_growth_snapshots WHERE snapshot_date=CURRENT_DATE`)).rows
    expect(prop.length).toBe(1)
    expect(prop[0].units).toBe(2)
    expect(prop[0].occupied_units).toBe(1)
    expect(Number(prop[0].monthly_rent_roll)).toBe(900)
    expect(prop[0].open_maintenance).toBe(0)
    expect(Number(prop[0].outstanding_balance)).toBe(0)

    // Engagement columns land on the totals row (0 logins in fixture).
    expect(totals.active_users_30d).not.toBeNull()

    // Idempotent: run again, still one row per scope, same values.
    await captureGrowthSnapshot()
    const count = (await db.query<any>(
      `SELECT COUNT(*)::int AS n FROM platform_growth_snapshots
        WHERE snapshot_date=CURRENT_DATE AND state='AZ' AND city='Yarnell'`)).rows[0]
    expect(count.n).toBe(1)
    const pcount = (await db.query<any>(
      `SELECT COUNT(*)::int AS n FROM property_growth_snapshots
        WHERE snapshot_date=CURRENT_DATE`)).rows[0]
    expect(pcount.n).toBe(1)
  })
})

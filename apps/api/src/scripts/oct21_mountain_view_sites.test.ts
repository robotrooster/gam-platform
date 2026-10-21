/**
 * 10/21 (Nic) — RV 34 is a 50-amp site and RV 15A exists: the dry run reads and
 * writes nothing; --apply re-rates 34 and adds 15A with RV 15's settings; run
 * again and there is nothing to do. A site somebody is on is never re-rated,
 * and a number already taken is never added twice.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { planMountainViewSites, applyMountainViewSites, describeSitesPlan, AMP_FIX, NEW_SITE } from './oct21_mountain_view_sites'

beforeEach(cleanupAllSchema)

async function tx<T>(fn: (c: PoolClient) => Promise<T>, commit: boolean): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query(commit ? 'COMMIT' : 'ROLLBACK')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/** Mountain View's RV row as production has it: 15 occupied, 34 vacant on 30 amp, no 15A. */
async function park() {
  const c = await db.connect()
  try {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const at = { landlordId: ll.landlordId, propertyId }
    const ids: Record<string, string> = {}
    for (const [n, status, amp] of [['RV 15', 'active', '30'], ['RV 33', 'active', '30'], ['RV 34', 'vacant', '30']] as const) {
      ids[n] = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: 589, unitType: 'rv_spot' })
      await c.query(
        `UPDATE units SET unit_number = $2, status = $3, rv_amp_service = $4, rv_site_layout = 'pull_through',
                          nightly_rate = 49, weekly_rate = 269, monthly_rate = 589 WHERE id = $1`,
        [ids[n], n, status, amp])
    }
    await seedLease(c, { unitId: ids['RV 15'], landlordId: ll.landlordId, rentAmount: 589, startDate: '2026-01-01', status: 'active' })
    return { at, ids }
  } finally { c.release() }
}

const siteByNumber = (propertyId: string, n: string) => db.query<any>(
  `SELECT id, status, rv_amp_service, rv_site_layout, rent_amount::text AS rent, nightly_rate::text AS nightly,
          weekly_rate::text AS weekly, monthly_rate::text AS monthly, unit_type, subtype_id
     FROM units WHERE property_id = $1 AND unit_number = $2`, [propertyId, n]).then(r => r.rows[0])

describe('10/21: RV 34 is 50 amp, and RV 15A is a real site', () => {
  it('the dry run says both things and writes neither', async () => {
    const { at } = await park()
    const plan = await planMountainViewSites(db, at)
    expect(plan.refused).toBeNull()
    expect(plan.amp).toMatchObject({ number: 'RV 34', from: '30', to: 'both' })
    expect(plan.addSite).toMatchObject({ unitNumber: 'RV 15A', copyFrom: { number: 'RV 15' } })
    expect(describeSitesPlan(plan).join('\n')).toContain('RV 34 power: 30 → both')
    // Read-only: nothing moved.
    expect((await siteByNumber(at.propertyId, 'RV 34')).rv_amp_service).toBe('30')
    expect(await siteByNumber(at.propertyId, 'RV 15A')).toBeUndefined()
  })

  it('--apply re-rates 34 and adds 15A with its neighbour\'s settings; a second run has nothing to do', async () => {
    const { at } = await park()
    await tx(async c => applyMountainViewSites(c, await planMountainViewSites(c, at), at), true)

    expect((await siteByNumber(at.propertyId, 'RV 34')).rv_amp_service).toBe('both')
    const added = await siteByNumber(at.propertyId, 'RV 15A')
    expect(added).toMatchObject({
      status: 'vacant', unit_type: 'rv_spot', rv_amp_service: '30', rv_site_layout: 'pull_through',
      rent: '589.00', nightly: '49.00', weekly: '269.00', monthly: '589.00', subtype_id: null,
    })
    // No meter, no lease, no charge — a vacant site is never billed.
    expect((await db.query(`SELECT 1 FROM utility_meter_units WHERE unit_id = $1`, [added.id])).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM leases WHERE unit_id = $1`, [added.id])).rows).toHaveLength(0)

    const again = await planMountainViewSites(db, at)
    expect(again.refused).toBeNull()
    expect(again.amp).toBeNull()
    expect(again.addSite).toBeNull()
    expect(describeSitesPlan(again).join('\n')).toContain('already')
  })

  it('refuses to re-rate a site a lease holds, and changes nothing — not even the site it would have added', async () => {
    const { at, ids } = await park()
    const c = await db.connect()
    try {
      await seedLease(c, { unitId: ids['RV 34'], landlordId: at.landlordId, rentAmount: 589, startDate: '2026-02-01', status: 'active' })
    } finally { c.release() }
    const plan = await planMountainViewSites(db, at)
    expect(plan.refused).toMatch(/RV 34 is not vacant|a lease holds it/)
    expect(describeSitesPlan(plan).join('')).toContain('nothing changed')
    // One refusal stops the whole run: 15A is not added either.
    expect(plan.amp).toBeNull()
    expect(plan.addSite).toBeNull()
    await expect(tx(c2 => applyMountainViewSites(c2, plan, at), false)).rejects.toThrow()
    expect((await siteByNumber(at.propertyId, 'RV 34')).rv_amp_service).toBe('30')
    expect(await siteByNumber(at.propertyId, 'RV 15A')).toBeUndefined()
  })

  it('refuses when that number is already taken by something that is not a live RV site', async () => {
    const { at } = await park()
    const c = await db.connect()
    let retired: string
    try {
      retired = await seedUnit(c, { propertyId: at.propertyId, landlordId: at.landlordId, rentAmount: 589, unitType: 'rv_spot' })
    } finally { c.release() }
    await db.query(`UPDATE units SET unit_number = $2, retired_at = NOW() WHERE id = $1`, [retired, NEW_SITE.number])
    const plan = await planMountainViewSites(db, at)
    expect(plan.refused).toMatch(/RV 15A exists but is not a live RV site/)
    expect(plan.addSite).toBeNull()
    expect(AMP_FIX.to).toBe('both')
  })
})

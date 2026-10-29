/**
 * 10/14 (Nic) — Mountain View's mobile home spaces (D1–D3, I7): the dry run
 * reads and writes nothing; --apply adds MH 3.5 (MH 09's settings, $589,
 * vacant, park-owned), puts MH 11 and MH 26 at $589, marks the vacant spaces'
 * trailers the park's, and tags single / double wide on the property's own two
 * classes; run again, nothing to do. A space with a lease is never changed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { planMountainViewSpaces, applyMountainViewSpaces, describeSpacesPlan, NEW_SPACE } from './oct14_mountain_view_spaces'

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

/** Mountain View as production has it (read 10/14): the spaces the answers name, a leased one, the two classes. */
async function park() {
  const c = await db.connect()
  try {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const at = { landlordId: ll.landlordId, propertyId }
    const ids: Record<string, string> = {}
    const spaces: Array<[string, string, number]> = [
      ['MH 01', 'active', 460], ['MH 03', 'owner_use', 460], ['MH 09', 'active', 589], ['MH 11', 'vacant', 460], ['MH 12', 'vacant', 460],
      ['MH 14', 'vacant', 460], ['MH 17', 'vacant', 460], ['MH 19', 'active', 589], ['MH 24', 'vacant', 460], ['MH 26', 'vacant', 460],
    ]
    for (const [n, status, rent] of spaces) {
      ids[n] = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: rent, unitType: 'mobile_home' })
      await c.query(
        `UPDATE units SET unit_number = $2, status = $3, dwelling_ownership = 'tenant', lot_rent_amount = 0, bedrooms = $4,
                          lease_types_allowed = '{month_to_month,long_term}' WHERE id = $1`,
        [ids[n], n, status, n === 'MH 09' ? 3 : 1])
    }
    for (const n of ['MH 01', 'MH 09', 'MH 19']) {
      await seedLease(c, { unitId: ids[n], landlordId: ll.landlordId, rentAmount: n === 'MH 01' ? 460 : 589, startDate: '2026-01-01', status: 'active' })
    }
    const sub = async (name: string) => (await c.query<{ id: string }>(
      `INSERT INTO property_unit_subtypes (property_id, unit_type, name) VALUES ($1,'mobile_home',$2) RETURNING id`, [propertyId, name])).rows[0].id
    const single = await sub('Single Wide'), double = await sub('Double Wide')
    const amp = (await c.query<{ id: string }>(
      `INSERT INTO property_unit_subtypes (property_id, unit_type, name) VALUES ($1,'mobile_home','Corner lot') RETURNING id`, [propertyId])).rows[0].id
    for (const n of Object.keys(ids)) {
      await c.query(`INSERT INTO unit_subtype_links (unit_id, subtype_id) VALUES ($1,$2)`, [ids[n], ['MH 09', 'MH 19', 'MH 26'].includes(n) ? double : single])
    }
    await c.query(`INSERT INTO unit_subtype_links (unit_id, subtype_id) VALUES ($1,$2)`, [ids['MH 11'], amp])
    return { at, ids, single, double, amp }
  } finally { c.release() }
}

const unitsOf = async (propertyId: string) => Object.fromEntries((await db.query<any>(
  `SELECT u.unit_number, u.status, u.rent_amount::float AS rent, u.dwelling_ownership AS own, u.bedrooms, u.display_label,
          COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM unit_subtype_links k JOIN property_unit_subtypes s ON s.id = k.subtype_id
                     WHERE k.unit_id = u.id), '{}') AS tags
     FROM units u WHERE u.property_id = $1`, [propertyId])).rows.map(r => [r.unit_number, r]))

describe('oct14_mountain_view_spaces', () => {
  it('the dry run changes nothing; --apply makes Mountain View read as Nic says; again, nothing to do', async () => {
    const w = await park()
    const before = await unitsOf(w.at.propertyId)
    const dry = await tx(c => planMountainViewSpaces(c, w.at), false)
    expect(dry.refused).toBeNull()
    expect(dry.rents.map(r => [r.number, r.from, r.to])).toEqual([['MH 11', '460.00', 589], ['MH 26', '460.00', 589]])
    expect(dry.ownership.map(o => o.number)).toEqual(['MH 11', 'MH 12', 'MH 14', 'MH 17', 'MH 24', 'MH 26'])
    expect(dry.links.map(l => [l.number, l.add, l.remove.map(r => r.name)])).toEqual([['MH 11', 'double', ['Single Wide']], [NEW_SPACE, 'double', []]])
    expect(describeSpacesPlan(dry).join('\n')).toContain('MH 03 left as it is: owner_use, $460.00, Single Wide.')
    expect(await unitsOf(w.at.propertyId)).toEqual(before)

    await tx(async c => applyMountainViewSpaces(c, await planMountainViewSpaces(c, w.at), w.at), true)
    const after = await unitsOf(w.at.propertyId)
    // MH 3.5: a vacant mobile home space at $589, the park's trailer, MH 09's other settings, no printed label, Double Wide.
    expect(after[NEW_SPACE]).toEqual({
      unit_number: 'MH 3.5', status: 'vacant', rent: 589, own: 'landlord', bedrooms: 3, display_label: null, tags: ['Double Wide'],
    })
    expect(after['MH 11']).toMatchObject({ rent: 589, own: 'landlord', tags: ['Corner lot', 'Double Wide'] })
    expect(after['MH 26']).toMatchObject({ rent: 589, own: 'landlord', tags: ['Double Wide'] })
    for (const n of ['MH 12', 'MH 14', 'MH 17', 'MH 24']) expect(after[n]).toMatchObject({ rent: 460, own: 'landlord', tags: ['Single Wide'] })
    // Leased and owner-use spaces untouched.
    for (const n of ['MH 01', 'MH 03', 'MH 09', 'MH 19']) expect(after[n]).toEqual(before[n])
    // Never a second class beside the property's own.
    expect((await db.query(`SELECT 1 FROM property_unit_subtypes WHERE property_id = $1`, [w.at.propertyId])).rows).toHaveLength(3)

    const again = await tx(c => planMountainViewSpaces(c, w.at), false)
    expect(again).toMatchObject({ refused: null, addSpace: null, rents: [], ownership: [], links: [] })
    expect(describeSpacesPlan(again)[0]).toBe('  Nothing to change: Mountain View already reads this way.')
  })

  it('refuses, changing nothing, when a space it would change holds a lease', async () => {
    const w = await park()
    const c = await db.connect()
    try {
      await seedLease(c, { unitId: w.ids['MH 12'], landlordId: w.at.landlordId, rentAmount: 460, startDate: '2026-10-01', status: 'pending' })
    } finally { c.release() }
    const plan = await tx(cl => planMountainViewSpaces(cl, w.at), false)
    expect(plan.refused).toMatch(/MH 12 is not vacant/)
    await expect(tx(cl => applyMountainViewSpaces(cl, plan, w.at), false)).rejects.toThrow(/MH 12/)
  })

  it('makes the two classes when the property has neither', async () => {
    const w = await park()
    await db.query(`DELETE FROM property_unit_subtypes WHERE id = ANY($1::uuid[])`, [[w.single, w.double]])
    await tx(async c => applyMountainViewSpaces(c, await planMountainViewSpaces(c, w.at), w.at), true)
    const after = await unitsOf(w.at.propertyId)
    expect(after['MH 09'].tags).toEqual(['Double wide'])
    expect(after['MH 03'].tags).toEqual(['Single wide'])
    expect(after['MH 11'].tags).toEqual(['Corner lot', 'Double wide'])
  })
})

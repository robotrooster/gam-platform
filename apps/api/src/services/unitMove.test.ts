/**
 * S641 (Nic) — a resident moves spaces without ending their tenancy.
 *
 *   "Moving sites at an RV park is very common, especially when somebody with a
 *    nice shade tree leaves and somebody else wants to take that spot. I don't
 *    wanna have to terminate their lease, send them a new lease for the new
 *    spot. I want to just be able to move them in the system and say, as of this
 *    date, they moved from this spot to this spot, have it coordinate utilities
 *    for both."
 *
 *   "If they move mid month, it's gonna have a meter read start and end from the
 *    first part of the month for that first site and for the later half of the
 *    month start and end for the later site, and show them as line items."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import { moveLeaseToUnit, leaseUnitsInWindow } from './unitMove'

beforeEach(async () => { await cleanupAllSchema() })

async function world(opts: { withMeters?: boolean } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const mk = async (n: string) => {
      const id = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      await c.query(`UPDATE units SET unit_number=$2, unit_type='rv_spot', status='vacant' WHERE id=$1`, [id, n])
      return id
    }
    const shady = await mk('RV 12')
    const sunny = await mk('RV 23')
    const taken = await mk('RV 40')

    const leaseId = await seedLease(c, { unitId: shady, landlordId: ll.landlordId, startDate: '2026-01-01' })
    await c.query(`UPDATE units SET status='active' WHERE id=$1`, [shady])

    // somebody else already lives on RV 40
    const otherLease = await seedLease(c, { unitId: taken, landlordId: ll.landlordId, startDate: '2026-01-01' })

    if (opts.withMeters) {
      for (const [unitId, label] of [[shady, 'RV 12 electric'], [sunny, 'RV 23 electric']] as const) {
        const m = await c.query<{ id: string }>(
          `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, digits)
           VALUES ($1,'electric',$2,'submeter',6) RETURNING id`, [propertyId, label])
        await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
          [m.rows[0].id, unitId])
      }
    }
    await c.query('COMMIT')
    return { ...ll, propertyId, shady, sunny, taken, leaseId, otherLease }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('moving a resident to another space', () => {
  it('keeps the same lease and changes only which space it occupies', async () => {
    const w = await world()
    const r = await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    expect(r.fromUnitId).toBe(w.shady)
    expect(r.toUnitId).toBe(w.sunny)

    const { rows } = await db.query(`SELECT unit_id, status FROM leases WHERE id=$1`, [w.leaseId])
    expect(rows[0].unit_id).toBe(w.sunny)
    expect(rows[0].status).toBe('active')   // not terminated, not replaced
  })

  it('records both periods, seamed on the move date', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const { rows } = await db.query(
      `SELECT unit_id, to_char(effective_from,'YYYY-MM-DD') AS f,
              to_char(effective_to,'YYYY-MM-DD') AS t
         FROM lease_unit_history WHERE lease_id=$1 ORDER BY effective_from`, [w.leaseId])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ unit_id: w.shady, f: '2026-01-01', t: '2026-06-15' })
    expect(rows[1]).toMatchObject({ unit_id: w.sunny, f: '2026-06-15', t: null })
  })

  // The whole point: two line items, not one blended figure.
  it('a mid-month move splits the billing window across both spaces', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const slices = await leaseUnitsInWindow(w.leaseId, '2026-06-01', '2026-06-30')
    expect(slices).toHaveLength(2)
    expect(slices[0]).toMatchObject({ unit_number: 'RV 12', from_date: '2026-06-01', to_date: '2026-06-15' })
    expect(slices[1]).toMatchObject({ unit_number: 'RV 23', from_date: '2026-06-15', to_date: '2026-06-30' })
  })

  it('a month with no move is still a single line', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const july = await leaseUnitsInWindow(w.leaseId, '2026-07-01', '2026-07-31')
    expect(july).toHaveLength(1)
    expect(july[0].unit_number).toBe('RV 23')
  })

  it('names the meters that need closing and opening reads', async () => {
    const w = await world({ withMeters: true })
    const r = await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    expect(r.closingReadsNeeded.map(m => m.label)).toEqual(['RV 12 electric'])
    expect(r.openingReadsNeeded.map(m => m.label)).toEqual(['RV 23 electric'])
  })

  it('frees the old space and occupies the new one', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-15' })
    const { rows } = await db.query(
      `SELECT id, status FROM units WHERE id = ANY($1::uuid[])`, [[w.shady, w.sunny]])
    const by = Object.fromEntries(rows.map((r: any) => [r.id, r.status]))
    expect(by[w.shady]).toBe('vacant')
    expect(by[w.sunny]).toBe('active')
  })

  // The one mistake that cannot be repaired by history.
  it('refuses a space somebody else occupies', async () => {
    const w = await world()
    await expect(moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.taken, movedOn: '2026-06-15' }))
      .rejects.toThrow(/occupied/i)
  })

  it('refuses a move date before the tenancy started', async () => {
    const w = await world()
    await expect(moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2025-12-01' }))
      .rejects.toThrow(/before the tenancy/i)
  })

  it('refuses moving somewhere they already are', async () => {
    const w = await world()
    await expect(moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.shady, movedOn: '2026-06-15' }))
      .rejects.toThrow(/already in that space/i)
  })

  it('two moves in one month produce three slices', async () => {
    const w = await world()
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.sunny, movedOn: '2026-06-10' })
    await moveLeaseToUnit({ leaseId: w.leaseId, toUnitId: w.shady, movedOn: '2026-06-20' })
    const slices = await leaseUnitsInWindow(w.leaseId, '2026-06-01', '2026-06-30')
    expect(slices.map(s => s.unit_number)).toEqual(['RV 12', 'RV 23', 'RV 12'])
  })
})

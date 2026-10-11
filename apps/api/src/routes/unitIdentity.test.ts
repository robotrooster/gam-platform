/**
 * S641 (Nic) — a unit's identity: which building it is in, and what it has
 * been called over time.
 *
 *   "Apartment 101 or 201, duplicated at the property when assigned a separate
 *    building. That's one tier that we didn't come up with yet."
 *
 *   "I don't know why we're retiring units and replacing… would we just say
 *    that we're changing the unit number in the system — show a timeline of:
 *    this was classified as unit one up until this date, and it's been since
 *    changed to unit number two."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

beforeEach(async () => { await cleanupAllSchema() })

async function world() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query('COMMIT')
    return { ...ll, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const mkUnit = (propertyId: string, landlordId: string, number: string, building: string | null) =>
  db.query(
    `INSERT INTO units (property_id, landlord_id, unit_number, building, unit_type, rent_amount)
     VALUES ($1,$2,$3,$4,'apartment',1000) RETURNING id`,
    [propertyId, landlordId, number, building])

describe('a building is part of the unit number', () => {
  it('the same apartment number can exist in two buildings', async () => {
    const w = await world()
    await mkUnit(w.propertyId, w.landlordId, '101', 'Building 1')
    await expect(mkUnit(w.propertyId, w.landlordId, '101', 'Building 2')).resolves.toBeTruthy()
  })

  it('but not twice in the SAME building', async () => {
    const w = await world()
    await mkUnit(w.propertyId, w.landlordId, '101', 'Building 1')
    await expect(mkUnit(w.propertyId, w.landlordId, '101', 'Building 1')).rejects.toThrow()
  })

  // A park with no buildings must behave exactly as it always did.
  it('a property with no buildings still allows only one of each number', async () => {
    const w = await world()
    await mkUnit(w.propertyId, w.landlordId, 'RV 12', null)
    await expect(mkUnit(w.propertyId, w.landlordId, 'RV 12', null)).rejects.toThrow()
  })

  it('blank and absent are the same building, not two', async () => {
    const w = await world()
    await mkUnit(w.propertyId, w.landlordId, '5', null)
    // a blank string is refused outright rather than becoming a second building
    await expect(mkUnit(w.propertyId, w.landlordId, '5', '   ')).rejects.toThrow()
  })

  it('letter suffixes work, and differ from each other', async () => {
    const w = await world()
    await mkUnit(w.propertyId, w.landlordId, '14A', 'Building 1')
    await expect(mkUnit(w.propertyId, w.landlordId, '14B', 'Building 1')).resolves.toBeTruthy()
    await expect(mkUnit(w.propertyId, w.landlordId, '14a', 'Building 1')).rejects.toThrow()
  })
})

describe('what a space has been called', () => {
  it('a new unit opens its first period automatically', async () => {
    const w = await world()
    const r = await mkUnit(w.propertyId, w.landlordId, 'MH 5', null)
    const { rows } = await db.query(
      `SELECT unit_number, effective_to FROM unit_number_history WHERE unit_id=$1`, [r.rows[0].id])
    expect(rows).toHaveLength(1)
    expect(rows[0].unit_number).toBe('MH 5')
    expect(rows[0].effective_to).toBeNull()
  })

  it('renaming closes the old period and opens a new one', async () => {
    const w = await world()
    const r = await mkUnit(w.propertyId, w.landlordId, 'MH 5', null)
    await db.query(`UPDATE units SET unit_number='MH 12' WHERE id=$1`, [r.rows[0].id])

    const { rows } = await db.query(
      `SELECT unit_number, effective_to FROM unit_number_history
        WHERE unit_id=$1 ORDER BY effective_from`, [r.rows[0].id])
    expect(rows.map((x: any) => x.unit_number)).toEqual(['MH 5', 'MH 12'])
    expect(rows[0].effective_to).not.toBeNull()   // closed
    expect(rows[1].effective_to).toBeNull()       // live
  })

  // The whole point: March's invoice can say what March said.
  it('answers what it was called on a given date', async () => {
    const w = await world()
    const r = await mkUnit(w.propertyId, w.landlordId, 'MH 5', null)
    const id = r.rows[0].id
    await db.query(`UPDATE unit_number_history SET effective_from = now() - interval '90 days' WHERE unit_id=$1`, [id])
    await db.query(`UPDATE units SET unit_number='MH 12' WHERE id=$1`, [id])

    const then = await db.query(`SELECT unit_number_on($1, now() - interval '30 days') AS n`, [id])
    const now  = await db.query(`SELECT unit_number_on($1, now()) AS n`, [id])
    expect(then.rows[0].n).toBe('MH 5')
    expect(now.rows[0].n).toBe('MH 12')
  })

  it('changing the building is a change of identity too', async () => {
    const w = await world()
    const r = await mkUnit(w.propertyId, w.landlordId, '101', 'Building 1')
    await db.query(`UPDATE units SET building='Building 2' WHERE id=$1`, [r.rows[0].id])
    const { rows } = await db.query(
      `SELECT building FROM unit_number_history WHERE unit_id=$1 ORDER BY effective_from`, [r.rows[0].id])
    expect(rows.map((x: any) => x.building)).toEqual(['Building 1', 'Building 2'])
  })

  it('an unrelated edit does not open a period', async () => {
    const w = await world()
    const r = await mkUnit(w.propertyId, w.landlordId, 'MH 5', null)
    await db.query(`UPDATE units SET rent_amount=1234 WHERE id=$1`, [r.rows[0].id])
    const { rows } = await db.query(
      `SELECT 1 FROM unit_number_history WHERE unit_id=$1`, [r.rows[0].id])
    expect(rows).toHaveLength(1)
  })

  it('exactly one period is ever open', async () => {
    const w = await world()
    const r = await mkUnit(w.propertyId, w.landlordId, 'A', null)
    for (const n of ['B', 'C', 'D']) {
      await db.query(`UPDATE units SET unit_number=$2 WHERE id=$1`, [r.rows[0].id, n])
    }
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM unit_number_history WHERE unit_id=$1 AND effective_to IS NULL`,
      [r.rows[0].id])
    expect(rows[0].n).toBe(1)
  })
})

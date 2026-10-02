// S654 (Nic): "If I mark a unit as owner use, that should mark it as occupied in
// the system so that nothing can overlap the schedule on that."
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { findStayConflict, findAvailableUnits } from './unitAvailability'

beforeEach(cleanupAllSchema)

async function seed() {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const ownerUnit = await seedUnit(c, { propertyId, landlordId })
    const openUnit = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET status = 'owner_use' WHERE id = $1`, [ownerUnit])
    return { landlordId, ownerUnit, openUnit }
  } finally { c.release() }
}

describe('S654 an owner-use site is occupied', () => {
  it('a stay on it is refused', async () => {
    const s = await seed()
    expect(await findStayConflict(s.ownerUnit, { checkIn: '2026-11-01', checkOut: '2026-11-05' })).toBe('owner_use')
    expect(await findStayConflict(s.openUnit, { checkIn: '2026-11-01', checkOut: '2026-11-05' })).toBeNull()
  })
  it('it is never offered as available', async () => {
    const s = await seed()
    const rows = await findAvailableUnits({ landlordIds: [s.landlordId], window: { checkIn: '2026-11-01', checkOut: '2026-11-05' } })
    const ids = rows.map((r: any) => r.id)
    expect(ids).toContain(s.openUnit)
    expect(ids).not.toContain(s.ownerUnit)
  })
})

/**
 * 10/5 — the day-before inspection reminder goes to every person running the
 * property, and to the tenant ONCE. A property run by a management company has
 * one recipient per active staff member; the tenant was getting one identical
 * reminder per staff member.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit } from '../test/dbHelpers'

const { reminderMock, partyMock } = vi.hoisted(() => ({
  reminderMock: vi.fn(async (_o: any) => {}),
  partyMock: vi.fn(async (_p: string): Promise<any> => null),
}))
vi.mock('../services/notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyInspectionScheduledReminder: (o: any) => reminderMock(o),
}))
vi.mock('../services/responsibleParty', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPropertyResponsibleParty: (p: string) => partyMock(p),
}))
import { processOperationalNudges } from './operationalNudges'

beforeEach(async () => { await cleanupAllSchema(); reminderMock.mockClear(); partyMock.mockReset() })

describe('the day-before inspection reminder', () => {
  it('every staff member is reminded; the tenant once', async () => {
    const c = await db.connect()
    let inspectionId = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const tenantId = await seedTenant(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      inspectionId = (await c.query<{ id: string }>(
        `INSERT INTO unit_inspections (unit_id, tenant_id, landlord_id, inspection_type, status, scheduled_for)
         VALUES ($1,$2,$3,'periodic','draft', NOW() + interval '6 hours') RETURNING id`,
        [unitId, tenantId, landlordId])).rows[0].id
      await c.query('COMMIT')
      partyMock.mockResolvedValue({ primaries: [
        { user_id: userId, email: 'a@pm.test', phone: null },
        { user_id: userId, email: 'b@pm.test', phone: null },
      ], additionals: [] })
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    await processOperationalNudges()
    const calls = reminderMock.mock.calls.map(x => x[0])
    expect(calls.map(x => x.landlordEmail)).toEqual(['a@pm.test', 'b@pm.test'])
    expect(calls.filter(x => x.tenantEmail)).toHaveLength(1)
    expect(calls.every(x => x.inspectionId === inspectionId)).toBe(true)
  })
})

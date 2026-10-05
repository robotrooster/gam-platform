/**
 * Final sweep (10/3) — the nightly lease-end job (processLeaseEnds).
 *
 * An add-a-roommate addendum writes the roommate's spot ('pending_add') the
 * moment it is drafted, before anyone signs. When the lease ended, the job
 * marked that spot 'removed' / lease_ended, as if the person had been on the
 * lease. They never were: the spot is void now, the way voiding the addendum
 * leaves it (lib/leaseDocCascade.ts). The people who were on it are removed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'

vi.mock('../services/notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createNotification: vi.fn(async () => ({})),
}))

import { processLeaseEnds } from './scheduler'

beforeEach(async () => { await cleanupAllSchema() })

describe('nightly lease end: an unsigned roommate spot becomes void, not removed', () => {
  it('the household is removed (lease_ended); the never-signed roommate is void', async () => {
    const c = await db.connect()
    let w: { landlordId: string; unitId: string; leaseId: string; holder: string; roommate: string }
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, startDate: '2026-01-01', leaseType: 'fixed_term' })
      // Ended yesterday: tonight's run expires it.
      await c.query(`UPDATE leases SET end_date = CURRENT_DATE - 1 WHERE id = $1`, [leaseId])
      const holder = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId: holder })
      const roommate = await seedTenant(c)
      const addendum = (await c.query<{ id: string }>(
        `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
         VALUES ($1,$2,$3,'Add a roommate','addendum_add','in_progress') RETURNING id`,
        [ll.landlordId, unitId, leaseId])).rows[0].id
      await c.query(
        `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_reason, financial_responsibility, add_document_id)
         VALUES ($1,$2,'co_tenant','pending_add','roommate_added','joint_several',$3)`,
        [leaseId, roommate, addendum])
      await c.query('COMMIT')
      w = { landlordId: ll.landlordId, unitId, leaseId, holder, roommate }
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    await processLeaseEnds()

    expect((await db.query(`SELECT status FROM leases WHERE id = $1`, [w!.leaseId])).rows[0].status).toBe('expired')
    const spots = await db.query<{ tenant_id: string; status: string; removed_reason: string | null; removed_at: string | null }>(
      `SELECT tenant_id, status, removed_reason, removed_at FROM lease_tenants WHERE lease_id = $1`, [w!.leaseId])
    expect(spots.rows.find(r => r.tenant_id === w!.holder)).toMatchObject({ status: 'removed', removed_reason: 'lease_ended' })
    expect(spots.rows.find(r => r.tenant_id === w!.roommate)).toMatchObject({ status: 'void', removed_reason: null, removed_at: null })
  })
})

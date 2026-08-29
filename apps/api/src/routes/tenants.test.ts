import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'

beforeEach(async () => { await cleanupAllSchema() })


/**
 * S629 — two spots, two leases, ONE portal account.
 *
 * Nic: "I've got a couple of people that have two spots, two separate leases.
 * I need them to not be two separate tenant portal accounts... very important
 * that it doesn't screw that up."
 *
 * The account half was already right — the invite reuses an existing user and
 * tenant row. The invite half was not: pending_tenant_intents was UNIQUE on
 * tenant_id alone and the route did ON CONFLICT (tenant_id) DO UPDATE SET
 * unit_id = EXCLUDED.unit_id, so the second invite MOVED the first one. They
 * would have ended up with a single lease and no sign an invite was lost.
 */
describe('one person, two units', () => {
  it('keeps both invites alive against one tenant record', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: llUser, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
      const unitA = await seedUnit(c, { propertyId, landlordId })
      const unitB = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)

      // Two invites for the same person, one per unit — what the route now does.
      for (const unitId of [unitA, unitB]) {
        await c.query(
          `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
           VALUES ($1,$2,'not_uploaded',$3)
           ON CONFLICT (tenant_id, unit_id) WHERE cancelled_at IS NULL AND unit_id IS NOT NULL
           DO UPDATE SET resolved_at=NULL, accepted_at=NULL, updated_at=NOW()`,
          [landlordId, tenantId, unitId])
      }
      await c.query('COMMIT')

      const live = await query<any>(
        `SELECT unit_id FROM pending_tenant_intents
          WHERE tenant_id=$1 AND cancelled_at IS NULL ORDER BY created_at`, [tenantId])
      expect(live, 'both invites survive — the second must not move the first').toHaveLength(2)
      expect(live.map(r => r.unit_id).sort()).toEqual([unitA, unitB].sort())

      // One person, one tenant record, one login.
      const tenants = await query<any>(`SELECT id FROM tenants WHERE id=$1`, [tenantId])
      expect(tenants).toHaveLength(1)
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  })

  it('re-inviting to the SAME unit reopens that invite rather than adding one', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: llUser, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      for (let i = 0; i < 2; i++) {
        await c.query(
          `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
           VALUES ($1,$2,'not_uploaded',$3)
           ON CONFLICT (tenant_id, unit_id) WHERE cancelled_at IS NULL AND unit_id IS NOT NULL
           DO UPDATE SET resolved_at=NULL, accepted_at=NULL, updated_at=NOW()`,
          [landlordId, tenantId, unitId])
      }
      await c.query('COMMIT')
      const live = await query<any>(
        `SELECT id FROM pending_tenant_intents WHERE tenant_id=$1 AND cancelled_at IS NULL`, [tenantId])
      expect(live, 'the same unit twice is one invite, reopened').toHaveLength(1)
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  })
})

/**
 * S516: cross-property FlexDeposit custody forwarding (ToS § 9.1.6).
 *
 * executeDepositPortability must, given the target lease's own S515
 * deposit row, MERGE into it (delete the untouched duplicate, re-point the
 * funded row) and apply the custody-fee rule:
 *   - fully funded by the carry-forward (same/smaller deposit) → funded +
 *     custody_fee_active = FALSE (fee dissolves)
 *   - larger deposit at the new property → status partial, custody fee stays
 *     active until the top-up is funded.
 *
 * Functions run through the pool, so seeds are committed and cleaned per test.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  detectPortabilityEligible, authorizeDepositPortability, executeDepositPortability,
} from './depositPortability'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
  seedSecurityDeposit,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

// Seed: tenant with a FUNDED gam_escrow deposit on an active lease A, plus a
// target pending lease B that already has its own (S515) pending deposit row.
async function seedForwardScenario(targetTotal: number) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const tenantId = await seedTenant(c)

    const unitA = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const leaseA = await seedLease(c, { unitId: unitA, landlordId, rentAmount: 1000, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId, role: 'primary' })
    const depositId = await seedSecurityDeposit(c, {
      unitId: unitA, leaseId: leaseA, tenantId,
      totalAmount: 1000, collectedAmount: 1000, heldBy: 'gam_escrow', status: 'funded',
    })
    // Make the source a fully-funded FlexDeposit (2 settled installments) so
    // a larger-deposit forward exercises the top-up installment generator.
    await c.query(
      `UPDATE security_deposits
          SET flex_deposit_enabled = TRUE, flex_deposit_plan_status = 'completed',
              installment_count = 2, installments_paid = 2, installments_remaining = 0
        WHERE id = $1`, [depositId])
    await c.query(
      `INSERT INTO flex_deposit_installments
         (security_deposit_id, tenant_id, installment_number, installment_count,
          amount, due_date, status)
       VALUES ($1,$2,1,2,500,CURRENT_DATE,'settled'),
              ($1,$2,2,2,500,CURRENT_DATE,'settled')`, [depositId, tenantId])

    const unitB = await seedUnit(c, { propertyId, landlordId, rentAmount: 1100 })
    const leaseB = await seedLease(c, { unitId: unitB, landlordId, rentAmount: 1100, status: 'pending' })
    await seedLeaseTenant(c, { leaseId: leaseB, tenantId, role: 'primary' })
    const targetDepId = await seedSecurityDeposit(c, {
      unitId: unitB, leaseId: leaseB, tenantId,
      totalAmount: targetTotal, collectedAmount: 0, heldBy: 'gam_escrow', status: 'pending',
    })

    await c.query('COMMIT')
    return { tenantId, leaseA, leaseB, depositId, targetDepId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function getRow(id: string) {
  const r = await db.query(
    `SELECT lease_id, status, held_by, portability_status, custody_fee_active,
            total_amount::text FROM security_deposits WHERE id = $1`, [id])
  return r.rows[0] ?? null
}

describe('executeDepositPortability — custody forwarding (S516)', () => {
  it('same-size deposit: merges into target, deletes the duplicate, dissolves the custody fee', async () => {
    const s = await seedForwardScenario(1000)
    const elig = await detectPortabilityEligible({ leaseId: s.leaseA })
    expect(elig.eligible).toBe(true)
    expect(elig.target_lease_id).toBe(s.leaseB)

    await authorizeDepositPortability({
      tenantId: s.tenantId, depositId: s.depositId,
      targetLeaseId: s.leaseB, signature: 'tenant-signed',
    })
    const res = await executeDepositPortability({ depositId: s.depositId })
    expect(res.status).toBe('carried_forward')

    // Carried row now lives on lease B, fully funded, fee dissolved.
    const carried = await getRow(s.depositId)
    expect(carried.lease_id).toBe(s.leaseB)
    expect(carried.portability_status).toBe('carried_forward')
    expect(carried.status).toBe('funded')
    expect(carried.custody_fee_active).toBe(false)

    // The target lease's own (untouched) S515 row was deleted — no duplicate.
    expect(await getRow(s.targetDepId)).toBeNull()
  })

  it('larger deposit at the new property: stays partial, custody fee stays active', async () => {
    const s = await seedForwardScenario(1500)  // needs $500 top-up over the $1000 carried
    await authorizeDepositPortability({
      tenantId: s.tenantId, depositId: s.depositId,
      targetLeaseId: s.leaseB, signature: 'tenant-signed',
    })
    await executeDepositPortability({ depositId: s.depositId })

    const carried = await getRow(s.depositId)
    expect(carried.lease_id).toBe(s.leaseB)
    expect(Number(carried.total_amount)).toBe(1500)
    expect(carried.status).toBe('partial')
    expect(carried.custody_fee_active).toBe(true)

    // Top-up installments were generated for the $500 difference, numbered
    // after the original (settled) schedule, and are pending for the cron.
    const topups = await db.query(
      `SELECT amount::text, installment_number, status
         FROM flex_deposit_installments
        WHERE security_deposit_id = $1 AND status = 'pending'
        ORDER BY installment_number`, [s.depositId])
    expect(topups.rows.length).toBeGreaterThanOrEqual(2)
    expect(topups.rows.every(r => Number(r.installment_number) > 2)).toBe(true)
    const sum = topups.rows.reduce((a, r) => a + Number(r.amount), 0)
    expect(sum).toBeCloseTo(500, 2)
  })
})

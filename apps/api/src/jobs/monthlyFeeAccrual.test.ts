/**
 * S69 monthly manager-fee accrual cron.
 *
 * Scoped to the in-house manager path (owner ≠ managed_by AND no
 * pm_company_id on the property). The PM-company parallel path is
 * exercised by allocation tests + the pm subsystem suite; this file
 * stays focused on the owner-employee manager case.
 *
 * Covers:
 *   - happy path: posts a monthly_fee_accruals row + an
 *     allocation_manager_fee user_balance_ledger entry tagged to the
 *     manager user, sized correctly from flat + per_unit × occupied
 *   - idempotency: re-running the same month is a no-op
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { processMonthlyFeeAccrual } from './monthlyFeeAccrual'
import {
  cleanupAllSchema,
  seedLandlord, seedManager, seedTenant,
  seedProperty, seedUnit,
  seedAllocationRule,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface AccrualStack {
  landlordId:     string
  ownerUserId:    string
  managerUserId:  string
  propertyId:     string
  unitId:         string
}

/**
 * Seeds an in-house-manager-eligible property: owner ≠ managed_by,
 * pm_company_id NULL, one active (occupied) unit, configurable
 * allocation rule. Caller supplies the fee shape.
 */
async function buildManagerStack(opts: {
  flatMonthlyFee?:  number
  perUnitFee?:      number
}): Promise<AccrualStack> {
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const managerUserId = await seedManager(client)

    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: managerUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    // Mark unit active (occupied) so the per_unit_fee math counts it.
    await client.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])

    // Insert allocation rule directly to set flat/per-unit fees.
    await client.query(
      `INSERT INTO property_allocation_rules
         (property_id, flat_monthly_fee, per_unit_fee,
          ach_fee_payer, card_fee_payer, platform_fee_payer)
       VALUES ($1, $2, $3, 'tenant', 'tenant', 'landlord')`,
      [propertyId, opts.flatMonthlyFee ?? 0, opts.perUnitFee ?? 0]
    )
    return { landlordId, ownerUserId, managerUserId, propertyId, unitId }
  } finally {
    client.release()
  }
}

describe('processMonthlyFeeAccrual', () => {
  it('happy: posts accrual row + manager-fee ledger entry sized flat + per_unit × occupied', async () => {
    const stack = await buildManagerStack({
      flatMonthlyFee: 50,
      perUnitFee:     10,
    })
    // Pin the run to a calendar date — the accrual_month is computed
    // from now.toUTC().firstOfMonth(), so 2026-05-01 makes the
    // accrual row land on '2026-05-01'.
    const result = await processMonthlyFeeAccrual(new Date('2026-05-01T08:00:00Z'))

    expect(result.propertiesProcessed).toBe(1)
    expect(result.feesAccrued).toBe(1)
    expect(result.skippedZero).toBe(0)
    expect(result.skippedAlreadyAccrued).toBe(0)
    expect(result.errors).toHaveLength(0)

    // 1 occupied unit × 10 + 50 flat = 60.
    const accrual = await db.query<{
      property_id:          string
      accrual_month:        string
      occupied_unit_count:  number
      total_amount:         string
      manager_user_id:      string
      ledger_entry_id:      string | null
    }>(
      `SELECT property_id, accrual_month::text, occupied_unit_count,
              total_amount::text, manager_user_id, ledger_entry_id
         FROM monthly_fee_accruals WHERE property_id=$1`,
      [stack.propertyId]
    )
    expect(accrual.rows).toHaveLength(1)
    expect(accrual.rows[0]).toMatchObject({
      property_id:         stack.propertyId,
      accrual_month:       '2026-05-01',
      occupied_unit_count: 1,
      total_amount:        '60.00',
      manager_user_id:     stack.managerUserId,
    })
    // Ledger entry got linked back to the accrual row.
    expect(accrual.rows[0].ledger_entry_id).not.toBeNull()

    // user_balance_ledger entry on the manager user, type=manager_fee,
    // amount=60.
    const ledger = await db.query<{
      user_id: string; type: string; amount: string; reference_type: string
    }>(
      `SELECT user_id, type, amount::text AS amount, reference_type
         FROM user_balance_ledger WHERE user_id=$1`,
      [stack.managerUserId]
    )
    expect(ledger.rows).toHaveLength(1)
    expect(ledger.rows[0]).toMatchObject({
      user_id:        stack.managerUserId,
      type:           'allocation_manager_fee',
      amount:         '60.00',
      reference_type: 'monthly_fee_accrual',
    })
  })

  it('idempotent: re-running for the same month writes nothing, returns skippedAlreadyAccrued', async () => {
    const stack = await buildManagerStack({
      flatMonthlyFee: 100, perUnitFee: 0,
    })
    const r1 = await processMonthlyFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(r1.feesAccrued).toBe(1)

    const r2 = await processMonthlyFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(r2.feesAccrued).toBe(0)
    expect(r2.skippedAlreadyAccrued).toBe(1)
    expect(r2.errors).toHaveLength(0)

    // Still exactly one accrual + one ledger entry — no double-post.
    const counts = await db.query<{ accrual: string; ledger: string }>(`
      SELECT
        (SELECT COUNT(*)::text FROM monthly_fee_accruals WHERE property_id=$1) AS accrual,
        (SELECT COUNT(*)::text FROM user_balance_ledger WHERE user_id=$2)      AS ledger
    `, [stack.propertyId, stack.managerUserId])
    expect(counts.rows[0].accrual).toBe('1')
    expect(counts.rows[0].ledger).toBe('1')
  })

  it('skips zero-fee properties (no flat, no per-unit, no allocation_manager_fee row)', async () => {
    const stack = await buildManagerStack({})  // both fees default to 0
    // candidates SQL filters on flat>0 OR per_unit>0, so the property
    // never enters the loop — propertiesProcessed stays 0, no accrual
    // row gets written.
    const result = await processMonthlyFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.propertiesProcessed).toBe(0)
    expect(result.feesAccrued).toBe(0)

    const accrual = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM monthly_fee_accruals WHERE property_id=$1`,
      [stack.propertyId]
    )
    expect(accrual.rows[0].n).toBe('0')
  })
})

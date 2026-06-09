/**
 * S120 platform-fee accrual cron.
 *
 * Covers the long-term-unit aggregation + payer-toggle branches:
 *   - landlord-payer happy path: posts platform_fee_accruals +
 *     platform_revenue_ledger entry
 *   - min-per-property floor: rate × billable < min → totalAmount = min
 *   - tenant-payer: accrual row only, no platform_revenue_ledger entry
 *     (the rent-charge path picks it up later — out of scope here)
 *
 * Short-stay nights branch deferred; the math is exercised inline by
 * the SUM(LEAST/GREATEST) clamp which would need a unit_bookings
 * fixture. Long-term aggregation is the common case.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { processPlatformFeeAccrual } from './platformFeeAccrual'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant,
  seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(async () => {
  await cleanupAllSchema()
  // platform_fee_config is config (not user data), so cleanupAllSchema
  // leaves it alone — clear + reseed locally so each test sees a
  // single active row at the locked S113 rate ($2/unit, $10 floor).
  await db.query(`DELETE FROM platform_fee_config`)
  await db.query(`DELETE FROM landlord_platform_fee_overrides`)
  await db.query(
    `INSERT INTO platform_fee_config (rate_per_unit, min_per_property, notes)
     VALUES (2.00, 10.00, 'Test default')`
  )
})

interface PlatformStack {
  landlordId: string
  ownerUserId: string
  tenantId: string
  propertyId: string
  unitId: string
  leaseId: string
}

async function buildPlatformStack(opts: {
  unitCount?:      number  // number of active+leased units to seed
  platformFeePayer?: 'landlord' | 'tenant'
}): Promise<PlatformStack> {
  const unitCount = opts.unitCount ?? 1
  const payer = opts.platformFeePayer ?? 'landlord'
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: ownerUserId,
    })

    // Allocation rule (sets platform_fee_payer).
    await client.query(
      `INSERT INTO property_allocation_rules
         (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer)
       VALUES ($1, 'tenant', 'tenant', $2)`,
      [propertyId, payer]
    )

    let firstUnitId: string | null = null
    let firstLeaseId: string | null = null
    for (let i = 0; i < unitCount; i++) {
      const unitId = await seedUnit(client, {
        propertyId, landlordId, rentAmount: 1000,
      })
      await client.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
      const leaseId = await seedLease(client, {
        unitId, landlordId, rentAmount: 1000,
        status: 'active', startDate: '2026-01-01',
      })
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
      if (i === 0) {
        firstUnitId  = unitId
        firstLeaseId = leaseId
      }
    }
    return {
      landlordId, ownerUserId, tenantId, propertyId,
      unitId: firstUnitId!, leaseId: firstLeaseId!,
    }
  } finally {
    client.release()
  }
}

describe('processPlatformFeeAccrual', () => {
  it('landlord-payer happy: 1 LT unit × $2 floored at $10 min, posts accrual + revenue ledger', async () => {
    const stack = await buildPlatformStack({
      unitCount: 1, platformFeePayer: 'landlord',
    })
    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)
    expect(result.errors).toHaveLength(0)

    // 1 unit × $2 = $2; min_per_property = $10; total = max(2, 10) = 10.
    const accrual = await db.query<{
      total_billable: number
      total_amount:   string
      payer:          string
      platform_revenue_ledger_id: string | null
    }>(
      `SELECT total_billable, total_amount::text, payer,
              platform_revenue_ledger_id
         FROM platform_fee_accruals WHERE property_id=$1`,
      [stack.propertyId]
    )
    expect(accrual.rows[0]).toMatchObject({
      total_billable: 1,
      total_amount:   '10.00',
      payer:          'landlord',
    })
    expect(accrual.rows[0].platform_revenue_ledger_id).not.toBeNull()

    const ledger = await db.query<{
      type: string; amount: string; reference_type: string
    }>(
      `SELECT type, amount::text AS amount, reference_type
         FROM platform_revenue_ledger WHERE property_id=$1`,
      [stack.propertyId]
    )
    expect(ledger.rows[0]).toMatchObject({
      type:           'platform_fee_subscription',
      amount:         '10.00',
      reference_type: 'platform_fee_accrual',
    })
  })

  it('above-min: 6 LT units × $2 = $12 (clears the $10 min, exact rate × count applies)', async () => {
    const stack = await buildPlatformStack({
      unitCount: 6, platformFeePayer: 'landlord',
    })
    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)

    const accrual = await db.query<{ total_billable: number; total_amount: string }>(
      `SELECT total_billable, total_amount::text
         FROM platform_fee_accruals WHERE property_id=$1`,
      [stack.propertyId]
    )
    expect(accrual.rows[0]).toMatchObject({
      total_billable: 6,
      total_amount:   '12.00',
    })
  })

  it('tenant-payer: accrual row written, platform_revenue_ledger entry skipped', async () => {
    const stack = await buildPlatformStack({
      unitCount: 1, platformFeePayer: 'tenant',
    })
    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)

    const accrual = await db.query<{
      payer: string; total_amount: string; platform_revenue_ledger_id: string | null
    }>(
      `SELECT payer, total_amount::text, platform_revenue_ledger_id
         FROM platform_fee_accruals WHERE property_id=$1`,
      [stack.propertyId]
    )
    expect(accrual.rows[0].payer).toBe('tenant')
    expect(accrual.rows[0].total_amount).toBe('10.00')
    // No ledger entry — the tenant-payer path defers the revenue post
    // until the next rent charge rolls it into application_fee_amount.
    expect(accrual.rows[0].platform_revenue_ledger_id).toBeNull()

    const ledgerCount = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM platform_revenue_ledger WHERE property_id=$1`,
      [stack.propertyId]
    )
    expect(ledgerCount.rows[0].n).toBe('0')
  })

  it('idempotent: re-running the same month returns skippedAlreadyAccrued and writes no extra rows', async () => {
    const stack = await buildPlatformStack({
      unitCount: 1, platformFeePayer: 'landlord',
    })
    const r1 = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(r1.feesAccrued).toBe(1)
    const r2 = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(r2.feesAccrued).toBe(0)
    expect(r2.skippedAlreadyAccrued).toBe(1)

    const counts = await db.query<{ accrual: string; ledger: string }>(`
      SELECT
        (SELECT COUNT(*)::text FROM platform_fee_accruals      WHERE property_id=$1) AS accrual,
        (SELECT COUNT(*)::text FROM platform_revenue_ledger    WHERE property_id=$1) AS ledger
    `, [stack.propertyId])
    expect(counts.rows[0].accrual).toBe('1')
    expect(counts.rows[0].ledger).toBe('1')
  })

  it('short-stay nights: bookings clamped to the billing month, CEIL(nights/30) added to total_billable', async () => {
    // 0 long-term units, one 'nightly' booking spanning the May cycle.
    // Engine uses LEAST(check_out, month_end+1d) − GREATEST(check_in,
    // month_start), so a booking that straddles the month boundary
    // only contributes the in-month portion.
    //
    // Booking: check_in = 2026-04-25, check_out = 2026-05-12.
    //   Pre-clamp = 17 nights total.
    //   Clamped to May: GREATEST(05-01, 04-25)=05-01, LEAST(05-12, 06-01)=05-12.
    //   In-month nights = 12 - 1 = 11.
    // CEIL(11/30) = 1 short-stay-equivalent unit.
    // 1 SS unit × $2 = $2 → floored at $10 min.
    const client = await getClient()
    let propertyId: string, unitId: string, landlordId: string
    try {
      const { userId: ownerUserId, landlordId: lid } = await seedLandlord(client)
      landlordId = lid
      propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      // Allocation rule (default platform_fee_payer='landlord').
      await client.query(
        `INSERT INTO property_allocation_rules
           (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer)
         VALUES ($1, 'tenant', 'tenant', 'landlord')`,
        [propertyId]
      )
      // Vacant unit — does NOT count toward long-term aggregation. The
      // unit_bookings row attaches to it for the short-stay path.
      unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0 })
      await client.query(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, status,
            check_in, check_out, nights)
         VALUES ($1, $2, 'nightly', 'confirmed',
                 '2026-04-25', '2026-05-12', 17)`,
        [unitId, landlordId]
      )
    } finally {
      client.release()
    }

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)

    const accrual = await db.query<{
      long_term_unit_count:  number
      short_stay_nights:     number
      short_stay_equivalent: number
      total_billable:        number
      total_amount:          string
    }>(
      `SELECT long_term_unit_count, short_stay_nights, short_stay_equivalent,
              total_billable, total_amount::text
         FROM platform_fee_accruals WHERE property_id=$1`,
      [propertyId!]
    )
    expect(accrual.rows[0]).toMatchObject({
      long_term_unit_count:  0,
      short_stay_nights:     11,  // 17 booked nights, clamped to May → 11
      short_stay_equivalent: 1,   // CEIL(11 / 30)
      total_billable:        1,
      total_amount:          '10.00',  // 1 × $2 floored at $10
    })
  })

  it('short-stay nights: cancelled bookings excluded from the count', async () => {
    // Same booking shape as the previous test but status='cancelled' —
    // engine WHERE clause filters these out. Property should accrue
    // 0 billable units; total_billable=0 + min=$10 ⇒ accrued at min.
    const client = await getClient()
    let propertyId: string, unitId: string, landlordId: string
    try {
      const { userId: ownerUserId, landlordId: lid } = await seedLandlord(client)
      landlordId = lid
      propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      await client.query(
        `INSERT INTO property_allocation_rules
           (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer)
         VALUES ($1, 'tenant', 'tenant', 'landlord')`,
        [propertyId]
      )
      unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0 })
      await client.query(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, status,
            check_in, check_out, nights)
         VALUES ($1, $2, 'nightly', 'cancelled',
                 '2026-05-05', '2026-05-15', 10)`,
        [unitId, landlordId]
      )
    } finally {
      client.release()
    }

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)

    const accrual = await db.query<{
      short_stay_nights: number; total_billable: number; total_amount: string
    }>(
      `SELECT short_stay_nights, total_billable, total_amount::text
         FROM platform_fee_accruals WHERE property_id=$1`,
      [propertyId!]
    )
    expect(accrual.rows[0]).toMatchObject({
      short_stay_nights: 0,
      total_billable:    0,
      total_amount:      '10.00',  // pure minimum, no usage
    })
  })
})

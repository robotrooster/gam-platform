/**
 * S120 platform-fee accrual cron.
 *
 * Covers the long-term-unit aggregation + payer-toggle branches:
 *   - landlord-payer happy path: posts platform_fee_accruals +
 *     platform_revenue_ledger entry
 *   - min-per-property floor: rate × billable < min → totalAmount = min
 *   - S607: the platform fee is LOCKED to the landlord, so the old tenant-payer
 *     branch is unreachable; the lock itself is what is now under test
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

  // S607 (Nic, DIRECTIVE): the tenant-payer branch is GONE — not by deleting the
  // code path, but by making the state unreachable. "The landlord cannot toggle
  // the platform fee because when we change for volume discounts or things like
  // that, that needs to not affect what the tenants are paying."
  //
  // This test used to seed platform_fee_payer='tenant' and assert the deferred
  // revenue post. That scenario can no longer exist, so asserting it would be
  // asserting fiction. What is worth guarding is the LOCK itself.
  it('a property can no longer be set to bill the platform fee to tenants', async () => {
    await expect(buildPlatformStack({ unitCount: 1, platformFeePayer: 'tenant' as any }))
      .rejects.toThrow(/platform_fee_payer/)
  })

  it('every accrual posts against the landlord', async () => {
    const stack = await buildPlatformStack({ unitCount: 1, platformFeePayer: 'landlord' })
    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)
    const accrual = await db.query<{ payer: string }>(
      `SELECT payer FROM platform_fee_accruals WHERE property_id=$1`, [stack.propertyId])
    expect(accrual.rows[0].payer).toBe('landlord')
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
      // Vacant RV spot — does NOT count toward long-term aggregation. The
      // unit_bookings row attaches to it for the short-stay path. (S538:
      // rv_spot keeps nights/30; apartment/single_family would route to
      // the STR-percentage path instead.)
      unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0, unitType: 'rv_spot' })
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
      unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0, unitType: 'rv_spot' })
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

  // ── S538 STR pricing: the nights/30 aggregation is ONLY for rv_spot
  //    (space-only). Short-stays on ANY other unit type bill 5% of
  //    pro-rated revenue instead ──────────────────────────────────────────

  async function seedStrProperty(): Promise<{ propertyId: string; landlordId: string }> {
    const client = await getClient()
    try {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      await client.query(
        `INSERT INTO property_allocation_rules
           (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer)
         VALUES ($1, 'tenant', 'tenant', 'landlord')`,
        [propertyId]
      )
      return { propertyId, landlordId }
    } finally {
      client.release()
    }
  }

  it('STR: apartment booking bills 5% of month-pro-rated revenue, contributes ZERO nights', async () => {
    // Booking: $1000 total, 2026-04-25 → 2026-05-12 (17 nights, 11 in May).
    // str_revenue = 1000 × 11/17 = 647.06; fee = 5% = 32.35.
    // No long-term units, no non-STR nights → total = MAX(0 + 32.35, 10).
    const { propertyId, landlordId } = await seedStrProperty()
    const client = await getClient()
    try {
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0, unitType: 'apartment' })
      await client.query(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, status,
            check_in, check_out, nights, total_amount)
         VALUES ($1, $2, 'nightly', 'confirmed',
                 '2026-04-25', '2026-05-12', 17, 1000.00)`,
        [unitId, landlordId]
      )
    } finally {
      client.release()
    }

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)

    const accrual = await db.query<any>(
      `SELECT short_stay_nights, short_stay_equivalent, total_billable,
              str_revenue::text, str_fee_amount::text, total_amount::text
         FROM platform_fee_accruals WHERE property_id=$1`,
      [propertyId]
    )
    expect(accrual.rows[0]).toMatchObject({
      short_stay_nights:     0,        // STR nights never hit the /30 pool
      short_stay_equivalent: 0,
      total_billable:        0,
      str_revenue:           '647.06', // 1000 × 11/17
      str_fee_amount:        '32.35',  // 5%
      total_amount:          '32.35',  // clears the $10 min
    })
  })

  it('STR: small booking folds UNDER the $10 property minimum (no stacking on the floor)', async () => {
    // $100 booking fully inside May → str fee $5. total = MAX(0 + 5, 10) = $10.
    const { propertyId, landlordId } = await seedStrProperty()
    const client = await getClient()
    try {
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0, unitType: 'single_family' })
      await client.query(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, status,
            check_in, check_out, nights, total_amount)
         VALUES ($1, $2, 'nightly', 'confirmed',
                 '2026-05-05', '2026-05-10', 5, 100.00)`,
        [unitId, landlordId]
      )
    } finally {
      client.release()
    }

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)

    const accrual = await db.query<any>(
      `SELECT str_revenue::text, str_fee_amount::text, total_amount::text
         FROM platform_fee_accruals WHERE property_id=$1`,
      [propertyId]
    )
    expect(accrual.rows[0]).toMatchObject({
      str_revenue:    '100.00',
      str_fee_amount: '5.00',
      total_amount:   '10.00',  // MAX(5, min 10)
    })
  })

  it('STR: mobile_home short-stay bills 5% too (aggregation is rv_spot-ONLY)', async () => {
    // Nic: mobile homes aren't generally bookable short-term, but if a
    // landlord does it, it's a coordinated stay → 5%, never nights/30.
    // $400 booking fully in May → $20 fee; no nights in the /30 pool.
    const { propertyId, landlordId } = await seedStrProperty()
    const client = await getClient()
    try {
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0, unitType: 'mobile_home' })
      await client.query(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, status,
            check_in, check_out, nights, total_amount)
         VALUES ($1, $2, 'nightly', 'confirmed',
                 '2026-05-02', '2026-05-12', 10, 400.00)`,
        [unitId, landlordId]
      )
    } finally {
      client.release()
    }

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)

    const accrual = await db.query<any>(
      `SELECT short_stay_nights, str_revenue::text, str_fee_amount::text, total_amount::text
         FROM platform_fee_accruals WHERE property_id=$1`,
      [propertyId]
    )
    expect(accrual.rows[0]).toMatchObject({
      short_stay_nights: 0,
      str_revenue:       '400.00',
      str_fee_amount:    '20.00',
      total_amount:      '20.00',
    })
  })

  it('STR + RV mixed property: rv_spot keeps nights/30, apartment adds 5%, both sum', async () => {
    // RV booking: 10 May nights → CEIL(10/30)=1 billable × $2 = $2.
    // Apartment booking: $500 fully in May → 5% = $25.
    // total = MAX(2 + 25, 10) = $27.
    const { propertyId, landlordId } = await seedStrProperty()
    const client = await getClient()
    try {
      const rvId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0, unitType: 'rv_spot' })
      const aptId = await seedUnit(client, { propertyId, landlordId, rentAmount: 0, unitType: 'apartment' })
      await client.query(
        `INSERT INTO unit_bookings
           (unit_id, landlord_id, lease_type, status,
            check_in, check_out, nights, total_amount)
         VALUES ($1, $3, 'nightly', 'confirmed', '2026-05-01', '2026-05-11', 10, 440.00),
                ($2, $3, 'nightly', 'confirmed', '2026-05-10', '2026-05-20', 10, 500.00)`,
        [rvId, aptId, landlordId]
      )
    } finally {
      client.release()
    }

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.feesAccrued).toBe(1)

    const accrual = await db.query<any>(
      `SELECT short_stay_nights, short_stay_equivalent, total_billable,
              str_revenue::text, str_fee_amount::text, total_amount::text
         FROM platform_fee_accruals WHERE property_id=$1`,
      [propertyId]
    )
    expect(accrual.rows[0]).toMatchObject({
      short_stay_nights:     10,       // RV nights only
      short_stay_equivalent: 1,
      total_billable:        1,
      str_revenue:           '500.00', // apartment booking only
      str_fee_amount:        '25.00',
      total_amount:          '27.00',  // 1×$2 + $25, clears the min
    })
  })
})

// S615 (Nic): "It is technically a unit, so it needs to be billed at two
// dollars." The live estimate counted serviced spaces from S614; this job —
// the one that actually charges — did not. So GAM quoted the landlord one
// number and billed a lower one, under-collecting its own revenue every month.
describe('utility-service spaces accrue the per-unit fee (S615)', () => {
  /** A property with ONE leased unit plus one space next door the landlord
   *  only supplies utilities to. Two billable units, not one. */
  async function stackWithServicedSpace(
    opts: { superseded?: boolean; endDate?: string } = {},
  ): Promise<{ propertyId: string }> {
    const stack = await buildPlatformStack({ unitCount: 1 })
    const client = await getClient()
    try {
      const unitId = await seedUnit(client, {
        propertyId: stack.propertyId, landlordId: stack.landlordId,
      })
      await client.query(
        `UPDATE units SET status='utility_service' WHERE id=$1`, [unitId])
      const payerId = await seedTenant(client)
      let supersedingLeaseId: string | null = null
      if (opts.superseded) {
        supersedingLeaseId = await seedLease(client, {
          unitId, landlordId: stack.landlordId, status: 'active',
          startDate: '2026-01-01',
        })
      }
      await client.query(
        `INSERT INTO utility_service_agreements
           (landlord_id, unit_id, tenant_id, start_date, end_date,
            superseded_by_lease_id)
         VALUES ($1,$2,$3,'2026-01-01',$4,$5)`,
        [stack.landlordId, unitId, payerId, opts.endDate ?? null,
         supersedingLeaseId])
    } finally { client.release() }
    return { propertyId: stack.propertyId }
  }

  it('charges $2 for a space the landlord only supplies utilities to', async () => {
    const { propertyId } = await stackWithServicedSpace()

    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))

    const { rows } = await db.query<any>(
      `SELECT long_term_unit_count, utility_service_unit_count, total_billable
         FROM platform_fee_accruals WHERE property_id = $1`, [propertyId])
    expect(rows).toHaveLength(1)
    expect(rows[0].utility_service_unit_count).toBe(1)
    // Counted separately: a serviced space is not a long-term tenancy and
    // must not be reported to the landlord as one.
    expect(rows[0].long_term_unit_count).toBe(1)
    expect(rows[0].total_billable).toBe(2)
  })

  // The $2 follows the unit to the incoming landlord — never charged twice
  // for one space.
  it('stops charging once a lease supersedes the agreement', async () => {
    const { propertyId } = await stackWithServicedSpace({ superseded: true })

    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))

    const { rows } = await db.query<any>(
      `SELECT utility_service_unit_count FROM platform_fee_accruals
        WHERE property_id = $1`, [propertyId])
    expect(rows[0].utility_service_unit_count).toBe(0)
  })

  it('stops charging once the agreement has ended', async () => {
    const { propertyId } = await stackWithServicedSpace({ endDate: '2026-02-01' })

    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))

    const { rows } = await db.query<any>(
      `SELECT utility_service_unit_count, total_billable
         FROM platform_fee_accruals WHERE property_id = $1`, [propertyId])
    expect(rows[0].utility_service_unit_count).toBe(0)
    expect(rows[0].total_billable).toBe(1)
  })
})

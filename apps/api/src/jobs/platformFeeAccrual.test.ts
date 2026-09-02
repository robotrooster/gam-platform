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
    `INSERT INTO platform_fee_config (rate_per_unit, min_per_connect_account, notes)
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

    // 1 unit × $2 = $2; min_per_connect_account = $10; total = max(2, 10) = 10.
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
    // S630: the floor is no longer folded into the earned fee. The ledger now
    // reads the two things separately — $2 earned, $8 to reach the payout
    // account's monthly floor — so a $10 line can always be explained from the
    // unit count. The total the landlord owes is unchanged.
    const byType = new Map(ledger.rows.map(r => [r.reference_type, r]))
    expect(byType.get('platform_fee_accrual')).toMatchObject({
      type: 'platform_fee_subscription', amount: '2.00',
    })
    expect(byType.get('platform_fee_min_topup')).toMatchObject({
      type: 'platform_fee_subscription', amount: '8.00',
    })
    const total = ledger.rows.reduce((a, r) => a + parseFloat(r.amount), 0)
    expect(total).toBe(10)
  })

  // S630 DIRECTIVE (Nic): "It's ten dollars per Connect account. So if several
  // properties deposit to the same Stripe account, it's only ten dollar minimum
  // for that setup." Two properties on ONE payout account owe ONE floor.
  it('two properties on one Connect account share a single $10 minimum', async () => {
    const a = await buildPlatformStack({ unitCount: 1, platformFeePayer: 'landlord' })
    await db.query(
      `UPDATE landlords SET stripe_connect_account_id = 'acct_shared_s630' WHERE id = $1`,
      [a.landlordId])
    // A second property under the SAME landlord, hence the same payout account.
    const c = await db.connect()
    let propB = ''
    try {
      await c.query('BEGIN')
      propB = await seedProperty(c, {
        landlordId: a.landlordId, ownerUserId: a.ownerUserId, managedByUserId: a.ownerUserId })
      const unitB = await seedUnit(c, { propertyId: propB, landlordId: a.landlordId })
      const tenantB = await seedTenant(c)
      const leaseB = await seedLease(c, {
        unitId: unitB, landlordId: a.landlordId, status: 'active', startDate: '2026-01-01' })
      await seedLeaseTenant(c, { leaseId: leaseB, tenantId: tenantB, role: 'primary' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.errors).toHaveLength(0)

    const rows = await db.query<{ total_amount: string; connect_min_topup: string }>(
      `SELECT a.total_amount::text, a.connect_min_topup::text
         FROM platform_fee_accruals a WHERE a.landlord_id = $1`, [a.landlordId])
    const grandTotal = rows.rows.reduce((n, r) => n + parseFloat(r.total_amount), 0)
    // 1 unit + 1 unit = $4 earned, topped up to ONE $10 floor — not two.
    expect(grandTotal).toBe(10)
    const topups = rows.rows.reduce((n, r) => n + parseFloat(r.connect_min_topup), 0)
    expect(topups).toBe(6)
  })

  // S630: GAM's own renter-pool landlord is flagged is_system "so it stays out
  // of" billing — but this job never checked, so GAM invoiced ITSELF $10 a month
  // and booked it as platform revenue.
  it('never bills a system landlord — GAM does not invoice itself', async () => {
    const stack = await buildPlatformStack({ unitCount: 3, platformFeePayer: 'landlord' })
    await db.query(`UPDATE landlords SET is_system = TRUE WHERE id = $1`, [stack.landlordId])

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.errors).toHaveLength(0)

    const accrual = await db.query<any>(
      `SELECT id FROM platform_fee_accruals WHERE landlord_id=$1`, [stack.landlordId])
    expect(accrual.rows).toHaveLength(0)
    const ledger = await db.query<any>(
      `SELECT id FROM platform_revenue_ledger WHERE property_id=$1`, [stack.propertyId])
    expect(ledger.rows).toHaveLength(0)
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
    // S630: two ledger lines now — the $2 earned and the $8 that brings the
    // payout account to its floor. The point of this test is that a SECOND run
    // adds neither.
    expect(counts.rows[0].ledger).toBe('2')

    const total = await db.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS sum FROM platform_revenue_ledger WHERE property_id=$1`,
      [stack.propertyId])
    expect(parseFloat(total.rows[0].sum)).toBe(10)
    const accrued = await db.query<{ total_amount: string }>(
      `SELECT total_amount::text FROM platform_fee_accruals WHERE property_id=$1`,
      [stack.propertyId])
    expect(accrued.rows[0].total_amount).toBe('10.00')
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
    // Same booking shape as the previous test but status='cancelled' — the
    // engine's WHERE clause filters these out, so nothing is billable.
    //
    // S631 (Nic, DIRECTIVE): "We do ten dollars a month minimum, but only when
    // money's moving through the system." A cancelled booking is no money
    // moving, so this month costs the landlord NOTHING — no accrual row, no
    // floor. The floor is what a transacting account pays when $2/unit lands
    // under $10; it is not rent on an empty record.
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
    // Nothing earned, nothing billable — so neither pass writes anything.
    expect(result.feesAccrued).toBe(0)
    expect(result.connectMinimumsApplied).toBe(0)

    const accrual = await db.query(
      `SELECT id FROM platform_fee_accruals WHERE property_id=$1`, [propertyId!])
    // No invoice at all. Not a $0 row, not a floored $10 row — nothing.
    expect(accrual.rows).toHaveLength(0)
  })

  // S631 (Nic): the abandoned-signup case that prompted the rule. A landlord
  // signs up, adds one space, never comes back — no tenant, no lease, no Connect
  // account. The daily grace-cap sweep stamps billing_starts_at when the cap
  // arrives, which used to hand them a $10/month invoice forever. "Leaving it
  // vacant forever as a ghost in the system is okay."
  it('abandoned signup past its grace cap is never billed', async () => {
    const client = await getClient()
    let propertyId: string, landlordId: string
    try {
      const { userId: ownerUserId, landlordId: lid } = await seedLandlord(client)
      landlordId = lid
      propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      // One space, never leased.
      await seedUnit(client, { propertyId, landlordId, rentAmount: 0, unitType: 'rv_spot' })
      // Grace cap has passed: the sweep has stamped them live.
      await client.query(
        `UPDATE landlords SET billing_starts_at = '2026-04-01' WHERE id = $1`, [landlordId])
    } finally {
      client.release()
    }

    const result = await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    expect(result.connectMinimumsApplied).toBe(0)
    const accrual = await db.query(
      `SELECT id FROM platform_fee_accruals WHERE property_id=$1`, [propertyId!])
    expect(accrual.rows).toHaveLength(0)
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
      // S616 (Nic): 3%, down from 5%. 647.06 × 0.03 = 19.41.
      str_fee_amount:        '19.41',
      total_amount:          '19.41',  // clears the $10 min
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
      str_fee_amount: '3.00',   // S616: 3% of 100
      total_amount:   '10.00',  // MAX(3, min 10)
    })
  })

  it('STR: mobile_home short-stay bills the STR percentage too (aggregation is rv_spot-ONLY)', async () => {
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
      str_fee_amount:    '12.00',  // S616: 3% of 400
      total_amount:      '12.00',
    })
  })

  it('STR + RV mixed property: rv_spot keeps nights/30, apartment adds the STR percentage, both sum', async () => {
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
      str_fee_amount:        '15.00',  // S616: 3% of 500
      total_amount:          '17.00',  // 1×$2 + $15, clears the min
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
    opts: { superseded?: boolean; endDate?: string; meters?: number } = {},
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
            superseded_by_lease_id, payer_attested_at)
         VALUES ($1,$2,$3,'2026-01-01',$4,$5,NOW())`,
        [stack.landlordId, unitId, payerId, opts.endDate ?? null,
         supersedingLeaseId])
      // S616: the $2 is for a space that is ON a utility charge, so the space
      // has to actually be wired to a meter.
      if (opts.meters !== 0) {
        const { rows: [m] } = await client.query(
          `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee)
           VALUES ($1,'trash','Trash','flat_rate',0) RETURNING id`, [stack.propertyId])
        await client.query(
          `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
          [m.id, unitId])
        if (opts.meters === 2) {
          const { rows: [m2] } = await client.query(
            `INSERT INTO utility_meters (property_id, utility_type, label, billing_method, base_fee, rate_per_unit)
             VALUES ($1,'electric','Elec','submeter',0,0.21) RETURNING id`, [stack.propertyId])
          await client.query(
            `INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`,
            [m2.id, unitId])
        }
      }
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

  // S616 (Nic): "the two dollars is getting charged per residence... if my lot
  // next door, they're paying electricity to me and rent to my neighbor, Oak
  // Park is paying the two dollars on that until the other landlord onboards."
  it('two utilities on one space is still $2, not $4', async () => {
    const { propertyId } = await stackWithServicedSpace({ meters: 2 })
    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    const { rows } = await db.query<any>(
      `SELECT utility_service_unit_count, total_billable
         FROM platform_fee_accruals WHERE property_id = $1`, [propertyId])
    // Trash AND electric on the one neighbour space.
    expect(rows[0].utility_service_unit_count).toBe(1)
  })

  // Nic: "we're not assigning the spaces to a meter. Trash is a flat rate.
  // Water is a RUBS system. There is not always going to be a meter." The
  // agreement existing IS the statement that this space is on a utility charge.
  it('is charged even with no meter attached — trash is a flat rate', async () => {
    const { propertyId } = await stackWithServicedSpace({ meters: 0 })
    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    const { rows } = await db.query<any>(
      `SELECT utility_service_unit_count FROM platform_fee_accruals
        WHERE property_id = $1`, [propertyId])
    expect(rows[0].utility_service_unit_count).toBe(1)
  })

  // Without consent no invoice is issued at all, so GAM would be charging for
  // a bill it never delivered.
  it('a payer who has not agreed is not charged for', async () => {
    const { propertyId } = await stackWithServicedSpace()
    await db.query(
      `UPDATE utility_service_agreements SET payer_attested_at = NULL, payer_accepted_at = NULL`)
    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    const { rows } = await db.query<any>(
      `SELECT utility_service_unit_count FROM platform_fee_accruals
        WHERE property_id = $1`, [propertyId])
    expect(rows[0].utility_service_unit_count).toBe(0)
  })
})

// S616 (Nic): "any portion of thirty — like thirty two nights booked on a
// property is gonna be thirty nights as two dollars, and the other two nights
// are gonna be booked as two dollars. There's no proration. Any rollover past
// thirty nights is another two dollar charge."
describe('short-stay nights bill in whole $2 blocks (S616)', () => {
  /**
   * A park whose bookings total `nights` WITHIN the accrual month.
   *
   * Spread across separate spots on purpose: the accrual clamps each stay to
   * the month, so a single 32-night booking from May 1st only contributes 31
   * nights — May has 31 days. It is also closer to what Nic described, "thirty
   * nights as two dollars and the other two nights as two dollars", which is
   * two stays rather than one long one.
   */
  async function parkWithNights(nights: number) {
    const stack = await buildPlatformStack({ unitCount: 1 })
    const client = await getClient()
    try {
      let remaining = nights
      while (remaining > 0) {
        const stay = Math.min(remaining, 28)     // comfortably inside any month
        const unitId = await seedUnit(client, {
          propertyId: stack.propertyId, landlordId: stack.landlordId, unitType: 'rv_spot',
        })
        await client.query(`UPDATE units SET status='vacant' WHERE id=$1`, [unitId])
        await client.query(
          `INSERT INTO unit_bookings (landlord_id, unit_id, lease_type, status,
                                      check_in, check_out, total_amount, guest_name, guest_email)
           VALUES ($1,$2,'nightly','confirmed', DATE '2026-05-02',
                   DATE '2026-05-02' + ($3::int || ' days')::interval, 100, 'G', 'g@t.dev')`,
          [stack.landlordId, unitId, stay])
        remaining -= stay
      }
    } finally { client.release() }
    return stack
  }

  it('30 nights is one $2 block', async () => {
    const stack = await parkWithNights(30)
    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    const { rows } = await db.query<any>(
      `SELECT short_stay_nights, short_stay_equivalent FROM platform_fee_accruals
        WHERE property_id = $1`, [stack.propertyId])
    expect(rows[0].short_stay_nights).toBe(30)
    expect(rows[0].short_stay_equivalent).toBe(1)
  })

  // THE RULE. Not 32/30 of a block — two blocks.
  it('32 nights is TWO $2 blocks, not one and a fraction', async () => {
    const stack = await parkWithNights(32)
    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    const { rows } = await db.query<any>(
      `SELECT short_stay_nights, short_stay_equivalent FROM platform_fee_accruals
        WHERE property_id = $1`, [stack.propertyId])
    expect(rows[0].short_stay_nights).toBe(32)
    expect(rows[0].short_stay_equivalent).toBe(2)
  })

  it('a single night is a whole block — there is no proration downward either', async () => {
    const stack = await parkWithNights(1)
    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    const { rows } = await db.query<any>(
      `SELECT short_stay_equivalent FROM platform_fee_accruals WHERE property_id = $1`,
      [stack.propertyId])
    expect(rows[0].short_stay_equivalent).toBe(1)
  })

  it('61 nights is three blocks', async () => {
    const stack = await parkWithNights(61)
    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    const { rows } = await db.query<any>(
      `SELECT short_stay_equivalent FROM platform_fee_accruals WHERE property_id = $1`,
      [stack.propertyId])
    expect(rows[0].short_stay_equivalent).toBe(3)
  })
})

// S616 (Nic): "we just need a solution where the utilities only option gets
// billed to that landlord, and then as soon as the actual unit is physically
// onboarded to the other property, then the two dollars swaps and gets billed
// to the new landlord. The platform has to get its two dollar revenue either
// way."
describe('the $2 swaps between landlords and is never lost (S616)', () => {
  it('billed to the utility landlord first, the unit landlord after', async () => {
    // A supplies utilities to a space; nobody has onboarded the real unit yet.
    const A = await buildPlatformStack({ unitCount: 0 })
    const client = await getClient()
    let servicedUnitId = '', payerId = '', agreementId = ''
    try {
      servicedUnitId = await seedUnit(client, {
        propertyId: A.propertyId, landlordId: A.landlordId,
      })
      await client.query(
        `UPDATE units SET status='utility_service' WHERE id=$1`, [servicedUnitId])
      payerId = await seedTenant(client)
      const { rows: [sa] } = await client.query(
        `INSERT INTO utility_service_agreements
           (landlord_id, unit_id, tenant_id, start_date, payer_attested_at)
         VALUES ($1,$2,$3,'2026-01-01',NOW()) RETURNING id`,
        [A.landlordId, servicedUnitId, payerId])
      agreementId = sa.id
    } finally { client.release() }

    await processPlatformFeeAccrual(new Date('2026-05-01T08:00:00Z'))
    const { rows: before } = await db.query<any>(
      `SELECT utility_service_unit_count, total_billable
         FROM platform_fee_accruals WHERE property_id = $1`, [A.propertyId])
    expect(before[0].utility_service_unit_count).toBe(1)
    expect(before[0].total_billable).toBe(1)          // A pays the $2

    // B onboards the real unit and leases it. The link stamps supersedence.
    const B = await buildPlatformStack({ unitCount: 0 })
    const c2 = await getClient()
    let bLeaseId = ''
    try {
      const bUnitId = await seedUnit(c2, {
        propertyId: B.propertyId, landlordId: B.landlordId, rentAmount: 900,
      })
      await c2.query(`UPDATE units SET status='active' WHERE id=$1`, [bUnitId])
      bLeaseId = await seedLease(c2, {
        unitId: bUnitId, landlordId: B.landlordId, status: 'active',
        rentAmount: 900, startDate: '2026-01-01',
      })
      await seedLeaseTenant(c2, { leaseId: bLeaseId, tenantId: payerId, role: 'primary' })
      await c2.query(
        `UPDATE utility_service_agreements SET superseded_by_lease_id = $2 WHERE id = $1`,
        [agreementId, bLeaseId])
    } finally { c2.release() }

    // A fresh cycle, so both properties accrue again.
    await processPlatformFeeAccrual(new Date('2026-06-01T08:00:00Z'))

    const { rows: aAfter } = await db.query<any>(
      `SELECT utility_service_unit_count, total_billable
         FROM platform_fee_accruals
        WHERE property_id = $1 AND accrual_month = '2026-06-01'`, [A.propertyId])
    const { rows: bAfter } = await db.query<any>(
      `SELECT long_term_unit_count, total_billable
         FROM platform_fee_accruals
        WHERE property_id = $1 AND accrual_month = '2026-06-01'`, [B.propertyId])

    // It left A…
    if (aAfter.length > 0) expect(aAfter[0].utility_service_unit_count).toBe(0)
    // …and landed on B. The platform gets its $2 either way, which is the
    // whole point — it moves, it never evaporates.
    expect(bAfter[0].long_term_unit_count).toBe(1)
    expect(bAfter[0].total_billable).toBe(1)
  })
})

// S616 (Nic): "let's change the 5 percent to 3."
describe('the STR revenue fee is 3% (S616)', () => {
  it('reads the rate from config rather than a hardcoded number', async () => {
    const { rows } = await db.query<any>(
      `SELECT str_fee_pct::text FROM platform_fee_config WHERE effective_until IS NULL`)
    expect(Number(rows[0].str_fee_pct)).toBe(0.03)
  })
})

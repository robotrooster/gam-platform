/**
 * Allocation engine — critical-path tests.
 *
 * Covers the rent allocation entry point (`executeRentAllocation`) for
 * the most common configurations on launch day: owner-self-managed,
 * in-house manager fee, and the per-property fee-payer toggle. PM
 * company splits + supersedence boosts are exercised in separate
 * suites (TBD).
 *
 * Each test runs inside a tx that's rolled back at the end —
 * suite-level state is the empty schema loaded by globalSetup.
 */

import { randomUUID } from 'crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { db } from '../db'
import { executeRentAllocation } from './allocation'
import {
  withRollback,
  seedLandlord, seedManager, seedTenant,
  seedProperty, seedUnit,
  seedAllocationRule, seedRentPayment,
  seedUserBankAccount, seedPmCompany, seedPmFeePlan,
  attachPmToProperty,
} from '../test/dbHelpers'

beforeAll(async () => {
  // Processing rates are a global singleton, so seed once outside the
  // per-test transaction. Subsequent tests reuse the same rate rows.
  // Matches the GAM pricing model (ACH 1.0% customer-facing, 0.5%
  // stripe cost) — the spread is GAM's banking margin.
  //
  // INSERT ... WHERE NOT EXISTS guards against the partial unique
  // index `ux_platform_processing_rates_active_per_method`: only one
  // active row per payment_method (effective_until IS NULL). The
  // webhooks suite seeds the same rates in beforeEach, so if it ran
  // first this beforeAll would otherwise blow up on duplicate insert.
  const client = await db.connect()
  try {
    // Every expectation below is worked out on these two rates, so a rate
    // another suite left active (bookingLeaseBilling seeds a flat $6 ACH row
    // the same way) is retired first. Without this the file passed or failed
    // depending on which suite the run happened to start with.
    await client.query(
      `UPDATE platform_processing_rates SET effective_until = now()
        WHERE effective_until IS NULL AND effective_from < now()
          AND NOT (
            (payment_method = 'ach' AND customer_facing_flat = 0 AND customer_facing_percent = 1.0
              AND stripe_cost_flat = 0 AND stripe_cost_percent = 0.5)
            OR (payment_method = 'card' AND customer_facing_flat = 0.30 AND customer_facing_percent = 3.25
              AND stripe_cost_flat = 0.30 AND stripe_cost_percent = 2.9))
              OR (effective_until IS NULL AND effective_from < now()
                  AND (customer_facing_cap IS NOT NULL OR stripe_cost_cap IS NOT NULL))`
    )
    await client.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 0, 1.0, 0, 0.5
        WHERE NOT EXISTS (
          SELECT 1 FROM platform_processing_rates
           WHERE payment_method='ach' AND effective_until IS NULL
        )`
    )
    await client.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent)
       SELECT 'card', 0.30, 3.25, 0.30, 2.9
        WHERE NOT EXISTS (
          SELECT 1 FROM platform_processing_rates
           WHERE payment_method='card' AND effective_until IS NULL
        )`
    )
  } finally {
    client.release()
  }
})

/**
 * S655: a rent row the tenant paid by card or bank. Allocation pays out only
 * money GAM holds (v_payment_money.gam_held_part), and a Stripe settle is what
 * makes the row's own money GAM-held: the webhook stamps the charge id on it.
 * A row with no Stripe charge (cash at the desk) books no owner share at all.
 */
async function seedPaidRent(
  client: any,
  params: Parameters<typeof seedRentPayment>[1],
): Promise<string> {
  const id = await seedRentPayment(client, params)
  await client.query(`UPDATE payments SET stripe_charge_id = 'ch_' || id::text WHERE id = $1`, [id])
  return id
}

// Pool lifecycle: don't end the singleton in afterAll. Multiple test
// files share the same process under vitest singleFork — whichever
// file ran first would otherwise close the pool out from under the
// rest. The process exit handles teardown.

describe('executeRentAllocation — ACH', () => {
  it('owner self-managed, fee passed to tenant: full gross → owner_share, spread → platform', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      const userLedger = await client.query(
        `SELECT user_id, type, amount::text AS amount, balance_after::text AS balance_after
           FROM user_balance_ledger WHERE reference_id=$1 ORDER BY created_at, id`,
        [paymentId]
      )
      expect(userLedger.rows).toHaveLength(1)
      expect(userLedger.rows[0]).toMatchObject({
        user_id: ownerUserId,
        type: 'allocation_owner_share',
        amount: '1000.00',
        balance_after: '1000.00',
      })

      const platLedger = await client.query(
        `SELECT type, amount::text AS amount FROM platform_revenue_ledger
          WHERE reference_id=$1`,
        [paymentId]
      )
      expect(platLedger.rows).toHaveLength(1)
      // S603: Stripe bills on what it PROCESSED, not on the rent line. The
      // tenant pays the fee on top, so a $1,000 rent is a $1,010 charge and
      // Stripe's 0.5% is $5.05 — not $5.00. Spread is $10.00 - $5.05.
      // Pre-S603 this asserted $5.00, which was the bug.
      expect(platLedger.rows[0]).toMatchObject({
        type: 'banking_spread',
        amount: '4.95',
      })
    })
  })

  it('landlord absorbs ACH fee: owner_share = gross - customer_facing_fee', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'landlord' })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId]
      )
      expect(owner.rows[0].amount).toBe('990.00')

      const spread = await client.query(
        `SELECT amount::text AS amount FROM platform_revenue_ledger
          WHERE reference_id=$1 AND type='banking_spread'`,
        [paymentId]
      )
      expect(spread.rows[0].amount).toBe('5.00')
    })
  })

  it('separate in-house manager with rent_percent: splits manager_fee off splittable', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const managerUserId = await seedManager(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: managerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, {
        propertyId,
        achFeePayer: 'landlord',
        rentPercent: 10,
      })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      // gross=1000, customer-facing fee=10 (landlord absorbs), splittable=990
      // manager fee = 990 * 0.10 = 99
      // owner share = 990 - 99 = 891
      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId]
      )
      expect(owner.rows[0].amount).toBe('891.00')

      const mgr = await client.query(
        `SELECT user_id, amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_manager_fee'`,
        [paymentId]
      )
      expect(mgr.rows).toHaveLength(1)
      expect(mgr.rows[0].user_id).toBe(managerUserId)
      expect(mgr.rows[0].amount).toBe('99.00')
    })
  })

  it('manager rent_percent clamps to floor', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const managerUserId = await seedManager(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: managerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 500 })
      await seedAllocationRule(client, {
        propertyId,
        achFeePayer: 'tenant',
        rentPercent: 8,
        rentPercentFloor: 75,
      })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 500,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      // 500 * 0.08 = 40, clamps up to floor 75
      const mgr = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_manager_fee'`,
        [paymentId]
      )
      expect(mgr.rows[0].amount).toBe('75.00')
    })
  })

  it('manager rent_percent clamps to ceiling', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const managerUserId = await seedManager(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: managerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 5000 })
      await seedAllocationRule(client, {
        propertyId,
        achFeePayer: 'tenant',
        rentPercent: 20,
        rentPercentCeiling: 300,
      })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 5000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      // 5000 * 0.20 = 1000, clamps down to ceiling 300
      const mgr = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_manager_fee'`,
        [paymentId]
      )
      expect(mgr.rows[0].amount).toBe('300.00')
    })
  })

  it('supersedence subtracts from owner_share, not from manager_fee', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const managerUserId = await seedManager(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: managerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, {
        propertyId,
        achFeePayer: 'tenant',
        rentPercent: 10,
      })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
        gamSupersedenceAmount: 200,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      // splittable=1000 (tenant pays fee), manager=100, owner=1000-100-200=700
      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId]
      )
      expect(owner.rows[0].amount).toBe('700.00')

      const mgr = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_manager_fee'`,
        [paymentId]
      )
      expect(mgr.rows[0].amount).toBe('100.00')
    })
  })

  it('S581: sublease markup subtracts from owner_share — landlord nets master_share, not the sub amount', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,   // self-managed → no manager fee
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      // A sublessee paid the sub_monthly_amount of 1200; master_share_amount is
      // 1000, so 200 markup is stamped on the payment (as the pay route does).
      const paymentId = await seedPaidRent(client, { unitId, tenantId, landlordId, amount: 1200 })
      await client.query(`UPDATE payments SET sublease_markup_amount = 200 WHERE id = $1`, [paymentId])

      await executeRentAllocation(client, paymentId, 'ach')

      // splittable=1200 (tenant pays fee), no manager/pm, owner = 1200 - 200 = 1000.
      // The 200 goes to the sublessor via creditSublessorMarkupForPayment — so the
      // landlord no longer receives the markup on top of the sublessor's credit.
      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId])
      expect(owner.rows[0].amount).toBe('1000.00')
    })
  })

  it('is idempotent: second call on same paymentId is a no-op', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')
      await executeRentAllocation(client, paymentId, 'ach')

      const count = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM user_balance_ledger WHERE reference_id=$1`,
        [paymentId]
      )
      expect(count.rows[0].n).toBe('1')

      const platCount = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM platform_revenue_ledger WHERE reference_id=$1`,
        [paymentId]
      )
      expect(platCount.rows[0].n).toBe('1')
    })
  })

  // S609 (Nic, DIRECTIVE): "Late fees that come from the lease and are on the
  // invoice need to go to the landlord according to the lease... those also need
  // to go to the landlord. I don't know why that would go to GAM."
  //
  // Until S609 a late fee got NO allocation, so the tenant paid it and the money
  // stopped on GAM's books — invisible from both sides.
  async function feeFixture(client: any, opts: { type: string; desc: string; owner?: string }) {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: ownerUserId,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
    const res = await client.query(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, revenue_owner, stripe_charge_id)
       VALUES ($1, $2, $3, $4, 100, 'settled', $5, CURRENT_DATE, $6, 'ch_fee_' || gen_random_uuid())
       RETURNING id`,
      [unitId, tenantId, landlordId, opts.type, opts.desc, opts.owner ?? 'landlord'])
    return { paymentId: res.rows[0].id, ownerUserId }
  }

  it('THE FIX: a late fee off the lease pays the landlord', async () => {
    await withRollback(async (client) => {
      const { paymentId, ownerUserId } = await feeFixture(client, { type: 'late_fee', desc: 'LATEFEE' })
      await executeRentAllocation(client, paymentId, 'ach')
      const led = await client.query(
        `SELECT amount::float AS amount, user_id FROM user_balance_ledger
          WHERE reference_id = $1 AND type = 'allocation_owner_share'`, [paymentId])
      expect(led.rowCount).toBe(1)
      expect(led.rows[0].user_id).toBe(ownerUserId)
    })
  })

  it('a fee the landlord billed by hand pays the landlord', async () => {
    await withRollback(async (client) => {
      const { paymentId } = await feeFixture(client, { type: 'fee', desc: 'SUBSCRIP' })
      await executeRentAllocation(client, paymentId, 'ach')
      const led = await client.query(
        `SELECT 1 FROM user_balance_ledger
          WHERE reference_id = $1 AND type = 'allocation_owner_share'`, [paymentId])
      expect(led.rowCount).toBe(1)
    })
  })

  it("GAM's own fee is refused — it has no owner share", async () => {
    // Same type and description as the landlord's fee above. Only
    // revenue_owner separates them, which is exactly why it exists: both are
    // written as 'SUBSCRIP' and are otherwise identical rows.
    await withRollback(async (client) => {
      const { paymentId } = await feeFixture(client, { type: 'fee', desc: 'SUBSCRIP', owner: 'gam' })
      await expect(executeRentAllocation(client, paymentId, 'ach'))
        .rejects.toThrow(/GAM revenue/)
    })
  })

  it('a deposit is refused — it is held in trust, not split', async () => {
    await withRollback(async (client) => {
      const { paymentId } = await feeFixture(client, { type: 'deposit', desc: 'DEPOSIT' })
      await expect(executeRentAllocation(client, paymentId, 'ach'))
        .rejects.toThrow(/payment\.type IN/)
    })
  })

  it('rejects payment without an allocation rule (LEFT JOIN miss)', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      // NO allocation rule seeded
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })
      await expect(executeRentAllocation(client, paymentId, 'ach'))
        .rejects.toThrow(/no allocation rule/i)
    })
  })
})

describe('executeRentAllocation — card', () => {
  it('uses card_fee_payer (not ach_fee_payer) for splittable', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      // ACH is 'tenant', card is 'landlord'. Verify the engine reads the
      // right toggle based on payment method passed in.
      await seedAllocationRule(client, {
        propertyId,
        achFeePayer: 'tenant',
        cardFeePayer: 'landlord',
      })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'card')

      // gross=1000, customer-facing fee=0.30+3.25%=32.80, landlord absorbs
      // splittable = 1000 - 32.80 = 967.20
      // owner share = 967.20 (self-managed, no PM)
      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId]
      )
      expect(owner.rows[0].amount).toBe('967.20')

      // spread = 32.80 - (0.30 + 2.9% = 0.30 + 29.00 = 29.30) = 3.50
      const spread = await client.query(
        `SELECT amount::text AS amount FROM platform_revenue_ledger
          WHERE reference_id=$1 AND type='banking_spread'`,
        [paymentId]
      )
      expect(spread.rows[0].amount).toBe('3.50')
    })
  })
})

describe('executeRentAllocation — PM company cut', () => {
  it('percent_of_rent: pm_company_fee replaces manager_fee, owner_share = splittable - pm_cut', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const managerUserId = await seedManager(client) // separate, but PM takes over
      const tenantId = await seedTenant(client)
      // Bank account owner = a user who'll own the PM's payout target.
      // pm_payout_user_id is computed by allocation.ts from the bank's user.
      const { userId: pmOwnerUserId } = await seedLandlord(
        client, { email: `pm-owner-${randomUUID()}@test.dev` }
      )
      const pmBankId = await seedUserBankAccount(client, { userId: pmOwnerUserId })
      const pmCompanyId = await seedPmCompany(client, { bankAccountId: pmBankId })
      const pmFeePlanId = await seedPmFeePlan(client, {
        pmCompanyId, feeType: 'percent_of_rent', percent: 10,
      })
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: managerUserId,
      })
      await seedAllocationRule(client, {
        propertyId,
        achFeePayer: 'tenant',
        rentPercent: 10,  // would normally pay manager, but PM contracted overrides
      })
      await attachPmToProperty(client, { propertyId, pmCompanyId, pmFeePlanId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      // splittable=1000, pm_cut=1000*0.10=100, manager_fee SKIPPED, owner=900
      const pm = await client.query(
        `SELECT user_id, amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_pm_company_fee'`,
        [paymentId]
      )
      expect(pm.rows).toHaveLength(1)
      expect(pm.rows[0].user_id).toBe(pmOwnerUserId)
      expect(pm.rows[0].amount).toBe('100.00')

      const mgr = await client.query(
        `SELECT 1 FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_manager_fee'`,
        [paymentId]
      )
      expect(mgr.rows).toHaveLength(0)

      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId]
      )
      expect(owner.rows[0].amount).toBe('900.00')
    })
  })

  it('percent_with_floor: cut clamps up to floor when raw < floor', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const { userId: pmOwnerUserId } = await seedLandlord(
        client, { email: `pm-owner-${randomUUID()}@test.dev` }
      )
      const pmBankId = await seedUserBankAccount(client, { userId: pmOwnerUserId })
      const pmCompanyId = await seedPmCompany(client, { bankAccountId: pmBankId })
      const pmFeePlanId = await seedPmFeePlan(client, {
        pmCompanyId, feeType: 'percent_with_floor',
        percent: 5, floorAmount: 100,
      })
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      await attachPmToProperty(client, { propertyId, pmCompanyId, pmFeePlanId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      // splittable=1000, raw=50, clamps to floor 100. owner = 900.
      const pm = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_pm_company_fee'`,
        [paymentId]
      )
      expect(pm.rows[0].amount).toBe('100.00')

      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId]
      )
      expect(owner.rows[0].amount).toBe('900.00')
    })
  })

  it('percent_with_ceiling: cut clamps down to ceiling when raw > ceiling', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const { userId: pmOwnerUserId } = await seedLandlord(
        client, { email: `pm-owner-${randomUUID()}@test.dev` }
      )
      const pmBankId = await seedUserBankAccount(client, { userId: pmOwnerUserId })
      const pmCompanyId = await seedPmCompany(client, { bankAccountId: pmBankId })
      const pmFeePlanId = await seedPmFeePlan(client, {
        pmCompanyId, feeType: 'percent_with_ceiling',
        percent: 20, ceilingAmount: 150,
      })
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      await attachPmToProperty(client, { propertyId, pmCompanyId, pmFeePlanId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      // raw = 1000*0.20 = 200, ceiling 150. owner = 850.
      const pm = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_pm_company_fee'`,
        [paymentId]
      )
      expect(pm.rows[0].amount).toBe('150.00')

      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId]
      )
      expect(owner.rows[0].amount).toBe('850.00')
    })
  })

  it('flat_monthly fee_type: no per-payment cut (handled by monthly accrual job)', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const { userId: pmOwnerUserId } = await seedLandlord(
        client, { email: `pm-owner-${randomUUID()}@test.dev` }
      )
      const pmBankId = await seedUserBankAccount(client, { userId: pmOwnerUserId })
      const pmCompanyId = await seedPmCompany(client, { bankAccountId: pmBankId })
      const pmFeePlanId = await seedPmFeePlan(client, {
        pmCompanyId, feeType: 'flat_monthly', flatAmount: 200,
      })
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      await attachPmToProperty(client, { propertyId, pmCompanyId, pmFeePlanId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      const pm = await client.query(
        `SELECT 1 FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_pm_company_fee'`,
        [paymentId]
      )
      expect(pm.rows).toHaveLength(0)

      // Owner_share is still gross — manager_fee path skipped (PM contracted),
      // PM cut is zero this run. Full rent passes through to owner per-payment;
      // the flat_monthly fee deducts later via the monthly accrual job.
      const owner = await client.query(
        `SELECT amount::text AS amount FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_owner_share'`,
        [paymentId]
      )
      expect(owner.rows[0].amount).toBe('1000.00')
    })
  })

  it('leasing_fee fee_type: no per-payment cut (handled by lease-creation hook)', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const { userId: pmOwnerUserId } = await seedLandlord(
        client, { email: `pm-owner-${randomUUID()}@test.dev` }
      )
      const pmBankId = await seedUserBankAccount(client, { userId: pmOwnerUserId })
      const pmCompanyId = await seedPmCompany(client, { bankAccountId: pmBankId })
      const pmFeePlanId = await seedPmFeePlan(client, {
        pmCompanyId, feeType: 'leasing_fee',
      })
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      await attachPmToProperty(client, { propertyId, pmCompanyId, pmFeePlanId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await executeRentAllocation(client, paymentId, 'ach')

      const pm = await client.query(
        `SELECT 1 FROM user_balance_ledger
          WHERE reference_id=$1 AND type='allocation_pm_company_fee'`,
        [paymentId]
      )
      expect(pm.rows).toHaveLength(0)
    })
  })

  it('PM contracted with bank routing missing: 409', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      // PM company with NO bank_account_id — leave it null
      const res = await client.query<{ id: string }>(
        `INSERT INTO pm_companies (name) VALUES ('no-bank PM') RETURNING id`
      )
      const pmCompanyId = res.rows[0].id
      const pmFeePlanId = await seedPmFeePlan(client, {
        pmCompanyId, feeType: 'percent_of_rent', percent: 10,
      })
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      await attachPmToProperty(client, { propertyId, pmCompanyId, pmFeePlanId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      const paymentId = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await expect(executeRentAllocation(client, paymentId, 'ach'))
        .rejects.toThrow(/no bank routing/i)
    })
  })
})

// ══════════════════════════════════════════════════════════════
// S603 — ONE CHARGE, MANY ROWS. The bug that took real money.
//
// Allocation runs once per settled row (webhooks.ts loops `settled.rows`).
// Pre-S603 each pass recomputed the customer-facing fee from its own row, so a
// FLAT fee was booked once PER ROW instead of once per charge. With ACH's flat
// $6 and a charge covering rent + a utility bill that meant $12 booked against
// $6 actually charged — and with ach_fee_payer='landlord' the extra $6 came straight out of
// the landlord's share.
//
// These use the REAL production shape (flat $6 customer / 0.5% capped $3 cost),
// not the percentage-only rate the older tests seed — a pure percentage hides
// the bug, because 1% of each row already sums to 1% of the total.
// ══════════════════════════════════════════════════════════════
describe('executeRentAllocation — one charge covering multiple rows (S603)', () => {
  /**
   * A UTILITY row settled by the SAME PaymentIntent — the realistic multi-line
   * charge. Rent itself never stacks: it auto-charges on the due date, a failure
   * retries with a returned-payment fee, and a second failure ends ACH for that
   * tenant. What DOES ride along on one payment is rent + a utility bill (or a
   * late fee) swept up by the FIFO Pay-Now path. Utility runs through this same
   * allocation engine (S122), so it is allocated alongside the rent row.
   */
  async function seedUtilityOnSameCharge(
    client: any,
    a: { unitId: string; tenantId: string; landlordId: string; pi: string },
  ): Promise<string> {
    const r = await client.query(
      `INSERT INTO payments
         (unit_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, stripe_payment_intent_id, stripe_charge_id)
       VALUES ($1,$2,$3,'utility',500,'settled','UTILITY', CURRENT_DATE, $4, 'ch_' || $4)
       RETURNING id`,
      [a.unitId, a.tenantId, a.landlordId, a.pi])
    return r.rows[0].id
  }

  async function useFlatAchRate(client: any) {
    await client.query(
      `UPDATE platform_processing_rates SET effective_until = now()
        WHERE payment_method='ach' AND effective_until IS NULL`)
    await client.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
          stripe_cost_flat, stripe_cost_percent, stripe_cost_cap)
       VALUES ('ach', 6.00, 0, 6.00, 0, 0.5, 3.00)`)
  }

  it('books the flat fee ONCE across the charge, not once per row', async () => {
    await withRollback(async (client) => {
      await useFlatAchRate(client)
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 500 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })

      // ONE PaymentIntent covering $500 rent + a $500 utility bill — one
      // Pay-Now payment settling two obligations, which is how a charge really
      // ends up spanning multiple rows.
      const pi = 'pi_multi_row_s603'
      const p1 = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 500, stripePaymentIntentId: pi })
      const p2 = await seedUtilityOnSameCharge(client, { unitId, tenantId, landlordId, pi })

      await executeRentAllocation(client, p1, 'ach')
      await executeRentAllocation(client, p2, 'ach')

      const spread = await client.query(
        `SELECT COALESCE(SUM(amount),0)::text AS total FROM platform_revenue_ledger
          WHERE reference_id IN ($1,$2) AND type='banking_spread'`, [p1, p2])

      // Truth: tenant charged $1,000 + one $6 fee = $1,006 processed.
      // Stripe 0.5% of $1,006 = $5.03, capped at $3.00.
      // Spread = $6.00 fee - $3.00 cost = $3.00 TOTAL across both rows.
      // Pre-S603 this produced $7.00 ($6 fee booked twice, cost computed on
      // $500 per row) — a 133% overstatement of GAM revenue.
      expect(parseFloat(spread.rows[0].total)).toBeCloseTo(3.00, 2)
    })
  })

  it('landlord-paid fee is deducted ONCE across the charge, not once per row', async () => {
    await withRollback(async (client) => {
      await useFlatAchRate(client)
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 500 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'landlord' })

      const pi = 'pi_multi_row_landlord_s603'
      const p1 = await seedPaidRent(client, {
        unitId, tenantId, landlordId, amount: 500, stripePaymentIntentId: pi })
      const p2 = await seedUtilityOnSameCharge(client, { unitId, tenantId, landlordId, pi })

      await executeRentAllocation(client, p1, 'ach')
      await executeRentAllocation(client, p2, 'ach')

      const owner = await client.query(
        `SELECT COALESCE(SUM(amount),0)::text AS total FROM user_balance_ledger
          WHERE reference_id IN ($1,$2) AND type='allocation_owner_share'`, [p1, p2])

      // The landlord covers ONE $6 fee on a $1,000 charge → $994.00.
      // Pre-S603 they were charged $6 per row and received $988.00 — $6 of
      // their own money gone. THIS is the discrepancy that must never exist.
      expect(parseFloat(owner.rows[0].total)).toBeCloseTo(994.00, 2)
    })
  })
})

// ══════════════════════════════════════════════════════════════
// S655 (money plan Step 2) — THE OWNER SHARE IS MONEY GAM HOLDS.
//
// A row can be paid partly by money (a card, a bank pull) and partly by credit:
// credit the landlord issued, paid-ahead money the landlord already holds (a
// check they deposited), or money GAM holds (paid ahead through Stripe, deposit
// interest). Only what GAM holds may ever be paid out; the processing fee is on
// money only; and a cut too big for what GAM holds is capped, never thrown.
// ══════════════════════════════════════════════════════════════
describe('executeRentAllocation — credit on the row (S655)', () => {
  interface Fx { ownerUserId: string; landlordId: string; propertyId: string; unitId: string; tenantId: string; leaseId: string; managerUserId?: string }

  async function fx(client: any, o: { managerPercent?: number; managerFloor?: number; feePayer?: 'tenant' | 'landlord' } = {}): Promise<Fx> {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const managerUserId = o.managerPercent != null ? await seedManager(client) : undefined
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: managerUserId ?? ownerUserId })
    await seedAllocationRule(client, {
      propertyId, achFeePayer: o.feePayer ?? 'tenant', cardFeePayer: o.feePayer ?? 'tenant',
      rentPercent: o.managerPercent, rentPercentFloor: o.managerFloor,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 460 })
    const lease = await client.query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1, $2, 460, 'month_to_month', 'active', '2026-01-01') RETURNING id`, [unitId, landlordId])
    const leaseId = lease.rows[0].id
    await client.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    return { ownerUserId, landlordId, propertyId, unitId, tenantId, leaseId, managerUserId }
  }

  async function rentRow(client: any, f: Fx, amount = 460): Promise<string> {
    const r = await client.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, 'rent', $5, 'pending', '2026-10-01', 'RENT') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId, amount])
    return r.rows[0].id
  }

  async function paidAhead(client: any, f: Fx, amount: number, fundedBy: 'landlord' | 'gam') {
    const r = await client.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1, $2, $3, $3, $4, now()) RETURNING id`, [f.leaseId, f.tenantId, amount, fundedBy])
    return r.rows[0].id as string
  }

  async function issuedCredit(client: any, f: Fx, amount: number, category = 'goodwill') {
    const r = await client.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`, [f.landlordId, f.tenantId, f.leaseId, amount, category])
    return r.rows[0].id as string
  }

  async function use(client: any, f: Fx, paymentId: string, credit: { prepaid?: string; issued?: string }, amount: number) {
    await client.query(
      `INSERT INTO credit_uses (tenant_credit_id, prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, $4, $5, '2026-10-01', 'portal', 'applied', now())`,
      [credit.issued ?? null, credit.prepaid ?? null, paymentId, f.leaseId, amount])
  }

  /** The card or bank payment for the rest settles the row (the webhook's stamp). */
  async function settleByStripe(client: any, paymentId: string, money: number, method: 'ach' | 'card' = 'ach') {
    const pi = `pi_${paymentId.slice(0, 8)}`
    await client.query(
      `UPDATE payments SET status = 'settled', settled_at = now(), stripe_payment_intent_id = $2, stripe_charge_id = 'ch_' || $2 WHERE id = $1`,
      [paymentId, pi])
    await client.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
       SELECT tenant_id, landlord_id, $2, $2, 0, 'settled', $3, $4 FROM payments WHERE id = $1`,
      [paymentId, money, method, pi])
  }

  async function settleByCreditOnly(client: any, paymentId: string) {
    await client.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1`, [paymentId])
  }

  const ledger = async (client: any, paymentId: string, type: string) => {
    const r = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS a, COUNT(*)::int AS n FROM user_balance_ledger WHERE reference_id = $1 AND type = $2`,
      [paymentId, type])
    return r.rows[0] as { a: number; n: number }
  }
  const spread = async (client: any, paymentId: string) => {
    const r = await client.query(`SELECT amount::float AS a, customer_fee_charged::float AS fee FROM platform_revenue_ledger WHERE reference_id = $1`, [paymentId])
    return r.rows[0] ?? null
  }

  it('shelved 5: a row paid partly from GAM-held and partly from check-funded paid-ahead pays the landlord only the GAM-held part', async () => {
    await withRollback(async (client) => {
      const f = await fx(client)
      const pay = await rentRow(client, f)
      const gam = await paidAhead(client, f, 300, 'gam')
      const check = await paidAhead(client, f, 160, 'landlord')
      await use(client, f, pay, { prepaid: gam }, 300)
      await use(client, f, pay, { prepaid: check }, 160)
      await settleByCreditOnly(client, pay)
      await executeRentAllocation(client, pay, 'ach', { feeAlreadyCollected: true })
      expect((await ledger(client, pay, 'allocation_owner_share')).a).toBe(300)
      expect(await spread(client, pay)).toBeNull()
    })
  })

  it('owner share is Stripe money plus GAM-funded credit, never landlord-held or issued credit', async () => {
    await withRollback(async (client) => {
      const f = await fx(client)
      const pay = await rentRow(client, f)
      await use(client, f, pay, { issued: await issuedCredit(client, f, 50) }, 50)          // a move-in special
      await use(client, f, pay, { prepaid: await paidAhead(client, f, 10, 'landlord') }, 10) // a check the landlord has
      await use(client, f, pay, { prepaid: await paidAhead(client, f, 100, 'gam') }, 100)    // paid ahead by card
      await settleByStripe(client, pay, 300)                                                  // the card paid the rest
      await executeRentAllocation(client, pay, 'ach')
      // 300 money + 100 GAM-held credit. Never the 50 issued or the 10 the landlord holds.
      const owner = await ledger(client, pay, 'allocation_owner_share')
      expect(owner.a).toBe(400)
      const vm = (await client.query(`SELECT money_part::float AS m, gam_held_part::float AS g, issued_credit_amount::float AS i FROM v_payment_money WHERE payment_id = $1`, [pay])).rows[0]
      expect(vm).toEqual({ m: 300, g: 400, i: 50 })
    })
  })

  it("rent paid with deposit-interest credit pays the landlord's share with no fee and counts as received", async () => {
    await withRollback(async (client) => {
      const f = await fx(client)
      const pay = await rentRow(client, f, 40)
      const interest = await issuedCredit(client, f, 40, 'deposit_interest')
      await use(client, f, pay, { issued: interest }, 40)
      await settleByCreditOnly(client, pay)
      await executeRentAllocation(client, pay, 'ach', { feeAlreadyCollected: true })
      expect((await ledger(client, pay, 'allocation_owner_share')).a).toBe(40)
      expect(await spread(client, pay)).toBeNull()
      // GAM funds interest: it is not "issued" (never income) — it is new money
      // to the landlord on the day it pays the bill.
      const vm = (await client.query(
        `SELECT issued_credit_amount::float AS issued, deposit_interest_credit::float AS interest, gam_held_part::float AS held
           FROM v_payment_money WHERE payment_id = $1`, [pay])).rows[0]
      expect(vm).toEqual({ issued: 0, interest: 40, held: 40 })
    })
  })

  it('the processing fee is computed on the money part only', async () => {
    await withRollback(async (client) => {
      const f = await fx(client, { feePayer: 'landlord' })
      const pay = await rentRow(client, f, 1000)
      await use(client, f, pay, { issued: await issuedCredit(client, f, 200) }, 200)
      await settleByStripe(client, pay, 800)
      await executeRentAllocation(client, pay, 'ach')
      // ACH test rate is 1.0% customer / 0.5% cost, on the $800 of money.
      const s = await spread(client, pay)
      expect(s.fee).toBe(8)
      expect(s.a).toBe(4)
      // Landlord pays the fee: 800 − 8 out of what GAM holds.
      expect((await ledger(client, pay, 'allocation_owner_share')).a).toBe(792)
    })
  })

  it('a manager-fee floor above the GAM-held part clamps and alerts instead of throwing', async () => {
    await withRollback(async (client) => {
      const f = await fx(client, { managerPercent: 10, managerFloor: 75 })
      const pay = await rentRow(client, f)
      // $450 of the $460 the landlord collected at the desk earlier; $10 of GAM-held
      // credit is all GAM holds for this row.
      await use(client, f, pay, { prepaid: await paidAhead(client, f, 450, 'landlord') }, 450)
      await use(client, f, pay, { prepaid: await paidAhead(client, f, 10, 'gam') }, 10)
      await settleByCreditOnly(client, pay)
      await expect(executeRentAllocation(client, pay, 'ach', { feeAlreadyCollected: true })).resolves.toBeUndefined()
      // Manager earned $75 (floor) on $460 of income, but only $10 is GAM's to pay.
      expect((await ledger(client, pay, 'allocation_manager_fee')).a).toBe(10)
      const owner = await ledger(client, pay, 'allocation_owner_share')
      expect(owner).toEqual({ a: 0, n: 1 })
      const alert = await client.query(`SELECT body FROM admin_notifications WHERE category = 'allocation_fees_exceed_held'`)
      expect(alert.rowCount).toBe(1)
      expect(alert.rows[0].body).toMatch(/\$65\.00 was not covered/)
      // Re-running is a no-op (the $0 owner share marks it allocated).
      await executeRentAllocation(client, pay, 'ach', { feeAlreadyCollected: true })
      expect((await ledger(client, pay, 'allocation_manager_fee')).n).toBe(1)
    })
  })

  it('credit-only settle books GAM-held paid-ahead with no second fee and marks the row platform_held', async () => {
    const { db } = await import('../db')
    const { settleFromCredit } = await import('./creditUse')
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const f = await fx(c)
      const pay = await rentRow(c, f)
      await paidAhead(c, f, 460, 'gam')
      const r = await settleFromCredit(c, { leaseId: f.leaseId, tenantId: f.tenantId, source: 'portal', receipt: false })
      expect(r.settledIds).toEqual([pay])
      expect((await ledger(c, pay, 'allocation_owner_share')).a).toBe(460)
      expect(await spread(c, pay)).toBeNull()
      const row = (await c.query(`SELECT platform_held, status FROM payments WHERE id = $1`, [pay])).rows[0]
      expect(row).toEqual({ platform_held: true, status: 'settled' })
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
  })

  it('a row with nothing GAM holds (cash, a check, credit the landlord gave) books nothing', async () => {
    await withRollback(async (client) => {
      const f = await fx(client)
      const pay = await rentRow(client, f)
      await use(client, f, pay, { issued: await issuedCredit(client, f, 460) }, 460)
      await settleByCreditOnly(client, pay)
      await executeRentAllocation(client, pay, 'ach')
      expect((await ledger(client, pay, 'allocation_owner_share')).n).toBe(0)
      expect(await spread(client, pay)).toBeNull()
    })
  })

  // S655 review: "Use all $X" — GAM-held paid-ahead money covers rent and water
  // in full, and the card or bank pays only GAM's $4 returned-payment fee. No
  // landlord row on the charge carries money, so there is nothing to share the
  // fee by; it used to be booked on EVERY row (a landlord-paid $6 taken twice:
  // owner $488, not $494, and GAM's book counting one fee twice).
  async function creditPaidChargeWithGamFee(client: any, f: Fx, method: 'ach' | 'card') {
    const rent = await rentRow(client, f, 460)
    const water = (await client.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, 'utility', 40, 'pending', '2026-10-01', 'UTILITY') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])).rows[0].id as string
    const gamFee = (await client.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
       VALUES ($1, $2, $3, $4, 'fee', 4, 'pending', '2026-10-01', 'RETURNFEE', 'gam') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])).rows[0].id as string
    const credit = await paidAhead(client, f, 500, 'gam')
    await use(client, f, rent, { prepaid: credit }, 460)
    await use(client, f, water, { prepaid: credit }, 40)
    const pi = `pi_all_credit_${method}`
    await client.query(
      `UPDATE payments SET status = 'settled', settled_at = now(), stripe_payment_intent_id = $2, stripe_charge_id = 'ch_' || $2
        WHERE id = ANY($1::uuid[])`, [[rent, water, gamFee], pi])
    await client.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
       VALUES ($1, $2, $3, 4, 4, 0, 'settled', $4, $5)`, [f.tenantId, f.landlordId, f.leaseId, method, pi])
    await executeRentAllocation(client, rent, method)
    await executeRentAllocation(client, water, method)
    const owner = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS a FROM user_balance_ledger
        WHERE reference_id = ANY($1::uuid[]) AND type = 'allocation_owner_share'`, [[rent, water]])
    const fees = await client.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(customer_fee_charged), 0)::float AS fee FROM platform_revenue_ledger
        WHERE reference_id = ANY($1::uuid[]) AND type = 'banking_spread'`, [[rent, water]])
    return { owner: owner.rows[0].a as number, spreadRows: fees.rows[0].n as number, feeBooked: fees.rows[0].fee as number }
  }

  it('a charge whose landlord rows were all paid by credit books its fee once (bank, landlord pays the fee)', async () => {
    await withRollback(async (client) => {
      // The flat $6 ACH schedule, so a doubled fee is plain to see.
      await client.query(`UPDATE platform_processing_rates SET effective_until = now() WHERE payment_method = 'ach' AND effective_until IS NULL`)
      await client.query(
        `INSERT INTO platform_processing_rates
           (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
            stripe_cost_flat, stripe_cost_percent, stripe_cost_cap)
         VALUES ('ach', 6.00, 0, 6.00, 0, 0.5, 3.00)`)
      const f = await fx(client, { feePayer: 'landlord' })
      const r = await creditPaidChargeWithGamFee(client, f, 'ach')
      expect(r.owner).toBe(494)          // $500 GAM holds, less ONE $6 fee
      expect(r.feeBooked).toBe(6)
      expect(r.spreadRows).toBe(1)
    })
  })

  it('a charge whose landlord rows were all paid by credit books its fee once (card)', async () => {
    await withRollback(async (client) => {
      await client.query(`UPDATE platform_processing_rates SET effective_until = now() WHERE payment_method = 'card' AND effective_until IS NULL`)
      await client.query(
        `INSERT INTO platform_processing_rates
           (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
         VALUES ('card', 0.30, 3.25, 0.30, 2.9)`)
      const f = await fx(client, { feePayer: 'landlord' })
      const r = await creditPaidChargeWithGamFee(client, f, 'card')
      // Card test rate 3.25% + $0.30 on the $4 that moved: $0.43, once.
      expect(r.feeBooked).toBe(0.43)
      expect(r.owner).toBe(499.57)
    })
  })

  // S655 review (round 2): the once-per-charge fee went to the LAST landlord row
  // by id — even a row with nothing GAM holds on it, which books nothing. Rent
  // paid whole by GAM-held paid-ahead money, water paid whole by paid-ahead
  // money the landlord holds, and the bank paid only GAM's returned-payment
  // fee: with water last, the landlord-paid $6 was booked zero times (GAM
  // absorbing it).
  it('a charge whose credit-paid rows are split GAM-held / landlord-held books its fee once on the GAM-held row', async () => {
    await withRollback(async (client) => {
      await client.query(`UPDATE platform_processing_rates SET effective_until = now() WHERE payment_method = 'ach' AND effective_until IS NULL`)
      await client.query(
        `INSERT INTO platform_processing_rates
           (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
            stripe_cost_flat, stripe_cost_percent, stripe_cost_cap)
         VALUES ('ach', 6.00, 0, 6.00, 0, 0.5, 3.00)`)
      const f = await fx(client, { feePayer: 'landlord' })
      // Ids chosen so the landlord-held row (water) sorts LAST.
      const rent = `10000000-0000-4000-8000-${randomUUID().slice(-12)}`
      const water = `f0000000-0000-4000-8000-${randomUUID().slice(-12)}`
      await client.query(
        `INSERT INTO payments (id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1, $3, $4, $5, $6, 'rent', 460, 'pending', '2026-10-01', 'RENT'),
                ($2, $3, $4, $5, $6, 'utility', 40, 'pending', '2026-10-01', 'UTILITY')`,
        [rent, water, f.unitId, f.leaseId, f.tenantId, f.landlordId])
      const gamFee = (await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
         VALUES ($1, $2, $3, $4, 'fee', 4, 'pending', '2026-10-01', 'RETURNFEE', 'gam') RETURNING id`,
        [f.unitId, f.leaseId, f.tenantId, f.landlordId])).rows[0].id as string
      await use(client, f, rent, { prepaid: await paidAhead(client, f, 460, 'gam') }, 460)
      await use(client, f, water, { prepaid: await paidAhead(client, f, 40, 'landlord') }, 40)
      const pi = 'pi_split_credit'
      await client.query(
        `UPDATE payments SET status = 'settled', settled_at = now(), stripe_payment_intent_id = $2, stripe_charge_id = 'ch_' || $2
          WHERE id = ANY($1::uuid[])`, [[rent, water, gamFee], pi])
      await client.query(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 4, 4, 0, 'settled', 'ach', $4)`, [f.tenantId, f.landlordId, f.leaseId, pi])
      await executeRentAllocation(client, rent, 'ach')
      await executeRentAllocation(client, water, 'ach')
      // GAM holds $460 on rent: the landlord's share less ONE $6 fee. Water books nothing.
      expect((await ledger(client, rent, 'allocation_owner_share')).a).toBe(454)
      expect((await ledger(client, water, 'allocation_owner_share')).n).toBe(0)
      const fees = await client.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(customer_fee_charged), 0)::float AS fee FROM platform_revenue_ledger
          WHERE reference_id = ANY($1::uuid[]) AND type = 'banking_spread'`, [[rent, water]])
      expect(fees.rows[0]).toEqual({ n: 1, fee: 6 })
    })
  })

  // The same rule when money did move: a row settled at the desk that still
  // carries the charge's old (bounced) intent books nothing, so it takes no
  // share of the fee and cannot swallow the rounding cent.
  it("a desk-settled row still carrying the charge's old intent takes no share of its fee", async () => {
    await withRollback(async (client) => {
      const f = await fx(client, { feePayer: 'landlord' })
      const rent = `10000000-0000-4000-8000-${randomUUID().slice(-12)}`
      const water = `f0000000-0000-4000-8000-${randomUUID().slice(-12)}`
      const pi = 'pi_with_desk_row'
      await client.query(
        `INSERT INTO payments (id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                               stripe_payment_intent_id, settled_at, stripe_charge_id, manual_method)
         VALUES ($1, $3, $4, $5, $6, 'rent', 1000, 'settled', '2026-10-01', 'RENT', $7, now(), 'ch_' || $7, NULL),
                ($2, $3, $4, $5, $6, 'utility', 333.33, 'settled', '2026-10-01', 'UTILITY', $7, now(), NULL, 'cash')`,
        [rent, water, f.unitId, f.leaseId, f.tenantId, f.landlordId, pi])
      await client.query(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 1000, 1000, 0, 'settled', 'ach', $4)`, [f.tenantId, f.landlordId, f.leaseId, pi])
      await executeRentAllocation(client, rent, 'ach')
      await executeRentAllocation(client, water, 'ach')
      // ACH test rate 1.0% on the $1,000 the bank moved: $10, all on rent.
      const s = await spread(client, rent)
      expect(s.fee).toBe(10)
      expect((await ledger(client, rent, 'allocation_owner_share')).a).toBe(990)
      expect((await ledger(client, water, 'allocation_owner_share')).n).toBe(0)
      expect(await spread(client, water)).toBeNull()
    })
  })

  // Wave A review: the same desk row, but GAM-held paid-ahead money paid part
  // of it (gam_held_part > 0, so it books an owner share). It used to join the
  // split by its $300 of CASH — money Stripe never processed — and take $2.31
  // of the $10 fee: booked on the cash when the desk forgot to say "no fee",
  // and booked nowhere (GAM absorbing it) when it did. Either way the fee
  // belongs on the row the bank paid, once.
  it.each([
    ['the desk says no fee of its own', { feeAlreadyCollected: true }],
    ['the desk forgets to say so', {}],
  ])("a desk-settled row with GAM-held credit and the charge's old intent takes no share of its fee (%s)", async (_label, deskOpts) => {
    await withRollback(async (client) => {
      const f = await fx(client, { feePayer: 'landlord' })
      const rent = `10000000-0000-4000-8000-${randomUUID().slice(-12)}`
      const water = `f0000000-0000-4000-8000-${randomUUID().slice(-12)}`
      const pi = 'pi_with_desk_credit_row'
      await client.query(
        `INSERT INTO payments (id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                               stripe_payment_intent_id, settled_at, stripe_charge_id)
         VALUES ($1, $3, $4, $5, $6, 'rent', 1000, 'settled', '2026-10-01', 'RENT', $7, now(), 'ch_' || $7),
                ($2, $3, $4, $5, $6, 'utility', 333.33, 'failed', '2026-10-01', 'UTILITY', $7, NULL, NULL)`,
        [rent, water, f.unitId, f.leaseId, f.tenantId, f.landlordId, pi])
      // At the desk: $33.33 from money paid ahead through GAM, $300 in cash.
      await use(client, f, water, { prepaid: await paidAhead(client, f, 33.33, 'gam') }, 33.33)
      await client.query(
        `UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'cash', platform_held = TRUE WHERE id = $1`, [water])
      await client.query(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 1000, 1000, 0, 'settled', 'ach', $4)`, [f.tenantId, f.landlordId, f.leaseId, pi])
      const vm = (await client.query(
        `SELECT money_part::float AS m, gam_held_part::float AS g FROM v_payment_money WHERE payment_id = $1`, [water])).rows[0]
      expect(vm).toEqual({ m: 300, g: 33.33 })
      await executeRentAllocation(client, rent, 'ach')
      await executeRentAllocation(client, water, 'ach', deskOpts)
      // ACH test rate 1.0% on the $1,000 the bank moved: $10, booked once, all on rent.
      const fees = await client.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(customer_fee_charged), 0)::float AS fee FROM platform_revenue_ledger
          WHERE reference_id = ANY($1::uuid[]) AND type = 'banking_spread'`, [[rent, water]])
      expect(fees.rows[0]).toEqual({ n: 1, fee: 10 })
      expect((await spread(client, rent)).fee).toBe(10)
      expect((await ledger(client, rent, 'allocation_owner_share')).a).toBe(990)
      // The water's GAM-held credit is paid out whole, with no fee; its cash never.
      expect((await ledger(client, water, 'allocation_owner_share')).a).toBe(33.33)
      expect(await spread(client, water)).toBeNull()
    })
  })

  // Wave A cleanup: a row on the charge that is outside the split set (here a
  // reopened row whose re-payment GAM keeps; the webhook skips its allocation)
  // used to take a share of the fee by its money while the set's rows already
  // carried all of it — part of the fee booked twice if anything ever
  // allocated it. It takes nothing.
  it('a row on the intent that is not in the split set books no fee', async () => {
    await withRollback(async (client) => {
      const f = await fx(client, { feePayer: 'landlord' })
      const rent = `10000000-0000-4000-8000-${randomUUID().slice(-12)}`
      const reopened = `f0000000-0000-4000-8000-${randomUUID().slice(-12)}`
      const pi = 'pi_with_reopened_row'
      // October's rent was disputed: the original is returned, the landlord has
      // not been clawed back yet, and a reopened row asks the $500 again.
      const orig = (await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                               stripe_payment_intent_id, settled_at)
         VALUES ($1, $2, $3, $4, 'rent', 500, 'returned', '2026-09-01', 'RENT', 'pi_disputed', now()) RETURNING id`,
        [f.unitId, f.leaseId, f.tenantId, f.landlordId])).rows[0].id as string
      const rev = (await client.query(
        `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                        stripe_event_id, raw_event, recovery_status)
         VALUES ($1, $2, $3, $4, 'card_dispute', 500, $5, '{}'::jsonb, 'pending') RETURNING id`,
        [orig, f.landlordId, f.tenantId, f.leaseId, `evt_${randomUUID()}`])).rows[0].id as string
      // One bank payment settles this month's rent and the reopened row.
      await client.query(
        `INSERT INTO payments (id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                               stripe_payment_intent_id, settled_at, stripe_charge_id, reversal_id)
         VALUES ($1, $3, $4, $5, $6, 'rent', 1000, 'settled', '2026-10-01', 'RENT', $7, now(), 'ch_' || $7, NULL),
                ($2, $3, $4, $5, $6, 'rent', 500, 'settled', '2026-09-01', 'RENT', $7, now(), 'ch_' || $7, $8)`,
        [rent, reopened, f.unitId, f.leaseId, f.tenantId, f.landlordId, pi, rev])
      await client.query(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 1500, 1500, 0, 'settled', 'ach', $4)`, [f.tenantId, f.landlordId, f.leaseId, pi])
      await executeRentAllocation(client, rent, 'ach')
      // Nothing allocates the reopened row today; if anything ever does, it
      // books no share of the fee the rent row already carries in full.
      await executeRentAllocation(client, reopened, 'ach')
      // ACH test rate 1.0% on the $1,500 the bank moved: $15, booked once, all on rent.
      const fees = await client.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(customer_fee_charged), 0)::float AS fee FROM platform_revenue_ledger
          WHERE reference_id = ANY($1::uuid[]) AND type = 'banking_spread'`, [[rent, reopened]])
      expect(fees.rows[0]).toEqual({ n: 1, fee: 15 })
      expect((await spread(client, rent)).fee).toBe(15)
      expect(await spread(client, reopened)).toBeNull()
      expect((await ledger(client, reopened, 'allocation_owner_share')).a).toBe(500)
    })
  })

  it('a row no money paid carries no processing fee, even when the caller forgets to say so', async () => {
    await withRollback(async (client) => {
      await client.query(`UPDATE platform_processing_rates SET effective_until = now() WHERE payment_method = 'ach' AND effective_until IS NULL`)
      await client.query(
        `INSERT INTO platform_processing_rates
           (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
            stripe_cost_flat, stripe_cost_percent, stripe_cost_cap)
         VALUES ('ach', 6.00, 0, 6.00, 0, 0.5, 3.00)`)
      const f = await fx(client, { feePayer: 'landlord' })
      const pay = await rentRow(client, f)
      await use(client, f, pay, { prepaid: await paidAhead(client, f, 460, 'gam') }, 460)
      await settleByCreditOnly(client, pay)
      await executeRentAllocation(client, pay, 'ach')        // no feeAlreadyCollected
      expect((await ledger(client, pay, 'allocation_owner_share')).a).toBe(460)
      expect(await spread(client, pay)).toBeNull()
    })
  })
})

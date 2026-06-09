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
      const paymentId = await seedRentPayment(client, {
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
      expect(platLedger.rows[0]).toMatchObject({
        type: 'banking_spread',
        amount: '5.00',
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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

  it('is idempotent: second call on same paymentId is a no-op', async () => {
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      const paymentId = await seedRentPayment(client, {
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

  it('rejects payment.type outside (rent, utility)', async () => {
    // The engine accepts rent + utility (same allocation math per S122).
    // Anything else — fee, deposit, late_fee, etc. — is a routing bug
    // and gets a 400.
    await withRollback(async (client) => {
      const { userId: ownerUserId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId, managedByUserId: ownerUserId,
      })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
      await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant' })
      const res = await client.query<{ id: string }>(
        `INSERT INTO payments
           (unit_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date)
         VALUES ($1, $2, $3, 'fee', 100, 'settled', 'LATEFEE', CURRENT_DATE)
         RETURNING id`,
        [unitId, tenantId, landlordId]
      )
      await expect(executeRentAllocation(client, res.rows[0].id, 'ach'))
        .rejects.toThrow(/payment\.type IN \('rent','utility'\)/)
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
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
      const paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000,
      })

      await expect(executeRentAllocation(client, paymentId, 'ach'))
        .rejects.toThrow(/no bank routing/i)
    })
  })
})

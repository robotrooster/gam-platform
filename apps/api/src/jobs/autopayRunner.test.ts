/**
 * S609 — the autopay runner.
 *
 * The three things that must never go wrong, in order of how much damage they
 * would do:
 *
 *   1. NEVER CHARGE TWICE. A tenant charged their rent twice in one month is
 *      the worst thing this system can do to someone.
 *   2. CHARGE THE LIVE BALANCE, not a forecast (Nic) — whatever is owed at the
 *      moment it runs, including a late fee that ticked overnight.
 *   3. ON FAILURE the schedule stays on, and disarms after two in a row (Nic).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedAllocationRule,
} from '../test/dbHelpers'

const chargeMock = vi.fn(async (_input?: any) => ({
  remittanceId: 'rem_x', paymentIntentId: 'pi_x', status: 'processing',
  appliedTotal: 0, payAhead: 0, platformCutAmount: 0, lines: [],
}))
vi.mock('../services/rentCharge', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, chargeLeaseBalance: (...a: any[]) => chargeMock(...(a as [])) }
})
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    paymentMethods: {
      retrieve: vi.fn(async (id: string) => ({ id, customer: 'cus_s609', type: 'us_bank_account' })),
      list: vi.fn(async () => ({ data: [] })),
    },
    customers: { retrieve: vi.fn(async () => ({ invoice_settings: { default_payment_method: 'pm_default' } })) },
  }),
}))
vi.mock('../services/notifications', () => ({ createNotification: vi.fn(async () => undefined) }))

import { runAutopayForTimezone, isPullDayToday, AUTOPAY_DISARM_AFTER_FAILURES } from './autopayRunner'

const TZ = 'America/Phoenix'

interface Fixture {
  landlordId: string; userId: string; propertyId: string
  unitId: string; tenantId: string; leaseId: string
}

async function fixture(): Promise<Fixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await client.query(`UPDATE properties SET timezone = $2 WHERE id = $1`, [propertyId, TZ])
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, withLateFeeDecision: true })
    const tenantId = await seedTenant(client)
    await client.query(`UPDATE tenants SET stripe_customer_id='cus_s609' WHERE id=$1`, [tenantId])
    const leaseId = await seedLease(client, { unitId, landlordId: ll.landlordId, rentAmount: 1000 })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    return { ...ll, propertyId, unitId, tenantId, leaseId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** Today's day-of-month in the property's timezone — what the runner fires on. */
/**
 * S629: the run happens on a FIXED day of the current month, not on whatever
 * day the suite is run.
 *
 * These tests arm a tenant for "today" and then run the job. On the 29th, 30th
 * or 31st that is impossible — tenant_autopay_pull_day_check caps pull_day at
 * 28, because a pull day of 29 does not exist in every month — so the suite
 * went red on three days of every month, at month end, on the runner that
 * moves rent. Nothing was wrong with the runner; the test simply could not say
 * when it was pretending to run.
 *
 * The 15th of the CURRENT month: a legal pull day, and the same billing cycle
 * as the charges the fixtures create, since the cycle is the month.
 */
const RUN_DAY = 15
function runAt(): Date {
  const d = new Date()
  d.setDate(RUN_DAY)
  d.setHours(12, 0, 0, 0)
  return d
}
function todayDay(): number {
  return RUN_DAY
}

/** Arm autopay for TODAY so the runner picks it up on this run. */
async function armForToday(f: Fixture, methodId: string | null = 'pm_bank') {
  await db.query(
    `INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, pull_day, payment_method_id)
     VALUES ($1,$2,TRUE,$3,$4)`,
    [f.tenantId, f.leaseId, todayDay(), methodId])
}

async function seedCarried(f: Fixture, amount: number) {
  await db.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,'carried_balance',$5,'pending', CURRENT_DATE - 200, 'BALANCE')`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, amount.toFixed(2)])
}

async function seedCharge(f: Fixture, amount: number, type: 'rent' | 'late_fee' = 'rent') {
  await db.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,$6,$5,'pending', CURRENT_DATE, $7)`,
    [f.unitId, f.leaseId, f.tenantId, f.landlordId, amount.toFixed(2), type,
     type === 'late_fee' ? 'LATEFEE' : 'RENT'])
}

const autopayRow = async (leaseId: string) => (await db.query<any>(
  `SELECT enabled, consecutive_failures, last_run_cycle::text AS last_run_cycle,
          last_success_cycle::text AS last_success_cycle, disarmed_reason
     FROM tenant_autopay WHERE lease_id = $1`, [leaseId])).rows[0]

describe('S609 autopay runner', () => {
  let f: Fixture

  beforeAll(async () => {
    await db.query(
      `INSERT INTO platform_processing_rates
         (payment_method, customer_facing_flat, customer_facing_percent,
          stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 6, 0, 0, 0.5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'ach')`)
  })

  beforeEach(async () => {
    await cleanupAllSchema()
    chargeMock.mockClear()
    chargeMock.mockImplementation(async (_input?: any) => ({
      remittanceId: 'rem_x', paymentIntentId: 'pi_x', status: 'processing',
      appliedTotal: 0, payAhead: 0, platformCutAmount: 0, lines: [],
    }))
    f = await fixture()
  })

  it('charges the live balance on the tenant’s chosen day', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    await seedCharge(f, 35, 'late_fee')           // a late fee that landed overnight

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.charged).toBe(1)
    // 1035, not the 1000 anyone could have forecast yesterday.
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 1035, source: 'autopay' })
  })

  // S622 (Nic): "if somebody has ACH set up, do they have to manually pick the
  // amount every month, or is it gonna automatically charge them the full
  // balance or just the current rent charge?"
  //
  // Just the lease's own charges. A carried-forward balance is the one charge
  // payable in part, usually large and on a catch-up footing — sweeping it into
  // an automatic pull would debit $1,800 from a tenant who set autopay up for
  // $800 of rent. That does not merely misapply money, it takes money that was
  // never authorised.
  it('S622: autopay never sweeps the carried-forward balance', async () => {
    await armForToday(f)
    await seedCharge(f, 800)
    await seedCarried(f, 1000)          // eight months older than the rent

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.charged).toBe(1)
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 800, source: 'autopay' })
  })

  it('S622: a tenant whose ONLY open charge is arrears is skipped, not drained', async () => {
    await armForToday(f)
    await seedCarried(f, 1000)

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.charged).toBe(0)
    expect(r.skipped).toBe(1)
    expect(chargeMock).not.toHaveBeenCalled()
  })

  it('NEVER CHARGES TWICE — a second run in the same month does nothing', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)

    await runAutopayForTimezone(TZ, runAt())
    await runAutopayForTimezone(TZ, runAt())
    await runAutopayForTimezone(TZ, runAt())

    expect(chargeMock).toHaveBeenCalledTimes(1)
  })

  it('a tenant already paid ahead is skipped, not failed', async () => {
    await armForToday(f)                          // nothing owed
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.charged).toBe(0)
    expect(r.failed).toBe(0)
    expect(chargeMock).not.toHaveBeenCalled()

    const row = await autopayRow(f.leaseId)
    expect(row.enabled).toBe(true)
    expect(row.consecutive_failures).toBe(0)
  })

  it('a failed pull leaves the schedule ON and counts the failure', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    chargeMock.mockImplementationOnce(async () => { throw new Error('bank declined') })

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.failed).toBe(1)

    const row = await autopayRow(f.leaseId)
    expect(row.enabled).toBe(true)                // Nic: it stays on
    expect(row.consecutive_failures).toBe(1)
  })

  it('two failures in a row switch it off, with a reason the tenant can read', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    // Pre-load the first failure so this run is the second.
    await db.query(`UPDATE tenant_autopay SET consecutive_failures = $2 WHERE lease_id = $1`,
      [f.leaseId, AUTOPAY_DISARM_AFTER_FAILURES - 1])
    chargeMock.mockImplementationOnce(async () => { throw new Error('account closed') })

    await runAutopayForTimezone(TZ, runAt())

    const row = await autopayRow(f.leaseId)
    expect(row.enabled).toBe(false)
    expect(row.disarmed_reason).toBeTruthy()
    // Never the bank's error text — that is between the tenant and their bank.
    expect(row.disarmed_reason).not.toMatch(/account closed/i)
  })

  it('a switched-off schedule is never charged', async () => {
    await armForToday(f)
    await db.query(`UPDATE tenant_autopay SET enabled = FALSE WHERE lease_id = $1`, [f.leaseId])
    await seedCharge(f, 1000)

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.charged).toBe(0)
    expect(chargeMock).not.toHaveBeenCalled()
  })

  it('a lease scheduled for another day is left alone', async () => {
    const other = todayDay() === 15 ? 16 : 15
    await db.query(
      `INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, pull_day)
       VALUES ($1,$2,TRUE,$3)`, [f.tenantId, f.leaseId, other])
    await seedCharge(f, 1000)

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.considered).toBe(0)
    expect(chargeMock).not.toHaveBeenCalled()
  })

  describe('which day it fires', () => {
    it('no chosen day means the rent due day', () => {
      expect(isPullDayToday(5, null, 5)).toBe(true)
      expect(isPullDayToday(9, null, 5)).toBe(false)
    })
    it('a chosen day wins over the due day', () => {
      expect(isPullDayToday(9, 9, 1)).toBe(true)
      expect(isPullDayToday(1, 9, 1)).toBe(false)
    })
    it('neither set falls back to the 1st', () => {
      expect(isPullDayToday(1, null, null)).toBe(true)
    })
  })
})

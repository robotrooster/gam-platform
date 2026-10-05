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
// The real charge, where a test drives it, reaches Stripe through this one call.
let piSeq = 0
vi.mock('../services/stripeConnect', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createRentPlatformCharge: vi.fn(async () => ({ id: `pi_autopay_test_${++piSeq}`, status: 'processing' })),
  }
})
const { pmRetrieveMock, pmListMock, customerRetrieveMock, piCancelMock, piRetrieveMock } = vi.hoisted(() => ({
  piCancelMock: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
  /** What Stripe says of a card payment holding a bill (3-D Secure tests). */
  piRetrieveMock: vi.fn(async (id: string): Promise<any> => ({ id, status: 'requires_action' })),
  pmRetrieveMock: vi.fn(async (id: string): Promise<any> => ({ id, customer: 'cus_s609', type: 'us_bank_account' })),
  pmListMock: vi.fn(async (_o?: any): Promise<any> => ({ data: [] })),
  customerRetrieveMock: vi.fn(async (): Promise<any> => ({ invoice_settings: { default_payment_method: 'pm_default' } })),
}))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    paymentMethods: { retrieve: pmRetrieveMock, list: pmListMock },
    customers: { retrieve: customerRetrieveMock },
    paymentIntents: { cancel: piCancelMock, retrieve: piRetrieveMock },
  }),
}))
const { notifyAutopayFailedMock } = vi.hoisted(() => ({
  notifyAutopayFailedMock: vi.fn(async (_o?: any) => undefined),
}))
vi.mock('../services/notifications', () => ({
  createNotification: vi.fn(async () => undefined),
  notifyAutopayFailed: notifyAutopayFailedMock,
}))

import { runAutopayForTimezone, isPullDayToday, AUTOPAY_DISARM_AFTER_FAILURES, AUTOPAY_CARD_WHEN_BANK_PAUSED, resolvePaymentMethod, heldOverMarker, isMorningRunTick } from './autopayRunner'
import { CreditChangedError } from '../services/rentCharge'
import { holdCredit } from '../services/creditUse'
import { createNotification } from '../services/notifications'

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

/** A card refused on the spot, as the Stripe SDK throws it. */
function cardDeclined(): Error {
  return Object.assign(new Error('Your card was declined.'), {
    type: 'StripeCardError', rawType: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds',
  })
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
    notifyAutopayFailedMock.mockClear()
    pmRetrieveMock.mockReset()
    pmRetrieveMock.mockImplementation(async (id: string) => ({ id, customer: 'cus_s609', type: 'us_bank_account' }))
    pmListMock.mockReset()
    pmListMock.mockImplementation(async () => ({ data: [] }))
    customerRetrieveMock.mockReset()
    customerRetrieveMock.mockImplementation(async () => ({ invoice_settings: { default_payment_method: 'pm_default' } }))
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
  // never authorized.
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

  // S654: the failure notice was an in-app bell only. A tenant who thinks rent
  // paid itself does not open the app, so it now emails, with a Pay now button
  // that signs them in and lands on Payments.
  it('a failed pull emails the tenant a Pay now link that lands on Payments', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    chargeMock.mockImplementationOnce(async () => { throw cardDeclined() })

    await runAutopayForTimezone(TZ, runAt())

    expect(notifyAutopayFailedMock).toHaveBeenCalledTimes(1)
    const arg = notifyAutopayFailedMock.mock.calls[0][0]
    const t = (await db.query<{ user_id: string; email: string }>(
      `SELECT t.user_id, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [f.tenantId])).rows[0]
    expect(arg).toMatchObject({ tenantUserId: t.user_id, tenantEmail: t.email, disarming: false, kind: 'payment_method' })
    expect(arg.payUrl).toMatch(/\/login\?ef=[^&]+&to=%2Fpayments$/)
  })

  // S654 (review): the tenant is told WHY, truthfully. An eviction hold's
  // Payments page refuses the payment, and GAM's own errors are not their
  // account's fault — neither gets "check the account you pay from, then pay".
  it('an eviction hold is told as a paused space, not as a problem with their account', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    await db.query(`UPDATE units SET payment_block = TRUE WHERE id = $1`, [f.unitId])
    const { AppError } = await import('../middleware/errorHandler')
    chargeMock.mockImplementationOnce(async () => {
      throw new AppError(409, 'This unit is in eviction mode — payments to the landlord are paused. Accepting one could reset the eviction timeline. Contact the landlord.')
    })
    await runAutopayForTimezone(TZ, runAt())
    expect(notifyAutopayFailedMock).toHaveBeenCalledTimes(1)
    expect(notifyAutopayFailedMock.mock.calls[0][0]).toMatchObject({ kind: 'payments_paused' })
  })

  it('an error on our side is told as ours, and an admin is alerted', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    chargeMock.mockImplementationOnce(async () => { throw new Error('connection terminated unexpectedly') })
    await runAutopayForTimezone(TZ, runAt())
    expect(notifyAutopayFailedMock.mock.calls[0][0]).toMatchObject({ kind: 'our_side' })
    const alerts = await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'autopay_charge_error'`)
    expect(alerts.rows).toHaveLength(1)
  })

  it('no usable payment method is the tenant\'s to fix — told as such, no admin alert', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    await db.query(`UPDATE tenants SET stripe_customer_id = NULL WHERE id = $1`, [f.tenantId])
    await runAutopayForTimezone(TZ, runAt())
    expect(chargeMock).not.toHaveBeenCalled()
    expect(notifyAutopayFailedMock.mock.calls[0][0]).toMatchObject({ kind: 'payment_method' })
    const alerts = await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'autopay_charge_error'`)
    expect(alerts.rows).toHaveLength(0)
  })

  it('a pull that succeeds sends no failure notice', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    await runAutopayForTimezone(TZ, runAt())
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
  })

  it('two failures in a row switch it off, with a reason the tenant can read', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    // Pre-load the first failure so this run is the second.
    await db.query(`UPDATE tenant_autopay SET consecutive_failures = $2 WHERE lease_id = $1`,
      [f.leaseId, AUTOPAY_DISARM_AFTER_FAILURES - 1])
    chargeMock.mockImplementationOnce(async () => { throw Object.assign(new Error('account closed'), {
      type: 'StripeInvalidRequestError', code: 'bank_account_unusable' }) })

    await runAutopayForTimezone(TZ, runAt())

    const row = await autopayRow(f.leaseId)
    expect(row.enabled).toBe(false)
    expect(row.disarmed_reason).toBeTruthy()
    // Never the bank's error text — that is between the tenant and their bank.
    expect(row.disarmed_reason).not.toMatch(/account closed/i)
    // S654: the "turned off" notice is the one emailed.
    expect(notifyAutopayFailedMock.mock.calls[0][0]).toMatchObject({ disarming: true })
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

  // ── S654: a work-trade line is paid in hours, never pulled from the bank ──
  it('S654: a work-trade suspended line is never pulled', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,'utility',200,'pending', CURRENT_DATE, 'UTILITY', NOW())`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    await runAutopayForTimezone(TZ, runAt())
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 1000, source: 'autopay' })
  })

  it('S654: a month entirely covered by work trade is skipped, not charged', async () => {
    await armForToday(f)
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, work_trade_suspended_at)
       VALUES ($1,$2,$3,$4,'rent',1000,'pending', CURRENT_DATE, 'RENT', NOW())`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 0, skipped: 1, failed: 0 })
    expect(chargeMock).not.toHaveBeenCalled()
  })

  // ── S655 (money plan Step 8, item L) ────────────────────────────────────
  const giveCredit = (amount: number) => db.query(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
     VALUES ($1,$2,$3,$4,$4,'goodwill')`, [f.landlordId, f.tenantId, f.leaseId, amount])

  it('use-my-credit off charges the full bill and keeps the credit', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    await giveCredit(300)
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.charged).toBe(1)
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 1000, source: 'autopay', credit: { use: false, expected: 300 } })
  })

  it('on uses it; covering everything charges nothing', async () => {
    await armForToday(f)
    await db.query(`UPDATE tenant_autopay SET use_credit = TRUE WHERE lease_id = $1`, [f.leaseId])
    await seedCharge(f, 1000)
    await giveCredit(300)
    await runAutopayForTimezone(TZ, runAt())
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 700, credit: { use: true, expected: 300 } })

    // A credit that covers the whole bill: the real charge path, nothing charged.
    await cleanupAllSchema()
    f = await fixture()
    await armForToday(f)
    await db.query(`UPDATE tenant_autopay SET use_credit = TRUE WHERE lease_id = $1`, [f.leaseId])
    await seedCharge(f, 400)
    await giveCredit(500)
    const actual = await vi.importActual<typeof import('../services/rentCharge')>('../services/rentCharge')
    chargeMock.mockImplementationOnce(async (input: any) => actual.chargeLeaseBalance(input) as any)
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.charged).toBe(1)
    expect(chargeMock.mock.calls.at(-1)![0]).toMatchObject({ amount: 0, credit: { use: true, expected: 400 } })
    const rows = await db.query<any>(`SELECT status, stripe_payment_intent_id FROM payments WHERE lease_id = $1`, [f.leaseId])
    expect(rows.rows).toEqual([{ status: 'settled', stripe_payment_intent_id: null }])
    expect((await db.query(`SELECT 1 FROM tenant_remittances`)).rowCount).toBe(0)
  })

  // Fix round 2: the quote is read a moment before the charge takes its lock.
  // A credit that moved in between is refused by the charge before anything
  // is written; autopay re-quotes once — never a failure, never an admin alert.
  it('use-my-credit on: a credit that moved between the quote and the charge is re-quoted once, never a failure', async () => {
    await armForToday(f)
    await db.query(`UPDATE tenant_autopay SET use_credit = TRUE WHERE lease_id = $1`, [f.leaseId])
    await seedCharge(f, 1000)
    await giveCredit(300)
    chargeMock.mockImplementationOnce(async () => {
      // The credit moves the way the ledger allows once the C0 guard is on
      // (amount_remaining is never written directly): the $300 credit is
      // voided, as the landlord's void route does, and a $250 one issued.
      await db.query(`UPDATE tenant_credits SET status = 'void', voided_at = now(), updated_at = now() WHERE tenant_id = $1`, [f.tenantId])
      await giveCredit(250)
      throw new CreditChangedError(25000)
    })
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(chargeMock).toHaveBeenCalledTimes(2)
    expect(chargeMock.mock.calls[1][0]).toMatchObject({ amount: 750, credit: { use: true, expected: 250 } })
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
    const { rows: [a] } = await db.query<any>(`SELECT consecutive_failures, last_error FROM tenant_autopay WHERE lease_id = $1`, [f.leaseId])
    expect(a).toEqual({ consecutive_failures: 0, last_error: null })
  })

  it('a credit that moves twice in a row is a failure like any other', async () => {
    await armForToday(f)
    await db.query(`UPDATE tenant_autopay SET use_credit = TRUE WHERE lease_id = $1`, [f.leaseId])
    await seedCharge(f, 1000)
    await giveCredit(300)
    chargeMock.mockImplementation(async () => { throw new CreditChangedError(25000) })
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 0, failed: 1 })
    expect(chargeMock).toHaveBeenCalledTimes(2)
  })

  // Fix pass (verify r2): the answer always goes with the figure, $0 included.
  // A credit that lands between the quote and the charge's lock (desk cash
  // kept as credit, a webhook surplus, an issued credit) used to make the real
  // charge refuse with "choose Use or Save" — counted as a failure on our
  // side, an admin alert, a failure notice, and a step toward disarming.
  it('a credit that appears from $0 between the quote and the charge is not a failure: use-my-credit off charges the whole bill and keeps the credit', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    const actual = await vi.importActual<typeof import('../services/rentCharge')>('../services/rentCharge')
    chargeMock.mockImplementationOnce(async (input: any) => {
      await giveCredit(25)
      return actual.chargeLeaseBalance(input) as any
    })
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(chargeMock).toHaveBeenCalledTimes(1)
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 1000, credit: { use: false, expected: 0 } })
    const { rows: [rem] } = await db.query<any>(`SELECT amount::text FROM tenant_remittances WHERE lease_id = $1`, [f.leaseId])
    expect(rem.amount).toBe('1000.00')
    const { rows: [cr] } = await db.query<any>(`SELECT amount_remaining::text FROM tenant_credits WHERE tenant_id = $1`, [f.tenantId])
    expect(cr.amount_remaining).toBe('25.00')
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
    expect(await autopayRow(f.leaseId)).toMatchObject({ consecutive_failures: 0, enabled: true })
  })

  it('a credit that appears from $0 between the quote and the charge is not a failure: use-my-credit on re-quotes once and uses it', async () => {
    await armForToday(f)
    await db.query(`UPDATE tenant_autopay SET use_credit = TRUE WHERE lease_id = $1`, [f.leaseId])
    await seedCharge(f, 1000)
    const actual = await vi.importActual<typeof import('../services/rentCharge')>('../services/rentCharge')
    chargeMock
      .mockImplementationOnce(async (input: any) => {
        await giveCredit(25)
        return actual.chargeLeaseBalance(input) as any
      })
      .mockImplementationOnce(async (input: any) => actual.chargeLeaseBalance(input) as any)
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(chargeMock).toHaveBeenCalledTimes(2)
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 1000, credit: { use: true, expected: 0 } })
    expect(chargeMock.mock.calls[1][0]).toMatchObject({ amount: 975, credit: { use: true, expected: 25 } })
    const { rows: [rem] } = await db.query<any>(`SELECT amount::text FROM tenant_remittances WHERE lease_id = $1`, [f.leaseId])
    expect(rem.amount).toBe('975.00')
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
    expect(await autopayRow(f.leaseId)).toMatchObject({ consecutive_failures: 0, enabled: true })
  })

  it("the autopay amount equals the Pay Now quote, a neighbor's utility included", async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    // A neighbor landlord's trash on this lease's invoice (S616): not on the
    // lease, but on the bill the tenant pays in full.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const nb = await seedLandlord(c)
      const inv = await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
         VALUES ($1,$2,$3,$4,'INV-AP-1', CURRENT_DATE, 1000, 1025, 'pending') RETURNING id`,
        [f.landlordId, f.tenantId, f.leaseId, f.unitId])
      await c.query(`UPDATE payments SET invoice_id = $1 WHERE lease_id = $2`, [inv.rows[0].id, f.leaseId])
      await c.query(
        `INSERT INTO payments (unit_id, invoice_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'utility',25,'pending',CURRENT_DATE,'UTILITY')`,
        [f.unitId, inv.rows[0].id, f.tenantId, nb.landlordId])
      await c.query('COMMIT')
    } finally { c.release() }
    const { quoteLeaseCharge } = await vi.importActual<typeof import('../services/rentCharge')>('../services/rentCharge')
    const q = await quoteLeaseCharge({ tenantId: f.tenantId, leaseId: f.leaseId, paymentMethodType: 'ach' })
    await runAutopayForTimezone(TZ, runAt())
    expect(chargeMock.mock.calls[0][0].amount).toBe(1025)
    expect(chargeMock.mock.calls[0][0].amount).toBe(q.landing.dueCents / 100)
  })

  it('FlexPay tenants are skipped', async () => {
    await armForToday(f)
    await seedCharge(f, 1000)
    await db.query(`UPDATE tenants SET flexpay_enrolled = TRUE WHERE id = $1`, [f.tenantId])
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.considered).toBe(0)
    expect(chargeMock).not.toHaveBeenCalled()
  })

  it('the old bank is still charged while a new one verifies', async () => {
    await armForToday(f, null)
    await seedCharge(f, 1000)
    // The default is the new bank, still waiting on its microdeposits: not on the customer yet.
    customerRetrieveMock.mockImplementation(async () => ({ invoice_settings: { default_payment_method: 'pm_new_bank' } }))
    pmRetrieveMock.mockImplementation(async (id: string) => id === 'pm_new_bank'
      ? { id, customer: null, type: 'us_bank_account' }
      : { id, customer: 'cus_s609', type: 'us_bank_account' })
    pmListMock.mockImplementation(async (o: any) => ({
      data: o.type === 'us_bank_account' ? [{ id: 'pm_old_bank', customer: 'cus_s609', type: 'us_bank_account' }]
        : [{ id: 'pm_card', customer: 'cus_s609', type: 'card' }],
    }))
    await runAutopayForTimezone(TZ, runAt())
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ paymentMethodId: 'pm_old_bank', paymentMethodType: 'ach' })
  })

  it('no card fallback while a bank is verified', async () => {
    await armForToday(f, null)
    await seedCharge(f, 1000)
    customerRetrieveMock.mockImplementation(async () => ({ invoice_settings: { default_payment_method: null } }))
    pmListMock.mockImplementation(async (o: any) => ({
      data: o.type === 'us_bank_account' ? [{ id: 'pm_bank_ok', customer: 'cus_s609', type: 'us_bank_account' }]
        : [{ id: 'pm_card', customer: 'cus_s609', type: 'card' }],
    }))
    await runAutopayForTimezone(TZ, runAt())
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ paymentMethodId: 'pm_bank_ok', paymentMethodType: 'ach' })
  })

  it('a pinned method that is no longer on the account is a failure, never a switch to another method', async () => {
    await armForToday(f, 'pm_gone')
    await seedCharge(f, 1000)
    pmRetrieveMock.mockImplementation(async (id: string) => ({ id, customer: null, type: 'us_bank_account' }))
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.failed).toBe(1)
    expect(chargeMock).not.toHaveBeenCalled()
    expect(notifyAutopayFailedMock.mock.calls[0][0]).toMatchObject({ kind: 'payment_method' })
  })

  it('a suspended tenant is never pulled by bank, and never moved onto a card they did not choose', async () => {
    await armForToday(f, null)
    await seedCharge(f, 1000)
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [f.tenantId])
    customerRetrieveMock.mockImplementation(async () => ({ invoice_settings: { default_payment_method: 'pm_bank' } }))
    pmRetrieveMock.mockImplementation(async (id: string) => ({ id, customer: 'cus_s609', type: id === 'pm_card' ? 'card' : 'us_bank_account' }))
    pmListMock.mockImplementation(async (o: any) => ({
      data: o.type === 'us_bank_account' ? [{ id: 'pm_bank', customer: 'cus_s609', type: 'us_bank_account' }]
        : [{ id: 'pm_card', customer: 'cus_s609', type: 'card' }],
    }))
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r.failed).toBe(1)
    expect(chargeMock).not.toHaveBeenCalled()
    expect(notifyAutopayFailedMock.mock.calls[0][0]).toMatchObject({ kind: 'payment_method' })
  })

  // Fix round 1: nothing is charged, so no method is looked up at all.
  it('use-my-credit on and the credit pays the whole bill: settled with no card or bank, even with bank payments paused', async () => {
    await armForToday(f)
    await db.query(`UPDATE tenant_autopay SET use_credit = TRUE WHERE lease_id = $1`, [f.leaseId])
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [f.tenantId])
    await seedCharge(f, 400)
    await giveCredit(500)
    pmRetrieveMock.mockClear()
    customerRetrieveMock.mockClear()
    const actual = await vi.importActual<typeof import('../services/rentCharge')>('../services/rentCharge')
    chargeMock.mockImplementationOnce(async (input: any) => actual.chargeLeaseBalance(input) as any)
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(pmRetrieveMock).not.toHaveBeenCalled()
    expect(customerRetrieveMock).not.toHaveBeenCalled()
    const rows = await db.query<any>(`SELECT status FROM payments WHERE lease_id = $1`, [f.leaseId])
    expect(rows.rows).toEqual([{ status: 'settled' }])
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
  })

  /**
   * 10/4: f.leaseId is a renewal. The old lease on the same space ended; a
   * credit on it (`amount`, default $80) had $50 set aside by last month's
   * bank payment, the renewal hand-off moved the credit to the renewal, and
   * the bank bounced that payment: a retry is scheduled, still holding the $50.
   * This month's $1000 rent is open on the renewal; autopay is armed with
   * "use my credit first" on, and the real charge runs.
   */
  async function renewalWithMovedCreditHeldByOldRetry(o: { amount?: number } = {}) {
    const oldLeaseId = (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
       VALUES ($1,$2,1000,'fixed_term','active','2025-10-01', CURRENT_DATE - 1) RETURNING id`,
      [f.unitId, f.landlordId])).rows[0].id
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1,$2,'primary')`, [oldLeaseId, f.tenantId])
    await db.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [f.leaseId, oldLeaseId])
    const amount = o.amount ?? 80
    const creditId = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,$4,$4,'goodwill') RETURNING id`, [f.landlordId, f.tenantId, oldLeaseId, amount])).rows[0].id
    const lastMonth = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',1000,'processing', CURRENT_DATE - 30, 'RENT', 'pi_old_lease') RETURNING id`,
      [f.unitId, oldLeaseId, f.tenantId, f.landlordId])).rows[0].id
    const remId = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, payment_method, stripe_payment_intent_id, processing_fee_amount)
       VALUES ($1,$2,$3,950,950,0,'processing','ach','pi_old_lease',0) RETURNING id`,
      [f.tenantId, oldLeaseId, f.landlordId])).rows[0].id
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await holdCredit(c, [{ creditKind: 'issued', creditId, paymentId: lastMonth, leaseId: oldLeaseId, amount: 50,
        billingMonth: (await c.query<{ m: string }>(`SELECT to_char(date_trunc('month', CURRENT_DATE - 30), 'YYYY-MM-DD') AS m`)).rows[0].m }],
        { remittanceId: remId, source: 'portal' })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    // The renewal hand-off moves the credit (scheduler.handOffOpenItemsToRenewal);
    // the bank bounces last month's payment and a retry is scheduled, still holding the $50.
    await db.query(`UPDATE tenant_credits SET lease_id = $2 WHERE id = $1`, [creditId, f.leaseId])
    await db.query(`UPDATE payments SET status = 'failed', next_retry_at = now() + interval '3 days' WHERE id = $1`, [lastMonth])
    await db.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [oldLeaseId])

    await armForToday(f)
    await db.query(`UPDATE tenant_autopay SET use_credit = TRUE WHERE lease_id = $1`, [f.leaseId])
    await seedCharge(f, 1000)
    const actual = await vi.importActual<typeof import('../services/rentCharge')>('../services/rentCharge')
    chargeMock.mockImplementationOnce(async (input: any) => actual.chargeLeaseBalance(input) as any)
    ;(createNotification as any).mockClear()
    return { oldLeaseId, creditId, lastMonth }
  }
  const heldUsesOf = async (creditId: string) => (await db.query<{ payment_id: string; amount: string }>(
    `SELECT payment_id, amount::text AS amount FROM credit_uses WHERE tenant_credit_id = $1 AND status = 'held' ORDER BY amount`, [creditId])).rows
  const oldRetry = async (id: string) => (await db.query<any>(
    `SELECT status, next_retry_at IS NOT NULL AS retry FROM payments WHERE id = $1`, [id])).rows[0]
  const sentBodies = () => (createNotification as any).mock.calls.map((x: any[]) => x[0].body).join(' ')
  const WAITING_50 = '$50.00 of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.'

  // The charge used to refuse this with a plain 409 and autopay counted the
  // month as failed — no rent pulled, a late fee next. Now the free part is
  // used and the rest is pulled.
  it('autopay with use-my-credit-first on a renewal whose moved credit the old lease\'s retry holds still pulls the bill', async () => {
    const { creditId, lastMonth } = await renewalWithMovedCreditHeldByOldRetry()

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    // The free $30 is used and the rest of the bill is pulled this cycle.
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 970, source: 'autopay', credit: { use: true, expected: 30 } })
    const { rows: [rem] } = await db.query<any>(`SELECT amount::text FROM tenant_remittances WHERE lease_id = $1`, [f.leaseId])
    expect(rem.amount).toBe('970.00')
    // The held $50 stays with last month's retry.
    const held = await heldUsesOf(creditId)
    expect(held.find(h => h.payment_id === lastMonth)?.amount).toBe('50.00')
    expect(held.filter(h => h.payment_id !== lastMonth).map(h => h.amount)).toEqual(['30.00'])
    expect(await oldRetry(lastMonth)).toEqual({ status: 'failed', retry: true })
    // Not a failed month, and the tenant is told why only $30 was used.
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
    expect(await autopayRow(f.leaseId)).toMatchObject({ consecutive_failures: 0, enabled: true })
    expect(sentBodies()).toContain(WAITING_50)
  })

  it('autopay on that renewal when the free credit covers the bill: paid with credit, nothing pulled, the old retry keeps its hold', async () => {
    const { creditId, lastMonth } = await renewalWithMovedCreditHeldByOldRetry()
    // A later $1000 credit on the renewal: with the $30 free on the moved
    // credit it covers this month's $1000. The held $50 is not touched.
    const later = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,1000,1000,'goodwill') RETURNING id`, [f.landlordId, f.tenantId, f.leaseId])).rows[0].id
    pmRetrieveMock.mockClear()
    customerRetrieveMock.mockClear()
    const stripeConnect = await import('../services/stripeConnect')
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 0, source: 'autopay', credit: { use: true, expected: 1000 } })
    // Nothing charged, so no method is looked up and Stripe is never called.
    expect(pmRetrieveMock).not.toHaveBeenCalled()
    expect(customerRetrieveMock).not.toHaveBeenCalled()
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls).toHaveLength(0)
    const rows = await db.query<{ status: string }>(`SELECT status FROM payments WHERE lease_id = $1`, [f.leaseId])
    expect(rows.rows).toEqual([{ status: 'settled' }])
    expect(Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [later])).rows[0].r)).toBe(30)
    // Last month's retry keeps its $50 and its schedule.
    expect(await heldUsesOf(creditId)).toEqual([{ payment_id: lastMonth, amount: '50.00' }])
    expect(await oldRetry(lastMonth)).toEqual({ status: 'failed', retry: true })
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
    expect(await autopayRow(f.leaseId)).toMatchObject({ consecutive_failures: 0, enabled: true })
    expect(sentBodies()).toContain('Your account credit covered this bill, so nothing was charged.')
    // Recorded as autopay's, not as the whole-bill rule.
    const sources = (await db.query<{ source: string }>(
      `SELECT DISTINCT u.source FROM credit_uses u JOIN payments p ON p.id = u.payment_id
        WHERE p.lease_id = $1 AND u.status = 'applied'`, [f.leaseId])).rows.map(r => r.source)
    expect(sources).toEqual(['autopay'])
  })

  // decisions.md #46 1b: last month's bill has a bank retry scheduled for a
  // fixed amount; it never uses credit, so a free general credit is not set
  // aside for it — it pays this month's bill, the one autopay is charging.
  it('use-my-credit-first while an older bill\'s bank retry is scheduled: the free general credit pays this month\'s bill', async () => {
    const { creditId, lastMonth } = await renewalWithMovedCreditHeldByOldRetry({ amount: 50 })
    const general = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,NULL,200,200,'goodwill') RETURNING id`, [f.landlordId, f.tenantId])).rows[0].id

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 800, source: 'autopay', credit: { use: true, expected: 200 } })
    const { rows: [rem] } = await db.query<any>(`SELECT amount::text FROM tenant_remittances WHERE lease_id = $1`, [f.leaseId])
    expect(rem.amount).toBe('800.00')
    expect(Number((await db.query<{ r: string }>(`SELECT amount_remaining::text AS r FROM tenant_credits WHERE id = $1`, [general])).rows[0].r)).toBe(0)
    // Last month's retry is left as it was, with its $50.
    expect(await heldUsesOf(creditId)).toEqual([{ payment_id: lastMonth, amount: '50.00' }])
    expect(await oldRetry(lastMonth)).toEqual({ status: 'failed', retry: true })
    // The tenant is told why the moved credit's $50 was not used.
    expect(sentBodies()).toContain(WAITING_50)
  })

  it('autopay on that renewal when all its credit is held by the old retry: the whole bill is pulled, not a failure', async () => {
    const { creditId, lastMonth } = await renewalWithMovedCreditHeldByOldRetry({ amount: 50 })

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 1000, source: 'autopay', credit: { use: true, expected: 0 } })
    const { rows: [rem] } = await db.query<any>(`SELECT amount::text FROM tenant_remittances WHERE lease_id = $1`, [f.leaseId])
    expect(rem.amount).toBe('1000.00')
    expect(await heldUsesOf(creditId)).toEqual([{ payment_id: lastMonth, amount: '50.00' }])
    expect(await oldRetry(lastMonth)).toEqual({ status: 'failed', retry: true })
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
    expect(await autopayRow(f.leaseId)).toMatchObject({ consecutive_failures: 0, enabled: true })
    expect(sentBodies()).toContain(WAITING_50)
  })

  // Fix pass 3: two of the tenant's bills are pulled in one run, and the same
  // $50 held by last month's retry is what either could have used. The
  // tenant is told once, with the run's one figure — never "$50 set aside"
  // on both notices for one $50 hold.
  it('two bills pulled in one run: the held-credit sentence is sent once, with the run\'s figure', async () => {
    const { creditId } = await renewalWithMovedCreditHeldByOldRetry({ amount: 50 })
    // A general credit (any of the tenant's bills), still held by last month's retry.
    await db.query(`UPDATE tenant_credits SET lease_id = NULL WHERE id = $1`, [creditId])
    const c = await db.connect()
    let leaseB: string
    let unitB: string
    try {
      await c.query('BEGIN')
      unitB = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      leaseB = await seedLease(c, { unitId: unitB, landlordId: f.landlordId, rentAmount: 300 })
      await seedLeaseTenant(c, { leaseId: leaseB, tenantId: f.tenantId })
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',300,'pending', CURRENT_DATE, 'RENT')`, [unitB, leaseB, f.tenantId, f.landlordId])
    await db.query(
      `INSERT INTO tenant_autopay (tenant_id, lease_id, enabled, pull_day, payment_method_id, use_credit)
       VALUES ($1,$2,TRUE,$3,'pm_bank',TRUE)`, [f.tenantId, leaseB, todayDay()])
    const actual = await vi.importActual<typeof import('../services/rentCharge')>('../services/rentCharge')
    chargeMock.mockReset()
    chargeMock.mockImplementation(async (input: any) => actual.chargeLeaseBalance(input) as any)

    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 2, failed: 0 })
    const bodies: string[] = (createNotification as any).mock.calls.map((x: any[]) => x[0].body)
    expect(bodies).toHaveLength(2)
    expect(bodies.filter(b => b.includes('set aside'))).toHaveLength(1)
    expect(bodies.join(' ')).toContain(WAITING_50)
  })

  it('the held-credit sentence rides the first notice only, and never says less than that bill\'s own figure', async () => {
    const { waitingSentenceOnce } = await import('./autopayRunner')
    const told = new Set<string>()
    const run = new Map([['t1', 100]])
    // The run's figure ($100: two holds) beats the first bill's own $50.
    expect(waitingSentenceOnce('t1', 50, 'own note', run, told)).toContain('$100.00 of your credit is set aside')
    expect(waitingSentenceOnce('t1', 50, 'own note', run, told)).toBeNull()
    // One bill in the run: its own words.
    expect(waitingSentenceOnce('t2', 50, 'own note', run, told)).toBe('own note')
    // Nothing held on this bill: nothing said, and the tenant is not marked told.
    expect(waitingSentenceOnce('t3', 0, null, new Map([['t3', 50]]), told)).toBeNull()
    expect(told.has('t3')).toBe(false)
  })

  // The money plan's method rule (item L, "a card only when no verified bank
  // is on file") decides it: a paused bank is still a verified bank on file.
  // The rule lives in one constant and flips cleanly.
  it('a paused bank is not replaced by a card (the plan\'s method rule); the one setting flips it', async () => {
    expect(AUTOPAY_CARD_WHEN_BANK_PAUSED).toBe(false)
    customerRetrieveMock.mockImplementation(async () => ({ invoice_settings: { default_payment_method: 'pm_bank' } }))
    pmRetrieveMock.mockImplementation(async (id: string) => ({ id, customer: 'cus_s609', type: id === 'pm_card' ? 'card' : 'us_bank_account' }))
    pmListMock.mockImplementation(async (o: any) => ({
      data: o.type === 'us_bank_account' ? [{ id: 'pm_bank', customer: 'cus_s609', type: 'us_bank_account' }]
        : [{ id: 'pm_card', customer: 'cus_s609', type: 'card' }],
    }))
    await expect(resolvePaymentMethod(null, 'cus_s609', { achSuspended: true })).rejects.toThrow(/paused/)
    await expect(resolvePaymentMethod('pm_bank', 'cus_s609', { achSuspended: true })).rejects.toThrow(/paused/)
    expect(await resolvePaymentMethod(null, 'cus_s609', { achSuspended: true, cardWhenBankPaused: true }))
      .toEqual({ id: 'pm_card', type: 'card' })
    expect(await resolvePaymentMethod('pm_bank', 'cus_s609', { achSuspended: true, cardWhenBankPaused: true }))
      .toEqual({ id: 'pm_card', type: 'card' })
  })

  it('a suspended tenant whose own default is a card is charged on that card', async () => {
    await armForToday(f, null)
    await seedCharge(f, 1000)
    await db.query(`UPDATE tenants SET ach_suspended_at = NOW() WHERE id = $1`, [f.tenantId])
    customerRetrieveMock.mockImplementation(async () => ({ invoice_settings: { default_payment_method: 'pm_card' } }))
    pmRetrieveMock.mockImplementation(async (id: string) => ({ id, customer: 'cus_s609', type: id === 'pm_card' ? 'card' : 'us_bank_account' }))
    await runAutopayForTimezone(TZ, runAt())
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ paymentMethodId: 'pm_card', paymentMethodType: 'card' })
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

  // autopaycredit2 review problem 2: the notice reads its amount like the
  // waiting sentence beside it ("$1,234.00"), never "$1234.00".
  it('the autopay notice names a $1,234.00 bank payment with its comma', async () => {
    await armForToday(f)
    await seedCharge(f, 1228)
    chargeMock.mockImplementationOnce(async () => ({
      remittanceId: 'rem_x', paymentIntentId: 'pi_x', status: 'processing',
      appliedTotal: 1228, payAhead: 0, platformCutAmount: 6, lines: [], chargeAmount: 1234,
    }) as any)
    ;(createNotification as any).mockClear()
    await runAutopayForTimezone(TZ, runAt())
    const body: string = (createNotification as any).mock.calls.map((x: any[]) => x[0].body).join(' ')
    expect(body).toContain('scheduled rent payment of $1,234.00.')
    expect(body).not.toMatch(/\$1234/)
  })

  it('the autopay notice names a $1,234.00 card charge with its comma', async () => {
    await armForToday(f, 'pm_card')
    pmRetrieveMock.mockImplementation(async (id: string) => ({ id, customer: 'cus_s609', type: 'card' }))
    await seedCharge(f, 1190)
    chargeMock.mockImplementationOnce(async () => ({
      remittanceId: 'rem_x', paymentIntentId: 'pi_x', status: 'succeeded',
      appliedTotal: 1190, payAhead: 0, platformCutAmount: 44, lines: [], chargeAmount: 1234,
    }) as any)
    ;(createNotification as any).mockClear()
    await runAutopayForTimezone(TZ, runAt())
    const body: string = (createNotification as any).mock.calls.map((x: any[]) => x[0].body).join(' ')
    expect(body).toContain('Your card was charged $1,234.00 for rent.')
  })

  // decisions.md #48.4: an autopay card pull is sent off-session; a bank that
  // still wants the cardholder to confirm makes it fail through the normal
  // failure path, and the tenant is told to pay on the Payments page.
  it('a card pull the bank still wants confirmed fails through the normal failure path, card side, nothing charged', async () => {
    await armForToday(f, 'pm_card')
    pmRetrieveMock.mockImplementation(async (id: string) => ({ id, customer: 'cus_s609', type: 'card' }))
    await seedCharge(f, 1000)
    const actual = await vi.importActual<typeof import('../services/rentCharge')>('../services/rentCharge')
    const stripeConnect = await import('../services/stripeConnect')
    ;(stripeConnect.createRentPlatformCharge as any).mockClear()
    ;(stripeConnect.createRentPlatformCharge as any).mockImplementationOnce(async () => {
      throw Object.assign(new Error('This payment requires authentication.'), {
        type: 'StripeCardError', rawType: 'card_error', code: 'authentication_required',
        raw: { type: 'card_error', code: 'authentication_required', payment_intent: { id: 'pi_autopay_offsession' } },
      })
    })
    chargeMock.mockImplementationOnce(async (input: any) => actual.chargeLeaseBalance(input) as any)
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 0, failed: 1 })
    expect((stripeConnect.createRentPlatformCharge as any).mock.calls[0][0]).toMatchObject({ offSession: true, paymentMethodTypes: ['card'] })
    expect(notifyAutopayFailedMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'payment_method' }))
    expect(piCancelMock).toHaveBeenCalledWith('pi_autopay_offsession')
    const { rows: [a] } = await db.query<any>(`SELECT consecutive_failures, last_error FROM tenant_autopay WHERE lease_id = $1`, [f.leaseId])
    expect(a.consecutive_failures).toBe(1)
    expect(a.last_error).toMatch(/pay it on the Payments page/)
    expect((await db.query<any>(`SELECT status FROM payments WHERE lease_id = $1`, [f.leaseId])).rows).toEqual([{ status: 'pending' }])
  })
})

// ─── Fix pass 3: a bill held by a card payment its payer is confirming ───────
// A tenant who pressed Pay by card on the portal and is answering their bank's
// confirmation (3-D Secure) holds the bill for up to 30 minutes. Autopay never
// reads that as a paid bill: a hold past its window is released and the bill
// pulled; a hold still open is waited on (the lease is held over and looked at
// again), never recorded as this month's success.
describe('autopay and a bill held by a card being confirmed (3-D Secure)', () => {
  // What services/rentCharge stamps on a pay-screen card charge — the only
  // kind that holds a bill for its payer (paymentReconcile.heldForCardholder).
  const ON_SCREEN = { gam_confirm_on_screen: 'true' }
  let f: Fixture
  beforeEach(async () => {
    await cleanupAllSchema()
    chargeMock.mockClear()
    notifyAutopayFailedMock.mockClear()
    ;(createNotification as any).mockClear()
    piCancelMock.mockClear()
    piRetrieveMock.mockReset()
    pmRetrieveMock.mockReset()
    pmRetrieveMock.mockImplementation(async (id: string) => ({ id, customer: 'cus_s609', type: 'us_bank_account' }))
    pmListMock.mockReset()
    pmListMock.mockImplementation(async () => ({ data: [] }))
    customerRetrieveMock.mockReset()
    customerRetrieveMock.mockImplementation(async () => ({ invoice_settings: { default_payment_method: 'pm_default' } }))
    chargeMock.mockImplementation(async (_input?: any) => ({
      remittanceId: 'rem_x', paymentIntentId: 'pi_x', status: 'processing',
      appliedTotal: 0, payAhead: 0, platformCutAmount: 0, lines: [],
    }))
    f = await fixture()
  })

  /** This month's $1,000 rent held by a card payment made `minutesAgo` minutes ago on the pay screen. */
  async function seedHeldByCard(pi: string, minutesAgo: number): Promise<string> {
    const rowId = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'rent',1000,'processing', CURRENT_DATE, 'RENT', $5) RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId, pi])).rows[0].id
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       payment_method, gross_amount, processing_fee_amount, stripe_payment_intent_id, status, created_at)
       VALUES ($1,$2,$3,1000,1000,0,'card',1035.55,35.55,$4,'processing', now() - ($5 || ' minutes')::interval)`,
      [f.tenantId, f.leaseId, f.landlordId, pi, String(minutesAgo)])
    return rowId
  }
  const cycleOf = () => `${runAt().toISOString().slice(0, 7)}-01`
  const autopayRow = async () => (await db.query<any>(
    `SELECT last_run_cycle::text AS last_run_cycle, last_success_cycle::text AS last_success_cycle,
            consecutive_failures, last_error FROM tenant_autopay WHERE lease_id = $1`, [f.leaseId])).rows[0]

  it('a bill held by a card payment still being confirmed is not counted as paid: nothing charged, no success recorded, nobody told', async () => {
    await armForToday(f)
    await seedHeldByCard('pi_3ds_fresh', 5)
    piRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'requires_action' }))
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ considered: 1, charged: 0, failed: 0, skipped: 1 })
    expect(chargeMock).not.toHaveBeenCalled()
    expect(piCancelMock).not.toHaveBeenCalled()
    expect(notifyAutopayFailedMock).not.toHaveBeenCalled()
    expect(createNotification).not.toHaveBeenCalled()
    expect(await autopayRow()).toEqual({
      last_run_cycle: heldOverMarker(cycleOf()), last_success_cycle: null, consecutive_failures: 0, last_error: null,
    })
  })

  it('a held-over bill whose card payment was then abandoned is pulled on the next look, the same day', async () => {
    await armForToday(f)
    const rowId = await seedHeldByCard('pi_3ds_abandoned', 5)
    piRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'requires_action' }))
    await runAutopayForTimezone(TZ, runAt())
    expect(chargeMock).not.toHaveBeenCalled()
    // 30 minutes on, nobody confirmed: the hold is past its window.
    await db.query(`UPDATE tenant_remittances SET created_at = now() - interval '40 minutes' WHERE stripe_payment_intent_id = 'pi_3ds_abandoned'`)
    const later = await runAutopayForTimezone(TZ, runAt(), { pullDays: false })
    expect(later).toMatchObject({ considered: 1, charged: 1 })
    expect(piCancelMock).toHaveBeenCalledWith('pi_3ds_abandoned')
    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [rowId])).rows[0].status).toBe('pending')
    expect(chargeMock).toHaveBeenCalledTimes(1)
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ leaseId: f.leaseId, amount: 1000, source: 'autopay' })
    expect((await autopayRow())).toMatchObject({ last_run_cycle: cycleOf(), last_success_cycle: cycleOf() })
  })

  it('a hold older than 30 minutes is released first and the bill pulled in the morning run', async () => {
    await armForToday(f)
    await seedHeldByCard('pi_3ds_old', 40)
    piRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'requires_action' }))
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 1, failed: 0 })
    expect(piCancelMock).toHaveBeenCalledWith('pi_3ds_old')
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ amount: 1000 })
    expect(await autopayRow()).toMatchObject({ last_success_cycle: cycleOf() })
  })

  it('a held-over bill whose card payment went through is recorded as paid, nothing pulled', async () => {
    await armForToday(f)
    await seedHeldByCard('pi_3ds_confirmed', 5)
    piRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'requires_action' }))
    await runAutopayForTimezone(TZ, runAt())
    // The payer confirmed: Stripe now says it went through (the webhook may not have landed yet).
    piRetrieveMock.mockImplementation(async (id: string) => ({ id, metadata: ON_SCREEN, status: 'succeeded' }))
    const later = await runAutopayForTimezone(TZ, runAt(), { pullDays: false })
    expect(later).toMatchObject({ considered: 1, charged: 0, skipped: 1 })
    expect(chargeMock).not.toHaveBeenCalled()
    expect(await autopayRow()).toMatchObject({ last_run_cycle: cycleOf(), last_success_cycle: cycleOf() })
  })

  it('a card charge the pay screen did not make (a move-out balance charge GAM is finishing) never holds the bill: autopay pulls what is owed and leaves that charge alone', async () => {
    await armForToday(f)
    await seedHeldByCard('pi_gap_waiting', 40)
    // A water bill on the same lease, open and owed.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',40,'pending', CURRENT_DATE, 'UTILITY')`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    piRetrieveMock.mockImplementation(async (id: string) => ({ id, status: 'requires_confirmation', metadata: { gam_kind: 'deposit_return_gap' } }))
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ considered: 1, charged: 1, failed: 0 })
    expect(chargeMock.mock.calls[0][0]).toMatchObject({ leaseId: f.leaseId, amount: 40, source: 'autopay' })
    expect(piCancelMock).not.toHaveBeenCalled()
    expect((await db.query<any>(`SELECT status FROM payments WHERE stripe_payment_intent_id = 'pi_gap_waiting'`)).rows).toEqual([{ status: 'processing' }])
    expect(await autopayRow()).toMatchObject({ last_success_cycle: cycleOf() })
  })

  it('a card payment Stripe cannot be asked about is waited on, never read as paid', async () => {
    await armForToday(f)
    await seedHeldByCard('pi_3ds_unknown', 5)
    piRetrieveMock.mockImplementation(async () => { throw new Error('Stripe is down') })
    const r = await runAutopayForTimezone(TZ, runAt())
    expect(r).toMatchObject({ charged: 0, failed: 0, skipped: 1 })
    expect(await autopayRow()).toMatchObject({ last_run_cycle: heldOverMarker(cycleOf()), last_success_cycle: null })
  })

  it('the later looks take only held-over leases, never a pull day', async () => {
    await armForToday(f)
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',1000,'pending', CURRENT_DATE, 'RENT')`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    const r = await runAutopayForTimezone(TZ, runAt(), { pullDays: false })
    expect(r.considered).toBe(0)
    expect(chargeMock).not.toHaveBeenCalled()
    expect((await autopayRow()).last_run_cycle).toBeNull()
  })

  it('the held-over mark is the day before the cycle: below it, and never a real cycle', () => {
    expect(heldOverMarker('2026-10-01')).toBe('2026-09-30')
    expect(heldOverMarker('2026-03-01')).toBe('2026-02-28')
    expect(heldOverMarker('2027-01-01')).toBe('2026-12-31')
  })

  it('the morning run is the 09:00 tick in the property’s own time; the later ticks are not', () => {
    // 16:05 UTC is 09:05 in Phoenix (no daylight saving).
    expect(isMorningRunTick('America/Phoenix', new Date('2026-10-15T16:05:00Z'))).toBe(true)
    expect(isMorningRunTick('America/Phoenix', new Date('2026-10-15T16:15:00Z'))).toBe(false)
    expect(isMorningRunTick('America/Phoenix', new Date('2026-10-15T17:00:00Z'))).toBe(false)
    expect(isMorningRunTick('America/New_York', new Date('2026-10-15T13:00:00Z'))).toBe(true)
  })
})

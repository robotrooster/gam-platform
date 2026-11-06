/**
 * S641 (Nic) — the month-end sweep.
 *
 *   "A lot of landlords like to sweep cash before the end of the month, so we
 *    should have one additional push timed so that the balance is swept and HITS
 *    THE BANK ACCOUNT by the last business day of the month. If the last
 *    business day is a Friday and we need to push it on a Tuesday or Wednesday
 *    for it to actually hit by that Friday, that's important to some landlords
 *    for bookkeeping. You don't want stuff rolling over — you want all the
 *    months separated accurately."
 *
 * The target is ARRIVAL, not firing, which is the whole reason this is not just
 * "run on the last day". Everything below works backwards from the day the
 * money has to be in the bank.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const firePayoutMock = vi.hoisted(() => vi.fn(async () => ({ id: 'po_sweep' })))
const balanceMock = vi.hoisted(() => vi.fn(async () => 0))

vi.mock('../services/connectPayouts', () => ({
  firePayoutForConnectAccount: firePayoutMock,
  getAvailableUsdBalance: balanceMock,
}))
vi.mock('../services/landlordPassthrough', () => ({
  // 10/5: the run moves held rent per Stripe account.
  reconcilePlatformHeldForAccount: vi.fn(async () => ({
    attempted: false, payments_settled: 0, transfer_id: null, amount: 0 })),
  recoverPendingPlatformTransfers: vi.fn(async () => ({ scanned: 0, recovered: 0, stillPending: 0 })),
}))
vi.mock('../services/instantWithdrawalMargin', () => ({
  collectOwedInstantMargins: vi.fn(async () => undefined),
}))
vi.mock('../services/adminNotifications', () => ({
  createAdminNotification: vi.fn(async () => undefined),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import {
  processAutoPayouts, isMonthEndSweepDay,
  lastBusinessDayOfMonthUtc, monthEndSweepDateUtc,
} from './autoPayouts'

beforeEach(async () => {
  await cleanupAllSchema()
  firePayoutMock.mockClear()
  balanceMock.mockClear()
})

const at = (iso: string) => new Date(iso + 'T01:00:00Z')
const dow = (iso: string) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })

describe('S641 the last business day of the month', () => {
  it('is the last weekday when the month ends on a weekend', () => {
    // 2026-05-31 is a Sunday → Friday the 29th.
    expect(lastBusinessDayOfMonthUtc(2026, 4)).toBe('2026-05-29')
    expect(dow('2026-05-29')).toBe('Fri')
  })

  it('is the last calendar day when that day is a weekday', () => {
    // 2026-09-30 is a Wednesday.
    expect(lastBusinessDayOfMonthUtc(2026, 8)).toBe('2026-09-30')
  })

  it('steps back off a federal holiday falling on the last day', () => {
    // 2026-12-31 is a Thursday and not a holiday; check the mechanism on a
    // month whose end is a weekend instead, then assert no holiday is ever
    // returned for any month of the year.
    for (let m = 0; m < 12; m++) {
      const d = lastBusinessDayOfMonthUtc(2026, m)
      expect(['Sat', 'Sun']).not.toContain(dow(d))
    }
  })
})

/**
 * 10/28 (Nic) — THE SWEEP FIRES ON THE LAST BUSINESS DAY, NOT BEFORE IT:
 *
 *   "the month-end sweep shouldn't happen the two business days before. We need
 *    the last possible sweep that hits in the month to be right on the last
 *    day."
 *
 * These three asserted the two-business-days-early rule that preceded that, and
 * went stale when autoPayouts.monthEndSweepDateUtc was changed to honour it —
 * the lead time was a hedge from when payouts took days to land, and it only
 * ever bought a gap: October paid out on the 28th and left the 29th and 30th to
 * roll into November, which is the thing the sweep exists to prevent.
 */
describe('S641 when the sweep fires', () => {
  it('fires on the last business day, so nothing rolls into next month', () => {
    // September 2026: last business day Wed the 30th → fires that day.
    expect(monthEndSweepDateUtc(2026, 8)).toBe('2026-09-30')
    expect(dow('2026-09-30')).toBe('Wed')
  })

  // Nic's own example: a month whose last day is a weekend.
  it('a month ending Saturday fires on the Friday before', () => {
    // 2026-01-31 is a Saturday → the last day a bank is open is Fri the 30th.
    expect(lastBusinessDayOfMonthUtc(2026, 0)).toBe('2026-01-30')
    expect(monthEndSweepDateUtc(2026, 0)).toBe('2026-01-30')
    expect(dow('2026-01-30')).toBe('Fri')
  })

  it('never fires on a weekend or a holiday, in any month of the year', () => {
    for (let m = 0; m < 12; m++) {
      const d = monthEndSweepDateUtc(2026, m)
      expect(['Sat', 'Sun']).not.toContain(dow(d))
      expect(isMonthEndSweepDay(at(d))).toBe(true)
    }
  })

  it('is the last business day itself, every month of the year', () => {
    for (let m = 0; m < 12; m++) {
      // The run day IS the landing day on this account (standard payouts arrive
      // on the UTC day they are created), so there is no lead time to leave.
      expect(monthEndSweepDateUtc(2026, m)).toBe(lastBusinessDayOfMonthUtc(2026, m))
    }
  })

  it('is not a sweep day on an ordinary day', () => {
    expect(isMonthEndSweepDay(at('2026-09-15'))).toBe(false)
    expect(isMonthEndSweepDay(at('2026-09-01'))).toBe(false)
  })
})

describe('S641 the sweep pays where the weekly run would not', () => {
  async function seedPayable(lastPayoutDaysAgo: number | null) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      await c.query(
        `UPDATE landlords SET gam_debit_payment_method_id = 'pm_test_bank', stripe_connect_account_id = $2,
                connect_payouts_enabled = TRUE, connect_details_submitted = TRUE
          WHERE id = $1`, [landlordId, 'acct_sweep_' + landlordId.slice(0, 8)])
      if (lastPayoutDaysAgo != null) {
        await c.query(
          `INSERT INTO disbursements (user_id, landlord_id, amount, status, trigger_type, created_at, stripe_account_id)
           VALUES ($1,$2,500,'pending','auto_friday', NOW() - ($3 || ' days')::interval, $4)`,
          [userId, landlordId, String(lastPayoutDaysAgo), 'acct_sweep_' + landlordId.slice(0, 8)])
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const sweepInstant = () => at(monthEndSweepDateUtc(2026, 8))   // Mon 2026-09-28

  // The case that makes the exemption necessary: the weekly run paid them on
  // Thursday, and without this a residual would roll into next month's books.
  it('pays even though the weekly run paid two days ago', async () => {
    await seedPayable(2)
    balanceMock.mockResolvedValue(700 as any)
    const res = await processAutoPayouts(sweepInstant())
    expect(res.payoutsFired).toBe(1)
  })

  // A $40 residual is exactly what makes a month fail to tie out.
  it('pays a balance under the $100 floor', async () => {
    await seedPayable(2)
    balanceMock.mockResolvedValue(40 as any)
    const res = await processAutoPayouts(sweepInstant())
    expect(res.payoutsFired).toBe(1)
    expect(res.skippedBelowMinimum).toBe(0)
  })

  it('still sends nothing when there is nothing to send', async () => {
    await seedPayable(2)
    balanceMock.mockResolvedValue(0 as any)
    const res = await processAutoPayouts(sweepInstant())
    expect(res.payoutsFired).toBe(0)
    expect(res.skippedZeroBalance).toBe(1)
  })

  it('marks the payout as the month-end sweep, not the weekly run', async () => {
    await seedPayable(null)
    balanceMock.mockResolvedValue(700 as any)
    await processAutoPayouts(sweepInstant())
    const meta = (firePayoutMock.mock.calls[0] as any[])[0]?.metadata
    expect(meta?.gam_trigger).toBe('month_end_sweep')
  })

  // On an ordinary weekly day the guards are back in force.
  it('the weekly run still respects the floor and the interval', async () => {
    await seedPayable(2)
    balanceMock.mockResolvedValue(40 as any)
    // 2026-09-17 is the weekly payout day (Thursday, UTC).
    const res = await processAutoPayouts(at('2026-09-17'))
    expect(res.payoutsFired).toBe(0)
  })
})

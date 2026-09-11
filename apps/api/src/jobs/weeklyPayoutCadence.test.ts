/**
 * S640 (Nic, DIRECTIVE) — payouts are weekly, with a floor and an age override.
 *
 *   "The weekly transfer is a lot simpler than trying to have the three per
 *    cycle... if for some reason everybody's fairly late one month, or we don't
 *    hit the fifty percent threshold, and one person waits a whole week just to
 *    make it cross that, that's a problem. Let's just do it freaking weekly."
 *
 *   "Let's just make it a hundred dollar minimum if money is ever just sitting
 *    there... Landlords operating on that scale aren't crying for the forty
 *    bucks right away."
 *
 * The thresholds were meant to pay a landlord FASTER than a weekly calendar and
 * did the opposite: they scheduled four business days out, so Mountain View hit
 * 50% on Sep 9 and had its money booked for Sep 16 while it sat available the
 * whole time. And the economics say the complexity buys nothing — Stripe's
 * outbound fee is 0.17% of volume plus $0.25 a payout, and the percentage lands
 * on the volume however it is batched. Weekly against three-per-cycle is 33
 * cents a month at Mountain View.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const firePayoutMock = vi.hoisted(() => vi.fn(async () => ({ id: 'po_test' })))
const balanceMock = vi.hoisted(() => vi.fn(async () => 0))

vi.mock('../services/connectPayouts', () => ({
  firePayoutForConnectAccount: firePayoutMock,
  getAvailableUsdBalance: balanceMock,
}))
vi.mock('../services/landlordPassthrough', () => ({
  reconcilePlatformHeldPayments: vi.fn(async () => ({
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
import { processAutoPayouts, shouldRunToday } from './autoPayouts'

beforeEach(async () => {
  await cleanupAllSchema()
  firePayoutMock.mockClear()
  balanceMock.mockClear()
})

/** The next date the engine would actually run, so tests never fight the clock. */
function nextRunDate(): Date {
  const d = new Date()
  for (let i = 0; i < 21; i++) {
    if (shouldRunToday(d)) return d
    d.setDate(d.getDate() + 1)
  }
  throw new Error('no run day found in three weeks')
}

/** A Connect-ready landlord with no rent roll and no prior payout. */
async function seedPayable(opts: { lastPayoutDaysAgo?: number } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    await c.query(
      `UPDATE landlords SET stripe_connect_account_id = $2,
              connect_payouts_enabled = TRUE, connect_details_submitted = TRUE
        WHERE id = $1`, [landlordId, 'acct_weekly_' + landlordId.slice(0, 8)])
    if (opts.lastPayoutDaysAgo != null) {
      await c.query(
        `INSERT INTO disbursements (user_id, landlord_id, amount, status, trigger_type, created_at)
         VALUES ($1,$2,500,'pending','auto_friday', NOW() - ($3 || ' days')::interval)`,
        [userId, landlordId, String(opts.lastPayoutDaysAgo)])
    }
    await c.query('COMMIT')
    return { userId, landlordId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('S640 weekly payout cadence', () => {
  it('pays every Connect-ready landlord on the weekly run, with no threshold to reach', async () => {
    await seedPayable()
    balanceMock.mockResolvedValue(850 as any)
    const res = await processAutoPayouts(nextRunDate())
    expect(res.payoutsFired).toBe(1)
    expect(firePayoutMock).toHaveBeenCalledTimes(1)
  })

  // The floor: $0.25 is 0.6% of a $40 payout and 0.03% of an $800 one.
  it('holds back a balance under $100', async () => {
    await seedPayable({ lastPayoutDaysAgo: 7 })
    balanceMock.mockResolvedValue(40 as any)
    const res = await processAutoPayouts(nextRunDate())
    expect(res.payoutsFired).toBe(0)
    expect(res.skippedBelowMinimum).toBe(1)
    expect(firePayoutMock).not.toHaveBeenCalled()
  })

  // ...and the override that makes the floor a delay rather than a trap.
  it('pays a small balance anyway once it has waited a month', async () => {
    await seedPayable({ lastPayoutDaysAgo: 31 })
    balanceMock.mockResolvedValue(40 as any)
    const res = await processAutoPayouts(nextRunDate())
    expect(res.payoutsFired).toBe(1)
  })

  // A landlord who has NEVER been paid has no clock to measure, so the floor
  // must not hold their first payout hostage forever.
  it('pays a first-ever small balance rather than waiting on a clock that has not started', async () => {
    await seedPayable()
    balanceMock.mockResolvedValue(40 as any)
    const res = await processAutoPayouts(nextRunDate())
    expect(res.payoutsFired).toBe(1)
  })

  // The dedup, as an interval rather than a calendar rule.
  it('will not pay the same account twice inside five days', async () => {
    await seedPayable({ lastPayoutDaysAgo: 2 })
    balanceMock.mockResolvedValue(900 as any)
    const res = await processAutoPayouts(nextRunDate())
    expect(res.payoutsFired).toBe(0)
    expect(res.skippedAlreadyPaidThisWeek).toBe(1)
  })

  it('pays again once the interval has passed', async () => {
    await seedPayable({ lastPayoutDaysAgo: 6 })
    balanceMock.mockResolvedValue(900 as any)
    const res = await processAutoPayouts(nextRunDate())
    expect(res.payoutsFired).toBe(1)
  })
})

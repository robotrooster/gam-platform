/**
 * S561 Phase 2 (platform-holds money-flow rebuild): coverage for the weekly
 * auto-payout engine, which previously had NONE.
 *
 * Two concerns:
 *   1. Day gate — the batch now INITIATES on TUESDAY (D1: lands the landlord's
 *      bank by Friday at standard T+1–T+2), not Friday. shouldRunToday must be
 *      true only on that day.
 *   2. Phase 2 merge — for landlord users the engine must move platform-held
 *      owner-share (platform → their Connect) via reconcilePlatformHeldPayments
 *      BEFORE reading the Connect balance and firing the payout, so the sweep
 *      picks up the freshly-transferred funds in the same run.
 *
 * Stripe + the reconcile transfer are mocked; this is a unit test of the
 * engine's gating + call ordering, not the reconcile internals (those have
 * their own suite in services/landlordPassthrough.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const reconcileMock = vi.hoisted(() => vi.fn(async () => ({
  attempted: true, payments_settled: 1, transfer_id: 'tr_mock' as string | null, amount: 100,
})))
const getBalanceMock = vi.hoisted(() => vi.fn(async () => 100))
const firePayoutMock = vi.hoisted(() => vi.fn(async () => ({ id: 'po_mock' })))
const adminNotifyMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../services/landlordPassthrough', () => ({
  reconcilePlatformHeldPayments: reconcileMock,
}))
vi.mock('../services/connectPayouts', () => ({
  getAvailableUsdBalance: getBalanceMock,
  firePayoutForConnectAccount: firePayoutMock,
}))
vi.mock('../services/adminNotifications', () => ({
  createAdminNotification: adminNotifyMock,
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { shouldRunToday, processAutoPayouts } from './autoPayouts'

// Phoenix is UTC-7 year-round (no DST). Noon at -07:00 pins the calendar day.
const phx = (isoDate: string) => new Date(`${isoDate}T12:00:00-07:00`)
// July 2026 reference days (verified): 27th=Mon, 28th=Tue, 29th=Wed,
// 31st=Fri, Aug 1=Sat, Aug 2=Sun.
const TUESDAY   = phx('2026-07-28')
const MONDAY    = phx('2026-07-27')
const WEDNESDAY = phx('2026-07-29')
const FRIDAY    = phx('2026-07-31')
const SATURDAY  = phx('2026-08-01')
const SUNDAY    = phx('2026-08-02')

beforeEach(async () => {
  await cleanupAllSchema()
  reconcileMock.mockClear()
  getBalanceMock.mockClear()
  firePayoutMock.mockClear()
  adminNotifyMock.mockClear()
  getBalanceMock.mockResolvedValue(100)
  firePayoutMock.mockResolvedValue({ id: 'po_mock' } as any)
})

async function seedConnectReadyLandlord(account = 'acct_test_ll'): Promise<string> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId } = await seedLandlord(c)
    await c.query(
      `UPDATE users
          SET stripe_connect_account_id = $2,
              connect_payouts_enabled   = true,
              connect_details_submitted = true
        WHERE id = $1`,
      [userId, account]
    )
    await c.query('COMMIT')
    return userId
  } catch (e) {
    await c.query('ROLLBACK'); throw e
  } finally {
    c.release()
  }
}

// S554 Stage 2: account anchored on the LANDLORD ENTITY (users.stripe_connect
// stays NULL). The pre-Stage-2 candidate scan looked only at `users` and would
// strand this landlord's rent. Returns the founding user id.
async function seedEntityAnchoredLandlord(account = 'acct_entity_ll'): Promise<string> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    await c.query(
      `UPDATE landlords
          SET stripe_connect_account_id = $2,
              connect_payouts_enabled   = true,
              connect_details_submitted = true
        WHERE id = $1`,
      [landlordId, account]
    )
    await c.query('COMMIT')
    return userId
  } catch (e) {
    await c.query('ROLLBACK'); throw e
  } finally {
    c.release()
  }
}

describe('shouldRunToday — Tuesday gate (D1)', () => {
  it('is TRUE on Tuesday', () => {
    expect(shouldRunToday(TUESDAY)).toBe(true)
  })
  it('is FALSE on every other weekday', () => {
    expect(shouldRunToday(MONDAY)).toBe(false)
    expect(shouldRunToday(WEDNESDAY)).toBe(false)
    expect(shouldRunToday(FRIDAY)).toBe(false)
  })
  it('is FALSE on the weekend', () => {
    expect(shouldRunToday(SATURDAY)).toBe(false)
    expect(shouldRunToday(SUNDAY)).toBe(false)
  })
})

describe('processAutoPayouts — Phase 2 platform-holds merge', () => {
  it('does nothing on a non-payout day (no reconcile, no payout)', async () => {
    await seedConnectReadyLandlord()
    const res = await processAutoPayouts(WEDNESDAY)
    expect(res.candidatesScanned).toBe(0)
    expect(res.payoutsFired).toBe(0)
    expect(reconcileMock).not.toHaveBeenCalled()
    expect(firePayoutMock).not.toHaveBeenCalled()
  })

  it('reconciles platform-held funds for a landlord user BEFORE firing the payout', async () => {
    const userId = await seedConnectReadyLandlord('acct_ll_1')
    const res = await processAutoPayouts(TUESDAY)

    expect(res.candidatesScanned).toBe(1)
    expect(res.payoutsFired).toBe(1)

    // The reconcile (platform → Connect) ran for this landlord user...
    expect(reconcileMock).toHaveBeenCalledWith(userId)
    // ...and the payout (Connect → bank) fired against their account...
    expect(firePayoutMock).toHaveBeenCalledTimes(1)
    // ...in that order (transfer the owed funds, THEN sweep them out).
    expect(reconcileMock.mock.invocationCallOrder[0])
      .toBeLessThan(firePayoutMock.mock.invocationCallOrder[0])

    // A disbursement audit row was written for the fired payout.
    const disp = await db.query(
      `SELECT status, trigger_type FROM disbursements WHERE user_id = $1`,
      [userId]
    )
    expect(disp.rows).toHaveLength(1)
    expect(disp.rows[0]).toMatchObject({ status: 'processing', trigger_type: 'auto_friday' })
  })

  it('sweeps an ENTITY-anchored landlord (Stage 2: account on landlords, users NULL)', async () => {
    const userId = await seedEntityAnchoredLandlord('acct_entity_1')
    const res = await processAutoPayouts(TUESDAY)

    // The pre-Stage-2 scan (users-only) would have missed this entirely.
    expect(res.candidatesScanned).toBe(1)
    expect(res.payoutsFired).toBe(1)
    // Reconcile keyed by the founding user (it re-resolves the entity account
    // internally via COALESCE(entity, user)).
    expect(reconcileMock).toHaveBeenCalledWith(userId)
    // Payout fired against the ENTITY account, not a user account.
    expect(firePayoutMock).toHaveBeenCalledTimes(1)
    expect((firePayoutMock.mock.calls as any[])[0][0]).toMatchObject({ connectAccountId: 'acct_entity_1' })
  })

  it('does NOT scan an entity landlord whose entity payouts are not yet enabled', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { landlordId } = await seedLandlord(c)
      // Entity account present but readiness flags still false (KYC incomplete).
      await c.query(
        `UPDATE landlords SET stripe_connect_account_id='acct_entity_pending' WHERE id=$1`,
        [landlordId])
      await c.query('COMMIT')
    } finally { c.release() }
    const res = await processAutoPayouts(TUESDAY)
    expect(res.candidatesScanned).toBe(0)
    expect(firePayoutMock).not.toHaveBeenCalled()
  })

  it('still fires the payout when the landlord is owed nothing to reconcile', async () => {
    // Reconcile no-ops (owed 0), but the account may still hold a prior
    // balance — the sweep must not be gated on reconcile moving money.
    reconcileMock.mockResolvedValueOnce({
      attempted: false, payments_settled: 0, transfer_id: null, amount: 0,
    })
    const userId = await seedConnectReadyLandlord('acct_ll_2')
    const res = await processAutoPayouts(TUESDAY)
    expect(reconcileMock).toHaveBeenCalledWith(userId)
    expect(res.payoutsFired).toBe(1)
  })
})

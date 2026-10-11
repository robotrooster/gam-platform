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
  // 10/5: the run moves held rent per Stripe ACCOUNT, never per login.
  reconcilePlatformHeldForAccount: reconcileMock,
  // S617: this was missing, so every single test in this file threw inside
  // processAutoPayouts' recovery step and dumped a stack into the run. The
  // engine catches it (recovery is best-effort and must never block a payout),
  // so the tests still passed — which is exactly why it survived: real errors
  // would have been lost in the same noise.
  recoverPendingPlatformTransfers: vi.fn(async () => ({
    scanned: 0, recovered: 0, stillPending: 0,
  })),
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
import { shouldRunToday, processAutoPayouts, nextPayoutDateUtc, isMonthEndSweepDay } from './autoPayouts'
import { stampPayoutTransfers } from '../services/payoutComposition'

// Phoenix is UTC-7 year-round (no DST). Noon at -07:00 pins the calendar day.
const phx = (isoDate: string) => new Date(`${isoDate}T12:00:00-07:00`)
// July 2026 reference days (verified): 27th=Mon, 28th=Tue, 29th=Wed,
// 31st=Fri, Aug 1=Sat, Aug 2=Sun.
const TUESDAY   = phx('2026-07-28')
const THURSDAY  = phx('2026-07-30')
const MONDAY    = phx('2026-07-27')
// S641: was 2026-07-29, which is JULY'S MONTH-END SWEEP DAY — two business days
// before Friday the 31st. It stopped being a non-payout day the moment the sweep
// existed, and the test caught it. Mid-month Wednesday instead.
const WEDNESDAY = phx('2026-07-22')
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
          SET gam_debit_payment_method_id = 'pm_test_bank',
              stripe_connect_account_id = $2,
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

// S617: the cron fires at 01:00 UTC, which is 6pm PHOENIX THE DAY BEFORE.
// Every fixture above is noon Phoenix — the same calendar day in both frames —
// so those tests would stay green even if the real firing instant landed on the
// wrong day. These pin the instant production actually uses.
const atUtc = (isoDate: string, hour = 1) =>
  new Date(`${isoDate}T${String(hour).padStart(2, '0')}:00:00Z`)

describe('shouldRunToday at the real 01:00 UTC firing instant (S617)', () => {
  // 10/5 (Nic): money LANDS Tuesday (and Friday through the 10th). The cron
  // fires at 01:00 UTC on the landing day, which is 6pm PHOENIX THE DAY BEFORE.
  it('is TRUE at 01:00 UTC on Tuesday — 6pm Phoenix Monday', () => {
    const t = atUtc('2026-07-28')
    expect(t.toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' })).toBe('2026-07-27')
    expect(shouldRunToday(t)).toBe(true)
  })

  it('is FALSE at 01:00 UTC on the other weekdays late in the month', () => {
    expect(shouldRunToday(atUtc('2026-07-27'))).toBe(false)
    expect(shouldRunToday(atUtc('2026-07-30'))).toBe(false)   // Thursday — no longer the day
    expect(shouldRunToday(atUtc('2026-07-31'))).toBe(false)   // Friday after the 10th
  })

  it('is FALSE at 01:00 UTC on the weekend', () => {
    expect(shouldRunToday(atUtc('2026-08-01'))).toBe(false)
    expect(shouldRunToday(atUtc('2026-08-02'))).toBe(false)
  })
})

// ── 10/5 (Nic): TUESDAY AND FRIDAY THROUGH THE 10TH, THEN TUESDAYS ──────────
describe('the payout days', () => {
  it('October 2026: Fri 2, Tue 6, Fri 9, then Tuesdays only', () => {
    const runs = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
      .filter(d => shouldRunToday(atUtc(d)))
    expect(runs).toEqual(['2026-10-02', '2026-10-06', '2026-10-09', '2026-10-13', '2026-10-20', '2026-10-27'])
  })

  it('a Friday after the 10th is not a payout day; the 10th itself is', () => {
    expect(shouldRunToday(atUtc('2027-09-10'))).toBe(true)    // Friday the 10th
    expect(shouldRunToday(atUtc('2026-09-11'))).toBe(false)   // Friday the 11th
  })

  it('a payout day on a federal holiday moves to the next business day', () => {
    // Veterans Day 2025 is Tuesday Nov 11 → Wednesday Nov 12.
    expect(shouldRunToday(atUtc('2025-11-11'))).toBe(false)
    expect(shouldRunToday(atUtc('2025-11-12'))).toBe(true)
    // Independence Day 2025 is Friday Jul 4 (inside the 1st–10th) → Monday Jul 7.
    expect(shouldRunToday(atUtc('2025-07-04'))).toBe(false)
    expect(shouldRunToday(atUtc('2025-07-07'))).toBe(true)
  })

  it('a holiday that is not a payout day changes nothing', () => {
    // Labor Day 2026 is Monday Sep 7; Tuesday Sep 8 is still the day.
    expect(shouldRunToday(atUtc('2026-09-08'))).toBe(true)
  })
})

// ── S640: THE DASHBOARD'S DATE COMES FROM HERE ─────────────────────────────
//
// The card derived its own and was wrong three times: Friday while the engine
// fired Tuesday, then Tuesday while the run moved to Thursday — telling Nic
// "Sep 15" when the job would not fire until Sep 17. One schedule, one owner.
describe('nextPayoutDateUtc', () => {
  it('is always a day the engine would actually fire on', () => {
    const d = nextPayoutDateUtc()
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // S641: the month-end sweep is a payout day too. Near a month's end the
    // next date a landlord sees is the sweep, not the weekly run — this
    // failed on 2026-09-24 because the answer was the 28th, which was right.
    const inst = new Date(d + 'T01:00:00Z')
    expect(shouldRunToday(inst) || isMonthEndSweepDay(inst)).toBe(true)
  })

  it('is in the future, never today already-past', () => {
    const now = new Date()
    expect(new Date(nextPayoutDateUtc(now) + 'T01:00:00Z').getTime()).toBeGreaterThan(now.getTime())
  })

  it('lands on a payout day from any starting point in the week', () => {
    for (let i = 0; i < 9; i++) {
      const from = new Date(Date.UTC(2026, 6, 27 + i, 15, 0, 0))
      const inst = new Date(nextPayoutDateUtc(from) + 'T01:00:00Z')
      // S641: the next payout is not always the WEEKLY one — the month-end
      // sweep is a payout day too, and near the end of a month it is the next
      // one a landlord will see.
      expect(shouldRunToday(inst) || isMonthEndSweepDay(inst)).toBe(true)
    }
  })

  // The engine shifts off a federal holiday; a date derived beside it would not.
  it('agrees with the engine through a holiday week', () => {
    const from = new Date(Date.UTC(2026, 8, 5, 15, 0, 0))   // Labor Day week
    const inst = new Date(nextPayoutDateUtc(from) + 'T01:00:00Z')
    expect(shouldRunToday(inst) || isMonthEndSweepDay(inst)).toBe(true)
  })
})

describe('shouldRunToday — late in the month only Tuesday (10/5)', () => {
  it('is TRUE on Tuesday', () => {
    expect(shouldRunToday(TUESDAY)).toBe(true)
  })
  it('is FALSE on every other weekday', () => {
    expect(shouldRunToday(MONDAY)).toBe(false)
    expect(shouldRunToday(WEDNESDAY)).toBe(false)
    expect(shouldRunToday(THURSDAY)).toBe(false)
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

    // The reconcile (platform → Connect) ran for this Stripe ACCOUNT...
    expect(reconcileMock).toHaveBeenCalledWith('acct_ll_1')
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
    // 10/5: reconcile keyed by the account itself.
    expect(reconcileMock).toHaveBeenCalledWith('acct_entity_1')
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
        // S652: a payout goes to a bank GAM can also debit — the fixture has one on file.
        `UPDATE landlords SET stripe_connect_account_id='acct_entity_pending', gam_debit_payment_method_id='pm_test_bank' WHERE id=$1`,
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
    await seedConnectReadyLandlord('acct_ll_2')
    const res = await processAutoPayouts(TUESDAY)
    expect(reconcileMock).toHaveBeenCalledWith('acct_ll_2')
    expect(res.payoutsFired).toBe(1)
  })
})

describe('processAutoPayouts — a transfer that landed late (S652)', () => {
  // Mountain View's Sep 16 batch could not transfer that week; the retry landed
  // it Sep 19 and it sat in the Stripe balance waiting a whole extra week.
  async function lateTransfer(userId: string, landedHoursAfter: number) {
    const ll = await db.query(
      `SELECT l.id, COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS acct
         FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.user_id=$1`, [userId])
    await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
          stripe_transfer_id, created_at, transferred_at)
       VALUES ($1,$2,$4,4154.89,4154.89,'transferred','tr_late', NOW() - interval '3 days',
               NOW() - interval '3 days' + ($3 || ' hours')::interval)`,
      [ll.rows[0].id, userId, String(landedHoursAfter), ll.rows[0].acct])
  }

  it('pays it out on the next weekday run, even off the weekly day', async () => {
    const userId = await seedConnectReadyLandlord('acct_late')
    await lateTransfer(userId, 60)                       // landed 2½ days after its batch
    const res = await processAutoPayouts(WEDNESDAY)      // not a payout day
    expect(res.payoutsFired).toBe(1)
    const d = await db.query(`SELECT trigger_type FROM disbursements WHERE user_id=$1`, [userId])
    expect(d.rows).toEqual([{ trigger_type: 'catch_up' }])
  })

  it('does not then skip the regular weekly payout that follows', async () => {
    const userId = await seedConnectReadyLandlord('acct_late2')
    await lateTransfer(userId, 60)
    await processAutoPayouts(WEDNESDAY)                  // catch-up
    const res = await processAutoPayouts(TUESDAY)       // the weekly day, a day later
    expect(res.skippedAlreadyPaidThisWeek).toBe(0)
    expect(res.payoutsFired).toBe(1)
  })

  it('pays out only once — the catch-up does not repeat', async () => {
    const userId = await seedConnectReadyLandlord('acct_late3')
    await lateTransfer(userId, 60)
    await processAutoPayouts(WEDNESDAY)
    firePayoutMock.mockClear()
    const again = await processAutoPayouts(WEDNESDAY)
    expect(again.candidatesScanned).toBe(0)
    expect(firePayoutMock).not.toHaveBeenCalled()
  })

  it('an on-time transfer (same run as its batch) is left for the weekly day', async () => {
    const userId = await seedConnectReadyLandlord('acct_ontime')
    await lateTransfer(userId, 0)
    const res = await processAutoPayouts(WEDNESDAY)
    expect(res.candidatesScanned).toBe(0)
  })
})

// S655 (Nic): "$2,638.11 from GAM" — which payments? A payout now records the
// transfers it swept off the landlord's Stripe balance, so the bank row and the
// Payouts page can list every payment inside it.
describe('a payout records what it carried', () => {
  it('links the transfers that landed on the account before it to the payout row', async () => {
    const userId = await seedConnectReadyLandlord('acct_carry')
    const ll = (await db.query(`SELECT id FROM landlords WHERE user_id=$1`, [userId])).rows[0].id
    const intent = (await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
          stripe_transfer_id, transferred_at)
       VALUES ($1,$2,'acct_carry',100,100,'transferred','tr_carry', NOW() - interval '1 day') RETURNING id`,
      [ll, userId])).rows[0].id
    getBalanceMock.mockResolvedValue(100)

    const res = await processAutoPayouts(TUESDAY)
    expect(res.payoutsFired).toBe(1)
    const d = (await db.query(`SELECT id FROM disbursements WHERE user_id=$1`, [userId])).rows[0]
    const linked = (await db.query(`SELECT disbursement_id FROM platform_transfer_intents WHERE id=$1`, [intent])).rows[0]
    expect(linked.disbursement_id).toBe(d.id)
    // Fully traced — no gap notice.
    expect(adminNotifyMock.mock.calls.filter((c: any) => c[0]?.category === 'payout_composition_gap')).toHaveLength(0)
  })

  // S655 review: a GAM sweep carries every transfer waiting before it, and the
  // next sweep starts where this one's row says it ended. Both have to be the
  // same cut (services/payoutCut.ts): a transfer confirmed between the payout
  // leaving and its row being written was otherwise too late for this payout
  // and too early for the next — listed in none, for good.
  it('a transfer that lands after the payout left waits for the next payout, and the next payout carries it', async () => {
    const userId = await seedConnectReadyLandlord('acct_after')
    const ll = (await db.query(`SELECT id FROM landlords WHERE user_id=$1`, [userId])).rows[0].id
    const before = (await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
          stripe_transfer_id, transferred_at)
       VALUES ($1,$2,'acct_after',100,100,'transferred','tr_before', NOW() - interval '1 day') RETURNING id`,
      [ll, userId])).rows[0].id
    getBalanceMock.mockResolvedValue(100)
    // Stripe answers; then, before the run gets a connection to write the
    // payout's row, a transfer to the account is confirmed. Holding every
    // pooled connection is what makes the run wait there.
    let landed: Promise<void> = Promise.resolve()
    let answeredAt = new Date()
    firePayoutMock.mockImplementationOnce(async () => {
      const max = (db as any).options.max as number
      const held: any[] = []
      while (db.totalCount < max || db.idleCount > 0) held.push(await db.connect())
      landed = new Promise<void>((resolve, reject) => setTimeout(async () => {
        try {
          await held[0].query(
            `INSERT INTO platform_transfer_intents
               (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
                stripe_transfer_id, transferred_at)
             VALUES ($1,$2,'acct_after',40,40,'transferred','tr_after', clock_timestamp())`, [ll, userId])
          resolve()
        } catch (e) { reject(e) } finally { for (const c of held) c.release() }
      }, 100))
      answeredAt = new Date()
      return { id: 'po_after' } as any
    })

    await processAutoPayouts(TUESDAY)
    await landed

    const d = (await db.query(`SELECT id FROM disbursements WHERE stripe_payout_id='po_after'`)).rows[0]
    const link = async (ref: string) => (await db.query(
      `SELECT disbursement_id FROM platform_transfer_intents WHERE stripe_transfer_id=$1`, [ref])).rows[0].disbursement_id
    expect((await db.query(`SELECT disbursement_id FROM platform_transfer_intents WHERE id=$1`, [before])).rows[0].disbursement_id).toBe(d.id)
    // It really did land after Stripe answered, and before the payout's row was written.
    const t = (await db.query(
      `SELECT (i.transferred_at > $2::timestamptz) AS after_payout, (i.transferred_at < d.created_at) AS before_row
         FROM platform_transfer_intents i, disbursements d
        WHERE i.stripe_transfer_id = 'tr_after' AND d.id = $1`, [d.id, answeredAt])).rows[0]
    expect(t).toEqual({ after_payout: true, before_row: true })
    expect(await link('tr_after')).toBeNull()

    // The following week's sweep carries it.
    const next = (await db.query(
      `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
       VALUES ($1,'auto_friday',40,'processing','po_next',NOW(),0) RETURNING id`, [userId])).rows[0].id
    const r = await stampPayoutTransfers({
      disbursementId: next, connectAccountId: 'acct_after', payoutAmount: 40, payoutAt: new Date(),
    })
    expect(await link('tr_after')).toBe(next)
    expect(r.residual).toBe(0)
  })

  it('claims the row the Connect webhook filed first, instead of writing a second one', async () => {
    const userId = await seedConnectReadyLandlord('acct_race')
    firePayoutMock.mockResolvedValue({ id: 'po_race' } as any)
    await db.query(
      // (dated back so the engine's own spacing rule does not skip the run —
      // in production this row can only appear after the payout fires)
      `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged, notes, created_at)
       VALUES ($1,'stripe_dashboard',100,'processing','po_race',NOW(),0,'Paid out from the Stripe dashboard; recorded by GAM from Stripe.',
               NOW() - interval '10 days')`,
      [userId])
    await processAutoPayouts(TUESDAY)
    const rows = (await db.query(`SELECT trigger_type, notes FROM disbursements WHERE stripe_payout_id='po_race'`)).rows
    expect(rows).toEqual([{ trigger_type: 'auto_friday', notes: null }])
  })

  // The webhook dates its row by Stripe's clock. Claimed, the row takes the
  // run's own cut — or a Stripe clock running ahead would make the next sweep
  // start after a transfer this sweep did not carry.
  it('a payout the webhook filed first is claimed onto the run’s own cut, so the next sweep starts where this one ended', async () => {
    const userId = await seedConnectReadyLandlord('acct_clock')
    firePayoutMock.mockResolvedValue({ id: 'po_clock' } as any)
    await db.query(
      `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged, notes, created_at)
       VALUES ($1,'stripe_dashboard',100,'processing','po_clock',NOW() + interval '1 minute',0,
               'Paid out from the Stripe dashboard; recorded by GAM from Stripe.', NOW() - interval '10 days')`,
      [userId])
    const ranAt = new Date()
    await processAutoPayouts(TUESDAY)
    const claimed = (await db.query(
      `SELECT id, (initiated_at <= NOW()) AS on_our_clock, (initiated_at >= $1::timestamptz) AS after_start
         FROM disbursements WHERE stripe_payout_id='po_clock'`, [ranAt])).rows[0]
    expect(claimed).toMatchObject({ on_our_clock: true, after_start: true })

    // A transfer confirmed just after the payout: not this sweep's, the next one's.
    const ll = (await db.query(`SELECT id FROM landlords WHERE user_id=$1`, [userId])).rows[0].id
    await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
          stripe_transfer_id, transferred_at)
       VALUES ($1,$2,'acct_clock',25,25,'transferred','tr_clock', clock_timestamp())`, [ll, userId])
    const next = (await db.query(
      `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
       VALUES ($1,'auto_friday',25,'processing','po_clock_next',NOW() + interval '2 minutes',0) RETURNING id`, [userId])).rows[0].id
    await stampPayoutTransfers({
      disbursementId: next, connectAccountId: 'acct_clock', payoutAmount: 25,
      payoutAt: new Date(Date.now() + 120_000),
    })
    expect((await db.query(`SELECT disbursement_id FROM platform_transfer_intents WHERE stripe_transfer_id='tr_clock'`))
      .rows[0].disbursement_id).toBe(next)
  })
})

// S655 review: a GAM sweep pays out the balance it READ. Its cut used to be the
// moment Stripe answered, after the read — so a transfer confirmed between the
// read and the answer was listed in a payout whose amount did not include it,
// and the next payout showed the same money as "not traced". The cut is now
// taken just before the read, and the row and the sweep both use it.
describe('the payout’s cut comes before its balance is read', () => {
  it('a transfer confirmed after the balance was read is carried by the next payout, not this one', async () => {
    const userId = await seedConnectReadyLandlord('acct_read')
    const ll = (await db.query(`SELECT id FROM landlords WHERE user_id=$1`, [userId])).rows[0].id
    const before = (await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
          stripe_transfer_id, transferred_at)
       VALUES ($1,$2,'acct_read',100,100,'transferred','tr_read_before', NOW() - interval '1 day') RETURNING id`,
      [ll, userId])).rows[0].id
    // (Each step a few milliseconds apart, so the order is visible at the
    // millisecond a payout's cut is kept to.)
    const pause = () => new Promise(r => setTimeout(r, 5))
    let readAt: Date | null = null
    getBalanceMock.mockImplementationOnce(async () => {
      await pause()
      readAt = (await db.query(`SELECT clock_timestamp() AS at`)).rows[0].at
      await pause()
      return 100
    })
    // After the read and before Stripe answers, a transfer lands on the account.
    firePayoutMock.mockImplementationOnce(async () => {
      await pause()
      await db.query(
        `INSERT INTO platform_transfer_intents
           (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
            stripe_transfer_id, transferred_at)
         VALUES ($1,$2,'acct_read',30,30,'transferred','tr_read_mid', clock_timestamp())`, [ll, userId])
      await pause()
      return { id: 'po_read' } as any
    })

    await processAutoPayouts(TUESDAY)

    const d = (await db.query(
      `SELECT id, initiated_at <= $1::timestamptz AS cut_before_read FROM disbursements WHERE stripe_payout_id='po_read'`,
      [readAt])).rows[0]
    expect(d.cut_before_read).toBe(true)
    const link = async (ref: string) => (await db.query(
      `SELECT disbursement_id FROM platform_transfer_intents WHERE stripe_transfer_id=$1`, [ref])).rows[0].disbursement_id
    expect((await db.query(`SELECT disbursement_id FROM platform_transfer_intents WHERE id=$1`, [before])).rows[0].disbursement_id).toBe(d.id)
    expect(await link('tr_read_mid')).toBeNull()

    // The following sweep carries it, and ties out.
    const nextAt = (await db.query(`SELECT clock_timestamp() AS at`)).rows[0].at
    const next = (await db.query(
      `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
       VALUES ($1,'auto_friday',30,'processing','po_read_next',$2,0) RETURNING id`, [userId, nextAt])).rows[0].id
    const r = await stampPayoutTransfers({
      disbursementId: next, connectAccountId: 'acct_read', payoutAmount: 30, payoutAt: nextAt,
    })
    expect(await link('tr_read_mid')).toBe(next)
    expect(r.residual).toBe(0)
  })
})

// S655 review: disbursements.stripe_payout_id was not unique, and the Connect
// webhook and the payout run each looked first, then inserted — interleaved,
// one payout got two rows (the second traced to nothing and raised a gap
// notice). The payout run now files with ON CONFLICT on a unique index.
describe('one payout, one row', () => {
  async function untilSomeoneWaitsOnALock() {
    for (let i = 0; i < 200; i++) {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)
      if (r.rows[0].n > 0) return
      await new Promise(res => setTimeout(res, 25))
    }
    throw new Error('nothing ever waited on the lock')
  }

  it('the webhook filing the payout mid-run is claimed, not doubled', async () => {
    const userId = await seedConnectReadyLandlord('acct_race2')
    firePayoutMock.mockResolvedValue({ id: 'po_race2' } as any)
    const webhook = await db.connect()
    let run: Promise<any>
    try {
      await webhook.query('BEGIN')
      await webhook.query(
        `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged, notes)
         VALUES ($1,'stripe_dashboard',100,'processing','po_race2',NOW(),0,'Paid out from the Stripe dashboard; recorded by GAM from Stripe.')`,
        [userId])
      run = processAutoPayouts(TUESDAY)
      run.catch(() => {})
      await untilSomeoneWaitsOnALock()          // the run's insert, waiting on the webhook's
      await webhook.query('COMMIT')
    } finally { webhook.release() }
    const res = await run!
    expect(res.payoutsFired).toBe(1)
    const rows = (await db.query(`SELECT trigger_type, notes FROM disbursements WHERE stripe_payout_id='po_race2'`)).rows
    expect(rows).toEqual([{ trigger_type: 'auto_friday', notes: null }])
  })

  it('a payout GAM already filed is never written a second time', async () => {
    const userId = await seedConnectReadyLandlord('acct_once')
    firePayoutMock.mockResolvedValue({ id: 'po_once' } as any)
    await db.query(
      // dated back so the engine's spacing rule does not skip the run
      `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged, created_at)
       VALUES ($1,'catch_up',100,'settled','po_once',NOW() - interval '10 days',0,NOW() - interval '10 days')`,
      [userId])
    await processAutoPayouts(TUESDAY)
    const rows = (await db.query(`SELECT trigger_type, status FROM disbursements WHERE stripe_payout_id='po_once'`)).rows
    expect(rows).toEqual([{ trigger_type: 'catch_up', status: 'settled' }])
  })
})

// 10/3 (Nic's admin cards): the payout record says what GAM kept back for the
// fees the landlord owed it. Mountain View's 9/21 payout owed $495 and sent
// $413; the $82 September platform fee taken out of it could only be inferred.
describe('a payout record says what GAM kept back', () => {
  it('stores the GAM fees kept out of a payout, and $0 when nothing was', async () => {
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { ({ landlordId, userId } = await seedLandlord(c)) } finally { c.release() }
    const intent = async (gross: number, netted: number, sent: number) => (await db.query<{ kept: string }>(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, netted_amount, status)
       VALUES ($1, $2, 'acct_kept', $3, $4, $5, 'transferred') RETURNING gam_fees_kept_amount::text AS kept`,
      [landlordId, userId, sent, gross, netted])).rows[0].kept
    expect(await intent(495, 0, 413)).toBe('82.00')            // the September platform fee
    expect(await intent(600, 50, 520)).toBe('30.00')           // a returned payment taken back is not GAM's fee
    expect(await intent(589, 0, 589)).toBe('0.00')
  })
})

// ── 10/5 (Nic): PER STRIPE ACCOUNT, NEVER PER LOGIN ─────────────────────────
//   "It's not per property. It's not per company. It's per connect account...
//    A login sits outside of the portfolio. It is a window to view things."
describe('processAutoPayouts — one payout per Stripe account', () => {
  async function secondCompany(userId: string, account: string) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO landlords (user_id, billing_starts_at, stripe_connect_account_id, connect_payouts_enabled,
                              connect_details_submitted, gam_debit_payment_method_id)
       VALUES ($1, DATE '2000-01-01', $2, true, true, 'pm_test_bank') RETURNING id`, [userId, account])
    return r.rows[0].id
  }

  it('one login with two companies on two accounts: both are paid in the same run', async () => {
    firePayoutMock.mockImplementation((async (a: any) => ({ id: `po_${a.connectAccountId}` })) as any)
    const userId = await seedEntityAnchoredLandlord('acct_mountain_view')
    await secondCompany(userId, 'acct_oak_park')
    const res = await processAutoPayouts(TUESDAY)
    expect(res.candidatesScanned).toBe(2)
    expect(res.payoutsFired).toBe(2)
    expect(res.skippedAlreadyPaidThisWeek).toBe(0)
    const paid = (firePayoutMock.mock.calls as any[]).map(c => c[0].connectAccountId).sort()
    expect(paid).toEqual(['acct_mountain_view', 'acct_oak_park'])
    const rows = await db.query(`SELECT stripe_account_id FROM disbursements ORDER BY stripe_account_id`)
    expect(rows.rows.map((r: any) => r.stripe_account_id)).toEqual(['acct_mountain_view', 'acct_oak_park'])
  })

  // A company has at most one account (landlords_stripe_connect_account_id_uniq);
  // two companies share one only through an older account kept on the login
  // itself, which both fall back to.
  it('two companies paying into ONE account: one payout', async () => {
    const userId = await seedConnectReadyLandlord('acct_shared')
    await db.query(`INSERT INTO landlords (user_id, billing_starts_at) VALUES ($1, DATE '2000-01-01')`, [userId])
    const res = await processAutoPayouts(TUESDAY)
    expect(res.candidatesScanned).toBe(1)
    expect(res.payoutsFired).toBe(1)
    expect(reconcileMock).toHaveBeenCalledWith('acct_shared')
  })

  it('a recent payout to one account never holds back the other', async () => {
    firePayoutMock.mockImplementation((async (a: any) => ({ id: `po_${a.connectAccountId}` })) as any)
    const userId = await seedEntityAnchoredLandlord('acct_a')
    await secondCompany(userId, 'acct_b')
    await db.query(
      `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, fee_charged, stripe_account_id, created_at)
       VALUES ($1, 'auto_friday', 50, 'settled', 'po_earlier', 0, 'acct_a', NOW() - interval '1 day')`, [userId])
    const res = await processAutoPayouts(TUESDAY)
    expect(res.skippedAlreadyPaidThisWeek).toBe(1)
    expect((firePayoutMock.mock.calls as any[]).map(c => c[0].connectAccountId)).toEqual(['acct_b'])
  })
})

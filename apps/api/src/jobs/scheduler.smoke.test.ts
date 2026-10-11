/**
 * Scheduler init smoke test.
 *
 * Mocks node-cron so no real timers register, then calls schedulerInit()
 * and asserts the expected number of cron.schedule() invocations land.
 * The point is to catch breakage in scheduler.ts itself (import errors,
 * top-level throws, accidental schedule deletions) — not to assert
 * specific cron expressions, since those rotate as the product evolves.
 *
 * `refreshTimezoneCrons()` runs immediately at init and queries the
 * DB; against the empty test DB it returns { added: [], removed: [] }
 * cleanly. Engines registered via timezoneCronManager don't call
 * cron.schedule until a property timezone activates, so they don't
 * contribute to the count here — only the direct cron.schedule(...)
 * calls in schedulerInit do.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.mock is hoisted above any top-level statements, so the spy has
// to live inside vi.hoisted() to be visible to the mock factory.
// scheduler.ts uses `import cron from 'node-cron'` (default);
// timezoneCronManager.ts uses `import * as cron from 'node-cron'`
// (namespace). Providing both default + named schedule keeps both
// import styles wired to the same spy.
const { scheduleSpy } = vi.hoisted(() => {
  const spy = vi.fn(
    (_expr: string, _handler: () => unknown, _opts?: unknown) => ({
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
    })
  )
  return { scheduleSpy: spy }
})

vi.mock('node-cron', () => ({
  default:  { schedule: scheduleSpy },
  schedule: scheduleSpy,
}))

// Step 9 review (fix pass 2): the hourly move-out balance charge finisher.
const { finishSpy } = vi.hoisted(() => ({
  finishSpy: vi.fn(async () => ({ checked: 0, outcomes: { moving: 0, let_go: 0, unfinished: 0, not_ours: 0 }, errors: [] })),
}))
vi.mock('../services/depositReturn', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  finishPendingGapCharges: finishSpy,
}))

// decisions.md #48.4: the five-minute release of card holds nobody confirmed.
const { releaseSpy } = vi.hoisted(() => ({
  releaseSpy: vi.fn(async () => ({ checked: 0, released: 0, errors: 0 })),
}))
vi.mock('./paymentReconcile', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  releaseUnconfirmedCardCharges: releaseSpy,
}))

// Fix pass (rev8, decisions #47a): the 15-minute sweep of deposit refunds left sending.
const { resumeStaleSpy } = vi.hoisted(() => ({
  resumeStaleSpy: vi.fn(async (_limit?: number) => 0),
}))
vi.mock('../services/depositRefundSend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resumeStaleDepositRefunds: resumeStaleSpy,
}))

// 10/5 (Nic): the weeknight payout cron tops up the platform fee FIRST, so the
// payout right after nets it.
const { nightOrder, topUpSpy, payoutSpy, payoutSyncSpy } = vi.hoisted(() => {
  const nightOrder: string[] = []
  return {
    nightOrder,
    topUpSpy: vi.fn(async () => {
      nightOrder.push('top-up')
      return { monthScanned: '2026-10-01', monthNotYetBilled: false, graceEndedByMoney: 0, propertiesRaised: 0,
               propertiesCreated: 0, amountCharged: 0, tenantPayerSkipped: [], errors: [] }
    }),
    payoutSpy: vi.fn(async () => {
      nightOrder.push('payouts')
      return { candidatesScanned: 0, errors: [] }
    }),
    payoutSyncSpy: vi.fn(async () => ({ created: 0, updated: 0 })),
  }
})
vi.mock('./platformFeeAccrual', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  processPlatformFeeTopUp: topUpSpy,
}))
vi.mock('./autoPayouts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  processAutoPayouts: payoutSpy,
}))
vi.mock('../services/connectPayoutSync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncConnectPayouts: payoutSyncSpy,
}))

// Quiet the per-request DB chatter the init path doesn't care about.
import { schedulerInit } from './scheduler'
import { getStripe } from '../lib/stripe'

beforeEach(() => {
  scheduleSpy.mockClear()
})

describe('schedulerInit (smoke)', () => {
  it('runs to completion + registers the expected pool of cron.schedule calls', () => {
    // 31 cron.schedule(...) calls live directly in schedulerInit
    // (counted via grep at S285 authoring time). The exact number
    // can drift as crons get added/removed; the floor of 25 is the
    // load-bearing assertion — anything below that means a meaningful
    // cron block silently dropped.
    expect(() => schedulerInit()).not.toThrow()
    expect(scheduleSpy.mock.calls.length).toBeGreaterThanOrEqual(25)

    // Every registered schedule must have a string expression as
    // the first arg (defense against a "schedule(undefined, fn)"
    // regression).
    for (const call of scheduleSpy.mock.calls) {
      expect(typeof call[0]).toBe('string')
      expect(call[0].length).toBeGreaterThan(0)
    }
  })
})

describe('schedulerInit: the move-out balance charge finisher', () => {
  it('runs every hour and finishes saved move-out balance charges', async () => {
    schedulerInit()
    const hourly = scheduleSpy.mock.calls.filter((c) => c[0] === '35 * * * *')
    expect(hourly).toHaveLength(1)
    finishSpy.mockClear()
    await (hourly[0][1] as () => Promise<void>)()
    expect(finishSpy).toHaveBeenCalledTimes(1)
  })
})

describe('schedulerInit: card payments nobody confirmed (decisions.md #48.4)', () => {
  const sweepOf = () => scheduleSpy.mock.calls.filter((c) => c[0] === '2-59/5 * * * *')

  it('a card hold past its 30 minutes is released every five minutes, without anyone opening the bill', async () => {
    schedulerInit()
    expect(sweepOf()).toHaveLength(1)
    releaseSpy.mockClear()
    await (sweepOf()[0][1] as () => Promise<void>)()
    expect(releaseSpy).toHaveBeenCalledTimes(1)
    // Stripe is handed over lazily — built only when a hold is due.
    expect(releaseSpy).toHaveBeenCalledWith(getStripe)
  })

  it('a run still going when the next is due is not started twice', async () => {
    schedulerInit()
    const run = sweepOf()[0][1] as () => Promise<void>
    releaseSpy.mockClear()
    let finish!: () => void
    releaseSpy.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ checked: 0, released: 0, errors: 0 }) }))
    const first = run()
    await run()
    expect(releaseSpy).toHaveBeenCalledTimes(1)
    finish()
    await first
    await run()
    expect(releaseSpy).toHaveBeenCalledTimes(2)
  })

  it('a failed run is logged and the next one still runs', async () => {
    schedulerInit()
    const run = sweepOf()[0][1] as () => Promise<void>
    releaseSpy.mockClear()
    releaseSpy.mockRejectedValueOnce(new Error('stripe down'))
    await expect(run()).resolves.toBeUndefined()
    await run()
    expect(releaseSpy).toHaveBeenCalledTimes(2)
  })
})

describe('schedulerInit: a deposit refund left sending goes out by itself (decisions #47a)', () => {
  const sweepOf = () => scheduleSpy.mock.calls.filter((c) => c[0] === '4-59/15 * * * *')

  it('every 15 minutes the stale-refund sweep runs, without anyone opening the move-out page', async () => {
    schedulerInit()
    expect(sweepOf()).toHaveLength(1)
    resumeStaleSpy.mockClear()
    await (sweepOf()[0][1] as () => Promise<void>)()
    expect(resumeStaleSpy).toHaveBeenCalledTimes(1)
  })

  it('a sweep still going when the next is due is not started twice, and a failed one never stops the next', async () => {
    schedulerInit()
    const run = sweepOf()[0][1] as () => Promise<void>
    resumeStaleSpy.mockClear()
    let finish!: () => void
    resumeStaleSpy.mockImplementationOnce(() => new Promise((r) => { finish = () => r(0) }))
    const first = run()
    await vi.waitFor(() => expect(resumeStaleSpy).toHaveBeenCalledTimes(1))
    await run()
    expect(resumeStaleSpy).toHaveBeenCalledTimes(1)
    finish()
    await first
    resumeStaleSpy.mockRejectedValueOnce(new Error('db down'))
    await expect(run()).resolves.toBeUndefined()
    await run()
    expect(resumeStaleSpy).toHaveBeenCalledTimes(3)
  })
})

describe('schedulerInit: the weeknight payout run tops up the platform fee first (10/5)', () => {
  const nightOf = () => scheduleSpy.mock.calls.filter((c) => c[0] === '0 1 * * 1-5')

  it('bills spaces occupied since the 1st BEFORE the payouts, so tonight\'s payout nets them', async () => {
    schedulerInit()
    expect(nightOf()).toHaveLength(1)
    expect(nightOf()[0][2]).toEqual({ timezone: 'UTC' })
    nightOrder.length = 0
    await (nightOf()[0][1] as () => Promise<void>)()
    expect(nightOrder).toEqual(['top-up', 'payouts'])
  })

  it('a failed top-up is logged and never stops the payouts', async () => {
    schedulerInit()
    nightOrder.length = 0
    topUpSpy.mockRejectedValueOnce(new Error('db down'))
    await expect((nightOf()[0][1] as () => Promise<void>)()).resolves.toBeUndefined()
    expect(nightOrder).toEqual(['payouts'])
  })
})

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

// Quiet the per-request DB chatter the init path doesn't care about.
import { schedulerInit } from './scheduler'

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

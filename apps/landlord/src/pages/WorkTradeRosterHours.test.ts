/**
 * 10/19 (review) — THE ROSTER ROW AND THE WORK-TRADE WINDOW READ ONE RULE.
 *
 * Whether a trade is counting hours is `hoursCountedFor` on the server
 * (apps/api services/workTradeStanding), and it deliberately reads
 * `status IN ('paused','ended')`: the landlord's end-by-hand path writes
 * 'ended' BEFORE it settles, and migration 20261021150000 deliberately keeps
 * the space answer through paused -> ended so a season nobody counted is never
 * billed on the way out. GET /work-trade/:id therefore answers target 0 for an
 * agreement ended straight out of an empty-space pause, and the window prints
 * "0 hrs of 0 hrs" and "Bill covered 100%".
 *
 * The roster's hours cell only looked at 'paused', so that SAME agreement
 * printed its full stored target on the row — "0.0 / 80 hrs" beside a window
 * that asks for nothing. One agreement, two screens, two targets, and the row
 * is what a landlord reads first. These pin the row's copy of the rule against
 * the server's, case for case.
 */
import { describe, it, expect } from 'vitest'
import { countsHours } from './WorkTradePage'

describe('the roster reads the same hours rule as the window', () => {
  it('a running trade counts hours', () => {
    expect(countsHours({ status: 'active', tracksHours: true, pausedSpaceOccupied: null })).toBe(true)
  })

  it('a trade nobody clocks never counts hours, whatever its status', () => {
    for (const status of ['active', 'paused', 'ended']) {
      expect(countsHours({ status, tracksHours: false })).toBe(false)
    }
  })

  it('paused with the space empty: no hours counted', () => {
    expect(countsHours({ status: 'paused', tracksHours: true, pausedSpaceOccupied: false })).toBe(false)
  })

  it('paused with the space still used, or unanswered: hours keep counting', () => {
    expect(countsHours({ status: 'paused', tracksHours: true, pausedSpaceOccupied: true })).toBe(true)
    expect(countsHours({ status: 'paused', tracksHours: true, pausedSpaceOccupied: null })).toBe(true)
  })

  // The case the row used to get wrong: ENDED straight out of an empty-space
  // pause. The answer is kept through paused -> ended by design, and the server
  // reads it, so the row must too.
  it('ENDED straight out of an empty-space pause: no hours counted, same as the window', () => {
    expect(countsHours({ status: 'ended', tracksHours: true, pausedSpaceOccupied: false })).toBe(false)
  })

  it('an ordinary ended trade still shows its target — the answer is the thing that waives it', () => {
    expect(countsHours({ status: 'ended', tracksHours: true, pausedSpaceOccupied: null })).toBe(true)
    expect(countsHours({ status: 'ended', tracksHours: true, pausedSpaceOccupied: true })).toBe(true)
  })

  // An agreement row loaded before migration 20261021150000 carries no answer
  // at all, which reads as the space still being used — the same default the
  // server's SQL applies (COALESCE(..., 'true')).
  it('a row with no answer on it at all counts hours', () => {
    expect(countsHours({ status: 'paused', tracksHours: true })).toBe(true)
  })
})

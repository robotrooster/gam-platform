/**
 * GAM's cut of a finished marketplace job — the one arithmetic.
 *
 * Tested here rather than beside either screen because the contractor's screen
 * lives in apps/business, which has no test harness at all, and this is the
 * number both a landlord and a contractor are shown before they commit.
 */
import { describe, it, expect } from 'vitest'
import { marketplaceCutSplit, MARKETPLACE_CUT_PERCENT_TODAY } from './index'

describe('the split', () => {
  it('takes 3% and leaves the rest', () => {
    expect(marketplaceCutSplit(4000, 3)).toEqual({ cut: 120, contractorNet: 3880 })
  })

  it('always adds back to the job', () => {
    for (const amount of [0.01, 1, 33.33, 99.99, 1000, 4600, 12345.67, 999999.99]) {
      for (const pct of [0, 1.5, 3, 5, 8.25, 100]) {
        const { cut, contractorNet } = marketplaceCutSplit(amount, pct)
        expect(Math.round((cut + contractorNet) * 100) / 100).toBe(amount)
      }
    }
  })

  it('rounds the cut to the cent, not to a fraction of one', () => {
    // 3% of 33.33 is 0.9999 — a fraction of a cent GAM cannot charge.
    expect(marketplaceCutSplit(33.33, 3).cut).toBe(1)
    expect(marketplaceCutSplit(33.33, 3).contractorNet).toBe(32.33)
  })

  it('a zero-dollar job earns nothing and owes nothing', () => {
    expect(marketplaceCutSplit(0, 3)).toEqual({ cut: 0, contractorNet: 0 })
  })

  it('a zero rate is a free job, not an error', () => {
    // A zero rate can only come from a price card that says zero. "No card at
    // all" is refused upstream by requireMarketplaceCutPercent and never
    // reaches here as a zero.
    expect(marketplaceCutSplit(4000, 0)).toEqual({ cut: 0, contractorNet: 4000 })
  })

  it('refuses to invent money from nonsense', () => {
    expect(marketplaceCutSplit(NaN, 3)).toEqual({ cut: 0, contractorNet: 0 })
    expect(marketplaceCutSplit(-100, 3)).toEqual({ cut: 0, contractorNet: 0 })
    expect(marketplaceCutSplit(4000, NaN)).toEqual({ cut: 0, contractorNet: 0 })
    expect(marketplaceCutSplit(4000, -3)).toEqual({ cut: 0, contractorNet: 0 })
  })

  it('the stated rate is 3, matching the first price card', () => {
    expect(MARKETPLACE_CUT_PERCENT_TODAY).toBe(3)
  })
})

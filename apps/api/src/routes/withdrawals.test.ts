import { describe, it, expect } from 'vitest'
import { instantFeeBreakdown } from './withdrawals'

// W-32 (S531): instant withdrawal fee — 2% of available, $5 minimum,
// ALL-IN (Nic-set). GAM's margin is the total minus Stripe's projected
// 1.5%/$0.50 cut; the payout fires for available − margin and Stripe's
// actual fee comes out of that payout. Invariant: the user never nets
// LESS than available − totalFee (rounding drift goes to the user).

describe('instantFeeBreakdown', () => {
  it('percentage region: $1,000 → $20 all-in, $5 GAM margin', () => {
    const b = instantFeeBreakdown(1000)
    expect(b.totalFee).toBe(20)
    expect(b.gamMargin).toBe(5)
    expect(b.payoutAmount).toBe(995)
    expect(b.stripeFee).toBe(14.93) // 1.5% of 995
    expect(b.net).toBe(980.07)
    expect(b.net).toBeGreaterThanOrEqual(1000 - b.totalFee)
  })

  it('$5 minimum region: $100 → $5 all-in', () => {
    const b = instantFeeBreakdown(100)
    expect(b.totalFee).toBe(5)
    expect(b.gamMargin).toBe(3.5) // 5 − 1.50 Stripe projection
    expect(b.payoutAmount).toBe(96.5)
    expect(b.net).toBeGreaterThanOrEqual(100 - 5)
  })

  it('small balance where Stripe hits ITS minimum: $20 → nets exactly $15', () => {
    const b = instantFeeBreakdown(20)
    expect(b.totalFee).toBe(5)
    expect(b.gamMargin).toBe(4.5) // 5 − $0.50 Stripe minimum
    expect(b.payoutAmount).toBe(15.5)
    expect(b.stripeFee).toBe(0.5)
    expect(b.net).toBe(15)
  })

  it('balance at the fee floor is ineligible: $5 → net 0', () => {
    const b = instantFeeBreakdown(5)
    expect(b.net).toBeLessThanOrEqual(0)
  })

  it('balance below the fee floor is ineligible: $4 → net negative', () => {
    const b = instantFeeBreakdown(4)
    expect(b.net).toBeLessThanOrEqual(0)
  })

  it('crossover point: 2% overtakes the $5 minimum at $250', () => {
    expect(instantFeeBreakdown(250).totalFee).toBe(5)
    expect(instantFeeBreakdown(251).totalFee).toBe(5.02)
  })

  it('user-favor invariant holds across a range', () => {
    for (const a of [6, 10, 25, 50, 99.99, 250, 333.33, 1234.56, 10000]) {
      const b = instantFeeBreakdown(a)
      if (b.net > 0) {
        expect(b.net).toBeGreaterThanOrEqual(Math.round((a - b.totalFee) * 100) / 100)
      }
    }
  })
})

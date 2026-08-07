import { describe, it, expect } from 'vitest'
import { instantFeeBreakdown } from './withdrawals'

// W-32 (S531): instant withdrawal fee — 2% of available, $5 minimum, ALL-IN
// (Nic-set). GAM's margin is the total minus Stripe's projected 1.5%/$0.50 cut.
// S580 model: the payout pays the landlord their NET (= available − all-in fee);
// GAM's margin is NOT pre-pulled — it's collected at the next disbursement. So
// `net` is now EXACTLY available − totalFee (the landlord's bank amount), and any
// Stripe-fee rounding residual stays on the balance and sweeps to the landlord.

describe('instantFeeBreakdown', () => {
  it('percentage region: $1,000 → $20 all-in, $5 GAM margin, net $980', () => {
    const b = instantFeeBreakdown(1000)
    expect(b.totalFee).toBe(20)
    expect(b.gamMargin).toBe(5)     // 20 − 15 Stripe projection (1.5% of 1000)
    expect(b.net).toBe(980)         // exactly available − totalFee
  })

  it('$5 minimum region: $100 → $5 all-in, $3.50 margin, net $95', () => {
    const b = instantFeeBreakdown(100)
    expect(b.totalFee).toBe(5)
    expect(b.gamMargin).toBe(3.5)   // 5 − 1.50 Stripe projection
    expect(b.net).toBe(95)
  })

  it('small balance where Stripe hits ITS minimum: $20 → $4.50 margin, net $15', () => {
    const b = instantFeeBreakdown(20)
    expect(b.totalFee).toBe(5)
    expect(b.gamMargin).toBe(4.5)   // 5 − $0.50 Stripe minimum
    expect(b.net).toBe(15)
  })

  it('balance at the fee floor is ineligible: $5 → net 0', () => {
    expect(instantFeeBreakdown(5).net).toBeLessThanOrEqual(0)
  })

  it('balance below the fee floor is ineligible: $4 → net negative', () => {
    expect(instantFeeBreakdown(4).net).toBeLessThanOrEqual(0)
  })

  it('crossover point: 2% overtakes the $5 minimum at $250', () => {
    expect(instantFeeBreakdown(250).totalFee).toBe(5)
    expect(instantFeeBreakdown(251).totalFee).toBe(5.02)
  })

  it('net always equals available − totalFee (landlord never nets less)', () => {
    for (const a of [6, 10, 25, 50, 99.99, 250, 333.33, 1234.56, 10000]) {
      const b = instantFeeBreakdown(a)
      if (b.net > 0) {
        expect(b.net).toBe(Math.round((a - b.totalFee) * 100) / 100)
      }
    }
  })
})

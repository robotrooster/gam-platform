/**
 * S640 — GAM's per-unit margin math.
 *
 * The old model reported EVERY unit as a loss: it subtracted Stripe's ACH cost
 * from the $2 platform fee and stopped, ignoring that GAM charges the payer $6
 * for that ACH. A $500 unit read -$2.02 a month when it earns +$4.53. Six
 * dollars a unit, in the direction of believing the business does not work.
 *
 * It also charged the $0.25 payout flat to every unit rather than sharing it
 * across the park one payout actually covers — fiftyfold on a fifty-unit park.
 */
import { describe, it, expect } from 'vitest'
import { calcNetPerUnit, calcStripePerUnit, STRIPE_CONFIG, FIXED_COST_PER_PROPERTY_MO } from './index'

describe('S640 per-unit economics', () => {
  it('uses the contracted 0.17% outbound rate, not the public list price', () => {
    expect(STRIPE_CONFIG.PAYOUT_RATE).toBe(0.0017)
  })

  it('counts the ACH fee GAM charges, not just the cost Stripe bills', () => {
    const e = calcNetPerUnit(500, 0, 'ach', 25)
    // $6 charged, 0.5% of $500 = $2.50 cost → $3.50 kept, plus the $2 unit fee,
    // less 0.17% outbound ($0.85) and this unit's share of the park's $3.
    expect(e.processingFee).toBe(6)
    expect(e.processingCost).toBeCloseTo(2.5, 2)
    expect(e.netBR).toBeCloseTo(4.53, 2)
  })

  it('shares the fixed cost across the park instead of billing every unit', () => {
    const small = calcStripePerUnit(500, 'ach', 5)
    const large = calcStripePerUnit(500, 'ach', 50)
    expect(small.fixedShare).toBeCloseTo(FIXED_COST_PER_PROPERTY_MO / 5, 4)
    expect(large.fixedShare).toBeCloseTo(FIXED_COST_PER_PROPERTY_MO / 50, 4)
    // The old code added the whole $0.25 flat to each unit; nothing should now.
    expect(large.fixedShare).toBeLessThan(0.25)
  })

  // Cash never touches Stripe — nothing is processed and nothing is paid out,
  // and GAM's manual fee is zero by directive. It costs nothing to serve.
  it('charges a cash-paying unit nothing but its share of the fixed cost', () => {
    const e = calcStripePerUnit(2000, 'manual', 25)
    expect(e.processingCost).toBe(0)
    expect(e.outbound).toBe(0)
    expect(e.total).toBeCloseTo(FIXED_COST_PER_PROPERTY_MO / 25, 4)
  })

  // The ACH fee is flat while the outbound cost scales, so there is a rent
  // above which an ACH-paying unit stops paying for itself. Card has no such
  // ceiling — its fee is a percentage too, and a bigger one.
  it('finds the ACH ceiling near $2,900 and no ceiling at all on card', () => {
    expect(calcNetPerUnit(2500, 0, 'ach', 25).netBR).toBeGreaterThan(0)
    expect(calcNetPerUnit(3500, 0, 'ach', 25).netBR).toBeLessThan(0)
    expect(calcNetPerUnit(2871, 0, 'ach', 25).netBR).toBeCloseTo(0, 1)

    const card1k = calcNetPerUnit(1000, 0, 'card', 25).netBR
    const card3k = calcNetPerUnit(3000, 0, 'card', 25).netBR
    expect(card3k).toBeGreaterThan(card1k)
    expect(calcNetPerUnit(10000, 0, 'card', 25).netBR).toBeGreaterThan(0)
  })

  it('never reports a loss on the portfolio GAM actually has', () => {
    for (const rent of [440, 460, 495, 589, 800]) {
      for (const m of ['ach', 'card', 'manual'] as const) {
        expect(calcNetPerUnit(rent, 0, m, 25).netBR).toBeGreaterThan(0)
      }
    }
  })
})

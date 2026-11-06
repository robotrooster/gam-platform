/**
 * The basis every job-financing fee is derived from.
 *
 * Tested because the fee table is generated from it, and a table nobody can
 * re-derive is a table nobody can check. 10/31 (Nic): "Two payments, four
 * payments, and six payments need to be accurately handled."
 */
import { describe, it, expect } from 'vitest'
import { financingCapitalMonths, financingFeeForReturn } from './index'

describe('dollar-months of GAM\'s capital', () => {
  it('comes out as a clean 1 : 3 : 5 across two, four and six payments', () => {
    const two = financingCapitalMonths(2)
    const four = financingCapitalMonths(4)
    const six = financingCapitalMonths(6)
    expect(two).toBeCloseTo(0.470, 3)
    expect(four).toBeCloseTo(1.410, 3)
    expect(six).toBeCloseTo(2.350, 3)
    expect(four / two).toBeCloseTo(3, 2)
    expect(six / two).toBeCloseTo(5, 2)
  })

  it('a longer plan always ties up more, never less', () => {
    let prev = 0
    for (const n of [2, 3, 4, 5, 6, 8, 12]) {
      const cm = financingCapitalMonths(n)
      expect(cm).toBeGreaterThan(prev)
      prev = cm
    }
  })

  it('a bigger marketplace cut leaves GAM less to front, so less capital out', () => {
    // GAM keeps its cut rather than paying it to the contractor, so a larger
    // cut means a smaller cheque on day one.
    expect(financingCapitalMonths(4, 10)).toBeLessThan(financingCapitalMonths(4, 3))
    expect(financingCapitalMonths(4, 0)).toBeGreaterThan(financingCapitalMonths(4, 3))
  })

  it('refuses nonsense rather than returning a number that looks real', () => {
    for (const n of [0, -1, NaN, Infinity]) expect(financingCapitalMonths(n)).toBe(0)
  })
})

describe('the fee for a target return', () => {
  it('prices all three plan lengths at the same return per dollar-month', () => {
    const job = 10000
    const target = 0.60
    const fees = [2, 4, 6].map(n => ({
      n, fee: financingFeeForReturn({ job, payments: n, annualReturn: target }),
    }))
    for (const { n, fee } of fees) {
      const dollarMonths = financingCapitalMonths(n) * job
      // Within the $5 rounding every bracket uses.
      expect(fee / dollarMonths * 12).toBeCloseTo(target, 2)
    }
    // And the escalation Nic described: 2 cheapest, 4 the middle, 6 way higher.
    expect(fees[0].fee).toBeLessThan(fees[1].fee)
    expect(fees[1].fee).toBeLessThan(fees[2].fee)
  })

  it('reproduces the figures the 60% option was quoted at', () => {
    const at = (n: number) => financingFeeForReturn({ job: 10000, payments: n, annualReturn: 0.60 })
    expect(at(2)).toBe(235)
    expect(at(4)).toBe(705)
    expect(at(6)).toBe(1175)
  })

  it('rounds to $5, as every bracket in the schedule does', () => {
    for (const job of [1000, 7300, 12500, 19999]) {
      for (const n of [2, 4, 6]) {
        expect(financingFeeForReturn({ job, payments: n, annualReturn: 0.6 }) % 5).toBe(0)
      }
    }
  })
})

// 10/27 (Nic) — WHAT GAM ACTUALLY PAYS WHEN A RESIDENT STOPS FUNDING.
//
//   "Any deposits we hold are absolutely going to the landlord. That is our
//    risk to take, and that is why we are making the money on the flex
//    deposit... The landlord gets what they're owed, full stop."
//
// And the mechanism he had to explain to me twice, because I had it backwards:
//
//   "If there's $1,000 deposit ... They split into two payments. They pay the
//    first 500 and they never pay the second 500 ... if the landlord decides
//    he's only going to keep $500 and refund the other $500 to the tenant,
//    even though that $500 doesn't exist ... the tenant never paid that other
//    $500, so they're not magically going to get $500 back that they never
//    paid in the first place. That $500 that's refunded is going to balance
//    against GAM's books and the shortfall."
//
// The resident's refund is computed against what is actually HELD, so the half
// they never funded never becomes a refund. GAM therefore pays only what the
// landlord's deductions reach PAST the money in custody — which is zero in his
// worked example, and that is the first test below.
//
// These are pure-function tests over moveOutMath. The money that moves on the
// back of `gamCovers` (the landlord's transfer, the negative revenue row) is
// exercised by the deposit-return suite.

import { describe, it, expect } from 'vitest'
import { moveOutMath } from './depositReturn'

/** His example, with the deposit and funding as the variables. */
const flex = (o: {
  deposit: number; funded: number; deductions: number; paidAhead?: number
}) => moveOutMath({
  carriedForward: false,
  // The pool is what was COLLECTED, never the face amount (S262).
  security: o.funded,
  boxes: 0, interest: 0,
  paidAhead: o.paidAhead ?? 0,
  deductions: o.deductions,
  unfundedDeposit: Math.max(0, o.deposit - o.funded),
})

describe("Nic's own example: $1,000 deposit, $500 funded", () => {
  it('costs GAM nothing when the landlord keeps $500', () => {
    const m = flex({ deposit: 1000, funded: 500, deductions: 500 })
    // The $500 in custody goes to the landlord. The "refund" of the other $500
    // never existed, so nobody is owed and nobody pays.
    expect(m.gamCovers).toBe(0)
    expect(m.refund).toBe(0)
    expect(m.gap).toBe(0)
  })

  it('costs GAM $500 when the landlord keeps the whole deposit', () => {
    const m = flex({ deposit: 1000, funded: 500, deductions: 1000 })
    expect(m.gamCovers).toBe(500)
    // And the resident is billed nothing for it — GAM ate it.
    expect(m.gap).toBe(0)
  })

  it('returns the resident their own money when the landlord keeps less than they funded', () => {
    const m = flex({ deposit: 1000, funded: 500, deductions: 300 })
    expect(m.gamCovers).toBe(0)
    expect(m.refund).toBe(200)
    expect(m.gap).toBe(0)
  })
})

describe('GAM covers its own risk, never the landlord\'s damage claim', () => {
  it('stops at the face deposit and leaves the excess as the resident\'s bill', () => {
    // $1,300 of damage on a $1,000 deposit that was funded $500.
    const m = flex({ deposit: 1000, funded: 500, deductions: 1300 })
    // GAM covers the $500 never funded...
    expect(m.gamCovers).toBe(500)
    // ...and the $300 beyond the whole deposit stays owed by the resident,
    // exactly as it would be for somebody who paid their deposit in full.
    expect(m.gap).toBe(300)
  })

  it('bills a fully-funded deposit exactly as before — nothing changed for them', () => {
    const m = flex({ deposit: 1000, funded: 1000, deductions: 1300 })
    expect(m.gamCovers).toBe(0)
    expect(m.gap).toBe(300)
  })

  it('is zero for an ordinary deposit, where no unfunded figure is passed at all', () => {
    const m = moveOutMath({
      carriedForward: false, security: 1000, boxes: 0, interest: 0,
      paidAhead: 0, deductions: 1300,
    })
    expect(m.gamCovers).toBe(0)
    expect(m.gap).toBe(300)
  })
})

describe('the resident\'s own money is spent before GAM\'s', () => {
  it('lets paid-ahead rent reduce what GAM has to find', () => {
    // $1,000 deposit funded $500, $1,000 of deductions, $200 paid ahead.
    // Order (#46.2): deposit side, then paid-ahead, then the gap.
    const m = flex({ deposit: 1000, funded: 500, deductions: 1000, paidAhead: 200 })
    expect(m.paidAheadUsed).toBe(200)
    // $500 reached past the custody money, $200 of it came from their own
    // prepaid rent, so GAM finds $300 rather than $500.
    expect(m.gamCovers).toBe(300)
    expect(m.gap).toBe(0)
  })

  it('leaves paid-ahead money alone when the custody balance covers everything', () => {
    const m = flex({ deposit: 1000, funded: 500, deductions: 400, paidAhead: 200 })
    expect(m.paidAheadUsed).toBe(0)
    expect(m.paidAheadLeft).toBe(200)
    expect(m.gamCovers).toBe(0)
    expect(m.refund).toBe(100)
  })
})

describe('a deposit carried to the next unit is not settled here', () => {
  it('never pays a shortfall on the lease the resident is leaving', () => {
    // GAM's exposure travels with the custody balance to the new tenancy and
    // falls due at the lease that actually ends. Paying now would pay twice.
    const m = moveOutMath({
      carriedForward: true, security: 500, boxes: 0, interest: 0,
      paidAhead: 0, deductions: 1000, unfundedDeposit: 500,
    })
    expect(m.gamCovers).toBe(0)
    expect(m.carried).toBe(0)
    // The deductions beyond the carried deposit stay a bill, as before.
    expect(m.gap).toBe(500)
  })
})

describe('invariants that must hold whatever the numbers are', () => {
  const grid = [0, 1, 250, 499.99, 500, 1000, 1300]
  it('never covers more than was left unfunded, and never more than the gap', () => {
    for (const deposit of grid) {
      for (const funded of grid) {
        if (funded > deposit) continue
        for (const deductions of grid) {
          for (const paidAhead of [0, 100]) {
            const m = flex({ deposit, funded, deductions, paidAhead })
            const unfunded = deposit - funded
            expect(m.gamCovers).toBeGreaterThanOrEqual(0)
            expect(m.gamCovers).toBeLessThanOrEqual(round(unfunded))
            // Every dollar the deductions reached past the available money is
            // either GAM's or the resident's — never both, never neither.
            const reached = Math.max(0, round(deductions - funded - Math.min(paidAhead, Math.max(0, deductions - funded))))
            expect(round(m.gamCovers + m.gap)).toBe(reached)
          }
        }
      }
    }
  })

  it('never both refunds the resident and bills GAM', () => {
    for (const deposit of grid) {
      for (const funded of grid) {
        if (funded > deposit) continue
        for (const deductions of grid) {
          const m = flex({ deposit, funded, deductions })
          // A surplus means the deductions did not reach the custody money, so
          // there is nothing for GAM to make good. They are mutually exclusive.
          if (m.refund > 0) expect(m.gamCovers).toBe(0)
          if (m.gamCovers > 0) expect(m.refund).toBe(0)
        }
      }
    }
  })
})

const round = (n: number) => Math.round(n * 100) / 100

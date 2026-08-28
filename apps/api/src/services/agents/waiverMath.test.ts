/**
 * S626 — the grace-period arithmetic on a late-fee waiver request.
 *
 * Nic's note: "the grace period already gave them 5 days, so they're not 2 days
 * late, they're 7." profiles.ts has said so since S624 and the agent recited fee
 * policy instead on every run, so the numbers are computed rather than hoped for.
 */
import { describe, it, expect } from 'vitest'
import { __waiverInternals } from './agentRunner'

const { WAIVER_REQUEST, claimedDaysLate, graceDaysFromResults, waiverArithmeticLine } = __waiverInternals

describe('recognising a waiver request', () => {
  it.each([
    'any chance you can take that off? it was only two days late',
    'can you waive the late fee?',
    'is there any way to get that fee removed',
    'could you knock that off for me',
    'can you drop the late charge',
  ])('flags %j', (m) => expect(WAIVER_REQUEST.test(m)).toBe(true))

  it.each([
    'what is my late fee?',
    'when is my rent due?',
    'how much do I owe?',
  ])('leaves %j alone', (m) => expect(WAIVER_REQUEST.test(m)).toBe(false))
})

describe('the number they claimed', () => {
  it('reads it as a word — the phrasing from the review', () => {
    expect(claimedDaysLate('any chance you can take that off? it was only two days late')).toBe(2)
  })
  it('reads it as a digit', () => {
    expect(claimedDaysLate('I was 3 days late, can you waive it')).toBe(3)
  })
  it('reads "only 4 days"', () => {
    expect(claimedDaysLate('it was only 4 days')).toBe(4)
  })
  it('is null when they claimed nothing', () => {
    expect(claimedDaysLate('can you waive the late fee?')).toBeNull()
  })
})

describe('the grace period out of a lookup', () => {
  it('finds it nested in a real-shaped lease result', () => {
    expect(graceDaysFromResults([{ ok: true, lease: { lateFeeGraceDays: 5, rentAmount: '750' } }])).toBe(5)
  })
  it('accepts a numeric string', () => {
    expect(graceDaysFromResults([{ lease: { late_fee_grace_days: '3' } }])).toBe(3)
  })
  it('is null when no lookup carried one', () => {
    expect(graceDaysFromResults([{ ok: true, balance: '2330' }])).toBeNull()
  })
  it('does not confuse a zero-grace lease with a missing one', () => {
    // 0 is a real answer — live leases run 0, 3 and 5 — and must not be
    // treated as "unknown". The net declines to do arithmetic on it separately.
    expect(graceDaysFromResults([{ lease: { lateFeeGraceDays: 0 } }])).toBe(0)
  })
})

describe('the arithmetic itself', () => {
  it('two days claimed against a five-day grace is seven', () => {
    const grace = graceDaysFromResults([{ lease: { lateFeeGraceDays: 5 } }])!
    const claimed = claimedDaysLate('it was only two days late')!
    expect(grace + claimed).toBe(7)
  })
})

describe('the sentence written when the model will not write it (S628)', () => {
  // FOUR attempts at instructing it have failed: S624 put the rule in
  // profiles.ts, S626 rewrote the forcing net twice, and the S628 conversation
  // run caught it again with everything detected correctly — grace 5, claimed
  // 2, nudge fired — and the regenerated reply was one more recital of the fee
  // policy, which collapseRepetition then truncated mid-word. So the arithmetic
  // is computed and put in front of the reply instead of asked for a fifth
  // time, and what a tenant reads is pinned here like any other customer copy.
  it('answers the argument they actually made, with their own number in it', () => {
    const line = waiverArithmeticLine(5, 2)
    // The whole point: 7, not 2. Saying 2 back to them concedes the argument.
    expect(line).toContain('7 days past due')
    expect(line).toContain('rather than 2')
    expect(line).toContain('5-day grace period')
  })

  it('does not offer the waiver or hint the landlord might', () => {
    // Nic, standing: the waiver is the landlord's call and not ours to float.
    const line = waiverArithmeticLine(3, 4).toLowerCase()
    expect(line).toContain("landlord's call")
    expect(line).not.toMatch(/i can waive|i'll waive|they will probably|likely to waive/)
  })

  it('works for any grace period, including the zero-grace leases', () => {
    // Live leases run 0, 3 and 5 days. At zero there is no arithmetic to do and
    // the caller does not reach this — but the sentence must never claim a
    // grace period that does not exist.
    expect(waiverArithmeticLine(3, 1)).toContain('4 days past due')
  })
})

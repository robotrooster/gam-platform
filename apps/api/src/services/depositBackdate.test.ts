import { describe, it, expect } from 'vitest'
import { backdateLateFees, effectivePaidDateFor, type LateFeeTick } from './depositBackdate'

const tick = (d: string, amount = 5, settled = false): LateFeeTick =>
  ({ paymentId: `p-${d}`, tickDate: d, amount, settled })

describe('which date a confirmed deposit is paid on', () => {
  // The Friday-afternoon deposit that posts on Monday. Under bank-date-only the
  // tenant eats three days of late fees for being on time.
  it('a corroborated declaration earns the tenant their own date', () => {
    expect(effectivePaidDateFor('2026-09-04', '2026-09-07')).toBe('2026-09-04')
  })

  it('falls back to the bank when nobody declared', () => {
    expect(effectivePaidDateFor(null, '2026-09-07')).toBe('2026-09-07')
  })

  // A claim the bank contradicts is not evidence.
  it('never lets a declared date run ahead of the posting that proves it', () => {
    expect(effectivePaidDateFor('2026-09-20', '2026-09-07')).toBe('2026-09-07')
  })
})

describe('late fees against a backdated payment', () => {
  it('keeps what was earned and reverses what was not', () => {
    const out = backdateLateFees(
      [tick('2026-09-06'), tick('2026-09-07'), tick('2026-09-08')],
      '2026-09-06')
    expect(out.standingTicks.map(t => t.tickDate)).toEqual(['2026-09-06'])
    expect(out.reversedTicks.map(t => t.tickDate)).toEqual(['2026-09-07', '2026-09-08'])
    expect(out.unbillAmount).toBe(10)
    expect(out.refundAmount).toBe(0)
  })

  // GAM does not erase money that moved (standing retention rule) — a fee the
  // tenant already paid comes back as a credit, not as a deleted charge.
  it('separates unbilling from refunding, because they are different acts', () => {
    const out = backdateLateFees(
      [tick('2026-09-07', 5, true), tick('2026-09-08', 5, false)],
      '2026-09-06')
    expect(out.refundAmount).toBe(5)
    expect(out.unbillAmount).toBe(5)
  })

  it('reverses nothing when the rent was genuinely late throughout', () => {
    const out = backdateLateFees(
      [tick('2026-09-06'), tick('2026-09-07')],
      '2026-09-19')
    expect(out.reversedTicks).toEqual([])
    expect(out.unbillAmount).toBe(0)
    expect(out.standingTicks).toHaveLength(2)
  })

  it('a tick on the payment date itself stands — the rent was late that morning', () => {
    const out = backdateLateFees([tick('2026-09-06')], '2026-09-06')
    expect(out.standingTicks).toHaveLength(1)
    expect(out.unbillAmount).toBe(0)
  })
})

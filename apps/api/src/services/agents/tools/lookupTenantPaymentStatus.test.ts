/**
 * S624 — a landlord's question must not be searched as if it were a name.
 *
 * "what's chen's balance?" reached the tool as tenant="what's chen" and was
 * searched literally, so the landlord was asked to narrow a question that was
 * never ambiguous. The reply gave away that nothing was reading it like a person.
 */
import { describe, it, expect } from 'vitest'
import { cleanNeedle } from './lookupTenantPaymentStatus'

describe('cleaning a name out of a question', () => {
  it('handles the case from the review', () => {
    expect(cleanNeedle("what's chen's balance")).toBe('chen')
  })

  it('strips the ways landlords actually ask', () => {
    const cases: Array<[string, string]> = [
      ["what's chen's balance?", 'chen'],
      ['what is frank williams rent', 'frank williams'],
      ["how's alice doing on payments", 'alice'],
      ['show me bob chen', 'bob chen'],
      ['look up carol vasquez account', 'carol vasquez'],
      ["who's behind — dan okafor", 'dan okafor'],
      ['the tenant in apt 101', 'tenant in apt 101'],
    ]
    for (const [raw, want] of cases) {
      expect(cleanNeedle(raw).toLowerCase(), raw).toBe(want)
    }
  })

  // The trim only removes recognised filler from the ends, so a real name
  // always survives — that is what makes it safe to apply to every lookup.
  it('never eats a real name', () => {
    for (const n of ['Chen', 'Bob Chen', "O'Neill", 'Grace Littlefeather',
                     'RV 04', 'Apt 101', '101', 'Whatley', 'Howe', 'Duesouth']) {
      expect(cleanNeedle(n)).toBe(n)
    }
  })

  it('leaves an already-clean value alone', () => {
    expect(cleanNeedle('frank@tenant.dev')).toBe('frank@tenant.dev')
    expect(cleanNeedle('  Bob Chen  ')).toBe('Bob Chen')
  })

  it('survives junk', () => {
    expect(cleanNeedle(null)).toBe('')
    expect(cleanNeedle(undefined)).toBe('')
    expect(cleanNeedle("what's")).toBe('')
  })
})

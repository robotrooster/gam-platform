/**
 * S613: formatUnitNumber must be IDEMPOTENT — formatting an already-formatted
 * number has to leave it alone.
 *
 * Every stored unit number is canonical (POST /units canonicalises on create;
 * retire re-formats whatever you type), so "is this number already taken"
 * compares canonical against canonical. If a second pass could MOVE a number,
 * that comparison would depend on how many times each side had been through the
 * formatter — which is how a landlord could retire a unit into a number that is
 * already in use and be allowed to.
 *
 * Found via a flake that hit ~6% of full-suite runs: the unitRetire fixture
 * stored a RAW 'U-123456', which formats to 'U 123456' (hyphen becomes a
 * space), so the clash lookup missed and the retire succeeded where it should
 * have been refused. The fixture now canonicalises like production; this locks
 * the property that made the mismatch possible.
 */
import { describe, it, expect } from 'vitest'
import { formatUnitNumber } from './format'

describe('formatUnitNumber is idempotent (S613)', () => {
  const samples = [
    'U-123456', 'U-3f9a2b', 'RV-01', 'rv 12', 'apt101', '1a', '7', 'A-05',
    'MH 09', 'house 1', 'B2', '1A-05', 'U-000123', 'RV 37', 'Apt 204',
  ]
  for (const s of samples) {
    it(`"${s}" is stable once formatted`, () => {
      const once = formatUnitNumber(s)
      expect(formatUnitNumber(once)).toBe(once)
    })
  }

  // The two shapes behind the flake, named so the next person sees why they
  // differ: one only changes case (which the clash check ignores), the other
  // changes a character (which it does not).
  it('an all-digit suffix moves the hyphen to a space — the case that broke', () => {
    expect(formatUnitNumber('U-123456')).toBe('U 123456')
    expect(formatUnitNumber('U-3f9a2b')).toBe('U-3F9A2B')
  })
})

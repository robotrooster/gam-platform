/**
 * S550 — street-number address safety (pure helper).
 *
 * Property names repeat ("Oak Park" travels) and every park has an
 * "RV 01" — the street number on the lease is the coincidence-proof
 * check. Conflict ONLY when both sides carry a number and they differ.
 */
import { describe, it, expect } from 'vitest'
import { streetNumbersConflict, pickCandidateByAddress } from './resolveIntent'

describe('streetNumbersConflict', () => {
  it('same street number → no conflict', () => {
    expect(streetNumbersConflict('22658 Highway 89 Yarnell AZ 85362', '22658 Highway 89')).toBe(false)
  })
  it('different street numbers → conflict (wrong Oak Park)', () => {
    expect(streetNumbersConflict('101 Desert Rose Ln', '22658 Highway 89')).toBe(true)
  })
  it('missing number on either side → no conflict (nothing to compare)', () => {
    expect(streetNumbersConflict('Highway 89 frontage', '22658 Highway 89')).toBe(false)
    expect(streetNumbersConflict('', '22658 Highway 89')).toBe(false)
    expect(streetNumbersConflict(null, '22658 Highway 89')).toBe(false)
    expect(streetNumbersConflict('22658 Highway 89', null)).toBe(false)
  })
})

describe('pickCandidateByAddress — two "Oak Park"s under one landlord', () => {
  const yarnell = { street1: '22658 Highway 89', name: 'Oak Park Yarnell' }
  const phoenix = { street1: '101 Desert Rose Ln', name: 'Oak Park Phoenix' }

  it('single candidate needs no address at all', () => {
    expect(pickCandidateByAddress([yarnell], null)).toBe(yarnell)
  })
  it('lease street number picks the right one of two', () => {
    expect(pickCandidateByAddress([yarnell, phoenix], '22658 Highway 89 Yarnell AZ 85362')).toBe(yarnell)
    expect(pickCandidateByAddress([yarnell, phoenix], '101 Desert Rose Ln, Phoenix AZ')).toBe(phoenix)
  })
  it('no usable address on the lease → ambiguous (never guess)', () => {
    expect(pickCandidateByAddress([yarnell, phoenix], 'Highway 89 frontage')).toBe('ambiguous')
    expect(pickCandidateByAddress([yarnell, phoenix], null)).toBe('ambiguous')
  })
  it('two candidates at the SAME street number → ambiguous', () => {
    const twin = { street1: '22658 Old Stage Rd', name: 'Oak Park Twin' }
    expect(pickCandidateByAddress([yarnell, twin], '22658 Highway 89')).toBe('ambiguous')
  })
})

/**
 * S639 (Nic): "the word RV is usually in the park name, and so it pulls up all
 * the mobile home spaces too... the search doesn't gate on a unit type. It gates
 * on the name of the unit, which also includes the property name."
 */
import { describe, it, expect } from 'vitest'
import { normalizeUnitKey, matchesUnitQuery } from './index'

describe('normalizeUnitKey', () => {
  it('reduces the written and the spoken form to the same key', () => {
    for (const v of ['MH 05', 'MH5', 'mh 5', 'mobile home 5', 'mobile home five', 'Mobile Home #5'])
      expect(normalizeUnitKey(v)).toBe('mh5')
  })
  it('does the same for RV spaces', () => {
    for (const v of ['RV 09', 'rv9', 'RV space 9', 'rv spot nine'])
      expect(normalizeUnitKey(v)).toBe('rv9')
  })
  it('is safe on nothing', () => {
    expect(normalizeUnitKey('')).toBe('')
    expect(normalizeUnitKey(null)).toBe('')
  })
})

describe('matchesUnitQuery', () => {
  it('finds the space however it was typed', () => {
    expect(matchesUnitQuery('mobile home 5', 'MH 05')).toBe(true)
    expect(matchesUnitQuery('mh5', 'MH 05')).toBe(true)
    expect(matchesUnitQuery('MH 5', 'MH 05')).toBe(true)
  })
  it('a bare type prefix lists that type', () => {
    expect(matchesUnitQuery('mh', 'MH 20')).toBe(true)
    expect(matchesUnitQuery('rv', 'RV 41')).toBe(true)
  })
  it('THE BUG: an RV search must not return mobile homes', () => {
    // "Mountain View RV Ranch" is not consulted, so the park name cannot leak in.
    expect(matchesUnitQuery('rv', 'MH 05')).toBe(false)
    expect(matchesUnitQuery('rv 25', 'MH 25')).toBe(false)
  })
  it('and a mobile home search must not return RV spots', () => {
    expect(matchesUnitQuery('mobile home 9', 'RV 09')).toBe(false)
  })
  it('an empty query matches everything', () => {
    expect(matchesUnitQuery('', 'MH 05')).toBe(true)
    expect(matchesUnitQuery('   ', 'RV 41')).toBe(true)
  })
  it('a unit with no number matches nothing typed', () => {
    expect(matchesUnitQuery('mh5', null)).toBe(false)
  })
})

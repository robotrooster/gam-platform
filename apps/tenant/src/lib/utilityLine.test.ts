/**
 * S655 money plan, Step 13 — decisions #17: a utility line names the utility,
 * never a generic "Utilities".
 */
import { describe, it, expect } from 'vitest'
import { utilityLine } from './utilityLine'

describe('a utility line on the tenant bill names the utility', () => {
  it('uses the server\'s own name when the row carries one', () => {
    expect(utilityLine({ type: 'utility', label: 'Water', notes: '1,240 gal' })).toEqual({ label: 'Water', detail: '1,240 gal' })
  })

  it('uses the utility bill\'s type when the row carries it', () => {
    expect(utilityLine({ type: 'utility', utilityType: 'electric', notes: null }).label).toBe('Electric')
    expect(utilityLine({ type: 'utility', utilityType: 'trash' }).label).toBe('Trash')
  })

  it('reads the utility from the line\'s own note when nothing else names it', () => {
    expect(utilityLine({ type: 'utility', notes: 'Water — meter 1200 → 1450' }).label).toBe('Water')
    expect(utilityLine({ type: 'utility', notes: 'Monthly trash pickup' }).label).toBe('Trash')
  })

  it('a note only about the payment never names the line', () => {
    expect(utilityLine({ type: 'utility', notes: 'Covered by work trade' }).label).toBe('Utility')
  })

  it('a note with no utility word names the line by itself', () => {
    expect(utilityLine({ type: 'utility', notes: 'Shared meter, back row' }).label).toBe('Shared meter, back row')
  })

  it('never says "Utilities" — not even when that is what it was handed', () => {
    for (const row of [{ type: 'utility' }, { type: 'utility', label: 'Utilities' }, { type: 'utility', notes: '' }]) {
      expect(utilityLine(row).label).not.toBe('Utilities')
    }
    expect(utilityLine({ type: 'utility' }).label).toBe('Utility')
  })

  it('a late fee is a late fee', () => {
    expect(utilityLine({ type: 'late_fee', notes: 'Late fee — October' })).toEqual({ label: 'Late fee', detail: 'Late fee — October' })
  })
})

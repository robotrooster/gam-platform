import { describe, it, expect } from 'vitest'
import { extractAttemptShape, normalizeClaimName } from './csvImportAttempts'

describe('extractAttemptShape', () => {
  it('captures original-case headers from first record', () => {
    const records = [
      { 'First Name': 'Jane', 'Last Name': 'Doe', 'Email': 'jane@x.com' },
      { 'First Name': 'Bob',  'Last Name': 'Smith', 'Email': 'bob@x.com' },
    ]
    const shape = extractAttemptShape(records)
    expect(shape.columnHeaders).toEqual(['First Name', 'Last Name', 'Email'])
  })

  it('returns first 5 rows as samples', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ name: `row${i}` }))
    const shape = extractAttemptShape(records)
    expect(shape.sampleRows).toHaveLength(5)
    expect(shape.sampleRows[0]).toEqual({ name: 'row0' })
    expect(shape.sampleRows[4]).toEqual({ name: 'row4' })
  })

  it('returns fewer than 5 when records are short', () => {
    const records = [{ a: 1 }, { a: 2 }]
    const shape = extractAttemptShape(records)
    expect(shape.sampleRows).toHaveLength(2)
  })

  it('returns empty arrays for empty input', () => {
    const shape = extractAttemptShape([])
    expect(shape.columnHeaders).toEqual([])
    expect(shape.sampleRows).toEqual([])
  })

  it('preserves header order from first record (source-column order)', () => {
    const records = [{ z: 1, a: 2, m: 3 }]
    const shape = extractAttemptShape(records)
    expect(shape.columnHeaders).toEqual(['z', 'a', 'm'])
  })
})

describe('normalizeClaimName', () => {
  it('lowercases input', () => {
    expect(normalizeClaimName('DoorLoop')).toBe('doorloop')
  })

  it('strips whitespace + punctuation + casing', () => {
    expect(normalizeClaimName('Door Loop')).toBe('doorloop')
    expect(normalizeClaimName('door-loop')).toBe('doorloop')
    expect(normalizeClaimName('Door_Loop')).toBe('doorloop')
    expect(normalizeClaimName('  Door  Loop  ')).toBe('doorloop')
  })

  it('all variants collapse to one normalized form', () => {
    const variants = ['DoorLoop', 'doorloop', 'Door Loop', 'door-loop', 'Door_Loop', 'DOORLOOP']
    const normalized = variants.map(normalizeClaimName)
    expect(new Set(normalized).size).toBe(1)
    expect(normalized[0]).toBe('doorloop')
  })

  it('returns empty string for empty / null / undefined / whitespace', () => {
    expect(normalizeClaimName('')).toBe('')
    expect(normalizeClaimName(null)).toBe('')
    expect(normalizeClaimName(undefined)).toBe('')
    expect(normalizeClaimName('   ')).toBe('')
    expect(normalizeClaimName('-_-')).toBe('')
  })

  it('preserves alphanumeric characters', () => {
    expect(normalizeClaimName('Rentmoji 2.0')).toBe('rentmoji20')
    expect(normalizeClaimName('123 Property')).toBe('123property')
  })
})

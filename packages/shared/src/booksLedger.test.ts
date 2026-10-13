import { describe, it, expect } from 'vitest'
import {
  booksDefaultHours, BOOKS_PAY_FREQUENCIES, socialSecurityWageBase,
  booksNormalBalance, booksCents,
} from './booksLedger'

describe('booksDefaultHours (10/11: one rule for the run and the preview)', () => {
  it('a full-time year spread over the pay periods', () => {
    expect(booksDefaultHours('weekly')).toBe(40)
    expect(booksDefaultHours('biweekly')).toBe(80)
    expect(booksDefaultHours('semimonthly')).toBe(86.67)
    expect(booksDefaultHours('monthly')).toBe(173.33)
  })
  it('every listed frequency has hours', () => {
    for (const f of BOOKS_PAY_FREQUENCIES) expect(booksDefaultHours(f)).toBeGreaterThan(0)
  })
})

describe('socialSecurityWageBase', () => {
  it('each known year has its own figure', () => {
    expect(socialSecurityWageBase(2024)).toBe(168600)
    expect(socialSecurityWageBase(2025)).toBe(176100)
    expect(socialSecurityWageBase(2026)).toBe(184500)
  })
  it('a year past the table uses the latest year known', () => {
    expect(socialSecurityWageBase(2027)).toBe(184500)
  })
})

describe('booksNormalBalance', () => {
  it('assets and expenses read as stored (debits minus credits)', () => {
    expect(booksNormalBalance('asset', 500)).toBe(500)
    expect(booksNormalBalance('expense', '120.50')).toBe(120.5)
  })
  it('liabilities, equity and income read flipped, so money owed and earned is positive', () => {
    expect(booksNormalBalance('liability', -300)).toBe(300)
    expect(booksNormalBalance('equity', '-1000.00')).toBe(1000)
    expect(booksNormalBalance('income', -75)).toBe(75)
  })
  it('never shows a negative zero', () => {
    expect(Object.is(booksNormalBalance('income', 0), 0)).toBe(true)
  })
})

describe('booksCents', () => {
  it('adds as integers', () => {
    expect(booksCents(0.1) + booksCents(0.2)).toBe(booksCents(0.3))
    expect(booksCents('19.99')).toBe(1999)
    expect(booksCents(undefined)).toBe(0)
  })
})

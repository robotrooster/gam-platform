/**
 * 10/17 (Nic): the names a sale's taxes carry must add up to the tax the
 * customer actually paid — a breakdown recovered later never re-prices a sale.
 */
import { describe, it, expect } from 'vitest'
import {
  scaleNamedTaxes, isNamedAgencyTax, BARE_ITEM_RATE_NAME, PLACEHOLDER_TAX_NAME,
  BOOKS_OTHER_INCOME_NO_TAX_NOTE, BOOKS_SALES_TIE_TERMS, BOOKS_SALES_TIE_TERM_LABEL,
  BOOKS_SALES_TIE_TERM_NOTE, BOOKS_SALES_TIE_TERM_SIGN, BOOKS_TAX_ROLES, BOOKS_TAX_ROLE_LABEL,
} from './booksSalesTax'

const sum = (parts: { amount: number }[]) => Math.round(parts.reduce((a, p) => a + p.amount, 0) * 100)

describe('scaleNamedTaxes', () => {
  it('leaves a single tax that already adds up alone — the propane sale of 9/29', () => {
    expect(scaleNamedTaxes([{ name: 'Transaction privilege tax', rate: 0.066, amount: 0.87 }], 0.87))
      .toEqual([{ name: 'Transaction privilege tax', rate: 0.066, amount: 0.87 }])
  })

  it('scales to the tax the sale charged, keeping each name in proportion', () => {
    const out = scaleNamedTaxes([
      { name: 'State', rate: 0.05, amount: 5 },
      { name: 'County', rate: 0.01, amount: 1 },
    ], 12)
    expect(out).toEqual([
      { name: 'State', rate: 0.05, amount: 10 },
      { name: 'County', rate: 0.01, amount: 2 },
    ])
  })

  it('puts the rounding cent on the largest, so the names always add up to the cent', () => {
    const out = scaleNamedTaxes([
      { name: 'A', rate: 0.02, amount: 1 },
      { name: 'B', rate: 0.02, amount: 1 },
      { name: 'C', rate: 0.02, amount: 1 },
    ], 0.1)
    expect(sum(out)).toBe(10)
    expect(out.map(p => p.amount).sort((a, b) => b - a)[0]).toBe(0.04)
  })

  it('names nothing when there is nothing to name, and nothing when no tax was charged', () => {
    expect(scaleNamedTaxes([], 0.87)).toEqual([])
    expect(scaleNamedTaxes([{ name: 'A', rate: 0.02, amount: 0 }], 0.87)).toEqual([])
    expect(scaleNamedTaxes([{ name: 'A', rate: 0.02, amount: 1 }], 0)).toEqual([])
  })
})

describe('the labels', () => {
  it('every bridge term and every tax account has words for the screen', () => {
    for (const t of BOOKS_SALES_TIE_TERMS) {
      expect(BOOKS_SALES_TIE_TERM_LABEL[t], t).toBeTruthy()
      expect(BOOKS_SALES_TIE_TERM_NOTE[t], t).toBeTruthy()
      expect([1, -1, 0], t).toContain(BOOKS_SALES_TIE_TERM_SIGN[t])
    }
    // The total is not a term of the bridge, so it carries no sign.
    expect(BOOKS_SALES_TIE_TERM_SIGN.posted).toBe(0)
    for (const r of BOOKS_TAX_ROLES) expect(BOOKS_TAX_ROLE_LABEL[r], r).toBeTruthy()
  })
})

describe('isNamedAgencyTax', () => {
  it('a real agency name with money on it passes', () => {
    expect(isNamedAgencyTax({ name: 'Transaction privilege tax', amount: 0.87 })).toBe(true)
    expect(isNamedAgencyTax({ name: 'Lodging tax', amount: 17.08 })).toBe(true)
  })

  it('refuses the two names that are nobody\'s agency, so neither is ever written onto a sale', () => {
    // A tax named "Tax" would get its own chart sub-account ("Sales tax
    // payable: Tax") and read on the breakdown as a line she could file.
    expect(isNamedAgencyTax({ name: PLACEHOLDER_TAX_NAME, amount: 0.87 })).toBe(false)
    expect(isNamedAgencyTax({ name: BARE_ITEM_RATE_NAME, amount: 0.87 })).toBe(false)
  })

  it('refuses a blank name and a name carrying no money', () => {
    expect(isNamedAgencyTax({ name: '', amount: 1 })).toBe(false)
    expect(isNamedAgencyTax({ name: '   ', amount: 1 })).toBe(false)
    expect(isNamedAgencyTax({ amount: 1 })).toBe(false)
    expect(isNamedAgencyTax({ name: 'Lodging tax', amount: 0 })).toBe(false)
    expect(isNamedAgencyTax({ name: 'Lodging tax' })).toBe(false)
  })
})

describe('the other-income words', () => {
  it('say plainly that a lump recorded no tax inside it', () => {
    expect(BOOKS_OTHER_INCOME_NO_TAX_NOTE).toMatch(/no tax was recorded/i)
    expect(BOOKS_OTHER_INCOME_NO_TAX_NOTE).toMatch(/not in the tax table/i)
  })
})

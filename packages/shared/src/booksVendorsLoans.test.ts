// 10/12 (Nic): vendors, loans and fixed assets — the lists and the arithmetic
// the API, the ledger and the Books pages share (booksVendorsLoans.ts).
import { describe, it, expect } from 'vitest'
import {
  BOOKS_VENDOR_TYPES, BOOKS_VENDOR_TYPE_LABEL, BOOKS_VENDOR_1099_TYPE, BOOKS_W9_TAX_CLASSIFICATIONS,
  BOOKS_W9_TAX_CLASSIFICATION_LABEL, BOOKS_LOAN_FUNDED_TO, BOOKS_LOAN_FUNDED_TO_LABEL, BOOKS_LOAN_PAYMENT_METHODS,
  BOOKS_LOAN_PAYMENT_METHOD_LABEL, BOOKS_LOAN_STATES, BOOKS_LOAN_STATE_LABEL, BOOKS_FIXED_ASSET_CLASSES,
  BOOKS_FIXED_ASSET_CLASS_LABEL, BOOKS_FIXED_ASSET_CLASS_ROLE, BOOKS_DEPRECIATION_METHODS, BOOKS_DEPRECIATION_METHOD_LABEL,
  BOOKS_TAX_ID_PATTERN, FORM_1099_NOT_REPORTED_PAYMENT_METHODS,
  form1099NecThreshold, loanPaymentSuggestion, fixedAssetLifeMonths, fixedAssetDepreciates, depreciationSchedule,
  depreciationThrough, depreciationBefore, taxIdLast4,
} from './booksVendorsLoans'
import { LEDGER_ACCOUNT_ROLES, LEDGER_SOURCE_TYPES, LEDGER_MAP_KINDS, LEDGER_CAPTURE_COLUMNS } from './booksLedger'
import * as shared from './index'

describe('the lists and their words', () => {
  it('every value has its plain words (never the raw value on screen)', () => {
    const pairs: [readonly string[], Record<string, string>][] = [
      [BOOKS_VENDOR_TYPES, BOOKS_VENDOR_TYPE_LABEL], [BOOKS_W9_TAX_CLASSIFICATIONS, BOOKS_W9_TAX_CLASSIFICATION_LABEL],
      [BOOKS_LOAN_FUNDED_TO, BOOKS_LOAN_FUNDED_TO_LABEL], [BOOKS_LOAN_PAYMENT_METHODS, BOOKS_LOAN_PAYMENT_METHOD_LABEL],
      [BOOKS_LOAN_STATES, BOOKS_LOAN_STATE_LABEL], [BOOKS_FIXED_ASSET_CLASSES, BOOKS_FIXED_ASSET_CLASS_LABEL],
      [BOOKS_DEPRECIATION_METHODS, BOOKS_DEPRECIATION_METHOD_LABEL],
    ]
    for (const [values, labels] of pairs) {
      expect(Object.keys(labels).sort()).toEqual([...values].sort())
      for (const v of values) expect(labels[v]).toMatch(/^[A-Z]/)
    }
  })

  it('Nic 10/12: one list with a type — contractor, utility, supplier, other — and only a contractor carries the 1099 box', () => {
    expect(BOOKS_VENDOR_TYPES).toEqual(['contractor', 'utility', 'supplier', 'other'])
    expect(BOOKS_VENDOR_1099_TYPE).toBe('contractor')
  })

  it('an asset class sits on a real posting role; loans and assets are ledger sources; a loan is a map kind', () => {
    for (const role of Object.values(BOOKS_FIXED_ASSET_CLASS_ROLE)) expect(LEDGER_ACCOUNT_ROLES).toContain(role)
    expect(LEDGER_ACCOUNT_ROLES).toContain('loan_escrow')
    for (const t of ['loan', 'loan_payment', 'fixed_asset']) expect(LEDGER_SOURCE_TYPES).toContain(t)
    expect(LEDGER_MAP_KINDS).toContain('loan')
    for (const t of ['books_loans', 'books_loan_payments', 'books_fixed_assets']) expect(LEDGER_CAPTURE_COLUMNS).toHaveProperty(t)
  })

  it('the index exports this file (and the names that moved out of booksLedger are still there)', () => {
    expect(shared.BOOKS_VENDOR_TYPES).toBe(BOOKS_VENDOR_TYPES)
    expect(shared.BOOKS_CONTRACTOR_TAX_CLASSIFICATIONS).toBe(BOOKS_W9_TAX_CLASSIFICATIONS)
    expect(shared.BOOKS_VENDOR_PAYMENT_TERMS).toContain('net30')
    expect(shared.BOOKS_CONTRACTOR_PAY_UNITS).toContain('hour')
    expect(typeof shared.form1099NecThreshold).toBe('function')
  })

  it('a taxpayer ID is an EIN or an SSN, shown by its last four only', () => {
    for (const ok of ['12-3456789', '123456789', '123-45-6789']) expect(BOOKS_TAX_ID_PATTERN.test(ok)).toBe(true)
    for (const bad of ['1234', '12-345678', 'abc-de-fghi']) expect(BOOKS_TAX_ID_PATTERN.test(bad)).toBe(false)
    expect(taxIdLast4('12-3456789')).toBe('6789')
    expect(taxIdLast4('')).toBeNull()
  })
})

describe('the 1099-NEC threshold by the year the money was paid', () => {
  it('$600 through 2025, $2,000 for 2026; a later year uses the latest known, an earlier one the first', () => {
    expect(form1099NecThreshold(2024)).toBe(600)
    expect(form1099NecThreshold(2025)).toBe(600)
    expect(form1099NecThreshold(2026)).toBe(2000)
    expect(form1099NecThreshold(2031)).toBe(2000)
    expect(form1099NecThreshold(2019)).toBe(600)
  })
  it('card payments are left out of what a 1099-NEC counts (the card company reports them)', () => {
    expect(FORM_1099_NOT_REPORTED_PAYMENT_METHODS).toEqual(['card'])
  })
})

describe('loanPaymentSuggestion — escrow, a month of interest on what is owed, the rest principal', () => {
  it('splits a regular payment, the parts adding up to the payment', () => {
    // $100,000 owed at 6% → $500.00 a month of interest; $1,200 with $200 escrow.
    const s = loanPaymentSuggestion({ balanceCents: 10_000_000, annualRatePct: 6, paymentCents: 120_000, escrowCents: 20_000 })
    expect(s).toEqual({ principalCents: 50_000, interestCents: 50_000, escrowCents: 20_000 })
  })
  it('a payment smaller than the escrow and interest pays no principal', () => {
    const s = loanPaymentSuggestion({ balanceCents: 10_000_000, annualRatePct: 6, paymentCents: 30_000, escrowCents: 20_000 })
    expect(s).toEqual({ principalCents: 0, interestCents: 10_000, escrowCents: 20_000 })
  })
  it('the escrow part never exceeds the payment; a rate given as text works; 0% is all principal', () => {
    expect(loanPaymentSuggestion({ balanceCents: 500_000, annualRatePct: '0', paymentCents: 10_000, escrowCents: 50_000 }))
      .toEqual({ principalCents: 0, interestCents: 0, escrowCents: 10_000 })
    expect(loanPaymentSuggestion({ balanceCents: 500_000, annualRatePct: 0, paymentCents: 10_000, escrowCents: 0 }))
      .toEqual({ principalCents: 10_000, interestCents: 0, escrowCents: 0 })
  })
})

describe('fixed assets — a life in whole months, straight line, the parts add up to the cent', () => {
  it('lives', () => {
    expect(fixedAssetLifeMonths(27.5)).toBe(330)
    expect(fixedAssetLifeMonths('39')).toBe(468)
    expect(fixedAssetLifeMonths(27.3)).toBeNull()
    expect(fixedAssetLifeMonths(0)).toBeNull()
    expect(fixedAssetLifeMonths(101)).toBeNull()
    expect(fixedAssetLifeMonths(null)).toBeNull()
    expect(fixedAssetDepreciates('land')).toBe(false)
    expect(fixedAssetDepreciates('building')).toBe(true)
  })

  it('a 27.5-year building costing $33,000: $100 a month, from the month it went into service, on each month\'s last day', () => {
    const s = depreciationSchedule({ costCents: 3_300_000, salvageCents: 0, inServiceDate: '2024-02-10', lifeMonths: 330 })
    expect(s).toHaveLength(330)
    expect(s[0]).toEqual({ month: '2024-02', endDay: '2024-02-29', cents: 10_000 })
    expect(s[329].month).toBe('2051-07')
    expect(s.every(m => m.cents === 10_000)).toBe(true)
  })

  it('an uneven amount: the extra cents go to the first months, and the whole life adds up to cost less salvage', () => {
    const s = depreciationSchedule({ costCents: 100_000, salvageCents: 1, inServiceDate: '2026-01-01', lifeMonths: 36 })
    expect(s.reduce((a, m) => a + m.cents, 0)).toBe(99_999)
    expect(s[0].cents).toBe(2_778)
    expect(s[35].cents).toBe(2_777)
    expect(depreciationThrough(s, '2026-03-31')).toBe(2_778 * 3)
    expect(depreciationBefore(s, '2026-03-31')).toBe(2_778 * 2)
  })

  it('depreciation already taken before the books start: the months before carry it exactly, the rest spreads what is left', () => {
    // $12,000, 10 years from January 2020; books start 2026-01-01 → 72 months before, 48 after.
    const s = depreciationSchedule({ costCents: 1_200_000, salvageCents: 0, inServiceDate: '2020-01-15', lifeMonths: 120,
      priorCents: 700_000, priorAsOf: '2026-01-01' })
    expect(depreciationBefore(s, '2026-01-01')).toBe(700_000)
    expect(s.filter(m => m.endDay >= '2026-01-01').reduce((a, m) => a + m.cents, 0)).toBe(500_000)
    expect(s.find(m => m.month === '2026-01')!.cents).toBe(10_417)
  })

  it('refuses what cannot be: more than cost less salvage, or taken before an asset was in service', () => {
    expect(() => depreciationSchedule({ costCents: 100_000, salvageCents: 0, inServiceDate: '2020-01-01', lifeMonths: 12,
      priorCents: 100_001, priorAsOf: '2026-01-01' })).toThrow(/more than the cost/)
    expect(() => depreciationSchedule({ costCents: 100_000, salvageCents: 0, inServiceDate: '2026-02-01', lifeMonths: 12,
      priorCents: 100, priorAsOf: '2026-01-01' })).toThrow(/after it/)
    expect(() => depreciationSchedule({ costCents: 100_000, salvageCents: 0, inServiceDate: '2020-01-01', lifeMonths: 12,
      priorCents: 50_000, priorAsOf: '2026-01-01' })).toThrow(/life ended/)
  })
})

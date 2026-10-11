/**
 * S652 (Nic): the landlord TYPES the sale terms on the installment contract;
 * what is typed is what bills. These read the boxes the way a person fills them.
 */
import { describe, it, expect } from 'vitest'
import { saleTermsFromFields, resolveTypedSaleTerms, monthFromTyped } from './homeSale'

const f = (o: Record<string, string | null>) => Object.entries(o).map(([lease_column, value]) => ({ lease_column, value }))

describe('typed sale terms', () => {
  it('reads "$19" for "100" payments as a flat plan worth $1,900', () => {
    const t = resolveTypedSaleTerms(saleTermsFromFields(f({ sale_monthly_payment: '$19.00', sale_term_months: '100', sale_first_payment_month: '10/1/2026' })))
    expect(t).toMatchObject({ planType: 'flat', salePrice: 1900, termMonths: 100, startMonth: '2026-10-01', annualInterestRate: 0, downPayment: 0 })
  })
  it('a price with a rate and a term is an amortized plan', () => {
    const t = resolveTypedSaleTerms(saleTermsFromFields(f({ sale_price: '12,000', sale_down_payment: '500', sale_interest_rate: '5%', sale_term_months: '48', sale_first_payment_month: 'November 2026' })))
    expect(t).toMatchObject({ planType: 'amortized', salePrice: 12000, downPayment: 500, annualInterestRate: 5, termMonths: 48, startMonth: '2026-11-01' })
  })
  it('refuses a contract with no number of payments, in plain words', () => {
    expect(() => resolveTypedSaleTerms(saleTermsFromFields(f({ sale_monthly_payment: '200' })))).toThrow(/number of payments/)
  })
  it('reads the month however it was typed', () => {
    for (const [typed, iso] of [['10/01/2026', '2026-10-01'], ['10/2026', '2026-10-01'], ['2026-10', '2026-10-01'], ['Oct 2026', '2026-10-01'], ['October 2026', '2026-10-01'], ['garbage', null]] as const) {
      expect(monthFromTyped(typed)).toBe(iso)
    }
  })
})

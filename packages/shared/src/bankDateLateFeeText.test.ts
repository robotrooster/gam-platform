/**
 * 10/6 (Nic, "Yes, build it"): the words both sides read when the bank's date
 * takes a late fee off — plain dates ("Oct 3"), never the stored ISO form.
 */
import { describe, it, expect } from 'vitest'
import {
  lateFeeOffBankDateTenantText, lateFeeOffBankDateLandlordText, BANK_DEPOSIT_REPORT_NOT_TAKEN,
  BANK_DEPOSIT_METHOD_NOT_TAKEN, TENANTS_DEPOSIT_AT_BANK_LABEL,
} from './index'

describe('the bank-date late-fee notices', () => {
  it('tells the tenant the fee came off and the day their payment counts from', () => {
    expect(lateFeeOffBankDateTenantText({ depositedOn: '2026-10-03', amount: 25 }))
      .toBe('The $25 late fee came off because the bank shows your deposit on Oct 3, before it was charged. Your payment counts from Oct 3.')
    expect(lateFeeOffBankDateTenantText({ depositedOn: '2026-10-03', amount: 30, count: 3, refunded: 10 }))
      .toBe('The $30 in late fees came off because the bank shows your deposit on Oct 3, before it was charged. '
        + 'Your payment counts from Oct 3. The $10 you had already paid is back as credit on your account.')
  })
  it('tells the landlord the same, with the amount', () => {
    expect(lateFeeOffBankDateLandlordText({ depositedOn: '2026-10-03', amount: 25 }))
      .toBe('$25.00 in late fees charged after Oct 3 came off — the bank shows the deposit that day, so the payment counts from then.')
  })
  it('the setting and its refusals are plain words', () => {
    expect(TENANTS_DEPOSIT_AT_BANK_LABEL).toBe('Tenants may deposit rent directly at the bank')
    expect(BANK_DEPOSIT_REPORT_NOT_TAKEN).not.toMatch(/_|tenants_deposit/)
    expect(BANK_DEPOSIT_METHOD_NOT_TAKEN).toContain('"Tenants may deposit rent directly at the bank"')
  })
})

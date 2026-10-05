import { describe, it, expect } from 'vitest'
import {
  CREDIT_USE_SOURCES, CREDIT_USE_SOURCE_LABEL, CREDIT_USE_STATUSES, CREDIT_USE_STATUS_LABEL,
  CREDIT_USE_RELEASE_REASONS, CREDIT_USE_RELEASE_REASON_LABEL, CREDIT_USE_HELD_RELEASE_REASONS,
  CREDIT_KINDS, CREDIT_KIND_LABEL, PREPAID_FUNDED_BY, PREPAID_FUNDED_BY_LABEL,
  INCOME_BASES, INCOME_BASIS_LABEL, INCOME_BASIS_NOTE, DEFAULT_INCOME_BASIS,
  INCOME_LINES, INCOME_LINE_LABEL, BILLED_PARTS, BILLED_PART_LABEL,
  INCOME_CATEGORIES, INCOME_CATEGORY_LABEL, INCOME_UTILITY_CATEGORIES,
  DEPOSIT_SLIP_STATUSES, DEPOSIT_SLIP_STATUS_LABEL, DEPOSIT_SLIP_SOURCES, DEPOSIT_SLIP_SOURCE_LABEL,
  BANK_MATCH_KINDS, BANK_MATCH_KIND_LABEL, RENT_CHANNEL_PAYERS, isRentChannelPayer,
  FLEXPAY_TERMS, FLEXPAY_FORBIDDEN_PULL_DAYS, FLEXPAY_PULL_RETRY_DAYS, FLEXPAY_PULL_MAX_RETRIES,
  FLEXPAY_RETURNED_PULL_FEE, FLEXPAY_REJOIN_WAIT_DAYS,
} from './money'
import {
  BANK_TXN_MATCH_KINDS, BANK_TXN_MATCH_KIND_LABEL, PLATFORM_FEES, UTILITY_TYPES,
  TENANT_CREDIT_CATEGORIES, TENANT_CREDIT_ALL_CATEGORIES, TENANT_CREDIT_CATEGORY_LABEL,
  REVENUE_OWNERS, REVENUE_OWNER_LABEL,
} from './index'

const labelled = (values: readonly string[], labels: Record<string, string>) =>
  values.every(v => typeof labels[v] === 'string' && labels[v].trim().length > 0)
    && Object.keys(labels).length === values.length

describe('S655 money vocabulary', () => {
  it('every money list has a plain-words label for every value and nothing else', () => {
    expect(labelled(CREDIT_USE_SOURCES, CREDIT_USE_SOURCE_LABEL)).toBe(true)
    expect(labelled(CREDIT_USE_STATUSES, CREDIT_USE_STATUS_LABEL)).toBe(true)
    expect(labelled(CREDIT_USE_RELEASE_REASONS, CREDIT_USE_RELEASE_REASON_LABEL)).toBe(true)
    expect(labelled(CREDIT_KINDS, CREDIT_KIND_LABEL)).toBe(true)
    expect(labelled(PREPAID_FUNDED_BY, PREPAID_FUNDED_BY_LABEL)).toBe(true)
    expect(labelled(INCOME_BASES, INCOME_BASIS_LABEL)).toBe(true)
    expect(labelled(INCOME_LINES, INCOME_LINE_LABEL)).toBe(true)
    expect(labelled(BILLED_PARTS, BILLED_PART_LABEL)).toBe(true)
    expect(labelled(INCOME_CATEGORIES, INCOME_CATEGORY_LABEL)).toBe(true)
    expect(labelled(DEPOSIT_SLIP_STATUSES, DEPOSIT_SLIP_STATUS_LABEL)).toBe(true)
    expect(labelled(DEPOSIT_SLIP_SOURCES, DEPOSIT_SLIP_SOURCE_LABEL)).toBe(true)
    expect(labelled(BANK_MATCH_KINDS, BANK_MATCH_KIND_LABEL)).toBe(true)
    expect(labelled(TENANT_CREDIT_ALL_CATEGORIES, TENANT_CREDIT_CATEGORY_LABEL)).toBe(true)
    expect(labelled(REVENUE_OWNERS, REVENUE_OWNER_LABEL)).toBe(true)
  })

  it('a held use is released only for a failed, canceled or replaced payment', () => {
    expect([...CREDIT_USE_HELD_RELEASE_REASONS]).toEqual(['payment_failed', 'payment_canceled', 'superseded'])
    expect(CREDIT_USE_RELEASE_REASONS).toContain('funding_reversed')
  })

  it('Money received is the default and counts paid-ahead money on the day it arrived (Nic, 10/2)', () => {
    expect(DEFAULT_INCOME_BASIS).toBe('received')
    expect(INCOME_BASIS_LABEL).toEqual({ received: 'Money received', billed: 'Money billed' })
    expect(INCOME_BASIS_NOTE.received).toMatch(/day the money arrived/)
    expect(INCOME_BASIS_NOTE.received).toMatch(/not again when it pays a later bill/)
    expect(INCOME_BASIS_NOTE.received).toMatch(/credit you give is never income/)
    expect(INCOME_LINE_LABEL.paidAhead).toBe('Paid ahead for later bills')
  })

  it('the property breakdown leads with space rent, then each utility, in decision #4 order', () => {
    expect(INCOME_CATEGORIES.slice(0, 8)).toEqual(
      ['space_rent', 'electric', 'water', 'sewer', 'gas', 'trash', 'propane', 'utility_other'])
    expect(INCOME_CATEGORY_LABEL.space_rent).toBe('Lot/space rent')
    expect(INCOME_CATEGORY_LABEL.home_payments).toBe('Home/trailer payments')
    // Every utility type GAM bills has its own category.
    for (const t of UTILITY_TYPES) expect(INCOME_UTILITY_CATEGORIES as readonly string[]).toContain(t)
  })

  it('the bank-feed match kinds are the one money list', () => {
    expect(BANK_TXN_MATCH_KINDS).toBe(BANK_MATCH_KINDS)
    expect(BANK_TXN_MATCH_KIND_LABEL).toBe(BANK_MATCH_KIND_LABEL)
    expect(BANK_MATCH_KINDS).toEqual(['gam_payout', 'tenant_deposit', 'deposit_slip', 'auto_filed'])
  })

  it('a landlord cannot issue a deposit-interest credit; the full list matches the table', () => {
    expect(TENANT_CREDIT_CATEGORIES as readonly string[]).not.toContain('deposit_interest')
    expect(TENANT_CREDIT_ALL_CATEGORIES).toEqual([...TENANT_CREDIT_CATEGORIES, 'deposit_interest'])
    expect(REVENUE_OWNERS).toEqual(['landlord', 'gam', 'held'])
  })
})

describe('S655 rent-channel payers are never auto-filed as income', () => {
  it('names a rent channel as a whole word, in a raw or normalized memo', () => {
    expect(isRentChannelPayer('DOORLOOP INC PAYOUT 0921')).toBe(true)
    expect(isRentChannelPayer('Zego/PayLease ACH')).toBe(true)
    expect(isRentChannelPayer('rentcafe.com deposit')).toBe(true)
    expect(isRentChannelPayer('ZILLOW RENTALS')).toBe(true)
  })

  it('does not fire on a word that merely contains a channel name', () => {
    expect(isRentChannelPayer('AVAILABLE BALANCE TRANSFER')).toBe(false)
    expect(isRentChannelPayer('COZYCORNER LAUNDRY')).toBe(false)
    expect(isRentChannelPayer('SQUARE INC')).toBe(false)
    expect(isRentChannelPayer('')).toBe(false)
    expect(isRentChannelPayer(null)).toBe(false)
  })

  it('every channel is stored the way a memo is normalized (upper case words)', () => {
    for (const p of RENT_CHANNEL_PAYERS) expect(p).toMatch(/^[A-Z0-9]+( [A-Z0-9]+)*$/)
  })
})

describe('S655 FlexPay terms say what the code does', () => {
  const text = FLEXPAY_TERMS.map(s => `${s.title} ${s.body}`).join(' ')

  it('the monthly fee in the terms is the priced fee', () => {
    expect(PLATFORM_FEES.FLOAT_FEE_MO).toBe(25)
    expect(text).toContain(`$${PLATFORM_FEES.FLOAT_FEE_MO} monthly fee`)
  })

  it('every dollar figure in the terms is one the code charges: the $25 fee and the $4 on a retry', () => {
    const quoted = new Set([...text.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => Number(m[1])))
    expect([...quoted].sort((a, b) => a - b)).toEqual([FLEXPAY_RETURNED_PULL_FEE, PLATFORM_FEES.FLOAT_FEE_MO])
  })

  it('a retry collects the $4 bank-return fee at cost, with no markup', () => {
    expect(FLEXPAY_RETURNED_PULL_FEE).toBe(4)
    expect(text).toMatch(/Each retry also collects \$4: the fee GAM is charged when a bank sends a payment back, passed on at cost with no markup/)
  })

  it('after the last retry fails, the tenant cannot join again for 90 days, and never after a second time', () => {
    expect(FLEXPAY_REJOIN_WAIT_DAYS).toBe(90)
    expect(text).toMatch(/cannot join FlexPay again for 90 days/)
    expect(text).toMatch(/second time, you cannot join FlexPay again\./)
  })

  it('FlexPay ends only on the last try: the last retry, or the first try on a closed bank account', () => {
    const rejoining = FLEXPAY_TERMS.find(s => s.key === 'rejoining')!
    expect(rejoining.body).toMatch(/^The last try is the last retry, or the first try when the bank account is closed\./)
    expect(rejoining.body).toMatch(/If it does not go through, your FlexPay ends/)
    // Never "after the first failure": a retry still scheduled keeps FlexPay going.
    expect(text).not.toMatch(/first failure|first failed/)
  })

  it('covers the whole bill, retries 3 calendar days later with 2 retries in all, never retries a closed account, and keeps the $25 in a paid month', () => {
    expect(text).toMatch(/pays the whole bill/)
    expect(FLEXPAY_PULL_RETRY_DAYS).toBe(3)
    expect(FLEXPAY_PULL_MAX_RETRIES).toBe(2)
    expect(text).toMatch(/GAM tries again 3 calendar days later, up to 2 retries in all\./)
    // The old wording read as three retries.
    expect(text).not.toMatch(/more times/)
    expect(text).toMatch(/closed is not tried again/)
    expect(text).toMatch(/pay your bill yourself.*only the \$25/)
  })

  it('never offers a pull on the 1st through the 5th', () => {
    expect([...FLEXPAY_FORBIDDEN_PULL_DAYS]).toEqual([1, 2, 3, 4, 5])
    expect(text).toMatch(/6th through the 28th/)
  })

  it('every section has a unique key and plain words', () => {
    const keys = FLEXPAY_TERMS.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of FLEXPAY_TERMS) {
      expect(s.title.trim()).not.toBe('')
      expect(s.body.trim()).not.toBe('')
      // American spelling, no raw enum values.
      expect(`${s.title} ${s.body}`).not.toMatch(/cancelled|_/)
    }
  })

  it('never frames FlexPay as a loan (S304)', () => {
    expect(text).not.toMatch(/\b(loan|lend|lent|borrow|repay|pay GAM back|owe)/i)
  })
})

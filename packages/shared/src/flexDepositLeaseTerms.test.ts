// 10/27 (Nic) — the two rules the LEASE puts on a FlexDeposit plan:
//   month-to-month splits a deposit 2 ways; a fixed term may split it 4.
//   no schedule may finish after the tenancy does.
//
// Both are keyed to the lease, never to the applicant. The tests assert that
// explicitly, because the 10/26 rework removed every applicant-keyed variant
// of this and a future session must not quietly bring one back.

import { describe, it, expect } from 'vitest'
import {
  flexDepositPaymentChoicesForLeaseType,
  flexDepositScheduleFitsLease,
  FLEX_DEPOSIT_PAYMENT_CHOICES,
} from './flexFees'

describe('flexDepositPaymentChoicesForLeaseType', () => {
  it('offers both splits on a fixed term', () => {
    expect(flexDepositPaymentChoicesForLeaseType('fixed_term')).toEqual([2, 4])
  })

  it('offers 2 only on a month-to-month — the tenancy has no visible end', () => {
    expect(flexDepositPaymentChoicesForLeaseType('month_to_month')).toEqual([2])
  })

  it('treats a commercial lease as a fixed term, because it is a dated one', () => {
    expect(flexDepositPaymentChoicesForLeaseType('nnn_commercial')).toEqual([2, 4])
  })

  it('gives the cautious answer for an unknown, null or empty lease type', () => {
    for (const t of [null, undefined, '', 'something_new']) {
      expect(flexDepositPaymentChoicesForLeaseType(t)).toEqual([2])
    }
  })

  it('never offers a count the product does not sell', () => {
    for (const t of ['fixed_term', 'month_to_month', 'nnn_commercial', null]) {
      for (const n of flexDepositPaymentChoicesForLeaseType(t)) {
        expect(FLEX_DEPOSIT_PAYMENT_CHOICES).toContain(n)
      }
    }
  })

  it('does not narrow the offer by anything about the applicant', () => {
    // The signature takes a lease type and nothing else. If a later change adds
    // a second parameter for screening, income, history or risk, this fails
    // first — which is the point.
    expect(flexDepositPaymentChoicesForLeaseType.length).toBe(1)
  })
})

describe('flexDepositScheduleFitsLease', () => {
  it('allows anything when the lease has no end date', () => {
    expect(flexDepositScheduleFitsLease('2026-11-01', 4, null)).toBe(true)
    expect(flexDepositScheduleFitsLease('2026-11-01', 4, undefined)).toBe(true)
  })

  it('fits a 4-payment plan inside a year lease', () => {
    // Installments fall Nov, Dec, Jan, Feb; the lease runs to October.
    expect(flexDepositScheduleFitsLease('2026-11-01', 4, '2027-10-31')).toBe(true)
  })

  it('refuses a 4-payment plan on a 3-month lease', () => {
    // Last installment 2027-02-01 is past a 2027-01-31 end.
    expect(flexDepositScheduleFitsLease('2026-11-01', 4, '2027-01-31')).toBe(false)
  })

  it('fits a 2-payment plan on that same 3-month lease', () => {
    // Last installment 2026-12-01, comfortably inside.
    expect(flexDepositScheduleFitsLease('2026-11-01', 2, '2027-01-31')).toBe(true)
  })

  it('counts the last installment, not the month after it', () => {
    // 4 payments from Nov 1 land on Feb 1. A lease ending exactly Feb 1 fits;
    // Jan 31 does not. Off by one here refuses a plan that was fine.
    expect(flexDepositScheduleFitsLease('2026-11-01', 4, '2027-02-01')).toBe(true)
    expect(flexDepositScheduleFitsLease('2026-11-01', 4, '2027-01-31')).toBe(false)
  })

  it('refuses a 2-payment plan on a one-month lease', () => {
    expect(flexDepositScheduleFitsLease('2026-11-15', 2, '2026-12-14')).toBe(false)
  })

  it('crosses a year boundary correctly', () => {
    // 4 payments from Dec 2026 land on Mar 2027, not Mar 2026.
    expect(flexDepositScheduleFitsLease('2026-12-10', 4, '2027-03-10')).toBe(true)
    expect(flexDepositScheduleFitsLease('2026-12-10', 4, '2027-03-09')).toBe(false)
  })

  it('clamps a 31st move-in to the short month, as addMonths does', () => {
    // 4 payments from Dec 31 would be Mar 31 — a real date, so no clamp.
    expect(flexDepositScheduleFitsLease('2026-12-31', 4, '2027-03-31')).toBe(true)
    // 4 payments from Nov 30 land on Feb 28 in a non-leap year, NOT Mar 2.
    // Without the clamp this would demand a Mar 2 end date and wrongly refuse
    // a lease ending Feb 28.
    expect(flexDepositScheduleFitsLease('2026-11-30', 4, '2027-02-28')).toBe(true)
    // And a leap February takes the 29th.
    expect(flexDepositScheduleFitsLease('2027-11-29', 4, '2028-02-29')).toBe(true)
  })

  it('does not rule on an unparseable start date', () => {
    // Not this function's job to validate input; a bad date is somebody
    // else's error and must not silently read as "refused".
    expect(flexDepositScheduleFitsLease('', 4, '2027-01-01')).toBe(true)
    expect(flexDepositScheduleFitsLease('not-a-date', 4, '2027-01-01')).toBe(true)
  })

  it('compares as plain dates, so an evening is never tomorrow', () => {
    // The whole reason both sides are YYYY-MM-DD strings: parsing to Date and
    // comparing would push a late-evening Phoenix date into the next UTC day
    // and refuse a plan that fit. A same-day boundary must hold exactly.
    expect(flexDepositScheduleFitsLease('2026-11-01', 2, '2026-12-01')).toBe(true)
    expect(flexDepositScheduleFitsLease('2026-11-01', 2, '2026-11-30')).toBe(false)
  })

  it('2 payments is never stricter than 4 for the same lease', () => {
    const ends = ['2026-12-01', '2027-01-15', '2027-06-30', '2028-01-01']
    for (const end of ends) {
      const two  = flexDepositScheduleFitsLease('2026-11-01', 2, end)
      const four = flexDepositScheduleFitsLease('2026-11-01', 4, end)
      if (four) expect(two).toBe(true)
    }
  })
})

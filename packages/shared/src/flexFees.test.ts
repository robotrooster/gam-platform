import { describe, it, expect } from 'vitest'
import {
  pickFeeBracket,
  feeForValue,
  benefitWednesdayForPullDay,
  isAllowedFlexDepositPaymentCount,
  BENEFIT_WEDNESDAYS,
  type FeeBracketRow,
} from './flexFees'

// The seeded FlexPay 3rd-Wednesday column, as the migration writes it.
const THIRD_WED: FeeBracketRow[] = [
  { min: 0,    max: 1000, fee: 12 },
  { min: 1000, max: 1500, fee: 19 },
  { min: 1500, max: 2000, fee: 26 },
  { min: 2000, max: 2500, fee: 33 },
  { min: 2500, max: null, fee: 40 },
]

describe('pickFeeBracket', () => {
  it('matches a value inside a bracket', () => {
    expect(feeForValue(THIRD_WED, 1750)).toBe(26)
  })

  // A bracket is half-open, so a rent of exactly the floor belongs to THAT
  // bracket. Round rents cluster on these boundaries — $1,000, $1,500, $2,000
  // are the most common rents there are — so an off-by-one here misprices more
  // tenants than it correctly prices.
  it('puts a value exactly on a floor in the higher bracket', () => {
    expect(feeForValue(THIRD_WED, 1500)).toBe(26)
    expect(feeForValue(THIRD_WED, 1000)).toBe(19)
    expect(feeForValue(THIRD_WED, 2000)).toBe(33)
    expect(feeForValue(THIRD_WED, 2500)).toBe(40)
  })

  it('puts a value one cent below a floor in the lower bracket', () => {
    expect(feeForValue(THIRD_WED, 1499.99)).toBe(19)
    expect(feeForValue(THIRD_WED, 999.99)).toBe(12)
  })

  it('carries the open-topped bracket past its floor', () => {
    expect(feeForValue(THIRD_WED, 5000)).toBe(40)
    expect(feeForValue(THIRD_WED, 100000)).toBe(40)
  })

  it('covers zero and anything under the first ceiling', () => {
    expect(feeForValue(THIRD_WED, 0)).toBe(12)
    expect(feeForValue(THIRD_WED, 450)).toBe(12)
  })

  it('returns null rather than a price when no row covers the value', () => {
    // A schedule that starts at $1,000 must not quietly price a $400 rent.
    const gapped: FeeBracketRow[] = [{ min: 1000, max: 2000, fee: 19 }]
    expect(feeForValue(gapped, 400)).toBeNull()
    expect(feeForValue(gapped, 2000)).toBeNull()
    expect(feeForValue([], 1500)).toBeNull()
  })

  it('refuses a non-finite value instead of matching the first row', () => {
    expect(feeForValue(THIRD_WED, NaN)).toBeNull()
    expect(feeForValue(THIRD_WED, Infinity)).toBeNull()
  })

  // Row order out of the database is not guaranteed without an ORDER BY, and a
  // schedule edit can leave two rows overlapping. Highest matching floor wins,
  // so the answer does not depend on which row came back first.
  it('takes the highest matching floor regardless of row order', () => {
    const shuffled = [THIRD_WED[3], THIRD_WED[0], THIRD_WED[4], THIRD_WED[1], THIRD_WED[2]]
    expect(feeForValue(shuffled, 1750)).toBe(26)
    const overlapping: FeeBracketRow[] = [
      { min: 0,    max: 3000, fee: 99 },
      { min: 1500, max: 2000, fee: 26 },
    ]
    expect(feeForValue(overlapping, 1750)).toBe(26)
  })

  it('returns the row, not just the price, so a caller can show the bracket', () => {
    expect(pickFeeBracket(THIRD_WED, 1750)).toEqual({ min: 1500, max: 2000, fee: 26 })
  })
})

describe('benefitWednesdayForPullDay', () => {
  // The 2nd Wednesday always falls on the 8th-14th, the 3rd on the 15th-21st,
  // the 4th on the 22nd-28th. These are the exact windows, not estimates.
  it('maps each Wednesday window to its column', () => {
    for (const d of [8, 9, 10, 11, 12, 13, 14]) expect(benefitWednesdayForPullDay(d)).toBe(2)
    for (const d of [15, 16, 17, 18, 19, 20, 21]) expect(benefitWednesdayForPullDay(d)).toBe(3)
    for (const d of [22, 23, 24, 25, 26, 27, 28]) expect(benefitWednesdayForPullDay(d)).toBe(4)
  })

  // Earlier than any 2nd Wednesday means GAM's money is out for less time than
  // the cheapest column assumes, so it prices at the cheapest column.
  it('prices a pull before the 8th at the cheapest column', () => {
    expect(benefitWednesdayForPullDay(6)).toBe(2)
    expect(benefitWednesdayForPullDay(7)).toBe(2)
    expect(benefitWednesdayForPullDay(1)).toBe(2)
  })

  it('refuses a day no enrollment can hold', () => {
    expect(benefitWednesdayForPullDay(29)).toBeNull()
    expect(benefitWednesdayForPullDay(31)).toBeNull()
    expect(benefitWednesdayForPullDay(0)).toBeNull()
    expect(benefitWednesdayForPullDay(-3)).toBeNull()
    expect(benefitWednesdayForPullDay(10.5)).toBeNull()
  })

  it('only ever answers with a column the schedule has', () => {
    for (let d = 1; d <= 28; d++) {
      const w = benefitWednesdayForPullDay(d)
      expect(w).not.toBeNull()
      expect(BENEFIT_WEDNESDAYS).toContain(w!)
    }
  })
})

describe('isAllowedFlexDepositPaymentCount', () => {
  // 10/26 (Nic): FlexDeposit sells TWO splits, 2 or 4. Not a range — the whole
  // point of the shape is that there is no variation to be adverse about:
  // "People don't have a choice. There's no 'in part' by limiting their
  // options."
  it('accepts exactly two and four', () => {
    for (const n of [2, 4]) expect(isAllowedFlexDepositPaymentCount(n)).toBe(true)
  })

  it('rejects counts INSIDE the old range that are not sold', () => {
    // The bug a range check would reintroduce: 3, 5 and 6 all sit within
    // 2..6, have no row in flexdeposit_fee_schedule, and would quote null —
    // which the service treats as an error. Refuse them at the door instead.
    for (const n of [3, 5, 6]) expect(isAllowedFlexDepositPaymentCount(n), String(n)).toBe(false)
  })

  it('rejects one, seven, and anything that is not a whole count', () => {
    expect(isAllowedFlexDepositPaymentCount(1)).toBe(false)
    expect(isAllowedFlexDepositPaymentCount(7)).toBe(false)
    expect(isAllowedFlexDepositPaymentCount(0)).toBe(false)
    expect(isAllowedFlexDepositPaymentCount(2.5)).toBe(false)
    expect(isAllowedFlexDepositPaymentCount(NaN)).toBe(false)
  })
})

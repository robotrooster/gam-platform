/**
 * 10/26 (Nic) — THE FLEXDEPOSIT SERVICE FEE.
 *
 *   "The same amount of installments at the same amount of security deposit
 *    needs to be the same price for everybody. That's what keeps it not
 *    lending. It's a service they're paying for. It's like window tinting."
 *
 *   "I would say the entire fee is paid up front along with the first
 *    installment portion... We get our fee at the first payment."
 *
 * Two things these pin hardest:
 *  - the price depends ONLY on deposit size and the split, never on the person;
 *  - the fee is GAM's revenue and never deposit principal, so it can never be
 *    returned to the tenant at move-out as though they had funded it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { query } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { quoteFlexDepositServiceFee } from './flexDeposit'
import {
  isAllowedFlexDepositPaymentCount, FLEX_DEPOSIT_PAYMENT_CHOICES,
  getFlexDepositMaxInstallments,
} from '@gam/shared'

const ASOF = '2026-10-26'
beforeEach(async () => { await cleanupAllSchema() })

describe('the two splits, and only those', () => {
  it('sells 2 and 4', () => {
    expect([...FLEX_DEPOSIT_PAYMENT_CHOICES]).toEqual([2, 4])
    expect(isAllowedFlexDepositPaymentCount(2)).toBe(true)
    expect(isAllowedFlexDepositPaymentCount(4)).toBe(true)
  })

  it('refuses the counts that used to exist', async () => {
    for (const n of [3, 5, 6]) {
      expect(isAllowedFlexDepositPaymentCount(n), String(n)).toBe(false)
      // And there is no price for them either, so a caller that got past the
      // check still could not quote one.
      expect(await quoteFlexDepositServiceFee(900, n, ASOF), String(n)).toBeNull()
    }
  })
})

describe('the price Nic set', () => {
  // He checked this row himself against the move-in at Country Acres: "a $48
  // fee on 2 payments ... or a $67 fee for the deposit to be split into 4."
  it('is $48 on two and $67 on four for a deposit under $1,000', async () => {
    expect(await quoteFlexDepositServiceFee(900, 2, ASOF)).toBe(48)
    expect(await quoteFlexDepositServiceFee(900, 4, ASOF)).toBe(67)
  })

  it('climbs with the deposit, and four always costs more than two', async () => {
    const mids = [750, 1250, 1750, 2250, 2750]
    const two = await Promise.all(mids.map(d => quoteFlexDepositServiceFee(d, 2, ASOF)))
    const four = await Promise.all(mids.map(d => quoteFlexDepositServiceFee(d, 4, ASOF)))
    expect(two).toEqual([48, 67, 86, 105, 124])
    expect(four).toEqual([67, 93, 120, 147, 173])
    for (let i = 1; i < mids.length; i++) {
      expect(two[i]!).toBeGreaterThan(two[i - 1]!)
      expect(four[i]!).toBeGreaterThan(four[i - 1]!)
    }
    for (let i = 0; i < mids.length; i++) expect(four[i]!).toBeGreaterThan(two[i]!)
  })

  it('is the same at a bracket boundary whichever side you approach from', async () => {
    // Half-open brackets: $1,500 is the 1,500-1,999 bracket, not the one below.
    expect(await quoteFlexDepositServiceFee(1499.99, 2, ASOF)).toBe(67)
    expect(await quoteFlexDepositServiceFee(1500, 2, ASOF)).toBe(86)
  })

  it('is not offered at $3,000 or more, and never quotes it free', async () => {
    expect(await quoteFlexDepositServiceFee(2999.99, 4, ASOF)).toBe(173)
    for (const d of [3000, 3500, 10000]) {
      expect(await quoteFlexDepositServiceFee(d, 4, ASOF), String(d)).toBeNull()
    }
  })
})

describe('nothing about the person changes the offer', () => {
  // THE STRUCTURAL TEST. Every mechanism that gave one applicant fewer options
  // than another was a decision made about that applicant — which is what an
  // adverse action rests on. Removing the variation is what makes this a price.
  it('gives every risk level both choices', () => {
    for (const risk of ['low', 'medium', 'high', 'very_high'] as const) {
      expect(getFlexDepositMaxInstallments(900, risk), risk).toBe(4)
      expect(getFlexDepositMaxInstallments(2900, risk), risk).toBe(4)
    }
  })

  it('still reports "no screening result yet" as null rather than a default', () => {
    expect(getFlexDepositMaxInstallments(900, null)).toBeNull()
    expect(getFlexDepositMaxInstallments(900, undefined)).toBeNull()
  })

  it('does not vary the options by deposit size either', () => {
    for (const d of [100, 900, 1500, 2900]) {
      expect(getFlexDepositMaxInstallments(d, 'low'), String(d)).toBe(4)
    }
  })
})

describe('the fee is revenue, not deposit principal', () => {
  it('is written as a GAM fee row, separate from the installment', async () => {
    // The shape move-in writes: installment 1 funds the tenant's own custody
    // balance ('deposit'); the fee is GAM's ('fee' / 'gam' / 'FLEXDEP'). If
    // these were one row the deposit return would hand GAM's fee back.
    const allowed = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'payments'::regclass AND conname LIKE '%entry_desc%'`)
    expect(allowed[0].def).toContain('FLEXDEP')
  })

  it('the plan remembers the fee it was sold at', async () => {
    const col = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'security_deposits' AND column_name = 'flex_deposit_service_fee'`)
    expect(col[0].n).toBe(1)
  })
})

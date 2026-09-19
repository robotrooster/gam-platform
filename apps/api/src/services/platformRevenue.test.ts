/**
 * S650 (Nic): "Where is that $5 from that first background check? ... is it
 * five dollars flat on the markup plus any upcharge on the card fee, or is it
 * just five dollars flat? ... if it's off by a few cents and over time we have
 * hundreds of thousands of people doing background checks, that's going to be
 * a lot of money that could be missing."
 *
 * A screening earns GAM two things: the $5 inside the price, and the spread
 * between what the applicant is charged for card processing and what Stripe
 * costs. Both get written down, or the earnings figures are wrong by ~49c a
 * check forever.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { recordPlatformRevenue, recordScreeningEarnings } from './platformRevenue'

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM platform_revenue_ledger`)
  await db.query(`DELETE FROM platform_processing_rates WHERE payment_method = 'card' AND effective_until IS NULL`)
  // The live card row: customer 3.5% + $0.55, Stripe's cost 2.9% + $0.26.
  await db.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent, effective_from, notes)
     VALUES ('card', 0.55, 3.50, 0.26, 2.90, NOW(), 'S650 test')`)
})

const ledger = async () => (await db.query<{ type: string; amount: string }>(
  `SELECT type, amount::text AS amount FROM platform_revenue_ledger ORDER BY type`)).rows

describe('what a background check earns GAM', () => {
  it('books the $5 AND the card spread — $5.49 on a $44.99 check', async () => {
    await recordScreeningEarnings({
      backgroundCheckId: '11111111-1111-1111-1111-111111111111',
      gamMarginUsd: 5,
      processingChargedUsd: 2.05,   // 3.5% + $0.55 on the $42.94 subtotal
      totalChargedUsd: 44.99,
    })
    const rows = await ledger()
    expect(rows).toHaveLength(2)
    const byType = Object.fromEntries(rows.map(r => [r.type, Number(r.amount)]))
    expect(byType.screening_margin).toBe(5)
    expect(byType.banking_spread).toBeCloseTo(0.49, 2)   // 2.05 − (44.99×2.9% + 0.26)
    expect(Object.values(byType).reduce((a, b) => a + b, 0)).toBeCloseTo(5.49, 2)
  })

  it('cannot book the same screening twice', async () => {
    const args = {
      backgroundCheckId: '22222222-2222-2222-2222-222222222222',
      gamMarginUsd: 5, processingChargedUsd: 2.05, totalChargedUsd: 44.99,
    }
    await recordScreeningEarnings(args)
    await recordScreeningEarnings(args)
    expect(await ledger()).toHaveLength(2)
  })

  it('keeps a running balance across entries', async () => {
    await recordPlatformRevenue({ type: 'platform_fee_subscription', amount: 10, referenceId: null })
    await recordPlatformRevenue({ type: 'banking_spread', amount: 2.5, referenceId: null })
    const [last] = (await db.query<{ balance_after: string }>(
      `SELECT balance_after::text FROM platform_revenue_ledger ORDER BY created_at DESC, id DESC LIMIT 1`)).rows
    expect(Number(last.balance_after)).toBeCloseTo(12.5, 2)
  })

  it('never throws when the books cannot be written — the money still landed', async () => {
    await expect(recordPlatformRevenue({ type: 'adjustment', amount: 1, referenceId: 'not-a-uuid' }))
      .resolves.toBeUndefined()
  })
})

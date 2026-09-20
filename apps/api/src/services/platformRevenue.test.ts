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
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { recordPlatformRevenue, recordScreeningEarnings, trueUpProcessingMargin } from './platformRevenue'

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM platform_revenue_ledger`)
  await db.query(`DELETE FROM stripe_processing_costs`)
  await db.query(`DELETE FROM tenant_remittances`)
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

// S650 (Nic): "That KPI card doesn't match any of the numbers you said."
// The per-payment estimate runs low against Stripe's real invoices; the
// monthly true-up makes the ledger equal what actually happened.
describe('the monthly true-up', () => {
  const MONTH = '2026-07-01'
  async function seedMonth(feesCharged: number, stripeCost: number, estimated: number) {
    const c = await db.connect()
    let landlordId = ''
    try { landlordId = (await seedLandlord(c)).landlordId } finally { c.release() }
    const { rows: [t] } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('s650-remit-' || gen_random_uuid() || '@test.dev', 'x', 'tenant', 'T', 'R', TRUE) RETURNING id`)
    const { rows: [tt] } = await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [t.id])
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, processing_fee_amount, settled_at, created_at)
       VALUES ($3, $4, 1000, 1000, 0, 'settled', $1, $2::date, $2::date)`, [feesCharged, MONTH, tt.id, landlordId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, description, posted_at, period_start)
       VALUES ('txn_s650_' || gen_random_uuid(), 'stripe_fee', 'card_interchange', $1, 'S650 test', $2::date, $2::date)`,
      [stripeCost, MONTH])
    if (estimated > 0) {
      await db.query(
        `INSERT INTO platform_revenue_ledger (type, amount, balance_after, notes, created_at)
         VALUES ('banking_spread', $1, $1, 'S650 test estimate', $2::date)`, [estimated, MONTH])
    }
  }

  it('adds what the estimates missed, so the month equals fees minus Stripe', async () => {
    await seedMonth(238.31, 163.45, 41.75)
    const r = await trueUpProcessingMargin(MONTH)
    expect(r.actualMargin).toBeCloseTo(74.86, 2)
    expect(r.adjustment).toBeCloseTo(33.11, 2)          // 74.86 − 41.75
    const [sum] = (await db.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS s FROM platform_revenue_ledger
        WHERE to_char(date_trunc('month', created_at), 'YYYY-MM') = '2026-07'`)).rows
    expect(Number(sum.s)).toBeCloseTo(74.86, 2)
  })

  it('running it twice does not double the adjustment', async () => {
    await seedMonth(238.31, 163.45, 41.75)
    await trueUpProcessingMargin(MONTH)
    await trueUpProcessingMargin(MONTH)
    // It REPLACES its own previous row rather than stacking a second one.
    const [rows] = (await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM platform_revenue_ledger
        WHERE reference_type = 'processing_margin_true_up'`)).rows
    expect(Number(rows.n)).toBe(1)
    const [sum] = (await db.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS s FROM platform_revenue_ledger
        WHERE to_char(date_trunc('month', created_at), 'YYYY-MM') = '2026-07'`)).rows
    expect(Number(sum.s)).toBeCloseTo(74.86, 2)
  })

  it('takes money back off when the estimates ran HIGH', async () => {
    await seedMonth(100, 80, 35)                        // real margin 20, estimated 35
    const r = await trueUpProcessingMargin(MONTH)
    expect(r.adjustment).toBeCloseTo(-15, 2)
  })
})

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
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../db'
import { logger } from '../lib/logger'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { recordPlatformRevenue, recordScreeningEarnings, restateRunningBalance, trueUpProcessingMargin } from './platformRevenue'

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
    // 10/3: a card payment that cleared — the true-up is the Processing Margin
    // card's figure, which counts payments made by card or bank.
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, unapplied_amount,
                                       status, processing_fee_amount, settled_at, created_at,
                                       payment_method, gross_amount, stripe_payment_intent_id)
       VALUES ($3, $4, 1000, 1000, 0, 'settled', $1::numeric, $2::date, $2::date,
               'card', 1000 + $1::numeric, 'pi_s650_' || gen_random_uuid())`, [feesCharged, MONTH, tt.id, landlordId])
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

// S655 (money plan Step 4): FlexPay's $25 is GAM's own earnings, booked as
// its own type, and it can ride the transaction of the pull that earned it.
describe('FlexPay subscription earnings', () => {
  it('books the $25 as flexpay_subscription, once per advance', async () => {
    const advanceId = '33333333-3333-3333-3333-333333333333'
    await recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: advanceId, referenceType: 'flexpay_advance' })
    await recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: advanceId, referenceType: 'flexpay_advance' })
    const rows = await ledger()
    expect(rows).toEqual([{ type: 'flexpay_subscription', amount: '25.00' }])
  })

  it('inside a transaction the row commits with it, and rolls back with it', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: '44444444-4444-4444-4444-444444444444', referenceType: 'flexpay_advance' }, c)
      await c.query('ROLLBACK')
      expect(await ledger()).toHaveLength(0)
      await c.query('BEGIN')
      await recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: '44444444-4444-4444-4444-444444444444', referenceType: 'flexpay_advance' }, c)
      await c.query('COMMIT')
      expect(await ledger()).toHaveLength(1)
    } finally { c.release() }
  })

  it('a failed write inside a transaction leaves the caller\'s transaction usable', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await expect(recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: 'not-a-uuid' }, c))
        .resolves.toBeUndefined()
      // The caller's own work still runs and commits after the miss.
      await recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: '55555555-5555-5555-5555-555555555555', referenceType: 'flexpay_advance' }, c)
      await c.query('COMMIT')
      expect(await ledger()).toHaveLength(1)
    } finally { c.release() }
  })
})

// S655 Step 4 fix round 2: a FlexPay pull the bank takes back takes its $25
// back off the book. Only an 'adjustment' may be negative; earnings never are.
describe('taking money back off the book', () => {
  it('an adjustment may take money back off the book; an earnings row is never negative and no row is ever $0', async () => {
    const advanceId = '66666666-6666-6666-6666-666666666666'
    await recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: advanceId, referenceType: 'flexpay_advance' })
    await recordPlatformRevenue({ type: 'adjustment', amount: -25, referenceId: advanceId, referenceType: 'flexpay_advance_reversal' })
    await recordPlatformRevenue({ type: 'flexpay_subscription', amount: -25, referenceId: advanceId, referenceType: 'x' })
    await recordPlatformRevenue({ type: 'adjustment', amount: 0, referenceId: advanceId, referenceType: 'y' })
    const rows = (await db.query<{ type: string; amount: string; balance_after: string }>(
      `SELECT type, amount::text AS amount, balance_after::text AS balance_after
         FROM platform_revenue_ledger ORDER BY created_at, id`)).rows
    expect(rows).toEqual([
      { type: 'flexpay_subscription', amount: '25.00', balance_after: '25.00' },
      { type: 'adjustment', amount: '-25.00', balance_after: '0.00' },
    ])
  })

  /**
   * Another writer holds the ledger lock (as allocation does while it posts)
   * and lands a row before letting go. A writer that took the lock must wait
   * for it and build its running balance on that row; one that did not would
   * read the old balance and write a wrong one.
   */
  async function whileAnotherWriterHoldsTheLock(write: () => Promise<unknown>): Promise<void> {
    const holder = await db.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`)
      let done = false
      const pending = write().then(() => { done = true })
      await new Promise(r => setTimeout(r, 300))
      expect(done).toBe(false)                    // it is waiting on the lock
      await holder.query(
        `INSERT INTO platform_revenue_ledger (type, amount, balance_after, notes)
         VALUES ('platform_fee_subscription', 100, 110, 'the other writer')`)
      await holder.query('COMMIT')
      await pending
    } finally { holder.release() }
  }

  it('outside a transaction the running balance is also taken under the ledger lock', async () => {
    await recordPlatformRevenue({ type: 'platform_fee_subscription', amount: 10, referenceId: null })
    await whileAnotherWriterHoldsTheLock(() =>
      recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: '88888888-8888-8888-8888-888888888888', referenceType: 'flexpay_advance' }))
    const rows = (await db.query<{ amount: string; balance_after: string }>(
      `SELECT amount::text AS amount, balance_after::text AS balance_after
         FROM platform_revenue_ledger ORDER BY created_at, id`)).rows
    expect(rows).toEqual([
      { amount: '10.00',  balance_after: '10.00' },
      { amount: '100.00', balance_after: '110.00' },
      { amount: '25.00',  balance_after: '135.00' },   // built on the other writer's row
    ])
  })

  /**
   * A caller that holds the ledger lock in its own open transaction (a settle
   * that posted through allocation) and then writes revenue WITHOUT passing its
   * client would wait on itself forever: Postgres sees no deadlock, because the
   * holder is idle in its transaction. The write gives up after its lock
   * timeout and is logged as a missed row; it never hangs.
   */
  it('a no-client write while the ledger lock is held elsewhere gives up and logs, never hangs', async () => {
    const miss = vi.spyOn(logger, 'error')
    const holder = await db.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`)
      const started = Date.now()
      await expect(recordPlatformRevenue({
        type: 'flexpay_subscription', amount: 25,
        referenceId: '99999999-9999-9999-9999-999999999999', referenceType: 'flexpay_advance',
      })).resolves.toBeUndefined()
      const waited = Date.now() - started
      expect(waited).toBeGreaterThanOrEqual(9_000)        // it did wait for the lock
      expect(waited).toBeLessThan(15_000)                 // and then gave up
      expect(miss).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'flexpay_subscription', referenceId: '99999999-9999-9999-9999-999999999999' }),
        expect.stringContaining('could not record earnings'))
      await holder.query('COMMIT')
    } finally {
      holder.release()
      miss.mockRestore()
    }
    expect(await ledger()).toEqual([])                    // nothing half-written
    // Its own connection went back to the pool clean: the next write works.
    await recordPlatformRevenue({ type: 'platform_fee_subscription', amount: 10, referenceId: null })
    expect(await ledger()).toEqual([{ type: 'platform_fee_subscription', amount: '10.00' }])
  }, 30_000)

  it('the monthly true-up is taken under the ledger lock too', async () => {
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, description, posted_at, period_start)
       VALUES ('txn_s655_lock', 'stripe_fee', 'card_interchange', 5, 'S655 test', '2026-06-01', '2026-06-01')`)
    await whileAnotherWriterHoldsTheLock(() => trueUpProcessingMargin('2026-06-01'))
    const rows = (await db.query<{ amount: string; balance_after: string; reference_type: string | null }>(
      `SELECT amount::text AS amount, balance_after::text AS balance_after, reference_type
         FROM platform_revenue_ledger ORDER BY created_at, id`)).rows
    // $0 of fees against $5 of Stripe cost: −5, dated June's last second —
    // BEFORE the other writer's row (written today). It waited for that row,
    // saw it, and restated it: 100 on top of −5 is 95. (10/3 review: before,
    // the June row was given 105, a balance that counted a row from October.)
    expect(rows).toEqual([
      { amount: '-5.00', balance_after: '-5.00', reference_type: 'processing_margin_true_up' },
      { amount: '100.00', balance_after: '95.00', reference_type: null },
    ])
  })

  it('inside a transaction the running balance is taken under the ledger lock', async () => {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await recordPlatformRevenue({ type: 'flexpay_subscription', amount: 25, referenceId: '77777777-7777-7777-7777-777777777777', referenceType: 'flexpay_advance' }, c)
      const held = await c.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`)
      expect(held.rows[0].n).toBeGreaterThan(0)
      await c.query('COMMIT')
    } finally { c.release() }
  })
})

// 10/3 (Nic's admin cards): the true-up IS the Processing Margin card's figure,
// so the book and the card can never disagree — and the card's rules apply.
describe('the true-up follows the card\'s rules (10/3)', () => {
  const MONTH = '2026-08-01'
  async function people() {
    const c = await db.connect()
    try {
      const { landlordId, userId } = await seedLandlord(c)
      const { rows: [t] } = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ('cards-' || gen_random_uuid() || '@test.dev', 'x', 'tenant', 'Mireya', 'Fierro', TRUE) RETURNING id`)
      const { rows: [tt] } = await c.query<{ id: string }>(`INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [t.id])
      return { landlordId, userId, tenantId: tt.id }
    } finally { c.release() }
  }

  it('a bank payment\'s fee counts once it has cleared, and its Stripe fee waits with it', async () => {
    const { landlordId, tenantId } = await people()
    const { rows: [r] } = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method,
                                       gross_amount, processing_fee_amount, stripe_payment_intent_id, created_at)
       VALUES ($1, $2, 460, 460, 'processing', 'ach', 466, 6, 'pi_ach_clearing', '2026-08-10T15:00:00Z') RETURNING id`,
      [tenantId, landlordId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, stripe_payment_intent_id)
       VALUES ('txn_ach:fee', 'payment', 'bank_debit_fee', 2.33, '2026-08-10T20:00:00Z', 'pi_ach_clearing')`)
    const clearing = await trueUpProcessingMargin(MONTH)
    expect(clearing).toMatchObject({ feesCharged: 0, stripeCost: 0, actualMargin: 0 })

    await db.query(`UPDATE tenant_remittances SET status = 'settled', settled_at = '2026-08-14T15:00:00Z' WHERE id = $1`, [r.id])
    const cleared = await trueUpProcessingMargin(MONTH)
    expect(cleared).toMatchObject({ feesCharged: 6, stripeCost: 2.33, actualMargin: 3.67 })
  })

  it('register card fees count, and Stripe\'s bank-feed charges are a cost (Nic 10/3)', async () => {
    const { landlordId, userId } = await people()
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total,
                                     platform_fee, stripe_payment_intent_id, created_at)
       VALUES ($1, $2, 'card', 3.30, 0.22, 0.67, 4.19, 0.67, 'pi_register', '2026-08-02T01:27:00Z')`, [landlordId, userId])
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('n_aug2', 'network_cost', 'card_interchange', 0.06, '2026-08-03T12:00:00Z', '2026-08-02', '2026-08-02'),
              ('fc_aug', 'stripe_fee', 'bank_linking', 9.91, '2026-09-01T01:52:00Z', '2026-08-01', '2026-08-31')`)
    const r = await trueUpProcessingMargin(MONTH)
    expect(r.feesCharged).toBe(0.67)
    expect(r.stripeCost).toBe(9.97)
    expect(r.actualMargin).toBe(-9.30)
  })

  it('a dry run computes the true-up and writes nothing', async () => {
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('o_jul', 'network_cost', 'card_interchange', 0.24, '2026-08-02T05:21:00Z', '2026-07-01', '2026-07-31')`)
    const r = await trueUpProcessingMargin('2026-07-01', { dryRun: true })
    expect(r.adjustment).toBe(-0.24)
    expect(await ledger()).toEqual([])
    const real = await trueUpProcessingMargin('2026-07-01')
    expect(real.adjustment).toBe(-0.24)
    expect(await ledger()).toEqual([{ type: 'adjustment', amount: '-0.24' }])
    // Again: it replaces itself.
    expect((await trueUpProcessingMargin('2026-07-01')).previousTrueUp).toBe(-0.24)
    expect(await ledger()).toHaveLength(1)
  })
})

describe('earnings written down after the fact (10/3)', () => {
  it('carry the day they were earned, so they land in the right month', async () => {
    await recordPlatformRevenue({
      type: 'banking_spread', amount: 1.04, customerFeeCharged: 1.04,
      referenceId: '12121212-1212-1212-1212-121212121212', referenceType: 'pos_transaction',
      at: '2026-09-29T22:08:00Z',
    })
    const [row] = (await db.query<{ m: string }>(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS m FROM platform_revenue_ledger`)).rows
    expect(row.m).toBe('2026-09-29')
  })

  it('a screening\'s own record says what GAM kept — $5, not the stale $15', async () => {
    const c = await db.connect()
    let landlordId = '', userId = ''
    try { ({ landlordId, userId } = await seedLandlord(c)) } finally { c.release() }
    const { rows: [bc] } = await db.query<{ id: string; platform_net: string }>(
      `INSERT INTO background_checks (landlord_id, user_id, amount_charged) VALUES ($1, $2, 44.99)
       RETURNING id, platform_net::text AS platform_net`, [landlordId, userId])
    expect(bc.platform_net).toBe('15.00')
    await recordScreeningEarnings({ backgroundCheckId: bc.id, gamMarginUsd: 5, processingChargedUsd: 2.05, totalChargedUsd: 44.99 })
    const [after] = (await db.query<{ platform_net: string }>(
      `SELECT platform_net::text AS platform_net FROM background_checks WHERE id = $1`, [bc.id])).rows
    expect(after.platform_net).toBe('5.00')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10/3 (review): balance_after is a real running balance in (created_at, id)
// order, even when a row is written for an earlier day or a month's true-up
// sits at the month's last second. No total is read from it; it must still be
// what it says.
// ═══════════════════════════════════════════════════════════════════════════
describe('the revenue book\'s running balance (10/3 review)', () => {
  const running = async () => (await db.query<{ amount: string; balance_after: string }>(
    `SELECT amount::text AS amount, balance_after::text AS balance_after
       FROM platform_revenue_ledger ORDER BY created_at, id`)).rows
    .map(r => [Number(r.amount), Number(r.balance_after)])
  const ref = (n: number) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`

  it('a row written for an earlier day is in every later row\'s running balance', async () => {
    await recordPlatformRevenue({ type: 'banking_spread', amount: 5, referenceId: ref(1), referenceType: 'pos_transaction', at: '2026-09-10T18:00:00Z' })
    await recordPlatformRevenue({ type: 'banking_spread', amount: 2, referenceId: ref(2), referenceType: 'pos_transaction', at: '2026-09-20T18:00:00Z' })
    // Booked after the fact, on the day it was earned.
    await recordPlatformRevenue({ type: 'banking_spread', amount: 1.04, referenceId: ref(3), referenceType: 'pos_transaction', at: '2026-09-15T18:00:00Z' })
    expect(await running()).toEqual([[5, 5], [1.04, 6.04], [2, 8.04]])
  })

  it('a live row written while this month\'s true-up sits at the month\'s last second runs before it', async () => {
    // The current month's true-up is dated the month's last second — after "now".
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, reference_type, created_at)
       VALUES ('adjustment', 3.10, 3.10, 'processing_margin_true_up', date_trunc('month', NOW()) + interval '1 month' - interval '1 second')`)
    await recordPlatformRevenue({ type: 'screening_margin', amount: 5, referenceId: ref(4), referenceType: 'background_check' })
    expect(await running()).toEqual([[5, 5], [3.10, 8.10]])
  })

  it('a month\'s true-up landing before later months\' rows is in their running balance', async () => {
    await recordPlatformRevenue({ type: 'screening_margin', amount: 5, referenceId: ref(5), referenceType: 'background_check', at: '2026-08-05T18:00:00Z' })
    await db.query(
      `INSERT INTO stripe_processing_costs (stripe_txn_id, txn_type, category, amount, posted_at, period_start, period_end)
       VALUES ('o_jul_rb', 'network_cost', 'card_interchange', 0.24, '2026-08-02T05:21:00Z', '2026-07-01', '2026-07-31')`)
    const r = await trueUpProcessingMargin('2026-07-01')
    expect(r.adjustment).toBe(-0.24)
    expect(await running()).toEqual([[-0.24, -0.24], [5, 4.76]])
    // Replacing it (the nightly re-run) keeps it right.
    await trueUpProcessingMargin('2026-07-01')
    expect(await running()).toEqual([[-0.24, -0.24], [5, 4.76]])
  })

  it('restating from the start rebuilds the whole running balance from $0, and a second run changes nothing', async () => {
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after, created_at) VALUES
         ('banking_spread', 1.00, 99.00, '2026-07-01T12:00:00Z'),
         ('screening_margin', 5.00, 5.00, '2026-07-02T12:00:00Z'),
         ('adjustment', -0.50, 0.00, '2026-07-03T12:00:00Z')`)
    const exec = async (sql: string, params?: unknown[]) => (await db.query(sql, params as any[])).rows
    expect(await restateRunningBalance(exec, '-infinity')).toBe(3)
    expect(await running()).toEqual([[1, 1], [5, 6], [-0.5, 5.5]])
    expect(await restateRunningBalance(exec, '-infinity')).toBe(0)
  })
})

/**
 * S650 (Nic): GAM's own earnings, written down when they are earned.
 *
 * "Where is that $5 from that first background check?" — in the Stripe balance,
 * and nowhere else. Every other piece of GAM revenue (the card spread, the
 * per-unit platform fee) posts a row to platform_revenue_ledger; screening
 * margin never did, so the earnings figures either missed it or estimated it
 * by counting checks.
 *
 * One helper, so anything that earns GAM money records it the same way and the
 * running balance stays a real running balance.
 */
import type { PoolClient } from 'pg'
import type { PlatformRevenueTypeValue } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { logger } from '../lib/logger'

/**
 * Every kind of GAM earnings row, from the one list that mirrors
 * platform_revenue_ledger_type_check (PLATFORM_REVENUE_TYPES in
 * packages/shared/src/money.ts). S655: 'flexpay_subscription' is FlexPay's $25,
 * booked when the month's pull is collected.
 */
export type PlatformRevenueType = PlatformRevenueTypeValue

export interface PlatformRevenueEntry {
  type: PlatformRevenueType
  amount: number
  referenceId?: string | null
  referenceType?: string | null
  propertyId?: string | null
  notes?: string | null
  /** S650: the processing fee the customer paid, for the monthly true-up. */
  customerFeeCharged?: number | null
  /**
   * 10/3: when the money was earned, for a row written down after the fact (the
   * deploy-day data script books the register fees and a bank-debit cost that
   * were never booked, each on its own day; the nightly true-up books a card
   * sale's fee that missed its after-commit booking). Live callers leave it
   * out: now.
   *
   * A row written for an earlier day lands BEFORE rows already on the book, so
   * every later row's balance_after is restated to include it
   * (restateRunningBalance) — the column stays a true running balance in
   * (created_at, id) order. No total is ever read from balance_after; every
   * figure GAM shows is a SUM(amount).
   */
  at?: string | Date | null
}

/**
 * Post one earnings row. Best-effort by design: GAM failing to WRITE DOWN a
 * fee must never fail the thing that earned it (a screening the applicant has
 * already paid for). A missed row is recoverable from Stripe; a refused
 * screening is not.
 *
 * Idempotent per (type, reference): the same screening cannot be booked twice.
 *
 * S655: pass `client` to book the row inside the caller's transaction, so the
 * earnings land with the money that earned them (the FlexPay $25 commits with
 * the pull it rode on, or not at all). The write runs under a SAVEPOINT there:
 * a failed write is rolled back to it and logged, and the caller's transaction
 * carries on exactly as it would without one.
 *
 * Amounts are positive, except an 'adjustment', which may be negative (money
 * taken back off the book: a FlexPay $25 whose pull the bank took back). A $0
 * row is never written.
 *
 * Inside a transaction, pass its client — unless that transaction goes on to
 * wait on something slow (a card capture) before it commits: then book after
 * it commits, with recordPlatformRevenueOnceCommitted, so the ledger lock is
 * never held across that wait. Without a client the row is written on a
 * connection of its own under the ledger lock; a caller whose transaction
 * already holds that lock (any settle that posted through
 * allocation.postPlatformLedgerEntry) would wait on itself. That wait gives up
 * after OWN_TRANSACTION_LOCK_TIMEOUT and is logged as a missed row, so it can
 * never hang a pooled connection or a webhook.
 */
export async function recordPlatformRevenue(e: PlatformRevenueEntry, client?: PoolClient): Promise<void> {
  if (!client) {
    // No caller transaction: a short one of its own, so the running balance
    // is read and written under the same ledger lock as every other writer.
    let own: PoolClient | null = null
    try {
      own = await getClient()
      const c = own
      await c.query('BEGIN')
      await c.query(`SET LOCAL lock_timeout = '${OWN_TRANSACTION_LOCK_TIMEOUT}'`)
      await writeRevenueRow(e, async (sql, params) => (await c.query(sql, params)).rows, true)
      await c.query('COMMIT')
    } catch (err) {
      if (own) await own.query('ROLLBACK').catch(() => {})
      logRevenueMiss(err, e)
    } finally {
      own?.release()
    }
    return
  }
  await client.query('SAVEPOINT platform_revenue_row')
  try {
    await writeRevenueRow(e, async (sql, params) => (await client.query(sql, params)).rows, true)
    await client.query('RELEASE SAVEPOINT platform_revenue_row')
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT platform_revenue_row').catch(() => {})
    logRevenueMiss(err, e)
  }
}

/**
 * 10/3 (review): book an earnings row once the transaction that earned it has
 * COMMITTED — never inside it.
 *
 * The ledger's running balance is written under one global lock. Taken inside
 * a register sale's transaction, it was held through the card capture (a
 * Stripe call made before that transaction commits), and every other writer of
 * GAM's earnings — rent settling in the webhooks, screenings, FlexPay, the
 * true-up — queued behind the slowest card reader; one with no transaction of
 * its own gave up after OWN_TRANSACTION_LOCK_TIMEOUT and lost its row.
 *
 * So the caller hands over its transaction's id (pg_current_xact_id()) and
 * this asks Postgres how that transaction ended: committed → the row is
 * written on its own short transaction (recordPlatformRevenue, no client);
 * rolled back → nothing is written; still open after `maxWaitMs` → given up,
 * and the nightly true-up books it (bookUnbookedCardSaleFees). `stillThere`
 * confirms the thing that earned it survived (a savepoint can roll back a
 * part of a transaction that committed). Never throws.
 */
export type CommittedBookingOutcome = 'booked' | 'rolled_back' | 'gave_up'

export async function recordPlatformRevenueOnceCommitted(
  e: PlatformRevenueEntry,
  xid: string,
  opts: { stillThere?: () => Promise<boolean>; maxWaitMs?: number } = {},
): Promise<CommittedBookingOutcome> {
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000
  const started = Date.now()
  let delay = 10
  try {
    for (;;) {
      const [st] = await query<{ s: string | null }>(`SELECT pg_xact_status($1::xid8) AS s`, [xid])
      const status = st?.s ?? null
      if (status === 'committed') {
        if (opts.stillThere && !(await opts.stillThere())) return 'rolled_back'
        await recordPlatformRevenue(e)
        return 'booked'
      }
      if (status !== 'in progress') return status === 'aborted' ? 'rolled_back' : 'gave_up'
      if (Date.now() - started >= maxWaitMs) {
        logger.warn({ type: e.type, referenceId: e.referenceId },
          '[platform-revenue] the transaction that earned this is still open — the nightly true-up will book it')
        return 'gave_up'
      }
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, delay); t.unref?.() })
      delay = Math.min(delay * 2, 250)
    }
  } catch (err) {
    logger.warn({ err, type: e.type, referenceId: e.referenceId },
      '[platform-revenue] could not wait for the sale to commit — the nightly true-up will book it')
    return 'gave_up'
  }
}

type RevenueExec = (sql: string, params?: unknown[]) => Promise<any[]>

/**
 * S653 (Nic): "any demo money should not be billed. It should not exist in the
 * system at all." A payment taken for a demo account, or for GAM's own system
 * account, is not GAM processing revenue — the same rule writeRevenueRow
 * (below) applies to every row it writes. 10/3 (review): the Processing Margin
 * card (stripeCosts) counted them, and the true-up, which IS the card's figure,
 * then put their fees on the book anyway as an adjustment. Every query that
 * picks out GAM's processing payments uses this one SQL test.
 *
 * `poolIsReal`: a background check an applicant pays through GAM's renter
 * pool is anchored at GAM's own system account (the pool intake,
 * landlords.is_system) and it is real money from a real applicant — the
 * screening books it the same way (recordScreeningEarnings names no property).
 * Only a demo account's screening is left out.
 */
export function realLandlordSql(col: string, opts: { poolIsReal?: boolean } = {}): string {
  return `EXISTS (SELECT 1 FROM landlords own WHERE own.id = ${col} AND own.is_demo IS NOT TRUE`
    + `${opts.poolIsReal ? '' : ' AND own.is_system IS NOT TRUE'})`
}

/**
 * 10/3 (review): the statuses of a register / pay-link card sale whose money
 * is on GAM's Stripe balance, GAM's card fee in it. A refund at the register is
 * paid back in cash, by check or onto a charge account — never back to the
 * card through Stripe (routes/pos.ts POST /transactions/:id/refund) — so a sale
 * refunded in full is still a charge on GAM's balance, the landlord is still
 * paid for it, and GAM keeps its fee (decisions Q4: GAM keeps the card fee it
 * already earned). Only a void says the sale never happened, and a card sale
 * cannot be voided. Every query that picks out these sales uses this one list:
 * both admin cards, the nightly booking of missed fees, the data script.
 */
export const CARD_SALE_ON_BALANCE_STATUSES = ['completed', 'partial_refund', 'refunded'] as const
export const cardSaleOnBalanceSql = (col: string): string =>
  `${col} IN (${CARD_SALE_ON_BALANCE_STATUSES.map(s => `'${s}'`).join(', ')})`

/**
 * 10/3 (review): a property can pass GAM's monthly platform fee to its tenants
 * (platform_fee_accruals.payer = 'tenant'): the next rent charge adds it on top
 * (services/rentCharge), so the remittance's processing_fee_amount carries the
 * card or bank fee AND that platform fee. The platform fee is not processing
 * revenue. This names, for each tenant-paid accrual, the remittance whose
 * charge carried it: the newest one applied to the accrual's tenant_charge_id
 * row at or before the moment it was linked (rentCharge links it in the same
 * transaction that writes the remittance, so the two share a timestamp; a later
 * charge of the same row — a retry after a failure — did not carry it).
 * Columns: accrual_id, property_id, amount, remittance_id.
 */
export const TENANT_PLATFORM_FEE_CHARGES_SQL = `
  SELECT a.id AS accrual_id, a.property_id, a.total_amount AS amount, pick.remittance_id
    FROM platform_fee_accruals a
    CROSS JOIN LATERAL (
      SELECT ra.remittance_id
        FROM remittance_applications ra
        JOIN tenant_remittances r2 ON r2.id = ra.remittance_id
       WHERE ra.payment_id = a.tenant_charge_id AND r2.created_at <= a.updated_at
       ORDER BY r2.created_at DESC, r2.id DESC
       LIMIT 1) pick
   WHERE a.payer = 'tenant' AND a.tenant_charge_id IS NOT NULL AND a.total_amount > 0`

/** The tenant-paid platform fee each remittance carried (remittance_id, amt). */
export const TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL = `
  SELECT remittance_id, SUM(amount) AS amt FROM (${TENANT_PLATFORM_FEE_CHARGES_SQL}) tpf GROUP BY remittance_id`

/** The ledger's one lock (allocation.postPlatformLedgerEntry takes the same). */
const PLATFORM_REVENUE_LOCK_SQL = `pg_advisory_xact_lock(hashtextextended('platform_revenue', 0))`

/**
 * How long a write with no caller transaction waits for the ledger lock. Any
 * real holder lets go in well under a second; a wait this long is a caller
 * holding the lock in its own open transaction (see recordPlatformRevenue).
 */
const OWN_TRANSACTION_LOCK_TIMEOUT = '10s'

async function writeRevenueRow(e: PlatformRevenueEntry, exec: RevenueExec, inTransaction = false): Promise<void> {
  // Earnings are always money in. Only an 'adjustment' may take money back off
  // the book (S655: a FlexPay $25 whose pull the bank took back), and never by
  // $0.
  if (e.type === 'adjustment' ? !(Number.isFinite(e.amount) && e.amount !== 0) : !(e.amount > 0)) return
  // S653 (Nic): "any demo money should not be billed. It should not exist in
  // the system at all." A row tied to a demo or GAM-internal account is not
  // revenue and never reaches the book — no charge, and therefore never a
  // reversal of one either.
  if (e.propertyId) {
    const [owner] = await exec(
      `SELECT l.is_system, l.is_demo FROM properties p JOIN landlords l ON l.id = p.landlord_id WHERE p.id = $1`,
      [e.propertyId]) as Array<{ is_system: boolean; is_demo: boolean }>
    if (owner && (owner.is_system || owner.is_demo)) return
  }
  // The running balance: the same lock allocation takes to post its rows
  // (allocation.postPlatformLedgerEntry), so two writers can never read the
  // same previous balance. Taken before the duplicate check, so two writers of
  // the same reference cannot both find it missing.
  if (inTransaction) await exec(`SELECT ${PLATFORM_REVENUE_LOCK_SQL}`)
  if (e.referenceId) {
    const [dup] = await exec(
      `SELECT id FROM platform_revenue_ledger
        WHERE type = $1 AND reference_id = $2 AND reference_type IS NOT DISTINCT FROM $3
        LIMIT 1`,
      [e.type, e.referenceId, e.referenceType ?? null])
    if (dup) return
  }
  const [prev] = await exec(
    `SELECT balance_after FROM platform_revenue_ledger ORDER BY created_at DESC, id DESC LIMIT 1`) as Array<{ balance_after: string }>
  const balanceAfter = Math.round(((prev ? parseFloat(prev.balance_after) : 0) + e.amount) * 100) / 100
  const [row] = await exec(
    `INSERT INTO platform_revenue_ledger
       (type, amount, balance_after, reference_id, reference_type, property_id, notes, customer_fee_charged, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, NOW()))
     RETURNING id, created_at`,
    [e.type, e.amount, balanceAfter, e.referenceId ?? null, e.referenceType ?? null,
     e.propertyId ?? null, e.notes ?? null, e.customerFeeCharged ?? null,
     e.at == null ? null : (e.at instanceof Date ? e.at.toISOString() : e.at)]) as Array<{ id: string; created_at: Date }>
  // 10/3 (review): the row is not the newest on the book — it was written for
  // an earlier day, or the month's true-up already sits at the month's last
  // second. "The latest row's balance + this amount" is then the wrong running
  // balance for it AND leaves it out of every later row's. Restate from here.
  if (row) {
    const [later] = await exec(
      `SELECT 1 FROM platform_revenue_ledger WHERE (created_at, id) > ($1::timestamptz, $2::uuid) LIMIT 1`,
      [row.created_at, row.id])
    if (later) await restateRunningBalance(exec, row.created_at)
  }
}

/**
 * 10/3 (review): make balance_after the true running balance — SUM(amount) in
 * (created_at, id) order, the order every writer reads "the latest row" in —
 * for every row at or after `from`. Rows written for an earlier day (the data
 * script, a late-booked card sale fee) and a month's true-up (dated the
 * month's last second, so in the current month it sits AFTER rows written
 * later in real time) otherwise left it drifting: 18 of 46 rows by the evening
 * of 10/3, the newest row $89.23 below the book's total.
 *
 * balance_after is informational: no total anywhere is read from it (every
 * figure is a SUM(amount)), so a drift never moved a number — but a running
 * balance that is not one should not be on the book. Writers outside this file
 * (allocation.postPlatformLedgerEntry, the platform-fee accrual) still append
 * "latest + amount"; a row of theirs written while a month-end true-up sits
 * ahead of it is restated by the next nightly true-up, which restates its whole
 * months.
 *
 * It starts from the balance of the row just before `from` (one index read,
 * so a live write restating the few rows after it stays cheap); '-infinity'
 * restates the whole book from $0 (the deploy-day data script does that once).
 *
 * Call it holding the ledger lock (every writer takes it), inside the
 * transaction that changed the book. Returns how many rows changed.
 */
export async function restateRunningBalance(exec: RevenueExec, from: string | Date): Promise<number> {
  const rows = await exec(
    `WITH base AS (
       SELECT COALESCE((SELECT balance_after FROM platform_revenue_ledger
                         WHERE created_at < $1::timestamptz
                         ORDER BY created_at DESC, id DESC LIMIT 1), 0) AS b
     ), run AS (
       SELECT l.id, (SELECT b FROM base)
                    + SUM(l.amount) OVER (ORDER BY l.created_at, l.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS bal
         FROM platform_revenue_ledger l
        WHERE l.created_at >= $1::timestamptz
     )
     UPDATE platform_revenue_ledger t SET balance_after = run.bal
       FROM run
      WHERE t.id = run.id AND t.balance_after IS DISTINCT FROM run.bal
     RETURNING t.id`,
    [from instanceof Date ? from.toISOString() : from])
  return rows.length
}

function logRevenueMiss(err: unknown, e: PlatformRevenueEntry): void {
  logger.error({ err, type: e.type, referenceId: e.referenceId },
    '[platform-revenue] could not record earnings — the money landed, the row did not')
}

/**
 * S650 (Nic): "is it five dollars flat on the markup plus any upcharge on the
 * card fee, or is it just five dollars flat?"
 *
 * Both. The applicant is charged Checkr's cost + GAM's $5 + any state tax, and
 * then card processing at GAM's customer rate (3.5% + $0.55) on that subtotal.
 * Stripe's own cost is lower, so a screening earns GAM the $5 AND the card
 * spread — about 49c on a $44.99 check. Recording only the $5 understates every
 * screening; across a hundred thousand of them that is real money.
 *
 * The cost side comes from platform_processing_rates, the same row rent uses,
 * so the two can never drift apart.
 */
export async function recordScreeningEarnings(args: {
  backgroundCheckId: string
  /** GAM's flat margin inside the price. */
  gamMarginUsd: number
  /** What the applicant was charged for card processing. */
  processingChargedUsd: number
  /** The whole amount that hit the card. */
  totalChargedUsd: number
}): Promise<void> {
  await recordPlatformRevenue({
    type: 'screening_margin',
    amount: round2(args.gamMarginUsd),
    referenceId: args.backgroundCheckId,
    referenceType: 'background_check',
    notes: 'Screening margin (applicant paid; settles to the platform)',
  })
  // 10/3: the screening's own record says what GAM kept, too. Nothing set
  // platform_net, so every screening carried the column's stale $15 default
  // (the old model) beside a $5 margin on the book.
  await query(`UPDATE background_checks SET platform_net = $2 WHERE id = $1 AND platform_net IS DISTINCT FROM $2`,
    [args.backgroundCheckId, round2(args.gamMarginUsd)])
    .catch((err) => logger.error({ err, backgroundCheckId: args.backgroundCheckId },
      '[platform-revenue] could not write the screening\'s platform_net'))
  try {
    const rate = await queryOne<{ stripe_cost_flat: string; stripe_cost_percent: string; stripe_cost_cap: string | null }>(
      `SELECT stripe_cost_flat, stripe_cost_percent, stripe_cost_cap
         FROM platform_processing_rates
        WHERE payment_method = 'card' AND effective_until IS NULL LIMIT 1`)
    if (!rate) return
    const cap = rate.stripe_cost_cap == null ? Number.POSITIVE_INFINITY : parseFloat(rate.stripe_cost_cap)
    const stripeCost = Math.min(
      parseFloat(rate.stripe_cost_flat) + args.totalChargedUsd * (parseFloat(rate.stripe_cost_percent) / 100),
      cap)
    const spread = round2(args.processingChargedUsd - stripeCost)
    if (spread > 0) {
      await recordPlatformRevenue({
        type: 'banking_spread',
        amount: spread,
        referenceId: args.backgroundCheckId,
        referenceType: 'background_check',
        customerFeeCharged: args.processingChargedUsd,
        notes: 'Card spread on a background check',
      })
    }
  } catch (err) {
    logger.error({ err, backgroundCheckId: args.backgroundCheckId },
      '[platform-revenue] could not record the screening card spread')
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

/**
 * 10/3 (review): GAM's card fee on every register and pay-link card sale of
 * `month` that has no earnings row yet — booked on the sale's own day, inside
 * the caller's transaction (which holds the ledger lock). A sale's fee is
 * booked right after the sale commits (services/posSale, through
 * recordPlatformRevenueOnceCommitted); this picks up any that missed it (the
 * API restarted in between, the sale's transaction stayed open too long).
 * The same rule as the deploy-day data script's step 2. Returns how many.
 */
export async function bookUnbookedCardSaleFees(client: PoolClient, month: string): Promise<{ count: number; amount: number }> {
  const { rows } = await client.query<{ id: string; fee: string; property_id: string | null; at: Date; online: boolean }>(
    `SELECT pt.id, pt.platform_fee::text AS fee, pt.property_id, pt.created_at AS at,
            (pt.pay_link_id IS NOT NULL OR pt.paid_online) AS online
       FROM pos_transactions pt
      WHERE pt.payment_method IN ('card', 'card_on_file') AND pt.stripe_payment_intent_id IS NOT NULL
        AND ${cardSaleOnBalanceSql('pt.status')} AND pt.platform_fee > 0
        AND to_char(pt.created_at, 'YYYY-MM') = $1
        -- S653: a demo or GAM-internal account's sale is not revenue (the
        -- writer skips it); 10/3 (review): leave it out here too, so the count
        -- this returns is what was really booked.
        AND ${realLandlordSql('pt.landlord_id')}
        AND NOT EXISTS (SELECT 1 FROM platform_revenue_ledger l
                         WHERE l.type = 'banking_spread' AND l.reference_type = 'pos_transaction'
                           AND l.reference_id = pt.id)
      ORDER BY pt.created_at`, [month])
  let amount = 0
  for (const r of rows) {
    const fee = Number(r.fee)
    await recordPlatformRevenue({
      type: 'banking_spread', amount: fee, customerFeeCharged: fee,
      referenceId: r.id, referenceType: 'pos_transaction', propertyId: r.property_id, at: r.at,
      notes: r.online ? 'Card fee on a pay link payment (booked by the nightly true-up)' : 'Card fee on a register card sale (booked by the nightly true-up)',
    }, client)
    amount += fee
  }
  return { count: rows.length, amount: round2(amount) }
}

/**
 * 10/3 (review): the platform fee a property passed to its tenants
 * (platform_fee_accruals.payer = 'tenant'), booked as GAM's platform-fee
 * earnings once the rent payment that carried it CLEARED in `month` — on that
 * day, inside the caller's transaction (which holds the ledger lock).
 *
 * A landlord-paid platform fee is booked when it accrues (jobs/
 * platformFeeAccrual, reference 'platform_fee_accrual'); a tenant-paid one was
 * booked nowhere of its own — it rode inside the payment's processing fee, so
 * the Processing Margin card and its true-up counted it as processing. Both
 * now leave it out of processing, and this books it under the same reference
 * the landlord-paid fee uses (one row per accrual, ever). Returns how many.
 */
export async function bookTenantPaidPlatformFees(client: PoolClient, month: string): Promise<{ count: number; amount: number }> {
  const { rows } = await client.query<{ accrual_id: string; property_id: string | null; amount: string; at: Date }>(
    `SELECT tpf.accrual_id, tpf.property_id, tpf.amount::text AS amount, r.settled_at AS at
       FROM (${TENANT_PLATFORM_FEE_CHARGES_SQL}) tpf
       JOIN tenant_remittances r ON r.id = tpf.remittance_id
      WHERE r.status = 'settled' AND r.settled_at IS NOT NULL
        AND r.payment_method IN ('card', 'ach') AND r.stripe_payment_intent_id IS NOT NULL
        AND to_char(r.settled_at, 'YYYY-MM') = $1
        AND ${realLandlordSql('r.landlord_id')}
        AND NOT EXISTS (SELECT 1 FROM platform_revenue_ledger l
                         WHERE l.type = 'platform_fee_subscription' AND l.reference_type = 'platform_fee_accrual'
                           AND l.reference_id = tpf.accrual_id)
      ORDER BY r.settled_at, tpf.accrual_id`, [month])
  let amount = 0
  for (const r of rows) {
    const fee = Number(r.amount)
    await recordPlatformRevenue({
      type: 'platform_fee_subscription', amount: fee,
      referenceId: r.accrual_id, referenceType: 'platform_fee_accrual', propertyId: r.property_id, at: r.at,
      notes: 'Platform fee the property passes to its tenants, paid with rent (booked when the payment cleared)',
    }, client)
    amount += fee
  }
  return { count: rows.length, amount: round2(amount) }
}

/**
 * S650 (Nic): "I want those numbers to match up."
 *
 * The per-payment `banking_spread` rows are an ESTIMATE — Stripe is on
 * unbundled pricing, so it attributes no cost to an individual charge and bills
 * the real cost as daily aggregates. The estimate uses a deliberately
 * conservative cost (2.9% + $0.26), so it runs LOW: September's estimate was
 * $41.75 against a real margin of $74.86.
 *
 * Once Stripe's invoices for a month are recorded (stripe_processing_costs),
 * this posts ONE adjustment that makes the ledger's month equal what actually
 * happened. After it runs, the revenue ledger and the Processing Margin card
 * are the same number — because the figure IS the card's (10/3):
 * stripeCosts.computeMarginMonths, so the two cannot drift apart. That brings
 * the card's rules into the book too:
 *   - every payment on GAM's balance counts — register and pay-link card sales
 *     (one refunded at the register included: the money stayed), online stay
 *     deposits, business invoice and register card payments, and the bank pull
 *     of a landlord's GAM fees, beside rent and screenings;
 *   - a platform fee a property passes to its tenants is not processing: it is
 *     booked as a platform fee when the rent payment carrying it clears
 *     (bookTenantPaidPlatformFees);
 *   - a bank payment's fee counts the day it CLEARED, never while clearing;
 *   - Stripe's bank-feed charges are a cost (Nic 10/3);
 *   - Stripe's sales tax on its own fees is a cost (it left the balance);
 *   - 10/4 (review, fix pass 1): a fee Stripe charged for a dispute or a
 *     returned payment is a cost in the month it was charged, and what came
 *     back for it — off a payee's payout, or the fee billed to the tenant once
 *     paid — counts in the month it came back, so a recovered fee never reads
 *     as GAM's loss (stripeCosts.FEES_BACK_KINDS).
 *
 * Before it reads what is recorded, it books any register / pay-link card fee
 * of the month that missed its after-commit booking (bookUnbookedCardSaleFees).
 *
 * Idempotent: re-running replaces its own previous true-up for that month.
 * `dryRun` computes the same figures and writes nothing (the deploy-day data
 * script shows what each month would become before it is run for real).
 */
/**
 * The revenue rows that ARE the processing margin on the book before a true-up
 * (one definition: the true-up and the deploy-day data script's preview both
 * read it). See trueUpProcessingMargin.
 */
export const PROCESSING_MARGIN_ON_THE_BOOK_SQL = `(type = 'banking_spread'
               OR (type = 'adjustment' AND reference_type IN ('payment', 'background_check', 'dispute_spread_reversal')))`

export async function trueUpProcessingMargin(monthIso: string, opts: { dryRun?: boolean } = {}): Promise<{
  month: string; feesCharged: number; stripeCost: number; feesBack: number; actualMargin: number
  alreadyRecorded: number; adjustment: number; previousTrueUp: number
}> {
  const month = monthIso.slice(0, 7)
  const { marginForMonth } = await import('./stripeCosts')
  const card = await marginForMonth(month)
  const feesCharged = round2(card.feeRevenue)
  const stripeCost = round2(card.stripeCost)
  const actualMargin = round2(card.margin)
  // 10/4 (review, fix pass 1): disputes and returned payments — a fee Stripe
  // charged for one is in stripeCost; what came back for it is here, inside
  // the margin (stripeCosts.FEES_BACK_KINDS).
  const feesBack = round2(card.feesBack?.total ?? 0)
  // Replacing the month's true-up, reading what is recorded, and posting the
  // new row run as ONE transaction under the ledger lock every writer takes
  // (writeRevenueRow, allocation.postPlatformLedgerEntry): no other row can
  // land between the balance read and the insert, and no reader ever sees the
  // month with its old true-up deleted and the new one not yet written.
  let alreadyRecorded = 0
  let adjustment = 0
  let previousTrueUp = 0
  const c = await getClient()
  try {
    await c.query('BEGIN')
    await c.query(`SELECT ${PLATFORM_REVENUE_LOCK_SQL}`)
    // 10/3 (review): any register / pay-link card fee of the month that missed
    // its after-commit booking is booked first, so "already recorded" holds it.
    await bookUnbookedCardSaleFees(c, month)
    // 10/3 (review): a platform fee passed to tenants is not processing — the
    // card leaves it out — so it is booked as the platform fee it is.
    await bookTenantPaidPlatformFees(c, month)
    // Its own previous true-up for the month is REPLACED, not added to — so the
    // figure is recomputed from scratch every time and running it twice cannot
    // double anything.
    const { rows: [prior] } = await c.query<{ amt: string }>(
      `DELETE FROM platform_revenue_ledger
        WHERE type = 'adjustment' AND reference_type = 'processing_margin_true_up'
          AND to_char(date_trunc('month', created_at), 'YYYY-MM') = $1
      RETURNING amount::text AS amt`, [month])
    previousTrueUp = prior ? round2(parseFloat(prior.amt)) : 0
    // What the books already say this month's PROCESSING margin is: the per-payment
    // spreads, plus any correction posted against one of them (a spread reversed
    // because it was booked against a payment that does not exist, or — 10/4,
    // review fix pass 1 — taken back for a disputed charge under the superseded
    // dispute rule: the card's feesBack counts that dispute, so the row is part
    // of the same figure and must not be taken off twice). Platform fees
    // and screening margin are separate earnings and are not part of this figure.
    const { rows: [recorded] } = await c.query<{ amt: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS amt FROM platform_revenue_ledger
        WHERE to_char(date_trunc('month', created_at), 'YYYY-MM') = $1
          AND ${PROCESSING_MARGIN_ON_THE_BOOK_SQL}`,
      [month])
    alreadyRecorded = round2(parseFloat(recorded.amt))
    adjustment = round2(actualMargin - alreadyRecorded)
    if (adjustment !== 0) {
      const { rows: [prev] } = await c.query<{ balance_after: string }>(
        `SELECT balance_after FROM platform_revenue_ledger ORDER BY created_at DESC, id DESC LIMIT 1`)
      const balanceAfter = round2((prev ? parseFloat(prev.balance_after) : 0) + adjustment)
      await c.query(
        `INSERT INTO platform_revenue_ledger
           (type, amount, balance_after, reference_id, reference_type, notes, created_at)
         VALUES ('adjustment', $1, $2, NULL, 'processing_margin_true_up', $3,
                 date_trunc('month', $4::date) + interval '1 month' - interval '1 second')`,
        [adjustment, balanceAfter,
         `True-up for ${month}: payers paid ${feesCharged.toFixed(2)} in processing fees on payments that cleared, Stripe charged ${stripeCost.toFixed(2)} (bank feeds and its sales tax included)${feesBack !== 0 ? `, disputes and returned payments ${feesBack > 0 ? 'added' : 'took'} ${Math.abs(feesBack).toFixed(2)}` : ''} — the estimates on the day came to ${alreadyRecorded.toFixed(2)}.`,
         `${month}-01`])
    }
    // 10/3 (review): the true-up sits at the month's last second (in the
    // current month, AFTER rows written later in real time), and the one it
    // replaced is gone — restate the month's running balance and everything
    // after it, so balance_after stays a real running balance.
    await restateRunningBalance(async (sql, params) => (await c.query(sql, params as any[])).rows, `${month}-01`)
    await c.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    c.release()
  }
  if (adjustment !== previousTrueUp && !opts.dryRun) {
    logger.info({ month, feesCharged, stripeCost, actualMargin, alreadyRecorded, adjustment },
      '[platform-revenue] processing margin trued up to Stripe\'s real invoices')
  }
  return { month, feesCharged, stripeCost, feesBack, actualMargin, alreadyRecorded, adjustment, previousTrueUp }
}

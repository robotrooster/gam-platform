/**
 * S642 (Nic): "Instead of showing $199 fees from Stripe I want to see our
 * margin on that too."
 *
 * Pulls what Stripe actually charged GAM and stores it, so margin is a figure
 * the platform holds rather than one somebody has to go ask Stripe for.
 *
 * THE SHAPE OF THE DATA IS NOT OUR CHOICE. The account is on unbundled
 * (interchange-plus) pricing: every charge balance-transaction returns fee = 0
 * and fee_details = [], and the real costs arrive as separate daily aggregates —
 * one "Transaction network costs" line, one "Stripe volume fee" line, and so on,
 * each covering that day's entire card volume. So this syncs those lines.
 *
 * 10/3 (Nic: "Is that actually accurate?" — the math was right, the picture
 * incomplete mid-month). Two cards read this file:
 *
 *   PROCESSING MARGIN — what payers paid GAM in processing fees, minus what
 *   Stripe charged GAM, month by month, AND payment by payment:
 *     - every payment that landed on GAM's Stripe balance with a GAM fee in it
 *       is on it: rent and bills by card or bank, register and pay-link card
 *       sales (one refunded at the register too — the refund was paid back by
 *       hand and the money stayed), online stay deposits, business invoice
 *       payments and business register card sales, background checks, and the
 *       bank pull that collects GAM's own fees from a landlord. Their Stripe
 *       costs were always inside the daily totals; leaving their fees out made
 *       the margin read low.
 *     - a platform fee a property passes to its tenants rides inside the rent
 *       payment's processing fee; it is not processing and is left out (it is
 *       booked as the platform fee it is — platformRevenue.bookTenantPaidPlatformFees).
 *     - a bank payment's fee counts only once the payment has CLEARED (money
 *       plan §0.0: money received = the day it arrived; Nic 10/3). Until then
 *       it, and what Stripe took on it, show apart as "still clearing".
 *     - what Stripe took on each payment: a bank payment's own fee, exactly; a
 *       card payment's share of its day's card costs, split by size (Stripe
 *       bills cards only as a day's total); a card day Stripe has not posted
 *       yet is an estimate at the month's own observed rate (the month
 *       before's until the month's first card day posts; Stripe's list price
 *       when neither month has one), labeled so, and the card names the rate.
 *     - a fee the landlord covers (ach_fee_payer = 'landlord') is GAM's fee
 *       like one the payer paid on top (gamFeeOnRemittance).
 *     - Stripe's fee on a bank payment the card does not list (a FlexPay pull,
 *       a GAM fee charged on its own) waits, like every bank payment's, until
 *       that payment clears.
 *     - Stripe's charges for landlords' bank feeds (Financial Connections) are
 *       GAM costs on the card (Nic 10/3 — this reverses S650's "beside the
 *       margin, not in it").
 *
 *   GAM'S OWN MONEY — whose money the Stripe balance is (splitPlatformBalance).
 */
import Stripe from 'stripe'
import { query } from '../db'
import { logger } from '../lib/logger'
import { stripeSecretKeyOrNull } from '../lib/stripe'
import { PROCESSING_FEES, PLATFORM_FEES, processingFeeFor } from '@gam/shared'
// The demo / GAM-internal account rule, which card sales are on GAM's balance,
// and the platform fee a tenant's rent payment carried live with the revenue
// book's writer. (Imported this way round: platformRevenue is loaded by most of
// the API, and must never load this file, which reads the Stripe key when it
// loads.)
import {
  realLandlordSql, cardSaleOnBalanceSql, CARD_SALE_ON_BALANCE_STATUSES, TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL,
} from './platformRevenue'
export { CARD_SALE_ON_BALANCE_STATUSES }

const key = stripeSecretKeyOrNull()
const defaultStripe = key ? new Stripe(key, { apiVersion: '2023-10-16' }) : null

/** Categories, in the order a human would want them read. */
export const COST_CATEGORIES = [
  'card_interchange',
  'stripe_volume_fee',
  'authorization_boost',
  'per_authorization',
  'radar',
  'bank_debit_fee',
  'card_fee',
  'bank_linking',
  'other',
] as const
export type CostCategory = typeof COST_CATEGORIES[number]

export const COST_LABELS: Record<CostCategory, string> = {
  card_interchange:    'Card network interchange',
  stripe_volume_fee:   'Stripe volume fee',
  authorization_boost: 'Authorization Boost',
  per_authorization:   'Stripe per-authorization',
  radar:               'Radar (fraud screening)',
  bank_debit_fee:      'Bank debit fee (ACH)',
  card_fee:            'Card fee charged on the charge',
  bank_linking:        'Bank feeds (Financial Connections)',
  other:               'Other Stripe charges',
}

/**
 * Stripe's description prose is the only thing distinguishing these, so the
 * mapping lives in ONE place and the stored row carries our category — a read
 * should never be re-parsing English.
 */
export function categorize(description: string): CostCategory {
  const d = (description || '').toLowerCase()
  if (d.includes('connections'))          return 'bank_linking'
  if (d.includes('radar'))                return 'radar'
  if (d.includes('authorization boost'))  return 'authorization_boost'
  if (d.includes('per-autho'))            return 'per_authorization'
  if (d.includes('network cost'))         return 'card_interchange'
  if (d.includes('volume fee'))           return 'stripe_volume_fee'
  return 'other'
}

/** "(2026-08-01 - 2026-08-31)" → the period the charge covers, when named. */
export function parsePeriod(description: string): { start: string | null; end: string | null } {
  const m = /\((\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\)/.exec(description || '')
  if (m) return { start: m[1], end: m[2] }
  const single = /\((\d{4}-\d{2}-\d{2})\)/.exec(description || '')
  return single ? { start: single[1], end: single[1] } : { start: null, end: null }
}

/**
 * What one Stripe cost line actually took off the balance, in dollars, or null
 * when the line is not a cost.
 *
 * 10/3: Stripe adds sales tax to some of its own fees (Authorization Boost, the
 * bank-feed subscriptions) and states it separately: amount −12.90, fee 0.85,
 * net −13.75. The balance lost $13.75. Storing |amount| dropped the tax — $2.46
 * of it by 10/3 — so the books said Stripe cost less than the balance shows.
 * The net is what left.
 *
 * Stripe posts costs as NEGATIVE balance moves. A non-negative one is not a
 * cost (a reversal, a credit) and is left alone rather than stored as a
 * negative cost that would quietly inflate margin.
 */
export function costLineAmount(t: { amount: number; net?: number | null }): number | null {
  if (t.amount >= 0) return null
  const net = typeof t.net === 'number' ? t.net : t.amount
  return net < 0 ? Math.abs(net) / 100 : null
}

/** The PaymentIntent behind a balance transaction's (expanded) source charge. */
function sourcePaymentIntent(source: unknown): string | null {
  if (!source || typeof source !== 'object') return null
  const pi = (source as any).payment_intent
  if (typeof pi === 'string') return pi
  return typeof pi?.id === 'string' ? pi.id : null
}

export interface SyncResult { scanned: number; stored: number; updated: number; skipped: number }

/**
 * Balance transactions whose own `fee` is something Stripe took off GAM's
 * balance. A bank payment's fee is on its 'payment' line; a card charge carries
 * none under unbundled pricing (its costs are the daily aggregate lines).
 *
 * 10/3 (review): a fee on any OTHER kind of balance transaction left the
 * balance too — a returned bank payment's failure fee, a dispute's fee on its
 * 'adjustment', a fee on a refund or reversal. Reading only 'payment' and
 * 'charge', the first one would never have been recorded and the GAM's Own
 * Money check would have shown it as a gap. Each is recorded the same way,
 * keyed on its own transaction id. (A fee Stripe gives BACK — a negative fee —
 * is not a cost and is not stored; the cost table holds no negative amounts.)
 */
export const FEE_BEARING_TXN_TYPES = [
  'payment', 'charge', 'payment_failure_refund', 'payment_refund', 'payment_reversal', 'refund', 'adjustment',
] as const
type FeeBearingTxnType = typeof FEE_BEARING_TXN_TYPES[number]
const FEE_TXN_WORDS: Record<FeeBearingTxnType, string> = {
  payment:                'Bank debit',
  charge:                 'Card',
  payment_failure_refund: 'Returned bank payment',
  payment_refund:         'Bank payment refund',
  payment_reversal:       'Bank payment reversal',
  refund:                 'Card refund',
  adjustment:             'Adjustment (a dispute or a correction)',
}
const feeTxnCategory = (type: FeeBearingTxnType): CostCategory =>
  type === 'charge' ? 'card_fee' : type.startsWith('payment') ? 'bank_debit_fee' : 'other'

/**
 * 10/3 (review, pass 2): the balance transactions whose fee is Stripe's price
 * for THAT payment — a bank payment's 'payment' line, a card charge's 'charge'
 * line. Only these are tied to their payment (stripe_payment_intent_id).
 *
 * A fee on any other kind — a dispute's, a returned or reversed bank payment's,
 * a refund's — is Stripe charging GAM the day it posts, often weeks or months
 * after the payment. Tied to the payment it rode back into the payment's month:
 * a $15 dispute fee posted Oct 2 on a Sep 3 card payment moved September's
 * "Stripe took" from $217.16 to $232.16, never showed on October's card, read
 * on the payment's row as a share of its day's card costs, and — the nightly
 * true-up running for this month and last only — was never booked once that
 * month was older. It now counts in the month Stripe took it, its payment named
 * in its description.
 */
export const PAYMENT_TIED_TXN_TYPES = ['payment', 'charge'] as const
const isPaymentTiedTxnType = (type: string) => (PAYMENT_TIED_TXN_TYPES as readonly string[]).includes(type)
/**
 * A cost row's payment, read only for the fee types that belong to one — so a
 * row stored before the rule above (a dispute's fee with its PaymentIntent) is
 * still never tied. `t` is the table alias with its dot, or ''.
 */
const tiedPiSql = (t = '') =>
  `(CASE WHEN ${t}txn_type IN (${PAYMENT_TIED_TXN_TYPES.map(x => `'${x}'`).join(', ')}) THEN ${t}stripe_payment_intent_id END)`

async function eachBalanceTransaction(
  s: Stripe, params: Stripe.BalanceTransactionListParams,
  fn: (t: Stripe.BalanceTransaction) => Promise<void>,
): Promise<void> {
  let after: string | undefined
  for (;;) {
    const page: Stripe.ApiList<Stripe.BalanceTransaction> = await s.balanceTransactions.list({
      ...params, limit: 100, ...(after ? { starting_after: after } : {}),
    })
    for (const t of page.data) await fn(t)
    if (!page.has_more) break
    after = page.data[page.data.length - 1]?.id
    if (!after) break
  }
}

/**
 * One row in, or the row it already is brought up to date. Keyed on Stripe's
 * own transaction id, so re-running cannot double-count — double-counting here
 * would silently understate margin, which is the one failure this exists to
 * prevent. A row stored before 10/3 without its sales tax, or without the
 * payment it came from, is corrected the next time the sync sees it.
 */
const UPSERT_COST_SQL = `
  INSERT INTO stripe_processing_costs
    (stripe_txn_id, txn_type, category, description, amount, posted_at, period_start, period_end, stripe_payment_intent_id)
  VALUES ($1,$2,$3,$4,$5, to_timestamp($6), $7, $8, $9)
  ON CONFLICT (stripe_txn_id) DO UPDATE
     SET amount = EXCLUDED.amount,
         stripe_payment_intent_id = COALESCE(stripe_processing_costs.stripe_payment_intent_id, EXCLUDED.stripe_payment_intent_id)
   WHERE stripe_processing_costs.amount IS DISTINCT FROM EXCLUDED.amount
      OR (stripe_processing_costs.stripe_payment_intent_id IS NULL AND EXCLUDED.stripe_payment_intent_id IS NOT NULL)
  RETURNING (xmax = 0) AS inserted`

export async function syncStripeCosts(opts: {
  lookbackDays?: number; stripe?: Stripe
  /**
   * 10/4: where the rows are written — the caller's open transaction (the
   * deploy's data script, so its dry run rolls the sync back with the rest).
   * Default: the pool.
   */
  exec?: SqlExec
} = {}): Promise<SyncResult> {
  const out: SyncResult = { scanned: 0, stored: 0, updated: 0, skipped: 0 }
  const s = opts.stripe ?? defaultStripe
  if (!s) return out
  const run: SqlExec = opts.exec ?? ((sql, params) => query<any>(sql, params as any[]))
  const since = Math.floor(Date.now() / 1000) - (opts.lookbackDays ?? 45) * 86400
  const tally = (rows: Array<{ inserted: boolean }>) => {
    if (!rows.length) out.skipped++
    else if (rows[0].inserted) out.stored++
    else out.updated++
  }

  // ACH debit fees do NOT arrive as their own cost line — they are the `fee`
  // field on the type='payment' balance transaction itself (0.5% of the debit,
  // e.g. $2.33 on $466). Card charges under unbundled pricing carry fee = 0, so
  // this loop finds nothing for them, which is correct: their cost is in the
  // aggregate lines below. 10/3: the source charge is expanded so the row
  // names the payment it belongs to (what Stripe took on THAT payment). 10/3
  // (review): every kind of balance transaction that can carry a fee
  // (FEE_BEARING_TXN_TYPES) — a returned bank payment's or a dispute's too.
  // 10/3 (review, pass 2): only a payment's own fee is tied to it
  // (PAYMENT_TIED_TXN_TYPES); a later fee names the payment in its words and
  // counts in the month Stripe took it.
  for (const type of FEE_BEARING_TXN_TYPES) {
    await eachBalanceTransaction(s, { type, created: { gte: since }, expand: ['data.source'] }, async (t) => {
      out.scanned++
      if (!t.fee || t.fee <= 0) { out.skipped++; return }
      const pi = sourcePaymentIntent(t.source)
      const tied = isPaymentTiedTxnType(type)
      const desc = `${FEE_TXN_WORDS[type]} fee on ${t.id}${!tied && pi ? ` (payment ${pi})` : ''}`
      tally(await run(UPSERT_COST_SQL,
        // Keyed distinctly from any aggregate line that might share the id.
        [`${t.id}:fee`, type, feeTxnCategory(type),
         desc, t.fee / 100, t.created, null, null, tied ? pi : null]))
    })
  }

  for (const type of ['stripe_fee', 'network_cost'] as const) {
    await eachBalanceTransaction(s, { type, created: { gte: since } }, async (t) => {
      out.scanned++
      const amount = costLineAmount(t)
      if (amount == null) { out.skipped++; return }
      const desc = t.description ?? ''
      const period = parsePeriod(desc)
      tally(await run(UPSERT_COST_SQL,
        [t.id, type, categorize(desc), desc, amount, t.created, period.start, period.end, null]))
    })
  }
  logger.info(out, '[stripe-costs] synced what Stripe charged us')
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESSING MARGIN — month by month, payment by payment
// ═══════════════════════════════════════════════════════════════════════════

/** Every kind of payment that lands on GAM's Stripe balance with a fee on it. */
export const MARGIN_PAYMENT_KINDS = [
  'rent_card', 'rent_bank', 'register_card', 'pay_link_card', 'stay_deposit',
  'business_invoice', 'business_register_card', 'background_check', 'landlord_fee_debit',
] as const
export type MarginPaymentKind = typeof MARGIN_PAYMENT_KINDS[number]
export const MARGIN_PAYMENT_KIND_LABEL: Record<MarginPaymentKind, string> = {
  rent_card:              'Card payment',
  rent_bank:              'Bank payment',
  register_card:          'Register card sale',
  pay_link_card:          'Pay link card payment',
  stay_deposit:           'Stay deposit paid online',
  business_invoice:       'Business invoice payment',
  business_register_card: 'Business register card sale',
  background_check:       'Background check',
  landlord_fee_debit:     'GAM fees pulled from a landlord\'s bank',
}

export const COST_BASES = ['exact', 'day_share', 'estimate_unposted', 'none'] as const
export type CostBasis = typeof COST_BASES[number]
export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  exact:             'Stripe\'s own fee on this payment',
  // 10/3 (review): an estimate, and said so. Stripe bills cards only as a
  // day's total, so one payment's part of it is a split by size, never a fee
  // Stripe named for that payment.
  day_share:         'Estimate: this payment\'s share of that day\'s card costs, by size (Stripe bills cards only as a day\'s total)',
  estimate_unposted: 'Estimate until Stripe posts',
  none:              'Stripe has not posted a fee for it',
}
export const PAYMENT_METHOD_LABEL: Record<'card' | 'bank', string> = { card: 'Card', bank: 'Bank' }

/** The label for the part of a month's cost that is an estimate. */
export const ESTIMATE_CATEGORY = 'card_costs_not_posted'
const ESTIMATE_LABEL = 'Card costs Stripe has not posted yet (estimate)'

/**
 * 10/3 (review): which rate a month's not-yet-posted card days were estimated
 * at (computeMarginMonths, rateFor) — so the card says the one it used. Until
 * the month's first card day posts (the 1st-2nd of every month) it is the month
 * before's; with no posted card day in either, Stripe's list price.
 */
export const ESTIMATE_RATE_SOURCES = ['this_month', 'month_before', 'rate_card'] as const
export type EstimateRateSource = typeof ESTIMATE_RATE_SOURCES[number]
export const ESTIMATE_RATE_LABEL: Record<EstimateRateSource, string> = {
  this_month:   'this month\'s own card cost rate (from the card days Stripe has posted)',
  month_before: 'last month\'s card cost rate (Stripe has not posted a card day for this month yet)',
  rate_card:    'Stripe\'s list price for cards (no posted card days this month or last to measure a rate from)',
}

/**
 * Card cost lines Stripe bills for ONE day's card volume. A day is posted once
 * its network-cost line is in (Stripe posts it last, around noon UTC the next
 * day); until then the day's cards are estimated, and any of its lines that did
 * arrive are inside that estimate, never counted beside it.
 */
const CARD_DAY_CATEGORIES = new Set<string>(['card_interchange', 'stripe_volume_fee', 'authorization_boost', 'per_authorization', 'radar'])
const DAY_POSTED_CATEGORY = 'card_interchange'

export interface MarginPaymentInput {
  id: string
  kind: MarginPaymentKind
  method: 'card' | 'bank'
  /** A bank payment still clearing — its fee is not earned yet. */
  clearing: boolean
  /** 'YYYY-MM' on GAM's calendar (Phoenix): settle day, or the day paid while clearing. */
  month: string
  /** 'YYYY-MM-DD' in UTC: the day Stripe bills this charge's card costs under. */
  day: string
  /** When it counts (ISO). */
  at: string
  /** What the payer paid in all. */
  amount: number
  /** GAM's processing fee inside it. */
  fee: number
  paymentIntentId: string | null
  who: string
}

export interface MarginCostInput {
  id: string
  category: string
  amount: number
  /** 'YYYY-MM' it belongs to when it is not one payment's (period, else posting day, Phoenix). */
  month: string
  /** 'YYYY-MM-DD' when the line covers exactly one day. */
  day: string | null
  paymentIntentId: string | null
  /**
   * 10/3 (review): Stripe's fee on a bank payment this card does not list (a
   * FlexPay pull, one of GAM's own fees charged on its own) that is still
   * clearing. Held out of every month until it clears — then it counts in the
   * month it cleared (`month`), like every bank payment's fee — the same rule
   * GAM's Own Money keeps.
   */
  clearing?: boolean
}

/**
 * 10/4 (review, fix pass 1): what a payment Stripe took back after it settled
 * (a dispute, a returned bank payment) does to the margin besides Stripe's own
 * fee for it — that fee (a $15 dispute fee, a bank return's fee) is already a
 * month cost here, in the month Stripe charged it. Without these the card and
 * the true-up showed GAM absorbing every such fee ($15 short on each dispute)
 * while GAM's Own Money counted it coming back (DisputesTakenBack and its GAM
 * bill lines), so the two cards disagreed. Each part counts in the month it
 * happened, the same records GAM's Own Money reads:
 *
 *   fee_given_back          − a disputed tenant payment's fee on top that went
 *                             back to the payer (DisputesTakenBack.feesGivenBack),
 *                             in the month of the dispute.
 *   fee_charged_to_landlord + that fee taken back from the landlords' payouts
 *                             (paymentReversal: 'stripe_fee_kept:…' lines).
 *   chargeback_fee_repaid   + Stripe's dispute fee a payee repays off their payout
 *                             for a disputed register sale, stay deposit or
 *                             business payment (heldPayouts.recordChargeback).
 *   refund_fee_repaid       + Stripe's kept fee on a refunded held pay-link
 *                             payment, taken back from the landlord (decisions #22).
 *   billed_fee_paid         + a returned-payment fee (RETURNFEE: a dispute fee or
 *                             a bank return's fee, billed to the tenant at cost)
 *                             or a declined-card fee (DECLINEFEE) the tenant paid
 *                             through Stripe, in the month it cleared — or that a
 *                             move-out paid from the deposit, in the month GAM
 *                             had it (gamLinesPaidFromDepositSql).
 *   billed_fee_taken_back   − one of those taken back by a later dispute.
 *   fee_returned_on_win     + 10/4 (review, fix pass 2): a dispute GAM won —
 *                             Stripe put the disputed amount back, the fee on
 *                             top in it — in the month it was won.
 *   fee_owed_back_on_win    − the fee the dispute handling charged the
 *                             landlords for it ('stripe_fee_kept:…'), now
 *                             theirs again, in the month it was won.
 *   dispute_fee_returned_on_win
 *                           + fix pass 3: Stripe's own dispute fee that Stripe
 *                             gave back with a win (disputeFeeReturnedOnWinSql),
 *                             in the month it was won — on a dispute whose fee
 *                             no payee repaid (a tenant payment's dispute: the
 *                             fee was GAM's month cost, billed to the tenant as
 *                             GAM's RETURNFEE line). Stripe never records it as
 *                             a cost (a negative fee), so without it a won
 *                             dispute read $15 short. On a held charge's
 *                             chargeback the payee repaid that fee, and it is
 *                             theirs (DisputesTakenBack.chargebacksOwedBackOnWins),
 *                             never counted here.
 *
 * A won dispute's fee_given_back stays in the dispute's month and the two win
 * lines count in the win's month, so a month already shown never changes when a
 * dispute is decided later, and a dispute won nets to nothing. The line that
 * hands the fee back to the landlord's payout (a positive 'dispute' line for the
 * same charge, written by the dispute handling once it undoes a win) is never
 * counted here: fee_owed_back_on_win already counted it, in the month of the win.
 */
export const FEES_BACK_KINDS = [
  'fee_given_back', 'fee_charged_to_landlord', 'chargeback_fee_repaid', 'refund_fee_repaid',
  'billed_fee_paid', 'billed_fee_taken_back', 'fee_returned_on_win', 'fee_owed_back_on_win',
  'dispute_fee_returned_on_win',
] as const
export type FeesBackKind = typeof FEES_BACK_KINDS[number]
export const FEES_BACK_KIND_LABEL: Record<FeesBackKind, string> = {
  fee_given_back:          'Fees on top that went back to payers in disputes',
  fee_charged_to_landlord: 'Those fees taken back from landlords\' payouts',
  chargeback_fee_repaid:   'Stripe\'s dispute fees repaid off a payout (register sales, stay deposits, business payments)',
  refund_fee_repaid:       'Stripe\'s fees on refunded pay-link payments, taken back from landlords\' payouts',
  billed_fee_paid:         'Returned-payment and declined-card fees tenants paid',
  billed_fee_taken_back:   'Returned-payment and declined-card fees taken back in a dispute',
  fee_returned_on_win:     'Fees on top that came back when GAM won a dispute',
  fee_owed_back_on_win:    'Those fees owed back to landlords after a won dispute',
  dispute_fee_returned_on_win: 'Stripe\'s dispute fees Stripe gave back when GAM won a dispute',
}

/**
 * connect_disputes.status for a dispute GAM won (connect_disputes_status_check):
 * Stripe put the disputed money back on the balance.
 */
export const DISPUTE_STATUS_WON = 'won'

/**
 * Fix pass 3: SQL on a connect_disputes alias — no payee was charged for this
 * dispute (heldPayouts.recordChargeback writes a negative 'dispute' line keyed
 * on Stripe's dispute id when it charges one). Stripe's dispute fee on such a
 * dispute was GAM's own cost.
 */
const NO_CHARGEBACK_LINE = (cd: string) =>
  `NOT EXISTS (SELECT 1 FROM held_payout_items hx
                WHERE hx.source_type = 'dispute' AND hx.source_id = ${cd}.stripe_dispute_id AND hx.amount < 0)`

/**
 * Books6 review (choice46d): the landlord whose charge a dispute (alias `cd`)
 * is on — its own column, else the rent payment, register sale or held
 * register payment carrying its intent. NULL when no landlord's charge carries
 * it (GAM's own).
 */
const disputeLandlordSql = (cd: string) => `COALESCE(${cd}.landlord_id,
    (SELECT r.landlord_id FROM tenant_remittances r WHERE r.stripe_payment_intent_id = ${cd}.stripe_payment_intent_id ORDER BY r.created_at, r.id LIMIT 1),
    (SELECT p.landlord_id FROM payments p WHERE p.stripe_payment_intent_id = ${cd}.stripe_payment_intent_id ORDER BY p.created_at, p.id LIMIT 1),
    (SELECT t.landlord_id FROM pos_transactions t WHERE t.stripe_payment_intent_id = ${cd}.stripe_payment_intent_id ORDER BY t.created_at, t.id LIMIT 1),
    (SELECT hp.landlord_id FROM pos_held_payments hp WHERE hp.stripe_payment_intent_id = ${cd}.stripe_payment_intent_id ORDER BY hp.created_at, hp.id LIMIT 1))`
/** The dispute is not on a test or system landlord's charge (the same filter every sibling kind applies: realLandlordSql). */
const DISPUTE_OF_REAL_LANDLORD = (cd: string) =>
  `(${disputeLandlordSql(cd)} IS NULL OR ${realLandlordSql(`(${disputeLandlordSql(cd)})`)})`

export interface MarginFeeBackInput {
  id: string
  kind: FeesBackKind
  /** 'YYYY-MM' it counts in (Phoenix). */
  month: string
  at: string
  /** Signed: what it adds to GAM's margin. */
  amount: number
  who: string
  /** The payment it is about, when there is one (marks that payment on the list). */
  paymentIntentId: string | null
}

export interface MarginFeeBackRow {
  id: string
  kind: FeesBackKind
  label: string
  at: string
  who: string
  amount: number
}

export interface MarginInputs {
  payments: MarginPaymentInput[]
  costs: MarginCostInput[]
  /** 10/4 (review, fix pass 1): disputes and returned payments (FEES_BACK_KINDS). */
  feesBack?: MarginFeeBackInput[]
  /** Stripe's bank-debit price, for a clearing payment it has not posted a fee for yet. */
  bankCost: { pct: number; flat: number; cap: number | null }
  /** Used only when no month has a posted card day to measure a rate from. */
  cardFallback: { pct: number; flat: number }
}

export interface MarginPaymentRow {
  id: string
  kind: MarginPaymentKind
  kindLabel: string
  at: string
  who: string
  method: 'card' | 'bank'
  methodLabel: string
  amount: number
  feeCharged: number
  stripeCost: number
  costBasis: CostBasis
  costBasisLabel: string
  gamKeeps: number
  clearing: boolean
  /**
   * 10/4 (review, fix pass 1): the payer disputed this payment. What that did
   * to the margin is in the month's feesBack (the month it happened), never in
   * this row's figures.
   */
  disputed: boolean
  /** The part of this payment's fee on top that went back to the payer in the dispute. */
  feeGivenBack: number
  /** 10/4 (review, fix pass 2): GAM won that dispute — the money came back (the month's feesBack says when). */
  disputeWon: boolean
}

export interface MarginRow {
  month: string
  /** Fees on payments that cleared this month. */
  feeRevenue: number
  /** Everything Stripe charged GAM for this month, the bank-feed fees included. */
  stripeCost: number
  /** The bank-feed part of stripeCost (Nic 10/3: a GAM cost, counted on the card). */
  bankFeedCost: number
  /** The part of stripeCost that is an estimate for card days Stripe has not posted. */
  estimatedCost: number
  estimateDays: string[]
  /** 10/3 (review): the rate that estimate used; null when nothing was estimated. */
  estimateRate: EstimateRateSource | null
  estimateRateLabel: string | null
  margin: number
  marginPct: number | null
  /** Bank payments made this month that have not cleared: not counted above. */
  clearing: { count: number; amount: number; fees: number; stripeCost: number }
  /**
   * 10/3 (review): bank payments made in an EARLIER month that are still
   * clearing now. They are in their own month's list and count in the month
   * they clear; without this the current month's card showed a payment made on
   * the 30th and still clearing on the 3rd nowhere at all.
   */
  clearingEarlier: { count: number; amount: number; fees: number; stripeCost: number }
  /**
   * 10/3 (review): Stripe's fees on bank payments this card does not list (a
   * FlexPay pull, one of GAM's own fees charged on its own, and — pass 2 — a
   * business invoice paid by bank, which GAM records only once it clears) that
   * were posted by this month and are still clearing. Not counted above; each
   * counts in the month its payment clears.
   */
  otherClearing: { count: number; stripeCost: number }
  byCategory: Array<{ category: string; label: string; amount: number }>
  byRail: Array<{ rail: MarginPaymentKind; label: string; charged: number; count: number }>
  /** Stripe charges for the month that belong to no one payment (monthly lines, Connect fees). */
  notTiedToAPayment: Array<{ category: string; label: string; amount: number }>
  notTiedTotal: number
  /**
   * 10/4 (review, fix pass 1): disputes and returned payments this month
   * (FEES_BACK_KINDS) — inside `margin`:
   *   margin = feeRevenue − stripeCost + feesBack.total.
   * `items` comes with the per-payment list only (marginForMonth).
   */
  feesBack: {
    total: number
    byKind: Array<{ kind: FeesBackKind; label: string; amount: number; count: number }>
    items?: MarginFeeBackRow[]
  }
  payments?: MarginPaymentRow[]
}

const cents = (n: number) => Math.round(n * 100)
const dollars = (c: number) => Math.round(c) / 100
const round2 = (n: number) => Math.round(n * 100) / 100

/** `total` cents split in proportion to `weights`, to the cent, nothing lost. */
export function splitCents(total: number, weights: number[]): number[] {
  if (!weights.length) return []
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0)
  const w = sum > 0 ? weights.map(x => Math.max(0, x)) : weights.map(() => 1)
  const wsum = sum > 0 ? sum : weights.length
  const raw = w.map(x => (total * x) / wsum)
  const out = raw.map(Math.floor)
  let left = total - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i]++
  return out
}

/** Phoenix month 'YYYY-MM' one before `month`. */
function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

interface Work {
  p: MarginPaymentInput
  exact: number
  share: number
  est: number
  byCat: Map<string, number>
}

/**
 * The margin for each of `months`, every dollar once:
 *   stripeCost = Σ what Stripe took on each payment that cleared in the month
 *              + the month's charges that belong to no one payment.
 * A cost tied to a payment still clearing is in that payment's clearing line,
 * never in the month (it counts with the payment, when the payment does).
 */
export function computeMarginMonths(inp: MarginInputs, months: string[]): MarginRow[] {
  const work: Work[] = inp.payments.map(p => ({ p, exact: 0, share: 0, est: 0, byCat: new Map() }))
  const addCat = (m: Map<string, number>, cat: string, c: number) => m.set(cat, (m.get(cat) ?? 0) + c)
  const byPi = new Map<string, Work>()
  for (const w of work) if (w.p.paymentIntentId) byPi.set(w.p.paymentIntentId, w)

  const monthLevel = new Map<string, Map<string, number>>()
  const addMonthLevel = (month: string, cat: string, c: number) => {
    if (!monthLevel.has(month)) monthLevel.set(month, new Map())
    addCat(monthLevel.get(month)!, cat, c)
  }

  // 1. Each cost line to its payment, its day, or its month — or, a fee on a
  // bank payment this card does not list that is still clearing, held apart.
  const dayRows = new Map<string, MarginCostInput[]>()
  const heldClearing: MarginCostInput[] = []
  for (const c of inp.costs) {
    const w = c.paymentIntentId ? byPi.get(c.paymentIntentId) : undefined
    if (w) { w.exact += cents(c.amount); addCat(w.byCat, c.category, cents(c.amount)); continue }
    if (c.clearing) { heldClearing.push(c); continue }
    if (c.day && CARD_DAY_CATEGORIES.has(c.category)) {
      if (!dayRows.has(c.day)) dayRows.set(c.day, [])
      dayRows.get(c.day)!.push(c)
      continue
    }
    addMonthLevel(c.month, c.category, cents(c.amount))
  }

  // 2. Posted card days: the day's costs split across that day's card payments by size.
  const cardsByDay = new Map<string, Work[]>()
  for (const w of work) {
    if (w.p.method !== 'card') continue
    if (!cardsByDay.has(w.p.day)) cardsByDay.set(w.p.day, [])
    cardsByDay.get(w.p.day)!.push(w)
  }
  const observed = new Map<string, { cost: number; volume: number }>()
  const unposted: string[] = []
  for (const day of new Set([...dayRows.keys(), ...cardsByDay.keys()])) {
    const rows = dayRows.get(day) ?? []
    const pays = cardsByDay.get(day) ?? []
    if (!rows.some(r => r.category === DAY_POSTED_CATEGORY)) { unposted.push(day); continue }
    if (!pays.length) { for (const r of rows) addMonthLevel(r.month, r.category, cents(r.amount)); continue }
    const weights = pays.map(w => cents(w.p.amount))
    const before = pays.map(w => w.share)
    for (const r of rows) {
      const parts = splitCents(cents(r.amount), weights)
      pays.forEach((w, i) => { w.share += parts[i]; addCat(w.byCat, r.category, parts[i]) })
    }
    pays.forEach((w, i) => {
      const o = observed.get(w.p.month) ?? { cost: 0, volume: 0 }
      o.cost += w.share - before[i]
      o.volume += weights[i]
      observed.set(w.p.month, o)
    })
  }

  // 3. Card days Stripe has not posted: the month's own observed rate; before
  // the month has a posted card day, the month before's; failing both, the
  // rate card. 10/3 (review): only ever the month just before — the one month
  // every load holds whole (loadMarginInputs) — so the card, its payment list
  // and the true-up borrow the same rate whatever window they loaded. Reaching
  // further back, or reading a month loaded only in part, made the 1st of the
  // month's card disagree with its own list ($72.57 vs $93.71 taken).
  const rateFor = (month: string): { pct: number; flat: number; source: EstimateRateSource } => {
    const own = observed.get(month)
    if (own && own.volume > 0) return { pct: own.cost / own.volume, flat: 0, source: 'this_month' }
    const before = observed.get(prevMonth(month))
    if (before && before.volume > 0) return { pct: before.cost / before.volume, flat: 0, source: 'month_before' }
    return { ...inp.cardFallback, source: 'rate_card' }
  }
  for (const day of unposted) {
    const rows = dayRows.get(day) ?? []
    const pays = cardsByDay.get(day) ?? []
    if (!pays.length) { for (const r of rows) addMonthLevel(r.month, r.category, cents(r.amount)); continue }
    // The lines that did arrive for this day are inside the estimate.
    for (const w of pays) {
      const r = rateFor(w.p.month)
      w.est = Math.max(0, Math.round(cents(w.p.amount) * r.pct + cents(r.flat)))
    }
  }

  // 4. A bank payment still clearing that Stripe has not posted a fee for yet.
  for (const w of work) {
    if (w.p.method !== 'bank' || !w.p.clearing || w.exact > 0) continue
    const raw = w.p.amount * (inp.bankCost.pct / 100) + inp.bankCost.flat
    w.est = cents(inp.bankCost.cap == null ? raw : Math.min(raw, inp.bankCost.cap))
  }

  const basisOf = (w: Work): CostBasis =>
    w.est > 0 ? 'estimate_unposted' : w.share > 0 ? 'day_share' : w.exact > 0 ? 'exact' : 'none'
  const costOf = (w: Work) => w.exact + w.share + w.est

  // 10/4 (review, fix pass 1): disputes and returned payments. Each counts in
  // its own month; a payment it is about is marked on the list whatever month.
  const feesBack = inp.feesBack ?? []
  const disputedPis = new Set<string>()
  const wonPis = new Set<string>()
  const givenBackByPi = new Map<string, number>()
  for (const f of feesBack) {
    if (!f.paymentIntentId) continue
    if (f.kind === 'fee_given_back' || f.kind === 'chargeback_fee_repaid') disputedPis.add(f.paymentIntentId)
    if (f.kind === 'fee_returned_on_win' || f.kind === 'fee_owed_back_on_win' || f.kind === 'dispute_fee_returned_on_win') wonPis.add(f.paymentIntentId)
    if (f.kind === 'fee_given_back') givenBackByPi.set(f.paymentIntentId, (givenBackByPi.get(f.paymentIntentId) ?? 0) - cents(f.amount))
  }

  // 5. The months.
  return months.map((month) => {
    const cleared = work.filter(w => !w.p.clearing && w.p.month === month)
    const clearing = work.filter(w => w.p.clearing && w.p.month === month)
    const clearingEarlier = work.filter(w => w.p.clearing && w.p.month < month)
    const clearingSum = (ws: Work[]) => ({
      count: ws.length,
      amount: dollars(ws.reduce((a, w) => a + cents(w.p.amount), 0)),
      fees: dollars(ws.reduce((a, w) => a + cents(w.p.fee), 0)),
      stripeCost: dollars(ws.reduce((a, w) => a + costOf(w), 0)),
    })
    const ml = monthLevel.get(month) ?? new Map<string, number>()

    const cat = new Map<string, number>()
    for (const w of cleared) {
      for (const [k, v] of w.byCat) addCat(cat, k, v)
      if (w.est > 0) addCat(cat, ESTIMATE_CATEGORY, w.est)
    }
    for (const [k, v] of ml) addCat(cat, k, v)

    const feeC = cleared.reduce((a, w) => a + cents(w.p.fee), 0)
    const payCostC = cleared.reduce((a, w) => a + costOf(w), 0)
    const notTiedC = [...ml.values()].reduce((a, v) => a + v, 0)
    const stripeC = payCostC + notTiedC
    const backs = feesBack.filter(f => f.month === month)
    const backC = backs.reduce((a, f) => a + cents(f.amount), 0)
    const marginC = feeC - stripeC + backC
    const labelOf = (k: string) => k === ESTIMATE_CATEGORY ? ESTIMATE_LABEL : (COST_LABELS as Record<string, string>)[k] ?? COST_LABELS.other
    const order = (k: string) => { const i = (COST_CATEGORIES as readonly string[]).indexOf(k); return i < 0 ? 99 : i }

    // The month's card estimates all used rateFor(month) (a payment's estimate
    // is at its own month's rate), so the card can say which rate that was.
    const estimatedCards = cleared.some(w => w.est > 0 && w.p.method === 'card')
    const estimateRate: EstimateRateSource | null = estimatedCards ? rateFor(month).source : null
    const held = heldClearing.filter(c => c.month <= month)

    const rails = new Map<MarginPaymentKind, { charged: number; count: number }>()
    for (const w of cleared) {
      const r = rails.get(w.p.kind) ?? { charged: 0, count: 0 }
      r.charged += cents(w.p.fee); r.count++
      rails.set(w.p.kind, r)
    }

    const rows: MarginPaymentRow[] = [...cleared, ...clearing]
      .sort((a, b) => b.p.at.localeCompare(a.p.at))
      .map((w) => {
        const basis = basisOf(w)
        const cost = costOf(w)
        return {
          id: w.p.id, kind: w.p.kind, kindLabel: MARGIN_PAYMENT_KIND_LABEL[w.p.kind], at: w.p.at, who: w.p.who,
          method: w.p.method, methodLabel: PAYMENT_METHOD_LABEL[w.p.method],
          amount: round2(w.p.amount), feeCharged: round2(w.p.fee), stripeCost: dollars(cost),
          costBasis: basis, costBasisLabel: COST_BASIS_LABEL[basis],
          gamKeeps: dollars(cents(w.p.fee) - cost), clearing: w.p.clearing,
          disputed: !!w.p.paymentIntentId && disputedPis.has(w.p.paymentIntentId),
          feeGivenBack: dollars(w.p.paymentIntentId ? givenBackByPi.get(w.p.paymentIntentId) ?? 0 : 0),
          disputeWon: !!w.p.paymentIntentId && wonPis.has(w.p.paymentIntentId),
        }
      })

    return {
      month,
      feeRevenue: dollars(feeC),
      stripeCost: dollars(stripeC),
      bankFeedCost: dollars(cat.get('bank_linking') ?? 0),
      estimatedCost: dollars(cleared.reduce((a, w) => a + w.est, 0)),
      estimateDays: [...new Set(cleared.filter(w => w.est > 0 && w.p.method === 'card').map(w => w.p.day))].sort(),
      estimateRate,
      estimateRateLabel: estimateRate ? ESTIMATE_RATE_LABEL[estimateRate] : null,
      margin: dollars(marginC),
      marginPct: feeC > 0 ? Math.round((marginC / feeC) * 1000) / 10 : null,
      clearing: clearingSum(clearing),
      clearingEarlier: clearingSum(clearingEarlier),
      otherClearing: {
        count: new Set(held.map(c => c.paymentIntentId ?? c.id)).size,
        stripeCost: dollars(held.reduce((a, c) => a + cents(c.amount), 0)),
      },
      byCategory: [...cat.entries()].filter(([, v]) => v !== 0)
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([k, v]) => ({ category: k, label: labelOf(k), amount: dollars(v) })),
      byRail: [...rails.entries()]
        .map(([rail, r]) => ({ rail, label: MARGIN_PAYMENT_KIND_LABEL[rail], charged: dollars(r.charged), count: r.count }))
        .sort((a, b) => b.charged - a.charged),
      notTiedToAPayment: [...ml.entries()].filter(([, v]) => v !== 0)
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([k, v]) => ({ category: k, label: labelOf(k), amount: dollars(v) })),
      notTiedTotal: dollars(notTiedC),
      feesBack: {
        total: dollars(backC),
        byKind: FEES_BACK_KINDS
          .map(kind => {
            const of = backs.filter(f => f.kind === kind)
            return { kind, label: FEES_BACK_KIND_LABEL[kind], amount: dollars(of.reduce((a, f) => a + cents(f.amount), 0)), count: of.length }
          })
          .filter(k => k.count > 0),
        items: [...backs].sort((a, b) => b.at.localeCompare(a.at))
          .map(f => ({ id: f.id, kind: f.kind, label: FEES_BACK_KIND_LABEL[f.kind], at: f.at, who: f.who, amount: round2(f.amount) })),
      },
      payments: rows,
    }
  })
}

/** A screening's card fee, when the book did not record it: 3.5% + $0.55 on what came before it. */
export function screeningFeeInside(charged: number): number {
  const before = (charged - PROCESSING_FEES.CARD_FLAT) / (1 + PROCESSING_FEES.CARD_PCT)
  return round2(charged - before)
}

const nameSql = (u: string) => `NULLIF(TRIM(COALESCE(${u}.first_name, '') || ' ' || COALESCE(${u}.last_name, '')), '')`

/**
 * Everything the margin needs for the Phoenix dates [from, to): the payments
 * (two days either side, so a card day straddling a month boundary is split
 * across all of its payments) and every cost line that could belong to them.
 *
 * A payment is in when the day it counts (cleared) OR the day it was made falls
 * in that window, and every payment still clearing is in whatever its date (so
 * the current month can say what is clearing from earlier months). Then every
 * cost line tied to a payment (its PaymentIntent) that is not in yet brings
 * its payment in, whenever that payment counts.
 *
 * 10/3 (review): a bank payment made Sep 28 that cleared Oct 6 was in neither
 * window's list for September, so its $2.63 fee — posted Sep 28 and loaded by
 * date — was counted as a September charge "not tied to a payment", and again
 * in October tied to the payment. The true-up took it off twice. A cost tied
 * to a payment now always rides with that payment, in the month the payment
 * counts, and nowhere else.
 */
export type SqlExec = (sql: string, params?: unknown[]) => Promise<any[]>

/** Which payments a load asks for: a date window, or exact PaymentIntents. */
type PaymentScope = { window: [string, string] } | { pis: string[] }

async function loadMarginPayments(exec: SqlExec, scope: PaymentScope): Promise<MarginPaymentInput[]> {
  const lo = `($1::date - interval '2 days')`
  const hi = `($2::date + interval '2 days')`
  const byWindow = 'window' in scope
  const params = byWindow ? scope.window : [scope.pis]
  const inWindow = (col: string) => `(${col} >= ${lo} AND ${col} < ${hi})`
  const piIs = (col: string) => `${col} = ANY($1::text[])`
  // Only a payment Stripe charged (it has a PaymentIntent) is on GAM's balance
  // with a processing fee — the same rule the reconciliation applies.
  // 10/3 (review): the fee is the processing fee alone — a platform fee the
  // property passes to its tenants rides in processing_fee_amount too, and it
  // is not processing (TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL) — and a fee the
  // landlord covers is in it (gamFeeOnRemittance).
  const remits = await exec(
    `SELECT r.id, r.status, r.payment_method, r.amount::float AS amount,
            COALESCE(r.gross_amount, r.amount + r.processing_fee_amount)::float AS gross,
            ${remittanceFeeColumnsSql('r', 'tpf')}, r.stripe_payment_intent_id AS pi,
            to_char(COALESCE(r.settled_at, r.created_at), 'YYYY-MM') AS month,
            to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            COALESCE(r.settled_at, r.created_at) AS at,
            ${nameSql('u')} AS person, pr.name AS property_name, un.unit_number
       FROM tenant_remittances r
       LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
       LEFT JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN leases l ON l.id = r.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
      WHERE r.payment_method IN ('card', 'ach')
        AND r.status IN ('settled', 'processing')
        AND r.stripe_payment_intent_id IS NOT NULL
        AND ${realLandlordSql('r.landlord_id')}
        AND ${byWindow
          ? `(${inWindow('COALESCE(r.settled_at, r.created_at)')} OR ${inWindow('r.created_at')} OR r.status = 'processing')`
          : piIs('r.stripe_payment_intent_id')}`, params)
  // A card sale on GAM's account: the counter, a card on file, a pay link.
  // platform_fee is GAM's card fee on it (whoever paid it — a pay link whose
  // landlord covers the fee still pays GAM's fee out of the sale). 10/3
  // (review): one refunded at the register stays — the refund went back by
  // hand, the charge and GAM's fee stayed on GAM's balance.
  const sales = await exec(
    `SELECT pt.id, pt.total::float AS gross, pt.platform_fee::float AS fee, pt.stripe_payment_intent_id AS pi,
            (pt.pay_link_id IS NOT NULL OR pt.paid_online) AS online,
            to_char(pt.created_at, 'YYYY-MM') AS month,
            to_char(pt.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, pt.created_at AS at,
            pr.name AS property_name, ${nameSql('c')} AS person
       FROM pos_transactions pt
       LEFT JOIN properties pr ON pr.id = pt.property_id
       LEFT JOIN pos_customers c ON c.id = pt.pos_customer_id
      WHERE pt.payment_method IN ('card', 'card_on_file')
        AND pt.stripe_payment_intent_id IS NOT NULL
        AND ${cardSaleOnBalanceSql('pt.status')}
        AND ${realLandlordSql('pt.landlord_id')}
        AND ${byWindow ? inWindow('pt.created_at') : piIs('pt.stripe_payment_intent_id')}`, params)
  const checks = await exec(
    `SELECT bc.id, bc.amount_charged::float AS gross, bc.applicant_payment_intent_id AS pi,
            to_char(bc.created_at, 'YYYY-MM') AS month,
            to_char(bc.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, bc.created_at AS at,
            ${nameSql('bc')} AS person,
            (SELECT MAX(l.customer_fee_charged) FROM platform_revenue_ledger l
              WHERE l.type = 'banking_spread' AND l.reference_type = 'background_check'
                AND l.reference_id = bc.id)::float AS fee_booked
       FROM background_checks bc
      WHERE bc.applicant_payment_intent_id IS NOT NULL AND bc.amount_charged > 0
        AND bc.refunded_at IS NULL
        AND ${realLandlordSql('bc.landlord_id', { poolIsReal: true })}
        AND ${byWindow ? inWindow('bc.created_at') : piIs('bc.applicant_payment_intent_id')}`, params)
  const debits = await exec(
    `SELECT d.id, d.status, d.total_amount::float AS gross, d.bank_cost_amount::float AS fee,
            d.stripe_payment_intent_id AS pi,
            to_char(CASE WHEN d.status = 'succeeded' THEN COALESCE(d.settled_at, d.created_at) ELSE d.created_at END, 'YYYY-MM') AS month,
            to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            CASE WHEN d.status = 'succeeded' THEN COALESCE(d.settled_at, d.created_at) ELSE d.created_at END AS at,
            l.business_name
       FROM landlord_gam_debits d
       JOIN landlords l ON l.id = d.landlord_id
      WHERE d.status IN ('succeeded', 'pending') AND d.stripe_payment_intent_id IS NOT NULL
        AND d.bank_cost_amount > 0
        AND ${realLandlordSql('d.landlord_id')}
        AND ${byWindow
          ? `(${inWindow('COALESCE(d.settled_at, d.created_at)')} OR ${inWindow('d.created_at')} OR d.status = 'pending')`
          : piIs('d.stripe_payment_intent_id')}`, params)
  // 10/3 (review): a stay deposit a guest paid online (services/propertyBooking
  // confirmBookingDeposit): the charge is GAM's, the deposit is held for the
  // landlord (its 'booking_deposit' payout line = what was charged less GAM's
  // card fee), and GAM keeps the card fee. Card only. The fee is read from the
  // payout line, never from deposit_amount alone (stayDepositFeeFromPayoutLine).
  const deposits = await exec(
    `SELECT b.id, b.deposit_amount::float AS deposit, h.amount::float AS held, b.stripe_payment_intent_id AS pi,
            pr.booking_card_fee_payer AS fee_payer,
            to_char(b.deposit_paid_at, 'YYYY-MM') AS month,
            to_char(b.deposit_paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, b.deposit_paid_at AS at,
            b.guest_name AS person, pr.name AS property_name, un.unit_number
       FROM unit_bookings b
       JOIN held_payout_items h ON h.source_type = 'booking_deposit' AND h.source_id = b.id::text
       LEFT JOIN units un ON un.id = b.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
      WHERE b.deposit_paid_at IS NOT NULL AND b.stripe_payment_intent_id IS NOT NULL
        AND ${realLandlordSql('b.landlord_id')}
        AND ${byWindow ? inWindow('b.deposit_paid_at') : piIs('b.stripe_payment_intent_id')}`, params)
  // 10/3 (review): the business portal's payments on GAM's account — an
  // invoice paid online (card, or bank once it cleared: a bank payment is only
  // recorded when it clears) and a register card sale. GAM holds each for the
  // business less GAM's cut (the payout line), and keeps the cut. A refund
  // never gives the cut back (an invoice refund comes out of the business's
  // payouts in full; a register refund is paid by hand).
  const bizInvoices = await exec(
    `SELECT bip.id, bip.method, bip.amount::float AS gross, h.amount::float AS held,
            bip.stripe_payment_intent_id AS pi,
            to_char(bip.paid_at, 'YYYY-MM') AS month,
            to_char(bip.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, bip.paid_at AS at,
            bz.name AS business_name, bi.invoice_number
       FROM business_invoice_payments bip
       JOIN businesses bz ON bz.id = bip.business_id
       LEFT JOIN business_invoices bi ON bi.id = bip.invoice_id
       LEFT JOIN held_payout_items h ON h.source_type = 'business_invoice_payment'
                                    AND h.source_id = bip.stripe_checkout_session_id
      WHERE bip.method IN ('card', 'ach') AND bip.stripe_payment_intent_id IS NOT NULL
        AND ${byWindow ? inWindow('bip.paid_at') : piIs('bip.stripe_payment_intent_id')}`, params)
  const bizSales = await exec(
    `SELECT t.id, (t.total_amount + t.tip_amount + t.card_surcharge)::float AS gross,
            t.card_surcharge::float AS surcharge, h.amount::float AS held, t.stripe_payment_intent_id AS pi,
            to_char(t.created_at, 'YYYY-MM') AS month,
            to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, t.created_at AS at,
            bz.name AS business_name, t.receipt_number
       FROM business_pos_transactions t
       JOIN businesses bz ON bz.id = t.business_id
       LEFT JOIN held_payout_items h ON h.source_type = 'business_pos_sale' AND h.source_id = t.id::text
      WHERE t.stripe_payment_intent_id IS NOT NULL
        AND t.payment_method IN ('stripe_terminal', 'stripe_checkout')
        AND t.status IN ('completed', 'partially_refunded', 'refunded')
        AND ${byWindow ? inWindow('t.created_at') : piIs('t.stripe_payment_intent_id')}`, params)

  const iso = (v: any) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())
  const place = (r: any) => [r.property_name, r.unit_number].filter(Boolean).join(' · ')
  return [
    ...remits.map((r: any): MarginPaymentInput => ({
      id: r.id, kind: r.payment_method === 'ach' ? 'rent_bank' : 'rent_card',
      method: r.payment_method === 'ach' ? 'bank' : 'card',
      clearing: r.status === 'processing', month: r.month, day: r.day, at: iso(r.at),
      amount: Number(r.gross), fee: gamFeeOnRemittance(remittanceFeeOf(r)).total, paymentIntentId: r.pi ?? null,
      who: [r.person ?? 'A tenant', place(r)].filter(Boolean).join(' · '),
    })),
    ...sales.map((r: any): MarginPaymentInput => ({
      id: r.id, kind: r.online ? 'pay_link_card' : 'register_card', method: 'card', clearing: false,
      month: r.month, day: r.day, at: iso(r.at), amount: Number(r.gross), fee: Number(r.fee) || 0,
      paymentIntentId: r.pi ?? null,
      who: [r.online ? 'Pay link' : 'Register sale', r.person, r.property_name].filter(Boolean).join(' · '),
    })),
    ...checks.map((r: any): MarginPaymentInput => ({
      id: r.id, kind: 'background_check', method: 'card', clearing: false,
      month: r.month, day: r.day, at: iso(r.at), amount: Number(r.gross),
      fee: r.fee_booked != null ? Number(r.fee_booked) : screeningFeeInside(Number(r.gross)),
      paymentIntentId: r.pi ?? null,
      who: ['Background check', r.person].filter(Boolean).join(' · '),
    })),
    ...debits.map((r: any): MarginPaymentInput => ({
      id: r.id, kind: 'landlord_fee_debit', method: 'bank', clearing: r.status === 'pending',
      month: r.month, day: r.day, at: iso(r.at), amount: Number(r.gross), fee: Number(r.fee),
      paymentIntentId: r.pi ?? null,
      who: ['GAM fees pulled from', r.business_name ?? 'a landlord'].join(' '),
    })),
    ...deposits.map((r: any): MarginPaymentInput => {
      const fee = stayDepositFeeFromPayoutLine(Number(r.held), r.deposit == null ? null : Number(r.deposit), r.fee_payer ?? null)
      return {
        id: r.id, kind: 'stay_deposit', method: 'card', clearing: false,
        month: r.month, day: r.day, at: iso(r.at), amount: dollars(cents(Number(r.held)) + cents(fee)), fee,
        paymentIntentId: r.pi ?? null,
        who: ['Stay deposit', r.person, place(r)].filter(Boolean).join(' · '),
      }
    }),
    ...bizInvoices.map((r: any): MarginPaymentInput => {
      const bank = r.method === 'ach'
      return {
        id: r.id, kind: 'business_invoice', method: bank ? 'bank' : 'card', clearing: false,
        month: r.month, day: r.day, at: iso(r.at), amount: Number(r.gross),
        fee: businessCut(Number(r.gross), r.held, processingFeeFor({ amount: Number(r.gross), paymentMethod: bank ? 'ach' : 'card' })),
        paymentIntentId: r.pi ?? null,
        who: [r.business_name, r.invoice_number ? `Invoice ${r.invoice_number}` : null].filter(Boolean).join(' · '),
      }
    }),
    ...bizSales.map((r: any): MarginPaymentInput => ({
      id: r.id, kind: 'business_register_card', method: 'card', clearing: false,
      month: r.month, day: r.day, at: iso(r.at), amount: Number(r.gross),
      fee: businessCut(Number(r.gross), r.held,
        Number(r.surcharge) > 0 ? Number(r.surcharge) : processingFeeFor({ amount: Number(r.gross), paymentMethod: 'card' })),
      paymentIntentId: r.pi ?? null,
      who: [r.business_name, r.receipt_number ? `Receipt ${r.receipt_number}` : null].filter(Boolean).join(' · '),
    })),
  ]
}

/**
 * 10/4 (review, fix pass 1): the disputes and returned payments
 * (FEES_BACK_KINDS) that happened in the Phoenix dates [from, to), plus — to
 * mark them on the list, whatever month they happened — every dispute on one
 * of `pis`. The same records, and the same rules, GAM's Own Money reads
 * (loadDisputesTakenBack, its GAM bill lines, keptFeesRecovered).
 */
async function loadMarginFeesBack(exec: SqlExec, from: string, to: string, pis: string[]): Promise<MarginFeeBackInput[]> {
  const { DISPUTE_STATUSES_MONEY_TAKEN } = await import('./creditUse')
  // 10/4 (review, fix pass 2): a dispute GAM later won took the money too, in
  // its own month — counting only the statuses Stripe still holds it under
  // dropped the fee given back out of a month already shown once the dispute
  // was won. The win counts on its own, in the month it was won (below).
  const tookMoney = `ARRAY[${[...DISPUTE_STATUSES_MONEY_TAKEN, DISPUTE_STATUS_WON].map(s => `'${s}'`).join(', ')}]::text[]`
  // 10/4 (review, fix pass 3): when the dispute was won, read from something
  // that never moves. Nothing writes connect_disputes.outcome_at today
  // (stripeConnect.recordDisputeEvent upserts status and updated_at only), and
  // updated_at moves on every later upsert of the dispute — a month already
  // shown would change. So: outcome_at when it is set, else the first webhook
  // that said the dispute was won (stored before processing, never rewritten),
  // else updated_at (a dispute marked won by hand, with no webhook).
  const wonAt = `MAX(${disputeWonAtSql('cd')})`
  const inWin = (col: string) => `(${col} >= $1::date AND ${col} < $2::date)`
  const payeeReal = (h: string) => `(${h}.landlord_id IS NULL OR ${realLandlordSql(`${h}.landlord_id`)})`
  const billed = `('RETURNFEE', 'DECLINEFEE')`
  const params = [from, to, pis]
  const win = [from, to]

  const given = await exec(
    `SELECT r.id, r.stripe_payment_intent_id AS pi, d.at, to_char(d.at, 'YYYY-MM') AS month,
            GREATEST(0, LEAST(d.taken, COALESCE(r.gross_amount, r.amount + r.processing_fee_amount)) - r.amount)::float AS amt,
            ${nameSql('u')} AS person, pr.name AS property_name, un.unit_number
       FROM tenant_remittances r
       JOIN LATERAL (SELECT MAX(cd.amount) AS taken, MIN(cd.created_at) AS at FROM connect_disputes cd
                      WHERE cd.stripe_payment_intent_id = r.stripe_payment_intent_id
                        AND cd.status = ANY(${tookMoney})) d ON d.taken IS NOT NULL
       LEFT JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN leases l ON l.id = r.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
      WHERE r.status = 'settled' AND r.payment_method IN ('card', 'ach') AND r.stripe_payment_intent_id IS NOT NULL
        AND ${realLandlordSql('r.landlord_id')}
        AND (${inWin('d.at')} OR r.stripe_payment_intent_id = ANY($3::text[]))`, params)
  const landlordFees = await exec(
    `SELECT h.id, (-h.amount)::float AS amt, h.created_at AS at, to_char(h.created_at, 'YYYY-MM') AS month,
            split_part(h.source_id, ':', 2) AS pi, l.business_name AS payee
       FROM held_payout_items h
       LEFT JOIN landlords l ON l.id = h.landlord_id
      WHERE h.source_type = 'dispute' AND h.source_id LIKE 'stripe\\_fee\\_kept:%' AND h.amount < 0
        AND ${payeeReal('h')} AND ${inWin('h.created_at')}`, win)
  // 10/4 (review, fix pass 2): a dispute GAM won, in the month it was won —
  // the fee on top Stripe put back with the disputed money, and what the
  // dispute handling had charged the landlords for it, theirs again.
  const returned = await exec(
    `SELECT r.id, r.stripe_payment_intent_id AS pi, w.at, to_char(w.at, 'YYYY-MM') AS month,
            GREATEST(0, LEAST(w.taken, COALESCE(r.gross_amount, r.amount + r.processing_fee_amount)) - r.amount)::float AS amt,
            ${nameSql('u')} AS person, pr.name AS property_name, un.unit_number
       FROM tenant_remittances r
       JOIN LATERAL (SELECT MAX(cd.amount) AS taken, ${wonAt} AS at FROM connect_disputes cd
                      WHERE cd.stripe_payment_intent_id = r.stripe_payment_intent_id
                        AND cd.status = '${DISPUTE_STATUS_WON}') w ON w.taken IS NOT NULL
       LEFT JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN leases l ON l.id = r.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = un.property_id
      WHERE r.status = 'settled' AND r.payment_method IN ('card', 'ach') AND r.stripe_payment_intent_id IS NOT NULL
        AND ${realLandlordSql('r.landlord_id')}
        AND (${inWin('w.at')} OR r.stripe_payment_intent_id = ANY($3::text[]))`, params)
  const owedBack = await exec(
    `SELECT h.id, h.amount::float AS amt, w.at, to_char(w.at, 'YYYY-MM') AS month,
            split_part(h.source_id, ':', 2) AS pi, l.business_name AS payee
       FROM held_payout_items h
       JOIN LATERAL (SELECT ${wonAt} AS at FROM connect_disputes cd
                      WHERE cd.stripe_payment_intent_id = split_part(h.source_id, ':', 2)
                        AND cd.status = '${DISPUTE_STATUS_WON}') w ON w.at IS NOT NULL
       LEFT JOIN landlords l ON l.id = h.landlord_id
      WHERE h.source_type = 'dispute' AND h.source_id LIKE 'stripe\\_fee\\_kept:%' AND h.amount < 0
        AND ${payeeReal('h')}
        AND (${inWin('w.at')} OR split_part(h.source_id, ':', 2) = ANY($3::text[]))`, params)
  // Fix pass 3: Stripe's dispute fee Stripe gave back with a win, on a
  // dispute no payee repaid that fee for (no chargeback line) — GAM's cost
  // that came back, in the month it was won (dispute_fee_returned_on_win).
  const disputeFeesBack = await exec(
    `SELECT cd.id, cd.stripe_payment_intent_id AS pi, w.at, to_char(w.at, 'YYYY-MM') AS month,
            (${disputeFeeReturnedOnWinSql('cd')})::float AS amt
       FROM connect_disputes cd
       CROSS JOIN LATERAL (SELECT ${disputeWonAtSql('cd')} AS at) w
      WHERE cd.status = '${DISPUTE_STATUS_WON}' AND ${NO_CHARGEBACK_LINE('cd')} AND ${DISPUTE_OF_REAL_LANDLORD('cd')}
        AND (${inWin('w.at')} OR cd.stripe_payment_intent_id = ANY($3::text[]))`, params)
  const chargebacks = await exec(
    `SELECT h.id, (-h.amount - cd.amount)::float AS amt, h.created_at AS at, to_char(h.created_at, 'YYYY-MM') AS month,
            cd.stripe_payment_intent_id AS pi, COALESCE(l.business_name, bz.name) AS payee
       FROM held_payout_items h
       JOIN connect_disputes cd ON cd.stripe_dispute_id = h.source_id
       LEFT JOIN landlords l ON l.id = h.landlord_id
       LEFT JOIN businesses bz ON bz.id = h.business_id
      WHERE h.source_type = 'dispute' AND ${payeeReal('h')}
        AND (${inWin('h.created_at')} OR cd.stripe_payment_intent_id = ANY($3::text[]))`, params)
  const refunds = await exec(
    `SELECT i.id, (-i.amount)::float AS amt, i.created_at AS at, to_char(i.created_at, 'YYYY-MM') AS month,
            h.payer_name, l.business_name AS payee
       FROM held_payout_items i
       JOIN pos_held_payments h ON h.stripe_refund_id = i.source_id AND h.landlord_id = i.landlord_id
       LEFT JOIN landlords l ON l.id = i.landlord_id
      WHERE i.source_type = 'refund' AND ${payeeReal('i')} AND ${inWin('i.created_at')}`, win)
  const paid = await exec(
    `SELECT ra.payment_id::text || ':' || r.id::text AS id, ra.amount_applied::float AS amt, r.settled_at AS at,
            to_char(r.settled_at, 'YYYY-MM') AS month, p.entry_description, ${nameSql('u')} AS person, NULL::text AS part
       FROM remittance_applications ra
       JOIN tenant_remittances r ON r.id = ra.remittance_id
       JOIN payments p ON p.id = ra.payment_id
       LEFT JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE r.status = 'settled' AND r.payment_method IN ('card', 'ach') AND r.stripe_payment_intent_id IS NOT NULL
        AND p.revenue_owner = 'gam' AND p.entry_description IN ${billed}
        AND ${realLandlordSql('r.landlord_id')} AND r.settled_at IS NOT NULL AND ${inWin('r.settled_at')}
     UNION ALL
     SELECT p.id::text, (p.amount - COALESCE(p.gam_supersedence_amount, 0))::float, COALESCE(p.settled_at, p.created_at),
            to_char(COALESCE(p.settled_at, p.created_at), 'YYYY-MM'), p.entry_description, ${nameSql('u')}, NULL::text
       FROM payments p
       LEFT JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE p.revenue_owner = 'gam' AND p.manual_method IS NULL AND p.entry_description IN ${billed}
        AND (p.status = 'settled'
             OR (p.status = 'returned' AND EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)))
        AND p.stripe_payment_intent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM remittance_applications ra WHERE ra.payment_id = p.id)
        AND ${realLandlordSql('p.landlord_id')} AND ${inWin('COALESCE(p.settled_at, p.created_at)')}
     UNION ALL
     -- Leftovers fix: one a move-out paid from the deposit, in the part GAM
     -- has, when GAM has it (gamLinesPaidFromDepositSql).
     SELECT d.id::text || ':deposit:' || d.part, d.amt::float, d.at, to_char(d.at, 'YYYY-MM'), d.entry_description,
            ${nameSql('u')}, d.part
       FROM (${gamLinesPaidFromDepositSql()}) d
       LEFT JOIN tenants t ON t.id = d.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE d.entry_description IN ${billed}
        AND ${realLandlordSql('d.landlord_id')} AND ${inWin('d.at')}`, win)
  const takenBack = await exec(
    `SELECT pr.id, (-pr.reversed_amount)::float AS amt, pr.created_at AS at, to_char(pr.created_at, 'YYYY-MM') AS month,
            p.entry_description, ${nameSql('u')} AS person
       FROM payment_reversals pr
       JOIN payments p ON p.id = pr.payment_id
       LEFT JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
      WHERE p.revenue_owner = 'gam' AND p.manual_method IS NULL AND p.stripe_payment_intent_id IS NOT NULL
        AND p.entry_description IN ${billed}
        AND ${realLandlordSql('p.landlord_id')} AND ${inWin('pr.created_at')}`, win)

  const iso = (v: any) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())
  const place = (r: any) => [r.property_name, r.unit_number].filter(Boolean).join(' · ')
  const billedWord = (d: string) => (d === 'DECLINEFEE' ? 'Declined-card fee' : 'Returned-payment fee')
  const row = (kind: FeesBackKind, r: any, who: string, pi: string | null = null): MarginFeeBackInput => ({
    id: `${kind}:${r.id}`, kind, month: r.month, at: iso(r.at), amount: round2(Number(r.amt) || 0), who, paymentIntentId: pi,
  })
  return [
    ...given.filter((r: any) => cents(Number(r.amt)) > 0)
      .map((r: any) => row('fee_given_back', { ...r, amt: -Number(r.amt) },
        [r.person ?? 'A tenant', place(r)].filter(Boolean).join(' · '), r.pi)),
    ...landlordFees.map((r: any) => row('fee_charged_to_landlord', r, `Off ${r.payee ?? 'a landlord'}'s payout`, r.pi || null)),
    ...returned.filter((r: any) => cents(Number(r.amt)) > 0)
      .map((r: any) => row('fee_returned_on_win', r,
        [r.person ?? 'A tenant', place(r)].filter(Boolean).join(' · '), r.pi)),
    ...owedBack.map((r: any) => row('fee_owed_back_on_win', r, `Back to ${r.payee ?? 'a landlord'}'s payout`, r.pi || null)),
    ...disputeFeesBack.filter((r: any) => cents(Number(r.amt)) > 0)
      .map((r: any) => row('dispute_fee_returned_on_win', r, 'Given back by Stripe with the win', r.pi ?? null)),
    ...chargebacks.filter((r: any) => cents(Number(r.amt)) !== 0)
      .map((r: any) => row('chargeback_fee_repaid', r, `Off ${r.payee ?? 'the payee'}'s payout`, r.pi ?? null)),
    ...refunds.map((r: any) => row('refund_fee_repaid', r,
      [`Off ${r.payee ?? 'a landlord'}'s payout`, r.payer_name ? `refund to ${r.payer_name}` : null].filter(Boolean).join(' · '))),
    ...paid.map((r: any) => row('billed_fee_paid', r, [billedWord(r.entry_description), r.person,
      r.part === 'gam_held' ? 'paid from the deposit at move-out'
        : r.part === 'landlord_held' ? 'paid from the deposit at move-out, off the landlord\'s payout' : null,
    ].filter(Boolean).join(' · '))),
    ...takenBack.map((r: any) => row('billed_fee_taken_back', r, [billedWord(r.entry_description), r.person].filter(Boolean).join(' · '))),
  ]
}

/**
 * GAM's card fee on a stay deposit paid online — what confirmBookingDeposit
 * kept back from the landlord's payout line (the deposit's card fee, whoever
 * paid it). What was charged is that line plus this.
 */
export function stayDepositFee(deposit: number): number {
  return processingFeeFor({ amount: deposit, paymentMethod: 'card' })
}

/**
 * 10/3 (review): GAM's card fee on a stay deposit paid online, read from what
 * confirmBookingDeposit fixed when it was paid — the landlord's
 * 'booking_deposit' payout line: what was charged less GAM's fee on the
 * deposit. That is the deposit itself when the guest paid the fee on top, or
 * the deposit less the fee when the property covers it
 * (properties.booking_card_fee_payer = 'landlord').
 *
 * Never from unit_bookings.deposit_amount alone: every later payment toward the
 * stay (the arrival-day balance link, the counter — routes/posPayLinks
 * settleLinkBooking) adds to it, so a $70 deposit followed by a $630 balance
 * link read as a $700 deposit with a $25.05 fee instead of $3.00, on the card,
 * in the true-up and in the check.
 *
 * While deposit_amount still is the deposit it says exactly which of the two
 * the line is; once a later payment has moved it, the property's setting says.
 */
export function stayDepositFeeFromPayoutLine(held: number, depositOnRecord: number | null, feePayerNow: string | null): number {
  const heldC = cents(held)
  if (depositOnRecord != null && depositOnRecord > 0) {
    const fee = stayDepositFee(depositOnRecord)
    if (heldC === cents(depositOnRecord) || heldC === cents(depositOnRecord) - cents(fee)) return fee
  }
  if (feePayerNow === 'landlord') {
    // The line is D − fee(D): find the deposit D to the cent.
    const guess = Math.round(((held + PROCESSING_FEES.CARD_FLAT) / (1 - PROCESSING_FEES.CARD_PCT)) * 100)
    for (const d of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
      const fee = stayDepositFee(d / 100)
      if (d - cents(fee) === heldC) return fee
    }
    return stayDepositFee(guess / 100)
  }
  return stayDepositFee(held)
}

/**
 * 10/3 (review): the columns that say what GAM's processing fee on a tenant's
 * payment (a remittance) is.
 *
 * A property can cover its tenants' bank fee (property_allocation_rules
 * .ach_fee_payer = 'landlord'; the card fee too, if card_fee_payer is set so).
 * Then nothing is added on top: processing_fee_amount carries only a platform
 * fee passed to the tenants, if any, and GAM's $6 comes out of the landlord's
 * share when the payment settles (allocation.ts books it as the banking
 * spread's customer_fee_charged). Reading processing_fee_amount alone counted
 * that $6 zero times: the margin card showed $0 charged and GAM keeping
 * −Stripe's fee, the true-up wrote −$6, the check showed a $6 gap, and while the
 * payment cleared the $6 was counted as the landlord's.
 *
 *   tenant_fee — the payer's fee on top: processing_fee_amount less the
 *                platform fee it carried for the property (`tpf`, the
 *                TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL join's alias).
 *   alloc_fee  — the fee allocation booked on the charge once it settled: the
 *                customer_fee_charged of every banking spread on a bill line
 *                the PaymentIntent paid. NULL before it settles.
 *   fee_payer  — who the property says pays this method's fee, for a payment
 *                not allocated yet (still clearing).
 */
export const remittanceFeeColumnsSql = (r: string, tpf: string) => `
  (${r}.processing_fee_amount - COALESCE(${tpf}.amt, 0))::float AS tenant_fee,
  (SELECT SUM(fl.customer_fee_charged) FROM platform_revenue_ledger fl
     JOIN payments fp ON fp.id = fl.reference_id
    WHERE fl.type = 'banking_spread' AND fl.reference_type = 'payment'
      AND fp.stripe_payment_intent_id = ${r}.stripe_payment_intent_id)::float AS alloc_fee,
  (SELECT CASE WHEN ${r}.payment_method = 'ach' THEN fr.ach_fee_payer ELSE fr.card_fee_payer END
     FROM property_allocation_rules fr
    WHERE fr.property_id = COALESCE(
      (SELECT fu.property_id FROM leases fls JOIN units fu ON fu.id = fls.unit_id WHERE fls.id = ${r}.lease_id),
      (SELECT fu2.property_id FROM remittance_applications fa
         JOIN payments fp2 ON fp2.id = fa.payment_id JOIN units fu2 ON fu2.id = fp2.unit_id
        WHERE fa.remittance_id = ${r}.id ORDER BY fp2.id LIMIT 1))) AS fee_payer`

/** A row carrying remittanceFeeColumnsSql's columns, read for gamFeeOnRemittance. */
export const remittanceFeeOf = (r: any) => ({
  tenantFee: Number(r.tenant_fee ?? 0),
  allocFee: r.alloc_fee == null ? null : Number(r.alloc_fee),
  feePayer: (r.fee_payer ?? null) as string | null,
  amount: Number(r.amount ?? 0),
  method: (r.payment_method === 'ach' ? 'ach' : 'card') as 'ach' | 'card',
})

/**
 * 10/3 (review): GAM's processing fee on a tenant's payment — the payer's fee
 * on top, or, when the payer paid none, the fee the landlord covers: what
 * allocation took from the landlord's share once the payment settled, or, while
 * it is still clearing, the property's fee for that method when it says the
 * landlord pays. One rule for the margin card, the true-up (which IS the card's
 * figure) and both sides of GAM's Own Money.
 */
export function gamFeeOnRemittance(r: {
  tenantFee: number; allocFee: number | null; feePayer: string | null; amount: number; method: 'ach' | 'card'
}): { tenantBorne: number; landlordBorne: number; total: number } {
  const tenantBorne = round2(r.tenantFee)
  let landlordBorne = 0
  if (cents(tenantBorne) === 0) {
    if (r.allocFee != null) landlordBorne = round2(Math.max(0, r.allocFee))
    else if (r.feePayer === 'landlord' && r.amount > 0) landlordBorne = processingFeeFor({ amount: r.amount, paymentMethod: r.method })
  }
  return { tenantBorne, landlordBorne, total: dollars(cents(tenantBorne) + cents(landlordBorne)) }
}

/**
 * GAM's cut of a business payment: what was paid less what GAM holds for the
 * business (its payout line). With no payout line on record, the cut the
 * charge was priced with (`priced`).
 */
export function businessCut(gross: number, held: number | string | null | undefined, priced: number): number {
  if (held == null) return round2(priced)
  return dollars(cents(gross) - cents(Number(held)))
}

export async function loadMarginInputs(from: string, to: string, exec: SqlExec = (sql, params) => query<any>(sql, params as any[])): Promise<MarginInputs> {
  const lo = `($1::date - interval '2 days')`
  const hi = `($2::date + interval '2 days')`
  // 10/3 (review): the month before `from` is loaded whole too. Until Stripe
  // posts a month's first card day, its card costs are estimated at the month
  // before's observed rate (computeMarginMonths, rateFor) — and a load that
  // held only that month's last two days measured it on part of its last card
  // day: the 1st-of-the-month card said Stripe took $72.57 while its own list
  // and the true-up said $93.71. Every load now holds that month whole, so the
  // rate is the same whichever window asked.
  const loadFrom = monthStart(prevMonth(from.slice(0, 7)))
  const payments = await loadMarginPayments(exec, { window: [loadFrom, to] })

  const pis = payments.map(p => p.paymentIntentId).filter((x): x is string => !!x)
  // 10/3 (review, pass 2): a cost is tied to a payment only when it is that
  // payment's own fee (tiedPiSql); a dispute's or a return's fee is the month's
  // it posted in, whatever payment it names. `recent`: posted within the window
  // GAM's Own Money looks in for bank payments its records do not list.
  const costs = await exec(
    `SELECT id::text AS id, category, amount::float AS amount, ${tiedPiSql()} AS pi, txn_type,
            posted_at >= NOW() - make_interval(days => $4::int) AS recent,
            to_char(COALESCE(period_start, posted_at::date), 'YYYY-MM') AS month,
            CASE WHEN period_start IS NOT NULL AND (period_end IS NULL OR period_end = period_start)
                 THEN to_char(period_start, 'YYYY-MM-DD') END AS day
       FROM stripe_processing_costs
      WHERE (COALESCE(period_start, posted_at::date) >= ${lo}::date
             AND COALESCE(period_start, posted_at::date) < ${hi}::date)
         OR ${tiedPiSql()} = ANY($3::text[])`, [loadFrom, to, pis, CLEARING_LOOKBACK_DAYS])

  // A cost tied to a payment that is not in the list yet (it counts in another
  // month) brings its payment in, so the cost rides with it and is never taken
  // as a charge "not tied to a payment" in this one.
  const known = new Set(pis)
  const orphanPis = [...new Set(costs.map((c: any) => c.pi as string | null).filter((pi): pi is string => !!pi && !known.has(pi)))]
  if (orphanPis.length) {
    const seen = new Set(payments.map(p => `${p.kind}:${p.id}`))
    for (const p of await loadMarginPayments(exec, { pis: orphanPis })) {
      if (!seen.has(`${p.kind}:${p.id}`)) { seen.add(`${p.kind}:${p.id}`); payments.push(p) }
    }
  }

  // 10/3 (review): a cost tied to a bank payment this card does not list — a
  // FlexPay pull, one of GAM's own fees charged on its own, a demo account's
  // payment. While that payment is still clearing, Stripe's fee on it is held
  // out of every month (GAM's Own Money keeps it out of its costs until then
  // too — Nic's rule 3); once it has cleared, it counts in the month it cleared,
  // like the fee on every bank payment the card lists. It used to land in the
  // month's "not tied to a payment" costs while the pull was still clearing.
  const listed = new Set(payments.map(p => p.paymentIntentId).filter((x): x is string => !!x))
  const otherPis = [...new Set(costs.map((c: any) => c.pi as string | null).filter((pi): pi is string => !!pi && !listed.has(pi)))]
  const otherState = new Map<string, { clearing: boolean; clearedMonth: string | null }>()
  if (otherPis.length) {
    const rows: Array<{ pi: string; clearing: boolean; cleared_month: string | null }> = await exec(
      `SELECT pi, bool_or(clearing) AS clearing, to_char(MAX(cleared_at), 'YYYY-MM') AS cleared_month FROM (
         SELECT stripe_payment_intent_id AS pi, status = 'processing' AS clearing,
                CASE WHEN status = 'settled' THEN settled_at END AS cleared_at
           FROM payments WHERE stripe_payment_intent_id = ANY($1::text[])
         UNION ALL
         SELECT stripe_payment_intent_id, status = 'processing', CASE WHEN status = 'settled' THEN settled_at END
           FROM tenant_remittances WHERE stripe_payment_intent_id = ANY($1::text[])
         UNION ALL
         SELECT stripe_payment_intent_id, status = 'pending', CASE WHEN status = 'succeeded' THEN settled_at END
           FROM landlord_gam_debits WHERE stripe_payment_intent_id = ANY($1::text[])
       ) x GROUP BY pi`, [otherPis])
    for (const r of rows) otherState.set(r.pi, { clearing: !!r.clearing, clearedMonth: r.cleared_month ?? null })
  }
  // 10/3 (review, pass 2): a bank payment's fee whose PaymentIntent matches
  // nothing in GAM's records at all — a business invoice paid by bank, which
  // GAM records only once it clears (webhooks: async_payment_succeeded). It
  // used to count at once as a charge "not tied to a payment" in the month it
  // posted, then move to the month the payment cleared once its record
  // appeared, while GAM's Own Money kept it out until then. Now one rule: held
  // out as still clearing while it is recent (posted within the window GAM's
  // Own Money looks in for bank payments its records do not list —
  // readPlatformStripeLive); once its record appears it rides with the payment
  // in the month it cleared. One that never gets a record (the payment failed)
  // counts, after that window, in the month Stripe took it — this month or
  // last, so the nightly true-up books it.
  const unrecordedClearing = (c: any) =>
    !!c.pi && !listed.has(c.pi) && !otherState.has(c.pi) && c.txn_type === 'payment' && !!c.recent

  const rates: Array<{ payment_method: string; stripe_cost_flat: string; stripe_cost_percent: string; stripe_cost_cap: string | null }> = await exec(
    `SELECT payment_method, stripe_cost_flat, stripe_cost_percent, stripe_cost_cap
       FROM platform_processing_rates WHERE effective_until IS NULL`)
  const ach = rates.find(r => r.payment_method === 'ach')
  const card = rates.find(r => r.payment_method === 'card')
  const feesBack = await loadMarginFeesBack(exec, loadFrom, to,
    [...new Set(payments.map(p => p.paymentIntentId).filter((x): x is string => !!x))])
  return {
    payments,
    feesBack,
    costs: costs.map((c: any): MarginCostInput => {
      const other = c.pi ? otherState.get(c.pi) : undefined
      return {
        id: c.id, category: c.category, amount: Number(c.amount),
        month: other && !other.clearing && other.clearedMonth ? other.clearedMonth : c.month,
        day: c.day ?? null, paymentIntentId: c.pi ?? null,
        ...(other?.clearing || unrecordedClearing(c) ? { clearing: true } : {}),
      }
    }),
    bankCost: {
      pct: ach ? Number(ach.stripe_cost_percent) : 0.5,
      flat: ach ? Number(ach.stripe_cost_flat) : 0,
      cap: ach ? (ach.stripe_cost_cap == null ? null : Number(ach.stripe_cost_cap)) : 3,
    },
    cardFallback: {
      pct: card ? Number(card.stripe_cost_percent) / 100 : 0.029,
      flat: card ? Number(card.stripe_cost_flat) : 0.26,
    },
  }
}

/** Today's month on GAM's calendar (Phoenix), from the database clock. */
async function currentMonth(): Promise<string> {
  const [r] = await query<{ m: string }>(`SELECT to_char(NOW(), 'YYYY-MM') AS m`)
  return r.m
}

const monthStart = (month: string) => `${month}-01`
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/**
 * The last `months` months, newest first; a month with nothing in it at all is
 * left out (the current month stays when payments from earlier months are
 * still clearing — its card says so). The per-payment list is not included
 * (marginForMonth has it). `now` pins the current month (tests).
 */
export async function marginByMonth(months = 6, opts: { now?: string } = {}): Promise<MarginRow[]> {
  const now = opts.now ?? await currentMonth()
  const list: string[] = [now]
  while (list.length < months) list.push(prevMonth(list[list.length - 1]))
  const inputs = await loadMarginInputs(monthStart(list[list.length - 1]), monthStart(nextMonth(now)))
  return computeMarginMonths(inputs, list)
    .filter(r => r.feeRevenue !== 0 || r.stripeCost !== 0 || r.clearing.count > 0 || r.feesBack.byKind.length > 0
      || (r.month === now && (r.clearingEarlier.count > 0 || r.otherClearing.count > 0)))
    .map(r => {
      const row: MarginRow = { ...r, feesBack: { total: r.feesBack.total, byKind: r.feesBack.byKind } }
      delete row.payments
      return row
    })
}

/** One month with every payment in it — what the card's list shows. */
export async function marginForMonth(month: string, exec?: SqlExec): Promise<MarginRow> {
  const inputs = await loadMarginInputs(monthStart(month), monthStart(nextMonth(month)), exec)
  return computeMarginMonths(inputs, [month])[0]
}

// ═══════════════════════════════════════════════════════════════════════════
// GAM'S OWN MONEY — whose money the Stripe balance is
// ═══════════════════════════════════════════════════════════════════════════
//
// S650 (Nic): "I want to see somewhere where our subscription to the platform
// fee and our card markups — where that money is pooling."
//
// 10/3: the card said $1,336.55. GAM's own was $318.76 — and of that, $75.88
// was background-check money applicants paid that is Checkr's, and $6.85 the
// fees on two bank payments still clearing. The rest of the gap ($1,017.79) was
// Mireya Fierro's and Randall Cox's rent: bank payments still clearing sit in
// Stripe's pending balance the moment Stripe records them, but GAM books the
// landlord's share only when they settle, so the card counted landlords' rent
// as GAM's. Every part of the balance is now named, and the card checks itself
// against GAM's own records (the reconciliation line), so a gap shows with its
// amount instead of hiding inside the headline. 10/3 (review): pay-link
// payments GAM holds until the landlord refunds them (decisions #13) are named
// too; a refunded one's kept fee, taken back from the landlord, is GAM's.

/**
 * 10/3 (review): the kinds of GAM-owned bill lines (payments.revenue_owner =
 * 'gam') the check counts as collected. Two are left out on purpose, because
 * the check names their money elsewhere or cannot yet: FLEXPAY (the FlexPay
 * pull — its $25 is "FlexPay fees" and its rent repays "FlexPay rent covered")
 * and FCPAYDOWN (FlexCharge, not launched: the merchants' part of a paydown
 * leaves the balance by transfer, which the check has no line for).
 */
export const GAM_BILL_LINE_KINDS = ['return_fee', 'decline_fee', 'on_time_pay', 'platform_fee', 'subscription', 'other'] as const
export type GamBillLineKind = typeof GAM_BILL_LINE_KINDS[number]
export const GAM_BILL_LINE_KIND_LABEL: Record<GamBillLineKind, string> = {
  return_fee:   'Returned bank payment fees',
  decline_fee:  'Declined card fees',
  on_time_pay:  'On-Time Pay fees',
  platform_fee: 'Platform fees tenants paid',
  subscription: 'GAM subscriptions tenants paid (FlexDeposit custody, FlexCredit)',
  other:        'Other GAM fees tenants paid',
}
const GAM_BILL_LINES_LEFT_OUT = `('FLEXPAY', 'FCPAYDOWN')`
const gamBillLineKindSql = (p: string) => `CASE
    WHEN ${p}.type = 'platform_fee'             THEN 'platform_fee'
    WHEN ${p}.entry_description = 'RETURNFEE'   THEN 'return_fee'
    WHEN ${p}.entry_description = 'DECLINEFEE'  THEN 'decline_fee'
    WHEN ${p}.entry_description = 'ONTIMEPAY'   THEN 'on_time_pay'
    WHEN ${p}.entry_description = 'SUBSCRIP'    THEN 'subscription'
    ELSE 'other' END`

/**
 * Leftovers fix: the source_id prefix of the payout line a move-out writes
 * when GAM's own bill lines were paid from deposit money the LANDLORD holds
 * (depositReturn's finalize: a negative 'deposit_settlement' line,
 * 'gam_lines:<move-out>', netted from their next payout).
 */
const GAM_LINES_ITEM_PREFIX = 'gam_lines:'
/** SQL on a held_payout_items alias: that line, not netted by a payout yet. */
const unnettedGamLinesItemSql = (h: string) =>
  `(${h}.source_type = 'deposit_settlement' AND ${h}.source_id LIKE 'gam\\_lines:%' AND ${h}.amount < 0
    AND ${h}.payout_intent_id IS NULL)`

/**
 * Leftovers fix: GAM's own bill lines (payments.revenue_owner = 'gam') a
 * move-out paid from the deposit (status 'paid_via_deposit', settled_at = the
 * finalize). Before this GAM's revenue never counted them (only lines Stripe
 * collected), so the margin card, its true-up and GAM's Own Money under-read.
 * Each line counts once, in the part GAM actually has:
 *   - the part money GAM held paid (deposits paid through GAM): at the
 *     finalize, when GAM keeps it on its balance;
 *   - the part money the landlord holds paid (the move-out's
 *     'gam_lines:<move-out>' payout line): when a payout nets that line (the
 *     payout's created_at) — nothing before, so the balance side leaves that
 *     line out of what GAM owes the landlord until then
 *     (loadPlatformBalanceBook's heldItemsOwed).
 * The landlord-held part is the line's amount, taken from the move-out's
 * lines latest-due first (the finalize keeps GAM's own lines out of the
 * money GAM holds first, so what the landlord's money paid is the rest).
 * A move-out is matched by its finalize instant (incomeBasis.sweptBySql:
 * settled_at = finalized_at, same landlord) — nothing ties a swept line to
 * its move-out directly. Known limit (books6 review, accepted): two move-outs
 * of one landlord finalized in the SAME transaction share that instant, so
 * the landlord-held 'gam_lines:' amounts of both spread over both move-outs'
 * lines — each line still counts once and the total is right, but a line can
 * be dated at the other move-out's netting. Every finalize today runs in its
 * own transaction (depositReturn's finalize route), so it does not happen.
 * Rows: the line (alias-free
 * columns id, entry_description, type, tenant_id, landlord_id) with `part`
 * ('gam_held' | 'landlord_held'), `amt` and `at`.
 */
function gamLinesPaidFromDepositSql(): string {
  return `
    SELECT y.id, y.entry_description, y.type, y.tenant_id, y.landlord_id, v.part, v.amt, v.at
      FROM (
        SELECT x.*, LEAST(x.amount, GREATEST(0, x.landlord_paid - x.paid_after)) AS landlord_part
          FROM (
            SELECT p.id, p.entry_description, p.type, p.tenant_id, p.landlord_id, p.amount, p.settled_at,
                   COALESCE(-h.amount, 0) AS landlord_paid, ti.created_at AS netted_at,
                   COALESCE(SUM(p.amount) OVER (PARTITION BY dr.id ORDER BY p.due_date DESC NULLS LAST, p.id DESC
                                                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS paid_after
              FROM payments p
              LEFT JOIN deposit_returns dr ON dr.finalized_at = p.settled_at AND dr.landlord_id = p.landlord_id
              LEFT JOIN held_payout_items h ON h.source_type = 'deposit_settlement'
                                           AND h.source_id = '${GAM_LINES_ITEM_PREFIX}' || dr.id::text AND h.amount < 0
              LEFT JOIN platform_transfer_intents ti ON ti.id = h.payout_intent_id
             WHERE p.revenue_owner = 'gam' AND p.status = 'paid_via_deposit' AND p.settled_at IS NOT NULL
               AND COALESCE(p.entry_description, '') NOT IN ${GAM_BILL_LINES_LEFT_OUT}
          ) x
      ) y
      CROSS JOIN LATERAL (VALUES ('gam_held', y.amount - y.landlord_part, y.settled_at),
                                 ('landlord_held', y.landlord_part, y.netted_at)) AS v(part, amt, at)
     WHERE v.amt > 0 AND v.at IS NOT NULL`
}

/**
 * One payment still clearing: on the balance (Stripe recorded it) or not yet.
 *   tenant_payment     — rent and bills: the landlord's part is theirs, the fees GAM's.
 *   gam_fee_debit      — GAM's fees pulled from a landlord's bank: GAM's all through.
 *   flexpay_pull       — FlexPay's pull: GAM's all through (it repays the rent GAM covered).
 *   gam_bill_line      — 10/3 (review): one of GAM's own bill lines charged on its own
 *                        (a FlexDeposit custody fee, …): GAM's all through.
 *   business_payment   — 10/3 (review): a business invoice paid by bank, found on the
 *                        balance (GAM records it only once it clears): the business's
 *                        part is theirs, GAM's cut GAM's.
 *   unrecorded_payment — 10/3 (review): a bank payment on the balance, still clearing,
 *                        that GAM's records do not list as clearing. None of it is counted
 *                        as GAM's; once it clears it reads as a gap until it is named.
 */
export const CLEARING_ITEM_KINDS = [
  'tenant_payment', 'gam_fee_debit', 'flexpay_pull', 'gam_bill_line', 'business_payment', 'unrecorded_payment',
] as const
export type ClearingItemKind = typeof CLEARING_ITEM_KINDS[number]
export interface ClearingItem {
  kind: ClearingItemKind
  id: string
  paymentIntentId: string
  /** Card or bank: Stripe records a bank payment as a 'payment' balance transaction. */
  method: 'card' | 'bank'
  /** When it was paid (ISO): Stripe cannot have recorded it before then. */
  createdAt: string
  /** What GAM owes on for it once it clears (the landlord's part of a tenant payment). */
  othersShare: number
  /**
   * GAM's fee inside it — earned only when it clears (Nic 10/3) — and any of
   * GAM's own bill lines it pays (a returned-payment fee riding with the rent).
   */
  gamFee: number
  gross: number
  who: string
}

/**
 * 10/4 (review, pass 3): a payment Stripe took back after it settled — a card
 * dispute, or a bank payment disputed as unauthorized. Stripe takes the
 * disputed amount (the payer's fee on top included) and its dispute fee off
 * GAM's balance, and keeps its own processing fee. GAM's records answer for
 * each part of it the way the code that handles it does — never one rule
 * assumed for all — so the check ties whatever the rule is:
 *
 *   feesGivenBack            − the fees on top of a disputed tenant payment
 *                              that went back to the payer: what Stripe took
 *                              beyond the payment's money (connect_disputes,
 *                              while Stripe holds it: needs_response,
 *                              under_review, lost). Counted among the fees
 *                              collected when the payment cleared; gone now.
 *   feesChargedToLandlords   + what the dispute handling charged landlords'
 *                              payouts for those fees (held_payout_items
 *                              'dispute', 'stripe_fee_kept:…' —
 *                              paymentReversal.chargeKeptStripeFee: Stripe's
 *                              kept processing fee, or the whole fee, by its
 *                              DISPUTE_FEE_RULE). Whatever part of the fee no
 *                              landlord is charged is GAM's loss, and the two
 *                              lines leave exactly that, whichever the rule.
 *   chargebackFeesFromPayees + a disputed register sale, stay deposit or
 *                              business payment (heldPayouts.recordChargeback):
 *                              the payee repays the disputed amount and
 *                              Stripe's dispute fee off their payout; the
 *                              disputed amount was theirs or GAM's fee GAM
 *                              keeps, so the dispute fee is what this adds.
 *   rentNotRepaid            − landlords' rows Stripe took back that the
 *                              landlord has not repaid yet (payment_reversals
 *                              whose recovery is still owed: 'pending' or
 *                              'scheduled_netting', less what is recovered —
 *                              a share withheld before it was paid out counts
 *                              as recovered at once). It drops when the payout
 *                              nets it, or when the tenant pays the row again
 *                              (GAM keeps that payment) — the moment the
 *                              balance side gets the money back. The
 *                              landlord's own share lines a dispute moves
 *                              ('owner_share_…') are theirs, never on the book.
 *   gamLinesTakenBack        − GAM's own bill lines Stripe took back (counted
 *                              in gamOwnedBillLines when they were paid; the
 *                              tenant is billed for them again, and a
 *                              re-payment counts as new money).
 */
export interface DisputesTakenBack {
  feesGivenBack: number
  feesChargedToLandlords: number
  chargebackFeesFromPayees: number
  rentNotRepaid: number
  gamLinesTakenBack: number
  /**
   * 10/4 (review, fix pass 2): − on disputes GAM won, what the landlords were
   * charged for the fee on top (feesChargedToLandlords) that is theirs again —
   * the fee came back with the disputed money. Owed to the landlords, so the
   * balance side counts it among what they are owed and the book takes it off;
   * drops to nothing once the line handing it back is written
   * (wonDisputeFeeReturnSourceId).
   */
  feesOwedBackOnWins: number
  /**
   * 10/4 (review, fix pass 3): on a held charge's chargeback GAM won (register
   * sale, stay deposit, business payment — heldPayouts.recordChargeback took
   * the disputed amount and Stripe's dispute fee off the payee's payout), the
   * disputed amount Stripe put back on the balance. The payee repaid it, so it
   * is theirs: counted among what is owed to them (never on the book — the
   * chargeback's fee part, chargebackFeesFromPayees, does not change with the
   * outcome). Drops by what the line giving it back holds once it is written
   * (wonChargebackReturnSourceId).
   * Leftovers fix: plus Stripe's dispute fee when Stripe gave it back with the
   * win (disputeFeeReturnedOnWinSql) — the payee repaid that too.
   */
  chargebacksOwedBackOnWins: number
  /**
   * Fix pass 3: + Stripe's own dispute fee that Stripe gave back with a
   * dispute GAM won, where no payee had repaid that fee (no chargeback line —
   * a tenant payment's dispute, whose fee was GAM's cost and is billed to the
   * tenant as GAM's RETURNFEE line). It is back on the balance and nothing
   * else names it (Stripe sends it as a negative fee, never a recorded cost),
   * so it is GAM's again and the book adds it. On a held charge's chargeback
   * the payee repaid the fee and it is theirs (chargebacksOwedBackOnWins).
   * Optional for books built before it existed (read as 0).
   */
  disputeFeesReturnedOnWins?: number
}

/** What DisputesTakenBack adds to GAM's records, in cents. */
function takenBackNetCents(t: DisputesTakenBack): number {
  return cents(t.feesChargedToLandlords) + cents(t.chargebackFeesFromPayees) + cents(t.disputeFeesReturnedOnWins ?? 0)
    - cents(t.feesGivenBack) - cents(t.rentNotRepaid) - cents(t.gamLinesTakenBack) - cents(t.feesOwedBackOnWins)
}

export interface PlatformBalanceBook {
  ownerSharesOwed: number
  /**
   * Payout lines not batched yet, signed. A move-out's 'gam_lines:' line
   * (GAM's own lines paid from deposit money the landlord holds) is left out
   * until a payout nets it (gamLinesPaidFromDepositSql).
   */
  heldItemsOwed: number
  payoutsReserved: number
  depositsInTrust: number
  managerPmCutsOwed: number
  paidAheadHeld: number
  checkrHeld: number
  /**
   * 10/3 (review): pay-link card payments that did not fit (paid twice, an old
   * amount, more than was owed — pos_held_payments, decisions #13) that GAM
   * holds until the landlord refunds them. Not a sale and in nobody's payout,
   * so nothing else names them; the whole payment is on the balance.
   */
  heldPayLinkPayments: number
  clearing: ClearingItem[]
  collected: {
    processingFees: number
    registerCardFees: number
    screeningKept: number
    landlordChargesCollected: number
    flexpayKept: number
    sweptIn: number
    /**
     * Stripe's fee on a refunded held payment, taken back from the landlord's
     * payout (decisions #22: their loss, never GAM's). Stripe's cost of the
     * charge is already among Stripe's costs; this is GAM getting it back.
     */
    keptFeesRecovered: number
    /**
     * 10/3 (review): lines on a tenant's bill that are GAM's own
     * (payments.revenue_owner = 'gam' — a returned bank payment's fee, a
     * declined card's fee, On-Time Pay, a platform fee or a GAM subscription
     * the tenant pays) that Stripe collected onto the balance. They have no
     * landlord share, so the balance side always counted them as GAM's; the
     * records side never added them, and the first one paid read as a gap.
     */
    gamOwnedBillLines: number
    /**
     * 10/3 (review): the platform fee a property passes to its tenants, paid
     * inside a rent payment that cleared. It rides in the payment's processing
     * fee; it is taken out of processingFees and named here.
     */
    tenantPaidPlatformFees: number
    /** 10/3 (review): GAM's card fee on stay deposits guests paid online. */
    stayDepositFees: number
    /** 10/3 (review): GAM's cut of business invoice payments and business register card sales. */
    businessPaymentFees: number
    /** 10/3 (review): businesses' monthly invoicing fees GAM collected (netted from a payout, or debited). */
    businessInvoicingFees: number
  }
  /** gamOwnedBillLines, kind by kind, for the check's own lines. */
  gamOwnedBillLinesByKind: Array<{ kind: GamBillLineKind; label: string; amount: number }>
  /** Disputes and payments taken back after they settled (DisputesTakenBack). */
  takenBack: DisputesTakenBack
  /** Stripe costs on record, leaving out the fees on payments still clearing. */
  stripeCostsRecorded: number
  /** FlexPay rent GAM covered that the tenant's pull has not repaid. */
  flexpayFronted: number
  /** Stripe cost lines GAM already holds (recent), so the live read can find the rest. */
  recordedTxnIds: string[]
  owedByLandlordsUncollected: number
}

export interface PlatformStripeLive {
  available: number
  pending: number
  /** The balance transaction of each clearing payment Stripe has recorded, by PaymentIntent. */
  clearingOnBalance: Record<string, { net: number; fee: number }>
  /**
   * 10/3 (review): bank payments still clearing on the balance that GAM's
   * records do not list as clearing — a business invoice paid by bank (GAM
   * records it once it clears), or one GAM's records do not list at all. Each
   * is in clearingOnBalance too. Optional: absent = none found.
   */
  clearingNotInRecords?: ClearingItem[]
  /** Stripe's fees on those that GAM has already recorded (nightly): kept off the book side, like every clearing payment's. */
  clearingNotInRecordsFeesRecorded?: number
  /** Money paid out of the platform balance to GAM's own bank. */
  paidOutToGamBank: number
  /** Stripe charges already taken off the balance that GAM has not recorded yet (it records nightly). */
  costsNotYetRecorded: number
}

export interface PlatformBalanceSplit {
  stripeAvailable: number | null
  stripePending: number | null
  onBalance: number | null
  /** GAM's own money, earned and on the balance. null when Stripe could not be read. */
  gamsOwn: number | null
  owedToLandlords: number
  depositsInTrust: number
  managerPmCutsOwed: number
  paidAheadHeld: number
  checkrHeld: number
  heldPayLinkPayments: number
  clearing: {
    count: number
    /** Landlords' money in payments Stripe has already put on the balance. */
    landlordsOnBalance: number
    /** Landlords' money in payments Stripe has not recorded yet (not on the balance). */
    landlordsNotYetOnBalance: number
    /** 10/3 (review): businesses' money in their invoice bank payments still clearing (on the balance). */
    businessesOnBalance: number
    /**
     * 10/3 (review): bank payments on the balance, still clearing, that GAM's
     * records do not list as clearing — what they put on the balance. None of it is
     * counted as GAM's (nor in the gam* figures below).
     */
    unrecorded: { count: number; netOnBalance: number }
    /** GAM's fees on payments still clearing — not earned until they clear. */
    gamFees: number
    /** What Stripe already took off the balance on those on it. */
    stripeTook: number
    /** Everything the clearing payments have put on the balance so far. */
    netOnBalance: number
    /**
     * 10/3 (review): GAM's part of netOnBalance — what the clearing payments
     * already on the balance hold for GAM, after Stripe's cut (their fees, and
     * all of a GAM-fee debit or a FlexPay pull). Both cards show this one
     * figure, so they can never read two different "still clearing" amounts.
     */
    gamOnBalance: number
    /**
     * GAM's money in every clearing payment, before Stripe's cut, on the same
     * basis as gamOnBalance (a tenant payment's fees and GAM's own bill lines;
     * all of a GAM-fee debit or a FlexPay pull). To the cent:
     *   gamTotal = gamOnBalance + stripeTook + gamNotYetOnBalance.
     */
    gamTotal: number
    /** gamTotal's part in payments Stripe has not recorded yet (not on the balance). */
    gamNotYetOnBalance: number
    items: Array<ClearingItem & { onBalance: boolean }>
  }
  reconciliation: {
    collected: number
    collectedParts: PlatformBalanceBook['collected']
    gamOwnedBillLinesByKind: PlatformBalanceBook['gamOwnedBillLinesByKind']
    /** Disputes and payments taken back, part by part, and what they add up to (negative: they take away). */
    takenBack: DisputesTakenBack & { net: number }
    stripeCosts: number
    stripeCostsNotYetRecorded: number
    paidOutToGamBank: number
    flexpayFronted: number
    /** What GAM's records say GAM's own should be. */
    book: number
    /** What the balance says it is (gamsOwn). */
    onBalance: number | null
    /** onBalance − book. 0 when the two agree to the cent. */
    gap: number | null
  } | null
  owedByLandlordsUncollected: number
}

/**
 * The balance, split by whose it is. Every amount once: the balance is already
 * net of what Stripe took, so nothing here subtracts a Stripe cost from it; a
 * clearing payment counts by what it actually put on the balance (its net), and
 * nothing by what it will be once it clears.
 */
export function splitPlatformBalance(book: PlatformBalanceBook, live: PlatformStripeLive | null): PlatformBalanceSplit {
  // GAM's records' clearing payments, and (10/3 review) the ones Stripe has on
  // the balance that the records do not list as clearing.
  const known = new Set(book.clearing.map(i => i.paymentIntentId))
  const found = (live?.clearingNotInRecords ?? []).filter(i => !known.has(i.paymentIntentId))
  const items = [...book.clearing, ...found].map(i => ({ ...i, onBalance: !!live?.clearingOnBalance[i.paymentIntentId] }))
  let landlordsOnBalance = 0, landlordsNotYet = 0, gamFees = 0, stripeTook = 0, netOnBalance = 0, gamOnBalance = 0
  let gamTotal = 0, gamNotYet = 0, businessesOnBalance = 0, unrecordedCount = 0, unrecordedNet = 0
  for (const i of items) {
    const bt = live?.clearingOnBalance[i.paymentIntentId]
    // A payment GAM's records do not list as clearing: whatever it put on the balance is
    // not GAM's (yet), and none of it is in GAM's clearing figures.
    if (i.kind === 'unrecorded_payment') {
      if (bt) { netOnBalance += cents(bt.net); unrecordedNet += cents(bt.net); unrecordedCount++ }
      continue
    }
    gamFees += cents(i.gamFee)
    // What in it is someone else's: a tenant payment's landlord share, a
    // business payment's business share. A GAM-fee debit, a FlexPay pull or
    // GAM's own bill line is GAM's money all through.
    const others = i.kind === 'tenant_payment' || i.kind === 'business_payment' ? cents(i.othersShare) : 0
    const gamPart = cents(i.gross) - others
    gamTotal += gamPart
    if (bt) {
      netOnBalance += cents(bt.net); stripeTook += cents(bt.fee)
      if (i.kind === 'business_payment') businessesOnBalance += others
      else landlordsOnBalance += others
      gamOnBalance += cents(bt.net) - others
    } else {
      landlordsNotYet += others
      gamNotYet += gamPart
    }
  }
  // 10/4 (review, fix pass 2): plus the fees a won dispute made theirs again;
  // (fix pass 3) and what a won chargeback put back that the payee had repaid.
  const owedToLandlords = cents(book.ownerSharesOwed) + cents(book.heldItemsOwed) + cents(book.payoutsReserved)
    + cents(book.takenBack.feesOwedBackOnWins) + cents(book.takenBack.chargebacksOwedBackOnWins ?? 0)
  const notGams = owedToLandlords + cents(book.depositsInTrust) + cents(book.managerPmCutsOwed)
    + cents(book.paidAheadHeld) + cents(book.checkrHeld) + cents(book.heldPayLinkPayments) + netOnBalance
  const onBalanceC = live ? cents(live.available) + cents(live.pending) : null
  const gamsOwnC = onBalanceC == null ? null : onBalanceC - notGams

  const c = book.collected
  const collectedC = cents(c.processingFees) + cents(c.registerCardFees) + cents(c.screeningKept)
    + cents(c.landlordChargesCollected) + cents(c.flexpayKept) + cents(c.sweptIn) + cents(c.keptFeesRecovered)
    + cents(c.gamOwnedBillLines) + cents(c.tenantPaidPlatformFees) + cents(c.stayDepositFees)
    + cents(c.businessPaymentFees) + cents(c.businessInvoicingFees)
  const notYetC = live ? cents(live.costsNotYetRecorded) : 0
  const paidOutC = live ? cents(live.paidOutToGamBank) : 0
  // Stripe's fee on a clearing payment is never a cost on the book side (the
  // payment's net is set apart on the balance side instead). The records list
  // their own clearing payments' fees apart already; those found only on the
  // balance are taken off here.
  const costsC = cents(book.stripeCostsRecorded) - (live ? cents(live.clearingNotInRecordsFeesRecorded ?? 0) : 0)
  const takenBackC = takenBackNetCents(book.takenBack)
  const bookC = collectedC + takenBackC - costsC - notYetC - paidOutC - cents(book.flexpayFronted)

  return {
    stripeAvailable: live ? round2(live.available) : null,
    stripePending: live ? round2(live.pending) : null,
    onBalance: onBalanceC == null ? null : dollars(onBalanceC),
    gamsOwn: gamsOwnC == null ? null : dollars(gamsOwnC),
    owedToLandlords: dollars(owedToLandlords),
    depositsInTrust: round2(book.depositsInTrust),
    managerPmCutsOwed: round2(book.managerPmCutsOwed),
    paidAheadHeld: round2(book.paidAheadHeld),
    checkrHeld: round2(book.checkrHeld),
    heldPayLinkPayments: round2(book.heldPayLinkPayments),
    clearing: {
      count: items.length,
      landlordsOnBalance: dollars(landlordsOnBalance),
      landlordsNotYetOnBalance: dollars(landlordsNotYet),
      businessesOnBalance: dollars(businessesOnBalance),
      unrecorded: { count: unrecordedCount, netOnBalance: dollars(unrecordedNet) },
      gamFees: dollars(gamFees),
      stripeTook: dollars(stripeTook),
      netOnBalance: dollars(netOnBalance),
      gamOnBalance: dollars(gamOnBalance),
      gamTotal: dollars(gamTotal),
      gamNotYetOnBalance: dollars(gamNotYet),
      items,
    },
    reconciliation: live ? {
      collected: dollars(collectedC),
      collectedParts: c,
      gamOwnedBillLinesByKind: book.gamOwnedBillLinesByKind,
      takenBack: { ...book.takenBack, net: dollars(takenBackC) },
      // What Stripe charged GAM, on record (its fees on clearing payments left out).
      stripeCosts: dollars(costsC),
      stripeCostsNotYetRecorded: dollars(notYetC),
      paidOutToGamBank: dollars(paidOutC),
      flexpayFronted: round2(book.flexpayFronted),
      book: dollars(bookC),
      onBalance: gamsOwnC == null ? null : dollars(gamsOwnC),
      gap: gamsOwnC == null ? null : dollars(gamsOwnC - bookC),
    } : null,
    owedByLandlordsUncollected: round2(book.owedByLandlordsUncollected),
  }
}

const num = (v: any) => Number(v ?? 0)
const isoOf = (v: any) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())

/**
 * DisputesTakenBack, read from GAM's records: what each dispute or take-back
 * did, as the code that handled it recorded it (see the interface).
 */
export async function loadDisputesTakenBack(exec: SqlExec): Promise<DisputesTakenBack> {
  // The statuses under which Stripe holds a dispute's money — one list, the
  // credit ledger's (an inquiry moves none; a won dispute's came back).
  const { DISPUTE_STATUSES_MONEY_TAKEN } = await import('./creditUse')
  const held = `ARRAY[${DISPUTE_STATUSES_MONEY_TAKEN.map(s => `'${s}'`).join(', ')}]::text[]`
  // The fees on top that went back to the payer: what the dispute took beyond
  // the payment's money, never more than the fees on top (one dispute per
  // charge at Stripe; the largest if a record were ever repeated).
  const [given] = await exec(`
    SELECT COALESCE(SUM(GREATEST(0,
             LEAST(d.taken, COALESCE(r.gross_amount, r.amount + r.processing_fee_amount)) - r.amount)), 0)::float AS amt
      FROM tenant_remittances r
      JOIN LATERAL (SELECT MAX(cd.amount) AS taken FROM connect_disputes cd
                     WHERE cd.stripe_payment_intent_id = r.stripe_payment_intent_id
                       AND cd.status = ANY(${held})) d ON d.taken IS NOT NULL
     WHERE r.status = 'settled' AND r.payment_method IN ('card', 'ach') AND r.stripe_payment_intent_id IS NOT NULL`)
  // 'dispute' payout lines are of three kinds; the check reads two of them:
  //   - a fee the handling of a disputed tenant payment charged a landlord
  //     (paymentReversal: 'stripe_fee_kept:<intent>[:<landlord>]') — counted;
  //   - a chargeback on a held charge, keyed on Stripe's dispute (connect_disputes
  //     records it first) — counted below;
  //   - the landlord's own share of a disputed row GAM had not paid out yet
  //     (paymentReversal: 'owner_share_untouched:' / 'owner_share_withheld:' /
  //     'owner_share_returned:'): their money moving between their own lines,
  //     never GAM's — left out (the reversal's recovered amount says what of
  //     the loss it covered).
  //   10/4 (review, fix pass 2): and the line that hands such a fee back
  //   once GAM wins the dispute (positive, wonDisputeFeeReturnSourceId) — it
  //   counts against the fee it hands back, so the two read what the landlord
  //   is charged now.
  const [landlordFees] = await exec(`
    SELECT COALESCE(SUM(-h.amount), 0)::float AS amt FROM held_payout_items h
     WHERE h.source_type = 'dispute' AND h.source_id LIKE 'stripe\\_fee\\_kept:%'`)
  // 10/4 (review, fix pass 2): a dispute GAM won put the money back — the fee
  // on top in it (feesGivenBack leaves a won dispute out) — so what the
  // landlords were charged for that fee is theirs again: owed to them, never
  // GAM's, until the line handing it back is written (then that line is what
  // they are owed, and this drops to nothing).
  const [owedBack] = await exec(`
    SELECT COALESCE(SUM(GREATEST(0, f.charged)), 0)::float AS amt
      FROM (SELECT split_part(h.source_id, ':', 2) AS pi, SUM(-h.amount) AS charged
              FROM held_payout_items h
             WHERE h.source_type = 'dispute' AND h.source_id LIKE 'stripe\\_fee\\_kept:%'
             GROUP BY 1) f
     WHERE EXISTS (SELECT 1 FROM connect_disputes cd
                    WHERE cd.stripe_payment_intent_id = f.pi AND cd.status = '${DISPUTE_STATUS_WON}')`)
  const [chargebacks] = await exec(`
    SELECT COALESCE(SUM(-h.amount - cd.amount), 0)::float AS amt FROM held_payout_items h
      JOIN connect_disputes cd ON cd.stripe_dispute_id = h.source_id
     WHERE h.source_type = 'dispute'`)
  // 10/4 (review, fix pass 3): a held charge's chargeback GAM won — the
  // disputed amount came back to the balance, and the payee had repaid it.
  // Owed to them, less any line already giving it back. One dispute per
  // charge; a chargeback line exists only when a payee was charged.
  // Leftovers fix: and Stripe's dispute fee when Stripe gave it back with the
  // win (disputeFeeReturnedOnWinSql) — the payee repaid that fee too, so it is
  // theirs; without it GAM quietly kept the $15.
  const [chargebacksWon] = await exec(`
    SELECT COALESCE(SUM(GREATEST(0, cd.amount + ${disputeFeeReturnedOnWinSql('cd')} - COALESCE(
             (SELECT SUM(r.amount) FROM held_payout_items r
               WHERE r.source_type = 'dispute' AND r.source_id = cd.stripe_dispute_id || ':returned_on_win'), 0))), 0)::float AS amt
      FROM connect_disputes cd
     WHERE cd.status = '${DISPUTE_STATUS_WON}'
       AND EXISTS (SELECT 1 FROM held_payout_items h
                    WHERE h.source_type = 'dispute' AND h.source_id = cd.stripe_dispute_id AND h.amount < 0)`)
  // Fix pass 3: Stripe's dispute fee Stripe gave back with a win, where no
  // payee repaid it (no chargeback line): GAM's cost come back — GAM's again.
  const [disputeFeesBack] = await exec(`
    SELECT COALESCE(SUM(${disputeFeeReturnedOnWinSql('cd')}), 0)::float AS amt
      FROM connect_disputes cd
     WHERE cd.status = '${DISPUTE_STATUS_WON}' AND ${NO_CHARGEBACK_LINE('cd')} AND ${DISPUTE_OF_REAL_LANDLORD('cd')}`)
  const [notRepaid] = await exec(`
    SELECT COALESCE(SUM(reversed_amount - recovered_amount), 0)::float AS amt FROM payment_reversals
     WHERE recovery_status IN ('pending', 'scheduled_netting') AND status <> 'resolved'`)
  const [gamLines] = await exec(`
    SELECT COALESCE(SUM(pr.reversed_amount), 0)::float AS amt
      FROM payment_reversals pr JOIN payments p ON p.id = pr.payment_id
     WHERE p.revenue_owner = 'gam' AND p.manual_method IS NULL AND p.stripe_payment_intent_id IS NOT NULL
       AND COALESCE(p.entry_description, '') NOT IN ${GAM_BILL_LINES_LEFT_OUT}`)
  return {
    feesGivenBack: round2(num(given?.amt)),
    feesChargedToLandlords: round2(num(landlordFees?.amt)),
    chargebackFeesFromPayees: round2(num(chargebacks?.amt)),
    rentNotRepaid: round2(num(notRepaid?.amt)),
    gamLinesTakenBack: round2(num(gamLines?.amt)),
    feesOwedBackOnWins: round2(num(owedBack?.amt)),
    chargebacksOwedBackOnWins: round2(num(chargebacksWon?.amt)),
    disputeFeesReturnedOnWins: round2(num(disputeFeesBack?.amt)),
  }
}

/**
 * 10/4 (review, fix pass 3): SQL, on a connect_disputes alias — when that
 * dispute was won, from a record that never moves (see loadMarginFeesBack).
 */
export function disputeWonAtSql(cd: string): string {
  return `COALESCE(${cd}.outcome_at,
    (SELECT MIN(e.received_at) FROM stripe_webhook_events e
      WHERE e.event_type IN ('charge.dispute.closed', 'charge.dispute.updated')
        AND e.payload->'data'->'object'->>'id' = ${cd}.stripe_dispute_id
        AND e.payload->'data'->'object'->>'status' = '${DISPUTE_STATUS_WON}'),
    ${cd}.updated_at)`
}

/**
 * 10/4 (review, fix pass 2): the source_id of the payout line that hands a
 * landlord back the fee a dispute charged them ('stripe_fee_kept:<intent>:<landlord>')
 * once GAM wins that dispute — source_type 'dispute', a positive amount. The
 * cards read it by this shape (DisputesTakenBack.feesOwedBackOnWins and
 * feesChargedToLandlords; the margin card never counts it — its
 * fee_owed_back_on_win already did, in the month of the win). The dispute
 * handling writes it.
 * 10/4 (review, fix pass 3): shaped 'stripe_fee_kept:<intent>:<landlord>:returned_on_win',
 * inside paymentReversal's classification contract (disputeFeeLineSql,
 * 'stripe\_fee\_kept:%'), so every payout and statement reader that follows
 * the contract reads it as the landlord's dispute-fee line (a positive one,
 * cancelling the fee) — never as a register or stay chargeback. The intent
 * stays the second part, as on the fee line it hands back.
 */
export function wonDisputeFeeReturnSourceId(paymentIntentId: string, landlordId: string): string {
  return `stripe_fee_kept:${paymentIntentId}:${landlordId}:returned_on_win`
}

/**
 * 10/4 (review, fix pass 3): the source_id of the payout line that gives a
 * payee back what a chargeback on a held charge (register sale, stay deposit,
 * business payment) took off their payout, once GAM wins that dispute —
 * source_type 'dispute', a positive amount. Under paymentReversal's contract
 * it is a chargeback line (neither 'owner_share_…' nor 'stripe_fee_kept:…').
 * Until it is written, the cards count the disputed amount Stripe put back as
 * owed to the payee (DisputesTakenBack.chargebacksOwedBackOnWins). The dispute
 * handling writes it, for the disputed amount plus Stripe's dispute fee when
 * Stripe gave that back too (disputeFeeReturnedOnWinCents).
 */
export function wonChargebackReturnSourceId(stripeDisputeId: string): string {
  return `${stripeDisputeId}:returned_on_win`
}

/**
 * Leftovers fix: Stripe's dispute fee that came back with a won dispute, in
 * cents, read from the dispute object Stripe sends (Stripe.Dispute
 * .balance_transactions: the one that took the money carries the fee as a
 * positive `fee`; the one that put the money back, amount > 0, carries the
 * fee Stripe returned as a NEGATIVE `fee`, or 0 when Stripe kept it). Never
 * negative.
 *
 * The writer of a won chargeback's line (wonChargebackReturnSourceId) gives
 * the payee the disputed amount plus this, since they repaid both off their
 * payout; until that line is written, disputeFeeReturnedOnWinSql counts the
 * same fee among what is owed to them (DisputesTakenBack
 * .chargebacksOwedBackOnWins). The same rule, read from the same object.
 */
export function disputeFeeReturnedOnWinCents(dispute: {
  balance_transactions?: Array<{ amount?: number | null; fee?: number | null } | string> | null
}): number {
  let back = 0
  for (const bt of dispute.balance_transactions ?? []) {
    if (!bt || typeof bt !== 'object') continue
    if ((bt.amount ?? 0) > 0) back -= bt.fee ?? 0
  }
  return Math.max(0, back)
}

/**
 * Leftovers fix: disputeFeeReturnedOnWinCents as SQL, in dollars, on a
 * connect_disputes alias — read from the dispute as Stripe sent it in its
 * webhooks (stripe_webhook_events stores each payload before processing and
 * never rewrites it). The most any one of its events says came back; 0 when
 * none says so (Stripe kept its fee, or the dispute was not won).
 */
export function disputeFeeReturnedOnWinSql(cd: string): string {
  return `COALESCE((SELECT MAX(f.back) FROM (
      SELECT GREATEST(0, -SUM(COALESCE((bt->>'fee')::numeric, 0))) / 100.0 AS back
        FROM stripe_webhook_events e
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(e.payload->'data'->'object'->'balance_transactions') = 'array'
               THEN e.payload->'data'->'object'->'balance_transactions' ELSE '[]'::jsonb END) bt
       WHERE e.event_type LIKE 'charge.dispute.%'
         AND e.payload->'data'->'object'->>'id' = ${cd}.stripe_dispute_id
         AND jsonb_typeof(bt) = 'object' AND COALESCE((bt->>'amount')::numeric, 0) > 0
       GROUP BY e.id) f), 0)`
}

/** GAM's records: everything the split and the reconciliation need. */
export async function loadPlatformBalanceBook(): Promise<PlatformBalanceBook> {
  const [owed] = await query<any>(`
    SELECT COALESCE(SUM(ubl.amount), 0)::float AS amt
      FROM payments p
      JOIN user_balance_ledger ubl
        ON ubl.reference_id = p.id AND ubl.reference_type = 'payment'
       AND ubl.type = 'allocation_owner_share' AND ubl.stripe_transfer_id IS NULL
     WHERE p.platform_held = TRUE AND p.status = 'settled'`)
  // Leftovers fix: a move-out's 'gam_lines:' line (GAM's own bill lines paid
  // from deposit money the landlord holds) is left out until a payout nets
  // it — GAM counts those lines as its money only then
  // (gamLinesPaidFromDepositSql); counting the line here first read as a gap.
  const [held] = await query<any>(
    `SELECT COALESCE(SUM(h.amount), 0)::float AS amt FROM held_payout_items h
      WHERE h.payout_intent_id IS NULL AND NOT ${unnettedGamLinesItemSql('h')}`)
  const [reserved] = await query<any>(
    `SELECT COALESCE(SUM(amount), 0)::float AS amt FROM platform_transfer_intents WHERE status = 'pending'`)
  const [deposits] = await query<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS amt FROM payments
     WHERE type = 'deposit' AND platform_held = TRUE AND status = 'settled'`)
  // Step 9 (final fix — decisions #46.3, #47a): deposit money a finalized
  // move-out still owes back to the tenant from what GAM holds. Finalize stops
  // counting the deposit payments it used up as deposits GAM holds
  // (platform_held cleared — their kept part rides a held item or the escrow
  // transfer), so without this line the refund GAM still owes was counted
  // nowhere and read as GAM's own money. It is the tenant's: a liability,
  // inside "deposits GAM holds". Fix pass 1 (deprefund review): only the
  // refund parts still open count (depositRefundSend.depositRefundsOwedSql) —
  // a split refund with $300 sent and $200 failed owes $200, not $500; a part
  // given back in cash is the landlord's payout line instead.
  const { depositRefundsOwedSql } = await import('./depositRefundSend')
  const [refundsOwed] = await query<any>(depositRefundsOwedSql())
  // A manager's or PM company's cut is sent by its own transfer; until then it
  // is on GAM's balance and it is theirs.
  const [cuts] = await query<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS amt FROM user_balance_ledger
     WHERE type IN ('allocation_manager_fee', 'allocation_pm_company_fee')
       AND stripe_transfer_id IS NULL AND amount > 0`)
  // Money a tenant paid ahead through GAM, held for their later bills.
  const [ahead] = await query<any>(`
    SELECT COALESCE(SUM(amount_remaining), 0)::float AS amt FROM lease_prepaid_credits
     WHERE funded_by = 'gam' AND voided_at IS NULL`)

  // Nic 10/3: background-check money applicants paid is not GAM's. GAM's part
  // of a screening is its $5 and the card fee; the rest is Checkr's.
  // Known limit: this is every unrefunded screening ever — GAM keeps no record
  // of what it has paid Checkr. Paid from GAM's own bank (after a payout took
  // the money there), the line stays and the headline reads low by what was
  // paid; the check shows no gap, because both of its sides take payouts off.
  const checks = await query<any>(`
    SELECT bc.amount_charged::float AS charged,
           (SELECT SUM(l.amount) FROM platform_revenue_ledger l
             WHERE l.type = 'screening_margin' AND l.reference_type = 'background_check'
               AND l.reference_id = bc.id)::float AS margin,
           (SELECT MAX(l.customer_fee_charged) FROM platform_revenue_ledger l
             WHERE l.type = 'banking_spread' AND l.reference_type = 'background_check'
               AND l.reference_id = bc.id)::float AS fee
      FROM background_checks bc
     WHERE bc.applicant_payment_intent_id IS NOT NULL AND bc.amount_charged > 0
       AND bc.refunded_at IS NULL`)
  let checkrC = 0, screeningKeptC = 0
  for (const r of checks) {
    const charged = cents(num(r.charged))
    const margin = cents(r.margin != null ? num(r.margin) : PLATFORM_FEES.BG_CHECK_NET)
    const fee = cents(r.fee != null ? num(r.fee) : screeningFeeInside(num(r.charged)))
    const kept = Math.min(charged, margin + fee)
    screeningKeptC += kept
    checkrC += charged - kept
  }
  // 10/5 (Nic, A5): a background check paid WITH A STAY has no applicant
  // payment of its own (applicant_payment_intent_id is NULL), so it was counted
  // above nowhere. Paid by card or online, its amount sits on GAM's balance;
  // paid in cash at the counter, it reaches GAM only as the 'screening_fee'
  // charge taken from the landlord's payout (counted here by what was
  // collected, and left out of landlordChargesCollected below so it is counted
  // once). GAM's part is the margin booked when the check it paid for was
  // submitted — nothing while it waits for the guest; the rest is Checkr's.
  const prepaidChecks = await query<any>(`
    SELECT (CASE WHEN sp.landlord_charge_id IS NULL THEN sp.amount
                 ELSE COALESCE(c.collected_amount, 0) END)::float AS charged,
           (SELECT SUM(l.amount) FROM platform_revenue_ledger l
             WHERE l.type = 'screening_margin' AND l.reference_type = 'background_check'
               AND l.reference_id = sp.used_by_check_id)::float AS margin
      FROM screening_prepayments sp
      LEFT JOIN landlord_gam_charges c ON c.id = sp.landlord_charge_id
     WHERE sp.status <> 'void'`)
  for (const r of prepaidChecks) {
    const charged = cents(num(r.charged))
    const kept = Math.min(charged, Math.max(0, cents(num(r.margin))))
    screeningKeptC += kept
    checkrC += charged - kept
  }

  const tenantClearing = await query<any>(`
    SELECT r.id, r.stripe_payment_intent_id AS pi, r.amount::float AS amount, r.payment_method, r.created_at,
           r.processing_fee_amount::float AS fee,
           COALESCE(r.gross_amount, r.amount + r.processing_fee_amount)::float AS gross,
           -- 10/3 (review): a fee the landlord covers is GAM's too, and comes
           -- out of the landlord's part (gamFeeOnRemittance).
           ${remittanceFeeColumnsSql('r', 'tpf')},
           -- GAM's own bill lines it pays (a returned-payment fee riding with
           -- the rent): GAM's, never the landlord's.
           COALESCE((SELECT SUM(ra.amount_applied) FROM remittance_applications ra
                       JOIN payments gp ON gp.id = ra.payment_id
                      WHERE ra.remittance_id = r.id AND gp.revenue_owner = 'gam'), 0)::float AS gam_lines,
           ${nameSql('u')} AS person, pr.name AS property_name, un.unit_number
      FROM tenant_remittances r
      LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
      LEFT JOIN tenants t ON t.id = r.tenant_id
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN leases l ON l.id = r.lease_id
      LEFT JOIN units un ON un.id = l.unit_id
      LEFT JOIN properties pr ON pr.id = un.property_id
     WHERE r.status = 'processing' AND r.stripe_payment_intent_id IS NOT NULL
     ORDER BY r.created_at`)
  const debitClearing = await query<any>(`
    SELECT d.id, d.stripe_payment_intent_id AS pi, d.total_amount::float AS gross, d.created_at,
           d.bank_cost_amount::float AS fee, l.business_name
      FROM landlord_gam_debits d JOIN landlords l ON l.id = d.landlord_id
     WHERE d.status = 'pending' AND d.stripe_payment_intent_id IS NOT NULL`)
  const flexClearing = await query<any>(`
    SELECT p.id, p.stripe_payment_intent_id AS pi, p.amount::float AS gross, p.created_at
      FROM payments p
     WHERE p.entry_description = 'FLEXPAY' AND p.status = 'processing'
       AND p.stripe_payment_intent_id IS NOT NULL`)
  // 10/3 (review): one of GAM's own bill lines charged on its own (not inside a
  // tenant's payment) and still clearing — GAM's money, not earned until it
  // clears; once it does, the check's "GAM's own bill lines" counts it.
  const billLineClearing = await query<any>(`
    SELECT p.id, p.stripe_payment_intent_id AS pi, p.amount::float AS gross, p.created_at
      FROM payments p
     WHERE p.revenue_owner = 'gam' AND p.status = 'processing' AND p.manual_method IS NULL
       AND p.stripe_payment_intent_id IS NOT NULL
       AND COALESCE(p.entry_description, '') NOT IN ${GAM_BILL_LINES_LEFT_OUT}
       AND NOT EXISTS (SELECT 1 FROM remittance_applications ra WHERE ra.payment_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM tenant_remittances r WHERE r.stripe_payment_intent_id = p.stripe_payment_intent_id)`)
  const clearing: ClearingItem[] = [
    ...tenantClearing.map((r: any): ClearingItem => {
      const landlordCovers = gamFeeOnRemittance(remittanceFeeOf(r)).landlordBorne
      return {
        kind: 'tenant_payment', id: r.id, paymentIntentId: r.pi,
        method: r.payment_method === 'card' ? 'card' : 'bank', createdAt: isoOf(r.created_at),
        othersShare: dollars(cents(num(r.amount)) - cents(num(r.gam_lines)) - cents(landlordCovers)),
        gamFee: dollars(cents(num(r.fee)) + cents(num(r.gam_lines)) + cents(landlordCovers)), gross: num(r.gross),
        who: [r.person ?? 'A tenant', [r.property_name, r.unit_number].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
      }
    }),
    ...debitClearing.map((r: any): ClearingItem => ({
      kind: 'gam_fee_debit', id: r.id, paymentIntentId: r.pi, method: 'bank', createdAt: isoOf(r.created_at),
      othersShare: 0, gamFee: num(r.fee),
      gross: num(r.gross), who: `GAM fees pulled from ${r.business_name ?? 'a landlord'}`,
    })),
    ...flexClearing.map((r: any): ClearingItem => ({
      kind: 'flexpay_pull', id: r.id, paymentIntentId: r.pi, method: 'bank', createdAt: isoOf(r.created_at),
      othersShare: 0, gamFee: 0,
      gross: num(r.gross), who: 'FlexPay pull',
    })),
    ...billLineClearing.map((r: any): ClearingItem => ({
      kind: 'gam_bill_line', id: r.id, paymentIntentId: r.pi, method: 'bank', createdAt: isoOf(r.created_at),
      othersShare: 0, gamFee: num(r.gross),
      gross: num(r.gross), who: 'A GAM fee a tenant paid on its own',
    })),
  ]
  const clearingPis = clearing.map(i => i.paymentIntentId)

  // 10/3 (review): the processing fee alone — a platform fee passed to tenants
  // rides in processing_fee_amount and is its own line — and a fee the
  // landlord covers, taken from their share when the payment settled
  // (gamFeeOnRemittance), counted like a fee the payer paid on top.
  const settledRemits = await query<any>(`
    SELECT r.amount::float AS amount, r.payment_method, COALESCE(tpf.amt, 0)::float AS platform_fee,
           ${remittanceFeeColumnsSql('r', 'tpf')}
      FROM tenant_remittances r
      LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
     WHERE r.status = 'settled' AND r.payment_method IN ('card', 'ach') AND r.stripe_payment_intent_id IS NOT NULL`)
  const processingFeesC = settledRemits.reduce((a, r) => a + cents(gamFeeOnRemittance(remittanceFeeOf(r)).total), 0)
  const tenantPlatformFeesC = settledRemits.reduce((a, r) => a + cents(num(r.platform_fee)), 0)
  // 10/3 (review): a card sale refunded at the register is still on the
  // balance with GAM's fee in it (CARD_SALE_ON_BALANCE_STATUSES).
  const [sales] = await query<any>(`
    SELECT COALESCE(SUM(platform_fee), 0)::float AS amt FROM pos_transactions
     WHERE payment_method IN ('card', 'card_on_file') AND stripe_payment_intent_id IS NOT NULL
       AND ${cardSaleOnBalanceSql('status')}`)
  // 10/3 (review): stay deposits guests paid online — GAM's card fee on each
  // (the charge less the landlord's payout line), read from the payout line
  // (stayDepositFeeFromPayoutLine), never from deposit_amount alone.
  const stayDeposits = await query<{ deposit: string | null; held: string; fee_payer: string | null }>(`
    SELECT b.deposit_amount::text AS deposit, h.amount::text AS held, pr.booking_card_fee_payer AS fee_payer
      FROM unit_bookings b
      JOIN held_payout_items h ON h.source_type = 'booking_deposit' AND h.source_id = b.id::text
      LEFT JOIN units un ON un.id = b.unit_id
      LEFT JOIN properties pr ON pr.id = un.property_id
     WHERE b.deposit_paid_at IS NOT NULL AND b.stripe_payment_intent_id IS NOT NULL`)
  const stayDepositFeesC = stayDeposits.reduce((a, r) =>
    a + cents(stayDepositFeeFromPayoutLine(num(r.held), r.deposit == null ? null : num(r.deposit), r.fee_payer)), 0)
  // 10/3 (review): the business portal's payments on GAM's account — GAM's cut
  // of each (what was paid less the business's payout line) — and the monthly
  // invoicing fees collected from businesses.
  const bizPayments = await query<{ gross: string; held: string | null; priced: string }>(`
    SELECT bip.amount::text AS gross, h.amount::text AS held,
           CASE WHEN bip.method = 'ach' THEN 'ach' ELSE 'card' END AS priced
      FROM business_invoice_payments bip
      LEFT JOIN held_payout_items h ON h.source_type = 'business_invoice_payment'
                                   AND h.source_id = bip.stripe_checkout_session_id
     WHERE bip.method IN ('card', 'ach') AND bip.stripe_payment_intent_id IS NOT NULL
    UNION ALL
    SELECT (t.total_amount + t.tip_amount + t.card_surcharge)::text, h.amount::text,
           CASE WHEN t.card_surcharge > 0 THEN t.card_surcharge::text ELSE 'card' END
      FROM business_pos_transactions t
      LEFT JOIN held_payout_items h ON h.source_type = 'business_pos_sale' AND h.source_id = t.id::text
     WHERE t.stripe_payment_intent_id IS NOT NULL AND t.payment_method IN ('stripe_terminal', 'stripe_checkout')
       AND t.status IN ('completed', 'partially_refunded', 'refunded')`)
  const businessPaymentFeesC = bizPayments.reduce((a, r) => {
    const gross = num(r.gross)
    const priced = r.priced === 'ach' || r.priced === 'card'
      ? processingFeeFor({ amount: gross, paymentMethod: r.priced }) : num(r.priced)
    return a + cents(businessCut(gross, r.held, priced))
  }, 0)
  const [bizFees] = await query<any>(
    `SELECT COALESCE(SUM(amount), 0)::float AS amt FROM business_platform_fee_accruals WHERE status = 'collected'`)
  // 10/3 (review): GAM's own lines on tenants' bills that Stripe collected
  // onto the balance — inside a bank or card payment that settled, or charged
  // on their own (a FlexDeposit custody or FlexCredit fee). A line paid at the
  // desk never reached the balance and is not here. A payment's own row counts
  // without its supersedence part (money it carried toward an older GAM debt —
  // the check's known limits name that).
  const billLines = await query<{ kind: GamBillLineKind; amt: number }>(`
    SELECT kind, COALESCE(SUM(amt), 0)::float AS amt FROM (
      SELECT ${gamBillLineKindSql('p')} AS kind, ra.amount_applied AS amt
        FROM remittance_applications ra
        JOIN tenant_remittances r ON r.id = ra.remittance_id
        JOIN payments p ON p.id = ra.payment_id
       WHERE r.status = 'settled' AND r.payment_method IN ('card', 'ach') AND r.stripe_payment_intent_id IS NOT NULL
         AND p.revenue_owner = 'gam' AND COALESCE(p.entry_description, '') NOT IN ${GAM_BILL_LINES_LEFT_OUT}
      UNION ALL
      -- 10/4 (review, pass 3): one Stripe took back after it settled is
      -- 'returned' now; it still counts here, and what the dispute took is
      -- its own line (takenBack.gamLinesTakenBack), as for one paid inside
      -- a tenant's payment above.
      SELECT ${gamBillLineKindSql('p')} AS kind, p.amount - COALESCE(p.gam_supersedence_amount, 0) AS amt
        FROM payments p
       WHERE p.revenue_owner = 'gam' AND p.manual_method IS NULL
         AND (p.status = 'settled'
              OR (p.status = 'returned' AND EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)))
         AND p.stripe_payment_intent_id IS NOT NULL
         AND COALESCE(p.entry_description, '') NOT IN ${GAM_BILL_LINES_LEFT_OUT}
         AND NOT EXISTS (SELECT 1 FROM remittance_applications ra WHERE ra.payment_id = p.id)
      UNION ALL
      -- Leftovers fix: one a move-out paid from the deposit, in the part GAM
      -- has (gamLinesPaidFromDepositSql).
      SELECT ${gamBillLineKindSql('d')} AS kind, d.amt
        FROM (${gamLinesPaidFromDepositSql()}) d
    ) x GROUP BY kind`)
  const billLinesByKind = GAM_BILL_LINE_KINDS
    .map(kind => ({ kind, label: GAM_BILL_LINE_KIND_LABEL[kind], amount: round2(num(billLines.find(b => b.kind === kind)?.amt)) }))
    .filter(b => b.amount !== 0)
  const [charges] = await query<any>(
    // A stay's background check is counted with the screenings above (A5).
    `SELECT COALESCE(SUM(collected_amount), 0)::float AS amt FROM landlord_gam_charges WHERE kind <> 'screening_fee'`)
  const [flex] = await query<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS amt FROM platform_revenue_ledger
     WHERE type = 'flexpay_subscription'
        OR (type = 'adjustment' AND reference_type LIKE 'flexpay_advance_reversal%')`)
  // S650: Nic's August test payments, taken against a fake landlord and owed to
  // nobody — GAM's. Booked only as this adjustment.
  const [swept] = await query<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS amt FROM platform_revenue_ledger
     WHERE type = 'adjustment' AND reference_type = 'test_sweep'`)
  // Every cost but a clearing payment's own fee (10/3 review, pass 2: a
  // dispute's or a return's fee is never one, whatever payment it names).
  const [costs] = await query<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS amt FROM stripe_processing_costs
     WHERE NOT COALESCE(${tiedPiSql()} = ANY($1::text[]), FALSE)`, [clearingPis])
  // Held pay-link payments (decisions #13) are the payers' until the landlord
  // decides; a refunded one's kept fee, taken back from the landlord's payout
  // (decisions #22), is GAM's money back.
  const [heldPays] = await query<any>(
    `SELECT COALESCE(SUM(amount), 0)::float AS amt FROM pos_held_payments WHERE status = 'held'`)
  const [keptBack] = await query<any>(`
    SELECT COALESCE(SUM(-i.amount), 0)::float AS amt
      FROM held_payout_items i
      JOIN pos_held_payments h ON h.stripe_refund_id = i.source_id AND h.landlord_id = i.landlord_id
     WHERE i.source_type = 'refund'`)
  const takenBack = await loadDisputesTakenBack((sql, params) => query<any>(sql, params as any[]))
  const [fronted] = await query<any>(`
    SELECT COALESCE(SUM(rent_amount), 0)::float AS amt FROM flexpay_advances
     WHERE status IN ('fronted', 'pulled', 'nsf', 'defaulted')`)
  // The live read looks back up to CLEARING_LOOKBACK_DAYS for bank payments
  // still clearing; it must know which of their fees are already on record.
  const recent = await query<{ stripe_txn_id: string }>(`
    SELECT stripe_txn_id FROM stripe_processing_costs WHERE posted_at >= NOW() - make_interval(days => $1)`,
    [CLEARING_LOOKBACK_DAYS + 2])
  // S652: the book is what GAM has EARNED; part of it is fees landlords have
  // not paid yet. Said on the card.
  const [owedBy] = await query<any>(`
    SELECT COALESCE(SUM(amount - COALESCE(collected_amount, 0)), 0)::float AS amt
      FROM landlord_gam_charges WHERE amount > COALESCE(collected_amount, 0)`)

  return {
    ownerSharesOwed: round2(num(owed.amt)),
    heldItemsOwed: round2(num(held.amt)),
    payoutsReserved: round2(num(reserved.amt)),
    depositsInTrust: dollars(cents(num(deposits.amt)) + cents(num(refundsOwed.amt))),
    managerPmCutsOwed: round2(num(cuts.amt)),
    paidAheadHeld: round2(num(ahead.amt)),
    checkrHeld: dollars(checkrC),
    heldPayLinkPayments: round2(num(heldPays.amt)),
    clearing,
    collected: {
      processingFees: dollars(processingFeesC),
      tenantPaidPlatformFees: dollars(tenantPlatformFeesC),
      stayDepositFees: dollars(stayDepositFeesC),
      businessPaymentFees: dollars(businessPaymentFeesC),
      businessInvoicingFees: round2(num(bizFees.amt)),
      registerCardFees: round2(num(sales.amt)),
      screeningKept: dollars(screeningKeptC),
      landlordChargesCollected: round2(num(charges.amt)),
      flexpayKept: round2(num(flex.amt)),
      sweptIn: round2(num(swept.amt)),
      keptFeesRecovered: round2(num(keptBack.amt)),
      gamOwnedBillLines: dollars(billLinesByKind.reduce((a, b) => a + cents(b.amount), 0)),
    },
    gamOwnedBillLinesByKind: billLinesByKind,
    takenBack,
    stripeCostsRecorded: round2(num(costs.amt)),
    flexpayFronted: round2(num(fronted.amt)),
    recordedTxnIds: recent.map(r => r.stripe_txn_id),
    owedByLandlordsUncollected: round2(num(owedBy.amt)),
  }
}

/**
 * What only Stripe knows, read live: the balance, which clearing payments it
 * has already recorded, what has gone to GAM's own bank, and the cost lines
 * posted since GAM's nightly record. Throws when Stripe cannot be reached (the
 * caller then shows the split without a headline).
 */
/**
 * How far back the live read looks for bank payments still clearing that GAM's
 * records do not list as clearing. A bank payment here clears in 4-7 days; ten
 * covers a weekend and a holiday.
 */
const CLEARING_LOOKBACK_DAYS = 10

export async function readPlatformStripeLive(book: PlatformBalanceBook, s: Stripe): Promise<PlatformStripeLive> {
  const bal = await s.balance.retrieve()
  const usd = (a: any[]) => (a ?? []).filter((x: any) => x.currency === 'usd')
    .reduce((sum: number, x: any) => sum + Number(x.amount || 0), 0) / 100

  // Bank payments: one read of Stripe's 'payment' balance transactions since
  // the oldest one still clearing was made (at least the last ten days, which
  // also finds bank fees GAM has not recorded yet, and any bank payment still
  // clearing that GAM's records do not list) — never one call per payment,
  // which on the 1st of the month would be one per tenant. A bank payment
  // still clearing that is not in it has not reached the balance yet.
  const clearingOnBalance: Record<string, { net: number; fee: number }> = {}
  const clearingPis = new Set(book.clearing.map(i => i.paymentIntentId))
  const recorded = new Set(book.recordedTxnIds)
  const nowS = Math.floor(Date.now() / 1000)
  const costSince = nowS - 3 * 86400
  const lookSince = nowS - CLEARING_LOOKBACK_DAYS * 86400
  const oldestClearing = book.clearing.filter(i => i.method === 'bank')
    .reduce((m, i) => Math.min(m, Math.floor(Date.parse(i.createdAt) / 1000)), lookSince)
  let notYet = 0
  // 10/3 (review): a bank payment Stripe still has as pending (its charge is
  // 'pending') that GAM's records do not list as clearing: a business invoice
  // paid by bank (recorded only once it clears), or one GAM does not know.
  const strangers: Array<{ t: Stripe.BalanceTransaction; pi: string; charge: any }> = []
  await eachBalanceTransaction(s, { type: 'payment', created: { gte: Math.min(lookSince, oldestClearing - 86400) }, expand: ['data.source'] }, async (t) => {
    const pi = sourcePaymentIntent(t.source)
    if (pi && clearingPis.has(pi)) { clearingOnBalance[pi] = { net: t.net / 100, fee: t.fee / 100 }; return }
    const charge: any = t.source && typeof t.source === 'object' ? t.source : null
    if (pi && charge?.status === 'pending') { strangers.push({ t, pi, charge }); return }
    // A bank fee posted since GAM last recorded Stripe's charges (nightly).
    if (t.created >= costSince && t.fee > 0 && !recorded.has(`${t.id}:fee`)) notYet += t.fee
  })
  const clearingNotInRecords: ClearingItem[] = []
  let feesRecordedC = 0
  for (const { t, pi, charge } of strangers) {
    // Stripe copies a PaymentIntent's metadata onto its charge; ask for the
    // intent only when the charge does not say.
    let purpose: string | undefined = charge?.metadata?.gam_purpose
    if (!purpose) {
      const intent: any = await s.paymentIntents.retrieve(pi).catch(() => null)
      purpose = intent?.metadata?.gam_purpose
    }
    const gross = t.amount / 100
    const business = purpose === 'business_invoice'
    const cut = business ? processingFeeFor({ amount: gross, paymentMethod: 'ach' }) : 0
    clearingNotInRecords.push({
      kind: business ? 'business_payment' : 'unrecorded_payment',
      id: typeof charge?.id === 'string' ? charge.id : t.id, paymentIntentId: pi, method: 'bank',
      createdAt: new Date(t.created * 1000).toISOString(),
      othersShare: business ? dollars(cents(gross) - cents(cut)) : gross, gamFee: cut, gross,
      who: business ? 'Business invoice paid by bank' : 'A bank payment GAM\'s records do not list as clearing',
    })
    clearingOnBalance[pi] = { net: t.net / 100, fee: t.fee / 100 }
    // Its fee, if GAM has recorded it, is kept off the book side like every
    // clearing payment's (the payment's net is set apart on the balance side).
    if (t.fee > 0 && recorded.has(`${t.id}:fee`)) feesRecordedC += t.fee
  }
  // A card payment still marked clearing is rare (a card settles at once); ask for each.
  for (const item of book.clearing.filter(i => i.method === 'card')) {
    const pi: any = await s.paymentIntents.retrieve(item.paymentIntentId, { expand: ['latest_charge.balance_transaction'] })
    const bt = pi?.latest_charge?.balance_transaction
    if (bt && typeof bt === 'object') clearingOnBalance[item.paymentIntentId] = { net: bt.net / 100, fee: bt.fee / 100 }
  }

  let paidOut = 0
  let after: string | undefined
  for (;;) {
    const page: Stripe.ApiList<Stripe.Payout> = await s.payouts.list({ limit: 100, ...(after ? { starting_after: after } : {}) })
    for (const p of page.data) {
      if (p.currency !== 'usd' || p.status === 'failed' || p.status === 'canceled') continue
      paidOut += p.amount
    }
    if (!page.has_more) break
    after = page.data[page.data.length - 1]?.id
    if (!after) break
  }

  // Card and monthly cost lines Stripe has posted since GAM last recorded them,
  // and (10/3 review) a fee on any other kind of balance transaction — a
  // returned bank payment's, a dispute's — not recorded yet. Read side by side.
  await Promise.all([
    ...(['stripe_fee', 'network_cost'] as const).map(type =>
      eachBalanceTransaction(s, { type, created: { gte: costSince } }, async (t) => {
        const amt = costLineAmount(t)
        if (amt != null && !recorded.has(t.id)) notYet += cents(amt)
      })),
    ...FEE_BEARING_TXN_TYPES.filter(type => type !== 'payment').map(type =>
      eachBalanceTransaction(s, { type, created: { gte: costSince } }, async (t) => {
        if (t.fee > 0 && !recorded.has(`${t.id}:fee`)) notYet += t.fee
      })),
  ])

  return {
    available: usd(bal.available as any),
    pending: usd(bal.pending as any),
    clearingOnBalance,
    clearingNotInRecords,
    clearingNotInRecordsFeesRecorded: feesRecordedC / 100,
    paidOutToGamBank: paidOut / 100,
    costsNotYetRecorded: notYet / 100,
  }
}

/** The whole card: GAM's records, and Stripe when it answers. */
export async function platformBalance(s?: Stripe | null): Promise<PlatformBalanceSplit & { stripeError: string | null }> {
  const book = await loadPlatformBalanceBook()
  let live: PlatformStripeLive | null = null
  let stripeError: string | null = null
  const client = s === undefined ? defaultStripe : s
  if (client) {
    try { live = await readPlatformStripeLive(book, client) } catch (e) {
      stripeError = e instanceof Error ? e.message : String(e)
      logger.warn({ err: e }, '[platform-balance] Stripe could not be read — showing GAM\'s records only')
    }
  } else {
    stripeError = 'Stripe is not configured'
  }
  return { ...splitPlatformBalance(book, live), stripeError }
}

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
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

export type PlatformRevenueType =
  | 'banking_spread'
  | 'manual_withdrawal_fee'
  | 'placement_fee_share'
  | 'platform_fee_subscription'
  | 'screening_margin'
  | 'adjustment'

export interface PlatformRevenueEntry {
  type: PlatformRevenueType
  amount: number
  referenceId?: string | null
  referenceType?: string | null
  propertyId?: string | null
  notes?: string | null
}

/**
 * Post one earnings row. Best-effort by design: GAM failing to WRITE DOWN a
 * fee must never fail the thing that earned it (a screening the applicant has
 * already paid for). A missed row is recoverable from Stripe; a refused
 * screening is not.
 *
 * Idempotent per (type, reference): the same screening cannot be booked twice.
 */
export async function recordPlatformRevenue(e: PlatformRevenueEntry): Promise<void> {
  try {
    if (!(e.amount > 0)) return
    if (e.referenceId) {
      const dup = await queryOne<{ id: string }>(
        `SELECT id FROM platform_revenue_ledger
          WHERE type = $1 AND reference_id = $2 AND reference_type IS NOT DISTINCT FROM $3
          LIMIT 1`,
        [e.type, e.referenceId, e.referenceType ?? null])
      if (dup) return
    }
    const prev = await queryOne<{ balance_after: string }>(
      `SELECT balance_after FROM platform_revenue_ledger ORDER BY created_at DESC, id DESC LIMIT 1`)
    const balanceAfter = Math.round(((prev ? parseFloat(prev.balance_after) : 0) + e.amount) * 100) / 100
    await query(
      `INSERT INTO platform_revenue_ledger
         (type, amount, balance_after, reference_id, reference_type, property_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.type, e.amount, balanceAfter, e.referenceId ?? null, e.referenceType ?? null,
       e.propertyId ?? null, e.notes ?? null])
  } catch (err) {
    logger.error({ err, type: e.type, referenceId: e.referenceId },
      '[platform-revenue] could not record earnings — the money landed, the row did not')
  }
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
        notes: 'Card spread on a background check',
      })
    }
  } catch (err) {
    logger.error({ err, backgroundCheckId: args.backgroundCheckId },
      '[platform-revenue] could not record the screening card spread')
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

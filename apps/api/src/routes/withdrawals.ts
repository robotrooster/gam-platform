/**
 * S113-Phase5: manual on-demand withdrawal — Stripe Payouts edition.
 *
 * Replaces the pre-Phase4/5 model:
 *   - Reads Stripe Connect available + instant_available balances directly
 *     (not user_balance_ledger per-bank groupings).
 *   - Fires stripe.payouts.create against the user's Connect account →
 *     attached external bank. T+1–T+2 for standard; minutes for instant.
 *   - Drops the GAM manual-withdraw fee. Original fee was cost-recovery
 *     for GAM-rail ACH origination, which doesn't exist under Stripe
 *     Connect (standard payouts are free). Instant payouts: Stripe deducts
 *     1.5% (min $0.50) from the Connect balance natively — that surcharge
 *     is the user-facing instant fee, no GAM markup.
 *   - Drops the user_balance_ledger debit triple. No ledger participation
 *     in payouts under destination charges; balance is the live Stripe
 *     Connect balance.
 *
 * Preview endpoint (GET /me/withdrawals/preview):
 *   Returns available + instant_available + projected instant fee. No
 *   bank_account_id parameter — payout always goes to the Connect's
 *   default external_account. Bank-account management UI lives elsewhere
 *   (BankingPage will route to Stripe externalAccount APIs in a separate
 *   session).
 *
 * Withdrawal endpoint (POST /me/withdrawals):
 *   Body: { method?: 'standard' | 'instant' }. Fires payout for the full
 *   available USD on that channel. Audit row in `disbursements`. Webhook
 *   propagation flips status to 'settled' / 'failed' on payout events
 *   (services/stripeConnect.ts recordPayoutEvent).
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import {
  firePayoutForConnectAccount,
  getConnectBalance,
} from '../services/connectPayouts'
import { getStripe } from '../lib/stripe'
import { INSTANT_WITHDRAWAL_FEE } from '@gam/shared'
import { logger } from '../lib/logger'

export const withdrawalsRouter = Router()
withdrawalsRouter.use(requireAuth)

// Stripe instant payout pricing (US): 1.5% with $0.50 minimum, deducted
// from the payout amount.
const STRIPE_INSTANT_PCT     = 0.015
const STRIPE_INSTANT_MIN_USD = 0.50

/**
 * W-32 (S531, Nic-set pricing): the user-facing instant fee is 2% of the
 * available amount, $5 minimum, ALL-IN (INSTANT_WITHDRAWAL_FEE in shared).
 * Stripe's 1.5%/$0.50 comes out of that; GAM keeps the spread.
 *
 * Mechanics: GAM's margin is pulled off the Connect balance FIRST via an
 * account-debit transfer (connected account → platform), then the instant
 * payout fires for the remainder and Stripe deducts its fee from that
 * payout. Because Stripe's fee is then computed on the post-margin amount
 * (slightly smaller than the full available), the user's actual net lands
 * a hair ABOVE available − totalFee — rounding drift goes in the user's
 * favor, never GAM's.
 */
export function instantFeeBreakdown(available: number): {
  totalFee: number; gamMargin: number; payoutAmount: number; stripeFee: number; net: number
} {
  const totalFee     = round2(Math.max(available * INSTANT_WITHDRAWAL_FEE.PCT, INSTANT_WITHDRAWAL_FEE.MIN_USD))
  const stripeFeeProjected = round2(Math.max(available * STRIPE_INSTANT_PCT, STRIPE_INSTANT_MIN_USD))
  const gamMargin    = round2(Math.max(totalFee - stripeFeeProjected, 0))
  const payoutAmount = round2(available - gamMargin)
  const stripeFee    = payoutAmount > 0 ? round2(Math.max(payoutAmount * STRIPE_INSTANT_PCT, STRIPE_INSTANT_MIN_USD)) : 0
  const net          = round2(payoutAmount - stripeFee)
  return { totalFee, gamMargin, payoutAmount, stripeFee, net }
}

withdrawalsRouter.get('/me/withdrawals/preview', async (req, res, next) => {
  try {
    const userId = req.user!.userId
    const userRow = await queryOne<{
      stripe_connect_account_id: string | null
      connect_payouts_enabled: boolean
      connect_details_submitted: boolean
    }>(
      `SELECT stripe_connect_account_id, connect_payouts_enabled, connect_details_submitted
         FROM users WHERE id = $1`,
      [userId]
    )
    if (!userRow) throw new AppError(404, 'User not found')
    if (!userRow.stripe_connect_account_id) {
      throw new AppError(409, 'Stripe Connect onboarding incomplete — finish KYC at /banking before withdrawing.')
    }
    if (!userRow.connect_payouts_enabled || !userRow.connect_details_submitted) {
      throw new AppError(409, 'Stripe Connect onboarding incomplete — finish KYC at /banking before withdrawing.')
    }

    const bal = await getConnectBalance(userRow.stripe_connect_account_id)
    const availableUsd        = bal.available.find((b) => b.currency === 'usd')?.amount ?? 0
    const instantAvailableUsd = bal.instant_available.find((b) => b.currency === 'usd')?.amount ?? 0
    const breakdown = instantFeeBreakdown(instantAvailableUsd)

    res.json({
      success: true,
      data: {
        standard: {
          available: availableUsd,
          eligible:  availableUsd > 0,
        },
        instant: {
          available: instantAvailableUsd,
          fee:       instantAvailableUsd > 0 ? breakdown.totalFee : 0,
          net:       instantAvailableUsd > 0 ? breakdown.net : 0,
          feePct:    INSTANT_WITHDRAWAL_FEE.PCT,
          feeMin:    INSTANT_WITHDRAWAL_FEE.MIN_USD,
          eligible:  instantAvailableUsd > 0 && breakdown.net > 0,
        },
      },
    })
  } catch (e) { next(e) }
})

const withdrawalSchema = z.object({
  method: z.enum(['standard', 'instant']).optional(),
})

// Self-service: withdraws the CALLER's own Connect balance (req.user.userId),
// never the landlord's — so it is NOT gated on the landlord-staff catalog key
// (that would break property_manager direct-deposit self-withdrawal for zero
// security gain; a staff member can only ever move their own balance here).
withdrawalsRouter.post('/me/withdrawals', async (req, res, next) => {
  try {
    const userId = req.user!.userId
    const body   = withdrawalSchema.parse(req.body ?? {})
    const method = body.method ?? 'standard'

    const userRow = await queryOne<{
      stripe_connect_account_id: string | null
      connect_payouts_enabled: boolean
      connect_details_submitted: boolean
    }>(
      `SELECT stripe_connect_account_id, connect_payouts_enabled, connect_details_submitted
         FROM users WHERE id = $1`,
      [userId]
    )
    if (!userRow) throw new AppError(404, 'User not found')
    if (!userRow.stripe_connect_account_id) {
      throw new AppError(409, 'Stripe Connect onboarding incomplete — finish KYC at /banking before withdrawing.')
    }
    if (!userRow.connect_payouts_enabled || !userRow.connect_details_submitted) {
      throw new AppError(409, 'Stripe Connect onboarding incomplete — finish KYC at /banking before withdrawing.')
    }

    const bal = await getConnectBalance(userRow.stripe_connect_account_id)
    const availableUsd =
      method === 'instant'
        ? bal.instant_available.find((b) => b.currency === 'usd')?.amount ?? 0
        : bal.available.find((b) => b.currency === 'usd')?.amount ?? 0
    if (availableUsd <= 0) {
      throw new AppError(400, `No ${method} balance available`)
    }

    // Idempotency key: deterministic per (account, method, ms-truncated-second)
    // so a double-click within the same second deduplicates at Stripe.
    const idempotencyKey = `manual_${method}_${userRow.stripe_connect_account_id}_${Math.floor(Date.now() / 1000)}`

    // W-32 instant pricing: pull GAM's margin off the Connect balance FIRST
    // (account-debit transfer to platform), then fire the instant payout for
    // the remainder — Stripe's own fee comes out of that payout. Standard
    // payouts skip all of this (free, full available).
    const breakdown = method === 'instant' ? instantFeeBreakdown(availableUsd) : null
    if (breakdown && breakdown.net <= 0) {
      throw new AppError(400, `Instant balance too small to withdraw after the ${INSTANT_WITHDRAWAL_FEE.PCT * 100}% (min $${INSTANT_WITHDRAWAL_FEE.MIN_USD.toFixed(2)}) instant fee — use Standard instead.`)
    }
    const payoutAmount = breakdown ? breakdown.payoutAmount : availableUsd

    let marginTransferId: string | null = null
    if (breakdown && breakdown.gamMargin > 0) {
      const stripe = getStripe()
      // Platform account id resolves dynamically (cached) — the transfer is
      // created ON the connected account with the platform as destination
      // (Stripe "account debit").
      const platformAccountId = await getPlatformAccountId()
      const marginTransfer = await stripe.transfers.create(
        {
          amount:      Math.round(breakdown.gamMargin * 100),
          currency:    'usd',
          destination: platformAccountId,
          description: 'GAM instant withdrawal fee (margin over Stripe cost)',
          metadata: {
            gam_purpose:   'instant_withdrawal_fee_margin',
            gam_entity:    'user',
            gam_entity_id: userId,
            gam_total_fee: breakdown.totalFee.toFixed(2),
          },
        },
        { stripeAccount: userRow.stripe_connect_account_id, idempotencyKey: `${idempotencyKey}_margin` },
      )
      marginTransferId = marginTransfer.id
    }

    let payout
    try {
      payout = await firePayoutForConnectAccount({
        connectAccountId: userRow.stripe_connect_account_id,
        amount:           payoutAmount,
        method,
        idempotencyKey,
        metadata: {
          gam_trigger:   'manual_on_demand',
          gam_entity:    'user',
          gam_entity_id: userId,
          gam_method:    method,
        },
        description: method === 'instant' ? 'GAM instant payout' : 'GAM manual payout',
      })
    } catch (payoutErr) {
      // Margin taken but no payout delivered — reverse the debit so the
      // user is made whole, then rethrow. Reversal failure is logged for
      // manual recovery rather than masking the original error.
      if (marginTransferId) {
        try {
          const stripe = getStripe()
          await stripe.transfers.createReversal(
            marginTransferId,
            {},
            { stripeAccount: userRow.stripe_connect_account_id, idempotencyKey: `${idempotencyKey}_margin_reversal` },
          )
        } catch (reversalErr) {
          logger.error({ err: reversalErr, marginTransferId, userId }, '[WITHDRAWALS] margin reversal failed after payout error — manual recovery needed')
        }
      }
      throw payoutErr
    }

    // Audit row. fee_charged stamps the user-facing ALL-IN instant fee
    // (GAM margin + Stripe's cut). Standard payouts have no fee.
    const feeCharged = breakdown ? breakdown.totalFee : 0
    const dispRes = await query<{ id: string }>(
      `INSERT INTO disbursements
         (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
       VALUES ($1, 'manual_on_demand', $2, 'processing', $3, NOW(), $4)
       RETURNING id`,
      [userId, availableUsd, payout.id, feeCharged]
    )

    res.status(201).json({
      success: true,
      data: {
        disbursement_id:   dispRes[0].id,
        stripe_payout_id:  payout.id,
        amount:            availableUsd,
        method,
        fee_charged:       feeCharged,
        net_to_user:       breakdown ? breakdown.net : availableUsd,
      },
    })
  } catch (e) { next(e) }
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Platform Stripe account id, resolved once per process. Used as the
// destination for instant-fee margin account-debits.
let platformAccountIdCache: string | null = null
async function getPlatformAccountId(): Promise<string> {
  if (platformAccountIdCache) return platformAccountIdCache
  const stripe = getStripe()
  const acct = await stripe.accounts.retrieve()
  platformAccountIdCache = acct.id
  return acct.id
}

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
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import {
  firePayoutForConnectAccount,
  getConnectBalance,
} from '../services/connectPayouts'

export const withdrawalsRouter = Router()
withdrawalsRouter.use(requireAuth)

// Stripe instant payout pricing (US): 1.5% with $0.50 minimum. Stripe
// deducts this from the Connect balance at payout time; we surface it in
// preview so the user sees the effective net before confirming.
const STRIPE_INSTANT_PCT     = 0.015
const STRIPE_INSTANT_MIN_USD = 0.50

function projectedInstantFee(amount: number): number {
  return round2(Math.max(amount * STRIPE_INSTANT_PCT, STRIPE_INSTANT_MIN_USD))
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
    const instantFee          = instantAvailableUsd > 0 ? projectedInstantFee(instantAvailableUsd) : 0
    const instantNet          = round2(instantAvailableUsd - instantFee)

    res.json({
      success: true,
      data: {
        standard: {
          available: availableUsd,
          eligible:  availableUsd > 0,
        },
        instant: {
          available: instantAvailableUsd,
          fee:       instantFee,
          net:       instantNet,
          eligible:  instantAvailableUsd > 0 && instantNet > 0,
        },
      },
    })
  } catch (e) { next(e) }
})

const withdrawalSchema = z.object({
  method: z.enum(['standard', 'instant']).optional(),
})

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

    const payout = await firePayoutForConnectAccount({
      connectAccountId: userRow.stripe_connect_account_id,
      amount:           availableUsd,
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

    // Audit row. fee_charged stamps the projected Stripe instant surcharge
    // (informational — actual deduction is Stripe-side). Standard payouts
    // have no fee under Phase 5 (GAM manual fee dropped).
    const feeCharged = method === 'instant' ? projectedInstantFee(availableUsd) : 0
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
        net_to_user:       round2(availableUsd - feeCharged),
      },
    })
  } catch (e) { next(e) }
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

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
import {
  isInstantDisabled, recordInstantFailure, recordInstantSuccess, recordInstantMarginOwed,
} from '../services/instantWithdrawalMargin'
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
 * Stripe's 1.5%/$0.50 comes out of that; GAM keeps the spread (`gamMargin`).
 *
 * S580 model (Nic — no pre-pull): the instant payout pays the landlord their
 * `net` (= available − all-in fee). Stripe deducts its own instant fee from the
 * Connect balance; GAM's margin is NOT pulled here — it's recorded as an owed
 * receivable and collected Connect→platform at the next disbursement
 * (services/instantWithdrawalMargin.ts), so a failed payout can never leave the
 * landlord charged-for-nothing. GAM collects exactly `gamMargin`; any Stripe-fee
 * rounding residual stays on the balance and sweeps to the landlord — drift in
 * the landlord's favor, never GAM's.
 */
export function instantFeeBreakdown(available: number): {
  totalFee: number; gamMargin: number; net: number
} {
  const totalFee           = round2(Math.max(available * INSTANT_WITHDRAWAL_FEE.PCT, INSTANT_WITHDRAWAL_FEE.MIN_USD))
  const stripeFeeProjected = round2(Math.max(available * STRIPE_INSTANT_PCT, STRIPE_INSTANT_MIN_USD))
  const gamMargin          = round2(Math.max(totalFee - stripeFeeProjected, 0))
  const net                = round2(available - totalFee)  // what the landlord's bank receives
  return { totalFee, gamMargin, net }
}

// S554 re-anchor Stage 2: resolve which Connect account a caller withdraws.
// If the caller is a CURRENT member (owner) of a landlord entity that has an
// entity Connect account, withdraw the ENTITY's balance (rent) — and querying
// landlord_members at request time IS the live dissolution recheck: a removed
// owner no longer matches and falls through to their own user account (null for
// a pure owner → 409). Managers / opt-in direct-deposit / legacy landlords keep
// withdrawing their OWN user-level balance.
async function resolveWithdrawalTarget(userId: string): Promise<{
  account: string | null
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  entity: 'user' | 'landlord'
  entityId: string
}> {
  const ent = await queryOne<{
    landlord_id: string
    stripe_connect_account_id: string
    connect_payouts_enabled: boolean
    connect_details_submitted: boolean
  }>(
    `SELECT l.id AS landlord_id, l.stripe_connect_account_id,
            l.connect_payouts_enabled, l.connect_details_submitted
       FROM landlord_members m
       JOIN landlords l ON l.id = m.landlord_id
      WHERE m.user_id = $1 AND l.stripe_connect_account_id IS NOT NULL
      LIMIT 1`,
    [userId]
  )
  if (ent) {
    return {
      account: ent.stripe_connect_account_id,
      payoutsEnabled: ent.connect_payouts_enabled,
      detailsSubmitted: ent.connect_details_submitted,
      entity: 'landlord',
      entityId: ent.landlord_id,
    }
  }
  const usr = await queryOne<{
    stripe_connect_account_id: string | null
    connect_payouts_enabled: boolean
    connect_details_submitted: boolean
  }>(
    `SELECT stripe_connect_account_id, connect_payouts_enabled, connect_details_submitted
       FROM users WHERE id = $1`,
    [userId]
  )
  return {
    account: usr?.stripe_connect_account_id ?? null,
    payoutsEnabled: !!usr?.connect_payouts_enabled,
    detailsSubmitted: !!usr?.connect_details_submitted,
    entity: 'user',
    entityId: userId,
  }
}

withdrawalsRouter.get('/me/withdrawals/preview', async (req, res, next) => {
  try {
    const userId = req.user!.userId
    const target = await resolveWithdrawalTarget(userId)
    if (!target.account) {
      throw new AppError(409, 'Stripe Connect onboarding incomplete — finish KYC at /banking before withdrawing.')
    }
    if (!target.payoutsEnabled || !target.detailsSubmitted) {
      throw new AppError(409, 'Stripe Connect onboarding incomplete — finish KYC at /banking before withdrawing.')
    }

    const bal = await getConnectBalance(target.account)
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

// Self-service withdrawal. Target resolved by resolveWithdrawalTarget: a live
// landlord-entity owner withdraws the ENTITY's Connect balance (rent, S554
// Stage 2); everyone else (managers on direct-deposit, legacy) withdraws their
// OWN user balance. Not gated on a landlord-staff catalog key — a caller can
// only ever move funds of an entity they're a current member of, or their own.
withdrawalsRouter.post('/me/withdrawals', async (req, res, next) => {
  try {
    const userId = req.user!.userId
    const body   = withdrawalSchema.parse(req.body ?? {})
    const requestedMethod = body.method ?? 'standard'

    const target = await resolveWithdrawalTarget(userId)
    if (!target.account) {
      throw new AppError(409, 'Stripe Connect onboarding incomplete — finish KYC at /banking before withdrawing.')
    }
    if (!target.payoutsEnabled || !target.detailsSubmitted) {
      throw new AppError(409, 'Stripe Connect onboarding incomplete — finish KYC at /banking before withdrawing.')
    }

    // S580 circuit breaker: if instant has been auto-disabled for this account
    // (repeated instant-payout failures), fall back to the FREE standard payout
    // automatically — the landlord still gets paid, the flaky path stays isolated.
    let method: 'standard' | 'instant' = requestedMethod
    let instantFellBack = false
    if (method === 'instant' && (await isInstantDisabled(target.account))) {
      method = 'standard'
      instantFellBack = true
    }

    const bal = await getConnectBalance(target.account)
    const availableUsd =
      method === 'instant'
        ? bal.instant_available.find((b) => b.currency === 'usd')?.amount ?? 0
        : bal.available.find((b) => b.currency === 'usd')?.amount ?? 0
    if (availableUsd <= 0) {
      throw new AppError(400, `No ${method} balance available`)
    }

    // Idempotency key: deterministic per (account, method, second).
    const idempotencyKey = `manual_${method}_${target.account}_${Math.floor(Date.now() / 1000)}`

    // ── STANDARD — free, full available. No fee, no margin, no state to unwind.
    if (method === 'standard') {
      const payout = await firePayoutForConnectAccount({
        connectAccountId: target.account, amount: availableUsd, method: 'standard', idempotencyKey,
        metadata: { gam_trigger: 'manual_on_demand', gam_entity: target.entity, gam_entity_id: target.entityId, gam_method: 'standard' },
        description: 'GAM manual payout',
      })
      const dispRes = await query<{ id: string }>(
        `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
         VALUES ($1, 'manual_on_demand', $2, 'processing', $3, NOW(), 0) RETURNING id`,
        [userId, availableUsd, payout.id])
      return res.status(201).json({
        success: true,
        data: {
          disbursement_id: dispRes[0].id, stripe_payout_id: payout.id,
          amount: availableUsd, method: 'standard', fee_charged: 0, net_to_user: availableUsd,
          ...(instantFellBack ? { instant_unavailable: true } : {}),
        },
      })
    }

    // ── INSTANT — S580 (Nic): NEVER pre-pull GAM's margin. Pay the landlord their
    // NET; a failed payout moves NO money (nothing to reverse). GAM's margin is
    // recorded as an `owed` receivable and collected Connect→platform at the next
    // disbursement. Repeated failures trip the circuit → future requests fall back
    // to standard automatically. No manual recovery, ever.
    const breakdown = instantFeeBreakdown(availableUsd)
    if (breakdown.net <= 0) {
      throw new AppError(400, `Instant balance too small to withdraw after the ${INSTANT_WITHDRAWAL_FEE.PCT * 100}% (min $${INSTANT_WITHDRAWAL_FEE.MIN_USD.toFixed(2)}) instant fee — use Standard instead.`)
    }

    let payout
    try {
      payout = await firePayoutForConnectAccount({
        connectAccountId: target.account, amount: breakdown.net, method: 'instant', idempotencyKey,
        metadata: { gam_trigger: 'manual_on_demand', gam_entity: target.entity, gam_entity_id: target.entityId, gam_method: 'instant' },
        description: 'GAM instant payout',
      })
    } catch (payoutErr) {
      const { disabled } = await recordInstantFailure(target.account, payoutErr instanceof Error ? payoutErr.message : String(payoutErr))
      logger.error({ err: payoutErr, account: target.account, disabled }, '[WITHDRAWALS] instant payout failed (no money moved)')
      throw new AppError(502, disabled
        ? 'Instant payout is temporarily unavailable for this account — your balance is untouched. Use Standard (free); it lands in 1–2 business days.'
        : 'Instant payout could not be completed right now — your balance is untouched. Try again, or use Standard.')
    }

    await recordInstantSuccess(target.account)

    const dispRes = await query<{ id: string }>(
      `INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
       VALUES ($1, 'manual_on_demand', $2, 'processing', $3, NOW(), $4) RETURNING id`,
      [userId, availableUsd, payout.id, breakdown.totalFee])

    // Record GAM's margin as owed — collected at the next disbursement (never
    // pre-pulled). Only entity-landlord withdrawals carry a landlord_id.
    await recordInstantMarginOwed({
      landlordId:       target.entity === 'landlord' ? target.entityId : null,
      connectAccountId: target.account,
      amount:           breakdown.gamMargin,
      disbursementId:   dispRes[0].id,
    })

    res.status(201).json({
      success: true,
      data: {
        disbursement_id: dispRes[0].id, stripe_payout_id: payout.id,
        amount: availableUsd, method: 'instant',
        fee_charged: breakdown.totalFee, net_to_user: breakdown.net,
        margin_collection: 'next_disbursement',
      },
    })
  } catch (e) { next(e) }
})

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Per-user balance + ledger views.
 *
 * S113-Phase2 update: current_balance is sourced from the user's Stripe
 * Connect balance directly, not from `user_balance_ledger.balance_after`.
 * Under destination charges + Phase 4-5 outbound payouts, the ledger
 * receives only credit rows (allocation_owner_share, allocation_manager_fee,
 * allocation_pm_company_fee) — there are no longer withdrawal_* debit
 * rows. balance_after is therefore monotonic-growing and meaningless as a
 * "current balance" indicator. Stripe Connect is the source of truth.
 *
 * The `entries` array stays — it's the audit history of allocation events
 * for the calling user, useful for "what landed when" displays.
 *
 * Deprecated under Phase 2 (returned as empty/zero for back-compat with
 * existing UI; frontend cleanup is a separate session):
 *   - `unrouted_balance` — Stripe Connect handles bank routing via the
 *     attached external_account; there's no "unrouted" concept anymore.
 *   - `per_bank` — Stripe Connect maintains its own external_accounts
 *     list (one default per currency). The pre-Phase 4 "going to Bank X
 *     on Friday" UI is obsolete.
 *
 * Authorization unchanged: every query is hard-scoped to req.user.userId.
 * Owners / managers cannot see other users' balances. Optional
 * `?propertyId=` filter requires ownership or management.
 *
 * Does NOT expose platform_revenue_ledger (admin-only).
 */

import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { getConnectBalance } from '../services/connectPayouts'
import { logger } from '../lib/logger'

export const financesRouter = Router()
financesRouter.use(requireAuth)

interface LedgerRow {
  id: string
  type: string
  amount: string
  balance_after: string
  reference_id: string | null
  reference_type: string | null
  property_id: string | null
  bank_account_id: string | null
  notes: string | null
  created_at: string
}

const querySchema = z.object({
  propertyId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

financesRouter.get('/me/finances', async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query)
    const userId = req.user!.userId

    if (q.propertyId) {
      const propRes = await query<{ owner_user_id: string; managed_by_user_id: string }>(
        `SELECT owner_user_id, managed_by_user_id FROM properties WHERE id=$1`,
        [q.propertyId]
      )
      if (propRes.length === 0) throw new AppError(404, 'Property not found')
      const p = propRes[0]
      const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
      if (!isAdmin && p.owner_user_id !== userId && p.managed_by_user_id !== userId) {
        throw new AppError(403, 'Forbidden')
      }
    }

    // Source current_balance + pending from Stripe Connect when the caller
    // has an onboarded account. Managers without Connect (opt-in toggle
    // default off per CLAUDE.md), admin users, etc. fall through with
    // zeros. A Stripe hiccup also falls through with zeros — we log and
    // keep the endpoint responsive rather than 500ing.
    let currentBalance = 0
    let pendingBalance = 0
    let connectReady   = false

    const userRow = await queryOne<{
      stripe_connect_account_id: string | null
      connect_payouts_enabled: boolean
      connect_details_submitted: boolean
    }>(
      `SELECT stripe_connect_account_id, connect_payouts_enabled, connect_details_submitted
         FROM users WHERE id = $1`,
      [userId]
    )
    if (userRow?.stripe_connect_account_id) {
      connectReady = userRow.connect_payouts_enabled && userRow.connect_details_submitted
      try {
        const bal = await getConnectBalance(userRow.stripe_connect_account_id)
        currentBalance = bal.available.find((b) => b.currency === 'usd')?.amount ?? 0
        pendingBalance = bal.pending.find((b)   => b.currency === 'usd')?.amount ?? 0
      } catch (e) {
        logger.error({ err: e, ctx: userId }, '[finances] Stripe balance fetch failed for user')
      }
    }

    const params: any[] = [userId]
    let whereSql = 'WHERE user_id = $1'
    if (q.propertyId) {
      params.push(q.propertyId)
      whereSql += ` AND property_id = $${params.length}`
    }
    const limit = q.limit ?? 100
    params.push(limit)
    const entries = await query<LedgerRow>(`
      SELECT id, type, amount, balance_after,
             reference_id, reference_type, property_id, bank_account_id,
             notes, created_at
        FROM user_balance_ledger
        ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}
    `, params)

    res.json({
      success: true,
      data: {
        current_balance:   currentBalance,
        pending_balance:   pendingBalance,
        connect_ready:     connectReady,
        // Deprecated-but-preserved fields for frontend back-compat. UI
        // cleanup will drop these in a separate session.
        unrouted_balance:  0,
        per_bank:          [],
        entries,
      },
    })
  } catch (e) { next(e) }
})

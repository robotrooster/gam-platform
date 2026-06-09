/**
 * S113-Phase1: Daily reconciliation pass for unfired in-house manager
 * fee transfers.
 *
 * Mirror of pmTransferReconciliation.ts targeting type='allocation_manager_fee'.
 * Per-payment fires (allocation.ts → webhooks.ts post-commit) and monthly
 * fires (monthlyFeeAccrual.ts post-commit) leave the row's
 * stripe_transfer_id NULL on transient Stripe failures or when the manager
 * had no Connect account at the time. This cron picks them up daily.
 *
 * Stale = older than 1 hour. 500 rows per run cap.
 */

import { query } from '../db'
import { fireManagerTransfersForReference } from '../services/stripeConnect'

interface ReconResult {
  stale_groups_scanned: number
  total_fired: number
  total_failed: number
  errors: { reference_type: string; reference_id: string; error: string }[]
}

export async function reconcileManagerTransfers(): Promise<ReconResult> {
  const result: ReconResult = {
    stale_groups_scanned: 0,
    total_fired: 0,
    total_failed: 0,
    errors: [],
  }

  const groups = await query<{
    reference_type: 'payment' | 'monthly_fee_accrual'
    reference_id: string
  }>(
    `SELECT DISTINCT reference_type, reference_id
       FROM user_balance_ledger
      WHERE type = 'allocation_manager_fee'
        AND stripe_transfer_id IS NULL
        AND reference_id IS NOT NULL
        AND created_at < NOW() - INTERVAL '1 hour'
      LIMIT 500`
  )

  for (const g of groups) {
    result.stale_groups_scanned++
    try {
      const r = await fireManagerTransfersForReference(g.reference_type, g.reference_id)
      result.total_fired  += r.fired
      result.total_failed += r.failed
    } catch (e: any) {
      result.errors.push({
        reference_type: g.reference_type,
        reference_id:   g.reference_id,
        error:          e?.message ?? String(e),
      })
    }
  }

  return result
}

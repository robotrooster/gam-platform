/**
 * S121: Daily reconciliation pass for unfired PM company transfers.
 *
 * Background: S119 fires Stripe Transfers post-commit for each PM cut
 * ledger entry. If the Stripe call fails (transient API error, missing
 * Connect account at the time, etc.), the row sits with
 * stripe_transfer_id=NULL eligible for retry. This cron walks those
 * stale rows daily and re-runs `firePmTransfersForReference`.
 *
 * Stale = older than 1 hour (giving the original post-commit fire a
 * generous window to land before considering it stale). Limits to 500
 * rows per run as a defensive cap; subsequent days catch up.
 */

import { query } from '../db'
import { firePmTransfersForReference } from '../services/stripeConnect'

interface ReconResult {
  stale_groups_scanned: number
  total_fired: number
  total_failed: number
  errors: { reference_type: string; reference_id: string; error: string }[]
}

export async function reconcilePmTransfers(): Promise<ReconResult> {
  const result: ReconResult = {
    stale_groups_scanned: 0,
    total_fired: 0,
    total_failed: 0,
    errors: [],
  }

  // Find distinct (reference_type, reference_id) pairs with at least one
  // unfired PM cut row older than 1 hour. Cap at 500 groups per run.
  const groups = await query<{
    reference_type: 'payment' | 'pm_monthly_fee_accrual' | 'lease'
    reference_id: string
  }>(
    `SELECT DISTINCT reference_type, reference_id
       FROM user_balance_ledger
      WHERE type = 'allocation_pm_company_fee'
        AND stripe_transfer_id IS NULL
        AND reference_id IS NOT NULL
        AND created_at < NOW() - INTERVAL '1 hour'
      LIMIT 500`
  )

  for (const g of groups) {
    result.stale_groups_scanned++
    try {
      const r = await firePmTransfersForReference(g.reference_type, g.reference_id)
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

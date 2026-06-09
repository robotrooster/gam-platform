/**
 * S195: lease_fees sync helpers for the leases.security_deposit
 * deprecation. Phase 1 — every writer of leases.security_deposit also
 * upserts a corresponding lease_fees row with fee_type='security_deposit',
 * due_timing='move_in'. Phase 2 (next session) switches readers to
 * lease_fees and drops the column.
 *
 * Pattern is delete-then-insert because lease_fees lacks a UNIQUE
 * constraint on (lease_id, fee_type, due_timing) — multiple move_in
 * rows of different fee_types are intentional, and ON CONFLICT
 * doesn't have a target. The DELETE-INSERT round-trip is acceptable
 * for lease creation / patch flows (low volume; not hot path).
 */

import type { PoolClient } from 'pg'
import { query } from '../db'

/**
 * Upsert the security_deposit lease_fees row for a lease. When amount
 * is 0 or null, removes any existing row (landlord set deposit to
 * none).
 *
 * Caller can pass a transaction client; if omitted, runs outside any
 * transaction (best-effort).
 */
export async function syncSecurityDepositLeaseFee(
  leaseId: string,
  amount: number,
  client?: PoolClient,
): Promise<void> {
  const exec = async (sql: string, params: any[]): Promise<void> => {
    if (client) {
      await client.query(sql, params)
    } else {
      await query(sql, params)
    }
  }

  // Always remove any existing security_deposit move_in row first —
  // simpler than trying to UPDATE in place, and there's no UNIQUE
  // constraint to upsert against.
  await exec(
    `DELETE FROM lease_fees
      WHERE lease_id = $1
        AND fee_type = 'security_deposit'
        AND due_timing = 'move_in'`,
    [leaseId],
  )

  if (!amount || amount <= 0) return

  // S360 fix: lease_fees.is_refundable is NOT NULL. Pre-S360 the INSERT
  // omitted it, crashing every CSV-tenant commit that had a
  // security_deposit > 0 with "null value in column 'is_refundable'
  // violates not-null constraint" — the entire commit transaction
  // rolled back, so any tenant import with a deposit failed end-to-end.
  // Security deposits are refundable by definition; hardcode TRUE.
  await exec(
    `INSERT INTO lease_fees (lease_id, fee_type, due_timing, amount, description, is_refundable)
     VALUES ($1, 'security_deposit', 'move_in', $2, 'Security deposit', TRUE)`,
    [leaseId, amount],
  )
}

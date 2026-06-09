/**
 * S113-PhaseA: reconciliation flow for platform_held payments.
 *
 * When a tenant rent payment lands on GAM's platform balance (because the
 * landlord's Connect account wasn't charges_enabled at pay time), the
 * `payments.platform_held` flag is set true and the gross sits on platform.
 * Allocation engine writes the same `allocation_owner_share` audit row
 * regardless of routing — under platform_held mode that row IS the source
 * of truth for what GAM owes the landlord.
 *
 * This service runs from the `account.updated` webhook hook
 * (services/stripeConnect.ts → recordAccountUpdated). When a landlord's
 * Connect transitions to charges_enabled, sums every unfired owner_share
 * row across all platform_held payments and fires a single Transfer from
 * platform → landlord Connect for the total. PM and manager fees were
 * already Transferred at allocation time (sourced from the original
 * platform charge); only the owner share lingers.
 *
 * Idempotency: per-landlord advisory lock serializes concurrent webhook
 * deliveries. Each webhook walks platform_held=true; the in-transaction
 * UPDATE flips them false. Subsequent webhooks find nothing to do.
 */

import { query, queryOne, getClient } from '../db'
import { createPmCompanyTransfer } from './stripeConnect'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'

export interface PassthroughResult {
  attempted:        boolean
  payments_settled: number
  transfer_id:      string | null
  amount:           number
}

/**
 * Reconcile all platform_held payments for the landlord owned by the given
 * user. Caller is the account.updated webhook handler (and possibly an
 * admin manual-trigger button later). No-op when:
 *   - the user isn't a landlord (no landlords.user_id link)
 *   - the user has no Connect account
 *   - there are no unfired platform_held owner_share rows
 */
export async function reconcilePlatformHeldPayments(
  landlordUserId: string
): Promise<PassthroughResult> {
  const landlordRow = await queryOne<{ landlord_id: string; stripe_connect_account_id: string | null }>(
    `SELECT l.id AS landlord_id, u.stripe_connect_account_id
       FROM users u
       JOIN landlords l ON l.user_id = u.id
      WHERE u.id = $1`,
    [landlordUserId]
  )
  if (!landlordRow || !landlordRow.stripe_connect_account_id) {
    return { attempted: false, payments_settled: 0, transfer_id: null, amount: 0 }
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Per-landlord advisory lock. Same key shape as user_balance lock so
    // parallel allocation writes against this landlord serialize through
    // the same gate.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`platform_held_reconcile:${landlordRow.landlord_id}`]
    )

    const sumRow = await client.query<{ owed_amount: string }>(
      `SELECT COALESCE(SUM(ubl.amount), 0)::numeric AS owed_amount
         FROM payments p
         JOIN user_balance_ledger ubl
           ON ubl.reference_id = p.id
          AND ubl.reference_type = 'payment'
          AND ubl.type = 'allocation_owner_share'
          AND ubl.stripe_transfer_id IS NULL
        WHERE p.landlord_id = $1
          AND p.platform_held = true
          AND p.status = 'settled'`,
      [landlordRow.landlord_id]
    )
    const owed = parseFloat(sumRow.rows[0]?.owed_amount ?? '0')
    if (owed <= 0) {
      await client.query('ROLLBACK')
      return { attempted: false, payments_settled: 0, transfer_id: null, amount: 0 }
    }

    // Fire the platform → landlord Connect Transfer. No source_transaction
    // because the funds are aggregated across many charges; platform balance
    // already has them (gross of every platform_held payment).
    // createPmCompanyTransfer is the generic Transfer wrapper despite the
    // name (kept to avoid a refactor outside this phase).
    const transfer = await createPmCompanyTransfer({
      amount: owed,
      destinationConnectAccountId: landlordRow.stripe_connect_account_id,
      metadata: {
        gam_kind:             'platform_held_passthrough',
        gam_landlord_id:      landlordRow.landlord_id,
        gam_landlord_user_id: landlordUserId,
      },
      description: 'Platform-held rent passthrough',
    })

    await client.query(
      `UPDATE user_balance_ledger
          SET stripe_transfer_id = $1
        WHERE type = 'allocation_owner_share'
          AND reference_type = 'payment'
          AND stripe_transfer_id IS NULL
          AND reference_id IN (
            SELECT id FROM payments
             WHERE landlord_id = $2 AND platform_held = true AND status = 'settled'
          )`,
      [transfer.id, landlordRow.landlord_id]
    )

    const flipped = await client.query(
      `UPDATE payments
          SET platform_held = false
        WHERE landlord_id = $1 AND platform_held = true AND status = 'settled'`,
      [landlordRow.landlord_id]
    )

    await client.query('COMMIT')

    return {
      attempted:        true,
      payments_settled: flipped.rowCount ?? 0,
      transfer_id:      transfer.id,
      amount:           owed,
    }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    // Critical: if the Stripe Transfer fired but the DB update failed, we
    // have money moved without ledger flip — admin must investigate.
    await createAdminNotification({
      severity: 'critical',
      category: 'platform_held_reconciliation_failed',
      title:    `Platform-held passthrough reconciliation failed for landlord user ${landlordUserId}`,
      body:     e instanceof Error ? e.message : String(e),
      context:  { landlord_user_id: landlordUserId, landlord_id: landlordRow.landlord_id },
    })
    throw e
  } finally {
    client.release()
  }
}

/**
 * Hook entry — called by services/stripeConnect.ts recordAccountUpdated when
 * a Connect account flips to charges_enabled+payouts_enabled. Best-effort:
 * errors don't propagate, the webhook handler continues. Reconciliation is
 * also retryable via subsequent webhooks (next account.updated will retry)
 * or manually by admin if needed.
 */
export async function tryReconcileForLandlordUserId(landlordUserId: string): Promise<void> {
  try {
    const r = await reconcilePlatformHeldPayments(landlordUserId)
    if (r.attempted) {
      logger.info('[platform_held_reconcile]', JSON.stringify(r))
    }
  } catch (e) {
    logger.error({ err: e }, '[platform_held_reconcile] failed:')
  }
}

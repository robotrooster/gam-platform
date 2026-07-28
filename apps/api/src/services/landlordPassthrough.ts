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

import type { PoolClient } from 'pg'
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
 * S561: net this landlord's scheduled reversal receivables against the money
 * about to be paid out to them. GAM keeps `netted` of the owed rent to cover
 * prior reversals the landlord owes back (they were paid rent that later
 * reversed); only the remainder transfers out. Oldest receivable first; caps at
 * `availableOwed`. A receivable that gets fully covered resolves as a
 * landlord_clawback (its late fee reverts to the landlord). Runs inside the
 * caller's transaction. Returns the total amount netted.
 */
async function applyReversalNetting(
  client: PoolClient,
  landlordId: string,
  availableOwed: number,
): Promise<number> {
  const recs = await client.query<{ id: string; outstanding: string }>(
    `SELECT id, (reversed_amount - recovered_amount)::text AS outstanding
       FROM payment_reversals
      WHERE landlord_id = $1
        AND status <> 'resolved'
        AND recovery_status = 'scheduled_netting'
        AND (reversed_amount - recovered_amount) > 0
      ORDER BY created_at ASC
      FOR UPDATE`,
    [landlordId]
  )

  let remaining = availableOwed
  let totalNetted = 0
  for (const r of recs.rows) {
    const outstanding = Math.round(parseFloat(r.outstanding) * 100) / 100
    if (outstanding <= 0) continue
    // NO PARTIAL NETTING (Nic, S561): net a receivable ONLY if THIS batch fully
    // covers it. It's full-net or nothing — never a partial that leaves the
    // landlord short (a not-fully-covered receivable stays scheduled_netting for
    // a later fully-covering batch, or ages out to a full ACH clawback). FIFO
    // order is preserved; a smaller later receivable may still fit `remaining`.
    if (remaining < outstanding) continue
    // Fully covered → resolve as a landlord clawback (late fee reverts to landlord).
    await client.query(
      `UPDATE payment_reversals
          SET recovered_amount = reversed_amount,
              recovery_status  = 'recovered',
              recovered_at     = NOW(),
              outcome          = 'landlord_clawback',
              late_fee_owner   = 'landlord',
              status           = 'resolved',
              resolved_at      = NOW(),
              updated_at       = NOW()
        WHERE id = $1`,
      [r.id]
    )
    remaining   -= outstanding
    totalNetted += outstanding
  }
  return Math.round(totalNetted * 100) / 100
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
  // S554 Connect re-anchor: prefer the landlord ENTITY's account, fall back to
  // the founding owner's user account during the transition.
  const landlordRow = await queryOne<{ landlord_id: string; stripe_connect_account_id: string | null }>(
    `SELECT l.id AS landlord_id,
            COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS stripe_connect_account_id
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

    // S561: net scheduled reversal receivables against this payout FIRST. GAM
    // keeps `netted` of the owed rent to cover reversals the landlord owes back;
    // only the remainder is transferred out.
    const netted = await applyReversalNetting(client, landlordRow.landlord_id, owed)
    const transferAmount = Math.round((owed - netted) * 100) / 100

    // Fire the platform → landlord Connect Transfer for the net remainder. No
    // source_transaction because the funds are aggregated across many charges;
    // platform balance already has them (gross of every platform_held payment).
    // createPmCompanyTransfer is the generic Transfer wrapper despite the name.
    // If the payout was FULLY netted (transferAmount == 0) we skip the Stripe
    // Transfer but still stamp the ledger + flip platform_held so the
    // owner_share isn't reprocessed; a sentinel id marks the netted batch.
    let transferId: string
    if (transferAmount > 0) {
      const transfer = await createPmCompanyTransfer({
        amount: transferAmount,
        destinationConnectAccountId: landlordRow.stripe_connect_account_id,
        metadata: {
          gam_kind:             'platform_held_passthrough',
          gam_landlord_id:      landlordRow.landlord_id,
          gam_landlord_user_id: landlordUserId,
          ...(netted > 0 ? { gam_reversal_netted: String(netted) } : {}),
        },
        description: 'Platform-held rent passthrough',
      })
      transferId = transfer.id
    } else {
      transferId = `netted:${landlordRow.landlord_id}`
    }

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
      [transferId, landlordRow.landlord_id]
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
      transfer_id:      transferId,
      amount:           transferAmount,
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

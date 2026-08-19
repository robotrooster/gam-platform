/**
 * Platform→landlord Connect passthrough — fire-after-commit money movement.
 *
 * When tenant rent lands on GAM's PLATFORM balance (payments.platform_held=true)
 * the owner-share owed to the landlord sits on platform until their Connect
 * account is enabled. This service moves it out. It runs from the
 * `account.updated` webhook (services/stripeConnect.ts) AND the weekly auto-payout
 * cron (jobs/autoPayouts.ts), so it must be re-entrant and retry-safe.
 *
 * S580 — DURABLE TRANSFER-INTENT STATE MACHINE (replaces the old
 * transfer-inside-the-transaction flow, which had no idempotency key and could
 * double-pay a landlord if the Transfer succeeded but the commit failed):
 *
 *   RESERVE  (txn) — advisory-lock the landlord, sum the unfired owner-share,
 *     net scheduled reversals, write a `pending` platform_transfer_intents row,
 *     flip payments.platform_held=false, and stamp each reserved owner-share
 *     ledger row's stripe_transfer_id with an `intent:<id>` sentinel (so it's
 *     excluded from any future sum). COMMIT — the batch is now atomically claimed.
 *   EXECUTE  (no txn) — fire the platform→Connect Transfer with a DETERMINISTIC
 *     idempotency key derived from the intent id.
 *   CONFIRM  (txn) — mark the intent `transferred`, stamp the real transfer id
 *     onto the intent + its reserved ledger rows.
 *   RECOVER — re-run EXECUTE for any intent stuck in `pending`. Because the
 *     idempotency key is the same, Stripe dedupes a Transfer that already went
 *     through (no double-pay) or completes one that never fired (no stranded
 *     money).
 *
 * Idempotency + safety:
 *   - Per-landlord advisory lock serializes concurrent RESERVE attempts.
 *   - `intent:<id>` sentinel means a reserved owner-share row can never be
 *     re-summed into a second intent.
 *   - The Stripe idempotency key (`platform_passthrough_<intentId>`) makes EXECUTE
 *     safe to retry any number of times.
 *   - CONFIRM only advances a row while status='pending', so concurrent
 *     execute/recover races resolve to a single confirm.
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

// After this many failed EXECUTE attempts a pending intent is escalated to a
// critical admin notification (it's still retried — money isn't lost).
const ESCALATE_AFTER_ATTEMPTS = 3

function idemKeyFor(intentId: string): string {
  return `platform_passthrough_${intentId}`
}

/**
 * S561: net this landlord's scheduled reversal receivables against the money
 * about to be paid out. GAM keeps `netted` of the owed rent to cover prior
 * reversals the landlord owes back; only the remainder transfers out. Oldest
 * receivable first; NO PARTIAL NETTING (Nic, S561) — a receivable nets only if
 * this batch fully covers it. Runs inside the caller's RESERVE transaction.
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
    if (remaining < outstanding) continue // full-net or nothing
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

interface ReservedBatch {
  intentId:         string
  landlordId:       string
  destAccount:      string
  transferAmount:   number
  grossOwed:        number
  netted:           number
  payments_settled: number
  fullyNetted:      boolean   // transferAmount == 0 → no Stripe call needed
}

/**
 * RESERVE — claim the landlord's unfired owner-share into a durable pending
 * intent inside one transaction, then commit. Returns null when there is
 * nothing to do (unknown user, no Connect account, nothing owed).
 */
async function reservePlatformHeldBatch(landlordUserId: string): Promise<ReservedBatch | null> {
  const landlordRow = await queryOne<{ landlord_id: string; stripe_connect_account_id: string | null }>(
    `SELECT l.id AS landlord_id,
            COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS stripe_connect_account_id
       FROM users u
       JOIN landlords l ON l.user_id = u.id
      WHERE u.id = $1`,
    [landlordUserId]
  )
  if (!landlordRow || !landlordRow.stripe_connect_account_id) return null

  const client = await getClient()
  try {
    await client.query('BEGIN')
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
    const owed = Math.round(parseFloat(sumRow.rows[0]?.owed_amount ?? '0') * 100) / 100
    if (owed <= 0) {
      await client.query('ROLLBACK')
      return null
    }

    const netted = await applyReversalNetting(client, landlordRow.landlord_id, owed)
    const transferAmount = Math.round((owed - netted) * 100) / 100
    const fullyNetted = transferAmount <= 0

    // Create the durable intent. For a fully-netted batch there is no Stripe
    // Transfer to make, so it's born already 'transferred'.
    const intentRow = await client.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id,
          amount, gross_owed, netted_amount, status, stripe_transfer_id, transferred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        landlordRow.landlord_id, landlordUserId, landlordRow.stripe_connect_account_id,
        transferAmount, owed, netted,
        fullyNetted ? 'transferred' : 'pending',
        null, fullyNetted ? new Date() : null,
      ]
    )
    const intentId = intentRow.rows[0].id
    // A fully-netted batch has no Stripe id; use a sentinel for the ledger + row.
    const sentinel = fullyNetted ? `netted:${intentId}` : `intent:${intentId}`
    if (fullyNetted) {
      await client.query(`UPDATE platform_transfer_intents SET stripe_transfer_id=$1 WHERE id=$2`, [sentinel, intentId])
    }

    // Stamp the reserved owner-share rows so they can never be re-summed.
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
      [sentinel, landlordRow.landlord_id]
    )
    // S602 deposit-trust: NEVER pass a deposit through to the landlord on the
    // weekly batch. A tenant deposit is held by GAM in the segregated trust pool
    // (held_by='gam_escrow') and only leaves at move-out, when depositReturn
    // splits it (tenant refund out, landlord's retained share out). Deposits
    // carry no owner-share, so they're already excluded from `owed` above; this
    // guard also keeps the reconcile flip from silently clearing their held
    // state — a deposit stays platform_held=TRUE in trust until it's disbursed.
    const flipped = await client.query(
      `UPDATE payments
          SET platform_held = false
        WHERE landlord_id = $1 AND platform_held = true AND status = 'settled'
          AND type <> 'deposit'`,
      [landlordRow.landlord_id]
    )

    // Stamp the reserved payment count onto the intent for auditability.
    await client.query(
      `UPDATE platform_transfer_intents SET payments_settled=$1 WHERE id=$2`,
      [flipped.rowCount ?? 0, intentId]
    )

    await client.query('COMMIT')
    return {
      intentId,
      landlordId: landlordRow.landlord_id,
      destAccount: landlordRow.stripe_connect_account_id,
      transferAmount,
      grossOwed: owed,
      netted,
      payments_settled: flipped.rowCount ?? 0,
      fullyNetted,
    }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

/**
 * EXECUTE (+ CONFIRM) — fire the platform→Connect Transfer for a pending intent
 * with its deterministic idempotency key, then stamp the result. Returns the
 * transfer id on success, or null when the Transfer failed (intent stays pending
 * for RECOVER to retry). Never double-pays: the idempotency key dedupes retries.
 */
export async function executePlatformTransferIntent(intentId: string): Promise<string | null> {
  const intent = await queryOne<{
    id: string; landlord_id: string; landlord_user_id: string
    destination_connect_account_id: string; amount: string
    netted_amount: string; status: string; attempts: number
  }>(`SELECT * FROM platform_transfer_intents WHERE id = $1`, [intentId])
  if (!intent) return null
  if (intent.status !== 'pending') return intent.status === 'transferred' ? 'already' : null

  const amount = Math.round(parseFloat(intent.amount) * 100) / 100
  const netted = Math.round(parseFloat(intent.netted_amount) * 100) / 100

  // Defensive: a zero-amount pending intent needs no Stripe call.
  if (amount <= 0) {
    await confirmIntent(intentId, `netted:${intentId}`)
    return `netted:${intentId}`
  }

  let transferId: string
  try {
    const transfer = await createPmCompanyTransfer({
      amount,
      destinationConnectAccountId: intent.destination_connect_account_id,
      idempotencyKey: idemKeyFor(intentId),
      metadata: {
        gam_kind:             'platform_held_passthrough',
        gam_intent_id:        intentId,
        gam_landlord_id:      intent.landlord_id,
        gam_landlord_user_id: intent.landlord_user_id,
        ...(netted > 0 ? { gam_reversal_netted: String(netted) } : {}),
      },
      description: 'Platform-held rent passthrough',
    })
    transferId = transfer.id
  } catch (e) {
    const attempts = (intent.attempts ?? 0) + 1
    await query(
      `UPDATE platform_transfer_intents
          SET attempts = $1, last_error = $2, updated_at = NOW()
        WHERE id = $3`,
      [attempts, e instanceof Error ? e.message : String(e), intentId]
    )
    // Money is NOT lost — the batch is reserved and will be retried by RECOVER.
    // Escalate only after repeated failures so a transient blip isn't noisy.
    if (attempts >= ESCALATE_AFTER_ATTEMPTS) {
      await createAdminNotification({
        severity: 'critical',
        category: 'platform_held_transfer_stuck',
        title:    `Platform-held passthrough transfer stuck after ${attempts} attempts (intent ${intentId})`,
        body:     e instanceof Error ? e.message : String(e),
        context:  { intent_id: intentId, landlord_id: intent.landlord_id, landlord_user_id: intent.landlord_user_id, amount },
      })
    }
    logger.error({ err: e, intentId, attempts }, '[platform_held_passthrough] transfer failed (will retry)')
    return null
  }

  await confirmIntent(intentId, transferId)
  return transferId
}

/** CONFIRM — stamp the real transfer id onto the intent + its reserved ledger rows. */
async function confirmIntent(intentId: string, transferId: string): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Only advance a still-pending intent (concurrent execute/recover safe).
    const upd = await client.query(
      `UPDATE platform_transfer_intents
          SET status = 'transferred', stripe_transfer_id = $1,
              transferred_at = COALESCE(transferred_at, NOW()), updated_at = NOW()
        WHERE id = $2 AND status = 'pending'
        RETURNING id`,
      [transferId, intentId]
    )
    // Replace the intent sentinel on the reserved owner-share rows with the real
    // transfer id (idempotent: matches the sentinel this intent stamped).
    await client.query(
      `UPDATE user_balance_ledger
          SET stripe_transfer_id = $1
        WHERE type = 'allocation_owner_share'
          AND reference_type = 'payment'
          AND stripe_transfer_id = $2`,
      [transferId, `intent:${intentId}`]
    )
    await client.query('COMMIT')
    if (upd.rowCount) {
      logger.info('[platform_held_passthrough]', JSON.stringify({ intentId, transferId, confirmed: true }))
    }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }
}

/**
 * Reconcile all platform_held payments for the landlord owned by the given user:
 * RESERVE then EXECUTE. Public API + return shape preserved for the webhook hook
 * and the auto-payout cron.
 */
export async function reconcilePlatformHeldPayments(
  landlordUserId: string
): Promise<PassthroughResult> {
  const reserved = await reservePlatformHeldBatch(landlordUserId)
  if (!reserved) {
    return { attempted: false, payments_settled: 0, transfer_id: null, amount: 0 }
  }
  if (reserved.fullyNetted) {
    return { attempted: true, payments_settled: reserved.payments_settled, transfer_id: `netted:${reserved.intentId}`, amount: 0 }
  }
  const transferId = await executePlatformTransferIntent(reserved.intentId)
  return {
    attempted:        true,
    payments_settled: reserved.payments_settled,
    transfer_id:      transferId,   // null → pending, RECOVER will retry
    amount:           reserved.transferAmount,
  }
}

/**
 * RECOVER — re-fire any intent stuck in `pending` (its RESERVE committed but the
 * Transfer never confirmed). Safe to run repeatedly; the idempotency key dedupes
 * at Stripe. Called by the weekly cron and can be invoked by an admin/backstop.
 * `graceMinutes` skips very-fresh intents that an in-flight EXECUTE is handling.
 */
export async function recoverPendingPlatformTransfers(graceMinutes = 5): Promise<{ scanned: number; recovered: number; stillPending: number }> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM platform_transfer_intents
      WHERE status = 'pending' AND amount > 0
        AND created_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY created_at ASC`,
    [String(graceMinutes)]
  )
  let recovered = 0
  let stillPending = 0
  for (const r of rows) {
    const tid = await executePlatformTransferIntent(r.id)
    if (tid && tid !== 'already') recovered++
    else if (!tid) stillPending++
  }
  return { scanned: rows.length, recovered, stillPending }
}

/**
 * Hook entry — called by services/stripeConnect.ts recordAccountUpdated when a
 * Connect account flips to charges_enabled+payouts_enabled. Best-effort: errors
 * don't propagate. Reconciliation is also retryable via subsequent webhooks, the
 * weekly cron, and recoverPendingPlatformTransfers.
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

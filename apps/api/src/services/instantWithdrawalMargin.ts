/**
 * S580: instant-withdrawal margin collection + circuit breaker.
 *
 * GAM's margin on an INSTANT withdrawal is never pre-pulled off the landlord's
 * Connect balance (that created a "charged-for-nothing → manual reverse" state
 * when a payout failed). Instead:
 *   - The instant payout pays the landlord their NET (available − all-in fee).
 *   - GAM's margin is recorded here as an `owed` receivable and COLLECTED at the
 *     next disbursement, Connect→platform, idempotently (`collectOwedInstantMargins`,
 *     called from jobs/autoPayouts.ts before the bank sweep). If the balance
 *     can't cover it yet, it stays `owed` and collects from a future influx.
 *   - A per-account circuit breaker isolates a flaky instant path: N consecutive
 *     instant failures trip `disabled`, and the withdrawal route then falls back
 *     to the free standard payout automatically. No manual admin recovery, ever.
 *
 * GAM's platform income is secured UPSTREAM (platform fee at charge time); the
 * instant margin is small and can never strand the landlord.
 */
import { getStripe } from '../lib/stripe'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

// Consecutive instant-payout failures on one Connect account before instant is
// auto-disabled for it (withdrawals then fall back to the free standard payout).
export const INSTANT_CIRCUIT_THRESHOLD = 3

// Platform Stripe account id, resolved once per process — the destination for
// Connect→platform margin collection.
let platformAccountIdCache: string | null = null
export async function getPlatformAccountId(): Promise<string> {
  if (platformAccountIdCache) return platformAccountIdCache
  const acct = await getStripe().accounts.retrieve()
  platformAccountIdCache = acct.id
  return acct.id
}

// ── Circuit breaker ─────────────────────────────────────────────────────────

export async function isInstantDisabled(connectAccountId: string): Promise<boolean> {
  const row = await queryOne<{ disabled: boolean }>(
    `SELECT disabled FROM connect_instant_circuit WHERE connect_account_id = $1`,
    [connectAccountId],
  )
  return !!row?.disabled
}

/** A successful instant payout clears the failure streak (and any trip). */
export async function recordInstantSuccess(connectAccountId: string): Promise<void> {
  await query(
    `INSERT INTO connect_instant_circuit (connect_account_id, consecutive_failures, disabled, updated_at)
     VALUES ($1, 0, false, now())
     ON CONFLICT (connect_account_id) DO UPDATE
       SET consecutive_failures = 0, disabled = false, last_error = NULL, updated_at = now()`,
    [connectAccountId],
  )
}

/** A failed instant payout increments the streak; at the threshold it trips. */
export async function recordInstantFailure(connectAccountId: string, error: string): Promise<{ disabled: boolean }> {
  const row = await queryOne<{ consecutive_failures: number; disabled: boolean }>(
    `INSERT INTO connect_instant_circuit (connect_account_id, consecutive_failures, disabled, last_error, last_failure_at, updated_at)
     VALUES ($1, 1, false, $2, now(), now())
     ON CONFLICT (connect_account_id) DO UPDATE
       SET consecutive_failures = connect_instant_circuit.consecutive_failures + 1,
           last_error = $2, last_failure_at = now(), updated_at = now(),
           disabled = (connect_instant_circuit.consecutive_failures + 1) >= ${INSTANT_CIRCUIT_THRESHOLD}
     RETURNING consecutive_failures, disabled`,
    [connectAccountId, error.slice(0, 500)],
  )
  return { disabled: !!row?.disabled }
}

// ── Margin receivable ───────────────────────────────────────────────────────

export async function recordInstantMarginOwed(opts: {
  landlordId: string | null
  connectAccountId: string
  amount: number
  disbursementId: string | null
}): Promise<string | null> {
  if (opts.amount <= 0) return null
  const row = await queryOne<{ id: string }>(
    `INSERT INTO landlord_instant_margins
       (landlord_id, connect_account_id, amount, status, source_disbursement_id)
     VALUES ($1, $2, $3, 'owed', $4)
     RETURNING id`,
    [opts.landlordId, opts.connectAccountId, Math.round(opts.amount * 100) / 100, opts.disbursementId],
  )
  return row?.id ?? null
}

/**
 * Collect every `owed` instant margin for a Connect account by transferring it
 * Connect→platform, idempotently. Called from the weekly batch BEFORE the bank
 * sweep, so it nets against the next disbursement. A transfer that fails (e.g.
 * insufficient Connect balance because the landlord withdrew everything) leaves
 * the margin `owed` to collect from a future influx — never stranded, never
 * double-collected (idempotency key = the margin id).
 */
export async function collectOwedInstantMargins(
  connectAccountId: string,
): Promise<{ collected: number; amount: number; stillOwed: number }> {
  const owed = await query<{ id: string; amount: string }>(
    `SELECT id, amount::text AS amount
       FROM landlord_instant_margins
      WHERE connect_account_id = $1 AND status = 'owed'
      ORDER BY created_at ASC`,
    [connectAccountId],
  )
  if (owed.length === 0) return { collected: 0, amount: 0, stillOwed: 0 }

  const stripe = getStripe()
  const platformAccountId = await getPlatformAccountId()
  let collected = 0
  let amount = 0
  let stillOwed = 0
  for (const m of owed) {
    const amt = Math.round(parseFloat(m.amount) * 100) / 100
    if (amt <= 0) {
      await query(`UPDATE landlord_instant_margins SET status='collected', collected_at=now() WHERE id=$1`, [m.id])
      continue
    }
    try {
      const transfer = await stripe.transfers.create(
        {
          amount:      Math.round(amt * 100),
          currency:    'usd',
          destination: platformAccountId,
          description: 'GAM instant-withdrawal fee (collected at next disbursement)',
          metadata:    { gam_purpose: 'instant_withdrawal_margin', gam_margin_id: m.id },
        },
        { stripeAccount: connectAccountId, idempotencyKey: `instant_margin_${m.id}` },
      )
      await query(
        `UPDATE landlord_instant_margins
            SET status='collected', collected_at=now(), stripe_transfer_id=$2
          WHERE id=$1`,
        [m.id, transfer.id],
      )
      collected++
      amount += amt
    } catch (e) {
      // Leave it `owed` — a future batch retries with the same idempotency key.
      await query(
        `UPDATE landlord_instant_margins
            SET attempts = attempts + 1, last_error = $2
          WHERE id=$1`,
        [m.id, e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500)],
      )
      stillOwed++
      logger.warn({ err: e, marginId: m.id, connectAccountId }, '[instant_margin] collection deferred (will retry next batch)')
    }
  }
  return { collected, amount: Math.round(amount * 100) / 100, stillOwed }
}

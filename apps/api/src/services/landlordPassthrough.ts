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
import type { PlatformTransferPurpose } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { createPmCompanyTransfer } from './stripeConnect'
import { netAgainstDisbursement, markBalance, gamAccountLockKey, recordGamChargeCollections, type GamChargeTake } from './landlordGamAccount'
import { createAdminNotification } from './adminNotifications'
import { logger } from '../lib/logger'
import { isDefiniteStripeRefusal } from '../lib/stripeRefusal'
import { lockHeldItems, stampHeldItems } from './heldPayouts'
import { lockPayoutCut } from './payoutCut'

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
 * Read-only twin of the RESERVE sum, for display (GET /me/finances): how much
 * platform-held rent GAM currently owes this user, in DOLLARS, before reversal
 * and GAM-charge netting. The WHERE clause must stay in lockstep with
 * reservePlatformHeldBatch below — the number a landlord is shown as "held"
 * must be exactly the pool the next batch can reserve, or the two will drift
 * and read as a missing-money bug. Sums across every landlords row the user
 * owns (RESERVE runs per landlord row; the display is per user).
 */
export async function heldOwnerShareForUser(landlordUserId: string): Promise<number> {
  const row = await queryOne<{ owed_amount: string }>(
    `SELECT COALESCE(SUM(ubl.amount), 0)::numeric AS owed_amount
       FROM payments p
       JOIN landlords l ON l.id = p.landlord_id
       JOIN user_balance_ledger ubl
         ON ubl.reference_id = p.id
        AND ubl.reference_type = 'payment'
        AND ubl.type = 'allocation_owner_share'
        AND ubl.stripe_transfer_id IS NULL
      WHERE l.user_id = $1
        AND p.platform_held = true
        AND p.status = 'settled'`,
    [landlordUserId])
  const held = await queryOne<{ owed_amount: string }>(
    `SELECT COALESCE(SUM(h.amount), 0)::numeric AS owed_amount
       FROM held_payout_items h
       JOIN landlords l ON l.id = h.landlord_id
      WHERE l.user_id = $1 AND h.payout_intent_id IS NULL`,
    [landlordUserId])
  return Math.round((parseFloat(row?.owed_amount ?? '0') + parseFloat(held?.owed_amount ?? '0')) * 100) / 100
}

/**
 * S650: GAM's own AVAILABLE balance at Stripe, in cents — what can actually be
 * transferred right now. `null` means we could not ask (no key, Stripe down),
 * and the caller then behaves exactly as it did before rather than stalling
 * every payout on a failed balance call.
 */
async function platformAvailableCents(): Promise<number | null> {
  try {
    const { getStripe } = await import('../lib/stripe')
    const bal = await getStripe().balance.retrieve()
    const usd = (bal.available ?? []).filter((b: any) => b.currency === 'usd')
    return usd.reduce((a: number, b: any) => a + Number(b.amount || 0), 0)
  } catch (e) {
    logger.error({ err: e }, '[platform_held_passthrough] could not read the platform balance — proceeding uncapped')
    return null
  }
}

/**
 * RESERVE — claim the landlord's unfired owner-share into a durable pending
 * intent inside one transaction, then commit. Returns null when there is
 * nothing to do (unknown user, no Connect account, nothing owed).
 */
async function reservePlatformHeldBatch(
  landlordUserId: string,
  onlyLandlordId?: string,
): Promise<ReservedBatch | null> {
  // ── S640: ONE ACCOUNT OWNS SEVERAL COMPANIES ───────────────────────────
  //
  // This was a queryOne over `users JOIN landlords` — and an account that owns
  // two companies matches TWICE, so it silently took whichever row Postgres
  // returned first and the other company's rent could never be swept off the
  // platform balance at all. Nic's account owns Mountain View and Oak Park;
  // Mountain View happens to sort first, so Oak Park's card and ACH money would
  // have sat on GAM's balance forever, with nothing anywhere saying so.
  //
  // Not currently biting only because Oak Park's residents have all paid cash
  // so far. The first one who pays online would have found out the hard way.
  //
  // The caller now names the company (see reconcilePlatformHeldPayments, which
  // loops over all of them); the bare-user form still resolves when an account
  // owns exactly one.
  const landlordRow = await queryOne<{ landlord_id: string; stripe_connect_account_id: string | null }>(
    `SELECT l.id AS landlord_id,
            COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS stripe_connect_account_id
       FROM users u
       JOIN landlords l ON l.user_id = u.id
      WHERE u.id = $1
        AND ($2::uuid IS NULL OR l.id = $2::uuid)
      ORDER BY l.created_at ASC
      LIMIT 1`,
    [landlordUserId, onlyLandlordId ?? null]
  )
  if (!landlordRow || !landlordRow.stripe_connect_account_id) return null

  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [gamAccountLockKey(landlordRow.landlord_id)]
    )

    // S648: lock and read the EXACT rows this batch pays, then stamp those ids.
    // Summing and later stamping "everything currently held" let a payment or
    // sale that landed between the two be marked paid out without being in
    // the transfer — the landlord would never have been paid for it.
    const allShareRows = await client.query<{ id: string; amount: string }>(
      `SELECT ubl.id, ubl.amount::text AS amount
         FROM payments p
         JOIN user_balance_ledger ubl
           ON ubl.reference_id = p.id
          AND ubl.reference_type = 'payment'
          AND ubl.type = 'allocation_owner_share'
          AND ubl.stripe_transfer_id IS NULL
        WHERE p.landlord_id = $1
          AND p.platform_held = true
          AND p.status = 'settled'
        ORDER BY ubl.created_at ASC
          FOR UPDATE OF ubl`,
      [landlordRow.landlord_id]
    )
    // ── S650 (Nic): NEVER RESERVE MORE THAN GAM ACTUALLY HAS ────────────────
    //
    //   "Why the fuck would money fail to move for insufficient funds? We only
    //    move the money that was paid to us."
    //
    // Because a payment is `settled` here the moment the tenant's bank clears
    // it, and Stripe does not make an ACH's funds AVAILABLE for about four
    // business days after that. The batch was built from GAM's records alone,
    // so on 2026-09-16 it claimed $4,154.89 of rent whose newest $1,300 was
    // still ripening at Stripe. A Transfer is all-or-nothing: Stripe refused
    // the whole thing, and the older money that WAS available sat stuck behind
    // the newest — twelve payments, three days, no payout.
    //
    // So the batch is now capped by GAM's own available balance, oldest money
    // first. What is not yet available is simply not claimed; it goes out on
    // the next run, the day it ripens. Nothing is lost and nothing is stuck.
    const cents = (v: string) => Math.round(parseFloat(v) * 100)
    const availableCents = await platformAvailableCents()
    const shareRows = { rows: [] as { id: string; amount: string }[] }
    let claimedCents = 0
    for (const r of allShareRows.rows) {
      const c = cents(r.amount)
      if (availableCents != null && claimedCents + c > availableCents) break
      shareRows.rows.push(r)
      claimedCents += c
    }
    const skippedShares = allShareRows.rows.length - shareRows.rows.length
    // S648: everything else GAM holds for this landlord — register sales, stay
    // deposits, and the chargebacks/refunds that net against them.
    const held = await lockHeldItems(client, { landlordId: landlordRow.landlord_id },
      availableCents == null ? undefined : Math.max(0, availableCents - claimedCents))
    if (skippedShares > 0 || (availableCents != null && claimedCents === 0)) {
      logger.info({ landlordId: landlordRow.landlord_id, availableCents, claimedCents, skippedShares },
        '[platform_held_passthrough] capped to GAM\'s available balance — the rest goes out when it clears')
    }
    const owedCents = claimedCents + held.totalCents
    const owed = owedCents / 100
    if (owed <= 0) {
      await client.query('ROLLBACK')
      return null
    }

    const netted = await applyReversalNetting(client, landlordRow.landlord_id, owed)

    // S620 (Nic): "if six people pay cash and then four people pay card for the
    // remainder, we'll just take it all out of the card balance. It doesn't
    // make sense to debit the account of the landlord — that's just more money
    // moving back and forth, and we wanna eliminate moves."
    //
    // So whatever the landlord owes GAM comes out of the money on its way to
    // them, and a direct debit is only ever the fallback for when there is no
    // money to take it from. Runs AFTER the reversal netting because a
    // reversal is somebody else's money being returned; GAM's own fees queue
    // behind that.
    //
    // Unlike reversal netting this takes PARTIAL amounts — carrying a $20
    // remainder to next week is exactly what stops a bank debit happening.
    const gamTakes: GamChargeTake[] = []
    const gamTaken = await netAgainstDisbursement(
      client, landlordRow.landlord_id, Math.round((owed - netted) * 100) / 100, gamTakes)

    const transferAmount = Math.round((owed - netted - gamTaken) * 100) / 100
    const fullyNetted = transferAmount <= 0


    // Create the durable intent. For a fully-netted batch there is no Stripe
    // Transfer to make, so it's born already 'transferred' — and dated here,
    // so it follows the same rule as confirmIntent (services/payoutCut.ts):
    // take the account's cut lock first (a payout taking its cut waits for
    // this to commit), then date it by the database clock at the moment it is
    // written. Dated by the app's clock without the lock, it could sit before
    // a sweep's cut yet commit after that sweep looked: in no payout, ever,
    // with the payments netted inside it listed nowhere.
    if (fullyNetted) await lockPayoutCut(client, landlordRow.stripe_connect_account_id)
    const intentRow = await client.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id,
          amount, gross_owed, netted_amount, status, stripe_transfer_id, transferred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               CASE WHEN $7::text = 'transferred' THEN clock_timestamp() END)
       RETURNING id`,
      [
        landlordRow.landlord_id, landlordUserId, landlordRow.stripe_connect_account_id,
        transferAmount, owed, netted,
        fullyNetted ? 'transferred' : 'pending',
        null,
      ]
    )
    const intentId = intentRow.rows[0].id
    // 10/12 (Nic, ledger P0): what this batch kept back for each GAM charge,
    // as a record against the batch — the books post each collection on its
    // own day, and a charge can now be seen to have been collected once.
    await recordGamChargeCollections(client, gamTakes, { platformTransferIntentId: intentId })
    // A fully-netted batch has no Stripe id; use a sentinel for the ledger + row.
    const sentinel = fullyNetted ? `netted:${intentId}` : `intent:${intentId}`
    if (fullyNetted) {
      await client.query(`UPDATE platform_transfer_intents SET stripe_transfer_id=$1 WHERE id=$2`, [sentinel, intentId])
    }

    // Stamp the reserved owner-share rows so they can never be re-summed.
    await client.query(
      `UPDATE user_balance_ledger SET stripe_transfer_id = $1 WHERE id = ANY($2::uuid[])`,
      [sentinel, shareRows.rows.map(r => r.id)]
    )
    // Claim the held items this batch carries.
    await stampHeldItems(client, held.ids, intentId)
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
          AND type <> 'deposit'
          -- a payment whose owner share landed after this batch was read keeps
          -- waiting for the next one
          AND NOT EXISTS (
            SELECT 1 FROM user_balance_ledger ubl
             WHERE ubl.reference_id = payments.id AND ubl.reference_type = 'payment'
               AND ubl.type = 'allocation_owner_share' AND ubl.stripe_transfer_id IS NULL)`,
      [landlordRow.landlord_id]
    )

    // Stamp the reserved payment count onto the intent for auditability.
    await client.query(
      `UPDATE platform_transfer_intents SET payments_settled=$1 WHERE id=$2`,
      [flipped.rowCount ?? 0, intentId]
    )

    await client.query('COMMIT')
    // S620: record where this landlord's GAM balance stands after the netting,
    // trip or no trip. Nic: "we should flag those properties when that happens
    // and see how close it was to happening. Maybe we raise the limit per
    // property... if the fees are not worth the extra money movement."
    // A property that peaks at $80 and never crosses is the useful signal, and
    // it only exists if the near-misses are written down too.
    // 10/5: AFTER the commit. Read on its own connection before it, it saw the
    // balance the netting had just paid off — Mountain View's $175.50, netted
    // in full, was recorded as a peak over the $100 line with a warning that a
    // direct debit was the only route left.
    void markBalance(landlordRow.landlord_id).then((b) => {
      if (b.overThreshold) {
        logger.warn({ landlordId: landlordRow.landlord_id, owed: b.owed, threshold: b.threshold },
          '[gam-account] still over threshold after netting — a direct debit is the only route left')
      }
    }).catch(() => {})
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
    id: string; landlord_id: string | null; landlord_user_id: string | null; business_id: string | null
    destination_connect_account_id: string; amount: string
    netted_amount: string; status: string; attempts: number
    purpose: PlatformTransferPurpose | null
  }>(`SELECT * FROM platform_transfer_intents WHERE id = $1`, [intentId])
  if (!intent) return null
  if (intent.status !== 'pending') return intent.status === 'transferred' ? 'already' : null
  // 10/12 (ledger P0): a direct transfer (a move-out's deposit share, a store
  // charge account's merchant share) is retried under ITS OWN key and with the
  // exact request it was first sent with — never the batch's key, which would
  // let Stripe make it a second time. Reached by RECOVER only when the process
  // stopped between writing the record and hearing back from Stripe.
  if (intent.purpose && intent.purpose !== 'payout') {
    return sendDirectTransfer(intentId).catch(async (e) => {
      logger.error({ err: e, intentId }, '[direct-transfer] retry failed')
      // 10/12 (Nic, G4): a store charge account's merchant share that the
      // automatic retry could not send is told to an admin, as every other
      // merchant-transfer failure is (a move-out's deposit share raises its
      // own notice inside sendDirectTransfer).
      if (intent.purpose === 'flexcharge_merchant') {
        const st = await queryOne<{ flexcharge_statement_id: string | null }>(
          `SELECT flexcharge_statement_id FROM platform_transfer_intents WHERE id = $1`, [intentId]).catch(() => null)
        const { flexChargeMerchantTransferFailed } = await import('./flexCharge')
        await flexChargeMerchantTransferFailed(st?.flexcharge_statement_id ?? null, intent.landlord_id, e, 'recovery',
          { intent_id: intentId, amount: intent.amount })
      }
      return null
    })
  }

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
        ...(intent.landlord_id ? { gam_landlord_id: intent.landlord_id, gam_landlord_user_id: intent.landlord_user_id ?? '' } : {}),
        ...(intent.business_id ? { gam_business_id: intent.business_id } : {}),
        ...(netted > 0 ? { gam_reversal_netted: String(netted) } : {}),
      },
      description: intent.business_id ? 'GAM weekly payout (business)' : 'Platform-held rent passthrough',
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
        context:  { intent_id: intentId, landlord_id: intent.landlord_id, business_id: intent.business_id, landlord_user_id: intent.landlord_user_id, amount },
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
    // S655 review: a GAM payout carries every transfer dated before its cut,
    // and the next payout starts at that cut (services/payoutCut.ts). NOW() is
    // when this transaction BEGAN, and the row is invisible until it commits —
    // begun before a cut and committed after the payout looked, a transfer was
    // in neither payout, for good. So take the account's cut lock first (a
    // payout taking its cut waits for this to commit), then date the transfer
    // by the clock at the moment it is written.
    const dest = (await client.query<{ destination_connect_account_id: string | null }>(
      `SELECT destination_connect_account_id FROM platform_transfer_intents WHERE id = $1`,
      [intentId])).rows[0]?.destination_connect_account_id
    if (dest) await lockPayoutCut(client, dest)
    // Only advance a still-pending intent (concurrent execute/recover safe).
    // 10/12 (Nic, ledger P0 review): a DIRECT transfer (not the batch) marked
    // failed is advanced too when Stripe hands back a transfer id — Stripe's
    // answer wins. A second caller under the same key, refused while the
    // first was still in flight, could mark it failed after Stripe had made
    // it; left failed, the payout could never link it ("not traced") and the
    // move-out would read the landlord's share as never sent.
    const upd = await client.query(
      `UPDATE platform_transfer_intents
          SET status = 'transferred', stripe_transfer_id = $1,
              transferred_at = COALESCE(transferred_at, clock_timestamp()), updated_at = NOW()
        WHERE id = $2
          AND (status = 'pending' OR (status = 'failed' AND purpose <> 'payout'))
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
 * 10/12 (Nic, ledger P0, design M0b) — a transfer to a landlord's Stripe
 * account that is not the weekly batch: the landlord's share of a GAM-held
 * deposit at move-out (services/depositReturn), a store charge account's
 * merchant share (services/flexCharge, flexpay, routes/webhooks).
 *
 * These called Stripe and wrote nothing: a success left no record a payout
 * could list (the payout showed the money as "not traced"), and a failure
 * left only an admin notice. Now, the same three steps as the batch (S580):
 *
 *   RECORD  — a platform_transfer_intents row (status pending, its purpose,
 *             what it pays, its idempotency key and the exact request),
 *             written BEFORE Stripe is asked;
 *   EXECUTE — the transfer under that key (a retry, or a second caller with
 *             the same key, can never pay twice);
 *   CONFIRM — transferred, with Stripe's id, dated under the payout cut lock
 *             like any other transfer, so stampPayoutTransfers links it to the
 *             payout that carries it to the bank.
 *
 * A refusal marks the record 'failed' (RECOVER does not retry it: a person
 * decides, as before) and is thrown so the caller says what it always said.
 * Returns the Stripe transfer id — or null when Stripe's answer is not known
 * (10/12 review: a timeout, a dropped connection, Stripe's own error, or the
 * 409 a second caller gets while the first is in flight under the same key).
 * Then the record stays pending and RECOVER asks again under the same key,
 * which hands back the transfer if it was made and makes it once if not; it
 * is never marked failed and no "not sent" notice is raised for it.
 */
export interface RecordedDirectTransfer {
  purpose: Exclude<PlatformTransferPurpose, 'payout'>
  /** The company paid. A merchant transfer may leave it out: read from the statement. */
  landlordId?: string | null
  destinationConnectAccountId: string
  amount: number
  idempotencyKey: string
  depositReturnId?: string | null
  flexchargeStatementId?: string | null
  description: string
  metadata: Record<string, string>
}

export async function fireRecordedDirectTransfer(t: RecordedDirectTransfer): Promise<{ intentId: string; transferId: string | null }> {
  const amount = Math.round(t.amount * 100) / 100
  if (!(amount > 0)) throw new Error(`A ${t.purpose} transfer must move more than nothing (${t.amount})`)
  const landlordId = t.landlordId ?? (t.flexchargeStatementId
    ? (await queryOne<{ landlord_id: string }>(
        `SELECT a.landlord_id FROM flex_charge_statements s
           JOIN flex_charge_accounts a ON a.id = s.account_id
          WHERE s.id = $1`, [t.flexchargeStatementId]))?.landlord_id
    : null)
  if (!landlordId) throw new Error(`No company to record a ${t.purpose} transfer against (${t.idempotencyKey})`)

  const ins = await queryOne<{ id: string }>(
    `INSERT INTO platform_transfer_intents
       (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, netted_amount,
        status, purpose, deposit_return_id, flexcharge_statement_id, stripe_idempotency_key, stripe_request)
     SELECT l.id, l.user_id, $2, $3, $3, 0, 'pending', $4, $5, $6, $7, $8::jsonb
       FROM landlords l WHERE l.id = $1
     ON CONFLICT (stripe_idempotency_key) WHERE stripe_idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [landlordId, t.destinationConnectAccountId, amount.toFixed(2), t.purpose,
     t.depositReturnId ?? null, t.flexchargeStatementId ?? null, t.idempotencyKey,
     JSON.stringify({ description: t.description, metadata: t.metadata })])
  // Already recorded under this key (a second caller, or a retry): the same
  // transfer, never a second one.
  const intentId = ins?.id ?? (await queryOne<{ id: string }>(
    `SELECT id FROM platform_transfer_intents WHERE stripe_idempotency_key = $1`, [t.idempotencyKey]))?.id
  if (!intentId) throw new Error(`Company ${landlordId} not found for a ${t.purpose} transfer`)
  return { intentId, transferId: await sendDirectTransfer(intentId) }
}

/** EXECUTE + CONFIRM for a recorded direct transfer (see fireRecordedDirectTransfer). */
async function sendDirectTransfer(intentId: string): Promise<string | null> {
  const i = await queryOne<{
    id: string; status: string; purpose: PlatformTransferPurpose; amount: string
    destination_connect_account_id: string; stripe_transfer_id: string | null
    stripe_idempotency_key: string; stripe_request: { description: string; metadata: Record<string, string> }
    deposit_return_id: string | null; flexcharge_statement_id: string | null
  }>(
    `SELECT id, status, purpose, amount::text AS amount, destination_connect_account_id,
            stripe_transfer_id, stripe_idempotency_key, stripe_request,
            deposit_return_id, flexcharge_statement_id
       FROM platform_transfer_intents WHERE id = $1`, [intentId])
  if (!i) throw new Error(`Transfer record ${intentId} not found`)
  if (i.status === 'transferred' && i.stripe_transfer_id) return i.stripe_transfer_id
  // Trying again after a refusal: it is pending again until Stripe answers.
  if (i.status === 'failed') {
    await query(`UPDATE platform_transfer_intents SET status = 'pending', updated_at = NOW() WHERE id = $1 AND status = 'failed'`, [intentId])
  }
  const amount = Math.round(parseFloat(i.amount) * 100) / 100

  let transferId: string
  try {
    // The same request each caller made itself before 10/12, under its key.
    const { getStripe } = await import('../lib/stripe')
    const transfer = await getStripe().transfers.create(
      {
        amount:      Math.round(amount * 100),
        currency:    'usd',
        destination: i.destination_connect_account_id,
        description: i.stripe_request.description,
        metadata:    i.stripe_request.metadata,
      },
      { idempotencyKey: i.stripe_idempotency_key },
    )
    transferId = transfer.id
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 10/12 (Nic, ledger P0 review): only a definite refusal is a failure.
    // Stripe may have made a transfer it answered with a timeout, its own
    // error, or a 409 for a second caller under the same key — marking that
    // 'failed' left money paid with a record that says it was not. Unknown:
    // the record stays pending with the error, and RECOVER asks again under
    // the same key (lib/stripeRefusal).
    if (!isDefiniteStripeRefusal(e)) {
      await query(
        `UPDATE platform_transfer_intents
            SET attempts = attempts + 1, last_error = $2, updated_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [intentId, msg.slice(0, 1000)])
      logger.warn({ err: e, intentId, purpose: i.purpose },
        '[direct-transfer] Stripe\'s answer is unknown — left pending; RECOVER asks again under the same key')
      return null
    }
    const marked = await queryOne<{ id: string }>(
      `UPDATE platform_transfer_intents
          SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [intentId, msg.slice(0, 1000)])
    if (!marked) {
      // Another caller under the same key already confirmed it: Stripe's
      // transfer stands, and nothing failed.
      const done = await queryOne<{ stripe_transfer_id: string | null }>(
        `SELECT stripe_transfer_id FROM platform_transfer_intents WHERE id = $1 AND status = 'transferred'`, [intentId])
      if (done?.stripe_transfer_id) return done.stripe_transfer_id
    }
    if (i.purpose === 'deposit_settlement') {
      // The notice the move-out always raised (paymentReversal reads it to
      // know the landlord was never paid this share), now from here so a
      // retry that fails says it too.
      const dr = await queryOne<{ lease_id: string | null }>(
        `SELECT lease_id FROM deposit_returns WHERE id = $1`, [i.deposit_return_id])
      await createAdminNotification({
        severity: 'warn',
        category: 'deposit_disbursement_transfer_failed',
        title:    `Deposit disbursement Transfer failed — return ${i.deposit_return_id}`,
        body:     `Stripe Transfer for $${amount.toFixed(2)} to landlord Connect ${i.destination_connect_account_id} failed: ${msg}.`,
        context:  { deposit_return_id: i.deposit_return_id, lease_id: dr?.lease_id ?? null, amount,
                    connect_account: i.destination_connect_account_id, intent_id: intentId },
      }).catch((err) => logger.error({ err, intentId }, '[direct-transfer] could not raise the failure notice'))
    }
    throw e
  }
  // Outside the try: Stripe has made the transfer. A database error here
  // leaves the record pending, and RECOVER confirms it under the same key.
  await confirmIntent(intentId, transferId)
  return transferId
}

/**
 * Reconcile all platform_held payments for the landlord owned by the given user:
 * RESERVE then EXECUTE. Public API + return shape preserved for the webhook hook
 * and the auto-payout cron.
 */
export async function reconcilePlatformHeldPayments(
  landlordUserId: string
): Promise<PassthroughResult> {
  // S640: EVERY company the account owns, not the first one. Each has its own
  // Connect account and its own owed balance, so each gets its own intent and
  // its own transfer; the results are summed so the caller's shape is unchanged.
  const companies = await query<{ id: string }>(
    `SELECT id FROM landlords WHERE user_id = $1 ORDER BY created_at ASC`, [landlordUserId])
  if (companies.length === 0) {
    return { attempted: false, payments_settled: 0, transfer_id: null, amount: 0 }
  }

  const out: PassthroughResult = { attempted: false, payments_settled: 0, transfer_id: null, amount: 0 }
  for (const c of companies) {
    const reserved = await reservePlatformHeldBatch(landlordUserId, c.id)
    if (!reserved) continue
    out.attempted = true
    out.payments_settled += reserved.payments_settled
    if (reserved.fullyNetted) {
      out.transfer_id = out.transfer_id ?? `netted:${reserved.intentId}`
      continue
    }
    const transferId = await executePlatformTransferIntent(reserved.intentId)
    // null → the intent stays pending and RECOVER retries it; the money is
    // claimed either way, so a failure on one company never blocks the next.
    out.transfer_id = out.transfer_id ?? transferId
    out.amount += reserved.transferAmount
  }
  return out
}

/**
 * 10/5 (Nic): payouts are per Stripe CONNECT ACCOUNT — "It's not per property.
 * It's not per company. It's per connect account... A login sits outside of the
 * portfolio." Move the held rent of every company whose money lands in this
 * account (one company, or several sharing one bank through one account), each
 * with its own intent and transfer exactly as reconcilePlatformHeldPayments
 * does — only found by the account, never by a login.
 */
export async function reconcilePlatformHeldForAccount(
  stripeAccountId: string,
): Promise<PassthroughResult> {
  const companies = await query<{ id: string; user_id: string }>(
    `SELECT l.id, l.user_id
       FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) = $1
      ORDER BY l.created_at ASC`, [stripeAccountId])
  const out: PassthroughResult = { attempted: false, payments_settled: 0, transfer_id: null, amount: 0 }
  for (const c of companies) {
    const reserved = await reservePlatformHeldBatch(c.user_id, c.id)
    if (!reserved) continue
    out.attempted = true
    out.payments_settled += reserved.payments_settled
    if (reserved.fullyNetted) {
      out.transfer_id = out.transfer_id ?? `netted:${reserved.intentId}`
      continue
    }
    const transferId = await executePlatformTransferIntent(reserved.intentId)
    out.transfer_id = out.transfer_id ?? transferId
    out.amount += reserved.transferAmount
  }
  return out
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
  // S650 (Nic): money owed to a landlord must never sit quietly. Mountain
  // View's $4,154.89 was reserved on the 16th, failed twice on GAM's available
  // balance, and nothing said so — the escalation only fires at three attempts,
  // and a retry that never ran cannot reach three. A day is the alarm.
  const stale = await query<{ id: string; amount: string; landlord_id: string; hours: string }>(
    `SELECT id, amount::text AS amount, landlord_id,
            ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600)::text AS hours
       FROM platform_transfer_intents
      WHERE status = 'pending' AND amount > 0 AND created_at < NOW() - interval '24 hours'`)
  for (const st of stale) {
    await createAdminNotification({
      severity: 'critical',
      category: 'platform_held_transfer_stuck',
      title:    `$${Number(st.amount).toFixed(2)} owed to a landlord has been stuck ${st.hours}h`,
      body:     'A platform→Connect batch is still pending. Most often GAM\'s Stripe balance had not caught up; it retries daily, but check it.',
      context:  { intent_id: st.id, landlord_id: st.landlord_id, amount: st.amount, hours: st.hours },
    }).catch(() => {})
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

/**
 * What a landlord owes GAM, and how GAM gets it.
 *
 * S620 (Nic): "we'll just take it all out of the card balance. It doesn't make
 * sense to debit the account of the landlord — that's just more money moving
 * back and forth, and we wanna eliminate moves."
 *
 * So there are exactly two ways GAM collects, in this order:
 *
 *   1. NET IT OUT of money already on its way to the landlord. Costs nothing,
 *      moves nothing extra. This is the normal path.
 *   2. DEBIT the landlord — only when the balance crosses the property's
 *      threshold and there is no disbursement to take it from. Last resort.
 *
 * Nic on why (2) should almost never happen: "You're gonna have a mix of cash,
 * card, ACH, and I don't think you're ever gonna really hit that threshold."
 * (S654: cash itself costs nothing.) The high-water mark exists so that claim is
 * measured rather than assumed — a property peaking at $80 shows up before
 * anyone has to guess whether $100 is the right number.
 *
 * PARTIAL COLLECTION IS DELIBERATE, and it differs from the reversal netting
 * next to it in landlordPassthrough (full-net-or-nothing, Nic S561). Taking $50
 * of a $70 debt out of this week's money and carrying $20 is precisely what
 * avoids a bank debit, so partial is the point rather than a compromise.
 */

import type { PoolClient } from 'pg'
import type { LandlordGamChargeKind, LandlordGamChargeVoidReason } from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { logger } from '../lib/logger'

/** Fallback when a charge has no property (or the property was deleted). */
export const DEFAULT_DEBIT_THRESHOLD = 100

export interface GamCharge {
  landlordId: string
  propertyId?: string | null
  /**
   * subscription       — the monthly platform fee
   * bank_debit_cost    — S651: what an ACH pull cost, kept as its own line so
   *                      the landlord sees two numbers they can each check
   *                      rather than one lump they can only dispute
   * screening_fee      — 10/5 (Nic): a background check paid inside a stay's
   *                      payment is GAM's money, card or cash; it comes out of
   *                      the landlord's next payout (services/stayTerms)
   * bank_debit_failed_cost   — 10/12 (Nic, G1): what a failed or returned bank
   *                      pull actually cost GAM, at cost (services/landlordGamDebit)
   * uncovered_processing_fee — 10/12 (Nic, G5): the part of a processing fee
   *                      the landlord covers that was more than the money GAM
   *                      held from that payment (services/allocation)
   */
  kind: Exclude<LandlordGamChargeKind, 'manual_payment_fee'>
  amount: number
  /** what produced this, so a retry cannot bill twice */
  sourceType: string
  sourceId?: string | null
  notes?: string
  /**
   * 10/12 (Nic, ledger P0): a card reader piece names its order and which
   * piece it is (unique together), so the books can clear the reader piece by
   * piece. source_id cannot carry the order: an order has four pieces and
   * (source_type, source_id) is unique.
   */
  readerOrderId?: string | null
  installmentNumber?: number | null
}

/**
 * Record something the landlord owes GAM. Idempotent on (sourceType, sourceId):
 * a re-run accrual or a re-recorded manual payment cannot charge twice.
 * Returns the charge id, or null when it was already recorded.
 */
export async function chargeLandlord(
  client: PoolClient | null,
  c: GamCharge,
): Promise<string | null> {
  const run = <T extends Record<string, any>>(sql: string, params: any[]): Promise<T[]> =>
    client ? client.query<any>(sql, params).then(r => r.rows as T[]) : query<T>(sql, params)

  const rows = await run<{ id: string }>(
    `INSERT INTO landlord_gam_charges
       (landlord_id, property_id, kind, amount, source_type, source_id, notes,
        reader_order_id, installment_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [c.landlordId, c.propertyId ?? null, c.kind, c.amount.toFixed(2),
     c.sourceType, c.sourceId ?? null, c.notes ?? null,
     c.readerOrderId ?? null, c.installmentNumber ?? null]
  )
  return rows[0]?.id ?? null
}

/**
 * SQL: a GAM charge somebody still owes — not fully collected and not voided.
 * 10/12 (Nic, ledger P0): a charge GAM takes back is VOIDED and kept
 * (keep-everything), where it used to be deleted, so every reader of what a
 * landlord owes skips voided rows — this, or `voided_at IS NULL` beside the
 * readers' own conditions (gamCollections, portalLockSweep, stripeCosts,
 * routes/financials, routes/landlords).
 */
export const GAM_CHARGE_OWED_SQL = (c: string) => `(${c}.collected_amount < ${c}.amount AND ${c}.voided_at IS NULL)`

/** Everything this landlord still owes GAM, to the cent. */
export async function outstandingForLandlord(landlordId: string): Promise<number> {
  const row = await queryOne<{ owed: string }>(
    `SELECT COALESCE(SUM(c.amount - c.collected_amount), 0)::text AS owed
       FROM landlord_gam_charges c
      WHERE c.landlord_id = $1 AND ${GAM_CHARGE_OWED_SQL('c')}`,
    [landlordId])
  return Math.round(parseFloat(row?.owed ?? '0') * 100) / 100
}

/**
 * The lowest threshold across this landlord's properties.
 *
 * Lowest rather than an average or a per-property split, because the debit is
 * an account-level action: if ANY property they own is configured to be
 * cautious, the account inherits that caution. A landlord who raised one
 * property to $200 has not asked to be more exposed on the others.
 */
export async function debitThresholdForLandlord(landlordId: string): Promise<number> {
  const row = await queryOne<{ t: string | null }>(
    `SELECT MIN(gam_debit_threshold)::text AS t FROM properties WHERE landlord_id = $1`,
    [landlordId])
  const t = row?.t ? parseFloat(row.t) : NaN
  return Number.isFinite(t) ? t : DEFAULT_DEBIT_THRESHOLD
}

/**
 * The advisory-lock key a landlord's payout batch holds while it reserves
 * (services/landlordPassthrough RESERVE) and a bank pull holds while it claims
 * its charges (services/landlordGamDebit). One key, so a netting pass and a
 * pull can never both take the same charge.
 */
export function gamAccountLockKey(landlordId: string): string {
  return `platform_held_reconcile:${landlordId}`
}

/** One charge's part of a netting pass — what a payout batch kept back for it. */
export interface GamChargeTake {
  chargeId: string
  amount: number
}

/**
 * SQL: the charge is inside a bank pull that has not settled yet.
 *
 * 10/12 (Nic, ledger P0, design §16.1): netting never skipped these, and the
 * pull's settlement marks every one of its charges collected in full — so a
 * charge netted from a payout while its pull was in flight was collected
 * twice, once from the payout and again from the bank. The pull owns its
 * charges until it settles or fails; a failed pull hands them back.
 */
const IN_PENDING_DEBIT_SQL = (c: string) =>
  `EXISTS (SELECT 1 FROM landlord_gam_debits d
            WHERE d.landlord_id = ${c}.landlord_id AND d.status = 'pending'
              AND ${c}.id = ANY (d.charge_ids))`

/**
 * Net what the landlord owes GAM against money about to be paid out to them.
 *
 * Runs inside the caller's RESERVE transaction, exactly like
 * applyReversalNetting, and returns how much was taken. Oldest charge first so
 * a debt cannot sit forever behind a newer one.
 *
 * Takes as much as `available` covers, INCLUDING part of a charge — see the
 * header on why partial is the design here.
 *
 * Never a voided charge, and never one inside a bank pull still settling (see
 * IN_PENDING_DEBIT_SQL). The caller holds the landlord's
 * 'platform_held_reconcile:<id>' advisory lock, which a pull also takes while
 * it claims its charges (landlordGamDebit), so the two cannot interleave.
 *
 * `takes` receives what was kept from each charge. 10/12 (ledger P0): the
 * caller writes them as collection records against its payout batch
 * (recordGamChargeCollections) once that batch has an id — required, so a
 * netting can never collect without saying from what.
 */
export async function netAgainstDisbursement(
  client: PoolClient,
  landlordId: string,
  available: number,
  takes: GamChargeTake[],
): Promise<number> {
  if (available <= 0) return 0

  const charges = await client.query<{ id: string; outstanding: string }>(
    `SELECT c.id, (c.amount - c.collected_amount)::text AS outstanding
       FROM landlord_gam_charges c
      WHERE c.landlord_id = $1 AND ${GAM_CHARGE_OWED_SQL('c')}
        AND NOT ${IN_PENDING_DEBIT_SQL('c')}
      ORDER BY c.created_at ASC
      FOR UPDATE`,
    [landlordId])

  let remaining = Math.round(available * 100) / 100
  let taken = 0

  for (const row of charges.rows) {
    if (remaining <= 0) break
    const outstanding = Math.round(parseFloat(row.outstanding) * 100) / 100
    if (outstanding <= 0) continue
    const take = Math.min(outstanding, remaining)
    await client.query(
      `UPDATE landlord_gam_charges
          SET collected_amount = collected_amount + $2,
              collected_at = CASE WHEN collected_amount + $2 >= amount THEN NOW() ELSE collected_at END,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, take.toFixed(2)])
    takes.push({ chargeId: row.id, amount: take })
    remaining = Math.round((remaining - take) * 100) / 100
    taken = Math.round((taken + take) * 100) / 100
  }

  if (taken > 0) {
    logger.info({ landlordId, taken }, '[gam-account] netted out of disbursement')
  }
  return taken
}

/**
 * 10/12 (Nic, ledger P0): write what collected each charge — the payout batch
 * that netted it, or the bank pull that took it. One row per (charge,
 * source), in the caller's transaction, so landlord_gam_charge_collections
 * always adds up to each charge's collected_amount (migration 20261013090000
 * replayed the history to the same rule).
 */
export async function recordGamChargeCollections(
  client: Pick<PoolClient, 'query'>,
  takes: GamChargeTake[],
  source: { platformTransferIntentId: string } | { landlordGamDebitId: string },
): Promise<void> {
  const rows = takes.filter(t => Math.round(t.amount * 100) > 0)
  if (!rows.length) return
  const intentId = 'platformTransferIntentId' in source ? source.platformTransferIntentId : null
  const debitId = 'landlordGamDebitId' in source ? source.landlordGamDebitId : null
  await client.query(
    `INSERT INTO landlord_gam_charge_collections
       (charge_id, platform_transfer_intent_id, landlord_gam_debit_id, amount, collected_at)
     SELECT t.charge_id, $3::uuid, $4::uuid, t.amount, NOW()
       FROM unnest($1::uuid[], $2::numeric[]) AS t(charge_id, amount)`,
    [rows.map(t => t.chargeId), rows.map(t => (Math.round(t.amount * 100) / 100).toFixed(2)), intentId, debitId])
}

/**
 * Take a GAM charge back. 10/12 (Nic, ledger P0, design §16.3): VOIDED, never
 * deleted — the row stays with when and why (keep-everything), and
 * GAM_CHARGE_OWED_SQL stops it being owed. Only a charge nothing has been
 * collected on, and none a bank pull still settling is carrying (that money
 * is already on its way). Returns whether it was voided now.
 */
export async function voidGamCharge(
  client: Pick<PoolClient, 'query'> | null,
  chargeId: string,
  reason: LandlordGamChargeVoidReason,
): Promise<boolean> {
  // 10/12 (Nic, ledger P0 review): the row is locked FIRST, in its own
  // statement, and the void is a second statement. A single UPDATE read the
  // pulls with the snapshot it started with: when a bank pull had the charge
  // row-locked while claiming it and then committed, the waiting UPDATE went
  // ahead without seeing that pull, and voided a charge the pull was carrying
  // (its settlement would then collect a voided charge). Waiting on the lock
  // in its own statement, the void's statement starts after the pull
  // committed and sees it. The other way round, a pull that reaches the row
  // after this lock waits, then finds it voided and leaves it out.
  // (Not the account's advisory lock: a pull takes that BEFORE its row locks,
  // and this caller may already hold the row — stayTerms — so taking it here
  // would be the reverse order, a deadlock.)
  const sql =
    `UPDATE landlord_gam_charges c
        SET voided_at = NOW(), void_reason = $2, updated_at = NOW()
      WHERE c.id = $1 AND c.voided_at IS NULL AND c.collected_amount = 0
        AND NOT ${IN_PENDING_DEBIT_SQL('c')}
      RETURNING c.id`
  const lockSql = `SELECT id FROM landlord_gam_charges WHERE id = $1 FOR UPDATE`
  if (client) {
    await client.query(lockSql, [chargeId])
    return (await client.query(sql, [chargeId, reason])).rows.length > 0
  }
  // No caller transaction: one of its own, so the lock holds until the void commits.
  const own = await getClient()
  try {
    await own.query('BEGIN')
    await own.query(lockSql, [chargeId])
    const rows = (await own.query(sql, [chargeId, reason])).rows
    await own.query('COMMIT')
    return rows.length > 0
  } catch (e) {
    await own.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    own.release()
  }
}

export interface BalanceCheck {
  owed: number
  threshold: number
  overThreshold: boolean
}

/**
 * Record where this landlord's balance stands, and say whether it has crossed
 * the line into needing a direct debit.
 *
 * Called after every netting pass so the mark is written whether or not the
 * threshold trips — Nic: "we should flag those properties when that happens
 * and see how close it was to happening." A property that peaks at $80 and
 * never trips is the useful signal, and it only exists if the near-misses are
 * recorded too.
 */
export async function markBalance(landlordId: string, debited = false): Promise<BalanceCheck> {
  const [owed, threshold] = await Promise.all([
    outstandingForLandlord(landlordId),
    debitThresholdForLandlord(landlordId),
  ])
  await query(
    `INSERT INTO landlord_gam_balance_marks (landlord_id, peak_owed, threshold, debited)
     VALUES ($1, $2, $3, $4)`,
    [landlordId, owed.toFixed(2), threshold.toFixed(2), debited]
  ).catch(() => {})
  return { owed, threshold, overThreshold: owed >= threshold }
}

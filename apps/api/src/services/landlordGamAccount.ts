/**
 * What a landlord owes GAM, and how GAM gets it.
 *
 * S620 (Nic): "if six people pay cash and then four people pay card for the
 * remainder, we'll just take it all out of the card balance. It doesn't make
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
 * Nic on why (2) should almost never happen: at Oak Park a single ACH rent
 * payment offsets roughly 44 cash fees, and the park does not have 44 spaces.
 * "You're gonna have a mix of cash, card, ACH, and I don't think you're ever
 * gonna really hit that threshold." The high-water mark exists so that claim is
 * measured rather than assumed — a property peaking at $80 shows up before
 * anyone has to guess whether $100 is the right number.
 *
 * PARTIAL COLLECTION IS DELIBERATE, and it differs from the reversal netting
 * next to it in landlordPassthrough (full-net-or-nothing, Nic S561). Taking $50
 * of a $70 debt out of this week's money and carrying $20 is precisely what
 * avoids a bank debit, so partial is the point rather than a compromise.
 */

import type { PoolClient } from 'pg'
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

/** Fallback when a charge has no property (or the property was deleted). */
export const DEFAULT_DEBIT_THRESHOLD = 100

export interface GamCharge {
  landlordId: string
  propertyId?: string | null
  kind: 'subscription' | 'manual_payment_fee'
  amount: number
  /** what produced this, so a retry cannot bill twice */
  sourceType: string
  sourceId?: string | null
  notes?: string
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
       (landlord_id, property_id, kind, amount, source_type, source_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [c.landlordId, c.propertyId ?? null, c.kind, c.amount.toFixed(2),
     c.sourceType, c.sourceId ?? null, c.notes ?? null]
  )
  return rows[0]?.id ?? null
}

/** Everything this landlord still owes GAM, to the cent. */
export async function outstandingForLandlord(landlordId: string): Promise<number> {
  const row = await queryOne<{ owed: string }>(
    `SELECT COALESCE(SUM(amount - collected_amount), 0)::text AS owed
       FROM landlord_gam_charges
      WHERE landlord_id = $1 AND collected_amount < amount`,
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
 * Net what the landlord owes GAM against money about to be paid out to them.
 *
 * Runs inside the caller's RESERVE transaction, exactly like
 * applyReversalNetting, and returns how much was taken. Oldest charge first so
 * a debt cannot sit forever behind a newer one.
 *
 * Takes as much as `available` covers, INCLUDING part of a charge — see the
 * header on why partial is the design here.
 */
export async function netAgainstDisbursement(
  client: PoolClient,
  landlordId: string,
  available: number,
): Promise<number> {
  if (available <= 0) return 0

  const charges = await client.query<{ id: string; outstanding: string }>(
    `SELECT id, (amount - collected_amount)::text AS outstanding
       FROM landlord_gam_charges
      WHERE landlord_id = $1 AND collected_amount < amount
      ORDER BY created_at ASC
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
    remaining = Math.round((remaining - take) * 100) / 100
    taken = Math.round((taken + take) * 100) / 100
  }

  if (taken > 0) {
    logger.info({ landlordId, taken }, '[gam-account] netted out of disbursement')
  }
  return taken
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

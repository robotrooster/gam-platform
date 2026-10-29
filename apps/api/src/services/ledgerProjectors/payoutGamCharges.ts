/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: WHAT GAM CHARGES THE LANDLORD, AND HOW IT IS PAID
 * (gam-ledger-design-2026-10-12 §6 H; Nic's 10/12 answers G1, G5)
 *
 * Source 'gam_charge' = one landlord_gam_charges row: a fee the landlord owes
 * GAM, on the day it was charged (its property's calendar, else the
 * company's). Owed until it is collected — out of a payout (the batch posts
 * Dr Due to GAM, payoutTransfer, H6) or by a bank pull (the pull, below):
 *
 *   subscription, manual_payment_fee   Dr GAM platform fees (5155)        / Cr Due to GAM (2080)   H1
 *   bank_debit_cost                    Dr Bank fees (5220)                / Cr 2080                H2
 *   bank_debit_failed_cost             Dr Chargeback and return fees (5116) / Cr 2080 — Nic G1:
 *                                      "gam eats no fees of failed pulls ever"; what the failed
 *                                      pull cost GAM is the landlord's, at cost
 *   uncovered_processing_fee           Dr Processing fees (5115)          / Cr 2080 — Nic G5: the
 *                                      part of a fee the landlord covers that the payment was too
 *                                      small to pay (allocation_splits.landlord_fee_uncovered)
 *   screening_fee                      nothing: the cash sale that took GAM's background-check fee
 *                                      already credited 2080 (registerSale, design H3)
 *   device_installment                 nothing of its own — 10/13 (Nic): "Readers on the LANDLORD's
 *                                      books: each $87.50 → SUPPLIES, in the month GAM COLLECTED it"
 *                                      (design Q11 answered: an expense per piece, never equipment
 *                                      the landlord owns). The payout batch or bank pull the piece
 *                                      came out of posts it — Dr Supplies (5140) where it would have
 *                                      debited Due to GAM (payoutTransfer; the pull, below) — so the
 *                                      expense lands on the day GAM collected it, never when charged
 *
 * A voided charge posts nothing (taken back as a correction). 10/13 (Nic): a
 * charge on no property is GAM's own company-wide charge — the only kind of
 * cost nobody logs ("except gams charge all those costs get logged by a
 * person") — so it goes to the Company column (companyCosts COMPANY_COLUMN);
 * no setting decides it.
 *
 * Source 'gam_debit' = one landlord_gam_debits row: a bank pull of GAM's fees,
 * posted when it succeeds (its settled day, the company's calendar):
 *
 *   Dr Due to GAM (2080)                 each charge it collected, at the charge's property
 *                                        (landlord_gam_charge_collections, design P0)
 *   Dr Supplies (5140)                   10/13 (Nic): each card reader piece it collected, at the
 *                                        piece's property (one on no property: the Company
 *                                        column, companyCosts) — the piece is an expense in the
 *                                        month GAM collected it
 *   Cr Outstanding checks and debits (2015)  the same — cleared when the "GAM FEES" bank line
 *                                        matches it (design H5; never an expense)
 *
 * A pull for more than the charges on record (a pull raised by code from
 * before 10/12) puts the difference in Suspense (1099) to classify. A failed
 * pull posts nothing; what it cost is its own charge (above).
 *
 * 10/13 (Nic): "GAM fee pull disputed by landlord's bank: AUTOMATIC — the
 * disputed fees reopen as owed by the landlord, collected on the next pull,
 * admin told." A pull the landlord's bank disputed (disputed_at; it stays
 * 'succeeded', services/landlordGamDebit handleGamDebitDispute) posts a second
 * posting of its own, on the dispute's day (the company's calendar), that
 * takes back exactly what the pull posted:
 *
 *   Dr Outstanding checks and debits (2015)  the bank money coming back, until
 *                                        the bank line of the return clears it
 *   Cr Due to GAM (2080)                 each charge the pull had paid, owed again,
 *                                        at the charge's property
 *   Cr Supplies (5140)                   10/13 (Nic): each reader piece it had paid —
 *                                        not collected after all; the pull that collects
 *                                        it again expenses it then
 *   (and the Suspense difference back out of Suspense)
 *
 * With the rest of the dispute posting through its own charges — the pull's
 * own $6 cost line voided (its charge taken back: Dr 2080 / Cr Bank fees) and
 * what the dispute cost GAM billed at cost (bank_debit_failed_cost, source
 * 'gam_bank_debit_disputed': Dr 5116 / Cr 2080) — Due to GAM is up by exactly
 * dispute_reopened_amount plus that cost, and the next pull that collects them
 * debits it again. The p5_due_to_gam tie-out counts no collection of a disputed
 * pull (payoutChecks), so the books and the money records agree throughout.
 *
 * 10/13 (Nic): "Won GAM pull dispute: AUTOMATIC (back to collected; anything
 * collected twice credited back)." When Stripe decides the dispute for GAM
 * (landlord_gam_debits.dispute_won_at, services/landlordGamDebit
 * applyWonGamDebitDispute) the pull's money stands after all, so its
 * 'cancellation' is no longer wanted and is taken back (the engine reverses it:
 * the dispute's month restated, or the take-back shown on the win's day under
 * "show fixes on the day made"). The rest of the win posts through its own
 * records: the pull's own $6 un-voided (its charge posts again), the dispute's
 * cost charge voided (taken back) and what Stripe kept billed anew, and each
 * charge collected twice (or collected and voided) given back on a payout line
 * (payoutHeldItem: Dr 1050 / Cr 2080). The tie-out counts a won pull's
 * collections again (payoutChecks).
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import type { LedgerAccountRole } from '@gam/shared'
import { cr, dr, toCents, waitsOnRule, localDaySql, propertyTzSql, companyTzSql } from './registerBookingPayoutKit'
import { COMPANY_COLUMN, drSpread } from './companyCosts'

/**
 * 10/13 (Nic): "Readers on the LANDLORD's books: each $87.50 → SUPPLIES, in
 * the month GAM COLLECTED it." The landlord_gam_charges kind of a card
 * reader's monthly piece, and what a batch or a pull that collected one posts
 * for it instead of paying Due to GAM.
 */
export const READER_PIECE_KIND = 'device_installment'
const READER_PIECE_MEMO = 'Card reader piece GAM collected'

/**
 * 10/13 (Nic): the Supplies expense for reader pieces a batch or a pull
 * collected at one property (`propertyId`; null: the Company column — a piece
 * is GAM's own charge, logged by nobody, companyCosts). `side` 'cr' takes it
 * back exactly (a disputed pull).
 */
export function readerPieceLines(a: { propertyId: string | null; cents: number; side: 'dr' | 'cr' }): DesiredLine[] {
  if (!a.cents) return []
  return (a.side === 'dr' ? dr : cr)('supplies', a.cents, { propertyId: a.propertyId, memo: READER_PIECE_MEMO })
}

/** The expense each GAM charge kind is (null: posts nothing of its own). */
const CHARGE_EXPENSE: Record<string, LedgerAccountRole | null> = {
  subscription: 'gam_platform_fees',
  manual_payment_fee: 'gam_platform_fees',
  bank_debit_cost: 'bank_fees',
  bank_debit_failed_cost: 'chargeback_fees',
  uncovered_processing_fee: 'processing_fees',
  screening_fee: null,
}
const CHARGE_MEMO: Record<string, string> = {
  subscription: 'GAM platform fee',
  manual_payment_fee: 'GAM fee on a payment recorded by hand',
  bank_debit_cost: 'Bank transfer cost of collecting GAM\'s fees',
  bank_debit_failed_cost: 'What a failed bank pull of GAM\'s fees cost',
  uncovered_processing_fee: 'Processing fee you cover, more than the payment',
}
/**
 * 10/13 (Nic): the cost of a pull the landlord's bank disputed is a
 * bank_debit_failed_cost charge too (G1), from this source
 * (services/landlordGamDebit GAM_DEBIT_DISPUTE_COST_SOURCE) — the pull did go
 * through, so its memo says what happened.
 */
const DISPUTED_PULL_COST_SOURCE = 'gam_bank_debit_disputed'
const DISPUTED_PULL_COST_MEMO = 'What a bank pull of GAM\'s fees your bank disputed cost'

export const payoutGamChargeProjector: LedgerProjector = {
  sourceType: 'gam_charge',
  // 10/12 (Nic, review): 2 — a charge on no property follows the company's
  // choice for company-level costs (Nic L7). 10/13 (Nic): 3 — a reader piece
  // posts nothing of its own (its collection does); the Company column by default.
  // 10/13 (Nic): 4 — a charge on no property is GAM's own company-wide charge:
  // the Company column, never a setting.
  ruleVersion: 4,

  async project(client: PoolClient, chargeId: string): Promise<DesiredPosting[]> {
    const c = (await client.query<{
      landlord_id: string; property_id: string | null; kind: string; amount: string; voided_at: string | null; day: string
      source_type: string | null; created_at: string
    }>(
      `SELECT c.landlord_id, c.property_id, c.kind, c.amount::text, c.voided_at::text, c.source_type, c.created_at::text,
              ${localDaySql('c.created_at', propertyTzSql('c.property_id', 'c.landlord_id'))} AS day
         FROM landlord_gam_charges c WHERE c.id::text = $1`, [chargeId])).rows[0]
    if (!c || c.voided_at) return []
    // 10/13 (Nic): a reader piece is an expense in the month GAM collected it —
    // the batch or pull that collected it posts it, never the charge.
    if (c.kind === READER_PIECE_KIND) return []
    if (!(c.kind in CHARGE_EXPENSE)) throw waitsOnRule(`A GAM charge of kind ${c.kind} has no posting rule.`)
    const role = CHARGE_EXPENSE[c.kind]
    if (!role) return []
    const amt = toCents(c.amount)
    const memo = c.kind === 'bank_debit_failed_cost' && c.source_type === DISPUTED_PULL_COST_SOURCE
      ? DISPUTED_PULL_COST_MEMO
      : CHARGE_MEMO[c.kind]
    const at = { propertyId: c.property_id }
    // 10/13 (Nic): a charge on no property (the bank cost of a pull, a failed
    // pull's cost) is GAM's own company-wide charge — nobody logs it, so no one
    // picks where it goes: the Company column. What is owed to GAM stays at
    // company level too.
    const cost = c.property_id
      ? dr(role, amt, { ...at, memo })
      : drSpread(role, amt, COMPANY_COLUMN, { memo })
    return [{ owner: { landlordId: c.landlord_id }, intendedDate: c.day, memo, lines: [
      ...cost, ...cr('due_to_gam', amt, { ...at, memo: 'Owed to GAM' }),
    ] }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT c.id::text AS id, ${localDaySql('c.created_at', propertyTzSql('c.property_id', 'c.landlord_id'))} AS day
         FROM landlord_gam_charges c
        WHERE c.landlord_id = $1 AND ($2::date IS NULL OR c.created_at >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

export const payoutGamDebitProjector: LedgerProjector = {
  sourceType: 'gam_debit',
  // 10/13 (Nic): 2 — a pull the landlord's bank disputed takes itself back
  // (its own 'cancellation' posting, on the dispute's day). 3 — a card reader
  // piece it collected is a Supplies expense, not Due to GAM; a dispute GAM
  // won takes the cancellation back.
  ruleVersion: 3,

  async project(client: PoolClient, debitId: string): Promise<DesiredPosting[]> {
    const d = (await client.query<{
      landlord_id: string; total: string; status: string; day: string | null; disputed_day: string | null; settled_at: string | null
      won: boolean
    }>(
      `SELECT d.landlord_id, d.total_amount::text AS total, d.status, d.settled_at::text AS settled_at,
              d.dispute_won_at IS NOT NULL AS won,
              CASE WHEN d.settled_at IS NULL THEN NULL ELSE ${localDaySql('d.settled_at', companyTzSql('d.landlord_id'))} END AS day,
              CASE WHEN d.disputed_at IS NULL THEN NULL ELSE ${localDaySql('d.disputed_at', companyTzSql('d.landlord_id'))} END AS disputed_day
         FROM landlord_gam_debits d WHERE d.id::text = $1`, [debitId])).rows[0]
    if (!d || d.status !== 'succeeded' || !d.day) return []
    const cols = (await client.query<{ property_id: string | null; piece: boolean; s: string }>(
      `SELECT c.property_id, c.kind = $2 AS piece, SUM(col.amount)::text AS s
         FROM landlord_gam_charge_collections col JOIN landlord_gam_charges c ON c.id = col.charge_id
        WHERE col.landlord_gam_debit_id::text = $1
        GROUP BY c.property_id, c.kind = $2 ORDER BY c.property_id NULLS FIRST, piece`, [debitId, READER_PIECE_KIND])).rows
    const lines: DesiredLine[] = []
    const back: DesiredLine[] = []
    let recorded = 0
    for (const r of cols) {
      const v = toCents(r.s)
      recorded += v
      if (r.piece) {
        // 10/13 (Nic): a card reader piece is a Supplies expense in the month
        // GAM collected it — this pull's day — and comes back off if the bank
        // takes the pull back. Each cost sits beside the line that paid it.
        const piece = { propertyId: r.property_id, cents: v }
        lines.push(...readerPieceLines({ ...piece, side: 'dr' }))
        lines.push(...cr('outstanding_checks', v, { propertyId: r.property_id, memo: 'Bank pull of GAM\'s fees, until the bank line matches it' }))
        back.push(...dr('outstanding_checks', v, { propertyId: r.property_id, memo: 'Bank pull of GAM\'s fees your bank took back, until the bank line of the return matches it' }))
        back.push(...readerPieceLines({ ...piece, side: 'cr' }))
        continue
      }
      lines.push(...dr('due_to_gam', v, { propertyId: r.property_id, memo: 'GAM charges paid by a bank pull' }))
      lines.push(...cr('outstanding_checks', v, { propertyId: r.property_id, memo: 'Bank pull of GAM\'s fees, until the bank line matches it' }))
      back.push(...dr('outstanding_checks', v, { propertyId: r.property_id, memo: 'Bank pull of GAM\'s fees your bank took back, until the bank line of the return matches it' }))
      back.push(...cr('due_to_gam', v, { propertyId: r.property_id, memo: 'GAM charges owed again: your bank disputed the pull that paid them' }))
    }
    const extra = toCents(d.total) - recorded
    lines.push(...dr('suspense', extra, { propertyId: null, memo: 'Pulled beyond the GAM charges on record — to classify' }))
    lines.push(...cr('outstanding_checks', extra, { propertyId: null, memo: 'Bank pull of GAM\'s fees, until the bank line matches it' }))
    back.push(...dr('outstanding_checks', extra, { propertyId: null, memo: 'Bank pull of GAM\'s fees your bank took back, until the bank line of the return matches it' }))
    back.push(...cr('suspense', extra, { propertyId: null, memo: 'Pulled beyond the GAM charges on record — taken back by your bank' }))
    const owner = { landlordId: d.landlord_id }
    const out: DesiredPosting[] = [{ owner, intendedDate: d.day, memo: 'GAM fees paid by bank pull', lines }]
    // 10/13 (Nic): disputed by the landlord's bank — the whole pull came back
    // (a dispute for part of a pull is never placed by itself: it is left
    // undisputed for a person, handleGamDebitDispute), so its own posting
    // takes back exactly what the pull posted, on the dispute's day — until
    // GAM wins the dispute: the money stands, and the cancellation is taken back.
    if (d.disputed_day && !d.won) {
      out.push({ owner, postingKind: 'cancellation', intendedDate: d.disputed_day,
        memo: 'GAM fee pull your bank disputed: the money comes back and the charges are owed again', lines: back })
    }
    return out
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    // 10/13 (Nic): a pull disputed on or after `since` posts its dispute then,
    // however long before it was paid — and one whose dispute GAM won since
    // takes that back; it is listed on the day it paid (its earliest posting).
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT d.id::text AS id,
              CASE WHEN d.settled_at IS NULL THEN NULL ELSE ${localDaySql('d.settled_at', companyTzSql('d.landlord_id'))} END AS day
         FROM landlord_gam_debits d
        WHERE d.landlord_id = $1
          AND ($2::date IS NULL OR COALESCE(d.settled_at, d.created_at) >= $2::date - INTERVAL '1 day'
                                OR d.disputed_at >= $2::date - INTERVAL '1 day'
                                OR d.dispute_won_at >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

/**
 * 10/13 (Nic): "Readers on the LANDLORD's books: each $87.50 → SUPPLIES, in
 * the month GAM COLLECTED it." A card reader order (pos_reader_orders) is no
 * entry on the landlord's books — not equipment they own (design H4), not
 * owed until collected — so it posts nothing; each piece posts when a batch or
 * a pull collects it. Registered so its marks drain.
 */
export const readerOrderProjector: LedgerProjector = {
  sourceType: 'reader_order',
  ruleVersion: 1,
  async project(): Promise<DesiredPosting[]> { return [] },
  async listSources(): Promise<LedgerSourceRef[]> { return [] },
}

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
 *   device_installment                 waits — a card reader's pieces post once Nic says whether the
 *                                      reader is equipment the landlord owns (design H4: Dr 2085 /
 *                                      Cr 2080 each piece) or an expense per piece (design Q11)
 *
 * A voided charge posts nothing (taken back as a correction).
 *
 * Source 'gam_debit' = one landlord_gam_debits row: a bank pull of GAM's fees,
 * posted when it succeeds (its settled day, the company's calendar):
 *
 *   Dr Due to GAM (2080)                 each charge it collected, at the charge's property
 *                                        (landlord_gam_charge_collections, design P0)
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
 *   (and the Suspense difference back out of Suspense)
 *
 * With the rest of the dispute posting through its own charges — the pull's
 * own $6 cost line voided (its charge taken back: Dr 2080 / Cr Bank fees) and
 * what the dispute cost GAM billed at cost (bank_debit_failed_cost, source
 * 'gam_bank_debit_disputed': Dr 5116 / Cr 2080) — Due to GAM is up by exactly
 * dispute_reopened_amount plus that cost, and the next pull that collects them
 * debits it again. The p5_due_to_gam tie-out counts no collection of a disputed
 * pull (payoutChecks), so the books and the money records agree throughout.
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import type { LedgerAccountRole } from '@gam/shared'
import { cr, dr, toCents, waitsOnRule, localDaySql, propertyTzSql, companyTzSql } from './registerBookingPayoutKit'
import { companyCostSpread, drSpread } from './companyCosts'

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
  // choice for company-level costs (Nic L7).
  ruleVersion: 2,

  async project(client: PoolClient, chargeId: string): Promise<DesiredPosting[]> {
    const c = (await client.query<{
      landlord_id: string; property_id: string | null; kind: string; amount: string; voided_at: string | null; day: string
      source_type: string | null
    }>(
      `SELECT c.landlord_id, c.property_id, c.kind, c.amount::text, c.voided_at::text, c.source_type,
              ${localDaySql('c.created_at', propertyTzSql('c.property_id', 'c.landlord_id'))} AS day
         FROM landlord_gam_charges c WHERE c.id::text = $1`, [chargeId])).rows[0]
    if (!c || c.voided_at) return []
    if (c.kind === 'device_installment') {
      throw waitsOnRule('A card reader piece waits on Nic: is the reader equipment the landlord owns, or an expense per piece (design Q11)?')
    }
    if (!(c.kind in CHARGE_EXPENSE)) throw waitsOnRule(`A GAM charge of kind ${c.kind} has no posting rule.`)
    const role = CHARGE_EXPENSE[c.kind]
    if (!role) return []
    const amt = toCents(c.amount)
    const memo = c.kind === 'bank_debit_failed_cost' && c.source_type === DISPUTED_PULL_COST_SOURCE
      ? DISPUTED_PULL_COST_MEMO
      : CHARGE_MEMO[c.kind]
    const at = { propertyId: c.property_id }
    // 10/12 (Nic, review; Nic L7): a charge on no property (the bank cost of a
    // pull, a failed pull's cost) is a company-level cost — a Company column of
    // its own, or split across the properties by units, as the owner chose for
    // money out, loans and payroll (it waits until they choose). What is owed
    // to GAM stays at company level.
    const cost = c.property_id
      ? dr(role, amt, { ...at, memo })
      : drSpread(role, amt, await companyCostSpread(client, c.landlord_id, c.day), { memo })
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
  // (its own 'cancellation' posting, on the dispute's day).
  ruleVersion: 2,

  async project(client: PoolClient, debitId: string): Promise<DesiredPosting[]> {
    const d = (await client.query<{ landlord_id: string; total: string; status: string; day: string | null; disputed_day: string | null }>(
      `SELECT d.landlord_id, d.total_amount::text AS total, d.status,
              CASE WHEN d.settled_at IS NULL THEN NULL ELSE ${localDaySql('d.settled_at', companyTzSql('d.landlord_id'))} END AS day,
              CASE WHEN d.disputed_at IS NULL THEN NULL ELSE ${localDaySql('d.disputed_at', companyTzSql('d.landlord_id'))} END AS disputed_day
         FROM landlord_gam_debits d WHERE d.id::text = $1`, [debitId])).rows[0]
    if (!d || d.status !== 'succeeded' || !d.day) return []
    const cols = (await client.query<{ property_id: string | null; s: string }>(
      `SELECT c.property_id, SUM(col.amount)::text AS s
         FROM landlord_gam_charge_collections col JOIN landlord_gam_charges c ON c.id = col.charge_id
        WHERE col.landlord_gam_debit_id::text = $1
        GROUP BY c.property_id ORDER BY c.property_id NULLS FIRST`, [debitId])).rows
    const lines: DesiredLine[] = []
    const back: DesiredLine[] = []
    let recorded = 0
    for (const r of cols) {
      const v = toCents(r.s)
      recorded += v
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
    // takes back exactly what the pull posted, on the dispute's day.
    if (d.disputed_day) {
      out.push({ owner, postingKind: 'cancellation', intendedDate: d.disputed_day,
        memo: 'GAM fee pull your bank disputed: the money comes back and the charges are owed again', lines: back })
    }
    return out
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    // 10/13 (Nic): a pull disputed on or after `since` posts its dispute then,
    // however long before it was paid; it is listed on the day it paid (its
    // earliest posting).
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT d.id::text AS id,
              CASE WHEN d.settled_at IS NULL THEN NULL ELSE ${localDaySql('d.settled_at', companyTzSql('d.landlord_id'))} END AS day
         FROM landlord_gam_debits d
        WHERE d.landlord_id = $1
          AND ($2::date IS NULL OR COALESCE(d.settled_at, d.created_at) >= $2::date - INTERVAL '1 day'
                                OR d.disputed_at >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

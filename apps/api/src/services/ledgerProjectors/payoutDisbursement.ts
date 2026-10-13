/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: THE PAYOUT TO THE LANDLORD'S BANK
 * (gam-ledger-design-2026-10-12 §6 G3)
 *
 * Source 'disbursement' = one disbursements row (a Stripe payout from the
 * landlord's Connect account to their bank: the weekly run, a catch-up, or one
 * the landlord made in the Stripe dashboard), posted once it is settled, on
 * the day it settled (the company's books calendar):
 *
 *   Dr Checking (1010)              the payout's own amount — on the linked
 *                                   bank's own sub-account: 10/12 (Nic, ledger
 *                                   review) the bank connection of the bank line
 *                                   matched to this payout (a stored fact; its
 *                                   change re-posts the payout, migration
 *                                   20261014170000), else the connection ending
 *                                   in the payout's last four that was linked
 *                                   most recently on or before the payout
 *                                   settled (connections are never re-dated, so
 *                                   a later reconnect never moves an old payout),
 *                                   else the oldest such connection
 *   Dr Bank fees (5220)             an instant payout's fee (fee_charged)
 *   Cr Stripe in transit (1060)     both, at the properties of the transfers
 *                                   the payout carried (platform_transfer_intents
 *                                   .disbursement_id, split like each batch —
 *                                   payoutTransfer.batchByProperty); company
 *                                   level when it carried none on record
 *
 * A move between the landlord's own accounts, never income (fixes the old
 * Books treatment as financing). The company is the payout's own landlord_id
 * (design §16 fix 2: never the first company on a shared Stripe account). A
 * payout on an account two companies share (landlord_id NULL) is split
 * between the companies of the transfers it carried, by their amounts; with
 * none on record it waits (nobody can say whose it is). A payout that failed,
 * or has not settled, posts nothing; one that fails after settling is taken
 * back as a correction.
 *
 * Also here:
 *   'connect_payout'   a PM company's payout (connect_payouts is the PM
 *                      companies' record; a landlord's payouts are
 *                      disbursements rows, which its change also marks): never
 *                      on a landlord's book — posts nothing.
 *   'instant_margin'   GAM's margin on an instant payout, once collected from
 *                      the Connect balance (design G3): Dr GAM platform fees
 *                      (5155) / Cr Stripe in transit (1060), company level.
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { cr, dr, toCents, splitCents, missingFact, localDaySql, companyTzSql } from './registerBookingPayoutKit'
import { batchByProperty, loadIntent } from './payoutTransfer'
import { companyCostSpread, drSpread } from './companyCosts'

export const payoutDisbursementProjector: LedgerProjector = {
  sourceType: 'disbursement',
  ruleVersion: 1,

  async project(client: PoolClient, disbursementId: string): Promise<DesiredPosting[]> {
    const d = (await client.query<{
      id: string; landlord_id: string | null; amount: string; status: string; settled_at: string | null
      fee_charged: string | null; bank_last4: string | null; trigger_type: string | null
    }>(
      `SELECT id, landlord_id, amount::text, status, settled_at::text, fee_charged::text, bank_last4, trigger_type
         FROM disbursements WHERE id::text = $1`, [disbursementId])).rows[0]
    if (!d || d.status !== 'settled' || !d.settled_at) return []

    // The transfers it carried, and each one's money by property.
    const intents = (await client.query<{ id: string; landlord_id: string | null; amount: string }>(
      `SELECT id::text, landlord_id, amount::text FROM platform_transfer_intents
        WHERE disbursement_id::text = $1 AND status = 'transferred' ORDER BY id`, [d.id])).rows
    const byCompany = new Map<string, Map<string, number>>()
    for (const it of intents) {
      if (!it.landlord_id) continue
      const row = await loadIntent(client, it.id)
      if (!row) continue
      const m = byCompany.get(it.landlord_id) ?? new Map<string, number>()
      const toStripe = row.purpose === 'payout'
        ? (await batchByProperty(client, row)).toStripe
        : new Map<string, number>([['', toCents(row.amount)]])
      for (const [k, v] of toStripe) m.set(k, (m.get(k) ?? 0) + v)
      byCompany.set(it.landlord_id, m)
    }

    const amount = toCents(d.amount)
    const fee = toCents(d.fee_charged)
    // Whose payout: its own company, else the companies of what it carried.
    let shares: { landlordId: string; amount: number; fee: number; weights: Map<string, number> }[]
    if (d.landlord_id) {
      const w = new Map<string, number>()
      for (const m of byCompany.values()) for (const [k, v] of m) w.set(k, (w.get(k) ?? 0) + v)
      shares = [{ landlordId: d.landlord_id, amount, fee, weights: w }]
    } else {
      const companies = [...byCompany.keys()].sort()
      if (!companies.length) {
        throw missingFact('The payout names no company and carried no transfer on record, so nobody can say whose books it belongs to.')
      }
      const totals = companies.map(c => [...byCompany.get(c)!.values()].reduce((a, b) => a + Math.max(0, b), 0))
      const amounts = splitCents(amount, totals)
      const fees = splitCents(fee, totals)
      shares = companies.map((c, i) => ({ landlordId: c, amount: amounts[i], fee: fees[i], weights: byCompany.get(c)! }))
    }

    const out: DesiredPosting[] = []
    for (const s of shares) {
      const day = (await client.query<{ day: string }>(
        `SELECT ${localDaySql('$1::timestamptz', companyTzSql('$2::uuid'))} AS day`, [d.settled_at, s.landlordId])).rows[0].day
      // The linked bank, from stored facts only (see the header): never from
      // which connections happen to be on file today.
      const bank = (await client.query<{ id: string | null }>(
        `SELECT COALESCE(
           (SELECT bt.bank_connection_id::text FROM bank_transactions bt
             WHERE bt.matched_disbursement_id::text = $3 AND bt.landlord_id = $1
             ORDER BY bt.posted_date, bt.id LIMIT 1),
           (SELECT bc.id::text FROM bank_connections bc
             WHERE bc.landlord_id = $1 AND $2::text IS NOT NULL AND bc.account_last4 = $2 AND bc.created_at <= $4::timestamptz
             ORDER BY bc.created_at DESC, bc.id DESC LIMIT 1),
           (SELECT bc.id::text FROM bank_connections bc
             WHERE bc.landlord_id = $1 AND $2::text IS NOT NULL AND bc.account_last4 = $2
             ORDER BY bc.created_at, bc.id LIMIT 1)) AS id`,
        [s.landlordId, d.bank_last4, d.id, d.settled_at])).rows[0]?.id ?? null
      const bankSub = bank ? { sub: { kind: 'bank_connection' as const, value: bank } } : {}
      const keys = [...s.weights.keys()].filter(k => (s.weights.get(k) ?? 0) > 0).sort()
      const parts = keys.length ? splitCents(s.amount, keys.map(k => s.weights.get(k)!)) : [s.amount]
      const feeParts = keys.length ? splitCents(s.fee, keys.map(k => s.weights.get(k)!)) : [s.fee]
      const props = keys.length ? keys.map(k => (k === '' ? null : k)) : [null]
      const lines: DesiredLine[] = []
      props.forEach((p, i) => {
        lines.push(...dr('bank_checking', parts[i], { ...bankSub, propertyId: p, memo: 'Payout to your bank' }))
        lines.push(...dr('bank_fees', feeParts[i], { propertyId: p, memo: 'Instant payout fee' }))
        lines.push(...cr('stripe_in_transit', parts[i] + feeParts[i], { propertyId: p, memo: 'Paid out from your Stripe account' }))
      })
      out.push({ owner: { landlordId: s.landlordId }, intendedDate: day, memo: 'Payout to your bank', lines })
    }
    return out
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string }>(
      `SELECT d.id::text AS id FROM disbursements d
        WHERE (d.landlord_id = $1
               OR (d.landlord_id IS NULL AND EXISTS (SELECT 1 FROM platform_transfer_intents i
                                                      WHERE i.disbursement_id = d.id AND i.landlord_id = $1)))
          AND ($2::date IS NULL OR COALESCE(d.settled_at, d.created_at) >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id }))
  },
}

/** A PM company's payout (connect_payouts): never on a landlord's book. Registered so its marks drain. */
export const payoutConnectPayoutProjector: LedgerProjector = {
  sourceType: 'connect_payout',
  ruleVersion: 1,
  async project(): Promise<DesiredPosting[]> { return [] },
  async listSources(): Promise<LedgerSourceRef[]> { return [] },
}

export const payoutInstantMarginProjector: LedgerProjector = {
  sourceType: 'instant_margin',
  // 10/12 (Nic, review): 2 — a company-level cost, placed as the owner chose (Nic L7).
  ruleVersion: 2,

  async project(client: PoolClient, marginId: string): Promise<DesiredPosting[]> {
    const m = (await client.query<{ landlord_id: string | null; amount: string; status: string; day: string | null; collected_at: string | null }>(
      `SELECT landlord_id, amount::text, status, collected_at::text AS collected_at,
              CASE WHEN collected_at IS NULL OR landlord_id IS NULL THEN NULL
                   ELSE ${localDaySql('collected_at', companyTzSql('landlord_id'))} END AS day
         FROM landlord_instant_margins WHERE id::text = $1`, [marginId])).rows[0]
    if (!m || !m.landlord_id || m.status !== 'collected' || !m.day) return []
    const amt = toCents(m.amount)
    const memo = 'GAM\'s fee on an instant payout'
    // 10/12 (Nic, review; Nic L7): GAM's fee on a payout belongs to no one
    // property — a Company column of its own, or split by units, as the owner
    // chose (10/13: the Company column until they choose; a later split only
    // for fees collected after it). The money left from company level.
    return [{ owner: { landlordId: m.landlord_id }, intendedDate: m.day, memo, lines: [
      ...drSpread('gam_platform_fees', amt, await companyCostSpread(client, m.landlord_id, m.day, { at: m.collected_at }), { memo }),
      ...cr('stripe_in_transit', amt, { propertyId: null, memo }),
    ] }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string }>(
      `SELECT id::text FROM landlord_instant_margins
        WHERE landlord_id = $1 AND ($2::date IS NULL OR COALESCE(collected_at, created_at) >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id }))
  },
}

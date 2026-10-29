/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: THE NIGHTLY TIE-OUTS FOR THE PAYOUT CHAIN
 * (gam-ledger-design-2026-10-12 §8 "Nightly checks")
 *
 * Run inside the nightly check's one REPEATABLE READ snapshot (services/
 * ledgerCheck, registerLedgerCheck), per company. Each compares an account's
 * ledger balance with the money records it must equal; a difference is drift
 * (re-posted from source by the check, never plugged):
 *
 *   p5_stripe_in_transit (1060)   transfers sent to the company's Stripe account
 *                                 (weekly batches and recorded direct transfers)
 *                                 − payouts settled to its bank (and their
 *                                 instant fees) − GAM's instant margins collected
 *   p5_due_to_gam (2080)          every live GAM charge − what has been collected
 *                                 on it (landlord_gam_charge_collections); a
 *                                 card reader's pieces are never owed on the
 *                                 landlord's books — 10/13 (Nic): "each $87.50
 *                                 → SUPPLIES, in the month GAM COLLECTED it":
 *                                 the charge posts nothing and the batch or
 *                                 pull that collects a piece debits Supplies,
 *                                 not 2080 (payoutGamCharges, payoutTransfer),
 *                                 so pieces are on neither side.
 *                                 10/13 (Nic): a bank pull the landlord's
 *                                 bank disputed collected nothing — its
 *                                 charges are owed again and its own posting
 *                                 credits 2080 back (payoutGamCharges) — so
 *                                 its collections count on neither side,
 *                                 until GAM wins the dispute: then they
 *                                 count again ("back to collected"), and a
 *                                 charge collected twice, or collected and
 *                                 then voided, is given back on a payout line
 *                                 that credits 2080 back (payoutHeldItem) —
 *                                 so every charge's collections count, live
 *                                 or voided, less what was given back
 *
 * 10/12 (Nic, ledger review): a difference is 'pending' while a record that
 * posts to the account still waits to post (services/ledgerPending), else
 * drift.
 *
 * Both compare the whole history: a company whose books start after its first
 * money needs its opening posting (design J1, which carries every projection
 * dated before the start) for the totals to meet.
 *
 * The 1050 tie-out (owner shares and held lines not yet paid out, less the
 * recoveries still owed) is left to the phase that posts payment reversals and
 * receipts (P4: design B1, C1, E1): those sources move 1050 too, and the rule
 * for a reversal's withheld and returned share lines is theirs.
 */
import type { PoolClient } from 'pg'
import type { LedgerCheck, LedgerFinding, LedgerFindingSeverity } from '../ledgerCheck'
import type { LedgerOwner } from '../ledgerOwner'
import { toCents } from './registerBookingPayoutKit'
import { loadPendingScope, waitingFor, severityOf, type PendingRule } from '../ledgerPending'
import { READER_PIECE_KIND } from './payoutGamCharges'

/** What posts to Stripe in transit (1060) and to Due to GAM (2080). */
export const STRIPE_IN_TRANSIT_RULE: PendingRule = { types: ['transfer_intent', 'disbursement', 'instant_margin'] }
export const DUE_TO_GAM_RULE: PendingRule = { types: ['gam_charge', 'gam_debit', 'transfer_intent', 'pos_sale',
  // 10/13 (Nic): a GAM charge given back on a payout line (a won pull dispute).
  'held_item'] }

async function roleBalance(client: PoolClient, landlordId: string, role: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT COALESCE(SUM(debit - credit), 0)::text AS n FROM ledger_posting_lines WHERE landlord_id = $1 AND account_role = $2`,
    [landlordId, role])
  return toCents(r.rows[0]?.n)
}

function drift(check: string, ledgerCents: number, expectedCents: number, extra: Record<string, unknown> = {},
  severity: LedgerFindingSeverity = 'drift'): LedgerFinding[] {
  if (ledgerCents === expectedCents) return []
  return [{ check, severity, detail: {
    ledger: ledgerCents / 100, expected: expectedCents / 100, difference: (ledgerCents - expectedCents) / 100, ...extra,
  } }]
}

export const stripeInTransitCheck: LedgerCheck = {
  name: 'p5_stripe_in_transit',
  async run(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]> {
    if (!owner.landlordId) return []
    const ledger = await roleBalance(client, owner.landlordId, 'stripe_in_transit')
    const r = (await client.query<{ sent: string; paid: string; margins: string }>(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM platform_transfer_intents
           WHERE landlord_id = $1 AND status = 'transferred' AND purpose IN ('payout', 'deposit_settlement'))::text AS sent,
         (SELECT COALESCE(SUM(d.amount + COALESCE(d.fee_charged, 0)), 0) FROM disbursements d
           WHERE d.landlord_id = $1 AND d.status = 'settled')::text AS paid,
         (SELECT COALESCE(SUM(amount), 0) FROM landlord_instant_margins
           WHERE landlord_id = $1 AND status = 'collected')::text AS margins`, [owner.landlordId])).rows[0]
    // A payout from an account two companies share (no company of its own) is
    // each company's in proportion to the transfers it carried.
    const shared = (await client.query<{ s: string }>(
      `SELECT COALESCE(SUM((d.amount + COALESCE(d.fee_charged, 0)) * mine.amt / NULLIF(alls.amt, 0)), 0)::text AS s
         FROM disbursements d
         CROSS JOIN LATERAL (SELECT SUM(i.amount) AS amt FROM platform_transfer_intents i
                              WHERE i.disbursement_id = d.id AND i.status = 'transferred' AND i.landlord_id = $1) mine
         CROSS JOIN LATERAL (SELECT SUM(i.amount) AS amt FROM platform_transfer_intents i
                              WHERE i.disbursement_id = d.id AND i.status = 'transferred' AND i.landlord_id IS NOT NULL) alls
        WHERE d.landlord_id IS NULL AND d.status = 'settled' AND mine.amt IS NOT NULL`, [owner.landlordId])).rows[0]
    const expected = toCents(r.sent) - toCents(r.paid) - toCents(shared?.s) - toCents(r.margins)
    if (ledger === expected) return []
    const sev = severityOf(waitingFor(await loadPendingScope(client, owner.landlordId), STRIPE_IN_TRANSIT_RULE))
    return drift('p5_stripe_in_transit', ledger, expected, {}, sev)
  },
}

export const dueToGamCheck: LedgerCheck = {
  name: 'p5_due_to_gam',
  async run(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]> {
    if (!owner.landlordId) return []
    const ledger = -(await roleBalance(client, owner.landlordId, 'due_to_gam'))
    // 10/13 (Nic): what is owed = every live charge − what was collected on any
    // charge (a disputed pull's collections count only once GAM won the
    // dispute) + what was given back of a charge collected twice or collected
    // and voided. A card reader piece is never owed on the landlord's books.
    const r = (await client.query<{ owed: string }>(
      `WITH ch AS (SELECT c.id, c.amount, c.voided_at FROM landlord_gam_charges c WHERE c.landlord_id = $1 AND c.kind <> $2)
       SELECT (COALESCE((SELECT SUM(ch.amount) FROM ch WHERE ch.voided_at IS NULL), 0)
             - COALESCE((SELECT SUM(col.amount) FROM landlord_gam_charge_collections col JOIN ch ON ch.id = col.charge_id
                          WHERE NOT EXISTS (SELECT 1 FROM landlord_gam_debits dd
                                             WHERE dd.id = col.landlord_gam_debit_id
                                               AND dd.disputed_at IS NOT NULL AND dd.dispute_won_at IS NULL)), 0)
             + COALESCE((SELECT SUM(h.amount) FROM held_payout_items h JOIN ch ON ch.id::text = split_part(h.source_id, ':', -1)
                          WHERE h.landlord_id = $1 AND h.source_type = 'refund' AND h.amount > 0
                            AND (h.source_id LIKE 'gam_debit_dispute_won:%' OR h.source_id LIKE 'gam_charge_voided:%')), 0))::text AS owed`,
      [owner.landlordId, READER_PIECE_KIND])).rows[0]
    if (ledger === toCents(r.owed)) return []
    const waiting = waitingFor(await loadPendingScope(client, owner.landlordId), DUE_TO_GAM_RULE)
    return drift('p5_due_to_gam', ledger, toCents(r.owed), {}, severityOf(waiting))
  },
}

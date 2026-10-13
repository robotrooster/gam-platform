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
 *                                 card reader's pieces are left out while they
 *                                 wait on Nic (design Q11) — on BOTH sides:
 *                                 10/12 (Nic, ledger review) a batch or a bank
 *                                 pull that collected a piece still debits 2080
 *                                 (it collects every charge it carried), so what
 *                                 was collected on pieces is added back to the
 *                                 ledger side and reported on its own as
 *                                 'pending' (waiting on Q11), never as drift.
 *                                 10/13 (Nic): a bank pull the landlord's
 *                                 bank disputed collected nothing — its
 *                                 charges are owed again and its own posting
 *                                 credits 2080 back (payoutGamCharges) — so
 *                                 its collections count on neither side
 *
 * 10/12 (Nic, ledger review): a difference is 'pending' while a record that
 * posts to the account still waits to post (services/ledgerPending), else
 * drift. A reader piece's own waiting charge does not hold 2080 back (it is
 * left out of both sides).
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

/** What posts to Stripe in transit (1060) and to Due to GAM (2080). */
export const STRIPE_IN_TRANSIT_RULE: PendingRule = { types: ['transfer_intent', 'disbursement', 'instant_margin'] }
export const DUE_TO_GAM_RULE: PendingRule = { types: ['gam_charge', 'gam_debit', 'transfer_intent', 'pos_sale'] }

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
    const r = (await client.query<{ owed: string; pieces: string; piece_ids: string[] | null }>(
      // 10/13 (Nic): a disputed pull's collections are owed again — they count nowhere.
      `SELECT COALESCE((SELECT SUM(c.amount - COALESCE((SELECT SUM(col.amount) FROM landlord_gam_charge_collections col
                                                         WHERE col.charge_id = c.id
                                                           AND NOT EXISTS (SELECT 1 FROM landlord_gam_debits dd
                                                                            WHERE dd.id = col.landlord_gam_debit_id
                                                                              AND dd.disputed_at IS NOT NULL)), 0))
                          FROM landlord_gam_charges c
                         WHERE c.landlord_id = $1 AND c.voided_at IS NULL AND c.kind <> 'device_installment'), 0)::text AS owed,
              -- A reader piece collected by a sent batch or a bank pull that went through (and was not
              -- disputed: a disputed pull's own posting credits 2080 back): those debited 2080.
              COALESCE((SELECT SUM(col.amount) FROM landlord_gam_charge_collections col
                          JOIN landlord_gam_charges c ON c.id = col.charge_id
                         WHERE c.landlord_id = $1 AND c.kind = 'device_installment'
                           AND (EXISTS (SELECT 1 FROM platform_transfer_intents i
                                         WHERE i.id = col.platform_transfer_intent_id AND i.status = 'transferred' AND i.transferred_at IS NOT NULL)
                                OR EXISTS (SELECT 1 FROM landlord_gam_debits d
                                            WHERE d.id = col.landlord_gam_debit_id AND d.status = 'succeeded' AND d.settled_at IS NOT NULL
                                              AND d.disputed_at IS NULL))), 0)::text AS pieces,
              (SELECT array_agg(c.id::text) FROM landlord_gam_charges c
                WHERE c.landlord_id = $1 AND c.kind = 'device_installment') AS piece_ids`, [owner.landlordId])).rows[0]
    const pieces = toCents(r.pieces)
    const pieceIds = new Set(r.piece_ids ?? [])
    const out: LedgerFinding[] = []
    if (ledger + pieces !== toCents(r.owed)) {
      const waiting = waitingFor(await loadPendingScope(client, owner.landlordId), DUE_TO_GAM_RULE,
        s => s.type === 'gam_charge' && pieceIds.has(s.id))
      out.push(...drift('p5_due_to_gam', ledger + pieces, toCents(r.owed), {}, severityOf(waiting)))
    }
    if (pieces !== 0) {
      out.push({ check: 'p5_due_to_gam_reader_pieces', severity: 'pending', detail: {
        collected: pieces / 100,
        why: 'Card reader pieces collected from a payout or a bank pull: their charge waits on Nic (design Q11 — is the reader equipment the landlord owns, or an expense per piece?), so Due to GAM (2080) carries what was collected on them until the charge posts.',
      } })
    }
    return out
  },
}

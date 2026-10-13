/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE NIGHTLY TIE-OUT FOR "DUE FROM GAM" (1050)
 * (gam-ledger-design-2026-10-12 §8 table, row 1050; phases P4 + P5)
 *
 *   Nic 10/12: money GAM collected but has not yet paid out is "held by GAM"
 *   until the payout lands.
 *
 * 1050 Due from GAM: payable to you is everything GAM has collected for the
 * company and not yet sent on. Many sources move it — card and bank receipts
 * (P4 B1), GAM covering a bill (B10), paid-ahead money GAM held being used
 * (C1/C7/C10), refunds GAM sends (D4), money taken back (E1), the allocation's
 * fee and manager cuts (P5 G1), register card sales and booking deposits (F2,
 * F6), the held payout lines (G4) and the weekly batch that sends it (G2) — so
 * neither phase could tie it alone; this check is the integrate step's.
 *
 * It must equal what the next payouts would still pay, read from the payout
 * records themselves:
 *   + every owner share (user_balance_ledger allocation_owner_share) of the
 *     company's payments that no transferred batch has carried yet — not
 *     stamped, or stamped by a batch that has not been transferred;
 *   + every held payout line of the company (sales, stay deposits, refunds,
 *     chargebacks, deposit releases, paid-ahead draws, fees) no transferred
 *     batch has carried yet;
 *   + of a move-out's escrow settlement recorded for sending and not sent yet
 *     (a 'deposit_settlement' transfer, pending or failed), only the part that
 *     sits in 1050 — the paid-ahead money GAM held that the move-out used,
 *     never more than the transfer (the same figure the transfer takes out of
 *     1050 when it posts, payoutTransfer.gamHeldPaidAheadAtMoveOutSql); the
 *     rest of it is deposit money and waits in Deposits GAM holds (1070);
 *   10/12 (Nic, ledger review) — an owner share counts for the company that
 *     owned the property when it was split (its payouts carry it): after a
 *     sale, a tenant's late payment of the seller's bill sits in the buyer's
 *     1050 (design G6, Nic L17 — payoutAllocation);
 *   − what the company still owes back on a reversed payment (reversed less
 *     recovered, while the reversal is open), which the next batch nets.
 * Company level (the payout records carry the property, but a batch spreads
 * one transfer over them; the property split is the payout chain's own
 * business). While a record that moves 1050 still waits to post, a difference
 * is 'pending', never drift (services/ledgerPending: only such records, not
 * any waiting row of the company). Read on the nightly check's REPEATABLE READ
 * snapshot; never plugged.
 *
 * Also here, 'sold_property_receipts' (info): every split of a payment on a
 * property another company owned by then — held for review in both
 * companies' Suspense (1099) until an admin decides (Nic L17).
 */
import type { PoolClient } from 'pg'
import type { LedgerCheck, LedgerFinding } from './ledgerCheck'
import type { LedgerOwner } from './ledgerOwner'
import { loadPendingScope, waitingFor, severityOf, type PendingRule } from './ledgerPending'
import { gamHeldPaidAheadAtMoveOutSql } from './ledgerProjectors/payoutTransfer'
import { propertyOwnerAtSql } from './ledgerProjectors/payoutAllocation'

/** 10/12 (Nic, ledger review): what posts to Due from GAM (1050) — a difference is pending only while one of these waits. */
export const DUE_FROM_GAM_RULE: PendingRule = {
  types: ['remittance', 'credit_use', 'payment', 'payment_reversal', 'refund_part', 'allocation', 'held_item',
    'transfer_intent', 'pos_sale', 'pos_held', 'booking'],
  // A bill row moves 1050 itself only when GAM covered it (design B10).
  payment: p => p.flexpay,
}

const C = (expr: string) => `round((${expr}) * 100)::bigint`

/** The batch a stamp names has been transferred (a stamp no batch names is an older direct transfer: paid). */
const STAMP_PAID = (stampExpr: string) => `NOT EXISTS (
  SELECT 1 FROM platform_transfer_intents i
   WHERE i.status <> 'transferred'
     AND (${stampExpr} = 'intent:' || i.id::text OR ${stampExpr} = 'netted:' || i.id::text OR ${stampExpr} = i.stripe_transfer_id))`

export async function dueFromGamExpectedCents(client: PoolClient, landlordId: string): Promise<{
  shares: number; heldLines: number; escrow: number; recoveries: number; total: number
}> {
  const r = (await client.query<{ shares: string; held: string; escrow: string; recoveries: string }>(
    `SELECT
       COALESCE((SELECT ${C('sum(ubl.amount)')} FROM user_balance_ledger ubl JOIN payments p ON p.id = ubl.reference_id
                  WHERE ubl.type = 'allocation_owner_share' AND ubl.reference_type = 'payment'
                    AND COALESCE(${propertyOwnerAtSql('ubl.property_id', 'ubl.created_at')}, p.landlord_id) = $1
                    AND (ubl.stripe_transfer_id IS NULL OR NOT (${STAMP_PAID('ubl.stripe_transfer_id')}))), 0)::text AS shares,
       COALESCE((SELECT ${C('sum(h.amount)')} FROM held_payout_items h
                  WHERE h.landlord_id = $1
                    AND (h.payout_intent_id IS NULL
                         OR EXISTS (SELECT 1 FROM platform_transfer_intents i WHERE i.id = h.payout_intent_id AND i.status <> 'transferred'))), 0)::text AS held,
       COALESCE((SELECT ${C(`sum(LEAST(i.amount, ${gamHeldPaidAheadAtMoveOutSql('i.deposit_return_id')}))`)}
                   FROM platform_transfer_intents i
                  WHERE i.landlord_id = $1 AND i.purpose = 'deposit_settlement' AND i.status <> 'transferred'), 0)::text AS escrow,
       COALESCE((SELECT ${C('sum(pr.reversed_amount - pr.recovered_amount)')} FROM payment_reversals pr
                  WHERE pr.landlord_id = $1 AND pr.status <> 'resolved'
                    AND pr.recovery_status IN ('pending', 'scheduled_netting')), 0)::text AS recoveries`,
    [landlordId])).rows[0]
  const shares = Number(r?.shares ?? 0)
  const heldLines = Number(r?.held ?? 0)
  const escrow = Number(r?.escrow ?? 0)
  const recoveries = Number(r?.recoveries ?? 0)
  return { shares, heldLines, escrow, recoveries, total: shares + heldLines + escrow - recoveries }
}


export const dueFromGamCheck: LedgerCheck = {
  name: 'due_from_gam',
  async run(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]> {
    const id = owner.landlordId
    if (!id) return []
    const ledger = Number((await client.query<{ n: string }>(
      `SELECT COALESCE(${C('sum(debit - credit)')}, 0)::text AS n FROM ledger_posting_lines
        WHERE landlord_id = $1 AND account_role = 'due_from_gam'`, [id])).rows[0]?.n ?? 0)
    const e = await dueFromGamExpectedCents(client, id)
    if (ledger === e.total) return []
    const waiting = waitingFor(await loadPendingScope(client, id), DUE_FROM_GAM_RULE)
    return [{ check: 'due_from_gam', severity: severityOf(waiting), detail: {
      ledgerCents: ledger, expectedCents: e.total, differenceCents: ledger - e.total,
      ownerSharesNotPaidOut: e.shares, heldLinesNotPaidOut: e.heldLines, escrowNotSent: e.escrow, stillOwedBack: e.recoveries,
    } }]
  },
}

/**
 * 10/12 (Nic, L17): "sold property, tenant later pays the OLD owner's unpaid
 * bill: HOLD FOR REVIEW (admin decides each time)". Every split of a payment
 * on a property another company owned by then, for the seller and the buyer
 * alike — listed (info) on each night's run until an admin decides; the books
 * hold it in both companies' Suspense (1099, payoutAllocation).
 */
export const soldPropertyReceiptsCheck: LedgerCheck = {
  name: 'sold_property_receipts',
  async run(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]> {
    const id = owner.landlordId
    if (!id) return []
    const r = await client.query<{ split_id: string; payment_id: string; seller: string; buyer: string; owner_share: string; day: string }>(
      `SELECT s.id::text AS split_id, s.payment_id::text, s.landlord_id::text AS seller, x.owner_then::text AS buyer,
              s.owner_share::text, s.created_at::date::text AS day
         FROM allocation_splits s
         CROSS JOIN LATERAL (SELECT ${propertyOwnerAtSql('s.property_id', 's.created_at')} AS owner_then) x
        WHERE x.owner_then IS NOT NULL AND x.owner_then <> s.landlord_id AND s.owner_share <> 0
          AND (s.landlord_id = $1 OR x.owner_then = $1)
        ORDER BY s.created_at, s.id`, [id])
    return r.rows.map(x => ({ check: 'sold_property_receipts', severity: 'info' as const, detail: {
      splitId: x.split_id, paymentId: x.payment_id, sellerId: x.seller, buyerId: x.buyer, ownerShare: x.owner_share, day: x.day,
      why: 'A tenant paid the former owner\'s bill after the sale; the owner share went to the new owner. Held for review (Nic L17).',
    } }))
  },
}

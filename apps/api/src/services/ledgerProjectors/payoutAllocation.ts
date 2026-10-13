/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: HOW A PAYMENT GAM HELD WAS SPLIT
 * (gam-ledger-design-2026-10-12 §6 G1; Nic's 10/12 answers L18 and G5)
 *
 * Source 'allocation' = one allocation_splits row: how the money GAM held for
 * the landlord on one settled bill was split, stored as it was made
 * (services/allocation.executeRentAllocation; append-only). The receipt that
 * paid the bill put the whole of it in Due from GAM (1050, design B1); this
 * takes out what never reaches the owner, on the day of the split (the
 * property's calendar):
 *
 *   Dr Processing fees (5115)    the processing fee the landlord covers, as
 *                                withheld (landlord_fee_withheld)
 *   Dr Management fees (5080)    the PM company's cut and the manager's fee, as
 *                                paid (pm_paid + manager_paid)
 *   Cr Due from GAM (1050)       the two together — what stays in 1050 is the
 *                                owner share, paid out in the next batch
 *
 *   Nic L18 (manager fee bigger than the money GAM held: "BILL THE LANDLORD —
 *   the unpaid part is a bill the landlord owes the manager"):
 *   Dr Management fees (5080)    the cuts due that GAM held too little to pay
 *   Cr Accounts payable (2010)   (pm_fee_due − pm_paid) + (manager_fee_due −
 *                                manager_paid): the landlord owes it
 *
 * Nic G5 (a covered processing fee bigger than the payment): the part GAM held
 * nothing for (landlord_fee_uncovered) is billed to the landlord as a GAM
 * charge ('uncovered_processing_fee') and posts there (payoutGamCharges) —
 * never here, so it is counted once.
 *
 * GAM-supersedence and sublease markup leave the landlord's share at charge
 * time; how they post has no rule from Nic yet (design G1), so a split that
 * carries either waits with the reason (subleasing is shelved; supersedence
 * routes only while FlexDeposit's rollout is on).
 *
 * A SOLD PROPERTY (design G6; Nic 10/12, L17: "sold property, tenant later
 * pays the OLD owner's unpaid bill: HOLD FOR REVIEW (admin decides each
 * time)"). The bill stays the seller's (the split's company) — its receipt
 * closed the seller's receivable and put the money in the seller's Due from
 * GAM (B1) — but the owner share is paid to whoever owns the property when the
 * money is split (allocation.ts: the property's current owner), and the
 * buyer's weekly batch carries it out of the BUYER's Due from GAM (G2). So,
 * when the property's recorded transfers (property_transfers) say another
 * company owned it at the split:
 *   seller   Dr Suspense (1099) "held for review" / Cr Due from GAM (1050):
 *            the owner share GAM paid to the new owner, owed back to the seller
 *            until an admin decides;
 *   buyer    Dr Due from GAM (1050) / Cr Suspense (1099) "held for review":
 *            money of the former owner's bill paid to them.
 * Both companies show it in 1099 (listed for review by the nightly check,
 * services/ledgerDueFromGamCheck 'sold_property_receipts'), and each one's
 * 1050 ties to what its own payouts carry.
 */
import type { PoolClient } from 'pg'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { cr, dr, toCents, waitsOnRule, localDaySql, propertyTzSql } from './registerBookingPayoutKit'

/**
 * SQL: the company that owned property `propertyExpr` at `atExpr`, by its
 * recorded transfers (property_transfers) — NULL when it was never transferred
 * before then (then it is the row's own company). 10/12 (Nic, ledger review).
 */
export function propertyOwnerAtSql(propertyExpr: string, atExpr: string): string {
  return `(SELECT pt.to_landlord_id FROM property_transfers pt
            WHERE pt.property_id = ${propertyExpr} AND pt.transferred_at <= ${atExpr}
            ORDER BY pt.transferred_at DESC, pt.created_at DESC, pt.id DESC LIMIT 1)`
}

export const payoutAllocationProjector: LedgerProjector = {
  sourceType: 'allocation',
  ruleVersion: 1,

  async project(client: PoolClient, splitId: string): Promise<DesiredPosting[]> {
    const s = (await client.query<{
      landlord_id: string; property_id: string; payment_id: string
      landlord_fee_withheld: string; supersedence: string; sublease_markup: string
      pm_fee_due: string; pm_paid: string; manager_fee_due: string; manager_paid: string; owner_share: string
      owner_then: string | null; day: string
    }>(
      `SELECT s.landlord_id, s.property_id, s.payment_id, s.landlord_fee_withheld::text, s.supersedence::text,
              s.sublease_markup::text, s.pm_fee_due::text, s.pm_paid::text, s.manager_fee_due::text, s.manager_paid::text,
              s.owner_share::text, ${propertyOwnerAtSql('s.property_id', 's.created_at')} AS owner_then,
              ${localDaySql('s.created_at', propertyTzSql('s.property_id', 's.landlord_id'))} AS day
         FROM allocation_splits s WHERE s.id::text = $1`, [splitId])).rows[0]
    if (!s) return []
    if (toCents(s.supersedence) > 0 || toCents(s.sublease_markup) > 0) {
      throw waitsOnRule('This payment carried GAM-supersedence or sublease markup; how those post has no rule yet (design G1). It waits.')
    }
    const fee = toCents(s.landlord_fee_withheld)
    const pmPaid = toCents(s.pm_paid)
    const mgrPaid = toCents(s.manager_paid)
    const unpaid = Math.max(0, toCents(s.pm_fee_due) - pmPaid) + Math.max(0, toCents(s.manager_fee_due) - mgrPaid)
    const at = { propertyId: s.property_id, paymentId: s.payment_id }
    const lines = [
      ...dr('processing_fees', fee, { ...at, memo: 'Processing fee you cover, taken from the payment' }),
      ...dr('management_fees', pmPaid + mgrPaid, { ...at, memo: 'Management fee taken from the payment' }),
      ...cr('due_from_gam', fee + pmPaid + mgrPaid, { ...at, memo: 'Taken from the money GAM holds for you' }),
      ...dr('management_fees', unpaid, { ...at, memo: 'Management fee GAM held too little to pay' }),
      ...cr('accounts_payable', unpaid, { ...at, memo: 'Management fee you still owe the manager' }),
    ]
    const out: DesiredPosting[] = []
    // Nic L17 / design G6: the property belonged to another company when this
    // was split — its owner share went to them. Held for review on both books.
    const share = toCents(s.owner_share)
    const sold = !!s.owner_then && s.owner_then !== s.landlord_id && share !== 0
    if (sold) {
      lines.push(
        ...dr('suspense', share, { ...at, memo: 'Held for review: paid to the property\'s new owner after the sale' }),
        ...cr('due_from_gam', share, { ...at, memo: 'Owner share paid to the property\'s new owner' }),
      )
    }
    out.push({ owner: { landlordId: s.landlord_id }, intendedDate: s.day, memo: 'Fees taken from a payment', lines })
    if (sold) {
      out.push({ owner: { landlordId: s.owner_then! }, intendedDate: s.day, memo: 'A payment on the former owner\'s bill', lines: [
        ...dr('due_from_gam', share, { ...at, memo: 'Owner share of a payment on the former owner\'s bill' }),
        ...cr('suspense', share, { ...at, memo: 'Held for review: the former owner\'s money, paid to you after the sale' }),
      ] })
    }
    return out
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT s.id::text AS id, ${localDaySql('s.created_at', propertyTzSql('s.property_id', 's.landlord_id'))} AS day
         FROM allocation_splits s
        WHERE (s.landlord_id = $1 OR ${propertyOwnerAtSql('s.property_id', 's.created_at')} = $1)
          AND ($2::date IS NULL OR s.created_at >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

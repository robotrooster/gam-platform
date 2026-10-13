/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4, FAMILY E: MONEY TAKEN BACK AFTER
 * IT SETTLED (gam-ledger-design-2026-10-12 §6 E1-E3)
 *
 * E1 — a card dispute, an ACH unauthorized or a late ACH return
 * (payment_reversals, key `payment_reversal:<id>`, its own day). The dispute
 * handler (services/paymentReversal) writes one record per row the charge
 * paid, marks that row 'returned' and writes a fresh pending row for what the
 * tenant owes again (lost − GAM-first money; reversal_id names the record).
 * That fresh row is the receivable again, so this posting — not the row's own
 * charge (tenantCharges skips rows with reversal_id) — puts it back:
 *
 *   Dr receivables [the fresh row]    the fresh row's amount, counted as money
 *                                     received going BACK out (Received is
 *                                     negative that day)
 *   Cr 1050 Due from GAM              the same amount: the landlord gives back
 *                                     the whole money part, withheld from what
 *                                     GAM still holds or recovered from what was
 *                                     paid out (GAM keeps its fee; 5115 and 5080
 *                                     are never touched). For a deposit row GAM
 *                                     still holds: Cr 1070.
 * A row GAM-first money paid in full gets no fresh row and posts nothing; GAM's
 * own rows, the FlexPay pull and money GAM holds as paid-ahead (Nic L13) are
 * never on the landlord's book. A record reopening a row paid by disputed
 * paid-ahead money (the credit_spend shape) books the same way: the bill paid
 * from it was money received on the day it paid (tenantCredits C1), so the
 * reopened bill takes it back.
 *
 * E2 (Stripe's kept dispute fee) is a held payout item (phase P5, design G4).
 * E3 recovery: netting is inside the payout transfer (P5, G2); a re-payment of
 * the fresh row is an ordinary receipt (tenantReceipts B1/B3); an ACH pull has
 * no record of its completion yet (the pull executor waits on live keys) and a
 * write-off has no action yet (Nic L15 set who may write off; the action is
 * not built) — neither posts here.
 */
import type { PoolClient } from 'pg'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { Lines, rowDims, loadPaymentFacts, localDaySql, propertyTzSql, companyTzSql, isUuid } from './tenantShared'

export const TENANT_REVERSALS_RULE_VERSION = 1

export async function projectPaymentReversal(client: PoolClient, reversalId: string): Promise<DesiredPosting[]> {
  if (!isUuid(reversalId)) return []
  const pr = (await client.query<{ payment_id: string; new_row: string | null; finalized_before: boolean }>(
    `SELECT pr.payment_id,
            (SELECT np.id FROM payments np WHERE np.reversal_id = pr.id ORDER BY np.created_at, np.id LIMIT 1) AS new_row,
            EXISTS (SELECT 1 FROM payments op JOIN deposit_returns d ON d.lease_id = op.lease_id
                     WHERE op.id = pr.payment_id AND d.finalized_at IS NOT NULL AND d.finalized_at <= pr.created_at) AS finalized_before
       FROM payment_reversals pr WHERE pr.id = $1`, [reversalId])).rows[0]
  if (!pr || !pr.new_row) return []
  const facts = await loadPaymentFacts(client, [pr.payment_id, pr.new_row])
  const orig = facts.get(pr.payment_id)
  const fresh = facts.get(pr.new_row)
  if (!orig || !fresh || orig.exclusion || fresh.exclusion) return []
  const owedAgain = fresh.amountCents
  if (owedAgain === 0) return []
  const day = (await client.query<{ d: string }>(
    `SELECT ${localDaySql('pr.created_at', propertyTzSql('$2::uuid', 'pr.landlord_id'))} AS d FROM payment_reversals pr WHERE pr.id = $1`,
    [reversalId, fresh.propertyId])).rows[0]?.d
  if (!day) return []
  const gamHoldsDeposit = orig.type === 'deposit' && orig.depositCollectedBy !== 'landlord' && !pr.finalized_before
  const L = new Lines()
  L.dr('ar_tenants', owedAgain, { ...rowDims(fresh), reportCategory: fresh.category, cashEffect: 'in', memo: 'Payment taken back' })
  L.cr(gamHoldsDeposit ? 'deposits_gam_holds' : 'due_from_gam', owedAgain,
    { propertyId: fresh.propertyId, leaseId: gamHoldsDeposit ? fresh.leaseId : null, memo: 'Payment taken back' })
  return [{ owner: { landlordId: fresh.landlordId }, postingKind: 'charge', intendedDate: day,
    memo: 'A payment was disputed or returned', lines: L.lines }]
}

export const paymentReversalProjector: LedgerProjector = {
  sourceType: 'payment_reversal',
  ruleVersion: TENANT_REVERSALS_RULE_VERSION,
  project: (client, sourceId) => projectPaymentReversal(client, sourceId),
  async listSources(client, owner: LedgerOwner, opts): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string | null }>(
      `SELECT pr.id::text AS id, ${localDaySql('pr.created_at', companyTzSql('$1::uuid'))} AS day FROM payment_reversals pr
        WHERE (pr.landlord_id = $1 OR EXISTS (SELECT 1 FROM payments p WHERE p.id = pr.payment_id AND p.landlord_id = $1))
          AND ($2::date IS NULL OR pr.created_at >= ($2::date - 1))`, [owner.landlordId, opts.since ?? null])
    return r.rows.map(x => ({ id: x.id, day: x.day }))
  },
}

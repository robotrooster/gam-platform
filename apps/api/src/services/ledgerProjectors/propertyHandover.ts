/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: A PROPERTY SOLD TO ANOTHER COMPANY
 * (gam-ledger-design-2026-10-12 §6 G5)
 *
 * Source 'property_transfer' = one property_transfers row (services/
 * propertyTransfer: a property sold or moved to another GAM company). The
 * capture marks it for both the seller and the buyer.
 *
 * What moves at a sale: the live state — units, leases, the deposit records —
 * goes to the buyer; settled money history stays with the seller (the bills,
 * receipts and payouts keep the seller's company on every line). Design G5
 * hands over what the seller still owes the tenants on the moved leases:
 *   seller   Dr Security deposits payable (2020) / Dr Tenant prepayments (2050)
 *            Cr Deposits GAM holds (1070), or the cash it hands over
 *   buyer    the mirror: Dr 1070 or cash / Cr 2020 / Cr 2050
 *
 * A transfer that moved no lease and no deposit record hands nothing over and
 * posts nothing (production's one transfer, 8/28: Oak Park's Mountain View
 * property to its own company, 0 units, 0 leases, 0 deposits).
 *
 * One that moved leases or deposit records WAITS, named (design §4: projectors
 * refuse a missing fact): the transfer records only how many records moved
 * (property_transfers.moved), not the deposit and paid-ahead amounts handed
 * over per lease, so the handover cannot be rebuilt from the money records.
 * The transfer itself must record those amounts first (an open item for the
 * property-transfer lane). A tenant's later payment of the seller's old bill
 * is held for review by the allocation projector (design G6, Nic L17).
 */
import type { PoolClient } from 'pg'
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import { missingFact, localDaySql, companyTzSql } from './registerBookingPayoutKit'

export const propertyTransferProjector: LedgerProjector = {
  sourceType: 'property_transfer',
  ruleVersion: 1,

  async project(client: PoolClient, transferId: string): Promise<DesiredPosting[]> {
    const t = (await client.query<{ leases: string | null; deposits: string | null }>(
      `SELECT t.moved->>'leases' AS leases, t.moved->>'security_deposits' AS deposits
         FROM property_transfers t WHERE t.id::text = $1`, [transferId])).rows[0]
    if (!t) return []
    const leases = Number(t.leases ?? 0) || 0
    const deposits = Number(t.deposits ?? 0) || 0
    if (leases === 0 && deposits === 0) return []
    throw missingFact(
      `This property sale moved ${leases} lease(s) and ${deposits} deposit record(s) to the buyer, but the deposits and paid-ahead ` +
      'money handed over with them are not recorded with the sale, so the handover (design G5) cannot be posted yet.')
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT t.id::text AS id, ${localDaySql('t.transferred_at', companyTzSql('$1::uuid'))} AS day
         FROM property_transfers t
        WHERE (t.from_landlord_id = $1 OR t.to_landlord_id = $1)
          AND ($2::date IS NULL OR t.transferred_at >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}

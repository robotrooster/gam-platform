// S624 — assembling the shortlist for one inbound bank deposit.
//
// The ranking itself is pure and lives in services/bankDepositMatch.ts. This is
// the query around it: what is still owed to this landlord, and which tenants
// have claimed a deposit that could be this one.
//
// SCOPE IS THE SAFETY PROPERTY HERE. Only charges belonging to the SAME LANDLORD
// as the bank connection are ever considered. A tenant may rent from two
// landlords, and a deposit into landlord A's account must never be offered
// against a charge owed to landlord B — that is somebody else's rent, and
// settling it would take money out of one landlord's ledger to satisfy another.

import { query } from '../db'
import {
  matchDeposit, type OpenCharge, type TenantDeclaredDeposit, type DepositMatch,
} from './bankDepositMatch'
import { DECLARATION_DATE_WINDOW_DAYS } from './bankDepositMatch'

export interface DepositWithCandidates {
  transactionId: string
  amount: number
  postedDate: string
  description: string | null
  candidates: DepositMatch[]
}

/**
 * Open charges for one landlord, with the tenant's name for memo matching.
 *
 * `payments` rows that are pending (or failed, which is still owed) and belong
 * to a real lease. Late fees and the manual-payment fee itself are included: a
 * tenant catching up may well deposit rent plus last month's fee in one go, and
 * the subset-sum only finds that combination if the rows are here.
 */
async function openChargesFor(landlordId: string): Promise<OpenCharge[]> {
  const rows = await query<any>(
    `SELECT p.id, p.lease_id, p.tenant_id, p.type,
            p.amount::float AS amount,
            to_char(p.due_date,'YYYY-MM-DD') AS due_date,
            u.unit_number,
            TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,''))
              AS tenant_name
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN tenants t ON t.id = p.tenant_id
       JOIN users usr ON usr.id = t.user_id
      WHERE p.landlord_id = $1
        AND p.lease_id IS NOT NULL
        AND (p.status = 'pending' OR p.status = 'failed')
        AND p.amount > 0
        -- A unit in eviction hold cannot take a payment at all, so offering one
        -- would only produce a confirm that is refused downstream.
        AND u.payment_block IS NOT TRUE
      ORDER BY p.due_date`,
    [landlordId])
  return rows.map((r: any) => ({
    id: r.id, leaseId: r.lease_id, tenantId: r.tenant_id,
    tenantName: r.tenant_name || 'Tenant', unitNumber: r.unit_number,
    amount: Number(r.amount), dueDate: r.due_date, type: r.type,
  }))
}

/** Claims still waiting on a bank row, within reach of this posting date. */
async function declarationsFor(
  landlordId: string, postedDate: string,
): Promise<TenantDeclaredDeposit[]> {
  const rows = await query<any>(
    `SELECT id, lease_id, tenant_id, amount::float AS amount,
            to_char(declared_date,'YYYY-MM-DD') AS declared_date, method
       FROM tenant_declared_deposits
      WHERE landlord_id = $1 AND status = 'pending'
        AND declared_date BETWEEN ($2::date - $3::int) AND ($2::date + $3::int)`,
    [landlordId, postedDate, DECLARATION_DATE_WINDOW_DAYS])
  return rows.map((r: any) => ({
    id: r.id, leaseId: r.lease_id, tenantId: r.tenant_id,
    amount: Number(r.amount), declaredDate: r.declared_date, method: r.method,
  }))
}

/** Rank who could have paid one deposit. */
export async function candidatesForDeposit(
  txn: { id: string; landlord_id: string; amount: number; posted_date: string; description: string | null },
): Promise<DepositWithCandidates> {
  const [charges, declarations] = await Promise.all([
    openChargesFor(txn.landlord_id),
    declarationsFor(txn.landlord_id, txn.posted_date),
  ])
  return {
    transactionId: txn.id,
    amount: txn.amount,
    postedDate: txn.posted_date,
    description: txn.description,
    candidates: matchDeposit(
      { amount: txn.amount, postedDate: txn.posted_date, description: txn.description },
      charges,
      { declarations }),
  }
}

/**
 * Every unmatched inbound deposit for a landlord, each with its shortlist.
 *
 * Bounded: a landlord returning after months away has a long feed, and building
 * a shortlist per row is real work. The cap is on the QUERY, not silently on the
 * result — the caller reports how many were left.
 */
export async function unmatchedDepositsWithCandidates(
  landlordId: string, limit = 50,
): Promise<{ deposits: DepositWithCandidates[]; remaining: number }> {
  const rows = await query<any>(
    `SELECT id, landlord_id, amount::float AS amount,
            to_char(posted_date,'YYYY-MM-DD') AS posted_date, description,
            COUNT(*) OVER ()::int AS total
       FROM bank_transactions
      WHERE landlord_id = $1 AND status = 'needs_review' AND amount > 0
      ORDER BY posted_date DESC
      LIMIT $2`, [landlordId, limit])
  const total = rows[0]?.total ?? 0
  const deposits = await Promise.all(rows.map((r: any) => candidatesForDeposit(r)))
  return { deposits, remaining: Math.max(0, total - rows.length) }
}

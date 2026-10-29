/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P6: THE NIGHTLY TIE-OUT FOR MONEY OUT
 * (gam-ledger-design-2026-10-12 §8: "2010 = Σ unpaid balance of live
 * expenses (v_expense_balance)")
 *
 *   Nic: "within a minute (+ nightly tie-out check)"
 *
 * Accounts payable (2010) must equal what the company still owes, from the
 * money records themselves:
 *   + every live expense's unpaid part (amount − its live payments), but a
 *     manager's-cut bill (Nic L18) — its cost and its credit to 2010 are the
 *     split's (payoutAllocation)
 *   + the manager's and the PM company's cut each split held too little to
 *     pay ((fee due − paid), what the split posted to 2010)
 *   − the live payments toward those manager's-cut bills
 * A difference is 'pending' while an expense, a payment or a split still waits
 * to post (services/ledgerPending), else drift — never plugged.
 * The whole history is compared: a company whose books start after its first
 * bill needs its opening posting (design J1) for the totals to meet.
 */
import type { PoolClient } from 'pg'
import type { LedgerCheck, LedgerFinding } from '../ledgerCheck'
import type { LedgerOwner } from '../ledgerOwner'
import { toCents } from './registerBookingPayoutKit'
import { loadPendingScope, waitingFor, severityOf, type PendingRule } from '../ledgerPending'

/** What posts to Accounts payable (2010). */
export const ACCOUNTS_PAYABLE_RULE: PendingRule = { types: ['expense', 'expense_payment', 'allocation'] }

export const accountsPayableCheck: LedgerCheck = {
  name: 'accounts_payable',
  async run(client: PoolClient, owner: LedgerOwner): Promise<LedgerFinding[]> {
    const id = owner.landlordId
    if (!id) return []
    const ledger = toCents((await client.query<{ n: string }>(
      `SELECT COALESCE(SUM(credit - debit), 0)::text AS n FROM ledger_posting_lines
        WHERE landlord_id = $1 AND account_role = 'accounts_payable'`, [id])).rows[0]?.n)
    const expected = toCents((await client.query<{ n: string }>(
      `SELECT (
         COALESCE((SELECT sum(b.unpaid) FROM v_expense_balance b JOIN landlord_expenses e ON e.id = b.expense_id
                    WHERE b.landlord_id = $1 AND e.allocation_split_id IS NULL), 0)
       + COALESCE((SELECT sum(GREATEST(s.pm_fee_due - s.pm_paid, 0) + GREATEST(s.manager_fee_due - s.manager_paid, 0))
                     FROM allocation_splits s WHERE s.landlord_id = $1), 0)
       - COALESCE((SELECT sum(p.amount) FROM landlord_expense_payments p JOIN landlord_expenses e ON e.id = p.expense_id
                    WHERE e.landlord_id = $1 AND e.allocation_split_id IS NOT NULL AND p.voided_at IS NULL), 0))::text AS n`,
      [id])).rows[0]?.n)
    if (ledger === expected) return []
    const severity = severityOf(waitingFor(await loadPendingScope(client, id), ACCOUNTS_PAYABLE_RULE))
    return [{ check: 'accounts_payable', severity, detail: {
      ledgerCents: ledger, expectedCents: expected, differenceCents: ledger - expected,
    } }]
  },
}

export const P6_LEDGER_CHECKS: readonly LedgerCheck[] = [accountsPayableCheck]

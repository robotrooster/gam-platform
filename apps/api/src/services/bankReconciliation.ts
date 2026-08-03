// Bank reconciliation (S568, Nic) — landlords reconcile their bank statement
// against what GAM sent them, and categorize bank charges (which flow into the
// P&L as expenses). Manual for now (no bank feed until Plaid): the operator
// enters their statement balance + logs bank fees; GAM supplies the figure it
// actually disbursed to them so the difference is visible.
import { query, queryOne } from '../db'

const round2 = (n: number) => Math.round(n * 100) / 100

/** GAM-side figure + bank charges already logged for a period. */
export async function getReconciliationContext(landlordId: string, from: string, to: string) {
  const disb = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM disbursements
      WHERE landlord_id = $1 AND status = 'settled'
        AND target_date >= $2::date AND target_date <= $3::date`,
    [landlordId, from, to])
  const gamDisbursed = round2(parseFloat(disb?.total ?? '0'))

  const charges = await query<any>(
    `SELECT id, amount::float AS amount, description, vendor, expense_date, property_id
       FROM landlord_expenses
      WHERE landlord_id = $1 AND category = 'bank_fees' AND status = 'active'
        AND expense_date >= $2 AND expense_date <= $3
      ORDER BY expense_date DESC`, [landlordId, from, to])
  const bankChargesTotal = round2(charges.reduce((s, c) => s + Number(c.amount || 0), 0))

  return { gamDisbursed, bankCharges: charges, bankChargesTotal }
}

export async function createReconciliation(landlordId: string, input: {
  periodStart: string; periodEnd: string; statementBalance: number; accountId?: string | null
}) {
  const { gamDisbursed } = await getReconciliationContext(landlordId, input.periodStart, input.periodEnd)
  const bookBalance = gamDisbursed
  // `difference` is a generated column (statement_balance − book_balance) — don't insert it.
  const row = await queryOne<any>(
    `INSERT INTO bank_reconciliations
       (landlord_id, account_id, period_start, period_end, statement_balance, book_balance, status, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'completed',NOW()) RETURNING *`,
    [landlordId, input.accountId ?? null, input.periodStart, input.periodEnd,
     input.statementBalance.toFixed(2), bookBalance.toFixed(2)])
  return row
}

export async function listReconciliations(landlordId: string) {
  return query<any>(
    `SELECT id, period_start, period_end, statement_balance::float AS statement_balance,
            book_balance::float AS book_balance, difference::float AS difference, status, completed_at
       FROM bank_reconciliations
      WHERE landlord_id = $1 ORDER BY period_end DESC, created_at DESC`, [landlordId])
}

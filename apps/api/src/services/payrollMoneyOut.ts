/**
 * 10/12 (Nic) — GAM BOOKS, PHASE P7: WHAT A PAYROLL RUN LEAVES OWED BECOMES UNPAID EXPENSES
 * (gam-ledger-design-2026-10-12 §6 J3, §12; Nic 10/12 L5)
 *
 *   Nic, 10/12 (L5): money out is ONE record — the Expenses record. A bill is
 *   an unpaid expense, and filing a bank line creates or matches one.
 *
 * Approving a payroll run posts it (the payroll projector: wages and the
 * employer's taxes as expenses, the rest owed as payroll liabilities) and, in
 * the same transaction, creates what it leaves to pay as unpaid expenses on
 * the Expenses record, so the bank lines that pay them match them:
 *   - one per paycheck: the take-home pay (category "Payroll: take-home pay"),
 *     due the pay date — it clears Net pay payable;
 *   - one per payroll liability the run left owed (category "Payroll: taxes
 *     owed"): federal income tax withheld, Social Security and Medicare (both
 *     halves), federal unemployment, state income tax withheld, state
 *     unemployment, other deductions — each clears its own liability. No due
 *     date: when a payroll tax deposit is due depends on the company's deposit
 *     schedule, which GAM does not know.
 * payroll_run_expenses links each expense to the run (and paycheck) and names
 * the liability it clears (PAYROLL_EXPENSE_LIABILITY_ROLES). The expense's own
 * posting (phase P6, design I1) reads that link through
 * payrollLiabilityRolesOfExpenses and books Dr that liability / Cr Accounts
 * payable instead of the category's account — so "Payroll: taxes owed" clears
 * 2031 federal withholding, 2033 Social Security and Medicare … each on its own
 * account, not the 2030 parent. The link is written in the same transaction
 * as the expense and never changes (insert-only), so the expense's first
 * posting already sees it; it needs no ledger capture of its own.
 *
 * The expense itself is the Expenses lane's (services/landlordExpenses:
 * createMoneyOutExpense to create, voidLandlordExpense to void). Voiding the
 * run voids the expenses it created; it is refused while one of them has been
 * paid (one record per dollar out: a paid paycheck cannot belong to a run that
 * never happened — undo the payment first).
 */
import type { PoolClient } from 'pg'
import {
  PAYROLL_LIABILITY_PARTS, booksCents,
  type PayrollExpenseKind, type PayrollExpenseLiabilityRole,
} from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import { createMoneyOutExpense, voidLandlordExpense } from './landlordExpenses'

type Queryable = Pick<PoolClient, 'query'>

/** One unpaid expense a run leaves. Amounts in whole cents. */
export interface PayrollExpenseIntent {
  kind: PayrollExpenseKind
  /** The payroll liability it clears (payroll_run_expenses.liability_role). */
  liabilityRole: PayrollExpenseLiabilityRole
  /** The paycheck it pays (take-home pay only). */
  payrollRunLineId: string | null
  /** The Expenses record's category for it (BOOKS_DEFAULT_EXPENSE_CATEGORIES keys). */
  categoryKey: 'payroll_take_home' | 'payroll_taxes'
  cents: number
  expenseDate: string
  dueDate: string | null
  description: string
}

export interface PayrollRunForMoneyOut {
  id: string
  payDate: string
  lines: Array<{
    id: string; employeeName: string
    net: number | string; federal: number | string; state: number | string
    ss: number | string; medicare: number | string; employerSs: number | string; employerMedicare: number | string
    futa: number | string; suta: number | string; other: number | string
  }>
}

/**
 * What an approved run leaves to pay, in a stable order: each paycheck's
 * take-home pay, then one tax payment per liability (PAYROLL_LIABILITY_PARTS
 * order). Nothing for a $0 amount. The tax payments add up to exactly what the
 * payroll posting credits each liability (payrollRun projector).
 */
export function payrollExpenseIntents(run: PayrollRunForMoneyOut): PayrollExpenseIntent[] {
  const out: PayrollExpenseIntent[] = []
  for (const l of run.lines) {
    const net = booksCents(l.net)
    if (net > 0) {
      out.push({
        kind: 'payroll_net', liabilityRole: 'net_pay_payable', payrollRunLineId: l.id, categoryKey: 'payroll_take_home',
        cents: net, expenseDate: run.payDate, dueDate: run.payDate,
        description: `Take-home pay: ${l.employeeName}, paid ${run.payDate}`,
      })
    }
  }
  const sum = (f: (l: PayrollRunForMoneyOut['lines'][number]) => number) => run.lines.reduce((a, l) => a + f(l), 0)
  const owed: Record<string, number> = {
    payroll_federal_withholding: sum(l => booksCents(l.federal)),
    payroll_fica: sum(l => booksCents(l.ss) + booksCents(l.medicare) + booksCents(l.employerSs) + booksCents(l.employerMedicare)),
    payroll_futa: sum(l => booksCents(l.futa)),
    payroll_state_withholding: sum(l => booksCents(l.state)),
    payroll_suta: sum(l => booksCents(l.suta)),
    payroll_liabilities: sum(l => booksCents(l.other)),
  }
  for (const part of PAYROLL_LIABILITY_PARTS) {
    const cents = owed[part.role] ?? 0
    if (cents > 0) {
      out.push({
        kind: 'tax_payment', liabilityRole: part.role, payrollRunLineId: null, categoryKey: 'payroll_taxes',
        cents, expenseDate: run.payDate, dueDate: null,
        description: `${part.label}, payroll paid ${run.payDate}`,
      })
    }
  }
  return out
}

async function loadRun(client: Queryable, runId: string): Promise<PayrollRunForMoneyOut | null> {
  const run = (await client.query<{ id: string; pay_date: string }>(
    `SELECT id, pay_date::text AS pay_date FROM payroll_runs WHERE id = $1`, [runId])).rows[0]
  if (!run) return null
  const lines = (await client.query<any>(
    `SELECT l.id, trim(concat_ws(' ', e.first_name, e.last_name)) AS name, l.net_pay, l.federal_tax, l.state_tax,
            l.ss_tax, l.medicare_tax, l.employer_ss_tax, l.employer_medicare_tax, l.futa_tax, l.suta_tax,
            COALESCE(l.other_deductions, 0) AS other_deductions
       FROM payroll_run_lines l JOIN books_employees e ON e.id = l.employee_id
      WHERE l.run_id = $1 ORDER BY e.last_name, e.first_name, l.created_at, l.id`, [runId])).rows
  return {
    id: run.id, payDate: run.pay_date,
    lines: lines.map(l => ({
      id: l.id, employeeName: l.name || 'Employee', net: l.net_pay, federal: l.federal_tax, state: l.state_tax,
      ss: l.ss_tax, medicare: l.medicare_tax, employerSs: l.employer_ss_tax, employerMedicare: l.employer_medicare_tax,
      futa: l.futa_tax, suta: l.suta_tax, other: l.other_deductions,
    })),
  }
}

/**
 * Creates the unpaid expenses an approved run leaves, in the approving
 * transaction (`client`), and links each to the run (createMoneyOutExpense,
 * the Expenses record's way for a GAM feature to leave money owed).
 * Idempotent per run: a run that already has its links creates nothing.
 * Returns how many it created.
 */
export async function createPayrollMoneyOut(client: PoolClient, args: {
  runId: string; landlordId: string; createdBy: string | null
}): Promise<{ created: number }> {
  const already = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payroll_run_expenses WHERE payroll_run_id = $1`, [args.runId])).rows[0].n
  if (already > 0) return { created: 0 }
  const run = await loadRun(client, args.runId)
  if (!run) throw new AppError(404, 'Run not found')
  let created = 0
  for (const i of payrollExpenseIntents(run)) {
    const { id: expenseId } = await createMoneyOutExpense(client, {
      landlordId: args.landlordId, categoryKey: i.categoryKey, amount: i.cents / 100, expenseDate: i.expenseDate,
      dueDate: i.dueDate, description: i.description, createdBy: args.createdBy,
    })
    await client.query(
      `INSERT INTO payroll_run_expenses (landlord_id, payroll_run_id, payroll_run_line_id, expense_id, kind, liability_role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [args.landlordId, args.runId, i.payrollRunLineId, expenseId, i.kind, i.liabilityRole])
    created++
  }
  return { created }
}

/**
 * For the expense's posting (phase P6, design I1): the payroll liability each
 * of these expenses clears, for the ones a payroll run created. An expense not
 * in the map is an ordinary expense (its category decides its account).
 */
export async function payrollLiabilityRolesOfExpenses(
  client: Queryable, expenseIds: readonly string[],
): Promise<Map<string, PayrollExpenseLiabilityRole>> {
  const out = new Map<string, PayrollExpenseLiabilityRole>()
  if (!expenseIds.length) return out
  const r = await client.query<{ expense_id: string; liability_role: PayrollExpenseLiabilityRole }>(
    `SELECT expense_id, liability_role FROM payroll_run_expenses WHERE expense_id = ANY($1::uuid[])`, [expenseIds])
  for (const x of r.rows) out.set(x.expense_id, x.liability_role)
  return out
}

/** The live (not voided) expenses a run created. */
async function liveRunExpenses(client: Queryable, runId: string): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT e.id FROM payroll_run_expenses x JOIN landlord_expenses e ON e.id = x.expense_id
      WHERE x.payroll_run_id = $1 AND e.status = 'active' AND e.voided_at IS NULL
      ORDER BY x.created_at, x.id`, [runId])
  return r.rows.map(x => x.id)
}

/** Is the Expenses record's payments table in this database (phase P6)? */
async function hasExpensePayments(client: Queryable): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(
    `SELECT to_regclass('public.landlord_expense_payments') IS NOT NULL AS ok`)
  return !!r.rows[0]?.ok
}

/**
 * Why a run cannot be voided: one of the expenses it created has been paid (a
 * payment recorded on it, a bank line matched or filed against it). Read in
 * the voiding transaction, before anything changes. Null when nothing is paid.
 */
export async function payrollMoneyOutPaidRefusal(client: Queryable, runId: string): Promise<string | null> {
  const ids = await liveRunExpenses(client, runId)
  if (!ids.length) return null
  // A bank line filed or split against one (the bank feed's own links).
  let paid = (await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM landlord_expenses e
      WHERE e.id = ANY($1::uuid[])
        AND (e.bank_transaction_id IS NOT NULL OR EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.expense_id = e.id))`,
    [ids])).rows[0].n
  // A payment on the Expenses record (phase P6: landlord_expense_payments).
  if (!paid && await hasExpensePayments(client)) {
    paid = (await client.query<{ n: number }>(
      `SELECT count(DISTINCT p.expense_id)::int AS n FROM landlord_expense_payments p
        WHERE p.expense_id = ANY($1::uuid[]) AND p.voided_at IS NULL`, [ids])).rows[0].n
  }
  if (!paid) return null
  return 'This run\'s pay or taxes have already been paid (a payment is recorded against what it left to pay). Undo that payment on the Expenses or Bank page first, then void the run.'
}

/**
 * Voids the unpaid expenses a run created, on the Expenses record's own void,
 * in the run's voiding transaction (`client`) — the run and what it left owed
 * are voided together or not at all. Call payrollMoneyOutPaidRefusal first.
 */
export async function voidPayrollMoneyOut(client: PoolClient, args: { runId: string; landlordId: string }): Promise<number> {
  const ids = await liveRunExpenses(client, args.runId)
  // 10/12 review: the one way a run's bills are removed (voidLandlordExpense refuses them otherwise).
  for (const id of ids) await voidLandlordExpense(id, args.landlordId, { client, payrollRun: true })
  return ids.length
}

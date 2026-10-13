/**
 * 10/12 (Nic) — GAM BOOKS, PHASE P6: WHICH EXPENSES COUNT ON A PROFIT & LOSS
 *
 *   Nic, 10/12 (L5): money out is ONE record — every dollar out is an expense
 *   on the Expenses record — and the company's own categories say what each
 *   one was (each points at an account in its chart).
 *
 * So the Expenses record now holds money out that is NOT a cost of the
 * business: an owner draw (a category on an equity account), what a payroll
 * run left to pay (take-home pay and payroll taxes, on payroll's liabilities —
 * the wages themselves count through payroll), a purchase filed to an asset,
 * and the manager's cut GAM held too little to pay (Nic L18 — a real bill, but
 * its cost is the payout split's). Every reader that adds expenses into a
 * P&L, a report's net or a per-unit cost (gam-ledger-design-2026-10-12 §12
 * "live readers") filters with ONE predicate, liveExpenseSql, so no screen
 * counts a draw as a cost or a payroll check twice:
 *
 *   live (status 'active'), not a manager's-cut bill (allocation_split_id),
 *   and its category on the P&L on the expense's own date
 *   (books_category_on_pl_on — its account that day is an expense account; a
 *   row with no category reads as on it, as it always did).
 *
 * An unpaid bill counts on its date like any other expense (the reports count
 * an expense by its date, paid or not).
 *
 * THE REPAIR'S COST, ONCE (maintenanceCostNotBilledSql). A repair closed with a
 * cost used to reach the P&L only as "Maintenance" (maintenance_requests.
 * actual_cost). Nic L6: the cost can now be an unpaid bill on the Expenses
 * record too (landlord_expenses.maintenance_request_id). A reader that adds
 * the maintenance line beside entered expenses skips a repair whose bill is
 * live, so the cost counts once, on the bill. Both ship together (design §12:
 * the readers switch in the same deploy as, or before, any writer of the new
 * rows).
 */

/**
 * SQL predicate: this landlord_expenses row counts as a cost on a P&L.
 * `alias` is the row's table alias ('' for an unaliased table).
 */
export function liveExpenseSql(alias = 'e'): string {
  const a = alias ? `${alias}.` : ''
  // 10/12 review: judged by the category's account ON THE EXPENSE'S OWN DATE
  // (books_category_on_pl_on), the ledger's rule. Read by today's account, a
  // used category pointed at a balance-sheet account (Supplies → Equipment)
  // took every past expense under it off the P&L, closed months included,
  // while the ledger kept them — the two P&Ls disagreed.
  return `(${a}status = 'active' AND ${a}allocation_split_id IS NULL AND books_category_on_pl_on(${a}category_id, ${a}expense_date))`
}

/**
 * SQL predicate: this maintenance_requests row's actual_cost is NOT already
 * counted through a live bill for the repair. `alias` is the repair's alias.
 */
export function maintenanceCostNotBilledSql(alias = 'mr'): string {
  const a = alias ? `${alias}.` : ''
  return `NOT EXISTS (SELECT 1 FROM landlord_expenses mrb WHERE mrb.maintenance_request_id = ${a}id AND mrb.status = 'active')`
}

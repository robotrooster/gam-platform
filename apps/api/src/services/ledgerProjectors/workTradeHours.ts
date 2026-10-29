/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: WORK-TRADE EXTRA HOURS POST AS WHAT PAID THEM
 *
 * Paid extra work-trade hours (work_trade_extra_hours) are wages the landlord
 * pays a person, "Both" ways, and money out is ONE record (Nic L5). Every way
 * they are paid already has its own record, which posts:
 *   - marked paid by hand on the Work Trade page (check or cash): the PAID
 *     expense Mark paid records under "Work trade labor" (services/
 *     workTradeBooksPay recordWorkTradeHoursPaidByHand) — the 'expense' and
 *     'expense_payment' sources (design I1/I2);
 *   - sent to GAM Books as W-2 pay: the payroll run's paycheck line
 *     ('payroll_run', design J3);
 *   - sent to GAM Books as a 1099 contractor payment: the contractor expense
 *     and its payments ('expense' / 'expense_payment').
 * So the hours themselves post nothing — posting them too would count the same
 * dollars twice. Registered so the capture's marks on work_trade_extra_hours
 * drain instead of waiting forever (a month close's preflight counts what is
 * still waiting), and so a rebuild lists nothing for it.
 */
import type { DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'

export const workTradeHoursProjector: LedgerProjector = {
  sourceType: 'work_trade_hours',
  ruleVersion: 1,
  async project(): Promise<DesiredPosting[]> { return [] },
  async listSources(): Promise<LedgerSourceRef[]> { return [] },
}

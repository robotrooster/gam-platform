/**
 * Tool: get_profit_and_loss (landlord). The landlord's P&L for a year, or for
 * one month of it.
 *
 * S618 (Nic): "being able to call a report for P&L specifics is awesome."
 *
 * A THIN WRAPPER ON PURPOSE. computeLandlordPL in services/landlordPL.ts is the
 * single source of truth — the reports page and the Books app both compute from
 * it precisely so they cannot drift (S568, "detangle Books"). This calls the
 * same function with the same arguments, so the number the agent says out loud
 * is the number on the landlord's own reports page. Writing a second P&L query
 * here would have been faster and would have recreated, in the one place a
 * landlord is most likely to trust the answer, the exact class of bug found in
 * billing this session: three parts of the system with three ideas of the same
 * word.
 *
 * The definition it inherits, worth knowing when reading the reply:
 *   - deposits are a HELD LIABILITY, never income
 *   - GAM's platform and float fees are GAM's revenue, not the landlord's
 *   - expenses = platform fee + maintenance + lot rent + entered expenses
 *
 * WHAT IT CANNOT KNOW: an expense the landlord never entered. A portfolio with
 * no expenses on file will show net = income, and the reply says so rather than
 * calling it profit.
 *
 * Hard-scoped to actor.profileId. Read-only.
 */

import { computeLandlordPL } from '../../landlordPL'
import { periodMonths } from '../../platformFee'
import type { AgentTool, AgentActor } from './types'

const money = (n: number) => Math.round(n * 100) / 100

export const getProfitAndLoss: AgentTool = {
  name: 'get_profit_and_loss',
  description:
    'The landlord’s profit and loss — income broken down (rent, fees, utilities, home sales, other) ' +
    'against expenses (GAM platform fee, maintenance, lot rent, their own entered expenses), and ' +
    'the net. Use for "what did I make", "show me my P&L", "what were my expenses", "how much did ' +
    'I bring in last year", "am I profitable". Defaults to the current year; pass month for one ' +
    'month. Same figures as their reports page. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      year: { type: 'integer', description: 'Calendar year (default: this year).' },
      month: { type: 'integer', description: 'Month 1-12 for a single month. Omit for the whole year.' },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const now = new Date()
    const rawYear = Number(args.year)
    const year = Number.isFinite(rawYear) && rawYear > 2000 && rawYear < 2100
      ? Math.trunc(rawYear) : now.getUTCFullYear()
    const rawMonth = Number(args.month)
    const month = Number.isFinite(rawMonth) && rawMonth >= 1 && rawMonth <= 12
      ? Math.trunc(rawMonth) : null

    const start = month
      ? `${year}-${String(month).padStart(2, '0')}-01`
      : `${year}-01-01`
    const end = month
      ? new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)   // last day of that month
      : `${year}-12-31`

    const pl = await computeLandlordPL(actor.profileId, start, end, periodMonths(year, month))

    const noExpensesEntered = pl.expenses.enteredExpenses === 0

    return {
      ok: true,
      period: month ? `${year}-${String(month).padStart(2, '0')}` : String(year),
      from: start,
      to: end,
      income: {
        rent: money(pl.gross.rent),
        feesAndLateFees: money(pl.gross.fees),
        utilities: money(pl.gross.utilities),
        homeSales: money(pl.gross.homeSale),
        otherIncome: money(pl.gross.otherIncome),
        other: money(pl.gross.other),
        total: money(pl.gross.total),
      },
      expenses: {
        gamPlatformFee: money(pl.expenses.platformFee),
        maintenance: money(pl.expenses.maintenance),
        lotRent: money(pl.expenses.lotRent),
        theirOwnEnteredExpenses: money(pl.expenses.enteredExpenses),
        total: money(pl.expenses.total),
      },
      net: money(pl.net),
      // Deposits are money they hold, not money they made. Stated separately so
      // the agent never folds it into income.
      depositsHeld: money(pl.depositsHeld),
      depositsNote:
        'Deposits are money being HELD for tenants, not income. Never add them to what they made.',
      ...(noExpensesEntered ? {
        caveat:
          'No expenses have been entered by this landlord for the period, so "net" is income minus ' +
          'GAM fees and platform-recorded costs only. Say plainly that it is not their true profit ' +
          'until they record their own costs — do not present it as profit.',
      } : {}),
      note:
        'These are the same figures as the landlord’s reports page — they come from the shared ' +
        'definition, not a separate calculation. Report the categories given; do not compute ' +
        'margins, per-property splits or forecasts that are not here.',
    }
  },
}

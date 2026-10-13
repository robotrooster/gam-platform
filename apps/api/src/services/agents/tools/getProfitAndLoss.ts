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
 *   - 10/12 (Nic): "NO Money received / Money billed toggle anywhere — show
 *     Charged, Received and Owed side by side." (L2) "Received leads." The
 *     answer carries all three columns and the net on each money column; the
 *     old `basis` choice is gone (a stale one passed in is ignored).
 *   - 10/12 (ledger P8): once the company's books are live the same function
 *     reads the ledger: Owed is then what tenants still owed at the period's
 *     end, `howTheyTie` says how it got there, and the expenses come as paid
 *     (beside Received) and incurred (beside Charged).
 *
 * WHAT IT CANNOT KNOW: an expense the landlord never entered. A portfolio with
 * no expenses on file will show net = income, and the reply says so rather than
 * calling it profit.
 *
 * Hard-scoped to actor.profileId. Read-only.
 */

import { computeLandlordPL } from '../../landlordPL'
import { landlordExpensesTotal } from '../../landlordExpenses'
import { periodMonths } from '../../platformFee'
import type { AgentTool, AgentActor } from './types'
import { resolveActorCompany, COMPANY_PARAM } from './companyScope'
import { todayIn } from '../../../lib/timezone'

const money = (n: number) => Math.round(n * 100) / 100

export const getProfitAndLoss: AgentTool = {
  name: 'get_profit_and_loss',
  description:
    'The landlord’s profit and loss — income Received, Charged and Owed (rent, fees, utilities, home ' +
    'sales, other; Received first) against expenses, and the net on each. Use for "what did I make", "show me my P&L", "what were my expenses", "how much did ' +
    'I bring in last year", "am I profitable". Defaults to the current year; pass month for one ' +
    'month. Same figures as their reports page.\n' +
    'S630: THIS is where profit, income and expenses come from — every landlord has them from their ' +
    'property data. GAM Books is a separate optional module and is never the answer to a P&L ' +
    'question. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      ...COMPANY_PARAM,
      year: { type: 'integer', description: 'Calendar year (default: this year).' },
      month: { type: 'integer', description: 'Month 1-12 for a single month. Omit for the whole year.' },
    },
  },
  audiences: ['landlord'],
  async execute(args, actor: AgentActor) {
    const rawYear = Number(args.year)
    // S654: "this year" by the Phoenix calendar. The UTC year turns over at 5 pm
    // on New Year's Eve here, so the evening answer was next year's empty P&L.
    const year = Number.isFinite(rawYear) && rawYear > 2000 && rawYear < 2100
      ? Math.trunc(rawYear) : Number(todayIn(null).slice(0, 4))
    const rawMonth = Number(args.month)
    const month = Number.isFinite(rawMonth) && rawMonth >= 1 && rawMonth <= 12
      ? Math.trunc(rawMonth) : null

    const start = month
      ? `${year}-${String(month).padStart(2, '0')}-01`
      : `${year}-01-01`
    const end = month
      ? new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)   // last day of that month
      : `${year}-12-31`

    // S634: a P&L belongs to ONE company — separate books, separate bank, its
    // own return. Adding two together is a figure that is true of nothing, so
    // the account names which when it owns several.
    const company = await resolveActorCompany(actor, (args as any).company)
    if (!company.ok) return { ok: false, error: company.error }
    const pl = await computeLandlordPL(company.landlordId, start, end, periodMonths(year, month))
    const v = pl.view

    // 10/12 (Nic, ledger P8 integration): on the books "every other expense
    // account" also holds costs GAM records itself (the bank cost of collecting
    // GAM's fees, work-trade hours booked as labor), so whether THEY entered any
    // expense is read from their Expenses record, the same in both modes — the
    // copy of production showed Oak Park's September with $6 there and none entered.
    const fromBooks = v.source === 'ledger'
    const enteredByThem = fromBooks ? await landlordExpensesTotal(company.landlordId, start, end) : pl.expenses.enteredExpenses
    const noExpensesEntered = enteredByThem === 0

    return {
      ok: true,
      company: company.name,
      period: month ? `${year}-${String(month).padStart(2, '0')}` : String(year),
      from: start,
      to: end,
      // 10/12 (Nic, L2): Received leads; Charged and Owed beside it.
      income: {
        received: money(v.received),
        charged: money(v.charged),
        owed: money(v.owed),
        rent: money(pl.gross.rent),
        feesAndLateFees: money(pl.gross.fees),
        utilities: money(pl.gross.utilities),
        homeSales: money(pl.gross.homeSale),
        otherIncome: money(pl.gross.otherIncome),
        other: money(pl.gross.other),
        // Every line in the three columns, labeled as the reports page labels them.
        lines: v.lines.map(l => ({ label: l.label, received: money(l.received), charged: money(l.charged), owed: money(l.owed) })),
      },
      columns: 'Received = money on the day it arrived. Charged = bills in the month they were due, less credits. ' +
        (v.source === 'ledger' ? 'Owed = what tenants still owed at the end of the period.' : 'Owed = what is still unpaid of those bills today.'),
      howTheyTie: v.tieText,
      expenses: {
        gamPlatformFee: money(pl.expenses.platformFee),
        maintenance: money(pl.expenses.maintenance),
        lotRent: money(pl.expenses.lotRent),
        // On the books this line is every other expense account (what they
        // entered and what GAM records for them), named one by one below.
        ...(fromBooks
          ? { otherExpenses: money(pl.expenses.enteredExpenses), enteredByThem: money(enteredByThem) }
          : { theirOwnEnteredExpenses: money(pl.expenses.enteredExpenses) }),
        // 10/11: in the total; listed so the lines add up to it.
        paymentProcessingFees: money(pl.expenses.processingFees),
        // 10/12 (G10): in the total too — card fees guests got back with refunds.
        cardFeesRefunded: money(pl.expenses.cardFeesRefunded),
        total: money(pl.expenses.total),
        // 10/12 (ledger P8): on the books, what was paid in the period (beside Received).
        ...(pl.expenses.cashTotal !== undefined ? { paidInPeriod: money(pl.expenses.cashTotal) } : {}),
        // 10/12 (ledger P8): each expense account, incurred and paid.
        ...(fromBooks && pl.expenses.byAccount ? {
          byAccount: pl.expenses.byAccount.map(a => ({ account: a.name, incurred: money(a.incurred), paid: money(a.paid) })),
        } : {}),
      },
      net: { received: money(pl.nets.received), charged: money(pl.nets.charged) },
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

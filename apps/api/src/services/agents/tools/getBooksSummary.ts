/**
 * Tool: get_books_summary (landlord read).
 *
 * A plain-language profit-and-loss snapshot from GAM Books for the
 * landlord's OWN ledger — total income, total expenses, net, and the top
 * income/expense categories for a period. Hard-scoped to
 * landlord_id = actor.profileId on BOTH the chart of accounts and the
 * journal entries. Mirrors the period math of GET /api/books/reports/pl,
 * but never that route's admin "all landlords" (landlord_id IS NULL) path —
 * the agent always scopes to the one calling landlord.
 *
 * 10/12 (Nic, ledger P8): once the company's books are live, the summary reads
 * the ledger — every posting, the automatic ones and the bookkeeper's journal
 * entries — the same figures as the Books P&L (services/ledgerReports
 * ledgerProfitAndLoss). Received leads (L2): income received and expenses
 * paid in the period, with Charged and expenses incurred beside them. Before
 * that, the journal entries as before.
 */

import { query } from '../../../db'
import { ledgerReportsLive, ledgerProfitAndLoss } from '../../ledgerReports'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'
import { todayIn, addDaysTo, monthStartOf } from '../../../lib/timezone'

type Period = 'this_month' | 'last_month' | 'this_year' | 'last_year'
const PERIODS: Period[] = ['this_month', 'last_month', 'this_year', 'last_year']

// S654: every window is read off today's Phoenix date (the database's
// CURRENT_DATE zone) with plain calendar math. "To date" used to end on the UTC
// date, which is tomorrow after 5 pm here — and next month or next year on the
// last evening of one.
function periodRange(period: Period): { start: string; end: string; label: string } {
  const today = todayIn(null)
  const y = Number(today.slice(0, 4))
  const thisMonth = monthStartOf(today)
  switch (period) {
    case 'this_month':
      return { start: thisMonth, end: today, label: 'this month' }
    case 'last_month': {
      // The day before the 1st is the last day of the previous month.
      const lastMonthEnd = addDaysTo(thisMonth, -1)
      return { start: monthStartOf(lastMonthEnd), end: lastMonthEnd, label: 'last month' }
    }
    case 'last_year':
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31`, label: `last year (${y - 1})` }
    case 'this_year':
    default:
      return { start: `${y}-01-01`, end: today, label: `this year (${y} to date)` }
  }
}

interface AcctRow { code: string; name: string; period_amount: string }

export const getBooksSummary: AgentTool = {
  name: 'get_books_summary',
  description:
    // S630 (Nic): "that is flat wrong. We do a bunch of property reporting
    // already without having a separate books account." This tool described
    // itself as "a profit-and-loss snapshot" and listed the same questions as
    // get_profit_and_loss, so the model reached for it on "show me my profit and
    // loss" — and answered a landlord who has full portfolio reporting with
    // "there's nothing to summarize, set up GAM Books". GAM Books is the OPTIONAL
    // deeper ledger (tax set-aside, payroll); it is not where P&L comes from.
    'The landlord’s GAM BOOKS ledger only — the optional bookkeeping module they may not have set ' +
    'up. Use ONLY when they name GAM Books, or ask about bookkeeping accounts, journal entries, ' +
    'payroll or tax set-aside.\n' +
    'DO NOT use this for profit and loss, income, expenses, or "how did I do" — every landlord has ' +
    'those from their property data whether or not GAM Books exists, and get_profit_and_loss is ' +
    'where they come from. Answering a P&L question from here tells a landlord to set up ' +
    'bookkeeping they do not need. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: PERIODS,
        description: 'Reporting window. Defaults to this_year (year to date).',
      },
    },
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const period: Period = PERIODS.includes(args.period as Period) ? (args.period as Period) : 'this_year'
    const { start, end, label } = periodRange(period)
    const round2 = (n: number) => Math.round(n * 100) / 100

    // 10/12 (Nic, ledger P8): the books themselves, once they are live.
    const ids = actorLandlordIds(actor)
    if (await ledgerReportsLive(ids)) {
      const pl = await ledgerProfitAndLoss({ landlordIds: ids }, start, end, label)
      const top = (rows: Array<{ name: string; amount: number }>) => rows
        .filter(r => r.amount !== 0).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 5)
        .map(r => ({ category: r.name, amount: round2(r.amount) }))
      return {
        ok: true,
        period: label,
        note: pl.view.received === 0 && pl.view.charged === 0 && pl.expenses.incurred === 0
          ? `No money posted to the books for ${label}.` : undefined,
        totalIncome: pl.view.received,
        totalExpenses: pl.expenses.paid,
        netIncome: pl.nets.received,
        charged: { income: pl.view.charged, expensesIncurred: pl.expenses.incurred, net: pl.nets.charged },
        owedAtEnd: pl.view.owed,
        columns: 'Income received and expenses paid in the period lead; charged (bills by due month) and incurred beside them.',
        topIncome: top(pl.incomeAccounts.map(a => ({ name: a.name, amount: a.charged }))),
        topExpenses: top(pl.expenses.rows.map(a => ({ name: a.name, amount: a.incurred }))),
      }
    }

    // Income = credits − debits; expenses = debits − credits, over posted
    // journal entries in the window. Both the accounts and the entries are
    // bound to the landlord, so cross-landlord ledgers can't leak in.
    //
    // 10/11: the same join shape as the Books P&L (routes/books.ts periodSql),
    // so the assistant quotes the figures that page shows. The date, posted
    // and owner tests sat on a LEFT JOIN to journal_entries while SUM read
    // journal_entry_lines, so every line of the account was summed: voided
    // entries, any date, outside the period. And `ba.active = TRUE` dropped a
    // deactivated account that still had activity in the period.
    const periodSql = (type: 'income' | 'expense', amount: string) =>
      `SELECT ba.code, ba.name, COALESCE(SUM(${amount}), 0) AS period_amount
         FROM books_accounts ba
         LEFT JOIN (journal_entry_lines jel
                    JOIN journal_entries je ON je.id = jel.entry_id
                     AND je.date BETWEEN $2 AND $3
                     AND je.status = 'posted'
                     AND je.landlord_id = ANY($1::uuid[]))
           ON jel.account_id = ba.id
        WHERE ba.type = '${type}' AND ba.landlord_id = ANY($1::uuid[])
        GROUP BY ba.id
       HAVING ba.active OR COALESCE(SUM(${amount}), 0) <> 0
        ORDER BY ba.code`
    const income = await query<AcctRow>(periodSql('income', 'jel.credit - jel.debit'),
      [actorLandlordIds(actor), start, end])
    const expenses = await query<AcctRow>(periodSql('expense', 'jel.debit - jel.credit'),
      [actorLandlordIds(actor), start, end])

    const sum = (rows: AcctRow[]) => rows.reduce((s, a) => s + (Number(a.period_amount) || 0), 0)
    const topN = (rows: AcctRow[]) =>
      rows
        .map((r) => ({ category: r.name, amount: round2(Number(r.period_amount) || 0) }))
        .filter((r) => r.amount !== 0)
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, 5)

    const totalIncome = sum(income)
    const totalExpenses = sum(expenses)
    const hasAccounts = income.length > 0 || expenses.length > 0

    return {
      ok: true,
      period: label,
      note: !hasAccounts
        ? 'No bookkeeping accounts are set up yet — there’s nothing to summarize. Set up GAM Books to start tracking income and expenses.'
        : totalIncome === 0 && totalExpenses === 0
          ? `No posted bookkeeping activity for ${label}.`
          : undefined,
      totalIncome: round2(totalIncome),
      totalExpenses: round2(totalExpenses),
      netIncome: round2(totalIncome - totalExpenses),
      topIncome: topN(income),
      topExpenses: topN(expenses),
    }
  },
}

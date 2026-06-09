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
 */

import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

type Period = 'this_month' | 'last_month' | 'this_year' | 'last_year'
const PERIODS: Period[] = ['this_month', 'last_month', 'this_year', 'last_year']

function periodRange(period: Period): { start: string; end: string; label: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const iso = (d: Date) => d.toISOString().split('T')[0]
  switch (period) {
    case 'this_month':
      return { start: iso(new Date(y, m, 1)), end: iso(now), label: 'this month' }
    case 'last_month':
      // day 0 of this month = last day of previous month.
      return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 0)), label: 'last month' }
    case 'last_year':
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31`, label: `last year (${y - 1})` }
    case 'this_year':
    default:
      return { start: `${y}-01-01`, end: iso(now), label: `this year (${y} to date)` }
  }
}

interface AcctRow { code: string; name: string; period_amount: string }

export const getBooksSummary: AgentTool = {
  name: 'get_books_summary',
  description:
    'A profit-and-loss snapshot from GAM Books for the landlord’s own ledger — total income, total ' +
    'expenses, net income, and the top income/expense categories for a period. Use for “how did I do ' +
    'last month?”, “what are my biggest expenses this year?”, or “what’s my net income?”. Read-only.',
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

    // Income = credits − debits; expenses = debits − credits, over posted
    // journal entries in the window. Both the accounts and the entries are
    // bound to the landlord, so cross-landlord ledgers can't leak in.
    const income = await query<AcctRow>(
      `SELECT ba.code, ba.name, COALESCE(SUM(jel.credit - jel.debit), 0) AS period_amount
         FROM books_accounts ba
         LEFT JOIN journal_entry_lines jel ON jel.account_id = ba.id
         LEFT JOIN journal_entries je ON je.id = jel.entry_id
           AND je.date BETWEEN $2 AND $3 AND je.status = 'posted' AND je.landlord_id = $1
        WHERE ba.type = 'income' AND ba.active = TRUE AND ba.landlord_id = $1
        GROUP BY ba.id ORDER BY ba.code`,
      [actor.profileId, start, end]
    )
    const expenses = await query<AcctRow>(
      `SELECT ba.code, ba.name, COALESCE(SUM(jel.debit - jel.credit), 0) AS period_amount
         FROM books_accounts ba
         LEFT JOIN journal_entry_lines jel ON jel.account_id = ba.id
         LEFT JOIN journal_entries je ON je.id = jel.entry_id
           AND je.date BETWEEN $2 AND $3 AND je.status = 'posted' AND je.landlord_id = $1
        WHERE ba.type = 'expense' AND ba.active = TRUE AND ba.landlord_id = $1
        GROUP BY ba.id ORDER BY ba.code`,
      [actor.profileId, start, end]
    )

    const round2 = (n: number) => Math.round(n * 100) / 100
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

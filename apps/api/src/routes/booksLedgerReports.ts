/**
 * 10/12 (Nic) — GAM BOOKS, PHASE P8: THE BOOKS STATEMENTS READ THE LEDGER
 * (gam-ledger-design-2026-10-12 §10, P8)
 *
 *   Nic, 10/12: "NO Money received / Money billed toggle anywhere — show
 *   Charged, Received and Owed side by side." (L2) "Received leads."
 *
 * Registered on the Books router (routes/books.ts) AHEAD of its older report
 * routes. For a landlord company whose books are live (services/ledgerReports
 * ledgerReportsLive: a start date and a finished rebuild) these answer from
 * the ledger; for any other company — and for an admin's all-landlords view
 * or a business's books — the P&L, balance sheet and cash flow pass to the
 * older routes behind them (next()), so nothing changes for a company until
 * its books are live:
 *
 *   GET /reports/pl              the P&L: income by category in Received,
 *                                Charged and Owed with the proof strip;
 *                                expenses by account, paid and incurred; the
 *                                net on each money column
 *   GET /reports/balance-sheet   as of a day (?asOf), retained earnings computed
 *   GET /reports/cash-flow       money in and out of the company's cash, by
 *                                operating / investing / financing
 * And, on the ledger only (a company not yet live gets { live: false, reason }):
 *   GET /reports/trial-balance   per account: opening, debits, credits, closing
 *                                — the whole company, one property
 *                                (?property=<id>) or the company's own lines
 *                                (?property=company)
 *   GET /reports/general-ledger  one account's register with a running
 *                                balance and the record behind every line
 *                                (?accountId, ?showCorrections=1; a page of
 *                                lines at a time: ?offset, ?limit)
 *   GET /reports/money-out       Incurred / Paid / Unpaid by category, money
 *                                out that is not a cost, unpaid by vendor
 *   GET /reports/receivables     what tenants owed on a day (?asOf), by
 *                                household and property, aged by due date
 *   GET /reports/ledger-status   whether the company's reports read the ledger
 *
 * WHO SEES WHAT (lib/bookkeeperScope; routes/books.ts BOOKS_LEDGER gates the
 * paths). The P&L, money out and cash flow are company reports: a
 * bookkeeper's property money is their properties' (their former ones up to
 * the day each left) unless the owner ticked "Company reports show the whole
 * company" (BK2). The balance sheet, trial balance and general ledger are the
 * whole-company ledger (the company-wide box, or "May use the whole-company
 * ledger", BK1): the whole company, a sold property they never kept hidden
 * (BK3). A team member assigned to some properties is refused every one of
 * them in plain words (refuseScopedStaff). Owed — a grand total of what
 * tenants owe — is left out for a viewer who sees no grand totals
 * (decisions #25, viewForViewer).
 *
 * Read-only: no route here writes anything (no agent action needed).
 */
import type { Request, Router } from 'express'
import { requireBooksRead } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { bookkeeperScopesOf, requestScopeOf, type PropertyCutoff } from '../lib/bookkeeperScope'
import { todayIn } from '../lib/timezone'
import { seesGrandTotals } from '../services/openBalances'
import { MONEY_COLUMNS, MONEY_COLUMN_LABEL, MONEY_COLUMN_NOTE_LEDGER } from '@gam/shared'
import {
  ledgerReportsLive, ledgerNotLiveReason, ledgerProfitAndLoss, ledgerBalanceSheet, ledgerTrialBalance,
  ledgerGeneralLedger, ledgerCashFlow, ledgerMoneyOut, ledgerReceivables, AGING_BUCKET_LABEL, type LedgerScope,
} from '../services/ledgerReports'
import { refuseScopedStaff, viewForViewer } from './reports'

export interface BooksLedgerReportDeps {
  /** routes/books ownerScope: the company whose books are open (null id = an admin's every landlord). */
  ownerScope: (user: any) => { col: 'landlord_id' | 'business_id'; id: string | null }
  /** routes/books companyReportPropertyScope: a bookkeeper's property money in a company report (BK2). */
  companyReportPropertyScope: (user: any) => Promise<{ propertyIds: string[] | null; cutoffs: PropertyCutoff[] }>
}

/** 10/12 (Nic, ledger P8): what each money column counts on the ledger (packages/shared MONEY_COLUMN_NOTE_LEDGER). */
const LEDGER_COLUMNS_META = MONEY_COLUMNS.map(c => ({ key: c, label: MONEY_COLUMN_LABEL[c], note: MONEY_COLUMN_NOTE_LEDGER[c] }))

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The report's days: ?startDate / ?endDate, this calendar year to today (Phoenix) by default. */
function periodOf(req: Request): { start: string; end: string } {
  const today = todayIn(null)
  const start = String(req.query.startDate ?? `${today.slice(0, 4)}-01-01`)
  const end = String(req.query.endDate ?? today)
  if (!DAY.test(start) || !DAY.test(end)) throw new AppError(400, 'Choose the report dates.')
  if (start > end) throw new AppError(400, 'The start date is after the end date.')
  return { start, end }
}

/** The period's name in the proof strip ("Jan 1, 2026 to Oct 12, 2026"). */
function periodLabel(start: string, end: string): string {
  const w = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  }
  return `${w(start)} to ${w(end)}`
}

/**
 * The whole-company ledger's scope (balance sheet, trial balance, general
 * ledger, the chart's balances): the whole company; for a bookkeeper, a
 * property that left the company without being theirs stays hidden (BK3) and
 * a former property of theirs is read up to its last day — the cut a
 * whole-company reader gets (lib/bookkeeperScope requestScopeOf).
 */
export async function wholeLedgerScope(user: any, landlordId: string): Promise<LedgerScope> {
  if (user?.role !== 'bookkeeper') return { landlordIds: [landlordId] }
  const [row] = await bookkeeperScopesOf(user.userId, landlordId)
  if (!row) throw new AppError(403, 'You are not assigned to this client')
  const whole = requestScopeOf({ ...row, company_wide: true, whole_company_reports: true }).companyReports
  return { landlordIds: [landlordId], propertyIds: whole.propertyIds, cutoffs: whole.cutoffs }
}

export function registerBooksLedgerReportRoutes(router: Router, deps: BooksLedgerReportDeps): void {
  /** The landlord company whose books are open, or null (an admin's every landlord, a business's books). */
  const landlordCompany = (req: Request): string | null => {
    const { col, id } = deps.ownerScope(req.user)
    return col === 'landlord_id' && id ? id : null
  }

  /** A company report's scope (P&L, money out, cash flow): BK2 decides a bookkeeper's property money. */
  const companyReportScope = async (req: Request, landlordId: string): Promise<LedgerScope> => {
    const sc = await deps.companyReportPropertyScope(req.user)
    return { landlordIds: [landlordId], propertyIds: sc.propertyIds, cutoffs: sc.cutoffs }
  }

  /** The whole-company ledger's scope (wholeLedgerScope). */
  const ledgerScope = (req: Request, landlordId: string): Promise<LedgerScope> => wholeLedgerScope(req.user, landlordId)

  /** A ledger-only report's company, or a 400 / { live: false } answer. */
  const liveCompany = async (req: Request): Promise<{ landlordId: string; live: boolean; reason: string | null }> => {
    const landlordId = landlordCompany(req)
    if (!landlordId) throw new AppError(400, 'Open one landlord company’s books to see its ledger reports.')
    const live = await ledgerReportsLive([landlordId])
    return { landlordId, live, reason: live ? null : await ledgerNotLiveReason(landlordId) }
  }

  router.get('/reports/ledger-status', requireBooksRead, async (req, res, next) => {
    try {
      const landlordId = landlordCompany(req)
      if (!landlordId) return res.json({ success: true, data: { live: false, reason: 'The ledger reports are a landlord company’s.' } })
      const live = await ledgerReportsLive([landlordId])
      res.json({ success: true, data: { live, reason: live ? null : await ledgerNotLiveReason(landlordId) } })
    } catch (e) { next(e) }
  })

  router.get('/reports/pl', requireBooksRead, async (req, res, next) => {
    try {
      const landlordId = landlordCompany(req)
      if (!landlordId || !(await ledgerReportsLive([landlordId]))) return next()
      await refuseScopedStaff(req.user, 'Books profit and loss', { ledger: true })
      const { start, end } = periodOf(req)
      const pl = await ledgerProfitAndLoss(await companyReportScope(req, landlordId), start, end, periodLabel(start, end))
      const seesTotals = seesGrandTotals(req.user)
      const view = viewForViewer(pl.view, seesTotals) as typeof pl.view
      if (!seesTotals) delete (view as any).proof
      res.json({
        success: true,
        data: {
          ...pl,
          view,
          meta: { columns: LEDGER_COLUMNS_META },
          // The older screen's fields, from the same figures (a page loaded
          // before this release reads them until it reloads).
          period: { start, end },
          income: pl.incomeAccounts.map(a => ({ code: a.code, name: a.name, period_amount: a.charged })),
          expenses: pl.expenses.rows.map(a => ({ code: a.code, name: a.name, period_amount: a.incurred })),
          ledgerExpenses: pl.expenses,
          totalIncome: pl.view.charged, totalExpenses: pl.expenses.incurred, netIncome: pl.nets.charged,
          gamRentIncome: pl.view.received, gamPL: null, gamBusinessRevenue: 0,
        },
      })
    } catch (e) { next(e) }
  })

  router.get('/reports/balance-sheet', requireBooksRead, async (req, res, next) => {
    try {
      const landlordId = landlordCompany(req)
      if (!landlordId || !(await ledgerReportsLive([landlordId]))) return next()
      // 10/12 (Nic, review): the whole-company ledger, like the trial balance
      // and general ledger — a team member assigned to some properties is
      // refused it in plain words.
      await refuseScopedStaff(req.user, 'balance sheet', { ledger: true })
      const asOf = String(req.query.asOf ?? todayIn(null))
      if (!DAY.test(asOf)) throw new AppError(400, 'Choose the day the balance sheet is as of.')
      const bs = await ledgerBalanceSheet(await ledgerScope(req, landlordId), asOf)
      res.json({ success: true, data: { source: 'ledger', ...bs } })
    } catch (e) { next(e) }
  })

  router.get('/reports/cash-flow', requireBooksRead, async (req, res, next) => {
    try {
      const landlordId = landlordCompany(req)
      if (!landlordId || !(await ledgerReportsLive([landlordId]))) return next()
      await refuseScopedStaff(req.user, 'Books cash flow')
      const { start, end } = periodOf(req)
      const cf = await ledgerCashFlow(await companyReportScope(req, landlordId), start, end)
      res.json({ success: true, data: { source: 'ledger', ...cf } })
    } catch (e) { next(e) }
  })

  router.get('/reports/trial-balance', requireBooksRead, async (req, res, next) => {
    try {
      await refuseScopedStaff(req.user, 'trial balance', { ledger: true })
      const c = await liveCompany(req)
      const { start, end } = periodOf(req)
      if (!c.live) return res.json({ success: true, data: { live: false, reason: c.reason, rows: [] } })
      const raw = String(req.query.property ?? 'all')
      const property = raw === 'all' || raw === 'company' || /^[0-9a-f-]{36}$/i.test(raw) ? raw : 'all'
      const scope = await ledgerScope(req, c.landlordId)
      // The company's own lines belong to whoever reads the whole company.
      if (property === 'company' && scope.propertyIds) throw new AppError(403, 'The company’s own lines are part of the whole-company books, which the owner has not given you.')
      if (property !== 'all' && property !== 'company' && scope.propertyIds && !scope.propertyIds.includes(property)) {
        throw new AppError(403, 'That property is not among what the owner has given you.')
      }
      const tb = await ledgerTrialBalance(scope, start, end, property)
      res.json({ success: true, data: { live: true, ...tb } })
    } catch (e) { next(e) }
  })

  router.get('/reports/general-ledger', requireBooksRead, async (req, res, next) => {
    try {
      await refuseScopedStaff(req.user, 'general ledger', { ledger: true })
      const c = await liveCompany(req)
      const { start, end } = periodOf(req)
      const accountId = String(req.query.accountId ?? '')
      if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new AppError(400, 'Choose the account to open.')
      if (!c.live) return res.json({ success: true, data: { live: false, reason: c.reason, lines: [] } })
      // 10/12 (Nic, review): a page of lines at a time (?offset, ?limit); the
      // closing balance is always the whole period's.
      const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0)
      const limit = Number.parseInt(String(req.query.limit ?? ''), 10) || undefined
      const gl = await ledgerGeneralLedger(await ledgerScope(req, c.landlordId), accountId, start, end, {
        showCorrections: req.query.showCorrections === '1' || req.query.showCorrections === 'true',
        offset, limit,
      })
      if (!gl) throw new AppError(404, 'No such account in these books.')
      res.json({ success: true, data: { live: true, ...gl } })
    } catch (e) { next(e) }
  })

  router.get('/reports/receivables', requireBooksRead, async (req, res, next) => {
    try {
      await refuseScopedStaff(req.user, 'Books receivables report', { ledger: true })
      // decisions #25: what everyone owes is a grand total.
      if (!seesGrandTotals(req.user)) throw new AppError(403, 'What tenants owe in all is not among what you can see.')
      const c = await liveCompany(req)
      const asOf = String(req.query.asOf ?? todayIn(null))
      if (!DAY.test(asOf)) throw new AppError(400, 'Choose the day to see what was owed on.')
      if (!c.live) return res.json({ success: true, data: { live: false, reason: c.reason, rows: [] } })
      const r = await ledgerReceivables(await companyReportScope(req, c.landlordId), asOf)
      res.json({ success: true, data: { live: true, ...r, bucketLabels: AGING_BUCKET_LABEL } })
    } catch (e) { next(e) }
  })

  router.get('/reports/money-out', requireBooksRead, async (req, res, next) => {
    try {
      await refuseScopedStaff(req.user, 'Books money out report', { ledger: true })
      const c = await liveCompany(req)
      const { start, end } = periodOf(req)
      if (!c.live) return res.json({ success: true, data: { live: false, reason: c.reason, rows: [] } })
      const mo = await ledgerMoneyOut(await companyReportScope(req, c.landlordId), start, end)
      res.json({ success: true, data: { live: true, ...mo } })
    } catch (e) { next(e) }
  })
}

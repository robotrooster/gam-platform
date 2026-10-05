// Single source of truth for a landlord's P&L (S568, Nic — "detangle Books").
// Both the landlord reports (reports.ts) and the Books app (books.ts) compute the
// P&L from the SAME definition here, so they can never drift. Income is
// categorized (deposits are a HELD LIABILITY, not income; platform/float fees are
// GAM's revenue, not the landlord's). Expenses = GAM platform fee + maintenance +
// lot rent (investor-operator) + the landlord's entered expenses.
//
// S655 (money plan, Step 3): income now comes from services/incomeBasis, under
// the "Money received" / "Money billed" switch (default Money received). Nic
// (10/2): Money received is strictly the day money ARRIVED — paid-ahead money
// counts the day it arrives and $0 when it pays a later bill; a credit the
// landlord gives is never income.
import type { IncomeBasis } from '@gam/shared'
import { query, queryOne } from '../db'
import { platformFeesByProperty } from './platformFee'
import { landlordExpensesTotal } from './landlordExpenses'
import {
  incomeTotals, basisMeta, lineList, besideList,
  type BasisMeta, type IncomeBeside, type ReportLine,
} from './incomeBasis'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * S654: THE definition of a landlord's income row lives in services/incomeBasis
 * (one copy: the money facts every report reads are built on it) and is
 * re-exported here for the callers that always imported it from the P&L.
 */
export { landlordIncomeSql, LANDLORD_INCOME_TYPES } from './incomeBasis'

/** S654: a deposit row reported as held (not income). GAM's own rows excluded. */
export function landlordDepositSql(alias?: string): string {
  const a = alias ? `${alias}.` : ''
  return `(${a}type = 'deposit' AND ${a}revenue_owner <> 'gam')`
}

export interface LandlordPL {
  /**
   * balances = "Balances collected" (carried_balance). fees = fees + late fees
   * (as before). other = every line but rent, so rent + other = total.
   * The full set of lines (paid ahead, register sales, credits given, ...) is
   * `lines`.
   */
  gross: { rent: number; fees: number; utilities: number; homeSale: number; balances: number; otherIncome: number; other: number; total: number }
  /** S655: every income line, by REPORT_LINES (negatives are negative). */
  lines: Record<ReportLine, number>
  /** S655: the non-zero lines, labeled, for a screen. */
  lineItems: Array<{ line: ReportLine; label: string; amount: number }>
  /** S655: figures shown beside the total, never inside it. */
  beside: IncomeBeside & { paidAheadUnused: number }
  besideItems: Array<{ key: string; label: string; amount: number }>
  depositsHeld: number
  expenses: { platformFee: number; maintenance: number; lotRent: number; enteredExpenses: number; total: number }
  net: number
  basis: BasisMeta
}

/**
 * Compute a landlord's P&L for a date range. `periodMonthKeys` are the YYYY-MM
 * keys the platform-fee accrual lookup needs (pass the months the range spans).
 * `start`/`end` are days ('YYYY-MM-DD'; a longer timestamp is cut to its date):
 * income is dated on each property's own calendar day.
 *
 * `propertyIds` (S655, gam-audience-data-isolation): a team member assigned to
 * some properties sees the P&L of those properties only — their income, and
 * the expenses booked to them (platform fee, maintenance, lot rent, entered
 * expenses with that property). null/undefined = the whole company.
 */
export async function computeLandlordPL(
  landlordId: string,
  start: string,
  end: string,
  periodMonthKeys: string[],
  basis: IncomeBasis = 'received',
  propertyIds: string[] | null = null,
): Promise<LandlordPL> {
  const first = String(start).slice(0, 10)
  const last = String(end).slice(0, 10)
  const [inc, expenses] = await Promise.all([
    incomeTotals({ landlordIds: [landlordId], start: first, end: last, basis, propertyIds }),
    landlordPLExpenses(landlordId, start, end, periodMonthKeys, propertyIds),
  ])
  const L = inc.lines

  const rent = L.rent
  const fees = round2(L.fees + L.lateFees)
  const utilities = L.utilities
  const homeSale = L.homeSale
  const balances = L.balances
  // S605: income the landlord banked that GAM never collected — laundry, vending,
  // an insurance claim, cash rent deposited. Categorized off the bank feed.
  const otherIncome = L.otherIncome
  const grossTotal = inc.total
  const other = round2(grossTotal - rent)

  return {
    gross: { rent, fees, utilities, homeSale, balances, otherIncome, other, total: grossTotal },
    lines: L,
    lineItems: lineList(L),
    beside: { ...inc.beside, paidAheadUnused: inc.paidAheadUnused },
    besideItems: besideList(inc.beside, inc.paidAheadUnused, basis),
    depositsHeld: inc.beside.depositsHeld,
    expenses,
    net: round2(grossTotal - expenses.total),
    basis: basisMeta(basis),
  }
}

/**
 * S655: the P&L's expenses — ONE definition, read by computeLandlordPL and by
 * anything that shows a P&L's net beside other figures (the Reports overview's
 * month rows), so a row and the P&L it opens cannot net two ways. The same
 * under either basis: GAM's platform fee by the month it is for, repairs by
 * completion day, lot rent by billing month, entered expenses by their date.
 * `start`/`end` as computeLandlordPL takes them.
 */
export async function landlordPLExpenses(
  landlordId: string,
  start: string,
  end: string,
  periodMonthKeys: string[],
  propertyIds: string[] | null = null,
): Promise<LandlordPL['expenses']> {
  const first = String(start).slice(0, 10)
  const last = String(end).slice(0, 10)
  const inScope = (propertyId: string) => propertyIds === null || propertyIds.includes(propertyId)

  const feeMap = await platformFeesByProperty(landlordId, periodMonthKeys)
  const platformFee = round2(Array.from(feeMap.entries())
    .reduce((s, [propertyId, v]) => s + (inScope(propertyId) ? v : 0), 0))

  // S654: the end is a whole day. `< end::date + 1` takes the whole day, for a
  // bare date and for monthRange's '...T23:59:59-07:00' alike.
  const maintRow = await queryOne<any>(`
    SELECT COALESCE(SUM(mr.actual_cost), 0)::float AS c FROM maintenance_requests mr
      LEFT JOIN units u ON u.id = mr.unit_id
     WHERE mr.landlord_id = $1 AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
       AND mr.actual_cost IS NOT NULL
       AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))`,
    [landlordId, start, end, propertyIds])
  const maintenance = round2(+maintRow?.c || 0)

  const lotRow = await queryOne<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS c FROM lot_rent_charges
     WHERE landlord_id = $1 AND billing_month >= $2::date AND billing_month <= $3::date
       AND ($4::uuid[] IS NULL OR property_id = ANY($4::uuid[]))`,
    [landlordId, first, last, propertyIds])
  const lotRent = round2(+lotRow?.c || 0)

  // An expense with no property is the company's; a property-scoped view
  // carries only the expenses booked to its properties.
  const enteredExpenses = propertyIds === null
    ? await landlordExpensesTotal(landlordId, first, last)
    : round2(Number((await query<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM landlord_expenses
          WHERE landlord_id = $1 AND status = 'active' AND expense_date >= $2 AND expense_date <= $3
            AND property_id = ANY($4::uuid[])`,
        [landlordId, first, last, propertyIds]))[0]?.total ?? 0))

  return {
    platformFee, maintenance, lotRent, enteredExpenses,
    total: round2(platformFee + maintenance + lotRent + enteredExpenses),
  }
}

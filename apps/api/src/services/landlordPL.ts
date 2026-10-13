// Single source of truth for a landlord's P&L (S568, Nic — "detangle Books").
// Both the landlord reports (reports.ts) and the Books app (books.ts) compute the
// P&L from the SAME definition here, so they can never drift. Income is
// categorized (deposits are a HELD LIABILITY, not income; platform/float fees are
// GAM's revenue, not the landlord's). Expenses = GAM platform fee + maintenance +
// lot rent (investor-operator) + the landlord's entered expenses + (10/11) the
// payment processing fees the landlord covers for their tenants + (10/12, G10)
// the card fees guests got back with refunds of card sales.
//
// S655 (money plan, Step 3): income now comes from services/incomeBasis, under
// the "Money received" / "Money billed" switch (default Money received). Nic
// (10/2): Money received is strictly the day money ARRIVED — paid-ahead money
// counts the day it arrives and $0 when it pays a later bill; a credit the
// landlord gives is never income.
import type { IncomeBasis } from '@gam/shared'
// 10/12 (Nic, ledger P6, L5): which expenses count as a cost, and a repair's cost once (lib/liveExpense).
import { liveExpenseSql, maintenanceCostNotBilledSql } from '../lib/liveExpense'
import { query, queryOne } from '../db'
import { cutoffsParam, withinCutoffsSql, type PropertyCutoff } from '../lib/bookkeeperScope'
import { platformFeesByProperty } from './platformFee'
import { landlordExpensesTotal } from './landlordExpenses'
import { TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL } from './platformRevenue'
import {
  ledgerReportsLive, ledgerPLExpenses, ledgerPLExpensesByProperty, ledgerRoleByProperty, ledgerEnteredExpensesByDay,
  ledgerExpensesPaidOut,
} from './ledgerReports'
import {
  basisMeta, lineList, besideList, summarize, incomeBoth, moneyViewFrom, cardFeesRefundedByProperty,
  type BasisMeta, type IncomeBeside, type ReportLine, type MoneyView, type IncomeEvent, type ReportSource,
} from './incomeBasis'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 10/12 (Nic, review): does an expense reader read the ledger? 'auto' asks
 * whether every company of `ids` is live; a screen covering several companies
 * decides once ('ledger' / 'records') and passes it to every reader it calls,
 * so no company's figures mix the books and the money records.
 */
async function expensesFromLedger(ids: readonly string[], source: ReportSource): Promise<boolean> {
  if (source === 'records' || ids.length === 0) return false
  if (source === 'ledger') return true
  return ledgerReportsLive(ids)
}

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

/**
 * 10/12 (Nic, ledger P8): what a P&L's expenses carry once the company's books
 * are live (services/ledgerReports ledgerPLExpenses): `total` is then the
 * expenses INCURRED in the period (the Charged-based column), `cashTotal` the
 * expenses PAID in it (the Received-based column: a bill on the day it was
 * paid, payroll on the pay date, never depreciation or work done for rent),
 * and `byAccount` each expense account with both. Absent on the money records.
 */
export interface LedgerExpenseExtras {
  cashTotal?: number
  byAccount?: Array<{ accountId: string; code: string; name: string; role: string | null; incurred: number; paid: number }>
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
  /**
   * 10/12 (Nic, G10): cardFeesRefunded — the card fee a guest got back with a
   * refund of a card sale (the register's Refund, an early check-out's card
   * part). The landlord's cost: "the customer gets the card fee back too; the
   * landlord eats that fee." In the total.
   */
  expenses: { platformFee: number; maintenance: number; lotRent: number; enteredExpenses: number; processingFees: number; cardFeesRefunded: number; total: number } & LedgerExpenseExtras
  net: number
  basis: BasisMeta
  /**
   * 10/12 (Nic): Charged, Received and Owed side by side, with the tie — the
   * same facts every screen reads, both kinds always. `gross`/`lines`/`net`
   * above stay the one basis asked for (Money received unless a caller still
   * passes one), for the callers that read them.
   */
  view: MoneyView
  /** 10/12: the net on each column — Charged less expenses, Received less expenses. */
  nets: { charged: number; received: number }
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
 *
 * `cutoffs` (10/12, Nic): the clean cut at a sale — a bookkeeper reads a
 * former property's income and expenses up to the day it left the company,
 * never after (lib/bookkeeperScope). [] = no cut (owners).
 */
export async function computeLandlordPL(
  landlordId: string,
  start: string,
  end: string,
  periodMonthKeys: string[],
  basis: IncomeBasis = 'received',
  propertyIds: string[] | null = null,
  cutoffs: readonly PropertyCutoff[] = [],
  /** 10/12: the period's name in the tie line ("September 2026"); defaults to its days. */
  periodLabel?: string,
): Promise<LandlordPL> {
  const first = String(start).slice(0, 10)
  const last = String(end).slice(0, 10)
  // 10/12 (Nic, review): income and expenses from the same place, decided once.
  const source: ReportSource = (await ledgerReportsLive([landlordId])) ? 'ledger' : 'records'
  // 10/12 (Nic): both kinds of facts, read once — Charged/Received/Owed side
  // by side, and the one basis a caller still asks for read off the same facts.
  const [both, expenses] = await Promise.all([
    incomeBoth({ landlordIds: [landlordId], start: first, end: last, propertyIds, cutoffs, source }),
    landlordPLExpenses(landlordId, start, end, periodMonthKeys, propertyIds, cutoffs, source),
  ])
  return landlordPLFrom(both, expenses, { start: first, end: last, label: periodLabel ?? `${first} to ${last}` }, basis)
}

/**
 * 10/12: the P&L from facts already read (services/incomeBasis incomeBoth for
 * the same company, days, properties and cut) and its expenses
 * (landlordPLExpenses) — for a report that also lists those facts by month or
 * by day, so it reads them once. computeLandlordPL is this plus the reads.
 */
export function landlordPLFrom(
  both: { billed: readonly IncomeEvent[]; received: readonly IncomeEvent[]; paidAheadUnused: number },
  expenses: LandlordPL['expenses'],
  period: { start: string; end: string; label: string },
  basis: IncomeBasis = 'received',
): LandlordPL {
  const inc = { ...summarize(basis === 'billed' ? both.billed : both.received, basis), paidAheadUnused: both.paidAheadUnused }
  const view = moneyViewFrom(both.billed, both.received, period, both.paidAheadUnused)
  // 10/12 (Nic, ledger P8): on the ledger the Received net takes the expenses
  // PAID in the period and the Charged net the expenses incurred (one figure
  // for both on the money records).
  const paidOut = expenses.cashTotal ?? expenses.total
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
    net: round2(grossTotal - (basis === 'billed' ? expenses.total : paidOut)),
    basis: basisMeta(basis),
    view,
    nets: { charged: round2(view.charged - expenses.total), received: round2(view.received - paidOut) },
  }
}

/**
 * 10/12 (Nic): "under each day any expenses logged that day — 'You logged
 * $2,000 of expenses'." The landlord's entered expenses by their date, the
 * same rows (and the same scope and clean cut) the P&L's "Your expenses" line
 * adds up, so a month's days add back to it. Days are 'YYYY-MM-DD'.
 */
export async function enteredExpensesByDay(
  landlordId: string,
  start: string,
  end: string,
  propertyIds: string[] | null = null,
  cutoffs: readonly PropertyCutoff[] = [],
  /** 10/12 (Nic, review): see expensesFromLedger. */
  source: ReportSource = 'auto',
): Promise<Map<string, { amount: number; count: number }>> {
  const out = new Map<string, { amount: number; count: number }>()
  if (propertyIds && propertyIds.length === 0) return out
  // 10/12 (Nic, ledger P8): the Expenses record's lines in the ledger, by day.
  if (await expensesFromLedger([landlordId], source)) {
    return ledgerEnteredExpensesByDay({ landlordIds: [landlordId], propertyIds, cutoffs }, start, end)
  }
  const rows = await query<{ day: string; total: string; n: number }>(
    `SELECT expense_date::text AS day, SUM(amount)::text AS total, COUNT(*)::int AS n
       FROM landlord_expenses
      WHERE landlord_id = $1 AND ${liveExpenseSql('')} AND expense_date >= $2::date AND expense_date <= $3::date
        AND ($4::uuid[] IS NULL OR property_id = ANY($4::uuid[]))
        AND ${withinCutoffsSql('property_id', 'expense_date', '$5')}
      GROUP BY expense_date`,
    [landlordId, String(start).slice(0, 10), String(end).slice(0, 10), propertyIds, cutoffsParam(cutoffs)])
  for (const r of rows) out.set(r.day, { amount: round2(Number(r.total)), count: r.n })
  return out
}

/**
 * 10/11 (Nic) — "Payment processing fees": the card or bank fee a property
 * covers for its tenants (property_allocation_rules.ach_fee_payer /
 * card_fee_payer = 'landlord'). Nothing is added on top of the tenant's
 * payment; allocation takes the fee out of the landlord's share when the
 * payment settles (services/allocation executeRentAllocation, or a negative
 * payout line when credit paid every landlord row — bookFeeWithNoHeldShare).
 * Income counts the whole rent, so without this line the P&L's net was more
 * than the landlord was paid.
 *
 * Read from what allocation actually booked, never re-priced: the
 * customer_fee_charged on each banking_spread row it wrote for this
 * landlord's payment rows (the fee is apportioned across a charge's rows, so
 * the rows add up to the charge's fee). The fee is the landlord's when the
 * tenant's payment (tenant_remittances, by PaymentIntent) carried no fee on
 * top — its processing_fee_amount less any platform fee the property passed to
 * its tenants (TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL), which is the platform
 * fee line's, never this one's. The same rule GAM's own books read
 * (stripeCosts.gamFeeOnRemittance). A row with no remittance cannot say who
 * paid, and is left out.
 *
 * Dated on the property's own day the payment settled (when the fee came out),
 * like the income it came out of. A row with no property on the ledger takes
 * its unit's.
 *
 * By property (key '' = a fee with no property, the company's), so a report
 * that nets each property (Reports' by-property table, the property detail)
 * can take the same figure the P&L does. `start`/`end` are days; the
 * landlords' own fees only; `propertyIds` null = every property; `cutoffs`
 * (10/12) leave a former property's fees after the day it left out.
 */
export async function processingFeesByProperty(
  landlordIds: string[],
  start: string,
  end: string,
  propertyIds: string[] | null = null,
  cutoffs: readonly PropertyCutoff[] = [],
  /** 10/12 (Nic, review): see expensesFromLedger. */
  source: ReportSource = 'auto',
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (landlordIds.length === 0 || (propertyIds && propertyIds.length === 0)) return out
  // 10/12 (Nic, ledger P8): on the ledger, the processing fees account (5115).
  if (await expensesFromLedger(landlordIds, source)) {
    return ledgerRoleByProperty({ landlordIds, propertyIds, cutoffs }, 'processing_fees', start, end)
  }
  return processingFeesFromRecords(landlordIds, start, end, propertyIds, cutoffs)
}

/** processingFeesByProperty from the money records (the nightly parity check reads it beside the ledger). */
export async function processingFeesFromRecords(
  landlordIds: string[],
  start: string,
  end: string,
  propertyIds: string[] | null = null,
  cutoffs: readonly PropertyCutoff[] = [],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (landlordIds.length === 0 || (propertyIds && propertyIds.length === 0)) return out
  const rows = await query<{ property_id: string | null; total: string }>(`
    SELECT COALESCE(l.property_id, u.property_id) AS property_id,
           SUM(l.customer_fee_charged)::text AS total
      FROM platform_revenue_ledger l
      JOIN payments p ON p.id = l.reference_id
      JOIN tenant_remittances r ON r.stripe_payment_intent_id = p.stripe_payment_intent_id
      LEFT JOIN (${TENANT_PLATFORM_FEE_BY_REMITTANCE_SQL}) tpf ON tpf.remittance_id = r.id
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN properties pr ON pr.id = COALESCE(l.property_id, u.property_id)
     WHERE l.type = 'banking_spread' AND l.reference_type = 'payment'
       AND l.customer_fee_charged > 0
       AND p.landlord_id = ANY($1::uuid[])
       AND p.stripe_payment_intent_id IS NOT NULL
       AND ROUND(r.processing_fee_amount - COALESCE(tpf.amt, 0), 2) = 0
       AND ((COALESCE(p.settled_at, l.created_at) AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date
             BETWEEN $2::date AND $3::date)
       AND ($4::uuid[] IS NULL OR COALESCE(l.property_id, u.property_id) = ANY($4::uuid[]))
       AND ${withinCutoffsSql('COALESCE(l.property_id, u.property_id)',
             "(COALESCE(p.settled_at, l.created_at) AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date", '$5')}
     GROUP BY 1`,
    [landlordIds, String(start).slice(0, 10), String(end).slice(0, 10), propertyIds, cutoffsParam(cutoffs)])
  for (const r of rows) out.set(r.property_id ?? '', round2(Number(r.total)))
  return out
}

/**
 * S655: the P&L's expenses — ONE definition, read by computeLandlordPL and by
 * anything that shows a P&L's net beside other figures (the Reports overview's
 * month rows), so a row and the P&L it opens cannot net two ways. The same
 * under either basis: GAM's platform fee by the month it is for, repairs by
 * completion day, lot rent by billing month, entered expenses by their date,
 * (10/11) processing fees the landlord covers by the day the payment settled.
 * `start`/`end` as computeLandlordPL takes them. `cutoffs` (10/12): a former
 * property's expenses after the day it left are left out — its platform fee
 * for a month that began after that day, its repairs, lot rent, entered
 * expenses and processing fees dated after it.
 */
export async function landlordPLExpenses(
  landlordId: string,
  start: string,
  end: string,
  periodMonthKeys: string[],
  propertyIds: string[] | null = null,
  cutoffs: readonly PropertyCutoff[] = [],
  /**
   * 10/12 (Nic, review): 'auto' reads the books once this company's are live;
   * a screen covering several companies passes its one decision for all of
   * them (see expensesFromLedger).
   */
  source: ReportSource = 'auto',
): Promise<LandlordPL['expenses']> {
  const first = String(start).slice(0, 10)
  const last = String(end).slice(0, 10)
  // 10/12 (Nic, ledger P8): once the company's books are live, the expense
  // accounts (services/ledgerReports ledgerPLExpenses) — the same buckets, plus
  // what was paid in the period and each account.
  if (await expensesFromLedger([landlordId], source)) {
    if (propertyIds && propertyIds.length === 0) {
      return { platformFee: 0, maintenance: 0, lotRent: 0, enteredExpenses: 0, processingFees: 0, cardFeesRefunded: 0, total: 0, cashTotal: 0, byAccount: [] }
    }
    return ledgerPLExpenses({ landlordIds: [landlordId], propertyIds, cutoffs }, first, last)
  }
  const inScope = (propertyId: string) => propertyIds === null || propertyIds.includes(propertyId)
  const cut = cutoffsParam(cutoffs)

  const feeMap = await platformFeesByProperty(landlordId, periodMonthKeys)
  // 10/12: a former property's fee only for the months that began by its last
  // day (the fee is billed by the month; the month it left in was the company's).
  const cutFees = new Map<string, number>()
  for (const c of cutoffs) {
    if (!feeMap.has(c.propertyId)) continue
    const months = periodMonthKeys.filter(m => String(m).slice(0, 10) <= c.lastDay)
    cutFees.set(c.propertyId, months.length ? ((await platformFeesByProperty(landlordId, months, c.propertyId)).get(c.propertyId) ?? 0) : 0)
  }
  const platformFee = round2(Array.from(feeMap.entries())
    .reduce((s, [propertyId, v]) => s + (inScope(propertyId) ? (cutFees.get(propertyId) ?? v) : 0), 0))

  // S654: the end is a whole day. `< end::date + 1` takes the whole day, for a
  // bare date and for monthRange's '...T23:59:59-07:00' alike.
  const maintRow = await queryOne<any>(`
    SELECT COALESCE(SUM(mr.actual_cost), 0)::float AS c FROM maintenance_requests mr
      LEFT JOIN units u ON u.id = mr.unit_id
      LEFT JOIN properties mp ON mp.id = u.property_id
     WHERE mr.landlord_id = $1 AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
       AND mr.actual_cost IS NOT NULL
       AND ${maintenanceCostNotBilledSql('mr')}
       AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
       AND ${withinCutoffsSql('u.property_id', "(mr.completed_at AT TIME ZONE COALESCE(mp.timezone, 'America/Phoenix'))::date", '$5')}`,
    [landlordId, start, end, propertyIds, cut])
  const maintenance = round2(+maintRow?.c || 0)

  const lotRow = await queryOne<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS c FROM lot_rent_charges
     WHERE landlord_id = $1 AND billing_month >= $2::date AND billing_month <= $3::date
       AND ($4::uuid[] IS NULL OR property_id = ANY($4::uuid[]))
       AND ${withinCutoffsSql('property_id', 'billing_month', '$5')}`,
    [landlordId, first, last, propertyIds, cut])
  const lotRent = round2(+lotRow?.c || 0)

  // An expense with no property is the company's; a property-scoped view
  // carries only the expenses booked to its properties. 10/12: a former
  // property's expenses up to the day it left.
  const enteredExpenses = propertyIds === null && cutoffs.length === 0
    ? await landlordExpensesTotal(landlordId, first, last)
    : round2(Number((await query<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM landlord_expenses
          WHERE landlord_id = $1 AND ${liveExpenseSql('')} AND expense_date >= $2 AND expense_date <= $3
            AND ($4::uuid[] IS NULL OR property_id = ANY($4::uuid[]))
            AND ${withinCutoffsSql('property_id', 'expense_date', '$5')}`,
        [landlordId, first, last, propertyIds, cut]))[0]?.total ?? 0))

  // 10/11: the fees the landlord covers for their tenants (processingFeesByProperty).
  // 10/12 (Nic, review): from the money records here, like everything above.
  const procMap = await processingFeesByProperty([landlordId], first, last, propertyIds, cutoffs, 'records')
  const processingFees = round2([...procMap.values()].reduce((s, v) => s + v, 0))
  // 10/12 (Nic, G10): the card fees guests got back with refunds.
  const refundMap = await cardFeesRefundedByProperty([landlordId], first, last, propertyIds, cutoffs, 'records')
  const cardFeesRefunded = round2([...refundMap.values()].reduce((s, v) => s + v, 0))

  return {
    platformFee, maintenance, lotRent, enteredExpenses, processingFees, cardFeesRefunded,
    total: round2(platformFee + maintenance + lotRent + enteredExpenses + processingFees + cardFeesRefunded),
  }
}

/**
 * 10/12 review — the company's expenses as MONEY THAT LEFT, for a cash
 * statement (Books Cash Flow): every live payment toward an expense that counts
 * as a cost (lib/liveExpense), on the day it was paid. Since money out became
 * one record (Nic L5) an expense can be unpaid (a bill) or paid in parts, so
 * its amount on its date is not cash: an unpaid repair bill left nothing yet,
 * and a bill paid over three months left money in each. A payment taken back
 * (voided) never left. `propertyIds` / `cutoffs` as landlordPLExpenses (an
 * expense on no property is the company's; a former property's payments up to
 * its last day).
 */
export async function landlordExpensesPaidOut(
  landlordId: string | null,
  start: string,
  end: string,
  propertyIds: string[] | null = null,
  cutoffs: readonly PropertyCutoff[] = [],
  /** 10/12 (Nic, review): see expensesFromLedger. */
  source: ReportSource = 'auto',
): Promise<number> {
  // 10/12 (Nic, ledger P8): on the ledger, the expenses paid in the period.
  if (landlordId && await expensesFromLedger([landlordId], source)) {
    return ledgerExpensesPaidOut({ landlordIds: [landlordId], propertyIds, cutoffs }, start, end)
  }
  const r = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(p.amount), 0)::text AS total
       FROM landlord_expense_payments p
       JOIN landlord_expenses e ON e.id = p.expense_id
      WHERE ($1::uuid IS NULL OR e.landlord_id = $1::uuid) AND p.voided_at IS NULL AND ${liveExpenseSql('e')}
        AND p.paid_on >= $2::date AND p.paid_on <= $3::date
        AND ($4::uuid[] IS NULL OR e.property_id = ANY($4::uuid[]))
        AND ${withinCutoffsSql('e.property_id', 'p.paid_on', '$5')}`,
    [landlordId, String(start).slice(0, 10), String(end).slice(0, 10), propertyIds, cutoffsParam(cutoffs)])
  return round2(Number(r?.total ?? 0))
}

/** The company bucket of landlordPLExpensesByProperty: money booked to no property. */
export const NO_PROPERTY_KEY = ''

/**
 * landlordPLExpenses for every property of one company at once — the same
 * definitions (GAM's platform fee for the months, repairs by completion day,
 * lot rent by billing month, entered expenses by their date, processing fees
 * the landlord covers by the day the payment settled), each read ONCE and
 * split by property. `propertyIds` narrows it (null = every property, and the
 * company's own costs under NO_PROPERTY_KEY: a repair with no space, an entered
 * expense or lot rent on no property, a processing fee on no space). No
 * bookkeeper cutoffs: for a reader who keeps the whole company's properties.
 *
 * 10/12 review: the monthly property report called landlordPLExpenses once per
 * property, and each call read the company's whole platform-fee map — work
 * that grew with the square of the property count on every view, PDF and
 * recipient. The properties' entries here are exactly landlordPLExpenses(…,
 * [that property]) (services/landlordPL.test), and with every property and the
 * company bucket they add up to landlordPLExpenses(…, null).
 */
export async function landlordPLExpensesByProperty(
  landlordId: string,
  start: string,
  end: string,
  periodMonthKeys: string[],
  propertyIds: readonly string[] | null = null,
): Promise<Map<string, LandlordPL['expenses']>> {
  const first = String(start).slice(0, 10)
  const last = String(end).slice(0, 10)
  const ids = propertyIds === null ? null : [...propertyIds]
  const out = new Map<string, LandlordPL['expenses']>()
  if (ids && ids.length === 0) return out
  // 10/12 (Nic, ledger P8): on the ledger, the expense accounts by property
  // (NO_PROPERTY_KEY: the company's own lines).
  if (await ledgerReportsLive([landlordId])) {
    const byProp = await ledgerPLExpensesByProperty({ landlordIds: [landlordId], propertyIds: ids }, first, last)
    const zero = (): LandlordPL['expenses'] => ({
      platformFee: 0, maintenance: 0, lotRent: 0, enteredExpenses: 0, processingFees: 0, cardFeesRefunded: 0, total: 0,
      cashTotal: 0, byAccount: [],
    })
    if (ids) for (const id of ids) out.set(id, byProp.get(id) ?? zero())
    for (const [k, v] of byProp) if (ids === null || k !== NO_PROPERTY_KEY) out.set(k, v)
    return out
  }
  const keyOf = (propertyId: string | null) => propertyId ?? NO_PROPERTY_KEY
  const inScope = (key: string) => ids === null || ids.includes(key)
  const slot = (key: string) => {
    let e = out.get(key)
    if (!e) {
      e = { platformFee: 0, maintenance: 0, lotRent: 0, enteredExpenses: 0, processingFees: 0, cardFeesRefunded: 0, total: 0 }
      out.set(key, e)
    }
    return e
  }
  if (ids) for (const id of ids) slot(id)

  const [feeMap, maint, lot, entered, procMap, refundMap] = await Promise.all([
    platformFeesByProperty(landlordId, periodMonthKeys),
    query<{ property_id: string | null; c: string }>(`
      SELECT u.property_id, COALESCE(SUM(mr.actual_cost), 0)::text AS c FROM maintenance_requests mr
        LEFT JOIN units u ON u.id = mr.unit_id
       WHERE mr.landlord_id = $1 AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
         AND mr.actual_cost IS NOT NULL
         AND ${maintenanceCostNotBilledSql('mr')}
         AND ($4::uuid[] IS NULL OR u.property_id = ANY($4::uuid[]))
       GROUP BY u.property_id`, [landlordId, start, end, ids]),
    query<{ property_id: string | null; c: string }>(`
      SELECT property_id, COALESCE(SUM(amount), 0)::text AS c FROM lot_rent_charges
       WHERE landlord_id = $1 AND billing_month >= $2::date AND billing_month <= $3::date
         AND ($4::uuid[] IS NULL OR property_id = ANY($4::uuid[]))
       GROUP BY property_id`, [landlordId, first, last, ids]),
    query<{ property_id: string | null; c: string }>(`
      SELECT property_id, COALESCE(SUM(amount), 0)::text AS c FROM landlord_expenses
       WHERE landlord_id = $1 AND ${liveExpenseSql('')} AND expense_date >= $2 AND expense_date <= $3
         AND ($4::uuid[] IS NULL OR property_id = ANY($4::uuid[]))
       GROUP BY property_id`, [landlordId, first, last, ids]),
    // 10/12 (Nic, review): the money records here, like everything above.
    processingFeesByProperty([landlordId], first, last, ids, [], 'records'),
    cardFeesRefundedByProperty([landlordId], first, last, ids, [], 'records'),
  ])
  for (const [propertyId, v] of feeMap) if (inScope(propertyId)) slot(propertyId).platformFee = round2(v)
  for (const r of maint) slot(keyOf(r.property_id)).maintenance = round2(Number(r.c))
  for (const r of lot) slot(keyOf(r.property_id)).lotRent = round2(Number(r.c))
  for (const r of entered) slot(keyOf(r.property_id)).enteredExpenses = round2(Number(r.c))
  for (const [key, v] of procMap) if (inScope(key)) slot(key).processingFees = round2(v)
  for (const [key, v] of refundMap) if (inScope(key)) slot(key).cardFeesRefunded = round2(v)
  for (const e of out.values()) {
    e.total = round2(e.platformFee + e.maintenance + e.lotRent + e.enteredExpenses + e.processingFees + e.cardFeesRefunded)
  }
  return out
}

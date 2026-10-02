// Single source of truth for a landlord's P&L (S568, Nic — "detangle Books").
// Both the landlord reports (reports.ts) and the Books app (books.ts) compute the
// P&L from the SAME definition here, so they can never drift. Income is
// categorized (deposits are a HELD LIABILITY, not income; platform/float fees are
// GAM's revenue, not the landlord's). Expenses = GAM platform fee + maintenance +
// lot rent (investor-operator) + the landlord's entered expenses.
import { query, queryOne } from '../db'
import { platformFeesByProperty } from './platformFee'
import { landlordExpensesTotal } from './landlordExpenses'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * S654: THE definition of a landlord's income, used by every report (monthly
 * P&L, owner statement, tax summary, property reports, the report engine,
 * Books). A payment row is the landlord's income when:
 *   - it is their money: revenue_owner 'landlord'. Never GAM's fees ('gam':
 *     decline, return, opt-in products), never paid-ahead
 *     money GAM holds ('held', counted as rent when it is drawn down);
 *   - it is rent, a late fee, a fee, a utility, a home-sale payment, or a
 *     carried balance (pre-platform arrears and work-trade deficits: real
 *     money the tenant pays the landlord, shown as "Balances collected");
 *   - it is not a FlexPay pull ('FLEXPAY', written only by
 *     services/flexpay.ts): GAM reimbursing its own front plus its $25 fee.
 *     The landlord was paid by the front Transfer, not by this row.
 * Callers add status = 'settled' and their date window. Deposits are never
 * income; they are reported as held (landlordDepositSql).
 */
export const LANDLORD_INCOME_TYPES = ['rent', 'late_fee', 'fee', 'utility', 'home_payment', 'carried_balance'] as const
export function landlordIncomeSql(alias?: string): string {
  const a = alias ? `${alias}.` : ''
  return `(${a}revenue_owner = 'landlord'`
    + ` AND ${a}type IN (${LANDLORD_INCOME_TYPES.map(t => `'${t}'`).join(', ')})`
    + ` AND ${a}entry_description IS DISTINCT FROM 'FLEXPAY')`
}

/** S654: a deposit row reported as held (not income). GAM's own rows excluded. */
export function landlordDepositSql(alias?: string): string {
  const a = alias ? `${alias}.` : ''
  return `(${a}type = 'deposit' AND ${a}revenue_owner <> 'gam')`
}

export interface LandlordPL {
  /** balances = "Balances collected" (carried_balance). other = every non-rent line, otherIncome included. */
  gross: { rent: number; fees: number; utilities: number; homeSale: number; balances: number; otherIncome: number; other: number; total: number }
  depositsHeld: number
  expenses: { platformFee: number; maintenance: number; lotRent: number; enteredExpenses: number; total: number }
  net: number
}

/**
 * Compute a landlord's P&L for a date range. `periodMonths` are the YYYY-MM keys
 * the platform-fee accrual lookup needs (pass the months the range spans).
 */
export async function computeLandlordPL(
  landlordId: string,
  start: string,
  end: string,
  periodMonthKeys: string[],
): Promise<LandlordPL> {
  // Income — categorized from settled payments by actual settle date.
  // S654: the end is a whole day. `settled_at <= '2026-09-30'` meant midnight
  // at the START of the 30th, so a bare-date end dropped the last day's money.
  // `< end::date + 1` takes the whole day, for a bare date and for monthRange's
  // '...T23:59:59-07:00' alike.
  // S654: income is landlordIncomeSql's rows only, so a GAM fee, held
  // paid-ahead money or a FlexPay pull carrying this landlord_id is not theirs.
  const isIncome = landlordIncomeSql('p')
  const inc = await queryOne<any>(`
    SELECT
      COALESCE(SUM(p.amount) FILTER (WHERE ${isIncome} AND p.type='rent'), 0)::float                 AS rent,
      COALESCE(SUM(p.amount) FILTER (WHERE ${isIncome} AND p.type IN ('late_fee','fee')), 0)::float  AS fees,
      COALESCE(SUM(p.amount) FILTER (WHERE ${isIncome} AND p.type='utility'), 0)::float              AS utilities,
      COALESCE(SUM(p.amount) FILTER (WHERE ${isIncome} AND p.type='home_payment'), 0)::float         AS home_sale,
      COALESCE(SUM(p.amount) FILTER (WHERE ${isIncome} AND p.type='carried_balance'), 0)::float      AS balances,
      COALESCE(SUM(p.amount) FILTER (WHERE ${landlordDepositSql('p')}), 0)::float                    AS deposits
    FROM payments p
   WHERE p.landlord_id = $1 AND p.status = 'settled' AND p.settled_at >= $2 AND p.settled_at < ($3::date + 1)`,
    [landlordId, start, end])

  const rent = round2(+inc?.rent || 0)
  const fees = round2(+inc?.fees || 0)
  const utilities = round2(+inc?.utilities || 0)
  const homeSale = round2(+inc?.home_sale || 0)
  // S654: "Balances collected": pre-platform arrears and work-trade deficits.
  const balances = round2(+inc?.balances || 0)
  const depositsHeld = round2(+inc?.deposits || 0)
  // S605: income the landlord banked that GAM never collected — laundry, vending,
  // an insurance claim, cash rent deposited. Categorized off the bank feed. Until
  // this existed the P&L counted every expense but only GAM-collected income, so
  // it understated profit for any landlord with revenue outside the platform.
  const otherIncRow = await queryOne<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS c FROM landlord_other_income
     WHERE landlord_id = $1 AND status = 'active' AND income_date >= $2::date AND income_date <= $3::date`,
    [landlordId, String(start).slice(0, 10), String(end).slice(0, 10)])
  const otherIncome = round2(+otherIncRow?.c || 0)

  const other = round2(fees + utilities + homeSale + balances + otherIncome)
  const grossTotal = round2(rent + other)

  // Expenses.
  const feeMap = await platformFeesByProperty(landlordId, periodMonthKeys)
  const platformFee = round2(Array.from(feeMap.values()).reduce((s, v) => s + v, 0))

  const maintRow = await queryOne<any>(`
    SELECT COALESCE(SUM(actual_cost), 0)::float AS c FROM maintenance_requests
     WHERE landlord_id = $1 AND completed_at >= $2 AND completed_at < ($3::date + 1) AND actual_cost IS NOT NULL`,
    [landlordId, start, end])
  const maintenance = round2(+maintRow?.c || 0)

  const lotRow = await queryOne<any>(`
    SELECT COALESCE(SUM(amount), 0)::float AS c FROM lot_rent_charges
     WHERE landlord_id = $1 AND billing_month >= $2::date AND billing_month <= $3::date`,
    [landlordId, start, end])
  const lotRent = round2(+lotRow?.c || 0)

  const enteredExpenses = await landlordExpensesTotal(landlordId, String(start).slice(0, 10), String(end).slice(0, 10))

  const expensesTotal = round2(platformFee + maintenance + lotRent + enteredExpenses)

  return {
    gross: { rent, fees, utilities, homeSale, balances, otherIncome, other, total: grossTotal },
    depositsHeld,
    expenses: { platformFee, maintenance, lotRent, enteredExpenses, total: expensesTotal },
    net: round2(grossTotal - expensesTotal),
  }
}

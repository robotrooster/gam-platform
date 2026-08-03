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

export interface LandlordPL {
  gross: { rent: number; fees: number; utilities: number; homeSale: number; other: number; total: number }
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
  const inc = await queryOne<any>(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE type='rent'), 0)::float           AS rent,
      COALESCE(SUM(amount) FILTER (WHERE type IN ('late_fee','fee')), 0)::float AS fees,
      COALESCE(SUM(amount) FILTER (WHERE type='utility'), 0)::float        AS utilities,
      COALESCE(SUM(amount) FILTER (WHERE type='home_payment'), 0)::float   AS home_sale,
      COALESCE(SUM(amount) FILTER (WHERE type='deposit'), 0)::float        AS deposits
      -- platform_fee / float_fee excluded: GAM revenue, not landlord income.
    FROM payments
   WHERE landlord_id = $1 AND status = 'settled' AND settled_at >= $2 AND settled_at <= $3`,
    [landlordId, start, end])

  const rent = round2(+inc?.rent || 0)
  const fees = round2(+inc?.fees || 0)
  const utilities = round2(+inc?.utilities || 0)
  const homeSale = round2(+inc?.home_sale || 0)
  const depositsHeld = round2(+inc?.deposits || 0)
  const other = round2(fees + utilities + homeSale)
  const grossTotal = round2(rent + other)

  // Expenses.
  const feeMap = await platformFeesByProperty(landlordId, periodMonthKeys)
  const platformFee = round2(Array.from(feeMap.values()).reduce((s, v) => s + v, 0))

  const maintRow = await queryOne<any>(`
    SELECT COALESCE(SUM(actual_cost), 0)::float AS c FROM maintenance_requests
     WHERE landlord_id = $1 AND completed_at >= $2 AND completed_at <= $3 AND actual_cost IS NOT NULL`,
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
    gross: { rent, fees, utilities, homeSale, other, total: grossTotal },
    depositsHeld,
    expenses: { platformFee, maintenance, lotRent, enteredExpenses, total: expensesTotal },
    net: round2(grossTotal - expensesTotal),
  }
}

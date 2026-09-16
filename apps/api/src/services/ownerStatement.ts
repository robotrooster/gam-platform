/**
 * S644 — WHAT AN OWNER IS TOLD, AND WHAT THEY ARE PAID.
 *
 * Nic (S644): a property manager is onboarding with roughly 11,000 units across
 * Texas, Oklahoma and Georgia. "He has other owners that get their reports and
 * things like that, and their payments." The payments were already built — see
 * services/allocation.ts, which splits every settled rent into a PM cut, an
 * owner share and GAM's spread. The REPORT did not exist at all.
 *
 * WHERE THE NUMBERS COME FROM. Nothing here is recomputed from rent amounts or
 * lease terms, because a statement that disagrees with what actually moved is
 * worse than no statement. Every figure is read from the record of the money:
 *
 *   income     — user_balance_ledger 'allocation_owner_share', written at the
 *                moment a payment settled. This is the owner's money, after the
 *                manager and GAM have taken theirs, and it is the only number
 *                the owner's bank will ever agree with.
 *   gross      — the settled payments those allocations came from, so the owner
 *                can see what the resident actually paid before anyone's cut.
 *   manager    — everything the manager charged, in both the shapes a fee plan
 *                can take: 'allocation_pm_company_fee' on the balance ledger for
 *                a percent-of-rent plan (taken per payment, at settlement), plus
 *                pm_monthly_fee_accruals for a flat-monthly or per-unit plan
 *                (taken once, on the 1st). Reading only the first reported a
 *                manager on a per-unit plan as charging nothing.
 *
 *                Nic (S646): "The property manager sets the percentage or flat
 *                rate or per-unit count, that price. So the owner sees what the
 *                property manager sets on the owner's statement." One number,
 *                whatever shape their plan is.
 *   expenses   — landlord_expenses, which is where a bill paid on the owner's
 *                behalf is recorded. Voided rows are excluded, never netted.
 *
 * WHAT IS NOT ON IT. GAM's own per-unit fee. Nic (S644, DIRECTIVE): with this
 * manager GAM bills "the PM company — one bill" for every occupied unit across
 * all their owners. That is an agreement between GAM and the manager; whether
 * the manager passes it through to an owner is the manager's business and shows
 * up, if at all, as one of their own expense lines. Printing it here would state
 * a charge the owner does not owe us.
 *
 * THE MONTH. Keyed off when the allocation was written, which is settlement —
 * the same convention collectedRentMtd uses, for the same reason: a payment that
 * is still processing has not paid anybody yet.
 */

import { query } from '../db'
import { round2 } from './workTradeCredit'

export interface OwnerStatementProperty {
  propertyId: string
  propertyName: string
  /** What residents actually paid on this property, before anyone's cut. */
  grossCollected: number
  /** The owner's share of it, as allocated at settlement. */
  ownerShare: number
  /** What management took. */
  managementFee: number
  /** Bills paid on the owner's behalf this month. */
  expenses: number
  /** ownerShare - expenses. What the month was worth to them. */
  net: number
  expenseLines: Array<{
    date: string; category: string; amount: number
    description: string | null; vendor: string | null
  }>
}

export interface OwnerStatement {
  landlordId: string
  pmCompanyId: string | null
  /** ISO first-of-month. */
  periodMonth: string
  properties: OwnerStatementProperty[]
  totals: {
    grossCollected: number
    ownerShare: number
    managementFee: number
    expenses: number
    net: number
  }
}

/** ISO first-of-month for the month containing `month` (accepts 'YYYY-MM' too). */
export function monthStart(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month)
  if (!m) throw new Error(`ownerStatement: unrecognised month "${month}"`)
  return `${m[1]}-${m[2]}-01`
}

/**
 * Build one owner's statement for one month.
 *
 * `pmCompanyId` narrows to the properties that manager runs for this owner —
 * an owner with parks under two managers gets two statements, because they get
 * two sets of fees and two people to ask about them. Omit it for the owner's
 * whole portfolio.
 */
export async function ownerStatement(opts: {
  landlordId: string
  periodMonth: string
  pmCompanyId?: string | null
}): Promise<OwnerStatement> {
  const start = monthStart(opts.periodMonth)
  const pmId = opts.pmCompanyId ?? null

  // One pass over the properties in scope, with the money attached. Written as
  // one query rather than a loop because this runs for a manager with thousands
  // of units: a per-property round trip is how a report becomes a timeout.
  const rows = await query<any>(
    `WITH scope AS (
       SELECT p.id, p.name, p.owner_user_id
         FROM properties p
        WHERE p.landlord_id = $1
          AND ($3::uuid IS NULL OR p.pm_company_id = $3::uuid)
     ),
     money AS (
       SELECT l.property_id,
              SUM(CASE WHEN l.type = 'allocation_owner_share'    THEN l.amount ELSE 0 END) AS owner_share,
              SUM(CASE WHEN l.type = 'allocation_pm_company_fee' THEN l.amount ELSE 0 END) AS pm_fee
         FROM user_balance_ledger l
         JOIN scope s ON s.id = l.property_id
        WHERE l.created_at >= $2::date
          AND l.created_at <  ($2::date + INTERVAL '1 month')
          AND l.type IN ('allocation_owner_share','allocation_pm_company_fee')
        GROUP BY l.property_id
     ),
     gross AS (
       -- What the resident paid, before anyone's cut.
       --
       -- SETTLED MONEY ONLY — deliberately narrower than the live dashboards,
       -- which count 'processing' so a landlord can see money on its way. A
       -- statement is not a dashboard. Rent still in flight has not been split
       -- yet, so counting it here would print "collected $1,000, your share $0"
       -- and read as though management took the lot. Gross and owner share have
       -- to describe the SAME money or the document argues with itself. An
       -- in-flight payment lands on the statement for the month it settles,
       -- which is also the month the owner's bank sees it.
       SELECT u.property_id,
              SUM(pay.amount) AS gross_collected
         FROM payments pay
         JOIN units u ON u.id = pay.unit_id
         JOIN scope s ON s.id = u.property_id
        WHERE pay.status IN ('settled','paid_via_deposit')
          AND COALESCE(pay.settled_at, pay.created_at) >= $2::date
          AND COALESCE(pay.settled_at, pay.created_at) <  ($2::date + INTERVAL '1 month')
        GROUP BY u.property_id
     ),
     monthly_fee AS (
       -- The other half of what a manager charges. A percent-of-rent plan is
       -- taken per payment and lands on the balance ledger above; a flat or
       -- per-unit plan is taken once a month and lands here. An owner's
       -- statement has to add both or it understates their manager's price.
       SELECT a.property_id, SUM(a.total_amount) AS monthly_fee
         FROM pm_monthly_fee_accruals a
         JOIN scope s ON s.id = a.property_id
        WHERE a.accrual_month = $2::date
          AND ($3::uuid IS NULL OR a.pm_company_id = $3::uuid)
        GROUP BY a.property_id
     ),
     spend AS (
       SELECT e.property_id, SUM(e.amount) AS expenses
         FROM landlord_expenses e
         JOIN scope s ON s.id = e.property_id
        WHERE e.status = 'active' AND e.voided_at IS NULL
          AND e.expense_date >= $2::date
          AND e.expense_date <  ($2::date + INTERVAL '1 month')
        GROUP BY e.property_id
     )
     SELECT s.id AS property_id, s.name AS property_name,
            COALESCE(g.gross_collected, 0)::float AS gross_collected,
            COALESCE(m.owner_share, 0)::float     AS owner_share,
            COALESCE(m.pm_fee, 0)::float          AS pm_fee,
            COALESCE(sp.expenses, 0)::float       AS expenses,
            COALESCE(mf.monthly_fee, 0)::float    AS monthly_fee
       FROM scope s
       LEFT JOIN money m  ON m.property_id  = s.id
       LEFT JOIN gross g  ON g.property_id  = s.id
       LEFT JOIN spend sp ON sp.property_id = s.id
       LEFT JOIN monthly_fee mf ON mf.property_id = s.id
      ORDER BY s.name`,
    [opts.landlordId, start, pmId])

  // Expense detail, separately. An owner disputing a statement disputes a LINE
  // ("what was this $1,400?"), so the total alone is not a usable answer.
  const expenseRows = await query<any>(
    `SELECT e.property_id, e.expense_date::text AS date, e.category,
            e.amount::float AS amount, e.description, e.vendor
       FROM landlord_expenses e
       JOIN properties p ON p.id = e.property_id
      WHERE p.landlord_id = $1
        AND ($3::uuid IS NULL OR p.pm_company_id = $3::uuid)
        AND e.status = 'active' AND e.voided_at IS NULL
        AND e.expense_date >= $2::date
        AND e.expense_date <  ($2::date + INTERVAL '1 month')
      ORDER BY e.expense_date, e.created_at`,
    [opts.landlordId, start, pmId])

  const linesByProperty = new Map<string, OwnerStatementProperty['expenseLines']>()
  for (const e of expenseRows) {
    const list = linesByProperty.get(e.property_id) ?? []
    list.push({
      date: e.date, category: e.category, amount: Number(e.amount),
      description: e.description ?? null, vendor: e.vendor ?? null,
    })
    linesByProperty.set(e.property_id, list)
  }

  const properties: OwnerStatementProperty[] = rows.map((r: any) => {
    const ownerShare = round2(Number(r.owner_share))
    const expenses = round2(Number(r.expenses))
    return {
      propertyId: r.property_id,
      propertyName: r.property_name,
      grossCollected: round2(Number(r.gross_collected)),
      ownerShare,
      managementFee: round2(Number(r.pm_fee) + Number(r.monthly_fee)),
      expenses,
      net: round2(ownerShare - expenses),
      expenseLines: linesByProperty.get(r.property_id) ?? [],
    }
  })

  const sum = (pick: (p: OwnerStatementProperty) => number) =>
    round2(properties.reduce((s, p) => s + pick(p), 0))

  return {
    landlordId: opts.landlordId,
    pmCompanyId: pmId,
    periodMonth: start,
    properties,
    totals: {
      grossCollected: sum(p => p.grossCollected),
      ownerShare: sum(p => p.ownerShare),
      managementFee: sum(p => p.managementFee),
      expenses: sum(p => p.expenses),
      net: sum(p => p.net),
    },
  }
}

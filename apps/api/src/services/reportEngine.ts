// ============================================================
// REPORT ENGINE (S603, Nic) — "we should be able to generate reports for any
// combination of events and timelines and tables."
//
// One engine, three knobs:
//   • range  — any start/end date, not just whole months
//   • level  — portfolio | property | unit
//   • bucket — total | monthly | daily
//
// Every report a landlord wants becomes a PRESET over these knobs rather than
// its own endpoint. A trailing-twelve (T-12) for a listing agent is just
// {range: last 12 months, level: 'property', bucket: 'monthly'}. Cost-per-unit
// operating review is {level: 'unit', bucket: 'monthly'}.
//
// DELIBERATELY NOT a free-form "any table, any join" query builder. That shape
// lets one bad query take the database down and lets a caller reach rows that
// aren't theirs — the exact thing gam-audience-data-isolation forbids. Instead a
// FIXED catalog of measures is computed from scoped, parameterized SQL.
//
// DEFINITIONS ARE BORROWED, NOT REINVENTED. Income categorization matches
// services/landlordPL.ts exactly (deposits are a HELD LIABILITY and never
// income; GAM's platform/float fees are GAM revenue and never landlord income),
// and entered expenses match services/landlordExpenses.ts (active only, with
// common costs allocated per unit). If those definitions change, this must move
// with them or a landlord's reports will disagree with their own Books.
// ============================================================
// 10/12 (Nic, ledger P6, L5): which expenses count as a cost, and a repair's cost once (lib/liveExpense).
import { liveExpenseSql, maintenanceCostNotBilledSql } from '../lib/liveExpense'
import type { IncomeBasis } from '@gam/shared'
import { query } from '../db'
import { platformFeesByPropertyForEntities } from './platformFee'
import { processingFeesByProperty } from './landlordPL'
import { cardFeesRefundedByProperty } from './incomeBasis'
import { incomeEvents, ledgerOwedDay, REPORT_LINES, type ReportLine } from './incomeBasis'
// 10/12 (Nic, ledger P8): once the companies' books are live, the expenses come from them.
import { ledgerReportsLive, ledgerExpenseRows } from './ledgerReports'
import type { MoneyColumns } from './incomeBasis'

/** Every month a range touches, as 'YYYY-MM-01' — the key format the
 *  platform-fee accrual lookup expects. A range landing mid-month still bills
 *  that whole month, because the accrual itself is monthly. */
function monthKeysInRange(start: string, end: string): string[] {
  const out: string[] = []
  const s = new Date(start + 'T00:00:00Z')
  const e = new Date(end + 'T00:00:00Z')
  const cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1))
  while (cur <= e) {
    out.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-01`)
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }
  return out
}

export type ReportLevel  = 'portfolio' | 'property' | 'unit'
export type ReportBucket = 'total' | 'monthly' | 'daily'

export const REPORT_LEVELS:  readonly ReportLevel[]  = ['portfolio', 'property', 'unit'] as const
export const REPORT_BUCKETS: readonly ReportBucket[] = ['total', 'monthly', 'daily'] as const

export interface ReportQuery {
  /** S633: every entity the ACCOUNT owns. A report is about the account, so it
   *  spans them; scoped to one, every figure silently omitted the other
   *  company's money. Team roles pass their single id as a one-element array. */
  landlordIds:  string[]
  start:        string              // YYYY-MM-DD inclusive
  end:          string              // YYYY-MM-DD inclusive
  level:        ReportLevel
  bucket:       ReportBucket
  /** Property-scope filter. null = unrestricted (owner/admin); an array limits
   *  to those properties — this is how a scoped team member's reports stay
   *  inside their assignment. An EMPTY array means "sees nothing". */
  propertyIds?: string[] | null
  /** S655: "Money received" (default) or "Money billed" — services/incomeBasis. */
  basis?: IncomeBasis
}

export interface ReportRow {
  period:       string | null       // 'YYYY-MM' | 'YYYY-MM-DD' | null when bucket='total'
  propertyId:   string | null
  propertyName: string | null
  unitId:       string | null
  unitNumber:   string | null
  /** S654: other = everything without its own field: "Balances collected"
   *  (carried_balance: pre-platform arrears and work-trade deficits) and, S655,
   *  paid ahead, register sales and stays, other income, kept from deposits and
   *  the negatives (returned, stay shortened, credits given). fees includes
   *  late fees. `lines` has every line on its own. */
  income: {
    rent: number; fees: number; utilities: number; homeSale: number; other: number; total: number
    lines: Record<ReportLine, number>
  }
  expenses: {
    maintenance: number
    entered:     number
    byCategory:  Record<string, number>
    platformFee: number
    /** S655: lot rent an investor-operator owes the park, by billing month (the P&L's own). */
    lotRent:     number
    /** 10/11: payment processing fees the landlord covers for tenants, by the day the payment settled (the P&L's own). */
    processingFees: number
    /** 10/12 (Nic, G10): card fees guests got back with refunds of card sales, by the refund day (the P&L's own). */
    cardFeesRefunded: number
    total:       number
    /**
     * 10/12 (Nic, ledger P8): on the books, the expenses PAID in the bucket
     * (the P&L's Received-based expenses); the row's net takes it, as the
     * P&L's "Net on received" does. Company and property rows of a monthly or
     * whole-range report only (a day's or a unit's share of what was paid is
     * not worked out); absent on the money records.
     */
    paid?: number
  }
  net:           number
  /**
   * 10/12 (Nic): Charged / Received / Owed side by side. received = the
   * income above (money on the day it arrived); charged = the bills due in
   * the bucket, less credits given; owed = what of those bills is still owed
   * today. netCharged = charged less the same expenses.
   */
  money:         MoneyColumns
  netCharged:    number
  occupiedUnits: number
  derived: {
    netPerUnit:    number | null
    costPerUnit:   number | null
    incomePerUnit: number | null
    costPerDay:    number
    netPerDay:     number
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Grouping SQL fragments ────────────────────────────────────────────────
// Both are built from a CLOSED set of literals (never caller input), so they are
// safe to interpolate; every real value stays parameterized.
function bucketExpr(bucket: ReportBucket, dateCol: string): string {
  if (bucket === 'monthly') return `to_char(${dateCol}, 'YYYY-MM')`
  if (bucket === 'daily')   return `to_char(${dateCol}, 'YYYY-MM-DD')`
  return `NULL::text`
}

function keyOf(period: string | null, propertyId: string | null, unitId: string | null): string {
  return `${period ?? '-'}|${propertyId ?? '-'}|${unitId ?? '-'}`
}

function emptyRow(period: string | null, propertyId: string | null, unitId: string | null): ReportRow {
  return {
    period, propertyId, propertyName: null, unitId, unitNumber: null,
    income:   { rent: 0, fees: 0, utilities: 0, homeSale: 0, other: 0, total: 0,
                lines: Object.fromEntries(REPORT_LINES.map(l => [l, 0])) as Record<ReportLine, number> },
    expenses: { maintenance: 0, entered: 0, byCategory: {}, platformFee: 0, lotRent: 0, processingFees: 0, cardFeesRefunded: 0, total: 0 },
    net: 0, money: { charged: 0, received: 0, owed: 0 }, netCharged: 0, occupiedUnits: 0,
    derived: { netPerUnit: null, costPerUnit: null, incomePerUnit: null, costPerDay: 0, netPerDay: 0 },
  }
}

/** The engine's buckets as day spans ('total': the whole range). */
function bucketSpans(start: string, end: string, bucket: ReportBucket): Array<{ period: string | null; from: string; to: string }> {
  if (bucket === 'total') return [{ period: null, from: start, to: end }]
  const out: Array<{ period: string | null; from: string; to: string }> = []
  if (bucket === 'monthly') {
    for (const m of monthKeysInRange(start, end)) {
      const from = m < start ? start : m
      const last = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10)
      out.push({ period: m.slice(0, 7), from, to: last > end ? end : last })
    }
    return out
  }
  for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10)
    out.push({ period: day, from: day, to: day })
  }
  return out
}

/** The engine's expense category for an expense account GAM seeded (by its posting role). */
const ENGINE_CATEGORY_OF_ROLE: Record<string, string> = {
  management_fees: 'management', bank_fees: 'bank_fees', mortgage_interest: 'mortgage_interest', insurance: 'insurance',
  property_taxes: 'property_tax', utilities_expense: 'utilities', landscaping: 'landscaping', professional_fees: 'professional',
  accounting_fees: 'professional', advertising: 'advertising', supplies: 'supplies', hoa_fees: 'hoa',
}

/**
 * 10/12 (Nic, ledger P8): sections 2-4 from the books — every expense account's
 * lines dated in the period (incurred), by bucket, property and unit:
 *   GAM platform fees      platformFee (a property's own, never split per unit)
 *   repairs and maintenance maintenance
 *   lot rent               lotRent
 *   every other account    entered, by the company's category (its starting
 *                          key; a category of its own, or an account no
 *                          category charges to, by the account's role, else 'other')
 * A cost on a property but no unit is split evenly across the property's units
 * at unit level (S603, as the money records were); a cost on no property is
 * the company's. The processing fees and card fees refunded are 4b's.
 */
async function ledgerEngineExpenses(o: {
  landlordIds: string[]; start: string; end: string; bucket: ReportBucket; wantProperty: boolean; wantUnit: boolean
  scoped: string[] | null; upsert: (period: string | null, propertyId: string | null, unitId: string | null) => ReportRow
}): Promise<void> {
  const rows = await query<{ period: string | null; property_id: string | null; unit_id: string | null; role: string | null; key: string | null; amount: number }>(`
    SELECT ${bucketExpr(o.bucket, 'l.accounting_date')} AS period, l.property_id, l.unit_id, l.account_role AS role,
           bc.system_key AS key, SUM(l.debit - l.credit)::float AS amount
      FROM ledger_posting_lines l
      JOIN books_accounts a ON a.id = l.account_id AND a.type = 'expense'
      LEFT JOIN books_categories bc ON l.map_kind = 'expense_category' AND bc.id::text = l.map_value
     WHERE l.landlord_id = ANY($1::uuid[]) AND l.accounting_date BETWEEN $2::date AND $3::date
       AND ($4::uuid[] IS NULL OR l.property_id = ANY($4::uuid[]))
       AND (l.account_role IS NULL OR l.account_role NOT IN ('processing_fees', 'card_fees_refunded'))
     GROUP BY 1, 2, 3, 4, 5
    HAVING SUM(l.debit - l.credit) <> 0`, [o.landlordIds, o.start, o.end, o.scoped])
  const unitsOf = new Map<string, string[]>()
  if (o.wantUnit) {
    const props = [...new Set(rows.filter(r => r.property_id && !r.unit_id).map(r => r.property_id!))]
    if (props.length) {
      for (const u of await query<{ id: string; property_id: string }>(
        `SELECT id, property_id FROM units WHERE property_id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[])`, [props, o.landlordIds])) {
        unitsOf.set(u.property_id, [...(unitsOf.get(u.property_id) ?? []), u.id])
      }
    }
  }
  for (const r of rows) {
    const add = (row: ReportRow, amt: number) => {
      const v = round2(amt)
      if (r.role === 'gam_platform_fees') row.expenses.platformFee = round2(row.expenses.platformFee + v)
      else if (r.role === 'repairs_maintenance' && !r.key) row.expenses.maintenance = round2(row.expenses.maintenance + v)
      else if (r.role === 'lot_rent_expense') row.expenses.lotRent = round2(row.expenses.lotRent + v)
      else {
        const k = r.key ?? (r.role ? ENGINE_CATEGORY_OF_ROLE[r.role] : null) ?? 'other'
        row.expenses.byCategory[k] = round2((row.expenses.byCategory[k] ?? 0) + v)
        row.expenses.entered = round2(row.expenses.entered + v)
      }
    }
    if (!o.wantProperty) { add(o.upsert(r.period, null, null), r.amount); continue }
    if (!o.wantUnit || r.unit_id || !r.property_id || r.role === 'gam_platform_fees') {
      add(o.upsert(r.period, r.property_id, o.wantUnit ? r.unit_id : null), r.amount)
      continue
    }
    const units = unitsOf.get(r.property_id) ?? []
    if (!units.length) { add(o.upsert(r.period, r.property_id, null), r.amount); continue }
    for (const u of units) add(o.upsert(r.period, r.property_id, u), r.amount / units.length)
  }
}

export async function runReport(q: ReportQuery): Promise<{ rows: ReportRow[]; totals: ReportRow; source?: 'ledger' }> {
  const { landlordIds, start, end, level, bucket } = q
  const scoped = q.propertyIds ?? null
  // A caller scoped to zero properties sees nothing — same lockdown posture as
  // the read guards elsewhere, rather than silently falling back to everything.
  if (scoped && scoped.length === 0) {
    return { rows: [], totals: emptyRow(null, null, null) }
  }

  const wantProperty = level === 'property' || level === 'unit'
  const wantUnit     = level === 'unit'
  const rows = new Map<string, ReportRow>()

  const upsert = (period: string | null, propertyId: string | null, unitId: string | null): ReportRow => {
    const k = keyOf(period, propertyId, unitId)
    let r = rows.get(k)
    if (!r) { r = emptyRow(period, propertyId, unitId); rows.set(k, r) }
    return r
  }

  // ── 1. INCOME — services/incomeBasis, the one set of money facts ──────────
  // S655: every landlord report reads the same facts under the same switch.
  // Money received (default): each bill's own new money on the day it settled,
  // paid-ahead money on the day it arrived, register sales, other income; a
  // credit the landlord gave is never income. Money billed: each bill in the
  // month it was due. Deposits are a held liability and never income; GAM's
  // fees and FlexPay pulls are never the landlord's. Facts are dated on the
  // property's own calendar day.
  // 10/12 (Nic): the income columns are Money received (the day money
  // arrived); the Charged and Owed columns beside them come from the Money
  // billed facts for the same days and scope, bucketed by each bill's due day.
  // A caller passing basis 'billed' still gets the billed income figures (the
  // API no longer offers the switch).
  const basis: IncomeBasis = q.basis ?? 'received'
  const [events, billedEvents] = await Promise.all([
    incomeEvents({ landlordIds, start, end, basis, propertyIds: scoped }),
    incomeEvents({ landlordIds, start, end, basis: 'billed', propertyIds: scoped }),
  ])
  // 10/12 (Nic, ledger P8): on the ledger, Owed is the receivables still open
  // at the end of each bucket's last day read (ledger 'owed' facts, one set per
  // month's end and the period's end) — never added across months.
  const periodOf = (day: string) => bucket === 'monthly' ? day.slice(0, 7) : bucket === 'daily' ? day : null
  // 10/12 (Nic, review): each bucket's day is the last day the books were
  // read on inside it (the days every 'owed' fact carries), not the last day
  // that happens to have something owed — a bucket that ends owing nothing
  // reads $0, never an earlier day's balance.
  const lastOwed = new Map<string | null, string>()
  const startDay = String(start).slice(0, 10), endDay = String(end).slice(0, 10)
  const seenDays = new Set<readonly string[]>()
  const markOwedDay = (d: string) => {
    if (d < startDay || d > endDay) return
    const k = periodOf(d)
    const was = lastOwed.get(k)
    if (!was || d > was) lastOwed.set(k, d)
  }
  for (const e of billedEvents) {
    if (e.ledger !== 'owed') continue
    if (e.owedDays) {
      if (seenDays.has(e.owedDays)) continue
      seenDays.add(e.owedDays)
      for (const d of e.owedDays) markOwedDay(d)
    } else markOwedDay(e.day)
  }
  for (const e of billedEvents) {
    if (e.ledger === 'owed') {
      if (e.day !== lastOwed.get(periodOf(e.day))) continue
      const row = upsert(periodOf(e.day), wantProperty ? e.propertyId : null, wantUnit ? e.unitId : null)
      row.money.owed = round2(row.money.owed + e.amount)
      continue
    }
    if (!e.inTotal || !(REPORT_LINES as readonly string[]).includes(e.line)) continue
    const period = periodOf(e.day)
    const row = upsert(period, wantProperty ? e.propertyId : null, wantUnit ? e.unitId : null)
    row.money.charged = round2(row.money.charged + e.amount)
    if (e.part === 'stillOwed') row.money.owed = round2(row.money.owed + e.amount)
  }
  for (const e of events) {
    if (!e.inTotal) continue
    const period = bucket === 'monthly' ? e.day.slice(0, 7) : bucket === 'daily' ? e.day : null
    const row = upsert(period, wantProperty ? e.propertyId : null, wantUnit ? e.unitId : null)
    const amt = e.amount
    row.income.lines[e.line as ReportLine] = round2(row.income.lines[e.line as ReportLine] + amt)
    if (e.line === 'rent') row.income.rent = round2(row.income.rent + amt)
    else if (e.line === 'fees' || e.line === 'lateFees') row.income.fees = round2(row.income.fees + amt)
    else if (e.line === 'utilities') row.income.utilities = round2(row.income.utilities + amt)
    else if (e.line === 'homeSale') row.income.homeSale = round2(row.income.homeSale + amt)
    else row.income.other = round2(row.income.other + amt)
  }

  // 10/12 (Nic, ledger P8): once every company of the report reads its books,
  // sections 2-4 come from the expense accounts instead (ledgerEngineExpenses,
  // below 4); the processing fees and card fees refunded (4b) read the books
  // by themselves.
  const onBooks = await ledgerReportsLive(landlordIds)

  // ── 2. MAINTENANCE — real repair spend, dated by completion ───────────────
  // actual_cost only: an ESTIMATE is not money spent, and including estimates
  // would let an unapproved quote show up as a cost on a T-12.
  const maintSql = `
    SELECT ${bucketExpr(bucket, 'mr.completed_at')} AS period,
           ${wantProperty ? 'u.property_id' : 'NULL::uuid'} AS property_id,
           ${wantUnit ? 'mr.unit_id' : 'NULL::uuid'} AS unit_id,
           COALESCE(SUM(mr.actual_cost), 0)::float AS maintenance
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
     WHERE mr.landlord_id = ANY($1::uuid[])
       AND mr.actual_cost IS NOT NULL
       AND ${maintenanceCostNotBilledSql('mr')}
       AND mr.completed_at IS NOT NULL
       AND mr.completed_at >= $2::date
       AND mr.completed_at < ($3::date + INTERVAL '1 day')
       AND ($4::uuid[] IS NULL OR u.property_id = ANY($4))
     GROUP BY 1, 2, 3`
  for (const r of onBooks ? [] : await query<any>(maintSql, [landlordIds, start, end, scoped])) {
    upsert(r.period, r.property_id, r.unit_id).expenses.maintenance = round2(+r.maintenance)
  }

  // ── 3. ENTERED EXPENSES — by category, with common costs allocated ────────
  // At UNIT level, ANY cost not tied to a specific unit is split evenly across
  // that property's units — insurance, landscaping, property tax, all of it.
  //
  // S603 (Nic): this is how operators actually run the numbers. "If an expense
  // is not linked to one certain unit, it needs to be spread across all units.
  // There's no reason to just have it sit higher at a property level and not get
  // factored into a per-unit cost." Pre-S603 only costs the landlord had ticked
  // `allocate_per_unit` were spread, so an un-ticked insurance bill silently
  // vanished from per-unit cost and made every unit look cheaper to run than it
  // is — the exact number an owner uses to judge whether a unit earns its keep.
  // The flag is therefore no longer consulted for reporting.
  //
  // Divided by ALL units on the property, not just occupied ones: a vacant unit
  // still carries its share of insurance, and dividing by occupied units would
  // make costs spike as occupancy drops.
  //
  // Voided rows are excluded (status='active') — keep-everything means voided
  // rows persist, so a report must filter rather than assume deletion.
  const expenseSql = wantUnit
    ? `
    SELECT ${bucketExpr(bucket, 'e.expense_date')} AS period,
           tgt.property_id AS property_id,
           tgt.id AS unit_id,
           e.category,
           SUM(CASE WHEN e.unit_id = tgt.id THEN e.amount
                    ELSE e.amount / NULLIF(uc.n, 0) END)::float AS amount
      FROM landlord_expenses e
      JOIN units tgt ON tgt.property_id = e.property_id AND tgt.landlord_id = ANY($1::uuid[])
      JOIN LATERAL (SELECT COUNT(*)::int AS n FROM units u2 WHERE u2.property_id = e.property_id) uc ON TRUE
     WHERE e.landlord_id = ANY($1::uuid[])
       AND ${liveExpenseSql('e')}
       AND e.expense_date >= $2::date AND e.expense_date <= $3::date
       AND ($4::uuid[] IS NULL OR e.property_id = ANY($4))
       AND (e.unit_id = tgt.id OR e.unit_id IS NULL)
     GROUP BY 1, 2, 3, 4`
    : `
    SELECT ${bucketExpr(bucket, 'e.expense_date')} AS period,
           ${wantProperty ? 'e.property_id' : 'NULL::uuid'} AS property_id,
           NULL::uuid AS unit_id,
           e.category,
           SUM(e.amount)::float AS amount
      FROM landlord_expenses e
     WHERE e.landlord_id = ANY($1::uuid[])
       AND ${liveExpenseSql('e')}
       AND e.expense_date >= $2::date AND e.expense_date <= $3::date
       AND ($4::uuid[] IS NULL OR e.property_id = ANY($4))
     GROUP BY 1, 2, 3, 4`
  for (const r of onBooks ? [] : await query<any>(expenseSql, [landlordIds, start, end, scoped])) {
    const row = upsert(r.period, r.property_id, r.unit_id)
    const amt = round2(+r.amount)
    row.expenses.byCategory[r.category] = round2((row.expenses.byCategory[r.category] ?? 0) + amt)
    row.expenses.entered = round2(row.expenses.entered + amt)
  }

  // ── 3b. LOT RENT — what an investor-operator owes the park ───────────────
  // S655: the P&L subtracts lot rent (services/landlordPL: every charge whose
  // billing month falls in the range — a bill owed is that month's cost), and
  // so do the tax summary and the property report. Without it here a T-12's
  // net disagreed with all three for any landlord who pays lot rent. Billed
  // by the month like the platform fee, so it sits on a monthly or total
  // bucket and never on a day (spreading it over days would invent
  // precision). At unit level it stays on its own unit: each charge is one
  // lot's.
  if (bucket !== 'daily' && !onBooks) {
    const lotSql = `
      SELECT ${bucket === 'monthly' ? "to_char(lrc.billing_month, 'YYYY-MM')" : 'NULL::text'} AS period,
             ${wantProperty ? 'lrc.property_id' : 'NULL::uuid'} AS property_id,
             ${wantUnit ? 'lrc.unit_id' : 'NULL::uuid'} AS unit_id,
             COALESCE(SUM(lrc.amount), 0)::float AS amount
        FROM lot_rent_charges lrc
       WHERE lrc.landlord_id = ANY($1::uuid[])
         AND lrc.billing_month >= $2::date AND lrc.billing_month <= $3::date
         AND ($4::uuid[] IS NULL OR lrc.property_id = ANY($4))
       GROUP BY 1, 2, 3`
    for (const r of await query<any>(lotSql, [landlordIds, start, end, scoped])) {
      const row = upsert(r.period, r.property_id, r.unit_id)
      row.expenses.lotRent = round2(row.expenses.lotRent + (+r.amount))
    }
  }

  // ── 4. GAM PLATFORM FEE — the landlord's real cost of the platform ────────
  // Sourced from the SAME accrual the landlord is actually billed from, so a
  // report can never quote a fee they weren't charged. Accrual is monthly per
  // property, so it can be placed on a monthly/total bucket but NOT a daily one
  // — spreading a monthly charge across days would invent precision that does
  // not exist. Daily reports therefore show platformFee 0 and say so upstream.
  if (bucket !== 'daily' && !onBooks) {
    const months = monthKeysInRange(start, end)
    // platformFeesByProperty returns Map<propertyId, total> SUMMED over whatever
    // months it is handed — it does not break out per month. So a monthly bucket
    // asks one month at a time; a total bucket asks once for the whole span.
    const batches: Array<{ period: string | null; months: string[] }> =
      bucket === 'monthly'
        ? months.map(m => ({ period: m.slice(0, 7), months: [m] }))
        : [{ period: null, months }]

    for (const b of batches) {
      const byProperty = await platformFeesByPropertyForEntities(landlordIds, b.months)
      for (const [propertyId, amount] of byProperty) {
        if (scoped && !scoped.includes(propertyId)) continue
        // At unit level this stays a PROPERTY-level charge (unitId null) rather
        // than being split across units: the $2/occupied-unit accrual already
        // reflects occupancy, so re-splitting it would double-count.
        const row = upsert(b.period, wantProperty ? propertyId : null, null)
        row.expenses.platformFee = round2(row.expenses.platformFee + amount)
      }
    }
  }

  if (onBooks) {
    await ledgerEngineExpenses({ landlordIds, start, end, bucket, wantProperty, wantUnit, scoped, upsert })
    // Company and property rows of a monthly or whole-range report (a day's
    // or a unit's share of what was paid is not worked out).
    if (!wantUnit && bucket !== 'daily') {
      for (const sp of bucketSpans(start, end, bucket)) {
        const paid = await ledgerExpenseRows({ landlordIds, propertyIds: scoped }, sp.from, sp.to)
        const byProp = new Map<string | null, number>()
        for (const r of paid) {
          const k = wantProperty ? r.propertyId : null
          byProp.set(k, (byProp.get(k) ?? 0) + r.paidCents)
        }
        for (const [propertyId, c] of byProp) {
          const row = upsert(sp.period, propertyId, null)
          row.expenses.paid = round2((row.expenses.paid ?? 0) + c / 100)
        }
      }
    }
  }

  // ── 4b. PAYMENT PROCESSING FEES THE LANDLORD COVERS ──────────────────────
  // 10/11: the P&L subtracts them (services/landlordPL processingFeesByProperty:
  // read from what allocation booked, dated the day the payment settled), so a
  // report's net must too or it disagrees with the P&L for any property that
  // covers its tenants' fee. Dated by day, so every bucket can carry them; one
  // call per bucket (a daily report is capped at 400 days). Like the platform
  // fee, a property-level charge: at unit level it is not split across units.
  {
    const spans: Array<{ period: string | null; from: string; to: string }> = []
    if (bucket === 'total') {
      spans.push({ period: null, from: start, to: end })
    } else if (bucket === 'monthly') {
      for (const m of monthKeysInRange(start, end)) {
        const from = m < start ? start : m
        const last = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10)
        spans.push({ period: m.slice(0, 7), from, to: last > end ? end : last })
      }
    } else {
      for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const day = d.toISOString().slice(0, 10)
        spans.push({ period: day, from: day, to: day })
      }
    }
    // A few spans at a time, so a long daily report does not ask one by one.
    for (let i = 0; i < spans.length; i += 8) {
      const chunk = spans.slice(i, i + 8)
      const maps = await Promise.all(chunk.map(sp => processingFeesByProperty(landlordIds, sp.from, sp.to, scoped)))
      // 10/12 (Nic, G10): the card fees guests got back with refunds — the
      // P&L subtracts them too, dated the refund day, at the property.
      const backs = await Promise.all(chunk.map(sp => cardFeesRefundedByProperty(landlordIds, sp.from, sp.to, scoped)))
      chunk.forEach((sp, j) => {
        for (const [propertyId, amount] of maps[j]) {
          if (!amount) continue
          const row = upsert(sp.period, wantProperty ? (propertyId || null) : null, null)
          row.expenses.processingFees = round2(row.expenses.processingFees + amount)
        }
        for (const [propertyId, amount] of backs[j]) {
          if (!amount) continue
          const row = upsert(sp.period, wantProperty ? (propertyId || null) : null, null)
          row.expenses.cardFeesRefunded = round2(row.expenses.cardFeesRefunded + amount)
        }
      })
    }
  }

  // ── 5. OCCUPANCY — denominator for every per-unit metric ──────────────────
  // Occupied = active + delinquent + suspended, matching the rent roll: rent is
  // owed under the lease regardless of payment behavior, and a unit being
  // evicted still counts. Point-in-time (as of the report run), which is why
  // per-unit figures on a historical range are labeled as current occupancy.
  const occSql = `
    SELECT ${wantProperty ? 'u.property_id' : 'NULL::uuid'} AS property_id,
           ${wantUnit ? 'u.id' : 'NULL::uuid'} AS unit_id,
           COUNT(*)::int AS occupied
      FROM units u
     WHERE u.landlord_id = ANY($1::uuid[])
       AND u.status IN ('active','delinquent','suspended')
       AND ($2::uuid[] IS NULL OR u.property_id = ANY($2))
     GROUP BY 1, 2`
  const occupancy = new Map<string, number>()
  for (const r of await query<any>(occSql, [landlordIds, scoped])) {
    occupancy.set(`${r.property_id ?? '-'}|${r.unit_id ?? '-'}`, r.occupied)
  }

  // ── 6. Labels, roll-ups, derived metrics ─────────────────────────────────
  const nameRows = await query<any>(
    `SELECT p.id AS property_id, p.name AS property_name, u.id AS unit_id, u.unit_number
       FROM properties p LEFT JOIN units u ON u.property_id = p.id
      WHERE p.landlord_id = ANY($1::uuid[])`, [landlordIds])
  const propName = new Map<string, string>()
  const unitName = new Map<string, string>()
  for (const n of nameRows) {
    propName.set(n.property_id, n.property_name)
    if (n.unit_id) unitName.set(n.unit_id, n.unit_number)
  }

  const days = Math.max(
    1,
    Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1,
  )

  const finalize = (r: ReportRow): ReportRow => {
    r.propertyName = r.propertyId ? (propName.get(r.propertyId) ?? null) : null
    r.unitNumber   = r.unitId ? (unitName.get(r.unitId) ?? null) : null
    r.income.total = round2(
      r.income.rent + r.income.fees + r.income.utilities + r.income.homeSale + r.income.other)
    r.expenses.total = round2(
      r.expenses.maintenance + r.expenses.entered + r.expenses.platformFee + r.expenses.lotRent
      + r.expenses.processingFees + r.expenses.cardFeesRefunded)
    // 10/12 (ledger P8): on the books (company and property rows), income
    // received less the expenses paid; a unit row, and the money records,
    // less the expenses of the bucket.
    if (onBooks && !wantUnit && bucket !== 'daily' && r.expenses.paid === undefined) r.expenses.paid = 0
    r.net = round2(r.income.total - (r.expenses.paid ?? r.expenses.total))
    r.money.received = r.income.total
    r.netCharged = round2(r.money.charged - r.expenses.total)
    if (r.occupiedUnits === 0) {
      r.occupiedUnits = r.unitId
        ? (occupancy.get(`${r.propertyId ?? '-'}|${r.unitId}`) ?? 0)
        : (occupancy.get(`${r.propertyId ?? '-'}|-`) ?? 0)
    }
    const n = r.occupiedUnits
    r.derived = {
      netPerUnit:    n > 0 ? round2(r.net / n) : null,
      costPerUnit:   n > 0 ? round2(r.expenses.total / n) : null,
      incomePerUnit: n > 0 ? round2(r.income.total / n) : null,
      costPerDay:    round2(r.expenses.total / days),
      netPerDay:     round2(r.net / days),
    }
    return r
  }

  const out = [...rows.values()].map(finalize)
  out.sort((a, b) =>
    (a.period ?? '').localeCompare(b.period ?? '')
    || (a.propertyName ?? '').localeCompare(b.propertyName ?? '')
    || (a.unitNumber ?? '').localeCompare(b.unitNumber ?? ''))

  // Portfolio totals across every row, so a caller never re-adds them (and can
  // never get a different answer than the engine did).
  const totals = emptyRow(null, null, null)
  for (const r of out) {
    totals.income.rent      += r.income.rent
    totals.income.fees      += r.income.fees
    totals.income.utilities += r.income.utilities
    totals.income.homeSale  += r.income.homeSale
    totals.income.other     += r.income.other
    for (const l of REPORT_LINES) totals.income.lines[l] = round2(totals.income.lines[l] + r.income.lines[l])
    totals.expenses.maintenance += r.expenses.maintenance
    totals.expenses.entered     += r.expenses.entered
    totals.expenses.platformFee += r.expenses.platformFee
    totals.expenses.lotRent     += r.expenses.lotRent
    totals.expenses.processingFees += r.expenses.processingFees
    totals.expenses.cardFeesRefunded += r.expenses.cardFeesRefunded
    totals.money.charged = round2(totals.money.charged + r.money.charged)
    // 10/12 (ledger P8): on the books Owed is a balance, never added across
    // buckets — the last bucket's (below).
    if (!onBooks) totals.money.owed = round2(totals.money.owed + r.money.owed)
    if (r.expenses.paid !== undefined) totals.expenses.paid = round2((totals.expenses.paid ?? 0) + r.expenses.paid)
    for (const [cat, amt] of Object.entries(r.expenses.byCategory)) {
      totals.expenses.byCategory[cat] = round2((totals.expenses.byCategory[cat] ?? 0) + amt)
    }
  }
  if (onBooks) {
    // 10/12 (Nic, review): the receivables at the end of the report's last
    // day read, straight from the facts — not the last row's, which is an
    // earlier month when the last one owed and earned nothing.
    const owedAt = ledgerOwedDay(billedEvents, String(start).slice(0, 10), String(end).slice(0, 10))
    totals.money.owed = round2(billedEvents.filter(e => e.ledger === 'owed' && e.day === owedAt).reduce((x, e) => x + e.amount, 0))
  }
  // Occupancy is a point-in-time count of DISTINCT units — summing per-period
  // rows would multiply it by the number of periods.
  totals.occupiedUnits = [...occupancy.entries()]
    .filter(([k]) => (wantUnit ? !k.endsWith('|-') : k.endsWith('|-')))
    .reduce((s, [, v]) => s + v, 0)
  if (totals.occupiedUnits === 0) {
    totals.occupiedUnits = [...occupancy.values()].reduce((s, v) => s + v, 0)
  }

  return { rows: out, totals: finalize(totals), ...(onBooks ? { source: 'ledger' as const } : {}) }
}

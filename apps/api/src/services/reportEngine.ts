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
import { query } from '../db'
import { platformFeesByProperty, platformFeesByPropertyForEntities } from './platformFee'

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
}

export interface ReportRow {
  period:       string | null       // 'YYYY-MM' | 'YYYY-MM-DD' | null when bucket='total'
  propertyId:   string | null
  propertyName: string | null
  unitId:       string | null
  unitNumber:   string | null
  income: {
    rent: number; fees: number; utilities: number; homeSale: number; other: number; total: number
  }
  expenses: {
    maintenance: number
    entered:     number
    byCategory:  Record<string, number>
    platformFee: number
    total:       number
  }
  net:           number
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
    income:   { rent: 0, fees: 0, utilities: 0, homeSale: 0, other: 0, total: 0 },
    expenses: { maintenance: 0, entered: 0, byCategory: {}, platformFee: 0, total: 0 },
    net: 0, occupiedUnits: 0,
    derived: { netPerUnit: null, costPerUnit: null, incomePerUnit: null, costPerDay: 0, netPerDay: 0 },
  }
}

export async function runReport(q: ReportQuery): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
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

  // ── 1. INCOME — settled payments, dated by when money actually settled ────
  // Categorized exactly as landlordPL does. Deposits are EXCLUDED from income:
  // a deposit is the tenant's money held as a liability, not revenue. Counting
  // it would inflate a T-12 and mislead a buyer or lender reading it.
  const incomeSql = `
    SELECT ${bucketExpr(bucket, 'p.settled_at')} AS period,
           ${wantProperty ? 'u.property_id' : 'NULL::uuid'} AS property_id,
           ${wantUnit ? 'p.unit_id' : 'NULL::uuid'} AS unit_id,
           COALESCE(SUM(p.amount) FILTER (WHERE p.type='rent'), 0)::float              AS rent,
           COALESCE(SUM(p.amount) FILTER (WHERE p.type IN ('late_fee','fee')), 0)::float AS fees,
           COALESCE(SUM(p.amount) FILTER (WHERE p.type='utility'), 0)::float           AS utilities,
           COALESCE(SUM(p.amount) FILTER (WHERE p.type='home_payment'), 0)::float      AS home_sale,
           COALESCE(SUM(p.amount) FILTER (
             WHERE p.type NOT IN ('rent','late_fee','fee','utility','home_payment','deposit')
           ), 0)::float                                                                AS other
      FROM payments p
      LEFT JOIN units u ON u.id = p.unit_id
     WHERE p.landlord_id = ANY($1::uuid[])
       AND p.status = 'settled'
       AND p.settled_at >= $2::date
       AND p.settled_at < ($3::date + INTERVAL '1 day')
       AND ($4::uuid[] IS NULL OR u.property_id = ANY($4))
     GROUP BY 1, 2, 3`
  for (const r of await query<any>(incomeSql, [landlordIds, start, end, scoped])) {
    const row = upsert(r.period, r.property_id, r.unit_id)
    row.income.rent      = round2(+r.rent)
    row.income.fees      = round2(+r.fees)
    row.income.utilities = round2(+r.utilities)
    row.income.homeSale  = round2(+r.home_sale)
    row.income.other     = round2(+r.other)
  }

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
       AND mr.completed_at IS NOT NULL
       AND mr.completed_at >= $2::date
       AND mr.completed_at < ($3::date + INTERVAL '1 day')
       AND ($4::uuid[] IS NULL OR u.property_id = ANY($4))
     GROUP BY 1, 2, 3`
  for (const r of await query<any>(maintSql, [landlordIds, start, end, scoped])) {
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
       AND e.status = 'active'
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
       AND e.status = 'active'
       AND e.expense_date >= $2::date AND e.expense_date <= $3::date
       AND ($4::uuid[] IS NULL OR e.property_id = ANY($4))
     GROUP BY 1, 2, 3, 4`
  for (const r of await query<any>(expenseSql, [landlordIds, start, end, scoped])) {
    const row = upsert(r.period, r.property_id, r.unit_id)
    const amt = round2(+r.amount)
    row.expenses.byCategory[r.category] = round2((row.expenses.byCategory[r.category] ?? 0) + amt)
    row.expenses.entered = round2(row.expenses.entered + amt)
  }

  // ── 4. GAM PLATFORM FEE — the landlord's real cost of the platform ────────
  // Sourced from the SAME accrual the landlord is actually billed from, so a
  // report can never quote a fee they weren't charged. Accrual is monthly per
  // property, so it can be placed on a monthly/total bucket but NOT a daily one
  // — spreading a monthly charge across days would invent precision that does
  // not exist. Daily reports therefore show platformFee 0 and say so upstream.
  if (bucket !== 'daily') {
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
      r.expenses.maintenance + r.expenses.entered + r.expenses.platformFee)
    r.net = round2(r.income.total - r.expenses.total)
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
    totals.expenses.maintenance += r.expenses.maintenance
    totals.expenses.entered     += r.expenses.entered
    totals.expenses.platformFee += r.expenses.platformFee
    for (const [cat, amt] of Object.entries(r.expenses.byCategory)) {
      totals.expenses.byCategory[cat] = round2((totals.expenses.byCategory[cat] ?? 0) + amt)
    }
  }
  // Occupancy is a point-in-time count of DISTINCT units — summing per-period
  // rows would multiply it by the number of periods.
  totals.occupiedUnits = [...occupancy.entries()]
    .filter(([k]) => (wantUnit ? !k.endsWith('|-') : k.endsWith('|-')))
    .reduce((s, [, v]) => s + v, 0)
  if (totals.occupiedUnits === 0) {
    totals.occupiedUnits = [...occupancy.values()].reduce((s, v) => s + v, 0)
  }

  return { rows: out, totals: finalize(totals) }
}

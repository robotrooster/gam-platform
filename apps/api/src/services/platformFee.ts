import { query, queryOne } from '../db'

// Single source of truth for GAM's per-occupied-unit platform fee as it appears
// in any landlord-facing surface (Dashboard, Reports, property accounts). It
// mirrors what the billing cron (jobs/platformFeeAccrual.ts) actually charges,
// so every surface agrees with the bill.

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// First-of-month ISO strings ('YYYY-MM-01') covered by a period. Months that
// have not occurred yet are NEVER included: a future explicit month returns []
// (no fee), and a full-year view caps at the current month. A single past/
// current month → just that month; a full past year → all 12; the current year
// → Jan through the current month.
export function periodMonths(year: number, month: number | null, now: Date = new Date()): string[] {
  const curY = now.getFullYear()
  const curM = now.getMonth() + 1
  const mk = (m: number) => `${year}-${String(m).padStart(2, '0')}-01`
  const isFuture = (m: number) => year > curY || (year === curY && m > curM)
  if (month) return isFuture(month) ? [] : [mk(month)]
  const lastMonth = year < curY ? 12 : year > curY ? 0 : curM
  const out: string[] = []
  for (let m = 1; m <= lastMonth; m++) out.push(mk(m))
  return out
}

// GAM's platform-fee income for a landlord over a set of months, keyed by
// property.
//
// Source of truth: platform_fee_accruals.total_amount (written monthly by
// jobs/platformFeeAccrual.ts). For any month with no accrual row yet — the
// current in-progress month before the 1st-of-month cron, or environments
// without accrual history — fall back to a live estimate using the SAME billable
// basis the job uses: distinct units with a lease overlapping the month +
// CEIL(short-stay nights / 30), then MAX(rate × billable, min).
//
// PRICING (locked): $2 per billable unit, floored at the $10 PER-PROPERTY
// MINIMUM — full stop. A property is charged $10 for each month it has been ON
// THE PLATFORM (>= the month it was created), whether or not any unit is
// occupied. A property is NEVER charged for a month before it onboarded (a
// landlord who joins July 1 sees fees July-forward, nothing before) nor for a
// month that hasn't occurred yet (periodMonths excludes future months).
export async function platformFeesByProperty(
  landlordId: string,
  months: string[],
  propertyId?: string,
): Promise<Map<string, number>> {
  const fees = new Map<string, number>()
  if (months.length === 0) return fees
  const propFilter = propertyId ? 'AND p.id = $3' : ''
  const params: any[] = propertyId ? [landlordId, months, propertyId] : [landlordId, months]

  // Actual billed accruals for these months.
  const accr = await query<any>(`
    SELECT a.property_id, to_char(a.accrual_month, 'YYYY-MM-01') AS m, a.total_amount
      FROM platform_fee_accruals a
      JOIN properties p ON p.id = a.property_id
     WHERE a.landlord_id = $1 AND a.accrual_month = ANY($2::date[]) ${propFilter}`, params)
  const billed = new Map<string, number>()
  for (const r of accr) billed.set(`${r.property_id}|${r.m}`, parseFloat(r.total_amount))

  // Configured rate + minimum (same cascade as the accrual job). Defaults match
  // the launch model ($2/billable unit, $10/property minimum).
  const cfg = await queryOne<any>(`
    SELECT COALESCE(o.rate_per_unit, pfc.rate_per_unit)       AS rate,
           COALESCE(o.min_per_property, pfc.min_per_property) AS min
      FROM platform_fee_config pfc
      LEFT JOIN landlord_platform_fee_overrides o
             ON o.landlord_id = $1 AND o.effective_until IS NULL
     WHERE pfc.effective_until IS NULL
     LIMIT 1`, [landlordId])
  const rate = parseFloat(cfg?.rate ?? '2')
  const min  = parseFloat(cfg?.min ?? '10')

  // Per (property, month) billable for the live-estimate fallback. Only months
  // in which the property already existed (created_at) are billed.
  const est = await query<any>(`
    SELECT p.id AS property_id, to_char(m.month, 'YYYY-MM-01') AS m,
      (SELECT COUNT(DISTINCT l.unit_id)::int
         FROM leases l JOIN units u ON u.id = l.unit_id
        WHERE u.property_id = p.id AND l.status='active'
          AND l.start_date <= (m.month + INTERVAL '1 month' - INTERVAL '1 day')
          AND (l.end_date IS NULL OR l.end_date >= m.month)) AS long_term,
      COALESCE((SELECT SUM(GREATEST(
            LEAST(b.check_out, m.month + INTERVAL '1 month')::date
              - GREATEST(b.check_in, m.month)::date, 0))
         FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = p.id
          AND b.lease_type IN ('nightly','weekly')
          AND b.status NOT IN ('cancelled','no_show')
          AND b.check_in  < m.month + INTERVAL '1 month'
          AND b.check_out > m.month), 0)::int AS nights
      FROM properties p
      CROSS JOIN unnest($2::date[]) AS m(month)
     WHERE p.landlord_id = $1 ${propFilter}
       AND p.created_at < (m.month + INTERVAL '1 month')`, params)

  // Actual accruals are always counted — an accrual row means the property
  // existed and was billed that month.
  for (const [key, amount] of billed) {
    const propId = key.slice(0, key.indexOf('|'))
    fees.set(propId, round2((fees.get(propId) ?? 0) + amount))
  }
  // Fill in months that have NO accrual yet with the live estimate: $2 × billable
  // floored at the $10 property minimum — applied to every property for each
  // elapsed month it has been on the platform (the est query excludes
  // pre-onboarding months via created_at).
  for (const r of est) {
    const key = `${r.property_id}|${r.m}`
    if (billed.has(key)) continue
    const billable = parseInt(r.long_term, 10) + Math.ceil(parseInt(r.nights, 10) / 30)
    const fee = round2(Math.max(rate * billable, min))
    fees.set(r.property_id, round2((fees.get(r.property_id) ?? 0) + fee))
  }
  return fees
}

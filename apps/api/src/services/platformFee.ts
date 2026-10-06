import { query, queryOne } from '../db'
import { NIGHTS_AGGREGATION_UNIT_TYPES } from '@gam/shared'
import { soldCheckOutSql } from './registerStay'
import { feeCountedStaySql, feeCountedNightsStatusSql, occupiedSpacesSql } from './billableUnits'

// SQL literal list of the nights/30-aggregation unit types ('rv_spot').
// Short-stays on every OTHER type bill str_fee_pct of revenue instead.
// Compile-time constants from the shared catalog — safe to inline.
const AGG_TYPES_SQL = NIGHTS_AGGREGATION_UNIT_TYPES.map(t => `'${t}'`).join(',')

// Single source of truth for GAM's per-occupied-unit platform fee as it appears
// in any landlord-facing surface (Dashboard, Reports, property accounts). It
// mirrors what the billing cron (jobs/platformFeeAccrual.ts) actually charges,
// so every surface agrees with the bill.

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 10/3 (decisions #33) — A SHORT STAY'S REVENUE IN ONE MONTH, as SQL.
 *
 * Short stays on every type but the nights-aggregation ones bill str_fee_pct of
 * revenue, attributed to each month by nights. The stay is split by the length
 * it was SOLD for (services/registerStay soldCheckOutSql), never by an early
 * check-out: each month gets the nights the guest was on the site in it, and
 * the nights sold but not stayed (left early) count in the month the guest
 * left (the month of their last night). Dividing by the shortened stay counted
 * it less than once.
 *
 * The months add up to the stay's whole total ONLY when the check-out is
 * recorded in the same month the guest left (or before any month of the stay
 * is billed). Each month is billed once, from the check-out as it reads on
 * billing day, and is never re-billed. So a check-out recorded after its month
 * was billed, or an early check-out undone after a month was billed, counts the
 * stay more or less than once: e.g. a stay Oct 25 to Nov 10, checked out Oct 28,
 * October billed Nov 1, the check-out undone Nov 3, November billed Dec 1 —
 * October already took the unstayed nights, and November takes them again.
 * Fixing that needs a per-stay true-up (bill each month as the stay's share to
 * date, less what earlier months already billed for that stay); that is a
 * product choice for Nic, not made here.
 *
 * `b` is the unit_bookings alias; `monthStart` a SQL date expression for the
 * first of the month. The caller keeps its row filter (check_in before the
 * month ends, check_out after it starts) — every row this can give a share to
 * passes it.
 */
export function stayRevenueInMonthSql(b: string, monthStart: string): string {
  const sold = soldCheckOutSql(b)
  // The day they left (never past the length sold).
  const stayed = `LEAST(${b}.check_out, ${sold})`
  const start = `(${monthStart})::date`
  const end = `((${monthStart}) + INTERVAL '1 month')::date`
  return `(COALESCE(${b}.total_amount, 0)
      * (GREATEST(LEAST(${stayed}, ${end}) - GREATEST(${b}.check_in, ${start}), 0)
         + CASE WHEN ${stayed} > ${start} AND ${stayed} <= ${end}
                THEN GREATEST(${sold} - ${stayed}, 0) ELSE 0 END)::numeric
      / GREATEST(${sold} - ${b}.check_in, 1)::numeric)`
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
// basis the job uses: every space occupied in the month, once (leases, month
// stays, owner use, utility spaces — services/billableUnits occupiedSpacesSql)
// + CEIL(nightly and weekly nights / 30), then the per-payout-account floor.
//
// PRICING (locked): $2 per billable unit, floored at the $10 PER-PROPERTY
// MINIMUM — full stop. A property is charged $10 for each month it has been ON
// THE PLATFORM (>= the month it was created), whether or not any unit is
// occupied. A property is NEVER charged for a month before it onboarded (a
// landlord who joins July 1 sees fees July-forward, nothing before) nor for a
// month that hasn't occurred yet (periodMonths excludes future months).
/**
 * S633: the same map, across every entity an ACCOUNT owns.
 *
 * NOT a matter of widening the landlord_id filter to ANY(). The fee cascade
 * reads a PER-ENTITY override row (landlord_platform_fee_overrides) — two
 * companies can be on different rates, and one flattened query would silently
 * apply whichever override it happened to match to both. So this runs the real
 * per-entity calculation once per company and merges the results, which is safe
 * because the map is keyed by property and a property belongs to exactly one
 * entity.
 */
export async function platformFeesByPropertyForEntities(
  landlordIds: string[],
  months: string[],
  propertyId?: string,
): Promise<Map<string, number>> {
  const merged = new Map<string, number>()
  for (const id of landlordIds) {
    for (const [k, v] of await platformFeesByProperty(id, months, propertyId)) merged.set(k, v)
  }
  return merged
}

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
           COALESCE(o.min_per_connect_account, pfc.min_per_connect_account) AS min,
           COALESCE(o.str_fee_pct, pfc.str_fee_pct)           AS str_pct
      FROM platform_fee_config pfc
      LEFT JOIN landlord_platform_fee_overrides o
             ON o.landlord_id = $1 AND o.effective_until IS NULL
     WHERE pfc.effective_until IS NULL
     LIMIT 1`, [landlordId])
  const rate   = parseFloat(cfg?.rate ?? '2')
  const min    = parseFloat(cfg?.min ?? '10')

  // ── S637: THE ESTIMATE MUST NOT BILL WHAT THE ACCRUAL WOULD NOT ─────
  //
  // Nic: "the full year is wrong because we didn't have anybody in the
  // platform in August. So why would it show anything?"
  //
  // Two rules the accrual job obeys and this estimate did not, so reports
  // quoted fees that were never going to be charged.
  //
  // ONBOARDING GRACE (S600). billing_starts_at is NULL while a landlord is
  // still free — they pay nothing until they go live or hit the two-cycle cap.
  // The accrual path gates on `billing_starts_at IS NOT NULL AND <= month`
  // (jobs/platformFeeAccrual.ts:180). This estimated straight through it, so a
  // landlord who owes nothing at all was quoted a fee.
  // to_char, not a JS Date: node-postgres hands DATE back as a Date object, and
  // String(...).slice(0,10) on one yields "Sat Jan 01" — which compares as
  // LATER than every 'YYYY-MM-01' month string, so every month looked
  // pre-billing and every fee came back zero. Format it in SQL and the two
  // sides are the same shape by construction.
  const grace = await queryOne<{ starts: string | null }>(
    `SELECT to_char(billing_starts_at, 'YYYY-MM-01') AS starts
       FROM landlords WHERE id = $1`, [landlordId])
  const billingStarts = grace?.starts ?? null
  // S616 (Nic): 3%, down from 5%. The live figure comes from
  // platform_fee_config; this fallback only applies when no config row exists
  // at all, and it must not disagree with the seeded default or a fresh
  // install would quote one number and bill another.
  const strPct = parseFloat(cfg?.str_pct ?? '0.03')

  // Per (property, month) billable for the live-estimate fallback. Only months
  // in which the property already existed (created_at) are billed.
  const est = await query<any>(`
    SELECT p.id AS property_id, to_char(m.month, 'YYYY-MM-01') AS m,
      -- 10/5 (Nic): every space occupied in the month, ONCE — a lease, a
      -- month stay with no lease ("they get billed for october"), an
      -- owner-occupied space, a utility-service space — the bill's own rule
      -- (services/billableUnits occupiedSpacesSql), so the estimate quotes
      -- what the bill charges.
      --
      -- S653 (Nic): "me marking mobile home three at Mountain View as owner
      -- use... doesn't change the billing on the dashboard." Owner use is a
      -- unit STATUS, so it is only known for the present: counted for this
      -- month and later, never backdated onto a past month.
      --
      -- S614 (Nic): a space this landlord bills utilities for is an OCCUPIED
      -- UNIT — "it is technically a unit, so it needs to be billed at two
      -- dollars." Same two conditions the bill applies: the payer agreed or
      -- the landlord attested, and not a stay's own agreement (R11).
      (SELECT COUNT(*)::int FROM (${occupiedSpacesSql('p.id', 'm.month', {
        ownerUseWhen: `m.month >= date_trunc('month', CURRENT_DATE)`,
      })}) spaces) AS spaces,
      COALESCE((SELECT SUM(GREATEST(
            LEAST(b.check_out, m.month + INTERVAL '1 month')::date
              - GREATEST(b.check_in, m.month)::date, 0))
         FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = p.id
          AND u.unit_type IN (${AGG_TYPES_SQL})
          -- Which stays count by their nights, and by which status, is the
          -- bill's own rule (services/billableUnits): nightly and weekly only
          -- (10/5 — a month stay is a space, above); a stay cancelled on or
          -- after arrival still held the site.
          AND ${feeCountedStaySql('b', 'm.month')}
          AND ${feeCountedNightsStatusSql('b')}
          AND b.check_in  < m.month + INTERVAL '1 month'
          AND b.check_out > m.month), 0)::int AS nights,
      -- 10/3 (decisions #33): split by the length sold (stayRevenueInMonthSql).
      COALESCE((SELECT SUM(${stayRevenueInMonthSql('b', 'm.month')})
         FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE u.property_id = p.id
          AND u.unit_type NOT IN (${AGG_TYPES_SQL})
          AND ${feeCountedStaySql('b', 'm.month')}
          AND b.status NOT IN ('cancelled','no_show')
          AND b.check_in  < m.month + INTERVAL '1 month'
          AND b.check_out > m.month), 0) AS str_revenue
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
  // S630: the floor is per Connect PAYOUT ACCOUNT, not per property, so it can
  // only be applied once a whole month is in view — two properties earning $6
  // and $2 owe $10 between them, not $10 each. Estimated rows are gathered per
  // month first, then topped up to the floor exactly as the accrual job does.
  const perMonth = new Map<string, { total: number; rows: Array<{ prop: string; fee: number }> }>()
  for (const r of est) {
    const key = `${r.property_id}|${r.m}`
    if (billed.has(key)) continue
    // Still in onboarding grace, or this month predates the day billing began.
    // An ACTUAL accrual (billed, above) is always honored — if it was charged,
    // it is owed, whatever the grace column says now.
    if (!billingStarts || r.m < billingStarts) continue
    // S614 / 10/5: every occupied space counts exactly once.
    const billable = parseInt(r.spaces, 10)
      + Math.ceil(parseInt(r.nights, 10) / 30)
    // S538: short-stays on non-rv_spot types bill str_pct of pro-rated revenue
    // instead of nights/30.
    const strFee = round2(strPct * parseFloat(r.str_revenue ?? '0'))
    const fee = round2(rate * billable + strFee)
    const bucket = perMonth.get(r.m) ?? { total: 0, rows: [] }
    bucket.total = round2(bucket.total + fee)
    bucket.rows.push({ prop: r.property_id, fee })
    perMonth.set(r.m, bucket)
  }

  for (const [m, bucket] of perMonth) {
    // Months where something already accrued carry their own top-up already.
    let monthBilled = 0
    for (const [k, v] of billed) if (k.endsWith(`|${m}`)) monthBilled = round2(monthBilled + v)
    const earned = round2(bucket.total + monthBilled)
    const shortfall = round2(min - earned)
    // S631 (Nic, DIRECTIVE): "We do ten dollars a month minimum, but only when
    // money's moving through the system. Leaving it vacant forever as a ghost
    // in the system is okay." The floor is what a TRANSACTING account pays when
    // $2/unit lands under $10 — never a subscription for holding an empty
    // record. applyConnectAccountMinimums already skips a group with nothing
    // billable; this estimated a $10 floor onto months with zero occupied
    // units, which is how an empty August acquired a fee.
    if (shortfall > 0 && earned > 0 && bucket.rows.length > 0) {
      // Largest earner carries it, same rule as applyConnectAccountMinimums.
      const anchor = bucket.rows.reduce((a, b) => (b.fee > a.fee ? b : a), bucket.rows[0])
      anchor.fee = round2(anchor.fee + shortfall)
    }
    for (const row of bucket.rows) {
      fees.set(row.prop, round2((fees.get(row.prop) ?? 0) + row.fee))
    }
  }
  return fees
}

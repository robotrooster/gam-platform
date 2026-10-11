/**
 * 10/11 (Nic) — MONEY IN, BY TYPE.
 *
 *   "incoming income type pools, monthly, daily, electric bill back, etc."
 *
 * What a bookkeeper (and the owner, on the same page) reads instead of a
 * payment list: the money that arrived, added up by what it was for, by month
 * and by day. NOTHING per person — no tenant, no name, no unit, no lease — so
 * it can be handed to someone who keeps the books without handing them the
 * rent roll.
 *
 * Built on the one income definition every report reads (services/incomeBasis,
 * Money received), so the total here IS the P&L's income total for the same
 * days and properties. A pool is:
 *   - lot/space rent, split by how the space is rented: a lease's own rent is
 *     "Monthly rent"; rent on a lease drafted from a reservation follows that
 *     reservation (nightly, weekly, month) — RENT_POOLS
 *   - every other income category as the reports already name it (electric,
 *     water, sewer, trash, propane, late fees, home payments, register sales,
 *     stays and pay links, other income, ...) — INCOME_CATEGORIES
 *   - money in the total with no category (paid ahead, kept from deposits,
 *     returned or disputed, ...) under its P&L line's name — REPORT_LINES
 * Deposits received are NOT income (they are held), so they sit beside the
 * total, never inside it.
 */
import {
  RENT_POOLS, RENT_POOL_LABEL, INCOME_CATEGORIES, INCOME_CATEGORY_LABEL,
  type RentPool, type IncomeCategory,
} from '@gam/shared'
import { query } from '../db'
import { incomeEvents, basisMeta, REPORT_LINES, REPORT_LINE_LABEL, type IncomeEvent, type ReportLine } from './incomeBasis'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Every pool key in display order: rent pools, then categories, then uncategorized lines. */
export const INCOME_POOL_ORDER: readonly string[] = [
  ...RENT_POOLS,
  ...INCOME_CATEGORIES.filter(c => c !== 'space_rent'),
  ...REPORT_LINES,
]

export function incomePoolLabel(key: string): string {
  if ((RENT_POOLS as readonly string[]).includes(key)) return RENT_POOL_LABEL[key as RentPool]
  if ((INCOME_CATEGORIES as readonly string[]).includes(key)) return INCOME_CATEGORY_LABEL[key as IncomeCategory]
  if ((REPORT_LINES as readonly string[]).includes(key)) return REPORT_LINE_LABEL[key as ReportLine]
  return 'Other'
}

/** unit_bookings.lease_type → the rent pool a stay's rent lands in. */
const STAY_POOL: Record<string, RentPool> = {
  nightly:        'nightly_stays',
  weekly:         'weekly_stays',
  month_to_month: 'month_stays',
  long_term:      'month_stays',
}

export interface PoolRow { key: string; label: string; amount: number }
/**
 * A period's pools as a LIST of { key, amount }, never an object keyed by pool:
 * the API camelizes every object key on the way out, which would turn
 * 'monthly_rent' into 'monthlyRent' and part it from its own label.
 */
export interface PoolPeriod { total: number; depositsHeld: number; pools: Array<{ key: string; amount: number }> }
interface PoolAcc { total: number; depositsHeld: number; pools: Map<string, number> }

export interface IncomePools {
  period: { start: string; end: string }
  basis: ReturnType<typeof basisMeta>
  pools: PoolRow[]
  total: number
  depositsHeld: number
  months: Array<{ month: string } & PoolPeriod>
  days: Array<{ day: string } & PoolPeriod>
}

/** The pool one fact belongs to, or null when it is not in the total. */
export function poolOf(e: IncomeEvent, stayTypeByLease: Map<string, string>): string | null {
  if (!e.inTotal) return null
  if (e.category === 'space_rent') {
    const stay = e.leaseId ? stayTypeByLease.get(e.leaseId) : undefined
    return (stay && STAY_POOL[stay]) || 'monthly_rent'
  }
  if (e.category) return e.category
  return e.line
}

export async function incomePools(q: {
  landlordIds: string[]; propertyIds: string[] | null; start: string; end: string
}): Promise<IncomePools> {
  const events = await incomeEvents({
    landlordIds: q.landlordIds, propertyIds: q.propertyIds, start: q.start, end: q.end, basis: 'received',
  })
  // How each lease's space is rented: by the reservation it was drafted from.
  const leaseIds = [...new Set(events.filter(e => e.category === 'space_rent' && e.leaseId).map(e => e.leaseId!))]
  const stayTypeByLease = new Map<string, string>()
  if (leaseIds.length) {
    const rows = await query<{ id: string; lease_type: string }>(
      `SELECT l.id, b.lease_type FROM leases l JOIN unit_bookings b ON b.id = l.source_booking_id
        WHERE l.id = ANY($1::uuid[])`, [leaseIds])
    for (const r of rows) stayTypeByLease.set(r.id, r.lease_type)
  }

  const blank = (): PoolAcc => ({ total: 0, depositsHeld: 0, pools: new Map() })
  const all = blank()
  const months = new Map<string, PoolAcc>()
  const days = new Map<string, PoolAcc>()
  const add = (p: PoolAcc, pool: string | null, e: IncomeEvent) => {
    if (pool) {
      p.pools.set(pool, (p.pools.get(pool) ?? 0) + e.amount)
      p.total += e.amount
    } else if (e.line === 'depositsHeld') {
      p.depositsHeld += e.amount
    }
  }
  for (const e of events) {
    const pool = poolOf(e, stayTypeByLease)
    if (!pool && e.line !== 'depositsHeld') continue
    const m = e.day.slice(0, 7)
    if (!months.has(m)) months.set(m, blank())
    if (!days.has(e.day)) days.set(e.day, blank())
    add(all, pool, e); add(months.get(m)!, pool, e); add(days.get(e.day)!, pool, e)
  }
  const tidy = (p: PoolAcc): PoolPeriod => ({
    total: round2(p.total),
    depositsHeld: round2(p.depositsHeld),
    pools: INCOME_POOL_ORDER
      .map(k => ({ key: k, amount: round2(p.pools.get(k) ?? 0) }))
      .filter(x => x.amount !== 0),
  })
  const t = tidy(all)
  return {
    period: { start: q.start.slice(0, 10), end: q.end.slice(0, 10) },
    basis: basisMeta('received'),
    pools: t.pools.map(x => ({ key: x.key, label: incomePoolLabel(x.key), amount: x.amount })),
    total: t.total,
    depositsHeld: t.depositsHeld,
    months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, p]) => ({ month, ...tidy(p) })),
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, p]) => ({ day, ...tidy(p) })),
  }
}

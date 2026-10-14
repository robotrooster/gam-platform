/**
 * 10/12 (Nic) — THE MONTHLY PROPERTY REPORT.
 *
 *   "Monthly property report: EMAILED at month close (1st or 2nd of the
 *    following month) WITH A PDF attachment so they can put it to their
 *    books. Also lives in Reports, printable."
 *
 *   Round 5: ALL FOUR groups —
 *     tenants & leases  leases started, ended, renewed; move-ins / move-outs;
 *                       occupancy and vacant spaces
 *     payments          on time / late / partial / outstanding households,
 *                       with the colored stamps; who is late and by how many
 *                       days past grace
 *     money             Charged / Received / Owed by category, expenses by
 *                       category, net, work trade covered, deposits received
 *                       and returned
 *     operations        utility billed back vs the utility's own bill,
 *                       maintenance opened / closed and its cost, stays and
 *                       nights booked
 *
 * NOTHING HERE IS A NEW DEFINITION. Every figure is read through the service
 * that already owns it, so the report can never tell a landlord a different
 * number than the screen that number comes from:
 *   - payments: services/householdMonths (one stamp per household per bill
 *     month — the Rent Roll's stamps and the tenant payment report's);
 *   - money: services/incomeBasis (both kinds of facts — Received, Charged,
 *     Owed — and the tie line; 10/14, Nic: each group's itemized lines, read
 *     by the same moneyViewFrom over that group's facts) and services/landlordPL
 *     landlordPLExpensesByProperty (the P&L's expenses, every property read
 *     at once and split by property), so a property's net here is its By
 *     Property row's and the properties add up to the company P&L for those
 *     properties; money the company booked to no property is named beside
 *     the totals (notInTotals);
 *   - occupancy: the spaces on the property's daily growth snapshot day
 *     (services/growthSnapshots) for the month's last day; a month with no
 *     snapshot (the current month, a property onboarded since) counts today's
 *     spaces and says so. Occupied is what GAM bills for the month
 *     (billableUnits.occupiedSpacesSql — 10/12, Nic: "match billing") and
 *     vacant is the rest.
 * Every dollar is counted once: a property's money is the facts of that
 * property only, and the all-properties totals are the same facts added up.
 *
 * Scope: one company (landlords.id) and the properties the reader may see —
 * the caller passes them (a manager of one park never gets the other park's
 * money; routes/reports and the email job both pass the reader's scope).
 * Tenant names are in it (Nic chose "email with PDF"; names are allowed
 * wherever the books need them, 10/11) — no phone, email or address.
 */
// 10/12 (Nic, ledger P6, L5): which expenses count as a cost, and a repair's cost once (lib/liveExpense).
import { liveExpenseSql, maintenanceCostNotBilledSql } from '../lib/liveExpense'
import {
  PAYMENT_STAMPS, PAYMENT_STAMP_LABEL, INCOME_UTILITY_CATEGORIES, INCOME_CATEGORY_LABEL,
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, FALLBACK_TIMEZONE, LEDGER_INCOME_NOT_ITEMIZED_LABEL, ledgerIncomeDetailOf,
  LANDLORD_ASSIGNABLE_ROLE_LABEL, MONTHLY_REPORT_MAX_EXTRA_EMAILS, MONTHLY_REPORT_SEND_STATUS_LABEL,
  type PaymentStamp, type ExpenseCategory, type LandlordAssignableRole,
  type MonthlyReportRecipientKind, type MonthlyReportSendStatus,
} from '@gam/shared'
import { query, queryOne, getClient } from '../db'
import { bookkeeperScopesOf, requestScopeOf } from '../lib/bookkeeperScope'
import { householdMonthsBoth, addMonths, isBillMonth, type HouseholdMonth } from './householdMonths'
import { incomeBoth, moneyViewFrom, monthWords, type MoneyView, type MoneyColumns, type IncomeEvent } from './incomeBasis'
import { landlordPLExpensesByProperty, NO_PROPERTY_KEY, type LandlordPL } from './landlordPL'
import { utilityBillSentSql, stayHeldSql } from './moneyPredicates'
import { occupiedSpacesSql } from './billableUnits'
import { AppError } from '../middleware/errorHandler'

const round2 = (n: number) => Math.round(n * 100) / 100

/** The stamps a landlord reads first, in the Rent Roll's order (Due last: nothing is late yet). */
export const REPORT_STAMP_ORDER: readonly PaymentStamp[] = ['paid_on_time', 'paid_late', 'partial', 'outstanding', 'due']

/** Utilities a meter can bill, in report order (INCOME_UTILITY_CATEGORIES' own order). */
const UTILITY_TYPES = INCOME_UTILITY_CATEGORIES.filter(c => c !== 'utility_other')

export interface ReportTenants {
  /** Every lease that started in the month (new and renewals). */
  leasesStarted: number
  /** Of them, renewals: a new lease for a household already living there. */
  leasesRenewed: number
  /** Of them, existing tenancies moved onto GAM (never "moved in"). */
  existingOnboarded: number
  /** Leases that ended in the month (expired or ended early), renewed ones included. */
  leasesEnded: number
  /** New leases for a household moving in. */
  moveIns: number
  /** Leases that ended with no new lease after them: the household left. */
  moveOuts: number
  spaces: number
  occupied: number
  vacant: number
  occupancyPercent: number | null
  /** The day the occupancy was counted ('YYYY-MM-DD'), and how. */
  occupancyAsOf: string
  occupancyFrom: 'month_end_snapshot' | 'today'
}

export interface LateHousehold {
  householdId: string
  name: string
  units: string[]
  stamp: PaymentStamp
  stampLabel: string
  daysPastGrace: number
  owed: number
}

export interface ReportPayments {
  /** Households per stamp for the month's bills (REPORT_STAMP_ORDER). */
  counts: Array<{ stamp: PaymentStamp; label: string; households: number }>
  households: number
  /** Households past grace: paid late, still outstanding, or partly paid past grace. */
  late: LateHousehold[]
}

export interface ReportExpenseLine { key: string; label: string; amount: number }

/** 10/14 (Nic): one itemized line under a Summary group, with the space subtypes beneath it. */
export interface ReportIncomeLine extends MoneyColumns {
  key: string
  label: string
  subtypes: Array<MoneyColumns & { name: string }>
}

/**
 * 10/14 (Nic): one Summary group (an income category, or money with no
 * category under its line — the key is 'c:<category>' or 'l:<line>') and the
 * itemized lines of ITS money, which add up to the group's row in every
 * column (the part no line itemizes is LEDGER_INCOME_NOT_ITEMIZED_LABEL).
 */
export interface ReportIncomeGroup { key: string; label: string; lines: ReportIncomeLine[] }

export interface ReportMoney {
  view: MoneyView
  /**
   * 10/14 (Nic): "Monthly property report PDF/email: itemized lines under each
   * group" — the groups that itemize, in the view's order (incomeGroupsOf).
   * Empty when the month's facts are not itemized (books not live yet).
   */
  itemized?: ReportIncomeGroup[]
  /** 10/12 (ledger P8): `paid` — on the books, the expenses paid in the month (the Received net takes it). */
  expenses: { lines: ReportExpenseLine[]; total: number; paid?: number }
  /** Received less expenses (it leads — 10/12, Nic), and Charged less expenses. */
  net: { received: number; charged: number }
  workTradeCovered: number
  depositsReceived: number
  depositsReturned: number
}

export interface ReportUtility {
  utility: string
  label: string
  billedBack: number
  /** What the utility charged the property (the master meter's bill as entered); null when none was entered. */
  utilityBill: number | null
}

export interface ReportOperations {
  utilityCycle: string
  utilities: ReportUtility[]
  /** Utility bills the landlord logged as expenses this month (entered expenses, Utilities). */
  utilityExpensesLogged: number
  maintenance: { opened: number; closed: number; cost: number }
  stays: { stays: number; nights: number; bookedThisMonth: number }
}

export interface ReportProperty {
  property: { id: string; name: string; city: string | null; state: string | null }
  tenants: ReportTenants
  payments: ReportPayments
  money: ReportMoney
  operations: ReportOperations
}

export interface MonthlyPropertyReport {
  company: { id: string; name: string }
  month: string
  monthLabel: string
  period: { start: string; end: string }
  generatedAt: string
  properties: ReportProperty[]
  /**
   * 10/12 review: money the company booked to no property — income with no
   * space behind it and the company's own costs (an entered expense, a repair
   * or lot rent on no property, a processing fee on no space). It is in the
   * monthly P&L but in no property's row, so it is not in the totals below
   * ("All properties"); the report says so beside them. Only for a report on
   * the whole company (null otherwise, or when there is none).
   */
  notInTotals: { received: number; charged: number; expenses: number } | null
  /** Every property in the report added up (the same facts, counted once). */
  totals: {
    tenants: Omit<ReportTenants, 'occupancyAsOf' | 'occupancyFrom'>
    payments: { counts: ReportPayments['counts']; households: number; late: number }
    money: Omit<ReportMoney, 'view'> & { view: MoneyView }
    operations: { maintenance: ReportOperations['maintenance']; stays: ReportOperations['stays']; utilityExpensesLogged: number }
  }
}

/** 'YYYY-MM' → its first and last day. */
export function monthBounds(ym: string): { start: string; end: string } {
  if (!isBillMonth(ym)) throw new AppError(400, 'month must be YYYY-MM')
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  return { start: `${ym}-01`, end: last }
}

/** The month before a 'YYYY-MM-DD' day. */
export function previousMonth(day: string): string {
  return addMonths(day.slice(0, 7), -1)
}

const PROPERTY_DAY = (ts: string, pr = 'pr') => `((${ts}) AT TIME ZONE COALESCE(${pr}.timezone, '${FALLBACK_TIMEZONE}'))::date`

/** The properties a report covers: the company's, narrowed to `propertyIds` (null = all of them). */
async function reportProperties(landlordId: string, propertyIds: readonly string[] | null) {
  return query<{ id: string; name: string; city: string | null; state: string | null }>(
    `SELECT id, name, city, state FROM properties
      WHERE landlord_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY name, id`,
    [landlordId, propertyIds ? [...propertyIds] : null])
}

/**
 * 10/12 review: a lease unwound as paperwork never was a tenancy — the
 * tenant never moved in (lib/unwindIssuedLease NEVER_MOVED_IN_REASON), or the
 * lease document was voided before the tenant signed (the void path's
 * termination_reason there). Its status is 'terminated', so without this it
 * read as a lease started, a move-in, a lease ended and a move-out.
 * services/monthlyPropertyReport.test checks both against unwindIssuedLease.
 */
export const UNWOUND_LEASE_REASONS = [
  'The tenant never moved in',
  'Lease document voided before the tenant signed',
] as const
const unwoundSql = (a: string) =>
  `COALESCE(${a}.termination_reason, '') NOT IN (${UNWOUND_LEASE_REASONS.map(r => `'${r.replace(/'/g, "''")}'`).join(', ')})`

/** Leases started, renewed, ended; move-ins and move-outs — per property. Unwound leases never count. */
async function leaseCounts(landlordId: string, ids: string[], start: string, end: string) {
  const rows = await query<any>(`
    WITH l AS (
      SELECT u.property_id, l.id, l.start_date, l.supersedes_lease_id, l.is_existing_tenancy, l.status,
             CASE WHEN l.status IN ('expired', 'terminated')
                  THEN COALESCE(${PROPERTY_DAY('l.terminated_at')}, l.end_date) END AS ended_on
        FROM leases l
        JOIN units u ON u.id = l.unit_id
        JOIN properties pr ON pr.id = u.property_id
       WHERE l.landlord_id = $1 AND u.property_id = ANY($2::uuid[]) AND l.status <> 'pending'
         AND ${unwoundSql('l')}
    )
    SELECT property_id,
           COUNT(*) FILTER (WHERE start_date BETWEEN $3::date AND $4::date)::int AS started,
           COUNT(*) FILTER (WHERE start_date BETWEEN $3::date AND $4::date AND supersedes_lease_id IS NOT NULL)::int AS renewed,
           COUNT(*) FILTER (WHERE start_date BETWEEN $3::date AND $4::date AND supersedes_lease_id IS NULL
                              AND is_existing_tenancy)::int AS onboarded,
           COUNT(*) FILTER (WHERE start_date BETWEEN $3::date AND $4::date AND supersedes_lease_id IS NULL
                              AND NOT is_existing_tenancy)::int AS move_ins,
           COUNT(*) FILTER (WHERE ended_on BETWEEN $3::date AND $4::date)::int AS ended,
           COUNT(*) FILTER (WHERE ended_on BETWEEN $3::date AND $4::date
                              AND NOT EXISTS (SELECT 1 FROM leases nx WHERE nx.supersedes_lease_id = l.id
                                                AND nx.status <> 'pending' AND ${unwoundSql('nx')}))::int AS move_outs
      FROM l GROUP BY property_id`, [landlordId, ids, start, end])
  return new Map<string, any>(rows.map(r => [r.property_id, r]))
}

/**
 * Occupancy at the month's end: the spaces as they stood on the property's
 * growth snapshot day for its last day (or the latest one inside the month).
 * A month still running, or a property with no snapshot in it, counts today's
 * spaces and says so.
 *
 * 10/12 (Nic, A5 "MATCH BILLING"): occupied is the count GAM BILLS for the
 * month — billableUnits.occupiedSpacesSql, the query the platform fee and its
 * nightly top-up run (a lease, a month stay, owner use or a utility
 * arrangement, each space once; a space held at any point in the month counts
 * for it) — never a unit's status or the snapshot's own lease count. Vacant is
 * the rest, so occupied + vacant = spaces. Before, vacant was the spaces
 * MARKED vacant, and a space marked active with no one in it was neither.
 * Nightly and weekly stays are billed by their nights after the month, never
 * as spaces, so a site holding only those is not an occupied space here
 * either — the same as the bill (and the admin's Active Units card). Owner use
 * is a unit status; 10/12 (Nic) review: the report reads it for the month
 * from the change journal (occupiedSpacesSql ownerUseFromJournal) — owner use
 * at the month's start or switched on during it, the way the bill counted it
 * — never today's status backdated onto a month that has ended (the emailed
 * report always covers a month that has ended).
 *
 * 10/12 review: a space is a unit that is not retired (retire-and-replace
 * keeps the old row, status 'vacant', beside its replacement) and not a
 * utility service point (a neighbor's meter, never this landlord's inventory —
 * S616, as /property-pl counts it). The live count leaves both out, and so do
 * snapshots taken since (services/growthSnapshots). A snapshot taken before
 * counted every unit row, so its spaces are re-counted from the units as they
 * stood on its day (created by then, not retired by then, not a service
 * point), and vacant is never more than the spaces left after the occupied ones.
 */
async function occupancyAt(ids: string[], start: string, end: string) {
  // A space on the day counted: not a utility service point, there by then,
  // not retired by then. `u`/`pr` are the unit and its property.
  const spaceOn = (day: string) => `u.status <> 'utility_service'
               AND ${PROPERTY_DAY('u.created_at')} <= ${day}
               AND (u.retired_at IS NULL OR ${PROPERTY_DAY('u.retired_at')} > ${day})`
  // Of those, the ones GAM bills as occupied for the month (occupiedSpacesSql,
  // `$2` = the month's first day) — so occupied can never exceed the spaces.
  const billedOccupied = (propertyId: string) =>
    `u.id IN (SELECT bo.unit_id FROM (${occupiedSpacesSql(propertyId, '$2::date', { ownerUseFromJournal: true })}) bo)`
  const snap = await query<{ property_id: string; day: string; spaces: number; occupied: number }>(`
    SELECT DISTINCT ON (s.property_id) s.property_id, s.snapshot_date::text AS day,
           (SELECT COUNT(*) FROM units u JOIN properties pr ON pr.id = u.property_id
             WHERE u.property_id = s.property_id
               AND ${spaceOn('s.snapshot_date')})::int AS spaces,
           (SELECT COUNT(*) FROM units u JOIN properties pr ON pr.id = u.property_id
             WHERE u.property_id = s.property_id
               AND ${spaceOn('s.snapshot_date')}
               AND ${billedOccupied('s.property_id')})::int AS occupied
      FROM property_growth_snapshots s
     WHERE s.property_id = ANY($1::uuid[]) AND s.snapshot_date BETWEEN $2::date AND $3::date
     ORDER BY s.property_id, s.snapshot_date DESC`, [ids, start, end])
  const out = new Map<string, { spaces: number; occupied: number; vacant: number; asOf: string; from: 'month_end_snapshot' | 'today' }>()
  for (const s of snap) {
    const occupied = Math.min(s.occupied, s.spaces)
    out.set(s.property_id, { spaces: s.spaces, occupied, vacant: s.spaces - occupied, asOf: s.day, from: 'month_end_snapshot' })
  }
  const missing = ids.filter(id => !out.has(id))
  if (missing.length) {
    const live = await query<{ property_id: string; day: string; units: number; occupied: number }>(`
      SELECT p.id AS property_id, ${PROPERTY_DAY('NOW()', 'p')}::text AS day,
             COUNT(DISTINCT u.id)::int AS units,
             COUNT(DISTINCT u.id) FILTER (WHERE ${billedOccupied('p.id')})::int AS occupied
        FROM properties p
        LEFT JOIN units u ON u.property_id = p.id AND u.retired_at IS NULL AND u.status <> 'utility_service'
       WHERE p.id = ANY($1::uuid[])
       GROUP BY p.id`, [missing, start])
    for (const s of live) {
      const occupied = Math.min(s.occupied, s.units)
      out.set(s.property_id, { spaces: s.units, occupied, vacant: s.units - occupied, asOf: s.day, from: 'today' })
    }
  }
  return out
}

/** Household names (the primary resident's), by tenant id. */
async function householdNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const rows = await query<{ id: string; first_name: string | null; last_name: string | null }>(
    `SELECT t.id, u.first_name, u.last_name FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = ANY($1::uuid[])`, [ids])
  return new Map(rows.map(r => [r.id, [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Resident']))
}

/** Is a household's month past its grace period (the "who's late" list)? */
export function isLateMonth(m: Pick<HouseholdMonth, 'stamp' | 'days_past_grace'>): boolean {
  return m.stamp === 'paid_late' || m.stamp === 'outstanding' || (m.stamp === 'partial' && m.days_past_grace > 0)
}

function stampCounts(months: readonly HouseholdMonth[]): ReportPayments['counts'] {
  return REPORT_STAMP_ORDER.map(stamp => ({
    stamp, label: PAYMENT_STAMP_LABEL[stamp], households: months.filter(m => m.stamp === stamp).length,
  }))
}

/** Entered expenses by property and category; utility bills logged; deposits returned; maintenance; stays; utilities. */
async function propertyFacts(landlordId: string, ids: string[], start: string, end: string) {
  const [expenses, returned, maint, stays, billedBack, utilityBill] = await Promise.all([
    query<any>(`
      SELECT property_id, category, SUM(amount)::text AS total FROM landlord_expenses
       WHERE landlord_id = $1 AND property_id = ANY($2::uuid[]) AND ${liveExpenseSql('')}
         AND expense_date BETWEEN $3::date AND $4::date
       GROUP BY property_id, category`, [landlordId, ids, start, end]),
    query<any>(`
      SELECT u.property_id, SUM(dr.refund_amount)::text AS total
        FROM deposit_returns dr
        JOIN leases l ON l.id = dr.lease_id
        JOIN units u ON u.id = l.unit_id
        JOIN properties pr ON pr.id = u.property_id
       WHERE dr.landlord_id = $1 AND u.property_id = ANY($2::uuid[])
         AND dr.finalized_at IS NOT NULL
         AND dr.status IN ('sent_refund', 'sent_gap', 'sent_zero', 'sent_carried_forward')
         AND ${PROPERTY_DAY('dr.finalized_at')} BETWEEN $3::date AND $4::date
       GROUP BY u.property_id`, [landlordId, ids, start, end]),
    query<any>(`
      SELECT u.property_id,
             COUNT(*) FILTER (WHERE ${PROPERTY_DAY('mr.created_at')} BETWEEN $3::date AND $4::date)::int AS opened,
             COUNT(*) FILTER (WHERE mr.completed_at IS NOT NULL
                                AND ${PROPERTY_DAY('mr.completed_at')} BETWEEN $3::date AND $4::date)::int AS closed
        FROM maintenance_requests mr
        JOIN units u ON u.id = mr.unit_id
        JOIN properties pr ON pr.id = u.property_id
       WHERE mr.landlord_id = $1 AND u.property_id = ANY($2::uuid[])
       GROUP BY u.property_id`, [landlordId, ids, start, end]),
    query<any>(`
      SELECT u.property_id,
             COUNT(*) FILTER (WHERE b.check_in <= $4::date AND b.check_out > $3::date)::int AS stays,
             COALESCE(SUM(GREATEST(LEAST(b.check_out, $4::date + 1) - GREATEST(b.check_in, $3::date), 0))
                      FILTER (WHERE b.check_in <= $4::date AND b.check_out > $3::date), 0)::int AS nights,
             COUNT(*) FILTER (WHERE ${PROPERTY_DAY('b.created_at')} BETWEEN $3::date AND $4::date)::int AS booked
        FROM unit_bookings b
        JOIN units u ON u.id = b.unit_id
        JOIN properties pr ON pr.id = u.property_id
       WHERE b.landlord_id = $1 AND u.property_id = ANY($2::uuid[])
         AND b.lease_type IN ('nightly', 'weekly')
         -- 10/12 review: a tentative hold is not a stay (services/moneyPredicates stayHeldSql).
         AND ${stayHeldSql('b')}
       GROUP BY u.property_id`, [landlordId, ids, start, end]),
    query<any>(`
      SELECT u.property_id, ub.utility_type, SUM(ub.charge_amount)::text AS total
        FROM utility_bills ub
        JOIN units u ON u.id = ub.unit_id
       WHERE ub.landlord_id = $1 AND u.property_id = ANY($2::uuid[])
         -- 10/12 review: billed back = bills that went out (an unbilled draft is not; services/moneyPredicates).
         AND ub.billing_cycle_month = $3::date AND ${utilityBillSentSql('ub')}
       GROUP BY u.property_id, ub.utility_type`, [landlordId, ids, start]),
    query<any>(`
      SELECT m.property_id, m.utility_type, SUM(r.bill_amount)::text AS total
        FROM utility_meter_readings r
        JOIN utility_meters m ON m.id = r.meter_id
       WHERE m.property_id = ANY($1::uuid[]) AND m.billing_method = 'rubs'
         AND r.billing_cycle_month = $2::date AND r.reason = 'monthly_cycle' AND r.bill_amount IS NOT NULL
       GROUP BY m.property_id, m.utility_type`, [ids, start]),
  ])
  const by = <T>(rows: any[], f: (r: any) => T) => {
    const m = new Map<string, T[]>()
    for (const r of rows) { const l = m.get(r.property_id) ?? []; l.push(f(r)); m.set(r.property_id, l) }
    return m
  }
  return {
    expenses: by(expenses, r => ({ category: r.category as string, amount: round2(Number(r.total)) })),
    returned: new Map<string, number>(returned.map(r => [r.property_id, round2(Number(r.total))])),
    maint: new Map<string, { opened: number; closed: number }>(maint.map(r => [r.property_id, { opened: r.opened, closed: r.closed }])),
    stays: new Map<string, { stays: number; nights: number; booked: number }>(stays.map(r => [r.property_id, { stays: r.stays, nights: r.nights, booked: r.booked }])),
    billedBack: by(billedBack, r => ({ type: r.utility_type as string, amount: round2(Number(r.total)) })),
    utilityBill: by(utilityBill, r => ({ type: r.utility_type as string, amount: round2(Number(r.total)) })),
  }
}

/**
 * The P&L's expenses for one property as report lines: GAM's platform fee,
 * repairs, lot rent, payment processing fees, then the entered expenses by
 * category (they add up to the P&L's "Your expenses"). Zero lines are left
 * out except the platform fee and the processing fees (10/12, Nic: the
 * processing-fee line shows wherever expenses are listed).
 */
export function expenseReportLines(
  e: LandlordPL['expenses'], entered: ReadonlyArray<{ category: string; amount: number }>,
): ReportExpenseLine[] {
  const out: ReportExpenseLine[] = [
    { key: 'platformFee', label: 'GAM platform fee', amount: e.platformFee },
    { key: 'processingFees', label: 'Payment processing fees', amount: e.processingFees },
  ]
  if (e.maintenance) out.push({ key: 'maintenance', label: 'Maintenance (repairs)', amount: e.maintenance })
  if (e.lotRent) out.push({ key: 'lotRent', label: 'Lot rent', amount: e.lotRent })
  // 10/12 (Nic, G10): the card fee guests got back with refunds of card sales.
  if (e.cardFeesRefunded) out.push({ key: 'cardFeesRefunded', label: 'Card fees refunded', amount: e.cardFeesRefunded })
  const cats = new Map(entered.map(x => [x.category, x.amount]))
  for (const c of EXPENSE_CATEGORIES) {
    const v = cats.get(c)
    if (v) out.push({ key: `expense:${c}`, label: EXPENSE_CATEGORY_LABEL[c as ExpenseCategory], amount: v })
  }
  // An entered category outside today's list still adds up (never dropped).
  const other = [...cats.entries()].filter(([c]) => !(EXPENSE_CATEGORIES as readonly string[]).includes(c))
    .reduce((s, [, v]) => s + v, 0)
  if (other) out.push({ key: 'expense:other_unlisted', label: 'Other expenses', amount: round2(other) })
  return out
}

/** An itemized line's place under its group: rent lines, then stays, then home sales (ledgerIncomeDetailOf). */
function lineOrder(key: string): number {
  const at = key.indexOf(':')
  const d = at < 0 ? ledgerIncomeDetailOf(null, null, key) : ledgerIncomeDetailOf(key.slice(0, at), key.slice(at + 1))
  return d?.order ?? 1000
}

/**
 * 10/14 (Nic): "Monthly property report PDF/email: itemized lines under each
 * group." Each Summary group of `view` (an income category, or money with no
 * category under its line) with the itemized lines of its OWN money: the same
 * moneyViewFrom over only that group's facts, so the lines add up to the
 * group's row in every column — a stay sold by the month is "RV long-term
 * rent" under Stays and pay links, where its money is, and a lease's rent is
 * "RV long-term rent" under Space rent. The part no line itemizes (rent on a
 * space with no type on record, money for a bill billed before the books
 * began) is LEDGER_INCOME_NOT_ITEMIZED_LABEL, last. A group with nothing
 * itemized is left out (its Summary row says it all). Empty when the facts
 * are not itemized (a company whose books are not live reads the money
 * records, which carry no lines).
 */
export function incomeGroupsOf(
  billed: readonly IncomeEvent[], received: readonly IncomeEvent[],
  period: { start: string; end: string; label: string }, view: MoneyView,
): ReportIncomeGroup[] {
  if (!view.details?.length) return []
  const groups: Array<{ key: string; label: string; of: (e: IncomeEvent) => boolean }> = [
    ...view.categories.map(c => ({ key: `c:${c.category}`, label: c.label, of: (e: IncomeEvent) => e.category === c.category })),
    ...view.uncategorized.map(l => ({ key: `l:${l.line}`, label: l.label, of: (e: IncomeEvent) => !e.category && e.line === l.line })),
  ]
  const out: ReportIncomeGroup[] = []
  for (const g of groups) {
    const own = moneyViewFrom(billed.filter(g.of), received.filter(g.of), period)
    const lines: ReportIncomeLine[] = (own.details ?? [])
      .map(d => ({
        key: d.key, label: d.key === g.key ? LEDGER_INCOME_NOT_ITEMIZED_LABEL : d.label,
        charged: d.charged, received: d.received, owed: d.owed, subtypes: d.subtypes,
      }))
      .sort((a, b) => Number(a.key === g.key) - Number(b.key === g.key) || lineOrder(a.key) - lineOrder(b.key) || a.label.localeCompare(b.label))
    if (!lines.some(l => l.key !== g.key)) continue
    out.push({ key: g.key, label: g.label, lines })
  }
  return out
}

const sumBy = <T>(xs: readonly T[], f: (x: T) => number) => round2(xs.reduce((s, x) => s + f(x), 0))

/**
 * Build the report for one company, month and set of properties.
 * `asOf` (tests) pins the day the payment stamps are judged on.
 */
export async function buildMonthlyPropertyReport(opts: {
  landlordId: string
  month: string
  /** null = every property the company owns; [] = none. */
  propertyIds: readonly string[] | null
  asOf?: string | null
}): Promise<MonthlyPropertyReport> {
  const { start, end } = monthBounds(opts.month)
  const label = monthWords(opts.month)
  const company = await queryOne<{ id: string; name: string | null; first_name: string | null; last_name: string | null }>(
    `SELECT l.id, l.business_name AS name, u.first_name, u.last_name
       FROM landlords l LEFT JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [opts.landlordId])
  if (!company) throw new AppError(404, 'Company not found')
  const companyName = company.name || [company.first_name, company.last_name].filter(Boolean).join(' ') || 'Your company'
  const props = opts.propertyIds && opts.propertyIds.length === 0 ? [] : await reportProperties(opts.landlordId, opts.propertyIds)
  const ids = props.map(p => p.id)
  const empty = (): MonthlyPropertyReport => ({
    company: { id: company.id, name: companyName }, month: opts.month, monthLabel: label,
    period: { start, end }, generatedAt: new Date().toISOString(), properties: [], notInTotals: null,
    totals: {
      tenants: { leasesStarted: 0, leasesRenewed: 0, existingOnboarded: 0, leasesEnded: 0, moveIns: 0, moveOuts: 0, spaces: 0, occupied: 0, vacant: 0, occupancyPercent: null },
      payments: { counts: stampCounts([]), households: 0, late: 0 },
      money: {
        view: moneyViewFrom([], [], { start, end, label }), expenses: { lines: [], total: 0 },
        net: { received: 0, charged: 0 }, workTradeCovered: 0, depositsReceived: 0, depositsReturned: 0,
      },
      operations: { maintenance: { opened: 0, closed: 0, cost: 0 }, stays: { stays: 0, nights: 0, bookedThisMonth: 0 }, utilityExpensesLogged: 0 },
    },
  })
  if (!ids.length) return empty()

  const feeMonths = [`${opts.month}-01`]
  // A report on the whole company reads the company's money with no property
  // narrowing, so what it booked to no property is on hand for notInTotals.
  const wholeCompany = opts.propertyIds === null
  const [leases, occupancy, months, both, facts, expensesByProperty] = await Promise.all([
    leaseCounts(opts.landlordId, ids, start, end),
    occupancyAt(ids, start, end),
    // One read, both groupings: per property (each property's stamps) and per
    // household across them (10/12 review: the totals counted a household
    // billed at two properties twice).
    householdMonthsBoth({ landlordIds: [opts.landlordId], propertyIds: ids, from: opts.month, through: opts.month, asOf: opts.asOf ?? null }),
    incomeBoth({ landlordIds: [opts.landlordId], propertyIds: wholeCompany ? null : ids, start, end }),
    propertyFacts(opts.landlordId, ids, start, end),
    // 10/12 review: every property's expenses in one pass, not one P&L read per property.
    landlordPLExpensesByProperty(opts.landlordId, start, end, feeMonths, wholeCompany ? null : ids),
  ])
  const hh = months.byProperty
  const names = await householdNames([...new Set(hh.filter(isLateMonth).map(m => m.household_id))])
  const noExpenses: LandlordPL['expenses'] = { platformFee: 0, maintenance: 0, lotRent: 0, enteredExpenses: 0, processingFees: 0, cardFeesRefunded: 0, total: 0 }

  const eventsOf = (list: readonly IncomeEvent[], id: string) => list.filter(e => e.propertyId === id)
  const properties: ReportProperty[] = props.map(p => {
    const lc = leases.get(p.id) ?? {}
    const occ = occupancy.get(p.id) ?? { spaces: 0, occupied: 0, vacant: 0, asOf: end, from: 'today' as const }
    const hhMonths = hh.filter(m => m.property_id === p.id)
    const billedHere = eventsOf(both.billed, p.id), receivedHere = eventsOf(both.received, p.id)
    const view = moneyViewFrom(billedHere, receivedHere, { start, end, label })
    const ex = expensesByProperty.get(p.id) ?? noExpenses
    const lines = expenseReportLines(ex, facts.expenses.get(p.id) ?? [])
    const besideOf = (k: string) => view.beside.find(b => b.key === k)?.amount ?? 0
    const billedBack = facts.billedBack.get(p.id) ?? []
    const utilityBill = facts.utilityBill.get(p.id) ?? []
    const utilityTypes = UTILITY_TYPES.filter(t => billedBack.some(b => b.type === t) || utilityBill.some(b => b.type === t))
    return {
      property: { id: p.id, name: p.name, city: p.city, state: p.state },
      tenants: {
        leasesStarted: lc.started ?? 0, leasesRenewed: lc.renewed ?? 0, existingOnboarded: lc.onboarded ?? 0,
        leasesEnded: lc.ended ?? 0, moveIns: lc.move_ins ?? 0, moveOuts: lc.move_outs ?? 0,
        spaces: occ.spaces, occupied: occ.occupied, vacant: occ.vacant,
        occupancyPercent: occ.spaces > 0 ? Math.round((occ.occupied / occ.spaces) * 100) : null,
        occupancyAsOf: occ.asOf, occupancyFrom: occ.from,
      },
      payments: {
        counts: stampCounts(hhMonths),
        households: hhMonths.filter(m => m.stamp).length,
        late: hhMonths.filter(isLateMonth)
          .map(m => ({
            householdId: m.household_id, name: names.get(m.household_id) ?? 'Resident', units: m.units,
            stamp: m.stamp as PaymentStamp, stampLabel: PAYMENT_STAMP_LABEL[m.stamp as PaymentStamp],
            daysPastGrace: m.days_past_grace, owed: m.owed,
          }))
          .sort((a, b) => b.daysPastGrace - a.daysPastGrace || a.name.localeCompare(b.name)),
      },
      money: {
        view,
        itemized: incomeGroupsOf(billedHere, receivedHere, { start, end, label }, view),
        expenses: { lines, total: ex.total, ...(ex.cashTotal !== undefined ? { paid: ex.cashTotal } : {}) },
        net: { received: round2(view.received - (ex.cashTotal ?? ex.total)), charged: round2(view.charged - ex.total) },
        workTradeCovered: besideOf('workTrade'),
        depositsReceived: besideOf('depositsHeld'),
        depositsReturned: facts.returned.get(p.id) ?? 0,
      },
      operations: {
        utilityCycle: label,
        utilities: utilityTypes.map(t => {
          const bill = utilityBill.filter(b => b.type === t)
          return {
            utility: t, label: INCOME_CATEGORY_LABEL[t],
            billedBack: sumBy(billedBack.filter(b => b.type === t), b => b.amount),
            utilityBill: bill.length ? sumBy(bill, b => b.amount) : null,
          }
        }),
        utilityExpensesLogged: (facts.expenses.get(p.id) ?? []).find(x => x.category === 'utilities')?.amount ?? 0,
        maintenance: {
          opened: facts.maint.get(p.id)?.opened ?? 0, closed: facts.maint.get(p.id)?.closed ?? 0, cost: ex.maintenance,
        },
        stays: {
          stays: facts.stays.get(p.id)?.stays ?? 0, nights: facts.stays.get(p.id)?.nights ?? 0,
          bookedThisMonth: facts.stays.get(p.id)?.booked ?? 0,
        },
      },
    }
  })

  // The totals: the same facts added up — the company view over every
  // property's facts at once (each fact belongs to one property).
  const all = moneyViewFrom(both.billed.filter(e => e.propertyId && ids.includes(e.propertyId)),
    both.received.filter(e => e.propertyId && ids.includes(e.propertyId)), { start, end, label })
  const expenseLines = new Map<string, ReportExpenseLine>()
  for (const p of properties) for (const l of p.money.expenses.lines) {
    const x = expenseLines.get(l.key)
    if (x) x.amount = round2(x.amount + l.amount); else expenseLines.set(l.key, { ...l })
  }
  const expTotal = sumBy(properties, p => p.money.expenses.total)
  // 10/12 (ledger P8): on the books, the expenses paid in the month.
  const onBooks = properties.some(p => p.money.expenses.paid !== undefined)
  const expPaid = sumBy(properties, p => p.money.expenses.paid ?? p.money.expenses.total)
  const T = properties.map(p => p.tenants)
  const spaces = sumBy(T, t => t.spaces), occupied = sumBy(T, t => t.occupied)
  // Each household once, across the properties (a household billed at two counts once).
  const allMonths = months.byHousehold
  // 10/12 review: what the whole company's report holds outside every listed
  // property's row — income with no space behind it (or on a property no
  // longer the company's) and the company's own costs. The totals stay "every
  // property added up"; this is printed beside them, so the totals plus it
  // are the monthly P&L.
  let notInTotals: MonthlyPropertyReport['notInTotals'] = null
  if (wholeCompany) {
    const outside = (e: IncomeEvent) => !e.propertyId || !ids.includes(e.propertyId)
    const rest = moneyViewFrom(both.billed.filter(outside), both.received.filter(outside), { start, end, label })
    const restExpenses = round2([...expensesByProperty.entries()]
      .filter(([k]) => k === NO_PROPERTY_KEY || !ids.includes(k))
      .reduce((s, [, e]) => s + e.total, 0))
    if (rest.received || rest.charged || restExpenses) {
      notInTotals = { received: rest.received, charged: rest.charged, expenses: restExpenses }
    }
  }
  return {
    company: { id: company.id, name: companyName },
    month: opts.month,
    monthLabel: label,
    period: { start, end },
    generatedAt: new Date().toISOString(),
    properties,
    notInTotals,
    totals: {
      tenants: {
        leasesStarted: sumBy(T, t => t.leasesStarted), leasesRenewed: sumBy(T, t => t.leasesRenewed),
        existingOnboarded: sumBy(T, t => t.existingOnboarded), leasesEnded: sumBy(T, t => t.leasesEnded),
        moveIns: sumBy(T, t => t.moveIns), moveOuts: sumBy(T, t => t.moveOuts),
        spaces, occupied, vacant: sumBy(T, t => t.vacant),
        occupancyPercent: spaces > 0 ? Math.round((occupied / spaces) * 100) : null,
      },
      payments: {
        counts: stampCounts(allMonths),
        households: allMonths.filter(m => m.stamp).length,
        late: allMonths.filter(isLateMonth).length,
      },
      money: {
        view: all,
        expenses: { lines: [...expenseLines.values()], total: expTotal, ...(onBooks ? { paid: expPaid } : {}) },
        net: { received: round2(all.received - expPaid), charged: round2(all.charged - expTotal) },
        workTradeCovered: sumBy(properties, p => p.money.workTradeCovered),
        depositsReceived: sumBy(properties, p => p.money.depositsReceived),
        depositsReturned: sumBy(properties, p => p.money.depositsReturned),
      },
      operations: {
        maintenance: {
          opened: sumBy(properties, p => p.operations.maintenance.opened),
          closed: sumBy(properties, p => p.operations.maintenance.closed),
          cost: sumBy(properties, p => p.operations.maintenance.cost),
        },
        stays: {
          stays: sumBy(properties, p => p.operations.stays.stays),
          nights: sumBy(properties, p => p.operations.stays.nights),
          bookedThisMonth: sumBy(properties, p => p.operations.stays.bookedThisMonth),
        },
        utilityExpensesLogged: sumBy(properties, p => p.operations.utilityExpensesLogged),
      },
    },
  }
}

/** Every stamp the shared list knows is in REPORT_STAMP_ORDER (a new stamp cannot be dropped from the counts). */
export const REPORT_STAMPS_COMPLETE = PAYMENT_STAMPS.every(s => REPORT_STAMP_ORDER.includes(s))

// ─── Who gets it (10/12, Nic: "the recipients the OWNER picks") ─────────────

/** A person on the company's team, as the recipient list offers them. */
export interface TeamMember {
  userId: string
  email: string
  name: string
  /** 'owner', or a team role (LANDLORD_ASSIGNABLE_ROLES). */
  role: string
  roleLabel: string
  /** The properties their own scope lets them see; null = every property. */
  propertyIds: string[] | null
}

const ROLE_ORDER = ['owner', 'property_manager', 'onsite_manager', 'bookkeeper', 'maintenance'] as const

/**
 * Everyone on one company's team — its owners (the account owner and every
 * co-owner), property managers, on-site managers, bookkeepers and maintenance
 * — each once (an owner who is also on a scope row is an owner), with the
 * properties their own scope reads: an owner every property; a manager or
 * maintenance worker their assigned ones; a bookkeeper their ticked current
 * properties (lib/bookkeeperScope — a company-wide bookkeeper with every
 * property ticked reads them all, named one by one: 10/12 review).
 */
export async function companyTeam(landlordId: string): Promise<TeamMember[]> {
  const rows = await query<any>(`
    SELECT u.id AS user_id, u.email, u.first_name, u.last_name, 'owner' AS role, NULL::uuid[] AS property_ids, TRUE AS all_properties
      FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1
    UNION ALL
    SELECT u.id, u.email, u.first_name, u.last_name, 'owner', NULL::uuid[], TRUE
      FROM landlord_members lm JOIN users u ON u.id = lm.user_id WHERE lm.landlord_id = $1
    UNION ALL
    SELECT u.id, u.email, u.first_name, u.last_name, 'property_manager', s.property_ids, s.all_properties
      FROM property_manager_scopes s JOIN users u ON u.id = s.user_id WHERE s.landlord_id = $1
    UNION ALL
    SELECT u.id, u.email, u.first_name, u.last_name, 'onsite_manager', s.property_ids, s.all_properties
      FROM onsite_manager_scopes s JOIN users u ON u.id = s.user_id WHERE s.landlord_id = $1
    UNION ALL
    SELECT u.id, u.email, u.first_name, u.last_name, 'maintenance', s.property_ids, s.all_properties
      FROM maintenance_worker_scopes s JOIN users u ON u.id = s.user_id WHERE s.landlord_id = $1
    UNION ALL
    SELECT u.id, u.email, u.first_name, u.last_name, 'bookkeeper', NULL::uuid[], FALSE
      FROM bookkeeper_scopes s JOIN users u ON u.id = s.user_id WHERE s.landlord_id = $1`, [landlordId])
  const best = new Map<string, any>()
  for (const r of rows) {
    const cur = best.get(r.user_id)
    if (!cur || ROLE_ORDER.indexOf(r.role) < ROLE_ORDER.indexOf(cur.role)) best.set(r.user_id, r)
  }
  const out: TeamMember[] = []
  for (const r of best.values()) {
    let propertyIds: string[] | null = r.all_properties ? null : (r.property_ids ?? [])
    if (r.role === 'bookkeeper') {
      const [row] = await bookkeeperScopesOf(r.user_id, landlordId)
      propertyIds = row ? requestScopeOf(row).currentIds : []
      // 10/12 (Nic) review, SECURITY (BK3): a whole-company bookkeeper's
      // properties are named one by one (the company's today), the way the
      // on-screen report names them (routes/reports monthlyReportScope) — never
      // "every property", which builds the line for money outside the listed
      // properties and would carry a sold property's history they never kept.
      if (propertyIds === null) {
        propertyIds = (await query<{ id: string }>(
          `SELECT id FROM properties WHERE landlord_id = $1 ORDER BY name, id`, [landlordId])).map(p => p.id)
      }
    }
    out.push({
      userId: r.user_id, email: String(r.email || '').toLowerCase(),
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email,
      role: r.role,
      roleLabel: r.role === 'owner' ? 'Owner' : LANDLORD_ASSIGNABLE_ROLE_LABEL[r.role as LandlordAssignableRole] ?? 'Team member',
      propertyIds,
    })
  }
  return out.sort((a, b) => ROLE_ORDER.indexOf(a.role as any) - ROLE_ORDER.indexOf(b.role as any) || a.name.localeCompare(b.name))
}

export interface ReportRecipient {
  kind: MonthlyReportRecipientKind
  userId: string | null
  email: string
  name: string | null
  role: string | null
  roleLabel: string | null
  /** The properties their report covers; null = every property. */
  propertyIds: string[] | null
}

export interface RecipientList {
  /** True when the owner has never saved a list: the report goes to the owner only. */
  isDefault: boolean
  recipients: ReportRecipient[]
  /** People on the list who are no longer on the team (they get nothing; shown so the owner can tidy up). */
  leftTeam: Array<{ userId: string; name: string }>
}

/**
 * The company's recipients as they stand today. Never saved = the account
 * owner only (Nic's default). A team member's report covers the properties
 * their own scope reads, read fresh (a manager moved off a park stops getting
 * its report); one who has left the team gets nothing. Another address gets
 * every property — the owner chose to share the company's books with it.
 * One entry per address.
 */
export async function recipientsOf(landlordId: string, team?: TeamMember[]): Promise<RecipientList> {
  const members = team ?? await companyTeam(landlordId)
  const rows = await query<any>(
    `SELECT r.kind, r.user_id, r.email, r.removed_at, u.first_name, u.last_name
       FROM monthly_report_recipients r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.landlord_id = $1 ORDER BY r.created_at, r.id`, [landlordId])
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [landlordId])
  const isDefault = rows.length === 0
  const live = isDefault
    ? (owner ? [{ kind: 'team_member', user_id: owner.user_id, email: null }] : [])
    : rows.filter(r => !r.removed_at)
  const out: ReportRecipient[] = []
  const leftTeam: RecipientList['leftTeam'] = []
  const seen = new Set<string>()
  for (const r of live) {
    if (r.kind === 'team_member') {
      const m = members.find(x => x.userId === r.user_id)
      if (!m) {
        leftTeam.push({ userId: r.user_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Former team member' })
        continue
      }
      if (!m.email || seen.has(m.email)) continue
      seen.add(m.email)
      out.push({ kind: 'team_member', userId: m.userId, email: m.email, name: m.name, role: m.role, roleLabel: m.roleLabel, propertyIds: m.propertyIds })
    } else {
      const email = String(r.email).toLowerCase()
      if (seen.has(email)) continue
      seen.add(email)
      out.push({ kind: 'email', userId: null, email, name: null, role: null, roleLabel: null, propertyIds: null })
    }
  }
  return { isDefault, recipients: out, leftTeam }
}

/** A plain email address (what the recipient list accepts). */
export const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Save the owner's list (owner or GAM admin only — the route checks). Keep
 * everything: a dropped recipient's row is stamped removed, never deleted; a
 * person or address added back gets a new row. `teamMemberIds` must be on
 * the company's team; `emails` are other addresses (lowercased, deduplicated,
 * at most MONTHLY_REPORT_MAX_EXTRA_EMAILS). Returns the list as it now stands.
 */
export async function saveRecipients(
  landlordId: string, byUserId: string, teamMemberIds: readonly string[], emails: readonly string[],
): Promise<RecipientList> {
  const team = await companyTeam(landlordId)
  const ids = [...new Set(teamMemberIds)]
  const strangers = ids.filter(id => !team.some(m => m.userId === id))
  if (strangers.length) throw new AppError(400, 'Someone on that list is not on this company\'s team.')
  const addrs = [...new Set(emails.map(e => String(e).trim().toLowerCase()).filter(Boolean))]
  const bad = addrs.filter(e => !EMAIL_ADDRESS_RE.test(e) || e.length > 254)
  if (bad.length) throw new AppError(400, `That is not an email address: ${bad[0]}`)
  if (addrs.length > MONTHLY_REPORT_MAX_EXTRA_EMAILS) {
    throw new AppError(400, `Add at most ${MONTHLY_REPORT_MAX_EXTRA_EMAILS} other addresses.`)
  }
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // One save at a time per company, so two owners saving at once cannot interleave.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`monthly_report_recipients:${landlordId}`])
    await client.query(
      `UPDATE monthly_report_recipients SET removed_at = now(), removed_by_user_id = $2
        WHERE landlord_id = $1 AND removed_at IS NULL
          AND ((kind = 'team_member' AND NOT (user_id = ANY($3::uuid[])))
            OR (kind = 'email' AND NOT (email = ANY($4::text[]))))`,
      [landlordId, byUserId, ids, addrs])
    for (const id of ids) {
      await client.query(
        // clock_timestamp(), not the transaction's now(): the list reads back in
        // the order it was saved (recipientsOf orders by created_at), never by
        // a random id among rows saved in the same instant.
        `INSERT INTO monthly_report_recipients (landlord_id, kind, user_id, added_by_user_id, created_at)
         SELECT $1, 'team_member', $2, $3, clock_timestamp()
          WHERE NOT EXISTS (SELECT 1 FROM monthly_report_recipients
                             WHERE landlord_id = $1 AND kind = 'team_member' AND user_id = $2 AND removed_at IS NULL)`,
        [landlordId, id, byUserId])
    }
    for (const e of addrs) {
      await client.query(
        `INSERT INTO monthly_report_recipients (landlord_id, kind, email, added_by_user_id, created_at)
         SELECT $1, 'email', $2, $3, clock_timestamp()
          WHERE NOT EXISTS (SELECT 1 FROM monthly_report_recipients
                             WHERE landlord_id = $1 AND kind = 'email' AND email = $2 AND removed_at IS NULL)`,
        [landlordId, e, byUserId])
    }
    // The list is saved: an empty one is the owner's choice (nobody), never the default again.
    if (ids.length === 0 && addrs.length === 0) {
      const any = await client.query(`SELECT 1 FROM monthly_report_recipients WHERE landlord_id = $1 LIMIT 1`, [landlordId])
      if (!any.rows.length) {
        // Keep everything: the owner's own row, written and removed in the same save, records the choice.
        const owner = team.find(m => m.role === 'owner')
        if (owner) {
          await client.query(
            `INSERT INTO monthly_report_recipients (landlord_id, kind, user_id, added_by_user_id, removed_at, removed_by_user_id)
             VALUES ($1, 'team_member', $2, $3, now(), $3)`, [landlordId, owner.userId, byUserId])
        }
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
  return recipientsOf(landlordId, team)
}

/**
 * How long a claimed send may sit at 'sending' before it is called stuck. A
 * send takes seconds (build the report, render the PDF, hand it to the mail
 * service); the job runs hourly, so the run after a process died finds it
 * (jobs/monthlyPropertyReportEmail noticeStuckSends raises GAM's notice).
 */
export const MONTHLY_REPORT_STUCK_AFTER_MINUTES = 30
/**
 * 10/12 (Nic): what the owner's recipient list says of a send stuck at
 * 'sending' past MONTHLY_REPORT_STUCK_AFTER_MINUTES — it used to read
 * "Sending" forever. GAM is told by the stuck-send notice (raised before the
 * list is read: routes/reports recipientsReply).
 *
 * 10/12 (Nic, review): "GAM was alerted" only where the notice is actually on
 * record (lastSends reads it: admin_notifications or its archive, category
 * MONTHLY_REPORT_STUCK_CATEGORY, context.send_id). The check that raises it can
 * fail (it is caught and logged so the list still loads), and then no notice
 * exists — the list says MONTHLY_REPORT_STUCK_UNALERTED_LABEL until a later
 * read or the hourly job raises it.
 */
export const MONTHLY_REPORT_STUCK_LABEL = 'Not sent — stuck, GAM was alerted'
/** 10/12 (Nic, review): stuck, and GAM's notice is not on record (yet). */
export const MONTHLY_REPORT_STUCK_UNALERTED_LABEL = 'Not sent — stuck'
/**
 * admin_notifications.category of the stuck-send notice (one per send:
 * context.send_id). Lives here, beside the label that depends on it; the
 * email job (jobs/monthlyPropertyReportEmail noticeStuckSends) re-exports it.
 */
export const MONTHLY_REPORT_STUCK_CATEGORY = 'monthly_report_send_stuck'

/** The last send of the month's report to each address (the report page shows it beside the list). */
export async function lastSends(landlordId: string, now: Date = new Date()): Promise<Array<{
  month: string; email: string; status: MonthlyReportSendStatus; statusLabel: string; sentAt: string | null; attempts: number
  /** 10/12: still 'sending' past MONTHLY_REPORT_STUCK_AFTER_MINUTES. */
  stuck: boolean
}>> {
  // 10/12 (Nic, review): `alerted` — GAM's stuck-send notice for this very
  // send is on record (live or archived). Only then does the list say GAM was
  // alerted; the time alone said so even when raising the notice had failed.
  const rows = await query<any>(
    `SELECT DISTINCT ON (s.recipient_key) to_char(s.report_month, 'YYYY-MM') AS month, s.email, s.status, s.sent_at, s.attempts,
            (s.status = 'sending' AND s.updated_at < $2::timestamptz - make_interval(mins => $3::int)) AS stuck,
            (s.status = 'sending'
             AND (EXISTS (SELECT 1 FROM admin_notifications n
                           WHERE n.category = $4 AND n.context->>'send_id' = s.id::text)
                  OR EXISTS (SELECT 1 FROM admin_notifications_archive n
                              WHERE n.category = $4 AND n.context->>'send_id' = s.id::text))) AS alerted
       FROM monthly_report_sends s WHERE s.landlord_id = $1
      ORDER BY s.recipient_key, s.report_month DESC, s.created_at DESC`,
    [landlordId, now.toISOString(), MONTHLY_REPORT_STUCK_AFTER_MINUTES, MONTHLY_REPORT_STUCK_CATEGORY])
  return rows.map(r => ({
    month: r.month, email: r.email, status: r.status,
    statusLabel: r.stuck === true
      ? (r.alerted === true ? MONTHLY_REPORT_STUCK_LABEL : MONTHLY_REPORT_STUCK_UNALERTED_LABEL)
      : MONTHLY_REPORT_SEND_STATUS_LABEL[r.status as MonthlyReportSendStatus] ?? 'Sending',
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null, attempts: r.attempts, stuck: r.stuck === true,
  }))
}

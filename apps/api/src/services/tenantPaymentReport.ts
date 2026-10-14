/**
 * THE TENANT PAYMENT REPORT (10/12, Nic) — one household's whole payment story,
 * printable, opened from a name on the Rent Roll or from the tenant profile.
 *
 *   "household-wide; summary (payment health %, months on time / late /
 *    partial / outstanding over the window); HOW LATE: each late month's days
 *    past grace, plus the pattern (median and range, e.g. 'usually 1-2 days
 *    past grace'); PARTIALS: count, average partial amount, average days to
 *    settle the rest; full charge history with a 'What it's for' column (Rent,
 *    Electric, Late fee, Home payment, ...) for every line, paid date, method,
 *    amount; credits applied; work trade covered."
 *
 * Everything is read from services/householdMonths — the one payment-health
 * definition — so the report, the Rent Roll, the Tenants list and the profile
 * say the same thing. Days late are always days past the grace period. 10/12
 * (Nic): "payment health and a tenant's history are ALL-TIME (since the
 * household joined GAM), not 12 months" — the window is every month since the
 * household's first bill, and so is the stamp strip. Payment history
 * imported from another platform (the payment-history CSV) is listed on its
 * own, labeled with where it came from, and never counted (10/12, Nic: "health
 * starts with the first bill GAM wrote").
 *
 * 10/13 (Nic): "this is the kind of information I want to see on the customer
 * history". Opened from a name on the Payments page or the Rent Roll, the
 * report is that row's household — its LEASE (`leaseId`: "when someone is
 * renting 2 spots with 2 leases it is 2 households"); opened from the tenant
 * profile (no lease named), the person's whole household as before. "How
 * late" lists EVERY billed month (it showed only the months past grace: 2 of 5
 * open months), each with its status in the Rent Roll's words (`status`:
 * paid | paid_late | partial | owes | due — a partial past grace is "Owes +N"),
 * and so does every stamp of the all-time strip. The 10/12 breakdown stays:
 * how late they usually are (paid-late months), the average partial payment and
 * how long the difference takes to settle; `history` is the "What it's for"
 * list — every charge line: what it's for, amount, paid date, how paid, days
 * past grace.
 */
import { query } from '../db'
import {
  LEASE_TYPE_LABEL, GRACE_SOURCE_LABEL, RENT_ROLL_STATUS_COLOR, rentRollStatusOf, rentRollStatusText,
  type LeaseType, type GraceSource, type RentRollMonthStatus, type RentRollStatusColor,
} from '@gam/shared'
import {
  householdMonths, householdLines, paymentHealth, householdsOf, householdMembers, currentBillMonth, monthsBetween,
  importedHistory, owesPastGrace, ALL_TIME_FROM, type HouseholdMonth, type PaymentHealth, type ChargeLine, type ImportedLine,
} from './householdMonths'
import { DEFAULT_LATE_GRACE_DAYS, firstLateDay } from './openBalances'
import { todayIn } from '../lib/timezone'

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number) => Math.round(c) / 100
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`

/** The lease's late-fee terms in words ("$5 a day, counted back to the due date once the grace period has passed; no cap"). */
export function lateFeeTermsText(l: {
  late_fee_enabled: boolean | null
  late_fee_initial_type: string | null; late_fee_initial_amount: string | number | null
  late_fee_accrual_type: string | null; late_fee_accrual_amount: string | number | null; late_fee_accrual_period: string | null
  late_fee_accrual_from: string | null
  late_fee_cap_type: string | null; late_fee_cap_amount: string | number | null
}): string {
  if (l.late_fee_enabled === false) return 'No late fee'
  const amt = (type: string | null, v: string | number | null) =>
    type === 'percent_of_rent' ? `${Number(v)}% of the rent` : money(Number(v))
  const parts: string[] = []
  if (l.late_fee_initial_amount != null && Number(l.late_fee_initial_amount) > 0) {
    parts.push(`${amt(l.late_fee_initial_type, l.late_fee_initial_amount)} once the grace period has passed`)
  }
  if (l.late_fee_accrual_amount != null && Number(l.late_fee_accrual_amount) > 0 && l.late_fee_accrual_period) {
    const per = { daily: 'a day', weekly: 'a week', monthly: 'a month' }[l.late_fee_accrual_period] ?? 'each period'
    const from = l.late_fee_accrual_from === 'grace_end' ? 'from the end of the grace period'
      : 'counted back to the due date once the grace period has passed'
    parts.push(`${parts.length ? 'then ' : ''}${amt(l.late_fee_accrual_type, l.late_fee_accrual_amount)} ${per}, ${from}`)
  }
  if (!parts.length) return 'No late fee'
  const cap = l.late_fee_cap_amount != null && Number(l.late_fee_cap_amount) > 0
    ? `capped at ${amt(l.late_fee_cap_type, l.late_fee_cap_amount)}` : 'no cap'
  const text = `${parts.join('; ')}; ${cap}`
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The median of a list of numbers (the middle one; between the two middle ones, their average). */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`

/** "Usually 1 day past grace (1–2)" / "Usually 10 days past grace (8–14)". */
export function latenessPattern(daysPast: readonly number[]): string | null {
  if (!daysPast.length) return null
  const m = median(daysPast)!
  const lo = Math.min(...daysPast), hi = Math.max(...daysPast)
  const usual = Number.isInteger(m) ? days(m) : `${m} days`
  return `Usually ${usual} past grace${lo === hi ? '' : ` (${lo}–${hi})`}`
}

export const LATENESS_BUCKETS = ['within_grace', 'd1_3', 'd4_15', 'd16_30', 'd31_plus'] as const
export type LatenessBucket = typeof LATENESS_BUCKETS[number]
export const LATENESS_BUCKET_LABEL: Record<LatenessBucket, string> = {
  within_grace: 'Paid within grace',
  d1_3: '1–3 days past grace',
  d4_15: '4–15 days past grace',
  d16_30: '16–30 days past grace',
  d31_plus: '31+ days past grace',
}
function bucketOf(d: number): LatenessBucket {
  return d <= 0 ? 'within_grace' : d <= 3 ? 'd1_3' : d <= 15 ? 'd4_15' : d <= 30 ? 'd16_30' : 'd31_plus'
}

const dayNum = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000)

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
function ordinal(n: number): string {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/**
 * The first late day of a lease's rent, in words — "the 6th" for rent due the
 * 1st with 5 days of grace (10/12, Nic: "the 6th is late, the day late fees
 * start"). From the one rule (services/lateness firstLateDay), never the page's
 * arithmetic: the page used to print "late from day {grace + 1}", which was
 * wrong for rent due on any day but the 1st and for a grace of 0. When the
 * first late day falls in the next month (rent due the 28th, 5 days), it says
 * how many days after the due date instead.
 */
export function firstLateDayText(rentDueDay: number, graceDays: number): string {
  const due = Math.min(Math.max(Math.trunc(rentDueDay) || 1, 1), 28)
  const start = `2026-01-${String(due).padStart(2, '0')}`   // any 31-day month
  const first = firstLateDay(start, graceDays)
  if (first.slice(0, 7) === start.slice(0, 7)) return `the ${ordinal(Number(first.slice(8, 10)))}`
  const after = dayNum(first) - dayNum(start)
  return `${after} day${after === 1 ? '' : 's'} after the due date`
}

export interface ReportLease {
  lease_id: string
  property_name: string
  unit_number: string
  status: string
  lease_type_label: string
  start_date: string
  end_date: string | null
  rent_amount: number
  rent_due_day: number
  grace_days: number
  grace_source: GraceSource
  grace_source_label: string
  /** The first late day in words ("the 6th"): services/lateness firstLateDay. */
  first_late_day_text: string
  late_fee_terms: string
  existing_tenancy: boolean
  /**
   * 10/13 (Nic): the red "Delinquent" — this lease past its grace period with
   * money still owed (householdMonths owesPastGrace: the Payments page's tag,
   * the one rule), judged from its own months, so it clears the moment it is
   * paid. Never the space's overnight flag (units.status), which lags a
   * payment until the nightly job runs: the report a name on the Payments page
   * opens says what the row says.
   */
  delinquent: boolean
  eviction_mode: boolean
}

/** One line of the full history: a charge, or a bill's daily late fees collapsed into one. */
export interface HistoryLine extends ChargeLine {
  /** Daily late fees of one bill, collapsed: how many and over which days. */
  late_fee_count?: number
  late_fee_from?: string
  late_fee_to?: string
  late_fees?: ChargeLine[]
}

/** A month's pill in the Rent Roll's words (10/13). */
export interface MonthStatus {
  status: RentRollMonthStatus
  status_label: string
  status_color: RentRollStatusColor
}

/** The Rent Roll's pill for a judged month (no bill: 'none'). */
export function monthStatus(m: Pick<HouseholdMonth, 'stamp' | 'days_past_grace'> | undefined): MonthStatus {
  const status = rentRollStatusOf(m?.stamp ?? null, m?.days_past_grace ?? 0)
  const days = status === 'paid_late' || status === 'owes' ? (m?.days_past_grace ?? 0) : 0
  return { status, status_label: rentRollStatusText({ status, daysPastGrace: days }), status_color: RENT_ROLL_STATUS_COLOR[status] }
}

export interface TenantPaymentReport {
  household_id: string
  /** 10/13: the one lease the report covers (opened from a Rent Roll row); null = the person's whole household. */
  lease_id: string | null
  members: Array<{ tenant_id: string; name: string; role: string | null }>
  name: string
  leases: ReportLease[]
  /** YYYY-MM: the household's first bill month on GAM. */
  on_gam_since: string | null
  onboarding_month: string | null
  balance_owed_now: number
  /**
   * 10/13 (Nic): "Tenant report 'Delinquent' uses the money rule (same as
   * Payments)" — the report's own money (the one lease; or, from the profile,
   * the person's whole household, a charge on no lease included) past its
   * grace period with money still owed: householdMonths owesPastGrace, the
   * Payments page's tag. Clears the moment it is paid.
   */
  delinquent: boolean
  health: PaymentHealth
  /**
   * Every month from the household's first bill on GAM through the month
   * judged to, oldest first (10/12: all time; stamp null = nothing billed that
   * month). 10/13: `status` / `status_label` / `status_color` are the Rent
   * Roll's pill for the month (rentRollStatusOf: a partial past grace is
   * "Owes +N"; no bill, 'none').
   */
  stamps: Array<Pick<HouseholdMonth, 'month' | 'stamp' | 'stamp_label' | 'days_past_grace' | 'charged' | 'paid' | 'credit' | 'work_trade' | 'owed' | 'paid_in_full_on' | 'onboarding' | 'work_trade_only' | 'counted'> & MonthStatus>
  how_late: {
    /**
     * 10/13 (Nic): EVERY billed month, newest first — on time, late, part paid
     * or still owed — with its days past grace (0: within grace). `still_open`:
     * something on its bills (rent, utilities, fees) is still owed;
     * `due_date`: the bill's due date.
     */
    months: Array<{
      month: string; days_past_grace: number; paid_in_full_on: string | null; still_open: boolean
      first_late_day: string | null; due_date: string | null
      charged: number; paid: number; owed: number
    } & MonthStatus>
    pattern: string | null
    median: number | null
    min: number | null
    max: number | null
    average: number | null
    distribution: Array<{ bucket: LatenessBucket; label: string; months: number }>
    worst: { month: string; days_past_grace: number } | null
    /** Average days past grace of the last 3 late months, against the ones before. */
    trend: { recent: number | null; earlier: number | null } | null
  }
  partials: {
    months: number
    average_first_payment: number | null
    average_first_percent: number | null
    average_days_to_settle: number | null
    open: Array<{ month: string; owed: number; days_since_first_payment: number | null }>
  }
  late_fees: { charged: number; paid: number; credit: number; owed: number; months: number }
  credit_applied: number
  work_trade: {
    months_covered: number
    value_covered: number
    by_charge: Array<{ label: string; amount: number }>
    agreements: Array<{ status: string; covered_charges: string[]; tracks_hours: boolean; monthly_hours_target: number }>
    hours: Array<{ month: string; worked: number; target: number }>
  }
  months: HouseholdMonth[]
  history: HistoryLine[]
  /**
   * 10/12 (Nic): "CSV-imported old payment history does NOT count toward
   * payment health — health starts with the first bill GAM wrote; imported
   * history still shows in the report." Payments brought in from another
   * platform, newest first, each labeled with where it came from — never in
   * the health, the stamps, the months or `history` above.
   */
  imported: ImportedLine[]
}

/**
 * The household of `tenantId` with these companies (a property-locked viewer:
 * those properties). null when the person has nothing with them.
 */
export async function tenantPaymentReport(opts: {
  tenantId: string
  landlordIds: string[]
  propertyIds: string[] | null
  /**
   * 10/13 (Nic): the household is the LEASE ("2 spots with 2 leases it is 2
   * households") — the report of one Rent Roll row. The person must be on it,
   * and it must be one the viewer may see; otherwise null (404).
   */
  leaseId?: string | null
  through?: string
  asOf?: string | null
}): Promise<TenantPaymentReport | null> {
  if (!opts.landlordIds.length) return null
  const leaseId = opts.leaseId ?? null
  let lease: { unit_id: string; primary_id: string | null } | null = null
  if (leaseId) {
    ;[lease] = await query<{ unit_id: string; primary_id: string | null }>(`
      SELECT l.unit_id,
             (SELECT lt.tenant_id FROM lease_tenants lt
               WHERE lt.lease_id = l.id AND lt.role = 'primary' AND lt.status <> 'void'
               ORDER BY (lt.status = 'active') DESC, lt.created_at, lt.id LIMIT 1) AS primary_id
        FROM leases l JOIN units u ON u.id = l.unit_id
       WHERE l.id = $1 AND l.landlord_id = ANY($2::uuid[])
         AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
         AND EXISTS (SELECT 1 FROM lease_tenants me WHERE me.lease_id = l.id AND me.tenant_id = $4 AND me.status <> 'void')`,
      [leaseId, opts.landlordIds, opts.propertyIds, opts.tenantId])
    if (!lease) return null
  }
  // 10/12: a viewer kept to some properties gets the household of the person's
  // lease AT THOSE properties — never one from the company's other parks.
  const householdId = lease
    ? (lease.primary_id ?? opts.tenantId)
    : (await householdsOf([opts.tenantId], opts.landlordIds, opts.propertyIds)).get(opts.tenantId) ?? opts.tenantId
  const through = opts.through ?? currentBillMonth()
  // One lease: every charge of the lease (whoever on it was billed); else the household's.
  const scope = {
    landlordIds: opts.landlordIds, propertyIds: opts.propertyIds, asOf: opts.asOf ?? null,
    householdIds: leaseId ? null : [householdId], leaseIds: leaseId ? [leaseId] : null,
  }
  const [months, lines, imported] = await Promise.all([
    // One lease is one month per bill month, whichever company billed a line on it (byLease).
    householdMonths({ ...scope, from: ALL_TIME_FROM, through, byLease: !!leaseId }),
    householdLines({ ...scope, from: ALL_TIME_FROM, through }),
    // One lease: its own imported lines only, never the person's other lease's.
    importedHistory({ landlordIds: opts.landlordIds, propertyIds: opts.propertyIds, householdIds: [householdId], leaseIds: scope.leaseIds }),
  ])

  // 10/12: a viewer kept to some properties (S655) sees the household as it
  // lived there — its residents on a lease at those properties, never a
  // co-tenant from the company's other parks. The primary resident is put to
  // the same test (a Park B primary's name never reaches a Park A-only viewer).
  const memberIds = leaseId
    ? (await query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM lease_tenants WHERE lease_id = $1 AND status <> 'void'`, [leaseId])).map(r => r.tenant_id)
    : (await query<{ id: string }>(`
    SELECT m.id FROM unnest($1::uuid[]) AS m(id)
     WHERE $3::uuid[] IS NULL
        OR EXISTS (SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id JOIN units u ON u.id = l.unit_id
                    WHERE lt.tenant_id = m.id AND lt.status <> 'void'
                      AND l.landlord_id = ANY($2::uuid[]) AND u.property_id = ANY($3::uuid[]))`,
    [await householdMembers(householdId, opts.landlordIds), opts.landlordIds, opts.propertyIds])).map(r => r.id)
  const people = await query<{ id: string; name: string; role: string | null }>(`
    SELECT t.id, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name,
           (SELECT lt.role FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
             WHERE lt.tenant_id = t.id AND l.landlord_id = ANY($2::uuid[]) AND lt.status <> 'void'
             ORDER BY (lt.role = 'primary') DESC LIMIT 1) AS role
      FROM tenants t JOIN users u ON u.id = t.user_id
     WHERE t.id = ANY($1::uuid[])`, [memberIds, opts.landlordIds])

  const leaseRows = await query<any>(`
    SELECT l.id AS lease_id, pr.name AS property_name, u.unit_number, l.status, l.lease_type,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date, to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
           l.rent_amount::text AS rent_amount, l.rent_due_day, l.is_existing_tenancy,
           l.late_fee_grace_days AS lease_grace, pr.late_fee_grace_days AS property_grace,
           l.late_fee_enabled, l.late_fee_initial_type, l.late_fee_initial_amount, l.late_fee_accrual_type,
           l.late_fee_accrual_amount, l.late_fee_accrual_period, l.late_fee_accrual_from, l.late_fee_cap_type, l.late_fee_cap_amount,
           COALESCE(u.payment_block, FALSE) AS eviction_mode
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties pr ON pr.id = u.property_id
     WHERE l.landlord_id = ANY($2::uuid[])
       AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
       AND l.id IN (SELECT lt.lease_id FROM lease_tenants lt WHERE lt.tenant_id = ANY($1::uuid[]) AND lt.status <> 'void')
       AND ($4::uuid IS NULL OR l.id = $4)
     ORDER BY (l.status = 'active') DESC, l.start_date DESC`, [memberIds, opts.landlordIds, opts.propertyIds, leaseId])
  if (!months.length && !leaseRows.length && !imported.length) return null

  // 10/13 (Nic): "Delinquent" — each lease from its own months (one lease:
  // the report's own; the person's whole household: each of their leases,
  // read once), by the Payments page's rule (owesPastGrace).
  const delinquentLeases = new Set<string>()
  if (leaseId) {
    if (owesPastGrace(months)) delinquentLeases.add(leaseId)
  } else if (leaseRows.length) {
    const perLease = await householdMonths({
      landlordIds: opts.landlordIds, propertyIds: opts.propertyIds, asOf: opts.asOf ?? null, householdIds: null,
      leaseIds: leaseRows.map((l: any) => l.lease_id), from: ALL_TIME_FROM, through, byLease: true,
    })
    for (const l of leaseRows) if (owesPastGrace(perLease.filter(m => m.lease_id === l.lease_id))) delinquentLeases.add(l.lease_id)
  }

  const leases: ReportLease[] = leaseRows.map((l: any) => {
    const source: GraceSource = l.lease_grace != null ? 'lease' : l.property_grace != null ? 'property' : 'default'
    const grace = l.lease_grace ?? l.property_grace ?? DEFAULT_LATE_GRACE_DAYS
    return {
      lease_id: l.lease_id, property_name: l.property_name, unit_number: l.unit_number, status: l.status,
      lease_type_label: LEASE_TYPE_LABEL[l.lease_type as LeaseType] ?? 'Lease',
      start_date: l.start_date, end_date: l.end_date, rent_amount: Number(l.rent_amount), rent_due_day: Number(l.rent_due_day ?? 1),
      grace_days: Number(grace), grace_source: source, grace_source_label: GRACE_SOURCE_LABEL[source],
      first_late_day_text: firstLateDayText(Number(l.rent_due_day ?? 1), Number(grace)),
      late_fee_terms: lateFeeTermsText(l), existing_tenancy: l.is_existing_tenancy === true,
      delinquent: delinquentLeases.has(l.lease_id), eviction_mode: l.eviction_mode === true,
    }
  })

  const judged = months.filter(m => m.stamp !== null)
  const health = paymentHealth(months, through)
  // 10/12 (Nic): all time — one stamp for every month since the household's
  // first bill on GAM (on_gam_since below), never only the last 12.
  const onGamSince = judged[0]?.month ?? months[0]?.month ?? null
  const byMonth = new Map(months.map(m => [m.month, m]))
  const stamps = (onGamSince ? monthsBetween(onGamSince < through ? onGamSince : through, through) : []).map(month => {
    const m = byMonth.get(month)
    return {
      month, stamp: m?.stamp ?? null, stamp_label: m?.stamp_label ?? null, days_past_grace: m?.days_past_grace ?? 0,
      charged: m?.charged ?? 0, paid: m?.paid ?? 0, credit: m?.credit ?? 0, work_trade: m?.work_trade ?? 0, owed: m?.owed ?? 0,
      paid_in_full_on: m?.paid_in_full_on ?? null, onboarding: m?.onboarding ?? false, work_trade_only: m?.work_trade_only ?? false,
      counted: m?.counted ?? false, ...monthStatus(m),
    }
  })

  // HOW LATE — every month that went past its grace period (paid late, or
  // still open past it), days past grace each; and the months paid after
  // their due date but inside grace, for the distribution.
  const lateMonths = judged.filter(m => m.days_past_grace > 0 && (m.stamp === 'paid_late' || m.stamp === 'outstanding' || m.stamp === 'partial'))
  // The pattern is how late they PAY: months paid in full past grace. A month
  // still open is listed with its days so far, but it has not finished
  // counting, so it is not part of the typical figure.
  const paidLate = lateMonths.filter(m => m.stamp === 'paid_late')
  const lateDays = paidLate.map(m => m.days_past_grace)
  const dueOf = new Map<string, string>()
  for (const l of lines) if (!l.is_late_fee && (!dueOf.has(l.month) || l.due_date < dueOf.get(l.month)!)) dueOf.set(l.month, l.due_date)
  const paidMonths = judged.filter(m => m.stamp === 'paid_on_time' || m.stamp === 'paid_late')
  const distribution = LATENESS_BUCKETS.map(bucket => ({
    bucket, label: LATENESS_BUCKET_LABEL[bucket],
    months: bucket === 'within_grace'
      ? paidMonths.filter(m => m.days_past_grace === 0 && !m.work_trade_only && m.paid_in_full_on
          && dueOf.has(m.month) && m.paid_in_full_on > dueOf.get(m.month)!).length
      : paidLate.filter(m => bucketOf(m.days_past_grace) === bucket).length,
  }))
  const worst = lateMonths.reduce<HouseholdMonth | null>((w, m) => (!w || m.days_past_grace > w.days_past_grace ? m : w), null)
  const avg = (xs: number[]) => xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null
  const recent = paidLate.slice(-3).map(m => m.days_past_grace)
  const earlier = paidLate.slice(0, -3).map(m => m.days_past_grace)

  // PARTIALS — months paid in parts (money came in on more than one day before
  // the bill was paid in full), and months still part-paid.
  const baseLines = lines.filter(l => !l.is_late_fee && l.work_trade === 0)
  const firstDayIn = (month: string, firstDay: string | null) => firstDay == null ? 0
    : baseLines.filter(l => l.month === month && l.paid_on === firstDay).reduce((s, l) => s + cents(l.paid) + cents(l.credit), 0)
  const inParts = judged.filter(m => m.stamp === 'partial'
    || (m.first_paid_on && m.paid_in_full_on && m.first_paid_on < m.paid_in_full_on))
  const settledParts = inParts.filter(m => m.paid_in_full_on && m.first_paid_on)
  const firstAmounts = inParts.map(m => firstDayIn(m.month, m.first_paid_on)).filter(c => c > 0)
  const firstPercents = inParts.map(m => {
    const c = firstDayIn(m.month, m.first_paid_on)
    return c > 0 && m.charged_base > 0 ? (c / cents(m.charged_base)) * 100 : null
  }).filter((x): x is number => x !== null)
  // GAM's home calendar, like the rest of the report (a UTC date read a day
  // ahead every evening in Phoenix).
  const today = opts.asOf ?? todayIn(null)

  const lf = lines.filter(l => l.is_late_fee)
  const sumC = (xs: ChargeLine[], f: (l: ChargeLine) => number) => dollars(xs.reduce((s, l) => s + cents(f(l)), 0))

  // WORK TRADE
  const wtLines = lines.filter(l => l.work_trade > 0)
  const wtBy = new Map<string, number>()
  for (const l of wtLines) wtBy.set(l.label, (wtBy.get(l.label) ?? 0) + cents(l.work_trade))
  // Every dollar work trade covered is a line now — what a month close
  // settled included (householdLines) — so the lines add up to the months.
  const wtValue = dollars(months.reduce((s, m) => s + cents(m.work_trade), 0))
  // Only the agreements at the properties the viewer may see (S655).
  const agreements = await query<{ status: string; covered_charges: string[]; tracks_hours: boolean; monthly_hours_target: number; id: string }>(`
    SELECT a.id, a.status, a.covered_charges, a.tracks_hours, a.monthly_hours_target
      FROM work_trade_agreements a
      LEFT JOIN units u ON u.id = a.unit_id
     WHERE a.tenant_id = ANY($1::uuid[]) AND a.landlord_id = ANY($2::uuid[])
       AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))
       AND ($4::uuid IS NULL OR a.unit_id = $4)
     ORDER BY (a.status = 'active') DESC, a.start_date DESC`, [memberIds, opts.landlordIds, opts.propertyIds, lease?.unit_id ?? null])
  const hours = agreements.some(a => a.tracks_hours) ? await query<{ month: string; worked: string; target: string }>(`
    SELECT to_char(s.period_month, 'YYYY-MM') AS month, SUM(s.hours_worked)::text AS worked, SUM(s.target_hours)::text AS target
      FROM work_trade_settlements s
     WHERE s.agreement_id = ANY($1::uuid[])
       AND s.agreement_id IN (SELECT id FROM work_trade_agreements WHERE tracks_hours)
       -- 10/12 (G8): a voided period asked for no hours anyone owes.
       AND s.status <> 'voided'
     GROUP BY 1 ORDER BY 1`, [agreements.map(a => a.id)]) : []

  // THE HISTORY — newest first; a bill's daily late fees are one line.
  const history: HistoryLine[] = []
  const feeGroups = new Map<string, ChargeLine[]>()
  for (const l of lines) {
    if (l.is_late_fee && l.invoice_id) {
      const g = feeGroups.get(l.invoice_id)
      if (g) { g.push(l); continue }
      feeGroups.set(l.invoice_id, [l])
      history.push({ ...l })
    } else {
      history.push(l)
    }
  }
  for (const h of history) {
    if (!h.is_late_fee || !h.invoice_id) continue
    const g = feeGroups.get(h.invoice_id)!
    if (g.length < 2) continue
    const paidDays = g.map(x => x.paid_on).filter((d): d is string => !!d)
    const sum = (f: (x: ChargeLine) => number) => dollars(g.reduce((s, x) => s + cents(f(x)), 0))
    Object.assign(h, {
      label: `Late fees, ${g.length} days`,
      charged: sum(x => x.charged), paid: sum(x => x.paid), credit: sum(x => x.credit), owed: sum(x => x.owed),
      // Paid in full on the day the last of them was paid; open while any is owed.
      paid_on: paidDays.length === g.length ? paidDays.sort().slice(-1)[0] : null,
      late_fee_count: g.length, late_fees: g,
    })
  }
  // The day each late fee was charged is its own due date (one per day).
  const feeDays = new Map<string, string[]>()
  if (lf.length) {
    for (const r of await query<{ id: string; d: string }>(
      `SELECT id, to_char(due_date, 'YYYY-MM-DD') AS d FROM payments WHERE id = ANY($1::uuid[])`, [lf.map(l => l.payment_id)])) {
      const inv = lf.find(l => l.payment_id === r.id)?.invoice_id
      if (inv) feeDays.set(inv, [...(feeDays.get(inv) ?? []), r.d])
    }
  }
  for (const h of history) {
    if (h.late_fee_count && h.invoice_id && feeDays.has(h.invoice_id)) {
      const ds = feeDays.get(h.invoice_id)!.sort()
      h.late_fee_from = ds[0]
      h.late_fee_to = ds[ds.length - 1]
    }
  }

  const primary = people.find(p => p.id === householdId)
  return {
    household_id: householdId,
    lease_id: leaseId,
    members: people.map(p => ({ tenant_id: p.id, name: p.name, role: p.role }))
      .sort((a, z) => Number(z.tenant_id === householdId) - Number(a.tenant_id === householdId) || a.name.localeCompare(z.name)),
    name: primary?.name || people[0]?.name || 'Resident',
    leases,
    on_gam_since: onGamSince,
    onboarding_month: months.find(m => m.onboarding)?.month ?? null,
    balance_owed_now: dollars(months.reduce((s, m) => s + cents(m.owed), 0)),
    delinquent: owesPastGrace(months),
    health,
    stamps,
    how_late: {
      // 10/13 (Nic): every billed month, newest first — never only the late ones.
      months: judged.map(m => ({
        month: m.month, days_past_grace: m.days_past_grace, paid_in_full_on: m.paid_in_full_on,
        still_open: cents(m.owed_base) > 0, first_late_day: m.first_late_day, due_date: dueOf.get(m.month) ?? null,
        charged: m.charged, paid: dollars(cents(m.paid) + cents(m.credit)), owed: m.owed,
        ...monthStatus(m),
      })).reverse(),
      pattern: latenessPattern(lateDays),
      median: median(lateDays),
      min: lateDays.length ? Math.min(...lateDays) : null,
      max: lateDays.length ? Math.max(...lateDays) : null,
      average: avg(lateDays),
      distribution,
      worst: worst ? { month: worst.month, days_past_grace: worst.days_past_grace } : null,
      trend: paidLate.length > 3 ? { recent: avg(recent), earlier: avg(earlier) } : null,
    },
    partials: {
      months: inParts.length,
      average_first_payment: firstAmounts.length ? dollars(firstAmounts.reduce((s, c) => s + c, 0) / firstAmounts.length) : null,
      average_first_percent: firstPercents.length ? Math.round(firstPercents.reduce((s, x) => s + x, 0) / firstPercents.length) : null,
      average_days_to_settle: avg(settledParts.map(m => dayNum(m.paid_in_full_on!) - dayNum(m.first_paid_on!))),
      open: judged.filter(m => m.stamp === 'partial').map(m => ({
        month: m.month, owed: m.owed_base,
        days_since_first_payment: m.first_paid_on ? dayNum(today) - dayNum(m.first_paid_on) : null,
      })),
    },
    late_fees: {
      charged: sumC(lf, l => l.charged), paid: sumC(lf, l => l.paid), credit: sumC(lf, l => l.credit), owed: sumC(lf, l => l.owed),
      months: new Set(lf.map(l => l.month)).size,
    },
    credit_applied: dollars(months.reduce((s, m) => s + cents(m.credit), 0)),
    work_trade: {
      months_covered: months.filter(m => m.work_trade_only).length,
      value_covered: wtValue,
      by_charge: [...wtBy.entries()].map(([label, c]) => ({ label, amount: dollars(c) })).sort((a, z) => z.amount - a.amount),
      agreements: agreements.map(a => ({ status: a.status, covered_charges: a.covered_charges, tracks_hours: a.tracks_hours, monthly_hours_target: a.monthly_hours_target })),
      hours: hours.map(h => ({ month: h.month, worked: Number(h.worked), target: Number(h.target) })),
    },
    months,
    history,
    imported,
  }
}

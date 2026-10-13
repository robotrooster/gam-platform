/**
 * PAYMENT HEALTH, ONE DEFINITION: one stamp per HOUSEHOLD per BILL MONTH
 * (10/12, Nic).
 *
 *   "Payment health = ONE definition everywhere, per HOUSEHOLD per BILL MONTH,
 *    never per line. Late fees are never a bill and never decide a month's
 *    color or health; $0 lines are ignored."
 *
 * Every screen that says how a household pays reads it from here: the Rent
 * Roll (GET /api/balances/rent-roll), the tenant payment report (GET
 * /api/tenants/:id/payment-report), the Tenants list's health column, the
 * tenant profile and the tenant's own heartbeat. Before this there were five
 * formulas and none of them measured on-time: Gerald Logue read 25% on the
 * Tenants list (paid rows ÷ rows), 6% on his profile (every $5 daily late fee
 * counted as its own bill) and 0% on his own screen (a blank lease grace read
 * as 0 days).
 *
 * WHAT A MONTH IS — the bill month the Payments ledger and Outstanding already
 * file by (paymentsByMonth.ledgerMonthSql, openBalances BILL_DUE): a charge
 * belongs to the month its invoice is due (a charge on no invoice, its own due
 * date). A HOUSEHOLD is one balance (S652): everyone on a lease together, keyed
 * by the lease's primary resident; a charge on no lease belongs to the person
 * billed, or to the household of the lease they live on with that company.
 *
 * THE MONEY, every dollar counted once (S648) — each charge row is one of:
 *   paid     money that paid it (settled or taken from the deposit), or money
 *            still clearing (counted as paid: the postmark rule; `clearing`)
 *   credit   account credit applied to it (a credit_uses row is tied to one
 *            charge, so it is counted once, on that charge)
 *   work trade  covered by hours: a line still suspended, a line the
 *            month-close settled (the invoice's work_trade_credit_amount), a
 *            line a past trade covered at $0 ("Covered by work trade ($X)")
 *   owed     what it still owes now (openBalances.openBalanceSql /
 *            openAmountSql: the figure Outstanding shows)
 * Voided lines, a 'returned' original (its reopened row carries it), GAM's own
 * money, the FlexPay pull, paid-ahead boxes (the bills that money pays are
 * counted as credit when it pays them) and $0 lines are left out. So is
 * payment history imported from another platform (payments.import_source —
 * 10/12, Nic: "health starts with the first bill GAM wrote"; the tenant report
 * lists it apart, labeled: importedHistory). Charged = paid + credit + work
 * trade + owed.
 *
 * THE STAMP (judged on the BASE charges only — rent, utilities, fees, home
 * payment; late fees are charged and owed but never decide it):
 *   paid_on_time  every base charge paid in full by its last grace day (a line
 *                 work trade covers counts as paid on its due date; a month
 *                 work trade covers in full is paid on time)
 *   paid_late     paid in full, some of it after its grace period
 *   partial       money or credit came in, something is still owed (yellow,
 *                 past grace too: Owed shows what is left)
 *   outstanding   nothing came in and a charge is past its grace period
 *   due           nothing came in and nothing is past its grace period yet
 * Late = the one rule (services/openBalances): lateness starts on the due date
 * or the day GAM wrote the line when later (lateCountsFrom), the first late
 * day is start + grace (the 6th for the 1st with 5 days), grace = the lease's,
 * else the property's, else 5. "Days past grace" = days after the last grace
 * day (paid on the 6th = 1).
 *
 * HEALTH = months paid on time ÷ months counted, over ALL TIME: every month
 * since the household's first bill on GAM (10/12, Nic: "payment health and a
 * tenant's history are ALL-TIME (since the household joined GAM), not 12
 * months"). A month is counted once it is judged: not `due`, not a partial
 * still inside its grace period. The ONBOARDING month
 * (the first rent month of an existing tenancy moved onto GAM) is good news
 * only: paid on time counts, anything else is left out — unless a late fee
 * was charged on its bill (the credit history's 10/6 rule).
 */
import { query } from '../db'
import { FALLBACK_TIMEZONE, PAYMENT_STAMPS, PAYMENT_STAMP_LABEL, paidByLabel, type PaymentStamp } from '@gam/shared'
import {
  graceDaysSql, propertyDaySql, writtenAtSql, lateCountsFromSql, firstLateDaySql, daysPastGraceSql, pastGraceSql,
  openBalanceSql, inFlightRowSql, workTradeOpenRowSql, WORK_TRADE_MARKER_LABEL,
} from './openBalances'
import { payableRowSql } from './moneyPredicates'
import { WORK_TRADE_HELD_NOTE_PARTS } from './lateness'
import { chargeLabel, chargeDetail, chargeLabelColumnsSql } from './invoiceNotice'
import { isCsvImportPlatform, getPaymentPlatformConfig } from '../lib/csvImportMappings'

export { PAYMENT_STAMPS, PAYMENT_STAMP_LABEL }

/**
 * 10/12 (Nic): "Payment health and a tenant's history are ALL-TIME (since the
 * household joined GAM), not 12 months." The first bill month an all-time read
 * starts from — before anything on GAM — so a household's history begins at
 * its own first bill, whenever that was.
 */
export const ALL_TIME_FROM = '2000-01'

/** The kinds of charge that decide a month's stamp (late fees and deposits never do). */
export const BASE_CHARGE_TYPES = ['rent', 'utility', 'fee', 'home_payment'] as const

const cents = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number) => Math.round(c) / 100
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Is this a bill month (YYYY-MM)? */
export function isBillMonth(m: unknown): m is string {
  return typeof m === 'string' && MONTH_RE.test(m)
}

/** 'YYYY-MM' plus n months. */
export function addMonths(ym: string, n: number): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}

/** The months from `from` through `through`, oldest first. */
export function monthsBetween(from: string, through: string): string[] {
  const out: string[] = []
  for (let m = from; m <= through && out.length < 600; m = addMonths(m, 1)) out.push(m)
  return out
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

/**
 * The household a charge row (alias `p`, its invoice `inv`) belongs to: the
 * primary resident of its lease (or its bill's lease); else the person billed —
 * or, when that person lives on a lease with the same company, that lease's
 * primary resident (a co-tenant's counter charge is the household's).
 */
export function householdOfRowSql(p = 'p', inv = 'inv'): string {
  return `COALESCE(
      (SELECT hh_lt.tenant_id FROM lease_tenants hh_lt
        WHERE hh_lt.lease_id = COALESCE(${p}.lease_id, ${inv}.lease_id) AND hh_lt.role = 'primary' AND hh_lt.status <> 'void'
        ORDER BY (hh_lt.status = 'active') DESC, hh_lt.created_at, hh_lt.id LIMIT 1),
      (SELECT hh_p.tenant_id FROM lease_tenants hh_me
         JOIN leases hh_l ON hh_l.id = hh_me.lease_id
         JOIN lease_tenants hh_p ON hh_p.lease_id = hh_me.lease_id AND hh_p.role = 'primary' AND hh_p.status <> 'void'
        WHERE hh_me.tenant_id = COALESCE(${p}.tenant_id, ${inv}.tenant_id)
          AND hh_l.landlord_id = ${p}.landlord_id
          AND hh_me.status IN ('active','pending_add','pending_remove')
        ORDER BY (hh_l.status = 'active') DESC, hh_l.start_date DESC, hh_l.id LIMIT 1),
      COALESCE(${p}.tenant_id, ${inv}.tenant_id))`
}

/** The value a line a past work trade covered at $0 carries in its note ("Covered by work trade ($12.34)"). */
const WT_NOTE_VALUE = `COALESCE(substring(p.notes from 'Covered by work trade \\(\\$([0-9]+(\\.[0-9]+)?)\\)')::numeric, 0)`

export interface HouseholdMonthScope {
  /** The account's companies. Required. */
  landlordIds: string[]
  /** A property-locked viewer's properties; null = every property. */
  propertyIds?: string[] | null
  /** Only these households (primary resident ids); null = all. */
  householdIds?: string[] | null
  /** Bill months, inclusive (YYYY-MM). */
  from: string
  through: string
  /** One row per household per property (the Rent Roll's folders); else per household. */
  byProperty?: boolean
  /** The day to judge on ('YYYY-MM-DD'); default each property's today. For tests. */
  asOf?: string | null
}

/**
 * Every charge row in scope, with what it is, its money parts and its
 * lateness — the one place both the months and the lines are built from.
 * $1 companies, $2 properties, $3 first day, $4 first day after, $5
 * households, $6 the day to judge on (null: each property's today).
 */
function rowsCteSql(): string {
  const today = `COALESCE($6::date, ${propertyDaySql('NOW()', 'pr')})`
  return `
  base AS (
    SELECT p.id, p.landlord_id, p.type, p.status, p.amount, p.invoice_id, p.lease_id, p.notes, p.entry_description,
           p.manual_method, p.payment_channel, p.stripe_payment_intent_id, p.work_trade_suspended_at, p.due_date AS own_due,
           p.reversal_id, p.lease_fee_id, p.is_remainder, p.created_at,
           u.property_id, pr.name AS property_name, u.unit_number,
           COALESCE(inv.due_date, p.due_date) AS bill_due,
           ${householdOfRowSql('p', 'inv')} AS household_id,
           ${graceDaysSql('l', 'pr')}::int AS grace,
           CASE WHEN l.late_fee_grace_days IS NOT NULL THEN 'lease'
                WHEN pr.late_fee_grace_days IS NOT NULL THEN 'property' ELSE 'default' END AS grace_source,
           ${propertyDaySql(writtenAtSql('p'), 'pr')} AS written_day,
           ${today} AS today,
           ${openBalanceSql('p')} AS is_open,
           ${inFlightRowSql('p')} AS in_flight,
           ${workTradeOpenRowSql('p')} AS wt_open,
           (${payableRowSql('p')} AND NOT ${openBalanceSql('p')}) AS not_owed_any_more,
           CASE WHEN p.amount = 0 AND p.status = 'settled' THEN ${WT_NOTE_VALUE} ELSE 0 END AS wt_note_value,
           COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status = 'applied'), 0) AS credit_applied,
           COALESCE((SELECT SUM(cu.amount) FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('held','applied')), 0) AS credit_set,
           (SELECT MAX(cu.applied_at) FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status = 'applied') AS credit_at,
           (SELECT MAX(CASE WHEN tr.stripe_payment_intent_id IS NOT NULL THEN tr.created_at
                            ELSE COALESCE(tr.settled_at, tr.created_at) END)
              FROM remittance_applications ra JOIN tenant_remittances tr ON tr.id = ra.remittance_id
             WHERE ra.payment_id = p.id AND tr.status <> 'failed') AS receipt_at,
           (SELECT tr.payment_method
              FROM remittance_applications ra JOIN tenant_remittances tr ON tr.id = ra.remittance_id
             WHERE ra.payment_id = p.id AND tr.status <> 'failed'
             ORDER BY tr.created_at DESC, tr.id LIMIT 1) AS receipt_method,
           (SELECT MIN(bda.effective_paid_date) FROM bank_deposit_allocations bda
             WHERE bda.payment_id = p.id AND bda.reversed_at IS NULL) AS bank_day,
           ${propertyDaySql('p.settled_at', 'pr')} AS settled_day,
           pr.timezone,
           -- The onboarding month: the lease's first rent month on GAM. 10/12
           -- (Nic): never a voided rent line (a bill thrown away is not the
           -- first bill), and never history imported from another platform —
           -- "health starts with the first bill GAM wrote" — so imported rent
           -- from before GAM can never move the onboarding month back.
           (COALESCE(l.is_existing_tenancy, FALSE)
            AND date_trunc('month', COALESCE(inv.due_date, p.due_date)) = (
                  SELECT date_trunc('month', MIN(p2.due_date)) FROM payments p2
                   WHERE p2.lease_id = l.id AND p2.type = 'rent'
                     AND p2.status <> 'voided'
                     AND p2.import_source IS NULL)) AS onboarding
      FROM payments p
      LEFT JOIN invoices inv  ON inv.id = p.invoice_id
      LEFT JOIN units u       ON u.id  = p.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN leases l      ON l.id  = COALESCE(p.lease_id, inv.lease_id)
     WHERE p.landlord_id = ANY($1::uuid[])
       AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
       AND COALESCE(p.revenue_owner, 'landlord') NOT IN ('gam', 'held')
       AND p.entry_description IS DISTINCT FROM 'FLEXPAY'
       AND p.type NOT IN ('platform_fee', 'float_fee')
       AND p.status NOT IN ('voided', 'returned')
       AND (inv.id IS NULL OR inv.status <> 'void')
       -- 10/12 (Nic): "CSV-imported old payment history does NOT count toward
       -- payment health — health starts with the first bill GAM wrote." A row
       -- brought in from another platform (import_source) is never a GAM bill:
       -- the tenant report lists it as imported history (importedHistory),
       -- never as a month here, on the Rent Roll or on any health figure.
       AND p.import_source IS NULL
       AND COALESCE(inv.due_date, p.due_date) >= $3::date
       AND COALESCE(inv.due_date, p.due_date) <  $4::date
  ),
  rows AS (
    SELECT b.*,
           (b.type = ANY('{${BASE_CHARGE_TYPES.join(',')}}'::text[])) AS is_base,
           (b.type = 'late_fee') AS is_late_fee,
           (b.amount + b.wt_note_value) AS charged,
           (CASE WHEN b.wt_open THEN b.amount ELSE 0 END + b.wt_note_value) AS wt,
           CASE WHEN b.in_flight THEN b.credit_set ELSE b.credit_applied END AS credit,
           GREATEST(0, CASE WHEN b.status IN ('settled','paid_via_deposit') AND b.wt_note_value = 0 THEN b.amount - b.credit_applied
                            WHEN b.in_flight THEN b.amount - b.credit_set ELSE 0 END) AS paid,
           GREATEST(0, CASE WHEN b.in_flight THEN b.amount - b.credit_set ELSE 0 END) AS clearing,
           CASE WHEN b.is_open THEN GREATEST(0, b.amount - b.credit_applied) ELSE 0 END AS owed,
           -- The day it was paid in full (property calendar): a line work trade
           -- covered, its due date; a bank deposit matched to it, the bank's day;
           -- else the later of the receipt's postmark and the day credit paid it
           -- (never before the bill's due date: creditPaidOnDay); else the day
           -- it settled. NULL while it is still owed.
           CASE WHEN b.wt_open OR b.wt_note_value > 0 OR COALESCE(b.notes, '') ILIKE '%covered by work%trade%' THEN b.bill_due
                WHEN b.status IN ('settled','paid_via_deposit') OR b.in_flight THEN
                  COALESCE(b.bank_day,
                           GREATEST(${propertyDaySql('b.receipt_at', 'b')},
                                    CASE WHEN b.credit_at IS NOT NULL THEN GREATEST(${propertyDaySql('b.credit_at', 'b')}, b.bill_due) END),
                           b.settled_day, b.today)
           END AS paid_day
      FROM base b
     WHERE NOT b.not_owed_any_more
       AND (b.amount > 0 OR b.wt_note_value > 0)
       AND ($5::uuid[] IS NULL OR b.household_id = ANY($5::uuid[]))
  ),
  timed AS (
    SELECT r.*,
           ${lateCountsFromSql('r.bill_due', 'r.written_day', 'COALESCE(r.paid_day, r.today)')} AS late_start
      FROM rows r
  ),
  judged AS (
    SELECT t.*,
           ${firstLateDaySql('t.late_start', 't.grace')} AS first_late_day,
           CASE WHEN t.wt > 0 AND t.owed = 0 THEN 0
                WHEN t.owed > 0 THEN ${daysPastGraceSql('t.today', 't.late_start', 't.grace')}
                WHEN t.paid_day IS NOT NULL THEN ${daysPastGraceSql('t.paid_day', 't.late_start', 't.grace')}
                ELSE 0 END AS days_past_grace,
           ${pastGraceSql('t.today', 't.late_start', 't.grace')} AS past_grace_now
      FROM timed t
  )`
}

/**
 * The work trade a month-close settled (jobs/workTradeSettlement adds the
 * hours' value to the invoice's work_trade_credit_amount and settles the
 * covered lines at $0, or reduces a line it covers in part). Per household
 * and bill month, so a closed work-trade month still reads as covered.
 */
function closedWorkTradeCteSql(): string {
  return `
  wt_closed AS (
    SELECT inv.id AS invoice_id, inv.landlord_id,
           (SELECT hh_lt.tenant_id FROM lease_tenants hh_lt
             WHERE hh_lt.lease_id = inv.lease_id AND hh_lt.role = 'primary' AND hh_lt.status <> 'void'
             ORDER BY (hh_lt.status = 'active') DESC, hh_lt.created_at, hh_lt.id LIMIT 1) AS lease_primary,
           inv.tenant_id, u.property_id, pr.name AS property_name, u.unit_number,
           inv.due_date AS bill_due, inv.work_trade_credit_amount AS amount
      FROM invoices inv
      LEFT JOIN units u       ON u.id  = inv.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
     WHERE inv.work_trade_credit_amount > 0
       AND inv.status <> 'void'
       AND inv.landlord_id = ANY($1::uuid[])
       AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
       AND inv.due_date >= $3::date AND inv.due_date < $4::date
  ),
  wt_closed_hh AS (
    SELECT w.invoice_id, w.landlord_id, COALESCE(w.lease_primary, w.tenant_id) AS household_id, w.property_id, w.property_name,
           w.unit_number, w.bill_due, w.amount
      FROM wt_closed w
     WHERE ($5::uuid[] IS NULL OR COALESCE(w.lease_primary, w.tenant_id) = ANY($5::uuid[]))
  )`
}

// ─── The months ──────────────────────────────────────────────────────────────

/** One household's bill month, with its stamp. Money in dollars. */
export interface HouseholdMonth {
  landlord_id: string
  household_id: string
  /** Set when grouped by property (the Rent Roll's folders). */
  property_id: string | null
  property_name: string | null
  /** YYYY-MM: the bills' month. */
  month: string
  units: string[]
  /** Everything billed on the month's bills (base charges, late fees, deposits; work trade's value included). */
  charged: number
  /** Of `charged`, the late fees. */
  charged_late_fees: number
  /** Of `charged`, the base charges (rent, utilities, fees, home payment) — what the stamp is judged on. */
  charged_base: number
  /** Money that paid it (still clearing included). */
  paid: number
  /** Of `paid`, money still clearing. */
  clearing: number
  /** Account credit applied to it. */
  credit: number
  /** Covered by work trade (hours, not money). */
  work_trade: number
  /** Still owed now (late fees included). */
  owed: number
  /** Of `owed`, base charges. */
  owed_base: number
  /** Of `owed`, late fees. */
  owed_late_fees: number
  /** The first day money or credit came in on a base charge (YYYY-MM-DD), null when none has. */
  first_paid_on: string | null
  /** The day the base charges were paid in full, null while anything is owed. */
  paid_in_full_on: string | null
  /** The earliest first late day of its base charges. */
  first_late_day: string | null
  /** Days past the grace period: paid late → when paid; still owed → today; else 0. */
  days_past_grace: number
  /** null: nothing to judge (only late fees or a deposit on it). */
  stamp: PaymentStamp | null
  stamp_label: string | null
  /** Counts toward payment health. */
  counted: boolean
  on_time: boolean
  /** The household's first rent month after moving onto GAM (good news only). */
  onboarding: boolean
  /** A late fee was charged on the month's bills. */
  late_fee_on_bill: boolean
  /** Work trade covers every base charge of the month. */
  work_trade_only: boolean
  grace_days: number
}

export interface MonthAgg {
  landlord_id: string; household_id: string; property_id: string | null; property_name: string | null; month: string
  units: string[] | null
  charged: string; charged_late: string; charged_base: string
  paid: string; clearing: string; credit: string; wt: string; wt_base: string
  owed: string; owed_base: string; owed_late: string
  base_in: string
  base_rows: number
  open_past_grace: boolean
  dpg_open: number | null; dpg_paid: number | null
  first_paid_on: string | null; last_paid_on: string | null
  first_late_day: string | null
  onboarding: boolean; late_fee_on_bill: boolean
  grace: number | null
}

/**
 * Judge one month from its sums (the stamp rule in code, so it is tested on
 * its own). Exported for the tests and the report.
 */
export function judgeMonth(a: {
  chargedBaseC: number; workTradeBaseC: number; owedBaseC: number; baseInC: number
  openPastGrace: boolean; daysPastGraceOpen: number; daysPastGracePaid: number
  onboarding: boolean; lateFeeOnBill: boolean
}): { stamp: PaymentStamp | null; days: number; counted: boolean; onTime: boolean; workTradeOnly: boolean } {
  if (a.chargedBaseC <= 0) return { stamp: null, days: 0, counted: false, onTime: false, workTradeOnly: false }
  const workTradeOnly = a.workTradeBaseC >= a.chargedBaseC
  let stamp: PaymentStamp
  let days = 0
  if (a.owedBaseC <= 0) {
    days = workTradeOnly ? 0 : Math.max(0, a.daysPastGracePaid)
    stamp = days > 0 ? 'paid_late' : 'paid_on_time'
  } else if (a.baseInC > 0) {
    stamp = 'partial'
    days = Math.max(0, a.daysPastGraceOpen)
  } else if (a.openPastGrace) {
    stamp = 'outstanding'
    days = Math.max(0, a.daysPastGraceOpen)
  } else {
    stamp = 'due'
  }
  const onTime = stamp === 'paid_on_time'
  let counted = stamp !== 'due' && !(stamp === 'partial' && !a.openPastGrace)
  // Onboarding: good news only, unless a late fee was charged on the bill.
  if (counted && a.onboarding && !onTime && !a.lateFeeOnBill) counted = false
  return { stamp, days, counted, onTime: counted && onTime, workTradeOnly }
}

/**
 * The household months in scope: one set-based query, every household × bill
 * month that has a charge (or work trade) on it, oldest month first.
 */
export async function householdMonths(scope: HouseholdMonthScope): Promise<HouseholdMonth[]> {
  return (await monthAggs(scope)).map(judgeAgg)
}

/**
 * Both groupings from ONE read: the months per household per property (the
 * Rent Roll's folders, the monthly report's properties) and the same months per
 * household across those properties (a household's health and the report's
 * totals). 10/12 review: the Rent Roll read every charge row of the account's
 * whole history twice (once per grouping); each row runs a dozen correlated
 * lookups, so all time made that cost grow with every month on GAM. The
 * household months are the property months added up (foldAggs) and judged the
 * same way — exactly what the second read returned.
 */
export async function householdMonthsBoth(scope: Omit<HouseholdMonthScope, 'byProperty'>): Promise<{
  byProperty: HouseholdMonth[]; byHousehold: HouseholdMonth[]
  /**
   * 10/12 (Nic) review: the property months with the account's companies
   * added together — one month per household per property, whichever of the
   * viewer's companies billed it. The Rent Roll keys its rows by property and
   * household, so two companies' months for the same household and month (a
   * charge on no space at two companies, a property moved between the
   * account's own companies within a month) must add up, not overwrite.
   */
  byPropertyAcrossCompanies: HouseholdMonth[]
}> {
  const aggs = await monthAggs({ ...scope, byProperty: true })
  return {
    byProperty: aggs.map(judgeAgg),
    byHousehold: foldAggs(aggs).map(judgeAgg),
    byPropertyAcrossCompanies: foldAggsBy(aggs, r => `${r.property_id ?? ''}|${r.household_id}|${r.month}`, true).map(judgeAgg),
  }
}

/**
 * Property months → household months: the sums add, the yes/no columns OR, the
 * earliest / latest days and the most days past grace fold to the earliest /
 * latest / most — the same aggregates the query takes over the same rows.
 */
export function foldAggs(aggs: readonly MonthAgg[]): MonthAgg[] {
  return foldAggsBy(aggs, r => `${r.landlord_id}|${r.household_id}|${r.month}`, false)
}

/**
 * The same fold under any grouping: rows with the same key add up. With
 * `keepProperty` the rows keep their property (the key must hold it); without,
 * the property is dropped (a household month across properties).
 */
function foldAggsBy(aggs: readonly MonthAgg[], keyOf: (r: MonthAgg) => string, keepProperty: boolean): MonthAgg[] {
  const add = (x: string, y: string) => String(Number(x) + Number(y))
  const pick = <T>(x: T | null, y: T | null, f: (a: T, b: T) => T): T | null => (x === null ? y : y === null ? x : f(x, y))
  const min = (a: string, b: string) => (a <= b ? a : b)
  const max = (a: string, b: string) => (a >= b ? a : b)
  const out = new Map<string, MonthAgg>()
  for (const r of aggs) {
    const k = keyOf(r)
    const o = out.get(k)
    if (!o) {
      out.set(k, keepProperty ? { ...r, units: [...(r.units ?? [])] } : { ...r, property_id: null, property_name: null, units: [...(r.units ?? [])] })
      continue
    }
    o.units = [...new Set([...(o.units ?? []), ...(r.units ?? [])])]
    for (const f of ['charged', 'charged_late', 'charged_base', 'paid', 'clearing', 'credit', 'wt', 'wt_base',
      'owed', 'owed_base', 'owed_late', 'base_in'] as const) o[f] = add(o[f], r[f])
    o.base_rows += r.base_rows
    o.open_past_grace = o.open_past_grace || r.open_past_grace
    o.dpg_open = pick(o.dpg_open, r.dpg_open, Math.max)
    o.dpg_paid = pick(o.dpg_paid, r.dpg_paid, Math.max)
    o.first_paid_on = pick(o.first_paid_on, r.first_paid_on, min)
    o.last_paid_on = pick(o.last_paid_on, r.last_paid_on, max)
    o.first_late_day = pick(o.first_late_day, r.first_late_day, min)
    o.onboarding = o.onboarding || r.onboarding
    o.late_fee_on_bill = o.late_fee_on_bill || r.late_fee_on_bill
    o.grace = pick(o.grace, r.grace, Math.max)
  }
  return [...out.values()].sort((a, z) => a.month.localeCompare(z.month) || a.household_id.localeCompare(z.household_id))
}

/** The months' sums from the database, grouped per household (and per property when asked). */
async function monthAggs(scope: HouseholdMonthScope): Promise<MonthAgg[]> {
  if (!scope.landlordIds.length) return []
  if (!isBillMonth(scope.from) || !isBillMonth(scope.through)) throw new Error('householdMonths: months are YYYY-MM')
  const byProperty = scope.byProperty === true
  const propCols = byProperty ? 'x.property_id, x.property_name' : 'NULL::uuid AS property_id, NULL::text AS property_name'
  const groupProp = byProperty ? ', x.property_id, x.property_name' : ''
  const rows = await query<MonthAgg>(`
    WITH ${rowsCteSql()},
    ${closedWorkTradeCteSql()},
    parts AS (
      SELECT j.landlord_id, j.household_id, j.property_id, j.property_name, j.unit_number, j.bill_due,
             j.is_base, j.is_late_fee, j.charged, j.paid, j.clearing, j.credit, j.wt, j.owed,
             j.days_past_grace, j.past_grace_now, j.paid_day, j.first_late_day, j.onboarding, j.grace
        FROM judged j
      UNION ALL
      SELECT w.landlord_id, w.household_id, w.property_id, w.property_name, w.unit_number, w.bill_due,
             TRUE, FALSE, w.amount, 0, 0, 0, w.amount, 0,
             0, FALSE, w.bill_due, NULL::date, FALSE, NULL::int
        FROM wt_closed_hh w
    )
    SELECT x.landlord_id, x.household_id::text AS household_id, ${propCols},
           to_char(x.bill_due, 'YYYY-MM') AS month,
           array_remove(array_agg(DISTINCT x.unit_number), NULL) AS units,
           SUM(x.charged)::text                                        AS charged,
           COALESCE(SUM(x.charged) FILTER (WHERE x.is_late_fee), 0)::text AS charged_late,
           COALESCE(SUM(x.charged) FILTER (WHERE x.is_base), 0)::text  AS charged_base,
           SUM(x.paid)::text AS paid, SUM(x.clearing)::text AS clearing, SUM(x.credit)::text AS credit,
           SUM(x.wt)::text AS wt,
           COALESCE(SUM(x.wt) FILTER (WHERE x.is_base), 0)::text       AS wt_base,
           SUM(x.owed)::text                                           AS owed,
           COALESCE(SUM(x.owed) FILTER (WHERE x.is_base), 0)::text     AS owed_base,
           COALESCE(SUM(x.owed) FILTER (WHERE x.is_late_fee), 0)::text AS owed_late,
           COALESCE(SUM(x.paid + x.credit) FILTER (WHERE x.is_base), 0)::text AS base_in,
           COUNT(*) FILTER (WHERE x.is_base)::int                      AS base_rows,
           COALESCE(bool_or(x.is_base AND x.owed > 0 AND x.past_grace_now), FALSE) AS open_past_grace,
           MAX(x.days_past_grace) FILTER (WHERE x.is_base AND x.owed > 0)::int     AS dpg_open,
           MAX(x.days_past_grace) FILTER (WHERE x.is_base AND x.owed = 0)::int     AS dpg_paid,
           to_char(MIN(x.paid_day) FILTER (WHERE x.is_base AND x.paid + x.credit > 0), 'YYYY-MM-DD') AS first_paid_on,
           to_char(MAX(x.paid_day) FILTER (WHERE x.is_base AND x.owed = 0), 'YYYY-MM-DD') AS last_paid_on,
           to_char(MIN(x.first_late_day) FILTER (WHERE x.is_base), 'YYYY-MM-DD') AS first_late_day,
           COALESCE(bool_or(x.onboarding) FILTER (WHERE x.is_base), FALSE)        AS onboarding,
           COALESCE(bool_or(x.is_late_fee AND x.charged > 0), FALSE)              AS late_fee_on_bill,
           MAX(x.grace) FILTER (WHERE x.is_base)::int                             AS grace
      FROM parts x
     WHERE x.household_id IS NOT NULL
     GROUP BY x.landlord_id, x.household_id${groupProp}, to_char(x.bill_due, 'YYYY-MM')
     ORDER BY to_char(x.bill_due, 'YYYY-MM'), x.household_id`,
    [scope.landlordIds, scope.propertyIds ?? null, `${scope.from}-01`, `${addMonths(scope.through, 1)}-01`,
     scope.householdIds ?? null, scope.asOf ?? null])
  // pg returns numeric aggregates as text and ints as numbers; the folds above rely on it.
  return rows.map(r => ({ ...r, base_rows: Number(r.base_rows ?? 0) }))
}

/** One month's sums → its stamp and money (judgeMonth). */
function judgeAgg(r: MonthAgg): HouseholdMonth {
  const j = judgeMonth({
    chargedBaseC: cents(r.charged_base), workTradeBaseC: cents(r.wt_base), owedBaseC: cents(r.owed_base),
    baseInC: cents(r.base_in), openPastGrace: r.open_past_grace === true,
    daysPastGraceOpen: Number(r.dpg_open ?? 0), daysPastGracePaid: Number(r.dpg_paid ?? 0),
    onboarding: r.onboarding === true, lateFeeOnBill: r.late_fee_on_bill === true,
  })
  const paidInFull = cents(r.charged_base) > 0 && cents(r.owed_base) <= 0
  return {
    landlord_id: r.landlord_id,
    household_id: r.household_id,
    property_id: r.property_id,
    property_name: r.property_name,
    month: r.month,
    units: [...(r.units ?? [])].sort(),
    charged: dollars(cents(r.charged)),
    charged_late_fees: dollars(cents(r.charged_late)),
    charged_base: dollars(cents(r.charged_base)),
    paid: dollars(cents(r.paid)),
    clearing: dollars(cents(r.clearing)),
    credit: dollars(cents(r.credit)),
    work_trade: dollars(cents(r.wt)),
    owed: dollars(cents(r.owed)),
    owed_base: dollars(cents(r.owed_base)),
    owed_late_fees: dollars(cents(r.owed_late)),
    first_paid_on: r.first_paid_on,
    paid_in_full_on: paidInFull ? (j.workTradeOnly ? null : r.last_paid_on) : null,
    first_late_day: r.first_late_day,
    days_past_grace: j.days,
    stamp: j.stamp,
    stamp_label: j.stamp ? PAYMENT_STAMP_LABEL[j.stamp] : null,
    counted: j.counted,
    on_time: j.onTime,
    onboarding: r.onboarding === true,
    late_fee_on_bill: r.late_fee_on_bill === true,
    work_trade_only: j.workTradeOnly,
    grace_days: Number(r.grace ?? 5),
  }
}

// ─── Health ──────────────────────────────────────────────────────────────────

export interface PaymentHealth {
  /** On-time months ÷ counted months, as a whole percent; null when nothing is counted yet. */
  percent: number | null
  on_time: number
  counted: number
  paid_late: number
  partial: number
  outstanding: number
  /** Months not counted (still due, a partial inside grace, an onboarding month that was not on time). */
  not_counted: number
  /** Months work trade covered in full (counted as paid on time). */
  work_trade: number
  /** YYYY-MM through YYYY-MM: the household's first billed month on GAM (all time, 10/12) through the month judged to; `from` is `through` before anything is billed. */
  from: string
  through: string
  /** "50%, 1 of 2 months". */
  label: string
}

/**
 * A trailing window of `months` bill months ending at `through`. Payment
 * health no longer reads one (10/12, Nic: all time); the portfolio's late rate
 * (agents/tools getPortfolioStats, "over the last 12 months") still does.
 */
export function healthWindow(through: string, months = 12): { from: string; through: string } {
  return { from: addMonths(through, -(months - 1)), through }
}

/**
 * Payment health from one household's months (any order): every month billed
 * through `through` — all time, since the household's first bill on GAM
 * (10/12, Nic: "ALL-TIME, not 12 months").
 */
export function paymentHealth(months: readonly HouseholdMonth[], through: string): PaymentHealth {
  const billed = months.filter(m => m.month <= through && m.stamp !== null)
  const counted = billed.filter(m => m.counted)
  const onTime = counted.filter(m => m.on_time).length
  const percent = counted.length ? Math.round((onTime / counted.length) * 100) : null
  const first = billed.reduce<string | null>((f, m) => (f === null || m.month < f ? m.month : f), null)
  return {
    percent,
    on_time: onTime,
    counted: counted.length,
    paid_late: counted.filter(m => m.stamp === 'paid_late').length,
    partial: counted.filter(m => m.stamp === 'partial').length,
    outstanding: counted.filter(m => m.stamp === 'outstanding').length,
    not_counted: billed.length - counted.length,
    work_trade: counted.filter(m => m.work_trade_only).length,
    from: first ?? through,
    through,
    label: percent === null ? 'No months to judge yet'
      : `${percent}%, ${onTime} of ${counted.length} month${counted.length === 1 ? '' : 's'}`,
  }
}

/** The month a day falls in (YYYY-MM), on GAM's home calendar — the default "through" month. */
export function currentBillMonth(now: Date = new Date()): string {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE, year: 'numeric', month: '2-digit' }).format(now)
  return d.slice(0, 7)
}

/**
 * Payment health for these households, all time (one query) — every month
 * since each household's first bill on GAM. household id → health. A
 * household with nothing billed is absent.
 */
export async function healthByHousehold(opts: {
  landlordIds: string[]; propertyIds?: string[] | null; householdIds: string[]; through?: string; asOf?: string | null
}): Promise<Map<string, PaymentHealth>> {
  const out = new Map<string, PaymentHealth>()
  if (!opts.householdIds.length || !opts.landlordIds.length) return out
  const through = opts.through ?? currentBillMonth()
  const months = await householdMonths({
    landlordIds: opts.landlordIds, propertyIds: opts.propertyIds ?? null, householdIds: opts.householdIds,
    from: ALL_TIME_FROM, through, asOf: opts.asOf ?? null,
  })
  const by = new Map<string, HouseholdMonth[]>()
  for (const m of months) by.set(m.household_id, [...(by.get(m.household_id) ?? []), m])
  for (const [hh, ms] of by) out.set(hh, paymentHealth(ms, through))
  return out
}

/**
 * The household each of these people belongs to with these companies: the
 * primary resident of a lease they are on (the newest active one first), or
 * themselves. person id → household id.
 *
 * 10/12: with `propertyIds` (a viewer kept to some properties), only a lease
 * at those properties counts — a staff member limited to Park A never gets the
 * household of the person's lease at Park B.
 */
export async function householdsOf(
  tenantIds: readonly string[], landlordIds: readonly string[], propertyIds: readonly string[] | null = null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!tenantIds.length) return out
  const rows = await query<{ tenant_id: string; household_id: string }>(`
    SELECT t.id AS tenant_id,
           COALESCE((SELECT p.tenant_id FROM lease_tenants me
                       JOIN leases l ON l.id = me.lease_id
                       JOIN lease_tenants p ON p.lease_id = me.lease_id AND p.role = 'primary' AND p.status <> 'void'
                      WHERE me.tenant_id = t.id AND me.status <> 'void'
                        AND l.landlord_id = ANY($2::uuid[])
                        AND ($3::uuid[] IS NULL
                             OR EXISTS (SELECT 1 FROM units hu WHERE hu.id = l.unit_id AND hu.property_id = ANY($3::uuid[])))
                      ORDER BY (l.status = 'active') DESC, (me.status = 'active') DESC, l.start_date DESC, l.id LIMIT 1),
                    t.id) AS household_id
      FROM tenants t WHERE t.id = ANY($1::uuid[])`,
    [[...new Set(tenantIds)], [...landlordIds], propertyIds ? [...propertyIds] : null])
  for (const r of rows) out.set(r.tenant_id, r.household_id)
  return out
}

/** Everyone in a household: the primary resident and every resident who has been on one of their leases. */
export async function householdMembers(householdId: string, landlordIds: readonly string[]): Promise<string[]> {
  const rows = await query<{ tenant_id: string }>(`
    SELECT DISTINCT lt.tenant_id FROM lease_tenants lt
      JOIN leases l ON l.id = lt.lease_id
     WHERE l.landlord_id = ANY($2::uuid[]) AND lt.status <> 'void'
       AND lt.lease_id IN (SELECT p.lease_id FROM lease_tenants p WHERE p.tenant_id = $1 AND p.role = 'primary' AND p.status <> 'void')
    UNION SELECT $1::uuid`, [householdId, [...landlordIds]])
  return rows.map(r => r.tenant_id)
}

// ─── The lines (the tenant report, the Rent Roll's expanded row) ────────────

/** How a line was paid, in the words the screens use. */
export const HOW_PAID_OTHER = ['work_trade', 'credit', 'online'] as const
export type HowPaidOther = typeof HOW_PAID_OTHER[number]
export const HOW_PAID_OTHER_LABEL: Record<HowPaidOther, string> = {
  work_trade: WORK_TRADE_MARKER_LABEL,
  credit: 'Account credit',
  online: 'Online payment',
}

export interface ChargeLine {
  payment_id: string
  household_id: string
  /** YYYY-MM: the bill month it belongs to. */
  month: string
  /** YYYY-MM-DD: its bill's due date. */
  due_date: string
  /** "What it's for": Rent, Electric, Late fee, Home payment, … (never a raw type). */
  label: string
  detail: string | null
  type: string
  unit_number: string | null
  property_id: string | null
  property_name: string | null
  charged: number
  paid: number
  credit: number
  work_trade: number
  owed: number
  /** YYYY-MM-DD: the day it was paid in full; null while owed. */
  paid_on: string | null
  how_paid: string | null
  days_past_grace: number
  /** The invoice it is on (late fees collapse per bill). */
  invoice_id: string | null
  is_late_fee: boolean
}

interface LineRow {
  id: string; household_id: string; bill_due: string; type: string; status: string; amount: string
  notes: string | null; entry_description: string | null; utility_type: string | null; fee_type: string | null
  fee_description: string | null; origin_notes: string | null
  unit_number: string | null; property_id: string | null; property_name: string | null
  charged: string; paid: string; credit: string; wt: string; owed: string
  paid_day: string | null; days_past_grace: number; invoice_id: string | null
  manual_method: string | null; receipt_method: string | null; payment_channel: string | null
  stripe_payment_intent_id: string | null
}

/** Every charge line of these households in the months, newest first. */
export async function householdLines(scope: HouseholdMonthScope): Promise<ChargeLine[]> {
  if (!scope.landlordIds.length) return []
  const rows = await query<LineRow>(`
    WITH ${rowsCteSql()}
    SELECT j.id, j.household_id::text AS household_id, to_char(j.bill_due, 'YYYY-MM-DD') AS bill_due,
           j.type, j.status, j.amount::text AS amount, j.notes, j.entry_description,
           ${chargeLabelColumnsSql('j')},
           j.unit_number, j.property_id, j.property_name,
           j.charged::text AS charged, j.paid::text AS paid, j.credit::text AS credit, j.wt::text AS wt, j.owed::text AS owed,
           to_char(CASE WHEN j.owed = 0 THEN j.paid_day END, 'YYYY-MM-DD') AS paid_day,
           j.days_past_grace::int AS days_past_grace, j.invoice_id,
           j.manual_method, j.receipt_method, j.payment_channel, j.stripe_payment_intent_id
      FROM judged j
     ORDER BY j.bill_due DESC, j.type, j.created_at DESC, j.id`,
    [scope.landlordIds, scope.propertyIds ?? null, `${scope.from}-01`, `${addMonths(scope.through, 1)}-01`,
     scope.householdIds ?? null, scope.asOf ?? null])
  const out: ChargeLine[] = rows.map(r => {
    const wt = cents(r.wt), paidC = cents(r.paid), creditC = cents(r.credit)
    const how = wt > 0 ? HOW_PAID_OTHER_LABEL.work_trade
      : paidC === 0 && creditC > 0 ? HOW_PAID_OTHER_LABEL.credit
      : paidC > 0 ? (paidByLabel(r.manual_method ?? r.receipt_method, r.payment_channel)
                     ?? (r.stripe_payment_intent_id ? HOW_PAID_OTHER_LABEL.online : 'Recorded payment'))
      : null
    const labelRow = r as unknown as Parameters<typeof chargeLabel>[0]
    return {
      payment_id: r.id,
      household_id: r.household_id,
      month: r.bill_due.slice(0, 7),
      due_date: r.bill_due,
      label: chargeLabel(labelRow),
      detail: chargeDetail(labelRow),
      type: r.type,
      unit_number: r.unit_number,
      property_id: r.property_id,
      property_name: r.property_name,
      charged: dollars(cents(r.charged)),
      paid: dollars(paidC),
      credit: dollars(creditC),
      work_trade: dollars(wt),
      owed: dollars(cents(r.owed)),
      paid_on: r.paid_day,
      how_paid: how,
      days_past_grace: Number(r.days_past_grace) || 0,
      invoice_id: r.invoice_id,
      is_late_fee: r.type === 'late_fee',
    }
  })
  // 10/12: what a month close settled (jobs/workTradeSettlement creditInvoice)
  // is a line too. The close settles each line it covers in full at $0 ("Covered
  // by work-trade credit") and lowers one it covers in part; the value lives
  // only on the invoice (work_trade_credit_amount), which the months count
  // (wt_closed) — so the lines left it out: the Rent Roll's expanded row said
  // "Nothing billed for this month" under a $460 green month, and the tenant
  // report's history did not add up to its months (INV-2026-00019). One line
  // per bill, named for the charges the trade covered on it.
  const closed = await query<{
    invoice_id: string; household_id: string; bill_due: string; unit_number: string | null
    property_id: string | null; property_name: string | null; amount: string
    covered: Array<Record<string, string | null>> | null
  }>(`
    WITH ${closedWorkTradeCteSql()}
    SELECT w.invoice_id, w.household_id::text AS household_id, to_char(w.bill_due, 'YYYY-MM-DD') AS bill_due,
           w.unit_number, w.property_id, w.property_name, w.amount::text AS amount,
           (SELECT json_agg(json_build_object(
                     'type', cp.type, 'entry_description', cp.entry_description, 'notes', cp.notes,
                     'utility_type', lc.utility_type, 'fee_type', lc.fee_type, 'fee_description', lc.fee_description,
                     'origin_notes', lc.origin_notes) ORDER BY (cp.type = 'rent') DESC, cp.created_at, cp.id)
              FROM payments cp
              CROSS JOIN LATERAL (SELECT ${chargeLabelColumnsSql('cp')}) lc
             WHERE cp.invoice_id = w.invoice_id AND cp.status <> 'voided'
               AND cp.type = ANY('{${BASE_CHARGE_TYPES.join(',')}}'::text[])
               AND (cp.notes LIKE '%Covered by work-trade credit%'
                    OR ${WORK_TRADE_HELD_NOTE_PARTS.map(n => `cp.notes LIKE '%${n.replace(/'/g, "''")}%'`).join(' OR ')})) AS covered
      FROM wt_closed_hh w
     WHERE w.household_id IS NOT NULL`,
    [scope.landlordIds, scope.propertyIds ?? null, `${scope.from}-01`, `${addMonths(scope.through, 1)}-01`,
     scope.householdIds ?? null])
  const closedLines: ChargeLine[] = closed.map(w => {
    const covered = w.covered ?? []
    const labels = [...new Set(covered.map(c => chargeLabel(c as unknown as Parameters<typeof chargeLabel>[0])))]
    const amount = dollars(cents(w.amount))
    return {
      payment_id: `work-trade:${w.invoice_id}`,
      household_id: w.household_id,
      month: w.bill_due.slice(0, 7),
      due_date: w.bill_due,
      label: labels.length ? labels.join(' and ') : 'Charges the work trade covered',
      detail: 'Covered by work trade at month close',
      type: String(covered[0]?.type ?? 'rent'),
      unit_number: w.unit_number,
      property_id: w.property_id,
      property_name: w.property_name,
      charged: amount,
      paid: 0,
      credit: 0,
      work_trade: amount,
      owed: 0,
      paid_on: w.bill_due,
      how_paid: HOW_PAID_OTHER_LABEL.work_trade,
      days_past_grace: 0,
      invoice_id: w.invoice_id,
      is_late_fee: false,
    }
  })
  if (!closedLines.length) return out
  // Newest bill first, as the query orders the rest (a stable sort keeps their order).
  return [...out, ...closedLines].sort((a, z) => z.due_date.localeCompare(a.due_date))
}

// ─── Imported history (10/12, Nic) ───────────────────────────────────────────

/**
 * A payment brought in from another platform's history by the payment-history
 * CSV import (payments.import_source). 10/12 (Nic): "CSV-imported old payment
 * history does NOT count toward payment health — health starts with the first
 * bill GAM wrote; imported history still shows in the report." So it is never
 * a month or a line above (rowsCteSql leaves it out); the tenant report lists
 * it on its own, labeled with where it came from.
 */
export interface ImportedLine {
  payment_id: string
  household_id: string
  /** YYYY-MM-DD: the day the other platform recorded it paid. */
  paid_on: string
  /** "What it's for": Rent, Fee, Late fee, … (never a raw type). */
  label: string
  type: string
  unit_number: string | null
  property_id: string | null
  property_name: string | null
  amount: number
  /** Where it came from, in words: "Buildium", "AppFolio", … or "your previous software" (the GAM template). */
  imported_from: string
  /** How it was paid, as the other platform said it ("Check"); null when the file did not say. */
  method: string | null
  /** The other platform's reference for it; null when the file had none. */
  reference: string | null
}

/** The platform a payment came from, in words (the GAM template names no platform). */
export function importedFromLabel(source: string | null | undefined): string {
  const s = String(source ?? '').toLowerCase()
  if (!s || s === 'generic' || !isCsvImportPlatform(s)) return 'your previous software'
  return getPaymentPlatformConfig(s).label
}

/**
 * The method and reference the import wrote into the note ("Imported from
 * buildium. method: Check | ref: 1042" — routes/landlords
 * onboard-payment-history-csv/commit).
 */
export function importedNoteParts(notes: string | null | undefined): { method: string | null; reference: string | null } {
  const n = String(notes ?? '')
  const method = /method:\s*([^|]+)/i.exec(n)?.[1]?.trim() || null
  const reference = /ref:\s*([^|]+)/i.exec(n)?.[1]?.trim() || null
  return { method, reference }
}

/** These households' imported payment history, newest first. */
export async function importedHistory(scope: {
  landlordIds: string[]; propertyIds?: string[] | null; householdIds: string[]
}): Promise<ImportedLine[]> {
  if (!scope.landlordIds.length || !scope.householdIds.length) return []
  const rows = await query<{
    id: string; household_id: string; paid_on: string; type: string; status: string; entry_description: string | null
    notes: string | null; unit_number: string | null; property_id: string | null; property_name: string | null
    amount: string; import_source: string | null
    utility_type: string | null; fee_type: string | null; fee_description: string | null; origin_notes: string | null
  }>(`
    SELECT x.* FROM (
      SELECT p.id, ${householdOfRowSql('p', 'inv')}::text AS household_id,
             to_char(p.due_date, 'YYYY-MM-DD') AS paid_on, p.type, p.status, p.entry_description, p.notes,
             ${chargeLabelColumnsSql('p')},
             u.unit_number, u.property_id, pr.name AS property_name, p.amount::text AS amount, p.import_source,
             p.created_at
        FROM payments p
        LEFT JOIN invoices inv  ON inv.id = p.invoice_id
        LEFT JOIN units u       ON u.id  = p.unit_id
        LEFT JOIN properties pr ON pr.id = u.property_id
       WHERE p.landlord_id = ANY($1::uuid[])
         AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
         AND p.import_source IS NOT NULL
         AND p.status NOT IN ('voided', 'returned')
    ) x
     WHERE x.household_id = ANY($3::text[])
     ORDER BY x.paid_on DESC, x.created_at DESC, x.id`,
    [scope.landlordIds, scope.propertyIds ?? null, scope.householdIds])
  return rows.map(r => {
    // The note is the import's breadcrumb, never what the charge is for.
    const labelRow = { ...r, notes: null, origin_notes: null } as unknown as Parameters<typeof chargeLabel>[0]
    const { method, reference } = importedNoteParts(r.notes)
    return {
      payment_id: r.id,
      household_id: r.household_id,
      paid_on: r.paid_on,
      label: chargeLabel(labelRow),
      type: r.type,
      unit_number: r.unit_number,
      property_id: r.property_id,
      property_name: r.property_name,
      amount: dollars(cents(r.amount)),
      imported_from: importedFromLabel(r.import_source),
      method,
      reference,
    }
  })
}

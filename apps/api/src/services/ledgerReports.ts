/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P8: EVERY REPORT READS THE LEDGER
 * (gam-ledger-design-2026-10-12 §10, P8; Nic's 10/12 answers L2)
 *
 *   Nic, 10/12: "NO Money received / Money billed toggle anywhere — show
 *   Charged, Received and Owed side by side." (L2) "Received leads."
 *
 * Every money event already posts its own balanced lines (phases P4-P7). This
 * module reads those lines back as the reports a landlord and a bookkeeper
 * see. Three columns come from the same lines, side by side, never a switch:
 *
 *   Received  Σ(credit − debit) on lines marked cash_effect 'in' — money on the
 *             day it arrived; a reversal, clawback or refund is negative on
 *             its own day. Deposits, tax and an owner's own money put in arrive
 *             too but are not income: they are listed beside the total.
 *   Charged   Σ(credit − debit) on income accounts dated in the period —
 *             bills in the month they were due, credits given, the work-trade
 *             discount and returns as minus lines.
 *   Owed      the tenant receivables balance (1100) at the END of the period,
 *             by category and property (design §10). The proof strip under it
 *             shows how it got there: owed at the start + billed − received −
 *             credits given − work trade − paid from paid-ahead money − paid
 *             from deposits ± opening balances and corrections = owed at the
 *             end. Each term is the 1100 movement grouped by what posted it, so
 *             the strip always adds up.
 *
 * Every line is read on its ACCOUNTING date (where it landed: the first open
 * day when its own month was closed), so a closed month never changes and a
 * fix after the close shows in the month it was made.
 *
 * WHICH COMPANIES READ THE LEDGER (ledgerReportsLive). The design's "switch
 * readers only after parity" (§15 steps 6-9), company by company. A company's
 * reports switch to the ledger once:
 *   1. its books have a start date,
 *   2. a full rebuild of its ledger finished (ledger_rebuild_runs, mode apply
 *      or from_scratch, no source type or since-date narrowing it), and
 *   3. AFTER that rebuild, the nightly parity check (services/ledgerParity)
 *      found the ledger and the money records agree — every difference one
 *      the ledger makes on purpose — or an admin accepted the differences it
 *      listed (a parity run marked accepted, with who and why).
 * Once switched it stays switched (the first clean or accepted parity after
 * the first full rebuild decides; a later difference raises an admin notice,
 * it never flips screens back). Until then its reports read the money records
 * exactly as before (services/incomeBasis), so no screen ever mixes the two
 * for one company. A screen covering several companies reads the ledger only
 * when every one of them is live. LEDGER_REPORTS=off (environment) sends every
 * company back to the money records at once — the way back if the ledger is
 * ever wrong in production.
 *
 * READERS SWITCHED HERE, without changing their callers:
 *   - incomeEvents / paidAheadUnusedAt (services/incomeBasis) return events
 *     built from the ledger (ledgerIncomeEvents) — the Reports page, the
 *     dashboard, owner statements, the monthly property report, the report
 *     engine, income pools, rent collected and the agent tools all read those.
 *   - the P&L's expenses (services/landlordPL) come from the expense accounts
 *     (ledgerPLExpenses): Charged-based (incurred, by the day each expense is
 *     dated) and Received-based (paid: an expense through accounts payable on
 *     the day it was paid, a fee taken from money GAM holds on the day it was
 *     taken, payroll on the pay date; never depreciation, a write-off or work
 *     the tenant did for rent).
 *   - the Books statements (routes/booksLedgerReports): P&L, balance sheet,
 *     trial balance per property, general ledger, cash flow, money out, tax.
 *
 * SCOPE. A report reads one or more companies' lines (landlordIds), optionally
 * only some properties (propertyIds — a line on no property, the company's own,
 * is then left out) and a bookkeeper's clean cut at a sale (cutoffs: a former
 * property's lines after its last day are never read; lib/bookkeeperScope).
 *
 * Read-only. Never writes to the ledger.
 */
import {
  INCOME_CATEGORIES, INCOME_CATEGORY_LABEL, LEDGER_ACCOUNT_ROLE_BY_NAME, LEDGER_SOURCE_TYPE_LABEL, ledgerIncomeDetailOf,
  type IncomeCategory, type IncomeBasis, type LedgerAccountRole, type LedgerSourceType,
} from '@gam/shared'
import { query } from '../db'
import { cutoffsParam, withinCutoffsSql, pastCutoff, type PropertyCutoff } from '../lib/bookkeeperScope'
import type {
  IncomeEvent, IncomeQuery, ReportLine, AsideLine, LedgerProofTerm, MoneyView, IncomeDetailPiece,
} from './incomeBasis'
import { SPACE_COLS_SQL, spaceOf, stayParts } from './ledgerProjectors/incomeLines'
import { moneyViewFrom } from './incomeBasis'

const round2 = (n: number) => Math.round(n * 100) / 100
const ymd = (d: string) => String(d).slice(0, 10)
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100)

// ─── Which companies read the ledger ────────────────────────────────────────

/** The environment switch that sends every report back to the money records. */
export const LEDGER_REPORTS_ENV = 'LEDGER_REPORTS'

/** SQL: the first full rebuild of the company aliased `l` finished at (NULL: none yet). */
export const FIRST_FULL_REBUILD_SQL = (l = 'l') => `(SELECT MIN(r.finished_at) FROM ledger_rebuild_runs r
   WHERE r.landlord_id = ${l}.id AND r.mode IN ('apply', 'from_scratch') AND r.status = 'done'
     AND r.scope->>'sourceType' IS NULL AND r.scope->>'since' IS NULL)`

/** SQL: a parity run of the company aliased `l` after its first full rebuild that is clean or accepted. */
const PARITY_PASSED_SQL = (l = 'l') => `EXISTS (SELECT 1 FROM ledger_rebuild_runs p
   WHERE p.landlord_id = ${l}.id AND p.mode = 'check' AND p.status = 'done' AND p.scope->>'kind' = 'parity'
     AND (COALESCE((p.counts->>'unexplained')::int, 1) = 0 OR p.scope->>'accepted' = 'true')
     AND p.started_at >= ${FIRST_FULL_REBUILD_SQL(l)})`

/** The companies (of `ids`) whose reports read the ledger (see the header). */
export async function ledgerLiveCompanyIds(ids: readonly string[]): Promise<Set<string>> {
  if (process.env[LEDGER_REPORTS_ENV] === 'off') return new Set()
  const list = [...new Set(ids.filter(Boolean))]
  if (!list.length) return new Set()
  const rows = await query<{ id: string }>(
    `SELECT l.id::text AS id FROM landlords l
      WHERE l.id = ANY($1::uuid[]) AND l.books_start_date IS NOT NULL
        AND ${FIRST_FULL_REBUILD_SQL('l')} IS NOT NULL AND ${PARITY_PASSED_SQL('l')}`,
    [list])
  return new Set(rows.map(r => r.id))
}

/** TRUE when every company of the list reads the ledger (null = every landlord: never). */
export async function ledgerReportsLive(landlordIds: readonly string[] | null | undefined): Promise<boolean> {
  if (!landlordIds || landlordIds.length === 0) return false
  const live = await ledgerLiveCompanyIds(landlordIds)
  return landlordIds.every(id => live.has(id))
}

/** Why a company's reports still read the money records (for a screen to say). */
export async function ledgerNotLiveReason(landlordId: string): Promise<string | null> {
  if (process.env[LEDGER_REPORTS_ENV] === 'off') return 'Reports read the money records while the books are switched off for a check.'
  const r = (await query<{ start: string | null; built: boolean; passed: boolean }>(
    `SELECT l.books_start_date::text AS start, ${FIRST_FULL_REBUILD_SQL('l')} IS NOT NULL AS built,
            ${PARITY_PASSED_SQL('l')} AS passed
       FROM landlords l WHERE l.id = $1`, [landlordId]))[0]
  if (!r) return 'No such company.'
  if (!r.start) return 'Your books start once you pick their start date in Books settings.'
  if (!r.built) return 'Your books are being built from your money records; until they are, these reports read the records directly.'
  if (!r.passed) return 'Your books are built. Your reports switch to them once the nightly check finds they match your money records; until then they read the records directly.'
  return null
}

// ─── Scope ──────────────────────────────────────────────────────────────────

export interface LedgerScope {
  landlordIds: readonly string[]
  /** null/undefined = every property and the company's own lines; a list = only those properties. */
  propertyIds?: readonly string[] | null
  /** A bookkeeper's clean cut at a sale ([] = none). */
  cutoffs?: readonly PropertyCutoff[] | null
}

/** Pushes a parameter and returns its placeholder. */
function param(params: unknown[], v: unknown): string {
  params.push(v)
  return `$${params.length}`
}

/** The scope's WHERE conditions on the line table aliased `l`. */
function scopeSql(s: LedgerScope, params: unknown[], l = 'l'): string {
  const conds = [`${l}.landlord_id = ANY(${param(params, [...s.landlordIds])}::uuid[])`]
  if (s.propertyIds) conds.push(`${l}.property_id = ANY(${param(params, [...s.propertyIds])}::uuid[])`)
  if (s.cutoffs?.length) conds.push(withinCutoffsSql(`${l}.property_id`, `${l}.accounting_date`, param(params, cutoffsParam(s.cutoffs))))
  return conds.join(' AND ')
}

/** In scope (after the fact, for lines read company-wide and placed on a property here). */
function inScope(s: LedgerScope, propertyId: string | null, day: string): boolean {
  if (s.propertyIds && (!propertyId || !s.propertyIds.includes(propertyId))) return false
  return !pastCutoff(s.cutoffs, propertyId, day)
}

// ─── Income: the events every report reads (services/incomeBasis) ──────────

/** The report line of an income category. */
const LINE_OF_CATEGORY: Record<IncomeCategory, ReportLine> = {
  space_rent: 'rent',
  electric: 'utilities', water: 'utilities', sewer: 'utilities', gas: 'utilities', trash: 'utilities',
  propane: 'utilities', utility_other: 'utilities',
  late_fees: 'lateFees', home_payments: 'homeSale', other_fees: 'fees', balances_collected: 'balances',
  register_sales: 'registerAndStays', stays_and_pay_links: 'registerAndStays', other_income: 'otherIncome',
}

/** An income account's category when its line names none (by the role it posted to). */
const CATEGORY_OF_ROLE: Partial<Record<LedgerAccountRole, IncomeCategory>> = {
  space_rent: 'space_rent', late_fees: 'late_fees',
  application_fees: 'other_fees', pet_fees: 'other_fees', storage_fees: 'other_fees', other_fees: 'other_fees',
  laundry_vending: 'other_income', other_income: 'other_income', interest_earned: 'other_income',
  utility_reimbursements: 'utility_other', utility_electric: 'electric', utility_water: 'water', utility_sewer: 'sewer',
  utility_gas: 'gas', utility_trash: 'trash', utility_propane: 'propane', utility_other: 'utility_other',
  home_sales: 'home_payments', home_note_interest: 'home_payments',
  stay_income: 'stays_and_pay_links', register_sales: 'register_sales', sales_returns: 'register_sales',
}

const isIncomeCategory = (c: string | null): c is IncomeCategory =>
  !!c && (INCOME_CATEGORIES as readonly string[]).includes(c)

interface LineRow {
  landlord_id: string; property_id: string | null; unit_id: string | null; lease_id: string | null
  payment_id: string | null; due_date: string | null; day: string; report_category: string | null
  account_role: string | null; account_type: string; amount: string
}

function baseEvent(r: LineRow): Omit<IncomeEvent, 'line' | 'category' | 'inTotal' | 'amount'> {
  return {
    landlordId: r.landlord_id, propertyId: r.property_id, unitId: r.unit_id, leaseId: r.lease_id,
    paymentId: r.payment_id, dueDate: r.due_date, day: r.day, part: null, moveOutId: null, ledger: 'line',
  }
}

/** What one received (cash_effect 'in') line is in a report: its line, category, and whether it is income. */
export function receivedLineOf(reportCategory: string | null, role: string | null, accountType: string): {
  line: ReportLine | AsideLine; category: IncomeCategory | null; inTotal: boolean
} {
  if (isIncomeCategory(reportCategory)) return { line: LINE_OF_CATEGORY[reportCategory], category: reportCategory, inTotal: true }
  switch (reportCategory) {
    case 'paid_ahead': return { line: 'paidAhead', category: null, inTotal: true }
    case 'deposits': return { line: 'depositsHeld', category: null, inTotal: false }
    case 'tax_collected': return { line: 'taxCollected', category: null, inTotal: false }
    case 'not_income': return { line: accountType === 'equity' ? 'ownerContributions' : 'saleProceeds', category: null, inTotal: false }
    case 'refunds': {
      if (role === 'tenant_prepayments') return { line: 'paidAheadRefunded', category: null, inTotal: true }
      if (role === 'security_deposits_payable' || role === 'deposits_gam_holds') return { line: 'depositsHeld', category: null, inTotal: false }
      const cat = role ? CATEGORY_OF_ROLE[role as LedgerAccountRole] ?? null : null
      return { line: 'returned', category: cat, inTotal: true }
    }
    default: {
      const cat = role ? CATEGORY_OF_ROLE[role as LedgerAccountRole] ?? null : null
      return cat ? { line: LINE_OF_CATEGORY[cat], category: cat, inTotal: true } : { line: 'otherIncome', category: 'other_income', inTotal: true }
    }
  }
}

/** What one income-account line is in the Charged column. */
export function chargedLineOf(reportCategory: string | null, role: string | null): { line: ReportLine; category: IncomeCategory | null } {
  if (isIncomeCategory(reportCategory)) return { line: LINE_OF_CATEGORY[reportCategory], category: reportCategory }
  if (reportCategory === 'credits_given' || role === 'credits_given') return { line: 'creditsGiven', category: null }
  if (reportCategory === 'work_trade' || role === 'work_trade_discount') return { line: 'workTradeDiscount', category: null }
  if (role === 'deposit_deductions_kept') return { line: 'depositDeductions', category: null }
  const cat = role ? CATEGORY_OF_ROLE[role as LedgerAccountRole] ?? null : null
  if (reportCategory === 'refunds') return { line: 'returned', category: cat }
  return cat ? { line: LINE_OF_CATEGORY[cat], category: cat } : { line: 'otherIncome', category: 'other_income' }
}

/** The line an amount still owed is listed on (by the bill's category). */
export function owedLineOf(reportCategory: string | null): { line: ReportLine; category: IncomeCategory | null } {
  if (isIncomeCategory(reportCategory)) return { line: LINE_OF_CATEGORY[reportCategory], category: reportCategory }
  if (reportCategory === 'deposits') return { line: 'depositsOwed', category: null }
  return { line: 'fees', category: 'other_fees' }
}

/** The last day of each month from `start` through `end`, and `end` itself ('YYYY-MM-DD'). */
export function snapshotDays(start: string, end: string): string[] {
  const out: string[] = []
  const [ey, em] = end.split('-').map(Number)
  let [y, m] = start.split('-').map(Number)
  while (y < ey || (y === ey && m <= em)) {
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    if (last < end) out.push(last)
    m++; if (m > 12) { m = 1; y++ }
  }
  out.push(end)
  return out
}

/**
 * The money facts of a period from the ledger, in the shape every report
 * reads (services/incomeBasis IncomeEvent). basis 'received': the Received
 * column. basis 'billed': the Charged column, plus the amounts still owed at
 * each month's end and the period's end (ledger 'owed', for the Owed column)
 * and the receivables movements of the proof strip (ledger 'proof'). Neither
 * of those last two is in any total (inTotal false, a line no total reads).
 */
export async function ledgerIncomeEvents(q: IncomeQuery): Promise<IncomeEvent[]> {
  if (q.landlordIds && q.landlordIds.length === 0) return []
  if (q.propertyIds && q.propertyIds.length === 0) return []
  if (!q.landlordIds) return []
  const s: LedgerScope = { landlordIds: q.landlordIds, propertyIds: q.propertyIds ?? null, cutoffs: q.cutoffs ?? null }
  const start = ymd(q.start), end = ymd(q.end)
  return q.basis === 'received' ? receivedEvents(s, start, end) : chargedEvents(s, start, end)
}

const LINE_COLS = `l.landlord_id::text AS landlord_id, l.property_id::text AS property_id, l.unit_id::text AS unit_id,
       l.lease_id::text AS lease_id, l.payment_id::text AS payment_id, pay.due_date::text AS due_date,
       l.accounting_date::text AS day, l.report_category, l.account_role, a.type AS account_type`

async function receivedEvents(s: LedgerScope, start: string, end: string): Promise<IncomeEvent[]> {
  const params: unknown[] = [start, end]
  const rows = await query<DetailRow>(
    `SELECT ${LINE_COLS}, l.map_kind, l.map_value, ${STAY_BOOKING_SQL} AS booking_id,
            ROUND(SUM(l.credit - l.debit), 2)::text AS amount
       FROM ledger_posting_lines l
       JOIN books_accounts a ON a.id = l.account_id
       JOIN ledger_postings ps ON ps.id = l.posting_id
       LEFT JOIN payments pay ON pay.id = l.payment_id
      WHERE l.cash_effect = 'in' AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, params)}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
     HAVING SUM(l.credit - l.debit) <> 0`, params)
  return (await itemized(rows)).map(({ row: r, amount, detail }) => ({
    ...baseEvent(r), ...receivedLineOf(r.report_category, r.account_role, r.account_type), amount, ...(detail.length ? { detail } : {}),
  }))
}

async function chargedEvents(s: LedgerScope, start: string, end: string): Promise<IncomeEvent[]> {
  const params: unknown[] = [start, end]
  const income = query<DetailRow>(
    `SELECT ${LINE_COLS}, l.map_kind, l.map_value, NULL::text AS booking_id, ROUND(SUM(l.credit - l.debit), 2)::text AS amount
       FROM ledger_posting_lines l
       JOIN books_accounts a ON a.id = l.account_id
       LEFT JOIN payments pay ON pay.id = l.payment_id
      WHERE a.type = 'income' AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, params)}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
     HAVING SUM(l.credit - l.debit) <> 0`, params).then(itemized)
  // 10/12 (Nic, review): every snapshot day travels with each 'owed' fact, so
  // a day on which nothing was owed still counts as the day Owed is read
  // (Owed $0), and the day before the start gives the proof strip a real
  // owed-at-start to tie out against.
  const [rows, owed, flows] = await Promise.all([income, owedSnapshots(s, [addDays(start, -1), ...snapshotDays(start, end)], end), receivableFlows(s, start, end)])
  return [
    ...rows.map(({ row: r, amount, detail }) => ({
      ...baseEvent(r), ...chargedLineOf(r.report_category, r.account_role), inTotal: true, amount, ...(detail.length ? { detail } : {}),
    })),
    ...owed,
    ...flows,
  ]
}

// ─── 10/14 (Nic I1): the Detailed view's pieces ─────────────────────────────
//
// Nic's bookkeeper (10/14): "we need everything to be as itemized as
// possible". Each fact names the income line(s) it is (IncomeEvent.detail):
//   - a line on an itemized income account names its own (the line's
//     sub-account — rent and stays by space — or the home-sale roles, I3);
//   - money received or still owed on a bill is itemized as the bill was
//     charged (its charge posting's income lines, in proportion);
//   - stay money received before the stay is earned, as the stay will earn it
//     (its booking: under 30 nights short-term, else long-term, I2).
// The space's subtype rides along (a reporting dimension, never an account).
// Facts keep their grain: a fact's pieces add to its amount, and what they do
// not cover stays on its Summary group.

const ITEMIZED_CATEGORIES: ReadonlySet<string> = new Set(['space_rent', 'stays_and_pay_links', 'home_payments'])

interface DetailRow extends LineRow { map_kind: string | null; map_value: string | null; booking_id: string | null }

/**
 * SQL over l / ps: the booking a stay's money received toward it belongs to
 * (none for any other line). Money taken in before the stay sits on a role's
 * own account (map kind 'role': guest deposits, the register); a line on an
 * itemized income account names its own line instead (itemized, own).
 */
const STAY_BOOKING_SQL = `(CASE WHEN l.payment_id IS NULL AND l.report_category = 'stays_and_pay_links' AND COALESCE(l.map_kind, 'role') = 'role' THEN
   COALESCE(CASE WHEN ps.source_type = 'booking' THEN split_part(ps.source_id, '|', 1) END,
            (SELECT sp.booking_id::text FROM stay_payments sp JOIN unit_bookings bk ON bk.id = sp.booking_id
              WHERE ps.source_type = 'pos_sale' AND sp.pos_transaction_id::text = ps.source_id
                AND bk.unit_id IS NOT DISTINCT FROM l.unit_id
              ORDER BY sp.booking_id LIMIT 1)) END)`

/** One weighted share of a split: an income line (key '' = not itemized). */
interface Share { key: string; label: string; order: number; weight: number }

/** How each bill was charged: its charge posting's credits, by income line. */
async function billShares(paymentIds: readonly string[]): Promise<Map<string, Share[]>> {
  const out = new Map<string, Share[]>()
  if (!paymentIds.length) return out
  const rows = await query<{ pid: string; map_kind: string | null; map_value: string | null; role: string | null; c: string }>(
    `SELECT l.payment_id::text AS pid, l.map_kind, l.map_value, l.account_role AS role,
            round(SUM(l.credit - l.debit) * 100)::bigint::text AS c
       FROM ledger_posting_lines l
       JOIN ledger_postings ps ON ps.id = l.posting_id
      WHERE l.payment_id = ANY($1::uuid[]) AND ps.source_type = 'payment' AND ps.posting_kind = 'charge'
        AND ps.role = 'post' AND ps.superseded_at IS NULL AND l.account_role IS DISTINCT FROM 'ar_tenants'
      GROUP BY 1, 2, 3, 4
     HAVING SUM(l.credit - l.debit) <> 0`, [[...new Set(paymentIds)]])
  for (const r of rows) {
    const d = ledgerIncomeDetailOf(r.map_kind, r.map_value, r.role)
    const list = out.get(r.pid) ?? []
    list.push({ key: d?.key ?? '', label: d?.label ?? '', order: d?.order ?? 0, weight: Math.abs(Number(r.c)) })
    out.set(r.pid, list)
  }
  return out
}

/** How each stay earns (incomeLines.stayParts, the projector's own rule): one share, its line. */
async function bookingShares(bookingIds: readonly string[]): Promise<Map<string, Share[]>> {
  const out = new Map<string, Share[]>()
  const ids = [...new Set(bookingIds)].filter(id => /^[0-9a-f-]{36}$/i.test(id))
  if (!ids.length) return out
  const rows = await query<any>(
    `SELECT b.id::text AS id, ${SPACE_COLS_SQL('su', 'sl', 'b.created_at')}, b.stay_terms,
            (GREATEST(b.check_out, COALESCE(b.booked_check_out, b.check_out)) - b.check_in) AS nights
       FROM unit_bookings b LEFT JOIN units su ON su.id = b.unit_id LEFT JOIN leases sl ON FALSE
      WHERE b.id = ANY($1::uuid[])`, [ids])
  for (const r of rows) {
    const parts = stayParts({ space: spaceOf(r), nightsSold: Number(r.nights) || 0, stayTerms: r.stay_terms ?? null }, 10_000)
    out.set(r.id, parts.map(p => {
      const d = p.sub ? ledgerIncomeDetailOf(p.sub.kind, p.sub.value) : null
      return { key: d?.key ?? '', label: d?.label ?? '', order: d?.order ?? 0, weight: Math.abs(p.cents) }
    }))
  }
  return out
}

/** Each unit's subtypes, named ("Double wide"; several joined by " · "). */
async function subtypeNames(unitIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(unitIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const rows = await query<{ unit_id: string; names: string }>(
    `SELECT k.unit_id::text AS unit_id, string_agg(DISTINCT st.name, ' · ') AS names
       FROM unit_subtype_links k JOIN property_unit_subtypes st ON st.id = k.subtype_id
      WHERE k.unit_id = ANY($1::uuid[]) GROUP BY 1`, [ids])
  return new Map(rows.map(r => [r.unit_id, r.names]))
}

/** `amountCents` split over the shares, as pieces (a share that is not itemized stays off them). */
function piecesOf(amountCents: number, shares: readonly Share[], subtype: string | null): IncomeDetailPiece[] {
  const parts = splitBy(amountCents, shares.map(x => x.weight))
  const out: IncomeDetailPiece[] = []
  shares.forEach((x, i) => {
    if (!x.key || !parts[i]) return
    out.push({ key: x.key, label: x.label, order: x.order, amount: parts[i] / 100, subtype: x.key.includes(':') ? subtype : null })
  })
  return out
}

/** The rows' pieces, and the rows merged back to a fact's grain (every column but the line's account and booking). */
async function itemized(rows: readonly DetailRow[]): Promise<Array<{ row: LineRow; amount: number; detail: IncomeDetailPiece[] }>> {
  const own = (r: DetailRow) => ledgerIncomeDetailOf(r.map_kind, r.map_value, r.account_role)
  const billIds = rows.filter(r => !own(r) && r.payment_id && ITEMIZED_CATEGORIES.has(r.report_category ?? '')).map(r => r.payment_id!)
  const [bills, stays, subtypes] = await Promise.all([
    billShares(billIds),
    bookingShares(rows.filter(r => !own(r) && r.booking_id).map(r => r.booking_id!)),
    subtypeNames(rows.map(r => r.unit_id ?? '')),
  ])
  const merged = new Map<string, { row: LineRow; cents: number; detail: IncomeDetailPiece[] }>()
  for (const r of rows) {
    const cents = Math.round(Number(r.amount) * 100)
    const sub = r.unit_id ? subtypes.get(r.unit_id) ?? null : null
    const mine = own(r)
    const detail: IncomeDetailPiece[] = mine
      ? [{ key: mine.key, label: mine.label, order: mine.order, amount: cents / 100, subtype: mine.key.includes(':') ? sub : null }]
      : r.payment_id && bills.has(r.payment_id) && ITEMIZED_CATEGORIES.has(r.report_category ?? '') ? piecesOf(cents, bills.get(r.payment_id)!, sub)
      : r.booking_id && stays.has(r.booking_id) ? piecesOf(cents, stays.get(r.booking_id)!, sub)
      : []
    const k = [r.landlord_id, r.property_id, r.unit_id, r.lease_id, r.payment_id, r.due_date, r.day, r.report_category, r.account_role, r.account_type].join('\u0000')
    const m = merged.get(k)
    if (!m) { merged.set(k, { row: r, cents, detail }); continue }
    m.cents += cents
    for (const p of detail) {
      const same = m.detail.find(x => x.key === p.key && x.subtype === p.subtype)
      if (same) same.amount = round2(same.amount + p.amount)
      else m.detail.push(p)
    }
  }
  return [...merged.values()].filter(m => m.cents !== 0).map(m => ({ row: m.row, amount: m.cents / 100, detail: m.detail }))
}

/** 'YYYY-MM-DD' plus n days. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * The receivables still open at the end of each given day, by property, lease
 * and category: ledger 'owed' (dated that day, the Owed column) for each day
 * from the period's start on, and ledger 'owedStart' (dated the NEXT day, the
 * proof strip's owed at the start of it) for each day before `lastDay` — so a
 * report that splits the facts by month or property finds a month's opening
 * balance among that month's own facts. 10/12 (Nic, review): only days with
 * something owed have rows, so every fact carries the whole list of days read
 * (owedDays): Owed on a day with no rows is $0, never an earlier day's balance.
 */
async function owedSnapshots(s: LedgerScope, days: string[], lastDay: string): Promise<IncomeEvent[]> {
  const params: unknown[] = [days]
  const rows = await query<{
    day: string; landlord_id: string; property_id: string | null; unit_id: string | null; lease_id: string | null
    report_category: string | null; amount: string; payment_id: string | null
  }>(
    `SELECT d.day::text AS day, l.landlord_id::text AS landlord_id, l.property_id::text AS property_id,
            l.unit_id::text AS unit_id, l.lease_id::text AS lease_id, l.report_category,
            l.payment_id::text AS payment_id,
            ROUND(SUM(l.debit - l.credit), 2)::text AS amount
       FROM unnest($1::date[]) AS d(day)
       JOIN ledger_posting_lines l ON l.accounting_date <= d.day
      WHERE l.account_role = 'ar_tenants' AND ${scopeSql(s, params)}
      GROUP BY 1, 2, 3, 4, 5, 6, 7
     HAVING SUM(l.debit - l.credit) <> 0`, params)
  // 10/14 (Nic I1): what is still owed on a bill, itemized as the bill was
  // charged (the Detailed view); the facts keep their grain (no bill on them).
  const owedBills = rows.filter(r => r.payment_id && ITEMIZED_CATEGORIES.has(r.report_category ?? '')).map(r => r.payment_id!)
  const [bills, subtypes] = await Promise.all([billShares(owedBills), subtypeNames(rows.map(r => r.unit_id ?? ''))])
  const grain = new Map<string, { r: typeof rows[number]; cents: number; detail: IncomeDetailPiece[] }>()
  for (const r of rows) {
    const cents = Math.round(Number(r.amount) * 100)
    const shares = r.payment_id && ITEMIZED_CATEGORIES.has(r.report_category ?? '') ? bills.get(r.payment_id) : undefined
    const detail = shares ? piecesOf(cents, shares, r.unit_id ? subtypes.get(r.unit_id) ?? null : null) : []
    const k = [r.day, r.landlord_id, r.property_id, r.unit_id, r.lease_id, r.report_category].join('\u0000')
    const g = grain.get(k)
    if (!g) { grain.set(k, { r, cents, detail }); continue }
    g.cents += cents
    for (const p of detail) {
      const same = g.detail.find(x => x.key === p.key && x.subtype === p.subtype)
      if (same) same.amount = round2(same.amount + p.amount)
      else g.detail.push(p)
    }
  }
  const owedDays: readonly string[] = Object.freeze([...new Set(days)].sort())
  const first = owedDays[0]
  const out: IncomeEvent[] = []
  for (const { r, cents, detail } of grain.values()) {
    if (cents === 0) continue
    const base = {
      landlordId: r.landlord_id, propertyId: r.property_id, unitId: r.unit_id, leaseId: r.lease_id, paymentId: null,
      dueDate: null, ...owedLineOf(r.report_category), amount: cents / 100, inTotal: false, moveOutId: null, owedDays,
      ...(detail.length ? { detail } : {}),
    }
    // The day before the period is read only as the period's opening balance.
    if (r.day !== first) out.push({ ...base, day: r.day, part: 'stillOwed', ledger: 'owed' })
    if (r.day < lastDay) out.push({ ...base, day: addDays(r.day, 1), part: null, ledger: 'owedStart' })
  }
  return out
}

/**
 * What each receivables (1100) line in the period was, for the proof strip:
 * received (money in, a reversal negative), billed, credits given, work trade,
 * paid from paid-ahead money, paid from deposits, opening balances, written
 * off, or another correction.
 */
export const RECEIVABLE_TERM_SQL = `
  CASE WHEN l.cash_effect = 'in' THEN 'received'
       WHEN ps.source_type = 'opening' OR f.ob THEN 'opening'
       WHEN f.wo THEN 'writtenOff'
       WHEN ps.posting_kind = 'work_trade' THEN 'workTrade'
       WHEN ps.posting_kind = 'paid_from_deposit' OR ps.source_type IN ('deposit_return', 'security_deposit')
         -- 10/12 (Nic, review): a move-out balance the tenant still owes is a
         -- new bill (a debit; a reversal's credit takes it back), not money
         -- paid from the deposit.
         THEN CASE WHEN (l.debit > 0) <> (ps.role = 'reversal') THEN 'billed' ELSE 'deposits' END
       WHEN ps.source_type = 'credit_use' THEN CASE WHEN f.pa THEN 'paidAhead' ELSE 'creditsGiven' END
       WHEN ps.posting_kind = 'charge' THEN 'billed'
       ELSE 'other' END`

const POSTING_FLAGS_SQL = `
  LEFT JOIN LATERAL (
    SELECT bool_or(o.account_role = 'tenant_prepayments') AS pa,
           bool_or(o.account_role = 'opening_balance_equity') AS ob,
           bool_or(o.account_role = 'bad_debt') AS wo
      FROM ledger_posting_lines o WHERE o.posting_id = l.posting_id) f ON TRUE`

async function receivableFlows(s: LedgerScope, start: string, end: string): Promise<IncomeEvent[]> {
  const params: unknown[] = [start, end]
  const rows = await query<{
    day: string; landlord_id: string; property_id: string | null; unit_id: string | null; lease_id: string | null
    report_category: string | null; term: LedgerProofTerm; amount: string
  }>(
    `SELECT l.accounting_date::text AS day, l.landlord_id::text AS landlord_id, l.property_id::text AS property_id,
            l.unit_id::text AS unit_id, l.lease_id::text AS lease_id, l.report_category,
            ${RECEIVABLE_TERM_SQL} AS term, ROUND(SUM(l.debit - l.credit), 2)::text AS amount
       FROM ledger_posting_lines l
       JOIN ledger_postings ps ON ps.id = l.posting_id
       ${POSTING_FLAGS_SQL}
      WHERE l.account_role = 'ar_tenants' AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, params)}
      GROUP BY 1, 2, 3, 4, 5, 6, 7
     HAVING SUM(l.debit - l.credit) <> 0`, params)
  return rows.map(r => ({
    landlordId: r.landlord_id, propertyId: r.property_id, unitId: r.unit_id, leaseId: r.lease_id, paymentId: null,
    dueDate: null, day: r.day, ...owedLineOf(r.report_category), part: null, amount: Number(r.amount),
    inTotal: false, moveOutId: null, ledger: 'proof' as const, proofTerm: r.term,
  }))
}

/** Paid-ahead money the company holds at the end of a day (2050; GAM-held money is not on its books, Nic L13). */
export async function ledgerPaidAheadUnusedAt(q: Omit<IncomeQuery, 'start' | 'basis'>): Promise<number> {
  if (!q.landlordIds || q.landlordIds.length === 0) return 0
  if (q.propertyIds && q.propertyIds.length === 0) return 0
  const params: unknown[] = [ymd(q.end)]
  const s: LedgerScope = { landlordIds: q.landlordIds, propertyIds: q.propertyIds ?? null, cutoffs: q.cutoffs ?? null }
  const r = await query<{ n: string }>(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS n FROM ledger_posting_lines l
      WHERE l.account_role = 'tenant_prepayments' AND l.accounting_date <= $1::date AND ${scopeSql(s, params)}`, params)
  return round2(Number(r[0]?.n ?? 0))
}

// ─── Expenses: incurred (Charged-based) and paid (Received-based) ───────────

/**
 * 10/12 (Nic, review): what pays an expense line on the day it is dated, for
 * the paid (Received-based) column. Design §10: the Received-based column
 * counts real money out — cash lines, money GAM holds for the company,
 * payroll on the pay date. Decided PER LINE, not per posting: one posting can
 * hold a processing fee taken from the money (paid) beside stock used (not
 * paid), or a manager's cut paid from the money beside the part still owed
 * (accounts payable). Each expense line is matched with the lines that offset
 * it (expenseLinePaidCents); the offset is PAYING when it is:
 *   - the company's cash (CASH_ROLES), an outstanding check, a credit card
 *   - money GAM holds for the company (due_from_gam*), the owner's own money
 *   - payroll's liabilities (payroll counts on the pay date, design J3)
 *   - money that came in or went out (a line with a cash effect), or income
 *     the money came from (a card fee taken out of a register sale)
 *   - a GAM charge billed to the company (due_to_gam, equipment_owed_to_gam):
 *     counted when billed, as before — WHEN a GAM charge counts as paid
 *     (billed or collected) waits on Nic's choice
 *   - a loan (money borrowed paid it)
 * Anything else defers it: accounts payable (counted on each payment's day,
 * payableExpensePayments), depreciation, a receivable worked off or written
 * off, stock used, a prepaid or accrued account, opening equity, suspense, an
 * account of the company's own that is not a bank account.
 */
const PAYING_ROLES: ReadonlySet<string> = new Set([
  'bank_checking', 'bank_savings', 'own_deposit_account', 'undeposited_funds', 'deposits_in_transit', 'stripe_in_transit',
  'outstanding_checks', 'credit_card_payable', 'due_from_gam', 'due_from_gam_tenant_money', 'owner_equity',
  'payroll_liabilities', 'payroll_federal_withholding', 'payroll_state_withholding', 'payroll_fica', 'payroll_futa',
  'payroll_suta', 'net_pay_payable', 'due_to_gam', 'equipment_owed_to_gam', 'mortgage_payable',
])

/** One line of a posting that holds an expense line, as the paid column reads it. */
export interface ExpensePostingLine {
  lineNo: number
  /** debit − credit, in cents. */
  cents: number
  /** 'expense' (an expense account), 'paying', 'deferred', or 'skip' (inter-property clearing). */
  kind: 'expense' | 'paying' | 'deferred' | 'skip'
}

/**
 * 10/12 (Nic, review): how much of each expense line of ONE posting is paid
 * on its day (cents, signed like the line). Lines are read in their order and
 * each expense line is matched with the offsetting lines nearest it (last in,
 * first out) — the projectors write each cost beside what offsets it, so the
 * processing fee meets the money it was taken from and the stock used meets
 * the inventory. The part matched to a PAYING line is paid. A reversal flips
 * every side and matches the same way, so it takes back exactly what its
 * original counted.
 */
export function expenseLinePaidCents(lines: readonly ExpensePostingLine[]): Map<number, number> {
  const paid = new Map<number, number>()
  type Open = { lineNo: number; left: number; kind: ExpensePostingLine['kind'] }
  const open: Open[] = []
  for (const l of [...lines].sort((a, b) => a.lineNo - b.lineNo)) {
    if (l.kind === 'skip' || l.cents === 0) continue
    const item: Open = { lineNo: l.lineNo, left: l.cents, kind: l.kind }
    for (let i = open.length - 1; i >= 0 && item.left !== 0; i--) {
      const o = open[i]
      if (Math.sign(o.left) === Math.sign(item.left)) continue
      const take = Math.min(Math.abs(o.left), Math.abs(item.left))
      const exp = item.kind === 'expense' ? item : o.kind === 'expense' ? o : null
      const other = exp === item ? o : item
      // An expense line matched with a paying line is paid by it; with another
      // expense line (a cost moved between accounts) it keeps its standing.
      if (exp && (other.kind === 'paying' || other.kind === 'expense')) {
        const sign = Math.sign(exp.left)
        paid.set(exp.lineNo, (paid.get(exp.lineNo) ?? 0) + sign * take)
        if (other.kind === 'expense') paid.set(other.lineNo, (paid.get(other.lineNo) ?? 0) - sign * take)
      }
      item.left -= Math.sign(item.left) * take
      o.left -= Math.sign(o.left) * take
      if (o.left === 0) open.splice(i, 1)
    }
    if (item.left !== 0) open.push(item)
  }
  return paid
}

export interface LedgerExpenseRow {
  accountId: string; code: string; name: string; role: string | null; propertyId: string | null
  /** Charged-based: dated in the period. */
  incurredCents: number
  /** Received-based: paid in the period. */
  paidCents: number
}

interface AccountMeta { id: string; code: string; name: string; type: string; parent_account_id: string | null }

/**
 * Every expense account's money in the period, by property: incurred (the
 * account's lines dated in it) and paid (decided line by line,
 * expenseLinePaidCents; an expense through accounts payable counts on the day
 * each payment toward it was made, on its own expense's accounts, in their
 * proportions).
 */
export async function ledgerExpenseRows(s: LedgerScope, start: string, end: string): Promise<LedgerExpenseRow[]> {
  const params: unknown[] = [ymd(start), ymd(end)]
  const inScopeSql = scopeSql(s, params)
  const payingParam = param(params, [...PAYING_ROLES])
  // Every line of each posting that has an expense line in the period and the
  // scope. A hand journal line names its account, not a role: it reads the
  // role its account (or the account it sits under) is mapped from, and an
  // account of the company's own is cash only when it is a linked bank's.
  const lines = query<{
    posting_id: string; line_no: number; account_id: string; role: string | null; property_id: string | null
    acct_type: string; kind: 'expense' | 'paying' | 'deferred' | 'skip'; counted: boolean; amount: string
  }>(
    `WITH ps AS (
       SELECT DISTINCT l.posting_id FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
        WHERE a.type = 'expense' AND l.accounting_date BETWEEN $1::date AND $2::date AND ${inScopeSql})
     SELECT l.posting_id::text AS posting_id, l.line_no, l.account_id::text AS account_id, l.account_role AS role,
            l.property_id::text AS property_id, a.type AS acct_type,
            CASE WHEN a.type = 'expense' THEN 'expense'
                 WHEN l.account_role = 'interproperty_clearing' OR l.system_line THEN 'skip'
                 WHEN l.cash_effect IS NOT NULL OR a.type = 'income' THEN 'paying'
                 WHEN ${effectiveRoleSql('l', 'a')} = ANY(${payingParam}::text[]) THEN 'paying'
                 WHEN l.account_role IS NULL AND a.bank_connection_id IS NOT NULL THEN 'paying'
                 ELSE 'deferred' END AS kind,
            (a.type = 'expense' AND l.accounting_date BETWEEN $1::date AND $2::date AND ${inScopeSql}) AS counted,
            (l.debit - l.credit)::text AS amount
       FROM ledger_posting_lines l
       JOIN ps ON ps.posting_id = l.posting_id
       JOIN books_accounts a ON a.id = l.account_id
      ORDER BY l.posting_id, l.line_no`, params)
  const [all, viaPayable] = await Promise.all([lines, payableExpensePayments(s, start, end)])
  const by = new Map<string, { accountId: string; role: string | null; propertyId: string | null; incurred: number; paid: number }>()
  const slot = (accountId: string, role: string | null, propertyId: string | null) => {
    const k = `${accountId}|${propertyId ?? ''}`
    let x = by.get(k)
    if (!x) { x = { accountId, role, propertyId, incurred: 0, paid: 0 }; by.set(k, x) }
    return x
  }
  for (let i = 0; i < all.length;) {
    let j = i
    while (j < all.length && all[j].posting_id === all[i].posting_id) j++
    const posting = all.slice(i, j)
    const paid = expenseLinePaidCents(posting.map(r => ({ lineNo: r.line_no, cents: cents(r.amount), kind: r.kind })))
    for (const r of posting) {
      if (!r.counted) continue
      const x = slot(r.account_id, r.role, r.property_id)
      x.incurred += cents(r.amount)
      x.paid += paid.get(r.line_no) ?? 0
    }
    i = j
  }
  for (const p of viaPayable) slot(p.accountId, p.role, p.propertyId).paid += p.cents
  const meta = await accountsById([...new Set([...by.values()].map(x => x.accountId))])
  return [...by.values()]
    .filter(x => x.incurred !== 0 || x.paid !== 0)
    .map(x => {
      const a = meta.get(x.accountId)
      return {
        accountId: x.accountId, code: a?.code ?? '', name: a?.name ?? 'Account', role: x.role, propertyId: x.propertyId,
        incurredCents: x.incurred, paidCents: x.paid,
      }
    })
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

/** Split `total` cents across `weights` (largest remainder; the parts add to it). */
function splitBy(total: number, weights: number[]): number[] {
  const sum = weights.reduce((t, w) => t + w, 0)
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const raw = weights.map(w => (total * w) / sum)
  const out = raw.map(v => Math.trunc(v))
  let left = total - out.reduce((t, v) => t + v, 0)
  const order = raw.map((v, i) => ({ i, r: Math.abs(v - Math.trunc(v)) })).sort((a, b) => b.r - a.r)
  for (let k = 0; left !== 0 && k < order.length; k++) {
    const step = left > 0 ? 1 : -1
    out[order[k].i] += step
    left -= step
  }
  return out
}

/**
 * The payments toward expenses that went through accounts payable (cash
 * 'out', kind 'expense'), in the period, placed on the expense's own expense
 * accounts and properties in their proportions — then the scope applied.
 */
async function payableExpensePayments(s: LedgerScope, start: string, end: string): Promise<Array<{
  accountId: string; role: string | null; propertyId: string | null; cents: number
}>> {
  const params: unknown[] = [ymd(start), ymd(end), [...s.landlordIds]]
  const pays = await query<{ expense_id: string; day: string; amount: string }>(
    `SELECT ep.expense_id::text AS expense_id, l.accounting_date::text AS day, SUM(l.debit - l.credit)::text AS amount
       FROM ledger_posting_lines l
       JOIN ledger_postings ps ON ps.id = l.posting_id AND ps.source_type = 'expense_payment'
       JOIN landlord_expense_payments ep ON ep.id::text = ps.source_id
      WHERE l.landlord_id = ANY($3::uuid[]) AND l.account_role = 'accounts_payable' AND l.cash_effect = 'out'
        AND l.expense_kind = 'expense' AND l.accounting_date BETWEEN $1::date AND $2::date
      GROUP BY 1, 2 HAVING SUM(l.debit - l.credit) <> 0`, params)
  if (!pays.length) return []
  const targets = await query<{ expense_id: string; account_id: string; role: string | null; property_id: string | null; amount: string }>(
    `SELECT ps.source_id AS expense_id, l.account_id::text AS account_id, l.account_role AS role,
            l.property_id::text AS property_id, SUM(l.debit - l.credit)::text AS amount
       FROM ledger_postings ps
       JOIN ledger_posting_lines l ON l.posting_id = ps.id
       JOIN books_accounts a ON a.id = l.account_id AND a.type = 'expense'
      WHERE ps.source_type = 'expense' AND ps.role = 'post' AND ps.superseded_at IS NULL
        AND ps.source_id = ANY($1::text[])
      GROUP BY 1, 2, 3, 4`, [[...new Set(pays.map(p => p.expense_id))]])
  const byExpense = new Map<string, typeof targets>()
  for (const t of targets) {
    const l = byExpense.get(t.expense_id)
    if (l) l.push(t); else byExpense.set(t.expense_id, [t])
  }
  // An expense whose cost was booked elsewhere posts nothing of its own (the
  // manager's cut GAM held too little to pay, Nic L18: the payout split booked
  // it to accounts payable): its payments land on its category's account.
  const orphans = [...new Set(pays.map(p => p.expense_id))].filter(id => !byExpense.has(id))
  if (orphans.length) {
    const fall = await query<{ expense_id: string; account_id: string | null; property_id: string | null }>(
      `SELECT e.id::text AS expense_id, books_category_account(e.category_id, e.expense_date)::text AS account_id,
              COALESCE(u.property_id, e.property_id)::text AS property_id
         FROM landlord_expenses e LEFT JOIN units u ON u.id = e.unit_id
        WHERE e.id::text = ANY($1::text[])`, [orphans])
    for (const f of fall) {
      if (f.account_id) byExpense.set(f.expense_id, [{ expense_id: f.expense_id, account_id: f.account_id, role: null, property_id: f.property_id, amount: '1' }])
    }
  }
  const out: Array<{ accountId: string; role: string | null; propertyId: string | null; cents: number }> = []
  for (const p of pays) {
    const ts = byExpense.get(p.expense_id)
    if (!ts?.length) continue
    const parts = splitBy(cents(p.amount), ts.map(t => Math.abs(cents(t.amount))))
    ts.forEach((t, i) => {
      if (parts[i] !== 0 && inScope(s, t.property_id, p.day)) {
        out.push({ accountId: t.account_id, role: t.role, propertyId: t.property_id, cents: parts[i] })
      }
    })
  }
  return out
}

async function accountsById(ids: string[]): Promise<Map<string, AccountMeta>> {
  if (!ids.length) return new Map()
  const rows = await query<AccountMeta>(
    `SELECT id::text AS id, code, name, type, parent_account_id::text AS parent_account_id FROM books_accounts WHERE id = ANY($1::uuid[])`, [ids])
  return new Map(rows.map(r => [r.id, r]))
}

/**
 * The P&L's expenses in the shape the reports have always read
 * (services/landlordPL LandlordPL['expenses']), from the expense accounts:
 *   platformFee      GAM platform fees (5155)
 *   processingFees   processing fees you pay (5115)
 *   cardFeesRefunded card fees refunded (5117)
 *   lotRent          lot rent (5200)
 *   maintenance      repairs and maintenance (5040)
 *   enteredExpenses  every other expense account
 *   total            incurred (Charged-based); cashTotal: paid (Received-based)
 * byAccount lists each account with both figures.
 */
export interface LedgerPLExpenses {
  platformFee: number; maintenance: number; lotRent: number; enteredExpenses: number; processingFees: number
  cardFeesRefunded: number; total: number
  cashTotal: number
  byAccount: Array<{ accountId: string; code: string; name: string; role: string | null; incurred: number; paid: number }>
}

const EXPENSE_BUCKET_OF_ROLE: Record<string, keyof Pick<LedgerPLExpenses,
  'platformFee' | 'maintenance' | 'lotRent' | 'processingFees' | 'cardFeesRefunded'>> = {
  gam_platform_fees: 'platformFee', repairs_maintenance: 'maintenance', lot_rent_expense: 'lotRent',
  processing_fees: 'processingFees', card_fees_refunded: 'cardFeesRefunded',
}

export function plExpensesFromRows(rows: readonly LedgerExpenseRow[]): LedgerPLExpenses {
  const b = { platformFee: 0, maintenance: 0, lotRent: 0, enteredExpenses: 0, processingFees: 0, cardFeesRefunded: 0 }
  let total = 0, cash = 0
  const acct = new Map<string, { accountId: string; code: string; name: string; role: string | null; incurred: number; paid: number }>()
  for (const r of rows) {
    const k = (r.role && EXPENSE_BUCKET_OF_ROLE[r.role]) || 'enteredExpenses'
    b[k] += r.incurredCents
    total += r.incurredCents
    cash += r.paidCents
    const a = acct.get(r.accountId) ?? { accountId: r.accountId, code: r.code, name: r.name, role: r.role, incurred: 0, paid: 0 }
    a.incurred += r.incurredCents
    a.paid += r.paidCents
    acct.set(r.accountId, a)
  }
  return {
    platformFee: b.platformFee / 100, maintenance: b.maintenance / 100, lotRent: b.lotRent / 100,
    enteredExpenses: b.enteredExpenses / 100, processingFees: b.processingFees / 100,
    cardFeesRefunded: b.cardFeesRefunded / 100, total: total / 100, cashTotal: cash / 100,
    byAccount: [...acct.values()].sort((x, y) => (x.code < y.code ? -1 : 1))
      .map(a => ({ ...a, incurred: a.incurred / 100, paid: a.paid / 100 })),
  }
}

export async function ledgerPLExpenses(s: LedgerScope, start: string, end: string): Promise<LedgerPLExpenses> {
  return plExpensesFromRows(await ledgerExpenseRows(s, start, end))
}

/** The P&L's expenses per property ('' = the company's own, on no property). */
export async function ledgerPLExpensesByProperty(s: LedgerScope, start: string, end: string): Promise<Map<string, LedgerPLExpenses>> {
  const rows = await ledgerExpenseRows(s, start, end)
  const by = new Map<string, LedgerExpenseRow[]>()
  for (const r of rows) {
    const k = r.propertyId ?? ''
    const l = by.get(k)
    if (l) l.push(r); else by.set(k, [r])
  }
  const out = new Map<string, LedgerPLExpenses>()
  for (const [k, list] of by) out.set(k, plExpensesFromRows(list))
  return out
}

/** One posting role's net debits per property in the period (processing fees, card fees refunded). */
export async function ledgerRoleByProperty(s: LedgerScope, role: LedgerAccountRole, start: string, end: string): Promise<Map<string, number>> {
  const params: unknown[] = [ymd(start), ymd(end), role]
  const rows = await query<{ property_id: string | null; n: string }>(
    `SELECT l.property_id::text AS property_id, SUM(l.debit - l.credit)::text AS n FROM ledger_posting_lines l
      WHERE l.account_role = $3 AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, params)}
      GROUP BY 1 HAVING SUM(l.debit - l.credit) <> 0`, params)
  return new Map(rows.map(r => [r.property_id ?? '', round2(Number(r.n))]))
}

/** Expenses entered on the Expenses record, by their day (the monthly P&L's "you logged $X"). */
export async function ledgerEnteredExpensesByDay(s: LedgerScope, start: string, end: string): Promise<Map<string, { amount: number; count: number }>> {
  const params: unknown[] = [ymd(start), ymd(end)]
  const rows = await query<{ day: string; n: string; c: number }>(
    `SELECT l.accounting_date::text AS day, SUM(l.debit - l.credit)::text AS n, COUNT(DISTINCT ps.source_id)::int AS c
       FROM ledger_posting_lines l
       JOIN ledger_postings ps ON ps.id = l.posting_id AND ps.source_type = 'expense'
       JOIN books_accounts a ON a.id = l.account_id AND a.type = 'expense'
      WHERE l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, params)}
      GROUP BY 1 HAVING SUM(l.debit - l.credit) <> 0`, params)
  return new Map(rows.map(r => [r.day, { amount: round2(Number(r.n)), count: r.c }]))
}

/** Expense money that left in the period (Received-based expenses: the cash statement's money out). */
export async function ledgerExpensesPaidOut(s: LedgerScope, start: string, end: string): Promise<number> {
  const rows = await ledgerExpenseRows(s, start, end)
  return rows.reduce((t, r) => t + r.paidCents, 0) / 100
}

// ─── Statements ─────────────────────────────────────────────────────────────

export interface AccountBalance {
  accountId: string; code: string; name: string; type: string; parentAccountId: string | null
  /** Debits less credits (cents) — the stored sign. */
  netCents: number
}

/** Each account's balance at the end of a day (debits − credits), in scope. */
async function balancesThrough(s: LedgerScope, day: string, after: string | null = null): Promise<AccountBalance[]> {
  const params: unknown[] = [ymd(day), after]
  const rows = await query<{ account_id: string; code: string; name: string; type: string; parent: string | null; n: string }>(
    `SELECT a.id::text AS account_id, a.code, a.name, a.type, a.parent_account_id::text AS parent,
            SUM(l.debit - l.credit)::text AS n
       FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
      WHERE l.accounting_date <= $1::date AND ($2::date IS NULL OR l.accounting_date > $2::date) AND ${scopeSql(s, params)}
      GROUP BY 1, 2, 3, 4, 5`, params)
  return rows.map(r => ({ accountId: r.account_id, code: r.code, name: r.name, type: r.type, parentAccountId: r.parent, netCents: cents(r.n) }))
}

/**
 * Each account's balance on the books at the end of a day (debits − credits,
 * the stored sign, as text to the cent) — what the chart of accounts shows
 * once the books are live (every posting, the bookkeeper's journal entries
 * included, design P7 J4).
 */
export async function ledgerAccountBalances(s: LedgerScope, day: string): Promise<Map<string, string>> {
  const rows = await balancesThrough(s, day)
  return new Map(rows.map(r => [r.accountId, (r.netCents / 100).toFixed(2)]))
}

/** A balance as people read it: debit-normal for assets and expenses, credit-normal for the rest. */
export function normalCents(type: string, netCents: number): number {
  return type === 'asset' || type === 'expense' ? netCents : -netCents
}

export interface BalanceSheet {
  asOf: string
  assets: Array<{ accountId: string; code: string; name: string; balance: number }>
  liabilities: Array<{ accountId: string; code: string; name: string; balance: number }>
  equity: Array<{ accountId: string; code: string; name: string; balance: number }>
  /** Earnings not closed into an equity account: earlier years' (retained earnings, computed) and this year's. */
  earnings: { thisYear: number; earlierYears: number }
  totalAssets: number; totalLiabilities: number; totalEquity: number
  balances: boolean
}

/**
 * The balance sheet as of a day: every asset, liability and equity account's
 * balance, and the earnings — income less expenses — not yet closed into
 * equity, split into earlier years' (retained earnings, never posted, design
 * §5 3030) and this calendar year's. Assets = liabilities + equity whenever
 * every posting balanced (in whole cents).
 */
export async function ledgerBalanceSheet(s: LedgerScope, asOf: string): Promise<BalanceSheet> {
  const day = ymd(asOf)
  const yearStart = `${day.slice(0, 4)}-01-01`
  const [all, earlier] = await Promise.all([
    balancesThrough(s, day),
    balancesThrough(s, prevDay(yearStart)),
  ])
  const shown = (type: string) => all.filter(a => a.type === type && a.netCents !== 0)
    .sort((x, y) => (x.code < y.code ? -1 : 1))
    .map(a => ({ accountId: a.accountId, code: a.code, name: a.name, balance: normalCents(a.type, a.netCents) / 100 }))
  const earningsOf = (list: AccountBalance[]) => list.filter(a => a.type === 'income' || a.type === 'expense')
    .reduce((t, a) => t - a.netCents, 0)
  const totalEarnings = earningsOf(all)
  const earlierEarnings = earningsOf(earlier)
  const assets = shown('asset'), liabilities = shown('liability'), equity = shown('equity')
  const sumC = (list: Array<{ balance: number }>) => list.reduce((t, a) => t + Math.round(a.balance * 100), 0)
  const assetsC = sumC(assets), liabC = sumC(liabilities), equityC = sumC(equity) + totalEarnings
  return {
    asOf: day, assets, liabilities, equity,
    earnings: { thisYear: (totalEarnings - earlierEarnings) / 100, earlierYears: earlierEarnings / 100 },
    totalAssets: assetsC / 100, totalLiabilities: liabC / 100, totalEquity: equityC / 100,
    balances: assetsC === liabC + equityC,
  }
}

function prevDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

export interface TrialBalanceRow {
  accountId: string; code: string; name: string; type: string
  /** Balance at the start (debit-positive), the period's debits and credits, the balance at the end. */
  opening: number; debits: number; credits: number; closing: number
}
export interface TrialBalance {
  period: { start: string; end: string }
  /** 'all' = the whole scope; a property id; 'company' = the company's own lines (on no property). */
  property: string
  rows: TrialBalanceRow[]
  totals: { debits: number; credits: number; closingDebits: number; closingCredits: number }
  /** Debits equal credits in the period, and the closing balances net to zero. */
  balances: boolean
}

/**
 * The trial balance for a period: each account's opening balance, the
 * period's debits and credits, and its closing balance — for the whole scope,
 * one property, or the company's own lines. Every posting balances per
 * property (inter-property clearing included), so each property's trial
 * balance balances on its own.
 */
export async function ledgerTrialBalance(s: LedgerScope, start: string, end: string, property: string = 'all'): Promise<TrialBalance> {
  const params: unknown[] = [ymd(start), ymd(end)]
  const propCond = property === 'all' ? 'TRUE'
    : property === 'company' ? 'l.property_id IS NULL'
    : `l.property_id = ${param(params, property)}::uuid`
  const rows = await query<{ account_id: string; code: string; name: string; type: string; opening: string; dr: string; cr: string }>(
    `SELECT a.id::text AS account_id, a.code, a.name, a.type,
            COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.accounting_date < $1::date), 0)::text AS opening,
            COALESCE(SUM(l.debit) FILTER (WHERE l.accounting_date >= $1::date), 0)::text AS dr,
            COALESCE(SUM(l.credit) FILTER (WHERE l.accounting_date >= $1::date), 0)::text AS cr
       FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
      WHERE l.accounting_date <= $2::date AND ${propCond} AND ${scopeSql(s, params)}
      GROUP BY 1, 2, 3, 4
      ORDER BY a.code, a.name`, params)
  let dr = 0, cr = 0, cdr = 0, ccr = 0
  const out: TrialBalanceRow[] = []
  for (const r of rows) {
    const o = cents(r.opening), d = cents(r.dr), c = cents(r.cr)
    const close = o + d - c
    if (o === 0 && d === 0 && c === 0) continue
    dr += d; cr += c
    if (close > 0) cdr += close; else ccr -= close
    out.push({ accountId: r.account_id, code: r.code, name: r.name, type: r.type, opening: o / 100, debits: d / 100, credits: c / 100, closing: close / 100 })
  }
  return {
    period: { start: ymd(start), end: ymd(end) }, property, rows: out,
    totals: { debits: dr / 100, credits: cr / 100, closingDebits: cdr / 100, closingCredits: ccr / 100 },
    balances: dr === cr && cdr === ccr,
  }
}

export interface GeneralLedgerLine {
  lineId: string; postingId: string; day: string; intendedDay: string
  debit: number; credit: number; balance: number
  memo: string | null; postingMemo: string | null
  propertyId: string | null; propertyName: string | null; tenantName: string | null; vendorName: string | null
  source: { type: string; id: string; label: string }
  /** A reversal of an earlier posting, a superseded posting, or a line moved past a closed month. */
  correction: boolean
}
export interface GeneralLedger {
  account: { id: string; code: string; name: string; type: string }
  period: { start: string; end: string }
  /** The balance before the first day, as people read it (debit-normal for assets and expenses). */
  opening: number
  /** The balance at the end of the last day — the whole period's lines, whichever page is shown. */
  closing: number
  lines: GeneralLedgerLine[]
  /** How many lines the default view folds away (corrections that cancel on the same day). */
  hiddenCorrections: number
  /** 10/12 (Nic, review): the period's lines (as listed: folded corrections left out unless shown) and this page of them. */
  totalLines: number
  offset: number
  limit: number
  /** More lines than this page holds (the page says so and offers the rest). */
  truncated: boolean
}

/**
 * One account's register for a period: every line with a running balance, as
 * people read it (debit-normal for assets and expenses, credit-normal for the
 * rest), each line naming what posted it — the drill-down to its source. By
 * default a superseded posting and the reversal that cancelled it on the SAME
 * day are hidden (they net to zero there, account by account, so the running
 * balance leaves them out too); showCorrections lists them, and every
 * correction that landed on another day is always listed.
 *
 * 10/12 (Nic, review): a busy account (receivables, money GAM holds, the bank)
 * passes thousands of lines in a year. The closing balance is worked out over
 * the whole period in the database, never from the lines of one page; the
 * lines come a page at a time (`offset`, `limit`), each page's running balance
 * starting from every listed line before it, and the reply says how many there
 * are (truncated when this page does not hold them all).
 */
export async function ledgerGeneralLedger(
  s: LedgerScope, accountId: string, start: string, end: string,
  opts: { showCorrections?: boolean; limit?: number; offset?: number } = {},
): Promise<GeneralLedger | null> {
  const acct = (await query<{ id: string; code: string; name: string; type: string; landlord_id: string | null }>(
    `SELECT id::text AS id, code, name, type, landlord_id::text AS landlord_id FROM books_accounts WHERE id = $1`, [accountId]))[0]
  if (!acct || !acct.landlord_id || !s.landlordIds.includes(acct.landlord_id)) return null
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit)) || 2000, 1), 5000)
  const offset = Math.max(Math.trunc(Number(opts.offset)) || 0, 0)
  const show = !!opts.showCorrections
  // The account's lines in the period, each marked when it is half of a
  // same-day correction pair (a superseded posting and its reversal).
  const linesCte = (params: unknown[]) => `
    WITH x AS (
      SELECT l.id, l.posting_id, l.accounting_date, l.intended_date, l.debit, l.credit, l.memo, l.line_no,
             l.property_id, l.tenant_id, l.vendor_id, ps.memo AS posting_memo, ps.posted_at,
             ps.source_type, ps.source_id, ps.role, ps.superseded_at IS NOT NULL AS superseded,
             CASE WHEN ps.role = 'reversal'
                    THEN EXISTS (SELECT 1 FROM ledger_postings o WHERE o.id = ps.reverses_posting_id AND o.accounting_date = ps.accounting_date)
                  WHEN ps.superseded_at IS NOT NULL
                    THEN EXISTS (SELECT 1 FROM ledger_postings r WHERE r.reverses_posting_id = ps.id AND r.accounting_date = ps.accounting_date)
                  ELSE FALSE END AS same_day_pair
        FROM ledger_posting_lines l
        JOIN ledger_postings ps ON ps.id = l.posting_id
       WHERE l.account_id = $1 AND l.accounting_date BETWEEN $2::date AND $3::date AND ${scopeSql(s, params)}),
    v AS (SELECT * FROM x WHERE ${show ? 'TRUE' : 'NOT x.same_day_pair'})`
  const ORDER = 'ORDER BY v.accounting_date, v.posted_at, v.posting_id, v.line_no'
  const openParams: unknown[] = [accountId, ymd(start)]
  const totParams: unknown[] = [accountId, ymd(start), ymd(end)]
  const beforeParams: unknown[] = [accountId, ymd(start), ymd(end)]
  const rowParams: unknown[] = [accountId, ymd(start), ymd(end)]
  const [opening, totals, before, rows] = await Promise.all([
    query<{ n: string }>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS n FROM ledger_posting_lines l
        WHERE l.account_id = $1 AND l.accounting_date < $2::date AND ${scopeSql(s, openParams)}`, openParams),
    query<{ moved: string; listed: number; folded: number }>(
      `${linesCte(totParams)}
       SELECT COALESCE(SUM(x.debit - x.credit), 0)::text AS moved,
              (SELECT count(*)::int FROM v) AS listed,
              count(*) FILTER (WHERE x.same_day_pair)::int AS folded
         FROM x`, totParams),
    offset === 0 ? Promise.resolve([{ n: '0' }]) : query<{ n: string }>(
      `${linesCte(beforeParams)}
       SELECT COALESCE(SUM(p.debit - p.credit), 0)::text AS n
         FROM (SELECT v.debit, v.credit FROM v ${ORDER} LIMIT ${offset}) p`, beforeParams),
    query<{
      id: string; posting_id: string; day: string; intended: string; debit: string; credit: string; memo: string | null
      posting_memo: string | null; property_id: string | null; property_name: string | null; tenant_name: string | null
      vendor_name: string | null; source_type: string; source_id: string; role: string; superseded: boolean
    }>(
      `${linesCte(rowParams)}
       SELECT v.id::text AS id, v.posting_id::text AS posting_id, v.accounting_date::text AS day, v.intended_date::text AS intended,
              v.debit::text AS debit, v.credit::text AS credit, v.memo, v.posting_memo,
              v.property_id::text AS property_id, pr.name AS property_name,
              NULLIF(TRIM(CONCAT_WS(' ', tu.first_name, tu.last_name)), '') AS tenant_name, bv.name AS vendor_name,
              v.source_type, v.source_id, v.role, v.superseded
         FROM v
         LEFT JOIN properties pr ON pr.id = v.property_id
         LEFT JOIN tenants tn ON tn.id = v.tenant_id
         LEFT JOIN users tu ON tu.id = tn.user_id
         LEFT JOIN books_vendors bv ON bv.id = v.vendor_id
        ${ORDER}
        LIMIT ${limit} OFFSET ${offset}`, rowParams),
  ])
  const sign = acct.type === 'asset' || acct.type === 'expense' ? 1 : -1
  const open = cents(opening[0]?.n)
  // Folded pairs net to nothing on their day, so the listed lines carry the
  // whole period's movement either way.
  let run = open + cents(before[0]?.n)
  const lines: GeneralLedgerLine[] = []
  for (const r of rows) {
    const d = cents(r.debit), c = cents(r.credit)
    run += d - c
    lines.push({
      lineId: r.id, postingId: r.posting_id, day: r.day, intendedDay: r.intended,
      debit: d / 100, credit: c / 100, balance: (sign * run) / 100,
      memo: r.memo, postingMemo: r.posting_memo,
      propertyId: r.property_id, propertyName: r.property_name, tenantName: r.tenant_name, vendorName: r.vendor_name,
      source: { type: r.source_type, id: r.source_id, label: LEDGER_SOURCE_TYPE_LABEL[r.source_type as LedgerSourceType] ?? 'An automatic record' },
      correction: r.role === 'reversal' || r.superseded || r.day !== r.intended,
    })
  }
  const totalLines = totals[0]?.listed ?? 0
  return {
    account: { id: acct.id, code: acct.code, name: acct.name, type: acct.type },
    period: { start: ymd(start), end: ymd(end) },
    opening: (sign * open) / 100,
    closing: (sign * (open + cents(totals[0]?.moved))) / 100,
    lines,
    hiddenCorrections: show ? 0 : (totals[0]?.folded ?? 0),
    totalLines, offset, limit,
    truncated: offset + lines.length < totalLines,
  }
}

/**
 * 10/12 (Nic, review): SQL — the posting role a line (alias `l`, its account
 * `a`) books to, '' when none. An automatic line names its role; a hand
 * journal line names its account, so it takes the role that account (or the
 * account it sits under — a bank's own checking account sits under 1010) is
 * mapped from.
 */
function effectiveRoleSql(l: string, a: string): string {
  return `COALESCE(${l}.account_role, (SELECT m.map_value FROM books_account_map m
            WHERE m.map_kind = 'role' AND m.account_id IN (${a}.id, ${a}.parent_account_id)
            ORDER BY (m.account_id = ${a}.id) DESC, m.effective_from DESC, m.id DESC LIMIT 1), '')`
}

/** The posting roles that are cash: the company's bank accounts, its drawer and money on its way into the bank. */
export const CASH_ROLES: readonly LedgerAccountRole[] = [
  'bank_checking', 'bank_savings', 'own_deposit_account', 'undeposited_funds', 'deposits_in_transit', 'stripe_in_transit',
]

const INVESTING_ROLES: readonly string[] = ['rental_property', 'accumulated_depreciation', 'homes_held_for_sale', 'equipment', 'inventory']

/** A cash-flow row's words for the accounts GAM keeps (the rest read by their account's name). */
const CASH_FLOW_ROLE_LABEL: Record<string, string> = {
  ar_tenants: 'Received from tenants',
  due_from_gam: 'Money GAM collected for you',
  due_from_gam_tenant_money: 'Money GAM collected for you',
  due_to_gam: 'GAM fees and charges',
  equipment_owed_to_gam: 'GAM fees and charges',
  tenant_prepayments: 'Paid ahead by tenants',
  security_deposits_payable: 'Deposits',
  deposits_gam_holds: 'Deposits',
  guest_deposits: 'Guest deposits',
  outstanding_checks: 'Checks and bank debits that cleared',
  suspense: 'To classify',
}
const FINANCING_ROLES: readonly string[] = [
  'mortgage_payable', 'credit_card_payable', 'owner_equity', 'owner_draws', 'loan_escrow',
]

export type CashFlowSection = 'operating' | 'investing' | 'financing' | 'opening'
export interface CashFlowRow { section: CashFlowSection; key: string; label: string; amount: number }
export interface CashFlow {
  period: { start: string; end: string }
  openingCash: number
  rows: CashFlowRow[]
  totals: Record<CashFlowSection, number>
  netChange: number
  closingCash: number
}

/**
 * The cash flow statement (direct method) for a period. Cash is the company's
 * bank accounts, its drawer, deposits on their way to the bank and its Stripe
 * balance on the way (CASH_ROLES). Each posting that moved cash is read by its
 * OTHER lines: every non-cash line's (credit − debit) is the cash it brought in
 * or sent out, so the rows always add up to the change in cash. A move between
 * two of the company's own cash accounts has no other line and adds nothing.
 *   operating  income and expenses, tenants, bills, deposits and money GAM
 *              holds, taxes, payroll
 *   investing  property, equipment, homes held for sale, stock
 *   financing  loans, a credit card paid down, the owner's own money in or out
 *   opening    the books' opening balances, when they are dated in the period
 * An expense paid through accounts payable lands by what it was (an owner
 * draw in financing, equipment in investing).
 */
export async function ledgerCashFlow(s: LedgerScope, start: string, end: string): Promise<CashFlow> {
  const params: unknown[] = [ymd(start), ymd(end), CASH_ROLES]
  const sc = scopeSql(s, params)
  // 10/12 (Nic, review): a posting that only CLEARS a check or a bank debit
  // (outstanding checks against the bank, on the bank's day) is read by what
  // it cleared — below — not as "checks that cleared": an owner draw paid by
  // check is still financing, equipment still investing.
  const CLEARING_ONLY = (ps: string) => `NOT EXISTS (
          SELECT 1 FROM ledger_posting_lines o JOIN books_accounts oa ON oa.id = o.account_id WHERE o.posting_id = ${ps}.id
             AND NOT (${effectiveRoleSql('o', 'oa')} = ANY($3::text[]) OR ${effectiveRoleSql('o', 'oa')} IN ('outstanding_checks', 'interproperty_clearing')))`
  // 10/12 (Nic, review): a hand journal line names its account, not a role —
  // a line on the checking account moves cash like any other (effectiveRoleSql).
  const TOUCHES_CASH = `EXISTS (SELECT 1 FROM ledger_posting_lines c JOIN books_accounts ca ON ca.id = c.account_id
                          WHERE c.posting_id = l.posting_id AND ${effectiveRoleSql('c', 'ca')} = ANY($3::text[]))`
  const flows = query<{ source_type: string; role: string | null; account_id: string; name: string; type: string; kind: string | null; amount: string }>(
    `SELECT ps.source_type, NULLIF(${effectiveRoleSql('l', 'a')}, '') AS role, a.id::text AS account_id, a.name, a.type, l.expense_kind AS kind,
            SUM(l.credit - l.debit)::text AS amount
       FROM ledger_posting_lines l
       JOIN ledger_postings ps ON ps.id = l.posting_id
       JOIN books_accounts a ON a.id = l.account_id
      WHERE l.accounting_date BETWEEN $1::date AND $2::date
        AND NOT (${effectiveRoleSql('l', 'a')} = ANY($3::text[]))
        AND ${TOUCHES_CASH}
        AND NOT (${effectiveRoleSql('l', 'a')} = 'outstanding_checks' AND ${CLEARING_ONLY('ps')})
        AND ${sc}
      GROUP BY 1, 2, 3, 4, 5, 6 HAVING SUM(l.credit - l.debit) <> 0`, params)
  const clearParams: unknown[] = [ymd(start), ymd(end), CASH_ROLES]
  const clearings = query<{ posting_id: string; landlord_id: string; property_id: string | null; main_type: string | null; main_id: string | null; amount: string }>(
    `SELECT ps.id::text AS posting_id, l.landlord_id::text AS landlord_id, l.property_id::text AS property_id,
            CASE WHEN ps.posting_kind = 'bank_clear' THEN ps.source_type
                 WHEN ps.source_type = 'bank_match' THEN bt.matched_kind END AS main_type,
            CASE WHEN ps.posting_kind = 'bank_clear' THEN ps.source_id
                 WHEN ps.source_type = 'bank_match' THEN COALESCE(bt.matched_gam_debit_id, bt.matched_pos_refund_id, bt.matched_refund_part_id)::text END AS main_id,
            SUM(l.credit - l.debit)::text AS amount
       FROM ledger_posting_lines l
       JOIN ledger_postings ps ON ps.id = l.posting_id
       LEFT JOIN bank_transactions bt ON ps.source_type = 'bank_match' AND bt.id::text = ps.source_id
      WHERE l.accounting_date BETWEEN $1::date AND $2::date AND l.account_role = 'outstanding_checks'
        AND ${TOUCHES_CASH}
        AND ${CLEARING_ONLY('ps')}
        AND ${scopeSql(s, clearParams)}
      GROUP BY 1, 2, 3, 4, 5 HAVING SUM(l.credit - l.debit) <> 0`, clearParams)
  const cashParams: unknown[] = [ymd(start), ymd(end), CASH_ROLES]
  const cash = query<{ opening: string; closing: string }>(
    `SELECT COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.accounting_date < $1::date), 0)::text AS opening,
            COALESCE(SUM(l.debit - l.credit), 0)::text AS closing
       FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
      WHERE l.accounting_date <= $2::date AND ${effectiveRoleSql('l', 'a')} = ANY($3::text[]) AND ${scopeSql(s, cashParams)}`, cashParams)
  const [rows, clears, c] = await Promise.all([flows, clearings, cash])
  // What each cleared record paid for: its own posting's lines other than the
  // check (and cash, and the clearing between properties), by property.
  // 10/13 (Nic): never its taking-back (posting kind 'cancellation': a GAM fee
  // pull the landlord's bank later disputed, ledgerProjectors/payoutGamCharges)
  // — that posting is the money coming back, not what the bank line paid, and
  // read with it the pull's GAM charges would net to nothing and the line would
  // fall back to "checks and bank debits that cleared", in a month already shown.
  type Paid = { role: string | null; account_id: string; name: string; type: string; kind: string | null; property_id: string | null; cents: number }
  const mains = new Map<string, Paid[]>()
  const keys = [...new Set(clears.filter(x => x.main_type && x.main_id).map(x => `${x.landlord_id}|${x.main_type}|${x.main_id}`))]
  if (keys.length) {
    const ml = await query<{ k: string; role: string | null; account_id: string; name: string; type: string; kind: string | null; property_id: string | null; amount: string }>(
      `SELECT ps.landlord_id::text || '|' || ps.source_type || '|' || ps.source_id AS k, l.account_role AS role,
              a.id::text AS account_id, a.name, a.type, l.expense_kind AS kind, l.property_id::text AS property_id,
              SUM(l.credit - l.debit)::text AS amount
         FROM ledger_postings ps
         JOIN ledger_posting_lines l ON l.posting_id = ps.id
         JOIN books_accounts a ON a.id = l.account_id
        WHERE ps.landlord_id::text || '|' || ps.source_type || '|' || ps.source_id = ANY($1::text[])
          AND ps.role = 'post' AND ps.superseded_at IS NULL
          AND ps.posting_kind IS DISTINCT FROM 'bank_clear' AND ps.posting_kind IS DISTINCT FROM 'cancellation'
          AND NOT (${effectiveRoleSql('l', 'a')} = ANY($2::text[]) OR ${effectiveRoleSql('l', 'a')} IN ('outstanding_checks', 'interproperty_clearing'))
        GROUP BY 1, 2, 3, 4, 5, 6, 7 HAVING SUM(l.credit - l.debit) <> 0`, [keys, CASH_ROLES])
    for (const r of ml) {
      const list = mains.get(r.k) ?? []
      list.push({ ...r, cents: cents(r.amount) })
      mains.set(r.k, list)
    }
  }
  const flowRows: Array<{ source_type: string; role: string | null; account_id: string; name: string; type: string; kind: string | null; cents: number }> =
    rows.map(r => ({ ...r, cents: cents(r.amount) }))
  for (const x of clears) {
    const amt = cents(x.amount)
    const all = x.main_type && x.main_id ? mains.get(`${x.landlord_id}|${x.main_type}|${x.main_id}`) ?? [] : []
    const here = all.filter(m => m.property_id === x.property_id)
    const parts = here.length ? here : all
    // Split by what it paid for when those all point the same way; otherwise
    // (or when the record is gone) it stays "checks and bank debits that cleared".
    const sameWay = parts.length > 0 && (parts.every(m => m.cents > 0) || parts.every(m => m.cents < 0))
    if (!sameWay) {
      flowRows.push({ source_type: 'bank_clear', role: 'outstanding_checks', account_id: '', name: CASH_FLOW_ROLE_LABEL.outstanding_checks, type: 'liability', kind: null, cents: amt })
      continue
    }
    const split = splitBy(amt, parts.map(m => Math.abs(m.cents)))
    parts.forEach((m, i) => {
      if (split[i]) flowRows.push({ source_type: x.main_type!, role: m.role, account_id: m.account_id, name: m.name, type: m.type, kind: m.kind, cents: split[i] })
    })
  }
  const by = new Map<string, CashFlowRow & { c: number }>()
  for (const r of flowRows) {
    let section: CashFlowSection = 'operating'
    let key = r.role ?? r.account_id
    let label = (r.role && CASH_FLOW_ROLE_LABEL[r.role]) || r.name
    if (r.role && CASH_FLOW_ROLE_LABEL[r.role]) key = CASH_FLOW_ROLE_LABEL[r.role]
    if (r.source_type === 'opening') { section = 'opening'; key = 'opening'; label = 'Opening balances' }
    else if (r.role === 'accounts_payable') {
      section = r.kind === 'equity' ? 'financing' : r.kind === 'asset' ? 'investing' : 'operating'
      key = `ap:${r.kind ?? 'expense'}`
      label = r.kind === 'equity' ? 'Owner draws and money taken out' : r.kind === 'asset' ? 'Purchases of property and equipment'
        : r.kind === 'liability' ? 'Payroll, taxes and loans paid' : 'Expenses paid'
    } else if (r.role && INVESTING_ROLES.includes(r.role)) section = 'investing'
    else if (r.role && FINANCING_ROLES.includes(r.role)) section = 'financing'
    else if (r.type === 'equity') section = 'financing'
    const k = `${section}|${key}`
    const x = by.get(k) ?? { section, key, label, amount: 0, c: 0 }
    x.c += r.cents
    by.set(k, x)
  }
  const order: CashFlowSection[] = ['operating', 'investing', 'financing', 'opening']
  const out = [...by.values()].filter(x => x.c !== 0)
    .sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || (a.label < b.label ? -1 : 1))
  const totals: Record<CashFlowSection, number> = { operating: 0, investing: 0, financing: 0, opening: 0 }
  for (const x of out) totals[x.section] += x.c
  const openingCash = cents(c[0]?.opening), closingCash = cents(c[0]?.closing)
  return {
    period: { start: ymd(start), end: ymd(end) },
    openingCash: openingCash / 100,
    rows: out.map(x => ({ section: x.section, key: x.key, label: x.label, amount: x.c / 100 })),
    totals: { operating: totals.operating / 100, investing: totals.investing / 100, financing: totals.financing / 100, opening: totals.opening / 100 },
    netChange: (closingCash - openingCash) / 100,
    closingCash: closingCash / 100,
  }
}

export interface MoneyOutRow { key: string; label: string; incurred: number; paid: number; unpaid: number }
export interface MoneyOut {
  period: { start: string; end: string }
  /** By category: incurred in the period, paid in the period, still unpaid at its end. */
  rows: MoneyOutRow[]
  /** Money paid out that is not a cost (owner draws, loan principal, taxes, payroll take-home), by kind. */
  notExpenses: Array<{ kind: string; label: string; paid: number }>
  /** Bills still unpaid at the end, by vendor. */
  unpaidByVendor: Array<{ vendorId: string | null; name: string; unpaid: number }>
  totals: { incurred: number; paid: number; unpaid: number }
}

const NOT_EXPENSE_KIND_LABEL: Record<string, string> = {
  equity: 'Owner draws and money taken out', liability: 'Payroll, taxes and loans paid down',
  asset: 'Purchases of property and equipment', income: 'Refunds of money received',
}

/**
 * Money out (design §10): Incurred (each expense account's lines dated in the
 * period; an expense on the Expenses record under its company's own category),
 * Paid (the P&L's Received-based expenses), Unpaid (accounts payable at the
 * period's end, by the bill's category and by vendor), and the money paid out
 * that is not a cost at all, by its kind.
 */
export async function ledgerMoneyOut(s: LedgerScope, start: string, end: string): Promise<MoneyOut> {
  const rows = await ledgerExpenseRows(s, start, end)
  const params: unknown[] = [ymd(end)]
  const sc = scopeSql(s, params)
  const apRows = query<{ category: string | null; account: string | null; vendor_id: string | null; vendor: string | null; n: string }>(
    `WITH ap AS (
       SELECT CASE ps.source_type WHEN 'expense' THEN ps.source_id
                                  WHEN 'expense_payment' THEN (SELECT ep.expense_id::text FROM landlord_expense_payments ep WHERE ep.id::text = ps.source_id)
              END AS expense_id,
              l.vendor_id, l.credit - l.debit AS amt
         FROM ledger_posting_lines l JOIN ledger_postings ps ON ps.id = l.posting_id
        WHERE l.account_role = 'accounts_payable' AND l.accounting_date <= $1::date AND ${sc})
     SELECT bc.name AS category, ba.name AS account, ap.vendor_id::text AS vendor_id, bv.name AS vendor,
            SUM(ap.amt)::text AS n
       FROM ap
       LEFT JOIN landlord_expenses e ON e.id::text = ap.expense_id
       LEFT JOIN books_categories bc ON bc.id = e.category_id
       LEFT JOIN books_accounts ba ON ba.id = books_category_account(e.category_id, e.expense_date)
       LEFT JOIN books_vendors bv ON bv.id = ap.vendor_id
      GROUP BY 1, 2, 3, 4 HAVING SUM(ap.amt) <> 0`, params)
  const kindParams: unknown[] = [ymd(start), ymd(end)]
  const kinds = query<{ kind: string; n: string }>(
    `SELECT l.expense_kind AS kind, SUM(l.debit - l.credit)::text AS n FROM ledger_posting_lines l
      WHERE l.cash_effect = 'out' AND l.expense_kind IS NOT NULL AND l.expense_kind <> 'expense'
        AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, kindParams)}
      GROUP BY 1 HAVING SUM(l.debit - l.credit) <> 0`, kindParams)
  const incurredByCategory = await categoryNamesForExpenseLines(s, start, end)
  const [ap, k] = await Promise.all([apRows, kinds])

  const by = new Map<string, { label: string; incurred: number; paid: number; unpaid: number }>()
  const slot = (label: string) => {
    let x = by.get(label)
    if (!x) { x = { label, incurred: 0, paid: 0, unpaid: 0 }; by.set(label, x) }
    return x
  }
  // Incurred and paid by account; an account a category charges to takes the category's name.
  for (const r of rows) {
    const label = incurredByCategory.get(r.accountId) ?? r.name
    const x = slot(label)
    x.incurred += r.incurredCents
    x.paid += r.paidCents
  }
  const vendors = new Map<string, { vendorId: string | null; name: string; unpaid: number }>()
  for (const r of ap) {
    const c = cents(r.n)
    slot(r.category ?? r.account ?? 'Bills owed').unpaid += c
    const vk = r.vendor_id ?? ''
    const v = vendors.get(vk) ?? { vendorId: r.vendor_id, name: r.vendor ?? 'No vendor named', unpaid: 0 }
    v.unpaid += c
    vendors.set(vk, v)
  }
  const list = [...by.values()].filter(x => x.incurred || x.paid || x.unpaid).sort((a, b) => (a.label < b.label ? -1 : 1))
  const tot = list.reduce((t, x) => ({ incurred: t.incurred + x.incurred, paid: t.paid + x.paid, unpaid: t.unpaid + x.unpaid }), { incurred: 0, paid: 0, unpaid: 0 })
  return {
    period: { start: ymd(start), end: ymd(end) },
    rows: list.map(x => ({ key: x.label, label: x.label, incurred: x.incurred / 100, paid: x.paid / 100, unpaid: x.unpaid / 100 })),
    notExpenses: k.map(r => ({ kind: r.kind, label: NOT_EXPENSE_KIND_LABEL[r.kind] ?? 'Other money out', paid: round2(Number(r.n)) })),
    unpaidByVendor: [...vendors.values()].filter(v => v.unpaid !== 0).sort((a, b) => b.unpaid - a.unpaid)
      .map(v => ({ ...v, unpaid: v.unpaid / 100 })),
    totals: { incurred: tot.incurred / 100, paid: tot.paid / 100, unpaid: tot.unpaid / 100 },
  }
}

/** The category name of the expense accounts one company category charges to (one name per account, the first). */
async function categoryNamesForExpenseLines(s: LedgerScope, start: string, end: string): Promise<Map<string, string>> {
  const params: unknown[] = [ymd(start), ymd(end)]
  const rows = await query<{ account_id: string; name: string }>(
    `SELECT DISTINCT ON (l.account_id) l.account_id::text AS account_id, bc.name
       FROM ledger_posting_lines l
       JOIN books_categories bc ON l.map_kind = 'expense_category' AND bc.id::text = l.map_value
      WHERE l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, params)}
      ORDER BY l.account_id, bc.name`, params)
  // An account more than one category charges to keeps its own name.
  const count = await query<{ account_id: string; n: number }>(
    `SELECT l.account_id::text AS account_id, COUNT(DISTINCT l.map_value)::int AS n FROM ledger_posting_lines l
      WHERE l.map_kind = 'expense_category' AND l.landlord_id = ANY($1::uuid[]) GROUP BY 1`, [[...s.landlordIds]])
  const many = new Set(count.filter(c => c.n > 1).map(c => c.account_id))
  return new Map(rows.filter(r => !many.has(r.account_id)).map(r => [r.account_id, r.name]))
}

export interface TaxSummaryRow { accountId: string; code: string; name: string; taxName: string | null; collected: number; paid: number; owedAtEnd: number }

/**
 * Taxes for a period from the liability accounts that hold them (sales,
 * lodging and utility tax, payroll withholding and payroll taxes): collected
 * (credits), paid to the government (debits) and what is still owed at the
 * period's end. GAM shows them; it does not file them (design §19).
 *
 * 10/12 (Nic, review): tax given back to a customer — a register refund, a
 * chargeback on a sale or a stay — debits the tax account as money in taken
 * back (cash effect 'in' / tax collected); it comes off Collected and is never
 * "paid to the government". A reversal undoes what its original was: its
 * debits take back a collection, its credits take back a payment (or a
 * give-back).
 */
export async function ledgerTaxSummary(s: LedgerScope, start: string, end: string): Promise<{ rows: TaxSummaryRow[]; totals: { collected: number; paid: number; owedAtEnd: number } }> {
  const roles = ['sales_tax_payable', 'lodging_tax_payable', 'utility_tax_payable', 'payroll_liabilities',
    'payroll_federal_withholding', 'payroll_state_withholding', 'payroll_fica', 'payroll_futa', 'payroll_suta']
  const params: unknown[] = [ymd(start), ymd(end), roles]
  const rows = await query<{ account_id: string; code: string; name: string; tax_name: string | null; cr: string; dr: string; bal: string }>(
    `WITH x AS (
       SELECT a.id AS account_id, a.code, a.name, l.tax_name, l.accounting_date, l.debit, l.credit, ps.role = 'reversal' AS undo,
              (l.cash_effect = 'in' OR l.report_category = 'tax_collected') AS taken_in
         FROM ledger_posting_lines l
         JOIN books_accounts a ON a.id = l.account_id
         JOIN ledger_postings ps ON ps.id = l.posting_id
        WHERE l.account_role = ANY($3::text[]) AND l.accounting_date <= $2::date AND ${scopeSql(s, params)})
     SELECT x.account_id::text AS account_id, x.code, x.name, x.tax_name,
            COALESCE(SUM(CASE WHEN x.undo THEN (CASE WHEN x.taken_in THEN x.credit ELSE 0 END) - x.debit
                              ELSE x.credit - (CASE WHEN x.taken_in THEN x.debit ELSE 0 END) END)
                       FILTER (WHERE x.accounting_date >= $1::date), 0)::text AS cr,
            COALESCE(SUM(CASE WHEN x.undo THEN -(CASE WHEN x.taken_in THEN 0 ELSE x.credit END)
                              ELSE (CASE WHEN x.taken_in THEN 0 ELSE x.debit END) END)
                       FILTER (WHERE x.accounting_date >= $1::date), 0)::text AS dr,
            SUM(x.credit - x.debit)::text AS bal
       FROM x
      GROUP BY 1, 2, 3, 4 ORDER BY x.code, x.tax_name`, params)
  const out = rows.map(r => ({
    accountId: r.account_id, code: r.code, name: r.name, taxName: r.tax_name,
    collected: round2(Number(r.cr)), paid: round2(Number(r.dr)), owedAtEnd: round2(Number(r.bal)),
  })).filter(r => r.collected || r.paid || r.owedAtEnd)
  return {
    rows: out,
    totals: {
      collected: round2(out.reduce((t, r) => t + r.collected, 0)),
      paid: round2(out.reduce((t, r) => t + r.paid, 0)),
      owedAtEnd: round2(out.reduce((t, r) => t + r.owedAtEnd, 0)),
    },
  }
}

// ─── The Profit and Loss ────────────────────────────────────────────────────

export interface LedgerProfitAndLoss {
  source: 'ledger'
  period: { start: string; end: string; label: string }
  /** Nic 10/12 (L2): Received leads. */
  lead: 'received'
  /** Income by category in the three columns, with the proof strip (view.proof, view.tieText). */
  view: MoneyView
  /** Each income account's Charged figure (an accountant's view of the same money). */
  incomeAccounts: Array<{ accountId: string; code: string; name: string; charged: number }>
  /**
   * Billed to tenants beside Charged, never in it (design §10): deposits (owed
   * back), a home sale's principal (it pays down the note), tax (owed to the
   * government) and balances carried from before GAM (opening equity).
   */
  chargedBeside: Array<{ key: string; label: string; amount: number }>
  /** Each expense account: paid in the period (Received-based) and incurred (Charged-based). */
  expenses: { rows: Array<{ accountId: string; code: string; name: string; paid: number; incurred: number }>; paid: number; incurred: number }
  /**
   * Design §13: what belongs to an earlier, closed month but was posted in this
   * period (the first open day) — "Corrections to September, posted in
   * October". Already inside the figures above; listed so a reader sees it.
   */
  corrections: Array<{ month: string; received: number; charged: number; expensesIncurred: number }>
  /** Received less expenses paid; Charged less expenses incurred. */
  nets: { received: number; charged: number }
}

const CHARGED_BESIDE_KEY: Record<string, string> = {
  security_deposits_payable: 'depositsBilled', home_notes_receivable: 'homePrincipalBilled',
  sales_tax_payable: 'taxBilled', lodging_tax_payable: 'taxBilled', utility_tax_payable: 'taxBilled',
  opening_balance_equity: 'openingBalancesBilled',
}
const CHARGED_BESIDE_LABEL: Record<string, string> = {
  depositsBilled: 'Deposits billed (held for tenants, never income)',
  homePrincipalBilled: 'Home-sale principal billed (pays down the note)',
  taxBilled: 'Tax billed (owed to the government)',
  openingBalancesBilled: 'Balances from before GAM billed',
  other: 'Other money billed that is not income',
}

/**
 * The P&L from the ledger (design §10): income in Received, Charged and Owed
 * by category with the proof strip; expenses by account, paid (the
 * Received-based column) and incurred (the Charged-based column); the net on
 * each money column, Received first (Nic L2).
 */
export async function ledgerProfitAndLoss(s: LedgerScope, start: string, end: string, label: string): Promise<LedgerProfitAndLoss> {
  const q = { landlordIds: [...s.landlordIds], start: ymd(start), end: ymd(end), propertyIds: s.propertyIds ? [...s.propertyIds] : null, cutoffs: s.cutoffs ?? null }
  const params: unknown[] = [ymd(start), ymd(end)]
  const [received, charged, paidAhead, expenseRows, incomeAccounts] = await Promise.all([
    ledgerIncomeEvents({ ...q, basis: 'received' }),
    ledgerIncomeEvents({ ...q, basis: 'billed' }),
    ledgerPaidAheadUnusedAt(q),
    ledgerExpenseRows(s, start, end),
    query<{ account_id: string; code: string; name: string; n: string }>(
      `SELECT a.id::text AS account_id, a.code, a.name, SUM(l.credit - l.debit)::text AS n
         FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
        WHERE a.type = 'income' AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, params)}
        GROUP BY 1, 2, 3 HAVING SUM(l.credit - l.debit) <> 0 ORDER BY a.code, a.name`, params),
  ])
  const view = moneyViewFrom(charged, received, { start: ymd(start), end: ymd(end), label }, paidAhead)
  const ex = plExpensesFromRows(expenseRows)
  const besideParams: unknown[] = [ymd(start), ymd(end)]
  const beside = await query<{ role: string; n: string }>(
    `SELECT l.account_role AS role, SUM(l.credit - l.debit)::text AS n
       FROM ledger_posting_lines l
       JOIN ledger_postings ps ON ps.id = l.posting_id AND ps.posting_kind = 'charge'
       JOIN books_accounts a ON a.id = l.account_id AND a.type <> 'income'
      WHERE l.account_role IN ('security_deposits_payable', 'home_notes_receivable', 'sales_tax_payable', 'lodging_tax_payable',
                               'utility_tax_payable', 'opening_balance_equity')
        AND l.accounting_date BETWEEN $1::date AND $2::date AND ${scopeSql(s, besideParams)}
      GROUP BY 1 HAVING SUM(l.credit - l.debit) <> 0`, besideParams)
  const besideBy = new Map<string, { key: string; label: string; amount: number }>()
  for (const r of beside) {
    const k = CHARGED_BESIDE_KEY[r.role] ?? 'other'
    const x = besideBy.get(k) ?? { key: k, label: CHARGED_BESIDE_LABEL[k], amount: 0 }
    x.amount = round2(x.amount + Number(r.n))
    besideBy.set(k, x)
  }
  const corrParams: unknown[] = [ymd(start), ymd(end)]
  const corr = await query<{ m: string; rec: string; chg: string; exp: string }>(
    `SELECT to_char(l.intended_date, 'YYYY-MM') AS m,
            COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.cash_effect = 'in'
              AND COALESCE(l.report_category, '') NOT IN ('deposits', 'tax_collected', 'not_income')), 0)::text AS rec,
            COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a.type = 'income'), 0)::text AS chg,
            COALESCE(SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0)::text AS exp
       FROM ledger_posting_lines l JOIN books_accounts a ON a.id = l.account_id
      WHERE l.accounting_date BETWEEN $1::date AND $2::date AND l.intended_date < $1::date
        AND date_trunc('month', l.intended_date) < date_trunc('month', l.accounting_date)
        AND ${scopeSql(s, corrParams)}
      GROUP BY 1 ORDER BY 1`, corrParams)
  return {
    source: 'ledger',
    period: { start: ymd(start), end: ymd(end), label },
    lead: 'received',
    view,
    corrections: corr.map(c => ({ month: c.m, received: round2(Number(c.rec)), charged: round2(Number(c.chg)), expensesIncurred: round2(Number(c.exp)) }))
      .filter(c => c.received || c.charged || c.expensesIncurred),
    chargedBeside: [...besideBy.values()].filter(b => b.amount !== 0),
    incomeAccounts: incomeAccounts.map(r => ({ accountId: r.account_id, code: r.code, name: r.name, charged: round2(Number(r.n)) })),
    expenses: {
      rows: ex.byAccount.map(a => ({ accountId: a.accountId, code: a.code, name: a.name, paid: a.paid, incurred: a.incurred })),
      paid: ex.cashTotal, incurred: ex.total,
    },
    nets: { received: round2(view.received - ex.cashTotal), charged: round2(view.charged - ex.total) },
  }
}

// ─── Owed: by household, with aging ─────────────────────────────────────────

export const AGING_BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const
export type AgingBucket = typeof AGING_BUCKETS[number]
export const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  current: 'Not due yet or due today',
  days1to30: '1–30 days late',
  days31to60: '31–60 days late',
  days61to90: '61–90 days late',
  over90: 'Over 90 days late',
}

export interface ReceivablesRow {
  tenantId: string | null; tenantName: string | null; propertyId: string | null; propertyName: string | null
  total: number; buckets: Record<AgingBucket, number>
}

/** The age of an amount owed on a bill due `due`, as of `asOf` ('YYYY-MM-DD'). */
export function agingBucketOf(due: string | null, asOf: string): AgingBucket {
  if (!due || due >= asOf) return 'current'
  const days = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000)
  return days <= 30 ? 'days1to30' : days <= 60 ? 'days31to60' : days <= 90 ? 'days61to90' : 'over90'
}

/**
 * What tenants owed at the end of a day (the receivables, 1100), by household
 * — the tenant and the company — and property, each bill's open amount aged
 * by its due date (design §10 "Owed … by household, category and property,
 * with aging by payment_id"). A line with no bill behind it (an opening
 * balance) is aged from the day it posted.
 */
export async function ledgerReceivables(s: LedgerScope, asOf: string): Promise<{
  asOf: string; rows: ReceivablesRow[]; totals: { total: number; buckets: Record<AgingBucket, number> }
}> {
  const params: unknown[] = [ymd(asOf)]
  const rows = await query<{ tenant_id: string | null; tenant_name: string | null; property_id: string | null; property_name: string | null; due: string | null; n: string }>(
    `SELECT l.tenant_id::text AS tenant_id, NULLIF(TRIM(CONCAT_WS(' ', tu.first_name, tu.last_name)), '') AS tenant_name,
            l.property_id::text AS property_id, pr.name AS property_name,
            COALESCE(pay.due_date, MIN(l.intended_date))::text AS due, SUM(l.debit - l.credit)::text AS n
       FROM ledger_posting_lines l
       LEFT JOIN payments pay ON pay.id = l.payment_id
       LEFT JOIN properties pr ON pr.id = l.property_id
       LEFT JOIN tenants tn ON tn.id = l.tenant_id
       LEFT JOIN users tu ON tu.id = tn.user_id
      WHERE l.account_role = 'ar_tenants' AND l.accounting_date <= $1::date AND ${scopeSql(s, params)}
      GROUP BY l.tenant_id, tu.first_name, tu.last_name, l.property_id, pr.name, l.payment_id, pay.due_date
     HAVING SUM(l.debit - l.credit) <> 0`, params)
  const zero = (): Record<AgingBucket, number> => ({ current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 })
  const by = new Map<string, ReceivablesRow & { c: Record<AgingBucket, number> }>()
  const totC = zero()
  for (const r of rows) {
    const k = `${r.tenant_id ?? ''}|${r.property_id ?? ''}`
    const x = by.get(k) ?? { tenantId: r.tenant_id, tenantName: r.tenant_name, propertyId: r.property_id, propertyName: r.property_name, total: 0, buckets: zero(), c: zero() }
    const b = agingBucketOf(r.due, ymd(asOf))
    const c = cents(r.n)
    x.c[b] += c
    totC[b] += c
    by.set(k, x)
  }
  const fromC = (c: Record<AgingBucket, number>) =>
    Object.fromEntries(AGING_BUCKETS.map(b => [b, c[b] / 100])) as Record<AgingBucket, number>
  const sumC = (c: Record<AgingBucket, number>) => AGING_BUCKETS.reduce((t, b) => t + c[b], 0)
  const out = [...by.values()]
    .filter(x => sumC(x.c) !== 0)
    .map(x => ({ tenantId: x.tenantId, tenantName: x.tenantName, propertyId: x.propertyId, propertyName: x.propertyName,
      total: sumC(x.c) / 100, buckets: fromC(x.c) }))
    .sort((a, b) => b.total - a.total || String(a.tenantName).localeCompare(String(b.tenantName)))
  return { asOf: ymd(asOf), rows: out, totals: { total: sumC(totC) / 100, buckets: fromC(totC) } }
}

/** The role's seeded name (when an account has none to show). */
export function roleName(role: string | null | undefined): string | null {
  return role ? LEDGER_ACCOUNT_ROLE_BY_NAME[role as LedgerAccountRole]?.name ?? null : null
}

/** INCOME_CATEGORY_LABEL, re-exported for the Books statements. */
export const LEDGER_INCOME_CATEGORY_LABEL = INCOME_CATEGORY_LABEL

/** The basis a ledger read stands for (Received or Charged), for callers that pass one. */
export type LedgerColumnBasis = IncomeBasis

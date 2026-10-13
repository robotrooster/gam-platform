import { Router } from 'express'
// 10/12 (Nic, ledger P6, L5): which expenses count as a cost, and a repair's cost once (lib/liveExpense).
import { liveExpenseSql, maintenanceCostNotBilledSql } from '../lib/liveExpense'
import { z } from 'zod'
import { collectedRentMtd, incomeCardFrom } from '../lib/rentCollected'
import {
  occupancyRateFrom, INCOME_CATEGORY_LABEL, MANUAL_PAYMENT_METHOD_LABELS, MAINTENANCE_CATEGORY_LABEL,
  MONEY_COLUMNS, MONEY_COLUMN_LABEL, MONEY_COLUMN_NOTE, MONEY_COLUMN_NOTE_LEDGER, MONTHLY_REPORT_MAX_EXTRA_EMAILS,
  type IncomeBasis, type MaintenanceCategory,
} from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm, getScopedPropertyIds, bookkeeperRequestScopeOf, propertyCutoffsOf } from '../middleware/auth'
import { companyWideRefusal, cutoffsParam, withinCutoffsSql, MONTHLY_REPORT_REFUSAL, type PropertyCutoff } from '../lib/bookkeeperScope'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { landlordScopeIds, resolveLandlordTarget, isEntityMember } from '../lib/landlordScope'
import { platformFeesByPropertyForEntities, periodMonths } from '../services/platformFee'
import {
  landlordPLExpenses, landlordPLFrom, enteredExpensesByDay, landlordIncomeSql, landlordDepositSql, processingFeesByProperty,
} from '../services/landlordPL'
import { seesGrandTotals } from '../services/openBalances'
import {
  incomeBoth, summarize, byMonth, breakdownFrom, partList, moneyViewFrom, monthWords, cardFeesRefundedByProperty,
  type IncomeEvent, type MoneyView,
} from '../services/incomeBasis'
import { householdMonths, householdOfRowSql } from '../services/householdMonths'
// 10/12 (Nic, ledger P8): whether a viewer's reports read the books.
import { ledgerReportsLive, ledgerPLExpensesByProperty, type LedgerPLExpenses } from '../services/ledgerReports'
import {
  buildMonthlyPropertyReport, monthBounds, previousMonth, companyTeam, recipientsOf, saveRecipients, lastSends,
} from '../services/monthlyPropertyReport'
import { renderMonthlyReportPdf, monthlyReportFilename } from '../services/monthlyReportPdf'
import { todayIn, addDaysTo, monthStartOf, localDateTimeToUtc } from '../lib/timezone'
import {
  runReport, REPORT_LEVELS, REPORT_BUCKETS,
  type ReportLevel, type ReportBucket, type ReportRow,
} from '../services/reportEngine'

export const reportsRouter = Router()
// S127: blanket requireLandlord lifted in favor of per-route perm gates.
// All reports require auth; specific perms gate per endpoint below.
// Owners auto-pass requirePerm via OWNER_ROLES short-circuit.
reportsRouter.use(requireAuth)

// 10/11 (Nic): the Reports page is one of the financial pages GAM Books shows
// too (apps/{landlord,books}/src/financials). Books has ONE company open at a
// time and names it with X-Client-Id; an owner's reports there read that
// company, the way every other Books page does. The landlord portal sends no
// header and keeps reading every company the account owns. (A bookkeeper's
// company is already pinned by requireAuth.)
reportsRouter.use(async (req: any, _res, next) => {
  try {
    const header = req.headers?.['x-client-id']
    const named = Array.isArray(header) ? header[0] : header
    if (req.user?.role === 'landlord' && named) {
      if (!/^[0-9a-f-]{36}$/i.test(String(named)) || !(await isEntityMember(req.user, String(named), query))) {
        throw new AppError(403, 'That company is not yours.')
      }
      req.user = { ...req.user, landlordIds: [String(named)] }
    }
    next()
  } catch (e) { next(e) }
})

// S654: report periods follow GAM's home calendar — Phoenix, the zone
// todayIn(null) reads and the database's CURRENT_DATE uses — never the UTC
// date, which turns over at 5 pm here.
// S655: income itself is dated on each PROPERTY's own calendar day
// (services/incomeBasis); these bounds are the days of the period.
const REPORT_TZ = 'America/Phoenix'

/**
 * 10/12 (Nic): "NO Money received / Money billed toggle anywhere — show
 * Charged, Received and Owed side by side as columns, with a short line
 * showing how they tie." Every report below returns the three columns (`view`
 * / `charged`, `received`, `owed`) and the tie line, from both kinds of facts
 * (services/incomeBasis). ?basis= is accepted for one release and IGNORED; the
 * fields that carried one basis (gross, lines, net, collected...) are Money
 * received — the old default — for the callers that still read them.
 */
const LEGACY_BASIS: IncomeBasis = 'received'

/**
 * decisions #25 (Nic, 10/3): "front desk / on-site staff never see a GRAND
 * TOTAL of what everyone owes ... (omitted server-side for everyone else, not
 * just hidden)." The Owed column of a report IS such a total — what is still
 * owed of every household's bills in the period — so for a viewer who sees no
 * grand totals (services/openBalances seesGrandTotals: owners, property
 * managers and bookkeepers do) it is left out of the reply, together with what
 * it can be worked back from: Charged's split into collected / clearing /
 * other (collected + clearing + owed + other = charged) and the tie line that
 * says it in words. Charged, Received and the nets stay — they are not what
 * anyone owes. The screens print "—" where a figure is absent.
 */
function dropOwed<T extends { owed: number }>(x: T): Omit<T, 'owed'> {
  const { owed: _owed, ...rest } = x
  return rest
}

/** A report's three columns as this viewer may see them (decisions #25). */
export function viewForViewer(view: MoneyView, seesTotals: boolean) {
  if (seesTotals) return view
  // 10/12 (Nic, ledger P8): the ledger's proof strip starts and ends on what
  // is owed, so it goes with the Owed column.
  const { owed: _owed, collected: _collected, clearing: _clearing, tie, tieText, lines, categories, uncategorized, proof: _proof, ...rest } = view
  return {
    ...rest,
    lines: lines.map(dropOwed),
    categories: categories.map(dropOwed),
    uncategorized: uncategorized.map(dropOwed),
    tie: { received: tie.received, stillClearing: tie.stillClearing },
    // moneyTieText: the second line is what became of what was charged (it
    // names what is still owed); the first says what the money received was
    // for (10/12, Nic: Received leads), and a third, when there is one, what
    // is still clearing.
    tieText: tieText.filter((_, i) => i !== 1),
  }
}

/** A report-engine row as this viewer may see it: no Owed (decisions #25). */
function engineRowForViewer(r: ReportRow, seesTotals: boolean) {
  return seesTotals ? r : { ...r, money: dropOwed(r.money) }
}

/** What each report says about its columns (meta.columns). */
const MONEY_META = {
  columns: MONEY_COLUMNS.map(c => ({ key: c, label: MONEY_COLUMN_LABEL[c], note: MONEY_COLUMN_NOTE[c] })),
}
/** 10/12 (Nic, ledger P8): the same, once the report reads the company's books (Owed at the period's end). */
const LEDGER_MONEY_META = {
  columns: MONEY_COLUMNS.map(c => ({ key: c, label: MONEY_COLUMN_LABEL[c], note: MONEY_COLUMN_NOTE_LEDGER[c] })),
}

/** S654: this calendar year by the Phoenix clock. */
function thisYear(): number {
  return Number(todayIn(null).slice(0, 4))
}

/** S654: last day of a month as 'YYYY-MM-DD', by pure calendar math (no server zone). */
function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

/** S654: a Phoenix wall-clock time written with its UTC offset, e.g. '2026-09-30T23:59:59-07:00'. */
function withReportOffset(local: string): string {
  const offsetMin = Math.round((Date.parse(local + 'Z') - localDateTimeToUtc(local, REPORT_TZ).getTime()) / 60000)
  const abs = Math.abs(offsetMin)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${local}${offsetMin < 0 ? '-' : '+'}${hh}:${mm}`
}

// Helper — get month date range.
// S654: the bounds carry the Phoenix offset ('2026-09-30T23:59:59-07:00').
// They used to be UTC ISO strings, so the month's last second read
// '2026-10-01T06:59:59Z': right as an instant, but every DATE column compared
// against it (due_date, lot rent's billing_month, other income, entered
// expenses) read 2026-10-01 and pulled next month's 1st into this month.
function monthRange(year: number, month: number) {
  // Date.UTC rolls month 0 / 13 over to the neighboring year, as before.
  const first = new Date(Date.UTC(year, month - 1, 1))
  return {
    start: withReportOffset(`${first.toISOString().slice(0, 10)}T00:00:00`),
    end:   withReportOffset(`${lastDayOfMonth(first.getUTCFullYear(), first.getUTCMonth() + 1)}T23:59:59`),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * S655: a property's lot rent and entered expenses over a period — ONE
 * definition read by the By Property row (/property-pl, and its CSV) and by
 * the drill-in it opens (/property-detail), so the row's net and the
 * drill-in's net are the same number (S642: two cards about the same money
 * must match). `p` is the SQL for the property id; `s`/`e` the period's first
 * and last day. Lot rent by its billing month; an entered expense by its date
 * (voided ones excluded) — as the P&L counts them.
 *
 * 10/12 review: and only the viewer's companies' rows (`l`, a uuid[]), each
 * former property's cut at the day it left (`cut`, cutoffsParam). By property
 * alone, a property bought from another company carried the SELLER's costs from
 * before the sale onto the buyer's row (and to the buyer's bookkeeper), while
 * its income (incomeEvents, by company) did not — so the row matched neither
 * company's P&L. Now costs and income are read by the same companies.
 */
function propertyLotRentSql(p: string, s: string, e: string, l: string, cut: string): string {
  return `(SELECT COALESCE(SUM(lrc.amount), 0) FROM lot_rent_charges lrc
            WHERE lrc.property_id = ${p} AND lrc.landlord_id = ANY(${l}::uuid[])
              AND lrc.billing_month >= ${s}::date AND lrc.billing_month <= ${e}::date
              AND ${withinCutoffsSql('lrc.property_id', 'lrc.billing_month', cut)})`
}
function propertyEnteredExpensesSql(p: string, s: string, e: string, l: string, cut: string): string {
  return `(SELECT COALESCE(SUM(lex.amount), 0) FROM landlord_expenses lex
            WHERE lex.property_id = ${p} AND lex.landlord_id = ANY(${l}::uuid[]) AND ${liveExpenseSql('lex')}
              AND lex.expense_date >= ${s}::date AND lex.expense_date <= ${e}::date
              AND ${withinCutoffsSql('lex.property_id', 'lex.expense_date', cut)})`
}

/** 10/12: a property's day for a timestamp, on its own calendar (properties aliased `tz`). */
const propertyDaySql = (ts: string, tz: string) => `((${ts}) AT TIME ZONE COALESCE(${tz}.timezone, 'America/Phoenix'))::date`

/**
 * 10/12 (Nic): a former property's platform fee only for the months that
 * began by its last day — landlordPLExpenses's own rule (the fee is billed by
 * the month; the month it left in was the company's).
 */
async function cutFormerPlatformFees(
  feeMap: Map<string, number>, landlordIds: string[], months: string[], cutoffs: readonly PropertyCutoff[],
): Promise<void> {
  for (const c of cutoffs) {
    if (!feeMap.has(c.propertyId)) continue
    const kept = months.filter(m => String(m).slice(0, 10) <= c.lastDay)
    feeMap.set(c.propertyId, kept.length
      ? ((await platformFeesByPropertyForEntities(landlordIds, kept, c.propertyId)).get(c.propertyId) ?? 0)
      : 0)
  }
}

/**
 * 10/12 (Nic, ledger P8): the properties' expenses from the books, once every
 * company the report reads is live — the expense accounts by property
 * (services/ledgerReports), in the buckets the By Property row and its drill-in
 * show, plus what was PAID in the period (the Received net takes it). null
 * while the report still reads the money records.
 */
async function ledgerExpensesByProperty(
  landlordIds: string[], start: string, end: string, propertyIds: string[] | null, cutoffs: readonly PropertyCutoff[],
): Promise<Map<string, LedgerPLExpenses> | null> {
  if (!(await ledgerReportsLive(landlordIds))) return null
  return ledgerPLExpensesByProperty({ landlordIds, propertyIds, cutoffs }, start, end)
}

/** 'YYYY-MM' → the month's first and last day. */
function monthDays(ym: string): { first: string; last: string } {
  const [y, m] = ym.split('-').map(Number)
  return { first: `${ym}-01`, last: lastDayOfMonth(y, m) }
}

/** The 'YYYY-MM' keys of the current Phoenix month and the n−1 before it, oldest first. */
function lastMonths(n: number): string[] {
  const today = todayIn(null)
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7))
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(d.toISOString().slice(0, 7))
  }
  return out
}

// 10/5: from the shared labels, so a new recorded method (a bank deposit) is named here too.
const MANUAL_LABEL: Record<string, string> = { ...MANUAL_PAYMENT_METHOD_LABELS, prior_arrangement: 'Prior arrangement' }
/** S652 (Nic): "it doesn't tell me if they paid cash or not." */
function methodLabel(p: any): string {
  return p.manual_method ? (MANUAL_LABEL[p.manual_method] || 'Other')
    : p.ach_trace_number ? 'ACH'
    : (p.stripe_charge_id || p.stripe_payment_intent_id) ? 'Card'
    : '—'
}

/**
 * S655: the charges behind a set of money facts — one entry per charge per
 * day it counted, with the dollars that charge contributed to the total under
 * the basis (its own money on the day it settled for Money received, and a
 * dispute or bank return as a negative on the day it happened; its bill, net
 * of credits given, on its due day for Money billed) and, for Money billed,
 * what became of it. The list a report shows therefore sums to the part of
 * the total that came from charges (`rowsTotal`), and each entry's `day` (the
 * property's calendar day the money counted) is the day a screen files it
 * under — never the day the original payment settled, which can be in an
 * earlier month than a dispute of it.
 */
async function chargesBehind(events: readonly IncomeEvent[]): Promise<{ rows: any[]; rowsTotal: number; chargeCount: number }> {
  const agg = new Map<string, { paymentId: string; day: string; amount: number; parts: Record<string, number> }>()
  for (const e of events) {
    if (!e.inTotal || !e.paymentId) continue
    const key = `${e.paymentId}|${e.day}`
    const a = agg.get(key) ?? { paymentId: e.paymentId, day: e.day, amount: 0, parts: {} }
    a.amount += e.amount
    if (e.part) a.parts[e.part] = round2((a.parts[e.part] ?? 0) + e.amount)
    agg.set(key, a)
  }
  const ids = [...new Set([...agg.values()].map(a => a.paymentId))]
  if (!ids.length) return { rows: [], rowsTotal: 0, chargeCount: 0 }
  const detail = await query<any>(`
    SELECT p.id, p.landlord_id, p.settled_at, p.due_date::text AS due_date, p.amount, p.type, p.status,
           p.entry_description, p.manual_method, p.ach_trace_number, p.stripe_charge_id, p.stripe_payment_intent_id,
           p.issued_credit_amount, u.unit_number, pr.name AS property_name,
           us.first_name AS tenant_first, us.last_name AS tenant_last
      FROM payments p
      LEFT JOIN leases l       ON l.id  = p.lease_id
      LEFT JOIN units u        ON u.id  = COALESCE(p.unit_id, l.unit_id)
      LEFT JOIN properties pr  ON pr.id = u.property_id
      LEFT JOIN tenants t      ON t.id  = p.tenant_id
      LEFT JOIN users us       ON us.id = t.user_id
     WHERE p.id = ANY($1::uuid[])`, [ids])
  const byId = new Map<string, any>(detail.map((p: any) => [p.id, p]))
  // A charge's category, when everything it added carries the same one. A
  // move-out shortfall the tenant paid is split across the bills it covered
  // (each under its own category) and the deductions (none): no one category.
  const cats = new Map<string, Set<string | null>>()
  for (const e of events) {
    if (!e.inTotal || !e.paymentId) continue
    const s = cats.get(e.paymentId) ?? new Set<string | null>()
    s.add(e.category ?? null)
    cats.set(e.paymentId, s)
  }
  const cat = new Map<string, string | null>()
  for (const [id, s] of cats) cat.set(id, s.size === 1 ? [...s][0] : null)
  const rows = [...agg.values()].filter(a => byId.has(a.paymentId)).map(a => {
    const p = byId.get(a.paymentId)
    const category = cat.get(p.id) ?? null
    return {
      id: p.id, key: `${p.id}:${a.day}`, day: a.day,
      landlordId: p.landlord_id, settledAt: p.settled_at, dueDate: p.due_date,
      amount: round2(a.amount),
      billedAmount: round2(parseFloat(p.amount || 0)),
      creditGiven: round2(parseFloat(p.issued_credit_amount || 0)),
      parts: a.parts,
      type: p.type, entryDescription: p.entry_description, status: p.status, method: methodLabel(p),
      category, categoryLabel: category ? INCOME_CATEGORY_LABEL[category as keyof typeof INCOME_CATEGORY_LABEL] : null,
      tenantName: [p.tenant_first, p.tenant_last].filter(Boolean).join(' ') || null,
      tenantFirst: p.tenant_first ?? null, tenantLast: p.tenant_last ?? null,
      unitNumber: p.unit_number ?? null, propertyName: p.property_name ?? null,
    }
  })
  // Newest first: by the day the money counted, then by when it settled.
  const settled = (r: any) => r.settledAt ? new Date(r.settledAt).getTime() : 0
  rows.sort((x: any, y: any) => y.day.localeCompare(x.day) || settled(y) - settled(x))
  return {
    rows,
    rowsTotal: round2(rows.reduce((s: number, r: any) => s + r.amount, 0)),
    // How many charges are behind the total (a charge counted on two days is one charge).
    chargeCount: new Set(rows.map((r: any) => r.id)).size,
  }
}

/**
 * S633 — REPORTS SPLIT TWO WAYS, AND THE SPLIT IS NOT ARBITRARY.
 *
 * The account owns entities; entities own properties. So "which landlord is
 * this report for?" has two different right answers depending on the report:
 *
 *  - An ANALYTICAL rollup — how is my portfolio doing — is about the account.
 *    It spans every entity the account owns. Nic, on the dashboard doing this
 *    already: "I see everything combined for mine, without the two mixing."
 *    Use `reportScope()`.
 *
 *  - A TAX or STATEMENT document — a 1099, a tax summary, a monthly statement —
 *    belongs to ONE company. It carries that company's name and EIN, and an LLC
 *    files its own return. Summing two LLCs into one statement would produce a
 *    document that is wrong on its face. Use `reportEntity()`, which asks which
 *    company when the account owns more than one.
 *
 * Both replace `resolveLandlordIdForUser`, which answered with whichever single
 * entity the session sat on — silently omitting the other company's money from
 * every figure on the page.
 */
function reportScope(user: any): string[] {
  const ids = landlordScopeIds(user)
  if (!ids.length) throw new AppError(400, 'No landlord scope on this user')
  return ids
}

function reportEntity(user: any, explicit: unknown): string {
  return resolveLandlordTarget(user, typeof explicit === 'string' ? explicit : undefined, 'report')
}

/**
 * S655 (gam-audience-data-isolation): a company document — the owner
 * statement, the tax summary, the 1099 work-trade summary — covers every
 * property the company owns, so a team member assigned to some of them is
 * refused it in plain words rather than handed the whole company's money (or a
 * partial "company" document that is wrong on its face). Owners and team
 * members with every property pass. Books uses the same refusal for its own
 * company documents (P&L, cash flow, owner statements).
 *
 * 10/12 (Nic): a bookkeeper gets a company document by the company-wide box
 * alone — the owner's own choice per bookkeeper, no longer inferred from
 * "every property ticked". 10/12 (Nic, BK1): a document that is part of the
 * Books ledger (`ledger: true` — the Books P&L) also opens with the ledger box,
 * "May use the whole-company ledger".
 */
export async function refuseScopedStaff(user: any, what: string, opts: { ledger?: boolean } = {}): Promise<void> {
  if (user?.role === 'bookkeeper') {
    const bk = await bookkeeperRequestScopeOf(user)
    if (!bk.companyWide && !(opts.ledger && bk.ledger)) {
      const w = `The ${what}`
      throw new AppError(403, companyWideRefusal(w.charAt(0).toUpperCase() + w.slice(1)))
    }
    return
  }
  if (await getScopedPropertyIds(user) !== null) {
    throw new AppError(403, `The ${what} covers the whole company, and you are assigned to some of its properties. Ask the owner for it.`)
  }
}

// ── LEDGER STATUS (10/12, Nic, ledger P8) ─────────────────────
// GET /api/reports/ledger-status — do this viewer's reports read the books
// (the ledger)? Every company the reports cover must be live
// (services/ledgerReports ledgerReportsLive); the screens then say what Owed
// means on the books (what tenants still owed at the end of the period, with
// the strip that ties it). A yes or no about the viewer's own companies only.
reportsRouter.get('/ledger-status', async (req, res, next) => {
  try {
    const ids = reportScope(req.user!)
    res.json({ success: true, data: { live: await ledgerReportsLive(ids) } })
  } catch (e) { next(e) }
})

// ── SUMMARY (S69) ─────────────────────────────────────────────
// GET /api/reports/summary
// Backs the landlord ReportsPage. Per-landlord scoped (admin/super_admin
// see the whole platform).
//
// Returns:
//   collectedMtd     — the shared rent card (lib/rentCollected), the same
//                      figure the dashboard's rent card shows: Money received =
//                      rent that arrived this month, incl. money paid ahead;
//                      Money billed = collected so far of this month's rent
//   collectedMtdClearing — money still clearing, beside it (never inside)
//   incomeCard       — the dashboard's income card, both ways (every line)
//   outstanding      — sum of unsettled invoice amounts (pending + partial)
//   occupancyRate    — round(100 × active / total) across landlord's units
//   monthly[]        — last 6 months: charged / received / owed and the net
//                      on each (10/12), collected (= received), rent,
//                      disbursed, fees, net
//   thisMonth, ytd   — 10/12 (Nic): Charged / Received / Owed this month (with
//                      the tie line) and this year
//   ownerVsManager   — split of landlord's manager_fee vs owner_share
//                      ledger entries this month (16a)
reportsRouter.get('/summary', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = LEGACY_BASIS
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    // decisions #25: the Outstanding Balance and every Owed figure below are
    // grand totals of what everyone owes (viewForViewer).
    const seesTotals = seesGrandTotals(req.user)
    // S633: spans every entity the account owns. Scoped to one entity, the
    // headline figures on the Reports page silently excluded the other
    // company's rent — a number that is wrong with no sign that it is wrong.
    const landlordIds = isAdmin ? null : reportScope(req.user!)
    // S655 (gam-audience-data-isolation): a team member assigned to some
    // properties sees those properties' money only — every figure below.
    const scopedIds = isAdmin ? null : await getScopedPropertyIds(req.user)
    // 10/12 (Nic): a bookkeeper's former property stops at the day it left.
    const cutoffs = await propertyCutoffsOf(req.user)
    const userId = req.user!.userId

    // S655: each month's figure IS that month's P&L total under the basis —
    // the row and the P&L it opens can never disagree. Calendar months by the
    // Phoenix clock, the current one included.
    const months = lastMonths(6)
    const today = todayIn(null)
    const yearStart = `${today.slice(0, 4)}-01-01`
    const windowStart = months[0] + '-01' < yearStart ? months[0] + '-01' : yearStart
    // 10/12 (Nic, review): one decision for the whole account — the books only
    // when EVERY company reads them — passed to every reader below, so no
    // company's month mixes the books and the money records (Oak Park and
    // Mountain View share one account).
    const source = landlordIds && await ledgerReportsLive(landlordIds) ? 'ledger' as const : 'records' as const
    // 10/12 (Nic): both kinds of facts — Charged, Received and Owed side by side.
    const both = await incomeBoth({
      landlordIds, start: windowStart, end: monthDays(months[months.length - 1]).last,
      propertyIds: scopedIds, cutoffs, source,
    })
    const perMonth = byMonth(both.received)
    const perMonthBilled = byMonth(both.billed)
    const monthTotals = (ym: string) => summarize(perMonth.get(ym) ?? [], basis)
    const monthView = (ym: string) => {
      const d = monthDays(ym)
      return moneyViewFrom(perMonthBilled.get(ym) ?? [], perMonth.get(ym) ?? [], { start: d.first, end: d.last, label: monthWords(ym) })
    }

    const disbursementRows = isAdmin
      ? await query<any>(`
          SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                 SUM(amount)::numeric AS disbursed,
                 SUM(fee_charged)::numeric AS fees
            FROM disbursements
           WHERE created_at > NOW() - INTERVAL '6 months'
             AND status IN ('pending', 'processing', 'settled')
           GROUP BY 1
        `)
      : await query<any>(`
          SELECT to_char(date_trunc('month', d.created_at), 'YYYY-MM') AS month,
                 SUM(d.amount)::numeric AS disbursed,
                 SUM(d.fee_charged)::numeric AS fees
            FROM disbursements d
           WHERE d.user_id = $1
             AND d.created_at > NOW() - INTERVAL '6 months'
             AND d.status IN ('pending', 'processing', 'settled')
           GROUP BY 1
        `, [userId])
    const disb = new Map<string, { disbursed: number; fees: number }>()
    for (const r of disbursementRows) {
      disb.set(r.month, { disbursed: parseFloat(r.disbursed ?? '0'), fees: parseFloat(r.fees ?? '0') })
    }
    // S655: each month's net IS the P&L's net (the month's income less its
    // expenses: GAM's platform fee, maintenance, lot rent, entered expenses —
    // services/landlordPL, the definition the P&L the row opens uses), summed
    // over the account's companies. It used to be income less the payout
    // run's fees, which matched nothing the row opens. The admin lens (every
    // landlord) has no one P&L to net against: null.
    const monthExpenses = new Map<string, number>()
    // 10/12 (Nic, ledger P8): on the books, the Received net takes the
    // expenses PAID in the month (cashTotal), the Charged net those incurred.
    const monthPaid = new Map<string, number>()
    if (landlordIds) {
      await Promise.all(months.map(async ym => {
        const [y, m] = ym.split('-').map(Number)
        const { start, end } = monthRange(y, m)
        const perCompany = await Promise.all(landlordIds.map(lid =>
          landlordPLExpenses(lid, start, end, periodMonths(y, m), scopedIds, cutoffs, source)))
        monthExpenses.set(ym, round2(perCompany.reduce((s, e) => s + e.total, 0)))
        monthPaid.set(ym, round2(perCompany.reduce((s, e) => s + (e.cashTotal ?? e.total), 0)))
      }))
    }
    const monthly = [...months].reverse().map(month => {
      const t = monthTotals(month)
      const v = monthView(month)
      const d = disb.get(month) ?? { disbursed: 0, fees: 0 }
      const expenses = landlordIds ? (monthExpenses.get(month) ?? 0) : null
      const paid = landlordIds ? (monthPaid.get(month) ?? 0) : null
      return {
        month,
        // 10/12 (Nic): the three columns, and the net on each money column.
        charged: v.charged,
        received: v.received,
        ...(seesTotals ? { owed: v.owed } : {}),
        netCharged: expenses == null ? null : round2(v.charged - expenses),
        netReceived: paid == null ? null : round2(v.received - paid),
        collected: t.total,
        rent: t.lines.rent,
        disbursed: d.disbursed,
        fees: d.fees,
        expenses,
        net: paid == null ? null : round2(t.total - paid),
      }
    })

    // S642/S655: the dashboard's cards, from the same facts and the same rules
    // (lib/rentCollected), so Reports and the dashboard cannot disagree. Money
    // still clearing is its own figure beside what arrived.
    const [rentCard, allCard] = await Promise.all([
      collectedRentMtd(landlordIds, scopedIds, { scope: 'rent', basis, cutoffs }),
      collectedRentMtd(landlordIds, scopedIds, { scope: 'all', basis, cutoffs }),
    ])
    const fullIncomeCard = incomeCardFrom(allCard, basis)
    // decisions #25: Money billed's collected / clearing / still owed add up to
    // what was charged, so only the charged amount is left for a viewer who
    // sees no grand totals.
    const incomeCard = seesTotals ? fullIncomeCard
      : { ...fullIncomeCard, billed: { amount: fullIncomeCard.billed.amount } }
    const collectedMtd = basis === 'received' ? rentCard.collected : rentCard.billed.collected
    const collectedMtdClearing = basis === 'received' ? rentCard.inFlight : rentCard.billed.clearing

    // Outstanding = invoice total minus settled payments matched to that invoice.
    // pending|partial invoices only — settled invoices net to zero.
    // S640 (Nic): work-trade charges are suspended, not owed — they settle in
    // hours at month close. Netted here for the same reason as on the dashboard
    // and the balances page: this figure and those two are the same claim about
    // the same money, and Reports is where a landlord goes to check the others.
    const OUTSTANDING_PAID = `
              SELECT invoice_id,
                     SUM(amount) FILTER (WHERE status IN ('settled', 'processing')) AS paid,
                     SUM(amount) FILTER (WHERE status NOT IN ('settled', 'processing')
                                           AND work_trade_suspended_at IS NOT NULL) AS traded
                FROM payments WHERE invoice_id IS NOT NULL
               GROUP BY invoice_id`
    // S654: suspended lines sit OUTSIDE total_amount (the S634 shape, every
    // writer); subtracting `traded` again clamped a partly covered bill to $0.
    const OUTSTANDING_SUM =
      `COALESCE(SUM(GREATEST(i.total_amount - COALESCE(p.paid, 0), 0)), 0)::numeric AS amount`
    // decisions #25 (Nic, 10/3): a GRAND TOTAL of what everyone owes is for
    // account owners and property managers only — left out of the reply for
    // anyone else (front desk / on-site staff with "View all payments"), not
    // just hidden on the screen, and not even computed. One rule:
    // services/openBalances seesGrandTotals.
    // 10/12 (Nic): a bookkeeper who keeps no property's money (the
    // company-wide box alone) has no Outstanding Balance to read — a "$0"
    // card would say nobody owes anything. The card is left out for them.
    const keepsNoPropertyMoney = req.user!.role === 'bookkeeper' && Array.isArray(scopedIds) && scopedIds.length === 0
    const showOutstanding = seesTotals && !keepsNoPropertyMoney
    const outstandingRow = !showOutstanding ? null : isAdmin
      ? await queryOne<any>(`
          SELECT ${OUTSTANDING_SUM}
            FROM invoices i
            LEFT JOIN (${OUTSTANDING_PAID}) p ON p.invoice_id = i.id
           WHERE i.status IN ('pending', 'partial')
        `)
      : await queryOne<any>(`
          SELECT ${OUTSTANDING_SUM}
            FROM invoices i
            LEFT JOIN (${OUTSTANDING_PAID}) p ON p.invoice_id = i.id
           WHERE i.landlord_id = ANY($1::uuid[]) AND i.status IN ('pending', 'partial')
             AND ($2::uuid[] IS NULL OR i.unit_id IN (SELECT id FROM units WHERE property_id = ANY($2::uuid[])))
             -- 10/12: a bookkeeper's former property: its bills due by the day it left.
             AND ${withinCutoffsSql('(SELECT ou.property_id FROM units ou WHERE ou.id = i.unit_id)', 'i.due_date', '$3')}
        `, [landlordIds, scopedIds, cutoffsParam(cutoffs)])
    const outstanding = parseFloat(outstandingRow?.amount ?? '0')

    // S616 (Nic): occupancy counts SHORT STAYS — "aggregate thirty nights of
    // bookings as well" — and excludes service points, which are a neighbor's
    // building rather than this landlord's inventory. Shares one formula with
    // the Dashboard's Occupancy card so the two cannot disagree.
    const occRow = isAdmin
      ? await queryOne<any>(`
          SELECT
            COUNT(*) FILTER (WHERE status <> 'utility_service')::int AS total,
            COUNT(*) FILTER (WHERE status='active')::int AS active
          FROM units
        `)
      : await queryOne<any>(`
          SELECT
            COUNT(*) FILTER (WHERE status <> 'utility_service')::int AS total,
            COUNT(*) FILTER (WHERE status='active')::int AS active
          FROM units WHERE landlord_id = ANY($1::uuid[])
            AND ($2::uuid[] IS NULL OR property_id = ANY($2::uuid[]))
        `, [landlordIds, scopedIds])
    const nightsRow = await queryOne<{ nights: number }>(`
      SELECT COALESCE(SUM(
               GREATEST(
                 LEAST(b.check_out, date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
                   - GREATEST(b.check_in, date_trunc('month', CURRENT_DATE))::date, 0)), 0)::int AS nights
        FROM unit_bookings b
        JOIN units u ON u.id = b.unit_id
       WHERE ($1::uuid[] IS NULL OR u.landlord_id = ANY($1::uuid[]))
         AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
         AND u.status <> 'utility_service'
         AND b.lease_type IN ('nightly','weekly')
         AND b.status NOT IN ('cancelled','no_show')
         AND b.check_in  < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
         AND b.check_out > date_trunc('month', CURRENT_DATE)`,
      [isAdmin ? null : landlordIds, scopedIds])
    const total = parseInt(occRow?.total ?? '0', 10)
    const active = parseInt(occRow?.active ?? '0', 10)
    const occupancyRate = occupancyRateFrom(active, nightsRow?.nights || 0, total)

    // 16a owner-vs-manager split for the calling user, this calendar month.
    // Both columns sum to "what hit my ledger this month".
    const splitRow = await queryOne<any>(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type='allocation_owner_share'), 0)::numeric AS owner_share,
        COALESCE(SUM(amount) FILTER (WHERE type='allocation_manager_fee'), 0)::numeric AS manager_fee
      FROM user_balance_ledger
      WHERE user_id = $1
        AND created_at >= date_trunc('month', NOW())
    `, [userId])

    // YTD: each month of this year (to date), the same month totals.
    // 10/12: Charged and Owed beside Received (collected) for every month.
    const ytdMonthly: Array<{ month: string; collected: number; charged: number; owed?: number }> = []
    for (let m = 1; m <= Number(today.slice(5, 7)); m++) {
      const ym = `${today.slice(0, 4)}-${String(m).padStart(2, '0')}`
      const v = monthView(ym)
      if (v.received !== 0 || v.charged !== 0) {
        ytdMonthly.push({ month: ym, collected: v.received, charged: v.charged, ...(seesTotals ? { owed: v.owed } : {}) })
      }
    }
    const ytdCollected = round2(ytdMonthly.reduce((s, m) => s + m.collected, 0))
    // 10/12 (Nic, review): on the books a month's Owed is a balance at its end
    // (a bill unpaid since January is in every month's), so the year's Owed is
    // the balance at the end of this month, never the months added up.
    const ytdOwed = source === 'ledger'
      ? monthView(today.slice(0, 7)).owed
      : round2(ytdMonthly.reduce((s, m) => s + (m.owed ?? 0), 0))
    const ytd = {
      charged: round2(ytdMonthly.reduce((s, m) => s + m.charged, 0)),
      received: ytdCollected,
      ...(seesTotals ? { owed: ytdOwed } : {}),
    }
    const cur = viewForViewer(monthView(today.slice(0, 7)), seesTotals) as Partial<MoneyView> & Pick<MoneyView, 'charged' | 'received' | 'tieText'>
    const thisMonth = {
      month: today.slice(0, 7), charged: cur.charged, received: cur.received,
      ...(seesTotals ? { owed: cur.owed, collected: cur.collected, clearing: cur.clearing } : {}),
      tieText: cur.tieText,
    }

    res.json({ success: true, data: {
      collectedMtd,
      collectedMtdClearing,
      incomeCard,
      ytdCollected,
      ytd,
      thisMonth,
      ...(showOutstanding ? { outstanding } : {}),
      occupancyRate,
      occupiedUnits: active,
      totalUnits: total,
      monthly,
      ytdMonthly,
      ownerVsManager: {
        ownerShare: parseFloat(splitRow?.owner_share ?? '0'),
        managerFee: parseFloat(splitRow?.manager_fee ?? '0'),
      },
      meta: MONEY_META,
    } })
  } catch (e) { next(e) }
})

// ── MONTHLY P&L DRILL-IN (S512 #20) ───────────────────────────
// GET /api/reports/monthly-pl?year=YYYY&month=M
// Backs the clickable drill-in on the landlord ReportsPage monthly
// table. One month's profit-and-loss:
//   view      — 10/12 (Nic): Charged / Received / Owed by line and category,
//               with the tie line; nets = each money column less expenses
//   days[]    — 10/12 (Nic): "the money by the day it arrived" as ONE line per
//               day with that day's total, and under it the expenses logged
//               that day; paymentKeys name the payments[] behind the day (the
//               screen expands a day to who paid; the printout shows totals)
//   gross     — income by line (services/landlordPL → incomeBasis)
//   lines     — every non-zero income line, labeled (paid ahead, register
//               sales, credits given, returned, ...); they add up to gross.total
//   beside    — figures shown beside the total, never in it (still clearing,
//               credits you gave, covered by work trade, deposits held, ...)
//   parts     — Money billed: what became of the bills (adds up to the total)
//   expenses  — GAM platform fee, maintenance, lot rent, entered expenses
//   net       — gross.total − expenses.total
//   payments[] — the charges behind the total: Money received lists each
//               charge's own new money on the day it settled; Money billed
//               lists each bill due this month with what became of it.
//               rowsTotal is their sum.
reportsRouter.get('/monthly-pl', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = LEGACY_BASIS
    // S654: "this month" by the Phoenix calendar, not the server clock's zone.
    const today = todayIn(null)
    const year  = parseInt(req.query.year as string)  || Number(today.slice(0, 4))
    const month = parseInt(req.query.month as string) || Number(today.slice(5, 7))
    if (month < 1 || month > 12) throw new AppError(400, 'month must be 1-12')
    const { start, end } = monthRange(year, month)
    // S633: a STATEMENT belongs to one company — it carries that company's name
    // and EIN, and an LLC files its own return. Summing two together produces a
    // document that is wrong on its face, so this asks which when the account
    // owns more than one.
    const landlordId = reportEntity(req.user!, req.query.landlordId)
    // S655 (gam-audience-data-isolation): the drill-in of the Reports table,
    // so a team member assigned to some properties sees those properties'
    // P&L — the same scope /summary's row was built with.
    const scopedIds = await getScopedPropertyIds(req.user)
    // 10/12 (Nic): a bookkeeper's former property stops at the day it left.
    const cutoffs = await propertyCutoffsOf(req.user)

    // 10/12: the facts read once — both kinds — for the P&L, its three
    // columns, the payments behind it and its days.
    const first = String(start).slice(0, 10), last = String(end).slice(0, 10)
    const ym = `${year}-${String(month).padStart(2, '0')}`
    const [both, expenses, expensesByDay] = await Promise.all([
      incomeBoth({ landlordIds: [landlordId], start: first, end: last, propertyIds: scopedIds, cutoffs }),
      landlordPLExpenses(landlordId, String(start), String(end), periodMonths(year, month), scopedIds, cutoffs),
      enteredExpensesByDay(landlordId, first, last, scopedIds, cutoffs),
    ])
    const pl = landlordPLFrom(both, expenses, { start: first, end: last, label: monthWords(ym) }, basis)
    const events = both.received
    const { rows: paymentRows, rowsTotal, chargeCount } = await chargesBehind(events)
    const summary = summarize(events, basis)

    res.json({ success: true, data: {
      period: { year, month, start, end },
      gross: pl.gross,
      lines: pl.lineItems,
      beside: pl.besideItems,
      parts: partList(summary.parts),
      depositsHeld: pl.depositsHeld,
      expenses: pl.expenses,
      net: pl.net,
      paymentCount: chargeCount,
      payments: paymentRows,
      rowsTotal,
      view: viewForViewer(pl.view, seesGrandTotals(req.user)),
      nets: pl.nets,
      days: dailyLines(events, paymentRows, expensesByDay),
      meta: MONEY_META,
    } })
  } catch (e) { next(e) }
})

/**
 * 10/12 (Nic): "the monthly P&L's 'money by the day it arrived' list
 * collapses to ONE line per day with that day's total, and under each day any
 * expenses logged that day ('You logged $2,000 of expenses')."
 *
 * One entry per day that had money arrive or an expense logged, newest first.
 * `received` is every fact of the day in the Received total — so the days add
 * up to the month's Received — and `chargesTotal` the part with a charge
 * behind it (`paymentKeys`, the payments[] rows a screen expands to); the rest
 * (`noCharge`) is money with no single charge (paid ahead, register sales,
 * stays, other income). Expenses are the P&L's "Your expenses" by their date.
 */
export function dailyLines(
  events: readonly IncomeEvent[],
  rows: ReadonlyArray<{ id: string; key: string; day: string; amount: number }>,
  expensesByDay: ReadonlyMap<string, { amount: number; count: number }>,
): Array<{
  day: string; received: number; chargesTotal: number; noCharge: number; paymentCount: number; paymentKeys: string[]
  expensesLogged: number; expenseCount: number
}> {
  const totals = new Map<string, number>()
  for (const e of events) if (e.inTotal) totals.set(e.day, (totals.get(e.day) ?? 0) + e.amount)
  const days = new Set<string>([...totals.keys(), ...expensesByDay.keys()])
  return [...days].sort((a, b) => b.localeCompare(a)).map(day => {
    const dayRows = rows.filter(r => r.day === day)
    const received = round2(totals.get(day) ?? 0)
    const chargesTotal = round2(dayRows.reduce((s, r) => s + r.amount, 0))
    const exp = expensesByDay.get(day)
    return {
      day, received, chargesTotal, noCharge: round2(received - chargesTotal),
      paymentCount: new Set(dayRows.map(r => r.id)).size, paymentKeys: dayRows.map(r => r.key),
      expensesLogged: exp?.amount ?? 0, expenseCount: exp?.count ?? 0,
    }
  })
}

// ── MONTHLY OWNER STATEMENT ───────────────────────────────────
reportsRouter.get('/monthly-statement', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = LEGACY_BASIS
    // S654: the default is LAST month (a statement covers a finished month),
    // read off the Phoenix calendar. The old getMonth() shortcut handed back
    // month 0 in January.
    const lastMonth = addDaysTo(monthStartOf(todayIn(null)), -1)
    const year  = parseInt(req.query.year as string)  || Number(lastMonth.slice(0, 4))
    const month = parseInt(req.query.month as string) || Number(lastMonth.slice(5, 7))
    if (month < 1 || month > 12) throw new AppError(400, 'month must be 1-12')
    const { start, end } = monthRange(year, month)
    const first = String(start).slice(0, 10), last = String(end).slice(0, 10)
    // S633: a STATEMENT belongs to one company — it carries that company's name
    // and EIN, and an LLC files its own return. Summing two together produces a
    // document that is wrong on its face, so this asks which when the account
    // owns more than one.
    const landlordId = reportEntity(req.user!, req.query.landlordId)
    await refuseScopedStaff(req.user, 'owner statement')

    // Landlord info
    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, u.phone
      FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [landlordId])

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). landlords
    // never had pm_company_id / pm_fee_plan_id columns and the pm_companies
    // / pm_fee_plans tables don't exist. Response shape preserves the
    // pmInfo / pmPlan keys as null so the frontend doesn't break.
    const pmInfo = null
    const pmPlan = null

    // Properties with units
    const properties = await query<any>(`
      SELECT p.*, COUNT(u.id) as total_units,
        COUNT(u.id) FILTER (WHERE vuo.is_occupied) as occupied_units
      FROM properties p
      LEFT JOIN units u ON u.property_id = p.id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE p.landlord_id = $1
      GROUP BY p.id ORDER BY p.name`, [landlordId])

    // Unit detail for the month
    const units = await query<any>(`
      SELECT u.*, p.name as property_name,
        vuo.primary_first_name as tenant_first,
        vuo.primary_last_name as tenant_last,
        vuo.primary_email as tenant_email,
        vuo.is_occupied
      FROM units u
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE u.landlord_id = $1
      ORDER BY p.name, u.unit_number`, [landlordId])

    // Payments for the month. S655: the statement's rows are the charges
    // behind its total, from the same money facts as the P&L (chargesBehind,
    // as /monthly-pl lists them): Money received lists each charge's own new
    // money on the day it settled (a credit-paid part and money paid ahead
    // that paid it are not new money that day); Money billed lists each bill
    // due this month with what became of it. They sum to rowsTotal; the rest
    // of totalIncome is the money with no charge behind it (paid ahead,
    // register sales and stays, other income, the move-out lines). Only the
    // landlord's income is listed — GAM's own rows, held paid-ahead money and
    // FlexPay pulls are not the landlord's. Deposits held are their own list:
    // never income.
    // 10/12: both kinds of facts and the P&L's expenses, read once; the P&L,
    // its three columns and the payments behind it come off them.
    const [both, plExpenses] = await Promise.all([
      incomeBoth({ landlordIds: [landlordId], start: first, end: last }),
      landlordPLExpenses(landlordId, String(start), String(end), periodMonths(year, month)),
    ])
    const statementEvents = both.received
    const { rows: payments, rowsTotal } = await chargesBehind(statementEvents)
    const depositRows = await query<any>(`
      SELECT p.id, p.amount, p.status, p.due_date::text AS due_date, p.settled_at,
             u.unit_number, pr.name AS property_name,
             us.first_name AS tenant_first, us.last_name AS tenant_last
        FROM payments p
        LEFT JOIN leases l ON l.id = p.lease_id
        LEFT JOIN units u ON u.id = COALESCE(p.unit_id, l.unit_id)
        LEFT JOIN properties pr ON pr.id = u.property_id
        LEFT JOIN tenants t ON t.id = p.tenant_id
        LEFT JOIN users us ON us.id = t.user_id
       WHERE p.landlord_id = $1 AND ${landlordDepositSql('p')}
         AND p.status = 'settled' AND p.settled_at IS NOT NULL
         AND (p.settled_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date BETWEEN $2::date AND $3::date
       ORDER BY pr.name, u.unit_number`, [landlordId, first, last])
    const deposits = depositRows.map((d: any) => ({
      id: d.id, amount: round2(parseFloat(d.amount || 0)), status: d.status,
      dueDate: d.due_date, settledAt: d.settled_at,
      unitNumber: d.unit_number ?? null, propertyName: d.property_name ?? null,
      tenantFirst: d.tenant_first ?? null, tenantLast: d.tenant_last ?? null,
      tenantName: [d.tenant_first, d.tenant_last].filter(Boolean).join(' ') || null,
    }))
    // 10/12 (Nic): late and failed count HOUSEHOLDS, never lines — a $5
    // daily late fee is not five late bills. Late = a household past its
    // grace period on the month's bills (services/householdMonths, the Rent
    // Roll's stamps: paid late, outstanding, or partly paid past grace);
    // failed = a household with a payment that failed on the month's bills.
    const ym = `${year}-${String(month).padStart(2, '0')}`
    const hhMonths = await householdMonths({ landlordIds: [landlordId], from: ym, through: ym })
    const stampCount = (st: string) => hhMonths.filter(m => m.stamp === st).length
    const pastGrace = hhMonths.filter(m => m.stamp === 'paid_late' || m.stamp === 'outstanding'
      || (m.stamp === 'partial' && m.days_past_grace > 0)).length
    const failedRow = await queryOne<{ failed: number }>(`
      SELECT COUNT(DISTINCT hh)::int AS failed FROM (
        SELECT ${householdOfRowSql('p', 'inv')} AS hh
          FROM payments p
          LEFT JOIN invoices inv ON inv.id = p.invoice_id
         WHERE p.landlord_id = $1 AND ${landlordIncomeSql('p')}
           AND p.status = 'failed'
           AND COALESCE(inv.due_date, p.due_date) BETWEEN $2::date AND $3::date) f
       WHERE hh IS NOT NULL`,
      [landlordId, first, last])
    const openCounts = { late: pastGrace, failed: failedRow?.failed ?? 0 }

    // Maintenance costs for the month
    const maintenance = await query<any>(`
      SELECT mr.*, u.unit_number, p.name as property_name
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      JOIN properties p ON p.id = u.property_id
      WHERE mr.landlord_id = $1
        -- S654: whole last day, as the P&L's maintenance figure counts it.
        AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
        AND mr.actual_cost IS NOT NULL
      ORDER BY p.name, u.unit_number`, [landlordId, start, end])

    // Work trade this month
    const workTrade = await query<any>(`
      SELECT wta.*, u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users us ON us.id = t.user_id
      WHERE wta.landlord_id = $1 AND wta.status = 'active'`, [landlordId])

    // Disbursements for the month
    const disbursements = await query<any>(`
      SELECT * FROM disbursements
      WHERE landlord_id = $1
        AND created_at >= $2 AND created_at < ($3::date + 1)
      ORDER BY created_at DESC`, [landlordId, start, end])

    // ── P&L calculations ──────────────────────────────────────
    // S654: the statement's P&L IS the monthly P&L (computeLandlordPL), so the
    // two can never disagree for the same month.
    const pl = landlordPLFrom(both, plExpenses, { start: first, end: last, label: monthWords(ym) }, basis)
    const rentCollected      = pl.gross.rent
    const feesCollected      = pl.gross.fees
    const utilitiesCollected = pl.gross.utilities
    const homeSaleCollected  = pl.gross.homeSale
    const balancesCollected  = pl.gross.balances   // "Balances collected"
    const bankedOtherIncome  = pl.gross.otherIncome // income the landlord banked outside GAM (S605)
    const otherIncome        = pl.gross.other       // every line but rent, so rent + other = total
    const totalIncome        = pl.gross.total
    const depositsCollected  = pl.depositsHeld
    // S655: what the listed charges brought in. Money received: their own new
    // money (rowsTotal). Money billed: the collected parts of this month's
    // bills (paid, covered by money paid ahead or deposit interest, kept from
    // a deposit) — never "still owed" or "clearing".
    const COLLECTED_PARTS = ['paid', 'coveredByPaidAhead', 'coveredByDepositInterest', 'keptFromDeposit']
    const totalCollected = basis === 'received'
      ? rowsTotal
      : round2(payments.reduce((s: number, p: any) =>
          s + COLLECTED_PARTS.reduce((t, k) => t + (p.parts[k] ?? 0), 0), 0))
    // One charge can be listed on two days (a payment and its dispute in the
    // same month); it is still one settled payment.
    const settledRows = [...new Set(payments.filter((p: any) => p.status === 'settled').map((p: any) => p.id))]

    // Expenses — the P&L's: platform fee (actual billed accruals), actual
    // maintenance cost (the maintenance platform fee is never surfaced), lot
    // rent, the landlord's entered expenses and (10/11) the payment processing
    // fees the landlord covers for tenants — every figure in totalExpenses has
    // its own field, so the statement's lines add up to it.
    const totalPlatformFees = pl.expenses.platformFee
    const totalMaintCost    = pl.expenses.maintenance
    const lotRent           = pl.expenses.lotRent
    const enteredExpenses   = pl.expenses.enteredExpenses
    const processingFees    = pl.expenses.processingFees
    // 10/12 (Nic, G10): the card fees guests got back with refunds of card sales.
    const cardFeesRefunded  = pl.expenses.cardFeesRefunded

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). pmFee always 0.
    const pmFee = 0

    const totalExpenses = round2(pl.expenses.total + pmFee)
    // 10/12 (Nic, ledger P8): on the books, income received less the expenses PAID in the month.
    const netToOwner    = round2(totalIncome - ((pl.expenses.cashTotal ?? pl.expenses.total) + pmFee))

    res.json({
      success: true,
      data: {
        period: { year, month, start, end },
        landlord, pmInfo, pmPlan,
        properties, units, payments, rowsTotal, deposits, maintenance, workTrade, disbursements,
        lines: pl.lineItems,
        beside: pl.besideItems,
        summary: {
          // income
          rentCollected, feesCollected, utilitiesCollected, homeSaleCollected,
          balancesCollected, bankedOtherIncome, otherIncome,
          depositsCollected, totalIncome, totalCollected,
          // expenses
          totalPlatformFees, totalMaintCost, lotRent, enteredExpenses, processingFees, cardFeesRefunded, pmFee, totalExpenses,
          netToOwner,
          // occupancy + payment counts
          occupiedUnits:  units.filter((u:any) => u.is_occupied).length,
          vacantUnits:    units.filter((u:any) => !u.is_occupied).length,
          settledPayments: settledRows.length,
          // 10/12: households, not lines (see openCounts).
          latePayments:    openCounts.late,
          failedPayments:  openCounts.failed,
          households: {
            counted: hhMonths.filter(m => m.stamp).length,
            paidOnTime: stampCount('paid_on_time'), paidLate: stampCount('paid_late'), partial: stampCount('partial'),
            outstanding: stampCount('outstanding'), due: stampCount('due'),
            pastGrace, failed: openCounts.failed,
          },
        },
        // 10/12 (Nic): Charged / Received / Owed side by side, with the tie.
        view: viewForViewer(pl.view, seesGrandTotals(req.user)),
        nets: pl.nets,
        meta: MONEY_META,
      }
    })
  } catch (e) { next(e) }
})

/**
 * S655: the name of the paid-ahead money left at the end of a tax year. Once
 * Dec 31 has passed (Phoenix calendar) whatever is left is for next year's
 * bills; while the year is still running it is only money not used yet.
 */
export function paidAheadLeftoverLabel(year: number, today: string = todayIn(null)): string {
  return today > `${year}-12-31` ? "Paid ahead for next year's bills" : 'Paid ahead, not used yet'
}

// ── ANNUAL TAX SUMMARY ────────────────────────────────────────
// S655: the total IS the year's P&L under the basis (default Money received),
// the net IS its net, and "Paid ahead, not used yet at Dec 31" is shown beside
// it: money that arrived this year for next year's bills (counted this year,
// $0 again next year when it pays them).
reportsRouter.get('/tax-summary', requirePerm('books.view'), async (req, res, next) => {
  try {
    const basis = LEGACY_BASIS
    const year = parseInt(req.query.year as string) || thisYear()   // S654: Phoenix year
    const start = `${year}-01-01`
    const end   = `${year}-12-31`
    // S633: a STATEMENT belongs to one company — it carries that company's name
    // and EIN, and an LLC files its own return. Summing two together produces a
    // document that is wrong on its face, so this asks which when the account
    // owns more than one.
    const landlordId = reportEntity(req.user!, req.query.landlordId)
    await refuseScopedStaff(req.user, 'tax summary')

    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email
      FROM landlords l JOIN users u ON u.id = l.user_id
      WHERE l.id = $1`, [landlordId])

    // The year's P&L (income under the basis; expenses: GAM platform fee,
    // maintenance actual cost, lot rent, entered expenses).
    // 10/12: both kinds of facts read once — the P&L, its three columns and the months.
    const [both, plExpenses] = await Promise.all([
      incomeBoth({ landlordIds: [landlordId], start, end }),
      landlordPLExpenses(landlordId, start, end, periodMonths(year, null)),
    ])
    const pl = landlordPLFrom(both, plExpenses, { start, end, label: String(year) }, basis)
    const events = both.received
    const perMonth = byMonth(events)
    const perMonthBilled = byMonth(both.billed)
    const countedCharges = new Set(events.filter(e => e.inTotal && e.paymentId).map(e => e.paymentId))

    const maintStats = await queryOne<any>(`
      SELECT COUNT(*) as request_count
      FROM maintenance_requests
      -- S654: '2026-12-31' alone is midnight at the start of Dec 31; take the whole day.
      WHERE landlord_id=$1 AND completed_at >= $2 AND completed_at < ($3::date + 1)`,
      [landlordId, start, end])

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). pmInfo
    // preserved as null in the response shape.
    const pmInfo = null

    // Work trade — 1099 eligible. S517: the bartered value is the actual
    // work-trade credit applied to the tenant's invoices that year
    // (invoices.work_trade_credit_amount), not the retired ytd_value dollar
    // ledger. Only agreements with real credit in the year are reported.
    const workTradeStats = await query<any>(`
      SELECT wta.*, u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last, us.email as tenant_email,
        COALESCE((SELECT SUM(i.work_trade_credit_amount) FROM invoices i
                   WHERE i.work_trade_agreement_id = wta.id
                     AND EXTRACT(YEAR FROM i.due_date) = $2), 0) AS credit_value
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users us ON us.id = t.user_id
      WHERE wta.landlord_id=$1
        AND COALESCE((SELECT SUM(i.work_trade_credit_amount) FROM invoices i
                       WHERE i.work_trade_agreement_id = wta.id
                         AND EXTRACT(YEAR FROM i.due_date) = $2), 0) > 0`,
      [landlordId, year])

    // ── S637: DEPOSITS HELD MEANS MONEY WE HOLD ────────────────────────
    //
    // Nic: "when I select Mountain View RV, the deposits held shows eight
    // hundred dollars, and on Oak Park, it shows a thousand and fifty dollars
    // for deposits held. We aren't holding any deposits at either property so
    // far. So where is that pulling data from?"
    //
    // It summed units.security_deposit — the amount CONFIGURED on each
    // occupied unit, which is what a deposit would be if one were taken. Not a
    // penny of it had been collected. On a TAX page that is the worst possible
    // place to state a number nobody is holding: a deposit is a liability, and
    // this one was invented from a setting.
    //
    // security_deposits is the ledger of actual custody. Only rows that are
    // genuinely held count — a refunded or forfeited deposit is no longer held,
    // and a pending one was never collected.
    const depositStats = await queryOne<any>(`
      SELECT COALESCE(SUM(sd.collected_amount), 0) AS total_deposits
        FROM security_deposits sd
        JOIN units u ON u.id = sd.unit_id
       WHERE u.landlord_id = $1
         -- The schema's own vocabulary: pending was never collected,
         -- disbursed went back to the tenant, claimed was applied to damages.
         -- Only funded and partial are still money in custody.
         AND sd.status IN ('funded', 'partial')
         AND sd.collected_amount > 0`, [landlordId])

    // Monthly breakdown — S654/S655: the same facts as the total, so the months sum to it.
    const failedRows = await query<any>(`
      SELECT EXTRACT(MONTH FROM due_date)::int AS month, COUNT(*)::int AS failed
        FROM payments
       WHERE landlord_id=$1 AND due_date >= $2 AND due_date <= $3 AND status = 'failed'
         AND ${landlordIncomeSql()}
       GROUP BY 1`, [landlordId, start, end])
    const failedBy = new Map<number, number>(failedRows.map((r: any) => [r.month, r.failed]))
    const seesTotals = seesGrandTotals(req.user)
    const monthlyBreakdown: Array<{ month: number; collected: number; paid: number; failed: number; charged: number; received: number; owed?: number }> = []
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}-${String(m).padStart(2, '0')}`
      const evs = perMonth.get(ym) ?? []
      const t = summarize(evs, basis)
      // 10/12 (Nic): Charged and Owed beside Received for every month.
      const d = monthDays(ym)
      const v = moneyViewFrom(perMonthBilled.get(ym) ?? [], evs, { start: d.first, end: d.last, label: monthWords(ym) })
      const paid = new Set(evs.filter(e => e.inTotal && e.paymentId).map(e => e.paymentId)).size
      const failed = failedBy.get(m) ?? 0
      if (t.total !== 0 || v.charged !== 0 || paid || failed) {
        // decisions #25: Owed only for a viewer who sees grand totals (viewForViewer).
        monthlyBreakdown.push({ month: m, collected: t.total, paid, failed, charged: v.charged, received: v.received, ...(seesTotals ? { owed: v.owed } : {}) })
      }
    }

    const workTradeVal = workTradeStats.reduce((s:number, w:any) => s + parseFloat(w.credit_value||0), 0)

    res.json({
      success: true,
      data: {
        year, landlord, pmInfo,
        income: {
          totalRent: pl.gross.total,
          paymentCount: countedCharges.size,
          // S654: the lines that make up totalRent; balances = "Balances collected".
          breakdown: {
            rent: pl.gross.rent,
            fees: pl.gross.fees,
            utilities: pl.gross.utilities,
            homeSale: pl.gross.homeSale,
            balances: pl.gross.balances,
          },
          lines: pl.lineItems,
        },
        deductions: {
          platformFees:  pl.expenses.platformFee,
          maintExpenses: pl.expenses.maintenance,
          lotRent: pl.expenses.lotRent,
          enteredExpenses: pl.expenses.enteredExpenses,
          // 10/11: in pl.net (netIncome below), so listed with the rest.
          processingFees: pl.expenses.processingFees,
          // 10/12 (G10): in pl.net too.
          cardFeesRefunded: pl.expenses.cardFeesRefunded,
          maintRequestCount: parseInt(maintStats?.request_count || 0),
          workTradeValue: workTradeVal,
        },
        deposits: {
          totalHeld: parseFloat(depositStats?.total_deposits || 0),
        },
        // S655 (Nic): money that arrived this year for next year's bills —
        // counted this year (it arrived), $0 next year when it pays them.
        // Only a FINISHED year's leftover is that: for the year still running
        // the figure is what is unused as of today, which includes money for
        // this year's own later bills, so it says only what it is (§2:
        // "Paid ahead, not used yet").
        paidAheadUnusedAtYearEnd: pl.beside.paidAheadUnused,
        paidAheadNextYear: { label: paidAheadLeftoverLabel(year), amount: pl.beside.paidAheadUnused },
        beside: pl.besideItems,
        workTrade: workTradeStats,
        monthlyBreakdown,
        // S655: the net IS the P&L's net (income − platform fee − maintenance −
        // lot rent − entered expenses − processing fees the landlord covers),
        // so the tax page and the P&L agree.
        netIncome: pl.net,
        // 10/12 (Nic): Charged / Received / Owed for the year, with the tie,
        // and the net on each money column.
        view: viewForViewer(pl.view, seesTotals),
        nets: pl.nets,
        w2099Threshold: workTradeStats.filter((w:any) => parseFloat(w.credit_value||0) >= 600),
        meta: MONEY_META,
      }
    })
  } catch (e) { next(e) }
})

// ── PER-PROPERTY P&L ──────────────────────────────────────────
reportsRouter.get('/property-pl', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = LEGACY_BASIS
    const seesTotals = seesGrandTotals(req.user)
    const year  = parseInt(req.query.year as string)  || thisYear()   // S654: Phoenix year
    const month = req.query.month ? parseInt(req.query.month as string) : null
    if (month !== null && (month < 1 || month > 12)) throw new AppError(400, 'month must be 1-12')
    // S633: an analytical rollup is about the ACCOUNT, so it spans every company
    // it owns. Scoped to one entity, every figure here silently omitted the
    // other company's money.
    const landlordIds = reportScope(req.user!)
    // S655: a team member assigned to some properties sees only those
    // (gam-audience-data-isolation), as /query and /t12 already did.
    const scopedIds = await getScopedPropertyIds(req.user)
    const start = month ? `${year}-${String(month).padStart(2,'0')}-01` : `${year}-01-01`
    const end   = month ? lastDayOfMonth(year, month) : `${year}-12-31`
    // 10/12 (Nic): the clean cut at a sale — a bookkeeper's former property's
    // rows after the day it left are never read ([] for everyone else).
    const cutoffs = await propertyCutoffsOf(req.user)
    // 10/12 review: a bookkeeper's former properties (sold or moved out while
    // they kept them) are rows here too, read only, up to the day each left.
    // The overview and the P&L count that history (incomeEvents, by company),
    // so without these rows the table did not add up to the P&L it opens: a
    // bookkeeper whose only property sold saw $500 on the overview and an
    // empty table. Their figures are the company's own (the companies this
    // report reads, $1), never the new owner's.
    const former = req.user?.role === 'bookkeeper'
      ? (await bookkeeperRequestScopeOf(req.user)).former
          .filter(f => scopedIds === null || scopedIds.includes(f.propertyId))
      : []
    const formerIds = former.map(f => f.propertyId)

    // Scalar subqueries per concern — NOT multiple LEFT JOINs of payments +
    // maintenance onto units. Joining two one-to-many tables to the same unit
    // fans out (P payments × M maintenance rows), which multiplied each money
    // SUM by the other table's row count whenever a unit had both.
    // 10/11 (Nic): only what the By Property table shows. `p.*` sent every
    // property's lease signer, office email and phone, owner ids and fee
    // settings to whoever opened the report — a bookkeeper included.
    // 10/12 review: every cost is the companies of this report's own ($1), as
    // its income is (helpers above) — a repair the seller paid before a sale is
    // not the buyer's.
    const properties = await query<any>(`
      SELECT p.id, p.name, p.city, p.state, p.type, p.landlord_id,
        -- S616: a service point carries a neighbor's utility bill and is not
        -- this landlord's inventory. Every other count here names a status,
        -- which is why this bare one was the place it still leaked in.
        (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id
          AND u.status <> 'utility_service') AS total_units,
        (SELECT COUNT(*) FROM units u
           JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
          WHERE u.property_id = p.id AND vuo.is_occupied) AS occupied_units,
        (SELECT COALESCE(SUM(mr.actual_cost), 0) FROM maintenance_requests mr
           JOIN units u ON u.id = mr.unit_id
          WHERE u.property_id = p.id AND mr.landlord_id = ANY($1::uuid[])
            AND ${maintenanceCostNotBilledSql('mr')}
            -- S654: the bare-date end is the whole last day, as the P&L counts it.
            AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
            AND ${withinCutoffsSql('p.id', propertyDaySql('mr.completed_at', 'p'), '$6')}) AS maint_cost,
        -- S655: the drill-in's own lot rent and entered expenses, so the row's
        -- net equals the drill-in's net.
        ${propertyLotRentSql('p.id', '$2', '$3', '$1', '$6')} AS lot_rent,
        ${propertyEnteredExpensesSql('p.id', '$2', '$3', '$1', '$6')} AS entered_expenses
      FROM properties p
      WHERE (p.landlord_id = ANY($1::uuid[])
             AND ($4::uuid[] IS NULL OR p.id = ANY($4::uuid[])))
         OR p.id = ANY($5::uuid[])
      ORDER BY p.name`,
      [landlordIds, start, end, scopedIds, formerIds, cutoffsParam(cutoffs)])

    // S655: income per property from the one set of money facts.
    // 10/12 (Nic): both kinds — Charged, Received and Owed per property.
    const both = await incomeBoth({ landlordIds, start, end, propertyIds: scopedIds, cutoffs })
    const events = both.received
    const groupBy = (list: readonly IncomeEvent[]) => {
      const m = new Map<string, IncomeEvent[]>()
      for (const e of list) {
        if (!e.propertyId) continue
        const l = m.get(e.propertyId)
        if (l) l.push(e); else m.set(e.propertyId, [e])
      }
      return m
    }
    const incomeBy = groupBy(events)
    const billedBy = groupBy(both.billed)
    const periodLabel = month ? monthWords(`${year}-${String(month).padStart(2, '0')}`) : String(year)

    // Platform fee per property = GAM's actual billed income over the period
    // (accruals + live estimate for un-accrued months), period-based and
    // short-stay-aware. The maintenance platform fee is never surfaced.
    // S655: landlord net = income − platform fee − maintenance − lot rent −
    // entered expenses: the drill-in's net, line for line.
    const feeMonths = periodMonths(year, month)
    const feeMap = await platformFeesByPropertyForEntities(landlordIds, feeMonths)
    await cutFormerPlatformFees(feeMap, landlordIds, feeMonths, cutoffs)
    // 10/11: and the payment processing fees the landlord covers for tenants,
    // as the company P&L subtracts them — so the rows still add up to it.
    const procMap = await processingFeesByProperty(landlordIds, start, end, scopedIds, cutoffs)
    // 10/12 (Nic, G10): and the card fees guests got back with refunds.
    const refundFeeMap = await cardFeesRefundedByProperty(landlordIds, start, end, scopedIds, cutoffs)
    // 10/12 (Nic, ledger P8): on the books, each property's expense accounts.
    const booksExpenses = await ledgerExpensesByProperty(landlordIds, start, end, scopedIds, cutoffs)

    const result = properties.map((p:any) => {
      const inc = summarize(incomeBy.get(p.id) ?? [], basis)
      const le = booksExpenses ? booksExpenses.get(p.id) : null
      const maint    = booksExpenses ? round2(le?.maintenance ?? 0) : round2(parseFloat(p.maint_cost || 0))
      const platFee  = booksExpenses ? round2(le?.platformFee ?? 0) : round2(feeMap.get(p.id) ?? 0)
      const lotRent  = booksExpenses ? round2(le?.lotRent ?? 0) : round2(parseFloat(p.lot_rent || 0))
      const entered  = booksExpenses ? round2(le?.enteredExpenses ?? 0) : round2(parseFloat(p.entered_expenses || 0))
      const proc     = round2(procMap.get(p.id) ?? 0)
      const cardBack = round2(refundFeeMap.get(p.id) ?? 0)
      const expensesTotal = round2(platFee + maint + lotRent + entered + proc + cardBack)
      // On the books the Received net takes the expenses PAID in the period.
      const expensesPaid = booksExpenses ? round2(le?.cashTotal ?? 0) : expensesTotal
      const netIncome = round2(inc.total - expensesPaid)
      // 10/12 (Nic): the three columns and the net on each money column.
      const v = moneyViewFrom(billedBy.get(p.id) ?? [], incomeBy.get(p.id) ?? [], { start, end, label: periodLabel })
      // decisions #25: Owed only for a viewer who sees grand totals (viewForViewer).
      const cols = {
        charged: v.charged, received: v.received, ...(seesTotals ? { owed: v.owed } : {}),
        net_charged: round2(v.charged - expensesTotal), net_received: round2(v.received - expensesPaid),
        ...(booksExpenses ? { expenses_paid: expensesPaid } : {}),
      }
      // 10/12: a former property's row is its history: no units or occupancy
      // today (those are the new owner's), and the last day it was theirs.
      const left = former.find(f => f.propertyId === p.id)
      if (left) {
        return { ...p, landlord_id: landlordIds[0],
          total_units: null, occupied_units: null, occupancy_rate: null, left_on: left.lastDay,
          rent_collected: inc.total, income_total: inc.total, rent_line: inc.lines.rent,
          maint_cost: maint, platform_fees: platFee, lot_rent: lotRent, entered_expenses: entered,
          processing_fees: proc, card_fees_refunded: cardBack, expenses_total: expensesTotal, net_income: netIncome, ...cols }
      }
      return { ...p, ...cols,
        // Kept under its old name: this is the property's income under the basis.
        rent_collected: inc.total, income_total: inc.total, rent_line: inc.lines.rent,
        maint_cost: maint, platform_fees: platFee, lot_rent: lotRent, entered_expenses: entered,
        processing_fees: proc, card_fees_refunded: cardBack, expenses_total: expensesTotal, net_income: netIncome, left_on: null,
        occupancy_rate: parseInt(p.total_units||0) > 0
          ? Math.round((parseInt(p.occupied_units||0) / parseInt(p.total_units||0)) * 100) : 0 }
    })

    res.json({ success: true, data: { year, month, period: { start, end }, properties: result, meta: MONEY_META } })
  } catch (e) { next(e) }
})

// GET /api/reports/site-downtime?year=YYYY[&month=M] — S652 (Nic): "our average
// RV sites, when they go down, they're down for a day or 10 days... another
// metric to have in a reporting category somewhere." Same period rules as the
// P&L beside it: outages that ENDED in the period. Out-right-now is as of today.
reportsRouter.get('/site-downtime', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year as string)  || thisYear()   // S654: Phoenix year
    const month = req.query.month ? parseInt(req.query.month as string) : null
    const start = month ? `${year}-${String(month).padStart(2,'0')}-01` : `${year}-01-01`
    const end   = month ? lastDayOfMonth(year, month) : `${year}-12-31`
    const { siteDowntimeReport } = await import('../services/outOfOrder')
    // S655 (gam-audience-data-isolation): a team member assigned to some
    // properties sees those properties' sites only.
    const scopedIds = await getScopedPropertyIds(req.user)
    const rows = (await siteDowntimeReport(reportScope(req.user!), start, end))
      .filter((r: any) => scopedIds === null || scopedIds.includes(r.property_id))
    res.json({ success: true, data: { year, month, period: { start, end }, rows } })
  } catch (e) { next(e) }
})

// ── PER-PROPERTY DETAIL DRILL-IN ──────────────────────────────
// GET /api/reports/property-detail?propertyId=UUID&year=YYYY[&month=M]
// Backs the click-into-a-property drill-in on the By Property tab. Same
// period semantics as /property-pl (month omitted = full calendar year) so
// the modal reconciles with the row the user clicked.
//
// S655, decision #4 (Nic): "here's the total collected... I want to see how
// much electric was billed back, property-wide... the distinction between lot
// rent collected, late fees, trailer payments, etc." It LEADS with:
//   1. breakdown — income by category (lot/space rent, each utility, late
//      fees, home/trailer payments, other fees, register sales, stays and pay
//      links, other income), billed vs collected, under the switch; then the
//      lines with no category (paid ahead, deposit deductions, ...)
//   2. expenses — GAM platform fee, maintenance, lot rent, entered expenses
//   3. net
// and only then the lists (rent roll, payments, maintenance), which the page
// shows collapsed. The dashboard property-health card reads the same
// categoryTotals, so the two agree.
// Scoped to the caller's landlord; a property owned by anyone else returns 404.
reportsRouter.get('/property-detail', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = LEGACY_BASIS
    const propertyId = req.query.propertyId as string
    if (!propertyId) throw new AppError(400, 'propertyId is required')
    const year  = parseInt(req.query.year as string)  || thisYear()   // S654: Phoenix year
    const month = req.query.month ? parseInt(req.query.month as string) : null
    if (month !== null && (month < 1 || month > 12)) throw new AppError(400, 'month must be 1-12')
    // S633: the company is the one that owns the property being reported on —
    // derived, not guessed from session state. Authorized below by the same
    // landlord_id filter that has always been there.
    const landlordIds = reportScope(req.user!)
    // S655: a team member assigned to other properties gets the same 404 as a stranger.
    const scopedIds = await getScopedPropertyIds(req.user)
    if (scopedIds && !scopedIds.includes(propertyId)) throw new AppError(404, 'Property not found')
    // 10/12 review: a bookkeeper's former property (sold or moved out while they
    // kept it) opens too — its history up to the day it left, read only, from
    // the company's own rows (the By Property row it is opened from).
    const left = req.user?.role === 'bookkeeper'
      ? (await bookkeeperRequestScopeOf(req.user)).former.find(f => f.propertyId === propertyId) ?? null
      : null
    const cutoffs = await propertyCutoffsOf(req.user)
    const cut = cutoffsParam(cutoffs)

    const start = month ? `${year}-${String(month).padStart(2,'0')}-01` : `${year}-01-01`
    const end   = month ? lastDayOfMonth(year, month) : `${year}-12-31`
    const yearStart = `${year}-01-01`, yearEnd = `${year}-12-31`

    const property = await queryOne<any>(`
      SELECT p.id, p.name, p.city, p.state, p.type, p.landlord_id,
        -- S616: a service point carries a neighbor's utility bill and is not
        -- this landlord's inventory. Every other count here names a status,
        -- which is why this bare one was the place it still leaked in.
        (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id
          AND u.status <> 'utility_service') AS total_units,
        (SELECT COUNT(*) FROM units u
           JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
          WHERE u.property_id = p.id AND vuo.is_occupied) AS occupied_units
      FROM properties p
      WHERE p.id = $1 AND (p.landlord_id = ANY($2::uuid[]) OR $3::boolean)`, [propertyId, landlordIds, !!left])
    if (!property) throw new AppError(404, 'Property not found')

    const occupied = parseInt(property.occupied_units || '0', 10)
    const totalUnits = parseInt(property.total_units || '0', 10)
    // 10/12 review: the facts are the companies of this report's own — the
    // same ones the By Property row reads (/property-pl: incomeEvents and every
    // cost by $1) — so the drill-in's net is the row's net. It read the
    // property's CURRENT owner only, so for a property moved between two of the
    // account's companies the row and the drill-in disagreed, and a former
    // property (now someone else's) would have read the new owner's money.
    const scope = { landlordIds, propertyIds: [propertyId], cutoffs }

    // 1. Income by category — 10/12 (Nic): Charged, Received and Owed side by
    // side (both kinds of facts, read once for the breakdown, the payments
    // behind it and the three columns).
    const both = await incomeBoth({ ...scope, start, end })
    const breakdown = breakdownFrom(basis, both.billed, both.received)
    const periodLabel = month ? monthWords(`${year}-${String(month).padStart(2, '0')}`) : String(year)
    const view = moneyViewFrom(both.billed, both.received, { start, end, label: periodLabel }, both.paidAheadUnused)

    // 2. Expenses as line items.
    // Platform fee = GAM's actual billed income for this property over the period
    // (accruals + live estimate for un-accrued months) — period-based and
    // short-stay-aware, so a property that earned rent never shows a $0 fee. The
    // maintenance platform fee is never surfaced; landlord pays only actual cost.
    const feeMonths = periodMonths(year, month)
    const feeMap = await platformFeesByPropertyForEntities(landlordIds, feeMonths, propertyId)
    await cutFormerPlatformFees(feeMap, landlordIds, feeMonths, cutoffs)
    const platformFee = round2(feeMap.get(propertyId) ?? 0)
    // 10/12 review: the companies' own repairs (a repair the seller paid before
    // a sale is not the buyer's), cut at a former property's last day.
    const maintenance = await query<any>(`
      SELECT mr.id, mr.title, mr.category, mr.status, mr.actual_cost, mr.completed_at,
        u.unit_number
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      JOIN properties mp ON mp.id = u.property_id
      WHERE u.property_id = $1 AND mr.landlord_id = ANY($4::uuid[])
        -- S654: the bare-date end is the whole last day, as the P&L counts it.
        AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
        AND mr.actual_cost IS NOT NULL
        -- 10/12 review (Nic L6): a repair with a live bill counts once, on the
        -- bill (in entered expenses below), as the By Property row counts it.
        AND ${maintenanceCostNotBilledSql('mr')}
        AND ${withinCutoffsSql('u.property_id', propertyDaySql('mr.completed_at', 'mp'), '$5')}
      ORDER BY mr.completed_at DESC`, [propertyId, start, end, landlordIds, cut])
    const maintCost = round2(maintenance.reduce((s: number, m: any) => s + parseFloat(m.actual_cost || 0), 0))
    // The same lot rent and entered expenses the By Property row subtracts.
    const otherCosts = await queryOne<{ lot: string; entered: string }>(`
      SELECT ${propertyLotRentSql('$1::uuid', '$2', '$3', '$4', '$5')}::text AS lot,
             ${propertyEnteredExpensesSql('$1::uuid', '$2', '$3', '$4', '$5')}::text AS entered`,
      [propertyId, start, end, landlordIds, cut])
    const lotRent = round2(parseFloat(otherCosts?.lot ?? '0'))
    const enteredExpenses = round2(parseFloat(otherCosts?.entered ?? '0'))
    // 10/11: the processing fees the landlord covers, as the By Property row
    // and the company P&L subtract them.
    const processingFees = round2(
      (await processingFeesByProperty(landlordIds, start, end, [propertyId], cutoffs)).get(propertyId) ?? 0)
    // 10/12 (Nic, G10): the card fees guests got back with refunds, as the row and the P&L subtract them.
    const cardFeesRefunded = round2(
      (await cardFeesRefundedByProperty(landlordIds, start, end, [propertyId], cutoffs)).get(propertyId) ?? 0)
    // 10/12 (Nic, ledger P8): on the books, the property's expense accounts —
    // the same figures its By Property row takes.
    const booksExpenses = (await ledgerExpensesByProperty(landlordIds, start, end, [propertyId], cutoffs))?.get(propertyId) ?? null
    const onBooks = !!(await ledgerReportsLive(landlordIds))
    const ex = onBooks
      ? {
          platformFee: round2(booksExpenses?.platformFee ?? 0), maintenance: round2(booksExpenses?.maintenance ?? 0),
          lotRent: round2(booksExpenses?.lotRent ?? 0), enteredExpenses: round2(booksExpenses?.enteredExpenses ?? 0),
        }
      : { platformFee, maintenance: maintCost, lotRent, enteredExpenses }
    const expensesTotal = round2(ex.platformFee + ex.maintenance + ex.lotRent + ex.enteredExpenses + processingFees + cardFeesRefunded)
    const expensesPaid = onBooks ? round2(booksExpenses?.cashTotal ?? 0) : expensesTotal

    // 3. Net.
    const net = round2(breakdown.total - expensesPaid)

    // The lists, after the breakdown.
    const isBookkeeper = req.user?.role === 'bookkeeper'
    // 10/11 (Nic): the property's rent roll — unit, status, rent, occupied and
    // the tenant's NAME — is a bookkeeper's too (names are allowed wherever the
    // books need them). No contact column is selected, so none can reach them.
    // 10/12: a former property's units today are the new owner's — none here.
    const units = left ? [] : await query<any>(`
      SELECT u.id, u.unit_number, u.status, u.bedrooms, u.bathrooms, u.rent_amount,
        vuo.is_occupied,
        vuo.primary_first_name AS tenant_first, vuo.primary_last_name AS tenant_last
      FROM units u
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE u.property_id = $1
      ORDER BY u.unit_number`, [propertyId])

    const events = both.received
    const { rows: paymentRows } = await chargesBehind(events)
    const depositsHeld = summarize(events, basis).beside.depositsHeld

    // Calendar-year income per month — the modal's mini trend. 10/12: Charged
    // beside Received for each month.
    const yearBoth = month === null ? both : await incomeBoth({ ...scope, start: yearStart, end: yearEnd })
    const yearBilledBy = byMonth(yearBoth.billed)
    const yearReceivedBy = byMonth(yearBoth.received)
    const trend = [...new Set([...yearReceivedBy.keys(), ...yearBilledBy.keys()])]
      .map(m => ({
        month: m,
        collected: summarize(yearReceivedBy.get(m) ?? [], basis).total,
        charged: summarize(yearBilledBy.get(m) ?? [], 'billed').total,
      }))
      .filter(t => t.collected !== 0 || t.charged !== 0)
      .sort((x, y) => x.month.localeCompare(y.month))

    res.json({ success: true, data: {
      property: {
        id: property.id, name: property.name, city: property.city, state: property.state, type: property.type,
        // 10/12: a former property's history carries no units or occupancy
        // today (the new owner's), and says the last day it was theirs.
        totalUnits: left ? null : totalUnits, occupiedUnits: left ? null : occupied,
        occupancyRate: left ? null : (totalUnits > 0 ? Math.round(100 * occupied / totalUnits) : 0),
        leftOn: left?.lastDay ?? null,
      },
      period: { year, month, start, end },
      breakdown: { categories: breakdown.categories, lines: breakdown.lines, total: breakdown.total },
      expenses: {
        ...ex, processingFees, cardFeesRefunded, total: expensesTotal,
        // 10/12 (ledger P8): on the books, what was paid in the period and each account.
        ...(onBooks ? { paid: expensesPaid, byAccount: booksExpenses?.byAccount ?? [] } : {}),
      },
      net,
      // 10/12 (Nic): Charged / Received / Owed, the tie, and the net on each money column.
      view: viewForViewer(view, seesGrandTotals(req.user)),
      nets: { charged: round2(view.charged - expensesTotal), received: round2(view.received - expensesPaid) },
      // Kept for the existing screen: collected = the breakdown's total under the basis.
      summary: { collected: breakdown.total, maintCost: ex.maintenance, platformFee: ex.platformFee, net, depositsHeld },
      units: units.map((u: any) => ({
        id: u.id, unitNumber: u.unit_number, status: u.status,
        bedrooms: u.bedrooms, bathrooms: parseFloat(u.bathrooms),
        rent: parseFloat(u.rent_amount || 0), isOccupied: !!u.is_occupied,
        tenantName: [u.tenant_first, u.tenant_last].filter(Boolean).join(' ') || null,
      })),
      payments: paymentRows,
      // 10/11 (Nic): "They don't need to see all the maintenance reports" — a
      // bookkeeper gets the cost and its kind, never the request's own words
      // (a title often names the resident or the problem in their home).
      maintenance: maintenance.map((m: any) => {
        const categoryLabel = MAINTENANCE_CATEGORY_LABEL[m.category as MaintenanceCategory] ?? 'General / Other'
        const cost = {
          id: m.id, categoryLabel, status: m.status,
          actualCost: parseFloat(m.actual_cost || 0),
          completedAt: m.completed_at, unitNumber: m.unit_number ?? null,
        }
        return isBookkeeper ? cost : { ...cost, title: m.title }
      }),
      monthlyTrend: trend,
      meta: { ...MONEY_META, listsAfterBreakdown: true },
    } })
  } catch (e) { next(e) }
})

// ── WORK TRADE 1099 SUMMARY ───────────────────────────────────
reportsRouter.get('/work-trade-1099', requirePerm('books.view'), async (req, res, next) => {
  try {
    const year = parseInt(req.query.year as string) || thisYear()   // S654: Phoenix year
    // S633: a STATEMENT belongs to one company — it carries that company's name
    // and EIN, and an LLC files its own return. Summing two together produces a
    // document that is wrong on its face, so this asks which when the account
    // owns more than one.
    const landlordId = reportEntity(req.user!, req.query.landlordId)
    await refuseScopedStaff(req.user, '1099 work-trade summary')

    const landlord = await queryOne<any>(`
      SELECT l.*, u.first_name, u.last_name, u.email, l.ein
      FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id=$1`, [landlordId])

    // S408 fix: pre-fix SELECTed `t.ein as tenant_ein`, but tenants table
    // has no ein column (it exists on landlords + pm_companies +
    // books_contractors only). Route always 500'd with 42703 — the
    // 1099 work-trade summary surface was completely dead in production.
    // Surgical fix: drop the broken SELECT. Tenant TIN storage is a
    // separate hygiene item; nowhere to capture it today, so we can't
    // return it even if we wanted to.
    // S517: report the actual work-trade credit applied to invoices that
    // year as the bartered value (the retired tax_year + ytd_value dollar
    // ledger is gone). Only agreements with real credit in the year appear.
    const agreements = await query<any>(`
      SELECT wta.*,
        u.unit_number, p.name as property_name,
        us.first_name as tenant_first, us.last_name as tenant_last,
        us.email as tenant_email,
        COALESCE((SELECT SUM(i.work_trade_credit_amount) FROM invoices i
                   WHERE i.work_trade_agreement_id = wta.id
                     AND EXTRACT(YEAR FROM i.due_date) = $2), 0) AS credit_value
      FROM work_trade_agreements wta
      JOIN units u ON u.id = wta.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN tenants t ON t.id = wta.tenant_id
      JOIN users us ON us.id = t.user_id
      WHERE wta.landlord_id=$1
        AND COALESCE((SELECT SUM(i.work_trade_credit_amount) FROM invoices i
                       WHERE i.work_trade_agreement_id = wta.id
                         AND EXTRACT(YEAR FROM i.due_date) = $2), 0) > 0
      ORDER BY us.last_name, us.first_name`,
      [landlordId, year])

    const eligible   = agreements.filter((a:any) => parseFloat(a.credit_value||0) >= 600)
    const totalValue = agreements.reduce((s:number, a:any) => s + parseFloat(a.credit_value||0), 0)

    res.json({
      success: true,
      data: { year, landlord, agreements, eligible,
        summary: { totalAgreements: agreements.length, eligible1099Count: eligible.length, totalValue } }
    })
  } catch (e) { next(e) }
})

// ============================================================
// S603 (Nic) — FLEXIBLE REPORTING. "We should be able to generate reports for
// any combination of events and timelines and tables."
//
// Every endpoint above is a fixed-shape report. These two run the shared engine
// (services/reportEngine.ts) so a new report is a set of PARAMETERS, not a new
// endpoint: any date range × portfolio|property|unit × total|monthly|daily.
// 10/12 (Nic): no switch. Income is Money received; every row also carries
// Charged and Owed (row.money) and the net on Charged (row.netCharged).
// ============================================================

// GET /api/reports/query — the general engine.
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD&level=property&bucket=monthly
reportsRouter.get('/query', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = LEGACY_BASIS
    // S633: an analytical rollup is about the ACCOUNT, so it spans every company
    // it owns. Scoped to one entity, every figure here silently omitted the
    // other company's money.
    const landlordIds = reportScope(req.user!)

    const start = String(req.query.start || '')
    const end   = String(req.query.end   || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new AppError(400, 'start and end are required as YYYY-MM-DD')
    }
    if (start > end) throw new AppError(400, 'start must be on or before end')

    const level  = String(req.query.level  || 'portfolio') as ReportLevel
    const bucket = String(req.query.bucket || 'total')     as ReportBucket
    if (!REPORT_LEVELS.includes(level))   throw new AppError(400, `level must be one of ${REPORT_LEVELS.join(', ')}`)
    if (!REPORT_BUCKETS.includes(bucket)) throw new AppError(400, `bucket must be one of ${REPORT_BUCKETS.join(', ')}`)

    // A daily bucket over years of data is a self-inflicted denial of service;
    // cap the row count rather than letting one request scan everything.
    if (bucket === 'daily') {
      const days = Math.round(
        (new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1
      if (days > 400) throw new AppError(400, 'A daily report is limited to 400 days — narrow the range or use a monthly bucket.')
    }

    // Property scope: a team member assigned to specific properties must never
    // pull portfolio-wide money (gam-audience-data-isolation). null = owner.
    const scopedIds = await getScopedPropertyIds(req.user)

    const result = await runReport({ landlordIds, start, end, level, bucket, propertyIds: scopedIds, basis })
    // decisions #25: Owed only for a viewer who sees grand totals (viewForViewer).
    const sees = seesGrandTotals(req.user)
    res.json({
      success: true,
      data: {
        rows: result.rows.map(r => engineRowForViewer(r, sees)),
        totals: engineRowForViewer(result.totals, sees),
        meta: {
          start, end, level, bucket,
          ...(result.source === 'ledger' ? LEDGER_MONEY_META : MONEY_META),
          // Stated, not silent: the platform fee accrues monthly per property,
          // so a daily bucket cannot attribute it to a day without inventing
          // precision. Callers must show this rather than imply $0 of fee.
          // 10/12 (ledger P8): on the books each GAM charge has its own day.
          platformFeeIncluded: bucket !== 'daily' || result.source === 'ledger',
          // S655: lot rent is billed by the month too — the same rule.
          lotRentIncluded: bucket !== 'daily' || result.source === 'ledger',
          occupancyBasis: 'current',
          ...(result.source ? { source: result.source } : {}),
        },
      },
    })
  } catch (e) { next(e) }
})

// GET /api/reports/t12 — trailing twelve months, month by month, per property.
// The artifact a listing agent, buyer, or lender asks for when a property goes
// on the market. Deliberately a PRESET over the same engine: if the engine's
// numbers move, this moves with them and can never tell a different story than
// the landlord's own P&L.
reportsRouter.get('/t12', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = LEGACY_BASIS
    // S633: an analytical rollup is about the ACCOUNT, so it spans every company
    // it owns. Scoped to one entity, every figure here silently omitted the
    // other company's money.
    const landlordIds = reportScope(req.user!)

    // Trailing twelve FULL months ending with last month — the current partial
    // month is excluded on purpose, because a T-12 that includes a half-finished
    // month understates income and misleads whoever is reading it.
    // S654: anchored on today's Phoenix date (UTC midnight of it, so the UTC
    // getters below read the Phoenix month). The raw UTC clock is next month
    // after 5 pm on the last day, which pulled the partial month in.
    const anchor = new Date(req.query.asOf ? String(req.query.asOf) : todayIn(null))
    if (isNaN(anchor.getTime())) throw new AppError(400, 'asOf must be a valid date')
    const endD   = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 0))
    const startD = new Date(Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth() - 11, 1))
    const iso    = (d: Date) => d.toISOString().slice(0, 10)

    const propertyId = req.query.propertyId ? String(req.query.propertyId) : null
    const scopedIds  = await getScopedPropertyIds(req.user)
    let propertyIds  = scopedIds
    if (propertyId) {
      // An explicit property must still be inside the caller's scope.
      if (scopedIds && !scopedIds.includes(propertyId)) {
        throw new AppError(403, 'Property not in your assigned scope')
      }
      propertyIds = [propertyId]
    }

    const result = await runReport({
      landlordIds, start: iso(startD), end: iso(endD),
      level: 'property', bucket: 'monthly', propertyIds, basis,
    })
    // decisions #25: Owed only for a viewer who sees grand totals (viewForViewer).
    const sees = seesGrandTotals(req.user)
    res.json({
      success: true,
      data: {
        rows: result.rows.map(r => engineRowForViewer(r, sees)),
        totals: engineRowForViewer(result.totals, sees),
        meta: {
          report: 'T-12', start: iso(startD), end: iso(endD),
          months: 12, level: 'property', bucket: 'monthly',
          ...(result.source === 'ledger' ? LEDGER_MONEY_META : MONEY_META),
          platformFeeIncluded: true, lotRentIncluded: true, occupancyBasis: 'current',
          ...(result.source ? { source: result.source } : {}),
          // 10/12 (Nic): no switch — income is the money that arrived; Charged and Owed are beside it.
          // 10/12 (ledger P8): on the books, Owed is what was still owed at each month's end.
          note: `Trailing twelve complete months. The current partial month is excluded. Income is money received, on the day it arrived; ${MONEY_COLUMN_LABEL.charged} (${MONEY_COLUMN_NOTE.charged.toLowerCase()}) and ${MONEY_COLUMN_LABEL.owed} ${result.source === 'ledger' ? '(what tenants still owed at each month\'s end) ' : ''}are shown beside it.`,
        },
      },
    })
  } catch (e) { next(e) }
})

// ============================================================
// 10/12 (Nic) — THE MONTHLY PROPERTY REPORT
//
//   All four groups — tenants & leases, payments, money, operations — for each
//   property, on screen (the Reports page's Monthly report tab) and as a PDF,
//   and emailed at month close with the PDF to the recipients the owner picks
//   (jobs/monthlyPropertyReportEmail). services/monthlyPropertyReport builds
//   it from the services that own each figure.
// ============================================================

/** ?month=YYYY-MM, else last month on GAM's home calendar (a report covers a finished month). */
function reportMonthOf(raw: unknown): string {
  const today = todayIn(null)
  if (raw === undefined || raw === null || raw === '') return previousMonth(today)
  const m = String(Array.isArray(raw) ? raw[0] : raw)
  monthBounds(m)   // 400 unless YYYY-MM
  if (m > today.slice(0, 7)) throw new AppError(400, 'That month has not started yet.')
  return m
}

/**
 * One company (a report carries its name), and the properties this caller may
 * see in it — a team member assigned to some properties gets those only
 * (gam-audience-data-isolation) — narrowed to ?propertyId when one is named.
 *
 * 10/12 (Nic): a bookkeeper sees it only with the owner's box ("Sees the
 * monthly property report on screen"), and only for the properties they keep
 * that the company owns today. A whole-company bookkeeper's properties are
 * named one by one rather than read as "the whole company", so the report's
 * line for money outside the listed properties (which holds a sold
 * property's) is never built for them.
 */
async function monthlyReportScope(req: any): Promise<{ landlordId: string; propertyIds: string[] | null }> {
  const landlordId = reportEntity(req.user!, req.query.landlordId)
  let scoped = await getScopedPropertyIds(req.user)
  if (req.user?.role === 'bookkeeper') {
    const bk = await bookkeeperRequestScopeOf(req.user)
    if (!bk.seesMonthlyReport || bk.keepsNothing) throw new AppError(403, MONTHLY_REPORT_REFUSAL)
    scoped = bk.currentIds ?? (await query<{ id: string }>(
      `SELECT id FROM properties WHERE landlord_id = $1 ORDER BY name, id`, [landlordId])).map(r => r.id)
  }
  const one = req.query.propertyId ? String(req.query.propertyId) : null
  if (!one) return { landlordId, propertyIds: scoped }
  if (!/^[0-9a-f-]{36}$/i.test(one)) throw new AppError(400, 'propertyId is not valid')
  if (scoped && !scoped.includes(one)) throw new AppError(404, 'Property not found')
  return { landlordId, propertyIds: [one] }
}

// GET /api/reports/monthly-report?month=YYYY-MM[&landlordId][&propertyId]
// 10/12 review: the report opens on its own permission — the Monthly report
// tab's ("reports.tab.monthly", sensitive) — the key the Reports page shows the
// tab for. Gated on "View all payments" it refused the staffer the tab was
// granted to and opened to one it was not. Owners pass. 10/12 (Nic): a
// bookkeeper holds the key only with the owner's box (lib/bookkeeperAccess
// bookkeeperHasPerm), and monthlyReportScope checks the box again and keeps
// them to their current properties. Property scope still applies.
reportsRouter.get('/monthly-report', requirePerm('reports.tab.monthly'), async (req, res, next) => {
  try {
    const month = reportMonthOf(req.query.month)
    const { landlordId, propertyIds } = await monthlyReportScope(req)
    const report = await buildMonthlyPropertyReport({ landlordId, month, propertyIds })
    res.json({ success: true, data: { ...report, meta: MONEY_META } })
  } catch (e) { next(e) }
})

// GET /api/reports/monthly-report/pdf?month=YYYY-MM[&landlordId][&propertyId] — the same report, as the emailed PDF.
reportsRouter.get('/monthly-report/pdf', requirePerm('reports.tab.monthly'), async (req, res, next) => {
  try {
    const month = reportMonthOf(req.query.month)
    const { landlordId, propertyIds } = await monthlyReportScope(req)
    const report = await buildMonthlyPropertyReport({ landlordId, month, propertyIds })
    const pdf = await renderMonthlyReportPdf(report)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${monthlyReportFilename(report)}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.send(pdf)
  } catch (e) { next(e) }
})

/** 10/12 (Nic): "owner/admin only to edit" the recipient list. */
const RECIPIENT_EDITOR_ROLES = new Set(['landlord', 'admin', 'super_admin'])
function assertRecipientEditor(user: any): void {
  if (!RECIPIENT_EDITOR_ROLES.has(user?.role)) {
    throw new AppError(403, 'Only the account owner chooses who gets the monthly report.')
  }
}

async function recipientsReply(landlordId: string) {
  // 10/12 (Nic): a send stuck at 'sending' reads "Not sent — stuck, GAM was
  // alerted" on this list (lastSends) — so GAM is told before it says so: the
  // stuck-send notice, once per send, for this company (the hourly job raises
  // the same one; whichever comes first). Never stops the list from loading.
  // 10/12 (Nic, review): when it fails, no notice exists, and the list says
  // "Not sent — stuck" — "GAM was alerted" only where the notice is on record
  // (services/monthlyPropertyReport lastSends).
  try {
    const { noticeStuckSends } = await import('../jobs/monthlyPropertyReportEmail')
    await noticeStuckSends(new Date(), [landlordId])
  } catch (e) {
    logger.error({ err: e, landlordId }, '[monthly-report] could not check for stuck sends')
  }
  const team = await companyTeam(landlordId)
  const list = await recipientsOf(landlordId, team)
  return {
    canEdit: true,
    isDefault: list.isDefault,
    recipients: list.recipients.map(r => ({
      kind: r.kind, userId: r.userId, email: r.email, name: r.name, roleLabel: r.roleLabel,
      allProperties: r.propertyIds === null, propertyCount: r.propertyIds ? r.propertyIds.length : null,
    })),
    leftTeam: list.leftTeam,
    // Everyone the owner can pick from their own team, with how much of the company each one sees.
    team: team.map(m => ({
      userId: m.userId, name: m.name, email: m.email, roleLabel: m.roleLabel,
      allProperties: m.propertyIds === null, propertyCount: m.propertyIds ? m.propertyIds.length : null,
    })),
    lastSends: await lastSends(landlordId),
    maxExtraEmails: MONTHLY_REPORT_MAX_EXTRA_EMAILS,
  }
}

// GET /api/reports/monthly-report/recipients[?landlordId] — owner / admin only.
reportsRouter.get('/monthly-report/recipients', async (req, res, next) => {
  try {
    assertRecipientEditor(req.user)
    const landlordId = reportEntity(req.user!, req.query.landlordId)
    res.json({ success: true, data: await recipientsReply(landlordId) })
  } catch (e) { next(e) }
})

// POST /api/reports/monthly-report/recipients — owner / admin only. The whole
// list: the team members picked and any other addresses. A recipient dropped
// is stamped removed (keep everything); an empty list sends to nobody.
const MonthlyRecipientsBody = z.object({
  landlordId: z.string().uuid().optional(),
  teamMemberIds: z.array(z.string().uuid()).max(500),
  emails: z.array(z.string().trim().max(254)).max(MONTHLY_REPORT_MAX_EXTRA_EMAILS),
})
reportsRouter.post('/monthly-report/recipients', async (req, res, next) => {
  try {
    assertRecipientEditor(req.user)
    const body = MonthlyRecipientsBody.parse(req.body ?? {})
    const landlordId = reportEntity(req.user!, body.landlordId ?? req.query.landlordId)
    await saveRecipients(landlordId, req.user!.userId, body.teamMemberIds, body.emails)
    res.json({ success: true, data: await recipientsReply(landlordId) })
  } catch (e) { next(e) }
})

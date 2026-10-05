import { Router } from 'express'
import { collectedRentMtd, incomeCardFrom } from '../lib/rentCollected'
import { occupancyRateFrom, INCOME_CATEGORY_LABEL, type IncomeBasis } from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm, getScopedPropertyIds } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds, resolveLandlordTarget } from '../lib/landlordScope'
import { platformFeesByPropertyForEntities, periodMonths } from '../services/platformFee'
import { computeLandlordPL, landlordPLExpenses, landlordIncomeSql, landlordDepositSql } from '../services/landlordPL'
import { seesGrandTotals } from '../services/openBalances'
import {
  parseIncomeBasis, basisMeta, incomeEvents, summarize, byMonth, categoryTotals, partList,
  type IncomeEvent,
} from '../services/incomeBasis'
import { todayIn, addDaysTo, monthStartOf, localDateTimeToUtc } from '../lib/timezone'
import {
  runReport, REPORT_LEVELS, REPORT_BUCKETS,
  type ReportLevel, type ReportBucket,
} from '../services/reportEngine'

export const reportsRouter = Router()
// S127: blanket requireLandlord lifted in favor of per-route perm gates.
// All reports require auth; specific perms gate per endpoint below.
// Owners auto-pass requirePerm via OWNER_ROLES short-circuit.
reportsRouter.use(requireAuth)

// S654: report periods follow GAM's home calendar — Phoenix, the zone
// todayIn(null) reads and the database's CURRENT_DATE uses — never the UTC
// date, which turns over at 5 pm here.
// S655: income itself is dated on each PROPERTY's own calendar day
// (services/incomeBasis); these bounds are the days of the period.
const REPORT_TZ = 'America/Phoenix'

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
 */
function propertyLotRentSql(p: string, s: string, e: string): string {
  return `(SELECT COALESCE(SUM(lrc.amount), 0) FROM lot_rent_charges lrc
            WHERE lrc.property_id = ${p} AND lrc.billing_month >= ${s}::date AND lrc.billing_month <= ${e}::date)`
}
function propertyEnteredExpensesSql(p: string, s: string, e: string): string {
  return `(SELECT COALESCE(SUM(lex.amount), 0) FROM landlord_expenses lex
            WHERE lex.property_id = ${p} AND lex.status = 'active'
              AND lex.expense_date >= ${s}::date AND lex.expense_date <= ${e}::date)`
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

const MANUAL_LABEL: Record<string, string> = { cash: 'Cash', check: 'Check', money_order: 'Money order', prior_arrangement: 'Prior arrangement' }
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
 */
export async function refuseScopedStaff(user: any, what: string): Promise<void> {
  if (await getScopedPropertyIds(user) !== null) {
    throw new AppError(403, `The ${what} covers the whole company, and you are assigned to some of its properties. Ask the owner for it.`)
  }
}

// ── SUMMARY (S69) ─────────────────────────────────────────────
// GET /api/reports/summary[?basis=received|billed]
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
//   monthly[]        — last 6 months: collected (= that month's P&L total),
//                      rent, disbursed, fees, net
//   ownerVsManager   — split of landlord's manager_fee vs owner_share
//                      ledger entries this month (16a)
reportsRouter.get('/summary', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = parseIncomeBasis(req.query.basis)
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin'
    // S633: spans every entity the account owns. Scoped to one entity, the
    // headline figures on the Reports page silently excluded the other
    // company's rent — a number that is wrong with no sign that it is wrong.
    const landlordIds = isAdmin ? null : reportScope(req.user!)
    // S655 (gam-audience-data-isolation): a team member assigned to some
    // properties sees those properties' money only — every figure below.
    const scopedIds = isAdmin ? null : await getScopedPropertyIds(req.user)
    const userId = req.user!.userId

    // S655: each month's figure IS that month's P&L total under the basis —
    // the row and the P&L it opens can never disagree. Calendar months by the
    // Phoenix clock, the current one included.
    const months = lastMonths(6)
    const today = todayIn(null)
    const yearStart = `${today.slice(0, 4)}-01-01`
    const windowStart = months[0] + '-01' < yearStart ? months[0] + '-01' : yearStart
    const events = await incomeEvents({
      landlordIds, start: windowStart, end: monthDays(months[months.length - 1]).last, basis,
      propertyIds: scopedIds,
    })
    const perMonth = byMonth(events)
    const monthTotals = (ym: string) => summarize(perMonth.get(ym) ?? [], basis)

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
    if (landlordIds) {
      await Promise.all(months.map(async ym => {
        const [y, m] = ym.split('-').map(Number)
        const { start, end } = monthRange(y, m)
        const perCompany = await Promise.all(landlordIds.map(lid =>
          landlordPLExpenses(lid, start, end, periodMonths(y, m), scopedIds)))
        monthExpenses.set(ym, round2(perCompany.reduce((s, e) => s + e.total, 0)))
      }))
    }
    const monthly = [...months].reverse().map(month => {
      const t = monthTotals(month)
      const d = disb.get(month) ?? { disbursed: 0, fees: 0 }
      const expenses = landlordIds ? (monthExpenses.get(month) ?? 0) : null
      return {
        month,
        collected: t.total,
        rent: t.lines.rent,
        disbursed: d.disbursed,
        fees: d.fees,
        expenses,
        net: expenses == null ? null : round2(t.total - expenses),
      }
    })

    // S642/S655: the dashboard's cards, from the same facts and the same rules
    // (lib/rentCollected), so Reports and the dashboard cannot disagree. Money
    // still clearing is its own figure beside what arrived.
    const [rentCard, allCard] = await Promise.all([
      collectedRentMtd(landlordIds, scopedIds, { scope: 'rent', basis }),
      collectedRentMtd(landlordIds, scopedIds, { scope: 'all', basis }),
    ])
    const incomeCard = incomeCardFrom(allCard, basis)
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
    const showOutstanding = seesGrandTotals(req.user)
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
        `, [landlordIds, scopedIds])
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
    const ytdMonthly: Array<{ month: string; collected: number }> = []
    for (let m = 1; m <= Number(today.slice(5, 7)); m++) {
      const ym = `${today.slice(0, 4)}-${String(m).padStart(2, '0')}`
      const t = monthTotals(ym)
      if (t.total !== 0) ytdMonthly.push({ month: ym, collected: t.total })
    }
    const ytdCollected = round2(ytdMonthly.reduce((s, m) => s + m.collected, 0))

    res.json({ success: true, data: {
      collectedMtd,
      collectedMtdClearing,
      incomeCard,
      ytdCollected,
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
      meta: { basis: basisMeta(basis) },
    } })
  } catch (e) { next(e) }
})

// ── MONTHLY P&L DRILL-IN (S512 #20) ───────────────────────────
// GET /api/reports/monthly-pl?year=YYYY&month=M[&basis=received|billed]
// Backs the clickable drill-in on the landlord ReportsPage monthly
// table. One month's profit-and-loss:
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
    const basis = parseIncomeBasis(req.query.basis)
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

    const pl = await computeLandlordPL(landlordId, String(start), String(end), periodMonths(year, month), basis, scopedIds)
    const events = await incomeEvents({
      landlordIds: [landlordId], start: String(start).slice(0, 10), end: String(end).slice(0, 10), basis,
      propertyIds: scopedIds,
    })
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
      meta: { basis: pl.basis },
    } })
  } catch (e) { next(e) }
})

// ── MONTHLY OWNER STATEMENT ───────────────────────────────────
reportsRouter.get('/monthly-statement', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = parseIncomeBasis(req.query.basis)
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
    const statementEvents = await incomeEvents({ landlordIds: [landlordId], start: first, end: last, basis })
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
    // Bills due this month that are open: late (past due, not paid) and failed.
    const openCounts = await queryOne<{ late: number; failed: number }>(`
      SELECT COUNT(*) FILTER (WHERE p.status = 'pending' AND p.due_date < $4::date)::int AS late,
             COUNT(*) FILTER (WHERE p.status = 'failed')::int AS failed
        FROM payments p
       WHERE p.landlord_id = $1 AND ${landlordIncomeSql('p')}
         AND p.work_trade_suspended_at IS NULL
         AND p.due_date BETWEEN $2::date AND $3::date`,
      [landlordId, first, last, todayIn(null)])

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
    const pl = await computeLandlordPL(landlordId, String(start), String(end), periodMonths(year, month), basis)
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
    // rent and the landlord's entered expenses.
    const totalPlatformFees = pl.expenses.platformFee
    const totalMaintCost    = pl.expenses.maintenance
    const lotRent           = pl.expenses.lotRent
    const enteredExpenses   = pl.expenses.enteredExpenses

    // S86: PM subsystem superseded by 16a (DEFERRED Item 13). pmFee always 0.
    const pmFee = 0

    const totalExpenses = round2(pl.expenses.total + pmFee)
    const netToOwner    = round2(totalIncome - totalExpenses)

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
          totalPlatformFees, totalMaintCost, lotRent, enteredExpenses, pmFee, totalExpenses,
          netToOwner,
          // occupancy + payment counts
          occupiedUnits:  units.filter((u:any) => u.is_occupied).length,
          vacantUnits:    units.filter((u:any) => !u.is_occupied).length,
          settledPayments: settledRows.length,
          latePayments:    openCounts?.late ?? 0,
          failedPayments:  openCounts?.failed ?? 0,
        },
        meta: { basis: pl.basis },
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
    const basis = parseIncomeBasis(req.query.basis)
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
    const pl = await computeLandlordPL(landlordId, start, end, periodMonths(year, null), basis)
    const events = await incomeEvents({ landlordIds: [landlordId], start, end, basis })
    const perMonth = byMonth(events)
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
    const monthlyBreakdown: Array<{ month: number; collected: number; paid: number; failed: number }> = []
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}-${String(m).padStart(2, '0')}`
      const evs = perMonth.get(ym) ?? []
      const t = summarize(evs, basis)
      const paid = new Set(evs.filter(e => e.inTotal && e.paymentId).map(e => e.paymentId)).size
      const failed = failedBy.get(m) ?? 0
      if (t.total !== 0 || paid || failed) monthlyBreakdown.push({ month: m, collected: t.total, paid, failed })
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
        // lot rent − entered expenses), so the tax page and the P&L agree.
        netIncome: pl.net,
        w2099Threshold: workTradeStats.filter((w:any) => parseFloat(w.credit_value||0) >= 600),
        meta: { basis: pl.basis },
      }
    })
  } catch (e) { next(e) }
})

// ── PER-PROPERTY P&L ──────────────────────────────────────────
reportsRouter.get('/property-pl', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = parseIncomeBasis(req.query.basis)
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

    // Scalar subqueries per concern — NOT multiple LEFT JOINs of payments +
    // maintenance onto units. Joining two one-to-many tables to the same unit
    // fans out (P payments × M maintenance rows), which multiplied each money
    // SUM by the other table's row count whenever a unit had both.
    const properties = await query<any>(`
      SELECT p.*,
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
          WHERE u.property_id = p.id
            -- S654: the bare-date end is the whole last day, as the P&L counts it.
            AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)) AS maint_cost,
        -- S655: the drill-in's own lot rent and entered expenses, so the row's
        -- net equals the drill-in's net.
        ${propertyLotRentSql('p.id', '$2', '$3')} AS lot_rent,
        ${propertyEnteredExpensesSql('p.id', '$2', '$3')} AS entered_expenses
      FROM properties p
      WHERE p.landlord_id = ANY($1::uuid[])
        AND ($4::uuid[] IS NULL OR p.id = ANY($4::uuid[]))
      ORDER BY p.name`,
      [landlordIds, start, end, scopedIds])

    // S655: income per property from the one set of money facts, under the basis.
    const events = await incomeEvents({ landlordIds, start, end, basis, propertyIds: scopedIds })
    const incomeBy = new Map<string, IncomeEvent[]>()
    for (const e of events) {
      if (!e.propertyId) continue
      const l = incomeBy.get(e.propertyId)
      if (l) l.push(e); else incomeBy.set(e.propertyId, [e])
    }

    // Platform fee per property = GAM's actual billed income over the period
    // (accruals + live estimate for un-accrued months), period-based and
    // short-stay-aware. The maintenance platform fee is never surfaced.
    // S655: landlord net = income − platform fee − maintenance − lot rent −
    // entered expenses: the drill-in's net, line for line.
    const feeMap = await platformFeesByPropertyForEntities(landlordIds, periodMonths(year, month))

    const result = properties.map((p:any) => {
      const inc = summarize(incomeBy.get(p.id) ?? [], basis)
      const maint    = round2(parseFloat(p.maint_cost || 0))
      const platFee  = round2(feeMap.get(p.id) ?? 0)
      const lotRent  = round2(parseFloat(p.lot_rent || 0))
      const entered  = round2(parseFloat(p.entered_expenses || 0))
      const expensesTotal = round2(platFee + maint + lotRent + entered)
      const netIncome = round2(inc.total - expensesTotal)
      return { ...p,
        // Kept under its old name: this is the property's income under the basis.
        rent_collected: inc.total, income_total: inc.total, rent_line: inc.lines.rent,
        maint_cost: maint, platform_fees: platFee, lot_rent: lotRent, entered_expenses: entered,
        expenses_total: expensesTotal, net_income: netIncome,
        occupancy_rate: parseInt(p.total_units||0) > 0
          ? Math.round((parseInt(p.occupied_units||0) / parseInt(p.total_units||0)) * 100) : 0 }
    })

    res.json({ success: true, data: { year, month, period: { start, end }, properties: result, meta: { basis: basisMeta(basis) } } })
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
// GET /api/reports/property-detail?propertyId=UUID&year=YYYY[&month=M][&basis=]
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
    const basis = parseIncomeBasis(req.query.basis)
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
      WHERE p.id = $1 AND p.landlord_id = ANY($2::uuid[])`, [propertyId, landlordIds])
    if (!property) throw new AppError(404, 'Property not found')

    const occupied = parseInt(property.occupied_units || '0', 10)
    const totalUnits = parseInt(property.total_units || '0', 10)
    const scope = { landlordIds: [property.landlord_id], propertyIds: [propertyId] }

    // 1. Income by category, billed vs collected, under the switch.
    const breakdown = await categoryTotals({ ...scope, start, end, basis })

    // 2. Expenses as line items.
    // Platform fee = GAM's actual billed income for this property over the period
    // (accruals + live estimate for un-accrued months) — period-based and
    // short-stay-aware, so a property that earned rent never shows a $0 fee. The
    // maintenance platform fee is never surfaced; landlord pays only actual cost.
    const feeMap = await platformFeesByPropertyForEntities(landlordIds, periodMonths(year, month), propertyId)
    const platformFee = round2(feeMap.get(propertyId) ?? 0)
    const maintenance = await query<any>(`
      SELECT mr.id, mr.title, mr.status, mr.actual_cost, mr.completed_at,
        u.unit_number
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      WHERE u.property_id = $1
        -- S654: the bare-date end is the whole last day, as the P&L counts it.
        AND mr.completed_at >= $2 AND mr.completed_at < ($3::date + 1)
        AND mr.actual_cost IS NOT NULL
      ORDER BY mr.completed_at DESC`, [propertyId, start, end])
    const maintCost = round2(maintenance.reduce((s: number, m: any) => s + parseFloat(m.actual_cost || 0), 0))
    // The same lot rent and entered expenses the By Property row subtracts.
    const otherCosts = await queryOne<{ lot: string; entered: string }>(`
      SELECT ${propertyLotRentSql('$1::uuid', '$2', '$3')}::text AS lot,
             ${propertyEnteredExpensesSql('$1::uuid', '$2', '$3')}::text AS entered`,
      [propertyId, start, end])
    const lotRent = round2(parseFloat(otherCosts?.lot ?? '0'))
    const enteredExpenses = round2(parseFloat(otherCosts?.entered ?? '0'))
    const expensesTotal = round2(platformFee + maintCost + lotRent + enteredExpenses)

    // 3. Net.
    const net = round2(breakdown.total - expensesTotal)

    // The lists, after the breakdown.
    const units = await query<any>(`
      SELECT u.id, u.unit_number, u.status, u.bedrooms, u.bathrooms, u.rent_amount,
        vuo.is_occupied,
        vuo.primary_first_name AS tenant_first, vuo.primary_last_name AS tenant_last
      FROM units u
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      WHERE u.property_id = $1
      ORDER BY u.unit_number`, [propertyId])

    const events = await incomeEvents({ ...scope, start, end, basis })
    const { rows: paymentRows } = await chargesBehind(events)
    const depositsHeld = summarize(events, basis).beside.depositsHeld

    // Calendar-year income per month under the basis — the modal's mini trend.
    const yearEvents = month === null
      ? events
      : await incomeEvents({ ...scope, start: yearStart, end: yearEnd, basis })
    const trend = [...byMonth(yearEvents).entries()]
      .map(([m, evs]) => ({ month: m, collected: summarize(evs, basis).total }))
      .filter(t => t.collected !== 0)
      .sort((x, y) => x.month.localeCompare(y.month))

    res.json({ success: true, data: {
      property: {
        id: property.id, name: property.name, city: property.city, state: property.state, type: property.type,
        totalUnits, occupiedUnits: occupied,
        occupancyRate: totalUnits > 0 ? Math.round(100 * occupied / totalUnits) : 0,
      },
      period: { year, month, start, end },
      breakdown: { categories: breakdown.categories, lines: breakdown.lines, total: breakdown.total },
      expenses: { platformFee, maintenance: maintCost, lotRent, enteredExpenses, total: expensesTotal },
      net,
      // Kept for the existing screen: collected = the breakdown's total under the basis.
      summary: { collected: breakdown.total, maintCost, platformFee, net, depositsHeld },
      units: units.map((u: any) => ({
        id: u.id, unitNumber: u.unit_number, status: u.status,
        bedrooms: u.bedrooms, bathrooms: parseFloat(u.bathrooms),
        rent: parseFloat(u.rent_amount || 0), isOccupied: !!u.is_occupied,
        tenantName: [u.tenant_first, u.tenant_last].filter(Boolean).join(' ') || null,
      })),
      payments: paymentRows,
      maintenance: maintenance.map((m: any) => ({
        id: m.id, title: m.title, status: m.status,
        actualCost: parseFloat(m.actual_cost || 0),
        completedAt: m.completed_at, unitNumber: m.unit_number ?? null,
      })),
      monthlyTrend: trend,
      meta: { basis: basisMeta(basis), listsAfterBreakdown: true },
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
// S655: both take ?basis= (Money received, the default, or Money billed).
// ============================================================

// GET /api/reports/query — the general engine.
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD&level=property&bucket=monthly[&basis=]
reportsRouter.get('/query', requirePerm('payments.view_all'), async (req, res, next) => {
  try {
    const basis = parseIncomeBasis(req.query.basis)
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
    res.json({
      success: true,
      data: {
        ...result,
        meta: {
          start, end, level, bucket,
          basis: basisMeta(basis),
          // Stated, not silent: the platform fee accrues monthly per property,
          // so a daily bucket cannot attribute it to a day without inventing
          // precision. Callers must show this rather than imply $0 of fee.
          platformFeeIncluded: bucket !== 'daily',
          // S655: lot rent is billed by the month too — the same rule.
          lotRentIncluded: bucket !== 'daily',
          occupancyBasis: 'current',
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
    const basis = parseIncomeBasis(req.query.basis)
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
    const bm = basisMeta(basis)
    res.json({
      success: true,
      data: {
        ...result,
        meta: {
          report: 'T-12', start: iso(startD), end: iso(endD),
          months: 12, level: 'property', bucket: 'monthly',
          basis: bm,
          platformFeeIncluded: true, lotRentIncluded: true, occupancyBasis: 'current',
          note: `Trailing twelve complete months. The current partial month is excluded. ${bm.label}: ${bm.note}`,
        },
      },
    })
  } catch (e) { next(e) }
})

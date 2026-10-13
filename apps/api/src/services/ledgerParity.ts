/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P8: THE NIGHTLY PARITY CHECK
 * (gam-ledger-design-2026-10-12 §10 "Cutover" step 1, §15 step 7)
 *
 * Reports read the ledger once a company's books are live (services/
 * ledgerReports). Every night this compares, for each company with books,
 * what the ledger says against what the money records say (services/
 * incomeBasis with source 'records', services/landlordPL's records readers)
 * for last month and this month to date, to the cent:
 *
 *   received          money received (in the total)
 *   charged           money charged, credits given off it
 *   depositsReceived  deposits received (beside the total)
 *   processingFees    the processing fees the landlord covers — the
 *                     in-flight records figure (processingFeesFromRecords)
 *                     must equal the ledger's 5115 to the cent (design §10)
 *   cardFeesRefunded  card fees given back with refunds (5117)
 *   expensesEntered   the Expenses record's expenses, by their date
 *   platformFee       GAM's platform fee for a finished month (the P&L's
 *                     accrual against the books' 5155) — last month only: this
 *                     month's fee is charged as the month goes
 *
 * Any difference raises an admin notice. The known differences the ledger
 * makes on purpose are worked out and named beside each one — a home sale's
 * principal (not income when the owner books the whole sale at signing, Nic
 * L11), an opening balance carried from before GAM (opening equity, never
 * this company's income), paid-ahead money GAM holds (counted when it pays a
 * bill, not when it arrives — Nic L13), a stay (counted when the guest
 * arrives, L10), utility tax (owed to the government), and (10/12, found on a
 * copy of production) a bill on hold for work trade, work-trade hours counted
 * as full rent plus labor (L12) and a one-time pay link's timing — so an admin sees
 * at once what is left unexplained. The notice is a warning when something is
 * unexplained, information when every difference is one of those.
 *
 * THE SWITCH (design §15 step 9, "switch readers only after parity"): the
 * first check after a company's full rebuild that leaves nothing unexplained
 * switches its reports to the ledger, for good (services/ledgerReports
 * ledgerReportsLive), and an admin is told. When the differences are
 * understood but not one of the named ones, a super admin accepts them with a
 * reason (acceptParity, POST /api/admin/ledger/landlords/:id/parity/accept),
 * which switches the reports the same way.
 *
 * Each run is kept in ledger_rebuild_runs (mode 'check', scope.kind 'parity'),
 * beside the nightly tie-out, so the admin ledger page lists it.
 *
 * Read-only on the money and the ledger.
 */
import { ledgerQuery } from '../db/ledgerPool'
import { query } from '../db'
import { logger } from '../lib/logger'
import { todayIn } from '../lib/timezone'
import { createAdminNotification } from './adminNotifications'
import { incomeEvents, summarize, cardFeesRefundedByProperty, type IncomeEvent, type ReportLine } from './incomeBasis'
import { processingFeesFromRecords } from './landlordPL'
import { platformFeesByProperty } from './platformFee'
import { landlordExpensesTotal } from './landlordExpenses'
import { ledgerIncomeEvents, ledgerRoleByProperty, ledgerEnteredExpensesByDay, ledgerReportsLive, FIRST_FULL_REBUILD_SQL } from './ledgerReports'

const round2 = (n: number) => Math.round(n * 100) / 100

export type ParityMeasureKey = 'received' | 'charged' | 'depositsReceived' | 'processingFees' | 'cardFeesRefunded' | 'expensesEntered' | 'platformFee'

export const PARITY_MEASURE_LABEL: Record<ParityMeasureKey, string> = {
  received: 'Money received',
  charged: 'Money charged',
  depositsReceived: 'Deposits received',
  processingFees: 'Processing fees you pay',
  cardFeesRefunded: 'Card fees refunded',
  expensesEntered: 'Expenses entered',
  platformFee: 'GAM platform fee',
}

export interface ParityMeasure {
  key: ParityMeasureKey
  label: string
  records: number
  ledger: number
  /** ledger − records */
  difference: number
  /** The part of the difference the ledger makes on purpose (see the header). */
  explained: number
  reasons: Array<{ reason: string; amount: number }>
  /** Per report line, where the two differ (received and charged only). */
  byLine?: Array<{ line: string; records: number; ledger: number }>
}

export interface ParityMonth { month: string; start: string; end: string; measures: ParityMeasure[] }
export interface ParityResult { landlordId: string; months: ParityMonth[]; differences: number; unexplained: number; runId: string | null }

const sum = (m: Map<string, number>) => round2([...m.values()].reduce((t, v) => t + v, 0))

function byLine(records: readonly IncomeEvent[], ledger: readonly IncomeEvent[]): Array<{ line: string; records: number; ledger: number }> {
  const add = (m: Map<string, number>, list: readonly IncomeEvent[]) => {
    for (const e of list) if (e.inTotal) m.set(e.line, (m.get(e.line) ?? 0) + e.amount)
  }
  const r = new Map<string, number>(), l = new Map<string, number>()
  add(r, records); add(l, ledger)
  return [...new Set([...r.keys(), ...l.keys()])]
    .map(line => ({ line, records: round2(r.get(line) ?? 0), ledger: round2(l.get(line) ?? 0) }))
    .filter(x => x.records !== x.ledger)
}

function measure(key: ParityMeasureKey, records: number, ledger: number, reasons: Array<{ reason: string; amount: number }> = []): ParityMeasure {
  const live = reasons.filter(r => r.amount !== 0)
  return {
    key, label: PARITY_MEASURE_LABEL[key], records: round2(records), ledger: round2(ledger),
    difference: round2(ledger - records), explained: round2(live.reduce((t, r) => t + r.amount, 0)), reasons: live,
  }
}

/**
 * Stays (Nic L10, design F6): the ledger counts a stay's money as Charged when
 * the guest arrives (held as a guest deposit until then); the records count it
 * when it is paid. The part of a month's Charged difference that is this
 * timing: stay income earned from guest deposits in the month − stay money
 * that went to guest deposits in the month.
 */
async function stayTiming(landlordId: string, start: string, end: string): Promise<number> {
  const r = await query<{ earned: string; held: string }>(
    `SELECT COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.account_role = 'stay_income' AND ps.source_type = 'booking' AND ps.posting_kind = 'charge'), 0)::text AS earned,
            COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.account_role = 'guest_deposits' AND l.cash_effect = 'in'), 0)::text AS held
       FROM ledger_posting_lines l JOIN ledger_postings ps ON ps.id = l.posting_id
      WHERE l.landlord_id = $1 AND l.accounting_date BETWEEN $2::date AND $3::date`, [landlordId, start, end])
  return round2(Number(r[0]?.earned ?? 0) - Number(r[0]?.held ?? 0))
}

/** Ledger lines of the company in the month: credits on a role from bill postings (Cr − Dr). */
async function chargeCredits(landlordId: string, role: string, start: string, end: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS n
       FROM ledger_posting_lines l JOIN ledger_postings ps ON ps.id = l.posting_id
      WHERE l.landlord_id = $1 AND l.account_role = $2 AND ps.posting_kind = 'charge'
        AND l.accounting_date BETWEEN $3::date AND $4::date`, [landlordId, role, start, end])
  return round2(Number(r[0]?.n ?? 0))
}

/**
 * Paid-ahead money GAM holds (Nic L13): the records count it the day it
 * arrives; the ledger the day it pays a bill. The part of a month's received
 * difference that is this timing: (used through GAM in the month) − (arrived
 * through GAM in the month).
 */
async function gamHeldPaidAheadTiming(landlordId: string, start: string, end: string): Promise<number> {
  const used = await query<{ n: string }>(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS n
       FROM ledger_posting_lines l JOIN ledger_postings ps ON ps.id = l.posting_id
      WHERE l.landlord_id = $1 AND ps.source_type = 'credit_use' AND l.cash_effect = 'in' AND l.account_role = 'ar_tenants'
        AND EXISTS (SELECT 1 FROM ledger_posting_lines o WHERE o.posting_id = l.posting_id AND o.account_role = 'due_from_gam')
        AND EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.id::text = ps.source_id AND cu.prepaid_credit_id IS NOT NULL)
        AND l.accounting_date BETWEEN $2::date AND $3::date`, [landlordId, start, end])
  const arrived = await query<{ n: string }>(
    `SELECT COALESCE(SUM(c.amount_original), 0)::text AS n
       FROM lease_prepaid_credits c JOIN leases le ON le.id = COALESCE(c.received_lease_id, c.lease_id)
       LEFT JOIN units u ON u.id = le.unit_id LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE le.landlord_id = $1 AND c.funded_by = 'gam' AND c.voided_at IS NULL
        AND (COALESCE(c.received_at, c.created_at) AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date BETWEEN $2::date AND $3::date`,
    [landlordId, start, end])
  return round2(Number(used[0]?.n ?? 0) - Number(arrived[0]?.n ?? 0))
}

/**
 * 10/12 (Nic, ledger P8 integration): three more differences the ledger makes
 * on purpose, found by the parity shadow on a copy of production (every
 * company's Money charged differed by them and nothing named them, so no
 * company could ever switch on its own):
 *
 *   workTradeHeld   a bill on hold for work trade (payments.work_trade_suspended_at)
 *                   is charged on its due day, like any bill — the 1100 check
 *                   counts it owed (design §8); the records leave it out of
 *                   Money billed until the work-trade month settles. The part
 *                   of a month's Charged difference: the bills on hold that
 *                   came due in the month, from the money records (10/12).
 *   workTradeLabor  work-trade hours that covered rent, when the owner counts
 *                   them as "full rent plus a labor cost" (Nic L12): the books
 *                   charge the full rent and book the hours as labor; the
 *                   records show the bill less the hours. (With "a rent
 *                   discount" the books show the bill less the hours too.)
 *   payLinkTiming   a one-time pay link: the records bill its sale the day the
 *                   link was sent (incomeBasis sharedBranches); the books count
 *                   it the day it is paid (register sales post when made).
 */
/**
 * 10/12 (Nic, review): worked out from the MONEY RECORDS — every bill on hold
 * for work trade that came due in the month (its whole amount; the tax on it
 * is the utility-tax reason's) — never from what the books charged on those
 * bills, which would "explain" any mistake the books made on them.
 */
async function workTradeHeldCharged(landlordId: string, start: string, end: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS n FROM payments
      WHERE landlord_id = $1 AND work_trade_suspended_at IS NOT NULL AND status <> 'voided'
        AND type NOT IN ('deposit', 'float_fee', 'platform_fee')
        AND due_date BETWEEN $2::date AND $3::date`, [landlordId, start, end])
  return round2(Number(r[0]?.n ?? 0))
}

async function workTradeLaborCharged(landlordId: string, start: string, end: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS n
       FROM ledger_posting_lines l JOIN ledger_postings ps ON ps.id = l.posting_id
      WHERE l.landlord_id = $1 AND l.account_role = 'work_trade_labor' AND ps.posting_kind = 'work_trade'
        AND l.accounting_date BETWEEN $2::date AND $3::date`, [landlordId, start, end])
  return round2(Number(r[0]?.n ?? 0))
}

async function payLinkTiming(landlordId: string, start: string, end: string): Promise<number> {
  const r = await query<{ n: string }>(
    `WITH sale AS (
       SELECT t.id::text AS id, (lk.created_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date AS link_day
         FROM pos_transactions t
         JOIN pos_pay_links lk ON lk.id = t.pay_link_id AND lk.kind = 'one_time'
         LEFT JOIN properties pr ON pr.id = t.property_id
        WHERE t.landlord_id = $1),
     income AS (
       SELECT s.link_day, l.accounting_date AS day, SUM(l.credit - l.debit) AS amount
         FROM sale s
         JOIN ledger_postings ps ON ps.source_type = 'pos_sale' AND ps.source_id = s.id
         JOIN ledger_posting_lines l ON l.posting_id = ps.id AND l.landlord_id = $1
         JOIN books_accounts a ON a.id = l.account_id AND a.type = 'income'
        GROUP BY 1, 2)
     SELECT (COALESCE(SUM(amount) FILTER (WHERE day BETWEEN $2::date AND $3::date), 0)
           - COALESCE(SUM(amount) FILTER (WHERE link_day BETWEEN $2::date AND $3::date), 0))::text AS n
       FROM income`, [landlordId, start, end])
  return round2(Number(r[0]?.n ?? 0))
}

/** One company, one month: every measure, records against the ledger. `finished`: the month is over (its platform fee is due). */
export async function parityForMonth(landlordId: string, start: string, end: string, finished = false): Promise<ParityMonth> {
  const q = { landlordIds: [landlordId], start, end }
  const [rRec, bRec, rLed, bLed] = await Promise.all([
    incomeEvents({ ...q, basis: 'received', source: 'records' }),
    incomeEvents({ ...q, basis: 'billed', source: 'records' }),
    ledgerIncomeEvents({ ...q, basis: 'received' }),
    ledgerIncomeEvents({ ...q, basis: 'billed' }),
  ])
  const rr = summarize(rRec, 'received'), rl = summarize(rLed, 'received')
  const br = summarize(bRec, 'billed'), bl = summarize(bLed, 'billed')
  const [procRec, procLed, cardRec, cardLed, expRec, expLedDays, homePrincipal, openingCarried, gamTiming, stays, utilityTax] = await Promise.all([
    processingFeesFromRecords([landlordId], start, end),
    ledgerRoleByProperty({ landlordIds: [landlordId] }, 'processing_fees', start, end),
    cardFeesRefundedByProperty([landlordId], start, end, null, [], 'records'),
    ledgerRoleByProperty({ landlordIds: [landlordId] }, 'card_fees_refunded', start, end),
    landlordExpensesTotal(landlordId, start, end),
    ledgerEnteredExpensesByDay({ landlordIds: [landlordId] }, start, end),
    chargeCredits(landlordId, 'home_notes_receivable', start, end),
    chargeCredits(landlordId, 'opening_balance_equity', start, end),
    gamHeldPaidAheadTiming(landlordId, start, end),
    stayTiming(landlordId, start, end),
    chargeCredits(landlordId, 'utility_tax_payable', start, end),
  ])
  const [workTradeHeld, workTradeLabor, payLinks] = await Promise.all([
    workTradeHeldCharged(landlordId, start, end),
    workTradeLaborCharged(landlordId, start, end),
    payLinkTiming(landlordId, start, end),
  ])
  const received = measure('received', rr.total, rl.total, [
    { reason: 'Paid-ahead money GAM holds counts when it pays a bill, not when it arrives (Nic L13)', amount: gamTiming },
  ])
  received.byLine = byLine(rRec, rLed)
  const charged = measure('charged', br.total, bl.total, [
    { reason: 'A home sale\'s principal pays down the note, not income (the whole sale booked at signing, Nic L11)', amount: -homePrincipal },
    { reason: 'An old balance carried from before GAM is opening equity, not this company\'s income', amount: -openingCarried },
    { reason: 'A stay counts when the guest arrives, held as a guest deposit until then (Nic L10)', amount: stays },
    { reason: 'Utility tax on a bill is owed to the government, not income', amount: -utilityTax },
    { reason: 'A bill on hold for work trade is charged when it is due; the records leave it out until the work-trade month settles', amount: workTradeHeld },
    { reason: 'Work-trade hours that covered rent count as full rent plus a labor cost (Nic L12); the records show the bill less the hours', amount: workTradeLabor },
    { reason: 'A one-time pay link counts the day it is paid; the records bill it the day the link was sent', amount: payLinks },
  ])
  charged.byLine = byLine(bRec, bLed.filter(e => !e.ledger || e.ledger === 'line'))
  // 10/12 (Nic, review): a month cut at the books' start date compares no
  // platform fee (the fee is billed for the whole month, before the start).
  const fee = finished && start.endsWith('-01')
    ? [measure('platformFee', sum(await platformFeesByProperty(landlordId, [start])),
        sum(await ledgerRoleByProperty({ landlordIds: [landlordId] }, 'gam_platform_fees', start, end)))]
    : []
  return {
    month: start.slice(0, 7), start, end,
    measures: [
      received,
      charged,
      measure('depositsReceived', rr.beside.depositsHeld, rl.beside.depositsHeld),
      measure('processingFees', sum(procRec), sum(procLed)),
      measure('cardFeesRefunded', sum(cardRec), sum(cardLed)),
      measure('expensesEntered', expRec, round2([...expLedDays.values()].reduce((t, d) => t + d.amount, 0))),
      ...fee,
    ],
  }
}

/** The month before `today` (first and last day) and this month to `today`. */
export function parityMonths(today: string): Array<{ start: string; end: string }> {
  const [y, m] = today.split('-').map(Number)
  const prevY = m === 1 ? y - 1 : y, prevM = m === 1 ? 12 : m - 1
  const pad = (n: number) => String(n).padStart(2, '0')
  const prevEnd = new Date(Date.UTC(prevY, prevM, 0)).toISOString().slice(0, 10)
  return [
    { start: `${prevY}-${pad(prevM)}-01`, end: prevEnd },
    { start: `${y}-${pad(m)}-01`, end: today },
  ]
}

const NOT_ZERO = (x: ParityMeasure) => x.difference !== 0

/**
 * 10/12 (Nic, review): the parity months cut at the books' start date — the
 * ledger posts nothing before it (services/ledgerEngine), so a month that ended
 * before the books start is skipped and the month they start in is compared
 * from the start date on (a company starting its books mid-month is not held
 * back by records it never meant the books to hold).
 */
export function parityMonthsFrom(today: string, booksStart: string | null): Array<{ start: string; end: string }> {
  return parityMonths(today)
    .filter(p => !booksStart || p.end >= booksStart)
    .map(p => (booksStart && p.start < booksStart ? { ...p, start: booksStart } : p))
}

/** One company's parity check: both months, kept as a run, an admin told of any difference. */
export async function checkCompanyParity(landlordId: string, today: string = todayIn(null)): Promise<ParityResult> {
  const months: ParityMonth[] = []
  const booksStart = (await query<{ d: string | null }>(
    `SELECT books_start_date::text AS d FROM landlords WHERE id = $1`, [landlordId]))[0]?.d ?? null
  for (const p of parityMonthsFrom(today, booksStart)) months.push(await parityForMonth(landlordId, p.start, p.end, p.end < today))
  const all = months.flatMap(m => m.measures)
  const differences = all.filter(NOT_ZERO).length
  const unexplained = all.filter(x => round2(x.difference - x.explained) !== 0).length
  const wasLive = await ledgerReportsLive([landlordId])
  const run = await ledgerQuery<{ id: string }>(
    `INSERT INTO ledger_rebuild_runs (landlord_id, mode, status, scope, finished_at, counts, drift)
     VALUES ($1, 'check', 'done', $2::jsonb, now(), $3::jsonb, $4::jsonb) RETURNING id`,
    [landlordId, JSON.stringify({ kind: 'parity', months: months.map(m => m.month) }),
     JSON.stringify({ differences, unexplained }),
     JSON.stringify(months.map(m => ({ month: m.month, measures: m.measures.filter(NOT_ZERO) })))])
  const runId = run[0]?.id ?? null
  const name = (await query<{ n: string | null }>(
    `SELECT COALESCE(NULLIF(TRIM(business_name), ''), (SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM properties p WHERE p.landlord_id = l.id)) AS n
       FROM landlords l WHERE l.id = $1`, [landlordId]))[0]?.n ?? 'A company'
  // The check that switches a company's reports to its books says so, once.
  if (!wasLive && await ledgerReportsLive([landlordId])) {
    await createAdminNotification({
      severity: 'info', category: 'books_ledger',
      title: `${name}: reports now read the books`,
      body: 'The books were rebuilt and match the money records (every difference expected), so every report of this company now reads them.',
      context: { runId, landlordId },
    })
  }
  if (differences > 0) {
    const lines = months.flatMap(m => m.measures.filter(NOT_ZERO).map(x =>
      `${m.month} ${x.label}: records $${x.records.toFixed(2)}, books $${x.ledger.toFixed(2)} (difference $${x.difference.toFixed(2)}`
      + `${x.explained ? `, $${x.explained.toFixed(2)} of it expected` : ''})`))
    await createAdminNotification({
      severity: unexplained > 0 ? 'warn' : 'info',
      category: 'books_ledger',
      title: unexplained > 0 ? `${name}: the books and the money records differ` : `${name}: the books differ from the money records only where expected`,
      body: lines.slice(0, 12).join('\n'),
      context: { runId, landlordId, months: months.map(m => ({ month: m.month, measures: m.measures.filter(NOT_ZERO) })) },
    })
  }
  return { landlordId, months, differences, unexplained, runId }
}

/**
 * The nightly job: every company with a books start date whose ledger was
 * rebuilt in full (before that the ledger holds only what posted since the
 * engine started, so there is nothing whole to compare). One company's
 * failure is logged; the rest still run. The first run after the rebuild that
 * finds no unexplained difference switches the company's reports to the
 * ledger (services/ledgerReports ledgerReportsLive).
 */
export async function runLedgerParity(opts: { today?: string } = {}): Promise<ParityResult[]> {
  const companies = await query<{ id: string }>(
    `SELECT l.id::text AS id FROM landlords l
      WHERE l.books_start_date IS NOT NULL AND ${FIRST_FULL_REBUILD_SQL('l')} IS NOT NULL
      ORDER BY l.created_at, l.id`)
  const out: ParityResult[] = []
  for (const c of companies) {
    try {
      out.push(await checkCompanyParity(c.id, opts.today))
    } catch (e) {
      logger.error({ err: e, landlordId: c.id }, '[ledger-parity] company check failed')
    }
  }
  return out
}

/** For a line key, its words (an admin reading byLine). */
export type ParityLine = ReportLine

/**
 * An admin accepts the differences the last parity check listed (each one
 * understood) — the company's reports switch to the ledger. Kept as a parity
 * run marked accepted, with who and why; never removed.
 */
export async function acceptParity(landlordId: string, byUserId: string, reason: string): Promise<{ runId: string }> {
  const why = String(reason ?? '').trim()
  if (!why) throw new Error('Say why the differences are accepted.')
  const r = await ledgerQuery<{ id: string }>(
    `INSERT INTO ledger_rebuild_runs (landlord_id, mode, status, scope, finished_at, started_by, counts)
     VALUES ($1, 'check', 'done', $2::jsonb, now(), $3, '{"accepted": true}'::jsonb) RETURNING id`,
    [landlordId, JSON.stringify({ kind: 'parity', accepted: true, reason: why.slice(0, 500) }), byUserId])
  return { runId: r[0].id }
}

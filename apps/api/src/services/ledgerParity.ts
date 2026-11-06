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
            COALESCE(SUM(l.credit - l.debit) FILTER (WHERE l.account_role = 'guest_deposits' AND l.cash_effect = 'in'
              -- 11/2: the held sum subtracts a dollar on the understanding that
              -- money records billed that same dollar in this same month. For a
              -- ONE-TIME PAY LINK they did not: the records bill a link the day
              -- it was SENT (incomeBasis, 'Open one-time pay links: billed,
              -- still owed (by the day they were sent)'), which can be any
              -- earlier month. Mountain View's October subtracted $589.00 on a
              -- link sent 9/18 and paid 10/06 and so reported $554.05 of
              -- difference that was never there. That dollar's records-side
              -- billing belongs to the pay-link reason, not to this one.
              AND NOT EXISTS (
                SELECT 1 FROM pos_pay_links lk
                  LEFT JOIN properties lp ON lp.id = lk.property_id
                 WHERE ps.source_type = 'pos_sale' AND lk.pos_transaction_id::text = ps.source_id::text
                   AND lk.kind = 'one_time'
                   AND (lk.created_at AT TIME ZONE COALESCE(lp.timezone, 'America/Phoenix'))::date
                         NOT BETWEEN $2::date AND $3::date)), 0)::text AS held
       FROM ledger_posting_lines l JOIN ledger_postings ps ON ps.id = l.posting_id
      WHERE l.landlord_id = $1 AND ps.role = 'post' AND ps.superseded_at IS NULL
        AND l.accounting_date BETWEEN $2::date AND $3::date`, [landlordId, start, end])
  return round2(Number(r[0]?.earned ?? 0) - Number(r[0]?.held ?? 0))
}

/**
 * Ledger lines of the company in the month: credits on a role from bill
 * postings (Cr − Dr).
 *
 * 11/2 — `includeOpening` exists because the opening balance is NOT a bill.
 * It is posted once as `posting_kind = 'main'` with `source_type = 'opening'`,
 * so the `'charge'` filter hid it, and the reason written for it below ("An old
 * balance carried from before GAM is opening equity, not this company's
 * income") returned 0.00 for every company since it was written. Mountain View
 * carried $589.00 of pre-books rent that way — rent for an RV 27 stay that
 * ended the day before its books begin — and it read as unexplained in both
 * directions: −589 in September and +589 in October.
 *
 * Scoped to `source_type = 'opening'` rather than dropping the filter: the
 * opening posting touches only guest_deposits and opening_balance_equity today,
 * but a future opening leg on a role this helper is also called with (a home
 * note, utility tax) would otherwise silently start over-explaining a month the
 * records never billed.
 */
async function chargeCredits(
  landlordId: string, role: string, start: string, end: string,
  opts: { includeOpening?: boolean } = {},
): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS n
       FROM ledger_posting_lines l JOIN ledger_postings ps ON ps.id = l.posting_id
      WHERE l.landlord_id = $1 AND l.account_role = $2
        AND (ps.posting_kind = 'charge'${opts.includeOpening ? " OR ps.source_type = 'opening'" : ''})
        -- The reader these are measured against counts only live postings
        -- (ledgerReports), so a reversed or superseded leg must not land in a
        -- reason either, or the reason outlives the posting it explains.
        AND ps.role = 'post' AND ps.superseded_at IS NULL
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
 *   workTradeHeld   RETIRED 11/4. It used to explain a real difference: the
 *                   books charged a bill held for work trade on its due day
 *                   while the records left it out until the work-trade month
 *                   settled. Nic's 11/3 directive took that money out of every
 *                   month figure, so ledgerReports leaves the held bill out of
 *                   Charged as well (NOT_WORK_TRADE_HELD) and the two sides now
 *                   agree with no reason needed. See the note at the reason
 *                   list below for why removing it was mandatory and not
 *                   housekeeping.
 *   workTradeLabor  work-trade hours that covered rent, when the owner counts
 *                   them as "full rent plus a labor cost" (Nic L12): the books
 *                   charge the full rent and book the hours as labor; the
 *                   records show the bill less the hours. (With "a rent
 *                   discount" the books show the bill less the hours too.)
 *   payLinkTiming   a one-time pay link: the records bill its sale the day the
 *                   link was sent (incomeBasis sharedBranches); the books count
 *                   it the day it is paid (register sales post when made).
 */

async function workTradeLaborCharged(landlordId: string, start: string, end: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS n
       FROM ledger_posting_lines l JOIN ledger_postings ps ON ps.id = l.posting_id
      WHERE l.landlord_id = $1 AND l.account_role = 'work_trade_labor' AND ps.posting_kind = 'work_trade'
        AND l.accounting_date BETWEEN $2::date AND $3::date`, [landlordId, start, end])
  return round2(Number(r[0]?.n ?? 0))
}

/**
 * 11/2 (Nic: "leave it in September") — MONEY THAT PAID AN OLDER MONTH'S BILL.
 *
 * Cash can arrive in one month and pay off a bill recorded as settled in
 * another. The books count the cash the day it actually arrived; the money
 * records count it against the month of the bill it cleared. Both are right and
 * they differ by that amount.
 *
 * It happens whenever an older balance is settled by hand on the day it belongs
 * to rather than the day the money turned up — which is the whole shape of a
 * balance carried in from before GAM. MH 29 at Country Acres paid $500 toward
 * September: $100 early in September and $400 that reached the bank on 10/05.
 * September is where that income belongs (dating it to arrival would put
 * pre-GAM rent in October and charge GAM's fee on it), so the September bill is
 * settled 09/01 while the books hold the cash on 10/05 — $400 the records place
 * in September and the books in October.
 *
 * Both directions, because the same pair of dates reads the other way round
 * from the earlier month's side:
 *   + cash the books counted INSIDE this window against a bill settled outside
 *   − cash the books counted outside the window against a bill settled inside
 *
 * Derived from the MECHANISM — the two dates on one piece of money — and never
 * from the size of the gap. A reason computed as "whatever is left over"
 * explains everything and would hide the next real defect.
 */
async function olderMonthSettlementTiming(landlordId: string, start: string, end: string): Promise<number> {
  const r = await query<{ n: string }>(
    `WITH money AS (
       SELECT ra.amount_applied AS amount,
              -- What the BOOKS used: the day the remittance's cash posted.
              ps.accounting_date AS cash_day,
              -- What the RECORDS used: the day the bill it cleared was settled,
              -- in the property's own calendar (incomeBasis' convention).
              (p.settled_at AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date AS bill_day
         FROM remittance_applications ra
         JOIN tenant_remittances tr ON tr.id = ra.remittance_id AND tr.undone_at IS NULL
         JOIN payments p ON p.id = ra.payment_id AND p.settled_at IS NOT NULL
         JOIN ledger_postings ps ON ps.source_type = 'remittance' AND ps.source_id = tr.id::text
                                AND ps.role = 'post' AND ps.superseded_at IS NULL
         LEFT JOIN units u ON u.id = p.unit_id
         LEFT JOIN properties pr ON pr.id = u.property_id
        WHERE tr.landlord_id = $1)
     SELECT (COALESCE(SUM(amount) FILTER (
               WHERE cash_day BETWEEN $2::date AND $3::date
                 AND bill_day NOT BETWEEN $2::date AND $3::date), 0)
           - COALESCE(SUM(amount) FILTER (
               WHERE bill_day BETWEEN $2::date AND $3::date
                 AND cash_day NOT BETWEEN $2::date AND $3::date), 0))::text AS n
       FROM money`, [landlordId, start, end])
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
                               AND ps.role = 'post' AND ps.superseded_at IS NULL
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
  /**
   * 11/2 — a one-time pay link NOBODY HAS PAID. The records bill it the day it
   * was sent and carry it as still owed; the books have nothing until money
   * arrives, which is right. Nothing named that, so two unpaid reservation
   * links sent 10/24 ($24.50 and $10.45) sat in Mountain View's October as
   * $34.95 of unexplained difference.
   *
   * Taken off the records reader's own events rather than re-queried here. The
   * records side carries real conditions — one link per booking, never one past
   * its expiry, nothing for a link that is only a background check — and a
   * second hand-written copy of them in this file is exactly how the stay
   * reason above came to subtract a dollar the records had billed in another
   * month. There is one definition, and this reads it.
   */
  const openLinksOwed = round2(bRec
    .filter(e => e.part === 'stillOwed' && e.category === 'stays_and_pay_links')
    .reduce((t, e) => t + e.amount, 0))
  const [procRec, procLed, cardRec, cardLed, expRec, expLedDays, homePrincipal, openingCarried, gamTiming, stays, utilityTax] = await Promise.all([
    processingFeesFromRecords([landlordId], start, end),
    ledgerRoleByProperty({ landlordIds: [landlordId] }, 'processing_fees', start, end),
    cardFeesRefundedByProperty([landlordId], start, end, null, [], 'records'),
    ledgerRoleByProperty({ landlordIds: [landlordId] }, 'card_fees_refunded', start, end),
    landlordExpensesTotal(landlordId, start, end),
    ledgerEnteredExpensesByDay({ landlordIds: [landlordId] }, start, end),
    chargeCredits(landlordId, 'home_notes_receivable', start, end),
    chargeCredits(landlordId, 'opening_balance_equity', start, end, { includeOpening: true }),
    gamHeldPaidAheadTiming(landlordId, start, end),
    stayTiming(landlordId, start, end),
    chargeCredits(landlordId, 'utility_tax_payable', start, end),
  ])
  const [workTradeLabor, payLinks, olderMonth] = await Promise.all([
    workTradeLaborCharged(landlordId, start, end),
    payLinkTiming(landlordId, start, end),
    olderMonthSettlementTiming(landlordId, start, end),
  ])
  const received = measure('received', rr.total, rl.total, [
    { reason: 'Paid-ahead money GAM holds counts when it pays a bill, not when it arrives (Nic L13)', amount: gamTiming },
    { reason: 'Money that paid an older month\'s bill counts on the books the day it arrived; the records count it in the month of the bill it cleared', amount: olderMonth },
  ])
  received.byLine = byLine(rRec, rLed)
  const charged = measure('charged', br.total, bl.total, [
    { reason: 'A home sale\'s principal pays down the note, not income (the whole sale booked at signing, Nic L11)', amount: -homePrincipal },
    { reason: 'An old balance carried from before GAM is opening equity, not this company\'s income', amount: -openingCarried },
    { reason: 'A stay counts when the guest arrives, held as a guest deposit until then (Nic L10)', amount: stays },
    { reason: 'Utility tax on a bill is owed to the government, not income', amount: -utilityTax },
    // 11/4: THIS REASON IS RETIRED, and retiring it is not optional.
    //
    // It explained a REAL difference: the books charged a bill held for work
    // trade on its due day while the money records left it out until the
    // work-trade month settled. Nic's 11/3 directive took that money out of
    // every month figure, so ledgerReports now leaves the held bill out of
    // Charged too (NOT_WORK_TRADE_HELD) and the two sides agree on their own.
    //
    // Leaving the reason in place would have been far worse than a stale
    // comment. `measure` subtracts every reason from the raw difference to get
    // `unexplained`; with the difference now zero and the reason still
    // claiming it, unexplained would go non-zero by exactly the held amount,
    // PARITY_PASSED_SQL would stop matching, ledgerLiveCompanyIds would drop
    // the company, and EVERY report for Mountain View and Oak Park would
    // silently fall back off the books onto the money records. The reports
    // would still render. They would just quietly be answering a different
    // question than the day before.
    { reason: 'Work-trade hours that covered rent count as full rent plus a labor cost (Nic L12); the records show the bill less the hours', amount: workTradeLabor },
    { reason: 'A one-time pay link counts the day it is paid; the records bill it the day the link was sent', amount: round2(payLinks - openLinksOwed) },
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

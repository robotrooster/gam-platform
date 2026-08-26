// S624 — work-trade month-close settlement. The HOURS ledger.
//
// This file is the arithmetic only: no database, no dates beyond a month key,
// no side effects. The job (jobs/workTradeSettlement.ts) reads rows, calls
// `settleMonth`, and writes what comes back. Keeping it pure is what lets the
// interesting cases — a deficit ageing out, a bank covering a bad month, a
// catch-up crediting an invoice from two months ago — be tested without
// standing up a tenancy.
//
// THE MODEL (Nic, S623 + S624)
//
// Rent is paid FORWARD, so the work that pays for a month happens DURING that
// month. An invoice therefore issues in full, sits open and unchased while the
// tenant works, and is credited at month close from that month's own approved
// hours. The old model credited a month from the PREVIOUS month's hours at
// generation time, which left the first month of every tenancy uncovered
// forever and asked the tenant to pay before they had any reason to work.
//
// The ledger is in HOURS. Nic: "if the agreement's eighty hours, somebody only
// works sixty, twenty hours would carry forward, and then next month they would
// have to work one hundred hours to be caught up."
//
// ORDER OF APPLICATION — the one thing the spec did not state, and it decides
// whether the whole thing works. Hours land on THEIR OWN MONTH FIRST, and only
// the surplus flows back to older deficits. Oldest-first is the tempting
// alternative and it is a trap: it would clear the old debt every month and
// leave a permanently fresh current-month shortfall, so no deficit would ever
// grow old enough to trip the leniency window, and an agreement that is never
// going to be caught up would run forever.
//
// A carried hour keeps ITS OWN MONTH'S VALUE (`hourRate`, frozen at settlement).
// A rent increase must not retroactively reprice labour somebody already failed
// to do.
//
// SURPLUS BANKS WITHOUT LIMIT. Deficits follow the tenant, so credits follow
// them too. Banked hours buy months; they never become cash. That is what keeps
// this a trade rather than paid labour — the cap that used to enforce that
// (clamping a single month to 100%) still holds per month, it just no longer
// throws the excess away.

import { round2 } from './workTradeCredit'

/** Hours are logged to the quarter-hour in practice; 2dp is well inside that. */
export function round2h(hours: number): number {
  return Math.round((hours + Number.EPSILON) * 100) / 100
}

/**
 * One month's obligation, as the ledger sees it.
 *
 * `periodMonth` is an ISO first-of-month ('2026-09-01') and is the only date
 * this module knows about — everything else is ordering.
 */
export interface SettlementPeriod {
  periodMonth: string
  /** Hours this month asks for. Prorated when the invoice was prorated. */
  targetHours: number
  /** Hours already credited to this month by earlier runs. */
  hoursApplied: number
  /** Covered charges on this month's invoice, gross. Caps the credit. */
  basisAmount: number
  /** basis ÷ target, frozen when the period was opened. */
  hourRate: number
  /**
   * How many month-closes this period has already survived while open. The
   * period's own close is 0; it ages by one on every close after that.
   */
  agedCloses: number
}

/** What one period walked away from a settlement run with. */
export interface PeriodOutcome {
  periodMonth: string
  /** Hours credited to this period BY THIS RUN. */
  hoursAppliedNow: number
  /** Total hours credited to this period, all runs. */
  hoursAppliedTotal: number
  /** Hours the period still wants. */
  hoursOutstanding: number
  /** Dollars this period's invoice is credited, all runs — never > basis. */
  creditTotal: number
  /**
   * Dollars still uncovered on this period's invoice. Only meaningful once
   * `status` is 'billed'; while 'open' it is a running figure for display.
   */
  uncoveredAmount: number
  /**
   * How many month-closes this period has now survived while open. The job
   * persists it; a period that settles or bills stops ageing.
   */
  agedCloses: number
  status: 'open' | 'settled' | 'billed'
}

export interface SettlementInput {
  /**
   * Every period still open, plus the one just closing, OLDEST FIRST. The
   * closing month must be last — it is identified by position, not by date, so
   * this module never has to reason about calendars.
   */
  periods: SettlementPeriod[]
  /** Approved hours dated inside the month that is closing. */
  hoursWorked: number
  /** Hours carried in from previous runs. */
  bankedHours: number
  /**
   * Further closes a deficit may survive before it is billed in cash and the
   * agreement ends. 0 bills at the period's own close. Landlord-set, because
   * (Nic) "at some point a landlord's gonna know that somebody's never gonna be
   * able to physically catch up."
   */
  carryForwardMonths: number
}

export interface SettlementResult {
  periods: PeriodOutcome[]
  /** Hours left over after every obligation was met. Carried, uncapped. */
  bankedHours: number
  /**
   * Dollars to charge now because a period's leniency window closed with hours
   * still owed. Non-zero means the agreement ends.
   */
  billedAmount: number
  /** Periods that were billed out this run. */
  billedPeriods: string[]
  /** True when a deficit aged out — the caller ends the agreement. */
  endsAgreement: boolean
}

/**
 * Dollar value of one hour for a month: the whole covered bill divided by the
 * hours that month asks for. An 80-hour target makes an hour worth 1.25% of the
 * bill; a 100-hour target makes it 1%.
 *
 * A zero or negative target cannot produce a rate; callers must not open a
 * period for a month that asks for no hours.
 */
export function hourRateFor(basisAmount: number, targetHours: number): number {
  if (!(targetHours > 0)) return 0
  return Math.round((basisAmount / targetHours) * 10000) / 10000
}

/**
 * Prorate a month's hours target the same way the invoice prorated the rent.
 *
 * Nic (S624): an hour is a percentage of the bill, so if the bill is 11/31 of a
 * month the target has to be 11/31 of the hours — otherwise a tenant who moves
 * in on the 20th starts 69 hours in the hole for a month that only charged them
 * eleven days.
 *
 * Rounded UP to the quarter hour, and never to zero: a month that bills
 * anything at all asks for some work.
 */
export function proratedTarget(
  monthlyTarget: number, billedAmount: number, fullMonthAmount: number,
): number {
  if (!(monthlyTarget > 0)) return 0
  if (!(fullMonthAmount > 0)) return monthlyTarget
  const ratio = Math.min(1, billedAmount / fullMonthAmount)
  const raw = monthlyTarget * ratio
  const quarterUp = Math.ceil(raw * 4) / 4
  return Math.max(0.25, round2h(quarterUp))
}

/**
 * Run one month-close.
 *
 * Applies `hoursWorked` to the closing period, tops it up from the bank, sends
 * any surplus back to older deficits oldest-first, banks the rest, and bills out
 * any period whose leniency window has now closed with hours still owed.
 */
export function settleMonth(input: SettlementInput): SettlementResult {
  const { periods, carryForwardMonths } = input
  if (periods.length === 0) {
    return {
      periods: [], bankedHours: round2h(input.bankedHours),
      billedAmount: 0, billedPeriods: [], endsAgreement: false,
    }
  }

  // Working state, one entry per period, in the order given (oldest first).
  const state = periods.map(p => ({
    src: p,
    applied: round2h(p.hoursApplied),
    appliedNow: 0,
  }))
  const closing = state[state.length - 1]

  const want = (s: typeof state[number]) =>
    Math.max(0, round2h(s.src.targetHours - s.applied))

  /** Credit hours to a period, never past its target. Returns hours consumed. */
  const give = (s: typeof state[number], hours: number): number => {
    const used = Math.min(round2h(hours), want(s))
    if (used <= 0) return 0
    s.applied = round2h(s.applied + used)
    s.appliedNow = round2h(s.appliedNow + used)
    return used
  }

  // 1. This month's work pays for THIS month first. See the header — this
  //    ordering is what lets an old deficit actually age.
  let pool = round2h(Math.max(0, input.hoursWorked))
  pool = round2h(pool - give(closing, pool))

  // 2. Still short? Draw on the bank. A tenant who worked ahead has already
  //    earned this month.
  let bank = round2h(Math.max(0, input.bankedHours))
  if (want(closing) > 0 && bank > 0) {
    const drawn = give(closing, bank)
    bank = round2h(bank - drawn)
  }

  // 3. Surplus flows back to older deficits, oldest first — catching up is the
  //    point of carrying hours forward at all. Each older month is credited at
  //    ITS OWN frozen rate, which happens automatically: the rate lives on the
  //    period, not on the run.
  //
  //    The bank is spent before this month's surplus purely for tidiness; both
  //    are hours and neither is worth more than the other.
  const older = state.slice(0, -1)
  for (const s of older) {
    if (bank <= 0) break
    const drawn = give(s, bank)
    bank = round2h(bank - drawn)
  }
  for (const s of older) {
    if (pool <= 0) break
    pool = round2h(pool - give(s, pool))
  }

  // 4. Whatever is left banks, without limit.
  bank = round2h(bank + pool)

  // 5. Age the open periods and bill out any whose window has closed.
  //
  //    The closing period ages 0 — it has just had its own month. Everything
  //    older ages by one more close. A period is billed when it has survived
  //    more closes than the landlord allowed AND still wants hours.
  let billedAmount = 0
  const billedPeriods: string[] = []
  const outcomes: PeriodOutcome[] = state.map((s, i) => {
    const isClosing = i === state.length - 1
    const outstanding = want(s)
    const agedCloses = isClosing ? 0 : s.src.agedCloses + 1

    // Credit is the applied fraction of the basis, valued at this period's own
    // frozen rate. Computed from the rate rather than from basis × fraction so
    // that a period always prices its hours the way it promised to — and capped
    // at basis so rounding can never credit more than the bill.
    const creditTotal = Math.min(
      round2(s.src.basisAmount),
      round2(s.applied * s.src.hourRate),
    )
    const uncovered = round2(Math.max(0, s.src.basisAmount - creditTotal))

    let status: PeriodOutcome['status'] = 'open'
    if (outstanding <= 0) {
      status = 'settled'
    } else if (agedCloses > carryForwardMonths) {
      status = 'billed'
      billedAmount = round2(billedAmount + uncovered)
      billedPeriods.push(s.src.periodMonth)
    }

    return {
      periodMonth: s.src.periodMonth,
      hoursAppliedNow: round2h(s.appliedNow),
      hoursAppliedTotal: round2h(s.applied),
      hoursOutstanding: outstanding,
      creditTotal,
      uncoveredAmount: uncovered,
      agedCloses,
      status,
    }
  })

  return {
    periods: outcomes,
    bankedHours: bank,
    billedAmount: round2(billedAmount),
    billedPeriods,
    // Nic: a deficit that outlives the landlord's leniency is charged in cash
    // and the agreement ends. The manual "end it now" path settles the same way
    // — see settleOnEnd.
    endsAgreement: billedPeriods.length > 0,
  }
}

/**
 * Settle everything outstanding because the agreement is ending NOW — the
 * landlord marked it over, or the tenancy ended.
 *
 * Nic (S624): "when the landlord marks the work trade agreement as over, any
 * percentage of hours unpaid or uncompleted is billed immediately."
 *
 * Leniency does not apply: the window exists to give someone time to catch up,
 * and there is no more time. Banked hours ARE spent first — they were earned,
 * and refusing to let them cover a debt at the one moment it matters would take
 * work someone already did and throw it away.
 */
export function settleOnEnd(
  periods: SettlementPeriod[], bankedHours: number,
): SettlementResult {
  let bank = round2h(Math.max(0, bankedHours))
  let billedAmount = 0
  const billedPeriods: string[] = []

  // Oldest first. Which month a banked hour lands on is not cosmetic — periods
  // carry different frozen rates, so the order changes what the tenant is
  // billed. Oldest-first is the same order catch-up uses during a normal close,
  // and it clears the debt that has been outstanding longest.
  const outcomes: PeriodOutcome[] = periods.map(p => {
    let applied = round2h(p.hoursApplied)
    const wanted = Math.max(0, round2h(p.targetHours - applied))
    const drawn = Math.min(bank, wanted)
    if (drawn > 0) {
      applied = round2h(applied + drawn)
      bank = round2h(bank - drawn)
    }
    const outstanding = Math.max(0, round2h(p.targetHours - applied))
    const creditTotal = Math.min(round2(p.basisAmount), round2(applied * p.hourRate))
    const uncovered = round2(Math.max(0, p.basisAmount - creditTotal))
    const status: PeriodOutcome['status'] = outstanding <= 0 ? 'settled' : 'billed'
    if (status === 'billed') {
      billedAmount = round2(billedAmount + uncovered)
      billedPeriods.push(p.periodMonth)
    }
    return {
      periodMonth: p.periodMonth,
      hoursAppliedNow: drawn,
      hoursAppliedTotal: applied,
      hoursOutstanding: outstanding,
      creditTotal,
      uncoveredAmount: uncovered,
      agedCloses: p.agedCloses,
      status,
    }
  })

  return {
    periods: outcomes,
    // Hours left in the bank when an agreement ends are NOT paid out. They were
    // a trade, not wages (Nic's standing rule), and there is no month left for
    // them to buy. Zeroed here so the figure the caller writes back is honest
    // rather than a balance nobody can ever spend.
    bankedHours: 0,
    billedAmount: round2(billedAmount),
    billedPeriods,
    endsAgreement: true,
  }
}

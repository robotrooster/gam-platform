// S624 — work-trade month-close settlement. The HOURS ledger.
//
// This file is the arithmetic only: no database, no dates beyond a month key,
// no side effects. The job (jobs/workTradeSettlement.ts) reads rows, calls
// `settleMonth`, and writes what comes back. Keeping it pure is what lets the
// interesting cases — a deficit aging out, a bank covering a bad month, a
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
// A rent increase must not retroactively reprice labor somebody already failed
// to do.
//
// SURPLUS BANKS WITHOUT LIMIT. Deficits follow the tenant, so credits follow
// them too. Banked hours buy months; they never become cash. That is what keeps
// this a trade rather than paid labor — the cap that used to enforce that
// (clamping a single month to 100%) still holds per month, it just no longer
// throws the excess away.
//
// 10/12 (Nic) — UNLESS THE LANDLORD PAYS FOR EXTRA HOURS. Per agreement, the
// landlord picks what hours beyond what a month and any carried shortfall
// needed do: bank them (the default, everything above), or pay them at an
// hourly rate (`extraHours: 'pay'`). Paid extra hours come back as
// `payableHours` and do not bank. Banked hours still never become cash: new
// work always meets the needs first, so what is paid is only work beyond them.

import { round2 } from './workTradeCredit'
import type { WorkTradeSettlementStatus } from '@gam/shared'

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
   * persists it; a period that settles or bills stops aging.
   */
  agedCloses: number
  /** A run's outcome is never 'voided' (a voided period is never fed in). */
  status: Exclude<WorkTradeSettlementStatus, 'voided'>
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
  /**
   * 10/12: approved hours from OLDER months that no close has counted and that
   * their own months no longer need (an approval that landed after its month
   * closed). New work, like `hoursWorked` — not banked credit — so it fills this
   * month's gap before the bank does, and in 'pay' mode what is left is paid.
   */
  lateSurplusHours?: number
  /**
   * 10/12 (Nic): what approved hours beyond what this month and any carried
   * shortfall needed do. 'bank' (default) banks them; 'pay' returns them as
   * `payableHours` for the landlord to pay at the agreement's rate.
   */
  extraHours?: 'bank' | 'pay'
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
  /**
   * 10/12: hours of NEW work this run had left over after every need — this
   * month's, then any carried shortfall. In 'bank' mode they are inside
   * `bankedHours` already and this says how many this run added; in 'pay' mode
   * they are NOT banked (see `payableHours`).
   */
  extraHours: number
  /** 10/12: 'pay' mode only — the extra hours the landlord pays for. 0 in 'bank'. */
  payableHours: number
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
/**
 * Dollars a period's applied hours have bought, capped at the bill.
 *
 * S637 (Nic): a ZERO-hour agreement covers the month outright. The landlord
 * approves it for someone they trust to get the work done without counting —
 * "I wanna only track hours on people that I can't trust to get enough done."
 * No hours are expected, so there is nothing to fall short of and the whole
 * basis is credited. Pricing it the normal way (applied x rate) would credit
 * zero and leave the tenant the full gross bill, which is the exact opposite of
 * what the agreement says.
 */
export function periodCredit(
  basisAmount: number, targetHours: number, appliedHours: number, hourRate: number,
): number {
  if (!(targetHours > 0)) return round2(basisAmount)
  return Math.min(round2(basisAmount), round2(appliedHours * hourRate))
}

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
  const pays = input.extraHours === 'pay'
  if (periods.length === 0) {
    // Nothing to apply anything to: new work is all extra.
    const fresh = round2h(Math.max(0, input.hoursWorked) + Math.max(0, input.lateSurplusHours ?? 0))
    return {
      periods: [], bankedHours: round2h(Math.max(0, input.bankedHours) + (pays ? 0 : fresh)),
      billedAmount: 0, billedPeriods: [], endsAgreement: false,
      extraHours: fresh, payableHours: pays ? fresh : 0,
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
  // 10/12: approvals that landed after their own (older) month closed are new
  // work too, so they fill this month's gap next — before banked credit.
  pool = round2h(pool + Math.max(0, input.lateSurplusHours ?? 0))
  pool = round2h(pool - give(closing, pool))

  // 2. Surplus flows back to older deficits, oldest first — catching up is the
  //    point of carrying hours forward at all. Each older month is credited at
  //    ITS OWN frozen rate, which happens automatically: the rate lives on the
  //    period, not on the run.
  //
  //    10/12: new work goes to the older deficits BEFORE the bank. In 'bank'
  //    mode the order changes nothing (every hour left ends up in the bank
  //    either way, and each period receives the same total oldest-first). In
  //    'pay' mode it is the rule Nic set: extra hours are the hours worked
  //    beyond what the month AND any carried shortfall needed — so the
  //    shortfall is paid down with work first, and banked credit is never
  //    turned into wages by letting it cover a deficit the new hours would
  //    have covered.
  const older = state.slice(0, -1)
  for (const s of older) {
    if (pool <= 0) break
    pool = round2h(pool - give(s, pool))
  }

  // 3. Still short? Draw on the bank. A tenant who worked ahead has already
  //    earned these months.
  let bank = round2h(Math.max(0, input.bankedHours))
  if (want(closing) > 0 && bank > 0) {
    const drawn = give(closing, bank)
    bank = round2h(bank - drawn)
  }
  for (const s of older) {
    if (bank <= 0) break
    const drawn = give(s, bank)
    bank = round2h(bank - drawn)
  }

  // 4. Whatever new work is left is EXTRA. 'bank' (the default): it banks,
  //    without limit. 'pay' (10/12, Nic): the landlord pays it at the
  //    agreement's rate, so it does not bank.
  const extraHours = round2h(Math.max(0, pool))
  if (!pays) bank = round2h(bank + extraHours)

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
    const creditTotal = periodCredit(
      s.src.basisAmount, s.src.targetHours, s.applied, s.src.hourRate,
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
    extraHours,
    payableHours: pays ? extraHours : 0,
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
 *
 * S654: so are approved hours no close has counted yet — the month the
 * agreement ends in, mostly. `uncountedHours` (by periodMonth) lands on its own
 * period first, as at a close; any surplus joins the bank. Without it, ending
 * mid-month billed the whole month however much of it had been worked.
 */
export function settleOnEnd(
  periods: SettlementPeriod[], bankedHours: number,
  uncountedHours: Record<string, number> = {},
  opts: { lateSurplusHours?: number; extraHours?: 'bank' | 'pay' } = {},
): SettlementResult {
  let bank = round2h(Math.max(0, bankedHours))
  const pays = opts.extraHours === 'pay'
  let billedAmount = 0
  const billedPeriods: string[] = []

  const state = periods.map(p => ({ p, applied: round2h(p.hoursApplied), now: 0 }))
  const give = (s: typeof state[number], hours: number): number => {
    const used = Math.min(round2h(hours), Math.max(0, round2h(s.p.targetHours - s.applied)))
    if (used <= 0) return 0
    s.applied = round2h(s.applied + used)
    s.now = round2h(s.now + used)
    return used
  }
  // Each period's own uncounted hours first. 10/12: the surplus is NEW work
  // (`fresh`), kept apart from banked credit: it pays down the remaining
  // deficits before the bank does, and in 'pay' mode what is left is paid.
  let fresh = round2h(Math.max(0, opts.lateSurplusHours ?? 0))
  for (const s of state) {
    const own = round2h(Math.max(0, uncountedHours[s.p.periodMonth] ?? 0))
    fresh = round2h(fresh + own - give(s, own))
  }

  // Oldest first. Which month a banked hour lands on is not cosmetic — periods
  // carry different frozen rates, so the order changes what the tenant is
  // billed. Oldest-first is the same order catch-up uses during a normal close,
  // and it clears the debt that has been outstanding longest. New work first,
  // then the bank (10/12 — see settleMonth step 2; in 'bank' mode the order
  // changes nothing, since every hour is spent oldest-first either way).
  for (const s of state) {
    if (fresh <= 0) break
    fresh = round2h(fresh - give(s, fresh))
  }
  const outcomes: PeriodOutcome[] = state.map(s => {
    const p = s.p
    if (bank > 0) bank = round2h(bank - give(s, bank))
    const applied = s.applied
    const outstanding = Math.max(0, round2h(p.targetHours - applied))
    const creditTotal = periodCredit(p.basisAmount, p.targetHours, applied, p.hourRate)
    const uncovered = round2(Math.max(0, p.basisAmount - creditTotal))
    const status: PeriodOutcome['status'] = outstanding <= 0 ? 'settled' : 'billed'
    if (status === 'billed') {
      billedAmount = round2(billedAmount + uncovered)
      billedPeriods.push(p.periodMonth)
    }
    return {
      periodMonth: p.periodMonth,
      hoursAppliedNow: s.now,
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
    //
    // 10/12: NEW work left over is different on an agreement set to pay extra
    // hours — those hours were worked beyond everything the trade asked, and
    // the landlord chose to pay for such hours (`payableHours`). On a 'bank'
    // agreement they would have banked, and the bank ends here, so they go too.
    bankedHours: 0,
    billedAmount: round2(billedAmount),
    billedPeriods,
    endsAgreement: true,
    extraHours: round2h(Math.max(0, fresh)),
    payableHours: pays ? round2h(Math.max(0, fresh)) : 0,
  }
}

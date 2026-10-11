import { DateTime } from 'luxon'

// US federal holidays with observed-day shift rules.
// Saturday holidays observe Friday; Sunday holidays observe Monday.
// ACH does not settle on federal holidays — this drives disbursement SLA math.

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): DateTime {
  // weekday: 1=Mon..7=Sun (Luxon convention)
  let dt = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' })
  const offset = (weekday - dt.weekday + 7) % 7
  dt = dt.plus({ days: offset + (n - 1) * 7 })
  return dt
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): DateTime {
  const last = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' }).endOf('month').startOf('day')
  const offset = (last.weekday - weekday + 7) % 7
  return last.minus({ days: offset })
}

function observedDate(dt: DateTime): DateTime {
  if (dt.weekday === 6) return dt.minus({ days: 1 }) // Sat -> Fri
  if (dt.weekday === 7) return dt.plus({ days: 1 })  // Sun -> Mon
  return dt
}

/** Returns ISO date strings (YYYY-MM-DD) for US federal holidays in a given year, observed. */
export function usFederalHolidays(year: number): string[] {
  const fixed: Array<[number, number]> = [
    [1, 1],   // New Year's Day
    [6, 19],  // Juneteenth
    [7, 4],   // Independence Day
    [11, 11], // Veterans Day
    [12, 25], // Christmas Day
  ]
  const floats: DateTime[] = [
    nthWeekdayOfMonth(year, 1, 1, 3),   // MLK Day: 3rd Monday Jan
    nthWeekdayOfMonth(year, 2, 1, 3),   // Presidents Day: 3rd Monday Feb
    lastWeekdayOfMonth(year, 5, 1),     // Memorial Day: last Monday May
    nthWeekdayOfMonth(year, 9, 1, 1),   // Labor Day: 1st Monday Sep
    nthWeekdayOfMonth(year, 10, 1, 2),  // Columbus Day: 2nd Monday Oct
    nthWeekdayOfMonth(year, 11, 4, 4),  // Thanksgiving: 4th Thursday Nov
  ]
  const all: DateTime[] = [
    ...fixed.map(([m, d]) => observedDate(DateTime.fromObject({ year, month: m, day: d }, { zone: 'utc' }))),
    ...floats, // already weekday-anchored, no observed shift
  ]
  return all.map(d => d.toISODate()!).sort()
}

/**
 * 10/5 (Nic): the days BANKS are closed for a holiday — the Federal Reserve's
 * rule, which differs from the federal-employee rule above in one way: a
 * holiday on a Saturday is NOT moved to the Friday before (the Fed and banks
 * stay open that Friday); one on a Sunday is still closed the Monday after.
 * Used to judge when a bank posts a branch deposit (lastPostingDayFor).
 */
export function usBankHolidays(year: number): string[] {
  const fixed: Array<[number, number]> = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]]
  const fixedClosed = fixed
    .map(([m, d]) => DateTime.fromObject({ year, month: m, day: d }, { zone: 'utc' }))
    .filter(dt => dt.weekday !== 6)
    .map(dt => (dt.weekday === 7 ? dt.plus({ days: 1 }) : dt))
  const floats: DateTime[] = [
    nthWeekdayOfMonth(year, 1, 1, 3), nthWeekdayOfMonth(year, 2, 1, 3), lastWeekdayOfMonth(year, 5, 1),
    nthWeekdayOfMonth(year, 9, 1, 1), nthWeekdayOfMonth(year, 10, 1, 2), nthWeekdayOfMonth(year, 11, 4, 4),
  ]
  return [...fixedClosed, ...floats].map(d => d.toISODate()!).sort()
}

/** 10/5: `n` days banks are open after `from` — weekends and bank holidays (usBankHolidays) skipped. */
export function addBankBusinessDays(from: string, n: number): string {
  return walkBusinessDays(from, n, usBankHolidays)
}

export function isUsFederalHoliday(isoDate: string): boolean {
  const year = parseInt(isoDate.slice(0, 4), 10)
  return usFederalHolidays(year).includes(isoDate)
}

/** Last business day of a given month in a given timezone. Skips weekends + US federal holidays. */
export function lastBusinessDay(year: number, month: number, timezone: string): DateTime {
  let dt = DateTime.fromObject({ year, month, day: 1 }, { zone: timezone }).endOf('month').startOf('day')
  const holidays = new Set(usFederalHolidays(year))
  while (dt.weekday === 6 || dt.weekday === 7 || holidays.has(dt.toISODate()!)) {
    dt = dt.minus({ days: 1 })
  }
  return dt
}

/** Number of days in a given month (handles leap years). */
export function daysInMonth(year: number, month: number): number {
  return DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' }).daysInMonth!
}

/**
 * The ISO date `n` business days after `from`, skipping weekends and US
 * federal holidays.
 *
 * S617 (Nic): "threshold trigger plus four business days. That's the simpler
 * way to do it." This exists because the payout scheduler was adding four
 * CALENDAR days to the day a rent-roll threshold tripped, while Stripe releases
 * an ACH debit four BUSINESS days out. Those only agree in a week with no
 * weekend in it, so a payout scheduled off the calendar count fired before the
 * money existed, found an empty balance, and retired the trigger anyway —
 * spending one of the landlord's three monthly payouts on nothing.
 *
 * Verified against a real charge: an ACH created Wed 2026-08-19 came back from
 * Stripe with available_on Tue 2026-08-25, which is what this returns for
 * (2026-08-19, 4). The calendar count returned 2026-08-23, two days early.
 *
 * Holidays are looked up per year as the walk crosses one, so a window that
 * straddles New Year is correct in both years.
 */
export function addBusinessDays(from: string, n: number): string {
  return walkBusinessDays(from, n, usFederalHolidays)
}

function walkBusinessDays(from: string, n: number, holidaysOf: (year: number) => string[]): string {
  let dt = DateTime.fromISO(from, { zone: 'utc' })
  const holidaysByYear = new Map<number, Set<string>>()
  const holidaysFor = (year: number): Set<string> => {
    let s = holidaysByYear.get(year)
    if (!s) { s = new Set(holidaysOf(year)); holidaysByYear.set(year, s) }
    return s
  }
  let moved = 0
  while (moved < n) {
    dt = dt.plus({ days: 1 })
    const iso = dt.toISODate()!
    if (dt.weekday >= 6) continue                 // Sat/Sun
    if (holidaysFor(dt.year).has(iso)) continue   // federal holiday
    moved++
  }
  return dt.toISODate()!
}

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

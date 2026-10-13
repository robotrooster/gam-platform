/**
 * THE RENT ROLL'S RANGE (10/13, Nic) — which months the history page shows.
 *
 *   "the rent roll page is the historical lookup for previous reportings for
 *    quarters or years or individual months or whatever."
 *   Answered 10/13: "custom ranges per property with pre populated quick
 *   select buttons" — Last month · This quarter · Last quarter · This year ·
 *   Last year · All time, plus a custom start/end month range.
 *
 * One range ("the view") applies to whichever property is open: "I don't want
 * to be able to have one property looking one way and one property looking
 * another way." It rides in the page's address (?range=<quick pick>, or
 * ?from=&to= for a custom range), so switching property keeps it and a reload
 * or a shared link lands on the same view. Months are
 * 'YYYY-MM'; quarters are calendar quarters (Jan–Mar …).
 */

export const RANGE_PICKS = ['last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'all'] as const
export type RangePick = typeof RANGE_PICKS[number]
export const RANGE_PICK_LABEL: Record<RangePick, string> = {
  last_month:   'Last month',
  this_quarter: 'This quarter',
  last_quarter: 'Last quarter',
  this_year:    'This year',
  last_year:    'Last year',
  all:          'All time',
}

/** A range of bill months, inclusive, or all time (the property's first bill through the open month). */
export type MonthRange = { all: true } | { all: false; from: string; to: string }

/** The view a page opens on when its address names none. */
export const DEFAULT_RANGE_PICK: RangePick = 'last_month'

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** 'YYYY-MM' n months after (or before, n < 0) `ym`. */
export function addMonths(ym: string, n: number): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}

/** The calendar quarter's first month ('2026-07' for '2026-08'). */
function quarterStart(ym: string): string {
  const m = Number(ym.slice(5, 7))
  return `${ym.slice(0, 4)}-${String(m - ((m - 1) % 3)).padStart(2, '0')}`
}

/** The months a quick pick covers, judged on `today` ('YYYY-MM-DD' or 'YYYY-MM'). */
export function rangeOfPick(pick: RangePick, today: string): MonthRange {
  const now = today.slice(0, 7)
  const year = now.slice(0, 4)
  switch (pick) {
    case 'last_month': { const m = addMonths(now, -1); return { all: false, from: m, to: m } }
    case 'this_quarter': return { all: false, from: quarterStart(now), to: now }
    case 'last_quarter': { const s = addMonths(quarterStart(now), -3); return { all: false, from: s, to: addMonths(s, 2) } }
    case 'this_year': return { all: false, from: `${year}-01`, to: now }
    case 'last_year': { const y = String(Number(year) - 1); return { all: false, from: `${y}-01`, to: `${y}-12` } }
    case 'all': return { all: true }
  }
}

export function isRangePick(v: unknown): v is RangePick {
  return typeof v === 'string' && (RANGE_PICKS as readonly string[]).includes(v)
}

/**
 * The view on screen: the quick pick that is lit (null for a custom range)
 * and the months it covers. A quick pick rides in the address by name
 * (?range=last_quarter) so it stays lit — in January "This year" and "This
 * quarter" are the same months, and the one clicked is the one lit — and it
 * means the same words on another day. A custom range rides as ?from=&to=.
 */
export interface RangeView { pick: RangePick | null; range: MonthRange }

/**
 * The view the address names: ?range=<quick pick>, or ?from=&to= (two good
 * months, the start on or before the end, the end no later than this month).
 * Anything else — nothing, or a range the page cannot show — is the default.
 */
export function viewFromParams(params: URLSearchParams, today: string): RangeView {
  const named = params.get('range')
  if (isRangePick(named)) return { pick: named, range: rangeOfPick(named, today) }
  const from = params.get('from'), to = params.get('to')
  if (from && to && MONTH.test(from) && MONTH.test(to) && from <= to && to <= today.slice(0, 7)) {
    return { pick: null, range: { all: false, from, to } }
  }
  return { pick: DEFAULT_RANGE_PICK, range: rangeOfPick(DEFAULT_RANGE_PICK, today) }
}

/** The address's search params with the view written into them (every other param — the property — kept). */
export function withViewParams(params: URLSearchParams, view: RangePick | { from: string; to: string }): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('range'); next.delete('from'); next.delete('to')
  if (typeof view === 'string') next.set('range', view)
  else { next.set('from', view.from); next.set('to', view.to) }
  return next
}

/** GET /api/balances/rent-roll/history for a property and a range (services/rentRoll's contract). */
export function historyPath(propertyId: string, range: MonthRange): string {
  const q = new URLSearchParams({ propertyId })
  if (range.all) q.set('range', 'all')
  else { q.set('from', range.from); q.set('to', range.to) }
  return `/balances/rent-roll/history?${q.toString()}`
}

/** A stable key for a range (the query cache). */
export function rangeKey(range: MonthRange): string {
  return range.all ? 'all' : `${range.from}..${range.to}`
}

/**
 * The months the custom start/end boxes offer, newest first: this month back
 * to January five years ago — and further back when the range on screen
 * reaches earlier (All time on a long-billed property).
 */
export function monthChoices(today: string, earliest?: string | null): string[] {
  const now = today.slice(0, 7)
  let first = `${Number(now.slice(0, 4)) - 5}-01`
  if (earliest && MONTH.test(earliest) && earliest < first) first = earliest
  const out: string[] = []
  for (let m = now; m >= first; m = addMonths(m, -1)) out.push(m)
  return out
}

/**
 * A custom range after one box changed: a start after the end moves the end
 * to it, an end before the start moves the start to it — never a backwards
 * range.
 */
export function customRange(current: { from: string; to: string }, edge: 'from' | 'to', month: string): { from: string; to: string } {
  if (edge === 'from') return { from: month, to: month > current.to ? month : current.to }
  return { from: month < current.from ? month : current.from, to: month }
}

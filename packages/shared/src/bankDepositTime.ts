// 10/6 (Nic) — "about what time were you at the bank?"
//
// Nic, 10/6: "the tenant logs into the portal and they say, hey, I deposited
// ... on this date at ... approximately this time. Maybe they just pick a
// time, you know, three o'clock, four o'clock ... GAM can match the
// transaction to something near that window because for people that pay the
// exact same amount, the probability that they're going to be in the bank at
// exactly the same time also kind of shrinks."
//
// Two halves live here so the tenant's form, the server and the landlord's
// match screen say the same thing:
//   - the hour the tenant picks (8 AM … 6 PM by the hour, or after hours /
//     ATM), required on every new report;
//   - the time the BANK wrote on its own line, when it wrote one. The bank
//     feed (Stripe Financial Connections) gives a posted date, an amount and
//     the bank's description only. Some banks put the deposit's own date and
//     time in that description — Mountain View's writes "eDeposit in Branch
//     09/30/26 04:39:28 PM 360 W CONTINENTAL RD GREEN VALLEY AZ" — and others
//     write nothing of the kind ("DEPOSIT *4662"). No time on the line means
//     no time, never a guess.

/** The hours a tenant may pick, 8 AM through 6 PM (24-hour clock). */
export const DEPOSIT_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const
export type DepositHour = typeof DEPOSIT_HOURS[number]

/** The choice for a deposit made outside banking hours or at an ATM. */
export const DEPOSIT_AFTER_HOURS = 'after_hours' as const

/** What the tenant picks: an hour from DEPOSIT_HOURS, or after hours / ATM. */
export type DepositHourChoice = DepositHour | typeof DEPOSIT_AFTER_HOURS

export const DEPOSIT_HOUR_QUESTION = 'About what time?'
export const DEPOSIT_AFTER_HOURS_LABEL = 'After hours / ATM'
/** 10/6 (Nic): the hint under the tenant's hour picker. */
export const DEPOSIT_HOUR_HINT =
  'Pick the hour you were at the bank — it helps us find your deposit when someone else deposits the same amount.'
/** The server's refusal of a report with no time picked. */
export const DEPOSIT_HOUR_REQUIRED =
  'Pick about what time you were at the bank — it helps us find your deposit when someone else deposits the same amount.'

/** 8 → "8 AM", 12 → "12 PM", 15 → "3 PM". */
export function depositHourLabel(hour: number): string {
  const h = Math.trunc(Number(hour))
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve} ${h < 12 ? 'AM' : 'PM'}`
}

/** Is this a time a tenant may report? */
export function isDepositHourChoice(v: unknown): v is DepositHourChoice {
  return v === DEPOSIT_AFTER_HOURS || (typeof v === 'number' && (DEPOSIT_HOURS as readonly number[]).includes(v))
}

/**
 * The reported time as words for either side: "about 3 PM", "after hours or
 * at an ATM", or null for a report made before the time was asked.
 */
export function reportedTimeText(o: { hour?: number | null; afterHours?: boolean | null }): string | null {
  if (o.afterHours) return 'after hours or at an ATM'
  if (o.hour == null || !Number.isFinite(Number(o.hour))) return null
  return `about ${depositHourLabel(Number(o.hour))}`
}

/** Minutes after midnight → "4:39 PM". */
export function minutesLabel(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, '0')
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve}:${mm} ${h < 12 ? 'AM' : 'PM'}`
}

/** What the bank's own line says about when the deposit was made. */
export interface BankLineWhen {
  /** The deposit's own day written on the line (YYYY-MM-DD), when the bank wrote one. */
  date: string | null
  /** Minutes after midnight written on the line, when the bank wrote a time. */
  minutes: number | null
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const isoOf = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`
const validDay = (y: number, m: number, d: number) => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400000

/**
 * How far before the posting a date written on the line may be and still be
 * this deposit's own day (a long weekend, a slow branch). A date after the
 * posting by more than a day is not the deposit's day (a reference that looks
 * like one) and is ignored.
 */
const LINE_DATE_BEFORE_POSTING_DAYS = 10

/**
 * Read the deposit's own date and time from the bank's description, when the
 * bank wrote them. Formats differ by bank; what is read:
 *   - a time with a colon: "04:39:28 PM", "4:39 PM", "4:39PM", "16:39",
 *     "16:39:28", "04:39:28", "4:39 P.M." (a time without a colon — "1639" —
 *     is never read: it cannot be told apart from a reference number; a time
 *     with no AM/PM that a 12-hour clock could also write — "4:39", "12:30" —
 *     is never read either);
 *   - a date: "09/30/26", "09/30/2026", "9-30-26", "09/30" (the year taken
 *     from the posting), never one more than a day after the posting or more
 *     than ten days before it.
 * Nothing found → nulls. The posted date is the bank's own field and is never
 * replaced by what is read here; this only says when, inside it, the deposit
 * was made.
 */
export function bankLineDateTime(description: string | null | undefined, postedDate: string): BankLineWhen {
  const text = String(description ?? '')
  let minutes: number | null = null
  const timeRe = /(?:^|[^\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?\s?[Mm]\.?(?![A-Za-z])|(?:^|[^\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/g
  for (const m of text.matchAll(timeRe)) {
    if (m[1] !== undefined) {
      const h = Number(m[1]); const mm = Number(m[2])
      if (h < 1 || h > 12 || mm > 59 || (m[3] !== undefined && Number(m[3]) > 59)) continue
      const pm = m[4].toUpperCase() === 'P'
      minutes = ((h % 12) + (pm ? 12 : 0)) * 60 + mm
      break
    }
    const h = Number(m[5]); const mm = Number(m[6])
    if (h > 23 || mm > 59 || (m[7] !== undefined && Number(m[7]) > 59)) continue
    // 10/6: a time with no AM/PM is read only when it cannot be a 12-hour
    // clock — an hour of 0 or 13 to 23 ("16:39"), or a two-digit hour with
    // seconds ("04:39:28", how a 24-hour bank stamps it). A bare "4:39" or
    // "12:30" could be morning or afternoon: no time, never a guess.
    const unambiguous = h === 0 || h >= 13 || (m[5].length === 2 && m[7] !== undefined)
    if (!unambiguous) continue
    minutes = h * 60 + mm
    break
  }

  let date: string | null = null
  const posted = String(postedDate ?? '').slice(0, 10)
  const py = Number(posted.slice(0, 4))
  if (py) {
    const dateRe = /(?:^|[^\d/-])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?(?![\d/-])/g
    for (const m of text.matchAll(dateRe)) {
      const mo = Number(m[1]); const d = Number(m[2])
      const years = m[3] !== undefined
        ? [m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])]
        : [py, py - 1] // no year: the posting's, or last year's for a December deposit posted in January
      for (const y of years) {
        if (!validDay(y, mo, d)) continue
        const iso = isoOf(y, mo, d)
        const before = dayNumber(posted) - dayNumber(iso)
        if (before >= -1 && before <= LINE_DATE_BEFORE_POSTING_DAYS) { date = iso; break }
      }
      if (date) break
    }
  }
  return { date, minutes }
}

/**
 * How far past its window a time can be and still fit the time the tenant
 * picked. Beyond it the bank's time says only "not this report" — it is
 * never the reason a report gets the line (services/declaredDepositAssign).
 */
export const DEPOSIT_TIME_FIT_MINUTES = 60

/**
 * How far, in minutes, a time the bank wrote is from the time the tenant
 * picked. The tenant picks "the hour you were at the bank", so the pick is
 * that whole hour: "about 3 PM" fits 3:00 through 3:59 exactly (0), and a
 * time outside it is the distance to its nearest edge (10/6 review: a 3:45
 * deposit is the 3 PM pick's, not the 4 PM pick's). After hours / ATM: the
 * distance to the nearest edge of banking hours (before 7:30 AM or after 6:30
 * PM is a perfect fit). Null when either side has no time.
 */
export function reportedTimeGapMinutes(
  report: { hour?: number | null; afterHours?: boolean | null }, lineMinutes: number | null,
): number | null {
  if (lineMinutes == null) return null
  if (report.afterHours) {
    const open = 7 * 60 + 30, close = 18 * 60 + 30
    if (lineMinutes <= open || lineMinutes >= close) return 0
    return Math.min(lineMinutes - open, close - lineMinutes)
  }
  if (report.hour == null) return null
  const start = Number(report.hour) * 60, end = start + 59
  if (lineMinutes >= start && lineMinutes <= end) return 0
  return lineMinutes < start ? start - lineMinutes : lineMinutes - end
}

/** Does the bank's time fit the tenant's pick (within DEPOSIT_TIME_FIT_MINUTES of its window)? */
export function reportedTimeFits(gapMinutes: number | null): boolean {
  return gapMinutes != null && gapMinutes <= DEPOSIT_TIME_FIT_MINUTES
}

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const countWord = (n: number, lower = false) => {
  const w = n >= 0 && n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n)
  return lower ? w.toLowerCase() : w
}
const usd = (n: number) => `$${(Math.round(Number(n) * 100) / 100).toFixed(2)}`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const md = (iso: string) => {
  const [, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return m && d ? `${MONTHS[m - 1]} ${d}` : String(iso)
}
const listOf = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/** Why GAM did not pick which report a deposit belongs to (the landlord's conflict card). */
export type ReportConflictKind =
  /** More reports than deposits, nothing to tell them apart. */
  | 'fewer_deposits'
  /** Deposits of the amount posted on different days: which is whose decides who paid late. */
  | 'who_is_late'
  /** Nothing tells the reports apart and the choice changes what they are told. */
  | 'no_difference'
  /** One deposit equals what two or more residents reported together. */
  | 'combined'

/**
 * 10/6 (Nic): the landlord's conflict card, in plain words — why GAM did not
 * pick, and what to do. "Two residents reported $450.00 on Oct 2 — pick which
 * deposit is whose."
 *
 * Residents are counted by who reported (tenantId), not by reports: one
 * resident with two reports is one resident. One resident and two deposits
 * that could each be theirs reads as that, never "One residents".
 */
export function reportConflictText(o: {
  kind: ReportConflictKind
  /** The reports in the conflict (amount each, the day each said, and who said it when known). */
  reports: Array<{ amount: number; declaredDate: string; tenantId?: string | null }>
  /** The bank lines in the conflict (amount each). */
  deposits: Array<{ amount: number; postedDate: string }>
}): string {
  const n = o.reports.length
  const people = new Set(o.reports.map((r, i) => r.tenantId ?? `report-${i}`)).size
  const days = [...new Set(o.reports.map(r => String(r.declaredDate).slice(0, 10)))].sort()
  const on = days.length === 1 ? `on ${md(days[0])}` : `on ${listOf(days.map(md))}`
  const d = o.deposits.length
  if (o.kind === 'combined') {
    const total = o.deposits[0]?.amount ?? o.reports.reduce((s, r) => s + r.amount, 0)
    const each = [...new Set(o.reports.map(r => usd(r.amount)))]
    const parts = each.length === 1 ? `${usd(o.reports[0].amount)} each` : listOf(o.reports.map(r => usd(r.amount)))
    const who = people === 1 ? `one resident reported in ${countWord(n, true)} reports` : `${countWord(people, true)} residents reported together`
    // 10/6 review: a confirm pays one household's bills, so the step that
    // works is recording each part by hand — never "pick", with nothing to pick.
    return `This ${usd(total)} deposit equals what ${who} `
      + `(${parts}, ${on}). GAM can't split one deposit between residents — record each resident's part from the payments screen.`
  }
  const amount = usd(o.reports[0]?.amount ?? o.deposits[0]?.amount ?? 0)
  const depositsWord = `${countWord(d, true)} ${amount} deposits`
  if (people === 1) {
    // One resident: the question is which deposit is theirs, not whose is whose.
    const said = n === 1 ? `A resident reported ${amount} ${on}` : `One resident reported ${amount} ${countWord(n, true)} times ${on}`
    if (o.kind === 'fewer_deposits') {
      return `${said}, and only ${d === 1 ? `one ${amount} deposit has` : `${depositsWord} have`} shown up at the bank so far — pick which report it is for.`
    }
    if (o.kind === 'who_is_late') {
      return `${said}, and ${d === 1 ? `one ${amount} deposit` : depositsWord} could be theirs — `
        + `the one you pick decides whether it counts on time.`
    }
    return `${said}, and ${d === 1 ? `one ${amount} deposit` : depositsWord} could be theirs — pick which one is theirs.`
  }
  const head = `${countWord(people)} residents reported ${amount} ${on} — pick which deposit is whose.`
  if (o.kind === 'fewer_deposits') {
    return `${head} ${d === 1 ? 'Only one' : `Only ${countWord(d, true)}`} ${amount} ${d === 1 ? 'deposit has' : 'deposits have'} shown up at the bank so far, and nothing tells the reports apart.`
  }
  if (o.kind === 'who_is_late') {
    return `${head} The deposits posted on different days, so which one is whose decides who paid late.`
  }
  return `${head} Nothing on the bank's lines tells them apart.`
}

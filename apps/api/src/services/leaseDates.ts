/**
 * S582 (Nic): platform lease-date rules — one source for every prefill path.
 *
 * START: the unit's available_date when it's in the future (the spot becomes
 *   available then); otherwise today. A mid-month start is prorated by the
 *   move-in invoice (jobs/moveInBundle.ts).
 * END (fixed term only): leases end at MONTH-END. The term is N full calendar
 *   months counted from the first FULL month — the partial first month rides on
 *   TOP — so a 12-month lease starting Aug 15 runs through Aug 31 the next year.
 *   This guarantees the term is always ≥ a full year and the final month is a
 *   full (un-prorated) bill, so a lease never prorates twice (in AND out).
 * DUE DAY: always the 1st (locked in @gam/shared WRITABLE_LEASE_COLUMN_SPECS).
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** Server-local 'YYYY-MM-DD' for today (local parts — no UTC-evening rollover). */
export function serverTodayYmd(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Parse 'YYYY-MM-DD' (or a Date/ISO) to its Y/M/D parts; null if unparseable. */
function ymdParts(v: string | Date | null | undefined): { y: number; m: number; d: number } | null {
  if (!v) return null
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Prefill start date: the unit's available_date if it's strictly in the future,
 * otherwise today. (An already-past availability isn't backdated onto a new lease.)
 */
export function computeLeaseStart(availableDate: string | Date | null, now: Date = new Date()): string {
  const today = serverTodayYmd(now)
  const p = ymdParts(availableDate)
  if (!p) return today
  const avail = `${p.y}-${pad(p.m)}-${pad(p.d)}`
  return cmp(avail, today) > 0 ? avail : today
}

/**
 * Fixed-term end date, snapped to month-end. Returns null for a non-positive term
 * (month-to-month — no end date). See the module header for the exact rule.
 */
export function computeLeaseEnd(startYmd: string, termMonths: number | null): string | null {
  if (!termMonths || termMonths <= 0) return null
  const p = ymdParts(startYmd)
  if (!p) return null
  // First FULL month: the start month if it begins on the 1st, else the next month.
  let fmY = p.y, fmM = p.m
  if (p.d !== 1) { fmM += 1; if (fmM > 12) { fmM = 1; fmY += 1 } }
  // Anchor the final month = firstFullMonth + (termMonths - 1), then take its last day.
  // JS Date month is 0-based; day 0 of the NEXT month = the last day of this month.
  const anchor = new Date(Date.UTC(fmY, (fmM - 1) + (termMonths - 1) + 1, 0, 12))
  return anchor.toISOString().slice(0, 10)
}

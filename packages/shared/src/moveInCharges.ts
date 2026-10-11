/**
 * S648 (Nic, DIRECTIVE) — page 8 of the lease IS the move-in invoice.
 *
 *   "First month's rent, proration... those should be changeable because
 *    landlords do stuff like that from time to time [move-in specials]. The
 *    total should still calculate everything from those and not be typable."
 *   "Page eight security deposit copies page two so they can't disagree."
 *   Onboarding residents: their move-in charges were paid long ago — $0.
 *
 * One set of arithmetic for the draft, the signing page, the server's check
 * and billing, so the page and the invoice can never tell different stories.
 */

/** Banker's rounding (half-even) to cents — the rounding billing has always used. */
export function roundHalfEvenCents(value: number): number {
  const cents = value * 100
  const floor = Math.floor(cents)
  const diff = cents - floor
  if (Math.abs(diff - 0.5) > 1e-9) return Math.round(cents) / 100
  return (floor % 2 === 0 ? floor : floor + 1) / 100
}

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').slice(0, 10))
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

// ── S648 (Nic): WHEN RENT IS DUE ──────────────────────────────────────────
export const RENT_DUE_MODES = ['fixed_day', 'move_in_day'] as const
export type RentDueMode = typeof RENT_DUE_MODES[number]
export const RENT_DUE_MODE_LABEL: Record<RentDueMode, string> = {
  fixed_day: 'Everyone on the same day',
  move_in_day: "Each tenant's move-in day",
}

/** "1st", "2nd", "15th" — how a due day prints on a lease. */
export function dueDayLabel(day: number): string {
  const n = Math.trunc(day)
  const t = n % 100
  const suf = t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suf}`
}

/**
 * Read a due day off a lease box ("the 15th", "15", "1st") → 1–28, else null.
 *
 * Nic: "the only thing we structured is that the 29th through the 31st are
 * moved to be due on the first because not every month has those days and we
 * don't want any skips." So a typed 29th, 30th or 31st reads as the 1st —
 * the same rule leaseDueDay applies to a move-in on those days. Anything
 * else that is not a day of the month (0, 32, words) is unreadable.
 */
export function parseDueDay(raw: unknown): number | null {
  const m = /(\d{1,2})/.exec(String(raw ?? ''))
  if (!m) return null
  const n = Number(m[1])
  if (n >= 1 && n <= 28) return n
  if (n >= 29 && n <= 31) return 1
  return null
}

/**
 * The day a new lease is due, from the property's rule.
 * move_in_day: the move-in day — except the 29th–31st, which are due on the 1st
 * ("late in the month it's just billed on the first").
 */
export function leaseDueDay(opts: { mode: RentDueMode | string; propertyDay: number; startIso: string | null }): number {
  if (opts.mode === 'move_in_day') {
    const p = opts.startIso ? parseIso(opts.startIso) : null
    if (!p) return 1
    return p.d > 28 ? 1 : p.d
  }
  const d = Math.trunc(Number(opts.propertyDay) || 1)
  return d >= 1 && d <= 28 ? d : 1
}

/** The first due date strictly after `startIso`, as YYYY-MM-DD. */
export function nextDueDateAfter(startIso: string, dueDay: number): string {
  const p = parseIso(startIso)!
  let y = p.y, m = p.m
  if (p.d >= dueDay) { m += 1; if (m > 12) { m = 1; y += 1 } }
  return `${y}-${String(m).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`
}

/**
 * Rent from the move-in day up to (not including) the next due date. Zero when
 * the tenant moves in ON a due day — their first full period starts that day.
 * With the 1st as the due day this is the long-standing days-left-in-the-month
 * rule exactly.
 */
export function prorateMoveInRent(rent: number, startIso: string, dueDay = 1): number {
  const p = parseIso(startIso)
  if (!p || !(rent > 0)) return 0
  if (p.d === dueDay) return 0
  const next = parseIso(nextDueDateAfter(startIso, dueDay))!
  const nextMs = Date.UTC(next.y, next.m - 1, next.d)
  const prevMs = Date.UTC(next.m === 1 ? next.y - 1 : next.y, next.m === 1 ? 11 : next.m - 2, dueDay)
  const startMs = Date.UTC(p.y, p.m - 1, p.d)
  const period = Math.round((nextMs - prevMs) / 86400000)
  const days = Math.round((nextMs - startMs) / 86400000)
  return roundHalfEvenCents(rent * days / period)
}

/** The calendar day before `iso`, as YYYY-MM-DD. */
export function dayBefore(iso: string): string {
  const p = parseIso(iso)!
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d - 1))
  return d.toISOString().slice(0, 10)
}

// ── RENEWALS: ONE TENANCY, ONE BILLING SCHEDULE ───────────────────────────
//
// Nic: "people get billed on their due date according to how the landlord
// sets the property." A renewal is not a move-in. The old lease bills every
// due date up to and including its last day; the new lease bills every due
// date after that. Nothing bills off-cycle because the paperwork changed.
//
// So the old lease is paid through the day before the first of its due dates
// AFTER its last day (P). The new lease's first bill is on the later of its
// start and P (B). B on the new lease's due day: full rent there and every due
// date after — no proration. B off the due day happens only when the landlord
// changed the due day on the new form (or left a gap): one prorated bridge
// from B to the next due day, then full rent.
//
// Used by the nightly bill run and by the signing pages, so the page and the
// bill can never tell different stories.
export interface RenewalSchedule {
  /** The first due date after the old lease's last day — it is paid up to here. */
  paidThrough: string
  /** The first bill under the new lease. */
  firstBill: string
  /** The prorated amount billed on firstBill when it is not a due date; null when it is. */
  bridge: number | null
  /** The first full month's rent under the new lease. */
  firstFullDue: string
  /** The new form moved the due day. A bridge without it is a gap between the leases. */
  dueDayChanged: boolean
}

export function renewalSchedule(opts: {
  /** The old lease's end date; null for a month-to-month that has none written. */
  oldEnd: string | null
  oldDueDay: number
  newStart: string
  newDueDay: number
  /** The new lease's monthly rent. */
  rent: number
}): RenewalSchedule {
  const clampDay = (d: number) => {
    const n = Math.trunc(Number(d) || 1)
    return n >= 1 && n <= 28 ? n : 1
  }
  const oldDay = clampDay(opts.oldDueDay)
  const newDay = clampDay(opts.newDueDay)
  // The old lease never bills on or after the new start, whatever its paper
  // end date says (a renewal can start early), and a month-to-month with no
  // end written runs to the day before.
  const lastOld = dayBefore(opts.newStart)
  const oldLast = opts.oldEnd && opts.oldEnd.slice(0, 10) < lastOld ? opts.oldEnd.slice(0, 10) : lastOld
  const paidThrough = nextDueDateAfter(oldLast, oldDay)
  const start = opts.newStart.slice(0, 10)
  const firstBill = paidThrough > start ? paidThrough : start
  const dueDayChanged = oldDay !== newDay
  if (Number(firstBill.slice(8, 10)) === newDay) {
    return { paidThrough, firstBill, bridge: null, firstFullDue: firstBill, dueDayChanged }
  }
  return {
    paidThrough,
    firstBill,
    bridge: prorateMoveInRent(Number(opts.rent) || 0, firstBill, newDay),
    firstFullDue: nextDueDateAfter(firstBill, newDay),
    dueDayChanged,
  }
}

/**
 * The renewal's billing in one plain sentence, for the signing pages — so the
 * landlord and the tenant read, beside page 8, what the first bill under the
 * new lease will be. Built from renewalSchedule, the same arithmetic the bill
 * run uses.
 */
export function renewalBillingSummary(s: RenewalSchedule, rent: number, newDueDay: number): string {
  const date = (iso: string) => {
    const p = parseIso(iso)
    return p ? new Date(Date.UTC(p.y, p.m - 1, p.d))
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : iso
  }
  const usd = (n: number) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const day = dueDayLabel(newDueDay)
  if (s.bridge == null) {
    return `Rent stays on its schedule, due on the ${day}. The first rent bill under this lease is ${date(s.firstBill)}: ${usd(rent)}.`
  }
  // A bridge with the due day unchanged is a gap between the leases (the old
  // one ended before the day this one starts): the day did not move.
  return `${s.dueDayChanged ? `Rent moves to the ${day}. ` : ''}The first bill under this lease is ${date(s.firstBill)}: ${usd(s.bridge)} for `
    + `${date(s.firstBill)} to ${date(dayBefore(s.firstFullDue))}, then ${usd(rent)} on ${date(s.firstFullDue)} and every ${day} after.`
}

export interface MoveInDefaults { firstMonthRent: number; proration: number }

/**
 * What page 8 starts at.
 *  - Onboarding (existing tenancy): the month's rent, no proration. Locked.
 *  - New tenant moving in on the due day: the month's rent, no proration.
 *  - New tenant mid-month: the proration; plus the next full month only where
 *    the property collects it up front.
 */
export function moveInDefaults(opts: {
  rent: number; startIso: string | null; existingTenancy: boolean; collectsNextPeriod: boolean
  /** S648: the lease's due day (default the 1st) and the property's rule. */
  dueDay?: number; mode?: RentDueMode | string
}): MoveInDefaults {
  const rent = Number(opts.rent) || 0
  const dueDay = opts.dueDay ?? 1
  if (opts.existingTenancy) return { firstMonthRent: roundHalfEvenCents(rent), proration: 0 }
  const p = opts.startIso ? parseIso(opts.startIso) : null
  // Due on the move-in day (anniversary billing, or moving in on the due day):
  // the first full period starts that day — no proration.
  if (!p || p.d === dueDay || opts.mode === 'move_in_day') {
    return { firstMonthRent: roundHalfEvenCents(rent), proration: 0 }
  }
  return {
    firstMonthRent: opts.collectsNextPeriod ? roundHalfEvenCents(rent) : 0,
    proration: prorateMoveInRent(rent, opts.startIso!, dueDay),
  }
}

/** Parse a money box: "$1,250.00" → 1250; blank / N/A / junk → 0. */
export function moneyBoxValue(raw: unknown): number {
  const t = String(raw ?? '').trim()
  if (!t) return 0
  const n = Number(t.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
}

/** The page 8 deposit line: page 2's deposit for a new tenant, $0 for onboarding. */
export function moveInDepositMirror(pageTwoDeposit: unknown, existingTenancy: boolean): number {
  return existingTenancy ? 0 : moneyBoxValue(pageTwoDeposit)
}

/** Everything the move-in invoice bills, as page 8 states it. */
export function moveInTotalDue(opts: {
  firstMonthRent: unknown; proration: unknown; depositMirror: number
  /** Every one-time move-in fee box on the lease (pet deposit, pet fee, …). */
  moveInFees: unknown[]
}): number {
  const fees = opts.moveInFees.reduce<number>((s, v) => s + moneyBoxValue(v), 0)
  return Math.round((moneyBoxValue(opts.firstMonthRent) + moneyBoxValue(opts.proration)
    + opts.depositMirror + fees) * 100) / 100
}

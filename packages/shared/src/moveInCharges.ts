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

/** Read a due day off a lease box ("the 15th", "15", "1st") → 1–28, else null. */
export function parseDueDay(raw: unknown): number | null {
  const m = /(\d{1,2})/.exec(String(raw ?? ''))
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 28 ? n : null
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

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

/** Days from the move-in date through the end of that month, as rent. */
export function prorateMoveInRent(rent: number, startIso: string): number {
  const p = parseIso(startIso)
  if (!p || !(rent > 0)) return 0
  if (p.d === 1) return 0
  const dim = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate()
  return roundHalfEvenCents(rent * (dim - p.d + 1) / dim)
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
}): MoveInDefaults {
  const rent = Number(opts.rent) || 0
  if (opts.existingTenancy) return { firstMonthRent: roundHalfEvenCents(rent), proration: 0 }
  const p = opts.startIso ? parseIso(opts.startIso) : null
  if (!p || p.d === 1) return { firstMonthRent: roundHalfEvenCents(rent), proration: 0 }
  return {
    firstMonthRent: opts.collectsNextPeriod ? roundHalfEvenCents(rent) : 0,
    proration: prorateMoveInRent(rent, opts.startIso!),
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

/**
 * 10/12 (Nic) — the payment stamps on the Rent Roll and the tenant payment
 * report: one per household per bill month, the one payment-health definition
 * (the server's services/householdMonths decides every stamp; this only says
 * it). Words and letters come from the shared maps, never a raw value.
 */
import { HEALTH_ONBOARDING_NOT_COUNTED, HEALTH_NOTHING_JUDGED, type PaymentStamp } from '@gam/shared'
import { monthTitle } from './creditDesk'

/** One month of one household, as the server sends it (camelCase on the wire). */
export interface StampMonth {
  month: string
  stamp: PaymentStamp | null
  stampLabel: string | null
  daysPastGrace: number
  charged: number
  chargedLateFees?: number
  paid: number
  credit: number
  workTrade: number
  owed: number
  firstPaidOn?: string | null
  paidInFullOn: string | null
  onboarding: boolean
  workTradeOnly: boolean
}

export interface HealthFigure {
  percent: number | null
  onTime: number
  counted: number
  paidLate: number
  partial: number
  outstanding: number
  notCounted: number
  workTrade: number
  from: string
  through: string
  label: string
  /** The onboarding month was judged and left out (paid late; good news only). */
  onboardingLeftOut?: boolean
}

export interface ChargeLine {
  paymentId: string
  householdId: string
  month: string
  dueDate: string
  label: string
  detail: string | null
  type: string
  unitNumber: string | null
  propertyName: string | null
  charged: number
  paid: number
  credit: number
  workTrade: number
  owed: number
  paidOn: string | null
  howPaid: string | null
  daysPastGrace: number
  invoiceId: string | null
  isLateFee: boolean
}

/** 'Oct' for '2026-10'. */
export function shortMonth(ym: string): string {
  return monthTitle(ym).slice(0, 3)
}

/**
 * 10/12: the strip is every month since the first bill (all time), so two
 * Octobers can sit in one strip. A month in another year than the picked one
 * carries its year ("’25") under its name; the picked year's months do not.
 */
export function stripYear(ym: string, through: string): string | null {
  return ym.slice(0, 4) === through.slice(0, 4) ? null : `’${ym.slice(2, 4)}`
}

/**
 * 10/12 (Nic): one health figure, one color, on every screen that shows it
 * (the Tenants list, the profile, the Rent Roll, the report): 90% and up
 * green, 75% and up amber, below that red, gray before any month is judged.
 * The Tenants list used to turn amber at 70 and the profile at 75 — the same
 * 72% read amber on one and red on the other.
 */
export const HEALTH_GOOD_PCT = 90
export const HEALTH_FAIR_PCT = 75
export function healthColor(p: number | null | undefined): string {
  if (p === null || p === undefined) return 'var(--text-3)'
  return p >= HEALTH_GOOD_PCT ? 'var(--green)' : p >= HEALTH_FAIR_PCT ? 'var(--amber)' : 'var(--red)'
}
/**
 * 10/13 (Nic), the onboarding month (September at Mountain View) paid late:
 * "Keep it out, but say so." What health says while nothing is counted —
 * "Onboarding month — not counted" when the onboarding month was judged and
 * left out, else "No months to judge yet" — never a bare dash.
 */
export function healthNoneWords(h: { onboardingLeftOut?: boolean } | null | undefined): string {
  return h?.onboardingLeftOut ? HEALTH_ONBOARDING_NOT_COUNTED : HEALTH_NOTHING_JUDGED
}

/** The word under the figure on the profile; nothing counted yet: why (healthNoneWords). */
export function healthWord(p: number | null | undefined, h?: { onboardingLeftOut?: boolean } | null): string {
  if (p === null || p === undefined) return healthNoneWords(h)
  return p >= HEALTH_GOOD_PCT ? 'Excellent' : p >= HEALTH_FAIR_PCT ? 'Good' : 'Needs attention'
}

/** The figure: "50%" — or, before any month is counted, why in words (healthNoneWords), never a dash. */
export function healthText(h: Pick<HealthFigure, 'percent' | 'onboardingLeftOut'> | null | undefined): string {
  return h && h.percent !== null ? `${h.percent}%` : healthNoneWords(h)
}

/**
 * On hover: "Pays on time: 50%, 1 of 2 months — all time through October
 * 2026"; when the onboarding month was left out beside counted months, it says
 * so ("Keep it out, but say so").
 */
export function healthTitle(h: Pick<HealthFigure, 'percent' | 'label' | 'through' | 'onboardingLeftOut'>): string {
  const left = h.onboardingLeftOut && h.percent !== null ? ' · the onboarding month is not counted' : ''
  return `Pays on time: ${h.label}${left} — all time through ${monthTitle(h.through)}`
}

/**
 * A charge line's lateness in words: days past grace, "On time" once paid
 * inside it, "Not late yet" while still owed inside it (10/12: an unpaid bill
 * this month used to read "On time"), and nothing for a late fee (a late fee
 * is never itself late).
 */
export function lineLateness(l: Pick<ChargeLine, 'isLateFee' | 'daysPastGrace' | 'owed' | 'workTrade'>): string {
  if (l.isLateFee) return '—'
  if (l.daysPastGrace > 0) return `${l.daysPastGrace}`
  return l.owed > 0 ? 'Not late yet' : 'On time'
}

/**
 * A CSV field, quoted when it needs to be. 10/12: text that starts like a
 * formula (= + - @, a tab or a carriage return) is opened as a formula by
 * Excel and Sheets — a resident named "=HYPERLINK(…)" would run in the
 * landlord's spreadsheet (CSV injection) — so it gets a leading apostrophe and
 * reads as plain text. Numbers stay numbers.
 */
export function csvField(v: unknown): string {
  const raw = v == null ? '' : String(v)
  const t = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${raw}` : raw
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

export function csvLine(fields: unknown[]): string {
  return fields.map(csvField).join(',')
}

/** Hand the viewer a file to save (no dialog). */
export function downloadText(name: string, text: string, type = 'text/csv'): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

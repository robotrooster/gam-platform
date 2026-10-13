/**
 * 10/12 (Nic) — the payment stamps on the Rent Roll and the tenant payment
 * report: one per household per bill month, the one payment-health definition
 * (the server's services/householdMonths decides every stamp; this only says
 * it). Words and letters come from the shared maps, never a raw value.
 */
import { PAYMENT_STAMP_LABEL, PAYMENT_STAMP_LETTER, type PaymentStamp } from '@gam/shared'
import { money, dayWord, monthTitle } from './creditDesk'

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

/** The counts per stamp, as the server's camelCased keys. */
export interface StampCounts {
  month: string
  paidOnTime: number
  partial: number
  paidLate: number
  outstanding: number
  due: number
  workTrade: number
}

/** The camelCase key a stamp's count travels under. */
export const STAMP_COUNT_KEY: Record<PaymentStamp, keyof Omit<StampCounts, 'month' | 'workTrade'>> = {
  paid_on_time: 'paidOnTime',
  partial: 'partial',
  paid_late: 'paidLate',
  outstanding: 'outstanding',
  due: 'due',
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

/** The letter (and, for a late month, the days past grace) on a stamp. */
export function stampText(s: Pick<StampMonth, 'stamp' | 'daysPastGrace'>): string {
  if (!s.stamp) return '–'
  if ((s.stamp === 'paid_late' || s.stamp === 'outstanding' || s.stamp === 'partial') && s.daysPastGrace > 0) {
    return `${PAYMENT_STAMP_LETTER[s.stamp]}+${s.daysPastGrace}`
  }
  return PAYMENT_STAMP_LETTER[s.stamp]
}

/** What a stamp says on hover or tap: the month, the words, the money and the day. */
export function stampTitle(s: StampMonth): string {
  const head = `${monthTitle(s.month)}: ${s.stamp ? PAYMENT_STAMP_LABEL[s.stamp] : 'Nothing billed'}`
  if (!s.stamp) return head
  const bits = [head]
  if (s.workTradeOnly) bits.push('covered by work trade')
  if (s.daysPastGrace > 0) bits.push(`${s.daysPastGrace} day${s.daysPastGrace === 1 ? '' : 's'} past grace`)
  bits.push(`charged ${money(s.charged)}`, `paid ${money(s.paid + s.credit)}`)
  if (s.workTrade > 0) bits.push(`work trade ${money(s.workTrade)}`)
  if (s.owed > 0) bits.push(`owed ${money(s.owed)}`)
  if (s.paidInFullOn) bits.push(`paid in full ${dayWord(s.paidInFullOn)}`)
  if (s.onboarding) bits.push('onboarding month')
  return bits.join(' · ')
}

/** The status words under the pill: "paid Oct 3", "+7 days past grace", "due". */
export function statusNote(s: StampMonth | null): string | null {
  if (!s || !s.stamp) return null
  if (s.stamp === 'paid_on_time') return s.workTradeOnly ? 'work trade' : s.paidInFullOn ? `paid ${dayWord(s.paidInFullOn)}` : null
  if (s.stamp === 'paid_late') return `paid ${dayWord(s.paidInFullOn)} · ${s.daysPastGrace}d past grace`
  if (s.daysPastGrace > 0) return `${s.daysPastGrace} day${s.daysPastGrace === 1 ? '' : 's'} past grace`
  return s.stamp === 'due' ? 'not late yet' : null
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
/** The word under the figure on the profile. */
export function healthWord(p: number | null | undefined): string {
  if (p === null || p === undefined) return 'No months to judge yet'
  return p >= HEALTH_GOOD_PCT ? 'Excellent' : p >= HEALTH_FAIR_PCT ? 'Good' : 'Needs attention'
}

/** "50%, 1 of 2 months" — the server's words, or a dash before any month is judged. */
export function healthText(h: HealthFigure | null | undefined): string {
  return h && h.percent !== null ? `${h.percent}%` : '—'
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

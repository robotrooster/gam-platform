/**
 * S655 money plan, Step 15: the "Money received" / "Money billed" switch.
 *
 * Nic (10/2): "a landlord should be able to see how much money came in this
 * month, ACTUALLY came in, versus how much money actually was SCHEDULED to come
 * in... people need to be able to see it both ways."
 *
 * ONE switch, default Money received, drives every report, the dashboard's
 * income card, its trend and the property-health card. The choice is per
 * browser (a viewer's convenience, never shared state): it lives in
 * localStorage, every read and write is wrapped, and a page renders correctly
 * on the default when storage is missing, blocked or throws.
 *
 * The screen math the pages share lives here as small pure functions, so a
 * card and the report it opens cannot add the same figures up two ways.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  INCOME_BASES, DEFAULT_INCOME_BASIS, INCOME_BASIS_LABEL, INCOME_BASIS_NOTE,
  INCOME_LINES, INCOME_LINE_LABEL,
  BILLED_PARTS, BILLED_PART_LABEL, INCOME_CATEGORY_LABEL,
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, humanize,
  type IncomeBasis, type BilledPart, type IncomeCategory, type IncomeLine,
} from '@gam/shared'

export type { IncomeBasis }

export const INCOME_BASIS_STORAGE_KEY = 'gam_income_basis'

const round2 = (n: number) => Math.round(n * 100) / 100

// ─── The choice ──────────────────────────────────────────────────────────────

/** Anything that is not a known basis reads as the default (Money received). */
export function parseBasis(raw: unknown): IncomeBasis {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (INCOME_BASES as readonly string[]).includes(v) ? (v as IncomeBasis) : DEFAULT_INCOME_BASIS
}

type BasisStore = Pick<Storage, 'getItem' | 'setItem'>

/** The browser's storage, or null where touching it throws (private mode, blocked site data). */
function browserStore(): BasisStore | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

/** The viewer's last choice; Money received when there is none or storage fails. */
export function readIncomeBasis(store: BasisStore | null = browserStore()): IncomeBasis {
  try {
    return parseBasis(store?.getItem(INCOME_BASIS_STORAGE_KEY))
  } catch {
    return DEFAULT_INCOME_BASIS
  }
}

/** Remember the choice. A failure to save is silent: the page keeps working on the choice in hand. */
export function writeIncomeBasis(basis: IncomeBasis, store: BasisStore | null = browserStore()): void {
  try {
    store?.setItem(INCOME_BASIS_STORAGE_KEY, basis)
  } catch {
    /* private mode or blocked storage — the switch still works for this visit */
  }
}

// Every switch on the page moves together (the Reports page and a modal it
// opens, say), and a change in another tab follows here too.
const listeners = new Set<(b: IncomeBasis) => void>()
let current: IncomeBasis | null = null

function currentBasis(): IncomeBasis {
  if (current === null) current = readIncomeBasis()
  return current
}

export function setIncomeBasis(basis: IncomeBasis): void {
  current = parseBasis(basis)
  writeIncomeBasis(current)
  for (const l of [...listeners]) l(current)
}

/** [basis, setBasis] — shared by every component on the page, remembered per browser. */
export function useIncomeBasis(): [IncomeBasis, (b: IncomeBasis) => void] {
  const [basis, setLocal] = useState<IncomeBasis>(currentBasis)
  useEffect(() => {
    const onChange = (b: IncomeBasis) => setLocal(b)
    listeners.add(onChange)
    const onStorage = (e: StorageEvent) => {
      if (e.key !== INCOME_BASIS_STORAGE_KEY) return
      current = parseBasis(e.newValue)
      setLocal(current)
    }
    try { window.addEventListener('storage', onStorage) } catch { /* no window */ }
    return () => {
      listeners.delete(onChange)
      try { window.removeEventListener('storage', onStorage) } catch { /* no window */ }
    }
  }, [])
  const set = useCallback((b: IncomeBasis) => setIncomeBasis(b), [])
  return [basis, set]
}

/** Add `basis=` to a report path, keeping any query it already has. */
export function withBasis(path: string, basis: IncomeBasis): string {
  return `${path}${path.includes('?') ? '&' : '?'}basis=${encodeURIComponent(basis)}`
}

export const basisLabel = (basis: IncomeBasis): string => INCOME_BASIS_LABEL[basis]
export const basisNote = (basis: IncomeBasis): string => INCOME_BASIS_NOTE[basis]

/**
 * The basis the figures ON SCREEN were counted under: the one the API echoed
 * back with them (meta.basis / the dashboard's basis), else the switch. A
 * screen that keeps the last answer up while a flip loads labels it by this,
 * so a figure never sits under the other basis's name.
 */
export function figuresBasis(echoed: unknown, chosen: IncomeBasis): IncomeBasis {
  const v = typeof echoed === 'string' ? echoed.trim().toLowerCase() : ''
  return (INCOME_BASES as readonly string[]).includes(v) ? (v as IncomeBasis) : chosen
}

/**
 * True while a report on screen is out of date: it was counted under the other
 * basis (the switch has flipped and its re-run has not landed), or a run is in
 * flight. The screen dims it until the new answer lands.
 */
export function resultIsStale(resultBasis: unknown, chosen: IncomeBasis, running: boolean): boolean {
  return running || figuresBasis(resultBasis, chosen) !== chosen
}

/**
 * Does a statement list what became of its bills (Money billed, with parts)?
 * Then "collected so far" — made of those parts, inside the total — is not
 * listed again under "beside the total, not in it".
 */
export function showsBillOutcome(basis: IncomeBasis, partsCount: number): boolean {
  return basis === 'billed' && partsCount > 0
}

/** "Money received by month" / "Money billed by month". */
export function perMonthTitle(basis: IncomeBasis): string {
  return `${INCOME_BASIS_LABEL[basis]} by month`
}

// ─── Income lines ────────────────────────────────────────────────────────────

/**
 * The income lines in report order. The reports API also emits
 * 'movedToCredit' (Money billed: rent or a stay deposit already counted and
 * moved to credit for a later bill), which the shared list does not carry yet.
 */
export const INCOME_LINES_ORDER: readonly string[] = (INCOME_LINES as readonly string[]).includes('movedToCredit')
  ? INCOME_LINES
  : [...INCOME_LINES, 'movedToCredit']

const camelToSnake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** A P&L line's label: the shared label, never the raw key. */
export function incomeLineLabel(line: string): string {
  return INCOME_LINE_LABEL[line as IncomeLine] ?? (line === 'movedToCredit' ? 'Moved to credit' : humanize(camelToSnake(line)))
}

// ─── Money ───────────────────────────────────────────────────────────────────

export const money = (n: number | null | undefined): string =>
  n == null || !isFinite(Number(n))
    ? '—'
    : `${Number(n) < 0 ? '−' : ''}$${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const moneyWhole = (n: number | null | undefined): string =>
  n == null || !isFinite(Number(n))
    ? '—'
    : `${Number(n) < 0 ? '−' : ''}$${Math.round(Math.abs(Number(n))).toLocaleString('en-US')}`

/** Add a list of figures to the cent. */
export function sumAmounts(items: ReadonlyArray<{ amount: number }>): number {
  return round2(items.reduce((s, i) => s + (Number(i.amount) || 0), 0))
}

/** True when a set of lines adds up to its total, to the cent. */
export function linesAddUp(items: ReadonlyArray<{ amount: number }>, total: number): boolean {
  return Math.abs(sumAmounts(items) - round2(Number(total) || 0)) < 0.005
}

// ─── The income card (dashboard, Reports overview) ──────────────────────────

export interface IncomeCardData {
  received?: { amount: number; paidAhead: number; clearing: number }
  billed?: { amount: number; collected: number; clearing: number; stillOwed: number }
}

export interface IncomeCardView {
  label: string
  amount: number
  /** Plain lines shown under the figure, in order. */
  notes: string[]
}

/**
 * §0.0 (Nic): Money received — "Money received this month $A", "incl. $X paid
 * ahead for later bills", "+ $Y still clearing" beside it (never inside).
 * Money billed — "Money billed this month $B", with collected so far, clearing
 * and still owed, which add up to $B.
 */
export function incomeCardView(
  card: IncomeCardData | null | undefined, basis: IncomeBasis, period = 'this month',
  // To the cent: the parts under a whole-dollar figure must visibly add up to it.
  fmt: (n: number) => string = money,
): IncomeCardView {
  if (basis === 'billed') {
    const b = card?.billed ?? { amount: 0, collected: 0, clearing: 0, stillOwed: 0 }
    const parts = [`Collected so far ${fmt(b.collected)}`]
    if (b.clearing) parts.push(`clearing ${fmt(b.clearing)}`)
    parts.push(`still owed ${fmt(b.stillOwed)}`)
    return { label: `Money billed ${period}`, amount: b.amount, notes: [parts.join(' · ')] }
  }
  const r = card?.received ?? { amount: 0, paidAhead: 0, clearing: 0 }
  const notes: string[] = []
  if (r.paidAhead) notes.push(`incl. ${fmt(r.paidAhead)} paid ahead for later bills`)
  if (r.clearing) notes.push(`+ ${fmt(r.clearing)} still clearing`)
  return { label: `Money received ${period}`, amount: r.amount, notes }
}

/** Money billed: collected so far + clearing + still owed = the bill. */
export function billedPartsAddUp(b: { amount: number; collected: number; clearing: number; stillOwed: number }): boolean {
  return Math.abs(round2(b.collected + b.clearing + b.stillOwed) - round2(b.amount)) < 0.005
}

// ─── Figures beside a total ─────────────────────────────────────────────────

export interface BesideItem { key: string; label: string; amount: number }

/**
 * Money billed: of the API's beside figures, "still clearing" and "still owed"
 * are parts of the bills INSIDE the total (the basis note: "'Still owed' is
 * inside the total; 'Collected so far' is beside it"), and the three of them —
 * collected so far, still clearing, still owed — are what became of the bills,
 * adding up to the total.
 */
const BILLED_OUTCOME_KEYS = ['collectedSoFar', 'clearing', 'stillOwed'] as const
const INSIDE_TOTAL_WHEN_BILLED: ReadonlySet<string> = new Set(['clearing', 'stillOwed'])

/**
 * What became of the bills (Money billed), for a screen that has no list of
 * its parts: collected so far, still clearing, still owed. Empty under Money
 * received, where none of them applies.
 */
export function billedOutcome(items: readonly BesideItem[] | null | undefined, basis: IncomeBasis): BesideItem[] {
  if (basis !== 'billed') return []
  const list = items ?? []
  return BILLED_OUTCOME_KEYS
    .map(k => list.find(i => i.key === k))
    .filter((i): i is BesideItem => !!i)
}

/** The API's key for paid-ahead money on hand at the period's last day. */
export const PAID_AHEAD_ON_HAND_KEY = 'paidAheadUnused'

/**
 * §0.0: under Money received, paid-ahead money counted in full on the day it
 * arrived (its own line, "Paid ahead for later bills") and counts $0 again
 * when it pays a bill. So what is still on hand is never "not in the total" —
 * a landlord told it is would think they hold that much more than the report
 * counted (Todd: $460 for October counted in September's $920).
 */
export const PAID_AHEAD_COUNTED_NOTE = 'Counted on the day it arrived; $0 again when it pays a bill.'

/**
 * The figures to list under "beside the total, not in it". Money received:
 * all of them (money still clearing has not arrived, a credit you gave is not
 * income, ...) except the paid-ahead money on hand, which already counted on
 * the day it arrived (see `paidAheadOnHand`). Money billed: never "still
 * clearing" or "still owed" — they are inside the total — and not "collected
 * so far" either when the screen already shows what became of the bills
 * (`outcomeShown`). Paid-ahead money on hand stays here under Money billed: no
 * bill it will pay is in that total yet.
 */
export function besideNotInTotal(
  items: readonly BesideItem[] | null | undefined, basis: IncomeBasis, opts: { outcomeShown?: boolean } = {},
): BesideItem[] {
  const list = [...(items ?? [])]
  if (basis !== 'billed') return list.filter(i => i.key !== PAID_AHEAD_ON_HAND_KEY)
  return list.filter(i => !INSIDE_TOTAL_WHEN_BILLED.has(i.key) && !(opts.outcomeShown && i.key === 'collectedSoFar'))
}

/**
 * Money received only: the paid-ahead money not used yet by the period's last
 * day, shown on its own line with PAID_AHEAD_COUNTED_NOTE — never under "not
 * in it". Null under Money billed (it is listed beside that total) or when
 * there is none.
 */
export function paidAheadOnHand(items: readonly BesideItem[] | null | undefined, basis: IncomeBasis): BesideItem | null {
  if (basis === 'billed') return null
  const item = (items ?? []).find(i => i.key === PAID_AHEAD_ON_HAND_KEY)
  return item && Number(item.amount) ? item : null
}

/**
 * The tax summary's figures beside the year's totals: the paid-ahead money on
 * hand at year end (named by the server — "Paid ahead for next year's bills"
 * once the year is over) and work trade (never money). Split the way every
 * other statement is: under Money received the paid-ahead money is shown as
 * counted when it arrived, never "not in them"; work trade always is.
 */
export function taxYearBeside(
  paidAhead: { label?: string | null; amount?: number | string | null } | null | undefined,
  workTradeValue: number | string | null | undefined,
  basis: IncomeBasis,
): { onHand: BesideItem | null; notIn: BesideItem[] } {
  const items: BesideItem[] = []
  const pa = Number(paidAhead?.amount || 0)
  if (pa > 0) items.push({ key: PAID_AHEAD_ON_HAND_KEY, label: paidAhead?.label || 'Paid ahead, not used yet', amount: pa })
  const wt = Number(workTradeValue || 0)
  if (wt > 0) items.push({ key: 'workTrade', label: 'Covered by work trade (bartered, never money)', amount: wt })
  return { onHand: paidAheadOnHand(items, basis), notIn: besideNotInTotal(items, basis) }
}

// ─── Property health ─────────────────────────────────────────────────────────

/**
 * How much of this month's rent bills is paid (money still clearing counts:
 * the tenant has paid, the bank is moving it). The same under either switch —
 * "is rent getting paid" is a question about the bills. null when nothing is
 * billed yet.
 */
export function rentBillsPaidRate(
  rentBilled: { amount: number; collected: number; clearing: number } | null | undefined,
): number | null {
  if (!rentBilled || !(rentBilled.amount > 0)) return null
  return (Number(rentBilled.collected) + Number(rentBilled.clearing)) / Number(rentBilled.amount)
}

export type HealthStatus = 'awaiting' | 'full' | 'healthy' | 'attention'
export function healthStatus(rate: number | null): HealthStatus {
  if (rate == null) return 'awaiting'
  if (rate >= 1) return 'full'
  if (rate >= 0.85) return 'healthy'
  return 'attention'
}
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = {
  awaiting: 'Awaiting data',
  full: 'Fully collected',
  healthy: 'Healthy',
  attention: 'Needs attention',
}

// ─── Income by category (decision #4) ───────────────────────────────────────

export interface CategoryRow {
  category: string
  label?: string
  billed: number
  collected: number
  clearing: number
  stillOwed: number
  amount: number
}

export function categoryLabel(row: { category: string; label?: string }): string {
  return INCOME_CATEGORY_LABEL[row.category as IncomeCategory] ?? row.label ?? humanize(row.category)
}

/** The categories with any money in the period, in the report's order (the API's order). */
export function activeCategories<T extends CategoryRow>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter(r => r.billed || r.collected || r.clearing || r.stillOwed || r.amount)
}

export interface CategoryColumn { key: 'billed' | 'collected' | 'clearing' | 'stillOwed'; label: string }

/**
 * Billed vs collected under the switch. Money received: what was billed in the
 * period and what arrived in it. Money billed: the bills and what became of
 * them (collected so far, clearing, still owed — they add up to the bill).
 */
export function categoryColumns(basis: IncomeBasis): CategoryColumn[] {
  return basis === 'billed'
    ? [
        { key: 'billed', label: 'Billed' },
        { key: 'collected', label: 'Collected so far' },
        { key: 'clearing', label: 'Still clearing' },
        { key: 'stillOwed', label: 'Still owed' },
      ]
    : [
        { key: 'billed', label: 'Billed' },
        { key: 'collected', label: 'Received' },
      ]
}

/** The breakdown's total: every category's figure under the basis, plus the lines with no category. */
export function breakdownTotal(
  categories: readonly CategoryRow[], lines: ReadonlyArray<{ amount: number }>,
): number {
  return round2(sumAmounts(categories) + sumAmounts(lines))
}

// ─── Expenses ────────────────────────────────────────────────────────────────

export interface ExpenseFigures {
  platformFee: number
  maintenance: number
  lotRent?: number
  enteredExpenses?: number
}

/** The P&L's expenses as lines that add up to its expense total (platform fee always shown). */
export function expenseLines(e: ExpenseFigures | null | undefined): Array<{ key: string; label: string; amount: number }> {
  if (!e) return []
  const out = [{ key: 'platformFee', label: 'GAM platform fee', amount: Number(e.platformFee) || 0 }]
  if (Number(e.maintenance)) out.push({ key: 'maintenance', label: 'Maintenance', amount: Number(e.maintenance) })
  if (Number(e.lotRent)) out.push({ key: 'lotRent', label: 'Lot rent', amount: Number(e.lotRent) })
  if (Number(e.enteredExpenses)) out.push({ key: 'enteredExpenses', label: 'Your expenses', amount: Number(e.enteredExpenses) })
  return out
}

/**
 * An entered-expense category's label. The API camelizes object KEYS on the
 * way out, so a breakdown keyed by category arrives as 'propertyTax', not
 * 'property_tax'; both find their label, and nothing raw reaches the screen.
 */
const EXPENSE_LABEL_BY_KEY: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const c of EXPENSE_CATEGORIES) {
    out[c] = EXPENSE_CATEGORY_LABEL[c]
    out[c.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase())] = EXPENSE_CATEGORY_LABEL[c]
  }
  return out
})()
export function expenseCategoryLabel(key: string): string {
  return EXPENSE_LABEL_BY_KEY[key] ?? humanize(camelToSnake(key))
}

// ─── The charges behind a total ──────────────────────────────────────────────

export interface ChargeRow {
  id: string
  /**
   * The property's calendar day this entry counted ('YYYY-MM-DD'): Money
   * received, the day its money arrived — or, for a dispute or bank return,
   * the day the money was taken back; Money billed, the bill's due day. One
   * charge can be listed on two days (a payment and its dispute in the same
   * month), so `key` — not `id` — names an entry.
   */
  day?: string
  key?: string
  settledAt: string | null
  dueDate: string | null
  /** What this charge put into the total under the basis. */
  amount: number
  /** Money billed: what became of it (paid, clearing, still owed, ...). */
  parts?: Partial<Record<BilledPart, number>>
}

/** A bill's due day ('YYYY-MM-DD') in American words, "Oct 1, 2026" — read as a calendar day, never shifted by a zone. */
export function usDay(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''))
  if (!m) return ymd ? String(ymd) : '—'
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** A timestamp's calendar day in the viewer's own zone, 'YYYY-MM-DD'. */
export function localDay(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso).slice(0, 10)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * The day an entry is filed under: the day it counted, from the report
 * itself (the property's calendar). An older reply without it falls back to
 * the bill's due day (Money billed) or the settle day (Money received).
 */
export function chargeDay(r: ChargeRow, basis: IncomeBasis): string {
  if (r.day) return String(r.day).slice(0, 10)
  return basis === 'billed' ? String(r.dueDate ?? '').slice(0, 10) : localDay(r.settledAt)
}

/**
 * The day an entry's money arrived ('YYYY-MM-DD'), for the owner statement's
 * "Money arrived" column — a calendar day, never the UTC date of the settle
 * time (a 6 pm Arizona payment on Sep 29 is Sep 30 in UTC). Money received,
 * money in (a positive entry): the day it counted, from the report (the
 * property's calendar), so it always matches "Counted on". Otherwise (a bill
 * under Money billed, a dispute's take-back day): the settle time's own day.
 */
export function arrivalDay(r: ChargeRow, basis: IncomeBasis): string {
  if (!r.settledAt) return ''
  if (basis === 'received' && Number(r.amount) > 0 && r.day) return String(r.day).slice(0, 10)
  return localDay(r.settledAt)
}

// ─── Calendar days for a request ─────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0')
const ymdLocal = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/**
 * This month so far, from the viewer's own calendar: the 1st and today. Never
 * from toISOString, which is the UTC date — on an Arizona evening that is
 * already tomorrow, and "the 1st at 8 pm" is the 2nd, leaving out the day most
 * rent settles.
 */
export function monthToDate(now: Date = new Date()): { monthStart: string; today: string } {
  return { monthStart: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`, today: ymdLocal(now) }
}

/**
 * The last 12 complete months on the viewer's calendar (the T-12 convention:
 * a half-finished current month makes income look worse than it is). The last
 * evening of a month is still that month, so it is not counted complete.
 */
export function lastTwelveMonths(now: Date = new Date()): { start: string; end: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), 0)
  const start = new Date(end.getFullYear(), end.getMonth() - 11, 1)
  return { start: ymdLocal(start), end: ymdLocal(end) }
}

/** An entry's React key: one charge can be listed on two days. */
export const chargeKey = (r: ChargeRow): string => r.key ?? (r.day ? `${r.id}:${r.day}` : r.id)

/**
 * Money received: the charges grouped by the day their money counted (a
 * dispute of a September payment is filed on its October day, as a
 * negative). Money billed: grouped by the day each bill was due. Newest first.
 */
export function groupCharges<T extends ChargeRow>(rows: readonly T[], basis: IncomeBasis): Array<{ date: string; rows: T[]; total: number }> {
  const map = new Map<string, T[]>()
  for (const r of rows) {
    const key = chargeDay(r, basis)
    const list = map.get(key)
    if (list) list.push(r); else map.set(key, [r])
  }
  return [...map.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, list]) => ({ date, rows: list, total: sumAmounts(list) }))
}

/** "Paid $460.00 · Still owed $25.00" — what became of a bill, in report order. */
export function partsText(parts: Partial<Record<BilledPart, number>> | null | undefined, fmt: (n: number) => string = money): string {
  if (!parts) return ''
  return BILLED_PARTS
    .filter(p => Number(parts[p]))
    .map(p => `${BILLED_PART_LABEL[p]} ${fmt(Number(parts[p]))}`)
    .join(' · ')
}

/** The part of a total with no single charge behind it (paid ahead, register sales, other income, ...). */
export function noChargeRemainder(total: number, rowsTotal: number): number {
  return round2((Number(total) || 0) - (Number(rowsTotal) || 0))
}

// ─── A report that could not load ────────────────────────────────────────────

/**
 * The words a report shows when it could not load — once, with the next step
 * that fits. "Try again in a moment" only when trying again can help: the
 * connection dropped, the server failed (5xx), or it asked for fewer requests
 * (429). A refusal (403: "covers the whole company... Ask the owner for it")
 * or a request to change something (400: choose a company) carries its own
 * next step, and "try again" there sends the reader in a circle.
 */
export function reportErrorText(error: unknown, what: string): string {
  const e = error as any
  const status: number | undefined = e?.response?.status ?? e?.status
  const said: string = (typeof e?.message === 'string' && e.message.trim()) ? e.message.trim() : ''
  const fallback = `Could not load ${what}.`
  // The API client puts the server's sentence in e.message only when the reply
  // carries one (data.error / data.message). When it does not — the general
  // rate limit answers 429 in plain text, a missing route answers 404 — the
  // message is still axios' own words ("Network Error", "Request failed with
  // status code 429", "timeout of …"), which are never for the reader.
  const plain = said && !AXIOS_WORDS.test(said) ? said : ''
  // Too many requests: waiting is the next step, whatever the server said.
  if (status === 429) return `${plain || fallback} Try again in a moment.`
  if (status && status >= 400 && status < 500) return plain || fallback
  // Nor is a 500's message for the reader: the API sends an unexpected
  // failure's own words ('relation "v_payment_money" does not exist'), the
  // server's insides. Another 5xx (503, "restarting") may carry a sentence
  // meant for the reader.
  return `${(status !== 500 && plain) || fallback} Try again in a moment.`
}

/** Axios' own words for a failure — never shown on a screen. */
const AXIOS_WORDS = /^Network Error$|^Request failed with status code|^timeout of/i

// ─── Runs that can overlap ───────────────────────────────────────────────────

/**
 * Number each run of a report; only the newest run may put its answer on the
 * screen. Flipping the switch while a slower run under the other basis is
 * still out would otherwise let the old answer land last and sit under a
 * switch that says the opposite.
 */
export function latestOnly(): { start: () => number; isLatest: (run: number) => boolean } {
  let n = 0
  return { start: () => ++n, isLatest: (run: number) => run === n }
}

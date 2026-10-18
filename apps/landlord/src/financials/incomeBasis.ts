/**
 * The screen math every report shares — one copy, so a card and the report it
 * opens cannot add the same figures up two ways.
 *
 * 10/12 (Nic): "NO 'Money received / Money billed' toggle anywhere — show
 * Charged, Received and Owed side by side as columns, with a short line
 * showing how they tie." The switch (S655, Step 15) is retired: every report
 * reads both kinds of facts and the API sends the three columns, their tie
 * line and the net on each money column (services/incomeBasis MoneyView). Its
 * localStorage choice is no longer read or written.
 */
import {
  INCOME_LINES, INCOME_LINE_LABEL,
  BILLED_PARTS, BILLED_PART_LABEL, INCOME_CATEGORY_LABEL,
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, MONEY_COLUMNS, MONEY_COLUMN_LABEL, MONEY_COLUMN_NOTE, MONEY_COLUMN_NOTE_LEDGER, humanize,
  type BilledPart, type IncomeCategory, type IncomeLine, type MoneyColumn,
} from '@gam/shared'

const round2 = (n: number) => Math.round(n * 100) / 100

// ─── The three columns ───────────────────────────────────────────────────────

export interface MoneyThree { charged: number; received: number; owed: number }

/**
 * Received, Charged, Owed — in Nic's order (10/12, L2: Received leads), with
 * their labels and plain notes (the shared words). 10/12 (ledger P8):
 * `fromBooks` — the reports read the company's books, where Owed is what
 * tenants still owed at the end of the period (MONEY_COLUMN_NOTE_LEDGER).
 */
export function moneyColumns(fromBooks = false): Array<{ key: MoneyColumn; label: string; note: string }> {
  const notes = fromBooks ? MONEY_COLUMN_NOTE_LEDGER : MONEY_COLUMN_NOTE
  return MONEY_COLUMNS.map(k => ({ key: k, label: MONEY_COLUMN_LABEL[k], note: notes[k] }))
}

export interface MoneyViewLine extends MoneyThree { line: string; label: string }
export interface MoneyViewCategory extends MoneyThree { category: string; label: string }
/** 10/14 (Nic I1): a Detailed-view line (services/incomeBasis MoneyViewDetail) with its subtypes. */
export interface MoneyViewDetail extends MoneyThree { key: string; label: string; category: string | null; subtypes: Array<MoneyThree & { name: string }> }

/** The API's three-column view of a period (services/incomeBasis MoneyView). */
export interface MoneyView extends MoneyThree {
  collected: number
  clearing: number
  lines: MoneyViewLine[]
  categories: MoneyViewCategory[]
  uncategorized: MoneyViewLine[]
  tie: {
    charged: { collected: number; clearing: number; owed: number; other: number }
    received: { forPeriodBills: number; forEarlierBills: number; paidAhead: number; noBill: number }
    stillClearing: number
  }
  /** How the columns tie, in plain words — printed as is. */
  tieText: string[]
  /** In no column: work trade, deposits held, owner money in, chargeback costs, paid ahead not used yet. */
  beside: BesideItem[]
  /** 10/12 (Nic, review): 'ledger' when the view was read from the company's books (Owed is then a balance at the period's end). */
  source?: 'ledger'
  /** 10/14 (Nic I1): the Detailed view's lines (income itemized by space, home sales), when the books itemized it. */
  details?: MoneyViewDetail[]
}

/** Add rows of the three columns to the cent. */
export function sumThree(rows: ReadonlyArray<Partial<MoneyThree>>): MoneyThree {
  return {
    charged: round2(rows.reduce((s, r) => s + (Number(r.charged) || 0), 0)),
    received: round2(rows.reduce((s, r) => s + (Number(r.received) || 0), 0)),
    owed: round2(rows.reduce((s, r) => s + (Number(r.owed) || 0), 0)),
  }
}

/** True when rows add up to a total in every column, to the cent. */
export function threeAddUp(rows: ReadonlyArray<Partial<MoneyThree>>, total: Partial<MoneyThree>): boolean {
  const s = sumThree(rows)
  return MONEY_COLUMNS.every(k => Math.abs(s[k] - round2(Number(total[k]) || 0)) < 0.005)
}

/** Every split in the tie adds back to its column (the line under the table can be trusted). */
export function tieAddsUp(v: Pick<MoneyView, 'charged' | 'received' | 'tie'>): boolean {
  const c = v.tie.charged, r = v.tie.received
  return Math.abs(round2(c.collected + c.clearing + c.owed + c.other) - round2(v.charged)) < 0.005
    && Math.abs(round2(r.forPeriodBills + r.forEarlierBills + r.paidAhead + r.noBill) - round2(v.received)) < 0.005
}

/** The net on each money column: Charged less expenses, Received less expenses. */
export function netsOf(view: Partial<MoneyThree> | null | undefined, expensesTotal: number): { charged: number; received: number } {
  return {
    charged: round2((Number(view?.charged) || 0) - (Number(expensesTotal) || 0)),
    received: round2((Number(view?.received) || 0) - (Number(expensesTotal) || 0)),
  }
}

// ─── Income lines ────────────────────────────────────────────────────────────

/**
 * The income lines in report order. The reports API also emits
 * 'movedToCredit' (rent or a stay deposit already counted and moved to credit
 * for a later bill), which the shared list does not carry yet.
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

// ─── The money card (dashboard, Reports overview) ───────────────────────────

/** The API's income card, both ways (lib/rentCollected IncomeCard). */
export interface IncomeCardData {
  received?: { amount: number; paidAhead: number; clearing: number }
  billed?: { amount: number; collected: number; clearing: number; stillOwed: number }
}

export interface MoneyCardView extends MoneyThree {
  /** Plain lines under the three figures, in order. */
  notes: string[]
}

/**
 * 10/12 (Nic): this month's Charged, Received and Owed side by side, from the
 * card the dashboard and the Reports overview both read. The notes say how
 * they tie: what became of what was charged, and what Received includes.
 */
export function moneyCardView(
  card: IncomeCardData | null | undefined,
  // To the cent: the parts under a whole-dollar figure must visibly add up to it.
  fmt: (n: number) => string = money,
): MoneyCardView {
  const b = card?.billed ?? { amount: 0, collected: 0, clearing: 0, stillOwed: 0 }
  const r = card?.received ?? { amount: 0, paidAhead: 0, clearing: 0 }
  const charged = [`Of ${fmt(b.amount)} charged: ${fmt(b.collected)} collected`]
  if (b.clearing) charged.push(`${fmt(b.clearing)} clearing`)
  charged.push(`${fmt(b.stillOwed)} still owed`)
  // 10/12 (Nic, L2): Received leads — what Received includes first, then
  // what became of what was charged.
  const notes: string[] = []
  const rec: string[] = []
  if (r.paidAhead) rec.push(`Received includes ${fmt(r.paidAhead)} paid ahead for later bills`)
  if (r.clearing) rec.push(`${fmt(r.clearing)} more is still clearing`)
  if (rec.length) notes.push(rec.join(' · '))
  notes.push(charged.join(' · '))
  return { charged: Number(b.amount) || 0, received: Number(r.amount) || 0, owed: Number(b.stillOwed) || 0, notes }
}

/** Money billed: collected so far + clearing + still owed = the bill. */
export function billedPartsAddUp(b: { amount: number; collected: number; clearing: number; stillOwed: number }): boolean {
  return Math.abs(round2(b.collected + b.clearing + b.stillOwed) - round2(b.amount)) < 0.005
}

// ─── Figures beside a total ─────────────────────────────────────────────────

export interface BesideItem { key: string; label: string; amount: number }

/** The API's key for paid-ahead money on hand at the period's last day. */
export const PAID_AHEAD_ON_HAND_KEY = 'paidAheadUnused'

/**
 * §0.0: paid-ahead money counts in Received in full on the day it arrived
 * (its own line, "Paid ahead for later bills") and never again when it pays a
 * bill. What is still on hand already counted — a landlord told otherwise
 * would think they hold that much more than the report counted.
 */
export const PAID_AHEAD_COUNTED_NOTE = 'Counted in Received on the day it arrived; never again when it pays a bill.'

// ─── Property health ─────────────────────────────────────────────────────────

/**
 * 10/17 (Nic): "the property health matches what was invoiced and what was
 * paid. work trade isnt billed until a shortfall so it shouldnt apply here
 * unless an invoice generates."
 *
 * So: how much of this month's rent bills is paid — the bills the API already
 * leaves work trade out of, and paid once settled whatever settled it (money,
 * money still clearing at the bank, an account credit, money paid ahead). It
 * used to divide the Money billed figures, which answer "what was charged and
 * what arrived": work-trade-held rent read as owed and credit-paid rent read as
 * unpaid, so Mountain View said 67% in a month where only $2,061 was left to
 * collect. Both figures come from one place now (the API's rentHealth, lib/
 * rentCollected rentHealthMtd). null when nothing is invoiced yet.
 */
export interface RentHealthData { invoiced: number; paid: number; owed?: number; workTradeHeld?: number }

export function rentBillsPaidRate(health: RentHealthData | null | undefined): number | null {
  if (!health || !(Number(health.invoiced) > 0)) return null
  return Number(health.paid) / Number(health.invoiced)
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
  /** 10/12: the three columns (the API sends them on every breakdown). */
  charged?: number
  received?: number
  owed?: number
}

export function categoryLabel(row: { category: string; label?: string }): string {
  return INCOME_CATEGORY_LABEL[row.category as IncomeCategory] ?? row.label ?? humanize(row.category)
}

/** The categories with any money in the period, in the report's order (the API's order). */
export function activeCategories<T extends CategoryRow>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter(r => r.billed || r.collected || r.clearing || r.stillOwed || r.amount
    || r.charged || r.received || r.owed)
}

/** A category row's three columns (an older reply without them reads billed / collected / still owed). */
export function categoryThree(r: CategoryRow): MoneyThree {
  return {
    charged: Number(r.charged ?? r.billed) || 0,
    received: Number(r.received ?? r.collected) || 0,
    owed: Number(r.owed ?? r.stillOwed) || 0,
  }
}

// ─── Expenses ────────────────────────────────────────────────────────────────

export interface ExpenseFigures {
  platformFee: number
  maintenance: number
  lotRent?: number
  enteredExpenses?: number
  /** 10/11: payment processing fees the landlord covers for tenants (in the P&L's expense total). */
  processingFees?: number
  /** 10/12 (Nic, G10): card fees guests got back with refunds of card sales (in the expense total). */
  cardFeesRefunded?: number
  /**
   * 10/12 (Nic, ledger P8): once the company's books are live, each expense
   * account with what was incurred in the period (beside Charged) and what
   * was paid in it (beside Received).
   */
  byAccount?: Array<{ accountId: string; code: string; name: string; role?: string | null; incurred: number; paid: number }>
  /** 10/12 (ledger P8): the expenses paid in the period (the Received net takes it). */
  cashTotal?: number
}

/** One expense line; `paid` (on the books) is what the Received column takes, else the same amount. */
export interface ExpenseLine { key: string; label: string; amount: number; paid?: number }

/**
 * The P&L's expenses as lines that add up to its expense total. The platform
 * fee and (10/12, Nic) the payment processing fees always show — the
 * processing-fee line is rendered wherever expenses are listed, $0 included,
 * so a landlord always sees where the fees they cover for tenants go.
 */
export function expenseLines(e: ExpenseFigures | null | undefined): ExpenseLine[] {
  if (!e) return []
  // 10/12 (Nic, ledger P8): on the books, one line per expense account —
  // incurred beside Charged, paid beside Received — and the processing fees
  // you cover always listed.
  if (e.byAccount) {
    const out: ExpenseLine[] = e.byAccount.map(a => ({ key: a.accountId, label: a.name, amount: Number(a.incurred) || 0, paid: Number(a.paid) || 0 }))
    if (!e.byAccount.some(a => a.role === 'processing_fees')) out.push({ key: 'processingFees', label: 'Payment processing fees', amount: 0, paid: 0 })
    return out
  }
  const out: ExpenseLine[] = [{ key: 'platformFee', label: 'GAM platform fee', amount: Number(e.platformFee) || 0 }]
  if (Number(e.maintenance)) out.push({ key: 'maintenance', label: 'Maintenance', amount: Number(e.maintenance) })
  if (Number(e.lotRent)) out.push({ key: 'lotRent', label: 'Lot rent', amount: Number(e.lotRent) })
  if (Number(e.enteredExpenses)) out.push({ key: 'enteredExpenses', label: 'Your expenses', amount: Number(e.enteredExpenses) })
  out.push({ key: 'processingFees', label: 'Payment processing fees', amount: Number(e.processingFees) || 0 })
  // 10/12 (Nic, G10): "the customer gets the card fee back too; the landlord eats that fee."
  if (Number(e.cardFeesRefunded)) out.push({ key: 'cardFeesRefunded', label: 'Card fees refunded', amount: Number(e.cardFeesRefunded) })
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
   * The property's calendar day this entry counted ('YYYY-MM-DD'): the day
   * its money arrived — or, for a dispute or bank return, the day the money
   * was taken back. One charge can be listed on two days (a payment and its
   * dispute in the same month), so `key` — not `id` — names an entry.
   */
  day?: string
  key?: string
  settledAt: string | null
  dueDate: string | null
  /** What this charge put into Received. */
  amount: number
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

/** The day an entry is filed under: the day it counted, from the report itself (the property's calendar). */
export function chargeDay(r: ChargeRow): string {
  return r.day ? String(r.day).slice(0, 10) : localDay(r.settledAt)
}

/** An entry's React key: one charge can be listed on two days. */
export const chargeKey = (r: ChargeRow): string => r.key ?? (r.day ? `${r.id}:${r.day}` : r.id)

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

// ─── One line per day (10/12, Nic) ───────────────────────────────────────────

/** A day of the monthly P&L's list, as the API sends it. */
export interface DayLine {
  day: string
  received: number
  chargesTotal: number
  noCharge: number
  paymentCount: number
  paymentKeys: string[]
  expensesLogged: number
  expenseCount: number
}

/** The payments behind one day (the screen expands a day to who paid). */
export function dayRows<T extends ChargeRow>(day: Pick<DayLine, 'paymentKeys'>, payments: readonly T[]): T[] {
  const keys = new Set(day.paymentKeys)
  return payments.filter(p => keys.has(chargeKey(p)))
}

/** "You logged $2,000.00 of expenses" (Nic's words). */
export function expensesLoggedText(amount: number, count: number, fmt: (n: number) => string = money): string {
  return `You logged ${fmt(amount)} of expenses${count > 1 ? ` (${count})` : ''}`
}

/** The days add up to the month's Received, to the cent. */
export function daysAddUp(days: ReadonlyArray<Pick<DayLine, 'received'>>, received: number): boolean {
  return Math.abs(round2(days.reduce((s, d) => s + (Number(d.received) || 0), 0)) - round2(Number(received) || 0)) < 0.005
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

/** Last month on the viewer's calendar, 'YYYY-MM' (the monthly report covers a finished month). */
export function lastMonthKey(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
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
 * screen. A slower earlier run answering last would otherwise sit under the
 * settings of the newer one.
 */
export function latestOnly(): { start: () => number; isLatest: (run: number) => boolean } {
  let n = 0
  return { start: () => ++n, isLatest: (run: number) => run === n }
}

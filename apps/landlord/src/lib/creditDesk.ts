/**
 * S655 money plan, Step 14 — the landlord payment screens' arithmetic and words.
 *
 * Nic (10/2): "landlord screens show the full balance with 'credit available $X'
 * beside it"; credit is used only when the payer (or the desk, for them) says
 * so — "Use" or "Save" — and pays a bill by itself only when it covers the
 * whole bill. Decisions #25, #26 and #29 (10/3): Outstanding Balances is where
 * money is taken (Record payment on each household, one at the top for anyone
 * paying ahead); the Payments tab is the record of payments already made, by
 * month; nobody but owners and property managers sees a grand total.
 *
 * Everything here is a small pure function, so the desk window, the
 * Outstanding list, the Front Desk call list, the tenant page and the Payments
 * ledger cannot say the same thing two ways — and so each rule has a test
 * (creditDesk.test.ts). The SERVER is the authority on every figure: these
 * functions only lay out what it sent and ask the desk's questions BEFORE the
 * Record click, in the same words the server would refuse with.
 */
import {
  ACH_RETURN_CONFIG, PAYMENT_REVERSAL_TYPE_VALUES, PAYMENT_STATUS_LABEL, MANUAL_PAYMENT_METHOD_WORD, placePartPayment, paidAheadGoesOn,
  bankReceiptPhotoProblem, DEPOSIT_REFERENCE_LABEL, LATE_FEE_CREDITED_LANDLORD_TEXT, LATE_FEE_DELETED_LANDLORD_TEXT, LATE_FEE_DELETED_STILL_LATE_LANDLORD_TEXT,
  type ManualPaymentMethod, type PaymentReversalType, type PaymentStatus,
} from '@gam/shared'

// ─── Money ────────────────────────────────────────────────────────────────────

export const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
export const toDollars = (c: number): number => Math.round(c) / 100

/** $1,234.56 — every money figure on these screens. */
export function money(v: number | string | null | undefined): string {
  const n = toDollars(toCents(v))
  return `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** What a typed amount box holds, in cents; null when it holds nothing usable. */
export function parseAmount(typed: string | null | undefined): number | null {
  const t = String(typed ?? '').replace(/[$,\s]/g, '')
  if (t === '' || !/^\d*\.?\d*$/.test(t) || t === '.') return null
  const n = Number(t)
  return Number.isFinite(n) ? toCents(n) : null
}

// ─── Days and months ─────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Today on this device's calendar, YYYY-MM-DD (never shifted by UTC). */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** 'September 2026' for '2026-09'. */
export function monthTitle(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym)
  if (!m) return ym
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`
}

/** 'August' for '2026-08' this year; 'December 2025' for another year. */
export function monthWord(ym: string, today: string = localToday()): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym)
  if (!m) return ym
  const name = MONTHS[Number(m[2]) - 1] ?? m[2]
  return m[1] === today.slice(0, 4) ? name : `${name} ${m[1]}`
}

/** 'Oct 3' for a day this year (or in `year`); 'Oct 3, 2025' otherwise. A YYYY-MM-DD read as a calendar day. */
export function dayWord(day: string | null | undefined, year: string = localToday().slice(0, 4)): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''))
  if (!m) return '—'
  const d = `${SHORT[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`
  return m[1] === year ? d : `${d}, ${m[1]}`
}

/** The calendar day of a DATE column (due date, lease start) as the wire carries it — its own leading day, never shifted by time zone. */
export function calendarDay(v: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''))
  return m ? m[1] : null
}

/** The day a moment (a timestamp such as when a payment settled) fell on, on this device's calendar. */
export function localDayOf(v: string | null | undefined): string | null {
  const t = String(v ?? '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const d = new Date(t)
  return t && !Number.isNaN(d.getTime()) ? localToday(d) : null
}

/**
 * decisions #29: how late, honoring the grace period (the server counts it).
 * 10/12 (Nic): "'Days late' = days past the grace period everywhere", and the
 * words say so. 0 → null: nothing to say.
 */
export function daysLateText(days: number | null | undefined): string | null {
  const n = Math.max(0, Math.floor(Number(days ?? 0)))
  if (n === 0) return null
  return `${n} day${n === 1 ? '' : 's'} past grace`
}

// ─── The credit beside a balance ─────────────────────────────────────────────

/**
 * "credit available $X" — what their credit could pay of this balance now
 * (the server's plan: eligibility, the monthly draw, the lease it belongs to).
 * Never taken off the balance. When there is more on file than can pay it,
 * that is said too, so nobody is surprised the two differ.
 */
export function creditBesideText(available: number | string | null | undefined, onFile?: number | string | null): string | null {
  const a = toCents(available)
  const f = toCents(onFile)
  if (a <= 0 && f <= 0) return null
  if (a <= 0) return `${money(toDollars(f))} credit on file — none of it can pay this balance`
  if (f > a) return `credit available ${money(toDollars(a))} (${money(toDollars(f))} on file)`
  return `credit available ${money(toDollars(a))}`
}

/**
 * The Front Desk's sentence for somebody who owes: the FULL balance, with their
 * credit said beside it as a question for them — never taken off the figure.
 */
export function deskBalanceSentence(b: {
  first: string; owed: number; credit: number; when: string | null; overdue: boolean
  /** 10/5 (Nic): the property takes part payments (recorded ones). */
  partialOk?: boolean
}): string {
  const head = `${b.first} owes ${money(b.owed)}${b.when ? ` — oldest bill ${b.overdue ? 'was due' : 'due'} ${b.when}` : ''}.`
  if (toCents(b.credit) > 0) {
    return `${head} They have ${money(b.credit)} of credit that can go toward it — ask whether they want to use it or save it.`
      + (b.partialOk
        ? ' They can pay part of what is left; what they do not pay stays owed, and late fees still apply.'
        : ' Whatever is left is taken in full; rent cannot be part-paid.')
  }
  return b.partialOk
    ? `${head} They can pay part; what they do not pay stays owed, and late fees still apply.`
    : `${head} Take the full amount; rent cannot be part-paid.`
}

// ─── Outstanding Balances ────────────────────────────────────────────────────

export interface OwedMonth { month: string; amount: number }

/** "$450.00 from August · $460.00 from September" — every unpaid month, oldest first (decisions #29). */
export function monthsOwedText(months: readonly OwedMonth[] | null | undefined, today: string = localToday()): string | null {
  const list = (months ?? []).filter(m => toCents(m.amount) > 0)
  if (list.length === 0) return null
  return [...list].sort((a, b) => a.month.localeCompare(b.month))
    .map(m => `${money(m.amount)} from ${monthWord(m.month, today)}`).join(' · ')
}

export interface OutstandingSpace {
  landlordId: string
  leaseId: string | null
  unitNumber: string | null
  propertyId: string | null
  propertyName: string | null
  balance: number
  creditAvailable: number
  months: OwedMonth[]
  daysLate: number
  clearing: number
}

export interface RecordAnchor { landlordId: string; paymentId: string }

export interface OutstandingRow {
  tenantId: string | null
  payLinkId?: string | null
  ticketId?: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  email: string | null
  unitNumber: string | null
  propertyId: string | null
  propertyName: string | null
  balance: string | number
  creditAvailable?: number
  creditOnAccount?: number
  months?: OwedMonth[]
  daysLate?: number
  clearing?: number
  workTrade?: boolean
  status?: 'owes' | 'clearing'
  statusLabel?: string
  recordWith?: RecordAnchor[]
  spaces?: OutstandingSpace[]
  [k: string]: unknown
}

/** One folder's share of a person: what they owe at THAT property (S648: a person at two parks is under each). */
export interface OutstandingSlice {
  key: string
  propertyId: string
  propertyName: string
  row: OutstandingRow
  name: string
  unitNumber: string | null
  balance: number
  creditAvailable: number
  creditOnAccount: number
  months: OwedMonth[]
  daysLate: number
  clearing: number
  workTrade: boolean
  status: 'owes' | 'clearing'
  /** Where Record payment opens for this slice (one per company they owe here). */
  anchors: RecordAnchor[]
}

export function personName(r: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  return [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.email || 'Tenant'
}

/**
 * Split each person into the property folders they owe in. A person whose
 * spaces are all at one property is one slice carrying the server's own
 * figures; a person at two is two slices, each with only what is owed there.
 */
export function sliceByProperty(rows: readonly OutstandingRow[]): OutstandingSlice[] {
  const out: OutstandingSlice[] = []
  for (const r of rows) {
    const name = personName(r)
    const base = {
      row: r, name,
      creditOnAccount: Number(r.creditOnAccount ?? 0),
      workTrade: r.workTrade === true,
    }
    const spaces = r.spaces ?? []
    const props = [...new Set(spaces.map(s => s.propertyId ?? ''))]
    if (spaces.length === 0 || props.length <= 1) {
      const pid = spaces[0]?.propertyId ?? r.propertyId ?? ''
      out.push({
        ...base,
        key: `${pid}:${r.payLinkId ?? r.ticketId ?? r.tenantId ?? name}`,
        propertyId: pid,
        propertyName: spaces[0]?.propertyName ?? r.propertyName ?? 'No property',
        unitNumber: r.unitNumber ?? null,
        balance: Number(r.balance ?? 0),
        creditAvailable: Number(r.creditAvailable ?? 0),
        months: r.months ?? [],
        daysLate: Number(r.daysLate ?? 0),
        clearing: Number(r.clearing ?? 0),
        status: r.status ?? (toCents(r.balance) > 0 ? 'owes' : 'clearing'),
        anchors: r.recordWith ?? [],
      })
      continue
    }
    for (const pid of props) {
      const here = spaces.filter(s => (s.propertyId ?? '') === pid)
      const months = new Map<string, number>()
      for (const s of here) for (const m of s.months ?? []) months.set(m.month, (months.get(m.month) ?? 0) + toCents(m.amount))
      const balanceC = here.reduce((t, s) => t + toCents(s.balance), 0)
      const owingLandlords = new Set(here.filter(s => toCents(s.balance) > 0).map(s => s.landlordId))
      const anchors = (r.recordWith ?? []).filter(a => owingLandlords.has(a.landlordId))
      out.push({
        ...base,
        key: `${pid}:${r.tenantId ?? name}`,
        propertyId: pid,
        propertyName: here[0]?.propertyName ?? 'No property',
        unitNumber: [...new Set(here.map(s => s.unitNumber).filter(Boolean))].join(', ') || null,
        balance: toDollars(balanceC),
        creditAvailable: toDollars(here.reduce((t, s) => t + toCents(s.creditAvailable), 0)),
        months: [...months.entries()].sort(([a], [z]) => a.localeCompare(z)).map(([month, c]) => ({ month, amount: toDollars(c) })),
        daysLate: Math.max(0, ...here.filter(s => toCents(s.balance) > 0).map(s => Number(s.daysLate ?? 0))),
        clearing: toDollars(here.reduce((t, s) => t + toCents(s.clearing), 0)),
        status: balanceC > 0 ? 'owes' : 'clearing',
        anchors: anchors.length ? anchors : (balanceC > 0 ? (r.recordWith ?? []) : []),
      })
    }
  }
  return out
}

export interface OutstandingTotals {
  owed: number
  households: number
  clearing: number
  byProperty: Array<{ propertyId: string | null; propertyName: string | null; owed: number; clearing: number }>
}

/**
 * decisions #25 (Nic, 10/3): only account owners and property managers see a
 * grand total, and the server decides — it sends `meta.totals` to them and to
 * nobody else. A screen shows a total ONLY when the server sent one; it never
 * adds rows up itself (that would hand the front desk the figure Nic withheld).
 */
export function serverTotals(meta: unknown): OutstandingTotals | null {
  const t = (meta as { totals?: OutstandingTotals } | null | undefined)?.totals
  return t && typeof t.owed === 'number' ? t : null
}

/** A property folder's total, from the server's totals only (decisions #25); null when it sent none. */
export function folderTotal(totals: OutstandingTotals | null, propertyId: string): number | null {
  if (!totals) return null
  const hit = totals.byProperty?.find(p => (p.propertyId ?? '') === propertyId)
  return hit ? hit.owed : 0
}

// ─── "Who is paying?" (Record payment at the top of Outstanding Balances) ───

/** A lease as GET /leases sends it — only what the picker reads. */
export interface PickerLease {
  status: string
  propertyId?: string | null
  unitNumber?: string | null
  propertyName?: string | null
  tenants?: Array<{ tenantId?: string | null; status?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null }> | null
}

/**
 * One person the picker can offer. Exactly one of:
 *   - `owes`: they owe something the desk takes — their desk window opens on that charge;
 *   - `aheadTenantId`: nothing the desk takes is owed — a payment is posted ahead;
 *   - neither: they cannot be taken here at all, and `note` says why (never a dead end with no words).
 */
export interface PayerHit {
  key: string
  name: string
  where: string
  owes?: { slice: OutstandingSlice; anchor: RecordAnchor; amount: number }
  aheadTenantId?: string
  /** What they owe that is not taken at the desk, said beside them. */
  note?: string
}

/**
 * decisions #29: Record payment at the top is "for anyone not on the list
 * (paying ahead)" — and anyone on it is found there too. A resident whose only
 * money owed is something the desk does not take (an open register ticket, GAM's
 * own charges paid online, a space paused for an eviction) has no Record
 * button; they are still found, with the reason beside their name, and can
 * still have a payment posted ahead when they are on a lease here.
 */
export function payerHits(owing: readonly OutstandingRow[], leases: readonly PickerLease[], scoped: ReadonlySet<string> | null): PayerHit[] {
  const hits: PayerHit[] = []
  const takenHere = new Set<string>()
  const notes = new Map<string, { name: string; where: string; notes: string[] }>()
  for (const s of sliceByProperty(owing)) {
    const tenantId = s.row.tenantId
    if (!tenantId || s.status !== 'owes') continue
    const where = [s.unitNumber, s.propertyName].filter(Boolean).join(' · ')
    if (s.anchors.length > 0) {
      takenHere.add(tenantId)
      for (const a of s.anchors) {
        hits.push({ key: `owes:${s.key}:${a.paymentId}`, name: s.name, where, owes: { slice: s, anchor: a, amount: s.balance } })
      }
      continue
    }
    const why = s.row.ticketId
      ? `owes ${money(s.balance)} on an open register ticket — settle it at the register`
      : `owes ${money(s.balance)} that is not taken at the desk — it is paid online, or the space is paused for an eviction`
    const n = notes.get(tenantId) ?? { name: s.name, where, notes: [] }
    n.notes.push(why)
    notes.set(tenantId, n)
  }
  const seen = new Set<string>()
  for (const l of leases) {
    if (l.status !== 'active') continue
    if (scoped && !scoped.has(String(l.propertyId ?? ''))) continue
    for (const t of l.tenants ?? []) {
      if (!t.tenantId || t.status !== 'active' || takenHere.has(t.tenantId) || seen.has(t.tenantId)) continue
      seen.add(t.tenantId)
      const note = notes.get(t.tenantId)?.notes.join('; ')
      hits.push({
        key: `ahead:${t.tenantId}`, name: personName(t),
        where: [l.unitNumber, l.propertyName].filter(Boolean).join(' · '), aheadTenantId: t.tenantId,
        ...(note ? { note } : {}),
      })
    }
  }
  for (const [tenantId, n] of notes) {
    if (takenHere.has(tenantId) || seen.has(tenantId)) continue
    hits.push({ key: `elsewhere:${tenantId}`, name: n.name, where: n.where, note: n.notes.join('; ') })
  }
  return hits
}

/** The picker's list for what was typed: nothing under two letters; name or space; at most 12, by name. */
export function matchPayerHits(hits: readonly PayerHit[], typed: string): PayerHit[] {
  const term = typed.trim().toLowerCase()
  if (term.length < 2) return []
  return hits
    .filter(h => `${h.name} ${h.where}`.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 12)
}

// ─── The desk window (record a cash, check or money-order payment) ──────────

export interface DeskQuoteRow {
  id: string
  leaseId: string | null
  /** The bill (invoice) the row is on. */
  invoiceId?: string | null
  type: string
  entryDescription?: string | null
  amount: number
  dueDate: string
  creditAlreadyApplied: number
  /** What "Use" would spend on this charge (10/5: so a part payment can say which bill stays owed). */
  creditIfUsed?: number
  notes: string | null
  unitNumber: string | null
  propertyName: string | null
}

/**
 * 10/14 (Nic): one open bill — "the itemized lines of that invoice", paid
 * together and whole ("each separate invoice is its own thing"). The desk
 * picks the bills the money pays; nothing is picked for it.
 */
export interface DeskQuoteBill {
  id: string
  /** The space (lease) the bill is on. */
  leaseId: string | null
  unitNumber: string | null
  dueDate: string
  total: number
  creditAlreadyApplied: number
  owed: number
  /** The older open bills of the same space: "October waits for September". */
  olderBillIds: string[]
  rows: DeskQuoteRow[]
}

/** A card payment of the household's waiting on its card's bank, as the desk quote carries it. */
export interface AwaitingCardAtDesk {
  amount: number
  heldAmount: number
  confirmBy: string
  payerName: string | null
  /**
   * The property's time zone (IANA), when the quote carries it: the hour the
   * bill opens is said on the park's clock — the same clock the server's own
   * refusal words use — not the desk browser's.
   */
  timezone?: string | null
}

/**
 * The hour a card hold runs out and the bill opens at the desk ("3:45 PM").
 * On the property's clock when the quote names its time zone; otherwise on
 * this browser's clock WITH the zone named ("3:45 PM CDT"), so staff away from
 * the park never read a bare time that disagrees with the park's.
 */
export function awaitingOpensAtWord(a: Pick<AwaitingCardAtDesk, 'confirmBy' | 'timezone'>): string {
  const at = new Date(a.confirmBy)
  if (a.timezone) {
    try { return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: a.timezone }) } catch { /* unknown zone: below */ }
  }
  return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

/**
 * The desk's "on its way" figures (decisions #48.4): a card waiting on its
 * bank has charged nothing, so it is said on its own line — never inside
 * "Already on its way". `clearing` is what is left of the quote's clearing
 * figure once those holds are taken out (never below zero).
 */
export function deskOnItsWay(q: Pick<DeskQuote, 'clearing' | 'awaitingCard'>): { clearing: number; awaiting: AwaitingCardAtDesk[] } {
  const awaiting = q.awaitingCard ?? []
  const held = awaiting.reduce((t, a) => t + toCents(a.heldAmount), 0)
  return { clearing: toDollars(Math.max(0, toCents(q.clearing) - held)), awaiting }
}

/** When the desk reads the bill again by itself: just after the earliest card hold runs out (null when none). */
export function nextAwaitingRereadAt(q: Pick<DeskQuote, 'awaitingCard'>): number | null {
  const times = (q.awaitingCard ?? []).map(a => Date.parse(a.confirmBy)).filter(t => Number.isFinite(t))
  return times.length ? Math.min(...times) : null
}

/** GET /payments/:id/record-manual/quote, as the wire carries it. */
export interface DeskQuote {
  anchorPaymentId: string
  anchorOpen: boolean
  paymentsPaused: boolean
  /** What the desk takes now: the lines of the bills picked (10/14). */
  rows: DeskQuoteRow[]
  /**
   * 10/14 (Nic): every open bill the desk takes, oldest first — what the desk
   * picks from (read with ?bills=). Absent: an older server (rows is everything).
   */
  bills?: DeskQuoteBill[]
  /** The bills picked that are still open (null when none were named). */
  pickedBillIds?: string[] | null
  /** Why the pick cannot be recorded as it is ("pick the September bill too"), or null. */
  pickRefusal?: string | null
  currentTotal: number
  oldBalance: DeskQuoteRow[]
  oldBalanceTotal: number
  payOnline: DeskQuoteRow[]
  payOnlineTotal: number
  paused: DeskQuoteRow[]
  pausedTotal: number
  clearing: number
  /**
   * The part of `clearing` that is a card payment waiting on the card's bank
   * (decisions #48.4): nothing is charged yet, and the bill it holds opens at
   * the desk by itself at `confirmBy` if nobody confirms it. `heldAmount` is
   * what it holds on these bills (inside `clearing`).
   */
  awaitingCard?: AwaitingCardAtDesk[]
  creditAlreadyApplied: number
  creditAvailable: number
  creditSetAsideElsewhere: number
  creditOnFile: number
  owedIfUsed: number
  owedIfSaved: number
  fullBalance: number
  scheduledRetries: Array<{ nextRetryAt: string | null }>
  /**
   * 10/5 (Nic): the property takes part payments — less than the bill may be
   * recorded; the oldest bills are paid first and the rest stays owed (late
   * fees still apply). Absent or false: pay in full.
   */
  partialPaymentsAllowed?: boolean
  /**
   * 10/26 (Nic): the landlord turned "let residents save credit for later" OFF
   * at every property this credit would pay on, so there is no Use/Save
   * question — the credit goes on the bill and the window says where it went.
   * Absent or false: ask, as before.
   */
  creditMustBeUsed?: boolean
  /** 10/5 (Nic): read with ?depositedOn= — late fees charged after that day, off this bill when the deposit pays it in full. */
  lateFeesOffIfPaidInFull?: number
  /** 10/5: the same, bill by bill — a bill the deposit pays only in part keeps its own. */
  lateFeesOffByBill?: Array<{ invoiceId: string; amount: number }>
  /**
   * 10/6 (Nic): how much of lateFeesOffIfPaidInFull is on the onboarding
   * month's bill — where "Delete the late fee completely (onboarding month)"
   * applies — and whether this person may tick it (owner / property manager).
   */
  onboardingLateFeesOff?: number
  canDeleteLateFees?: boolean
  /**
   * 10/6 (Nic): the property takes rent its tenants deposit at the bank
   * ("Tenants may deposit rent directly at the bank") — only then is "Bank
   * deposit" offered. Absent (an older server): offered, the server decides.
   */
  bankDepositAllowed?: boolean
}

/** 10/6 (Nic): the ways to record a payment here — "Bank deposit" only where the property takes them. */
export function recordableMethods<M extends string>(
  methods: readonly M[], q: { bankDepositAllowed?: boolean } | null | undefined,
): M[] {
  return methods.filter(m => m !== 'bank_deposit' || q?.bankDepositAllowed !== false)
}

/** 10/6 (Nic): does the window offer the onboarding box? A bank deposit dated back that takes a late fee off the onboarding bill, for someone who may tick it. */
export function onboardingLateFeeBoxApplies(
  q: Pick<DeskQuote, 'onboardingLateFeesOff' | 'canDeleteLateFees'> | null | undefined,
): boolean {
  return !!q && q.canDeleteLateFees === true && toCents(q.onboardingLateFeesOff) > 0
}

/** The desk's answer to "credit available $X": Use, Save, or not asked yet. */
export type CreditChoice = 'use' | 'save' | null

/** Must the desk answer Use or Save before recording? Whenever any credit could pay part of this bill. */
export function creditChoiceNeeded(q: Pick<DeskQuote, 'creditAvailable' | 'creditMustBeUsed'>): boolean {
  // 10/26 (Nic): where the landlord's answer is "use it", the desk is not
  // asked. Credit still lands on the bill — see creditCoversBill, which is the
  // question every figure depends on.
  return toCents(q.creditAvailable) > 0 && q.creditMustBeUsed !== true
}

/**
 * Whether the credit actually lands on this bill — true when the desk said Use,
 * and true WITHOUT being asked where the landlord turned saving off.
 *
 * Kept separate from creditChoiceNeeded on purpose: "is there a question to
 * ask" and "is the credit being spent" stopped being the same thing on 10/26,
 * and collapsing them would show the desk the owed-if-SAVED figure while the
 * server spent the credit.
 */
export function creditCoversBill(
  q: Pick<DeskQuote, 'creditAvailable' | 'creditMustBeUsed'>, choice: CreditChoice,
): boolean {
  if (toCents(q.creditAvailable) <= 0) return false
  return q.creditMustBeUsed === true || choice === 'use'
}

/**
 * What the server is told: the usable figure the desk was SHOWN when it said
 * Use (`shownCents`, captured at the click), or 0 for Save — never a figure it
 * was not shown. If the credit moved after the answer, the shown figure no
 * longer matches the server's and the server refuses with a 409, so the payer
 * is asked again instead of having a different amount spent silently.
 */
export function creditToUseFor(
  q: Pick<DeskQuote, 'creditAvailable' | 'creditMustBeUsed'>, choice: CreditChoice, shownCents?: number | null,
): number | undefined {
  const usable = toCents(q.creditAvailable)
  if (usable <= 0) return undefined
  // 10/26: nobody was asked, so send the figure the window displayed. The
  // server still refuses a figure that no longer matches, so a credit that
  // moved while the window was open is asked about rather than spent silently.
  if (q.creditMustBeUsed === true) return toDollars(shownCents ?? usable)
  if (choice === 'use') return toDollars(shownCents ?? usable)
  if (choice === 'save') return 0
  return undefined
}

/**
 * The figures the desk's answers rest on (cents): the credit, what is owed
 * with and without it, this bill and the old balance. The window keeps the
 * figures in place when the desk first answers anything (Use / Save, give
 * change or keep it, "yes, the check is $X"); if a fresh read changes any of
 * them, every answer is asked again (staff screens self-heal, Nic 10/2).
 */
export interface DeskFigures { credit: number; owedIfUsed: number; owedIfSaved: number; current: number; old: number }

export function deskFigures(q: Pick<DeskQuote, 'creditAvailable' | 'owedIfUsed' | 'owedIfSaved' | 'currentTotal' | 'oldBalanceTotal'>): DeskFigures {
  return {
    credit: toCents(q.creditAvailable), owedIfUsed: toCents(q.owedIfUsed), owedIfSaved: toCents(q.owedIfSaved),
    current: toCents(q.currentTotal), old: toCents(q.oldBalanceTotal),
  }
}

export function sameFigures(a: DeskFigures, b: DeskFigures): boolean {
  return a.credit === b.credit && a.owedIfUsed === b.owedIfUsed && a.owedIfSaved === b.owedIfSaved
    && a.current === b.current && a.old === b.old
}

/** The one message said when the figures moved under the desk's answers: what changed, and the next step. */
export function figuresMovedMessage(before: DeskFigures, after: DeskFigures): string {
  if (before.credit !== after.credit) {
    return after.credit > 0
      ? `Their credit changed — it is now ${money(toDollars(after.credit))}. Ask them again: use it or save it.`
      : 'Their credit changed — none of it can pay this bill now. Check the figures above and take what they show.'
  }
  const old = after.old > 0 ? `, with a ${money(toDollars(after.old))} old balance` : ''
  return `What they owe changed while this window was open — this bill is now ${money(toDollars(after.current))}${old}. Check the figures above and answer again.`
}

/** Money owed now for the bill the desk takes, after the Use / Save answer. */
export function deskOwedCents(
  q: Pick<DeskQuote, 'owedIfUsed' | 'owedIfSaved' | 'creditAvailable' | 'creditMustBeUsed'>, choice: CreditChoice,
): number {
  return creditCoversBill(q, choice) ? toCents(q.owedIfUsed) : toCents(q.owedIfSaved)
}

/** What the old (carried-forward) balance still owes. */
export function oldBalanceOwedCents(q: Pick<DeskQuote, 'oldBalance'>): number {
  return (q.oldBalance ?? []).reduce((s, r) => s + Math.max(0, toCents(r.amount) - toCents(r.creditAlreadyApplied)), 0)
}

/** The charge Record posts to: the one the window opened on while it is still open, else the oldest one the desk takes. */
export function postAnchor(q: Pick<DeskQuote, 'anchorOpen' | 'anchorPaymentId' | 'rows' | 'oldBalance'> & Pick<Partial<DeskQuote>, 'bills'>): string | null {
  if (q.anchorOpen) return q.anchorPaymentId
  // 10/14: the anchor only says whose balance it is — any open bill will do.
  return q.rows[0]?.id ?? q.oldBalance[0]?.id ?? q.bills?.[0]?.rows[0]?.id ?? null
}

// ─── THE OPEN BILLS, AS A STATEMENT ────────────────────────────────────────
//
// 10/14 (Nic) gave the desk a tick box per bill: "we also need to be able to
// log each separate bill as one payment ... the only thing I wanted paid
// together was the itemized lines of that invoice."
//
// 10/27 (Nic) took the boxes back out: "that checkbox beside each bill before
// cash check or money order can turn on, that is something you decided.
// That's not what I want at all. That's clunky. That adds an extra step to
// things that just need to be smooth. Disable that checkbox. There's no reason
// for it to exist." It had just stopped a resident's cash at the counter.
//
// So the desk takes the whole balance and the server lands it oldest bill
// first — the platform's standing rule either way (10/15: "money gets applied
// to the most outstanding balance first"). What is left here is the grouping
// that made the bills readable; the choosing is gone, with it
// canPickBill / togglePick / picksStillOpen / quoteMatchesPick.

/** The open bills, by space, in the quote's order (oldest first). */
export function billsBySpace(bills: readonly DeskQuoteBill[]): Array<{ key: string; label: string | null; bills: DeskQuoteBill[] }> {
  const out: Array<{ key: string; label: string | null; bills: DeskQuoteBill[] }> = []
  for (const b of bills) {
    const key = b.leaseId ?? 'none'
    let g = out.find(x => x.key === key)
    if (!g) { g = { key, label: b.unitNumber ? `Space ${b.unitNumber}` : null, bills: [] }; out.push(g) }
    g.bills.push(b)
  }
  return out
}

/**
 * ── 10/27: THE AMOUNT SAYS WHICH BILLS IT PAYS ──────────────────────────────
 *
 * With the tick boxes gone, something still has to answer the question they
 * answered: a household owing September and October hands over one month's
 * rent — is that a part payment of their balance (refused where the property
 * is pay-in-full) or payment in full of September (which is all 10/14's boxes
 * ever did)?
 *
 * The amount answers it. Bills are paid oldest first, so money that comes to
 * exactly the oldest bill, or the oldest two, or the oldest three, pays those
 * bills WHOLE and leaves nothing half-paid — no rent part-collected, no
 * eviction clock reset, which is what the pay-in-full rule protects. Anything
 * else really is a part payment and the rule still refuses it.
 *
 * Returns the ids of the bills the amount clears whole, oldest first — empty
 * when it clears none of them exactly. services/manualPaymentSettle applies
 * the same rule server-side; this mirrors it so the window says yes to the
 * same amounts the server will take.
 */
export function billsClearedByAmount(
  bills: readonly Pick<DeskQuoteBill, 'id' | 'owed'>[] | null | undefined,
  tenderedCents: number,
): string[] {
  if (!bills || bills.length === 0 || tenderedCents <= 0) return []
  const ids: string[] = []
  let run = 0
  for (const b of bills) {
    run += toCents(b.owed)
    ids.push(b.id)
    if (run === tenderedCents) return ids
    if (run > tenderedCents) return []
  }
  return []
}

/**
 * The amounts that DO pay whole bills, oldest first — what the desk can be
 * told when the amount handed over clears none of them: "$457.07 pays the
 * September bill, $902.29 pays the first two, $1,272.42 pays all of it."
 * Every running total, smallest first, the full balance last.
 */
export function wholeBillAmountsCents(
  bills: readonly Pick<DeskQuoteBill, 'owed'>[] | null | undefined,
): number[] {
  if (!bills || bills.length === 0) return []
  const out: number[] = []
  let run = 0
  for (const b of bills) { run += toCents(b.owed); out.push(run) }
  return out
}

/** "September bill" — a bill by its month, for the list of bills. */
export function pickBillName(b: Pick<DeskQuoteBill, 'dueDate'>): string {
  return billName(b.dueDate, 'bill')
}

const METHOD_WORD: Record<ManualPaymentMethod, string> = MANUAL_PAYMENT_METHOD_WORD

/**
 * 10/5 (Nic): what the desk types for each way of paying — the amount box,
 * and the number that identifies it (cash has none). A bank deposit's number
 * is the reference on the bank's receipt: "in case somebody else happens to
 * deposit the same amount".
 */
export const AMOUNT_FIELD_LABEL: Record<ManualPaymentMethod, string> = {
  cash: 'Cash handed over',
  check: 'Amount on the check',
  money_order: 'Amount on the money order',
  bank_deposit: 'Amount deposited',
}
export const NUMBER_FIELD_LABEL: Record<ManualPaymentMethod, string> = {
  cash: '',
  check: 'Check number',
  money_order: 'Money order number',
  bank_deposit: DEPOSIT_REFERENCE_LABEL,
}
/** Said when Record is pressed without the number. */
export function numberMissingMessage(method: ManualPaymentMethod): string {
  return method === 'bank_deposit'
    ? 'Enter the deposit reference number from the bank\'s receipt — it tells this deposit apart from anyone else\'s for the same amount.'
    : `Enter the ${METHOD_WORD[method]} number — it is the receipt if the payment is ever questioned.`
}

/**
 * 10/5 (Nic): the photo of the bank's deposit receipt (optional, bank deposit
 * only). Null when it can be sent; else what is wrong with it, in plain words.
 */
export function depositPhotoProblem(file: { type: string; size: number } | null | undefined): string | null {
  // The tenant's photo on their own report takes the same files (@gam/shared).
  return bankReceiptPhotoProblem(file)
}

/**
 * 10/6 (Nic): what became of the late fees a bank deposit dated back took off,
 * said after it is recorded. "They get a credit against their bill and the
 * late payment still shows on their payment history" — credited (and, for a
 * fee they had already paid, given back as credit) — unless the landlord
 * deleted it in the onboarding month ("nothing shows on their record").
 * Null when no late fee came off.
 */
export function lateFeeOutcomeText(r: {
  lateFeesUnbilled?: number; lateFeesRefunded?: number; lateFeesDeleted?: number; lateFeeCountsLate?: boolean
  /** The server read the bill afterwards: another late fee is still on a bill the box deleted one from. */
  lateFeeDeletedStillLate?: boolean
}): string | null {
  const said: string[] = []
  // "Nothing shows on their record" only when no late fee is left on that
  // bill — the server reads what is left, never what was done.
  if (Number(r.lateFeesDeleted ?? 0) > 0) {
    said.push(r.lateFeeDeletedStillLate ? LATE_FEE_DELETED_STILL_LATE_LANDLORD_TEXT : LATE_FEE_DELETED_LANDLORD_TEXT)
  }
  const credited = toCents(r.lateFeesUnbilled)
  const refunded = toCents(r.lateFeesRefunded)
  if (credited > 0 || refunded > 0) {
    said.push(LATE_FEE_CREDITED_LANDLORD_TEXT
      + (refunded > 0 ? ` ${money(toDollars(refunded))} they had already paid was given back as credit.` : ''))
  }
  return said.length > 0 ? said.join(' ') : null
}

/** "October rent" — a bill's month and what it is, for "stays owed on …". */
export function billName(dueDate: string, label: string): string {
  const m = /^\d{4}-(\d{2})/.exec(String(dueDate ?? ''))
  const month = m ? MONTHS[Number(m[1]) - 1] : null
  const what = String(label || 'bill').split(' · ')[0].trim().toLowerCase()
  return month ? `${month} ${what}` : what
}

/** "a, b and c". */
function andList(xs: string[]): string {
  const u = [...new Set(xs)]
  return u.length <= 1 ? (u[0] ?? '') : `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`
}

/**
 * 10/5 (Nic): a bank deposit dated back, recorded as a part payment — the late
 * fees the window left off the bills it pays only in part go back on them (the
 * server judges each bill: services/manualPaymentSettle). Cents.
 */
export function lateFeesBackOnShortBills(q: Pick<DeskQuote, 'lateFeesOffByBill'>, shortInvoiceIds: readonly string[]): number {
  return (q.lateFeesOffByBill ?? [])
    .filter(b => shortInvoiceIds.includes(b.invoiceId))
    .reduce((s, b) => s + toCents(b.amount), 0)
}

/** 10/5 (Nic): "$100.00 stays owed on October rent — late fees still apply." */
export function stillOwedText(cents: number, names: string[]): string {
  return `${money(toDollars(cents))} stays owed${names.length ? ` on ${andList(names)}` : ''} — late fees still apply.`
}

/**
 * 10/6 (Nic): "why is it talking about credit when they didn't even make a
 * full payment to begin with? ... The landlord should never see something that
 * stupid." On a part payment the window says exactly what WILL happen with the
 * amount typed — what is owed, what is being paid, what stays owed, and that
 * late fees still apply — and nothing hypothetical: no "if this pays in full",
 * no credit. Cents in; the lines to show, in order.
 */
export function partPaymentLines(p: {
  owedCents: number; payingCents: number; stillOwedCents: number; names: string[]
  /** Money that could go on nothing left (only when no rent line can take it): the old balance first, then kept. */
  toOldCents?: number; keptCents?: number
  /**
   * Of `keptCents`, what goes on the rest of what they owe by itself (money
   * paid ahead goes on an open late fee, utility or fee right after the
   * record). Already out of `stillOwedCents`.
   */
  keptOnBalanceCents?: number
}): string[] {
  const out = [
    `Owed ${money(toDollars(p.owedCents))}`,
    `Paying ${money(toDollars(p.payingCents))}`,
    `Stays owed ${money(toDollars(p.stillOwedCents))}${p.names.length ? ` on ${andList(p.names)}` : ''} — late fees still apply.`,
  ]
  if ((p.toOldCents ?? 0) > 0) out.push(`${money(toDollars(p.toOldCents!))} of it goes to the old balance.`)
  const onBalance = Math.min(p.keptCents ?? 0, p.keptOnBalanceCents ?? 0)
  // Review fix (10/6): it is not "kept toward their next bill" when an open
  // line here takes it — it goes on the rest of what they owe.
  if (onBalance > 0) out.push(`${money(toDollars(onBalance))} of it goes on the rest of what they owe.`)
  const waits = (p.keptCents ?? 0) - onBalance
  if (waits > 0) {
    out.push(`${money(toDollars(waits))} of it cannot go on what is left (only rent can be paid in part), so it is kept toward their next bill.`)
  }
  return out
}

/**
 * Review fix (10/6, Nic: "why is it talking about credit when they didn't even
 * make a full payment"): "Post a payment" speaks of money kept ahead only when
 * the amount typed is more than they owe now — never before an amount is typed,
 * never for an amount that only pays what is open. Null: nothing to say.
 */
export function postAheadText(typedCents: number | null | undefined, owedNow: number | null | undefined): string | null {
  if (typedCents == null || typedCents <= 0 || owedNow == null) return null
  const over = typedCents - toCents(owedNow)
  if (over <= 0) return null
  return toCents(owedNow) > 0
    ? `They owe ${money(owedNow)} now. That is paid first; the other ${money(toDollars(over))} is kept as paid ahead and goes on their bills by itself as they come.`
    : `They owe nothing now. The ${money(toDollars(over))} is kept as paid ahead and goes on their bills by itself as they come.`
}

/**
 * 10/6 (Nic): a bank deposit dated back — the late fees charged after the day
 * it was deposited come off ONLY the bills the amount typed pays in full (the
 * server judges each bill). Said only when that will happen: nothing while no
 * amount is typed, nothing on a bill paid only in part. Null: nothing to say.
 */
export function backdatedLateFeeText(
  q: Pick<DeskQuote, 'lateFeesOffIfPaidInFull' | 'lateFeesOffByBill'> | null | undefined,
  plan: Pick<TenderPlan, 'stop' | 'shortInvoiceIds'> | null | undefined,
  depositedOn: string | null,
  typedCents: number | null,
): string | null {
  if (!q || !plan || !depositedOn || typedCents == null || typedCents <= 0 || plan.stop !== null) return null
  const off = toCents(q.lateFeesOffIfPaidInFull) - lateFeesBackOnShortBills(q, plan.shortInvoiceIds)
  if (off <= 0) return null
  return `Deposited ${dayWord(depositedOn)}, before ${money(toDollars(off))} in late fees were charged. This pays `
    + `${plan.shortInvoiceIds.length > 0 ? 'the bill those fees are on' : 'the bill'} in full, so those late fees are credited; `
    + 'the payment still counts as late on their history. When your bank feed shows this deposit, the bank\'s date decides.'
}

/**
 * 10/6 (Nic): the bill as ONE balance — its charges, then the credit already
 * applied against it, then what is still owed. Never a line marked "covered by
 * credit". Cents.
 */
export function deskBillBalance(q: Pick<DeskQuote, 'currentTotal' | 'creditAlreadyApplied'>): {
  charges: number; creditApplied: number; stillOwed: number
} {
  const charges = toCents(q.currentTotal)
  const creditApplied = Math.min(charges, toCents(q.creditAlreadyApplied))
  return { charges, creditApplied, stillOwed: charges - creditApplied }
}

export interface TenderInput {
  method: ManualPaymentMethod
  /** What was handed over, cents; null = nothing typed. */
  tenderedCents: number | null
  choice: CreditChoice
  /** Cash only: "also pay $X toward the old balance" when change is given (null = not typed). */
  towardOldCents: number | null
  /** Cash over the bill: hand it back, or keep it (no change on hand). Never defaulted. */
  surplusHandling: 'change' | 'credit' | null
  /** A check or money order over the bill: the desk confirmed the amount written on it. */
  writtenConfirmed: boolean
  /** The credit figure (cents) on screen when the desk said Use or Save; null/absent = the current figure. */
  answeredCreditCents?: number | null
  /** What a charge is called ("Rent", "Water") — for the part-payment line. Default: its type. */
  nameOf?: (r: DeskQuoteRow) => string
}

export type TenderStop =
  | 'choose_credit' | 'credit_moved' | 'amount' | 'short' | 'written_confirm' | 'too_much_to_old'
  | 'surplus_choice' | 'credit_and_keep' | 'nothing_to_pay'

export interface TenderPlan {
  owedCents: number
  oldOwedCents: number
  overCents: number
  /** Money going to the old balance. */
  toOldCents: number
  /** Over the bill and the old-balance part. */
  surplusCents: number
  changeCents: number
  keptAsCreditCents: number
  /** 10/6: of a part payment's kept money, what goes on the rest of what they owe by itself (already out of stillOwedCents). */
  keptOnBalanceCents?: number
  creditUsedCents: number
  /** Choices the cash buttons offer: [change to hand back, old balance if kept, credit if kept]. */
  ifChange: { changeCents: number; toOldCents: number }
  ifKept: { toOldCents: number; creditCents: number }
  /** Why Record cannot be pressed yet (the first thing to fix), and what to say. */
  stop: TenderStop | null
  message: string | null
  /** amountTendered / creditToUse / towardOldBalance / surplusHandling / confirmWrittenAmount to send. */
  body: Record<string, unknown> | null
  /**
   * 10/5 (Nic): a part payment (the property takes them) — what stays owed
   * after it (cents) and the line that says so; 0 / null when paid in full.
   */
  stillOwedCents: number
  stillOwedText: string | null
  /** 10/5: the bills (invoices) a part payment leaves owed — paid in part or not reached — and what they are called. */
  shortInvoiceIds: string[]
  stillOwedNames: string[]
}

/**
 * 10/5 (Nic): a part payment, as services/manualPaymentSettle takes it — the
 * one placement both call (@gam/shared placePartPayment): the money pays the
 * oldest bills first, each in full; a RENT bill it cannot cover in full is
 * paid in part (the rest stays owed); any other bill it cannot cover is passed
 * by and stays owed whole. 10/6 (Nic): money is never left over as credit
 * while the balance is owed — the newest rent paid in full is paid last and
 * takes what is left. Only when no rent can take it is anything kept (rare):
 * the old balance first, then their account.
 */
export function partialPlan(q: DeskQuote, choice: CreditChoice, tenderedC: number, nameOf?: (r: DeskQuoteRow) => string): {
  stillOwedCents: number; names: string[]; toOldCents: number; keptCents: number; keptOnBalanceCents: number; shortInvoiceIds: string[]
} {
  const useCredit = choice === 'use' && creditChoiceNeeded(q)
  const owed = (r: DeskQuoteRow) =>
    Math.max(0, toCents(r.amount) - toCents(r.creditAlreadyApplied) - (useCredit ? toCents(r.creditIfUsed) : 0))
  const name = (r: DeskQuoteRow) => billName(r.dueDate, nameOf ? nameOf(r) : r.type)
  const placed = placePartPayment(q.rows ?? [], owed, tenderedC)
  let stillOwed = 0
  const short: DeskQuoteRow[] = []
  for (const s of placed.partSplits) { stillOwed += s.owedOnRow - s.take; short.push(s.row) }
  for (const r of placed.notReached) { stillOwed += owed(r); short.push(r) }
  // Named in the bill's own order, oldest first.
  const ordered = (q.rows ?? []).filter(r => short.includes(r))
  const names: string[] = []
  const shortInvoiceIds: string[] = []
  for (const r of ordered) {
    names.push(name(r))
    if (r.invoiceId && !shortInvoiceIds.includes(r.invoiceId)) shortInvoiceIds.push(r.invoiceId)
  }
  const toOld = Math.min(placed.left, oldBalanceOwedCents(q))
  const kept = placed.left - toOld
  // What is kept goes on an open line money paid ahead may pay, by itself
  // (services/manualPaymentSettle leftoverOnBalance — the same figure).
  const onBalance = Math.min(kept, placed.notReached.filter(paidAheadGoesOn).reduce((t, r) => t + owed(r), 0))
  return {
    stillOwedCents: stillOwed - onBalance, names, toOldCents: toOld, keptCents: kept, keptOnBalanceCents: onBalance, shortInvoiceIds,
  }
}

/**
 * What to add to a "that is short" refusal where whole bills WOULD be taken:
 * the amounts that pay the oldest bill, the oldest two, and so on. Empty when
 * there is only one bill (the owed figure already says it), or when credit is
 * being spent (the bills' own figures are not what is owed then).
 */
function wholeBillAmountsText(q: DeskQuote, creditUsedCents: number): string {
  if (creditUsedCents > 0) return ''
  const bills = q.bills ?? []
  if (bills.length < 2) return ''
  const runs = wholeBillAmountsCents(bills)
  const words = runs.map((c, i) => `${money(toDollars(c))} pays ${
    i === 0 ? `the ${pickBillName(bills[0])}`
    : i === runs.length - 1 ? 'all of it'
    : `the oldest ${i + 1} bills`}`)
  return ` Whole bills can be taken: ${words.join('; ')}.`
}

/**
 * THE DESK'S QUESTIONS, ASKED BEFORE RECORD (services/manualPaymentSettle is
 * the authority; this mirrors it so the window asks instead of being refused):
 *   - Use or Save, whenever credit could pay part of the bill (Nic, 10/2);
 *   - pay in full — never less than owed (standing directive);
 *   - cash over the bill: "Give $X change" or "Keep it — no change on hand",
 *     nothing defaulted (S637; Nic 10/3) — money kept pays the old balance
 *     first, then is credit;
 *   - money kept as credit while credit is being used is refused (cash: hand
 *     it back; a check: save the credit instead);
 *   - last, a check or money order over the bill: "is it really $X?"
 *     (harland-credits 10/3: typed round-ups became stray credits) — asked
 *     only once nothing else would refuse it, in the server's order.
 */
export function planTender(q: DeskQuote, input: TenderInput): TenderPlan {
  const isCash = input.method === 'cash'
  const usableC = toCents(q.creditAvailable)
  const creditUsedC = creditCoversBill(q, input.choice) ? usableC : 0
  const owedC = deskOwedCents(q, input.choice)
  const oldOwedC = oldBalanceOwedCents(q)
  const hasRows = (q.rows ?? []).length > 0
  // Nothing typed and nothing to take (the credit pays it all): $0 handed over.
  const tenderedC = input.tenderedCents ?? (owedC === 0 && creditUsedC > 0 ? 0 : null)
  const blank: TenderPlan = {
    owedCents: owedC, oldOwedCents: oldOwedC, overCents: 0, toOldCents: 0, surplusCents: 0,
    changeCents: 0, keptAsCreditCents: 0, creditUsedCents: creditUsedC,
    ifChange: { changeCents: 0, toOldCents: 0 }, ifKept: { toOldCents: 0, creditCents: 0 },
    stop: null, message: null, body: null, stillOwedCents: 0, stillOwedText: null, shortInvoiceIds: [], stillOwedNames: [],
  }
  const stop = (s: TenderStop, message: string | null, extra: Partial<TenderPlan> = {}): TenderPlan =>
    ({ ...blank, ...extra, stop: s, message })

  // An answer given against another credit figure is no answer: ask again.
  if (input.choice !== null && input.answeredCreditCents != null && input.answeredCreditCents !== usableC) {
    return stop('credit_moved', figuresMovedMessage(
      { ...deskFigures(q), credit: input.answeredCreditCents }, deskFigures(q)))
  }
  // 10/26: only asked where the landlord allows saving; otherwise the credit
  // is already on the bill and the window states it.
  if (creditChoiceNeeded(q) && input.choice === null) {
    return stop('choose_credit',
      `They have ${money(toDollars(usableC))} of credit that can pay part of this bill. Choose Use or Save first.`)
  }
  if (tenderedC === null) return stop('amount', null)
  // 10/6 (Nic): the credit goes on the bill even when it pays only part of it
  // and nothing is handed over — the pay-in-full rule is about their own money.
  const creditOnlyPart = tenderedC === 0 && creditUsedC > 0 && tenderedC < owedC
  // 10/27: money that comes to exactly the oldest bill, or the oldest few,
  // pays those bills whole — not a part payment (billsClearedByAmount). Only
  // where no credit is being spent: with credit on the bill the amount owed is
  // no longer the bills' own figures, so the old rule stands and the desk is
  // asked for the lot.
  const clearsWholeBills = creditUsedC === 0 && billsClearedByAmount(q.bills, tenderedC).length > 0
  if (tenderedC < owedC && !q.partialPaymentsAllowed && !creditOnlyPart && !clearsWholeBills) {
    return stop('short',
      `That is ${money(toDollars(owedC - tenderedC))} short — ${money(toDollars(tenderedC))} against ${money(toDollars(owedC))} owed. Rent is paid in full.`
      + wholeBillAmountsText(q, creditUsedC))
  }
  // 10/5 (Nic): the property takes part payments — "there's really no way to
  // stop somebody from going into the bank and making a partial".
  if (tenderedC < owedC) {
    if (tenderedC === 0 && !creditOnlyPart) return stop('amount', null)
    const part = partialPlan(q, input.choice, tenderedC, input.nameOf)
    if (part.keptCents > 0 && creditUsedC > 0) {
      return stop('credit_and_keep',
        `Credit is being used on this bill and ${money(toDollars(part.keptCents))} of this payment would be kept as credit beside it. Choose Save instead.`)
    }
    const body: Record<string, unknown> = { method: input.method, amountTendered: toDollars(tenderedC) }
    const creditToUse = creditToUseFor(q, input.choice, input.answeredCreditCents)
    if (creditToUse !== undefined) body.creditToUse = creditToUse
    return {
      ...blank, toOldCents: part.toOldCents, surplusCents: part.keptCents, keptAsCreditCents: part.keptCents,
      keptOnBalanceCents: part.keptOnBalanceCents, body,
      stillOwedCents: part.stillOwedCents, stillOwedText: stillOwedText(part.stillOwedCents, part.names),
      shortInvoiceIds: part.shortInvoiceIds, stillOwedNames: part.names,
    }
  }
  const overC = tenderedC - owedC
  const word = METHOD_WORD[input.method]

  const oldFirstC = Math.min(overC, oldOwedC)
  const autoOld = owedC === 0 && creditUsedC === 0
  const changeToOld = input.towardOldCents ?? (autoOld ? oldFirstC : 0)
  const ifChange = { changeCents: Math.max(0, overC - changeToOld), toOldCents: changeToOld }
  const ifKept = { toOldCents: oldFirstC, creditCents: overC - oldFirstC }
  const keeps = !isCash || input.surplusHandling === 'credit'
  let toOldC: number
  if (keeps) {
    toOldC = oldFirstC
  } else {
    if (input.towardOldCents !== null && input.towardOldCents > oldFirstC) {
      return stop('too_much_to_old', oldOwedC === 0
        ? 'There is no old balance to put money toward.'
        : `At most ${money(toDollars(oldFirstC))} can go toward the old balance.`,
      { overCents: overC, ifChange, ifKept })
    }
    toOldC = changeToOld
  }
  const surplusC = overC - toOldC
  if (surplusC > 0 && isCash && input.surplusHandling === null) {
    return stop('surplus_choice',
      `That is ${money(toDollars(overC))} over the bill. Choose "Give change" or "Keep it — no change on hand".`,
      { overCents: overC, ifChange, ifKept })
  }
  const keepAsCredit = surplusC > 0 && keeps
  if (keepAsCredit && creditUsedC > 0) {
    return stop('credit_and_keep', isCash
      ? `Credit is being used on this bill, so the ${money(toDollars(surplusC))} extra can only be handed back as change.`
      : `Credit is being used on this bill and the ${word} is ${money(toDollars(surplusC))} over it. Choose Save instead.`,
    { overCents: overC, toOldCents: toOldC, surplusCents: surplusC, ifChange, ifKept })
  }
  if (!hasRows && toOldC === 0) {
    return stop('nothing_to_pay', tenderedC === 0
      ? 'Only the old balance is open here, and it is paid with money. Enter the amount handed over.'
      : 'Nothing would be paid — only the old balance is open here. Put the money toward the old balance, or keep it.',
    { overCents: overC, ifChange, ifKept })
  }
  // A check or money order written over the bill: "is it really $X?" — asked
  // LAST, once nothing else stands in the way, as the server asks it (fix
  // round 2: the desk is never made to confirm an amount and then refused for
  // something else, such as "Credit is being used… Choose Save instead").
  if (!isCash && overC > 0 && !input.writtenConfirmed) {
    const against = oldOwedC === 0
      ? `against ${money(toDollars(owedC))} owed`
      : owedC === 0
        ? `toward the ${money(toDollars(oldOwedC))} old balance`
        : `against the ${money(toDollars(owedC))} bill and a ${money(toDollars(oldOwedC))} old balance`
    const where = input.method === 'bank_deposit' ? 'Check the amount on the bank\'s receipt' : 'Check the amount written on it'
    return stop('written_confirm',
      `You typed ${money(toDollars(tenderedC))} ${against} — is the ${word} really ${money(toDollars(tenderedC))}? ${where}, then confirm.`,
      { overCents: overC, toOldCents: toOldC, surplusCents: surplusC, ifChange, ifKept })
  }
  const changeC = surplusC > 0 && !keepAsCredit ? surplusC : 0
  const body: Record<string, unknown> = {
    method: input.method,
    amountTendered: toDollars(tenderedC),
  }
  const creditToUse = creditToUseFor(q, input.choice, input.answeredCreditCents)
  if (creditToUse !== undefined) body.creditToUse = creditToUse
  // Cash over the bill: the desk's answer goes with it whenever there was one —
  // even when nothing is left as credit. "Keep it" with all of the extra paying
  // the old balance leaves no surplus here, but the server only sends kept cash
  // to the old balance when it is told the cash was kept (its keepsMoney rule);
  // without the answer it reads the cash as not kept and refuses (fix round 2).
  if (isCash && overC > 0 && input.surplusHandling !== null) body.surplusHandling = input.surplusHandling
  if (!isCash && surplusC > 0) body.surplusHandling = 'credit'
  // Money kept pays the old balance first: the server works that out itself.
  // An amount is sent only when change is given and the desk typed one.
  if (isCash && !keeps && input.towardOldCents !== null && input.towardOldCents > 0) {
    body.towardOldBalance = toDollars(input.towardOldCents)
  }
  if (!isCash && overC > 0) body.confirmWrittenAmount = true
  return {
    ...blank,
    overCents: overC, toOldCents: toOldC, surplusCents: surplusC, changeCents: changeC,
    keptAsCreditCents: keepAsCredit ? surplusC : 0, ifChange, ifKept, body,
  }
}

/** What the desk is told after Record (the server's own figures). */
export function recordedMessage(name: string, r: {
  amountSettled?: number; creditUsed?: number; towardOldBalance?: number
  changeGiven?: number; surplus?: number; creditId?: string | null
  /** 10/5: a part payment — what is still owed after it, and the words for where. */
  stillOwed?: number; stillOwedNames?: string[]
  /** 10/6: what a part payment could not place, gone on the rest of what they owe. */
  leftoverOnBalance?: number
  /** 10/5 (Nic): a bank deposit dated back — late fees charged after that day that came off. */
  depositedOn?: string | null; lateFeesUnbilled?: number; lateFeesRefunded?: number
  /** 10/6 (Nic): late fees deleted from the onboarding bill (the box), and whether a late fee left on a bill still counts late. */
  lateFeesDeleted?: number; lateFeeCountsLate?: boolean; lateFeeDeletedStillLate?: boolean
  /** 10/6 (Nic): the onboarding box was ticked but a late fee could not be deleted — why (credited instead, or still owed). */
  lateFeeDeleteRefusals?: string[]
}): string {
  const parts: string[] = []
  const settled = toCents(r.amountSettled)
  const credit = toCents(r.creditUsed)
  const stillOwedC = toCents(r.stillOwed)
  // Review fix (10/6): credit that paid only part of the bill did not "pay the bill".
  parts.push(settled > 0 ? `Recorded ${money(toDollars(settled))} from ${name}`
    : stillOwedC > 0 ? `Applied ${money(toDollars(credit))} of ${name}'s credit` : `Paid ${name}'s bill with their credit`)
  if (credit > 0 && settled > 0) parts.push(`${money(toDollars(credit))} of their credit used`)
  if (toCents(r.towardOldBalance) > 0) parts.push(`${money(r.towardOldBalance)} went to the old balance`)
  const onBalanceC = Math.min(toCents(r.surplus), toCents(r.leftoverOnBalance))
  if (toCents(r.changeGiven) > 0) parts.push(`give ${money(r.changeGiven)} change`)
  else if (toCents(r.surplus) > 0 && r.creditId && stillOwedC > 0) {
    // 10/6 (Nic): a part payment is never said as credit while the balance is owed.
    if (onBalanceC > 0) parts.push(`${money(toDollars(onBalanceC))} went on the rest of what they owe`)
    if (toCents(r.surplus) > onBalanceC) parts.push(`${money(toDollars(toCents(r.surplus) - onBalanceC))} kept toward their next bill`)
  }
  else if (toCents(r.surplus) > 0 && r.creditId) parts.push(`${money(r.surplus)} kept on their account as credit`)
  if (stillOwedC > 0) return `${parts.join(' — ')} — ${stillOwedText(stillOwedC, r.stillOwedNames ?? [])}`
  const said = r.depositedOn ? lateFeeOutcomeText(r) : null
  const refused = lateFeeDeleteRefusalText(r.lateFeeDeleteRefusals)
  return parts.join(' — ') + '.' + (said ? ` ${said}` : '') + (refused ? ` ${refused}` : '')
}

/**
 * 10/6 (Nic): the onboarding box was ticked but the server could not delete a
 * late fee (most often money is recorded against it). Its own reasons, in its
 * own plain words, once each; null when nothing was refused.
 */
export function lateFeeDeleteRefusalText(refusals: unknown): string | null {
  const said = [...new Set((Array.isArray(refusals) ? refusals : [])
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()))]
  return said.length > 0 ? said.join(' ') : null
}

/**
 * A refusal that names a charge's raw status — "This charge is not open
 * (status: settled)", from the record, prior-arrangement and reader routes —
 * said in plain words (no raw enum on a screen; routes/payments.ts words it
 * that way today). Every screen that shows it reads the bill again, so what
 * is still owed is what the desk sees next. Any other text is left as the
 * server wrote it.
 */
const NOT_OPEN = /^This charge is not open \(status: ([a-z_]+)\)\.?$/
export function plainRefusal(text: string): string {
  const m = NOT_OPEN.exec(text.trim())
  if (!m) return text
  const label = PAYMENT_STATUS_LABEL[m[1] as PaymentStatus]
  return `This charge is no longer open${label ? ` — it is ${label.toLowerCase()} now` : ''}.`
}

/** A server refusal's words, said once (axios puts them on response.data.error). */
export function serverMessage(e: unknown, fallback: string): string {
  const any = e as { response?: { data?: { error?: unknown; message?: unknown } }; message?: unknown }
  const said = any?.response?.data?.error ?? any?.response?.data?.message
  if (typeof said === 'string' && said.trim()) return plainRefusal(said.trim())
  if (typeof any?.message === 'string' && any.message.trim() && !/status code \d+/.test(any.message)) return any.message.trim()
  return fallback
}

/** The HTTP status of a refusal (409 = something moved: refetch and ask again in place). */
export function serverStatus(e: unknown): number | null {
  const s = (e as { response?: { status?: unknown } })?.response?.status
  return typeof s === 'number' ? s : null
}

// ─── The card reader at the desk ─────────────────────────────────────────────

export interface ReaderFigures { balance: number; cardFee: number; total: number }

/** GET /payments/:id/reader/quote. */
export interface ReaderQuote extends ReaderFigures {
  outstanding: number
  usableCredit: number
  needsCreditChoice: boolean
  /**
   * 10/26 (Nic): the property turned "let residents save credit for later"
   * OFF, so the reader is not asked either — the credit is on the bill and the
   * block states it. The server already applied it when working this quote out,
   * so needsCreditChoice comes back false alongside this.
   */
  creditMustBeUsed?: boolean
  useCredit: boolean
  creditUsed: number
  creditApplied: number
  oldBalance: number
  towardOldBalance: number
  paidAhead: number
  ifUsed?: ReaderFigures
  ifSaved?: ReaderFigures
  lineItems: Array<{ description: string; amountCents: number; quantity: number }>
}

/** What a reader quote, charge and show are told: the Use/Save answer with the figure shown, and any old-balance amount. */
export function readerChoiceParams(
  usableCredit: number, choice: CreditChoice, towardOldCents: number | null, mustUse = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // 10/26: nobody is asked where saving is off, but the figure still goes with
  // the charge so a credit that moved since the quote is refused rather than a
  // different amount spent quietly.
  if (toCents(usableCredit) > 0 && mustUse && choice === null) {
    out.useCredit = true
    out.expectedCredit = toDollars(toCents(usableCredit))
  } else if (toCents(usableCredit) > 0 && choice !== null) {
    out.useCredit = choice === 'use'
    out.expectedCredit = toDollars(toCents(usableCredit))
  }
  if (towardOldCents !== null && towardOldCents > 0) out.towardOldBalance = toDollars(towardOldCents)
  return out
}

/** The same, as a query string for GET /reader/quote. */
export function readerQuoteQuery(usableCredit: number, choice: CreditChoice, towardOldCents: number | null): string {
  const p = readerChoiceParams(usableCredit, choice, towardOldCents)
  const qs = Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  return qs ? `?${qs}` : ''
}

/**
 * Does the reader have what it needs to be sent the amount? The desk asked Use
 * or Save when there is credit (Nic, 10/2: "before sending"), and there is
 * something to put on a card.
 */
export function readerReady(
  q: (Pick<ReaderQuote, 'usableCredit' | 'total'> & Partial<Pick<ReaderQuote, 'outstanding' | 'oldBalance' | 'creditUsed'>>) | null | undefined,
  choice: CreditChoice,
): { ready: boolean; reason: string | null } {
  if (!q) return { ready: false, reason: null }
  // 10/26 (Nic): where the landlord turned saving off there is no question to
  // put, so the reader is ready without one — asking would hold the payment on
  // an answer the server has already made.
  const mustUse = (q as Partial<ReaderQuote>).creditMustBeUsed === true
  if (toCents(q.usableCredit) > 0 && choice === null && !mustUse) {
    return { ready: false, reason: `Ask whether to use their ${money(q.usableCredit)} credit or save it, before sending the amount to the reader.` }
  }
  if (!(toCents(q.total) > 0)) {
    // Fix pass 3: say why nothing can be sent in the words that fit — the
    // credit covers it only when credit is being used.
    if (toCents(q.creditUsed ?? 0) > 0) {
      return { ready: false, reason: 'The credit covers this whole bill — nothing goes on a card. Choose Cash, then Use, and record it with nothing taken.' }
    }
    const old = toCents(q.oldBalance ?? 0)
    if (old > 0 && toCents(q.outstanding ?? 0) - old <= 0) {
      return { ready: false, reason: 'Only an old balance is open on this space. Enter an amount toward the old balance to send it to the reader.' }
    }
    return { ready: false, reason: 'Nothing is open on this space to put on a card.' }
  }
  return { ready: true, reason: null }
}

/** One block per lease on the bill (the reader takes one lease at a time — its own fee and receipt, S581). */
export interface ReaderSpace { leaseId: string; anchorId: string; unitNumber: string | null }

/**
 * One reader block per lease, each charged on one of its own charges. Fix pass
 * 2: the bill is read again once a space is taken on the reader (so what the
 * desk takes next is only what is left), and that read no longer lists the
 * space just taken. A space already taken stays listed — first, exactly as it
 * was when it was taken — so the desk still sees "Taken." beside it and the
 * other space keeps its name.
 */
export function readerLeases(
  q: Pick<DeskQuote, 'rows' | 'oldBalance'> & Pick<Partial<DeskQuote>, 'bills'>,
  taken: readonly ReaderSpace[] = [],
): Array<ReaderSpace & { label: string | null }> {
  const seen = new Map<string, ReaderSpace>()
  for (const s of taken) if (s?.leaseId && !seen.has(s.leaseId)) seen.set(s.leaseId, s)
  // 10/14: the reader takes a space at a time on its own quote — every open
  // bill's space, whatever is ticked for cash.
  const open = q.bills ? q.bills.flatMap(b => b.rows) : (q.rows ?? [])
  for (const r of [...open, ...(q.oldBalance ?? [])]) {
    if (!r.leaseId || seen.has(r.leaseId)) continue
    seen.set(r.leaseId, { leaseId: r.leaseId, anchorId: r.id, unitNumber: r.unitNumber ?? null })
  }
  const list = [...seen.values()]
  return list.map(s => ({ ...s, label: list.length > 1 && s.unitNumber ? `Space ${s.unitNumber}` : null }))
}

/**
 * A household whose spaces were paid two ways in one visit — one on the card
 * reader, the rest in cash, by check or from credit — hears both (fix pass 2):
 * the card taken first, then what the desk recorded.
 */
export function withReaderTaken(text: string, takenDollars: number): string {
  return toCents(takenDollars) > 0 ? `Took ${money(takenDollars)} by card on the reader. ${text}` : text
}

/**
 * Every space was taken on the reader (fix pass 3): what was taken, and — read
 * from the bill as it stands after the last card — anything still open there,
 * so an old balance left behind is never left unsaid. `after` is null when that
 * read failed (nothing more is claimed then).
 */
export function readerFinishedMessage(
  name: string, takenDollars: number, after: Pick<DeskQuote, 'rows' | 'oldBalance'> | null,
): string {
  const text = `Took ${money(takenDollars)} by card on the reader from ${name}.`
  if (!after) return text
  const rowsCents = (after.rows ?? []).reduce((s, r) => s + Math.max(0, toCents(r.amount) - toCents(r.creditAlreadyApplied)), 0)
  const oldCents = oldBalanceOwedCents(after)
  if (rowsCents + oldCents <= 0) return text
  return rowsCents === 0
    ? `${text} Their ${money(toDollars(oldCents))} old balance is still open (it is paid last) — use Record payment again to take it.`
    : `${text} ${money(toDollars(rowsCents + oldCents))} is still open — use Record payment again to take it.`
}

// ─── Posting a payment that arrived before its bill ──────────────────────────

/** A check or money order posted ahead: "is it really $X?" before it becomes money paid ahead. */
export function postConfirmQuestion(method: ManualPaymentMethod, cents: number): string | null {
  if (method === 'cash' || !(cents > 0)) return null
  const where = method === 'bank_deposit' ? 'Check the amount on the bank\'s receipt.' : 'Check the amount written on it.'
  // 10/5: worded for every outcome — where the property takes part payments,
  // an amount under what is owed pays part of the bill and nothing is paid ahead.
  return `Is the ${METHOD_WORD[method]} really ${money(toDollars(cents))}? ${where} It pays what is open first, oldest bill first; anything over what is owed is kept on their account as paid ahead.`
}

/**
 * A check or money order is identified by its number (S637), and a bank
 * deposit by the reference on the bank's receipt (10/5): required before it
 * is recorded.
 */
export function numberRequired(method: ManualPaymentMethod): boolean {
  return method === 'check' || method === 'money_order' || method === 'bank_deposit'
}

// ─── The tenant page's credit card ───────────────────────────────────────────

export interface TenantCredit { total: number; usable: number; paidAhead: number; fromLandlord: number; depositInterest: number }

/**
 * "ALL the credit on their account, and what of it would pay their bills right
 * now" (tenants.ts). The parts, in words; a part with nothing in it is left out.
 */
export function tenantCreditLines(c: TenantCredit | null | undefined): Array<{ label: string; amount: number }> {
  if (!c) return []
  return [
    { label: 'Paid ahead', amount: c.paidAhead },
    { label: 'Credit you gave', amount: c.fromLandlord },
    { label: 'Statutory interest on their deposit', amount: c.depositInterest },
  ].filter(l => toCents(l.amount) > 0)
}

export function tenantCreditHeadline(c: TenantCredit | null | undefined): string | null {
  if (!c || toCents(c.total) <= 0) return null
  const usable = toCents(c.usable)
  if (usable <= 0) return `${money(c.total)} on their account. Nothing they owe right now can be paid from it.`
  if (usable >= toCents(c.total)) return `${money(c.total)} on their account — all of it can pay what they owe now.`
  return `${money(c.total)} on their account — ${money(c.usable)} of it can pay what they owe now.`
}

/** The one sentence on how credit is used, everywhere a landlord reads about it (decisions, 10/2). */
export const CREDIT_USE_RULE =
  // 10/6 (Nic): "a credit against the entire balance", not line by line.
  'Money they paid ahead goes on their balance by itself, oldest bill first — on part of a bill when it cannot pay all of it, '
  // 10/18 (Nic): "it does need to go on the October bill for the other spot" —
  // but only for credit YOU give. Money they paid ahead stays with the space
  // they paid it for.
  + 'and only on the space they paid it for. '
  // 10/15 (Nic): "money gets applied to the most outstanding balance first" —
  // credit you give goes on the balance the same way, so none of it sits there
  // while they owe. Only what is over the whole balance waits for a next bill.
  + 'Credit you give them goes on their oldest bill first across every space they hold with you, '
  + 'so credit never sits on an account while they still owe.'

/**
 * Why part of the credit on an account cannot pay what is owed right now.
 * 10/18: a credit you gave is no longer one of the reasons — it crosses spaces
 * by due date now — so the line names the two kinds of money that do stay put.
 */
export const CREDIT_REST_NOT_USABLE =
  ' The rest cannot pay these bills: money they paid ahead stops at its monthly limit and pays only the space they paid it for, '
  + 'interest on a deposit pays only that space, and credit pays only your own rent, utilities, late fees and fees.'

// ─── The Payments ledger (decisions #26, #29, #35.1, #36.A) ──────────────────

export interface LedgerPayment {
  id: string
  name: string
  unitNumber: string | null
  propertyName: string | null
  paidOn: string
  /** 10/12: what this payment put toward the month's bills (money plus credit) — never "owed". */
  applied: number
  amount: number
  creditApplied: number
  returned: number
  /**
   * Of `creditApplied`, paid-ahead credit whose own money a card dispute or
   * bank return took back after it paid these bills (services/paymentsByMonth
   * LedgerPayment.credit_returned). This payment's own money is `returned`.
   */
  creditReturned: number
  methodLabel: string
  /** 10/5: the receipt this payment is, its reference (check / money-order number, bank deposit reference). */
  receiptId?: string | null
  reference?: string | null
  /** 10/5 (Nic): a bank deposit's photo of the bank's receipt (authed URL; the landlord's own people only). */
  depositPhotoUrl?: string | null
  /**
   * 10/5 (Nic): paid from a bank deposit the tenant reported on an earlier
   * day than the bank shows — the two dates (the screen says "Said they
   * deposited Oct 1 — the bank shows Oct 6."). Null otherwise.
   */
  depositDateFlag?: { said: string; bank: string } | null
  /** 10/5 (Nic): the tenant's own photo of the bank's receipt on that report (authed URL). */
  tenantReceiptPhotoUrl?: string | null
  method?: string | null
  status: 'settled' | 'clearing' | 'returned'
  statusLabel: string
  paidFor: string
  daysLate: number
  timingLabel: string
}

/** How a card dispute or a bank reversal is named on a returned charge (payments.return_code holds the type). */
export const REVERSAL_RETURN_LABEL: Record<PaymentReversalType, string> = {
  ach_return: 'Bank return after it cleared',
  ach_unauthorized: 'Bank return after it cleared — not authorized',
  card_dispute: 'Card dispute',
}

export interface ReturnFacts { returnCode?: string | null; returnReason?: string | null; zeroToleranceFlag?: boolean | null }

/**
 * Why a payment came back, for the landlord's ledger: what happened in words,
 * the bank's code beside it, and the zero-tolerance mark when the bank said the
 * debit was not authorized (bank payments from that person are then stopped).
 * Null when the charge carries no return.
 */
export function returnDetail(r: ReturnFacts | null | undefined): { text: string; zeroTolerance: boolean } | null {
  const code = String(r?.returnCode ?? '').trim()
  if (!code) return null
  const ach = ACH_RETURN_CONFIG[code]
  const zeroTolerance = r?.zeroToleranceFlag === true || ach?.zeroTolerance === true
  if (ach) return { text: `Bank return: ${ach.plain} (${code})`, zeroTolerance }
  if ((PAYMENT_REVERSAL_TYPE_VALUES as readonly string[]).includes(code)) {
    return { text: REVERSAL_RETURN_LABEL[code as PaymentReversalType], zeroTolerance }
  }
  const reason = String(r?.returnReason ?? '').trim()
  return { text: reason ? `Returned: ${reason} (${code})` : `Returned (${code})`, zeroTolerance }
}

/** The words for the zero-tolerance mark. */
export const ZERO_TOLERANCE_TEXT = 'Zero tolerance — bank payments from them are stopped'

/**
 * Why paid-ahead credit that paid a bill was taken back (fix pass 2): the
 * bill's own charges were not disputed — the payment that put the credit on
 * their account was, and the bill is owed again for that part.
 */
export const CREDIT_TAKEN_BACK_TEXT =
  'The payment that put this credit on their account was disputed or returned — this bill is owed again for that part'

/** The due-date span, in whole months, that holds these charges (to read them from GET /payments); null for none. */
export function chargeMonthsRange(dueDates: readonly string[]): { from: string; to: string } | null {
  const days = dueDates.filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).map(d => d.slice(0, 10)).sort()
  if (!days.length) return null
  const last = days[days.length - 1]
  const [y, m] = last.slice(0, 7).split('-').map(Number)
  const end = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${days[0].slice(0, 7)}-01`, to: `${last.slice(0, 7)}-${String(end).padStart(2, '0')}` }
}

/** How many charges one page of GET /payments carries (the route's own ceiling). */
export const CHARGE_PAGE_SIZE = 1000
/** Pages read at most for one set of charges (50,000 charges); past that the caller says some were not read. */
export const CHARGE_MAX_PAGES = 50

/**
 * Particular charges, read from GET /payments by id (fix round 2): the route
 * returns at most 1,000 charges a page, ordered by due date, and a large
 * portfolio bills more than that in a month, so one page could leave a charge
 * out with no sign of it — a returned payment's reason on the ledger, or the
 * onboarding "already collected" button at the desk. Pages are read until
 * every charge asked for is found, or a page comes back short (the last one).
 * `complete` is false only when the page limit stopped the read with some
 * still missing.
 */
export async function readChargesById<T extends { id: string }>(
  fetchPage: (page: number) => Promise<T[] | null | undefined>,
  wanted: ReadonlySet<string>,
  pageSize: number = CHARGE_PAGE_SIZE,
  maxPages: number = CHARGE_MAX_PAGES,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = []
  const missing = new Set(wanted)
  for (let page = 1; page <= maxPages && missing.size > 0; page++) {
    const got = (await fetchPage(page)) ?? []
    for (const r of got) {
      if (r?.id && missing.has(r.id)) { rows.push(r); missing.delete(r.id) }
    }
    if (got.length < pageSize) return { rows, complete: true }
  }
  return { rows, complete: missing.size === 0 }
}

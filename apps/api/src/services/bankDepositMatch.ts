// S624 — match an inbound BANK DEPOSIT to the tenant charges it paid.
//
// WHY THIS EXISTS (Nic, S624). A landlord running a property remotely takes
// cash and checks, and the tenant deposits them straight into the landlord's
// bank. Today GAM makes the landlord transcribe every one of those by hand:
// look up when the deposit hit, waive the late fee that accrued in the
// meantime, credit it back down, mark the charges paid — and unwind all of it
// when a check bounces. That is work GAM can simply delete: the bank feed is
// already required and already syncing these very rows.
//
// The important by-product is not the clicks saved. It is that the DEPOSIT'S
// OWN BANK DATE becomes the payment date, so the late fee is decided by a fact
// instead of by the landlord's judgment about when someone probably paid.
//
// WHY THIS SUGGESTS RATHER THAN DECIDES
//
// The park that prompted this is ~25 lots that ALL pay $250. A $250 deposit is
// therefore consistent with 25 different tenants, and no amount of cleverness
// can tell them apart — a cash deposit carries no payer. So the matcher RANKS
// and the landlord CONFIRMS. That is still most of the work removed: picking a
// name off a shortlist instead of transcribing an amount, a date, a method and
// a set of charges.
//
// A CHECK is different from CASH here, and the difference is worth exploiting:
// the payer's name is usually in the bank memo. When a name lands, confidence
// is high enough to pre-select. When it doesn't, we say so rather than guess.
//
// RENT IS PAY-IN-FULL (standing directive): a deposit settles whole charges
// only, never part of one, and never more than the deposit.
//
// S655 (money plan §3, the bank-deposit row; decisions #11):
//   - THE OLDEST LINES WIN. Of every set of a tenant's open charges that adds
//     up to the deposit, the one paying the oldest lines is proposed (the one
//     allocation order: ordinary bills, then propane, then the old carried
//     balance; by due date). Fewest lines only breaks a tie.
//   - A TENANT'S REPORT SETTLES ONLY WHAT ADDS UP TO IT, TO THE CENT. A report
//     that matches no set of charges is shown for review with "covers $X of $Y
//     owed" and is never settled by itself. (It used to fall back to the
//     tenant's WHOLE balance: a $300 report settled $750 of charges.)
//   - A deposit that is short of what is owed, or more than it, says so:
//     "covers $X of $Y owed"; what is over the lines it pays becomes paid-ahead
//     money when the landlord records it (services/bankDepositConfirm).

import { sortForAllocation, declaredDateHolds, reportedTimeText } from '@gam/shared'

export interface OpenCharge {
  id: string
  leaseId: string
  tenantId: string
  /** For name-matching against the bank memo, and for the landlord's shortlist. */
  tenantName: string
  unitNumber: string
  /** What is still owed on it in money: the charge less any credit already spent on it. */
  amount: number
  dueDate: string
  /** `payments.type`. A carried balance sorts after every current bill. */
  type: string
  /** `payments.entry_description`: propane sorts after the ordinary bills. */
  entryDescription?: string | null
  /** `payments.created_at`: the last tie-break of the one allocation order. */
  createdAt?: string | null
}

/**
 * A deposit the TENANT told us about — "I paid $250 at the bank on the 3rd".
 *
 * S624 (Nic): in the normal case the amounts already identify the payer, because
 * every unit is submetered and the water line makes each invoice total distinct.
 * The hard case is a property where utilities are included and every rent is the
 * same figure. Nic asked for "an option that gives the landlord minimal work to
 * do" there — and the minimal amount of work is NONE, which is what this is.
 *
 * The tenant is the one person who knows they paid. They already hold the app;
 * they already see the invoice. Letting them declare the deposit means the
 * landlord never touches it: the tenant asserts, the BANK verifies, GAM
 * reconciles the two. It is strictly better evidence than the landlord guessing,
 * because the landlord was not at the bank either.
 */
export interface TenantDeclaredDeposit {
  id: string
  leaseId: string
  tenantId: string
  amount: number
  /** The date the TENANT says they made the deposit. */
  declaredDate: string
  /**
   * S624 (Nic): "they should also mark whether they paid cash or check or money
   * order just in case two dollar amounts happen to be exactly matching."
   *
   * It is a genuinely good discriminator, because a bank memo describes the
   * INSTRUMENT even when it names nobody — and a mobile deposit is a check by
   * definition, since you cannot photograph cash.
   */
  method: 'cash' | 'check' | 'money_order'
  /** 10/5 (Nic): the deposit reference number from the bank's receipt (older reports may have none). */
  reference?: string | null
  /** 10/5 (Nic): the tenant's photo of the bank's receipt (an authed URL), if they added one. */
  receiptPhotoUrl?: string | null
  /**
   * 10/6 (Nic): about what time they were at the bank — the hour they picked
   * (8–18), or after hours / ATM. Null on a report made before it was asked.
   */
  hour?: number | null
  afterHours?: boolean
}

/**
 * What the bank memo suggests the deposit WAS, if anything.
 *
 * Returns null when the memo is silent, which is common and must not be read as
 * a contradiction — an unhelpful memo is not evidence against a tenant.
 */
export function memoMethodHint(
  description: string | null | undefined,
): 'cash' | 'check' | null {
  const d = String(description || '').toUpperCase()
  // A mobile or remote deposit is a photographed instrument. Checked first
  // because "MOBILE DEPOSIT" contains no other clue and is extremely common.
  if (/\bMOBILE\b|\bREMOTE\b|\bRDC\b|\bCHECK\b|\bCHK\b|\bCK\b/.test(d)) return 'check'
  if (/\bCASH\b|\bATM\b|\bTELLER\b|\bCURRENCY\b/.test(d)) return 'cash'
  return null
}

/**
 * Does the tenant's stated method contradict what the bank memo describes?
 *
 * A money order deposits like a check (it is a paper instrument), so it is NOT
 * treated as contradicting a check-shaped memo. Only a genuine cash/paper
 * mismatch counts — and even then it demotes rather than eliminates, because
 * memos lie by omission and a tenant may simply have misremembered.
 */
export function methodContradicts(
  declaredMethod: TenantDeclaredDeposit['method'],
  description: string | null | undefined,
): boolean {
  const hint = memoMethodHint(description)
  if (!hint) return false
  const declaredIsPaper = declaredMethod === 'check' || declaredMethod === 'money_order'
  return declaredIsPaper ? hint === 'cash' : hint === 'check'
}

export interface DepositToMatch {
  amount: number
  postedDate: string
  description: string | null
}

export type MatchConfidence =
  /** The tenant declared this deposit and the bank row confirms it. */
  | 'declared'
  /** The memo names a tenant and their open charges total the deposit exactly. */
  | 'named_exact'
  /** The memo names a tenant; the amount does not tie out on its own. */
  | 'named_partial'
  /** Exactly one way to make this amount out of open charges. */
  | 'amount_unique'
  /** The amount ties out, but several tenants could equally be the payer. */
  | 'amount_ambiguous'
  /** Short of any full charge; only offerable against a carried balance. */
  | 'carried_paydown'

export interface DepositMatch {
  chargeIds: string[]
  leaseId: string
  tenantId: string
  tenantName: string
  unitNumber: string
  /** What the proposed charges total: never more than the deposit. */
  total: number
  /** Everything this lease owes now (its open bank-payable charges). */
  owed: number
  /** The proposed charges add up to the deposit to the cent. */
  exact: boolean
  confidence: MatchConfidence
  /** How many OTHER tenants the same amount would have fitted. 0 = unambiguous. */
  rivals: number
  /** Plain sentence for the landlord's screen. Never a raw enum. */
  reason: string
  /**
   * 10/5 (Nic): the tenant's report behind a 'declared' match — what the
   * landlord sees beside it (the reference, the photo of the bank's receipt)
   * and whether the bank bears out the date they gave (false: the bank posted
   * it later than the next business day, so the bank's date counts and the
   * report is flagged when it is recorded).
   */
  declaration?: {
    id: string
    declaredDate: string
    reference: string | null
    receiptPhotoUrl: string | null
    dateHolds: boolean
    /** 10/6 (Nic): the hour the tenant picked (8–18), or null. */
    hour: number | null
    /** 10/6 (Nic): they picked after hours / ATM. */
    afterHours: boolean
  }
}

/**
 * Confidence high enough to pre-select the row for the landlord, rather than
 * merely offering it. Everything else still requires them to choose.
 *
 * Deliberately narrow: a wrong pre-selection that gets confirmed reflexively is
 * worse than no suggestion at all, because it books a stranger's money against
 * a tenant's ledger and then reports it to a credit bureau.
 *
 * S655: only a set of charges that adds up to the deposit to the cent. A
 * tenant's report that matches no such set is reviewed, never pre-selected —
 * and the unattended auto-settle (services/bankFeed) acts only on what this
 * admits.
 */
export function isPreselectable(m: DepositMatch): boolean {
  if (!m.exact || m.chargeIds.length === 0) return false
  return m.confidence === 'declared'
    || m.confidence === 'named_exact'
    || (m.confidence === 'amount_unique' && m.rivals === 0)
}

/**
 * S655 (money plan §3, "Bank-deposit auto-settle by amount"; Step 12; Nic 10/2:
 * "auto-settle a tenant's own bank deposit that equals exactly one tenant's
 * whole open bill to the cent with nothing else fitting").
 *
 * This reverses S624's "never on amount alone", so it is narrow on purpose. A
 * deposit nobody reported settles by itself only when:
 *   - the match adds up to the deposit to the cent, and it is the tenant's
 *     WHOLE bank-payable bill with this company (every lease of the household),
 *     not a part of it;
 *   - nothing else fits: it is the only candidate (no other tenant whose bills
 *     add up to the same figure) — or a deposited check whose memo names
 *     this tenant and nobody else (isTenantCheckMemo), which tells
 *     same-amount tenants apart;
 *   - no tenant reported a deposit of this amount, and this household has no
 *     report waiting (that is the declared path's job);
 *   - no other deposit of the same amount posted within
 *     AUTO_SETTLE_SAME_AMOUNT_DAYS days;
 *   - no deposit slip and no combination of the office's unbanked cash adds up
 *     to it (then it may be the office's bag — a person decides).
 * Everything else waits for the landlord with its shortlist. An auto-settle can
 * be undone (bankDepositConfirm.undoDepositMatch) and both sides are told.
 */
export const AUTO_SETTLE_SAME_AMOUNT_DAYS = 4

export interface AutoSettleContext {
  /** What this household owes the company in bank-payable money now, every lease. */
  householdOwed: number
  /** Pending tenant reports of this amount in the window, plus any pending report from this household. */
  pendingReports: number
  /** Other money-in bank rows of the same amount within AUTO_SETTLE_SAME_AMOUNT_DAYS days. */
  sameAmountDeposits: number
  /** An open deposit slip, or a combination of unbanked cash, adds up to the deposit. */
  competingCash: boolean
  /** The bank memo. */
  description: string | null
}

/**
 * May this match settle with nobody looking? `all` is every candidate the
 * matcher returned for the deposit (matchDeposit). Pure: the caller gathers
 * the context.
 */
export function isAutoSettleable(m: DepositMatch, all: readonly DepositMatch[], ctx: AutoSettleContext): boolean {
  if (!m.exact || m.chargeIds.length === 0) return false
  // The whole bill of the lease, and of the household.
  if (cents(m.total) !== cents(m.owed) || cents(ctx.householdOwed) !== cents(m.total)) return false
  if (ctx.pendingReports > 0 || ctx.sameAmountDeposits > 0 || ctx.competingCash) return false
  if (m.confidence === 'amount_unique') return m.rivals === 0 && all.length === 1
  // A check naming exactly this tenant (matchDeposit demotes a name that fits
  // two tenants). Step 12 review: only a memo that reads as a deposited check
  // AND names nobody but this tenant — a Square payout naming its account
  // holder ("Square Inc … Meryl Rhoades") or a branch deposit whose street
  // address holds a tenant's name ("… GREEN VALLEY AZ") is not a tenant's check.
  if (m.confidence === 'named_exact') return isTenantCheckMemo(ctx.description, m.tenantName)
  return false
}

/**
 * How far a bank posting may sit from the date the tenant says they paid.
 *
 * A branch deposit posts same-day or next business day; a weekend or a holiday
 * stretches it. Four days covers a Friday afternoon deposit over a long weekend
 * without being so wide that two consecutive months could overlap.
 */
export const DECLARATION_DATE_WINDOW_DAYS = 4

/**
 * 10/5 (Nic): how long AFTER the date a tenant gave the bank may post the
 * deposit and still be the one they reported — a week, the time a report
 * waits for its deposit (routes/declaredDeposits DECLARATION_EXPIRY_DAYS).
 *
 * Nic: "if they say they paid on time and it was actually late we need to make
 * sure that they get the late fee and then they get flagged for false
 * information." A report dated Oct 1 for a deposit the bank posted Oct 6 is
 * that deposit with a false date: it matches, the bank's date decides the late
 * fees, and the report is flagged (services/depositBackdate). Inside the old
 * four-day reach it would have found nothing and expired as "not found".
 * Earlier than the posting the reach stays four days (a date after the bank's
 * is a slip of the calendar, and the bank's date is used).
 */
export const DECLARATION_POSTED_LATE_DAYS = 7

/** Can a report dated `declaredDate` be the deposit the bank posted on `postedDate`? */
export function declarationReaches(declaredDate: string, postedDate: string): boolean {
  const late = Math.round((Date.parse(`${postedDate}T00:00:00Z`) - Date.parse(`${declaredDate}T00:00:00Z`)) / 86400000)
  return late <= DECLARATION_POSTED_LATE_DAYS && -late <= DECLARATION_DATE_WINDOW_DAYS
}

/** SQL twin of declarationReaches: `declared` (a date) can be the deposit posted on `posted` (a date). */
export function declarationReachesSql(declared: string, posted: string): string {
  return `${declared} BETWEEN (${posted} - ${DECLARATION_POSTED_LATE_DAYS}) AND (${posted} + ${DECLARATION_DATE_WINDOW_DAYS})`
}

export function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`))
  return Math.round(ms / 86400000)
}

/**
 * Bank boilerplate: words that say HOW money came in, never WHO sent it. The
 * ONE list (Step 12 fix round 2 — it used to exist twice, here and in
 * bankFeed.ts, and the two copies had drifted). Both readers use it:
 *   - bankFeed.namesAPayer: a payer key made only of these ("MOBILE DEPOSIT",
 *     "EDEPOSIT IN BRANCH/STORE", "MOBILE DEPOSIT REF NUMBER", "DEPOSIT MADE IN
 *     A") names nobody — it may be the office's cash, it never files itself as
 *     income, and only such a deposit may settle a bill on amount alone.
 *   - memoNameTokens below: whatever is left after these is a candidate name.
 *
 * Seen in production: Wells Fargo's "eDeposit in Branch … 02:31:45 PM …" and
 * "EDEPOSIT IN BRANCH/STORE", PNC's "DEPOSIT *4021", a mobile deposit's "REF
 * NUMBER", a payout's "Square Inc SQ…" (SQ and INC say nothing; SQUARE still
 * names the payer).
 */
export const BANK_BOILERPLATE_WORDS: ReadonlySet<string> = new Set([
  'DEPOSIT', 'DEP', 'DEPOSITED', 'MOBILE', 'REMOTE', 'RDC', 'ATM', 'BRANCH', 'TELLER', 'CASH', 'CURRENCY',
  'EDEPOSIT', 'EDEP', 'STORE', 'NIGHT', 'DROP', 'COUNTER', 'ONLINE', 'BANKING', 'BANK', 'AM', 'PM',
  'CHECK', 'CHECKS', 'CHK', 'CK', 'MONEY', 'ORDER', 'MO', 'TRANSFER', 'XFER',
  'CREDIT', 'CR', 'DR', 'ACH', 'PAYMENT', 'PMT', 'RENT',
  'ITEM', 'ITEMS', 'REF', 'ID', 'NUMBER', 'NBR', 'CAPTURE', 'INSTANT', 'INC', 'SQ', 'CO',
  'MADE', 'FROM', 'TO', 'IN', 'OF', 'THE', 'A', 'THANK', 'YOU',
])

/**
 * decisions.md #48.1: words that say the money moved between accounts
 * ("ONLINE TRANSFER FROM CHK 1234", "XFER FROM SAVINGS") — most often the
 * landlord's own. They stay in BANK_BOILERPLATE_WORDS (such a memo still
 * yields no name and never teaches GAM a payer), and on top of that a memo
 * with one of them is never the office's banked cash, never a deposit slip,
 * never a tenant's check, and never settles a bill on amount alone: it goes to
 * review. A tenant's own report of the same amount still confirms it.
 */
export const NOT_CUSTOMER_MONEY_WORDS: ReadonlySet<string> = new Set(['TRANSFER', 'XFER'])

/** Does this bank memo (raw, or a payer key) say the money is a transfer between accounts? */
export function memoSaysTransfer(description: string | null | undefined): boolean {
  return String(description ?? '').toUpperCase().split(/[^A-Z]+/)
    .some(w => NOT_CUSTOMER_MONEY_WORDS.has(w))
}

/**
 * Words that do name a payer — so they are NOT bank boilerplate — but never a
 * person: "INTEREST PAYMENT" is the bank itself paying interest. A payer for
 * filing income, never part of a tenant's name.
 */
const NOT_A_PERSON_WORDS: ReadonlySet<string> = new Set(['INTEREST'])

/**
 * Tokens from a bank memo that could plausibly be a person's name.
 *
 * Bank descriptions for deposits are noisy and mostly boilerplate — "MOBILE
 * DEPOSIT", "ATM DEPOSIT 07/12", "REMOTE DEP CHK". Strip the boilerplate and
 * whatever is left is a candidate name.
 */
const isMemoNoise = (w: string) => BANK_BOILERPLATE_WORDS.has(w) || NOT_A_PERSON_WORDS.has(w)

/** Street words that end the number-and-street part of an address ("360 W CONTINENTAL RD"). */
const STREET_SUFFIXES = new Set([
  'RD', 'ROAD', 'ST', 'STREET', 'AVE', 'AV', 'AVENUE', 'BLVD', 'BOULEVARD', 'DR', 'DRIVE', 'LN', 'LANE',
  'WAY', 'HWY', 'HIGHWAY', 'CT', 'COURT', 'PL', 'PLACE', 'PKWY', 'PARKWAY', 'CIR', 'CIRCLE', 'TRL', 'TRAIL',
  'LOOP', 'TER', 'TERRACE', 'PIKE',
])

/**
 * Step 12 review: a word with a digit in it is a reference, a date, a time or
 * a house number — dropped WHOLE before punctuation is stripped, so a Square
 * reference "T3H80F2ZQ67M" never leaves fragments ("ZQ", "MKBFF") that could
 * spell a name. And a street address names a place, not a payer: from a house
 * number followed within four words by a street word ("360 W CONTINENTAL RD
 * GREEN VALLEY AZ") to the end of the memo is the branch's address and is
 * never read for names.
 */
export function memoNameTokens(description: string | null | undefined): string[] {
  if (!description) return []
  const raw = String(description).toUpperCase().split(/\s+/).filter(Boolean)
  let end = raw.length
  for (let i = 0; i < raw.length; i++) {
    if (!/^\d+$/.test(raw[i])) continue
    const ahead = raw.slice(i + 1, i + 5).map(w => w.replace(/[^A-Z]/g, ''))
    if (ahead.some(w => STREET_SUFFIXES.has(w))) { end = i; break }
  }
  return raw.slice(0, end)
    .filter(w => !/\d/.test(w))
    .join(' ')
    .replace(/[^A-Z' ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !isMemoNoise(w))
}

/** The parts of a tenant's name long enough to look for in a memo. */
function nameParts(tenantName: string): string[] {
  return String(tenantName || '')
    .toUpperCase()
    .replace(/[^A-Z' ]+/g, ' ')
    .split(/\s+/)
    .filter(p => p.length >= 3)
}

/**
 * Step 12 review: does the memo name this tenant and NOBODY else? Every word
 * left after the bank's boilerplate, references and address must be part of
 * the tenant's name. "REMOTE DEP CHK R GARCIA" is Rosa Garcia's alone; "Square
 * Inc … Meryl Rhoades" names Meryl (and Square) as well as a Rhoades, so it is
 * not Nicholas Rhoades's check.
 */
export function memoNamesOnlyTenant(description: string | null | undefined, tenantName: string): boolean {
  const tokens = memoNameTokens(description)
  const parts = nameParts(tenantName)
  if (tokens.length === 0 || parts.length === 0) return false
  return tokens.every(t => parts.includes(t))
}

/**
 * Step 12 review: a memo GAM may read as THIS tenant's deposited check, the
 * only named deposit that may settle a bill with nobody looking (decisions
 * 10/2: "a check memo naming the tenant with an exact amount"): the memo reads
 * as a check (mobile / remote / check deposit) and names only this tenant.
 */
export function isTenantCheckMemo(description: string | null | undefined, tenantName: string): boolean {
  // "ONLINE TRANSFER FROM CHK …" reads check-shaped (CHK) but is no check (#48.1).
  if (memoSaysTransfer(description)) return false
  return memoMethodHint(description) === 'check' && memoNamesOnlyTenant(description, tenantName)
}

/**
 * Does this memo name this tenant? Matches on any name part of length ≥ 3, so
 * "MOBILE DEPOSIT R GARCIA" finds Rosa Garcia on the surname alone.
 *
 * Single-initial first names are why we do not require both parts: on a paper
 * check the endorsement rarely survives into the memo intact.
 */
export function memoNamesTenant(description: string | null | undefined, tenantName: string): boolean {
  const tokens = memoNameTokens(description)
  if (tokens.length === 0) return false
  const parts = nameParts(tenantName)
  if (parts.length === 0) return false
  return parts.some(p => tokens.includes(p))
}

/** Cents, so subset-sum can work in exact integers. */
const cents = (n: number) => Math.round(n * 100)
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`

/** One tenant's open charges in the one allocation order (packages/shared). */
export function inAllocationOrder(charges: readonly OpenCharge[]): OpenCharge[] {
  const byId = new Map(charges.map(c => [c.id, c]))
  return sortForAllocation(charges.map(c => ({
    id: c.id, amount: c.amount, due_date: c.dueDate, type: c.type,
    entry_description: c.entryDescription ?? null, created_at: c.createdAt ?? null,
  }))).map(x => byId.get(x.id)!)
}

/** How old a line is, for "the oldest lines win": its sort bucket, then its due date. */
function ageKey(c: OpenCharge): string {
  const bucket = c.type === 'carried_balance' ? 2
    : (c.entryDescription ?? '').toUpperCase() === 'PROPANE' ? 1 : 0
  return `${bucket}|${c.dueDate}`
}

/**
 * Which of two sets of lines (each given as positions in the allocation order)
 * pays the older lines: compared line by line from the oldest; when one set's
 * lines are the other's first lines, the set with fewer lines wins — fewest
 * lines only breaks a tie. Positions decide whatever is left, so the answer
 * never depends on query order.
 */
function olderSetFirst(sorted: readonly OpenCharge[], a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ka = ageKey(sorted[a[i]]), kb = ageKey(sorted[b[i]])
    if (ka !== kb) return ka < kb ? -1 : 1
  }
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * Bounded deliberately: a lease with a pathological number of open charges is a
 * broken ledger, not a matching problem, and an unbounded search here would let
 * one bad row hang the landlord's bank screen. Beyond the cap only the oldest
 * lines in order are tried (a run of them that adds up exactly is the
 * oldest-lines answer anyway), which still finds "they paid everything".
 */
const MAX_CHARGES_FOR_SUBSET = 14

/**
 * The set of one lease's open charges that adds up to `target` to the cent and
 * pays the oldest lines (olderSetFirst). Null when no set adds up.
 */
export function bestExactSet(charges: readonly OpenCharge[], target: number): OpenCharge[] | null {
  const t = cents(target)
  if (t <= 0 || charges.length === 0) return null
  const sorted = inAllocationOrder(charges)
  if (sorted.length > MAX_CHARGES_FOR_SUBSET) {
    let sum = 0
    for (let i = 0; i < sorted.length; i++) {
      sum += cents(sorted[i].amount)
      if (sum === t) return sorted.slice(0, i + 1)
      if (sum > t) break
    }
    return null
  }
  let best: number[] | null = null
  const n = sorted.length
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0
    const pick: number[] = []
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { sum += cents(sorted[i].amount); pick.push(i) }
      if (sum > t) break
    }
    if (sum === t && (!best || olderSetFirst(sorted, pick, best) < 0)) best = pick
  }
  return best ? best.map(i => sorted[i]) : null
}

/**
 * What a deposit that adds up to no set of charges would pay, oldest first,
 * whole lines only: the lines in allocation order up to the first one it
 * cannot pay in full. Never more than the deposit; may be nothing.
 */
export function oldestLinesWithin(charges: readonly OpenCharge[], amount: number): OpenCharge[] {
  let left = cents(amount)
  const out: OpenCharge[] = []
  for (const c of inAllocationOrder(charges)) {
    const owe = cents(c.amount)
    if (owe <= 0) continue
    if (owe > left) break
    out.push(c)
    left -= owe
  }
  return out
}

/** "covers $X of $Y owed", or nothing when the lines pay everything owed. */
export function coversText(totalCents: number, owedCents: number): string | null {
  return totalCents < owedCents ? `covers ${dollars(totalCents)} of ${dollars(owedCents)} owed` : null
}

/** The charges a deposit would pay, said for the landlord. */
function linesWord(n: number, mine: boolean): string {
  return n === 1 ? (mine ? 'their open charge' : 'an open charge') : `${n} open charges`
}

/**
 * The review sentence for a deposit that adds up to no set of a tenant's
 * charges: what it would pay oldest first, and what would be left over.
 */
function noTieOut(depositCents: number, fit: readonly OpenCharge[], owedCents: number): string {
  const fitCents = fit.reduce((s, c) => s + cents(c.amount), 0)
  const extra = depositCents - fitCents
  return `it covers ${dollars(fitCents)} of ${dollars(owedCents)} owed` +
    (extra > 0 ? ` and would leave ${dollars(extra)} as paid-ahead money` : '')
}

/**
 * Rank the ways this deposit could have been paid.
 *
 * Returns at most `limit` matches, best first. An empty result means the
 * landlord files it as other income (or ignores it) exactly as they do today —
 * this feature never blocks that path.
 */
export function matchDeposit(
  deposit: DepositToMatch,
  openCharges: OpenCharge[],
  opts: {
    declarations?: TenantDeclaredDeposit[]; limit?: number
    /**
     * 10/6 (Nic): the reports GAM will not pick between for this deposit
     * (services/declaredDepositAssign) — why, in the landlord's words. Every
     * report candidate is then a choice for the landlord, never pre-selected
     * and never settled by itself, and none is dropped for its instrument.
     */
    conflict?: string | null
  } = {},
): DepositMatch[] {
  const limit = opts.limit ?? 8
  if (!(deposit.amount > 0) || openCharges.length === 0) return []
  const depositCents = cents(deposit.amount)

  // A TENANT DECLARATION OUTRANKS EVERYTHING. It is the only signal that comes
  // from someone who was actually at the bank; the amount and the memo are both
  // inferences about a person who left no name. When one lands, the landlord has
  // nothing to do at all.
  const declared = (opts.declarations ?? []).filter(d =>
    cents(d.amount) === depositCents
    && declarationReaches(d.declaredDate, deposit.postedDate))

  // Group by lease: a deposit pays one tenant's charges. A single deposit
  // covering TWO tenants (a landlord banking the day's cash in one go) is a
  // real case, but it is a SPLIT — the landlord allocates it across tenants —
  // not a match, and offering a speculative cross-tenant combination would be
  // guessing with someone's rent record.
  const byLease = new Map<string, OpenCharge[]>()
  for (const c of openCharges) {
    if (!(cents(c.amount) > 0)) continue
    const list = byLease.get(c.leaseId)
    if (list) list.push(c); else byLease.set(c.leaseId, [c])
  }
  const owedOf = (charges: readonly OpenCharge[]) => charges.reduce((s, c) => s + cents(c.amount), 0)

  interface Cand { m: DepositMatch; rank: number }
  const cands: Cand[] = []

  // When two tenants declare the same figure, the one whose stated instrument
  // agrees with the bank memo is the better answer — this is the tiebreaker Nic
  // asked for. If it separates them cleanly, the ambiguity disappears entirely.
  const agreeing = opts.conflict ? [] : declared.filter(d => !methodContradicts(d.method, deposit.description))
  // 10/5: one report per lease — the one this deposit bears out first, then
  // the nearest date. A report now reaches a week back (DECLARATION_POSTED_
  // LATE_DAYS), so a weekly payer's last week's report and this week's can
  // both reach this deposit; it is this week's, never a flag on last week's.
  const nearestPerLease = new Map<string, TenantDeclaredDeposit>()
  const better = (a: TenantDeclaredDeposit, b: TenantDeclaredDeposit) => {
    const ha = declaredDateHolds(a.declaredDate, deposit.postedDate), hb = declaredDateHolds(b.declaredDate, deposit.postedDate)
    if (ha !== hb) return ha
    const ga = daysApart(a.declaredDate, deposit.postedDate), gb = daysApart(b.declaredDate, deposit.postedDate)
    return ga !== gb ? ga < gb : a.id < b.id
  }
  for (const d of agreeing.length > 0 ? agreeing : declared) {
    const cur = nearestPerLease.get(d.leaseId)
    if (!cur || better(d, cur)) nearestPerLease.set(d.leaseId, d)
  }
  const usable = [...nearestPerLease.values()]

  for (const d of usable) {
    const charges = byLease.get(d.leaseId) ?? []
    const head = inAllocationOrder(charges)[0]
    if (!head) continue
    const owedCents = owedOf(charges)
    // 10/6 (Nic): and about what time, when they said.
    const at = reportedTimeText({ hour: d.hour ?? null, afterHours: d.afterHours ?? false })
    const said = `${head.tenantName} reported paying $${d.amount.toFixed(2)} at the bank on ${d.declaredDate}${at ? `, ${at}` : ''}`
    // S655 (decisions #11): the report settles only charges that add up to
    // it exactly — never the whole balance for a smaller deposit. Anything
    // else is shown for review, never pre-selected or settled by itself.
    const exact = bestExactSet(charges, deposit.amount)
    const lines = exact ?? oldestLinesWithin(charges, deposit.amount)
    const totalCents = lines.reduce((s, c) => s + cents(c.amount), 0)
    const covers = coversText(totalCents, owedCents)
    // 10/5 (Nic): the bank's date counts when it posted later than the next business day.
    const dateHolds = declaredDateHolds(d.declaredDate, deposit.postedDate)
    cands.push({
      rank: exact ? -1 : 1,
      m: {
        chargeIds: lines.map(c => c.id),
        leaseId: d.leaseId, tenantId: d.tenantId,
        tenantName: head.tenantName, unitNumber: head.unitNumber,
        total: totalCents / 100, owed: owedCents / 100, exact: !!exact,
        confidence: 'declared',
        rivals: 0,
        reason: (exact
          ? `${said}, and this deposit matches ${linesWord(lines.length, true)} exactly${covers ? ` — it ${covers}` : ''}.`
          : `${said}, but it does not add up to any set of their open charges: ${noTieOut(depositCents, lines, owedCents)}. Check it before recording.`),
        // 10/5: a false date is said once, from `declaration.dateHolds` (the
        // match screen's own flag line) — never also in this reason.
        declaration: {
          id: d.id, declaredDate: d.declaredDate, reference: d.reference ?? null,
          receiptPhotoUrl: d.receiptPhotoUrl ?? null, dateHolds,
          hour: d.hour ?? null, afterHours: d.afterHours === true,
        },
      },
    })
  }
  const declaredLeases = new Set(cands.map(c => c.m.leaseId))

  for (const [leaseId, charges] of byLease) {
    if (declaredLeases.has(leaseId)) continue
    const head = inAllocationOrder(charges)[0]
    const named = memoNamesTenant(deposit.description, head.tenantName)
    const owedCents = owedOf(charges)

    const best = bestExactSet(charges, deposit.amount)
    if (best) {
      const covers = coversText(depositCents, owedCents)
      cands.push({
        // Named-and-exact is the only combination we will ever pre-select, so
        // it ranks alone at the top.
        rank: named ? 0 : 2,
        m: {
          chargeIds: best.map(c => c.id),
          leaseId, tenantId: head.tenantId,
          tenantName: head.tenantName, unitNumber: head.unitNumber,
          total: depositCents / 100, owed: owedCents / 100, exact: true,
          confidence: named ? 'named_exact' : 'amount_unique',
          rivals: 0,
          reason: (named
            ? `The deposit names ${head.tenantName} and matches ${linesWord(best.length, true)} exactly`
            : `Matches ${linesWord(best.length, false)} on ${head.unitNumber} exactly`) +
            (covers ? ` — it ${covers}.` : '.'),
        },
      })
      continue
    }

    // No exact tie-out. A named tenant is still worth surfacing — the landlord
    // may know the payer short-paid, or paid ahead. What it would pay is the
    // oldest whole lines it covers; the rest of the deposit would be paid-ahead
    // money (services/bankDepositConfirm).
    if (named) {
      const fit = oldestLinesWithin(charges, deposit.amount)
      cands.push({
        rank: 1,
        m: {
          chargeIds: fit.map(c => c.id), leaseId, tenantId: head.tenantId,
          tenantName: head.tenantName, unitNumber: head.unitNumber,
          total: fit.reduce((s, c) => s + cents(c.amount), 0) / 100,
          owed: owedCents / 100, exact: false,
          confidence: 'named_partial',
          rivals: 0,
          reason: `The deposit names ${head.tenantName}, but $${deposit.amount.toFixed(2)} does not add up to any set of their open charges: ${noTieOut(depositCents, fit, owedCents)}.`,
        },
      })
      continue
    }

    // Nothing else is a candidate. S652 (Nic): "it's thinking every single
    // transaction is going to be Mobile Home 2's rent — none of them even are
    // a dollar amount match." A candidate is an exact amount match, a tenant's
    // own report, or their name on the memo — nothing weaker.
  }

  // Two tenants declaring the same figure in the same window is possible in a
  // uniform-rent park. It is still a vastly smaller question than before — a
  // choice between the two who say they paid, not among everyone who owes.
  const declaredHits = cands.filter(c => c.m.confidence === 'declared')
  if (opts.conflict && declaredHits.length > 0) {
    // 10/6 (Nic): a real conflict between reports — the landlord picks.
    for (const c of declaredHits) {
      c.rank = 1
      c.m.confidence = 'amount_ambiguous'
      c.m.rivals = declaredHits.length - 1
      // The card says once why GAM did not pick; each choice says what was reported.
      const dcl = c.m.declaration
      const at = dcl ? reportedTimeText({ hour: dcl.hour, afterHours: dcl.afterHours }) : null
      c.m.reason = `${c.m.tenantName} reported paying $${deposit.amount.toFixed(2)} at the bank`
        + `${dcl ? ` on ${dcl.declaredDate}` : ''}${at ? `, ${at}` : ''}.`
    }
  } else if (declaredHits.length > 1) {
    for (const c of declaredHits) {
      c.rank = 1
      c.m.confidence = 'amount_ambiguous'
      c.m.rivals = declaredHits.length - 1
      c.m.reason =
        `${c.m.tenantName} reported a deposit of this amount — but so did ` +
        `${declaredHits.length - 1} other ${declaredHits.length - 1 === 1 ? 'tenant' : 'tenants'}. Confirm who paid.`
    }
  }

  // A NAME THAT FITS SEVERAL TENANTS IS NOT AN IDENTIFICATION. Two tenants
  // called Garcia, or a memo whose only surviving token is a word they happen to
  // share, must not produce a confident pre-selected match — that is the exact
  // failure this whole file is built to avoid, arriving through the door we
  // trusted most. Demote every named match to the ambiguous shortlist when more
  // than one lease answers to the name.
  const namedHits = cands.filter(c =>
    c.m.confidence === 'named_exact' || c.m.confidence === 'named_partial')
  if (namedHits.length > 1) {
    for (const c of namedHits) {
      const others = namedHits.length - 1
      c.rank = 2
      c.m.confidence = 'amount_ambiguous'
      c.m.rivals = others
      c.m.reason =
        `The deposit's name matches ${c.m.tenantName} on ${c.m.unitNumber}, but it ` +
        `also matches ${others} other ${others === 1 ? 'tenant' : 'tenants'}. Confirm who paid.`
    }
  }

  // Ambiguity is a property of the WHOLE result, not of any one row: if four
  // tenants all owe $250, none of them is a unique match, and saying so is the
  // difference between a useful shortlist and a confident wrong answer.
  const exactHits = cands.filter(c => c.m.confidence === 'amount_unique')
  if (exactHits.length > 1) {
    for (const c of exactHits) {
      c.m.confidence = 'amount_ambiguous'
      c.m.rivals = exactHits.length - 1
      c.m.reason =
        `Matches ${c.m.unitNumber} exactly — but ${exactHits.length - 1} other ` +
        `${exactHits.length - 1 === 1 ? 'tenant owes' : 'tenants owe'} the same amount. Confirm who paid.`
    }
  }

  cands.sort((a, b) =>
    a.rank - b.rank ||
    a.m.tenantName.localeCompare(b.m.tenantName))
  return cands.slice(0, limit).map(c => c.m)
}

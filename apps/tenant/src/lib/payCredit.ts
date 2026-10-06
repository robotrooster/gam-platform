/**
 * S655 money plan, Step 13 — the tenant's bill and the credit question, as
 * plain arithmetic over what the server quoted (GET /payments/balance-context,
 * the same figures /pay-balance enforces in services/rentCharge).
 *
 * Nic (10/2): the tenant sees the FULL bill. When credit could pay part of it
 * they choose "Use all $X — pay $Y" or "Save it for later — pay $Z"; when it
 * covers the whole bill, "Pay with credit — nothing charged". Nothing here
 * decides money — it only adds up the server's per-lease figures and says what
 * each lease's charge will carry, so the pay screen and the Payments page can
 * never show two different numbers for one bill.
 *
 * The two answers are on ONE basis — this period's bill, the old balance left
 * out of both — exactly as the server's own payIfUsed / payIfSaved are: $Y is
 * the bill less the credit, $Z the bill. The old balance (S622) is never paid
 * by credit; it is said beside the two buttons, and the amount box still
 * carries it ("Just what I owe").
 */
import { formatCurrency } from '@gam/shared'

// One lease's bill from GET /payments/balance-context — the same arithmetic
// /pay-balance enforces (services/rentCharge.quoteLeaseCharge).
export interface LeaseBill {
  leaseId:          string
  /** The landlord this lease pays. S622 ("current charges first") is read per landlord. */
  landlordId?:      string | null
  propertyName?:    string | null
  unitNumber?:      string | null
  paymentBlocked?:  boolean
  /**
   * 10/6 (Nic): the property takes rent its tenants deposit at the landlord's
   * bank — only then is "I paid at the bank — report a deposit" offered.
   */
  bankDepositsTaken?: boolean
  /** The bill and the old balance, before any credit. */
  outstanding:      number
  /** The old balance (S622): paid last, may be paid down in part, never paid by credit. */
  carriedBalance?:  number
  /** What must be paid in full now when the credit is saved (the old balance not included). */
  requiredNow?:     number
  /** Credit that may pay part of this bill now. 0 = no credit question. */
  usableCredit?:    number
  /** Every dollar of credit the household has with this landlord. */
  creditOnFile?:    number
  /**
   * Credit this bill could use that another bank payment still holds (a retry
   * on an earlier bill): not in usableCredit. If that payment clears it pays
   * the earlier bill; only if it finally fails does it come back to the
   * account (services/rentCharge creditStillHeldElsewhere).
   */
  creditWaiting?:   number
  /** creditWaiting in the server's own words (services/rentCharge creditWaitingNote). */
  creditWaitingNote?: string | null
  /**
   * The rest of the credit on file — not usable on this bill, not waiting on
   * another payment — and where it goes (a bill on another lease, or a later
   * bill), in the server's own words (services/rentCharge creditRestNote).
   */
  creditRestNote?:  string | null
  /** Money owed now if the credit is used (the old balance not included). */
  payIfUsed?:       number
  /** Money owed now if the credit is saved (the old balance not included). */
  payIfSaved?:      number
  coversWholeBill?: boolean
  /** A bank payment on this bill bounced and is set to be tried again. Paying now replaces it. */
  scheduledRetries?: { nextRetryAt: string | null }[]
  /** Already paid and on its way (processing): clearing, not owed. */
  clearing?:        number
  /**
   * decisions.md #48.4: a card payment on this bill waiting on the card's bank
   * to have the cardholder confirm it (3-D Secure). The bill is held until it
   * is confirmed, or released (canceled) at `confirmBy`. Not clearing.
   */
  awaitingConfirmation?: AwaitingCardConfirmation[]
  suggestedPayAhead?: number
  /**
   * "Pay all" with "Use all": this bill's figures as its charge will find them
   * when its turn comes in the run (GET /payments/balance-context payAll —
   * the earlier charges played through first, in `order`). null/absent: the
   * server did not sequence this bill with others (one bill, or a paused one).
   */
  payAll?:          PayAllFigures | null
  /** Set by payAllView only: the leases the run charges before this one. */
  payAllAfter?:     string[]
}

/** A card payment waiting on its bank's 3-D Secure confirmation (balance-context). */
export interface AwaitingCardConfirmation {
  paymentIntentId: string
  /** Its receipt in "Payments you've made" (marked "Waiting on your bank" there). */
  remittanceId?:   string
  /** What the card is charged, fee included. */
  amount:          number
  /** When the held bill is released if nobody confirms it (ISO). */
  confirmBy:       string
  /** The bank's window can be shown again (false: the bank already said no, or it is not the viewer's). */
  canConfirm:      boolean
  /**
   * The viewer made this payment. Only they can confirm or cancel it; the
   * rest of the household is told whose card's bank it waits on. Absent on an
   * older answer: taken as the viewer's.
   */
  mine?:           boolean
  /** Who made it, by name — set only when it is not the viewer's. */
  payerName?:      string | null
  /** The lease whose bill it holds (or null for a service agreement). */
  leaseId?:        string | null
  /** The service agreement whose bill it holds (a payer with no lease). */
  serviceAgreementId?: string | null
}

/** One bill's "Pay all" figures from the server (balance-context payAll). */
export interface PayAllFigures {
  /** Every lease of the run, in charge order (the same list on each bill). */
  order:            string[]
  usableCredit:     number
  payIfUsed:        number
  coversWholeBill:  boolean
  creditWaiting?:   number
  creditWaitingNote?: string | null
  /**
   * The credit another bank payment still holds that the WHOLE run would have
   * used — one figure, the same on every bill of the run (the server plays the
   * run through with and without the holds). Adding the bills' own figures up
   * could count the same held dollars on every bill.
   */
  runCreditWaiting?: number
  /** runCreditWaiting in the server's own words; null when nothing is waiting. */
  runCreditWaitingNote?: string | null
  /**
   * The credit on file for the run's landlords — the same on every bill of the
   * run (the server's payAllRunCreditRest). The Pay all box says "You have $X
   * credit. $Y of it can pay these bills." with it, as one bill's box does.
   */
  runCreditOnFile?: number
  /** Where the rest of that credit goes, in the server's own words (null: nothing more to explain). */
  runCreditRestNote?: string | null
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * "Pay all": the bills read with the figures each charge will find in the run,
 * in the server's charge order. A general credit's share of a later bill
 * changes once an earlier bill is charged (a replaced bank retry gives back
 * what it held; credit the earlier bill uses is gone), so the run is sent
 * those figures — never the per-bill figures, which may each count the same
 * dollars and would end in "Your credit changed" part-way through. Only when
 * the bills are exactly the run the server sequenced; otherwise (one bill, an
 * older server) the bills as they are.
 */
export function payAllView(bills: LeaseBill[]): LeaseBill[] {
  if (bills.length < 2 || !bills.every((b) => b.payAll)) return bills
  const order = bills[0].payAll!.order
  const ids = new Set(bills.map((b) => b.leaseId))
  if (order.length !== ids.size || !order.every((id) => ids.has(id))
    || !bills.every((b) => sameList(b.payAll!.order, order))) return bills
  return order.map((id, i) => {
    const b = bills.find((x) => x.leaseId === id)!
    const p = b.payAll!
    return {
      ...b,
      usableCredit: p.usableCredit,
      payIfUsed: p.payIfUsed,
      coversWholeBill: p.coversWholeBill,
      creditWaiting: p.creditWaiting ?? 0,
      creditWaitingNote: p.creditWaitingNote ?? null,
      payAllAfter: order.slice(0, i),
    }
  })
}

export const roundCents = (n: number): number => Math.round(n * 100) / 100

/** What must be paid in full now, without credit (the old balance not included). */
export function requiredOf(l: LeaseBill): number {
  return roundCents(Math.max(0, l.requiredNow ?? (l.outstanding - (l.carriedBalance ?? 0))))
}

/** Everything owed on this lease in money, before any credit: the bill plus the old balance. */
export function owedOf(l: LeaseBill): number {
  if (l.requiredNow == null) return roundCents(Math.max(0, l.outstanding))
  return roundCents(Math.max(0, l.requiredNow) + Math.max(0, l.carriedBalance ?? 0))
}

export interface CreditOffer {
  /** Credit that may pay part of these bills now. 0 = no credit question at all. */
  usable:          number
  /** Money if the credit is used: the bills less the credit (the old balance not included). */
  payIfUsed:       number
  /** Money if the credit is saved: the bills (the old balance not included) — the server's payIfSaved. */
  payIfSaved:      number
  /** Everything owed: the bills plus the old balance, before any credit ("Your balance"). */
  balance:         number
  /** The credit pays every bill in full: "Pay with credit — nothing charged". */
  coversWholeBill: boolean
  /** The old balance on these leases (credit never pays it, and neither answer includes it). */
  carried:         number
}

/** The credit question for one bill, or for "Pay all" across several. */
export function creditOffer(bills: LeaseBill[]): CreditOffer {
  let usable = 0, payIfUsed = 0, payIfSaved = 0, balance = 0, carried = 0
  for (const l of payAllView(bills)) {
    const u = Math.max(0, l.usableCredit ?? 0)
    usable += u
    payIfUsed += u > 0 ? Math.max(0, l.payIfUsed ?? 0) : requiredOf(l)
    payIfSaved += requiredOf(l)
    balance += owedOf(l)
    carried += Math.max(0, l.carriedBalance ?? 0)
  }
  usable = roundCents(usable)
  payIfUsed = roundCents(payIfUsed)
  return {
    usable, payIfUsed, payIfSaved: roundCents(payIfSaved), balance: roundCents(balance), carried: roundCents(carried),
    coversWholeBill: usable > 0 && payIfUsed <= 0,
  }
}

/** "Use all" or "Save it for later". */
export type CreditMode = 'use' | 'save'

/** One pay-balance call: one lease, its own charge and receipt (S581). */
export interface ChargeLine {
  leaseId:         string
  /** Money sent, before the fee. 0 = credit pays it all, nothing charged. */
  amount:          number
  useCredit?:      boolean
  expectedCredit?: number
  creditOnly:      boolean
  /** This charge reaches the old balance. */
  reachesCarried:  boolean
  /**
   * Old balance on this lease left out of this payment so the landlord's other
   * current bills can be claimed first (S622). It can be paid down after.
   */
  carriedLeft?:    number
  /**
   * "Pay all" with "Use all": the leases charged before this one in the run.
   * Sent with this line's quote (POST /payments/quote afterLeaseIds) so the
   * quote is the charge as it will be when its turn comes.
   */
  afterLeaseIds?:  string[]
}

/**
 * What each lease is charged for the payer's answer. `amountFor` is the
 * amount box (one lease, credit saved or none): paying ahead stays possible.
 *
 *   use   — each lease with usable credit: exactly the bill less its credit,
 *           with the credit figure it was shown (a moved figure is a 409). The
 *           old balance is not paid in the same charge: with credit used the
 *           money must be exactly what is left of the bill (rentCharge).
 *           A lease with a bank retry scheduled goes first: paying it replaces
 *           the retry and gives back the credit the retry set aside. "Pay all"
 *           sends each lease the figure its charge will find when its turn
 *           comes (payAllView: the server played the earlier charges through),
 *           so a credit the replaced retry frees for a later lease is used on
 *           it in the same run — never a "Your credit changed" part-way.
 *   save  — the bill, the figure the "Save it for later" button named; the
 *           answer still travels with the figure, so a general credit's share
 *           that grows on the next lease once this one is claimed refuses
 *           nothing. The amount box (one lease) may add the old balance.
 *   null  — no credit was offered: everything owed, the old balance included.
 *           No answer is sent: credit that appeared since the screen loaded
 *           comes back as a refusal, and the screen reads the bill again and asks.
 *
 * S622 (rentCharge): money toward an old balance is refused while ANOTHER of
 * the same landlord's leases still owes a current bill — and a lease's own
 * current rows stop owing only once its charge claims them. So, per landlord,
 * every lease's current bill is claimed before any old balance: at most one
 * charge that also pays a current bill may carry its old balance, and it goes
 * after the others (the rest are trimmed to their bill; their old balance is
 * `carriedLeft`, payable after). Charges that pay only an old balance go after
 * all of that landlord's current-bill charges.
 */
export function planCharges(bills: LeaseBill[], mode: CreditMode | null, amountFor?: (l: LeaseBill) => number): ChargeLine[] {
  if (mode === 'use') {
    const lines: ChargeLine[] = []
    const view = payAllView(bills)
    const retrying = (l: LeaseBill) => (l.scheduledRetries?.length ?? 0) > 0
    // Sequenced by the server: its order (retrying first). Else the same rule here.
    const ordered = view !== bills ? view : [...bills.filter(retrying), ...bills.filter((b) => !retrying(b))]
    for (const l of ordered) {
      const after = l.payAllAfter && l.payAllAfter.length > 0 ? { afterLeaseIds: l.payAllAfter } : {}
      const usable = roundCents(Math.max(0, l.usableCredit ?? 0))
      if (usable > 0) {
        const amount = roundCents(Math.max(0, l.payIfUsed ?? 0))
        lines.push({ leaseId: l.leaseId, amount, useCredit: true, expectedCredit: usable, creditOnly: amount <= 0, reachesCarried: false, ...after })
      } else {
        const amount = requiredOf(l)
        if (amount > 0) lines.push({ leaseId: l.leaseId, amount, useCredit: false, expectedCredit: 0, creditOnly: false, reachesCarried: false, ...after })
      }
    }
    return lines
  }

  type Draft = { l: LeaseBill; line: ChargeLine; required: number }
  const drafts: Draft[] = []
  for (const l of bills) {
    const required = requiredOf(l)
    const amount = roundCents(amountFor ? amountFor(l) : mode === 'save' ? required : owedOf(l))
    if (!(amount > 0)) continue
    const line: ChargeLine = { leaseId: l.leaseId, amount, creditOnly: false, reachesCarried: amount > required + 0.005 }
    if (mode === 'save') { line.useCredit = false; line.expectedCredit = roundCents(Math.max(0, l.usableCredit ?? 0)) }
    drafts.push({ l, line, required })
  }

  // Per landlord (a lease whose landlord is not known shares one group with
  // the others not known — the cautious reading): one current-bill charge may
  // keep its old balance, the last; the others are trimmed to their bill.
  const landlordOf = (d: Draft) => d.l.landlordId ?? ''
  const groups = new Map<string, Draft[]>()
  for (const d of drafts) {
    const g = groups.get(landlordOf(d))
    if (g) g.push(d); else groups.set(landlordOf(d), [d])
  }
  for (const g of groups.values()) {
    const current = g.filter((d) => d.required > 0)
    if (current.length < 2) continue
    const reaching = current.filter((d) => d.line.reachesCarried)
    for (const d of reaching.slice(0, -1)) {
      d.line.carriedLeft = roundCents(d.line.amount - d.required)
      d.line.amount = d.required
      d.line.reachesCarried = false
    }
  }

  const plain = drafts.filter((d) => !d.line.reachesCarried)
  const withCurrent = drafts.filter((d) => d.line.reachesCarried && d.required > 0)
  const oldOnly = drafts.filter((d) => d.line.reachesCarried && !(d.required > 0))
  return [...plain, ...withCurrent, ...oldOnly].map((d) => d.line)
}

/**
 * Credit held by another bank payment that has not finished: it is left alone
 * and the rest of the bill is charged — why only part of the credit on file
 * can pay. null when none is waiting. One bill: the server's own sentence
 * (creditWaitingNote).
 *
 * "Pay all" the server sequenced (payAllView): the run's ONE figure
 * (payAll.runCreditWaiting) — never the bills' figures added up. A hold that
 * belongs to a lease outside the run (a paused lease's bank retry) is the same
 * dollars on every bill, so a sum said "$100.00 set aside" with $50.00 on file
 * (fix pass 2). A hold the run's own earlier charge replaces is not said.
 *
 * Bills that are not the server's run: the run figure the page asked the
 * server for these exact bills (`asked`, POST /payments/quote runLeaseIds —
 * needsRunCreditWaiting). Until it is in, or from an older server: per
 * landlord, the largest single bill's figure — each bill's figure
 * is at most what is held, so this never says more than is set aside; credit
 * never crosses landlords, so the landlords' figures add up. Same words as the
 * server (services/rentCharge creditWaitingSentence; payCredit.test.ts pins them).
 */
export function creditWaitingSentence(bills: LeaseBill[], asked?: RunCreditWaiting | null): string | null {
  const view = payAllView(bills)
  const run = view !== bills ? bills[0].payAll : null
  if (run && run.runCreditWaiting != null) return runSentence(run.runCreditWaiting, run.runCreditWaitingNote)
  // Fix pass 3: the run figure the server worked out for exactly these bills
  // (POST /payments/quote runLeaseIds), when the page asked for it.
  if (asked && Array.isArray(asked.runLeaseIds) && bills.length >= 2 && sameList(asked.runLeaseIds, runOrder(bills))) {
    return runSentence(asked.runCreditWaiting, asked.runCreditWaitingNote)
  }
  const waitingBills = view.filter((l) => (l.creditWaiting ?? 0) > 0)
  if (waitingBills.length === 0) return null
  if (waitingBills.length === 1 && waitingBills[0].creditWaitingNote) return waitingBills[0].creditWaitingNote
  const largest = new Map<string, number>()
  for (const l of waitingBills) {
    const k = l.landlordId ?? ''
    largest.set(k, Math.max(largest.get(k) ?? 0, l.creditWaiting ?? 0))
  }
  const waiting = roundCents([...largest.values()].reduce((a, b) => a + b, 0))
  if (!(waiting > 0)) return null
  return `${formatCurrency(waiting)}${CREDIT_WAITING_TAIL}`
}

function runSentence(figure: number, note: string | null | undefined): string | null {
  const w = roundCents(Math.max(0, figure))
  if (!(w > 0)) return null
  return note || `${formatCurrency(w)}${CREDIT_WAITING_TAIL}`
}

/** The server's run figure for a set of bills (POST /payments/quote with runLeaseIds). */
export interface RunCreditWaiting {
  runLeaseIds:          string[]
  runCreditWaiting:     number
  runCreditWaitingNote?: string | null
}

/**
 * The order "Use all" charges these bills in (planCharges): each lease with a
 * bank retry scheduled first, then the rest as listed.
 */
export function runOrder(bills: LeaseBill[]): string[] {
  const retrying = (l: LeaseBill) => (l.scheduledRetries?.length ?? 0) > 0
  return [...bills.filter(retrying), ...bills.filter((b) => !retrying(b))].map((b) => b.leaseId)
}

/**
 * Bills whose held-credit sentence needs the server's run figure: two or more
 * bills that are not the run balance-context sequenced, with credit waiting on
 * at least one. Their own figures cannot be added up (the same held dollars
 * may be on each) and the largest alone can say too little (two holds, one per
 * bill), so the page asks the server for these bills' run (runOrder).
 */
export function needsRunCreditWaiting(bills: LeaseBill[]): boolean {
  return bills.length >= 2 && payAllView(bills) === bills && bills.some((l) => (l.creditWaiting ?? 0) > 0)
}

/**
 * Where the rest of the credit goes: the server's own sentence, said beside
 * "You have $X credit. $Y of it can pay this bill / these bills." so every
 * dollar on file is explained. One bill: its creditRestNote. "Pay all" the
 * server sequenced (payAllView): the run's one note (payAll.runCreditRestNote).
 * Bills that are not the server's run: null (their credit sentence then names
 * only the credit the bills use — creditOnFileOf is null for them too).
 */
export function creditRestSentence(bills: LeaseBill[]): string | null {
  if (bills.length === 1) return bills[0].creditRestNote ?? null
  if (bills.length >= 2 && payAllView(bills) !== bills) return bills[0].payAll?.runCreditRestNote ?? null
  return null
}

/**
 * The credit on file the "You have $X credit" sentence names: one bill's
 * creditOnFile, or the run's one figure for "Pay all" the server sequenced.
 * null when the server gave no figure for exactly these bills (the sentence
 * then names only what the bills can use).
 */
export function creditOnFileOf(bills: LeaseBill[]): number | null {
  if (bills.length === 1) return bills[0].creditOnFile ?? null
  if (bills.length >= 2 && payAllView(bills) !== bills) return bills[0].payAll?.runCreditOnFile ?? null
  return null
}

/** The wording after the amount; the same as the server's (pinned by a test). */
export const CREDIT_WAITING_TAIL = ' of your credit is set aside for an earlier bank payment that has not cleared yet. If that payment clears, the credit goes toward that earlier bill. If it does not, the credit comes back to your account.'


/** "You have $X credit." — and, when the account holds more than can pay the bill(s), how much can. */
export function creditSentence(usable: number, onFile?: number | null, several = false): string {
  if (onFile != null && onFile > usable + 0.005) {
    return `You have ${formatCurrency(onFile)} credit. ${formatCurrency(usable)} of it can pay ${several ? 'these bills' : 'this bill'}.`
  }
  return `You have ${formatCurrency(usable)} credit.`
}
